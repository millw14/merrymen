/**
 * WHY A TENANT'S TRADING IS HELD, as its home records it and as its owner is told.
 *
 * A paper tenant whose practice book cannot be restored must not start trading:
 * the book would restart its cash from nothing, silently (orchestrator.ts,
 * spawnChild). It used to not start AT ALL, and the child is the only process
 * that polled the owner's bot, so the bot went silent for days and nobody was
 * told why. Now the orchestrator holds the tenant instead: trading stays off,
 * and a small process answers the bot (telegram/hold.ts). This file is what the
 * two of them share about the hold.
 *
 * - `restore-blocked.json` in the tenant's home says the hold is on, why, and
 *   since when. The orchestrator writes it; the hold process reads it.
 * - `restoreBlockClass` is the only part of the reason an owner ever sees. The
 *   raw reason carries checkpoint figures (a basis in raw units, a delta in
 *   USDG), which are the operator's business and mean nothing in a chat. The
 *   class is a fixed phrase with no numbers in it, chosen by pattern, so no
 *   figure from the book can reach Telegram through it.
 *
 * Imports only node:fs and node:path: the hold process reads this, and it must
 * not pull in the ledger or the database to do so.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const RESTORE_BLOCKED_FILE = "restore-blocked.json";

export interface RestoreBlock {
  /** The restore's own error, for operators. Never sent to a chat. */
  reason: string;
  /** restoreBlockClass(reason): what an owner is told. */
  class: string;
  /** When the hold began, unix seconds. */
  since: number;
  /**
   * Whether the owner is offered the practice reset: true only when their
   * stored settings would let a held reset be honoured (held-reset.ts
   * settingsRefuseHeldReset), as the orchestrator last read them. Absent, or
   * anything but true, is not offered.
   */
  resettable?: boolean;
}

/**
 * The class of a restore that failed for no rule of the book's: a database
 * that dropped the connection or timed a statement out looks like this, and so
 * would a rejection this file has not learned to name yet.
 *
 * It is not announced as a blocker. The owner is not messaged about it (a blip
 * would tell them their book is broken when it is not), it never replaces a
 * named class a hold already has, and the orchestrator tries the restore again
 * on the next pass or so rather than backing off (orchestrator.ts retryHold).
 * The hold process still answers a message while trading is held, but with
 * the words for a retry, not for a broken book (holdText).
 */
export const UNCLASSIFIED_BLOCK = "restore error";

/** Is this a class the book's own rules produced, as opposed to UNCLASSIFIED_BLOCK? */
export function isNamedBlock(cls: string): boolean {
  return cls !== UNCLASSIFIED_BLOCK;
}

/**
 * The short, figure-free name for why a restore failed. Ordered most specific
 * first; anything unrecognised is UNCLASSIFIED_BLOCK, which is also what a
 * database that could not be reached looks like.
 */
export function restoreBlockClass(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("fills are newer than")) return "trades newer than the last valuation";
  if (r.includes("does not add up")) return "the last valuation doesn't add up";
  if (r.includes("do not value")) return "holdings could not be priced";
  if (r.includes("no paper cost basis")) return "a holding has no cost basis";
  if (r.includes("disagrees with") || r.includes("is not held") || r.includes("negative cost basis") || r.includes("basis is negative")) {
    return "cost basis and holdings disagree";
  }
  if (r.includes("invalid paper checkpoint")) return "the saved book is unreadable";
  return UNCLASSIFIED_BLOCK;
}

export function writeRestoreBlocked(home: string, block: RestoreBlock): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, RESTORE_BLOCKED_FILE), JSON.stringify(block, null, 2), { encoding: "utf8", mode: 0o600 });
}

/** The hold recorded in this home, or null when there is none (or it cannot be read). */
export function readRestoreBlocked(home: string): RestoreBlock | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(home, RESTORE_BLOCKED_FILE), "utf8")) as Partial<RestoreBlock>;
    if (typeof raw.reason !== "string" || typeof raw.since !== "number") return null;
    // The class is re-derived rather than trusted: this file is data, and a
    // class read back verbatim could carry whatever was written into it.
    return { reason: raw.reason, class: restoreBlockClass(raw.reason), since: raw.since, resettable: raw.resettable === true };
  } catch {
    return null;
  }
}

export function clearRestoreBlocked(home: string): void {
  try {
    rmSync(path.join(home, RESTORE_BLOCKED_FILE), { force: true });
  } catch {
    /* best-effort: nothing reads it once trading is back */
  }
}

/**
 * The way out an owner is offered: starting practice over. Honoured while held
 * (held-reset.ts), so it is true to say, to an owner whose settings allow it.
 * On the web the only way to ask for it is Start over, which discards the
 * signed key too, hence "sign again".
 */
const START_OVER =
  "You can wait for a fix, or start practice over: restart the practice book in the app " +
  "(on the web, Wallet → Start over, then sign again).";
/** What an owner the reset would be refused for is told instead. */
const NOTHING_TO_DO = "You don't need to do anything.";

/**
 * WHAT AN OWNER IS TOLD WHILE A HOLD NAMES NO CAUSE (UNCLASSIFIED_BLOCK).
 *
 * Every rejection restorePaperCheckpoint makes is a named class: each error
 * it throws, and whatever it calls an invalid checkpoint
 * (paper-checkpoint.ts, restoreBlockClass). So an unnamed one is a database
 * that dropped the connection or timed a statement out, as a redeploy's
 * restarts can, and the next attempt is fifteen seconds away, and at most two
 * minutes apart after that (orchestrator.ts scheduleHoldRetry): "trying
 * again" is true for as long as it is said.
 *
 * It used to get the broken book's words, reset offer and all. An owner who
 * messaged during a blip was told their practice book "couldn't be restored"
 * and to start it over, and a reset asked for is honoured even when the book
 * would have restored a pass later: a healthy book, and the owner's signed
 * key, thrown away for a dropped connection. Nor would a reset mend a
 * database that cannot be reached: it needs the same one.
 */
const RETRYING =
  "I'm not trading right now: I couldn't load your practice book just now, and I'm trying again. " +
  "Nothing was traded or lost. /link still works.";

/**
 * What the bot says to its owner while trading is held. The plan's wording,
 * with the class and nothing else from the reason.
 *
 * THE PRACTICE RESET IS OFFERED, WHERE IT WOULD BE HONOURED. A paper-reset is
 * an agent_commands row, the ferries hand rows to trading children only, and a
 * held tenant has none, so until plan §3.4 the row waited for the first worker
 * after the hold. Now the orchestrator honours it while held: it claims the
 * newest reset of the last seven days, under the lease, for a book the ledger
 * and the stored settings both say is practice, and starts the book over in
 * the shared ledger (held-reset.ts). The press brings the next restore attempt
 * forward, so it is acted on within a pass or so rather than at the end of the
 * backoff. If that attempt restores the book after all, the worker it hands to
 * is ferried the same reset and starts over as it was asked to: the owner
 * asked for a new book, and gets one either way.
 *
 * `resettable` is false for an owner the reset would be refused for whatever
 * they did (live trading switched on beside practice, or live consent stood
 * down on the deployment). Offered to them, the advice would send a web owner
 * to discard a signed grant, sign again, and be held again with the same
 * advice. They are told what the text said before §3.4: nothing to do.
 *
 * A HOLD THAT NAMES NO CAUSE IS NOT A BROKEN BOOK, and is told so (RETRYING),
 * whatever `resettable` says. `resettable` itself is left as the settings
 * say: a named class that replaces the unnamed one (orchestrator.ts
 * retryHold) carries it on, and must offer the reset where it would be
 * honoured.
 */
export function holdText(cls: string, resettable: boolean): string {
  if (!isNamedBlock(cls)) return RETRYING;
  return (
    `I'm not trading right now: your practice book couldn't be restored after a server update (${cls}). ` +
    `Nothing was traded or lost, and the team has been alerted. ${resettable ? START_OVER : NOTHING_TO_DO} /link still works.`
  );
}

/**
 * The one message the orchestrator sends the owner, unasked, when a hold
 * begins (or its class changes to one they have not heard). Plain text: the
 * sender escapes it. The same way out as holdText, on the same condition.
 *
 * Never sent for a hold that names no cause (orchestrator.ts noteHold). Were
 * it asked for one, it says what holdText says: a retry, not a broken book.
 */
export function holdNoticeText(cls: string, resettable: boolean): string {
  if (!isNamedBlock(cls)) return RETRYING;
  return (
    `⏸️ Your agent has stopped trading: your practice book couldn't be restored after a server update (${cls}). ` +
    `Nothing was traded or lost, and the team has been alerted. ${resettable ? START_OVER : NOTHING_TO_DO} ` +
    "I'll keep answering here in the meantime."
  );
}
