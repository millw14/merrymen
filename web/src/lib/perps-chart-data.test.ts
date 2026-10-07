import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "../../../worker/src/db";
import {
  candlesFromVenue, chartQuery, chartResponse, entriesFromFills, readChartFills,
  type ChartQuery, type PerpFillChartRow,
} from "./perps-chart-data";

const AGENT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90124";
const NOW = 1_790_000_000_000;
const Q: ChartQuery = { market: "BTC-PERP", book: "paper", window: "24h" };
const SPEC = { sizeDecimals: 5, priceDecimals: 1 };
const row = (over: Partial<PerpFillChartRow> = {}): PerpFillChartRow => ({
  epoch: 2, venue_trade_id: "trade-1", side_role: "bid", base: "100", price: "832186",
  position_before: "0", attribution: "intent", venue_ts_ms: NOW - 5_000, ...over,
});

describe("owner chart queries", () => {
  it("only accepts a frozen market, explicit book/window and no account selector", () => {
    assert.deepEqual(chartQuery("http://localhost/api/perps/chart?market=BTC-PERP&book=paper&window=24h"), Q);
    for (const query of [
      "market=btc-perp&book=paper&window=24h",
      "market=BTC&book=paper&window=24h",
      "market=BTC-PERP&book=off&window=24h",
      "market=BTC-PERP&book=live&window=365d",
      "market=BTC-PERP&book=live&window=24h&agent=0xdead",
      "market=BTC-PERP&market=ETH-PERP&book=live&window=24h",
    ]) assert.equal(chartQuery(`http://localhost/api/perps/chart?${query}`), null, query);
  });

  it("binds the server-resolved agent, mode, market id and time window across all epochs", async () => {
    const seen: { sql?: string; params?: unknown[] } = {};
    const db = { prepare(sql: string) {
      seen.sql = sql;
      return { all: async (...params: unknown[]) => { seen.params = params; return [row()]; } };
    } } as unknown as Db;
    const rows = await readChartFills(db, AGENT.toUpperCase(), Q, NOW);
    assert.equal(rows.length, 1);
    assert.match(seen.sql!, /WHERE agent_id = \? AND mode = \? AND market_id = \? AND venue_ts_ms >= \? AND venue_ts_ms <= \?/);
    assert.doesNotMatch(seen.sql!, /epoch =/);
    assert.match(seen.sql!, /ORDER BY venue_ts_ms DESC, venue_trade_id DESC, side_role DESC LIMIT 501/);
    assert.deepEqual(seen.params, [AGENT, "paper", 1, NOW - 86_400_000, NOW]);
  });
});

describe("exact fill markers", () => {
  it("labels open/add/reversal, keeps partial fills and epochs, and excludes closes", () => {
    const rows = [
      row({ venue_trade_id: "later", side_role: "ask", base: "50", position_before: "30", epoch: 3, venue_ts_ms: NOW - 1_000 }),
      row({ venue_trade_id: "same", side_role: "bid", base: "80", position_before: "-50", venue_ts_ms: NOW - 2_000 }),
      row({ venue_trade_id: "same", side_role: "ask", base: "100", position_before: "0", venue_ts_ms: NOW - 2_000 }),
      row({ venue_trade_id: "close", side_role: "bid", base: "40", position_before: "-100", venue_ts_ms: NOW - 3_000 }),
      row({ venue_trade_id: "add", side_role: "bid", base: "10", position_before: "20", venue_ts_ms: NOW - 4_000 }),
      row({ venue_trade_id: "unknown", position_before: null, venue_ts_ms: NOW - 5_000 }),
      row({ venue_trade_id: "open", venue_ts_ms: NOW - 6_000 }),
    ];
    const result = entriesFromFills(rows, Q, SPEC);
    assert.equal(result.unknownFills, 1);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.entries.map((e) => [e.id, e.kind, e.side, e.size]), [
      ["2:open:bid", "open", "long", "0.00100"],
      ["2:add:bid", "add", "long", "0.00010"],
      ["2:same:ask", "open", "short", "0.00100"],
      ["2:same:bid", "reverse", "long", "0.00030"],
      ["3:later:ask", "reverse", "short", "0.00020"],
    ]);
    assert.equal(result.entries[0]?.priceExact, "83218.6");
    assert.equal(result.entries[0]?.timeMs, NOW - 6_000);
    assert.equal(result.entries[0]?.price, 83218.6);
  });

  it("reports omitted history instead of drawing a falsely complete tape", () => {
    const rows = Array.from({ length: 501 }, (_, i) => row({ venue_trade_id: String(i), venue_ts_ms: NOW - i }));
    const result = entriesFromFills(rows, Q, SPEC);
    assert.equal(result.truncated, true);
    assert.equal(result.entries.length, 500);
    assert.equal(result.entries[0]?.id, "2:499:bid");
  });
});

describe("venue mark candles", () => {
  const STEP = 300_000;
  const t = Math.floor(NOW / STEP) * STEP;
  const candle = (timeMs: number) => ({ tMs: timeMs, open: 832186n, high: 832300n, low: 832100n, close: 832250n });

  it("returns real mark OHLC with explicit gaps and a stale flag", () => {
    const c = candlesFromVenue([candle(t - 5 * STEP), candle(t - 3 * STEP)], Q, 1, NOW);
    assert.equal(c.state, "ok");
    assert.deepEqual(c.gaps, [{ startMs: t - 4 * STEP, endMs: t - 3 * STEP }]);
    assert.equal(c.bars[0]?.open, 83218.6);
    assert.equal(c.stale, true);
    assert.equal(c.asOfMs, t - 2 * STEP);
  });

  it("drops incomplete current candle and distinguishes empty from unreadable", () => {
    assert.equal(candlesFromVenue([candle(t)], Q, 1, NOW).state, "none");
    assert.equal(candlesFromVenue([candle(t - STEP)], Q, 1, NOW).stale, false);
    assert.equal(candlesFromVenue([candle(t - 2 * STEP)], Q, 1, NOW).stale, true);
    assert.equal(candlesFromVenue(null, Q, 1, NOW).state, "unreadable");
    assert.equal(chartResponse(Q, "unreadable", NOW).generatedAtMs, NOW);
  });
});
