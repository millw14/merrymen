/**
 * THE X-POSTING TABLES, AND THE ONLY CODE THAT READS OR WRITES THEM.
 *
 * docs/x-posting.md is the contract. Seven tables, all `xpost_*`:
 *
 *   xpost_accounts — the connected X account per owner: its immutable X user
 *     id, the handle it had when it was connected, the sealed tokens, and the
 *     owner's consent — bound to the user id they were shown.
 *   xpost_pending  — an OAuth connect in flight, single use, fifteen minutes.
 *   xpost_posts    — every post: drafted and scheduled, claimed, sent, skipped,
 *     cancelled or failed. The UNIQUE dedupe_key and the conditional claim are
 *     what make a post at-most-once across crashes and replicas.
 *   xpost_meta     — fleet counters: the model's daily budget, the day's post
 *     allowance, the fleet's pauses and comment polling cursors; the
 *     per-person answer locks and an owner's replies-off mark.
 *   xpost_reply_accounts — separate consent for selected comment replies.
 *   xpost_reply_targets — durable comment, parent and author ids per reply.
 *   xpost_reply_optouts — recipient opt-outs per posting account and author.
 *
 * NOT THE SETTINGS BLOB, AND THAT IS THE POINT. The orchestrator copies every
 * tenant's decrypted settings into its child's plaintext settings.json each
 * reconcile, and the web's PUT replaces the blob whole. A token there would sit
 * in the clear in a process that must never hold it, and a refresh token X has
 * just rotated would be overwritten by the next settings save — and X refresh
 * tokens are single use, so that is a silent, permanent disconnect.
 *
 * NEVER A TRADING INPUT. Nothing that feeds a trading decision reads these
 * tables (xpost/boundary.test.ts). `posts` — the social table — is a trading
 * input through peer-theses, which is exactly why X posts are not stored there.
 *
 * ONE DIALECT, TWO DATABASES, with the same discipline as the room's store:
 * sqlite spelling translated by db.ts; `RETURNING` read through `.get()`
 * (Postgres reports lastInsertRowid as 0); "did it happen" is a RETURNING row or
 * an UPDATE/DELETE `changes`; snake_case result columns; upserts assign
 * `x = excluded.x` or a CASE on the table-qualified column; `?` only in
 * prepared SQL; every bound value a string, null or a safe integer.
 *
 * SEALED HERE, NOT BY CALLERS. Every token and verifier passes through
 * sealSecret/openSecret under the DEK the caller hands in, so there is one
 * place a plaintext secret could reach a column and it does not. The DEK comes
 * from the caller (requireDek() in web and orchestrator) because this module is
 * imported by both and reads no environment.
 */
import { createHash } from "node:crypto";
import type { Db } from "../db";
import { openSecret, sealSecret } from "../store-crypto";

export type XpostDialect = "postgres" | "sqlite";

/**
 * The DDL, in sqlite's dialect. `IF NOT EXISTS` throughout, so a second boot or
 * a second process is a no-op. Comments are `--` and free of placeholders and
 * quotes because translateSchema rewrites this text blind.
 */
export const XPOST_SCHEMA = `
CREATE TABLE IF NOT EXISTS xpost_accounts (
  tenant TEXT PRIMARY KEY,                 -- the owner, lowercased
  x_user_id TEXT NOT NULL,                 -- the X account, from GET /2/users/me
  username TEXT NOT NULL,                  -- its handle when connected, for display only
  sealed_access TEXT NOT NULL,
  sealed_refresh TEXT,                     -- null when X issued none
  access_expires_at_ms INTEGER NOT NULL,
  scope TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,      -- compare and swap for refresh rotation
  connected_at_ms INTEGER NOT NULL,
  posting_enabled INTEGER NOT NULL DEFAULT 0,
  consent_at_ms INTEGER,
  consent_x_user_id TEXT,                  -- the account named in the warning the owner confirmed
  tz TEXT,                                 -- the zone the owner consented from, for quiet hours
  status TEXT NOT NULL DEFAULT 'ok',       -- ok or revoked
  updated_at_ms INTEGER NOT NULL,
  post_buys INTEGER NOT NULL DEFAULT 1,    -- owner choice: post about the coins it buys
  post_casual INTEGER NOT NULL DEFAULT 1,  -- owner choice: post the odd passing thought
  per_day INTEGER                          -- owner choice: posts per local day, null for the server number
);
CREATE TABLE IF NOT EXISTS xpost_pending (
  state_hash TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  sealed_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS xpost_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  x_user_id TEXT NOT NULL,                 -- the account it was written for
  kind TEXT NOT NULL,                      -- intro casual buy sell reply or answer
  dedupe_key TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  coin TEXT,                               -- a buy post coin, for the per coin fold
  decision_id TEXT,
  status TEXT NOT NULL,                    -- scheduled sending posted skipped cancelled failed
  reason TEXT,                             -- a short operator code, never shown publicly
  created_at_ms INTEGER NOT NULL,
  due_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  tweet_id TEXT,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS xpost_posts_tenant ON xpost_posts (tenant, created_at_ms);
CREATE INDEX IF NOT EXISTS xpost_posts_due ON xpost_posts (status, due_at_ms);
CREATE INDEX IF NOT EXISTS xpost_posts_x_user ON xpost_posts (x_user_id, created_at_ms);
CREATE TABLE IF NOT EXISTS xpost_reply_targets (
  post_id INTEGER PRIMARY KEY,
  reply_to_tweet_id TEXT NOT NULL,
  root_tweet_id TEXT NOT NULL,
  author_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS xpost_reply_accounts (
  tenant TEXT PRIMARY KEY,
  x_user_id TEXT NOT NULL,
  consent_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS xpost_reply_optouts (
  x_user_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (x_user_id, author_id)
);
CREATE TABLE IF NOT EXISTS xpost_meta (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  v TEXT,
  updated_at_ms INTEGER NOT NULL
);
`;

/**
 * The columns a table made by an earlier CREATE lacks: CREATE TABLE IF NOT
 * EXISTS adds none to a table that is there. The defaults are what every
 * owner had before the choices existed: buys and passing thoughts both on, and
 * the server's number of posts a day. How they are run is ensureXpostSchema's
 * business (Postgres: only the missing ones, in a transaction of their own).
 */
export const XPOST_ALTERS: readonly string[] = [
  "ALTER TABLE xpost_accounts ADD COLUMN post_buys INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE xpost_accounts ADD COLUMN post_casual INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE xpost_accounts ADD COLUMN per_day INTEGER",
];

/** The column an XPOST_ALTERS statement adds. */
const addedColumn = (ddl: string): string => /ADD COLUMN (\w+)/.exec(ddl)?.[1] ?? "";

/** Distinct from every other advisory key in the repo (the room's is 1_297_692_090). */
const SCHEMA_LOCK = 1_297_692_110;

const schemaReady = new WeakMap<Db, Promise<void>>();

/**
 * Create the tables once per Db for the life of the process. Memoised on the
 * Db and dropped on failure so a briefly unreachable database is retried. On
 * Postgres the DDL runs under an advisory lock because web and orchestrator
 * boot together and two concurrent CREATE TABLE IF NOT EXISTS can collide.
 *
 * THE ADDED COLUMNS, APART, AND ONLY WHEN MISSING. An ALTER TABLE takes an
 * ACCESS EXCLUSIVE lock on xpost_accounts even when IF NOT EXISTS makes it a
 * no-op, and the schema transaction already holds xpost_posts (its CREATE
 * INDEX IF NOT EXISTS locks the table it would index). Every other writer
 * takes accounts first, then posts — an owner's Off, a Disconnect — so the
 * two in one transaction deadlocked the owner's Off on a process's first
 * query. They run in a second transaction under the same advisory lock, and
 * only for a column information_schema says is missing: a normal restart
 * takes no exclusive lock at all.
 */
export function ensureXpostSchema(db: Db, dialect: XpostDialect): Promise<void> {
  const existing = schemaReady.get(db);
  if (existing) return existing;
  const started = (async () => {
    if (dialect === "postgres") {
      await db.tx(async (tx) => {
        await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(SCHEMA_LOCK);
        await tx.exec(XPOST_SCHEMA);
      });
      await db.tx(async (tx) => {
        await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(SCHEMA_LOCK);
        const rows = (await tx
          .prepare(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'xpost_accounts'`,
          )
          .all()) as { column_name: unknown }[];
        const have = new Set(rows.map((r) => String(r.column_name)));
        for (const ddl of XPOST_ALTERS) if (!have.has(addedColumn(ddl))) await tx.exec(ddl);
      });
    } else {
      await db.exec(XPOST_SCHEMA);
      for (const ddl of XPOST_ALTERS) {
        try {
          await db.exec(ddl);
        } catch (e) {
          if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e;
        }
      }
    }
  })().catch((error: unknown) => {
    if (schemaReady.get(db) === started) schemaReady.delete(db);
    throw error;
  });
  schemaReady.set(db, started);
  return started;
}

// ── small helpers ───────────────────────────────────────────────────────────

/** Every table keys the owner lowercased: the session's checksummed address and the roster's must meet. */
export function tenantKey(tenant: string | null | undefined): string {
  return String(tenant ?? "").trim().toLowerCase();
}

/** A bindable integer: pg refuses a fractional value for a BIGINT column. */
function int(n: number): number {
  const r = Math.trunc(Number(n));
  if (!Number.isFinite(r)) return 0;
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, r));
}

function num(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** The state is a bearer value until it is spent: only its hash is stored. */
export function stateHash(state: string): string {
  return createHash("sha256").update(String(state)).digest("hex");
}

// ── pending connects ────────────────────────────────────────────────────────

export interface PendingConnect {
  tenant: string;
  verifier: string;
  redirectUri: string;
}

/** Park a connect between the start and the finish. The verifier is sealed; the state is stored hashed. */
export async function putPending(
  db: Db,
  dek: Buffer,
  p: { state: string; tenant: string; verifier: string; redirectUri: string; expiresAtMs: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO xpost_pending (state_hash, tenant, sealed_verifier, redirect_uri, expires_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(stateHash(p.state), tenantKey(p.tenant), sealSecret(p.verifier, dek), p.redirectUri, int(p.expiresAtMs));
}

/**
 * SPEND a pending connect: delete it and return what it held, or null when it
 * is unknown, already spent or expired. DELETE … RETURNING is the whole answer
 * on both engines, so two finishes racing one state cannot both get a row.
 * An expired row is deleted too, and answers null.
 */
export async function takePending(db: Db, dek: Buffer, state: string, nowMs: number): Promise<PendingConnect | null> {
  const row = (await db
    .prepare(
      `DELETE FROM xpost_pending WHERE state_hash = ?
       RETURNING tenant, sealed_verifier, redirect_uri, expires_at_ms`,
    )
    .get(stateHash(state))) as { tenant: unknown; sealed_verifier: unknown; redirect_uri: unknown; expires_at_ms: unknown } | undefined;
  if (!row) return null;
  if (num(row.expires_at_ms) <= nowMs) return null;
  const sealed = strOrNull(row.sealed_verifier);
  const redirectUri = strOrNull(row.redirect_uri);
  if (!sealed || !redirectUri) return null;
  return { tenant: tenantKey(strOrNull(row.tenant)), verifier: openSecret(sealed, dek), redirectUri };
}

/** Drop connects nobody finished. */
export async function prunePending(db: Db, nowMs: number): Promise<number> {
  const r = await db.prepare(`DELETE FROM xpost_pending WHERE expires_at_ms <= ?`).run(int(nowMs));
  return r.changes;
}

// ── accounts ────────────────────────────────────────────────────────────────

export type AccountStatus = "ok" | "revoked";

/**
 * The most posts a day an owner may choose (the planner's own default,
 * planner.ts DEFAULT_PER_DAY). With no choice, the server's number applies
 * (MERRYMEN_XPOST_PER_DAY, which may be higher or lower); with one, whichever
 * of the two is smaller. An owner can post less, never more.
 */
export const OWNER_PER_DAY_MAX = 3;

/**
 * WHAT THE OWNER LETS IT POST, beside the switch (docs/x-posting.md "What the
 * owner chooses"). The hello is not a choice: it is the post that says an AI
 * agent posts here, and it always comes first (the owner can still Skip it).
 */
export interface XPostPrefs {
  /** Post about a coin it bought, and why. Only real fills: never one it is watching. */
  buys: boolean;
  /** Post the odd passing thought. */
  casual: boolean;
  /** Posts per owner-local day, 1..OWNER_PER_DAY_MAX; null for the server's number. */
  perDay: number | null;
}

/** What every owner had before the choices existed. */
export const DEFAULT_PREFS: Readonly<XPostPrefs> = Object.freeze({ buys: true, casual: true, perDay: null });

/** A stored or requested per-day choice, or null when it is not one. */
export function ownerPerDay(v: unknown): number | null {
  const n = typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isSafeInteger(n) && n >= 1 && n <= OWNER_PER_DAY_MAX ? n : null;
}

export interface XAccount {
  tenant: string;
  xUserId: string;
  username: string;
  accessExpiresAtMs: number;
  scope: string;
  version: number;
  connectedAtMs: number;
  consentAtMs: number | null;
  consentXUserId: string | null;
  /**
   * THE ZONE THE OWNER CONSENTED FROM (an IANA name the web or the app read off
   * the device when the owner turned posting on), or null. The quiet-hours
   * fallback when the room has no zone for this owner: without it, an owner
   * the room never met is never asleep, and their account posts at 4am.
   */
  tz: string | null;
  status: AccountStatus;
  updatedAtMs: number;
  /** What the owner lets it post (XPostPrefs). */
  prefs: XPostPrefs;
  /**
   * POSTING IS ON FOR THE ACCOUNT CONNECTED NOW: the switch, AND a consent that
   * names this exact X user id, AND a connection X still honours. Every reader
   * uses this, never the raw column, so "on" can never mean "on for an account
   * the owner was not shown".
   */
  posting: boolean;
}

const ACCOUNT_COLUMNS =
  "tenant, x_user_id, username, access_expires_at_ms, scope, version, connected_at_ms, posting_enabled, " +
  "consent_at_ms, consent_x_user_id, tz, status, updated_at_ms, post_buys, post_casual, per_day";

interface AccountRow {
  tenant: unknown;
  x_user_id: unknown;
  username: unknown;
  access_expires_at_ms: unknown;
  scope: unknown;
  version: unknown;
  connected_at_ms: unknown;
  posting_enabled: unknown;
  consent_at_ms: unknown;
  consent_x_user_id: unknown;
  tz: unknown;
  status: unknown;
  updated_at_ms: unknown;
  post_buys: unknown;
  post_casual: unknown;
  per_day: unknown;
}

/** A stored choice. Anything but a clear 0 is on: the column's default, and what every owner had before. */
function prefsOf(r: Pick<AccountRow, "post_buys" | "post_casual" | "per_day">): XPostPrefs {
  const on = (v: unknown) => v === null || v === undefined || num(v) !== 0;
  return { buys: on(r.post_buys), casual: on(r.post_casual), perDay: ownerPerDay(r.per_day) };
}

function accountOf(r: AccountRow): XAccount {
  const xUserId = String(r.x_user_id ?? "");
  const consentXUserId = strOrNull(r.consent_x_user_id);
  const status: AccountStatus = r.status === "ok" ? "ok" : "revoked";
  const enabled = num(r.posting_enabled) === 1;
  return {
    tenant: tenantKey(strOrNull(r.tenant)),
    xUserId,
    username: String(r.username ?? ""),
    accessExpiresAtMs: num(r.access_expires_at_ms),
    scope: String(r.scope ?? ""),
    version: num(r.version),
    connectedAtMs: num(r.connected_at_ms),
    consentAtMs: r.consent_at_ms === null || r.consent_at_ms === undefined ? null : num(r.consent_at_ms),
    consentXUserId,
    tz: strOrNull(r.tz),
    status,
    updatedAtMs: num(r.updated_at_ms),
    prefs: prefsOf(r),
    posting: enabled && status === "ok" && xUserId !== "" && consentXUserId === xUserId,
  };
}

export async function getAccount(db: Db, tenant: string): Promise<XAccount | null> {
  const row = (await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM xpost_accounts WHERE tenant = ?`).get(tenantKey(tenant))) as
    | AccountRow
    | undefined;
  return row ? accountOf(row) : null;
}

/** The accounts among `tenants` that may post right now (XAccount.posting), in tenant order. */
export async function postingAccounts(db: Db, tenants: readonly string[]): Promise<XAccount[]> {
  const keys = [...new Set(tenants.map(tenantKey).filter((t) => t !== ""))];
  if (keys.length === 0) return [];
  const rows = (await db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM xpost_accounts
        WHERE posting_enabled = 1 AND status = 'ok' AND consent_x_user_id = x_user_id
          AND tenant IN (${keys.map(() => "?").join(", ")})
        ORDER BY tenant`,
    )
    .all(...keys)) as AccountRow[];
  return rows.map(accountOf).filter((a) => a.posting);
}

/** Separate, account-bound consent for replies. Posting consent alone is insufficient. */
export async function repliesEnabledFor(db: Db, tenant: string, xUserId: string): Promise<boolean> {
  return (await replyConsentAt(db, tenant, xUserId)) !== null;
}

/** First polling starts at reply consent, rather than an account's old mention history. */
export async function replyConsentAt(db: Db, tenant: string, xUserId: string): Promise<number | null> {
  const row = await db.prepare(`SELECT r.consent_at_ms FROM xpost_reply_accounts r JOIN xpost_accounts a ON a.tenant = r.tenant
    WHERE r.tenant = ? AND r.x_user_id = ? AND a.x_user_id = r.x_user_id
      AND a.posting_enabled = 1 AND a.status = 'ok' AND a.consent_x_user_id = a.x_user_id`)
    .get(tenantKey(tenant), xUserId) as { consent_at_ms: unknown } | undefined;
  return row ? num(row.consent_at_ms) : null;
}

/** A shared X inbox must cover every active owner's consent, including opt-outs. */
export async function firstReplyConsentAt(db: Db, xUserId: string): Promise<number | null> {
  const row = await db.prepare(`SELECT MIN(r.consent_at_ms) AS consent_at_ms
    FROM xpost_reply_accounts r JOIN xpost_accounts a ON a.tenant = r.tenant
    WHERE r.x_user_id = ? AND a.x_user_id = r.x_user_id
      AND a.posting_enabled = 1 AND a.status = 'ok' AND a.consent_x_user_id = a.x_user_id`)
    .get(xUserId) as { consent_at_ms: unknown } | undefined;
  return row?.consent_at_ms === null || row?.consent_at_ms === undefined ? null : num(row.consent_at_ms);
}

/** The durable mark an owner's own "replies off" leaves (xpost_meta), which the house consent never overrides. */
export function repliesOffKey(tenant: string): string {
  return `replies-off:${tenantKey(tenant)}`;
}

/**
 * Turning replies off leaves ordinary posting on and cancels only waiting replies.
 *
 * THE OWNER'S OFF IS REMEMBERED. Turning replies off also writes
 * repliesOffKey(tenant), and only the owner's own on (the web or the app,
 * after the reply warning) clears it. `house` is the orchestrator recording
 * consent for one of the operator's own agents (MERRYMEN_XPOST_ACTIVE_TENANTS,
 * docs/x-posting.md "Active owners"): it changes nothing — false — while
 * that mark exists or consent is already recorded, and it leaves the mark
 * alone. It is decided under the same account row lock as the owner's off,
 * so the two cannot interleave.
 */
export async function setReplying(
  db: Db, tenant: string, enabled: boolean, seenXUserId: string, nowMs: number, opts: { house?: boolean } = {},
): Promise<boolean> {
  const key = tenantKey(tenant);
  return db.tx(async (tx) => {
    // Serialize with account replacement, disconnect and posting switches.
    const current = await tx.prepare(`UPDATE xpost_accounts SET updated_at_ms = updated_at_ms WHERE tenant = ? AND x_user_id = ?
      AND (? = 0 OR (posting_enabled = 1 AND status = 'ok' AND consent_x_user_id = x_user_id))`)
      .run(key, seenXUserId, enabled ? 1 : 0);
    if (current.changes !== 1) return false;
    if (enabled && opts.house) {
      if (await readMeta(tx, repliesOffKey(key)) !== null) return false;
      if (await tx.prepare(`SELECT tenant FROM xpost_reply_accounts WHERE tenant = ?`).get(key) !== undefined) return false;
    }
    if (enabled) {
      await tx.prepare(`INSERT INTO xpost_reply_accounts (tenant, x_user_id, consent_at_ms) VALUES (?, ?, ?)
        ON CONFLICT (tenant) DO UPDATE SET
          consent_at_ms = CASE WHEN xpost_reply_accounts.x_user_id = excluded.x_user_id THEN xpost_reply_accounts.consent_at_ms ELSE excluded.consent_at_ms END,
          x_user_id = excluded.x_user_id`)
        .run(key, seenXUserId, int(nowMs));
      if (!opts.house) await tx.prepare(`DELETE FROM xpost_meta WHERE k = ?`).run(repliesOffKey(key));
    } else {
      await tx.prepare(`DELETE FROM xpost_reply_accounts WHERE tenant = ?`).run(key);
      await tx.prepare(`UPDATE xpost_posts SET status = 'cancelled', reason = 'replies-off', updated_at_ms = ?
        WHERE tenant = ? AND kind IN ('reply', 'answer') AND status = 'scheduled'`).run(int(nowMs), key);
      await writeMeta(tx, repliesOffKey(key), "owner", nowMs);
    }
    return true;
  });
}

/** Recipient opt-outs are shared by every tenant connected to this X account. */
export async function repliesOptedOut(db: Db, xUserId: string, authorId: string): Promise<boolean> {
  return (await db.prepare(`SELECT author_id FROM xpost_reply_optouts WHERE x_user_id = ? AND author_id = ?`)
    .get(xUserId, authorId)) !== undefined;
}

export async function optOutReplies(db: Db, xUserId: string, authorId: string, nowMs: number): Promise<void> {
  if (!X_ID.test(xUserId) || !X_ID.test(authorId)) return;
  await db.tx(async (tx) => {
    await tx.prepare(`INSERT INTO xpost_reply_optouts (x_user_id, author_id, created_at_ms) VALUES (?, ?, ?)
      ON CONFLICT (x_user_id, author_id) DO NOTHING`).run(xUserId, authorId, int(nowMs));
    await tx.prepare(`UPDATE xpost_posts SET status = 'cancelled', reason = 'recipient-optout', updated_at_ms = ?
      WHERE x_user_id = ? AND kind IN ('reply', 'answer') AND status = 'scheduled'
        AND EXISTS (SELECT 1 FROM xpost_reply_targets r WHERE r.post_id = xpost_posts.id AND r.author_id = ?)`)
      .run(int(nowMs), xUserId, authorId);
  });
}

export interface TokenSetPlain {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAtMs: number;
  scope: string;
}

/**
 * Store a fresh connection. A reconnect of the SAME X user keeps the owner's
 * consent and switch; a DIFFERENT X user clears both — the owner confirmed a
 * warning that named another account (docs/x-posting.md rule 1) — and cancels
 * whatever was drafted for the old one. Returns whether the account changed.
 */
export async function upsertAccount(
  db: Db,
  dek: Buffer,
  a: { tenant: string; xUserId: string; username: string; tokens: TokenSetPlain; nowMs: number },
): Promise<{ changedAccount: boolean }> {
  const tenant = tenantKey(a.tenant);
  return db.tx(async (tx) => {
    const before = (await tx.prepare(`SELECT x_user_id FROM xpost_accounts WHERE tenant = ?`).get(tenant)) as
      | { x_user_id: unknown }
      | undefined;
    const changedAccount = before !== undefined && String(before.x_user_id ?? "") !== a.xUserId;
    await tx
      .prepare(
        `INSERT INTO xpost_accounts (
           tenant, x_user_id, username, sealed_access, sealed_refresh, access_expires_at_ms, scope,
           version, connected_at_ms, posting_enabled, consent_at_ms, consent_x_user_id, status, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0, NULL, NULL, 'ok', ?)
         ON CONFLICT (tenant) DO UPDATE SET
           posting_enabled = CASE WHEN xpost_accounts.x_user_id = excluded.x_user_id THEN xpost_accounts.posting_enabled ELSE 0 END,
           consent_at_ms = CASE WHEN xpost_accounts.x_user_id = excluded.x_user_id THEN xpost_accounts.consent_at_ms ELSE NULL END,
           consent_x_user_id = CASE WHEN xpost_accounts.x_user_id = excluded.x_user_id THEN xpost_accounts.consent_x_user_id ELSE NULL END,
           version = CASE WHEN xpost_accounts.version IS NULL THEN 1 ELSE xpost_accounts.version + 1 END,
           x_user_id = excluded.x_user_id,
           username = excluded.username,
           sealed_access = excluded.sealed_access,
           sealed_refresh = excluded.sealed_refresh,
           access_expires_at_ms = excluded.access_expires_at_ms,
           scope = excluded.scope,
           connected_at_ms = excluded.connected_at_ms,
           status = excluded.status,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        tenant,
        a.xUserId,
        a.username,
        sealSecret(a.tokens.accessToken, dek),
        a.tokens.refreshToken ? sealSecret(a.tokens.refreshToken, dek) : null,
        int(a.tokens.accessExpiresAtMs),
        a.tokens.scope,
        int(a.nowMs),
        int(a.nowMs),
      );
    if (changedAccount) {
      await tx.prepare(`DELETE FROM xpost_reply_accounts WHERE tenant = ?`).run(tenant);
      await cancelScheduledIn(tx, tenant, a.nowMs, "account-changed");
    }
    return { changedAccount };
  });
}

/**
 * THE OWNER'S SWITCH. Turning it on needs the X user id the warning named:
 * if the connected account is no longer that one, nothing changes and the
 * answer is false, so the owner is shown the new account before it can post.
 * Turning it off always works, and cancels every drafted post.
 *
 * `tz` is the zone the device reported when the owner confirmed — already
 * validated by the caller (a canonical IANA name, and never a placeless one
 * like UTC that a privacy browser reports for everybody), or null to keep
 * whatever was stored before.
 */
export async function setPosting(
  db: Db,
  tenant: string,
  change: { enabled: true; xUserId: string; tz?: string | null } | { enabled: false },
  nowMs: number,
): Promise<boolean> {
  const key = tenantKey(tenant);
  if (change.enabled) {
    const r = await db
      .prepare(
        `UPDATE xpost_accounts
            SET posting_enabled = 1, consent_at_ms = ?, consent_x_user_id = x_user_id,
                tz = COALESCE(?, tz), updated_at_ms = ?
          WHERE tenant = ? AND x_user_id = ? AND status = 'ok'`,
      )
      .run(int(nowMs), typeof change.tz === "string" && change.tz !== "" ? change.tz : null, int(nowMs), key, change.xUserId);
    return r.changes === 1;
  }
  return db.tx(async (tx) => {
    const r = await tx
      .prepare(`UPDATE xpost_accounts SET posting_enabled = 0, updated_at_ms = ? WHERE tenant = ?`)
      .run(int(nowMs), key);
    await cancelScheduledIn(tx, key, nowMs, "turned-off");
    await tx.prepare(`DELETE FROM xpost_reply_accounts WHERE tenant = ?`).run(key);
    return r.changes === 1;
  });
}

/**
 * WHAT THE OWNER LETS IT POST (XPostPrefs). Only the fields given change. A
 * kind turned off takes its drafts out of Coming up at once (cancelled
 * `kind-off`): the owner just said not to post them. A lower number a day
 * leaves the drafts alone — each post still takes a place in the day's count
 * right before it is sent (orchestrator-xpost.ts), so no more than the new
 * number goes out. Returns the choices now stored, or null when this owner
 * has no connection.
 * A claimed post keeps its sending status, but remembers kind-off so a
 * definite refusal cannot revive it after the owner turns the kind back on.
 *
 * ONE UPDATE, ONLY THE FIELDS GIVEN. A read then a write of all three would
 * let two saves at once (two tabs, or a tab and the app) put back the field
 * the other one just changed: "coins it buys" shown off, and stored on.
 */
export async function setPrefs(db: Db, tenant: string, change: Partial<XPostPrefs>, nowMs: number): Promise<XPostPrefs | null> {
  const key = tenantKey(tenant);
  const buys = typeof change.buys === "boolean" ? (change.buys ? 1 : 0) : null;
  const casual = typeof change.casual === "boolean" ? (change.casual ? 1 : 0) : null;
  const setDay = change.perDay === null || ownerPerDay(change.perDay) !== null;
  return db.tx(async (tx) => {
    const row = (await tx
      .prepare(
        `UPDATE xpost_accounts
            SET post_buys = COALESCE(?, post_buys), post_casual = COALESCE(?, post_casual),
                per_day = CASE WHEN ? = 1 THEN ? ELSE per_day END, updated_at_ms = ?
          WHERE tenant = ?
        RETURNING post_buys, post_casual, per_day`,
      )
      .get(buys, casual, setDay ? 1 : 0, setDay ? ownerPerDay(change.perDay) : null, int(nowMs), key)) as
      | Pick<AccountRow, "post_buys" | "post_casual" | "per_day">
      | undefined;
    if (!row) return null;
    const next = prefsOf(row);
    // A recap names the coins it bought: it goes with the buy posts.
    for (const kind of [...(next.buys ? [] : ["buy", "recap"]), ...(next.casual ? [] : ["casual"])]) {
      await tx
        .prepare(
          `UPDATE xpost_posts
              SET status = CASE WHEN status = 'scheduled' THEN 'cancelled' ELSE status END,
                  reason = 'kind-off', updated_at_ms = ?
            WHERE tenant = ? AND kind = ? AND status IN ('scheduled', 'sending')`,
        )
        .run(int(nowMs), key, kind);
    }
    return next;
  });
}

/**
 * Forget the connection. Returns the tokens so the caller can revoke them at X
 * (best effort — the row is gone either way), and cancels every drafted post.
 */
export async function deleteAccount(
  db: Db,
  dek: Buffer,
  tenant: string,
  nowMs: number,
): Promise<{ accessToken: string | null; refreshToken: string | null } | null> {
  const key = tenantKey(tenant);
  return db.tx(async (tx) => {
    const row = (await tx
      .prepare(`DELETE FROM xpost_accounts WHERE tenant = ? RETURNING sealed_access, sealed_refresh`)
      .get(key)) as { sealed_access: unknown; sealed_refresh: unknown } | undefined;
    await cancelScheduledIn(tx, key, nowMs, "disconnected");
    await tx.prepare(`DELETE FROM xpost_reply_accounts WHERE tenant = ?`).run(key);
    if (!row) return null;
    return {
      accessToken: openOrNull(row.sealed_access, dek),
      refreshToken: openOrNull(row.sealed_refresh, dek),
    };
  });
}

function openOrNull(sealed: unknown, dek: Buffer): string | null {
  if (typeof sealed !== "string" || sealed === "") return null;
  try {
    return openSecret(sealed, dek);
  } catch {
    // A token this DEK cannot open is a token nobody can use: revoking it is moot.
    return null;
  }
}

export interface StoredTokens {
  xUserId: string;
  version: number;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAtMs: number;
  status: AccountStatus;
}

/** The tenant's tokens, opened. Throws when the DEK cannot open them: that is a fault, not "no tokens". */
export async function readTokens(db: Db, dek: Buffer, tenant: string): Promise<StoredTokens | null> {
  const row = (await db
    .prepare(
      `SELECT x_user_id, version, sealed_access, sealed_refresh, access_expires_at_ms, status
         FROM xpost_accounts WHERE tenant = ?`,
    )
    .get(tenantKey(tenant))) as
    | { x_user_id: unknown; version: unknown; sealed_access: unknown; sealed_refresh: unknown; access_expires_at_ms: unknown; status: unknown }
    | undefined;
  if (!row) return null;
  return {
    xUserId: String(row.x_user_id ?? ""),
    version: num(row.version),
    accessToken: openSecret(String(row.sealed_access ?? ""), dek),
    refreshToken: typeof row.sealed_refresh === "string" && row.sealed_refresh !== "" ? openSecret(row.sealed_refresh, dek) : null,
    accessExpiresAtMs: num(row.access_expires_at_ms),
    status: row.status === "ok" ? "ok" : "revoked",
  };
}

/**
 * WRITE A ROTATED TOKEN PAIR, only over the version it was refreshed from.
 * False means somebody else wrote first (a reconnect, a disconnect): the pair
 * just obtained is dropped and the next pass reads what won. The new refresh
 * token is stored BEFORE the access token is used — X invalidated the old one
 * the moment it answered.
 */
export async function swapTokens(
  db: Db,
  dek: Buffer,
  tenant: string,
  fromVersion: number,
  tokens: TokenSetPlain,
  nowMs: number,
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE xpost_accounts
          SET sealed_access = ?, sealed_refresh = ?, access_expires_at_ms = ?, scope = ?,
              version = version + 1, updated_at_ms = ?
        WHERE tenant = ? AND version = ? AND status = 'ok'`,
    )
    .run(
      sealSecret(tokens.accessToken, dek),
      tokens.refreshToken ? sealSecret(tokens.refreshToken, dek) : null,
      int(tokens.accessExpiresAtMs),
      tokens.scope,
      int(nowMs),
      tenantKey(tenant),
      int(fromVersion),
    );
  return r.changes === 1;
}

/**
 * X REFUSED THE CONNECTION (a refresh answered invalid_grant, or a fresh token
 * was refused). Posting stops, drafts are cancelled, and the owner is asked to
 * reconnect. Only over the version that failed, so a reconnect that landed in
 * between is not marked dead.
 */
export async function markRevoked(db: Db, tenant: string, atVersion: number, nowMs: number): Promise<boolean> {
  const key = tenantKey(tenant);
  return db.tx(async (tx) => {
    const r = await tx
      .prepare(`UPDATE xpost_accounts SET status = 'revoked', updated_at_ms = ? WHERE tenant = ? AND version = ?`)
      .run(int(nowMs), key, int(atVersion));
    if (r.changes === 1) await cancelScheduledIn(tx, key, nowMs, "revoked");
    return r.changes === 1;
  });
}

// ── posts ───────────────────────────────────────────────────────────────────

/**
 * `answer` is an active agent's reply to a post that tagged it (the mention is
 * both its target and its root). It has its own short gap and day allowance,
 * so it neither waits behind nor spends the account's posting cadence.
 */
/** `recap`: an active agent's one post for a burst of trades (planner.ts planRecap, 2026-10-14). */
export type XPostKind = "intro" | "casual" | "buy" | "sell" | "reply" | "answer" | "recap";
/** Every kind, as a closed list: what a kind filter may name in SQL. */
const XPOST_KINDS: readonly XPostKind[] = ["intro", "casual", "buy", "sell", "reply", "answer", "recap"];
export type XPostStatus = "scheduled" | "sending" | "posted" | "skipped" | "cancelled" | "failed";

export interface XPost {
  id: number;
  tenant: string;
  xUserId: string;
  kind: XPostKind;
  dedupeKey: string;
  body: string;
  coin: string | null;
  decisionId: string | null;
  status: XPostStatus;
  reason: string | null;
  createdAtMs: number;
  dueAtMs: number;
  sentAtMs: number | null;
  tweetId: string | null;
  replyToTweetId?: string;
  replyRootTweetId?: string;
  replyAuthorId?: string;
  updatedAtMs: number;
}

const POST_COLUMNS =
  "id, tenant, x_user_id, kind, dedupe_key, body, coin, decision_id, status, reason, created_at_ms, due_at_ms, " +
  "sent_at_ms, tweet_id, updated_at_ms, " +
  "(SELECT reply_to_tweet_id FROM xpost_reply_targets r WHERE r.post_id = xpost_posts.id) AS reply_to_tweet_id, " +
  "(SELECT root_tweet_id FROM xpost_reply_targets r WHERE r.post_id = xpost_posts.id) AS reply_root_tweet_id, " +
  "(SELECT author_id FROM xpost_reply_targets r WHERE r.post_id = xpost_posts.id) AS reply_author_id";

interface PostRow {
  id: unknown;
  tenant: unknown;
  x_user_id: unknown;
  kind: unknown;
  dedupe_key: unknown;
  body: unknown;
  coin: unknown;
  decision_id: unknown;
  status: unknown;
  reason: unknown;
  created_at_ms: unknown;
  due_at_ms: unknown;
  sent_at_ms: unknown;
  tweet_id: unknown;
  reply_to_tweet_id?: unknown;
  reply_root_tweet_id?: unknown;
  reply_author_id?: unknown;
  updated_at_ms: unknown;
}

const KINDS: ReadonlySet<string> = new Set(XPOST_KINDS);
const STATUSES: ReadonlySet<string> = new Set(["scheduled", "sending", "posted", "skipped", "cancelled", "failed"]);

function postOf(r: PostRow): XPost {
  return {
    id: num(r.id),
    tenant: tenantKey(strOrNull(r.tenant)),
    xUserId: String(r.x_user_id ?? ""),
    kind: (KINDS.has(String(r.kind)) ? r.kind : "casual") as XPostKind,
    dedupeKey: String(r.dedupe_key ?? ""),
    body: String(r.body ?? ""),
    coin: strOrNull(r.coin),
    decisionId: strOrNull(r.decision_id),
    // An unknown status reads as failed: never as something that may be sent.
    status: (STATUSES.has(String(r.status)) ? r.status : "failed") as XPostStatus,
    reason: strOrNull(r.reason),
    createdAtMs: num(r.created_at_ms),
    dueAtMs: num(r.due_at_ms),
    sentAtMs: r.sent_at_ms === null || r.sent_at_ms === undefined ? null : num(r.sent_at_ms),
    tweetId: strOrNull(r.tweet_id),
    ...(typeof r.reply_to_tweet_id === "string" ? { replyToTweetId: r.reply_to_tweet_id } : {}),
    ...(typeof r.reply_root_tweet_id === "string" ? { replyRootTweetId: r.reply_root_tweet_id } : {}),
    ...(typeof r.reply_author_id === "string" ? { replyAuthorId: r.reply_author_id } : {}),
    updatedAtMs: num(r.updated_at_ms),
  };
}

export interface NewPost {
  tenant: string;
  xUserId: string;
  kind: XPostKind;
  dedupeKey: string;
  body: string;
  coin?: string | null;
  decisionId?: string | null;
  replyToTweetId?: string;
  replyRootTweetId?: string;
  replyAuthorId?: string;
  dueAtMs: number;
  nowMs: number;
  /** Small-talk only: reserve the wording for this author for seven days. Not persisted as a new field. */
  smalltalk?: boolean;
  /**
   * "skipped" records a decision NOT to post under this key — a draft the gate
   * refused, a model that said PASS — so the key is spent and the same buy or
   * day is not drafted again every minute on the model's allowance.
   */
  status?: "scheduled" | "skipped";
  reason?: string | null;
}

/**
 * Write a post under its dedupe key. The id, or null when the key was already
 * used — that post was already written (or deliberately not), which is how an
 * intro or a buy post survives a redeploy without being said twice.
 */
export async function schedulePost(db: Db, p: NewPost): Promise<number | null> {
  if (!p.dedupeKey) throw new Error("a post needs a dedupe key");
  if (p.kind === "reply") {
    if (!validReplyIds(p) || p.replyToTweetId === p.replyRootTweetId || p.dedupeKey !== `reply:${p.xUserId}:${p.replyToTweetId}` || p.replyAuthorId === p.xUserId) return null;
    return db.tx(async (tx) => {
      // Lock the account row against an overlapping disconnect or switch-off.
      const current = await tx.prepare(`UPDATE xpost_accounts SET updated_at_ms = updated_at_ms
        WHERE tenant = ? AND x_user_id = ? AND posting_enabled = 1 AND status = 'ok' AND consent_x_user_id = x_user_id`)
        .run(tenantKey(p.tenant), p.xUserId);
      if (current.changes !== 1 || !(await repliesEnabledFor(tx, p.tenant, p.xUserId)) ||
          await repliesOptedOut(tx, p.xUserId, p.replyAuthorId!)) return null;
      const parent = await tx.prepare(`SELECT id FROM xpost_posts WHERE tenant = ? AND x_user_id = ?
        AND kind = 'buy' AND status = 'posted' AND tweet_id = ?`).get(tenantKey(p.tenant), p.xUserId, p.replyRootTweetId!);
      if (!parent) return null;
      // The account lock makes thread limits durable across replicas too.
      // Skips and ambiguous sends spend their slot: never draft repeatedly.
      const attempts = await tx.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN r.author_id = ? THEN 1 ELSE 0 END) AS by_author
        FROM xpost_posts sent JOIN xpost_reply_targets r ON r.post_id = sent.id
        WHERE sent.x_user_id = ? AND sent.kind = 'reply' AND r.root_tweet_id = ?`)
        .get(p.replyAuthorId!, p.xUserId, p.replyRootTweetId!) as { total: unknown; by_author: unknown };
      if (num(attempts.total) >= 2 || num(attempts.by_author) >= 1) return null;
      const id = await insertPost(tx, p);
      if (id === null) return null;
      await tx.prepare(`INSERT INTO xpost_reply_targets (post_id, reply_to_tweet_id, root_tweet_id, author_id) VALUES (?, ?, ?, ?)`)
        .run(id, p.replyToTweetId!, p.replyRootTweetId!, p.replyAuthorId!);
      return id;
    });
  }
  if (p.kind === "answer") {
    if (!validReplyIds(p) || p.replyToTweetId !== p.replyRootTweetId || p.dedupeKey !== `answer:${p.xUserId}:${p.replyToTweetId}` || p.replyAuthorId === p.xUserId) return null;
    return db.tx(async (tx) => {
      const current = await tx.prepare(`UPDATE xpost_accounts SET updated_at_ms = updated_at_ms
        WHERE tenant = ? AND x_user_id = ? AND posting_enabled = 1 AND status = 'ok' AND consent_x_user_id = x_user_id`)
        .run(tenantKey(p.tenant), p.xUserId);
      if (current.changes !== 1 || !(await repliesEnabledFor(tx, p.tenant, p.xUserId)) ||
          await repliesOptedOut(tx, p.xUserId, p.replyAuthorId!)) return null;
      // ONE PERSON, A FEW ANSWERS A DAY (ANSWERS_PER_AUTHOR), whatever happened
      // to them: two accounts tagging each other cannot become an endless
      // conversation.
      // THE COUNT IS TAKEN UNDER A LOCK ON THE X ACCOUNT AND THE PERSON. The
      // account row above is the owner's: two owners connected to one X
      // account lock two rows, and could both count one answer and both
      // write a third. This upsert row-locks one xpost_meta row per X account
      // and author until commit on Postgres (sqlite has one writer), so the
      // second waits, then counts the first's answer.
      await tx.prepare(`INSERT INTO xpost_meta (k, n, v, updated_at_ms) VALUES (?, 0, NULL, ?)
        ON CONFLICT (k) DO UPDATE SET updated_at_ms = excluded.updated_at_ms`)
        .run(answerAuthorKey(p.xUserId, p.replyAuthorId!), int(p.nowMs));
      if (await answersToAuthor(tx, p.xUserId, p.replyAuthorId!, p.nowMs) >= ANSWERS_PER_AUTHOR) return null;
      // The general 200-post memory can roll over in a few busy days. Under
      // the same author lock, prevent two replicas or two owners sharing an
      // account from scheduling the identical small-talk line for a week.
      // Failed sends may exist on X; cancellation and deliberate skips do not.
      if (p.smalltalk === true && p.status !== "skipped" && p.body.trim() !== "") {
        const duplicate = await tx.prepare(`SELECT sent.id FROM xpost_posts sent
          JOIN xpost_reply_targets r ON r.post_id = sent.id
          WHERE sent.x_user_id = ? AND sent.kind = 'answer' AND r.author_id = ?
            AND sent.status IN ('scheduled', 'sending', 'posted', 'failed')
            AND COALESCE(sent.sent_at_ms, sent.created_at_ms) >= ?
            AND LOWER(TRIM(sent.body)) = ? LIMIT 1`)
          .get(p.xUserId, p.replyAuthorId!, int(p.nowMs - SMALLTALK_WORD_WINDOW_MS), p.body.trim().toLowerCase());
        if (duplicate) return null;
      }
      const id = await insertPost(tx, p);
      if (id === null) return null;
      await tx.prepare(`INSERT INTO xpost_reply_targets (post_id, reply_to_tweet_id, root_tweet_id, author_id) VALUES (?, ?, ?, ?)`)
        .run(id, p.replyToTweetId!, p.replyRootTweetId!, p.replyAuthorId!);
      return id;
    });
  }
  if (p.replyToTweetId || p.replyRootTweetId || p.replyAuthorId) return null;
  return insertPost(db, p);
}

/**
 * Answers to one person per rolling day, including skips and uncertain sends:
 * six (the owner's decision, 2026-10-12, up from two), so someone who replies
 * to an answer can carry on a short conversation, and two accounts tagging
 * each other still cannot become an endless one. Counted under the per-person
 * lock in schedulePost, whichever owner on the X account writes it.
 */
export const ANSWERS_PER_AUTHOR = 6;
const ANSWER_AUTHOR_WINDOW_MS = 24 * 60 * 60_000;
const SMALLTALK_WORD_WINDOW_MS = 7 * ANSWER_AUTHOR_WINDOW_MS;

/** Per-person public answer memory, independent of the busy account's latest 200 posts. */
export async function smalltalkBodiesToAuthor(db: Db, xUserId: string, authorId: string, nowMs: number): Promise<string[]> {
  const rows = await db.prepare(`SELECT sent.body FROM xpost_posts sent
    JOIN xpost_reply_targets r ON r.post_id = sent.id
    WHERE sent.x_user_id = ? AND sent.kind = 'answer' AND r.author_id = ?
      AND sent.status IN ('scheduled', 'sending', 'posted', 'failed')
      AND COALESCE(sent.sent_at_ms, sent.created_at_ms) >= ? AND sent.body <> ''
    ORDER BY COALESCE(sent.sent_at_ms, sent.created_at_ms) DESC, sent.id DESC LIMIT 256`)
    .all(xUserId, authorId, int(nowMs - SMALLTALK_WORD_WINDOW_MS)) as { body: string }[];
  return rows.map((row) => row.body);
}

/** Answers this X account wrote to one person in the rolling day before `nowMs`, whatever became of them. */
async function answersToAuthor(db: Db, xUserId: string, authorId: string, nowMs: number): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n
    FROM xpost_posts sent JOIN xpost_reply_targets r ON r.post_id = sent.id
    WHERE sent.x_user_id = ? AND sent.kind = 'answer' AND r.author_id = ? AND sent.created_at_ms >= ?`)
    .get(xUserId, authorId, int(nowMs - ANSWER_AUTHOR_WINDOW_MS)) as { n: unknown };
  return num(row.n);
}

/**
 * HAS THIS PERSON HAD THEIR ANSWERS FOR THE DAY? A read without the lock, so
 * the answer path can pass over their tag before it spends a lookup or a
 * model call on a draft schedulePost would refuse, and go on to the next
 * person's. schedulePost still counts again, under the lock, and decides.
 */
export async function answerAuthorSpent(db: Db, xUserId: string, authorId: string, nowMs: number): Promise<boolean> {
  return (await answersToAuthor(db, xUserId, authorId, nowMs)) >= ANSWERS_PER_AUTHOR;
}

/**
 * ANSWERS DRAFTED AND STILL WAITING TO GO OUT on this X account, drafted
 * since `sinceMs`. The day's answer allowance is taken at send time, so the
 * answer path counts these against it too: a draft that could not take the
 * day's allowance would be one the model was paid for and nobody sees.
 */
export async function answersWaiting(db: Db, xUserId: string, sinceMs: number): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM xpost_posts
    WHERE x_user_id = ? AND created_at_ms >= ? AND kind = 'answer' AND status = 'scheduled'`)
    .get(xUserId, int(sinceMs)) as { n: unknown };
  return num(row.n);
}

/** The xpost_meta row an answer's per-person count is taken under: one per posting X account and author. */
export function answerAuthorKey(xUserId: string, authorId: string): string {
  return `answer-author:${xUserId}:${authorId}`;
}

async function insertPost(db: Db, p: NewPost): Promise<number | null> {
  const row = (await db
    .prepare(
      `INSERT INTO xpost_posts (
         tenant, x_user_id, kind, dedupe_key, body, coin, decision_id, status, reason,
         created_at_ms, due_at_ms, sent_at_ms, tweet_id, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
    )
    .get(
      tenantKey(p.tenant),
      p.xUserId,
      p.kind,
      p.dedupeKey,
      p.body,
      p.coin ?? null,
      p.decisionId ?? null,
      p.status ?? "scheduled",
      p.reason ?? null,
      int(p.nowMs),
      int(p.dueAtMs),
      int(p.nowMs),
    )) as { id: unknown } | undefined;
  return row ? num(row.id) : null;
}

/** The status a dedupe key was written with, or null when it is unused. */
export async function keyStatus(db: Db, dedupeKey: string): Promise<XPostStatus | null> {
  const row = (await db.prepare(`SELECT status FROM xpost_posts WHERE dedupe_key = ?`).get(dedupeKey)) as
    | { status: unknown }
    | undefined;
  if (!row) return null;
  return (STATUSES.has(String(row.status)) ? row.status : "failed") as XPostStatus;
}

/**
 * CLAIM A POST FOR SENDING: scheduled → sending, conditionally. True for
 * exactly one caller. Nothing may call X for a post it did not claim.
 */
export async function claimPost(db: Db, id: number, nowMs: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE xpost_posts SET status = 'sending', updated_at_ms = ? WHERE id = ? AND status = 'scheduled'
      AND NOT EXISTS (
        SELECT 1 FROM xpost_accounts a WHERE a.tenant = xpost_posts.tenant
          AND ((xpost_posts.kind IN ('buy', 'recap') AND a.post_buys = 0) OR (xpost_posts.kind = 'casual' AND a.post_casual = 0))
      )`)
    .run(int(nowMs), int(id));
  return r.changes === 1;
}

/** Before a first send or a definite-refusal retry, honor an intervening kind-off change. */
export async function cancelDisabledKind(db: Db, id: number, nowMs: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE xpost_posts SET status = 'cancelled', reason = 'kind-off', updated_at_ms = ?
    WHERE id = ? AND status = 'sending' AND (reason = 'kind-off' OR EXISTS (
      SELECT 1 FROM xpost_accounts a WHERE a.tenant = xpost_posts.tenant
        AND ((xpost_posts.kind IN ('buy', 'recap') AND a.post_buys = 0) OR (xpost_posts.kind = 'casual' AND a.post_casual = 0))
    ))`).run(int(nowMs), int(id));
  return result.changes === 1;
}

/** X created it. */
export async function markPosted(db: Db, id: number, tweetId: string, nowMs: number): Promise<void> {
  await db
    .prepare(
      `UPDATE xpost_posts SET status = 'posted', tweet_id = ?, sent_at_ms = ?, reason = NULL, updated_at_ms = ?
        WHERE id = ? AND status = 'sending'`,
    )
    .run(tweetId, int(nowMs), int(nowMs), int(id));
}

/** A claimed post that will never be sent. `reason` is an operator code. */
export async function markFailed(db: Db, id: number, reason: string, nowMs: number): Promise<void> {
  await db
    .prepare(`UPDATE xpost_posts SET status = 'failed', reason = ?, updated_at_ms = ? WHERE id = ? AND status = 'sending'`)
    .run(reason, int(nowMs), int(id));
}

/**
 * X REFUSED BEFORE CREATING ANYTHING (a 429, credits, a refresh that did not
 * land): back to scheduled, due again at `dueAtMs`. Never for an ambiguous
 * answer.
 *
 * ONLY WHILE THE ACCOUNT STILL POSTS FOR THAT X USER, under a consent given
 * before the post was drafted. Switching off, disconnecting and a revoke
 * cancel only `scheduled` rows; a post in flight at that moment is `sending`
 * and was left alone. Put back to `scheduled` regardless, it would sit as a
 * live draft while posting is off — and go out if the owner switched on again
 * before it came due, which the owner's "off" was meant to prevent. Such a
 * post is cancelled ("account-off") instead. A kind turned off while sending
 * is marked `kind-off` by setPrefs without changing its claim. That mark also
 * prevents retry after the owner turns the kind back on. True when put back.
 */
export async function reschedulePost(db: Db, id: number, dueAtMs: number, nowMs: number): Promise<boolean> {
  return db.tx(async (tx) => {
    const back = await tx
      .prepare(
        `UPDATE xpost_posts SET status = 'scheduled', due_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND status = 'sending'
            AND (reason IS NULL OR reason <> 'kind-off')
            AND EXISTS (
              SELECT 1 FROM xpost_accounts a
               WHERE a.tenant = xpost_posts.tenant AND a.x_user_id = xpost_posts.x_user_id
                 AND a.posting_enabled = 1 AND a.status = 'ok' AND a.consent_x_user_id = a.x_user_id
                 AND a.consent_at_ms <= xpost_posts.created_at_ms
                 AND (xpost_posts.kind <> 'buy' OR a.post_buys = 1)
                 AND (xpost_posts.kind <> 'casual' OR a.post_casual = 1)
            )
            AND (kind NOT IN ('reply', 'answer') OR EXISTS (
              SELECT 1 FROM xpost_reply_targets r JOIN xpost_reply_accounts c ON c.tenant = xpost_posts.tenant
              WHERE r.post_id = xpost_posts.id AND c.x_user_id = xpost_posts.x_user_id
                AND c.consent_at_ms <= xpost_posts.created_at_ms
                AND NOT EXISTS (SELECT 1 FROM xpost_reply_optouts o
                  WHERE o.x_user_id = xpost_posts.x_user_id AND o.author_id = r.author_id)
            ))`,
      )
      .run(int(dueAtMs), int(nowMs), int(id));
    if (back.changes === 1) return true;
    await tx
      .prepare(`UPDATE xpost_posts SET status = 'cancelled',
        reason = CASE WHEN reason = 'kind-off' THEN reason ELSE 'account-off' END,
        updated_at_ms = ? WHERE id = ? AND status = 'sending'`)
      .run(int(nowMs), int(id));
    return false;
  });
}

/** A scheduled post that will not go out (stale, the owner's night ran past it…). */
export async function skipScheduled(db: Db, id: number, reason: string, nowMs: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE xpost_posts SET status = 'skipped', reason = ?, updated_at_ms = ? WHERE id = ? AND status = 'scheduled'`)
    .run(reason, int(nowMs), int(id));
  return r.changes === 1;
}

/**
 * A SCHEDULED POST WHOSE ACCOUNT MOVED ON — gone, switched off, or a different
 * X account now. The web cancels drafts on each of those as it happens; this
 * is the orchestrator's backstop for a draft written in the same instant.
 * Conditional, like every transition out of scheduled.
 */
export async function cancelPost(db: Db, id: number, reason: string, nowMs: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE xpost_posts SET status = 'cancelled', reason = ?, updated_at_ms = ? WHERE id = ? AND status = 'scheduled'`)
    .run(reason, int(nowMs), int(id));
  return r.changes === 1;
}

/**
 * NOT YET: a scheduled post moved later (the three-hour gap, found at send
 * time). Conditional on still being scheduled, like every change to one.
 */
export async function deferPost(db: Db, id: number, dueAtMs: number, nowMs: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE xpost_posts SET due_at_ms = ?, updated_at_ms = ? WHERE id = ? AND status = 'scheduled'`)
    .run(int(dueAtMs), int(nowMs), int(id));
  return r.changes === 1;
}

/**
 * THE OWNER'S SKIP. Only their own post, and only while it is still
 * scheduled: a post already claimed for sending cannot be half-skipped.
 */
export async function ownerCancel(db: Db, tenant: string, id: number, nowMs: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE xpost_posts SET status = 'cancelled', reason = 'owner', updated_at_ms = ?
        WHERE id = ? AND tenant = ? AND status = 'scheduled'`,
    )
    .run(int(nowMs), int(id), tenantKey(tenant));
  return r.changes === 1;
}

async function cancelScheduledIn(db: Db, tenant: string, nowMs: number, reason: string): Promise<number> {
  const r = await db
    .prepare(
      `UPDATE xpost_posts SET status = 'cancelled', reason = ?, updated_at_ms = ?
        WHERE tenant = ? AND status = 'scheduled'`,
    )
    .run(reason, int(nowMs), tenantKey(tenant));
  return r.changes;
}

/** Cancel every drafted post of one owner. */
export function cancelScheduled(db: Db, tenant: string, nowMs: number, reason: string): Promise<number> {
  return cancelScheduledIn(db, tenant, nowMs, reason);
}

/**
 * Scheduled posts of these owners whose time has come, oldest due first — one
 * page of them. `after` is the last row of the page before (keyset paging on
 * due time, then id), so a caller can look past the posts at the head that
 * only wait (owners asleep) instead of being blocked by them.
 */
export async function duePosts(
  db: Db,
  tenants: readonly string[],
  nowMs: number,
  limit = 50,
  after: { dueAtMs: number; id: number } | null = null,
): Promise<XPost[]> {
  const keys = [...new Set(tenants.map(tenantKey).filter((t) => t !== ""))];
  if (keys.length === 0) return [];
  const page = after ? "AND (due_at_ms > ? OR (due_at_ms = ? AND id > ?))" : "";
  const cursor = after ? [int(after.dueAtMs), int(after.dueAtMs), int(after.id)] : [];
  const rows = (await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM xpost_posts
        WHERE status = 'scheduled' AND due_at_ms <= ? AND tenant IN (${keys.map(() => "?").join(", ")})
          ${page}
        ORDER BY due_at_ms, id
        LIMIT ?`,
    )
    .all(int(nowMs), ...keys, ...cursor, int(Math.max(1, Math.min(500, limit))))) as PostRow[];
  return rows.map(postOf);
}

/**
 * A CLAIM THAT OUTLIVED ITS PROCESS. A `sending` row older than the cutoff
 * belonged to a pass that crashed or was redeployed mid-call: whether X created
 * the post is unknown, so it is failed as "interrupted" and NEVER sent again.
 */
export async function failInterrupted(db: Db, olderThanMs: number, nowMs: number): Promise<number> {
  const r = await db
    .prepare(
      `UPDATE xpost_posts SET status = 'failed', reason = 'interrupted', updated_at_ms = ?
        WHERE status = 'sending' AND updated_at_ms < ?`,
    )
    .run(int(nowMs), int(olderThanMs));
  return r.changes;
}

/** One owner's posts since `sinceMs`, newest first: what the planner weighs and Settings shows. */
export async function postsOf(db: Db, tenant: string, sinceMs: number, limit = 100): Promise<XPost[]> {
  const rows = (await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM xpost_posts
        WHERE tenant = ? AND created_at_ms >= ?
        ORDER BY created_at_ms DESC, id DESC
        LIMIT ?`,
    )
    .all(tenantKey(tenant), int(sinceMs), int(Math.max(1, Math.min(500, limit))))) as PostRow[];
  return rows.map(postOf);
}

/**
 * WHEN ONE X ACCOUNT LAST POSTED something other than a hello — from any owner
 * posting on it — or null. What went out (its sent time), and what may have
 * (an uncertain answer, a crashed claim, our own fault after the call: the
 * time it ended). Only posts drafted since `sinceMs` are looked at. The send
 * side's three-hour gap is kept against this.
 */
export async function lastOutAt(db: Db, xUserId: string, sinceMs: number): Promise<number | null> {
  const row = (await db
    .prepare(
      `SELECT MAX(CASE WHEN status = 'posted' THEN sent_at_ms ELSE updated_at_ms END) AS at FROM xpost_posts
        WHERE x_user_id = ? AND created_at_ms >= ? AND kind NOT IN ('intro', 'answer')
          AND (status = 'posted' OR (status = 'failed' AND reason IN ('uncertain', 'interrupted', 'fault')))`,
    )
    .get(String(xUserId), int(sinceMs))) as { at: unknown } | undefined;
  return row && row.at !== null && row.at !== undefined ? num(row.at) : null;
}

/**
 * ONE X ACCOUNT'S POSTS since `sinceMs`, newest first — from every owner that
 * posts on it. What the cadence weighs: one X account connected to two owners
 * (one person with two wallets) is still one timeline, with one day's cap, one
 * three-hour gap and one coin fold, not two.
 */
export async function postsOfXUser(db: Db, xUserId: string, sinceMs: number, limit = 100): Promise<XPost[]> {
  const rows = (await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM xpost_posts
        WHERE x_user_id = ? AND created_at_ms >= ?
        ORDER BY created_at_ms DESC, id DESC
        LIMIT ?`,
    )
    .all(String(xUserId), int(sinceMs), int(Math.max(1, Math.min(500, limit))))) as PostRow[];
  return rows.map(postOf);
}

/**
 * ONE OWNER'S RECAP ROWS SINCE `sinceMs`, any status (planner.ts PlanInput
 * .recaps): what each covered (its `coin`, recapCoverOf) and when it went
 * out. Read apart from postsOfXUser, whose few hundred newest rows a day of
 * answers can fill and push a recap out of (review of the recap branch,
 * 2026-10-14). At most a hundred: one every three hours fits many times over.
 */
export async function recapPostsOf(db: Db, tenant: string, sinceMs: number): Promise<XPost[]> {
  const rows = (await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM xpost_posts
        WHERE tenant = ? AND kind = 'recap' AND created_at_ms >= ?
        ORDER BY created_at_ms DESC, id DESC
        LIMIT 100`,
    )
    .all(tenantKey(tenant), int(sinceMs))) as PostRow[];
  return rows.map(postOf);
}

/**
 * THE POSTS A CONVERSATION ON THIS X ACCOUNT MAY BE ROOTED AT: the tweet ids
 * of its own posted top-level posts (an intro, a casual post, a buy, a sale
 * or a recap; never a reply or an answer, which are themselves replies), newest
 * first, at most `limit`. A tag that replies inside a thread is answered only
 * when the thread is rooted at one of these (replies.ts tagCandidate).
 */
export async function ownRootTweetIds(db: Db, xUserId: string, limit = 2000): Promise<Set<string>> {
  const rows = (await db
    .prepare(
      `SELECT tweet_id FROM xpost_posts
        WHERE x_user_id = ? AND status = 'posted' AND tweet_id IS NOT NULL AND kind IN ('intro', 'casual', 'buy', 'sell', 'recap')
        ORDER BY created_at_ms DESC, id DESC
        LIMIT ?`,
    )
    .all(String(xUserId), int(Math.max(1, Math.min(5000, limit))))) as { tweet_id: unknown }[];
  return new Set(rows.map((r) => String(r.tweet_id ?? "")).filter((t) => t !== ""));
}

/**
 * THE CONVERSATIONS THIS X ACCOUNT IS IN, AND WHO IT ANSWERED THERE (the
 * owner's decision, 2026-10-12: whoever replies to it or quotes it is giving
 * consent). What tagCandidate (replies.ts) answers a reply or a quote by:
 *
 *   - `roots`: its own posted top-level posts (ownRootTweetIds);
 *   - `posts`: those, and every answer or comment reply it posted (kind
 *     answer or reply, status posted, with a tweet id): its own words, which
 *     a follow-up or a quote may sit under;
 *   - `answered`: each tag or comment one of those posted answers replied
 *     to, by its author: the person's own earlier post that this account
 *     read, judged answerable and answered. A conversation rooted at one is
 *     one it is in; a person's reply to their own such post is a follow-up.
 *
 * Only what X surely published counts (posted rows): a draft, a skip, a
 * failed or uncertain send was never seen under anyone's post. Bounded like
 * ownRootTweetIds: at most `limit` top-level posts and `limit` answers and
 * replies, newest first; a reply under an older one is no reply this account
 * can vouch for, and goes unanswered.
 *
 * NOR ANYTHING UNDER A POST OF ITS OWN THAT `shut` REFUSES (red-team review
 * of 1ed46625, 2026-10-12). Under its own sherwood-1 model line ("the new
 * sherwood-1 is what they've got in the oven"), "can i buy it yet?", "should
 * i buy some before it's done?" and "wen moon" got code's decline or mood
 * line, "mum's the word on the rest" reading as Merrymen confirming a
 * sherwood-1 token. A posted tweet whose body `shut` refuses (the caller's
 * screen: orchestrator-xpost.ts passes sherwood in any form) is in none of
 * the three: a reply or a quote under it, or under the tag it answered, is
 * answered by nothing, and a conversation rooted at it is no conversation of
 * its own.
 *
 * AND WHAT A FOLLOW-UP THERE SITS UNDER (red-team review of 1ed46625,
 * 2026-10-12). A follow-up lost the coin its conversation was about: under
 * its decline to "should i buy $SCAM?", "what have you been buying lately?"
 * was handed its PEPE buys and "yes, bought it earlier" went out, and "how
 * are you?" was drafted as "doing great, this one looks solid to me". Code
 * never stores what a tag said, so it stores what kind of exchange each
 * answer was (`ANSWER_PLAIN_THREAD` on the answer's row), and:
 *
 *   - `plain`: what a follow-up may sit under as plain chat: its own intro
 *     and casual posts, and each answer marked plain (a greeting, or banter
 *     handed nothing, in a thread that was itself plain), with the tag it
 *     answered;
 *   - `trade`: its own buy and sell posts, under which the coin is its own
 *     public buy; and an intro or casual post that names a coin it bought
 *     (the caller's `trade` screen, red-team review of daaae961).
 *
 * Anything else in `posts` or `answered` (a decline, its mood, a market
 * line, a coin's answer, an answer told its buys, a comment reply on a buy
 * post, any answer from before the mark) is closed: a follow-up under it is
 * answered with a greeting, a thanks or nothing (orchestrator-xpost.ts
 * writeAnswer).
 *
 *   - `done`: each small-talk answer that ended its thread
 *     (ANSWER_THREAD_DONE), with the tag it answered: nothing at all is
 *     answered under either, not even a greeting (2026-10-18).
 *
 *   - `small`: each of its own plain-thread answers (ANSWER_PLAIN_THREAD: a
 *     greeting, a thanks, banter or how it is, the first exchange of a plain
 *     thread), by its tweet, to the tag it answered (2026-10-19). Only its
 *     answers, never the tags: a confused reply is read only directly under
 *     one (replies.ts confusedWords), and what's hot or the market is
 *     answered under one only in a thread rooted at that same tag
 *     (orchestrator-xpost.ts tradeMarket).
 */
export interface OwnThreads {
  roots: Set<string>;
  posts: Set<string>;
  answered: Map<string, string>;
  plain: Set<string>;
  trade: Set<string>;
  done: Set<string>;
  small: Map<string, string>;
}

/**
 * AN ANSWER A FOLLOW-UP MAY BE CHATTED UNDER, by its row's `coin` (which no
 * answer otherwise uses but ANSWER_LOOKED_UP): a greeting, a thanks or
 * banter, handed nothing and told none of its buys, under a tag that was
 * itself top level or under one of its own plain posts (orchestrator-xpost.ts
 * writeAnswer). Absent: closed.
 */
export const ANSWER_PLAIN_THREAD = "plain-thread";

/**
 * SMALL TALK THAT ENDED ITS THREAD (2026-10-18), by its row's `coin`: a
 * greeting, a thanks, banter, its mood or a decline answered under one of
 * its plain-thread answers, under its own buy, sale, recap or market post,
 * or under any closed answer. Nothing is answered under it, or under the tag
 * it answered (OwnThreads.done), so small talk is at most two of its answers
 * deep in any thread, and a greeting under a closed answer is answered once.
 */
export const ANSWER_THREAD_DONE = "thread-done";

/**
 * `trade`: the caller's screen for an intro or casual post that is about a
 * coin it bought (orchestrator-xpost.ts passes its buys' names, red-team
 * review of daaae961): such a post sits with its buy and sell posts, never in
 * `plain`. `closed`: the caller's screen for a casual post that talks about
 * a coin or the market at all (red-team review of daaae961): in neither, so
 * a reply under it or a quote of it is answered with a greeting or nothing.
 * Its hello is what it is, and stays plain.
 */
export async function ownThreadTweets(db: Db, xUserId: string, limit = 2000, shut: (body: string) => boolean = () => false,
  trade: (body: string) => boolean = () => false, closed: (body: string) => boolean = () => false): Promise<OwnThreads> {
  const max = int(Math.max(1, Math.min(5000, limit)));
  const tops = (await db
    .prepare(
      `SELECT tweet_id, body, kind FROM xpost_posts
        WHERE x_user_id = ? AND status = 'posted' AND tweet_id IS NOT NULL AND kind IN ('intro', 'casual', 'buy', 'sell', 'recap')
        ORDER BY created_at_ms DESC, id DESC
        LIMIT ?`,
    )
    .all(String(xUserId), max)) as { tweet_id: unknown; body: unknown; kind: unknown }[];
  const roots = new Set<string>(), plain = new Set<string>(), traded = new Set<string>(), done = new Set<string>();
  for (const r of tops) {
    const tweet = String(r.tweet_id ?? "");
    if (tweet === "" || shut(String(r.body ?? ""))) continue;
    roots.add(tweet);
    // A recap names the coins it traded, as a buy or sale post does: a reply under it is a reply under its trades.
    const own = r.kind === "buy" || r.kind === "sell" || r.kind === "recap";
    if (r.kind === "casual" && closed(String(r.body ?? ""))) continue;
    (own || trade(String(r.body ?? "")) ? traded : plain).add(tweet);
  }
  const rows = (await db
    .prepare(
      `SELECT p.tweet_id AS tweet_id, p.body AS body, p.kind AS kind, p.coin AS coin, r.reply_to_tweet_id AS reply_to_tweet_id, r.author_id AS author_id
        FROM xpost_posts p JOIN xpost_reply_targets r ON r.post_id = p.id
        WHERE p.x_user_id = ? AND p.status = 'posted' AND p.tweet_id IS NOT NULL AND p.kind IN ('answer', 'reply')
        ORDER BY p.created_at_ms DESC, p.id DESC
        LIMIT ?`,
    )
    .all(String(xUserId), max)) as { tweet_id: unknown; body: unknown; kind: unknown; coin: unknown; reply_to_tweet_id: unknown; author_id: unknown }[];
  const posts = new Set(roots);
  const answered = new Map<string, string>();
  const small = new Map<string, string>();
  for (const r of rows) {
    const tweet = String(r.tweet_id ?? ""), to = String(r.reply_to_tweet_id ?? ""), author = String(r.author_id ?? "");
    if (shut(String(r.body ?? ""))) continue;
    if (tweet !== "") posts.add(tweet);
    if (to !== "" && author !== "" && !answered.has(to)) answered.set(to, author);
    if (r.kind === "answer" && r.coin === ANSWER_PLAIN_THREAD) {
      if (tweet !== "") plain.add(tweet);
      if (to !== "") plain.add(to);
      if (tweet !== "" && to !== "") small.set(tweet, to);
    }
    if (r.kind === "answer" && r.coin === ANSWER_THREAD_DONE) {
      if (tweet !== "") done.add(tweet);
      if (to !== "") done.add(to);
    }
  }
  return { roots, posts, answered, plain, trade: traded, done, small };
}

/**
 * EVERY X ACCOUNT THE FLEET POSTS FROM (2026-10-18): each tenant's connected
 * X user and the one its owner consented for, whatever its status. An active
 * agent never answers any of them, so two of the fleet's agents can never
 * talk to each other in a loop on X. Bounded, as every read here is.
 */
export async function fleetXUserIds(db: Db, candidates?: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  // Bound the caller's mention batch, not the fleet. Truncating the account
  // table let agents outside its first page answer each other indefinitely.
  const ids = candidates === undefined ? null : [...new Set(candidates.filter((id) => /^\d+$/.test(id)))];
  if (ids?.length === 0) return out;
  const batches = ids === null ? [null] : Array.from({ length: Math.ceil(ids.length / 200) }, (_, i) => ids.slice(i * 200, (i + 1) * 200));
  for (const batch of batches) {
    const placeholders = batch?.map(() => "?").join(",");
    const where = batch ? ` WHERE x_user_id IN (${placeholders}) OR consent_x_user_id IN (${placeholders})` : "";
    const rows = await db.prepare(`SELECT x_user_id, consent_x_user_id FROM xpost_accounts${where}`)
      .all(...(batch ? [...batch, ...batch] : [])) as { x_user_id: unknown; consent_x_user_id: unknown }[];
    for (const r of rows) for (const id of [r.x_user_id, r.consent_x_user_id]) if (typeof id === "string" && id !== "") out.add(id);
  }
  return out;
}

/**
 * EVERY INTRO ONE OWNER EVER WROTE FOR ONE X ACCOUNT, oldest first, any status
 * and any age — the first hello's key and each redraft's. Whether the hello
 * has been dealt with is a fact about the account's whole history, not about
 * the last few days the planner otherwise weighs.
 */
export async function introPostsOf(db: Db, tenant: string, xUserId: string): Promise<XPost[]> {
  const rows = (await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM xpost_posts
        WHERE tenant = ? AND x_user_id = ? AND kind = 'intro'
        ORDER BY created_at_ms, id
        LIMIT 100`,
    )
    .all(tenantKey(tenant), String(xUserId))) as PostRow[];
  return rows.map(postOf);
}

/**
 * AN ANSWER THAT CARRIED SOMETHING LOOKED UP, by data and not by its words
 * (final review, 2026-10-12): its row's `coin`, which no answer otherwise
 * uses. Research for a tag a stranger asked (an index read, Fomo's talk, a
 * flow band, a creator's claim) is true only of that coin and that moment;
 * the model may say it without any source word ("thin liquidity and holders
 * bunched up"), so it is never handed on — not as what it already said, not
 * as a casual post's theme, and not as a recent post a prompt is shown
 * (ownRecentBodies). The gate still sees it, so nothing repeats it.
 */
export const ANSWER_LOOKED_UP = "looked-up";

/**
 * Bodies that went out, or are about to, since `sinceMs`, newest first —
 * every account's when `tenant` is null. What a new draft must not repeat: its
 * own account's history, and the fleet's (X: never "identical or substantially
 * similar content across multiple accounts").
 *
 * `posted` narrows it to what X surely published: what an agent may say it
 * already said. A draft still waiting may yet be skipped by its owner, so it
 * is something not to echo, never something said.
 *
 * `exceptLookedUp` leaves out every answer that carried something looked up
 * (ANSWER_LOOKED_UP): what may be handed on to another prompt, never what a
 * draft is gated against.
 */
export async function recentBodies(db: Db, opts: {
  tenant: string | null; sinceMs: number; limit: number; posted?: boolean; exceptLookedUp?: boolean;
  /** Only these kinds (a closed list, never caller text). Absent: every kind. */
  kinds?: readonly XPostKind[];
}): Promise<string[]> {
  const lim = int(Math.max(1, Math.min(2000, opts.limit)));
  const statuses = opts.posted ? "('posted')" : "('scheduled', 'sending', 'posted')";
  // Spelled out for NULL: an answer with no mark is handed on, one with the mark never.
  const looked = (opts.exceptLookedUp ? `AND (kind <> 'answer' OR coin IS NULL OR coin <> '${ANSWER_LOOKED_UP}')` : "")
    + (opts.kinds ? ` AND kind IN (${opts.kinds.filter((k) => (XPOST_KINDS as readonly string[]).includes(k)).map((k) => `'${k}'`).join(", ") || "''"})` : "");
  const rows = (opts.tenant === null
    ? await db
        .prepare(
          `SELECT body FROM xpost_posts
            WHERE status IN ${statuses} AND created_at_ms >= ? ${looked}
            ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
        )
        .all(int(opts.sinceMs), lim)
    : await db
        .prepare(
          `SELECT body FROM xpost_posts
            WHERE tenant = ? AND status IN ${statuses} AND created_at_ms >= ? ${looked}
            ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
        )
        .all(tenantKey(opts.tenant), int(opts.sinceMs), lim)) as { body: unknown }[];
  return rows.map((r) => String(r.body ?? "")).filter((b) => b !== "");
}

/**
 * ONE OWNER'S RECENT BODIES, read once, twice over: `all` (recentBodies,
 * scheduled, sending or posted), what each draft is gated against so it never
 * repeats one; and `shown`, the same less every answer that carried
 * something looked up (ANSWER_LOOKED_UP), what a prompt may be shown as its
 * recent posts. Newest first.
 */
export async function ownRecentBodies(db: Db, opts: { tenant: string; sinceMs: number; limit: number }): Promise<{ all: string[]; shown: string[]; timeline: { body: string; kind: XPostKind }[] }> {
  const lim = int(Math.max(1, Math.min(2000, opts.limit)));
  const rows = (await db
    .prepare(
      `SELECT body, kind, coin FROM xpost_posts
        WHERE tenant = ? AND status IN ('scheduled', 'sending', 'posted') AND created_at_ms >= ?
        ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
    )
    .all(tenantKey(opts.tenant), int(opts.sinceMs), lim)) as { body: unknown; kind: unknown; coin: unknown }[];
  // Replies keep their existing repeat-memory bound, but cannot displace the
  // timeline's own latest posts from the prompt or same-opener window.
  const timelineRows = (await db.prepare(`SELECT body, kind FROM xpost_posts
    WHERE tenant = ? AND status IN ('scheduled', 'sending', 'posted') AND created_at_ms >= ?
      AND kind IN ('buy', 'sell', 'recap', 'casual')
    ORDER BY created_at_ms DESC, id DESC LIMIT ?`).all(tenantKey(opts.tenant), int(opts.sinceMs), lim)) as { body: unknown; kind: unknown }[];
  const timeline = timelineRows.map((r) => ({ body: String(r.body ?? ""), kind: r.kind as XPostKind })).filter((r) => r.body !== "");
  const all: string[] = [], shown: string[] = [];
  for (const r of rows) {
    const body = String(r.body ?? "");
    if (body === "") continue;
    all.push(body);
    if (!(r.kind === "answer" && r.coin === ANSWER_LOOKED_UP)) shown.push(body);
  }
  return { all, shown, timeline };
}

const X_ID = /^\d{1,25}$/;
function validReplyIds(p: Pick<NewPost, "replyToTweetId" | "replyRootTweetId" | "replyAuthorId">): boolean {
  return [p.replyToTweetId, p.replyRootTweetId, p.replyAuthorId].every((v) => typeof v === "string" && X_ID.test(v));
}

export interface ReplyTarget { replyToTweetId: string; replyRootTweetId: string; replyAuthorId: string }

/** Read the durable target, consent and parent again immediately before sending. */
export async function replyTargetFor(db: Db, post: Pick<XPost, "id" | "tenant" | "xUserId">): Promise<ReplyTarget | null> {
  const row = await db.prepare(`SELECT r.reply_to_tweet_id, r.root_tweet_id, r.author_id
    FROM xpost_reply_targets r JOIN xpost_posts p ON p.id = r.post_id
    JOIN xpost_accounts a ON a.tenant = p.tenant
    JOIN xpost_reply_accounts c ON c.tenant = p.tenant
    WHERE p.id = ? AND p.tenant = ? AND p.x_user_id = ? AND p.kind IN ('reply', 'answer')
      AND p.status IN ('scheduled', 'sending') AND a.x_user_id = p.x_user_id
      AND a.posting_enabled = 1 AND a.status = 'ok' AND a.consent_x_user_id = a.x_user_id
      AND a.consent_at_ms <= p.created_at_ms AND c.x_user_id = p.x_user_id AND c.consent_at_ms <= p.created_at_ms
      AND r.author_id <> p.x_user_id
      AND ((p.kind = 'reply' AND p.dedupe_key = 'reply:' || p.x_user_id || ':' || r.reply_to_tweet_id
        AND EXISTS (SELECT 1 FROM xpost_posts parent WHERE parent.tenant = p.tenant AND parent.x_user_id = p.x_user_id
          AND parent.kind = 'buy' AND parent.status = 'posted' AND parent.tweet_id = r.root_tweet_id))
        OR (p.kind = 'answer' AND p.dedupe_key = 'answer:' || p.x_user_id || ':' || r.reply_to_tweet_id
          AND r.root_tweet_id = r.reply_to_tweet_id))
      AND NOT EXISTS (SELECT 1 FROM xpost_reply_optouts o WHERE o.x_user_id = p.x_user_id AND o.author_id = r.author_id)`)
    .get(int(post.id), tenantKey(post.tenant), post.xUserId) as
    { reply_to_tweet_id: string; root_tweet_id: string; author_id: string } | undefined;
  if (!row) return null;
  const target = { replyToTweetId: row.reply_to_tweet_id, replyRootTweetId: row.root_tweet_id, replyAuthorId: row.author_id };
  return validReplyIds(target) ? target : null;
}

// ── meta ────────────────────────────────────────────────────────────────────

/**
 * TAKE ONE FROM A DAILY ALLOWANCE, atomically: true while the counter under
 * `key` is below `limit` (and it is bumped), false once it is not. The key
 * carries the day, so a new day is a new counter. The conditional DO UPDATE
 * means two replicas cannot both take the last one. Optional durable send history
 * seeds an introduced counter and can raise, never lower, existing reservations.
 */
export async function takeAllowance(db: Db, key: string, limit: number, nowMs: number, initialUsed = 0): Promise<boolean> {
  if (!(limit > 0) || !Number.isSafeInteger(initialUsed) || initialUsed < 0 || initialUsed >= int(limit)) return false;
  const row = (await db
    .prepare(
      `INSERT INTO xpost_meta (k, n, v, updated_at_ms) VALUES (?, ?, NULL, ?)
       ON CONFLICT (k) DO UPDATE SET
         n = CASE WHEN xpost_meta.n < excluded.n THEN excluded.n ELSE xpost_meta.n + 1 END,
         updated_at_ms = excluded.updated_at_ms
       WHERE xpost_meta.n < ?
       RETURNING n`,
    )
    .get(key, initialUsed + 1, int(nowMs), int(limit))) as { n: unknown } | undefined;
  return row !== undefined;
}

/**
 * Reserve an owner's daily allowance using the preference stored now. The
 * account row is locked before reading its limit, in the same order as
 * setPrefs, so a concurrent save cannot be missed by a cached pass snapshot.
 * Count even without a chosen limit: lowering it later still includes earlier
 * sends. The caller separately reserves the shared X account's server limit,
 * and returns this reservation only when the post certainly did not happen.
 */
export async function takeOwnerAllowance(db: Db, tenant: string, dayKey: string, serverLimit: number, nowMs: number, initialUsed = 0): Promise<boolean> {
  if (!(serverLimit >= 1)) return false;
  return db.tx(async (tx) => {
    const account = await tx.prepare(`UPDATE xpost_accounts SET per_day = per_day
      WHERE tenant = ? AND posting_enabled = 1 AND status = 'ok' AND consent_x_user_id = x_user_id
      RETURNING per_day`).get(tenantKey(tenant)) as { per_day: unknown } | undefined;
    if (!account) return false;
    const limit = Math.min(int(serverLimit), ownerPerDay(account.per_day) ?? int(serverLimit));
    // Seed a newly introduced counter from durable send history before taking
    // a unit. ON CONFLICT leaves an already-existing reservation count alone.
    await tx.prepare(`INSERT INTO xpost_meta (k, n, v, updated_at_ms) VALUES (?, ?, NULL, ?)
      ON CONFLICT (k) DO NOTHING`).run(dayKey, Math.max(0, int(initialUsed)), int(nowMs));
    return takeAllowance(tx, dayKey, limit, nowMs);
  });
}

/**
 * Send times used to seed an owner's first daily counter after an upgrade.
 * Old drafts can be sent today, so filter by send/claim time, not creation.
 * Include uncertain outcomes conservatively, just as a live reservation is
 * retained when the caller cannot establish that X created nothing.
 */
export async function ownerSendTimesSince(db: Db, tenant: string, sinceMs: number): Promise<number[]> {
  const rows = await db.prepare(`SELECT CASE WHEN status = 'posted' THEN sent_at_ms ELSE updated_at_ms END AS at_ms
    FROM xpost_posts WHERE tenant = ? AND kind <> 'answer' AND (
      (status = 'posted' AND sent_at_ms >= ?)
      OR ((status = 'sending' OR (status = 'failed' AND reason IN ('uncertain', 'interrupted', 'fault'))) AND updated_at_ms >= ?)
    )`).all(tenantKey(tenant), int(sinceMs), int(sinceMs)) as { at_ms: unknown }[];
  return rows.map((row) => num(row.at_ms));
}

/** Account-wide trade sends, including uncertain attempts, for a new trade counter. */
export async function tradeSendTimesSince(db: Db, xUserId: string, sinceMs: number): Promise<number[]> {
  const rows = await db.prepare(`SELECT CASE WHEN status = 'posted' THEN sent_at_ms ELSE updated_at_ms END AS at_ms
    FROM xpost_posts WHERE x_user_id = ? AND kind IN ('buy', 'sell', 'recap') AND (
      (status = 'posted' AND sent_at_ms >= ?)
      OR ((status = 'sending' OR (status = 'failed' AND reason IN ('uncertain', 'interrupted', 'fault'))) AND updated_at_ms >= ?)
    )`).all(xUserId, int(sinceMs), int(sinceMs)) as { at_ms: unknown }[];
  return rows.map((row) => num(row.at_ms));
}

/**
 * GIVE ONE BACK to a daily allowance taken for something that then certainly
 * did not happen (X refused before creating anything). Never below zero.
 */
export async function returnAllowance(db: Db, key: string, nowMs: number): Promise<void> {
  await db.prepare(`UPDATE xpost_meta SET n = n - 1, updated_at_ms = ? WHERE k = ? AND n > 0`).run(int(nowMs), key);
}

/**
 * A SPAN OF ONE X ACCOUNT'S CLOCK, CLAIMED ATOMICALLY — the three-hour gap
 * between two posts, the three-day fold on one coin.
 *
 * The planner spaces an account's posts from its history, and the send loop
 * checks that history again — but a read followed by a send is not a lock.
 * Two orchestrator replicas holding two owners who connected the same X
 * account can both read "nothing went out in three hours" and both post. So
 * the last send is also a row, `xpost_meta.n` under `key`, and taking the next
 * span is one conditional upsert: it succeeds only while the span last taken
 * is at least `spanMs` old, which Postgres decides under the row's lock and
 * sqlite under its write lock. Exactly one of two racing claims wins.
 *
 * Returns what to put back if the send then never happened (`prev`, the span
 * before ours, or null when there was none), or — when the claim lost — when
 * the span last taken began, so the post can wait until it has passed.
 */
export async function claimSpan(
  db: Db,
  key: string,
  atMs: number,
  spanMs: number,
): Promise<{ ok: true; prev: number | null } | { ok: false; lastAtMs: number }> {
  // Read only for the release: the conditional upsert below is the decision.
  const before = await readMeta(db, key);
  const row = (await db
    .prepare(
      `INSERT INTO xpost_meta (k, n, v, updated_at_ms) VALUES (?, ?, NULL, ?)
       ON CONFLICT (k) DO UPDATE SET n = excluded.n, updated_at_ms = excluded.updated_at_ms
       WHERE xpost_meta.n <= ?
       RETURNING n`,
    )
    .get(key, int(atMs), int(atMs), int(atMs - spanMs))) as { n: unknown } | undefined;
  if (row) return { ok: true, prev: before ? before.n : null };
  return { ok: false, lastAtMs: (await readMeta(db, key))?.n ?? atMs };
}

/**
 * Give a span back when the post it was taken for never reached X — only if it
 * is still ours, so a later claim by another replica is never undone.
 */
export async function releaseSpan(db: Db, key: string, claimedAtMs: number, prev: number | null, nowMs: number): Promise<void> {
  if (prev === null) {
    await db.prepare(`DELETE FROM xpost_meta WHERE k = ? AND n = ?`).run(key, int(claimedAtMs));
  } else {
    await db.prepare(`UPDATE xpost_meta SET n = ?, updated_at_ms = ? WHERE k = ? AND n = ?`).run(int(prev), int(nowMs), key, int(claimedAtMs));
  }
}

export async function readMeta(db: Db, key: string): Promise<{ n: number; v: string | null } | null> {
  const row = (await db.prepare(`SELECT n, v FROM xpost_meta WHERE k = ?`).get(key)) as { n: unknown; v: unknown } | undefined;
  return row ? { n: num(row.n), v: strOrNull(row.v) } : null;
}

export async function writeMeta(db: Db, key: string, v: string | null, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO xpost_meta (k, n, v, updated_at_ms) VALUES (?, 0, ?, ?)
       ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at_ms = excluded.updated_at_ms`,
    )
    .run(key, v, int(nowMs));
}
