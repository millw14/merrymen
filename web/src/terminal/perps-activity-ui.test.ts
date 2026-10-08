import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { PerpsActivity } from "./PerpsActivity";
import { testDom, json } from "./test-dom";
import { usdExact } from "../lib/format";
import type { PerpsActivityResponse } from "../lib/perps-activity";
it("shows recorded closes and funding exactly, then removes private records on auth loss",async()=>{
  const dom=testDom(),original=globalThis.fetch;let status=200;
  const payload:PerpsActivityResponse={state:"ok",market:"BTC-PERP",book:"paper",generatedAtMs:2000,unknownRows:0,truncated:false,items:[{id:"close",kind:"fill",market:"BTC-PERP",book:"paper",timeMs:1500,side:"long",effect:"close",priceExact:"123.123456789012345678",sizeExact:"0.00000001",realizedMicro:"-1000001",feeMicro:"1",attribution:"agent",tradeType:"perp-close"},{id:"funding",kind:"funding",market:"BTC-PERP",book:"paper",timeMs:1000,paymentMicro:"1000002"}]};
  globalThis.fetch=async()=>json(payload,status);
  try{await dom.render(createElement(PerpsActivity,{market:"BTC-PERP",book:"paper"}));assert.equal(dom.container.querySelectorAll(".perps-activity-list>li").length,2);assert.ok(dom.container.textContent?.includes(usdExact("123.123456789012345678")));assert.ok(dom.container.textContent?.includes(`−${usdExact("1.000001")}`));status=401;await dom.click("Refresh activity");assert.equal(dom.container.querySelectorAll(".perps-activity-list>li").length,0);assert.match(dom.container.textContent??"",/Sign in again/);}finally{globalThis.fetch=original;await dom.close();}
});
