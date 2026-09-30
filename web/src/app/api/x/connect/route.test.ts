/**
 * CONNECTING AN X ACCOUNT, DRIVEN THROUGH THE REAL HANDLER.
 *
 * Real session cookies, the store's real SQL on an in-memory sqlite, and an X
 * that answers from a script and records every request (lib/x-test-kit.ts).
 * The properties that matter most are about what X is ASKED, because that is
 * where a mistake cannot be taken back:
 *
 *   - a connect started by one owner and finished by another redeems NOTHING;
 *   - a state works once, and not after fifteen minutes;
 *   - the code is exchanged with the verifier whose hash was sent to X;
 *   - nothing X says, and no code, state or token, reaches the owner or a log.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { OWNER_CHANGED_SETTING } from "@/lib/order-owner";
import { X_COPY } from "@/lib/x-connect";
import {
  OWNER_A,
  OWNER_B,
  X_ACCESS,
  X_REFRESH,
  X_USER,
  jsonRequest,
  xWorld,
} from "@/lib/x-test-kit";
import { X_AUTHORIZE_URL, X_ME_URL, X_REVOKE_URL, X_TOKEN_URL } from "../../../../../../worker/src/xpost/client";
import { getAccount, markRevoked, readTokens, setPosting } from "../../../../../../worker/src/xpost/store";
import { POST } from "./route";

let w: Awaited<ReturnType<typeof xWorld>>;
let warned: string[];

beforeEach(async () => {
  w = await xWorld();
  warned = [];
  mock.method(console, "warn", (...args: unknown[]) => {
    warned.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  mock.restoreAll();
  w.close();
});

const post = (tenant: `0x${string}` | null, body: unknown) => POST(jsonRequest("/api/x/connect", "POST", tenant, body));

async function read(res: Response): Promise<Record<string, unknown>> {
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  return (await res.json()) as Record<string, unknown>;
}

/** Start a connect as `tenant` and hand back the authorize URL's parameters. */
async function started(tenant: `0x${string}`, client: "web" | "ios" = "web") {
  const res = await post(tenant, { action: "start", client, owner: tenant });
  const body = await read(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  const url = new URL(String(body.url));
  assert.equal(`${url.origin}${url.pathname}`, X_AUTHORIZE_URL);
  return { url, state: url.searchParams.get("state")!, challenge: url.searchParams.get("code_challenge")! };
}

const pendingRows = () => (w.raw.prepare("SELECT tenant, sealed_verifier, redirect_uri, expires_at_ms FROM xpost_pending").all() as Record<string, unknown>[]);

describe("who may call it", () => {
  it("is 404 on a self-hosted install", async () => {
    process.env.MERRYMEN_HOSTED = "";
    const res = await post(OWNER_A, { action: "start", client: "web", owner: OWNER_A });
    assert.equal(res.status, 404);
  });

  it("is 401 signed out, and parks nothing", async () => {
    const res = await post(null, { action: "start", client: "web", owner: OWNER_A });
    assert.equal(res.status, 401);
    assert.equal(pendingRows().length, 0);
  });

  it("refuses a body that names a different owner than the session, before anything is parked", async () => {
    const res = await post(OWNER_A, { action: "start", client: "web", owner: OWNER_B });
    assert.equal(res.status, 409);
    assert.equal((await read(res)).error, OWNER_CHANGED_SETTING);
    assert.equal(pendingRows().length, 0);
  });

  it("refuses a start that names no owner", async () => {
    const res = await post(OWNER_A, { action: "start", client: "web" });
    assert.equal(res.status, 400);
    assert.equal(pendingRows().length, 0);
  });

  it("refuses an oversized body unread, and a body that is not a JSON object", async () => {
    const big = await post(OWNER_A, JSON.stringify({ action: "start", client: "web", owner: OWNER_A, pad: "x".repeat(8000) }));
    assert.equal(big.status, 413);
    assert.equal((await post(OWNER_A, "[1,2]")).status, 400);
    assert.equal((await post(OWNER_A, "not json")).status, 400);
  });

  it("is 503, with a sentence written for the owner, when the X app, its callback or the DEK is missing", async () => {
    for (const change of [
      () => delete w.env.MERRYMEN_X_CLIENT_SECRET,
      () => delete w.env.MERRYMEN_PUBLIC_ORIGIN,
      () => delete process.env.MERRYMEN_STORE_DEK,
    ]) {
      const env = { ...w.env };
      const dek = process.env.MERRYMEN_STORE_DEK;
      change();
      const res = await post(OWNER_A, { action: "start", client: "web", owner: OWNER_A });
      const body = await read(res);
      assert.equal(res.status, 503);
      assert.equal(body.error, X_COPY.unavailable);
      assert.equal(body.ownerFacing, true);
      Object.assign(w.env, env);
      process.env.MERRYMEN_STORE_DEK = dek;
    }
    assert.equal(pendingRows().length, 0);
  });
});

describe("start", () => {
  it("parks one sealed, hashed, fifteen-minute connect under the session's tenant and answers X's authorize URL", async () => {
    const { url, state } = await started(OWNER_A);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), "test-client-id");
    assert.equal(url.searchParams.get("redirect_uri"), "https://app.merrymen.test/connect/x");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("scope"), "tweet.read tweet.write users.read offline.access");
    assert.match(state, /^w\.[A-Za-z0-9_-]{32}$/);

    const rows = pendingRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tenant, OWNER_A);
    assert.equal(rows[0]!.redirect_uri, "https://app.merrymen.test/connect/x");
    assert.equal(Number(rows[0]!.expires_at_ms), w.clock.now + 15 * 60_000);
    // Only the state's hash is stored, and the verifier is sealed.
    const stored = JSON.stringify(w.raw.prepare("SELECT * FROM xpost_pending").all());
    assert.ok(!stored.includes(state), "the state itself is a bearer value until spent");
    assert.equal(w.x.calls.length, 0, "starting asks X nothing");
  });

  it("marks an iOS connect so the callback page hands the code to the app", async () => {
    const { state } = await started(OWNER_A, "ios");
    assert.match(state, /^i\./);
  });

  it("refuses a client it does not know", async () => {
    const res = await post(OWNER_A, { action: "start", client: "android", owner: OWNER_A });
    assert.equal(res.status, 400);
    assert.equal(pendingRows().length, 0);
  });

  it("clears connects nobody finished", async () => {
    await started(OWNER_A);
    w.clock.now += 16 * 60_000;
    await started(OWNER_A);
    assert.equal(pendingRows().length, 1);
  });
});

describe("finish", () => {
  it("exchanges the code with the verifier X was shown the hash of, asks X who it is, and stores it sealed with posting OFF", async () => {
    const { state, challenge } = await started(OWNER_A);
    const res = await post(OWNER_A, { action: "finish", code: "the-code-from-x", state });
    const body = await read(res);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { ok: true, username: X_USER.username, postingEnabled: false });

    assert.deepEqual(w.x.calls.map((c) => c.url), [X_TOKEN_URL, X_ME_URL]);
    const form = new URLSearchParams(w.x.calls[0]!.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "the-code-from-x");
    assert.equal(form.get("redirect_uri"), "https://app.merrymen.test/connect/x");
    const verifier = form.get("code_verifier")!;
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge, "PKCE: the verifier matches the challenge");
    assert.match(w.x.calls[0]!.headers.authorization ?? "", /^Basic /);
    assert.equal(w.x.calls[1]!.headers.authorization, `Bearer ${X_ACCESS}`);

    const account = await getAccount(w.db, OWNER_A);
    assert.ok(account);
    assert.equal(account.xUserId, X_USER.id);
    assert.equal(account.username, X_USER.username);
    assert.equal(account.posting, false, "connecting is not consent");
    const tokens = await readTokens(w.db, w.dek, OWNER_A);
    assert.equal(tokens?.accessToken, X_ACCESS);
    assert.equal(tokens?.refreshToken, X_REFRESH);
    const rowText = JSON.stringify(w.raw.prepare("SELECT * FROM xpost_accounts").all());
    assert.ok(!rowText.includes(X_ACCESS) && !rowText.includes(X_REFRESH), "tokens are sealed at rest");
    assert.equal(pendingRows().length, 0, "the pending connect is spent");
  });

  it("accepts a code in any printable alphabet X might use, and sends it form-encoded", async () => {
    const { state } = await started(OWNER_A);
    const code = "VGNibzFW+SWRE/Zm01bj==&x=1";
    assert.equal((await post(OWNER_A, { action: "finish", code, state })).status, 200);
    assert.equal(new URLSearchParams(w.x.calls[0]!.body).get("code"), code);
    assert.equal(new URLSearchParams(w.x.calls[0]!.body).get("x"), null, "a code cannot add a field");
  });

  it("works exactly once for a state: a replay is refused without asking X again", async () => {
    const { state } = await started(OWNER_A);
    assert.equal((await post(OWNER_A, { action: "finish", code: "the-code-from-x", state })).status, 200);
    const again = await post(OWNER_A, { action: "finish", code: "the-code-from-x", state });
    assert.equal(again.status, 400);
    assert.equal((await read(again)).error, X_COPY.expired);
    assert.equal(w.x.to(X_TOKEN_URL).length, 1);
  });

  it("A CONNECT STARTED BY ANOTHER OWNER IS REFUSED WITHOUT REDEEMING THE CODE — and it is spent", async () => {
    const { state } = await started(OWNER_A);
    const res = await post(OWNER_B, { action: "finish", code: "the-code-from-x", state });
    assert.equal(res.status, 403);
    assert.equal((await read(res)).error, X_COPY.wrongOwner);
    assert.equal(w.x.calls.length, 0, "X was asked nothing: the code was never exchanged");
    assert.equal(await getAccount(w.db, OWNER_B), null);
    assert.equal(await getAccount(w.db, OWNER_A), null);
    // Spent by the attempt, so the state cannot be tried again by anybody.
    assert.equal((await post(OWNER_A, { action: "finish", code: "the-code-from-x", state })).status, 400);
    assert.equal(w.x.calls.length, 0);
  });

  it("refuses an expired connect without asking X", async () => {
    const { state } = await started(OWNER_A);
    w.clock.now += 15 * 60_000 + 1;
    const res = await post(OWNER_A, { action: "finish", code: "the-code-from-x", state });
    assert.equal(res.status, 400);
    assert.equal((await read(res)).error, X_COPY.expired);
    assert.equal(w.x.calls.length, 0);
  });

  it("refuses a state it never issued, and a malformed code or state, without asking X", async () => {
    await started(OWNER_A);
    for (const body of [
      { action: "finish", code: "the-code-from-x", state: `w.${"A".repeat(32)}` },
      { action: "finish", code: "the-code-from-x", state: "w.short" },
      { action: "finish", code: "has a space", state: `w.${"A".repeat(32)}` },
      { action: "finish", state: `w.${"A".repeat(32)}` },
    ]) {
      const res = await post(OWNER_A, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(w.x.calls.length, 0);
    assert.equal(pendingRows().length, 1, "a bad finish does not spend somebody's real connect");
  });

  it("is 401 signed out, and leaves the connect for its owner", async () => {
    const { state } = await started(OWNER_A);
    assert.equal((await post(null, { action: "finish", code: "the-code-from-x", state })).status, 401);
    assert.equal(pendingRows().length, 1);
    assert.equal(w.x.calls.length, 0);
  });

  it("refuses an iOS finish that names a different owner than the session, before spending anything", async () => {
    const { state } = await started(OWNER_A, "ios");
    const res = await post(OWNER_A, { action: "finish", code: "the-code-from-x", state, owner: OWNER_B });
    assert.equal(res.status, 409);
    assert.equal(pendingRows().length, 1);
    assert.equal((await post(OWNER_A, { action: "finish", code: "the-code-from-x", state, owner: OWNER_A })).status, 200);
  });

  it("when X refuses the code: 502 in one plain sentence, nothing stored, X's words nowhere", async () => {
    w.x.answers.token = { status: 400, body: { error: "invalid_grant", error_description: "Value passed for the authorization code was invalid SECRET-DETAIL" } };
    const { state } = await started(OWNER_A);
    const res = await post(OWNER_A, { action: "finish", code: "the-code-from-x", state });
    const body = await read(res);
    assert.equal(res.status, 502);
    assert.deepEqual(body, { error: X_COPY.xFailed, ownerFacing: true });
    assert.equal(await getAccount(w.db, OWNER_A), null);
    assert.ok(!warned.join("\n").includes("SECRET-DETAIL"));
    assert.match(warned.join("\n"), /token exchange failed \(grant 400\)/);
  });

  it("when X will not say who the token is: 502, nothing stored, and the fresh tokens are handed back", async () => {
    w.x.answers.me = { status: 503, body: "upstream" };
    const { state } = await started(OWNER_A);
    const res = await post(OWNER_A, { action: "finish", code: "the-code-from-x", state });
    assert.equal(res.status, 502);
    assert.equal(await getAccount(w.db, OWNER_A), null);
    const revoked = w.x.to(X_REVOKE_URL).map((c) => new URLSearchParams(c.body));
    assert.deepEqual(
      revoked.map((f) => [f.get("token"), f.get("token_type_hint")]).sort(),
      [[X_ACCESS, "access_token"], [X_REFRESH, "refresh_token"]].sort(),
    );
  });

  it("when X cannot be reached at all: 502, and the connect is still spent", async () => {
    w.x.answers.token = { status: 500, body: "boom" };
    const { state } = await started(OWNER_A);
    assert.equal((await post(OWNER_A, { action: "finish", code: "the-code-from-x", state })).status, 502);
    assert.equal(pendingRows().length, 0);
  });

  it("a reconnect of a DIFFERENT X account turns posting off: the consent named the old one", async () => {
    let s = await started(OWNER_A);
    assert.equal((await post(OWNER_A, { action: "finish", code: "the-code-from-x", state: s.state })).status, 200);
    w.raw.prepare("UPDATE xpost_accounts SET posting_enabled = 1, consent_x_user_id = x_user_id, consent_at_ms = 1").run();
    assert.equal((await getAccount(w.db, OWNER_A))?.posting, true);

    w.x.answers.me = { status: 200, body: { data: { id: "999", username: "someone_else" } } };
    s = await started(OWNER_A);
    assert.equal((await post(OWNER_A, { action: "finish", code: "the-code-from-x", state: s.state })).status, 200);
    const now = await getAccount(w.db, OWNER_A);
    assert.equal(now?.username, "someone_else");
    assert.equal(now?.posting, false);
  });

  it("A RECONNECT OF THE SAME ACCOUNT AFTER X REVOKED IT SAYS POSTING IS ON AGAIN: the consent it had was kept", async () => {
    let s = await started(OWNER_A);
    assert.equal((await post(OWNER_A, { action: "finish", code: "the-code-from-x", state: s.state })).status, 200);
    await setPosting(w.db, OWNER_A, { enabled: true, xUserId: X_USER.id }, w.clock.now);
    await markRevoked(w.db, OWNER_A, 1, w.clock.now);
    assert.equal((await getAccount(w.db, OWNER_A))?.posting, false, "revoked: nothing posts");

    s = await started(OWNER_A);
    const res = await post(OWNER_A, { action: "finish", code: "the-code-from-x", state: s.state });
    assert.deepEqual(await read(res), { ok: true, username: X_USER.username, postingEnabled: true });
    assert.equal((await getAccount(w.db, OWNER_A))?.posting, true, "and it is what the store says");
  });

  it("a reconnect of an account whose owner had posting off says it is off", async () => {
    let s = await started(OWNER_A);
    await post(OWNER_A, { action: "finish", code: "the-code-from-x", state: s.state });
    await markRevoked(w.db, OWNER_A, 1, w.clock.now);
    s = await started(OWNER_A);
    const body = await read(await post(OWNER_A, { action: "finish", code: "the-code-from-x", state: s.state }));
    assert.equal(body.postingEnabled, false);
  });

  it("NEVER LOGS OR ANSWERS A CODE, A STATE OR A TOKEN, whatever happens", async () => {
    const answers: string[] = [];
    const run = async () => {
      const { state } = await started(OWNER_A);
      const res = await post(OWNER_A, { action: "finish", code: "CODE-that-must-not-leak", state });
      answers.push(JSON.stringify(await res.json()), state);
      return state;
    };
    const states: string[] = [];
    states.push(await run());
    w.x.answers.me = { status: 401, body: {} };
    states.push(await run());
    w.x.answers.token = { status: 400, body: { error: "invalid_request" } };
    states.push(await run());
    const said = [...warned, ...answers.filter((a) => a.startsWith("{"))].join("\n");
    for (const secret of ["CODE-that-must-not-leak", X_ACCESS, X_REFRESH, ...states]) {
      assert.ok(!said.includes(secret), `leaked: ${secret}`);
    }
  });

  it("does not know other actions", async () => {
    assert.equal((await post(OWNER_A, { action: "nope", owner: OWNER_A })).status, 400);
  });
});
