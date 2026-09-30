/**
 * THE /link DECISION: whether a code links this chat, and what a link does.
 *
 * Lifted out of service.ts so that any process answering a bot decides the same
 * way: the trading child today, and a process that answers the owner while
 * trading is held (plan §1.1), which must not import the trading service to do
 * it. So this file imports nothing but the state it reads and writes. Whatever
 * else a link means to the process running it (writing the allowlist into
 * settings.json, remembering the owner's handle, a line in the event feed) is
 * handed in as a callback.
 *
 * The rules, in order:
 * - A LOCKED chat is refused before its code is looked at. Checking the code
 *   first would let a locked chat keep guessing and learn when it was right.
 * - A wrong code counts toward the lockout: LINK_MAX_FAILS wrong codes, each
 *   within LINK_LOCKOUT_SEC of the last, lock the chat for LINK_LOCKOUT_SEC.
 * - The right code links: the chat is allowlisted, the first linker becomes the
 *   owner, and the code rotates, so it can never link a second chat. Every
 *   chat's lockout is forgiven, since each counted guesses at a code that no
 *   longer exists.
 *
 * Nothing here decides WHICH messages reach it. A /link that waited out an
 * outage is never compared or counted (service.ts, the backlog rule); that is
 * the caller's to hold back.
 */

import { ensureLinkCode, rotateLinkCode, type LinkRng, type StateRef } from "./state";

export const LINK_MAX_FAILS = 5;
export const LINK_LOCKOUT_SEC = 600;

/** Wrong codes one chat has sent, and until when they count. */
export interface LinkLock {
  fails: number;
  /** Unix seconds. */
  until: number;
}

/**
 * Wrong codes per chat. In memory on purpose, as before: a restart forgives
 * them, and a restart is not something a guesser can cause.
 */
export type LinkFails = Map<number, LinkLock>;

/** Who sent the code. */
export interface Linker {
  chatId: number;
  fromId: number;
  fromUsername?: string;
}

export type LinkOutcome =
  | { ok: true }
  /** Locked out; the code was not looked at. */
  | { ok: false; locked: true; until: number }
  | { ok: false; locked: false };

export interface LinkDeps {
  stateRef: StateRef;
  fails: LinkFails;
  now: () => number;
  /**
   * Put the chat on the allowlist the gate reads. Runs before the code is
   * spent, as it always did.
   */
  allow: (chatId: number) => void;
  /** Anything else a link means to the caller: remembering the handle, the event line. */
  onLinked?: (who: Linker) => void;
  /** Injectable for tests; crypto.randomBytes otherwise. */
  rng?: LinkRng;
}

/** Try `code` for `who`. Every effect of a link happens here, or through `deps`. */
export function tryLink(deps: LinkDeps, who: Linker, code: string): LinkOutcome {
  const t = deps.now();
  const lock = deps.fails.get(who.chatId);
  if (lock && lock.fails >= LINK_MAX_FAILS && t < lock.until) {
    return { ok: false, locked: true, until: lock.until };
  }
  const before = deps.stateRef.get();
  let state = ensureLinkCode(before, deps.rng);
  // A code minted just now is the code, so it is kept. It used to be dropped
  // on a wrong guess, which cost nothing while the code was a hash of the
  // token and came out the same next time. A random one would not.
  if (state !== before) deps.stateRef.set(state);
  if (!code || code.toUpperCase() !== state.linkCode.toUpperCase()) {
    const prev = lock && t < lock.until ? lock.fails : 0;
    deps.fails.set(who.chatId, { fails: prev + 1, until: t + LINK_LOCKOUT_SEC });
    return { ok: false, locked: false };
  }
  // First-come owner + allowlist the chat; the code is consumed (rotates).
  // linkedAt marks day zero of the relationship — the bond grows from here.
  deps.allow(who.chatId);
  state = rotateLinkCode(
    {
      ...state,
      ownerId: state.ownerId ?? who.fromId,
      linkedAt: state.linkedAt ?? t,
      // AND IN THE ONE FILE NOBODY OVERWRITES. `allow` wrote the chat into
      // the child's settings.json, which hosted the orchestrator replaces
      // wholesale from the tenant store every 15 seconds — so the link, on its
      // own, is undone before the owner can send a second command, and the
      // code that bought it has already been consumed by this very rotation.
      // This file is child-owned; the parent reads it and unions these ids
      // back into the stored allowlist, which is what makes the link durable.
      linkedChats: state.linkedChats.includes(who.chatId) ? state.linkedChats : [...state.linkedChats, who.chatId],
      // And WHEN, so the parent promotes this link once and no other time: a
      // chat the owner removes stays removed until it links again, with a
      // code of its own (linksToPromote).
      linkedChatAt: { ...state.linkedChatAt, [String(who.chatId)]: t },
    },
    deps.rng,
  );
  deps.stateRef.set(state);
  // Only now. Forgiven before the rotation was saved, a failed settings write
  // in `allow` left every chat's count cleared and the same code still live:
  // five fresh guesses at it for whoever had been locked out.
  deps.fails.clear();
  deps.onLinked?.(who);
  return { ok: true };
}

/**
 * WHICH LINKS THE ORCHESTRATOR HAS STILL TO PROMOTE into the tenant's stored
 * allowlist, and the record to keep once it has: chat id → the time of the
 * link it promoted.
 *
 * `linkedChats` only grows: nothing takes a chat out of it but a redeploy
 * that wipes the home. Unioned into the stored allowlist on every pass, it
 * put back a chat the owner had just removed on the dashboard, the one way
 * they have to revoke a chat that linked with a shared or leaked code, and
 * the chat kept full command authority (trades, /transfer, /kill) until the
 * next redeploy.
 *
 * So each LINK is promoted once. A chat whose latest link (`linkedChatAt`) is
 * the one `promoted` records is left alone, whatever the stored allowlist says
 * now; one that has linked again since, with a fresh code, is due again.
 * Compared for equality, not order: the times and the record are the same
 * home's, and no clock is compared with another machine's. A chat with no
 * time (a file from before these were kept) is a link at 0: promoted once, as
 * it always was, and then left alone.
 */
export function linksToPromote(
  linkedChats: readonly number[],
  linkedChatAt: Readonly<Record<string, number>>,
  promoted: Readonly<Record<string, number>>,
): { due: number[]; record: Record<string, number> } {
  const due: number[] = [];
  const record: Record<string, number> = { ...promoted };
  for (const chat of linkedChats) {
    const at = linkedChatAt[String(chat)] ?? 0;
    if (promoted[String(chat)] === at) continue;
    due.push(chat);
    record[String(chat)] = at;
  }
  return { due, record };
}

/**
 * The outcome as the executor's /link reply wants it. A lockout says how long
 * and until when, and where the right code is: the owner locked out in the
 * incident this came from was told "try again in a few minutes", tried again
 * sooner with a code that could not work, and was locked out again.
 */
export function linkReply(outcome: LinkOutcome, now: number): { ok: boolean; reason?: string } {
  if (outcome.ok) return { ok: true };
  if (!outcome.locked) return { ok: false, reason: "bad or expired code" };
  const minutes = Math.max(1, Math.ceil((outcome.until - now) / 60));
  const at = new Date(outcome.until * 1000).toISOString().slice(11, 16);
  return {
    ok: false,
    reason: `too many wrong codes from this chat — try again in about ${minutes} min (after ${at} UTC). Use the code in Settings → Telegram.`,
  };
}

/**
 * Tell the log about a /link that did not link (poll-rules.ts makeChatTally):
 * a wrong code, one refused because the chat is locked, or the wrong code that
 * locked it, with until when. Read from `fails` just after tryLink, which is
 * the only place that knows whether this attempt was the one that locked the
 * chat.
 */
export function tallyFailedLink(
  // poll-rules.ts ChatTally, by shape: this file imports only the state.
  tally: { linkFailed(chatId: number, o: { locked: boolean; justLocked: boolean; lockedUntil?: number }): void },
  fails: LinkFails,
  chatId: number,
  outcome: LinkOutcome,
): void {
  if (outcome.ok) return;
  if (outcome.locked) {
    tally.linkFailed(chatId, { locked: true, justLocked: false, lockedUntil: outcome.until });
    return;
  }
  const lock = fails.get(chatId);
  tally.linkFailed(chatId, { locked: false, justLocked: lock?.fails === LINK_MAX_FAILS, lockedUntil: lock?.until });
}
