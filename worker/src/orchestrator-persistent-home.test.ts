/** Real SQLite books through the persistent cold-start and stopped-writer cleanup gates. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";
import { DEPLOY_GUARD_IMAGE } from "./deploy-guard-checks";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { captureLedgerImport, LEDGER_IMPORT_PENDING_FILE, registerLedgerSource, restoreLedgerImport, stageLedgerImport } from "./ledger-import";
import { ensurePersonalMemorySchema, publishPersonalMemory } from "./personal-memory-ferry";
import {
  adoptPopulatedPersistentHome, controlAdoptedPersistentHomeHalt, PERSISTENT_HOME_MANIFEST, PERSISTENT_HOME_PREADOPTION,
  type PersistentHomeIdentity,
} from "./persistent-home";
import type { TenantLease } from "./tenant-lease";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-persistent-reconcile-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
const {
  childHome, fleetHaltFile, hasLeaseForTest, honourFleetHalt, reconcile, setPaperRestoreForTest, setPersistentHomeVerifierForTest,
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
  const sharedFacts = () => Object.fromEntries((raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'fleet_recovery_health' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) =>
    [name, raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY 1`).all()]));
  const expectedShared = sharedFacts(), expectedGrant = await getGrantStore().get(f.tenant), checkedAfter = Math.floor(Date.now() / 1000);
  assert.equal(existsSync(f.home), false);
  let paperCalls = 0; setPaperRestoreForTest(async () => { paperCalls++; return { ok: true, line: null }; });
  setPersistentHomeVerifierForTest(() => { throw new Error("disposable volume proof failure"); });
  try {
    await reconcile();
    const report = raw.prepare("SELECT tenant,smart_account,chain_id,held,cause,since_at,checked_at FROM fleet_recovery_health WHERE tenant=?").get(f.tenant)!;
    assert.deepEqual({ tenant: report.tenant, smartAccount: report.smart_account, chainId: report.chain_id, held: report.held, cause: report.cause },
      { tenant: f.tenant, smartAccount: f.account, chainId: 4663, held: 1, cause: "persistent-source" });
    assert.equal(report.since_at, report.checked_at);
    assert.ok(Number(report.checked_at) >= checkedAfter && Number(report.checked_at) <= Math.floor(Date.now() / 1000));
    await reconcile();
    assert.equal(raw.prepare("SELECT since_at FROM fleet_recovery_health WHERE tenant=?").get(f.tenant)!.since_at, report.since_at);
    assert.equal(spawned.length, before); assert.equal(paperCalls, 0);
    assert.equal(existsSync(f.home), false);
    assert.equal(existsSync(path.join(f.home, "grant.json")), false); assert.equal(existsSync(path.join(f.home, "merrymen.db")), false);
    assert.equal(existsSync(path.join(f.home, "recovery-command-barrier.json")), false);
    assert.deepEqual(await getGrantStore().get(f.tenant), expectedGrant); assert.deepEqual(sharedFacts(), expectedShared);
    assert.equal(hasLeaseForTest(f.tenant), true); assert.equal(f.releases.n, 0);
  } finally {
    setPersistentHomeVerifierForTest(() => volume); setPaperRestoreForTest(async () => ({ ok: true, line: null })); await remove(f);
  }
});

it("an adopted fleet root spawns nothing until its reviewed release, and a hand-made FLEET_HALT afterwards still stands every child down", async () => {
  const f = await fixture(); setTenantLeaseForTest(f.tenant, f.lease);
  // The incident's shape on this fleet root: tenant homes from the tests
  // above, an operator's hand-made halt, and no manifest.
  const original = "operator incident halt\n", halt = fleetHaltFile(), token = "reviewed-adoption";
  writeFileSync(halt, original, { mode: 0o600 });
  const major = ((rootStat.dev >> 8n) & 0xfffn) | ((rootStat.dev >> 32n) & 0xfffff000n), minor = (rootStat.dev & 0xffn) | ((rootStat.dev >> 12n) & 0xffffff00n);
  const options = { readMountInfo: () => `40 20 ${major}:${minor} / ${fleet} rw,relatime - ext4 /dev/volume rw\n` };
  const adopt = { MERRYMEN_PERSISTENT_HOME_REQUIRED: "1", MERRYMEN_HOME: fleet, RAILWAY_VOLUME_MOUNT_PATH: fleet, MERRYMEN_HOME_VOLUME_ID: volume.id,
    MERRYMEN_INITIAL_HANDOVER: token, MERRYMEN_ADOPT_HOME_HALT_SHA256: createHash("sha256").update(original).digest("hex") };
  const release = { ...adopt, MERRYMEN_RELEASE_HOME_HALT: token, MERRYMEN_FLEET_ROLLOUT: `${f.tenant}:trade` };
  const before = spawned.length;
  try {
    assert.equal(adoptPopulatedPersistentHome(adopt, options)!.handoverState, "held");
    await reconcile(); assert.equal(spawned.length, before, "the canonical halt holds like the original");
    assert.equal(controlAdoptedPersistentHomeHalt({ ...release, MERRYMEN_FLEET_ROLLOUT: "none" }, options)!.action, "withheld");
    await reconcile(); assert.equal(spawned.length, before);
    assert.equal(controlAdoptedPersistentHomeHalt(release, options)!.action, "released");
    await reconcile(); assert.equal(spawned.length, before + 1);
    const proc = spawned.at(-1)!;
    writeFileSync(halt, "hand-made stop\n", { mode: 0o600 });
    // The next start, with the release variable still set, leaves it alone.
    assert.equal(controlAdoptedPersistentHomeHalt(release, options)!.action, "already-released");
    await honourFleetHalt();
    assert.deepEqual(proc.signals, ["SIGTERM"]); assert.equal(hasLeaseForTest(f.tenant), false); assert.equal(f.releases.n, 1);
    assert.equal(readFileSync(halt, "utf8"), "hand-made stop\n");
    proc.exit();
  } finally {
    for (const name of ["FLEET_HALT", PERSISTENT_HOME_MANIFEST, PERSISTENT_HOME_PREADOPTION]) rmSync(path.join(fleet, name), { force: true });
    await remove(f);
  }
});

it("startup adopts, then applies the env release or re-halt, then re-proves the home, all before any lease, child or writer", () => {
  const source = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  const run = source.slice(source.indexOf("export async function runOrchestrator("));
  // B1's boot-time refusal of a malformed rollout comes first of all.
  const order = ["fleetRollout(process.env)", "await runRecoveryReportOnly(); return;", "adoptPopulatedPersistentHome()", "controlAdoptedPersistentHomeHalt()",
    "preparePersistentHomeForHandover()", "setTenantLeaseLossHandler(", "await runAccountingDiagnosisIfAsked()", "void orderFerryLoop()", "await reconcile()"];
  const at = order.map(step => run.indexOf(step));
  order.forEach((step, k) => assert.ok(at[k]! > 0 && (k === 0 || at[k - 1]! < at[k]!), `${step} out of order`));
  assert.equal(run.split("adoptPopulatedPersistentHome(").length, 2, "called once");
  assert.equal(run.split("controlAdoptedPersistentHomeHalt(").length, 2, "called once");
});

/**
 * The real entry point, in its own process: runOrchestrator() is what the
 * container runs, and process.exit is what is being tested. Deliberately NOT
 * process.env — this file pointed MERRYMEN_HOME at its in-process fleet, and
 * no DATABASE_URL from a developer's shell may reach a supervisor started here.
 * Started directly, NOT through container-start.sh: what is under test is the
 * check that holds however the process was started. Correctly configured
 * apart from what each test changes.
 *
 * That includes MERRYMEN_FLEET_ROLLOUT, as `none`: once the orchestrator
 * reads its rollout scope at boot, a Railway-hosted one without the variable
 * refuses to start, which would answer every test here before the check under
 * test is reached. `none` admits nobody, and it is not `all`, so the one-shot
 * refusal below still holds while a one-shot is set.
 */
const FLEET_SERVICE = "227ff49a-1111-4222-8333-444455556666";
function hostedOrchestrator(home: string, extra: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", "worker/src/orchestrator.ts"], {
    cwd: path.join(import.meta.dirname, "..", ".."), encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: path.dirname(home), MERRYMEN_HOSTED: "1", MERRYMEN_HOME: home, RAILWAY_VOLUME_MOUNT_PATH: home,
      RAILWAY_ENVIRONMENT_ID: "e1e1e1e1-1111-4222-8333-444455556666", RAILWAY_SERVICE_ID: FLEET_SERVICE,
      MERRYMEN_FLEET_SERVICE_ID: FLEET_SERVICE, MERRYMEN_IMAGE: DEPLOY_GUARD_IMAGE, MERRYMEN_FLEET_ROLLOUT: "none", ...extra },
  });
}
const refusals = (stdout: string) => stdout.split("\n").filter((l) => l.startsWith("[orchestrator] refusing to start — "));

it("a Railway-hosted orchestrator without the persistent-home opt-in exits 78 before it touches its home", () => {
  for (const required of [undefined, "0", ""]) {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-hosted-ephemeral-"))), home = path.join(dir, "home");
    mkdirSync(home, { mode: 0o700 });
    try {
      // The report-only entry is behind the same gate: it must not get first word.
      const r = hostedOrchestrator(home, { MERRYMEN_FLEET_RECOVERY_REPORT_ONLY: "1",
        ...(required === undefined ? {} : { MERRYMEN_PERSISTENT_HOME_REQUIRED: required }) });
      assert.equal(r.status, 78, `${JSON.stringify(required)}: ${r.stdout}${r.stderr}`);
      assert.equal(refusals(r.stdout).length, 1, r.stdout);
      assert.match(r.stdout, /^\[orchestrator\] refusing to start — MERRYMEN_PERSISTENT_HOME_REQUIRED is not 1 — a fleet role runs only on a home proven to be the mounted volume/m);
      assert.doesNotMatch(r.stdout, /\[orchestrator\] starting/);
      assert.deepEqual(readdirSync(home), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

it("without the start script, a hosted orchestrator on the wrong service, or with a one-shot set mid-rollout, still exits 78", () => {
  // A Start Command on the service, or node run by hand, never passes through
  // container-start.sh and its guard; runOrchestrator() holds the same line.
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-hosted-unguarded-"))), home = path.join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  const secret = `apply-${"7".repeat(40)}`;
  try {
    const r = hostedOrchestrator(home, { MERRYMEN_PERSISTENT_HOME_REQUIRED: "1", MERRYMEN_FLEET_SERVICE_ID: "b72f7ad9-1111-4222-8333-444455556666",
      MERRYMEN_REPAIR_HWM: secret, MERRYMEN_FLEET_ROLLOUT: "none" });
    assert.equal(r.status, 78, `${r.stdout}${r.stderr}`);
    const lines = refusals(r.stdout);
    assert.equal(lines.length, 2, r.stdout);
    assert.match(lines[0]!, /refusing to start — this is not the fleet's service/);
    assert.match(lines[1]!, /refusing to start — one-shot operator variables are set \(MERRYMEN_REPAIR_HWM\) while MERRYMEN_FLEET_ROLLOUT is not all/);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(secret), "a one-shot value reached the log");
    assert.doesNotMatch(r.stdout, /\[orchestrator\] starting/);
    assert.deepEqual(readdirSync(home), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("with the opt-in, a hosted orchestrator goes on to the real volume proof, which still decides", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-hosted-persistent-"))), home = path.join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  try {
    // No provider volume UUID: past the gate, persistent-home.ts refuses — the
    // gate only ever adds a refusal, it never stands in for the proof.
    const r = hostedOrchestrator(home, { MERRYMEN_PERSISTENT_HOME_REQUIRED: "1" });
    assert.notEqual(r.status, 0);
    assert.notEqual(r.status, 78, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /refusing to start/);
    assert.match(r.stderr, /Persistent home refused: an explicit provider volume UUID is required/);
    assert.deepEqual(readdirSync(home), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
