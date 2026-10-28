/**
 * THE CUSTODY GUARD — the one check that stands between a hosted server and
 * becoming custodian of every tenant's fund-custody key.
 *
 * Pass this incorrectly and one database dump drains everyone, so it is tested
 * for what a real attacker or a careless client actually sends: the named
 * field, a renamed field, a raw key nested anywhere, a mnemonic — and it must
 * NOT trip on the session key, which the worker legitimately needs.
 *
 * carriesOwnerKey lives in packages/core so the grant API and the boot check
 * share one definition; this exercises it directly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { assertNoOwnerKeysAtRest, base58Encode, carriesOwnerKey, SOLANA_USDG_MINT } from "../../packages/core/src/index";

const KEY = "0x" + "ab".repeat(32); // a 32-byte private key
const sessionOnlyGrant = {
  smartAccount: "0x00000000000000000000000000000000000000a1",
  owner: "0x00000000000000000000000000000000000000b1",
  serialized: "eyJ...a-long-zerodev-blob...",
  chainId: 4663,
  grantFeatures: ["tradeable-v2"],
  grantTokens: ["0x00000000000000000000000000000000000000c1"],
  demoSessionPrivateKey: "0x" + "cd".repeat(32), // the worker needs this — NOT custody
};

test("a session-key-only grant is clean — the shape the hosted signer produces", () => {
  assert.equal(carriesOwnerKey(sessionOnlyGrant), false);
});

test("the named owner-key field is caught", () => {
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, demoOwnerPrivateKey: KEY }), true);
});

test("a RENAMED field hiding a raw 32-byte key is still caught", () => {
  // A future bug or a hostile client could call it anything.
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, ownerBackup: KEY }), true);
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, sudo: KEY.slice(2) }), true, "no 0x prefix, still a key");
});

test("a key nested deep in the payload is caught", () => {
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, meta: { backup: { k: KEY } } }), true);
});

test("a mnemonic is caught — the other shape of an owner key", () => {
  const grant = { ...sessionOnlyGrant, phrase: "legal winner thank year wave sausage worth useful legal winner thank yellow" };
  assert.equal(carriesOwnerKey(grant), true);
});

test("the session key ALONE never trips the guard — the worker legitimately holds it", () => {
  // This is the false-positive that would break every hosted grant. The
  // session key is a 64-hex value too, so the guard must exempt its field.
  assert.equal(carriesOwnerKey(sessionOnlyGrant), false);
  assert.equal(carriesOwnerKey({ demoSessionPrivateKey: KEY }), false);
});

test("null / non-object / empty are clean, never a throw", () => {
  for (const x of [null, undefined, "", 42, [], {}]) assert.equal(carriesOwnerKey(x), false);
});

test("assertNoOwnerKeysAtRest is inert when hosted mode is off", () => {
  delete process.env.MERRYMEN_HOSTED;
  // Even a dirty grant does not throw when self-hosted — the owner key on disk
  // is the user's own, on their own machine.
  assert.doesNotThrow(() => assertNoOwnerKeysAtRest([{ ...sessionOnlyGrant, demoOwnerPrivateKey: KEY }]));
});

test("assertNoOwnerKeysAtRest REFUSES to boot in hosted mode on a dirty grant", () => {
  process.env.MERRYMEN_HOSTED = "1";
  try {
    assert.doesNotThrow(() => assertNoOwnerKeysAtRest([sessionOnlyGrant, sessionOnlyGrant]), "clean grants boot");
    assert.throws(
      () => assertNoOwnerKeysAtRest([sessionOnlyGrant, { ...sessionOnlyGrant, demoOwnerPrivateKey: KEY }]),
      /refuses to start/,
      "one dirty grant halts the whole boot",
    );
  } finally {
    delete process.env.MERRYMEN_HOSTED;
  }
});

// ── Solana secret keys ──────────────────────────────────────────────────────
// The real signer's grants are checked in web/src/lib/grant-owner-key.test.ts.

/** A real Solana keypair: its base58 secret, the id.json byte array, and a real signature by it. */
function solanaKeypair(seedByte: number) {
  const seed = new Uint8Array(32).fill(seedByte);
  const pub = ed25519.getPublicKey(seed);
  const secret = new Uint8Array([...seed, ...pub]);
  const sig = ed25519.sign(new TextEncoder().encode("merrymen"), seed);
  return { b58: base58Encode(secret), bytes: [...secret], pub: base58Encode(pub), sig: base58Encode(sig) };
}
const SOL = solanaKeypair(7);
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

test("a Solana secret key is caught as base58 or as a byte array, wherever it hides", () => {
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, solanaOwner: SOL.b58 }), true, "renamed field, base58");
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, meta: { backup: { k: SOL.bytes } } }), true, "nested id.json array");
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, note: `export ${JSON.stringify(SOL.bytes, null, 2)}` }), true, "pretty-printed in prose");
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, grantTokens: [SOL.b58] }), true, "inside an array");
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, demoSessionPrivateKey: SOL.b58 }), true, "the session-key field exempts only a 0x key");
  assert.equal(carriesOwnerKey(SOL.b58), true, "a bare string");
});

test("the serialized blob is scanned for what it holds, not exempted", () => {
  const blob = (extra: Record<string, unknown>) => b64({ permissionParams: { policies: [] }, privateKey: KEY, ...extra });
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, serialized: blob({}) }), false, "a clean ZeroDev-shaped blob");
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, serialized: blob({ ownerSecret: SOL.b58 }) }), true, "base58 inside the blob");
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, serialized: blob({ k: SOL.bytes }) }), true, "a byte array inside the blob");
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, serialized: blob({ note: JSON.stringify(SOL.bytes, null, 2) }) }), true, "a pasted id.json inside the blob");
  // Base58 is a subset of base64's alphabet: a raw key passes the base64 test,
  // but it is not a ZeroDev blob, so it is scanned as written.
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, serialized: SOL.b58 }), true, "a raw key in place of the blob");
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, serialized: b64(SOL.bytes) }), true, "a byte array base64'd in place of the blob");
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, inner: { serialized: SOL.b58 } }), true, "only the grant's own field is decoded");
});

test("Solana public ids are never a secret: a signature, a public key, a mint", () => {
  const grant = {
    ...sessionOnlyGrant,
    binding: { nonce: SOL.sig, ownerSignature: SOL.sig, did: `did:privy:${SOL.pub}` },
    grantTokens: [SOL.pub, SOLANA_USDG_MINT],
    serialized: b64({ permissionParams: { sig: SOL.sig, pub: SOL.pub }, privateKey: KEY }),
    random: Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256),
  };
  assert.equal(carriesOwnerKey(grant), false);
});

test("a stored grant with a Solana secret halts the hosted boot", () => {
  process.env.MERRYMEN_HOSTED = "1";
  try {
    assert.throws(() => assertNoOwnerKeysAtRest([sessionOnlyGrant, { ...sessionOnlyGrant, solana: SOL.b58 }]), /refuses to start/);
  } finally {
    delete process.env.MERRYMEN_HOSTED;
  }
});
