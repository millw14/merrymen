import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import { PerpsFeed, type PerpsFeedProps } from "./PerpsFeed";
import { deferred, json, testDom } from "./test-dom";
import type { PerpsActivityResponse } from "../lib/perps-activity";

const props: PerpsFeedProps = {theses:[],tokens:[],agents:[],read:"ok",mineSlug:null,ownerKey:"owner-a",hasAgent:true,currentBook:"live",onToken(){},onDesk(){},onAccount(){}};
function journal(book: "paper" | "live"): PerpsActivityResponse {
  return {state:"ok",market:"all",book,generatedAtMs:2000,unknownRows:0,truncated:false,items:[
    {id:"btc",kind:"fill",market:"BTC-PERP",book,timeMs:1500,side:"long",effect:"open",priceExact:"60000.012345",sizeExact:"0.001",realizedMicro:"0",feeMicro:"1",attribution:"agent",tradeType:"perp-open"},
    {id:"eth",kind:"funding",market:"ETH-PERP",book,timeMs:1000,paymentMicro:"1000002"},
  ]};
}
it("loads all-market private activity only on demand and labels real markets and separate books",async()=>{
  const dom=testDom(),original=globalThis.fetch,requests:string[]=[];
  globalThis.fetch=async(url,init)=>{if(!String(url).startsWith("/api/perps/")) return String(url)==="/api/likes"?json({liked:[],signedIn:false}):json({counts:{},read:true});requests.push(String(url));assert.ok(!init?.method || init.method==="GET");assert.equal(init?.cache,"no-store");const book=new URL(String(url),"https://example.test").searchParams.get("book");return json(journal(book==="paper"?"paper":"live"));};
  try {
    await dom.render(createElement(PerpsFeed,props));assert.deepEqual(requests,[]);
    await dom.click("My activity");
    assert.deepEqual(requests,["/api/perps/activity?market=all&book=live&purpose=perps"]);
    assert.match(dom.container.textContent??"",/BTC-PERP · OPEN/);assert.match(dom.container.textContent??"",/ETH-PERP · FUNDING/);
    assert.match(dom.container.textContent??"",/real-money executions/);
    await dom.click("Paper");
    assert.equal(requests.at(-1),"/api/perps/activity?market=all&book=paper&purpose=perps");
    assert.match(dom.container.textContent??"",/simulations; no real money moves/);
    assert.equal(dom.container.querySelectorAll(".perps-activity-list>li").length,2);
  } finally {globalThis.fetch=original;await dom.close();}
});
it("drops private history and rejects late responses when the owner leaves",async()=>{
  const dom=testDom(),original=globalThis.fetch,pending=deferred<Response>();let calls=0,accountOpened=false;
  globalThis.fetch=async()=>{calls++;return pending.promise;};
  try {
    await dom.render(createElement(PerpsFeed,props));await dom.click("My activity");
    await dom.render(createElement(PerpsFeed,{...props,ownerKey:null,hasAgent:false,onAccount(){accountOpened=true;}}));
    await act(async()=>pending.resolve(json(journal("live"))));
    assert.equal(dom.container.querySelector(".perps-activity-list"),null);
    await dom.click("My activity");assert.equal(calls,1);assert.match(dom.container.textContent??"",/Sign in with your Merrymen account/);
    await dom.click("Open account");assert.equal(accountOpened,true);
  } finally {globalThis.fetch=original;await dom.close();}
});
