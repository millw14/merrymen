/** Cold starts and every live copy preserve the original shared accounting witnesses. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import type { TenantLease } from "./tenant-lease";
import { ensurePersonalMemorySchema, publishPersonalMemory, recordPersonalMemoryForget, restorePersonalMemory } from "./personal-memory-ferry";

const fleet = mkdtempSync(path.join(os.tmpdir(), "merrymen-live-continuity-"));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
const {
  adoptChildForTest, childHome, hasLeaseForTest, isRetiringExpiredForTest, mirrorRunningLedgerForTest, mirrorLedgersForTest, reconcile,
  setLiveMirrorStoreForTest, setPaperRestoreForTest, setRetirementMemoryStoreForTest, setSpawnForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw), dek = Buffer.alloc(32, 75);
await applyLedgerSchema(shared);
await shared.exec(MIRROR_STATE_DDL);
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
class FakeProc extends EventEmitter {
  readonly stdout = null; readonly stderr = null; readonly signals: string[] = [];
  constructor(readonly pid: number) { super(); }
  kill(signal?: NodeJS.Signals | number) { this.signals.push(String(signal)); return true; }
  exit() { this.emit("exit", 0, "SIGTERM"); }
}
const spawned: FakeProc[] = [];
setSpawnForTest(() => {
  const proc = new FakeProc(77_000 + spawned.length); spawned.push(proc);
  return proc as unknown as ChildProcess;
});
const handles: DatabaseSync[] = [];
after(() => {
  setPaperRestoreForTest(null); setRetirementMemoryStoreForTest(null); setLiveMirrorStoreForTest(null);
  for (const handle of handles) handle.close();
  raw.close(); rmSync(fleet, { recursive: true, force: true });
});
function lease(tenant: `0x${string}`, releases: { n: number }): TenantLease {
  return { tenant, backend: "postgres", healthy: () => true, async release() { releases.n++; } };
}
async function agent(db: Db, tenant: string, account: string) {
  await db.prepare(`INSERT INTO agents (smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,status,hwm_usdg,mode)
    VALUES (?,?,?,4663,'{}',1,9999999999,'armed',120,'live')`).run(account, tenant, address(0xc92));
}
async function book(tenant: string, account: string, id = 1) {
  const home = childHome(tenant); mkdirSync(home, { recursive: true });
  const localRaw = new DatabaseSync(path.join(home, "merrymen.db")); handles.push(localRaw);
  const local = wrapSqlite(localRaw); await applyLedgerSchema(local); await agent(local, tenant, account);
  await local.prepare(`INSERT INTO trades(id,agent_id,kind,target,amount_usdg,status,created_at)
    VALUES (?,?,'swap','fixture',1,'rejected',?)`).run(id, account, id === 100 ? 100 : 200);
  return { localRaw, local, home };
}
async function protectedShared(tenant: string, account: string) {
  await agent(shared, tenant, account);
  await shared.prepare(`INSERT INTO positions(agent_id,symbol,token,raw_balance,ui_multiplier,price_usd,value_usdg,updated_at)
    VALUES (?,'COIN',?,'10','1',1,10,100)`).run(account, tenant);
  await shared.prepare(`INSERT INTO cost_basis(agent_id,mode,symbol,qty_raw,cost_usdg,updated_at)
    VALUES (?,'live','COIN','10','20',100)`).run(account);
  await shared.prepare(`INSERT INTO mirror_state(tenant,table_name,last_id,last_stamp,updated_at)
    VALUES (?,'trades',100,100,100)`).run(tenant);
}
async function assertProtected(tenant: string, account: string, cursor = 100) {
  assert.equal((await shared.prepare("SELECT raw_balance FROM positions WHERE agent_id=?").get(account) as {raw_balance: string}).raw_balance, "10");
  assert.equal((await shared.prepare("SELECT cost_usdg FROM cost_basis WHERE agent_id=?").get(account) as {cost_usdg: string}).cost_usdg, "20");
  assert.equal(Number((await shared.prepare("SELECT last_id FROM mirror_state WHERE tenant=? AND table_name='trades'").get(tenant) as {last_id: number}).last_id), cursor);
}
const grant = (account: `0x${string}`) => ({
  smartAccount: account, owner: address(0xc91), sessionKeyAddress: address(0xc92), serialized: "fixture-live-continuity",
  chainId: 4663, grantedAt: 1, expiresAt: Math.floor(Date.now()/1000)+86400,
  caps: {perTradeUsdg:10,dailyUsdg:50,maxDrawdownPct:20,expiryDays:7},
  grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
}) as unknown as StoredGrant;

async function seedDm(tenant: string, local: DatabaseSync, home: string) {
  mkdirSync(path.join(home,"soul"),{recursive:true}); writeFileSync(path.join(home,"soul","OWNER.md"),"preserved owner notes");
  local.exec("CREATE TABLE IF NOT EXISTS chat_turns (id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,memory_ids TEXT,at INTEGER NOT NULL)");
  for (const chat of [42,43]) local.prepare("INSERT INTO chat_turns(chat_id,role,content,at) VALUES (?,'user',?,100)").run(chat,`protected transcript ${chat}`);
  await ensurePersonalMemorySchema(shared,"sqlite");
  assert.equal(await publishPersonalMemory({tenant,home,shared,dek,seen:new Map(),log:()=>{}}),"published");
}
async function restoredChats(tenant: string) {
  const destination=mkdtempSync(path.join(fleet,"dm-restore-"));
  assert.equal(await restorePersonalMemory({tenant,home:destination,shared,dek,log:()=>{}}),"restored");
  const copy=new DatabaseSync(path.join(destination,"merrymen.db"));
  try { return copy.prepare("SELECT chat_id,content FROM chat_turns ORDER BY chat_id").all() as Array<{chat_id:number;content:string}>; }
  finally {copy.close();}
}

it("two queued ordinary live passes refuse a rebuilt source before either cursor or protected snapshot changes", async () => {
  const tenant = address(0xc11), account = address(0xc12), proc = new FakeProc(76_001), releases = {n:0};
  await protectedShared(tenant, account); await book(tenant, account);
  adoptChildForTest(tenant, account, proc, lease(tenant, releases));
  const results = await Promise.allSettled([mirrorRunningLedgerForTest(tenant, shared), mirrorRunningLedgerForTest(tenant, shared)]);
  assert.ok(results.every(r => r.status === "rejected"));
  await assertProtected(tenant, account);
  assert.deepEqual(proc.signals, ["SIGTERM"]);
  assert.equal(hasLeaseForTest(tenant), true); assert.equal(releases.n, 0);
  assert.equal(existsSync(path.join(childHome(tenant), "ledger-source-blocked.json")), false, "unchanged-cursor proof failure is safely retryable");
  proc.exit();
});

it("an unexpected live rewind persists its guard, stands trading down, and refuses a later copy", async () => {
  const tenant = address(0xc21), account = address(0xc22), proc = new FakeProc(76_002), releases = {n:0};
  await protectedShared(tenant, account); const {localRaw, home} = await book(tenant, account, 100);
  let changed = false;
  const racing: Db = {exec: sql => shared.exec(sql), tx: fn => shared.tx(fn), prepare(sql) {
    const s = shared.prepare(sql);
    return {...s, async get(...args) {
      const row = await s.get(...args);
      if (!changed && /SELECT last_id, last_stamp FROM mirror_state/.test(sql) && args[1] === "fee_accruals") {
        changed = true; localRaw.prepare("DELETE FROM trades WHERE agent_id=?").run(account);
        localRaw.prepare(`INSERT INTO trades(id,agent_id,kind,target,amount_usdg,status,created_at)
          VALUES (1,?,'swap','fixture',1,'rejected',200)`).run(account);
      }
      return row;
    }};
  }};
  adoptChildForTest(tenant, account, proc, lease(tenant, releases));
  await assert.rejects(mirrorRunningLedgerForTest(tenant, racing), /source changed/);
  await assertProtected(tenant, account, 1);
  assert.equal(existsSync(path.join(home,"ledger-source-blocked.json")), true);
  await assert.rejects(mirrorRunningLedgerForTest(tenant, shared));
  await assertProtected(tenant, account, 1);
  assert.equal(proc.signals[0], "SIGTERM"); assert.equal(hasLeaseForTest(tenant), true); assert.equal(releases.n, 0);
  proc.exit();
});

it("a healthy ordinary source continues mirroring and clears only the guard it successfully completed", async () => {
  const tenant = address(0xc31), account = address(0xc32), proc = new FakeProc(76_003), releases = {n:0};
  await protectedShared(tenant, account); const {local, home} = await book(tenant, account, 100);
  await local.prepare(`INSERT INTO trades(id,agent_id,kind,target,amount_usdg,status,created_at)
    VALUES (101,?,'swap','fixture',1,'rejected',200)`).run(account);
  await local.prepare(`INSERT INTO positions(agent_id,symbol,token,raw_balance,ui_multiplier,price_usd,value_usdg,updated_at)
    VALUES (?,'COIN',?,'10','1',1,10,100)`).run(account, tenant);
  await local.prepare(`INSERT INTO cost_basis(agent_id,mode,symbol,qty_raw,cost_usdg,updated_at)
    VALUES (?,'live','COIN','10','20',100)`).run(account);
  adoptChildForTest(tenant, account, proc, lease(tenant,releases));
  await mirrorRunningLedgerForTest(tenant, shared); await mirrorRunningLedgerForTest(tenant, shared);
  await assertProtected(tenant, account, 101); assert.deepEqual(proc.signals, []);
  assert.equal(existsSync(path.join(home,"ledger-source-blocked.json")), false);
  assert.equal(hasLeaseForTest(tenant), true); assert.equal(releases.n, 0);
});

it("cold startup checks the rebuilt ledger created during restore before the worker forks", async () => {
  const tenant = address(0xc41), account = address(0xc42);
  await protectedShared(tenant, account);
  assert.equal(existsSync(path.join(childHome(tenant),"merrymen.db")), false);
  let restored = 0;
  setRetirementMemoryStoreForTest({shared,dek,dialect:"sqlite"});
  setPaperRestoreForTest(async (t,a) => { if (t === tenant) {restored++; await book(t,a);} return {ok:true,line:null}; });
  await getGrantStore().put(tenant, grant(account));
  const before = spawned.length; await reconcile();
  assert.equal(restored, 1, "the file was absent at entry and created by the actual preparation path");
  assert.equal(spawned.length, before); await assertProtected(tenant,account);
  assert.equal(hasLeaseForTest(tenant), true);
  await getGrantStore().remove(tenant); await reconcile();
  setRetirementMemoryStoreForTest(null); setPaperRestoreForTest(null);
});

it("a fresh cold startup with no previous cursor can create its first book and fork", async () => {
  const tenant = address(0xc51), account = address(0xc52);
  setRetirementMemoryStoreForTest({shared,dek,dialect:"sqlite"});
  setPaperRestoreForTest(async (t,a) => { if (t === tenant) await book(t,a); return {ok:true,line:null}; });
  await getGrantStore().put(tenant,grant(account));
  const before = spawned.length; await reconcile();
  assert.equal(spawned.length,before+1);
  assert.equal(existsSync(path.join(childHome(tenant),"ledger-source-blocked.json")),false);
  await getGrantStore().remove(tenant); await reconcile(); spawned.at(-1)!.exit();
  setRetirementMemoryStoreForTest(null); setPaperRestoreForTest(null);
});

it("a transient continuity read failure stops the writer without rewriting cursors, then a healthy startup may retry", async () => {
  const tenant = address(0xc61), account = address(0xc62), proc = new FakeProc(76_006), releases = {n:0};
  await protectedShared(tenant,account); await book(tenant,account,100);
  const unavailable: Db = {exec: sql=>shared.exec(sql),tx: fn=>shared.tx(fn),prepare(sql) {
    const s=shared.prepare(sql);
    return {...s,async get(...args) {
      if (/SELECT last_id, last_stamp FROM mirror_state/.test(sql)) throw new Error("injected transient read failure");
      return s.get(...args);
    }};
  }};
  await getGrantStore().put(tenant,grant(account));
  adoptChildForTest(tenant,account,proc,lease(tenant,releases));
  await assert.rejects(mirrorRunningLedgerForTest(tenant,unavailable),/transient/);
  await assertProtected(tenant,account);
  assert.equal(existsSync(path.join(childHome(tenant),"ledger-source-blocked.json")),false);
  assert.equal(proc.signals[0],"SIGTERM"); assert.equal(releases.n,0); proc.exit();
  setRetirementMemoryStoreForTest({shared,dek,dialect:"sqlite"});
  const before=spawned.length; await reconcile(); assert.equal(spawned.length,before+1);
  await assertProtected(tenant,account);
  await getGrantStore().remove(tenant); await reconcile(); spawned.at(-1)!.exit();
  setRetirementMemoryStoreForTest(null);
});

it("an unlinked live ledger stops trading and keeps a durable source-loss marker and the healthy lease", async () => {
  const tenant=address(0xc71),account=address(0xc72),proc=new FakeProc(76_007),releases={n:0};
  await protectedShared(tenant,account); const {home}=await book(tenant,account,100);
  adoptChildForTest(tenant,account,proc,lease(tenant,releases));
  rmSync(path.join(home,"merrymen.db"));
  await assert.rejects(mirrorRunningLedgerForTest(tenant,shared),/unreadable/);
  await assertProtected(tenant,account);
  assert.equal(existsSync(path.join(home,"ledger-source-blocked.json")),true);
  assert.equal(proc.signals[0],"SIGTERM"); assert.equal(hasLeaseForTest(tenant),true); assert.equal(releases.n,0);
  proc.exit();
  await getGrantStore().put(tenant,grant(account)); setRetirementMemoryStoreForTest({shared,dek,dialect:"sqlite"});
  const before=spawned.length; await reconcile(); assert.equal(spawned.length,before);
  assert.equal(existsSync(path.join(home,"merrymen.db")),false,"the lost source is not silently replaced");
  setRetirementMemoryStoreForTest(null);
});

it("lease loss during a copy leaves the pending barrier instead of certifying the copy", async () => {
  const tenant=address(0xc81),account=address(0xc82),proc=new FakeProc(76_008),releases={n:0};
  await protectedShared(tenant,account); const {home}=await book(tenant,account,100);
  let healthy=true;
  adoptChildForTest(tenant,account,proc,{...lease(tenant,releases),healthy:()=>healthy});
  const loss: Db={exec: sql=>shared.exec(sql),prepare: sql=>shared.prepare(sql),async tx(fn) {
    const result=await shared.tx(fn); healthy=false; return result;
  }};
  await assert.rejects(mirrorRunningLedgerForTest(tenant,loss),/ownership changed/);
  assert.equal(existsSync(path.join(home,"ledger-source-blocked.json")),true);
  assert.equal(proc.signals[0],"SIGTERM"); assert.equal(releases.n,0); proc.exit();
});

it("a full live pass with a missing source retains sealed DM history and still applies the requested chat forget", async () => {
  const tenant=address(0xc91),account=address(0xc92),proc=new FakeProc(76_009),releases={n:0};
  await protectedShared(tenant,account); const {home,localRaw}=await book(tenant,account,100);
  await seedDm(tenant,localRaw,home); const original=(await shared.prepare("SELECT sealed FROM tenant_personal_memory WHERE tenant=?").get(tenant) as {sealed:string}).sealed;
  rmSync(path.join(home,"merrymen.db")); adoptChildForTest(tenant,account,proc,lease(tenant,releases));
  setLiveMirrorStoreForTest({shared,dek,dialect:"sqlite"}); await mirrorLedgersForTest();
  assert.equal((await shared.prepare("SELECT sealed FROM tenant_personal_memory WHERE tenant=?").get(tenant) as {sealed:string}).sealed,original);
  assert.deepEqual((await restoredChats(tenant)).map(t=>t.chat_id),[42,43]);
  recordPersonalMemoryForget({kind:"chat",chatId:42},home);
  // Drive the same unconfirmed live boundary again, with its recovery marker
  // already retained. It may apply privacy operations, never a full snapshot.
  adoptChildForTest(tenant,account,proc,lease(tenant,releases)); await mirrorLedgersForTest();
  assert.deepEqual((await restoredChats(tenant)).map(t=>t.chat_id),[43]);
  assert.equal(readFileSync(path.join(home,"soul","OWNER.md"),"utf8"),"preserved owner notes");
  assert.equal(releases.n,0); proc.exit(); setLiveMirrorStoreForTest(null);
});

it("a missing retirement source retains sealed DM history and its lease while a valid chat forget still reaches the row", async () => {
  const tenant=address(0xca1),account=address(0xca2),proc=new FakeProc(76_010),releases={n:0};
  await protectedShared(tenant,account); const {home,localRaw}=await book(tenant,account,100); await seedDm(tenant,localRaw,home);
  const original=(await shared.prepare("SELECT sealed FROM tenant_personal_memory WHERE tenant=?").get(tenant) as {sealed:string}).sealed;
  await getGrantStore().put(tenant,grant(account)); adoptChildForTest(tenant,account,proc,lease(tenant,releases));
  setRetirementMemoryStoreForTest({shared,dek,dialect:"sqlite"}); await getGrantStore().stopForReplacement(tenant,account);
  await reconcile(); proc.exit(); rmSync(path.join(home,"merrymen.db")); await reconcile();
  assert.equal((await shared.prepare("SELECT sealed FROM tenant_personal_memory WHERE tenant=?").get(tenant) as {sealed:string}).sealed,original);
  assert.deepEqual((await restoredChats(tenant)).map(t=>t.chat_id),[42,43]);
  assert.equal(isRetiringExpiredForTest(tenant),true); assert.equal(hasLeaseForTest(tenant),true); assert.equal(releases.n,0);
  recordPersonalMemoryForget({kind:"chat",chatId:42},home); await reconcile();
  assert.deepEqual((await restoredChats(tenant)).map(t=>t.chat_id),[43]);
  assert.equal(isRetiringExpiredForTest(tenant),true); assert.equal(releases.n,0);
  setRetirementMemoryStoreForTest(null);
});
