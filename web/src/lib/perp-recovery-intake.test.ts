import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GRANT_PERP_LIGHTER, type PerpRecoveryReference, type StoredGrant } from '@merrymen/core';
import { carryPerpRecovery, perpRecoveryIntakeRefusal } from './perp-recovery-intake';
const ACCOUNT = `0x${'a1'.repeat(20)}` as const, OLD=`0x${'11'.repeat(40)}` as const, NEXT=`0x${'33'.repeat(40)}` as const;
const ref:PerpRecoveryReference={v:1,smartAccount:ACCOUNT,chainId:4663,route:GRANT_PERP_LIGHTER,accountIndex:123,apiKeyIndex:16,incidentId:'11111111-2222-4333-8444-555555555555',evidenceDigest:'a'.repeat(64),txHash:`0x${'11'.repeat(32)}`,userOpHash:`0x${'22'.repeat(32)}`,recoveryPublicKey:`0x${'22'.repeat(40)}`,oldPublicKey:OLD,newPublicKey:NEXT,notAfterMs:1};
const grant=(apiPublicKey:string,recovery?:PerpRecoveryReference)=>({smartAccount:ACCOUNT,chainId:4663,grantFeatures:[GRANT_PERP_LIGHTER],perp:{route:GRANT_PERP_LIGHTER,apiKeyIndex:16,apiPublicKey},...(recovery?{perpRecovery:recovery}:{})}) as StoredGrant;
function fixture() {
 let verifies=0,reads=0;
 const deps={context:async()=>{reads++;return {smartAccount:ACCOUNT,accountIndex:123,incidentId:ref.incidentId,oldPublicKey:OLD,retiredKeys:[],evidenceDigest:ref.evidenceDigest};},verify:async(reference:PerpRecoveryReference)=>{verifies++;return {ok:true as const,verified:{reference,blockHash:`0x${'ab'.repeat(32)}`,blockNumber:1n,rotationLogIndex:1}};}};
 return {deps,counts:()=>({verifies,reads})};
}
describe('recovery grant intake',()=>{
 it('independently proves a fresh recovery and refuses another prior key/account',async()=>{
  const f=fixture(), fresh={...ref,notAfterMs:Date.now()+60_000};
  assert.equal(await perpRecoveryIntakeRefusal(grant(OLD),grant(NEXT,fresh),f.deps),null);
  assert.deepEqual(f.counts(),{reads:1,verifies:1});
  for(const prior of [null,grant(NEXT),{...grant(OLD),smartAccount:`0x${'b2'.repeat(20)}` as const}]) assert.equal((await perpRecoveryIntakeRefusal(prior,grant(NEXT,fresh),f.deps))?.status,409);
 });
 it('requires new proof when an accepted-but-unapplied recovery expires and the owner re-signs the retained key',async()=>{
  const f=fixture(), accepted=grant(NEXT,ref), fresh={...ref,notAfterMs:Date.now()+60_000};
  assert.equal(await perpRecoveryIntakeRefusal(accepted,grant(NEXT,fresh),f.deps),null);
  assert.deepEqual(f.counts(),{reads:1,verifies:1});
  const denied={...f.deps,verify:async()=>({ok:false as const,why:'current slot changed'})};
  assert.match((await perpRecoveryIntakeRefusal(accepted,grant(NEXT,fresh),denied))!.error,/current slot changed/);
  for(const changed of [{evidenceDigest:'b'.repeat(64)},{txHash:`0x${'44'.repeat(32)}` as const},{newPublicKey:OLD}]) assert.equal((await perpRecoveryIntakeRefusal(accepted,grant(NEXT,{...fresh,...changed}),f.deps))?.status,409);
 });
 it('exact carry-forward grants no fresh acknowledgement and cannot change the signed target',async()=>{
  const f=fixture(), accepted=grant(NEXT,ref);
  assert.equal(await perpRecoveryIntakeRefusal(accepted,{...accepted},f.deps),null);
  assert.deepEqual(f.counts(),{reads:0,verifies:0});
  assert.equal((await perpRecoveryIntakeRefusal(accepted,grant(OLD,ref),f.deps))?.status,409);
 });
 it('a normal same-key renewal retains pending recovery for an interrupted worker',()=>{
  const accepted=grant(NEXT,ref),renewed=carryPerpRecovery(accepted,grant(NEXT));
  assert.deepEqual(renewed.perpRecovery,ref);
  assert.equal(carryPerpRecovery(accepted,grant(OLD)).perpRecovery,undefined);
  assert.equal(carryPerpRecovery(accepted,{...grant(NEXT),smartAccount:`0x${'b2'.repeat(20)}`}).perpRecovery,undefined);
  const fresh={...ref,notAfterMs:2}; assert.deepEqual(carryPerpRecovery(accepted,grant(NEXT,fresh)).perpRecovery,fresh);
 });
 it('unreadable evidence and a mismatched wall are refusals',async()=>{
  const f=fixture();
  assert.equal((await perpRecoveryIntakeRefusal(grant(OLD),grant(NEXT,ref),{...f.deps,context:async()=>{throw new Error('database unavailable');}}))?.status,409);
  assert.equal((await perpRecoveryIntakeRefusal(grant(OLD),{...grant(NEXT,ref),chainId:46630},f.deps))?.status,409);
 });
});
