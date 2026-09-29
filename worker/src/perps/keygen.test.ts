/**
 * KEYGEN AND THE SEALED KEY — with the REAL pinned signer (it is fast: ~50 ms
 * to build, ~2 ms per key).
 *
 * docs/perps.md rule 5. What is proven here:
 *   - self-hosted keygen writes the 0600 key file BEFORE returning, and returns
 *     only the public half;
 *   - hosted keygen returns the public half plus a blob that opens to the
 *     private key under exactly (tenant, smartAccount, pubkey, 16) — and under
 *     nothing else, including the same tenant's other account or key;
 *   - no DEK is a refusal before the signer is even built;
 *   - no error carries a byte of the key.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { LIGHTER_ROUTE_V1, validatePerpPubKey } from "../../../packages/core/src/index";
import { loadPerpPrivateKey, perpKeyFileFor } from "./keystore";
import {
  generatePerpKeyPair,
  hostedPerpKeygen,
  isSealedPerpKey,
  openPerpKey,
  perpKeyAad,
  PerpKeySealError,
  sealPerpKey,
  selfHostedPerpKeygen,
} from "./keygen";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-keygen-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const DEK = Buffer.alloc(32, 7);
const TENANT = "0x00000000000000000000000000000000000000aa" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000a1" as const;
const OTHER = "0x00000000000000000000000000000000000000b2" as const;
const KI = LIGHTER_ROUTE_V1.apiKeyIndex;

function sealReason(fn: () => unknown, reason: string, secret?: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof PerpKeySealError, String(e));
    assert.equal(e.reason, reason, e.message);
    if (secret) {
      const bare = secret.replace(/^0x/, "");
      assert.ok(!e.message.includes(bare.slice(0, 16)) && !e.message.toUpperCase().includes(bare.slice(0, 16).toUpperCase()), "key material leaked into an error");
    }
    return true;
  });
}

test("the official signer makes a canonical pair, fresh every call", async () => {
  const a = await generatePerpKeyPair();
  const b = await generatePerpKeyPair();
  assert.match(a.privateKey, /^0x[0-9a-f]{80}$/);
  assert.equal(validatePerpPubKey(a.publicKey), a.publicKey);
  assert.notEqual(a.privateKey, b.privateKey);
  assert.notEqual(a.publicKey, b.publicKey);
});

test("SELF-HOSTED: the key file exists (0600) before the public key is returned, and only the public key is returned", async () => {
  const home = path.join(ROOT, "self");
  const out = await selfHostedPerpKeygen({ home });
  assert.deepEqual(Object.keys(out).sort(), ["apiKeyIndex", "apiPublicKey"]);
  assert.equal(out.apiKeyIndex, 16);
  const file = perpKeyFileFor(home, out.apiPublicKey);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const pair = loadPerpPrivateKey({ home, apiPublicKey: out.apiPublicKey });
  assert.equal(pair.publicKey, out.apiPublicKey);
  assert.ok(!JSON.stringify(out).includes(pair.privateKey.slice(2)), "the private key never leaves in the reply");
  assert.ok(readFileSync(file, "utf8").includes(pair.privateKey), "and it is in the file the worker will load");
});

test("HOSTED: public key + a blob that opens under exactly (tenant, account, pubkey, 16) — a sealed round trip", async () => {
  const out = await hostedPerpKeygen({ tenant: TENANT, smartAccount: ACCOUNT, dek: DEK });
  assert.deepEqual(Object.keys(out).sort(), ["apiKeyIndex", "apiKeySealed", "apiPublicKey"]);
  assert.ok(isSealedPerpKey(out.apiKeySealed));
  const ctx = { tenant: TENANT, smartAccount: ACCOUNT, apiPublicKey: out.apiPublicKey, apiKeyIndex: KI };
  const priv = openPerpKey(out.apiKeySealed, ctx, DEK);
  assert.match(priv, /^0x[0-9a-f]{80}$/);
  assert.ok(!out.apiKeySealed.includes(priv.slice(2, 20)), "the blob is ciphertext");
  // Case of the context does not matter: everything is canonicalised.
  assert.equal(openPerpKey(out.apiKeySealed, { ...ctx, tenant: TENANT.toUpperCase().replace("0X", "0x"), apiPublicKey: out.apiPublicKey.toUpperCase().replace("0X", "0x") }, DEK), priv);

  // ANY other context is "not this key's blob".
  sealReason(() => openPerpKey(out.apiKeySealed, { ...ctx, tenant: OTHER }, DEK), "unopenable", priv);
  sealReason(() => openPerpKey(out.apiKeySealed, { ...ctx, smartAccount: OTHER }, DEK), "unopenable", priv);
  const other = await generatePerpKeyPair();
  sealReason(() => openPerpKey(out.apiKeySealed, { ...ctx, apiPublicKey: other.publicKey }, DEK), "unopenable", priv);
  sealReason(() => openPerpKey(out.apiKeySealed, ctx, Buffer.alloc(32, 9)), "unopenable", priv);
  // A flipped byte — mid-ciphertext: the LAST base64url character of 82
  // bytes carries only padding bits past its first two, so flipping it can
  // decode to the very same bytes and prove nothing.
  const parts = out.apiKeySealed.split(".");
  const ct = parts[3]!;
  const flipped = [...parts.slice(0, 3), `${ct.slice(0, 40)}${ct[40] === "A" ? "B" : "A"}${ct.slice(41)}`].join(".");
  sealReason(() => openPerpKey(flipped, ctx, DEK), "unopenable", priv);
  sealReason(() => openPerpKey("0xdeadbeef", ctx, DEK), "malformed");
});

test("HOSTED WITHOUT A DEK: refused before the signer is built", async () => {
  let built = 0;
  const source = async () => {
    built++;
    return { generateApiKey: () => ({ privateKey: `0x${"ab".repeat(40)}` as `0x${string}`, publicKey: `0x${"01".padEnd(16, "0").repeat(5)}` as `0x${string}` }) };
  };
  await assert.rejects(hostedPerpKeygen({ tenant: TENANT, smartAccount: ACCOUNT, dek: null, source }), (e: unknown) => e instanceof PerpKeySealError && e.reason === "no-dek");
  await assert.rejects(hostedPerpKeygen({ tenant: TENANT, smartAccount: ACCOUNT, dek: Buffer.alloc(16), source }), (e: unknown) => e instanceof PerpKeySealError && e.reason === "no-dek");
  assert.equal(built, 0);
});

test("the AAD is exactly perp-key-v1|tenant|account|pubkey|16, canonical, and refuses a malformed context", async () => {
  const { publicKey } = await generatePerpKeyPair();
  assert.equal(
    perpKeyAad({ tenant: TENANT.toUpperCase().replace("0X", "0x"), smartAccount: ACCOUNT, apiPublicKey: publicKey, apiKeyIndex: 16 }),
    `perp-key-v1|${TENANT}|${ACCOUNT}|${publicKey}|16`,
  );
  sealReason(() => perpKeyAad({ tenant: "nope", smartAccount: ACCOUNT, apiPublicKey: publicKey, apiKeyIndex: 16 }), "bad-context");
  sealReason(() => perpKeyAad({ tenant: TENANT, smartAccount: ACCOUNT, apiPublicKey: `0x${"ff".repeat(40)}`, apiKeyIndex: 16 }), "bad-context");
  sealReason(() => perpKeyAad({ tenant: TENANT, smartAccount: ACCOUNT, apiPublicKey: publicKey, apiKeyIndex: 3 }), "bad-context");
});

test("sealPerpKey refuses a plaintext that is not a Lighter private key, without echoing it", () => {
  const pk = `0x${"01".padEnd(16, "0").repeat(5)}`;
  const ctx = { tenant: TENANT, smartAccount: ACCOUNT, apiPublicKey: pk, apiKeyIndex: KI };
  const evm = `0x${"cd".repeat(32)}`;
  sealReason(() => sealPerpKey(evm, ctx, DEK), "bad-plaintext", evm);
  sealReason(() => sealPerpKey(`0x${"0".repeat(80)}`, ctx, DEK), "bad-plaintext");
  sealReason(() => sealPerpKey(`0x${"ab".repeat(40)}`, ctx, null), "no-dek");
  // Two seals of one key differ (fresh IV) and both open.
  const a = sealPerpKey(`0x${"ab".repeat(40)}`, ctx, DEK);
  const b = sealPerpKey(`0x${"AB".repeat(40)}`, ctx, DEK);
  assert.notEqual(a, b);
  assert.equal(openPerpKey(a, ctx, DEK), `0x${"ab".repeat(40)}`);
  assert.equal(openPerpKey(b, ctx, DEK), `0x${"ab".repeat(40)}`);
});
