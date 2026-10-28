import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REVIEW_CANDIDATES, ReviewCandidateWindow } from "./review-candidates";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const key = (n: number) => `eip155:4663:0x${n.toString(16).padStart(2, "0").repeat(20)}`;
const keys = (from: number, count: number) => Array.from({ length: count }, (_, i) => key(from + i));

describe("ReviewCandidateWindow", () => {
  it("admits at most perWindow distinct coins per window; a coin named again inside it is not a second coin", () => {
    const w = new ReviewCandidateWindow();
    assert.equal(REVIEW_CANDIDATES.perWindow, 10);
    assert.deepEqual(w.admit([key(1), key(1), key(2)], NOW), [key(1), key(2)]);
    assert.deepEqual(w.admit([key(2), key(1)], NOW + MIN), [], "duplicates inside the window are never re-sent");
    const more = w.admit(keys(3, 12), NOW + 2 * MIN);
    assert.equal(more.length, 8, "the window holds ten in all");
    assert.deepEqual(more, keys(3, 8));
    assert.deepEqual(w.admit([key(40)], NOW + 9 * MIN), [], "full until the oldest admissions age out");
    assert.deepEqual(w.admit([key(40)], NOW + 10 * MIN), [key(40)], "two aged out at the ten-minute mark; one is taken");
  });

  it("forget gives an undelivered admission back, and only that admission", () => {
    const w = new ReviewCandidateWindow();
    assert.deepEqual(w.admit(keys(1, 10), NOW), keys(1, 10));
    w.forget([key(1), key(2)], NOW);
    assert.deepEqual(w.carried(NOW).map((c) => c.tokenKey).sort(), keys(3, 8).sort(), "never carried for research");
    assert.deepEqual(w.admit([key(30), key(1), key(2)], NOW + MIN), [key(30), key(1)], "room again, and the given-back coins rank as never admitted");
    // An admission made later is not undone by forgetting an earlier one.
    w.forget([key(1)], NOW);
    assert.deepEqual(w.admit([key(1)], NOW + 2 * MIN), [], "key(1)'s newer admission stands");
    w.forget("nope" as unknown as string[], NOW);
  });

  it("ignores what is not a key", () => {
    const w = new ReviewCandidateWindow();
    assert.deepEqual(w.admit(["", 7 as unknown as string, null as unknown as string, key(1)], NOW), [key(1)]);
    assert.deepEqual(w.admit("nope" as unknown as string[], NOW), []);
    assert.deepEqual(w.admit([key(2)], Number.NaN), []);
  });

  it("rotates fairly: coins never admitted go before ones admitted last window", () => {
    const w = new ReviewCandidateWindow();
    const all = keys(1, 15);
    assert.deepEqual(w.admit(all, NOW), all.slice(0, 10));
    // Next window: the five that waited go first, then the five admitted longest ago.
    assert.deepEqual(w.admit(all, NOW + 10 * MIN), [...all.slice(10), ...all.slice(0, 5)]);
  });

  it("carries coins admitted within keepMs, newest first and bounded, and forgets them after", () => {
    const w = new ReviewCandidateWindow();
    w.admit([key(1)], NOW);
    w.admit([key(2)], NOW + MIN);
    assert.deepEqual(w.carried(NOW + 2 * MIN), [
      { tokenKey: key(2), admittedAt: NOW + MIN },
      { tokenKey: key(1), admittedAt: NOW },
    ]);
    assert.deepEqual(w.carried(NOW + REVIEW_CANDIDATES.keepMs).map((c) => c.tokenKey), [key(2)], "key(1) is past keepMs");
    assert.deepEqual(w.carried(NOW + MIN + REVIEW_CANDIDATES.keepMs), []);
    const busy = new ReviewCandidateWindow({ ...REVIEW_CANDIDATES, perWindow: 30 });
    busy.admit(keys(1, 25), NOW);
    assert.equal(busy.carried(NOW).length, REVIEW_CANDIDATES.carriedMax);
  });

  it("a clock that went backwards does not keep an admission from the future", () => {
    const w = new ReviewCandidateWindow();
    w.admit(keys(1, 10), NOW);
    assert.deepEqual(w.admit([key(20)], NOW - MIN), [key(20)], "admissions stamped after now no longer fill the window");
    assert.deepEqual(w.carried(NOW - MIN).map((c) => c.tokenKey), [key(20)]);
  });

  it("remembers a bounded number of coins", () => {
    const w = new ReviewCandidateWindow({ ...REVIEW_CANDIDATES, perWindow: 1_000, carriedMax: 1_000 });
    w.admit(keys(1, 250), NOW);
    assert.equal(w.carried(NOW).length, REVIEW_CANDIDATES.memoryMax);
  });
});
