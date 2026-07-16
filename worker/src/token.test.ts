import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CIRCLE_TIERS,
  effectivePerfFeeBps,
  nextTier,
  tierForBalance,
  wholeTokens,
} from "../../packages/core/src/token";

/** raw 18-dp balance for a whole-token count. */
const T = (whole: number) => BigInt(whole) * 10n ** 18n;

describe("Merry Circle tiers", () => {
  it("tiers are sorted ascending by minTokens (tierForBalance relies on it)", () => {
    for (let i = 1; i < CIRCLE_TIERS.length; i++) {
      assert.ok(CIRCLE_TIERS[i]!.minTokens > CIRCLE_TIERS[i - 1]!.minTokens);
    }
  });

  it("no holdings → outsider (never null)", () => {
    assert.equal(tierForBalance(0n).id, "outsider");
    assert.equal(tierForBalance(T(9_999)).id, "outsider");
  });

  it("maps balances to the highest tier they qualify for", () => {
    assert.equal(tierForBalance(T(10_000)).id, "villager");
    assert.equal(tierForBalance(T(99_999)).id, "villager");
    assert.equal(tierForBalance(T(100_000)).id, "merryman");
    assert.equal(tierForBalance(T(999_999)).id, "merryman");
    assert.equal(tierForBalance(T(1_000_000)).id, "lord");
    assert.equal(tierForBalance(T(50_000_000)).id, "lord");
  });

  it("the fee discount actually lowers the effective fee", () => {
    const base = 1_000; // 10%
    assert.equal(effectivePerfFeeBps(base, tierForBalance(0n)), 1_000); // outsider: no change
    assert.equal(effectivePerfFeeBps(base, tierForBalance(T(10_000))), 900); // villager: 10% off
    assert.equal(effectivePerfFeeBps(base, tierForBalance(T(100_000))), 750); // merryman: 25% off
    assert.equal(effectivePerfFeeBps(base, tierForBalance(T(1_000_000))), 500); // lord: 50% off
  });

  it("only the top tiers unlock bonus strategies", () => {
    assert.equal(tierForBalance(0n).bonusStrategies, false);
    assert.equal(tierForBalance(T(10_000)).bonusStrategies, false);
    assert.equal(tierForBalance(T(100_000)).bonusStrategies, true);
    assert.equal(tierForBalance(T(1_000_000)).bonusStrategies, true);
  });

  it("nextTier walks up and stops at the top", () => {
    assert.equal(nextTier(tierForBalance(0n))?.id, "villager");
    assert.equal(nextTier(tierForBalance(T(10_000)))?.id, "merryman");
    assert.equal(nextTier(tierForBalance(T(100_000)))?.id, "lord");
    assert.equal(nextTier(tierForBalance(T(1_000_000))), null);
  });

  it("wholeTokens floors the 18-dp balance", () => {
    assert.equal(wholeTokens(T(1_234)), 1_234);
    assert.equal(wholeTokens(T(1) - 1n), 0); // just under one whole token
  });
});
