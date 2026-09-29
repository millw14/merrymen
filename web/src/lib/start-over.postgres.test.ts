/**
 * REAL POSTGRES: THE PRACTICE RESET START OVER QUEUES, HONOURED BY THE
 * ORCHESTRATOR WHILE THE BOOK IS HELD. Opt-in, like
 * worker/src/pg-upgrade.postgres.test.ts (see its header):
 *
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@localhost:55432/merrymen_pgtest \
 *     npx tsx --test web/src/lib/start-over.postgres.test.ts
 *
 * Skipped without it. A LOCAL Postgres only, in a schema of its own, dropped
 * after.
 *
 * The web's half of worker/src/telegram-fix.postgres.test.ts, here because the
 * row is queued by queuePaperReset (lib/start-over.ts), which only the web's
 * own module resolution can load. From that row on it is the orchestrator's
 * code, as it runs: resetsAsked and applyHeldReset (worker held-reset.ts),
 * resetBlockedPaperBook and restorePaperCheckpoint (paper-checkpoint.ts), and
 * the spawn's anchor (bootstrap-source.ts), over production's schema, with two
 * replicas' connections racing for the same command.
 *
 * WHY. A held practice reset moves the accounting epoch and deletes the
 * practice book's positions and basis. Run twice it would open two epochs; run
 * on a live account it would hide real history. The claim that makes it at most
 * once is a row lock in Postgres, and sqlite, which every other test uses,
 * serialises the two attempts before they can race.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { makePgDb, wrapSqlite, type Db } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import {
  HELD_RESET_DONE,
  HELD_RESET_EXPIRED,
  HELD_RESET_MAX_AGE_MS,
  HELD_RESET_SUPERSEDED,
  applyHeldReset,
  heldResetEvent,
  newestResetAsk,
  resetsAsked,
} from "../../../worker/src/held-reset";
import { resetBlockedPaperBook, restorePaperCheckpoint } from "../../../worker/src/paper-checkpoint";
import { deriveBootstrapAccounting } from "../../../worker/src/bootstrap-source";
import { queuePaperReset } from "./start-over";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}
// LOADED ONLY WHEN A DATABASE IS NAMED: `pg` is not a dependency (see
// worker/src/pg-upgrade.postgres.test.ts), so CI and a plain `npm test` skip cleanly.
const pg = (url ? createRequire(import.meta.url)("pg") : null) as { Client: new (c: { connectionString: string }) => PgClient } | null;
const FIXTURE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..", "..", "..", "worker", "src", "testdata", "shared-schema-75995697.sql",
);

/** Smart accounts, spelled as grants carry them: mixed case, which the command rows keep. */
const account = (n: number) => `0xAbCd${n.toString(16).padStart(36, "0")}` as `0x${string}`;
const EPOCH = 3;
/** When the held book's last valuation was taken, unix seconds. */
const T0 = 1_790_000_000;
const NVDA = "0x" + "4".repeat(40);
const TSLA = "0x" + "5".repeat(40);

/**
 * A practice book the restore refuses, as the shared ledger holds it for a
 * held tenant: a valuation at `EPOCH` and a paper fill after it, an older
 * book's checkpoint, a trade the mirror copied a step ahead of `agents.epoch`,
 * and holdings, paper and live basis, and paper and live floors.
 */
async function heldBook(db: Db, acct: string, o: { mode?: "paper" | "live"; markMode?: "paper" | "live" } = {}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, epoch, mode, hwm_usdg)
       VALUES (?, '0x9', '0x8', 4663, '{}', 1, 2, ?, ?, 1010)`,
    )
    .run(acct, EPOCH, o.mode ?? "paper");
  await db
    .prepare(
      `INSERT INTO paper_checkpoints (agent_id, epoch, cash_usdg, vault_usdg, hwm_usdg, shares, basis_json, updated_at)
       VALUES (?, ?, 1000, 0, 1000, '{}', '[]', ?)`,
    )
    .run(acct, EPOCH - 1, T0 - 86_400);
  await db
    .prepare(
      `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at)
       VALUES (?, '0', 900, 0, 110, 1010, ?, ?, ?)`,
    )
    .run(acct, EPOCH, o.markMode ?? o.mode ?? "paper", T0);
  for (const [epoch, at] of [[EPOCH, T0 + 60], [EPOCH + 1, T0 + 120]] as const) {
    await db
      .prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, epoch, created_at) VALUES (?, 'swap', 'NVDA', 100, 'paper', ?, ?)`)
      .run(acct, epoch, at);
  }
  await db
    .prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, source, epoch, chain_id, at) VALUES (?, 'in', 1000, 'inferred', ?, 4663, ?)`)
    .run(acct, EPOCH, T0 - 3_600);
  await db
    .prepare(
      `INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, value_usdg)
       VALUES (?, 'NVDA', ?, '2000000000000000000', '1000000000000000000', 55, 110)`,
    )
    .run(acct, NVDA);
  for (const [mode, symbol] of [["paper", "NVDA"], ["live", "TSLA"]] as const) {
    await db
      .prepare("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg) VALUES (?, ?, ?, '2000000000000000000', '100000000')")
      .run(acct, mode, symbol);
    await db
      .prepare("INSERT INTO position_floors (agent_id, mode, symbol, stop_bps, rung, why) VALUES (?, ?, ?, 800, 'base', 'test')")
      .run(acct, mode, symbol);
  }
}

test("Postgres: Start over's practice reset, honoured while the book is held", { skip: !url, timeout: 120_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "only a disposable LOCAL Postgres is allowed");
  const schema = `mm_web_reset_test_${randomBytes(8).toString("hex")}`;
  assert.match(schema, /^mm_web_reset_test_[a-f0-9]{16}$/);
  const scoped = (who: string) => {
    const u = new URL(target);
    u.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=20000 -c lock_timeout=10000`);
    u.searchParams.set("application_name", `merrymen-web-reset-test-${who}`);
    return u.toString();
  };
  const saved = { db: process.env.DATABASE_URL, home: process.env.MERRYMEN_HOME };
  const home = mkdtempSync(path.join(os.tmpdir(), "mm-web-reset-"));
  process.env.MERRYMEN_HOME = home;
  // queuePaperReset's ledger (lib/ledger.ts withReadDb) picks Postgres by DATABASE_URL: this run's schema only.
  process.env.DATABASE_URL = scoped("web");

  const clients: PgClient[] = [];
  const admin = new pg!.Client({ connectionString: target.toString() });
  await admin.connect();
  clients.push(admin);
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    const fixture = new pg!.Client({ connectionString: scoped("fixture") });
    await fixture.connect();
    clients.push(fixture);
    await fixture.query(readFileSync(FIXTURE, "utf8"));
    // Two replicas of the orchestrator, each with its own pool.
    const one = await makePgDb(scoped("replica-1"));
    const two = await makePgDb(scoped("replica-2"));
    await applyLedgerSchema(one);

    const num = async (sql: string, ...args: unknown[]) => Number(((await one.prepare(sql).get(...args)) as { n: number | string }).n);
    const epochOf = (acct: string) => num("SELECT epoch AS n FROM agents WHERE smart_account = ?", acct);
    const command = async (id: string) =>
      ({ ...((await one.prepare("SELECT agent_id, kind, created_at, claimed_at, done_at, result FROM agent_commands WHERE id = ?").get(id)) as object) }) as {
        agent_id: string;
        kind: string;
        created_at: number;
        claimed_at: number | null;
        done_at: number | null;
        result: string | null;
      };
    const queue = async (acct: string): Promise<string> => {
      const q = await queuePaperReset(true, acct);
      assert.ok(q.ok, q.ok ? "" : q.error);
      return q.id;
    };
    const opts = (now: number, over: Partial<Parameters<typeof applyHeldReset>[2]> = {}): Parameters<typeof applyHeldReset>[2] => ({
      now,
      readSettings: async () => ({ paperTradingEnabled: true }),
      consentEnforced: true,
      mayWrite: () => null,
      ...over,
    });
    const freshChild = async () => {
      const child = wrapSqlite(new DatabaseSync(":memory:"));
      await applyLedgerSchema(child);
      return child;
    };

    const RACED = [1, 2, 3, 4].map(account);
    const [LIVE, LIVE_MARK, OWNER_LIVE, MOVED, OLD] = [0x11, 0x12, 0x13, 0x14, 0x15].map(account) as [
      `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`,
    ];
    const asked = new Map<string, string[]>();

    await t.test("A HELD BOOK: the restore refuses it, and Start over queues the reset the orchestrator looks for", async () => {
      for (const a of RACED) await heldBook(one, a);
      await heldBook(one, LIVE, { mode: "live" });
      await heldBook(one, LIVE_MARK, { mode: "paper", markMode: "live" });
      for (const a of [OWNER_LIVE, MOVED, OLD]) await heldBook(one, a);
      await assert.rejects(restorePaperCheckpoint(await freshChild(), one, RACED[0]!), /paper fills are newer than the recoverable valuation/);

      const before = Date.now();
      // The owner pressed it twice on the first account; once everywhere else.
      asked.set(RACED[0]!, [await queue(RACED[0]!)]);
      await new Promise((r) => setTimeout(r, 5));
      asked.get(RACED[0]!)!.push(await queue(RACED[0]!));
      for (const a of [...RACED.slice(1), LIVE, LIVE_MARK, OWNER_LIVE, MOVED, OLD]) asked.set(a, [await queue(a)]);
      const after = Date.now();

      const newest = asked.get(RACED[0]!)![1]!;
      const row = await command(newest);
      assert.equal(row.agent_id, RACED[0], "bound to the smart account exactly as the grant spells it");
      assert.equal(row.kind, "paper-reset");
      assert.ok(row.created_at >= before && row.created_at <= after, "milliseconds, read back as a number");
      assert.deepEqual([row.claimed_at, row.done_at, row.result], [null, null, null]);
      assert.deepEqual(await newestResetAsk(two, RACED[0]!), { id: newest, created_at: row.created_at, claimed_at: null });
      assert.equal(await newestResetAsk(two, RACED[0]!.toLowerCase()), null, "the ferry's own predicate: this spelling, and no other");
      const all = await resetsAsked(two, [...RACED, LIVE, "0x" + "e".repeat(40)], Date.now());
      assert.deepEqual(
        [...all].sort(),
        [...RACED, LIVE].map((a) => [a, asked.get(a)!.at(-1)!]).sort(),
        "one row per account asked about, the newest",
      );
    });

    await t.test("A LIVE ACCOUNT IS REFUSED, WHICHEVER SIDE SAYS SO: nothing claimed, nothing moved, nothing deleted", async () => {
      const now = Date.now();
      const cases: [string, Parameters<typeof applyHeldReset>[2], RegExp][] = [
        [LIVE, opts(now), /^the agent last reported the live rail$/],
        [LIVE_MARK, opts(now), /^the newest valuation is not a paper one$/],
        [OWNER_LIVE, opts(now, { readSettings: async () => ({ paperTradingEnabled: true, liveTradingEnabled: true }) }), /^live trading is switched on$/],
      ];
      for (const [acct, o, why] of cases) {
        const out = await applyHeldReset(one, acct, o);
        assert.ok(!out.applied && why.test(out.why) && !out.transient, `${acct}: ${JSON.stringify(out)}`);
        assert.equal(out.id, asked.get(acct)![0]);
        assert.deepEqual((({ claimed_at, done_at, result }) => [claimed_at, done_at, result])(await command(asked.get(acct)![0]!)), [null, null, null]);
        assert.equal(await epochOf(acct), EPOCH);
        assert.equal(await num("SELECT COUNT(*) AS n FROM positions WHERE agent_id = ?", acct), 1);
      }
      // The ledger's own half, asked inside the transaction, refuses on its own too.
      assert.deepEqual(await resetBlockedPaperBook(two, LIVE, EPOCH), { ok: false, why: "the agent last reported the live rail" });
      assert.deepEqual(await resetBlockedPaperBook(two, LIVE_MARK, EPOCH), { ok: false, why: "the newest valuation is not a paper one (live)" });
      for (const acct of [LIVE, LIVE_MARK]) {
        assert.equal(await epochOf(acct), EPOCH);
        assert.equal(await num("SELECT COUNT(*) AS n FROM cost_basis WHERE agent_id = ?", acct), 2, "no basis deleted");
      }
    });

    await t.test("TWO REPLICAS AT ONCE: each reset claimed once, its epoch moved once, its book cleared once", async () => {
      const now = Date.now();
      // Both attempts read the unclaimed row before either writes: each is held
      // at its settings read (which comes after it has read the row) until the
      // other has got there too. From there the claim's row lock decides.
      const race = (acct: string) => {
        let arrived = 0;
        let go!: () => void;
        const both = new Promise<void>((r) => (go = r));
        const readSettings = async () => {
          if (++arrived === 2) go();
          await both;
          return { paperTradingEnabled: true };
        };
        return Promise.all([applyHeldReset(one, acct, opts(now, { readSettings })), applyHeldReset(two, acct, opts(now, { readSettings }))]);
      };
      const results = await Promise.all(RACED.map(race));
      for (const [i, acct] of RACED.entries()) {
        const pair = results[i]!;
        const won = pair.filter((o) => o.applied);
        assert.equal(won.length, 1, `${acct}: ${JSON.stringify(pair)}`);
        const newest = asked.get(acct)!.at(-1)!;
        assert.deepEqual(won[0], { applied: true, id: newest, from: EPOCH, epoch: EPOCH + 2 }, "one past the highest epoch any row carries");
        const lost = pair.find((o) => !o.applied)!;
        assert.deepEqual(lost, { applied: false, id: newest, why: "another pass or replica claimed the reset", transient: false });

        assert.equal(await epochOf(acct), EPOCH + 2, "moved once, not twice");
        assert.deepEqual((({ claimed_at, done_at, result }) => [claimed_at, done_at, result])(await command(newest)), [now, now, HELD_RESET_DONE]);
        for (const older of asked.get(acct)!.slice(0, -1)) {
          assert.deepEqual((({ claimed_at, done_at, result }) => [claimed_at, done_at, result])(await command(older)), [now, now, HELD_RESET_SUPERSEDED]);
        }
        const events = (await one.prepare("SELECT level, message FROM events WHERE agent_id = ?").all(acct)) as { level: string; message: string }[];
        assert.deepEqual(events.map((e) => ({ ...e })), [{ level: "ok", message: heldResetEvent(EPOCH) }], "said once in the feed");
        // The book is gone; its history is not.
        assert.equal(await num("SELECT COUNT(*) AS n FROM positions WHERE agent_id = ?", acct), 0);
        assert.deepEqual(await one.prepare("SELECT mode, symbol FROM cost_basis WHERE agent_id = ?").all(acct), [{ mode: "live", symbol: "TSLA" }]);
        assert.deepEqual(await one.prepare("SELECT mode, symbol FROM position_floors WHERE agent_id = ?").all(acct), [{ mode: "live", symbol: "TSLA" }]);
        assert.equal(await num("SELECT COUNT(*) AS n FROM equity WHERE agent_id = ?", acct), 1);
        assert.equal(await num("SELECT COUNT(*) AS n FROM trades WHERE agent_id = ?", acct), 2);
        assert.equal(await num("SELECT COUNT(*) AS n FROM flows WHERE agent_id = ?", acct), 1);
        assert.equal(await num("SELECT epoch AS n FROM paper_checkpoints WHERE agent_id = ?", acct), EPOCH - 1);
      }
      // Nothing is left for the ferry, nor for another attempt.
      assert.deepEqual([...(await resetsAsked(two, RACED, Date.now()))], []);
      for (const acct of RACED) {
        assert.equal(await newestResetAsk(one, acct), null);
        assert.deepEqual(await applyHeldReset(two, acct, opts(Date.now())), { applied: false, id: null, why: "no practice reset is waiting", transient: false });
      }
    });

    await t.test("AFTER: the spawn's anchor is in the new epoch, and the restore finds a fresh book", async () => {
      for (const acct of RACED) {
        const anchor = await deriveBootstrapAccounting(one, acct, T0 + 3_600);
        assert.equal(anchor.kind, "established", anchor.kind === "unknown" ? anchor.why : "");
        if (anchor.kind !== "established") continue;
        assert.equal(anchor.accountingEpoch, EPOCH + 2);
        assert.equal(anchor.netContributionsUsdg, "0", "no capital flow booked for a practice reset");
        assert.equal(anchor.unanchoredFlowCount, 0, "the old epoch's flows no longer count");
        // What the orchestrator's retry and the next spawn run (tryPaperRestore): a new home, the shared ledger.
        assert.equal(await restorePaperCheckpoint(await freshChild(), two, acct), "no durable checkpoint");
      }
    });

    await t.test("THE EPOCH MOVES BETWEEN THE DECISION AND THE WRITE: the claim rolls back with the reset, and the next attempt honours it", async () => {
      const id = asked.get(MOVED)![0]!;
      // Another writer (the mirror carrying a worker's own reset up) moves the
      // epoch after the decision, exactly where applyHeldReset runs its only
      // DDL before its transaction. The replica's own statements are untouched.
      const other = await makePgDb(scoped("mirror"));
      const movedUnder: Db = {
        prepare: (sql) => one.prepare(sql),
        exec: async (sql) => {
          await other.prepare("UPDATE agents SET epoch = epoch + 1 WHERE smart_account = ?").run(MOVED);
          await one.exec(sql);
        },
        tx: (fn) => one.tx(fn),
      };
      const now = Date.now();
      const out = await applyHeldReset(movedUnder, MOVED, opts(now));
      assert.deepEqual(out, { applied: false, id, why: `the epoch moved (${EPOCH} → ${EPOCH + 1})`, transient: true });
      assert.deepEqual((({ claimed_at, done_at, result }) => [claimed_at, done_at, result])(await command(id)), [null, null, null], "unclaimed: a crash here leaves nothing to replay, and nothing lost");
      assert.equal(await num("SELECT COUNT(*) AS n FROM positions WHERE agent_id = ?", MOVED), 1, "and nothing deleted");
      assert.equal(await num("SELECT COUNT(*) AS n FROM events WHERE agent_id = ?", MOVED), 0);
      const next = await applyHeldReset(two, MOVED, opts(now + 1));
      assert.deepEqual(next, { applied: true, id, from: EPOCH + 1, epoch: EPOCH + 2 });
      assert.equal(await epochOf(MOVED), EPOCH + 2);
    });

    await t.test("A RESET ASKED MORE THAN SEVEN DAYS AGO IS CLOSED UNRUN, and the book is not touched", async () => {
      const id = asked.get(OLD)![0]!;
      const later = Date.now() + HELD_RESET_MAX_AGE_MS + 60_000;
      assert.deepEqual([...(await resetsAsked(one, [OLD], later))], [], "not asked, as far as the retries go");
      const out = await applyHeldReset(two, OLD, opts(later));
      assert.ok(!out.applied && out.id === id && /closed unrun/.test(out.why) && !out.transient, JSON.stringify(out));
      assert.deepEqual((({ claimed_at, done_at, result }) => [claimed_at, done_at, result])(await command(id)), [later, later, HELD_RESET_EXPIRED]);
      assert.equal(await epochOf(OLD), EPOCH);
      assert.equal(await num("SELECT COUNT(*) AS n FROM positions WHERE agent_id = ?", OLD), 1);
    });
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    for (const c of clients) await c.end().catch(() => {});
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of [["DATABASE_URL", saved.db], ["MERRYMEN_HOME", saved.home]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
