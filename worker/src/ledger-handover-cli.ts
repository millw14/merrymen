/** Reviewed operator entry point; never imported by the orchestrator. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, rmSync, writeSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { makePgDb, type Db } from "./db";
import {
  captureLedgerImport, stageLedgerImport, restoreLedgerImport, verifyLedgerImport,
  verifyRestoredLedgerImport, readLedgerGapBinding, type CapturedLedgerImport,
} from "./ledger-import";
import { inspectMemorySource } from "./memory-safeguard-cli";
import {
  captureFleetMemory, memoryBackupCounts, openMemoryBackup, readMemoryBackupArtifact,
  sealMemoryBackup, seedMemoryBackup, verifyMemoryBackup, type MemoryBackup, type MemorySource,
} from "./memory-safeguard";
import {
  capturePersonalMemoryExport, ensurePersonalMemorySchema, restorePersonalMemory,
} from "./personal-memory-ferry";
import { ensureTgGroupsSchema, isTgGroupsText, restoreTgGroups, TG_GROUPS_FILE_NAME, TG_GROUPS_MAX_BYTES } from "./tg-groups-ferry";
import {
  markPersistentHomeHandoverComplete, PERSISTENT_HOME_MANIFEST, preparePersistentHomeForHandover,
  verifyPersistentHome, type PersistentHomeHaltProof, type PersistentHomeIdentity, type PersistentHomeOptions,
} from "./persistent-home";
import { acquireTenantLease, type TenantLease } from "./tenant-lease";
import { openSecret, sealSecret } from "./store-crypto";

const ENVELOPE = "ledger-handover/v1\n";
export const LEDGER_HANDOVER_MAX_BYTES = 384 * 1024 * 1024;
const MAX_PLAIN_BYTES = 256 * 1024 * 1024;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const silent = () => {};
const refuse = () => new Error("Ledger handover refused; retain both holds and review source, roster, original books, volume and memory. No private content was logged.");
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const canonical = (value: unknown): string => {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)])) : v;
  return JSON.stringify(sorted(value));
};
export interface HandoverRosterEntry {
  tenant: string; smartAccount: string; chainId: number; updatedAt: string; rowVersion: string;
}
export interface FleetLedgerHandover {
  version: 1; id: string; capturedAtMs: number; source: MemorySource;
  target: { volumeId: string; mountPath: string; gitCommit: string; operationToken: string };
  roster: HandoverRosterEntry[]; books: CapturedLedgerImport[]; withoutBook: string[];
  historicalGaps: HistoricalLedgerGap[];
  memory: MemoryBackup;
}
export interface HistoricalLedgerGap extends HandoverRosterEntry {
  sharedFinancialDigest: string;
  financialRows: Record<string, number>;
  nonzeroCursors: Array<{ table: string; lastId: string; lastStamp: string | null }>;
}
export const HISTORICAL_GAP_PROOF_FILE = ".ledger-handover-gap.proof.json";
export interface LedgerHandoverDependencies {
  /** Trusted filesystem/DB seams for isolated operator-flow tests. */
  env?: NodeJS.ProcessEnv; procRoot?: string; shared?: Db; dek?: Buffer;
  acquireLease?: typeof acquireTenantLease; dialect?: "postgres" | "sqlite";
  persistentOptions?: PersistentHomeOptions;
}

function plainDirectory(dir: string): void {
  if (!path.isAbsolute(dir) || path.resolve(dir) !== dir || realpathSync(dir) !== dir || !lstatSync(dir).isDirectory()) throw refuse();
}
function present(file: string): boolean {
  try { lstatSync(file); return true; } catch (e) { if (missing(e)) return false; throw refuse(); }
}
function readPlain(file: string, cap: number, privateFile = true): string {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(cap) || before.size < 0n
        || (privateFile && ((before.mode & 0o7777n) !== 0o600n || (process.geteuid && before.uid !== BigInt(process.geteuid()))))) throw refuse();
    const data = Buffer.alloc(Number(before.size) + 1);
    let n = 0;
    while (n < data.length) {
      const got = readSync(fd, data, n, data.length - n, n);
      if (!got) break;
      n += got;
    }
    const after = fstatSync(fd, { bigint: true });
    if (n !== Number(before.size) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw refuse();
    return data.subarray(0, n).toString("utf8");
  } finally { closeSync(fd); }
}
export function writeLedgerHandoverArtifact(file: string, sealed: string): string {
  if (Buffer.byteLength(sealed) > LEDGER_HANDOVER_MAX_BYTES) throw refuse();
  plainDirectory(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const data = Buffer.from(sealed); let n = 0;
    while (n < data.length) { const got = writeSync(fd, data, n, data.length - n); if (!got) throw refuse(); n += got; }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    linkSync(temp, file);
    const parent = openSync(path.dirname(file), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return hash(sealed);
  } finally { rmSync(temp, { force: true }); }
}
export function sealFleetLedgerHandover(backup: FleetLedgerHandover, dek: Buffer): string {
  const text = JSON.stringify(backup);
  if (dek.length !== 32 || Buffer.byteLength(text) > MAX_PLAIN_BYTES) throw refuse();
  return sealSecret(ENVELOPE + text, dek) + "\n";
}
function validSource(s: MemorySource): boolean {
  return !!s && typeof s.deploymentId === "string" && /^[\w.-]{1,128}$/.test(s.deploymentId)
    && SHA.test(s.gitCommit) && Number.isSafeInteger(s.orchestratorPid) && s.orchestratorPid > 0
    && typeof s.orchestratorStart === "string" && /^\d+$/.test(s.orchestratorStart)
    && s.quiescent === true && s.singleReplicaConfirmed === true;
}
export function openFleetLedgerHandover(sealed: string, dek: Buffer): FleetLedgerHandover {
  try {
    if (dek.length !== 32 || Buffer.byteLength(sealed) > LEDGER_HANDOVER_MAX_BYTES) throw refuse();
    const plain = openSecret(sealed.trim(), dek);
    if (!plain.startsWith(ENVELOPE) || Buffer.byteLength(plain) > MAX_PLAIN_BYTES) throw refuse();
    const b = JSON.parse(plain.slice(ENVELOPE.length)) as FleetLedgerHandover;
    if (b?.version !== 1 || !UUID.test(b.id) || !Number.isSafeInteger(b.capturedAtMs) || !validSource(b.source)
        || !b.target || !UUID.test(b.target.volumeId) || !SHA.test(b.target.gitCommit)
        || !path.isAbsolute(b.target.mountPath) || path.resolve(b.target.mountPath) !== b.target.mountPath
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(b.target.operationToken)
        || !Array.isArray(b.roster) || b.roster.length > 128 || !Array.isArray(b.books) || !Array.isArray(b.withoutBook)
        || !Array.isArray(b.historicalGaps) || b.books.length + b.withoutBook.length + b.historicalGaps.length !== b.roster.length || !b.memory) throw refuse();
    const seen = new Set<string>();
    for (const r of b.roster) {
      if (!ADDRESS.test(r.tenant) || seen.has(r.tenant) || !ADDRESS.test(r.smartAccount) || !Number.isSafeInteger(r.chainId) || r.chainId < 1
          || !/^\d+$/.test(r.updatedAt) || !/^\d+$/.test(r.rowVersion)) throw refuse();
      seen.add(r.tenant);
    }
    const listed = [...b.books.map(a => a.tenant), ...b.withoutBook, ...b.historicalGaps.map(g => g.tenant)];
    if (new Set(listed).size !== listed.length || listed.some(tenant => !seen.has(tenant))) throw refuse();
    for (const a of b.books) if (!UUID.test(a.generation) || typeof a.sealed !== "string" || a.sealed.length > 128 * 1024 * 1024
        || !Number.isSafeInteger(a.bytes) || a.bytes < 1 || a.bytes > 64 * 1024 * 1024 || hash(a.sealed) !== a.sha256) throw refuse();
    for (const g of b.historicalGaps) {
      const r = b.roster.find(r => r.tenant === g.tenant);
      if (!r || canonical(r) !== canonical({ tenant: g.tenant, smartAccount: g.smartAccount, chainId: g.chainId, updatedAt: g.updatedAt, rowVersion: g.rowVersion })
          || !/^[0-9a-f]{64}$/.test(g.sharedFinancialDigest) || !g.financialRows || !Array.isArray(g.nonzeroCursors)
          || Object.keys(g.financialRows).sort().join() !== [...FINANCIAL_TABLES].sort().join()
          || Object.values(g.financialRows).some(n => !Number.isSafeInteger(n) || n < 0 || n > 250_000)
          || g.nonzeroCursors.length > 32 || g.nonzeroCursors.some(m => typeof m.table !== "string" || !/^\w{1,64}$/.test(m.table)
            || !/^[1-9]\d*$/.test(m.lastId) || (m.lastStamp !== null && !/^-?\d+$/.test(m.lastStamp)))) throw refuse();
    }
    // Reuse the established structural/privacy boundary, including tenant headers.
    b.memory = openMemoryBackup(sealMemoryBackup(b.memory, dek), dek);
    if (canonical(b.memory.source) !== canonical(b.source) || canonical(b.memory.roster) !== canonical(b.roster.map(({ chainId, ...r }) => { void chainId; return r; }))) throw refuse();
    return b;
  } catch { throw refuse(); }
}
async function roster(shared: Db, dialect: "postgres" | "sqlite"): Promise<HandoverRosterEntry[]> {
  const rows = await shared.prepare(`SELECT tenant,lower(grant_json->>'smartAccount') AS account,grant_json->>'chainId' AS chain,
    ${dialect === "postgres" ? "updated_at::text AS updated,xmin::text AS incarnation" : "CAST(updated_at AS TEXT) AS updated,CAST(row_version AS TEXT) AS incarnation"}
    FROM grants ORDER BY tenant LIMIT 129`).all() as Array<Record<string, unknown>>;
  if (rows.length > 128) throw refuse();
  return rows.map(r => {
    if (typeof r.tenant !== "string" || !ADDRESS.test(r.tenant) || typeof r.account !== "string" || !ADDRESS.test(r.account)
        || !Number.isSafeInteger(Number(r.chain)) || Number(r.chain) < 1 || typeof r.updated !== "string" || !/^\d+$/.test(r.updated)
        || typeof r.incarnation !== "string" || !/^\d+$/.test(r.incarnation)) throw refuse();
    return { tenant: r.tenant, smartAccount: r.account, chainId: Number(r.chain), updatedAt: r.updated, rowVersion: r.incarnation };
  });
}
const FINANCIAL_TABLES = ["agents", "events", "posts", "trades", "equity", "flows", "fee_accruals", "journal", "decisions", "positions", "cost_basis",
  "paper_checkpoints", "risk_periods", "energy_days", "class_positions", "agent_commands", "position_floors", "trench_positions", "paper_book", "brain_trigger_state", "flows_quarantine"];
async function noOriginalBookEvidence(r: HandoverRosterEntry, shared: Db): Promise<void> {
  const marks = await shared.prepare("SELECT last_id FROM mirror_state WHERE tenant = ?").all(r.tenant) as Array<{ last_id: unknown }>;
  if (marks.some(m => String(m.last_id) !== "0")) throw refuse();
  for (const table of FINANCIAL_TABLES) {
    const key = table === "agents" ? "smart_account" : "agent_id";
    const row = await shared.prepare(`SELECT count(*) AS n FROM ${table} WHERE LOWER(${key}) = ?`).get(r.smartAccount) as { n?: unknown };
    if (String(row?.n) !== "0") throw refuse();
  }
}
async function financialSummary(r: HandoverRosterEntry, shared: Db): Promise<Pick<HistoricalLedgerGap, "financialRows" | "nonzeroCursors">> {
  const financialRows: Record<string, number> = {};
  for (const table of FINANCIAL_TABLES) {
    const key = table === "agents" ? "smart_account" : "agent_id";
    const result = await shared.prepare(`SELECT count(*) AS n FROM ${table} WHERE LOWER(${key}) = ?`).get(r.smartAccount) as { n?: unknown };
    const n = Number(result?.n); if (!Number.isSafeInteger(n) || n < 0 || n > 250_000) throw refuse();
    financialRows[table] = n;
  }
  const marks = await shared.prepare("SELECT table_name,last_id,last_stamp FROM mirror_state WHERE tenant = ? ORDER BY table_name LIMIT 33")
    .all(r.tenant) as Array<{ table_name: unknown; last_id: unknown; last_stamp: unknown }>;
  if (marks.length > 32) throw refuse();
  const nonzeroCursors = marks.filter(m => String(m.last_id) !== "0").map(m => {
    if (typeof m.table_name !== "string" || !/^\w{1,64}$/.test(m.table_name) || !/^[1-9]\d*$/.test(String(m.last_id))
        || (m.last_stamp !== null && !/^-?\d+$/.test(String(m.last_stamp)))) throw refuse();
    return { table: m.table_name, lastId: String(m.last_id), lastStamp: m.last_stamp === null ? null : String(m.last_stamp) };
  });
  return { financialRows, nonzeroCursors };
}
async function gapProof(r: HandoverRosterEntry, shared: Db, dialect: "postgres" | "sqlite", assertRuntime: () => void, lease: TenantLease): Promise<HistoricalLedgerGap> {
  const publicGrant: HandoverRosterEntry = { tenant: r.tenant, smartAccount: r.smartAccount, chainId: r.chainId, updatedAt: r.updatedAt, rowVersion: r.rowVersion };
  // The importer owns the compiled financial boundary. Its digest includes
  // grant owner/incarnation, every financial table and final mirror metadata.
  const bound = await readLedgerGapBinding({ ...publicGrant, shared, lease, assertSource: assertRuntime, dialect });
  const { owner, ...grant } = bound.grant; void owner;
  if (canonical(grant) !== canonical(publicGrant)) throw refuse();
  const summary = await financialSummary(r, shared); assertRuntime();
  return { ...publicGrant, sharedFinancialDigest: bound.digest, ...summary };
}
async function sourceBookSet(home: string, rows: HandoverRosterEntry[], shared: Db): Promise<{ books: string[]; withoutBook: string[]; historicalGapTenants: string[] }> {
  const children = path.join(home, "children"); plainDirectory(children);
  const tenants = new Set(rows.map(r => r.tenant)), names = readdirSync(children);
  if (names.length > 128) throw refuse();
  for (const name of names) {
    if (!ADDRESS.test(name)) throw refuse();
    const child = path.join(children, name); plainDirectory(child);
    if (present(path.join(child, "merrymen.db")) && !tenants.has(name)) throw refuse();
  }
  const books: string[] = [], withoutBook: string[] = [], historicalGapTenants: string[] = [];
  for (const r of rows) {
    const child = path.join(children, r.tenant), file = path.join(child, "merrymen.db");
    if (present(child)) plainDirectory(child);
    if (present(file)) {
      if (!lstatSync(file).isFile()) throw refuse();
      books.push(r.tenant);
    } else {
      const summary = await financialSummary(r, shared);
      if (summary.nonzeroCursors.length || Object.values(summary.financialRows).some(n => n > 0)) historicalGapTenants.push(r.tenant);
      else withoutBook.push(r.tenant);
    }
  }
  return { books, withoutBook, historicalGapTenants };
}
async function finalCursor(home: string, tenant: string, shared: Db): Promise<void> {
  const raw = new DatabaseSync(path.join(home, "merrymen.db"), { readOnly: true });
  try {
    for (const [table, stamp] of [["events", "created_at"], ["posts", "created_at"], ["trades", "created_at"], ["equity", "at"], ["flows", "at"], ["fee_accruals", "at"]] as const) {
      const tail = raw.prepare(`SELECT id,${stamp} AS stamp FROM ${table} ORDER BY id DESC LIMIT 1`).get() as { id: number; stamp: number } | undefined;
      const mark = await shared.prepare("SELECT last_id,last_stamp FROM mirror_state WHERE tenant = ? AND table_name = ?").get(tenant, table) as { last_id: unknown; last_stamp: unknown } | undefined;
      if (tail ? !mark || String(mark.last_id) !== String(tail.id) || String(mark.last_stamp) !== String(tail.stamp)
        : mark && String(mark.last_id) !== "0") throw refuse();
    }
  } finally { raw.close(); }
}
function personalContent(tenant: string, sealed: string, dek: Buffer): string {
  const head = `personal-memory/v1 ${tenant}\n`, text = openSecret(sealed, dek);
  if (!text.startsWith(head)) throw refuse();
  const snapshot = JSON.parse(text.slice(head.length)) as { forgets: Array<Record<string, unknown>> };
  return canonical({ ...snapshot, forgets: snapshot.forgets.map(({ completed, ...op }) => { void completed; return op; }) });
}
function groupText(tenant: string, sealed: string, dek: Buffer): string {
  const head = `tg-groups/v1 ${tenant}\n`, text = openSecret(sealed, dek);
  if (!text.startsWith(head) || !isTgGroupsText(text.slice(head.length))) throw refuse();
  return text.slice(head.length);
}
function sameMemory(a: MemoryBackup, b: MemoryBackup, dek: Buffer): void {
  if (canonical(a.roster) !== canonical(b.roster) || a.entries.length !== b.entries.length) throw refuse();
  for (const e of a.entries) {
    const other = b.entries.find(x => x.tenant === e.tenant);
    if (!other || e.homeDev !== other.homeDev || e.homeIno !== other.homeIno || !!e.personal !== !!other.personal || !!e.groups !== !!other.groups
        || (e.personal && personalContent(e.tenant, e.personal.sealed, dek) !== personalContent(e.tenant, other.personal!.sealed, dek))
        || (e.groups && groupText(e.tenant, e.groups.sealed, dek) !== groupText(e.tenant, other.groups!.sealed, dek))) throw refuse();
  }
}
async function storedMemory(backup: MemoryBackup, shared: Db, dek: Buffer): Promise<void> {
  for (const e of backup.entries) {
    for (const kind of ["personal", "groups"] as const) {
      const expected = e[kind], table = kind === "personal" ? "tenant_personal_memory" : "tenant_tg_groups";
      const row = await shared.prepare(`SELECT sealed FROM ${table} WHERE tenant = ?`).get(e.tenant) as { sealed?: unknown } | undefined;
      if (!expected) { if (row) throw refuse(); continue; }
      if (!row || typeof row.sealed !== "string") throw refuse();
      const content = kind === "personal" ? personalContent : groupText;
      if (content(e.tenant, row.sealed, dek) !== content(e.tenant, expected.sealed, dek)) throw refuse();
    }
  }
}
async function verifyTargetMemory(backup: MemoryBackup, home: string, shared: Db, dek: Buffer): Promise<void> {
  await storedMemory(backup, shared, dek);
  for (const e of backup.entries) {
    const child = path.join(home, "children", e.tenant); plainDirectory(child);
    const local = capturePersonalMemoryExport({ tenant: e.tenant, home: child, dek });
    if (!!local !== !!e.personal || (local && e.personal && personalContent(e.tenant, local.sealed, dek) !== personalContent(e.tenant, e.personal.sealed, dek))) throw refuse();
    const file = path.join(child, TG_GROUPS_FILE_NAME);
    if (e.groups) {
      if (readPlain(file, TG_GROUPS_MAX_BYTES) !== groupText(e.tenant, e.groups.sealed, dek)) throw refuse();
    } else if (present(file)) throw refuse();
  }
}
function emptyFinancialTarget(home: string): void {
  const file = path.join(home, "merrymen.db");
  if (!present(file)) return;
  if (!lstatSync(file).isFile()) throw refuse();
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    for (const table of FINANCIAL_TABLES) {
      const exists = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (exists && Number(raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n) !== 0) throw refuse();
    }
    if (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get()) {
      for (const row of raw.prepare("SELECT name,seq FROM sqlite_sequence").all()) {
        if (["events", "posts", "trades", "equity", "flows", "fee_accruals", "journal"].includes(String(row.name)) && String(row.seq) !== "0") throw refuse();
      }
    }
  } finally { raw.close(); }
}
function ensureChild(home: string, tenant: string): string {
  const children = path.join(home, "children"), child = path.join(children, tenant);
  if (!present(children)) mkdirSync(children, { mode: 0o700 });
  plainDirectory(children);
  if (!present(child)) mkdirSync(child, { mode: 0o700 });
  plainDirectory(child);
  return child;
}
function gapMarkerText(backup: FleetLedgerHandover, gap: HistoricalLedgerGap): string {
  return canonical({ version: 1, kind: "historical-ledger-gap", handoverId: backup.id, operationToken: backup.target.operationToken,
    targetVolumeId: backup.target.volumeId, ...gap,
    reason: "Original financial source absent at the reviewed handover; this tenant remains blocked from ledger bootstrap, mirror and trading." }) + "\n";
}
function gapTargetProof(backup: FleetLedgerHandover, gap: HistoricalLedgerGap, volume: PersistentHomeIdentity, initialize: boolean): void {
  const home = volume.homeRoot;
  const child = initialize ? ensureChild(home, gap.tenant) : path.join(home, "children", gap.tenant);
  plainDirectory(child); emptyFinancialTarget(child);
  const marker = path.join(child, "ledger-source-blocked.json"), receipt = path.join(child, HISTORICAL_GAP_PROOF_FILE), text = gapMarkerText(backup, gap);
  if (initialize && !present(marker) && !present(receipt)) {
    writeLedgerHandoverArtifact(marker, text); // Durable block before any memory can create a DB.
    const st = lstatSync(marker, { bigint: true });
    writeLedgerHandoverArtifact(receipt, canonical({ version: 1, handoverId: backup.id, operationToken: backup.target.operationToken,
      markerDevice: String(st.dev), markerInode: String(st.ino), markerSha256: hash(text) }) + "\n");
  }
  // A crash between marker and receipt is held, never automatically repaired.
  const saved = JSON.parse(readPlain(receipt, 8 * 1024)) as Record<string, unknown>, st = lstatSync(marker, { bigint: true });
  if (saved.version !== 1 || saved.handoverId !== backup.id || saved.operationToken !== backup.target.operationToken
      || typeof saved.markerDevice !== "string" || !/^\d+$/.test(saved.markerDevice)
      || String(st.dev) !== volume.device || saved.markerInode !== String(st.ino) || saved.markerSha256 !== hash(text)
      || readPlain(marker, 32 * 1024) !== text) throw refuse();
}
function targetCoverage(home: string, rows: HandoverRosterEntry[]): void {
  const children = path.join(home, "children"), wanted = new Set(rows.map(r => r.tenant));
  plainDirectory(children);
  for (const name of readdirSync(children)) {
    if (!wanted.has(name)) throw refuse();
    plainDirectory(path.join(children, name));
  }
}
function argumentsFor(argv: string[]): { mode: string; values: Map<string, string>; flags: Set<string> } {
  const mode = argv[0] ?? "", values = new Map<string, string>(), flags = new Set<string>();
  if (!["preflight", "capture", "verify", "stage", "restore", "complete"].includes(mode)) throw refuse();
  const booleans = new Set(["--quiescent", "--single-replica-confirmed", "--acknowledge-historical-ledger-gaps"]);
  const named = new Set(["--expected-deployment", "--expected-commit", "--orchestrator-pid", "--output", "--artifact", "--memory-artifact",
    "--target-volume-id", "--target-mount-path", "--target-commit", "--operation-token", "--expected-source-deployment", "--expected-source-commit", "--source-orchestrator-pid", "--source-orchestrator-start"]);
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (booleans.has(arg) && !flags.has(arg)) { flags.add(arg); continue; }
    if (!named.has(arg) || values.has(arg) || !argv[i + 1] || argv[i + 1]!.startsWith("--")) throw refuse();
    values.set(arg, argv[++i]!);
  }
  if ((mode !== "preflight" && !flags.has("--quiescent")) || !flags.has("--single-replica-confirmed")) throw refuse();
  return { mode, values, flags };
}

/** Only bounded public counts/hash/process identities leave this runner. */
export async function runLedgerHandoverCli(argv: string[], dependencies: LedgerHandoverDependencies = {}): Promise<Record<string, unknown>> {
  const { mode, values, flags } = argumentsFor(argv), env = dependencies.env ?? process.env;
  const home = env.MERRYMEN_HOME;
  if (!home || !path.isAbsolute(home) || path.resolve(home) !== home || (!dependencies.shared && !env.DATABASE_URL)) throw refuse();
  plainDirectory(home);
  const opts = { home, expectedDeployment: values.get("--expected-deployment") ?? "", expectedCommit: values.get("--expected-commit") ?? "",
    orchestratorPid: Number(values.get("--orchestrator-pid")), quiescent: flags.has("--quiescent"), singleReplicaConfirmed: true };
  const current = inspectMemorySource(opts, env, dependencies.procRoot), targetMode = mode === "restore" || mode === "complete";
  const dek = dependencies.dek ?? Buffer.from(env.MERRYMEN_STORE_DEK ?? "", "base64");
  if (dek.length !== 32) throw refuse();
  const shared = dependencies.shared ?? await makePgDb(env.DATABASE_URL!), dialect = dependencies.dialect ?? "postgres";
  if (mode === "preflight") {
    const rows = await roster(shared, dialect), set = await sourceBookSet(home, rows, shared), gaps = [];
    const presentButUnverified: string[] = [];
    for (const tenant of set.books) {
      try { await finalCursor(path.join(home, "children", tenant), tenant, shared); }
      catch { presentButUnverified.push(tenant); }
    }
    for (const tenant of set.historicalGapTenants) {
      const r = rows.find(r => r.tenant === tenant)!; gaps.push({ ...r, ...await financialSummary(r, shared) });
    }
    if (canonical(await roster(shared, dialect)) !== canonical(rows)
        || canonical(inspectMemorySource(opts, env, dependencies.procRoot)) !== canonical(current)) throw refuse();
    return { operation: "preflight-read-only", source: current, roster: rows.length, existingBooks: set.books.length,
      neverCreatedBooks: set.withoutBook.length, historicalMissingBooks: gaps.length, presentButUnverified, historicalGaps: gaps,
      releaseEligible: false };
  }
  const leases = new Map<string, TenantLease>();
  let expectedRoster: HandoverRosterEntry[];
  const assertRuntime = () => {
    if (canonical(inspectMemorySource(opts, env, dependencies.procRoot)) !== canonical(current)
        || [...leases.values()].some(l => l.backend !== "postgres" || !l.healthy())) throw refuse();
    if (targetMode && !verifyPersistentHome(env, dependencies.persistentOptions)) throw refuse();
  };
  const gate = async () => {
    assertRuntime();
    if (canonical(await roster(shared, dialect)) !== canonical(expectedRoster)) throw refuse();
  };
  try {
    let backup: FleetLedgerHandover;
    if (mode === "capture") {
      if (!values.get("--memory-artifact") || !values.get("--output")) throw refuse();
      const memory = openMemoryBackup(readMemoryBackupArtifact(path.resolve(values.get("--memory-artifact")!)), dek);
      if (canonical(memory.source) !== canonical(current)) throw refuse();
      expectedRoster = await roster(shared, dialect);
      backup = { version: 1, id: randomUUID(), capturedAtMs: Date.now(), source: current,
        target: { volumeId: values.get("--target-volume-id") ?? "", mountPath: values.get("--target-mount-path") ?? "",
          gitCommit: values.get("--target-commit") ?? "", operationToken: values.get("--operation-token") ?? "" },
        roster: expectedRoster, books: [], withoutBook: [], historicalGaps: [], memory };
    } else {
      if (!values.get("--artifact")) throw refuse();
      backup = openFleetLedgerHandover(readPlain(path.resolve(values.get("--artifact")!), LEDGER_HANDOVER_MAX_BYTES), dek);
      expectedRoster = backup.roster;
      if (!targetMode && canonical(current) !== canonical(backup.source)) throw refuse();
      if (targetMode && (values.get("--expected-source-deployment") !== backup.source.deploymentId
          || values.get("--expected-source-commit") !== backup.source.gitCommit
          || Number(values.get("--source-orchestrator-pid")) !== backup.source.orchestratorPid
          || values.get("--source-orchestrator-start") !== backup.source.orchestratorStart)) throw refuse();
    }
    // Validate target bindings before any lease or shared mutation.
    if (!UUID.test(backup.target.volumeId) || !SHA.test(backup.target.gitCommit) || !path.isAbsolute(backup.target.mountPath)
        || path.resolve(backup.target.mountPath) !== backup.target.mountPath || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(backup.target.operationToken)) throw refuse();
    for (const r of expectedRoster) {
      const lease = await (dependencies.acquireLease ?? acquireTenantLease)(r.tenant as `0x${string}`);
      if (!lease || lease.backend !== "postgres" || lease.tenant.toLowerCase() !== r.tenant || !lease.healthy()) { await lease?.release(); throw refuse(); }
      leases.set(r.tenant, lease);
    }
    await gate();
    await verifyMemoryBackup(backup.memory, dek); // Real restore in disposable SQLite homes.
    if (!targetMode) {
      const set = await sourceBookSet(home, expectedRoster, shared);
      if (mode === "capture") {
        if (set.historicalGapTenants.length && !flags.has("--acknowledge-historical-ledger-gaps")) throw refuse();
        backup.withoutBook = set.withoutBook;
        for (const tenant of set.historicalGapTenants) backup.historicalGaps.push(await gapProof(expectedRoster.find(r => r.tenant === tenant)!, shared, dialect, assertRuntime, leases.get(tenant)!));
        for (const tenant of set.books) {
          const r = expectedRoster.find(r => r.tenant === tenant)!;
          const child = path.join(home, "children", tenant);
          await gate(); await finalCursor(child, tenant, shared);
          backup.books.push(await captureLedgerImport({ ...r, home: child, shared, dek, lease: leases.get(tenant)!, source: current, assertSource: assertRuntime, dialect }));
        }
        // The encrypted wrapper enforces its tenant coverage and size before publication.
        backup = openFleetLedgerHandover(sealFleetLedgerHandover(backup, dek), dek);
      } else if (canonical(set) !== canonical({ books: backup.books.map(a => a.tenant), withoutBook: backup.withoutBook,
        historicalGapTenants: backup.historicalGaps.map(g => g.tenant) })) throw refuse();
      for (const gap of backup.historicalGaps) {
        if (present(path.join(home, "children", gap.tenant, "merrymen.db"))
            || canonical(await gapProof(gap, shared, dialect, assertRuntime, leases.get(gap.tenant)!)) !== canonical(gap)) throw refuse();
      }
      const currentMemory = await captureFleetMemory({ childrenDir: path.join(home, "children"), shared, dek, source: current, assertSource: assertRuntime });
      sameMemory(backup.memory, currentMemory, dek);
      let rows = 0;
      for (const artifact of backup.books) {
        await gate();
        const child = path.join(home, "children", artifact.tenant);
        await finalCursor(child, artifact.tenant, shared);
        const check = await verifyLedgerImport({ artifact, home: child, shared, dek, lease: leases.get(artifact.tenant)!, assertSource: assertRuntime, dialect });
        rows += check.rows;
      }
      await gate();
      if (mode === "stage") {
        // Personal seeding is insert-only; group state came from the separate final checkpoint.
        await seedMemoryBackup({ backup: backup.memory, childrenDir: path.join(home, "children"), shared, dek, assertSource: assertRuntime });
        await ensureTgGroupsSchema(shared, dialect);
        await storedMemory(backup.memory, shared, dek);
        for (const artifact of backup.books) {
          await stageLedgerImport({ artifact, targetVolumeId: backup.target.volumeId, shared, dek, lease: leases.get(artifact.tenant)!, assertSource: assertRuntime, dialect });
        }
      }
      await gate();
      const ciphertextSha256 = mode === "capture" ? writeLedgerHandoverArtifact(path.resolve(values.get("--output")!), sealFleetLedgerHandover(backup, dek))
        : hash(readPlain(path.resolve(values.get("--artifact")!), LEDGER_HANDOVER_MAX_BYTES));
      return { operation: mode === "capture" ? "captured-and-verified" : mode === "stage" ? "staged" : "verified", source: backup.source,
        ciphertextSha256, books: backup.books.length, withoutBook: backup.withoutBook.length, historicalBlockedBooks: backup.historicalGaps.length,
        rows, memory: memoryBackupCounts(backup.memory) };
    }
    const volume = verifyPersistentHome(env, dependencies.persistentOptions);
    if (!volume || volume.id !== backup.target.volumeId || volume.mountPath !== backup.target.mountPath
        || current.gitCommit !== backup.target.gitCommit || env.MERRYMEN_INITIAL_HANDOVER !== backup.target.operationToken) throw refuse();
    const prepared = preparePersistentHomeForHandover(env, dependencies.persistentOptions);
    if (!prepared) throw refuse();
    // Complete-receipt crash retries may still have the original owned hold.
    const manifest = JSON.parse(readPlain(path.join(home, PERSISTENT_HOME_MANIFEST), 8 * 1024)) as { handover: { halt: PersistentHomeHaltProof } };
    const halt = prepared.halt ?? { ...manifest.handover.halt, device: volume.device };
    if (halt.operationToken !== backup.target.operationToken || readPlain(halt.path, 8 * 1024) !== halt.text) throw refuse();
    if (mode === "restore" && prepared.handoverState !== "held") throw refuse();
    await ensurePersonalMemorySchema(shared, dialect); await ensureTgGroupsSchema(shared, dialect);
    await storedMemory(backup.memory, shared, dek);
    for (const gap of backup.historicalGaps) {
      await gate();
      if (canonical(await gapProof(gap, shared, dialect, assertRuntime, leases.get(gap.tenant)!)) !== canonical(gap)) throw refuse();
      gapTargetProof(backup, gap, volume, mode === "restore");
    }
    if (mode === "restore") {
      // Every original financial book comes first. Memory restore can open SQLite.
      for (const artifact of backup.books) {
        const r = expectedRoster.find(r => r.tenant === artifact.tenant)!;
        await gate();
        const row = await shared.prepare("SELECT generation,state,sealed,target_volume_id FROM tenant_ledger_import WHERE tenant = ?").get(r.tenant) as Record<string, unknown> | undefined;
        if (!row || row.generation !== artifact.generation || row.target_volume_id !== volume.id
            || (row.state === "available" ? row.sealed !== artifact.sealed : row.state !== "consumed")) throw refuse();
        const result = await restoreLedgerImport({ ...r, home: path.join(home, "children", r.tenant), volume, shared, dek, lease: leases.get(r.tenant)!, dialect });
        if (result === "none") throw refuse();
      }
      for (const tenant of backup.withoutBook) {
        const r = expectedRoster.find(r => r.tenant === tenant)!; await noOriginalBookEvidence(r, shared);
        const child = ensureChild(home, tenant); emptyFinancialTarget(child);
      }
      for (const r of expectedRoster) {
        await gate();
        const child = path.join(home, "children", r.tenant), opts = { tenant: r.tenant, home: child, shared, dek, log: silent };
        const personal = await restorePersonalMemory(opts), groups = await restoreTgGroups(opts);
        if (!["restored", "present", "none"].includes(personal) || !["restored", "present", "none"].includes(groups)) throw refuse();
      }
    }
    let rows = 0;
    for (const artifact of backup.books) {
      await gate();
      for (const file of ["ledger-source-blocked.json", "restore-blocked.json", "energy-unrestored.json", "telegram-held-groups.json"]) {
        if (present(path.join(home, "children", artifact.tenant, file))) throw refuse();
      }
      const check = await verifyRestoredLedgerImport({ artifact, home: path.join(home, "children", artifact.tenant), volume, shared, dek,
        lease: leases.get(artifact.tenant)!, assertSource: assertRuntime, dialect });
      rows += check.rows;
    }
    for (const tenant of backup.withoutBook) {
      await noOriginalBookEvidence(expectedRoster.find(r => r.tenant === tenant)!, shared);
      emptyFinancialTarget(path.join(home, "children", tenant));
    }
    for (const gap of backup.historicalGaps) {
      if (canonical(await gapProof(gap, shared, dialect, assertRuntime, leases.get(gap.tenant)!)) !== canonical(gap)) throw refuse();
      gapTargetProof(backup, gap, volume, false);
    }
    targetCoverage(home, expectedRoster);
    await verifyTargetMemory(backup.memory, home, shared, dek);
    await gate();
    if (mode === "complete") {
      // Lock ALL current grant incarnations through the synchronous release.
      await shared.tx(async tx => {
        for (const r of expectedRoster) {
          const lock = await tx.prepare(`SELECT tenant FROM grants WHERE tenant = ?${dialect === "postgres" ? " FOR SHARE" : ""}`).get(r.tenant);
          if (!lock) throw refuse();
          for (const table of ["tenant_personal_memory", "tenant_tg_groups"]) {
            await tx.prepare(`SELECT sealed FROM ${table} WHERE tenant = ?${dialect === "postgres" ? " FOR SHARE" : ""}`).get(r.tenant);
          }
        }
        if (canonical(await roster(tx, dialect)) !== canonical(expectedRoster)) throw refuse();
        await verifyTargetMemory(backup.memory, home, tx, dek);
        for (const gap of backup.historicalGaps) gapTargetProof(backup, gap, volume, false);
        assertRuntime();
        markPersistentHomeHandoverComplete(volume, halt, env, dependencies.persistentOptions);
      });
    }
    return { operation: mode === "complete" ? "completed" : "restored-and-verified", source: backup.source, target: current,
      books: backup.books.length, withoutBook: backup.withoutBook.length, historicalBlockedBooks: backup.historicalGaps.length,
      rows, memory: memoryBackupCounts(backup.memory) };
  } catch { throw refuse(); }
  finally { for (const lease of [...leases.values()].reverse()) await lease.release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runLedgerHandoverCli(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result)); process.exit(0); })
    .catch(() => { console.error(refuse().message); process.exit(1); });
}
