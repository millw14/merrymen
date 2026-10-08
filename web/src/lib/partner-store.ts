/**
 * Durable owner consent and conversations for the partner API.
 *
 * A partner's external user id never identifies a wallet by itself. Only bind(),
 * called after Merrymen authenticates the owner, can establish that link. The
 * unique indexes and single-use token update are the authority across replicas.
 * Hosted deployments require shared Postgres; the local SQLite file is for
 * self-hosted use and tests, with the same transactions and constraints.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isHostedMode } from "@merrymen/core";
import { merrymenHome } from "@merrymen/home";
import { LockBusyError, makePgDb, withAdvisoryLock, wrapSqlite, type Db } from "../../../worker/src/db";

export type PartnerAddress = `0x${string}`;
export class PartnerStoreError extends Error {
  /** retryAfter: seconds after which the same request may simply be sent again. */
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) {
    super(message);
    this.name = "PartnerStoreError";
  }
}
export interface PartnerConnection {
  id: string;
  partnerId: string;
  partnerName: string;
  externalUserId: string;
  name: string;
  tenant: PartnerAddress | null;
  scopes: string[];
  status: "pending" | "linked" | "revoked";
  tokenHash: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  /** The owner-signed embedded activation that last completed on this connection. */
  activation?: { nonceHash: string; grantHash: string; at: number };
}
/** What identifies one signed embedded activation: its challenge nonce and the exact grant it authorized. */
export interface PartnerActivationProof { nonce: string; grantHash: string }
export interface PartnerCreate {
  partnerId: string;
  partnerName: string;
  externalUserId: string;
  name: string;
  scopes: string[];
}
export interface PartnerExchange {
  requestId: string;
  message: string;
  reply: string;
  command?: unknown;
  createdAt: number;
}
export interface PartnerMessage {
  role: "user" | "assistant";
  content: string;
  requestId: string;
  createdAt: number;
  command?: unknown;
}
export interface PartnerStore {
  create(input: PartnerCreate): Promise<{ connection: PartnerConnection; token: string | null; created: boolean }>;
  byId(partnerId: string, id: string): Promise<PartnerConnection | null>;
  byTenant(partnerId: string, tenant: PartnerAddress): Promise<PartnerConnection | null>;
  byToken(raw: string): Promise<PartnerConnection | null>;
  bind(raw: string, tenant: PartnerAddress, consentedScopes: string[]): Promise<PartnerConnection>;
  /** Internal only: caller has verified a fresh grant ownership proof. */
  bindAuthorized(id: string, partnerId: string, tenant: PartnerAddress, consentedScopes: string[]): Promise<PartnerConnection>;
  /** Internal only: after a verified activation has COMPLETED on a connection linked to this tenant. */
  recordActivation(id: string, partnerId: string, tenant: PartnerAddress, proof: PartnerActivationProof): Promise<PartnerConnection>;
  revokeByTenant(id: string, tenant: PartnerAddress): Promise<boolean>;
  revoke(partnerId: string, id: string): Promise<boolean>;
  list(partnerId: string): Promise<PartnerConnection[]>;
  consumeNonce(nonce: string, expiresAt: number): Promise<boolean>;
  readMessages(connectionId: string): Promise<PartnerMessage[]>;
  getExchange(connectionId: string, requestId: string): Promise<PartnerExchange | null>;
  appendExchange(connectionId: string, exchange: Omit<PartnerExchange, "createdAt">): Promise<{ created: boolean; exchange: PartnerExchange }>;
  /**
   * One holder at a time, across replicas. A caller waits (bounded, holding no
   * connection) and then gets <kind>_busy with retryAfter. Store calls inside
   * run on the lock's connection, and each write commits on its own: there is
   * no enclosing transaction to roll back.
   */
  withConversationLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T>;
  withEnrollmentLock<T>(tenant: PartnerAddress, fn: () => Promise<T>): Promise<T>;
}

export const ONBOARDING_TTL_SECONDS = 30 * 60;
export const PARTNER_HISTORY_EXCHANGES = 40;
type LockKind = "conversation" | "enrollment";
/**
 * How long a request waits for another holding its lock: a transport retry of a
 * chat still being generated, or two activations for one owner. The wait holds
 * no pooled connection, and both bounds sit well inside the gateway's 45-second
 * upstream timeout. Past it the answer is <kind>_busy with a retry hint.
 */
export const PARTNER_LOCK_WAIT_MS: Readonly<Record<LockKind, number>> = { conversation: 20_000, enrollment: 10_000 };
const LOCK_CLASS: Readonly<Record<LockKind, number>> = { conversation: 1_297_692_083, enrollment: 1_297_692_084 };
const BUSY_RETRY_AFTER_SECONDS = 2;
const NONCE_RETENTION_SECONDS = 10 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function bridgeSecret(): string {
  const value = process.env.MERRYMEN_PARTNER_BRIDGE_SECRET ?? "";
  if (value.length < 32) throw new Error("MERRYMEN_PARTNER_BRIDGE_SECRET must contain at least 32 characters");
  return value;
}

/** Reproducible on a lost create response; no recoverable token is stored. */
export function onboardingToken(connection: Pick<PartnerConnection, "id" | "expiresAt">, secret = bridgeSecret()): string {
  const payload = `${connection.id}.${connection.expiresAt}`;
  return `mmon_${payload}.${createHmac("sha256", secret).update(`partner-onboarding:${payload}`).digest("base64url")}`;
}

export const PARTNER_MESSAGE_MAX = 2000;
export const PARTNER_REPLY_MAX = 16_000;
export const PARTNER_COMMAND_MAX = 8000;
/** Multiline text keeps tabs and line breaks; every other C0 control is refused. */
const LINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const LINE_CONTROLS = new RegExp(LINE_CONTROL.source, "g");
const CONTROL = /[\u0000-\u001f]/;

/**
 * The store's text rule, exported so a caller can refuse before paying for work
 * the store would then reject. Well-formed too: a lone surrogate is not text,
 * JSON.stringify writes it as an escape that Postgres refuses in any json value,
 * and a stored one broke every list of its app.
 */
export function partnerText(value: unknown, max: number, multiline = false): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max && value.isWellFormed() && !(multiline ? LINE_CONTROL : CONTROL).test(value);
}
function textField(value: string, max: number, label: string, multiline = false): string {
  if (!partnerText(value, max, multiline)) throw new PartnerStoreError(400, "invalid_input", `invalid ${label}`);
  return value;
}

/**
 * A model reply made storable instead of refused: the model's output is not the
 * partner's input, so it must never come back as the partner's 400. Disallowed
 * controls are dropped (tabs and line breaks kept) and an over-long reply is cut
 * on a character boundary, marked with an ellipsis. A lone surrogate becomes
 * U+FFFD. "" when nothing is left.
 */
export function fitPartnerReply(reply: string): string {
  const clean = String(reply ?? "").toWellFormed().replace(LINE_CONTROLS, "").trim();
  if (clean.length <= PARTNER_REPLY_MAX) return clean;
  let end = PARTNER_REPLY_MAX - 1;
  // Never keep half of a surrogate pair: the stored JSON would carry a lone one.
  if (/[\ud800-\udbff]/.test(clean[end - 1])) end--;
  return `${clean.slice(0, end).trimEnd()}…`;
}
/** True when exactly this signed activation is the one recorded as completed on the connection. */
export function activatedBy(connection: PartnerConnection, proof: PartnerActivationProof): boolean {
  return !!connection.activation && connection.activation.nonceHash === hash(`enrollment:${proof.nonce}`) && connection.activation.grantHash === proof.grantHash;
}
/** A proposal the store would refuse as too large; the reply is kept without it. */
export function partnerCommandFits(command: unknown): boolean {
  return JSON.stringify(command ?? null).length <= PARTNER_COMMAND_MAX;
}
function scopeList(scopes: string[]): string[] {
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 32 || scopes.some(s => typeof s !== "string" || !/^[a-z][a-z0-9:_-]{0,63}$/.test(s))) {
    throw new PartnerStoreError(400, "invalid_scopes", "invalid consent scopes");
  }
  return [...new Set(scopes)].sort();
}
function address(tenant: PartnerAddress): PartnerAddress {
  if (!ADDRESS.test(tenant)) throw new PartnerStoreError(400, "invalid_tenant", "invalid authenticated tenant");
  return tenant.toLowerCase() as PartnerAddress;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS partner_connections (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  tenant TEXT,
  status TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  expires_at BIGINT NOT NULL,
  record_json TEXT NOT NULL,
  UNIQUE (partner_id, external_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_connections_linked_tenant
  ON partner_connections (partner_id, tenant) WHERE status = 'linked';
CREATE TABLE IF NOT EXISTS partner_used_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS partner_used_nonces_expiry ON partner_used_nonces (expires_at);
CREATE TABLE IF NOT EXISTS partner_exchanges (
  connection_id TEXT NOT NULL REFERENCES partner_connections(id),
  request_id TEXT NOT NULL,
  ordinal BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  exchange_json TEXT NOT NULL,
  PRIMARY KEY (connection_id, request_id)
);
CREATE INDEX IF NOT EXISTS partner_exchanges_history ON partner_exchanges (connection_id, ordinal);
`;

/** The external_user_id column of a revoked connection that has been reconnected; its record keeps the real one. */
const RETIRED = "\u001fretired:";
const retiredSlot = (id: string) => `${RETIRED}${id}`;
type JsonRow = { record_json: string };
type ExchangeRow = { exchange_json: string };
const connectionOf = (row: unknown): PartnerConnection | null => row ? JSON.parse((row as JsonRow).record_json) as PartnerConnection : null;
const exchangeOf = (row: unknown): PartnerExchange | null => row ? JSON.parse((row as ExchangeRow).exchange_json) as PartnerExchange : null;

/** Shared database implementation; the SQLite backend tests the production SQL. */
export class SqlPartnerStore implements PartnerStore {
  private ready: Promise<Db> | null = null;
  /** The connection a partner lock pinned (transaction: false), or the transaction running on it. */
  private context = new AsyncLocalStorage<{ db: Db; transaction: boolean }>();
  constructor(
    private connect: () => Promise<Db>,
    private dialect: "postgres" | "sqlite" = "postgres",
    private clock: () => number = nowSeconds,
    private secret: () => string = bridgeSecret,
    private waits: Readonly<Record<LockKind, number>> = PARTNER_LOCK_WAIT_MS,
  ) {}

  private database(): Promise<Db> {
    if (!this.ready) {
      this.ready = this.connect().then(async db => {
        await db.tx(async tx => {
          if (this.dialect === "postgres") await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(1_297_692_081);
          await tx.exec(SCHEMA);
        });
        return db;
      }).catch(error => { this.ready = null; throw error; });
    }
    return this.ready;
  }
  private async transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const active = this.context.getStore();
    if (active?.transaction) return fn(active.db);
    // Under a partner lock the transaction runs on the lock's own connection.
    const db = active?.db ?? await this.database();
    return db.tx(tx => this.context.run({ db: tx, transaction: true }, () => fn(tx)));
  }
  private async reader(): Promise<Db> { return this.context.getStore()?.db ?? this.database(); }
  private lockSuffix(): string { return this.dialect === "postgres" ? " FOR UPDATE" : ""; }
  private async save(db: Db, c: PartnerConnection): Promise<void> {
    await db.prepare(`UPDATE partner_connections SET tenant = ?, status = ?, token_hash = ?, expires_at = ?, record_json = ? WHERE id = ?`)
      .run(c.tenant, c.status, c.tokenHash, c.expiresAt, JSON.stringify(c), c.id);
  }
  private async scoped(partnerId: string, id: string, db: Db, lock = false): Promise<PartnerConnection | null> {
    return connectionOf(await db.prepare(`SELECT record_json FROM partner_connections WHERE partner_id = ? AND id = ?${lock ? this.lockSuffix() : ""}`).get(partnerId, id));
  }

  async create(input: PartnerCreate) {
    const checked = {
      partnerId: textField(input.partnerId, 128, "partner id"),
      partnerName: textField(input.partnerName, 100, "partner name"),
      externalUserId: textField(input.externalUserId, 256, "external user id"),
      name: textField(input.name, 64, "agent name"),
      scopes: scopeList(input.scopes),
    };
    return this.transaction(async db => {
      // Serialize the absent-row case too, including concurrent creates on two replicas.
      if (this.dialect === "postgres") {
        const key = createHash("sha256").update(JSON.stringify([checked.partnerId, checked.externalUserId])).digest().readInt32BE();
        await db.prepare("SELECT pg_advisory_xact_lock(?, ?)").get(1_297_692_082, key);
      }
      let c = connectionOf(await db.prepare(`SELECT record_json FROM partner_connections WHERE partner_id = ? AND external_user_id = ?${this.lockSuffix()}`).get(checked.partnerId, checked.externalUserId));
      if (c?.status === "revoked") {
        // A disconnected user may connect again, but never through the revoked
        // connection: returning it made a disconnect permanent. Its id keeps
        // answering disconnected, and its history, owner binding and consent
        // stay with it. The fresh authorization gets a NEW id, so nothing keyed
        // by the old one can be read or reused, and needs full owner consent and
        // activation again. The old row gives up its (app, user) slot in the
        // existing UNIQUE constraint (no migration) for a value no real external
        // id can collide with: textField refuses control characters.
        await db.prepare("UPDATE partner_connections SET external_user_id = ? WHERE id = ?").run(retiredSlot(c.id), c.id);
        c = null;
      }
      const created = !c;
      const now = this.clock();
      if (!c) {
        c = { ...checked, id: `pa_${randomBytes(16).toString("hex")}`, tenant: null, status: "pending", tokenHash: null,
          expiresAt: now + ONBOARDING_TTL_SECONDS, createdAt: now, updatedAt: now };
        c.tokenHash = hash(onboardingToken(c, this.secret()));
        await db.prepare(`INSERT INTO partner_connections (id, partner_id, external_user_id, tenant, status, token_hash, expires_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(c.id, c.partnerId, c.externalUserId, c.tenant, c.status, c.tokenHash, c.expiresAt, JSON.stringify(c));
      } else if (c.status === "pending" && c.expiresAt <= now) {
        c = { ...c, name: checked.name, partnerName: checked.partnerName, scopes: checked.scopes, expiresAt: now + ONBOARDING_TTL_SECONDS, updatedAt: now };
        c.tokenHash = hash(onboardingToken(c, this.secret()));
        await this.save(db, c);
      }
      const token = c.status === "pending" ? onboardingToken(c, this.secret()) : null;
      if (token && hash(token) !== c.tokenHash) throw new Error("pending authorization was issued with a different server secret; retry after its expiry");
      return { connection: c, token, created };
    });
  }
  async byId(partnerId: string, id: string) { return this.scoped(partnerId, id, await this.reader()); }
  async byTenant(partnerId: string, tenant: PartnerAddress) {
    return connectionOf(await (await this.reader()).prepare("SELECT record_json FROM partner_connections WHERE partner_id = ? AND tenant = ? AND status = 'linked'").get(partnerId, address(tenant)));
  }
  async byToken(raw: string) {
    if (typeof raw !== "string" || raw.length < 32 || raw.length > 512) return null;
    const db = await this.reader();
    return connectionOf(await db.prepare("SELECT record_json FROM partner_connections WHERE token_hash = ? AND status = 'pending' AND expires_at > ?").get(hash(raw), this.clock()));
  }
  async bind(raw: string, tenant: PartnerAddress, consentedScopes: string[]) {
    const owner = address(tenant);
    const scopes = scopeList(consentedScopes);
    if (typeof raw !== "string" || raw.length < 32 || raw.length > 512) throw new PartnerStoreError(410, "authorization_expired", "authorization link is invalid or expired");
    return this.transaction(async db => {
      const c = connectionOf(await db.prepare(`SELECT record_json FROM partner_connections WHERE token_hash = ? AND status = 'pending' AND expires_at > ?${this.lockSuffix()}`).get(hash(raw), this.clock()));
      if (!c) throw new PartnerStoreError(410, "authorization_expired", "authorization link is invalid, expired, or already used");
      return this.link(db, c, owner, scopes);
    });
  }
  private async link(db: Db, c: PartnerConnection, owner: PartnerAddress, scopes: string[]): Promise<PartnerConnection> {
    if (scopes.some(scope => !c.scopes.includes(scope))) throw new PartnerStoreError(400, "invalid_scopes", "consent includes a scope this partner did not request");
    const next: PartnerConnection = { ...c, tenant: owner, scopes, status: "linked", tokenHash: null, updatedAt: this.clock() };
    try { await this.save(db, next); }
    catch (error) {
      if (/unique|duplicate/i.test(error instanceof Error ? error.message : String(error))) throw new PartnerStoreError(409, "wallet_already_linked", "this wallet is already linked to another user of this partner");
      throw error;
    }
    return next;
  }
  async bindAuthorized(id: string, partnerId: string, tenant: PartnerAddress, consentedScopes: string[]): Promise<PartnerConnection> {
    const owner = address(tenant);
    const scopes = scopeList(consentedScopes);
    return this.transaction(async db => {
      const c = await this.scoped(partnerId, id, db, true);
      if (!c) throw new PartnerStoreError(404, "not_found", "no such agent connection");
      if (c.status === "revoked") throw new PartnerStoreError(409, "connection_revoked", "this agent connection has been revoked");
      if (c.status === "linked") {
        if (c.tenant !== owner || JSON.stringify(c.scopes) !== JSON.stringify(scopes)) {
          throw new PartnerStoreError(409, "connection_already_linked", "this agent connection already has a different owner or consent");
        }
        return c;
      }
      return this.link(db, c, owner, scopes);
    });
  }
  async recordActivation(id: string, partnerId: string, tenant: PartnerAddress, proof: PartnerActivationProof): Promise<PartnerConnection> {
    const owner = address(tenant);
    if (typeof proof?.nonce !== "string" || typeof proof.grantHash !== "string") throw new PartnerStoreError(400, "invalid_input", "invalid activation proof");
    return this.transaction(async db => {
      const c = await this.scoped(partnerId, id, db, true);
      // Never on a revoked or re-owned connection: a recorded proof answers retries.
      if (!c || c.status !== "linked" || c.tenant !== owner) throw new PartnerStoreError(409, "connection_changed", "the agent connection changed during activation");
      const next: PartnerConnection = { ...c, activation: { nonceHash: hash(`enrollment:${proof.nonce}`), grantHash: proof.grantHash, at: this.clock() }, updatedAt: this.clock() };
      await this.save(db, next);
      return next;
    });
  }
  private async revokeWhere(id: string, field: "partner_id" | "tenant", value: string): Promise<boolean> {
    return this.transaction(async db => {
      const c = connectionOf(await db.prepare(`SELECT record_json FROM partner_connections WHERE id = ? AND ${field} = ?${this.lockSuffix()}`).get(id, value));
      if (!c) return false;
      if (c.status !== "revoked") await this.save(db, { ...c, status: "revoked", tokenHash: null, updatedAt: this.clock() });
      return true;
    });
  }
  async revokeByTenant(id: string, tenant: PartnerAddress) { return this.revokeWhere(id, "tenant", address(tenant)); }
  async revoke(partnerId: string, id: string) { return this.revokeWhere(id, "partner_id", partnerId); }
  async list(partnerId: string) {
    // Newest first, then id, one row per external user. Ordering by the random
    // ids alone made WHICH 100 a large app saw arbitrary, and oldest first hid
    // every new connection once an app had 100 older rows, which each
    // reconnect adds to. A retired row (revoked, and since replaced for its
    // user) is history: its id still answers disconnected on its own, but
    // listed it showed the same user twice.
    //
    // createdAt lives only in record_json, read there with no schema change. On
    // Postgres it is matched as text, not cast to json: rows stored before text
    // had to be well-formed may hold a lone surrogate escape, which json
    // refuses, and one such row failed the whole list. Only the top-level key
    // can match: inside a JSON string every quote is escaped.
    const createdAt = this.dialect === "postgres" ? `substring(record_json from '"createdAt":([0-9]+)')::bigint` : "json_extract(record_json, '$.createdAt')";
    return (await (await this.reader()).prepare(`SELECT record_json FROM partner_connections WHERE partner_id = ? AND external_user_id <> (? || id)
      ORDER BY ${createdAt} DESC NULLS LAST, id DESC LIMIT 100`).all(partnerId, RETIRED)).map(row => connectionOf(row)!);
  }
  async consumeNonce(nonce: string, expiresAt: number): Promise<boolean> {
    const now = this.clock();
    if (typeof nonce !== "string" || nonce.length < 16 || nonce.length > 256 || !Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
    return this.transaction(async db => {
      await db.prepare("DELETE FROM partner_used_nonces WHERE expires_at < ?").run(now - NONCE_RETENTION_SECONDS);
      return (await db.prepare("INSERT INTO partner_used_nonces (nonce_hash, expires_at) VALUES (?, ?) ON CONFLICT (nonce_hash) DO NOTHING").run(hash(nonce), expiresAt)).changes === 1;
    });
  }
  async readMessages(connectionId: string): Promise<PartnerMessage[]> {
    const rows = await (await this.reader()).prepare("SELECT exchange_json FROM partner_exchanges WHERE connection_id = ? ORDER BY ordinal DESC LIMIT ?").all(connectionId, PARTNER_HISTORY_EXCHANGES);
    return rows.reverse().flatMap(row => {
      const e = exchangeOf(row)!;
      return [
        { role: "user" as const, content: e.message, requestId: e.requestId, createdAt: e.createdAt },
        { role: "assistant" as const, content: e.reply, requestId: e.requestId, createdAt: e.createdAt, ...(e.command ? { command: e.command } : {}) },
      ];
    });
  }
  async getExchange(connectionId: string, requestId: string): Promise<PartnerExchange | null> {
    return exchangeOf(await (await this.reader()).prepare("SELECT exchange_json FROM partner_exchanges WHERE connection_id = ? AND request_id = ?").get(connectionId, requestId));
  }
  async appendExchange(connectionId: string, input: Omit<PartnerExchange, "createdAt">) {
    textField(input.requestId, 128, "request id");
    textField(input.message, PARTNER_MESSAGE_MAX, "message", true);
    textField(input.reply, PARTNER_REPLY_MAX, "reply", true);
    if (!partnerCommandFits(input.command)) throw new PartnerStoreError(400, "invalid_command", "command is too large");
    return this.transaction(async db => {
      const c = connectionOf(await db.prepare(`SELECT record_json FROM partner_connections WHERE id = ?${this.lockSuffix()}`).get(connectionId));
      if (!c || c.status !== "linked") throw new PartnerStoreError(409, "connection_inactive", "agent connection is not active");
      const existing = exchangeOf(await db.prepare("SELECT exchange_json FROM partner_exchanges WHERE connection_id = ? AND request_id = ?").get(connectionId, input.requestId));
      if (existing) {
        if (existing.message !== input.message) throw new PartnerStoreError(409, "idempotency_conflict", "request id was already used for a different message");
        return { created: false, exchange: existing };
      }
      const exchange: PartnerExchange = { ...input, createdAt: this.clock() };
      const latest = await db.prepare("SELECT MAX(ordinal) AS last FROM partner_exchanges WHERE connection_id = ?").get(connectionId) as { last: number | null };
      const ordinal = Number(latest.last ?? 0) + 1;
      await db.prepare("INSERT INTO partner_exchanges (connection_id, request_id, ordinal, created_at, exchange_json) VALUES (?, ?, ?, ?, ?)").run(connectionId, input.requestId, ordinal, exchange.createdAt, JSON.stringify(exchange));
      // Store only a bounded history. Request-id replay protection lasts for
      // those retained exchanges; the API documents that window explicitly.
      await db.prepare(`DELETE FROM partner_exchanges WHERE connection_id = ? AND request_id NOT IN (
        SELECT request_id FROM partner_exchanges WHERE connection_id = ? ORDER BY ordinal DESC LIMIT ?
      )`).run(connectionId, connectionId, PARTNER_HISTORY_EXCHANGES);
      return { created: true, exchange };
    });
  }
  async withConversationLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
    return this.withLock("conversation", connectionId, fn);
  }
  async withEnrollmentLock<T>(tenant: PartnerAddress, fn: () => Promise<T>): Promise<T> {
    return this.withLock("enrollment", address(tenant), fn);
  }
  /**
   * WAIT YOUR TURN, BOUNDED, WITHOUT HOLDING A CONNECTION WHILE YOU WAIT.
   *
   * The Postgres lock used to be TRIED once inside a transaction, so any overlap
   * failed at once: a chat retry got conversation_busy instead of the reply the
   * first request was about to save, and a second activation for an owner got
   * enrollment_busy after its single-use signature had been spent. Waiting
   * inside a transaction would hold a pooled connection per waiter instead.
   *
   * withAdvisoryLock queues callers in this process and retries a session lock
   * across replicas, holding a connection only while it holds the lock. Every
   * nested read and write runs on that one pinned connection (so ten holders
   * can never sit on every pool slot waiting for an eleventh), and each write
   * commits as its own short transaction: nothing holds a transaction open
   * through a model call, and a nonce consumed under the lock stays consumed
   * whatever fails after it. SQLite takes the same in-process queue.
   */
  private async withLock<T>(kind: LockKind, id: string, fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) throw new Error("nested partner locks are not supported");
    const key = createHash("sha256").update(id).digest().readInt32BE();
    let entered = false;
    try {
      return await withAdvisoryLock(await this.database(), LOCK_CLASS[kind], key, db => {
        entered = true;
        return this.context.run({ db, transaction: false }, fn);
      }, this.waits[kind]);
    } catch (error) {
      if (!entered && error instanceof LockBusyError) {
        throw new PartnerStoreError(409, `${kind}_busy`, `another ${kind} request is still in progress for this agent; retry shortly`, BUSY_RETRY_AFTER_SECONDS);
      }
      throw error;
    }
  }
}

export class FilePartnerStore extends SqlPartnerStore {
  private raw: DatabaseSync;
  constructor(home: string, clock: () => number = nowSeconds, secret: () => string = bridgeSecret, waits: Readonly<Record<LockKind, number>> = PARTNER_LOCK_WAIT_MS) {
    mkdirSync(home, { recursive: true });
    const raw = new DatabaseSync(join(home, "partner-connections.sqlite"));
    raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    super(async () => wrapSqlite(raw), "sqlite", clock, secret, waits);
    this.raw = raw;
  }
  close(): void { this.raw.close(); }
}

const stores = new Map<string, PartnerStore>();
export function getPartnerStore(): PartnerStore {
  const url = process.env.DATABASE_URL;
  if (!url && isHostedMode()) throw new Error("hosted partner connections require DATABASE_URL");
  const key = url ? `pg:${url}` : `file:${merrymenHome()}`;
  let store = stores.get(key);
  if (!store) {
    store = url ? new SqlPartnerStore(() => makePgDb(url)) : new FilePartnerStore(merrymenHome());
    stores.set(key, store);
  }
  return store;
}
