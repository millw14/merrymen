/**
 * THE PERP BOOK CROSSES THE ORIGINAL-LEDGER BOUNDARY (ledger-import.ts), and a
 * Spot book without one crosses exactly as it always did.
 *
 *   perps     a Perps wallet's paper book — orders, legs, fills, funding, a
 *             gapped position with its recorded stop, the account row and a
 *             carry — is captured, staged and restored whole under its
 *             worker's key (`0x<owner>:perps`), bound to its own grant in
 *             perps_grants and its own home under children-perps/.
 *   settled   a book with a perp intent in flight, money in transit, a live
 *             row or signed venue bytes is never sealed.
 *   spot      a persistent Spot book last opened before the perp tables
 *             existed is still the book it was: existingBookIdentity and
 *             readBook pass it, and its digest is the digest it had.
 *   sweep     the Spot roster's sweep never touches a Perps receipt.
 */
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { openSecret } from "./store-crypto";
import {
  captureLedgerImport, invalidateLedgerImportsUnlessListed, registerLedgerSource, restoreLedgerImport, stageLedgerImport,
  verifyLedgerImport, verifyRestoredLedgerImport, type LedgerImportVolume,
} from "./ledger-import";
import type { TenantLease } from "./tenant-lease";
import { workerKey } from "./worker-key";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-perps-import-")));
const handles: DatabaseSync[] = [];
after(() => { for (const raw of handles) raw.close(); rmSync(root, { recursive: true, force: true }); });
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const dek = Buffer.alloc(32, 77);
const source = { deploymentId: "original-deployment", gitCommit: "1".repeat(40), orchestratorPid: 999, orchestratorStart: "original-start", quiescent: true, singleReplicaConfirmed: true };
const PERP_TABLES = ["perp_orders", "perp_order_legs", "perp_fills", "perp_funding", "perp_transfers", "perp_positions", "perp_accounts", "perp_carries"];
const REFUSED = /Original ledger import refused/;

let fixtureId = 0;
/** A source book, a shared store and a volume; `perps` makes the tenant a Perps wallet's worker. */
async function fixture(o: { perps?: boolean; empty?: boolean } = {}) {
  const id = ++fixtureId, owner = addr(0xf100 + id), account = addr(0xe100 + id);
  const tenant = workerKey(owner, o.perps ? "perps" : "spot");
  const dir = path.join(root, String(id)), sourceHome = path.join(dir, "original"), mountPath = path.join(dir, "volume"), homeRoot = path.join(mountPath, "fleet");
  mkdirSync(sourceHome, { recursive: true }); mkdirSync(homeRoot, { recursive: true });
  const st = lstatSync(mountPath, { bigint: true });
  const volume: LedgerImportVolume = { id: `vol_perps_${id}`, mountPath, homeRoot, device: String(st.dev), inode: String(st.ino) };
  const home = o.perps ? path.join(homeRoot, "children-perps", owner) : path.join(homeRoot, "children", owner);
  const raw = new DatabaseSync(path.join(sourceHome, "merrymen.db")), sharedRaw = new DatabaseSync(":memory:"); handles.push(raw, sharedRaw);
  const local = wrapSqlite(raw), shared = wrapSqlite(sharedRaw);
  await applyLedgerSchema(local); await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL); await shared.exec(PAPER_CHECKPOINT_SCHEMA);
  const grant = JSON.stringify({ smartAccount: account, owner, chainId: 4663 });
  sharedRaw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY,grant_json TEXT NOT NULL,updated_at INTEGER NOT NULL,row_version INTEGER NOT NULL)");
  if (o.perps) {
    sharedRaw.exec("CREATE TABLE perps_grants(tenant TEXT PRIMARY KEY,grant_json TEXT NOT NULL,updated_at INTEGER NOT NULL,row_version INTEGER NOT NULL)");
    // The owner's Spot wallet is another account, under the same owner: never this book's.
    sharedRaw.prepare("INSERT INTO grants VALUES(?,?,1000,10)").run(owner, JSON.stringify({ smartAccount: addr(0xd100 + id), owner, chainId: 4663 }));
    sharedRaw.prepare("INSERT INTO perps_grants VALUES(?,?,1001,11)").run(owner, grant);
  } else {
    sharedRaw.prepare("INSERT INTO grants VALUES(?,?,1000,10)").run(owner, grant);
  }
  let healthy = true;
  const lease: TenantLease = { tenant, backend: "postgres", healthy: () => healthy, async release() { healthy = false; } };
  if (!o.empty) {
    raw.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,status,epoch,mode) VALUES(?,?,?,4663,'{}',1,9999999999,'armed',1,'paper')").run(account, owner, addr(7));
    raw.prepare("INSERT INTO events(id,agent_id,level,message,created_at) VALUES(40,?,'ok','original event',1040)").run(account);
  }
  const capture = () => captureLedgerImport({ tenant, smartAccount: account, chainId: 4663, home: sourceHome, shared, dek, lease, source, assertSource() {}, dialect: "sqlite" });
  const options = { tenant, smartAccount: account, chainId: 4663, home, volume, shared, dek, lease, dialect: "sqlite" as const };
  return { tenant, owner, account, raw, local, shared, sharedRaw, sourceHome, home, volume, lease, capture, options };
}

/** A settled paper perp book, the shape the paper engine leaves (store.ts bookPaperPerp), with a stop that gapped. */
function paperPerpBook(raw: DatabaseSync, account: string): void {
  raw.prepare(`INSERT INTO perp_orders (id, agent_id, mode, epoch, nonce, status, effect, reduce_only, market_id, worst_notional_micro,
      filled_base, filled_quote_micro, created_at, resolved_at, updated_at)
    VALUES ('o1', ?, 'paper', 1, 1790000000001, 'filled', 'open', 0, 1, '16080000', '20', '16000000', 1000, 1000, 1000)`).run(account);
  raw.prepare(`INSERT INTO perp_order_legs (agent_id, mode, order_id, role, client_order_index, status, venue_status, created_at, updated_at)
    VALUES (?, 'paper', 'o1', 'entry', 14320000000008, 'filled', 'paper', 1000, 1000)`).run(account);
  raw.prepare(`INSERT INTO perp_order_legs (agent_id, mode, order_id, role, client_order_index, status, venue_status, created_at, updated_at)
    VALUES (?, 'paper', 'o1', 'sl', 14320000000009, 'cancelled', 'paper-gapped', 1000, 1200)`).run(account);
  raw.prepare(`INSERT INTO perp_fills (agent_id, mode, epoch, venue_trade_id, side_role, market_id, side, role, base, price, quote_micro, fee_micro,
      realized_micro, position_before, entry_quote_before_micro, trade_type, attribution, order_id, client_order_index, venue_ts_ms, created_at)
    VALUES (?, 'paper', 1, 'paper:open:1:1790000000001', 'bid', 1, 'long', 'taker', '20', '800000', '16000000', '0', '0', '0', '0', 'trade', 'intent', 'o1', 14320000000008, 1790000000001, 1000)`).run(account);
  raw.prepare(`INSERT INTO perp_funding (agent_id, mode, epoch, market_id, funding_id, funding_hour, payment_micro, rate_ppm, position_base, position_side, created_at)
    VALUES (?, 'paper', 1, 1, 'paper:funding:1:3600', 3600, '-192', 12, '20', 'long', 1100)`).run(account);
  raw.prepare(`INSERT INTO perp_positions (agent_id, mode, market_id, side, base, entry_price, allocated_margin_micro, imf_bp, margin_mode, realized_micro, funding_micro,
      stop_trigger, stop_price, recorded_stop_trigger, recorded_stop_price, take_trigger, take_price, funding_hour_applied, opened_at, updated_at, source)
    VALUES (?, 'paper', 1, 'long', '20', '800000', '7999808', 5000, 'isolated', '0', '-192', NULL, NULL, '760000', '744800', NULL, NULL, 3600, 1000, 1200, 'paper')`).run(account);
  raw.prepare(`INSERT INTO perp_accounts (agent_id, mode, nonce_high_water, paper_collateral_micro, created_at, updated_at)
    VALUES (?, 'paper', '1790000000001', '0', 1000, 1200)`).run(account);
  raw.prepare(`INSERT INTO perp_carries (agent_id, mode, epoch, market_id, side, base, mark_price, entry_quote_micro, created_at)
    VALUES (?, 'paper', 1, 1, 'long', '20', '800000', '16000000', 1000)`).run(account);
}

it("a Perps paper book — a gapped stop's recorded level included — is captured, staged and restored whole under its worker's key and its own home", async () => {
  const f = await fixture({ perps: true });
  paperPerpBook(f.raw, f.account);
  const mirrored = await mirrorTenant({ tenant: f.tenant, child: f.local, shared: f.shared });
  assert.equal(mirrored.failed, undefined, JSON.stringify(mirrored.failed));
  assert.equal(mirrored.copied.perp_positions, 1, "the mirror names the account through perps_grants");
  const artifact = await f.capture();
  assert.equal(artifact.tenant, f.tenant);
  await stageLedgerImport({ artifact, targetVolumeId: f.volume.id, shared: f.shared, dek, lease: f.lease, assertSource() {}, dialect: "sqlite" });
  const verified = await verifyLedgerImport({ artifact, home: f.sourceHome, shared: f.shared, dek, lease: f.lease, assertSource() {}, dialect: "sqlite" });
  assert.equal(verified.tables, 21 + 7, "every Spot table, and each perp table that holds a row");
  assert.equal(await restoreLedgerImport(f.options), "restored");
  assert.deepEqual(await verifyRestoredLedgerImport({ ...f.options, artifact, assertSource() {} }), verified);
  const imported = new DatabaseSync(path.join(f.home, "merrymen.db")); handles.push(imported);
  for (const table of PERP_TABLES) {
    assert.deepEqual(imported.prepare(`SELECT * FROM ${table}`).all(), f.raw.prepare(`SELECT * FROM ${table}`).all(), table);
  }
  const pos = imported.prepare("SELECT stop_trigger, recorded_stop_trigger, recorded_stop_price, funding_hour_applied FROM perp_positions").get() as Record<string, unknown>;
  assert.deepEqual({ ...pos }, { stop_trigger: null, recorded_stop_trigger: "760000", recorded_stop_price: "744800", funding_hour_applied: 3600 });
  // The receipt is the worker's key's, never the owner's: the Spot wallet's book has none.
  assert.deepEqual((f.sharedRaw.prepare("SELECT tenant, state FROM tenant_ledger_import").all() as Record<string, unknown>[]).map((r) => ({ ...r })), [{ tenant: f.tenant, state: "consumed" }]);
  // The imported book mirrors on with nothing booked twice.
  for (let i = 0; i < 2; i++) {
    const r = await mirrorTenant({ tenant: f.tenant, child: wrapSqlite(imported), shared: f.shared });
    assert.equal(r.failed, undefined, JSON.stringify(r.failed));
    assert.equal(r.restarted, undefined);
  }
  for (const table of ["perp_fills", "perp_funding", "perp_carries"]) {
    assert.equal(Number((f.sharedRaw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n), 1, table);
  }
  assert.equal(await restoreLedgerImport(f.options), "present", "an advanced persistent book is never overwritten");
});

it("a Perps worker's book is bound to its own wallet, its own grant and its own home, and to nothing else", async () => {
  const f = await fixture({ perps: true });
  paperPerpBook(f.raw, f.account);
  await mirrorTenant({ tenant: f.tenant, child: f.local, shared: f.shared });
  const artifact = await f.capture();
  await stageLedgerImport({ artifact, targetVolumeId: f.volume.id, shared: f.shared, dek, lease: f.lease, assertSource() {}, dialect: "sqlite" });
  // The Spot home's path for a Perps key, and a lease for the owner's other worker, both refuse.
  await assert.rejects(restoreLedgerImport({ ...f.options, home: path.join(f.volume.homeRoot, "children", f.owner) }), REFUSED);
  await assert.rejects(restoreLedgerImport({ ...f.options, lease: { ...f.lease, tenant: f.owner as `0x${string}` } }), REFUSED);
  // Not a worker key at all.
  await assert.rejects(restoreLedgerImport({ ...f.options, tenant: `${f.owner}:PERPS` }), REFUSED);
  // With its wallet's grant gone — the table itself, made lazily — there is nothing to bind to.
  f.sharedRaw.exec("DROP TABLE perps_grants");
  await assert.rejects(restoreLedgerImport(f.options), REFUSED);
  await assert.rejects(f.capture(), REFUSED);
});

it("a book with a perp intent in flight, money in transit, a live row or signed venue bytes is never sealed", async () => {
  const cases: Array<[string, (raw: DatabaseSync, account: string) => void]> = [
    ["an unanswered order", (raw) => raw.exec("UPDATE perp_orders SET status = 'submitted'")],
    ["an executed order whose fills are not booked", (raw) => raw.exec("UPDATE perp_orders SET status = 'executed'")],
    ["signed venue bytes", (raw) => raw.exec(`UPDATE perp_orders SET tx_info = '{"Sig":"c2ln"}'`)],
    ["a live row", (raw) => raw.exec("UPDATE perp_positions SET mode = 'live', source = 'venue'")],
    ["a deposit in transit", (raw, account) => raw.prepare(`INSERT INTO perp_transfers (id, agent_id, mode, epoch, direction, amount_micro, initiator, state)
      VALUES ('t1', ?, 'paper', 1, 'deposit', '5000000', 'agent', 'landed')`).run(account)],
    ["a withdrawal in transit", (raw, account) => raw.prepare(`INSERT INTO perp_transfers (id, agent_id, mode, epoch, direction, amount_micro, initiator, state)
      VALUES ('t1', ?, 'paper', 1, 'withdraw', '5000000', 'agent', 'executed')`).run(account)],
    ["a transfer not yet resolved", (raw, account) => raw.prepare(`INSERT INTO perp_transfers (id, agent_id, mode, epoch, direction, amount_micro, initiator, state)
      VALUES ('t1', ?, 'paper', 1, 'deposit', '5000000', 'agent', 'submitted')`).run(account)],
  ];
  for (const [what, breakIt] of cases) {
    const f = await fixture({ perps: true });
    paperPerpBook(f.raw, f.account);
    breakIt(f.raw, f.account);
    // Mirrored as the passing case below is, so the one difference is the breakage.
    await mirrorTenant({ tenant: f.tenant, child: f.local, shared: f.shared });
    await assert.rejects(f.capture(), REFUSED, what);
  }
  // …and a settled transfer, credited, is a book like any other.
  const f = await fixture({ perps: true });
  paperPerpBook(f.raw, f.account);
  f.raw.prepare(`INSERT INTO perp_transfers (id, agent_id, mode, epoch, direction, amount_micro, initiator, state, created_at, updated_at)
    VALUES ('t1', ?, 'paper', 1, 'deposit', '5000000', 'agent', 'credited', 1000, 1000)`).run(f.account);
  await mirrorTenant({ tenant: f.tenant, child: f.local, shared: f.shared });
  assert.ok(await f.capture());
});

it("a Spot book from before the perp tables is read, digested and restored as the book it was", async () => {
  const f = await fixture();
  await mirrorTenant({ tenant: f.tenant, child: f.local, shared: f.shared });
  const digestOf = (sealed: string) => (JSON.parse(openSecret(sealed, dek).split("\n").slice(1).join("\n")) as { sourceDigest: string; book: { tables: Record<string, unknown> } });
  const withTables = digestOf((await f.capture()).sealed);
  assert.deepEqual(Object.keys(withTables.book.tables).filter((t) => t.startsWith("perp_")), [], "an empty perp table is not in the book");
  for (const table of PERP_TABLES) f.raw.exec(`DROP TABLE ${table}`);
  const artifact = await f.capture();
  const without = digestOf(artifact.sealed);
  assert.equal(without.sourceDigest, withTables.sourceDigest, "the digest a Spot book had before the perp tables crossed");
  await stageLedgerImport({ artifact, targetVolumeId: f.volume.id, shared: f.shared, dek, lease: f.lease, assertSource() {}, dialect: "sqlite" });
  const verified = await verifyLedgerImport({ artifact, home: f.sourceHome, shared: f.shared, dek, lease: f.lease, assertSource() {}, dialect: "sqlite" });
  assert.equal(verified.tables, 21, "the tables every Spot book has always reported");
  assert.equal(await restoreLedgerImport(f.options), "restored", "a book the new schema gives empty perp tables is still the same book");
  assert.equal(await restoreLedgerImport(f.options), "present");
});

it("a persistent Spot book last opened before the perp tables passes existingBookIdentity on every spawn", async () => {
  // The held tenant's book: registered, armed by a worker, and never opened
  // by a build that made the perp tables. Every persistent spawn proves it
  // with existingBookIdentity before the worker runs its schema.
  const f = await fixture({ empty: true });
  await registerLedgerSource(f.options);
  const book = new DatabaseSync(path.join(f.home, "merrymen.db"));
  try {
    book.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at) VALUES(?,?,?,4663,'{}',1,9999999999)").run(f.account, f.owner, addr(7));
    for (const table of PERP_TABLES) book.exec(`DROP TABLE ${table}`);
  } finally { book.close(); }
  assert.equal(await restoreLedgerImport(f.options), "present");
  await registerLedgerSource(f.options);
});

it("the Spot roster's sweep never invalidates a Perps worker's receipt", async () => {
  const f = await fixture({ perps: true, empty: true });
  await registerLedgerSource(f.options);
  const spot = await fixture({ empty: true });
  // Share one store between the two, as one login's two workers do.
  const shared = f.shared;
  await shared.prepare(`INSERT INTO tenant_ledger_import(tenant,generation,target_volume_id,state,sealed,bytes,sha256,source_digest,bindings_json,created_at_ms,grant_updated_at,grant_row_version)
    VALUES(?,?,?,'consumed',NULL,0,'','','{}',1,'1','1')`).run(spot.tenant, "00000000-0000-4000-8000-000000000001", spot.volume.id);
  await invalidateLedgerImportsUnlessListed(shared, new Set(), Date.now());
  const states = Object.fromEntries((f.sharedRaw.prepare("SELECT tenant, state FROM tenant_ledger_import").all() as { tenant: string; state: string }[]).map((r) => [r.tenant, r.state]));
  assert.equal(states[f.tenant], "consumed", "a Perps receipt is never read as a removed Spot tenant's");
  assert.equal(states[spot.tenant], "deleted", "the sweep still runs for Spot");
});
