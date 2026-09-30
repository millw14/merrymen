import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {createFleetPerpFeed,type FleetPerpFeedTargets} from './fleet-feed';
import type {LighterFeedOptions} from './feed';
function setup(){
 let halted=false,fail=false,stops=0,env:Record<string,string|undefined>={MERRYMEN_PERPS:'paper'};
 let targets:FleetPerpFeedTargets={settings:[{perpsEnabled:true,perpsMarkets:['BTC-PERP','ETH-PERP']}],heldMarketIds:[]};
 const starts:LighterFeedOptions[]=[];
 const feed=createFleetPerpFeed({home:'/tmp/offline-fleet',halted:()=>halted,env:()=>env,readTargets:async()=>{if(fail)throw new Error('DB unread');return targets;},api:()=>({}) as LighterFeedOptions['api'],start:options=>{starts.push(options);return {stop(){stops++;}};}});
 return {feed,starts,stops:()=>stops,setTargets:(x:FleetPerpFeedTargets)=>targets=x,setEnv:(x:Record<string,string|undefined>)=>env=x,halt:(x:boolean)=>halted=x,fail:(x:boolean)=>fail=x};
}
describe('orchestrator fleet perps publisher',()=>{
 it('starts one public feed for paper consumers and updates union/held subscriptions without another socket',async()=>{
  const t=setup();await Promise.all([t.feed.refresh(),t.feed.refresh()]);assert.equal(t.starts.length,1);assert.deepEqual(t.starts[0]!.marketIds(),[0,1]);assert.equal(t.starts[0]!.home,'/tmp/offline-fleet');assert.equal(t.starts[0]!.outPath,'/tmp/offline-fleet/lighter-feed.json');
  t.setTargets({settings:[{perpsEnabled:true,perpsMarkets:['SOL-PERP']}],heldMarketIds:[1,99999]});await t.feed.refresh();assert.equal(t.starts.length,1);assert.deepEqual(t.starts[0]!.marketIds(),[1,3]);assert.deepEqual(t.starts[0]!.heldMarketIds!(),[1]);t.feed.stop();assert.equal(t.stops(),1);
 });
 it('operator off suppresses new subscriptions but preserves held positions for protection and funding',async()=>{
  const t=setup();t.setEnv({MERRYMEN_PERPS:'off'});await t.feed.refresh();assert.equal(t.starts.length,0);
  t.setTargets({settings:[{perpsEnabled:false}],heldMarketIds:[1]});await t.feed.refresh();assert.deepEqual(t.starts[0]!.marketIds(),[1]);
  t.setTargets({settings:[],heldMarketIds:[]});await t.feed.refresh();assert.equal(t.feed.running,false);assert.equal(t.stops(),1);t.feed.stop();
 });
 it('fleet halt stops the publisher, resume starts once, and shutdown prevents every restart',async()=>{
  const t=setup();await t.feed.refresh();t.halt(true);await t.feed.refresh();assert.equal(t.stops(),1);assert.equal(t.feed.running,false);
  t.halt(false);await t.feed.refresh();assert.equal(t.starts.length,2);t.feed.stop();t.feed.stop();await t.feed.refresh();assert.equal(t.starts.length,2);assert.equal(t.stops(),2);
 });
 it('failed inventory retains known markets; shutdown during an awaited read cannot restart a socket',async()=>{
  const t=setup();await t.feed.refresh();t.fail(true);await t.feed.refresh();assert.equal(t.starts.length,1);assert.deepEqual(t.starts[0]!.marketIds(),[0,1]);t.feed.stop();
  let resolve!:(x:FleetPerpFeedTargets)=>void,starts=0;
  const f=createFleetPerpFeed({home:'/tmp/offline-fleet',halted:()=>false,readTargets:()=>new Promise(r=>{resolve=r;}),api:()=>({}) as LighterFeedOptions['api'],start:()=>{starts++;return{stop(){}};}});
  const running=f.refresh();await new Promise(r=>setImmediate(r));f.stop();resolve({settings:[{perpsEnabled:true}],heldMarketIds:[]});await running;assert.equal(starts,0);
 });
});
