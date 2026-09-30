import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { marketReview, MarketReviewClock, PRIVATE_REVIEW_SOURCE, REVIEW_SOURCE, reviewSource, type ReviewQuote } from "./market-review";
import { publishableThesis } from "./thesis-policy";
import { memoryLines, sentimentLine } from "./brain-material";
const quote = (over: Partial<ReviewQuote> = {}): ReviewQuote => ({ symbol: "TSLA", priceUsd: 102, at: 1800000000, stale: false, ...over });
const history = [{ at: quote().at - 3600, priceUsd: 100 }, { at: quote().at - 1800, priceUsd: 103 }, { at: quote().at - 60, priceUsd: 101 }];
const row = (source: string, review: { action: "hold"; symbol: string; reason: string }) =>
  ({ source, ...review, first_at: quote().at, last_at: quote().at, name: "shogun" });

describe("research-backed quiet decisions", () => {
  it("says one third-person line built from the observation, with the evidence beside it", () => {
    const review = marketReview(quote(), null, history)!;
    // NOT FIRST PERSON. Nothing in the sentence is this agent's: it is a fact
    // about one shared oracle series, and five agents watching TSLA used to
    // publish the same paragraph as five personal convictions.
    assert.equal(review.reason, "TSLA +2.0% over 1h, above its mean.");
    assert.ok(!/\b(I|my|me)\b/.test(review.reason));
    const evidence = JSON.parse(review.evidence_json);
    assert.deepEqual(evidence.points, history);
    assert.equal(evidence.high, 103);
    assert.equal(evidence.low, 100);
    assert.equal(evidence.direction, "upward");
    assert.equal(evidence.confirmationRounds, 2);
  });
  it("rejects spot quotes, repeated timestamps, stale or flat history", () => {
    for (const points of [[], history.slice(0, 1), history.map(p => ({ ...p, at: quote().at })), history.map(p => ({ ...p, priceUsd: 100 })), history.map(p => ({ ...p, at: p.at - 7200 }))]) assert.equal(marketReview(quote(), null, points), null);
    for (const q of [quote({ stale: true }), quote({ priceUsd: NaN }), quote({ priceUsd: 0 }), quote({ symbol: "bad\nname" })]) assert.equal(marketReview(q, null, history), null);
  });
  it("excludes future and invalid observations", () => {
    const review = marketReview(quote(), null, [...history, { at: quote().at + 1, priceUsd: 999 }, { at: quote().at - 1, priceUsd: Infinity }])!;
    assert.deepEqual(JSON.parse(review.evidence_json).points, history);
  });
  it("records private holds without publishing operational failures", () => {
    assert.equal(publishableThesis({ source: "research-unavailable", action: "hold", reason: "Invalid API key" }), null);
    const clock = new MarketReviewClock();
    assert.equal(clock.prepare(quote()), null);
    assert.equal(clock.due(quote().at), true);
    clock.recorded(quote());
    assert.equal(clock.due(quote().at + 299), false);
    assert.equal(clock.due(quote().at + 300), true);
  });
  it("retries failed persistence and respects bounded preparation", () => {
    const clock = new MarketReviewClock();
    assert.ok(clock.prepare(quote(), 0, history));
    assert.ok(clock.prepare(quote(), 0, history));
    clock.recorded(quote());
    assert.equal(clock.prepare(quote({ at: quote().at + 239 }), 60000, history), null);
    assert.ok(clock.prepare(quote({ at: quote().at + 240 }), 60000, history));
    clock.noteDecision(quote().at + 300);
    assert.equal(clock.due(quote().at + 301), false);
    assert.equal(clock.nextAt, quote().at + 600);
  });
  it("uses decision time for cadence without falsifying observation timestamps", () => {
    const clock = new MarketReviewClock();
    clock.noteDecision(quote().at - 250);
    const review = clock.prepare(quote(), 0, history, quote().at + 50)!;
    assert.ok(review);
    assert.equal(JSON.parse(review.evidence_json).quote.at, quote().at);
  });
});

/**
 * PRIVATE UNLESS SOMETHING HAPPENED.
 *
 * quietReview wrote this for every quiet agent every five minutes, and when
 * TSLA was the only fresh feed every agent picked TSLA — so the feed carried
 * the same shared Chainlink paragraph under five names, every five minutes.
 * The review is still written, for the owner's record; it is PUBLISHED only
 * when it says something the last one did not.
 */
describe("a market review publishes only when it changes", () => {
  const later = (dt: number, priceUsd: number) => quote({ at: quote().at + dt, priceUsd });

  it("the first review and an unchanged one stay in the owner's record", () => {
    const clock = new MarketReviewClock();
    const first = clock.prepare(quote(), 0, history)!;
    assert.equal(first.publish, false, "nothing to compare against is not news");
    assert.equal(reviewSource(first), PRIVATE_REVIEW_SOURCE);
    assert.equal(publishableThesis(row(reviewSource(first), first)), null, "an unclassified source publishes nothing");
    clock.recorded(quote(), first);
    const same = clock.prepare(later(300, 102.5), 0, [...history, { at: quote().at + 240, priceUsd: 102.4 }])!;
    assert.equal(same.publish, false, "the same bias five minutes later is the same view");
  });

  it("A FLIP PUBLISHES, and says what it flipped from", () => {
    const clock = new MarketReviewClock();
    const up = clock.prepare(quote(), 0, history)!;
    clock.recorded(quote(), up);
    const falling = [...history, { at: quote().at + 200, priceUsd: 100.5 }, { at: quote().at + 260, priceUsd: 100.2 }];
    const down = clock.prepare(later(300, 100.2), 0, falling)!;
    assert.equal(down.publish, true);
    assert.equal(reviewSource(down), REVIEW_SOURCE);
    assert.match(down.reason, /^TSLA \+0\.2% over 1h, below its mean — it was above it at the last review\.$/);
    assert.equal(JSON.parse(down.evidence_json).event, "flip");
    const post = publishableThesis(row(reviewSource(down), down));
    assert.ok(post, "a changed view reaches the feed");
    // Peers read the published sentence. The agent's own memory does not: the
    // review is filed as a hold, and a hold is not memory (brain-memory.test.ts)
    // — nothing in this sentence is the agent's own word anyway.
    assert.ok(sentimentLine([post], "TSLA", "sentiment")?.includes("below its mean"));
    assert.deepEqual(memoryLines([post], quote().at + 301), []);
  });

  it("A TWO-ROUND BREAKOUT PUBLISHES — the follow-up the review named", () => {
    const clock = new MarketReviewClock();
    const first = clock.prepare(quote(), 0, history)!;
    clock.recorded(quote(), first);
    const broke = [...history, { at: quote().at + 200, priceUsd: 103.4 }, { at: quote().at + 260, priceUsd: 103.9 }];
    const review = clock.prepare(later(300, 103.9), 0, broke)!;
    assert.equal(review.publish, true);
    assert.match(review.reason, /— two fresh oracle rounds above the \$103\.00 high\.$/);
    assert.equal(JSON.parse(review.evidence_json).event, "breakout-up");
  });

  it("but one round is not a breakout", () => {
    const clock = new MarketReviewClock();
    const first = clock.prepare(quote(), 0, history)!;
    clock.recorded(quote(), first);
    const once = [...history, { at: quote().at + 200, priceUsd: 102.1 }, { at: quote().at + 260, priceUsd: 103.9 }];
    assert.equal(clock.prepare(later(300, 103.9), 0, once)!.publish, false);
  });

  it("a previous review of a DIFFERENT name is not a baseline", () => {
    const clock = new MarketReviewClock();
    const nvda = clock.prepare(quote({ symbol: "NVDA", priceUsd: 99 }), 0, history)!;
    clock.recorded(quote({ symbol: "NVDA" }), nvda);
    assert.equal(clock.prepare(later(300, 102), 0, history)!.publish, false);
    // And the rule holds for any caller, not only the clock's own bookkeeping.
    const stance = { direction: "downward" as const, high: 103, low: 100, observationEnd: quote().at - 60 };
    assert.equal(marketReview(quote(), { ...stance, symbol: "NVDA" }, history)!.publish, false);
    assert.equal(marketReview(quote(), { ...stance, symbol: "TSLA" }, history)!.publish, true);
  });

  it("a review that failed to persist is not remembered as said", () => {
    // `recorded` is called only after the row is verified written. A flip the
    // owner's record never received cannot be the baseline for the next one.
    const clock = new MarketReviewClock();
    clock.prepare(quote(), 0, history);
    const falling = [...history, { at: quote().at + 200, priceUsd: 100.5 }, { at: quote().at + 260, priceUsd: 100.2 }];
    assert.equal(clock.prepare(later(300, 100.2), 0, falling)!.publish, false);
  });
});
