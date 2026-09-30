import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, spawn } from "node:child_process";
import { wrapSqlite, type Db } from "../db";
import { applyLedgerSchema, JOURNAL_GENESIS, journalHash } from "../store";
import { HostedLiveCheckpointStore, HostedStanddownStore, HOSTED_STANDDOWN_TTL_MS, revokeHostedGrant, openCheckpoint, type HostedStanddownJob, type HostedLiveCheckpoint } from "./hosted-standdown-store";
import { sealPerpKey } from "./key-seal";
import { captureStanddownLedger, encodeStanddownLedger, restoreStanddownLedger, STANDDOWN_TABLES, validateStanddownLedger } from "./hosted-standdown-ledger";
import { durableStanddownSendFence, durableStanddownStore } from "./hosted-standdown-runner";
import { hostedStanddownAvailable, HostedStanddownSupervisor, standdownChildEnv } from "./hosted-standdown";
import { HostedLiveCheckpointBridge } from "./hosted-live-supervisor";
import { inspectFinancialStream, type FinancialChunks } from "./hosted-financial-stream";
import { MIRROR_STATE_DDL, mirrorTenant } from "../ledger-mirror";
import { hostedStanddownConfirmation } from "./hosted-standdown-status";

const TENANT = "0x00000000000000000000000000000000000000aa" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000a1" as const;
const OTHER = "0x00000000000000000000000000000000000000bb" as const;
const DEK = Buffer.alloc(32, 7), PRIV = `0x${"ab".repeat(40)}`;
const PUB = `0x${("01" + "00".repeat(7)).repeat(5)}` as `0x${string}`;
const emptyLedger = () => encodeStanddownLedger({ v: 1, account: ACCOUNT, agent: null, journal: [], tables: Object.fromEntries(STANDDOWN_TABLES.map(t => [t, []])) });
function grant(tenant: string = TENANT) {
 return { smartAccount: ACCOUNT, expiresAt: 100, chainId: 4663, demoSessionPrivateKey: "session-never-retained",
  grantFeatures: ["perp-lighter-v1"], perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: PUB,
   apiKeySealed: sealPerpKey(PRIV, { tenant, smartAccount: ACCOUNT, apiPublicKey: PUB, apiKeyIndex: 16 }, DEK) } };
}
async function setup() {
 const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
 await db.exec("CREATE TABLE grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
 const store = new HostedStanddownStore(db, DEK); await store.init();
 await db.prepare("INSERT INTO grants VALUES (?, ?, ?)").run(TENANT, JSON.stringify(grant()), 50);
 return { raw, db, store };
}
describe("hosted shutdown atomic custody and replay", () => {
 it("revokes the exact grant and retains only a sealed venue key for 15 minutes", async () => {
  const { raw, db, store } = await setup(); try {
   assert.equal(await revokeHostedGrant(db, TENANT, DEK, { nowMs: 100_000 }), "removed");
   assert.equal(await db.prepare("SELECT * FROM grants").get(), undefined);
   const job = (await store.latest(TENANT))!;
   assert.equal(job.expiresAtMs - job.createdAtMs, HOSTED_STANDDOWN_TTL_MS);
   assert.equal(job.smartAccount, ACCOUNT); assert.equal(job.apiKeyIndex, 16);
   assert.ok(!JSON.stringify(job).includes(PRIV)); assert.ok(!JSON.stringify(job).includes("session-never-retained"));
   assert.equal(await revokeHostedGrant(db, TENANT, DEK, { nowMs: 200_000 }), "absent");
   assert.equal((await store.list()).length, 1); assert.equal((await store.latest(TENANT))!.expiresAtMs, job.expiresAtMs);
  } finally { raw.close(); }
 });
 it("a newer grant survives delayed kill; expiry checks the row deleted, not an earlier read", async () => {
  const { raw, db, store } = await setup(); try {
   assert.equal(await revokeHostedGrant(db, TENANT, DEK, { beforeSec: 49 }), "newer");
   assert.equal(await revokeHostedGrant(db, TENANT, DEK, { nowMs: 99_999, reason: "expiry", expiredOnly: true }), "newer");
   assert.equal((await store.list()).length, 0);
   assert.equal(await revokeHostedGrant(db, TENANT, DEK, { nowMs: 100_000, reason: "expiry", expiredOnly: true }), "removed");
   assert.equal((await store.latest(TENANT))!.reason, "expiry");
  } finally { raw.close(); }
 });
 it("an insert failure or cross-tenant sealed key rolls grant deletion back", async () => {
  const { raw, db, store } = await setup(); try {
   await db.exec("CREATE TRIGGER refuse_job BEFORE INSERT ON perp_standdown BEGIN SELECT RAISE(ABORT, 'test interruption'); END");
   await assert.rejects(revokeHostedGrant(db, TENANT, DEK));
   assert.ok(await db.prepare("SELECT * FROM grants").get());
   await db.exec("DROP TRIGGER refuse_job");
   await db.prepare("UPDATE grants SET grant_json = ?").run(JSON.stringify(grant(OTHER)));
   await assert.rejects(revokeHostedGrant(db, TENANT, DEK));
   assert.ok(await db.prepare("SELECT * FROM grants").get()); assert.equal((await store.list()).length, 0);
  } finally { raw.close(); }
 });
 it("reclaim fences the old writer and preserves exact signed bytes across generations", async () => {
  const { raw, db, store } = await setup(); try {
   await revokeHostedGrant(db, TENANT, DEK, { nowMs: 100_000 });
   const first = (await store.claim((await store.latest(TENANT))!.id, "replica-a", 100_001))!;
   const book = validateStanddownLedger(emptyLedger(), ACCOUNT); book.tables.perp_orders!.push({ id: "x", agent_id: ACCOUNT, mode: "live", tx_info: "exact signed bytes", nonce: 456 });
   const bytes = encodeStanddownLedger(book);
   await store.checkpoint(first, bytes, 100_002);
   const next = (await store.claim(first.id, "replica-b", 100_003))!;
   assert.equal((await readBook(store.loadStream(next))).tables.perp_orders![0]!.tx_info, "exact signed bytes");
   assert.equal(await store.fence(first, 100_004), false); assert.equal(await store.fence(next, 100_004), true);
   await assert.rejects(store.checkpoint(first, Buffer.from("stale"), 100_004));
   assert.throws(() => openCheckpoint({ ...next, tenant: OTHER }, next.checkpoint!, DEK));
   assert.throws(() => openCheckpoint({ ...next, id: "another-job" }, next.checkpoint!, DEK));
  } finally { raw.close(); }
 });
 it("TTL destroys key authority even when the process died; accounting remains blocked until mirrored", async () => {
  const { raw, db, store } = await setup(); try {
   await revokeHostedGrant(db, TENANT, DEK, { nowMs: 100_000 });
   const job = (await store.claim((await store.latest(TENANT))!.id, "a", 100_001))!;
   await store.checkpoint(job, emptyLedger(), 100_002);
   assert.equal(await store.fence(job, job.expiresAtMs), false);
   await store.expire(job.expiresAtMs);
   const expired = (await store.latest(TENANT))!;
   assert.equal(expired.state, "expired"); assert.equal(expired.sealedKey, null);
   assert.equal(JSON.parse(expired.resultJson!).outcome, "unreachable");
   assert.equal(await store.claim(job.id, "b", job.expiresAtMs), null);
   assert.equal(await store.blocked(TENANT, ACCOUNT), true);
   await store.mirrored(expired); assert.equal(await store.blocked(TENANT, ACCOUNT), false);
   assert.equal((await store.latest(TENANT))!.checkpoint, null);
  } finally { raw.close(); }
 });
 it("completion destroys the API key immediately but retains the durable book for mirror retry", async () => {
  const { raw, db, store } = await setup(); try {
   await revokeHostedGrant(db, TENANT, DEK, { nowMs: 100_000 });
   const job = (await store.claim((await store.latest(TENANT))!.id, "a", 100_001))!;
   const book = validateStanddownLedger(emptyLedger(), ACCOUNT);
   book.tables.perp_orders!.push({ id: "x", agent_id: ACCOUNT, mode: "live", tx_hash: "evidence", nonce: 17, tx_info: "signed-replay-authority" });
   await store.checkpoint(job, encodeStanddownLedger(book), 100_002);
   assert.equal(await store.finish(job, '{"outcome":"residual"}'), true);
   const done = (await store.latest(TENANT))!; assert.equal(done.sealedKey, null); assert.ok(done.checkpoint);
   const retired = (await readBook(store.loadStream(done))).tables.perp_orders![0]!;
   assert.equal(retired.tx_info, null); assert.equal(retired.tx_hash, "evidence"); assert.equal(retired.nonce, 17);
   assert.equal(await store.fence(job, 100_003), false);
   assert.equal(await store.finish(job, '{"outcome":"done"}'), false);
  } finally { raw.close(); }
 });
 it("TTL retires authenticated encrypted pages even when their payload manifest is corrupt", async () => {
  const { raw, db, store } = await setup(); try {
   await revokeHostedGrant(db, TENANT, DEK, { nowMs: 100_000 });
   const job = (await store.claim((await store.latest(TENANT))!.id, "a", 100_001))!;
   await store.checkpoint(job, emptyLedger(), 100_002);
   await db.prepare("UPDATE perp_checkpoint_manifests SET manifest = 'corrupt'").run();
   await store.expire(job.expiresAtMs);
   const expired = (await store.latest(TENANT))!;
   assert.equal(expired.sealedKey, null); assert.equal(expired.checkpoint, null);
   assert.equal(JSON.parse(expired.resultJson!).outcome, "unreachable");
   assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM perp_checkpoint_pages").get() as { n: number }).n, 0);
  } finally { raw.close(); }
 });
 it("reserves at most three recorded close hashes per market for the entire job, including after crash/reclaim", async () => {
  const { raw, db, store } = await setup(); try {
   await revokeHostedGrant(db, TENANT, DEK, { nowMs: 100_000 });
   const first = (await store.claim((await store.latest(TENANT))!.id, "first", 100_001))!;
   const book = validateStanddownLedger(emptyLedger(), ACCOUNT);
   for (let i = 1; i <= 5; i++) book.tables.perp_orders!.push({ id: `close-${i}`, agent_id: ACCOUNT, mode: "live", market_id: i === 5 ? 2 : 1, tx_hash: `hash-${i}`, tx_type: 14, tx_info: "exact-signed-close", api_key_index: 16, reduce_only: 1, effect: "close" });
   await store.checkpoint(first, encodeStanddownLedger(book), 100_002);
   assert.equal(await store.reserveClose(first, { marketId: 1, txHash: "hash-1" }, 100_003), true);
   // Parent committed its reservation, then its ACK was lost before the child
   // knew whether a send happened. The replay keeps that same attempt.
   const next = (await store.claim(first.id, "replacement", 100_004))!;
   assert.equal(await store.reserveClose(first, { marketId: 1, txHash: "hash-2" }, 100_005), false);
   assert.equal(await store.reserveClose(next, { marketId: 1, txHash: "hash-1" }, 100_005), true);
   assert.equal(await store.reserveClose(next, { marketId: 1, txHash: "hash-2" }, 100_006), true);
   const attempts = await Promise.all([
    store.reserveClose(next, { marketId: 1, txHash: "hash-3" }, 100_007),
    store.reserveClose(next, { marketId: 1, txHash: "hash-4" }, 100_007),
   ]);
   assert.equal(attempts.filter(Boolean).length, 1);
   assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM perp_standdown_closes WHERE job_id = ? AND market_id = 1").get(first.id) as { n: number }).n, 3);
   assert.equal(await store.reserveClose(next, { marketId: 2, txHash: "hash-5" }, 100_008), true, "one market cannot spend another market's budget");
   assert.equal(await store.reserveClose(next, { marketId: 2, txHash: "hash-1" }, 100_008), false);
   assert.equal(await store.reserveClose(next, { marketId: 3, txHash: "not-recorded" }, 100_008), false);
   assert.equal(await store.reserveClose(next, { marketId: 1, txHash: "hash-1" }, next.expiresAtMs), false);
  } finally { raw.close(); }
 });
});

describe("hosted shutdown isolation and durable send barriers", () => {
 it("the runner environment has no session, owner, database, bundler or model secrets", () => {
  const env = standdownChildEnv("/runner", "/fleet", { PATH: "/usr/bin", HOME: "/home", DATABASE_URL: "postgres://secret", MERRYMEN_STORE_DEK: "secret", MERRYMEN_PIMLICO_KEY: "secret", OPENAI_API_KEY: "secret" });
  assert.equal(env.PATH, "/usr/bin"); assert.equal(env.MERRYMEN_HOME, "/runner");
  assert.ok(!JSON.stringify(env).includes("secret"));
  assert.equal(hostedStanddownAvailable({ DATABASE_URL: "postgres://test" }), false);
  assert.equal(hostedStanddownAvailable({ DATABASE_URL: "postgres://test", MERRYMEN_STORE_DEK: DEK.toString("base64") }), true);
 });
 it("an unacknowledged write cannot return to a caller that would send", async () => {
  const order: string[] = [];
  const store = durableStanddownStore({ insertPerpOrderSubmitted: async () => { order.push("local persisted"); return "id"; } }, async () => { order.push("durable failed"); throw new Error("db unavailable"); });
  await assert.rejects(async () => { await store.insertPerpOrderSubmitted(); order.push("send"); });
  assert.deepEqual(order, ["local persisted", "durable failed"]);
 });
 it("a replay after a failed mutation ACK still cannot send until its exact bytes are durably checkpointed", async () => {
  let local = "", durable = "", available = false, sends = 0, fences = 0;
  const persist = async () => { if (!available) throw new Error("parent offline"); durable = local; };
  const store = durableStanddownStore({ insertPerpOrderSubmitted: async () => { local = "signed-close-nonce-17"; } }, persist);
  await assert.rejects(store.insertPerpOrderSubmitted());
  const beforeSend = durableStanddownSendFence(persist, async () => { fences++; });
  const replay = async () => { await beforeSend(); assert.equal(durable, local); sends++; };
  await assert.rejects(replay()); assert.equal(sends, 0); assert.equal(fences, 0);
  available = true; await replay(); assert.equal(sends, 1); assert.equal(fences, 1);
 });
 it("a recovery capsule rejects foreign/paper rows and restores exact nonce/tx bytes", async () => {
  const a = new DatabaseSync(":memory:"), b = new DatabaseSync(":memory:");
  try {
   const db = wrapSqlite(a), restored = wrapSqlite(b); await applyLedgerSchema(db); await applyLedgerSchema(restored);
   await db.prepare("INSERT INTO perp_accounts (agent_id, mode, nonce_high_water) VALUES (?, 'live', '456')").run(ACCOUNT);
   await db.prepare("INSERT INTO perp_orders (id, agent_id, mode, epoch, status, effect, reduce_only, worst_notional_micro, tx_info) VALUES ('x', ?, 'live', 1, 'submitted', 'close', 1, '0', 'EXACT_SIGNED_BYTES')").run(ACCOUNT);
   await db.prepare("INSERT INTO perp_accounts (agent_id, mode) VALUES (?, 'live')").run(OTHER);
   const bytes = await captureStanddownLedger(db, ACCOUNT);
   assert.ok(!bytes.toString().includes(OTHER));
   await restoreStanddownLedger(restored, bytes, ACCOUNT);
   assert.equal((await restored.prepare("SELECT tx_info FROM perp_orders").get() as { tx_info: string }).tx_info, "EXACT_SIGNED_BYTES");
   assert.equal((await restored.prepare("SELECT nonce_high_water FROM perp_accounts").get() as { nonce_high_water: string }).nonce_high_water, "456");
   const evil = validateStanddownLedger(bytes, ACCOUNT); evil.tables.perp_accounts![0]!.agent_id = OTHER;
   assert.throws(() => encodeStanddownLedger(evil));
   assert.throws(() => validateStanddownLedger(bytes, OTHER));
  } finally { a.close(); b.close(); }
 });
 it("a supervisor refuses to spawn without the lease and kills a runner whose send fence loses it", async () => {
  const { raw, db, store } = await setup(); const home = mkdtempSync(path.join(os.tmpdir(), "mm-hosted-shutdown-"));
  let leased = false, spawns = 0;
  const process = new EventEmitter() as ChildProcess;
  Object.assign(process, { connected: true, exitCode: null, signalCode: null });
  const acks: unknown[] = []; process.send = ((msg: unknown) => { acks.push(msg); return true; }) as ChildProcess["send"];
  process.kill = (() => { process.emit("exit", null, "SIGKILL"); return true; }) as ChildProcess["kill"];
  const supervisor = new HostedStanddownSupervisor({ db, dek: DEK, home, normalHome: () => path.join(home, "normal"), acquire: async () => leased, healthy: () => leased, stopNormal: async () => true, log: () => {},
   spawnRunner: (() => { spawns++; return process; }) as unknown as typeof spawn });
  try {
   await applyLedgerSchema(db);
   await revokeHostedGrant(db, TENANT, DEK);
   await supervisor.reconcile(); assert.equal(spawns, 0);
   leased = true; await supervisor.reconcile(); assert.equal(spawns, 1);
   const job = (await store.latest(TENANT))!;
   const runnerHome = path.join(home, "perp-standdowns", `${job.id}-${job.generation}`);
   assert.ok(existsSync(path.join(runnerHome, "perp-key.json")));
   assert.ok(!existsSync(path.join(runnerHome, "grant.json")));
   assert.ok(!readFileSync(path.join(runnerHome, "standdown.json"), "utf8").includes("apiKeySealed"));
   const orphan = path.join(runnerHome, ".perp-checkpoint-00000000-0000-4000-8000-000000000000");
   writeFileSync(orphan, "signed replay bytes in interrupted sender spool", { mode: 0o600 });
   leased = false; process.emit("message", { id: 1, kind: "fence" });
   await new Promise(resolve => setTimeout(resolve, 25));
   assert.deepEqual(acks, [{ id: 1, ok: false }]);
   assert.equal(existsSync(path.join(runnerHome, "perp-key.json")), false);
   assert.equal(existsSync(orphan), false);
  } finally { supervisor.stopAll(); raw.close(); rmSync(home, { recursive: true, force: true }); }
 });
});

async function readBook(chunks: FinancialChunks) {
 const tables: Record<string, Record<string, unknown>[]> = {};
 await inspectFinancialStream(chunks, ACCOUNT, { onRow: (table, row) => { (tables[table] ??= []).push(row); } });
 return { tables };
}
async function journalFact(db: Db, kind: string, value: number): Promise<void> {
 const last = await db.prepare("SELECT hash FROM journal WHERE agent_id = ? AND epoch = 1 ORDER BY seq DESC LIMIT 1").get(ACCOUNT) as { hash: string } | undefined;
 const prev = last?.hash ?? JOURNAL_GENESIS, payload = JSON.stringify({ value });
 await db.prepare("INSERT INTO journal (agent_id, epoch, kind, payload_json, prev_hash, hash, at) VALUES (?, 1, ?, ?, ?, ?, 100)")
  .run(ACCOUNT, kind, payload, prev, journalHash(prev, payload));
}
function inertChild() {
 const proc = new EventEmitter() as ChildProcess;
 Object.assign(proc, { connected: true, exitCode: null, signalCode: null });
 const acks: { id: number; ok: boolean }[] = [];
 proc.send = ((msg: { id: number; ok: boolean }) => { acks.push(msg); return true; }) as ChildProcess["send"];
 proc.kill = (() => { proc.emit("exit", null, "SIGKILL"); return true; }) as ChildProcess["kill"];
 const message = async (msg: unknown) => {
  const prior = acks.length; proc.emit("message", msg);
  for (let i = 0; i < 100 && acks.length === prior; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(acks.length, prior + 1, "child message must receive a durable acknowledgement");
  return acks.at(-1)!;
 };
 return { proc, acks, message };
}
describe("hosted financial lifecycle", () => {
 it("a mirrored residual or unknown result never becomes the old funds-home confirmation", () => {
  for (const result of [{ outcome: "residual", ingested: true, otherAccounts: 1 }, { outcome: "unreachable", ingested: false }]) {
   const job = { state: "done", resultJson: JSON.stringify(result), mirrored: true };
   const text = hostedStanddownConfirmation(job);
   assert.match(text, /residual|unknown/); assert.doesNotMatch(text, /funds stay|funds are home|shutdown.*queued/i);
  }
 });
 it("hands a revoked normal child's final spot suffix to shutdown, then cold-restores its completed exact accounting without replay bytes", async () => {
  const { raw, db, store } = await setup();
  const home = mkdtempSync(path.join(os.tmpdir(), "mm-shutdown-lifecycle-")), normalHome = path.join(home, "normal"); mkdirSync(normalHome);
  const localRaw = new DatabaseSync(path.join(normalHome, "merrymen.db")), local = wrapSqlite(localRaw);
  const child = inertChild(); let spawns = 0, mirroredNormal = false;
  let bridge: HostedLiveCheckpointBridge;
  const supervisor = new HostedStanddownSupervisor({ db, dek: DEK, home, normalHome: () => normalHome, acquire: async () => true, healthy: () => true,
   stopNormal: async () => {
    if (mirroredNormal) return true;
    await bridge.mirrorSnapshot(local, async snapshot => {
     const r = await mirrorTenant({ tenant: TENANT, child: snapshot, shared: db }); assert.deepEqual(r.failed ?? {}, {});
    });
    mirroredNormal = true; return true;
   }, log: () => {}, spawnRunner: (() => { spawns++; return child.proc; }) as unknown as typeof spawn });
  try {
   await applyLedgerSchema(db); await applyLedgerSchema(local); await db.exec(MIRROR_STATE_DDL);
   await local.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, ?, ?, 4663, '{}', 1, 2000000000)").run(ACCOUNT, TENANT, TENANT);
   await local.prepare("INSERT INTO paper_book (agent_id, cash_usdg) VALUES (?, 50)").run(ACCOUNT);
   await local.prepare("INSERT INTO perp_accounts (agent_id, mode, nonce_high_water) VALUES (?, 'live', '456')").run(ACCOUNT);
   await local.prepare("INSERT INTO perp_orders (id, agent_id, mode, epoch, status, effect, reduce_only, worst_notional_micro, tx_info, nonce, tx_hash, account_index, api_key_index) VALUES ('close', ?, 'live', 1, 'submitted', 'close', 1, '0', 'SIGNED_CLOSE', 456, 'close-hash', 123, 16)").run(ACCOUNT);
   await journalFact(local, "mark", 1);
   bridge = await HostedLiveCheckpointBridge.prepare({ shared: db, dek: DEK, tenant: TENANT, account: ACCOUNT, publicKey: PUB, home: normalHome, healthy: () => true });
   // A spot write after the last perps ACK belongs to the final normal snapshot.
   await local.tx(async tx => {
    await tx.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, user_op_hash) VALUES (?, 'swap', 'pool', 7, 'landed', 'op-late')").run(ACCOUNT);
    await tx.prepare("UPDATE paper_book SET cash_usdg = 43 WHERE agent_id = ?").run(ACCOUNT);
    await journalFact(tx, "fill", 7);
   });
   await revokeHostedGrant(db, TENANT, DEK);
   const live = new HostedLiveCheckpointStore(db, DEK);
   assert.equal(await live.fence((await live.latest(TENANT, ACCOUNT))!), false, "ordinary grant authority is already gone");
   assert.equal((await readBook(live.loadStream((await live.latest(TENANT, ACCOUNT))!))).tables.perp_orders![0]!.tx_info, null);
   await supervisor.reconcile(); assert.equal(spawns, 1); assert.equal(mirroredNormal, true);
   let job = (await store.latest(TENANT))!;
   const initial = (await readBook(store.loadStream(job)));
   assert.equal(initial.tables.journal!.length, 2); assert.equal(initial.tables.perp_orders![0]!.tx_info, "SIGNED_CLOSE");
   const runnerHome = path.join(home, "perp-standdowns", `${job.id}-${job.generation}`);
   const runnerRaw = new DatabaseSync(path.join(runnerHome, "merrymen.db")), runner = wrapSqlite(runnerRaw);
   try {
    await runner.tx(async tx => {
     await tx.prepare("UPDATE perp_accounts SET nonce_high_water = '457' WHERE agent_id = ?").run(ACCOUNT);
     await tx.prepare("UPDATE perp_orders SET status = 'filled', updated_at = updated_at + 1 WHERE id = 'close'").run();
     await journalFact(tx, "perp-fill", 9);
    });
    const final = await runner.tx(tx => captureStanddownLedger(tx, ACCOUNT));
    assert.equal((await child.message({ id: 1, kind: "checkpoint", payload: final.toString("base64") })).ok, true);
    assert.equal((await child.message({ id: 2, kind: "fence" })).ok, true);
    assert.equal((await child.message({ id: 3, kind: "result", payload: JSON.stringify({ outcome: "residual", ingested: true, ordersLeft: 0, openPositions: 0, finishedAt: Date.now(), otherAccounts: 1, collateralMicro: "0", withdrawRequestedMicro: null }) })).ok, true);
   } finally { runnerRaw.close(); }
   job = (await store.latest(TENANT))!; assert.equal(job.sealedKey, null);
   assert.equal((await readBook(store.loadStream(job))).tables.perp_orders![0]!.tx_info, null);
   child.proc.emit("exit", 0, null); await supervisor.reconcile();
   job = (await store.latest(TENANT))!; assert.equal(job.mirrored, true); assert.equal(job.checkpoint, null);
   assert.equal(JSON.parse(job.resultJson!).outcome, "residual", "inaccessible subaccounts never become a done claim");
   assert.equal(existsSync(normalHome), false); assert.equal(existsSync(runnerHome), false);
   const final = (await readBook(live.loadStream((await live.latest(TENANT, ACCOUNT))!)));
   assert.equal(final.tables.journal!.length, 3); assert.equal(final.tables.paper_book![0]!.cash_usdg, 43);
   assert.equal(final.tables.perp_accounts![0]!.nonce_high_water, "457"); assert.equal(final.tables.perp_orders![0]!.tx_info, null);
   await db.prepare("INSERT INTO grants VALUES (?, ?, ?)").run(TENANT, JSON.stringify(grant()), 100);
   mkdirSync(normalHome);
   await HostedLiveCheckpointBridge.prepare({ shared: db, dek: DEK, tenant: TENANT, account: ACCOUNT, publicKey: PUB, home: normalHome, healthy: () => true });
   const restored = new DatabaseSync(path.join(normalHome, "merrymen.db"));
   try {
    assert.equal((restored.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number }).n, 3);
    assert.equal((restored.prepare("SELECT nonce_high_water FROM perp_accounts").get() as { nonce_high_water: string }).nonce_high_water, "457");
    assert.equal((restored.prepare("SELECT tx_info FROM perp_orders").get() as { tx_info: null }).tx_info, null);
   } finally { restored.close(); }
  } finally { supervisor.stopAll(); localRaw.close(); raw.close(); rmSync(home, { recursive: true, force: true }); }
 });

 it("an expiry before first claim still preserves the stopped normal child's final suffix without replay authority", async () => {
  const { raw, db, store } = await setup(); const home = mkdtempSync(path.join(os.tmpdir(), "mm-expired-handoff-"));
  const localRaw = new DatabaseSync(path.join(home, "merrymen.db")), local = wrapSqlite(localRaw);
  try {
   await applyLedgerSchema(db); await applyLedgerSchema(local);
   await journalFact(local, "mark", 1);
   const bridge = await HostedLiveCheckpointBridge.prepare({ shared: db, dek: DEK, tenant: TENANT, account: ACCOUNT, publicKey: PUB, home, healthy: () => true });
   await journalFact(local, "mark", 2);
   await revokeHostedGrant(db, TENANT, DEK, { nowMs: 100_000 });
   await store.expire(100_000 + HOSTED_STANDDOWN_TTL_MS);
   await bridge.mirrorSnapshot(local, async snapshot => { assert.equal((await snapshot.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number }).n, 2); });
   const job = (await store.latest(TENANT))!;
   assert.equal(job.state, "expired"); assert.equal(job.sealedKey, null); assert.equal(job.generation, 1);
   assert.equal((await readBook(store.loadStream(job))).tables.journal!.length, 2);
  } finally { localRaw.close(); raw.close(); rmSync(home, { recursive: true, force: true }); }
 });

 it("a final mirror retains recovery material until every bounded perps page is copied", async () => {
  const { raw, db, store } = await setup(); const home = mkdtempSync(path.join(os.tmpdir(), "mm-mirror-pages-")), normalHome = path.join(home, "normal"); mkdirSync(normalHome);
  const sourceRaw = new DatabaseSync(":memory:"), source = wrapSqlite(sourceRaw);
  const supervisor = new HostedStanddownSupervisor({ db, dek: DEK, home, normalHome: () => normalHome, acquire: async () => true, healthy: () => true, stopNormal: async () => true, log: () => {}, spawnRunner: (() => { throw new Error("terminal jobs must not spawn"); }) as unknown as typeof spawn });
  try {
   await applyLedgerSchema(db); await applyLedgerSchema(source);
   await source.tx(async tx => {
    const insert = tx.prepare("INSERT INTO perp_orders (id, agent_id, mode, epoch, status, effect, reduce_only, worst_notional_micro, created_at, updated_at) VALUES (?, ?, 'live', 1, 'filled', 'close', 1, '0', 100, 100)");
    for (let i = 0; i < 10_241; i++) await insert.run(`close-${i}`, ACCOUNT);
   });
   await revokeHostedGrant(db, TENANT, DEK);
   const job = (await store.claim((await store.latest(TENANT))!.id, "a"))!;
   await store.checkpoint(job, await source.tx(tx => captureStanddownLedger(tx, ACCOUNT)));
   await store.finish(job, '{"outcome":"residual","ingested":true}');
   await supervisor.reconcile();
   assert.equal((await store.latest(TENANT))!.mirrored, false); assert.ok(existsSync(normalHome));
   assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM perp_orders").get() as { n: number }).n, 10_240);
   await supervisor.reconcile();
   assert.equal((await store.latest(TENANT))!.mirrored, true); assert.equal(existsSync(normalHome), false);
   assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM perp_orders").get() as { n: number }).n, 10_241);
  } finally { supervisor.stopAll(); sourceRaw.close(); raw.close(); rmSync(home, { recursive: true, force: true }); }
 });

 for (const failure of ["fence", "spawn"] as const) it(`cleans plaintext venue material when ${failure} fails after key materialization`, async () => {
  const { raw, db, store } = await setup(); const home = mkdtempSync(path.join(os.tmpdir(), "mm-shutdown-start-failure-"));
  let originalFence = HostedStanddownStore.prototype.fence, sawKey = false;
  const keyFiles = () => {
   const root = path.join(home, "perp-standdowns");
   if (!existsSync(root)) return [];
   return readdirSync(root).map((dir: string) => path.join(root, dir, "perp-key.json")).filter((file: string) => existsSync(file));
  };
  if (failure === "fence") HostedStanddownStore.prototype.fence = async function(job, now) {
   if (keyFiles().length) { sawKey = true; throw new Error("database failed after key write"); }
   return originalFence.call(this, job, now);
  };
  const supervisor = new HostedStanddownSupervisor({ db, dek: DEK, home, normalHome: () => path.join(home, "normal"), acquire: async () => true, healthy: () => true,
   stopNormal: async () => true, log: () => {}, spawnRunner: (() => { sawKey = keyFiles().length > 0; throw new Error("spawn failed"); }) as unknown as typeof spawn });
  try {
   await applyLedgerSchema(db); await revokeHostedGrant(db, TENANT, DEK); await supervisor.reconcile();
   assert.equal(sawKey, true); assert.deepEqual(keyFiles(), []);
   const job = (await store.latest(TENANT))!; assert.ok(job.checkpoint); assert.equal(job.state, "running");
  } finally { HostedStanddownStore.prototype.fence = originalFence; supervisor.stopAll(); raw.close(); rmSync(home, { recursive: true, force: true }); }
 });
});
