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
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { merrymenHome } from "./home";
import {
  assertNoPerpKeysAtRest,
  carriesOwnerKey,
  carriesPerpPrivateKey,
  GRANT_PERP_LIGHTER,
  grantPerp,
  grantPurpose,
  isGrantPurpose,
  isHostedMode,
} from "../../packages/core/src/index";
import { openSecret, requireDek, sealSecret, storeDek } from "./store-crypto";
import { openPerpKey } from "./perps/key-seal";
import { makePgDb } from "./db";
import { createHostedTables, initHostedStanddownSchema, HostedStanddownStore, revokeHostedGrant } from "./perps/hosted-standdown-store";
import type { GrantPurpose, StoredGrant } from "../../packages/core/src/index";

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
  /** Strict existence check: malformed/unreadable authority is never absent. */
  hasStoredGrant?(tenant: `0x${string}`): Promise<boolean>;
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
  /** Hosted perps expiry uses the same atomic key retention as an explicit kill. */
  expirePerps?(nowMs: number): Promise<void>;
}

/** Rechecked under the writer lock so simultaneous setup cannot split owner authority. */
function assertIndependentAccount(incoming: StoredGrant, other: StoredGrant | null): void {
  if (!other) return;
  if (typeof other.owner !== "string" || other.owner.toLowerCase() !== incoming.owner?.toLowerCase()) throw new Error("Spot and Perps must use the same owner key");
  if (other.smartAccount?.toLowerCase() === incoming.smartAccount.toLowerCase()) throw new Error("Spot and Perps must use distinct smart accounts");
  const spot = grantPurpose(incoming) === "spot" ? incoming : other;
  if (spot.perp !== undefined || spot.grantFeatures?.includes(GRANT_PERP_LIGHTER)) throw new Error("retire the legacy Spot perpetual permission before creating separate account authority");
}

/** Split a full grant into a persistable record, refusing anything with an owner key. */
function toRecord(tenant: `0x${string}`, grant: StoredGrant, purpose: GrantPurpose): StoredRecord {
  if (grantPurpose(grant) !== purpose) throw new Error("grant purpose does not match its account store");
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
  assertPerpCustodyAtPut(tenant, grant, rest, dek);
  const sealedSessionKey = dek ? sealSecret(demoSessionPrivateKey, dek) : demoSessionPrivateKey;
  return {
    tenant,
    chainId: grant.chainId,
    grant: rest,
    sealedSessionKey,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * THE LIGHTER KEY'S CUSTODY, CHECKED WHERE BYTES HIT DISK (docs/perps.md
 * rule 5). The route checks all of this first; the store is the last place it
 * can be enforced, and it is enforced here for the reason the owner-key
 * refusal above is — whatever writes a grant next, a new route, a script, a
 * partner door, goes through put.
 *
 *   NO PLAINTEXT KEY, ANYWHERE. `apiKeySealed` (DEK ciphertext) may live in
 *   grant_json; an 80-hex run outside `perp.apiPublicKey`, or any field named
 *   apiPrivateKey / privateKey, may not (carriesPerpPrivateKey). Checked on
 *   `rest` — exactly what is written — so the rule is about the bytes at rest,
 *   not about a view of them.
 *
 *   A PERP BLOCK IS WHOLE OR REFUSED. The marker without a valid block, or a
 *   block without the marker, is a grant whose wall and metadata disagree
 *   (grantPerp is the one reader).
 *
 *   HOSTED: A DEK, AND A BLOB THAT IS THIS TENANT'S. Without a DEK nothing can
 *   seal the key, so a perp grant is refused rather than stored in a state the
 *   orchestrator cannot arm. The sealed blob must OPEN under this tenant, this
 *   account and this public key (key-seal.ts AAD): a blob issued to anyone
 *   else — another tenant, another account, another key — never reaches disk.
 *   A hosted perp grant with NO blob is refused too: the route re-attaches the
 *   stored one on a carry-forward, so reaching here without one means the key
 *   the wall pins is held nowhere.
 */
function assertPerpCustodyAtPut(
  tenant: `0x${string}`,
  grant: StoredGrant,
  rest: StoredRecord["grant"],
  dek: Buffer | null,
): void {
  if (carriesPerpPrivateKey(rest)) {
    throw new Error("refusing to store a grant that carries a plaintext Lighter API private key");
  }
  const marked = grant.grantFeatures?.includes(GRANT_PERP_LIGHTER) === true;
  if (!marked && grant.perp === undefined) return;
  const perp = grantPerp(grant);
  if (perp === null || grant.perp === undefined) {
    throw new Error("refusing to store a grant whose perps marker and perp block disagree");
  }
  const hosted = isHostedMode();
  if (hosted && !dek) {
    throw new Error("refusing to store a perps grant: MERRYMEN_STORE_DEK is not set, so its Lighter key could not be sealed");
  }
  if (perp.apiKeySealed === undefined) {
    if (hosted) throw new Error("refusing to store a hosted perps grant without its sealed Lighter key");
    return;
  }
  if (!dek) throw new Error("refusing to store a sealed Lighter key this store has no DEK to open");
  try {
    openPerpKey(
      perp.apiKeySealed,
      { tenant, smartAccount: grant.smartAccount, apiPublicKey: perp.apiPublicKey, apiKeyIndex: perp.apiKeyIndex },
      dek,
    );
  } catch {
    throw new Error("refusing to store a sealed Lighter key that was not issued to this login, account and public key");
  }
}

/**
 * The boot half of the same rule, over grants AS WRITTEN: hosted, a store that
 * holds a plaintext Lighter key anywhere refuses to go on (the
 * assertNoOwnerKeysAtRest pattern; inert self-hosted).
 */
function assertRecordsClean(grants: readonly unknown[]): void {
  assertNoPerpKeysAtRest(grants);
}

/** Reassemble a full grant, decrypting the session key back in. */
function fromRecord(rec: StoredRecord, purpose: GrantPurpose): StoredGrant {
  if (grantPurpose(rec.grant) !== purpose) throw new Error("stored grant purpose does not match its account store");
  // READ-TIME, PER RECORD, over the grant as it was written (never the
  // rebuilt one, which is where secrets are joined back in): a record holding
  // a plaintext Lighter key is refused on the way out as well as the way in,
  // so one that got to disk some other way is never handed to a child.
  assertRecordsClean([rec.grant]);
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
  private dir: string;
  constructor(readonly purpose: GrantPurpose = "spot") {
    if (!isGrantPurpose(purpose)) throw new Error("Unrecognised agent account purpose");
    this.dir = path.join(merrymenHome(), purpose === "perps" ? "tenants-perps" : "tenants");
  }
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
    // Both purposes share the writer lock: cross-purpose account checks and writes are atomic.
    const lockDir = path.join(merrymenHome(), "tenants");
    await mkdir(lockDir, { recursive: true });
    const db = new DatabaseSync(path.join(lockDir, GRANT_STORE_LOCK_FILE));
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
  /**
   * The boot scan (hosted only): every tenant file, as written, once per
   * process after it first comes back clean. Run from put and listTenants —
   * listTenants is the orchestrator's first read, so a dirty store stops the
   * fleet from arming instead of arming it.
   */
  private atRestClean = false;
  private async scanAtRest(): Promise<void> {
    if (this.atRestClean || !isHostedMode()) return;
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
    } catch {
      files = [];
    }
    const grants: unknown[] = [];
    for (const f of files) {
      try {
        grants.push((JSON.parse(await readFile(path.join(this.dir, f), "utf8")) as StoredRecord).grant);
      } catch {
        /* unreadable is not a key at rest; get() on it answers null as before */
      }
    }
    assertRecordsClean(grants);
    this.atRestClean = true;
  }
  async put(tenant: `0x${string}`, grant: StoredGrant): Promise<void> {
    await this.scanAtRest();
    await this.locked(tenant, async () => {
      // Stamped inside the lock, so `updatedAt` is when the record landed.
      const rec = toRecord(tenant, grant, this.purpose);
      const other = new FileGrantStore(this.purpose === "perps" ? "spot" : "perps");
      const otherGrant = await other.get(tenant);
      if (!otherGrant && await other.hasStoredGrant(tenant)) throw new Error("the other account authority could not be read");
      assertIndependentAccount(grant, otherGrant);
      if (await other.tenantForAccountInPurpose(grant.smartAccount)) {
        throw new Error("Spot and Perps must use distinct smart accounts");
      }
      const tmp = `${this.file(tenant)}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(rec, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.file(tenant));
    });
  }
  async hasStoredGrant(tenant: `0x${string}`): Promise<boolean> {
    try { await stat(this.file(tenant)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async get(tenant: `0x${string}`): Promise<StoredGrant | null> {
    try {
      const rec = JSON.parse(await readFile(this.file(tenant), "utf8")) as StoredRecord;
      if (rec.tenant.toLowerCase() !== tenant.toLowerCase()) throw new Error("stored grant tenant mismatch");
      return fromRecord(rec, this.purpose);
    } catch {
      return null;
    }
  }
  async listTenants(): Promise<`0x${string}`[]> {
    await this.scanAtRest();
    try {
      const files = await readdir(this.dir);
      return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5) as `0x${string}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
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
    const own = await this.tenantForAccountInPurpose(smartAccount);
    const other = await new FileGrantStore(this.purpose === "perps" ? "spot" : "perps").tenantForAccountInPurpose(smartAccount);
    if (own && other && own !== other) throw new Error("smart account has conflicting tenant claims");
    return own ?? other;
  }
  private async tenantForAccountInPurpose(smartAccount: `0x${string}`): Promise<`0x${string}` | null> {
    const want = smartAccount.toLowerCase();
    // A scan, deliberately: the file backend is the single-service/self-hosted
    // path where the tenant count is small, and an index would be another thing
    // to keep in step with the files themselves. A read that throws propagates —
    // the caller must refuse rather than assume the account is unclaimed.
    for (const tenant of await this.listTenants()) {
      const rec = JSON.parse(await readFile(this.file(tenant), "utf8")) as StoredRecord;
      if (rec.tenant.toLowerCase() !== tenant.toLowerCase() || grantPurpose(rec.grant) !== this.purpose) throw new Error("stored grant account scope mismatch");
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
  private table: "grants" | "perps_grants";
  constructor(private url: string, readonly purpose: GrantPurpose = "spot") {
    if (!isGrantPurpose(purpose)) throw new Error("Unrecognised agent account purpose");
    this.table = purpose === "perps" ? "perps_grants" : "grants";
    requireDek(); // fail fast: hosted Postgres without a DEK is a plaintext-at-rest bug
  }
  private async client(): Promise<PgClientLike> {
    if (!this.ready) {
      const started = this.ready = (async () => {
        // pg is a RUNTIME-only dependency (installed on the hosted deploy, not
        // in this repo). The webpackIgnore comment stops Next's bundler from
        // trying to resolve it at build — the file backend must build with pg
        // absent — and it is loaded only here, only when DATABASE_URL selected
        // this backend. The Postgres path is gated on a live integration test
        // before any deploy (docs/hosted-platform-plan.md).
        // @ts-expect-error pg has no types here (runtime-only); webpackIgnore stops the bundler resolving it
        const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
          Client: new (c: { connectionString: string }) => PgClientLike & { connect(): Promise<void>; end(): Promise<void> };
        };
        const c = new pg.Client({ connectionString: this.url });
        try {
        await c.connect();
        for (const table of ["grants", "perps_grants"]) await createHostedTables(sql => c.query(sql),
          `CREATE TABLE IF NOT EXISTS ${table} (
             tenant TEXT PRIMARY KEY,
             chain_id INTEGER NOT NULL,
             grant_json JSONB NOT NULL,
             sealed_session_key TEXT NOT NULL,
             updated_at BIGINT NOT NULL
           )`,
        );
        await initHostedStanddownSchema(sql => c.query(sql));
        // THE BOOT SCAN: every grant_json as written, before this process
        // serves a single read or write. A hosted store holding a plaintext
        // Lighter key anywhere does not come up (assertNoPerpKeysAtRest).
        const { rows } = await c.query(`SELECT grant_json FROM grants UNION ALL SELECT grant_json FROM perps_grants`);
        assertRecordsClean(rows.map((r) => (typeof r.grant_json === "string" ? JSON.parse(r.grant_json) : r.grant_json)));
        return c;
        } catch (error) {
          await c.end().catch(() => {});
          throw error;
        }
      })();
      started.catch(() => { if (this.ready === started) this.ready = null; });
    }
    return this.ready;
  }
  async put(tenant: `0x${string}`, grant: StoredGrant): Promise<void> {
    const rec = toRecord(tenant, grant, this.purpose);
    await this.client();
    const db = await makePgDb(this.url);
    await db.tx(async tx => {
    // Serialize both account purposes for an owner, then cross-owner account claims.
    await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`grant-owner:${tenant.toLowerCase()}`);
    await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(grant.smartAccount.toLowerCase());
    const otherTable = this.purpose === "perps" ? "grants" : "perps_grants";
    const opposite = await tx.prepare(`SELECT grant_json FROM ${otherTable} WHERE tenant = ?`).get(tenant.toLowerCase()) as { grant_json: unknown } | undefined;
    if (opposite) assertIndependentAccount(grant, (typeof opposite.grant_json === "string" ? JSON.parse(opposite.grant_json) : opposite.grant_json) as StoredGrant);
    if (await tx.prepare(`SELECT tenant FROM ${otherTable} WHERE lower(grant_json->>'smartAccount') = ? LIMIT 1`).get(grant.smartAccount.toLowerCase())) {
      throw new Error("Spot and Perps must use distinct smart accounts");
    }
    await tx.prepare(
      `INSERT INTO ${this.table} (tenant, chain_id, grant_json, sealed_session_key, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant) DO UPDATE SET
         chain_id = EXCLUDED.chain_id, grant_json = EXCLUDED.grant_json,
         sealed_session_key = EXCLUDED.sealed_session_key, updated_at = EXCLUDED.updated_at`,
    ).run(rec.tenant, rec.chainId, JSON.stringify(rec.grant), rec.sealedSessionKey, rec.updatedAt);
    // The upsert takes the grant's row lock FIRST. A concurrent kill either
    // follows this put or commits its job before this test; it cannot slip a
    // new normal worker beside a draining venue key.
    if (await new HostedStanddownStore(tx, requireDek()).blocked(tenant, grant.smartAccount, this.purpose)) {
      throw new Error("the previous perps shutdown is still being accounted for; try again after it finishes");
    }
    });
  }
  async hasStoredGrant(tenant: `0x${string}`): Promise<boolean> {
    const client = await this.client();
    const { rows } = await client.query(`SELECT 1 FROM ${this.table} WHERE tenant = $1 LIMIT 1`, [tenant.toLowerCase()]);
    return rows.length > 0;
  }
  async get(tenant: `0x${string}`): Promise<StoredGrant | null> {
    const c = await this.client();
    const { rows } = await c.query(
      `SELECT tenant, chain_id, grant_json, sealed_session_key, updated_at FROM ${this.table} WHERE tenant = $1`,
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
    return fromRecord(rec, this.purpose);
  }
  async listTenants(): Promise<`0x${string}`[]> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT tenant FROM ${this.table}`);
    return rows.map((r) => String(r.tenant) as `0x${string}`);
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    await this.client();
    await revokeHostedGrant(await makePgDb(this.url), tenant, requireDek(), { purpose: this.purpose });
  }
  async removeUnlessNewer(tenant: `0x${string}`, atSec: number): Promise<"removed" | "absent" | "newer"> {
    await this.client();
    return revokeHostedGrant(await makePgDb(this.url), tenant, requireDek(), { beforeSec: atSec, purpose: this.purpose });
  }
  async expirePerps(nowMs: number): Promise<void> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT tenant FROM ${this.table} WHERE grant_json->'perp' IS NOT NULL
      AND CAST(grant_json->>'expiresAt' AS BIGINT) <= $1`, [Math.floor(nowMs / 1000)]);
    const db = await makePgDb(this.url);
    for (const row of rows) await revokeHostedGrant(db, String(row.tenant) as `0x${string}`, requireDek(), { nowMs, reason: "expiry", expiredOnly: true, purpose: this.purpose });
  }
  async tenantForAccount(smartAccount: `0x${string}`): Promise<`0x${string}` | null> {
    const c = await this.client();
    // The account lives inside grant_json, so this reads it out of the JSONB
    // rather than a column. Fine at this size; if the fleet grows, the index to
    // add is on (grant_json->>'smartAccount').
    const { rows } = await c.query(
      `SELECT tenant FROM grants WHERE lower(grant_json->>'smartAccount') = $1
       UNION SELECT tenant FROM perps_grants WHERE lower(grant_json->>'smartAccount') = $1`,
      [smartAccount.toLowerCase()],
    );
    if (rows.length > 1) throw new Error("smart account has conflicting tenant claims");
    const row = rows[0];
    return row ? (String(row.tenant) as `0x${string}`) : null;
  }
}

/** The store this deploy uses: Postgres when DATABASE_URL is set, else the file backend. */
const cached = new Map<GrantPurpose, GrantStore>();
export function getGrantStore(purpose: GrantPurpose = "spot"): GrantStore {
  if (!isGrantPurpose(purpose)) throw new Error("Unrecognised agent account purpose");
  const found = cached.get(purpose);
  if (found) return found;
  const url = process.env.DATABASE_URL;
  const store = url ? new PgGrantStore(url, purpose) : new FileGrantStore(purpose);
  cached.set(purpose, store);
  return store;
}

/** Test seam: drop the cached store so a test can change the environment. */
export function resetGrantStoreForTest(): void {
  cached.clear();
}

/** Refuse unknown backends rather than interpreting a failed read as no grant. */
export async function hasStoredGrant(tenant: `0x${string}`, purpose: GrantPurpose = "spot"): Promise<boolean> {
  const store = getGrantStore(purpose);
  if (!store.hasStoredGrant) throw new Error("Grant presence cannot be verified");
  return store.hasStoredGrant(tenant);
}
