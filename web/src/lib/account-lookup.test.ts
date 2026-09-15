import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasValue, verdictOf, type Lookup, type Reading } from "./account-lookup";

/**
 * THE SENTENCE IS THE PRODUCT.
 *
 * Someone reaches this page because they think their money is gone. The
 * balances are the easy half; the hard half is telling them which of three
 * addresses they are holding, and the difference between "empty" and "we could
 * not read it" — which is the difference between a bad afternoon and concluding
 * that funds are lost. So the wording is chosen by a pure function and pinned
 * here, rather than by whichever branch of some JSX happened to match.
 */

const ADDR = "0x8e93bad5a60a266b4283855ceffa0979720aed72" as const;
const DERIVED = "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487" as const;

const reading = (o: Partial<Reading> = {}): Reading => ({
  address: DERIVED,
  deployed: false,
  nativeWei: 0n,
  holdings: [],
  unreadable: [],
  ...o,
});

const held = () => [
  { symbol: "DOGGOS", address: "0x15e498ff2dbca95e8648a1f025cbbd12c2525461" as const, raw: 1n, decimals: 6, amount: "1.0" },
];

const lookup = (o: Partial<Lookup> = {}): Lookup => ({
  input: ADDR,
  chainId: 4663,
  asOwner: null,
  ownerError: null,
  asAccount: reading({ address: ADDR }),
  accountError: null,
  ...o,
});

const withOwner = (r: Reading, classHoldings: Lookup["asOwner"] extends null ? never : never[] = []) => ({
  derived: DERIVED as `0x${string}`,
  reading: r,
  classVault: null,
  classHoldings,
});

describe("hasValue separates held from not held", () => {
  it("counts tokens and native, and nothing else", () => {
    assert.equal(hasValue(reading()), false);
    assert.equal(hasValue(reading({ holdings: held() })), true);
    assert.equal(hasValue(reading({ nativeWei: 1n })), true);
    // Unreadable is not the same as held — it must not fake a balance.
    assert.equal(hasValue(reading({ unreadable: ["USDG"] })), false);
    assert.equal(hasValue(null), false);
  });
});

describe("the verdict names which address this is", () => {
  it("calls it an owner when the DERIVED account holds something", () => {
    const l = lookup({ asOwner: withOwner(reading({ holdings: held() })) });
    assert.equal(verdictOf(l).kind, "owner");
  });

  it("counts a class vault holding as the owner having something", () => {
    // The vault is a separate contract the ACCOUNT does not hold, and it is
    // where a launchpad position actually sits. Ignoring it would tell an owner
    // whose whole book is class positions that their account is empty — which
    // is the exact failure `recoverFunds` was patched for.
    const l = lookup({
      asOwner: {
        derived: DERIVED,
        reading: reading(),
        classVault: "0x3fcdde6e011769ca05f0115f1543290862473216",
        classHoldings: held(),
      },
    });
    assert.equal(verdictOf(l).kind, "owner");
  });

  it("calls it an account when the address itself holds something", () => {
    const l = lookup({ asAccount: reading({ address: ADDR, holdings: held() }) });
    assert.equal(verdictOf(l).kind, "account");
  });

  it("says both when both readings find something", () => {
    const l = lookup({
      asOwner: withOwner(reading({ holdings: held() })),
      asAccount: reading({ address: ADDR, holdings: held() }),
    });
    assert.equal(verdictOf(l).kind, "both");
  });
});

describe("empty and unknown are different answers", () => {
  it("reports unreadable rather than empty when a balance could not be read", () => {
    // The whole reason `classifyBalance` is three-way. An RPC that blinked must
    // never render as "nothing here".
    const l = lookup({ asAccount: reading({ address: ADDR, unreadable: ["USDG"] }) });
    assert.equal(verdictOf(l).kind, "unreadable");
  });

  it("reports unreadable when BOTH readings failed outright", () => {
    const l = lookup({ asAccount: null, accountError: "rpc down", ownerError: "rpc down" });
    assert.equal(verdictOf(l).kind, "unreadable");
  });

  it("distinguishes an account that was used and emptied from one that never existed", () => {
    const used = lookup({ asAccount: reading({ address: ADDR, deployed: true }) });
    assert.equal(verdictOf(used).kind, "empty-deployed");

    const never = lookup({ asOwner: withOwner(reading({ deployed: false })) });
    assert.equal(verdictOf(never).kind, "nothing");
  });

  it("treats a SIGN-IN wallet as nothing, which is the case that needs explaining", () => {
    // A tenant address derives an account that was never created. This must not
    // read as "empty account" — the honest answer is that no agent was ever
    // made from it, and the person is holding the wrong address.
    const l = lookup({
      asOwner: withOwner(reading({ deployed: false })),
      asAccount: reading({ address: ADDR, deployed: false }),
    });
    const v = verdictOf(l);
    assert.equal(v.kind, "nothing");
  });

  it("prefers a real balance over any explanation", () => {
    // An unreadable token alongside a real holding is still an account with
    // money in it; the warning belongs on the card, not in place of the answer.
    const l = lookup({ asAccount: reading({ address: ADDR, holdings: held(), unreadable: ["USDG"] }) });
    assert.equal(verdictOf(l).kind, "account");
  });
});
