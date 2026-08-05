/**
 * Playground backtest endpoint. Runs one strategy — or two, side by side,
 * when `compareStrategy` is set — through the real policy layer over an
 * identical synthetic price series, so a comparison is apples-to-apples.
 */

import { randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import { readStoredGrant } from "@/lib/grant";
import { CASH, STOCK_TOKENS, UNISWAP, MORPHO } from "@merrymen/core";
import { runBacktest } from "@merrymen/backtest";
import { buildScenario } from "@merrymen/backtest-scenario";
import { limitsFromGrant } from "@merrymen/limits";
import { steadyBasketTick, type SteadyBasketConfig } from "@merrymen/strategies/steady-basket";
import { weekendGapTick, type WeekendGapConfig } from "@merrymen/strategies/weekend-gap";

export const dynamic = "force-dynamic";

type StrategyName = "steady-basket" | "weekend-gap";

interface PlaygroundRequest {
  strategy: StrategyName;
  compareStrategy?: StrategyName | null;
  symbols: string[];
  days: number;
  startingCashUsdg: number;
  seed?: number;
}

const U = (v: number): bigint => BigInt(Math.round(v * 1e6));

interface RunOutput {
  strategy: StrategyName;
  finalEquityUsdg: number;
  pnlUsdg: number;
  maxDrawdownBps: number;
  executed: number;
  rejected: { rule: string; count: number }[];
  rejectedEvents: { tSec: number; rule: string }[];
  equitySeries: { tSec: number; equityUsdg: number }[];
}

export async function POST(req: Request) {
  const body = (await req.json()) as PlaygroundRequest;
  if (body.strategy !== "steady-basket" && body.strategy !== "weekend-gap") {
    return NextResponse.json({ error: "unknown strategy" }, { status: 400 });
  }
  if (
    body.compareStrategy != null &&
    body.compareStrategy !== "steady-basket" &&
    body.compareStrategy !== "weekend-gap"
  ) {
    return NextResponse.json({ error: "unknown comparison strategy" }, { status: 400 });
  }
  if (!Array.isArray(body.symbols)) {
    return NextResponse.json({ error: "symbols must be an array" }, { status: 400 });
  }
  if (!Number.isInteger(body.days) || body.days < 1 || body.days > 3_650) {
    return NextResponse.json({ error: "days must be between 1 and 3650" }, { status: 400 });
  }
  if (!Number.isFinite(body.startingCashUsdg) || body.startingCashUsdg <= 0) {
    return NextResponse.json({ error: "starting cash must be positive" }, { status: 400 });
  }

  const grant = await readStoredGrant();
  if (!grant) {
    return NextResponse.json({ error: "no grant — deploy an agent first" }, { status: 404 });
  }

  const seed = body.seed ?? randomInt(0, 0x1_0000_0000);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    return NextResponse.json({ error: "seed must be a 32-bit unsigned integer" }, { status: 400 });
  }

  const legs = new Map<string, `0x${string}`>(
    body.symbols
      .map((s) => STOCK_TOKENS.find((t) => t.symbol === s))
      .filter((t): t is (typeof STOCK_TOKENS)[number] => !!t)
      .map((t) => [t.symbol, t.address]),
  );
  if (legs.size === 0) {
    return NextResponse.json({ error: "no valid symbols in that basket" }, { status: 400 });
  }

  const swapRouter = UNISWAP.swapRouter02;
  const vault = MORPHO.steakhouseUsdgVault;

  const weightBps = Math.floor(10_000 / legs.size);
  const basketLegs = [...legs.entries()].map(([symbol, token]) => ({ symbol, token, weightBps }));

  const limits = limitsFromGrant(grant);

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
                enterBudgetUsdg: U(
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
                buyPerTickUsdg: U(body.startingCashUsdg * 0.05),
                idleFloorUsdg: U(body.startingCashUsdg * 0.1),
                swapRouter,
                vault,
                usdg: CASH.USDG,
              } satisfies SteadyBasketConfig,
              s,
            ),
        };
  }

  async function runOne(name: StrategyName): Promise<RunOutput> {
    const result = await runBacktest(
      {
        strategy: buildStrategy(name),
        limits,
        legs,
        initialCashUsdg: U(body.startingCashUsdg),
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

  return NextResponse.json({
    seed,
    limits: {
      perTradeUsdg: Number(limits.perTradeUsdg) / 1e6,
      dailyUsdg: Number(limits.dailyUsdg) / 1e6,
      maxDrawdownPct: limits.maxDrawdownBps / 100,
      maxOpsPerDay: limits.maxOpsPerDay,
    },
    primary,
    compare,
  });
}
