/**
 * CUSTOM TOKEN SHAPE — the check a grant path uses before it stops, revokes,
 * or asks for a signature. The wall also filters unusable extras (duplicates,
 * built-ins, the energy reserve); those are not this file. This is only: can
 * the saved entry be a token at all, and if not, which field is wrong.
 *
 * If a later change lets a missing `decimals` pass, or starts describing the
 * second fault before the first, restore can seal a wall that no longer
 * covers a dropped token and never name why. Keep the sentences pinned.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CUSTOM_TOKEN_FAULT_HINT,
  customTokenFault,
  describeCustomTokenFaults,
  isCustomTokenFaultMessage,
  isValidCustomToken,
} from "./tokens";

const address = `0x${"a".repeat(40)}` as const;
const valid = { symbol: "PEPE", address, decimals: 18 };

describe("custom token shape", () => {
  it("accepts a complete ERC-20 entry and nothing else", () => {
    assert.equal(isValidCustomToken(valid), true);
    assert.equal(customTokenFault(valid), null);
    assert.equal(describeCustomTokenFaults(undefined), null);
    assert.equal(describeCustomTokenFaults([]), null);
    assert.equal(describeCustomTokenFaults([valid]), null);
    for (const t of [null, undefined, "PEPE", 18, [], { ...valid, symbol: "" }]) {
      assert.equal(isValidCustomToken(t), false);
    }
  });

  it("names the missing or invalid field, and isValidCustomToken stays in lockstep", () => {
    const missingDecimals = { symbol: "PEPE", address };
    assert.deepEqual(customTokenFault(missingDecimals), { field: "decimals", reason: "is missing decimals" });
    assert.equal(isValidCustomToken(missingDecimals), false);

    const invalidDecimals = { symbol: "PEPE", address, decimals: 18.5 };
    assert.deepEqual(customTokenFault(invalidDecimals), { field: "decimals", reason: "has invalid decimals" });
    assert.equal(isValidCustomToken(invalidDecimals), false);
    assert.equal(isValidCustomToken({ ...valid, decimals: -1 }), false);
    assert.equal(isValidCustomToken({ ...valid, decimals: 37 }), false);
    assert.equal(isValidCustomToken({ ...valid, decimals: "18" }), false);
    assert.equal(isValidCustomToken({ ...valid, decimals: null }), false);

    assert.deepEqual(customTokenFault({ address, decimals: 18 }), { field: "symbol", reason: "is missing symbol" });
    assert.deepEqual(customTokenFault({ symbol: "PEPE!", address, decimals: 18 }), {
      field: "symbol",
      reason: "has an invalid symbol",
    });
    assert.deepEqual(customTokenFault({ symbol: "PEPE", decimals: 18 }), { field: "address", reason: "is missing address" });
    assert.deepEqual(customTokenFault({ symbol: "PEPE", address: "0xabc", decimals: 18 }), {
      field: "address",
      reason: "has an invalid address",
    });
    assert.deepEqual(customTokenFault(null), { field: "entry", reason: "is not a token record" });
  });

  it("describes the first malformed entry and the field, and ignores a later one until that is fixed", () => {
    const later = { symbol: "BAD!", address, decimals: 18 };
    const message = describeCustomTokenFaults([valid, { symbol: "PEPE", address }, later]);
    assert.equal(
      message,
      `Custom token 2 (PEPE) is missing decimals. ${CUSTOM_TOKEN_FAULT_HINT}`,
    );
    assert.equal(isCustomTokenFaultMessage(message), true);
    assert.equal(isCustomTokenFaultMessage("invalid custom tokens"), false);

    const byAddress = { address: `0x${"b".repeat(40)}` };
    assert.equal(
      describeCustomTokenFaults([byAddress]),
      `Custom token 1 (0xbbbb…bbbb) is missing symbol. ${CUSTOM_TOKEN_FAULT_HINT}`,
    );
    assert.equal(
      describeCustomTokenFaults("not-a-list"),
      `Saved custom tokens are not a list. ${CUSTOM_TOKEN_FAULT_HINT}`,
    );
  });
});
