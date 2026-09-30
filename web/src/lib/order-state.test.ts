/**
 * WHAT HAPPENED TO AN ORDER, ACROSS ITS OWN WINDOW — NOT ACROSS SEVEN MINUTES.
 *
 * The chat said "nothing was sent" at a fixed seven minutes. The order's real
 * window is max(5 min, 2 ticks + 15 s) — 8m15s at the hosted 240 s tick — and
 * the child enforces it at the claim, so an order could fill after the owner
 * was told it had not, and after they had asked again.
 *
 * So the server answers from the order's OWN deadline, carried in its args,
 * and "expired" is said only when it is certainly true: never claimed, and past
 * that deadline plus the grace the slot is held for. Every test here drives the
 * clock explicitly across that boundary.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ORDER_IN_FLIGHT_MS,
  ORDER_STALE_GRACE_MS,
  ORDER_TTL_FLOOR_MS,
  holdsSlot,
  hostedOrderReply,
  orderExpiresAt,
  orderStateOf,
  orderTtlMs,
  placeSelfHostedOrder,
  slotFreesAt,
} from "./order-state";

const T = 1_800_000_000_000;
/** The hosted tick: 240 s, so the window is (2 × 240 + 15) s. */
const WINDOW_MS = (2 * 240 + 15) * 1000;
const EXPIRES = T + WINDOW_MS;
const MIN = 60_000;

const row = (over: Record<string, unknown> = {}) => ({
  id: "a1b2c3",
  created_at: T,
  claimed_at: null,
  done_at: null,
  result: null,
  args: JSON.stringify({ side: "buy", symbol: "TSLA", usdgAmount: 25, expiresAt: EXPIRES }),
  ...over,
});

describe("an unclaimed order across its window", () => {
  it("IS STILL QUEUED AT SEVEN MINUTES — the moment the chat used to give up", () => {
    assert.equal(hostedOrderReply(row(), T + 7 * MIN).state, "queued");
  });

  it("is still queued at its own deadline, and through the grace after it", () => {
    assert.equal(hostedOrderReply(row(), EXPIRES).state, "queued");
    assert.equal(hostedOrderReply(row(), EXPIRES + ORDER_STALE_GRACE_MS).state, "queued");
  });

  it("is EXPIRED one millisecond past deadline plus grace — and only then", () => {
    assert.equal(hostedOrderReply(row(), EXPIRES + ORDER_STALE_GRACE_MS + 1).state, "expired");
  });

  it("the grace is the slot's grace, so the answer and the one-at-a-time rule agree", () => {
    // The route holds the slot for exactly this long; saying "expired" any
    // earlier would invite a second order while the first could still run.
    assert.equal(ORDER_STALE_GRACE_MS, 2 * MIN);
  });
});

describe("a claimed or finished order is never called expired", () => {
  it("CLAIMED IS RUNNING, however late — the worker decides, not the clock here", () => {
    const claimed = row({ claimed_at: T + 20_000 });
    assert.equal(hostedOrderReply(claimed, T + 7 * MIN).state, "running");
    assert.equal(hostedOrderReply(claimed, EXPIRES + ORDER_STALE_GRACE_MS + 60 * MIN).state, "running");
  });

  it("done is done, with the worker's own words", () => {
    const done = row({ claimed_at: T + 20_000, done_at: T + 9 * MIN, result: "bought 25.00 USDG of TSLA" });
    const r = hostedOrderReply(done, T + 9 * MIN);
    assert.equal(r.state, "done");
    assert.equal(r.result, "bought 25.00 USDG of TSLA");
  });

  it("carries the deadline back, so the card waits for the right window", () => {
    assert.equal(hostedOrderReply(row(), T).expiresAt, EXPIRES);
  });
});

describe("an order with no deadline", () => {
  it("IS NEVER CALLED EXPIRED — the worker would still run it, so we may not say it will not", () => {
    // command-files.ts isExpired: no expiresAt means no expiry at the claim.
    const legacy = row({ args: JSON.stringify({ side: "buy", symbol: "TSLA", usdgAmount: 25 }) });
    assert.equal(hostedOrderReply(legacy, T + 24 * 60 * MIN).state, "queued");
    assert.equal(hostedOrderReply(legacy, T).expiresAt, null);
  });

  it("reads the deadline only from a real number", () => {
    assert.equal(orderExpiresAt(JSON.stringify({ expiresAt: 123 })), 123);
    assert.equal(orderExpiresAt({ expiresAt: 123 }), 123);
    assert.equal(orderExpiresAt(JSON.stringify({ expiresAt: "123" })), null);
    assert.equal(orderExpiresAt("{not json"), null);
    assert.equal(orderExpiresAt(null), null);
    assert.equal(orderExpiresAt(JSON.stringify({ expiresAt: Number.NaN })), null);
  });
});

describe("the same rule for the self-hosted files", () => {
  it("a file still in the queue past deadline plus grace is expired; a claimed one is not", () => {
    const late = EXPIRES + ORDER_STALE_GRACE_MS + 1;
    assert.equal(orderStateOf({ done: false, claimed: false, expiresAt: EXPIRES }, late), "expired");
    assert.equal(orderStateOf({ done: false, claimed: true, expiresAt: EXPIRES }, late), "running");
    assert.equal(orderStateOf({ done: true, claimed: true, expiresAt: EXPIRES }, late), "done");
    assert.equal(orderStateOf({ done: false, claimed: false, expiresAt: EXPIRES }, T + 7 * MIN), "queued");
  });
});

describe("THE SLOT LETS GO WHEN GET SAYS 'EXPIRED' — not a moment before, not a moment after", () => {
  // An unclaimed order: the one-at-a-time slot and GET's "expired" read the
  // same deadline. Earlier, a second order is admitted while the first can
  // still be claimed. Later, the owner is told "ask again" and refused for it.
  const unclaimed = { claimed: false, expiresAt: EXPIRES, at: T };
  for (const at of [T, T + 7 * MIN, EXPIRES, EXPIRES + ORDER_STALE_GRACE_MS, EXPIRES + ORDER_STALE_GRACE_MS + 1, EXPIRES + 60 * MIN]) {
    it(`at +${Math.round((at - T) / 1000)}s`, () => {
      const expired = orderStateOf({ done: false, claimed: false, expiresAt: EXPIRES }, at) === "expired";
      assert.equal(holdsSlot(unclaimed, at), !expired);
    });
  }
});

describe("A CLAIMED ORDER HOLDS THE SLOT UNTIL IT CAN NO LONGER BE TRADING", () => {
  it("through deadline and grace, and the in-flight bound after them", () => {
    // Its deadline bounds the CLAIM, not the fill: a live fill still waits on
    // its receipt. Freeing the slot at deadline + grace was "ask again" with the
    // first order on chain.
    const claimed = { claimed: true, expiresAt: EXPIRES, at: T };
    assert.equal(holdsSlot(claimed, EXPIRES + ORDER_STALE_GRACE_MS + 1), true);
    assert.equal(holdsSlot(claimed, EXPIRES + ORDER_STALE_GRACE_MS + ORDER_IN_FLIGHT_MS), true);
  });

  it("and NOT FOR EVER — a child SIGKILLed mid-trade never answers", () => {
    // A row nothing can finish used to refuse every future order from that
    // owner, for good.
    const claimed = { claimed: true, expiresAt: EXPIRES, at: T };
    assert.equal(holdsSlot(claimed, EXPIRES + ORDER_STALE_GRACE_MS + ORDER_IN_FLIGHT_MS + 1), false);
  });
});

describe("the window itself", () => {
  it("is two ticks and a ferry pass, never under five minutes", () => {
    assert.equal(orderTtlMs(240), WINDOW_MS, "the hosted tick");
    assert.equal(orderTtlMs(60), 5 * MIN, "the default tick sits on the floor");
    assert.equal(orderTtlMs(1), ORDER_TTL_FLOOR_MS);
    assert.equal(orderTtlMs(3600), (2 * 3600 + 15) * 1000);
  });

});

describe("AN UNCLAIMED ORDER WITH NO DEADLINE HOLDS THE SLOT UNTIL IT IS CLAIMED", () => {
  // Legacy rows only — nothing the route writes today lacks a deadline. The
  // worker's isExpired runs such an order whenever it is claimed, and GET
  // calls it queued for as long as it sits there. Freeing the slot at the old
  // seven minutes admitted a second order beside one that could still run.
  const legacy = { claimed: false, expiresAt: null, at: T };

  it("still held at seven minutes, and a day later — GET still calls it queued", () => {
    for (const at of [T + 7 * MIN, T + 7 * MIN + 1, T + 24 * 60 * MIN]) {
      assert.equal(orderStateOf({ done: false, claimed: false, expiresAt: null }, at), "queued");
      assert.equal(holdsSlot(legacy, at), true, `at +${(at - T) / MIN} min`);
    }
  });

  it("once claimed it is bounded like any claimed order — the floor window, the grace, the in-flight bound", () => {
    const claimed = { claimed: true, expiresAt: null, at: T };
    const bound = T + ORDER_TTL_FLOOR_MS + ORDER_STALE_GRACE_MS + ORDER_IN_FLIGHT_MS;
    assert.equal(slotFreesAt(claimed), bound);
    assert.equal(holdsSlot(claimed, bound), true);
    assert.equal(holdsSlot(claimed, bound + 1), false, "a child SIGKILLed mid-trade still lets go");
  });

  it("the self-hosted placement refuses a second order behind a legacy file, however old", () => {
    const files = [{ state: "queued" as const, expiresAt: null, at: T }];
    let written = 0;
    const r = placeSelfHostedOrder(
      { open: () => files, write: () => void (written += 1) },
      { id: "second", args: { side: "buy", symbol: "TSLA", usdgAmount: 25 }, expiresAt: T + 60 * MIN + WINDOW_MS, now: T + 60 * MIN },
    );
    assert.deepEqual(r, { ok: false, why: "in-flight" });
    assert.equal(written, 0, "nothing was queued beside it");
  });
});
