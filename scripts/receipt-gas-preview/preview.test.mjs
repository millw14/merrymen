import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile, writeFile, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview, canonical, collectSnapshot, digest, intendedDelta, parseArgs, plainSummary, readQuery, targetDigest, sourceFingerprint, savePreview, validateScope } from './preview.mjs';
import { recoverGasProof, createReadOnlyChain, RPC_METHODS } from './runtime.ts';

const account = `0x${'a'.repeat(40)}`, tx = `0x${'1'.repeat(64)}`, op = `0x${'2'.repeat(64)}`, blockHash = `0x${'3'.repeat(64)}`;
const slug = 'bm74qsj64fygkhjh';
const scope = [{slug,account}];
const time = 1790000000;
const hex32 = x => BigInt(x).toString(16).padStart(64,'0');
function fixture({ owner = false, priced = true } = {}) {
  const row = { id: '1', agent_id: account, epoch: 2, status: 'landed', tx_hash: tx, user_op_hash: op, user_op_nonce: '7',
    gas_wei: null, sponsored_gas_wei: null, gas_units: null, gas_usdg: null, gas_recorded_at: null };
  const receipt = { transactionHash: tx, blockHash, blockNumber: 100n, status: 'success', logs: [{
    address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    topics: ['0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f', op,
      `0x${account.slice(2).padStart(64,'0')}`, `0x${(owner ? '0'.repeat(40) : 'b'.repeat(40)).padStart(64,'0')}`],
    data: `0x${hex32(7)}${hex32(1)}${hex32(1000000000000000n)}${hex32(200000)}`,
  }] };
  const chain = { chainId: async () => 4663, head: async () => 200n, receipt: async () => receipt,
    block: async () => ({ hash: blockHash, timestamp: BigInt(time) }),
    latestRound: async () => priced ? ({roundId:1n,priceUsd:2500,updatedAt:time-60}) : null,
    round: async () => null };
  const snapshot = { schema: { gasRecordedAtPresent: false, userOpNoncePresent: true },
    bindings: [{ slug, account, state:'bound-current-named-account', canonicalAgent:{ account, canonicalAddress:account,epoch:2,chainId:4663 } }],
    snapshots: [{ row, protectedSnapshotDigest: digest('protected-source-row'), snapshotDigest: digest(row) }] };
  const options = { snapshot, scope, chain, recoverGasProof, target: digest('test-db'),
    source: {gitHead:'68193034586ab0ce29a427b3c4cdd54cdf5d36dd'}, capturedAt: '2026-10-04T00:00:00.000Z' };
  return { row, receipt, chain, snapshot, options };
}
function pgFixture({ hasTime = false, hasNonce = true, isolation = 'repeatable read', readOnly = 'on', failRows = false, identities, agents, missingColumns = [] } = {}) {
  const f = fixture(); const commands = [];
  const columns = ['id','agent_id','epoch','status','user_op_hash','tx_hash','gas_wei','sponsored_gas_wei','gas_units','gas_usdg',
    ...(hasTime?['gas_recorded_at']:[]), ...(hasNonce?['user_op_nonce']:[])];
  const client = { query: async (sql, params) => {
    commands.push({sql,params});
    if (/^(BEGIN|ROLLBACK)/.test(sql)) return {};
    if (sql.includes('current_setting')) return { rows: [{ read_only: readOnly, isolation }] };
    if (sql.includes('information_schema')) return { rows: columns.filter(c=>!missingColumns.includes(c)).map(column_name => ({column_name})) };
    if (sql.includes('FROM agent_identity')) return { rows: identities ?? [{slug,accounts:[account]}] };
    if (sql.includes('AS protected_snapshot_text')) {
      if (failRows) throw new Error('private database failure text must not escape the runner');
      return { rows: [{...f.row, protected_snapshot_text:'{"amount_usdg":987654.321,"private_balance":123456789}'}] };
    }
    return { rows: agents ?? [{ smart_account:account,epoch:2,chain_id:4663,beat_at:100,created_at:1,owner_address:account }] };
  } };
  return { ...f, client, commands };
}

describe('standalone preview-only runner', () => {
  it('the actual CLI executes under /tmp realpath aliases and help never loads or opens a database', async () => {
    const path=fileURLToPath(new URL('./preview.mjs',import.meta.url));
    const invocation=path.replace('/private/tmp/','/tmp/');
    const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',invocation,'--help'],{env:{...process.env,DATABASE_URL:'DO-NOT-CONNECT'}});
    assert.match(stdout,/PREVIEW ONLY/); assert.match(stdout,/--agent PUBLIC_SLUG=0xACCOUNT/);
    await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx',invocation,'--commit','yes']),error=>error.code===1 && /invalid-arguments/.test(error.stderr));
  });
  it('requires a bounded explicit account scope and rejects all commit/apply/migration flags', () => {
    assert.deepEqual(parseArgs(['--agent',`${slug}=${account}`,'--output','/tmp/new.json']),{scope,output:'/tmp/new.json'});
    for (const args of [[], ['--output','/tmp/p.json'], ['--agent','all','--output','/tmp/p.json'],
      ['--agent',`${slug}=${account}`,'--agent',`${slug}=${account}`,'--output','/tmp/p.json'], ['--commit', 'yes'], ['--apply','preview.json'],
      ['--migrate','true'], ['--agent',`${slug}=${account}`,'--output','relative.json'], ['--account',account,'--output','/tmp/p.json']]) assert.throws(() => parseArgs(args));
  });
  it('binds the supplied public slug to a unique current canonical registration and refuses ambiguity', async () => {
    const other=`0x${'c'.repeat(40)}`;
    const registration={smart_account:account,epoch:2,chain_id:4663,beat_at:100,created_at:1,owner_address:account};
    const cases=[
      [{identities:[]},'public-slug-not-found'],
      [{identities:[{slug,accounts:[other]}]},'slug-address-mismatch'],
      [{identities:[{slug,accounts:[account]},{slug:'0'.repeat(16),accounts:[account]}]},'ambiguous-account-identity'],
      [{identities:[{slug,accounts:[account,other]}],agents:[registration,{...registration,smart_account:other,created_at:2}]},'address-is-not-current-for-public-slug'],
      [{agents:[{...registration,epoch:0}]},'invalid-canonical-registration'],
      [{agents:[{...registration,chain_id:0}]},'invalid-canonical-registration'],
      [{agents:[registration,{...registration,smart_account:account.toUpperCase(),chain_id:46630}]},'ambiguous-current-registration'],
      [{agents:[registration,{...registration,smart_account:account.toUpperCase(),owner_address:other}]},'ambiguous-current-registration'],
      [{identities:[{slug,accounts:[account,other]}],agents:[registration,{...registration,smart_account:other}]},'ambiguous-current-registration'],
    ];
    for(const [options,state] of cases) {
      const f=pgFixture(options); const snapshot=await collectSnapshot(f.client,scope);
      assert.equal(snapshot.bindings[0].state,state);
      const preview=await buildPreview({...f.options,snapshot});
      assert.equal(preview.summary.accountsIneligible,1); assert.equal(preview.operations[0].state,'ineligible');
      assert.deepEqual(preview.operations[0].intendedMissingFieldDelta,{});
    }
  });
  it('the isolated proof module contains no database writer or DDL and its exported chain is read-only', async () => {
    const runtime = await readFile(new URL('./runtime.ts',import.meta.url),'utf8');
    assert.doesNotMatch(runtime,/UPDATE trades|CREATE TABLE|ALTER TABLE|recordRecoveredGas|writeRecoveredGas|recoverSettledGas/);
    const chain = createReadOnlyChain('https://example.invalid/rpc');
    assert.deepEqual(Object.keys(chain).sort(),['block','chainId','head','latestRound','receipt','round']);
    assert.deepEqual(RPC_METHODS,['eth_chainId','eth_blockNumber','eth_getTransactionReceipt','eth_getBlockByNumber','eth_call']);
  });
  it('establishes and rolls back REPEATABLE READ READ ONLY without DDL; old gas-time/nonce columns use NULL aliases', async () => {
    const f = pgFixture({hasNonce:false});
    const result = await collectSnapshot(f.client,scope);
    assert.equal(f.commands[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(f.commands.at(-1).sql,'ROLLBACK');
    assert.equal(result.schema.gasRecordedAtPresent,false);
    assert.equal(result.snapshots[0].row.gas_recorded_at,null);
    const query = f.commands.find(c => c.sql.includes('protected_snapshot_text')).sql;
    assert.match(query,/NULL::integer AS gas_recorded_at/); assert.match(query,/NULL::text AS user_op_nonce/);
    assert.doesNotMatch(canonical(result),/987654|123456789|amount_usdg|private_balance/);
    assert.ok(result.snapshots[0].protectedSnapshotDigest.match(/^[a-f0-9]{64}$/));
  });
  it('refuses a database that does not prove the read-only isolation and still rolls back', async () => {
    for(const options of [{readOnly:'off'},{isolation:'read committed'},{failRows:true}]) {
      const f = pgFixture(options); await assert.rejects(collectSnapshot(f.client,scope));
      assert.equal(f.commands.at(-1).sql,'ROLLBACK');
    }
  });
  it('the query gate accepts only reads and rejects disguised mutation CTEs', async () => {
    const client={query:async()=>({rows:[]})};
    await readQuery(client,'SELECT 1');
    for(const sql of ['ALTER TABLE trades ADD COLUMN x int','WITH t AS (DELETE FROM trades RETURNING *) SELECT * FROM t',
      'SELECT 1; UPDATE trades SET gas_usdg=0','DO $$ BEGIN END $$']) await assert.rejects(readQuery(client,sql));
  });
  it('stores full sponsored receipt proof and intended NULL-field fills, never a budget/status/fill change', async () => {
    const f = fixture(); const preview = await buildPreview(f.options); const item=preview.operations[0];
    assert.equal(item.state,'eligible'); assert.equal(item.proof.recoveredGas.payer,'sponsor'); assert.equal(item.proof.recoveredGas.usdg,0);
    assert.equal(item.proof.observations.receiptEnvelope.status,'success'); assert.equal(item.proof.observations.receiptEnvelope.transactionHash,tx);
    assert.equal(item.proof.observations.receiptEnvelope.blockHash,item.proof.observations.canonicalBlock.hash);
    assert.equal(item.proof.recoveredGas.blockHash,blockHash); assert.equal(item.proof.recoveredGas.at,time);
    assert.deepEqual(item.intendedMissingFieldDelta,{sponsored_gas_wei:'1000000000000000',gas_units:'200000',gas_usdg:0,gas_recorded_at:time});
    assert.equal(preview.summary.writesPerformed,0); assert.equal(preview.summary.ddlPerformed,0);
    assert.equal(preview.summary.allRecordedOperationsHaveProvenExactOwnerExpense,true);
    assert.doesNotMatch(canonical(item.intendedMissingFieldDelta),/budget|status|fill|amount|caps|source|flags/);
  });
  it('prices owner fee with the tested historical round and binds the immutable proof digest', async () => {
    const f = fixture({owner:true}); const preview=await buildPreview(f.options); const item=preview.operations[0];
    assert.equal(item.proof.recoveredGas.usdg,2.5); assert.equal(item.proof.recoveredGas.price.roundId,'1');
    assert.equal(item.proofDigest,digest(item.proof)); assert.equal(item.proof.observations.latestRound.roundId,'1'); assert.equal(item.intendedMissingFieldDelta.gas_wei,'1000000000000000');
  });
  it('unpriced owner expenses are explicit unknown cases with no intended write delta', async () => {
    const f = fixture({owner:true,priced:false}); const preview=await buildPreview(f.options); const item=preview.operations[0];
    assert.equal(item.state,'unknown'); assert.equal(item.proof.recoveredGas.usdg,null);
    assert.deepEqual(item.intendedMissingFieldDelta,{}); assert.equal(preview.summary.unknownOwnerGasPrices,1);
    assert.equal(preview.summary.allRecordedOperationsHaveProvenExactOwnerExpense,false);
  });
  it('independently reprices an existing owner USDG value, refusing zero, mismatch or unavailable corroboration', async () => {
    for(const [recorded,priced,expected] of [[0,true,'unknown'],[2.500001,true,'unknown'],[2.5,false,'unknown'],[2.5,true,'eligible']]) {
      const f=fixture({owner:true,priced}); f.row.gas_usdg=recorded;
      const preview=await buildPreview(f.options); const item=preview.operations[0];
      assert.equal(item.state,expected); assert.equal(item.row.gas_usdg,recorded);
      assert.ok(!Object.hasOwn(item.intendedMissingFieldDelta,'gas_usdg'));
      if(expected==='unknown') {
        assert.deepEqual(item.intendedMissingFieldDelta,{});
        assert.equal(preview.summary.allRecordedOperationsHaveProvenExactOwnerExpense,false);
      }
    }
  });
  it('retains the selected, latest and immediate successor round observations for offline boundary review', async () => {
    const f=fixture({owner:true});
    f.chain.latestRound=async()=>({roundId:3n,priceUsd:2600,updatedAt:time+100});
    f.chain.round=async id=>({roundId:id,priceUsd:2500,updatedAt:id===1n?time-1000:id===2n?time-60:time+100});
    const preview=await buildPreview(f.options); const proof=preview.operations[0].proof;
    assert.equal(proof.recoveredGas.price.roundId,'2'); assert.equal(proof.observations.latestRound.roundId,'3');
    assert.ok(proof.observations.roundReads.some(r=>r.requestedRoundId==='3' && Number(r.round.updatedAt)>time));
  });
  it('unknown, ineligible and complete rows remain visible without fabricated zero', async () => {
    const f = fixture(); f.chain.receipt=async()=>{throw new Error('secret-url-not-for-output');};
    const unknown=await buildPreview(f.options); assert.equal(unknown.operations[0].state,'unknown');
    assert.equal(unknown.operations[0].proof,null); assert.deepEqual(unknown.operations[0].intendedMissingFieldDelta,{});
    f.row.tx_hash=null; const ineligible=await buildPreview(f.options); assert.equal(ineligible.operations[0].state,'ineligible');
    assert.doesNotMatch(canonical(ineligible),/secret-url/);
    const g=fixture(); Object.assign(g.row,{sponsored_gas_wei:'1000000000000000',gas_units:'200000',gas_usdg:0,gas_recorded_at:time});
    const complete=await buildPreview(g.options); assert.equal(complete.operations[0].state,'already-complete');
  });
  it('wrong RPC chain is refused and missing/current-other-chain accounts are reported', async () => {
    const f=fixture(); f.chain.chainId=async()=>46630; await assert.rejects(buildPreview(f.options),/rpc-is-not/);
    f.chain.chainId=async()=>4663; f.snapshot.bindings[0].canonicalAgent.chainId=46630; f.snapshot.bindings[0].state='ineligible-chain';
    const other=await buildPreview(f.options); assert.equal(other.scope[0].state,'ineligible-chain'); assert.equal(other.operations[0].state,'ineligible');
    f.snapshot.bindings[0].state='account-not-found'; f.snapshot.bindings[0].canonicalAgent=null; const missing=await buildPreview(f.options); assert.equal(missing.scope[0].state,'account-not-found');
  });
  it('never replaces an already recorded value in the proposed delta', () => {
    const f=fixture(); f.row.gas_usdg=99; f.row.gas_units='123';
    const delta=intendedDelta(f.row,{payer:'owner',gasWei:'100',gasUnits:'200',usdg:2,at:time});
    assert.deepEqual(delta,{gas_wei:'100',gas_recorded_at:time});
  });
  it('scope, snapshots, protected row fingerprints, proof, and delta tampering changes review digest', async () => {
    const preview=await buildPreview(fixture().options); const {previewDigest,...body}=preview;
    assert.equal(digest(body),previewDigest);
    for(const mutate of [p=>{p.scope[0].account='0xother';},p=>{p.operations[0].row.status='reverted';},
      p=>{p.operations[0].protectedSnapshotDigest='different';},p=>{p.operations[0].proof.recoveredGas.gasWei='0';},
      p=>{p.operations[0].intendedMissingFieldDelta.gas_usdg=100;}]) {
      const changed=structuredClone(body); mutate(changed); assert.notEqual(digest(changed),previewDigest);
    }
  });
  it('console summary reveals only aggregates and public gas field counts; credentials and balances are excluded', async () => {
    const preview=await buildPreview(fixture().options); const summary=plainSummary(preview);
    assert.match(summary,/PREVIEW ONLY/); assert.match(summary,/gas_recorded_at=1/);
    assert.doesNotMatch(summary,/1000000000000000|balance|DATABASE_URL|987654|private/);
    const secret='postgresql://private-user:private-password@db.example/db?password=private-password';
    const hash=targetDigest(secret); assert.match(hash,/^[a-f0-9]{64}$/); assert.doesNotMatch(hash,/private/);
    assert.equal(hash,targetDigest('postgresql://different:rotated@db.example/db'));
  });
  it('saved previews with invalid PG numeric values retain a recomputable digest and an explicit refusal', async () => {
    for(const invalid of [NaN,Infinity,-Infinity]) {
      const f=fixture(); f.row.gas_usdg=invalid;
      const result=await buildPreview(f.options); const saved=JSON.parse(JSON.stringify(result));
      const {previewDigest,...body}=saved;
      assert.equal(digest(body),previewDigest); assert.equal(saved.operations[0].state,'ineligible');
      assert.equal(saved.operations[0].row.gas_usdg.invalidNumber,String(invalid));
    }
  });
  it('no recorded operations does not make a claim that a portfolio has been recovered', async () => {
    const f=fixture(); f.snapshot.snapshots=[]; const p=await buildPreview(f.options);
    assert.equal(p.summary.allRecordedOperationsHaveProvenExactOwnerExpense,false);
    assert.equal(p.summary.recordedExpenseCoverage,'no-recorded-settled-operations');
  });
  it('invalid number markers preserve a digest through JSON serialization instead of masquerading as zero', () => {
    const value={gas_usdg:NaN}; const normalized=JSON.parse(canonical(value));
    assert.deepEqual(normalized,{gas_usdg:{invalidNumber:'NaN'}}); assert.equal(digest(value),digest(normalized));
  });
});


describe('standalone safety and immutable outputs', () => {
  it('accepts only bounded explicit scopes and refuses excessive rows before opening a transaction', async () => {
    const scopes=Array.from({length:256},(_,i)=>({
      slug:i.toString(16).padStart(16,'0'), account:`0x${i.toString(16).padStart(40,'0')}`,
    }));
    assert.equal(validateScope(scopes).length,256);
    assert.throws(()=>validateScope([...scopes,{slug:'ffffffffffffffff',account:`0x${'f'.repeat(40)}`}]),/invalid-arguments/);
    const f=pgFixture();
    for(const bound of [0,1501,1.5]) await assert.rejects(collectSnapshot(f.client,scope,bound),/invalid-arguments/);
    assert.deepEqual(f.commands,[]);
    assert.throws(()=>parseArgs(['--agent',`${slug}=${account}`,'--output','/tmp/a','--output','/tmp/b']),/invalid-arguments/);
  });
  it('missing required columns are unresolved, without DDL or fabricated empty-history completeness', async () => {
    const f=pgFixture({missingColumns:['gas_usdg']});
    const snapshot=await collectSnapshot(f.client,scope);
    assert.deepEqual(snapshot.schema.missingRequiredColumns,['gas_usdg']);
    assert.equal(snapshot.schema.complete,false);
    assert.equal(snapshot.bindings[0].state,'unsupported-trade-schema');
    const preview=await buildPreview({...f.options,snapshot});
    assert.equal(preview.summary.recordedExpenseCoverage,'unavailable-trade-schema');
    assert.equal(preview.summary.allRecordedOperationsHaveProvenExactOwnerExpense,false);
    assert.equal(preview.summary.accountsIneligible,1);
    assert.equal(f.commands.at(-1).sql,'ROLLBACK');
    assert.equal(f.commands.filter(c=>/^(INSERT|UPDATE|CREATE|ALTER|DELETE)/.test(c.sql)).length,0);
  });
  it('source fingerprints cover all executable repository files, without absolute workstation paths', async () => {
    const source=await sourceFingerprint();
    assert.equal(source.baseHead,'4346e3d023c32d50fda6673f56a981f10df3a349');
    assert.equal(Object.keys(source.files).length,8);
    for(const hash of Object.values(source.files)) assert.match(hash,/^[a-f0-9]{64}$/);
    assert.doesNotMatch(canonical(source),/Users|DATABASE_URL/);
  });
  it('publishes once with owner-only permissions and refuses overwrite and symlink targets', async () => {
    const folder=await mkdtemp(join(tmpdir(),'merrymen-preview-output-'));
    try {
      const output=join(folder,'new.json');
      const preview=await buildPreview(fixture().options);
      await savePreview(output,preview);
      assert.equal((await stat(output)).mode & 0o777,0o600);
      assert.deepEqual(JSON.parse(await readFile(output,'utf8')),preview);
      await assert.rejects(savePreview(output,{changed:true}),e=>e.code==='EEXIST');
      const link=join(folder,'link.json'); await symlink(output,link);
      await assert.rejects(savePreview(link,{changed:true}),e=>e.code==='EEXIST');
      assert.deepEqual(JSON.parse(await readFile(output,'utf8')),preview);
    } finally {await rm(folder,{recursive:true,force:true});}
  });
  it('rejects invalid and unsafe trade IDs without reaching receipt reads', async () => {
    for(const id of ['0','-1','1.5','9007199254740993','1e3','01']) {
      const f=fixture(); f.row.id=id; let reads=0;
      f.chain.receipt=async()=>{reads++;return f.receipt;};
      const preview=await buildPreview(f.options);
      assert.equal(preview.operations[0].state,'ineligible'); assert.equal(reads,0);
    }
  });
});
