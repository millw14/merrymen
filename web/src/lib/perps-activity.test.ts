import assert from "node:assert/strict";
import { it } from "node:test";
import { perpsActivityQuery, readPerpsActivity, type PerpsActivityResponse } from "./perps-activity";
import { readPerpsActivityData } from "./perps-activity-data";
import type { Db } from "../../../worker/src/db";
import type { PerpMarketSpec } from "@merrymen/core";
const q = { market: "BTC-PERP", book: "paper" as const }, now = 1_790_000_000_000;
const spec = { marketId: 1, priceDecimals: 1, sizeDecimals: 5 } as PerpMarketSpec;
const fill = { epoch: 2, venue_trade_id: "1", side_role: "ask", side: "long", base: "100", price: "832186", position_before: "100", realized_micro: null, fee_micro: "0", attribution: "venue-stop", trade_type: "trade", venue_ts_ms: now - 1000 };
function db(fills: Record<string, unknown>[], funding: Record<string, unknown>[] = []): Db {
  return { prepare(sql: string) { return { async all(...args: unknown[]) {
    assert.deepEqual(args.slice(0, 3), ["owner", "paper", 1]);
    assert.match(sql, /LIMIT 101/);
    return sql.includes("FROM perp_fills") ? fills : funding;
  } }; } } as unknown as Db;
}
it("classifies actual close/reduce/reverse and missing provenance without inventing realized PnL", async () => {
  for (const [before, base, effect] of [["0", "100", "open"], ["-50", "100", "add"], ["150", "100", "reduce"], ["100", "100", "close"], ["50", "100", "reverse"], [null, "100", "unknown"]]) {
    const result = await readPerpsActivityData(db([{ ...fill, position_before: before, base }]), "OWNER", q, spec, now);
    assert.equal(result.items[0].kind, "fill");
    if (result.items[0].kind === "fill") { assert.equal(result.items[0].effect, effect); assert.equal(result.items[0].realizedMicro, null); }
  }
});
it("counts malformed rows, preserves exact funding, and discloses bounded truncation", async () => {
  const hour = Math.floor(now / 3600_000);
  const result = await readPerpsActivityData(db([{ ...fill, base: "NaN" }, { ...fill, realized_micro: "garbled" }, ...Array.from({ length: 101 }, (_, i) => ({ ...fill, venue_trade_id: String(i) }))], [
    { epoch: 2, funding_id: "x", funding_hour: hour * 3600, payment_micro: "-9007199254740993000" },
  ]), "owner", q, spec, now);
  assert.equal(result.unknownRows, 2); assert.equal(result.truncated, true); assert.equal(result.items.length, 100);
  const funding = await readPerpsActivityData(db([], [{ epoch: 2, funding_id: "x", funding_hour: hour * 3600, payment_micro: "-9007199254740993000" }]), "owner", q, spec, now);
  assert.deepEqual(funding.items[0], { ...q, id: "funding:2:x", kind: "funding", timeMs: hour * 3600_000, paymentMicro: "-9007199254740993000" });
  await assert.rejects(readPerpsActivityData(db([]), "owner", q, { ...spec, marketId: 0 }, now), /another market/);
});
it("browser rejects another book, malformed amount, reordered or duplicate rows and invalid queries", async () => {
  const data: PerpsActivityResponse = { ...q, state: "ok", generatedAtMs: now, unknownRows: 0, truncated: false,
    items: [{ ...q, id: "one", kind: "funding", timeMs: now - 1000, paymentMicro: "-101" }] };
  assert.ok(readPerpsActivity(data, q));
  for (const patch of [{ book: "live" }, { timeMs: now + 1 }, { paymentMicro: "NaN" }]) assert.equal(readPerpsActivity({ ...data, items: [{ ...data.items[0], ...patch }] }, q), null);
  assert.equal(readPerpsActivity({ ...data, state: "unreadable" }, q), null);
  assert.equal(readPerpsActivity({ ...data, items: [data.items[0], data.items[0]] }, q), null);
  assert.equal(perpsActivityQuery("http://local?market=BTC-PERP&book=paper&agent=x"), null);
  assert.equal(perpsActivityQuery("http://local?market=BTC-PERP&book=paper&book=live"), null);
});
