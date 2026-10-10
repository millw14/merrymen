/**
 * A web intent is the authority to choose a newly created managed bot. Telegram
 * creation notifications carry no web state, so they can only propose a bot to
 * a fresh, privately bound intent. A confirmation saves it: the signed-in web
 * owner's, or the manager's Connect button pressed by the Telegram user the
 * intent's /start challenge bound (forTelegramUser), and nobody else's.
 *
 * No network calls, token retrieval or bot moves live here. The caller
 * authenticates Telegram deliveries and holds withSettingsSaveLock when
 * completing. All writes then share one Db transaction, including the claim
 * and encrypted settings. Only the token and enabled flag change: connecting
 * the owner's chat remains the existing worker's /start /link flow.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rootDb, type Db } from "../../../worker/src/db";
import { botIdOf, claimBot, ensureBotClaims } from "../../../worker/src/telegram-claims";
import { openSecret, requireDek, sealSecret } from "../../../worker/src/store-crypto";

/**
 * THIRTY MINUTES FROM "Set up Telegram" TO A BOT. Ten was too short: an owner
 * who began at 03:09 made their bot at 03:24, after the intent had expired,
 * and the creation was ignored with nothing said. Naming a bot, and finding
 * the way back from Telegram on a phone, takes longer than ten minutes often
 * enough. The window still ends: an old challenge cannot bind, and an old
 * candidate cannot be saved.
 */
export const MANAGED_INTENT_TTL_MS = 30 * 60_000;
export const MANAGED_MESSAGE_FRESHNESS_MS = 2 * 60_000;
const ACTIVE = "('waiting_telegram', 'waiting_bot', 'confirm')";

/**
 * THE SCHEMA, MADE BY THE STORE AT FIRST USE (ensureManagedTelegramSchema).
 *
 * #284 shipped this behind a hand-applied migration, and runtime DDL was
 * banned in its comments, docs and tests. Other stores here create their own
 * tables at first use (lib/partner-store.ts, for one), and the cost of the ban
 * was a feature that could not be switched on without an operator opening a
 * production shell (railway ssh, psql, the SQL file) on a live service. The
 * owner's call on 2026-10-10 was that
 * one-click Telegram must work with nothing but the manager bot, its variables
 * and a deploy, so the store makes these three tables itself. They hold
 * onboarding state only: no trading record, wallet or existing link is in them.
 *
 * Written once in the sqlite spelling, as everywhere in this repo: PgDb.exec
 * (translateSchema) turns every INTEGER into BIGINT, which is what the
 * millisecond clocks need. docs/migrations/2026-10-05-telegram-managed.sql
 * stays as the reviewed Postgres spelling of the same schema, and a test holds
 * the two equal.
 */
export const TELEGRAM_MANAGED_DDL = `
  CREATE TABLE IF NOT EXISTS telegram_managed_intents (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    manager_bot_id TEXT NOT NULL,
    challenge_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN
      ('waiting_telegram', 'waiting_bot', 'confirm', 'connected', 'expired', 'cancelled')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    telegram_user_id TEXT,
    bound_at INTEGER,
    bound_message_date INTEGER,
    bound_update_id INTEGER,
    bot_id TEXT,
    bot_username TEXT,
    completed_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS telegram_managed_active_tenant
    ON telegram_managed_intents (tenant) WHERE status IN ${ACTIVE};
  CREATE UNIQUE INDEX IF NOT EXISTS telegram_managed_active_user
    ON telegram_managed_intents (telegram_user_id)
    WHERE telegram_user_id IS NOT NULL AND status IN ${ACTIVE};
  CREATE TABLE IF NOT EXISTS telegram_managed_users (
    telegram_user_id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS telegram_managed_users_intent ON telegram_managed_users (intent_id);
  CREATE TABLE IF NOT EXISTS telegram_managed_updates (
    manager_bot_id TEXT NOT NULL,
    update_id INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    outcome TEXT NOT NULL,
    intent_id TEXT,
    PRIMARY KEY (manager_bot_id, update_id)
  );
`;

/**
 * The schema lock's key. Distinct from every single-key advisory lock in the
 * repo (tg-groups-ferry.ts and fomo/store.ts list them) and from the
 * manager's delivery lock beside it (1_297_692_148): a shared key would only
 * make unrelated first uses queue behind each other, but there is no reason to.
 */
export const MANAGED_SCHEMA_LOCK = 1_297_692_149;
const schemaReady = new WeakMap<Db, Promise<void>>();

/** Under SQLite there is one process and one connection: nothing to lock against. */
async function lockSchema(tx: Db): Promise<void> {
  try { await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(MANAGED_SCHEMA_LOCK); }
  catch (e) { if (!/no such function: pg_advisory_xact_lock/i.test(String((e as Error)?.message ?? ""))) throw e; }
}

/**
 * CREATE THE TABLES ONCE PER DATABASE, SAFE AGAINST EVERY OTHER WEB REPLICA
 * DOING IT AT THE SAME MOMENT.
 *
 * After the deploy that brings this, every web replica's first Settings visit
 * asks for these tables at once, and Postgres's IF NOT EXISTS is not atomic
 * against that: the loser can fail on the catalog's own unique index (23505),
 * see a table appear mid-statement (42P07) or find its row type already made
 * (42710). So the DDL runs in a transaction holding an advisory lock, which
 * serializes the replicas, and those three codes are still answered by running
 * it again: an operator applying the documented SQL by hand takes no lock, and
 * once the other creator has finished, the second run finds everything there.
 *
 * Memoised on the database (rootDb), not on the connection a settings lock
 * pinned from it, and forgotten on any failure so the next request tries
 * again. The bot-claims table complete() writes to is made here too
 * (ensureBotClaims); web settings saves and the orchestrator already make it,
 * but a database where neither has yet must not fail a confirmation for it.
 */
export function ensureManagedTelegramSchema(db: Db): Promise<void> {
  const root = rootDb(db);
  const existing = schemaReady.get(root);
  if (existing) return existing;
  const started = (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await db.tx(async (tx) => {
          await lockSchema(tx);
          await tx.exec(TELEGRAM_MANAGED_DDL);
        });
        break;
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        if (attempt < 3 && (code === "23505" || code === "42P07" || code === "42710")) continue;
        throw e;
      }
    }
    await ensureBotClaims(db);
  })().catch((error: unknown) => {
    if (schemaReady.get(root) === started) schemaReady.delete(root);
    throw error;
  });
  schemaReady.set(root, started);
  return started;
}

export type ManagedTelegramStatus =
  | "waiting_telegram" | "waiting_bot" | "confirm" | "connected" | "expired" | "cancelled";

/** Safe for this intent's authenticated tenant. No challenge, user ID or token. */
export interface ManagedTelegramIntent {
  id: string;
  status: ManagedTelegramStatus;
  expiresAt: number;
  botId: string | null;
  botUsername: string | null;
}

export class ManagedTelegramError extends Error {
  constructor(public readonly code: string, public readonly status: number = 409) {
    super(code);
    this.name = "ManagedTelegramError";
  }
}

type IntentRow = {
  id: string; tenant: string; manager_bot_id: string; challenge_hash: string;
  status: ManagedTelegramStatus; created_at: number; expires_at: number;
  telegram_user_id: string | null; bound_at: number | null;
  bound_message_date: number | null; bound_update_id: number | null;
  bot_id: string | null; bot_username: string | null; completed_at: number | null;
};
type Scope = { tenant: string; intentId: string; managerBotId: string; now?: number };
type TelegramUserScope = { intentId: string; managerBotId: string; telegramUserId: number; now?: number };
type UpdateScope = { managerBotId: string; updateId: number; telegramUserId: number; now?: number };
/**
 * "unmatched": a fresh creation message for which this Telegram user had no
 * setup underway (expired, cancelled, connected or never begun). Recorded so
 * a redelivery of that update is told apart from it, and the manager's one
 * "this setup had expired" reply is never sent twice.
 */
type UpdateOutcome = "bound" | "candidate" | "unmatched" | "ignored";
type Receipt = { payload_hash: string; outcome: UpdateOutcome; intent_id: string | null };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const intentIdOk = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id);
const active = (row: IntentRow, now: number) =>
  (row.status === "waiting_telegram" || row.status === "waiting_bot" || row.status === "confirm") && Number(row.expires_at) > now;

function tenantKey(tenant: string): string {
  if (typeof tenant !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(tenant)) throw new ManagedTelegramError("invalid_tenant", 400);
  return tenant.toLowerCase();
}
function numericId(value: string | number): string {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new ManagedTelegramError("invalid_telegram_id", 400);
  return text;
}
function clock(value?: number): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + MANAGED_INTENT_TTL_MS)) throw new ManagedTelegramError("invalid_time", 400);
  return now;
}
function updateId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ManagedTelegramError("invalid_update", 400);
  return value;
}
function messageDate(value: number, now: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || Math.abs(value * 1000 - now) > MANAGED_MESSAGE_FRESHNESS_MS) {
    throw new ManagedTelegramError("stale_message", 400);
  }
  return value;
}
function publicIntent(row: IntentRow, now: number): ManagedTelegramIntent {
  return {
    id: row.id,
    status: !active(row, now) && (row.status === "waiting_telegram" || row.status === "waiting_bot" || row.status === "confirm") ? "expired" : row.status,
    expiresAt: Number(row.expires_at), botId: row.bot_id ?? null, botUsername: row.bot_username ?? null,
  };
}

async function readIntent(db: Db, tenant: string, id: string, manager: string): Promise<IntentRow | undefined> {
  return await db.prepare("SELECT * FROM telegram_managed_intents WHERE tenant = ? AND id = ? AND manager_bot_id = ?")
    .get(tenant, id, manager) as IntentRow | undefined;
}
/** Only through the Telegram user its /start bound: a button names an id, and an id alone is no authority. */
async function readUserIntent(db: Db, id: string, manager: string, user: string): Promise<IntentRow | undefined> {
  return await db.prepare("SELECT * FROM telegram_managed_intents WHERE id = ? AND manager_bot_id = ? AND telegram_user_id = ?")
    .get(id, manager, user) as IntentRow | undefined;
}
/** Cancel a setup still underway and free its user's lease. Ended ones are left as they are: a connection is never undone here. */
async function cancelRow(db: Db, row: IntentRow, now: number): Promise<void> {
  if (!active(row, now)) return;
  const changed = await db.prepare(`UPDATE telegram_managed_intents SET status = 'cancelled' WHERE id = ? AND tenant = ? AND status IN ${ACTIVE}`)
    .run(row.id, row.tenant);
  if (changed.changes === 1) await db.prepare("DELETE FROM telegram_managed_users WHERE intent_id = ?").run(row.id);
}

/** Read raw settings, without defaults or field filtering: unknown fields survive. */
async function readSettings(db: Db, tenant: string, dek: Buffer): Promise<{ sealed: string | null; value: Record<string, unknown> }> {
  const row = await db.prepare("SELECT sealed FROM tenant_settings WHERE tenant = ?").get(tenant) as { sealed: string } | undefined;
  if (!row) return { sealed: null, value: {} };
  if (typeof row.sealed !== "string") throw new ManagedTelegramError("settings_unreadable", 503);
  try {
    // Legacy settings can be plaintext; every new write below is encrypted.
    const json = row.sealed.startsWith("{") ? row.sealed : openSecret(row.sealed, dek);
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not settings");
    return { sealed: row.sealed, value: value as Record<string, unknown> };
  } catch {
    throw new ManagedTelegramError("settings_unreadable", 503);
  }
}

function refuseExistingBot(settings: Record<string, unknown>): void {
  const token = settings.telegramBotToken;
  if (token !== undefined && token !== null && token !== "") throw new ManagedTelegramError("bot_already_configured");
}

/** Claim an update before changing state. Replays never change its first outcome. */
async function receive(db: Db, manager: string, id: number, payload: unknown): Promise<{ fresh: boolean; receipt: Receipt }> {
  const fingerprint = hash(JSON.stringify(payload));
  const inserted = await db.prepare(`INSERT INTO telegram_managed_updates
    (manager_bot_id, update_id, payload_hash, outcome) VALUES (?, ?, ?, 'ignored')
    ON CONFLICT(manager_bot_id, update_id) DO NOTHING`).run(manager, id, fingerprint);
  const receipt = await db.prepare("SELECT payload_hash, outcome, intent_id FROM telegram_managed_updates WHERE manager_bot_id = ? AND update_id = ?")
    .get(manager, id) as Receipt | undefined;
  if (!receipt || receipt.payload_hash !== fingerprint) throw new ManagedTelegramError("update_conflict");
  return { fresh: inserted.changes === 1, receipt };
}
async function record(db: Db, manager: string, id: number, outcome: UpdateOutcome, intentId: string | null): Promise<void> {
  await db.prepare("UPDATE telegram_managed_updates SET outcome = ?, intent_id = ? WHERE manager_bot_id = ? AND update_id = ?")
    .run(outcome, intentId, manager, id);
}
async function replayActive(db: Db, receipt: Receipt, manager: string, now: number): Promise<boolean> {
  if (!receipt.intent_id) return false;
  const row = await db.prepare("SELECT * FROM telegram_managed_intents WHERE id = ? AND manager_bot_id = ?")
    .get(receipt.intent_id, manager) as IntentRow | undefined;
  return !!row && active(row, now);
}

export class ManagedTelegramStore {
  constructor(private readonly db: Db) {}

  async begin(args: { tenant: string; managerBotId: string; now?: number }): Promise<{ intent: ManagedTelegramIntent; challenge: string }> {
    const tenant = tenantKey(args.tenant), manager = numericId(args.managerBotId), now = clock(args.now);
    const dek = requireDek();
    await ensureManagedTelegramSchema(this.db);
    const id = randomUUID(), challenge = `mm_${randomBytes(32).toString("base64url")}`;
    const row = await this.db.tx(async (db) => {
      refuseExistingBot((await readSettings(db, tenant, dek)).value);
      // A new web request replaces only this tenant's unfinished intent.
      await db.prepare(`UPDATE telegram_managed_intents SET status = 'cancelled' WHERE tenant = ? AND status IN ${ACTIVE}`).run(tenant);
      await db.prepare(`DELETE FROM telegram_managed_users WHERE intent_id IN
        (SELECT id FROM telegram_managed_intents WHERE tenant = ? AND status IN ('cancelled', 'expired', 'connected'))`).run(tenant);
      // A completion which committed while the preceding UPDATE waited must
      // still prevent this new intent. The caller's save lock also serializes
      // begin/complete/settings PUT across web replicas.
      refuseExistingBot((await readSettings(db, tenant, dek)).value);
      await db.prepare(`INSERT INTO telegram_managed_intents
        (id, tenant, manager_bot_id, challenge_hash, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'waiting_telegram', ?, ?)`).run(id, tenant, manager, hash(challenge), now, now + MANAGED_INTENT_TTL_MS);
      const inserted = await readIntent(db, tenant, id, manager);
      if (!inserted) throw new ManagedTelegramError("intent_unavailable", 503);
      return inserted;
    });
    return { intent: publicIntent(row, now), challenge };
  }

  async get(args: Scope): Promise<ManagedTelegramIntent | null> {
    const now = clock(args.now), tenant = tenantKey(args.tenant), manager = numericId(args.managerBotId);
    await ensureManagedTelegramSchema(this.db);
    const row = await readIntent(this.db, tenant, args.intentId, manager);
    return row ? publicIntent(row, now) : null;
  }

  async cancel(args: Scope): Promise<ManagedTelegramIntent | null> {
    const tenant = tenantKey(args.tenant), manager = numericId(args.managerBotId), now = clock(args.now);
    await ensureManagedTelegramSchema(this.db);
    return this.db.tx(async (db) => {
      const row = await readIntent(db, tenant, args.intentId, manager);
      if (!row) return null;
      await cancelRow(db, row, now);
      const current = await readIntent(db, tenant, args.intentId, manager);
      return current ? publicIntent(current, now) : null;
    });
  }

  /**
   * THE INTENT A MANAGER BUTTON NAMES, for the Telegram user who pressed it.
   * Found by its id, this manager and that user together, never by anything
   * else the button or the message carries: the user is the one the intent's
   * /start challenge bound, and only that user can confirm or cancel it from
   * Telegram. The tenant is for this server's own use (its settings lock and
   * completion); it never goes into a response, a message or a log.
   */
  async forTelegramUser(args: TelegramUserScope): Promise<{ tenant: `0x${string}`; intent: ManagedTelegramIntent } | null> {
    const manager = numericId(args.managerBotId), user = numericId(args.telegramUserId), now = clock(args.now);
    if (!intentIdOk(args.intentId)) return null;
    await ensureManagedTelegramSchema(this.db);
    const row = await readUserIntent(this.db, args.intentId, manager, user);
    return row ? { tenant: tenantKey(row.tenant) as `0x${string}`, intent: publicIntent(row, now) } : null;
  }

  /** The manager's "Not this bot": the web cancel, keyed by the Telegram user as forTelegramUser is. */
  async cancelForTelegramUser(args: TelegramUserScope): Promise<ManagedTelegramIntent | null> {
    const manager = numericId(args.managerBotId), user = numericId(args.telegramUserId), now = clock(args.now);
    if (!intentIdOk(args.intentId)) return null;
    await ensureManagedTelegramSchema(this.db);
    return this.db.tx(async (db) => {
      const row = await readUserIntent(db, args.intentId, manager, user);
      if (!row) return null;
      await cancelRow(db, row, now);
      const current = await readUserIntent(db, args.intentId, manager, user);
      return current ? publicIntent(current, now) : null;
    });
  }

  /** Whom the manager tells about a connection made on the web. Server use only, like the tenant above. */
  async boundTelegramUser(args: Scope): Promise<number | null> {
    const tenant = tenantKey(args.tenant), manager = numericId(args.managerBotId);
    await ensureManagedTelegramSchema(this.db);
    const row = await readIntent(this.db, tenant, args.intentId, manager);
    const user = row?.telegram_user_id ? Number(row.telegram_user_id) : NaN;
    return Number.isSafeInteger(user) && user > 0 ? user : null;
  }

  /** Caller has authenticated a private /start from this non-bot Telegram user. */
  async bind(args: UpdateScope & { challenge: string; messageDate?: number }): Promise<{ outcome: "bound" | "already_bound" | "ignored" }> {
    const manager = numericId(args.managerBotId), user = numericId(args.telegramUserId), id = updateId(args.updateId), now = clock(args.now);
    const date = messageDate(args.messageDate ?? Math.floor(now / 1000), now);
    if (!/^mm_[A-Za-z0-9_-]{43}$/.test(args.challenge)) return { outcome: "ignored" };
    const challengeHash = hash(args.challenge);
    await ensureManagedTelegramSchema(this.db);
    return this.db.tx(async (db) => {
      const update = await receive(db, manager, id, { kind: "start", challengeHash, user, date });
      if (!update.fresh) return { outcome: update.receipt.outcome === "bound" && await replayActive(db, update.receipt, manager, now) ? "already_bound" : "ignored" };
      const row = await db.prepare("SELECT * FROM telegram_managed_intents WHERE challenge_hash = ? AND manager_bot_id = ?")
        .get(challengeHash, manager) as IntentRow | undefined;
      if (!row || !active(row, now) || date * 1000 < Number(row.created_at) - 1000) return { outcome: "ignored" };
      if (row.telegram_user_id !== null) {
        if (row.telegram_user_id !== user) return { outcome: "ignored" };
        await record(db, manager, id, "bound", row.id);
        return { outcome: "already_bound" };
      }
      // This lease is globally keyed by Telegram user, across tenants/managers.
      // INSERT then SELECT sees a racing winner under PG READ COMMITTED.
      await db.prepare(`INSERT INTO telegram_managed_users (telegram_user_id, intent_id, expires_at)
        VALUES (?, ?, ?) ON CONFLICT(telegram_user_id) DO NOTHING`).run(user, row.id, row.expires_at);
      await db.prepare("UPDATE telegram_managed_users SET intent_id = ?, expires_at = ? WHERE telegram_user_id = ? AND expires_at <= ?")
        .run(row.id, row.expires_at, user, now);
      const lease = await db.prepare("SELECT intent_id FROM telegram_managed_users WHERE telegram_user_id = ?").get(user) as { intent_id: string } | undefined;
      if (!lease || lease.intent_id !== row.id) return { outcome: "ignored" };
      // Expired intent rows must stop participating in the unique-user index.
      await db.prepare(`UPDATE telegram_managed_intents SET status = 'expired'
        WHERE telegram_user_id = ? AND expires_at <= ? AND status IN ${ACTIVE}`).run(user, now);
      const bound = await db.prepare(`UPDATE telegram_managed_intents SET status = 'waiting_bot', telegram_user_id = ?,
        bound_at = ?, bound_message_date = ?, bound_update_id = ?
        WHERE id = ? AND manager_bot_id = ? AND status = 'waiting_telegram' AND expires_at > ? AND telegram_user_id IS NULL`)
        .run(user, now, date, id, row.id, manager, now);
      if (bound.changes !== 1) {
        await db.prepare("DELETE FROM telegram_managed_users WHERE telegram_user_id = ? AND intent_id = ?").run(user, row.id);
        return { outcome: "ignored" };
      }
      await record(db, manager, id, "bound", row.id);
      return { outcome: "bound" };
    });
  }

  /**
   * Only a fresh creation service message may supply the first candidate.
   * "candidate" (with the intent it proposes to) and "unmatched" come only
   * from an update's first delivery, so the manager's reply to either is sent
   * once; a redelivery answers "already_candidate" or "ignored".
   */
  async candidate(args: UpdateScope & { kind: "managed_bot_created"; botId: string; username: string; messageDate: number }): Promise<
    { outcome: "candidate"; intentId: string } | { outcome: "already_candidate" | "unmatched" | "ignored" }> {
    if (args.kind !== "managed_bot_created") return { outcome: "ignored" };
    const manager = numericId(args.managerBotId), user = numericId(args.telegramUserId), id = updateId(args.updateId), now = clock(args.now);
    const bot = numericId(args.botId), date = messageDate(args.messageDate, now);
    if (bot === manager) throw new ManagedTelegramError("manager_bot_reserved", 400);
    if (!/^[A-Za-z0-9_]{5,32}$/.test(args.username) || !/bot$/i.test(args.username)) throw new ManagedTelegramError("invalid_bot_username", 400);
    await ensureManagedTelegramSchema(this.db);
    return this.db.tx(async (db) => {
      const update = await receive(db, manager, id, { kind: args.kind, user, bot, username: args.username, date });
      if (!update.fresh) return { outcome: update.receipt.outcome === "candidate" && await replayActive(db, update.receipt, manager, now) ? "already_candidate" : "ignored" };
      const row = await db.prepare(`SELECT * FROM telegram_managed_intents
        WHERE manager_bot_id = ? AND telegram_user_id = ? AND status IN ${ACTIVE} AND expires_at > ?`)
        .get(manager, user, now) as IntentRow | undefined;
      if (!row) {
        await record(db, manager, id, "unmatched", null);
        return { outcome: "unmatched" };
      }
      if (row.bound_message_date === null || row.bound_update_id === null
        || date < Number(row.bound_message_date) || id <= Number(row.bound_update_id)) return { outcome: "ignored" };
      if (row.status !== "waiting_bot") return { outcome: "ignored" };
      const changed = await db.prepare(`UPDATE telegram_managed_intents SET status = 'confirm', bot_id = ?, bot_username = ?
        WHERE id = ? AND manager_bot_id = ? AND status = 'waiting_bot' AND bot_id IS NULL AND expires_at > ?`)
        .run(bot, args.username, row.id, manager, now);
      if (changed.changes !== 1) return { outcome: "ignored" };
      await record(db, manager, id, "candidate", row.id);
      return { outcome: "candidate", intentId: row.id };
    });
  }

  /** An authenticated selection (web owner, or bound Telegram user), under the caller's per-tenant settings lock. */
  async complete(args: Scope & { botId: string; token?: string; confirmedBotId?: string | null }): Promise<ManagedTelegramIntent> {
    const tenant = tenantKey(args.tenant), manager = numericId(args.managerBotId), bot = numericId(args.botId), now = clock(args.now);
    if (bot === manager) throw new ManagedTelegramError("manager_bot_reserved", 400);
    await ensureManagedTelegramSchema(this.db);
    return this.db.tx(async (db) => {
      const row = await readIntent(db, tenant, args.intentId, manager);
      if (!row) throw new ManagedTelegramError("intent_not_found", 404);
      if (row.status === "connected" && row.bot_id === bot) return publicIntent(row, now);
      if (!active(row, now)) throw new ManagedTelegramError("intent_expired");
      if (row.status !== "confirm" || row.bot_id !== bot || !row.telegram_user_id) throw new ManagedTelegramError("candidate_mismatch");
      if (!args.token || botIdOf(args.token) !== bot || args.confirmedBotId !== bot) throw new ManagedTelegramError("bot_unconfirmed");
      const dek = requireDek();
      const settings = await readSettings(db, tenant, dek);
      refuseExistingBot(settings.value);
      const claim = await claimBot(db, bot, tenant, args.confirmedBotId, now);
      if (!claim || claim.holder !== tenant) throw new ManagedTelegramError("bot_claimed");
      const sealed = sealSecret(JSON.stringify({ ...settings.value, telegramBotToken: args.token, telegramEnabled: true }), dek);
      const timestamp = Math.floor(now / 1000);
      const saved = settings.sealed === null
        ? await db.prepare(`INSERT INTO tenant_settings (tenant, sealed, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(tenant) DO NOTHING`).run(tenant, sealed, timestamp)
        : await db.prepare("UPDATE tenant_settings SET sealed = ?, updated_at = ? WHERE tenant = ? AND sealed = ?")
            .run(sealed, timestamp, tenant, settings.sealed);
      if (saved.changes !== 1) throw new ManagedTelegramError("settings_changed");
      const completed = await db.prepare(`UPDATE telegram_managed_intents SET status = 'connected', completed_at = ?
        WHERE id = ? AND tenant = ? AND manager_bot_id = ? AND status = 'confirm' AND bot_id = ? AND expires_at > ?`)
        .run(now, row.id, tenant, manager, bot, now);
      if (completed.changes !== 1) throw new ManagedTelegramError("intent_changed");
      await db.prepare("DELETE FROM telegram_managed_users WHERE intent_id = ?").run(row.id);
      row.status = "connected";
      return publicIntent(row, now);
    });
  }
}
