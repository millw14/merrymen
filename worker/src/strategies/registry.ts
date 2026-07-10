/**
 * Strategy registry — one armed agent runs one named strategy, selected by
 * MERRYMEN_STRATEGY. Both ship with the same guardrails; neither sees a model.
 */

import { CASH, MORPHO, STOCK_TOKENS } from "@merrymen/core";
import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import { weekendGapTick, type WeekendGapConfig } from "./weekend-gap";
import type { Strategy } from "./types";

export const STRATEGY_NAMES = ["steady-basket", "weekend-gap"] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

const BASKET_SYMBOLS = ["AAPL", "MSFT", "QQQ"] as const;

export function basketTokens() {
  return STOCK_TOKENS.filter((t) => (BASKET_SYMBOLS as readonly string[]).includes(t.symbol));
}

function legs() {
  return basketTokens().map((t, _, arr) => ({
    symbol: t.symbol,
    token: t.address,
    weightBps: Math.floor(10_000 / arr.length),
  }));
}

export function buildStrategy(
  name: StrategyName,
  opts: { swapRouter: `0x${string}`; usdg6: (v: number) => bigint },
): Strategy {
  if (name === "weekend-gap") {
    const cfg: WeekendGapConfig = {
      legs: legs(),
      enterBudgetUsdg: opts.usdg6(75),
      swapRouter: opts.swapRouter,
      usdg: CASH.USDG as `0x${string}`,
    };
    return { name, tick: (snap) => weekendGapTick(cfg, snap) };
  }
  const cfg: SteadyBasketConfig = {
    legs: legs(),
    buyPerTickUsdg: opts.usdg6(25),
    idleFloorUsdg: opts.usdg6(50),
    swapRouter: opts.swapRouter,
    vault: MORPHO.steakhouseUsdgVault as `0x${string}`,
    usdg: CASH.USDG as `0x${string}`,
  };
  return { name: "steady-basket", tick: (snap) => steadyBasketTick(cfg, snap) };
}

export function resolveStrategyName(raw: string | undefined): StrategyName {
  if (raw && (STRATEGY_NAMES as readonly string[]).includes(raw)) return raw as StrategyName;
  return "steady-basket";
}
