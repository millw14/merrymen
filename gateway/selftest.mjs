/**
 * Offline self-test for the gateway's security-critical pure logic, exercising the
 * REAL shared core (lib/core.mjs) — HMAC token issue/verify (tamper + expiry +
 * wrong-secret + garbage), single-use domain-bound nonces (authenticity + binding
 * + expiry + tamper), and atomic replay protection via the store. No network, no
 * real keys. Run: node selftest.mjs
 */
process.env.MERRYMEN_GATEWAY_UPSTREAM_KEY ||= "test-upstream-key";
process.env.MERRYMEN_GATEWAY_SECRET ||= "test-secret-at-least-32-bytes-long-for-hmac!!";
process.env.MERRYMEN_GATEWAY_RPC ||= "https://example.invalid";

import assert from "node:assert/strict";
import { createGateway } from "./lib/core.mjs";
import { createStore } from "./lib/store.mjs";

const SECRET = process.env.MERRYMEN_GATEWAY_SECRET;
const baseCfg = {
  upstreamUrl: "https://example.invalid",
  upstreamKey: "x",
  model: "test-model",
  domain: "merrymen.dev",
  minTokens: 10000n,
  tokenAddress: "0x0000000000000000000000000000000000000000",
  publicClient: { readContract: async () => 0n }, // isHolder isn't exercised here
};
const store = createStore(); // in-memory (no KV env in the test)
const gw = createGateway({ ...baseCfg, secret: SECRET, store });
const gwOther = createGateway({ ...baseCfg, secret: "a-totally-different-secret-value-32bytes!!", store });
const { sign, issueToken, verifyToken, issueNonce, verifyNonceAuthentic, claimMessage } = gw._tokens;

const ADDR = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

// ── HMAC access tokens ───────────────────────────────────────────────────────
assert.equal(verifyToken(issueToken(ADDR)), ADDR.toLowerCase(), "valid token verifies to its address");

const t = issueToken(ADDR);
const mac = t.slice(4).split(".")[1];
const evilPayload = Buffer.from(JSON.stringify({ a: OTHER, exp: 9e9 })).toString("base64url");
assert.equal(verifyToken(`mmk_${evilPayload}.${mac}`), null, "swapping the payload but keeping the mac is rejected");

const expiredPayload = Buffer.from(JSON.stringify({ a: ADDR.toLowerCase(), exp: Math.floor(Date.now() / 1000) - 10 })).toString("base64url");
assert.equal(verifyToken(`mmk_${expiredPayload}.${sign(expiredPayload)}`), null, "an expired token is rejected");

assert.equal(gwOther._tokens.verifyToken(t), null, "a token signed with a different secret is rejected");

for (const bad of ["", "hello", "mmk_", "mmk_a.b", "Bearer x"]) assert.equal(verifyToken(bad), null, `garbage rejected: ${bad}`);

// ── single-use, domain-bound claim nonces ────────────────────────────────────
const n = issueNonce(ADDR);
assert.equal(verifyNonceAuthentic(n, ADDR), true, "a fresh nonce is authentic for its own address");
assert.equal(verifyNonceAuthentic(n, OTHER), false, "a nonce is bound to its address (can't be reused for another wallet)");

const nMac = issueNonce(ADDR).split(".")[1];
const evilNonce = Buffer.from(JSON.stringify({ a: ADDR.toLowerCase(), exp: 9e9, r: "x" })).toString("base64url");
assert.equal(verifyNonceAuthentic(`${evilNonce}.${nMac}`, ADDR), false, "swapping the nonce payload but keeping a mac is rejected");

const expiredNonce = Buffer.from(JSON.stringify({ a: ADDR.toLowerCase(), exp: Math.floor(Date.now() / 1000) - 10, r: "x" })).toString("base64url");
assert.equal(verifyNonceAuthentic(`${expiredNonce}.${sign(expiredNonce)}`, ADDR), false, "an expired nonce is rejected");

// atomic replay protection lives in the store: first spend wins, the rest fail
assert.equal(await store.spendNonce(n, 300), true, "first spend of a nonce succeeds");
assert.equal(await store.spendNonce(n, 300), false, "a spent nonce cannot be spent again — no replay");

// message is domain- + nonce-bound (no reusable date-stamped template)
const message = claimMessage(ADDR, n);
assert.ok(message.includes(`Nonce: ${n}`) && message.includes("Domain: merrymen.dev"), "the signed message binds a fresh nonce + the domain");

console.log("[gateway] selftest OK — shared core: token scheme + single-use nonce + replay protection verified");
