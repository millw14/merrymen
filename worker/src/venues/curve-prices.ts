/**
 * Pricing owner-held tokens that trade on a Pons bonding curve.
 *
 * WHAT THIS IS FOR. `createPoolPriceReader` refuses a curve token before it
 * looks at anything, with `no-pool` — correctly, since there is no Uniswap pool
 * to read. So a token the owner added because they hold it on a curve was
 * simply unvalued: it fell out of `positions` and was carried at cost. This
 * gives it a number, with a safety model of its own.
 *
 * NOTHING IS CACHED, AND THAT IS THE DESIGN. `pool-prices.ts` caches a route for
 * 60 seconds because a 15-minute TWAP does not move meaningfully inside one. A
 * curve has no time-average at all: over 240 seconds the p99 price move among
 * active curves was 1,546 bps and the maximum 5,511 bps. Reusing that cache
 * would be a category error, so every tick reads the reserves fresh, and the
 * guard's `stale-read` check exists to catch anyone who later adds caching
 * without thinking about it.
 *
 * WHAT A CURVE QUOTE IS AND IS NOT. It is good enough to VALUE something already
 * held. It is not good enough to authorise a new buy — nothing checked it
 * against an oracle, because there is no oracle to check it against. That
 * distinction is not enforced here; it is enforced by the quote carrying
 * `source: "curve"`, which keeps the token inside the scout ceiling and out of
 * the high-water mark. If this module ever starts emitting `source: "pool"`,
 * both of those protections disappear silently.
 */
import type { PublicClient } from "viem";
import type { PriceQuote, StockToken } from "../../../packages/core/src/index";
import { readCurveReserves } from "./pons";
import {
  curveDepthFraction,
  curveFloorDrawdownBps,
  curveGraduated,
  curvePrice,
  curvePriceUsable,
  type CurveGuard,
  type CurveRefusalKind,
  type CurveReserves,
} from "./pons-price";

/** Where a token trades, and what it takes to read its reserves as money. */
export interface CurveRef {
  curve: `0x${string}`;
  /** `0x000…0` means native ETH. */
  quoteToken: `0x${string}`;
  graduationThresholdRaw: bigint;
}

export interface CurvePricesResult {
  quotes: Map<string, PriceQuote>;
  refused: { symbol: string; kind: CurveRefusalKind | "no-curve"; reason: string }[];
  /**
   * WHAT THIS PASS ALREADY READ, kept instead of thrown away.
   *
   * Every entry here cost an RPC call that has already been made: the pricer
   * reads a curve's reserves to value it, then discarded everything except the
   * derived price. A strategist that wants to TRADE a curve needs exactly the
   * same three facts, and reading them again a moment later would double the
   * cost and — worse — get a different answer. The header of this file forbids
   * caching curve reserves for good reason: measured p99 movement is 1,546 bps
   * over 240 seconds. Two reads of the same tick are two different markets.
   *
   * Only symbols the guard ALLOWED appear. A curve too shallow, too graduated
   * or too fresh to price is also one nobody should be sized against, so the
   * refusal that keeps it off the dashboard keeps it out of here too — one
   * decision, not two that can drift.
   */
  legs: Map<string, { curve: `0x${string}`; quoteToken: `0x${string}`; reserves: CurveReserves }>;
}

export interface CurvePricesDeps {
  client: PublicClient;
  tokens: readonly StockToken[];
  /**
   * Where this token trades. Null when we have no record of a curve for it.
   *
   * Injected rather than reaching into the store so the pricing logic can be
   * tested without a database, and so the "we do not know where this trades"
   * branch is explicit rather than an exception.
   */
  curveOf: (address: string) => Promise<CurveRef | null>;
  /** USD price of a quote asset, 8dp. Null when this repo cannot price it. */
  quoteUsd8Of: (quoteToken: `0x${string}`) => bigint | null;
  /** Decimals of a quote asset, for converting its reserve to USD. */
  quoteDecimalsOf: (quoteToken: `0x${string}`) => number;
  guard: CurveGuard;
}

/**
 * Price each token that trades on a curve, refusing with a stated reason.
 *
 * A refusal is the normal outcome and is not an error: most curves hold almost
 * nothing, and roughly half are quoted in assets this repo cannot value at all.
 * Every refusal names which, so the owner sees "I cannot price what this is
 * quoted in" rather than a silent absence.
 */
export async function readCurvePrices(deps: CurvePricesDeps): Promise<CurvePricesResult> {
  const quotes = new Map<string, PriceQuote>();
  const refused: CurvePricesResult["refused"] = [];
  const legs: CurvePricesResult["legs"] = new Map();

  for (const t of deps.tokens) {
    const ref = await deps.curveOf(t.address);
    if (!ref) {
      // Honest, and deliberately not a scan. The launch log only reaches ~8.4
      // hours back, so scanning would find recent tokens and silently fail for
      // older ones — succeeding often enough to be trusted and failing often
      // enough to matter.
      refused.push({
        symbol: t.symbol,
        kind: "no-curve",
        reason: "I know this token but not where it trades",
      });
      continue;
    }

    const quoteDecimals = deps.quoteDecimalsOf(ref.quoteToken);
    const reserves = await readCurveReserves(deps.client, ref, {
      quote: quoteDecimals,
      token: t.decimals ?? 18,
    });
    if (!reserves) {
      refused.push({ symbol: t.symbol, kind: "no-curve", reason: "its curve did not answer" });
      continue;
    }

    // Graduation is checked by the guard, but the reserves have to be read
    // first to know — and a graduated curve prices at the seed, which is a real
    // number for a market that no longer exists there.
    const graduated = curveGraduated(reserves);
    const quoteUsd8 = deps.quoteUsd8Of(ref.quoteToken);
    const priced = quoteUsd8 === null ? null : curvePrice(reserves, quoteUsd8);
    // 8dp → 6dp at the boundary. depthUsd8 is the only 8dp depth in the worker
    // and every guard downstream is 6dp USDG; carrying the 8dp number under a
    // 6dp name would let a $250 curve clear a $25,000 floor.
    const depthUsdg = priced ? priced.depthUsd8 / 100n : null;

    const verdict = curvePriceUsable(
      {
        price8: priced?.price8 ?? 0n,
        depthUsdg,
        depthFraction: curveDepthFraction(reserves),
        graduated,
        floorDrawdownBps: curveFloorDrawdownBps(reserves),
        // Not sizing a trade here — this is a valuation read, and impact is a
        // property of a trade, not of a price. The trade-time check belongs
        // wherever a size is chosen.
        impactBps: null,
        // Read this instant. The field exists so that adding a cache later
        // cannot quietly bypass the freshness rule.
        readAgeSec: 0,
      },
      deps.guard,
    );
    if (!verdict.ok) {
      refused.push({ symbol: t.symbol, kind: verdict.kind, reason: verdict.reason });
      continue;
    }

    legs.set(t.symbol, { curve: ref.curve, quoteToken: ref.quoteToken, reserves });
    quotes.set(t.symbol, {
      price8: priced!.price8,
      // Read fresh from the chain this tick. `stale` means "a Chainlink feed
      // stopped updating", which has no analogue here — and repurposing it to
      // mean "unverifiable" would make dip-hunter skip the token entirely and
      // print weekend-market language about something that trades 24/7. The
      // freshness question is answered by the guard refusing, not by a flag on
      // a quote that was allowed through.
      stale: false,
      source: "curve",
      detail: `bonding curve, ${((curveDepthFraction(reserves) ?? 0) * 100).toFixed(1)}% to graduation`,
      liquidityUsdg: depthUsdg ?? undefined,
    });
  }

  return { quotes, refused, legs };
}
