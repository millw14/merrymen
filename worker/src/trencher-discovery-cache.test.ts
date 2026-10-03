/**
 * WHAT A DISCOVERY PASS REMEMBERS, AND WHAT IT MUST STILL ASK.
 *
 * Measured 2026-09-27 on a healthy endpoint: a pass was ~110 logical reads, once
 * a minute per trencher agent — about a fifth of the fleet's reads — and ~80 of
 * them re-proved facts about pools that cannot change. The house RPC's monthly
 * quota ran out the next day.
 *
 * These tests pin both halves of the trade. A second pass over the same tape is
 * nearly free; and nothing it skips can admit a coin the uncached pass would
 * refuse: new pools are fully verified, tape claims are re-checked, holdings and
 * decimals are read fresh, custody is re-verified, and a refusal is never a
 * verification.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, multicall3Abi, type Hex, type PublicClient } from "viem";
import { CASH, UNISWAP, GRANT_TRENCHER, robinhoodChain, type StoredGrant } from "../../packages/core/src/index";
import { POOL_REFUSAL_TTL_MS, TrencherPoolCache, discoverTrencherUniverse } from "./trencher-discovery";
import { CoalescedRefresh } from "./coalesced-refresh";
import { emptyGeckoBuckets, type GeckoPool } from "./venues/geckoterminal";

const vault = "0x2222222222222222222222222222222222222222";
const factory = "0x3333333333333333333333333333333333333333";
const owner = "0x4444444444444444444444444444444444444444";
const stranger = "0x9999999999999999999999999999999999999999";
const grant = { smartAccount: owner, grantFeatures: [GRANT_TRENCHER], trencherVaultAddress: vault, trencherFactoryAddress: factory } as unknown as StoredGrant;

/** A tape of `n` v3 pools, busiest first, each with its own coin and pool address. */
function tape(n: number, from = 1): GeckoPool[] {
  return Array.from({ length: n }, (_, i) => {
    const hex = (i + from).toString(16).padStart(4, "0");
    return {
      tokenAddress: `0x${"a".repeat(36)}${hex}`, poolAddress: `0x${"b".repeat(36)}${hex}`, poolId: `0x${"b".repeat(36)}${hex}`,
      priceUsd: 0.01, reserveUsd: 200_000, fdvUsd: 1_000_000, change24hPct: 5, change1hPct: 1, createdAt: 1000,
      dex: "uniswap-v3-robinhood", name: `COIN${i + from} / USDG`, volume24hUsd: 10_000_000 - (i + from) * 10_000,
      buyers24h: 50, buys24h: 100, sells24h: 80,
      buckets: { ...emptyGeckoBuckets(), m5: { volumeUsd: 1000, changePct: 2, buys: 10, sells: 8, buyers: 9, sellers: 8 } },
    } as GeckoPool;
  });
}

/**
 * A chain whose every read is counted. Each registered pool answers for its own
 * coin against USDG (or `quote`), and the factory returns a pool only for the
 * coins in `canonical`. A multicall is ONE call, as it is to the provider.
 */
function chain() {
  const s = {
    pools: new Map<string, string>(),
    quote: new Map<string, string>(),
    canonical: new Set<string>(),
    failing: new Set<string>(),
    tokens: [] as readonly string[] | Error,
    decimals: new Map<string, number | Error>(),
    calls: [] as string[],
  };
  const answer = async ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    const a = address.toLowerCase();
    if (s.pools.has(a)) {
      if (s.failing.has(a)) throw new Error("RPC unavailable");
      if (functionName === "token0") return s.quote.get(a) ?? CASH.USDG;
      if (functionName === "token1") return s.pools.get(a);
      if (functionName === "fee") return 3000;
    }
    if (functionName === "getPool") {
      const coin = String(args?.[1] ?? "").toLowerCase();
      if (!s.canonical.has(coin)) return stranger;
      for (const [pool, t] of s.pools) if (t === coin) return pool;
      return stranger;
    }
    if (functionName === "decimals") {
      const d = s.decimals.get(a) ?? 6;
      if (d instanceof Error) throw d;
      return d;
    }
    if (functionName === "tokens") {
      if (s.tokens instanceof Error) throw s.tokens;
      return s.tokens;
    }
    const fixed: Record<string, unknown> = { cash: CASH.USDG, bridge: CASH.WETH, router: UNISWAP.swapRouter02, poolFactory: UNISWAP.v3Factory, vaultFor: vault, owner, VERSION: 1n };
    if (fixed[functionName] === undefined) throw new Error(`Unexpected read ${functionName}`);
    return fixed[functionName];
  };
  const client = {
    getCode: async ({ address }: { address: string }) => { s.calls.push(`getCode@${address.toLowerCase()}`); return "0x6000"; },
    readContract: async (x: { address: string; functionName: string; args?: readonly unknown[] }) => {
      s.calls.push(`${x.functionName}@${x.address.toLowerCase()}`);
      return answer(x);
    },
    multicall: async ({ contracts }: { contracts: readonly { address: string; functionName: string }[] }) => {
      s.calls.push(`multicall×${contracts.length}`);
      return Promise.all(contracts.map(c => answer(c).then(result => ({ status: "success", result }), error => ({ status: "failure", error, result: undefined }))));
    },
  } as unknown as PublicClient;
  return {
    s, client,
    add(pools: GeckoPool[], canonical = true) {
      for (const p of pools) {
        s.pools.set(p.poolAddress!.toLowerCase(), p.tokenAddress.toLowerCase());
        if (canonical) s.canonical.add(p.tokenAddress.toLowerCase());
      }
    },
    /** Reads that went to a pool, or to the factory's getPool — the part the cache exists to skip. */
    poolReads(): string[] { return s.calls.filter(c => /^(token0|token1|fee|getPool)@/.test(c)); },
    readsOf(pool: GeckoPool): string[] { return s.calls.filter(c => c.endsWith(`@${pool.poolAddress!.toLowerCase()}`)); },
    reset() { s.calls.length = 0; },
  };
}

function trustedHash(t: { after: (fn: () => void) => void }) {
  const prior = process.env.TRENCHER_FACTORY_CODE_HASH;
  process.env.TRENCHER_FACTORY_CODE_HASH = keccak256("0x6000");
  t.after(() => { if (prior === undefined) delete process.env.TRENCHER_FACTORY_CODE_HASH; else process.env.TRENCHER_FACTORY_CODE_HASH = prior; });
}

const addrs = (r: { qualified: GeckoPool[] }) => r.qualified.map(p => p.tokenAddress).sort();

test("A SECOND PASS OVER THE SAME TAPE MAKES FAR FEWER READS, and finds the same universe", async (t) => {
  trustedHash(t);
  const c = chain();
  const pools = tape(20);
  c.add(pools);
  const cache = new TrencherPoolCache();

  const first = await discoverTrencherUniverse(c.client, grant, pools, { cache });
  const firstCalls = c.s.calls.length;
  assert.equal(first.qualified.length, 20);
  assert.equal(c.poolReads().length, 80, "a cold pass proves every pool: token0, token1, fee, getPool");

  c.reset();
  const second = await discoverTrencherUniverse(c.client, grant, pools, { cache });
  assert.deepEqual(addrs(second), addrs(first));
  assert.deepEqual(second.tokens.map(x => [x.address, x.decimals, x.symbol]), first.tokens.map(x => [x.address, x.decimals, x.symbol]));
  assert.deepEqual(c.poolReads(), [], "nothing already proved is asked again");
  // What is left: custody (9), the vault's poolFactory, the holdings, one decimals multicall.
  assert.ok(c.s.calls.length <= 12, `a warm pass still made ${c.s.calls.length} reads: ${c.s.calls.join(", ")}`);
  assert.ok(firstCalls - c.s.calls.length >= 80, `saved only ${firstCalls - c.s.calls.length} reads`);

  // Without a cache nothing is remembered: the old behaviour, unchanged.
  c.reset();
  await discoverTrencherUniverse(c.client, grant, pools);
  assert.equal(c.poolReads().length, 80);
});

test("decimals use one actual aggregate3 request even with a small client batch default", async (t) => {
  trustedHash(t);
  const c = chain();
  const pools = tape(20);
  c.add(pools);
  const requestSizes: number[] = [];
  const wire = createPublicClient({
    chain: robinhoodChain,
    // One decimals() selector fits in this default. Discovery must explicitly
    // keep the pass together rather than rely on a caller's batch settings.
    batch: { multicall: { batchSize: 4 } },
    transport: custom({
      async request({ method, params }) {
        assert.equal(method, "eth_call");
        const [{ data }] = params as [{ data: Hex }];
        const decoded = decodeFunctionData({ abi: multicall3Abi, data });
        if (decoded.functionName !== "aggregate3") throw new Error(`Unexpected multicall: ${decoded.functionName}`);
        const calls = decoded.args[0];
        requestSizes.push(calls.length);
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: calls.map(call => {
            assert.equal(decodeFunctionData({ abi: erc20Abi, data: call.callData }).functionName, "decimals");
            return { success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 6 }) };
          }),
        });
      },
    }),
  });
  const result = await discoverTrencherUniverse({ ...c.client, multicall: wire.multicall } as PublicClient, grant, pools);
  assert.equal(result.tokens.length, 20);
  assert.deepEqual(requestSizes, [20]);
});

test("changing the connection discards cached evidence and a discovery already in flight", async () => {
  // Exercise the actual worker wiring without starting its main loop. Both
  // fragments are ordinary JavaScript; the surrounding module is TypeScript.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const refresh = source.slice(source.indexOf("  const autoTrenchRefresh ="), source.indexOf("  const trenchTapeReader ="));
  const resetStart = source.indexOf("      poolPrices.reset();", source.indexOf("  async function refreshConfig()"));
  const reset = source.slice(resetStart, source.indexOf("      if (active) {", resetStart));
  const pending: { cache: TrencherPoolCache; resolve: (result: unknown) => void }[] = [];
  const discover = (_client: unknown, _grant: unknown, _tape: unknown, opts: { cache: TrencherPoolCache }) =>
    new Promise(resolve => pending.push({ cache: opts.cache, resolve }));
  const worker = new Function("discoverTrencherUniverse", "TrencherPoolCache", "CoalescedRefresh", `
    let active = { agentId: "agent", grant: { grantedAt: 1 } };
    let autoTrench = null, autoTrenchContext = "", autoTrenchNext = 0;
    let trenchPoolCache = new TrencherPoolCache(), names = 0;
    const grantTrencher = () => true, mainnetClient = () => ({}), freshTrenchTape = () => [];
    const tgNominated = new Set(), coinNames = {}, poolPrices = { reset() {} };
    const warmHeldNames = () => { names++; }, trenchNotice = () => {};
    const wakeQualifiedNominations = () => {};
    ${refresh}
    return {
      tick: refreshAutoTrench,
      reconnect() { ${reset} },
      snapshot: () => ({ result: autoTrench, names, cache: trenchPoolCache }),
    };
  `)(discover, TrencherPoolCache, CoalescedRefresh) as {
    tick(): void; reconnect(): void;
    snapshot(): { result: unknown; names: number; cache: TrencherPoolCache };
  };
  worker.tick();
  await new Promise(resolve => setImmediate(resolve));
  const old = pending[0]!;
  old.cache.rememberVerified(factory, vault, { token0: CASH.USDG, token1: owner, fee: 3000 });
  worker.reconnect();
  worker.tick(); // A new connection while the old pass runs owes one new pass.
  assert.notEqual(worker.snapshot().cache, old.cache);
  assert.equal(worker.snapshot().cache.verified(factory, vault), undefined);
  old.resolve({ oldConnection: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.snapshot().result, null);
  assert.equal(worker.snapshot().names, 0, "old holdings must not warm names on the new connection");
  assert.equal(pending.length, 2, "the coalesced new-connection read starts without another poll or the old interval");
  pending[1]!.resolve({ newConnection: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(worker.snapshot().result, { newConnection: true });
  assert.equal(worker.snapshot().names, 1);
});

test("A NEW POOL IS FULLY VERIFIED, and a remembered one is re-checked against what the tape now claims", async (t) => {
  trustedHash(t);
  const c = chain();
  const pools = tape(20);
  c.add(pools);
  const cache = new TrencherPoolCache();
  await discoverTrencherUniverse(c.client, grant, pools, { cache });

  // A new, busier pool arrives — and one look-alike the factory never made.
  const [fresh, lookalike] = tape(2, 100).map(p => ({ ...p, volume24hUsd: 50_000_000 })) as [GeckoPool, GeckoPool];
  c.add([fresh]);
  c.add([lookalike], false);
  c.reset();
  const next = await discoverTrencherUniverse(c.client, grant, [fresh, lookalike, ...pools], { cache });
  for (const p of [fresh, lookalike]) {
    assert.deepEqual(c.readsOf(p).sort(), ["fee", "token0", "token1"].map(f => `${f}@${p.poolAddress!.toLowerCase()}`).sort(), `${p.name} was read from scratch`);
  }
  assert.equal(c.poolReads().filter(x => x.startsWith("getPool@")).length, 2, "and the factory was asked about both new pools");
  assert.ok(next.qualified.some(p => p.tokenAddress === fresh.tokenAddress), "the new canonical pool qualifies");
  assert.ok(!next.qualified.some(p => p.tokenAddress === lookalike.tokenAddress), "the look-alike does not");

  // A remembered pool the tape now attributes to a different coin: the cached
  // pair is checked against the claim, and the claim fails.
  const known = pools[0]!;
  const misattributed = { ...known, tokenAddress: `0x${"d".repeat(40)}` } as GeckoPool;
  c.reset();
  const claimed = await discoverTrencherUniverse(c.client, grant, [misattributed, ...pools.slice(1)], { cache });
  assert.deepEqual(c.readsOf(known), [], "the pool's facts came from the cache");
  assert.ok(!claimed.qualified.some(p => p.tokenAddress === misattributed.tokenAddress), "and a coin not in its pair is not admitted");

  // The canonical answer belongs to one factory.
  assert.ok(cache.verified(UNISWAP.v3Factory, known.poolAddress!));
  assert.equal(cache.verified(stranger, known.poolAddress!), undefined);
});

test("A HOLDINGS READ THAT FAILS STILL ABORTS THE PASS, however warm the cache", async (t) => {
  trustedHash(t);
  const c = chain();
  const pools = tape(5);
  c.add(pools);
  const cache = new TrencherPoolCache();
  c.s.tokens = [pools[0]!.tokenAddress];
  const warm = await discoverTrencherUniverse(c.client, grant, pools, { cache });
  assert.deepEqual(warm.held, [pools[0]!.tokenAddress]);

  c.s.tokens = new Error("RPC unavailable");
  await assert.rejects(discoverTrencherUniverse(c.client, grant, pools, { cache }), /RPC unavailable/,
    "a failed tokens() must never become an empty book");

  // Decimals are read fresh too: a held coin whose metadata no longer reads aborts.
  c.s.tokens = [pools[0]!.tokenAddress];
  c.s.decimals.set(pools[0]!.tokenAddress.toLowerCase(), new Error("metadata unavailable"));
  await assert.rejects(discoverTrencherUniverse(c.client, grant, pools, { cache }), /metadata unavailable/);

  // And a discovered coin that now reports an unsupported precision is dropped,
  // although its pool is remembered — the uncached pass would refuse it.
  c.s.decimals.clear();
  c.s.decimals.set(pools[1]!.tokenAddress.toLowerCase(), 40);
  const refused = await discoverTrencherUniverse(c.client, grant, pools, { cache });
  assert.ok(cache.verified(UNISWAP.v3Factory, pools[1]!.poolAddress!), "its pool is still a proved pool");
  assert.ok(!refused.tokens.some(x => x.address === pools[1]!.tokenAddress), "but the coin is not admitted");
});

test("CUSTODY IS RE-VERIFIED ON EVERY PASS, so a changed trust anchor stops a warm pass", async (t) => {
  trustedHash(t);
  const c = chain();
  const pools = tape(3);
  c.add(pools);
  const cache = new TrencherPoolCache();
  await discoverTrencherUniverse(c.client, grant, pools, { cache });
  c.reset();
  await discoverTrencherUniverse(c.client, grant, pools, { cache });
  for (const read of [`getCode@${factory}`, `getCode@${vault}`, `cash@${factory}`, `vaultFor@${factory}`, `owner@${vault}`, `VERSION@${vault}`]) {
    assert.ok(c.s.calls.includes(read), `${read} was skipped on a warm pass`);
  }
  process.env.TRENCHER_FACTORY_CODE_HASH = keccak256("0x6001");
  await assert.rejects(discoverTrencherUniverse(c.client, grant, pools, { cache }), /bytecode/);
});

test("A POOL THAT FAILED ONCE IS NOT TREATED AS VERIFIED", async (t) => {
  trustedHash(t);
  let clock = 1_000_000;
  const cache = new TrencherPoolCache({ now: () => clock });
  const c = chain();
  const [lookalike, wrongQuote, flaky] = tape(3);
  c.add([lookalike!], false);
  c.add([wrongQuote!, flaky!]);
  c.s.quote.set(wrongQuote!.poolAddress!.toLowerCase(), stranger); // paired with a coin that is not USDG or WETH
  c.s.failing.add(flaky!.poolAddress!.toLowerCase());
  const all = [lookalike!, wrongQuote!, flaky!];

  const first = await discoverTrencherUniverse(c.client, grant, all, { cache });
  assert.equal(first.qualified.length, 0);
  assert.equal(cache.size().verified, 0, "no refusal and no failed read is stored as a verification");
  for (const p of all) assert.equal(cache.verified(UNISWAP.v3Factory, p.poolAddress!), undefined, p.name);

  // Within the refusal window the chain's answers are not re-asked, and even a
  // chain that would now say yes does not admit them: nothing was proved.
  c.s.canonical.add(lookalike!.tokenAddress.toLowerCase());
  c.s.quote.delete(wrongQuote!.poolAddress!.toLowerCase());
  c.s.failing.delete(flaky!.poolAddress!.toLowerCase());
  c.reset();
  const second = await discoverTrencherUniverse(c.client, grant, all, { cache });
  assert.deepEqual(c.readsOf(lookalike!), [], "a definitive refusal is left alone for a while");
  assert.deepEqual(c.readsOf(wrongQuote!), []);
  assert.ok(!second.qualified.some(p => p.tokenAddress === lookalike!.tokenAddress || p.tokenAddress === wrongQuote!.tokenAddress));
  // A failed READ is not an answer: it is asked again on the very next pass,
  // and qualifies only by passing every check from scratch.
  assert.deepEqual(c.readsOf(flaky!).sort(), ["fee", "token0", "token1"].map(f => `${f}@${flaky!.poolAddress!.toLowerCase()}`).sort());
  assert.ok(c.s.calls.includes(`getPool@${UNISWAP.v3Factory.toLowerCase()}`));
  assert.ok(second.qualified.some(p => p.tokenAddress === flaky!.tokenAddress));

  // After the window, the refused pools are checked from scratch — the full
  // verification, not the old refusal and not a pass, decides.
  clock += POOL_REFUSAL_TTL_MS + 1;
  c.reset();
  const third = await discoverTrencherUniverse(c.client, grant, all, { cache });
  for (const p of [lookalike!, wrongQuote!]) {
    assert.equal(c.readsOf(p).length, 3, `${p.name} was re-read`);
    assert.ok(third.qualified.some(q => q.tokenAddress === p.tokenAddress), `${p.name} qualified on its own evidence`);
  }
});

test("the cache is bounded, oldest first", () => {
  const cache = new TrencherPoolCache({ maxEntries: 2 });
  const facts = { token0: CASH.USDG as `0x${string}`, token1: vault as `0x${string}`, fee: 3000 };
  cache.rememberVerified(factory, "0x01", facts);
  cache.rememberVerified(factory, "0x02", facts);
  cache.rememberVerified(factory, "0x03", facts);
  assert.equal(cache.verified(factory, "0x01"), undefined);
  assert.ok(cache.verified(factory, "0x02") && cache.verified(factory, "0x03"));
  assert.equal(cache.size().verified, 2);
});
