import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findLatestCardable, type LatestTradeRow } from "./pnl-latest";

const sell = (over: Partial<LatestTradeRow> = {}): LatestTradeRow => ({
  id: 7,
  target: "0xrouter",
  fill_side: "sell",
  fill_cash_usdg: 120,
  realized_pnl_usdg: 20,
  status: "landed",
  coin_symbol: "NEON",
  ...over,
});

describe("findLatestCardable — which trade the chat card shows", () => {
  it("returns the latest cardable close with paper status intact", () => {
    assert.deepEqual(findLatestCardable([sell({ status: "paper" })]), {
      tradeId: 7,
      symbol: "NEON",
      status: "paper",
      realizedPnlUsdg: 20,
    });
  });

  it("skips buys, refusals-shaped rows, unbacked and dust sells", () => {
    assert.equal(
      findLatestCardable([
        { ...sell(), id: 9, fill_side: "buy" },
        { ...sell(), id: 8, realized_pnl_usdg: null },
        { ...sell(), id: 7, fill_cash_usdg: 0.005, realized_pnl_usdg: -0.001 },
      ]),
      null,
    );
  });

  it("an unnameable coin does not hide the cardable close behind it", () => {
    const found = findLatestCardable([
      { ...sell(), id: 9, coin_symbol: "0xabc123" },
      { ...sell(), id: 8, coin_symbol: "TABCDEF12345" },
      { ...sell(), id: 7, coin_symbol: "NEON" },
    ]);
    assert.equal(found?.tradeId, 7);
    assert.equal(found?.symbol, "NEON");
  });

  it("empty ledger and malformed rows yield none, never throw", () => {
    assert.equal(findLatestCardable([]), null);
    assert.equal(findLatestCardable([{ id: -1 } as never]), null);
    assert.equal(findLatestCardable([{ id: 3, fill_side: "sell" } as never]), null);
  });
});
