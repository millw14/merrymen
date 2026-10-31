/**
 * Shared paper-pilot admission. The environment is imported exactly once;
 * thereafter only durable records decide membership. Invites never override a
 * revocation. All capacity-changing writes take the same singleton row lock,
 * and commit their audit/usage receipt in the same transaction.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { makePgDb, rootDb, type Db } from "../db";

export const PERPS_PILOT_LIMIT = 100;
export const PERPS_PILOT_INVITE_MAX_TTL_MS = 30 * 24 * 60 * 60_000;
const WINDOW_MS = 60_000;
const ATTEMPT_LIMIT = 10;
const SCHEMA_LOCK = 1_297_692_150;
type Owner = `0x${string}`;
type Status = "allowed" | "revoked";
export interface PerpsPilotSnapshot { owners: readonly Owner[]; revision: number }
export interface PerpsPilotAdmission {
  owner: Owner; status: Status; source: "bootstrap" | "invite" | "admin";
  revision: number; updatedAt: number; actor: Owner | null;
}
export interface PerpsPilotInvite {
  id: string; createdAt: number; expiresAt: number; maxUses: number; uses: number;
  revokedAt: number | null; createdBy: Owner;
}
export interface PerpsPilotAudit {
  id: string; action: string; actor: Owner | null; owner: Owner | null;
  inviteId: string | null; at: number; revision: number;
}
export interface PerpsPilotListing {
  revision: number; limit: number; admissions: PerpsPilotAdmission[];
  invites: PerpsPilotInvite[]; audit: PerpsPilotAudit[];
}
export interface PerpsPilotRedeemResult {
  outcome: "admitted" | "already-admitted" | "invalid-invite" | "revoked" | "full" | "limited";
  revision: number; retryAfterSec?: number;
}
/** Trusted server callback: atomically turn stored entry settings off before admission. */
export type PerpsPilotBeforeAdmit = () => Promise<unknown>;
export interface PerpsPilotStore {
  snapshot(): Promise<PerpsPilotSnapshot>;
  /**
   * Serialize a final protected write with admission/revocation. The trusted
   * callback must not call this store recursively. Its independently committed
   * writes cannot be rolled back if this transaction subsequently fails.
   */
  withAdmission<T>(owner: string, action: () => Promise<T>): Promise<{ allowed: false } | { allowed: true; value: T }>;
  get(owner: string): Promise<{ owner: Owner; status: Status | "not-admitted"; revision: number; updatedAt: number | null }>;
  list(): Promise<PerpsPilotListing>;
  createInvite(args: { actor: string; maxUses: number; expiresAt: number }): Promise<{ code: string; invite: PerpsPilotInvite }>;
  revokeInvite(args: { actor: string; id: string }): Promise<{ revoked: boolean }>;
  setAdmission(args: { actor: string; owner: string; status: Status; expectedRevision: number; beforeAdmit?: PerpsPilotBeforeAdmit }): Promise<{
    outcome: "updated" | "unchanged" | "stale" | "full"; revision: number;
  }>;
  redeem(args: { owner: string; code: string; beforeAdmit?: PerpsPilotBeforeAdmit }): Promise<PerpsPilotRedeemResult>;
}

export const PERPS_PILOT_DDL = `
CREATE TABLE IF NOT EXISTS perps_pilot_cohort (
  id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 0),
  initialized_at INTEGER, bootstrap_digest TEXT
);
CREATE TABLE IF NOT EXISTS perps_pilot_admissions (
  owner TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('allowed','revoked')),
  source TEXT NOT NULL CHECK (source IN ('bootstrap','invite','admin')),
  revision INTEGER NOT NULL CHECK (revision >= 0), updated_at INTEGER NOT NULL, actor TEXT
);
CREATE INDEX IF NOT EXISTS perps_pilot_admissions_status ON perps_pilot_admissions(status, updated_at, owner);
CREATE TABLE IF NOT EXISTS perps_pilot_invites (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses), revoked_at INTEGER,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS perps_pilot_invites_created ON perps_pilot_invites(created_at, id);
CREATE TABLE IF NOT EXISTS perps_pilot_redemptions (
  invite_id TEXT NOT NULL REFERENCES perps_pilot_invites(id), owner TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL, PRIMARY KEY (invite_id, owner)
);
CREATE TABLE IF NOT EXISTS perps_pilot_attempts (
  owner TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL CHECK (attempts >= 0)
);
CREATE INDEX IF NOT EXISTS perps_pilot_attempts_expiry ON perps_pilot_attempts(window_start);
CREATE TABLE IF NOT EXISTS perps_pilot_audit (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, actor TEXT, owner TEXT, invite_id TEXT,
  at INTEGER NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0)
);
CREATE INDEX IF NOT EXISTS perps_pilot_audit_time ON perps_pilot_audit(at, id);
`;

function integer(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("Unreadable paper-pilot record.");
  if (typeof value === "string" && !/^\d+$/.test(value)) throw new Error("Unreadable paper-pilot record.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Unreadable paper-pilot record.");
  return parsed;
}
function ownerKey(value: string): Owner {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) throw new Error("Invalid paper-pilot owner.");
  return value.toLowerCase() as Owner;
}
function storedOwner(value: unknown): Owner {
  if (typeof value !== "string" || ownerKey(value) !== value) throw new Error("Unreadable paper-pilot owner.");
  return value as Owner;
}
function bootstrapOwners(raw: string | undefined): Owner[] {
  if (raw === undefined || raw.trim() === "") return [];
  const values = raw.split(",").map(value => value.trim());
  if (values.length > PERPS_PILOT_LIMIT) throw new Error("Paper-pilot bootstrap exceeds the cohort limit.");
  return [...new Set(values.map(ownerKey))].sort();
}
function codeHash(value: unknown): string | null {
  if (typeof value !== "string" || !/^mmp_[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const encoded = value.slice(4), bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== encoded) return null;
  return createHash("sha256").update(value).digest("hex");
}
function inviteId(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
    throw new Error("Invalid paper-pilot invite.");
  return value;
}
type Row = Record<string, unknown>;
function inviteFrom(row: Row): PerpsPilotInvite {
  const maxUses = integer(row.max_uses), uses = integer(row.uses);
  if (maxUses < 1 || maxUses > PERPS_PILOT_LIMIT || uses > maxUses) throw new Error("Unreadable paper-pilot invite.");
  const out = { id: inviteId(String(row.id)), createdAt: integer(row.created_at), expiresAt: integer(row.expires_at),
    maxUses, uses, revokedAt: row.revoked_at === null ? null : integer(row.revoked_at), createdBy: storedOwner(row.created_by) };
  if (out.expiresAt <= out.createdAt) throw new Error("Unreadable paper-pilot invite.");
  return out;
}
function admissionFrom(row: Row): PerpsPilotAdmission {
  if (row.status !== "allowed" && row.status !== "revoked") throw new Error("Unreadable paper-pilot status.");
  if (row.source !== "bootstrap" && row.source !== "invite" && row.source !== "admin") throw new Error("Unreadable paper-pilot source.");
  return { owner: storedOwner(row.owner), status: row.status, source: row.source, revision: integer(row.revision),
    updatedAt: integer(row.updated_at), actor: row.actor === null ? null : storedOwner(row.actor) };
}

const schemaReady = new WeakMap<Db, Promise<void>>();
async function lockSchema(tx: Db): Promise<void> {
  try { await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(SCHEMA_LOCK); }
  catch (error) { if (!/no such function: pg_advisory_xact_lock/i.test(String((error as Error)?.message))) throw error; }
}
async function boundedTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.tx(async tx => {
    try { await tx.exec("SET LOCAL statement_timeout = '2000ms'; SET LOCAL lock_timeout = '1000ms';"); }
    catch (error) { if (!/near "SET": syntax error/i.test(String((error as Error)?.message))) throw error; }
    return fn(tx);
  });
}
async function ensureSchema(db: Db): Promise<void> {
  const root = rootDb(db);
  const existing = schemaReady.get(root);
  if (existing) return existing;
  const ready = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await boundedTransaction(db, async tx => {
          await lockSchema(tx);
          await tx.exec(PERPS_PILOT_DDL);
          await tx.prepare("INSERT INTO perps_pilot_cohort(id,revision) VALUES(1,0) ON CONFLICT(id) DO NOTHING").run();
        });
        return;
      } catch (error) {
        if (attempt < 2 && ["23505", "42P07", "42710"].includes(String((error as { code?: unknown }).code))) continue;
        throw error;
      }
    }
  })().catch(error => { if (schemaReady.get(root) === ready) schemaReady.delete(root); throw error; });
  schemaReady.set(root, ready);
  return ready;
}

export class SqlPerpsPilotStore implements PerpsPilotStore {
  private ready: Promise<void> | null = null;
  constructor(private db: Db, private options: { bootstrapOwners?: () => string | undefined; now?: () => number } = {}) {}
  private now(): number { return integer((this.options.now ?? Date.now)()); }
  private async lock(tx: Db, initializing = false): Promise<number> {
    // PostgreSQL row lock and SQLite write lock, in the same order for every
    // mutation. Trusted cross-store callbacks must not acquire this cohort lock
    // recursively, and must keep their own lock order consistent.
    const changed = await tx.prepare("UPDATE perps_pilot_cohort SET revision=revision WHERE id=1").run();
    if (changed.changes !== 1) throw new Error("Paper-pilot cohort is unavailable.");
    const row = await tx.prepare("SELECT revision,initialized_at FROM perps_pilot_cohort WHERE id=1").get() as Row | undefined;
    if (!initializing || row?.initialized_at !== null) integer(row?.initialized_at);
    return integer(row?.revision);
  }
  private async bump(tx: Db): Promise<number> {
    await tx.prepare("UPDATE perps_pilot_cohort SET revision=revision+1 WHERE id=1").run();
    const row = await tx.prepare("SELECT revision FROM perps_pilot_cohort WHERE id=1").get() as Row | undefined;
    return integer(row?.revision);
  }
  private async audit(tx: Db, action: string, actor: Owner | null, owner: Owner | null, id: string | null, revision: number, at: number): Promise<void> {
    await tx.prepare("INSERT INTO perps_pilot_audit(id,action,actor,owner,invite_id,at,revision) VALUES(?,?,?,?,?,?,?)")
      .run(randomUUID(), action, actor, owner, id, at, revision);
  }
  private async initialize(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await ensureSchema(this.db);
        await boundedTransaction(this.db, async tx => {
          // Another replica's first-use DDL can lock the admission tables.
          // Take its schema lock BEFORE the cohort row, never the reverse.
          await lockSchema(tx);
          await this.lock(tx, true);
          const cohort = await tx.prepare("SELECT initialized_at FROM perps_pilot_cohort WHERE id=1").get() as Row;
          if (cohort.initialized_at !== null) { integer(cohort.initialized_at); return; }
          if (await tx.prepare("SELECT owner FROM perps_pilot_admissions LIMIT 1").get()) throw new Error("Uninitialized paper-pilot cohort contains membership records.");
          const owners = bootstrapOwners((this.options.bootstrapOwners ?? (() => process.env.MERRYMEN_PERPS_PAPER_TENANTS))());
          const revision = await this.bump(tx), at = this.now();
          for (const owner of owners) {
            await tx.prepare("INSERT INTO perps_pilot_admissions(owner,status,source,revision,updated_at,actor) VALUES(?,'allowed','bootstrap',?,?,NULL)")
              .run(owner, revision, at);
          }
          await tx.prepare("UPDATE perps_pilot_cohort SET initialized_at=?,bootstrap_digest=? WHERE id=1")
            .run(at, createHash("sha256").update(owners.join(",")).digest("hex"));
          await this.audit(tx, "bootstrap", null, null, null, revision, at);
        });
      })().catch(error => { this.ready = null; throw error; });
    }
    return this.ready;
  }
  private async locked<T>(fn: (tx: Db, revision: number) => Promise<T>): Promise<T> {
    await this.initialize();
    return boundedTransaction(this.db, async tx => fn(tx, await this.lock(tx)));
  }
  private async hasRoom(tx: Db): Promise<boolean> {
    const row = await tx.prepare("SELECT COUNT(*) AS n FROM perps_pilot_admissions WHERE status='allowed'").get() as Row;
    return integer(row.n) < PERPS_PILOT_LIMIT;
  }
  async snapshot(): Promise<PerpsPilotSnapshot> {
    await this.initialize();
    return boundedTransaction(this.db, tx => this.snapshotAt(tx));
  }
  private async snapshotAt(tx: Db): Promise<PerpsPilotSnapshot> {
    // One SQL statement gives a matching revision and owner set, even at READ
    // COMMITTED while a different replica changes membership.
    const rows = await tx.prepare(`SELECT c.revision,c.initialized_at,a.owner FROM perps_pilot_cohort c
      LEFT JOIN perps_pilot_admissions a ON a.status='allowed' WHERE c.id=1 AND c.initialized_at IS NOT NULL ORDER BY a.owner LIMIT 101`).all() as Row[];
    if (!rows.length || rows.length > PERPS_PILOT_LIMIT) throw new Error("Paper-pilot cohort is unavailable or exceeds its limit.");
    const revision = integer(rows[0]!.revision), owners: Owner[] = [];
    for (const row of rows) {
      integer(row.initialized_at);
      if (integer(row.revision) !== revision) throw new Error("Unreadable paper-pilot revision.");
      if (row.owner !== null) owners.push(storedOwner(row.owner));
    }
    return { owners, revision };
  }
  async withAdmission<T>(value: string, action: () => Promise<T>): Promise<{ allowed: false } | { allowed: true; value: T }> {
    const owner = ownerKey(value);
    return this.locked(async tx => {
      // Validate the complete bounded cohort as well as this owner, so corrupt
      // over-cap membership cannot authorize a protected mutation.
      if (!(await this.snapshotAt(tx)).owners.includes(owner)) return { allowed: false };
      return { allowed: true, value: await action() };
    });
  }
  async get(value: string) {
    const owner = ownerKey(value);
    await this.initialize();
    const row = await boundedTransaction(this.db, tx => tx.prepare(`SELECT c.revision,c.initialized_at,a.status,a.updated_at,
      (SELECT COUNT(*) FROM perps_pilot_admissions WHERE status='allowed') AS active_count FROM perps_pilot_cohort c
      LEFT JOIN perps_pilot_admissions a ON a.owner=? WHERE c.id=1 AND c.initialized_at IS NOT NULL`).get(owner)) as Row | undefined;
    if (!row || (row.status !== null && row.status !== "allowed" && row.status !== "revoked")) throw new Error("Unreadable paper-pilot admission.");
    integer(row.initialized_at);
    if (integer(row.active_count) > PERPS_PILOT_LIMIT) throw new Error("Paper-pilot cohort exceeds its limit.");
    return { owner, status: (row.status ?? "not-admitted") as Status | "not-admitted", revision: integer(row.revision),
      updatedAt: row.status === null ? null : integer(row.updated_at) };
  }
  async list(): Promise<PerpsPilotListing> {
    return this.locked(async (tx, revision) => {
      const active = await tx.prepare("SELECT * FROM perps_pilot_admissions WHERE status='allowed' ORDER BY owner LIMIT 101").all() as Row[];
      if (active.length > PERPS_PILOT_LIMIT) throw new Error("Paper-pilot cohort exceeds its limit.");
      const revoked = await tx.prepare("SELECT * FROM perps_pilot_admissions WHERE status='revoked' ORDER BY updated_at DESC,owner LIMIT 100").all() as Row[];
      const invites = await tx.prepare("SELECT * FROM perps_pilot_invites ORDER BY created_at DESC,id LIMIT 100").all() as Row[];
      const audit = await tx.prepare("SELECT * FROM perps_pilot_audit ORDER BY at DESC,id LIMIT 100").all() as Row[];
      return { revision, limit: PERPS_PILOT_LIMIT, admissions: [...active, ...revoked].map(admissionFrom), invites: invites.map(inviteFrom),
        audit: audit.map(row => ({ id: String(row.id), action: String(row.action), actor: row.actor === null ? null : storedOwner(row.actor),
          owner: row.owner === null ? null : storedOwner(row.owner), inviteId: row.invite_id === null ? null : String(row.invite_id),
          at: integer(row.at), revision: integer(row.revision) })) };
    });
  }
  async createInvite(args: { actor: string; maxUses: number; expiresAt: number }) {
    const actor = ownerKey(args.actor), maxUses = integer(args.maxUses), expiresAt = integer(args.expiresAt);
    if (maxUses < 1 || maxUses > PERPS_PILOT_LIMIT) throw new Error("Invalid paper-pilot invite use limit.");
    return this.locked(async (tx, revision) => {
      const at = this.now();
      if (expiresAt <= at || expiresAt > at + PERPS_PILOT_INVITE_MAX_TTL_MS) throw new Error("Invalid paper-pilot invite expiry.");
      const code = `mmp_${randomBytes(32).toString("base64url")}`, id = randomUUID();
      await tx.prepare("INSERT INTO perps_pilot_invites(id,code_hash,created_by,created_at,expires_at,max_uses,uses) VALUES(?,?,?,?,?,?,0)")
        .run(id, codeHash(code), actor, at, expiresAt, maxUses);
      await this.audit(tx, "invite-created", actor, null, id, revision, at);
      return { code, invite: { id, createdAt: at, expiresAt, maxUses, uses: 0, revokedAt: null, createdBy: actor } };
    });
  }
  async revokeInvite(args: { actor: string; id: string }) {
    const actor = ownerKey(args.actor), id = inviteId(args.id);
    return this.locked(async (tx, revision) => {
      const at = this.now();
      const result = await tx.prepare("UPDATE perps_pilot_invites SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(at, id);
      if (result.changes) await this.audit(tx, "invite-revoked", actor, null, id, revision, at);
      const row = await tx.prepare("SELECT revoked_at FROM perps_pilot_invites WHERE id=?").get(id) as Row | undefined;
      return { revoked: !!row && row.revoked_at !== null };
    });
  }
  async setAdmission(args: { actor: string; owner: string; status: Status; expectedRevision: number; beforeAdmit?: PerpsPilotBeforeAdmit }) {
    const actor = ownerKey(args.actor), owner = ownerKey(args.owner), expected = integer(args.expectedRevision);
    if (args.status !== "allowed" && args.status !== "revoked") throw new Error("Invalid paper-pilot status.");
    return this.locked(async (tx, revision) => {
      if (revision !== expected) return { outcome: "stale" as const, revision };
      const previous = await tx.prepare("SELECT status FROM perps_pilot_admissions WHERE owner=?").get(owner) as Row | undefined;
      if (previous?.status === args.status) return { outcome: "unchanged" as const, revision };
      if (args.status === "allowed" && !(await this.hasRoom(tx))) return { outcome: "full" as const, revision };
      if (args.status === "allowed") await args.beforeAdmit?.();
      const nextRevision = await this.bump(tx), at = this.now();
      await tx.prepare(`INSERT INTO perps_pilot_admissions(owner,status,source,revision,updated_at,actor) VALUES(?,?,'admin',?,?,?)
        ON CONFLICT(owner) DO UPDATE SET status=excluded.status,source=excluded.source,revision=excluded.revision,updated_at=excluded.updated_at,actor=excluded.actor`)
        .run(owner, args.status, nextRevision, at, actor);
      await this.audit(tx, `admission-${args.status}`, actor, owner, null, nextRevision, at);
      return { outcome: "updated" as const, revision: nextRevision };
    });
  }
  private async attempt(tx: Db, owner: Owner, at: number): Promise<number | null> {
    const row = await tx.prepare("SELECT window_start,attempts FROM perps_pilot_attempts WHERE owner=?").get(owner) as Row | undefined;
    if (row && integer(row.window_start) + WINDOW_MS > at) {
      if (integer(row.attempts) >= ATTEMPT_LIMIT) return Math.max(1, Math.ceil((integer(row.window_start) + WINDOW_MS - at) / 1000));
      await tx.prepare("UPDATE perps_pilot_attempts SET attempts=attempts+1 WHERE owner=?").run(owner);
    } else {
      await tx.prepare(`INSERT INTO perps_pilot_attempts(owner,window_start,attempts) VALUES(?,?,1)
        ON CONFLICT(owner) DO UPDATE SET window_start=excluded.window_start,attempts=1`).run(owner, at);
    }
    await tx.prepare(`DELETE FROM perps_pilot_attempts WHERE owner IN
      (SELECT owner FROM perps_pilot_attempts WHERE window_start < ? ORDER BY window_start LIMIT 100)`).run(at - 24 * 60 * 60_000);
    return null;
  }
  async redeem(args: { owner: string; code: string; beforeAdmit?: PerpsPilotBeforeAdmit }): Promise<PerpsPilotRedeemResult> {
    const owner = ownerKey(args.owner), hash = codeHash(args.code);
    return this.locked(async (tx, revision) => {
      const at = this.now(), retryAfterSec = await this.attempt(tx, owner, at);
      if (retryAfterSec !== null) return { outcome: "limited", revision, retryAfterSec };
      const previous = await tx.prepare("SELECT status FROM perps_pilot_admissions WHERE owner=?").get(owner) as Row | undefined;
      if (previous?.status === "revoked") return { outcome: "revoked", revision };
      if (previous?.status === "allowed") return { outcome: "already-admitted", revision };
      if (!hash) return { outcome: "invalid-invite", revision };
      const row = await tx.prepare("SELECT * FROM perps_pilot_invites WHERE code_hash=?").get(hash) as Row | undefined;
      if (!row) return { outcome: "invalid-invite", revision };
      const invite = inviteFrom(row);
      if (invite.revokedAt !== null || invite.expiresAt <= at || invite.uses >= invite.maxUses) return { outcome: "invalid-invite", revision };
      if (!(await this.hasRoom(tx))) return { outcome: "full", revision };
      await args.beforeAdmit?.();
      const admittedAt = this.now();
      // The settings write may have waited on another connection. An invite
      // that expired during that wait must not become new authority afterward.
      if (invite.expiresAt <= admittedAt) return { outcome: "invalid-invite", revision };
      const nextRevision = await this.bump(tx);
      await tx.prepare("INSERT INTO perps_pilot_admissions(owner,status,source,revision,updated_at,actor) VALUES(?,'allowed','invite',?,?,?)")
        .run(owner, nextRevision, admittedAt, owner);
      await tx.prepare("INSERT INTO perps_pilot_redemptions(invite_id,owner,redeemed_at) VALUES(?,?,?)").run(invite.id, owner, admittedAt);
      await tx.prepare("UPDATE perps_pilot_invites SET uses=uses+1 WHERE id=?").run(invite.id);
      await this.audit(tx, "invite-redeemed", owner, owner, invite.id, nextRevision, admittedAt);
      return { outcome: "admitted", revision: nextRevision };
    });
  }
}

const stores = new Map<string, PerpsPilotStore>();
let testStore: PerpsPilotStore | null = null;
/** Explicit dependency seam; no environment variable can bypass admission. */
export function setPerpsPilotStoreForTest(store: PerpsPilotStore | null): void { testStore = store; }
/** Hosted admission never falls back to ephemeral files or an environment-only decision. */
export function getPerpsPilotStore(): PerpsPilotStore {
  if (testStore) return testStore;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Paper-pilot admission requires shared database storage.");
  let store = stores.get(url);
  if (!store) {
    let pending: Promise<SqlPerpsPilotStore> | null = null;
    const load = () => pending ??= makePgDb(url).then(db => new SqlPerpsPilotStore(db)).catch(error => { pending = null; throw error; });
    store = {
      snapshot: () => load().then(value => value.snapshot()),
      withAdmission: (owner, action) => load().then(value => value.withAdmission(owner, action)),
      get: owner => load().then(value => value.get(owner)),
      list: () => load().then(value => value.list()),
      createInvite: args => load().then(value => value.createInvite(args)),
      revokeInvite: args => load().then(value => value.revokeInvite(args)),
      setAdmission: args => load().then(value => value.setAdmission(args)),
      redeem: args => load().then(value => value.redeem(args)),
    };
    stores.set(url, store);
  }
  return store;
}
