import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicClient } from "viem";
import {
  UI_MULTIPLIER_ONE,
  curveMarkedSymbols,
  mayRatchetHwm,
  positionValueUsdg,
  readPositions,
  valuationMultiplierFor,
  type Position,
} from "./positions";
import type { PriceQuote, StockToken } from "../../packages/core/src/index";

const ONE = 10n ** 18n; // 1.0 in both raw-balance (18dp) and multiplier terms
const usd = (v: number) => BigInt(Math.round(v * 1e8)); // Chainlink 8dp

describe("positionValueUsdg (ERC-8056)", () => {
  it("values a whole share at multiplier 1.0", () => {
    // 1 AAPL raw × 1.0 × $250 = 250 USDG (6dp)
    const v = positionValueUsdg({ rawBalance: ONE, uiMultiplier: ONE, price8: usd(250) });
    assert.equal(v, 250_000_000n);
  });

  it("values fractional holdings", () => {
    // 0.5 shares × 1.0 × $100 = 50 USDG
    const v = positionValueUsdg({ rawBalance: ONE / 2n, uiMultiplier: ONE, price8: usd(100) });
    assert.equal(v, 50_000_000n);
  });

  it("a 2-for-1 split is NOT a crash: multiplier doubles, price halves, value unchanged", () => {
    const before = positionValueUsdg({ rawBalance: ONE, uiMultiplier: ONE, price8: usd(500) });
    const after = positionValueUsdg({ rawBalance: ONE, uiMultiplier: 2n * ONE, price8: usd(250) });
    assert.equal(before, after);
    assert.equal(after, 500_000_000n);
  });

  it("ignoring the multiplier WOULD have looked like a 50% crash (the bug this prevents)", () => {
    const naiveAfterSplit = positionValueUsdg({ rawBalance: ONE, uiMultiplier: ONE, price8: usd(250) });
    assert.equal(naiveAfterSplit, 250_000_000n); // half of the true 500
  });

  it("a 10% stock dividend scales value by the multiplier", () => {
    const v = positionValueUsdg({
      rawBalance: ONE,
      uiMultiplier: (11n * ONE) / 10n,
      price8: usd(100),
    });
    assert.equal(v, 110_000_000n);
  });

  it("zero balance is zero value", () => {
    assert.equal(positionValueUsdg({ rawBalance: 0n, uiMultiplier: ONE, price8: usd(999) }), 0n);
  });

  it("keeps precision on realistic dust (0.0342092 QQQ @ $575.31)", () => {
    const raw = 34_209_200_024_468_519n; // ~0.0342 in 18dp
    const v = positionValueUsdg({ rawBalance: raw, uiMultiplier: ONE, price8: usd(575.31) });
    // 0.034209200024468519 × 575.31 = 19.680894866… → floors to 19.680894 USDG
    assert.equal(v, 19_680_894n);
  });
});

/**
 * Stock Tokens are 18dp; a memecoin is whatever its author chose. The asset model
 * divides by 10^decimals, so assuming 18 for a 6dp coin undervalues the position
 * by a factor of a trillion — and equity feeds the drawdown breaker, so that is
 * not a display bug, it's a phantom wipeout.
 */
describe("positionValueUsdg — decimals are not always 18", () => {
  it("values a 6dp token correctly (USDC-style)", () => {
    // 1 whole token at 6dp = 1_000_000 raw, at $2 → 2 USDG
    const v = positionValueUsdg({
      rawBalance: 1_000_000n,
      uiMultiplier: ONE,
      price8: usd(2),
      decimals: 6,
    });
    assert.equal(v, 2_000_000n);
  });

  it("values a 9dp token correctly", () => {
    const v = positionValueUsdg({
      rawBalance: 1_000_000_000n,
      uiMultiplier: ONE,
      price8: usd(0.5),
      decimals: 9,
    });
    assert.equal(v, 500_000n); // $0.50
  });

  it("values a 0dp token correctly — no fractional units at all", () => {
    const v = positionValueUsdg({ rawBalance: 3n, uiMultiplier: ONE, price8: usd(7), decimals: 0 });
    assert.equal(v, 21_000_000n);
  });

  it("assuming 18 for a 6dp holding would have wiped it out (the bug this prevents)", () => {
    const naive = positionValueUsdg({ rawBalance: 1_000_000n, uiMultiplier: ONE, price8: usd(2) });
    assert.equal(naive, 0n, "a real $2 position reads as zero — equity craters, breaker trips");
  });

  it("omitting decimals still means 18, so every existing stock call is unchanged", () => {
    const implicit = positionValueUsdg({ rawBalance: ONE, uiMultiplier: ONE, price8: usd(250) });
    const explicit = positionValueUsdg({ rawBalance: ONE, uiMultiplier: ONE, price8: usd(250), decimals: 18 });
    assert.equal(implicit, explicit);
    assert.equal(implicit, 250_000_000n);
  });
});

const tok = (symbol: string, address: `0x${string}`): StockToken => ({
  symbol,
  name: symbol,
  address,
  chainlinkFeed: "0x0000000000000000000000000000000000000001",
  kind: "stock",
});
/** No feed configured at all — every memecoin, and any delisted feed. */
const feedless = (symbol: string, address: `0x${string}`): StockToken => ({
  ...tok(symbol, address),
  chainlinkFeed: null,
});
const AAPL = tok("AAPL", "0x00000000000000000000000000000000000000a1");
const TSLA = tok("TSLA", "0x00000000000000000000000000000000000000b2");
/** A Chainlink quote — the default provenance everywhere in this file. */
const px = (v: number, stale = false) => ({ price8: usd(v), stale, source: "chainlink" as const });
const good = (result: unknown) => ({ status: "success" as const, result });
const bad = () => ({ status: "failure" as const, error: new Error("revert") });
const client = (results: unknown[]): PublicClient => ({ multicall: async () => results }) as unknown as PublicClient;
const ACCT = "0x000000000000000000000000000000000000dEaD" as const;

describe("readPositions — a held holding is never silently valued at zero", () => {
  it("a held token with a price is valued and not flagged", async () => {
    const prices = new Map([["AAPL", px(200)]]);
    const r = await readPositions(client([good(5n * ONE), good(ONE)]), ACCT, [AAPL], prices);
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0]?.symbol, "AAPL");
    assert.deepEqual(r.missingPrice, []);
  });

  it("a HELD token whose feed price is missing goes to missingPrice (the equity-crater bug)", async () => {
    const r = await readPositions(client([good(5n * ONE), good(ONE)]), ACCT, [AAPL], new Map());
    assert.deepEqual(r.positions, []);
    assert.deepEqual(r.missingPrice, ["AAPL"]);
  });

  it("a HELD token whose multiplier read reverts is flagged, not mispriced at 1.0", async () => {
    const prices = new Map([["AAPL", px(200)]]);
    const r = await readPositions(client([good(5n * ONE), bad()]), ACCT, [AAPL], prices);
    assert.deepEqual(r.positions, []);
    assert.deepEqual(r.missingPrice, ["AAPL"]);
  });

  it("a zero-balance token is not held — absent from both lists (not a coverage gap)", async () => {
    const prices = new Map([["AAPL", px(200)]]);
    const r = await readPositions(client([good(0n), good(ONE)]), ACCT, [AAPL], prices);
    assert.deepEqual(r.positions, []);
    assert.deepEqual(r.missingPrice, []);
  });

  it("mixed: one priced holding valued, one unpriced holding flagged", async () => {
    const prices = new Map([["AAPL", px(200)]]); // TSLA absent
    const r = await readPositions(client([good(ONE), good(ONE), good(2n * ONE), good(ONE)]), ACCT, [AAPL, TSLA], prices);
    assert.deepEqual(r.positions.map((p) => p.symbol), ["AAPL"]);
    assert.deepEqual(r.missingPrice, ["TSLA"]);
  });

  it("stale-but-present price still values the holding (weekend prices aren't a gap)", async () => {
    const prices = new Map([["AAPL", px(200, true)]]);
    const r = await readPositions(client([good(5n * ONE), good(ONE)]), ACCT, [AAPL], prices);
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0]?.priceStale, true);
    assert.deepEqual(r.missingPrice, []);
  });

  it("a totally failed multicall values nothing and reports no false holdings", async () => {
    const broken = { multicall: async () => { throw new Error("rpc down"); } } as unknown as PublicClient;
    const r = await readPositions(broken, ACCT, [AAPL], new Map());
    assert.deepEqual(r.positions, []);
    assert.deepEqual(r.missingPrice, []);
    assert.deepEqual(r.unpricedByDesign, []);
    // …and SAYS SO. Reporting nothing held is only safe if the caller can tell
    // it apart from holding nothing; without this flag the tick sailed on and
    // booked positionsUsdg = 0 for a held book — a phantom 100% crater from one
    // RPC hiccup, which is the 30% drawdown row sitting in the July ledger.
    assert.equal(r.readFailed, true);
    // And every token is unread, by name: nothing about any of them is known.
    assert.deepEqual(r.unreadBalances, ["AAPL"]);
  });

  it("a successful read is marked as one, so an empty book is believable", async () => {
    const r = await readPositions(client([good(0n), good(ONE)]), ACCT, [AAPL], new Map());
    assert.deepEqual(r.positions, []);
    assert.equal(r.readFailed, false);
    assert.deepEqual(r.unreadBalances, []);
  });
});

/**
 * ONE FAILED BALANCE ROW IS NOT A ZERO BALANCE.
 *
 * viem's multicall does not throw when one chunk of it is rate-limited: every
 * call in that chunk comes back `{ status: "failure" }` and the rest succeed.
 * readPositions skipped such a row exactly like a zero and reported
 * `readFailed: false`, so the tick's stranded-basis sweep read a held token as
 * gone and closed its basis (Shogun's GATO, 2026-11-04 08:36 UTC).
 */
describe("readPositions — one failed balance row among good ones", () => {
  const GATO: StockToken = { ...feedless("GATO", "0x436b01e41314d4b010edd24cf7c997a7d111c0ab"), kind: "memecoin" };
  const rateLimited = () => ({ status: "failure" as const, error: new Error("HTTP request failed. Status: 429") });

  it("names the token as unread, and does not report it as held or as flat", async () => {
    const prices = new Map([["AAPL", px(200)]]);
    // AAPL: balance + multiplier; GATO (memecoin): balance only, and it failed.
    const r = await readPositions(client([good(5n * ONE), good(ONE), rateLimited()]), ACCT, [AAPL, GATO], prices);
    assert.deepEqual(r.unreadBalances, ["GATO"]);
    // The rest of the read is still used — one token's gap is not the whole book's.
    assert.equal(r.readFailed, false);
    assert.deepEqual(r.positions.map((p) => p.symbol), ["AAPL"]);
    // And GATO is in no holding list: nothing was learned about it either way.
    assert.deepEqual(r.missingPrice, []);
    assert.deepEqual(r.unpricedByDesign, []);
  });

  it("the same token with a balance that DID come back is held, not unread", async () => {
    const r = await readPositions(client([good(5n * ONE), good(ONE), good(2_842n * ONE)]), ACCT, [AAPL, GATO], new Map([["AAPL", px(200)]]));
    assert.deepEqual(r.unreadBalances, []);
    assert.deepEqual(r.unpricedByDesign, ["GATO"]);
  });

  it("and a balance that came back ZERO is the only flat answer", async () => {
    const r = await readPositions(client([good(5n * ONE), good(ONE), good(0n)]), ACCT, [AAPL, GATO], new Map([["AAPL", px(200)]]));
    assert.deepEqual(r.unreadBalances, []);
    assert.deepEqual(r.unpricedByDesign, []);
  });

  it("a failed MULTIPLIER on a held token is still a missing price, not an unread balance", async () => {
    // The balance answered, so the holding is known; only its valuation is not.
    const r = await readPositions(client([good(5n * ONE), bad()]), ACCT, [AAPL], new Map([["AAPL", px(200)]]));
    assert.deepEqual(r.unreadBalances, []);
    assert.deepEqual(r.missingPrice, ["AAPL"]);
  });

  it("a failed balance row on a Stock Token is unread too, whatever its multiplier said", async () => {
    const r = await readPositions(client([rateLimited(), good(ONE)]), ACCT, [AAPL], new Map([["AAPL", px(200)]]));
    assert.deepEqual(r.unreadBalances, ["AAPL"]);
    assert.deepEqual(r.positions, []);
    assert.deepEqual(r.missingPrice, []);
  });
});

/**
 * THE RAW BALANCE OF EVERY ROW THAT ANSWERED, for the Trencher vault's routing.
 *
 * The tick used to read the vault twice — this read for the valuation, and a
 * second raw `balanceOf` multicall for the custody routing — and the second
 * one turned ONE failed row into `readFailed`, which froze every exit on the
 * agent for as long as that row kept failing. The routing is built from this
 * map now, so it must carry everything the raw read did: a held coin whether
 * or not it can be valued, and nothing for a row that failed or read zero.
 */
describe("readPositions — balances, every row that answered", () => {
  const MEME: StockToken = { ...feedless("MEME", "0x00000000000000000000000000000000000000C4"), kind: "memecoin" };
  const GATO: StockToken = { ...feedless("GATO", "0x436B01E41314d4b010edd24cf7c997a7d111c0ab"), kind: "memecoin" };
  const ZERO: StockToken = { ...feedless("ZERO", "0x00000000000000000000000000000000000000c5"), kind: "memecoin" };
  const rateLimited = () => ({ status: "failure" as const, error: new Error("HTTP request failed. Status: 429") });

  it("a priced holding and an unpriced one are both there, by lowercased address; a failed row and a zero are not", async () => {
    const r = await readPositions(
      // AAPL: balance + multiplier; MEME, GATO, ZERO: balance only.
      client([good(5n * ONE), good(ONE), good(7n * ONE), rateLimited(), good(0n)]),
      ACCT,
      [AAPL, MEME, GATO, ZERO],
      new Map([["AAPL", px(200)]]),
    );
    assert.deepEqual(
      [...r.balances.entries()].sort(),
      [
        ["0x00000000000000000000000000000000000000a1", 5n * ONE],
        ["0x00000000000000000000000000000000000000c4", 7n * ONE],
      ],
    );
    assert.ok(!r.balances.has(GATO.address.toLowerCase()), "a failed row is no balance");
    assert.ok(!r.balances.has(ZERO.address.toLowerCase()), "a zero is no balance");
    // ONE FAILED ROW IS THAT TOKEN, UNREAD — never the whole read failing.
    assert.deepEqual(r.unreadBalances, ["GATO"]);
    assert.equal(r.readFailed, false);
  });

  it("a held Stock Token whose multiplier failed is a missing price AND a balance — it is held, only unvalued", async () => {
    const r = await readPositions(client([good(5n * ONE), bad()]), ACCT, [AAPL], new Map([["AAPL", px(200)]]));
    assert.deepEqual(r.missingPrice, ["AAPL"]);
    assert.equal(r.balances.get(AAPL.address.toLowerCase()), 5n * ONE);
  });

  it("a whole read that failed has no balances at all, and says so", async () => {
    const broken = { multicall: async () => { throw new Error("rpc down"); } } as unknown as PublicClient;
    const r = await readPositions(broken, ACCT, [AAPL, MEME], new Map());
    assert.equal(r.readFailed, true);
    assert.equal(r.balances.size, 0);
  });
});

/**
 * A feed that FAILED is transient — hold and retry. A feed that doesn't EXIST
 * never recovers, and treating the two alike froze the tick permanently: no
 * equity, no breaker, no strategy run, and therefore no way to sell out of the
 * position. Every memecoin is in the second category, so this distinction is
 * what makes holding one survivable at all.
 */
describe("readPositions — a missing feed is not a failed feed", () => {
  const DOGE = feedless("DOGE", "0x00000000000000000000000000000000000000c3");

  it("a held token with NO feed configured is unpricedByDesign, not missingPrice", async () => {
    const r = await readPositions(client([good(5n * ONE), good(ONE)]), ACCT, [DOGE], new Map());
    assert.deepEqual(r.unpricedByDesign, ["DOGE"], "permanent condition, reported as such");
    assert.deepEqual(r.missingPrice, [], "must NOT look like a transient hiccup");
    assert.deepEqual(r.positions, [], "still not valued — we genuinely don't know what it's worth");
  });

  it("a held token WITH a feed that didn't read stays transient", async () => {
    const r = await readPositions(client([good(5n * ONE), good(ONE)]), ACCT, [AAPL], new Map());
    assert.deepEqual(r.missingPrice, ["AAPL"]);
    assert.deepEqual(r.unpricedByDesign, []);
  });

  it("separates the two when both are held at once", async () => {
    const r = await readPositions(
      client([good(ONE), good(ONE), good(2n * ONE), good(ONE)]),
      ACCT,
      [AAPL, DOGE],
      new Map(), // neither priced
    );
    assert.deepEqual(r.missingPrice, ["AAPL"], "feed exists → retry");
    assert.deepEqual(r.unpricedByDesign, ["DOGE"], "no feed → don't wait, don't freeze");
  });

  it("a feedless token that is NOT held is simply absent", async () => {
    const r = await readPositions(client([good(0n), good(ONE)]), ACCT, [DOGE], new Map());
    assert.deepEqual(r.unpricedByDesign, [], "nothing held, nothing to report");
    assert.deepEqual(r.missingPrice, []);
  });

  it("a feedless token still values normally if a price IS supplied (e.g. a DEX quote)", async () => {
    // The seam for Phase 3: once a non-Chainlink price source exists, feeding it
    // through this same map values the position with no further changes here.
    const prices = new Map([["DOGE", px(0.42)]]);
    const r = await readPositions(client([good(100n * ONE), good(ONE)]), ACCT, [DOGE], prices);
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0]?.symbol, "DOGE");
    assert.deepEqual(r.unpricedByDesign, []);
  });
});

/**
 * A memecoin is not a Stock Token. It has no uiMultiplier(), so ASKING reverts —
 * and the old code read that revert as "held but unvaluable", the transient gap
 * that halts the tick and retries forever. It also isn't necessarily 18dp.
 */
describe("readPositions — memecoins are not ERC-8056", () => {
  const CATE: StockToken = {
    symbol: "CATE",
    name: "CATE",
    address: "0x00000000000000000000000000000000000000e4",
    chainlinkFeed: null,
    kind: "memecoin",
    decimals: 18,
  };
  const SIXDP: StockToken = { ...CATE, symbol: "SIXDP", address: "0x00000000000000000000000000000000000000e5", decimals: 6 };

  it("reads ONE call for a memecoin, not two — the multiplier is never requested", async () => {
    // Only a balance is mocked. Under the old two-call layout this would have
    // read the next token's balance as CATE's multiplier.
    const prices = new Map([["CATE", px(2)]]);
    const r = await readPositions(client([good(5n * ONE)]), ACCT, [CATE], prices);
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0]?.uiMultiplier, ONE, "assumed 1.0, not read from the token");
    assert.deepEqual(r.missingPrice, []);
  });

  it("keeps stock and memecoin call layouts straight when mixed", async () => {
    // AAPL contributes balance + multiplier; CATE contributes balance only.
    const prices = new Map([["AAPL", px(200)], ["CATE", px(2)]]);
    const r = await readPositions(
      client([good(ONE), good(ONE), good(3n * ONE)]),
      ACCT,
      [AAPL, CATE],
      prices,
    );
    assert.deepEqual(r.positions.map((p) => p.symbol), ["AAPL", "CATE"]);
    assert.equal(r.positions[0]?.valueUsdg, 200_000_000n);
    assert.equal(r.positions[1]?.valueUsdg, 6_000_000n, "3 CATE × $2");
  });

  it("values a 6dp memecoin off its own decimals, not 18", async () => {
    const prices = new Map([["SIXDP", px(2)]]);
    // 5 whole tokens at 6dp
    const r = await readPositions(client([good(5_000_000n)]), ACCT, [SIXDP], prices);
    assert.equal(r.positions[0]?.valueUsdg, 10_000_000n, "$10, not $0");
    assert.equal(r.positions[0]?.decimals, 6);
  });

  it("carries the price's provenance onto the position", async () => {
    const prices = new Map([
      ["CATE", { price8: usd(2), stale: false, source: "pool" as const, detail: "15m TWAP" }],
    ]);
    const r = await readPositions(client([good(ONE)]), ACCT, [CATE], prices);
    assert.equal(r.positions[0]?.priceSource, "pool");
  });

  it("an unpriced memecoin is still unpricedByDesign — refusing to price it must not freeze the tick", async () => {
    const r = await readPositions(client([good(ONE)]), ACCT, [CATE], new Map());
    assert.deepEqual(r.unpricedByDesign, ["CATE"]);
    assert.deepEqual(r.missingPrice, [], "never the transient list — that halts trading");
  });
});

/**
 * Chainlink quotes USD per ERC-8056 UI SHARE; a Uniswap pool quotes USD per
 * WHOLE ERC-20 TOKEN, which already reflects any split — the market repriced.
 * Multiplying a pool price by uiMultiplier therefore counts the split twice.
 */
describe("readPositions — a pool price is per raw token, so the multiplier must not apply", () => {
  const SPLIT = 2n * 10n ** 18n; // uiMultiplier after a 2-for-1

  it("applies the multiplier to a Chainlink price", () => {
    // 100 raw × 2.0 shares/raw × $10/share = $2,000
    const r = positionValueUsdg({ rawBalance: 100n * ONE, uiMultiplier: SPLIT, price8: usd(10) });
    assert.equal(r, 2_000_000_000n);
  });

  it("does NOT apply it to a pool price — the pool already repriced the raw token", async () => {
    // Same holding, priced from a pool at $20 per RAW token = $2,000 true.
    const prices = new Map([["AAPL", { price8: usd(20), stale: false, source: "pool" as const }]]);
    const r = await readPositions(
      client([good(100n * ONE), good(SPLIT)]),
      ACCT,
      [AAPL],
      prices,
    );
    assert.equal(
      r.positions[0]?.valueUsdg,
      2_000_000_000n,
      "double-counting the split would report $4,000 — a peak that never happened",
    );
  });

  it("still REPORTS the real multiplier, it just doesn't value with it", async () => {
    const prices = new Map([["AAPL", { price8: usd(20), stale: false, source: "pool" as const }]]);
    const r = await readPositions(client([good(ONE), good(SPLIT)]), ACCT, [AAPL], prices);
    assert.equal(r.positions[0]?.uiMultiplier, SPLIT, "the fact is preserved for display");
  });
});

describe("valuationMultiplierFor — the unit each price source implies", () => {
  const SPLIT = 2n * 10n ** 18n; // uiMultiplier after a 2-for-1

  it("chainlink applies the ERC-8056 multiplier; pool and broker do not", () => {
    assert.equal(valuationMultiplierFor("chainlink", SPLIT), SPLIT);
    assert.equal(valuationMultiplierFor("pool", SPLIT), ONE);
    assert.equal(valuationMultiplierFor("broker", SPLIT), ONE);
  });

  it("a broker quote after a 2-for-1 split must NOT double-count (the hazard the old ternary had)", () => {
    // Broker share counts are already split-adjusted and the broker price is per
    // that share. The pre-refactor code (`source === "pool" ? 1e18 : uiMultiplier`)
    // dropped every non-pool source into the Chainlink arm — so a broker quote
    // would have inherited the multiplier and read 2x after a split, ratcheting
    // a phantom high-water mark and eventually tripping the breaker.
    const value = positionValueUsdg({
      rawBalance: ONE, // 1 share as the broker counts it
      uiMultiplier: valuationMultiplierFor("broker", SPLIT), // SPLIT=2.0 must be ignored
      price8: usd(250), // post-split per-share price
    });
    assert.equal(value, 250_000_000n, "$250, not the double-counted $500");
  });
});

/**
 * No curve mark may set a high-water mark.
 *
 * This rule regressed the first time it was written: the guard was applied to
 * the fee and the database write but not to the in-memory peak the drawdown
 * BREAKER divides by. A curve spike then a revert therefore halted every
 * non-exit intent on a drawdown that never happened, for the rest of the
 * process — and because the inflated peak was never persisted, nothing but a
 * restart cleared it. Naming the rule is what makes it testable.
 */
describe("mayRatchetHwm", () => {
  const pos = (symbol: string, source: PriceQuote["source"]): Position => ({
    symbol,
    token: `0x${"1".repeat(40)}`,
    rawBalance: 10n ** 18n,
    uiMultiplier: UI_MULTIPLIER_ONE,
    decimals: 18,
    price8: 100_000_000n,
    priceStale: false,
    priceSource: source,
    valueUsdg: 1_000_000n,
  });

  it("allows a book with no curve marks in it", () => {
    assert.equal(mayRatchetHwm([]), true);
    assert.equal(mayRatchetHwm([pos("NVDA", "chainlink"), pos("CATE", "pool")]), true);
  });

  it("refuses as soon as ONE holding is valued off a curve", () => {
    // Not proportional and not per-position: equity is a single total, so one
    // unoracled mark inside it makes the whole figure unfit to set a peak.
    assert.equal(mayRatchetHwm([pos("NVDA", "chainlink"), pos("PONSY", "curve")]), false);
  });

  it("names which holdings caused it, for the log", () => {
    assert.deepEqual(curveMarkedSymbols([pos("A", "pool"), pos("B", "curve"), pos("C", "curve")]), ["B", "C"]);
  });

  it("treats a broker price as ordinary — it has a venue behind it", () => {
    assert.equal(mayRatchetHwm([pos("AAPL", "broker")]), true);
  });
});
