import { readRequestPurpose } from "@/lib/account-purpose";
/** An authenticated owner prepares recovery; only the subsequent fresh grant can re-enable the worker. */
import { readFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { grantPurpose, grantPerp, readPerpRecoveryReference, samePerpRecoveryAttempt, GRANT_PERP_LIGHTER, LIGHTER_ROUTE_V1, isHostedMode, type PerpRecoveryReference, type StoredGrant } from '@merrymen/core';
import { homePaths, purposeHome } from '@merrymen/home';
import { getGrantStore } from '@merrymen/grant-store';
import { tenantOf } from '@/lib/auth';
import { ownerMismatch, OWNER_CHANGED_SETTING } from '@/lib/order-owner';
import { withReadDb } from '@/lib/ledger';
import { NO_STORE_HEADERS, perRouteLimiter, perpsOptInOffered, storeDek } from '@/lib/perp-custody';
import { readPerpRecoveryContext, verifyLiveOwnerRecovery } from '../../../../../../worker/src/perps/owner-recovery-live';
import { createLighterApi } from '../../../../../../worker/src/perps/api';
import { apiKeySlotOf } from '../../../../../../worker/src/perps/onboard';
import { hostedPerpKeygen, selfHostedPerpKeygen } from '../../../../../../worker/src/perps/keygen';
export const dynamic = 'force-dynamic';
const limit = perRouteLimiter(3);
const reply = (body: object, status = 200) => NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
export async function POST(req: Request) {
 const hosted = isHostedMode(), tenant = hosted ? tenantOf(req) : null;
 if (hosted && !tenant) return reply({ error: 'not signed in' }, 401);
  const purpose = readRequestPurpose(req);
  if (!purpose) return reply({ error: "Invalid account purpose" }, 400);
 let body: Record<string, unknown>;
 try { body = await req.json(); } catch { return reply({ error: 'Expected recovery transaction and operation hashes.' }, 400); }
 if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true || !/^0x[0-9a-fA-F]{64}$/.test(String(body.txHash ?? '')) || !/^0x[0-9a-fA-F]{64}$/.test(String(body.userOpHash ?? ''))) return reply({ error: 'Confirm recovery and supply its transaction and operation hashes.' }, 400);
 if (hosted && (typeof body.owner !== 'string' || ownerMismatch(body.owner, tenant))) return reply({ error: OWNER_CHANGED_SETTING }, 409);
 if (!limit(tenant ?? 'self-hosted').ok) return reply({ error: 'Wait a minute before preparing another recovery.' }, 429);
 try {
  const stored = hosted ? await getGrantStore(purpose).get(tenant!) : JSON.parse(await readFile(homePaths.grant(purpose), 'utf8')) as StoredGrant;
  const old = grantPerp(stored);
  if (!stored || grantPurpose(stored) !== purpose || !old) return reply({ error: 'An armed perpetual permission is required to prepare re-enablement.' }, 409);
  if (!perpsOptInOffered(stored.smartAccount)) return reply({ error: 'Live perpetuals are not offered for this account.' }, 403);
  const context = await withReadDb(db => { if (!db) throw new Error('The recovery ledger could not be read.'); return readPerpRecoveryContext(db, stored.smartAccount); }, hosted ? "spot" : purpose);
  const accepted = readPerpRecoveryReference(stored.perpRecovery);
  const retry = accepted !== null && accepted.newPublicKey === old.apiPublicKey && accepted.smartAccount === stored.smartAccount.toLowerCase() && accepted.oldPublicKey === context.oldPublicKey && accepted.incidentId === context.incidentId && accepted.evidenceDigest === context.evidenceDigest && accepted.accountIndex === context.accountIndex;
  if (context.oldPublicKey !== old.apiPublicKey && !retry) return reply({ error: 'The active permission changed after this incident. Refresh before continuing.' }, 409);
  const slot = apiKeySlotOf(await createLighterApi({ home: purposeHome(purpose), budgetKey: stored.smartAccount }).apikeys(context.accountIndex, LIGHTER_ROUTE_V1.apiKeyIndex));
  if (typeof slot !== 'object') return reply({ error: 'The current recovery key could not be read from Lighter.' }, 503);
  const dek = hosted ? storeDek() : null;
  if (hosted && !dek) return reply({ error: 'This service cannot securely hold a new venue key right now.' }, 503);
  // A crash after intake may leave the newly signed key waiting for an expired proof.
  // Keep that exact held key, re-prove the same operation, and require another owner signature.
  const key = retry ? { apiPublicKey: old.apiPublicKey, apiKeyIndex: old.apiKeyIndex, ...(old.apiKeySealed ? { apiKeySealed: old.apiKeySealed } : {}) } : hosted ? await hostedPerpKeygen({ tenant: tenant!, smartAccount: stored.smartAccount, dek: dek! }) : await selfHostedPerpKeygen({ home: purposeHome(purpose) });
  const reference: PerpRecoveryReference = { v: 1, smartAccount: stored.smartAccount.toLowerCase() as `0x${string}`, chainId: LIGHTER_ROUTE_V1.chainId, route: GRANT_PERP_LIGHTER, accountIndex: context.accountIndex, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, incidentId: context.incidentId, evidenceDigest: context.evidenceDigest, txHash: String(body.txHash).toLowerCase() as `0x${string}`, userOpHash: String(body.userOpHash).toLowerCase() as `0x${string}`, recoveryPublicKey: slot.publicKey, oldPublicKey: context.oldPublicKey as `0x${string}`, newPublicKey: key.apiPublicKey, notAfterMs: Date.now() + 15 * 60_000 };
  if (retry && !samePerpRecoveryAttempt(accepted, reference)) return reply({ error: 'This pending recovery must be re-proved against its original operation, incident and current recovery key.' }, 409);
  const proof = await verifyLiveOwnerRecovery(reference, context, { newPublicKey: key.apiPublicKey, home: purposeHome(purpose) });
  if (!proof.ok) return reply({ error: `Recovery remains halted: ${proof.why}` }, 409);
  return reply({ recovery: reference, key, detail: 'Recovery verified. Review and sign the fresh permission to re-enable this key. Your settings, consent and entry halt remain in force.' });
 } catch (e) { return reply({ error: e instanceof Error ? e.message : 'Recovery could not be verified.' }, 503); }
}
