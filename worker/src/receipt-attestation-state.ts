import { tablePresent, type Db } from "./db";

/** Permanent evidence, including failed/interrupted repairs. Never delete on grant removal. */
export const RECEIPT_ATTESTATION_SCHEMA = `CREATE TABLE IF NOT EXISTS ledger_receipt_attestations (
  tenant TEXT PRIMARY KEY, approval_digest TEXT NOT NULL UNIQUE, plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','applied')),
  created_at_ms BIGINT NOT NULL, applied_at_ms BIGINT
)`;

export async function ensureReceiptAttestationSchema(db: Db): Promise<void> {
  await db.exec(RECEIPT_ATTESTATION_SCHEMA);
}

/** Read-only; absence is possible before this additive protocol has ever been installed. */
export async function readReceiptAttestation(db: Db, tenant: string): Promise<Record<string, unknown> | undefined> {
  if (!await tablePresent(db, "ledger_receipt_attestations")) return undefined;
  return await db.prepare("SELECT * FROM ledger_receipt_attestations WHERE tenant = ?").get(tenant.toLowerCase()) as Record<string, unknown> | undefined;
}

/** Startup installs the schema first. A failed read always refuses admission. */
export async function assertNoPendingReceiptAttestation(db: Db, tenant: string): Promise<void> {
  const row = await db.prepare("SELECT state FROM ledger_receipt_attestations WHERE tenant = ?").get(tenant.toLowerCase()) as { state?: unknown } | undefined;
  if (row && row.state !== "applied") throw new Error("Original receipt attestation is unfinished; preserve the source and its maintenance hold.");
}
