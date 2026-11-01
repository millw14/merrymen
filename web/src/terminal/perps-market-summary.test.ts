import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChartResponse } from "../lib/perps-chart-data";
import { marketSummary, marketPrice } from "./perps-market-summary";

const sample = (): ChartResponse => ({ state: "ok", market: "BTC-PERP", book: "paper", window: "24h", owner: null, account: null, generatedAtMs: 100_000, entries: [], unknownFills: 0, truncated: false, candles: { state: "ok", bars: [{ timeMs: 10, open: 100, high: 110, low: 90, close: 102 }, { timeMs: 20, open: 102, high: 108, low: 95, close: 105 }], gaps: [], stale: false, asOfMs: 20 } });
test("market metrics describe available candles, not account entries or a synthetic quote", () => {
  assert.deepEqual(marketSummary(sample()), { last: 105, high: 110, low: 90, changePct: (105 / 100 - 1) * 100 });
  const stale = sample(); stale.candles.stale = true;
  assert.equal(marketSummary(stale)?.last, 105, "historical last price remains historical when stale");
});
test("empty, unreadable and malformed prices remain unknown", () => {
  assert.equal(marketSummary(null), null);
  for (const state of ["none", "unreadable"] as const) { const data = sample(); data.candles.state = state; assert.equal(marketSummary(data), null); }
  const unreadable = sample(); unreadable.state = "unreadable"; assert.equal(marketSummary(unreadable), null);
  const empty = sample(); empty.candles.bars = []; assert.equal(marketSummary(empty), null);
  for (const price of [0, -1, NaN, Infinity]) { const data = sample(); data.candles.bars[0]!.open = price; assert.equal(marketSummary(data), null); }
  assert.equal(marketPrice(null), "—");
  assert.equal(marketPrice(0.004213), "0.004213");
  assert.equal(marketPrice(.00000001), "1.000e-8", "positive quotes never round to zero");
  assert.equal(marketPrice(Infinity), "—");
});
