/** Real SQLite books + real memory restore functions; no production connections. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { captureFleetMemory, sealMemoryBackup, writeMemoryBackupArtifact } from "./memory-safeguard";
import { inspectMemorySource } from "./memory-safeguard-cli";
import { ensurePersonalMemorySchema } from "./personal-memory-ferry";
import { ensureTgGroupsSchema, publishTgGroups } from "./tg-groups-ferry";
import { PERSISTENT_HOME_MANIFEST, preparePersistentHomeForHandover } from "./persistent-home";
import {
  HISTORICAL_GAP_PROOF_FILE, openFleetLedgerHandover, runLedgerHandoverCli, sealFleetLedgerHandover, writeLedgerHandoverArtifact,
  type LedgerHandoverDependencies,
} from "./ledger-handover-cli";

const TENANT = `0x${"41".repeat(20)}`, ACCOUNT = `0x${"52".repeat(20)}`, OWNER = `0x${"63".repeat(20)}`;
const VOLUME = "d6481580-14af-430c-af4a-f3540dfb833d", OP = "reviewed-ledger-handover";
const DEK = Buffer.alloc(32, 99), SOURCE_SHA = "1".repeat(40), TARGET_SHA = "2".repeat(40);
const SECRET = "EXCLUDED cached signing credential", PERSONAL = "Remember the owner's orchids", GROUP = "A private group line";

function scopedSqlite(db: Db): Db {
  const adapt = (sql: string) => sql.replaceAll("updated_at::text", "CAST(updated_at AS TEXT)")
    .replaceAll("xmin::text", "CAST(row_version AS TEXT)").replace(/ FOR (SHARE|UPDATE)$/, "");
  return { exec: sql => db.exec(sql), prepare: sql => db.prepare(sql.includes("pg_advisory_xact_lock") ? "SELECT ?" : adapt(sql)),
    tx: fn => db.tx(tx => fn(scopedSqlite(tx))) };
}
function procFixture(root: string, pid: number, start: string): void {
  const dir = path.join(root, String(pid)); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "cmdline"), "node\0--import\0tsx\0/app/worker/src/orchestrator.ts\0");
  writeFileSync(path.join(dir, "stat"), `${pid} (node) S ${Array(18).fill("0").join(" ")} ${start} 0`);
}
async function fixture(t: test.TestContext, emptyTenant = false) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-handover-cli-")));
  const sourceHome = path.join(dir, "source"), child = path.join(sourceHome, "children", TENANT), targetHome = path.join(dir, "target");
  mkdirSync(path.join(child, "soul"), { recursive: true }); mkdirSync(targetHome, { mode: 0o700 });
  writeFileSync(path.join(sourceHome, "FLEET_HALT"), "reviewed original source hold", { mode: 0o600 });
  writeFileSync(path.join(child, "soul", "OWNER.md"), PERSONAL, { mode: 0o600 });
  writeFileSync(path.join(child, "grant.json"), SECRET, { mode: 0o600 });
  writeFileSync(path.join(child, "settings.json"), SECRET, { mode: 0o600 });
  const raw = new DatabaseSync(path.join(child, "merrymen.db")), sharedRaw = new DatabaseSync(":memory:");
  t.after(() => { raw.close(); sharedRaw.close(); rmSync(dir, { recursive: true, force: true }); });
  const local = wrapSqlite(raw), shared = scopedSqlite(wrapSqlite(sharedRaw));
  await applyLedgerSchema(local); await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL); await shared.exec(PAPER_CHECKPOINT_SCHEMA);
  await ensurePersonalMemorySchema(shared, "sqlite"); await ensureTgGroupsSchema(shared, "sqlite");
  sharedRaw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY,grant_json TEXT,updated_at INTEGER,row_version INTEGER)");
  sharedRaw.prepare("INSERT INTO grants VALUES(?,?,25,1)").run(TENANT, JSON.stringify({ smartAccount: ACCOUNT, owner: OWNER, chainId: 4663, privateKey: SECRET }));
  if (emptyTenant) sharedRaw.prepare("INSERT INTO grants VALUES(?,?,25,1)").run(`0x${"74".repeat(20)}`,
    JSON.stringify({ smartAccount: `0x${"85".repeat(20)}`, owner: OWNER, chainId: 4663 }));
  raw.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,status,epoch,hwm_usdg,hwm_withdrawn_usdg,accrued_fee_usdg,mode) VALUES(?,?,?,4663,'{}',1,9999999999,'armed',3,120,4,2,'live')")
    .run(ACCOUNT, OWNER, `0x${"07".repeat(20)}`);
  raw.prepare("INSERT INTO events(id,agent_id,level,message,created_at) VALUES(41,?,'ok','original financial event',1041)").run(ACCOUNT);
  raw.prepare("INSERT INTO trades(id,agent_id,kind,target,amount_usdg,status,created_at,epoch,user_op_hash,user_op_nonce,fill_qty_raw,gas_wei,budget_settled_at) VALUES(37,?,'swap','fixture',5,'landed',1037,3,'0xhash','17','900719925474099312345','3',1040)").run(ACCOUNT);
  raw.prepare("INSERT INTO chat_turns(chat_id,role,content,at) VALUES(7,'user',?,12)").run(PERSONAL);
  raw.prepare("INSERT INTO chat_turns(chat_id,role,content,at) VALUES(-100,'user',?,13)").run(SECRET);
  raw.exec("CREATE TABLE signing_secrets(secret TEXT)"); raw.prepare("INSERT INTO signing_secrets VALUES(?)").run(SECRET);
  const groupText = JSON.stringify({ version: 1, rooms: { "-100": { chatId: -100, status: "approved", title: "garden",
    lines: [{ messageId: 1, fromId: 8, name: "A", text: GROUP, atMs: 1 }] } }, llm: { day: "2026-10-04", used: 4 }, nominations: { day: "2026-10-04", n: 2, entries: 1 } });
  writeFileSync(path.join(child, "tg-groups.json"), groupText, { mode: 0o600 });
  assert.equal((await mirrorTenant({ tenant: TENANT, child: local, shared })).failed, undefined);
  assert.equal(await publishTgGroups({ tenant: TENANT, home: child, shared, dek: DEK, seen: new Map(), log() {} }), "published");
  const procRoot = path.join(dir, "proc"), targetProc = path.join(dir, "target-proc");
  procFixture(procRoot, 41, "1234"); procFixture(targetProc, 42, "5678");
  const env: NodeJS.ProcessEnv = { MERRYMEN_HOME: sourceHome, RAILWAY_DEPLOYMENT_ID: "source-deployment", RAILWAY_GIT_COMMIT_SHA: SOURCE_SHA };
  const source = inspectMemorySource({ expectedDeployment: "source-deployment", expectedCommit: SOURCE_SHA, orchestratorPid: 41,
    home: sourceHome, quiescent: true, singleReplicaConfirmed: true }, env, procRoot);
  const memory = await captureFleetMemory({ childrenDir: path.join(sourceHome, "children"), shared, dek: DEK, source, assertSource() {} });
  const memoryFile = path.join(dir, "memory.sealed"), artifact = path.join(dir, "ledger.sealed");
  writeMemoryBackupArtifact(memoryFile, sealMemoryBackup(memory, DEK));
  let leasesReleased = 0, loseLease = false;
  const deps: LedgerHandoverDependencies = { env, procRoot, shared, dek: DEK, dialect: "sqlite", acquireLease: async tenant => {
    let active = true;
    return { tenant, backend: "postgres", healthy: () => active && !loseLease, async release() { if (active) leasesReleased++; active = false; } };
  } };
  const current = ["--expected-deployment", "source-deployment", "--expected-commit", SOURCE_SHA, "--orchestrator-pid", "41", "--quiescent", "--single-replica-confirmed"];
  const captureArgs = ["capture", ...current, "--memory-artifact", memoryFile, "--output", artifact, "--target-volume-id", VOLUME,
    "--target-mount-path", targetHome, "--target-commit", TARGET_SHA, "--operation-token", OP];
  const sourceMode = (mode: string) => runLedgerHandoverCli([mode, ...current, "--artifact", artifact], deps);
  const targetEnv: NodeJS.ProcessEnv = { MERRYMEN_HOME: targetHome, RAILWAY_DEPLOYMENT_ID: "target-deployment", RAILWAY_GIT_COMMIT_SHA: TARGET_SHA,
    MERRYMEN_PERSISTENT_HOME_REQUIRED: "1", MERRYMEN_HOME_VOLUME_ID: VOLUME, RAILWAY_VOLUME_MOUNT_PATH: targetHome, MERRYMEN_INITIAL_HANDOVER: OP };
  const st = (await import("node:fs")).lstatSync(targetHome, { bigint: true });
  const major = ((st.dev >> 8n) & 0xfffn) | ((st.dev >> 32n) & 0xfffff000n), minor = (st.dev & 0xffn) | ((st.dev >> 12n) & 0xffffff00n);
  const mountInfo = `40 20 ${major}:${minor} / ${targetHome} rw - ext4 /dev/volume rw\n`;
  const persistentOptions = { readMountInfo: () => mountInfo };
  preparePersistentHomeForHandover(targetEnv, persistentOptions);
  const targetDeps: LedgerHandoverDependencies = { ...deps, env: targetEnv, procRoot: targetProc, persistentOptions };
  const targetArgs = (mode: string) => [mode, "--expected-deployment", "target-deployment", "--expected-commit", TARGET_SHA, "--orchestrator-pid", "42",
    "--quiescent", "--single-replica-confirmed", "--artifact", artifact, "--expected-source-deployment", "source-deployment",
    "--expected-source-commit", SOURCE_SHA, "--source-orchestrator-pid", "41", "--source-orchestrator-start", "1234"];
  const targetMode = (mode: string) => runLedgerHandoverCli(targetArgs(mode), targetDeps);
  const capture = () => runLedgerHandoverCli(captureArgs, deps);
  const stage = async () => { await capture(); return sourceMode("stage"); };
  return { dir, sourceHome, targetHome, child, raw, sharedRaw, shared, deps, targetDeps, captureArgs, targetArgs, capture, sourceMode, stage, targetMode,
    artifact, memoryFile, groupText, targetChild: path.join(targetHome, "children", TENANT), getReleases: () => leasesReleased, loseLease: () => { loseLease = true; } };
}

test("capture, verify, stage, restore and explicit completion preserve original accounting and actual private memory", async t => {
  const f = await fixture(t);
  const captured = await f.capture();
  assert.equal(captured.operation, "captured-and-verified"); assert.equal(captured.books, 1);
  const sealed = readFileSync(f.artifact, "utf8");
  for (const secret of [SECRET, PERSONAL, GROUP, TENANT]) assert.equal(sealed.includes(secret), false);
  assert.equal(JSON.stringify(captured).includes(SECRET), false);
  const decoded = openFleetLedgerHandover(sealed, DEK);
  assert.equal(decoded.books.length, 1); assert.equal(decoded.memory.entries[0]!.personal!.dmTurns, 1);
  assert.equal((await f.sourceMode("verify")).operation, "verified");
  assert.equal(f.sharedRaw.prepare("SELECT name FROM sqlite_master WHERE name='tenant_ledger_import'").get(), undefined, "verify does not stage");
  await f.sourceMode("stage");
  assert.equal(f.sharedRaw.prepare("SELECT state FROM tenant_ledger_import").get()!.state, "available");
  assert.equal((await f.targetMode("restore")).operation, "restored-and-verified");
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), true, "restore is not release");
  const target = new DatabaseSync(path.join(f.targetChild, "merrymen.db"), { readOnly: true });
  try {
    assert.deepEqual(target.prepare("SELECT * FROM trades").all(), f.raw.prepare("SELECT * FROM trades").all());
    assert.deepEqual(target.prepare("SELECT * FROM agents").all(), f.raw.prepare("SELECT * FROM agents").all());
    assert.equal(target.prepare("SELECT content FROM chat_turns").get()!.content, PERSONAL);
    assert.equal(target.prepare("SELECT count(*) AS n FROM chat_turns").get()!.n, 1);
    assert.equal(target.prepare("SELECT name FROM sqlite_master WHERE name='signing_secrets'").get(), undefined);
  } finally { target.close(); }
  assert.equal(readFileSync(path.join(f.targetChild, "soul", "OWNER.md"), "utf8"), PERSONAL);
  assert.equal(readFileSync(path.join(f.targetChild, "tg-groups.json"), "utf8"), f.groupText);
  assert.equal(existsSync(path.join(f.targetChild, "grant.json")), false);
  assert.equal((await f.targetMode("complete")).operation, "completed");
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), false);
  assert.equal(f.sharedRaw.prepare("SELECT state,sealed FROM tenant_ledger_import").get()!.state, "consumed");
  assert.ok(f.getReleases() >= 5);
});

test("source preconditions reject skipped original books and missing accounting sources without staging or blank fiction", async t => {
  const f = await fixture(t);
  const orphan = path.join(f.sourceHome, "children", `0x${"96".repeat(20)}`); mkdirSync(orphan);
  writeFileSync(path.join(orphan, "merrymen.db"), "unlisted original book");
  await assert.rejects(f.capture(), /Ledger handover refused/);
  assert.equal(existsSync(f.artifact), false);
  rmSync(orphan, { recursive: true });
  // Original handle is still open, but the namespace no longer exposes its book.
  rmSync(path.join(f.child, "merrymen.db"));
  await assert.rejects(f.capture(), /Ledger handover refused/);
  assert.equal(existsSync(f.artifact), false);
});

test("explicit completion can retry its durable receipt after a crash and device renumbering", async t => {
  const f = await fixture(t); await f.stage(); await f.targetMode("restore");
  const haltFile = path.join(f.targetHome, "FLEET_HALT"), manifestFile = path.join(f.targetHome, PERSISTENT_HOME_MANIFEST);
  const held = lstatSync(haltFile, { bigint: true }), text = readFileSync(haltFile, "utf8");
  await assert.rejects(runLedgerHandoverCli(f.targetArgs("complete"), { ...f.targetDeps, persistentOptions: {
    ...f.targetDeps.persistentOptions, afterCompletionSynced: () => { throw new Error("simulated release crash"); },
  } }), /Ledger handover refused/);
  const saved = JSON.parse(readFileSync(manifestFile, "utf8"));
  assert.equal(saved.handover.state, "complete");
  assert.equal(lstatSync(haltFile, { bigint: true }).ino, held.ino);
  assert.equal(readFileSync(haltFile, "utf8"), text, "the crash must leave the original hold intact");
  // Model the saved mount-namespace device differing from the current attachment.
  // Provider UUID, root inode and halt inode/content remain the same volume.
  saved.device = String(BigInt(saved.device) + 1n); saved.handover.halt.device = saved.device;
  writeFileSync(manifestFile, JSON.stringify(saved), { mode: 0o600 });
  assert.equal(preparePersistentHomeForHandover(f.targetDeps.env!, f.targetDeps.persistentOptions)!.halt, null);
  assert.equal((await f.targetMode("complete")).operation, "completed");
  assert.equal(existsSync(haltFile), false);
  assert.equal(f.sharedRaw.prepare("SELECT state FROM tenant_ledger_import").get()!.state, "consumed");
});

test("capture requires the separate checkpoint's final exact cursors and every healthy Postgres lease", async t => {
  const f = await fixture(t);
  f.sharedRaw.prepare("UPDATE mirror_state SET last_id=0 WHERE tenant=? AND table_name='events'").run(TENANT);
  await assert.rejects(f.capture(), /Ledger handover refused/);
  assert.equal(existsSync(f.artifact), false);
  f.sharedRaw.prepare("UPDATE mirror_state SET last_id=41,last_stamp=1041 WHERE tenant=? AND table_name='events'").run(TENANT);
  f.loseLease();
  await assert.rejects(f.capture(), /Ledger handover refused/);
  assert.equal(existsSync(f.artifact), false);
});

test("wrong target volume, commit, source process proof or ephemeral mount cannot consume imports", async t => {
  const f = await fixture(t); await f.stage();
  const original = f.targetDeps.env!;
  for (const env of [{ ...original, MERRYMEN_HOME_VOLUME_ID: randomUUID() }, { ...original, MERRYMEN_INITIAL_HANDOVER: "different-operation" }]) {
    await assert.rejects(runLedgerHandoverCli(f.targetArgs("restore"), { ...f.targetDeps, env }), /Ledger handover refused/);
  }
  const args = f.targetArgs("restore"); args[args.indexOf("--source-orchestrator-start") + 1] = "9999";
  await assert.rejects(runLedgerHandoverCli(args, f.targetDeps), /Ledger handover refused/);
  await assert.rejects(runLedgerHandoverCli(f.targetArgs("restore"), { ...f.targetDeps, persistentOptions: { readMountInfo: () => "40 20 0:1 / /ephemeral rw - overlay overlay rw\n" } }), /Ledger handover refused/);
  assert.equal(f.sharedRaw.prepare("SELECT state FROM tenant_ledger_import").get()!.state, "available");
  assert.equal(existsSync(path.join(f.targetChild, "merrymen.db")), false);
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), true);
});

test("completion compares memory bytes and full original financial content; matching counts cannot release the hold", async t => {
  const f = await fixture(t); await f.stage(); await f.targetMode("restore");
  const owner = path.join(f.targetChild, "soul", "OWNER.md"); writeFileSync(owner, "Different owner's orchids");
  await assert.rejects(f.targetMode("complete"), /Ledger handover refused/);
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), true);
  writeFileSync(owner, PERSONAL);
  writeFileSync(path.join(f.targetChild, "tg-groups.json"), f.groupText.replace(GROUP, "A different private line"));
  await assert.rejects(f.targetMode("complete"), /Ledger handover refused/);
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), true);
  writeFileSync(path.join(f.targetChild, "tg-groups.json"), f.groupText);
  const target = new DatabaseSync(path.join(f.targetChild, "merrymen.db"));
  target.exec("UPDATE trades SET amount_usdg=6"); target.close();
  await assert.rejects(f.targetMode("complete"), /Ledger handover refused/);
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), true);
});

test("missing consumed books and conflicting stored memory leave the target held and never replay a generation", async t => {
  const f = await fixture(t); await f.stage();
  const old = f.sharedRaw.prepare("SELECT sealed FROM tenant_personal_memory").get()!.sealed;
  f.sharedRaw.exec("UPDATE tenant_personal_memory SET sealed='wrong-key-or-torn-row'");
  await assert.rejects(f.targetMode("restore"), /Ledger handover refused/);
  assert.equal(f.sharedRaw.prepare("SELECT state FROM tenant_ledger_import").get()!.state, "available");
  f.sharedRaw.prepare("UPDATE tenant_personal_memory SET sealed=?").run(old!);
  await f.targetMode("restore");
  rmSync(path.join(f.targetChild, "merrymen.db"));
  await assert.rejects(f.targetMode("restore"), /Ledger handover refused/);
  assert.equal(existsSync(path.join(f.targetChild, "merrymen.db")), false);
  assert.equal(f.sharedRaw.prepare("SELECT state,sealed FROM tenant_ledger_import").get()!.state, "consumed");
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), true);
});

test("genuinely never-created sources are explicit and carry no invented financial ledger", async t => {
  const f = await fixture(t, true); await f.stage();
  const backup = openFleetLedgerHandover(readFileSync(f.artifact, "utf8"), DEK);
  assert.deepEqual(backup.withoutBook, [`0x${"74".repeat(20)}`]);
  await f.targetMode("restore");
  assert.equal(existsSync(path.join(f.targetHome, "children", backup.withoutBook[0]!, "merrymen.db")), false);
  await f.targetMode("complete");
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), false);
});

test("sealed artifact tampering, permissive files and incomplete explicit flags fail closed", async t => {
  const f = await fixture(t); await f.capture();
  const original = readFileSync(f.artifact, "utf8");
  assert.throws(() => openFleetLedgerHandover(original, Buffer.alloc(32, 77)), /Ledger handover refused/);
  const backup = openFleetLedgerHandover(original, DEK); backup.books[0]!.sha256 = "0".repeat(64);
  assert.throws(() => openFleetLedgerHandover(sealFleetLedgerHandover(backup, DEK), DEK), /Ledger handover refused/);
  chmodSync(f.artifact, 0o644);
  await assert.rejects(f.sourceMode("verify"), /Ledger handover refused/);
  chmodSync(f.artifact, 0o600);
  await assert.rejects(runLedgerHandoverCli(f.captureArgs.filter(x => x !== "--quiescent"), f.deps), /Ledger handover refused/);
  assert.throws(() => writeLedgerHandoverArtifact(f.artifact, original), /EEXIST/);
  assert.equal(readFileSync(f.artifact, "utf8"), original);
});

const GAP_TENANT = `0x${"74".repeat(20)}`, GAP_ACCOUNT = `0x${"85".repeat(20)}`;
function addHistoricalGap(sharedRaw: DatabaseSync): void {
  sharedRaw.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,status,epoch,hwm_usdg,mode) VALUES(?,?,?,4663,'{}',1,20,'expired',1,100,'live')")
    .run(GAP_ACCOUNT, OWNER, `0x${"18".repeat(20)}`);
  sharedRaw.prepare("INSERT INTO events(id,agent_id,level,message,created_at) VALUES(800,?,'ok','durable historical event',1800)").run(GAP_ACCOUNT);
  sharedRaw.prepare("INSERT INTO mirror_state(tenant,table_name,last_id,last_stamp,updated_at) VALUES(?,'events',18,1800,1900)").run(GAP_TENANT);
}

test("read-only live preflight classifies historical gaps before a halt without approving a handover", async t => {
  const f = await fixture(t, true); addHistoricalGap(f.sharedRaw);
  rmSync(path.join(f.sourceHome, "FLEET_HALT"));
  const result = await runLedgerHandoverCli(["preflight", "--expected-deployment", "source-deployment", "--expected-commit", SOURCE_SHA,
    "--orchestrator-pid", "41", "--single-replica-confirmed"], f.deps);
  assert.equal(result.operation, "preflight-read-only");
  assert.equal(result.existingBooks, 1); assert.equal(result.historicalMissingBooks, 1); assert.equal(result.neverCreatedBooks, 0);
  assert.equal(result.releaseEligible, false);
  assert.equal((result.historicalGaps as Array<{ financialRows: Record<string, number> }>)[0]!.financialRows.events, 1);
  assert.equal(existsSync(path.join(f.sourceHome, "FLEET_HALT")), false);
  assert.equal(existsSync(f.artifact), false);
  assert.equal(f.getReleases(), 0, "preflight never leases or writes");
});

test("retained decision evidence alone prevents a missing book from becoming a new empty source", async t => {
  const f = await fixture(t, true);
  f.sharedRaw.prepare("INSERT INTO decisions(id,agent_id,source,reason,at) VALUES('historical-only',?,'chat','retained execution provenance',1900)").run(GAP_ACCOUNT);
  await assert.rejects(f.capture(), /Ledger handover refused/);
  const preflight = await runLedgerHandoverCli(["preflight", "--expected-deployment", "source-deployment", "--expected-commit", SOURCE_SHA,
    "--orchestrator-pid", "41", "--single-replica-confirmed"], f.deps);
  assert.equal(preflight.historicalMissingBooks, 1);
  assert.equal(preflight.neverCreatedBooks, 0);
  assert.equal((preflight.historicalGaps as Array<{ financialRows: Record<string, number> }>)[0]!.financialRows.decisions, 1);
  assert.equal(existsSync(f.artifact), false);
});

test("acknowledged historical gaps retain financial state and a durable owned block after fleet completion", async t => {
  const f = await fixture(t, true); addHistoricalGap(f.sharedRaw);
  await assert.rejects(f.capture(), /Ledger handover refused/);
  await runLedgerHandoverCli([...f.captureArgs, "--acknowledge-historical-ledger-gaps"], f.deps);
  const backup = openFleetLedgerHandover(readFileSync(f.artifact, "utf8"), DEK);
  assert.equal(backup.historicalGaps.length, 1); assert.deepEqual(backup.withoutBook, []);
  assert.equal(backup.historicalGaps[0]!.tenant, GAP_TENANT);
  await f.sourceMode("stage"); await f.targetMode("restore");
  const gapHome = path.join(f.targetHome, "children", GAP_TENANT), marker = path.join(gapHome, "ledger-source-blocked.json");
  assert.equal(existsSync(marker), true); assert.equal(existsSync(path.join(gapHome, HISTORICAL_GAP_PROOF_FILE)), true);
  assert.equal(existsSync(path.join(gapHome, "merrymen.db")), false);
  const before = f.sharedRaw.prepare("SELECT * FROM events WHERE agent_id=?").all(GAP_ACCOUNT);
  const completed = await f.targetMode("complete");
  assert.equal(completed.historicalBlockedBooks, 1);
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), false);
  assert.equal(existsSync(marker), true, "the gap tenant remains blocked after the fleet hold releases");
  assert.deepEqual(f.sharedRaw.prepare("SELECT * FROM events WHERE agent_id=?").all(GAP_ACCOUNT), before);
  assert.equal(f.sharedRaw.prepare("SELECT last_id FROM mirror_state WHERE tenant=?").get(GAP_TENANT)!.last_id, 18);
  assert.equal(f.sharedRaw.prepare("SELECT * FROM tenant_ledger_import WHERE tenant=?").get(GAP_TENANT), undefined);
});

test("a historical gap's shared financial changes or replaced block forbid release; cold rebuilt books are never acknowledged as gaps", async t => {
  const f = await fixture(t, true); addHistoricalGap(f.sharedRaw);
  await runLedgerHandoverCli([...f.captureArgs, "--acknowledge-historical-ledger-gaps"], f.deps);
  await f.sourceMode("stage"); await f.targetMode("restore");
  const gapHome = path.join(f.targetHome, "children", GAP_TENANT), marker = path.join(gapHome, "ledger-source-blocked.json");
  const text = readFileSync(marker, "utf8");
  // Keep the original inode allocated so identical replacement text cannot be mistaken for ownership.
  (await import("node:fs")).renameSync(marker, path.join(gapHome, "original-block"));
  writeFileSync(marker, text, { mode: 0o600 });
  await assert.rejects(f.targetMode("complete"), /Ledger handover refused/);
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), true);
  rmSync(marker); (await import("node:fs")).renameSync(path.join(gapHome, "original-block"), marker);
  f.sharedRaw.prepare("UPDATE events SET message='historical accounting changed' WHERE agent_id=?").run(GAP_ACCOUNT);
  await assert.rejects(f.targetMode("complete"), /Ledger handover refused/);
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), true);
  const rebuiltHome = path.join(f.sourceHome, "children", GAP_TENANT); mkdirSync(rebuiltHome);
  const rebuilt = new DatabaseSync(path.join(rebuiltHome, "merrymen.db")); await applyLedgerSchema(wrapSqlite(rebuilt)); rebuilt.close();
  const newArgs = [...f.captureArgs, "--acknowledge-historical-ledger-gaps"];
  newArgs[newArgs.indexOf("--output") + 1] = path.join(f.dir, "must-not-capture-rebuilt.sealed");
  await assert.rejects(runLedgerHandoverCli(newArgs, f.deps), /Ledger handover refused/);
  assert.equal(existsSync(path.join(f.dir, "must-not-capture-rebuilt.sealed")), false);
});

test("completed-receipt crash retries tolerate device renumbering for owned historical-gap blocks", async t => {
  const f = await fixture(t, true); addHistoricalGap(f.sharedRaw);
  await runLedgerHandoverCli([...f.captureArgs, "--acknowledge-historical-ledger-gaps"], f.deps);
  await f.sourceMode("stage"); await f.targetMode("restore");
  const gapHome = path.join(f.targetHome, "children", GAP_TENANT), marker = path.join(gapHome, "ledger-source-blocked.json");
  const receiptFile = path.join(gapHome, HISTORICAL_GAP_PROOF_FILE), manifestFile = path.join(f.targetHome, PERSISTENT_HOME_MANIFEST);
  const heldMarker = lstatSync(marker, { bigint: true }), markerText = readFileSync(marker, "utf8");
  await assert.rejects(runLedgerHandoverCli(f.targetArgs("complete"), { ...f.targetDeps, persistentOptions: {
    ...f.targetDeps.persistentOptions, afterCompletionSynced: () => { throw new Error("simulated release crash"); },
  } }), /Ledger handover refused/);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")), receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  assert.equal(manifest.handover.state, "complete");
  manifest.device = String(BigInt(manifest.device) + 1n); manifest.handover.halt.device = manifest.device;
  writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  receipt.markerDevice = "not-a-device"; writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
  await assert.rejects(f.targetMode("complete"), /Ledger handover refused/);
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), true);
  receipt.markerDevice = manifest.device; writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
  assert.equal((await f.targetMode("complete")).historicalBlockedBooks, 1);
  assert.equal(existsSync(path.join(f.targetHome, "FLEET_HALT")), false);
  assert.equal(lstatSync(marker, { bigint: true }).ino, heldMarker.ino);
  assert.equal(readFileSync(marker, "utf8"), markerText, "the reviewed gap remains blocked on its original inode");
  assert.equal(f.sharedRaw.prepare("SELECT * FROM tenant_ledger_import WHERE tenant=?").get(GAP_TENANT), undefined);
});
