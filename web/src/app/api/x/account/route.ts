/**
 * AN OWNER'S X CONNECTION: what is connected, whether their Merryman may post
 * from it, what is about to go out, and what went out.
 *
 *   GET     the connection as Settings draws it (lib/x-connect.ts accountBody):
 *           never a token, only the owner's own drafts and posts.
 *   POST    {action:"enable", xUserId, owner, tz}  — the owner confirmed the
 *           warning that named THIS X account. Stored against that immutable X
 *           user id: if a different account is connected by the time it
 *           lands, nothing changes and the answer is 409, so the owner is
 *           shown the new account before it can post (docs/x-posting.md rule
 *           1). `tz` is the device's IANA zone, kept for quiet hours when the
 *           room has none (lib/x-connect.ts xpostTz); a missing, unknown or
 *           placeless one never refuses the consent.
 *           {action:"disable", owner} — always works, cancels every draft.
 *           {action:"enable-replies"|"disable-replies", xUserId, owner} —
 *           separate consent for selected comment replies, bound to the shown
 *           X account. Enabling also requires posting and operator approval;
 *           disabling cancels waiting replies even while unavailable.
 *           {action:"skip", id, owner} — the owner's Skip on one draft; only
 *           their own, only while it is still scheduled (a post already
 *           claimed for sending cannot be half-skipped).
 *           {action:"prefs", owner, buys?, casual?, perDay?} — what it may
 *           post: coins it bought, passing thoughts (booleans), and posts a
 *           day (1..perDayMax, or null for the server's number). A kind
 *           turned off takes its drafts out of Coming up. Like the switch,
 *           only here: works without the X app, needs a connection.
 *   DELETE  {owner} — forget the connection: the row goes, every draft is
 *           cancelled, and X is asked to revoke the tokens, best effort (not
 *           at all when this process has no X app or no DEK to open them).
 *
 * THE SWITCH IS HERE AND NOWHERE ELSE. Chat, Telegram and MCP have no path to
 * `enable`; it needs a browser session (or the iOS app's) and a body naming
 * the X account the owner was shown. Consent is never inferred from a
 * connection, a previous consent for another account, or a missing field.
 *
 * EVERY CHANGE NAMES ITS OWNER. The body carries the owner the client believes
 * is signed in, and a session that is someone else's is refused with the
 * repo's owner-changed answer (lib/order-owner.ts) — another tab can sign a
 * different wallet in between the owner reading the warning and pressing it.
 *
 * Hosted only (404 otherwise), signed-in only (401), private and never cached.
 */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { OWNER_CHANGED_SETTING, ownerMismatch } from "@/lib/order-owner";
import {
  X_COPY,
  X_POSTS_WINDOW_MS,
  X_PRIVATE_HEADERS,
  accountBody,
  readXBody,
  withXpostDb,
  xpostApp,
  xpostAvailable,
  xpostRepliesAvailable,
  xpostDek,
  xpostFetch,
  xpostNow,
  xpostTz,
} from "@/lib/x-connect";
import { revokeToken } from "../../../../../../worker/src/xpost/client";
import {
  deleteAccount,
  getAccount,
  ownerCancel,
  ownerPerDay,
  postsOf,
  repliesEnabledFor,
  setPosting,
  setReplying,
  setPrefs,
  type XPostPrefs,
} from "../../../../../../worker/src/xpost/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{action, xUserId|id, owner}` fits in a fraction of this. */
const BODY_MAX_BYTES = 2048;
const X_USER_ID = /^\d{1,25}$/;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: X_PRIVATE_HEADERS });
/** `ownerFacing` marks a 5xx sentence as written for the owner (terminal/request-json.ts shows it). */
const refuse = (status: number, error: string) =>
  json(status >= 500 ? { error, ownerFacing: true } : { error }, status);

export async function GET(req: Request) {
  if (!isHostedMode()) return refuse(404, "not found");
  const tenant = tenantOf(req);
  if (!tenant) return refuse(401, X_COPY.signedOut);
  const available = xpostAvailable(isHostedMode());
  try {
    const body = await withXpostDb(async (db) => {
      if (!db) return accountBody(false, null, []);
      const account = await getAccount(db, tenant);
      const posts = account ? await postsOf(db, tenant, xpostNow() - X_POSTS_WINDOW_MS, 200) : [];
      const enabled = account ? await repliesEnabledFor(db, tenant, account.xUserId) : false;
      return accountBody(available, account, posts, { enabled, available: xpostRepliesAvailable(isHostedMode()) });
    });
    return json(body);
  } catch {
    // NOT "not connected". An owner told they have no connection while one is
    // live would connect again, or believe their Merryman had stopped posting.
    console.warn("[x-account] could not read the connection");
    return refuse(503, X_COPY.storeDown);
  }
}

/** The owner check every change makes first. Null when the body may go ahead. */
function ownerRefusal(input: Record<string, unknown>, tenant: `0x${string}`): Response | null {
  if (typeof input.owner !== "string") return refuse(400, X_COPY.noOwner);
  if (ownerMismatch(input.owner, tenant)) return refuse(409, OWNER_CHANGED_SETTING);
  return null;
}

export async function POST(req: Request) {
  if (!isHostedMode()) return refuse(404, "not found");
  const tenant = tenantOf(req);
  if (!tenant) return refuse(401, X_COPY.signedOut);

  const read = await readXBody(req, BODY_MAX_BYTES);
  if (!read.ok) return refuse(read.status, read.status === 413 ? X_COPY.tooLarge : X_COPY.badJson);
  const input = read.value;
  const refused = ownerRefusal(input, tenant);
  if (refused) return refused;
  const now = xpostNow();

  try {
    if (input.action === "enable-replies" || input.action === "disable-replies") {
      const enabled = input.action === "enable-replies";
      const xUserId = input.xUserId;
      if (typeof xUserId !== "string" || !X_USER_ID.test(xUserId)) return refuse(400, "Say which X account the warning named.");
      if (enabled && !xpostRepliesAvailable(isHostedMode())) return refuse(503, X_COPY.repliesUnavailable);
      const result = await withXpostDb(async (db) => {
        if (!db) return null;
        const account = await getAccount(db, tenant);
        if (!account || account.xUserId !== xUserId) return "changed";
        if (enabled && !account.posting) return "posting-off";
        return await setReplying(db, tenant, enabled, xUserId, now) ? "saved" : "changed";
      });
      if (result === null) return refuse(503, X_COPY.storeDown);
      if (result === "changed") return refuse(409, X_COPY.accountChanged);
      if (result === "posting-off") return refuse(409, X_COPY.repliesNeedPosting);
      return json({ ok: true, replyEnabled: enabled });
    }
    if (input.action === "enable") {
      const xUserId = input.xUserId;
      if (typeof xUserId !== "string" || !X_USER_ID.test(xUserId)) {
        return refuse(400, "Say which X account the warning named.");
      }
      // Turning posting ON needs the whole feature; turning it off never does.
      if (!xpostAvailable(isHostedMode())) return refuse(503, X_COPY.unavailable);
      // The device's zone, for quiet hours when the room has none; an unusable
      // or placeless one is null, which keeps the zone stored before.
      const tz = xpostTz(input.tz);
      const on = await withXpostDb(async (db) => (db ? setPosting(db, tenant, { enabled: true, xUserId, tz }, now) : null));
      if (on === null) return refuse(503, X_COPY.unavailable);
      if (!on) return refuse(409, X_COPY.accountChanged);
      return json({ ok: true, postingEnabled: true });
    }
    if (input.action === "disable") {
      const done = await withXpostDb(async (db) => (db ? (await setPosting(db, tenant, { enabled: false }, now), true) : false));
      if (!done) return refuse(503, X_COPY.unavailable);
      return json({ ok: true, postingEnabled: false });
    }
    if (input.action === "skip") {
      const id = input.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return refuse(400, "Say which post to skip.");
      const skipped = await withXpostDb(async (db) => (db ? ownerCancel(db, tenant, id, now) : null));
      if (skipped === null) return refuse(503, X_COPY.unavailable);
      // Not scheduled any more (claimed for sending, sent, gone) or not this
      // owner's: either way there is nothing left here to stop.
      if (!skipped) return refuse(409, X_COPY.alreadySending);
      return json({ ok: true });
    }
    if (input.action === "prefs") {
      const change: Partial<XPostPrefs> = {};
      for (const k of ["buys", "casual"] as const) {
        if (input[k] === undefined) continue;
        if (typeof input[k] !== "boolean") return refuse(400, "Say on or off.");
        change[k] = input[k];
      }
      if (input.perDay !== undefined) {
        if (input.perDay !== null && ownerPerDay(input.perDay) === null) return refuse(400, "Pick how many posts a day.");
        change.perDay = input.perDay === null ? null : ownerPerDay(input.perDay);
      }
      if (Object.keys(change).length === 0) return refuse(400, "Say what to change.");
      const prefs = await withXpostDb(async (db) => (db ? setPrefs(db, tenant, change, now) : undefined));
      if (prefs === undefined) return refuse(503, X_COPY.unavailable);
      if (prefs === null) return refuse(409, X_COPY.notConnected);
      return json({ ok: true, prefs });
    }
  } catch {
    console.warn("[x-account] could not save the change");
    return refuse(503, X_COPY.storeDown);
  }
  return refuse(400, "Unknown action.");
}

export async function DELETE(req: Request) {
  if (!isHostedMode()) return refuse(404, "not found");
  const tenant = tenantOf(req);
  if (!tenant) return refuse(401, X_COPY.signedOut);

  const read = await readXBody(req, BODY_MAX_BYTES);
  if (!read.ok) return refuse(read.status, read.status === 413 ? X_COPY.tooLarge : X_COPY.badJson);
  const refused = ownerRefusal(read.value, tenant);
  if (refused) return refused;

  // THE DEK ONLY OPENS THE TOKENS SO THEY CAN BE REVOKED; forgetting the
  // connection never needs it. A web process without one can still sit in
  // front of an orchestrator that has it and is posting, and "Disconnect"
  // must stop that. Without the DEK the store is handed a throwaway key that
  // opens nothing (store.ts openOrNull answers null for every token), so the
  // row goes and the drafts are cancelled, and only the revoke is skipped.
  const dek = xpostDek();
  let tokens: Awaited<ReturnType<typeof deleteAccount>>;
  try {
    const gone = await withXpostDb(async (db) =>
      db ? { tokens: await deleteAccount(db, dek ?? randomBytes(32), tenant, xpostNow()) } : null,
    );
    if (!gone) return refuse(503, X_COPY.unavailable);
    tokens = gone.tokens;
  } catch {
    console.warn("[x-account] could not delete the connection");
    return refuse(503, X_COPY.storeDown);
  }

  // REVOKED AT X, BEST EFFORT, AFTER THE ROW IS GONE. The owner's answer does
  // not depend on X: the connection is forgotten here either way, and a
  // revoke X refused only leaves a token nobody holds to expire on its own.
  const app = xpostApp();
  if (tokens && app && dek) {
    const xFetch = xpostFetch();
    await Promise.all([
      tokens.refreshToken ? revokeToken(app, tokens.refreshToken, "refresh_token", { fetch: xFetch }) : null,
      tokens.accessToken ? revokeToken(app, tokens.accessToken, "access_token", { fetch: xFetch }) : null,
    ]);
  }
  return json({ ok: true });
}
