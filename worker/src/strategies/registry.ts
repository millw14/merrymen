/**
 * Strategy registry — one armed agent runs one named strategy, selected by
 * MERRYMEN_STRATEGY. Both ship with the same guardrails; neither sees a model.
 */

import { CASH, MORPHO, STOCK_TOKENS } from "@merrymen/core";
import { createAnthropicDriver, nullDriver } from "../strategist/driver";
import { makeLlmStrategist } from "../strategist/strategy";
import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import { weekendGapTick, type WeekendGapConfig } from "./weekend-gap";
import type { Strategy } from "./types";

export const STRATEGY_NAMES = ["steady-basket", "weekend-gap", "llm-strategist"] as const;
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
  opts: {
    swapRouter: `0x${string}`;
    usdg6: (v: number) => bigint;
    onNote?: (level: "ok" | "warn", message: string) => void;
  },
): Strategy {
  if (name === "llm-strategist") {
    // LLM proposes; deterministic code disposes. Without a key, the null
    // driver proposes nothing — the worker still runs, honestly idle.
    const driver = process.env.ANTHROPIC_API_KEY ? createAnthropicDriver() : nullDriver;
    if (driver === nullDriver) {
      console.log("[strategist] no ANTHROPIC_API_KEY — llm-strategist runs with the null driver (no trades)");
    }
    return makeLlmStrategist({
      driver,
      universe: {
        legs: new Map(legs().map((l) => [l.symbol, l.token])),
        swapRouter: opts.swapRouter,
        usdg: CASH.USDG as `0x${string}`,
        maxPerActionUsdg: opts.usdg6(Number(process.env.MERRYMEN_LLM_MAX_ACTION_USDG ?? 50)),
        maxActionsPerTick: 4,
      },
      decisionIntervalMs: Number(process.env.MERRYMEN_LLM_INTERVAL_MIN ?? 30) * 60_000,
      onNote: opts.onNote,
    });
  }
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
