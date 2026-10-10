/** Server-only Bot API transport. Tokens never appear in a response or a log. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { botIdOf } from "../../../worker/src/telegram/state";

export interface TelegramManagerConfig { token: string; username: string; webhookSecret: string }
/** Where Telegram delivers the manager's updates, under this deployment's public origin. */
export const MANAGER_WEBHOOK_PATH = "/api/telegram/manager/webhook";
/**
 * `managed_bot` is subscribed to as Telegram documents it; only `message` (a
 * /start, a creation) and `callback_query` (the Connect and Not this bot
 * buttons) are acted on, and the webhook says why. A webhook already set
 * without one of these is set again by the readiness probe ("stale").
 */
export const MANAGER_ALLOWED_UPDATES = ["message", "managed_bot", "callback_query"] as const;
/**
 * The manager's webhook URL for a configured public origin, or null when there
 * is none Telegram would accept: Bot API webhooks are HTTPS only, and a path,
 * query or credential in the origin would send the manager's updates somewhere
 * this service does not answer.
 */
export function managerWebhookUrl(origin: string | undefined | null): string | null {
  if (!origin) return null;
  let url: URL;
  try { url = new URL(origin.replace(/\/$/, "")); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  return `${url.origin}${MANAGER_WEBHOOK_PATH}`;
}
/**
 * What the manager's webhook points at, compared with this deployment's URL.
 * "stale": this URL, but subscribed to less than MANAGER_ALLOWED_UPDATES (a
 * webhook set before the buttons existed, or by hand), so the buttons'
 * presses would never arrive.
 */
export type ManagerWebhook = "unset" | "ours" | "stale" | "elsewhere";
export function validWebhookSecret(received: string | null, expected: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class TelegramManagerError extends Error {
  constructor() { super("Telegram could not complete this step. Please try again."); }
}
export interface ManagedBotIdentity { id: string; username: string }

type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
/** A message the manager sends or edits into: plain text, and its inline buttons. */
export interface ManagerNotice { text: string; buttons: InlineButton[][] }

/**
 * WHAT A BUTTON CARRIES: `mc:<intent id>:<bot id>` to connect, `mx:…` for
 * Not this bot. The intent id is a random UUID with no authority of its own
 * (forTelegramUser finds it only through the Telegram user who pressed), and
 * the bot id is the public one the message names; never the challenge, the
 * tenant or a token. Telegram allows 64 bytes, and this is at most 60.
 */
export type ManagerPress = { action: "connect" | "cancel"; intentId: string; botId: string };
const PRESS = /^(mc|mx):([A-Za-z0-9_-]{16,36}):([1-9][0-9]{0,19})$/;
export function pressData(action: ManagerPress["action"], intentId: string, botId: string): string {
  const data = `${action === "connect" ? "mc" : "mx"}:${intentId}:${botId}`;
  if (!PRESS.test(data) || Buffer.byteLength(data) > 64) throw new TelegramManagerError();
  return data;
}
export function parsePress(data: unknown): ManagerPress | null {
  const match = typeof data === "string" ? PRESS.exec(data) : null;
  return match ? { action: match[1] === "mc" ? "connect" : "cancel", intentId: match[2]!, botId: match[3]! } : null;
}

/**
 * EVERYTHING THE MANAGER SAYS ABOUT A SETUP, in one place. `home` is this
 * deployment's public origin, for the Back to Merrymen button; without one the
 * button is left off. Usernames are Telegram's own, already validated; no
 * message carries a token, a challenge, a tenant or a link code.
 */
const back = (home: string | null): InlineButton[][] => home ? [[{ text: "Back to Merrymen", url: home }]] : [];
export const managerNotices = {
  /** A bot was just made for a setup underway: connect it from here, or say it is the wrong one. */
  ready: (bot: ManagedBotIdentity, intentId: string): ManagerNotice => ({
    text: `✅ @${bot.username} is ready.\nConnect it to your Merrymen agent?`,
    buttons: [[{ text: `Connect @${bot.username}`, callback_data: pressData("connect", intentId, bot.id) }],
      [{ text: "Not this bot", callback_data: pressData("cancel", intentId, bot.id) }]],
  }),
  /** A bot made with no setup underway for its maker: nothing was connected, and they are told so. */
  unmatched: (username: string, home: string | null): ManagerNotice => ({
    text: `Your bot @${username} was created, but this Merrymen setup had expired, so it wasn't connected. Start again from Merrymen and create the bot within 30 minutes.`,
    buttons: back(home),
  }),
  /**
   * SAVED, NOT RUNNING. Only the agent's own worker (or its hold process)
   * starts the bot and mints the code "Open my bot" carries, and an agent the
   * fleet holds (not yet admitted, an expired session key, a recovery or
   * accounting hold) has neither. This side cannot see which, so it says what
   * the bot waits for rather than promising when it will answer.
   */
  connected: (username: string, home: string | null): ManagerNotice => ({
    text: `✅ Connected @${username} to your Merrymen agent.\n@${username} replies once your agent is running. Merrymen then shows "Open my bot" to link your chat with it. If your agent is paused for recovery, that waits until it resumes.`,
    buttons: back(home),
  }),
  expired: (home: string | null): ManagerNotice => ({ text: "This setup expired. Start again from Merrymen.", buttons: back(home) }),
  cancelled: (username: string, home: string | null): ManagerNotice => ({
    text: `Cancelled. Start again from Merrymen when you're ready.\nIf you don't need @${username}, you can delete it in @BotFather.`,
    buttons: back(home),
  }),
  /** complete() refused: the agent's settings already hold a bot token (this one or another). */
  alreadyHasBot: (username: string, home: string | null): ManagerNotice => ({
    text: `Your Merrymen agent already has a Telegram bot, so @${username} wasn't connected. To use @${username} instead, replace the bot in Settings on Merrymen.`,
    buttons: back(home),
  }),
  /** complete() refused: another agent holds the bot. Whose is never said (lib/telegram-claims.ts). */
  claimed: (username: string, home: string | null): ManagerNotice => ({
    text: `@${username} is already connected to another Merrymen agent, so it wasn't connected to yours.`,
    buttons: back(home),
  }),
  /** Anything else: the buttons stay, to try again, and Merrymen can still connect it. */
  failed: (bot: ManagedBotIdentity, intentId: string): ManagerNotice => ({
    text: "Couldn't connect right now. Try again, or connect from Merrymen.",
    buttons: managerNotices.ready(bot, intentId).buttons,
  }),
};
const markup = (notice: ManagerNotice) => notice.buttons.length ? { reply_markup: { inline_keyboard: notice.buttons } } : {};
/**
 * A PUBLIC USERNAME THAT SAYS NOTHING ABOUT ITS OWNER. #284 suggested
 * `merrymen_<telegram user id>_bot`, which would have published the owner's
 * numeric Telegram id in a bot username anyone can look up, for as long as the
 * bot exists. Eight random hex digits instead: `merrymen_1a2b3c4d_bot`, 21
 * characters, inside Telegram's 5 to 32 and ending in "bot" as it requires. A
 * clash is Telegram's to report, and the owner picks another in its dialog.
 */
export function suggestedUsername(): string {
  return `merrymen_${randomBytes(4).toString("hex")}_bot`;
}
function botIdentity(value: unknown): ManagedBotIdentity | null {
  const u = value as { id?: unknown; is_bot?: unknown; username?: unknown } | null;
  if (!u || !Number.isSafeInteger(u.id) || Number(u.id) <= 0 || u.is_bot !== true ||
      typeof u.username !== "string" || !/^[A-Za-z0-9_]{5,32}$/.test(u.username) || !/bot$/i.test(u.username)) return null;
  return { id: String(u.id), username: u.username };
}
export class TelegramManager {
  constructor(readonly config: TelegramManagerConfig, private request: typeof fetch = fetch) {}
  private async call(token: string, method: string, body: Record<string, unknown> = {}, timeoutMs = 8_000): Promise<unknown> {
    if (!botIdOf(token)) throw new TelegramManagerError();
    try {
      const res = await this.request(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "error",
      });
      const data = await res.json() as { ok?: unknown; result?: unknown };
      if (!res.ok || data.ok !== true) throw new TelegramManagerError();
      return data.result;
    } catch { throw new TelegramManagerError(); }
  }
  async assertReady(timeoutMs?: number): Promise<void> {
    const result = await this.call(this.config.token, "getMe", {}, timeoutMs);
    const bot = botIdentity(result);
    if (!bot || bot.id !== botIdOf(this.config.token) ||
        bot.username.toLowerCase() !== this.config.username.toLowerCase() ||
        (result as { can_manage_bots?: unknown }).can_manage_bots !== true) throw new TelegramManagerError();
  }
  /**
   * Telegram reports the URL, never the secret: equal URLs are all this can
   * compare. And the update types it delivers, when they were set: none
   * reported counts as stale, since setWebhook here always names them.
   */
  async webhook(expected: string, timeoutMs?: number): Promise<ManagerWebhook> {
    const info = await this.call(this.config.token, "getWebhookInfo", {}, timeoutMs) as { url?: unknown; allowed_updates?: unknown } | null;
    if (!info || typeof info.url !== "string") throw new TelegramManagerError();
    if (info.url === "") return "unset";
    if (info.url !== expected) return "elsewhere";
    const allowed = Array.isArray(info.allowed_updates) ? info.allowed_updates : [];
    return MANAGER_ALLOWED_UPDATES.every(type => allowed.includes(type)) ? "ours" : "stale";
  }
  /** Deliveries to `url`, signed with this deployment's secret, of the update types the webhook reads. */
  async setWebhook(url: string, timeoutMs?: number): Promise<void> {
    const done = await this.call(this.config.token, "setWebhook", {
      url, secret_token: this.config.webhookSecret, allowed_updates: [...MANAGER_ALLOWED_UPDATES],
    }, timeoutMs);
    if (done !== true) throw new TelegramManagerError();
  }
  /**
   * The creation offer: Telegram's own request button, which makes the bot and
   * reports it to the webhook (managed_bot_created), which then sends `ready`.
   * THE SEAM FOR ANOTHER WAY TO MAKE THE BOT: a further row of this keyboard,
   * or a second message after this one, would go here. None is added yet.
   */
  async offerCreation(userId: number): Promise<void> {
    await this.call(this.config.token, "sendMessage", {
      chat_id: userId,
      text: "Create your Merrymen bot below. Telegram will ask you to approve its name. Then confirm here, or in Merrymen, which bot to connect.",
      reply_markup: { keyboard: [[{ text: "Create my Telegram bot", request_managed_bot: {
        request_id: 1, suggested_name: "My Merrymen", suggested_username: suggestedUsername(),
      } }]], resize_keyboard: true, one_time_keyboard: true },
    });
  }
  /** A private message from the manager. */
  async send(userId: number, notice: ManagerNotice, timeoutMs?: number): Promise<void> {
    await this.call(this.config.token, "sendMessage", { chat_id: userId, text: notice.text, ...markup(notice) }, timeoutMs);
  }
  /** The pressed message, rewritten to say what the press did. Its buttons become the notice's. */
  async edit(chatId: number, messageId: number, notice: ManagerNotice, timeoutMs?: number): Promise<void> {
    await this.call(this.config.token, "editMessageText", { chat_id: chatId, message_id: messageId, text: notice.text, ...markup(notice) }, timeoutMs);
  }
  /** Stops the pressed button's spinner; `text` shows briefly above the chat. */
  async answer(callbackQueryId: string, text?: string, timeoutMs?: number): Promise<void> {
    await this.call(this.config.token, "answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }, timeoutMs);
  }
  /** Reconfirm the manager's association with this bot and its live token. */
  async credentials(expected: ManagedBotIdentity): Promise<{ token: string; bot: ManagedBotIdentity }> {
    const token = await this.call(this.config.token, "getManagedBotToken", { user_id: Number(expected.id) });
    if (typeof token !== "string" || botIdOf(token) !== expected.id) throw new TelegramManagerError();
    const bot = botIdentity(await this.call(token, "getMe"));
    if (!bot || bot.id !== expected.id || bot.username.toLowerCase() !== expected.username.toLowerCase()) throw new TelegramManagerError();
    return { token, bot };
  }
}

/** Bound input size even when Content-Length is missing or dishonest. */
export async function boundedJson(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("Invalid request.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 16_384) { await reader.cancel(); throw new Error("Request too large."); }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { reader.releaseLock(); }
}
export { botIdentity as managedBotIdentity };
