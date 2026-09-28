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
 *   app          → the token endpoint refused OUR client credentials (a
 *                  rotated or mistyped secret): back to scheduled, and the
 *                  fleet pauses a quarter of an hour (xpost_meta "pause:app")
 *                  so one bad secret is not a refresh per due post. Never a
 *                  revocation: every owner's grant is still good.
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
 * Every "back to scheduled" goes through store.ts reschedulePost, which puts
 * a post back only while its account still posts for that X user: one the
 * owner switched off (or disconnected, or X revoked) while it was in flight
 * is cancelled instead, and the outcome says so.
 *
 * THE TOKEN IS REFRESHED BEFORE IT IS USED, AND STORED BEFORE IT IS USED. With
 * under two minutes left it is traded for a new pair, and the new pair is
 * written with compare-and-swap on `version` BEFORE the post is sent: X
 * refresh tokens are single use, so a pair used and not stored is a
 * connection lost. If the swap loses — another replica, a reconnect — what
 * won is read back and used when it is fresh; otherwise the post waits five
 * minutes. Nothing was sent either way. `invalid_grant` means the owner (or
 * X) revoked us — unless the row moved on while we asked, which means another
 * sender spent the token first: only a refusal at the version still stored
 * marks the account revoked, and the owner is asked to reconnect.
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
  readMeta,
  readTokens,
  reschedulePost,
  swapTokens,
  writeMeta,
  type StoredTokens,
  type TokenSetPlain,
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
/** The token endpoint refused the app's own credentials: the fleet, and the post, wait this long. */
export const APP_PAUSE_MS = 15 * 60_000;
/** The xpost_meta key holding that pause, as epoch ms in `v`. Its own key, so the log can say which. */
export const APP_PAUSE_KEY = "pause:app";

export type SendOutcome =
  | "posted"
  | "lost" // another sender claimed it first
  | "retry" // back to scheduled, nothing was sent
  | "rate"
  | "credits"
  | "app" // the token endpoint refused our client credentials; back to scheduled, the fleet pauses
  | "revoked"
  | "duplicate"
  | "forbidden"
  | "invalid"
  | "uncertain"
  | "gone" // the account, or the X user the post was written for, is not there any more
  | "cancelled" // X did nothing, and the account stopped posting while it was in flight
  | "fault"; // our own failure (the database, a DEK that cannot open the tokens)

export interface SendDeps {
  fetch?: FetchLike;
  nowMs: number;
}

type Unsent = "revoked" | "retry" | "app";
type Fresh = { ok: true; tokens: StoredTokens } | { ok: false; outcome: Unsent };

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
    if (r.failure === "app") return { ok: false, outcome: "app" };
    if (r.failure === "grant") {
      // A REFUSED REFRESH TOKEN MAY BE ONE SOMEBODY ELSE JUST SPENT. Two
      // senders that read the same version (a lease handover) both trade the
      // same single-use token: X rotates it for the first and refuses the
      // second. So the row is read again first. If its version moved, the
      // other sender (or a reconnect) won: its pair is used when it is fresh,
      // otherwise the post waits. Only a refusal at the version still stored
      // is the owner's (or X's) revocation.
      const current = await readTokens(db, dek, post.tenant);
      if (!current) return { ok: false, outcome: "retry" };
      if (current.version !== from.version) return usableWinner(current, from, post, now) ? { ok: true, tokens: current } : { ok: false, outcome: "retry" };
      await markRevoked(db, post.tenant, from.version, now);
      return { ok: false, outcome: "revoked" };
    }
    // rate, uncertain, invalid: the refresh did not land; nothing was posted.
    return { ok: false, outcome: "retry" };
  }
  // A REFRESH ANSWER WITHOUT A REFRESH TOKEN KEEPS THE ONE STORED. X rotates
  // with every refresh, but an answer that leaves it out (X, or a proxy) must
  // not erase the stored one: two hours later that is a revoked account.
  const next: TokenSetPlain = { ...r.value, refreshToken: r.value.refreshToken ?? from.refreshToken };
  if (await swapTokens(db, dek, post.tenant, from.version, next, now)) {
    return {
      ok: true,
      tokens: {
        ...from,
        version: from.version + 1,
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        accessExpiresAtMs: next.accessExpiresAtMs,
      },
    };
  }
  // THE SWAP LOST. Somebody else wrote a pair first; the one just obtained is
  // dropped. What won is used when it may be.
  const winner = await readTokens(db, dek, post.tenant);
  return winner && usableWinner(winner, from, post, now) ? { ok: true, tokens: winner } : { ok: false, outcome: "retry" };
}

/**
 * A PAIR ANOTHER WRITER STORED, fit to post with: for the same X account,
 * still honoured and fresh — and, when X just refused a token, not that same
 * token again.
 */
function usableWinner(winner: StoredTokens, from: StoredTokens, post: XPost, now: number): boolean {
  return (
    winner.status === "ok" &&
    winner.xUserId === post.xUserId &&
    winner.accessExpiresAtMs - now >= REFRESH_WITHIN_MS &&
    winner.accessToken !== from.accessToken
  );
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
        return (await reschedulePost(db, post.id, answer.resetAtMs ?? now + 15 * 60_000, now)) ? "rate" : "cancelled";
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
      case "app":
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

/**
 * Nothing reached X: revoked is final; the app's credentials refused waits out
 * the fleet pause it sets; anything else waits five minutes.
 */
async function settleUnsent(db: Db, post: XPost, outcome: Unsent, now: number): Promise<SendOutcome> {
  if (outcome === "revoked") {
    await markFailed(db, post.id, "revoked", now);
    return "revoked";
  }
  if (outcome === "app") {
    await reschedulePost(db, post.id, now + APP_PAUSE_MS, now);
    await pauseUntil(db, APP_PAUSE_KEY, now + APP_PAUSE_MS, now);
    return "app";
  }
  return (await reschedulePost(db, post.id, now + RETRY_AFTER_MS, now)) ? "retry" : "cancelled";
}

/** Pause the fleet until `untilMs` under `key` — never shortening a pause already longer. */
async function pauseUntil(db: Db, key: string, untilMs: number, now: number): Promise<void> {
  const current = Number((await readMeta(db, key))?.v);
  if (Number.isFinite(current) && current >= untilMs) return;
  await writeMeta(db, key, String(untilMs), now);
}
