import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountIndexForPurpose, bindingMessage, grantPurpose, publicGrantView } from "./grant";
const claim = { origin: "https://merrymen.dev", nonce: "nonce", owner: "0x0000000000000000000000000000000000000011", smartAccount: "0x0000000000000000000000000000000000000022", chainId: 4663 } as const;
describe("independent signed account purposes", () => {
 it("keeps legacy claims byte-identical while binding Perps claims to their purpose in both login models", () => {
  for (const c of [claim, { ...claim, version: "privy-did-owner-v1" as const, did: "did:privy:owner" }]) {
   assert.equal(bindingMessage(c), bindingMessage({ ...c, purpose: "spot" }));
   assert.doesNotMatch(bindingMessage(c), /Account purpose/);
   assert.match(bindingMessage({ ...c, purpose: "perps" }), /Account purpose: perps/);
   assert.notEqual(bindingMessage(c), bindingMessage({ ...c, purpose: "perps" }));
  }
 });
 it("assigns the old account index only to Spot and refuses unknown purposes", () => {
  assert.equal(grantPurpose({}), "spot");
  assert.equal(accountIndexForPurpose(), 0n);
  assert.equal(accountIndexForPurpose("perps"), 1n);
  assert.throws(() => grantPurpose({ purpose: "other" }), /purpose/);
  assert.throws(() => bindingMessage({ ...claim, purpose: "other" as never }), /purpose/);
 });
 it("shows only valid nonsecret purposes through the public allowlist", () => {
  assert.deepEqual(publicGrantView({ purpose: "perps", secret: "never" }), { purpose: "perps" });
  assert.deepEqual(publicGrantView({ purpose: "unexpected-secret" }), {});
  assert.deepEqual(publicGrantView({}), {});
 });
});
