import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { captureFleetMemory, type MemorySource } from "./memory-safeguard";
import { checkpointFleetLedger } from "./ledger-safeguard";
import type { TenantLease } from "./tenant-lease";
import { sealSecret } from "./store-crypto";
import { MIRROR_STATE_DDL } from "./ledger-mirror";

const TENANT = `0x${"63".repeat(20)}` as `0x${string}`, ACCOUNT = `0x${"74".repeat(20)}`;
const DEK = Buffer.alloc(32, 19);
const source: MemorySource = { deploymentId: "fixture", gitCommit: "b".repeat(40), orchestratorPid: 8,
  orchestratorStart: "654", quiescent: true, singleReplicaConfirmed: true };
async function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mm-ledger-safeguard-"));
  const childrenDir = path.join(root, "children"), home = path.join(childrenDir, TENANT);
  mkdirSync(path.join(home, "soul"), { recursive: true });
  writeFileSync(path.join(home, "soul", "IDENTITY.md"), "fixture identity");
  const local = new DatabaseSync(path.join(home, "merrymen.db"));
  const raw = new DatabaseSync(":memory:");
  await applyLedgerSchema(wrapSqlite(local));
  await applyLedgerSchema(wrapSqlite(raw));
  raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY, grant_json TEXT, updated_at INTEGER, row_version INTEGER); CREATE TABLE tenant_tg_groups(tenant TEXT PRIMARY KEY, sealed TEXT, bytes INTEGER, updated_at_ms INTEGER)");
  raw.prepare("INSERT INTO grants VALUES (?, ?, 15, 1)").run(TENANT, JSON.stringify({ smartAccount: ACCOUNT }));
  local.prepare("INSERT INTO agents(smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, hwm_usdg, mode) VALUES (?, ?, ?, 4663, '{}', 1, 2, 'armed', 120, 'live')")
    .run(ACCOUNT, TENANT, `0x${"85".repeat(20)}`);
  const flow = local.prepare("INSERT INTO flows(agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at) VALUES (?, 'in', 1, ?, 10, ?, 'chain-log', 1, 4663, ?)");
  for (let n = 1; n <= 503; n++) flow.run(ACCOUNT, `0x${n.toString(16).padStart(64, "0")}`, n, 100 + n);
  local.close();
  const base = wrapSqlite(raw);
  const adapt = (sql: string) => sql.replaceAll("updated_at::text", "CAST(updated_at AS TEXT)").replaceAll("xmin::text", "CAST(row_version AS TEXT)");
  const scoped = (db: Db): Db => ({ prepare: sql => db.prepare(sql.includes("pg_advisory_xact_lock") ? "SELECT ?" : adapt(sql)),
    exec: sql => db.exec(sql), tx: fn => db.tx(tx => fn(scoped(tx))) });
  const shared = scoped(base);
  const backup = await captureFleetMemory({ childrenDir, shared, dek: DEK, source, assertSource: () => {} });
  let releases = 0;
  const acquireLease = async (tenant: `0x${string}`): Promise<TenantLease> => {
    assert.equal(tenant, TENANT);
    return { tenant, backend: "postgres", healthy: () => true, release: async () => { releases++; } };
  };
  t.after(() => { raw.close(); rmSync(root, { recursive: true, force: true }); });
  return { backup, childrenDir, home, shared, raw, dek: DEK, assertSource: () => {}, acquireLease,
    releases: () => releases };
}

test("final checkpoint runs the actual mirror to exhaustion and a repeat never duplicates capital or lowers the peak", async t => {
  const f = await fixture(t);
  const first = await checkpointFleetLedger(f);
  assert.equal(first.checkpointed, 1); assert.ok(first.passes >= 3, "503 rows require two batches plus verification");
  assert.equal(f.raw.prepare("SELECT count(*) n FROM flows").get()!.n, 503);
  assert.equal(f.raw.prepare("SELECT sum(amount_usdg) n FROM flows").get()!.n, 503);
  assert.equal(f.raw.prepare("SELECT hwm_usdg FROM agents WHERE smart_account=?").get(ACCOUNT)!.hwm_usdg, 120);
  assert.equal(f.releases(), 1);
  await checkpointFleetLedger(f);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM flows").get()!.n, 503);
  assert.equal(f.raw.prepare("SELECT hwm_usdg FROM agents WHERE smart_account=?").get(ACCOUNT)!.hwm_usdg, 120);
  assert.equal(f.releases(), 2);
});

test("held, unrestored, pending-chain, changed-account and nonquiescent books refuse before mirroring", async t => {
  const f = await fixture(t);
  const count = () => f.raw.prepare("SELECT count(*) n FROM flows").get()!.n;
  await assert.rejects(checkpointFleetLedger({ ...f, accountingHolds: new Set([TENANT]) }), /refused/);
  for (const file of ["restore-blocked.json", "energy-unrestored.json", "telegram-held-groups.json", "ledger-source-blocked.json"]) {
    writeFileSync(path.join(f.home, file), "fixture");
    await assert.rejects(checkpointFleetLedger(f), /refused/);
    rmSync(path.join(f.home, file));
  }
  await assert.rejects(checkpointFleetLedger({ ...f, backup: { ...f.backup, source: { ...source, quiescent: false } } }), /refused/);
  const local = new DatabaseSync(path.join(f.home, "merrymen.db"));
  local.prepare("INSERT INTO trades(agent_id, kind, target, amount_usdg, status) VALUES (?, 'call', 'fixture', 1, 'submitted')").run(ACCOUNT);
  local.close();
  await assert.rejects(checkpointFleetLedger(f), /refused/);
  const changed = new DatabaseSync(path.join(f.home, "merrymen.db"));
  changed.exec("DELETE FROM trades"); changed.prepare("UPDATE agents SET smart_account=?").run(`0x${"96".repeat(20)}`); changed.close();
  await assert.rejects(checkpointFleetLedger(f), /refused/);
  assert.equal(count(), 0); assert.equal(f.releases(), 0);
});

test("unavailable lease, failed/skipped mirrors and lost lease never claim checkpoint completion", async t => {
  const f = await fixture(t);
  await assert.rejects(checkpointFleetLedger({ ...f, acquireLease: async () => null }), /refused/);
  for (const report of [{ tenant: TENANT, copied: {}, failed: { flows: "fixture SQL failure" } },
    { tenant: TENANT, copied: {}, skipped: "unopenable fixture" }]) {
    await assert.rejects(checkpointFleetLedger({ ...f, mirror: async () => report }), /refused/);
  }
  await assert.rejects(checkpointFleetLedger({ ...f, acquireLease: async () => ({ tenant: TENANT, backend: "postgres",
    healthy: () => false, release: async () => {} }) }), /refused/);
  assert.equal(f.releases(), 2, "failed mirror leases released");
  assert.equal(f.raw.prepare("SELECT count(*) n FROM flows").get()!.n, 0);
});

test("an empty held-style group file with no held-groups marker never replaces a populated protected row", async t => {
  const f = await fixture(t);
  const protectedText = JSON.stringify({ version: 1, rooms: { "-100": { chatId: -100, status: "approved", title: "preserve this room",
    lines: [{ messageId: 4, fromId: 8, text: "protected memory", name: "fixture", atMs: 1 }], claims: { "4:coin": 5 } } } });
  const sealed = sealSecret(`tg-groups/v1 ${TENANT}\n${protectedText}`, DEK);
  f.raw.prepare("INSERT INTO tenant_tg_groups VALUES (?, ?, ?, ?)").run(TENANT, sealed, protectedText.length, Date.now());
  writeFileSync(path.join(f.home, "tg-groups.json"), JSON.stringify({ version: 1, rooms: {} }));
  const backup = await captureFleetMemory({ ...f, source });
  await assert.rejects(checkpointFleetLedger({ ...f, backup }), /refused/);
  assert.equal(f.raw.prepare("SELECT sealed FROM tenant_tg_groups WHERE tenant=?").get(TENANT)!.sealed, sealed);
  assert.equal(f.raw.prepare("SELECT count(*) n FROM flows").get()!.n, 0, "source disagreement refused before financial copy");
});

test("cold rebuilt source refuses before moving the cursor and repeated invocation preserves shared positions and basis", async t => {
  const f = await fixture(t);
  f.raw.exec(MIRROR_STATE_DDL);
  f.raw.prepare("INSERT INTO mirror_state(tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, 'trades', 100, 900, 1000)").run(TENANT);
  f.raw.prepare("INSERT INTO positions(agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg, updated_at) VALUES (?, 'KEEP', '0xasset', '10', '1', 4, 0, 40, 900)").run(ACCOUNT);
  f.raw.prepare("INSERT INTO cost_basis(agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES (?, 'live', 'KEEP', '10', '20', 900)").run(ACCOUNT);
  const local = new DatabaseSync(path.join(f.home, "merrymen.db"));
  local.prepare("INSERT INTO trades(agent_id, kind, target, amount_usdg, status, created_at) VALUES (?, 'call', 'fixture', 1, 'rejected', 1001)").run(ACCOUNT);
  local.close();
  for (let n = 0; n < 2; n++) {
    await assert.rejects(checkpointFleetLedger(f), /refused/);
    assert.equal(f.raw.prepare("SELECT raw_balance FROM positions WHERE agent_id=?").get(ACCOUNT)!.raw_balance, "10");
    assert.equal(f.raw.prepare("SELECT cost_usdg FROM cost_basis WHERE agent_id=?").get(ACCOUNT)!.cost_usdg, "20");
    assert.equal(f.raw.prepare("SELECT last_id FROM mirror_state WHERE tenant=? AND table_name='trades'").get(TENANT)!.last_id, 100);
    assert.equal(f.raw.prepare("SELECT count(*) n FROM flows").get()!.n, 0);
  }
});
