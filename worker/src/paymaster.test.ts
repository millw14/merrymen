import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PAYMASTER_GAS_MAX,
  PAYMASTER_POSTOP_GAS,
  PAYMASTER_VERIFICATION_GAS,
  SponsorRefused,
  assertBoundsHeld,
} from "./paymaster";

/**
 * The sponsor is an untrusted party that picks numbers WE pay for — or rather,
 * that the house pays for, which is worse, because the account that would feel
 * an out-of-gas is not the account being charged.
 *
 * These tests are about the two things that make sponsorship safe to attach: the
 * limits we bounded survive it, and a refusal is a typed pre-broadcast event
 * rather than a free-form string in a column with a small vocabulary.
 */

describe("the bounds we signed must survive the sponsor", () => {
  const bounded = {
    callGasLimit: 200_000n,
    verificationGasLimit: 150_000n,
    preVerificationGas: 60_000n,
  };

  it("passes when the prepared operation reports our numbers back", () => {
    assert.doesNotThrow(() =>
      assertBoundsHeld(bounded, {
        callGasLimit: 200_000n,
        verificationGasLimit: 150_000n,
        preVerificationGas: 60_000n,
      }),
    );
  });

  it("passes when the fields are not reported at all", () => {
    // Absence is not contradiction. A check that treated a missing field as a
    // failure would refuse every operation on a bundler that simply echoes less.
    assert.doesNotThrow(() => assertBoundsHeld(bounded, {}));
  });

  it("REFUSES when the sponsor lowered a limit — the out-of-gas case", () => {
    // The dangerous direction. An under-provisioned operation does not bounce:
    // the EntryPoint runs it, the inner call runs out of gas, and it is charged
    // in full. Under sponsorship the payer of that is the house.
    assert.throws(
      () => assertBoundsHeld(bounded, { callGasLimit: 21_000n }),
      (e: unknown) => e instanceof SponsorRefused && e.rule === "sponsor-absurd",
    );
  });

  it("REFUSES when the sponsor raised a limit", () => {
    // Also refused, and not out of symmetry: gas-limits.ts exists so that no
    // number nobody checked is ever signed. A sponsor that raises one has
    // replaced our arithmetic with its own.
    assert.throws(
      () => assertBoundsHeld(bounded, { verificationGasLimit: 900_000n }),
      (e: unknown) => e instanceof SponsorRefused,
    );
  });

  it("reads hex, because that is what an RPC actually returns", () => {
    assert.doesNotThrow(() => assertBoundsHeld(bounded, { callGasLimit: "0x30d40" }));
    assert.throws(
      () => assertBoundsHeld(bounded, { callGasLimit: "0x5208" }),
      (e: unknown) => e instanceof SponsorRefused,
    );
  });

  it("ignores junk rather than treating it as a mismatch", () => {
    // A field we cannot parse is a field we cannot contradict. Refusing here
    // would turn an unfamiliar reply shape into a trading outage.
    assert.doesNotThrow(() => assertBoundsHeld(bounded, { callGasLimit: null }));
    assert.doesNotThrow(() => assertBoundsHeld(bounded, { callGasLimit: "not a number" }));
  });
});

describe("SponsorRefused carries a rule from a fixed vocabulary", () => {
  it("names the three ways a sponsor says no", () => {
    // The whole point of the type: without it these land in the generic submit
    // catch as `status: "reverted"` with a free-form reject_rule — a ledger row
    // asserting the chain refused a trade the chain never saw.
    for (const rule of ["sponsor-refused", "sponsor-unreachable", "sponsor-absurd"] as const) {
      const e = new SponsorRefused(rule, "because");
      assert.equal(e.rule, rule);
      assert.equal(e.name, "SponsorRefused");
      assert.ok(e instanceof Error);
    }
  });
});

describe("the paymaster gas ceiling", () => {
  it("leaves room for a real approve+swap and refuses well below absurd", () => {
    // Sized against gas-limits.ts's 3,000,000 total ceiling: the two paymaster
    // fields together must not be able to eat it.
    assert.ok(PAYMASTER_VERIFICATION_GAS < PAYMASTER_GAS_MAX);
    assert.ok(PAYMASTER_POSTOP_GAS < PAYMASTER_GAS_MAX);
    assert.ok(PAYMASTER_GAS_MAX * 2n < 3_000_000n, "two paymaster fields must not exhaust the op ceiling");
  });
});
