import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canStart, hasCapital, hasGas } from "./can-start";

/**
 * This predicate decides whether an owner is shown the dashboard or held on the
 * fund step, so both directions of being wrong are expensive: hold a working
 * agent's owner and they conclude the product is broken; wave an unfunded one
 * through and they wait for trades that cannot happen.
 *
 * The unsponsored cases are pinned hardest. Sponsorship is off by default and
 * permanently off for any self-hosted install that has not opted in, so those
 * are the paths almost every user is on and they must not move at all.
 */

const eth = (ethWei: string) => ({ balances: { ethWei } });

describe("with no sponsorship — the default, and it must not move", () => {
  it("needs gas, exactly as before", () => {
    assert.equal(canStart(eth("1")), true);
    assert.equal(canStart(eth("0")), false);
    assert.equal(canStart(undefined), false);
    assert.equal(canStart({}), false);
  });

  it("capital alone is NOT enough", () => {
    // Unsponsored, USDG cannot pay a fee. This is the whole two-asset problem
    // and the predicate must keep saying so.
    assert.equal(canStart({ balances: { ethWei: "0", cashUsdg: "500000000" } }), false);
    assert.equal(
      canStart({ balances: { ethWei: "0", cashUsdg: "500000000" }, gasSponsored: false }),
      false,
    );
    assert.equal(
      canStart({ balances: { ethWei: "0", cashUsdg: "500000000" }, gasSponsored: null }),
      false,
    );
  });
});

describe("with sponsorship", () => {
  it("capital is enough, because the fee is not the owner's to pay", () => {
    assert.equal(
      canStart({ balances: { ethWei: "0", cashUsdg: "1" }, gasSponsored: true }),
      true,
    );
  });

  it("counts the VAULT as capital", () => {
    // Idle cash is swept to the vault on the first tick, so an owner who funded
    // and then waited a minute has a zero cash balance and is not unfunded.
    // Missing this would push exactly the people who did everything right back
    // onto the fund step.
    assert.equal(
      canStart({ balances: { ethWei: "0", cashUsdg: "0", vaultUsdg: "250000000" }, gasSponsored: true }),
      true,
    );
  });

  it("still needs SOMETHING — sponsorship is not capital", () => {
    assert.equal(
      canStart({ balances: { ethWei: "0", cashUsdg: "0", vaultUsdg: "0" }, gasSponsored: true }),
      false,
    );
    assert.equal(canStart({ gasSponsored: true }), false);
  });

  it("gas alone still works, sponsored or not", () => {
    assert.equal(canStart({ balances: { ethWei: "5" }, gasSponsored: true }), true);
  });
});

describe("a balance that could not be read is not a balance", () => {
  it("never reads an unread balance as gas or capital", () => {
    // The status route now says null for a chain read that failed, rather
    // than "0". Null must close the gate exactly as zero did — unknown money is
    // not money to start with.
    assert.equal(canStart({ balances: { ethWei: null, cashUsdg: null, vaultUsdg: null }, gasSponsored: true }), false);
    assert.equal(canStart({ balances: { ethWei: null, cashUsdg: "5000000" }, gasSponsored: false }), false);
    assert.equal(hasGas(null), false);
    assert.equal(hasCapital({ cashUsdg: null, vaultUsdg: "1" }), true, "the leg that WAS read still counts");
  });

  it("never reads unparseable capital as funded", () => {
    // Coercing junk here would wave an owner past a funding step they still
    // need.
    for (const v of ["", "nope", "0x", "1.5", "-1"]) {
      assert.equal(
        canStart({ balances: { ethWei: "0", cashUsdg: v }, gasSponsored: true }),
        false,
        `must not accept cashUsdg=${JSON.stringify(v)}`,
      );
    }
  });

  it("hasCapital sums the two legs rather than taking either alone", () => {
    assert.equal(hasCapital({ cashUsdg: "0", vaultUsdg: "0" }), false);
    assert.equal(hasCapital({ cashUsdg: "0", vaultUsdg: "1" }), true);
    assert.equal(hasCapital({ cashUsdg: "1", vaultUsdg: "0" }), true);
    assert.equal(hasCapital(undefined), false);
  });

  it("hasGas keeps its original lenient fallback", () => {
    // Deliberately unchanged: this is the arm that gates the UNSPONSORED path,
    // and tightening it would move behaviour for every deployment.
    assert.equal(hasGas("1"), true);
    assert.equal(hasGas("0"), false);
    assert.equal(hasGas(undefined), false);
    assert.equal(hasGas("1.5"), true, "BigInt throws, Number() catches it — as it always did");
  });
});
