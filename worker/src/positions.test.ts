import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { positionValueUsdg } from "./positions";

const ONE = 10n ** 18n; // 1.0 in both raw-balance (18dp) and multiplier terms
const usd = (v: number) => BigInt(Math.round(v * 1e8)); // Chainlink 8dp

describe("positionValueUsdg (ERC-8056)", () => {
  it("values a whole share at multiplier 1.0", () => {
    // 1 AAPL raw × 1.0 × $250 = 250 USDG (6dp)
    const v = positionValueUsdg({ rawBalance: ONE, uiMultiplier: ONE, price8: usd(250) });
    assert.equal(v, 250_000_000n);
  });

  it("values fractional holdings", () => {
    // 0.5 shares × 1.0 × $100 = 50 USDG
    const v = positionValueUsdg({ rawBalance: ONE / 2n, uiMultiplier: ONE, price8: usd(100) });
    assert.equal(v, 50_000_000n);
  });

  it("a 2-for-1 split is NOT a crash: multiplier doubles, price halves, value unchanged", () => {
    const before = positionValueUsdg({ rawBalance: ONE, uiMultiplier: ONE, price8: usd(500) });
    const after = positionValueUsdg({ rawBalance: ONE, uiMultiplier: 2n * ONE, price8: usd(250) });
    assert.equal(before, after);
    assert.equal(after, 500_000_000n);
  });

  it("ignoring the multiplier WOULD have looked like a 50% crash (the bug this prevents)", () => {
    const naiveAfterSplit = positionValueUsdg({ rawBalance: ONE, uiMultiplier: ONE, price8: usd(250) });
    assert.equal(naiveAfterSplit, 250_000_000n); // half of the true 500
  });

  it("a 10% stock dividend scales value by the multiplier", () => {
    const v = positionValueUsdg({
      rawBalance: ONE,
      uiMultiplier: (11n * ONE) / 10n,
      price8: usd(100),
    });
    assert.equal(v, 110_000_000n);
  });

  it("zero balance is zero value", () => {
    assert.equal(positionValueUsdg({ rawBalance: 0n, uiMultiplier: ONE, price8: usd(999) }), 0n);
  });

  it("keeps precision on realistic dust (0.0342092 QQQ @ $575.31)", () => {
    const raw = 34_209_200_024_468_519n; // ~0.0342 in 18dp
    const v = positionValueUsdg({ rawBalance: raw, uiMultiplier: ONE, price8: usd(575.31) });
    // 0.034209200024468519 × 575.31 = 19.680894866… → floors to 19.680894 USDG
    assert.equal(v, 19_680_894n);
  });
});
