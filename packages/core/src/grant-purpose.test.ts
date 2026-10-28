/**
 * ONE OWNER KEY, TWO WALLETS. The purpose a grant names decides which Kernel
 * account it is for, and it is bound into the signed claim. Spot is what
 * every grant made before Perps already is, so nothing about Spot may move.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountIndexForPurpose, bindingMessage, grantPurpose, isGrantPurpose, publicGrantView, type BindingClaim } from "./grant";

const claim = {
  origin: "https://app.merrymen.dev",
  nonce: "n-1",
  owner: "0x00000000000000000000000000000000000000AA",
  smartAccount: "0x00000000000000000000000000000000000000BB",
  chainId: 4663,
} as const;
const both: BindingClaim[] = [claim, { ...claim, version: "privy-did-owner-v1", did: "did:privy:owner" }];

describe("wallet purpose", () => {
  it("absent is Spot; an unrecognised purpose is refused, never read as Spot", () => {
    assert.equal(grantPurpose({}), "spot");
    assert.equal(grantPurpose(null), "spot");
    assert.equal(grantPurpose({ purpose: "spot" }), "spot");
    assert.equal(grantPurpose({ purpose: "perps" }), "perps");
    for (const purpose of ["Perps", "", "solana", 1, null]) {
      assert.throws(() => grantPurpose({ purpose }), /wallet purpose/, String(purpose));
      assert.equal(isGrantPurpose(purpose), false);
    }
  });

  it("Spot keeps Kernel's default index 0, and Perps is index 1", () => {
    assert.equal(accountIndexForPurpose("spot"), 0n);
    assert.equal(accountIndexForPurpose("perps"), 1n);
    assert.throws(() => accountIndexForPurpose("other" as never), /wallet purpose/);
  });

  it("the Spot claim text is byte for byte what it was, under both binding versions", () => {
    for (const c of both) {
      const text = bindingMessage(c);
      assert.equal(bindingMessage({ ...c, purpose: "spot" }), text);
      assert.doesNotMatch(text, /purpose/i);
    }
    // The legacy text, frozen: a signature is over these exact bytes.
    assert.equal(
      bindingMessage(claim),
      [
        "https://app.merrymen.dev wants you to authorize a merrymen agent account.",
        "",
        "You are linking the agent wallet below to this login. It moves no funds.",
        "",
        "Agent account: 0x00000000000000000000000000000000000000bb",
        "Owner key: 0x00000000000000000000000000000000000000aa",
        "Chain ID: 4663",
        "URI: https://app.merrymen.dev",
        "Nonce: n-1",
      ].join("\n"),
    );
  });

  it("a Perps claim names its wallet in the signed text, so a Spot signature cannot be replayed as one", () => {
    for (const c of both) {
      const perps = bindingMessage({ ...c, purpose: "perps" });
      assert.match(perps, /\nAccount purpose: perps\nURI: /);
      assert.notEqual(perps, bindingMessage(c));
    }
    assert.throws(() => bindingMessage({ ...claim, purpose: "other" as never }), /wallet purpose/);
  });

  it("the public view shows a recognised purpose and nothing else under that name", () => {
    assert.deepEqual(publicGrantView({ purpose: "perps" }), { purpose: "perps" });
    assert.deepEqual(publicGrantView({ purpose: "0x" + "ab".repeat(32) }), {});
    assert.deepEqual(publicGrantView({}), {});
  });
});
