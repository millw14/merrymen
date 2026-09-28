/**
 * SENDING ONE POST — docs/x-posting.md rule 4, exactly, and nothing else.
 *
 * AT MOST ONCE, EVEN ACROSS A CRASH. The post was written under its UNIQUE
 * dedupe key before this runs. Here it is CLAIMED (scheduled → sending, a
 * conditional update) before X is called, and whatever X answers, it is never
 * sent again unless X said, in so many words, that it did nothing:
 *
 *   ok           → posted.
 *   rate (429)   → back to scheduled, due at X's reset. X did nothing.
 *   auth (401)   → ONE forced token refresh and ONE retry. X did nothing the
 *                  first time; if the fresh token is refused too, the
 *                  connection is dead: revoked, and the post failed.
 *   credits      → back to scheduled in an hour, AND the whole fleet pauses
 *                  for that hour (xpost_meta "pause"): the APP may not post.
 *   duplicate    → failed. X will never take this text.
 *   forbidden    → failed. The ACCOUNT may not post (locked, restricted).
 *   invalid      → failed. Our request was wrong; resending it is wrong too.
 *   uncertain    → failed, and NEVER resent: a timeout, a network error, a 5xx
 *                  or an unreadable 2xx may have created the post, X has no
 *                  idempotency key, and a duplicate on somebody's personal
 *                  timeline is worse than a gap.
 *
 * A crash anywhere after the claim leaves the row `sending`; the next pass
 * fails it as `interrupted` (store.ts failInterrupted). Also never resent.
 *
 * THE TOKEN IS REFRESHED BEFORE IT IS USED, AND STORED BEFORE IT IS USED. With
 * under two minutes left it is traded for a new pair, and the new pair is
 * written with compare-and-swap on `version` BEFORE the post is sent: X
 * refresh tokens are single use, so a pair used and not stored is a
 * connection lost. If the swap loses — another replica, a reconnect — what
 * won is read back and used when it is fresh; otherwise the post waits five
 * minutes. Nothing was sent either way. `invalid_grant` means the owner (or
 * X) revoked us: the account is marked revoked over the version that failed,
 * and the owner is asked to reconnect.
 *
 * NOTHING SECRET LEAVES. No token and no post body is logged, thrown or
 * returned: the answer is one short outcome code for the pass summary.
 */
import type { Db } from "../db";
import { createPost, refreshTokens, type FetchLike, type XApp } from "./client";
import {
  claimPost,
  markFailed,
  markPosted,
  markRevoked,
  readTokens,
  reschedulePost,
  swapTokens,
  writeMeta,
  type StoredTokens,
  type XPost,
} from "./store";

/** A token with less than this left is refreshed before it is used. */
export const REFRESH_WITHIN_MS = 2 * 60_000;
/** A post X never saw (a refresh that did not land) waits this long. */
export const RETRY_AFTER_MS = 5 * 60_000;
/** A credits refusal pauses the fleet, and the post, this long. */
export const CREDITS_PAUSE_MS = 60 * 60_000;
/** The xpost_meta key holding the fleet pause, as epoch ms in `v`. */
export const PAUSE_KEY = "pause";

export type SendOutcome =
  | "posted"
  | "lost" // another sender claimed it first
  | "retry" // back to scheduled, nothing was sent
  | "rate"
  | "credits"
  | "revoked"
  | "duplicate"
  | "forbidden"
  | "invalid"
  | "uncertain"
  | "gone" // the account, or the X user the post was written for, is not there any more
  | "fault"; // our own failure (the database, a DEK that cannot open the tokens)

export interface SendDeps {
  fetch?: FetchLike;
  nowMs: number;
}

type Fresh = { ok: true; tokens: StoredTokens } | { ok: false; outcome: "revoked" | "retry" };

/**
 * A pair fresh enough to post with, refreshed and stored first when needed.
 * `force` refreshes even a token that looks fresh — X just refused it.
 */
async function freshTokens(db: Db, dek: Buffer, app: XApp, post: XPost, from: StoredTokens, deps: SendDeps, force: boolean): Promise<Fresh> {
  const now = deps.nowMs;
  if (!force && from.accessExpiresAtMs - now >= REFRESH_WITHIN_MS) return { ok: true, tokens: from };
  if (!from.refreshToken) {
    // No refresh token and a token that is (or X says is) no good: nothing
    // can revive this connection but the owner reconnecting.
    await markRevoked(db, post.tenant, from.version, now);
    return { ok: false, outcome: "revoked" };
  }
  const r = await refreshTokens(app, from.refreshToken, { fetch: deps.fetch, nowMs: now });
  if (!r.ok) {
    if (r.failure === "grant") {
      await markRevoked(db, post.tenant, from.version, now);
      return { ok: false, outcome: "revoked" };
    }
    // rate, uncertain, invalid: the refresh did not land; nothing was posted.
    return { ok: false, outcome: "retry" };
  }
  if (await swapTokens(db, dek, post.tenant, from.version, r.value, now)) {
    return {
      ok: true,
      tokens: {
        ...from,
        version: from.version + 1,
        accessToken: r.value.accessToken,
        refreshToken: r.value.refreshToken,
        accessExpiresAtMs: r.value.accessExpiresAtMs,
      },
    };
  }
  // THE SWAP LOST. Somebody else wrote a pair first; the one just obtained is
  // dropped. What won is used if it is for the same X account, still honoured
  // and fresh — and, when X just refused a token, not that same token again.
  const winner = await readTokens(db, dek, post.tenant);
  if (
    winner &&
    winner.status === "ok" &&
    winner.xUserId === post.xUserId &&
    winner.accessExpiresAtMs - now >= REFRESH_WITHIN_MS &&
    winner.accessToken !== from.accessToken
  ) {
    return { ok: true, tokens: winner };
  }
  return { ok: false, outcome: "retry" };
}

/**
 * SEND ONE DUE POST. The caller decided it may go (planner sendDecision); this
 * claims it, makes sure of the token, calls X once — twice only for a 401 a
 * refresh answered — and records what happened. Never throws.
 */
export async function sendOne(db: Db, dek: Buffer, app: XApp, post: XPost, deps: SendDeps): Promise<SendOutcome> {
  const now = deps.nowMs;
  let claimed = false;
  try {
    if (!(await claimPost(db, post.id, now))) return "lost";
    claimed = true;

    const stored = await readTokens(db, dek, post.tenant);
    if (!stored || stored.xUserId !== post.xUserId) {
      await markFailed(db, post.id, "gone", now);
      return "gone";
    }
    if (stored.status !== "ok") {
      await markFailed(db, post.id, "revoked", now);
      return "revoked";
    }

    const first = await freshTokens(db, dek, app, post, stored, deps, false);
    if (!first.ok) return settleUnsent(db, post, first.outcome, now);

    let tokens = first.tokens;
    let answer = await createPost(tokens.accessToken, post.body, { fetch: deps.fetch, nowMs: now });
    if (!answer.ok && answer.failure === "auth") {
      // X refused the token and did nothing. One forced refresh, one retry.
      const again = await freshTokens(db, dek, app, post, tokens, deps, true);
      if (!again.ok) return settleUnsent(db, post, again.outcome, now);
      tokens = again.tokens;
      answer = await createPost(tokens.accessToken, post.body, { fetch: deps.fetch, nowMs: now });
      if (!answer.ok && answer.failure === "auth") {
        await markRevoked(db, post.tenant, tokens.version, now);
        await markFailed(db, post.id, "revoked", now);
        return "revoked";
      }
    }

    if (answer.ok) {
      await markPosted(db, post.id, answer.value.id, now);
      return "posted";
    }
    switch (answer.failure) {
      case "rate":
        await reschedulePost(db, post.id, answer.resetAtMs ?? now + 15 * 60_000, now);
        return "rate";
      case "credits":
        await reschedulePost(db, post.id, now + CREDITS_PAUSE_MS, now);
        await writeMeta(db, PAUSE_KEY, String(now + CREDITS_PAUSE_MS), now);
        return "credits";
      case "duplicate":
        await markFailed(db, post.id, "duplicate", now);
        return "duplicate";
      case "forbidden":
        await markFailed(db, post.id, "forbidden", now);
        return "forbidden";
      case "invalid":
      case "grant":
        await markFailed(db, post.id, "invalid", now);
        return "invalid";
      default:
        // uncertain — and anything this switch does not know is treated as it.
        await markFailed(db, post.id, "uncertain", now);
        return "uncertain";
    }
  } catch {
    // Our own failure. Whatever happened, the post is not sent again: a
    // claimed row is failed here (conditional on still being `sending`, so a
    // post already marked posted stays posted), or, if even that write fails,
    // it stays `sending` and the next pass fails it as interrupted.
    if (claimed) {
      try {
        await markFailed(db, post.id, "fault", now);
      } catch {
        /* failInterrupted will close it */
      }
    }
    return "fault";
  }
}

/** Nothing reached X: revoked is final, anything else waits five minutes. */
async function settleUnsent(db: Db, post: XPost, outcome: "revoked" | "retry", now: number): Promise<SendOutcome> {
  if (outcome === "revoked") {
    await markFailed(db, post.id, "revoked", now);
    return "revoked";
  }
  await reschedulePost(db, post.id, now + RETRY_AFTER_MS, now);
  return "retry";
}
