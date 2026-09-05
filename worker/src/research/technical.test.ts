/**
 * 106 OF 120 ANALYST READINGS CAME BACK no-data, AND THE ANALYSTS WERE RIGHT.
 *
 * The technical lens was handed one spot price, usually marked stale. Asked to
 * do technical analysis on that, it correctly answered that it had nothing —
 * so every hold the desk produced was a hold about the pipeline rather than
 * about the market.
 *
 * These tests are mostly about the other failure mode. Once a series exists it
 * is very easy to compute a "24h return" from forty minutes of data, and that
 * number is not a smaller version of the truth — it is a different number
 * wearing its name, and it would be far more damaging than the no-data it
 * replaced, because it looks like evidence.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTechnical, renderTechnical, type PricePoint } from "./technical";

const NOW = 1_788_600_000;
const MIN = 60;

/** `n` points ending at NOW, `gap` apart, walking from `from` to `to`. */
const ramp = (n: number, gap: number, from: number, to: number): PricePoint[] =>
  Array.from({ length: n }, (_, i) => ({
    at: NOW - (n - 1 - i) * gap,
    priceUsd: from + ((to - from) * i) / Math.max(1, n - 1),
  }));

const build = (points: PricePoint[], over: Partial<Parameters<typeof buildTechnical>[0]> = {}) =>
  buildTechnical({ symbol: "TSLA", asOf: NOW, price: points[points.length - 1]?.priceUsd ?? 100, priceSource: "chainlink", stale: false, points, ...over });

describe("it refuses to compute a window the series does not cover", () => {
  it("gives a 15m return from 40 minutes of data, and nothing longer", () => {
    // The exact trap: a 24h return derived from 40 minutes is a different
    // number wearing its name, and it looks like evidence.
    const t = build(ramp(9, 5 * MIN, 100, 104));
    const by = Object.fromEntries(t.returns.map((r) => [r.label, r]));
    assert.notEqual(by["15m"]!.value, null, "15m fits inside 40m");
    assert.equal(by["1h"]!.value, null);
    assert.equal(by["24h"]!.value, null);
    assert.match(by["24h"]!.why!, /covers 40m, less than the 1440m this needs/);
  });

  it("states the window every figure was actually measured over", () => {
    const t = build(ramp(9, 5 * MIN, 100, 104));
    const fifteen = t.returns.find((r) => r.label === "15m")!;
    assert.equal(fifteen.spanSec, 15 * MIN, "not 'about 15m' — the real gap to the point used");
  });

  it("refuses a mean over fewer than three rounds in the window", () => {
    const t = build([
      { at: NOW - 50 * MIN, priceUsd: 100 },
      { at: NOW - 40 * MIN, priceUsd: 101 },
      { at: NOW, priceUsd: 102 },
    ]);
    const ma = t.movingAverages.find((m) => m.label === "1h")!;
    assert.equal(ma.value, null);
    assert.match(ma.why!, /covers 50m, less than the 60m this needs/);
  });

  it("refuses a deviation over too few rounds", () => {
    const t = build(ramp(4, 5 * MIN, 100, 101));
    assert.equal(t.volatility!.value, null);
    assert.match(t.volatility!.why!, /only 4 round\(s\); a deviation needs at least 8/);
  });

  it("survives an empty series without inventing anything", () => {
    const t = build([], { price: 100 });
    assert.equal(t.series.points, 0);
    assert.equal(t.series.spanSec, 0);
    assert.equal(t.range, null);
    assert.equal(t.freshnessSec, null);
    for (const r of t.returns) assert.equal(r.value, null);
    assert.doesNotThrow(() => renderTechnical(t));
  });
});

describe("what it computes when the data supports it", () => {
  const long = () => ramp(49, 30 * MIN, 100, 124); // 24h of half-hourly rounds

  it("computes returns against the point at the window, not the oldest point", () => {
    const t = build(long());
    const day = t.returns.find((r) => r.label === "24h")!;
    assert.equal(day.value!.toFixed(2), "24.00", "100 -> 124 over the full day");
    const hour = t.returns.find((r) => r.label === "1h")!;
    assert.equal(hour.value!.toFixed(2), "0.81", "two rounds back (123.0), not the whole ramp");
  });

  it("computes a mean and says where the price sits against it", () => {
    const t = build(long());
    const ma = t.movingAverages.find((m) => m.label === "24h")!;
    assert.equal(ma.value!.toFixed(2), "112.00");
    assert.match(renderTechnical(t), /price is \+10\.71% against it/);
  });

  it("annualises volatility by the MEDIAN gap, not an assumed bar size", () => {
    // The rounds are irregular; pretending they are minutes would scale the
    // answer by whatever the feed's cadence happens to be.
    const t = build(long());
    assert.notEqual(t.volatility!.value, null);
    assert.equal(t.series.medianGapSec, 30 * MIN);
  });

  it("reports the range and where the mark sits in it", () => {
    const t = build([
      { at: NOW - 60 * MIN, priceUsd: 100 },
      { at: NOW - 30 * MIN, priceUsd: 110 },
      { at: NOW, priceUsd: 105 },
    ]);
    assert.equal(t.range!.low, 100);
    assert.equal(t.range!.high, 110);
    assert.equal(t.range!.positionPct.toFixed(0), "50");
  });
});

describe("what it will not pretend to have", () => {
  it("says volume is absent and why, rather than omitting it", () => {
    // An analyst told nothing about volume cannot tell "we have no source" from
    // "we forgot". A proxy would be the synthetic-neutral failure this work
    // exists to avoid.
    const t = build(ramp(9, 5 * MIN, 100, 104));
    assert.equal(t.volume.value, null);
    assert.match(t.volume.why, /publishes prices, not turnover/);
    assert.match(renderTechnical(t), /Volume: none available/);
  });

  it("says a stale feed has stopped updating, in words", () => {
    const t = build(ramp(9, 5 * MIN, 100, 104), { stale: true });
    assert.match(renderTechnical(t), /STALE, the feed has stopped updating/);
  });

  it("tells the analyst the window bounds every figure below it", () => {
    const text = renderTechnical(build(ramp(9, 5 * MIN, 100, 104)));
    assert.match(text, /9 published round\(s\) covering 40m/);
    assert.match(text, /measured over that window and no further/);
    assert.match(text, /24h unavailable/, "and names what it could not compute");
  });
});
