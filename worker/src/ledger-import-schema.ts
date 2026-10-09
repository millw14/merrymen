/** Nonpayload generation receipts survive key removal and volume loss. Pure DDL for grant-store. */
export const LEDGER_IMPORT_SCHEMA = `CREATE TABLE IF NOT EXISTS tenant_ledger_import (
  tenant TEXT PRIMARY KEY, generation TEXT NOT NULL UNIQUE, target_volume_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available','consumed','deleted')), sealed TEXT, bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL, source_digest TEXT NOT NULL, source_inode TEXT, source_identity TEXT, bindings_json TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL, consumed_at_ms BIGINT, grant_updated_at TEXT NOT NULL, grant_row_version TEXT NOT NULL
)`;
export const LEDGER_IMPORT_GENERATIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS tenant_ledger_import_generations (
  generation TEXT PRIMARY KEY, tenant TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('available','consumed','deleted'))
)`;

/**
 * ATTESTED-GAP ADMISSION (ledger-resume.ts, docs/fleet-resume.md). Pure DDL,
 * created on first use by the orchestrator. None of these tables holds a
 * financial fact the books read: they are the operator's approvals, what each
 * admission attested, and the archived pre-images of the cursor and snapshot
 * rows the new book replaces. Nothing here is ever deleted by the code.
 *
 *  - ledger_resume_preview_runs: one row per MERRYMEN_RESUME_PREVIEW run, the
 *    entries it printed, keyed by the run's own digest, so a batch approval
 *    (MERRYMEN_RESUME_APPROVE=run:<digest>) binds to exactly what was shown.
 *    The digest binds each tenant, its evidence digest and its verdict, and
 *    nothing beside them, so a later preview that comes to the same digest
 *    replaces the entries: what is said beside the verdict (the last
 *    refusal, the chain hold) is the newest reading, never the first.
 *  - ledger_resume_approvals: one per (tenant, evidence digest). At most one
 *    OPEN approval per tenant (approved → archiving → archived → registered);
 *    applied, refused and revoked are terminal. `source` says who approved:
 *    `operator` (MERRYMEN_RESUME_APPROVE; null on a row from before the
 *    column) or `auto-paper` (the orchestrator's own approval of a re-signed
 *    paper tenant, MERRYMEN_RESUME_AUTO_PAPER). `chain_read_from_sec`, on a
 *    chain refusal, is the chain time of the first block the refused read
 *    covered: while that refusal is unanswered, admission and the chain-gap
 *    booking tool never read from later than it (ledger-resume.ts
 *    resumeGapWindow). Null on every other row, and on a chain refusal an
 *    earlier build wrote, whose start is derived instead (chainReadFloor).
 *  - ledger_resume_attestations: what each registered generation archived and
 *    replaced, with the receipt digest bound into tenant_ledger_import, and
 *    the chain window read for it (chain_from_block..chain_head, both
 *    inclusive; null for a tenant that needed no chain read).
 *  - mirror_state_archive / ledger_snapshot_archive: the exact pre-images.
 *  - ledger_resume_grant_watch: under MERRYMEN_RESUME_AUTO_PAPER only, what
 *    the orchestrator last saw of each tenant's grant row (a digest of its
 *    expiry and its server-stamped update time, nothing secret), whether a
 *    change is still owed an automatic preview, and what that preview came
 *    to. The row `*` records that the roster was baselined, once, when the
 *    variable was first on: grants as they stood then are nobody's re-sign.
 *    `attempted_at_ms` is the last automatic preview of an owed change that
 *    could not be read: the least recently tried goes first, so a tenant
 *    that never reads cannot take every turn from the ones behind it.
 *    `seen_at_ms` is when the owed key was first seen: an auto-paper approval
 *    of the tenant created since is that change's answer, even one whose
 *    insert's reply was lost (ledger-resume.ts answeredGrantChanges).
 */
export const LEDGER_RESUME_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ledger_resume_preview_runs (
  run TEXT PRIMARY KEY, created_at_ms BIGINT NOT NULL, entries_json TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS ledger_resume_approvals (
  approval_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, smart_account TEXT NOT NULL, chain_id BIGINT NOT NULL, owner TEXT NOT NULL,
  evidence_digest TEXT NOT NULL, evidence_json TEXT NOT NULL, preview_run TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('approved','archiving','archived','registered','applied','refused','revoked')),
  generation TEXT UNIQUE, archive_path TEXT, reason TEXT, created_at_ms BIGINT NOT NULL, updated_at_ms BIGINT NOT NULL,
  source TEXT, chain_read_from_sec BIGINT,
  UNIQUE (tenant, evidence_digest)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ledger_resume_one_open_per_tenant ON ledger_resume_approvals (tenant)
  WHERE state IN ('approved','archiving','archived','registered')`,
  `CREATE TABLE IF NOT EXISTS ledger_resume_attestations (
  generation TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE, tenant TEXT NOT NULL, smart_account TEXT NOT NULL, chain_id BIGINT NOT NULL,
  owner TEXT NOT NULL, evidence_digest TEXT NOT NULL, receipt_digest TEXT NOT NULL, mirror_state_digest TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL, archive_path TEXT, gap_from_sec BIGINT, created_at_ms BIGINT NOT NULL,
  chain_from_block TEXT, chain_head TEXT
)`,
  `CREATE TABLE IF NOT EXISTS mirror_state_archive (
  generation TEXT NOT NULL, tenant TEXT NOT NULL, table_name TEXT NOT NULL, last_id BIGINT NOT NULL, last_stamp BIGINT,
  updated_at BIGINT NOT NULL, archived_at_ms BIGINT NOT NULL, PRIMARY KEY (generation, table_name)
)`,
  `CREATE TABLE IF NOT EXISTS ledger_snapshot_archive (
  generation TEXT NOT NULL, tenant TEXT NOT NULL, table_name TEXT NOT NULL, seq BIGINT NOT NULL, row_digest TEXT NOT NULL,
  row_json TEXT NOT NULL, archived_at_ms BIGINT NOT NULL, PRIMARY KEY (generation, table_name, seq)
)`,
  `CREATE TABLE IF NOT EXISTS ledger_resume_grant_watch (
  tenant TEXT PRIMARY KEY, grant_key TEXT NOT NULL, owed INTEGER NOT NULL CHECK (owed IN (0, 1)),
  seen_at_ms BIGINT NOT NULL, settled_at_ms BIGINT, run TEXT, outcome TEXT, attempted_at_ms BIGINT
)`,
];

/**
 * The chain window's columns, for a ledger_resume_attestations table created
 * by an earlier build of this branch, before they were in its CREATE; and the
 * approvals' `source` and `chain_read_from_sec`, for the table production
 * created before they were. Db.exec
 * makes each `ADD COLUMN IF NOT EXISTS` on Postgres; on sqlite a re-run fails
 * with "duplicate column name", which ensureLedgerResumeSchema expects.
 */
export const LEDGER_RESUME_ADDITIVE_DDL: readonly string[] = [
  "ALTER TABLE ledger_resume_attestations ADD COLUMN chain_from_block TEXT",
  "ALTER TABLE ledger_resume_attestations ADD COLUMN chain_head TEXT",
  "ALTER TABLE ledger_resume_approvals ADD COLUMN source TEXT",
  "ALTER TABLE ledger_resume_approvals ADD COLUMN chain_read_from_sec BIGINT",
];
