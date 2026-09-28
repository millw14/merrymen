import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, type PublicClient } from "viem";
import { CASH, UNISWAP, GRANT_TRENCHER, MERRYMEN_TOKEN, type StoredGrant } from "../../packages/core/src/index";
import { discoverTrencherUniverse } from "./trencher-discovery";
import { emptyGeckoBuckets, type GeckoPool } from "./venues/geckoterminal";

const token="0x1111111111111111111111111111111111111111";
const vault="0x2222222222222222222222222222222222222222";
const factory="0x3333333333333333333333333333333333333333";
const owner="0x4444444444444444444444444444444444444444";
const poolAddress="0x5555555555555555555555555555555555555555";
const grant={smartAccount:owner,grantFeatures:[GRANT_TRENCHER],trencherVaultAddress:vault,trencherFactoryAddress:factory} as unknown as StoredGrant;
const pool={tokenAddress:token,poolAddress,poolId:poolAddress,priceUsd:0.01,reserveUsd:200_000,fdvUsd:1_000_000,change24hPct:5,change1hPct:1,createdAt:1000,dex:"uniswap-v3-robinhood",name:"COIN / USDG",volume24hUsd:500_000,buyers24h:50,buys24h:100,sells24h:80,
  buckets:{...emptyGeckoBuckets(),m5:{volumeUsd:1000,changePct:2,buys:10,sells:8,buyers:9,sellers:8}}} as GeckoPool;
function client(over:Record<string,unknown>={}) {
  return {getCode:async()=>"0x6000",readContract:async({functionName}: {functionName:string})=>{
    const values:Record<string,unknown>={cash:CASH.USDG,bridge:CASH.WETH,router:UNISWAP.swapRouter02,poolFactory:UNISWAP.v3Factory,vaultFor:vault,owner,VERSION:1n,tokens:[],token0:CASH.USDG,token1:token,fee:3000,getPool:poolAddress,decimals:6,...over};
    const result=values[functionName]; if (result instanceof Error) throw result;
    if (result===undefined) throw new Error(`Unexpected read ${functionName}`);
    return result;
  }} as unknown as PublicClient;
}
test("automatic discovery verifies pool provenance and recovers held tokens without a custom list",async(t)=>{
  const prior=process.env.TRENCHER_FACTORY_CODE_HASH;
  process.env.TRENCHER_FACTORY_CODE_HASH=keccak256("0x6000");
  t.after(()=>{if(prior===undefined) delete process.env.TRENCHER_FACTORY_CODE_HASH; else process.env.TRENCHER_FACTORY_CODE_HASH=prior;});
  const result=await discoverTrencherUniverse(client(),grant,[pool]);
  assert.equal(result.qualified.length,1); assert.equal(result.tokens[0]!.address,token);
  assert.equal(result.tokens[0]!.decimals,6); assert.equal(result.tokens[0]!.name,"COIN / USDG");
  const competing = await discoverTrencherUniverse(client(),grant,[
    {...pool,dex:"uniswap-v4-robinhood",volume24hUsd:900_000}, pool,
  ]);
  assert.equal(competing.qualified.length,1,"unsupported higher-volume pool must not hide the verified V3 route");
  assert.equal(competing.qualified[0]!.dex,"uniswap-v3-robinhood");
  assert.equal((await discoverTrencherUniverse(client({getPool:owner}),grant,[pool])).tokens.length,0);
  assert.equal((await discoverTrencherUniverse(client({token1:owner}),grant,[pool])).tokens.length,0);
  assert.equal((await discoverTrencherUniverse(client(),grant,[{...pool,dex:"uniswap-v4-robinhood"}])).tokens.length,0);
  const restarted=await discoverTrencherUniverse(client({tokens:[token]}),grant,[]);
  assert.equal(restarted.tokens[0]!.address,token);
  await assert.rejects(discoverTrencherUniverse(client({tokens:new Error("RPC unavailable")}),grant,[]),/RPC unavailable/);
  await assert.rejects(discoverTrencherUniverse(client({tokens:[token],decimals:new Error("metadata unavailable")}),grant,[]),/metadata unavailable/);
  assert.equal((await discoverTrencherUniverse(client({decimals:new Error("metadata unavailable")}),grant,[pool])).tokens.length,0);
  process.env.TRENCHER_FACTORY_CODE_HASH=keccak256("0x6001");
  await assert.rejects(discoverTrencherUniverse(client(),grant,[pool]),/bytecode/);
});
test("the energy reserve is never a trencher candidate, and held tokens are not narrowed", async (t) => {
  // $MERRYMEN is held as energy — never watched, bought or sold as a coin. A
  // Uniswap v3 MERRYMEN pool does not exist today, but discovery must not
  // depend on that staying true.
  const prior = process.env.TRENCHER_FACTORY_CODE_HASH;
  process.env.TRENCHER_FACTORY_CODE_HASH = keccak256("0x6000");
  t.after(() => { if (prior === undefined) delete process.env.TRENCHER_FACTORY_CODE_HASH; else process.env.TRENCHER_FACTORY_CODE_HASH = prior; });
  const merrymen = MERRYMEN_TOKEN.address;
  const reservePool = { ...pool, tokenAddress: merrymen, name: "MERRYMEN / USDG" } as GeckoPool;
  const shouted = { ...reservePool, tokenAddress: `0x${merrymen.slice(2).toUpperCase()}` } as GeckoPool;
  for (const p of [reservePool, shouted]) {
    const result = await discoverTrencherUniverse(client({ token1: merrymen }), grant, [p]);
    assert.equal(result.qualified.length, 0, "a qualifying MERRYMEN pool is excluded");
    assert.equal(result.tokens.length, 0);
  }
  // An ordinary pool beside it still qualifies.
  const both = await discoverTrencherUniverse(client(), grant, [reservePool, pool]);
  assert.deepEqual(both.qualified.map((q) => q.tokenAddress), [token]);
  // What the vault already holds is read as it is: `held` is never filtered,
  // because a held-token read must never be narrowed into an empty book.
  const held = await discoverTrencherUniverse(client({ tokens: [token] }), grant, [reservePool]);
  assert.deepEqual(held.held, [token]);
  assert.deepEqual(held.tokens.map((x) => x.address), [token]);
});
