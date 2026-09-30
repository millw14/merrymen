import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeFunctionData } from "viem";
import { CASH, GRANT_TRENCHER, TRENCHER_VAULT_ABI, type StoredGrant } from "../../packages/core/src/index";
import { buildTrencherCalls, checkTrencherCalls } from "./venues/trencher-vault";
import { checkPolicy, type AgentLimits, type TradeIntent } from "./policy";
const vault="0x1111111111111111111111111111111111111111";
const token="0x2222222222222222222222222222222222222222";
const factory="0x3333333333333333333333333333333333333333";
const owner="0x4444444444444444444444444444444444444444";
const grant={smartAccount:owner,grantFeatures:[GRANT_TRENCHER],trencherVaultAddress:vault,trencherFactoryAddress:factory} as unknown as StoredGrant;
test("autonomous swaps cannot borrow ordinary token permissions or substitute custody",()=>{
  const limits:AgentLimits={perTradeUsdg:10_000_000n,dailyUsdg:25_000_000n,maxOpsPerDay:24,maxDrawdownBps:500,expiresAt:2000,allowedTargets:[vault],allowedAssets:[CASH.USDG],sellableAssets:[CASH.USDG],cashToken:CASH.USDG,trencherVault:vault,knownTrencherAssets:[token]};
  const state={nowSec:1000,spentTodayUsdg:0n,opsToday:0,highWaterMarkUsdg:100_000_000n,equityUsdg:100_000_000n};
  const intent:TradeIntent={kind:"swap",custody:"trencher",target:vault,sellToken:CASH.USDG,buyToken:token,sellAmountRaw:5_000_000n,notionalUsdg:5_000_000n};
  assert.equal(checkPolicy(intent,limits,state).ok,true);
  assert.equal(checkPolicy({...intent,custody:undefined},limits,state).ok,false);
  assert.equal(checkPolicy(intent,{...limits,trencherVault:undefined},state).ok,false);
  assert.equal(checkPolicy(intent,{...limits,knownTrencherAssets:[]},state).ok,false);
  assert.equal(checkPolicy({...intent,sellAmountRaw:6_000_000n},limits,state).ok,false);
  assert.equal(checkPolicy(intent,{...limits,expiresAt:999},state).ok,false);
  assert.equal(checkPolicy(intent,{...limits,perTradeUsdg:1n},state).ok,false);
});
test("vault buy and sell calls use the sealed target and never approve a discovered token from the account",()=>{
  const args={grant,deployed:false,quote:{fee:3000,amountOut:10n,gasEstimate:100000n},token:token as `0x${string}`,side:"buy" as const,amountIn:5_000_000n,minOut:1n,deadline:2000n};
  const calls=buildTrencherCalls(args);
  assert.deepEqual(calls.map(c=>c.to),[factory,CASH.USDG,vault]);
  const decoded=decodeFunctionData({abi:TRENCHER_VAULT_ABI,data:calls[2]!.data});
  assert.equal(decoded.functionName,"buy");
  const sell=buildTrencherCalls({...args,deployed:true,side:"sell",amountIn:10n});
  assert.equal(sell.length,1); assert.equal(sell[0]!.to,vault);
  assert.equal(decodeFunctionData({abi:TRENCHER_VAULT_ABI,data:sell[0]!.data}).functionName,"sell");
  assert.throws(()=>buildTrencherCalls({...args,grant:{...grant,grantFeatures:[]}}));
  assert.throws(()=>buildTrencherCalls({...args,amountIn:5_000_001n}));
  assert.equal(checkTrencherCalls(calls,args).ok,true);
  assert.equal(checkTrencherCalls([...calls,calls[0]!],args).ok,false);
  assert.equal(checkTrencherCalls(calls.map((c,i)=>i===2?{...c,to:token}:c),args).ok,false);
  for (const index of [0,3,4,5]) {
    const changed = [token,3000,0,5_000_000n,1n,2000n] as const;
    const values: any[] = [...changed]; values[index]=index===0?owner:2n;
    const data=encodeFunctionData({abi:TRENCHER_VAULT_ABI,functionName:"buy",args:values as any});
    assert.equal(checkTrencherCalls([...calls.slice(0,2),{...calls[2]!,data}],args).ok,false);
  }
  assert.equal(checkTrencherCalls(sell,{...args,deployed:true,side:"sell",amountIn:10n}).ok,true);
});
