/**
 * Playground backtest endpoint. Runs one strategy — or two, side by side,
 * when `compareStrategy` is set — through the real policy layer over an
 * identical synthetic price series, so a comparison is apples-to-apples.
 */

import { randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import { readStoredGrant } from "@/lib/grant";
import { CASH, STOCK_TOKENS, UNISWAP, MORPHO, usdgUnits } from "@merrymen/core";
import { runBacktest } from "@merrymen/backtest";
import { buildScenario } from "@merrymen/backtest-scenario";
import { limitsFromGrant } from "@merrymen/limits";
import {
  parsePlaygroundRequest,
  type PlaygroundResponse,
  type PlaygroundRunOutput,
  type StrategyName,
} from "@merrymen/playground-api";
import { steadyBasketTick, type SteadyBasketConfig } from "@merrymen/strategies/steady-basket";
import { weekendGapTick, type WeekendGapConfig } from "@merrymen/strategies/weekend-gap";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = parsePlaygroundRequest(input);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const body = parsed.value;

  const grant = await readStoredGrant();
  if (!grant) {
    return NextResponse.json({ error: "no grant — deploy an agent first" }, { status: 404 });
  }

  const seed = body.seed ?? randomInt(0, 0x1_0000_0000);
  const selectedTokens = body.symbols
    .map((symbol) => STOCK_TOKENS.find((token) => token.symbol === symbol))
    .filter((token): token is (typeof STOCK_TOKENS)[number] => token !== undefined);
  const legs = new Map<string, `0x${string}`>(
    selectedTokens.map((token) => [token.symbol, token.address]),
  );
  if (legs.size === 0) {
    return NextResponse.json({ error: "no valid symbols in that basket" }, { status: 400 });
  }

  const swapRouter = UNISWAP.swapRouter02;
  const vault = MORPHO.steakhouseUsdgVault;

  const weightBps = Math.floor(10_000 / legs.size);
  const basketLegs = [...legs.entries()].map(([symbol, token]) => ({ symbol, token, weightBps }));

  const limits = limitsFromGrant(grant, selectedTokens);

  // Same price series for every strategy run in this request — a fair
  // comparison means identical prices, not identical randomness.
  const startPrice = Object.fromEntries([...legs.keys()].map((symbol) => [symbol, 100]));
  const bars = buildScenario({ symbols: [...legs.keys()], startPrice, days: body.days, seed });

  function buildStrategy(name: StrategyName) {
    return name === "weekend-gap"
      ? {
          name: "weekend-gap" as const,
          tick: (s: Parameters<typeof weekendGapTick>[1]) =>
            weekendGapTick(
              {
                legs: basketLegs,
                enterBudgetUsdg: usdgUnits(
                  Math.min(body.startingCashUsdg * 0.5, (Number(limits.perTradeUsdg) / 1e6) * 0.9),
                ),
                swapRouter,
                usdg: CASH.USDG,
              } satisfies WeekendGapConfig,
              s,
            ),
        }
      : {
          name: "steady-basket" as const,
          tick: (s: Parameters<typeof steadyBasketTick>[1]) =>
            steadyBasketTick(
              {
                legs: basketLegs,
                buyPerTickUsdg: usdgUnits(body.startingCashUsdg * 0.05),
                idleFloorUsdg: usdgUnits(body.startingCashUsdg * 0.1),
                swapRouter,
                vault,
                usdg: CASH.USDG,
              } satisfies SteadyBasketConfig,
              s,
            ),
        };
  }

  async function runOne(name: StrategyName): Promise<PlaygroundRunOutput> {
    const result = await runBacktest(
      {
        strategy: buildStrategy(name),
        limits,
        legs,
        initialCashUsdg: usdgUnits(body.startingCashUsdg),
        collectRejectedEvents: true,
      },
      bars,
    );
    return {
      strategy: name,
      finalEquityUsdg: Number(result.finalEquityUsdg) / 1e6,
      pnlUsdg: Number(result.pnlUsdg) / 1e6,
      maxDrawdownBps: result.maxDrawdownBps,
      executed: result.executed,
      rejected: result.rejected,
      rejectedEvents: result.rejectedEvents,
      equitySeries: result.equitySeries.map((p) => ({
        tSec: p.tSec,
        equityUsdg: Number(p.equityUsdg) / 1e6,
      })),
    };
  }

  const primary = await runOne(body.strategy);
  const compare =
    body.compareStrategy && body.compareStrategy !== body.strategy
      ? await runOne(body.compareStrategy)
      : null;

  const response: PlaygroundResponse = {
    seed,
    limits: {
      perTradeUsdg: Number(limits.perTradeUsdg) / 1e6,
      dailyUsdg: Number(limits.dailyUsdg) / 1e6,
      maxDrawdownPct: limits.maxDrawdownBps / 100,
      maxOpsPerDay: limits.maxOpsPerDay,
    },
    primary,
    compare,
  };
  return NextResponse.json(response);
}
