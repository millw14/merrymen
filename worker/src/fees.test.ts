import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accrueAboveHwm } from "./fees";

const U = (v: number) => BigInt(Math.round(v * 1e6)); // USDG 6dp

describe("accrueAboveHwm", () => {
  it("first profit sets the HWM and accrues the fee", () => {
    const a = accrueAboveHwm(U(1100), U(1000), 1000); // 10%
    assert.equal(a.profitUsdg, U(100));
    assert.equal(a.feeUsdg, U(10));
    assert.equal(a.newHwmUsdg, U(1100));
  });

  it("no fee when flat", () => {
    const a = accrueAboveHwm(U(1000), U(1000), 1000);
    assert.equal(a.feeUsdg, 0n);
    assert.equal(a.newHwmUsdg, U(1000));
  });

  it("no fee under water, HWM untouched", () => {
    const a = accrueAboveHwm(U(900), U(1000), 1000);
    assert.equal(a.feeUsdg, 0n);
    assert.equal(a.profitUsdg, 0n);
    assert.equal(a.newHwmUsdg, U(1000));
  });

  it("recovering to the old peak accrues nothing — only NEW highs pay", () => {
    // drawdown to 900, recover to exactly 1000: no fee
    const recover = accrueAboveHwm(U(1000), U(1000), 1000);
    assert.equal(recover.feeUsdg, 0n);
    // then a new high at 1050: fee only on the 50 above the old peak
    const newHigh = accrueAboveHwm(U(1050), U(1000), 1000);
    assert.equal(newHigh.profitUsdg, U(50));
    assert.equal(newHigh.feeUsdg, U(5));
  });

  it("sequential accruals never double-charge the same profit", () => {
    let hwm = U(1000);
    let total = 0n;
    for (const eq of [1100, 1050, 1100, 1200]) {
      const a = accrueAboveHwm(U(eq), hwm, 1000);
      hwm = a.newHwmUsdg;
      total += a.feeUsdg;
    }
    // Total profit above running peak: 100 (→1100) + 100 (1100→1200) = 200 → fee 20
    assert.equal(total, U(20));
    assert.equal(hwm, U(1200));
  });

  it("zero fee bps accrues nothing but still ratchets the HWM", () => {
    const a = accrueAboveHwm(U(1100), U(1000), 0);
    assert.equal(a.feeUsdg, 0n);
    assert.equal(a.newHwmUsdg, U(1100));
  });

  it("rejects out-of-range fee bps", () => {
    assert.throws(() => accrueAboveHwm(U(1), 0n, -1));
    assert.throws(() => accrueAboveHwm(U(1), 0n, 10_000));
    assert.throws(() => accrueAboveHwm(U(1), 0n, 12.5));
  });
});
