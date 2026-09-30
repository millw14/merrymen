/**
 * WHAT COUNTS AS NEWS: a real-money trade that landed, seen for the first time.
 *
 * The chime and the tab title both count these, and both would be worse than
 * silence if they counted wrong — a chime on every page load, a title that
 * climbs on the feed's scheduled holds, a paper fill announced like money.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { outcomeOf } from "../../../worker/src/thesis-policy";
import type { Thesis } from "./live";
import { createArrivals, isLandedTrade } from "./arrivals";

const NOW = 1_800_000_000;
let n = 0;
/**
 * A landed row. Its coin follows its post id unless named, so rows of one post
 * share an agent, side and coin (what arrivals keys on) and unrelated rows do not.
 */
const row = (over: Partial<Thesis> = {}): Thesis => {
  const postId = over.postId ?? (++n).toString(16).padStart(32, "0");
  return {
    name: "Shogun",
    slug: "shogun",
    handle: null,
    action: "buy",
    symbol: `C${postId}`,
    sizeUsdg: 5,
    reason: "r",
    paper: false,
    head: "bought CASHCAT",
    outcome: "landed",
    at: NOW - 30,
    postId,
    ...over,
  } as Thesis;
};

describe("a landed trade", () => {
  it("is a real-money buy or sell that landed, with an id to remember it by", () => {
    assert.equal(isLandedTrade(row()), true);
    assert.equal(isLandedTrade(row({ action: "sell" })), true);
  });

  it("is not a hold, a refusal, a pending order, a paper fill, a shadow, or a post with no id", () => {
    assert.equal(isLandedTrade(row({ action: "hold" })), false);
    assert.equal(isLandedTrade(row({ outcome: "refused" })), false);
    assert.equal(isLandedTrade(row({ outcome: "pending" })), false);
    assert.equal(isLandedTrade(row({ paper: true })), false, "a paper fill is simulated money");
    assert.equal(isLandedTrade(row({ shadow: true })), false);
    assert.equal(isLandedTrade(row({ outcome: "shadow" })), false);
    assert.equal(isLandedTrade(row({ postId: null })), false, "nothing stable to diff it by");
  });

  it("a paper fill is not money even after its agent has gone live", () => {
    // `paper` on a post is the AUTHOR'S mode at its last heartbeat
    // (thesis-policy.ts), not the fill's. A fill booked on paper minutes before
    // the owner switched the agent to live arrives with paper:false — and was
    // never announced while it was paper, so the first read after the switch
    // would chime it as a real trade. The fill's own status still says it.
    // Pinned to the producer's own words, so a rephrasing there fails here.
    assert.equal(isLandedTrade(row({ paper: false, outcomeText: outcomeOf("paper", null).text })), false);
    assert.equal(isLandedTrade(row({ paper: false, outcomeText: outcomeOf("landed", null).text })), true);
  });
});

describe("arrivals, read by read", () => {
  it("NEVER ON FIRST LOAD: everything already on the feed is what the reader walked in on", () => {
    const a = createArrivals();
    assert.deepEqual(a.take([row(), row()], NOW), { rows: [], fills: 0 });
  });

  it("a landed trade that was not there before is news, once", () => {
    const a = createArrivals();
    const old = row();
    a.take([old], NOW);
    const fresh = row({ action: "sell" });
    assert.deepEqual(a.take([fresh, old], NOW).rows.map((t) => t.postId), [fresh.postId]);
    assert.deepEqual(a.take([fresh, old], NOW + 10).rows, [], "the next read has nothing new");
  });

  it("a pending trade that lands is news when it lands — the id is the same, the outcome is not", () => {
    const a = createArrivals();
    const pending = row({ outcome: "pending" });
    a.take([pending], NOW);
    assert.equal(a.take([{ ...pending, outcome: "landed" }], NOW).rows.length, 1);
  });

  it("THE SAME SHAPE FILLING AGAIN IS NEWS — a post id names a thesis, not a trade", () => {
    // A steady-basket leg says the same sentence every tick, so its next fill
    // is the same id with a newer `at`. Keyed on the id alone it was silent.
    const a = createArrivals();
    const earlier = NOW - 4 * 3600;
    a.take([], earlier);
    const leg = row({ at: earlier - 10, said: 1 });
    assert.equal(a.take([leg], earlier).rows.length, 1, "the first fill is news");
    const again = { ...leg, at: NOW - 10, said: 2 };
    assert.deepEqual(a.take([again], NOW), { rows: [again], fills: 1 }, "and so is the next fill of the same shape");
    assert.deepEqual(a.take([again], NOW + 10).rows, [], "the same copy read again is not");
  });

  it("a leg that filled before the page opened still announces its next fill", () => {
    const a = createArrivals();
    const leg = row({ at: NOW - 2 * 3600, said: 3 });
    a.take([leg], NOW - 60);
    assert.equal(a.take([{ ...leg, at: NOW - 5, said: 4 }], NOW).rows.length, 1);
  });

  it("two new rows of one post, each past everything seen, are two fills", () => {
    const a = createArrivals();
    const id = row().postId;
    a.take([row({ postId: id, at: NOW - 3000 })], NOW);
    const r1 = row({ postId: id, at: NOW - 40, sizeUsdg: 5 });
    const r2 = row({ postId: id, at: NOW - 20, sizeUsdg: 3 });
    assert.deepEqual(a.take([r2, r1], NOW), { rows: [r1, r2], fills: 2 });
  });

  it("a fill first seen long after it happened is not news — a reader re-ranking old rows must not chime", () => {
    const a = createArrivals();
    a.take([], NOW);
    assert.deepEqual(a.take([row({ at: NOW - 3 * 3600 })], NOW).rows, []);
    assert.deepEqual(a.take([row({ at: undefined })], NOW).rows, [], "and one with no time has no age to judge");
  });

  it("several at once come back oldest first", () => {
    const a = createArrivals();
    a.take([], NOW);
    const later = row({ at: NOW - 5 });
    const earlier = row({ at: NOW - 50 });
    assert.deepEqual(a.take([later, earlier], NOW).rows.map((t) => t.at), [NOW - 50, NOW - 5]);
  });

  it("remembers a bounded number of ids", () => {
    const a = createArrivals({ cap: 3 });
    a.take([row(), row(), row(), row(), row()], NOW);
    assert.equal(a.size(), 3);
  });
});

/**
 * NOTHING THAT DID NOT HAPPEN IS EVER ANNOUNCED. Each case here is one a review
 * built against a rule that measured fills by a row's count of copies; each
 * announced a fill nobody made. The rule now is time only: a post's landed row
 * is news only past the newest `at` this page ever read for it.
 */
describe("a fill that did not happen is never announced", () => {
  it("COPIES LEAVING THE WINDOW: `said` shrinks with time, then grows back, and nothing landed", () => {
    const a = createArrivals();
    const leg = row({ at: NOW - 60, said: 5 });
    a.take([leg], NOW);
    assert.deepEqual(a.take([{ ...leg, said: 4 }], NOW + 10).rows, []);
    assert.deepEqual(a.take([{ ...leg, said: 5 }], NOW + 20).rows, [], "a count coming back is not a landing");
  });

  it("A ROW THAT FELL PAST THE READ'S BOUND AND CAME BACK brings its old copies, not new fills (R4W-1)", () => {
    const a = createArrivals();
    const id = row().postId;
    const regular = row({ postId: id, at: NOW - 600, said: 9, sizeUsdg: 5 });
    const clamped = row({ postId: id, at: NOW - 300, said: 1, sizeUsdg: 2 });
    a.take([clamped, regular], NOW);
    assert.deepEqual(a.take([clamped], NOW + 10).rows, [], "the older row pushed off the read");
    assert.deepEqual(a.take([clamped, regular], NOW + 20).rows, [], "and back with every copy it always had");
  });

  it("BOTH OLD ROWS LEAVING WHILE ONE NEW ROW ARRIVES is one fill, not their counts (R5W-1)", () => {
    const a = createArrivals();
    const id = row().postId;
    const big = row({ postId: id, at: NOW - 900, said: 12 });
    const top = row({ postId: id, at: NOW - 300, said: 1 });
    a.take([big, top], NOW);
    const next = row({ postId: id, at: NOW - 10, said: 13 });
    assert.deepEqual(a.take([next], NOW), { rows: [next], fills: 1 });
  });

  it("A POST BODY SPLITTING A ROW adds a row at a time already seen — not a fill (R5W-2)", () => {
    const a = createArrivals();
    const id = row().postId;
    const leg = row({ postId: id, at: NOW - 60, said: 3 });
    a.take([leg], NOW);
    const withBody = { ...leg, said: 1, post: "one line" } as Thesis;
    const rest = row({ postId: id, at: NOW - 120, said: 2 });
    assert.deepEqual(a.take([withBody, rest], NOW + 10).rows, []);
  });

  it("A ROW WHOSE TIME WENT BACK is another grouping of the post, and not news when it returns", () => {
    const a = createArrivals();
    const leg = row({ at: NOW - 30, said: 4 });
    a.take([leg], NOW);
    assert.deepEqual(a.take([{ ...leg, at: NOW - 200, said: 1 }], NOW + 10).rows, []);
    assert.deepEqual(a.take([leg], NOW + 20).rows, [], "the row it was, read again");
  });

  it("TWO ROWS IN THE SAME SECOND, read apart across a bound, are at most one fill (R5W-4)", () => {
    const a = createArrivals();
    const id = row().postId;
    const r1 = row({ postId: id, at: NOW - 30, sizeUsdg: 5 });
    const r2 = row({ postId: id, at: NOW - 30, sizeUsdg: 3 });
    a.take([r1], NOW);
    assert.deepEqual(a.take([r1, r2], NOW + 10).rows, [], "the second of the same second is not a new time");
  });

  it("the price of never lying: a late landing that leaves the newest time where it was is not announced", () => {
    // An order decided before the row's newest copy lands after it: `at` stands
    // still. It is on the feed and the desk; only the tone is not played.
    const a = createArrivals();
    const leg = row({ at: NOW - 20, said: 2 });
    a.take([leg], NOW);
    assert.deepEqual(a.take([{ ...leg, said: 3 }], NOW + 10), { rows: [], fills: 0 });
  });
});

describe("what the owner's book setting changes is not news", () => {
  it("A BOOK FLIPPED PUBLIC OR PRIVATE re-ids every recent fill — and none of them chimes again", () => {
    // The post id hashes the published size and reason; a private book
    // publishes neither size nor figures. The same landed decision, read once
    // public and once private, comes back under a new id at the same time.
    const a = createArrivals();
    a.take([], NOW);
    const publicRow = row({ slug: "shogun", action: "buy", symbol: "CASHCAT", at: NOW - 30, sizeUsdg: 5, postId: "a".repeat(32) });
    assert.equal(a.take([publicRow], NOW).rows.length, 1, "the fill, once");
    const privateRow = { ...publicRow, sizeUsdg: null, postId: "b".repeat(32) } as Thesis;
    assert.deepEqual(a.take([privateRow], NOW + 10), { rows: [], fills: 0 }, "the same fill under a new id is not a new fill");
    assert.deepEqual(a.take([publicRow], NOW + 20), { rows: [], fills: 0 }, "and flipped back, still not");
    const next = { ...privateRow, at: NOW + 25 };
    assert.equal(a.take([next], NOW + 30).rows.length, 1, "a genuinely newer fill of that coin still is");
  });

  it("two agents, or two sides, or two coins keep their own times", () => {
    const a = createArrivals();
    const t = NOW - 30;
    a.take([row({ slug: "shogun", symbol: "CASHCAT", at: t })], NOW);
    const other = [
      row({ slug: "sirsendit", symbol: "CASHCAT", at: t }),
      row({ slug: "shogun", action: "sell", symbol: "CASHCAT", at: t }),
      row({ slug: "shogun", symbol: "CHUMP", at: t }),
    ];
    assert.equal(a.take(other, NOW).rows.length, 3);
  });
});
