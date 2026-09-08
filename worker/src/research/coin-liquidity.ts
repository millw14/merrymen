/**
 * WHAT A LIQUIDITY ANALYST CAN HONESTLY BE TOLD ABOUT A BONDING CURVE.
 *
 * The memecoin desk asks for four lenses — technical, onchain, social,
 * liquidity — and until now supplied material for exactly one. The other three
 * answered NO DATA AVAILABLE while still costing a model call each, so a
 * memecoin decision was three quarters analyst-shaped silence at full price.
 *
 * This fills `liquidity`, and it is the one of the three that needs NO NEW I/O
 * AT ALL. `readCurvePrices` reads every held curve's live reserves each tick to
 * value the position and keeps them in `legs`; eight pure functions in
 * pons-price.ts already turn those exact reserves into depth, progress toward
 * graduation, overhang, FDV, an exit quote and a price impact. Nothing here
 * calls a chain, a vendor or a model. It is arithmetic on a number already read.
 *
 * THE ONE THING THIS LENS EXISTS TO SAY. On a bonding curve, MORE DEPTH IS MORE
 * DOWNSIDE — the real quote reserve is the aggregate cost basis of everyone who
 * bought before you, and if they leave the price returns to the virtual seed.
 * That is the opposite of the instinct any model carries in from Uniswap, and an
 * analyst not told so will read a deep curve as a safe one. So
 * `curveFloorDrawdownBps` is not one figure among several here; it is the
 * headline, and the block says in words what it means.
 *
 * WHAT IT REFUSES TO SAY. No holder count, no age, no volume, no launch
 * narrative — those are the `onchain` and `social` lenses and this file has no
 * source for any of them, so it names their absence rather than leaving it to be
 * read as cleanliness. A quote asset with no USD price yields no dollar figures
 * and the block says so; but graduation progress, overhang and price impact are
 * computed against the curve's OWN threshold and need no feed at all, so they
 * are stated even then. That split is the point: a curve nobody can price in
 * dollars is still a curve whose risk is exactly computable.
 *
 * PURE. Given reserves, returns prose.
 */
import {
  curveBuyImpactBps,
  curveDepthFraction,
  curveFdvUsd8,
  curveFloorDrawdownBps,
  curveGraduated,
  curvePrice,
  curveSellOut,
  realQuoteRaw,
  virtualSeedRaw,
  type CurveReserves,
} from "../venues/pons-price";

export interface LiquidityInputs {
  symbol: string;
  reserves: CurveReserves;
  /** USD price of the quote asset, 8dp. Null when this repo cannot price it. */
  quoteUsd8: bigint | null;
  /** What the curve is quoted in, for the sentence. */
  quoteSymbol: string;
  /** What the agent holds of this token, raw units. Zero when it holds none. */
  heldRaw: bigint;
  /** The size a buy would be proposed at, micro-USDG. Zero when none is sized. */
  probeUsdg: bigint;
}

const usd8From = (raw: bigint, decimals: number, quoteUsd8: bigint): bigint =>
  (raw * quoteUsd8) / 10n ** BigInt(decimals);

const money = (usd8: bigint): string => {
  const whole = Number(usd8) / 1e8;
  if (whole >= 1000) return `$${Math.round(whole).toLocaleString("en-US")}`;
  if (whole >= 1) return `$${whole.toFixed(2)}`;
  return `$${whole.toFixed(4)}`;
};

const units = (raw: bigint, decimals: number): string => {
  const n = Number(raw) / 10 ** decimals;
  return n >= 1 ? n.toFixed(4) : n.toPrecision(3);
};

/**
 * Turn one curve's reserves into the liquidity analyst's material.
 *
 * Returns null only when there is genuinely nothing to say — an empty side that
 * is not a graduation, which is a reading this module cannot interpret rather
 * than a market it can describe. An empty string would reach Brain as a
 * supplied-but-blank lens; null reaches it as NO DATA AVAILABLE, which is the
 * truthful one.
 */
export function renderLiquidity(i: LiquidityInputs): string | null {
  const r = i.reserves;
  const lines: string[] = [];

  // GRADUATION READS EXACTLY LIKE AN EMPTY CURVE and is the opposite situation:
  // the whole market moved to a Uniswap pool and these reserves are a reset.
  // Checked first, because every figure below it would describe a venue that no
  // longer trades this token.
  if (curveGraduated(r)) {
    return (
      `${i.symbol} HAS GRADUATED off its bonding curve. The curve holds none of the token, which ` +
      `happens only at graduation, and the market has moved to a Uniswap pool. Nothing about this ` +
      `venue applies any more: the reserves here are a reset, not a market. Liquidity for this ` +
      `token is now whatever that pool holds, and this lens cannot see the pool.`
    );
  }
  if (r.quoteRaw <= 0n || r.tokenRaw <= 0n) return null;

  const progress = curveDepthFraction(r);
  const overhangBps = curveFloorDrawdownBps(r);
  const realRaw = realQuoteRaw(r);
  const seedRaw = virtualSeedRaw(r.graduationThresholdRaw);
  const quoteUsd8 = i.quoteUsd8;
  const priced = quoteUsd8 === null ? null : curvePrice(r, quoteUsd8);

  // ── what is actually there ────────────────────────────────────────────────
  lines.push(
    `${i.symbol} trades on a Pons bonding curve quoted in ${i.quoteSymbol}. There is no order book ` +
      `and no pool: the reserves ARE the market, so every figure below is exact rather than sampled.`,
  );
  lines.push(
    `Real money raised: ${units(realRaw, r.quoteDecimals)} ${i.quoteSymbol}` +
      (priced ? ` (${money(priced.depthUsd8)})` : ` — no USD price for ${i.quoteSymbol}, so no dollar figure`) +
      `. That EXCLUDES a virtual seed of ${units(seedRaw, r.quoteDecimals)} ${i.quoteSymbol}, which the ` +
      `curve prices against but does not hold: the contract's own reserve reading counts it, and it is ` +
      `not money anyone can sell into.`,
  );
  if (progress !== null) {
    lines.push(
      `Progress toward graduation: ${(progress * 100).toFixed(1)}% of this curve's own threshold. ` +
        `Measured against the curve rather than against dollars, so it needs no price feed and cannot ` +
        `go stale. For scale: against a base graduation rate of 0.96%, curves reaching 25% graduate ` +
        `18.2% of the time.`,
    );
  }

  // ── the number this lens exists for ───────────────────────────────────────
  if (overhangBps !== null) {
    lines.push(
      `OVERHANG — READ THIS BEFORE SIZING. If every prior buyer sold, the price would fall ` +
        `${(overhangBps / 100).toFixed(1)}% and stop there, because the quote reserve would return to ` +
        `the virtual seed and the price with it. On a bonding curve DEPTH IS OTHER PEOPLE'S EXIT, so ` +
        `more depth is MORE downside, not less — the reverse of a Uniswap pool, where deeper is safer. ` +
        `Depth here is a liveness test, never a safety margin. And a tight stop is inside routine curve ` +
        `movement: p99 price movement among active curves is 1,546bps over four minutes.`,
    );
  }
  if (priced && quoteUsd8 !== null) {
    const fdv = curveFdvUsd8(r, quoteUsd8);
    if (fdv !== null) {
      lines.push(
        `Fully diluted value: ${money(fdv)}. This is a CEILING as much as a measure — a curve's FDV at ` +
          `the instant it graduates is 4.9x its threshold, and it stops existing there, so the largest ` +
          `FDV any live curve can carry is about $50,000 and the largest observed across 1,680 of them ` +
          `was $26,953. A curve is not a small cap; it is a pre-market.`,
      );
    }
  }

  // ── what it would cost this agent, at this size, right now ────────────────
  if (i.heldRaw > 0n) {
    const out = curveSellOut(r, i.heldRaw);
    if (out === null) {
      lines.push(
        `Exit quote: the curve will not quote a sale of the ${units(i.heldRaw, r.tokenDecimals)} tokens ` +
          `held. Treat this position as unexitable at this venue until it will.`,
      );
    } else {
      const outUsd8 = quoteUsd8 === null ? null : usd8From(out, r.quoteDecimals, quoteUsd8);
      // The honest exit figure. A mark of spot x quantity is a price no sale
      // gets: it charges neither the fee nor the curve this sale walks down.
      const spotOut = (i.heldRaw * r.quoteRaw) / r.tokenRaw;
      const shortfallBps = spotOut > 0n ? Number(((spotOut - out) * 10_000n) / spotOut) : null;
      lines.push(
        `Exit quote for the whole position (${units(i.heldRaw, r.tokenDecimals)} tokens): ` +
          `${units(out, r.quoteDecimals)} ${i.quoteSymbol}` +
          (outUsd8 === null ? "" : ` (${money(outUsd8)})`) +
          (shortfallBps === null
            ? "."
            : `, which is ${(shortfallBps / 100).toFixed(2)}% under what that quantity marks at. That gap ` +
              `is the 0.99% curve fee plus the price this sale moves against itself. It is what leaving ` +
              `actually pays; the mark is not.`),
      );
    }
  } else {
    lines.push(`The agent holds none of this token, so there is no exit to quote.`);
  }

  if (i.probeUsdg > 0n && quoteUsd8 !== null && quoteUsd8 > 0n) {
    // micro-USDG → 8dp USD → raw quote units, so impact is measured at the size
    // actually on the table rather than at a round number nobody would trade.
    const inRaw = (i.probeUsdg * 100n * 10n ** BigInt(r.quoteDecimals)) / quoteUsd8;
    const impact = curveBuyImpactBps(r, inRaw);
    if (impact !== null) {
      lines.push(
        `A buy of ${money(i.probeUsdg * 100n)} at these reserves moves the price ` +
          `${(impact / 100).toFixed(2)}% against itself before the fee. Impact on a curve is bounded ` +
          `below by the seed, so it stays small at sizes like this — it is not the constraint here. ` +
          `The overhang is.`,
      );
    }
  }

  lines.push(
    `NOT IN THIS LENS: holder distribution, curve age, trade count, and who is on the other side. No ` +
      `source for any of those was read, so treat their absence as unknown rather than as clean.`,
  );
  return lines.join("\n");
}
