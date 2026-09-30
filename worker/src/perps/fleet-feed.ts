/** One public market-data publisher per orchestrator; hosted children only read its file. */
import type { MerrymenSettings } from '../../../packages/core/src/index';
import { perpMarketById, perpMarketByKey } from '../../../packages/core/src/index';
import { mergeSettings } from '../settings';
import { createLighterApi } from './api';
import { lighterFeedPath } from './feed-reader';
import { startLighterFeed, type LighterFeedOptions } from './feed';

export interface FleetPerpFeedTargets { settings: readonly MerrymenSettings[]; heldMarketIds: readonly number[] }
export interface FleetPerpFeedOptions {
 home: string;
 halted: () => boolean;
 readTargets: () => Promise<FleetPerpFeedTargets>;
 env?: () => Record<string,string|undefined>;
 log?: (line:string) => void;
 /** Offline test seams; production uses the shared public client and feed. */
 start?: (options:LighterFeedOptions) => {stop():void};
 api?: () => LighterFeedOptions['api'];
}
export function createFleetPerpFeed(o:FleetPerpFeedOptions): {refresh():Promise<void>;stop():void;readonly running:boolean} {
 let handle:{stop():void}|null=null,closed=false,markets:number[]=[],held:number[]=[];
 let tail=Promise.resolve(),lastError:string|null=null;
 const stopHandle=()=>{const active=handle;handle=null;try{active?.stop();}catch{/* shutdown remains best effort */}};
 const refresh=async()=>{
  if(closed||o.halted()){stopHandle();return;}
  try {
   const targets=await o.readTargets();
   if(closed||o.halted()){stopHandle();return;}
   held=[...new Set(targets.heldMarketIds.filter(id=>perpMarketById(id)!==null))].sort((a,b)=>a-b);
   const wanted=new Set(held);
   for(const settings of targets.settings){
    const cfg=mergeSettings(settings,o.env?.()??process.env);
    if(!cfg.perpsEnabled||cfg.perpsOperatorCeiling==='off')continue;
    for(const key of cfg.perpsMarkets){const market=perpMarketByKey(key);if(market)wanted.add(market.marketId);}
   }
   markets=[...wanted].sort((a,b)=>a-b);
   if(!markets.length){stopHandle();return;}
   if(!handle){
    handle=(o.start??startLighterFeed)({home:o.home,outPath:lighterFeedPath(o.home),marketIds:()=>markets,heldMarketIds:()=>held,
     api:o.api?.()??createLighterApi({home:o.home,budgetKey:'public'}),logger:line=>o.log?.(`[perps feed] ${line}`)});
    o.log?.('[perps feed] fleet publisher started');
   }
   lastError=null;
  }catch(error){
   // A failed target read preserves the last known subscriptions. Their feed
   // timestamps remain authoritative; no synthetic freshness is introduced.
   const message=error instanceof Error?error.message:String(error);
   if(message!==lastError)o.log?.(`[perps feed] fleet publisher unavailable: ${message}`);
   lastError=message;
  }
 };
 return {
  refresh(){const run=tail.then(refresh);tail=run.catch(()=>{});return run;},
  stop(){closed=true;stopHandle();},
  get running(){return handle!==null;},
 };
}
