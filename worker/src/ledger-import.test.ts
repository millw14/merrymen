/** Actual original SQLite books, isolated shared store, and crash/replay boundaries. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { assertLedgerSourceContinuity } from "./ledger-safeguard";
import { openSecret } from "./store-crypto";
import {
  captureLedgerImport, stageLedgerImport, restoreLedgerImport, registerLedgerSource, invalidateLedgerImport,
  invalidateLedgerImportsUnlessListed, verifyLedgerImport, verifyRestoredLedgerImport, readLedgerGapBinding, LEDGER_IMPORT_PENDING_FILE, type LedgerImportVolume,
} from "./ledger-import";
import type { TenantLease } from "./tenant-lease";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-original-import-")));
const handles: DatabaseSync[] = [];
after(() => { for (const raw of handles) raw.close(); rmSync(root, { recursive: true, force: true }); });
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const dek = Buffer.alloc(32, 102);
const source = { deploymentId: "original-deployment", gitCommit: "1".repeat(40), orchestratorPid: 999, orchestratorStart: "original-start", quiescent: true, singleReplicaConfirmed: true };
let fixtureId = 0;
async function fixture(empty = false) {
  const id = ++fixtureId, tenant = addr(0xd000 + id), account = addr(0xe000 + id), owner = addr(0xf000 + id);
  const dir = path.join(root, String(id)), sourceHome = path.join(dir, "original"), mountPath = path.join(dir, "volume"), homeRoot = path.join(mountPath, "fleet");
  mkdirSync(sourceHome, { recursive: true }); mkdirSync(homeRoot, { recursive: true });
  const st = lstatSync(mountPath, { bigint: true });
  const volume: LedgerImportVolume = { id: `vol_fixture_${id}`, mountPath, homeRoot, device: String(st.dev), inode: String(st.ino) };
  const home = path.join(homeRoot, "children", tenant);
  const raw = new DatabaseSync(path.join(sourceHome, "merrymen.db")), sharedRaw = new DatabaseSync(":memory:"); handles.push(raw, sharedRaw);
  const local = wrapSqlite(raw), shared = wrapSqlite(sharedRaw);
  await applyLedgerSchema(local); await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL); await shared.exec(PAPER_CHECKPOINT_SCHEMA);
  sharedRaw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY,grant_json TEXT NOT NULL,updated_at INTEGER NOT NULL,row_version INTEGER NOT NULL)");
  const grant = JSON.stringify({ smartAccount: account, owner, chainId: 4663 });
  sharedRaw.prepare("INSERT INTO grants VALUES(?,?,1000,10)").run(tenant, grant);
  let healthy = true;
  const lease: TenantLease = { tenant: tenant as `0x${string}`, backend: "postgres", healthy: () => healthy, async release() { healthy = false; } };
  if (!empty) {
    raw.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,status,epoch,hwm_usdg,hwm_withdrawn_usdg,accrued_fee_usdg,mode) VALUES(?,?,?,4663,'{}',1,9999999999,'armed',3,120,4,2,'live')").run(account, owner, addr(7));
    raw.prepare("INSERT INTO events(id,agent_id,level,message,created_at) VALUES(40,?,'ok','original event 🦊',1040)").run(account);
    raw.prepare("INSERT INTO events(id,agent_id,message,created_at) VALUES(99,?,'purged allocation',1099)").run(account); raw.exec("DELETE FROM events WHERE id=99");
    raw.prepare("INSERT INTO posts(id,agent_id,decision_id,body,created_at) VALUES(21,?,'decision-a','original post',1021)").run(account);
    raw.prepare("INSERT INTO trades(id,agent_id,kind,target,amount_usdg,status,created_at,epoch,user_op_hash,user_op_nonce,fill_qty_raw,gas_wei,budget_settled_at) VALUES(37,?,'swap','fixture',5,'landed',1037,3,'0xhash',?,?,?,1040)")
      .run(account, (2n ** 256n - 1n).toString(), "123456789012345678901234567890", "900719925474099312345");
    raw.prepare("INSERT INTO equity(id,agent_id,eth_wei,cash_usdg,vault_usdg,positions_usdg,equity_usdg,at,epoch,mode) VALUES(55,?,'0',90,0,10,100,1055,3,'live')").run(account);
    raw.prepare("INSERT INTO flows(id,agent_id,direction,amount_usdg,source,at,epoch) VALUES(12,?,'in',100,'epoch-carry',1012,3)").run(account);
    raw.prepare("INSERT INTO fee_accruals(id,agent_id,profit_usdg,fee_usdg,hwm_before_usdg,hwm_after_usdg,at,epoch) VALUES(8,?,10,1,110,120,1008,3)").run(account);
    const payload = '{"original":"bytes"}', prev = "0".repeat(64), digest = createHash("sha256").update(prev + payload).digest("hex");
    raw.prepare("INSERT INTO journal(seq,agent_id,epoch,kind,payload_json,prev_hash,hash,at) VALUES(1,?,3,'mark',?,?,?,1055)").run(account, payload, prev, digest);
    raw.prepare("INSERT INTO positions(agent_id,symbol,token,raw_balance,ui_multiplier,price_usd,value_usdg,updated_at) VALUES(?,'COIN',?,'10','1',1,10,1000)").run(account, addr(8));
    raw.prepare("INSERT INTO cost_basis VALUES(?,'live','COIN','10','20',1000)").run(account);
    raw.prepare("INSERT INTO position_floors VALUES(?,'live','COIN',1500,'fixture','original stop',1000)").run(account);
    raw.prepare("INSERT INTO trench_positions VALUES(?,'live','COIN',50000,1000)").run(account);
    raw.prepare("INSERT INTO decisions(id,agent_id,source,reason,at) VALUES('decision-a',?,'chat','original decision',1000)").run(account);
    raw.prepare("INSERT INTO risk_periods VALUES('risk-original',?,1000,100,120,4,'owner reviewed')").run(account);
    raw.prepare("INSERT INTO energy_days(agent_id,day,reviews,entries,entries_refunded) VALUES(?,'2026-10-04',4,3,1)").run(account);
    raw.prepare("INSERT INTO brain_trigger_state VALUES(?,'{\"reviewed\":true}',1000)").run(account);
    raw.prepare("INSERT INTO agent_commands(id,agent_id,kind,created_at,claimed_at,done_at,result,args) VALUES('claimed-original',?,'selftest',1000,1001,1002,'done','{}')").run(account);
    raw.exec("INSERT INTO chat_turns(chat_id,role,content,at) VALUES(42,'user','EXCLUDED private DM',1000); CREATE TABLE secret_tokens(token TEXT); INSERT INTO secret_tokens VALUES('EXCLUDED credential')");
    const report = await mirrorTenant({ tenant, child: local, shared }); assert.equal(report.failed, undefined);
  }
  const capture = () => captureLedgerImport({ tenant, smartAccount: account, chainId: 4663, home: sourceHome, shared, dek, lease, source, assertSource() {}, dialect: "sqlite" });
  const stage = async () => { const artifact = await capture(); await stageLedgerImport({ artifact, targetVolumeId: volume.id, shared, dek, lease, assertSource() {}, dialect: "sqlite" }); return artifact; };
  const options = { tenant, smartAccount: account, chainId: 4663, home, volume, shared, dek, lease, dialect: "sqlite" as const };
  return { ...options, sourceHome, raw, local, sharedRaw, capture, stage, options, setHealthy: (v: boolean) => { healthy = v; } };
}

it("imports original IDs/stamps, full financial rows and allocation high-water; subsequent real mirror cannot rewind or duplicate", async () => {
  const f = await fixture(), artifact = await f.stage();
  const verified = await verifyLedgerImport({ artifact, home: f.sourceHome, shared: f.shared, dek, lease: f.lease, assertSource() {}, dialect: "sqlite" });
  assert.equal(verified.tables, 21); assert.ok(verified.rows > 6);
  const clear = openSecret(artifact.sealed, dek); assert.ok(!clear.includes("EXCLUDED private DM")); assert.ok(!clear.includes("EXCLUDED credential"));
  assert.equal(await restoreLedgerImport(f.options), "restored");
  assert.deepEqual(await verifyRestoredLedgerImport({ ...f.options, artifact, assertSource() {} }), verified);
  const importedRaw = new DatabaseSync(path.join(f.home, "merrymen.db")); handles.push(importedRaw); const imported = wrapSqlite(importedRaw);
  for (const table of ["agents", "events", "posts", "trades", "equity", "flows", "fee_accruals", "journal", "positions", "cost_basis", "decisions", "risk_periods", "energy_days", "position_floors", "trench_positions", "brain_trigger_state", "agent_commands"]) {
    assert.deepEqual(importedRaw.prepare(`SELECT * FROM ${table}`).all(), f.raw.prepare(`SELECT * FROM ${table}`).all(), table);
  }
  assert.equal(importedRaw.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()!.seq, 99);
  assert.equal(importedRaw.prepare("SELECT count(*) AS n FROM chat_turns").get()!.n, 0);
  assert.equal(importedRaw.prepare("SELECT name FROM sqlite_master WHERE name='secret_tokens'").get(), undefined);
  await assertLedgerSourceContinuity(imported, f.shared, f.tenant);
  const before = f.sharedRaw.prepare("SELECT count(*) AS n FROM trades").get()!.n;
  for (let i = 0; i < 2; i++) { const report = await mirrorTenant({ tenant: f.tenant, child: imported, shared: f.shared }); assert.equal(report.restarted, undefined); assert.equal(report.failed, undefined); }
  assert.equal(f.sharedRaw.prepare("SELECT count(*) AS n FROM trades").get()!.n, before);
  assert.equal(f.sharedRaw.prepare("SELECT raw_balance FROM positions WHERE agent_id=?").get(f.smartAccount)!.raw_balance, "10");
  const inserted = importedRaw.prepare("INSERT INTO events(agent_id,message) VALUES(?,'new continuation')").run(f.smartAccount); assert.equal(inserted.lastInsertRowid, 100);
  const receipt = f.sharedRaw.prepare("SELECT state,sealed,bytes FROM tenant_ledger_import WHERE tenant=?").get(f.tenant)!;
  assert.equal(receipt.state, "consumed"); assert.equal(receipt.sealed, null); assert.equal(receipt.bytes, 0);
  assert.equal(existsSync(path.join(f.home, LEDGER_IMPORT_PENDING_FILE)), false);
  assert.equal(await restoreLedgerImport(f.options), "present", "advanced persistent book is never overwritten by original import");
  await assert.rejects(stageLedgerImport({ artifact, targetVolumeId: f.volume.id, shared: f.shared, dek, lease: f.lease, assertSource() {}, dialect: "sqlite" }));
});

it("lost commit acknowledgement resumes the same published generation without replaying its rows", async () => {
  const f = await fixture(); await f.stage(); let lose = true;
  const uncertain: Db = { prepare: sql => f.shared.prepare(sql), exec: sql => f.shared.exec(sql), async tx(fn) { const result = await f.shared.tx(fn); if (lose) { lose = false; throw new Error("lost COMMIT acknowledgement"); } return result; } };
  await assert.rejects(restoreLedgerImport({ ...f.options, shared: uncertain }));
  assert.equal(f.sharedRaw.prepare("SELECT state FROM tenant_ledger_import").get()!.state, "consumed");
  assert.ok(existsSync(path.join(f.home, LEDGER_IMPORT_PENDING_FILE)));
  assert.equal(await restoreLedgerImport(f.options), "resumed");
  const raw = new DatabaseSync(path.join(f.home, "merrymen.db")); handles.push(raw); assert.equal(raw.prepare("SELECT count(*) AS n FROM trades").get()!.n, 1);
});

it("failure after no-clobber publication rolls back the consume and completes only that exact pending book", async () => {
  const f = await fixture(); await f.stage();
  const wrap = (db: Db): Db => ({ exec: sql => db.exec(sql), prepare(sql) { const stmt = db.prepare(sql); return { ...stmt, async run(...args) { if (sql.startsWith("UPDATE tenant_ledger_import SET state = 'consumed'")) throw new Error("failed consume"); return stmt.run(...args); } }; }, tx: fn => db.tx(tx => fn(wrap(tx))) });
  await assert.rejects(restoreLedgerImport({ ...f.options, shared: wrap(f.shared) }));
  assert.equal(f.sharedRaw.prepare("SELECT state FROM tenant_ledger_import").get()!.state, "available");
  assert.ok(existsSync(path.join(f.home, "merrymen.db"))); assert.ok(existsSync(path.join(f.home, LEDGER_IMPORT_PENDING_FILE)));
  const before = lstatSync(path.join(f.home, "merrymen.db")); assert.equal(await restoreLedgerImport(f.options), "restored");
  assert.equal(lstatSync(path.join(f.home, "merrymen.db")).ino, before.ino);
});

it("consumed receipt refuses restoration after persistent-volume book loss, even when all cursors are zero", async () => {
  const f = await fixture(true); assert.equal(existsSync(path.join(f.home, "merrymen.db")), false);
  await registerLedgerSource(f.options); assert.equal(await restoreLedgerImport(f.options), "present"); rmSync(path.join(f.home, "merrymen.db"));
  await assert.rejects(restoreLedgerImport(f.options));
  assert.equal(existsSync(path.join(f.home, "merrymen.db")), false);
});

it("a consumed zero-cursor original cannot be replaced in place after an unmirrored trade; missing incarnation is never reminted", async () => {
  const f = await fixture(true); await registerLedgerSource(f.options);
  const file = path.join(f.home, "merrymen.db"), inode = lstatSync(file).ino;
  const raw = new DatabaseSync(file);
  raw.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,hwm_usdg) VALUES(?,?,?,4663,'{}',1,9999999999,120)")
    .run(f.smartAccount, addr(0xf000 + fixtureId), addr(7));
  raw.prepare("INSERT INTO trades(id,agent_id,kind,target,amount_usdg,status,created_at) VALUES(37,?,'swap','unmirrored-original',5,'landed',1037)").run(f.smartAccount);
  raw.close(); assert.equal(await restoreLedgerImport(f.options), "present");
  const identity = f.sharedRaw.prepare("SELECT source_identity FROM tenant_ledger_import").get()!.source_identity;
  assert.equal(f.sharedRaw.prepare("SELECT count(*) AS n FROM mirror_state").get()!.n, 0);
  truncateSync(file, 0); const replacement = new DatabaseSync(file); await applyLedgerSchema(wrapSqlite(replacement)); replacement.close();
  assert.equal(lstatSync(file).ino, inode, "this actually reproduces in-place loss on the original inode");
  await assert.rejects(restoreLedgerImport(f.options)); await assert.rejects(registerLedgerSource(f.options));
  assert.equal(f.sharedRaw.prepare("SELECT source_identity FROM tenant_ledger_import").get()!.source_identity, identity);
  const refused = new DatabaseSync(file); assert.equal(refused.prepare("SELECT name FROM sqlite_master WHERE name='ledger_source_identity'").get(), undefined); refused.close();
  await invalidateLedgerImport(f.tenant, f.shared); await assert.rejects(registerLedgerSource(f.options));
});

it("new registration requires empty original accounting and never permits an old positive cursor", async () => {
  const f = await fixture(true); mkdirSync(f.home, { recursive: true }); const raw = new DatabaseSync(path.join(f.home, "merrymen.db")); await applyLedgerSchema(wrapSqlite(raw)); raw.close();
  f.sharedRaw.prepare("INSERT INTO mirror_state(tenant,table_name,last_id,last_stamp,updated_at) VALUES(?,'events',40,1040,1040)").run(f.tenant);
  await assert.rejects(registerLedgerSource(f.options)); assert.equal(f.sharedRaw.prepare("SELECT count(*) AS n FROM tenant_ledger_import").get()!.n, 0);
});

it("historical gap binding is read-only, covers unchanged-cursor accounting corrections, and never proves an original source", async () => {
  const f = await fixture(), options = { ...f.options, assertSource() {} };
  const before = f.sharedRaw.prepare("SELECT * FROM mirror_state ORDER BY table_name").all();
  const first = await readLedgerGapBinding(options);
  assert.equal(first.grant.smartAccount, f.smartAccount); assert.equal(first.grant.chainId, 4663);
  assert.deepEqual(first.marks.map(row => ({ ...(row as Record<string, unknown>) })), before.map(({ tenant: _tenant, ...row }) => row));
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.equal(f.sharedRaw.prepare("SELECT name FROM sqlite_master WHERE name='tenant_ledger_import'").get(), undefined);
  f.sharedRaw.exec("UPDATE trades SET budget_settled_at=1041,status='reverted',gas_wei='999'");
  const changed = await readLedgerGapBinding(options);
  assert.notEqual(changed.mutableDigest, first.mutableDigest); assert.notEqual(changed.digest, first.digest);
  assert.deepEqual(f.sharedRaw.prepare("SELECT * FROM mirror_state ORDER BY table_name").all(), before);
  let checks = 0;
  await assert.rejects(readLedgerGapBinding({ ...options, assertSource() { if (++checks === 2) f.sharedRaw.exec("UPDATE cost_basis SET cost_usdg='21'"); } }));
  await assert.rejects(readLedgerGapBinding({ ...options, smartAccount: addr(1) }));
  f.setHealthy(false); await assert.rejects(readLedgerGapBinding(options));
  assert.equal(f.sharedRaw.prepare("SELECT name FROM sqlite_master WHERE name='tenant_ledger_import'").get(), undefined);
});

it("newer authority incarnation or changed shared accounting/settlement refuses staged import without publishing a book", async () => {
  for (const mutation of ["UPDATE grants SET row_version=row_version+1", "UPDATE cost_basis SET cost_usdg='21'", "UPDATE trades SET budget_settled_at=1041,status='reverted',gas_wei='999'", "UPDATE fee_accruals SET fee_usdg=2", "UPDATE equity SET cash_usdg=91,equity_usdg=101"]) {
    const f = await fixture(); await f.stage(); f.sharedRaw.exec(mutation);
    await assert.rejects(restoreLedgerImport(f.options)); assert.equal(existsSync(path.join(f.home, "merrymen.db")), false);
    assert.equal(f.sharedRaw.prepare("SELECT state FROM tenant_ledger_import").get()!.state, "available");
  }
});

it("wrong tenant/account/chain/cipher or an unverified/different mounted home is refused", async () => {
  const f = await fixture(); await f.stage();
  for (const options of [
    { ...f.options, smartAccount: addr(2) }, { ...f.options, chainId: 46630 }, { ...f.options, dek: Buffer.alloc(32, 9) },
    { ...f.options, volume: { ...f.volume, id: "vol_wrong_identity" } }, { ...f.options, volume: { ...f.volume, device: "0" } },
    { ...f.options, home: path.join(root, "ephemeral-fallback") },
  ]) await assert.rejects(restoreLedgerImport(options));
  assert.equal(existsSync(path.join(f.home, "merrymen.db")), false);
  f.setHealthy(false); await assert.rejects(restoreLedgerImport(f.options));
});

it("never overwrites an existing financial book or follows a destination symlink", async () => {
  const f = await fixture(); await f.stage(); mkdirSync(f.home, { recursive: true });
  const file = path.join(f.home, "merrymen.db"); writeFileSync(file, "original existing bytes");
  await assert.rejects(restoreLedgerImport(f.options)); assert.equal(readFileSync(file, "utf8"), "original existing bytes");
  rmSync(file); symlinkSync(path.join(f.sourceHome, "merrymen.db"), file);
  await assert.rejects(restoreLedgerImport(f.options)); assert.ok(lstatSync(file).isSymbolicLink());
});

it("consumed books reject a symlink or another account, while healthy grown books exceed portable export limits safely", async () => {
  const f = await fixture(true); await registerLedgerSource(f.options);
  const file = path.join(f.home, "merrymen.db"), preserved = file + ".preserved"; renameSync(file, preserved); symlinkSync(path.join(f.sourceHome, "merrymen.db"), file);
  await assert.rejects(restoreLedgerImport(f.options)); rmSync(file); renameSync(preserved, file);
  const raw = new DatabaseSync(file); await applyLedgerSchema(wrapSqlite(raw));
  raw.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at) VALUES(?,?,?,4663,'{}',1,9999999999)").run(f.smartAccount, addr(7), addr(8));
  raw.exec("BEGIN"); const insert = raw.prepare("INSERT INTO events(agent_id,message) VALUES(?,'healthy growth')");
  for (let i = 0; i < 250_001; i++) insert.run(f.smartAccount); raw.exec("COMMIT");
  raw.close(); const { chmodSync } = await import("node:fs"); chmodSync(file, 0o600);
  assert.equal(await restoreLedgerImport(f.options), "present");
  const foreign = new DatabaseSync(file); foreign.prepare("UPDATE events SET agent_id=? WHERE id=250001").run(addr(9)); foreign.close();
  await assert.rejects(restoreLedgerImport(f.options));
});

it("pending operations/commands or unsupported schema cannot be captured and silently truncated", async () => {
  for (const mutation of ["UPDATE trades SET status='submitted'", "UPDATE agent_commands SET done_at=NULL", "ALTER TABLE trades ADD COLUMN private_signature TEXT", "UPDATE flows SET tx_hash='0xABC',chain_id=NULL", "UPDATE sqlite_sequence SET seq=9007199254740992 WHERE name='events'"]) {
    const f = await fixture(); f.raw.exec(mutation); await assert.rejects(f.capture());
  }
});

it("deletion erases ciphertext and permanently fences its generation; stale cleanup cannot invalidate a later artifact", async () => {
  const f = await fixture(), artifact = await f.stage();
  const created = Number(f.sharedRaw.prepare("SELECT created_at_ms FROM tenant_ledger_import").get()!.created_at_ms);
  await invalidateLedgerImport(f.tenant, f.shared, { beforeMs: created - 1 });
  await invalidateLedgerImport(f.tenant, f.shared, { expectedGrant: { updatedAt: "1000", rowVersion: "9" } });
  assert.equal(f.sharedRaw.prepare("SELECT state FROM tenant_ledger_import").get()!.state, "available");
  await invalidateLedgerImportsUnlessListed(f.shared, new Set(), created - 1);
  assert.equal(f.sharedRaw.prepare("SELECT state FROM tenant_ledger_import").get()!.state, "available");
  await invalidateLedgerImportsUnlessListed(f.shared, new Set(), created);
  assert.equal(f.sharedRaw.prepare("SELECT state FROM tenant_ledger_import").get()!.state, "available", "stale roster cannot invalidate a current grant");
  await invalidateLedgerImport(f.tenant, f.shared, { beforeMs: created, expectedGrant: { updatedAt: "1000", rowVersion: "10" } });
  assert.equal(f.sharedRaw.prepare("SELECT sealed FROM tenant_ledger_import").get()!.sealed, null);
  assert.equal(f.sharedRaw.prepare("SELECT state FROM tenant_ledger_import_generations").get()!.state, "deleted");
  await assert.rejects(stageLedgerImport({ artifact, targetVolumeId: f.volume.id, shared: f.shared, dek, lease: f.lease, assertSource() {}, dialect: "sqlite" }));
  assert.equal(await restoreLedgerImport(f.options), "none");
});

it("explicit deletion reattaches only the actual retained original source and never permits a missing zero-cursor replacement", async () => {
  const f = await fixture(), artifact = await f.stage(); await restoreLedgerImport(f.options);
  await invalidateLedgerImport(f.tenant, f.shared); f.sharedRaw.exec("UPDATE grants SET row_version=11,updated_at=1001");
  assert.equal(await restoreLedgerImport(f.options), "none");
  const inode = lstatSync(path.join(f.home, "merrymen.db")).ino;
  await registerLedgerSource(f.options); assert.equal(await restoreLedgerImport(f.options), "present");
  assert.equal(lstatSync(path.join(f.home, "merrymen.db")).ino, inode);
  assert.equal(f.sharedRaw.prepare("SELECT state FROM tenant_ledger_import_generations WHERE generation=?").get(artifact.generation)!.state, "deleted");
  await assert.rejects(stageLedgerImport({ artifact, targetVolumeId: f.volume.id, shared: f.shared, dek, lease: f.lease, assertSource() {}, dialect: "sqlite" }));
  const empty = await fixture(true); await registerLedgerSource(empty.options); await invalidateLedgerImport(empty.tenant, empty.shared);
  rmSync(path.join(empty.home, "merrymen.db")); await assert.rejects(registerLedgerSource(empty.options));
  assert.equal(existsSync(path.join(empty.home, "merrymen.db")), false);
});
