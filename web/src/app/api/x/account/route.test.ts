/**
 * AN OWNER'S X CONNECTION, DRIVEN THROUGH THE REAL HANDLERS.
 *
 * Same harness as ../connect/route.test.ts (lib/x-test-kit.ts). What matters
 * most here:
 *
 *   - posting turns on only for the X account the warning named — a request
 *     carrying any other id changes nothing;
 *   - Skip stops only the owner's own post, and only while it is still waiting;
 *   - disconnecting forgets the row, cancels the drafts and revokes at X, and
 *     answers the owner the same whether or not X agreed;
 *   - the owner reads back their connection and drafts, never a token, and a
 *     database that could not be read is never answered as "not connected".
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { OWNER_CHANGED_SETTING } from "@/lib/order-owner";
import { X_COPY, type XAccountBody } from "@/lib/x-connect";
import { OWNER_A, OWNER_B, X_ACCESS, X_REFRESH, X_USER, jsonRequest, xWorld } from "@/lib/x-test-kit";
import { X_REVOKE_URL } from "../../../../../../worker/src/xpost/client";
import {
  claimPost,
  getAccount,
  markPosted,
  markRevoked,
  schedulePost,
  repliesEnabledFor,
  upsertAccount,
  type NewPost,
} from "../../../../../../worker/src/xpost/store";
import { DELETE, GET, POST } from "./route";

let w: Awaited<ReturnType<typeof xWorld>>;

beforeEach(async () => {
  w = await xWorld();
  mock.method(console, "warn", () => {});
});

afterEach(() => {
  mock.restoreAll();
  w.close();
});

const get = (tenant: `0x${string}` | null) => GET(jsonRequest("/api/x/account", "GET", tenant));
const post = (tenant: `0x${string}` | null, body: unknown) => POST(jsonRequest("/api/x/account", "POST", tenant, body));
const del = (tenant: `0x${string}` | null, body: unknown) => DELETE(jsonRequest("/api/x/account", "DELETE", tenant, body));

async function read<T = Record<string, unknown>>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  assert.equal(res.status, status, text);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  return JSON.parse(text) as T;
}

/** Connect `tenant` to an X account directly through the store, as a finished connect would. */
async function connect(tenant: `0x${string}`, who: { id: string; username: string } = X_USER) {
  await upsertAccount(w.db, w.dek, {
    tenant,
    xUserId: who.id,
    username: who.username,
    tokens: { accessToken: X_ACCESS, refreshToken: X_REFRESH, accessExpiresAtMs: w.clock.now + 7_200_000, scope: "tweet.write" },
    nowMs: w.clock.now,
  });
}

let keyN = 0;
async function draft(tenant: `0x${string}`, over: Partial<NewPost> = {}): Promise<number> {
  const id = await schedulePost(w.db, {
    tenant,
    xUserId: X_USER.id,
    kind: "casual",
    dedupeKey: `test:${++keyN}`,
    body: `a passing thought ${keyN}`,
    dueAtMs: w.clock.now + 3_600_000,
    nowMs: w.clock.now,
    ...over,
  });
  assert.ok(id);
  return id;
}

const statusOf = (id: number) => (w.raw.prepare("SELECT status FROM xpost_posts WHERE id = ?").get(id) as { status: string }).status;

describe("who may call it", () => {
  it("is 404 for every verb on a self-hosted install", async () => {
    process.env.MERRYMEN_HOSTED = "0";
    assert.equal((await get(OWNER_A)).status, 404);
    assert.equal((await post(OWNER_A, { action: "disable", owner: OWNER_A })).status, 404);
    assert.equal((await del(OWNER_A, { owner: OWNER_A })).status, 404);
  });

  it("is 401 for every verb signed out", async () => {
    assert.equal((await get(null)).status, 401);
    assert.equal((await post(null, { action: "disable", owner: OWNER_A })).status, 401);
    assert.equal((await del(null, { owner: OWNER_A })).status, 401);
  });

  it("refuses every change that names a different owner than the session, and one that names none", async () => {
    await connect(OWNER_A);
    for (const body of [
      { action: "enable", xUserId: X_USER.id, owner: OWNER_B },
      { action: "disable", owner: OWNER_B },
      { action: "enable-replies", xUserId: X_USER.id, owner: OWNER_B },
      { action: "disable-replies", xUserId: X_USER.id, owner: OWNER_B },
      { action: "skip", id: 1, owner: OWNER_B },
    ]) {
      const res = await post(OWNER_A, body);
      assert.equal((await read(res, 409)).error, OWNER_CHANGED_SETTING);
    }
    assert.equal((await read(await del(OWNER_A, { owner: OWNER_B }), 409)).error, OWNER_CHANGED_SETTING);
    assert.equal((await post(OWNER_A, { action: "enable", xUserId: X_USER.id })).status, 400);
    assert.equal((await del(OWNER_A, {})).status, 400);
    assert.equal((await getAccount(w.db, OWNER_A))?.posting, false);
    assert.ok(await getAccount(w.db, OWNER_A), "and the connection is still there");
  });
});

describe("GET", () => {
  it("says available and not connected for an owner with nothing connected", async () => {
    const body = await read<XAccountBody>(await get(OWNER_A));
    assert.deepEqual(body, {
      available: true,
      connected: false,
      username: null,
      xUserId: null,
      status: null,
      postingEnabled: false,
      prefs: { buys: true, casual: true, perDay: null },
      perDayMax: 3,
      replyEnabled: false,
      repliesAvailable: false,
      upcoming: [],
      recent: [],
    });
  });

  it("names the account X said the token posts as, with posting off until the owner turns it on", async () => {
    await connect(OWNER_A);
    const body = await read<XAccountBody>(await get(OWNER_A));
    assert.equal(body.connected, true);
    assert.equal(body.username, X_USER.username);
    assert.equal(body.xUserId, X_USER.id);
    assert.equal(body.status, "ok");
    assert.equal(body.postingEnabled, false);
  });

  it("NEVER CONTAINS A TOKEN, sealed or not", async () => {
    await connect(OWNER_A);
    await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A });
    await draft(OWNER_A);
    const text = await (await get(OWNER_A)).text();
    const sealed = w.raw.prepare("SELECT sealed_access, sealed_refresh FROM xpost_accounts").get() as Record<string, string>;
    for (const secret of [X_ACCESS, X_REFRESH, sealed.sealed_access, sealed.sealed_refresh]) {
      assert.ok(!text.includes(secret), "a token reached the browser");
    }
    assert.doesNotMatch(text, /token|sealed|scope|version/i);
  });

  it("is another owner's business only to that owner", async () => {
    await connect(OWNER_A);
    await draft(OWNER_A);
    const b = await read<XAccountBody>(await get(OWNER_B));
    assert.equal(b.connected, false);
    assert.deepEqual(b.upcoming, []);
  });

  it("lists what is waiting (soonest first) and what went out (newest first, linked), and nothing else", async () => {
    await connect(OWNER_A);
    const later = await draft(OWNER_A, { body: "later one", dueAtMs: w.clock.now + 7_200_000 });
    const sooner = await draft(OWNER_A, { kind: "buy", body: "sooner one", dueAtMs: w.clock.now + 600_000 });
    const cancelled = await draft(OWNER_A, { body: "cancelled one" });
    w.raw.prepare("UPDATE xpost_posts SET status = 'cancelled' WHERE id = ?").run(cancelled);
    const sent1 = await draft(OWNER_A, { body: "first out" });
    await claimPost(w.db, sent1, w.clock.now);
    await markPosted(w.db, sent1, "1111111111", w.clock.now + 1);
    const sent2 = await draft(OWNER_A, { kind: "intro", body: "second out" });
    await claimPost(w.db, sent2, w.clock.now);
    await markPosted(w.db, sent2, "2222222222", w.clock.now + 2);
    const failed = await draft(OWNER_A, { body: "failed one" });
    await claimPost(w.db, failed, w.clock.now);
    w.raw.prepare("UPDATE xpost_posts SET status = 'failed' WHERE id = ?").run(failed);
    // Written for an account that is no longer the connected one.
    await draft(OWNER_A, { xUserId: "5555", body: "old account's draft" });

    const body = await read<XAccountBody>(await get(OWNER_A));
    assert.deepEqual(body.upcoming, [
      { id: sooner, kind: "buy", body: "sooner one", dueAt: w.clock.now + 600_000 },
      { id: later, kind: "casual", body: "later one", dueAt: w.clock.now + 7_200_000 },
    ]);
    assert.deepEqual(body.recent, [
      { id: sent2, kind: "intro", body: "second out", sentAt: w.clock.now + 2, url: `https://x.com/${X_USER.username}/status/2222222222` },
      { id: sent1, kind: "casual", body: "first out", sentAt: w.clock.now + 1, url: `https://x.com/${X_USER.username}/status/1111111111` },
    ]);
  });

  it("links a post only through a handle that passes X's own rule", async () => {
    await connect(OWNER_A, { id: X_USER.id, username: "javascript:alert(1)" });
    const sent = await draft(OWNER_A, { body: "out" });
    await claimPost(w.db, sent, w.clock.now);
    await markPosted(w.db, sent, "1111111111", w.clock.now);
    const body = await read<XAccountBody>(await get(OWNER_A));
    assert.equal(body.username, null);
    assert.deepEqual(body.recent, []);
  });

  it("says revoked when X stopped honouring the connection", async () => {
    await connect(OWNER_A);
    await markRevoked(w.db, OWNER_A, 1, w.clock.now);
    const body = await read<XAccountBody>(await get(OWNER_A));
    assert.equal(body.status, "revoked");
    assert.equal(body.postingEnabled, false);
  });

  it("says unavailable when the X app is not configured, and still shows what is connected", async () => {
    await connect(OWNER_A);
    delete w.env.MERRYMEN_X_CLIENT_ID;
    const body = await read<XAccountBody>(await get(OWNER_A));
    assert.equal(body.available, false);
    assert.equal(body.connected, true);
  });

  it("A DATABASE THAT CANNOT BE READ IS A 503, NEVER 'NOT CONNECTED'", async () => {
    await connect(OWNER_A);
    w.raw.close();
    const res = await get(OWNER_A);
    const body = await read(res, 503);
    assert.equal(body.connected, undefined);
    assert.equal(body.ownerFacing, true);
  });
});

describe("enable — the warning's confirm", () => {
  it("turns posting on only for the X account the warning named", async () => {
    await connect(OWNER_A);
    const wrong = await post(OWNER_A, { action: "enable", xUserId: "999", owner: OWNER_A });
    assert.equal((await read(wrong, 409)).error, X_COPY.accountChanged);
    assert.equal((await getAccount(w.db, OWNER_A))?.posting, false);

    const right = await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A });
    assert.deepEqual(await read(right), { ok: true, postingEnabled: true });
    const account = await getAccount(w.db, OWNER_A);
    assert.equal(account?.posting, true);
    assert.equal(account?.consentXUserId, X_USER.id);
    assert.equal((await read<XAccountBody>(await get(OWNER_A))).postingEnabled, true);
  });

  it("the account changing between the warning and the confirm changes nothing", async () => {
    await connect(OWNER_A);
    // The owner read a warning naming X_USER; another tab reconnected someone else.
    await connect(OWNER_A, { id: "777", username: "other_account" });
    const res = await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A });
    assert.equal(res.status, 409);
    assert.equal((await getAccount(w.db, OWNER_A))?.posting, false);
  });

  it("is refused with nothing connected, and on a connection X revoked", async () => {
    assert.equal((await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A })).status, 409);
    await connect(OWNER_A);
    await markRevoked(w.db, OWNER_A, 1, w.clock.now);
    assert.equal((await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A })).status, 409);
  });

  it("keeps the zone the consent came from, canonical, for quiet hours when the room has none", async () => {
    await connect(OWNER_A);
    const ok = await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A, tz: "america/new_york" });
    assert.deepEqual(await read(ok), { ok: true, postingEnabled: true });
    assert.equal((await getAccount(w.db, OWNER_A))?.tz, "America/New_York");
  });

  it("a zone that says nothing about where the owner is never refuses the consent, and never replaces a real one", async () => {
    await connect(OWNER_A);
    await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A, tz: "Asia/Tokyo" });
    // Privacy browsers report UTC or Reykjavik for everybody; the rest is not a zone at all.
    for (const tz of ["UTC", "Etc/UTC", "Etc/GMT+5", "GMT", "Atlantic/Reykjavik", "Iceland", "Mars/Olympus", "+05:30", 42, "", null, undefined, "x".repeat(300)]) {
      await post(OWNER_A, { action: "disable", owner: OWNER_A });
      const res = await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A, tz });
      assert.deepEqual(await read(res), { ok: true, postingEnabled: true }, String(tz));
      const account = await getAccount(w.db, OWNER_A);
      assert.equal(account?.posting, true, String(tz));
      assert.equal(account?.tz, "Asia/Tokyo", `${String(tz)} replaced the stored zone`);
    }
  });

  it("a consent with no zone at all stores none", async () => {
    await connect(OWNER_A);
    await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A, tz: "UTC" });
    assert.equal((await getAccount(w.db, OWNER_A))?.tz, null);
  });

  it("refuses an id that is not one, and is unavailable without the X app", async () => {
    await connect(OWNER_A);
    assert.equal((await post(OWNER_A, { action: "enable", xUserId: 1234567890, owner: OWNER_A })).status, 400);
    assert.equal((await post(OWNER_A, { action: "enable", xUserId: "12a", owner: OWNER_A })).status, 400);
    delete w.env.MERRYMEN_X_CLIENT_SECRET;
    assert.equal((await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A })).status, 503);
    assert.equal((await getAccount(w.db, OWNER_A))?.posting, false);
  });
});

describe("disable", () => {
  it("turns posting off and cancels every draft, even without the X app", async () => {
    await connect(OWNER_A);
    await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A });
    const waiting = await draft(OWNER_A);
    delete w.env.MERRYMEN_X_CLIENT_ID;
    const res = await post(OWNER_A, { action: "disable", owner: OWNER_A });
    assert.deepEqual(await read(res), { ok: true, postingEnabled: false });
    assert.equal((await getAccount(w.db, OWNER_A))?.posting, false);
    assert.equal(statusOf(waiting), "cancelled");
  });
});

describe("prefs — what it posts", () => {
  it("reads back the defaults: coins it buys and passing thoughts on, the server's number a day", async () => {
    await connect(OWNER_A);
    const body = await read<XAccountBody>(await get(OWNER_A));
    assert.deepEqual(body.prefs, { buys: true, casual: true, perDay: null });
    assert.equal(body.perDayMax, 3);
  });

  it("changes only the choices given, and reads them back", async () => {
    await connect(OWNER_A);
    assert.deepEqual(await read(await post(OWNER_A, { action: "prefs", owner: OWNER_A, casual: false })), {
      ok: true,
      prefs: { buys: true, casual: false, perDay: null },
    });
    assert.deepEqual(await read(await post(OWNER_A, { action: "prefs", owner: OWNER_A, perDay: 1 })), {
      ok: true,
      prefs: { buys: true, casual: false, perDay: 1 },
    });
    assert.deepEqual((await getAccount(w.db, OWNER_A))?.prefs, { buys: true, casual: false, perDay: 1 });
    assert.deepEqual((await read<XAccountBody>(await get(OWNER_A))).prefs, { buys: true, casual: false, perDay: 1 });
    // null goes back to the server's number.
    assert.deepEqual((await read<{ prefs: unknown }>(await post(OWNER_A, { action: "prefs", owner: OWNER_A, perDay: null }))).prefs, {
      buys: true,
      casual: false,
      perDay: null,
    });
  });

  it("a kind turned off takes its drafts out of Coming up, and leaves the other kinds' alone", async () => {
    await connect(OWNER_A);
    await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A });
    const buy = await draft(OWNER_A, { kind: "buy", coin: "frog", decisionId: "d1" });
    const casual = await draft(OWNER_A);
    const intro = await draft(OWNER_A, { kind: "intro" });
    await read(await post(OWNER_A, { action: "prefs", owner: OWNER_A, buys: false }));
    assert.equal(statusOf(buy), "cancelled");
    assert.equal((w.raw.prepare("SELECT reason FROM xpost_posts WHERE id = ?").get(buy) as { reason: string }).reason, "kind-off");
    assert.equal(statusOf(casual), "scheduled");
    assert.equal(statusOf(intro), "scheduled", "the hello is not a kind the owner turns off");
    assert.equal((await getAccount(w.db, OWNER_A))?.posting, true, "posting itself stays on");
  });

  it("Coming up never lists a kind turned off, even a draft planned as it changed", async () => {
    await connect(OWNER_A);
    await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A });
    await read(await post(OWNER_A, { action: "prefs", owner: OWNER_A, buys: false }));
    // Planned by a pass that read the account before the change landed.
    await draft(OWNER_A, { kind: "buy", coin: "frog", decisionId: "d9", body: "grabbed some frog on paper" });
    await draft(OWNER_A, { body: "a thought that stays" });
    const body = await read<XAccountBody>(await get(OWNER_A));
    assert.deepEqual(body.upcoming.map((p) => p.body), ["a thought that stays"]);
  });

  it("works without the X app, like the off switch", async () => {
    await connect(OWNER_A);
    delete w.env.MERRYMEN_X_CLIENT_ID;
    assert.equal((await post(OWNER_A, { action: "prefs", owner: OWNER_A, buys: false })).status, 200);
  });

  it("refuses with nothing connected, a choice that is not one, a number past the most, and an empty change", async () => {
    assert.equal((await read<{ error: string }>(await post(OWNER_A, { action: "prefs", owner: OWNER_A, buys: false }), 409)).error, X_COPY.notConnected);
    await connect(OWNER_A);
    for (const bad of [{ buys: "no" }, { casual: 0 }, { perDay: 0 }, { perDay: 4 }, { perDay: 1.5 }, { perDay: "2" }, {}]) {
      assert.equal((await post(OWNER_A, { action: "prefs", owner: OWNER_A, ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual((await getAccount(w.db, OWNER_A))?.prefs, { buys: true, casual: true, perDay: null }, "nothing changed");
  });

  it("another owner's choices are theirs alone", async () => {
    await connect(OWNER_A);
    await connect(OWNER_B, { id: "999", username: "other_one" });
    await read(await post(OWNER_A, { action: "prefs", owner: OWNER_A, casual: false }));
    assert.deepEqual((await getAccount(w.db, OWNER_B))?.prefs, { buys: true, casual: true, perDay: null });
  });
});

describe("comment reply consent", () => {
  const reply = (enabled: boolean, xUserId = X_USER.id as string, owner = OWNER_A as string) =>
    post(OWNER_A, { action: enabled ? "enable-replies" : "disable-replies", xUserId, owner });
  const postingOn = () => post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A });
  const replyDraft = async () => {
    const root = await draft(OWNER_A, { kind: "buy" });
    await claimPost(w.db, root, w.clock.now);
    await markPosted(w.db, root, "222", w.clock.now);
    return draft(OWNER_A, { kind: "reply", dedupeKey: `reply:${X_USER.id}:111`, replyToTweetId: "111", replyRootTweetId: "222", replyAuthorId: "333" });
  };

  it("defaults off and requires the operator gate as well as posting consent", async () => {
    await connect(OWNER_A);
    await postingOn();
    assert.equal((await read<XAccountBody>(await get(OWNER_A))).replyEnabled, false);
    assert.equal((await read(await reply(true), 503)).error, X_COPY.repliesUnavailable);
    assert.equal(await repliesEnabledFor(w.db, OWNER_A, X_USER.id), false);
    w.env.MERRYMEN_XPOST_REPLIES_APPROVED = "1";
    await post(OWNER_A, { action: "disable", owner: OWNER_A });
    assert.equal((await read(await reply(true), 409)).error, X_COPY.repliesNeedPosting);
    assert.equal((await read<XAccountBody>(await get(OWNER_A))).repliesAvailable, true);
  });

  it("binds the confirmation to both the signed-in owner and immutable X account", async () => {
    await connect(OWNER_A);
    await postingOn();
    w.env.MERRYMEN_XPOST_REPLIES_APPROVED = "1";
    assert.equal((await reply(true, X_USER.id, OWNER_B)).status, 409);
    assert.equal((await reply(true, "999")).status, 409);
    assert.equal((await post(null, { action: "enable-replies", xUserId: X_USER.id, owner: OWNER_A })).status, 401);
    assert.equal((await post(OWNER_A, { action: "enable-replies", xUserId: X_USER.id })).status, 400);
    assert.equal((await reply(true, "not-an-id")).status, 400);
    assert.equal(await repliesEnabledFor(w.db, OWNER_A, X_USER.id), false);
    assert.deepEqual(await read(await reply(true)), { ok: true, replyEnabled: true });
    assert.equal((await read<XAccountBody>(await get(OWNER_A))).replyEnabled, true);
    await connect(OWNER_A, { id: "777", username: "another_owner" });
    assert.equal((await reply(true)).status, 409);
    assert.equal((await read<XAccountBody>(await get(OWNER_A))).replyEnabled, false);
  });

  it("turns replies off without the gate or app and cancels only waiting replies", async () => {
    await connect(OWNER_A);
    await postingOn();
    w.env.MERRYMEN_XPOST_REPLIES_APPROVED = "1";
    await reply(true);
    const waiting = await replyDraft();
    const ordinary = await draft(OWNER_A);
    delete w.env.MERRYMEN_XPOST_REPLIES_APPROVED;
    delete w.env.MERRYMEN_X_CLIENT_ID;
    assert.deepEqual(await read(await reply(false)), { ok: true, replyEnabled: false });
    assert.equal(await repliesEnabledFor(w.db, OWNER_A, X_USER.id), false);
    assert.equal(statusOf(waiting), "cancelled");
    assert.equal(statusOf(ordinary), "scheduled");
  });

  it("returns validated comment context for upcoming and posted replies", async () => {
    await connect(OWNER_A);
    await postingOn();
    w.env.MERRYMEN_XPOST_REPLIES_APPROVED = "1";
    await reply(true);
    const id = await replyDraft();
    let body = await read<XAccountBody>(await get(OWNER_A));
    assert.equal(body.upcoming[0]?.replyToTweetId, "111");
    assert.equal(body.upcoming[0]?.replyRootTweetId, "222");
    assert.ok(!JSON.stringify(body).includes("replyAuthorId"));
    await claimPost(w.db, id, w.clock.now);
    await markPosted(w.db, id, "444", w.clock.now);
    body = await read<XAccountBody>(await get(OWNER_A));
    assert.equal(body.recent[0]?.kind, "reply");
    assert.equal(body.recent[0]?.replyToTweetId, "111");
  });
});

describe("skip", () => {
  it("cancels the owner's own waiting post", async () => {
    await connect(OWNER_A);
    const id = await draft(OWNER_A);
    assert.deepEqual(await read(await post(OWNER_A, { action: "skip", id, owner: OWNER_A })), { ok: true });
    assert.equal(statusOf(id), "cancelled");
  });

  it("cannot touch another owner's post", async () => {
    await connect(OWNER_B);
    const theirs = await draft(OWNER_B);
    const res = await post(OWNER_A, { action: "skip", id: theirs, owner: OWNER_A });
    assert.equal((await read(res, 409)).error, X_COPY.alreadySending);
    assert.equal(statusOf(theirs), "scheduled");
  });

  it("cannot half-skip a post already claimed for sending", async () => {
    await connect(OWNER_A);
    const id = await draft(OWNER_A);
    await claimPost(w.db, id, w.clock.now);
    const res = await post(OWNER_A, { action: "skip", id, owner: OWNER_A });
    assert.equal((await read(res, 409)).error, X_COPY.alreadySending);
    assert.equal(statusOf(id), "sending");
  });

  it("refuses an id that is not one", async () => {
    for (const id of ["1", 0, -1, 1.5, null]) {
      assert.equal((await post(OWNER_A, { action: "skip", id, owner: OWNER_A })).status, 400, String(id));
    }
  });
});

describe("DELETE — disconnect", () => {
  it("forgets the connection, cancels the drafts and revokes both tokens at X", async () => {
    await connect(OWNER_A);
    await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A });
    const waiting = await draft(OWNER_A);
    assert.deepEqual(await read(await del(OWNER_A, { owner: OWNER_A })), { ok: true });
    assert.equal(await getAccount(w.db, OWNER_A), null);
    assert.equal(statusOf(waiting), "cancelled");
    const revoked = w.x.to(X_REVOKE_URL).map((c) => new URLSearchParams(c.body));
    assert.deepEqual(
      revoked.map((f) => [f.get("token"), f.get("token_type_hint")]).sort(),
      [[X_ACCESS, "access_token"], [X_REFRESH, "refresh_token"]].sort(),
    );
    assert.equal((await read<XAccountBody>(await get(OWNER_A))).connected, false);
  });

  it("answers the owner the same when X refuses the revoke", async () => {
    await connect(OWNER_A);
    w.x.answers.revoke = { status: 503, body: "down" };
    assert.deepEqual(await read(await del(OWNER_A, { owner: OWNER_A })), { ok: true });
    assert.equal(await getAccount(w.db, OWNER_A), null);
  });

  it("is ok with nothing connected, and asks X nothing", async () => {
    assert.deepEqual(await read(await del(OWNER_A, { owner: OWNER_A })), { ok: true });
    assert.equal(w.x.calls.length, 0);
  });

  it("still forgets the connection when the X app is gone, without trying to revoke", async () => {
    await connect(OWNER_A);
    delete w.env.MERRYMEN_X_CLIENT_ID;
    assert.deepEqual(await read(await del(OWNER_A, { owner: OWNER_A })), { ok: true });
    assert.equal(await getAccount(w.db, OWNER_A), null);
    assert.equal(w.x.calls.length, 0);
  });

  it("STILL FORGETS THE CONNECTION AND CANCELS THE DRAFTS ON A WEB WITHOUT THE DEK — only the revoke is skipped", async () => {
    // The orchestrator holds the DEK and is posting; this web process does not.
    await connect(OWNER_A);
    await post(OWNER_A, { action: "enable", xUserId: X_USER.id, owner: OWNER_A });
    const waiting = await draft(OWNER_A);
    delete process.env.MERRYMEN_STORE_DEK;
    assert.deepEqual(await read(await del(OWNER_A, { owner: OWNER_A })), { ok: true });
    assert.equal(await getAccount(w.db, OWNER_A), null);
    assert.equal(statusOf(waiting), "cancelled");
    assert.equal(w.x.calls.length, 0, "a token nobody here can open is not sent anywhere");
  });

  it("leaves another owner's connection alone", async () => {
    await connect(OWNER_A);
    await connect(OWNER_B);
    await del(OWNER_A, { owner: OWNER_A });
    assert.ok(await getAccount(w.db, OWNER_B));
  });
});

describe("POST", () => {
  it("does not know other actions, and refuses a body that is not a JSON object", async () => {
    assert.equal((await post(OWNER_A, { action: "post-now", owner: OWNER_A })).status, 400);
    assert.equal((await post(OWNER_A, "nope")).status, 400);
    assert.equal((await post(OWNER_A, JSON.stringify({ owner: OWNER_A, pad: "x".repeat(4000) }))).status, 413);
  });
});
