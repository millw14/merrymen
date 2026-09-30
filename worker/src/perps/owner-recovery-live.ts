/** Read-only network adapter shared by authenticated intake and the worker. */
import { createPublicClient, http } from 'viem';
import { chainForId, LIGHTER_ROUTE_V1, type PerpRecoveryReference } from '../../../packages/core/src/index';
import type { Db } from '../db';
import { createLighterApi } from './api';
import { lighterReadFromClient, venueFlatness } from './flatness';
import { apiKeySlotOf } from './onboard';
import { recoveryEvidenceDigest, recoveryFillFingerprint } from './owner-recovery-state';
import { verifyOwnerRecoveryProof, type OwnerRecoveryProofResult } from './owner-recovery-proof';

export interface PerpRecoveryContext { smartAccount: string; accountIndex: number; incidentId: string; oldPublicKey: string; retiredKeys: string[]; evidenceDigest: string }
export async function readPerpRecoveryContext(db: Db, smartAccount: string): Promise<PerpRecoveryContext> {
 const account = smartAccount.toLowerCase();
 const row = await db.prepare("SELECT account_index,incident_id,incident_json,incident_sealed_pubkey,retired_pubkeys FROM perp_accounts WHERE agent_id = ? AND mode = 'live'").get(account) as Record<string, unknown> | undefined;
 if (!row || row.incident_json == null || typeof row.incident_id !== 'string' || typeof row.incident_sealed_pubkey !== 'string' || !Number.isSafeInteger(row.account_index) || Number(row.account_index) < 1) throw new Error('The current key incident is not ready for recovery verification. Wait for the upgraded worker to record its identity.');
 const retiredKeys = JSON.parse(String(row.retired_pubkeys ?? '[]')) as unknown;
 if (!Array.isArray(retiredKeys) || retiredKeys.some(k => typeof k !== 'string')) throw new Error('The retired key history could not be read.');
 await assertPerpRecoverySettled(db, account);
 const fills = await db.prepare("SELECT * FROM perp_fills WHERE agent_id = ? AND mode = 'live' AND attribution = 'venue-unknown'").all(account) as Record<string, unknown>[];
 return { smartAccount: account, accountIndex: Number(row.account_index), incidentId: row.incident_id, oldPublicKey: row.incident_sealed_pubkey, retiredKeys: retiredKeys as string[], evidenceDigest: recoveryEvidenceDigest(fills.map(recoveryFillFingerprint)) };
}
export async function verifyLiveOwnerRecovery(reference: PerpRecoveryReference, context: PerpRecoveryContext, opts: { newPublicKey: string; home: string; rpcUrl?: string }) {
 const client = createPublicClient({ chain: chainForId(LIGHTER_ROUTE_V1.chainId), transport: http(opts.rpcUrl, { timeout: 5_000, retryCount: 0 }) });
 const chainRead = lighterReadFromClient(client as unknown as { readContract: (args: never) => Promise<unknown> });
 const api = createLighterApi({ home: opts.home, budgetKey: reference.smartAccount });
 return boundedRecoveryProof(() => verifyOwnerRecoveryProof(reference, {
  now: Date.now, smartAccount: context.smartAccount, incidentId: context.incidentId, evidenceDigest: context.evidenceDigest,
  oldPublicKey: context.oldPublicKey, newPublicKey: opts.newPublicKey, retiredKeys: context.retiredKeys,
  readChainId: () => client.getChainId(),
  readReceipt: async hash => { const r = await client.getTransactionReceipt({ hash: hash as `0x${string}` }); return { ...r, logs: r.logs }; },
  readCanonicalBlockHash: async blockNumber => (await client.getBlock({ blockNumber })).hash,
  readAccountIndex: async () => { const n = await chainRead({ functionName: 'addressToAccountIndex', args: [reference.smartAccount] }); return typeof n === 'bigint' ? n : null; },
  readSlot: async () => { const slot = apiKeySlotOf(await api.apikeys(reference.accountIndex, LIGHTER_ROUTE_V1.apiKeyIndex)); return typeof slot === 'object' ? slot.publicKey : null; },
  readFlat: async () => (await venueFlatness({ smartAccount: reference.smartAccount, chainId: LIGHTER_ROUTE_V1.chainId, read: chainRead, home: opts.home })).flat,
 }));
}

/** A stalled read must not occupy the protective lane indefinitely. Late answers confer no authority. */
export async function boundedRecoveryProof(read: () => Promise<OwnerRecoveryProofResult>, timeoutMs = 15_000): Promise<OwnerRecoveryProofResult> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try {
  return await Promise.race([read(), new Promise<OwnerRecoveryProofResult>(resolve => {
   timer = setTimeout(() => resolve({ ok: false, why: 'Recovery verification timed out. The incident remains halted; retry after the venue responds.' }), timeoutMs);
  })]);
 } finally { if (timer) clearTimeout(timer); }
}

/** No age-based waiver: signed L1 operations and in-transit funds can outlive a flat venue read. */
export async function assertPerpRecoverySettled(db: Db, account: string): Promise<void> {
 if (await db.prepare("SELECT 1 FROM perp_orders WHERE agent_id = ? AND mode = 'live' AND status = 'submitted' LIMIT 1").get(account)) throw new Error('perp recovery has unresolved orders; reconcile before re-enabling');
 if (await db.prepare("SELECT 1 FROM trades WHERE LOWER(agent_id) = ? AND kind IN ('perp-key','perp-deposit','perp-claim') AND status = 'submitted' LIMIT 1").get(account)) throw new Error('perp recovery has an unresolved on-chain operation; wait for its proven outcome before re-enabling');
 if (await db.prepare("SELECT 1 FROM perp_transfers WHERE agent_id = ? AND mode = 'live' AND state IN ('submitted','landed','executed') LIMIT 1").get(account)) throw new Error('perp recovery has an unresolved transfer; wait for funds to settle before re-enabling');
}
