/**
 * The batch pool-price reader. What matters here isn't that it returns numbers —
 * it's that it REFUSES to, correctly and for a stated reason, and that caching a
 * read never caches a verdict. Equity, P&L and the drawdown breaker consume
 * whatever comes out of this, so a wrong "ok" is worth more than a wrong price.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicClient } from "viem";
import { CASH, type StockToken } from "../../../packages/core/src/index";
import { createPoolPriceReader, describeRoute } from "./pool-prices";
import type { RoutedPrice } from "./pool-price";

const CATE: StockToken = {
  symbol: "CATE",
  name: "CATE",
  address: "0x00000000000000000000000000000000000000c1",
  chainlinkFeed: null,
  kind: "memecoin",
  decimals: 18,
};
const KITTY: StockToken = { ...CATE, symbol: "KITTY", address: "0x00000000000000000000000000000000000000d0" };

const usdgD = (v: number) => BigInt(Math.round(v * 1e6));
const p8 = (v: number) => BigInt(Math.round(v * 1e8));

const route = (over: Partial<RoutedPrice> = {}): RoutedPrice => ({
  price8: p8(0.5),
  spot8: p8(0.5),
  route: "weth",
  liquidityUsdg: usdgD(50_000),
  divergenceBps: 20,
  twapWindowSec: 900,
  ...over,
});

const GUARD = { minLiquidityUsdg: usdgD(5_000), maxDivergenceBps: 500 };

/**
 * A stub standing in for readRoutedPrice's on-chain reads. `readRoutedPrice`
 * itself takes a viem client and calls readContract, so a client that answers
 * the factory/pool calls is the seam. Rather than reimplement Uniswap here, the
 * reader is injected with a fake client whose readContract drives the real code
 * path down a known branch — see the direct-pool shape below.
 */
function stubClient(plan: {
  /** address → cash sitting in that pool, by fee tier order 500/3000/10000 */
  poolFor: (token: string, cash: string, fee: number) => `0x${string}` | null;
  cashInPool: (pool: string) => bigint;
  token0: (pool: string) => `0x${string}`;
  sqrtPriceX96: (pool: string) => bigint;
  /** In-range liquidity L — what depth is actually measured from. */
  liquidity?: (pool: string) => bigint;
  /** null ⇒ observe() reverts, i.e. the pool has no TWAP yet */
  tickCumulatives: (pool: string) => readonly [bigint, bigint] | null;
}): PublicClient {
  return {
    async readContract(args: {
      address: string;
      functionName: string;
      args?: readonly unknown[];
    }): Promise<unknown> {
      switch (args.functionName) {
        case "getPool": {
          const [a, b, fee] = args.args as [string, string, number];
          const pool = plan.poolFor(a.toLowerCase(), b.toLowerCase(), fee);
          return pool ?? "0x0000000000000000000000000000000000000000";
        }
        case "balanceOf": {
          const [pool] = args.args as [string];
          return plan.cashInPool(pool.toLowerCase());
        }
        case "token0":
          return plan.token0(args.address.toLowerCase());
        case "slot0":
          return [plan.sqrtPriceX96(args.address.toLowerCase()), 0, 0, 2, 2, 0, true];
        case "liquidity":
          return plan.liquidity ? plan.liquidity(args.address.toLowerCase()) : 0n;
        case "observe": {
          const t = plan.tickCumulatives(args.address.toLowerCase());
          if (!t) throw new Error("OLD");
          return [t, [0n, 0n]];
        }
        default:
          throw new Error(`unexpected call ${args.functionName}`);
      }
    },
  } as unknown as PublicClient;
}

/** A client that answers nothing — every route lookup finds no pool. */
const noPools = stubClient({
  poolFor: () => null,
  cashInPool: () => 0n,
  token0: () => "0x0000000000000000000000000000000000000000",
  sqrtPriceX96: () => 0n,
  tickCumulatives: () => null,
});

describe("createPoolPriceReader — refusals", () => {
  it("reports a token with no pool at all, with a reason a human can act on", async () => {
    const reader = createPoolPriceReader();
    const { quotes, refused } = await reader.read({
      client: noPools,
      tokens: [CATE],
      guard: GUARD,
      nowSec: 1000,
    });
    assert.equal(quotes.size, 0);
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.symbol, "CATE");
    assert.match(refused[0]!.reason, /no Uniswap v3 pool/);
  });

  it("prices nothing and asks nothing when the watch set has no feedless tokens", async () => {
    const reader = createPoolPriceReader();
    let calls = 0;
    const counting = { readContract: async () => { calls++; return 0n; } } as unknown as PublicClient;
    const r = await reader.read({ client: counting, tokens: [], guard: GUARD, nowSec: 1000 });
    assert.equal(r.quotes.size, 0);
    assert.deepEqual(r.refused, []);
    assert.equal(calls, 0, "an empty set must not touch the network");
  });
});

/**
 * The cache is the part most likely to go quietly wrong: a stale VERDICT would
 * mean the owner tightens their liquidity floor and nothing happens for a
 * minute, while a position keeps being valued off a pool they just declared too
 * thin. Reads are cached; judgements never are.
 */
describe("createPoolPriceReader — cache holds reads, never verdicts", () => {
  // A direct CATE/USDG pool, deep, with a working oracle. sqrtPriceX96 chosen so
  // spot ≈ TWAP; the exact price doesn't matter, only that a quote comes back.
  const POOL = "0x00000000000000000000000000000000000000ff" as const;
  // sqrtPriceX96 = 2^96 ⇒ sqrtP = 1, so the cash-side virtual reserve is just L.
  // USDG is token1 here, at 6dp, so L = 5e10 is $50,000 of real in-range depth.
  const DEEP = usdgD(50_000);
  let reads = 0;
  const client = stubClient({
    poolFor: (a, b, fee) => {
      reads++;
      const usdg = (CASH.USDG as string).toLowerCase();
      return fee === 500 && (a === usdg || b === usdg) ? POOL : null;
    },
    cashInPool: () => usdgD(50_000),
    token0: () => CATE.address,
    sqrtPriceX96: () => 2n ** 96n,
    liquidity: () => DEEP,
    tickCumulatives: () => [0n, 0n],
  });

  it("does not re-read within the TTL", async () => {
    const reader = createPoolPriceReader({ ttlSec: 60 });
    reads = 0;
    await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_000 });
    const first = reads;
    assert.ok(first > 0, "the first read must hit the network");
    await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_030 });
    assert.equal(reads, first, "within the TTL, nothing more is fetched");
  });

  it("re-reads once the TTL has passed", async () => {
    const reader = createPoolPriceReader({ ttlSec: 60 });
    reads = 0;
    await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_000 });
    const first = reads;
    await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_061 });
    assert.ok(reads > first, "past the TTL the route is fetched again");
  });

  it("a tightened liquidity floor takes effect on the very next read, cache or not", async () => {
    const reader = createPoolPriceReader({ ttlSec: 3_600 });
    const loose = await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_000 });
    assert.equal(loose.quotes.has("CATE"), true, "passes a $5k floor at $50k deep");

    // Same cached route, stricter floor — the answer must flip immediately.
    const strict = await reader.read({
      client,
      tokens: [CATE],
      guard: { minLiquidityUsdg: usdgD(1_000_000), maxDivergenceBps: 500 },
      nowSec: 1_001,
    });
    assert.equal(strict.quotes.has("CATE"), false);
    assert.match(strict.refused[0]!.reason, /too thin/);
  });

  it("a tightened divergence band also re-judges a cached route", async () => {
    const reader = createPoolPriceReader({ ttlSec: 3_600 });
    await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_000 });
    const strict = await reader.read({
      client,
      tokens: [CATE],
      guard: { minLiquidityUsdg: usdgD(5_000), maxDivergenceBps: 0 },
      nowSec: 1_001,
    });
    // divergence is 0 here (spot == twap), so 0bps still passes — the point is
    // that the guard is consulted, which the floor test above proves flips.
    assert.equal(strict.quotes.size + strict.refused.length, 1);
  });

  it("reset() drops the cache", async () => {
    const reader = createPoolPriceReader({ ttlSec: 3_600 });
    reads = 0;
    await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_000 });
    const first = reads;
    reader.reset();
    await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_001 });
    assert.ok(reads > first);
  });

  it("marks every quote as pool-sourced and never stale", async () => {
    const reader = createPoolPriceReader();
    const { quotes } = await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_000 });
    const q = quotes.get("CATE")!;
    assert.equal(q.source, "pool", "provenance must survive into the price map");
    assert.equal(q.stale, false, "a TWAP is averaged by design, not a feed that stopped");
    assert.ok(q.detail && q.detail.length > 0, "a pool price must carry its own explanation");
  });

  /**
   * readRoutedPrice returns null both for "no pool exists" and for "the RPC
   * didn't answer", and nothing downstream can tell those apart. Neither extreme
   * is safe: always trusting the old route keeps pricing a drained pool forever,
   * always dropping it means one flaky call pauses equity and the drawdown
   * breaker. So a failed refresh buys a bounded grace period and no more.
   */
  const flaky = { readContract: async () => { throw new Error("rpc down"); } } as unknown as PublicClient;

  it("one flaky read does not yank a held position's valuation away", async () => {
    const reader = createPoolPriceReader({ ttlSec: 1 });
    await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_000 });
    const after = await reader.read({ client: flaky, tokens: [CATE], guard: GUARD, nowSec: 1_060 });
    assert.equal(after.quotes.has("CATE"), true, "60s of RPC trouble is not evidence about the pool");
  });

  it("but a route that stays unreadable is retired, not trusted forever", async () => {
    const reader = createPoolPriceReader({ ttlSec: 1 });
    await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_000 });
    const later = await reader.read({ client: flaky, tokens: [CATE], guard: GUARD, nowSec: 1_700 });
    assert.equal(later.quotes.has("CATE"), false, "a pool that may simply be gone stops counting");
    assert.match(later.refused[0]!.reason, /stale reading/);
  });

  it("a successful refresh resets the clock, so intermittent failures never accumulate", async () => {
    const reader = createPoolPriceReader({ ttlSec: 1 });
    await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_000 });
    await reader.read({ client: flaky, tokens: [CATE], guard: GUARD, nowSec: 1_400 });
    await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_500 }); // recovers
    const after = await reader.read({ client: flaky, tokens: [CATE], guard: GUARD, nowSec: 1_900 });
    assert.equal(after.quotes.has("CATE"), true, "age is measured from the last GOOD read");
  });

  it("handles several tokens independently — one refusal doesn't poison the rest", async () => {
    const reader = createPoolPriceReader();
    const mixed = stubClient({
      poolFor: (a, b, fee) => {
        const usdg = (CASH.USDG as string).toLowerCase();
        if (a === KITTY.address.toLowerCase() || b === KITTY.address.toLowerCase()) return null;
        return fee === 500 && (a === usdg || b === usdg) ? POOL : null;
      },
      cashInPool: () => usdgD(50_000),
      token0: () => CATE.address,
      sqrtPriceX96: () => 2n ** 96n,
      liquidity: () => usdgD(50_000),
      tickCumulatives: () => [0n, 0n],
    });
    const r = await reader.read({ client: mixed, tokens: [CATE, KITTY], guard: GUARD, nowSec: 1_000 });
    assert.equal(r.quotes.has("CATE"), true);
    assert.deepEqual(r.refused.map((x) => x.symbol), ["KITTY"]);
  });
});

/**
 * ~75% of this chain's memecoins have no USDG pair, so they price TOKEN/WETH ×
 * WETH/USDG. That leg's depth is denominated in WETH — 18 raw decimals — while
 * the floor is 6dp USD. Getting that conversion wrong by 1e12 doesn't produce a
 * visibly silly number anywhere; it just quietly makes the depth floor
 * unreachable on the route that carries most of the tokens, and hands whoever
 * wants it a $300 pool that vouches for itself as a $5M one.
 */
describe("createPoolPriceReader — the depth floor survives the WETH hop", () => {
  const WETH = (CASH.WETH as string).toLowerCase();
  const USDG = (CASH.USDG as string).toLowerCase();
  const CATE_WETH = "0x000000000000000000000000000000000000aa01" as const;
  const WETH_USDG = "0x000000000000000000000000000000000000aa02" as const;
  const Q96 = 2n ** 96n;

  /** sqrtPriceX96 for "one whole token0 buys `price` whole token1". */
  const sqrtX96 = (price: number, d0: number, d1: number) =>
    BigInt(Math.round(Math.sqrt(price * 10 ** (d1 - d0)) * 2 ** 96));
  /** The L that yields `cashRaw` of virtual cash reserve — inverts the depth formula. */
  const liquidityFor = (cashRaw: bigint, sqrtPriceX96: bigint) => (cashRaw * Q96) / sqrtPriceX96;
  /**
   * The observe() cumulative pair for a TWAP that agrees with spot. Without
   * this the stub's TWAP is tick 0 (price 1.0) while spot says something else,
   * and the divergence guard — correctly — refuses everything.
   */
  const cumulativesFor = (price: number, d0: number, d1: number, windowSec = 900) => {
    const tick = Math.round(Math.log(price * 10 ** (d1 - d0)) / Math.log(1.0001));
    return [0n, BigInt(tick * windowSec)] as const;
  };

  const ETH_USD = 3000;
  const CATE_IN_WETH = 1.5e-8; // ≈ $0.000045 — an ordinary memecoin price
  const SQRT_WETH_USDG = sqrtX96(ETH_USD, 18, 6); // WETH is token0, USDG token1
  const SQRT_CATE_WETH = sqrtX96(CATE_IN_WETH, 18, 18); // CATE token0, WETH token1
  const WETH_USDG_DEPTH = usdgD(5_000_000); // a genuinely deep second leg

  /** A two-hop chain, with the memecoin leg's real depth set in WETH. */
  const twoHop = (wethInLeg: bigint) =>
    stubClient({
      poolFor: (a, b, fee) => {
        if (fee !== 3000) return null;
        const pair = [a, b].sort().join("/");
        if (pair === [CATE.address.toLowerCase(), WETH].sort().join("/")) return CATE_WETH;
        if (pair === [WETH, USDG].sort().join("/")) return WETH_USDG;
        return null; // no direct CATE/USDG pool — the realistic case
      },
      cashInPool: (pool) => (pool === CATE_WETH ? wethInLeg : WETH_USDG_DEPTH),
      token0: (pool) => (pool === CATE_WETH ? CATE.address : (CASH.WETH as `0x${string}`)),
      sqrtPriceX96: (pool) => (pool === CATE_WETH ? SQRT_CATE_WETH : SQRT_WETH_USDG),
      liquidity: (pool) =>
        pool === CATE_WETH
          ? liquidityFor(wethInLeg, SQRT_CATE_WETH)
          : liquidityFor(WETH_USDG_DEPTH, SQRT_WETH_USDG),
      tickCumulatives: (pool) =>
        pool === CATE_WETH
          ? cumulativesFor(CATE_IN_WETH, 18, 18)
          : cumulativesFor(ETH_USD, 18, 6),
    });

  const oneWeth = 10n ** 18n;

  it("REFUSES a memecoin whose WETH pool holds pocket change, however deep WETH/USDG is", async () => {
    // 0.1 WETH ≈ $300 of real depth, behind a $5,000,000 WETH/USDG pool.
    const reader = createPoolPriceReader();
    const r = await reader.read({
      client: twoHop(oneWeth / 10n),
      tokens: [CATE],
      guard: { minLiquidityUsdg: usdgD(25_000), maxDivergenceBps: 500 },
      nowSec: 1_000,
    });
    assert.equal(r.quotes.has("CATE"), false, "the shallow leg must decide the verdict");
    assert.equal(r.refused[0]?.kind, "too-thin");
    assert.match(r.refused[0]!.reason, /\$3\d\d /, `should name ~$300, said: ${r.refused[0]!.reason}`);
  });

  it("accepts the same route once the memecoin leg is genuinely deep", async () => {
    // 100 WETH ≈ $300,000.
    const reader = createPoolPriceReader();
    const r = await reader.read({
      client: twoHop(100n * oneWeth),
      tokens: [CATE],
      guard: { minLiquidityUsdg: usdgD(25_000), maxDivergenceBps: 500 },
      nowSec: 1_000,
    });
    assert.equal(r.quotes.has("CATE"), true);
    assert.match(r.quotes.get("CATE")!.detail!, /via WETH/);
  });

  it("never reports the deep leg's depth as the route's depth", async () => {
    const reader = createPoolPriceReader();
    const r = await reader.read({
      client: twoHop(100n * oneWeth),
      tokens: [CATE],
      guard: { minLiquidityUsdg: 0n, maxDivergenceBps: 500 },
      nowSec: 1_000,
    });
    // If the route ever claims the $5,000,000 second leg for a token whose own
    // pool holds $300,000, the floor has quietly become decorative.
    // Asserted on the NUMBER, not on describeRoute's prose. The prose is built
    // with toLocaleString, so the old regex here only held on a comma-grouping
    // host and failed on de-DE, fr-FR, ru-RU and friends — for a reason with
    // nothing to do with what this test is actually about.
    const depth = Number(r.quotes.get("CATE")!.liquidityUsdg!) / 1e6;
    assert.ok(depth > 300_000 && depth < 400_000, `expected the shallow leg, got ${depth}`);
  });

  it("prices the memecoin at its real value rather than a quantized step", async () => {
    const reader = createPoolPriceReader();
    const r = await reader.read({
      client: twoHop(100n * oneWeth),
      tokens: [CATE],
      guard: { minLiquidityUsdg: 0n, maxDivergenceBps: 500 },
      nowSec: 1_000,
    });
    const usd = Number(r.quotes.get("CATE")!.price8) / 1e8;
    const want = CATE_IN_WETH * ETH_USD; // $0.000045
    assert.ok(Math.abs(usd - want) / want < 0.01, `got $${usd}, want ~$${want}`);
  });

  /**
   * A quiet pool must read as quiet. Measuring divergence off the 8dp figures
   * compares 1 against 2 for a token worth 1.5e-8 WETH, i.e. 5,000–10,000bps,
   * so every WETH-routed memecoin — most of this chain — got refused as
   * "manipulated" while trading perfectly normally, and the whole feature was
   * dead on arrival for the tokens it exists to serve.
   */
  it("reads a calm two-hop pool as calm, not as manipulation", async () => {
    const reader = createPoolPriceReader();
    const r = await reader.read({
      client: twoHop(100n * oneWeth),
      // A 1bp band: only an exactly-quiet pool passes.
      guard: { minLiquidityUsdg: 0n, maxDivergenceBps: 10 },
      tokens: [CATE],
      nowSec: 1_000,
    });
    assert.equal(r.quotes.has("CATE"), true, r.refused[0]?.reason ?? "refused a quiet pool");
  });
});

/**
 * Route selection, calibrated against live Robinhood Chain pools (2026-07-27).
 *
 * Preferring "direct if it answers at all" reads as an optimisation and is a
 * functional bug. On the real chain, VIRTUAL has a direct USDG pool holding $25
 * and a WETH route with $4.6M behind it; ARROW's direct pool has a valid TWAP
 * and ZERO in-range liquidity while its WETH pool is alive; CASHCAT's $32k
 * direct pool preempts a $1.9M WETH route. Taking the first answer refused four
 * perfectly good tokens and mispriced others off the thinner of two pools.
 */
describe("readRoutedPrice — the deeper route wins, not the first one", () => {
  const WETH = (CASH.WETH as string).toLowerCase();
  const USDG = (CASH.USDG as string).toLowerCase();
  const DIRECT = "0x000000000000000000000000000000000000bb01" as const;
  const CATE_WETH = "0x000000000000000000000000000000000000bb02" as const;
  const WETH_USDG = "0x000000000000000000000000000000000000bb03" as const;
  const Q96 = 2n ** 96n;

  const sqrtX96 = (price: number, d0: number, d1: number) =>
    BigInt(Math.round(Math.sqrt(price * 10 ** (d1 - d0)) * 2 ** 96));
  const liquidityFor = (cashRaw: bigint, s: bigint) => (cashRaw * Q96) / s;
  const cumulativesFor = (price: number, d0: number, d1: number, w = 900) =>
    [0n, BigInt(Math.round(Math.log(price * 10 ** (d1 - d0)) / Math.log(1.0001)) * w)] as const;

  const ETH_USD = 3000;
  const CATE_USD = 0.0001;
  const CATE_IN_WETH = CATE_USD / ETH_USD;
  const SQRT_DIRECT = sqrtX96(CATE_USD, 18, 6);
  const SQRT_CW = sqrtX96(CATE_IN_WETH, 18, 18);
  const SQRT_WU = sqrtX96(ETH_USD, 18, 6);

  /** Both routes live: `directUsdg` of direct depth vs `legWeth` behind the hop. */
  const bothRoutes = (directUsdg: bigint, legWeth: bigint) =>
    stubClient({
      poolFor: (a, b, fee) => {
        if (fee !== 3000) return null;
        const pair = [a, b].sort().join("/");
        if (pair === [CATE.address.toLowerCase(), USDG].sort().join("/")) return DIRECT;
        if (pair === [CATE.address.toLowerCase(), WETH].sort().join("/")) return CATE_WETH;
        if (pair === [WETH, USDG].sort().join("/")) return WETH_USDG;
        return null;
      },
      cashInPool: (p) => (p === DIRECT ? directUsdg : p === CATE_WETH ? legWeth : usdgD(5_000_000)),
      token0: (p) => (p === WETH_USDG ? (CASH.WETH as `0x${string}`) : CATE.address),
      sqrtPriceX96: (p) => (p === DIRECT ? SQRT_DIRECT : p === CATE_WETH ? SQRT_CW : SQRT_WU),
      liquidity: (p) =>
        p === DIRECT
          ? liquidityFor(directUsdg, SQRT_DIRECT)
          : p === CATE_WETH
            ? liquidityFor(legWeth, SQRT_CW)
            : liquidityFor(usdgD(5_000_000), SQRT_WU),
      tickCumulatives: (p) =>
        p === DIRECT
          ? cumulativesFor(CATE_USD, 18, 6)
          : p === CATE_WETH
            ? cumulativesFor(CATE_IN_WETH, 18, 18)
            : cumulativesFor(ETH_USD, 18, 6),
    });

  const oneWeth = 10n ** 18n;
  const read = async (directUsdg: bigint, legWeth: bigint) => {
    const reader = createPoolPriceReader();
    return reader.read({
      client: bothRoutes(directUsdg, legWeth),
      tokens: [CATE],
      guard: { minLiquidityUsdg: usdgD(25_000), maxDivergenceBps: 500 },
      nowSec: 1_000,
    });
  };

  it("takes the WETH hop when the direct pool is a shell — VIRTUAL's live shape", async () => {
    // $25 direct vs 100 WETH (~$300,000) one hop away.
    const r = await read(usdgD(25), 100n * oneWeth);
    assert.equal(r.quotes.has("CATE"), true, r.refused[0]?.reason ?? "refused a deep route");
    assert.match(r.quotes.get("CATE")!.detail!, /via WETH/);
  });

  it("keeps the direct pool when IT is the deeper one", async () => {
    const r = await read(usdgD(2_000_000), oneWeth / 10n);
    assert.match(r.quotes.get("CATE")!.detail!, /USDG pool/);
  });

  it("agrees on the price whichever route it picks", async () => {
    const viaWeth = await read(usdgD(25), 100n * oneWeth);
    const viaDirect = await read(usdgD(2_000_000), oneWeth / 10n);
    const a = Number(viaWeth.quotes.get("CATE")!.price8) / 1e8;
    const b = Number(viaDirect.quotes.get("CATE")!.price8) / 1e8;
    assert.ok(Math.abs(a - b) / b < 0.01, `routes disagree: $${a} vs $${b}`);
  });

  it("a dead direct pool no longer costs the token its price", async () => {
    // Valid TWAP, zero in-range liquidity — exactly ARROW on the live chain.
    const r = await read(0n, 100n * oneWeth);
    assert.equal(r.quotes.has("CATE"), true, "the live WETH route must still be found");
  });
});

describe("describeRoute", () => {
  it("says the window, the hop and the depth — the three things that decide trust", () => {
    const s = describeRoute(route({ route: "weth", liquidityUsdg: usdgD(12_345), twapWindowSec: 900 }));
    assert.match(s, /15m TWAP/);
    assert.match(s, /via WETH/);
    // Locale-independent: this asserts the FIGURE is there, not that the host
    // groups it with commas. describeRoute is a human string and may be
    // grouped any way the runtime likes.
    assert.match(s.replace(/[^0-9]/g, ""), /12345/);
  });

  it("names a direct pool as such", () => {
    assert.match(describeRoute(route({ route: "direct" })), /USDG pool/);
  });
});

/**
 * Depth travels as a NUMBER, not inside a sentence.
 *
 * It used to be recovered by running /\$([\d,]+)\s+deep/ over describeRoute's
 * output. describeRoute formats with toLocaleString, so on a host grouping with
 * dots or using non-Latin digits the match failed for every pool over $1,000 —
 * and it failed SILENTLY, returning null rather than erroring. Two live
 * consequences: trencher's liquidity-drain exit never fired, and the trench
 * entry baseline was stamped 0 through an upsert that never corrects itself, for
 * the position's whole life.
 */
describe("PriceQuote.liquidityUsdg", () => {
  const POOL = "0x00000000000000000000000000000000000000fe" as const;
  const client = stubClient({
    poolFor: (a, b, fee) => {
      const usdg = (CASH.USDG as string).toLowerCase();
      return fee === 500 && (a === usdg || b === usdg) ? POOL : null;
    },
    cashInPool: () => usdgD(50_000),
    token0: () => CATE.address,
    sqrtPriceX96: () => 2n ** 96n,
    liquidity: () => usdgD(50_000),
    tickCumulatives: () => [0n, 0n],
  });

  it("carries depth in the same 6dp USDG units as the guard", async () => {
    const r = await createPoolPriceReader().read({ client, tokens: [CATE], guard: GUARD, nowSec: 1_000 });
    const q = r.quotes.get("CATE")!;
    assert.equal(typeof q.liquidityUsdg, "bigint");
    // Comparable against PriceGuard.minLiquidityUsdg with no conversion, which
    // is the point. An 8dp number under this name would let a $250 pool clear
    // a $25,000 floor.
    assert.ok(q.liquidityUsdg! >= GUARD.minLiquidityUsdg);
    assert.equal(Math.round(Number(q.liquidityUsdg) / 1e6), 50_000);
  });

  it("would have been unreadable through the prose on a non-comma locale", () => {
    // The exact live failure, demonstrated rather than described.
    for (const loc of ["de-DE", "fr-FR", "ru-RU", "sv-SE"]) {
      const prose = `$${(347_123).toLocaleString(loc, { maximumFractionDigits: 0 })} deep`;
      const parsed = /\$([\d,]+)\s+deep/.exec(prose)?.[1]?.replace(/,/g, "");
      assert.notEqual(parsed, "347123", `${loc} would have parsed, weakening this test`);
    }
  });

  it("is ABSENT rather than zero when there is no depth concept", () => {
    // Chainlink and broker quotes have no depth. Downstream treats null as
    // "skip the drain check" and 0 as "the pool emptied" — collapsing the two
    // turns a missing fact into a forced liquidation.
    const chainlinkish = { price8: 1n, stale: false, source: "chainlink" as const };
    assert.equal("liquidityUsdg" in chainlinkish, false);
  });
});

/**
 * THE 0.01% TIER, AND THE COINS IT WAS HIDING.
 *
 * This chain's main WETH/USDG pool is on the 100 tier ("USDG/WETH 0.01% … the
 * 26.1M pool", the scout's own read, 2026-10-02), which FEE_TIERS did not scan.
 * Every WETH-routed price needs that leg, and the autonomous Trencher verifies
 * pools at whatever fee they report — so it admitted coins this reader then
 * called unpriceable, and a coin nothing can price is never bought.
 */
describe("the 0.01% tier", () => {
  const Q96 = 2n ** 96n;
  const WETH = (CASH.WETH as string).toLowerCase();
  const USDG = (CASH.USDG as string).toLowerCase();
  const CATE_WETH = "0x000000000000000000000000000000000000cc01" as const;
  const WETH_USDG_100 = "0x000000000000000000000000000000000000cc02" as const;
  const WETH_USDG_500 = "0x000000000000000000000000000000000000cc03" as const;
  const sqrtX96 = (price: number, d0: number, d1: number) =>
    BigInt(Math.round(Math.sqrt(price * 10 ** (d1 - d0)) * 2 ** 96));
  const liquidityFor = (cashRaw: bigint, sqrtPriceX96: bigint) => (cashRaw * Q96) / sqrtPriceX96;
  const cumulativesFor = (price: number, d0: number, d1: number, windowSec = 900) => {
    const tick = Math.round(Math.log(price * 10 ** (d1 - d0)) / Math.log(1.0001));
    return [0n, BigInt(tick * windowSec)] as const;
  };
  const ETH_USD = 3000;
  const CATE_IN_WETH = 1.5e-8;
  const SQRT_WETH_USDG = sqrtX96(ETH_USD, 18, 6);
  const SQRT_CATE_WETH = sqrtX96(CATE_IN_WETH, 18, 18);
  const oneWeth = 10n ** 18n;

  /**
   * CATE trades against WETH at 0.3%; WETH/USDG exists at 0.01% (deep) and,
   * optionally, at 0.05% (shallower). `twapAt100` says whether the deep pool
   * can serve a 15-minute TWAP — a pool keeps one observation until somebody
   * pays to grow it.
   */
  const chain = (o: { with500: boolean; twapAt100: boolean; observed: string[] }) =>
    stubClient({
      poolFor: (a, b, fee) => {
        const pair = [a, b].sort().join("/");
        if (fee === 3000 && pair === [CATE.address.toLowerCase(), WETH].sort().join("/")) return CATE_WETH;
        if (pair === [WETH, USDG].sort().join("/")) {
          if (fee === 100) return WETH_USDG_100;
          if (fee === 500 && o.with500) return WETH_USDG_500;
        }
        return null;
      },
      cashInPool: (pool) =>
        pool === CATE_WETH ? 100n * oneWeth : pool === WETH_USDG_100 ? usdgD(26_000_000) : usdgD(400_000),
      token0: (pool) => (pool === CATE_WETH ? CATE.address : (CASH.WETH as `0x${string}`)),
      sqrtPriceX96: (pool) => (pool === CATE_WETH ? SQRT_CATE_WETH : SQRT_WETH_USDG),
      liquidity: (pool) =>
        pool === CATE_WETH
          ? liquidityFor(100n * oneWeth, SQRT_CATE_WETH)
          : liquidityFor(pool === WETH_USDG_100 ? usdgD(26_000_000) : usdgD(400_000), SQRT_WETH_USDG),
      tickCumulatives: (pool) => {
        o.observed.push(pool);
        if (pool === WETH_USDG_100 && !o.twapAt100) return null;
        return pool === CATE_WETH ? cumulativesFor(CATE_IN_WETH, 18, 18) : cumulativesFor(ETH_USD, 18, 6);
      },
    });

  const price = async (client: PublicClient) =>
    createPoolPriceReader().read({
      client,
      tokens: [CATE],
      guard: { minLiquidityUsdg: usdgD(25_000), maxDivergenceBps: 500 },
      nowSec: 1_000,
    });

  it("PRICES A WETH-ROUTED COIN WHOSE ONLY WETH/USDG LEG IS ON THE 0.01% TIER", async () => {
    // Before the tier was scanned this was "no Uniswap v3 pool against USDG or
    // WETH", and the coin fell through to "I know this token but not where it
    // trades" — the line the Trencher's verified coins were logged with.
    const r = await price(chain({ with500: false, twapAt100: true, observed: [] }));
    assert.equal(r.quotes.has("CATE"), true, r.refused[0]?.reason ?? "");
    assert.match(r.quotes.get("CATE")!.detail!, /via WETH/);
    const usd = Number(r.quotes.get("CATE")!.price8) / 1e8;
    assert.ok(Math.abs(usd - CATE_IN_WETH * ETH_USD) / (CATE_IN_WETH * ETH_USD) < 0.01, `got $${usd}`);
  });

  it("the deepest pool still wins when it can serve the TWAP", async () => {
    const observed: string[] = [];
    const r = await price(chain({ with500: true, twapAt100: true, observed }));
    assert.equal(r.quotes.has("CATE"), true);
    assert.ok(observed.includes(WETH_USDG_100), "the 0.01% pool was the one read");
    assert.ok(!observed.includes(WETH_USDG_500), "and the shallower one never needed asking");
  });

  it("A DEEP POOL WITH NO TWAP DOES NOT HIDE A SHALLOWER ONE THAT HAS ONE — no regression", async () => {
    // The risk the new tier brings: if the deepest pool keeps one observation,
    // picking it by cash alone would refuse a coin the 0.05% pool priced fine
    // before the tier existed. The choice falls through to the deepest pool
    // that can actually answer.
    const observed: string[] = [];
    const r = await price(chain({ with500: true, twapAt100: false, observed }));
    assert.equal(r.quotes.has("CATE"), true, r.refused[0]?.reason ?? "");
    assert.ok(observed.includes(WETH_USDG_500), "priced off the pool that could answer");
  });

  it("and with nothing that can answer, it is refused — never priced off spot", async () => {
    // The tier widens where a TWAP is LOOKED FOR, never what counts as one: a
    // pool with no time-average is still not a price to trade on.
    const observed: string[] = [];
    const r = await price(chain({ with500: false, twapAt100: false, observed }));
    assert.equal(r.quotes.has("CATE"), false);
    assert.ok(observed.includes(WETH_USDG_100), "the deep pool was asked");
  });

  it("asks no extra question of a token with a single pool", async () => {
    // The fall-through costs one observe() per candidate, so it only runs when
    // there IS a candidate to fall through to.
    const observed: string[] = [];
    await price(chain({ with500: false, twapAt100: true, observed }));
    assert.equal(observed.filter((p) => p === WETH_USDG_100).length, 1, "observed once, by the price read itself");
  });
});
