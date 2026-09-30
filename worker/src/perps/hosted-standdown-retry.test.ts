import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runHostedStanddown } from "./hosted-standdown-runner";
import type { StanddownAccount, StanddownOptions } from "./standdown";
import { perpMarketById } from "../../../packages/core/src/perps";

function flatFixture() {
 let now=1_800_000_000_000,collateral=10_000_000n,checkpoints=0,sends=0;
 const deadlineMs=now+90_000;
 const account=():StanddownAccount=>({collateralMicro:collateral,positions:[],totalOrderCount:0,pendingOrderCount:0,poolShareCount:0,pendingUnlockCount:0,spotHoldings:[],decimals:new Map()});
 const opts:StanddownOptions={reason:"kill",deadlineMs,now:()=>now,sleep:async ms=>{now+=ms;},settings:{maxSlippageBps:150},
  executor:{account:async()=>account(),place:async()=>{throw new Error("flat account must never close");},cancelMarket:async()=>({status:"executed"}),requestWithdraw:async()=>{sends++;collateral=0n;return {status:"executed"};}},
  reconcile:{resolveSubmitted:async()=>{},reconcileOnce:async()=>{}}};
 return {opts,checkpoint:async()=>{checkpoints++;},stats:()=>({now,checkpoints,sends,collateral}),zero:()=>{collateral=0n;}};
}
describe("hosted shutdown uses its remaining fixed recovery window",()=>{
 it("a transient withdrawal refusal recovers automatically before the parent retires custody",async()=>{
  const f=flatFixture(),send=f.opts.executor.requestWithdraw;let attempts=0;
  f.opts.executor.requestWithdraw=async(...args)=>{attempts++;return attempts===1?{status:"rejected",detail:"temporarily unavailable"}:send(...args);};
  const result=await runHostedStanddown(f.opts,f.checkpoint);
  assert.equal(result.outcome,"done");assert.equal(result.ingested,true);
  assert.equal(attempts,2);assert.equal(f.stats().sends,1);assert.equal(f.stats().checkpoints,2);
  assert.ok(f.stats().now<f.opts.deadlineMs);assert.equal(result.deadlineMs,f.opts.deadlineMs);
 });
 it("a failed final ingest is retried without another withdrawal after collateral is gone",async()=>{
  const f=flatFixture();let ingests=0;
  f.opts.reconcile.reconcileOnce=async()=>({ok:++ingests>1});
  const result=await runHostedStanddown(f.opts,f.checkpoint);
  assert.equal(result.ingested,true);assert.equal(f.stats().sends,1);assert.equal(ingests,2);
  assert.equal(result.withdrawRequestedMicro,10_000_000n,"the accepted request survives the later zero-collateral ingest pass");
 });
 it("ambiguous withdrawal stays unresolved through the deadline without inventing a new send",async()=>{
  const f=flatFixture();let attempts=0,sends=0,pending=false;
  f.opts.executor.requestWithdraw=async()=>{
   attempts++;
   // The live executor's durable pending-withdrawal guard has this contract.
   if(pending)throw new Error("perp-withdraw-in-flight");
   pending=true;sends++;throw new Error("reply lost after send");
  };
  const result=await runHostedStanddown(f.opts,f.checkpoint);
  assert.equal(result.outcome,"residual");assert.equal(result.withdrawRequestedMicro,null);
  assert.equal(sends,1);assert.ok(attempts>1);assert.ok(f.stats().now<=f.opts.deadlineMs);
 });
 it("unsupported residual assets do not repeatedly restart a completed perps unwind",async()=>{
  const f=flatFixture();f.zero();const account=f.opts.executor.account;
  f.opts.executor.account=async ctx=>({...((await account(ctx))!),poolShareCount:1});
  const result=await runHostedStanddown(f.opts,f.checkpoint);
  assert.equal(result.outcome,"residual");assert.equal(f.stats().checkpoints,1);assert.equal(f.stats().sends,0);
 });
 it("an open position with an initially unread mark closes when pricing recovers within the same job",async()=>{
  const f=flatFixture();let open=true,closes=0;
  const flat=f.opts.executor.account;
  f.opts.executor.account=async ctx=>({...((await flat(ctx))!),decimals:new Map([[1,{sizeDecimals:5,priceDecimals:1}]]),positions:open?[{
   marketId:1,key:perpMarketById(1)!.key,symbol:"BTC",side:"long",baseAmount:100n,marginMode:"isolated",allocatedMarginMicro:1_000_000n,
   positionValueMicro:f.stats().checkpoints?80_000_000n:0n,openOrderCount:0,pendingOrderCount:0,positionTiedOrderCount:1,stopResting:true,
  }]:[]});
  f.opts.executor.place=async intent=>{assert.ok(intent.reduceOnly);assert.equal(intent.effect,"close");closes++;open=false;return {status:"filled",orderRowId:"close",filledBase:100n};};
  let ingests=0;f.opts.reconcile.reconcileOnce=async()=>({ok:++ingests!==2});
  const result=await runHostedStanddown(f.opts,f.checkpoint,async()=>3-closes);
  assert.equal(result.outcome,"done");assert.equal(closes,1);assert.equal(f.stats().checkpoints,3);
  assert.equal(result.closed.length,1);assert.equal(result.closed[0]!.filledBase,100n);
  assert.equal(result.withdrawRequestedMicro,10_000_000n);
 });
 it("transient pre-send failures do not burn the job's three actual sends, and exhausted capacity signs nothing further",async()=>{
  const f=flatFixture();let calls=0,actualSends=0;
  const flat=f.opts.executor.account;
  f.opts.executor.account=async ctx=>({...((await flat(ctx))!),decimals:new Map([[1,{sizeDecimals:5,priceDecimals:1}]]),positions:[{
   marketId:1,key:perpMarketById(1)!.key,symbol:"BTC",side:"long",baseAmount:100n,marginMode:"isolated",allocatedMarginMicro:1_000_000n,
   positionValueMicro:80_000_000n,openOrderCount:0,pendingOrderCount:0,positionTiedOrderCount:1,stopResting:true,
  }]});
  f.opts.executor.place=async()=>{calls++;if(!f.stats().checkpoints)throw new Error("temporary pre-sign venue read failure");actualSends++;return {status:"rejected",orderRowId:`close-${actualSends}`,filledBase:0n};};
  const result=await runHostedStanddown(f.opts,f.checkpoint,async()=>3-actualSends);
  assert.equal(result.outcome,"residual");assert.equal(result.residual[0]!.stopResting,true);
  assert.equal(actualSends,3);assert.equal(calls,6);assert.equal(f.stats().checkpoints,2);
  // A reclaimed job observes the same spent parent budget, before signing.
  await runHostedStanddown(f.opts,f.checkpoint,async()=>3-actualSends);
  assert.equal(actualSends,3);assert.equal(calls,6);
 });
});
