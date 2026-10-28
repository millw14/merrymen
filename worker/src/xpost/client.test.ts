/**
 * The X client against a scripted fetch: what it sends, and above all how it
 * sorts X's answers — "X did nothing" versus "X may have acted" is the line the
 * at-most-once sender stands on.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  X_MEDIA_SCOPE,
  X_SCOPES,
  authorizeUrl,
  grantHolds,
  createPost,
  exchangeCode,
  fetchMe,
  newState,
  pkceChallenge,
  pkcePair,
  refreshTokens,
  readMentions,
  revokeToken,
  stateClient,
  uploadImage,
  X_MAX_IMAGE_BYTES,
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
  assert.equal(url.searchParams.get("scope"), "tweet.read tweet.write users.read offline.access media.write");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("state"), "w.s");
  assert.ok(!url.toString().includes("client-secret"), "the secret never goes through a browser");
  assert.deepEqual([...X_SCOPES], ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"]);
});

test("a stored grant holds media.write only when X named it, and an unnamed grant is never read as holding it", async () => {
  assert.equal(grantHolds("tweet.read tweet.write users.read offline.access media.write", X_MEDIA_SCOPE), true);
  // Every grant issued before the card asked for it.
  assert.equal(grantHolds("tweet.read tweet.write users.read offline.access", X_MEDIA_SCOPE), false);
  assert.equal(grantHolds("tweet.write", X_MEDIA_SCOPE), false);
  assert.equal(grantHolds("media.writer", X_MEDIA_SCOPE), false, "a whole word, not a prefix");
  assert.equal(grantHolds("", X_MEDIA_SCOPE), false);
  assert.equal(grantHolds(null, X_MEDIA_SCOPE), false);
  // An answer that names no scope is stored as the posting scopes alone.
  const r = await refreshTokens(APP, "old-refresh", { fetch: scripted(200, { access_token: "acc-12345", refresh_token: "ref-12345", expires_in: 7200 }), nowMs: 1_000 });
  assert.ok(r.ok);
  assert.equal(r.value.scope, "tweet.read tweet.write users.read offline.access");
  assert.equal(grantHolds(r.value.scope, X_MEDIA_SCOPE), false);
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

// ── media ───────────────────────────────────────────────────────────────────

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("an image is uploaded as the owner, base64 in JSON as a tweet_image, and X's media id handed back", async () => {
  const seen: Seen[] = [];
  const r = await uploadImage("acc", PNG, {
    fetch: scripted(200, { data: { id: "1880028106020515840", media_key: "3_1880028106020515840", size: 11, expires_after_secs: 86400 } }, {}, seen),
  });
  assert.deepEqual(r, { ok: true, value: { id: "1880028106020515840" } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "https://api.x.com/2/media/upload");
  assert.equal(seen[0]?.method, "POST");
  assert.equal(seen[0]?.headers.authorization, "Bearer acc");
  assert.equal(seen[0]?.headers["content-type"], "application/json");
  const body = JSON.parse(seen[0]!.body!);
  assert.deepEqual(Object.keys(body).sort(), ["media", "media_category"]);
  assert.equal(body.media_category, "tweet_image");
  assert.deepEqual([...Buffer.from(body.media, "base64")], [...PNG]);
});

test("an upload is refused before X is asked when there is no image or it is over X's 5 MB", async () => {
  const seen: Seen[] = [];
  const f = scripted(200, { data: { id: "1" } }, {}, seen);
  assert.deepEqual(await uploadImage("acc", new Uint8Array(0), { fetch: f }), { ok: false, failure: "invalid", status: null });
  assert.deepEqual(await uploadImage("acc", new Uint8Array(X_MAX_IMAGE_BYTES + 1), { fetch: f }), { ok: false, failure: "invalid", status: null });
  assert.equal(seen.length, 0);
  assert.equal((await uploadImage("acc", new Uint8Array(X_MAX_IMAGE_BYTES), { fetch: f })).ok, true, "exactly 5 MB is X's limit, not over it");
});

test("every refused or unreadable upload is sorted like a post's answer", async () => {
  const at = 1_000_000;
  const cases: [number, unknown, Record<string, string>, unknown][] = [
    [401, { title: "Unauthorized" }, {}, { ok: false, failure: "auth", status: 401 }],
    [403, { title: "Forbidden", detail: "Missing scope media.write" }, {}, { ok: false, failure: "forbidden", status: 403 }],
    [429, {}, { "x-rate-limit-reset": String(at / 1000 + 600) }, { ok: false, failure: "rate", status: 429, resetAtMs: at + 600_000 }],
    [400, { title: "Invalid Request" }, {}, { ok: false, failure: "invalid", status: 400 }],
    [413, "", {}, { ok: false, failure: "invalid", status: 413 }],
    [500, "", {}, { ok: false, failure: "uncertain", status: 500 }],
    [503, "", {}, { ok: false, failure: "uncertain", status: 503 }],
    [200, "not json", {}, { ok: false, failure: "uncertain", status: 200 }],
    [200, { data: {} }, {}, { ok: false, failure: "uncertain", status: 200 }],
    [200, { data: { id: "12345678901234567890" } }, {}, { ok: false, failure: "uncertain", status: 200 }],
    [200, { data: { id: 1880028106020515840 } }, {}, { ok: false, failure: "uncertain", status: 200 }],
    [200, { data: { id: "1880?evil" } }, {}, { ok: false, failure: "uncertain", status: 200 }],
  ];
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const [status, body, headers, want] of cases) {
      assert.deepEqual(await uploadImage("acc", PNG, { fetch: scripted(status, body, headers), nowMs: at }), want, `${status} ${JSON.stringify(body)}`);
    }
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(await uploadImage("acc", PNG, { fetch: throwing }), { ok: false, failure: "uncertain", status: null });
});

test("an upload is bounded by the caller's budget, never past the client's own ten seconds", async () => {
  const aborted: number[] = [];
  const hanging: FetchLike = (_url, init) => new Promise((_, reject) => {
    const started = Date.now();
    init.signal?.addEventListener("abort", () => { aborted.push(Date.now() - started); reject(new Error("aborted")); });
  });
  // The client's abort timer is unref'd (it must never hold a process open), and a
  // hanging fake leaves nothing else pending: on Node 22 the loop empties and the
  // runner cancels this test and the rest of the file. Hold it open while it waits.
  const keep = setInterval(() => {}, 1_000);
  let result;
  try { result = await uploadImage("acc", PNG, { fetch: hanging, timeoutMs: 30 }); } finally { clearInterval(keep); }
  assert.deepEqual(result, { ok: false, failure: "uncertain", status: null });
  assert.equal(aborted.length, 1);
  assert.ok(aborted[0]! < 2_000, `aborted after ${aborted[0]}ms`);
});

test("a post carries X's media ids when it has them, and nothing else becomes one", async () => {
  const seen: Seen[] = [];
  const f = scripted(201, { data: { id: "1840000000000000001" } }, {}, seen);
  assert.equal((await createPost("acc", "sold it", { fetch: f, mediaIds: ["1880028106020515840"] })).ok, true);
  assert.deepEqual(JSON.parse(seen[0]!.body!), { text: "sold it", media: { media_ids: ["1880028106020515840"] } });
  assert.equal((await createPost("acc", "sold it", { fetch: f, mediaIds: ["1880028106020515840"], replyToTweetId: "123" })).ok, true);
  assert.deepEqual(JSON.parse(seen[1]!.body!), { text: "sold it", reply: { in_reply_to_tweet_id: "123" }, media: { media_ids: ["1880028106020515840"] } });
  assert.equal((await createPost("acc", "sold it", { fetch: f, mediaIds: [] })).ok, true);
  assert.deepEqual(JSON.parse(seen[2]!.body!), { text: "sold it" }, "no ids, no media object");
  for (const bad of [["1880?evil"], ["12345678901234567890"], [""], ["1", "2", "3", "4", "5"]]) {
    assert.deepEqual(await createPost("acc", "sold it", { fetch: f, mediaIds: bad }), { ok: false, failure: "invalid", status: null }, JSON.stringify(bad));
  }
  assert.equal(seen.length, 3, "a malformed id never reaches X");
});

test("length is counted the way X counts it", () => {
  assert.equal(xWeightedLength("hello"), 5);
  assert.equal(xWeightedLength("日本"), 4);
  assert.equal(xWeightedLength("ok 🙂"), 5);
  assert.equal(xWeightedLength("é"), 1, "normalised first");
});


test("reply creation preserves its target and rejects malformed targets without a network call", async () => {
  const seen: Seen[] = [];
  const f = scripted(201, { data: { id: "999" } }, {}, seen);
  assert.equal((await createPost("token", "a reply", { fetch: f, replyToTweetId: "123" })).ok, true);
  assert.deepEqual(JSON.parse(seen[0]!.body!), { text: "a reply", reply: { in_reply_to_tweet_id: "123" } });
  assert.equal((await createPost("token", "a reply", { fetch: f, replyToTweetId: "123?evil" })).ok, false);
  assert.equal(seen.length, 1);
});

const MENTION_NOW = Date.parse("2026-09-30T12:00:00Z");
const mention = (id: string, over: Record<string, unknown> = {}) => ({ id, text: "why this coin?", author_id: "222", conversation_id: "100",
  referenced_tweets: [{ type: "replied_to", id: "100" }], created_at: "2026-09-30T11:00:00Z", ...over });

test("mentions paginate completely and retain nested old-thread opt-outs while excluding self and retaining plain opt-out mentions", async () => {
  const seen: Seen[] = [];
  const pages = [
    { data: [mention("300"), mention("299", { text: "STOP", conversation_id: "50", referenced_tweets: [{ type: "replied_to", id: "51" }], created_at: "2026-09-01T12:00:00Z" })], meta: { result_count: 2, next_token: "next" } },
    { data: [mention("298", { author_id: "111" }), mention("297", { text: "STOP", referenced_tweets: [], conversation_id: "297" })], meta: { result_count: 2 } },
  ];
  const r = await readMentions("token", "111", { nowMs: MENTION_NOW, sinceId: "200", fetch: async (u, i) => scripted(200, pages.shift(), {}, seen)(u, i) });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.replies.map((x) => [x.id, x.inReplyToTweetId]), [["300", "100"], ["299", "51"], ["297", ""]]);
  assert.equal(r.value.newestId, "300");
  assert.equal(new URL(seen[0]!.url).pathname, "/2/users/111/mentions");
  assert.equal(new URL(seen[0]!.url).searchParams.get("since_id"), "200");
  assert.equal(new URL(seen[1]!.url).searchParams.get("pagination_token"), "next");
  assert.ok(seen.every((x) => x.method === "GET" && x.headers.authorization === "Bearer token"));
});

test("a quote or a retweet is marked, so nothing is ever answered under a post code cannot read (red-team 2026-10-12)", async () => {
  const body = { data: [
    // T5: a quote tweet of a post nobody here can read; and a reply that also quotes one.
    mention("300", { text: "@pine_stoat what model do you run on?", conversation_id: "300", referenced_tweets: [{ type: "quoted", id: "100000000000000006" }] }),
    mention("299", { referenced_tweets: [{ type: "replied_to", id: "100" }, { type: "quoted", id: "7" }] }),
    mention("298", { text: "RT @someone: what model", conversation_id: "298", referenced_tweets: [{ type: "retweeted", id: "8" }] }),
    mention("297"),
    mention("296", { conversation_id: "296", referenced_tweets: [] }),
  ], meta: { result_count: 5 } };
  const r = await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, body) });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.replies.map((x) => [x.id, x.quoted ?? false]), [["300", true], ["299", true], ["298", true], ["297", false], ["296", false]]);
  assert.ok(!("quoted" in r.value.replies[3]!), "absent, not false, on a plain reply");
  // WHICH POST A QUOTE QUOTES (2026-10-12): a quote of one of its own posts may be answered; a retweet never says what it quotes.
  assert.deepEqual(r.value.replies.map((x) => [x.id, x.quotedTweetId ?? null]), [["300", "100000000000000006"], ["299", "7"], ["298", null], ["297", null], ["296", null]]);
});

test("a quote names the post it quotes only when that is all it refers to besides its parent, by an id X could have sent (2026-10-12)", async () => {
  const body = { data: [
    mention("300", { conversation_id: "300", referenced_tweets: [{ type: "quoted", id: "100000000000000006" }, { type: "retweeted", id: "8" }] }),
    mention("299", { conversation_id: "299", referenced_tweets: [{ type: "quoted", id: "6" }, { type: "quoted", id: "7" }] }),
    mention("298", { conversation_id: "298", referenced_tweets: [{ type: "quoted", id: "not-an-id" }] }),
    mention("297", { conversation_id: "297", referenced_tweets: [{ type: "quoted" }] }),
    mention("296", { conversation_id: "296", referenced_tweets: [null] }),
  ], meta: { result_count: 5 } };
  const r = await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, body) });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  for (const x of r.value.replies) {
    assert.equal(x.quoted, true, x.id);
    assert.equal(x.quotedTweetId, undefined, x.id);
  }
});

test("a poll, media, a card or a long post's rest is marked, and the author X expanded is read (red-team 2026-10-12)", async () => {
  const seen: Seen[] = [];
  const body = { data: [
    // The reproduced tag: the plain model question with a poll attached, from author 888.
    mention("100000000000000040", { text: "@pine_stoat what model are you?", author_id: "888", conversation_id: "100000000000000040", referenced_tweets: [],
      attachments: { poll_ids: ["1199786642468413448"] } }),
    mention("299", { attachments: { media_keys: ["3_1"] } }),
    mention("298", { card_uri: "card://123" }),
    mention("297", { note_tweet: { text: "a long post" } }),
    mention("296", { attachments: "garbled" }),
    mention("295", { attachments: {}, author_id: "999" }),
    mention("294", { author_id: "777" }),
  ], includes: { users: [{ id: "888", username: "Sherwood1Token", name: "SHERWOOD-1 presale LIVE" }, { id: "222", username: "reader", name: "A Reader" },
    { id: "777", username: 7, name: "bad" }] }, meta: { result_count: 7 } };
  const r = await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, body, {}, seen) });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.replies.map((x) => [x.id, x.attached ?? false]),
    [["100000000000000040", true], ["299", true], ["298", true], ["297", true], ["296", true], ["295", false], ["294", false]]);
  assert.deepEqual(r.value.replies[0]!.author, { username: "Sherwood1Token", name: "SHERWOOD-1 presale LIVE" });
  assert.deepEqual(r.value.replies[1]!.author, { username: "reader", name: "A Reader" });
  assert.equal(r.value.replies[5]!.author, undefined, "an author X did not expand is unknown");
  assert.equal(r.value.replies[6]!.author, undefined, "and so is a malformed one");
  const q = new URL(seen[0]!.url).searchParams;
  assert.deepEqual(q.get("tweet.fields")!.split(",").sort(), ["attachments", "author_id", "card_uri", "conversation_id", "created_at", "entities", "note_tweet", "referenced_tweets"]);
  assert.equal(q.get("expansions"), "author_id,referenced_tweets.id,referenced_tweets.id.author_id");
  assert.equal(q.get("user.fields"), "username,name,url,entities");
});

test("what a tag sits under is read for a larp check: its words, its links and its author's profile link, and nothing malformed fails the batch (2026-10-13)", async () => {
  const body = { data: [
    // "@proj @alanaidale larp check", replying to the project's post, which links its site.
    mention("400", { text: "@proj @alanaidale larp check", conversation_id: "390", referenced_tweets: [{ type: "replied_to", id: "390" }],
      entities: { urls: [{ url: "https://t.co/a", expanded_url: "https://x.com/proj/status/390" }] } }),
    // A quote of a post whose long text and link X sent as a note.
    mention("401", { text: "@alanaidale is this real?", referenced_tweets: [{ type: "quoted", id: "391" }],
      entities: { urls: [{ url: "https://t.co/b", expanded_url: "https://acme.example/app", unwound_url: "https://acme.example/app?ref=x" }, { expanded_url: "javascript:alert(1)" }, 7] } }),
    // A reply under a post X did not expand: no context, still a reply.
    mention("402", { text: "@alanaidale check this", conversation_id: "392", referenced_tweets: [{ type: "replied_to", id: "392" }] }),
  ], includes: {
    users: [{ id: "555", username: "proj", name: "Proj", url: "https://t.co/p", entities: { url: { urls: [{ url: "https://t.co/p", expanded_url: "https://proj.example" }] } } }],
    tweets: [
      { id: "390", author_id: "555", text: "we are live https://t.co/z", entities: { urls: [{ url: "https://t.co/z", expanded_url: "https://proj.example/launch" }] } },
      { id: "391", author_id: "556", text: "short", note_tweet: { text: "the whole long post with CA 0x86aF99052DB086a66aF7D764bB04d3abb81b485F", entities: { urls: [{ expanded_url: "https://acme.example" }] } } },
      { id: "bad", text: 9 },
    ],
  }, meta: { result_count: 3 } };
  const r = await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, body) });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const [a, b, c] = r.value.replies;
  assert.deepEqual(a!.links, ["https://x.com/proj/status/390"]);
  assert.deepEqual(a!.context, [{ id: "390", relation: "replied_to", text: "we are live https://t.co/z", links: ["https://proj.example/launch"], authorId: "555",
    author: { username: "proj", name: "Proj", url: "https://proj.example" } }]);
  assert.deepEqual(b!.links, ["https://acme.example/app?ref=x"], "the unwound destination, and nothing that is not a web link");
  assert.deepEqual(b!.context?.map((x) => [x.relation, x.text.startsWith("the whole long post"), x.links, x.author]), [["quoted", true, ["https://acme.example"], undefined]]);
  assert.equal(c!.context, undefined);
  assert.equal(c!.links, undefined);
  // What X did not hand over is marked unread: the unexpanded parent, and the quoted post whose author X sent no profile for.
  assert.deepEqual([a!.contextUnread, b!.contextUnread, c!.contextUnread], [undefined, true, true]);
});

/** X's own error for a post it could not expand beside a page: deleted, protected, or from a suspended account. */
const missing = (id: string, over: Record<string, unknown> = {}) => ({ value: id, detail: `Could not find tweet with referenced_tweets.id: [${id}].`, title: "Not Found Error",
  resource_type: "tweet", parameter: "referenced_tweets.id", resource_id: id, type: "https://api.twitter.com/2/problems/resource-not-found", ...over });

test("a page whose only errors are posts or authors X could not expand is read whole, and those tags say what they sit under is unread (2026-10-18)", async () => {
  const body = { data: [
    // A STOP and a question under a post someone deleted; a quote of a protected post; a reply whose parent's author is suspended; a plain one.
    mention("300", { text: "@alanaidale stop", conversation_id: "390", referenced_tweets: [{ type: "replied_to", id: "390" }] }),
    mention("299", { text: "@alanaidale is this real?", conversation_id: "299", referenced_tweets: [{ type: "quoted", id: "391" }] }),
    mention("298", { text: "@alanaidale larp check", conversation_id: "392", referenced_tweets: [{ type: "replied_to", id: "392" }] }),
    mention("297"),
  ], includes: {
    users: [{ id: "222", username: "reader", name: "A Reader" }, { id: "555", username: "op", name: "Original Poster" }],
    tweets: [{ id: "392", author_id: "556", text: "we are live" }, { id: "100", author_id: "555", text: "gm" }],
  }, errors: [
    missing("390"),
    missing("391", { title: "Authorization Error", detail: "Sorry, you are not authorized to see the Tweet with referenced_tweets.id: [391].", type: "https://api.twitter.com/2/problems/not-authorized-for-resource" }),
    { value: "556", detail: "User has been suspended: [556].", title: "Forbidden", resource_type: "user", parameter: "referenced_tweets.id.author_id", resource_id: "556", type: "https://api.twitter.com/2/problems/resource-not-found" },
  ], meta: { result_count: 4 } };
  const r = await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, body) });
  assert.equal(r.ok, true, "read whole, its STOP with it");
  if (!r.ok) return;
  assert.deepEqual(r.value.replies.map((x) => [x.id, x.text, x.contextUnread ?? false]),
    [["300", "@alanaidale stop", true], ["299", "@alanaidale is this real?", true], ["298", "@alanaidale larp check", true], ["297", "why this coin?", false]]);
  assert.equal(r.value.newestId, "300");
  assert.equal(r.value.replies[0]!.context, undefined, "nothing of a post X did not send");
  assert.deepEqual(r.value.replies[2]!.context?.map((c) => [c.id, c.author]), [["392", undefined]], "the post, with no author X did not send");
  assert.deepEqual(r.value.replies[3]!.context?.map((c) => [c.id, c.author?.username]), [["100", "op"]]);
  // A tag's own author X could not expand: read whole, the author unknown.
  const author = await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, { data: [mention("300", { author_id: "777" })], meta: { result_count: 1 },
    errors: [{ value: "777", detail: "Could not find user with author_id: [777].", title: "Not Found Error", resource_type: "user", parameter: "author_id", resource_id: "777" }] }) });
  assert.equal(author.ok, true);
  if (author.ok) assert.equal(author.value.replies[0]!.author, undefined);
});

test("any other error beside a page still fails it closed, as does an expansion miss off its shape (2026-10-18)", async () => {
  // 301 replies to 300, so a miss naming 300 is one a tag refers to, and still a post on the page.
  const page = (errors: unknown, data = [mention("300"), mention("301", { referenced_tweets: [{ type: "replied_to", id: "300" }] })]) => ({ data, meta: { result_count: data.length }, errors });
  assert.equal((await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, page([missing("100")])) })).ok, true, "the shape that is read past");
  const cases: [string, unknown][] = [
    ["no shape at all", [{ detail: "partial read" }]],
    ["a parameter this read never asked for", [missing("100", { parameter: "pinned_tweet_id" })]],
    ["a tweet it says it could not find, that is on the page", [missing("300")]],
    ["a post no tag on the page refers to", [missing("390")]],
    ["the wrong kind for the expansion", [missing("100", { resource_type: "user" })]],
    ["a user miss named as a tweet", [{ value: "555", resource_type: "tweet", parameter: "referenced_tweets.id.author_id", resource_id: "555" }]],
    ["an id that is no id", [missing("abc")]],
    ["a value that is not the id", [missing("100", { value: "101" })]],
    ["no id", [missing("100", { resource_id: undefined })]],
    ["one miss beside one other error", [missing("100"), { title: "Internal Error", detail: "partial read" }]],
    ["an empty list", []],
    ["not a list", { detail: "partial read" }],
    ["null", null],
    ["an entry that is no object", ["referenced_tweets.id"]],
  ];
  for (const [what, errors] of cases) {
    assert.equal((await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, page(errors)) })).ok, false, what);
  }
  // The checks that stay: a malformed tag beside a miss, and the eight hundred.
  assert.equal((await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, page([missing("100")], [mention("300", { created_at: "not time" })])) })).ok, false);
  assert.equal((await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, page([missing("100")], [mention("300")])) })).ok, true);
  let calls = 0;
  const flood = await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: async (u, i) => {
    calls++;
    const data = Array.from({ length: 100 }, (_, k) => mention(String(100000 - calls * 100 - k)));
    return scripted(200, { data, meta: { result_count: 100, next_token: `page-${calls}` }, errors: [missing("100")] })(u, i);
  } });
  assert.equal(flood.ok, false, "past eight hundred mentions, misses or not");
  assert.equal(calls, 8);
});

test("mentions fail closed for incomplete pages, broken reply metadata and repeated cursors", async () => {
  const cases = [
    { data: [mention("300", { author_id: undefined })], meta: { result_count: 1 } },
    { data: [mention("300", { created_at: "not time" })], meta: { result_count: 1 } },
    { data: [mention("300", { conversation_id: "bad" })], meta: { result_count: 1 } },
    { data: [mention("300")], meta: { result_count: 2 } },
    { data: [mention("300")], meta: { result_count: 1 }, errors: [{ detail: "partial read" }] },
    { data: [mention("300")], meta: { result_count: 1, next_token: "same" } },
  ];
  for (const body of cases) assert.equal((await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, body) })).ok, false);
  let calls = 0;
  const r = await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: async (u, i) => {
    calls++;
    return scripted(calls === 1 ? 200 : 429, calls === 1 ? { data: [mention("300")], meta: { result_count: 1, next_token: "next" } } : {})(u, i);
  } });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.failure, "rate");
  assert.equal(calls, 2);
  assert.deepEqual(await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, { meta: { result_count: 0 } }) }), { ok: true, value: { replies: [], newestId: null } });
});

test("mentions stop after eight pages and never return a partial successful batch", async () => {
  let calls = 0;
  const r = await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: async (u, i) => {
    calls++;
    return scripted(200, { data: [mention(String(500 - calls))], meta: { result_count: 1, next_token: `page-${calls}` } })(u, i);
  } });
  assert.equal(calls, 8);
  assert.equal(r.ok, false);
});


test("a full mentions page uses a bounded size budget that fits multibyte text", async () => {
  const data = Array.from({ length: 100 }, (_, i) => mention(String(1000 + i), { text: "🙂".repeat(140) }));
  const body = JSON.stringify({ data, meta: { result_count: 100 } });
  assert.ok(Buffer.byteLength(body) > 64 * 1024, "ordinary emoji posts can exceed the token response budget");
  const fetch: FetchLike = async () => new Response(body, { status: 200 });
  const r = await readMentions("token", "111", { nowMs: MENTION_NOW, fetch });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.replies.length, 100);
  const tooLarge: FetchLike = async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 });
  assert.equal((await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: tooLarge })).ok, false);
  assert.equal((await createPost("token", "post", { fetch })).ok, false, "ordinary post responses still use the smaller budget");
});

test("mentions arriving during a request are valid, while far-future timestamps fail closed", async () => {
  const recent = mention("300", { created_at: new Date(MENTION_NOW + 1000).toISOString() });
  const r = await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    return new Response(JSON.stringify({ data: [recent], meta: { result_count: 1 } }), { status: 200 });
  } });
  assert.equal(r.ok, true);
  const future = mention("301", { created_at: new Date(MENTION_NOW + 60 * 60_000).toISOString() });
  assert.equal((await readMentions("token", "111", { nowMs: MENTION_NOW, fetch: scripted(200, { data: [future], meta: { result_count: 1 } }) })).ok, false);
});


test("initial mentions polling starts at consent, then a cursor takes precedence", async () => {
  const seen: Seen[] = [];
  const fetch = scripted(200, { meta: { result_count: 0 } }, {}, seen);
  const startTimeMs = MENTION_NOW - 60_001;
  await readMentions("token", "111", { nowMs: MENTION_NOW, startTimeMs, fetch });
  const first = new URL(seen[0]!.url).searchParams;
  assert.equal(first.get("start_time"), new Date(Math.floor(startTimeMs / 1000) * 1000).toISOString());
  assert.equal(first.has("since_id"), false);
  await readMentions("token", "111", { nowMs: MENTION_NOW, startTimeMs, sinceId: "300", fetch });
  const second = new URL(seen[1]!.url).searchParams;
  assert.equal(second.get("since_id"), "300");
  assert.equal(second.has("start_time"), false);
  for (const bad of [NaN, Infinity, -1, MENTION_NOW + 1]) {
    assert.equal((await readMentions("token", "111", { nowMs: MENTION_NOW, startTimeMs: bad, fetch })).ok, false);
  }
  assert.equal(seen.length, 2);
});
