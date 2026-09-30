/** Recovery is a ledger transition, not an incident delete or a rotation-journal flag. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { GRANT_PERP_LIGHTER, LIGHTER_ROUTE_V1, samePerpRecoveryAttempt, type PerpRecoveryReference } from '../../../packages/core/src/index';
import { recoveryFillInputFingerprint, readRecoveries, recoveryReplacementKeys } from './owner-recovery-state';
import { ownerControlHead } from './owner-controls';
import { boundedRecoveryProof } from './owner-recovery-live';
const dir = mkdtempSync(path.join(tmpdir(), 'mm-recovery-store-'));
process.env.MERRYMEN_HOME = dir; delete process.env.DATABASE_URL;
const store = await import('../store'); await store.initStore();
const raw = new DatabaseSync(path.join(dir, 'merrymen.db'));
after(() => { raw.close(); store.closeStoreForTest(); rmSync(dir, { recursive: true, force: true }); });
const OLD = `0x${'11'.repeat(40)}` as const, RECOVERY = `0x${'22'.repeat(40)}` as const, NEXT = `0x${'33'.repeat(40)}` as const;
let n = 0;
async function fixture() {
 const account = `0x${(++n).toString(16).padStart(40,'0')}` as `0x${string}`;
 await store.ensureAgent({ smartAccount: account, owner: account, sessionKeyAddress: account, serialized: 'fake', chainId: 4663, caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 10 }, grantedAt: 1, expiresAt: 2_000_000_000 } as never);
 await store.patchPerpAccount(account, 'live', { accountIndex: 123, registeredPubkey: OLD, incident: { kind: 'key-mismatch', at: 100, detail: 'receipt is required' }, incidentSealedPubkey: OLD, entriesHalted: true });
 const fill: Parameters<typeof store.insertPerpFill>[0] = { agentId: account, mode: 'live', venueTradeId: 'known-unknown', sideRole: 'bid', marketId: 1, side: 'long', role: 'taker', base: 1n, price: 1n, quoteMicro: 1n, feeMicro: 0n, tradeType: 'trade', attribution: 'venue-unknown', venueTsMs: 1000 };
 await store.insertPerpFill(fill);
 const context = await store.getPerpRecoveryContext(account);
 const ref: PerpRecoveryReference = { v: 1, smartAccount: account, chainId: LIGHTER_ROUTE_V1.chainId, route: GRANT_PERP_LIGHTER, accountIndex: 123, apiKeyIndex: 16, incidentId: context.incidentId, evidenceDigest: context.evidenceDigest, txHash: `0x${'a1'.repeat(32)}`, userOpHash: `0x${'b2'.repeat(32)}`, oldPublicKey: OLD, recoveryPublicKey: RECOVERY, newPublicKey: NEXT, notAfterMs: 2000 };
 const proof = (reference = ref) => ({ reference, blockHash: `0x${'c3'.repeat(32)}`, blockNumber: 12n, rotationLogIndex: 1 });
 return { account, fill, context, ref, proof, commit: (reference = ref) => store.commitVerifiedPerpRecovery(account, proof(reference), () => 1000) };
}
describe('verified owner recovery transaction', () => {
 it('retires the old key, acknowledges only exact facts and leaves the owner halt in force', async () => {
  const f = await fixture(); assert.equal(await f.commit(), 'applied');
  const a = (await store.getPerpAccount(f.account,'live'))!;
  assert.equal(a.incident,null); assert.equal(a.incidentId,null); assert.equal(a.entriesHalted,true); assert.deepEqual(a.retiredPubkeys,[OLD]);
  assert.equal(readRecoveries(a.recoveriesJson,f.account).length,1);
  assert.deepEqual(recoveryReplacementKeys(a.recoveriesJson,f.account,NEXT),[RECOVERY]);
  assert.deepEqual(recoveryReplacementKeys(a.recoveriesJson,f.account,OLD),[]);
  assert.equal(await store.perpFillRecoveryAcknowledged(f.account,f.fill.venueTradeId,'bid',recoveryFillInputFingerprint(f.fill)),true);
  assert.equal(await store.perpFillRecoveryAcknowledged(f.account,f.fill.venueTradeId,'bid',recoveryFillInputFingerprint({...f.fill,price:2n})),false);
  const novel = {...f.fill,venueTradeId:'new-unknown'}; await store.insertPerpFill(novel);
  assert.equal(await store.perpFillRecoveryAcknowledged(f.account,novel.venueTradeId,'bid',recoveryFillInputFingerprint(novel)),false);
  await assert.rejects(store.patchPerpAccount(f.account,'live',{registeredPubkey:OLD}),/retired/);
 });
 it('replaying the exact consumed proof cannot clear a later incident', async () => {
  const f=await fixture(); await f.commit();
  await store.patchPerpAccount(f.account,'live',{incident:{kind:'unmatched-fill',at:101},incidentSealedPubkey:NEXT});
  const next=(await store.getPerpAccount(f.account,'live'))!.incidentId;
  assert.equal(await f.commit(),'already-applied'); assert.equal((await store.getPerpAccount(f.account,'live'))!.incidentId,next);
  await assert.rejects(f.commit({...f.ref,notAfterMs:1900}),/consumed differently/);
 });
 it('refuses changed evidence, an expired grant acknowledgement, and a retired target key', async () => {
  let f=await fixture(); await store.insertPerpFill({...f.fill,venueTradeId:'late-fill'}); await assert.rejects(f.commit(),/evidence changed/);
  f=await fixture(); await assert.rejects(store.commitVerifiedPerpRecovery(f.account,f.proof(),()=>2000),/expired/);
  f=await fixture(); await store.patchPerpAccount(f.account,'live',{retirePubkeys:[NEXT]}); await assert.rejects(f.commit(),/non-retired/);
 });
 it('refuses unresolved orders and atomically rolls back a failed incident clear', async () => {
  let f=await fixture();
  raw.prepare("INSERT INTO perp_orders(id,agent_id,mode,epoch,status,effect,reduce_only,worst_notional_micro,nonce,tx_hash,account_index,api_key_index) VALUES (? ,?,'live',1,'submitted','close',1,'0',1,'hash',123,16)").run(`pending-${f.account}`,f.account);
  await assert.rejects(f.commit(),/unresolved orders/);
  f=await fixture(); const before=(await store.getPerpAccount(f.account,'live'))!;
  raw.exec("CREATE TRIGGER reject_recovery BEFORE UPDATE OF recoveries_json ON perp_accounts BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END");
  try { await assert.rejects(f.commit(),/simulated disk failure/); } finally { raw.exec('DROP TRIGGER reject_recovery'); }
  const after=(await store.getPerpAccount(f.account,'live'))!;
  assert.equal(after.incidentId,before.incidentId); assert.deepEqual(after.retiredPubkeys,[]); assert.equal(after.recoveriesJson,null);
 });
 it('refuses every unresolved L1 operation and transfer until its proven settlement',async()=>{
  for(const kind of ['perp-key','perp-deposit','perp-claim']) {
   const f=await fixture();
   assert.equal(await store.addTrade({agent_id:f.account,kind,target:'proxy',amount_usdg:0,status:'submitted',user_op_hash:`0x${'44'.repeat(32)}`}),true);
   await assert.rejects(f.commit(),/unresolved on-chain operation/);
   await assert.rejects(store.getPerpRecoveryContext(f.account),/unresolved on-chain operation/);
   assert.equal(await store.addTrade({agent_id:f.account,kind,target:'proxy',amount_usdg:0,status:'reverted',user_op_hash:`0x${'44'.repeat(32)}`}),true);
   assert.equal(await f.commit(),'applied');
  }
  for(const state of ['submitted','landed','executed'] as const) {
   const f=await fixture(), direction=state==='executed'?'withdraw':'deposit';
   const result=await store.upsertPerpTransfer({agentId:f.account,mode:'live',id:`waiting-funds-${f.account}`,direction,amountMicro:1n,initiator:'agent',state});
   assert.notEqual(result.outcome,'refused'); await assert.rejects(f.commit(),/unresolved transfer/);
  }
 });
 it('invalid owner-control history projects a halt while preserving financial reads for protection',async()=>{
  const f=await fixture(); await f.commit();
  raw.prepare("UPDATE perp_accounts SET entries_halted=0 WHERE agent_id=? AND mode='live'").run(f.account);
  const account=(await store.getPerpAccount(f.account,'live'))!;
  assert.equal(account.entriesHalted,true); assert.equal(account.accountIndex,123); assert.deepEqual(account.retiredPubkeys,[OLD]);
  await assert.rejects(store.patchPerpAccount(f.account,'live',{entriesHalted:false}),/contradicts/);
  raw.prepare("UPDATE perp_accounts SET owner_controls_json='{' WHERE agent_id=? AND mode='live'").run(f.account);
  assert.equal((await store.getPerpAccount(f.account,'live'))!.entriesHalted,true);
  await assert.rejects(store.patchPerpAccount(f.account,'live',{entriesHalted:false}),/unreadable/);
 });
 it('a later explicit halt or incident defeats a queued Resume even within the same second',async()=>{
  const f=await fixture(); await f.commit(); let a=(await store.getPerpAccount(f.account,'live'))!;
  const head=ownerControlHead(a.ownerControlsJson,f.account,'live')!;
  await store.patchPerpAccount(f.account,'live',{entriesHalted:true});
  await assert.rejects(store.patchPerpAccount(f.account,'live',{entriesHalted:false,expectedOwnerControlHead:head}),/halt changed/);
  a=(await store.getPerpAccount(f.account,'live'))!;
  await store.patchPerpAccount(f.account,'live',{incident:{kind:'unmatched-fill',at:101},incidentSealedPubkey:NEXT});
  await assert.rejects(store.patchPerpAccount(f.account,'live',{entriesHalted:false,expectedOwnerControlHead:ownerControlHead(a.ownerControlsJson,f.account,'live')!}),/incident remains halted/);
 });
 it('an accepted but unapplied recovery can be explicitly re-proved after expiry without a different target key',async()=>{
  const f=await fixture(); const accepted={...f.ref};
  await assert.rejects(store.commitVerifiedPerpRecovery(f.account,f.proof(accepted),()=>3000),/expired/);
  const refreshed={...accepted,notAfterMs:4000};
  assert.equal(samePerpRecoveryAttempt(accepted,refreshed),true);
  for(const altered of [{evidenceDigest:'f'.repeat(64)},{incidentId:'ffffffff-ffff-ffff-ffff-ffffffffffff'},{newPublicKey:`0x${'44'.repeat(40)}`},{txHash:`0x${'a2'.repeat(32)}`}]) assert.equal(samePerpRecoveryAttempt(accepted,{...refreshed,...altered}),false);
  // The fresh verification and owner signature are required at intake; their separately-tested
  // result is the only input accepted here, against the still-current exact incident/evidence.
  assert.equal(await store.commitVerifiedPerpRecovery(f.account,f.proof(refreshed),()=>3000),'applied');
 });
 it('bounds verification and ignores a successful answer that arrives after timeout',async()=>{
  const f=await fixture(); let answer!:(r:{ok:true;verified:ReturnType<typeof f.proof>})=>void;
  const late=new Promise<{ok:true;verified:ReturnType<typeof f.proof>}>(resolve=>{answer=resolve;});
  const result=await boundedRecoveryProof(()=>late,5); assert.equal(result.ok,false);
  answer({ok:true,verified:f.proof()}); await Promise.resolve();
  assert.equal((await store.getPerpAccount(f.account,'live'))!.incidentId,f.ref.incidentId);
 });
});
