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
  init?: { method?: string; headers?: Record<string, string>; body?: string },
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
}

export interface TgBotInfo {
  id: number;
  username: string;
}

function short(token: string): string {
  return token.length > 8 ? `…${token.slice(-6)}` : "…";
}

/**
 * Call a bot method. Returns the parsed `result` on `{ ok: true }`, else a
 * reason. GET when no body, POST+JSON when a body is given.
 */
async function call(
  opts: TelegramOpts,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ result: unknown; reason?: string }> {
  const base = opts.apiBase ?? API_BASE;
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
  const url = `${base}/bot${opts.token}/${method}`;

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = params
      ? await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) })
      : await fetchFn(url);
  } catch (e) {
    return { result: null, reason: `request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok && res.status !== 200) {
    // Telegram returns 200 with {ok:false} for logical errors; other codes are transport-level.
    return { result: null, reason: `HTTP ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { result: null, reason: "response is not JSON" };
  }
  if (!body || typeof body !== "object") return { result: null, reason: "malformed response" };
  const env = body as { ok?: unknown; result?: unknown; description?: unknown };
  if (env.ok !== true) {
    return { result: null, reason: typeof env.description === "string" ? env.description : "bot API returned ok:false" };
  }
  return { result: env.result };
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

/** Long-poll for new messages. `offset` is the last handled updateId + 1. */
export async function getUpdates(
  opts: TelegramOpts,
  offset: number,
  timeoutSec = 25,
): Promise<{ messages: TgMessage[]; nextOffset: number; reason?: string }> {
  const { result, reason } = await call(opts, "getUpdates", {
    offset,
    timeout: timeoutSec,
    allowed_updates: ["message"],
  });
  if (!Array.isArray(result)) return { messages: [], nextOffset: offset, reason };

  const messages: TgMessage[] = [];
  let nextOffset = offset;
  for (const raw of result) {
    if (!raw || typeof raw !== "object") continue;
    const u = raw as { update_id?: unknown; message?: unknown };
    if (typeof u.update_id === "number") nextOffset = Math.max(nextOffset, u.update_id + 1);
    const m = u.message as
      | {
          chat?: { id?: unknown };
          from?: { id?: unknown; username?: unknown };
          text?: unknown;
          caption?: unknown;
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
    });
  }
  return { messages, nextOffset };
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
 * Send a message. Best-effort — returns a reason on failure, never throws.
 * Sends with HTML parse mode (formatters use <b>/<code>); if Telegram rejects
 * the entities, retries as plain text so a formatting bug never eats a reply.
 */
export async function sendMessage(
  opts: TelegramOpts,
  chatId: number,
  text: string,
): Promise<{ ok: boolean; reason?: string }> {
  // Telegram caps message text at 4096 chars.
  const body = text.length > 4096 ? text.slice(0, 4090) + "\n…" : text;
  const html = await call(opts, "sendMessage", { chat_id: chatId, text: body, parse_mode: "HTML" });
  if (html.result != null) return { ok: true };
  if (html.reason && /parse|entit|tag/i.test(html.reason)) {
    const plain = await call(opts, "sendMessage", { chat_id: chatId, text: body.replace(/<[^>]+>/g, "") });
    return plain.result != null ? { ok: true } : { ok: false, reason: plain.reason };
  }
  return { ok: false, reason: html.reason };
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
    const res = await fetchFn(`${base}/bot${opts.token}/${method}`, { method: "POST", body: form });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (body?.ok) return { ok: true };
    return { ok: false, reason: body?.description ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function sendPhoto(opts: TelegramOpts, chatId: number, filePath: string, caption?: string) {
  return sendFile(opts, "sendPhoto", "photo", chatId, filePath, caption);
}

export function sendDocument(opts: TelegramOpts, chatId: number, filePath: string, caption?: string) {
  return sendFile(opts, "sendDocument", "document", chatId, filePath, caption);
}
