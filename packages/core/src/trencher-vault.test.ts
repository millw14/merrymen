import assert from "node:assert/strict";
import { test } from "node:test";
import { ParamCondition } from "@zerodev/permissions/policies";
import { CASH } from "./tokens";
import { GRANT_TRENCHER, grantTrencher, trencherPermissions } from "./trencher-vault";
import { buildCallPermissions, buildWallPolicies } from "./wall";
import { firstEnableEnvelope, wallShape } from "./first-enable-gas";
const self = "0x1111111111111111111111111111111111111111";
const opts = {trencherVaultAddress:"0x2222222222222222222222222222222222222222",trencherFactoryAddress:"0x3333333333333333333333333333333333333333"};
test("autonomous permission is explicit and cannot grant recovery or arbitrary approvals",()=>{
  assert.deepEqual(trencherPermissions({},self,5_000_000n),[]);
  assert.equal(grantTrencher(opts),null);
  assert.ok(grantTrencher({...opts,grantFeatures:[GRANT_TRENCHER]}));
  const permissions=trencherPermissions(opts,self,10_000_000n);
  // NO `approve` OF ITS OWN, and that absence is the point rather than a
  // narrowing. It used to carry one — USDG approve, EQUAL(vault) — which
  // collided with the router approve on Kernel's (target, selector) key and
  // made every Trencher wall revert with `AA23 duplicate permissionHash`. The
  // vault is named in the router approval's ONE_OF list instead, asserted
  // below and in wall-duplicate-permission.test.ts.
  //
  // "No approve" is now proven by the TYPE — `functionName` narrows to
  // "buy" | "sell" | "deploy", so a runtime check for "approve" does not
  // compile. The deepEqual below is what pins the set; that nothing here
  // targets cash is asserted instead, since that is not type-level.
  assert.deepEqual(permissions.map(p=>p.functionName),["buy","sell","deploy"]);
  assert.ok(!permissions.some(p=>p.target===CASH.USDG),"nothing of its own targets cash");
  assert.equal(permissions[0]!.target,opts.trencherVaultAddress);
  // The 5 USDG entry ceiling still binds, now on `buy` rather than the approve.
  assert.deepEqual(permissions[0]!.args[3],{condition:ParamCondition.LESS_THAN_OR_EQUAL,value:5_000_000n});
  assert.deepEqual(permissions[2]!.args[0],{condition:ParamCondition.EQUAL,value:self});
  const wall=buildCallPermissions({perTradeUsdg:3,dailyUsdg:20,maxOpsPerDay:10,maxDrawdownBps:500,expiryDays:7} as never,self,opts);
  const buy=wall.find(p=>p.functionName==="buy" && p.target===opts.trencherVaultAddress);
  assert.ok(buy); assert.deepEqual(buy.args?.[3],{condition:ParamCondition.LESS_THAN_OR_EQUAL,value:3_000_000n});
  // The vault must be approvable for cash, or `buy()` cannot pull it and the
  // rail is dead in a quieter way than before.
  const approve=wall.find(p=>p.functionName==="approve" && p.target===CASH.USDG);
  assert.ok(approve,"the wall still carries exactly one USDG approve");
  assert.ok(
    (approve.args?.[0]?.value as readonly string[]).includes(opts.trencherVaultAddress),
    "and the vault is inside it",
  );
});
test("incomplete or malformed custody permissions fail closed",()=>{
  for(const bad of [{trencherVaultAddress:opts.trencherVaultAddress},{...opts,trencherFactoryAddress:"0x"},{...opts,trencherVaultAddress:"0x"+"0".repeat(40)},{...opts,trencherFactoryAddress:opts.trencherVaultAddress}]) {
    assert.throws(()=>trencherPermissions(bad,self,5_000_000n));
    assert.equal(grantTrencher({...bad,grantFeatures:[GRANT_TRENCHER]}),null);
  }
});
test("the autonomous wall serializes and fits the existing first-enable bound alongside the class vault",()=>{
  const caps={perTradeUsdg:10,dailyUsdg:500,maxOpsPerDay:24,maxDrawdownPct:5,expiryDays:7};
  const scope={...opts,ponsClassVaultAddress:"0x4444444444444444444444444444444444444444",ponsClassVaultFactoryAddress:"0x5555555555555555555555555555555555555555"};
  const shape=wallShape(buildCallPermissions(caps,self,scope));
  assert.equal(firstEnableEnvelope(shape).withinHardMax,true);
  assert.doesNotThrow(()=>buildWallPolicies({caps,smartAccount:self,...scope}));
});
