/**
 * GENUINELY NEW TENANTS, ADMITTED WITHOUT BEING NAMED (MERRYMEN_ROLLOUT_NEW_TENANTS).
 *
 * THE INCIDENT IT ANSWERS. On 2026-10-09 the hosted fleet ran under an
 * explicit MERRYMEN_FLEET_ROLLOUT naming 49 tenants, and every tenant it did
 * not name was held (fleet-rollout.ts). A tester created a new agent that day.
 * No worker ever started for it, so nothing minted the link code its Telegram
 * row waits for ("starting up", for good), and no line anywhere said why. The
 * list is there so the pre-incident fleet comes back a few tenants at a time,
 * each after its accounting is reviewed (docs/fleet-resume.md); an agent
 * created since the incident has no accounting to review, and the site is
 * live. The owner decided on 2026-10-09 that every genuinely new agent must be
 * able to start without her naming it, while the pre-incident tenants stay
 * governed by the list and the recovery machinery.
 *
 * WHAT "GENUINELY NEW" MEANS, all of it, each part failing closed (a fact that
 * cannot be read is "not new", and the tenant stays held):
 *
 *  - Nothing for it on the volume: no home (children/<tenant>) and no archive
 *    of one (archive/<tenant>, ledger-resume.ts archiveTenantHome). Every
 *    pre-incident tenant has a home there.
 *  - No history in Postgres for the tenant or the account its grant names:
 *    the new-book branch's own predicate, the one function both ask
 *    (ledger-import.ts sharedLedgerHistory: a mirror cursor past zero, a row
 *    for the account in any table the book mirrors, a paper checkpoint), and
 *    beside it an agent registered by its owner, a ledger-import receipt, an
 *    attested-gap approval, attestation or archived pre-image, or a recovery
 *    hold on record (HISTORY_RECORDS).
 *  - And what the orchestrator asks before it calls this: an unexpired grant
 *    in the roster, not named by the accounting hold, no kill pending.
 *
 * Never a grant timestamp. grants.updated_at moves on every re-sign, and the
 * grant's grantedAt is stamped by the owner's browser; neither says whether
 * a tenant existed before the incident.
 *
 * DURABLE ONCE ADMITTED. Its first spawn gives the tenant a home and, soon, a
 * history, so a stateless "is it new?" would hold it on the very next pass and
 * stop an agent that is running. The admission is recorded instead
 * (fleet_new_tenant_admissions), BEFORE that first spawn, under the tenant's
 * lease, in the same transaction as the last read of its history. From then
 * on the record admits it at whatever level the variable gives NOW: lowering
 * the variable lowers every tenant it admitted, and removing it holds them all
 * again, exactly as before it existed. Naming the tenant in the list gives it
 * the list's level instead.
 *
 * WRITTEN BY THE ORCHESTRATOR ALONE. A child has no DATABASE_URL (orchestrator
 * CHILD_SECRET_STRIP) and nothing it runs imports this module; the insert
 * here refuses unless the caller's lease proof holds before and after it.
 *
 * NOT A WAY ROUND RECOVERY. The record only answers the rollout's question.
 * Every spawn still goes through the ordinary new-book path: on the volume,
 * registerLedgerSource binds the tenant's first book to a durable receipt and
 * refuses any account with history, so a tenant whose volume is later lost
 * meets the same refusal as every other tenant whose book is gone, record or
 * no record.
 */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { rootDb, type Db } from "./db";
import { sharedLedgerHistory } from "./ledger-import";
import { AUTO_PAPER_HEADROOM } from "./ledger-resume";
import type { AdmissionLevel } from "./worker-admission";

/**
 * One row per tenant the route has admitted. `level_at_admission` is what the
 * variable said then, for the record; the level the tenant runs at is always
 * the variable's now. `evidence_digest` binds what was proved: the tenant, its
 * account, chain and owner, and every fact read (newTenantEvidenceDigest).
 * Nothing here is secret, and no row is ever deleted by the code.
 */
export const NEW_TENANT_ADMISSIONS_DDL = `CREATE TABLE IF NOT EXISTS fleet_new_tenant_admissions (
  tenant TEXT PRIMARY KEY, smart_account TEXT NOT NULL, chain_id BIGINT NOT NULL,
  level_at_admission TEXT NOT NULL CHECK (level_at_admission IN ('observe', 'exits-only', 'trade')),
  admitted_at_ms BIGINT NOT NULL, evidence_digest TEXT NOT NULL
)`;

/**
 * PROCESS SLOTS THE ROUTE LEAVES FREE UNDER THE CAP: the automatic lane's own
 * reserve (ledger-resume.ts AUTO_PAPER_HEADROOM, the runbook's batch bound of
 * 40 of 48), for restarts, holds and the tenants the list names. Never raised
 * to fit, and never a reason to raise the cap.
 */
export const NEW_TENANT_HEADROOM = AUTO_PAPER_HEADROOM;

/**
 * The most tenants one pass reads Postgres history for. A tenant refused on a
 * fact is not read again by the same process (the orchestrator remembers it),
 * so this bounds only what a burst of sign-ups, or a store failing for
 * everyone, costs a pass.
 */
export const NEW_TENANT_LOOKS_PER_PASS = 4;

/**
 * HOW MANY MORE PROCESSES THE ROUTE MAY START NOW. None while any tenant the
 * list names waited for a slot this pass: a new tenant never takes one a
 * named tenant needs. Otherwise what the cap leaves above the headroom.
 */
export function newTenantRoom(o: { running: number; cap: number; namedWaiting: number }): number {
  if (o.namedWaiting > 0) return 0;
  return Math.max(0, o.cap - NEW_TENANT_HEADROOM - o.running);
}

/** Everything the check needs to know about one tenant: lowercase addresses, its home, and where archives of homes are kept. */
export interface NewTenantScope {
  tenant: string;
  account: string;
  owner: string;
  chainId: number;
  home: string;
  /** Each a directory holding archive/<tenant> trees (archiveTenantHome's archiveRoot is <root>/<tenant>). */
  archiveRoots: readonly string[];
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
function scopeOk(s: NewTenantScope): void {
  if (!ADDRESS.test(s.tenant) || !ADDRESS.test(s.account) || !ADDRESS.test(s.owner) || !Number.isSafeInteger(s.chainId) || s.chainId <= 0) {
    throw new Error("new-tenant scope is not a lowercase tenant, account, owner and chain");
  }
}

/** Present at all, whatever it is. Absent only on ENOENT; any other failure is not an answer, and throws. */
function present(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * WHAT THE VOLUME HOLDS FOR IT: why it is not new, or null for nothing at all.
 * A home in any state, even an empty directory, is not nothing: only a spawn,
 * a restore or an archive makes one. Throws on a read that is not ENOENT.
 */
export function volumeHistory(s: Pick<NewTenantScope, "tenant" | "home" | "archiveRoots">): string | null {
  if (present(s.home)) return "it has a home on the volume";
  for (const root of s.archiveRoots) if (present(path.join(root, s.tenant))) return "an archive of its home is on the volume";
  return null;
}

/** A table that is not there yet holds nothing: Postgres's 42P01, sqlite's "no such table". Never a missing column, which is drift and throws. */
const absentTable = (e: unknown): boolean => {
  const err = e as { code?: unknown; message?: unknown } | null;
  return err?.code === "42P01" || /no such table/.test(String(err?.message ?? ""));
};

/**
 * THE RECORDS BESIDE THE BOOK'S OWN TABLES that only a tenant with a past has.
 * `required`: the table is one the new-book predicate reads too, so its
 * absence is a store that cannot answer, not an empty one.
 */
const HISTORY_RECORDS: ReadonlyArray<{ what: string; sql: string; args: (s: NewTenantScope) => string[]; required?: true }> = [
  { what: "an agent registered by its owner", sql: "SELECT 1 AS x FROM agents WHERE LOWER(owner_address) IN (?, ?) LIMIT 1", args: (s) => [s.owner, s.tenant], required: true },
  { what: "a ledger-import receipt", sql: "SELECT 1 AS x FROM tenant_ledger_import WHERE LOWER(tenant) = ? LIMIT 1", args: (s) => [s.tenant] },
  { what: "a ledger-import generation", sql: "SELECT 1 AS x FROM tenant_ledger_import_generations WHERE LOWER(tenant) = ? LIMIT 1", args: (s) => [s.tenant] },
  { what: "an attested-gap approval", sql: "SELECT 1 AS x FROM ledger_resume_approvals WHERE LOWER(tenant) = ? OR LOWER(smart_account) = ? LIMIT 1", args: (s) => [s.tenant, s.account] },
  { what: "an attested-gap attestation", sql: "SELECT 1 AS x FROM ledger_resume_attestations WHERE LOWER(tenant) = ? OR LOWER(smart_account) = ? LIMIT 1", args: (s) => [s.tenant, s.account] },
  { what: "an archived mirror cursor", sql: "SELECT 1 AS x FROM mirror_state_archive WHERE LOWER(tenant) = ? LIMIT 1", args: (s) => [s.tenant] },
  { what: "an archived snapshot row", sql: "SELECT 1 AS x FROM ledger_snapshot_archive WHERE LOWER(tenant) = ? LIMIT 1", args: (s) => [s.tenant] },
  { what: "a recovery hold on record", sql: "SELECT 1 AS x FROM fleet_recovery_health WHERE LOWER(tenant) = ? OR LOWER(smart_account) = ? LIMIT 1", args: (s) => [s.tenant, s.account] },
];

/**
 * WHAT POSTGRES HOLDS FOR IT: why it is not new, or null for nothing at all.
 * The new-book predicate first, then the records beside it. Throws on any
 * read that fails (a missing table the predicate needs included), so the
 * caller holds the tenant and asks again later.
 */
export async function postgresHistory(db: Pick<Db, "prepare">, s: NewTenantScope): Promise<string | null> {
  scopeOk(s);
  const book = await sharedLedgerHistory(db, s.tenant, s.account);
  if (book !== null) return `Postgres holds history for it (${book})`;
  for (const record of HISTORY_RECORDS) {
    try {
      if (await db.prepare(record.sql).get(...record.args(s))) return `Postgres holds ${record.what} for it`;
    } catch (e) {
      if (record.required || !absentTable(e)) throw e;
    }
  }
  return null;
}

const canonical = (value: unknown): string => {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(value));
};

/** What the record binds: the tenant, its account, chain and owner, the level asked for, and every fact that was read and found empty. */
export function newTenantEvidenceDigest(s: NewTenantScope, level: AdmissionLevel): string {
  return createHash("sha256").update(canonical({
    version: 1, tenant: s.tenant, account: s.account, chainId: s.chainId, owner: s.owner, level,
    volume: { home: "absent", archive: "absent" },
    postgres: ["sharedLedgerHistory", ...HISTORY_RECORDS.map((r) => r.what)],
  })).digest("hex");
}

/**
 * CREATE TABLE IF NOT EXISTS, once per database, and safe against another
 * process doing the same at once (telegram-claims.ts ensureBotClaims says why:
 * Postgres's IF NOT EXISTS is not atomic, and the loser sees 23505, 42P07 or
 * 42710, each meaning the table now exists). A failure that is not one of
 * those is forgotten, so the next call tries again.
 */
const ensured = new WeakMap<Db, Promise<void>>();
export function ensureNewTenantAdmissions(db: Db): Promise<void> {
  const root = rootDb(db);
  let done = ensured.get(root);
  if (!done) {
    done = db.exec(NEW_TENANT_ADMISSIONS_DDL).catch((e: unknown) => {
      const code = (e as { code?: unknown }).code;
      if (code === "23505" || code === "42P07" || code === "42710") return;
      ensured.delete(root);
      throw e;
    });
    ensured.set(root, done);
  }
  return done;
}

/** Every tenant the route has admitted, lowercase. A table not made yet is nobody. Throws on any other failure. */
export async function readNewTenantAdmissions(db: Pick<Db, "prepare">): Promise<Set<string>> {
  try {
    const rows = (await db.prepare("SELECT tenant FROM fleet_new_tenant_admissions").all()) as Array<{ tenant: unknown }>;
    return new Set(rows.map((r) => String(r.tenant).toLowerCase()).filter((t) => ADDRESS.test(t)));
  } catch (e) {
    if (absentTable(e)) return new Set();
    throw e;
  }
}

/**
 * IS IT NEW: null when it is, or why not. `fact`: something true of the
 * tenant (a home, an archive, history), which asking again will not change;
 * otherwise a read failed, and the answer is "not now". Never throws.
 */
export type NewTenantRefusal = { why: string; fact: boolean };

/** WHAT KIND OF FAILURE, without what it said: its class and code, as the orchestrator's errorKind says one. */
function failureKind(e: unknown): string {
  const err = e as { name?: unknown; code?: unknown } | null;
  const name = e instanceof Error && typeof err?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(err.name) ? err.name : "Error";
  const code = typeof err?.code === "string" && /^[A-Z0-9_]{2,40}$/.test(err.code) ? ` ${err.code}` : "";
  return `${name}${code}`;
}

/** The volume first (no read of Postgres for a tenant with a home), then Postgres. Read-only. */
export async function newTenantRefusal(db: Pick<Db, "prepare">, s: NewTenantScope): Promise<NewTenantRefusal | null> {
  try {
    scopeOk(s);
    const onVolume = volumeHistory(s);
    if (onVolume) return { why: onVolume, fact: true };
    const history = await postgresHistory(db, s);
    return history ? { why: history, fact: true } : null;
  } catch (e) {
    return { why: `its history could not be read (${failureKind(e)})`, fact: false };
  }
}

export type NewTenantAdmission =
  | { admitted: true; digest: string; fresh: boolean }
  | ({ admitted: false } & NewTenantRefusal);

/**
 * PROVE IT NEW AND RECORD IT, under the caller's lease, before its first
 * spawn: the volume and Postgres read again (newTenantRefusal), then the
 * insert, in a transaction that holds nothing but the insert. The lease proof
 * is asked before the reads, before the insert and after it: an insert whose
 * lease went meanwhile is rolled back. A record already there (another
 * replica's, or this process's before a restart) admits it as it stands.
 * Never throws: every failure is an answer that holds the tenant.
 *
 * WHY THE READS ARE NOT IN THE TRANSACTION. On Postgres one failed statement
 * aborts the whole transaction, and a table not made yet is read as empty
 * here (absentTable); inside it, that one absent table would have refused
 * every new tenant for good. Under the lease nothing of ours writes the
 * tenant's history meanwhile (no worker runs for it), and whatever else might
 * is met by the new-book gate on the spawn this record precedes.
 */
export async function admitNewTenant(db: Db, s: NewTenantScope & { level: AdmissionLevel; nowMs: number; mayWrite: () => boolean }): Promise<NewTenantAdmission> {
  const lost = "its lease was lost before the admission could be recorded";
  try {
    scopeOk(s);
    if (!s.mayWrite()) return { admitted: false, why: lost, fact: false };
    await ensureNewTenantAdmissions(db);
    const recorded = async () => (await db.prepare("SELECT evidence_digest FROM fleet_new_tenant_admissions WHERE tenant = ?").get(s.tenant)) as
      { evidence_digest?: unknown } | undefined;
    const had = await recorded();
    if (had) return { admitted: true, digest: String(had.evidence_digest), fresh: false };
    const refused = await newTenantRefusal(db, s);
    if (refused) return { admitted: false, ...refused };
    if (!s.mayWrite()) return { admitted: false, why: lost, fact: false };
    const digest = newTenantEvidenceDigest(s, s.level);
    const fresh = await db.tx(async (tx) => {
      const r = await tx.prepare(`INSERT INTO fleet_new_tenant_admissions (tenant, smart_account, chain_id, level_at_admission, admitted_at_ms, evidence_digest)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tenant) DO NOTHING`).run(s.tenant, s.account, s.chainId, s.level, s.nowMs, digest);
      // Thrown, not returned: the transaction rolls the insert back.
      if (!s.mayWrite()) throw new Error(lost);
      return r.changes === 1;
    });
    if (fresh) return { admitted: true, digest, fresh: true };
    const now = await recorded();
    return now ? { admitted: true, digest: String(now.evidence_digest), fresh: false } : { admitted: false, why: "the record could not be read back", fact: false };
  } catch (e) {
    return { admitted: false, why: e instanceof Error && e.message === lost ? lost : `the admission could not be recorded (${failureKind(e)})`, fact: false };
  }
}
