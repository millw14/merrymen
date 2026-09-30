/**
 * A GRANT THAT CANNOT BE INSTALLED MUST BE REFUSED AT SIGNING TIME.
 *
 * Kernel's CallPolicy refuses a repeated (callType, target, selector), so a
 * grant carrying one reverts at validation — `AA23 duplicate permissionHash` —
 * on every operation forever. The agent still looks armed, the wall still
 * looks sealed, and nothing downstream names the cause.
 *
 * It cost three re-signs to find, because the wall is built in the SIGNING
 * CLIENT: an owner with a browser tab open from before a deploy seals the old
 * wall, and the server stored it without a word. These pin the check that turns
 * that into one sentence.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { duplicateWallPermissions } from "./grant-installable";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const APPROVE = "0x095ea7b3";
const TRANSFER = "0xa9059cbb";

const encode = (permissions: unknown[]) =>
  Buffer.from(
    JSON.stringify({
      permissionParams: {
        policies: [
          { policyParams: { type: "timestamp", validUntil: 1, validAfter: 0 } },
          { policyParams: { type: "call", permissions } },
        ],
      },
    }),
  ).toString("base64");

const perm = (target: string, selector: string, callType = "0x00") => ({ callType, target, selector });

describe("the duplicate that makes a grant uninstallable", () => {
  it("catches the exact wall that was stuck in production", () => {
    // Two USDG approves: the Trencher one scoped to the vault, and the router
    // one scoped to the spender list. Different args, same on-chain key.
    const found = duplicateWallPermissions(
      encode([perm(USDG, APPROVE), perm("0x2222222222222222222222222222222222222222", "0xaabbccdd"), perm(USDG, APPROVE)]),
    );
    assert.equal(found.length, 1);
    assert.match(found[0]!, /5fc5360d/);
    assert.match(found[0]!, /095ea7b3/);
    assert.match(found[0]!, /×2/);
  });

  it("passes a wall where the same target carries DIFFERENT selectors", () => {
    // USDG approve + USDG transfer is legitimate and common — a withdrawal
    // address makes it the normal shape. Refusing it would break every grant.
    assert.deepEqual(duplicateWallPermissions(encode([perm(USDG, APPROVE), perm(USDG, TRANSFER)])), []);
  });

  it("is case-insensitive about addresses and selectors", () => {
    // The chain hashes bytes; JSON carries whatever casing the client used, and
    // a checksummed address must not read as a different permission.
    const found = duplicateWallPermissions(
      encode([perm(USDG.toLowerCase(), APPROVE), perm(USDG.toUpperCase().replace("0X", "0x"), APPROVE.toUpperCase().replace("0X", "0x"))]),
    );
    assert.equal(found.length, 1);
  });

  it("separates entries that differ only by callType", () => {
    // callType is part of the key, so CALL and DELEGATECALL on one target are
    // two permissions, not a duplicate.
    assert.deepEqual(duplicateWallPermissions(encode([perm(USDG, APPROVE, "0x00"), perm(USDG, APPROVE, "0x01")])), []);
  });

  it("catches two entries that BOTH omit a selector", () => {
    // They fold to the same 0x00000000 on chain. Skipping fieldless entries
    // would hide precisely the case that is hardest to spot by eye.
    const found = duplicateWallPermissions(encode([{ target: USDG }, { target: USDG }]));
    assert.equal(found.length, 1);
    assert.match(found[0]!, /0x00000000/);
  });
});

describe("what it refuses to have an opinion about", () => {
  // A shape it cannot read must never block an owner from signing. The checks
  // that own a grant's validity are elsewhere; this one exists only to catch a
  // condition that is unambiguously fatal.
  it("says nothing about input it cannot decode", () => {
    for (const bad of ["", "not base64 at all !!!", Buffer.from("{").toString("base64"), undefined, null, 42, {}]) {
      assert.deepEqual(duplicateWallPermissions(bad as never), [], `${String(bad)} must not be refused`);
    }
  });

  it("says nothing when there is no call policy", () => {
    const noCall = Buffer.from(
      JSON.stringify({ permissionParams: { policies: [{ policyParams: { type: "timestamp" } }] } }),
    ).toString("base64");
    assert.deepEqual(duplicateWallPermissions(noCall), []);
  });

  it("says nothing about a valid empty wall", () => {
    assert.deepEqual(duplicateWallPermissions(encode([])), []);
  });
});
