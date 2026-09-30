/**
 * THE RULES EVERY PROCESS THAT POLLS AN OWNER'S BOT FOLLOWS.
 *
 * Two processes poll a hosted owner's bot, one at a time: the trading child
 * (service.ts), and while trading is held, the hold process (hold.ts). The
 * hold process must not import the service, which pulls in the model, the
 * ledger and the chain. So what the two must agree on lives here: how long a
 * failed poll waits and how it is recorded, what a stranger and a late code
 * are told and what the log says about them, and how a slash command's name
 * is read. They share telegram.json and one bot, and
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
): { kind: PollErrKind; waitMs: number; line: string; err: string } {
  const reason = r.reason ?? "unknown error";
  let kind: PollErrKind;
  let waitSec: number;
  let line: string;
  let detail: string;
  if (r.errorCode === 409) {
    kind = "conflict";
    waitSec = CONFLICT_WAIT_SEC;
    // Both are a 409, and they need different fixes: stop the other program,
    // or delete the webhook. The webhook is never deleted from here; it may
    // be another deployment's.
    const webhook = /webhook/i.test(reason);
    line = webhook
      ? "Telegram: this bot has a webhook set, so its updates can't be polled (409 Conflict)"
      : "Telegram: another program is reading this bot's updates (409 Conflict)";
    detail = webhook ? "this bot has a webhook set (409)" : "another program is reading this bot's updates (409)";
  } else if (r.errorCode === 401 || r.errorCode === 404) {
    kind = "refused";
    waitSec = REFUSED_WAIT_SEC;
    line = `Telegram: the bot token was refused (${r.errorCode} ${reason}); trying again every 5 minutes, or as soon as the token changes`;
    detail = `${r.errorCode} ${reason}`;
  } else {
    kind = "failed";
    waitSec = Math.min(BACKOFF_MAX_SEC, 2 ** streak);
    line = `Telegram: getUpdates — ${reason}`;
    detail = reason;
  }
  return { kind, waitMs: Math.max(r.retryAfter ?? 0, waitSec) * 1000, line, err: pollErrText(kind, detail) };
}

/** The three ways a poll fails, as pollFailure tells them apart. */
export type PollErrKind = "conflict" | "refused" | "failed";

/** The longest poll error kept on disk and published: enough for the reason, never a page of HTML. */
const POLL_ERR_MAX = 160;

/**
 * A POLL FAILURE AS IT IS KEPT (telegram.json `poll.err`) AND PUBLISHED
 * (tenant_telegram.poll_err): `<kind>: <detail>`. The kind comes first so the
 * orchestrator's liveness pass and the dashboard read it without parsing
 * prose (pollErrKind); the detail is for the operator's log line.
 *
 * It leaves this process's home, for the shared database and the owner's
 * dashboard, so nothing that could be the token may ride in it. Telegram's own
 * descriptions never carry it, but a transport error names the URL it was
 * asking, and the token is in that URL's path. See cleanPollErr.
 */
export function pollErrText(kind: PollErrKind, detail: string): string {
  return `${kind}: ${cleanPollErr(detail) || "unknown error"}`.slice(0, POLL_ERR_MAX);
}

/**
 * POLL ERROR TEXT MADE SAFE TO KEEP, PUBLISH AND LOG: anything shaped like a
 * token blanked, anything that is not printable (a line break above all) made
 * a space, trimmed and clipped. Empty when nothing is left.
 *
 * Run by the writer (pollErrText) AND by every reader of the file
 * (state.ts parsePollHealth). The file is in the tenant's home, and the
 * orchestrator puts what it reads there into its own log lines and the
 * shared database. The home is not the orchestrator's to trust: an agent
 * with shell or file tools can write it, and an older build may have
 * written it without these rules. A line break in `err` would put a line of
 * the file's choosing into the fleet's log, untagged, where it reads as the
 * orchestrator's own (`[orchestrator] [alert] …`, naming any tenant).
 */
export function cleanPollErr(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<token>")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}/g, "<token>")
    .trim()
    .slice(0, POLL_ERR_MAX);
}

/** The kind a kept poll error names (pollErrText), or null for anything else. */
export function pollErrKind(err: string | null | undefined): PollErrKind | null {
  const colon = typeof err === "string" ? err.indexOf(":") : -1;
  const head = colon > 0 ? err!.slice(0, colon) : "";
  return head === "conflict" || head === "refused" || head === "failed" ? head : null;
}

/**
 * A chat id as the fleet's log may show it: its last four digits. Enough to
 * tell two chats apart in one incident and to match an owner who reads theirs
 * out, and not enough to message anyone.
 */
export const redactChat = (chatId: number): string => `…${String(Math.abs(chatId)).slice(-4)}`;

/**
 * A line for the fleet's log (stdout, which the orchestrator tags with the
 * tenant), in the shape the hold process has always used. Not the owner's
 * event feed: see makeChatTally.
 */
export function telegramLog(level: "ok" | "warn", message: string): void {
  console.log(`[telegram${level === "warn" ? " warn" : ""}] ${message}`);
}

/** How many chats each tally remembers before it starts over, so a flood of strangers cannot grow it without end. */
const TALLY_CHATS_KEPT = 1_000;
/** A failed send to one chat for one reason is logged at most this often. A blocked bot fails every reply the same way. */
const SEND_FAIL_RETELL_SEC = 3_600;

/**
 * WHAT A STRANGER DID TO THE BOT, AND WHICH MESSAGES NEVER ARRIVED, counted
 * and logged by whichever process is answering: the child (service.ts, and
 * the notifier's own sends beside it, one tally for both) or hold.ts.
 *
 * All three were invisible. In the incident this came from, an owner's chat
 * was refused a day's messages and locked out of /link by five codes that
 * were compared against the wrong one, and nothing in any log said so: the
 * refusals and the failed codes were not counted anywhere, and a reply
 * Telegram would not deliver was dropped without a word.
 *
 * Counted per chat, with the chat id cut to its last four digits
 * (redactChat). The first of each is logged and then the 2nd, 4th, 8th …, so
 * a stranger hammering the bot costs a handful of lines, not one per message.
 * A lockout is always logged: it is the one an owner will ask about. A failed
 * send is logged once an hour per chat and reason.
 *
 * THE FLEET'S LOG, NEVER THE OWNER'S FEED. `log` is telegramLog in both
 * processes, not the child's event sink: nearly everything here is
 * something a stranger did, and a stranger must not be able to write into
 * the owner's events. The owner's notice slot shows the newest warning
 * among their last events, and warnings like the live-rail blocker are
 * written once and never again; one `/link x` from anyone who knows the
 * bot's @username would have covered it for good, and a lockout line every
 * ten minutes would have kept it covered.
 */
export function makeChatTally(log: (level: "ok" | "warn", message: string) => void, now: () => number) {
  const refused = new Map<number, number>();
  const wrongCodes = new Map<number, number>();
  const sendFails = new Map<string, number>();
  const bump = (m: Map<number, number>, chatId: number): number => {
    if (m.size >= TALLY_CHATS_KEPT && !m.has(chatId)) m.clear();
    const n = (m.get(chatId) ?? 0) + 1;
    m.set(chatId, n);
    return n;
  };
  const worthTelling = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;
  return {
    /** A message from a chat not on the allowlist, answered with a refusal or the way in. */
    refused(chatId: number): void {
      const n = bump(refused, chatId);
      if (worthTelling(n)) log("ok", `Telegram: message from unlisted chat ${redactChat(chatId)} refused (${n} so far)`);
    },
    /**
     * A /link (or /start <code>) that did not link. `lockedUntil` is set when
     * this attempt was refused unlooked-at because the chat is locked, or
     * when this wrong code is the one that locked it (`justLocked`).
     */
    linkFailed(chatId: number, o: { locked: boolean; justLocked: boolean; lockedUntil?: number }): void {
      const n = bump(wrongCodes, chatId);
      if (o.justLocked && o.lockedUntil !== undefined) {
        const at = new Date(o.lockedUntil * 1000).toISOString().slice(11, 16);
        log("warn", `Telegram: chat ${redactChat(chatId)} locked out of /link until ${at} UTC after ${n} failed code(s)`);
        return;
      }
      if (worthTelling(n)) {
        log("warn", `Telegram: /link from chat ${redactChat(chatId)} failed${o.locked ? " (locked out)" : " (wrong code)"} — ${n} so far`);
      }
    },
    /** A reply Telegram would not take. */
    sendFailed(chatId: number, reason: string | undefined): void {
      const why = pollErrText("failed", reason ?? "unknown error").slice("failed: ".length);
      const key = `${chatId}:${why}`;
      const t = now();
      const last = sendFails.get(key);
      if (last !== undefined && t - last < SEND_FAIL_RETELL_SEC) return;
      if (sendFails.size >= TALLY_CHATS_KEPT && last === undefined) sendFails.clear();
      sendFails.set(key, t);
      log("warn", `Telegram: a reply to chat ${redactChat(chatId)} was not delivered — ${why}`);
    },
  };
}

export type ChatTally = ReturnType<typeof makeChatTally>;

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

/**
 * A group or supergroup; with no chat type (an older parse, or a button
 * press, which carries none), a negative id — the repo's long-standing group
 * test. Both processes that poll the bot ask this first: nothing in a group
 * goes down a DM's path (the refusal, the way in, /link and its lockout, the
 * backlog's notes), in the child (service.ts) or while trading is held
 * (hold.ts).
 */
export function isGroupMessage(m: { chatType?: string; chatId: number }): boolean {
  if (m.chatType === "group" || m.chatType === "supergroup") return true;
  return m.chatType === undefined && m.chatId < 0;
}

/**
 * WHETHER A LINE TYPED IN A GROUP SHOWS THE LIVE LINK CODE (docs/tg-groups.md
 * "Link codes are for DMs only"): as a word of its own anywhere in it, or
 * anywhere at all in what follows /link or /start ("/link CODE.", "/link
 * `CODE`", a longer run holding it). Everyone in the room has then seen a
 * bearer credential, so the process that reads it replaces it, whatever the
 * line's age and whoever is answering the bot: a false positive only costs a
 * fresh code.
 */
export function groupLineShowsCode(text: string, liveCode: string): boolean {
  const live = liveCode.toUpperCase();
  if (!live || !text) return false;
  const word = new RegExp(`(?<![A-Z0-9])${live.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)}(?![A-Z0-9])`, "i");
  if (word.test(text)) return true;
  const head = slashHead(text);
  return (head?.cmd === "link" || head?.cmd === "start") && head.arg.toUpperCase().includes(live);
}
