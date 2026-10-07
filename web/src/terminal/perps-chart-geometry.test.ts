import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DeskPerpRow } from "./live";
import { chartGeometry, chartPoint, chartX, chartY, positionReferences, referenceRange } from "./perps-chart-geometry";

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

describe("position snapshot references", () => {
  const row: DeskPerpRow = {
    market: "ETH-USD", side: "long", paper: true, size: "1", entry: "100.123456",
    mark: "103", leverage: 2, marginUsd: 50, liqPrice: "50", liqDistancePct: 50,
    unrealisedUsd: 3, stopTrigger: "95", fundingUsd: 0,
  };

  it("requires both the market and book to match", () => {
    const rows = [row, { ...row, market: "BTC-USD" }, { ...row, paper: false }];
    const refs = positionReferences(rows, "ETH-USD", "paper");
    assert.equal(refs.length, 3);
    assert.ok(refs.every((ref) => ref.book === "paper"));
    assert.deepEqual(positionReferences(rows, "SOL-USD", "paper"), []);
    assert.equal(positionReferences(rows, "ETH-USD", "live").length, 3);
  });

  it("ignores absent and invalid prices without coercing them to zero", () => {
    for (const bad of [null, "", " ", "NaN", "Infinity", "0", "-1", "0x100", "1,000", "1e999"]) {
      assert.deepEqual(positionReferences([{ ...row, entry: bad as string, stopTrigger: bad, liqPrice: bad }], row.market, "paper"), []);
    }
  });

  it("preserves exact reference prices and projects them on the same axis as fills", () => {
    const refs = positionReferences([row], row.market, "paper");
    const g = chartGeometry([{ timeMs: 1000, open: 100, close: 103, high: 110, low: 90 }], [], 0, 10_000)!;
    assert.equal(refs[0].priceExact, "100.123456");
    assert.equal(chartY(g, refs[0].price), chartPoint(g, { timeMs: 2500, price: 100.123456 })!.y);
    assert.equal(referenceRange(g, refs[0].price), "visible");
    assert.equal(referenceRange(g, 50), "below");
    assert.equal(referenceRange(g, 200), "above");
    assert.equal(referenceRange(g, g.priceMin), "visible");
    assert.equal(referenceRange(g, g.priceMax), "visible");
    // Far-off liquidation values do not flatten candles or masquerade as boundary prices.
    assert.ok(chartY(g, 50) > g.bottom);
    assert.ok(g.priceMin > 50);
  });
});
