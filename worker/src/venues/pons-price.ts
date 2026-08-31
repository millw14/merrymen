/**
 * Pricing a Pons bonding-curve token.
 *
 * WHY THIS CANNOT REUSE THE POOL PRICER. Every existing price path assumes a
 * Uniswap pool with an observation oracle behind it: `poolPriceUsable`
 * (venues/pool-price.ts) refuses with `no-twap` BEFORE it looks at depth or
 * divergence, because its whole safety model is "does spot agree with a
 * time-weighted average". A bonding curve has no observations to average, so
 * every curve token is structurally unpriceable there — which is why they show
 * as `priceable: false` and trencher's entry gate refuses them.
 *
 * The fix is NOT to synthesise a TWAP to get past that check. That would
 * launder an unguarded number through a guard designed for something else, and
 * the guard would then report a confidence it does not have. A curve needs its
 * own safety model, and this module says plainly what that model is:
 *
 *   OVERHANG IS THE GUARD. A constant-product curve's price is an exact
 *   function of its reserves — there is no oracle to disagree with and nothing
 *   to manipulate through a stale window. What hurts you is that the real quote
 *   reserve IS the aggregate cost basis of everyone ahead of you, and if they
 *   leave, the price returns to the virtual seed. See curveFloorDrawdownBps.
 *
 * AN EARLIER VERSION OF THIS COMMENT SAID "depth is the guard", and that was
 * an instinct imported from Uniswap where deeper is safer. On a bonding curve
 * it is backwards: more depth is MORE downside, not less, because depth is
 * other people's exit. Depth still sets a FLOOR — below a few hundred dollars
 * there is no market to speak of — but it is a liveness test, not a safety
 * margin, and the thing that bounds the risk is how much of the current price
 * is other people's money. Size matters too, but far less than it looks:
 * impact is bounded below by the seed, so a 300bps cap does not bind until
 * about $124 of notional and is dead code at the configured entry sizes.
 *
 * THE VIRTUAL SEED, AND THE BUG IT CAUSED HERE. Pons opens every curve with a
 * VIRTUAL quote reserve of exactly 40% of that curve's graduation threshold —
 * 1.68 ETH on a 4.2 ETH curve — while the contract holds none of the quote
 * asset at all. Verified on mainnet: fresh curves report `quoteReserve /
 * graduationThreshold() == 0.400000` with an on-chain balance of zero, and
 * where there IS real money, `r0 - 0.4 x threshold` matches the balance held
 * (0.0147 computed against 0.015 actual).
 *
 * The first version of this module reported that seed as depth. It would have
 * told the owner a curve holding $0 had $4,106 to sell into — on the very
 * figure the safety model rests on, and off by however much money was not
 * there. The module had already caught this exact hazard on the token side
 * ("the token side is not liquidity — it is inventory the curve mints") and
 * then made the same mistake on the quote side one field down.
 *
 * WHAT THE SEED DOES AND DOES NOT AFFECT. The constant product genuinely uses
 * the full reserve INCLUDING the seed — verified exact to 1 wei against real
 * buys — so spot price and price impact are correct computed from `quoteRaw`
 * and must not be "fixed". Only figures that claim something about REAL MONEY
 * — depth, and progress toward graduation — subtract it.
 *
 * The maths is pure and lives apart from the RPC so it can be tested against
 * figures read off mainnet — the same discipline fills.ts uses.
 */

/**
 * Reserves as the curve reports them, plus what it takes to interpret them.
 *
 * `graduationThresholdRaw` is not optional, and that is deliberate: without it
 * the virtual seed cannot be subtracted, and every depth figure computed from
 * these reserves would be the fiction described above. Making it a required
 * field means no caller can accidentally ask for a depth this module cannot
 * honestly give. It is free to obtain — data word 2 of the launch event, and
 * `graduationThreshold()` on the curve agrees with it 18/18 across quote assets.
 */
export interface CurveReserves {
  /**
   * Reserve of the QUOTE asset as getReserves() reports it, raw units.
   *
   * INCLUDES the virtual seed. Correct for pricing, wrong for depth — see the
   * header. Use `realQuoteRaw` for anything that asserts money exists.
   */
  quoteRaw: bigint;
  /** Reserve of the launched token, raw units. */
  tokenRaw: bigint;
  quoteDecimals: number;
  tokenDecimals: number;
  /** The curve's own graduation threshold, raw quote units. */
  graduationThresholdRaw: bigint;
}

/**
 * The seed is 40% of the graduation threshold, as a fraction in basis points.
 *
 * Measured, not documented: across 2,000 sampled curves, 63.1% sit within 5 wei
 * of exactly 0.4 x threshold, 76.0% at or below it, and NOT ONE below — which is
 * what makes the subtraction below safe to floor at zero.
 */
export const VIRTUAL_SEED_BPS = 4_000n;

/** The quote reserve a curve reports before anyone has bought anything. */
export function virtualSeedRaw(graduationThresholdRaw: bigint): bigint {
  if (graduationThresholdRaw <= 0n) return 0n;
  return (graduationThresholdRaw * VIRTUAL_SEED_BPS) / 10_000n;
}

/**
 * The quote asset actually raised — what is really there to sell into.
 *
 * Saturates at zero rather than going negative. No sampled curve reads below
 * the seed, so a negative result would mean the seed model is wrong for that
 * curve, and in that case reporting "nothing" is the honest answer rather than
 * a negative depth that would compare as less than every floor.
 */
export function realQuoteRaw(r: CurveReserves): bigint {
  const real = r.quoteRaw - virtualSeedRaw(r.graduationThresholdRaw);
  return real > 0n ? real : 0n;
}

export interface CurvePrice {
  /** USD per whole token, 8dp — the same convention as every other PriceQuote. */
  price8: bigint;
  /**
   * USD value of the REAL quote raised, 8dp. Zero for a curve nobody has bought.
   *
   * This is the honest depth figure twice over: it excludes the virtual seed,
   * which is not money, and it excludes the token side, which is inventory the
   * curve mints rather than anything to sell into.
   *
   * NOTE THE UNITS. This is 8dp, while every existing depth guard in the worker
   * (`PriceGuard.minLiquidityUsdg`, `cfg.minPoolLiquidityUsdg`) is 6dp USDG.
   * Comparing the two directly makes a $250 curve clear a $25,000 floor.
   */
  depthUsd8: bigint;
}

/**
 * Price a curve from its reserves and the USD price of its quote asset.
 *
 * Returns null rather than a zero when the curve cannot be priced — an empty
 * side, or a quote asset we have no USD price for. A zero price is not a
 * cheaper token, it is a missing fact, and downstream code values positions
 * with this.
 */
export function curvePrice(r: CurveReserves, quoteUsd8: bigint): CurvePrice | null {
  if (r.quoteRaw <= 0n || r.tokenRaw <= 0n || quoteUsd8 <= 0n) return null;
  if (r.quoteDecimals < 0 || r.tokenDecimals < 0) return null;
  // Without a threshold the seed cannot be subtracted, and depthUsd8 would
  // silently become the pre-fix figure — the full seeded reserve reported as
  // money. Every current caller supplies one (parseLaunchLogs refuses a
  // zero-threshold log and readCurveReserves checks it again), so this is
  // defence in depth rather than a live path; it is here because the cost of it
  // being wrong is a confident number on a curve holding nothing.
  if (r.graduationThresholdRaw <= 0n) return null;

  // price_usd = (quoteRaw / 10^qd) / (tokenRaw / 10^td) * quoteUsd
  //
  // The FULL reserve, seed included — the curve's constant product really does
  // use it, verified to 1 wei against observed buys, so this is the price a
  // trade would actually get. Subtracting the seed here would produce a number
  // no trade could ever execute at.
  //
  // Kept as one integer expression so the division happens once, at the end:
  // dividing early throws away every significant digit, because a memecoin's
  // price is ~1e-9 of the quote asset and the intermediate is exactly where
  // that precision lives.
  const price8 =
    (r.quoteRaw * 10n ** BigInt(r.tokenDecimals) * quoteUsd8) /
    (r.tokenRaw * 10n ** BigInt(r.quoteDecimals));

  // Depth is the REAL quote raised, valued in USD at 8dp to match price8.
  const depthUsd8 = (realQuoteRaw(r) * quoteUsd8) / 10n ** BigInt(r.quoteDecimals);

  // A curve so thin (or a token so numerous) that a whole token rounds to zero
  // at 8dp cannot be priced honestly at this precision. Say so instead of
  // returning a zero that reads as free.
  if (price8 <= 0n) return null;
  return { price8, depthUsd8 };
}

/**
 * What a buy of `quoteInRaw` would actually cost, as price impact in bps.
 *
 * On a constant-product curve this is exact rather than estimated: the reserves
 * ARE the market, so the post-trade price follows from x*y=k with no routing,
 * no other liquidity, and nothing to sample. That makes impact the natural size
 * guard here — the equivalent of the probe-requote the Uniswap path has to do
 * because it cannot see the whole book.
 *
 * Uses the FULL reserve including the virtual seed, because that is what the
 * curve itself uses. This is not an oversight and must not be "corrected": the
 * seed is what makes an early buy cost less than the empty pool it would
 * otherwise be, and pricing against the real reserve would overstate impact
 * enormously on exactly the curves the agent is most likely to look at.
 *
 * Returns null when the trade cannot be evaluated, never 0 — "unknown impact"
 * and "no impact" must not be the same value to a caller deciding whether to
 * spend money.
 */
/**
 * THE CURVE'S OWN FEE, IN BASIS POINTS PER SIDE.
 *
 * A quote that ignores it is systematically optimistic, and a minAmountOut
 * derived from an optimistic quote is a floor the honest case trips over: the
 * trade reverts, the account pays gas, and nothing says why. Measured at ~99 bps
 * by replaying the compiled adapter against a live USDG-quoted curve through
 * eth_simulateV1 (10 USDG in, 3,050,001.54 tokens out) versus the frictionless
 * constant product below.
 *
 * HARDCODED ON PURPOSE, and the activity tape VALIDATES it rather than sets it.
 * pons-activity.ts:24-26 says outright that its eth_getLogs carries no address
 * filter -- topic0 only -- so any contract on this chain can emit those topics
 * with arbitrary data words. Deriving this constant from that tape would let an
 * attacker move the number that sets every future slippage floor, for the cost of
 * one contract, on a chain already producing hundreds of launches an hour. Any
 * re-derivation must restrict itself to emitters that appear as curves in the
 * FACTORY-FILTERED launch set (pons.ts:194).
 */
export const CURVE_FEE_BPS = 99n;

/**
 * How many tokens a quote-in buy actually returns, fee included. Raw units.
 *
 * WHY THIS EXISTS SEPARATELY FROM curveBuyImpactBps. That function computes
 * `tokensOut` on its way to a bps figure and then throws the number away, and it
 * was the only place in the repo the constant product was written down. So there
 * was no function anywhere answering “given (curve, amountIn), how many tokens
 * come back” -- which is the one input a minAmountOut needs, which is the one
 * field standing between a curve buy and an unbounded loss.
 *
 * WHAT THIS IS NOT: an independent check on the curve. `r` is read from the
 * curve's OWN getReserves(), so a hostile curve reports whatever reserves make
 * its price look fair and this function faithfully agrees. The floor derived
 * here bounds HONEST-WORKER SLIPPAGE -- the market moving between quote and
 * fill -- and is never an answer to the hostile-curve risk. That risk is bounded
 * elsewhere and only elsewhere: the wall's pinned asset legs, the amountIn-capped
 * pull, the per-trade approve, and PonsSelfTrade's own measurement of the
 * CALLER's balance delta. Nobody should later cite minAmountOut as the reason a
 * strange curve is safe.
 *
 * Uses the FULL reserve including the virtual seed, for the reason spelled out
 * on curveBuyImpactBps: the seed is what the curve itself prices against.
 *
 * Returns null, never 0, when it cannot be evaluated.
 */
export function curveBuyOut(r: CurveReserves, quoteInRaw: bigint): bigint | null {
  if (r.quoteRaw <= 0n || r.tokenRaw <= 0n || quoteInRaw <= 0n) return null;
  // The fee is taken on the way IN, which is why it is applied to the input
  // rather than the output: a curve that skimmed the output would leave the
  // invariant holding at a different k, and that is not what was measured.
  const inAfterFee = (quoteInRaw * (10_000n - CURVE_FEE_BPS)) / 10_000n;
  if (inAfterFee <= 0n) return null;
  const k = r.quoteRaw * r.tokenRaw;
  const newQuote = r.quoteRaw + inAfterFee;
  const tokensOut = r.tokenRaw - k / newQuote;
  return tokensOut > 0n ? tokensOut : null;
}

/**
 * The sell twin: how much quote asset comes back for `tokenInRaw` tokens.
 *
 * Needed as early as the buy, because an entry whose exit cannot be quoted is an
 * entry nobody can size. Same fee, same seed treatment, same null discipline,
 * and the same warning as above about whose arithmetic this is.
 */
export function curveSellOut(r: CurveReserves, tokenInRaw: bigint): bigint | null {
  if (r.quoteRaw <= 0n || r.tokenRaw <= 0n || tokenInRaw <= 0n) return null;
  const inAfterFee = (tokenInRaw * (10_000n - CURVE_FEE_BPS)) / 10_000n;
  if (inAfterFee <= 0n) return null;
  const k = r.quoteRaw * r.tokenRaw;
  const newToken = r.tokenRaw + inAfterFee;
  const quoteOut = r.quoteRaw - k / newToken;
  return quoteOut > 0n ? quoteOut : null;
}

/**
 * A slippage floor for a curve trade: the quote, less `toleranceBps`.
 *
 * Kept beside the quote so the two can never be computed from different readings
 * of a curve the repo's own prose says can move 1,546 bps at p99 over four
 * minutes. The intent type already requires this (policy.ts) -- “carried on the
 * intent rather than recomputed at execution time so the number the trade is
 * judged against and the number the chain enforces cannot come from two
 * different readings”.
 */
export function curveMinOut(quotedOutRaw: bigint, toleranceBps: number): bigint | null {
  if (quotedOutRaw <= 0n || toleranceBps < 0 || toleranceBps >= 10_000) return null;
  return (quotedOutRaw * BigInt(10_000 - toleranceBps)) / 10_000n;
}

export function curveBuyImpactBps(r: CurveReserves, quoteInRaw: bigint): number | null {
  if (r.quoteRaw <= 0n || r.tokenRaw <= 0n || quoteInRaw <= 0n) return null;
  // Constant product: tokensOut = tokenRaw - k/(quoteRaw + in)
  const k = r.quoteRaw * r.tokenRaw;
  const newQuote = r.quoteRaw + quoteInRaw;
  const newToken = k / newQuote;
  const tokensOut = r.tokenRaw - newToken;
  if (tokensOut <= 0n) return null;

  // Effective price paid vs the spot price before the trade, in bps. Scaled up
  // before dividing for the same precision reason as above.
  const SCALE = 1_000_000_000_000n;
  const spotScaled = (r.quoteRaw * SCALE) / r.tokenRaw;
  const paidScaled = (quoteInRaw * SCALE) / tokensOut;
  if (spotScaled <= 0n) return null;
  const bps = ((paidScaled - spotScaled) * 10_000n) / spotScaled;
  return Number(bps);
}

/**
 * Real quote raised as a fraction of this curve's own graduation threshold, 0..1.
 *
 * THE PRICE-FEED-FREE MEASURE, and the one worth building a filter on. Pons
 * curves are quoted in whatever the launcher chose — 53.6% native ETH, but 42.8%
 * in Robinhood STOCK TOKENS, plus cbBTC and USDG — and their thresholds are not
 * a constant USD value either (they range $7,737 to $10,377 at today's prices,
 * having been configured at different times and never repriced). So comparing
 * curves in USD needs a price for every quote asset, some of which have no
 * usable feed at all, and would still be comparing against a moving bar.
 *
 * A curve's progress along its OWN threshold needs no feed, is exact, and is
 * the thing Pons itself is measuring. It is directly predictive: against a base
 * graduation rate of 0.96%, curves that reach 25% of threshold graduate 18.2%
 * of the time.
 *
 * Clamped to 1. A graduated curve resets — token side to zero, quote side back
 * to the seed — so a LOW reading cannot distinguish "graduated" from "never
 * traded"; check `curveGraduated` before believing one.
 */
export function curveDepthFraction(r: CurveReserves): number | null {
  if (r.graduationThresholdRaw <= 0n) return null;
  const pct = Number((realQuoteRaw(r) * 10_000n) / r.graduationThresholdRaw) / 10_000;
  return pct > 1 ? 1 : pct;
}

/**
 * Has this curve already graduated to a Uniswap pool?
 *
 * Graduation drains the token side entirely and returns the quote side to the
 * virtual seed, so reserves alone read exactly like a brand-new empty curve.
 * That collision matters: the two are opposite situations — one has moved its
 * whole market to a pool the ordinary pricer can handle, the other has no
 * market at all — and a depth reading cannot tell them apart. The token side
 * can: only a graduated curve has none of its own token left.
 */
export function curveGraduated(r: CurveReserves): boolean {
  return r.tokenRaw === 0n;
}

/**
 * How far along the curve is toward graduating, 0..1 — an alias kept for the
 * meaning rather than the maths, since "progress" and "depth" are the same
 * quantity here expressed for different audiences.
 */
export const graduationProgress = curveDepthFraction;

/**
 * How far the price would fall if every prior buyer sold, in bps.
 *
 * THE CURVE'S ANSWER TO DIVERGENCE, and the number this safety model is built
 * on. A pool pricer asks "has spot run away from the time-weighted average" — a
 * question about manipulation, answerable only because an oracle remembers the
 * past. A curve has no memory and nothing to manipulate: its price is an exact
 * function of its reserves. What it has instead is OVERHANG.
 *
 * The real quote reserve is the aggregate cost basis of everyone who bought
 * before you. If they all leave, the reserve returns to the virtual seed and the
 * price returns with it. Since the constant product fixes tokenRaw = k/quoteRaw,
 * price is proportional to quoteRaw², so that floor is exactly (seed/quoteRaw)²
 * of the current price.
 *
 * THE INVERSION WORTH STATING PLAINLY: on a bonding curve, MORE DEPTH IS MORE
 * DOWNSIDE. Depth here is not a cushion, it is other people's exit. That runs
 * opposite to every instinct imported from Uniswap, where deeper is safer:
 *
 *    5% of threshold → 2,099 bps of floor drawdown
 *   10%              → 3,600 bps
 *   25%              → 6,213 bps
 *  100%              → 9,184 bps
 *
 * Past ~9.61% of threshold the curve merely doing what a curve does exceeds
 * trencher's 3,500 bps stop — so beyond that the stop can no longer distinguish
 * "this trade went wrong" from "this is a bonding curve".
 */
export function curveFloorDrawdownBps(r: CurveReserves): number | null {
  const seed = virtualSeedRaw(r.graduationThresholdRaw);
  if (seed <= 0n || r.quoteRaw < seed) return null;
  // 10_000 * (1 - (seed/quoteRaw)^2) in integers. Scaled before dividing so a
  // ratio near 1 does not floor away to nothing.
  const SCALE = 1_000_000n;
  const ratio = (seed * SCALE) / r.quoteRaw;
  const squared = (ratio * ratio) / SCALE;
  return Number(((SCALE - squared) * 10_000n) / SCALE);
}

/**
 * Fully diluted value of the launched token, USD 8dp.
 *
 * Exact, and free — no totalSupply() call. The curve mints the entire supply
 * into itself at launch, so k = seed x S; therefore tokenRaw = seed·S/quoteRaw,
 * price = quoteRaw²/(seed·S), and FDV = S x price = quoteRaw²/seed, with the
 * supply cancelling out entirely.
 *
 * Worth having because it BOUNDS what a curve can ever be worth. At the instant
 * of graduation quoteRaw is seed + threshold = 1.4 x threshold, so FDV is
 * (1.4T)²/0.4T = 4.9 x threshold — $50,218 on an ETH curve, and that is the
 * ceiling, reached only at the moment the curve stops existing. Across 1,680
 * live curves the highest observed was $26,953.
 *
 * That matters for a specific reason: trencher's minFdvUsd default is $50,000,
 * which no curve reaches in practice and only the very last block of one could
 * reach in theory. A gate set there refuses every curve forever while its
 * refusal reads as a judgement about the token rather than about the venue.
 */
export function curveFdvUsd8(r: CurveReserves, quoteUsd8: bigint): bigint | null {
  const seed = virtualSeedRaw(r.graduationThresholdRaw);
  if (seed <= 0n || r.quoteRaw <= 0n || quoteUsd8 <= 0n) return null;
  const fdvRaw = (r.quoteRaw * r.quoteRaw) / seed;
  return (fdvRaw * quoteUsd8) / 10n ** BigInt(r.quoteDecimals);
}

/**
 * What a curve price must clear before anything may act on it.
 *
 * Deliberately NOT PriceGuard. That guard's two questions — is the pool deep
 * enough, and has spot run from the TWAP — are the wrong two here: a curve has
 * no TWAP, and its depth means the opposite of what pool depth means. Reusing it
 * would report a confidence built for a different instrument.
 */
export interface CurveGuard {
  /** Raw USDG, 6dp — the same unit as PriceGuard.minLiquidityUsdg. */
  minRealDepthUsdg: bigint;
  /** Refuse when reverting to the curve's own floor would exceed this. */
  maxFloorDrawdownBps: number;
  /** Refuse a trade whose own size moves the price more than this. */
  maxImpactBps: number;
  /** Refuse a reading older than this many seconds. */
  maxReadAgeSec: number;
}

export type CurveRefusalKind =
  | "graduated"
  | "no-quote-price"
  | "too-thin"
  | "overhang"
  | "impact-cap"
  | "stale-read";

/**
 * Measured defaults. Every number came off chain 4663 rather than out of taste.
 *
 * Sample: 4,043 launches over 8.41h, 1,697 curves' reserves read, ETH at
 * $2,440.16 — every ETH curve carries the same 4.2 ETH threshold ($10,249) and
 * the same 1.68 ETH seed ($4,099).
 */
export const CURVE_GUARD_DEFAULTS: CurveGuard = {
  // 78% of live curves hold under $1 of real quote and 13.3% hold exactly zero
  // wei — their entire "market" is the virtual seed. $250 admits about 2.2%.
  minRealDepthUsdg: 250_000_000n,
  // Tied to TRENCHER_DEFAULTS.stopLossBps rather than picked: at 9.61% of
  // threshold the floor drawdown is 3,499 bps, so past it the stop-loss can no
  // longer tell a bad trade from ordinary curve behaviour.
  maxFloorDrawdownBps: 3_500,
  maxImpactBps: 300,
  // NOT the pool pricer's 60s TTL, and emphatically not its 600s route age.
  // Over 240 seconds the p99 price move among active curves was 1,546 bps and
  // the max 5,511 bps; a curve reading is worth about the block it was read at.
  maxReadAgeSec: 30,
};

/**
 * Is this curve price safe to act on?
 *
 * ORDER MATTERS, and the first check is the surprising one. A GRADUATED curve
 * resets — token side drained, quote side back to the seed — so its reserves
 * read identically to a curve nobody ever bought. Checking depth first would
 * report "too thin" about a token whose market has simply moved elsewhere,
 * which is a refusal naming the wrong reason. And it has moved to a Uniswap v4
 * pool this repo cannot read: of 17 graduated tokens sampled, 16 had no v3 pool
 * against WETH or USDG at any tier and the 17th held 13 wei. There is no
 * fallback to take, so saying so plainly is the only honest answer.
 */
export function curvePriceUsable(
  p: {
    price8: bigint;
    depthUsdg: bigint | null;
    depthFraction: number | null;
    graduated: boolean;
    floorDrawdownBps: number | null;
    impactBps: number | null;
    readAgeSec: number;
  },
  guard: CurveGuard,
): { ok: true } | { ok: false; kind: CurveRefusalKind; reason: string } {
  if (p.graduated) {
    return {
      ok: false,
      kind: "graduated",
      reason: "this curve has graduated — its market moved to a Uniswap v4 pool I cannot read yet",
    };
  }
  if (p.price8 <= 0n) {
    return { ok: false, kind: "no-quote-price", reason: "no USD price for what this curve is quoted in" };
  }
  if (p.readAgeSec > guard.maxReadAgeSec) {
    // Not pedantry: a curve has no time-average to smooth anything, and half a
    // percent of them move more than 55% inside four minutes.
    return {
      ok: false,
      kind: "stale-read",
      reason: `this reading is ${p.readAgeSec}s old and a curve moves too fast for that`,
    };
  }
  // Depth in USD, with deliberately NO feed-free fallback.
  //
  // An earlier version carried one — a fraction-of-threshold floor for curves
  // whose quote asset has no USD price — and it could never fire. Reaching this
  // line at all means a price8 was computed, which means the quote asset WAS
  // priceable; anything else was already refused above as `no-quote-price`.
  // Replayed against 900 live curves, not one of the 316 feedless-quote curves
  // reached that branch. A guard field that cannot fire is worse than no field:
  // someone eventually tunes it, nothing changes, and nothing says so.
  //
  // The feed-free floor is real, it just belongs one layer out. Discovery's
  // PONS_MIN_DEPTH_FRACTION judges the ~45% of launches quoted in stock tokens
  // and cbBTC, and there it does real work.
  if (p.depthUsdg === null || p.depthUsdg < guard.minRealDepthUsdg) {
    const have = p.depthUsdg === null ? "an unknown amount" : `$${(Number(p.depthUsdg) / 1e6).toFixed(0)}`;
    return {
      ok: false,
      kind: "too-thin",
      reason: `only ${have} has really been raised into this curve, under the $${Number(guard.minRealDepthUsdg) / 1e6} floor`,
    };
  }
  if (p.floorDrawdownBps === null || p.floorDrawdownBps > guard.maxFloorDrawdownBps) {
    return {
      ok: false,
      kind: "overhang",
      reason:
        p.floorDrawdownBps === null
          ? "I cannot tell how far this would fall back to the curve's own floor"
          : `${(p.floorDrawdownBps / 100).toFixed(0)}% of this price is other people's cost basis — it returns to the floor if they leave`,
    };
  }
  // Last, and honestly: impact on a curve is 10,000 x quoteIn/quoteRaw, and
  // quoteRaw is never below the seed (~$4,099 on an ETH curve), so a 300bps cap
  // first binds at about $124 of notional. At the default $5 entry size this
  // never fires. It is a ticket-size sanity check, NOT the safety model — the
  // overhang check above is.
  if (p.impactBps !== null && p.impactBps > guard.maxImpactBps) {
    return {
      ok: false,
      kind: "impact-cap",
      reason: `a trade this size would move the curve ${(p.impactBps / 100).toFixed(1)}%`,
    };
  }
  return { ok: true };
}
