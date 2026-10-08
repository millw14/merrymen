import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { SETTINGS_DEFAULTS } from "@merrymen/core";
import PerpsControlDesk from "./PerpsControlDesk";
import { testDom, json, deferred } from "./test-dom";
const owner = "0x1111111111111111111111111111111111111111";
const props = {ownerKey:owner, session:{hosted:true,address:owner}, hasAgent:true, perps:undefined, styleRequest:null, onCreate(){},onFund(){},onPermission(){},onRefreshAccount(){}};
describe("perpetual control room",()=>{
  it("loads saved controls without writes and pauses only new entries",async()=>{
    const dom=testDom(), original=globalThis.fetch; const writes:unknown[]=[]; let enabled=true;
    globalThis.fetch=async(url,init)=>{
      if(init?.method==="PUT") {const body=JSON.parse(String(init.body));writes.push(body);enabled=body.perpsEnabled;return json({ok:true});}
      if(String(url)==="/api/settings")return json({owner,values:{perpsEnabled:enabled},defaults:SETTINGS_DEFAULTS});
      return json({});
    };
    try {
      await dom.render(createElement(PerpsControlDesk,props));assert.deepEqual(writes,[]);
      assert.match(dom.container.textContent??"",/No completed evaluation has been reported/);
      await dom.click("Pause new entries");assert.deepEqual(writes,[{perpsEnabled:false,owner}]);
      assert.match(dom.container.textContent??"",/Existing positions still need protective exits/);
      assert.match(dom.container.textContent??"",/New entries disabled/);
    }finally{globalThis.fetch=original;await dom.close();}
  });
  it("rejects settings belonging to another owner",async()=>{
    const dom=testDom(),original=globalThis.fetch;
    globalThis.fetch=async()=>json({owner:"0x2222222222222222222222222222222222222222",values:{perpsEnabled:true},defaults:SETTINGS_DEFAULTS});
    try{await dom.render(createElement(PerpsControlDesk,props));assert.match(dom.container.textContent??"",/does not match this account/);assert.equal(dom.container.querySelector(".perps-control-form"),null);assert.doesNotMatch(dom.container.textContent??"",/Pause new entries/);}finally{globalThis.fetch=original;await dom.close();}
  });
  it("drops the prior owner's controls before a delayed next-owner read resolves", async()=>{
    const dom=testDom(),original=globalThis.fetch; const pending=deferred<Response>();
    globalThis.fetch=async url=>String(url)==="/api/settings"?json({owner,values:{perpsEnabled:true},defaults:SETTINGS_DEFAULTS}):json({});
    try {
      await dom.render(createElement(PerpsControlDesk,props));assert.ok(dom.container.querySelector(".perps-control-form"));
      globalThis.fetch=async()=>pending.promise;
      await dom.render(createElement(PerpsControlDesk,{...props,ownerKey:"second",session:{hosted:true,address:"0x2222222222222222222222222222222222222222"}}));
      assert.equal(dom.container.querySelector(".perps-control-form"),null);
      assert.doesNotMatch(dom.container.textContent??"",/Pause new entries/);
      pending.resolve(json({owner,values:{perpsEnabled:true},defaults:SETTINGS_DEFAULTS}));
    }finally{globalThis.fetch=original;await dom.close();}
  });

});
