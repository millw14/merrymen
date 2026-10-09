import { requestOrigin, tenantOf } from "./auth";
import { OWNER_CHANGED_SETTING, ownerMismatch } from "./order-owner";
import { SAVE_BUSY, withSettingsSaveLock } from "./telegram-claims";
import { botIdOf } from "../../../worker/src/telegram/state";
import { makePgDb, withAdvisoryLock, type Db } from "../../../worker/src/db";
import { ManagedTelegramStore, ManagedTelegramError, MANAGED_MESSAGE_FRESHNESS_MS } from "./telegram-managed-store";
import { boundedJson, managedBotIdentity, TelegramManager, TelegramManagerError, validWebhookSecret, type TelegramManagerConfig } from "./telegram-manager";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const unavailable = () => json({ available: false, error: "Bot creation is not available right now. You can still connect an existing bot." }, 503);
const tenantPattern = /^0x[0-9a-f]{40}$/i;
const idPattern = /^[A-Za-z0-9_-]{16,64}$/;
/** Serialize manager delivery, including a retried creation prompt. Separate from settings saves. */
const MANAGER_DELIVERY_LOCK = 1_297_692_148;
function webOrigin(req: Request): string {
  if (process.env.MERRYMEN_PUBLIC_ORIGIN) return requestOrigin(req);
  const url = new URL(req.url);
  // Next normalizes a loopback URL to localhost; Host preserves the browser's
  // actual origin, as the API middleware does. Hosted can use its configured origin.
  const host = req.headers.get("host");
  if (host) url.host = host;
  return url.origin;
}
interface Dependencies {
  config(): TelegramManagerConfig | null;
  auth(req: Request): `0x${string}` | null;
  db(): Promise<Db>;
  manager(config: TelegramManagerConfig): TelegramManager;
  saveLock: typeof withSettingsSaveLock;
}
const defaults: Omit<Dependencies, "config"> = {
  auth: tenantOf,
  db: () => makePgDb(process.env.DATABASE_URL!),
  manager: config => new TelegramManager(config), saveLock: withSettingsSaveLock,
};
function failure(error: unknown): Response {
  if (error instanceof ManagedTelegramError) {
    const messages: Record<string, string> = {
      bot_already_configured: "A bot is already connected. Open it below, or disconnect it before creating a new one.",
      bot_claimed: "This bot is already connected to another Merrymen agent. Its connection was not changed.",
      bot_unconfirmed: "Telegram couldn't confirm your bot. Please try again.",
      intent_expired: "This setup request expired. Start again when you're ready.",
      candidate_mismatch: "Check the bot name and confirm again.",
      intent_not_found: "Setup request not found. Start again.",
      settings_changed: "Your settings changed during setup. Check them and try again.",
    };
    return json({ error: messages[error.code] ?? "Couldn't complete bot setup just now. Please try again." }, error.status);
  }
  if (error instanceof TelegramManagerError) return json({ error: error.message }, 502);
  return json({ error: "Couldn't complete bot setup just now. Please try again." }, 503);
}
/** No secret-bearing errors or unscoped intent lookups leave these handlers. */
export function createTelegramHandlers(overrides: Pick<Dependencies, "config"> & Partial<Omit<Dependencies, "config">>) {
  const deps = { ...defaults, ...overrides };
  return {
    async GET(req: Request): Promise<Response> {
      try {
        const tenant = deps.auth(req);
        if (!tenant || !tenantPattern.test(tenant)) return json({ error: "Sign in to create your Telegram bot." }, 401);
        const url = new URL(req.url);
        if (!url.searchParams.has("owner") || ownerMismatch(url.searchParams.get("owner"), tenant)) return json({ error: OWNER_CHANGED_SETTING }, 409);
        const config = deps.config();
        if (!config) return json({ available: false });
        const intentId = url.searchParams.get("intent");
        if (!intentId) return json({ available: true });
        if (!idPattern.test(intentId)) return json({ error: "Invalid setup request." }, 400);
        const intent = await new ManagedTelegramStore(await deps.db()).get({ tenant, intentId, managerBotId: botIdOf(config.token)! });
        if (!intent) return json({ error: "This setup request isn't available. Start again." }, 404);
        return json({ available: true, intent });
      } catch (error) { return failure(error); }
    },
    async POST(req: Request): Promise<Response> {
      try {
        const tenant = deps.auth(req);
        if (!tenant || !tenantPattern.test(tenant)) return json({ error: "Sign in to create your Telegram bot." }, 401);
        if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Invalid setup request." }, 415);
        const origin = req.headers.get("origin");
        const site = req.headers.get("sec-fetch-site");
        if ((origin && origin !== webOrigin(req)) || (site && site !== "same-origin" && site !== "none")) return json({ error: "Open bot setup from Merrymen." }, 403);
        let value: unknown;
        try { value = await boundedJson(req); } catch { return json({ error: "Invalid setup request." }, 400); }
        const body = value as { owner?: unknown; action?: unknown; intentId?: unknown; botId?: unknown } | null;
        if (!body || typeof body !== "object" || typeof body.owner !== "string" || ownerMismatch(body.owner, tenant)) return json({ error: OWNER_CHANGED_SETTING }, 409);
        if (!["begin", "confirm", "cancel"].includes(String(body.action))) return json({ error: "Invalid setup action." }, 400);
        const config = deps.config();
        if (!config) return unavailable();
        const managerBotId = botIdOf(config.token)!;
        if (body.action !== "begin" && (typeof body.intentId !== "string" || !idPattern.test(body.intentId))) return json({ error: "Invalid setup request." }, 400);
        const result = await deps.saveLock(tenant, async claims => {
          if (!claims.db) return unavailable();
          const store = new ManagedTelegramStore(claims.db);
          const scope = { tenant, intentId: String(body.intentId), managerBotId };
          if (body.action === "cancel") {
            const intent = await store.cancel(scope);
            return intent ? json({ intent }) : json({ error: "Setup request not found." }, 404);
          }
          const manager = deps.manager(config);
          if (body.action === "begin") {
            await manager.assertReady();
            const { intent, challenge } = await store.begin({ tenant, managerBotId });
            return json({ intent, telegramUrl: `https://t.me/${config.username}?start=${encodeURIComponent(challenge)}` });
          }
          const intent = await store.get(scope);
          if (!intent) return json({ error: "Setup request not found." }, 404);
          if (typeof body.botId !== "string" || body.botId !== intent.botId) return json({ error: "The bot changed. Check its name and confirm again." }, 409);
          if (intent.status === "connected") return json({ intent });
          if (intent.status !== "confirm" || !intent.botId || !intent.botUsername) return json({ error: "Finish creating your bot in Telegram first, or start again if this request expired." }, 409);
          const { token, bot } = await manager.credentials({ id: intent.botId, username: intent.botUsername });
          const connected = await store.complete({ ...scope, botId: bot.id, token, confirmedBotId: bot.id });
          return json({ intent: connected });
        }, 3_000);
        if (result === SAVE_BUSY) return json({ error: "Another save is still going through. Please try again in a moment." }, 409);
        return result;
      } catch (error) { return failure(error); }
    },
    async webhook(req: Request): Promise<Response> {
      const config = deps.config();
      if (!config) return json({ error: "Bot creation is unavailable." }, 503);
      if (!validWebhookSecret(req.headers.get("x-telegram-bot-api-secret-token"), config.webhookSecret)) return json({ error: "Unauthorized." }, 401);
      let raw: unknown;
      try { raw = await boundedJson(req); } catch { return json({ error: "Invalid update." }, 400); }
      const update = raw as { update_id?: unknown; message?: {
        date?: unknown; from?: { id?: unknown; is_bot?: unknown }; chat?: { id?: unknown; type?: unknown };
        text?: unknown; managed_bot_created?: { bot?: unknown };
      } } | null;
      if (!update || !Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0) return json({ error: "Invalid update." }, 400);
      const message = update.message;
      // Generic managed_bot updates include token rotations and owner changes;
      // they are never proof that this web request created a bot.
      if (!message || message.chat?.type !== "private" || !Number.isSafeInteger(message.from?.id) ||
          Number(message.from?.id) <= 0 || message.from?.is_bot !== false || message.chat.id !== message.from.id ||
          !Number.isSafeInteger(message.date)) return json({ ok: true });
      const date = Number(message.date);
      const now = Date.now();
      if (date * 1000 > now + 30_000 || date * 1000 < now - MANAGED_MESSAGE_FRESHNESS_MS) return json({ ok: true });
      const userId = Number(message.from.id);
      const managerBotId = botIdOf(config.token)!;
      const challenge = typeof message.text === "string" ? /^\/start(?:@[A-Za-z0-9_]+)? (mm_[A-Za-z0-9_-]{43})$/.exec(message.text)?.[1] : undefined;
      const bot = managedBotIdentity(message.managed_bot_created?.bot);
      if ((!challenge && !bot) || bot?.id === managerBotId) return json({ ok: true });
      try {
        return await withAdvisoryLock(await deps.db(), MANAGER_DELIVERY_LOCK, Number(managerBotId) % 2_147_483_647, async db => {
          const store = new ManagedTelegramStore(db);
          if (challenge) {
            const result = await store.bind({ managerBotId, updateId: Number(update.update_id), challenge, telegramUserId: userId, messageDate: date, now });
            if (result.outcome !== "ignored") await deps.manager(config).offerCreation(userId);
          } else if (bot) {
            await store.candidate({ kind: "managed_bot_created", managerBotId, updateId: Number(update.update_id), telegramUserId: userId, botId: bot.id, username: bot.username, messageDate: date, now });
          }
          return json({ ok: true });
        }, 10_000);
      } catch { return json({ error: "Please retry delivery." }, 503); }
    },
  };
}
