/**
 * Gap strategy — the strategy class that only exists here: tokenized equities
 * trade 24/7 while the underlying markets close every night and weekend.
 *
 * Deterministic state machine, keyed off feed staleness (robust to holidays —
 * no market calendar needed):
 *
 *   leg's feed goes stale (market just closed / is closed) and we hold none
 *     → ENTER: buy the leg's slice of the budget. Token keeps trading; the
 *       underlying is frozen at the close print.
 *   leg's feed is fresh (market open) and we hold the leg
 *     → EXIT: sell the full holding back to USDG, realizing the gap between
 *       the close and the open.
 *
 * The strategy is stateless: entered/exited is derived from holdings, so a
 * worker restart mid-weekend picks up exactly where it left off.
 */

import type { TradeIntent } from "../policy";
import type { Snapshot } from "./types";

export interface GapLeg {
  symbol: string;
  token: `0x${string}`;
  weightBps: number; // sums to 10_000 across legs
}

export interface WeekendGapConfig {
  legs: GapLeg[];
  /** Total USDG (6dp) deployed per gap window across all legs. */
  enterBudgetUsdg: bigint;
  swapRouter: `0x${string}`;
  usdg: `0x${string}`;
}

export function weekendGapTick(cfg: WeekendGapConfig, snap: Snapshot): TradeIntent[] {
  if (!snap.sequencerUp) return [];

  const intents: TradeIntent[] = [];

  for (const leg of cfg.legs) {
    if (snap.pausedTokens.has(leg.token.toLowerCase())) continue;
    const held = snap.holdings.get(leg.symbol);
    const marketClosed = snap.staleFeeds.has(leg.symbol);

    if (marketClosed && !held) {
      // ENTER at the close. Budget is split up front; insufficient cash for
      // the full slice means we skip the leg rather than size down silently.
      const slice = (cfg.enterBudgetUsdg * BigInt(leg.weightBps)) / 10_000n;
      if (slice === 0n || snap.cashUsdg < slice) continue;
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: cfg.usdg,
        buyToken: leg.token,
        sellAmountRaw: slice,
        notionalUsdg: slice,
      });
    } else if (!marketClosed && held && held.rawBalance > 0n) {
      // EXIT at the open — full position, back to cash.
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: leg.token,
        buyToken: cfg.usdg,
        sellAmountRaw: held.rawBalance,
        notionalUsdg: held.valueUsdg,
      });
    }
  }

  return intents;
}
