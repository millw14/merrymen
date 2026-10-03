/**
 * A COIN POSTED IN A TELEGRAM GROUP, SEEN FROM THE TRADING SIDE
 * (docs/tg-groups.md). What is pinned here:
 *
 *   - the quick look: every kind, cheapest reads first, one getCode on
 *     Robinhood Chain before any GeckoTerminal read (no code is `wallet`, which
 *     is what another chain's token is here) under its own allowance,
 *     `unknown` whenever a read fails (never `wallet`, never `no-pool`), a
 *     30-minute cache that the free checks still run in front of, and a
 *     per-process allowance of full looks;
 *   - the port: safe at any time, never throws, outcomes reach every
 *     subscriber;
 *   - the tick's seams: a nominated coin's buy still needs a fresh Brain BUY
 *     and then the group-entry claim, and a refused claim blocks that entry
 *     and nothing else;
 *   - the wiring in index.ts, read as source the way energy-wiring.test.ts
 *     reads it, because the order of those seams is the safety property.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { encodeAbiParameters, type PublicClient } from "viem";
import { CASH, MERRYMEN_TOKEN, STOCK_TOKENS, UNISWAP } from "../../packages/core/src/index";
import type { ShadowInputs, ShadowOutcome } from "./brain-shadow";
import { makeTrencher, TRENCHER_FAST, type Candidate } from "./strategies/trencher";
import { takeTick, type Snapshot } from "./strategies/types";
import type { CoinLook, CoinOutcome, TrencherReadiness } from "./telegram/tg-groups/types";
import {
  COIN_LOOK,
  chainTokenProbe,
  claimGroupEntry,
  createCoinLook,
  createTgCoinsPort,
  groupExitOf,
  reviewedDecisionOf,
  type CoinLookReaders,
  type TokenProbe,
} from "./tg-coin-look";
import { TrenchBrainReview } from "./trencher-brain";
import { NOMINATE, NominationBook, type NominationCounters } from "./trencher-nominate";
import { emptyGeckoBuckets, type GeckoPool } from "./venues/geckoterminal";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const NOW_SEC = Math.floor(NOW / 1000);
const COIN = "0x00000000000000000000000000000000000c0111";
const ACCOUNT = "0x000000000000000000000000000000000000acc1";
const VAULT = "0x000000000000000000000000000000000000fa17";

const gp = (over: Partial<GeckoPool> = {}): GeckoPool => ({
  poolId: "0x0000000000000000000000000000000000000011",
  poolAddress: "0x0000000000000000000000000000000000000011",
  tokenAddress: COIN,
  name: "FROGGY / WETH 1%",
  dex: "uniswap-v3-robinhood",
  priceUsd: 0.01,
  reserveUsd: 200_000,
  fdvUsd: 1_000_000,
  volume24hUsd: 500_000,
  change24hPct: 5,
  change1hPct: 1,
  buys24h: 100,
  sells24h: 80,
  buyers24h: 50,
  buckets: { ...emptyGeckoBuckets(), m5: { changePct: 2, volumeUsd: 1000, buys: 10, sells: 8, buyers: 9, sellers: 8 } },
  createdAt: NOW_SEC - 3600,
  ...over,
});
const V4_ID = `0x${"4".repeat(64)}`;
/** The chat side's bound on one look (telegram/tg-groups/coins.ts COIN_FLOW.lookMs). */
const COIN_FLOW_LOOK_MS = 10_000;

function readers(over: Partial<CoinLookReaders> = {}, clock = { t: NOW }) {
  const calls = { pools: 0, code: 0, probe: 0, curve: 0 };
  const r: CoinLookReaders = {
    own: () => [ACCOUNT, VAULT],
    held: () => null,
    tokenPools: async () => { calls.pools++; return [gp()]; },
    getCode: async () => { calls.code++; return "0x6000"; },
    probe: async () => { calls.probe++; return { pons: false, erc20: true }; },
    curveFor: async () => { calls.curve++; return null; },
    now: () => clock.t,
    ...over,
  };
  return { r, calls, clock };
}
/**
 * The classification alone: public research figures and which read answered
 * (`source`) have tests of their own below.
 */
function lookOf(r: CoinLookReaders): (address: string) => Promise<CoinLook> {
  const look = createCoinLook(r);
  return async (address) => {
    const { source: _source, research: _research, ...answer } = await look(address);
    return answer;
  };
}
const look1 = async (over: Partial<CoinLookReaders>, address = COIN) => lookOf(readers(over).r)(address);

describe("public research observations beside the quick look", () => {
  it("reports one actual pool's observations, not sums or invented values", async () => {
    const quiet = gp({ poolId: "0x0000000000000000000000000000000000000022", reserveUsd: 900_000, volume24hUsd: 50_000 });
    const look = createCoinLook(readers({ tokenPools: async () => [quiet, gp()] }).r);
    const result = await look(COIN);
    assert.equal(result.kind, "candidate");
    assert.deepEqual(result.research, {
      observedAtMs: NOW, source: "geckoterminal", priceUsd: 0.01,
      liquidityUsd: 200_000, fdvUsd: 1_000_000, volume24hUsd: 500_000,
      priceChange24hPct: 5, buys24h: 100, sells24h: 80, ageMinutes: 60,
    }, "facts come from the screened pool, not the larger quiet pool");
  });

  it("keeps source and observation time on cached data and a later holding", async () => {
    let held = false;
    const h = readers({ held: () => held ? { name: "FROGGY" } : null });
    const look = createCoinLook(h.r);
    const initial = await look(COIN);
    h.clock.t += 8 * 60_000;
    const cached = await look(COIN);
    assert.equal(cached.source, "cache");
    assert.deepEqual(cached.research, initial.research);
    held = true;
    const holding = await look(COIN);
    assert.equal(holding.kind, "held");
    assert.deepEqual(holding.research, initial.research);
    assert.deepEqual(h.calls, { pools: 1, code: 1, probe: 0, curve: 0 }, "no new reads just to answer the holding");
    h.clock.t += COIN_LOOK.cacheMs;
    const refreshed = await look(COIN);
    assert.equal(refreshed.kind, "held");
    assert.equal(refreshed.research?.observedAtMs, h.clock.t, "an expired holding snapshot is refreshed, not relabelled fresh");
    assert.deepEqual(h.calls, { pools: 2, code: 1, probe: 0, curve: 0 }, "holding refresh reads only the public index");
  });

  it("a holding after restart gets one shared public read and remains held", async () => {
    let finish!: (pools: GeckoPool[]) => void;
    let pools = 0;
    const h = readers({ held: () => ({ name: "FROGGY" }), tokenPools: () => {
      pools++;
      return new Promise<GeckoPool[]>((resolve) => { finish = resolve; });
    } });
    const look = createCoinLook(h.r);
    const first = look(COIN), second = look(COIN);
    await setImmediate();
    assert.equal(pools, 1, "concurrent holding questions share the same read");
    finish([gp()]);
    const results = await Promise.all([first, second]);
    for (const result of results) {
      assert.equal(result.kind, "held", "public screening cannot nominate a held coin");
      assert.equal(result.research?.liquidityUsd, 200_000);
    }
    assert.deepEqual(h.calls, { pools: 0, code: 0, probe: 0, curve: 0 });
    await look(COIN);
    assert.equal(pools, 1, "the dated market snapshot is cached");
  });

  it("holding refresh failures retain held authority and spend the existing full-look allowance", async () => {
    const h = readers({ held: () => ({ name: "FROGGY" }), tokenPools: async () => {
      h.calls.pools++;
      return null;
    } });
    const look = createCoinLook(h.r);
    for (let i = 0; i < COIN_LOOK.maxUncached + 2; i++) {
      const result = await look(`0x${(0xc0111 + i).toString(16).padStart(40, "0")}`);
      assert.equal(result.kind, "held");
      assert.equal(result.research, undefined);
    }
    assert.equal(h.calls.pools, COIN_LOOK.maxUncached);
    assert.equal(h.calls.code + h.calls.probe + h.calls.curve, 0, "no chain calls for holdings");
  });

  it("a sold holding cannot persist as cached held authority", async () => {
    let held = true;
    let finish!: (pools: GeckoPool[]) => void;
    const h = readers({ held: () => held ? { name: "FROGGY" } : null, tokenPools: () => new Promise<GeckoPool[]>((resolve) => { finish = resolve; }) });
    const look = createCoinLook(h.r);
    const pending = look(COIN);
    await setImmediate();
    held = false;
    finish([gp()]);
    assert.equal((await pending).kind, "candidate", "delivery rechecks whether the coin is still held");
    assert.equal((await look(COIN)).kind, "candidate", "the cache stores only the public screen");
  });

  it("missing, invalid and future index figures stay absent, never zero", async () => {
    const pool = gp({ priceUsd: Number.NaN, reserveUsd: null, fdvUsd: -1,
      volume24hUsd: Number.POSITIVE_INFINITY, change24hPct: -101,
      buys24h: -1, sells24h: 2.5, createdAt: NOW_SEC + 1 });
    const result = await createCoinLook(readers({ tokenPools: async () => [pool] }).r)(COIN);
    assert.deepEqual(result.research, { observedAtMs: NOW, source: "geckoterminal" });
    assert.notEqual(result.kind, "candidate");
  });

  it("unreadable indexes, other-chain addresses and free wallet checks have no market snapshot", async () => {
    const down = createCoinLook(readers({ tokenPools: async () => null }).r);
    assert.equal((await down(COIN)).research, undefined);
    assert.equal((await down(ACCOUNT)).research, undefined);
    const wallet = createCoinLook(readers({ getCode: async () => "0x" }).r);
    assert.equal((await wallet(COIN)).research, undefined);
  });
});

describe("the quick look: every kind, cheapest first", () => {
  it("answers its own money, cash, energy and stocks with no read; holdings only refresh the public index", async () => {
    const { r, calls } = readers({ held: (a) => (a === COIN ? { name: "FROGGY" } : null) });
    const look = lookOf(r);
    assert.deepEqual(await look(ACCOUNT.toUpperCase().replace("0X", "0x")), { kind: "own" });
    assert.deepEqual(await look(VAULT), { kind: "own" });
    assert.deepEqual(await look(CASH.USDG), { kind: "cash", name: "USDG" });
    assert.deepEqual(await look(CASH.WETH), { kind: "cash", name: "WETH" });
    assert.deepEqual(await look(MERRYMEN_TOKEN.address), { kind: "energy" });
    const stock = STOCK_TOKENS[0]!;
    assert.deepEqual(await look(stock.address), { kind: "stock", name: stock.symbol }, "a stock goes by its ticker");
    assert.deepEqual(calls, { pools: 0, code: 0, probe: 0, curve: 0 }, "protected addresses never perform market research");
    assert.deepEqual(await look(COIN), { kind: "held", name: "FROGGY" });
    assert.deepEqual(calls, { pools: 1, code: 0, probe: 0, curve: 0 });
  });

  it("a v3 pool that clears the tape screen and shouldEnter(TRENCHER_FAST) is a candidate, named by its pool label", async () => {
    assert.deepEqual(await look1({ tokenPools: async () => [gp()] }), { kind: "candidate", name: "FROGGY" });
  });

  it("names which bound refused: quiet, thin, small, new", async () => {
    assert.equal((await look1({ tokenPools: async () => [gp({ volume24hUsd: 50_000 })] })).kind, "too-quiet");
    assert.equal((await look1({ tokenPools: async () => [gp({ sells24h: 0 })] })).kind, "too-quiet", "one-sided flow is quiet");
    assert.equal((await look1({ tokenPools: async () => [gp({ reserveUsd: TRENCHER_FAST.minLiquidityUsd - 1 })] })).kind, "too-thin");
    assert.equal((await look1({ tokenPools: async () => [gp({ fdvUsd: TRENCHER_FAST.minFdvUsd - 1 })] })).kind, "too-thin");
    assert.equal((await look1({ tokenPools: async () => [gp({ createdAt: NOW_SEC - 60 })] })).kind, "too-new");
    // The busiest v3 pool is the one judged, whatever else trades.
    assert.equal((await look1({ tokenPools: async () => [gp({ volume24hUsd: 50_000, poolAddress: "0x0000000000000000000000000000000000000022" }), gp()] })).kind, "candidate");
  });

  it("a figure the index left out is a look that could not be made", async () => {
    for (const over of [{ fdvUsd: null }, { reserveUsd: null }, { createdAt: null }, { createdAt: NOW_SEC + 3600 }]) {
      assert.equal((await look1({ tokenPools: async () => [gp(over)] })).kind, "unknown", JSON.stringify(over));
    }
  });

  it("venues trencher v1 cannot buy: the curve, v4-only, and no v3 pool at all", async () => {
    assert.equal((await look1({ tokenPools: async () => [gp({ dex: "pons-v2", poolAddress: null, poolId: V4_ID })] })).kind, "curve");
    const v4 = await look1({ tokenPools: async () => [gp({ dex: "uniswap-v4-robinhood", poolAddress: null, poolId: V4_ID }), gp({ dex: "pons-v2-dex", poolAddress: null, poolId: V4_ID })] });
    assert.deepEqual(v4, { kind: "v4-only", name: "FROGGY" });
    assert.equal((await look1({ tokenPools: async () => [gp({ dex: "uniswap-v2-robinhood" })] })).kind, "no-pool");
    // A "v3" row with no pool contract is a v4-style id and does not count as v3.
    assert.equal((await look1({ tokenPools: async () => [gp({ poolAddress: null, poolId: V4_ID })] })).kind, "v4-only");
  });

  it("the presence probe comes first: no code on Robinhood Chain is a wallet, from one getCode and nothing else", async () => {
    // An Ethereum, BNB or Base token has the same 0x + 40 hex and nothing deployed at it here.
    for (const code of [undefined, "0x", ""]) {
      const h = readers({ getCode: async () => { h.calls.code++; return code; } });
      assert.deepEqual(await lookOf(h.r)(COIN), { kind: "wallet" }, String(code));
      assert.deepEqual(h.calls, { pools: 0, code: 1, probe: 0, curve: 0 }, "GeckoTerminal, the ledger and the multicall are never asked");
    }
    // Code found: the full look goes on, and GeckoTerminal decides.
    const found = readers();
    assert.equal((await lookOf(found.r)(COIN)).kind, "candidate");
    assert.deepEqual(found.calls, { pools: 1, code: 1, probe: 0, curve: 0 });
  });

  it("no pool known: one probe decides curve, token or not a token", async () => {
    const none = async () => [] as GeckoPool[];
    assert.equal((await look1({ tokenPools: none, probe: async () => ({ pons: true, erc20: true }) })).kind, "curve");
    assert.equal((await look1({ tokenPools: none, probe: async () => ({ pons: false, erc20: true }) })).kind, "no-pool");
    assert.equal((await look1({ tokenPools: none, probe: async () => ({ pons: false, erc20: false }) })).kind, "not-token");
    // Pools where the coin is only the QUOTE side are not its pools.
    assert.equal((await look1({ tokenPools: async () => [gp({ tokenAddress: "0x00000000000000000000000000000000000d0222" })] })).kind, "no-pool");
  });

  it("local curve provenance answers before the multicall probe", async () => {
    const h = readers({ tokenPools: async () => [], curveFor: async () => ({ curve: "0x1" }) });
    assert.deepEqual(await lookOf(h.r)(COIN), { kind: "curve" });
    assert.equal(h.calls.probe, 0);
    assert.equal(h.calls.code, 1, "only the presence probe");
    // A ledger that cannot be read is not a verdict: the chain is asked.
    assert.equal((await look1({ tokenPools: async () => [], curveFor: async () => { throw new Error("db"); } })).kind, "no-pool");
  });

  it("UNREADABLE IS NOT ABSENT: every failed read is unknown, never wallet or no-pool", async () => {
    assert.equal((await look1({ tokenPools: async () => null })).kind, "unknown");
    assert.equal((await look1({ tokenPools: async () => { throw new Error("gecko"); } })).kind, "unknown");
    assert.equal((await look1({ tokenPools: async () => [], probe: async () => null })).kind, "unknown", "a failed probe is not no-pool");
    assert.equal((await look1({ tokenPools: async () => [], probe: async () => { throw new Error("rpc"); } })).kind, "unknown");
    assert.equal((await look1({ own: () => { throw new Error("no grant"); } })).kind, "unknown", "never throws");
    const noPools = readers({ tokenPools: async () => null });
    await lookOf(noPools.r)(COIN);
    assert.equal(noPools.calls.probe, 0, "a failed index read does not fall through to the probe");
  });

  it("UNREADABLE IS NOT ABSENT: a presence probe that failed is never a wallet; with nothing on the index either it is unknown, and not cached", async () => {
    let fail = true;
    const h = readers({
      getCode: async () => { h.calls.code++; if (fail) throw new Error("rpc"); return "0x6000"; },
      tokenPools: async () => { h.calls.pools++; return fail ? [] : [gp()]; },
    });
    const look = lookOf(h.r);
    assert.deepEqual(await look(COIN), { kind: "unknown" }, "no pools on the index: a wallet, another chain's token and a coin nobody traded look alike");
    assert.deepEqual(h.calls, { pools: 1, code: 1, probe: 0, curve: 0 }, "the multicall reads the chain that just failed: not tried");
    fail = false;
    assert.equal((await look(COIN)).kind, "candidate", "not cached: the next look can succeed");
    assert.equal(h.calls.code, 2);
  });

  it("anything that is not an address is unknown, and nothing is read for it", async () => {
    const { r, calls } = readers();
    const look = lookOf(r);
    for (const bad of ["", "0x1234", `0x${"a".repeat(64)}`, `0x${"0".repeat(40)}`, `0x${"g".repeat(40)}`, undefined as unknown as string]) {
      assert.deepEqual(await look(bad), { kind: "unknown" });
    }
    assert.equal(calls.pools, 0);
  });

  it("a name is never address-shaped and never borrows a trusted ticker", async () => {
    for (const name of ["0xdeadbeef / WETH", `T${COIN.slice(-11).toUpperCase()} / WETH`, "TSLA / WETH", "usdg / WETH", "$$$ / WETH"]) {
      const l = await look1({ tokenPools: async () => [gp({ name })] });
      assert.equal(l.kind, "candidate");
      assert.equal(l.name, undefined, name);
    }
    assert.deepEqual(await look1({ held: () => ({ name: "NVDA" }) }), { kind: "held" });
  });
});

describe("the quick look when the chain cannot be asked: GeckoTerminal's Robinhood page stands in", () => {
  // Declined by the governor, rate-limited by the provider, or no answer:
  // what the fleet's reads looked like the day a Pons coin went unanswered.
  const declined = async (): Promise<string | undefined> => {
    throw new Error("rpc declined by the governor");
  };
  const PONS_POOL = (over: Partial<GeckoPool> = {}) => gp({ dex: "pons-v2", poolAddress: null, poolId: V4_ID, name: "APPSHARE / WETH", ...over });

  it("a failed getCode with this coin's pools on the index: a Robinhood Chain coin, classified from those pools", async () => {
    const h = readers({ getCode: declined, tokenPools: async () => { h.calls.pools++; return [PONS_POOL()]; } });
    assert.deepEqual(await lookOf(h.r)(COIN), { kind: "curve", name: "APPSHARE" }, "a Pons bonding-curve coin");
    assert.deepEqual(h.calls, { pools: 1, code: 0, probe: 0, curve: 0 });
    for (const [pools, want] of [
      [[gp({ dex: "uniswap-v4-robinhood", poolAddress: null, poolId: V4_ID })], "v4-only"],
      [[gp()], "candidate"],
      [[gp({ volume24hUsd: 50_000 })], "too-quiet"],
      [[gp({ reserveUsd: TRENCHER_FAST.minLiquidityUsd - 1 })], "too-thin"],
      [[gp({ createdAt: NOW_SEC - 60 })], "too-new"],
      [[gp({ dex: "uniswap-v2-robinhood" })], "no-pool"],
      [[gp({ fdvUsd: null })], "unknown"],
    ] as const) {
      assert.equal((await look1({ getCode: declined, tokenPools: async () => [...pools] })).kind, want, want);
    }
  });

  it("a candidate from the index alone is only that: the port still only nominates, and nothing is relaxed", async () => {
    // The look answers the chat side; discovery still verifies the pool on
    // chain before anything can be bought (trencher-discovery.ts), and the
    // Brain, shouldEnter and the wall still decide. Here: the same
    // classification a healthy chain gives, from the same pools.
    const healthy = await look1({ tokenPools: async () => [gp()] });
    const degraded = await look1({ getCode: declined, tokenPools: async () => [gp()] });
    assert.deepEqual(degraded, healthy);
  });

  it("no pools on the index, only pools against it, or the index failing too: unknown, never a wallet", async () => {
    assert.deepEqual(await look1({ getCode: declined, tokenPools: async () => [] }), { kind: "unknown" });
    assert.deepEqual(await look1({ getCode: declined, tokenPools: async () => [gp({ tokenAddress: "0x00000000000000000000000000000000000d0222" })] }), { kind: "unknown" }, "a pool where it is only the quote side is not its pool");
    assert.deepEqual(await look1({ getCode: declined, tokenPools: async () => null }), { kind: "unknown" });
    assert.deepEqual(await look1({ getCode: declined, tokenPools: async () => { throw new Error("gecko"); } }), { kind: "unknown" });
  });

  it("a definite answer from the index is cached; the presence probe is spent from its own allowance, the page from the full looks'", async () => {
    const clock = { t: NOW };
    const h = readers({ getCode: async () => { h.calls.code++; throw new Error("rate limited"); }, tokenPools: async () => { h.calls.pools++; return [PONS_POOL()]; } }, clock);
    const look = lookOf(h.r);
    assert.equal((await look(COIN)).kind, "curve");
    assert.equal((await look(COIN)).kind, "curve");
    assert.deepEqual(h.calls, { pools: 1, code: 1, probe: 0, curve: 0 }, "the second look is the cache's");
    // Other chains' CAs while the chain is down: each one a probe AND a page, bounded by the full looks.
    const eth = (i: number) => `0x${(0xe7e000 + i).toString(16).padStart(40, "0")}`;
    const g = readers({ getCode: declined, tokenPools: async () => { g.calls.pools++; return []; } }, clock);
    const other = lookOf(g.r);
    for (let i = 0; i < COIN_LOOK.maxUncached; i++) assert.equal((await other(eth(i))).kind, "unknown");
    assert.equal(g.calls.pools, COIN_LOOK.maxUncached);
    assert.deepEqual(await other(eth(99)), { kind: "unknown" });
    assert.equal(g.calls.pools, COIN_LOOK.maxUncached, "past the full-look allowance, not one more GeckoTerminal read");
  });
});

describe("the quick look when GeckoTerminal's page cannot be read: DexScreener's Robinhood pairs stand in", () => {
  // GeckoTerminal's quota is the fleet's: in a cooldown every page read fails
  // at once. That, with the chain's reads declined, is how a coin with six
  // figures of liquidity read as `unknown` and got silence.
  const cooldown = async (): Promise<GeckoPool[] | null> => null;
  const declined = async (): Promise<string | undefined> => {
    throw new Error("rpc declined by the governor");
  };
  /** A DexScreener pair as venues/dexscreener.ts maps it: no distinct-buyer count. */
  const dx = (over: Partial<GeckoPool> = {}): GeckoPool => gp({ name: "VRAX / WETH", buyers24h: null, buckets: { ...emptyGeckoBuckets(), m5: { changePct: 1, volumeUsd: 1500, buys: 12, sells: 9, buyers: null, sellers: null } }, ...over });
  const dexReader = (pools: GeckoPool[] | null | (() => Promise<GeckoPool[] | null>)) => {
    const calls = { dex: 0 };
    const dexPairs = async (): Promise<GeckoPool[] | null> => {
      calls.dex++;
      return typeof pools === "function" ? pools() : pools;
    };
    return { calls, dexPairs };
  };

  it("the page failing with the chain healthy: DexScreener's pairs, classified by the same rules", async () => {
    const d = dexReader([dx()]);
    const h = readers({ tokenPools: cooldown, dexPairs: d.dexPairs });
    const { research, ...answer } = await createCoinLook(h.r)(COIN);
    assert.deepEqual(answer, { kind: "candidate", name: "VRAX", source: "dexscreener" });
    assert.equal(research?.source, "dexscreener");
    assert.equal(d.calls.dex, 1);
    assert.equal(h.calls.probe, 0, "never the probe: it cannot tell no pool from an index that is down");
  });

  it("the chain AND the page failing (the day it went silent): DexScreener still shows the Robinhood coin", async () => {
    const d = dexReader([dx()]);
    const h = readers({ getCode: declined, tokenPools: cooldown, dexPairs: d.dexPairs });
    const { research, ...answer } = await createCoinLook(h.r)(COIN);
    assert.deepEqual(answer, { kind: "candidate", name: "VRAX", source: "dexscreener" });
    assert.equal(research?.source, "dexscreener");
    // …and with the chain down, a page that answered but listed nothing gets DexScreener's word too.
    const e = dexReader([dx()]);
    const g = readers({ getCode: declined, tokenPools: async () => [], dexPairs: e.dexPairs });
    assert.equal((await createCoinLook(g.r)(COIN)).source, "dexscreener");
  });

  it("the same rules: quiet, thin, new, v4 only, a figure left out — only the distinct-buyer count it does not publish is not held against it; a pair it cannot place is unknown, never no-pool", async () => {
    for (const [pools, want] of [
      [[dx()], "candidate"],
      [[dx({ volume24hUsd: 50_000 })], "too-quiet"],
      [[dx({ sells24h: 0 })], "too-quiet"],
      [[dx({ buckets: emptyGeckoBuckets() })], "too-quiet"],
      [[dx({ reserveUsd: TRENCHER_FAST.minLiquidityUsd - 1 })], "too-thin"],
      [[dx({ createdAt: NOW_SEC - 60 })], "too-new"],
      [[dx({ dex: "uniswap-robinhood" })], "unknown"],
      [[dx({ dex: "pons-robinhood", poolAddress: null, poolId: V4_ID })], "unknown"],
      [[dx({ dex: "uniswap-v4-robinhood", poolAddress: null, poolId: V4_ID })], "v4-only"],
      [[dx({ fdvUsd: null })], "unknown"],
    ] as const) {
      const d = dexReader([...pools]);
      assert.equal((await look1({ tokenPools: cooldown, dexPairs: d.dexPairs })).kind, want, want);
    }
    // A pool that does publish its buyers is screened on them as ever.
    const counted = dexReader([dx({ buyers24h: 3 })]);
    assert.equal((await look1({ tokenPools: cooldown, dexPairs: counted.dexPairs })).kind, "too-quiet");
  });

  it("GeckoTerminal answering in time, chain up or down: DexScreener is not asked", async () => {
    const d = dexReader([dx()]);
    const l = await createCoinLook(readers({ dexPairs: d.dexPairs }).r)(COIN);
    assert.equal(l.source, "geckoterminal");
    assert.equal(d.calls.dex, 0);
    const e = dexReader([dx()]);
    const probed = readers({ tokenPools: async () => [], dexPairs: e.dexPairs });
    assert.equal((await createCoinLook(probed.r)(COIN)).kind, "no-pool", "the chain answers a page that lists nothing");
    assert.equal(e.calls.dex, 0);
    const f = dexReader([dx()]);
    const down = readers({ getCode: declined, dexPairs: f.dexPairs });
    assert.equal((await createCoinLook(down.r)(COIN)).source, "geckoterminal");
    assert.equal(f.calls.dex, 0, "the chain down, the page answering: its answer");
  });

  describe("inside the chat side's ten seconds, whatever hangs", () => {
    /** Run a look on mocked timers: when it settled, in virtual ms, and what it said. */
    const timed = async (over: Partial<CoinLookReaders>): Promise<{ ms: number; look: CoinLook | undefined }> => {
      mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      try {
        const look = createCoinLook(readers(over).r);
        let got: CoinLook | undefined;
        let at = -1;
        void look(COIN).then((l) => {
          got = l;
          at = Date.now();
        });
        for (let t = 0; t < 20_000 && got === undefined; t += 100) {
          for (let i = 0; i < 5; i++) await setImmediate();
          mock.timers.tick(100);
        }
        for (let i = 0; i < 5 && got === undefined; i++) await setImmediate();
        return { ms: at, look: got };
      } finally {
        mock.timers.reset();
      }
    };
    const after = <T>(ms: number, v: T) => () => new Promise<T>((r) => setTimeout(() => r(v), ms));
    const never = <T>() => () => new Promise<T>(() => {});

    it("the chain answering slowly and the page never: DexScreener is asked beside the page, not after it", async () => {
      const r = await timed({ getCode: after(COIN_LOOK.readMs - 100, "0x6000"), tokenPools: never(), dexPairs: after(COIN_LOOK.dexMs - 100, [dx()]) });
      assert.equal(r.look?.source, "dexscreener");
      assert.equal(r.look?.kind, "candidate");
      assert.ok(r.ms < COIN_FLOW_LOOK_MS, `${r.ms} ms`);
    });

    it("the chain timing out and the page never answering: the same", async () => {
      const r = await timed({ getCode: never(), tokenPools: never(), dexPairs: after(COIN_LOOK.dexMs - 100, [dx()]) });
      assert.equal(r.look?.source, "dexscreener");
      assert.ok(r.ms < COIN_FLOW_LOOK_MS, `${r.ms} ms`);
    });

    it("everything hanging: unknown, inside the bound", async () => {
      const r = await timed({ getCode: never(), tokenPools: never(), dexPairs: never() });
      assert.deepEqual(r.look, { kind: "unknown" });
      assert.ok(r.ms < COIN_FLOW_LOOK_MS, `${r.ms} ms`);
    });

    it("a page slower than the head start but answering in time: its answer, not DexScreener's", async () => {
      const f = dexReader([dx({ reserveUsd: TRENCHER_FAST.minLiquidityUsd - 1 })]);
      const r = await timed({ tokenPools: after(COIN_LOOK.dexAfterMs + 500, [gp()]), dexPairs: f.dexPairs });
      const { research, ...answer } = r.look!;
      assert.deepEqual(answer, { kind: "candidate", name: "FROGGY", source: "geckoterminal" });
      assert.equal(research?.source, "geckoterminal");
      assert.equal(f.calls.dex, 1, "asked beside the slow page, and not used");
    });
  });

  it("DexScreener listing nothing, failing, or listing only other tokens: unknown, never no-pool, never cached", async () => {
    for (const pools of [[], null, [dx({ tokenAddress: "0x00000000000000000000000000000000000d0222" })]] as const) {
      const d = dexReader(pools === null ? null : [...pools]);
      assert.deepEqual(await look1({ tokenPools: cooldown, dexPairs: d.dexPairs }), { kind: "unknown" });
    }
    const thrown = dexReader(async () => {
      throw new Error("dexscreener 429");
    });
    assert.deepEqual(await look1({ getCode: declined, tokenPools: cooldown, dexPairs: thrown.dexPairs }), { kind: "unknown" });
    let up = false;
    const later = dexReader(async () => (up ? [dx()] : null));
    const look = createCoinLook(readers({ tokenPools: cooldown, dexPairs: later.dexPairs }).r);
    assert.equal((await look(COIN)).kind, "unknown");
    up = true;
    assert.equal((await look(COIN)).kind, "candidate", "not cached: the next look can succeed");
  });

  it("inside the same slot of the full-look allowance: no extra look is spent on it", async () => {
    const d = dexReader([dx()]);
    const look = createCoinLook(readers({ tokenPools: cooldown, dexPairs: d.dexPairs }).r);
    const coin = (i: number) => `0x${(0xc0de00 + i).toString(16).padStart(40, "0")}`;
    for (let i = 0; i < COIN_LOOK.maxUncached; i++) await look(coin(i));
    const before = d.calls.dex;
    assert.deepEqual(await look(coin(99)), { kind: "unknown" });
    assert.equal(d.calls.dex, before, "past the allowance, not one DexScreener read either");
  });

  it(`a DexScreener read that never answers is let go after ${COIN_LOOK.dexMs / 1000} s`, async () => {
    mock.timers.enable({ apis: ["setTimeout"], now: 0 });
    try {
      const look = createCoinLook(readers({ tokenPools: cooldown, dexPairs: () => new Promise<GeckoPool[] | null>(() => {}) }).r);
      let got: CoinLook | undefined;
      void look(COIN).then((l) => (got = l));
      for (let i = 0; i < 10 && got === undefined; i++) {
        await setImmediate();
        mock.timers.tick(COIN_LOOK.dexMs);
      }
      for (let i = 0; i < 10 && got === undefined; i++) await setImmediate();
      assert.deepEqual(got, { kind: "unknown" });
    } finally {
      mock.timers.reset();
    }
  });
});

describe("every answer says which read gave it", () => {
  it("free, cache, chain, geckoterminal, dexscreener — and unknown says none", async () => {
    const clock = { t: NOW };
    const h = readers({ held: (a) => (a === COIN ? { name: "FROGGY" } : null) }, clock);
    const look = createCoinLook(h.r);
    assert.equal((await look(ACCOUNT)).source, "free");
    assert.equal((await look(CASH.USDG)).source, "free");
    assert.equal((await look(COIN)).source, "free", "held authority is local; the market snapshot identifies its own source");
    const other = "0x00000000000000000000000000000000000d0222";
    const g = createCoinLook(readers({ tokenPools: async () => [gp({ tokenAddress: other })] }, clock).r);
    assert.equal((await g(other)).source, "geckoterminal");
    assert.equal((await g(other)).source, "cache");
    assert.deepEqual(await createCoinLook(readers({ getCode: async () => "0x" }).r)(other), { kind: "wallet", source: "chain" });
    assert.deepEqual(await createCoinLook(readers({ tokenPools: async () => [] }).r)(other), { kind: "no-pool", source: "chain" });
    assert.deepEqual(await createCoinLook(readers({ tokenPools: async () => null }).r)(other), { kind: "unknown" });
  });

  it("the port carries it to the chat side", async () => {
    const port = createTgCoinsPort({
      readiness: () => ({ kind: "ready-paper", ownerReason: "ready" }),
      look: createCoinLook(readers({ tokenPools: async () => null, dexPairs: async () => [gp({ buyers24h: null })] }).r),
      book: { nominate: () => ({ ok: true }) },
      heldNames: () => [],
      paper: () => true,
    });
    assert.equal((await port.look(COIN)).source, "dexscreener");
  });
});

describe("the quick look: every read is bounded, so a look always settles", () => {
  /** Let promise callbacks run (setImmediate is not a mocked timer here). */
  const flush = async () => {
    for (let i = 0; i < 8; i++) await setImmediate();
  };
  /** Settle `p` on the mocked clock in `step` ms ticks; how long it took, and what it said. */
  async function settleOn<T>(p: Promise<T>, step: number, maxSteps = 40): Promise<{ value: T; ms: number }> {
    let done = false;
    let value!: T;
    void p.then((v) => {
      done = true;
      value = v;
    });
    let ms = 0;
    for (let i = 0; i < maxSteps && !done; i++) {
      await flush();
      if (done) break;
      mock.timers.tick(step);
      ms += step;
    }
    await flush();
    assert.ok(done, "the look settled");
    return { value, ms };
  }
  const never = <T>(): Promise<T> => new Promise<T>(() => {});

  it(`a getCode that never answers is a failed read after ${COIN_LOOK.readMs / 1000} s: the index stands in`, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const h = readers({ getCode: () => never(), tokenPools: async () => [gp({ dex: "pons-v2", poolAddress: null, poolId: V4_ID })] });
      const { value, ms } = await settleOn(lookOf(h.r)(COIN), 500);
      assert.equal(value.kind, "curve");
      assert.equal(ms, COIN_LOOK.readMs);
    } finally {
      mock.timers.reset();
    }
  });

  it(`a GeckoTerminal page that never answers is unknown after ${COIN_LOOK.poolsMs / 1000} s, and the look after it reads again`, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let hang = true;
      const h = readers({ tokenPools: () => (hang ? never() : Promise.resolve([gp()])) });
      const look = lookOf(h.r);
      const { value, ms } = await settleOn(look(COIN), 500);
      assert.deepEqual(value, { kind: "unknown" });
      assert.equal(ms, COIN_LOOK.poolsMs);
      hang = false;
      assert.equal((await settleOn(look(COIN), 500)).value.kind, "candidate", "no stuck read for the next look to join");
    } finally {
      mock.timers.reset();
    }
  });

  it("the chain down AND the index hanging: unknown inside the chat side's ten seconds", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const h = readers({ getCode: () => never(), tokenPools: () => never() });
      const { value, ms } = await settleOn(lookOf(h.r)(COIN), 500);
      assert.deepEqual(value, { kind: "unknown" });
      assert.equal(ms, COIN_LOOK.readMs + COIN_LOOK.poolsMs);
      assert.ok(ms < 10_000, "inside tg-groups/coins.ts COIN_FLOW.lookMs");
    } finally {
      mock.timers.reset();
    }
  });

  it("a ledger lookup that never answers is 'not known here'; a probe that never answers is unknown", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const ledger = readers({ tokenPools: async () => [], curveFor: () => never() });
      const a = await settleOn(lookOf(ledger.r)(COIN), 500);
      assert.equal(a.value.kind, "no-pool", "the multicall still decides");
      assert.equal(a.ms, COIN_LOOK.readMs);
      const probe = readers({ tokenPools: async () => [], probe: () => never() });
      const b = await settleOn(lookOf(probe.r)(COIN), 500);
      assert.deepEqual(b.value, { kind: "unknown" });
      assert.equal(b.ms, 2 * COIN_LOOK.readMs, "a multicall and the factory's read");
    } finally {
      mock.timers.reset();
    }
  });

  it("the chain probe: a multicall or a factory read that never answers is a read that failed", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const hung = chainTokenProbe({ readContract: () => never() } as unknown as PublicClient);
      const a = await settleOn(hung(COIN), 500);
      assert.equal(a.value, null);
      assert.equal(a.ms, COIN_LOOK.readMs);
      const nope = { success: false, returnData: "0x" };
      const word = (a: string) => ({ success: true, returnData: `0x${a.slice(2).toLowerCase().padStart(64, "0")}` });
      const fee = { success: true, returnData: `0x${(10_000).toString(16).padStart(64, "0")}` };
      const factoryHangs = chainTokenProbe({
        readContract: (q: { functionName: string }) =>
          q.functionName === "aggregate3" ? Promise.resolve([nope, nope, word(CASH.WETH), word(COIN), fee]) : never(),
      } as unknown as PublicClient);
      const b = await settleOn(factoryHangs("0x0000000000000000000000000000000000000011"), 500);
      assert.equal(b.value?.pool?.canonical, null, "unknown to the look, never 'not that coin's pool'");
      assert.equal(b.ms, COIN_LOOK.readMs);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("the quick look: cache and allowance", () => {
  it("reuses a definite answer for 30 minutes, then reads again", async () => {
    const h = readers();
    const look = lookOf(h.r);
    assert.equal((await look(COIN)).kind, "candidate");
    assert.equal((await look(COIN.toUpperCase().replace("0X", "0x"))).kind, "candidate");
    assert.equal(h.calls.pools, 1);
    h.clock.t += COIN_LOOK.cacheMs;
    await look(COIN);
    assert.equal(h.calls.pools, 2);
  });

  it("does not cache unknown, so the next look can succeed", async () => {
    let fail = true;
    const h = readers({ tokenPools: async () => (fail ? null : [gp()]) });
    const look = lookOf(h.r);
    assert.equal((await look(COIN)).kind, "unknown");
    fail = false;
    assert.equal((await look(COIN)).kind, "candidate");
  });

  it("the free checks run in front of the cache: a coin bought since is held, not a stale candidate", async () => {
    let held = false;
    const h = readers({ held: () => (held ? { name: "FROGGY" } : null) });
    const look = lookOf(h.r);
    assert.equal((await look(COIN)).kind, "candidate");
    held = true;
    assert.deepEqual(await look(COIN), { kind: "held", name: "FROGGY" });
  });

  it(`at most ${COIN_LOOK.maxUncached} uncached looks per ${COIN_LOOK.windowMs / 60_000} minutes; beyond is unknown with no read`, async () => {
    let reads = 0;
    const clock = { t: NOW };
    const h = readers({ tokenPools: async (a) => { reads++; return [gp({ tokenAddress: a as `0x${string}` })]; } }, clock);
    const look = lookOf(h.r);
    const addr = (i: number) => `0x${(0xc0de00 + i).toString(16).padStart(40, "0")}`;
    for (let i = 0; i < COIN_LOOK.maxUncached; i++) assert.equal((await look(addr(i))).kind, "candidate");
    assert.equal(reads, COIN_LOOK.maxUncached);
    assert.deepEqual(await look(addr(99)), { kind: "unknown" });
    assert.equal(reads, COIN_LOOK.maxUncached, "the refused look read nothing");
    assert.equal((await look(addr(0))).kind, "candidate", "a cached answer costs nothing and is still given");
    clock.t += COIN_LOOK.windowMs;
    assert.equal((await look(addr(99))).kind, "candidate", "the window rolls");
  });

  it("a wallet (another chain's token) is remembered 30 minutes: reposted, no read at all", async () => {
    const h = readers({ getCode: async () => { h.calls.code++; return undefined; } });
    const look = lookOf(h.r);
    assert.equal((await look(COIN)).kind, "wallet");
    assert.equal((await look(COIN)).kind, "wallet");
    assert.equal(h.calls.code, 1);
    h.clock.t += COIN_LOOK.cacheMs;
    await look(COIN);
    assert.equal(h.calls.code, 2);
    assert.equal(h.calls.pools, 0);
  });

  it(`presence probes have their own allowance (${COIN_LOOK.maxProbes} per ${COIN_LOOK.windowMs / 60_000} minutes): a chat full of other chains' CAs cannot spend the full looks`, async () => {
    const clock = { t: NOW };
    const rh = new Set<string>();
    const h = readers(
      {
        tokenPools: async (a) => { h.calls.pools++; return [gp({ tokenAddress: a as `0x${string}` })]; },
        // Only the Robinhood coins have code here; the rest are Ethereum tokens.
        getCode: async (a) => { h.calls.code++; return rh.has(a) ? "0x6000" : undefined; },
      },
      clock,
    );
    const look = lookOf(h.r);
    const eth = (i: number) => `0x${(0xe7e000 + i).toString(16).padStart(40, "0")}`;
    const coin = (i: number) => `0x${(0xc0de00 + i).toString(16).padStart(40, "0")}`;
    const others = COIN_LOOK.maxProbes - COIN_LOOK.maxUncached;
    for (let i = 0; i < others; i++) assert.equal((await look(eth(i))).kind, "wallet");
    assert.equal(h.calls.pools, 0, "not one GeckoTerminal read for them");
    // Every full look is still there for the Robinhood coins.
    for (let i = 0; i < COIN_LOOK.maxUncached; i++) {
      rh.add(coin(i));
      assert.equal((await look(coin(i))).kind, "candidate", `coin ${i}`);
    }
    assert.equal(h.calls.code, COIN_LOOK.maxProbes);
    // The probe allowance is spent: unknown, with no read at all.
    assert.deepEqual(await look(eth(99)), { kind: "unknown" });
    assert.equal(h.calls.code, COIN_LOOK.maxProbes, "the refused probe read nothing");
    assert.equal((await look(eth(0))).kind, "wallet", "a remembered wallet costs nothing and is still given");
    clock.t += COIN_LOOK.windowMs;
    assert.equal((await look(eth(99))).kind, "wallet", "the window rolls");
  });

  it("an address with code that was refused a full look is not probed again for it", async () => {
    const clock = { t: NOW };
    const h = readers({ tokenPools: async (a) => { h.calls.pools++; return [gp({ tokenAddress: a as `0x${string}` })]; } }, clock);
    const look = lookOf(h.r);
    const addr = (i: number) => `0x${(0xc0de00 + i).toString(16).padStart(40, "0")}`;
    for (let i = 0; i < COIN_LOOK.maxUncached; i++) await look(addr(i));
    assert.deepEqual(await look(addr(99)), { kind: "unknown" }, "past the full-look allowance");
    const probes = h.calls.code;
    clock.t += COIN_LOOK.windowMs;
    assert.equal((await look(addr(99))).kind, "candidate");
    assert.equal(h.calls.code, probes, "its code was already found");
  });

  it("two looks at the same coin at once are one read and one use of the allowance", async () => {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = readers({ tokenPools: async () => { reads++; await gate; return [gp()]; } });
    const look = lookOf(h.r);
    const both = Promise.all([look(COIN), look(COIN)]);
    release();
    assert.deepEqual((await both).map((l) => l.kind), ["candidate", "candidate"]);
    assert.equal(reads, 1);
  });
});

describe("the chain probe: one multicall, and a failed batch is not an answer", () => {
  const METADATA = [
    { type: "address" }, { type: "string" }, { type: "string" },
    { type: "tuple", components: [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }] },
  ] as const;
  const meta = encodeAbiParameters(METADATA, [ACCOUNT, "ipfs://logo", "a frog", ["", "", "", "", ""]]);
  const decimals = `0x${(18).toString(16).padStart(64, "0")}` as `0x${string}`;
  const client = (answer: () => unknown) => ({ readContract: async () => answer() }) as unknown as PublicClient;
  const nope = { success: false, returnData: "0x" };
  /** Pons, decimals, and a token0/token1/fee that all revert: a plain ERC-20's answer. */
  const batch = (pons: unknown, dec: unknown) => [pons, dec, nope, nope, nope];

  it("reads Pons-ness and ERC-20-ness from one aggregate3", async () => {
    let calls = 0;
    const probe = chainTokenProbe({ readContract: async () => { calls++; return batch({ success: true, returnData: meta }, { success: true, returnData: decimals }); } } as unknown as PublicClient);
    assert.deepEqual(await probe(COIN), { pons: true, erc20: true });
    assert.equal(calls, 1);
    assert.deepEqual(await chainTokenProbe(client(() => batch(nope, { success: true, returnData: decimals })))(COIN), { pons: false, erc20: true });
    // An address with no code answers every sub-call with nothing.
    const empty = { success: true, returnData: "0x" };
    assert.deepEqual(await chainTokenProbe(client(() => [empty, empty, empty, empty, empty]))(COIN), { pons: false, erc20: false });
    // decimals() that is not a uint8 is not an ERC-20 answer.
    assert.deepEqual(await chainTokenProbe(client(() => batch(nope, { success: true, returnData: `0x${"f".repeat(64)}` })))(COIN), { pons: false, erc20: false });
  });

  it("a batch that failed is null — unknown to the look, never 'not a token'", async () => {
    assert.equal(await chainTokenProbe(client(() => { throw new Error("rpc"); }))(COIN), null);
    assert.equal(await chainTokenProbe(client(() => [nope, nope]))(COIN), null, "a batch that did not answer every sub-call is not an answer");
  });

  const POOL = "0x0000000000000000000000000000000000000011" as const;
  const addrWord = (a: string) => ({ success: true, returnData: `0x${a.slice(2).toLowerCase().padStart(64, "0")}` });
  const feeWord = { success: true, returnData: `0x${(10_000).toString(16).padStart(64, "0")}` };

  it("a pool-shaped address costs one more read: what the CANONICAL v3 factory names for its tokens and fee", async () => {
    const seen: Array<{ address: string; functionName: string; args?: unknown }> = [];
    const probe = chainTokenProbe({
      readContract: async (q: { address: string; functionName: string; args?: unknown }) => {
        seen.push(q);
        if (q.functionName === "aggregate3") return [nope, nope, addrWord(CASH.WETH), addrWord(COIN), feeWord];
        return POOL.toUpperCase().replace("0X", "0x");
      },
    } as unknown as PublicClient);
    assert.deepEqual(await probe(POOL), {
      pons: false,
      erc20: false,
      pool: { token0: CASH.WETH.toLowerCase(), token1: COIN, canonical: POOL },
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.functionName, "getPool");
    assert.equal(seen[1]!.address.toLowerCase(), UNISWAP.v3Factory.toLowerCase(), "the canonical factory, never one the address names");
    assert.deepEqual(seen[1]!.args, [CASH.WETH.toLowerCase(), COIN, 10_000]);
  });

  it("the factory read failing is canonical null, and a half pool is no pool with no second read", async () => {
    let reads = 0;
    const failing = chainTokenProbe({
      readContract: async (q: { functionName: string }) => {
        reads++;
        if (q.functionName === "aggregate3") return [nope, nope, addrWord(CASH.WETH), addrWord(COIN), feeWord];
        throw new Error("rpc");
      },
    } as unknown as PublicClient);
    assert.equal((await failing(POOL))?.pool?.canonical, null);
    assert.equal(reads, 2);
    for (const shape of [
      [nope, nope, addrWord(CASH.WETH), addrWord(COIN), nope],
      [nope, nope, addrWord(CASH.WETH), nope, feeWord],
      [nope, nope, { success: true, returnData: `0x${"f".repeat(64)}` }, addrWord(COIN), feeWord],
      [nope, nope, addrWord(CASH.WETH), addrWord(COIN), { success: true, returnData: `0x${(0x1000000).toString(16).padStart(64, "0")}` }],
    ]) {
      let n = 0;
      const p = chainTokenProbe({ readContract: async () => { n++; return shape; } } as unknown as PublicClient);
      assert.deepEqual(await p(POOL), { pons: false, erc20: false });
      assert.equal(n, 1, "not pool-shaped: the factory is not asked");
    }
  });
});

describe("a chart link carries the POOL: the look resolves it to its coin on chain provenance, never a label", () => {
  // GeckoTerminal /robinhood/pools/<POOL> and dexscreener.com/robinhood/<POOL>
  // both put the pool's address in the message, and it is the only address
  // there (detect.test.ts pins that extractCas reads it out of both).
  const POOL = "0x0000000000000000000000000000000000000011";
  const PAIR = "0x0000000000000000000000000000000000000012";
  const OTHER = "0x00000000000000000000000000000000000d0222";
  const WETH = CASH.WETH.toLowerCase();
  const USDG = CASH.USDG.toLowerCase();
  type Pool = TokenProbe["pool"];

  /** POOL is WETH/COIN (GeckoTerminal's link), PAIR is COIN/USDG (DexScreener's): both canonical. */
  function chart(over: Partial<CoinLookReaders> = {}, pools: Record<string, Pool> = {}) {
    const shapes: Record<string, Pool> = {
      [POOL]: { token0: WETH, token1: COIN, canonical: POOL },
      [PAIR]: { token0: COIN, token1: USDG, canonical: PAIR },
      ...pools,
    };
    const asked: string[] = [];
    const h = readers({
      // The index has no token page for a pool (a 404, read as an empty page).
      tokenPools: async (a) => { asked.push(a); return a === COIN ? [gp()] : []; },
      probe: async (a) => (shapes[a] ? { pons: false, erc20: false, pool: shapes[a] } : { pons: false, erc20: true }),
      ...over,
    });
    return { ...h, asked };
  }

  it("a GeckoTerminal pool and a DexScreener pair are looked at as the coin they trade, and carry its address", async () => {
    for (const posted of [POOL, PAIR]) {
      const h = chart();
      assert.deepEqual(await lookOf(h.r)(posted), { kind: "candidate", name: "FROGGY", address: COIN }, posted);
      assert.deepEqual(h.asked, [posted, COIN], "the coin's own page decides, like any posted coin");
    }
    // Whatever the coin's look says is the answer, with the coin's address.
    assert.deepEqual(await lookOf(chart({ tokenPools: async (a) => (a === COIN ? [gp({ volume24hUsd: 50_000 })] : []) }).r)(POOL), { kind: "too-quiet", name: "FROGGY", address: COIN });
    const stock = STOCK_TOKENS[0]!;
    assert.deepEqual(
      await lookOf(chart({}, { [POOL]: { token0: stock.address.toLowerCase(), token1: USDG, canonical: POOL } }).r)(POOL),
      { kind: "stock", name: stock.symbol, address: stock.address.toLowerCase() },
    );
  });

  it("the coin's look is its own: the free checks run every time, and its cache serves the coin posted bare", async () => {
    let held = false;
    const h = chart({ held: (a) => (held && a === COIN ? { name: "FROGGY" } : null) });
    const look = lookOf(h.r);
    assert.equal((await look(POOL)).kind, "candidate");
    held = true;
    assert.deepEqual(await look(POOL), { kind: "held", name: "FROGGY", address: COIN }, "bought since: held through its chart link too");
    held = false;
    const asked = h.asked.length;
    assert.deepEqual(await look(COIN), { kind: "candidate", name: "FROGGY" }, "the coin itself, posted bare, needs no address of its own");
    assert.deepEqual(await look(POOL), { kind: "candidate", name: "FROGGY", address: COIN });
    assert.equal(h.asked.length, asked, "both answered from the cache");
  });

  it("no cash side, cash on both sides, or a pool the canonical factory does not name: not-token, and the coin is never read", async () => {
    const cases: Array<[string, Pool]> = [
      ["two coins", { token0: COIN, token1: OTHER, canonical: POOL }],
      ["USDG against WETH", { token0: USDG, token1: WETH, canonical: POOL }],
      ["an impostor the factory does not name", { token0: WETH, token1: COIN, canonical: "0x0000000000000000000000000000000000000099" }],
      ["no such pool at the factory", { token0: WETH, token1: COIN, canonical: `0x${"0".repeat(40)}` }],
    ];
    for (const [why, pool] of cases) {
      // The index even labels the impostor as COIN's pool: a label is a claim, the factory is the proof.
      const h = chart({ tokenPools: async (a) => { h.asked.push(a); return a === COIN ? [gp()] : [gp({ tokenAddress: COIN as `0x${string}` })]; } }, { [POOL]: pool });
      assert.deepEqual(await lookOf(h.r)(POOL), { kind: "not-token" }, why);
      assert.deepEqual(h.asked, [POOL], `${why}: the coin is never looked at`);
    }
  });

  it("UNREADABLE IS NOT ABSENT: a failed factory read, or a coin that could not be looked at, is unknown and not cached", async () => {
    let canonical: string | null = null;
    const h = chart({ probe: async (a) => (a === POOL ? { pons: false, erc20: false, pool: { token0: WETH, token1: COIN, canonical } } : null) });
    const look = lookOf(h.r);
    assert.deepEqual(await look(POOL), { kind: "unknown" }, "the factory could not be asked");
    canonical = POOL;
    assert.deepEqual(await look(POOL), { kind: "candidate", name: "FROGGY", address: COIN }, "not cached: the next look can succeed");

    let fail = true;
    const g = chart({ tokenPools: async (a) => (a === COIN ? (fail ? null : [gp()]) : []) });
    const again = lookOf(g.r);
    assert.deepEqual(await again(POOL), { kind: "unknown" }, "the coin's page could not be read");
    fail = false;
    assert.deepEqual(await again(POOL), { kind: "candidate", name: "FROGGY", address: COIN });
  });

  it("the coin's look spends its own slot of the allowance; none left is unknown", async () => {
    const h = chart();
    const look = lookOf(h.r);
    const addr = (i: number) => `0x${(0xc0de00 + i).toString(16).padStart(40, "0")}`;
    for (let i = 0; i < COIN_LOOK.maxUncached - 1; i++) await look(addr(i));
    assert.deepEqual(await look(POOL), { kind: "unknown" }, "the pool took the last slot, and the coin found none");
    assert.ok(!h.asked.includes(COIN), "and read nothing");
  });

  it("one level only: a pool whose coin is itself pool-shaped is not a coin", async () => {
    const h = chart({ tokenPools: async (a) => { h.asked.push(a); return []; } }, { [COIN]: { token0: WETH, token1: OTHER, canonical: COIN } });
    assert.deepEqual(await lookOf(h.r)(POOL), { kind: "not-token", address: COIN });
    assert.ok(!h.asked.includes(OTHER), "never followed a second time");
  });
});

// ─── The port ───────────────────────────────────────────────────────────────

const READY: TrencherReadiness = { kind: "ready-paper", ownerReason: "ready" };
const nomination = (over = {}) => ({ address: COIN, chatId: -100, messageId: 7, senderId: 42, atMs: NOW, ...over });

function memCounters(entriesUsed = 0): NominationCounters & { entries: () => number } {
  const day = new Date(NOW).toISOString().slice(0, 10);
  const s = { n: 0, entries: entriesUsed };
  return {
    entries: () => s.entries,
    takeNomination: (d, limit) => (d === day && s.n < limit ? (s.n++, true) : false),
    takeGroupEntry: (d, limit) => (d === day && s.entries < limit ? (s.entries++, true) : false),
    refundGroupEntry: (d) => { if (d === day && s.entries > 0) s.entries--; },
  };
}

describe("the port is safe to call at any time", () => {
  it("nominates through the book with the live readiness, and registers the tape page only on success", () => {
    const seen: string[] = [];
    const kinds: string[] = [];
    const port = createTgCoinsPort({
      readiness: () => READY,
      look: async () => ({ kind: "candidate" }),
      book: { nominate: (_n, kind) => { kinds.push(kind); return { ok: true }; } },
      onNominated: (a) => seen.push(a),
      heldNames: () => ["FROGGY", ""],
      paper: () => true,
    });
    assert.deepEqual(port.nominate(nomination({ address: COIN.toUpperCase().replace("0X", "0x") })), { ok: true });
    assert.deepEqual(kinds, ["ready-paper"]);
    assert.deepEqual(seen, [COIN], "lowercased");
    assert.deepEqual(port.heldNames(), ["FROGGY"]);
    assert.equal(port.mode(), "paper");

    const refused = createTgCoinsPort({
      readiness: () => READY, look: async () => ({ kind: "unknown" }),
      book: { nominate: () => ({ ok: false, reason: "busy" }) },
      onNominated: () => { throw new Error("must not be called"); },
      heldNames: () => [], paper: () => false,
    });
    assert.deepEqual(refused.nominate(nomination()), { ok: false, reason: "busy" });
    assert.equal(refused.mode(), "live");
  });

  it("with a real book: not ready is refused, and a burst is capped", () => {
    let readiness: TrencherReadiness = { kind: "slow", ownerReason: "fast off" };
    const book = new NominationBook(memCounters(), () => NOW);
    const port = createTgCoinsPort({ readiness: () => readiness, look: async () => ({ kind: "candidate" }), book, heldNames: () => [], paper: () => true });
    assert.deepEqual(port.nominate(nomination()), { ok: false, reason: "not-ready" });
    readiness = READY;
    assert.deepEqual(port.nominate(nomination()), { ok: true });
    assert.deepEqual(port.nominate(nomination({ messageId: 8 })), { ok: false, reason: "recent" }, "the same coin is one nomination");
  });

  it("every failure answers the way that does nothing", async () => {
    const boom = () => { throw new Error("boom"); };
    const port = createTgCoinsPort({
      readiness: boom, look: boom as never, book: { nominate: boom }, onNominated: boom,
      heldNames: boom, paper: boom,
    });
    assert.equal(port.readiness().kind, "off");
    assert.ok(!/\d/.test(port.readiness().ownerReason));
    assert.deepEqual(await port.look(COIN), { kind: "unknown" });
    assert.deepEqual(port.nominate(nomination()), { ok: false, reason: "invalid" });
    assert.deepEqual(port.heldNames(), []);
    assert.equal(port.mode(), "paper", "an unreadable mode never claims real money");
    const rejecting = createTgCoinsPort({ readiness: () => READY, look: () => Promise.reject(new Error("x")), book: { nominate: () => ({ ok: true }) }, onNominated: boom, heldNames: () => [], paper: () => false });
    assert.deepEqual(await rejecting.look(COIN), { kind: "unknown" });
    assert.deepEqual(rejecting.nominate(nomination()), { ok: true }, "a failing tape hook does not undo the nomination");
  });

  it("outcomes reach every subscriber, a throwing one is skipped, and unsubscribe works", () => {
    const lines: string[] = [];
    const port = createTgCoinsPort({ readiness: () => READY, look: async () => ({ kind: "candidate" }), book: { nominate: () => ({ ok: true }) }, heldNames: () => [], paper: () => true, log: (l) => lines.push(l) });
    const a: CoinOutcome[] = [];
    const b: CoinOutcome[] = [];
    port.onOutcome(() => { throw new Error("bad handler"); });
    const offA = port.onOutcome((o) => a.push(o));
    port.onOutcome((o) => b.push(o));
    const expired: CoinOutcome = { kind: "expired", address: COIN, chatId: -100, messageId: 7 };
    port.emit(expired);
    port.emit([expired, { kind: "skipped", address: COIN, chatId: -100, messageId: 8 }]);
    port.emit(null);
    port.emit(undefined);
    assert.equal(a.length, 3);
    assert.equal(b.length, 3);
    offA();
    port.emit(expired);
    assert.equal(a.length, 3);
    assert.equal(b.length, 4);
    assert.ok(lines.every((l) => !l.includes(COIN) && !l.includes("-100")), "the log line is the kind only");
    assert.deepEqual(lines.slice(0, 1), ["[tg-groups] coin outcome: expired"]);
  });
});

// ─── The tick's seams ─────────────────────────────────────────────────────

describe("what a review of a nominated coin reports", () => {
  const decision = (over = {}) => ({
    action: "buy" as const, decision_id: "d-1", thesis: "flow is real", bull_case: "new buyers", bear_case: "thin",
    risks: ["reversal"], hold_kind: null, gate_verdict: "proceed" as const, ...over,
  });
  it("passes the Brain's own decision through", () => {
    assert.deepEqual(reviewedDecisionOf(decision()), {
      action: "buy", decisionId: "d-1", holdKind: null, thesis: "flow is real", bullCase: "new buyers", bearCase: "thin", risks: ["reversal"],
    });
  });
  it("a BUY the portfolio gate refused is a gate-forced hold — skipped, never a take, never a pending buy", () => {
    for (const gate_verdict of ["refuse", "downgrade-to-hold"] as const) {
      const r = reviewedDecisionOf(decision({ gate_verdict }));
      assert.equal(r.action, "hold");
      assert.equal(r.holdKind, "GATE_FORCED_HOLD");
      const book = new NominationBook(memCounters(), () => NOW);
      book.nominate(nomination(), "ready-paper");
      assert.equal(book.onReviewed(COIN, r)?.kind, "skipped");
    }
  });
});

describe("a nominated coin's buy", () => {
  const OTHER = "0x00000000000000000000000000000000000d0222" as const;
  const USDG = "0x0000000000000000000000000000000000000022" as const;
  const ROUTER = "0x0000000000000000000000000000000000000033" as const;
  const AGENT = "0x0000000000000000000000000000000000000044";
  const cand = (token: `0x${string}`, symbol: string): Candidate => ({
    symbol, token, decimals: 18, price8: 1_000_000n, priceable: true, liquidityUsd: 100_000, fdvUsd: 1_000_000, ageSec: 3600, volume24hUsd: 500_000,
  });
  const inputFor = (symbol: string) => ({ agentId: AGENT, market: { instrumentId: `merrymen:${symbol.toLowerCase()}`, symbol, priceUsd: "0.01" } }) as ShadowInputs;
  const buy = (symbol: string, id: string) => ({ ran: true, result: { ok: true, decision: {
    decision_id: id, agent_id: AGENT, instrument_id: `merrymen:${symbol.toLowerCase()}`, symbol, action: "buy", suggested_delta_usdg: 5e6, gate_verdict: "proceed",
  } } }) as ShadowOutcome;
  const snap = { cashUsdg: 1000_000_000n, vaultUsdg: 0n, holdings: new Map(), prices: new Map(), pausedTokens: new Set(), staleFeeds: new Set(), sequencerUp: true, spendHeadroomUsdg: 100_000_000n, perTradeCapUsdg: 10_000_000n } as unknown as Snapshot;

  it("still needs the fresh Brain BUY, then the group-entry claim; a refused claim blocks only that entry", async () => {
    let now = NOW;
    const counters = memCounters();
    const book = new NominationBook(counters, () => now);
    assert.deepEqual(book.nominate(nomination(), "ready-paper"), { ok: true });
    const review = new TrenchBrainReview(() => now);
    review.reset("paper");
    const reviewed = new Map<string, string>();
    const candidates = [cand(OTHER, "TOTHER"), cand(COIN, "TNOM")];
    const strategy = makeTrencher({
      cfg: TRENCHER_FAST, brainRequired: true, brainOrder: (s, t, p) => review.take(s, t, p, 5),
      swapRouter: ROUTER, usdgToken: USDG, candidates: () => candidates, open: () => [], liquidityOf: () => 100_000,
    });

    // 1. A nomination is not a buy: no Brain BUY, no intent — for it or anyone.
    assert.equal(takeTick(await strategy.tick(snap)).intents.length, 0);

    // 2. It is looked at first...
    assert.equal(review.candidate(candidates, book.priority())?.token, COIN);
    // ...and the Brain's answer is the only thing that can make an order.
    review.launch("paper", inputFor("TNOM"), COIN, async () => {
      const o = buy("TNOM", "decision-nom");
      if (o.ran && o.result.ok) {
        const d = reviewedDecisionOf(o.result.decision);
        if (book.nominated(COIN)) reviewed.set(d.decisionId, COIN);
        assert.equal(book.onReviewed(COIN, d), null, "a BUY says nothing until a fill");
      }
      return o;
    }, () => {});
    await setImmediate();
    const intents = takeTick(await strategy.tick(snap)).intents;
    assert.equal(intents.length, 1);
    const entry = intents[0]!;
    assert.ok(entry.kind === "swap");
    assert.equal(entry.buyToken, COIN);
    assert.equal(entry.decisionId, "decision-nom", "provenance is the Brain's decision, nothing minted");
    assert.equal(entry.sellAmountRaw, 5_000_000n, "sized by the entry path, never by the chat");

    // 3. The group-entry claim, on top of everything else.
    const claimed = claimGroupEntry(book, entry, (id) => reviewed.get(id));
    assert.deepEqual(claimed, { group: true, address: COIN, ok: true });
    assert.equal(counters.entries(), 1);
    // No fill → the claim goes back (the loop's tgSettleGroupEntry).
    book.refundEntry(COIN);
    assert.equal(counters.entries(), 0);

    // 4. At the day's cap, THIS entry is refused...
    const full = memCounters(NOMINATE.groupEntriesPerDay);
    const capped = new NominationBook(full, () => now);
    capped.nominate(nomination(), "ready-paper");
    assert.deepEqual(claimGroupEntry(capped, entry, (id) => reviewed.get(id)), { group: true, address: COIN, ok: false, why: "cap" });
    assert.equal(full.entries(), NOMINATE.groupEntriesPerDay, "a refusal takes nothing");
    // ...and an entry into a coin nobody nominated is not this cap's business.
    const tape = { kind: "swap" as const, buyToken: OTHER, decisionId: "decision-other" };
    assert.deepEqual(claimGroupEntry(capped, tape, (id) => reviewed.get(id)), { group: false });
    const exit = { kind: "swap", sellToken: COIN, buyToken: USDG };
    assert.deepEqual(claimGroupEntry(capped, exit, () => undefined), { group: false }, "an exit is never an entry");

    // 5. A decision from a nominated review whose nomination has since
    //    resolved cannot slip past the cap uncounted.
    now += NOMINATE.ttlMs;
    assert.equal(book.expire().length, 1);
    assert.deepEqual(claimGroupEntry(book, entry, (id) => reviewed.get(id)), { group: true, address: COIN, ok: false, why: "resolved" });
  });

  it("a TTL that runs out inside claimEntry refuses the entry as resolved, takes nothing, and refunds no older claim", () => {
    const base = memCounters();
    let entryTakes = 0;
    const counters: NominationCounters = {
      takeNomination: (d, l) => base.takeNomination(d, l),
      takeGroupEntry: (d, l) => { entryTakes++; return base.takeGroupEntry(d, l); },
      refundGroupEntry: (d) => base.refundGroupEntry(d),
    };
    // The book reads the clock once per call; `reads` scripts those readings.
    let reads: number[] = [];
    const book = new NominationBook(counters, () => reads.shift() ?? NOW + NOMINATE.ttlMs);
    reads = [NOW];
    assert.deepEqual(book.nominate(nomination(), "ready-paper"), { ok: true });
    // An earlier entry for this coin won its claim and went `submitted`, so
    // the loop's settle gave nothing back: that slot is used.
    reads = [NOW + 1, NOW + 2, NOW + 3];
    book.onReviewed(COIN, { action: "buy", decisionId: "decision-first" });
    const entry = { kind: "swap", buyToken: COIN, decisionId: "decision-first" };
    assert.deepEqual(claimGroupEntry(book, entry, () => COIN), { group: true, address: COIN, ok: true });
    assert.equal(base.entries(), 1);
    const takesBefore = entryTakes;

    // The next entry: nominated() still sees it pending, and the TTL passes
    // before claimEntry() reads the clock.
    reads = [NOW + NOMINATE.ttlMs - 1, NOW + NOMINATE.ttlMs];
    const again = claimGroupEntry(book, { ...entry, decisionId: "decision-second" }, () => undefined);
    assert.deepEqual(again, { group: true, address: COIN, ok: false, why: "resolved" });
    assert.equal(entryTakes, takesBefore, "takeGroupEntry is never called");
    // The loop's tgSettleGroupEntry refunds only a claim that was ok.
    if (again.group && again.ok) book.refundEntry(COIN);
    assert.equal(base.entries(), 1, "the earlier entry's slot stays spent");
  });

  it("a claim that cannot be answered refuses the entry", () => {
    const book = { nominated: () => nomination(), claimEntry: () => { throw new Error("disk"); } };
    assert.deepEqual(claimGroupEntry(book as never, { kind: "swap", buyToken: COIN }, () => undefined), { group: true, address: COIN, ok: false, why: "cap" });
  });
});

describe("which sale is an exit worth one line", () => {
  const sale = (over = {}) => ({ kind: "swap", sellToken: COIN, buyToken: CASH.USDG, sellAmountRaw: 500n, ...over });
  it("a mechanical trencher exit always sells the whole position", () => {
    for (const cause of ["stop", "take", "aged", "drain", "unpriceable"]) {
      const e = groupExitOf(sale({ sellAmountRaw: 1n }), { code: "trench-exit", cause }, 500n);
      assert.equal(e?.address, COIN);
      assert.equal(e!.notes.length, 1);
      assert.ok(!/\d|%|\$|up|profit|loss/i.test(e!.notes[0]!), `${cause}: ${e!.notes[0]}`);
    }
  });
  it("a Brain sale counts only when it empties the position; a trim is silence", () => {
    assert.ok(groupExitOf(sale(), null, 500n));
    assert.ok(groupExitOf(sale({ sellAmountRaw: 600n }), null, 500n));
    assert.equal(groupExitOf(sale({ sellAmountRaw: 200n }), null, 500n), null);
    assert.equal(groupExitOf(sale(), null, null), null, "an unknown holding is not an empty one");
  });
  it("buys and cash legs are never exits", () => {
    assert.equal(groupExitOf({ kind: "swap", sellToken: CASH.USDG, buyToken: COIN, sellAmountRaw: 5n }, { code: "trench-exit", cause: "stop" }, 5n), null);
    assert.equal(groupExitOf({ kind: "transfer" }, { code: "trench-exit" }, 5n), null);
  });
});

// ─── The wiring, read as source ───────────────────────────────────────────

describe("index.ts wires the seams in the order that makes them safe", () => {
  const CODE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const loopAt = CODE.indexOf("for (const [proposedAt, intent] of proposed.entries()) {");
  const LOOP = CODE.slice(loopAt, CODE.indexOf("\n    }\n", loopAt));

  it("the group-entry claim comes before the energy claim and before any decision row", () => {
    const group = LOOP.indexOf("const groupEntry = entry ? tgClaimGroupEntry(intent) : null;");
    const skip = LOOP.indexOf("if (groupEntry?.group && !groupEntry.ok) continue;");
    const energy = LOOP.indexOf("const energyClaim = entry ? await claimEntry() : null;");
    const decided = LOOP.indexOf("await ensureDecision(");
    assert.ok(loopAt > 0 && group > 0 && skip > group && energy > skip && decided > energy);
  });

  it("the group claim goes back wherever the energy claim does", () => {
    assert.match(LOOP, /tgSettleGroupEntry\(groupEntry, intent\.decisionId, null\);\n\s+await withholdEntry\(agentId\);\n\s+continue;/);
    assert.match(LOOP, /await refundEntry\(energyClaim\);\n\s+tgSettleGroupEntry\(groupEntry, intent\.decisionId, null\);\n\s+continue;/);
    assert.match(LOOP, /if \(!tradeConsumesSnapshot\(facts\?\.status\)\) await refundEntry\(energyClaim\);\n\s+tgSettleGroupEntry\(groupEntry, intent\.decisionId, facts\?\.status\);/);
    assert.match(CODE, /if \(!g \|\| !g\.group \|\| !g\.ok \|\| tradeConsumesSnapshot\(status\)\) return;/, "refunded only when no trade came of it");
  });

  it("the nomination only reorders the review, and the Brain's input is any tape coin's", () => {
    assert.match(CODE, /trenchBrain\.candidate\(trenchEligible\.filter\([^\n]*\), tgBook\.priority\(\)\);/);
    const inputsAt = CODE.indexOf("const inputs: ShadowInputs = {");
    const launchAt = CODE.indexOf("trenchBrain.launch(trenchContext, inputs");
    assert.ok(inputsAt > 0 && launchAt > inputsAt);
    assert.doesNotMatch(CODE.slice(inputsAt, launchAt), /\btg[A-Z]\w*/, "nothing from Telegram groups reaches the Brain's input");
  });

  it("every trencher review is reported after it is persisted, and cannot break the review", () => {
    const at = CODE.indexOf("return runShadow(brainConfig, inputs,");
    assert.match(CODE.slice(at, at + 1600), /admit: claimReview,\n\s+\}\)\.then\(outcome => \{ tgNoteReview\(focus\.token, outcome\); return outcome; \}\); \},/);
    const body = CODE.slice(CODE.indexOf("function tgNoteReview("), CODE.indexOf("function tgNoteHeld("));
    assert.match(body, /try \{[\s\S]*\} catch/);
  });

  it("fills, drops, TTLs and context changes all reach the book", () => {
    assert.match(CODE, /if \(wrote && decision_id\) void maybePost\(decision_id, row\.status\);\n[\s\S]{0,400}if \(wrote\) tgNoteTradeRow\(intent, decision_id, row\.status\);/);
    assert.match(CODE, /if \(decisionId\) tgDeliver\(tgBook\.onFill\(decisionId, "dropped", paperActive\(\)\)\);/);
    assert.match(CODE, /if \(trenchBrain\.reset\(trenchContext\)\) tgDeliver\(tgBook\.reset\(\)\);\n\s+tgDeliver\(tgBook\.expire\(\)\);/);
    // The nominated set still reaches discovery. The pool cache rides beside it
    // (trencher-discovery.ts) and changes what is re-read, never what qualifies.
    const refresh = CODE.slice(CODE.indexOf("const autoTrenchRefresh = new CoalescedRefresh("), CODE.indexOf("function refreshAutoTrench("));
    assert.match(refresh, /const poolCache = trenchPoolCache;/);
    assert.match(refresh, /discoverTrencherUniverse\(mainnetClient\(\),\s*current\.grant,\s*freshTrenchTape\(\),\s*\{\s*nominated:\s*new Set\(tgNominated\),\s*cache:\s*poolCache\s*\}\)/);
    assert.match(refresh, /autoTrenchContext === context && trenchPoolCache === poolCache && active/,
      "a result from an old grant or connection cannot replace the current discovery");
  });

  it("the look's presence probe reads Robinhood Chain, through the governed mainnet client", () => {
    const at = CODE.indexOf("const tgLook = createCoinLook({");
    assert.ok(at > 0);
    assert.match(CODE.slice(at, at + 800), /\n\s+getCode: \(a\) => mainnetClient\(\)\.getCode\(\{ address: a \}\),\n/);
  });

  it("the look's last index is DexScreener's Robinhood Chain pairs, inside the look's own bound", () => {
    const at = CODE.indexOf("const tgLook = createCoinLook({");
    const block = CODE.slice(at, CODE.indexOf("});", at));
    assert.match(block, /\n\s+dexPairs: \(a\) => readDexTokenPairs\(a, \{ timeoutMs: COIN_LOOK\.dexMs \}\),\n/);
  });

  it("the child hands the service its one store and the port", () => {
    assert.match(CODE, /const tgGroupsStore = TgGroupsStore\.open\(merrymenHome\(\), \{ ownsForgets: !isHostedMode\(\) \}\);\n\s+const tgBook = new NominationBook\(tgGroupsStore\);/);
    const tg = CODE.slice(CODE.indexOf("startTelegram({"));
    assert.match(tg.slice(0, 4000), /\n\s+tgGroupsStore,\n\s+tgCoins,\n/);
  });
});
