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
 *  - ledger_resume_approvals: one per (tenant, evidence digest). At most one
 *    OPEN approval per tenant (approved → archiving → archived → registered);
 *    applied, refused and revoked are terminal.
 *  - ledger_resume_attestations: what each registered generation archived and
 *    replaced, with the receipt digest bound into tenant_ledger_import.
 *  - mirror_state_archive / ledger_snapshot_archive: the exact pre-images.
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
  UNIQUE (tenant, evidence_digest)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ledger_resume_one_open_per_tenant ON ledger_resume_approvals (tenant)
  WHERE state IN ('approved','archiving','archived','registered')`,
  `CREATE TABLE IF NOT EXISTS ledger_resume_attestations (
  generation TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE, tenant TEXT NOT NULL, smart_account TEXT NOT NULL, chain_id BIGINT NOT NULL,
  owner TEXT NOT NULL, evidence_digest TEXT NOT NULL, receipt_digest TEXT NOT NULL, mirror_state_digest TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL, archive_path TEXT, gap_from_sec BIGINT, created_at_ms BIGINT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS mirror_state_archive (
  generation TEXT NOT NULL, tenant TEXT NOT NULL, table_name TEXT NOT NULL, last_id BIGINT NOT NULL, last_stamp BIGINT,
  updated_at BIGINT NOT NULL, archived_at_ms BIGINT NOT NULL, PRIMARY KEY (generation, table_name)
)`,
  `CREATE TABLE IF NOT EXISTS ledger_snapshot_archive (
  generation TEXT NOT NULL, tenant TEXT NOT NULL, table_name TEXT NOT NULL, seq BIGINT NOT NULL, row_digest TEXT NOT NULL,
  row_json TEXT NOT NULL, archived_at_ms BIGINT NOT NULL, PRIMARY KEY (generation, table_name, seq)
)`,
];
