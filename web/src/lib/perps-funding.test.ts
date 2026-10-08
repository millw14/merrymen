import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CASH } from "@merrymen/core";
import { transferPerpsFunding } from "./perps-funding";
import { FundingPreparationError } from "./perps-funding-intent";
const SPOT = "0x1111111111111111111111111111111111111111" as const;
const PERPS = "0x2222222222222222222222222222222222222222" as const;
const TENANT = "0x3333333333333333333333333333333333333333";
const UINT = parseAbi(["function f() view returns(uint256)"]);
const SENDER = parseAbi(["function getSenderAddress(bytes initCode)", "error SenderAddressResult(address sender)"]);
const FACTORY = parseAbi(["function deployWithFactory(address factory,bytes data,bytes32 salt)"]);
const owner = privateKeyToAccount(`0x${"31".repeat(32)}`);
const request = { amountMicro: "1234567", expectedAccount: PERPS, expectedSource: SPOT, expectedOwner: TENANT, chainId: 4663, privyOwnerAccount: owner };
async function fixture(run: (ctx: { data: Map<string,string>; sent: Record<string,unknown>[]; switchAfterSign(): void }) => Promise<void>) {
 const keys = ["fetch", "window", "navigator", "localStorage"] as const;
 const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
 const data = new Map<string,string>(), sent: Record<string,unknown>[] = [];
 let login = TENANT, changeAfterSign = false;
 const storage = { getItem: (key:string) => data.get(key) ?? null, setItem: (key:string,value:string) => data.set(key,value) };
 const json = (body:unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
 const rpc = (method: string, params: unknown[]): object => {
  if (method === "eth_chainId") return {result:"0x1237"};
  if (method === "eth_getCode") return {result:"0x"};
  if (method === "eth_getBalance") return {result:"0x100000000000000000"};
  if (method === "eth_call") {
   const call = params[0] as {data:Hex;to:string};
   if (call.data.startsWith("0x9b249f69")) {
    const decoded = decodeFunctionData({abi:SENDER, data:call.data});
    const init = decoded.args![0] as Hex;
    const factory = decodeFunctionData({abi:FACTORY, data:`0x${init.slice(42)}`});
    const account = BigInt(factory.args[2]) === 1n ? PERPS : SPOT;
    return {error:{code:3,message:"execution reverted",data:encodeErrorResult({abi:SENDER,errorName:"SenderAddressResult",args:[account]})}};
   }
   if (call.data.startsWith("0x70a08231")) return {result:encodeFunctionResult({abi:UINT,result:99_000_000n})};
   if (call.data.startsWith("0x35567e1a")) return {result:encodeFunctionResult({abi:UINT,result:0n})};
   return {result:"0x"};
  }
  if (method === "pimlico_getUserOperationGasPrice") { const tier={maxFeePerGas:"0x2",maxPriorityFeePerGas:"0x1"}; return {result:{slow:tier,standard:tier,fast:tier}}; }
  if (method === "eth_estimateUserOperationGas") return {result:{preVerificationGas:"0xea60",verificationGasLimit:"0x493e0",callGasLimit:"0x61a80"}};
  if (method === "eth_sendUserOperation") {
   sent.push(params[0] as Record<string,unknown>);
   const intent=JSON.parse([...data.values()].find(raw => raw.includes('"submitting"'))!);
   return {result:intent.hash};
  }
  if (method === "eth_getUserOperationReceipt") return {result:{userOpHash:params[0],sender:SPOT,nonce:"0x0",actualGasCost:"0x1",actualGasUsed:"0x1",success:true,logs:[],receipt:{transactionHash:`0x${"ab".repeat(32)}`,blockHash:`0x${"cd".repeat(32)}`,blockNumber:"0x1",transactionIndex:"0x0",from:SPOT,to:SPOT,cumulativeGasUsed:"0x1",gasUsed:"0x1",effectiveGasPrice:"0x1",status:"0x1",logs:[],logsBloom:`0x${"00".repeat(256)}`,contractAddress:null,type:"0x2"}}};
  throw new Error(`Unexpected RPC ${method}`);
 };
 const fetcher = async (input:RequestInfo|URL,init?:RequestInit) => {
  const url = String(input);
  if (url === "/api/auth/session") return json({hosted:true,address:login});
  if (url.startsWith("/api/grants")) {const perps=url.includes("purpose=perps");return json({exists:true,grant:{purpose:perps?"perps":undefined,smartAccount:perps?PERPS:SPOT,owner:owner.address,chainId:4663}});}
  if (url.includes("/api/recover/ticket")) return json(init?.method==="POST"?{smartAccount:SPOT}:{nonce:"n",message:"recovery challenge"});
  const payload=JSON.parse(String(init?.body));
  const one=(item:{id:number;method:string;params:unknown[]})=>({jsonrpc:"2.0",id:item.id,...rpc(item.method,item.params??[])});
  return json(Array.isArray(payload)?payload.map(one):one(payload));
 };
 const values = {fetch:fetcher,window:{location:{origin:"https://app.merrymen.test"}},navigator:{locks:{request:async (_key:string,_options:unknown,fn:(lock:object)=>Promise<unknown>)=>fn({})}},localStorage:storage};
 for(const key of keys) Object.defineProperty(globalThis,key,{configurable:true,value:values[key],writable:true});
 const originalSign=owner.signMessage;
 owner.signMessage=async args=>{const result=await originalSign(args);if(changeAfterSign && typeof args.message === "object") login="0x4444444444444444444444444444444444444444";return result;};
 try {await run({data,sent,switchAfterSign:()=>{changeAfterSign=true;}});} finally {
  owner.signMessage=originalSign;
  for(const key of keys) {const descriptor=saved.get(key);if(descriptor) Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
 }
}
test("real SDK funding signs only the exact USDG transfer from Spot to the derived Perps account", async()=>fixture(async({data,sent})=>{
 const result=await transferPerpsFunding(request);
 assert.equal(result.status,"confirmed");assert.equal(sent.length,1);
 assert.equal(String(sent[0].sender).toLowerCase(),SPOT);
 const callData=String(sent[0].callData).toLowerCase();
 assert.ok(callData.includes(CASH.USDG.slice(2).toLowerCase()));
 assert.ok(callData.includes(PERPS.slice(2)));
 assert.ok(callData.includes(BigInt(request.amountMicro).toString(16).padStart(64,"0")));
 assert.ok([...data.values()].some(raw=>JSON.parse(raw).state==="confirmed"));
}));
test("an owner switch after the signing prompt prevents broadcast and pending journal creation",async()=>fixture(async({data,sent,switchAfterSign})=>{
 switchAfterSign();
 await assert.rejects(transferPerpsFunding(request),FundingPreparationError);
 assert.equal(sent.length,0);assert.equal(data.size,0);
}));
