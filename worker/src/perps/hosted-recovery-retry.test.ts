import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostedRecoveryRetries, recoverHostedChild, transientHostedRecoveryError } from "./hosted-recovery-retry";

const reset = () => Object.assign(new Error("database connection dropped"), { code: "ECONNRESET" });
describe("hosted startup recovery", () => {
 it("retries temporary storage failures with a bounded delay, but never accounting or authority refusals", () => {
  const retries = new HostedRecoveryRetries();
  retries.fail("tenant", "account", reset(), 0);
  assert.equal(retries.due("tenant", "account", 29_999), false);
  assert.equal(retries.due("tenant", "account", 30_000), true);
  retries.fail("tenant", "account", reset(), 30_000);
  assert.equal(retries.due("tenant", "account", 89_999), false);
  assert.equal(retries.due("tenant", "account", 90_000), true);
  for (let n=0;n<10;n++) retries.fail("tenant", "account", reset(), 100_000);
  assert.equal(retries.due("tenant", "account", 400_000), true);
  for (const message of ["warm financial state diverges without complete audit facts", "paged checkpoint authentication failed", "hosted perps recovery was fenced", "accounting drift"]) {
   retries.fail("tenant", "account", new Error(message), 0);
   assert.equal(retries.has("tenant"), false);
  }
  retries.fail("tenant", "account", reset(), 0);
  assert.equal(retries.due("tenant", "another", 40_000), false);
  assert.equal(retries.has("tenant"), false);
  assert.equal(transientHostedRecoveryError({code:"ERR_SQLITE_ERROR",errcode:5}), true);
  assert.equal(transientHostedRecoveryError({code:"ERR_SQLITE_ERROR",errcode:11}), false);
  assert.equal(transientHostedRecoveryError(new Error("timeout exceeded when trying to connect")), true);
  assert.equal(transientHostedRecoveryError({code:"28P01",message:"password authentication failed"}), false);
 });
 it("does not stop a healthy child while storage is still unavailable", async () => {
  const events:string[]=[];
  await assert.rejects(recoverHostedChild({healthy:()=>true,probe:async()=>{throw reset();},stop:async()=>{events.push("stop");return true;},mirror:async()=>{events.push("mirror");return true;},restart:async()=>{events.push("restart");}}));
  assert.deepEqual(events,[]);
 });
 it("waits for actual exit and complete final mirror before preparing a replacement", async () => {
  const events:string[]=[];let exited!:()=>void;
  const exit=new Promise<void>(resolve=>{exited=resolve;});
  const recovered=recoverHostedChild({healthy:()=>true,probe:async()=>{events.push("probe");},stop:async()=>{events.push("stop");await exit;events.push("exit");return true;},mirror:async()=>{events.push("mirror");return true;},restart:async()=>{events.push("restart");}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,["probe","stop"]);
  exited();assert.equal(await recovered,true);
  assert.deepEqual(events,["probe","stop","exit","mirror","restart"]);
 });
 it("an incomplete mirror, unexited child or lost lease never reaches restart", async () => {
  for(const failure of ["exit","mirror","lease"]){
   let healthy=true,restarts=0,mirrors=0;
   const result=await recoverHostedChild({healthy:()=>healthy,probe:async()=>{},stop:async()=>{if(failure==="lease")healthy=false;return failure!=="exit";},mirror:async()=>{mirrors++;return failure!=="mirror";},restart:async()=>{restarts++;}});
   assert.equal(result,false);assert.equal(restarts,0);assert.equal(mirrors,failure==="mirror"?1:0);
  }
 });
});
