import { recoveryRecord, recoveryEvidenceDigest } from './owner-recovery-state';
import { GRANT_PERP_LIGHTER, type PerpRecoveryReference } from '../../../packages/core/src/index';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { wrapSqlite } from '../db';
import { applyLedgerSchema } from '../store';
import { MIRROR_STATE_DDL, mirrorPerpLedger } from '../ledger-mirror';
import { captureFinancialCapsule, restoreFinancialCapsule } from './hosted-financial-capsule';
import { captureFinancialStream, restoreFinancialStream } from './hosted-financial-stream';
import { appendEntryControl, mergeEntryControls, preserveAccountControls, readOwnerControls, initialOwnerControls } from './owner-controls';
const A = `0x${'a1'.repeat(20)}`;
const legacy = (halted = 0) => ({ agent_id: A, mode: 'live', entries_halted: halted, owner_controls_json: null as string | null, retired_pubkeys: '[]' });
const change = (row: ReturnType<typeof legacy>, halted: boolean) => ({ ...row, owner_controls_json: appendEntryControl(row, halted), entries_halted: halted ? 1 : 0 });
async function fixture() { const raw = new DatabaseSync(':memory:'), db = wrapSqlite(raw); await applyLedgerSchema(db); await db.exec(MIRROR_STATE_DDL); return { raw, db }; }
async function put(f: Awaited<ReturnType<typeof fixture>>, row: ReturnType<typeof legacy>) {
  await f.db.prepare('INSERT INTO perp_accounts(agent_id,mode,entries_halted,owner_controls_json,retired_pubkeys) VALUES (?,?,?,?,?) ON CONFLICT(agent_id,mode) DO UPDATE SET entries_halted=excluded.entries_halted,owner_controls_json=excluded.owner_controls_json,retired_pubkeys=excluded.retired_pubkeys').run(row.agent_id,row.mode,row.entries_halted,row.owner_controls_json,row.retired_pubkeys);
}
async function pass(a: Awaited<ReturnType<typeof fixture>>, b: Awaited<ReturnType<typeof fixture>>) { const copied: Record<string, number> = {}, failed: Record<string, string> = {}; await mirrorPerpLedger({ child: a.db, shared: b.db, tenant: A, nowSec: 100, batch: 500, copied, failed }); return failed; }
const rowOf = async (f: Awaited<ReturnType<typeof fixture>>) => await f.db.prepare('SELECT * FROM perp_accounts').get() as ReturnType<typeof legacy>;
describe('durable owner entry controls', () => {
 it('resumes a mirrored legacy halt without relying on timestamps, preserving a later halt against stale resume', async () => {
  const a = await fixture(), b = await fixture(); try {
   const held = { ...legacy(1), owner_controls_json: initialOwnerControls(A, "live", true) }, resumed = change(held, false), haltedAgain = change(resumed, true);
   await put(a, held); assert.deepEqual(await pass(a, b), {});
   await put(a, resumed); assert.deepEqual(await pass(a, b), {}); assert.equal((await rowOf(b)).entries_halted, 0);
   await put(a, haltedAgain); assert.deepEqual(await pass(a, b), {}); assert.equal((await rowOf(b)).entries_halted, 1);
   await put(a, resumed); assert.deepEqual(await pass(a, b), {}); assert.equal((await rowOf(b)).entries_halted, 1);
  } finally { a.raw.close(); b.raw.close(); }
 });
 it('refuses divergent history, unknown legacy halt, forged hash and cross-account history', () => {
  const held = legacy(), first = change(held, true), branch = change(held, false);
  assert.throws(() => mergeEntryControls(first, branch), /conflicting branches/);
  assert.throws(() => mergeEntryControls(legacy(1), branch), /omit the existing halt/);
  assert.throws(() => readOwnerControls(first.owner_controls_json, `0x${'b2'.repeat(20)}`, 'live'), /binding/);
  const broken = JSON.parse(first.owner_controls_json!); broken.events[0].halted = false;
  assert.throws(() => readOwnerControls(JSON.stringify(broken), A, 'live'), /does not verify/);
  assert.throws(() => preserveAccountControls({ ...first, entries_halted: 0 }), /contradicts/);
 });
 for (const format of ['capsule', 'stream', 'legacy'] as const) it(`${format} restoration keeps newer controls and retired keys when restoring old authority`, async () => {
  const a = await fixture(), b = await fixture(); try {
   const halted = change(legacy(), true), resumed = change(halted, false), latest = change(resumed, true);
   await put(a, resumed); await put(b, { ...latest, retired_pubkeys: JSON.stringify([`0x${'11'.repeat(40)}`]) });
   if (format === 'stream') await restoreFinancialStream(b.db, captureFinancialStream(a.db, A), A);
   else {
    const x = JSON.parse((await captureFinancialCapsule(a.db, A)).toString());
    if (format === 'legacy') { delete x.tables.perp_accounts[0].owner_controls_json; x.tables.perp_accounts[0].entries_halted = 0; }
    await restoreFinancialCapsule(b.db, Buffer.from(JSON.stringify(x)), A);
   }
   const row = await rowOf(b); assert.equal(row.entries_halted, 1); assert.equal(row.owner_controls_json, latest.owner_controls_json); assert.match(row.retired_pubkeys, /111111/);
  } finally { a.raw.close(); b.raw.close(); }
 });
 it('keeps controls even if an older checkpoint has no account row', async () => {
  const a = await fixture(), b = await fixture(); try {
   const halted = change(legacy(), true); await put(b, halted);
   await restoreFinancialStream(b.db, captureFinancialStream(a.db, A), A);
   assert.equal((await rowOf(b)).owner_controls_json, halted.owner_controls_json);
   await restoreFinancialCapsule(b.db, await captureFinancialCapsule(a.db, A), A);
   assert.equal((await rowOf(b)).owner_controls_json, halted.owner_controls_json);
  } finally { a.raw.close(); b.raw.close(); }
 });
});

const OLD=`0x${'11'.repeat(40)}` as const, NEXT=`0x${'33'.repeat(40)}` as const;
const reference:PerpRecoveryReference={v:1,smartAccount:A as `0x${string}`,chainId:4663,route:GRANT_PERP_LIGHTER,accountIndex:123,apiKeyIndex:16,incidentId:'11111111-2222-4333-8444-555555555555',evidenceDigest:recoveryEvidenceDigest([]),txHash:`0x${'11'.repeat(32)}`,userOpHash:`0x${'22'.repeat(32)}`,recoveryPublicKey:`0x${'22'.repeat(40)}`,oldPublicKey:OLD,newPublicKey:NEXT,notAfterMs:1000};
const recovered=JSON.stringify([recoveryRecord(reference,[OLD],[])]);
async function evidence(f:Awaited<ReturnType<typeof fixture>>, done:boolean, incident=reference.incidentId) {
 await f.db.prepare('UPDATE perp_accounts SET incident_json=?,incident_id=?,incident_sealed_pubkey=?,recoveries_json=?,retired_pubkeys=?').run(done?null:JSON.stringify({kind:'unmatched-fill',at:100}),done?null:incident,done?null:OLD,done?recovered:null,JSON.stringify(done?[OLD]:[]));
}
describe('durable exact recovery acknowledgement',()=>{
 for(const format of ['mirror','capsule','stream'] as const) it(`${format} preserves known acknowledgement, suppresses only its old incident and retains a novel one`,async()=>{
  const a=await fixture(),b=await fixture(); try {
   const halt=change(legacy(),true); await put(a,halt);await put(b,halt); await evidence(a,false);await evidence(b,true);
   const copy=async()=>{if(format==='mirror')assert.deepEqual(await pass(a,b),{});else if(format==='stream')await restoreFinancialStream(b.db,captureFinancialStream(a.db,A),A);else await restoreFinancialCapsule(b.db,await captureFinancialCapsule(a.db,A),A);};
   await copy(); let row=await b.db.prepare('SELECT * FROM perp_accounts').get() as Record<string,unknown>;
   assert.equal(row.incident_id,null);assert.equal(row.recoveries_json,recovered);assert.equal(row.entries_halted,1);assert.equal(row.retired_pubkeys,JSON.stringify([OLD]));
   await evidence(a,false,'22222222-3333-4444-8555-666666666666');await copy();row=await b.db.prepare('SELECT * FROM perp_accounts').get() as Record<string,unknown>;
   assert.equal(row.incident_id,'22222222-3333-4444-8555-666666666666');assert.equal(row.recoveries_json,recovered);
  }finally{a.raw.close();b.raw.close();}
 });
 it('a checkpoint cannot retain an acknowledgement while dropping the keys it retired',()=>{
  assert.throws(()=>preserveAccountControls({...legacy(),recoveries_json:recovered}),/lost retired keys/);
 });
});
