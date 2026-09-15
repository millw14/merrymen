/**
 * Discovery is the one path where a THIRD PARTY's data reaches a message the
 * owner reads and may act on. So the tests care about two things: that it picks
 * the right side of a pair, and that nothing an attacker controls — a token
 * symbol, a malformed event — gets through unshaped.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CASH } from "../../packages/core/src/index";
import {
  PONS_MAX_EVALUATE,
  describeDiscovery,
  describeTrending,
  discoverTrending,
  newTokenOf,
  ponsScanWindow,
  sanitizeSymbol,
  type Discovery,
} from "./discovery";
import { applyVerdicts, nullScout } from "./strategist/memecoin-scout";
import { emptyGeckoBuckets, type GeckoPool } from "./venues/geckoterminal";

const USDG = (CASH.USDG as string).toLowerCase() as `0x${string}`;
const WETH = (CASH.WETH as string).toLowerCase() as `0x${string}`;
const CATE = "0x00000000000000000000000000000000000000c1" as const;
const DOGE = "0x00000000000000000000000000000000000000d0" as const;

const pair = (a: `0x${string}`, b: `0x${string}`) => ({
  token: a,
  quote: b,
  symbol: "",
  decimals: 18,
  protocol: "uniswap",
  createdAt: 1,
  txHash: "0x",
});

describe("newTokenOf — which side actually launched", () => {
  it("picks the non-cash side, whichever order it arrives in", () => {
    assert.equal(newTokenOf(pair(CATE, USDG)), CATE);
    assert.equal(newTokenOf(pair(USDG, CATE)), CATE);
    assert.equal(newTokenOf(pair(CATE, WETH)), CATE);
    assert.equal(newTokenOf(pair(WETH, CATE)), CATE);
  });

  it("says nothing about a cash/cash pool — USDG/WETH is not a launch", () => {
    assert.equal(newTokenOf(pair(USDG, WETH)), null);
    assert.equal(newTokenOf(pair(WETH, USDG)), null);
  });

  it("says nothing about an exotic pair with no cash leg", () => {
    // Nothing to value it against, so announcing it would be noise the owner
    // can't act on anyway.
    assert.equal(newTokenOf(pair(CATE, DOGE)), null);
  });

  it("treats native ETH as a cash side", () => {
    const NATIVE = "0x0000000000000000000000000000000000000000" as const;
    assert.equal(newTokenOf(pair(CATE, NATIVE)), CATE);
  });

  it("is case-insensitive about the cash addresses", () => {
    const upper = USDG.toUpperCase().replace("0X", "0x") as `0x${string}`;
    assert.equal(newTokenOf(pair(CATE, upper)), CATE);
  });
});

/**
 * A token's symbol is chosen by whoever deployed it and lands in a Telegram
 * message and an event line. Same reasoning as the memory sanitizers: strip
 * anything that could pass for markup or a list separator, and cap the length.
 */
describe("sanitizeSymbol", () => {
  it("keeps an ordinary ticker intact", () => {
    assert.equal(sanitizeSymbol("CATE"), "CATE");
    assert.equal(sanitizeSymbol("wstETH-1"), "wstETH-1");
  });

  it("strips markup, separators and whitespace", () => {
    assert.equal(sanitizeSymbol("<b>CATE</b>"), "bCATEb");
    assert.equal(sanitizeSymbol("CATE,NVDA"), "CATENVDA");
    assert.equal(sanitizeSymbol("CA TE"), "CATE");
    assert.equal(sanitizeSymbol("CATE\n/grant"), "CATEgrant");
  });

  it("caps the length so a symbol can't flood the message", () => {
    assert.equal(sanitizeSymbol("x".repeat(200)).length, 16);
  });

  it("never returns empty — an unnamed token still needs a label", () => {
    assert.equal(sanitizeSymbol(""), "?");
    assert.equal(sanitizeSymbol("<<<>>>"), "?");
  });
});

describe("describeDiscovery — what the owner is told", () => {
  const base: Discovery = {
    token: CATE,
    symbol: "CATE",
    decimals: 18,
    createdAt: 0,
    liquidityUsdg: 120_000_000_000n, // $120k
    priceable: true,
    price8: 100_000n,
    fdvUsd: 800_000,
  };

  it("names the token, its depth and whether it can be priced", () => {
    const s = describeDiscovery(base);
    assert.match(s, /CATE/);
    assert.match(s, /120,000/);
    assert.match(s, /deep enough/);
  });

  it("gives the guard's own reason when it can't be priced", () => {
    const s = describeDiscovery({ ...base, priceable: false, reason: "pool too thin: 300 USDG" });
    assert.match(s, /can't price it yet/);
    assert.match(s, /too thin/);
  });

  it("handles an unpriceable pool with no depth reading at all", () => {
    const s = describeDiscovery({ ...base, liquidityUsdg: null, priceable: false, reason: "no route to USDG yet" });
    assert.match(s, /depth unknown/);
    assert.match(s, /no route/);
  });

  it("shows a truncated address so the owner can look it up", () => {
    assert.match(describeDiscovery(base), /0x00000000…/);
  });
});

/**
 * The launchpad half of discovery.
 *
 * A Pons launch is a different KIND of sighting from a Uniswap pool, and the
 * tests that matter are the ones where saying so is load-bearing: the owner's
 * price guards did not run, there is no pool to route through, and the depth
 * figure means something else. Getting any of those wrong reports a confidence
 * nothing established.
 */
describe("describeDiscovery — a Pons launch", () => {
  const launch: Discovery = {
    token: CATE,
    symbol: "PONSY",
    decimals: 18,
    createdAt: 0,
    liquidityUsdg: 640_000_000n, // $640
    priceable: false,
    reason: "trades on a Pons curve at 8.0% of graduation",
    price8: null,
    fdvUsd: null,
    curve: {
      curve: "0x00000000000000000000000000000000000000e1",
      quoteToken: `0x${"0".repeat(40)}`,
      graduationThresholdRaw: 4_200_000_000_000_000_000n,
      depthFraction: 0.08,
    },
  };

  it("does not call it a new PAIR — there is neither a pair nor a pool", () => {
    const s = describeDiscovery(launch);
    assert.ok(!/new pair/.test(s), "a pre-graduation token has no pool at all");
    assert.match(s, /pons launch/);
    assert.match(s, /trades on its curve/);
  });

  it("leads with progress toward graduation, the comparable measure", () => {
    // Depth in USD is not comparable across this launchpad: 42.8% of launches
    // are quoted in stock tokens and 2.3% in cbBTC, and the thresholds are not
    // a constant dollar value either. Progress along a curve's own threshold is.
    assert.match(describeDiscovery(launch), /8\.0% to graduation/);
  });

  it("still names the token and its depth", () => {
    const s = describeDiscovery(launch);
    assert.match(s, /PONSY/);
    assert.match(s, /\$640 deep/);
  });

  it("says depth unknown for a curve quoted in something we cannot price", () => {
    // Roughly half of launches are. Null must read as unknown, never as $0 —
    // those are different claims and only one of them is true.
    const s = describeDiscovery({ ...launch, liquidityUsdg: null });
    assert.match(s, /depth unknown/);
    assert.ok(!/\$0 deep/.test(s));
  });

  it("never claims the price guards passed", () => {
    // `priceable` means the owner's depth and divergence guards ran and were
    // satisfied. On a curve they cannot run at all — poolPriceUsable refuses
    // with no-twap before it even looks at depth.
    assert.equal(launch.priceable, false);
    assert.ok(!/deep enough for me to price/.test(describeDiscovery(launch)));
  });

  it("leaves the ORDINARY pool line untouched", () => {
    // The two shapes share one function; the pool wording is asserted above and
    // by four other tests in this file.
    assert.match(describeDiscovery({ ...launch, curve: undefined, priceable: true }), /new pair/);
  });
});

/**
 * The scan clock, which is where a silent hole would open.
 *
 * The window is measured from the last SUCCESSFUL pass. An earlier version
 * advanced it before the RPC call and returned early on failure, so the ~40
 * launches inside a failed window were read by no pass ever — and one transient
 * 429 from the RPC was enough to open one. These tests exist because that
 * failure produces no error and no log anyone would notice.
 */
describe("ponsScanWindow", () => {
  const base = { intervalSec: 300, blocksPerSec: 10n };

  it("is not due before the interval, and is due after", () => {
    assert.equal(ponsScanWindow({ ...base, lastSuccessAt: 1000, nowSec: 1200 }).due, false);
    assert.equal(ponsScanWindow({ ...base, lastSuccessAt: 1000, nowSec: 1300 }).due, true);
  });

  it("runs immediately on a cold start, looking back one interval", () => {
    const w = ponsScanWindow({ ...base, lastSuccessAt: 0, nowSec: 50_000 });
    assert.equal(w.due, true);
    assert.equal(w.lookbackBlocks, BigInt(300 + 60) * 10n);
  });

  it("WIDENS after a failure instead of skipping the window", () => {
    // The whole point. The caller does not advance lastSuccessAt on failure, so
    // the next pass must cover the failed window too.
    const first = ponsScanWindow({ ...base, lastSuccessAt: 1000, nowSec: 1300 });
    const afterFailure = ponsScanWindow({ ...base, lastSuccessAt: 1000, nowSec: 1600 });
    assert.ok(afterFailure.lookbackBlocks > first.lookbackBlocks, "the retry must reach further back");
    assert.equal(afterFailure.elapsedSec, 600, "two intervals of ground to make up");
  });

  it("covers the whole gap with no hole, across consecutive failures", () => {
    // Walk five passes where every one fails, then one succeeds, and check the
    // final window reaches back to the last success.
    const lastSuccess = 1000;
    for (let n = 1; n <= 5; n++) {
      const now = lastSuccess + 300 * n;
      const w = ponsScanWindow({ ...base, lastSuccessAt: lastSuccess, nowSec: now });
      const reachesBackTo = now - Number(w.lookbackBlocks / 10n);
      assert.ok(reachesBackTo <= lastSuccess, `pass ${n} left a hole: reaches ${reachesBackTo}, needs ${lastSuccess}`);
    }
  });

  it("overlaps rather than abutting — re-reading is free, missing is permanent", () => {
    const w = ponsScanWindow({ ...base, lastSuccessAt: 1000, nowSec: 1300 });
    const reachesBackTo = 1300 - Number(w.lookbackBlocks / 10n);
    assert.ok(reachesBackTo < 1000, "the window must extend past the last success, not stop at it");
  });

  it("never produces a negative lookback from a clock that went backwards", () => {
    // NTP correction, or a restored snapshot. A negative here would throw on
    // the BigInt conversion and take the pass down.
    const w = ponsScanWindow({ ...base, lastSuccessAt: 9_999, nowSec: 1_000 });
    assert.equal(w.elapsedSec, 0);
    assert.ok(w.lookbackBlocks >= 0n);
    assert.equal(w.due, false);
  });
});

/**
 * The per-pass evaluation cap.
 *
 * A normal pass sees ~40 launches. After an outage the lookback widens until it
 * clamps at ~8.4 hours — roughly 4,000 launches, and one sequential eth_call
 * each against a public RPC that already returns 429s under much less. The cap
 * exists so a catch-up pass cannot rate-limit the agent out of its own chain,
 * and the shortfall is reported rather than absorbed.
 */
describe("PONS_MAX_EVALUATE", () => {
  it("is large enough for an ordinary pass and small enough for a catch-up", () => {
    // ~40 launches per 5-minute pass at the measured 475/hour.
    assert.ok(PONS_MAX_EVALUATE >= 200, "an ordinary pass must never be truncated");
    assert.ok(PONS_MAX_EVALUATE <= 1000, "a clamped catch-up must not fire thousands of sequential calls");
  });
});

/**
 * Trending and graduated coins — the discoverer that sees what is TRADING.
 *
 * The other two discoverers watch things being born: a Uniswap Initialize
 * event, or a Pons launch. Both are blind by construction to a coin that
 * launched last week and is up 40% today. These tests are mostly about the
 * boundaries of what this one is allowed to do with what it finds.
 */
describe("discoverTrending", () => {
  const pool = (over: Partial<GeckoPool> = {}): GeckoPool => ({
    poolId: "0x" + "1".repeat(40),
    poolAddress: null,
    tokenAddress: `0x${"a".repeat(40)}`,
    name: "AAA / WETH",
    dex: "uniswap-v3-robinhood",
    priceUsd: 1,
    reserveUsd: 500_000,
    fdvUsd: 5_000_000,
    volume24hUsd: 900_000,
    change24hPct: 20,
    change1hPct: 1,
    buys24h: 900,
    sells24h: 700,
    buyers24h: 400,
    buckets: emptyGeckoBuckets(),
    createdAt: 1,
    ...over,
  });
  const LIMITS = { minReserveUsd: 25_000, minVolume24hUsd: 50_000, minBuyers24h: 100 };
  const keepAll = {
    name: "t",
    rank: async (ps: readonly GeckoPool[]) =>
      applyVerdicts(ps, { keep: ps.map((_, i) => ({ index: i, conviction: 3, reason: "r" })) }),
  };
  // A client whose ERC-20 reads always fail, so identity falls back to the
  // address — the path that must not throw.
  const blindClient = { async readContract() { throw new Error("no"); } } as never;

  const deps = (pools: GeckoPool[], over: Record<string, unknown> = {}) => ({
    client: blindClient,
    seen: new Set<string>(),
    known: [],
    fetchPools: async () => pools,
    scout: keepAll,
    limits: LIMITS,
    nowSec: 1_000,
    ...over,
  });

  it("dedupes a coin that appears on several venues, keeping the DEEPEST", async () => {
    // The owner cares about the coin, not the pool — and the deepest venue is
    // the one a trade would actually reach.
    const res = await discoverTrending(deps([pool({ reserveUsd: 100_000 }), pool({ reserveUsd: 800_000 })]) as never);
    assert.equal(res.picks.length, 1);
    assert.equal(res.picks[0]!.pool.reserveUsd, 800_000);
  });

  it("labels a GRADUATED coin as such, by venue slug", async () => {
    // pons-v2-dex is a coin that made it off its bonding curve into a real
    // pool; pons-v2 is one still on the curve, whose reported reserve is mostly
    // the virtual seed.
    const res = await discoverTrending(deps([pool({ dex: "pons-v2-dex" })]) as never);
    assert.equal(res.picks[0]!.graduated, true);
    const curve = await discoverTrending(deps([pool({ dex: "pons-v2", tokenAddress: `0x${"b".repeat(40)}` })]) as never);
    assert.equal(curve.picks[0]!.graduated, false);
  });

  it("says which kind it is in the owner-facing line", async () => {
    const grad = await discoverTrending(deps([pool({ dex: "pons-v2-dex" })]) as never);
    assert.match(describeTrending(grad.picks[0]!), /graduated/);
    const curve = await discoverTrending(deps([pool({ dex: "pons-v2" })]) as never);
    assert.match(describeTrending(curve.picks[0]!), /still on its curve/);
  });

  it("skips what the owner already has and what has already been reported", async () => {
    const seen = new Set([pool().tokenAddress]);
    assert.equal((await discoverTrending(deps([pool()], { seen }) as never)).picks.length, 0);
    const known = [{ symbol: "AAA", name: "AAA", address: pool().tokenAddress, chainlinkFeed: null, kind: "memecoin" }];
    assert.equal((await discoverTrending(deps([pool()], { known }) as never)).picks.length, 0);
  });

  it("does not fall over when the token is not a readable ERC-20", async () => {
    // It still trades, so it is still worth reporting — by address rather than
    // by a name nobody could verify.
    const res = await discoverTrending(deps([pool()]) as never);
    assert.match(res.picks[0]!.symbol, /^0x/);
  });

  it("NEVER takes the index's own label as the symbol", async () => {
    // GeckoTerminal's `name` is attacker-chosen text headed for a human and
    // could be picked to impersonate a real ticker. Identity comes from the
    // contract or from the address, never from the feed.
    const res = await discoverTrending(deps([pool({ name: "USDG / WETH" })]) as never);
    assert.ok(!res.picks[0]!.symbol.includes("USDG"));
  });

  it("picks NOTHING when there is no brain to narrow with", async () => {
    // nullScout is the safe default: this step exists to exclude, so with
    // nothing doing the excluding, nothing has been vetted.
    const res = await discoverTrending(deps([pool()], { scout: nullScout }) as never);
    assert.equal(res.picks.length, 0);
    assert.equal(res.screened, 1, "but it still reports what the screen kept");
  });

  it("reports the funnel honestly at every stage", async () => {
    const thin = pool({ tokenAddress: `0x${"c".repeat(40)}`, reserveUsd: 10 });
    const res = await discoverTrending(deps([pool(), thin]) as never);
    assert.equal(res.scanned, 2, "both were seen");
    assert.equal(res.screened, 1, "one cleared the screen");
    assert.equal(res.picks.length, 1);
  });
});

/**
 * A RESTART MUST NOT BLIND THE SCANNER.
 *
 * A child rebuilds its sqlite on redeploy, so its candidate table starts empty.
 * The class route reads a SIX HOUR candidate window; the scan interval is five
 * minutes. With a cold start treated as "one interval has passed", the first
 * pass reached back about six minutes of chain — so a restarted agent was blind
 * to everything that launched before it booted and needed six hours of
 * five-minute scans to rebuild what it already knew.
 *
 * The launch feed is derived from factory logs, so the chain is authoritative
 * and the table is only a cache. A cache that empties is refilled from the
 * source, not waited out.
 */
describe("the first scan after a restart reaches back over the whole window", () => {
  const SIX_HOURS = 6 * 3600;
  const base = { nowSec: 1_000_000, intervalSec: 300, blocksPerSec: 10n };

  it("REACHES THE FULL WINDOW on a cold start, not one interval", () => {
    const w = ponsScanWindow({ ...base, lastSuccessAt: 0, coldStartSec: SIX_HOURS });
    assert.equal(w.coldStart, true);
    assert.equal(w.due, true, "a cold start must scan immediately");
    // (21600 + 60 overlap) * 10 blocks/sec
    assert.equal(w.lookbackBlocks, BigInt((SIX_HOURS + 60) * 10));
  });

  it("and that reach is inside the node's log cap", () => {
    // MAX_LOOKBACK_BLOCKS is 300,000 (~8.4h), sized to stay under the 10,000-log
    // response cap at the measured 474.8 launches/hour. A warm-up that exceeded
    // it would be clamped — correct, but it would also mean the window the class
    // route reads can no longer be refilled in one pass.
    const w = ponsScanWindow({ ...base, lastSuccessAt: 0, coldStartSec: SIX_HOURS });
    assert.ok(w.lookbackBlocks <= 300_000n, `warm-up of ${w.lookbackBlocks} blocks would be clamped`);
  });

  it("but a WARM pass still reaches back only as far as it has been away", () => {
    // The whole point of widening only the first pass: conflating reach with
    // elapsed time would make every subsequent scan re-read six hours it has
    // already seen, every five minutes, forever.
    const w = ponsScanWindow({ ...base, lastSuccessAt: base.nowSec - 300, coldStartSec: SIX_HOURS });
    assert.equal(w.coldStart, false);
    assert.equal(w.lookbackBlocks, BigInt((300 + 60) * 10));
  });

  it("and without a coldStartSec the old behaviour is unchanged", () => {
    // Every other caller of this function keeps what it had.
    const w = ponsScanWindow({ ...base, lastSuccessAt: 0 });
    assert.equal(w.lookbackBlocks, BigInt((300 + 60) * 10));
  });

  it("a cold start never reaches back LESS than a normal pass would", () => {
    // If an operator set a coldStartSec smaller than the interval, the warm-up
    // must not become a narrowing.
    const w = ponsScanWindow({ ...base, lastSuccessAt: 0, coldStartSec: 60 });
    assert.ok(w.lookbackBlocks >= BigInt((300 + 60) * 10));
  });
});
