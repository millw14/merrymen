import { createPublicClient, http, erc20Abi, type Hex } from "viem";
import { CASH, STOCK_TOKENS } from "../../packages/core/src/index";
import { netTokenDeltas } from "./fills";
import { pickAcquiredLeg } from "./inflight-reconcile";
import type { Db } from "./db";
import { recoverReceiptBasis } from "./receipt-basis-recovery";
import { fillSymbolFor } from "./token-label";
import type { ReconcileChain, RawLog } from "./inflight-reconcile";

/** Receipt-only repair. Never converts an intended notional or a price mark
 * into historical proceeds, and never overwrites existing accounting. */
export async function repairHistoricalFills(db:Db, rpcUrl:string, clientOverride?: ReturnType<typeof createPublicClient>):Promise<{repaired:number;unavailable:number;pnlRecovered:number;reasons:Record<string,number>}> {
  const client:ReturnType<typeof createPublicClient> = clientOverride ?? createPublicClient({transport:http(rpcUrl,{timeout:8000,retryCount:0})});
  const rows=await db.prepare(`SELECT t.id,t.agent_id,t.tx_hash FROM trades t JOIN agents a ON LOWER(a.smart_account)=LOWER(t.agent_id)
    WHERE t.status='landed' AND t.kind='swap' AND t.tx_hash IS NOT NULL AND a.chain_id=4663
    AND (t.fill_side IS NULL OR t.buy_token IS NULL OR t.sell_token IS NULL OR t.fill_cash_usdg IS NULL OR t.fill_symbol IS NULL)
    AND (SELECT COUNT(*) FROM trades sibling WHERE LOWER(sibling.agent_id)=LOWER(t.agent_id)
      AND sibling.tx_hash=t.tx_hash AND sibling.status='landed')=1
    ORDER BY CASE WHEN t.fill_side IS NULL THEN 0 ELSE 1 END, t.created_at DESC LIMIT 100`).all() as {id:number;agent_id:string;tx_hash:Hex}[];
  let repaired=0,unavailable=0;
  const reasons:Record<string,number>={};
  const unavailableBecause=(reason:string)=>{unavailable++;reasons[reason]=(reasons[reason]??0)+1;};
  const books=new Map<string,{account:string;token:Hex}>();
  for(const row of rows) {
    let stage='duplicate-check';
    try {
      // Recheck after candidate selection in case another row was mirrored.
      // Bundled transactions may have more than one operation for an account.
      // Refuse aggregated deltas if there is not exactly one accounting row.
      const count=await db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE LOWER(agent_id)=LOWER(?) AND tx_hash=? AND status='landed'`).get(row.agent_id,row.tx_hash) as {n:number};
      if(Number(count.n)!==1){unavailableBecause('multiple-execution-rows');continue;}
      stage='receipt-read';
      const receipt=await client.getTransactionReceipt({hash:row.tx_hash});
      if(receipt.status!=='success'){unavailableBecause('receipt-not-successful');continue;}
      const fill=pickAcquiredLeg(netTokenDeltas(receipt.logs,row.agent_id),CASH.USDG);
      if(!fill){unavailableBecause('no-unambiguous-account-swap');continue;}
      books.set(`${row.agent_id.toLowerCase()}:${fill.token}`,{account:row.agent_id,token:fill.token as Hex});
      const known=STOCK_TOKENS.find(t=>t.address.toLowerCase()===fill.token.toLowerCase());
      const symbol=known?.symbol ?? await client.readContract({address:fill.token as Hex,abi:erc20Abi,functionName:'symbol'}).catch(()=>null);
      // The same guard the child writes names through: a coin calling itself a stock's
      // or the cash token's ticker is stored nameless, never under that name.
      const safeSymbol=fillSymbolFor(fill.token,[typeof symbol==='string' ? symbol : null]);
      stage='fill-update';
      // Only a row this fills counts as repaired. A coin with no storable name
      // stays a candidate on every start; counted, it re-read every tenant's
      // history for the chat each deploy (orchestrator refreshHistoryForLiveChildren).
      const fills=`(fill_side IS NULL OR buy_token IS NULL OR sell_token IS NULL OR fill_qty_raw IS NULL OR fill_cash_usdg IS NULL${safeSymbol?' OR fill_symbol IS NULL':''})`;
      const res=await db.prepare(`UPDATE trades SET fill_side=COALESCE(fill_side,?),fill_symbol=COALESCE(fill_symbol,?),
        buy_token=COALESCE(buy_token,?),sell_token=COALESCE(sell_token,?),
        fill_qty_raw=COALESCE(fill_qty_raw,?),fill_cash_usdg=COALESCE(fill_cash_usdg,?),
        basis_source=CASE WHEN fill_qty_raw IS NULL AND fill_cash_usdg IS NULL THEN 'receipt' ELSE basis_source END
        WHERE id=? AND status='landed' AND tx_hash=? AND ${fills}`).run(fill.side,safeSymbol,
        fill.side==='buy'?fill.token:CASH.USDG,fill.side==='sell'?fill.token:CASH.USDG,
        String(fill.qtyRaw),Number(fill.cashUsdg)/1e6,row.id,row.tx_hash);
      if(res.changes>0) repaired++;
    }catch{unavailableBecause(stage+'-failed');}
  }
  const chain:ReconcileChain={
    getBlockNumber:()=>client.getBlockNumber(),
    getLogs:async a=>await client.request({method:'eth_getLogs',params:[{address:a.address,topics:a.topics,fromBlock:`0x${a.fromBlock.toString(16)}`,toBlock:`0x${a.toBlock.toString(16)}`}]} as never) as RawLog[],
    getReceiptLogs:async hash=>(await client.getTransactionReceipt({hash})).logs,
  };
  let pnlRecovered=0;
  for(const {account,token} of [...books.values()].slice(0,20)) {
    try {
      const heldRaw=await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[account as Hex]});
      const replay=await recoverReceiptBasis({chain,token,account,usdgToken:CASH.USDG,heldRaw,allowClosed:true,lookbackBlocks:2_000_000n,budgetMs:15_000});
      if(!replay)continue;
      for(const sale of replay.realized) {
        const matches=await db.prepare(`SELECT id,realized_pnl_usdg FROM trades WHERE LOWER(agent_id)=LOWER(?) AND LOWER(tx_hash)=LOWER(?) AND status='landed'`).all(account,sale.tx) as {id:number;realized_pnl_usdg:number|null}[];
        if(matches.length!==1 || matches[0]!.realized_pnl_usdg!==null)continue;
        await db.prepare(`UPDATE trades SET realized_pnl_usdg=?,basis_source='receipt' WHERE id=? AND realized_pnl_usdg IS NULL`).run(Number(sale.pnl)/1e6,matches[0]!.id);
        pnlRecovered++;
      }
    }catch{/* A partial chain history cannot establish P&L. */}
  }
  return {repaired,unavailable,pnlRecovered,reasons};
}
