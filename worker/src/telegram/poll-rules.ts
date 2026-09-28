/**
 * THE RULES EVERY PROCESS THAT POLLS AN OWNER'S BOT FOLLOWS.
 *
 * Two processes poll a hosted owner's bot, one at a time: the trading child
 * (service.ts), and while trading is held, the hold process (hold.ts). The
 * hold process must not import the service, which pulls in the model, the
 * ledger and the chain. So what the two must agree on lives here: how long a
 * failed poll waits, what a stranger and a late code are told, and how a
 * slash command's name is read. They share telegram.json and one bot, and
 * the owner should not be able to tell from the bot's manners which of them
 * is answering.
 *
 * Imports nothing.
 */

/** Between polls when the last one worked. getUpdates itself long-polls, so this can be tight. */
export const POLL_GAP_MS = 500;
/** How often to look again while Telegram is switched off or has no token. */
export const IDLE_GAP_MS = 8_000;
/** A failing poll waits 2s, 4s, 8s … up to this, or longer when Telegram names a retry_after. */
export const BACKOFF_MAX_SEC = 60;
/** After a 401 or 404. The token is revoked or wrong, and retrying sooner cannot fix that. */
export const REFUSED_WAIT_SEC = 300;
/** After a 409. Another poller holds the bot; hammering it only steals its updates back and forth. */
export const CONFLICT_WAIT_SEC = 10;
/** A 409 is logged at most this often. Two pollers trade 409s, so each quiet spell would re-log it. */
export const CONFLICT_RETELL_SEC = 3_600;
/** A long wait is taken in slices this long, so a token fixed on the dashboard is used within one. */
export const WAKE_SLICE_MS = 5_000;
/**
 * A silence this long re-arms the backlog boundary (service.ts pollOnce). About
 * as long as an owner waits for a reply before giving up on it; a blip the
 * backoff retries through (2s, 4s, 8s …) is well inside it, and anything that
 * failed for a 401's five minutes is well past it.
 */
export const REARM_AFTER_SEC = 60;

/**
 * What a chat that is not on the allowlist is told. Its own chat id, which is
 * what the owner would add by hand, and where the code is. Nothing about the
 * agent.
 */
export const refusalText = (chatId: number): string =>
  `🚫 not authorized — your chat id is ${chatId}. Ask the owner to add you, or send /link &lt;code&gt; with the code shown in Settings → Telegram.`;
/**
 * A bare /start or /help from a chat not on the allowlist: the first thing
 * anyone who finds the bot sees. What to do if the bot is theirs, and nothing
 * about the agent behind it.
 */
export const onboardingText = (chatId: number): string =>
  `This is a private Merrymen bot. If it's yours, send the /link code shown in Settings → Telegram. Your chat id is ${chatId}.`;
/**
 * A /link or /start <code> that waited out an outage (holdStale). Never
 * compared, never counted. Any chat may get it, so it says nothing more than
 * that the bot was offline.
 */
export const STALE_LINK_TEXT =
  "that code reached me after I'd been offline, so I didn't use it — send the code shown in Settings → Telegram now.";
/**
 * A /link sent to the bot before this agent was switched onto it (holdEarly).
 * Any chat may get this, so it says nothing about the switch itself.
 */
export const EARLY_LINK_TEXT = "that code reached me late, so I didn't use it — send the code shown in Settings → Telegram now.";

/** "45s", "4m 10s", "3h 5m", "2d 6h": how long polling was down, for the recovery line. */
export function span(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ${Math.floor((s % 3_600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3_600)}h`;
}

/**
 * A POLL THAT FAILED: what kind of failure, how long to leave it, and the line
 * that says so. `streak` counts this failure.
 *
 * The loop used to retry every 500ms whatever the answer. A revoked token
 * was asked again twice a second for days, a 429 was retried inside its own
 * retry_after, and a second poller on the same bot turned into two processes
 * taking the bot's updates from each other as fast as they could.
 */
export function pollFailure(
  r: { reason?: string; errorCode?: number; retryAfter?: number },
  streak: number,
): { kind: "conflict" | "refused" | "failed"; waitMs: number; line: string } {
  const reason = r.reason ?? "unknown error";
  let kind: "conflict" | "refused" | "failed";
  let waitSec: number;
  let line: string;
  if (r.errorCode === 409) {
    kind = "conflict";
    waitSec = CONFLICT_WAIT_SEC;
    // Both are a 409, and they need different fixes: stop the other program,
    // or delete the webhook. The webhook is never deleted from here; it may
    // be another deployment's.
    line = /webhook/i.test(reason)
      ? "Telegram: this bot has a webhook set, so its updates can't be polled (409 Conflict)"
      : "Telegram: another program is reading this bot's updates (409 Conflict)";
  } else if (r.errorCode === 401 || r.errorCode === 404) {
    kind = "refused";
    waitSec = REFUSED_WAIT_SEC;
    line = `Telegram: the bot token was refused (${r.errorCode} ${reason}); trying again every 5 minutes, or as soon as the token changes`;
  } else {
    kind = "failed";
    waitSec = Math.min(BACKOFF_MAX_SEC, 2 ** streak);
    line = `Telegram: getUpdates — ${reason}`;
  }
  return { kind, waitMs: Math.max(r.retryAfter ?? 0, waitSec) * 1000, line };
}

/**
 * A slash command's name and argument, read the way interpreter.ts parseSlash
 * reads them: the first word, lowercased, with any @BotName stripped, and the
 * rest trimmed. Null for anything that is not a slash command. For a process
 * that answers only a handful of commands and may not import the interpreter.
 */
export function slashHead(text: string): { cmd: string; arg: string } | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const [head, ...rest] = t.slice(1).split(/\s+/);
  return { cmd: (head ?? "").toLowerCase().replace(/@[\w]+$/, ""), arg: rest.join(" ").trim() };
}
