/**
 * WHICH SECURITY MODEL A CLAIM WAS MADE UNDER, AND WHY IT IS NEVER GUESSED.
 *
 * Merrymen is about to have two ways of proving the same two facts:
 *
 *   legacy-wallet-owner-v1  the login wallet signs, and a SEPARATE browser-held
 *                           owner key co-signs. Authentication and owner
 *                           authority come from two different keys.
 *   privy-did-owner-v1      a verified Privy access token carries the identity,
 *                           and the embedded owner wallet signs the challenge.
 *                           One key may be both anchor and owner; the proofs
 *                           are still separate, because one of them is a token
 *                           the server verified.
 *
 * A validator that tried to serve both from one shape would have to decide, per
 * request, which evidence it was looking at — and the wrong guess in either
 * direction is a downgrade. The dangerous one is specific and silent: under
 * Privy the owner and the identity anchor can be the same key, so a single
 * signature would satisfy BOTH arms of the legacy check, and every existing
 * test would still pass. That is the case this file exists to make loud.
 *
 * Real viem signatures, no mocks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEFAULT_BINDING_VERSION, bindingMessage, isBindingVersion } from "@merrymen/core";

process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";

import { issueChallengeNonce, verifyGrantBinding } from "./auth";

const ORIGIN = "https://app.merrymen.dev";
const SMART = "0x00000000000000000000000000000000000000a1" as `0x${string}`;
const CHAIN = 4663;

type Signer = ReturnType<typeof privateKeyToAccount>;

/** A legacy claim: the wallet authorizes, the owner key co-signs the same text. */
async function legacyClaim(wallet: Signer, owner: Signer, version?: unknown) {
  const nonce = issueChallengeNonce(ORIGIN);
  const message = bindingMessage({
    origin: ORIGIN,
    nonce,
    owner: owner.address,
    smartAccount: SMART,
    chainId: CHAIN,
  });
  return {
    origin: ORIGIN,
    tenant: wallet.address.toLowerCase() as `0x${string}`,
    nonce,
    owner: owner.address,
    smartAccount: SMART,
    chainId: CHAIN,
    walletSignature: await wallet.signMessage({ message }),
    ownerSignature: await owner.signMessage({ message }),
    ...(version === undefined ? {} : { version }),
  };
}

test("an absent version is legacy — by history, not by falling through a default", async () => {
  // Every grant signed before the field existed was made under the
  // two-signature model, because it was the only model there was. And the
  // default resolves to the STRICTER of the two, so a mistake here costs a
  // refusal rather than an acceptance.
  assert.equal(DEFAULT_BINDING_VERSION, "legacy-wallet-owner-v1");
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const r = await verifyGrantBinding(await legacyClaim(wallet, owner));
  assert.equal(r.ok, true, r.ok === false ? r.why : "");
});

test("naming the legacy version explicitly verifies identically", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const r = await verifyGrantBinding(await legacyClaim(wallet, owner, "legacy-wallet-owner-v1"));
  assert.equal(r.ok, true, r.ok === false ? r.why : "");
});

test("A VERSION THIS DEPLOYMENT DOES NOT KNOW IS REFUSED, never best-guessed", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  for (const bogus of ["privy-v2", "legacy", "", 1, {}, [], true]) {
    const r = await verifyGrantBinding(await legacyClaim(wallet, owner, bogus));
    assert.equal(r.ok, false, `version ${JSON.stringify(bogus)} must be refused`);
    assert.match(r.ok === false ? r.why : "", /binding version/);
  }
});

test("a privy binding is refused until the deployment can verify one", async () => {
  // The failure direction that matters: an unimplemented arm must NOT fall back
  // to the legacy one, which would read a single owner signature as if it were
  // two independent proofs.
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const r = await verifyGrantBinding(await legacyClaim(wallet, owner, "privy-did-owner-v1"));
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /privy bindings are not enabled/);
});

test("ONE KEY SIGNING TWICE IS NOT TWO PROOFS", async () => {
  // The silent collapse. If the login wallet and the owner key are the same
  // key, both recoveries land on the same address and the arithmetic passes —
  // while the co-signature that makes a legacy claim unforgeable was never
  // made. Note what is NOT asserted here: there is no global rule that an owner
  // may never equal a tenant. `privy-did-owner-v1` allows exactly that, and
  // gets its authentication from a verified token instead.
  const both = privateKeyToAccount(generatePrivateKey());
  const claim = await legacyClaim(both, both);
  // Both signatures verify against their own addresses — the old checks pass:
  assert.equal(claim.walletSignature, claim.ownerSignature);
  const r = await verifyGrantBinding(claim);
  assert.equal(r.ok, false);
  const why = r.ok === false ? r.why : "";
  assert.match(why, /one proof where it needs two/);
  // And it says what to DO. A refusal on a fund-access path that only describes
  // the cause leaves the user with a permanently unusable agent and no next
  // step — which is how a correct check becomes an outage.
  assert.match(why, /create a new agent and sweep the old one/);
});

test("a legacy claim with no wallet signature is refused, not treated as a privy claim", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const claim = await legacyClaim(wallet, owner);
  const { walletSignature: _drop, ...withoutWallet } = claim;
  const r = await verifyGrantBinding(withoutWallet as typeof claim);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /missing the login signature/);
});

test("the two versions sign DIFFERENT text, so neither signature replays as the other", () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const common = {
    origin: ORIGIN,
    nonce: "n",
    owner: owner.address,
    smartAccount: SMART,
    chainId: CHAIN,
  } as const;
  const legacy = bindingMessage(common);
  const privy = bindingMessage({
    ...common,
    version: "privy-did-owner-v1",
    did: "did:privy:cabc123",
  });
  assert.notEqual(legacy, privy);
  // The DID is IN the privy text. Without it the owner signature would name no
  // identity and would verify just as well under somebody else's login.
  assert.match(privy, /Identity: did:privy:cabc123/);
  assert.doesNotMatch(legacy, /Identity:/);
});

test("the legacy message text is frozen, byte for byte", () => {
  // Grants signed by a browser that has not reloaded are still in flight, and a
  // signature is over the exact bytes. This literal is the contract.
  const text = bindingMessage({
    origin: ORIGIN,
    nonce: "NONCE",
    owner: "0x00000000000000000000000000000000000000b2",
    smartAccount: SMART,
    chainId: CHAIN,
  });
  assert.equal(
    text,
    [
      "https://app.merrymen.dev wants you to authorize a merrymen agent account.",
      "",
      "You are linking the agent wallet below to this login. It moves no funds.",
      "",
      "Agent account: 0x00000000000000000000000000000000000000a1",
      "Owner key: 0x00000000000000000000000000000000000000b2",
      "Chain ID: 4663",
      "URI: https://app.merrymen.dev",
      "Nonce: NONCE",
    ].join("\n"),
  );
});

test("isBindingVersion admits exactly the two shapes and nothing else", () => {
  assert.equal(isBindingVersion("legacy-wallet-owner-v1"), true);
  assert.equal(isBindingVersion("privy-did-owner-v1"), true);
  for (const no of [undefined, null, "", "legacy", "privy", 0, {}, []]) {
    assert.equal(isBindingVersion(no), false, JSON.stringify(no));
  }
});
