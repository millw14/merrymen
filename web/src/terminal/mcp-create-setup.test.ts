import assert from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_BASKET_SYMBOLS, RISK_PROFILES } from "@merrymen/core";
import { approvedMcpSetup, mcpSetupRequest, reviewMcpCreateSetup } from "./mcp-create-setup";
import { headline, walletSetupUrl, type View } from "../app/connect/approve/[id]/approve-view";

const id=`prp_${"a".repeat(32)}`;
const owner=`0x${"b".repeat(40)}`;
const now=1_800_000_000_000;
function view():View {
  return {id,kind:"agent_draft",status:"applied",binding:{purpose:"create",tenant:owner,settings:{agentName:"Robin",strategy:"steady-basket",basketSymbols:["TSLA"],...RISK_PROFILES.careful.settings},risk_level:"careful",expires_at:now/1000+3600},binding_hash:"a".repeat(64),summary:{},requested_by:"Claude",created_at:now/1000,expires_at:now/1000+3600,decided_at:now/1000,result:{setup_only:true,setup_url:"https://evil.example/steal"},fresh_quote:null,settings_check:null};
}
function setupView():View {
  const v=view();
  delete (v.binding.settings as Record<string,unknown>).maxImpactBps;
  return v;
}

it("accepts only one opaque setup ID from the URL",()=>{
  assert.deepEqual(mcpSetupRequest("?name=forged&strategy=live"),{id:null,invalid:false});
  assert.deepEqual(mcpSetupRequest(`?proposal=${id}&live=true`),{id,invalid:false});
  for(const search of [`?proposal=${id}&proposal=${id}`,"?proposal=", "?proposal=https://evil.example"]){
    assert.deepEqual(mcpSetupRequest(search),{id:null,invalid:true});
  }
});
it("hydrates only reviewed, owner-bound setup fields and preset risk settings",()=>{
  const setup=approvedMcpSetup(setupView(),id,owner.toUpperCase().replace("0X","0x"),now);
  assert.equal(setup.name,"Robin");assert.equal(setup.strategy,"steady-basket");
  assert.deepEqual(setup.basket,["TSLA"]);assert.equal(setup.riskLevel,"careful");
  assert.equal(setup.riskSettings.slippageBps,RISK_PROFILES.careful.settings.slippageBps);
  assert.equal("maxImpactBps" in setup.riskSettings,false);
});
it("rejects unapproved, foreign, expired and non-creation drafts",()=>{
  for(const mutate of [
    (v:View)=>{v.status="awaiting_approval";},
    (v:View)=>{v.kind="settings";},
    (v:View)=>{delete v.binding.purpose;},
    (v:View)=>{v.binding.tenant=`0x${"c".repeat(40)}`;},
    (v:View)=>{v.result={};},
    (v:View)=>{v.expires_at=now/1000;v.binding.expires_at=v.expires_at;},
    (v:View)=>{v.binding.expires_at=now/1000+7200;},
    (v:View)=>{v.id=`prp_${"d".repeat(32)}`;},
  ]){const v=setupView();mutate(v);assert.throws(()=>approvedMcpSetup(v,id,owner,now),/not approved/);}
});
it("a pending creation can be displayed without becoming an approved setup",()=>{
  const v=setupView();v.status="awaiting_approval";v.result=null;
  const review=reviewMcpCreateSetup(v,id,owner,now);
  assert.equal(review.name,"Robin");assert.equal(review.status,"awaiting_approval");
  assert.equal(review.bindingHash,v.binding_hash);
  assert.throws(()=>approvedMcpSetup(v,id,owner,now),/not approved/);
});
it("pending display rejects foreign, expired, altered and malformed proposals",()=>{
  for(const mutate of [
    (v:View)=>{v.binding.tenant=`0x${"c".repeat(40)}`;},
    (v:View)=>{v.expires_at=now/1000;v.binding.expires_at=v.expires_at;},
    (v:View)=>{v.binding.purpose="settings";},
    (v:View)=>{v.binding_hash="missing";},
    (v:View)=>{v.status="rejected";},
    (v:View)=>{(v.binding.settings as Record<string,unknown>).liveTradingEnabled=true;},
    (v:View)=>{(v.binding.settings as Record<string,unknown>).slippageBps=9999;},
  ]){
    const v=setupView();v.status="awaiting_approval";v.result=null;mutate(v);
    assert.throws(()=>reviewMcpCreateSetup(v,id,owner,now));
  }
});
it("an applied review still requires the approved setup-only result",()=>{
  const v=setupView();v.result={};
  assert.throws(()=>reviewMcpCreateSetup(v,id,owner,now),/not approved/);
});
it("rejects injected settings, altered presets and unknown strategies",()=>{
  for(const patch of [{liveTradingEnabled:true},{maxImpactBps:9999},{slippageBps:9999},{strategy:"made-up"},{agentName:""},{basketSymbols:["bad symbol"]}]){
    const v=setupView();Object.assign(v.binding.settings as object,patch);
    assert.throws(()=>approvedMcpSetup(v,id,owner,now),/not approved/);
  }
});
it("rejects crypto-only non-Trencher setups with an omitted or stock-only basket",()=>{
  for(const strategy of ["steady-basket","weekend-gap","llm-strategist","even-keel","dip-hunter"]){
    for(const basketSymbols of [undefined,["TSLA"],["qqq","nVdA","tsla"]]){
      const v=setupView();const settings=v.binding.settings as Record<string,unknown>;
      Object.assign(settings,{strategy,assetMode:"crypto"});
      if(basketSymbols===undefined)delete settings.basketSymbols;else settings.basketSymbols=basketSymbols;
      assert.throws(()=>approvedMcpSetup(v,id,owner,now),/Crypto-only setup needs an explicit basket/,`${strategy}: ${basketSymbols}`);
    }
  }
});
it("preserves an explicit owner-reviewed crypto basket instead of substituting stocks",()=>{
  const v=setupView();Object.assign(v.binding.settings as object,{strategy:"llm-strategist",assetMode:"crypto",basketSymbols:["Cat"]});
  const setup=approvedMcpSetup(v,id,owner,now);
  assert.equal(setup.assetMode,"crypto");assert.deepEqual(setup.basket,["Cat"]);
});
it("keeps stock-capable basket defaults and Trencher discovery setup unchanged",()=>{
  for(const assetMode of [undefined,"all","stocks"]){
    const v=setupView();const settings=v.binding.settings as Record<string,unknown>;
    delete settings.basketSymbols;
    if(assetMode!==undefined)settings.assetMode=assetMode;
    const setup=approvedMcpSetup(v,id,owner,now);
    assert.equal(setup.assetMode,assetMode??"all");assert.deepEqual(setup.basket,DEFAULT_BASKET_SYMBOLS);
  }
  const v=setupView();const settings=v.binding.settings as Record<string,unknown>;
  Object.assign(settings,{strategy:"trencher",assetMode:"crypto"});delete settings.basketSymbols;
  const setup=approvedMcpSetup(v,id,owner,now);
  assert.equal(setup.assetMode,"crypto");assert.deepEqual(setup.basket,[]);
});
it("owner continuation is local and says wallet setup still remains",()=>{
  const v=setupView();assert.equal(headline(v),"Ready for wallet setup");
  v.result={setup_only:true,setup_url:"https://attacker.invalid/steal"};
  assert.equal(walletSetupUrl(v,now),`/connect/setup/${id}`);
  assert.equal(walletSetupUrl(v,now+3600_000),null);
  v.status="awaiting_approval";assert.equal(walletSetupUrl(v,now),null);
  v.status="applied";v.id="../../attacker";assert.equal(walletSetupUrl(v,now),null);
  v.id=id;
  v.binding.purpose="update";assert.equal(walletSetupUrl(v,now),null);
});
