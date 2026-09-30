import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, type PublicClient } from "viem";
import { CASH, UNISWAP, GRANT_TRENCHER, MERRYMEN_TOKEN, type StoredGrant } from "../../packages/core/src/index";
import { NOMINATED_VERIFY_MAX, discoverTrencherUniverse } from "./trencher-discovery";
import { emptyGeckoBuckets, type GeckoPool } from "./venues/geckoterminal";

const token="0x1111111111111111111111111111111111111111";
const vault="0x2222222222222222222222222222222222222222";
const factory="0x3333333333333333333333333333333333333333";
const owner="0x4444444444444444444444444444444444444444";
const poolAddress="0x5555555555555555555555555555555555555555";
const grant={smartAccount:owner,grantFeatures:[GRANT_TRENCHER],trencherVaultAddress:vault,trencherFactoryAddress:factory} as unknown as StoredGrant;
const pool={tokenAddress:token,poolAddress,poolId:poolAddress,priceUsd:0.01,reserveUsd:200_000,fdvUsd:1_000_000,change24hPct:5,change1hPct:1,createdAt:1000,dex:"uniswap-v3-robinhood",name:"COIN / USDG",volume24hUsd:500_000,buyers24h:50,buys24h:100,sells24h:80,
  buckets:{...emptyGeckoBuckets(),m5:{volumeUsd:1000,changePct:2,buys:10,sells:8,buyers:9,sellers:8}}} as GeckoPool;
/**
 * Multicall3 as the chain runs it: every call answered exactly as readContract
 * would answer it, and a failure reported for that call alone.
 */
function withMulticall<C extends { readContract: (a: never) => Promise<unknown> }>(c: C) {
  const read = c.readContract as (a: unknown) => Promise<unknown>;
  return { ...c, multicall: async ({ contracts }: { contracts: readonly unknown[] }) =>
    Promise.all(contracts.map(x => read(x).then(result => ({ status: "success", result }), error => ({ status: "failure", error, result: undefined })))) };
}
function client(over:Record<string,unknown>={}) {
  return withMulticall({getCode:async()=>"0x6000",readContract:async({functionName}: {functionName:string})=>{
    const values:Record<string,unknown>={cash:CASH.USDG,bridge:CASH.WETH,router:UNISWAP.swapRouter02,poolFactory:UNISWAP.v3Factory,vaultFor:vault,owner,VERSION:1n,tokens:[],token0:CASH.USDG,token1:token,fee:3000,getPool:poolAddress,decimals:6,...over};
    const result=values[functionName]; if (result instanceof Error) throw result;
    if (result===undefined) throw new Error(`Unexpected read ${functionName}`);
    return result;
  }}) as unknown as PublicClient;
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

// ─── Nominated coins (Telegram groups, docs/tg-groups.md) ─────────────────
//
// A coin posted in a group is a LOOKUP KEY: it decides which pool this pass
// reads on chain, never whether that pool counts as verified. These tests pin
// both halves: a nominated pool far outside the top slice IS read, and it
// passes or fails exactly the checks every other pool does.

/** A pool per index, each with its own token and pool address and a descending volume. */
const ranked = (n: number) => Array.from({ length: n }, (_, i) => {
  const hex = (i + 1).toString(16).padStart(4, "0");
  return {
    ...pool,
    tokenAddress: `0x${"a".repeat(36)}${hex}` as `0x${string}`,
    poolAddress: `0x${"b".repeat(36)}${hex}` as `0x${string}`,
    poolId: `0x${"b".repeat(36)}${hex}`,
    volume24hUsd: 10_000_000 - i * 10_000,
  } as GeckoPool;
});

/**
 * A chain where each pool answers for ITS OWN token, and the canonical
 * factory knows exactly the pools in `canonical` (by token). Every pool read
 * is recorded, so a test can say which pools the pass actually looked at.
 */
function chain(canonical: ReadonlySet<string>, reads: string[]) {
  const pools = new Map<string, string>();
  return {
    register(p: GeckoPool) { pools.set(p.poolAddress!.toLowerCase(), p.tokenAddress.toLowerCase()); },
    client: withMulticall({
      getCode: async () => "0x6000",
      readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
        const a = address.toLowerCase();
        const values: Record<string, unknown> = { cash: CASH.USDG, bridge: CASH.WETH, router: UNISWAP.swapRouter02, poolFactory: UNISWAP.v3Factory, vaultFor: vault, owner, VERSION: 1n, tokens: [], decimals: 6 };
        if (pools.has(a)) {
          reads.push(a);
          if (functionName === "token0") return CASH.USDG;
          if (functionName === "token1") return pools.get(a);
          if (functionName === "fee") return 3000;
        }
        if (functionName === "getPool") {
          const token = String(args?.[1] ?? "").toLowerCase();
          if (!canonical.has(token)) return owner; // someone else's pool — not the one posted
          for (const [poolAddr, t] of pools) if (t === token) return poolAddr;
        }
        const result = values[functionName];
        if (result === undefined) throw new Error(`Unexpected read ${functionName}`);
        return result;
      },
    }) as unknown as PublicClient,
  };
}

test("a nominated pool outside the top slice is verified by the same on-chain checks", async (t) => {
  const prior = process.env.TRENCHER_FACTORY_CODE_HASH;
  process.env.TRENCHER_FACTORY_CODE_HASH = keccak256("0x6000");
  t.after(() => { if (prior === undefined) delete process.env.TRENCHER_FACTORY_CODE_HASH; else process.env.TRENCHER_FACTORY_CODE_HASH = prior; });
  const tape = ranked(30);
  const far = tape[27]!; // 28th busiest: nowhere near the top 20
  const reads: string[] = [];
  const c = chain(new Set(tape.map(p => p.tokenAddress.toLowerCase())), reads);
  tape.forEach(p => c.register(p));

  // NON-NOMINATED BEHAVIOUR IS UNCHANGED: the top 20 and nothing else.
  const plain = await discoverTrencherUniverse(c.client, grant, tape);
  assert.equal(plain.qualified.length, 20);
  assert.ok(!plain.qualified.some(p => p.tokenAddress === far.tokenAddress), "without a nomination the far pool is never read");
  assert.ok(!reads.includes(far.poolAddress!.toLowerCase()));
  const emptySet = await discoverTrencherUniverse(c.client, grant, tape, { nominated: new Set() });
  assert.deepEqual(emptySet.qualified.map(p => p.tokenAddress), plain.qualified.map(p => p.tokenAddress));

  // Nominated: read, verified, and in the universe — spelled any case.
  reads.length = 0;
  const withNomination = await discoverTrencherUniverse(c.client, grant, tape, { nominated: new Set([far.tokenAddress.toUpperCase().replace("0X", "0x")]) });
  assert.ok(reads.includes(far.poolAddress!.toLowerCase()), "the nominated pool is read on chain");
  assert.equal(withNomination.qualified.length, 21);
  assert.ok(withNomination.qualified.some(p => p.tokenAddress === far.tokenAddress));
  assert.ok(withNomination.tokens.some(tok => tok.address === far.tokenAddress && tok.symbol === `T${far.tokenAddress.slice(-11).toUpperCase()}`),
    "its identity is address-derived like every other discovered coin");
  // The rest of the top slice is exactly what it was.
  assert.deepEqual(withNomination.qualified.slice(0, 20).map(p => p.tokenAddress), plain.qualified.map(p => p.tokenAddress));
});

test("a nominated pool that fails the canonical factory check is dropped, whoever posted it", async (t) => {
  const prior = process.env.TRENCHER_FACTORY_CODE_HASH;
  process.env.TRENCHER_FACTORY_CODE_HASH = keccak256("0x6000");
  t.after(() => { if (prior === undefined) delete process.env.TRENCHER_FACTORY_CODE_HASH; else process.env.TRENCHER_FACTORY_CODE_HASH = prior; });
  const tape = ranked(25);
  const far = tape[22]!;
  const reads: string[] = [];
  // The factory does not return this pool for its token: a look-alike pool.
  const c = chain(new Set(tape.filter(p => p !== far).map(p => p.tokenAddress.toLowerCase())), reads);
  tape.forEach(p => c.register(p));
  const result = await discoverTrencherUniverse(c.client, grant, tape, { nominated: new Set([far.tokenAddress]) });
  assert.ok(reads.includes(far.poolAddress!.toLowerCase()), "it was read");
  assert.ok(!result.qualified.some(p => p.tokenAddress === far.tokenAddress), "and refused: a nomination is not provenance");
  assert.ok(!result.tokens.some(tok => tok.address === far.tokenAddress));
  assert.equal(result.qualified.length, 20);
});

test("a nominated pool still has to pass highVolumePools, the v3 venue and the energy exclusion", async (t) => {
  const prior = process.env.TRENCHER_FACTORY_CODE_HASH;
  process.env.TRENCHER_FACTORY_CODE_HASH = keccak256("0x6000");
  t.after(() => { if (prior === undefined) delete process.env.TRENCHER_FACTORY_CODE_HASH; else process.env.TRENCHER_FACTORY_CODE_HASH = prior; });
  const tape = ranked(22);
  const quiet = { ...tape[21]!, volume24hUsd: 99_999 } as GeckoPool; // under TRENCH_VOLUME_MIN
  const v4 = { ...tape[20]!, dex: "uniswap-v4-robinhood" } as GeckoPool;
  // Busy enough for highVolumePools, below every top-slice pool: only the
  // energy exclusion can keep it out.
  const reserve = { ...pool, tokenAddress: MERRYMEN_TOKEN.address, poolAddress: `0x${"c".repeat(40)}`, poolId: `0x${"c".repeat(40)}`, volume24hUsd: 200_000 } as GeckoPool;
  const all = [...tape.slice(0, 20), v4, quiet, reserve];
  const reads: string[] = [];
  const c = chain(new Set(all.map(p => p.tokenAddress.toLowerCase())), reads);
  all.forEach(p => c.register(p));
  const result = await discoverTrencherUniverse(c.client, grant, all, {
    nominated: new Set([quiet.tokenAddress, v4.tokenAddress, reserve.tokenAddress.toLowerCase()]),
  });
  for (const p of [quiet, v4, reserve]) {
    assert.ok(!result.qualified.some(q => q.tokenAddress.toLowerCase() === p.tokenAddress.toLowerCase()), p.name);
    assert.ok(!reads.includes(p.poolAddress!.toLowerCase()), "never even read on chain");
  }
  assert.equal(result.qualified.length, 20);
});

test("verification beyond the slice is bounded by the nomination queue", async (t) => {
  const prior = process.env.TRENCHER_FACTORY_CODE_HASH;
  process.env.TRENCHER_FACTORY_CODE_HASH = keccak256("0x6000");
  t.after(() => { if (prior === undefined) delete process.env.TRENCHER_FACTORY_CODE_HASH; else process.env.TRENCHER_FACTORY_CODE_HASH = prior; });
  const tape = ranked(40);
  const reads: string[] = [];
  const c = chain(new Set(tape.map(p => p.tokenAddress.toLowerCase())), reads);
  tape.forEach(p => c.register(p));
  const result = await discoverTrencherUniverse(c.client, grant, tape, { nominated: new Set(tape.slice(20).map(p => p.tokenAddress)) });
  assert.equal(result.qualified.length, 20 + NOMINATED_VERIFY_MAX);
  assert.equal(new Set(reads).size, 20 + NOMINATED_VERIFY_MAX);
});
