import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe,it } from 'node:test';
import { wrapSqlite,type Db } from '../db';
import { applyLedgerSchema,JOURNAL_GENESIS,journalHash } from '../store';
import { captureFinancialCapsule } from './hosted-financial-capsule';
import { captureFinancialStream,decodeFinancialRecords,encodeFinancialRecord,inspectFinancialStream,restoreFinancialStream,transformFinancialStream,type FinancialStreamRecord } from './hosted-financial-stream';
const ACCOUNT='0x00000000000000000000000000000000000000a1';
async function fixture(){const raw=new DatabaseSync(':memory:'),db=wrapSqlite(raw);await applyLedgerSchema(db);await db.prepare("INSERT INTO agents (smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at) VALUES (?,?,?,4663,'{}',1,2000000000)").run(ACCOUNT,ACCOUNT,ACCOUNT);return {raw,db};}
async function* split(bytes:Buffer){for(let i=0;i<bytes.length;i+=13)yield bytes.subarray(i,i+13);}
async function bytes(db:Db){return db.tx(async tx=>{const chunks:Buffer[]=[];for await(const x of captureFinancialStream(tx,ACCOUNT))chunks.push(x);return Buffer.concat(chunks);});}
async function addJournal(db:Db,payload='🙂'){const prev=await db.prepare('SELECT hash FROM journal ORDER BY seq DESC LIMIT 1').get() as {hash:string}|undefined;const head=prev?.hash??JOURNAL_GENESIS;await db.prepare("INSERT INTO journal(agent_id,epoch,kind,payload_json,prev_hash,hash,at) VALUES (?,1,'fill',?,?,?,100)").run(ACCOUNT,payload,head,journalHash(head,payload));}
describe('streamed financial recovery',()=>{
 it('round trips complete histories beyond old row caps with bounded SQL batches and split UTF8',async()=>{
  const a=await fixture(),b=await fixture();try{
   a.raw.exec('BEGIN');const insert=a.raw.prepare("INSERT INTO equity(agent_id,eth_wei,cash_usdg,vault_usdg,equity_usdg) VALUES (?,'0',0,0,?)");for(let i=0;i<40001;i++)insert.run(ACCOUNT,i);a.raw.exec('COMMIT');await addJournal(a.db);
   let maxBatch=0;const bounded:Db={...a.db,tx:fn=>a.db.tx(fn),exec:s=>a.db.exec(s),prepare(sql){const q=a.db.prepare(sql);return {...q,all:async(...args)=>{const rows=await q.all(...args);maxBatch=Math.max(maxBatch,rows.length);return rows;}};}};
   await restoreFinancialStream(b.db,captureFinancialStream(bounded,ACCOUNT),ACCOUNT);
   assert.equal((await b.db.prepare('SELECT count(*) AS n FROM equity').get() as {n:number}).n,40001);assert.ok(maxBatch<=128);
   const serialized=await bytes(b.db);const summary=await inspectFinancialStream(split(serialized),ACCOUNT);assert.equal(summary.tableCounts.equity,40001);assert.equal(summary.journalProof.count,1);
  }finally{a.raw.close();b.raw.close();}
 });
 it('proves exact prior journal metadata and rejects a shortened or replaced prefix',async()=>{
  const f=await fixture();try{await addJournal(f.db);const before=await bytes(f.db),prior=(await inspectFinancialStream([before],ACCOUNT)).journalProof;await addJournal(f.db,'next');await inspectFinancialStream([await bytes(f.db)],ACCOUNT,{priorJournalProof:prior});await f.db.prepare("UPDATE journal SET kind='other' WHERE seq=1").run();await assert.rejects(inspectFinancialStream([await bytes(f.db)],ACCOUNT,{priorJournalProof:prior}),/prefix replaced/);await f.db.prepare('DELETE FROM journal').run();await assert.rejects(inspectFinancialStream([await bytes(f.db)],ACCOUNT,{priorJournalProof:prior}),/incomplete/);}finally{f.raw.close();}
 });
 it('rolls back destination changes on truncated footer, foreign rows, schema errors or late digest failure',async()=>{
  const a=await fixture(),b=await fixture();try{await a.db.prepare('INSERT INTO paper_book(agent_id,cash_usdg) VALUES (?,123)').run(ACCOUNT);await b.db.prepare('INSERT INTO paper_book(agent_id,cash_usdg) VALUES (?,7)').run(ACCOUNT);const valid=await bytes(a.db);
   const variants=[valid.subarray(0,valid.length-15),Buffer.from(valid.toString().replace('"cash_usdg":123','"evil_column":123')),Buffer.from(valid.toString().replace('"agent_id":"'+ACCOUNT+'"','"agent_id":"0x00000000000000000000000000000000000000ff"'))];
   for(const bad of variants){await assert.rejects(restoreFinancialStream(b.db,[bad],ACCOUNT));assert.equal((await b.db.prepare('SELECT cash_usdg FROM paper_book').get() as {cash_usdg:number}).cash_usdg,7);}
   async function* late(){yield valid;throw new Error('page digest mismatch');}await assert.rejects(restoreFinancialStream(b.db,late(),ACCOUNT),/digest/);assert.equal((await b.db.prepare('SELECT cash_usdg FROM paper_book').get() as {cash_usdg:number}).cash_usdg,7);
  }finally{a.raw.close();b.raw.close();}
 });
 it('narrows public identity/live perps while retaining exact full journal and scrubs replay bytes',async()=>{
  const f=await fixture();try{await addJournal(f.db);await f.db.prepare("INSERT INTO perp_orders(id,agent_id,mode,epoch,status,effect,reduce_only,worst_notional_micro,tx_info) VALUES ('live',?,'live',1,'submitted','close',1,'0','SIGNED'),('paper',?,'paper',1,'submitted','close',1,'0','PAPER')").run(ACCOUNT,ACCOUNT);const full=await bytes(f.db),records:FinancialStreamRecord[]=[];for await(const r of decodeFinancialRecords(transformFinancialStream([full],ACCOUNT,{scope:'standdown',stripReplay:true})))records.push(r);assert.ok(!records.some(r=>r.type==='table'&&r.name==='paper_book'));const rows=records.filter((r):r is Extract<FinancialStreamRecord,{type:'row'}>=>r.type==='row');assert.ok(!rows.some(r=>r.value.mode==='paper'));assert.equal(rows.find(r=>r.value.id==='live')!.value.tx_info,null);assert.deepEqual((await inspectFinancialStream(records.map(encodeFinancialRecord),ACCOUNT)).journalProof,(await inspectFinancialStream([full],ACCOUNT)).journalProof);}finally{f.raw.close();}
 });
 it('adapts bounded legacy v2 checkpoints but requires complete ordered v3 tables and terminal marker',async()=>{
  const f=await fixture();try{await addJournal(f.db);const legacy=await f.db.tx(tx=>captureFinancialCapsule(tx,ACCOUNT));assert.equal((await inspectFinancialStream(split(legacy),ACCOUNT)).journalProof.count,1);const full=await bytes(f.db);await assert.rejects(inspectFinancialStream([Buffer.concat([full,encodeFinancialRecord({type:'end'})])],ACCOUNT),/order/);await assert.rejects(inspectFinancialStream([Buffer.from(full.toString().replace('"name":"trades"','"name":"agents"'))],ACCOUNT),/table order/);}finally{f.raw.close();}
 });
});
