import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARRIVAL_PATIENCE_MS, arrivalOf, balanceOf, settleWatch } from "./deposit-arrival";

const OPENED = 1_000_000;
const watch = { baseline: 10_000_000n, minOut: 35_729_935n, openedAt: OPENED };

describe("watching the agent's USDG for a deposit signed on Relay", () => {
  it("waits while nothing has risen", () => {
    assert.deepEqual(arrivalOf(watch, 10_000_000n, OPENED + 30_000), { kind: "waiting", elapsedMs: 30_000 });
    // A trade spending USDG meanwhile is still just "nothing has arrived".
    assert.equal(arrivalOf(watch, 4_000_000n, OPENED + 60_000).kind, "waiting");
  });

  it("calls it arrived once the rise reaches the quote's minimum", () => {
    assert.deepEqual(arrivalOf(watch, 10_000_000n + 35_729_935n, OPENED + 5_000), { kind: "arrived", rise: 35_729_935n });
    assert.deepEqual(arrivalOf(watch, 10_000_000n + 35_900_000n, OPENED + 5_000), { kind: "arrived", rise: 35_900_000n });
  });

  it("calls a smaller rise partial, not arrived and not failed", () => {
    assert.deepEqual(arrivalOf(watch, 10_000_001n, OPENED + 5_000), { kind: "partial", rise: 1n });
  });

  it("says 'not seen yet' after fifteen minutes, never failed", () => {
    assert.deepEqual(arrivalOf(watch, 10_000_000n, OPENED + ARRIVAL_PATIENCE_MS), { kind: "late", elapsedMs: ARRIVAL_PATIENCE_MS });
    // A late rise still counts the moment it is read.
    assert.equal(arrivalOf(watch, 50_000_000n, OPENED + ARRIVAL_PATIENCE_MS * 4).kind, "arrived");
  });

  it("never reads a failed balance as zero", () => {
    assert.deepEqual(arrivalOf(watch, null, OPENED + 5_000), { kind: "unread" });
    assert.equal(balanceOf(null), null);
    assert.equal(balanceOf(undefined), null);
    assert.equal(balanceOf(""), null);
    assert.equal(balanceOf("-5"), null);
    assert.equal(balanceOf("0"), 0n);
  });

  it("refuses to compare against a starting balance nobody read", () => {
    assert.deepEqual(arrivalOf({ ...watch, baseline: null }, 99_000_000n, OPENED + 5_000), { kind: "no-baseline", current: 99_000_000n });
    assert.deepEqual(arrivalOf({ ...watch, baseline: null }, null, OPENED + 5_000), { kind: "no-baseline", current: null });
  });

  it("measures from a zero starting balance as a real zero", () => {
    assert.equal(arrivalOf({ ...watch, baseline: 0n }, 35_729_935n, OPENED + 1_000).kind, "arrived");
  });

  it("keeps an arrival once seen, whatever later readings say", () => {
    const seen = settleWatch(watch, 10_000_000n + 40_000_000n, OPENED + 5_000);
    assert.equal(seen.arrived, 40_000_000n);
    // The agent trades it away, the read fails, the clock runs past patience.
    assert.deepEqual(arrivalOf(seen, 1_000_000n, OPENED + 60_000), { kind: "arrived", rise: 40_000_000n });
    assert.deepEqual(arrivalOf(seen, null, OPENED + ARRIVAL_PATIENCE_MS * 2), { kind: "arrived", rise: 40_000_000n });
    // Settling again keeps the first sighting.
    assert.equal(settleWatch(seen, 10_000_000n + 90_000_000n, OPENED + 90_000), seen);
  });

  it("remembers nothing short of the minimum", () => {
    assert.equal(settleWatch(watch, 10_000_001n, OPENED + 5_000), watch, "partial");
    assert.equal(settleWatch(watch, null, OPENED + 5_000), watch, "unread");
    assert.equal(settleWatch({ ...watch, baseline: null }, 99_000_000n, OPENED + 5_000).arrived, undefined, "no baseline");
  });

  it("does not count time before the link was opened", () => {
    assert.deepEqual(arrivalOf(watch, 10_000_000n, OPENED - 10_000), { kind: "waiting", elapsedMs: 0 });
  });
});
