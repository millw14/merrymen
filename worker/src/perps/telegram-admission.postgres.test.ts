/** Real production driver and account locks, against disposable LOCAL PostgreSQL only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { StoredGrant } from "../../../packages/core/src/index";
import { makePgDb, type Db } from "../db";
import { recordFleetRecoveryHold } from "../fleet-recovery";
import { orderTtlMs } from "../order-window";
import { queuePerpsBotExit, readPerpsBotView } from "./telegram-admission";
import type { PerpsBotRequest } from "./telegram-bridge";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
const ACCOUNT = `0x${"ab".repeat(20)}` as const, OWNER = `0x${"cd".repeat(20)}` as const, OTHER = `0x${"ef".repeat(20)}` as const;
const NOW = 1_800_000_000_000;
const grant = {
  purpose: "perps", owner: OWNER, smartAccount: ACCOUNT, chainId: 4663,
  expiresAt: NOW / 1000 + 1000, grantedAt: NOW / 1000 - 100,
  sessionKeyAddress: OTHER, serialized: "test-paper-permission", demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
  caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 },
} satisfies StoredGrant;
const request = (extra: Partial<PerpsBotRequest> = {}): PerpsBotRequest => ({
  kind: "flatten", expectedAccount: ACCOUNT, requestId: "tg-perps-123-9", askedAtSec: NOW / 1000, ...extra,
});
const options = (db: Db, extra: Partial<Parameters<typeof queuePerpsBotExit>[0]> = {}) => ({
  db, tenant: OWNER, grant, request: request(), tickSeconds: 60, nowMs: NOW, mayWrite: () => true, ...extra,
});
interface Client {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<unknown>;
}

test("Postgres: Telegram paper exits preserve owner scope, durable identity and one pending slot", { skip: !url, timeout: 60_000 }, async t => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only disposable LOCAL PostgreSQL is allowed");
  const pg = createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => Client };
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  const schema = `mm_perps_admission_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = (name: string) => {
    const value = new URL(target);
    value.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=3000`);
    value.searchParams.set("application_name", name);
    return value.toString();
  };
  const a = await makePgDb(scoped("perps-admission-a"));
  const b = await makePgDb(scoped("perps-admission-b"));
  const rows = () => a.prepare("SELECT * FROM agent_commands ORDER BY id").all() as Promise<Array<Record<string, unknown>>>;
  const reset = async () => {
    await a.exec("DELETE FROM agent_commands; DELETE FROM agents");
    await a.prepare("INSERT INTO agents(smart_account,owner_address,chain_id,mode) VALUES(?,?,4663,'paper')").run(ACCOUNT, OWNER);
    await a.prepare("INSERT INTO agents(smart_account,owner_address,chain_id,mode) VALUES(?,?,4663,'paper')").run(OTHER, OWNER);
  };
  try {
    // These are the production columns consumed by this boundary. In particular,
    // millisecond clocks are BIGINT, and no optional recovery table exists yet.
    await a.exec(`CREATE TABLE agents(smart_account TEXT PRIMARY KEY,owner_address TEXT NOT NULL,chain_id INTEGER NOT NULL,mode TEXT,perps TEXT);
      CREATE TABLE agent_commands(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,kind TEXT NOT NULL,args TEXT,
        created_at BIGINT NOT NULL,claimed_at BIGINT,done_at BIGINT,result TEXT);`);
    await t.test("snapshot binds the report to its owner, chain and account without exposing a foreign row", async () => {
      await reset();
      assert.deepEqual(await readPerpsBotView(a, grant), { state: "ready", account: ACCOUNT, grantExpiresAt: grant.expiresAt, report: null });
      assert.deepEqual(await readPerpsBotView(a, { ...grant, owner: OTHER }), { state: "unread" });
      assert.deepEqual(await readPerpsBotView(a, { ...grant, chainId: 1 }), { state: "unread" });
      await a.prepare("UPDATE agents SET perps=? WHERE smart_account=?").run("not JSON", OTHER);
      assert.equal((await readPerpsBotView(a, grant)).state, "ready", "a foreign account's bad report does not replace this snapshot");
      await a.prepare("UPDATE agents SET perps=? WHERE smart_account=?").run("not JSON", ACCOUNT);
      assert.deepEqual(await readPerpsBotView(a, grant), { state: "unread" });
      assert.deepEqual(await rows(), []);
    });
    await t.test("an actual reduce-only INSERT is consumed across a changed action and replacement account", async () => {
      await reset();
      assert.match(await queuePerpsBotExit(options(a)), /^Your paper Perps exit was queued/);
      const [row] = await rows();
      assert.ok(row);
      assert.equal(row.agent_id, ACCOUNT);
      assert.equal(row.kind, "trade");
      assert.equal(row.created_at, NOW, "the production driver preserves the millisecond BIGINT clock");
      assert.deepEqual(JSON.parse(String(row.args)), { purpose: "flatten-perps", side: "sell", symbol: "ALL-PERPS", usdgAmount: 0, book: "paper", expiresAt: NOW + orderTtlMs(60) });
      await a.prepare("UPDATE agent_commands SET claimed_at=?,done_at=?,result='done' WHERE id=?").run(NOW, NOW + 1, row.id);
      const consumed = await rows();
      assert.match(await queuePerpsBotExit(options(b, { request: request({ kind: "close", market: "BTC-PERP" }) })), /already recorded/);
      assert.match(await queuePerpsBotExit(options(b, { grant: { ...grant, smartAccount: OTHER }, request: request({ expectedAccount: OTHER }) })), /could not be identified safely/);
      assert.deepEqual(await rows(), consumed, "a repeated update cannot create, move or reset its durable command");
    });
    await t.test("separate PostgreSQL pools serialize competing requests and preserve other accounts", async () => {
      await reset();
      await a.prepare("INSERT INTO agent_commands(id,agent_id,kind,args,created_at) VALUES('foreign',?,'trade','{}',?)").run(OTHER, NOW);
      const result = await Promise.all([
        queuePerpsBotExit(options(a)),
        queuePerpsBotExit(options(b, { request: request({ requestId: "tg-perps-123-10" }) })),
      ]);
      assert.equal(result.filter(value => /^Your paper Perps exit was queued/.test(value)).length, 1, result.join("\n"));
      assert.equal(result.filter(value => /still pending/.test(value)).length, 1, result.join("\n"));
      const pending = await rows();
      assert.equal(pending.filter(row => row.agent_id === ACCOUNT).length, 1);
      assert.deepEqual(pending.find(row => row.id === "foreign"), {
        id: "foreign", agent_id: OTHER, kind: "trade", args: "{}", created_at: NOW, claimed_at: null, done_at: null, result: null,
      });
    });
    await t.test("unreported, live, foreign and recovery-held books refuse without a queue write", async () => {
      await reset();
      for (const mode of [null, "live", "unread"]) {
        await a.prepare("UPDATE agents SET mode=? WHERE smart_account=?").run(mode, ACCOUNT);
        assert.match(await queuePerpsBotExit(options(a)), /has not reported safely/);
      }
      await a.prepare("UPDATE agents SET mode='paper',owner_address=? WHERE smart_account=?").run(OTHER, ACCOUNT);
      assert.match(await queuePerpsBotExit(options(a)), /has not reported safely/);
      await a.prepare("DELETE FROM agents WHERE smart_account=?").run(ACCOUNT);
      assert.match(await queuePerpsBotExit(options(a)), /has not reported safely/);
      await reset();
      await a.exec("CREATE TABLE paper_recovery_health(agent_id TEXT PRIMARY KEY,blocked INTEGER)");
      await a.prepare("INSERT INTO paper_recovery_health VALUES(?,1)").run(ACCOUNT);
      assert.match(await queuePerpsBotExit(options(a)), /practice book is held/);
      await a.prepare("UPDATE paper_recovery_health SET blocked=NULL WHERE agent_id=?").run(ACCOUNT);
      assert.match(await queuePerpsBotExit(options(a)), /could not be reached/);
      await a.prepare("DELETE FROM paper_recovery_health WHERE agent_id=?").run(ACCOUNT);
      await recordFleetRecoveryHold(b, { tenant: OWNER, smartAccount: ACCOUNT, chainId: 4663 }, "source-continuity", NOW / 1000 - 2, () => true);
      assert.match(await queuePerpsBotExit(options(a)), /held for recovery/);
      assert.deepEqual(await rows(), []);
    });
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
