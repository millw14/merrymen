import { PERPS_STYLE_CATALOG } from "../../../packages/core/src/perps-styles";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runPerpsReplay, replaySettings, type PerpsReplayFrame } from "./backtest";
import { specToJson, type LighterFeedFile, parseLighterFeed } from "./feed-reader";
import { marketView, NOW_SEC, breakout, T_LAST } from "./testkit-perps";
const start = (NOW_SEC + 120) * 1000;
function frame(atMs = start, mark = 805000n): PerpsReplayFrame {
  const spec = marketView("BTC-PERP").spec;
  const endHour = Math.floor(atMs / 3600000) * 3600;
  const feed: LighterFeedFile = { v: 1, observedAt: atMs, markets: { "1": {
        observedAt: atMs, priceSource: "ws", mark: String(mark), index: String(mark), fundingRatePctPerHour: "0.0010",
        status: "active", spec: specToJson(spec), specObservedAt: atMs, takerFeePpm: 200, makerFeePpm: 0,
        bids: [[String(mark - 1n), "100000"]], asks: [[String(mark + 1n), "100000"]], bookSource: "ws", bookObservedAt: atMs,
        closed4h: breakout("BTC-PERP", 5000n).map(c => ({ t: c.t, o: String(c.o), h: String(c.h), l: String(c.l), c: String(c.c) })),
        candlesObservedAt: atMs,
        fundings1h: Array.from({ length: 12 }, (_, i) => ({ t: endHour - (11 - i) * 3600, rate: "0.0010", direction: "long" as const })),
        fundingsObservedAt: atMs,
      } } };
  assert.ok(parseLighterFeed(feed, atMs));
  return { atMs, feed };
}
const config = { initialCashUsdg: 100, settings: { perpsMarkets: ["BTC-PERP" as const] } };
test("replay uses the shipped defaults and keeps a marked tail with real fees", () => {
  const r = runPerpsReplay(config, [frame()]);
  assert.equal(r.complete, true);
  assert.equal(r.settings.perpsMaxLeverage, 2);
  assert.equal(r.settings.perpsPerTradeUsdg, 25);
  assert.equal(r.tailPositions.length, 1, JSON.stringify(r.events, (_, v) => typeof v === "bigint" ? String(v) : v));
  assert.ok(r.feesMicro > 0n);
  assert.equal(r.realizedMicro, 0n);
  assert.equal(r.finalEquityMicro, r.initialCashMicro - r.feesMicro + r.curve[0]!.unrealizedMicro);
  assert.deepEqual(r, runPerpsReplay(config, [frame()]));
});
test("same closed candle never opens twice, and funding is booked once per hour", () => {
  const r = runPerpsReplay(config, [frame(), frame(start + 3600000), frame(start + 3601000)]);
  assert.equal(r.complete, true);
  assert.equal(r.events.filter(e => e.kind === "open").length, 1);
  assert.equal(r.events.filter(e => e.kind === "funding").length, 1);
  assert.ok(r.fundingMicro < 0n);
  assert.equal(r.finalEquityMicro, r.initialCashMicro + r.fundingMicro - r.feesMicro + r.curve.at(-1)!.unrealizedMicro);
});
test("a missing funding hour stops the replay with unknown final equity, before any exit", () => {
  const f = frame(start + 7200000, 760000n);
  (f.feed as LighterFeedFile).markets["1"]!.fundings1h = (f.feed as LighterFeedFile).markets["1"]!.fundings1h!.filter(x => x.t !== Math.floor(start / 3600000) * 3600 + 3600);
  const r = runPerpsReplay(config, [frame(), f]);
  assert.equal(r.complete, false);
  assert.match(r.failure!.reason, /funding gap/);
  assert.equal(r.finalEquityMicro, null);
  assert.equal(r.snapshotsProcessed, 1);
  assert.equal(r.tailPositions.length, 1);
});
test("a funded stop settles fees and realized loss without forcing a tail sale", () => {
  const opened = runPerpsReplay(config, [frame()]);
  const stop = opened.tailPositions[0]!.stop!;
  const r = runPerpsReplay(config, [frame(), frame(start + 3600000, stop.trigger - 1n)]);
  assert.equal(r.complete, true);
  assert.equal(r.tailPositions.length, 0);
  assert.ok(r.events.some(e => e.kind === "sl"));
  assert.ok(r.realizedMicro < 0n);
  assert.equal(r.finalEquityMicro, r.initialCashMicro + r.realizedMicro + r.fundingMicro - r.feesMicro);
});
test("future data is refused and appended future snapshots cannot change the earlier decision", () => {
  const first = frame();
  const future = frame(start + 1000);
  const a = runPerpsReplay(config, [first]);
  const b = runPerpsReplay(config, [first, future]);
  assert.deepEqual(a.curve, b.curve.slice(0, 1));
  assert.deepEqual(a.events, b.events.filter(e => e.atMs === start));
  const forged = frame();
  (forged.feed as LighterFeedFile).markets["1"]!.closed4h!.push({ t: T_LAST + 14400000, o: "1", h: "9999999", l: "1", c: "9999999" });
  const r = runPerpsReplay(config, [forged]);
  assert.equal(r.complete, false);
  assert.equal(r.finalEquityMicro, null);
});
test("small caps and entry halt remain binding, never raised to make a backtest trade", () => {
  const small = runPerpsReplay({ ...config, settings: { ...config.settings, perpsPerTradeUsdg: 10 } }, [frame()]);
  assert.equal(small.tailPositions.length, 0);
  const halted = runPerpsReplay({ ...config, settings: { ...config.settings, perpsEntriesHalted: true } }, [frame()]);
  assert.equal(halted.tailPositions.length, 0);
  assert.throws(() => replaySettings({ perpsMaxLeverage: 100 }), /invalid/);
  assert.throws(() => runPerpsReplay(config, [frame(), frame()]), /strictly increase/);
});
test("stale held-market depth makes performance incomplete instead of optimistic", () => {
  const stale = frame(start + 20000);
  (stale.feed as LighterFeedFile).markets["1"]!.bookObservedAt = start;
  const r = runPerpsReplay(config, [frame(), stale]);
  assert.equal(r.complete, false);
  assert.equal(r.finalEquityMicro, null);
  assert.match(r.failure!.reason, /depth/);
});


test("replay rejects unknown profiles instead of silently evaluating swing defaults", () => {
  assert.throws(() => replaySettings({ perpsStyle: "unknown" as never }), /invalid perpsStyle/);
});
for (const profile of PERPS_STYLE_CATALOG) {
  test(`replay evaluates ${profile.id} native signals and immutable deadline`, () => {
    const entryAt = Math.floor(start / profile.candleMs) * profile.candleMs + 90_000;
    const last = Math.floor(entryAt / profile.candleMs) * profile.candleMs - profile.candleMs;
    const first = frame(entryAt);
    const market = (first.feed as LighterFeedFile).markets["1"]!;
    const rows = market.closed4h!.map((c, i, all) => ({ ...c, t: last - (all.length - 1 - i) * profile.candleMs }));
    if (profile.timeframe === "4h") market.closed4h = rows;
    else { delete market.closed4h; delete market.candlesObservedAt; market.closedByTimeframe = { [profile.timeframe]: { observedAt: entryAt, rows } }; }
    const cfg = { ...config, settings: { ...config.settings, perpsStyle: profile.id } };
    const opened = runPerpsReplay(cfg, [first]);
    assert.equal(opened.complete, true);
    assert.equal(opened.settings.perpsStyle, profile.id);
    assert.equal(opened.tailPositions.length, 1);
    assert.equal(opened.tailPositions[0]!.entryStyle, profile.id);
    // Hourly frames retain complete funding and real depth; no fresh signal
    // candles are fabricated after entry. The recorded position still expires.
    const endAt = entryAt + profile.maxHoldHours * 3600_000;
    const samples = [first];
    for (let at = entryAt + 3600_000; at < endAt; at += 3600_000) {
      const f = frame(at); const m = (f.feed as LighterFeedFile).markets["1"]!;
      delete m.closed4h; delete m.candlesObservedAt; delete m.closedByTimeframe; samples.push(f);
    }
    const closing = frame(endAt); const m = (closing.feed as LighterFeedFile).markets["1"]!;
    delete m.closed4h; delete m.candlesObservedAt; delete m.closedByTimeframe; samples.push(closing);
    const closed = runPerpsReplay(cfg, samples);
    assert.equal(closed.complete, true, closed.failure?.reason);
    assert.equal(closed.tailPositions.length, 0);
    assert.equal(closed.events.filter(e => e.kind === "open").length, 1);
    assert.ok(closed.events.some(e => e.kind === "risk-close" && e.atMs === endAt));
  });
}
