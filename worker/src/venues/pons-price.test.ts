import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CURVE_GUARD_DEFAULTS,
  curveBuyImpactBps,
  curveFdvUsd8,
  curveFloorDrawdownBps,
  curvePriceUsable,
  curveDepthFraction,
  curveGraduated,
  curvePrice,
  realQuoteRaw,
  virtualSeedRaw,
  curveBuyOut,
  curveSellOut,
  curveMinOut,
  CURVE_FEE_BPS,
  type CurveReserves,
} from "./pons-price";

/**
 * Pricing a bonding curve, checked against real ones.
 *
 * A CORRECTION THESE TESTS EXIST TO PIN. The first version of this suite took
 * the fixture below — 1.6838 ETH against a 4.2 ETH threshold — and asserted it
 * was "~40% of the way to graduation", calling that an independent sanity check
 * that the units were right. It was not independent and it was not a check: Pons
 * seeds every curve with a VIRTUAL reserve of exactly 0.4 x threshold, so 1.68
 * against 4.2 is the constant 0.4 being rediscovered, and it would read the same
 * on a curve that had never traded. That curve held 0.0038 ETH. It was 0.09% of
 * the way, and the old suite asserted the seed as both depth and progress.
 *
 * The lesson worth keeping: a figure that "comes out to a plausible round
 * number" is evidence of a constant, not of correctness. What separates them is
 * a second, unrelated observation — here, the contract's own balance.
 */

// A real mainnet curve: 0x312a8dff…, native-ETH quoted, threshold 4.2 ETH.
const LIVE: CurveReserves = {
  quoteRaw: 1683772225727764056n, // 1.68 virtual seed + 0.00377 real
  tokenRaw: 997759657945341386015177738n,
  quoteDecimals: 18,
  tokenDecimals: 18,
  graduationThresholdRaw: 4_200_000_000_000_000_000n,
};
// The real ETH price on chain 4663 when these reserves were read.
const ETH_USD8 = 244_237_000_000n; // $2,442.37

/**
 * A second real curve, read 2026-08-29, whose REAL reserve is corroborated by
 * something outside the curve's own arithmetic: the contract's ETH balance.
 * getReserves() reported 0.4035 x threshold; r0 - 0.4 x threshold = 0.0147 ETH;
 * eth_getBalance said 0.015 ETH held. That agreement — not a round number — is
 * what establishes the seed model.
 */
const CORROBORATED: CurveReserves = {
  quoteRaw: 1694700000000000000n, // 0.40350 x 4.2e18
  tokenRaw: 990_000_000n * 10n ** 18n,
  quoteDecimals: 18,
  tokenDecimals: 18,
  graduationThresholdRaw: 4_200_000_000_000_000_000n,
};

describe("the virtual seed", () => {
  it("is 40% of the curve's own threshold", () => {
    assert.equal(virtualSeedRaw(4_200_000_000_000_000_000n), 1_680_000_000_000_000_000n);
    // Thresholds are per quote asset, not a constant — a 6dp USDG curve too.
    assert.equal(virtualSeedRaw(8_090_000_000n), 3_236_000_000n);
    assert.equal(virtualSeedRaw(0n), 0n, "no threshold, no seed to subtract");
  });

  it("leaves the real reserve, corroborated by the contract's own balance", () => {
    // 0.0147 ETH computed here; eth_getBalance on that curve said 0.015 held.
    const real = Number(realQuoteRaw(CORROBORATED)) / 1e18;
    assert.ok(Math.abs(real - 0.0147) < 0.0005, `expected ~0.0147 ETH, got ${real}`);
  });

  it("reports a curve nobody has bought as holding NOTHING", () => {
    // The bug this whole change is about: a fresh curve reads 1.68 ETH of
    // reserve while its balance is zero. Depth must be 0, not $4,106.
    const fresh: CurveReserves = { ...LIVE, quoteRaw: 1_680_000_000_000_000_000n };
    assert.equal(realQuoteRaw(fresh), 0n);
    assert.equal(curvePrice(fresh, ETH_USD8)!.depthUsd8, 0n);
    assert.equal(curveDepthFraction(fresh), 0);
  });

  it("never goes negative when a curve reads below its seed", () => {
    // No sampled curve does, so this means the seed model is wrong for it —
    // and "nothing" is the honest answer, not a negative that would compare as
    // less than every floor and quietly pass a `< min` test in the wrong
    // direction.
    assert.equal(realQuoteRaw({ ...LIVE, quoteRaw: 1n }), 0n);
  });
});

describe("curvePrice", () => {
  it("prices the live mainnet curve at a sane figure", () => {
    const p = curvePrice(LIVE, ETH_USD8);
    assert.ok(p);
    // CROSS-CHECKED AGAINST AN INDEPENDENT SOURCE. GeckoTerminal, which indexes
    // this chain and this pre-graduation curve, reported 4.246263e-6 for the
    // same token; this computes 4.120e-6 from the raw reserves — 3% apart,
    // which is block skew plus the curve's own fee, not a modelling error.
    const usd = Number(p!.price8) / 1e8;
    const gecko = 4.246263e-6;
    assert.ok(Math.abs(usd - gecko) / gecko < 0.06, `${usd.toExponential(3)} vs gecko ${gecko.toExponential(3)}`);
  });

  it("prices from the FULL reserve, seed included — that is what the curve does", () => {
    // Verified to 1 wei against real observed buys: the constant product uses
    // the seeded reserve. This is deliberate, not an oversight, and the cost of
    // getting it backwards is stark — against the 0.00377 ETH real reserve the
    // same token prices below 1e-8 and comes back UNPRICEABLE, so a young curve
    // would look like it had no price at all rather than a small one.
    assert.ok(curvePrice(LIVE, ETH_USD8)!.price8 > 0n);
    assert.equal(curvePrice({ ...LIVE, quoteRaw: realQuoteRaw(LIVE) }, ETH_USD8), null);
  });

  it("reports DEPTH as the real money only", () => {
    // 0.00377 ETH at $2,442.37 is about $9.21 — not the $4,112 the first
    // version of this file asserted.
    const depth = Number(curvePrice(LIVE, ETH_USD8)!.depthUsd8) / 1e8;
    assert.ok(depth > 8 && depth < 11, `expected ~$9.21 of real depth, got $${depth.toFixed(2)}`);
    assert.ok(depth < 100, "the virtual seed must never be counted as depth");
  });

  it("does not lose the price to integer division", () => {
    // A memecoin is ~1e-9 of its quote asset. Dividing before multiplying would
    // floor this to zero and report a free token.
    assert.ok(curvePrice(LIVE, ETH_USD8)!.price8 > 0n);
  });

  it("handles a 6dp quote (USDG) as well as an 18dp one", () => {
    const usdgCurve: CurveReserves = {
      quoteRaw: 10_000_000_000n, // 10,000 USDG at 6dp
      tokenRaw: 1_000_000_000n * 10n ** 18n,
      quoteDecimals: 6,
      tokenDecimals: 18,
      graduationThresholdRaw: 8_090_000_000n, // the observed USDG threshold
    };
    const p = curvePrice(usdgCurve, 100_000_000n); // USDG = $1.00
    assert.ok(p);
    // $10,000 across 1e9 tokens = $1e-5 each — priced off the full reserve.
    assert.equal(p!.price8, 1_000n);
    // Depth is 10,000 - 3,236 seed = 6,764 USDG.
    assert.equal(p!.depthUsd8, 676_400_000_000n);
  });

  it("returns null — never zero — when it cannot price", () => {
    // "Missing fact" and "worthless" must not be the same value: positions are
    // valued with this.
    assert.equal(curvePrice({ ...LIVE, quoteRaw: 0n }, ETH_USD8), null, "empty quote side");
    assert.equal(curvePrice({ ...LIVE, tokenRaw: 0n }, ETH_USD8), null, "empty token side");
    assert.equal(curvePrice(LIVE, 0n), null, "no USD price for the quote asset");
  });

  it("refuses a token too numerous to price at 8dp rather than rounding to free", () => {
    const dust: CurveReserves = { ...LIVE, quoteRaw: 1n, tokenRaw: 10n ** 36n };
    assert.equal(curvePrice(dust, ETH_USD8), null);
  });
});

describe("curveBuyImpactBps", () => {
  it("charges more impact for a bigger bite of the same curve", () => {
    const small = curveBuyImpactBps(LIVE, 10n ** 16n); // 0.01 ETH
    const large = curveBuyImpactBps(LIVE, 10n ** 18n); // 1 ETH
    assert.ok(small !== null && large !== null);
    assert.ok(large! > small!, "a larger trade must cost more, not less");
    assert.ok(small! > 0 && small! < 200, `expected a small positive bps, got ${small}`);
  });

  it("uses the seeded reserve, so an early buy is not priced as an empty pool", () => {
    // Against the REAL 0.00377 ETH reserve, a 0.01 ETH buy would look
    // catastrophic. Against the seeded reserve — which is what the contract
    // actually computes with — it is small. Getting this backwards would
    // reject every young curve for impact it does not really incur.
    const seeded = curveBuyImpactBps(LIVE, 10n ** 16n)!;
    const unseeded = curveBuyImpactBps({ ...LIVE, quoteRaw: realQuoteRaw(LIVE) }, 10n ** 16n)!;
    assert.ok(unseeded > seeded * 10, `seeded ${seeded}bps vs unseeded ${unseeded}bps`);
  });

  it("returns null rather than 0 when a trade cannot be evaluated", () => {
    assert.equal(curveBuyImpactBps(LIVE, 0n), null);
    assert.equal(curveBuyImpactBps({ ...LIVE, quoteRaw: 0n }, 10n ** 16n), null);
  });

  it("impact is exact, not sampled — it follows from x*y=k", () => {
    const huge = curveBuyImpactBps(LIVE, 10n ** 24n);
    assert.ok(huge !== null && huge > 0);
  });
});

describe("curveDepthFraction", () => {
  it("puts the live curve at 0.09% of threshold, not 40%", () => {
    // 0.00377 / 4.2. The old suite asserted ~0.40 here, which was the seed.
    const p = curveDepthFraction(LIVE);
    assert.ok(p !== null);
    assert.ok(p! > 0.0005 && p! < 0.002, `expected ~0.0009, got ${p}`);
  });

  it("needs no price feed, so it works for a stock-quoted curve", () => {
    // 42.8% of launches are quoted in Robinhood stock tokens and 2.3% in cbBTC,
    // which this repo cannot price at all. Normalising by the curve's own
    // threshold compares those to an ETH curve without a single feed read.
    const nvdaQuoted: CurveReserves = {
      quoteRaw: 41_600_000_000_000_000_000n / 10n + 16_640_000_000_000_000_000n, // 10% raised + seed
      tokenRaw: 900_000_000n * 10n ** 18n,
      quoteDecimals: 18,
      tokenDecimals: 18,
      graduationThresholdRaw: 41_600_000_000_000_000_000n, // the observed NVDA threshold
    };
    const f = curveDepthFraction(nvdaQuoted);
    assert.ok(f !== null && Math.abs(f - 0.1) < 0.001, `expected 0.10, got ${f}`);
  });

  it("clamps at 1 and refuses a nonsense threshold", () => {
    assert.equal(curveDepthFraction({ ...LIVE, quoteRaw: 10n ** 19n }), 1);
    assert.equal(curveDepthFraction({ ...LIVE, graduationThresholdRaw: 0n }), null);
  });
});

describe("curveGraduated", () => {
  it("tells a graduated curve from a brand-new one, which depth cannot", () => {
    // Graduation drains the token side and returns the quote side to the seed,
    // so reserves alone read EXACTLY like a curve nobody ever bought. These are
    // opposite situations and only the token side separates them.
    const graduated: CurveReserves = { ...LIVE, quoteRaw: 1_680_000_000_000_000_000n, tokenRaw: 0n };
    const fresh: CurveReserves = { ...LIVE, quoteRaw: 1_680_000_000_000_000_000n };
    assert.equal(curveDepthFraction(graduated), curveDepthFraction(fresh), "depth genuinely cannot tell them apart");
    assert.equal(curveGraduated(graduated), true);
    assert.equal(curveGraduated(fresh), false);
  });
});

/**
 * The curve's own safety model.
 *
 * The thing these tests exist to pin is an INVERSION. Every instinct here is
 * imported from Uniswap, where a deeper pool is a safer one; on a bonding curve
 * the real reserve is the aggregate cost basis of everyone ahead of you, so more
 * depth is more overhang and more downside. A guard written the Uniswap way
 * would pass exactly the curves it should refuse.
 */

/** An ETH-quoted curve at a chosen fraction of its own graduation threshold. */
const atFraction = (f: number): CurveReserves => {
  const threshold = 4_200_000_000_000_000_000n;
  const seed = (threshold * 4n) / 10n;
  const real = BigInt(Math.round(f * 4.2e18));
  const quoteRaw = seed + real;
  // k is fixed at launch: seed x initial supply (1e27 tokens).
  const k = seed * 10n ** 27n;
  return {
    quoteRaw,
    tokenRaw: k / quoteRaw,
    quoteDecimals: 18,
    tokenDecimals: 18,
    graduationThresholdRaw: threshold,
  };
};
const ETH_GUARD_USD8 = 244_016_000_000n; // $2,440.16, when the guard sample was taken

describe("curveFloorDrawdownBps — more depth is MORE downside", () => {
  it("matches the closed form at every scale", () => {
    // 10_000 * (1 - (0.4/(0.4+f))^2). These are the figures the guard's
    // threshold was chosen against, so they are worth pinning exactly.
    for (const [f, want] of [[0.05, 2099], [0.10, 3600], [0.25, 6213], [1.0, 9184]] as const) {
      const got = curveFloorDrawdownBps(atFraction(f));
      assert.ok(got !== null);
      assert.ok(Math.abs(got! - want) <= 2, `f=${f}: expected ~${want}bps, got ${got}`);
    }
  });

  it("RISES with depth — the whole point", () => {
    const shallow = curveFloorDrawdownBps(atFraction(0.05))!;
    const deep = curveFloorDrawdownBps(atFraction(0.5))!;
    assert.ok(deep > shallow, "a deeper curve carries MORE overhang, not less");
  });

  it("is zero for a curve nobody has bought", () => {
    // Nothing above the floor means nothing to fall back to. This is the one
    // sense in which an empty curve is genuinely safe — and it is refused
    // elsewhere for having no market at all.
    assert.equal(curveFloorDrawdownBps(atFraction(0)), 0);
  });

  it("crosses trencher's stop-loss at about 9.6% of threshold", () => {
    // The justification for maxFloorDrawdownBps = 3,500. Past this point the
    // curve reverting to its own floor is by itself enough to trip the stop, so
    // the stop stops meaning "this trade went wrong".
    assert.ok(curveFloorDrawdownBps(atFraction(0.096))! <= 3_500);
    assert.ok(curveFloorDrawdownBps(atFraction(0.10))! > 3_500);
  });

  it("refuses rather than guessing when the seed model does not hold", () => {
    assert.equal(curveFloorDrawdownBps({ ...atFraction(0.1), graduationThresholdRaw: 0n }), null);
    assert.equal(curveFloorDrawdownBps({ ...atFraction(0.1), quoteRaw: 1n }), null, "below its own seed");
  });
});

describe("curveFdvUsd8", () => {
  it("bounds what a curve can ever be worth", () => {
    // At graduation quoteRaw is 1.4 x threshold, so FDV is 4.9 x threshold —
    // $50,218 on an ETH curve, and that is the CEILING, touched only at the
    // instant the curve stops existing. Highest observed across 1,680 live
    // curves was $26,953. Trencher's $50,000 FDV gate sits above both.
    const atGraduation = curveFdvUsd8(atFraction(1.0), ETH_GUARD_USD8)!;
    const usd = Number(atGraduation) / 1e8;
    assert.ok(usd > 45_000 && usd < 55_000, `expected ~$50,218 at graduation, got ${usd.toFixed(0)}`);
    assert.ok(usd > 50_000, 'and it only just exceeds the $50,000 gate, at the last possible moment');
  });

  it("needs no totalSupply call — the supply cancels out", () => {
    // A fresh curve's FDV is seed^2/seed = seed, valued in USD: ~$4,099.
    const fresh = Number(curveFdvUsd8(atFraction(0), ETH_GUARD_USD8)!) / 1e8;
    assert.ok(fresh > 3_900 && fresh < 4_300, `expected ~$4,099, got $${fresh.toFixed(0)}`);
  });

  it("returns null rather than zero when it cannot be computed", () => {
    assert.equal(curveFdvUsd8(atFraction(0.1), 0n), null);
    assert.equal(curveFdvUsd8({ ...atFraction(0.1), graduationThresholdRaw: 0n }, ETH_GUARD_USD8), null);
  });
});

describe("curvePriceUsable", () => {
  const ok = {
    price8: 1_000n,
    depthUsdg: 500_000_000n, // $500
    depthFraction: 0.05,
    graduated: false,
    floorDrawdownBps: 2_099,
    impactBps: 60,
    readAgeSec: 2,
  };
  const G = CURVE_GUARD_DEFAULTS;

  it("admits a curve that clears every gate", () => {
    assert.deepEqual(curvePriceUsable(ok, G), { ok: true });
  });

  it("checks GRADUATED first, before anything else", () => {
    // A graduated curve resets to look exactly like a never-traded one, so a
    // depth-first order would refuse it as "too thin" — naming the wrong
    // reason about a token whose market simply moved to a v4 pool.
    const v = curvePriceUsable({ ...ok, graduated: true, depthUsdg: 0n, depthFraction: 0, floorDrawdownBps: 0 }, G);
    assert.equal(v.ok, false);
    assert.equal((v as { kind: string }).kind, "graduated");
  });

  it("refuses a curve with no real money in it", () => {
    const v = curvePriceUsable({ ...ok, depthUsdg: 40_000_000n }, G); // $40
    assert.equal((v as { kind: string }).kind, "too-thin");
  });

  it("has NO feed-free fallback here — it cannot be reached", () => {
    // A price8 exists only if the quote asset was priceable, so a
    // fraction-of-threshold branch could never fire at this point. Replayed
    // against 900 live curves, none of the 316 feedless-quote ones got past
    // the no-quote-price check. The feed-free floor lives in discovery, where
    // it judges the ~45% of launches quoted in stock tokens and cbBTC.
    const noQuote = curvePriceUsable({ ...ok, price8: 0n, depthUsdg: null, depthFraction: 0.5 }, G);
    assert.equal((noQuote as { kind: string }).kind, "no-quote-price", "the true reason, not a depth verdict");
    // And an unknown depth WITH a price is refused, never waved through.
    const unknown = curvePriceUsable({ ...ok, depthUsdg: null }, G);
    assert.equal((unknown as { kind: string }).kind, "too-thin");
    assert.match((unknown as { reason: string }).reason, /unknown amount/);
  });

  it("refuses a curve whose price is mostly other people's cost basis", () => {
    // The check that has no Uniswap analogue, and the reason this guard exists.
    const v = curvePriceUsable({ ...ok, depthUsdg: 2_000_000_000n, depthFraction: 0.25, floorDrawdownBps: 6_213 }, G);
    assert.equal((v as { kind: string }).kind, "overhang");
    assert.match((v as { reason: string }).reason, /other people/);
  });

  it("a DEEPER curve can be refused where a shallower one passes", () => {
    // States the inversion as a behaviour, not a comment. $500 deep passes;
    // $2,000 deep does not — because the extra $1,500 is overhang.
    assert.equal(curvePriceUsable(ok, G).ok, true);
    const deeper = curvePriceUsable({ ...ok, depthUsdg: 2_000_000_000n, floorDrawdownBps: 6_213 }, G);
    assert.equal(deeper.ok, false);
  });

  it("refuses a reading older than a handful of seconds", () => {
    // A curve has no time-average to smooth anything: p99 move over 240s was
    // 1,546 bps. The pool pricer's 60s TTL would be a category error here.
    const v = curvePriceUsable({ ...ok, readAgeSec: 45 }, G);
    assert.equal((v as { kind: string }).kind, "stale-read");
    assert.ok(G.maxReadAgeSec <= 30);
  });

  it("refuses when it has no USD price at all", () => {
    const v = curvePriceUsable({ ...ok, price8: 0n }, G);
    assert.equal((v as { kind: string }).kind, "no-quote-price");
  });

  it("treats an UNKNOWN overhang as a refusal, not a pass", () => {
    const v = curvePriceUsable({ ...ok, floorDrawdownBps: null }, G);
    assert.equal((v as { kind: string }).kind, "overhang");
  });

  it("keeps the impact cap, while being honest that it rarely binds", () => {
    // impact = 10_000 * quoteIn/quoteRaw and quoteRaw >= the ~$4,099 seed, so
    // 300bps first binds at about $124 of notional — well above the default $5
    // entry. It must still refuse when it DOES bind, but it is a ticket-size
    // check, not the safety model.
    const v = curvePriceUsable({ ...ok, impactBps: 900 }, G);
    assert.equal((v as { kind: string }).kind, "impact-cap");
    // A null impact is not a refusal: not every caller is sizing a trade.
    assert.equal(curvePriceUsable({ ...ok, impactBps: null }, G).ok, true);
  });
});


/**
 * THE QUOTE FUNCTIONS — the thing that stood between a curve buy and an
 * unbounded loss, and that did not exist until now.
 *
 * The arithmetic was lifted OUT of curveBuyImpactBps, which computed tokensOut
 * and threw it away. So the first duty of these tests is to prove the two have
 * not drifted: the lift must be a lift, not a rewrite that happens to look
 * similar.
 */
describe("curve quotes", () => {
  it("agrees with the impact function it was lifted from", () => {
    // Same reserves, same input, zero fee: the effective price implied by
    // curveBuyOut must reproduce curveBuyImpactBps. Computed here from the
    // frictionless output so the fee does not confound the comparison.
    const inRaw = 1_000_000_000_000_000n;
    const out = curveBuyOut(LIVE, inRaw);
    assert.ok(out !== null && out > 0n);
    // Undo the fee to recover the frictionless output the impact fn assumes.
    const k = LIVE.quoteRaw * LIVE.tokenRaw;
    const frictionless = LIVE.tokenRaw - k / (LIVE.quoteRaw + inRaw);
    const SCALE = 1_000_000_000_000n;
    const spot = (LIVE.quoteRaw * SCALE) / LIVE.tokenRaw;
    const paid = (inRaw * SCALE) / frictionless;
    const expected = Number(((paid - spot) * 10_000n) / spot);
    assert.equal(curveBuyImpactBps(LIVE, inRaw), expected, "the lift changed the maths");
  });

  it("is FEE-AWARE, so a derived floor is not systematically too high", () => {
    // The whole reason the constant exists. A frictionless quote produces a
    // minAmountOut the honest case cannot meet, and the trade reverts having
    // paid gas to be told the market did exactly what it was going to do.
    const inRaw = 1_000_000_000_000_000n;
    const k = LIVE.quoteRaw * LIVE.tokenRaw;
    const frictionless = LIVE.tokenRaw - k / (LIVE.quoteRaw + inRaw);
    const withFee = curveBuyOut(LIVE, inRaw);
    assert.ok(withFee !== null);
    assert.ok(withFee < frictionless, "fee-aware quote must be below the frictionless one");
    // And by roughly the fee, not by some other amount.
    const shortfallBps = Number(((frictionless - withFee) * 10_000n) / frictionless);
    assert.ok(
      Math.abs(shortfallBps - Number(CURVE_FEE_BPS)) <= 2,
      `shortfall ${shortfallBps} bps should track the ${CURVE_FEE_BPS} bps fee`,
    );
  });

  it("a round trip loses about two fees — the number a strategy has to beat", () => {
    // ~199 bps round trip. Stated as a test because it is the economics of the
    // whole venue: against merrymen's ~47 bps pool floor, a curve strategy has
    // to clear roughly 2% before gas to be worth running at all.
    const inRaw = 100_000_000_000_000n;
    const tokens = curveBuyOut(LIVE, inRaw);
    assert.ok(tokens !== null);
    const back = curveSellOut(LIVE, tokens);
    assert.ok(back !== null);
    const lossBps = Number(((inRaw - back) * 10_000n) / inRaw);
    assert.ok(lossBps > 150 && lossBps < 320, `round trip lost ${lossBps} bps`);
  });

  it("returns null, never 0, when it cannot evaluate", () => {
    // The codebase's central rule. A 0 here is a quote of 'you get nothing',
    // which a caller would happily sign a minAmountOut of 0 against.
    assert.equal(curveBuyOut({ ...LIVE, quoteRaw: 0n }, 1n), null);
    assert.equal(curveBuyOut({ ...LIVE, tokenRaw: 0n }, 1n), null);
    assert.equal(curveBuyOut(LIVE, 0n), null);
    assert.equal(curveBuyOut(LIVE, -1n), null);
    assert.equal(curveSellOut(LIVE, 0n), null);
    // A dust input whose fee rounds it to nothing is 'cannot evaluate', not 0.
    assert.equal(curveBuyOut(LIVE, 1n), null);
  });

  it("curveMinOut refuses a tolerance that would authorise a total loss", () => {
    assert.equal(curveMinOut(1_000n, 0), 1_000n);
    assert.equal(curveMinOut(1_000n, 100), 990n);
    // 100% tolerance is a floor of zero, i.e. no floor. Refused rather than
    // computed, because a caller that passes it wants a number it should not get.
    assert.equal(curveMinOut(1_000n, 10_000), null);
    assert.equal(curveMinOut(1_000n, -1), null);
    assert.equal(curveMinOut(0n, 100), null);
  });

  it("the fee constant is HARDCODED, not derived from the unauthenticated tape", () => {
    // pons-activity.ts filters on topic0 with no address filter, so any contract
    // on this chain can emit those topics with arbitrary data. If this constant
    // ever becomes tape-derived, an attacker moves every future slippage floor
    // for the cost of one contract. Asserting the value pins that decision.
    assert.equal(CURVE_FEE_BPS, 99n);
  });
});
