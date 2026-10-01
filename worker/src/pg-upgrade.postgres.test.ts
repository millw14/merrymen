/**
 * REAL POSTGRES: THE UPGRADE FROM THE SCHEMA PRODUCTION RUNS TODAY, AND EVERY
 * STATEMENT THE ENERGY RELEASE ADDS OR CHANGES. Opt-in.
 *
 * HOW TO RUN — against a disposable LOCAL Postgres only (the test refuses any
 * other host, and never reads DATABASE_URL):
 *
 *   createdb -h localhost -p 55432 -U merrymen merrymen_pgtest
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@localhost:55432/merrymen_pgtest \
 *     npx tsx --test worker/src/pg-upgrade.postgres.test.ts
 *
 * (MERRYMEN_TEST_POSTGRES_URL, the partner-store test's variable, works too.)
 * With neither set every case is skipped, so `npm test` and CI need no
 * database. Each run works in a schema of its own, `mm_upgrade_test_<hex>`,
 * dropped at the end; nothing outside it is touched.
 *
 * WHY. Every other test runs this SQL on sqlite, and the release ships to a
 * shared Postgres that already has tables, rows and two services booting
 * against it at once. Run this way it found what sqlite could not: the
 * orchestrator's first spawn reading `equity.cash_read_at` before its mirror
 * had added it (every child armed with an UNKNOWN anchor), two services'
 * CREATE TABLE IF NOT EXISTS racing on the new tables (23505, and 42710
 * `type … already exists`), and a settings store that cached a failed start
 * for the life of the process.
 *
 * THE STARTING POINT IS PRODUCTION'S SCHEMA, NOT THIS BRANCH'S:
 * testdata/shared-schema-75995697.sql, pg_dump'd from a database built by the
 * previous release's own boot code. Rows are then written in THAT shape —
 * before any new DDL runs — and the new code boots over them.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { makePgDb, translateSchema, wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { PgSettingsStore, type PgClientLike } from "./settings-store";
import { deriveBootstrapAccounting } from "./bootstrap-source";
import { backfillHolderClaims } from "./holder-claims";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";
import { TELEGRAM_STATE_DDL } from "./telegram-store";
import { ANNOUNCE_DDL, runAnnouncement } from "./announce";
import { TELEGRAM_BOT_CLAIMS_DDL } from "./telegram-claims";
import {
  ENERGY_DAYS_SCHEMA,
  claimEnergyDay,
  claimEnergyNoticeDay,
  ensureEnergyDays,
  mergeEnergyDayRow,
  noteEnergyReadDay,
  readEnergyDay,
  readEnergyDaysSince,
  refundEnergyDay,
} from "./energy-days";
import { planEnergySeed, utcDay } from "./energy";
import { seedEnergyDays } from "./energy-seed";
import { RISK_PERIOD_SCHEMA, startRiskPeriod } from "./risk-period";
import { sealSecret } from "./store-crypto";
import { repairAccount } from "./accounting-repair";
import type { AccountPlan } from "./accounting-reconstruction";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;

interface PgClient extends PgClientLike {
  connect(): Promise<void>;
  end(): Promise<void>;
}
// LOADED ONLY WHEN A DATABASE IS NAMED. `pg` is not a dependency — the
// production image installs it at build time (Dockerfile) — so CI and a
// plain `npm test` have no driver. A top-level require failed the whole file
// there instead of skipping it.
const pg = (url ? createRequire(import.meta.url)("pg") : null) as { Client: new (c: { connectionString: string }) => PgClient } | null;

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "testdata", "shared-schema-75995697.sql");
const ANNOUNCEMENT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "docs",
  "announcements",
  "energy-daily-cap-2026-09-28.html",
);

// Tenants (owner wallets), holder wallets and smart accounts — accounts in the
// mixed case grants carry them, which is the case the ledger keys on.
const T1 = "0x1111111111111111111111111111111111111111" as const;
const T2 = "0x2222222222222222222222222222222222222222" as const;
const T3 = "0x3333333333333333333333333333333333333333" as const;
const W1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const A1 = "0xA1a1A1a1a1A1a1a1A1a1a1a1A1a1a1A1A1a1a1a1";
const A2 = "0xB2b2B2b2b2B2b2B2b2b2b2b2B2b2b2B2B2b2b2b2";
const tenantN = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const DAY_MS = 86_400_000;

test("Postgres: the energy release over production's schema", { skip: !url, timeout: 120_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "only a disposable LOCAL Postgres is allowed");
  const schema = `mm_upgrade_test_${randomBytes(8).toString("hex")}`;
  assert.match(schema, /^mm_upgrade_test_[a-f0-9]{16}$/);
  const scoped = (who: string) => {
    const u = new URL(target);
    u.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=20000 -c lock_timeout=10000`);
    u.searchParams.set("application_name", `merrymen-upgrade-test-${who}`);
    return u.toString();
  };

  // The process environment the stores read, pointed at this run and put back after.
  const saved = { db: process.env.DATABASE_URL, dek: process.env.MERRYMEN_STORE_DEK, home: process.env.MERRYMEN_HOME };
  const home = mkdtempSync(path.join(os.tmpdir(), "mm-upgrade-"));
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
  process.env.MERRYMEN_HOME = home;
  delete process.env.DATABASE_URL;

  const clients: PgClient[] = [];
  const connect = async (u: string): Promise<PgClient> => {
    const c = new pg!.Client({ connectionString: u });
    await c.connect();
    clients.push(c);
    return c;
  };
  const admin = await connect(target.toString());
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    const shared = await makePgDb(scoped("orchestrator"));
    const other = await makePgDb(scoped("web"));
    const store = (who: string) => new PgSettingsStore(scoped(who), connect);
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);

    await t.test("production's schema, with rows written in production's shape", async () => {
      // Loaded verbatim — not through Db.exec, whose sqlite-to-Postgres
      // translation must not touch production's own DDL.
      await (await connect(scoped("fixture"))).query(readFileSync(FIXTURE, "utf8"));
      const seal = (s: unknown) => sealSecret(JSON.stringify(s), Buffer.from(process.env.MERRYMEN_STORE_DEK!, "base64"));
      for (const [tenant, settings] of [
        [T1, { holderProof: { address: W1, at: now - DAY_MS }, telegramBotToken: "111:AAA", telegramEnabled: true, telegramAllowlist: [424242] }],
        [T2, { telegramBotToken: "222:BBB", telegramEnabled: true, telegramAllowlist: [515151] }],
        [T3, { holderProof: { address: W1, at: now - 3_600_000 } }],
      ] as const) {
        await shared.prepare("INSERT INTO tenant_settings (tenant, sealed, updated_at) VALUES (?, ?, ?)").run(tenant, seal(settings), nowSec - 86_400);
      }
      for (const [tenant, account] of [[T1, A1], [T2, A2]] as const) {
        await shared
          .prepare("INSERT INTO grants (tenant, chain_id, grant_json, sealed_session_key, updated_at) VALUES (?, 4663, ?, 'sealed', ?)")
          .run(tenant, JSON.stringify({ smartAccount: account, chainId: 4663 }), nowSec - 86_400);
        await shared
          .prepare("INSERT INTO tenant_telegram (tenant, link_code, owner_id, linked_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
          .run(tenant, tenant === T1 ? 424242 : 515151, nowSec - 86_400, nowSec - 86_400);
      }
      // A1: live, epoch 2, a peak with a withdrawal against it. A2: paper, and blocked.
      await shared
        .prepare(
          `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at,
                               mode, epoch, hwm_usdg, hwm_withdrawn_usdg, live_blocker)
           VALUES (?, '0x9', '0x8', 4663, '{}', ?, ?, 'live', 2, 520, 20, NULL), (?, '0x9', '0x8', 4663, '{}', ?, ?, 'paper', 1, 0, 0, 'no-usdg')`,
        )
        .run(A1, nowSec - 86_400, nowSec + 86_400 * 14, A2, nowSec - 86_400, nowSec + 86_400 * 14);
      await shared
        .prepare(
          `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
           VALUES (?, 'in', 500, ?, 1000, 3, 'chain-log', 2, 4663, ?), (?, 'out', 20, ?, 1100, NULL, 'transfer-intent', 2, 4663, ?)`,
        )
        .run(A1, "0x" + "ab".repeat(32), nowSec - 7_200, A1, "0x" + "cd".repeat(32), nowSec - 7_000);
      for (const [cash, at] of [[480, nowSec - 3_600], [478, nowSec - 900]] as const) {
        await shared
          .prepare(
            `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at)
             VALUES (?, '1000000000000000', ?, 0, 2, ?, 2, 'live', ?)`,
          )
          .run(A1, cash, cash + 2, at);
      }
      const cols = (await shared
        .prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'equity'")
        .all()) as { column_name: string }[];
      assert.ok(!cols.some((c) => c.column_name === "flows_held" || c.column_name === "cash_read_at"), "production has neither column yet");
    });

    await t.test("THE FIRST PASS reads before any new DDL: the anchor is established, the energy read is null", async () => {
      const a = await deriveBootstrapAccounting(shared, A1, nowSec);
      assert.equal(a.kind, "established", a.kind === "unknown" ? a.why : "");
      if (a.kind !== "established") return;
      assert.equal(a.highWaterMarkUsdg, "520000000");
      assert.equal(a.highWaterWithdrawnUsdg, "20000000");
      assert.equal(a.accountingEpoch, 2);
      assert.equal(a.netContributionsUsdg, "480000000");
      assert.equal(a.lastObservedCashUsdg, "478000000");
      // The web's /api/grants read, on a ledger the mirror has not migrated yet.
      await assert.rejects(shared.prepare("SELECT energy FROM agents WHERE smart_account = ?").get(A1), /energy/);
    });

    await t.test("BOOT: every new DDL path, four at once from two services, then again — all clean", async () => {
      const boot = async (db: Db, who: string) => {
        await store(who).listTenants();
        await applyLedgerSchema(db);
        await db.exec(translateSchema(MIRROR_STATE_DDL));
        await db.exec(translateSchema(TELEGRAM_STATE_DDL));
        await db.exec(ENERGY_DAYS_SCHEMA);
        await db.exec(RISK_PERIOD_SCHEMA);
        await db.exec(ANNOUNCE_DDL);
      };
      const raced = await Promise.allSettled([boot(shared, "o1"), boot(other, "w1"), boot(shared, "o2"), boot(other, "w2")]);
      assert.deepEqual(
        raced.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error).message)] : [])),
        [],
        "no racing boot failed",
      );
      await boot(shared, "o3");
      const cols = (await shared
        .prepare(
          `SELECT table_name || '.' || column_name AS c, data_type FROM information_schema.columns
            WHERE table_schema = current_schema() AND (
              (table_name = 'equity' AND column_name IN ('flows_held', 'cash_read_at'))
              OR (table_name = 'agents' AND column_name = 'energy')
              OR (table_name = 'holder_claims' AND column_name IN ('claimed_at', 'moved_at', 'moved_from'))
              OR table_name IN ('energy_days', 'holder_wallet_moves', 'holder_claims_meta'))`,
        )
        .all()) as { c: string; data_type: string }[];
      const got = new Map(cols.map((r) => [r.c, r.data_type]));
      for (const [c, type] of [
        ["equity.flows_held", "bigint"],
        ["equity.cash_read_at", "bigint"],
        ["agents.energy", "text"],
        ["holder_claims.claimed_at", "bigint"],
        ["holder_claims.moved_at", "bigint"],
        ["holder_claims.moved_from", "text"],
        ["holder_wallet_moves.moved_at", "bigint"],
        ["holder_claims_meta.value", "text"],
        ["energy_days.reviews", "bigint"],
        ["energy_days.read_at", "bigint"],
        ["energy_days.entries_refunded", "bigint"],
      ]) {
        assert.equal(got.get(c!), type, c);
      }
    });

    await t.test("THE ROWS FROM BEFORE are all still read the same", async () => {
      const s = store("reader");
      assert.deepEqual((await s.get(T1))?.holderProof, { address: W1, at: now - DAY_MS }, "sealed settings unseal");
      const marks = (await shared.prepare("SELECT flows_held, cash_read_at FROM equity WHERE agent_id = ?").all(A1)) as Record<string, unknown>[];
      assert.ok(marks.length === 2 && marks.every((m) => m.flows_held === null && m.cash_read_at === null));
      const a = await deriveBootstrapAccounting(shared, A1, nowSec);
      assert.equal(a.kind === "established" && a.lastObservedCashUsdg, "478000000", "a NULL flag is not held");
      assert.equal(a.kind === "established" && a.observedAt, nowSec - 900, "a NULL read time falls back to the insert");
      assert.equal(((await shared.prepare("SELECT energy FROM agents WHERE smart_account = ?").get(A1)) as { energy: unknown }).energy, null);
    });

    await t.test("HOLDER CLAIMS: backfill once ever, and every move/release statement on real Postgres", async () => {
      const s = store("claims");
      const first = await backfillHolderClaims(s);
      assert.deepEqual([first.claimed, first.collisions.map((c) => c.tenant), first.done], [1, [T3], true], "the earlier proof keeps W1");
      assert.equal((await backfillHolderClaims(s)).alreadyDone, true);
      assert.equal((await s.holderClaims()).get(W1), T1);
      assert.deepEqual([...(await s.holderClaims([W1.toUpperCase().replace("0X", "0x"), T2, "nope"]))], [[W1, T1]]);

      const t0 = now;
      const moved = await s.takeHolder(W1, T3, t0);
      assert.ok(moved.ok && moved.from === T1 && moved.was?.movedAt === null);
      const row = (await shared.prepare("SELECT claimed_at, moved_at, moved_from FROM holder_claims WHERE wallet = ?").get(W1)) as Record<string, unknown>;
      assert.deepEqual(row, { claimed_at: t0, moved_at: t0, moved_from: T1 }, "epoch ms round-trips through BIGINT exactly");
      assert.deepEqual(await s.takeHolder(W1, T2, t0 + 1), { ok: false, movableAt: t0 + DAY_MS, held: true });
      const back = await s.takeHolder(W1, T1, t0 + 2);
      assert.ok(back.ok && back.from === T3, "back to the account it was moved from");
      const own = await s.takeHolder(W1, W1, t0 + 3);
      assert.ok(own.ok && own.from === T1, "the wallet's own login may always take it");
      await s.undoTakeHolder(W1, W1, own.ok && own.from ? own.was : null);
      assert.equal((await s.holderClaims()).get(W1), T1, "undo put the replaced claim back");
      await s.releaseHolder(W1, T1);
      assert.deepEqual(await s.claimHolder(W1, T2), { ok: false, heldBy: null }, "released: no unsigned claim");
      assert.deepEqual(await s.takeHolder(W1, T2, t0 + 4), { ok: false, movableAt: t0 + 2 + DAY_MS, held: false }, "the move outlives the release");
      assert.deepEqual(await s.takeHolder(W1, T1, t0 + 5), { ok: true, fresh: true });
      await s.takeHolder(tenantN(99), T1, t0 + 6);
      await s.releaseHolderClaims(T1, W1);
      assert.deepEqual([...(await s.holderClaims([W1, tenantN(99)]))], [[W1, T1]], "keep survives, the stray goes");
      await s.releaseHolderClaims(T1);
      assert.equal((await s.holderClaims()).size, 0);
      await s.saveHolderBackfill({ startedAt: 5, pending: [T2] });
      assert.deepEqual(await s.holderBackfill(), { startedAt: 5, pending: [T2] });
    });

    await t.test("HOLDER CLAIMS ACROSS TWO CONNECTIONS: one winner, one move, and a release never eats a move", async () => {
      const web = store("web-claims");
      const orch = store("orch-claims");
      const W = tenantN(0xabc);
      const tenants = Array.from({ length: 12 }, (_, i) => tenantN(1000 + i));
      const claims = await Promise.all(tenants.map((tn, i) => (i % 2 ? web : orch).claimHolder(W, tn)));
      const winners = claims.flatMap((r, i) => (r.ok ? [tenants[i]!] : []));
      assert.equal(winners.length, 1, JSON.stringify(claims));
      assert.ok(claims.every((r) => r.ok || r.heldBy === winners[0]));

      const t0 = now + 10 * DAY_MS;
      const movers = tenants.filter((tn) => tn !== winners[0]).slice(0, 6);
      const moves = await Promise.all(movers.map((tn, i) => (i % 2 ? web : orch).takeHolder(W, tn, t0)));
      assert.equal(moves.filter((m) => m.ok).length, 1, `exactly one move in the window: ${JSON.stringify(moves)}`);

      // A release and a move onto the releasing account, interleaved across services.
      const W9 = tenantN(0xdef);
      const [a, b] = [tenantN(2001), tenantN(2002)];
      await web.takeHolder(W9, a, t0);
      for (let round = 0; round < 10; round++) {
        const at = t0 + DAY_MS * (round + 1);
        const [, move] = await Promise.all([orch.releaseHolderClaims(b), web.takeHolder(W9, b, at)]);
        assert.ok(move.ok, `round ${round}: the move itself is allowed`);
        const holder = (await web.holderClaims([W9])).get(W9);
        if (holder === undefined) {
          // The release took the claim after the move: then it recorded THAT
          // claim, move and all — never a claim gone with no record of it.
          const rec = (await shared.prepare("SELECT last_tenant, moved_at FROM holder_wallet_moves WHERE wallet = ?").get(W9)) as Record<string, unknown>;
          assert.deepEqual(rec, { last_tenant: b, moved_at: at }, `round ${round}`);
        } else {
          assert.equal(holder, b, `round ${round}: the move survived a release that ran around it`);
        }
        assert.equal((await web.takeHolder(W9, a, at + 1)).ok, true, "back to the account it came from");
      }
    });

    await t.test("THE BACKFILL LEASE is a real advisory lock: a second replica is refused until it is released", async () => {
      const { acquireTenantLease } = await import("./tenant-lease");
      process.env.DATABASE_URL = scoped("lease");
      try {
        const one = await acquireTenantLease("0xholder-claims-backfill");
        assert.ok(one && one.backend === "postgres");
        assert.equal(await acquireTenantLease("0xholder-claims-backfill"), null);
        await one.release();
        const again = await acquireTenantLease("0xholder-claims-backfill");
        assert.ok(again);
        await again.release();
      } finally {
        delete process.env.DATABASE_URL;
      }
    });

    // A hosted child's own sqlite, written by this release's code.
    const childRaw = new DatabaseSync(":memory:");
    const child = wrapSqlite(childRaw);
    const today = utcDay(nowSec);
    const yesterday = utcDay(nowSec - 86_400);
    const buyTx = "0x" + "e1".repeat(32);

    await t.test("THE MIRROR carries energy, energy_days, the held flag and read time, and the energy-buy flow — once", async () => {
      await applyLedgerSchema(child);
      await child
        .prepare(
          `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch, hwm_usdg, hwm_withdrawn_usdg, energy)
           VALUES (?, '0x9', '0x8', 4663, '{}', ?, ?, 'live', 2, 520, 35, ?)`,
        )
        .run(A1, nowSec - 86_400, nowSec + 86_400 * 14, JSON.stringify({ v: 1, level: "low" }));
      assert.equal(await claimEnergyDay(child, A1, yesterday, "entries", 1), true);
      assert.equal(await claimEnergyNoticeDay(child, A1, yesterday, nowSec - 80_000), true);
      await noteEnergyReadDay(child, A1, yesterday, false, nowSec - 80_000);
      for (let i = 0; i < 3; i++) await claimEnergyDay(child, A1, today, "reviews", 15);
      await noteEnergyReadDay(child, A1, today, true, nowSec - 60);
      await child
        .prepare(
          `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, flows_held, cash_read_at, at)
           VALUES (?, '1', 470, 0, 5, 475, 2, 'live', 0, ?, ?), (?, '1', 455, 0, 5, 460, 2, 'live', 1, ?, ?)`,
        )
        .run(A1, nowSec - 330, nowSec - 300, A1, nowSec - 65, nowSec - 60);
      await child
        .prepare(
          `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
           VALUES (?, 'out', 15, ?, 2000123, 7, 'energy-buy', 2, 4663, ?)`,
        )
        .run(A1, buyTx, nowSec - 200);
      await child
        .prepare(
          `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, epoch)
           VALUES (?, 'energy-buy', '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', 15, ?, ?, 'landed', 2)`,
        )
        .run(A1, "0x" + "0e".repeat(32), buyTx);

      for (const pass of [1, 2]) {
        const r = await mirrorTenant({ tenant: T1, child, shared, nowSec });
        assert.equal(r.failed, undefined, `pass ${pass}: ${JSON.stringify(r.failed)}`);
        assert.equal(r.copied.energy_days, 2, `pass ${pass}`);
      }
      const agent = (await shared.prepare("SELECT energy, hwm_withdrawn_usdg FROM agents WHERE smart_account = ?").get(A1)) as Record<string, unknown>;
      assert.equal(JSON.parse(String(agent.energy)).level, "low");
      const days = (await shared.prepare("SELECT day, reviews, entries, told_at, read_at, read_full FROM energy_days WHERE agent_id = ? ORDER BY day").all(A1)) as Record<string, unknown>[];
      assert.deepEqual(days, [
        { day: yesterday, reviews: 0, entries: 1, told_at: nowSec - 80_000, read_at: nowSec - 80_000, read_full: 0 },
        { day: today, reviews: 3, entries: 0, told_at: null, read_at: nowSec - 60, read_full: 1 },
      ]);
      const buys = (await shared.prepare("SELECT tx_hash, block_number, log_index, chain_id FROM flows WHERE agent_id = ? AND source = 'energy-buy'").all(A1)) as Record<string, unknown>[];
      assert.deepEqual(buys, [{ tx_hash: buyTx, block_number: 2000123, log_index: 7, chain_id: 4663 }], "one row, identity intact, twice mirrored");
      const held = (await shared.prepare("SELECT cash_usdg, flows_held, cash_read_at FROM equity WHERE agent_id = ? AND flows_held IS NOT NULL ORDER BY id").all(A1)) as Record<string, unknown>[];
      assert.deepEqual(held, [
        { cash_usdg: 470, flows_held: 0, cash_read_at: nowSec - 330 },
        { cash_usdg: 455, flows_held: 1, cash_read_at: nowSec - 65 },
      ]);
      // A rebuilt child reports no energy yet: NULL never erases the last report.
      await child.prepare("UPDATE agents SET energy = NULL WHERE smart_account = ?").run(A1);
      await mirrorTenant({ tenant: T1, child, shared, nowSec });
      assert.ok(((await shared.prepare("SELECT energy FROM agents WHERE smart_account = ?").get(A1)) as { energy: unknown }).energy);
    });

    await t.test("THE ANCHOR after the mirror: the held mark is skipped, and its time is the read", async () => {
      const a = await deriveBootstrapAccounting(shared, A1, nowSec);
      assert.equal(a.kind, "established");
      if (a.kind !== "established") return;
      assert.equal(a.lastObservedCashUsdg, "470000000");
      assert.equal(a.observedAt, nowSec - 200, "the newest flow is later than the read");
      assert.equal(a.netContributionsUsdg, "465000000", "500 in, 20 home, 15 on energy");
      assert.equal(a.unanchoredFlowCount, 0, "the energy-buy row is evidenced");
    });

    await t.test("THE SEED into a rebuilt child restores today and yesterday; a copy never lowers a counter", async () => {
      const rebuilt = wrapSqlite(new DatabaseSync(":memory:"));
      await rebuilt.exec(ENERGY_DAYS_SCHEMA);
      await shared.exec(ENERGY_DAYS_SCHEMA);
      const sinceDay = utcDay(nowSec - 86_400);
      const plan = planEnergySeed({
        shared: await readEnergyDaysSince(shared, A1.toLowerCase(), sinceDay),
        child: await readEnergyDaysSince(rebuilt, A1, sinceDay),
        sinceDay,
      });
      for (const row of plan) await mergeEnergyDayRow(rebuilt, A1, row);
      const got = (await rebuilt.prepare("SELECT day, reviews, entries, told_at FROM energy_days WHERE agent_id = ? ORDER BY day").all(A1)) as Record<string, unknown>[];
      assert.deepEqual(got.map((r) => ({ ...r })), [
        { day: yesterday, reviews: 0, entries: 1, told_at: nowSec - 80_000 },
        { day: today, reviews: 3, entries: 0, told_at: null },
      ]);
      await mergeEnergyDayRow(shared, A1, { day: today, reviews: 0, entries: 0, entriesRefunded: 0, toldAt: 5, readAt: 1, readFull: false });
      const kept = (await shared.prepare("SELECT reviews, told_at, read_at, read_full FROM energy_days WHERE agent_id = ? AND day = ?").get(A1, today)) as Record<string, unknown>;
      assert.deepEqual(kept, { reviews: 3, told_at: 5, read_at: nowSec - 60, read_full: 1 }, "zeros and an older read change nothing; the first notice stamp lands");
    });

    await t.test("A REFUND MIRRORED AFTER ITS CLAIM comes back down through the seed — the net, never the stale claim", async () => {
      // Two new trades claimed while their ops await execution, and mirrored so.
      assert.equal(await claimEnergyDay(child, A1, today, "entries", 2), true);
      assert.equal(await claimEnergyDay(child, A1, today, "entries", 2), true);
      assert.equal((await mirrorTenant({ tenant: T1, child, shared, nowSec })).failed, undefined);
      // The second is refused at execution and handed back; mirrored again.
      await refundEnergyDay(child, A1, today);
      assert.equal((await mirrorTenant({ tenant: T1, child, shared, nowSec })).failed, undefined);
      assert.deepEqual(
        await shared.prepare("SELECT entries, entries_refunded FROM energy_days WHERE agent_id = ? AND day = ?").get(A1, today),
        { entries: 2, entries_refunded: 1 },
        "shared took the refund — a rising counter the larger-wins merge carries",
      );
      // A redeploy: the rebuilt child is seeded by the real seed, off real Postgres.
      const rebuilt = wrapSqlite(new DatabaseSync(":memory:"));
      const r = await seedEnergyDays({ home: path.join(home, "rebuilt"), agent: A1, nowSec, when: "spawn", local: () => rebuilt, shared: async () => shared });
      assert.equal(r.ok, true, r.ok ? "" : r.why);
      assert.equal((await readEnergyDay(rebuilt, A1, today)).entries, 1, "one used, not the two the first mirror saw");
      assert.equal(await claimEnergyDay(rebuilt, A1, today, "entries", 2), true, "the handed-back claim is room for one more");
      assert.equal(await claimEnergyDay(rebuilt, A1, today, "entries", 2), false);
    });

    await t.test("AN energy_days FROM BEFORE THE REFUND COUNTER gains it, four boots at once, its rows reading as they did", async () => {
      const old = `${schema}_old`;
      assert.match(old, /^mm_upgrade_test_[a-f0-9]{16}_old$/);
      await admin.query(`CREATE SCHEMA ${old}`);
      try {
        const u = new URL(target);
        u.searchParams.set("options", `-c search_path=${old} -c statement_timeout=20000 -c lock_timeout=10000`);
        const db = await makePgDb(u.toString());
        await db.exec(
          "CREATE TABLE energy_days (agent_id TEXT NOT NULL, day TEXT NOT NULL, reviews INTEGER NOT NULL DEFAULT 0, entries INTEGER NOT NULL DEFAULT 0," +
            " told_at INTEGER, read_at INTEGER, read_full INTEGER, PRIMARY KEY (agent_id, day))",
        );
        // Written by the previous code: two claimed, one refunded by decrement.
        await db.prepare("INSERT INTO energy_days (agent_id, day, reviews, entries) VALUES (?, ?, 2, 1)").run(A1, today);
        const raced = await Promise.allSettled([ensureEnergyDays(db), ensureEnergyDays(db), ensureEnergyDays(db), ensureEnergyDays(db)]);
        assert.deepEqual(raced.flatMap((x) => (x.status === "rejected" ? [String(x.reason)] : [])), []);
        await ensureEnergyDays(db);
        assert.deepEqual(await readEnergyDay(db, A1, today), { reviews: 2, entries: 1, toldAt: null });
        const wins = await Promise.all(Array.from({ length: 10 }, () => claimEnergyDay(db, A1, today, "entries", 2)));
        assert.equal(wins.filter(Boolean).length, 1, "ten racers, one left under the cap");
        await Promise.all(Array.from({ length: 5 }, () => refundEnergyDay(db, A1, today)));
        assert.deepEqual(
          await db.prepare("SELECT entries, entries_refunded FROM energy_days WHERE agent_id = ? AND day = ?").get(A1, today),
          { entries: 2, entries_refunded: 2 },
          "five racing refunds stop at zero used",
        );
        assert.equal((await readEnergyDay(db, A1, today)).entries, 0);
      } finally {
        await admin.query(`DROP SCHEMA ${old} CASCADE`).catch(() => {});
      }
    });

    await t.test("THE STORE'S POSTGRES BACKEND runs every new statement", async () => {
      const s = await import("./store");
      process.env.DATABASE_URL = scoped("store");
      try {
        await s.initStore();
        const A3 = "0xC3c3C3c3c3C3c3C3c3c3c3c3C3c3c3C3C3c3c3c3";
        await s.ensureAgent({ smartAccount: A3, owner: "0x9", sessionKeyAddress: "0x8", chainId: 4663, caps: {}, grantedAt: nowSec, expiresAt: nowSec + 86_400 } as never);
        await s.setAgentMode(A3, "live", nowSec, false, null);
        await s.setAgentEnergy(A3, JSON.stringify({ v: 1 }));
        assert.equal(((await shared.prepare("SELECT energy FROM agents WHERE smart_account = ?").get(A3)) as { energy: string }).energy, '{"v":1}');

        const day = "2099-01-01";
        const wins = await Promise.all(Array.from({ length: 20 }, () => s.claimEnergy(A3, day, "entries", 3)));
        assert.equal(wins.filter(Boolean).length, 3, "twenty racers, a cap of three");
        await s.refundEnergy(A3, day, "entries");
        assert.deepEqual(await s.getEnergyDay(A3, day), { reviews: 0, entries: 2, toldAt: null });
        const again = await Promise.all(Array.from({ length: 20 }, () => s.claimEnergy(A3, day, "entries", 3)));
        assert.equal(again.filter(Boolean).length, 1, "a refund is room for exactly one more, however many race");
        assert.deepEqual(
          await shared.prepare("SELECT entries, entries_refunded FROM energy_days WHERE agent_id = ? AND day = ?").get(A3, day),
          { entries: 4, entries_refunded: 1 },
        );
        await s.refundEnergy(A3, day, "entries");
        assert.deepEqual(await s.getEnergyDay(A3, day), { reviews: 0, entries: 2, toldAt: null });
        assert.deepEqual([await s.claimEnergyNotice(A3, day, nowSec), await s.claimEnergyNotice(A3, day, nowSec + 1)], [true, false]);
        await s.noteEnergyRead(A3, day, true, nowSec);
        await s.noteEnergyRead(A3, day, false, nowSec - 100);
        assert.deepEqual(await s.lastEnergyRead(A3, nowSec - 1_000), { full: true, at: nowSec });

        await s.addEquity(A3, { ethWei: 1n, cashUsdg: 100, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 100, mode: "live", cashReadAt: nowSec - 20 } as never);
        await s.addEquity(A3, { ethWei: 1n, cashUsdg: 90, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 90, mode: "live", flowsHeld: true, cashReadAt: nowSec - 2 } as never);
        assert.deepEqual(await s.lastKnownCashReading(A3), { cashUsdg: 100, at: nowSec - 20 });

        await s.addFlow({ agentId: A3, direction: "in", amountUsdg: 100, source: "chain-log", txHash: "0x" + "d0".repeat(32), blockNumber: 1, logIndex: 0, chainId: 4663, mode: "live" });
        await s.setAgentHwm(A3, 100);
        const buy = { agentId: A3, direction: "out" as const, amountUsdg: 10, source: "energy-buy" as const, txHash: "0x" + "E5".repeat(32), blockNumber: 3, logIndex: 2, chainId: 4663, mode: "live" as const };
        const booked = await Promise.all([s.bookCapitalFlow(buy), s.bookCapitalFlow(buy), s.bookCapitalFlow(buy)]);
        assert.deepEqual(booked.map((b) => b.kind).sort(), ["already", "already", "booked"], "three racers, one booking");
        assert.deepEqual(
          await shared.prepare("SELECT hwm_usdg, hwm_withdrawn_usdg FROM agents WHERE smart_account = ?").get(A3),
          { hwm_usdg: 100, hwm_withdrawn_usdg: 10 },
          "the peak moved exactly once",
        );
        assert.deepEqual([await s.hasFlowForTx(A3, "0x" + "e5".repeat(32)), await s.hasChainFlow(A3, "0x" + "E5".repeat(32), 2)], [true, true]);
        assert.deepEqual(await s.getNetContributionsSince(A3, nowSec - 3_600), { epoch: 1, netUsdg: 90, sinceUsdg: 90 });

        await s.addTrade({ agent_id: A3, kind: "energy-buy", target: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", amount_usdg: 10, user_op_hash: "0x" + "AB".repeat(32), tx_hash: "0x" + "e5".repeat(32), status: "landed" } as never);
        await s.addTrade({ agent_id: A3, kind: "energy-buy", target: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", amount_usdg: 10, user_op_hash: "0x" + "CD".repeat(32), status: "submitted" } as never);
        assert.deepEqual(await s.landedOpsBetween(A3, nowSec - 3_600, nowSec + 3_600), ["0x" + "ab".repeat(32)]);
        assert.equal(await s.energyBuysInFlight(A3, nowSec - 3_600), true);
        assert.deepEqual(await s.newestLandedEnergyBuy(A3), { txHash: "0x" + "e5".repeat(32), blockNumber: 3 });
        assert.ok((await s.listSubmittedOps(A3)).some((o) => o.kind === "energy-buy"));
      } finally {
        s.closeStoreForTest();
        delete process.env.DATABASE_URL;
      }
    });

    await t.test("ACCOUNTING REPAIR proposes, inserts and verifies an 'energy-buy' row as evidenced", async () => {
      const A4 = "0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";
      await shared
        .prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, '0x9', '0x8', 4663, '{}', ?, ?)")
        .run(A4, nowSec, nowSec + 86_400);
      await shared.prepare("INSERT INTO flows (agent_id, direction, amount_usdg, source, epoch, chain_id) VALUES (?, 'in', 50, 'inferred', 1, 4663)").run(A4);
      const inferred = (await shared.prepare("SELECT id FROM flows WHERE agent_id = ? AND source = 'inferred'").get(A4)) as { id: number };
      const plan = {
        smartAccount: A4,
        epoch: 1,
        blocked: null,
        insert: [
          { agentId: A4, direction: "in", amountUsdg: 50, txHash: "0x" + "a4".repeat(32), blockNumber: 10, logIndex: 1, epoch: 1, source: "chain-log" },
          { agentId: A4, direction: "out", amountUsdg: 5, txHash: "0x" + "b4".repeat(32), blockNumber: 11, logIndex: 4, epoch: 1, source: "energy-buy" },
        ],
        quarantine: [{ id: inferred.id, reason: "inferred" }],
        existingTotalUsdg: 50,
        contributionsAfterUsdg: 45,
        contributionsKnownBefore: false,
        contributionsKnownAfter: true,
      } as unknown as AccountPlan;
      const opts = { accounts: [], runId: `${schema}-run`, resume: false };
      const done = await repairAccount(shared, plan, { ...opts, mode: "commit" }, 4663);
      assert.equal(done.stage, "recomputed", done.why);
      assert.equal(done.contributionsKnownAfter, true, "energy-buy counts as evidence");
      const verified = await repairAccount(shared, plan, { ...opts, mode: "verify-only" }, 4663);
      assert.equal(verified.stage, "verified", verified.why);
    });

    await t.test("THE NOTIFY FLOW SELECT and a risk period over the migrated equity", async () => {
      const rows = (await shared
        .prepare(
          `SELECT direction, amount_usdg, tx_hash, log_index, source FROM flows
            WHERE agent_id IN (?, ?, ?) AND epoch = ? AND source <> 'epoch-carry' AND at > ? AND at <= ?`,
        )
        .all(A1, A1.toLowerCase(), A1, 2, 0, nowSec + 10)) as { source: string }[];
      assert.deepEqual(rows.map((r) => r.source).sort(), ["chain-log", "energy-buy", "transfer-intent"]);
      await shared.prepare("UPDATE agents SET contributions_known = 1 WHERE smart_account = ?").run(A1);
      await shared
        .prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, flows_held, at) VALUES (?, '1', 1, 0, 0, 999, 2, 'live', 1, ?)")
        .run(A1, nowSec);
      await shared
        .prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, flows_held, at) VALUES (?, '1', 1, 0, 0, 470, 2, 'live', 0, ?)")
        .run(A1, nowSec - 1);
      const period = await startRiskPeriod(shared, A1, `${schema}-rp`, "fresh period", nowSec);
      assert.equal(period.baseline_usdg, 470, "never the held mark");
    });

    await t.test("THE ANNOUNCEMENT, DRY RUN ONLY: the recipients join works on the migrated schema and nothing is sent", async () => {
      const c = await connect(scoped("announce"));
      await c.query("ALTER TABLE tenant_telegram ADD COLUMN IF NOT EXISTS bot_id TEXT");
      await c.query("UPDATE tenant_telegram SET bot_id = CASE tenant WHEN $1 THEN '111' WHEN $2 THEN '222' END WHERE tenant IN ($1, $2)", [T1, T2]);
      await c.query(TELEGRAM_BOT_CLAIMS_DDL);
      await c.query("INSERT INTO telegram_bot_claims (bot_id, tenant, claimed_at) VALUES ('111', $1, 1), ('222', $2, 1)", [T1, T2]);
      const out = await runAnnouncement({
        client: c,
        announceId: "energy-daily-cap-2026-09-28",
        body: readFileSync(ANNOUNCEMENT, "utf8").trim(),
        confirmed: false,
        store: store("announce-store"),
        send: async () => {
          throw new Error("a dry run must never send");
        },
        sleep: async () => {},
      });
      assert.equal(out.dryRun, true);
      assert.equal(out.blockerJoinError, null);
      assert.deepEqual([out.considered, out.eligible, out.sent, out.personalised], [3, 2, 2, 1]);
      assert.deepEqual(
        out.preview.map((p) => [p.tenant, p.blocker]).sort(),
        [[T1, null], [T2, "no-usdg"]],
      );
      assert.ok(out.preview.every((p) => p.chars <= 3_600));
      assert.equal(((await c.query("SELECT count(*)::int AS n FROM announcements")).rows[0] as { n: number }).n, 0, "nothing recorded as sent");
    });
  } finally {
    // Only this run's own schema, whose name was checked before it was made.
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    for (const c of clients) await c.end().catch(() => {});
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of [["DATABASE_URL", saved.db], ["MERRYMEN_STORE_DEK", saved.dek], ["MERRYMEN_HOME", saved.home]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
