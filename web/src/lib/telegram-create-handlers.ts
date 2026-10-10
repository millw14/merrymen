import { requestOrigin, tenantOf } from "./auth";
import { OWNER_CHANGED_SETTING, ownerMismatch } from "./order-owner";
import { SAVE_BUSY, withSettingsSaveLock } from "./telegram-claims";
import { botIdOf } from "../../../worker/src/telegram/state";
import { createHash } from "node:crypto";
import { makePgDb, withAdvisoryLock, type Db } from "../../../worker/src/db";
import { ensureManagedTelegramSchema, ManagedTelegramStore, ManagedTelegramError, MANAGED_MESSAGE_FRESHNESS_MS, type ManagedTelegramIntent } from "./telegram-managed-store";
import {
  boundedJson, managedBotIdentity, managerNotices, managerWebhookUrl, parsePress, TelegramManager, TelegramManagerError, validWebhookSecret,
  type ManagedBotIdentity, type ManagerNotice, type ManagerPress, type TelegramManagerConfig,
} from "./telegram-manager";

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
  /** This deployment's manager webhook URL, or null without an https public origin. Its origin is the manager's Back to Merrymen link. */
  webhookUrl(): string | null;
  /**
   * One line per change of readiness, and one per manager message or button
   * that failed. Fixed reasons only: never a token, secret, URL, challenge,
   * tenant or Telegram id.
   */
  log(line: string): void;
}
const defaults: Omit<Dependencies, "config"> = {
  auth: tenantOf,
  db: () => makePgDb(process.env.DATABASE_URL!),
  manager: config => new TelegramManager(config), saveLock: withSettingsSaveLock,
  webhookUrl: () => managerWebhookUrl(process.env.MERRYMEN_PUBLIC_ORIGIN),
  log: line => console.warn(`[telegram-create] ${line}`),
};

/** A passed probe is trusted this long; a failed one only briefly, so a fix shows within a minute. */
const READY_TTL_MS = 5 * 60_000;
const NOT_READY_TTL_MS = 30_000;
/** Each Bot API call a probe makes, and the longest a Settings visit waits on a probe. */
const PROBE_CALL_MS = 5_000;
const PROBE_WAIT_MS = 8_000;

/**
 * NEVER A BUTTON THAT FAILS. Availability used to mean only that the variables
 * were set: Settings offered Create Telegram bot while the manager's tables did
 * not exist, its Bot Management Mode was off or its webhook pointed nowhere,
 * and the owner found out after Telegram had made them a bot nothing would
 * ever hear about. Now the button shows only after this has passed: tables
 * made (ensureManagedTelegramSchema), getMe says the manager can manage bots,
 * and the manager's webhook is this deployment's URL.
 *
 * THE WEBHOOK, CONSERVATIVELY. Telegram's getWebhookInfo reports a URL, never
 * the secret. Empty: nobody has one, so this deployment sets its own, with its
 * secret and the update types the webhook reads, and reads it back (two
 * deployments racing for an unset manager: whoever's URL is there afterwards
 * won, and the other refuses). Already this deployment's URL: set again once
 * per process, because the secret cannot be read back and a URL set by hand,
 * or before the secret was rotated, would have every delivery refused (401)
 * with nothing here able to tell; re-setting our own URL to our own secret can
 * hurt nothing. Set again too, at any probe, when it is this URL but missing
 * an update type MANAGER_ALLOWED_UPDATES names ("stale"): the webhook set
 * before the Connect buttons existed delivered no callback_query, and a
 * replica still running that code during a deploy can set it back once more.
 * Any other URL: another environment's (staging and production sharing one
 * manager token, say), and overwriting it would silently break that one.
 * Refused, with one log line, and creation stays unavailable here.
 *
 * Per process, per configuration: a changed token, username, secret or origin
 * is probed afresh. One probe at a time, shared by every request waiting on
 * it; a Settings visit waits at most PROBE_WAIT_MS and is told unavailable if
 * Telegram is slower than that, while the probe finishes and is kept.
 */
function readiness(deps: Dependencies) {
  let memo: { key: string; until: number; result: Promise<boolean> } | null = null;
  let asserted: string | null = null;
  let said: string | null = null;
  const tell = (line: string | null) => {
    if (said === line) return;
    if (line !== null) deps.log(`one-click Telegram unavailable: ${line}`);
    else if (said !== null) deps.log("one-click Telegram available");
    said = line;
  };
  async function probe(config: TelegramManagerConfig, url: string | null, key: string): Promise<boolean> {
    if (!url) { tell("MERRYMEN_PUBLIC_ORIGIN is not an https origin, so the manager has no webhook URL"); return false; }
    try { await ensureManagedTelegramSchema(await deps.db()); }
    catch { tell("its tables could not be created or read"); return false; }
    const manager = deps.manager(config);
    try { await manager.assertReady(PROBE_CALL_MS); }
    catch { tell("the manager bot's getMe failed, or Bot Management Mode is off for it"); return false; }
    try {
      let webhook = await manager.webhook(url, PROBE_CALL_MS);
      if (webhook === "elsewhere") { tell("the manager bot's webhook points at another URL; it was left as it is"); return false; }
      if (webhook !== "ours" || asserted !== key) {
        await manager.setWebhook(url, PROBE_CALL_MS);
        webhook = await manager.webhook(url, PROBE_CALL_MS);
        // Our URL is what creation needs. Should the types read back short
        // all the same, the next probe sets them again; the buttons they
        // carry are a convenience the page in Merrymen also offers.
        if (webhook !== "ours" && webhook !== "stale") { tell("the manager bot's webhook changed while it was being set; it was left as it is"); return false; }
        asserted = key;
      }
    } catch { tell("the manager bot's webhook could not be read or set"); return false; }
    tell(null);
    return true;
  }
  return async function ready(config: TelegramManagerConfig): Promise<boolean> {
    const url = deps.webhookUrl();
    const key = createHash("sha256").update(JSON.stringify([config.token, config.username, config.webhookSecret, url])).digest("hex");
    if (!memo || memo.key !== key || memo.until <= Date.now()) {
      const entry = { key, until: Infinity, result: probe(config, url, key).catch(() => false) };
      memo = entry;
      void entry.result.then(ok => { entry.until = Date.now() + (ok ? READY_TTL_MS : NOT_READY_TTL_MS); });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([memo.result, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), PROBE_WAIT_MS); })]);
    } finally { clearTimeout(timer); }
  };
}
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
const busy = () => json({ error: "Another save is still going through. Please try again in a moment." }, 409);
/** Each Bot API call the manager makes to tell its user something: best effort, and bounded. */
const NOTICE_CALL_MS = 5_000;
/** A pressed button's answer, shown briefly above the chat. The edited message says the rest. */
const TOAST = {
  unavailable: "This button isn't available any more.",
  notYours: "This setup isn't available. Start again from Merrymen.",
  expired: "This setup expired.",
  notReady: "Finish creating your bot first.",
  alreadyConnected: "Already connected, so nothing was cancelled.",
  alreadyHasBot: "Your agent already has a bot.",
  claimed: "That bot is connected to another agent.",
  connectFailed: "Couldn't connect right now. Try again.",
  failed: "Couldn't do that right now. Try again.",
};
type Reply = { toast?: string; notice?: ManagerNotice };
/** What one completion did. "connected" is `fresh` when this call made the connection, not an earlier one. */
type Connection =
  | { outcome: "connected"; intent: ManagedTelegramIntent; fresh: boolean }
  | { outcome: "not_ready"; intent: ManagedTelegramIntent }
  | { outcome: "not_found" } | { outcome: "bot_changed" } | { outcome: "unavailable" } | { outcome: "busy" };

/** No secret-bearing errors or unscoped intent lookups leave these handlers. */
export function createTelegramHandlers(overrides: Pick<Dependencies, "config"> & Partial<Omit<Dependencies, "config">>) {
  const deps = { ...defaults, ...overrides };
  const ready = readiness(deps);
  /** Where Back to Merrymen goes: this deployment's public origin, which its webhook URL is built on. */
  const home = () => { const url = deps.webhookUrl(); return url ? new URL(url).origin : null; };

  /**
   * ONE COMPLETION, FROM MERRYMEN OR FROM TELEGRAM. The page's Connect and
   * the manager's Connect button both come here, so a bot is saved one way:
   * under the tenant's settings lock, the intent as it stands, then the bot's
   * live token (getManagedBotToken, and getMe for it), then complete()'s one
   * transaction (claim, sealed token, connected). Who may ask is settled by
   * the caller: the signed-in tenant, or the Telegram user whose /start bound
   * the intent. A connection already made answers as made, and asks Telegram
   * for nothing again, so a retry, a second tap or a redelivered press is safe.
   */
  async function connect(config: TelegramManagerConfig, tenant: `0x${string}`, intentId: string, botId: string | null): Promise<Connection> {
    const managerBotId = botIdOf(config.token)!;
    const result = await deps.saveLock(tenant, async (claims): Promise<Connection> => {
      if (!claims.db) return { outcome: "unavailable" };
      const store = new ManagedTelegramStore(claims.db);
      const scope = { tenant, intentId, managerBotId };
      const intent = await store.get(scope);
      if (!intent) return { outcome: "not_found" };
      if (!botId || botId !== intent.botId) return { outcome: "bot_changed" };
      if (intent.status === "connected") return { outcome: "connected", intent, fresh: false };
      if (intent.status !== "confirm" || !intent.botId || !intent.botUsername) return { outcome: "not_ready", intent };
      const { token, bot } = await deps.manager(config).credentials({ id: intent.botId, username: intent.botUsername });
      const connected = await store.complete({ ...scope, botId: bot.id, token, confirmedBotId: bot.id });
      return { outcome: "connected", intent: connected, fresh: true };
    }, 3_000);
    return result === SAVE_BUSY ? { outcome: "busy" } : result;
  }

  /** A manager message nothing else depends on: a failure is logged, never retried by failing the delivery. */
  async function tell(config: TelegramManagerConfig, userId: number, notice: () => ManagerNotice, what: string): Promise<void> {
    try { await deps.manager(config).send(userId, notice(), NOTICE_CALL_MS); }
    catch { deps.log(`the manager's ${what} message could not be sent`); }
  }

  /**
   * CONNECTED ON THE WEB, SAID IN TELEGRAM TOO, where the owner was last
   * asked to choose: one message to the user the intent bound, sent only by
   * the confirmation that made the connection. The connection stands whatever
   * happens here.
   */
  async function tellConnected(config: TelegramManagerConfig, scope: { tenant: string; intentId: string; managerBotId: string }, username: string): Promise<void> {
    let user: number | null;
    try { user = await new ManagedTelegramStore(await deps.db()).boundTelegramUser(scope); }
    catch { deps.log("the manager's Connected message could not be sent"); return; }
    if (user !== null) await tell(config, user, () => managerNotices.connected(username, home()), "Connected");
  }

  /** What an intent that can no longer be connected says, when a button finds it so. */
  function ended(intent: ManagedTelegramIntent, username: string, action: ManagerPress["action"]): Reply {
    if (intent.status === "connected") return { toast: action === "cancel" ? TOAST.alreadyConnected : undefined, notice: managerNotices.connected(username, home()) };
    if (intent.status === "cancelled") return { notice: managerNotices.cancelled(username, home()) };
    if (intent.status === "expired") return { toast: TOAST.expired, notice: managerNotices.expired(home()) };
    return { toast: TOAST.notReady };
  }

  /** A Connect press the store, Telegram or the settings lock refused. Expected refusals say why; anything else keeps the buttons to try again. */
  function refused(error: unknown, bot: ManagedBotIdentity, intentId: string): Reply {
    if (error instanceof ManagedTelegramError) {
      if (error.code === "intent_expired") return { toast: TOAST.expired, notice: managerNotices.expired(home()) };
      if (error.code === "bot_already_configured") return { toast: TOAST.alreadyHasBot, notice: managerNotices.alreadyHasBot(bot.username, home()) };
      if (error.code === "bot_claimed") return { toast: TOAST.claimed, notice: managerNotices.claimed(bot.username, home()) };
      if (error.code === "candidate_mismatch" || error.code === "intent_not_found") return { toast: TOAST.notYours };
    }
    // A store code is one of its own fixed strings; nothing else about the error is logged.
    const reason = error === "busy" || error === "unavailable" ? error : error instanceof ManagedTelegramError ? error.code : error instanceof TelegramManagerError ? "Bot API" : "error";
    deps.log(`a Connect button in Telegram failed (${reason})`);
    return { toast: TOAST.connectFailed, notice: managerNotices.failed(bot, intentId) };
  }

  /**
   * A PRESSED BUTTON, FROM THE TELEGRAM USER WHO STARTED THIS SETUP.
   *
   * Milla's call: connecting from Telegram is allowed, on the authority the
   * /start challenge already gave. The challenge came from the signed-in
   * owner's own Merrymen page and bound exactly one private Telegram user to
   * this intent (bind); that user, and only that user, may now choose the
   * candidate the creation message proposed. So a press counts only when it
   * comes from a human (not a bot), in that user's private chat with the
   * manager, naming an intent of this manager bound to that same user, and
   * the bot that intent holds. Anything else is answered, and changes nothing.
   *
   * The button carries no authority of its own (pressData): its intent id is
   * looked up only through the presser's Telegram id, and the tenant found
   * that way never leaves this server. Completion is connect(), the web's
   * own. Telegram redelivers a press it was not answered for, and a second
   * tap sends another: both are safe, since a connected or cancelled intent
   * answers as it stands and the message is edited to the same words.
   */
  async function decide(config: TelegramManagerConfig, user: number, pressed: ManagerPress): Promise<Reply> {
    const scope = { intentId: pressed.intentId, managerBotId: botIdOf(config.token)!, telegramUserId: user };
    const found = await new ManagedTelegramStore(await deps.db()).forTelegramUser(scope);
    if (!found || !found.intent.botUsername || found.intent.botId !== pressed.botId) return { toast: TOAST.notYours };
    const bot = { id: pressed.botId, username: found.intent.botUsername };
    if (pressed.action === "cancel") {
      // The web cancel's lock: a cancel never lands in the middle of a completion.
      const result = await deps.saveLock(found.tenant, async claims => claims.db ? await new ManagedTelegramStore(claims.db).cancelForTelegramUser(scope) : undefined, 3_000);
      if (result === SAVE_BUSY || result === undefined) return { toast: TOAST.failed };
      return result ? ended(result, bot.username, "cancel") : { toast: TOAST.notYours };
    }
    let connection: Connection;
    try { connection = await connect(config, found.tenant, pressed.intentId, pressed.botId); }
    catch (error) { return refused(error, bot, pressed.intentId); }
    if (connection.outcome === "connected") return { notice: managerNotices.connected(bot.username, home()) };
    if (connection.outcome === "not_ready") return ended(connection.intent, bot.username, "connect");
    if (connection.outcome === "not_found" || connection.outcome === "bot_changed") return { toast: TOAST.notYours };
    return refused(connection.outcome, bot, pressed.intentId);
  }

  /** Every press is answered, so its spinner stops; only a valid one edits its message. */
  async function press(config: TelegramManagerConfig, value: unknown): Promise<void> {
    const query = value as { id?: unknown; data?: unknown; from?: { id?: unknown; is_bot?: unknown };
      message?: { message_id?: unknown; chat?: { id?: unknown; type?: unknown } } } | null;
    if (!query || typeof query.id !== "string" || !query.id || query.id.length > 128) return;
    const user = Number(query.from?.id), messageId = Number(query.message?.message_id);
    const pressed = parsePress(query.data);
    const valid = Number.isSafeInteger(query.from?.id) && user > 0 && query.from?.is_bot === false && query.message?.chat?.type === "private" &&
      query.message.chat.id === user && Number.isSafeInteger(query.message.message_id) && messageId > 0 && pressed !== null;
    let reply: Reply;
    try { reply = valid ? await decide(config, user, pressed!) : { toast: TOAST.unavailable }; }
    catch { deps.log("a manager button press could not be checked"); reply = { toast: TOAST.failed }; }
    const manager = deps.manager(config);
    await manager.answer(query.id, reply.toast, NOTICE_CALL_MS).catch(() => {});
    if (valid && reply.notice) await manager.edit(user, messageId, reply.notice, NOTICE_CALL_MS).catch(() => {});
  }

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
        if (!intentId) return json({ available: await ready(config) });
        if (!idPattern.test(intentId)) return json({ error: "Invalid setup request." }, 400);
        // A setup already underway is read whether or not a new one could
        // start: its candidate can still be confirmed, and a connected one
        // must be seen as connected, without the webhook.
        const intent = await new ManagedTelegramStore(await deps.db()).get({ tenant, intentId, managerBotId: botIdOf(config.token)! });
        if (!intent) return json({ error: "This setup request isn't available. Start again." }, 404);
        return json({ available: await ready(config), intent });
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
        // Only a new setup needs the webhook; confirm and cancel finish one.
        // Probed before the settings lock, so a slow Telegram never holds it.
        if (body.action === "begin" && !(await ready(config))) return unavailable();
        const scope = { tenant, intentId: String(body.intentId), managerBotId };
        if (body.action === "confirm") {
          const connection = await connect(config, tenant, scope.intentId, typeof body.botId === "string" ? body.botId : null);
          if (connection.outcome === "busy") return busy();
          if (connection.outcome === "unavailable") return unavailable();
          if (connection.outcome === "not_found") return json({ error: "Setup request not found." }, 404);
          if (connection.outcome === "bot_changed") return json({ error: "The bot changed. Check its name and confirm again." }, 409);
          if (connection.outcome === "not_ready") return json({ error: "Finish creating your bot in Telegram first, or start again if this request expired." }, 409);
          if (connection.fresh && connection.intent.botUsername) await tellConnected(config, scope, connection.intent.botUsername);
          return json({ intent: connection.intent });
        }
        const result = await deps.saveLock(tenant, async claims => {
          if (!claims.db) return unavailable();
          const store = new ManagedTelegramStore(claims.db);
          if (body.action === "cancel") {
            const intent = await store.cancel(scope);
            return intent ? json({ intent }) : json({ error: "Setup request not found." }, 404);
          }
          const { intent, challenge } = await store.begin({ tenant, managerBotId });
          return json({ intent, telegramUrl: `https://t.me/${config.username}?start=${encodeURIComponent(challenge)}` });
        }, 3_000);
        if (result === SAVE_BUSY) return busy();
        return result;
      } catch (error) { return failure(error); }
    },
    async webhook(req: Request): Promise<Response> {
      const config = deps.config();
      if (!config) return json({ error: "Bot creation is unavailable." }, 503);
      if (!validWebhookSecret(req.headers.get("x-telegram-bot-api-secret-token"), config.webhookSecret)) return json({ error: "Unauthorized." }, 401);
      let raw: unknown;
      try { raw = await boundedJson(req); } catch { return json({ error: "Invalid update." }, 400); }
      const update = raw as { update_id?: unknown; callback_query?: unknown; message?: {
        date?: unknown; from?: { id?: unknown; is_bot?: unknown }; chat?: { id?: unknown; type?: unknown };
        text?: unknown; managed_bot_created?: { bot?: unknown };
      } } | null;
      if (!update || !Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0) return json({ error: "Invalid update." }, 400);
      // A press is answered whatever it finds, and never asks for redelivery:
      // its presser has been told, and can press again.
      if (update.callback_query !== undefined) { await press(config, update.callback_query); return json({ ok: true }); }
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
            // THE NEXT STEP, IN TELEGRAM. A bot made for a setup underway is
            // offered at once (Connect, or Not this bot), so nobody is left in
            // the chat with nothing said; one made with no setup underway is
            // answered with why nothing happened. Each is said once: both
            // outcomes come only from the update's first delivery, and a send
            // that fails is not retried, since Merrymen's page still offers it.
            const result = await store.candidate({ kind: "managed_bot_created", managerBotId, updateId: Number(update.update_id), telegramUserId: userId, botId: bot.id, username: bot.username, messageDate: date, now });
            if (result.outcome === "candidate") await tell(config, userId, () => managerNotices.ready(bot, result.intentId), "Connect");
            else if (result.outcome === "unmatched") await tell(config, userId, () => managerNotices.unmatched(bot.username, home()), "setup expired");
          }
          return json({ ok: true });
        }, 10_000);
      } catch { return json({ error: "Please retry delivery." }, 503); }
    },
  };
}
