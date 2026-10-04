import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertReserve } from "./convert-reserve";

describe("convertReserve", () => {
  it("keeps the max of owner percent and op floor", () => {
    // 10% of 1 ETH at 1 gwei: pct (0.1) beats deployed floor (0.002).
    const r = convertReserve(10n ** 18n, 10n ** 9n, true, 10, false);
    assert.equal(r.reserve, 10n ** 17n);
    assert.equal(r.surplus, 10n ** 18n - 10n ** 17n);
    // 1% of dust: the floor wins, surplus is zero rather than negative.
    const d = convertReserve(1000n, 10n ** 9n, true, 1, false);
    assert.equal(d.reserve, 2_000_000n * 10n ** 9n);
    assert.equal(d.surplus, 0n);
    // Sponsored: tiny drift margin, not a UserOp cost.
    const s2 = convertReserve(1000n, 10n ** 9n, false, 1, true);
    assert.equal(s2.reserve, 100_000n * 10n ** 9n);
  });
});
