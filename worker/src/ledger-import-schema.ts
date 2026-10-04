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
