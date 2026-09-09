/**
 * THE PROPERTIES THAT DECIDE WHETHER THIS HELPS OR MAKES IT WORSE.
 *
 * A limiter added to a system that is already failing is the most dangerous
 * kind of change: every mistake it makes looks exactly like the fault it was
 * added to fix. So the tests here are not about arithmetic. They are about the
 * four ways this could turn a 5% overshoot into an outage —
 *
 *   backing off in lockstep (which rebuilds the burst it is damping),
 *   letting a stale shared file release a live cooldown,
 *   holding a healthy fleet down after the endpoint recovers, and
 *   throttling a tick that was never near the limit,
 *
 * — plus the one property the whole diagnosis rests on: a refusal must never
 * cause another request into the thing that refused.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_LIMITS,
  adoptShared,
  backoffMs,
  begin,
  decide,
  end,
  freshState,
  refill,
  shouldPublish,
  type GovernorState,
} from "./rpc-governor";

const L = DEFAULT_LIMITS;
const T0 = 1_788_000_000_000;

/** Refuse `n` requests in a row, from a clean state. */
const strike = (n: number, rand = 0.9): GovernorState => {
  let s = freshState(T0);
  for (let i = 0; i < n; i += 1) s = end(begin(s, T0, L), T0, L, { refused: true }, rand);
  return s;
};

describe("a refusal never produces another request into the refusal", () => {
  it("A LONE REFUSAL OPENS NOTHING — this is the regression, not the design", () => {
    // Shipped opening on the first strike, and production went from 56% of
    // meter windows showing refusals to 93%, with "market unreadable"
    // outnumbering successful block reads. At this endpoint a single 429 is
    // noise: measured, it serves 50/s cleanly and refuses about a fifth at
    // 100/s. Stopping the whole container over one of them turns a slow tick
    // into a blind one.
    for (const n of [1, 2]) {
      assert.equal(decide(strike(n), T0 + 1, L).act, "send", `${n} strike(s) must not open the breaker`);
    }
    assert.equal(strike(2).strikes, 2, "but they are still counted — the ladder needs them");
  });

  it("AND A PATTERN DOES — it refuses, it does not queue", () => {
    // The distinction is the fix. `wait` means "you are going too fast, slow
    // down"; `refuse` means "the endpoint said stop, repeatedly". A governor
    // that turned a sustained refusal into a wait would still send — later,
    // together with fourteen others — which is what viem's retryCount:3 did.
    const s = strike(L.openAfterStrikes);
    const d = decide(s, T0 + 1, L);
    assert.equal(d.act, "refuse");
    assert.ok(d.ms > 0);
  });

  it("and the cooldown outranks a full bucket", () => {
    // Tokens say yes, the endpoint has said no three times. The endpoint wins.
    const s = { ...strike(L.openAfterStrikes, 1), tokens: L.burst };
    assert.equal(decide(s, T0 + 10, L).act, "refuse");
  });

  it("AND THE CEILING IS ONE A TICK CAN SURVIVE", () => {
    // Thirty seconds — the first value — is longer than several sequential
    // reads take, so an open breaker blinded the whole tick rather than
    // slowing it. The cooldown is shared by every child, so its cost is paid
    // fleet-wide at once.
    assert.ok(L.maxBackoffMs <= 5_000, "a shared cooldown must be survivable inside one tick");
    let worst = 0;
    for (let n = L.openAfterStrikes; n < 20; n += 1) {
      worst = Math.max(worst, backoffMs(n, L, 1, null));
    }
    assert.ok(worst <= L.maxBackoffMs);
  });
});

describe("full jitter, because fifteen children share one endpoint", () => {
  it("THE SAME LADDER MUST NOT PRODUCE THE SAME DELAY", () => {
    // getLogsAdaptive retried a rate limit at a fixed 132ms. Fifteen children
    // refused in the same instant then retried in the same instant, which is
    // the burst reassembled. A uniform draw over the window is what breaks it.
    const draws = [0, 0.1, 0.25, 0.5, 0.75, 0.99].map((r) => backoffMs(5, L, r, null));
    assert.equal(new Set(draws).size, draws.length, "distinct draws must give distinct delays");
    const window = Math.min(L.maxBackoffMs, L.baseBackoffMs * 2 ** 4);
    assert.ok(
      Math.max(...draws) - Math.min(...draws) > window * 0.8,
      "and the spread must cover most of the window, or it is not full jitter",
    );
  });

  it("the window doubles per strike and then stops", () => {
    // Always the top of the window (rand = 1) so the ladder itself is visible.
    assert.equal(backoffMs(1, L, 1, null), L.baseBackoffMs);
    assert.equal(backoffMs(2, L, 1, null), L.baseBackoffMs * 2);
    assert.equal(backoffMs(3, L, 1, null), L.baseBackoffMs * 4);
    assert.equal(backoffMs(50, L, 1, null), L.maxBackoffMs, "and it is capped, not unbounded");
  });

  it("AND A Retry-After IS A FLOOR, NOT A SCHEDULE", () => {
    // It says when the endpoint will talk again. It does not say the whole
    // fleet should resume in that same millisecond, so the jitter is added on
    // top rather than replaced by it.
    const a = backoffMs(1, L, 0, 5_000);
    const b = backoffMs(1, L, 0.9, 5_000);
    assert.ok(a >= 5_000 && b >= 5_000, "never earlier than the endpoint asked");
    assert.ok(b > a, "and still spread");
  });
});

describe("the shared cooldown only ever extends", () => {
  it("A STALE FILE CANNOT RELEASE A LIVE COOLDOWN", () => {
    // Fifteen processes write this number. If a low value could overwrite a
    // high one, the child with the shortest memory would pull the whole fleet
    // back into the overload.
    const s: GovernorState = { ...freshState(T0), coolUntil: T0 + 10_000 };
    assert.equal(adoptShared(s, T0 + 500, T0, L).coolUntil, T0 + 10_000);
    assert.equal(adoptShared(s, 0, T0, L).coolUntil, T0 + 10_000);
    assert.equal(adoptShared(s, Number.NaN, T0, L).coolUntil, T0 + 10_000);
    assert.equal(adoptShared(s, null, T0, L).coolUntil, T0 + 10_000);
  });

  it("but a longer one from another child is adopted", () => {
    const s: GovernorState = { ...freshState(T0), coolUntil: T0 + 500 };
    assert.equal(adoptShared(s, T0 + 4_000, T0, L).coolUntil, T0 + 4_000);
  });

  it("AND A FILE FROM YESTERDAY CANNOT BRICK THE FLEET", () => {
    // This one was found by a test, not by reasoning: the file outlives every
    // process that can see it, so a restarted child reads whatever is on disk
    // and believes it. Without a ceiling, one bad number — a clock skew, a
    // botched write, a value from a container that ran yesterday — refuses
    // every read for every child for as long as it says, and nothing in the
    // fleet ever asks the endpoint again to discover it had recovered.
    const s = freshState(T0);
    const week = T0 + 7 * 24 * 3_600_000;
    assert.equal(adoptShared(s, week, T0, L).coolUntil, T0 + L.maxBackoffMs);
    // The cap can only ever discard a number this module did not write.
    assert.equal(adoptShared(s, T0 + L.maxBackoffMs, T0, L).coolUntil, T0 + L.maxBackoffMs);
  });

  it("and `end` will not shorten one either", () => {
    // A child on its first strike must not pull the fleet in early just
    // because its own ladder is short.
    const s: GovernorState = { ...freshState(T0), coolUntil: T0 + 20_000, inFlight: 1 };
    const after = end(s, T0, L, { refused: true }, 0);
    assert.equal(after.coolUntil, T0 + 20_000);
  });

  it("and it is only published when it would actually tell somebody something", () => {
    // Writing on every refusal means fifteen processes writing one file in a
    // tight loop during the incident the file exists to damp.
    const s: GovernorState = { ...freshState(T0), coolUntil: T0 + 5_000 };
    assert.equal(shouldPublish(s, T0 + 4_900), false, "a 100ms improvement is not news");
    assert.equal(shouldPublish(s, T0 + 1_000), true);
    assert.equal(shouldPublish(s, null), true);
  });
});

describe("recovery must be immediate, or the limiter becomes the outage", () => {
  it("ONE SUCCESS CLEARS THE LADDER COMPLETELY", () => {
    // Decaying the strike count would leave a fleet that had one bad minute
    // backing off into a healthy endpoint for many more.
    let s = freshState(T0);
    for (let i = 0; i < 5; i += 1) s = end(begin(s, T0, L), T0, L, { refused: true }, 0.5);
    assert.ok(s.strikes >= 5);
    s = end(begin(s, T0 + 60_000, L), T0 + 60_000, L, { refused: false }, 0.5);
    assert.equal(s.strikes, 0);
  });

  it("and once the cooldown passes, sending resumes with no further ceremony", () => {
    let s = freshState(T0);
    s = end(begin(s, T0, L), T0, L, { refused: true }, 1);
    const until = s.coolUntil;
    assert.equal(decide(s, until - 1, L).act, "refuse");
    assert.equal(decide(s, until + 1, L).act, "send");
  });
});

describe("a healthy tick is never throttled", () => {
  it("THE MEASURED WORKLOAD PASSES WITHOUT WAITING", () => {
    // The median child made 0.68 logical calls a second, and a tick's price
    // multicall arrives as one burst. If the defaults delayed that, the
    // limiter would be slowing the fleet down to protect an endpoint it was
    // never troubling — the fleet measured 11.2 calls/s against a ceiling
    // between 50 and 100.
    let s = freshState(T0);
    for (let i = 0; i < L.burst; i += 1) {
      assert.equal(decide(s, T0, L).act, "send", `burst call ${i + 1} must not wait`);
      s = begin(s, T0, L);
      s = end(s, T0, L, { refused: false }, 0.5);
    }
    // And a second tick, four minutes later, is entirely refilled.
    assert.equal(decide(s, T0 + 240_000, L).act, "send");
    assert.equal(refill(s, T0 + 240_000, L).tokens, L.burst);
  });

  it("and only a runaway is asked to wait", () => {
    let s = freshState(T0);
    for (let i = 0; i < L.burst; i += 1) s = end(begin(s, T0, L), T0, L, { refused: false }, 0.5);
    const d = decide(s, T0, L);
    assert.equal(d.act, "wait", "the bucket is empty in the same millisecond");
    assert.ok(d.ms > 0 && d.ms < 1_000);
  });

  it("and concurrency is capped without refusing anything", () => {
    // In-flight pressure is a fact about this instant, not a verdict from the
    // endpoint. It must produce a wait, never a refusal.
    let s = freshState(T0);
    for (let i = 0; i < L.maxInFlight; i += 1) s = begin(s, T0, L);
    assert.equal(decide(s, T0, L).act, "wait");
  });
});

describe("the bucket itself", () => {
  it("refills continuously and never past the burst", () => {
    const empty: GovernorState = { ...freshState(T0), tokens: 0 };
    assert.equal(refill(empty, T0 + 1_000, L).tokens, L.ratePerSec);
    assert.equal(refill(empty, T0 + 3_600_000, L).tokens, L.burst);
  });

  it("and a clock that goes backwards does not mint tokens", () => {
    const s: GovernorState = { ...freshState(T0), tokens: 1 };
    assert.equal(refill(s, T0 - 60_000, L).tokens, 1);
  });
});
