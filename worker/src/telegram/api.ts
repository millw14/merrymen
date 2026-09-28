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
}

/** One inbound message, normalized to what the interpreter needs. */
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
   * from one that waited out the silence.
   */
  date: number;
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
}

function short(token: string): string {
  return token.length > 8 ? `…${token.slice(-6)}` : "…";
}

/**
 * How long one bot method may take before it is abandoned. getUpdates is
 * allowed its long-poll window on top of POLL_SLACK_SEC instead.
 */
const CALL_TIMEOUT_MS = 15_000;
/** Past a long poll's own `timeout`, how long before it counts as hung. */
const POLL_SLACK_SEC = 10;
/** An upload carries the file itself, so it gets longer than a JSON call. */
const UPLOAD_TIMEOUT_MS = 60_000;

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
  const t = setTimeout(() => ac.abort(new DOMException(`timed out after ${ms}ms`, "TimeoutError")), ms);
  (t as { unref?: () => void }).unref?.();
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
 * What a bot method came back with. `errorCode` and `retryAfter` are what the
 * poll loop backs off on: Telegram's own `error_code` (the HTTP status when the
 * body has none), and `parameters.retry_after` in seconds on a 429.
 */
interface CallResult {
  result: unknown;
  reason?: string;
  errorCode?: number;
  retryAfter?: number;
}

/**
 * Call a bot method. Returns the parsed `result` on `{ ok: true }`, else a
 * reason. GET when no body, POST+JSON when a body is given.
 *
 * EVERY CALL HAS A DEADLINE. The poll loop is strictly serial, one update after
 * the next, so a single request that never answered, a half-open socket after
 * a network blip, stalled every message behind it for as long as the process
 * lived, and nothing ever said so.
 */
async function call(
  opts: TelegramOpts,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<CallResult> {
  const base = opts.apiBase ?? API_BASE;
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
  const url = `${base}/bot${opts.token}/${method}`;
  const { signal, disarm } = deadline(timeoutMs);
  const timedOut = { result: null, reason: `request timed out after ${Math.round(timeoutMs / 1000)}s` };

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
      if (signal.aborted) return timedOut;
      return { result: null, reason: `request failed: ${e instanceof Error ? e.message : String(e)}` };
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
      if (signal.aborted) return timedOut;
      body = null;
    }
    const env = (body && typeof body === "object" ? body : {}) as {
      ok?: unknown;
      result?: unknown;
      description?: unknown;
      error_code?: unknown;
      parameters?: { retry_after?: unknown };
    };
    if (res.ok && env.ok === true) return { result: env.result };
    // Kept, not dropped with the rest of the envelope: a 429 that is retried
    // before its retry_after is refused again, and a 401 or 409 is not a
    // network blip and must not be retried like one.
    const errorCode = typeof env.error_code === "number" ? env.error_code : !res.ok ? res.status : undefined;
    const ra = env.parameters && typeof env.parameters === "object" ? env.parameters.retry_after : undefined;
    const why = { errorCode, ...(typeof ra === "number" && ra > 0 ? { retryAfter: ra } : {}) };
    if (typeof env.description === "string") return { result: null, reason: env.description, ...why };
    if (!res.ok) return { result: null, reason: `HTTP ${res.status}`, ...why };
    return { result: null, reason: body ? "bot API returned ok:false" : "response is not JSON", ...why };
  } finally {
    disarm();
  }
}

/** Validate a token and return the bot's identity (for the dashboard "test connection"). */
export async function getMe(opts: TelegramOpts): Promise<{ bot: TgBotInfo | null; reason?: string }> {
  const { result, reason } = await call(opts, "getMe");
  if (!result || typeof result !== "object") return { bot: null, reason: reason ?? `invalid token ${short(opts.token)}` };
  const r = result as { id?: unknown; username?: unknown };
  if (typeof r.id !== "number" || typeof r.username !== "string") {
    return { bot: null, reason: "getMe: missing id/username" };
  }
  return { bot: { id: r.id, username: r.username } };
}

/**
 * Long-poll for new messages. `offset` is the last handled updateId + 1.
 *
 * Bounded at `timeoutSec` plus POLL_SLACK_SEC: Telegram holds the request for
 * up to `timeoutSec` and then answers, so anything much past that is a request
 * that will never come back. On failure `errorCode` and `retryAfter` say how
 * long the caller should leave it (service.ts).
 */
export async function getUpdates(
  opts: TelegramOpts,
  offset: number,
  timeoutSec = 25,
): Promise<{
  messages: TgMessage[];
  callbacks: TgCallback[];
  nextOffset: number;
  reason?: string;
  errorCode?: number;
  retryAfter?: number;
}> {
  const { result, reason, errorCode, retryAfter } = await call(
    opts,
    "getUpdates",
    {
      offset,
      timeout: timeoutSec,
      // callback_query is how an inline button press arrives. Without it here
      // Telegram never delivers the press at all — the button spins and nothing
      // on this side can tell it was tapped.
      allowed_updates: ["message", "callback_query"],
    },
    (timeoutSec + POLL_SLACK_SEC) * 1000,
  );
  if (!Array.isArray(result)) {
    return {
      messages: [],
      callbacks: [],
      nextOffset: offset,
      // A reason always, even for a 200 whose result is not a list: the loop
      // treats "no reason" as a clean poll.
      reason: reason ?? "getUpdates returned no update list",
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }

  const messages: TgMessage[] = [];
  const callbacks: TgCallback[] = [];
  let nextOffset = offset;
  for (const raw of result) {
    if (!raw || typeof raw !== "object") continue;
    const u = raw as { update_id?: unknown; message?: unknown; callback_query?: unknown };
    if (typeof u.update_id === "number") nextOffset = Math.max(nextOffset, u.update_id + 1);
    const cb = parseCallback(u.update_id, u.callback_query);
    if (cb) {
      callbacks.push(cb);
      continue;
    }
    const m = u.message as
      | {
          chat?: { id?: unknown };
          from?: { id?: unknown; username?: unknown };
          text?: unknown;
          caption?: unknown;
          date?: unknown;
          voice?: { file_id?: unknown };
          audio?: { file_id?: unknown };
        }
      | undefined;
    if (!m) continue;
    const chatId = m.chat?.id;
    const fromId = m.from?.id;
    if (typeof chatId !== "number" || typeof fromId !== "number") continue;
    // Accept text messages OR voice/audio notes (for transcription). Voice notes
    // may carry no text; text falls back to the caption then empty.
    const voiceFileId =
      typeof m.voice?.file_id === "string" ? m.voice.file_id
      : typeof m.audio?.file_id === "string" ? m.audio.file_id
      : undefined;
    const text = typeof m.text === "string" ? m.text : typeof m.caption === "string" ? m.caption : "";
    if (!text && !voiceFileId) continue; // ignore stickers/photos/etc.
    messages.push({
      updateId: typeof u.update_id === "number" ? u.update_id : 0,
      chatId,
      fromId,
      fromUsername: typeof m.from?.username === "string" ? m.from.username : undefined,
      text,
      voiceFileId,
      date: typeof m.date === "number" ? m.date : 0,
    });
  }
  return { messages, callbacks, nextOffset };
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
}

/** Telegram caps message text at 4096 chars. */
function clip(t: string): string {
  return t.length > 4096 ? t.slice(0, 4090) + "\n…" : t;
}

/**
 * Send a message. Best-effort — returns a reason on failure, never throws.
 * Sends with HTML parse mode (formatters use <b>/<code>); if Telegram rejects
 * the entities, retries as plain text so a formatting bug never eats a reply.
 *
 * `messageId` comes back on success so a question with buttons can later be
 * edited to show what was decided.
 */
export async function sendMessage(
  opts: TelegramOpts,
  chatId: number,
  text: string,
  extra: SendExtra = {},
): Promise<{ ok: boolean; reason?: string; messageId?: number }> {
  const idOf = (r: unknown) => {
    const id = (r as { message_id?: unknown } | null)?.message_id;
    return typeof id === "number" ? id : undefined;
  };
  const attempt = async (
    body: string,
    keyboard: InlineKeyboard | undefined,
  ): Promise<{ ok: boolean; reason?: string; messageId?: number }> => {
    const kb = keyboard && keyboard.length ? { reply_markup: markup(keyboard) } : {};
    const html = await call(opts, "sendMessage", { chat_id: chatId, text: body, parse_mode: "HTML", ...kb });
    if (html.result != null) return { ok: true, messageId: idOf(html.result) };
    if (html.reason && /parse|entit|tag/i.test(html.reason)) {
      const plain = await call(opts, "sendMessage", { chat_id: chatId, text: body.replace(/<[^>]+>/g, ""), ...kb });
      return plain.result != null ? { ok: true, messageId: idOf(plain.result) } : { ok: false, reason: plain.reason };
    }
    return { ok: false, reason: html.reason };
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
 * take a few seconds, and silence reads as a dead bot. Best-effort.
 */
export async function sendChatAction(opts: TelegramOpts, chatId: number, action: "typing" = "typing"): Promise<void> {
  await call(opts, "sendChatAction", { chat_id: chatId, action });
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
  const base = opts.apiBase ?? API_BASE;
  const fetchFn = (opts.fetchFn ?? (fetch as unknown)) as typeof fetch;
  // Bounded like call(): an upload that never finishes would hold the serial
  // poll loop just as a hung sendMessage would.
  const { signal, disarm } = deadline(UPLOAD_TIMEOUT_MS);
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
    if (signal.aborted) return { ok: false, reason: `upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s` };
    return { ok: false, reason: body?.description ?? `HTTP ${res.status}` };
  } catch (e) {
    if (signal.aborted) return { ok: false, reason: `upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s` };
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
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
