import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement, act } from "react";
import { PerpsCommunity, communityProfile } from "./PerpsCommunity";
import { testDom,json,deferred } from "./test-dom";

function profile(slug:string,name=slug) {return {slug,name,mode:"paper",handle:null,how:null,pnlBps:null,paperPnlBps:null,gas:null,publicBook:false,growth:[],holdings:[],theses:[],thesesRead:true,recentTrades:[],activityRead:true,topTrades:[],topTradesRead:true,tradeCount:0,landed:0,filledPaper:0,holdingsRead:true};}
const props={theses:[],tokens:[],agents:[],read:"ok" as const,mineSlug:null,ownerKey:"owner-a",onToken(){},onDesk(){}};
it("maps only public profile data and never mixes owner perpetual fields into a profile",()=>{
  const result=communityProfile({...profile("scout"),perps:[{market:"BTC-PERP",size:99}],holdings:[{symbol:"SECRET",valueUsdg:999999,shareBps:10000}],perpsAccount:{collateral:99999}},"scout");
  assert.ok(result);assert.equal(result.agent.holdingsUsd,null);assert.equal(result.agent.glance.legs,undefined);
  assert.ok(!("perps" in result.agent));assert.ok(!("perpsAccount" in result.agent));
  assert.equal(communityProfile(profile("other"),"scout"),null);
  assert.equal(communityProfile({...profile("scout"),growth:[null]},"scout"),null);
});
it("keeps profile navigation inside the fleet, rejects late reads, and resets across owners",async()=>{
  const dom=testDom(),original=globalThis.fetch;
  const globals=globalThis as {ResizeObserver?:unknown;self?:unknown};const previous={observer:globals.ResizeObserver,self:globals.self};
  globals.ResizeObserver=class{observe(){}disconnect(){}};globals.self=dom.dom.window;
  const pending=deferred<Response>();const requests:string[]=[];
  globalThis.fetch=async(url)=>{requests.push(String(url));return String(url)==="/api/agents/first"?pending.promise:json(profile("second","Second agent"));};
  try {
    await dom.render(createElement(PerpsCommunity,{...props,requestedProfile:{slug:"first",revision:1}}));
    await dom.render(createElement(PerpsCommunity,{...props,requestedProfile:{slug:"second",revision:2}}));
    assert.match(dom.container.textContent??"",/Second agent/);
    await act(async()=>pending.resolve(json(profile("first","Old agent"))));
    assert.doesNotMatch(dom.container.textContent??"",/Old agent/);
    assert.match(dom.container.textContent??"",/spot \/ on-chain activity/);
    assert.match(dom.container.textContent??"",/account equity, which can include perpetuals/);
    assert.ok(requests.every(url=>!url.startsWith("/api/perps/")));
    await dom.click("← Fleet feed");assert.equal(dom.container.querySelector(".perps-community-profile"),null);
    await act(async()=>{await new Promise(resolve=>dom.dom.window.requestAnimationFrame(resolve));});
    assert.equal(dom.dom.window.document.activeElement,dom.container.querySelector(".perps-community-heading h2"));
    await dom.render(createElement(PerpsCommunity,{...props,ownerKey:"owner-b"}));
    assert.equal(dom.container.querySelector(".perps-community-profile"),null);
  }finally{globalThis.fetch=original;await dom.close();globals.ResizeObserver=previous.observer;globals.self=previous.self;}
});
