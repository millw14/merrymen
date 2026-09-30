/** Grant intake repeats verification; client-side preparation is never authority. */
import { grantPerp, readPerpRecoveryReference, samePerpRecoveryAttempt, type StoredGrant } from '@merrymen/core';
import { merrymenHome } from '@merrymen/home';
import { withReadDb } from './ledger';
import { readPerpRecoveryContext, verifyLiveOwnerRecovery, type PerpRecoveryContext } from '../../../worker/src/perps/owner-recovery-live';
import type { PerpRefusal } from './perp-custody';
interface RecoveryIntakeReads {
 context(account: string): Promise<PerpRecoveryContext>;
 verify: typeof verifyLiveOwnerRecovery;
}
const reads: RecoveryIntakeReads = {
 context: account => withReadDb(db => { if (!db) throw new Error('The ledger could not be read.'); return readPerpRecoveryContext(db, account); }),
 verify: verifyLiveOwnerRecovery,
};
export async function perpRecoveryIntakeRefusal(stored: StoredGrant | null, incoming: StoredGrant, deps: RecoveryIntakeReads = reads): Promise<PerpRefusal | null> {
 if (incoming.perpRecovery === undefined) return null;
 const ref = readPerpRecoveryReference(incoming.perpRecovery), next = grantPerp(incoming), old = grantPerp(stored);
 const no = (error: string): PerpRefusal => ({ status: 409, code: 'perp-recovery-unverified', error });
 if (!ref || !next || ref.smartAccount !== incoming.smartAccount.toLowerCase() || ref.newPublicKey !== next.apiPublicKey || ref.chainId !== incoming.chainId) return no('The recovery reference does not match this fresh permission.');
 // Carrying the exact accepted reference cannot acknowledge a new incident.
 if (old?.apiPublicKey === next.apiPublicKey && stored?.smartAccount.toLowerCase() === ref.smartAccount && JSON.stringify(stored.perpRecovery) === JSON.stringify(ref)) return null;
 const retry = old?.apiPublicKey === next.apiPublicKey && samePerpRecoveryAttempt(stored?.perpRecovery, ref);
 if (!old || (!retry && old.apiPublicKey !== ref.oldPublicKey) || stored?.smartAccount.toLowerCase() !== ref.smartAccount) return no('The prior permission changed after recovery was prepared. Review recovery again.');
 try {
  const context = await deps.context(ref.smartAccount);
  const proof = await deps.verify(ref, context, { newPublicKey: next.apiPublicKey, home: merrymenHome() });
  return proof.ok ? null : no(`Recovery remains halted: ${proof.why}`);
 } catch { return no('Recovery evidence could not be checked. The existing permission remains in place.'); }
}

/** Normal same-key renewals cannot erase an accepted recovery that a stopped worker has yet to apply. */
export function carryPerpRecovery(stored: StoredGrant | null, incoming: StoredGrant): StoredGrant {
 if (incoming.perpRecovery !== undefined) return incoming;
 const ref = readPerpRecoveryReference(stored?.perpRecovery), old = grantPerp(stored), next = grantPerp(incoming);
 if (!ref || !old || !next || stored?.smartAccount.toLowerCase() !== incoming.smartAccount.toLowerCase() || ref.smartAccount !== incoming.smartAccount.toLowerCase() || old.apiPublicKey !== next.apiPublicKey || ref.newPublicKey !== next.apiPublicKey) return incoming;
 return { ...incoming, perpRecovery: ref };
}
