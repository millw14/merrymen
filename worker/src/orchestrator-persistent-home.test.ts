/** Real SQLite books through the persistent cold-start and stopped-writer cleanup gates. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { captureLedgerImport, LEDGER_IMPORT_PENDING_FILE, registerLedgerSource, restoreLedgerImport, stageLedgerImport } from "./ledger-import";
import { ensurePersonalMemorySchema, publishPersonalMemory } from "./personal-memory-ferry";
import type { PersistentHomeIdentity } from "./persistent-home";
import type { TenantLease } from "./tenant-lease";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-persistent-reconcile-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
const {
  childHome, hasLeaseForTest, reconcile, setPaperRestoreForTest, setPersistentHomeVerifierForTest,
  setPersonalMemoryStoreForTest, setRetirementMemoryStoreForTest, setSpawnForTest, setTenantLeaseForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw), dek = Buffer.alloc(32, 113);
await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL); await shared.exec(PAPER_CHECKPOINT_SCHEMA);
await ensurePersonalMemorySchema(shared, "sqlite");
raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY,grant_json TEXT NOT NULL,updated_at INTEGER NOT NULL,row_version INTEGER NOT NULL)");
const rootStat = lstatSync(fleet, { bigint: true });
const volume: PersistentHomeIdentity = { id: "654eb84c-04b3-4c02-a281-5e9e10b11604", mountPath: fleet, homeRoot: fleet, device: String(rootStat.dev), inode: String(rootStat.ino) };
setPersistentHomeVerifierForTest(() => volume);
setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
setPersonalMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
class FakeProc extends EventEmitter {
  readonly stdout = null; readonly stderr = null; readonly signals: string[] = [];
  constructor(readonly pid: number) { super(); }
  kill(signal?: NodeJS.Signals | number) { this.signals.push(String(signal)); return true; }
  exit() { this.emit("exit", 0, "SIGTERM"); }
}
const spawned: FakeProc[] = [];
setSpawnForTest(() => { const proc = new FakeProc(93_000 + spawned.length); spawned.push(proc); return proc as unknown as ChildProcess; });
setPaperRestoreForTest(async () => ({ ok: true, line: null }));
after(() => {
  setPaperRestoreForTest(null); setPersistentHomeVerifierForTest(null); setRetirementMemoryStoreForTest(null); setPersonalMemoryStoreForTest(null);
  raw.close(); rmSync(fleet, { recursive: true, force: true });
});
let next = 0;
async function fixture(expiresAt = Math.floor(Date.now() / 1000) + 86_400) {
  const n = ++next, tenant = addr(0xa100 + n), account = addr(0xa200 + n), owner = addr(0xa300 + n), releases = { n: 0 };
  const grant = { smartAccount: account, owner, sessionKeyAddress: addr(0xa400 + n), serialized: "disposable persistent fixture", chainId: 4663,
    grantedAt: 1, expiresAt, caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 }, grantFeatures: ["tradeable-v2"], grantTokens: [],
    demoSessionPrivateKey: `0x${"ab".repeat(32)}` } as unknown as StoredGrant;
  await getGrantStore().put(tenant, grant);
  raw.prepare("INSERT INTO grants VALUES(?,?,1000,1)").run(tenant, JSON.stringify({ smartAccount: account, owner, chainId: 4663 }));
  const lease: TenantLease = { tenant, backend: "postgres", healthy: () => true, async release() { releases.n++; } };
  return { tenant, account, owner, grant, lease, releases, home: childHome(tenant), options: { tenant, smartAccount: account, chainId: 4663, home: childHome(tenant), volume, shared, dek, lease, dialect: "sqlite" as const } };
}
async function remove(f: Awaited<ReturnType<typeof fixture>>, proc?: FakeProc) {
  await getGrantStore().remove(f.tenant); raw.prepare("DELETE FROM grants WHERE tenant=?").run(f.tenant);
  await reconcile(); if (proc) { proc.exit(); await reconcile(); }
  setTenantLeaseForTest(f.tenant, null);
}
function createAgent(db: DatabaseSync, f: Awaited<ReturnType<typeof fixture>>) {
  db.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,status,hwm_usdg,epoch,mode) VALUES(?,?,?,4663,'{}',1,9999999999,'armed',120,3,'live')")
    .run(f.account, f.owner, f.grant.sessionKeyAddress);
}
async function sourceBook(f: Awaited<ReturnType<typeof fixture>>) {
  const original = realpathSync(mkdtempSync(path.join(fleet, "original-"))), file = path.join(original, "merrymen.db"), db = new DatabaseSync(file);
  await applyLedgerSchema(wrapSqlite(db)); createAgent(db, f);
  db.prepare("INSERT INTO trades(id,agent_id,kind,target,amount_usdg,status,created_at,epoch) VALUES(37,?,'swap','fixture',5,'landed',1037,3)").run(f.account);
  db.prepare("INSERT INTO events(id,agent_id,message,created_at) VALUES(40,?,'original event',1040)").run(f.account);
  db.prepare("INSERT INTO events(id,agent_id,message,created_at) VALUES(99,?,'purged allocation',1099)").run(f.account); db.exec("DELETE FROM events WHERE id=99");
  db.prepare("INSERT INTO positions(agent_id,symbol,token,raw_balance,ui_multiplier,price_usd,value_usdg,updated_at) VALUES(?,'COIN',?,'10','1',1,10,1000)").run(f.account, addr(9));
  db.prepare("INSERT INTO cost_basis VALUES(?,'live','COIN','10','20',1000)").run(f.account);
  db.prepare("INSERT INTO position_floors VALUES(?,'live','COIN',1500,'original','reviewed stop',1000)").run(f.account);
  db.prepare("INSERT INTO risk_periods VALUES('original-risk-'||?, ?,1000,100,120,4,'reviewed')").run(f.tenant, f.account);
  db.exec("INSERT INTO chat_turns(chat_id,role,content,at) VALUES(42,'user','private owner memory',1000)");
  mkdirSync(path.join(original, "soul")); writeFileSync(path.join(original, "soul", "OWNER.md"), "original owner notes");
  const report = await mirrorTenant({ tenant: f.tenant, child: wrapSqlite(db), shared }); assert.equal(report.failed, undefined);
  await publishPersonalMemory({ tenant: f.tenant, home: original, shared, dek, seen: new Map(), log() {} });
  db.close(); chmodSync(file, 0o600);
  const artifact = await captureLedgerImport({ tenant: f.tenant, smartAccount: f.account, chainId: 4663, home: original, shared, dek, lease: f.lease,
    source: { deploymentId: "disposable-source", gitCommit: "2".repeat(40), orchestratorPid: 92000, orchestratorStart: "disposable-source-start", quiescent: true, singleReplicaConfirmed: true }, assertSource() {}, dialect: "sqlite" });
  await stageLedgerImport({ artifact, targetVolumeId: volume.id, shared, dek, lease: f.lease, assertSource() {}, dialect: "sqlite" });
  return { artifact, original };
}
function financialFacts(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Object.fromEntries(["agents", "trades", "events", "positions", "cost_basis", "position_floors", "risk_periods", "sqlite_sequence"].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])); }
  finally { db.close(); }
}

it("registers a genuinely new persistent book before partial paper restore and then forks once", async () => {
  const f = await fixture(); setTenantLeaseForTest(f.tenant, f.lease);
  let paperCalls = 0;
  setPaperRestoreForTest(async (tenant) => {
    if (tenant === f.tenant) {
      paperCalls++;
      assert.equal(raw.prepare("SELECT state,sealed FROM tenant_ledger_import WHERE tenant=?").get(tenant)!.state, "consumed");
      const db = new DatabaseSync(path.join(f.home, "merrymen.db")); try { assert.equal(db.prepare("SELECT count(*) AS n FROM agents").get()!.n, 0); createAgent(db, f); } finally { db.close(); }
    }
    return { ok: true, line: null };
  });
  const before = spawned.length; await reconcile();
  assert.equal(paperCalls, 1); assert.equal(spawned.length, before + 1); assert.equal(f.releases.n, 0);
  await remove(f, spawned.at(-1)); setPaperRestoreForTest(async () => ({ ok: true, line: null }));
});

it("restores the original witness rows and memory before partial restore or trading fork", async () => {
  const f = await fixture(); const { original } = await sourceBook(f); setTenantLeaseForTest(f.tenant, f.lease);
  const expected = financialFacts(path.join(original, "merrymen.db")); let paperCalls = 0;
  setPaperRestoreForTest(async tenant => {
    if (tenant === f.tenant) {
      paperCalls++; assert.deepEqual(financialFacts(path.join(f.home, "merrymen.db")), expected);
      const db = new DatabaseSync(path.join(f.home, "merrymen.db"), { readOnly: true });
      try { assert.equal(db.prepare("SELECT content FROM chat_turns WHERE chat_id=42").get()!.content, "private owner memory"); } finally { db.close(); }
      assert.equal(readFileSync(path.join(f.home, "soul", "OWNER.md"), "utf8"), "original owner notes");
    }
    return { ok: true, line: null };
  });
  const before = spawned.length; await reconcile();
  assert.equal(paperCalls, 1); assert.equal(spawned.length, before + 1); assert.equal(existsSync(path.join(f.home, LEDGER_IMPORT_PENDING_FILE)), false);
  await remove(f, spawned.at(-1)); setPaperRestoreForTest(async () => ({ ok: true, line: null }));
});

it("a consumed book lost from the volume refuses before any partial restore can recreate it", async () => {
  const f = await fixture(); await registerLedgerSource(f.options); rmSync(path.join(f.home, "merrymen.db")); setTenantLeaseForTest(f.tenant, f.lease);
  let paperCalls = 0; setPaperRestoreForTest(async () => { paperCalls++; return { ok: true, line: null }; });
  const before = spawned.length; await reconcile(); await reconcile();
  assert.equal(spawned.length, before); assert.equal(paperCalls, 0); assert.equal(existsSync(path.join(f.home, "merrymen.db")), false);
  assert.equal(raw.prepare("SELECT state,sealed FROM tenant_ledger_import WHERE tenant=?").get(f.tenant)!.state, "consumed");
  assert.equal(hasLeaseForTest(f.tenant), true); await remove(f); setPaperRestoreForTest(async () => ({ ok: true, line: null }));
});

it("ordinary reconciliation completes a consumed pending import without replay before it forks", async () => {
  const f = await fixture(); const { original } = await sourceBook(f);
  const lostAck: Db = { exec: sql => shared.exec(sql), prepare: sql => shared.prepare(sql), async tx(fn) {
    const result = await shared.tx(fn);
    if (result === "restored") throw new Error("disposable lost commit acknowledgement");
    return result;
  } };
  await assert.rejects(restoreLedgerImport({ ...f.options, shared: lostAck }), /lost commit acknowledgement/);
  assert.equal(raw.prepare("SELECT state FROM tenant_ledger_import WHERE tenant=?").get(f.tenant)!.state, "consumed");
  assert.equal(existsSync(path.join(f.home, LEDGER_IMPORT_PENDING_FILE)), true);
  const expected = financialFacts(path.join(original, "merrymen.db")); setTenantLeaseForTest(f.tenant, f.lease);
  const before = spawned.length; await reconcile();
  assert.equal(spawned.length, before + 1); assert.equal(existsSync(path.join(f.home, LEDGER_IMPORT_PENDING_FILE)), false);
  assert.deepEqual(financialFacts(path.join(f.home, "merrymen.db")), expected);
  await remove(f, spawned.at(-1));
});

it("explicit removal waits for writer exit, then clears private access and DM memory while retaining original accounting IDs", async () => {
  const f = await fixture(); const { original } = await sourceBook(f); setTenantLeaseForTest(f.tenant, f.lease);
  await reconcile(); const proc = spawned.at(-1)!; const before = financialFacts(path.join(original, "merrymen.db"));
  writeFileSync(path.join(f.home, "telegram.json"), "{\"privateBotState\":true}"); writeFileSync(path.join(f.home, "settings.json"), "{\"privateBotConfig\":true}");
  await getGrantStore().remove(f.tenant); raw.prepare("DELETE FROM grants WHERE tenant=?").run(f.tenant); await reconcile();
  assert.deepEqual(proc.signals, ["SIGTERM"]); assert.equal(existsSync(path.join(f.home, "grant.json")), true);
  assert.equal(existsSync(path.join(f.home, "soul", "OWNER.md")), true); assert.deepEqual(financialFacts(path.join(f.home, "merrymen.db")), before);
  assert.equal(hasLeaseForTest(f.tenant), true); proc.exit(); await reconcile();
  assert.equal(existsSync(path.join(f.home, "merrymen.db")), true); assert.deepEqual(financialFacts(path.join(f.home, "merrymen.db")), before);
  for (const file of ["grant.json", "settings.json", "telegram.json", "soul/OWNER.md"]) assert.equal(existsSync(path.join(f.home, file)), false, file);
  const db = new DatabaseSync(path.join(f.home, "merrymen.db"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM chat_turns WHERE chat_id>0").get()!.n, 0); } finally { db.close(); }
  setTenantLeaseForTest(f.tenant, null);
});

it("cold inactive tenants scrub an obsolete cached signing key without a process or lease", async () => {
  const now = Math.floor(Date.now() / 1000), f = await fixture(now); mkdirSync(f.home, { recursive: true });
  writeFileSync(path.join(f.home, "grant.json"), JSON.stringify(f.grant), { mode: 0o600 });
  const db = new DatabaseSync(path.join(f.home, "merrymen.db")); await applyLedgerSchema(wrapSqlite(db)); createAgent(db, f);
  db.exec("INSERT INTO chat_turns(chat_id,role,content,at) VALUES(42,'user','retained private memory',1000)"); db.close();
  mkdirSync(path.join(f.home, "soul")); writeFileSync(path.join(f.home, "soul", "OWNER.md"), "retained notes");
  const expected = financialFacts(path.join(f.home, "merrymen.db")), before = spawned.length; await reconcile();
  assert.equal(spawned.length, before); assert.equal(hasLeaseForTest(f.tenant), false); assert.equal(existsSync(path.join(f.home, "grant.json")), false);
  assert.deepEqual(financialFacts(path.join(f.home, "merrymen.db")), expected); assert.equal(readFileSync(path.join(f.home, "soul", "OWNER.md"), "utf8"), "retained notes");
  await remove(f);
});

it("removed blocked sources retain the original book and recovery lease after the writer exits", async () => {
  const f = await fixture(); await sourceBook(f); setTenantLeaseForTest(f.tenant, f.lease); await reconcile();
  const proc = spawned.at(-1)!, file = path.join(f.home, "merrymen.db"), expected = financialFacts(file);
  writeFileSync(path.join(f.home, "ledger-source-blocked.json"), JSON.stringify({ version: 1, state: "pending-mirror" }), { mode: 0o600 });
  await getGrantStore().remove(f.tenant); raw.prepare("DELETE FROM grants WHERE tenant=?").run(f.tenant); await reconcile(); proc.exit(); await reconcile();
  assert.deepEqual(financialFacts(file), expected); assert.equal(existsSync(path.join(f.home, "ledger-source-blocked.json")), true);
  assert.equal(hasLeaseForTest(f.tenant), true); assert.equal(f.releases.n, 0); assert.equal(existsSync(path.join(f.home, "grant.json")), false);
  const before = spawned.length; await getGrantStore().put(f.tenant, f.grant);
  raw.prepare("INSERT INTO grants VALUES(?,?,1001,2)").run(f.tenant, JSON.stringify({ smartAccount: f.account, owner: f.owner, chainId: 4663 }));
  await reconcile(); assert.equal(spawned.length, before); assert.deepEqual(financialFacts(file), expected);
  await remove(f);
});

it("an unconfirmed final copy retains its lease and original IDs until a healthy retry confirms the rows", async () => {
  const f = await fixture(); await sourceBook(f); setTenantLeaseForTest(f.tenant, f.lease); await reconcile();
  const proc = spawned.at(-1)!, file = path.join(f.home, "merrymen.db"), local = new DatabaseSync(file);
  local.prepare("INSERT INTO events(id,agent_id,message,created_at) VALUES(100,?,'unmirrored final event',1100)").run(f.account); local.close();
  const expected = financialFacts(file);
  const failEventCopy = (db: Db): Db => ({ exec: sql => db.exec(sql), tx: fn => db.tx(tx => fn(failEventCopy(tx))), prepare(sql) {
    const stmt = db.prepare(sql);
    return { ...stmt, async run(...args) {
      if (/INSERT INTO events/.test(sql)) throw new Error("disposable final copy failure");
      return stmt.run(...args);
    } };
  } });
  const unavailable = failEventCopy(shared);
  setRetirementMemoryStoreForTest({ shared: unavailable, dek, dialect: "sqlite" });
  await getGrantStore().remove(f.tenant); raw.prepare("DELETE FROM grants WHERE tenant=?").run(f.tenant); await reconcile(); proc.exit(); await reconcile();
  assert.equal(hasLeaseForTest(f.tenant), true); assert.equal(f.releases.n, 0); assert.deepEqual(financialFacts(file), expected);
  assert.equal(raw.prepare("SELECT 1 FROM events WHERE agent_id=? AND created_at=1100").get(f.account), undefined);
  setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" }); await reconcile();
  assert.equal(raw.prepare("SELECT message FROM events WHERE agent_id=? AND created_at=1100").get(f.account)!.message, "unmirrored final event");
  assert.equal(hasLeaseForTest(f.tenant), false); assert.equal(f.releases.n, 1); assert.deepEqual(financialFacts(file), expected);
});

it("a final source larger than one batch retains its recovery lease until every row is copied", async () => {
  const f = await fixture(); await sourceBook(f); setTenantLeaseForTest(f.tenant, f.lease); await reconcile();
  const proc = spawned.at(-1)!, file = path.join(f.home, "merrymen.db"), local = new DatabaseSync(file);
  local.exec("BEGIN"); const insert = local.prepare("INSERT INTO events(id,agent_id,message,created_at) VALUES(?,?,'final backlog',?)");
  for (let id = 100; id <= 700; id++) insert.run(id, f.account, 1000 + id); local.exec("COMMIT"); local.close();
  const expected = financialFacts(file);
  await getGrantStore().remove(f.tenant); raw.prepare("DELETE FROM grants WHERE tenant=?").run(f.tenant); await reconcile(); proc.exit(); await reconcile();
  assert.equal(Number(raw.prepare("SELECT last_id FROM mirror_state WHERE tenant=? AND table_name='events'").get(f.tenant)!.last_id), 599);
  assert.equal(hasLeaseForTest(f.tenant), true); assert.equal(f.releases.n, 0); assert.deepEqual(financialFacts(file), expected);
  await reconcile();
  assert.equal(Number(raw.prepare("SELECT last_id FROM mirror_state WHERE tenant=? AND table_name='events'").get(f.tenant)!.last_id), 700);
  assert.equal(Number(raw.prepare("SELECT count(*) AS n FROM events WHERE agent_id=?").get(f.account)!.n), 602);
  assert.equal(hasLeaseForTest(f.tenant), false); assert.equal(f.releases.n, 1); assert.deepEqual(financialFacts(file), expected);
});

it("a failed persistent root proof writes no cached key, child book or partial restore", async () => {
  const f = await fixture(); setTenantLeaseForTest(f.tenant, f.lease); const before = spawned.length;
  let paperCalls = 0; setPaperRestoreForTest(async () => { paperCalls++; return { ok: true, line: null }; });
  setPersistentHomeVerifierForTest(() => { throw new Error("disposable volume proof failure"); });
  try {
    await assert.rejects(reconcile(), /disposable volume proof failure/);
    assert.equal(spawned.length, before); assert.equal(paperCalls, 0);
    assert.equal(existsSync(path.join(f.home, "grant.json")), false); assert.equal(existsSync(path.join(f.home, "merrymen.db")), false);
  } finally {
    setPersistentHomeVerifierForTest(() => volume); setPaperRestoreForTest(async () => ({ ok: true, line: null })); await remove(f);
  }
});
