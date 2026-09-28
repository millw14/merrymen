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
}

/**
 * The short, figure-free name for why a restore failed. Ordered most specific
 * first; anything unrecognised is a plain "restore error", which is also what
 * a database that could not be reached looks like.
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
  return "restore error";
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
    return { reason: raw.reason, class: restoreBlockClass(raw.reason), since: raw.since };
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
 * What the bot says to its owner while trading is held. The plan's wording,
 * with the class and nothing else from the reason.
 */
export function holdText(cls: string): string {
  return (
    `I'm not trading right now: your practice book couldn't be restored after a server update (${cls}). ` +
    "Nothing was traded or lost, and the team has been alerted. " +
    "To start practice over, use Practice reset in the app (web: Wallet → Start over). /link still works."
  );
}

/**
 * The one message the orchestrator sends the owner, unasked, when a hold
 * begins (or its class changes). Plain text: the sender escapes it.
 */
export function holdNoticeText(cls: string): string {
  return (
    `⏸️ Your agent has stopped trading: your practice book couldn't be restored after a server update (${cls}). ` +
    "Nothing was traded or lost, and the team has been alerted. " +
    "To start practice over, use Practice reset in the app (web: Wallet → Start over). " +
    "I'll keep answering here in the meantime."
  );
}
