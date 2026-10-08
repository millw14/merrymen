import assert from "node:assert/strict";
import { it } from "node:test";
import { chartResponse, type ChartQuery } from "./perps-chart-data";
import { readChartResponse } from "./perps-chart-response";
const q: ChartQuery = { market: "BTC-PERP", book: "paper", window: "24h" };
const now = 1_790_000_000_000;
const valid = () => ({ ...chartResponse(q, "ok", now), entries: [{ id: "1:2:bid", timeMs: now - 1000, price: 100.5, priceExact: "100.50", size: "0.0100", side: "long", book: "paper", epoch: 1, attribution: "intent", kind: "open" }] });
it("accepts truthful exact-price responses and explicit unavailable reads", () => {
  assert.ok(readChartResponse(valid(), q));
  assert.ok(readChartResponse(chartResponse(q, "unreadable", now), q));
});
it("rejects mixed books, malformed entries, duplicate markers and renderer-crashing fields", () => {
  const value = valid();
  for (const patch of [{ book: "live" }, { timeMs: 9e20 }, { timeMs: now + 1 }, { priceExact: "101.0" }, { price: NaN }, { size: "-1" }, { side: "buy" }, { epoch: 0 }]) {
    assert.equal(readChartResponse({ ...value, entries: [{ ...value.entries[0], ...patch }] }, q), null);
  }
  assert.equal(readChartResponse({ ...value, entries: [value.entries[0], value.entries[0]] }, q), null);
  for (const candles of [{ ...value.candles, gaps: null }, { ...value.candles, bars: [{ timeMs: now }] }, { ...value.candles, state: "ok" }])
    assert.equal(readChartResponse({ ...value, candles }, q), null);
});
