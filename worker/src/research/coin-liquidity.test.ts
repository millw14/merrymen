/**
 * THE LENS THAT HAD TO SAY THE COUNTERINTUITIVE THING.
 *
 * A liquidity analyst arrives carrying one instinct from every other market it
 * has ever read about: deeper is safer. On a Pons bonding curve that is exactly
 * backwards — the real quote reserve IS the aggregate cost basis of everyone
 * ahead of you, so depth is their exit and more of it is more downside. A block
 * of correct figures that leaves that instinct in place is worse than no block,
 * because the numbers lend it authority.
 *
 * So these tests are mostly about what the prose commits to, not about
 * arithmetic — pons-price.ts owns the arithmetic and has its own tests. What is
 * pinned here is the honesty: the seed is never reported as money, a quote asset
 * nobody can price still yields the feed-free figures, an exit is quoted at what
 * leaving pays rather than at the mark, and the three lenses this file has no
 * source for are named as unknown instead of left to read as clean.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderLiquidity, type LiquidityInputs } from "./coin-liquidity";
import { curveFloorDrawdownBps, type CurveReserves } from "../venues/pons-price";

const ETH_USD8 = 4_000_00000000n; // $4,000
const THRESHOLD = 4_200_000_000_000_000_000n; // 4.2 ETH, a real Pons threshold
const SEED = (THRESHOLD * 4_000n) / 10_000n; // 1.68 ETH, virtual

/** A curve holding `realEth` of actual money on top of the virtual seed. */
const curve = (realEth: bigint, tokenRaw = 700_000_000_000_000_000_000_000_000n): CurveReserves => ({
  quoteRaw: SEED + realEth,
  tokenRaw,
  quoteDecimals: 18,
  tokenDecimals: 18,
  graduationThresholdRaw: THRESHOLD,
});

const render = (over: Partial<LiquidityInputs> = {}): string => {
  const out = renderLiquidity({
    symbol: "WIF",
    reserves: curve(420_000_000_000_000_000n), // 0.42 ETH raised — 10% of threshold
    quoteUsd8: ETH_USD8,
    quoteSymbol: "ETH",
    heldRaw: 0n,
    probeUsdg: 10_000_000n, // 10 USDG
    ...over,
  });
  assert.ok(out !== null, "expected material");
  return out;
};

describe("the seed is never reported as money", () => {
  it("DEPTH EXCLUDES THE VIRTUAL SEED, and the block says the seed exists", () => {
    // A fresh curve reports 1.68 ETH of reserve while holding nothing at all.
    // Reporting that as depth would tell an owner a curve holding $0 had $6,720
    // to sell into — on the very figure the safety model rests on.
    const said = render();
    assert.match(said, /Real money raised: 0.420 ETH \(\$1,680\)/);
    assert.match(said, /virtual seed of 1\.6800 ETH/);
    assert.match(said, /does not hold/);
  });

  it("and progress is measured against the curve's own threshold", () => {
    // 0.42 of 4.2 — and it needs no price feed, which is the whole reason this
    // figure is the one worth filtering on.
    assert.match(render(), /Progress toward graduation: 10\.0%/);
  });
});

describe("the counterintuitive number is the headline", () => {
  it("OVERHANG IS STATED, AND SO IS WHAT IT MEANS", () => {
    const said = render();
    const bps = curveFloorDrawdownBps(curve(420_000_000_000_000_000n));
    assert.ok(bps !== null);
    assert.match(said, new RegExp(`price would fall ${(bps / 100).toFixed(1)}%`));
    // The sentence, not just the figure. Without it a model reads a deep curve
    // as a safe one, which is the instinct every other venue teaches.
    assert.match(said, /DEPTH IS OTHER PEOPLE'S EXIT/);
    assert.match(said, /more depth is MORE downside/);
  });

  it("and a deeper curve reads as MORE dangerous, not less", () => {
    const shallow = render({ reserves: curve(210_000_000_000_000_000n) }); // 5%
    const deep = render({ reserves: curve(4_200_000_000_000_000_000n) }); // 100%
    const pctOf = (s: string) => Number(/price would fall ([\d.]+)%/.exec(s)![1]);
    assert.ok(pctOf(deep) > pctOf(shallow), "the deeper curve must report the larger fall");
    assert.ok(pctOf(shallow) > 20, "even 5% of threshold is already past a 20% stop");
  });
});

describe("a quote asset nobody can price", () => {
  it("STILL GETS EVERY FEED-FREE FIGURE — that is the point of them", () => {
    // 42.8% of Pons launches quote in stock tokens, which this repo refuses to
    // price outside market hours. Progress, overhang and impact are computed
    // against the curve itself and are unaffected; only dollars are missing.
    const said = render({ quoteUsd8: null, quoteSymbol: "TSLA" });
    assert.match(said, /Progress toward graduation: 10\.0%/);
    assert.match(said, /price would fall/);
    assert.match(said, /no USD price for TSLA, so no dollar figure/);
    assert.ok(!said.includes("Fully diluted value"), "no FDV without a price for the quote asset");
    assert.ok(!/\$\d/.test(said.split("p99")[0]!), "no invented dollar figure");
  });
});

describe("what leaving actually pays", () => {
  it("THE EXIT IS QUOTED BELOW THE MARK, and says why", () => {
    // The gap is the 0.99% fee plus the curve this sale walks down. A mark of
    // spot x quantity is a price no sale gets, and it is the number every other
    // surface shows.
    const said = render({ heldRaw: 7_000_000_000_000_000_000_000_000n }); // 1% of the token side
    assert.match(said, /Exit quote for the whole position/);
    const under = Number(/is ([\d.]+)% under what that quantity marks at/.exec(said)![1]);
    assert.ok(under > 0.99, `expected more than the bare fee, got ${under}%`);
    assert.ok(under < 5, `1% of the token side should not cost 5%, got ${under}%`);
  });

  it("and a book holding none of it does not get an exit quote at all", () => {
    const said = render({ heldRaw: 0n });
    assert.match(said, /holds none of this token, so there is no exit to quote/);
    assert.ok(!said.includes("Exit quote"), "nothing to quote, so nothing quoted");
  });
});

describe("a graduated curve is not an empty one", () => {
  it("IT SAYS SO AND REPORTS NOTHING ELSE", () => {
    // Graduation drains the token side and returns the quote side to the seed,
    // so the reserves read exactly like a curve nobody ever bought. They are
    // opposite situations, and every figure below would describe a venue that
    // no longer trades this token.
    const said = render({ reserves: curve(0n, 0n) });
    assert.match(said, /HAS GRADUATED/);
    assert.ok(!said.includes("Progress toward graduation:"), "no progress on a finished curve");
    assert.ok(!said.includes("OVERHANG"), "no overhang on a market that moved");
    assert.match(said, /cannot see the pool/);
  });

  it("and an uninterpretable reading is NO DATA, not a blank block", () => {
    // Null reaches Brain as NO DATA AVAILABLE. An empty string would reach it
    // as a lens that was supplied and had nothing to say — a different claim.
    const base = { symbol: "X", quoteUsd8: ETH_USD8, quoteSymbol: "ETH", heldRaw: 0n, probeUsdg: 0n };
    // A zero QUOTE side is not graduation — graduation drains the token side —
    // so this is a reading the module cannot interpret rather than one it can.
    assert.equal(renderLiquidity({ ...base, reserves: { ...curve(0n), quoteRaw: 0n } }), null);
    // And a curve with both sides present is always interpretable, however thin.
    assert.ok(renderLiquidity({ ...base, reserves: curve(0n) }) !== null);
  });
});

describe("it does not claim what it did not read", () => {
  it("HOLDERS, AGE AND VOLUME ARE NAMED AS ABSENT", () => {
    // The neighbouring lenses. Silence about them reads as cleanliness, which
    // on a launchpad token is the single most expensive thing to assume.
    assert.match(render(), /NOT IN THIS LENS: holder distribution, curve age, trade count/);
    assert.match(render(), /unknown rather than as clean/);
  });

  it("and it fits inside the request schema's per-lens ceiling", () => {
    // MAX_LENS_CHARS in services/brain/brain/schemas.py. A renderer that
    // outgrows it does not truncate — the whole request is refused.
    assert.ok(render({ heldRaw: 7_000_000_000_000_000_000_000_000n }).length < 8_000);
  });
});
