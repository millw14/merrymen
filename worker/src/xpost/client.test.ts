/**
 * The X client against a scripted fetch: what it sends, and above all how it
 * sorts X's answers — "X did nothing" versus "X may have acted" is the line the
 * at-most-once sender stands on.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  X_SCOPES,
  authorizeUrl,
  createPost,
  exchangeCode,
  fetchMe,
  newState,
  pkceChallenge,
  pkcePair,
  refreshTokens,
  revokeToken,
  stateClient,
  xAppFromEnv,
  xWeightedLength,
  type FetchLike,
  type XApp,
} from "./client";

const APP: XApp = { clientId: "client-id", clientSecret: "client-secret", redirectUri: "https://app.test/connect/x" };

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function scripted(status: number, body: unknown, headers: Record<string, string> = {}, seen: Seen[] = []): FetchLike {
  return async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => text };
  };
}

const throwing: FetchLike = async () => {
  throw new Error("socket hang up");
};

// ── configuration ───────────────────────────────────────────────────────────

test("the app is configured only with both halves, and its callback is built from the public origin", () => {
  assert.equal(xAppFromEnv({}), null);
  assert.equal(xAppFromEnv({ MERRYMEN_X_CLIENT_ID: "id" }), null);
  assert.deepEqual(xAppFromEnv({ MERRYMEN_X_CLIENT_ID: " id ", MERRYMEN_X_CLIENT_SECRET: "s", MERRYMEN_PUBLIC_ORIGIN: "https://app.merrymen.dev/" }), {
    clientId: "id",
    clientSecret: "s",
    redirectUri: "https://app.merrymen.dev/connect/x",
  });
  const explicit = xAppFromEnv({ MERRYMEN_X_CLIENT_ID: "id", MERRYMEN_X_CLIENT_SECRET: "s", MERRYMEN_X_REDIRECT_URI: "http://127.0.0.1:3100/connect/x" });
  assert.equal(explicit?.redirectUri, "http://127.0.0.1:3100/connect/x");
  // Plain http off loopback is not a callback X would honour, nor one we should.
  assert.equal(xAppFromEnv({ MERRYMEN_X_CLIENT_ID: "id", MERRYMEN_X_CLIENT_SECRET: "s", MERRYMEN_PUBLIC_ORIGIN: "http://evil.test" })?.redirectUri, null);
});

test("PKCE is S256 and the authorize URL asks for exactly what posting needs", () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, pkceChallenge(verifier));
  assert.notEqual(challenge, verifier);
  // S256 is BASE64URL(SHA256(ASCII(verifier))), unpadded (RFC 7636 §4.2).
  assert.equal(challenge, createHash("sha256").update(verifier, "ascii").digest("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"));

  const url = new URL(authorizeUrl(APP, { state: "w.s", challenge, redirectUri: APP.redirectUri! }));
  assert.equal(url.origin + url.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.test/connect/x");
  assert.equal(url.searchParams.get("scope"), "tweet.read tweet.write users.read offline.access");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("state"), "w.s");
  assert.ok(!url.toString().includes("client-secret"), "the secret never goes through a browser");
  assert.deepEqual([...X_SCOPES], ["tweet.read", "tweet.write", "users.read", "offline.access"]);
});

test("a state routes the callback page and nothing else", () => {
  const w = newState("web");
  const i = newState("ios");
  assert.equal(stateClient(w), "web");
  assert.equal(stateClient(i), "ios");
  assert.notEqual(newState("web"), w);
  for (const bad of ["", "w.", "x.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "w.short", `w.${"a".repeat(32)}&x=1`, null, 7]) {
    assert.equal(stateClient(bad), null, String(bad));
  }
});

// ── the token endpoint ──────────────────────────────────────────────────────

test("a code is redeemed as a confidential client, and the answer is read with its own lifetime", async () => {
  const seen: Seen[] = [];
  const r = await exchangeCode(
    APP,
    { code: "the-code", verifier: "the-verifier", redirectUri: APP.redirectUri! },
    {
      fetch: scripted(200, { token_type: "bearer", expires_in: 7200, access_token: "acc-12345", refresh_token: "ref-12345", scope: "tweet.write" }, {}, seen),
      nowMs: 1_000,
    },
  );
  assert.deepEqual(r, { ok: true, value: { accessToken: "acc-12345", refreshToken: "ref-12345", accessExpiresAtMs: 1_000 + 7_200_000, scope: "tweet.write" } });
  const [req] = seen;
  assert.equal(req?.url, "https://api.x.com/2/oauth2/token");
  assert.equal(req?.headers.authorization, `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
  const form = new URLSearchParams(req?.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "the-code");
  assert.equal(form.get("code_verifier"), "the-verifier");
  assert.equal(form.get("redirect_uri"), "https://app.test/connect/x");
  assert.equal(form.get("client_secret"), null, "the secret rides in the header, not the form");
});

test("a refused grant, a malformed request and an outage are three different answers", async () => {
  const grant = await refreshTokens(APP, "old", { fetch: scripted(400, { error: "invalid_request", error_description: "Value passed for the token was invalid." }) });
  assert.deepEqual(grant, { ok: false, failure: "grant", status: 400 });
  assert.deepEqual(await refreshTokens(APP, "old", { fetch: scripted(400, { error: "invalid_grant" }) }), { ok: false, failure: "grant", status: 400 });
  assert.deepEqual(await refreshTokens(APP, "old", { fetch: scripted(400, { error: "unsupported_grant_type" }) }), { ok: false, failure: "invalid", status: 400 });
  assert.deepEqual(await refreshTokens(APP, "old", { fetch: scripted(503, "") }), { ok: false, failure: "uncertain", status: 503 });
  assert.deepEqual(await refreshTokens(APP, "old", { fetch: throwing }), { ok: false, failure: "uncertain", status: null });
  // A 200 without a token is not a token.
  assert.deepEqual(await refreshTokens(APP, "old", { fetch: scripted(200, { nope: true }) }), { ok: false, failure: "uncertain", status: 200 });
});

test("the token endpoint refusing the APP's own credentials is never read as the owner's grant", async () => {
  // A rotated or mistyped client secret: RFC 6749 answers 401 invalid_client.
  // Read as "grant", every owner's connection would be revoked in turn.
  for (const [status, body] of [
    [401, { error: "unauthorized_client", error_description: "Missing valid authorization header" }],
    [401, { error: "invalid_client" }],
    [401, {}],
    [400, { error: "invalid_client" }],
    [400, { error: "unauthorized_client" }],
    [401, { error: "invalid_grant" }],
  ] as const) {
    assert.deepEqual(await refreshTokens(APP, "old", { fetch: scripted(status, body) }), { ok: false, failure: "app", status }, JSON.stringify([status, body]));
  }
  assert.deepEqual(await exchangeCode(APP, { code: "c", verifier: "v", redirectUri: APP.redirectUri! }, { fetch: scripted(401, { error: "invalid_client" }) }), {
    ok: false,
    failure: "app",
    status: 401,
  });
  // Only a 400 names the grant itself.
  assert.deepEqual(await refreshTokens(APP, "old", { fetch: scripted(403, { error: "invalid_request" }) }), { ok: false, failure: "invalid", status: 403 });
});

test("a missing or absurd lifetime reads as X's documented two hours", async () => {
  const r = await refreshTokens(APP, "old", { fetch: scripted(200, { access_token: "acc-12345", expires_in: "soon" }), nowMs: 0 });
  assert.equal(r.ok && r.value.accessExpiresAtMs, 7_200_000);
  assert.equal(r.ok && r.value.refreshToken, null);
});

test("nothing X says in an error is echoed back", async () => {
  const leaky = { error: "invalid_grant", error_description: "code the-secret-code was used", access_token: "tok" };
  const r = await exchangeCode(APP, { code: "the-secret-code", verifier: "v", redirectUri: "https://app.test/connect/x" }, { fetch: scripted(400, leaky) });
  assert.ok(!JSON.stringify(r).includes("the-secret-code"));
  assert.ok(!JSON.stringify(r).includes("tok"));
});

test("revoking is best effort and says which", async () => {
  const seen: Seen[] = [];
  assert.deepEqual(await revokeToken(APP, "ref", "refresh_token", { fetch: scripted(200, { revoked: true }, {}, seen) }), { ok: true, value: null });
  assert.equal(new URLSearchParams(seen[0]?.body).get("token_type_hint"), "refresh_token");
  assert.equal(seen[0]?.url, "https://api.x.com/2/oauth2/revoke");
  assert.deepEqual(await revokeToken(APP, "ref", "refresh_token", { fetch: throwing }), { ok: false, failure: "uncertain", status: null });
});

// ── the API ─────────────────────────────────────────────────────────────────

test("users/me names the account, and only a real X handle is accepted", async () => {
  assert.deepEqual(await fetchMe("acc", { fetch: scripted(200, { data: { id: "2244994945", name: "Robin", username: "robin_trades" } }) }), {
    ok: true,
    value: { id: "2244994945", username: "robin_trades" },
  });
  assert.deepEqual(await fetchMe("acc", { fetch: scripted(200, { data: { id: "2244994945", username: "javascript:alert(1)" } }) }), {
    ok: false,
    failure: "invalid",
    status: 200,
  });
  assert.deepEqual(await fetchMe("acc", { fetch: scripted(401, { title: "Unauthorized" }) }), { ok: false, failure: "auth", status: 401 });
});

test("a post is sent as text only, and a created post hands back its id", async () => {
  const seen: Seen[] = [];
  const r = await createPost("acc", "picked up some pepe on paper today", {
    fetch: scripted(201, { data: { id: "1840000000000000001", text: "…", edit_history_tweet_ids: ["1840000000000000001"] } }, {}, seen),
  });
  assert.deepEqual(r, { ok: true, value: { id: "1840000000000000001" } });
  assert.equal(seen[0]?.url, "https://api.x.com/2/tweets");
  assert.equal(seen[0]?.headers.authorization, "Bearer acc");
  assert.deepEqual(JSON.parse(seen[0]!.body!), { text: "picked up some pepe on paper today" });
});

test("every answer to a post is sorted by whether X might have created it", async () => {
  const at = 1_000_000;
  const cases: [number, unknown, Record<string, string>, unknown][] = [
    [401, { title: "Unauthorized" }, {}, { ok: false, failure: "auth", status: 401 }],
    [402, { title: "CreditsDepleted" }, {}, { ok: false, failure: "credits", status: 402 }],
    [403, { detail: "You are not allowed to create a Tweet with duplicate content." }, {}, { ok: false, failure: "duplicate", status: 403 }],
    [403, { title: "CreditsDepleted", detail: "Your enrolled account does not have any credits" }, {}, { ok: false, failure: "credits", status: 403 }],
    [403, { detail: "You are not permitted to perform this action." }, {}, { ok: false, failure: "forbidden", status: 403 }],
    [429, { title: "Too Many Requests" }, { "x-rate-limit-reset": String(at / 1000 + 600) }, { ok: false, failure: "rate", status: 429, resetAtMs: at + 600_000 }],
    [429, {}, {}, { ok: false, failure: "rate", status: 429, resetAtMs: at + 15 * 60_000 }],
    [400, { title: "Invalid Request" }, {}, { ok: false, failure: "invalid", status: 400 }],
    [500, "", {}, { ok: false, failure: "uncertain", status: 500 }],
    [503, "", {}, { ok: false, failure: "uncertain", status: 503 }],
    [201, "not json", {}, { ok: false, failure: "uncertain", status: 201 }],
    [201, { data: {} }, {}, { ok: false, failure: "uncertain", status: 201 }],
  ];
  for (const [status, body, headers, want] of cases) {
    assert.deepEqual(await createPost("acc", "hello there friends", { fetch: scripted(status, body, headers), nowMs: at }), want, `${status} ${JSON.stringify(body)}`);
  }
  assert.deepEqual(await createPost("acc", "hello there friends", { fetch: throwing }), { ok: false, failure: "uncertain", status: null });
});

test("length is counted the way X counts it", () => {
  assert.equal(xWeightedLength("hello"), 5);
  assert.equal(xWeightedLength("日本"), 4);
  assert.equal(xWeightedLength("ok 🙂"), 5);
  assert.equal(xWeightedLength("é"), 1, "normalised first");
});
