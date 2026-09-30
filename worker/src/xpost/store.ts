/**
 * THE X-POSTING TABLES, AND THE ONLY CODE THAT READS OR WRITES THEM.
 *
 * docs/x-posting.md is the contract. Four tables, all `xpost_*`:
 *
 *   xpost_accounts — the connected X account per owner: its immutable X user
 *     id, the handle it had when it was connected, the sealed tokens, and the
 *     owner's consent — bound to the user id they were shown.
 *   xpost_pending  — an OAuth connect in flight, single use, fifteen minutes.
 *   xpost_posts    — every post: drafted and scheduled, claimed, sent, skipped,
 *     cancelled or failed. The UNIQUE dedupe_key and the conditional claim are
 *     what make a post at-most-once across crashes and replicas.
 *   xpost_meta     — fleet counters: the model's daily budget, the day's post
 *     allowance, the fleet's pauses.
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
  updated_at_ms INTEGER NOT NULL
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
  kind TEXT NOT NULL,                      -- intro or casual or buy
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
CREATE TABLE IF NOT EXISTS xpost_meta (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  v TEXT,
  updated_at_ms INTEGER NOT NULL
);
`;

/** Distinct from every other advisory key in the repo (the room's is 1_297_692_090). */
const SCHEMA_LOCK = 1_297_692_110;

const schemaReady = new WeakMap<Db, Promise<void>>();

/**
 * Create the tables once per Db for the life of the process. Memoised on the
 * Db and dropped on failure so a briefly unreachable database is retried. On
 * Postgres the DDL runs under an advisory lock because web and orchestrator
 * boot together and two concurrent CREATE TABLE IF NOT EXISTS can collide.
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
    } else {
      await db.exec(XPOST_SCHEMA);
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
  "consent_at_ms, consent_x_user_id, tz, status, updated_at_ms";

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
    if (changedAccount) await cancelScheduledIn(tx, tenant, a.nowMs, "account-changed");
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
    return r.changes === 1;
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

export type XPostKind = "intro" | "casual" | "buy";
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
  updatedAtMs: number;
}

const POST_COLUMNS =
  "id, tenant, x_user_id, kind, dedupe_key, body, coin, decision_id, status, reason, created_at_ms, due_at_ms, " +
  "sent_at_ms, tweet_id, updated_at_ms";

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
  updated_at_ms: unknown;
}

const KINDS: ReadonlySet<string> = new Set(["intro", "casual", "buy"]);
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
  dueAtMs: number;
  nowMs: number;
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
    .prepare(`UPDATE xpost_posts SET status = 'sending', updated_at_ms = ? WHERE id = ? AND status = 'scheduled'`)
    .run(int(nowMs), int(id));
  return r.changes === 1;
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
 * post is cancelled ("account-off") instead. True when it was put back.
 */
export async function reschedulePost(db: Db, id: number, dueAtMs: number, nowMs: number): Promise<boolean> {
  return db.tx(async (tx) => {
    const back = await tx
      .prepare(
        `UPDATE xpost_posts SET status = 'scheduled', due_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND status = 'sending'
            AND EXISTS (
              SELECT 1 FROM xpost_accounts a
               WHERE a.tenant = xpost_posts.tenant AND a.x_user_id = xpost_posts.x_user_id
                 AND a.posting_enabled = 1 AND a.status = 'ok' AND a.consent_x_user_id = a.x_user_id
                 AND a.consent_at_ms <= xpost_posts.created_at_ms
            )`,
      )
      .run(int(dueAtMs), int(nowMs), int(id));
    if (back.changes === 1) return true;
    await tx
      .prepare(`UPDATE xpost_posts SET status = 'cancelled', reason = 'account-off', updated_at_ms = ? WHERE id = ? AND status = 'sending'`)
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
        WHERE x_user_id = ? AND created_at_ms >= ? AND kind <> 'intro'
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
 * Bodies that went out, or are about to, since `sinceMs`, newest first —
 * every account's when `tenant` is null. What a new draft must not repeat: its
 * own account's history, and the fleet's (X: never "identical or substantially
 * similar content across multiple accounts").
 */
export async function recentBodies(db: Db, opts: { tenant: string | null; sinceMs: number; limit: number }): Promise<string[]> {
  const lim = int(Math.max(1, Math.min(2000, opts.limit)));
  const rows = (opts.tenant === null
    ? await db
        .prepare(
          `SELECT body FROM xpost_posts
            WHERE status IN ('scheduled', 'sending', 'posted') AND created_at_ms >= ?
            ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
        )
        .all(int(opts.sinceMs), lim)
    : await db
        .prepare(
          `SELECT body FROM xpost_posts
            WHERE tenant = ? AND status IN ('scheduled', 'sending', 'posted') AND created_at_ms >= ?
            ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
        )
        .all(tenantKey(opts.tenant), int(opts.sinceMs), lim)) as { body: unknown }[];
  return rows.map((r) => String(r.body ?? "")).filter((b) => b !== "");
}

// ── meta ────────────────────────────────────────────────────────────────────

/**
 * TAKE ONE FROM A DAILY ALLOWANCE, atomically: true while the counter under
 * `key` is below `limit` (and it is bumped), false once it is not. The key
 * carries the day, so a new day is a new counter. The conditional DO UPDATE
 * means two replicas cannot both take the last one.
 */
export async function takeAllowance(db: Db, key: string, limit: number, nowMs: number): Promise<boolean> {
  if (!(limit > 0)) return false;
  const row = (await db
    .prepare(
      `INSERT INTO xpost_meta (k, n, v, updated_at_ms) VALUES (?, 1, NULL, ?)
       ON CONFLICT (k) DO UPDATE SET n = xpost_meta.n + 1, updated_at_ms = excluded.updated_at_ms
       WHERE xpost_meta.n < ?
       RETURNING n`,
    )
    .get(key, int(nowMs), int(limit))) as { n: unknown } | undefined;
  return row !== undefined;
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
