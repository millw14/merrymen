/**
 * REAL POSTGRES: EVERY STATEMENT THE TELEGRAM OUTAGE FIX ADDS, OVER THE SCHEMA
 * PRODUCTION RUNS. Opt-in, like pg-upgrade.postgres.test.ts (see its header):
 *
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@localhost:55432/merrymen_pgtest \
 *     npx tsx --test worker/src/telegram-fix.postgres.test.ts
 *
 * Skipped without it (MERRYMEN_TEST_POSTGRES_URL works too). A LOCAL Postgres
 * only, in a schema of its own, `mm_tgfix_test_<hex>`, dropped after; the test
 * never reads DATABASE_URL, and sets it only around the calls that read it.
 * One thing is not in the schema: an advisory lock is DATABASE-WIDE, so the
 * tenant the lease is taken for (T1) is random per run, and two runs against
 * one database (two worktrees sharing a local Postgres) never take each
 * other's lease. Two runs fit a default local Postgres; three do not: this
 * file and start-over.postgres.test.ts hold about 34 connections at their
 * peak, against a default max_connections of 100.
 *
 * WHY. Every other test of this branch runs its SQL on sqlite, and it ships to
 * a shared Postgres that already has the tables, with the web and the
 * orchestrator booting against it at once. So this runs the production
 * functions themselves, through makePgDb and the web's own read helper, never
 * SQL typed out again here:
 *
 * - the new DDL (tenant_telegram's liveness and hold_notified columns, and
 *   telegram_bot_claims, made by the orchestrator AND by the web), four boots
 *   at once from two services and then again, over production's schema with
 *   production's rows, and the column types the code writes seconds and
 *   milliseconds into;
 * - what the orchestrator publishes (telegram-store.ts) read back by
 *   GET /api/telegram's read and decision (web lib/telegram-runtime.ts,
 *   lib/telegram-listening.ts), before the new columns exist and after;
 * - the bot claims (telegram-claims.ts) from both sides and across two
 *   connections, including the orchestrator's own pass (reconcile(), with the
 *   claims in Postgres) against the web's settings save (botClaimForSave), and
 *   two saves for one account at once, on two web pools, settling on what the
 *   sealed settings hold after the write (settleBotClaims);
 * - the hold notice's durable dedupe (hold-notice.ts) and the tenant lease
 *   that makes it one writer.
 *
 * The held practice reset is the web's half too (the row is queued by Start
 * over), so it is in web/src/lib/start-over.postgres.test.ts, beside the code
 * that queues it.
 *
 * THE STARTING POINT IS PRODUCTION'S SCHEMA: testdata/shared-schema-75995697.sql
 * with main's own boot run over it (the DDL pg-upgrade.postgres.test.ts
 * applies), and rows written in THAT shape before any of this branch's DDL runs.
 *
 * THE HOLD NOTICE IS AT LEAST ONCE BY DESIGN (hold-notice.ts: recorded after
 * the send), so two unguarded attempts can both send. What makes concurrent
 * attempts one message is that only the replica holding the tenant's lease
 * reaches it (orchestrator.ts noteHold), and that is what is raced here: ONE
 * SENDER WHILE THE LEASE IS HELD. Not exactly once: noteHold starts the send
 * and does not hold it under the lease, so a lease that changes hands mid-send
 * (a redeploy, a dropped lease connection) can let the next holder read an
 * empty hold_notified and say it again.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { MerrymenSettings, StoredGrant } from "../../packages/core/src/index";
import { advisoryLockWaitersForTest, LockBusyError, makePgDb, translateSchema, withAdvisoryLock, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { PgSettingsStore, resetSettingsStoreForTest, useSettingsStoreForTest, type PgClientLike } from "./settings-store";
import { resetGrantStoreForTest } from "./grant-store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { ENERGY_DAYS_SCHEMA } from "./energy-days";
import { RISK_PERIOD_SCHEMA } from "./risk-period";
import { ANNOUNCE_DDL } from "./announce";
import {
  TELEGRAM_STATE_DDL,
  clearHoldNotified,
  ensureTelegramSchema,
  holdNotifiedClasses,
  livenessFor,
  publishTelegramRuntime,
  publishTenantChildState,
  publishTenantTelegram,
  readTenantTelegram,
} from "./telegram-store";
import {
  botIdOf,
  claimBot,
  claimGate,
  ensureBotClaims,
  moveBotClaim,
  readBotClaims,
  releaseBotClaims,
  undoBotClaim,
} from "./telegram-claims";
import { notifyHoldOnce, type HoldNoticeDeps, type HoldNoticeOutcome } from "./hold-notice";
import { holdNoticeText } from "./restore-block";
import { hostedRecipient } from "./mcp/notify";
import { acquireTenantLease } from "./tenant-lease";
import type { PollHealth } from "./telegram/state";
import { createReadDb } from "../../web/src/lib/ledger";
import { readTelegramRuntime } from "../../web/src/lib/telegram-runtime";
import { LIVE_WITHIN_SEC, telegramListening } from "../../web/src/lib/telegram-listening";
import {
  BOT_CLAIMED_TEXT,
  botClaimForSave,
  decideBotClaim,
  SETTINGS_SAVE_LOCK,
  settingsSaveLockKey,
  settleWithoutToken,
  useBotClaimsDbForTest,
} from "../../web/src/lib/telegram-claims";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;

interface PgClient extends PgClientLike {
  connect(): Promise<void>;
  end(): Promise<void>;
}
// LOADED ONLY WHEN A DATABASE IS NAMED: `pg` is not a dependency (see
// pg-upgrade.postgres.test.ts), so CI and a plain `npm test` skip cleanly.
const pg = (url ? createRequire(import.meta.url)("pg") : null) as { Client: new (c: { connectionString: string }) => PgClient } | null;

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "testdata", "shared-schema-75995697.sql");

const tenantN = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
// Tenants as a login spells them (mixed case) and as the tables key them.
// T1 is RANDOM PER RUN: it is the tenant the lease subtest leases, and an
// advisory lock is database-wide, not per schema (see the header). The fixed
// `abc` makes sure its upper-cased spelling differs.
const T1 = `0x${randomBytes(18).toString("hex")}0abc` as `0x${string}`;
const T1_MIXED = `0x${T1.slice(2).toUpperCase()}` as `0x${string}`;
const T2 = "0x2222222222222222222222222222222222222222" as const;
const T3 = "0x3333333333333333333333333333333333333333" as const;
const TA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const TA_MIXED = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" as `0x${string}`;
const TB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const OWNER_CHAT = 424242;
const TOKEN_111 = "111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
/** 2100-01-01T00:00:00Z: a time in seconds no INTEGER (int4) column could hold. */
const FAR = 4_102_444_800;
const FAR_MS = FAR * 1000;
const NEWER = "trades newer than the last valuation";
const NO_BASIS = "a holding has no cost basis";

const heard = (botId: string, over: Partial<PollHealth> = {}): PollHealth => ({ okAt: FAR - 20, err: null, errAt: null, botId, ...over });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("Postgres: the Telegram outage fix over production's schema", { skip: !url, timeout: 180_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "only a disposable LOCAL Postgres is allowed");
  const schema = `mm_tgfix_test_${randomBytes(8).toString("hex")}`;
  assert.match(schema, /^mm_tgfix_test_[a-f0-9]{16}$/);
  // One URL per service and purpose: makePgDb keeps one pool per URL, so each
  // is its own set of connections, as the web and the orchestrator are.
  const scoped = (who: string) => {
    const u = new URL(target);
    u.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=20000 -c lock_timeout=10000`);
    u.searchParams.set("application_name", `merrymen-tgfix-test-${who}`);
    return u.toString();
  };

  // The process environment the stores read, pointed at this run and put back after.
  const saved = {
    db: process.env.DATABASE_URL,
    dek: process.env.MERRYMEN_STORE_DEK,
    home: process.env.MERRYMEN_HOME,
    hosted: process.env.MERRYMEN_HOSTED,
    tgEnabled: process.env.MERRYMEN_TELEGRAM_ENABLED,
  };
  const home = mkdtempSync(path.join(os.tmpdir(), "mm-tgfix-"));
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 11).toString("base64");
  process.env.MERRYMEN_HOME = home;
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_TELEGRAM_ENABLED;
  /** Run `fn` with DATABASE_URL naming this run's schema, for the code that reads it (the lease, the web's read helper). */
  const withDatabaseUrl = async <T>(who: string, fn: () => Promise<T>): Promise<T> => {
    process.env.DATABASE_URL = scoped(who);
    try {
      return await fn();
    } finally {
      delete process.env.DATABASE_URL;
    }
  };

  const clients: PgClient[] = [];
  const connect = async (u: string): Promise<PgClient> => {
    const c = new pg!.Client({ connectionString: u });
    await c.connect();
    clients.push(c);
    return c;
  };
  const admin = await connect(target.toString());
  await admin.query(`CREATE SCHEMA ${schema}`);
  const orchestratorSeams: { reset?: () => void } = {};
  try {
    const orch = await makePgDb(scoped("orchestrator"));
    const web = await makePgDb(scoped("web"));
    const settings = new PgSettingsStore(scoped("settings"), connect);
    /** What a save's claim step reads back after its write: the sealed settings in this Postgres. */
    const pgSettings = (before: MerrymenSettings | null) => ({ before, read: (tn: `0x${string}`) => settings.get(tn) });
    /** For a claim step whose settle and undo these subtests never run. */
    const nothingStored = { before: null, read: async () => null };
    const cols = async (table: string) =>
      new Map(
        ((await orch
          .prepare("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?")
          .all(table)) as { column_name: string; data_type: string }[]).map((r) => [r.column_name, r.data_type]),
      );

    // GET /api/telegram's read, through the web's own read helper (the route's
    // withReadDb), and its decision: what the owner's screen would say.
    const withReadDb = createReadDb(makePgDb);
    const webRead = (tenant: `0x${string}`, confirmedBot: string | null) =>
      withDatabaseUrl("web-read", () => withReadDb((db) => readTelegramRuntime(db!, tenant, confirmedBot)));
    const dashboard = async (tenant: `0x${string}`, token: string | null, now: number, o: { confirmed?: boolean } = {}) => {
      const confirmed = token && o.confirmed !== false ? botIdOf(token) : null;
      return telegramListening(await webRead(tenant, confirmed), token, now);
    };

    // The hold notice as the orchestrator composes it (sendHoldNotice): its
    // recipient over this Postgres, the stored allowlist, and a bot that
    // records what it was asked to send instead of sending it.
    const sent: { chatId: number; text: string }[] = [];
    const noticeDeps = (db: Db, o: { sendMs?: number } = {}): HoldNoticeDeps => ({
      db,
      recipient: hostedRecipient(db, settings),
      allowlist: async (tn) => {
        const s = await settings.get(tn);
        return Array.isArray(s?.telegramAllowlist) ? s.telegramAllowlist : [];
      },
      send: async (_token, chatId, text) => {
        if (o.sendMs) await sleep(o.sendMs);
        sent.push({ chatId, text });
        return { ok: true };
      },
      log: () => {},
    });

    await t.test("production's schema, with the energy release booted over it and rows in its shape", async () => {
      // Loaded verbatim, not through Db.exec, whose translation must not touch production's own DDL.
      await (await connect(scoped("fixture"))).query(readFileSync(FIXTURE, "utf8"));
      // The boot main ships today (pg-upgrade.postgres.test.ts BOOT).
      await settings.listTenants();
      await applyLedgerSchema(orch);
      await orch.exec(translateSchema(MIRROR_STATE_DDL));
      await orch.exec(translateSchema(TELEGRAM_STATE_DDL));
      await orch.exec(ENERGY_DAYS_SCHEMA);
      await orch.exec(RISK_PERIOD_SCHEMA);
      await orch.exec(ANNOUNCE_DDL);
      // A linked tenant and one that never linked, published by the code
      // production runs now (the child's code and owner, ferried up).
      await publishTenantTelegram(orch, T1, { linkCode: "OLDC0D", ownerId: OWNER_CHAT, linkedAt: 1_790_000_000 });
      await publishTenantTelegram(orch, T2, { linkCode: "T2C0DE", ownerId: null, linkedAt: null });
      await settings.put(T1, { telegramEnabled: true, telegramBotToken: TOKEN_111, telegramAllowlist: [OWNER_CHAT] } as MerrymenSettings);
      const tt = await cols("tenant_telegram");
      for (const c of ["bot_id", "poll_ok_at", "poll_err", "poll_err_at", "child_state", "hold_notified"]) {
        assert.ok(!tt.has(c), `production has no ${c} yet`);
      }
      assert.equal((await cols("telegram_bot_claims")).size, 0, "nor a claims table");
    });

    await t.test("BEFORE THE NEW DDL: the web reads the old way, a publish still lands the code, a notice fails without sending", async () => {
      // The web can deploy before the orchestrator's first pass adds anything.
      const old = await webRead(T1, "111");
      assert.deepEqual(old, { linkCode: "OLDC0D", ownerId: OWNER_CHAT }, "the legacy read: code and owner, nothing claimed about listening");
      const seen = telegramListening(old, TOKEN_111, FAR);
      assert.deepEqual([seen.listening.state, seen.linkCode, seen.linkPending], ["unknown", "OLDC0D", false]);
      assert.deepEqual(await webRead(T3, "111"), { linkCode: null, ownerId: null }, "no row and no claims table: nothing known, and no throw");
      // The orchestrator publishing before its ALTERs ran: the liveness half
      // fails and says so, and the code and owner land all the same.
      const failed = await publishTelegramRuntime(orch, T2, { linkCode: "T2NEW1", ownerId: null, linkedAt: null }, livenessFor({ botId: "222", poll: heard("222") }, "222", "trading"));
      assert.ok(failed instanceof Error && /poll_ok_at|bot_id|column/.test(failed.message), String(failed));
      assert.deepEqual(await readTenantTelegram(orch, T2), { linkCode: "T2NEW1", ownerId: null, linkedAt: null });
      // The notice reads the durable record before it sends; with no column
      // there is no record, so nothing is sent (and the next attempt tries again).
      assert.equal(await notifyHoldOnce(noticeDeps(orch), T1, NEWER, true), "failed");
      assert.equal(sent.length, 0);
    });

    await t.test("BOOT: the new DDL from the orchestrator and the web, four at once, then again — all clean, and BIGINT where times are written", async () => {
      // The orchestrator: tenant_telegram and its ALTERs through the one
      // function mirrorLedgers and sendHoldNotice both call, and the claims
      // table as botClaimsDb makes it. Production does not throw a failed
      // ALTER; on Postgres there must be none, so here each one is a failure.
      const orchestratorBoot = async (db: Db) => {
        assert.deepEqual((await ensureTelegramSchema(db)).map(String), [], "no ALTER failed");
        await ensureBotClaims(db);
      };
      // The web: a settings save carrying no token still makes the claims
      // table (decideBotClaim), and the dashboard's read runs beside it.
      const webBoot = async (db: Db) => {
        const d = await decideBotClaim({ db, tenant: T3, token: undefined, moveBot: false, confirmBot: async () => null, settings: nothingStored });
        assert.equal(d.ok, true);
        await readTelegramRuntime(db, T3, null);
      };
      // Fresh pools each time: ensureBotClaims runs its CREATE once per Db.
      const pools = async (round: string) => Promise.all(["o1", "w1", "o2", "w2"].map((who) => makePgDb(scoped(`${round}-${who}`))));
      const [o1, w1, o2, w2] = await pools("boot1");
      const raced = await Promise.allSettled([orchestratorBoot(o1!), webBoot(w1!), orchestratorBoot(o2!), webBoot(w2!)]);
      assert.deepEqual(raced.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error).message)] : [])), [], "no racing boot failed");
      const again = await pools("boot2");
      const second = await Promise.allSettled([orchestratorBoot(again[0]!), webBoot(again[1]!), orchestratorBoot(again[2]!), webBoot(again[3]!)]);
      assert.deepEqual(second.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error).message)] : [])), [], "and again, over the tables they made");

      const tt = await cols("tenant_telegram");
      for (const [c, type] of [
        ["bot_id", "text"],
        ["poll_ok_at", "bigint"],
        ["poll_err", "text"],
        ["poll_err_at", "bigint"],
        ["child_state", "text"],
        ["hold_notified", "text"],
        ["owner_id", "bigint"],
      ] as const) {
        assert.equal(tt.get(c), type, `tenant_telegram.${c}`);
      }
      const claims = await cols("telegram_bot_claims");
      assert.deepEqual(Object.fromEntries(claims), { bot_id: "text", tenant: "text", claimed_at: "bigint" }, "claimed_at is epoch milliseconds: BIGINT");
      const pk = (await orch
        .prepare(
          `SELECT a.attname AS col FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = 'telegram_bot_claims'::regclass AND i.indisprimary`,
        )
        .all()) as { col: string }[];
      assert.deepEqual(pk.map((r) => r.col), ["bot_id"], "one row per bot: the primary key is the rule");
    });

    await t.test("THE ROWS FROM BEFORE read the same, and a code no bot has vouched for yet is not shown as the saved bot's", async () => {
      assert.deepEqual(await readTenantTelegram(orch, T1), { linkCode: "OLDC0D", ownerId: OWNER_CHAT, linkedAt: 1_790_000_000 });
      const row = await webRead(T1, "111");
      assert.equal(row?.linkCode, "OLDC0D");
      assert.equal(row?.botId, null, "the full read now: published, but no bot yet");
      assert.equal(row?.botElsewhere, undefined, "nobody has claimed 111");
      const seen = telegramListening(row, TOKEN_111, FAR);
      assert.deepEqual([seen.listening.state, seen.linkCode, seen.linkPending], ["unknown", null, true], "waiting for the agent to pick the bot up");
    });

    await t.test("PUBLISH → DASHBOARD: the orchestrator's row is what GET /api/telegram reads, and the code is shown only for its own bot", async () => {
      // Published under the spelling a login uses; the row is keyed lower case.
      // publishTelegramRuntime returns a failed liveness UPDATE rather than
      // throwing it, so every call here asserts null: a type or column error
      // is reported as itself, not as a wrong dashboard later.
      const pub = (tenant: `0x${string}`, poll: PollHealth | null, handed: string | null, code = "K7M2QX", child = "trading") =>
        publishTelegramRuntime(orch, tenant, { linkCode: code, ownerId: OWNER_CHAT, linkedAt: 1_790_000_000 }, livenessFor({ botId: "111", poll }, handed, child));
      assert.equal(await pub(T1_MIXED, heard("111"), "111"), null);
      const raw = (await orch.prepare("SELECT bot_id, poll_ok_at, poll_err, poll_err_at, child_state FROM tenant_telegram WHERE tenant = ?").get(T1)) as Record<string, unknown>;
      assert.deepEqual({ ...raw }, { bot_id: "111", poll_ok_at: FAR - 20, poll_err: null, poll_err_at: null, child_state: "trading" }, "seconds past 2038 round-trip exactly");

      const live = await dashboard(T1, TOKEN_111, FAR);
      assert.deepEqual(live.listening, { state: "live", lastOkAt: FAR - 20, reason: null });
      assert.deepEqual([live.linkCode, live.linkPending, live.botElsewhere, live.tradingHeld], ["K7M2QX", false, false, null]);
      // And read under the spelling a login uses: the reader lowercases too.
      assert.deepEqual(await dashboard(T1_MIXED, TOKEN_111, FAR), live);
      // The owner saves a token for another bot: that code would not link it.
      const other = await dashboard(T1, "999:AAHotherbotsecret", FAR);
      assert.deepEqual([other.linkCode, other.linkPending, other.listening.state], [null, true, "unknown"]);
      // Heard, then not for longer than the dashboard calls live.
      assert.equal((await dashboard(T1, TOKEN_111, FAR - 20 + LIVE_WITHIN_SEC + 1)).listening.state, "not-listening");
      // A refused token is said at once, with Telegram's words and no token.
      assert.equal(await pub(T1, heard("111", { okAt: FAR - 3_600, err: "refused: 401 Unauthorized", errAt: FAR - 30 }), "111"), null);
      assert.deepEqual((await dashboard(T1, TOKEN_111, FAR)).listening, { state: "revoked", lastOkAt: FAR - 3_600, reason: "401 Unauthorized" });
      // Another program on the bot, once it has kept it unheard.
      assert.equal(await pub(T1, heard("111", { okAt: FAR - 3_600, err: "conflict: 409 Conflict: terminated by other getUpdates request", errAt: FAR - 30 }), "111"), null);
      assert.equal((await dashboard(T1, TOKEN_111, FAR)).listening.state, "conflict");
      // A record about another bot publishes nulls: nothing heard on this one.
      assert.equal(await pub(T1, heard("999"), "111"), null);
      const unheard = await dashboard(T1, TOKEN_111, FAR);
      assert.deepEqual([unheard.listening.state, unheard.linkCode], ["unknown", "K7M2QX"]);
      // A process no longer handed the bot's token publishes no bot, so the code it still holds is never shown for it.
      assert.equal(await pub(T1, heard("111"), null), null);
      assert.deepEqual((await orch.prepare("SELECT bot_id FROM tenant_telegram WHERE tenant = ?").get(T1)) as object, { bot_id: null });
      assert.equal((await dashboard(T1, TOKEN_111, FAR)).linkCode, null);
      // Each tenant reads its own row.
      assert.equal(await pub(T1, heard("111"), "111"), null);
      assert.equal(
        await publishTelegramRuntime(orch, T2, { linkCode: "B0BC0D", ownerId: null, linkedAt: null }, livenessFor({ botId: "111", poll: heard("111") }, "111", "trading")),
        null,
      );
      assert.deepEqual([(await dashboard(T1, TOKEN_111, FAR)).linkCode, (await dashboard(T2, TOKEN_111, FAR)).linkCode], ["K7M2QX", "B0BC0D"]);
    });

    await t.test("HELD, BOT OR NO BOT: the child state is published and read, and a hold row is no link", async () => {
      await publishTenantChildState(orch, T1, `held:${NEWER}`);
      const held = await dashboard(T1, TOKEN_111, FAR);
      assert.deepEqual([held.listening.state, held.listening.reason, held.tradingHeld, held.linkCode], ["held", NEWER, NEWER, "K7M2QX"], "the hold process answers, so the code stays");
      await publishTenantChildState(orch, T1, "trading");
      assert.equal((await dashboard(T1, TOKEN_111, FAR)).tradingHeld, null);
      // A held tenant with no bot and no row: the hold makes a row that says only that.
      await publishTenantChildState(orch, T3, `held:${NO_BASIS}`);
      assert.equal(await readTenantTelegram(orch, T3), null, "no link, not 'linked once, then unlinked'");
      const noBot = await dashboard(T3, null, FAR);
      assert.deepEqual([noBot.tradingHeld, noBot.linkCode, noBot.linkPending], [NO_BASIS, null, false]);
      assert.equal((await noticeDeps(orch).recipient(T3)), null, "and no recipient for a notice");
      await publishTenantChildState(orch, T3, "trading");
      assert.equal((await dashboard(T3, null, FAR)).tradingHeld, null);
      // Trading only puts back a hold: a tenant that never had a bot or a hold gets no row.
      const never = tenantN(0x7777);
      await publishTenantChildState(orch, never, "trading");
      assert.equal(await webRead(never, null), null);
    });

    await t.test("CLAIMS: a confirmed first claim wins, a second tenant is refused, a move and its undo, and a release only by the holder", async () => {
      const bot = "9001";
      assert.equal(await claimBot(orch, bot, TA, null, FAR_MS), null, "no getMe, no claim");
      assert.equal(await claimBot(orch, bot, TA, "9002", FAR_MS), null, "getMe for another bot, no claim");
      assert.equal((await readBotClaims(web)).get(bot), undefined);
      assert.deepEqual(await claimBot(orch, bot, TA_MIXED, bot, FAR_MS), { holder: TA, fresh: true, stamp: FAR_MS });
      assert.deepEqual(await claimBot(web, bot, TB, bot, FAR_MS + 1), { holder: TA, fresh: false, stamp: FAR_MS }, "first one wins");
      assert.deepEqual(await claimBot(web, bot, TA, bot, FAR_MS + 2), { holder: TA, fresh: false, stamp: FAR_MS }, "its own again: the stamp is the first");
      // The web's settings save over the same row: refused, naming nobody.
      const refused = await decideBotClaim({ db: web, tenant: TB, token: `${bot}:BBB-secret`, moveBot: false, confirmBot: async () => bot, settings: nothingStored });
      assert.ok(!refused.ok && refused.status === 409 && refused.body.error === "bot_claimed");
      assert.deepEqual(refused.body.errors, [BOT_CLAIMED_TEXT]);
      assert.ok(!JSON.stringify(refused).includes(TA.slice(2)));
      // A token Telegram does not vouch for moves nothing, whatever the claims say.
      assert.deepEqual(await moveBotClaim(web, bot, TB, null, FAR_MS + 5), { moved: false, why: "unconfirmed" });
      const move = await moveBotClaim(web, bot, TB, bot, FAR_MS + 10);
      assert.deepEqual(move, { moved: true, from: { tenant: TA, claimedAt: FAR_MS }, stamp: FAR_MS + 10 });
      const row = async () => ({ ...((await orch.prepare("SELECT tenant, claimed_at FROM telegram_bot_claims WHERE bot_id = ?").get(bot)) as object) });
      assert.deepEqual(await row(), { tenant: TB, claimed_at: FAR_MS + 10 }, "milliseconds past 2038 round-trip exactly");
      // The save the move was for failed: the claim goes back, stamp and all.
      await undoBotClaim(orch, bot, TB, FAR_MS + 10, move.moved ? move.from : null);
      assert.deepEqual(await row(), { tenant: TA, claimed_at: FAR_MS });
      // An undo that is not the row's any more changes nothing.
      await undoBotClaim(web, bot, TB, FAR_MS + 10, null);
      await undoBotClaim(web, bot, TA, FAR_MS + 999, null);
      assert.deepEqual(await row(), { tenant: TA, claimed_at: FAR_MS });
      // Release names its tenant: nobody lets go of a claim that is not theirs.
      assert.equal(await releaseBotClaims(web, TB), 0);
      assert.equal(await releaseBotClaims(web, TA, bot), 0, "the bot it keeps is kept");
      assert.equal(await releaseBotClaims(orch, TA_MIXED), 1);
      assert.equal((await readBotClaims(web)).get(bot), undefined);
      // "Move it here" onto a bot nobody holds is a fresh claim, and its undo deletes it.
      assert.deepEqual(await moveBotClaim(web, bot, TB, bot, FAR_MS + 20), { moved: true, from: null, stamp: FAR_MS + 20 });
      assert.deepEqual(await row(), { tenant: TB, claimed_at: FAR_MS + 20 });
      await undoBotClaim(orch, bot, TB, FAR_MS + 20, null);
      assert.equal((await readBotClaims(web)).get(bot), undefined);
      // The web's fresh claim for a save that then failed is taken back; one that landed lets go of the bot it left.
      const fresh = await decideBotClaim({ db: web, tenant: TB, token: `${bot}:BBB-secret`, moveBot: false, confirmBot: async () => bot, settings: nothingStored });
      assert.ok(fresh.ok && !fresh.moved);
      assert.equal((await readBotClaims(orch)).get(bot), TB);
      await fresh.undo();
      assert.equal((await readBotClaims(orch)).get(bot), undefined, "a claim never outlives a token that was not stored");
      await claimBot(web, "9003", TB, "9003", FAR_MS);
      const switched = await decideBotClaim({ db: web, tenant: TB, token: `${bot}:BBB-secret`, moveBot: false, confirmBot: async () => bot, settings: pgSettings(null) });
      assert.ok(switched.ok);
      await settings.put(TB, { telegramBotToken: `${bot}:BBB-secret` } as MerrymenSettings);
      await switched.settle();
      const now = await readBotClaims(orch);
      assert.deepEqual([now.get(bot), now.get("9003")], [TB, undefined], "saved a different bot: the old one is free");
    });

    await t.test("CLAIMS ACROSS TWO CONNECTIONS: exactly one winner, from the store and from the web's save alike", async () => {
      const racers = Array.from({ length: 12 }, (_, i) => tenantN(0x9100 + i));
      const bot = "9101";
      const claims = await Promise.all(racers.map((tn, i) => claimBot(i % 2 ? web : orch, bot, tn, bot, FAR_MS + i)));
      const winners = claims.filter((c) => c?.fresh);
      assert.equal(winners.length, 1, JSON.stringify(claims));
      assert.ok(claims.every((c) => c !== null && c.holder === winners[0]!.holder && c.stamp === winners[0]!.stamp), "every loser is told the one holder");
      assert.equal((await readBotClaims(orch)).get(bot), winners[0]!.holder);

      const bot2 = "9102";
      const saves = await Promise.all(
        racers.slice(0, 6).map((tn, i) =>
          decideBotClaim({ db: i % 2 ? web : orch, tenant: tn, token: `${bot2}:secret-${i}`, moveBot: false, confirmBot: async (tok) => botIdOf(tok), settings: nothingStored }),
        ),
      );
      assert.equal(saves.filter((s) => s.ok).length, 1, "one save claims the bot");
      assert.ok(saves.every((s) => s.ok || (s.status === 409 && s.body.error === "bot_claimed")), "the rest are told it is taken");

      // Two logins pressing "move it here" at once, both confirmed. Both move,
      // one after the other: each UPDATE names the holder and stamp it read,
      // so the second changes the row only as the first left it, and says so.
      // Its `from` is what undoBotClaim puts back when its save fails: a
      // second move that claimed to have taken the bot from TA again would,
      // on its undo, hand the bot to TA instead of to the account it
      // displaced, the wrong-tenant hand-over this table exists to stop.
      const claimRow = async (b: string) =>
        ({ ...((await orch.prepare("SELECT tenant, claimed_at FROM telegram_bot_claims WHERE bot_id = ?").get(b)) as object) }) as {
          tenant: string;
          claimed_at: number;
        };
      const twoMoves = async (b: string, dbTB: Db, dbT3: Db) => {
        await claimBot(orch, b, TA, b, FAR_MS);
        const [m1, m2] = await Promise.all([moveBotClaim(dbTB, b, TB, b, FAR_MS + 1), moveBotClaim(dbT3, b, T3, b, FAR_MS + 2)]);
        assert.ok(m1.moved && m2.moved);
        const end = await claimRow(b);
        assert.ok(end.tenant === TB || end.tenant === T3, JSON.stringify(end));
        const [first, last, firstTenant] = end.tenant === TB ? [m2, m1, T3] : [m1, m2, TB];
        assert.equal(end.claimed_at, last.stamp, "the row is exactly what its last mover wrote");
        assert.deepEqual(first.from, { tenant: TA, claimedAt: FAR_MS }, "the first took it from the holder");
        assert.deepEqual(last.from, { tenant: firstTenant, claimedAt: first.stamp }, "the last took it from the first, never from TA a second time");
        // The last save fails: its undo puts the first mover back, not TA.
        await undoBotClaim(orch, b, end.tenant, last.stamp, last.from);
        assert.deepEqual(await claimRow(b), { tenant: firstTenant, claimed_at: first.stamp });
        // And then the first's: TA, stamp and all.
        await undoBotClaim(web, b, firstTenant, first.stamp, first.from);
        assert.deepEqual(await claimRow(b), { tenant: TA, claimed_at: FAR_MS });
      };
      await twoMoves("9103", orch, web);

      // The same, with the overlap made certain rather than likely: each mover
      // is held after its first read of the row until the other has read it
      // too, so both hold TA's row when they write. One UPDATE lands; the
      // other's names a holder that is gone, changes nothing, and reads again.
      // Without the compare-and-set both would land, and both say "from TA".
      const both = (() => {
        let arrived = 0;
        let open!: () => void;
        let stuck!: (e: Error) => void;
        const all = new Promise<void>((res, rej) => ((open = res), (stuck = rej)));
        all.catch(() => {});
        const timer = setTimeout(() => stuck(new Error("the other mover never read the claim row")), 10_000);
        timer.unref();
        return () => {
          if (++arrived === 2) {
            clearTimeout(timer);
            open();
          }
          return all;
        };
      })();
      let rowReads = 0;
      const readsThenWaits = (db: Db): Db => {
        let first = true;
        return {
          prepare: (sql) => {
            const stmt = db.prepare(sql);
            if (!sql.startsWith("SELECT tenant, claimed_at FROM telegram_bot_claims")) return stmt;
            return {
              run: (...a) => stmt.run(...a),
              all: (...a) => stmt.all(...a),
              get: async (...a) => {
                rowReads += 1;
                const got = await stmt.get(...a);
                if (first) {
                  first = false;
                  await both();
                }
                return got;
              },
            };
          },
          exec: (sql) => db.exec(sql),
          tx: (fn) => db.tx(fn),
        };
      };
      await twoMoves("9104", readsThenWaits(orch), readsThenWaits(web));
      assert.equal(rowReads, 3, "one mover's UPDATE was refused as stale, and it read the row again");
    });

    await t.test("TWO SAVES FOR ONE ACCOUNT AT ONCE, on two web pools over the sealed settings: the claims end on the bot stored last", async () => {
      // The settings PUT's claim step (decideBotClaim, settleBotClaims,
      // undoBotClaimUnlessSaved) as two web replicas run it: the claims on two
      // pools, the settings read back from the sealed store the save writes.
      // Before this, each save let go of every bot but its own, so the save
      // whose settle ran last kept ITS bot, whichever token was stored.
      const web2 = await makePgDb(scoped("web-replica"));
      const TW = tenantN(0xe1);
      const tokenOf = (bot: string, n: number | string) => `${bot}:WWW-secret-${n}`;
      const mine = async () => [...(await readBotClaims(orch))].filter(([, tn]) => tn === TW).map(([b]) => b).sort();
      const stampOf = async (bot: string) =>
        Number(((await orch.prepare("SELECT claimed_at FROM telegram_bot_claims WHERE bot_id = ?").get(bot)) as { claimed_at: number }).claimed_at);
      const storedBot = async () => botIdOf((await settings.get(TW))!.telegramBotToken!);
      const write = (token: string) => settings.put(TW, { telegramEnabled: true, telegramBotToken: token } as MerrymenSettings);
      const decide = async (db: Db, token: string, over: Partial<Parameters<typeof decideBotClaim>[0]> = {}) => {
        const d = await decideBotClaim({ db, tenant: TW, token, moveBot: false, confirmBot: async (tok) => botIdOf(tok), settings: pgSettings(await settings.get(TW)), ...over });
        assert.ok(d.ok, JSON.stringify(d));
        return d;
      };
      /** TW stores bot 9300's token and holds its claim. */
      const start = async () => {
        await releaseBotClaims(orch, TW);
        await write(tokenOf("9300", "prior"));
        await claimBot(orch, "9300", TW, "9300", FAR_MS);
      };
      /** A read of the store that, once armed, returns what it read only after `meanwhile` has run. */
      let meanwhile: (() => Promise<void>) | null = null;
      const overtaken = async (tn: `0x${string}`) => {
        const got = await settings.get(tn);
        const fn = meanwhile;
        meanwhile = null;
        if (fn) await fn();
        return got;
      };

      // Both claimed before either wrote; the writes and the settles after
      // them in each order. The first two orders are the review's: the save
      // for 9301's settle runs last, after 9302 was stored, and after 9301 was.
      for (const [writes, settles] of [[[0, 1], [1, 0]], [[1, 0], [1, 0]], [[0, 1], [0, 1]], [[1, 0], [0, 1]]] as const) {
        await start();
        const tokens = [tokenOf("9301", "x"), tokenOf("9302", "x")] as const;
        const saves = [await decide(web, tokens[0]), await decide(web2, tokens[1])] as const;
        assert.deepEqual(await mine(), ["9300", "9301", "9302"]);
        for (const i of writes) await write(tokens[i]);
        for (const i of settles) await saves[i].settle();
        const last = botIdOf(tokens[writes[1]])!;
        assert.equal(await storedBot(), last);
        assert.deepEqual(await mine(), [last], `written ${writes.join(",")}, settled ${settles.join(",")}`);
      }

      // A settle overtaken mid-flight: it reads 9301, and before it lets go of
      // anything the save for 9302 writes and settles to the end. Its release
      // (DELETE … RETURNING, on the other pool) takes 9302's claim with it; its
      // next read says 9302, so it puts that claim back, stamp and all.
      await start();
      const one = await decide(web, tokenOf("9301", "o"), { settings: { before: await settings.get(TW), read: overtaken }, now: FAR_MS + 1 });
      const two = await decide(web2, tokenOf("9302", "o"), { now: FAR_MS + 2 });
      await write(tokenOf("9301", "o"));
      meanwhile = async () => {
        await write(tokenOf("9302", "o"));
        await two.settle();
        assert.deepEqual(await mine(), ["9302"]);
      };
      await one.settle();
      assert.equal(meanwhile, null, "the overtaking save ran");
      assert.deepEqual(await mine(), ["9302"]);
      assert.equal(await stampOf("9302"), FAR_MS + 2, "put back as it was, milliseconds past 2038 and all");

      // A failed save's undo, overtaken the same way by a save for the same
      // bot that decided on its claim (made none of its own) and lands.
      await start();
      const failed = await decide(web, tokenOf("9303", "a"), { settings: { before: await settings.get(TW), read: overtaken }, now: FAR_MS + 3 });
      const landed = await decide(web2, tokenOf("9303", "b"), { now: FAR_MS + 4 });
      meanwhile = async () => {
        await write(tokenOf("9303", "b"));
        await landed.settle();
      };
      await failed.undo();
      assert.equal(meanwhile, null);
      assert.deepEqual(await mine(), ["9303"], "the failed save did not take the landed one's claim away");
      assert.equal(await stampOf("9303"), FAR_MS + 3);

      // And at once, with no order imposed: rounds of three saves, each its
      // own claim, write and settle, on alternating pools. Whichever write the
      // store kept, the account holds that bot and no other.
      for (let round = 0; round < 10; round++) {
        const tokens = ["9311", "9312", "9313"].map((b) => tokenOf(b, round));
        await Promise.all(
          tokens.map(async (token, i) => {
            const d = await decide(i % 2 ? web2 : web, token);
            await write(token);
            await d.settle();
          }),
        );
        assert.deepEqual(await mine(), [await storedBot()], `round ${round}`);
      }
    });

    await t.test("ONE SETTINGS SAVE AT A TIME PER ACCOUNT, ACROSS TWO WEB PROCESSES: the lock, held on the connection the save's claims run on", async () => {
      // withSettingsSaveLock's lock (withAdvisoryLock) on two web pools, as two
      // web replicas take it: the second waits, trying, holding no connection,
      // and then reads what the first stored. The save itself is the route's
      // order: read, decide the claim, write the sealed settings, settle.
      const web2 = await makePgDb(scoped("web-replica"));
      const TL = tenantN(0xe2);
      const key = settingsSaveLockKey(TL);
      const until = async (what: string, ok: () => boolean | Promise<boolean>) => {
        const deadline = Date.now() + 20_000;
        while (!(await ok())) {
          if (Date.now() > deadline) assert.fail(`never reached: ${what}`);
          await sleep(5);
        }
      };
      /** The backends holding this account's save lock, from Postgres's own view. */
      const holders = async () =>
        (
          await admin.query(
            `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
               AND classid = $1::bigint::oid AND objid = $2::bigint::oid`,
            [SETTINGS_SAVE_LOCK, key >>> 0],
          )
        ).rows.map((r) => Number(r.pid));
      const pidOf = async (db: Db) => Number(((await db.prepare("SELECT pg_backend_pid() AS pid").get()) as { pid: number }).pid);

      // The holder's statements run on the connection that holds the lock.
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const order: string[] = [];
      const first = withAdvisoryLock(web, SETTINGS_SAVE_LOCK, key, async (pinned) => {
        assert.deepEqual(await holders(), [await pidOf(pinned)], "one holder, and it is the connection handed over");
        order.push("first in");
        entered();
        await released;
        order.push("first out");
      });
      await inside;
      const second = withAdvisoryLock(web2, SETTINGS_SAVE_LOCK, key, async () => void order.push("second in"));
      try {
        await until("the other process trying the lock", () => advisoryLockWaitersForTest(web2, SETTINGS_SAVE_LOCK, key) === 1);
        assert.deepEqual(order, ["first in"]);
        await assert.rejects(
          withAdvisoryLock(orch, SETTINGS_SAVE_LOCK, key, async () => assert.fail("never runs"), 60),
          (e: unknown) => e instanceof LockBusyError,
          "a third that cannot get it in time gives up",
        );
      } finally {
        // Failing or not, the holder lets go, so a failure here fails the test instead of holding a connection for ever.
        release();
      }
      await Promise.all([first, second]);
      assert.deepEqual(order, ["first in", "first out", "second in"]);
      assert.deepEqual(await holders(), [], "let go");

      // Given back every time: more turns than the pool has connections.
      for (let i = 0; i < 25; i++) assert.equal(await withAdvisoryLock(web, SETTINGS_SAVE_LOCK, key, async (pinned) => (await pinned.prepare("SELECT 1 AS one").get() as { one: number }).one), 1);

      // A holder whose connection dies loses the lock with it, its statements
      // fail, the process lives, and the connection is not pooled again.
      await assert.rejects(
        withAdvisoryLock(web, SETTINGS_SAVE_LOCK, key, async (pinned) => {
          await admin.query("SELECT pg_terminate_backend($1)", [await pidOf(pinned)]);
          await until("the lock gone with its connection", async () => (await holders()).length === 0);
          await pinned.prepare("SELECT 1").get();
        }),
      );
      assert.equal(await withAdvisoryLock(web2, SETTINGS_SAVE_LOCK, key, async () => "free", 2_000), "free");
      assert.equal(await withAdvisoryLock(web, SETTINGS_SAVE_LOCK, key, async (pinned) => (await pidOf(pinned)) > 0), true, "the pool still serves");

      // The save that wrote back the old token (review of d7d506ce, R1),
      // across the two processes: a token save for 9401 holds the lock past
      // its claim; the other process's save of the allowlist waits, then reads
      // 9401 and writes it back with its own change.
      await releaseBotClaims(orch, TL);
      await settings.put(TL, { telegramEnabled: true, telegramBotToken: "9400:LLL-prior" } as MerrymenSettings);
      await claimBot(orch, "9400", TL, "9400", FAR_MS);
      const readBack = { read: (tn: `0x${string}`) => settings.get(tn) };
      let write!: () => void;
      const mayWrite = new Promise<void>((r) => (write = r));
      let claimed!: () => void;
      const hasClaimed = new Promise<void>((r) => (claimed = r));
      const tokenSave = withAdvisoryLock(web, SETTINGS_SAVE_LOCK, key, async (pinned) => {
        const before = await settings.get(TL);
        const next = { ...before, telegramBotToken: "9401:LLL-new" } as MerrymenSettings;
        const d = await decideBotClaim({ db: pinned, tenant: TL, token: next.telegramBotToken, moveBot: false, confirmBot: async (tok) => botIdOf(tok), settings: { before, ...readBack } });
        assert.ok(d.ok);
        claimed();
        await mayWrite;
        await settings.put(TL, next);
        await d.settle();
      });
      await hasClaimed;
      const allowlistSave = withAdvisoryLock(web2, SETTINGS_SAVE_LOCK, key, async (pinned) => {
        const before = await settings.get(TL);
        const next = { ...before, telegramAllowlist: [4242] } as MerrymenSettings;
        const d = await settleWithoutToken({ db: pinned, tenant: TL, next, settings: readBack });
        await settings.put(TL, next);
        await d.settle();
      });
      try {
        await until("the allowlist save waiting its turn", () => advisoryLockWaitersForTest(web2, SETTINGS_SAVE_LOCK, key) === 1);
      } finally {
        write();
      }
      await Promise.all([tokenSave, allowlistSave]);
      const final = await settings.get(TL);
      assert.equal(final?.telegramBotToken, "9401:LLL-new", "the new token was not written back over");
      assert.deepEqual(final?.telegramAllowlist, [4242]);
      assert.deepEqual([...(await readBotClaims(orch))].filter(([, tn]) => tn === TL), [["9401", TL]]);
    });

    await t.test("THE HOLD NOTICE: once per class across processes, a new class is news, and a restore makes the next hold news again", async () => {
      assert.equal(await notifyHoldOnce(noticeDeps(orch), T1, NEWER, true), "sent");
      assert.deepEqual(sent, [{ chatId: OWNER_CHAT, text: holdNoticeText(NEWER, true) }], "to the linked chat, read back from BIGINT");
      // New deps and the other service's pool: a redeployed orchestrator remembers nothing but the row.
      assert.equal(await notifyHoldOnce(noticeDeps(web), T1, NEWER, true), "told");
      assert.equal(sent.length, 1, "the same class is not said twice");
      assert.equal(await notifyHoldOnce(noticeDeps(web), T1, NO_BASIS, false), "sent");
      assert.equal(await notifyHoldOnce(noticeDeps(orch), T1, NEWER, true), "told");
      assert.equal(await notifyHoldOnce(noticeDeps(orch), T1, NO_BASIS, true), "told");
      assert.equal(sent.length, 2);
      assert.deepEqual(await holdNotifiedClasses(orch, T1), [NEWER, NO_BASIS]);
      assert.deepEqual(
        { ...((await orch.prepare("SELECT hold_notified FROM tenant_telegram WHERE tenant = ?").get(T1)) as object) },
        { hold_notified: JSON.stringify([NEWER, NO_BASIS]) },
      );
      await clearHoldNotified(orch, T1);
      assert.deepEqual(await holdNotifiedClasses(web, T1), []);
      assert.equal(await notifyHoldOnce(noticeDeps(orch), T1, NEWER, true), "sent", "a new hold after a restore is news");
      assert.equal(sent.length, 3);
      // The chat taken off the allowlist since it linked is not told.
      await settings.put(T1, { telegramEnabled: true, telegramBotToken: TOKEN_111, telegramAllowlist: [99] } as MerrymenSettings);
      assert.equal(await notifyHoldOnce(noticeDeps(orch), T1, "restore error", true), "no-owner");
      await settings.put(T1, { telegramEnabled: true, telegramBotToken: TOKEN_111, telegramAllowlist: [OWNER_CHAT] } as MerrymenSettings);
      assert.equal(sent.length, 3);
    });

    await t.test("THE HOLD NOTICE UNDER THE TENANT LEASE: while one replica holds it, replicas trying at once send one message", async () => {
      // Only the replica holding the tenant's lease reaches noteHold (spawnHolder,
      // retryHold). The lease is a real advisory lock here, taken as the
      // orchestrator takes it, and the send is slow enough that the others try
      // while the first is still sending. Each replica keeps the lease for its
      // whole send, as a replica that keeps the tenant does. That is the
      // promise: one sender while the lease is held. Production does not hold
      // the send under the lease (noteHold starts it and goes on), so a lease
      // that changes hands mid-send can repeat the notice: at least once, as
      // hold-notice.ts says, not exactly once.
      for (let round = 0; round < 4; round++) {
        await clearHoldNotified(orch, T1);
        sent.length = 0;
        const pools = [orch, web, await makePgDb(scoped("replica-3"))];
        const replica = async (db: Db): Promise<HoldNoticeOutcome | "no-lease"> => {
          const lease = await acquireTenantLease(T1);
          if (!lease) return "no-lease";
          try {
            return await notifyHoldOnce(noticeDeps(db, { sendMs: 60 }), T1, NEWER, true);
          } finally {
            await lease.release();
          }
        };
        const outcomes = await withDatabaseUrl("lease", () => Promise.all(pools.map(replica)));
        assert.equal(sent.length, 1, `round ${round}: ${JSON.stringify(outcomes)}`);
        assert.equal(outcomes.filter((o) => o === "sent").length, 1);
        assert.ok(outcomes.every((o) => o === "sent" || o === "told" || o === "no-lease"), JSON.stringify(outcomes));
        assert.deepEqual(await holdNotifiedClasses(orch, T1), [NEWER]);
      }
    });

    await t.test("THE WEB'S SAVE AND THE ORCHESTRATOR'S PASS AGREE ON ONE CLAIMS TABLE", async () => {
      // The real reconcile(), over the file grant store, the Postgres settings
      // store and the Postgres claims, with the worker process replaced by a
      // fake that records the token its settings.json held at spawn
      // (bot-claims.integration.test.ts does the same over sqlite). The web
      // side is the settings PUT's own claim step (botClaimForSave), over its
      // own pool, with Telegram's getMe answered by a stub.
      process.env.MERRYMEN_HOSTED = "1";
      resetGrantStoreForTest();
      useSettingsStoreForTest(settings);
      const { reconcile, childHome, setSpawnForTest, setBotClaimsDbForTest, setBotConfirmForTest } = await import("./orchestrator");
      const { getGrantStore } = await import("./grant-store");
      const orchClaims = await makePgDb(scoped("orchestrator-claims"));
      setBotClaimsDbForTest(orchClaims);
      useBotClaimsDbForTest(web);
      const confirm = async (token: string) => (/^\d+:fake/.test(token) ? null : botIdOf(token));
      setBotConfirmForTest(confirm);
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const u = String(input instanceof Request ? input.url : input);
        const m = /^https:\/\/api\.telegram\.org\/bot(\d+:[A-Za-z0-9_-]+)\/getMe$/.exec(u);
        const id = m ? await confirm(m[1]!) : null;
        return Response.json(id ? { ok: true, result: { id: Number(id), is_bot: true, username: `bot${id}` } } : { ok: false, error_code: 401 });
      }) as typeof fetch;
      const said: string[] = [];
      const realLog = console.log;
      console.log = (...a: unknown[]) => void said.push(a.map(String).join(" "));
      orchestratorSeams.reset = () => {
        globalThis.fetch = realFetch;
        console.log = realLog;
        setBotClaimsDbForTest(null);
        setBotConfirmForTest(null);
        useBotClaimsDbForTest(null);
      };
      const spawnedWith = new Map<string, string | undefined>();
      class FakeProc extends EventEmitter {
        static next = 70_000;
        readonly pid = FakeProc.next++;
        readonly stdout = null;
        readonly stderr = null;
        kill(): boolean {
          setImmediate(() => this.emit("exit", null, "SIGTERM"));
          return true;
        }
      }
      setSpawnForTest(((_cmd: string, _args: readonly string[], opts: SpawnOptions) => {
        const h = String(opts.env?.MERRYMEN_HOME);
        const file = JSON.parse(readFileSync(path.join(h, "settings.json"), "utf8")) as { telegramBotToken?: string };
        spawnedWith.set(path.basename(h), file.telegramBotToken);
        return new FakeProc() as unknown as ChildProcess;
      }) as never);
      const tokenInFile = (tn: string) =>
        (JSON.parse(readFileSync(path.join(childHome(tn), "settings.json"), "utf8")) as { telegramBotToken?: string }).telegramBotToken;
      const grant = (n: number): StoredGrant =>
        ({
          smartAccount: tenantN(0xc000 + n),
          owner: tenantN(0xb000 + n),
          sessionKeyAddress: tenantN(0xd000 + n),
          serialized: `eyJ-a-zerodev-blob-tgfix-${n}`,
          chainId: 4663,
          grantedAt: Math.floor(Date.now() / 1000) - 3600,
          expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
          caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
          grantFeatures: ["tradeable-v2"],
          grantTokens: [],
          demoSessionPrivateKey: ("0x" + "cd".repeat(32)) as `0x${string}`,
        }) as unknown as StoredGrant;
      const withBot = (token: string, linked = true): MerrymenSettings =>
        ({ telegramEnabled: true, telegramBotToken: token, ...(linked ? { telegramAllowlist: [4242] } : {}) }) as MerrymenSettings;
      /** The settings PUT for a token, in its order: the claim, then the write, then letting go of any bot left behind. */
      const webSave = async (tenant: `0x${string}`, next: MerrymenSettings, moveBot = false) => {
        const claim = await botClaimForSave({ tenant, touched: true, next, moveBot, settings: pgSettings(await settings.get(tenant)) });
        if (claim && !claim.ok) return claim;
        await settings.put(tenant, next);
        await claim?.settle();
        return claim;
      };

      const RA = tenantN(0xa1), RB = tenantN(0xb1), RC = tenantN(0xc1), RD = tenantN(0xd1), RS = tenantN(0x01), RO = tenantN(0x02);
      // A saves its bot on the web: claimed there, first.
      const a = await webSave(RA, withBot("111:AAA-first-secret"));
      assert.ok(a?.ok && !a.moved);
      // B, a second login with the same bot, is refused on the web...
      const b = await webSave(RB, withBot("111:BBB-reissued-secret"));
      assert.ok(b && !b.ok && b.status === 409 && b.body.error === "bot_claimed", JSON.stringify(b));
      // ...but holds the token from before claims existed, as the incident's second login did.
      await settings.put(RB, withBot("111:BBB-reissued-secret"));
      // C's bot was saved before claims existed and nobody has claimed it; D has no bot yet.
      await settings.put(RC, withBot("222:CCC-secret"));
      await settings.put(RD, { telegramEnabled: false } as MerrymenSettings);
      // A stranger's `<id>:guess` for O's bot, whose own Telegram is off at first.
      await settings.put(RS, withBot("444:fake-guessed-secret"));
      await settings.put(RO, { telegramEnabled: false, telegramBotToken: "444:the-real-secret" } as MerrymenSettings);
      for (const [i, tn] of [RA, RB, RC, RD, RS, RO].entries()) await getGrantStore().put(tn, grant(i));

      await reconcile();
      let claims = await readBotClaims(web);
      assert.equal(claims.get("111"), RA, "the web's claim holds for the orchestrator");
      assert.equal(spawnedWith.get(RA), "111:AAA-first-secret", "its holder starts with the bot");
      assert.ok(spawnedWith.has(RB) && spawnedWith.get(RB) === undefined, "the other login trades, never with the bot");
      assert.equal(tokenInFile(RB), undefined);
      assert.equal(claims.get("222"), RC, "the orchestrator's backfill claimed C's unclaimed bot, in the table the web reads");
      assert.equal(spawnedWith.get(RC), "222:CCC-secret");
      assert.equal(claims.get("444"), undefined, "a token Telegram refuses claims nothing");
      // The pass's own verdicts, from the claims as the orchestrator reads them.
      const orchRead = await readBotClaims(orchClaims);
      assert.equal(claimGate(withBot("111:AAA-first-secret"), RA, orchRead).verdict.kind, "keep");
      assert.deepEqual(claimGate(withBot("111:BBB-reissued-secret"), RB, orchRead).verdict, { kind: "strip", bot: "111", by: "claim" });

      // D saves C's bot on the web: taken, and the web says so; "move it here" moves it.
      const d = await webSave(RD, withBot("222:DDD-secret"));
      assert.ok(d && !d.ok && d.status === 409 && d.body.error === "bot_claimed", "the orchestrator's claim holds for the web");
      const dMoved = await webSave(RD, withBot("222:DDD-secret"), true);
      assert.ok(dMoved?.ok && dMoved.moved);
      // B moves the owner's bot back to itself, the incident's way out.
      const bMoved = await webSave(RB, withBot("111:BBB-reissued-secret"), true);
      assert.ok(bMoved?.ok && bMoved.moved);
      // O switches its Telegram on: its confirmed claim decides, not the stranger's guess.
      assert.ok((await webSave(RO, withBot("444:the-real-secret")))?.ok);

      await reconcile();
      claims = await readBotClaims(orchClaims);
      assert.deepEqual([claims.get("111"), claims.get("222"), claims.get("444")], [RB, RD, RO]);
      assert.deepEqual(
        [tokenInFile(RB), tokenInFile(RA), tokenInFile(RD), tokenInFile(RC), tokenInFile(RO), tokenInFile(RS)],
        ["111:BBB-reissued-secret", undefined, "222:DDD-secret", undefined, "444:the-real-secret", undefined],
        "each bot is handed to the account its claim names, and taken from the one it left",
      );
      // And the dashboard of the account the bot left says where it went, naming nobody.
      const left = telegramListening(await readTelegramRuntime(web, RA, "111"), "111:AAA-first-secret", FAR);
      assert.deepEqual([left.botElsewhere, left.linkCode, left.linkPending], [true, null, false]);
      assert.ok(!JSON.stringify(left).includes(RB.slice(2)));
      assert.equal((await readTelegramRuntime(web, RB, "111"))?.botElsewhere ?? false, false);
      assert.ok(!said.some((l) => /AAA-first|BBB-reissued|CCC-secret|DDD-secret|the-real-secret|fake-guessed/.test(l)), "no token in the orchestrator's log");
    });
  } finally {
    orchestratorSeams.reset?.();
    resetSettingsStoreForTest();
    resetGrantStoreForTest();
    // Only this run's own schema, whose name was checked before it was made.
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    for (const c of clients) await c.end().catch(() => {});
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    for (const [k, v] of [
      ["DATABASE_URL", saved.db],
      ["MERRYMEN_STORE_DEK", saved.dek],
      ["MERRYMEN_HOME", saved.home],
      ["MERRYMEN_HOSTED", saved.hosted],
      ["MERRYMEN_TELEGRAM_ENABLED", saved.tgEnabled],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
