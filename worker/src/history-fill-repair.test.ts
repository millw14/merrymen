import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "./db";
import { repairHistoricalFills } from "./history-fill-repair";
import { CASH, STOCK_TOKENS } from "../../packages/core/src/index";
import { addressTopic } from "./inflight-reconcile";

test("receipt repair fills missing history, preserves known P&L and refuses duplicate execution rows",async()=>{
 const raw=new DatabaseSync(':memory:');const db=wrapSqlite(raw);
 const account='0x'+'1'.repeat(40),router='0x'+'2'.repeat(40);
 try{
  await db.exec(`CREATE TABLE agents(smart_account TEXT,chain_id INTEGER); CREATE TABLE trades(id INTEGER,agent_id TEXT,tx_hash TEXT,status TEXT,kind TEXT,created_at INTEGER,fill_side TEXT,fill_symbol TEXT,buy_token TEXT,sell_token TEXT,fill_cash_usdg REAL,fill_qty_raw TEXT,basis_source TEXT,realized_pnl_usdg REAL);`);
  await db.prepare('INSERT INTO agents VALUES(?,4663)').run(account);
  for(const [id,hash] of [[1,'0xaa'],[2,'0xbb'],[3,'0xbb']] as const) await db.prepare(`INSERT INTO trades(id,agent_id,tx_hash,status,kind,created_at,realized_pnl_usdg) VALUES(?,?,?,'landed','swap',1,NULL)`).run(id,account,hash);
  // More than a batch of newer ambiguous rows must not starve the older fill.
  for(let id=4;id<105;id++) await db.prepare(`INSERT INTO trades(id,agent_id,tx_hash,status,kind,created_at) VALUES(?,?,'0xbb','landed','swap',2)`).run(id,account);
  const log=(token:string,from:string,to:string,qty:bigint)=>({address:token,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',addressTopic(from),addressTopic(to)],data:'0x'+qty.toString(16)});
  const client={getTransactionReceipt:async()=>({status:'success',logs:[log(CASH.USDG,account,router,10000000n),log(STOCK_TOKENS[0]!.address,router,account,2n*10n**18n)]}),readContract:async()=>{throw new Error('no closing balance');}};
  const result=await repairHistoricalFills(db,'unused',client as never);
  assert.equal(result.repaired,1);assert.equal(result.unavailable,0);assert.equal(result.pnlRecovered,0);
  assert.deepEqual(result.reasons,{});
  const row=await db.prepare('SELECT * FROM trades WHERE id=1').get() as Record<string,unknown>;
  assert.equal(row.fill_side,'buy');assert.equal(row.fill_symbol,STOCK_TOKENS[0]!.symbol);assert.equal(row.fill_cash_usdg,10);assert.equal(row.realized_pnl_usdg,null);
  assert.equal((await db.prepare('SELECT fill_side FROM trades WHERE id=2').get() as {fill_side:null}).fill_side,null);
 }finally{raw.close();}
});

test("a second repair counts nothing — not even a coin whose name can never be stored",async()=>{
 // Counted, a coin that stays nameless for good made every orchestrator start
 // re-read every tenant's history for the chat (refreshHistoryForLiveChildren).
 const raw=new DatabaseSync(':memory:');const db=wrapSqlite(raw);
 const account='0x'+'1'.repeat(40),router='0x'+'2'.repeat(40),coin='0x'+'3'.repeat(40);
 try{
  await db.exec(`CREATE TABLE agents(smart_account TEXT,chain_id INTEGER); CREATE TABLE trades(id INTEGER,agent_id TEXT,tx_hash TEXT,status TEXT,kind TEXT,created_at INTEGER,fill_side TEXT,fill_symbol TEXT,buy_token TEXT,sell_token TEXT,fill_cash_usdg REAL,fill_qty_raw TEXT,basis_source TEXT,realized_pnl_usdg REAL);`);
  await db.prepare('INSERT INTO agents VALUES(?,4663)').run(account);
  await db.prepare(`INSERT INTO trades(id,agent_id,tx_hash,status,kind,created_at) VALUES(1,?,'0xaa','landed','swap',1)`).run(account);
  const log=(token:string,from:string,to:string,qty:bigint)=>({address:token,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',addressTopic(from),addressTopic(to)],data:'0x'+qty.toString(16)});
  // A launchpad coin calling itself a stock's ticker: the guard stores it nameless.
  const client={getTransactionReceipt:async()=>({status:'success',logs:[log(CASH.USDG,account,router,10000000n),log(coin,router,account,2n*10n**18n)]}),readContract:async({functionName}:{functionName:string})=>{if(functionName==='symbol')return STOCK_TOKENS[0]!.symbol;throw new Error('no balance');}};
  const first=await repairHistoricalFills(db,'unused',client as never);
  assert.equal(first.repaired,1);
  const row=await db.prepare('SELECT fill_side, fill_symbol FROM trades WHERE id=1').get() as Record<string,unknown>;
  assert.deepEqual({...row},{fill_side:'buy',fill_symbol:null});
  const second=await repairHistoricalFills(db,'unused',client as never);
  assert.equal(second.repaired,0,"the row is still a candidate, but nothing about it changed");
 }finally{raw.close();}
});
