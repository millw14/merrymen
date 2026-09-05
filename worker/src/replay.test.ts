/**
 * A NUMBER THAT LOOKS LIKE EVIDENCE AND IS NOT IS WORSE THAN NO NUMBER.
 *
 * Replay's whole job is to say whether the decisions had signal, so every way
 * it could flatter us is a way it could be useless. These tests are mostly
 * about what it REFUSES to score: a call made against a stale mark, a horizon
 * that has not elapsed, an excursion computed from two points, and a hit rate
 * computed from three decisions.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HORIZONS, replayLines, scoreDecision, type Observation, type PricedDecision } from "./replay";

const T = 1_788_600_000;
const HOUR = 3600;

const dec = (over: Partial<PricedDecision> = {}): PricedDecision => ({
  decisionId: "dec_1",
  agentId: "0xa",
  agentName: "tester",
  symbol: "TSLA",
  at: T,
  action: "buy",
  confidence: 0.7,
  priceUsd: 100,
  priceStale: false,
  economics: "viable",
  deltaUsdg: 2_000_000,
  ...over,
});

/** A path from T to T+1h: up to 104, down to 98, ending at 102. */
const path = (): Observation[] => [
  { at: T + 600, priceUsd: 101 },
  { at: T + 1200, priceUsd: 104 },
  { at: T + 1800, priceUsd: 98 },
  { at: T + 2400, priceUsd: 100 },
  { at: T + 3400, priceUsd: 102 },
];

const one = (d: PricedDecision, series: Observation[], now: number) =>
  scoreDecision(d, series, now, [HORIZONS[0]!]).outcomes[0]!;

describe("it refuses to score what it cannot honestly score", () => {
  it("refuses a decision made against a stale mark", () => {
    // A call against a two-hour-old equity price is a call about the FEED.
    // Scoring it credits or blames the reasoner for the market's opening hours.
    const o = one(dec({ priceStale: true }), path(), T + 2 * HOUR);
    assert.equal(o.verdict, "unscoreable");
    assert.match(o.why, /not a call about the market/);
  });

  it("refuses a horizon that has not elapsed", () => {
    // Scoring against whatever happens to exist would silently shorten every
    // horizon to "as far as the data goes" — survivorship by another name.
    const o = one(dec(), path(), T + 1800);
    assert.equal(o.verdict, "unscoreable");
    assert.match(o.why, /has not elapsed yet/);
  });

  it("refuses when there is no observation near the horizon", () => {
    const o = one(dec(), [{ at: T + 60, priceUsd: 101 }], T + 2 * HOUR);
    assert.equal(o.verdict, "unscoreable");
    assert.match(o.why, /no observation within/);
  });

  it("refuses a decision with no mark at all", () => {
    assert.equal(one(dec({ priceUsd: null }), path(), T + 2 * HOUR).verdict, "unscoreable");
    assert.equal(one(dec({ priceUsd: 0 }), path(), T + 2 * HOUR).verdict, "unscoreable");
  });

  it("withholds excursions computed from too few points, but keeps the return", () => {
    // MFE and MAE over two observations are the endpoints with a longer name.
    const o = one(dec(), [{ at: T + 3400, priceUsd: 102 }], T + 2 * HOUR);
    assert.equal(o.returnPct!.toFixed(2), "2.00", "the return is real");
    assert.equal(o.mfePct, null);
    assert.equal(o.maePct, null);
    assert.match(o.why, /excursions are not/);
  });
});

describe("the verdict", () => {
  it("calls a buy right when the price rose", () => {
    const o = one(dec(), path(), T + 2 * HOUR);
    assert.equal(o.verdict, "right");
    assert.equal(o.returnPct!.toFixed(2), "2.00");
  });

  it("calls a sell right when the price fell", () => {
    const down = path().map((p) => ({ ...p, priceUsd: 200 - p.priceUsd }));
    const o = one(dec({ action: "sell" }), down, T + 2 * HOUR);
    assert.equal(o.verdict, "right");
  });

  it("signs excursions to the decision's own direction", () => {
    // For a sell, a fall is FAVOURABLE. Reporting the raw maximum would say a
    // correct sell had its worst moment when the price dropped.
    const buy = one(dec(), path(), T + 2 * HOUR);
    assert.equal(buy.mfePct!.toFixed(0), "4", "best for a buy is the high");
    assert.equal(buy.maePct!.toFixed(0), "-2", "worst for a buy is the low");

    const sell = one(dec({ action: "sell" }), path(), T + 2 * HOUR);
    assert.equal(sell.mfePct!.toFixed(0), "2", "best for a sell is the low");
    assert.equal(sell.maePct!.toFixed(0), "-4", "worst for a sell is the high");
  });

  it("calls a hold right when nothing happened", () => {
    const flat = [
      { at: T + 600, priceUsd: 100.1 },
      { at: T + 1800, priceUsd: 99.9 },
      { at: T + 3400, priceUsd: 100.2 },
    ];
    const o = one(dec({ action: "hold" }), flat, T + 2 * HOUR);
    assert.equal(o.verdict, "right");
    assert.match(o.why, /nothing happened .* and it stayed out/);
  });

  it("calls a hold wrong when the price ran without it", () => {
    const o = one(dec({ action: "hold" }), path(), T + 2 * HOUR);
    assert.equal(o.verdict, "wrong");
    assert.match(o.why, /stayed out and the price moved/);
  });

  it("calls a trade through a flat window FLAT, not right", () => {
    // Neither right nor wrong: a trade that paid gas for noise. Whether that
    // was worth it is the economics verdict's question, not this one.
    const flat = [
      { at: T + 600, priceUsd: 100.1 },
      { at: T + 1800, priceUsd: 99.9 },
      { at: T + 3400, priceUsd: 100.2 },
    ];
    const o = one(dec(), flat, T + 2 * HOUR);
    assert.equal(o.verdict, "flat");
    assert.match(o.why, /paid gas for noise/);
  });

  it("has nothing to say about a refusal", () => {
    assert.equal(one(dec({ action: "refused" }), path(), T + 2 * HOUR).verdict, "unscoreable");
  });
});

describe("the report will not state a rate it cannot support", () => {
  it("refuses a hit rate over a handful", () => {
    // Three scoreable decisions is a coin flip that reads as a measurement.
    const scored = [1, 2, 3].map((i) =>
      scoreDecision(dec({ decisionId: `d${i}`, at: T + i }), path().map((p) => ({ ...p, at: p.at + i })), T + 2 * HOUR, [
        HORIZONS[0]!,
      ]),
    );
    const text = replayLines(scored, [HORIZONS[0]!]).join("\n");
    assert.match(text, /too few to state a rate \(needs 10\)/);
    assert.ok(!/% right/.test(text));
  });

  it("states one once there is enough", () => {
    const scored = Array.from({ length: 12 }, (_, i) =>
      scoreDecision(dec({ decisionId: `d${i}`, at: T + i }), path().map((p) => ({ ...p, at: p.at + i })), T + 2 * HOUR, [
        HORIZONS[0]!,
      ]),
    );
    assert.match(replayLines(scored, [HORIZONS[0]!]).join("\n"), /100% right/);
  });

  it("counts WHY the rest were unscoreable, which is the useful number early", () => {
    const scored = [
      scoreDecision(dec({ priceStale: true }), path(), T + 2 * HOUR, [HORIZONS[0]!]),
      scoreDecision(dec({ decisionId: "d2" }), path(), T + 60, [HORIZONS[0]!]),
    ];
    const text = replayLines(scored, [HORIZONS[0]!]).join("\n");
    assert.match(text, /1 unscoreable: the mark was stale/);
    assert.match(text, /1 unscoreable: the 1h horizon has not elapsed yet/);
  });

  it("says so when there is nothing", () => {
    assert.deepEqual(replayLines([]), ["no priced shadow decisions to replay yet"]);
  });
});
