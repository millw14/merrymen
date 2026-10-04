import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { STOCK_TOKENS } from "../../packages/core/src/index";
import { readPaperPerformance } from "../../web/src/lib/paper-return";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";
import { PAPER_CHECKPOINT_SCHEMA, recordPaperRecoveryHealth } from "./paper-checkpoint";
import { refreshIdlePaperValuations, type IdlePaperOptions, type PaperQuoteRead } from "./paper-idle-valuation";

const ACCOUNT="0x"+"a".repeat(40);
const OTHER="0x"+"b".repeat(40);
const STOCK=STOCK_TOKENS.find(t=>t.symbol==='NVDA')!;
const quotes=():PaperQuoteRead=>({blockNumber:500n,blockAt:995,quotes:[
  {symbol:STOCK.symbol,token:STOCK.address,price8:100n*10n**8n,multiplier:10n**18n,updatedAt:950},
]});

async function world(){
  const raw=new DatabaseSync(':memory:');
  const db=wrapSqlite(raw);
  await applyLedgerSchema(db);
  await db.exec(PAPER_CHECKPOINT_SCHEMA);
  await db.prepare(`INSERT INTO agents(smart_account,owner_address,session_key_address,caps,granted_at,expires_at,
    chain_id,epoch,mode,status,beat_at,created_at,hwm_usdg,accrued_fee_usdg)
    VALUES(?,'owner','session','{}',90,500,4663,1,'paper','active',100,90,1000,2)`).run(ACCOUNT);
  await db.prepare(`INSERT INTO equity(agent_id,eth_wei,cash_usdg,vault_usdg,positions_usdg,equity_usdg,epoch,mode,at)
    VALUES(?,'0',1000,0,0,1000,1,'paper',100)`).run(ACCOUNT);
  await db.prepare(`INSERT INTO paper_checkpoints VALUES(?,1,590,10,1000,?,?,108)`).run(ACCOUNT.toUpperCase(),
    JSON.stringify({NVDA:{token:STOCK.address,shares:2}}),
    JSON.stringify([{symbol:'NVDA',qty_raw:'2000000000000000000',cost_usdg:'400000000'}]));
  // All three operations are included in the complete checkpoint, whose
  // second-resolution timestamp is equal to their recording time.
  for(const [kind,side] of [['swap','buy'],['swap','buy'],['vault-deposit',null]] as const) await db.prepare(`
    INSERT INTO trades(agent_id,epoch,kind,target,amount_usdg,status,fill_side,created_at)
    VALUES(?,1,?,'0x0',10,'paper',?,108)`).run(ACCOUNT,kind,side);
  await recordPaperRecoveryHealth(db,ACCOUNT,false);
  const options:IdlePaperOptions={now:1000,isRunning:()=>false,lockIdleAccount:async()=>true,readQuotes:async()=>quotes()};
  const counts=async()=>({
    marks:Number((await db.prepare('SELECT COUNT(*) AS n FROM equity').get() as {n:number}).n),
    proofs:Number((await db.prepare('SELECT COUNT(*) AS n FROM paper_valuation_proofs').get() as {n:number}).n),
  });
  return {db,raw,options,counts,close(){raw.close();}};
}

test('an idle post-fill checkpoint receives a measured mark and immutable proof, without reseeding or charging it',async()=>{
  const w=await world();
  try{
    const source=await w.db.prepare('SELECT cash_usdg,vault_usdg,hwm_usdg,shares,basis_json,updated_at FROM paper_checkpoints').get();
    const out=await refreshIdlePaperValuations(w.db,w.options);
    assert.equal(out.written,1);
    assert.deepEqual(await w.counts(),{marks:2,proofs:1});
    const p=await readPaperPerformance(w.db,ACCOUNT,1);
    assert.equal(p?.equityUsdg,800);
    assert.equal(p?.pnlUsdg,-200);
    assert.equal(p?.pnlBps,-2000);
    assert.equal(p?.pnlAt,1000);
    const proof=await w.db.prepare('SELECT * FROM paper_valuation_proofs').get() as {checkpoint_json:string;checkpoint_hash:string;marks_json:string;block_number:string;paper_operations:number};
    assert.equal(proof.checkpoint_hash,createHash('sha256').update(proof.checkpoint_json).digest('hex'));
    assert.equal(JSON.parse(proof.checkpoint_json).cash_usdg,590);
    assert.equal(proof.block_number,'500');
    assert.equal(proof.paper_operations,3);
    assert.equal(JSON.parse(proof.marks_json)[0].valueUsdgMicros,'200000000');
    assert.deepEqual(await w.db.prepare('SELECT cash_usdg,vault_usdg,hwm_usdg,shares,basis_json,updated_at FROM paper_checkpoints').get(),source);
    const agent=await w.db.prepare('SELECT hwm_usdg,accrued_fee_usdg FROM agents').get() as {hwm_usdg:number;accrued_fee_usdg:number};
    assert.deepEqual({...agent},{hwm_usdg:1000,accrued_fee_usdg:2});
    assert.equal((await w.db.prepare('SELECT COUNT(*) AS n FROM flows').get() as {n:number}).n,0);
    assert.equal((await refreshIdlePaperValuations(w.db,w.options)).written,0,'a repeat does not add another observation at the same time');
  }finally{w.close();}
});

test('corporate-action multiplier and oracle price apply to the same invariant paper quantity',async()=>{
  const w=await world();
  try{
    w.options.readQuotes=async()=>{
      const q=quotes();q.quotes=[{...q.quotes[0]!,price8:50n*10n**8n,multiplier:2n*10n**18n}];return q;
    };
    assert.equal((await refreshIdlePaperValuations(w.db,w.options)).written,1);
    assert.equal((await readPaperPerformance(w.db,ACCOUNT,1))?.equityUsdg,800);
  }finally{w.close();}
});

for(const [label,change] of [
  ['checkpoint cash',async(w:Awaited<ReturnType<typeof world>>)=>w.db.exec('UPDATE paper_checkpoints SET cash_usdg=589')],
  ['checkpoint inventory',async(w:Awaited<ReturnType<typeof world>>)=>w.db.prepare('UPDATE paper_checkpoints SET shares=?').run(JSON.stringify({NVDA:{token:STOCK.address,shares:3}}))],
  ['checkpoint basis',async(w:Awaited<ReturnType<typeof world>>)=>w.db.exec("UPDATE paper_checkpoints SET basis_json='[]'")],
  ['account epoch',async(w:Awaited<ReturnType<typeof world>>)=>w.db.exec('UPDATE agents SET epoch=2')],
  ['account mode',async(w:Awaited<ReturnType<typeof world>>)=>w.db.exec("UPDATE agents SET mode='live'")],
  ['fresh heartbeat',async(w:Awaited<ReturnType<typeof world>>)=>w.db.exec('UPDATE agents SET beat_at=999')],
  ['recovery hold',async(w:Awaited<ReturnType<typeof world>>)=>w.db.exec('UPDATE paper_recovery_health SET blocked=1')],
  ['same-second new paper operation',async(w:Awaited<ReturnType<typeof world>>)=>w.db.prepare("INSERT INTO trades(agent_id,epoch,kind,target,amount_usdg,status,created_at) VALUES(?,1,'swap','0x0',5,'paper',108)").run(ACCOUNT)],
  ['new measurement',async(w:Awaited<ReturnType<typeof world>>)=>w.db.prepare("INSERT INTO equity(agent_id,eth_wei,cash_usdg,vault_usdg,positions_usdg,equity_usdg,epoch,mode,at) VALUES(?,'0',590,10,200,800,1,'paper',999)").run(ACCOUNT)],
] as const){
  test(`a concurrent change to ${label} refuses the stale observation`,async()=>{
    const w=await world();
    try{
      w.options.readQuotes=async()=>{await change(w);return quotes();};
      assert.equal((await refreshIdlePaperValuations(w.db,w.options)).written,0);
      assert.equal((await w.counts()).proofs,0);
      assert.equal((await w.counts()).marks,label==='new measurement'?2:1);
    }finally{w.close();}
  });
}

test('current local workers are refused before any chain read',async()=>{
  const w=await world();
  try{
    w.options.isRunning=()=>true;
    w.options.readQuotes=async()=>{throw new Error('must not read');};
    const out=await refreshIdlePaperValuations(w.db,w.options);
    assert.equal(out.reasons['worker-running'],1);
    assert.deepEqual(await w.counts(),{marks:1,proofs:0});
  }finally{w.close();}
});

test('a worker that starts while the oracle is reading refuses the new mark',async()=>{
  const w=await world();
  try{
    let running=false;
    w.options.isRunning=()=>running;
    w.options.readQuotes=async()=>{running=true;return quotes();};
    assert.equal((await refreshIdlePaperValuations(w.db,w.options)).written,0);
    assert.deepEqual(await w.counts(),{marks:1,proofs:0});
  }finally{w.close();}
});

test('an unavailable remote-worker tenant lease refuses the shared measurement',async()=>{
  const w=await world();
  try{
    let called=false;
    w.options.lockIdleAccount=async(tx,account)=>{called=true;assert.notEqual(tx,w.db);assert.equal(account,ACCOUNT);return false;};
    assert.equal((await refreshIdlePaperValuations(w.db,w.options)).written,0);
    assert.equal(called,true);
    assert.deepEqual(await w.counts(),{marks:1,proofs:0});
  }finally{w.close();}
});

test('measurement and its proof roll back together when the proof cannot commit',async()=>{
  const w=await world();
  try{
    // Create schema with a deliberately blocked first read so no measurement
    // happens before the trigger models a durable proof failure.
    await refreshIdlePaperValuations(w.db,{...w.options,isRunning:()=>true});
    await w.db.exec("CREATE TRIGGER refuse_proof BEFORE INSERT ON paper_valuation_proofs BEGIN SELECT RAISE(ABORT,'proof refused'); END;");
    assert.equal((await refreshIdlePaperValuations(w.db,w.options)).written,0);
    assert.deepEqual(await w.counts(),{marks:1,proofs:0});
  }finally{w.close();}
});

for(const [label,mutate] of [
  ['an unread price',(q:PaperQuoteRead)=>{q.quotes=[];}],
  ['a nonpositive price',(q:PaperQuoteRead)=>{q.quotes=[{...q.quotes[0]!,price8:0n}];}],
  ['an unread multiplier',(q:PaperQuoteRead)=>{q.quotes=[{...q.quotes[0]!,multiplier:0n}];}],
  ['a wrong token',(q:PaperQuoteRead)=>{q.quotes=[{...q.quotes[0]!,token:OTHER}];}],
  ['a future oracle round',(q:PaperQuoteRead)=>{q.quotes=[{...q.quotes[0]!,updatedAt:1001}];}],
  ['an old quote block',(q:PaperQuoteRead)=>{q.blockAt=800;}],
] as const){
  test(`idle valuation refuses ${label}`,async()=>{
    const w=await world();
    try{
      w.options.readQuotes=async()=>{const q=quotes();mutate(q);return q;};
      assert.equal((await refreshIdlePaperValuations(w.db,w.options)).written,0);
      assert.deepEqual(await w.counts(),{marks:1,proofs:0});
    }finally{w.close();}
  });
}

test('held and invalid paper books cannot acquire a measurement',async()=>{
  for(const sql of [
    'UPDATE paper_recovery_health SET blocked=1',
    'UPDATE equity SET flows_held=1',
    "UPDATE paper_checkpoints SET basis_json='[]'",
    "UPDATE paper_checkpoints SET cash_usdg=-1",
    `UPDATE paper_checkpoints SET shares='{"FAKE":{"token":"${OTHER}","shares":2}}'`,
  ]){
    const w=await world();
    try{
      await w.db.exec(sql);
      assert.equal((await refreshIdlePaperValuations(w.db,w.options)).written,0);
      assert.deepEqual(await w.counts(),{marks:1,proofs:0});
    }finally{w.close();}
  }
});

test('cursor progression cannot let one invalid book permanently hide a later valid book',async()=>{
  const w=await world();
  try{
    await w.db.prepare(`INSERT INTO agents(smart_account,owner_address,session_key_address,caps,granted_at,expires_at,
      chain_id,epoch,mode,beat_at,created_at) VALUES(?,'owner2','session2','{}',90,500,4663,1,'paper',100,90)`).run(OTHER);
    await w.db.prepare("INSERT INTO equity(agent_id,eth_wei,cash_usdg,vault_usdg,positions_usdg,equity_usdg,epoch,mode,at) VALUES(?,'0',1000,0,0,1000,1,'paper',100)").run(OTHER);
    await w.db.prepare('INSERT INTO paper_checkpoints SELECT ?,epoch,cash_usdg,vault_usdg,hwm_usdg,shares,basis_json,updated_at FROM paper_checkpoints').run(OTHER);
    await recordPaperRecoveryHealth(w.db,OTHER,false);
    await w.db.prepare("UPDATE paper_checkpoints SET basis_json='[]' WHERE LOWER(agent_id)=?").run(ACCOUNT);
    const first=await refreshIdlePaperValuations(w.db,{...w.options,limit:1});
    assert.equal(first.written,0);assert.equal(first.nextAccount,ACCOUNT);
    const second=await refreshIdlePaperValuations(w.db,{...w.options,limit:1,afterAccount:first.nextAccount!});
    assert.equal(second.written,1);assert.equal(second.nextAccount,OTHER);
    const end=await refreshIdlePaperValuations(w.db,{...w.options,limit:1,afterAccount:second.nextAccount!});
    assert.equal(end.checked,0);assert.equal(end.nextAccount,null);
  }finally{w.close();}
});
