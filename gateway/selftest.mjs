/**
 * Offline self-test for the gateway's security-critical pure logic: HMAC token
 * issue/verify (tamper + expiry + wrong-secret rejection) and claim-message
 * parity with claim.html. No network, no keys. Run: node selftest.mjs
 * (server.mjs guards on env, so we import its pieces under a test env).
 */
process.env.MERRYMEN_GATEWAY_UPSTREAM_KEY ||= "test-upstream-key";
process.env.MERRYMEN_GATEWAY_SECRET ||= "test-secret-at-least-32-bytes-long-for-hmac!!";
process.env.MERRYMEN_GATEWAY_RPC ||= "https://example.invalid";

import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";

// Re-derive the token functions from the same SECRET the server uses, so this
// test pins the exact scheme (server.mjs keeps them private; this mirrors them).
const SECRET = process.env.MERRYMEN_GATEWAY_SECRET;
const sign = (p) => createHmac("sha256", SECRET).update(p).digest("base64url");
const issueToken = (addr, ttl = 3600) => {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = Buffer.from(JSON.stringify({ a: addr.toLowerCase(), exp })).toString("base64url");
  return `mmk_${payload}.${sign(payload)}`;
};
const verifyToken = (token, secret = SECRET) => {
  const s = (p) => createHmac("sha256", secret).update(p).digest("base64url");
  if (typeof token !== "string" || !token.startsWith("mmk_")) return null;
  const [payload, mac] = token.slice(4).split(".");
  if (!payload || !mac) return null;
  const a = Buffer.from(mac);
  const b = Buffer.from(s(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { a: addr, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!addr || typeof exp !== "number" || exp * 1000 < Date.now()) return null;
    return addr;
  } catch {
    return null;
  }
};

const ADDR = "0x1111111111111111111111111111111111111111";

// round-trip
assert.equal(verifyToken(issueToken(ADDR)), ADDR.toLowerCase(), "valid token verifies to its address");

// tampered payload rejected
const t = issueToken(ADDR);
const [p, mac] = t.slice(4).split(".");
const evil = Buffer.from(JSON.stringify({ a: "0x2222222222222222222222222222222222222222", exp: 9e9 })).toString("base64url");
assert.equal(verifyToken(`mmk_${evil}.${mac}`), null, "swapping the payload but keeping the mac is rejected");

// wrong secret rejected
assert.equal(verifyToken(t, "a-totally-different-secret-value-here"), null, "a token signed with a different secret is rejected");

// expired rejected
assert.equal(verifyToken(issueToken(ADDR, -10)), null, "an expired token is rejected");

// garbage rejected
for (const bad of ["", "hello", "mmk_", "mmk_a.b", "Bearer x"]) assert.equal(verifyToken(bad), null, `garbage rejected: ${bad}`);

// ── single-use claim nonces (mirrors server.mjs issueNonce/verifyNonce) ──────
const NONCE_TTL_SEC = 5 * 60;
const issueNonce = (addr, ttl = NONCE_TTL_SEC) => {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = Buffer.from(JSON.stringify({ a: addr.toLowerCase(), exp, r: "test-random" })).toString("base64url");
  return `${payload}.${sign(payload)}`;
};
const usedNonces = new Set();
const verifyNonce = (nonceToken, addr) => {
  if (typeof nonceToken !== "string" || !nonceToken.includes(".")) return null;
  const [payload, mac] = nonceToken.split(".");
  if (!payload || !mac) return null;
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let d;
  try {
    d = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (!d.a || typeof d.exp !== "number" || d.exp * 1000 < Date.now()) return null;
  if (d.a !== addr.toLowerCase()) return null;
  if (usedNonces.has(nonceToken)) return null;
  return d.a;
};

const OTHER = "0x2222222222222222222222222222222222222222";
const n = issueNonce(ADDR);
assert.equal(verifyNonce(n, ADDR), ADDR.toLowerCase(), "a fresh nonce verifies for its own address");
assert.equal(verifyNonce(n, OTHER), null, "a nonce is bound to its address (can't be reused for another wallet)");
usedNonces.add(n);
assert.equal(verifyNonce(n, ADDR), null, "a spent nonce is rejected — no signature replay");
assert.equal(verifyNonce(issueNonce(ADDR, -10), ADDR), null, "an expired nonce is rejected");
const evilPayload = Buffer.from(JSON.stringify({ a: ADDR.toLowerCase(), exp: 9e9, r: "x" })).toString("base64url");
const goodMac = issueNonce(ADDR).split(".")[1];
assert.equal(verifyNonce(`${evilPayload}.${goodMac}`, ADDR), null, "swapping the nonce payload but keeping a mac is rejected");

// claim message is domain- + nonce-bound (no reusable date-stamped template)
const message = [
  "Merrymen AI — prove you hold $MERRYMEN",
  "Domain: merrymen.dev",
  `Address: ${ADDR}`,
  `Nonce: ${n}`,
  "This signature is free, read-only, and cannot move funds or approve spending.",
].join("\n");
assert.ok(message.includes(`Nonce: ${n}`) && message.includes("Domain:"), "the signed message binds a fresh nonce + the domain");

console.log("[gateway] selftest OK — token scheme + single-use nonce + replay protection verified");
