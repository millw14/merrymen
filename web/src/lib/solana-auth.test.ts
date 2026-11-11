import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { NextRequest } from "next/server";
import { base58Encode } from "../../../packages/core/src/ids";
import { authenticateSolana, solanaBindingMessage, verifySolanaBindingSignature, SolanaWebError, type SolanaAuthDependencies } from "./solana-auth";
import { SOLANA_SIGN_IN_MISMATCH, solanaAccountLogin, solanaAccountLoginText, solanaSignInRefusal } from "./solana-sign-in";

const TENANT = `0x${"11".repeat(20)}` as const;
const OTHER = `0x${"22".repeat(20)}` as const;
const principal = { tenant: TENANT, did: "did:privy:alice" };
const seed = new Uint8Array(32).fill(42);
const OWNER = base58Encode(ed25519.getPublicKey(seed));
const OTHER_OWNER = base58Encode(ed25519.getPublicKey(new Uint8Array(32).fill(43)));
const origin = "https://app.example.test", nonce = "test-origin-bound-nonce";
const signature = base58Encode(ed25519.sign(new TextEncoder().encode(solanaBindingMessage(principal, OWNER, origin, nonce)), seed));
const request = (headers = {}) => new Request(origin + "/api/solana/status", { headers: { authorization: "Bearer fixture", ...headers } });
const dependencies = (overrides: Partial<SolanaAuthDependencies> = {}): SolanaAuthDependencies => ({
  tenant: () => TENANT, verifyToken: async () => ({ ok: true, identity: { did: principal.did } }),
  tenantForDid: async () => TENANT, ...overrides,
});
test("binding signatures prove exact owner, tenant, DID, origin, nonce and purpose", () => {
  assert.equal(verifySolanaBindingSignature(principal, OWNER, origin, nonce, signature), true);
  for (const [identity, owner, site, challenge] of [
    [{ ...principal, tenant: OTHER }, OWNER, origin, nonce],
    [{ ...principal, did: "did:privy:bob" }, OWNER, origin, nonce],
    [principal, OTHER_OWNER, origin, nonce], [principal, OWNER, "https://evil.example", nonce],
    [principal, OWNER, origin, "other-nonce"],
  ] as const) assert.equal(verifySolanaBindingSignature(identity, owner, site, challenge, signature), false);
  const loginSignature = base58Encode(ed25519.sign(new TextEncoder().encode("Sign in to Merrymen"), seed));
  assert.equal(verifySolanaBindingSignature(principal, OWNER, origin, nonce, loginSignature), false);
});
test("invalid and noncanonical wallet proofs fail closed", () => {
  for (const invalid of ["", signature.slice(1), signature + "1", " " + signature, "0x" + "a".repeat(128)]) {
    assert.equal(verifySolanaBindingSignature(principal, OWNER, origin, nonce, invalid), false);
  }
  assert.equal(verifySolanaBindingSignature(principal, OWNER.toLowerCase(), origin, nonce, signature), false);
  assert.equal(verifySolanaBindingSignature(principal, " " + OWNER, origin, nonce, signature), false);
});
test("Solana authentication requires the current cookie and verified DID to name the same tenant", async () => {
  assert.deepEqual(await authenticateSolana(request(), dependencies()), principal);
  await assert.rejects(authenticateSolana(request(), dependencies({ tenant: () => null })), (e: unknown) => e instanceof SolanaWebError && e.status === 401);
  await assert.rejects(authenticateSolana(request(), dependencies({ verifyToken: async () => ({ ok: false }) })), (e: unknown) => e instanceof SolanaWebError && e.status === 401);
  for (const mapped of [OTHER, null]) await assert.rejects(authenticateSolana(request(), dependencies({ tenantForDid: async () => mapped })), (e: unknown) => e instanceof SolanaWebError && e.status === 403);
});
/** The refusal authenticateSolana throws, for its fields. */
async function refusal(deps: SolanaAuthDependencies, req = request()): Promise<SolanaWebError> {
  try { await authenticateSolana(req, deps); } catch (e) { assert.ok(e instanceof SolanaWebError); return e; }
  assert.fail("expected a refusal");
}
test("a refused sign-in says why by code, and a mismatch names the account's login without deciding anything by it", async () => {
  // A Solana page asked to open with no Merrymen session, or a wallet token that does not verify.
  assert.deepEqual((await refusal(dependencies({ tenant: () => null }))).signIn, { problem: "signed-out", account: null, loginHasAccount: false });
  assert.deepEqual((await refusal(dependencies({ verifyToken: async () => ({ ok: false }) }))).signIn, { problem: "expired", account: null, loginHasAccount: false });
  // A session for one login and a wallet sign-in of another: named, and whether that other login has an account.
  const lookups: string[] = [];
  const accountLogin = async (tenant: `0x${string}`) => { lookups.push(tenant); return { provider: "twitter" as const, handle: "jamesc" }; };
  for (const [mapped, loginHasAccount] of [[OTHER, true], [null, false]] as const) {
    const mismatch = await refusal(dependencies({ tenantForDid: async () => mapped, accountLogin }));
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.message, SOLANA_SIGN_IN_MISMATCH);
    assert.deepEqual(mismatch.signIn, { problem: "mismatch", account: { provider: "twitter", handle: "jamesc" }, loginHasAccount });
  }
  assert.deepEqual(lookups, [TENANT, TENANT], "the login asked about is the session's own account's");
  // The lookup only words the answer: one that fails, or none at all, still refuses, naming no login.
  for (const deps of [dependencies({ tenantForDid: async () => OTHER, accountLogin: async () => { throw new Error("store down"); } }), dependencies({ tenantForDid: async () => OTHER })]) {
    const mismatch = await refusal(deps);
    assert.equal(mismatch.status, 403);
    assert.deepEqual(mismatch.signIn, { problem: "mismatch", account: null, loginHasAccount: true });
  }
  // A matching sign-in never looks the login up.
  lookups.length = 0;
  assert.deepEqual(await authenticateSolana(request(), dependencies({ accountLogin })), principal);
  assert.deepEqual(lookups, []);
  // Every other refusal carries no code: the cross-origin and changed-identity answers stay as they were.
  for (const headers of [{ origin: "https://evil.example" }, { "x-merrymen-privy-did": "did:privy:bob" }]) {
    const other = await refusal(dependencies({ accountLogin }), request(headers));
    assert.equal(other.status, 403);
    assert.equal(other.signIn, null);
  }
});
test("the account's login is shown as display words only: an X handle, never an email address", () => {
  assert.deepEqual(solanaAccountLogin({ social: { provider: "twitter", handle: "jamesc" } }), { provider: "twitter", handle: "jamesc" });
  assert.deepEqual(solanaAccountLogin({ social: { provider: "twitter", handle: "<script>" } }), { provider: "twitter", handle: null });
  assert.deepEqual(solanaAccountLogin({ social: { provider: "email", handle: "someone@example.com" } }), { provider: "email", handle: null });
  assert.deepEqual(solanaAccountLogin({ social: { provider: "google", handle: "someone" } }), { provider: "google", handle: null });
  assert.deepEqual(solanaAccountLogin({ social: null }), { provider: "wallet", handle: null }, "an account made with the wallet login");
  assert.equal(solanaAccountLogin({ social: { provider: "telegram", handle: "x" } }), null);
  assert.equal(solanaAccountLogin(null), null);
  assert.equal(solanaAccountLoginText({ provider: "twitter", handle: "jamesc" }), "X (@jamesc)");
  assert.equal(solanaAccountLoginText({ provider: "email", handle: null }), "email");
  assert.equal(solanaAccountLoginText({ provider: "wallet", handle: null }), "a wallet");
  assert.equal(solanaAccountLoginText(null), "another login");
  // What the page reads back from an answer: validated, anything else absent.
  assert.deepEqual(solanaSignInRefusal({ problem: "mismatch", account: { provider: "twitter", handle: "jamesc" }, loginHasAccount: true }),
    { problem: "mismatch", account: { provider: "twitter", handle: "jamesc" }, loginHasAccount: true });
  assert.deepEqual(solanaSignInRefusal({ problem: "mismatch", account: { provider: "email", handle: "someone@example.com" } }),
    { problem: "mismatch", account: { provider: "email", handle: null }, loginHasAccount: false });
  assert.deepEqual(solanaSignInRefusal({ problem: "expired" }), { problem: "expired", account: null, loginHasAccount: false });
  for (const junk of [null, "mismatch", { problem: "other" }, { problem: 1 }, []]) assert.equal(solanaSignInRefusal(junk), null);
});
test("browser cross-origin requests cannot mutate a bound Solana account", async () => {
  await assert.rejects(authenticateSolana(request({ origin: "https://evil.example" }), dependencies()), (e: unknown) => e instanceof SolanaWebError && e.status === 403);
  assert.deepEqual(await authenticateSolana(request({ origin }), dependencies()), principal);
});
test("a delayed token from a different login cannot satisfy the browser's expected identity", async () => {
  await assert.rejects(authenticateSolana(request({ "x-merrymen-privy-did": "did:privy:bob" }), dependencies()), (e: unknown) => e instanceof SolanaWebError && e.status === 403);
  assert.deepEqual(await authenticateSolana(request({ "x-merrymen-privy-did": principal.did }), dependencies()), principal);
});
test("a page opened at 127.0.0.1 is same-origin, while other loopback ports, rebinding names and real hosts are not", async () => {
  const configured = process.env.MERRYMEN_PUBLIC_ORIGIN;
  delete process.env.MERRYMEN_PUBLIC_ORIGIN;
  try {
    // Next rewrites a loopback req.url to localhost, exactly as the route sees it.
    const local = (origin: string, host: string, url = "http://127.0.0.1:3000/api/solana/settings") =>
      new NextRequest(url, { method: "POST", headers: { authorization: "Bearer fixture", origin, host } }) as unknown as Request;
    assert.equal(local("http://127.0.0.1:3000", "127.0.0.1:3000").url, "http://localhost:3000/api/solana/settings");
    assert.deepEqual(await authenticateSolana(local("http://127.0.0.1:3000", "127.0.0.1:3000"), dependencies()), principal);
    assert.deepEqual(await authenticateSolana(local("http://localhost:3000", "localhost:3000"), dependencies()), principal);
    assert.deepEqual(await authenticateSolana(local("http://[::1]:3000", "[::1]:3000", "http://[::1]:3000/api/solana/settings"), dependencies()), principal);
    for (const [origin, host] of [
      ["http://127.0.0.1:4000", "127.0.0.1:3000"], // another local service
      ["http://127.0.0.2:3000", "127.0.0.1:3000"],
      ["http://evil.example:3000", "evil.example:3000"], // DNS rebinding to loopback
      ["https://127.0.0.1:3000", "127.0.0.1:3000"], // scheme differs
      ["null", "127.0.0.1:3000"],
      ["http://127.0.0.1:3000/path", "127.0.0.1:3000"],
    ]) await assert.rejects(authenticateSolana(local(origin!, host!), dependencies()), (e: unknown) => e instanceof SolanaWebError && e.status === 403, `${origin} via ${host}`);
    // A real host never trusts the Host header.
    const real = new NextRequest("https://app.example.test/api/solana/settings", { method: "POST", headers: { authorization: "Bearer fixture", origin: "https://evil.example", host: "evil.example" } }) as unknown as Request;
    await assert.rejects(authenticateSolana(real, dependencies()), (e: unknown) => e instanceof SolanaWebError && e.status === 403);
    // A configured public origin stays exact, even for loopback.
    process.env.MERRYMEN_PUBLIC_ORIGIN = "https://app.example.test";
    await assert.rejects(authenticateSolana(local("http://127.0.0.1:3000", "127.0.0.1:3000"), dependencies()), (e: unknown) => e instanceof SolanaWebError && e.status === 403);
    assert.deepEqual(await authenticateSolana(local("https://app.example.test", "127.0.0.1:3000"), dependencies()), principal);
  } finally {
    if (configured === undefined) delete process.env.MERRYMEN_PUBLIC_ORIGIN; else process.env.MERRYMEN_PUBLIC_ORIGIN = configured;
  }
});
