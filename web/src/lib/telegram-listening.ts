/**
 * IS ANYTHING HEARING THE OWNER'S BOT, AND WHICH LINK CODE MAY THE DASHBOARD
 * SHOW? The decision behind `listening`, `linkCode` and `linkPending` in
 * GET /api/telegram, kept here where a test can run it.
 *
 * ── WHY THE DASHBOARD HAD TO STOP GUESSING ───────────────────────────────
 *
 * In the incident behind this, an owner's bot was not polled by anything for
 * days. Its worker was held back by a practice book that would not restore;
 * then the owner's second login saved the same bot and its worker drained the
 * backlog; then that worker was held back too. Throughout, the dashboard said
 * "connected" and showed the code NTE49D. "Connected" was a getMe the web ran
 * against the saved token, which says the token is good and nothing about
 * whether anything is listening. NTE49D was the last code the first agent had
 * published, frozen there, for a bot that was by then answering to another
 * agent's code. The owner sent it five times and was locked out.
 *
 * So this reads what the process polling the bot recorded (worker
 * telegram/state.ts PollHealth), as the orchestrator published it
 * (telegram-store.ts TELEGRAM_LIVENESS_DDL), and says only what that shows.
 *
 * ── THE STATES ───────────────────────────────────────────────────────────
 *
 * - `held`: trading is held because the practice book would not restore. A
 *   small process answers the bot meanwhile; `reason` is the short class the
 *   owner is also told in chat, never the restore's figures. Unless that bot
 *   is measurably not being heard: then the state below says so, since a
 *   deaf bot is the thing the owner can act on, and the hold was already
 *   sent to them directly (orchestrator.ts sendHoldNotice).
 * - `revoked`: the last poll was refused (401/404): the token was revoked or
 *   is wrong. Only the owner can fix it.
 * - `conflict`: the last poll failed with 409, and the bot has not been heard
 *   for longer than LIVE_WITHIN_SEC: another program is reading this bot's
 *   messages (a copy of Merrymen on the owner's computer, say, or a
 *   webhook). Not before: a redeploy's handover, while the old worker's long
 *   poll is still open, gives a 409 or two and then polls that work, and a
 *   linked owner's panel must not flip to "another program has the bot" for
 *   it. The orchestrator's alert waits for the same reason.
 * - `live`: a poll of this bot worked within LIVE_WITHIN_SEC.
 * - `not-listening`: nothing has heard this bot for longer than that.
 * - `unknown`: nothing to go on. No row yet, a deployment that does not
 *   publish these yet, or a bot bound but not yet polled. NOT a verdict: the
 *   screen then says what it said before, rather than claim either way.
 *
 * ── THE CODE BELONGS TO A BOT ────────────────────────────────────────────
 *
 * The published code is shown only when the bot it was minted for is the bot
 * of the token the owner has saved now. A code minted for another bot does
 * not link this one (the worker re-mints on a change of bot), and showing it
 * is how an owner ends up sending a dead code into a live bot. Until the
 * agent has picked up the saved bot there is no code to show:
 * `linkPending`. A code that IS for this bot stays visible while nothing is
 * listening, and the screen says so beside it: it will work once the bot is
 * heard again, and hiding it would only send the owner looking for another.
 *
 * A BOT ANOTHER AGENT HAS CLAIMED is neither (`botElsewhere`). The owner's
 * saved token stays in their settings when the bot is moved to another
 * agent, but this agent is no longer handed it and will never pick it up
 * again, so "waiting for your agent" would wait for ever. No code, and the
 * screen says the bot is connected elsewhere, naming nothing about where.
 *
 * ── TRADING HELD, WHATEVER THE BOT ───────────────────────────────────────
 *
 * `tradingHeld` is the hold's class whenever the tenant is held, bot or no
 * bot, heard or not. The Telegram row can only say it when there is a bot to
 * talk about, and an owner with no bot gets no hold reply and no direct
 * message either: the dashboard is the one place left to tell them.
 *
 * Neither the token nor the code is ever part of `reason`.
 */
import { botIdOf } from "../../../worker/src/telegram/state";
import { pollErrKind } from "../../../worker/src/telegram/poll-rules";
import { pollFailingNow } from "../../../worker/src/telegram-liveness";

/**
 * A bot heard this recently is live. The polling process records a good poll
 * at most every 30s and each long poll takes up to 25s; the orchestrator
 * publishes every 15s. Three minutes is comfortably past all of that together.
 */
export const LIVE_WITHIN_SEC = 180;

export type ListeningState = "live" | "held" | "not-listening" | "conflict" | "revoked" | "unknown";

export interface Listening {
  state: ListeningState;
  /** When a poll of the saved bot last worked, unix seconds. Null when none has, or it is not known. */
  lastOkAt: number | null;
  /**
   * A few words on why, when there is something to say: the held class, or
   * what Telegram said about the last failed poll. Null otherwise.
   */
  reason: string | null;
}

/**
 * What the orchestrator published for this tenant (tenant_telegram), or what
 * the worker wrote self-hosted. A field that is UNDEFINED is one this
 * deployment does not publish yet, which is not the same as one published
 * as null: the first means "cannot tell", the second "told: nothing".
 */
export interface TelegramRuntime {
  linkCode: string | null;
  ownerId: number | null;
  botId?: string | null;
  pollOkAt?: number | null;
  pollErr?: string | null;
  pollErrAt?: number | null;
  childState?: string | null;
  /** The saved token's bot is claimed by another tenant (telegram_bot_claims). Undefined when not asked. */
  botElsewhere?: boolean;
}

export interface TelegramListening {
  listening: Listening;
  /** The code to show, or null. */
  linkCode: string | null;
  /** A bot is saved that the agent has not picked up yet, so there is no code for it to show. */
  linkPending: boolean;
  /** The saved bot is connected to another agent: this one will never pick it up. */
  botElsewhere: boolean;
  /** The class of the hold while trading is held, bot or no bot; null when it trades or is not known. */
  tradingHeld: string | null;
}

const UNKNOWN: Listening = { state: "unknown", lastOkAt: null, reason: null };

const sec = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The class a `held:<class>` child state names, or null when the tenant is not held. */
export function heldClass(childState: string | null | undefined): string | null {
  if (typeof childState !== "string" || !childState.startsWith("held:")) return null;
  const cls = childState.slice("held:".length).trim();
  return cls || "restore error";
}

/** The part of a published poll error after its kind: what Telegram, or the network, said. */
function errDetail(err: string): string {
  const colon = err.indexOf(":");
  return (colon > 0 ? err.slice(colon + 1) : err).trim();
}

/**
 * THE DECISION. `token` is the owner's saved token, read only for the bot id
 * before its ':'; `now` is unix seconds.
 */
export function telegramListening(
  row: TelegramRuntime | null,
  token: string | null | undefined,
  now: number,
): TelegramListening {
  const none = { botElsewhere: false, tradingHeld: null };
  if (!row) return { listening: UNKNOWN, linkCode: null, linkPending: false, ...none };
  // NOT PUBLISHED HERE YET: an orchestrator from before these columns, or a
  // worker from before the poll record. There is nothing to hold the code
  // against, so it is shown as it always was, and nothing is claimed about
  // listening either way.
  if (row.botId === undefined) return { listening: UNKNOWN, linkCode: row.linkCode, linkPending: false, ...none };

  // HELD is about trading, not about the bot, so it is true whichever bot is
  // saved, or none.
  const held = heldClass(row.childState);
  const saved = typeof token === "string" ? botIdOf(token.trim()) : null;
  // ANOTHER AGENT HAS THIS BOT. Whatever the row says about it is this
  // tenant's past, and nothing here will pick it up again: no code, and not
  // "pending" either.
  if (saved !== null && row.botElsewhere === true) {
    const listening: Listening = held !== null ? { state: "held", lastOkAt: null, reason: held } : UNKNOWN;
    return { listening, linkCode: null, linkPending: false, botElsewhere: true, tradingHeld: held };
  }
  const sameBot = saved !== null && row.botId === saved;
  const linkCode = sameBot ? row.linkCode : null;
  const linkPending = saved !== null && !sameBot;
  const rest = { linkCode, linkPending, botElsewhere: false, tradingHeld: held };

  // What was heard on THIS bot. Nothing, when the record is about another
  // bot or about none yet.
  const heard = sameBot ? hearing(row, now) : null;

  // HELD, unless the bot is measurably deaf. The hold process answers and
  // links, so the code stays.
  if (held !== null && (heard === null || heard.state === "live")) {
    return { listening: { state: "held", lastOkAt: heard?.lastOkAt ?? null, reason: held }, ...rest };
  }
  return { listening: heard ?? UNKNOWN, ...rest };
}

/** What the poll record of the saved bot says, or null when it says nothing. */
function hearing(row: TelegramRuntime, now: number): Listening | null {
  const okAt = sec(row.pollOkAt);
  const err = typeof row.pollErr === "string" && row.pollErr !== "" ? row.pollErr : null;
  const errAt = sec(row.pollErrAt);
  // Bound but not yet polled: the first getUpdates is on its way.
  if (okAt === null && err === null) return null;
  const failing = pollFailingNow(okAt, err, errAt);
  const kind = pollErrKind(err);
  // A refused token is said at once: waiting cannot change it.
  if (failing && kind === "refused") return { state: "revoked", lastOkAt: okAt, reason: errDetail(err!) };
  if (okAt !== null && now - okAt <= LIVE_WITHIN_SEC) return { state: "live", lastOkAt: okAt, reason: null };
  // A 409 only once it has kept the bot unheard: see `conflict` above.
  if (failing && kind === "conflict") return { state: "conflict", lastOkAt: okAt, reason: errDetail(err!) };
  return { state: "not-listening", lastOkAt: okAt, reason: failing ? errDetail(err!) : null };
}
