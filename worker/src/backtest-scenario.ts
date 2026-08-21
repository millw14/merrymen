/**
 * Synthetic price-series generator for the Strategy Playground.
 *
 * backtest.ts is explicit that it runs over synthetic prices, not a market
 * replay — so the playground doesn't need historical data or an API key. This
 * just builds a plausible Bar[] for a chosen basket so a real strategy and the
 * real policy layer (checkPolicy, same as production) have something to tick
 * against. Weekends are marked stale, same as real 24/5 Chainlink feeds — so
 * weekend-gap has something real to do here, not just steady-basket.
 */

import type { Bar } from "./backtest";

export interface ScenarioConfig {
  /** Symbols in the basket, e.g. ["AAPL", "QQQ"]. */
  symbols: string[];
  /** Starting price per symbol, USD. Missing symbols default to 100. */
  startPrice: Record<string, number>;
  /** Number of daily bars to generate. */
  days: number;
  /** Annualized volatility, e.g. 0.25 for 25%. Default 0.25. */
  volatility?: number;
  /** Annualized drift, e.g. 0.08 for 8%/yr. Default 0.06. */
  drift?: number;
  /** Seed for a reproducible run (same seed -> same series). Default 42. */
  seed?: number;
  /** First bar timestamp. Defaults to a fixed Monday and is injectable for tests. */
  startTimeSec?: number;
}

const DAY_SEC = 86_400;
/** Fixed Monday so a seed reproduces the same path across machines and dates. */
export const DEFAULT_SCENARIO_START_SEC = Date.UTC(2024, 0, 1) / 1000;

/** Small seeded PRNG so a given seed always reproduces the same series. */
function mulberry32(seed: number) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function buildScenario(cfg: ScenarioConfig): Bar[] {
  const rand = mulberry32(cfg.seed ?? 42);
  const vol = cfg.volatility ?? 0.25;
  const drift = cfg.drift ?? 0.06;
  const dailyVol = vol / Math.sqrt(252);
  const dailyDrift = drift / 252;

  const price = new Map(cfg.symbols.map((s) => [s, cfg.startPrice[s] ?? 100]));
  const bars: Bar[] = [];
  const t0 = cfg.startTimeSec ?? DEFAULT_SCENARIO_START_SEC;

  for (let i = 0; i < cfg.days; i++) {
    const tSec = t0 + i * DAY_SEC;
    const dow = new Date(tSec * 1000).getUTCDay();
    const isWeekend = dow === 0 || dow === 6;
    const prices = new Map<string, bigint>();
    const staleSymbols = new Set<string>();

    for (const s of cfg.symbols) {
      if (!isWeekend) {
        const shock = dailyDrift + dailyVol * gaussian(rand);
        price.set(s, Math.max(0.01, price.get(s)! * (1 + shock)));
      } else {
        staleSymbols.add(s); // price holds flat, feed marked stale over the weekend
      }
      prices.set(s, BigInt(Math.round(price.get(s)! * 1e8)));
    }

    bars.push({ tSec, prices, staleSymbols: isWeekend ? staleSymbols : undefined });
  }

  return bars;
}
