/**
 * THE $950 LOSS THAT NEVER HAPPENED.
 *
 * An owner opened the app and read "−$950.17 today" over a book that was down
 * 2.7 cents. Nothing had been withdrawn and nothing had crashed: their agent had
 * practised at the paper book's opening 1,000 USDG, gone live at its real
 * balance, and both books had been writing marks to one series with nothing in
 * the row to say which was which. The step between two ledgers was read as a
 * day's performance — by the header, by the chart, by the growth index, and by a
 * drawdown figure published on a page that ranks people.
 *
 * The high-water marks were already kept apart, which is why the drawdown
 * BREAKER never fired on this. Only the reporting was wrong, everywhere at once,
 * because every surface derives from the same series.
 *
 * These tests pin the split AND the two things it must not do: it must not empty
 * the product's charts on the day the column ships, and it must not treat a
 * practice interlude as the end of the funded book's history.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sameBookAsLatest, spansTwoBooks } from "./equity-book";

const p = (v: number, mode?: string | null) => ({ equity_usdg: v, mode });

describe("two books never share a series", () => {
  it("THE PRACTICE PREFIX IS DROPPED once the agent goes live", () => {
    // The exact production shape: 1,000 USDG of simulation, then a funded book
    // holding 49.83. Last-minus-first across that is −950.17, and it is not a
    // number about anything.
    const rows = [p(1000, "paper"), p(1002, "paper"), p(49.86, "live"), p(49.83, "live")];
    const kept = sameBookAsLatest(rows);
    assert.deepEqual(kept.map((r) => r.equity_usdg), [49.86, 49.83]);
  });

  it("and going back to practice drops the funded rows instead", () => {
    // Symmetric on purpose. The newest row decides because it is the book the
    // agent is running now, which is the book every headline is about.
    const rows = [p(49.83, "live"), p(1000, "paper")];
    assert.deepEqual(sameBookAsLatest(rows).map((r) => r.equity_usdg), [1000]);
  });

  it("A PRACTICE INTERLUDE IS A GAP, NOT AN ENDING", () => {
    // The funded book kept existing while its owner practised; nobody was
    // marking it. That is a gap in OBSERVATION of one book, and a series may
    // span it — which is a different thing from two books interleaved. A
    // contiguity rule would throw away a month of real history for a ten-minute
    // experiment.
    const rows = [p(100, "live"), p(1000, "paper"), p(110, "live")];
    assert.deepEqual(sameBookAsLatest(rows).map((r) => r.equity_usdg), [100, 110]);
  });
});

describe("what it refuses to assume", () => {
  it("A NULL MODE PREDATES THE QUESTION and keeps the old behaviour exactly", () => {
    // Every row written before the column existed is one book or the other and
    // we cannot tell which. Labelling them `live` would be a claim about 900
    // rows an owner can see, and an assertion like that is what this file exists
    // because of. So: unchanged, until the worker starts saying.
    const rows = [p(10), p(11), p(12)];
    assert.deepEqual(sameBookAsLatest(rows).map((r) => r.equity_usdg), [10, 11, 12]);
  });

  it("and unattributable rows fall away as soon as the newest one is attributable", () => {
    // The transition, in one array: a redeployed worker starts stamping rows,
    // and the mixed prefix stops being part of the series. The chart shortens
    // once and rebuilds — which is honest, because the prefix was two books.
    const rows = [p(1000), p(1000), p(49.83, "live")];
    assert.deepEqual(sameBookAsLatest(rows).map((r) => r.equity_usdg), [49.83]);
  });

  it("an empty series stays empty rather than becoming a point", () => {
    assert.deepEqual(sameBookAsLatest([]), []);
  });
});

describe("saying so out loud", () => {
  it("a series that crosses books can be named as one", () => {
    assert.equal(spansTwoBooks([p(1000, "paper"), p(49.83, "live")]), true);
    assert.equal(spansTwoBooks([p(49.86, "live"), p(49.83, "live")]), false);
  });

  it("and rows that never said are not a second book", () => {
    // "We do not know" is not evidence of a switch. Two null rows beside two
    // live ones is one attributable book and a prefix, not a crossing.
    assert.equal(spansTwoBooks([p(10), p(11), p(49.83, "live")]), false);
  });
});
