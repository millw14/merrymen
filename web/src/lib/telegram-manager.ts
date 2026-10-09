/** Server-only Bot API transport. Tokens never appear in a response or a log. */
import { timingSafeEqual } from "node:crypto";
import { botIdOf } from "../../../worker/src/telegram/state";

export interface TelegramManagerConfig { token: string; username: string; webhookSecret: string }
export function validWebhookSecret(received: string | null, expected: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class TelegramManagerError extends Error {
  constructor() { super("Telegram could not complete this step. Please try again."); }
}
export interface ManagedBotIdentity { id: string; username: string }
function botIdentity(value: unknown): ManagedBotIdentity | null {
  const u = value as { id?: unknown; is_bot?: unknown; username?: unknown } | null;
  if (!u || !Number.isSafeInteger(u.id) || Number(u.id) <= 0 || u.is_bot !== true ||
      typeof u.username !== "string" || !/^[A-Za-z0-9_]{5,32}$/.test(u.username) || !/bot$/i.test(u.username)) return null;
  return { id: String(u.id), username: u.username };
}
export class TelegramManager {
  constructor(readonly config: TelegramManagerConfig, private request: typeof fetch = fetch) {}
  private async call(token: string, method: string, body: Record<string, unknown> = {}): Promise<unknown> {
    if (!botIdOf(token)) throw new TelegramManagerError();
    try {
      const res = await this.request(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8_000), redirect: "error",
      });
      const data = await res.json() as { ok?: unknown; result?: unknown };
      if (!res.ok || data.ok !== true) throw new TelegramManagerError();
      return data.result;
    } catch { throw new TelegramManagerError(); }
  }
  async assertReady(): Promise<void> {
    const result = await this.call(this.config.token, "getMe");
    const bot = botIdentity(result);
    if (!bot || bot.id !== botIdOf(this.config.token) ||
        bot.username.toLowerCase() !== this.config.username.toLowerCase() ||
        (result as { can_manage_bots?: unknown }).can_manage_bots !== true) throw new TelegramManagerError();
  }
  async offerCreation(userId: number): Promise<void> {
    await this.call(this.config.token, "sendMessage", {
      chat_id: userId,
      text: "Create your Merrymen bot below. Telegram will ask you to approve its name. Then return to Merrymen to confirm which bot to connect.",
      reply_markup: { keyboard: [[{ text: "Create my Telegram bot", request_managed_bot: {
        request_id: 1, suggested_name: "My Merrymen", suggested_username: `merrymen_${userId}_bot`,
      } }]], resize_keyboard: true, one_time_keyboard: true },
    });
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
