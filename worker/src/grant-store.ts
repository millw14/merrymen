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
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
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

/** How long a writer waits for another writer's lock on the same tenant. */
const LOCK_WAIT_MS = 5_000;

/** A lock names its holder: host, pid, and a nonce for this one acquisition. */
function lockToken(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

/**
 * Is the process that wrote this lock still running?
 *
 * Only a lock whose holder is known to be GONE may be broken. Age is not
 * evidence: a slow or paused holder still owns its lock, and breaking it on
 * age let a paused owner resume and delete its successor's. Anything that
 * can't be judged counts as alive: another host's lock, an unreadable or
 * half-written token, a pid we may not signal. Waiting fails closed (the
 * write is refused as busy). Breaking wrongly fails open.
 */
function holderAlive(token: string): boolean {
  const [host, pidText] = token.split(":");
  const pid = Number(pidText);
  if (host !== hostname() || !Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Remove the lock at `lock` only if it is still exactly the orphan `seen`.
 * The rename claims whatever is at the path, atomically, so at most one
 * contender gets it. If the claimed file is not the orphan, a successor
 * replaced it in between, and its lock is put back with link(), which never
 * overwrites. (What remains is a microsecond window needing a dead holder and
 * three contenders at once: a third writer can take the path while the
 * successor's lock is aside.)
 */
async function breakOrphan(lock: string, seen: string): Promise<void> {
  const claimed = `${lock}.${randomUUID()}.orphan`;
  try {
    await rename(lock, claimed);
  } catch {
    return; // another contender claimed it first
  }
  let got = "";
  try {
    got = await readFile(claimed, "utf8");
  } catch {
    /* unreadable: not provably the orphan, so it goes back */
  }
  if (got !== seen) {
    try {
      await link(claimed, lock);
    } catch {
      /* a newer lock already holds the path */
    }
  }
  await rm(claimed, { force: true });
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
   * ONE WRITER PER TENANT AT A TIME, ACROSS PROCESSES.
   *
   * removeUnlessNewer reads a record's stamp and then deletes it. Without
   * this, a put from another process (the web's grant intake beside the
   * orchestrator) could land between the two, and a grant signed after the
   * kill would be the one deleted. The lock is a file created with O_EXCL,
   * which works across processes where an in-memory lock would not. Readers
   * take no lock: a put renames a finished record into place, so a reader
   * sees the old record or the new one, never half of one.
   *
   * The lock file holds its owner's token. It is released only by the call
   * that holds it, and broken only when its holder process is gone
   * (holderAlive, breakOrphan). No writer here holds it for more than
   * milliseconds.
   */
  private async locked<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true });
    const lock = `${this.file(tenant)}.lock`;
    const token = lockToken();
    const giveUpAt = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await writeFile(lock, token, { flag: "wx", mode: 0o600 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let seen: string | null = null;
        try {
          seen = await readFile(lock, "utf8");
        } catch {
          /* released while we looked */
        }
        if (seen !== null && !holderAlive(seen)) await breakOrphan(lock, seen);
        if (Date.now() > giveUpAt) throw new Error(`grant store busy for ${tenant}: ${lock} is held by ${seen ?? "?"}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    try {
      return await fn();
    } finally {
      // ONLY THE LOCK THIS CALL HOLDS. Nobody breaks a live holder's lock, so
      // it should still be ours. Checking means a surprise here can never
      // delete someone else's.
      try {
        if ((await readFile(lock, "utf8")) === token) await rm(lock, { force: true });
      } catch {
        /* already gone */
      }
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
  constructor(private url: string) {
    requireDek(); // fail fast: hosted Postgres without a DEK is a plaintext-at-rest bug
  }
  private async client(): Promise<PgClientLike> {
    if (!this.ready) {
      this.ready = (async () => {
        // pg is a RUNTIME-only dependency (installed on the hosted deploy, not
        // in this repo). The webpackIgnore comment stops Next's bundler from
        // trying to resolve it at build — the file backend must build with pg
        // absent — and it is loaded only here, only when DATABASE_URL selected
        // this backend. The Postgres path is gated on a live integration test
        // before any deploy (docs/hosted-platform-plan.md).
        // @ts-expect-error pg has no types here (runtime-only); webpackIgnore stops the bundler resolving it
        const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
          Client: new (c: { connectionString: string }) => PgClientLike & { connect(): Promise<void> };
        };
        const c = new pg.Client({ connectionString: this.url });
        await c.connect();
        await c.query(
          `CREATE TABLE IF NOT EXISTS grants (
             tenant TEXT PRIMARY KEY,
             chain_id INTEGER NOT NULL,
             grant_json JSONB NOT NULL,
             sealed_session_key TEXT NOT NULL,
             updated_at BIGINT NOT NULL
           )`,
        );
        return c;
      })();
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
