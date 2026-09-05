import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AUTO_CONVERT_COOLDOWN_MS,
  convertReserve,
  emptyLatch,
  latchAllowsFire,
  loadLatch,
  parseManualSwap,
  ratchetMarkerDown,
  recordFire,
  recordSwapId,
  saveLatch,
  swapIdCompleted,
} from "./auto-convert-state";

describe("auto-convert latch — once per deposit", () => {
  it("fires on fresh funds when never fired", () => {
    assert.equal(latchAllowsFire(emptyLatch(), 10n ** 18n, Date.now()), true);
  });

  it("does NOT refire on the same funds (the restart bug)", () => {
    const latch = emptyLatch();
    const now = 1_000_000_000_000;
    recordFire(latch, now, 100n); // 100 wei left behind
    // Same balance after a restart, cooldown long elapsed → still no fire.
    assert.equal(latchAllowsFire(latch, 100n, now + 10 * AUTO_CONVERT_COOLDOWN_MS), false);
  });

  it("fires on a new deposit after cooldown", () => {
    const latch = emptyLatch();
    const now = 1_000_000_000_000;
    recordFire(latch, now, 100n);
    assert.equal(latchAllowsFire(latch, 200n, now + AUTO_CONVERT_COOLDOWN_MS + 1), true);
  });

  it("a deposit inside the cooldown waits", () => {
    const latch = emptyLatch();
    const now = 1_000_000_000_000;
    recordFire(latch, now, 100n);
    assert.equal(latchAllowsFire(latch, 500n, now + 60_000), false);
    // ...but fires once the hour passes — the deposit is not lost.
    assert.equal(latchAllowsFire(latch, 500n, now + AUTO_CONVERT_COOLDOWN_MS), true);
  });

  it("spend-then-small-deposit still counts (marker ratchets down)", () => {
    const latch = emptyLatch();
    recordFire(latch, 1_000, 100n);
    // Gas spend drops the balance below the marker.
    assert.equal(ratchetMarkerDown(latch, 40n), true);
    assert.equal(latch.consideredWei, "40");
    // A deposit smaller than the ORIGINAL leftover still exceeds the marker.
    assert.equal(latchAllowsFire(latch, 60n, 1_000 + AUTO_CONVERT_COOLDOWN_MS + 1), true);
  });

  it("ratchet is a no-op when balance is at or above the marker", () => {
    const latch = emptyLatch();
    recordFire(latch, 1_000, 100n);
    assert.equal(ratchetMarkerDown(latch, 100n), false);
    assert.equal(ratchetMarkerDown(latch, 150n), false);
  });

  it("manual swap ids are at-most-once", () => {
    const latch = emptyLatch();
    assert.equal(swapIdCompleted(latch, "abc"), false);
    recordSwapId(latch, "abc");
    assert.equal(swapIdCompleted(latch, "abc"), true);
    recordSwapId(latch, "abc"); // idempotent
    assert.equal(latch.completedSwapIds.length, 1);
  });

  it("round-trips through disk; corrupt file is 'never fired'", () => {    const dir = mkdtempSync(path.join(tmpdir(), "ac-"));
    const f = path.join(dir, "auto-convert.json");
    const latch = emptyLatch();
    recordFire(latch, 12345, 777n);
    recordSwapId(latch, "x");
    saveLatch(f, latch);
    const back = loadLatch(f);
    assert.equal(back.firedAtMs, 12345);
    assert.equal(back.consideredWei, "777");
    assert.deepEqual(back.completedSwapIds, ["x"]);

    writeFileSync(f, "not json{{{");
    assert.deepEqual(loadLatch(f), emptyLatch());
    assert.deepEqual(loadLatch(path.join(dir, "missing.json")), emptyLatch());
  });

  it("reserve keeps the max of owner percent and op floor", () => {
    // 10% of 1 ETH at 1 gwei: pct (0.1) beats deployed floor (0.002).
    const r = convertReserve(10n ** 18n, 10n ** 9n, true, 10, false);
    assert.equal(r.reserve, 10n ** 17n);
    assert.equal(r.surplus, 10n ** 18n - 10n ** 17n);
    // 1% of dust: the floor wins, surplus is zero rather than negative.
    const d = convertReserve(1000n, 10n ** 9n, true, 1, false);
    assert.equal(d.reserve, 2_000_000n * 10n ** 9n);
    assert.equal(d.surplus, 0n);
    // Sponsored: tiny drift margin, not a UserOp cost.
    const s = convertReserve(10n ** 18n, 10n ** 9n, true, 10, true);
    assert.equal(s.reserve, 10n ** 17n); // pct still wins here
    const s2 = convertReserve(1000n, 10n ** 9n, false, 1, true);
    assert.equal(s2.reserve, 100_000n * 10n ** 9n);
  });

  it("manual swap requests validate strictly", () => {
    assert.deepEqual(parseManualSwap({ manualSwapWei: "1000", manualSwapId: "a-b_c1" }), {
      wei: 1000n,
      id: "a-b_c1",
    });
    assert.equal(parseManualSwap({ manualSwapWei: "0", manualSwapId: "a" }), null);
    assert.equal(parseManualSwap({ manualSwapWei: "-5", manualSwapId: "a" }), null);
    assert.equal(parseManualSwap({ manualSwapWei: "1.5", manualSwapId: "a" }), null);
    assert.equal(parseManualSwap({ manualSwapWei: "10" }), null);
    assert.equal(parseManualSwap({ manualSwapId: "a" }), null);
    assert.equal(parseManualSwap({ manualSwapWei: "10", manualSwapId: "bad id!" }), null);
  });
});
