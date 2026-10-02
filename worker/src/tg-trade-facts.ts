/** Public projection of an owner's current-run executed trades. No private money or free-form reasons. */
import type { TgPublicTradesToday } from "./telegram/tg-groups/types";
import { chatPeriodStart } from "../../packages/core/src/index";
import { currentTradeEpochSync, readOnlyFactsDb, readTradeFacts } from "./chat-trades";
import { openRO } from "./telegram/reads";
import { overlayHistory } from "./telegram/history-overlay";

export async function readPublicTradesToday(agentId:string|null,nowSec:number):Promise<TgPublicTradesToday|null> {
  if(!agentId)return null;
  const db=openRO();if(!db)return null;
  try {
    overlayHistory(db,agentId);
    const facts=await readTradeFacts(readOnlyFactsDb(db),{account:agentId,epoch:currentTradeEpochSync(db,agentId),since:chatPeriodStart("today",nowSec).since,until:nowSec,filter:"filled",limit:30});
    return {day:new Date(nowSec*1000).toISOString().slice(0,10),complete:facts.complete && facts.trades.every(t=>t.side!==null&&t.label!=="an unnamed coin"),trades:facts.trades
      .filter(t=>t.side!==null&&t.kind!=="energy-buy"&&t.label!=="an unnamed coin")
      .map(t=>({symbol:t.label,side:t.side!,paper:t.paper,...(t.decisionId?{decisionId:t.decisionId}:{}),
        ...(t.source?.startsWith("brain")?{why:"brain"}:t.source?.startsWith("strategy:")?{why:"strategy"}:t.source==="telegram"||t.source==="manual"?{why:"manual"}:{})}))};
  } catch {return null;}
  finally {db.close();}
}
