/**
 * The sampled price for a pool too new to keep an oracle. What matters is when
 * a series is allowed to count as READY — it is the only thing a buy of such a
 * coin may be authorised by — and that the reader judges a sampled price with
 * the same depth floor and a spot-vs-average band, never off one reading.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicClient } from "viem";
import { CASH, type StockToken } from "../../../packages/core/src/index";
import { createPoolPriceReader, sampledDivergenceBps } from "./pool-prices";
import { readRoutedPrice } from "./pool-price";
import {
  SAMPLE_MAX_GAP_SEC,
  SAMPLE_MIN_COUNT,
  SAMPLE_MIN_SPAN_SEC,
  SAMPLE_WINDOW_SEC,
  SpotSampler,
} from "./spot-sampler";

const p8 = (v: number) => BigInt(Math.round(v * 1e8));
const usdgD = (v: number) => BigInt(Math.round(v * 1e6));
const sample = (atSec: number, price: number, depth = 50_000) => ({ atSec, price8: p8(price), liquidityUsdg: usdgD(depth) });

describe("SpotSampler — when a series counts", () => {
  it("is not ready on a single reading, and still prices at it", () => {
    const s = new SpotSampler();
    s.record("a", sample(1000, 2));
    const r = s.read("a", 1000)!;
    assert.equal(r.price8, p8(2));
    assert.equal(r.readings, 1);
    assert.equal(r.ready, false);
  });

  it("becomes ready only with enough readings over enough of the window", () => {
    const s = new SpotSampler();
    // Four readings 30s apart span 90s: enough readings, not enough time.
    for (let i = 0; i < SAMPLE_MIN_COUNT; i++) s.record("a", sample(1000 + i * 30, 1));
    assert.equal(s.read("a", 1090)!.ready, false);
    const t = new SpotSampler();
    // Three readings over 180s: enough time, not enough readings.
    for (const at of [1000, 1090, 1180]) t.record("b", sample(at, 1));
    assert.equal(t.read("b", 1180)!.ready, false);
    // Four over 180s on a 60s tick: ready.
    const u = new SpotSampler();
    for (const at of [1000, 1060, 1120, 1180]) u.record("c", sample(at, 1));
    const r = u.read("c", 1180)!;
    assert.equal(r.spanSec, SAMPLE_MIN_SPAN_SEC);
    assert.equal(r.ready, true);
  });

  it("averages by TIME, so a reading that held longer weighs more", () => {
    const s = new SpotSampler();
    s.record("a", sample(1000, 1)); // held 120s
    s.record("a", sample(1120, 3)); // held 60s, to now
    const r = s.read("a", 1180)!;
    // (1×120 + 3×60) / 180 = 1.6667
    assert.equal(r.price8, (p8(1) * 120n + p8(3) * 60n) / 180n);
    assert.equal(r.spot8, p8(3));
  });

  it("measures the newest reading against the series it joined", () => {
    const s = new SpotSampler();
    for (const at of [1000, 1060, 1120]) s.record("a", sample(at, 1));
    s.record("a", sample(1180, 1.3));
    const r = s.read("a", 1180)!;
    // Mean is 1 (the 1.3 reading has held for 0s), so spot sits 30% above it.
    assert.equal(r.price8, p8(1));
    assert.equal(r.divergenceBps, 3_000);
  });

  it("restarts the series across a gap, rather than averaging over a hole", () => {
    const s = new SpotSampler();
    for (const at of [1000, 1060, 1120, 1180]) s.record("a", sample(at, 1));
    const later = 1180 + SAMPLE_MAX_GAP_SEC + 1;
    s.record("a", sample(later, 5));
    const r = s.read("a", later)!;
    assert.equal(r.readings, 1);
    assert.equal(r.price8, p8(5));
    assert.equal(r.ready, false);
  });

  it("answers nothing once its newest reading is older than one gap", () => {
    const s = new SpotSampler();
    s.record("a", sample(1000, 1));
    assert.equal(s.read("a", 1000 + SAMPLE_MAX_GAP_SEC + 1), null);
    assert.equal(s.read("missing", 1000), null);
  });

  it("drops a reading that is not newer than the last one", () => {
    const s = new SpotSampler();
    s.record("a", sample(1000, 1));
    s.record("a", sample(1000, 9));
    s.record("a", sample(900, 9));
    assert.equal(s.read("a", 1000)!.price8, p8(1));
  });

  it("only averages what is inside the window", () => {
    const s = new SpotSampler();
    // A long-ago price, then the window's worth of a different one.
    s.record("a", sample(1000, 10));
    for (let at = 1100; at <= 1100 + SAMPLE_WINDOW_SEC + 60; at += 60) s.record("a", sample(at, 1));
    const now = 1100 + SAMPLE_WINDOW_SEC + 60;
    assert.equal(s.read("a", now)!.price8, p8(1));
  });
});

// ── the reader, end to end, against a stub chain ─────────────────────────

const CATE: StockToken = {
  symbol: "CATE",
  name: "CATE",
  address: "0x00000000000000000000000000000000000000c1",
  chainlinkFeed: null,
  kind: "memecoin",
  decimals: 18,
};
const POOL = "0x00000000000000000000000000000000000000ff" as const;
const GUARD = { minLiquidityUsdg: usdgD(25_000), maxDivergenceBps: 500 };

/**
 * A direct CATE/USDG pool on the 0.01% tier with NO oracle: observe() reverts
 * exactly as a cardinality-1 pool's does. sqrtPriceX96 = 2^96 × m, so price
 * scales with m²; depth L = 5e10 is $50,000 at m = 1.
 */
function freshPool(state: { m: number; liquidity?: bigint; oracle?: boolean }) {
  const calls: string[] = [];
  const client = {
    async readContract(args: { address: string; functionName: string; args?: readonly unknown[] }): Promise<unknown> {
      calls.push(args.functionName);
      switch (args.functionName) {
        case "getPool": {
          const [a, b, fee] = args.args as [string, string, number];
          const usdg = (CASH.USDG as string).toLowerCase();
          return fee === 100 && (a.toLowerCase() === usdg || b.toLowerCase() === usdg)
            ? POOL
            : "0x0000000000000000000000000000000000000000";
        }
        case "balanceOf":
          return usdgD(50_000);
        case "token0":
          return CATE.address;
        case "slot0":
          return [BigInt(Math.round(2 ** 96 * state.m)), 0, 0, 1, 1, 0, true];
        case "liquidity":
          return state.liquidity ?? usdgD(50_000);
        case "observe":
          if (!state.oracle) throw new Error("OLD");
          return [[0n, 0n], [0n, 0n]];
        default:
          throw new Error(`unexpected call ${args.functionName}`);
      }
    },
  } as unknown as PublicClient;
  return { client, calls };
}

describe("readRoutedPrice — a pool with no oracle", () => {
  it("is still null for a caller that did not ask for a spot route", async () => {
    const { client } = freshPool({ m: 1 });
    const r = await readRoutedPrice(client, {
      token: CATE.address, tokenDecimals: 18, cash: CASH.USDG as `0x${string}`, cashDecimals: 6, weth: CASH.WETH as `0x${string}`,
    });
    assert.equal(r, null);
  });

  it("comes back at its spot, flagged spot-only, for one that did", async () => {
    const { client } = freshPool({ m: 1 });
    const r = await readRoutedPrice(client, {
      token: CATE.address, tokenDecimals: 18, cash: CASH.USDG as `0x${string}`, cashDecimals: 6, weth: CASH.WETH as `0x${string}`,
      allowSpot: true,
    });
    assert.ok(r?.spotOnly, "a spot route must say so");
    assert.equal(r.spotOnly.pool, POOL);
    assert.equal(r.price8, r.spot8);
    assert.equal(r.liquidityUsdg, usdgD(50_000));
  });

  it("never replaces a route that has an oracle", async () => {
    const { client } = freshPool({ m: 1, oracle: true });
    const r = await readRoutedPrice(client, {
      token: CATE.address, tokenDecimals: 18, cash: CASH.USDG as `0x${string}`, cashDecimals: 6, weth: CASH.WETH as `0x${string}`,
      allowSpot: true,
    });
    assert.ok(r);
    assert.equal(r.spotOnly, undefined);
  });
});

describe("createPoolPriceReader — a sampled price", () => {
  it("values at once, is ready only after minutes, and re-reads without searching", async () => {
    const state = { m: 1 };
    const { client, calls } = freshPool(state);
    // A long TTL, so every read after the first is the two-call spot re-read.
    const reader = createPoolPriceReader({ ttlSec: 3_600 });
    const at = (nowSec: number) => reader.read({ client, tokens: [CATE], guard: GUARD, nowSec });

    const first = (await at(1000)).quotes.get("CATE");
    assert.equal(first?.source, "sampled");
    assert.equal(first?.sampled?.ready, false, "one reading values a holding and authorises nothing");
    const searches = calls.filter((c) => c === "getPool").length;

    await at(1060);
    await at(1120);
    const ready = (await at(1180)).quotes.get("CATE");
    assert.equal(ready?.sampled?.ready, true);
    assert.equal(ready?.sampled?.readings, 4);
    assert.match(ready!.detail!, /sampled spot \(4 readings\)/);
    assert.equal(calls.filter((c) => c === "getPool").length, searches, "a re-read must not search for the pool again");
  });

  it("refuses a reading that jumped away from its own series", async () => {
    const state = { m: 1 };
    const { client } = freshPool(state);
    const reader = createPoolPriceReader({ ttlSec: 3_600 });
    for (const nowSec of [1000, 1060, 1120]) await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec });
    // Price ∝ m², so m = 1.2 is +44% on the newest reading.
    state.m = 1.2;
    const { quotes, refused } = await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1180 });
    assert.equal(quotes.has("CATE"), false);
    assert.equal(refused[0]?.kind, "divergent");
    assert.match(refused[0]!.reason, /sampled average/);
  });

  it("allows a move inside twice the pool band", async () => {
    assert.equal(sampledDivergenceBps(GUARD), 1_000);
    const state = { m: 1 };
    const { client } = freshPool(state);
    const reader = createPoolPriceReader({ ttlSec: 3_600 });
    for (const nowSec of [1000, 1060, 1120]) await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec });
    state.m = Math.sqrt(1.08); // +8%: outside the 5% pool band, inside the 10% sampled one
    const { quotes } = await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1180 });
    assert.equal(quotes.get("CATE")?.source, "sampled");
  });

  it("holds a sampled price to the same depth floor as any pool", async () => {
    const { client } = freshPool({ m: 1, liquidity: usdgD(10_000) });
    const reader = createPoolPriceReader();
    const { quotes, refused } = await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1000 });
    assert.equal(quotes.size, 0);
    assert.equal(refused[0]?.kind, "too-thin");
  });

  it("does not call a new pool 'no pool' any more", async () => {
    const { client } = freshPool({ m: 1, liquidity: usdgD(10_000) });
    const { refused } = await createPoolPriceReader().read({ client, tokens: [CATE], guard: GUARD, nowSec: 1000 });
    assert.ok(refused.every((r) => r.kind !== "no-pool"), JSON.stringify(refused));
  });

  it("drops the series once the pool keeps an oracle of its own", async () => {
    const state = { m: 1, oracle: false };
    const { client } = freshPool(state);
    const reader = createPoolPriceReader({ ttlSec: 60 });
    await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1000 });
    state.oracle = true;
    const q = (await reader.read({ client, tokens: [CATE], guard: GUARD, nowSec: 1060 })).quotes.get("CATE");
    assert.equal(q?.source, "pool");
  });
});
