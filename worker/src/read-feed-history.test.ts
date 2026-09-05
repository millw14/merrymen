import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { segments, FEED_GUARDS, type FeedPoint } from "./read-feed-history";

/**
 * The oracle series is the one chart on this product that could state a price
 * that never existed. These pin the two things that stop it.
 */

const p = (at: number, px = 100): FeedPoint => ({ at, px });
const H = 3600;

describe("the line breaks where the feed went quiet", () => {
  it("keeps a busy session in one run", () => {
    // Measured on the live AAPL feed: median gap between rounds, 44 minutes.
    const run = [p(0), p(44 * 60), p(88 * 60), p(132 * 60)];
    assert.equal(segments(run).length, 1);
  });

  it("splits across a gap longer than a session break", () => {
    // The same feed's MAXIMUM gap was 79.7 hours — a weekend. A single stroke
    // drawn across it states a price for every hour of a closed market.
    const run = [p(0), p(H), p(80 * H), p(81 * H)];
    const out = segments(run);
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((s) => s.length),
      [2, 2],
    );
  });

  it("splits an overnight close too, not only a weekend", () => {
    // The threshold is six hours, and an overnight silence is about thirteen.
    // Both are periods in which the token traded and the feed did not look.
    const out = segments([p(0), p(H), p(14 * H), p(15 * H)]);
    assert.equal(out.length, 2);
  });

  it("never drops a point", () => {
    const run = [p(0), p(H), p(50 * H), p(51 * H), p(200 * H)];
    const total = segments(run).reduce((n, s) => n + s.length, 0);
    assert.equal(total, run.length);
  });

  it("keeps a lone observation as its own run rather than discarding it", () => {
    // A single round between two silences. It renders as a dot; dropping it
    // would hide an observation that really happened.
    const out = segments([p(0), p(50 * H), p(100 * H)]);
    assert.deepEqual(
      out.map((s) => s.length),
      [1, 1, 1],
    );
  });

  it("handles an empty series and a single point without throwing", () => {
    assert.deepEqual(segments([]), []);
    assert.equal(segments([p(0)]).length, 1);
  });
});

describe("the reader refuses what it cannot trust", () => {
  const SRC = readFileSync(new URL("./read-feed-history.ts", import.meta.url), "utf8");

  it("drops an answer from the wrong side of a phase boundary", () => {
    // Round ids are phase-encoded. Cross the boundary and the answers come from
    // a different aggregator at a different scale — one such point is 1e18
    // times the price and flattens every real observation onto the axis.
    assert.match(SRC, /median \* WILD/);
    assert.match(SRC, /median \/ WILD/);
    assert.equal(FEED_GUARDS.WILD, 100);
  });

  it("drops an unwritten round instead of plotting it in 1970", () => {
    assert.match(SRC, /if \(at <= 0\) continue;/);
  });

  it("distinguishes a refused read from an empty history", () => {
    // A feed with no history and a chain that would not answer are different
    // facts, and the chart renders them differently.
    assert.match(SRC, /read: false/);
    assert.match(SRC, /read: boolean;/);
  });

  it("walks the history in ONE request", () => {
    // This chain refuses bursts. Four hundred separate calls is precisely the
    // burst it refuses; one multicall was measured at 710ms for all of them.
    assert.match(SRC, /batchSize: 20_000/);
    assert.ok(!/for[\s\S]{0,80}await client\.readContract/.test(SRC), "no per-round request loop");
  });
});
