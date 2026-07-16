/**
 * Even Keel — a Merry Circle (holder-only) strategy.
 *
 * Keeps the basket at equal weight: trims whatever has run ahead and tops up
 * whatever has lagged, so the book quietly harvests mean reversion instead of
 * only ever buying (steady-basket). Stateless — it reads the current snapshot
 * and nudges toward balance by a bounded amount each tick, so no single tick
 * makes a violent move. Every intent still passes the policy wall.
 */

import type { TradeIntent } from "../policy";
import type { Snapshot } from "./types";

export interface EvenKeelLeg {
  symbol: string;
  token: `0x${string}`;
}

export interface EvenKeelConfig {
  legs: EvenKeelLeg[];
  swapRouter: `0x${string}`;
  usdg: `0x${string}`;
  /** Max USDG moved per leg per tick — keeps rebalancing gentle. */
  maxTradeUsdg: bigint;
  /** Tolerance band (bps of target) before a leg is trimmed/topped. */
  bandBps: number;
  /** When the book is empty, deploy this much cash as an equal-weight entry. */
  seedBudgetUsdg: bigint;
}

const clamp = (v: bigint, hi: bigint) => (v > hi ? hi : v);

export function evenKeelTick(cfg: EvenKeelConfig, snap: Snapshot): TradeIntent[] {
  if (!snap.sequencerUp) return [];

  const tradable = cfg.legs.filter(
    (l) => !snap.pausedTokens.has(l.token.toLowerCase()) && !snap.staleFeeds.has(l.symbol),
  );
  if (tradable.length === 0) return [];

  const valueOf = (symbol: string) => snap.holdings.get(symbol)?.valueUsdg ?? 0n;
  const invested = tradable.reduce((sum, l) => sum + valueOf(l.symbol), 0n);

  // Cold start: nothing invested yet → lay down an equal-weight entry from cash.
  if (invested === 0n) {
    const budget = clamp(cfg.seedBudgetUsdg, snap.cashUsdg);
    if (budget <= 0n) return [];
    const per = budget / BigInt(tradable.length);
    if (per <= 0n) return [];
    return tradable.map((l) => ({
      kind: "swap",
      target: cfg.swapRouter,
      sellToken: cfg.usdg,
      buyToken: l.token,
      sellAmountRaw: clamp(per, cfg.maxTradeUsdg),
      notionalUsdg: clamp(per, cfg.maxTradeUsdg),
    }));
  }

  const target = invested / BigInt(tradable.length);
  const band = (target * BigInt(cfg.bandBps)) / 10_000n;
  const intents: TradeIntent[] = [];
  let cashLeft = snap.cashUsdg;

  for (const l of tradable) {
    const diff = valueOf(l.symbol) - target; // >0 overweight, <0 underweight
    if (diff > band) {
      // Trim the winner back toward target — sell stock for USDG.
      const sellUsdg = clamp(diff, cfg.maxTradeUsdg);
      const held = snap.holdings.get(l.symbol);
      if (!held || held.valueUsdg === 0n) continue;
      // Convert the USDG amount to a raw stock amount pro-rata to the holding.
      const sellRaw = (held.rawBalance * sellUsdg) / held.valueUsdg;
      if (sellRaw <= 0n) continue;
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: l.token,
        buyToken: cfg.usdg,
        sellAmountRaw: sellRaw,
        notionalUsdg: sellUsdg,
      });
    } else if (-diff > band && cashLeft > 0n) {
      // Top up the laggard from cash.
      const buyUsdg = clamp(clamp(-diff, cfg.maxTradeUsdg), cashLeft);
      if (buyUsdg <= 0n) continue;
      cashLeft -= buyUsdg;
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: cfg.usdg,
        buyToken: l.token,
        sellAmountRaw: buyUsdg,
        notionalUsdg: buyUsdg,
      });
    }
  }

  return intents;
}
