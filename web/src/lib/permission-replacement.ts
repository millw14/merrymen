/** A grant selected for revocation must never be silently re-armed from storage. */
type GrantIdentity = { smartAccount: string; chainId: number; sessionKeyAddress: string };
const key = (grant: GrantIdentity) => `merrymen.permission-replacement.v1.${grant.chainId}.${grant.smartAccount.toLowerCase()}.${grant.sessionKeyAddress.toLowerCase()}`;

export function needsPermissionReplacement(grant: GrantIdentity): boolean {
  try { return localStorage.getItem(key(grant)) === "1"; }
  catch { return true; } // An unreadable journal cannot establish that re-arming is safe.
}

/** Persist BEFORE revocation, including unknown results across a browser crash. */
export function markPermissionForReplacement(grant: GrantIdentity): void {
  localStorage.setItem(key(grant), "1");
}
