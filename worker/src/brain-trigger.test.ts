/**
 * THE CHEAP GATE IN FRONT OF THE EXPENSIVE ONE.
 *
 * The tick runs every 240 seconds. Wiring Brain to it unconditionally would be
 * ~360 runs per agent per day for a market that mostly did nothing — and this
 * fleet has already had one incident where an unwatched background feature
 * emptied a daily token allowance. These tests are about the sleeping, not the
 * waking: a trigger layer that fires on everything is the same as no trigger
 * layer, and costs the same.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  afterFiring,
  DEFAULT_TRIGGERS,
  EMPTY_TRIGGER_STATE,
  shouldWake,
  type TriggerInputs,
  type TriggerState,
} from "./brain-trigger";

const T0 = 1_788_000_000;
const input = (over: Partial<TriggerInputs> = {}): TriggerInputs => ({
  now: T0,
  priceUsd: 100,
  equityUsdg: 500_000_000,
  newsKey: null,
  userRequested: false,
  ...over,
});

/**
 * A settled agent: it ran two hours ago, so every per-reason cooldown has
 * elapsed (the longest is 1800s) but the four-hour scheduled review has not.
 * That is the state most ticks find, and it is the one where a trigger must be
 * caused by something rather than by the clock.
 */
const settled = (over: Partial<TriggerState> = {}): TriggerState => ({
  lastFiredAt: {
    "scheduled-review": T0 - 7200,
    "price-move": T0 - 7200,
    "portfolio-change": T0 - 7200,
    "news-event": T0 - 7200,
  },
  lastPriceUsd: 100,
  lastEquityUsdg: 500_000_000,
  lastNewsKey: "n1",
  ...over,
});

describe("Brain sleeps when nothing happened", () => {
  it("does not fire on a quiet tick", () => {
    const v = shouldWake(settled(), input({ newsKey: "n1" }));
    assert.equal(v.fire, false);
    assert.match(v.detail, /nothing changed enough/);
  });

  it("does not fire on a move below the threshold", () => {
    // 2% when the bar is 3%. Most ticks look like this.
    const v = shouldWake(settled(), input({ priceUsd: 102, newsKey: "n1" }));
    assert.equal(v.fire, false);
  });

  it("fires on a real price move", () => {
    const v = shouldWake(settled(), input({ priceUsd: 104, newsKey: "n1" }));
    assert.equal(v.fire, true);
    assert.equal(v.reason, "price-move");
    assert.match(v.detail, /4\.0%/);
  });

  it("fires on a material portfolio change", () => {
    const v = shouldWake(settled(), input({ equityUsdg: 560_000_000, newsKey: "n1" }));
    assert.equal(v.fire, true);
    assert.equal(v.reason, "portfolio-change");
  });

  it("fires on a news item it has not seen", () => {
    const v = shouldWake(settled(), input({ newsKey: "n2" }));
    assert.equal(v.fire, true);
    assert.equal(v.reason, "news-event");
  });

  it("does not fire twice on the same news item", () => {
    const v = shouldWake(settled({ lastNewsKey: "n2" }), input({ newsKey: "n2" }));
    assert.equal(v.fire, false);
  });
});

describe("priority and cooldown", () => {
  it("a person asking outranks everything", () => {
    const v = shouldWake(settled(), input({ userRequested: true, priceUsd: 200, newsKey: "n9" }));
    assert.equal(v.reason, "user-request");
    assert.ok(v.candidates.length > 1, "the others still qualified, they just did not win");
  });

  it("one tick produces at most one run", () => {
    // Price, equity and news all moved. Three reasons, one run — otherwise a
    // busy tick bills three times for one situation.
    const v = shouldWake(settled(), input({ priceUsd: 130, equityUsdg: 600_000_000, newsKey: "n2" }));
    assert.equal(v.fire, true);
    assert.equal(v.candidates.length, 3);
    assert.equal(v.reason, "portfolio-change", "priority order, not arrival order");
  });

  it("cools down per reason rather than globally", () => {
    // A price move that just fired must not silence a genuine risk event.
    const state = settled({ lastFiredAt: { "price-move": T0 - 10, "scheduled-review": T0 - 10 } });
    const v = shouldWake(state, input({ priceUsd: 130, equityUsdg: 600_000_000, newsKey: "n1" }));
    assert.equal(v.fire, true);
    assert.equal(v.reason, "portfolio-change", "a different question is not on the price cooldown");
  });

  it("suppresses a repeat of the same reason inside its cooldown", () => {
    const state = settled({ lastFiredAt: { "price-move": T0 - 10, "scheduled-review": T0 - 10 } });
    const v = shouldWake(state, input({ priceUsd: 130, newsKey: "n1" }));
    assert.equal(v.fire, false);
    assert.deepEqual(v.candidates, ["price-move"]);
    assert.match(v.detail, /still cooling down/);
  });

  it("wakes on the schedule when the market is silent for long enough", () => {
    const quiet = settled({ lastFiredAt: { "scheduled-review": T0 - DEFAULT_TRIGGERS.scheduledIntervalSec - 1 } });
    const v = shouldWake(quiet, input({ newsKey: "n1" }));
    assert.equal(v.fire, true);
    assert.equal(v.reason, "scheduled-review");
  });

  it("runs once on a cold start and then settles", () => {
    const first = shouldWake(EMPTY_TRIGGER_STATE, input());
    assert.equal(first.fire, true);
    assert.equal(first.reason, "scheduled-review");
    const next = afterFiring(EMPTY_TRIGGER_STATE, first.reason!, input());
    assert.equal(shouldWake(next, input({ now: T0 + 60 })).fire, false);
  });
});

describe("the baseline moves on every fire", () => {
  it("does not bill one real movement twice", () => {
    // A scheduled review that left the old price in place would let the next
    // tick read the same drift as a fresh move.
    const state = settled({ lastFiredAt: { "scheduled-review": T0 - 99_999 } });
    const i = input({ priceUsd: 130, newsKey: "n1" });
    const v = shouldWake(state, i);
    assert.equal(v.fire, true);

    const after = afterFiring(state, v.reason!, i);
    assert.equal(after.lastPriceUsd, 130, "the new price is the new baseline");
    const again = shouldWake(after, input({ now: T0 + 60, priceUsd: 130, newsKey: "n1" }));
    assert.equal(again.fire, false, "the same 30% move must not fire a second time");
  });
});
