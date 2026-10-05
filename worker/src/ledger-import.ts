/** One-shot original ledger handover into a verified persistent home. Never a live snapshot ferry. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { assertLedgerSourceContinuity } from "./ledger-safeguard";
import { openSecret, sealSecret } from "./store-crypto";
import { fsyncDirSync, writeFileAtomicSync } from "./atomic-write";
import type { MemorySource } from "./memory-safeguard";
import type { TenantLease } from "./tenant-lease";
import { LEDGER_IMPORT_SCHEMA, LEDGER_IMPORT_GENERATIONS_SCHEMA, LEDGER_RESUME_ADDITIVE_DDL, LEDGER_RESUME_SCHEMA } from "./ledger-import-schema";
export { LEDGER_IMPORT_SCHEMA, LEDGER_IMPORT_GENERATIONS_SCHEMA, LEDGER_RESUME_SCHEMA } from "./ledger-import-schema";

export const LEDGER_IMPORT_PENDING_FILE = "ledger-import.pending.json";
export const LEDGER_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 250_000;
const HEADER = "ledger-source/v1 ";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOOK_ID_SCHEMA = `CREATE TABLE IF NOT EXISTS ledger_source_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1), book_id TEXT NOT NULL, tenant TEXT NOT NULL,
  smart_account TEXT NOT NULL, chain_id INTEGER NOT NULL
)`;
const refuse = () => new Error("Original ledger import refused; retain the original home and review source, authority, volume, generation or accounting continuity.");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(value));
}
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function address(v: unknown): string { if (typeof v !== "string" || !ADDRESS.test(v)) throw refuse(); return v; }
function present(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (e) { if ((e as { code?: unknown }).code === "ENOENT") return false; throw refuse(); }
}
function plain(file: string, directory: boolean): void {
  const s = lstatSync(file); if (directory ? !s.isDirectory() : !s.isFile()) throw refuse();
}
function privateBook(file: string): void {
  plain(file, false); const s = lstatSync(file);
  if ((s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid())) throw refuse();
}
function parentDirectories(file: string): void {
  for (let dir = path.resolve(file); ; dir = path.dirname(dir)) { plain(dir, true); if (dir === path.dirname(dir)) break; }
}
function syncFile(file: string): void {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// Compiled names/types, not sqlite_master's arbitrary tables or a raw DB export.
// New financial columns require review here; unknown signing/auth/chat tables never cross this boundary.
const SPECS = {
  agents: "smart_account:T name:T owner_address:T session_key_address:T chain_id:I caps:T granted_at:I expires_at:I status:T created_at:I hwm_usdg:R accrued_fee_usdg:R epoch:I mode:T beat_at:I sponsor_gas:I live_blocker:T energy:T x_handle:T x_verified:I contributions_known:I contributions_why:T gas_accounting:T quality_at:I hwm_withdrawn_usdg:R",
  events: "id:I agent_id:T level:T message:T created_at:I",
  posts: "id:I agent_id:T decision_id:T body:T created_at:I",
  trades: "id:I agent_id:T kind:T target:T sell_token:T buy_token:T amount_usdg:R user_op_hash:T tx_hash:T status:T reject_rule:T created_at:I sim_quote_out:T sim_min_out:T sim_fee_tier:I sim_gas:T decision_id:T fill_side:T fill_symbol:T fill_qty_raw:T fill_price_usd:R realized_pnl_usdg:R basis_source:T order_id:T settlement_status:T gas_wei:T sponsored_gas_wei:T epoch:I fill_slippage_bps:I fill_cash_usdg:R gas_usdg:R gas_units:T trade_fee_usdg:R user_op_nonce:T budget_settled_at:I",
  equity: "id:I agent_id:T eth_wei:T cash_usdg:R vault_usdg:R equity_usdg:R at:I positions_usdg:R epoch:I mode:T flows_held:I cash_read_at:I",
  flows: "id:I agent_id:T direction:T amount_usdg:R tx_hash:T block_number:I source:T at:I epoch:I log_index:I chain_id:I",
  fee_accruals: "id:I agent_id:T profit_usdg:R fee_usdg:R hwm_before_usdg:R hwm_after_usdg:R at:I epoch:I",
  journal: "seq:I agent_id:T epoch:I kind:T payload_json:T prev_hash:T hash:T at:I",
  decisions: "id:T agent_id:T source:T strategy:T provider:T model:T symbol:T action:T size_usdg:R reason:T dropped_rule:T signals_json:T evidence_json:T provenance:T display_name:T mark_usd:R mcap_usd:R at:I hold_kind:T",
  positions: "agent_id:T symbol:T token:T raw_balance:T ui_multiplier:T price_usd:R price_stale:I value_usdg:R updated_at:I price_source:T custody:T",
  paper_book: "agent_id:T cash_usdg:R vault_usdg:R hwm_usdg:R shares:T updated_at:I",
  cost_basis: "agent_id:T mode:T symbol:T qty_raw:T cost_usdg:T updated_at:I",
  position_floors: "agent_id:T mode:T symbol:T stop_bps:I rung:T why:T at:I",
  trench_positions: "agent_id:T mode:T symbol:T entry_liquidity_usd:R entry_sec:I",
  class_positions: "agent_id:T token:T symbol:T decimals:I curve:T quote_token:T first_seen:I vault:T entry_tx:T exit_tx:T cost_usdg:T qty_raw:T proceeds_usdg:T opened_at_block:T state:T swept_raw:T",
  risk_periods: "id:T agent_id:T started_at:I baseline_usdg:R hwm_usdg:R withdrawn_usdg:R reason:T",
  energy_days: "agent_id:T day:T reviews:I entries:I told_at:I read_at:I read_full:I entries_refunded:I",
  flows_quarantine: "original_id:I agent_id:T epoch:I direction:T amount_usdg:R tx_hash:T block_number:I log_index:I source:T at:I run_id:T quarantined_at:I reason:T replaced_by:T",
  brain_trigger_state: "agent_id:T state_json:T updated_at:I",
  agent_commands: "id:T agent_id:T kind:T created_at:I claimed_at:I done_at:I result:T args:T",
  discovered_pools: "address:T symbol:T first_seen:I decimals:I liquidity_usd:R fdv_usd:R pool_currency0:T pool_currency1:T pool_fee:I pool_tick_spacing:I pool_hooks:T curve:T quote_token:T pool_announced_at:I graduation_threshold:T",
} as const;
type Table = keyof typeof SPECS;
type Cell = null | string | number | { integer: string };
type Tables = Record<Table, Cell[][]>;
interface Book { tables: Tables; sequences: Record<string, string> }
const names = Object.keys(SPECS) as Table[];
const fields = (table: Table) => SPECS[table].split(" ").map(s => { const [name, type] = s.split(":"); return { name: name!, type: type! }; });
const autoincrement = ["events", "posts", "trades", "equity", "flows", "fee_accruals", "journal"];
function wire(value: unknown, type: string): Cell {
  if (value === null) return null;
  if (type === "I" && typeof value === "bigint" && value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return { integer: String(value) };
  if (type === "R" && typeof value === "number" && Number.isFinite(value)) return value;
  if (type === "T" && typeof value === "string" && Buffer.byteLength(value) <= LEDGER_IMPORT_MAX_BYTES) return value;
  throw refuse();
}
function unwire(value: Cell, type: string): string | number | bigint | null {
  if (value === null) return null;
  if (type === "I" && object(value) && typeof value.integer === "string" && /^-?(0|[1-9][0-9]*)$/.test(value.integer)) {
    const n = BigInt(value.integer); if (n >= -BigInt(Number.MAX_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)) return n;
  }
  if (type === "R" && typeof value === "number" && Number.isFinite(value)) return value;
  if (type === "T" && typeof value === "string") return value;
  throw refuse();
}
function readBook(raw: DatabaseSync, account: string, allowEmpty = false): Book {
  const tables = {} as Tables; let count = 0;
  for (const table of names) {
    const info = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
    const wanted = fields(table);
    if (info.length !== wanted.length || wanted.some(c => !info.some(i => i.name === c.name && i.type === ({ I: "INTEGER", R: "REAL", T: "TEXT" } as Record<string, string>)[c.type]))) throw refuse();
    const stmt = raw.prepare(`SELECT ${wanted.map(c => c.name).join(",")} FROM ${table} LIMIT ${MAX_ROWS + 1}`); stmt.setReadBigInts(true);
    const rows = stmt.all(); count += rows.length; if (count > MAX_ROWS) throw refuse();
    tables[table] = rows.map(row => {
      if (table !== "discovered_pools") {
        const id = table === "agents" ? row.smart_account : row.agent_id;
        if (typeof id !== "string" || id.toLowerCase() !== account) throw refuse();
      }
      return wanted.map(c => wire(row[c.name], c.type));
    }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  }
  if (tables.agents.length !== 1 && !(allowEmpty && tables.agents.length === 0 && names.every(t => tables[t].length === 0))) throw refuse();
  const sequences: Record<string, string> = {};
  const stmt = raw.prepare("SELECT name,seq FROM sqlite_sequence"); stmt.setReadBigInts(true);
  for (const row of stmt.all()) if (typeof row.name === "string" && autoincrement.includes(row.name)) {
    if (typeof row.seq !== "bigint" || row.seq < 0n || row.seq > BigInt(Number.MAX_SAFE_INTEGER)) throw refuse();
    sequences[row.name] = String(row.seq);
  }
  const out = { tables, sequences }; if (Buffer.byteLength(canonical(out)) > LEDGER_IMPORT_MAX_BYTES) throw refuse();
  return out;
}
function validateBook(book: unknown, account: string): asserts book is Book {
  if (!object(book) || !object(book.tables) || !object(book.sequences) || Object.keys(book.tables).sort().join() !== [...names].sort().join()) throw refuse();
  let count = 0;
  for (const table of names) {
    const rows = book.tables[table]; const cols = fields(table);
    if (!Array.isArray(rows)) throw refuse(); count += rows.length; if (count > MAX_ROWS) throw refuse();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== cols.length) throw refuse();
      row.forEach((v, i) => { unwire(v as Cell, cols[i]!.type); });
      if (table !== "discovered_pools") {
        const idx = cols.findIndex(c => c.name === (table === "agents" ? "smart_account" : "agent_id"));
        if (typeof row[idx] !== "string" || row[idx].toLowerCase() !== account) throw refuse();
      }
    }
  }
  if ((book.tables.agents as unknown[]).length !== 1) throw refuse();
  for (const [table, seq] of Object.entries(book.sequences)) if (!autoincrement.includes(table) || typeof seq !== "string" || !/^(0|[1-9][0-9]*)$/.test(seq) || BigInt(seq) > BigInt(Number.MAX_SAFE_INTEGER)) throw refuse();
}
function assertSettled(raw: DatabaseSync): void {
  if ((raw.prepare("SELECT count(*) AS n FROM trades WHERE status IN ('submitted','sent','pending')").get() as { n: number }).n
      || (raw.prepare("SELECT count(*) AS n FROM agent_commands WHERE done_at IS NULL").get() as { n: number }).n) throw refuse();
  // Store startup normalizes these historical fields. Reject an unsupported old source,
  // rather than advertise an exact import that its first schema pass would mutate.
  if (raw.prepare("SELECT 1 FROM flows WHERE tx_hash IS NOT NULL AND (tx_hash <> LOWER(tx_hash) OR chain_id IS NULL) LIMIT 1").get()) throw refuse();
}

type Dialect = "postgres" | "sqlite";
export interface LedgerGrantBinding { tenant: string; smartAccount: string; owner: string; chainId: number; updatedAt: string; rowVersion: string }
type GrantBinding = LedgerGrantBinding;
interface Bindings { grant: GrantBinding; marks: unknown[]; mutableDigest: string }
export interface LedgerGapBinding extends Bindings { digest: string }
interface Artifact {
  version: 1; generation: string; capturedAtMs: number; tenant: string; smartAccount: string; chainId: number;
  source: MemorySource; original: { homeDevice: string; homeInode: string; dbDevice: string; dbInode: string };
  bindings: Bindings; book: Book; sourceDigest: string;
}
export interface CapturedLedgerImport { tenant: string; generation: string; sealed: string; bytes: number; sha256: string }
export interface LedgerImportVolume { id: string; mountPath: string; homeRoot: string; device: string; inode: string }
function leaseOkay(lease: TenantLease, tenant: string): void {
  if (lease.tenant.toLowerCase() !== tenant || lease.backend !== "postgres" || !lease.healthy()) throw refuse();
}
async function grantBinding(db: Db, tenant: string, dialect: Dialect, lock = false): Promise<GrantBinding> {
  const row = await db.prepare(`SELECT tenant, lower(grant_json->>'smartAccount') AS account, lower(grant_json->>'owner') AS owner,
    grant_json->>'chainId' AS chain, ${dialect === "postgres" ? "updated_at::text AS updated, xmin::text AS incarnation" : "CAST(updated_at AS TEXT) AS updated, CAST(row_version AS TEXT) AS incarnation"}
    FROM grants WHERE tenant = ?${lock && dialect === "postgres" ? " FOR SHARE" : ""}`).get(tenant) as Record<string, unknown> | undefined;
  if (!row || row.tenant !== tenant || typeof row.updated !== "string" || !/^\d+$/.test(row.updated) || typeof row.incarnation !== "string" || !/^\d+$/.test(row.incarnation)
      || !Number.isSafeInteger(Number(row.chain)) || Number(row.chain) <= 0) throw refuse();
  return { tenant, smartAccount: address(row.account), owner: address(row.owner), chainId: Number(row.chain), updatedAt: row.updated, rowVersion: row.incarnation };
}
async function bindings(db: Db, tenant: string, account: string, dialect: Dialect, lock = false): Promise<Bindings> {
  const grant = await grantBinding(db, tenant, dialect, lock);
  const marks = await db.prepare("SELECT table_name,last_id,last_stamp,updated_at FROM mirror_state WHERE tenant = ? ORDER BY table_name").all(tenant);
  const mutable: Record<string, unknown> = {};
  // Settlements and historical accounting repairs can change rows without advancing
  // a source cursor. Bind those rows as well as the current position/basis snapshots.
  for (const table of names.filter(t => t !== "discovered_pools")) {
    const cols = fields(table).map(c => c.name).join(","); const key = table === "agents" ? "smart_account" : "agent_id";
    mutable[table] = (await db.prepare(`SELECT ${cols} FROM ${table} WHERE LOWER(${key}) = ?`).all(account)).map(r => canonical(r)).sort();
  }
  mutable.paper_checkpoints = (await db.prepare("SELECT agent_id,epoch,cash_usdg,vault_usdg,hwm_usdg,shares,basis_json,updated_at FROM paper_checkpoints WHERE LOWER(agent_id) = ?").all(account)).map(r => canonical(r)).sort();
  return { grant, marks, mutableDigest: hash(canonical(mutable)) };
}
/** Read-only evidence of a historical source gap. This does not prove or rebuild an original book. */
export async function readLedgerGapBinding(o: {
  tenant: string; smartAccount: string; chainId: number; shared: Db; lease: TenantLease;
  assertSource: () => void | Promise<void>; dialect?: Dialect;
}): Promise<LedgerGapBinding> {
  const tenant = address(o.tenant), account = address(o.smartAccount), dialect = o.dialect ?? "postgres";
  leaseOkay(o.lease, tenant); await o.assertSource();
  return o.shared.tx(async db => {
    const before = await bindings(db, tenant, account, dialect, true);
    if (before.grant.smartAccount !== account || before.grant.chainId !== o.chainId) throw refuse();
    await o.assertSource(); leaseOkay(o.lease, tenant);
    const after = await bindings(db, tenant, account, dialect, true);
    if (canonical(before) !== canonical(after)) throw refuse();
    await o.assertSource(); leaseOkay(o.lease, tenant);
    return { ...after, digest: hash(canonical(after)) };
  });
}
function openArtifact(captured: CapturedLedgerImport, dek: Buffer): Artifact {
  if (dek.length !== 32 || typeof captured.sealed !== "string" || Buffer.byteLength(captured.sealed) > LEDGER_IMPORT_MAX_BYTES * 2 || hash(captured.sealed) !== captured.sha256) throw refuse();
  const text = openSecret(captured.sealed, dek); const head = HEADER + address(captured.tenant) + "\n";
  if (!text.startsWith(head) || Buffer.byteLength(text) !== captured.bytes || captured.bytes > LEDGER_IMPORT_MAX_BYTES) throw refuse();
  const a: unknown = JSON.parse(text.slice(head.length));
  if (!object(a) || a.version !== 1 || a.tenant !== captured.tenant || a.generation !== captured.generation || typeof a.generation !== "string" || !UUID.test(a.generation)
      || !Number.isSafeInteger(a.capturedAtMs) || typeof a.smartAccount !== "string" || !ADDRESS.test(a.smartAccount) || !Number.isSafeInteger(a.chainId)
      || !object(a.bindings) || !object(a.bindings.grant) || !Array.isArray(a.bindings.marks) || typeof a.bindings.mutableDigest !== "string"
      || !object(a.source) || a.source.quiescent !== true || a.source.singleReplicaConfirmed !== true || !object(a.original) || typeof a.sourceDigest !== "string") throw refuse();
  validateBook(a.book, a.smartAccount);
  if (hash(canonical(a.book)) !== a.sourceDigest) throw refuse();
  return a as unknown as Artifact;
}
function volumeOkay(volume: LedgerImportVolume, home: string, tenant: string): void {
  if (!volume || typeof volume.id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(volume.id) || !path.isAbsolute(volume.mountPath) || !path.isAbsolute(volume.homeRoot)
      || path.resolve(home) !== path.join(path.resolve(volume.homeRoot), "children", tenant)) throw refuse();
  const relative = path.relative(path.resolve(volume.mountPath), path.resolve(volume.homeRoot));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw refuse();
  parentDirectories(volume.mountPath); parentDirectories(volume.homeRoot);
  const s = lstatSync(volume.mountPath, { bigint: true });
  if (String(s.dev) !== volume.device || String(s.ino) !== volume.inode) throw refuse();
  if (!present(path.dirname(home))) { mkdirSync(path.dirname(home), { mode: 0o700 }); fsyncDirSync(volume.homeRoot); }
  parentDirectories(path.dirname(home));
  if (!present(home)) { mkdirSync(home, { mode: 0o700 }); fsyncDirSync(path.dirname(home)); }
  parentDirectories(home);
  if (String(lstatSync(home, { bigint: true }).dev) !== volume.device) throw refuse();
}
function existingBookIdentity(file: string, account: string, chainId: number, volume: LedgerImportVolume): void {
  privateBook(file);
  if (String(lstatSync(file, { bigint: true }).dev) !== volume.device) throw refuse();
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    // Existing persistent books may grow beyond portable export limits. Prove
    // their ownership with bounded-result queries, without exporting/truncating them.
    const agents = raw.prepare("SELECT smart_account,chain_id FROM agents LIMIT 2").all() as Array<{ smart_account: string; chain_id: number }>;
    if (agents.length > 1 || agents.some(a => a.smart_account.toLowerCase() !== account || a.chain_id !== chainId)) throw refuse();
    for (const table of names) {
      if (table === "discovered_pools") continue;
      const key = table === "agents" ? "smart_account" : "agent_id";
      if (raw.prepare(`SELECT 1 FROM ${table} WHERE LOWER(${key}) <> ? OR ${key} IS NULL LIMIT 1`).get(account)) throw refuse();
      if (agents.length === 0 && raw.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw refuse();
    }
  } finally { raw.close(); }
}
function readSourceIdentity(raw: DatabaseSync, tenant: string, account: string, chainId: number): string {
  try {
    const rows = raw.prepare("SELECT book_id,tenant,smart_account,chain_id FROM ledger_source_identity LIMIT 2").all();
    const row = rows[0];
    if (rows.length !== 1 || !row || typeof row.book_id !== "string" || !UUID.test(row.book_id)
        || row.tenant !== tenant || row.smart_account !== account || row.chain_id !== chainId) throw refuse();
    return row.book_id;
  } catch { throw refuse(); }
}
function verifySourceIdentity(file: string, tenant: string, account: string, chainId: number, expected: unknown): void {
  if (typeof expected !== "string" || !UUID.test(expected)) throw refuse();
  privateBook(file); const raw = new DatabaseSync(file, { readOnly: true });
  try { if (readSourceIdentity(raw, tenant, account, chainId) !== expected) throw refuse(); }
  finally { raw.close(); }
}
function createSourceIdentity(raw: DatabaseSync, tenant: string, account: string, chainId: number, bookId: string): void {
  raw.exec(BOOK_ID_SCHEMA);
  raw.prepare("INSERT INTO ledger_source_identity(id,book_id,tenant,smart_account,chain_id) VALUES(1,?,?,?,?)").run(bookId, tenant, account, chainId);
  if (readSourceIdentity(raw, tenant, account, chainId) !== bookId) throw refuse();
}

export async function ensureLedgerImportSchema(shared: Db, dialect: Dialect = "postgres"): Promise<void> {
  void dialect;
  await shared.exec(LEDGER_IMPORT_SCHEMA);
  await shared.exec(LEDGER_IMPORT_GENERATIONS_SCHEMA);
}

/** The attested-gap tables (ledger-import-schema.ts). Additive; nothing else reads them. */
export async function ensureLedgerResumeSchema(shared: Db): Promise<void> {
  await ensureLedgerImportSchema(shared);
  for (const ddl of LEDGER_RESUME_SCHEMA) await shared.exec(ddl);
  // A column already there is sqlite's re-run, and expected; anything else
  // throws, and the registration that asked never writes a row without it.
  for (const ddl of LEDGER_RESUME_ADDITIVE_DDL) {
    try { await shared.exec(ddl); }
    catch (e) { if (!/duplicate column name/i.test(String((e as Error)?.message ?? ""))) throw e; }
  }
}

/** Called only by a reviewed operator after the final checkpoint, under stopped-writer/source proof. */
export async function captureLedgerImport(o: {
  tenant: string; smartAccount: string; chainId: number; home: string; shared: Db; dek: Buffer; lease: TenantLease;
  source: MemorySource; assertSource: () => void | Promise<void>; dialect?: Dialect;
}): Promise<CapturedLedgerImport> {
  const tenant = address(o.tenant), account = address(o.smartAccount), dialect = o.dialect ?? "postgres";
  leaseOkay(o.lease, tenant); await o.assertSource();
  if (o.dek.length !== 32 || !o.source.quiescent || !o.source.singleReplicaConfirmed || !o.source.deploymentId || !o.source.gitCommit || !o.source.orchestratorStart || !Number.isSafeInteger(o.source.orchestratorPid)) throw refuse();
  parentDirectories(o.home); const file = path.join(o.home, "merrymen.db"); plain(file, false);
  for (const name of [LEDGER_IMPORT_PENDING_FILE, "ledger-source-blocked.json", "restore-blocked.json", "energy-unrestored.json"]) if (present(path.join(o.home, name))) throw refuse();
  const hs = lstatSync(o.home, { bigint: true }), ds = lstatSync(file, { bigint: true });
  const raw = new DatabaseSync(file, { readOnly: true }); raw.exec("BEGIN");
  try {
    const book = readBook(raw, account); assertSettled(raw);
    const a = await o.shared.tx(async db => {
      leaseOkay(o.lease, tenant); await o.assertSource();
      const bound = await bindings(db, tenant, account, dialect, true);
      if (bound.grant.smartAccount !== account || bound.grant.chainId !== o.chainId) throw refuse();
      const agent = raw.prepare("SELECT owner_address,chain_id FROM agents").get() as { owner_address: string; chain_id: number };
      if (agent.owner_address.toLowerCase() !== bound.grant.owner || agent.chain_id !== o.chainId) throw refuse();
      await assertLedgerSourceContinuity(wrapSqlite(raw), db, tenant);
      leaseOkay(o.lease, tenant); await o.assertSource();
      const after = lstatSync(file, { bigint: true });
      if (after.dev !== ds.dev || after.ino !== ds.ino || after.size !== ds.size || after.mtimeNs !== ds.mtimeNs) throw refuse();
      return { version: 1 as const, generation: randomUUID(), capturedAtMs: Date.now(), tenant, smartAccount: account, chainId: o.chainId,
        source: { ...o.source }, original: { homeDevice: String(hs.dev), homeInode: String(hs.ino), dbDevice: String(ds.dev), dbInode: String(ds.ino) },
        bindings: bound, book, sourceDigest: hash(canonical(book)) };
    });
    const text = HEADER + tenant + "\n" + canonical(a); if (Buffer.byteLength(text) > LEDGER_IMPORT_MAX_BYTES) throw refuse();
    const sealed = sealSecret(text, o.dek);
    return { tenant, generation: a.generation, sealed, bytes: Buffer.byteLength(text), sha256: hash(sealed) };
  } finally { try { raw.exec("ROLLBACK"); } finally { raw.close(); } }
}

/** Insert once. Existing consumed/deleted records never accept a reseed, even with the old ciphertext. */
export async function stageLedgerImport(o: {
  artifact: CapturedLedgerImport; targetVolumeId: string; shared: Db; dek: Buffer; lease: TenantLease;
  assertSource: () => void | Promise<void>; dialect?: Dialect;
}): Promise<void> {
  const a = openArtifact(o.artifact, o.dek), dialect = o.dialect ?? "postgres";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(o.targetVolumeId) || Date.now() - a.capturedAtMs > 5 * 60_000 || a.capturedAtMs > Date.now() + 10_000) throw refuse();
  await ensureLedgerImportSchema(o.shared, dialect);
  await o.shared.tx(async db => {
    leaseOkay(o.lease, a.tenant); await o.assertSource();
    if (canonical(await bindings(db, a.tenant, a.smartAccount, dialect, true)) !== canonical(a.bindings)) throw refuse();
    const oldGeneration = await db.prepare("SELECT tenant,state FROM tenant_ledger_import_generations WHERE generation = ?").get(a.generation) as Record<string, unknown> | undefined;
    if (oldGeneration && (oldGeneration.tenant !== a.tenant || oldGeneration.state !== "available")) throw refuse();
    await db.prepare(`INSERT INTO tenant_ledger_import(tenant,generation,target_volume_id,state,sealed,bytes,sha256,source_digest,bindings_json,created_at_ms,grant_updated_at,grant_row_version)
      VALUES(?,?,?,'available',?,?,?,?,?,?,?,?) ON CONFLICT (tenant) DO NOTHING`)
      .run(a.tenant, a.generation, o.targetVolumeId, o.artifact.sealed, o.artifact.bytes, o.artifact.sha256, a.sourceDigest, canonical(a.bindings), Date.now(), a.bindings.grant.updatedAt, a.bindings.grant.rowVersion);
    const row = await db.prepare("SELECT generation,state,sealed,target_volume_id FROM tenant_ledger_import WHERE tenant = ?").get(a.tenant) as Record<string, unknown>;
    if (row.generation !== a.generation || row.state !== "available" || row.sealed !== o.artifact.sealed || row.target_volume_id !== o.targetVolumeId) throw refuse();
    await db.prepare("INSERT INTO tenant_ledger_import_generations(generation,tenant,state) VALUES(?,?,'available') ON CONFLICT (generation) DO NOTHING").run(a.generation, a.tenant);
    leaseOkay(o.lease, a.tenant); await o.assertSource();
  });
}

interface Pending { version: 1; generation: string; sourceDigest: string; volumeId: string }
function readPending(home: string): Pending | null {
  const file = path.join(home, LEDGER_IMPORT_PENDING_FILE); if (!present(file)) return null;
  plain(file, false); const s = lstatSync(file); if (s.size > 4096) throw refuse();
  const p: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!object(p) || p.version !== 1 || typeof p.generation !== "string" || !UUID.test(p.generation) || typeof p.sourceDigest !== "string" || !/^[0-9a-f]{64}$/.test(p.sourceDigest) || typeof p.volumeId !== "string") throw refuse();
  return p as unknown as Pending;
}
async function buildStage(file: string, a: Artifact): Promise<void> {
  if (present(file)) throw refuse();
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); fchmodSync(fd, 0o600); closeSync(fd);
  const raw = new DatabaseSync(file);
  try {
    raw.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL");
    await applyLedgerSchema(wrapSqlite(raw)); raw.exec("BEGIN IMMEDIATE");
    try {
      for (const table of names) {
        const cols = fields(table); const stmt = raw.prepare(`INSERT INTO ${table}(${cols.map(c => c.name).join(",")}) VALUES(${cols.map(() => "?").join(",")})`);
        for (const row of a.book.tables[table]) stmt.run(...row.map((v, i) => unwire(v, cols[i]!.type)));
      }
      for (const table of autoincrement) {
        raw.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
        if (a.book.sequences[table] !== undefined) raw.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)").run(table, BigInt(a.book.sequences[table]!));
      }
      createSourceIdentity(raw, a.tenant, a.smartAccount, a.chainId, a.generation);
      if (hash(canonical(readBook(raw, a.smartAccount))) !== a.sourceDigest) throw refuse();
      raw.exec("COMMIT");
    } catch (e) { raw.exec("ROLLBACK"); throw e; }
    // Simulate the worker's next idempotent schema pass; it must not silently normalize the imported facts.
    await applyLedgerSchema(wrapSqlite(raw));
    if (hash(canonical(readBook(raw, a.smartAccount))) !== a.sourceDigest) throw refuse();
    assertSettled(raw);
  } finally { raw.close(); }
  syncFile(file); fsyncDirSync(path.dirname(file));
}
function sameBook(file: string, account: string, digest: string): void {
  privateBook(file); const raw = new DatabaseSync(file, { readOnly: true });
  try { if (hash(canonical(readBook(raw, account))) !== digest) throw refuse(); }
  finally { raw.close(); }
}

/** Before ANY step may create/open a new child book. The caller holds the same live tenant lease through fork. */
export async function restoreLedgerImport(o: {
  tenant: string; smartAccount: string; chainId: number; home: string; volume: LedgerImportVolume;
  shared: Db; dek: Buffer; lease: TenantLease; dialect?: Dialect;
}): Promise<"none" | "present" | "restored" | "resumed"> {
  const tenant = address(o.tenant), account = address(o.smartAccount), dialect = o.dialect ?? "postgres";
  leaseOkay(o.lease, tenant); volumeOkay(o.volume, o.home, tenant);
  await ensureLedgerImportSchema(o.shared, dialect);
  const file = path.join(o.home, "merrymen.db"), marker = path.join(o.home, LEDGER_IMPORT_PENDING_FILE);
  return o.shared.tx<"none" | "present" | "restored" | "resumed"> (async db => {
    leaseOkay(o.lease, tenant);
    // Match explicit deletion's grant -> import lock order, never the inverse.
    const currentGrant = await grantBinding(db, tenant, dialect, true);
    if (currentGrant.smartAccount !== account || currentGrant.chainId !== o.chainId) throw refuse();
    const row = await db.prepare(`SELECT * FROM tenant_ledger_import WHERE tenant = ?${dialect === "postgres" ? " FOR UPDATE" : ""}`).get(tenant) as Record<string, unknown> | undefined;
    const pending = readPending(o.home);
    if (!row || row.state === "deleted") { if (pending) throw refuse(); return "none"; }
    if (row.target_volume_id !== o.volume.id) throw refuse();
    if (row.state === "consumed") {
      const original = JSON.parse(String(row.bindings_json)) as Bindings;
      if (original.grant.smartAccount !== account || original.grant.chainId !== o.chainId) throw refuse();
      if (!present(file)) throw refuse();
      if (row.source_inode !== String(lstatSync(file, { bigint: true }).ino)) throw refuse();
      verifySourceIdentity(file, tenant, account, o.chainId, row.source_identity);
      if (!pending) {
        existingBookIdentity(file, account, o.chainId, o.volume);
        leaseOkay(o.lease, tenant); return "present";
      }
      if (pending.generation !== row.generation || pending.sourceDigest !== row.source_digest || pending.volumeId !== o.volume.id) throw refuse();
      sameBook(file, account, pending.sourceDigest); leaseOkay(o.lease, tenant);
      const stage = path.join(o.home, `ledger-import-${pending.generation}.sqlite`);
      if (present(stage)) {
        plain(stage, false); const a = lstatSync(stage, { bigint: true }), b = lstatSync(file, { bigint: true });
        if (a.dev !== b.dev || a.ino !== b.ino) throw refuse();
        rmSync(stage);
      }
      rmSync(marker); fsyncDirSync(o.home); return "resumed";
    }
    if (row.state !== "available") throw refuse();
    const artifact: CapturedLedgerImport = { tenant, generation: String(row.generation), sealed: String(row.sealed), bytes: Number(row.bytes), sha256: String(row.sha256) };
    const a = openArtifact(artifact, o.dek);
    if (a.smartAccount !== account || a.chainId !== o.chainId || row.source_digest !== a.sourceDigest || row.bindings_json !== canonical(a.bindings)
        || canonical(await bindings(db, tenant, account, dialect, true)) !== canonical(a.bindings)) throw refuse();
    const expected: Pending = { version: 1, generation: a.generation, sourceDigest: a.sourceDigest, volumeId: o.volume.id };
    if (pending && canonical(pending) !== canonical(expected)) throw refuse();
    if (!pending && present(file)) throw refuse();
    if (!pending) writeFileAtomicSync(marker, canonical(expected), 0o600, { durable: true });
    const stage = path.join(o.home, `ledger-import-${a.generation}.sqlite`);
    if (!present(file)) {
      if (present(stage)) {
        // A crash before publication may leave either a complete stage or a partial schema.
        // Only this generation's private staging path is removable; never the destination book.
        plain(stage, false); try { sameBook(stage, account, a.sourceDigest); verifySourceIdentity(stage, tenant, account, o.chainId, a.generation); }
        catch {
          for (const suffix of ["", "-journal", "-wal", "-shm"]) {
            const partial = stage + suffix;
            if (present(partial)) { plain(partial, false); rmSync(partial); }
          }
          fsyncDirSync(o.home);
        }
      }
      if (!present(stage)) await buildStage(stage, a);
      leaseOkay(o.lease, tenant); volumeOkay(o.volume, o.home, tenant);
      if (canonical(await bindings(db, tenant, account, dialect, true)) !== canonical(a.bindings)) throw refuse();
      // link is atomic and cannot overwrite a ledger another writer created. Same filesystem.
      linkSync(stage, file); fsyncDirSync(o.home);
    }
    sameBook(file, account, a.sourceDigest);
    verifySourceIdentity(file, tenant, account, o.chainId, a.generation);
    if (String(lstatSync(file, { bigint: true }).dev) !== o.volume.device) throw refuse();
    const raw = new DatabaseSync(file, { readOnly: true });
    try { await assertLedgerSourceContinuity(wrapSqlite(raw), db, tenant); } finally { raw.close(); }
    leaseOkay(o.lease, tenant);
    if (canonical(await bindings(db, tenant, account, dialect, true)) !== canonical(a.bindings)) throw refuse();
    const changed = await db.prepare("UPDATE tenant_ledger_import SET state = 'consumed', sealed = NULL, bytes = 0, consumed_at_ms = ?, source_inode = ?, source_identity = ? WHERE tenant = ? AND generation = ? AND state = 'available'")
      .run(Date.now(), String(lstatSync(file, { bigint: true }).ino), a.generation, tenant, a.generation);
    if (changed.changes !== 1) throw refuse();
    await db.prepare("UPDATE tenant_ledger_import_generations SET state = 'consumed' WHERE generation = ? AND tenant = ? AND state = 'available'").run(a.generation, tenant);
    leaseOkay(o.lease, tenant);
    // Marker deliberately survives this transaction. A caller returning after COMMIT
    // finishes via the consumed branch: even a lost COMMIT acknowledgement cannot replay.
    return "restored";
  }).then(async result => {
    if (result !== "restored") return result;
    // The row is now durably consumed before this local writer barrier disappears.
    return restoreLedgerImport(o).then(() => "restored" as const);
  });
}

/** Permanent nonpayload generation receipt. Permission replacement must never call this. */
export async function invalidateLedgerImport(tenant: string, shared: Db, o: {
  beforeMs?: number; expectedGrant?: { updatedAt: string; rowVersion: string }; absentOnly?: boolean;
} = {}): Promise<void> {
  address(tenant); const before = o.beforeMs ?? Date.now(); if (!Number.isSafeInteger(before)) throw refuse();
  await shared.tx(async db => {
    const args = [tenant, before, ...(o.expectedGrant ? [o.expectedGrant.updatedAt, o.expectedGrant.rowVersion] : [])];
    const where = `tenant = ? AND created_at_ms <= ?${o.expectedGrant ? " AND grant_updated_at = ? AND grant_row_version = ?" : ""}${o.absentOnly ? " AND NOT EXISTS (SELECT 1 FROM grants WHERE grants.tenant = tenant_ledger_import.tenant)" : ""}`;
    await db.prepare(`UPDATE tenant_ledger_import_generations SET state = 'deleted' WHERE tenant = ? AND generation IN (SELECT generation FROM tenant_ledger_import WHERE ${where})`).run(tenant, ...args);
    await db.prepare(`UPDATE tenant_ledger_import SET state = 'deleted', sealed = NULL, bytes = 0 WHERE ${where}`).run(...args);
  });
}
export async function invalidateLedgerImportsUnlessListed(shared: Db, wanted: ReadonlySet<string>, listedAtMs: number): Promise<void> {
  if (!Number.isSafeInteger(listedAtMs)) throw refuse();
  const rows = await shared.prepare("SELECT tenant FROM tenant_ledger_import WHERE state <> 'deleted' AND created_at_ms <= ? ORDER BY tenant LIMIT 128").all(listedAtMs) as Array<{ tenant: string }>;
  for (const row of rows) if (!wanted.has(address(row.tenant))) await invalidateLedgerImport(row.tenant, shared, { beforeMs: listedAtMs, absentOnly: true });
}

/** Every genuinely new empty book gets a nonpayload receipt before its first fork. */
export async function registerLedgerSource(o: {
  tenant: string; smartAccount: string; chainId: number; home: string; volume: LedgerImportVolume;
  shared: Db; lease: TenantLease; dialect?: Dialect;
}): Promise<void> {
  const tenant = address(o.tenant), account = address(o.smartAccount), dialect = o.dialect ?? "postgres";
  leaseOkay(o.lease, tenant); volumeOkay(o.volume, o.home, tenant);
  const file = path.join(o.home, "merrymen.db"); if (present(file)) plain(file, false);
  if (readPending(o.home) || present(path.join(o.home, "ledger-source-blocked.json"))) throw refuse();
  await ensureLedgerImportSchema(o.shared, dialect);
  await o.shared.tx(async db => {
    leaseOkay(o.lease, tenant);
    const current = await grantBinding(db, tenant, dialect, true);
    const prior = await db.prepare(`SELECT state,target_volume_id,bindings_json,source_inode,source_identity FROM tenant_ledger_import WHERE tenant = ?${dialect === "postgres" ? " FOR UPDATE" : ""}`).get(tenant) as Record<string, unknown> | undefined;
    if (current.smartAccount !== account || current.chainId !== o.chainId) throw refuse();
    if (prior && prior.state !== "deleted") {
      const original = JSON.parse(String(prior.bindings_json)) as Bindings;
      if (prior.state !== "consumed" || prior.target_volume_id !== o.volume.id || original.grant.smartAccount !== account || original.grant.chainId !== o.chainId) throw refuse();
      existingBookIdentity(file, account, o.chainId, o.volume);
      if (prior.source_inode !== String(lstatSync(file, { bigint: true }).ino)) throw refuse();
      verifySourceIdentity(file, tenant, account, o.chainId, prior.source_identity);
      return;
    }
    if (prior?.state === "deleted") {
      const original = JSON.parse(String(prior.bindings_json)) as Bindings;
      if (!present(file) || prior.target_volume_id !== o.volume.id || original.grant.smartAccount !== account || original.grant.chainId !== o.chainId
          || original.grant.owner !== current.owner || prior.source_inode !== String(lstatSync(file, { bigint: true }).ino)) throw refuse();
      existingBookIdentity(file, account, o.chainId, o.volume);
      verifySourceIdentity(file, tenant, account, o.chainId, prior.source_identity);
      const raw = new DatabaseSync(file, { readOnly: true });
      try { assertSettled(raw); await assertLedgerSourceContinuity(wrapSqlite(raw), db, tenant); }
      finally { raw.close(); }
      leaseOkay(o.lease, tenant);
      const generation = randomUUID(), bound = { grant: current, marks: [], mutableDigest: hash("reattached-original-source") };
      const changed = await db.prepare(`UPDATE tenant_ledger_import SET generation=?,state='consumed',sealed=NULL,bytes=0,sha256='',source_digest='',bindings_json=?,created_at_ms=?,consumed_at_ms=?,grant_updated_at=?,grant_row_version=? WHERE tenant=? AND state='deleted'`)
        .run(generation, canonical(bound), Date.now(), Date.now(), current.updatedAt, current.rowVersion, tenant);
      if (changed.changes !== 1) throw refuse();
      await db.prepare("INSERT INTO tenant_ledger_import_generations(generation,tenant,state) VALUES(?,?,'consumed')").run(generation, tenant);
      leaseOkay(o.lease, tenant); return;
    }
    const marks = await db.prepare("SELECT last_id FROM mirror_state WHERE tenant = ?").all(tenant) as Array<{ last_id: unknown }>;
    if (marks.some(m => String(m.last_id) !== "0")) throw refuse();
    for (const table of names.filter(t => t !== "discovered_pools")) {
        const key = table === "agents" ? "smart_account" : "agent_id";
        const row = await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE LOWER(${key}) = ?`).get(account) as { n: unknown };
        if (Number(row.n) !== 0) throw refuse();
    }
    const checkpoint = await db.prepare("SELECT 1 FROM paper_checkpoints WHERE LOWER(agent_id) = ? LIMIT 1").get(account);
    if (checkpoint) throw refuse();
    if (!present(file)) {
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); fchmodSync(fd, 0o600); closeSync(fd);
      const created = new DatabaseSync(file);
      try { await applyLedgerSchema(wrapSqlite(created)); } finally { created.close(); }
      syncFile(file); fsyncDirSync(o.home);
    }
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      for (const table of names) if ((raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n !== 0) throw refuse();
      const stmt = raw.prepare("SELECT name,seq FROM sqlite_sequence"); stmt.setReadBigInts(true);
      if (stmt.all().some(row => typeof row.name === "string" && autoincrement.includes(row.name) && row.seq !== 0n)) throw refuse();
    } finally { raw.close(); }
    // No prior receipt exists and the complete local/shared book was proved empty.
    // Persist one nonsecret incarnation inside SQLite before its external receipt.
    const writable = new DatabaseSync(file); let identity: string;
    try {
      writable.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
      try {
        if (writable.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_source_identity'").get()) identity = readSourceIdentity(writable, tenant, account, o.chainId);
        else { identity = randomUUID(); createSourceIdentity(writable, tenant, account, o.chainId, identity); }
        writable.exec("COMMIT");
      } catch (e) { writable.exec("ROLLBACK"); throw e; }
    } finally { writable.close(); }
    const generation = randomUUID(), bound = { grant: current, marks: [], mutableDigest: hash("new-empty-source") };
    chmodSync(file, 0o600); syncFile(file); fsyncDirSync(o.home);
    await db.prepare(`INSERT INTO tenant_ledger_import(tenant,generation,target_volume_id,state,sealed,bytes,sha256,source_digest,source_inode,source_identity,bindings_json,created_at_ms,consumed_at_ms,grant_updated_at,grant_row_version)
      VALUES(?,?,?,'consumed',NULL,0,'','',?,?,?,?,?,?,?)`)
      .run(tenant, generation, o.volume.id, String(lstatSync(file, { bigint: true }).ino), identity, canonical(bound), Date.now(), Date.now(), current.updatedAt, current.rowVersion);
    await db.prepare("INSERT INTO tenant_ledger_import_generations(generation,tenant,state) VALUES(?,?,'consumed')").run(generation, tenant);
    leaseOkay(o.lease, tenant);
  });
}

/**
 * THE SNAPSHOT TABLES THE FIRST MIRROR PASS OF A NEW BOOK REPLACES per agent
 * (ledger-mirror.ts: delete-then-insert for positions, and for basis, floors
 * and the class book whenever no cursor rewound). Their rows as they stand at
 * admission are archived, row by row, before that can happen.
 */
export const ATTESTED_SNAPSHOT_TABLES = ["positions", "cost_basis", "position_floors", "class_positions"] as const;

/** What an attested-gap registration archived and bound. Digests only. */
export interface AttestedGapReceipt { generation: string; receiptDigest: string; mirrorStateDigest: string; snapshotDigest: string }

/**
 * BRING THE ATTESTED BOOK AT `file` TO "EMPTY, WITH THIS GENERATION AS ITS
 * IDENTITY", from wherever an earlier call stopped: just created (0 bytes),
 * schema half or wholly applied, or finished. Idempotent.
 *
 * An identity already present must be this generation's (anything else is
 * another book: refuse). With none, the file must hold no row in ANY table,
 * named or not, and no non-zero sequence, before anything is written into it:
 * the proof that it is the empty book this generation created and nobody
 * else's. Then the schema (idempotent) and the identity, in one SQLite
 * transaction, synchronous and journalled so a crash inside it rolls back to
 * the identity-less state this function starts from.
 */
async function finishAttestedBook(file: string, tenant: string, account: string, chainId: number, generation: string): Promise<void> {
  const raw = new DatabaseSync(file);
  try {
    raw.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL");
    if (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_source_identity'").get()) {
      if (readSourceIdentity(raw, tenant, account, chainId) !== generation) throw refuse();
      return;
    }
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: unknown }>)
      .map(t => String(t.name));
    for (const table of tables) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(table)) throw refuse();
      if ((raw.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n !== 0) throw refuse();
    }
    if (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get()) {
      const stmt = raw.prepare("SELECT seq FROM sqlite_sequence"); stmt.setReadBigInts(true);
      if (stmt.all().some(row => row.seq !== 0n)) throw refuse();
    }
    await applyLedgerSchema(wrapSqlite(raw));
    raw.exec("BEGIN IMMEDIATE");
    try { createSourceIdentity(raw, tenant, account, chainId, generation); raw.exec("COMMIT"); }
    catch (e) { raw.exec("ROLLBACK"); throw e; }
  } finally { raw.close(); }
}

/**
 * A NEW EMPTY BOOK FOR A TENANT WITH HISTORY, UNDER AN OPERATOR'S APPROVAL.
 *
 * The narrow variant of registerLedgerSource's new-book branch, and the only
 * one. That branch refuses whenever Postgres holds a cursor or a financial row
 * for the account, and rightly: an empty book beside history would be read by
 * the next mirror pass as a ledger that went backwards. Every tenant from
 * before 2026-10-04 03:18 has history and no surviving book (homes were
 * always rebuilt from the mirror; that deploy rebuilt them over nothing), so
 * that branch refuses all of them, forever.
 *
 * This replaces the "no shared financial rows" refusal with an attestation,
 * and nothing else. In ONE transaction, under the same lease and grant lock:
 *
 *  - the approval must be the one ledger-resume.ts archived the home under
 *    (state `archived`, this generation, this evidence digest), and the
 *    caller's re-check of the gap preconditions must pass inside it;
 *  - every mirror_state row for the tenant is copied to mirror_state_archive
 *    and deleted, so no cursor of the lost book can be read against the new
 *    one (assertLedgerSourceContinuity has nothing to compare, by design);
 *  - the four snapshot tables' rows are copied to ledger_snapshot_archive.
 *    They are NOT changed here; the first mirror pass replaces them with the
 *    seeded set, as every redeploy did before the incident;
 *  - the empty book is created O_EXCL, with this generation as its identity,
 *    and its consumed receipt in tenant_ledger_import is bound to
 *    hash('attested-gap:' + approval + ':' + evidence). A receipt from an
 *    earlier generation is superseded (its generation row marked deleted),
 *    never reused. A staged original import (`available`) refuses: an operator
 *    put a book there, and this does not override it;
 *  - the attestation row, with the chain window the caller read for it
 *    (`chainRead`: its first block and the head it reached, the head read
 *    immediately before this call; null only for a tenant that needed no
 *    chain read), and the approval's move to `registered`.
 *
 * NO FINANCIAL ROW IS WRITTEN OR CHANGED, and nothing is imported, so nothing
 * becomes replayable. The accounting epoch, peaks and fees continue from
 * Postgres through the ordinary anchor (writeBootstrapForChild), as before.
 *
 * RE-ENTRY IS KEYED BY GENERATION. A crash after the book was created and
 * before the commit leaves an empty book whose identity IS this generation;
 * the next call proves that and continues. A crash between the O_EXCL create
 * and the identity's commit — Railway's SIGKILL at the end of the drain, an
 * OOM kill, ENOSPC inside the schema — leaves a 0-byte or schema-only book
 * with NO identity, and that is this call's own too: it is proved to hold no
 * row in any table before its schema and this generation are written into
 * it (finishAttestedBook), exactly as registerLedgerSource finishes its own
 * interrupted empty book. Without that, every retry refused and the approval
 * sat `archived` for good. Any other file at the path — a row anywhere, or
 * another generation's identity — refuses.
 */
export async function registerAttestedGapSource(o: {
  tenant: string; smartAccount: string; chainId: number; owner: string; home: string; volume: LedgerImportVolume;
  shared: Db; lease: TenantLease; dialect?: Dialect;
  approvalId: string; evidenceDigest: string; generation: string; archivePath: string | null; gapFromSec: number | null;
  /** The chain window read for this registration, first block to head (decimal, inclusive), or null where none was needed. */
  chainRead: { fromBlock: string; head: string } | null;
  /** The gap preconditions, re-read inside the transaction. Throws to refuse. */
  recheck: (db: Db) => Promise<void>;
}): Promise<AttestedGapReceipt> {
  const tenant = address(o.tenant), account = address(o.smartAccount), owner = address(o.owner), dialect = o.dialect ?? "postgres";
  if (!UUID.test(o.generation) || !UUID.test(o.approvalId) || !/^[0-9a-f]{64}$/.test(o.evidenceDigest)) throw refuse();
  const block = /^(0|[1-9][0-9]{0,29})$/;
  if (o.chainRead && (!block.test(o.chainRead.fromBlock) || !block.test(o.chainRead.head) || BigInt(o.chainRead.head) < BigInt(o.chainRead.fromBlock))) throw refuse();
  leaseOkay(o.lease, tenant); volumeOkay(o.volume, o.home, tenant);
  if (readPending(o.home) || present(path.join(o.home, "ledger-source-blocked.json"))) throw refuse();
  const file = path.join(o.home, "merrymen.db");
  await ensureLedgerResumeSchema(o.shared);
  const forUpdate = dialect === "postgres" ? " FOR UPDATE" : "";
  return o.shared.tx(async db => {
    leaseOkay(o.lease, tenant);
    const current = await grantBinding(db, tenant, dialect, true);
    if (current.smartAccount !== account || current.chainId !== o.chainId || current.owner !== owner) throw refuse();
    const approval = await db.prepare(`SELECT state, generation, evidence_digest, smart_account, chain_id, owner FROM ledger_resume_approvals WHERE approval_id = ?${forUpdate}`)
      .get(o.approvalId) as Record<string, unknown> | undefined;
    if (!approval || approval.state !== "archived" || approval.generation !== o.generation || approval.evidence_digest !== o.evidenceDigest
        || approval.smart_account !== account || Number(approval.chain_id) !== o.chainId || approval.owner !== owner) throw refuse();
    await o.recheck(db);
    const prior = await db.prepare(`SELECT state, generation FROM tenant_ledger_import WHERE tenant = ?${forUpdate}`).get(tenant) as Record<string, unknown> | undefined;
    if (prior && prior.state === "available") throw refuse();
    const now = Date.now();
    // The lost book's cursors: archived exactly, then removed.
    const marks = await db.prepare("SELECT table_name, last_id, last_stamp, updated_at FROM mirror_state WHERE tenant = ? ORDER BY table_name").all(tenant) as Array<Record<string, unknown>>;
    for (const m of marks) {
      await db.prepare(`INSERT INTO mirror_state_archive (generation, tenant, table_name, last_id, last_stamp, updated_at, archived_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(o.generation, tenant, m.table_name, m.last_id, m.last_stamp ?? null, m.updated_at ?? 0, now);
    }
    await db.prepare("DELETE FROM mirror_state WHERE tenant = ?").run(tenant);
    const mirrorStateDigest = hash(canonical(marks.map(m => [String(m.table_name), String(m.last_id), m.last_stamp === null || m.last_stamp === undefined ? null : String(m.last_stamp), String(m.updated_at ?? 0)])));
    // The snapshot pre-images, row by row, in a stable order.
    const snapshot: Record<string, string[]> = {};
    for (const table of ATTESTED_SNAPSHOT_TABLES) {
      const rows = (await db.prepare(`SELECT * FROM ${table} WHERE LOWER(agent_id) = ?`).all(account) as Array<Record<string, unknown>>)
        .map(r => canonical(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v])))).sort();
      snapshot[table] = rows;
      let seq = 0;
      for (const row of rows) {
        await db.prepare(`INSERT INTO ledger_snapshot_archive (generation, tenant, table_name, seq, row_digest, row_json, archived_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(o.generation, tenant, table, seq++, hash(row), row, now);
      }
    }
    const snapshotDigest = hash(canonical(snapshot));
    // The new empty book, or this generation's own from a call that did not
    // finish. Created O_EXCL; a file already at the path is this call's own
    // only if it is a private plain file on the volume AND either carries this
    // generation as its identity, or carries no identity yet and holds
    // nothing at all (finishAttestedBook proves which).
    if (present(file)) {
      privateBook(file);
      if (String(lstatSync(file, { bigint: true }).dev) !== o.volume.device) throw refuse();
    } else {
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); fchmodSync(fd, 0o600); closeSync(fd);
      fsyncDirSync(o.home);
    }
    await finishAttestedBook(file, tenant, account, o.chainId, o.generation);
    chmodSync(file, 0o600); syncFile(file); fsyncDirSync(o.home);
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      for (const table of names) if ((raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n !== 0) throw refuse();
      const stmt = raw.prepare("SELECT name,seq FROM sqlite_sequence"); stmt.setReadBigInts(true);
      if (stmt.all().some(row => typeof row.name === "string" && autoincrement.includes(row.name) && row.seq !== 0n)) throw refuse();
    } finally { raw.close(); }
    leaseOkay(o.lease, tenant);
    const receiptDigest = hash(`attested-gap:${o.approvalId}:${o.evidenceDigest}`);
    const bound = { grant: current, marks: [], mutableDigest: receiptDigest };
    const inode = String(lstatSync(file, { bigint: true }).ino);
    if (prior) {
      const changed = await db.prepare(`UPDATE tenant_ledger_import SET generation=?,target_volume_id=?,state='consumed',sealed=NULL,bytes=0,sha256='',source_digest='',
        source_inode=?,source_identity=?,bindings_json=?,created_at_ms=?,consumed_at_ms=?,grant_updated_at=?,grant_row_version=? WHERE tenant=? AND generation=?`)
        .run(o.generation, o.volume.id, inode, o.generation, canonical(bound), now, now, current.updatedAt, current.rowVersion, tenant, prior.generation);
      if (changed.changes !== 1) throw refuse();
      await db.prepare("UPDATE tenant_ledger_import_generations SET state = 'deleted' WHERE generation = ? AND tenant = ?").run(prior.generation, tenant);
    } else {
      await db.prepare(`INSERT INTO tenant_ledger_import(tenant,generation,target_volume_id,state,sealed,bytes,sha256,source_digest,source_inode,source_identity,bindings_json,created_at_ms,consumed_at_ms,grant_updated_at,grant_row_version)
        VALUES(?,?,?,'consumed',NULL,0,'','',?,?,?,?,?,?,?)`)
        .run(tenant, o.generation, o.volume.id, inode, o.generation, canonical(bound), now, now, current.updatedAt, current.rowVersion);
    }
    await db.prepare("INSERT INTO tenant_ledger_import_generations(generation,tenant,state) VALUES(?,?,'consumed')").run(o.generation, tenant);
    await db.prepare(`INSERT INTO ledger_resume_attestations (generation, approval_id, tenant, smart_account, chain_id, owner, evidence_digest, receipt_digest,
      mirror_state_digest, snapshot_digest, archive_path, gap_from_sec, created_at_ms, chain_from_block, chain_head) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.generation, o.approvalId, tenant, account, o.chainId, owner, o.evidenceDigest, receiptDigest, mirrorStateDigest, snapshotDigest, o.archivePath, o.gapFromSec, now,
        o.chainRead?.fromBlock ?? null, o.chainRead?.head ?? null);
    const moved = await db.prepare("UPDATE ledger_resume_approvals SET state = 'registered', updated_at_ms = ? WHERE approval_id = ? AND state = 'archived' AND generation = ?")
      .run(now, o.approvalId, o.generation);
    if (moved.changes !== 1) throw refuse();
    leaseOkay(o.lease, tenant);
    return { generation: o.generation, receiptDigest, mirrorStateDigest, snapshotDigest };
  });
}

/** Read-only operator proof: exact original source -> throwaway schema -> original source. */
export async function verifyLedgerImport(o: {
  artifact: CapturedLedgerImport; home: string; shared: Db; dek: Buffer; lease: TenantLease;
  assertSource: () => void | Promise<void>; dialect?: Dialect;
}): Promise<{ tables: number; rows: number; sourceDigest: string }> {
  const a = openArtifact(o.artifact, o.dek), dialect = o.dialect ?? "postgres";
  leaseOkay(o.lease, a.tenant); await o.assertSource(); parentDirectories(o.home);
  const file = path.join(o.home, "merrymen.db"); plain(file, false);
  const hs = lstatSync(o.home, { bigint: true }), ds = lstatSync(file, { bigint: true });
  if (String(hs.dev) !== a.original.homeDevice || String(hs.ino) !== a.original.homeInode || String(ds.dev) !== a.original.dbDevice || String(ds.ino) !== a.original.dbInode) throw refuse();
  const original = new DatabaseSync(file, { readOnly: true }); original.exec("BEGIN");
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-verify-ledger-")));
  try {
    if (hash(canonical(readBook(original, a.smartAccount))) !== a.sourceDigest || original.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw refuse();
    assertSettled(original);
    await o.shared.tx(async db => {
      leaseOkay(o.lease, a.tenant); await o.assertSource();
      if (canonical(await bindings(db, a.tenant, a.smartAccount, dialect, true)) !== canonical(a.bindings)) throw refuse();
      await assertLedgerSourceContinuity(wrapSqlite(original), db, a.tenant);
      const staged = path.join(temporary, "verified.sqlite"); await buildStage(staged, a);
      const raw = new DatabaseSync(staged, { readOnly: true });
      try {
        if (raw.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw refuse();
        await assertLedgerSourceContinuity(wrapSqlite(raw), db, a.tenant);
      } finally { raw.close(); }
      leaseOkay(o.lease, a.tenant); await o.assertSource();
      if (canonical(await bindings(db, a.tenant, a.smartAccount, dialect, true)) !== canonical(a.bindings)) throw refuse();
    });
    return { tables: names.length, rows: names.reduce((n, t) => n + a.book.tables[t].length, 0), sourceDigest: a.sourceDigest };
  } finally { try { original.exec("ROLLBACK"); } finally { original.close(); rmSync(temporary, { recursive: true, force: true }); } }
}

/** Target completion proof, while the first persistent home is still quiescent. */
export async function verifyRestoredLedgerImport(o: {
  artifact: CapturedLedgerImport; home: string; volume: LedgerImportVolume; shared: Db; dek: Buffer; lease: TenantLease;
  assertSource: () => void | Promise<void>; dialect?: Dialect;
}): Promise<{ tables: number; rows: number; sourceDigest: string }> {
  const a = openArtifact(o.artifact, o.dek), dialect = o.dialect ?? "postgres";
  leaseOkay(o.lease, a.tenant); await o.assertSource(); volumeOkay(o.volume, o.home, a.tenant);
  if (readPending(o.home)) throw refuse();
  const file = path.join(o.home, "merrymen.db"); sameBook(file, a.smartAccount, a.sourceDigest);
  await o.shared.tx(async db => {
    if (canonical(await bindings(db, a.tenant, a.smartAccount, dialect, true)) !== canonical(a.bindings)) throw refuse();
    const row = await db.prepare(`SELECT generation,state,target_volume_id,source_digest,sealed,source_inode,source_identity FROM tenant_ledger_import WHERE tenant = ?${dialect === "postgres" ? " FOR SHARE" : ""}`).get(a.tenant) as Record<string, unknown> | undefined;
    const generation = await db.prepare("SELECT tenant,state FROM tenant_ledger_import_generations WHERE generation = ?").get(a.generation) as Record<string, unknown> | undefined;
    if (!row || row.generation !== a.generation || row.state !== "consumed" || row.target_volume_id !== o.volume.id || row.source_digest !== a.sourceDigest || row.sealed !== null || generation?.tenant !== a.tenant || generation.state !== "consumed") throw refuse();
    if (row.source_inode !== String(lstatSync(file, { bigint: true }).ino)) throw refuse();
    verifySourceIdentity(file, a.tenant, a.smartAccount, a.chainId, row.source_identity);
    const raw = new DatabaseSync(file, { readOnly: true });
    try { await assertLedgerSourceContinuity(wrapSqlite(raw), db, a.tenant); if (raw.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw refuse(); }
    finally { raw.close(); }
    leaseOkay(o.lease, a.tenant); await o.assertSource();
    sameBook(file, a.smartAccount, a.sourceDigest);
  });
  return { tables: names.length, rows: names.reduce((n, t) => n + a.book.tables[t].length, 0), sourceDigest: a.sourceDigest };
}
