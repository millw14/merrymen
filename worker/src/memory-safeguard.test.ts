import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { wrapSqlite, type Db } from "./db";
import { recordPersonalMemoryForget, PERSONAL_MEMORY_FORGET_FILE } from "./personal-memory-ferry";
import { openSecret, sealSecret } from "./store-crypto";
import { inspectMemorySource } from "./memory-safeguard-cli";
import {
  captureFleetMemory, openMemoryBackup, seedMemoryBackup, sealMemoryBackup, verifyMemoryBackup,
  writeMemoryBackupArtifact, type MemorySource,
} from "./memory-safeguard";

const TENANT = `0x${"41".repeat(20)}`, ACCOUNT = `0x${"52".repeat(20)}`;
const DEK = randomBytes(32), SECRET = "excluded grant key and trading credentials";
const source: MemorySource = { deploymentId: "fixture-deploy", gitCommit: "a".repeat(40),
  orchestratorPid: 21, orchestratorStart: "1234", quiescent: true, singleReplicaConfirmed: true };
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mm-safeguard-test-"));
  const childrenDir = path.join(dir, "children"), home = path.join(childrenDir, TENANT);
  mkdirSync(path.join(home, "soul"), { recursive: true });
  writeFileSync(path.join(home, "soul", "OWNER.md"), "My owner grows orchids.");
  writeFileSync(path.join(home, "soul", "IDENTITY.md"), "I am Shogun.");
  writeFileSync(path.join(home, "soul", "UNLISTED.md"), SECRET);
  writeFileSync(path.join(home, "grant.json"), SECRET);
  writeFileSync(path.join(home, "settings.json"), SECRET);
  const local = new DatabaseSync(path.join(home, "merrymen.db"));
  local.exec("CREATE TABLE chat_turns(id INTEGER PRIMARY KEY, chat_id INTEGER, role TEXT, content TEXT, memory_ids TEXT, at INTEGER); CREATE TABLE signing_secrets(value TEXT)");
  local.prepare("INSERT INTO signing_secrets VALUES (?)").run(SECRET);
  const turn = local.prepare("INSERT INTO chat_turns VALUES (?, ?, ?, ?, ?, ?)");
  turn.run(1, 7, "user", "Remember my orchid", null, 12);
  turn.run(2, 7, "assistant", "I remember", null, 13);
  turn.run(3, -100, "user", SECRET, null, 14); // Groups are not personal DMs.
  local.close();
  const groupText = JSON.stringify({ version: 1, rooms: { "-100": { chatId: -100, status: "approved", title: "garden",
    lines: [{ messageId: 1, fromId: 8, name: "A", text: "A private group line", atMs: 1 }], claims: { "1:coin": 4 } } },
    llm: { day: "2026-10-04", used: 4 }, nominations: { day: "2026-10-04", n: 2, entries: 1 } });
  writeFileSync(path.join(home, "tg-groups.json"), groupText);
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY, grant_json TEXT, updated_at INTEGER, row_version INTEGER); CREATE TABLE tenant_tg_groups(tenant TEXT PRIMARY KEY, sealed TEXT, bytes INTEGER, updated_at_ms INTEGER)");
  raw.prepare("INSERT INTO grants VALUES (?, ?, ?, ?)").run(TENANT, JSON.stringify({ smartAccount: ACCOUNT, privateKey: SECRET }), 25, 1);
  const sqlite = wrapSqlite(raw);
  // The production code uses Pg-only public projection/locking. This adapter
  // changes syntax only; the separate opt-in test exercises real PostgreSQL.
  const adapt = (sql: string) => sql.replaceAll("updated_at::text", "CAST(updated_at AS TEXT)")
    .replaceAll("xmin::text", "CAST(row_version AS TEXT)").replace(/ FOR SHARE$/, "");
  const scoped = (db: Db): Db => ({ exec: sql => sql.includes("pg_advisory_xact_lock") ? Promise.resolve() : db.exec(sql),
    prepare: sql => db.prepare(sql.includes("pg_advisory_xact_lock") ? "SELECT ?" : adapt(sql)),
    tx: fn => db.tx(tx => fn(scoped(tx))) });
  const shared = scoped(sqlite);
  t.after(() => { raw.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, home, childrenDir, raw, shared, groupText };
}

test("backup captures only the whitelist, encrypts the whole manifest and restores through production ferries", async t => {
  const f = fixture(t);
  const backup = await captureFleetMemory({ ...f, dek: DEK, source, assertSource: () => {} });
  assert.deepEqual(await verifyMemoryBackup(backup, DEK), { tenants: 1, personalSnapshots: 1, soulFiles: 2,
    dmChats: 1, dmTurns: 2, groupSnapshots: 1, groupRooms: 1, rosterWithoutHome: 0, historicalMemoryGaps: 0 });
  const sealed = sealMemoryBackup(backup, DEK);
  assert.ok(!sealed.includes(TENANT) && !sealed.includes("orchid") && !sealed.includes(SECRET));
  const decoded = openMemoryBackup(sealed, DEK);
  const personal = openSecret(decoded.entries[0]!.personal!.sealed, DEK);
  assert.ok(personal.includes("orchid") && !personal.includes(SECRET) && !personal.includes("UNLISTED"));
  assert.equal(openSecret(decoded.entries[0]!.groups!.sealed, DEK), `tg-groups/v1 ${TENANT}\n${f.groupText}`);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'tenant_personal_memory'").get()!.n, 0, "capture performs no shared DDL or writes");
  const file = path.join(f.dir, "backup.sealed");
  assert.match(writeMemoryBackupArtifact(file, sealed), /^[0-9a-f]{64}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(() => writeMemoryBackupArtifact(file, sealed), /EEXIST/);
  assert.equal(readFileSync(file, "utf8"), sealed);
});

test("pending privacy requests apply before encryption without clearing the live journals", async t => {
  const f = fixture(t);
  const op = recordPersonalMemoryForget({ kind: "chat", chatId: 7 }, f.home);
  const personalJournal = readFileSync(path.join(f.home, PERSONAL_MEMORY_FORGET_FILE), "utf8");
  const groupJournal = JSON.stringify({ chatId: -100, userId: 8, atMs: 5 }) + "\n";
  writeFileSync(path.join(f.home, "tg-groups-forget.json"), groupJournal);
  const b = await captureFleetMemory({ ...f, dek: DEK, source, assertSource: () => {} });
  assert.equal(b.entries[0]!.personal!.dmTurns, 0);
  assert.ok(!openSecret(b.entries[0]!.groups!.sealed, DEK).includes("A private group line"));
  assert.equal(readFileSync(path.join(f.home, PERSONAL_MEMORY_FORGET_FILE), "utf8"), personalJournal);
  assert.ok(personalJournal.includes(op.id));
  assert.equal(readFileSync(path.join(f.home, "tg-groups-forget.json"), "utf8"), groupJournal);
  await verifyMemoryBackup(b, DEK);
});

test("unsafe home, malformed privacy journal, swapped tenant ciphertext and wrong key refuse", async t => {
  const f = fixture(t);
  const b = await captureFleetMemory({ ...f, dek: DEK, source, assertSource: () => {} });
  assert.throws(() => openMemoryBackup(sealMemoryBackup(b, DEK), randomBytes(32)), /refused/);
  const changed = structuredClone(b);
  changed.entries[0]!.personal!.sealed = changed.entries[0]!.groups!.sealed;
  // An intact ciphertext for a different payload cannot masquerade as personal memory.
  await assert.rejects(verifyMemoryBackup(changed, DEK), /refused/);
  writeFileSync(path.join(f.home, "tg-groups-forget.json"), '{"chatId":');
  await assert.rejects(captureFleetMemory({ ...f, dek: DEK, source, assertSource: () => {} }), /refused/);
  rmSync(path.join(f.home, "tg-groups-forget.json"));
  rmSync(path.join(f.home, "soul", "OWNER.md"));
  symlinkSync(path.join(f.home, "grant.json"), path.join(f.home, "soul", "OWNER.md"));
  await assert.rejects(captureFleetMemory({ ...f, dek: DEK, source, assertSource: () => {} }), /export refused/);
});

test("seeding is quiescent, row-bound, insert-only and idempotent only for the identical encrypted artifact", async t => {
  const f = fixture(t);
  const b = await captureFleetMemory({ ...f, dek: DEK, source, assertSource: () => {} });
  await assert.rejects(seedMemoryBackup({ ...f, backup: { ...b, source: { ...source, quiescent: false } }, dek: DEK, assertSource: () => {} }), /refused/);
  assert.deepEqual(await seedMemoryBackup({ ...f, backup: b, dek: DEK, assertSource: () => {} }), { inserted: 1, alreadySeeded: 0 });
  assert.deepEqual(await seedMemoryBackup({ ...f, backup: b, dek: DEK, assertSource: () => {} }), { inserted: 0, alreadySeeded: 1 });
  const newer = await captureFleetMemory({ ...f, dek: DEK, source, assertSource: () => {} });
  await assert.rejects(seedMemoryBackup({ ...f, backup: newer, dek: DEK, assertSource: () => {} }), /refused/);
  assert.equal(f.raw.prepare("SELECT sealed FROM tenant_personal_memory WHERE tenant=?").get(TENANT)!.sealed, b.entries[0]!.personal!.sealed);
  f.raw.prepare("UPDATE grants SET row_version=2").run(); // Same owner, account and server second, new row incarnation.
  await assert.rejects(seedMemoryBackup({ ...f, backup: b, dek: DEK, assertSource: () => {} }), /refused/);
  f.raw.prepare("UPDATE grants SET updated_at=26").run();
  await assert.rejects(seedMemoryBackup({ ...f, backup: b, dek: DEK, assertSource: () => {} }), /refused/);
  assert.ok(existsSync(path.join(f.home, "grant.json")), "no destructive fallback");
});

test("public source guard pins deployment and live orchestrator identity and proves worker exit before quiescence", t => {
  const f = fixture(t), proc = path.join(f.dir, "proc");
  const pidDir = path.join(proc, "21"); mkdirSync(pidDir, { recursive: true });
  writeFileSync(path.join(pidDir, "cmdline"), "node\0--import\0tsx\0/app/worker/src/orchestrator.ts\0");
  writeFileSync(path.join(pidDir, "stat"), "21 (node) S " + Array(18).fill("0").join(" ") + " 1234 0");
  writeFileSync(path.join(f.dir, "FLEET_HALT"), "reviewed fixture\n");
  const env = { RAILWAY_DEPLOYMENT_ID: source.deploymentId, RAILWAY_GIT_COMMIT_SHA: source.gitCommit };
  const opts = { expectedDeployment: source.deploymentId, expectedCommit: source.gitCommit, orchestratorPid: 21,
    home: f.dir, quiescent: true, singleReplicaConfirmed: true };
  assert.deepEqual(inspectMemorySource(opts, env, proc), source);
  assert.throws(() => inspectMemorySource(opts, { ...env, RAILWAY_DEPLOYMENT_ID: "another-deployment" }, proc), /refused/);
  mkdirSync(path.join(proc, "22"));
  writeFileSync(path.join(proc, "22", "cmdline"), "node\0/app/worker/src/index.ts\0");
  assert.throws(() => inspectMemorySource(opts, env, proc), /refused/);
  rmSync(path.join(proc, "22"), { recursive: true });
  rmSync(path.join(f.dir, "FLEET_HALT"));
  assert.throws(() => inspectMemorySource(opts, env, proc));
});

test("missing homes preserve authenticated durable rows and report historical absence without inventing memory", async t => {
  const f = fixture(t), old = await captureFleetMemory({ ...f, dek: DEK, source, assertSource: () => {} });
  f.raw.exec("CREATE TABLE tenant_personal_memory(tenant TEXT PRIMARY KEY, sealed TEXT, bytes INTEGER, updated_at_ms INTEGER)");
  f.raw.prepare("INSERT INTO tenant_personal_memory VALUES (?, ?, ?, ?)")
    .run(TENANT, old.entries[0]!.personal!.sealed, old.entries[0]!.personal!.bytes, Date.now());
  f.raw.prepare("INSERT INTO tenant_tg_groups VALUES (?, ?, ?, ?)")
    .run(TENANT, old.entries[0]!.groups!.sealed, old.entries[0]!.groups!.bytes, Date.now());
  rmSync(f.home, { recursive: true });
  const b = await captureFleetMemory({ ...f, dek: DEK, source, assertSource: () => {} });
  const counts = await verifyMemoryBackup(b, DEK);
  assert.equal(counts.rosterWithoutHome, 1); assert.equal(counts.historicalMemoryGaps, 0);
  assert.equal(b.entries[0]!.personal!.sealed, old.entries[0]!.personal!.sealed);
  assert.deepEqual(await seedMemoryBackup({ ...f, backup: b, dek: DEK, assertSource: () => {} }), { inserted: 0, alreadySeeded: 0 });
  assert.equal(f.raw.prepare("SELECT sealed FROM tenant_personal_memory WHERE tenant=?").get(TENANT)!.sealed, old.entries[0]!.personal!.sealed);
  f.raw.exec("DELETE FROM tenant_personal_memory; DELETE FROM tenant_tg_groups");
  const missing = await captureFleetMemory({ ...f, dek: DEK, source, assertSource: () => {} });
  assert.equal((await verifyMemoryBackup(missing, DEK)).historicalMemoryGaps, 1);
  assert.equal(missing.entries[0]!.personal, null); assert.equal(missing.entries[0]!.groups, null);
  // Existing unreadable or foreign-tenant memory is a failure, never treated as absent.
  f.raw.prepare("INSERT INTO tenant_tg_groups VALUES (?, ?, ?, ?)")
    .run(TENANT, sealSecret(`tg-groups/v1 0x${"99".repeat(20)}\n${f.groupText}`, DEK), 50, Date.now());
  await assert.rejects(captureFleetMemory({ ...f, dek: DEK, source, assertSource: () => {} }), /refused/);
});

test("reviewed bootstrap bundle verifies an encrypted fixture from the repository root without plaintext logs", async t => {
  const f = fixture(t), repo = fileURLToPath(new URL("../..", import.meta.url));
  const backup = await captureFleetMemory({ ...f, dek: DEK, source, assertSource: () => {} });
  const artifact = path.join(f.dir, "bootstrap-fixture.sealed");
  writeMemoryBackupArtifact(artifact, sealMemoryBackup(backup, DEK));
  // External ESM dependencies resolve from this location, as from /app in the
  // verified hosted image. A /tmp bundle would not find /app/node_modules.
  const bundle = path.join(repo, `.memory-safeguard-${randomBytes(8).toString("hex")}.mjs`);
  t.after(() => rmSync(bundle, { force: true }));
  execFileSync(path.join(repo, "node_modules", ".bin", "esbuild"), ["worker/src/memory-safeguard-cli.ts", "--bundle", "--platform=node",
    "--format=esm", "--packages=external", `--outfile=${bundle}`], { cwd: repo, stdio: "pipe" });
  const env: NodeJS.ProcessEnv = { ...process.env, MERRYMEN_STORE_DEK: DEK.toString("base64") };
  delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, [bundle, "verify", "--artifact", artifact], { cwd: repo, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).operation, "verified");
  assert.ok(!result.stdout.includes(TENANT) && !result.stdout.includes("orchid") && !result.stdout.includes(SECRET));
  assert.equal(result.stderr, "");
});
