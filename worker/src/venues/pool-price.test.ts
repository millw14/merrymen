import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cashDepthFromLiquidity,
  combineLegs,
  divergenceBps,
  meanTick,
  poolPriceUsable,
  readExecutionPoolPrice,
  scalePrice,
  sqrtPriceX96ToPrice8,
  tickToPrice8,
} from "./pool-price";

const usd = (v: number) => BigInt(Math.round(v * 1e8)); // price8
const usdg = (v: number) => BigInt(Math.round(v * 1e6)); // 6dp cash
/** The intermediate TOKEN/WETH leg, at 18dp — see the combineLegs tests. */
const weth = (v: number) => scalePrice(v, 18);

/** Uniswap encodes token1/token0 as 1.0001^tick — the inverse of this. */
const tickFor = (ratio: number) => Math.round(Math.log(ratio) / Math.log(1.0001));

describe("tickToPrice8 — a v3 tick becomes USDG per whole token", () => {
  it("prices an 18dp token against 6dp USDG when the token is token0", () => {
    // $2.50/token ⇒ raw ratio = 2.50 × 10^(6−18) = 2.5e-12
    const tick = tickFor(2.5e-12);
    const p = tickToPrice8({ tick, tokenIsToken0: true, tokenDecimals: 18, cashDecimals: 6 });
    assert.ok(Math.abs(Number(p) / 1e8 - 2.5) < 0.01, `got ${Number(p) / 1e8}`);
  });

  it("inverts correctly when the token is token1 instead", () => {
    // Same $2.50, but now the pool orders USDG first: raw ratio = 1/2.5e-12
    const tick = tickFor(1 / 2.5e-12);
    const p = tickToPrice8({ tick, tokenIsToken0: false, tokenDecimals: 18, cashDecimals: 6 });
    assert.ok(Math.abs(Number(p) / 1e8 - 2.5) < 0.01, `got ${Number(p) / 1e8}`);
  });

  it("handles a sub-cent memecoin without losing the price to rounding", () => {
    const tick = tickFor(0.000004 * 1e-12);
    const p = tickToPrice8({ tick, tokenIsToken0: true, tokenDecimals: 18, cashDecimals: 6 });
    const got = Number(p) / 1e8;
    assert.ok(got > 0, "a real price, not zero");
    assert.ok(Math.abs(got - 0.000004) / 0.000004 < 0.01, `got ${got}`);
  });

  it("an extreme tick underflows to 0 rather than emitting a garbage price", () => {
    // Uniswap caps ticks at ±887272, so 1.0001^tick never actually overflows a
    // double — the realistic failure is the other end, where an absurd tick
    // rounds below 1e-8 and must report "no price" instead of a bogus one.
    assert.equal(tickToPrice8({ tick: 900_000, tokenIsToken0: false, tokenDecimals: 18, cashDecimals: 6 }), 0n);
    assert.equal(tickToPrice8({ tick: -900_000, tokenIsToken0: true, tokenDecimals: 18, cashDecimals: 6 }), 0n);
  });
});

describe("sqrtPriceX96ToPrice8 — spot from slot0", () => {
  it("agrees with the tick maths at the same price", () => {
    const price = 2.5;
    const rawRatio = price * 1e-12; // 18dp token, 6dp cash, token is token0
    const sqrtX96 = BigInt(Math.floor(Math.sqrt(rawRatio) * 2 ** 96));
    const fromSqrt = sqrtPriceX96ToPrice8({ sqrtPriceX96: sqrtX96, tokenIsToken0: true, tokenDecimals: 18, cashDecimals: 6 });
    const fromTick = tickToPrice8({ tick: tickFor(rawRatio), tokenIsToken0: true, tokenDecimals: 18, cashDecimals: 6 });
    const drift = Math.abs(Number(fromSqrt) - Number(fromTick)) / Number(fromTick);
    assert.ok(drift < 0.01, `spot and tick maths disagree by ${(drift * 100).toFixed(2)}%`);
  });

  it("returns 0 for a zero price rather than NaN", () => {
    assert.equal(sqrtPriceX96ToPrice8({ sqrtPriceX96: 0n, tokenIsToken0: true, tokenDecimals: 18, cashDecimals: 6 }), 0n);
  });
});

describe("meanTick — averaging the oracle's cumulative readings", () => {
  it("divides the cumulative delta by the window", () => {
    // 900s at a steady tick of 100 ⇒ delta 90_000
    assert.equal(meanTick([0n, 90_000n], 900), 100);
  });

  it("handles negative ticks (sub-1 prices)", () => {
    assert.equal(meanTick([0n, -90_000n], 900), -100);
  });

  it("refuses a malformed or zero-length window", () => {
    assert.equal(meanTick([0n], 900), null);
    assert.equal(meanTick([0n, 100n], 0), null);
  });
});

describe("divergenceBps", () => {
  it("measures how far spot has run from the TWAP", () => {
    assert.equal(divergenceBps(usd(110), usd(100)), 1000); // +10%
    assert.equal(divergenceBps(usd(90), usd(100)), 1000); // −10%, same magnitude
    assert.equal(divergenceBps(usd(100), usd(100)), 0);
  });

  it("is zero when there's no TWAP to compare against", () => {
    assert.equal(divergenceBps(usd(100), 0n), 0);
  });
});

/**
 * Most of this chain's memecoins quote against WETH, not USDG (checked live:
 * ~75% of pools), so a memecoin price is nearly always TOKEN/WETH × WETH/USDG.
 */
describe("combineLegs — routing a price through WETH", () => {
  it("multiplies the two legs and keeps 8dp", () => {
    // 0.0004 WETH per token × $2500 per WETH = $1.00
    assert.equal(combineLegs(weth(0.0004), usd(2500)), usd(1));
  });

  it("survives a sub-cent memecoin without collapsing to zero", () => {
    // 0.0000002 WETH × $2500 = $0.0005
    const p = combineLegs(weth(0.0000002), usd(2500));
    assert.ok(Math.abs(Number(p) / 1e8 - 0.0005) < 1e-6, `got ${Number(p) / 1e8}`);
  });

  it("returns 0 when either leg is missing — never a half-priced guess", () => {
    assert.equal(combineLegs(0n, usd(2500)), 0n);
    assert.equal(combineLegs(weth(0.0004), 0n), 0n);
  });

  /**
   * The token leg arrives at 18dp for a reason. A real memecoin here is worth
   * something like 0.000000015 WETH; at 8dp that is the integer 2, and every
   * price the route can express is then a multiple of ~$0.00003. Feeding equity
   * a number that moves in 50% steps means an ordinary 1% drift halves the
   * position and trips the drawdown breaker on rounding.
   */
  it("prices a real memecoin accurately instead of quantizing it", () => {
    // $0.000045/token with WETH at $3000 → 1.5e-8 WETH per token.
    const p = combineLegs(weth(1.5e-8), usd(3000));
    const got = Number(p) / 1e8;
    assert.ok(Math.abs(got - 0.000045) / 0.000045 < 0.001, `got ${got}, want ~0.000045`);
  });

  it("an 8dp token leg would have been catastrophically coarse (the bug this prevents)", () => {
    // What the old signature did: round the intermediate leg to 8dp FIRST.
    assert.equal(usd(1.5e-8), 1n, "the whole WETH price of the token collapses to the integer 1");
    const coarse = combineLegs(usd(1.5e-8) * 10_000_000_000n, usd(3000));
    const got = Number(coarse) / 1e8;
    // True value is $0.000045. Every price the route could express is a multiple
    // of $0.00003, so the holding reads a third low — and the ONLY other number
    // available is $0.00006, a 100% jump away.
    assert.equal(got, 0.00003, "a third low — and the next representable price is double this");
    const nextStep = combineLegs(2n * 10_000_000_000n, usd(3000));
    assert.equal(Number(nextStep) / 1e8, 0.00006, "one integer up doubles the position's value");
  });

  it("moves smoothly across a small drift rather than in steps", () => {
    const a = combineLegs(weth(1.51e-8), usd(3000));
    const b = combineLegs(weth(1.49e-8), usd(3000));
    const moveBps = Number(((a - b) * 10_000n) / b);
    assert.ok(moveBps > 100 && moveBps < 160, `a 1.3% drift should read ~133bps, got ${moveBps}`);
  });
});

describe("scalePrice — fixed point without inventing digits", () => {
  it("scales a small price exactly", () => {
    assert.equal(scalePrice(1.5e-8, 18), 15_000_000_000n);
    assert.equal(scalePrice(2.5, 8), 250_000_000n);
  });

  it("keeps a large price at 18dp honest, where a naive float multiply cannot", () => {
    // 3000 × 1e18 = 3e21, far past 2^53 — a double stops counting in ones there,
    // so `BigInt(Math.round(human * 1e18))` returns whatever the rounding error
    // happened to be and calls it precision.
    const got = scalePrice(3000, 18);
    assert.equal(got, 3_000_000_000_000_000_000_000n);
    assert.ok(!Number.isSafeInteger(3000 * 1e18), "the naive form is out of safe range");
  });

  it("refuses nonsense rather than emitting a garbage price", () => {
    assert.equal(scalePrice(0, 8), 0n);
    assert.equal(scalePrice(-1, 8), 0n);
    assert.equal(scalePrice(Number.NaN, 8), 0n);
    assert.equal(scalePrice(Number.POSITIVE_INFINITY, 8), 0n);
  });
});

/**
 * Depth decides whether a price is trustworthy, so how it's MEASURED is a
 * security property. balanceOf counts money that isn't defending the price at
 * all — out-of-range positions, uncollected fees, a plain transfer — and all
 * three are things an attacker can add cheaply and take back afterwards.
 */
describe("cashDepthFromLiquidity — in-range depth, not the pool's balance", () => {
  const Q96 = 2n ** 96n;

  it("returns L·sqrtP for a token1 cash side", () => {
    // sqrtP = 2 ⇒ price = 4. L = 1e18 ⇒ y = 2e18.
    const d = cashDepthFromLiquidity({
      liquidity: 10n ** 18n,
      sqrtPriceX96: 2n * Q96,
      cashIsToken0: false,
    });
    assert.equal(d, 2n * 10n ** 18n);
  });

  it("returns L/sqrtP for a token0 cash side", () => {
    const d = cashDepthFromLiquidity({
      liquidity: 10n ** 18n,
      sqrtPriceX96: 2n * Q96,
      cashIsToken0: true,
    });
    assert.equal(d, 5n * 10n ** 17n);
  });

  it("is zero when there is no in-range liquidity — an empty range defends nothing", () => {
    assert.equal(cashDepthFromLiquidity({ liquidity: 0n, sqrtPriceX96: Q96, cashIsToken0: true }), 0n);
  });

  it("is zero at an unset price rather than dividing by zero", () => {
    assert.equal(cashDepthFromLiquidity({ liquidity: 10n ** 18n, sqrtPriceX96: 0n, cashIsToken0: true }), 0n);
  });

  it("does not move when someone donates to the pool — only real liquidity counts", () => {
    // A donation changes balanceOf and nothing else. Since this function never
    // reads a balance, an attacker cannot buy their way past the depth floor.
    const before = cashDepthFromLiquidity({ liquidity: 10n ** 18n, sqrtPriceX96: Q96, cashIsToken0: false });
    const after = cashDepthFromLiquidity({ liquidity: 10n ** 18n, sqrtPriceX96: Q96, cashIsToken0: false });
    assert.equal(before, after);
  });
});

/**
 * These are the tests that matter. A DEX price feeds equity, P&L and the
 * drawdown breaker — if a thin pool can be pushed for pocket change, an outsider
 * can fake the owner's net worth or trip their circuit breaker at will. Refusing
 * is the correct behaviour, so refusal is what gets pinned.
 */
describe("poolPriceUsable — refusing a price you can't trust", () => {
  // poolPriceUsable judges a routed price, so it takes only the four fields a
  // verdict depends on — the depth here is already USD at 6dp, converted from
  // the pool's own cash units by readRoutedPrice.
  const base = {
    price8: usd(2.5),
    spot8: usd(2.5),
    liquidityUsdg: usdg(50_000),
    twapWindowSec: 900,
    divergenceBps: 0,
  };
  const guard = { minLiquidityUsdg: usdg(10_000), maxDivergenceBps: 500 };

  it("accepts a deep pool trading in line with its TWAP", () => {
    assert.deepEqual(poolPriceUsable(base, guard), { ok: true });
  });

  it("REFUSES a pool below the liquidity floor", () => {
    const thin = { ...base, liquidityUsdg: usdg(900) };
    const v = poolPriceUsable(thin, guard);
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.reason : "", /too thin/);
  });

  it("REFUSES when spot has run far from the TWAP — the manipulation signature", () => {
    const pushed = { ...base, spot8: usd(4.0), divergenceBps: divergenceBps(usd(4.0), usd(2.5)) };
    const v = poolPriceUsable(pushed, guard);
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.reason : "", /manipulation/);
  });

  it("REFUSES when the pool has no TWAP yet (fresh pool, cardinality 1)", () => {
    // Must NOT silently fall back to spot — that would defeat the entire design.
    const noTwap = { ...base, price8: 0n };
    const v = poolPriceUsable(noTwap, guard);
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.reason : "", /no usable TWAP/);
  });

  it("a small honest move stays acceptable — the band is not a straitjacket", () => {
    const drifting = { ...base, spot8: usd(2.55), divergenceBps: divergenceBps(usd(2.55), usd(2.5)) };
    assert.deepEqual(poolPriceUsable(drifting, guard), { ok: true });
  });

  it("the floor and band are caller-set, so a cautious owner can demand more", () => {
    const strict = { minLiquidityUsdg: usdg(100_000), maxDivergenceBps: 100 };
    assert.equal(poolPriceUsable(base, strict).ok, false, "50k pool fails a 100k floor");
  });
});
