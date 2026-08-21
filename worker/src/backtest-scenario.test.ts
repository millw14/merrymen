import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildScenario, DEFAULT_SCENARIO_START_SEC } from "./backtest-scenario";

const MONDAY_UTC = Date.UTC(2026, 7, 3) / 1000;

function serialiseScenario(seed: number) {
  return buildScenario({
    symbols: ["AAPL", "QQQ"],
    startPrice: { AAPL: 100, QQQ: 200 },
    days: 7,
    seed,
    startTimeSec: MONDAY_UTC,
  }).map((bar) => ({
    tSec: bar.tSec,
    prices: [...bar.prices],
    staleSymbols: [...(bar.staleSymbols ?? [])],
  }));
}

describe("buildScenario", () => {
  it("reproduces the same series from the same seed", () => {
    assert.deepEqual(serialiseScenario(123456), serialiseScenario(123456));
  });

  it("produces a different walk from a different seed", () => {
    assert.notDeepEqual(serialiseScenario(123456), serialiseScenario(654321));
  });

  it("uses a fixed default start date so a seed remains reproducible across days", () => {
    const bars = buildScenario({
      symbols: ["AAPL"],
      startPrice: { AAPL: 100 },
      days: 3,
      seed: 42,
    });
    assert.equal(bars[0]!.tSec, DEFAULT_SCENARIO_START_SEC);
  });

  it("holds prices and marks every symbol stale on weekends", () => {
    const bars = buildScenario({
      symbols: ["AAPL", "QQQ"],
      startPrice: { AAPL: 100, QQQ: 200 },
      days: 7,
      seed: 7,
      startTimeSec: MONDAY_UTC,
    });

    for (const index of [5, 6]) {
      const bar = bars[index]!;
      const previous = bars[index - 1]!;
      assert.deepEqual(bar.staleSymbols, new Set(["AAPL", "QQQ"]));
      assert.deepEqual(bar.prices, previous.prices);
    }
    for (const index of [0, 1, 2, 3, 4]) {
      assert.equal(bars[index]!.staleSymbols, undefined);
    }
  });

  it("produces approximately standard-normal shocks through Box-Muller", () => {
    const volatility = 0.2;
    const bars = buildScenario({
      symbols: ["AAPL"],
      startPrice: { AAPL: 100 },
      days: 14_000,
      volatility,
      drift: 0,
      seed: 0,
      startTimeSec: MONDAY_UTC,
    });

    const dailyVol = volatility / Math.sqrt(252);
    const shocks: number[] = [];
    for (let index = 1; index < bars.length; index++) {
      const bar = bars[index]!;
      if (bar.staleSymbols) continue;
      const previous = Number(bars[index - 1]!.prices.get("AAPL")!) / 1e8;
      const current = Number(bar.prices.get("AAPL")!) / 1e8;
      shocks.push((current / previous - 1) / dailyVol);
    }
    const mean = shocks.reduce((sum, value) => sum + value, 0) / shocks.length;
    const variance = shocks.reduce((sum, value) => sum + (value - mean) ** 2, 0) / shocks.length;
    const standardDeviation = Math.sqrt(variance);

    assert.ok(Math.abs(mean) < 0.03, `sample mean ${mean} is too far from zero`);
    assert.ok(
      standardDeviation > 0.97 && standardDeviation < 1.03,
      `sample standard deviation ${standardDeviation} is not approximately one`,
    );
  });
});
