import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextTickDelayMs, reviewLookaheadSec, tickIntervalMs } from "./decision-cadence";
import { afterFiring, EMPTY_TRIGGER_STATE, nextReviewAt, shouldWake, type TriggerState } from "./brain-trigger";

describe("five-minute decision schedule", () => {
  it("does not add tick processing time to the polling interval", () => {
    assert.equal(nextTickDelayMs({ startedAt: 100_000, now: 170_000, tickSeconds: 240 }), 170_000);
    assert.equal(tickIntervalMs(3600), 300_000);
    assert.equal(tickIntervalMs(NaN), 60_000);
  });

  it("brings an otherwise eight-minute Brain review forward to its deadline", () => {
    const base = 1_800_000_000;
    let now = base * 1000;
    let state: TriggerState = EMPTY_TRIGGER_STATE;
    const reviews: number[] = [];
    // Run the real trigger with the actual scheduler for an hour of quiet
    // market ticks, including work AFTER the trigger.
    for (let tick = 0; now < (base + 3600) * 1000; tick++) {
      const startedAt = now;
      const input = { now: Math.floor(now / 1000), priceUsd: 100, equityUsdg: 100_000_000, newsKey: null, userRequested: false };
      const verdict = shouldWake(state, input);
      if (verdict.fire) {
        reviews.push(input.now);
        state = afterFiring(state, verdict.reason!, input);
      }
      now += verdict.fire ? 70_000 : 8_000;
      now += nextTickDelayMs({ startedAt, now, tickSeconds: 240, nextReviewAt: nextReviewAt(state, input.now) });
    }
    assert.ok(reviews.length >= 12);
    for (let i = 1; i < reviews.length; i++) assert.ok(reviews[i]! - reviews[i - 1]! <= 300);
  });

  it("includes real preparation before the trigger without backdating review timestamps", () => {
    const base = 1_800_000_000;
    let now = base * 1000;
    let preparationMs = 0;
    let state: TriggerState = EMPTY_TRIGGER_STATE;
    const reviews: number[] = [];
    const preparation = [60_000, 8_000, 45_000, 60_000, 20_000, 2_000];
    for (let tick = 0; now < (base + 3600) * 1000; tick++) {
      const startedAt = now;
      const readMs = preparation[tick % preparation.length]!;
      now += readMs;
      preparationMs = Math.max(preparationMs, readMs);
      const input = { now: Math.floor(now / 1000), reviewPreparationMs: preparationMs, priceUsd: 100, equityUsdg: 100_000_000, newsKey: null, userRequested: false };
      const verdict = shouldWake(state, input);
      if (verdict.fire) {
        reviews.push(input.now);
        state = afterFiring(state, verdict.reason!, input);
        assert.equal(state.lastFiredAt[verdict.reason!], Math.floor(now / 1000), "record the real review time");
      }
      now += verdict.fire ? 70_000 : 8_000;
      const delay = nextTickDelayMs({ startedAt, now, tickSeconds: 240, preparationMs, nextReviewAt: nextReviewAt(state, input.now) });
      assert.ok(delay >= 1000, "a completed tick always yields before the next begins");
      now += delay;
    }
    assert.ok(reviews.length >= 12);
    for (let i = 1; i < reviews.length; i++) {
      const gap = reviews[i]! - reviews[i - 1]!;
      assert.ok(gap <= 300, `${gap}s exceeds the deadline with preparation inside its observed budget`);
      assert.ok(gap >= 150, "early review allowance cannot become a research loop");
    }
  });

  it("bounds the early window and never spins on a withheld early opportunity", () => {
    assert.equal(reviewLookaheadSec(60_001), 61);
    assert.equal(reviewLookaheadSec(999_999), 150);
    assert.equal(reviewLookaheadSec(999_999, 60), 30);
    for (const value of [NaN, Infinity, -1]) assert.equal(reviewLookaheadSec(value), 0);
    // The early wakeup at 240s finished without a publishable decision. Sleep
    // to the actual 300s deadline instead of retrying the expired early target.
    assert.equal(nextTickDelayMs({ startedAt: 240_000, now: 250_000, tickSeconds: 240, nextReviewAt: 300, preparationMs: 60_000 }), 50_000);
  });

  it("retries an overdue cycle after completion without creating catch-up bursts", () => {
    assert.equal(nextTickDelayMs({ startedAt: 0, now: 400_000, tickSeconds: 300, nextReviewAt: 300 }), 1000);
    // No stale deadline is retained when a tick could not read its market.
    assert.equal(nextTickDelayMs({ startedAt: 400_000, now: 401_000, tickSeconds: 300, nextReviewAt: null }), 299_000);
  });
});
