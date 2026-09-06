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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BINDING_VERSION, bindingMessage, isBindingVersion } from "@merrymen/core";

process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";

import { ENFORCE_LEGACY_TWO_PROOF, issueChallengeNonce, verifyGrantBinding } from "./auth";

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

test("A PRIVY BINDING WITHOUT A VERIFIED TOKEN IS REFUSED", async () => {
  // The validator holds no Privy credential and verifies no token — it is
  // HANDED the DID by the route that did. So a caller that forgot to verify
  // gets a refusal, never a binding checked with its authentication half
  // missing. That is the failure direction that matters: the privy arm must
  // not degrade into "one owner signature was enough".
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const r = await verifyGrantBinding({
    ...(await legacyClaim(wallet, owner, "privy-did-owner-v1")),
    did: "did:privy:someone",
    // verifiedDid deliberately absent — the route did not verify a token.
  });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /needs a verified privy identity/);
});

test("a privy binding whose claimed DID differs from the verified one is refused", async () => {
  // The grant echoes the DID so the signed text can be rebuilt. It is never an
  // identity — it is compared, and any difference is a refusal.
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const r = await verifyGrantBinding({
    ...(await legacyClaim(wallet, owner, "privy-did-owner-v1")),
    did: "did:privy:attacker",
    verifiedDid: "did:privy:victim",
  });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /different identity than the one that signed in/);
});

test("a privy binding whose owner is not the signed-in tenant is refused", async () => {
  // Under this version the embedded wallet is BOTH the login and the owner —
  // that is the model, and it is why the version exists separately. What must
  // hold is that the owner IS the tenant the DID resolved to, or a verified
  // login could install a grant on an owner it does not control.
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const did = "did:privy:same";
  const r = await verifyGrantBinding({
    ...(await legacyClaim(wallet, owner, "privy-did-owner-v1")),
    did,
    verifiedDid: did,
  });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /not the wallet you signed in with/);
});

test("A COMPLETE PRIVY BINDING VERIFIES — token, matching DID, owner-is-tenant", async () => {
  const embedded = privateKeyToAccount(generatePrivateKey());
  const did = "did:privy:clbeta0001";
  const nonce = issueChallengeNonce(ORIGIN);
  const message = bindingMessage({
    version: "privy-did-owner-v1",
    origin: ORIGIN,
    nonce,
    owner: embedded.address,
    smartAccount: SMART,
    chainId: CHAIN,
    did,
  });
  const r = await verifyGrantBinding({
    origin: ORIGIN,
    // tenant IS the embedded wallet: what the auth route minted the session for.
    tenant: embedded.address.toLowerCase() as `0x${string}`,
    nonce,
    owner: embedded.address,
    smartAccount: SMART,
    chainId: CHAIN,
    ownerSignature: await embedded.signMessage({ message }),
    version: "privy-did-owner-v1",
    did,
    verifiedDid: did,
  });
  assert.equal(r.ok, true, r.ok === false ? r.why : "");
});

test("a privy signature cannot be replayed under a different identity", async () => {
  // The DID is INSIDE the signed bytes, so a signature made under one identity
  // reconstructs to different text under another and fails to recover.
  const embedded = privateKeyToAccount(generatePrivateKey());
  const nonce = issueChallengeNonce(ORIGIN);
  const signedUnder = bindingMessage({
    version: "privy-did-owner-v1",
    origin: ORIGIN,
    nonce,
    owner: embedded.address,
    smartAccount: SMART,
    chainId: CHAIN,
    did: "did:privy:first",
  });
  const r = await verifyGrantBinding({
    origin: ORIGIN,
    tenant: embedded.address.toLowerCase() as `0x${string}`,
    nonce,
    owner: embedded.address,
    smartAccount: SMART,
    chainId: CHAIN,
    ownerSignature: await embedded.signMessage({ message: signedUnder }),
    version: "privy-did-owner-v1",
    did: "did:privy:second",
    verifiedDid: "did:privy:second",
  });
  assert.equal(r.ok, false);
});

test("ONE KEY SIGNING TWICE IS NOT TWO PROOFS", async () => {
  // Enforced only after it was counted. Production, 2026-09-06: twenty-two
  // installed grants, twenty-two owner keys read, zero of them equal to their
  // own tenant. So this refusal invalidates no custody pattern anybody is
  // actually using — which is the whole reason the census came first.
  //
  // Note what is NOT asserted here: there is no global rule that an owner may
  // never equal a tenant. `privy-did-owner-v1` allows exactly that, and takes
  // its authentication from a verified access token instead.
  assert.equal(ENFORCE_LEGACY_TWO_PROOF, true, "the census reported zero, so this is on");

  const both = privateKeyToAccount(generatePrivateKey());
  const claim = await legacyClaim(both, both);
  // One key signing the same text twice produces the SAME signature, which is
  // what makes the condition detectable at all — and what makes the two
  // recoveries agree while proving half of what the model claims.
  assert.equal(claim.walletSignature, claim.ownerSignature);
  const r = await verifyGrantBinding(claim);
  assert.equal(r.ok, false);
  const why = r.ok === false ? r.why : "";
  assert.match(why, /one proof where it needs two/);
  // And it says what to DO. A refusal on a fund-access path that only describes
  // the cause leaves the user with an unusable agent and no next step.
  assert.match(why, /sweep the old one from the recovery panel/);
});

test("two DIFFERENT keys still verify — the rule is about proofs, not addresses", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const r = await verifyGrantBinding(await legacyClaim(wallet, owner));
  assert.equal(r.ok, true, r.ok === false ? r.why : "");
});

test("the refusal exists, is gated on the flag, and names a remedy", () => {
  // Source-read, because the branch cannot run while the flag is false — and a
  // refusal that ships without a remedy turns a correct check into an outage.
  const src = readFileSync(join(import.meta.dirname, "auth.ts"), "utf8");
  assert.match(src, /if \(ENFORCE_LEGACY_TWO_PROOF && ownerSigner\.toLowerCase\(\) === walletSigner\.toLowerCase\(\)\)/);
  assert.match(src, /one proof where it needs two/);
  // A fragment that survives the string concatenation the message is built from.
  assert.match(src, /sweep the old one from the recovery panel/);
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
