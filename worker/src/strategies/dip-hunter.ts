/**
 * Dip Hunter — a Merry Circle (holder-only) strategy.
 *
 * Instead of spreading the tick's budget evenly, it concentrates it on the one
 * basket token that has fallen furthest below its recent high — buying weakness.
 * Stateful by design: it keeps a rolling per-symbol high across ticks (the only
 * strategy that does), which is why it lives behind the Circle. Buys only; every
 * intent still clears the policy wall.
 */

import type { TradeIntent } from "../policy";
import type { Snapshot, Strategy } from "./types";

export interface DipHunterConfig {
  legs: { symbol: string; token: `0x${string}` }[];
  swapRouter: `0x${string}`;
  usdg: `0x${string}`;
  /** USDG committed to the single deepest dip each tick. */
  buyPerTickUsdg: bigint;
  /** Minimum drawdown from the rolling high (bps) before it's a "dip" worth buying. */
  minDipBps: number;
}

/** Factory — holds the rolling highs in a closure (state the snapshot can't carry). */
export function makeDipHunter(cfg: DipHunterConfig): Strategy {
  const highs = new Map<string, bigint>();

  return {
    name: "dip-hunter",
    tick(snap: Snapshot): TradeIntent[] {
      if (!snap.sequencerUp) return [];
      if (snap.cashUsdg < cfg.buyPerTickUsdg) return [];

      let best: { token: `0x${string}`; dipBps: number } | null = null;

      for (const leg of cfg.legs) {
        const p = snap.prices.get(leg.symbol);
        if (!p || p.stale) continue; // no fresh price → skip (updates resume when live)
        if (snap.pausedTokens.has(leg.token.toLowerCase())) continue;

        const prevHigh = highs.get(leg.symbol) ?? 0n;
        const high = p.price8 > prevHigh ? p.price8 : prevHigh;
        highs.set(leg.symbol, high);
        if (high === 0n) continue;

        const dipBps = Number(((high - p.price8) * 10_000n) / high);
        if (dipBps >= cfg.minDipBps && (!best || dipBps > best.dipBps)) {
          best = { token: leg.token, dipBps };
        }
      }

      if (!best) return [];
      return [
        {
          kind: "swap",
          target: cfg.swapRouter,
          sellToken: cfg.usdg,
          buyToken: best.token,
          sellAmountRaw: cfg.buyPerTickUsdg,
          notionalUsdg: cfg.buyPerTickUsdg,
        },
      ];
    },
  };
}
