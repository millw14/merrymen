import { accountingHoldTenants } from "./accounting-maintenance";

export const RECEIPT_ATTESTATION_CONTROLS = new Set([
  "MERRYMEN_RECEIPT_ATTEST_ACCOUNT", "MERRYMEN_RECEIPT_ATTEST_TENANT", "MERRYMEN_RECEIPT_ATTEST_MODE", "MERRYMEN_RECEIPT_ATTEST_APPROVAL",
]);
export interface ReceiptAttestationRequest {
  account: string; tenant: string; mode: "dry-run" | "commit"; approvedDigest?: string;
}
export function receiptAttestationRequest(env: Record<string, string | undefined>): ReceiptAttestationRequest | null {
  const account = env.MERRYMEN_RECEIPT_ATTEST_ACCOUNT?.trim().toLowerCase();
  const tenant = env.MERRYMEN_RECEIPT_ATTEST_TENANT?.trim().toLowerCase();
  const mode = env.MERRYMEN_RECEIPT_ATTEST_MODE?.trim() || "dry-run";
  const approvedDigest = env.MERRYMEN_RECEIPT_ATTEST_APPROVAL?.trim();
  if (![...RECEIPT_ATTESTATION_CONTROLS].some(name => env[name] !== undefined)) return null;
  if (!account || !tenant || !/^0x[0-9a-f]{40}$/.test(account) || !/^0x[0-9a-f]{40}$/.test(tenant) || !["dry-run", "commit"].includes(mode)
      || (mode === "commit" ? !approvedDigest || !/^[0-9a-f]{64}$/.test(approvedDigest) : !!approvedDigest)) {
    throw new Error("Receipt attestation requires one complete account and tenant, dry-run or commit, and an exact approval digest for commit only.");
  }
  return { account, tenant, mode: mode as "dry-run" | "commit", ...(approvedDigest ? { approvedDigest } : {}) };
}

/** The only one-shot allowed during staged rollout: complete, named and held. */
export function scopedReceiptAttestationAllowed(env: Record<string, string | undefined>, census: readonly string[]): boolean {
  if (!census.length || census.some(name => !RECEIPT_ATTESTATION_CONTROLS.has(name))
      || !["dry-run", "commit"].includes(env.MERRYMEN_RECEIPT_ATTEST_MODE ?? "")) return false;
  try {
    const request = receiptAttestationRequest(env);
    return !!request && accountingHoldTenants(env).has(request.tenant);
  } catch { return false; }
}

/** The supervisor supplies its freshly read complete grant roster, never an operator assertion. */
export function receiptAttestationTenant(request: ReceiptAttestationRequest, roster: readonly { tenant: string; account: string }[]): `0x${string}` {
  const matches = roster.filter(row => row.account.toLowerCase() === request.account);
  if (matches.length !== 1 || matches[0]!.tenant.toLowerCase() !== request.tenant) {
    throw new Error("Receipt attestation account must resolve to exactly the declared tenant in the current grant roster.");
  }
  return request.tenant as `0x${string}`;
}
