/**
 * Sending one post against a real (in-memory) sqlite and a scripted X: every
 * branch of docs/x-posting.md rule 4 — the claim, the refresh stored before
 * it is used, the rotation race, one retry for a 401, and "may have acted"
 * being final.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { wrapSqlite, type Db } from "../db";
import type { FetchLike, XApp } from "./client";
import { APP_PAUSE_KEY, APP_PAUSE_MS, CREDITS_PAUSE_MS, PAUSE_KEY, RETRY_AFTER_MS, sendOne } from "./sender";
import {
  ensureXpostSchema,
  getAccount,
  keyStatus,
  postsOf,
  readMeta,
  readTokens,
  schedulePost,
  setPosting,
  swapTokens,
  upsertAccount,
  type TokenSetPlain,
  type XPost,
} from "./store";

const OWNER = `0x${"cd".repeat(20)}`;
const DEK = randomBytes(32);
const APP: XApp = { clientId: "client-id", clientSecret: "client-secret", redirectUri: "https://app.test/connect/x" };
const NOW = 1_800_000_000_000;
const BODY = "picked up some pepe on paper, the curve looked early";

const FRESH: TokenSetPlain = { accessToken: "access-one", refreshToken: "refresh-one", accessExpiresAtMs: NOW + 60 * 60_000, scope: "tweet.write" };
const EXPIRING: TokenSetPlain = { ...FRESH, accessExpiresAtMs: NOW + 60_000 };

interface Seen {
  url: string;
  auth: string;
  body?: string;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "throw" | ((seen: Seen) => Promise<Reply> | Reply);

/** X, scripted: each call takes the next reply in order, and every request is recorded. */
function scripted(replies: Reply[], seen: Seen[] = []): FetchLike {
  return async (url, init) => {
    const s = { url, auth: init.headers.authorization ?? "", body: init.body };
    seen.push(s);
    let r = replies.shift();
    if (r === undefined) throw new Error(`unexpected call to ${url}`);
    while (typeof r === "function") r = await r(s);
    if (r === "throw") throw new Error("socket hang up");
    const reply = r;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
    return { status: reply.status, headers: { get: (n: string) => reply.headers?.[n.toLowerCase()] ?? null }, text: async () => text };
  };
}

const created = (id = "1840000000000000001"): Reply => ({ status: 201, body: { data: { id, text: BODY } } });
const token = (access: string, refresh: string): Reply => ({ status: 200, body: { access_token: access, refresh_token: refresh, expires_in: 7200, scope: "tweet.write" } });

async function setup(t: { after(fn: () => void): void }, tokens: TokenSetPlain = FRESH): Promise<{ db: Db; post: XPost }> {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const db = wrapSqlite(raw);
  await ensureXpostSchema(db, "sqlite");
  await upsertAccount(db, DEK, { tenant: OWNER, xUserId: "111", username: "robin_trades", tokens, nowMs: NOW - 1000 });
  await setPosting(db, OWNER, { enabled: true, xUserId: "111" }, NOW - 900);
  await schedulePost(db, { tenant: OWNER, xUserId: "111", kind: "buy", dedupeKey: "buy:d1", body: BODY, coin: "pepe", decisionId: "d1", dueAtMs: NOW - 1, nowMs: NOW - 100 });
  const [post] = await postsOf(db, OWNER, 0);
  return { db, post: post! };
}

async function row(db: Db): Promise<XPost> {
  return (await postsOf(db, OWNER, 0))[0]!;
}

test("a fresh token posts once, and the post is recorded with its id", async (t) => {
  const { db, post } = await setup(t);
  const seen: Seen[] = [];
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([created()], seen), nowMs: NOW }), "posted");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "https://api.x.com/2/tweets");
  assert.equal(seen[0]?.auth, "Bearer access-one");
  assert.deepEqual(JSON.parse(seen[0]!.body!), { text: BODY });
  const r = await row(db);
  assert.equal(r.status, "posted");
  assert.equal(r.tweetId, "1840000000000000001");
  assert.equal(r.sentAtMs, NOW);
});

test("a post somebody else claimed is not sent", async (t) => {
  const { db, post } = await setup(t);
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([created()]), nowMs: NOW }), "posted");
  const seen: Seen[] = [];
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([created()], seen), nowMs: NOW + 1 }), "lost");
  assert.equal(seen.length, 0, "X is never called for a post this sender did not claim");
});

test("a token about to expire is refreshed, and the new pair is stored BEFORE it is used", async (t) => {
  const { db, post } = await setup(t, EXPIRING);
  const seen: Seen[] = [];
  const before = await readTokens(db, DEK, OWNER);
  const check: Reply = async () => {
    // At the moment X is asked to post, the rotated pair is already stored.
    const stored = await readTokens(db, DEK, OWNER);
    assert.equal(stored?.accessToken, "access-two");
    assert.equal(stored?.refreshToken, "refresh-two");
    assert.equal(stored?.version, before!.version + 1);
    return created();
  };
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([token("access-two", "refresh-two"), check], seen), nowMs: NOW }), "posted");
  assert.equal(seen[0]?.url, "https://api.x.com/2/oauth2/token");
  assert.equal(new URLSearchParams(seen[0]?.body).get("refresh_token"), "refresh-one");
  assert.equal(seen[1]?.auth, "Bearer access-two");
});

test("the rotation race: a swap that loses uses what won, when it is fresh", async (t) => {
  const { db, post } = await setup(t, EXPIRING);
  const seen: Seen[] = [];
  const v = (await readTokens(db, DEK, OWNER))!.version;
  // Another replica refreshes and stores its pair while ours is in flight.
  const otherWins: Reply = async () => {
    assert.equal(await swapTokens(db, DEK, OWNER, v, { ...FRESH, accessToken: "access-winner", refreshToken: "refresh-winner" }, NOW), true);
    return token("access-loser", "refresh-loser");
  };
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([otherWins, created()], seen), nowMs: NOW }), "posted");
  assert.equal(seen[1]?.auth, "Bearer access-winner", "the pair that lost is dropped, never used");
  assert.equal((await readTokens(db, DEK, OWNER))?.refreshToken, "refresh-winner", "and never stored");
});

test("the rotation race: when what won is not fresh either, the post waits five minutes — nothing was sent", async (t) => {
  const { db, post } = await setup(t, EXPIRING);
  const seen: Seen[] = [];
  const v = (await readTokens(db, DEK, OWNER))!.version;
  const otherWinsStale: Reply = async () => {
    await swapTokens(db, DEK, OWNER, v, { ...EXPIRING, accessToken: "access-winner-stale" }, NOW);
    return token("access-loser", "refresh-loser");
  };
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([otherWinsStale], seen), nowMs: NOW }), "retry");
  assert.equal(seen.length, 1, "no post call");
  const r = await row(db);
  assert.equal(r.status, "scheduled");
  assert.equal(r.dueAtMs, NOW + RETRY_AFTER_MS);
});

test("a refresh X refuses outright revokes the connection and fails the post", async (t) => {
  const { db, post } = await setup(t, EXPIRING);
  await schedulePost(db, { tenant: OWNER, xUserId: "111", kind: "casual", dedupeKey: "casual:other", body: "another draft", dueAtMs: NOW + 1, nowMs: NOW });
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([{ status: 400, body: { error: "invalid_grant" } }]), nowMs: NOW }), "revoked");
  const a = await getAccount(db, OWNER);
  assert.equal(a?.status, "revoked");
  assert.equal(a?.posting, false);
  assert.equal(await keyStatus(db, "buy:d1"), "failed");
  assert.equal((await postsOf(db, OWNER, 0)).find((p) => p.dedupeKey === "buy:d1")?.reason, "revoked");
  assert.equal(await keyStatus(db, "casual:other"), "cancelled", "every other draft is cancelled with it");
});

test("a refused refresh token that another sender already spent is not a revocation: what won is used", async (t) => {
  const { db, post } = await setup(t, EXPIRING);
  await schedulePost(db, { tenant: OWNER, xUserId: "111", kind: "casual", dedupeKey: "casual:other", body: "another draft", dueAtMs: NOW + 1, nowMs: NOW });
  const seen: Seen[] = [];
  const v = (await readTokens(db, DEK, OWNER))!.version;
  // A lease handover: the other replica traded the same single-use token a
  // moment earlier and stored its pair; X refuses ours as already spent.
  const otherSpentIt: Reply = async () => {
    assert.equal(await swapTokens(db, DEK, OWNER, v, { ...FRESH, accessToken: "access-winner", refreshToken: "refresh-winner" }, NOW), true);
    return { status: 400, body: { error: "invalid_request", error_description: "Value passed for the token was invalid." } };
  };
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([otherSpentIt, created()], seen), nowMs: NOW }), "posted");
  assert.equal(seen[1]?.auth, "Bearer access-winner");
  const a = await getAccount(db, OWNER);
  assert.equal(a?.status, "ok");
  assert.equal(await keyStatus(db, "casual:other"), "scheduled", "nothing is cancelled");
  assert.equal((await readTokens(db, DEK, OWNER))?.refreshToken, "refresh-winner", "the winner's pair survives");
});

test("a refused refresh after the row moved on, with nothing fresh to use, waits — it does not revoke", async (t) => {
  const { db, post } = await setup(t, EXPIRING);
  const v = (await readTokens(db, DEK, OWNER))!.version;
  const otherSpentItStale: Reply = async () => {
    await swapTokens(db, DEK, OWNER, v, { ...EXPIRING, accessToken: "access-winner-stale", refreshToken: "refresh-winner" }, NOW);
    return { status: 400, body: { error: "invalid_grant" } };
  };
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([otherSpentItStale]), nowMs: NOW }), "retry");
  assert.equal((await getAccount(db, OWNER))?.status, "ok");
  const r = await row(db);
  assert.equal(r.status, "scheduled");
  assert.equal(r.dueAtMs, NOW + RETRY_AFTER_MS);
});

test("a refresh answer without a refresh token keeps the one stored, and the next refresh uses it", async (t) => {
  const { db, post } = await setup(t, EXPIRING);
  const accessOnly: Reply = { status: 200, body: { access_token: "access-two", expires_in: 60, scope: "tweet.write" } };
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([accessOnly, created()]), nowMs: NOW }), "posted");
  const kept = await readTokens(db, DEK, OWNER);
  assert.equal(kept?.accessToken, "access-two");
  assert.equal(kept?.refreshToken, "refresh-one", "not erased");

  await schedulePost(db, { tenant: OWNER, xUserId: "111", kind: "casual", dedupeKey: "casual:next", body: "another draft", dueAtMs: NOW + 1, nowMs: NOW });
  const next = (await postsOf(db, OWNER, 0)).find((p) => p.dedupeKey === "casual:next")!;
  const seen: Seen[] = [];
  assert.equal(await sendOne(db, DEK, APP, next, { fetch: scripted([token("access-three", "refresh-three"), created("1840000000000000002")], seen), nowMs: NOW + 1_000 }), "posted");
  assert.equal(new URLSearchParams(seen[0]?.body).get("refresh_token"), "refresh-one");
  assert.equal((await getAccount(db, OWNER))?.status, "ok");
});

test("a refresh that did not land — rate, outage, a malformed answer — waits five minutes; nothing was sent", async (t) => {
  for (const reply of [{ status: 429, body: {} }, { status: 503, body: "" }, "throw" as const, { status: 400, body: { error: "unsupported_grant_type" } }]) {
    const { db, post } = await setup(t, EXPIRING);
    const seen: Seen[] = [];
    assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([reply], seen), nowMs: NOW }), "retry", JSON.stringify(reply));
    assert.equal(seen.length, 1);
    const r = await row(db);
    assert.equal(r.status, "scheduled");
    assert.equal(r.dueAtMs, NOW + RETRY_AFTER_MS);
  }
});

test("a token endpoint that refuses the APP's credentials revokes nobody: the post waits and the fleet pauses", async (t) => {
  for (const [label, replies] of [
    ["expiring token", [{ status: 401, body: { error: "unauthorized_client" } }]],
    ["forced refresh after a 401", [{ status: 401, body: {} }, { status: 401, body: { error: "invalid_client" } }]],
  ] as [string, Reply[]][]) {
    const { db, post } = await setup(t, label === "expiring token" ? EXPIRING : FRESH);
    await schedulePost(db, { tenant: OWNER, xUserId: "111", kind: "casual", dedupeKey: "casual:other", body: "another draft", dueAtMs: NOW + 1, nowMs: NOW });
    const seen: Seen[] = [];
    assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted(replies, seen), nowMs: NOW }), "app", label);
    assert.equal(seen.filter((s) => s.url.endsWith("/tweets")).length, label === "expiring token" ? 0 : 1, `${label}: no second post call`);
    const a = await getAccount(db, OWNER);
    assert.equal(a?.status, "ok", `${label}: the owner's grant is still good`);
    assert.equal(a?.posting, true);
    assert.equal(await keyStatus(db, "casual:other"), "scheduled", `${label}: no draft is cancelled`);
    const r = (await postsOf(db, OWNER, 0)).find((p) => p.dedupeKey === "buy:d1")!;
    assert.equal(r.status, "scheduled");
    assert.equal(r.dueAtMs, NOW + APP_PAUSE_MS);
    assert.equal((await readMeta(db, APP_PAUSE_KEY))?.v, String(NOW + APP_PAUSE_MS), `${label}: the fleet pauses`);
    assert.equal(await readMeta(db, PAUSE_KEY), null, `${label}: not the credits pause`);
  }
});

test("an expiring token with no refresh token is a dead connection", async (t) => {
  const { db, post } = await setup(t, { ...EXPIRING, refreshToken: null });
  const seen: Seen[] = [];
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([], seen), nowMs: NOW }), "revoked");
  assert.equal(seen.length, 0);
  assert.equal((await getAccount(db, OWNER))?.status, "revoked");
});

test("a 401 gets one forced refresh and one retry", async (t) => {
  const { db, post } = await setup(t);
  const seen: Seen[] = [];
  const out = await sendOne(db, DEK, APP, post, {
    fetch: scripted([{ status: 401, body: { title: "Unauthorized" } }, token("access-two", "refresh-two"), created()], seen),
    nowMs: NOW,
  });
  assert.equal(out, "posted");
  assert.deepEqual(
    seen.map((s) => [s.url, s.auth.startsWith("Bearer") ? s.auth : "basic"]),
    [
      ["https://api.x.com/2/tweets", "Bearer access-one"],
      ["https://api.x.com/2/oauth2/token", "basic"],
      ["https://api.x.com/2/tweets", "Bearer access-two"],
    ],
  );
  assert.equal((await readTokens(db, DEK, OWNER))?.accessToken, "access-two");
});

test("a 401 twice is a revoked connection, and the post fails", async (t) => {
  const { db, post } = await setup(t);
  const seen: Seen[] = [];
  const out = await sendOne(db, DEK, APP, post, {
    fetch: scripted([{ status: 401, body: {} }, token("access-two", "refresh-two"), { status: 401, body: {} }], seen),
    nowMs: NOW,
  });
  assert.equal(out, "revoked");
  assert.equal(seen.length, 3, "one retry, never a third post call");
  assert.equal((await getAccount(db, OWNER))?.status, "revoked", "marked over the version the retry used");
  assert.equal((await row(db)).reason, "revoked");
});

test("a 401 whose forced refresh does not land waits five minutes: X refused, nothing was created", async (t) => {
  const { db, post } = await setup(t);
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([{ status: 401, body: {} }, { status: 503, body: "" }]), nowMs: NOW }), "retry");
  assert.equal((await row(db)).status, "scheduled");
  const again = await setup(t);
  assert.equal(
    await sendOne(again.db, DEK, APP, again.post, { fetch: scripted([{ status: 401, body: {} }, { status: 400, body: { error: "invalid_grant" } }]), nowMs: NOW }),
    "revoked",
  );
});

test("a 429 goes back to scheduled at X's reset", async (t) => {
  const { db, post } = await setup(t);
  const reset = NOW / 1000 + 600;
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([{ status: 429, body: {}, headers: { "x-rate-limit-reset": String(reset) } }]), nowMs: NOW }), "rate");
  const r = await row(db);
  assert.equal(r.status, "scheduled");
  assert.equal(r.dueAtMs, reset * 1000);
});

test("a post whose owner switched off (and on again) while X answered 429 is cancelled, not put back", async (t) => {
  const { db, post } = await setup(t);
  const offThenOn: Reply = async () => {
    await setPosting(db, OWNER, { enabled: false }, NOW + 1);
    await setPosting(db, OWNER, { enabled: true, xUserId: "111" }, NOW + 2);
    return { status: 429, body: {} };
  };
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([offThenOn]), nowMs: NOW }), "cancelled");
  const r = await row(db);
  assert.equal(r.status, "cancelled");
  assert.equal(r.reason, "account-off");
  const offDuringRefresh = await setup(t, EXPIRING);
  const off: Reply = async () => {
    await setPosting(offDuringRefresh.db, OWNER, { enabled: false }, NOW + 1);
    return { status: 503, body: "" };
  };
  assert.equal(await sendOne(offDuringRefresh.db, DEK, APP, offDuringRefresh.post, { fetch: scripted([off]), nowMs: NOW }), "cancelled");
  assert.equal((await row(offDuringRefresh.db)).status, "cancelled");
});

test("out of credits: the post waits an hour and the whole fleet pauses", async (t) => {
  const { db, post } = await setup(t);
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([{ status: 402, body: { title: "CreditsDepleted" } }]), nowMs: NOW }), "credits");
  const r = await row(db);
  assert.equal(r.status, "scheduled");
  assert.equal(r.dueAtMs, NOW + CREDITS_PAUSE_MS);
  assert.equal((await readMeta(db, PAUSE_KEY))?.v, String(NOW + CREDITS_PAUSE_MS));
});

test("duplicate, forbidden and invalid are final", async (t) => {
  const cases: [Reply, string][] = [
    [{ status: 403, body: { detail: "You are not allowed to create a Tweet with duplicate content." } }, "duplicate"],
    [{ status: 403, body: { detail: "You are not permitted to perform this action." } }, "forbidden"],
    [{ status: 400, body: { title: "Invalid Request" } }, "invalid"],
  ];
  for (const [reply, want] of cases) {
    const { db, post } = await setup(t);
    assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([reply]), nowMs: NOW }), want);
    const r = await row(db);
    assert.equal(r.status, "failed");
    assert.equal(r.reason, want);
  }
});

test("an answer that may mean X acted is final and NEVER resent", async (t) => {
  for (const reply of [{ status: 500, body: "" }, { status: 503, body: "" }, "throw" as const, { status: 201, body: "not json" }, { status: 200, body: { data: {} } }]) {
    const { db, post } = await setup(t);
    const seen: Seen[] = [];
    assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([reply], seen), nowMs: NOW }), "uncertain", JSON.stringify(reply));
    const r = await row(db);
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "uncertain");
    assert.equal(await sendOne(db, DEK, APP, r, { fetch: scripted([created()], seen), nowMs: NOW + 60_000 }), "lost");
    assert.equal(seen.length, 1, "one call to X, ever");
  }
});

test("a post written for another X account, or an account that is gone, fails without calling X", async (t) => {
  const { db, post } = await setup(t);
  const seen: Seen[] = [];
  await upsertAccount(db, DEK, { tenant: OWNER, xUserId: "999", username: "someone_else", tokens: FRESH, nowMs: NOW - 10 });
  // upsertAccount cancelled the draft; put the claimable row back as if planned in the same instant.
  await db.prepare(`UPDATE xpost_posts SET status = 'scheduled' WHERE id = ?`).run(post.id);
  assert.equal(await sendOne(db, DEK, APP, post, { fetch: scripted([], seen), nowMs: NOW }), "gone");
  assert.equal(seen.length, 0);
  assert.equal((await row(db)).reason, "gone");
});

test("our own failure is final too, and says nothing secret", async (t) => {
  const { db, post } = await setup(t);
  const seen: Seen[] = [];
  // A DEK that cannot open the tokens: a fault, not "no tokens".
  const out = await sendOne(db, randomBytes(32), APP, post, { fetch: scripted([], seen), nowMs: NOW });
  assert.equal(out, "fault");
  assert.equal(seen.length, 0);
  const r = await row(db);
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "fault");
});

test("the outcome is a short code: never a token, never the body", async (t) => {
  const { db, post } = await setup(t, EXPIRING);
  const outs = [await sendOne(db, DEK, APP, post, { fetch: scripted([token("access-two", "refresh-two"), created()]), nowMs: NOW })];
  for (const o of outs) {
    assert.match(o, /^[a-z]+$/);
    for (const secret of ["access-", "refresh-", "pepe", "client-secret"]) assert.ok(!o.includes(secret));
  }
});
