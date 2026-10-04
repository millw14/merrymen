/** Value durable, idle practice books without starting a trading worker. */
import { createHash } from "node:crypto";
import { CHAINLINK_ABI, STOCK_ABI, STOCK_TOKENS, type StockToken } from "../../packages/core/src/index";
import type { Db } from "./db";
import { paperCheckpointRejection } from "./paper-checkpoint";
import { positionValueUsdg } from "./positions";
import { mainnetClient } from "./snapshot";

/** The original book and all valuation inputs commit with their equity row. */
export const PAPER_IDLE_VALUATION_SCHEMA = `CREATE TABLE IF NOT EXISTS paper_valuation_proofs (
  equity_id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, epoch INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL, checkpoint_hash TEXT NOT NULL,
  paper_operations INTEGER NOT NULL, last_paper_operation_id INTEGER NOT NULL,
  block_number TEXT NOT NULL, block_at INTEGER NOT NULL, marks_json TEXT NOT NULL,
  measured_at INTEGER NOT NULL
);`;

type Checkpoint = {agent_id:string;epoch:number;cash_usdg:number;vault_usdg:number;hwm_usdg:number;shares:string;basis_json:string;updated_at:number};
type Frontier = {n:number;last_id:number;last_at:number|null};
type Agent = {smart_account:string;epoch:number;mode:string;beat_at:number|null;created_at:number};
type Mark = {id:number;at:number;mode:string|null;flows_held:number|null};
export interface PaperQuote {
  symbol:string; token:string; price8:bigint; multiplier:bigint; updatedAt:number;
}
export interface PaperQuoteRead {
  blockNumber:bigint; blockAt:number; quotes:readonly PaperQuote[];
}
export interface IdlePaperOptions {
  now:number;
  /** Includes workers being spawned or handed back from a hold. No default. */
  isRunning:(normalizedAccount:string)=>boolean;
  /** Acquire the existing tenant's advisory TRANSACTION lease on this tx's
   * connection. It must exclude remote workers until COMMIT; no default. */
  lockIdleAccount:(tx:Db,normalizedAccount:string)=>Promise<boolean>;
  limit?:number;
  minimumIdleSec?:number;
  minimumRefreshSec?:number;
  afterAccount?:string;
  /** Test seam; production uses the canonical mainnet contracts at one block. */
  readQuotes?:(tokens:readonly StockToken[])=>Promise<PaperQuoteRead>;
}
export interface IdlePaperResult { checked:number;written:number;skipped:number;nextAccount:string|null;reasons:Record<string,number> }

const canonicalAgentSql = `SELECT smart_account,COALESCE(epoch,1) AS epoch,mode,beat_at,created_at FROM agents
  WHERE LOWER(smart_account)=? ORDER BY COALESCE(epoch,1) DESC,COALESCE(beat_at,0) DESC,created_at DESC,smart_account LIMIT 1`;
const newestMarkSql = `SELECT id,at,mode,flows_held FROM equity WHERE LOWER(agent_id)=? AND epoch=? ORDER BY at DESC,id DESC LIMIT 1`;
const frontierSql = `SELECT COUNT(*) AS n,COALESCE(MAX(id),0) AS last_id,MAX(created_at) AS last_at
  FROM trades WHERE LOWER(agent_id)=? AND epoch=? AND status='paper'`;

const number = (n:unknown):number|null => n === null || n === undefined || n === "" || !Number.isFinite(Number(n)) ? null : Number(n);
function micro(n:unknown):bigint|null {
  const value=number(n);
  if(value===null || value<0) return null;
  const units=value*1e6,whole=Math.round(units);
  return Number.isSafeInteger(whole) && Math.abs(units-whole)<=0.0001 ? BigInt(whole) : null;
}
function checkpointJson(p:Checkpoint):string {
  return JSON.stringify({agent_id:p.agent_id,epoch:Number(p.epoch),cash_usdg:Number(p.cash_usdg),vault_usdg:Number(p.vault_usdg),
    hwm_usdg:Number(p.hwm_usdg),shares:p.shares,basis_json:p.basis_json,updated_at:Number(p.updated_at)});
}
function idle(agent:Agent|undefined,epoch:number,o:IdlePaperOptions):boolean {
  return !!agent && agent.mode==='paper' && Number(agent.epoch)===epoch && number(agent.beat_at)!==null
    && Number(agent.beat_at)<=o.now-(o.minimumIdleSec??900);
}
function sameFrontier(a:Frontier,b:Frontier):boolean {
  return Number(a.n)===Number(b.n) && Number(a.last_id)===Number(b.last_id) && number(a.last_at)===number(b.last_at);
}
async function unblocked(db:Db,account:string):Promise<boolean> {
  const rows=await db.prepare("SELECT agent_id,blocked FROM paper_recovery_health WHERE LOWER(agent_id)=?").all(account) as {agent_id:string;blocked:number}[];
  // The writer uses the lowercase identity. Ambiguous or unread legacy health
  // cannot authorize a new valuation, even when old measured history exists.
  return rows.length===1 && rows[0]!.agent_id===account && Number(rows[0]!.blocked)===0;
}

/** Chainlink and ERC-8056 inputs are pinned to the same canonical chain block. */
export async function readIdlePaperQuotes(tokens:readonly StockToken[]):Promise<PaperQuoteRead> {
  const client=mainnetClient();
  const block=await client.getBlock({blockTag:'latest'});
  if(block.number===null) throw new Error('paper quote block unavailable');
  if(tokens.length===0) return {blockNumber:block.number,blockAt:Number(block.timestamp),quotes:[]};
  const contracts=tokens.flatMap(t=>[
    {address:t.chainlinkFeed!,abi:CHAINLINK_ABI,functionName:'latestRoundData'},
    {address:t.address,abi:STOCK_ABI,functionName:'uiMultiplier'},
  ]);
  type Result={status:'success';result:unknown}|{status:'failure'};
  const results=await client.multicall({contracts:contracts as never,blockNumber:block.number}) as Result[];
  const quotes=tokens.map((t,i)=>{
    const feed=results[i*2],mul=results[i*2+1];
    if(feed?.status!=='success' || mul?.status!=='success') throw new Error('paper quote unavailable');
    const [round,answer,,updated,answered]=feed.result as readonly bigint[];
    if(typeof answer!=='bigint'||answer<=0n||typeof updated!=='bigint'||updated<=0n||updated>block.timestamp
      ||typeof round!=='bigint'||typeof answered!=='bigint'||answered<round||typeof mul.result!=='bigint'||mul.result<=0n) throw new Error('paper quote invalid');
    return {symbol:t.symbol,token:t.address,price8:answer,multiplier:mul.result,updatedAt:Number(updated)};
  });
  return {blockNumber:block.number,blockAt:Number(block.timestamp),quotes};
}

const schemas=new WeakMap<object,Promise<void>>();
async function ensureProofSchema(db:Db):Promise<void> {
  let ready=schemas.get(db);
  if(!ready){
    ready=(async()=>{
      for(let attempt=0;;attempt++) try { await db.exec(PAPER_IDLE_VALUATION_SCHEMA);return; }
      catch(error){
        const code=(error as {code?:unknown}).code;
        if(attempt>=2 || !['23505','42P07','42710'].includes(String(code))) throw error;
      }
    })();
    schemas.set(db,ready);
    ready.catch(()=>schemas.delete(db));
  }
  await ready;
}

/** Bounded, resumable pass. No key, grant, policy, fee or high-water mark writes. */
export async function refreshIdlePaperValuations(db:Db,o:IdlePaperOptions):Promise<IdlePaperResult> {
  if(!Number.isSafeInteger(o.now)||o.now<=0) throw new Error('invalid paper measurement time');
  const result:IdlePaperResult={checked:0,written:0,skipped:0,nextAccount:null,reasons:{}};
  const skip=(why:string)=>{result.skipped++;result.reasons[why]=(result.reasons[why]??0)+1;};
  await ensureProofSchema(db);
  const candidates=await db.prepare(`WITH canonical AS (
    SELECT smart_account,COALESCE(epoch,1) AS epoch,mode,beat_at,
      ROW_NUMBER() OVER(PARTITION BY LOWER(smart_account) ORDER BY COALESCE(epoch,1) DESC,COALESCE(beat_at,0) DESC,created_at DESC,smart_account) AS copy
    FROM agents
  ) SELECT DISTINCT LOWER(a.smart_account) AS account FROM canonical a JOIN paper_checkpoints p
      ON LOWER(p.agent_id)=LOWER(a.smart_account) AND p.epoch=a.epoch
    WHERE a.copy=1 AND a.mode='paper' AND a.beat_at<=? AND LOWER(a.smart_account)>?
    ORDER BY account LIMIT ?`).all(o.now-(o.minimumIdleSec??900),(o.afterAccount??'').toLowerCase(),Math.min(50,Math.max(1,o.limit??8))) as {account:string}[];
  for(const candidate of candidates){
    const account=candidate.account;result.checked++;result.nextAccount=account;
    try{
      if(o.isRunning(account)){skip('worker-running');continue;}
      const agent=await db.prepare(canonicalAgentSql).get(account) as Agent|undefined;
      const epoch=Number(agent?.epoch);
      if(!idle(agent,epoch,o)||!await unblocked(db,account)){skip('not-idle-or-held');continue;}
      const checkpoints=await db.prepare(`SELECT agent_id,epoch,cash_usdg,vault_usdg,hwm_usdg,shares,basis_json,updated_at
        FROM paper_checkpoints WHERE LOWER(agent_id)=? AND epoch=?`).all(account,epoch) as Checkpoint[];
      if(checkpoints.length!==1){skip('ambiguous-checkpoint');continue;}
      const checkpoint=checkpoints[0]!;
      if(!Number.isSafeInteger(Number(checkpoint.updated_at))||Number(checkpoint.updated_at)>o.now){skip('invalid-checkpoint-time');continue;}
      const mark=await db.prepare(newestMarkSql).get(account,epoch) as Mark|undefined;
      if(!mark||mark.mode!=='paper'||Number(mark.flows_held??0)!==0){skip('valuation-held-or-wrong-book');continue;}
      if(o.now-Number(mark.at)<(o.minimumRefreshSec??300)){skip('valuation-current');continue;}
      const frontier=await db.prepare(frontierSql).get(account,epoch) as Frontier;
      if(!Number.isSafeInteger(Number(frontier.n))||!Number.isSafeInteger(Number(frontier.last_id))
        ||(number(frontier.last_at)!==null&&Number(frontier.last_at)>Number(checkpoint.updated_at))){skip('checkpoint-predates-trades');continue;}
      const shares=JSON.parse(checkpoint.shares) as Record<string,{token:string;shares:number}>;
      if(!shares||Array.isArray(shares)||typeof shares!=='object'){skip('invalid-checkpoint');continue;}
      const held=Object.entries(shares);
      const tokens:StockToken[]=[];
      for(const [symbol,p] of held){
        const token=STOCK_TOKENS.find(t=>t.symbol===symbol&&t.address.toLowerCase()===p.token?.toLowerCase());
        if(!token||token.kind==='memecoin'||token.chainlinkFeed===null||!Number.isFinite(p.shares)||p.shares<=0) throw new Error('unsupported-paper-holding');
        tokens.push(token);
      }
      const cash=micro(checkpoint.cash_usdg),vault=micro(checkpoint.vault_usdg);
      if(cash===null||vault===null) {skip('invalid-checkpoint');continue;}
      const quotes=await (o.readQuotes??readIdlePaperQuotes)(tokens);
      if(typeof quotes.blockNumber!=='bigint'||quotes.blockNumber<0n||!Number.isSafeInteger(quotes.blockAt)
        ||quotes.blockAt<=0||quotes.blockAt>o.now+30||o.now-quotes.blockAt>120) {skip('invalid-quote-block');continue;}
      const bySymbol=new Map(quotes.quotes.map(q=>[q.symbol,q]));
      if(bySymbol.size!==held.length||quotes.quotes.length!==held.length) {skip('incomplete-quotes');continue;}
      const multiplier=(symbol:string)=>Number(bySymbol.get(symbol)?.multiplier??0n)/1e18;
      if(paperCheckpointRejection(checkpoint,multiplier)) {skip('invalid-checkpoint');continue;}
      let positions=0n;
      const marks=held.map(([symbol,p])=>{
        const q=bySymbol.get(symbol);
        if(!q||q.token.toLowerCase()!==p.token.toLowerCase()||typeof q.price8!=='bigint'||q.price8<=0n
          ||typeof q.multiplier!=='bigint'||q.multiplier<=0n||!Number.isSafeInteger(q.updatedAt)||q.updatedAt<=0||q.updatedAt>quotes.blockAt) throw new Error('invalid-paper-quote');
        // The same split-invariant raw quantity as the paper worker's tick.
        const raw=Math.round(p.shares*1e18);
        if(!Number.isFinite(raw)||raw<=0) throw new Error('invalid-paper-quantity');
        const rawBalance=BigInt(raw);
        const value=positionValueUsdg({rawBalance,uiMultiplier:q.multiplier,price8:q.price8,decimals:18});
        positions+=value;
        return {symbol,token:p.token,rawBalance:String(rawBalance),multiplier:String(q.multiplier),price8:String(q.price8),
          source:'chainlink',feedUpdatedAt:q.updatedAt,stale:o.now-q.updatedAt>7200,valueUsdgMicros:String(value)};
      });
      const total=cash+vault+positions;
      if(total>BigInt(Number.MAX_SAFE_INTEGER)) {skip('valuation-overflow');continue;}
      if(o.isRunning(account)){skip('worker-started');continue;}
      const snapshot=checkpointJson(checkpoint);
      const written=await db.tx(async tx=>{
        if(!await o.lockIdleAccount(tx,account)||o.isRunning(account)) return false;
        // Same lock order as an epoch transition: agent, then source snapshot.
        await tx.prepare('UPDATE agents SET epoch=epoch WHERE LOWER(smart_account)=?').run(account);
        const currentAgent=await tx.prepare(canonicalAgentSql).get(account) as Agent|undefined;
        if(!idle(currentAgent,epoch,o)||currentAgent?.smart_account!==agent?.smart_account||o.isRunning(account)) return false;
        const source=await tx.prepare(`UPDATE paper_checkpoints SET updated_at=updated_at WHERE agent_id=? AND epoch=?
          RETURNING agent_id,epoch,cash_usdg,vault_usdg,hwm_usdg,shares,basis_json,updated_at`).get(checkpoint.agent_id,epoch) as Checkpoint|undefined;
        if(!source||checkpointJson(source)!==snapshot) return false;
        const allSources=await tx.prepare('SELECT agent_id FROM paper_checkpoints WHERE LOWER(agent_id)=? AND epoch=?').all(account,epoch);
        if(allSources.length!==1) return false;
        const health=await tx.prepare('UPDATE paper_recovery_health SET updated_at=updated_at WHERE agent_id=? AND blocked=0 RETURNING agent_id').get(account);
        if(!health||!await unblocked(tx,account)) return false;
        const latest=await tx.prepare(newestMarkSql).get(account,epoch) as Mark|undefined;
        const currentFrontier=await tx.prepare(frontierSql).get(account,epoch) as Frontier;
        if(!latest||Number(latest.id)!==Number(mark.id)||latest.mode!=='paper'||Number(latest.flows_held??0)!==0
          ||!sameFrontier(frontier,currentFrontier)||o.isRunning(account)) return false;
        const inserted=await tx.prepare(`INSERT INTO equity
          (agent_id,eth_wei,cash_usdg,vault_usdg,positions_usdg,equity_usdg,epoch,mode,flows_held,cash_read_at,at)
          VALUES(?,'0',?,?,?,?,?,'paper',0,?,?) RETURNING id`).get(agent!.smart_account,Number(cash)/1e6,Number(vault)/1e6,
            Number(positions)/1e6,Number(total)/1e6,epoch,Number(checkpoint.updated_at),o.now) as {id:number};
        await tx.prepare(`INSERT INTO paper_valuation_proofs
          (equity_id,agent_id,epoch,checkpoint_json,checkpoint_hash,paper_operations,last_paper_operation_id,block_number,block_at,marks_json,measured_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(inserted.id,agent!.smart_account,epoch,snapshot,createHash('sha256').update(snapshot).digest('hex'),
            Number(frontier.n),Number(frontier.last_id),String(quotes.blockNumber),quotes.blockAt,JSON.stringify(marks),o.now);
        return true;
      });
      if(written) result.written++; else skip('book-changed');
    }catch(error){
      const message=(error as {message?:unknown}).message;
      skip(message==='unsupported-paper-holding'?'unsupported-paper-holding':'measurement-unavailable');
    }
  }
  return result;
}
