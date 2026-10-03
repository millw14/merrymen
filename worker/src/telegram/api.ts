/**
 * Telegram Bot API client — the merryman's mouth and ears.
 *
 * Mirrors the venue-client discipline (worker/src/venues/rialto.ts): an
 * injectable `FetchLike` for tests, and every method returns `{ result, reason }`
 * and NEVER throws — a dead network or a bad token degrades to a reason string,
 * it doesn't crash the poll loop. No SDK; bare fetch against
 * https://api.telegram.org/bot<token>/<method>.
 *
 * The bot token is a secret (settings/env, masked in the web API). It is never
 * logged in full.
 */

const API_BASE = "https://api.telegram.org";

/** Minimal fetch surface — supports the POST+JSON that sendMessage needs. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface TelegramOpts {
  token: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: FetchLike;
  /** Override the API host (tests). */
  apiBase?: string;
  /**
   * The longest one JSON call is waited for, in ms; TG_CALL_TIMEOUT_MS when
   * absent. getUpdates adds its long poll on top. A photo or document upload
   * is waited for this long or UPLOAD_TIMEOUT_MS, whichever is longer: a
   * bound set short to keep calls quick must not cut off a file.
   */
  timeoutMs?: number;
}

/**
 * THE LONGEST ONE CALL IS WAITED FOR, beyond any long poll it asked for.
 * fetch has no deadline of its own — Node gives up waiting for headers only
 * after about five minutes — and every group line is sent under its chat's
 * lock (tg-groups/handler.ts): one sendChatAction that never answered held
 * every later line of that chat until each had gone stale, and nothing was
 * logged. The poll loop is strictly serial too, so one getUpdates or reply
 * that never answered held every message behind it for as long as the
 * process lived. Past this the call is a failed request ("request failed:
 * timed out") and the request is aborted.
 *
 * A send that timed out may still have landed, so the paths that answer a
 * person do not retry it: a group line (tg-groups/handler.ts sends it once
 * and logs "no answer"), a DM reply (service.ts), and sendMessage's and
 * editMessageText's own fallbacks, which retry only on what Telegram refused.
 * Some delayed re-senders do send again after one, and may repeat an
 * informational message: the sign prompt and the energy alert (notifier.ts,
 * after half an hour), the group Stay/Leave DM (after an hour), and the
 * notify queue (mcp/notify.ts, by design). None of them repeats a trade.
 *
 * Ten seconds: a call still out at ten is not coming back in time to
 * matter, and a group line or a poll that waits longer only goes stale.
 * getUpdates gets its long poll on top (35 s at the default 25 s), and an
 * upload gets UPLOAD_TIMEOUT_MS instead.
 */
export const TG_CALL_TIMEOUT_MS = 10_000;

/** Telegram's kinds of chat (Chat.type). */
export type TgChatType = "private" | "group" | "supergroup" | "channel";

const CHAT_TYPES: ReadonlySet<string> = new Set<TgChatType>(["private", "group", "supergroup", "channel"]);

/** A known chat type, or undefined for anything Telegram may add later (never guessed). */
function chatTypeOf(v: unknown): TgChatType | undefined {
  return typeof v === "string" && CHAT_TYPES.has(v) ? (v as TgChatType) : undefined;
}

/**
 * One MessageEntity of the text (or caption) it came with. `offset` and
 * `length` are UTF-16 code units, which is how JS indexes strings, so
 * `text.slice(offset, offset + length)` is the entity's text.
 */
export interface TgEntity {
  /** "mention", "text_mention", "bot_command", "url", "text_link", "cashtag", … */
  type: string;
  offset: number;
  length: number;
  /** The user a `text_mention` names (people without a username are mentioned this way). */
  userId?: number;
  /** A `text_link`'s target, which is NOT part of the visible text. */
  url?: string;
}

/** The message a message replied to, in the same chat. */
export interface TgReplyTo {
  messageId: number;
  fromId?: number;
  fromIsBot?: boolean;
  /**
   * The replied-to message's text (else its caption), as Telegram quoted it,
   * at most REPLY_TEXT_MAX characters. What "wdyt about this" under a coin
   * post is asking about when the post itself was never remembered. Absent
   * when Telegram quoted none.
   */
  text?: string;
}

/** Telegram's own limit on a message's text: a quoted reply is never longer. */
const REPLY_TEXT_MAX = 4096;

/**
 * One inbound message, normalized to what the interpreter needs.
 *
 * Everything after `date` is optional and set only when Telegram sent it, so
 * a private message that carried none of it parses to exactly the shape it
 * always had. The group code reads those fields; the DM path does not need
 * them.
 */
export interface TgMessage {
  updateId: number;
  chatId: number;
  fromId: number;
  fromUsername?: string;
  text: string;
  /** Telegram file_id of an attached voice/audio note, if any (for transcription). */
  voiceFileId?: string;
  /**
   * When Telegram received it, unix seconds; 0 when the update carried no date.
   * Telegram holds undelivered updates for up to a day, so after an outage a
   * batch can be hours old, and this is the only way to tell a live message
   * from one that waited out the silence. The same value as `dateSec` below,
   * which the group code reads and which is set only when Telegram sent one.
   */
  date: number;
  /** message_id within the chat: what a reply or a reaction targets. */
  messageId?: number;
  /** Telegram's `date`, unix seconds. */
  dateSec?: number;
  chatType?: TgChatType;
  chatTitle?: string;
  /** A supergroup with topics. */
  isForum?: boolean;
  /**
   * from.is_bot. NOT a loop guard on its own: when `senderChatId` is set (an
   * anonymous admin, or a linked channel's auto-forward) `from` is Telegram's
   * placeholder user, and the anonymous-admin one is a bot account.
   */
  fromIsBot?: boolean;
  fromFirstName?: string;
  /** sender_chat.id: the message was sent on behalf of a chat, not by `from`. */
  senderChatId?: number;
  /** The forum topic (or thread) it belongs to; answer in the same one. */
  messageThreadId?: number;
  isTopicMessage?: boolean;
  /** From `entities` when the text is the message text, `caption_entities` when it is the caption. */
  entities?: TgEntity[];
  replyTo?: TgReplyTo;
}

/**
 * A change in the BOT's own membership of a chat (a `my_chat_member` update):
 * added, removed, kicked, promoted. `fromId` is who did it, which is how a
 * group added by the owner is told from one added by a stranger. In a private
 * chat this only ever means the user blocked or unblocked the bot.
 */
export interface TgMemberUpdate {
  updateId: number;
  chatId: number;
  chatType: TgChatType;
  chatTitle?: string;
  isForum?: boolean;
  fromId: number;
  fromUsername?: string;
  fromFirstName?: string;
  /** ChatMember.status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked". */
  oldStatus: string;
  newStatus: string;
  /**
   * Only a "restricted" ChatMember carries is_member, and when it is false the
   * bot is not in the chat at all despite the status.
   */
  newIsMember?: boolean;
  dateSec: number;
}

/** One person in a new_chat_members service message. */
export interface TgServiceMember {
  id: number;
  isBot: boolean;
  firstName: string;
  username?: string;
}

/**
 * A group service message: people joined or left, or the group became a
 * supergroup (and so changed id). These arrive whatever the privacy mode.
 *
 * ITS OWN TYPE, NEVER A TgMessage. Everything in `messages` is treated as
 * something a person typed; a join is not a line anyone said.
 */
export interface TgServiceMessage {
  updateId: number;
  chatId: number;
  chatType: TgChatType;
  chatTitle?: string;
  messageId: number;
  dateSec: number;
  /** Who did it (who added the members, who upgraded the group), when Telegram says. */
  fromId?: number;
  newChatMembers?: TgServiceMember[];
  /** The member who left or was removed; may be the bot itself. */
  leftChatMember?: { id: number; isBot: boolean };
  /** Sent in the OLD group: its new supergroup id. */
  migrateToChatId?: number;
  /** Sent in the NEW supergroup: the id it had as a group. */
  migrateFromChatId?: number;
}

/**
 * A tap on one of our inline buttons.
 *
 * ITS OWN TYPE, NOT A TgMessage WITH EMPTY TEXT. Every caller of `messages`
 * treats `text` as something the owner typed; a button press routed through
 * that path would reach the classifier as "" and could be mistaken for a typed
 * instruction. A press only ever means "the answer to the question we asked",
 * so it gets a shape that can mean nothing else.
 */
export interface TgCallback {
  updateId: number;
  /** callback_query id — must be answered, or the owner's button spins. */
  id: string;
  /** The chat the button's message lives in. */
  chatId: number;
  /** Who pressed it. In a group this is NOT the chat. */
  fromId: number;
  fromUsername?: string;
  /** The message carrying the keyboard, so it can be edited to show the outcome. */
  messageId: number;
  /** Our own callback_data, at most 64 bytes. */
  data: string;
  /**
   * The date of the message the button sits on, unix seconds; 0 when absent.
   * A press carries no time of its own, so this is a lower bound: the press
   * came after the question was asked. Telegram itself sends 0 for a message
   * it can no longer show, which is why absent and 0 mean the same here.
   */
  date: number;
}

/**
 * One inline button: either a callback we handle, or a link Telegram opens.
 *
 * `callbackData` is capped at 64 BYTES by Telegram — callers pass a short token
 * (see buttons.ts), never content.
 */
export type InlineButton = { text: string; callbackData: string } | { text: string; url: string };

/** Rows of buttons, top to bottom. */
export type InlineKeyboard = InlineButton[][];

export interface TgBotInfo {
  id: number;
  username: string;
  /**
   * getMe's own `is_bot`, which every real getMe answer carries as true. A
   * caller that trusts the id (a bot claim) asks for it, so no other method's
   * answer, a chat's or a user's, can pass for getMe's.
   */
  isBot: boolean;
  /**
   * getMe's first_name: the display name members see on the bot's lines
   * ("Pine Bot"), which is often what they call it rather than its username or
   * soul name. Absent when Telegram left it out or it was not a string.
   */
  firstName?: string;
  /** getMe's can_join_groups: false when BotFather's "Allow Groups" is off. */
  canJoinGroups?: boolean;
  /**
   * getMe's can_read_all_group_messages: true when privacy mode is off. It
   * reports the BotFather setting only; a group the bot joined before the
   * change still delivers as before until the bot is removed and re-added.
   */
  canReadAllGroupMessages?: boolean;
}

function short(token: string): string {
  return token.length > 8 ? `…${token.slice(-6)}` : "…";
}

/**
 * An upload carries the file itself, so it gets longer than a JSON call's
 * TG_CALL_TIMEOUT_MS. It holds the serial poll loop while it runs, so it is
 * bounded all the same. A caller's `timeoutMs` can raise it, never lower it.
 */
const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * What a request past its limit comes back with, from call() and from an
 * upload alike. "request failed: …" is how every caller tells the transport
 * (no answer, which may still have landed) from Telegram saying no: the
 * group sender logs it as "no answer" and does not retry it
 * (tg-groups/handler.ts), notify.ts files it as "network", and the poll loop
 * backs it off as a plain failure (poll-rules.ts pollFailure).
 */
const TIMED_OUT = "request failed: timed out";

/**
 * How long one JSON call is waited for: the caller's `timeoutMs` when it gave
 * a usable one, else `fallback` (TG_CALL_TIMEOUT_MS). A long poll's own window
 * is added on top by call(); an upload takes the longer of this and
 * UPLOAD_TIMEOUT_MS (sendFile).
 */
function limitOf(opts: TelegramOpts, fallback: number): number {
  const own = opts.timeoutMs;
  return typeof own === "number" && Number.isFinite(own) && own > 0 ? own : fallback;
}

/**
 * A signal that aborts after `ms`, and a way to disarm it once the call is done.
 *
 * On setTimeout rather than AbortSignal.timeout because node:test's mock
 * timers drive setTimeout and cannot reach the internal timer
 * AbortSignal.timeout runs on, so a test could not show the bound holds. The
 * reason is the same TimeoutError AbortSignal.timeout would give.
 */
export function deadline(ms: number): { signal: AbortSignal; disarm: () => void } {
  const ac = new AbortController();
  // NOT unref'd. The deadline is what ends a request whose transport holds
  // nothing open — a fetch that never answers and owns no socket — and an
  // unref'd timer is exactly the one that cannot: the event loop empties with
  // the request still pending, and whoever awaited it never hears. CI (Node 22)
  // cancelled a whole test file that way. Every caller disarms in a finally,
  // so the timer never outlives the request it bounds.
  const t = setTimeout(() => ac.abort(new DOMException(`timed out after ${ms}ms`, "TimeoutError")), ms);
  return { signal: ac.signal, disarm: () => clearTimeout(t) };
}

/**
 * `p`, or a rejection the moment `signal` aborts, whichever comes first.
 *
 * The signal is also handed to fetch, and a real fetch honours it for the
 * request and the body. This makes the bound hold for ANY FetchLike, including
 * one that ignores the signal, so the deadline belongs to call() and not to
 * whichever fetch happened to be passed in.
 */
export function orAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * An error message with the token cut out. A fetch failure can quote the URL
 * it failed on, and the URL carries the token. Very short strings are left
 * alone: a real token is ~46 chars, and cutting a 1-char test token out of a
 * reason would only mangle it.
 */
function scrub(message: string, token: string): string {
  return token.length >= 8 ? message.split(token).join(short(token)) : message;
}

/**
 * What a call came back with. `result` on success; otherwise a reason plus
 * the ResponseParameters Telegram attached, which say what to do next: wait
 * `retryAfterSec` (flood control, for the whole bot), or send to
 * `migrateToChatId` (the group became a supergroup and changed id).
 * `errorCode` is Telegram's own `error_code` (the HTTP status when the body
 * has none): the poll loop backs off on it and on `retryAfterSec`.
 */
interface CallResult {
  result: unknown;
  reason?: string;
  errorCode?: number;
  retryAfterSec?: number;
  migrateToChatId?: number;
}

/**
 * The error details of a refused call. `error_code` falls back to the HTTP
 * status. retry_after is read from `parameters`; the "retry after N" in the
 * description is only a fallback for a reply that lost its parameters.
 */
function failureOf(env: { description?: unknown; error_code?: unknown; parameters?: unknown }, httpOk: boolean, status: number) {
  const out: Pick<CallResult, "errorCode" | "retryAfterSec" | "migrateToChatId"> = {};
  if (typeof env.error_code === "number") out.errorCode = env.error_code;
  else if (!httpOk) out.errorCode = status;
  const p = (env.parameters && typeof env.parameters === "object" ? env.parameters : {}) as {
    retry_after?: unknown;
    migrate_to_chat_id?: unknown;
  };
  if (typeof p.retry_after === "number" && Number.isFinite(p.retry_after) && p.retry_after >= 0) {
    out.retryAfterSec = p.retry_after;
  } else if (typeof env.description === "string") {
    const m = /retry after (\d+)/i.exec(env.description);
    if (m) out.retryAfterSec = Number(m[1]);
  }
  if (typeof p.migrate_to_chat_id === "number" && Number.isSafeInteger(p.migrate_to_chat_id)) {
    out.migrateToChatId = p.migrate_to_chat_id;
  }
  return out;
}

/** retryAfterSec / migrateToChatId of a refused call, only the ones it has. */
function nextStep(r: CallResult): { retryAfterSec?: number; migrateToChatId?: number } {
  return {
    ...(r.retryAfterSec !== undefined ? { retryAfterSec: r.retryAfterSec } : {}),
    ...(r.migrateToChatId !== undefined ? { migrateToChatId: r.migrateToChatId } : {}),
  };
}

/**
 * The characters a token may have and still be sent: Telegram's own, digits,
 * ':' and base64url. The token is pasted into the URL's PATH, and one holding
 * '/', '.', '?', '#' or '%' steers the request somewhere else on
 * api.telegram.org: `x/../../bot<other>/getChat?…` is resolved by the URL
 * parser into a call on another bot. A token that cannot be Telegram's is
 * refused here, before anything is sent, whatever the caller checked.
 */
const SENDABLE_TOKEN = /^[A-Za-z0-9:_-]+$/;

/**
 * Call a bot method. Returns the parsed `result` on `{ ok: true }`, else a
 * reason and whatever ResponseParameters came with it. GET when no body,
 * POST+JSON when a body is given.
 *
 * EVERY CALL HAS A DEADLINE: TG_CALL_TIMEOUT_MS (or the caller's own
 * `timeoutMs`), plus `pollMs`, the long poll a getUpdates asked Telegram to
 * hold it open. Past it the request is aborted and the answer is "request
 * failed: timed out" (TIMED_OUT), whether or not the transport honours the
 * abort, and whether it was the answer or its body that never came. Two
 * things waited on one that never answered: the poll loop, which is strictly
 * serial, so a half-open socket after a network blip stalled every message
 * behind it for as long as the process lived; and a group's send lock
 * (tg-groups/handler.ts), so every later line of that chat went stale.
 */
async function call(opts: TelegramOpts, method: string, params?: Record<string, unknown>, pollMs = 0): Promise<CallResult> {
  if (!SENDABLE_TOKEN.test(opts.token)) return { result: null, reason: "not a bot token (it has characters no Telegram token has)" };
  const base = opts.apiBase ?? API_BASE;
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
  const url = `${base}/bot${opts.token}/${method}`;
  const { signal, disarm } = deadline(limitOf(opts, TG_CALL_TIMEOUT_MS) + Math.max(0, pollMs));

  try {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await orAbort(
        params
          ? fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal })
          : fetchFn(url, { signal }),
        signal,
      );
    } catch (e) {
      if (signal.aborted) return { result: null, reason: TIMED_OUT };
      return { result: null, reason: `request failed: ${scrub(e instanceof Error ? e.message : String(e), opts.token)}` };
    }
    // READ THE BODY ON AN ERROR TOO. Telegram answers a refused request with
    // HTTP 400 AND a JSON description ("Bad Request: can't parse entities…",
    // "…button URL … is invalid"). Returning "HTTP 400" before reading it meant
    // every fallback keyed on that description — the plain-text retry when the
    // markup is refused, the retry without a link button — never ran: the reply
    // was simply lost.
    let body: unknown = null;
    try {
      body = await orAbort(res.json(), signal);
    } catch {
      if (signal.aborted) return { result: null, reason: TIMED_OUT };
      body = null;
    }
    const env = (body && typeof body === "object" ? body : {}) as {
      ok?: unknown;
      result?: unknown;
      description?: unknown;
      error_code?: unknown;
      parameters?: unknown;
    };
    if (res.ok && env.ok === true) return { result: env.result };
    // Kept, not dropped with the rest of the envelope: a 429 that is retried
    // before its retry_after is refused again, a 401 or 409 is not a network
    // blip and must not be retried like one, and a group that became a
    // supergroup is only reachable at its new id.
    const failure = failureOf(env, res.ok, res.status);
    if (typeof env.description === "string") return { result: null, reason: env.description, ...failure };
    if (!res.ok) return { result: null, reason: `HTTP ${res.status}`, ...failure };
    return { result: null, reason: body ? "bot API returned ok:false" : "response is not JSON", ...failure };
  } finally {
    disarm();
  }
}

/**
 * Validate a token and return the bot's identity (for the dashboard "test
 * connection"). A failure carries Telegram's error code when it answered
 * with one, so a refusal (401, 404) can be told from no answer at all (a
 * "request failed: …" reason and no code) or a Telegram that was down or
 * throttling (5xx, 429): see telegramDidNotAnswer in telegram-claims.ts.
 */
export async function getMe(opts: TelegramOpts): Promise<{ bot: TgBotInfo | null; reason?: string; errorCode?: number }> {
  const { result, reason, errorCode } = await call(opts, "getMe");
  if (!result || typeof result !== "object") {
    return { bot: null, reason: reason ?? `invalid token ${short(opts.token)}`, ...(errorCode !== undefined ? { errorCode } : {}) };
  }
  const r = result as {
    id?: unknown;
    username?: unknown;
    is_bot?: unknown;
    first_name?: unknown;
    can_join_groups?: unknown;
    can_read_all_group_messages?: unknown;
  };
  if (typeof r.id !== "number" || typeof r.username !== "string") {
    return { bot: null, reason: "getMe: missing id/username" };
  }
  return {
    bot: {
      id: r.id,
      username: r.username,
      isBot: r.is_bot === true,
      ...(typeof r.first_name === "string" && r.first_name.trim() ? { firstName: r.first_name.trim() } : {}),
      ...(typeof r.can_join_groups === "boolean" ? { canJoinGroups: r.can_join_groups } : {}),
      ...(typeof r.can_read_all_group_messages === "boolean" ? { canReadAllGroupMessages: r.can_read_all_group_messages } : {}),
    },
  };
}

/** Current chat identity for a one-target operator notice. No updates are read. */
export async function getChat(
  opts: TelegramOpts,
  chatId: number,
): Promise<{ chat: { id: number; title: string; type: TgChatType; isForum: boolean } | null; reason?: string }> {
  const { result, reason } = await call(opts, "getChat", { chat_id: chatId });
  if (!result || typeof result !== "object") return { chat: null, reason: reason ?? "getChat returned no chat" };
  const r = result as { id?: unknown; title?: unknown; type?: unknown; is_forum?: unknown };
  const type = chatTypeOf(r.type);
  if (!Number.isSafeInteger(r.id) || typeof r.title !== "string" || !type) {
    return { chat: null, reason: "getChat returned invalid chat identity" };
  }
  return { chat: { id: r.id as number, title: r.title, type, isForum: r.is_forum === true } };
}

/**
 * The update kinds the bot asks for. Telegram keeps this list server-side
 * until it is changed, so anything left out here is never delivered at all.
 * The hold process polls through this same function, so it asks for the same
 * list and never switches off what the trading child needs.
 *
 * - callback_query is how an inline button press arrives. Without it the
 *   press is never delivered — the button spins and nothing on this side can
 *   tell it was tapped.
 * - my_chat_member is how the bot learns it was added to a group (and by
 *   whom), removed, or kicked. It is in Telegram's default list, but an
 *   explicit list that leaves it out switches it off.
 *
 * edited_message stays out on purpose: edits are ignored (docs/tg-groups.md).
 */
const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"] as const;

/**
 * Long-poll for new messages. `offset` is the last handled updateId + 1.
 *
 * Bounded at `timeoutSec` plus TG_CALL_TIMEOUT_MS (35 s at the default 25 s
 * poll): Telegram holds the request for up to `timeoutSec` and then answers,
 * so anything much past that is a request that will never come back, and it
 * comes back as "request failed: timed out" with the offset kept. A timeout
 * carries no `errorCode`, so the poll loop backs it off as a plain failure;
 * on a refusal `errorCode` and `retryAfter` say how long the caller should
 * leave it (poll-rules.ts pollFailure).
 */
export async function getUpdates(
  opts: TelegramOpts,
  offset: number,
  timeoutSec = 25,
): Promise<{
  messages: TgMessage[];
  callbacks: TgCallback[];
  members: TgMemberUpdate[];
  service: TgServiceMessage[];
  nextOffset: number;
  reason?: string;
  errorCode?: number;
  retryAfter?: number;
}> {
  const { result, reason, errorCode, retryAfterSec } = await call(
    opts,
    "getUpdates",
    { offset, timeout: timeoutSec, allowed_updates: ALLOWED_UPDATES },
    // Telegram holds a long poll open this long by design: the bound is on top of it.
    Math.max(0, Number.isFinite(timeoutSec) ? timeoutSec : 0) * 1000,
  );
  if (!Array.isArray(result)) {
    return {
      messages: [],
      callbacks: [],
      members: [],
      service: [],
      nextOffset: offset,
      // A reason always, even for a 200 whose result is not a list: the loop
      // treats "no reason" as a clean poll.
      reason: reason ?? "getUpdates returned no update list",
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(retryAfterSec !== undefined && retryAfterSec > 0 ? { retryAfter: retryAfterSec } : {}),
    };
  }

  const messages: TgMessage[] = [];
  const callbacks: TgCallback[] = [];
  const members: TgMemberUpdate[] = [];
  const service: TgServiceMessage[] = [];
  let nextOffset = offset;
  for (const raw of result) {
    if (!raw || typeof raw !== "object") continue;
    const u = raw as { update_id?: unknown; message?: unknown; callback_query?: unknown; my_chat_member?: unknown };
    if (typeof u.update_id === "number") nextOffset = Math.max(nextOffset, u.update_id + 1);
    const cb = parseCallback(u.update_id, u.callback_query);
    if (cb) {
      callbacks.push(cb);
      continue;
    }
    const member = parseMemberUpdate(u.update_id, u.my_chat_member);
    if (member) {
      members.push(member);
      continue;
    }
    // A service message goes to `service` or nowhere — never on to the text
    // path below, even when it cannot be parsed. Telegram never puts text on
    // one, so no line anyone typed is lost by this.
    if (isServiceShaped(u.message)) {
      const s = parseService(u.update_id, u.message);
      if (s) service.push(s);
      continue;
    }
    const m = parseMessage(u.update_id, u.message);
    if (m) messages.push(m);
  }
  return { messages, callbacks, members, service, nextOffset };
}

/** The raw Message fields this file reads. */
interface RawMessage {
  message_id?: unknown;
  date?: unknown;
  chat?: { id?: unknown; type?: unknown; title?: unknown; is_forum?: unknown };
  from?: { id?: unknown; username?: unknown; first_name?: unknown; is_bot?: unknown };
  sender_chat?: { id?: unknown };
  message_thread_id?: unknown;
  is_topic_message?: unknown;
  text?: unknown;
  caption?: unknown;
  entities?: unknown;
  caption_entities?: unknown;
  reply_to_message?: unknown;
  voice?: { file_id?: unknown };
  audio?: { file_id?: unknown };
  new_chat_members?: unknown;
  left_chat_member?: unknown;
  migrate_to_chat_id?: unknown;
  migrate_from_chat_id?: unknown;
}

/** A text / caption / voice message, or null for anything else (stickers, photos without a caption, …). */
function parseMessage(updateId: unknown, raw: unknown): TgMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as RawMessage;
  const chatId = m.chat?.id;
  const fromId = m.from?.id;
  if (typeof chatId !== "number" || typeof fromId !== "number") return null;
  // Accept text messages OR voice/audio notes (for transcription). Voice notes
  // may carry no text; text falls back to the caption then empty.
  const voiceFileId =
    typeof m.voice?.file_id === "string" ? m.voice.file_id
    : typeof m.audio?.file_id === "string" ? m.audio.file_id
    : undefined;
  const text = typeof m.text === "string" ? m.text : typeof m.caption === "string" ? m.caption : "";
  if (!text && !voiceFileId) return null; // ignore stickers/photos/etc.
  // The entities that index into `text`: a caption's come separately.
  const rawEntities =
    typeof m.text === "string" ? m.entities
    : typeof m.caption === "string" ? m.caption_entities
    : undefined;
  const chatType = chatTypeOf(m.chat?.type);
  const replyTo = parseReplyTo(m.reply_to_message);
  return {
    updateId: typeof updateId === "number" ? updateId : 0,
    chatId,
    fromId,
    fromUsername: typeof m.from?.username === "string" ? m.from.username : undefined,
    text,
    voiceFileId,
    date: typeof m.date === "number" ? m.date : 0,
    // Group fields: each only when present, so a message without them keeps
    // the exact shape it always had.
    ...(typeof m.message_id === "number" ? { messageId: m.message_id } : {}),
    ...(typeof m.date === "number" ? { dateSec: m.date } : {}),
    ...(chatType ? { chatType } : {}),
    ...(typeof m.chat?.title === "string" ? { chatTitle: m.chat.title } : {}),
    ...(typeof m.chat?.is_forum === "boolean" ? { isForum: m.chat.is_forum } : {}),
    ...(typeof m.from?.is_bot === "boolean" ? { fromIsBot: m.from.is_bot } : {}),
    ...(typeof m.from?.first_name === "string" ? { fromFirstName: m.from.first_name } : {}),
    ...(typeof m.sender_chat?.id === "number" ? { senderChatId: m.sender_chat.id } : {}),
    ...(typeof m.message_thread_id === "number" ? { messageThreadId: m.message_thread_id } : {}),
    ...(typeof m.is_topic_message === "boolean" ? { isTopicMessage: m.is_topic_message } : {}),
    ...(Array.isArray(rawEntities) ? { entities: parseEntities(rawEntities) } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
}

/** MessageEntity[] → TgEntity[], dropping any entry without a type or a sane span. */
function parseEntities(raw: unknown[]): TgEntity[] {
  const out: TgEntity[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const x = e as { type?: unknown; offset?: unknown; length?: unknown; user?: { id?: unknown }; url?: unknown };
    if (typeof x.type !== "string") continue;
    if (!Number.isInteger(x.offset) || !Number.isInteger(x.length)) continue;
    const offset = x.offset as number;
    const length = x.length as number;
    if (offset < 0 || length < 0) continue;
    out.push({
      type: x.type,
      offset,
      length,
      ...(typeof x.user?.id === "number" ? { userId: x.user.id } : {}),
      ...(typeof x.url === "string" ? { url: x.url } : {}),
    });
  }
  return out;
}

/**
 * reply_to_message → TgReplyTo, or undefined.
 *
 * IN A FORUM, EVERY MESSAGE IN A TOPIC "REPLIES" TO THE TOPIC'S OPENING
 * SERVICE MESSAGE (the one carrying forum_topic_created) even when nobody
 * pressed reply. That is where the message lives, not what it answers, so it
 * is not reported as a reply: a memory line would otherwise point at the
 * topic's creation, and a topic the bot opened would read as "replied to me".
 */
function parseReplyTo(raw: unknown): TgReplyTo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { message_id?: unknown; from?: { id?: unknown; is_bot?: unknown }; forum_topic_created?: unknown; text?: unknown; caption?: unknown };
  if (typeof r.message_id !== "number") return undefined;
  if (r.forum_topic_created) return undefined;
  const text = typeof r.text === "string" && r.text ? r.text : typeof r.caption === "string" && r.caption ? r.caption : "";
  return {
    messageId: r.message_id,
    ...(typeof r.from?.id === "number" ? { fromId: r.from.id } : {}),
    ...(typeof r.from?.is_bot === "boolean" ? { fromIsBot: r.from.is_bot } : {}),
    ...(text ? { text: text.slice(0, REPLY_TEXT_MAX) } : {}),
  };
}

/** A message carrying any of the service fields this file reports. */
function isServiceShaped(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const m = raw as RawMessage;
  return (
    m.new_chat_members !== undefined ||
    m.left_chat_member !== undefined ||
    m.migrate_to_chat_id !== undefined ||
    m.migrate_from_chat_id !== undefined
  );
}

/**
 * A group service message, or null. Needs a known chat type, a message id and
 * a date; one without them is dropped rather than guessed, like a button
 * press without its chat.
 */
function parseService(updateId: unknown, raw: unknown): TgServiceMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as RawMessage;
  const chatId = m.chat?.id;
  const chatType = chatTypeOf(m.chat?.type);
  if (typeof chatId !== "number" || !chatType) return null;
  if (typeof m.message_id !== "number" || typeof m.date !== "number") return null;

  const joined: TgServiceMember[] = [];
  if (Array.isArray(m.new_chat_members)) {
    for (const x of m.new_chat_members) {
      if (!x || typeof x !== "object") continue;
      const p = x as { id?: unknown; is_bot?: unknown; first_name?: unknown; username?: unknown };
      if (typeof p.id !== "number") continue;
      joined.push({
        id: p.id,
        isBot: p.is_bot === true,
        firstName: typeof p.first_name === "string" ? p.first_name : "",
        ...(typeof p.username === "string" ? { username: p.username } : {}),
      });
    }
  }
  const leftRaw = (m.left_chat_member && typeof m.left_chat_member === "object" ? m.left_chat_member : null) as {
    id?: unknown;
    is_bot?: unknown;
  } | null;
  const left = leftRaw && typeof leftRaw.id === "number" ? { id: leftRaw.id, isBot: leftRaw.is_bot === true } : undefined;
  const to = typeof m.migrate_to_chat_id === "number" && Number.isSafeInteger(m.migrate_to_chat_id) ? m.migrate_to_chat_id : undefined;
  const from = typeof m.migrate_from_chat_id === "number" && Number.isSafeInteger(m.migrate_from_chat_id) ? m.migrate_from_chat_id : undefined;
  if (!joined.length && !left && to === undefined && from === undefined) return null;

  return {
    updateId: typeof updateId === "number" ? updateId : 0,
    chatId,
    chatType,
    ...(typeof m.chat?.title === "string" ? { chatTitle: m.chat.title } : {}),
    messageId: m.message_id,
    dateSec: m.date,
    ...(typeof m.from?.id === "number" ? { fromId: m.from.id } : {}),
    ...(joined.length ? { newChatMembers: joined } : {}),
    ...(left ? { leftChatMember: left } : {}),
    ...(to !== undefined ? { migrateToChatId: to } : {}),
    ...(from !== undefined ? { migrateFromChatId: from } : {}),
  };
}

/**
 * A my_chat_member update, or null. Who made the change (`from`) is required:
 * without it an add by the owner cannot be told from an add by a stranger,
 * and that decides whether the bot speaks there at all.
 */
function parseMemberUpdate(updateId: unknown, raw: unknown): TgMemberUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as {
    chat?: { id?: unknown; type?: unknown; title?: unknown; is_forum?: unknown };
    from?: { id?: unknown; username?: unknown; first_name?: unknown };
    date?: unknown;
    old_chat_member?: { status?: unknown };
    new_chat_member?: { status?: unknown; is_member?: unknown };
  };
  const chatId = c.chat?.id;
  const chatType = chatTypeOf(c.chat?.type);
  const fromId = c.from?.id;
  const oldStatus = c.old_chat_member?.status;
  const newStatus = c.new_chat_member?.status;
  if (typeof chatId !== "number" || !chatType || typeof fromId !== "number") return null;
  if (typeof oldStatus !== "string" || typeof newStatus !== "string" || typeof c.date !== "number") return null;
  return {
    updateId: typeof updateId === "number" ? updateId : 0,
    chatId,
    chatType,
    ...(typeof c.chat?.title === "string" ? { chatTitle: c.chat.title } : {}),
    ...(typeof c.chat?.is_forum === "boolean" ? { isForum: c.chat.is_forum } : {}),
    fromId,
    ...(typeof c.from?.username === "string" ? { fromUsername: c.from.username } : {}),
    ...(typeof c.from?.first_name === "string" ? { fromFirstName: c.from.first_name } : {}),
    oldStatus,
    newStatus,
    ...(typeof c.new_chat_member?.is_member === "boolean" ? { newIsMember: c.new_chat_member.is_member } : {}),
    dateSec: c.date,
  };
}

/** A callback_query update, or null when it is not one we can act on. */
function parseCallback(updateId: unknown, raw: unknown): TgCallback | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as {
    id?: unknown;
    data?: unknown;
    from?: { id?: unknown; username?: unknown };
    message?: { message_id?: unknown; chat?: { id?: unknown }; date?: unknown };
  };
  if (typeof q.id !== "string" || typeof q.data !== "string") return null;
  const fromId = q.from?.id;
  const chatId = q.message?.chat?.id;
  const messageId = q.message?.message_id;
  // A press on a message too old for Telegram to hand back has no chat, and so
  // no way to tell whose question it answers. Dropped rather than guessed.
  if (typeof fromId !== "number" || typeof chatId !== "number" || typeof messageId !== "number") return null;
  return {
    updateId: typeof updateId === "number" ? updateId : 0,
    id: q.id,
    chatId,
    fromId,
    fromUsername: typeof q.from?.username === "string" ? q.from.username : undefined,
    messageId,
    data: q.data,
    date: typeof q.message?.date === "number" ? q.message.date : 0,
  };
}

/**
 * The commands shown in the Telegram "/" menu. Mirrors /help (reads.ts) as
 * Telegram BotCommand entries: 1-32 lowercase alphanumeric/underscore, no
 * leading slash, plain-text descriptions (no HTML). This is the FULL menu —
 * pushed to each allowlisted chat so owners keep discoverability. Strangers
 * see the trimmed publicBotCommands subset instead.
 */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: "help", description: "list every command" },
  { command: "status", description: "what the band is doing now" },
  { command: "positions", description: "current positions and P&L" },
  { command: "depth", description: "liquidity map for one SYMBOL" },
  { command: "pnl", description: "profit and loss" },
  { command: "trades", description: "recent trades" },
  { command: "report", description: "today's campfire report" },
  { command: "why", description: "why I made my last trade" },
  { command: "brag", description: "your scorecard" },
  { command: "pause", description: "hold trading" },
  { command: "resume", description: "resume trading" },
  { command: "strategy", description: "switch strategy" },
  { command: "settings", description: "see your settings (change them by text)" },
  { command: "set", description: "change a setting — I ask you to confirm" },
  { command: "cap", description: "set the per-action chat ceiling (USDG)" },
  { command: "buy", description: "buy SYMBOL for USDG (passes the wall)" },
  { command: "sell", description: "sell SYMBOL for USDG" },
  { command: "transfer", description: "send USDG out (asks to /confirm)" },
  { command: "confirm", description: "approve a pending send or PC action" },
  { command: "cancel", description: "cancel a pending action" },
  { command: "kill", description: "destroy the grant, stand the band down" },
  { command: "alert", description: "ping me at a price" },
  { command: "alerts", description: "list price alerts" },
  { command: "unalert", description: "remove an alert" },
  { command: "name", description: "give your merryman a name" },
  { command: "remember", description: "keep a fact about you" },
  { command: "forget", description: "wipe what I know about you" },
  { command: "soul", description: "who I am and what I know" },
  { command: "wallet", description: "create, restore, or recover a wallet" },
  { command: "link", description: "pair this chat with a link code" },
  { command: "shot", description: "take a screenshot" },
  { command: "look", description: "what am I looking at?" },
  { command: "ls", description: "list files in a directory" },
  { command: "open", description: "open an app or URL" },
  { command: "sys", description: "system info" },
  { command: "vol", description: "volume up/down/mute" },
  { command: "media", description: "media play/pause/next/prev" },
  { command: "notify", description: "send a notification" },
  { command: "lock", description: "lock the machine" },
  { command: "sleep", description: "sleep the machine" },
  { command: "shutdown", description: "shut the machine down" },
  { command: "get", description: "send a file to this chat" },
  { command: "clip", description: "read or set the clipboard" },
  { command: "run", description: "run an allowlisted shell command" },
  { command: "type", description: "type into the active window" },
  { command: "key", description: "press a key combo (ctrl+s)" },
  { command: "pc", description: "what remote control is enabled" },
  { command: "watch", description: "watch cpu/file/proc" },
  { command: "watchers", description: "list watchers" },
  { command: "unwatch", description: "remove a watcher" },
  { command: "remind", description: "set a reminder in 20m/2h/90s" },
  { command: "reminders", description: "list reminders" },
  { command: "unremind", description: "remove a reminder" },
  { command: "agent", description: "run a multi-step task on your PC" },
];

/**
 * What an arbitrary stranger sees in the "/" menu. Pure reads + onboarding
 * signposts only — the remote-control surface (shell/keyboard/power/files,
 * agent) and the trading controls stay OUT of the public menu so the bot
 * doesn't advertise what it can do to a computer. Every command is still
 * gated at runtime; this is about not painting the target, while owners get
 * the full menu pushed to their own allowlisted chats (service.ts).
 */
const PUBLIC_COMMAND_NAMES = new Set([
  "help",
  "status",
  "positions",
  "depth",
  "pnl",
  "trades",
  "report",
  "why",
  "brag",
  "alerts",
  "reminders",
  "soul",
  "wallet",
  "link",
]);

export const publicBotCommands = BOT_COMMANDS.filter((c) => PUBLIC_COMMAND_NAMES.has(c.command));

/** Push the command menu to Telegram. Best-effort — never throws.
 * scope takes a chat_id for the per-allowlisted-chat full-menu push. */
export async function setMyCommands(
  opts: TelegramOpts,
  commands?: { command: string; description: string }[],
  scope?: { type: string; chat_id?: number },
): Promise<{ ok: boolean; reason?: string }> {
  const { result, reason } = await call(opts, "setMyCommands", {
    commands: commands ?? BOT_COMMANDS,
    ...(scope ? { scope } : {}),
  });
  return result != null ? { ok: true } : { ok: false, reason };
}

/** Resolve a Telegram file_id to a downloadable URL (getFile → file_path). */
export async function getFileUrl(opts: TelegramOpts, fileId: string): Promise<{ url: string | null; reason?: string }> {
  const { result, reason } = await call(opts, "getFile", { file_id: fileId });
  const fp = (result as { file_path?: unknown } | null)?.file_path;
  if (typeof fp !== "string") return { url: null, reason: reason ?? "no file_path" };
  const base = opts.apiBase ?? API_BASE;
  return { url: `${base}/file/bot${opts.token}/${fp}` };
}

/**
 * Escape text for Telegram HTML parse mode. Any dynamic content that can carry
 * user input (echoed commands, strategy names, error messages) MUST pass
 * through this before being embedded in an HTML-formatted reply.
 */
export function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * A model's words, for Telegram HTML: escaped exactly as esc() does, and then
 * the one piece of markdown models write anyway, `**bold**`, made bold.
 *
 * Escaped model text showed the asterisks: an owner read
 * `**"launchpad buying: off — dashboard only"**` with the stars in it. The
 * conversion runs AFTER escaping and only ever adds a bare <b></b> around text
 * that is already escaped, so it can't turn quoted text into a link or any
 * other tag — the reason model text is escaped at all. A pair that doesn't
 * close is left as typed; a <b> cut short by clip() fails the HTML send and
 * sendMessage retries plain.
 */
export function escModel(s: string): string {
  return esc(s).replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "<b>$1</b>");
}

/** Telegram's wire shape for an inline keyboard. */
function markup(keyboard: InlineKeyboard): { inline_keyboard: unknown[][] } {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((b) => ("url" in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callbackData })),
    ),
  };
}

/**
 * The same keyboard with every LINK button taken out, and the links themselves.
 *
 * Telegram refuses a URL button it will not open — `localhost`, a bare IP — and
 * it refuses the WHOLE message, not just the button. Self-hosted, the dashboard
 * IS `http://localhost:3100`, so a "sign now" button there would silently cost
 * the owner the message it was attached to. On that refusal the link moves into
 * the text instead.
 */
export function withoutLinks(keyboard: InlineKeyboard): { keyboard: InlineKeyboard; links: { text: string; url: string }[] } {
  const links: { text: string; url: string }[] = [];
  const rows = keyboard
    .map((row) =>
      row.filter((b) => {
        if ("url" in b) {
          links.push(b);
          return false;
        }
        return true;
      }),
    )
    .filter((row) => row.length > 0);
  return { keyboard: rows, links };
}

export interface SendExtra {
  /** Inline buttons under the message. */
  keyboard?: InlineKeyboard;
  /**
   * Send as a Telegram reply to this message (reply_parameters). If that
   * message is gone by the time this lands, it is sent as a plain message
   * instead of failing (allow_sending_without_reply).
   */
  replyToMessageId?: number;
  /** The forum topic to post in (message_thread_id). Only for forum supergroups. */
  messageThreadId?: number;
  /** Deliver without a notification sound. */
  disableNotification?: boolean;
  /** No link preview card under the text (link_preview_options.is_disabled). */
  disablePreview?: boolean;
}

/** A positive integer: the only thing Telegram accepts as a message or thread id. */
function isId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/**
 * The optional send parameters of `extra`, in Telegram's wire shape. Empty
 * when none is set, so a DM send's request body is exactly what it was
 * before these options existed.
 */
function sendOptions(extra: SendExtra): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isId(extra.replyToMessageId)) {
    out.reply_parameters = { message_id: extra.replyToMessageId, allow_sending_without_reply: true };
  }
  if (isId(extra.messageThreadId)) out.message_thread_id = extra.messageThreadId;
  if (extra.disableNotification === true) out.disable_notification = true;
  if (extra.disablePreview === true) out.link_preview_options = { is_disabled: true };
  return out;
}

/** Telegram caps message text at 4096 chars. */
function clip(t: string): string {
  return t.length > 4096 ? t.slice(0, 4090) + "\n…" : t;
}

/** What sendMessage reports. `retryAfterSec` / `migrateToChatId` only on a refusal that carried them. */
export interface SendResult {
  ok: boolean;
  reason?: string;
  messageId?: number;
  /** Flood control: nothing from this bot should go out for this many seconds. */
  retryAfterSec?: number;
  /** The group became a supergroup; this is its new chat id. */
  migrateToChatId?: number;
}

/**
 * Send a message. Best-effort — returns a reason on failure, never throws.
 * Sends with HTML parse mode (formatters use <b>/<code>); if Telegram rejects
 * the entities, retries as plain text so a formatting bug never eats a reply.
 * Every retry keeps the reply / topic / notification / preview options: a
 * reply that lost them would land as a loose line in the wrong topic.
 *
 * `messageId` comes back on success so a question with buttons can later be
 * edited to show what was decided.
 */
export async function sendMessage(
  opts: TelegramOpts,
  chatId: number,
  text: string,
  extra: SendExtra = {},
): Promise<SendResult> {
  const idOf = (r: unknown) => {
    const id = (r as { message_id?: unknown } | null)?.message_id;
    return typeof id === "number" ? id : undefined;
  };
  const options = sendOptions(extra);
  const attempt = async (body: string, keyboard: InlineKeyboard | undefined): Promise<SendResult> => {
    const kb = keyboard && keyboard.length ? { reply_markup: markup(keyboard) } : {};
    const html = await call(opts, "sendMessage", { chat_id: chatId, text: body, parse_mode: "HTML", ...kb, ...options });
    if (html.result != null) return { ok: true, messageId: idOf(html.result) };
    if (html.reason && /parse|entit|tag/i.test(html.reason)) {
      const plain = await call(opts, "sendMessage", { chat_id: chatId, text: body.replace(/<[^>]+>/g, ""), ...kb, ...options });
      return plain.result != null
        ? { ok: true, messageId: idOf(plain.result) }
        : { ok: false, reason: plain.reason, ...nextStep(plain) };
    }
    return { ok: false, reason: html.reason, ...nextStep(html) };
  };

  const first = await attempt(clip(text), extra.keyboard);
  if (first.ok || !extra.keyboard) return first;
  // A refused keyboard must not cost the owner the message. Only a refusal
  // that names the buttons is retried — a dead token or a blocked chat would
  // fail the same way twice.
  if (!first.reason || !/button|url|reply.?markup|keyboard/i.test(first.reason)) return first;
  const { keyboard, links } = withoutLinks(extra.keyboard);
  const tail = links.map((l) => `\n${esc(l.text)}: ${esc(l.url)}`).join("");
  return attempt(clip(`${text}${tail}`), keyboard.length ? keyboard : undefined);
}

/**
 * Replace a message's text, and its buttons with `keyboard` (none when absent).
 *
 * How a confirm question becomes its answer: the owner sees "✅ changed" where
 * the buttons were, so an old prompt cannot be pressed twice by accident.
 */
export async function editMessageText(
  opts: TelegramOpts,
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<{ ok: boolean; reason?: string }> {
  const body = clip(text);
  const kb = keyboard && keyboard.length ? { reply_markup: markup(keyboard) } : {};
  const r = await call(opts, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: body,
    parse_mode: "HTML",
    ...kb,
  });
  if (r.result != null) return { ok: true };
  if (r.reason && /parse|entit|tag/i.test(r.reason)) {
    const plain = await call(opts, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: body.replace(/<[^>]+>/g, ""),
      ...kb,
    });
    return plain.result != null ? { ok: true } : { ok: false, reason: plain.reason };
  }
  return { ok: false, reason: r.reason };
}

/**
 * Show "typing…" in the chat while an answer is being looked up — the lookups
 * take a few seconds, and silence reads as a dead bot. Best-effort, never
 * throws. In a forum the status shows only in the topic named by
 * `messageThreadId`.
 *
 * `ok` is also the cheapest proof that a chat can be written to, with nothing
 * left behind in it: Telegram refuses it where it would refuse a message (a
 * person who never opened a DM with the bot, or who blocked it).
 */
export async function sendChatAction(
  opts: TelegramOpts,
  chatId: number,
  action: "typing" | "upload_photo" = "typing",
  messageThreadId?: number,
): Promise<{ ok: boolean; reason?: string }> {
  const r = await call(opts, "sendChatAction", {
    chat_id: chatId,
    action,
    ...(isId(messageThreadId) ? { message_thread_id: messageThreadId } : {}),
  });
  return r.result != null ? { ok: true } : { ok: false, reason: r.reason };
}

/**
 * Put one emoji reaction on a message, or clear ours with `null`. Bots get
 * one reaction per message, from Telegram's fixed emoji list; the caller
 * picks from a subset of it. Best-effort, never throws; `retryAfterSec`
 * comes back on flood control like a send.
 */
export async function setMessageReaction(
  opts: TelegramOpts,
  chatId: number,
  messageId: number,
  emoji: string | null,
): Promise<{ ok: boolean; reason?: string; retryAfterSec?: number }> {
  const r = await call(opts, "setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: emoji ? [{ type: "emoji", emoji }] : [],
  });
  if (r.result != null) return { ok: true };
  return { ok: false, reason: r.reason, ...(r.retryAfterSec !== undefined ? { retryAfterSec: r.retryAfterSec } : {}) };
}

/** Leave a group (a stranger's group the owner said no to). Never throws. */
export async function leaveChat(opts: TelegramOpts, chatId: number): Promise<{ ok: boolean; reason?: string }> {
  const r = await call(opts, "leaveChat", { chat_id: chatId });
  return r.result != null ? { ok: true } : { ok: false, reason: r.reason };
}

/**
 * A member's status in a chat ("creator", "administrator", "member",
 * "restricted", "left", "kicked"), or null when Telegram would not say.
 * Telegram only guarantees this for other users when the bot is an admin, so
 * null means "unknown", never "not a member".
 */
export async function getChatMember(opts: TelegramOpts, chatId: number, userId: number): Promise<{ status: string } | null> {
  const r = await call(opts, "getChatMember", { chat_id: chatId, user_id: userId });
  const status = (r.result && typeof r.result === "object" ? (r.result as { status?: unknown }).status : undefined);
  return typeof status === "string" ? { status } : null;
}

/**
 * Acknowledge a button press. Telegram shows a spinner on the button until
 * this is called, so it is called for EVERY press, including refused ones.
 * `text` appears as a small toast.
 */
export async function answerCallbackQuery(
  opts: TelegramOpts,
  callbackId: string,
  text?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const r = await call(opts, "answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text ? { text: text.slice(0, 190) } : {}),
  });
  return r.result != null ? { ok: true } : { ok: false, reason: r.reason };
}

/**
 * Upload a local file as a photo or document via multipart/form-data. Bypasses
 * the JSON-only `call()` (uses global FormData/Blob/fetch, Node 22+). Never
 * throws — a failed upload returns a reason so the poll loop keeps running.
 * `field` is "photo" (sendPhoto) or "document" (sendDocument).
 */
async function sendFile(
  opts: TelegramOpts,
  method: "sendPhoto" | "sendDocument",
  field: "photo" | "document",
  chatId: number,
  filePath: string,
  caption?: string,
): Promise<{ ok: boolean; reason?: string }> {
  // Refused like call() refuses it: this builds its own URL.
  if (!SENDABLE_TOKEN.test(opts.token)) return { ok: false, reason: "not a bot token (it has characters no Telegram token has)" };
  const base = opts.apiBase ?? API_BASE;
  const fetchFn = (opts.fetchFn ?? (fetch as unknown)) as typeof fetch;
  // Bounded like call(): an upload that never finishes would hold the serial
  // poll loop just as a hung sendMessage would. Never shorter than
  // UPLOAD_TIMEOUT_MS: a `timeoutMs` set to keep JSON calls quick would
  // otherwise cut every photo and document to it, without a word.
  const { signal, disarm } = deadline(Math.max(limitOf(opts, TG_CALL_TIMEOUT_MS), UPLOAD_TIMEOUT_MS));
  try {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const bytes = readFileSync(filePath);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) {
      form.append("caption", caption.length > 1024 ? caption.slice(0, 1020) + "…" : caption);
      form.append("parse_mode", "HTML");
    }
    form.append(field, new Blob([bytes]), path.basename(filePath));
    const res = await orAbort(fetchFn(`${base}/bot${opts.token}/${method}`, { method: "POST", body: form, signal }), signal);
    const body = (await orAbort(res.json(), signal).catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (body?.ok) return { ok: true };
    if (signal.aborted) return { ok: false, reason: TIMED_OUT };
    return { ok: false, reason: body?.description ?? `HTTP ${res.status}` };
  } catch (e) {
    if (signal.aborted) return { ok: false, reason: TIMED_OUT };
    return { ok: false, reason: scrub(e instanceof Error ? e.message : String(e), opts.token) };
  } finally {
    disarm();
  }
}

export function sendPhoto(opts: TelegramOpts, chatId: number, filePath: string, caption?: string) {
  return sendFile(opts, "sendPhoto", "photo", chatId, filePath, caption);
}

export function sendDocument(opts: TelegramOpts, chatId: number, filePath: string, caption?: string) {
  return sendFile(opts, "sendDocument", "document", chatId, filePath, caption);
}

/**
 * A PHOTO FROM BYTES, AS A GROUP REPLY — what the market desk sends: a chart
 * drawn in memory, its caption, the reply and topic it belongs to. Bounded
 * like every upload, never throws, and reports what a group sender needs from
 * a refusal (flood wait, a supergroup's new id) the way sendMessage does. An
 * HTML caption Telegram rejects is sent again as plain text, so a formatting
 * slip never costs the chart.
 */
export async function sendPhotoBytes(
  opts: TelegramOpts,
  chatId: number,
  png: Uint8Array,
  caption: string,
  extra: SendExtra = {},
): Promise<SendResult> {
  if (!SENDABLE_TOKEN.test(opts.token)) return { ok: false, reason: "not a bot token (it has characters no Telegram token has)" };
  const base = opts.apiBase ?? API_BASE;
  const fetchFn = (opts.fetchFn ?? (fetch as unknown)) as typeof fetch;
  // A photo has no link preview: sendPhoto takes no link_preview_options.
  const { link_preview_options: _preview, ...options } = sendOptions(extra);
  const attempt = async (text: string, html: boolean): Promise<SendResult & { entityRefused?: boolean }> => {
    const { signal, disarm } = deadline(Math.max(limitOf(opts, TG_CALL_TIMEOUT_MS), UPLOAD_TIMEOUT_MS));
    try {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (text) form.append("caption", text);
      if (text && html) form.append("parse_mode", "HTML");
      for (const [k, v] of Object.entries(options)) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      form.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "chart.png");
      const res = await orAbort(fetchFn(`${base}/bot${opts.token}/sendPhoto`, { method: "POST", body: form, signal }), signal);
      const body = (await orAbort(res.json(), signal).catch(() => null)) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: unknown };
        parameters?: { retry_after?: unknown; migrate_to_chat_id?: unknown };
      } | null;
      if (body?.ok) return { ok: true, ...(typeof body.result?.message_id === "number" ? { messageId: body.result.message_id } : {}) };
      if (signal.aborted) return { ok: false, reason: TIMED_OUT };
      const reason = body?.description ?? `HTTP ${res.status}`;
      const retry = body?.parameters?.retry_after;
      const moved = body?.parameters?.migrate_to_chat_id;
      return {
        ok: false,
        reason,
        ...(typeof retry === "number" && Number.isFinite(retry) ? { retryAfterSec: retry } : {}),
        ...(typeof moved === "number" && Number.isFinite(moved) ? { migrateToChatId: moved } : {}),
        entityRefused: /parse|entit|tag/i.test(reason),
      };
    } catch (e) {
      if (signal.aborted) return { ok: false, reason: TIMED_OUT };
      return { ok: false, reason: scrub(e instanceof Error ? e.message : String(e), opts.token) };
    } finally {
      disarm();
    }
  };
  // MEASURED AS TELEGRAM MEASURES IT: the visible text, in UTF-16 units. A
  // caption over the cap goes as plain text cut at the cap — never as HTML cut
  // in the middle of a tag or an entity.
  const visible = caption.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  if (visible.length > 1024) {
    const { entityRefused: _, ...rest } = await attempt(Array.from(visible).reduce((acc, ch) => (acc.length + ch.length <= 1020 ? acc + ch : acc), "") + "…", false);
    return rest;
  }
  const first = await attempt(caption, true);
  if (first.ok || !first.entityRefused) {
    const { entityRefused: _, ...rest } = first;
    return rest;
  }
  const plain = await attempt(visible, false);
  const { entityRefused: _, ...rest } = plain;
  return rest;
}
