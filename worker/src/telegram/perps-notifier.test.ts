import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,rmSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {startPerpsNotifier} from "./perps-notifier";
import {formatPerps,perpsAttention,type TelegramPerpsSnapshot,type TelegramPerpsPort} from "./perps";
import type {StateRef,TelegramState} from "./state";
const NOW=1_800_000_000;
const ready:TelegramPerpsSnapshot={state:"ready",account:"0x1111111111111111111111111111111111111111",grantExpiresAt:NOW+1000,report:{v:1,mode:"paper",blocker:null,venueReadAt:NOW*1000,protectAt:NOW*1000,accountIndex:null,positions:[],openNotionalMicro:"0",collateralMicro:"1000000000",inTransitMicro:"0",minLiqDistanceBps:null,stopsMissing:0,incident:false}};
const settle=async()=>{for(let i=0;i<15;i++)await new Promise(resolve=>setImmediate(resolve));};

test("paper attention uses actual expiry, stop and read evidence without inventing live incidents",()=>{
 assert.deepEqual(perpsAttention({state:"absent"},NOW),[]);
 assert.match(perpsAttention({state:"unread"},NOW).join(" "),/unknown, not zero/);
 assert.match(perpsAttention(ready,NOW).join(" "),/expires within 24 hours/);
 assert.match(formatPerps({...ready,report:null},NOW),/unknown, not zero/);
 const changed={...ready,grantExpiresAt:NOW-1,report:{...ready.report!,venueReadAt:(NOW-200)*1000,stopsMissing:2,entriesHalted:true,incident:true}};
 const words=perpsAttention(changed,NOW).join(" ");assert.match(words,/expired/);assert.match(words,/protective stop/);assert.match(words,/old or unverified/);assert.match(words,/Close all/);assert.doesNotMatch(words,/incident|real.money|funding rate/i);
});

test("claims durably before owner DM, suppresses restart replay, and rejects save/recipient races",async()=>{
 const home=mkdtempSync(join(tmpdir(),"perps-notice-"));const realFetch=globalThis.fetch;
 let owner=42, reads=0,sends=0;
 const cfg={telegramEnabled:true,telegramNotifyEnabled:true,telegramBotToken:"111:secret"};
 const stateRef:StateRef={get:()=>({ownerId:owner} as TelegramState),set:()=>{throw Error("not used");}};
 const port:TelegramPerpsPort={read:async()=>{reads++;return ready;},exit:async()=>"never"};
 const notices:Array<{stop():void}>=[];
 const start=()=>{const n=startPerpsNotifier({home,getCfg:()=>cfg,stateRef,perps:port,now:()=>NOW});notices.push(n);return n;};
 globalThis.fetch=(async(_url,init)=>{
   assert.ok(JSON.parse(readFileSync(join(home,"telegram-perps-notices.json"),"utf8")).key,"claimed before network send");
   const body=JSON.parse(String(init?.body));assert.equal(body.chat_id,owner);assert.match(body.text,/paper practice/);sends++;
   return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:1}})} as Response;
 }) as typeof fetch;
 try {
   const first=start();await settle();first.stop();assert.equal(sends,1);
   const second=start();await settle();second.stop();assert.equal(sends,1,"same claim survives process restart");
   rmSync(join(home,"telegram-perps-notices.json"));mkdirSync(join(home,"telegram-perps-notices.json"));
   const bad=start();await settle();bad.stop();assert.equal(sends,1,"unreadable claim file fails closed");
   rmSync(join(home,"telegram-perps-notices.json"),{recursive:true});
   let finish!:(s:TelegramPerpsSnapshot)=>void;port.read=()=>new Promise(resolve=>{finish=resolve;});
   const raced=start();owner=43;finish(ready);await settle();raced.stop();assert.equal(sends,1,"old owner's awaited read cannot notify a new owner");
   assert.ok(reads>=3);
 } finally {notices.forEach(n=>n.stop());globalThis.fetch=realFetch;rmSync(home,{recursive:true,force:true});}
});
