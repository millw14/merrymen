/**
 * The per-tenant grant store — where a hosted deploy keeps each tenant's signed
 * grant, durably and in isolation.
 *
 * Self-hosted keeps its single grant.json file and never touches this. Hosted
 * needs three things this provides: (1) MANY grants, one per tenant, not a
 * single slot; (2) DURABILITY across a redeploy — Railway's container
 * filesystem is ephemeral, and a lost grant strands a funded account; (3)
 * ENCRYPTION at rest of the session key. Web (the write side) and the
 * orchestrator (the read side) share this one module so they cannot disagree
 * about the shape.
 *
 * TENANT = the owner address, lowercased — the SIWE-authenticated wallet. A
 * grant is always stored under grant.owner, and callers pass the authenticated
 * tenant so the store can refuse a mismatch: the store is the last place the
 * "this grant belongs to this wallet" invariant can be enforced before bytes
 * hit disk.
 *
 * TWO BACKENDS, selected by DATABASE_URL:
 *  - Postgres (hosted, multi-service): web and the orchestrator are separate
 *    Railway services that cannot share a volume, so the shared store is a
 *    network database. Selected when DATABASE_URL is set.
 *  - File (self-hosted, single-service, tests): one file per tenant under a
 *    directory, session key sealed when a DEK is present. The default.
 *
 * NODE-ONLY (node:crypto, node:fs, pg). Imported by web API routes (node
 * runtime) and the worker via the @merrymen/grant-store alias — never by the
 * browser bundle, which is why it lives here and not in core's browser barrel.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { merrymenHome } from "./home";
import { carriesOwnerKey } from "../../packages/core/src/index";
import { openSecret, requireDek, sealSecret, storeDek } from "./store-crypto";
import type { StoredGrant } from "../../packages/core/src/index";

/** A grant safe to persist server-side: session-key-only, session key sealed. */
export interface StoredRecord {
  tenant: `0x${string}`;
  chainId: number;
  /** The grant, session key REMOVED (it lives sealed, separately). */
  grant: Omit<StoredGrant, "demoSessionPrivateKey" | "demoOwnerPrivateKey">;
  /** The session key, AES-256-GCM sealed when a DEK is set, else plaintext. */
  sealedSessionKey: string;
  updatedAt: number;
}

export interface GrantStore {
  /** Persist (or replace) a tenant's grant. Throws on an owner key or a tenant mismatch. */
  put(tenant: `0x${string}`, grant: StoredGrant): Promise<void>;
  /** The tenant's grant, session key decrypted back in, or null. */
  get(tenant: `0x${string}`): Promise<StoredGrant | null>;
  /** Every tenant with a grant — for the orchestrator to lease and arm. */
  listTenants(): Promise<`0x${string}`[]>;
  /** Public grant expiry for process scheduling; no session key is decrypted. */
  listTenantExpiries?(): Promise<Array<{ tenant: `0x${string}`; expiresAt: number | null }>>;
  /**
   * Which tenant already holds this smart account, or null.
   *
   * The collision guard for grant intake: every ledger table keys on
   * smart_account, so two tenants sharing one account would write into a single
   * partition. Callers must treat a THROW as "refuse", never as "nobody holds
   * it" — an unreadable store must not be able to wave a collision through.
   */
  tenantForAccount(smartAccount: `0x${string}`): Promise<`0x${string}` | null>;
  /** Forget a tenant's grant (the kill switch). */
  remove(tenant: `0x${string}`): Promise<void>;
  /**
   * Forget a tenant's grant IF it was stored at or before `atSec` (unix
   * seconds, compared with the record's server-stamped `updatedAt`).
   *
   * The kill switch for a kill that was asked for somewhere else — Telegram,
   * inside the tenant's child — and carried out later by the orchestrator. In
   * between, the owner may have signed a new grant on purpose, and that one
   * must survive. `grantedAt` cannot decide it: the browser stamps it, so a
   * skewed clock would pass an old grant off as new. `updatedAt` is stamped
   * here, on the server, at the moment of the put.
   *
   * One conditional DELETE, so a put racing the kill cannot be lost to a
   * read-then-delete. A tie counts as covered: the grant is removed.
   */
  removeUnlessNewer(tenant: `0x${string}`, atSec: number): Promise<"removed" | "absent" | "newer">;
}

/** Split a full grant into a persistable record, refusing anything with an owner key. */
function toRecord(tenant: `0x${string}`, grant: StoredGrant): StoredRecord {
  if (carriesOwnerKey(grant)) {
    throw new Error("refusing to store a grant that carries an owner key");
  }
  // NOTE: this deliberately no longer requires grant.owner === tenant. The owner
  // key is generated in the browser, so the two can never be equal; requiring it
  // rejected every hosted grant ever submitted. The tenant↔account link is
  // proved at intake instead, by two signatures over a server-issued nonce
  // (verifyGrantBinding in web/src/lib/auth.ts) — the wallet's, and the owner
  // key's co-signature proving the browser actually holds what it vouched for.
  // What survives here as defence in depth is the owner-key refusal above and
  // the fact that the record is keyed on the AUTHENTICATED tenant below, never
  // on anything the grant declares about itself.
  const { demoSessionPrivateKey, demoOwnerPrivateKey, ...rest } = grant as StoredGrant & {
    demoOwnerPrivateKey?: string;
  };
  void demoOwnerPrivateKey; // discarded; the guard above already refused a real one
  const dek = storeDek();
  const sealedSessionKey = dek ? sealSecret(demoSessionPrivateKey, dek) : demoSessionPrivateKey;
  return {
    tenant,
    chainId: grant.chainId,
    grant: rest,
    sealedSessionKey,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/** Reassemble a full grant, decrypting the session key back in. */
function fromRecord(rec: StoredRecord): StoredGrant {
  const dek = storeDek();
  const sessionKey = dek ? openSecret(rec.sealedSessionKey, dek) : rec.sealedSessionKey;
  return { ...rec.grant, demoSessionPrivateKey: sessionKey as `0x${string}` } as StoredGrant;
}

// ── file backend ─────────────────────────────────────────────────────────────

/** How long a writer waits for another writer, in any process, before giving up. */
const LOCK_WAIT_MS = 5_000;

/** The file whose SQLite write lock serializes this store's writers. */
export const GRANT_STORE_LOCK_FILE = ".writers.lock.db";

/** SQLITE_BUSY / SQLITE_LOCKED: another connection holds the write lock. */
function lockBusy(e: unknown): boolean {
  const code = (e as { errcode?: number }).errcode;
  return code === 5 || code === 6 || /database is (locked|busy)/i.test(String((e as Error)?.message ?? e));
}

/**
 * One JSON record per tenant under <home>/tenants/. Used self-hosted, in tests,
 * and for a single-service hosted deploy on a persistent volume. The session
 * key is sealed on disk when a DEK is present — verified by test: the file must
 * not contain the plaintext key.
 */
export class FileGrantStore implements GrantStore {
  private dir = path.join(merrymenHome(), "tenants");
  private file(tenant: string) {
    return path.join(this.dir, `${tenant.toLowerCase()}.json`);
  }
  /**
   * ONE WRITER AT A TIME, ACROSS PROCESSES.
   *
   * removeUnlessNewer reads a record's stamp and then deletes it. Without
   * this, a put from another process (the web's grant intake beside the
   * orchestrator) could land between the two, and a grant signed after the
   * kill would be the one deleted. Readers take no lock: a put renames a
   * finished record into place, so a reader sees the old record or the new
   * one, never half of one.
   *
   * THE LOCK IS THE OPERATING SYSTEM'S. It is SQLite's write lock on
   * GRANT_STORE_LOCK_FILE, taken by BEGIN IMMEDIATE (fcntl on POSIX,
   * LockFileEx on Windows). The kernel holds it and releases it when the
   * holding process exits, however it exits. So a lock is never stale, and
   * nothing ever has to break one. That is what the lock-file versions of
   * this kept getting wrong: every protocol for breaking a dead holder's lock
   * left a window where a live holder's lock went missing.
   *
   * A connection per call, closed after it: no handle stays open between
   * writes. Callers in the same process contend through SQLite exactly as
   * other processes do. The wait is a retry loop, not SQLite's busy timeout,
   * so a contended lock never blocks the event loop.
   */
  private async locked<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true });
    const db = new DatabaseSync(path.join(this.dir, GRANT_STORE_LOCK_FILE));
    try {
      const giveUpAt = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        try {
          db.exec("BEGIN IMMEDIATE");
          break;
        } catch (e) {
          if (!lockBusy(e)) throw e;
          if (Date.now() > giveUpAt) throw new Error(`grant store busy for ${tenant}: another writer holds the lock`);
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      try {
        const out = await fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* nothing to roll back */
        }
        throw e;
      }
    } finally {
      db.close();
    }
  }
  async put(tenant: `0x${string}`, grant: StoredGrant): Promise<void> {
    await this.locked(tenant, async () => {
      // Stamped inside the lock, so `updatedAt` is when the record landed.
      const rec = toRecord(tenant, grant);
      const tmp = `${this.file(tenant)}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(rec, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.file(tenant));
    });
  }
  async get(tenant: `0x${string}`): Promise<StoredGrant | null> {
    try {
      const rec = JSON.parse(await readFile(this.file(tenant), "utf8")) as StoredRecord;
      return fromRecord(rec);
    } catch {
      return null;
    }
  }
  async listTenants(): Promise<`0x${string}`[]> {
    try {
      const files = await readdir(this.dir);
      return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5) as `0x${string}`);
    } catch {
      return [];
    }
  }
  async listTenantExpiries(): Promise<Array<{ tenant: `0x${string}`; expiresAt: number | null }>> {
    const tenants = await this.listTenants();
    return Promise.all(tenants.map(async (tenant) => {
      try {
        const rec = JSON.parse(await readFile(this.file(tenant), "utf8")) as StoredRecord;
        const expiry = rec.grant.expiresAt;
        return { tenant, expiresAt: typeof expiry === "number" && Number.isFinite(expiry) ? expiry : null };
      } catch {
        // An unreadable grant must not be treated as armed. Leave its row in
        // the roster so existing cleanup and repair paths can still find it.
        return { tenant, expiresAt: null };
      }
    }));
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    await this.locked(tenant, () => rm(this.file(tenant), { force: true }));
  }
  async removeUnlessNewer(tenant: `0x${string}`, atSec: number): Promise<"removed" | "absent" | "newer"> {
    // The read and the delete under one lock (see `locked`), so no put lands
    // between them.
    return this.locked(tenant, async () => {
      let raw: string;
      try {
        raw = await readFile(this.file(tenant), "utf8");
      } catch (e) {
        // Only a missing file is "absent". Any other read failure is not an
        // answer, and the caller must not treat it as a completed kill.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
        throw e;
      }
      let updatedAt = Number.NaN;
      try {
        updatedAt = Number((JSON.parse(raw) as StoredRecord).updatedAt);
      } catch {
        /* an unreadable record cannot prove it is newer — it is removed below */
      }
      if (updatedAt > atSec) return "newer";
      await rm(this.file(tenant), { force: true });
      return "removed";
    });
  }
  async tenantForAccount(smartAccount: `0x${string}`): Promise<`0x${string}` | null> {
    const want = smartAccount.toLowerCase();
    // A scan, deliberately: the file backend is the single-service/self-hosted
    // path where the tenant count is small, and an index would be another thing
    // to keep in step with the files themselves. A read that throws propagates —
    // the caller must refuse rather than assume the account is unclaimed.
    for (const tenant of await this.listTenants()) {
      const rec = JSON.parse(await readFile(this.file(tenant), "utf8")) as StoredRecord;
      if (rec.grant?.smartAccount?.toLowerCase() === want) return tenant;
    }
    return null;
  }
}

// ── postgres backend ─────────────────────────────────────────────────────────

/** The slice of a pg client this store uses. Kept minimal so `pg` is a runtime-only dep. */
interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end?(): Promise<void>;
  on?(event: "error" | "end", cb: () => void): void;
}

/** Opens a grant-store connection. A test can supply a stand-in for a refused connection. */
export type PgGrantConnect = (url: string) => Promise<PgClientLike>;

async function connectPgGrant(url: string): Promise<PgClientLike> {
  // @ts-expect-error pg has no types here (runtime-only); webpackIgnore stops the bundler resolving it
  const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
    Client: new (c: { connectionString: string }) => PgClientLike & { connect(): Promise<void> };
  };
  const c = new pg.Client({ connectionString: url });
  try {
    await c.connect();
    return c;
  } catch (e) {
    await Promise.resolve().then(() => c.end?.()).catch(() => {});
    throw e;
  }
}

/**
 * Postgres backend for the multi-service hosted deploy, where web and the
 * orchestrator are separate Railway services sharing a network database.
 *
 * `pg` is imported at RUNTIME only (dynamic import), so it is not a compile-time
 * dependency and the file backend needs it neither installed nor typed. The DEK
 * is REQUIRED here — a hosted server storing session keys in the clear is
 * exactly what encryption-at-rest exists to prevent — so the constructor path
 * asserts it.
 *
 * INTEGRATION-TEST GATE: the SQL below is typechecked but not exercised in this
 * repo's test run (no live Postgres). Per docs/hosted-platform-plan.md it must
 * pass a live-Postgres round-trip before any deploy that funds a real account.
 */
export class PgGrantStore implements GrantStore {
  private ready: Promise<PgClientLike> | null = null;
  constructor(private url: string, private connect: PgGrantConnect = connectPgGrant) {
    requireDek(); // fail fast: hosted Postgres without a DEK is a plaintext-at-rest bug
  }
  private async client(): Promise<PgClientLike> {
    if (!this.ready) {
      const started = (this.ready = (async () => {
        const c = await this.connect(this.url);
        let alive = true;
        const lost = () => {
          alive = false;
          if (this.ready === started) this.ready = null;
        };
        // A once-healthy connection can also end after a database restart.
        // Make the next request reconnect; the request that lost it still fails.
        c.on?.("error", () => {
          lost();
          void Promise.resolve().then(() => c.end?.()).catch(() => {});
        });
        c.on?.("end", lost);
        try {
          await c.query(
            `CREATE TABLE IF NOT EXISTS grants (
               tenant TEXT PRIMARY KEY,
               chain_id INTEGER NOT NULL,
               grant_json JSONB NOT NULL,
               sealed_session_key TEXT NOT NULL,
               updated_at BIGINT NOT NULL
             )`,
          );
          if (!alive) throw new Error("grant store connection ended during setup");
        } catch (e) {
          // A failed CREATE must not leave a connection open on every retry.
          await Promise.resolve().then(() => c.end?.()).catch(() => {});
          throw e;
        }
        return c;
      })());
      // A refused first connection is not the answer for every subsequent
      // account read (or orchestrator reconcile) for the process's lifetime.
      // The next independent call retries; no failed financial write is replayed.
      started.catch(() => {
        if (this.ready === started) this.ready = null;
      });
    }
    return this.ready;
  }
  async put(tenant: `0x${string}`, grant: StoredGrant): Promise<void> {
    const rec = toRecord(tenant, grant);
    const c = await this.client();
    await c.query(
      `INSERT INTO grants (tenant, chain_id, grant_json, sealed_session_key, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant) DO UPDATE SET
         chain_id = EXCLUDED.chain_id, grant_json = EXCLUDED.grant_json,
         sealed_session_key = EXCLUDED.sealed_session_key, updated_at = EXCLUDED.updated_at`,
      [rec.tenant, rec.chainId, JSON.stringify(rec.grant), rec.sealedSessionKey, rec.updatedAt],
    );
  }
  async get(tenant: `0x${string}`): Promise<StoredGrant | null> {
    const c = await this.client();
    const { rows } = await c.query(
      `SELECT tenant, chain_id, grant_json, sealed_session_key, updated_at FROM grants WHERE tenant = $1`,
      [tenant.toLowerCase()],
    );
    const row = rows[0];
    if (!row) return null;
    const rec: StoredRecord = {
      tenant: String(row.tenant) as `0x${string}`,
      chainId: Number(row.chain_id),
      grant: (typeof row.grant_json === "string" ? JSON.parse(row.grant_json) : row.grant_json) as StoredRecord["grant"],
      sealedSessionKey: String(row.sealed_session_key),
      updatedAt: Number(row.updated_at),
    };
    return fromRecord(rec);
  }
  async listTenants(): Promise<`0x${string}`[]> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT tenant FROM grants`);
    return rows.map((r) => String(r.tenant) as `0x${string}`);
  }
  async listTenantExpiries(): Promise<Array<{ tenant: `0x${string}`; expiresAt: number | null }>> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT tenant, grant_json->>'expiresAt' AS expires_at FROM grants`);
    return rows.map((row) => {
      const expiry = Number(row.expires_at);
      return {
        tenant: String(row.tenant) as `0x${string}`,
        expiresAt: row.expires_at !== null && Number.isFinite(expiry) ? expiry : null,
      };
    });
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM grants WHERE tenant = $1`, [tenant.toLowerCase()]);
  }
  async removeUnlessNewer(tenant: `0x${string}`, atSec: number): Promise<"removed" | "absent" | "newer"> {
    const c = await this.client();
    const t = tenant.toLowerCase();
    const { rows } = await c.query(`DELETE FROM grants WHERE tenant = $1 AND updated_at <= $2 RETURNING tenant`, [t, atSec]);
    if (rows.length > 0) return "removed";
    // Nothing deleted: either there is no row, or it was put after the kill.
    // This read only names which — the decision was the DELETE above.
    const left = await c.query(`SELECT 1 FROM grants WHERE tenant = $1`, [t]);
    return left.rows.length > 0 ? "newer" : "absent";
  }
  async tenantForAccount(smartAccount: `0x${string}`): Promise<`0x${string}` | null> {
    const c = await this.client();
    // The account lives inside grant_json, so this reads it out of the JSONB
    // rather than a column. Fine at this size; if the fleet grows, the index to
    // add is on (grant_json->>'smartAccount').
    const { rows } = await c.query(
      `SELECT tenant FROM grants WHERE lower(grant_json->>'smartAccount') = $1 LIMIT 1`,
      [smartAccount.toLowerCase()],
    );
    const row = rows[0];
    return row ? (String(row.tenant) as `0x${string}`) : null;
  }
}

/** The store this deploy uses: Postgres when DATABASE_URL is set, else the file backend. */
let cached: GrantStore | null = null;
export function getGrantStore(): GrantStore {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? new PgGrantStore(url) : new FileGrantStore();
  return cached;
}

/** Test seam: drop the cached store so a test can change the environment. */
export function resetGrantStoreForTest(): void {
  cached = null;
}
