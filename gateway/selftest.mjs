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
import { bitqueryAuthHeaders, createGateway, DEFAULTS, parseInitializeEvent, sanitizeSymbol } from "./lib/core.mjs";
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

// ── /bitquery: the catalogue IS the attack surface ───────────────────────────
// Bitquery bills by query cost and GraphQL is unbounded, so the one thing that
// must never be true is "a caller can choose the query". These assertions are
// the whole safety argument for putting an operator's paid key behind a public
// endpoint, so they check refusal FIRST and reachability second.
const holderClient = { readContract: async () => 10_000n * 10n ** 18n };
const bq = createGateway({
  ...baseCfg,
  secret: SECRET,
  store,
  bitqueryKey: "test-bitquery-key",
  bitqueryUrl: "https://example.invalid/graphql",
  publicClient: holderClient,
  // Raised so the refusal assertions below can all run; the real (tighter)
  // default is asserted separately at the end.
  tunables: { BITQUERY_RATE_PER_MIN: 1000 },
});
const goodToken = bq._tokens.issueToken(ADDR);

assert.equal(
  (await bq.bitquery({ token: "mmk_nope.bad", body: { query: "ping" }, ip: "1.1.1.1" })).status,
  401,
  "an unsigned token can't reach the operator's Bitquery key",
);

// Raw GraphQL must be refused BY NAME LOOKUP — not sanitised, not escaped.
for (const attempt of [
  "{ EVM(network: robinhood) { Blocks { Block { Number } } } }",
  "query { __schema { types { name } } }",
  "ping\n{ evil }",
  "__proto__",
  "constructor",
  "toString",
  "",
  null,
  undefined,
  42,
  { nested: true },
]) {
  const r = await bq.bitquery({ token: goodToken, body: { query: attempt }, ip: "1.1.1.1" });
  assert.equal(r.status, 400, `raw/hostile query must be rejected: ${String(attempt).slice(0, 30)}`);
  assert.ok(Array.isArray(r.json.available), "the refusal names what IS allowed");
}

// Prototype keys must not resolve to inherited Object members.
assert.deepEqual(
  bq.bitqueryQueries().sort(),
  ["ping", "recentPools"],
  "the catalogue is exactly what's declared — nothing inherited",
);

// A gateway with no Bitquery key configured refuses the route outright rather
// than failing somewhere upstream with the operator's other credentials in play.
const noKey = createGateway({ ...baseCfg, secret: SECRET, store, publicClient: holderClient });
assert.equal(
  (await noKey.bitquery({ token: noKey._tokens.issueToken(ADDR), body: { query: "ping" }, ip: "2.2.2.2" })).status,
  503,
  "no key configured = 503, not a confusing upstream error",
);

// Discovery gets its own bucket, tighter than chat: a polled background feed
// must not be able to eat the allowance the holder's brain also depends on.
const rated = createGateway({ ...baseCfg, secret: SECRET, store, bitqueryKey: "k", bitqueryUrl: "https://example.invalid/graphql", publicClient: holderClient, tunables: { BITQUERY_RATE_PER_MIN: 2 } });
const rt = rated._tokens.issueToken(OTHER);
assert.equal((await rated.bitquery({ token: rt, body: { query: "ping" }, ip: "3.3.3.3" })).status !== 429, true, "first discovery call is allowed");
await rated.bitquery({ token: rt, body: { query: "ping" }, ip: "3.3.3.3" });
assert.equal((await rated.bitquery({ token: rt, body: { query: "ping" }, ip: "3.3.3.3" })).status, 429, "discovery is rate-limited per address");
assert.ok(DEFAULTS.BITQUERY_RATE_PER_MIN < DEFAULTS.RATE_PER_MIN, "discovery is limited harder than chat by default");

// ── /memescope: the PUBLIC route ─────────────────────────────────────────────
// This one has no holder check in front of it, so its cost properties are load
// bearing rather than nice to have. Each assertion below is guarding the
// operator's Bitquery bill against a route strangers can call.

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WETH_ADDR = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const MEME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const evt = (a, b, iso = "2026-07-29T00:00:00Z", hash = "0xdead") => ({
  Block: { Time: iso },
  Transaction: { Hash: hash },
  Arguments: [{ Value: { address: a } }, { Value: { address: b } }],
});

assert.equal(parseInitializeEvent(evt(USDG, MEME)).token, MEME, "the non-cash side is the launch");
assert.equal(parseInitializeEvent(evt(MEME, USDG)).token, MEME, "…whichever order it arrives in");
assert.equal(parseInitializeEvent(evt(USDG, WETH_ADDR)), null, "a cash/cash pool is not a launch");
assert.equal(parseInitializeEvent(evt(MEME, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")), null, "neither side cash = nothing to price against");
assert.equal(parseInitializeEvent({ Arguments: [] }), null, "a malformed event is dropped, not thrown on");
assert.equal(parseInitializeEvent(evt(USDG, MEME, "not-a-date")), null, "an unparseable timestamp is dropped");

// A token name is attacker-chosen text on its way to a web page.
assert.equal(sanitizeSymbol("<script>x</script>"), "scriptxscript", "markup characters are stripped");
assert.equal(sanitizeSymbol("USDG‮evil"), "USDGevil", "the RTL override that disguises a name is stripped");
assert.equal(sanitizeSymbol("​​"), "?", "a zero-width-only name is not blank, it's unknown");
assert.equal(sanitizeSymbol("A".repeat(99)).length, 16, "length is hard-capped");
assert.equal(sanitizeSymbol(null), "?", "a non-string symbol never reaches the page");

// Bitquery has two credential types and they take DIFFERENT headers. Sending
// both at once is what produced an opaque 402 against the V2 endpoint.
assert.deepEqual(bitqueryAuthHeaders("BQYlegacykey"), { "X-API-KEY": "BQYlegacykey" }, "a V1 API key goes in X-API-KEY");
assert.deepEqual(bitqueryAuthHeaders("ory_at_abc.def"), { authorization: "Bearer ory_at_abc.def" }, "a V2 OAuth token goes in Authorization: Bearer");
assert.equal("authorization" in bitqueryAuthHeaders("BQYlegacykey"), false, "a V1 key never also sends a Bearer header");
assert.equal("X-API-KEY" in bitqueryAuthHeaders("ory_at_abc.def"), false, "a V2 token never also sends X-API-KEY");

const noKeyScope = createGateway({ ...baseCfg, secret: SECRET, store, publicClient: holderClient });
assert.equal((await noKeyScope.memescope({ ip: "9.9.9.1" })).status, 503, "no Bitquery key = 503, and nothing else is attempted");

// Count real upstream hits by stubbing fetch. `gate` lets the test hold the
// first call open so concurrent callers genuinely overlap.
const realFetch = globalThis.fetch;
let upstreamCalls = 0;
let release;
let gate = new Promise((r) => (release = r));
globalThis.fetch = async () => {
  upstreamCalls++;
  await gate;
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { EVM: { Events: [evt(USDG, MEME), evt(USDG, MEME, "2026-07-29T00:01:00Z", "0xbeef")] } } }),
  };
};

const scopeClient = { readContract: async ({ functionName }) => (functionName === "symbol" ? "PEPE" : 18) };
const ms = createGateway({
  ...baseCfg,
  secret: SECRET,
  store,
  bitqueryKey: "k",
  bitqueryUrl: "https://example.invalid/graphql",
  publicClient: scopeClient,
  tunables: { MEMESCOPE_RATE_PER_MIN: 10_000 },
});

// THE COST PROPERTY: a crowd arriving on a cold cache is ONE upstream query.
// Without single-flight this is one query per viewer, which is how a public
// route on a metered API becomes a bill.
const crowd = Promise.all(Array.from({ length: 50 }, () => ms.memescope({ ip: "9.9.9.2" })));
release();
const answers = await crowd;
assert.equal(upstreamCalls, 1, "50 concurrent viewers cost exactly ONE upstream query");
assert.equal(answers.every((a) => a.status === 200), true, "…and every one of them still got an answer");
assert.equal(answers[0].json.pools.length, 1, "the same token initializing twice is one row, not two");
assert.equal(answers[0].json.pools[0].symbol, "PEPE", "the symbol comes from the contract read");

// And a later viewer inside the TTL adds nothing at all.
await ms.memescope({ ip: "9.9.9.3" });
assert.equal(upstreamCalls, 1, "a call inside the TTL is served from cache — still one query");

// A provider having a bad minute must not blank the page.
globalThis.fetch = async () => {
  upstreamCalls++;
  throw new Error("upstream down");
};
// bitqueryUrl MUST be set on every gateway built here. Omitting it falls back to
// the real streaming.bitquery.io, and this file is meant to touch no network at
// all — an earlier version of this test genuinely called Bitquery with a fake
// key and got a 402 back.
const stale = await createGateway({ ...baseCfg, secret: SECRET, store, bitqueryKey: "k", bitqueryUrl: "https://example.invalid/graphql", publicClient: scopeClient, tunables: { MEMESCOPE_TTL_SEC: 0, MEMESCOPE_RATE_PER_MIN: 10_000 } }).memescope({ ip: "9.9.9.4" });
assert.equal(stale.status, 502, "with nothing cached yet, an upstream failure is an honest 502");

const wasFresh = await ms.memescope({ ip: "9.9.9.5" });
assert.equal(wasFresh.status, 200, "a gateway that already has rows keeps serving them when upstream fails");

globalThis.fetch = realFetch;

// The per-IP cap protects the process; the cache above already protects the bill.
const capped = createGateway({ ...baseCfg, secret: SECRET, store, bitqueryKey: "k", bitqueryUrl: "https://example.invalid/graphql", publicClient: scopeClient, tunables: { MEMESCOPE_RATE_PER_MIN: 1 } });
await capped.memescope({ ip: "9.9.9.6" });
assert.equal((await capped.memescope({ ip: "9.9.9.6" })).status, 429, "the public route is rate-limited per IP");

console.log("[gateway] selftest OK — /bitquery: named queries only, no raw GraphQL, key-gated, own rate bucket");
console.log("[gateway] selftest OK — /memescope: public, one shared query per TTL, single-flight under load, serves stale over blank");

// ── /v1/models, and the model name that must never leave ─────────────────────
//
// The forced model is the one fact this proxy exists to withhold from a caller.
// The brand rewrite used to match only `"model":"<id>"` — the shape of a
// SUCCESS body — so while the forced model was dead (Groq retired the whole
// Llama 3.x line and this gateway kept naming one), every caller read the
// upstream id straight out of the 404 error string.
{
  const list = gw.models();
  assert.equal(list.status, 200, "the models route answers");
  assert.equal(list.json.data.length, 1, "one model, because the gateway forces it");
  assert.equal(list.json.data[0].id, DEFAULTS.BRAND_MODEL ?? "merrymen-fast", "the list names the BRAND, never the upstream");

  const realFetch2 = globalThis.fetch;
  const holder = createGateway({
    ...baseCfg,
    secret: SECRET,
    store,
    model: "upstream-secret-model-id",
    publicClient: { readContract: async () => 10n ** 30n },
  });
  const tok = holder._tokens.issueToken(ADDR);

  // A SUCCESS body still gets the brand.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ model: "upstream-secret-model-id", choices: [] }), { status: 200 });
  const ok = await holder.chat({ token: tok, body: { messages: [] }, ip: "8.8.8.1" });
  assert.equal(ok.status, 200);
  assert.ok(!ok.text.includes("upstream-secret-model-id"), "a success body must not name the upstream model");

  // AND SO DOES A FAILURE — this is the case that leaked.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: { message: "The model `upstream-secret-model-id` does not exist", code: "model_not_found" } }),
      { status: 404 },
    );
  const bad = await holder.chat({ token: tok, body: { messages: [] }, ip: "8.8.8.2" });
  assert.equal(bad.status, 404, "the status passes through — a caller must tell 429 from 404");
  assert.ok(!bad.text.includes("upstream-secret-model-id"), "AN ERROR BODY MUST NOT NAME THE UPSTREAM MODEL EITHER");
  assert.ok(bad.text.includes("does not exist"), "and the caller still learns what went wrong");

  globalThis.fetch = realFetch2;
}

console.log("[gateway] selftest OK — /v1/models lists the brand; the upstream model name leaks on no status");
