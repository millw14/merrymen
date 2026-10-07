import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chartGeometry, chartPoint, chartX, chartY } from "./perps-chart-geometry";

describe("perps entry placement", () => {
  const bar = { timeMs: 1_000, open: 100, high: 110, low: 90, close: 101 };

  it("projects the fill at its exact venue time and price, even between candles", () => {
    const geometry = chartGeometry([bar], [], 0, 10_000)!;
    const fill = { timeMs: 1_234, price: 105 };
    const point = chartPoint(geometry, fill)!;
    assert.equal(point.x, chartX(geometry, 1_234));
    assert.equal(point.y, chartY(geometry, 105));
    assert.notEqual(point.x, chartX(geometry, bar.timeMs));
    assert.notEqual(point.y, chartY(geometry, bar.close));
  });

  it("keeps a fill inside a missing candle interval at its actual time", () => {
    const geometry = chartGeometry([bar, { ...bar, timeMs: 9_000 }], [], 0, 10_000)!;
    const middle = chartPoint(geometry, { timeMs: 5_000, price: 105 })!;
    assert.ok(middle.x > chartX(geometry, 1_000));
    assert.ok(middle.x < chartX(geometry, 9_000));
  });

  it("includes execution prices in the scale and rejects events outside the requested window", () => {
    const entry = { timeMs: 5_000, price: 130 };
    const geometry = chartGeometry([bar], [entry as never], 0, 10_000)!;
    assert.ok(geometry.priceMax > 130);
    assert.equal(chartPoint(geometry, { timeMs: 11_000, price: 130 }), null);
  });
});
