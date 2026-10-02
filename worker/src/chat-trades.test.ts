import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CASH, STOCK_TOKENS } from "../../packages/core/src/index";
import { currentTradeEpochSync, readOnlyFactsDb, readTradeFacts } from "./chat-trades";
import { readDeskTrades } from "../../web/src/lib/desk-trades";
const OWNER="0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",OTHER="0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",COIN="0xcccccccccccccccccccccccccccccccccccccccc";
const NOW=Date.parse("2026-10-01T23:00:00Z")/1000,DAY=Date.parse("2026-10-01T00:00:00Z")/1000;
function db() {
  const d=new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE trades(id INTEGER PRIMARY KEY,agent_id TEXT,epoch INTEGER,kind TEXT,target TEXT,sell_token TEXT,buy_token TEXT,amount_usdg REAL,status TEXT,user_op_hash TEXT,tx_hash TEXT,reject_rule TEXT,sim_quote_out TEXT,sim_min_out TEXT,sim_fee_tier INTEGER,sim_gas TEXT,created_at INTEGER,decision_id TEXT,fill_side TEXT,fill_symbol TEXT,fill_cash_usdg REAL,fill_qty_raw TEXT,basis_source TEXT,realized_pnl_usdg REAL);
    CREATE TABLE decisions(id TEXT PRIMARY KEY,agent_id TEXT,at INTEGER,symbol TEXT,display_name TEXT,action TEXT,reason TEXT,source TEXT);
    CREATE TABLE agents(smart_account TEXT PRIMARY KEY,epoch INTEGER);`);
  d.prepare("INSERT INTO agents VALUES (?,2)").run(OWNER);
  d.prepare("INSERT INTO decisions VALUES ('buy',?,?,'PRISM','Prism','buy','the recorded entry reason','brain')").run(OWNER,DAY+1);
  d.prepare("INSERT INTO decisions VALUES ('sell',?,?,'PRISM','Prism','sell','took a measured gain','brain')").run(OWNER,DAY+2);
  d.prepare("INSERT INTO decisions VALUES ('other',?,?,'SECRET','Secret','buy','OTHER_SECRET','brain')").run(OTHER,DAY+3);
  const add=(id:number,epoch:number,side:string,at:number,hash:string,status:string,cash:number,qty:string,source:string,pnl:number|null,decision:string|null,who=OWNER)=>d.prepare(`INSERT INTO trades(id,agent_id,epoch,kind,target,sell_token,buy_token,amount_usdg,status,user_op_hash,created_at,decision_id,fill_side,fill_symbol,fill_cash_usdg,fill_qty_raw,basis_source,realized_pnl_usdg)
     VALUES (?, ?, ?, 'swap','router',?, ?,999,?,?,?, ?,?,'PRISM',?,?,?,?)`).run(id,who,epoch,side==="buy"?CASH.USDG:COIN,side==="buy"?COIN:CASH.USDG,status,hash,at,decision,side,cash,qty,source,pnl);
  return {d,add};
}
test("chat facts match the web's canonical IDs, execution provenance, reason and current run",async()=> {
  const {d,add}=db();
  add(1,1,"buy",DAY+1,"0xold","landed",77,"100","receipt",null,"buy");
  add(2,2,"buy",DAY+1,"0xentry","landed",5,"100","receipt",null,"buy");
  add(3,2,"sell",DAY+2,"0xexit","landed",6,"100","receipt",1,"sell");
  // Re-recorded bare copy from a restart: not a second sale or its reason.
  d.prepare("INSERT INTO trades(id,agent_id,epoch,kind,target,status,user_op_hash,amount_usdg,created_at) VALUES (4,?,2,'swap',?,'landed','0xexit',888,?)").run(OWNER,OWNER,DAY+9);
  add(5,2,"buy",DAY+3,"0xforeignjoin","landed",2,"100","receipt",null,"other");
  add(6,2,"buy",DAY+4,"0xother","landed",88,"100","receipt",null,"other",OTHER);
  const raw=readOnlyFactsDb(d),chat=await readTradeFacts(raw,{account:OWNER,epoch:2,since:DAY,until:NOW});
  const web=await readDeskTrades(raw,OWNER,2,DAY-1);
  assert.deepEqual(chat.trades.map(t=>t.id),web.map(t=>t.id));
  assert.deepEqual(chat.trades.map(t=>t.id),[5,3,2]);
  assert.equal(chat.trades.find(t=>t.id===3)?.reason,"took a measured gain");
  assert.equal(chat.trades.find(t=>t.id===3)?.executedUsdg,6);
  assert.equal(chat.trades.find(t=>t.id===3)?.realizedPnlUsdg,1);
  assert.equal(chat.trades.find(t=>t.id===3)?.realizedPnlBps,2000);
  assert.equal(web.find(t=>t.id===3)?.realized_vouched,true);
  assert.equal(chat.trades.find(t=>t.id===5)?.reason,null,"a foreign tenant's decision link must not supply a reason");
  assert.doesNotMatch(JSON.stringify(chat),/OTHER_SECRET|888/);
  d.close();
});
test("a copy of yesterday is not today; quote-built basis and proposed cash are never verified results",async()=> {
  const {d,add}=db();
  add(1,2,"buy",DAY-20,"0xyesterday","landed",5,"100","quote",null,"buy");
  d.prepare("INSERT INTO trades(id,agent_id,epoch,kind,target,status,user_op_hash,amount_usdg,created_at) VALUES (2,?,2,'swap',?,'landed','0xyesterday',888,?)").run(OWNER,OWNER,DAY+1);
  add(3,2,"sell",DAY+2,"0xexit","landed",6,"100","receipt",1,"sell");
  add(4,2,"buy",DAY+3,"0xquoted","landed",22,"100","quote",null,"buy");
  add(5,2,"buy",DAY+4,"0xpending","submitted",100,"100","receipt",null,"buy");
  const facts=await readTradeFacts(readOnlyFactsDb(d),{account:OWNER,epoch:2,since:DAY,until:NOW});
  assert.deepEqual(facts.trades.map(t=>t.id),[4,3]);
  assert.equal(facts.trades[0]?.executedUsdg,null);
  assert.equal(facts.trades[1]?.realizedPnlUsdg,null);
  const all=await readTradeFacts(readOnlyFactsDb(d),{account:OWNER,epoch:2,since:DAY,until:NOW,filter:"all",limit:1});
  assert.equal(all.complete,false);assert.equal(all.trades[0]?.executedUsdg,null,"pending is not measured execution");
  d.close();
});
test("read-only facts adapter never arms writes",async()=> {
  const {d}=db(); const ro=readOnlyFactsDb(d);
  await assert.rejects(()=>ro.prepare("DELETE FROM trades").run(),/read-only/);
  await assert.rejects(()=>ro.exec("DROP TABLE trades"),/read-only/);
  d.close();
});

test("mixed-case account history cannot hide an estimated buy beneath a measured sale",async()=> {
  const {d,add}=db();
  add(1,2,"buy",DAY+1,"0xentry","landed",5,"100","quote",null,"buy",OWNER.toUpperCase());
  add(2,2,"sell",DAY+2,"0xexit","landed",6,"100","receipt",1,"sell");
  const facts=await readTradeFacts(readOnlyFactsDb(d),{account:OWNER,epoch:2,since:DAY,until:NOW});
  assert.equal(facts.trades[0]?.realizedPnlUsdg,null);assert.equal(facts.trades[0]?.realizedPnlBps,null);
  d.close();
});

test("stock-pair side inference also happens before a side-filtered limit",async()=> {
  const {d}=db(),stock=STOCK_TOKENS[0]!;
  d.prepare("INSERT INTO trades(id,agent_id,epoch,kind,target,sell_token,buy_token,amount_usdg,status,fill_cash_usdg,basis_source,created_at) VALUES (1,?,2,'swap','router',?,?,5,'landed',5,'receipt',?)").run(OWNER,CASH.USDG,stock.address,DAY+1);
  const facts=await readTradeFacts(readOnlyFactsDb(d),{account:OWNER,epoch:2,since:DAY,until:NOW,side:"buy"});
  assert.equal(facts.trades.length,1);assert.equal(facts.trades[0]?.side,"buy");assert.equal(facts.trades[0]?.label,stock.symbol);
  d.close();
});
test("unreadable current run and unplaceable restart times cannot become a complete empty day",async()=> {
  const {d}=db();d.exec("DROP TABLE agents");assert.throws(()=>currentTradeEpochSync(d,OWNER));
  d.prepare("INSERT INTO trades(id,agent_id,epoch,kind,target,status,user_op_hash,amount_usdg,created_at) VALUES (1,?,2,'swap',?,'landed','0xorphan',777,?)").run(OWNER,OWNER,DAY+1);
  const facts=await readTradeFacts(readOnlyFactsDb(d),{account:OWNER,epoch:2,since:DAY,until:NOW});
  assert.equal(facts.complete,false);assert.deepEqual(facts.trades,[]);
  d.close();
});

test("retained epoch-one fills without modern agent metadata cannot be called the current run",()=> {
  const {d,add}=db();add(1,1,"buy",DAY+1,"0xold","landed",5,"100","receipt",null,"buy");
  d.prepare("DELETE FROM agents WHERE smart_account = ?").run(OWNER);
  assert.throws(()=>currentTradeEpochSync(d,OWNER),/current run unavailable/);
  d.close();
  const legacy=new DatabaseSync(":memory:");legacy.exec("CREATE TABLE trades(id INTEGER PRIMARY KEY,agent_id TEXT)");
  assert.equal(currentTradeEpochSync(legacy,OWNER),null,"a schema predating runs retains its explicit legacy exception");legacy.close();
});
