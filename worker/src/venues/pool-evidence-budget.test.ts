/**
 * ONE SLOW LEG MUST NOT DESTROY THE OTHER LEG'S ANSWER.
 *
 * ── THE BEHAVIOUR THIS REPRODUCES ────────────────────────────────────────
 *
 * `readPoolEvidence` joined its candle and trade reads with `Promise.all`, and
 * the caller raced that one combined promise against one 5s timer. `Promise.all`
 * settles only when BOTH legs settle, so candles that arrived in a second were
 * discarded whenever trades were slow, and the caller — holding only a nullable
 * object — could not tell that one leg had succeeded.
 *
 * It was not a rare interleaving. The legs use different cache keys, so they
 * cannot share a fleet pacing slot (3s spacing, one row shared by every
 * tenant): the second leg cannot begin before ~3s, leaving under 2s of the
 * budget for its round trip. Measured on the fleet on 2026-09-20, 29% of
 * Trencher Brain reviews (39 of 135) were handed no evidence at all.
 *
 * ── WHAT THESE PIN ───────────────────────────────────────────────────────
 *
 * That a late leg degrades to a FAILURE while the other leg's data survives,
 * and that a leg which did not land is never reported as a measurement of
 * zero. They say nothing about money; this is evidence quality.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readPoolEvidence, summarizeEvidence, type EvidenceRead, type PriceBar, type MarketTrade } from "./pool-evidence";

const POOL = `0x${"a".repeat(40)}`;
const TOKEN = `0x${"b".repeat(40)}`;

/** A candle set shaped like a real one, aligned to the 300s grid. */
const barsAt = (now: number, n: number): PriceBar[] => {
  const end = Math.floor(now / 1000 / 300) * 300 - 300;
  return Array.from({ length: n }, (_, i) => {
    const time = end - (n - 1 - i) * 300;
    return { time, open: 1, high: 1.2, low: 0.9, close: 1.1 };
  });
};

describe("a leg that misses its budget is a failure, not an empty reading", () => {
  it("keeps candles that arrived when the trade leg never answers", async () => {
    // THE EXACT PRODUCTION SHAPE: fast candles, a trade leg that outlives the
    // budget. Before the per-leg budget this returned nothing at all.
    const now = Date.now();
    const e = await readPoolEvidence(POOL, TOKEN, 120, {
      candles: async () => ({ failed: false, observedAt: now, data: barsAt(now, 6) }) as EvidenceRead<PriceBar>,
      trades: () => new Promise<EvidenceRead<MarketTrade>>(() => {}),
    });
    assert.equal(e.candles.failed, false, "the candle leg landed and must survive");
    assert.equal(e.candles.data.length, 6);
    assert.equal(e.trades.failed, true);
    assert.equal(e.trades.failure, "budget");
  });

  it("keeps trades that arrived when the candle leg never answers", async () => {
    const now = Date.now();
    const e = await readPoolEvidence(POOL, TOKEN, 120, {
      candles: () => new Promise<EvidenceRead<PriceBar>>(() => {}),
      trades: async () => ({ failed: false, observedAt: now, data: [] }) as EvidenceRead<MarketTrade>,
    });
    assert.equal(e.candles.failure, "budget");
    assert.equal(e.trades.failed, false, "the trade leg landed and must survive");
  });

  it("does not invent an observation time for a leg that never answered", async () => {
    // `observedAt` is what freshness is judged on. A budget miss with a
    // timestamp would be indistinguishable from a real reading.
    const e = await readPoolEvidence(POOL, TOKEN, 60, {
      candles: () => new Promise<EvidenceRead<PriceBar>>(() => {}),
      trades: () => new Promise<EvidenceRead<MarketTrade>>(() => {}),
    });
    assert.equal(e.candles.observedAt, undefined);
    assert.equal(e.trades.observedAt, undefined);
  });

  it("returns within its budget rather than waiting for the slow leg", async () => {
    const started = Date.now();
    await readPoolEvidence(POOL, TOKEN, 100, {
      candles: () => new Promise<EvidenceRead<PriceBar>>(() => {}),
      trades: () => new Promise<EvidenceRead<MarketTrade>>(() => {}),
    });
    assert.ok(Date.now() - started < 2000, "a hung pair must not hold the caller open");
  });
});

describe("a leg that did not land is unknown, never zero", () => {
  const summarised = (candles: EvidenceRead<PriceBar>, trades: EvidenceRead<MarketTrade>, now: number) =>
    summarizeEvidence({ poolId: POOL, token: TOKEN, candles, trades }, now);

  it("reports completed bars as NULL when the candle read failed", () => {
    // The bug: `bars.length` is 0 both for a quiet market and for a feed that
    // never answered, and a model reading `completedFiveMinuteBars: 0` is
    // being told this pool printed nothing.
    const now = Date.now();
    const s = summarised({ failed: true, failure: "budget", data: [] }, { failed: true, failure: "budget", data: [] }, now);
    assert.equal(s.completedFiveMinuteBars, null, "a failed read must not read as a measured zero");
    assert.equal(s.contiguous, null, "`false` would assert a gap we never observed");
    assert.equal(s.candleFailure, "budget", "and it must say WHY it is unknown");
  });

  it("still reports a real zero as zero when the read DID land", () => {
    // The other direction, which matters just as much: a feed that answered
    // with no completed bars is a measurement and must not become "unknown".
    const now = Date.now();
    const s = summarised({ failed: false, observedAt: now, data: [] }, { failed: true, failure: "budget", data: [] }, now);
    assert.equal(s.completedFiveMinuteBars, 0, "a landed read of nothing IS zero");
    assert.equal(s.candleFailure, null);
  });

  it("keeps the two legs' freshness independent in the summary", () => {
    const now = Date.now();
    const s = summarised(
      { failed: false, observedAt: now, data: barsAt(now, 4) },
      { failed: true, failure: "budget", data: [] },
      now,
    );
    assert.equal(s.completedFiveMinuteBars, 4, "candles survived");
    assert.equal(s.sampledTrades5m, null, "trades are unknown");
    assert.equal(s.tradeFailure, "budget");
    assert.equal(s.candleFailure, null);
  });

  it("never carries a stale observation forward as fresh", () => {
    // Freshness is judged against the ORIGINAL observation time, so an old
    // reading must go unknown rather than be served as current.
    const now = Date.now();
    const old = now - 10 * 60 * 1000;
    const s = summarised({ failed: false, observedAt: old, data: barsAt(old, 6) }, { failed: true, failure: "budget", data: [] }, now);
    assert.equal(s.completedFiveMinuteBars, null, "a stale read is not a current measurement");
    assert.equal(s.candleObservedAt, old, "but the real observation time is still reported");
  });
});
