import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { wrapSqlite } from "./db";
import { applyLedgerSchema, initStore, closeStoreForTest } from "./store";
import { captureBootstrapFlowCursor, ensureBootstrapFlowIdentity, readBootstrapFlowTotals } from "./bootstrap-flow-cursor";
import { durableNetContributionsUsdg6 } from "./net-contributions";
import { captureFinancialStream, restoreFinancialStream } from "./perps/hosted-financial-stream";
import { BOOTSTRAP_SCHEMA_VERSION, classifyAnchor } from "./bootstrap-state";

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000b1";
async function fixture() {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
  await applyLedgerSchema(db); await ensureBootstrapFlowIdentity(db);
  const add = async (amount: number, epoch = 1) => db.prepare("INSERT INTO flows (agent_id,direction,amount_usdg,source,epoch,at) VALUES (?,'in',?,'inferred',?,100)").run(ACCOUNT, amount, epoch);
  return { raw, db, add };
}

it("an empty cold boundary counts its first flow, including in the same second", async () => {
  const f = await fixture();
  try {
    const cursor = await captureBootstrapFlowCursor(f.db, ACCOUNT);
    assert.equal(cursor.lastId, 0);
    assert.deepEqual(await readBootstrapFlowTotals(f.db, ACCOUNT, 1, cursor), { netUsdg: null, sinceUsdg: 0 });
    await f.add(7);
    assert.deepEqual(await readBootstrapFlowTotals(f.db, ACCOUNT, 1, cursor), { netUsdg: 7, sinceUsdg: 7 });
  } finally { f.raw.close(); }
});

it("a distinct ledger with identical flow IDs and contents cannot reuse the boundary", async () => {
  const a = await fixture(), b = await fixture();
  try {
    await a.add(10); await b.add(10);
    const cursor = await captureBootstrapFlowCursor(a.db, ACCOUNT);
    assert.deepEqual(await readBootstrapFlowTotals(b.db, ACCOUNT, 1, cursor), { netUsdg: 10, sinceUsdg: null });
    assert.equal((await readBootstrapFlowTotals(a.db, OTHER, 1, cursor)).sinceUsdg, null);
    assert.equal((await readBootstrapFlowTotals(a.db, ACCOUNT, 2, cursor)).sinceUsdg, null);
  } finally { a.raw.close(); b.raw.close(); }
});

it("deleted or replaced prefix endpoints fail closed while preserving the local total", async () => {
  const f = await fixture();
  try {
    await f.add(10); const cursor = await captureBootstrapFlowCursor(f.db, ACCOUNT);
    await f.db.prepare("UPDATE flows SET amount_usdg = 20 WHERE id = ?").run(cursor.lastId);
    assert.deepEqual(await readBootstrapFlowTotals(f.db, ACCOUNT, 1, cursor), { netUsdg: 20, sinceUsdg: null });
    await f.db.prepare("DELETE FROM flows WHERE id = ?").run(cursor.lastId);
    assert.equal((await readBootstrapFlowTotals(f.db, ACCOUNT, 1, cursor)).sinceUsdg, null);
  } finally { f.raw.close(); }
});

it("destructive full recovery rotates the lineage even when it restores identical endpoints", async () => {
  const f = await fixture();
  try {
    await f.add(10); const cursor = await captureBootstrapFlowCursor(f.db, ACCOUNT);
    const chunks: Buffer[] = [];
    await f.db.tx(async tx => { for await (const chunk of captureFinancialStream(tx, ACCOUNT)) chunks.push(chunk); });
    await restoreFinancialStream(f.db, chunks, ACCOUNT);
    assert.equal((await readBootstrapFlowTotals(f.db, ACCOUNT, 1, cursor)).sinceUsdg, null);
    const replacement = await captureBootstrapFlowCursor(f.db, ACCOUNT);
    assert.notEqual(replacement.ledgerId, cursor.ledgerId);
    assert.equal((await readBootstrapFlowTotals(f.db, ACCOUNT, 1, replacement)).sinceUsdg, 0);
    await assert.rejects(restoreFinancialStream(f.db, chunks.slice(0, -1), ACCOUNT), /incomplete/);
    assert.equal((await captureBootstrapFlowCursor(f.db, ACCOUNT)).ledgerId, replacement.ledgerId, "failed restore rolls the identity rotation back too");
  } finally { f.raw.close(); }
});

it("legacy anchors parse, but an unproved suffix never becomes a known hosted contribution figure", async () => {
  const f = await fixture();
  try {
    await f.add(7);
    const verdict = classifyAnchor(JSON.stringify({ schemaVersion: BOOTSTRAP_SCHEMA_VERSION, tenantId: ACCOUNT, generatedAt: 100,
      accounting: { kind: "no-prior-accounting", observedAt: 100 } }), { tenantId: ACCOUNT, nowSec: 100 });
    assert.equal(verdict.kind, "valid");
    const local = await readBootstrapFlowTotals(f.db, ACCOUNT, 1, null);
    const input = { anchorNetUsdg6: 10_000_000n, anchorEpoch: 1, epoch: 1, localNetUsdg: local.netUsdg, localSinceAnchorUsdg: local.sinceUsdg };
    assert.equal(durableNetContributionsUsdg6(input), null);
    assert.equal(durableNetContributionsUsdg6({ ...input, anchorNetUsdg6: null }), 7_000_000n, "self-hosted local total still answers");
    assert.equal(durableNetContributionsUsdg6({ ...input, anchorEpoch: 2 }), 7_000_000n, "a different accounting epoch uses its local total");
  } finally { f.raw.close(); }
});

it("a legacy flow boundary survives the child's real startup migrations", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mm-flow-upgrade-"));
  const oldHome = process.env.MERRYMEN_HOME, oldUrl = process.env.DATABASE_URL;
  const raw = new DatabaseSync(path.join(home, "merrymen.db")), db = wrapSqlite(raw);
  try {
    await applyLedgerSchema(db); await ensureBootstrapFlowIdentity(db);
    await db.prepare("INSERT INTO agents (smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at) VALUES (?,?,?,4663,'{}',1,2000000000)").run(ACCOUNT, ACCOUNT, ACCOUNT);
    await db.exec("DROP TABLE flows; CREATE TABLE flows (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, direction TEXT NOT NULL, amount_usdg REAL NOT NULL, tx_hash TEXT, block_number INTEGER, source TEXT NOT NULL, at INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 1)");
    await db.prepare("INSERT INTO flows (agent_id,direction,amount_usdg,tx_hash,block_number,source,at) VALUES (?,'in',10,'0xABCDEF',100,'chain-log',100)").run(ACCOUNT);
    const cursor = await captureBootstrapFlowCursor(db, ACCOUNT);
    process.env.MERRYMEN_HOME = home; delete process.env.DATABASE_URL;
    await initStore();
    const migrated = await db.prepare("SELECT tx_hash, chain_id, log_index FROM flows").get() as { tx_hash: string; chain_id: number; log_index: number | null };
    assert.deepEqual({ ...migrated }, { tx_hash: "0xabcdef", chain_id: 4663, log_index: null });
    assert.deepEqual(await readBootstrapFlowTotals(db, ACCOUNT, 1, cursor), { netUsdg: 10, sinceUsdg: 0 });
  } finally {
    closeStoreForTest(); raw.close();
    if (oldHome === undefined) delete process.env.MERRYMEN_HOME; else process.env.MERRYMEN_HOME = oldHome;
    if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl;
    rmSync(home, { recursive: true, force: true });
  }
});
