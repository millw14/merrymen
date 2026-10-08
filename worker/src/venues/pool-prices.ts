/**
 * Pool pricing for the tick: batch, cache, and — most importantly — REFUSE.
 *
 * pool-price.ts knows how to read one token's TWAP from Uniswap. This module is
 * what the tick actually calls, and it adds the three things a trading loop
 * needs that a single read doesn't:
 *
 *  1. A GUARD APPLIED EVERY TIME. Reads are cached; verdicts are not. The owner
 *     can tighten the liquidity floor mid-run and the very next tick honours it,
 *     because the cache holds the raw route and the judgement is re-made fresh.
 *
 *  2. A CACHE, because a routed price is expensive. Each token costs up to three
 *     getPool + three balanceOf + token0 + slot0 + observe PER LEG, and most of
 *     this chain's memecoins are two legs. At 50 tokens on a 15s tick that is
 *     thousands of RPC calls a minute for a number whose whole point is that it
 *     moves slowly — the TWAP window is 15 minutes.
 *
 *  3. A REASON when there's no price. "CATE isn't priced" is not actionable;
 *     "CATE's pool holds $312, below your $5,000 floor" tells the owner whether
 *     to lower the floor, or that the coin is simply too thin to trade.
 *
 * A refusal is the correct outcome, not a failure. A price nobody can trust is
 * worse than no price at all: it feeds equity, P&L and the drawdown breaker, so
 * a manipulable number lets an outsider fake the owner's net worth or trip their
 * circuit breaker on demand.
 */

import type { PublicClient } from "viem";
import { CASH, type PriceQuote, type StockToken } from "../../../packages/core/src/index";
import {
  poolPriceUsable,
  readRoutedPrice,
  readSpotLeg,
  type PriceGuard,
  type RefusalKind,
  type RoutedPrice,
} from "./pool-price";
import { SpotSampler, type SampledPrice } from "./spot-sampler";

/**
 * How long a routed read stays fresh. Well under the 15-minute TWAP window, so
 * the cached number is never a materially different number from a fresh one —
 * this trades RPC volume for staleness that the averaging window already implies.
 */
export const DEFAULT_CACHE_TTL_SEC = 60;

/**
 * How long a route may go UNCONFIRMED before it stops counting.
 *
 * readRoutedPrice returns null for two different things — "there is no pool" and
 * "the RPC didn't answer" — and the caller can't tell them apart. Letting null
 * always win means one flaky call drops a held position's valuation, which pauses
 * equity, the high-water mark and the drawdown breaker for that tick. Letting the
 * old route always win means a pool that was genuinely drained keeps producing a
 * price forever.
 *
 * So: a route that fails to refresh is KEPT but does not have its age reset, and
 * it is dropped once it passes this bound. Comfortably inside the 15-minute TWAP
 * window, so a route served at the limit is still a number of the same kind.
 */
export const MAX_ROUTE_AGE_SEC = 600;

export interface PoolQuoteRefusal {
  symbol: string;
  /**
   * A stable identifier for WHY. Callers that only want to speak up when the
   * situation changes must key on this, never on `reason` — the prose carries a
   * live pool balance and a divergence percentage, so it changes every time
   * anyone trades, and a change-detector built on it fires forever.
   */
  /**
   * Curve refusals arrive here too, prefixed `curve-`, when a token has no
   * pool but does have a bonding curve. Same contract: stable identifier, never
   * the prose.
   */
  kind: RefusalKind | "no-pool" | "stale-read" | "sampling" | `curve-${string}`;
  reason: string;
}

export interface PoolPricesResult {
  /** Symbol → quote, for tokens whose price passed the guard. */
  quotes: Map<string, PriceQuote>;
  /** Tokens deliberately left unpriced, each with a reason a human can act on. */
  refused: PoolQuoteRefusal[];
}

interface CacheEntry {
  /** The raw route, unjudged. null = no pool found at all. */
  routed: RoutedPrice | null;
  fetchedAt: number;
}

export interface PoolPriceReader {
  read(args: {
    client: PublicClient;
    tokens: readonly StockToken[];
    guard: PriceGuard;
    /** Unix seconds. Passed in rather than read from the clock so tests are honest. */
    nowSec: number;
  }): Promise<PoolPricesResult>;
  /** Drop everything cached — used when the chain or RPC changes underfoot. */
  reset(): void;
}

/** Human-readable provenance. Shown wherever a pool-priced value is displayed. */
export function describeRoute(r: RoutedPrice): string {
  const depth = Number(r.liquidityUsdg) / 1e6;
  const hop = r.route === "direct" ? "USDG pool" : "via WETH";
  return `${r.twapWindowSec / 60}m TWAP, ${hop}, $${depth.toLocaleString(undefined, { maximumFractionDigits: 0 })} deep`;
}

/**
 * The cache key includes DECIMALS, not just the address.
 *
 * A cached price8 was computed with the decimals declared at fetch time, and
 * positionValueUsdg divides by 10^decimals from the CURRENT settings. Key on the
 * address alone and correcting a mis-declared token (18 → 9, say) serves the old
 * price against the new divisor for a full TTL — valuing the holding 10^9 times
 * high, ratcheting that into the PERSISTED high-water mark, and tripping the
 * drawdown breaker permanently once the cache catches up.
 */
const cacheKey = (t: StockToken) => `${t.address.toLowerCase()}:${t.decimals ?? 18}`;

/**
 * The spot-vs-average band for a SAMPLED price: twice the pool band.
 *
 * The pool band compares spot with a fifteen-minute oracle; a sampled average
 * covers five, of a coin new enough that it is still finding its price. Held to
 * the pool band, every coin moving the way a fast Trencher exists to trade would
 * be refused as manipulated. Doubled rather than fixed so an owner who tightens
 * their band tightens this one with it. What the band is for is unchanged: a
 * reading that jumped away from the coin's own recent series.
 */
export function sampledDivergenceBps(guard: PriceGuard): number {
  return guard.maxDivergenceBps * 2;
}

/**
 * What a sampled series is a history OF: the pool read, and the route through
 * it. Lowercased. A series recorded under one identity is never read under
 * another (spot-sampler.ts), so a route that moves to a new pool starts over.
 */
export function spotIdentity(r: RoutedPrice): string {
  const leg = r.spotOnly;
  return leg ? `${r.route}:${leg.pool.toLowerCase()}:${leg.tokenIsToken0 ? 0 : 1}:${leg.cashDecimals}` : "";
}

/** The route a sampled series is kept for: a spot route, or the spot alternative riding a TWAP one. */
export function spotOf(r: RoutedPrice): RoutedPrice | null {
  return r.spotOnly ? r : r.spotAlternative?.spotOnly ? r.spotAlternative : null;
}

/**
 * WHETHER A CURRENT TWAP ROUTE STANDS when a refresh can only find a spot one.
 *
 * Kept (the refresh treated as a failed read, ageing toward MAX_ROUTE_AGE_SEC):
 *  - the spot route is on ANOTHER pool and is not deeper — it came back only
 *    because the TWAP pool's read failed this time (a rate limit, a timeout);
 *    were it deeper, the TWAP route would have carried it as an alternative.
 *  - it is the SAME pool and that pool keeps a real oracle ring (cardinality
 *    over 1) whose window just came up short — a ring overrun by a burst of
 *    swaps looks exactly like this, and a TWAP must not be traded for a spot
 *    price on it.
 * Taken at once: the same pool with a single observation. That pool can only
 *  have "answered" before by extrapolating one quiet observation; its first
 *  swap ends that, and its spot is now the truth — keeping the old reading
 *  would freeze a pre-trade price, depth and divergence for minutes.
 */
export function keepTwapOver(previous: { routed: RoutedPrice | null; fetchedAt: number } | undefined, routed: RoutedPrice, nowSec: number): boolean {
  const prev = previous?.routed;
  if (!prev || prev.spotOnly || !routed.spotOnly || nowSec - previous!.fetchedAt > MAX_ROUTE_AGE_SEC) return false;
  const samePool = !!prev.pool && prev.pool.toLowerCase() === routed.spotOnly.pool.toLowerCase();
  return samePool ? routed.spotOnly.oracleCardinality > 1 : routed.liquidityUsdg <= prev.liquidityUsdg;
}

/** Human-readable provenance for a sampled price, beside `describeRoute`. */
export function describeSampled(r: RoutedPrice, s: SampledPrice): string {
  const depth = Number(s.liquidityUsdg) / 1e6;
  const hop = r.route === "direct" ? "USDG pool" : "via WETH";
  const span = s.spanSec >= 60 ? `${Math.round(s.spanSec / 60)}m` : `${s.spanSec}s`;
  return `new pool, ${span} sampled spot (${s.readings} readings), ${hop}, $${depth.toLocaleString(undefined, { maximumFractionDigits: 0 })} deep`;
}

export function createPoolPriceReader(opts?: { ttlSec?: number; sampler?: SpotSampler }): PoolPriceReader {
  const ttlSec = opts?.ttlSec ?? DEFAULT_CACHE_TTL_SEC;
  const cache = new Map<string, CacheEntry>();
  // Fed on EVERY read, not every route refresh: the series is only as dense as
  // the reads that feed it (spot-sampler.ts).
  const sampler = opts?.sampler ?? new SpotSampler();

  return {
    reset() {
      for (const key of cache.keys()) sampler.drop(key);
      cache.clear();
    },

    async read({ client, tokens, guard, nowSec }) {
      const quotes = new Map<string, PriceQuote>();
      const refused: PoolQuoteRefusal[] = [];
      if (!tokens.length) return { quotes, refused };

      // Only the misses go to the network. A warm cache costs nothing.
      const stale = tokens.filter((t) => {
        const hit = cache.get(cacheKey(t));
        return !hit || nowSec - hit.fetchedAt >= ttlSec;
      });
      const refreshed = new Set<string>();

      await Promise.all(
        stale.map(async (t) => {
          const key = cacheKey(t);
          const previous = cache.get(key);
          let routed: RoutedPrice | null = null;
          try {
            routed = await readRoutedPrice(client, {
              token: t.address,
              tokenDecimals: t.decimals ?? 18,
              cash: CASH.USDG as `0x${string}`,
              cashDecimals: 6,
              weth: CASH.WETH as `0x${string}`,
              // A pool too new for an oracle comes back priced at its spot,
              // and is judged off the sampled series below — never off that
              // one spot reading.
              allowSpot: true,
            });
          } catch {
            routed = null; // readRoutedPrice usually swallows its own errors anyway
          }
          if (routed?.spotOnly && keepTwapOver(previous, routed, nowSec)) return;
          if (routed) {
            cache.set(key, { routed, fetchedAt: nowSec });
            // The full read's spot IS this tick's reading — of the spot route,
            // or of the deeper oracle-less alternative riding a TWAP route. A
            // route with neither needs no series: its pool keeps its own.
            const spot = spotOf(routed);
            if (spot) {
              sampler.record(key, { atSec: nowSec, price18: spot.price18 ?? spot.price8 * 10_000_000_000n, liquidityUsdg: spot.liquidityUsdg }, spotIdentity(spot));
            } else sampler.drop(key);
            refreshed.add(key);
            return;
          }
          // Nothing came back. That's either "no pool" or "the RPC didn't
          // answer" — indistinguishable here. Keep a route we already had, but
          // do NOT touch fetchedAt: it keeps ageing, and MAX_ROUTE_AGE_SEC below
          // eventually retires it whichever of the two it actually was.
          if (!previous?.routed) cache.set(key, { routed: null, fetchedAt: nowSec });
        }),
      );

      // EVERY OTHER ORACLE-LESS ROUTE GETS ITS READING TOO — two calls on the
      // pool already found, instead of the full search a refresh costs. A
      // failed read records nothing: the series ages, and a long enough hole
      // restarts it (SAMPLE_MAX_GAP_SEC).
      await Promise.all(
        tokens.map(async (t) => {
          const key = cacheKey(t);
          const hit = cache.get(key);
          const route = hit?.routed ? spotOf(hit.routed) : null;
          if (refreshed.has(key) || !hit || !route?.spotOnly || nowSec - hit.fetchedAt > MAX_ROUTE_AGE_SEC) return;
          const spot = await readSpotLeg(client, route.spotOnly);
          if (spot) sampler.record(key, { atSec: nowSec, price18: spot.price18, liquidityUsdg: spot.liquidityUsdg }, spotIdentity(route));
        }),
      );

      for (const t of tokens) {
        const hit = cache.get(cacheKey(t));
        if (hit?.routed && nowSec - hit.fetchedAt > MAX_ROUTE_AGE_SEC) {
          refused.push({
            symbol: t.symbol,
            kind: "stale-read",
            reason: `pool hasn't been readable for ${Math.round((nowSec - hit.fetchedAt) / 60)}m — refusing to keep valuing it off a stale reading`,
          });
          continue;
        }
        if (!hit || !hit.routed) {
          refused.push({
            symbol: t.symbol,
            kind: "no-pool",
            reason: "no Uniswap v3 pool against USDG or WETH — nothing to price it from",
          });
          continue;
        }
        const r = hit.routed;
        if (r.spotOnly) {
          const quote = sampledQuote(r, sampler.read(cacheKey(t), nowSec, spotIdentity(r)), guard);
          if ("refusal" in quote) refused.push({ symbol: t.symbol, ...quote.refusal });
          else quotes.set(t.symbol, quote.quote);
          continue;
        }
        // The guard is re-applied on every read, against the CURRENT settings —
        // a cached route must never carry a stale verdict.
        const verdict = poolPriceUsable(r, guard);
        // TOO THIN, WITH A DEEPER MARKET BESIDE IT: the deeper market answers.
        // A dust pool with a working oracle must not leave a coin whose real
        // market is a deep new pool unpriced — and a held one force-sold as
        // unpriceable. Only for depth: a TWAP refused as divergent is being
        // pushed, and that refusal stands.
        if (!verdict.ok && verdict.kind === "too-thin" && r.spotAlternative) {
          const alt = r.spotAlternative;
          const quote = sampledQuote(alt, sampler.read(cacheKey(t), nowSec, spotIdentity(alt)), guard);
          if ("refusal" in quote) refused.push({ symbol: t.symbol, ...quote.refusal });
          else quotes.set(t.symbol, quote.quote);
          continue;
        }
        if (!verdict.ok) {
          refused.push({ symbol: t.symbol, kind: verdict.kind, reason: verdict.reason });
          continue;
        }
        quotes.set(t.symbol, {
          price8: r.price8,
          // A TWAP is time-averaged by construction, not stale in the Chainlink
          // sense (a feed that stopped updating). Flagging it stale would make
          // every memecoin look broken on a weekend for no reason.
          stale: false,
          source: "pool",
          detail: describeRoute(r),
          // The number itself, not the sentence. describeRoute stays the human
          // string; this is what any guard or exit actually reads.
          liquidityUsdg: r.liquidityUsdg,
        });
      }

      return { quotes, refused };
    },
  };
}

/**
 * A price for an oracle-less route, from its sampled series — or why not.
 *
 * The same depth floor as every pool quote, at the newest reading's depth; the
 * spot-vs-average band at `sampledDivergenceBps`, also counting the WETH leg's
 * own divergence on a two-hop route. A series that is not ready still prices
 * (`sampled.ready` false), so a held coin is valued while it refills; only a
 * ready one may authorise a buy, and that is decided by the buyer
 * (strategies/trencher.ts), not here.
 */
export function sampledQuote(
  r: RoutedPrice,
  s: SampledPrice | null,
  guard: PriceGuard,
): { quote: PriceQuote } | { refusal: { kind: PoolQuoteRefusal["kind"]; reason: string } } {
  if (!s) {
    return {
      refusal: {
        kind: "sampling",
        reason: "its pool is too new to keep its own price history, and we have no recent reading of it to average",
      },
    };
  }
  if (s.price8 <= 0n) {
    return { refusal: { kind: "sampling", reason: "its price is below what an 8-decimal quote can carry" } };
  }
  const depth = poolPriceUsable(
    { price8: s.price8, liquidityUsdg: s.liquidityUsdg, twapWindowSec: s.spanSec, divergenceBps: 0 },
    guard,
  );
  if (!depth.ok) return { refusal: { kind: depth.kind, reason: depth.reason } };
  const band = sampledDivergenceBps(guard);
  const divergence = Math.max(s.divergenceBps, r.divergenceBps);
  if (divergence > band) {
    return {
      refusal: {
        kind: "divergent",
        reason: `spot is ${(divergence / 100).toFixed(1)}% off its ${Math.round(s.spanSec / 60)}m sampled average (limit ${(band / 100).toFixed(1)}%) — pool may be under manipulation`,
      },
    };
  }
  return {
    quote: {
      price8: s.price8,
      stale: false,
      source: "sampled",
      detail: describeSampled(r, s),
      liquidityUsdg: s.liquidityUsdg,
      sampled: { readings: s.readings, spanSec: s.spanSec, ready: s.ready },
    },
  };
}
