/**
 * ONE TENANT'S PROBLEM STOPS ONE TENANT: the reply listener's failure vocabulary.
 *
 * THE INCIDENT THIS CAME FROM. The reply-only listener (recovery-replies.ts)
 * used to treat every surprise as fleet-wide. Any write to ANY tenant's grants
 * row changed the whole roster's receipt and stopped every actor; one 1-second
 * statement timeout on one tenant's settings row stopped every actor; one bot's
 * Telegram 409, one lost lease, one thrown error in one actor — all of them
 * exited the process. On 2026-10-05 that happened ten times in a working day
 * (a user signing a grant was enough), Railway's ON_FAILURE policy ran out of
 * retries, and every bot went silent at once.
 *
 * WHAT STAYS FLEET-WIDE. Only conditions that are about the whole process, not
 * about one tenant or one bot (RecoveryReplyFleetRefusal below):
 *
 *   - the root proof (FLEET_HALT, the mount, the frozen environment) changed;
 *   - the data-encryption key is not a 32-byte key;
 *   - the roster cannot be read at startup for a reason that is not database
 *     weather (a missing table, say), or exceeds its 256-row cap;
 *   - SIGTERM / the trusted stop signal (a clean stop, not a refusal).
 *
 * WHAT PAUSES THE FLEET WITHOUT EXITING. Most serving bots seeing a NEW 409 at
 * once (ReplyConflictAlarm below) is the signature of a lease-less poller
 * fleet beside this one. The listener stops polling every bot for
 * CONFLICT_PAUSE_MS but keeps every tenant lease (the fence) and bot lease, so
 * it never hands a tenant to that other fleet the way an exit would, and it
 * spends none of Railway's restart attempts.
 *
 * EVERYTHING ELSE IS ONE ACTOR'S. A stop or a back-off names a fixed reason
 * code from the unions below and at most an eight-character tenant prefix
 * (tenantTag). No token, owner id, chat id, message text or provider prose is
 * ever put into a line: the codes are constants and the prefix is sliced from
 * an address the roster already validated.
 *
 * Imports only the shared refusal message and db.ts's test of a transient
 * failure (which opens nothing), so a test can exercise the vocabulary
 * without PostgreSQL, Telegram or a home.
 */
import { isTransientDbError } from "./db";
import { recoveryReplyRefused } from "./recovery-reply-proof";

/** Why ONE actor stopped (or was never admitted). Never fleet-wide. */
export type ReplyStopReason =
  /** The tenant's own grant row no longer matches the receipt the actor was admitted with, or became malformed/ambiguous. */
  | "roster-changed"
  /** The tenant left the roster: its actor stops and its leases are released. */
  | "roster-removed"
  /** Settings, claim, link, held status or room approval changed or no longer reads cleanly. */
  | "snapshot-invalid"
  /** This tenant's lease or this bot's stream lease stopped being ours. */
  | "lease-lost"
  /** Another process holds this tenant's lease; admission waits. */
  | "lease-busy"
  /**
   * THIS process's own earlier acquisition or release of that lease has not
   * settled yet (a late lock answer, or an unlock still in flight). Never
   * reported as lease-busy, which tells an operator to look for another
   * process holding the tenant.
   */
  | "lease-settling"
  /** Another process (or another of our tenants) holds this bot's stream lease; admission waits. */
  | "bot-busy"
  /**
   * The bot stream session was lost and is being replaced; admission waits,
   * without a back-off, for the actors still holding a lease from the lost
   * session to finish stopping.
   */
  | "bot-session-renewing"
  /** The multi-bot 409 alarm paused every actor (one fleet line, not one per actor). */
  | "fleet-paused"
  /** Telegram refused the token (401/404) or named another bot: quarantined until the stored scope changes. */
  | "telegram-refused"
  /** A transient database failure outside an actor's own retry (admission reads). */
  | "db-transient"
  /** Anything else thrown inside one actor. Its update is not acknowledged; admission backs off. */
  | "actor-error"
  /** The supervisor asked this actor to stop (shutdown, or a decision logged under its own reason). */
  | "stopped";

/** Why an actor backed off IN PLACE (it keeps its leases and its place). */
export type ReplyBackoffReason = "telegram-409" | "telegram-network" | "db-transient" | "deadline";

/** The only reasons the whole listener refuses. Each is about the process, never one tenant. */
export type ReplyFleetReason =
  | "root-proof"
  | "dek-invalid"
  | "roster-unreadable"
  | "roster-cap"
  | "supervisor-error";

/**
 * A FLEET-WIDE REFUSAL. Same message as every other reply refusal (nothing
 * about the cause leaks into an error string someone might print), plus the
 * fixed reason code the entry's exit line prints.
 */
export class RecoveryReplyFleetRefusal extends Error {
  constructor(readonly reason: ReplyFleetReason) {
    super(recoveryReplyRefused().message);
    this.name = "RecoveryReplyFleetRefusal";
  }
}

/** ONE ACTOR STOPS. Thrown by that actor's own guard/authority; caught by the supervisor. */
export class ReplyActorStop extends Error {
  constructor(readonly reason: ReplyStopReason) {
    super(recoveryReplyRefused().message);
    this.name = "ReplyActorStop";
  }
}

/**
 * AT MOST AN EIGHT-CHARACTER TENANT PREFIX: `0x` and six hex digits. Enough to
 * match a line to a tenant an operator is already looking at, not enough to
 * be the address. Anything that is not an address prints as `?`, so a value
 * that reached here by mistake cannot ride into the log.
 */
export function tenantTag(tenant: unknown): string {
  return typeof tenant === "string" && /^0x[0-9a-f]{40}$/i.test(tenant) ? tenant.slice(0, 8).toLowerCase() : "?";
}

/**
 * TRANSIENT DATABASE FAILURES: retry this actor, never stop the fleet.
 *
 * Which failures are weather is db.ts's isTransientDbError: among them 57014,
 * the statement timeout PostgreSQL logged at 11:01:01 on 2026-10-05
 * ("canceling statement due to statement timeout" on one tenant's settings
 * read), and 55P03, what `FOR SHARE NOWAIT` (and the 500ms lock_timeout)
 * answer while the web is writing that tenant's row.
 *
 * Deliberately NOT transient: anything that is our own refusal (a changed or
 * malformed scope), and any other SQLSTATE. Those are decisions, not weather.
 */
export function isTransientReplyDbError(e: unknown): boolean {
  if (e instanceof ReplyActorStop || e instanceof RecoveryReplyFleetRefusal) return false;
  return isTransientDbError(e);
}

/**
 * HOW LONG TO WAIT, by what went wrong and how many times in a row (`streak`
 * counts this failure, from 1). Each schedule doubles from its base to its
 * cap:
 *
 *   telegram-409      60s → 10 min. Another poller holds the bot. Asking
 *                     again sooner only steals updates back and forth (the
 *                     ordinary poller's own rule waits 10s and re-logs at
 *                     most hourly; this listener is the guest, so it waits
 *                     longer).
 *   telegram-network  2s → 60s, or longer when Telegram names retry_after.
 *                     The ordinary poller's BACKOFF_MAX_SEC.
 *   db-transient      2s → 60s. A database blip should cost seconds, and the
 *   deadline          actor re-proves its whole scope when it resumes.
 *   admission         5s → 5 min: re-acquiring a lost or busy lease, or a
 *                     bot stream another process holds.
 *   actor-error       60s → 10 min: an unexpected failure in one actor (for
 *                     instance a /forget whose legacy memory cannot be
 *                     erased). Its update stays unacknowledged, so each retry
 *                     meets it again; the cap keeps that to six an hour.
 */
export type ReplyBackoffKind = ReplyBackoffReason | "admission" | "actor-error";
const SCHEDULE: Record<ReplyBackoffKind, [baseMs: number, capMs: number]> = {
  "telegram-409": [60_000, 600_000],
  "telegram-network": [2_000, 60_000],
  "db-transient": [2_000, 60_000],
  deadline: [2_000, 60_000],
  admission: [5_000, 300_000],
  "actor-error": [60_000, 600_000],
};
export function replyBackoffMs(kind: ReplyBackoffKind, streak: number, retryAfterSec?: number): number {
  const [base, cap] = SCHEDULE[kind];
  const n = Math.max(1, Math.min(30, Math.floor(Number.isFinite(streak) ? streak : 1)));
  const ms = Math.min(cap, base * 2 ** (n - 1));
  const asked = typeof retryAfterSec === "number" && Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? Math.min(retryAfterSec, 3_600) * 1000 : 0;
  return Math.max(ms, asked);
}

/**
 * A 409 THAT IS THE OWNER'S OWN SETUP, NOT A SECOND POLLER. Telegram answers
 * getUpdates with 409 while the bot has a webhook set ("can't use getUpdates
 * method while webhook is active"). That is a setting on the owner's own bot,
 * per tenant; it can never be an ordinary poller fleet running beside this
 * listener, so it never feeds the fleet alarm. It stays that bot's [alert],
 * its `conflict: this bot has a webhook set (409)` mark (pollFailure's own
 * wording) and its back-off.
 */
export function isWebhookConflict(reason: unknown): boolean {
  return typeof reason === "string" && /webhook/i.test(reason);
}

/**
 * THE MULTI-BOT 409 ALARM. One bot answering 409 Conflict means something
 * else is reading THAT bot: the owner's own script, a self-hosted copy. That
 * bot backs off and is marked; nobody else is affected. An ordinary
 * orchestrator that holds no tenant lease (a legacy deployment) running beside
 * this listener would instead make most of the bots it serves answer 409 at
 * about the same moment. The tenant-lease fence already keeps out every
 * lease-respecting ordinary worker, so this alarm is only the backstop for
 * that lease-less case, and it must never be something a few owners can trip
 * with their own bots. It trips only when ALL of these hold:
 *
 *   - at least CONFLICT_ALARM_BOTS distinct bots have a standing 409 (webhook
 *     409s are never counted: isWebhookConflict above);
 *   - each of those conflicts FIRST APPEARED inside CONFLICT_ALARM_WINDOW_MS.
 *     A conflict that is merely refreshed (the same bot answering 409 again
 *     after its back-off) keeps its first time, so a few owners each running
 *     their own poller for days never line up into a "new" fleet event;
 *   - they are a strict MAJORITY of the bots this listener is serving.
 *
 * Tripping does not exit (see the header): the caller pauses every actor for
 * CONFLICT_PAUSE_MS and keeps every lease. Every conflict standing when it
 * trips is SPENT: it never counts toward another trip while it stands, so the
 * same conflicts cannot pause the fleet again on resume, however short the
 * pause; only new ones can. A bot's entry ends when it polls cleanly, or when
 * it has not been seen in conflict for CONFLICT_STALE_MS (its actor stopped or
 * its tenant left) — longer than the 409 back-off's ten-minute cap, so a bot
 * that is still in conflict is never forgotten and later mistaken for a new
 * one.
 */
export const CONFLICT_ALARM_BOTS = 3;
export const CONFLICT_ALARM_WINDOW_MS = 120_000;
export const CONFLICT_STALE_MS = 1_800_000;
/** How long the alarm pauses polling. The per-bot 409 back-off's own cap. */
export const CONFLICT_PAUSE_MS = 600_000;
export class ReplyConflictAlarm {
  private readonly seen = new Map<string, { first: number; last: number; spent: boolean }>();
  constructor(private readonly bots = CONFLICT_ALARM_BOTS, private readonly windowMs = CONFLICT_ALARM_WINDOW_MS) {}
  /**
   * Record a counted (non-webhook) 409 for `botId` at `atMs` while `serving`
   * bots are being served; true when the fleet alarm trips.
   */
  conflict(botId: string, atMs: number, serving: number): boolean {
    const had = this.seen.get(botId);
    this.seen.set(botId, { first: had?.first ?? atMs, last: atMs, spent: had?.spent ?? false });
    let fresh = 0;
    for (const [id, at] of this.seen) {
      if (atMs - at.last > CONFLICT_STALE_MS) this.seen.delete(id);
      else if (!at.spent && atMs - at.first <= this.windowMs) fresh++;
    }
    if (fresh < this.bots || fresh * 2 <= serving)
      return false;
    for (const at of this.seen.values()) at.spent = true;
    return true;
  }
  /** A clean poll: this bot's conflict is over. */
  clear(botId: string): void {
    this.seen.delete(botId);
  }
  /** Distinct bots with a standing counted 409, for the counts-only stats line. */
  get size(): number {
    return this.seen.size;
  }
}

/**
 * HOW THE ENTRY ENDED, as the ONE line the process prints last. `stopped` is a
 * SIGTERM or the trusted stop signal: a clean stop, exit 0, and a different
 * line from a refusal so a log search can tell them apart. Anything thrown is
 * a refusal, exit 1, with the fleet reason when there is one and `startup`
 * otherwise (a proof or configuration that failed before the supervisor ran).
 * The trailing sentence is the one operators already search for.
 */
export function recoveryReplyExitLine(outcome: { stopped: true } | { error: unknown }): { line: string; code: 0 | 1 } {
  if ("stopped" in outcome)
    return { line: "[recovery-replies] stopped on signal; leases released. Trading and original-source holds remain intact.", code: 0 };
  const reason = outcome.error instanceof RecoveryReplyFleetRefusal ? outcome.error.reason : "startup";
  return { line: `[recovery-replies] refused reason=${reason}. Reply-only listener stopped or refused; trading and original-source holds remain intact.`, code: 1 };
}
