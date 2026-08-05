import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildScenario } from "./backtest-scenario";

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

  it("keeps Box-Muller output finite and prices positive", () => {
    const bars = buildScenario({
      symbols: ["AAPL"],
      startPrice: { AAPL: 100 },
      days: 1_000,
      volatility: 2,
      seed: 0,
      startTimeSec: MONDAY_UTC,
    });
    for (const bar of bars) {
      const price = bar.prices.get("AAPL")!;
      assert.ok(price > 0n);
    }
  });
});
