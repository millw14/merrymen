/**
 * Strategy registry — one armed agent runs one named strategy. All knobs come
 * in as resolved settings (web UI > env > default); nothing in here reads the
 * environment, so the worker can rebuild a strategy mid-run when the user
 * changes settings.
 */

import { CASH, MORPHO, STOCK_TOKENS, type StockToken } from "../../../packages/core/src/index";
import { createAnthropicDriver, nullDriver } from "../strategist/driver";
import { makeLlmStrategist } from "../strategist/strategy";
import { makeCustomStrategy } from "./custom";
import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import { weekendGapTick, type WeekendGapConfig } from "./weekend-gap";
import type { Strategy } from "./types";

export const BUILTIN_STRATEGIES = ["steady-basket", "weekend-gap", "llm-strategist"] as const;
export type BuiltinStrategyName = (typeof BUILTIN_STRATEGIES)[number];

export interface StrategyBuildOpts {
  swapRouter: `0x${string}`;
  usdg6: (v: number) => bigint;
  basketSymbols: string[];
  buyPerTickUsdg: number;
  idleFloorUsdg: number;
  gapEnterBudgetUsdg: number;
  llm: { apiKey?: string; model: string; intervalMin: number; maxActionUsdg: number };
  onNote?: (level: "ok" | "warn", message: string) => void;
}

/** Registry tokens for the chosen symbols — unknown symbols are ignored. */
export function tokensForSymbols(symbols: readonly string[]): StockToken[] {
  return STOCK_TOKENS.filter((t) => symbols.includes(t.symbol));
}

function legsFor(symbols: readonly string[]) {
  return tokensForSymbols(symbols).map((t, _, arr) => ({
    symbol: t.symbol,
    token: t.address,
    weightBps: Math.floor(10_000 / arr.length),
  }));
}

export function buildStrategy(name: string, opts: StrategyBuildOpts): Strategy {
  // Not a builtin → a user-written strategy file in strategies/ (lazy-loaded,
  // hot-reloading, crash-isolated; every intent is shape-validated and then
  // policy-checked like any other).
  if (!(BUILTIN_STRATEGIES as readonly string[]).includes(name)) {
    return makeCustomStrategy(name, { onNote: opts.onNote });
  }
  if (name === "llm-strategist") {
    // LLM proposes; deterministic code disposes. Without a key, the null
    // driver proposes nothing — the worker still runs, honestly idle.
    const driver = opts.llm.apiKey
      ? createAnthropicDriver({ apiKey: opts.llm.apiKey, model: opts.llm.model })
      : nullDriver;
    if (driver === nullDriver) {
      console.log("[strategist] no Anthropic API key — llm-strategist runs with the null driver (no trades)");
    }
    return makeLlmStrategist({
      driver,
      universe: {
        legs: new Map(legsFor(opts.basketSymbols).map((l) => [l.symbol, l.token])),
        swapRouter: opts.swapRouter,
        usdg: CASH.USDG as `0x${string}`,
        maxPerActionUsdg: opts.usdg6(opts.llm.maxActionUsdg),
        maxActionsPerTick: 4,
      },
      decisionIntervalMs: opts.llm.intervalMin * 60_000,
      onNote: opts.onNote,
    });
  }
  if (name === "weekend-gap") {
    const cfg: WeekendGapConfig = {
      legs: legsFor(opts.basketSymbols),
      enterBudgetUsdg: opts.usdg6(opts.gapEnterBudgetUsdg),
      swapRouter: opts.swapRouter,
      usdg: CASH.USDG as `0x${string}`,
    };
    return { name, tick: (snap) => weekendGapTick(cfg, snap) };
  }
  const cfg: SteadyBasketConfig = {
    legs: legsFor(opts.basketSymbols),
    buyPerTickUsdg: opts.usdg6(opts.buyPerTickUsdg),
    idleFloorUsdg: opts.usdg6(opts.idleFloorUsdg),
    swapRouter: opts.swapRouter,
    vault: MORPHO.steakhouseUsdgVault as `0x${string}`,
    usdg: CASH.USDG as `0x${string}`,
  };
  return { name: "steady-basket", tick: (snap) => steadyBasketTick(cfg, snap) };
}
