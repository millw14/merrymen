import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { StoredGrant } from "../../../packages/core/src/index";
import { wrapSqlite, type Db, type Stmt } from "../db";
import { FLEET_RECOVERY_SCHEMA, recordFleetRecoveryHold, recordFleetSourceVerified } from "../fleet-recovery";
import { ORDER_STALE_GRACE_MS, ORDER_IN_FLIGHT_MS, orderTtlMs } from "../order-window";
import { queuePerpsBotExit, readPerpsBotView } from "./telegram-admission";
import { drainPerpsBotRequests, writePerpsBotRequest, type PerpsBotRequest } from "./telegram-bridge";
const ACCOUNT = "0x1111111111111111111111111111111111111111", OWNER = "0x2222222222222222222222222222222222222222", OTHER = "0x3333333333333333333333333333333333333333";
const NOW = 1_800_000_000_000;
const grant = { purpose: "perps", owner: OWNER, smartAccount: ACCOUNT, chainId: 4663, expiresAt: NOW / 1000 + 1000, grantedAt: NOW / 1000 - 100, sessionKeyAddress: OTHER, serialized: "test-paper-permission", demoSessionPrivateKey: `0x${"ab".repeat(32)}`, caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 } } satisfies StoredGrant;
const request = (extra: Partial<PerpsBotRequest> = {}): PerpsBotRequest => ({ kind: "flatten", expectedAccount: ACCOUNT, requestId: "tg-perps-123-9", askedAtSec: NOW / 1000, ...extra });
const schema = `CREATE TABLE agents(smart_account TEXT PRIMARY KEY,owner_address TEXT,chain_id INTEGER,mode TEXT,perps TEXT);
CREATE TABLE agent_commands(id TEXT PRIMARY KEY,agent_id TEXT,kind TEXT,args TEXT,created_at INTEGER,claimed_at INTEGER,done_at INTEGER,result TEXT);`;
function setup(t: { after(fn: () => void): void }, file = ":memory:") {
  const raw = new DatabaseSync(file); raw.exec(schema); raw.prepare("INSERT INTO agents VALUES(?,?,?,'paper',NULL)").run(ACCOUNT, OWNER, 4663);
  t.after(() => raw.close()); return { raw, db: wrapSqlite(raw) };
}
const options = (db: Db, extra: Partial<Parameters<typeof queuePerpsBotExit>[0]> = {}) => ({ db, tenant: OWNER, grant, request: request(), tickSeconds: 60, nowMs: NOW, mayWrite: () => true, ...extra });
const count = (raw: DatabaseSync) => (raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n;

test("real SQLite admission writes one paper reduce-only command and durable duplicates do not recreate it", async t => {
  const { raw, db } = setup(t);
  assert.match(await queuePerpsBotExit(options(db)), /^Your paper Perps exit was queued/);
  const row = raw.prepare("SELECT * FROM agent_commands").get()!;
  assert.equal(row.agent_id, ACCOUNT); assert.equal(row.kind, "trade"); assert.equal(row.created_at, NOW);
  assert.deepEqual(JSON.parse(String(row.args)), { purpose: "flatten-perps", side: "sell", symbol: "ALL-PERPS", usdgAmount: 0, book: "paper", expiresAt: NOW + orderTtlMs(60) });
  raw.prepare("UPDATE agent_commands SET claimed_at=?,done_at=?,result='done'").run(NOW, NOW + 1);
  assert.match(await queuePerpsBotExit(options(db)), /already recorded/); assert.equal(count(raw), 1);
});

test("close validates owner, grant account, ledger identity, expiry and paper shape before admission", async t => {
  const { raw, db } = setup(t);
  for (const extra of [
    { tenant: OTHER }, { request: request({ expectedAccount: OTHER }) },
    { grant: { ...grant, purpose: "spot" } as StoredGrant }, { grant: { ...grant, expiresAt: NOW / 1000 } },
    { request: request({ kind: "close", market: "BTC-PERP<script>" as "BTC-PERP" }) },
    { request: { ...request(), home: "/foreign" } as PerpsBotRequest },
    { request: request({ askedAtSec: NOW / 1000 + 30 }) }, { tickSeconds: Number.POSITIVE_INFINITY },
  ]) { assert.doesNotMatch(await queuePerpsBotExit(options(db, extra)), /^Your paper Perps exit was queued/); assert.equal(count(raw), 0); }
  raw.prepare("UPDATE agents SET owner_address=?").run(OTHER);
  assert.doesNotMatch(await queuePerpsBotExit(options(db)), /^Your paper Perps exit was queued/); assert.equal(count(raw), 0);
  raw.prepare("UPDATE agents SET owner_address=?,chain_id=1").run(OWNER);
  assert.doesNotMatch(await queuePerpsBotExit(options(db)), /^Your paper Perps exit was queued/); assert.equal(count(raw), 0);
  raw.prepare("UPDATE agents SET chain_id=4663,mode='live'").run();
  assert.doesNotMatch(await queuePerpsBotExit(options(db)), /^Your paper Perps exit was queued/); assert.equal(count(raw), 0);
});

test("the original request clock sets TTL, and delayed requests cannot be restamped as new", async t => {
  const { raw, db } = setup(t), askedAtSec = NOW / 1000 - 60;
  assert.match(await queuePerpsBotExit(options(db, { request: request({ kind: "close", market: "BTC-PERP", askedAtSec }), tickSeconds: 300 })), /^Your paper Perps exit was queued/);
  const row = raw.prepare("SELECT args,created_at FROM agent_commands").get()!;
  assert.equal(row.created_at, askedAtSec * 1000); assert.equal(JSON.parse(String(row.args)).expiresAt, askedAtSec * 1000 + orderTtlMs(300));
  raw.exec("DELETE FROM agent_commands");
  assert.doesNotMatch(await queuePerpsBotExit(options(db, { request: request({ askedAtSec: NOW / 1000 - 1000 }) })), /^Your paper Perps exit was queued/); assert.equal(count(raw), 0);
});

test("one account's pending slot is shared with HTTP and concurrent Telegram admissions", async t => {
  const { raw, db } = setup(t);
  const results = await Promise.all([queuePerpsBotExit(options(db)), queuePerpsBotExit(options(db, { request: request({ requestId: "tg-perps-123-10" }) }))]);
  assert.equal(results.filter(line => /^Your paper Perps exit was queued/.test(line)).length, 1); assert.equal(results.filter(line => /still pending/.test(line)).length, 1); assert.equal(count(raw), 1);
  raw.exec("DELETE FROM agent_commands");
  raw.prepare("INSERT INTO agent_commands(id,agent_id,kind,args,created_at) VALUES('other',?,'trade','{}',?)").run(OTHER, NOW);
  assert.match(await queuePerpsBotExit(options(db)), /^Your paper Perps exit was queued/); assert.equal(count(raw), 2, "another account's book does not block this owner");
});

test("pending orders retain the same grace and in-flight bounds as HTTP, including legacy no-expiry", async t => {
  const { raw, db } = setup(t);
  for (const [args, claimed, at, held] of [
    [{}, null, NOW - 86_400_000, true],
    [{ expiresAt: NOW - ORDER_STALE_GRACE_MS }, null, NOW - 600_000, true],
    [{ expiresAt: NOW - ORDER_STALE_GRACE_MS - 1 }, null, NOW - 600_000, false],
    [{ expiresAt: NOW - ORDER_STALE_GRACE_MS - ORDER_IN_FLIGHT_MS }, NOW - 1000, NOW - 900_000, true],
    [{ expiresAt: NOW - ORDER_STALE_GRACE_MS - ORDER_IN_FLIGHT_MS - 1 }, NOW - 1000, NOW - 900_000, false],
  ] as const) {
    raw.exec("DELETE FROM agent_commands"); raw.prepare("INSERT INTO agent_commands(id,agent_id,kind,args,created_at,claimed_at) VALUES('old',?,'trade',?,?,?)").run(ACCOUNT, JSON.stringify(args), at, claimed);
    const line = await queuePerpsBotExit(options(db)); assert.equal(/^Your paper Perps exit was queued/.test(line), !held, line); assert.equal(count(raw), held ? 1 : 2);
  }
});

test("fleet recovery, recovered boundary, held paper and malformed health all refuse writes", async t => {
  const { raw, db } = setup(t), scope = { tenant: OWNER, smartAccount: ACCOUNT, chainId: 4663 };
  raw.exec(FLEET_RECOVERY_SCHEMA);
  await recordFleetRecoveryHold(db, scope, "source-continuity", NOW / 1000 - 2, () => true);
  assert.match(await queuePerpsBotExit(options(db)), /held for recovery/); assert.equal(count(raw), 0);
  await recordFleetSourceVerified(db, scope, NOW / 1000, () => true);
  assert.match(await queuePerpsBotExit(options(db)), /held for recovery/); assert.equal(count(raw), 0, "pre-recovery commands never cross the boundary");
  raw.exec("DELETE FROM fleet_recovery_health; CREATE TABLE paper_recovery_health(agent_id TEXT,blocked INTEGER)");
  raw.prepare("INSERT INTO paper_recovery_health VALUES(?,1)").run(ACCOUNT);
  assert.match(await queuePerpsBotExit(options(db)), /practice book is held/); assert.equal(count(raw), 0);
  raw.exec("UPDATE paper_recovery_health SET blocked=NULL");
  assert.doesNotMatch(await queuePerpsBotExit(options(db)), /^Your paper Perps exit was queued/); assert.equal(count(raw), 0, "malformed health is unknown, never healthy");
});

/** Instrument the real transaction handle so authority is lost after SQLite accepts the INSERT. */
function loseAfterInsert(db: Db, lost: () => void): Db {
  return { exec: sql => db.exec(sql), prepare: sql => {
    const statement = db.prepare(sql);
    return { ...statement, run: async (...args: unknown[]) => { const result = await statement.run(...args); if (/INSERT INTO agent_commands/.test(sql)) lost(); return result; } } as Stmt;
  }, tx: fn => db.tx(tx => fn(loseAfterInsert(tx, lost))) };
}
test("lost writer before admission or after INSERT rolls the real SQLite transaction back", async t => {
  const { raw, db } = setup(t);
  assert.doesNotMatch(await queuePerpsBotExit(options(db, { mayWrite: () => false })), /^Your paper Perps exit was queued/); assert.equal(count(raw), 0);
  let owned = true;
  assert.doesNotMatch(await queuePerpsBotExit(options(loseAfterInsert(db, () => { owned = false; }), { mayWrite: () => owned })), /^Your paper Perps exit was queued/);
  assert.equal(count(raw), 0, "fencing loss before COMMIT must roll back insertion");
});

test("read view cannot expose a foreign ledger row or a malformed/live report", async t => {
  const { raw, db } = setup(t);
  assert.deepEqual(await readPerpsBotView(db, null), { state: "absent" });
  assert.equal((await readPerpsBotView(db, grant)).state, "ready");
  raw.prepare("UPDATE agents SET owner_address=?").run(OTHER); assert.equal((await readPerpsBotView(db, grant)).state, "unread");
  raw.prepare("UPDATE agents SET owner_address=?,perps='not JSON'").run(OWNER); assert.equal((await readPerpsBotView(db, grant)).state, "unread");
  assert.equal((await readPerpsBotView(db, { ...grant, purpose: "bad" } as unknown as StoredGrant)).state, "unread");
});

test("crash after database commit but before file receipt survives reopening without replay", async t => {
  const home = mkdtempSync(path.join(tmpdir(), "mm-bot-crash-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "ledger.db"), now = Date.now(), r = request({ askedAtSec: Math.floor(now / 1000) });
  const current = { ...grant, expiresAt: Math.floor(now / 1000) + 1000 };
  let raw = new DatabaseSync(file); raw.exec(schema); raw.prepare("INSERT INTO agents VALUES(?,?,?,'paper',NULL)").run(ACCOUNT, OWNER, 4663);
  writePerpsBotRequest(home, r);
  await assert.rejects(drainPerpsBotRequests(home, () => true, async request => {
    assert.match(await queuePerpsBotExit(options(wrapSqlite(raw), { grant: current, request, nowMs: now })), /^Your paper Perps exit was queued/);
    throw Error("process died before file receipt");
  }), /process died/);
  raw.close(); raw = new DatabaseSync(file);
  try {
    await drainPerpsBotRequests(home, () => true, async request => {
      const line = await queuePerpsBotExit(options(wrapSqlite(raw), { grant: current, request, nowMs: now })); assert.match(line, /already recorded/); return line;
    });
    assert.equal(count(raw), 1);
  } finally { raw.close(); }
});

test("same Telegram update remains consumed across changed action or wallet account", async t => {
  const { raw, db } = setup(t);
  assert.match(await queuePerpsBotExit(options(db)), /^Your paper Perps exit was queued/);
  raw.exec("UPDATE agent_commands SET done_at=1");
  assert.match(await queuePerpsBotExit(options(db, { request: request({ kind: "close", market: "BTC-PERP" }) })), /already recorded/);
  raw.prepare("INSERT INTO agents VALUES(?,?,?,'paper',NULL)").run(OTHER, OWNER, 4663);
  assert.doesNotMatch(await queuePerpsBotExit(options(db, { grant: { ...grant, smartAccount: OTHER }, request: request({ expectedAccount: OTHER }) })), /^Your paper Perps exit was queued/);
  assert.equal(count(raw), 1);
});

test("oversized historical pending sets are refused with a bounded database read", async t => {
  const { raw, db } = setup(t);
  const insert = raw.prepare("INSERT INTO agent_commands(id,agent_id,kind,args,created_at) VALUES(?,?,'trade',?,?)");
  for (let i = 0; i < 129; i++) insert.run(String(i), ACCOUNT, JSON.stringify({ expiresAt: NOW - ORDER_STALE_GRACE_MS - 1 }), NOW - 600_000);
  assert.match(await queuePerpsBotExit(options(db)), /could not be read safely/); assert.equal(count(raw), 129);
});
