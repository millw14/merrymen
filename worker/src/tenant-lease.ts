/**
 * Per-tenant Postgres advisory lease — the guarantee that at most ONE
 * orchestrator replica arms a given tenant at a time.
 *
 * THE HOLE IT CLOSES. The orchestrator forks one worker child per tenant. Run
 * two orchestrator replicas — which Railway does the moment the service scales
 * past one — and both read the same grant store, both fork a child for the same
 * tenant, and both trade that tenant's ONE session key against that tenant's ONE
 * daily cap. Each child counts only its own spend (the counters live in its
 * process, seeded from the ledger at arm), so the account can spend up to N×
 * the ceiling with N replicas. The wall still bounds per-op value, but the daily
 * budget — the thing that says "risk at most this much of my money per day" —
 * silently multiplies. That is the multi-replica correctness hole the plan flags
 * as a real-funds blocker.
 *
 * WHY AN ADVISORY LOCK. A Postgres SESSION-level advisory lock is a cross-process
 * mutex whose lifetime is exactly the connection that took it. One session can
 * hold distinct tenant locks, so the fleet is divided deterministically among
 * at most eight connections per orchestrator instead of one per tenant. This
 * bounds the blast radius of one lost socket while staying below the old
 * connection count. Replica B's
 * pg_try_advisory_lock returns false while replica A holds it, so B refuses to
 * arm. And when A dies — process gone, or just its lease connection dropped —
 * Postgres releases the lock, and B may take over on its next reconcile. That is
 * precisely the failover we want: at most one arm at a time, with automatic
 * handoff, and never a permanent freeze if a replica vanishes.
 *
 * NO SHARED DB → NO LOCK NEEDED. Without DATABASE_URL the grant store is the
 * single-file backend, which only one process can ever run against — so the
 * lease is implicit and acquire() returns a no-op hold that is always granted
 * and always healthy. This keeps the self-hosted path and the single-service
 * testnet deploy byte-identical to today; the lock machinery engages only once
 * there is a shared database for replicas to contend over.
 *
 * `pg` is a RUNTIME-only dependency (dynamic import), the same arrangement the
 * grant store uses, so the file backend builds and runs with pg absent.
 */

/** A held lease. `release()` is idempotent; `healthy()` is a cheap sync probe. */
export interface TenantLease {
  readonly tenant: `0x${string}`;
  /** "postgres" when a real advisory lock is held; "none" for the implicit single-process hold. */
  readonly backend: "postgres" | "none";
  /**
   * True while the lock is still ours. Goes false the instant the lease
   * shared lease connection errors or ends — because at that moment Postgres has
   * released every lock on it and another replica may hold this tenant, so this
   * child must stop trading. The
   * no-op lease is always healthy (nothing to lose).
   */
  healthy(): boolean;
  /** Release this tenant's lock. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * A stable 64-bit key for a tenant, in Postgres `bigint` range.
 *
 * FNV-1a over the lowercased owner address, reinterpreted as a SIGNED 64-bit
 * integer (Postgres bigint is signed; an unsigned value ≥ 2^63 would overflow
 * the ::bigint cast). Deterministic, so every replica computes the same key for
 * the same tenant and they contend over the same lock. A 64-bit space makes a
 * collision between two distinct tenants astronomically unlikely — and even a
 * collision would only make one of them wait, never let both arm, so it fails
 * safe.
 */
export function leaseKey(tenant: string): bigint {
  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  let h = OFFSET;
  const s = tenant.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = BigInt.asUintN(64, h * PRIME);
  }
  return BigInt.asIntN(64, h);
}

/** The minimal `pg.Client` surface the lease uses — keeps pg a runtime-only, untyped dep. */
interface PgLeaseClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: "error" | "end", cb: (...args: unknown[]) => void): void;
}

interface HeldLease {
  client: PgLeaseClient;
  active: boolean;
}

/**
 * One SESSION, many independently releasable locks. Session pooling (PgBouncer
 * transaction mode) cannot be used here: a lock must stay on the same backend
 * connection until its tenant is stood down. A failed connection or query
 * invalidates every lease on that session; the orchestrator sees `healthy() ===
 * false` and stops those children before attempting to lease them again.
 *
 * The connector is passed in so the real contention and loss rules can be
 * exercised with two fake Postgres sessions without importing `pg` in tests.
 */
export class PgTenantLeaseManager {
  private current: PgLeaseClient | null = null;
  private ready: Promise<PgLeaseClient> | null = null;
  private connected = false;
  private readonly held = new Map<string, HeldLease>();
  /** Includes acquisitions in flight, before `held` has its row. */
  private readonly acquiring = new Set<string>();
  /** FNV collisions must block, not become reentrant locks on our session. */
  private readonly keyOwners = new Map<string, string>();
  /** pg.Client queries must not overlap on one session (pg 9 will reject it). */
  private readonly queryTails = new WeakMap<PgLeaseClient, Promise<void>>();

  constructor(
    private readonly makeClient: () => Promise<PgLeaseClient>,
    private readonly onLoss: () => void = () => {},
  ) {}

  private lost(client: PgLeaseClient): void {
    // A late event from an old session must never poison its replacement.
    if (this.current !== client) return;
    const hadLocks = this.connected && [...this.held.values()].some((lease) => lease.client === client && lease.active);
    this.current = null;
    this.connected = false;
    // A second replica can take the released locks immediately. Signal the
    // orchestrator synchronously, in this event turn, rather than waiting for
    // its next 15-second reconcile to notice all children lost protection.
    if (hadLocks) {
      try {
        this.onLoss();
      } catch (error) {
        // Keep the socket marked lost even if the signaler itself failed; the
        // regular reconcile remains the fallback stand-down path.
        console.error("[lease] immediate stand-down failed:", error);
      }
    }
  }

  private async discard(client: PgLeaseClient): Promise<void> {
    this.lost(client);
    try {
      await client.end();
    } catch {
      // pg may reject or throw synchronously when the socket is already gone.
    }
  }

  private async client(): Promise<PgLeaseClient> {
    if (this.current && this.connected) return this.current;
    if (!this.ready) {
      const started = (async () => {
        const client = await this.makeClient();
        this.current = client;
        // Attach before connect, including its failed-start path, so a socket
        // error cannot become an unhandled EventEmitter error.
        client.on("error", () => { void this.discard(client).catch((error) => console.error("[lease] socket cleanup failed:", error)); });
        client.on("end", () => this.lost(client));
        try {
          await client.connect();
        } catch (error) {
          await this.discard(client);
          throw error;
        }
        if (this.current !== client) {
          await this.discard(client);
          throw new Error("lease connection ended while connecting");
        }
        this.connected = true;
        return client;
      })();
      this.ready = started;
      // Clear a failed start so the next reconcile can retry. Concurrent
      // callers of this start still share exactly one connection attempt.
      void started.finally(() => {
        if (this.ready === started) this.ready = null;
      }).catch(() => {});
    }
    return this.ready;
  }

  private async query(client: PgLeaseClient, sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    const previous = this.queryTails.get(client) ?? Promise.resolve();
    let done!: () => void;
    const tail = new Promise<void>((resolve) => { done = resolve; });
    this.queryTails.set(client, tail);
    await previous;
    try {
      if (this.current !== client || !this.connected) throw new Error("lease connection ended before query");
      return await client.query(sql, params);
    } finally {
      done();
      if (this.queryTails.get(client) === tail) this.queryTails.delete(client);
    }
  }

  async acquire(tenant: `0x${string}`): Promise<TenantLease | null> {
    const id = tenant.toLowerCase();
    const key = leaseKey(id).toString();
    // PostgreSQL session locks are reentrant. Asking twice on OUR session
    // would succeed twice, making one release insufficient and leaving a ghost
    // lock. Reserve both tenant and lock key before the first await. Distinct
    // tenants with a rare 64-bit collision must block each other too.
    if (this.held.has(id) || this.acquiring.has(id) || this.keyOwners.has(key)) return null;
    this.acquiring.add(id);
    this.keyOwners.set(key, id);
    let acquired = false;
    try {
      const client = await this.client();
      let rows: Record<string, unknown>[];
      try {
        ({ rows } = await this.query(client, "SELECT pg_try_advisory_lock($1::bigint) AS locked", [key]));
      } catch (error) {
        // A query error does not prove which locks remain on the server.
        // Closing the session releases all of them, and marks every local
        // lease unhealthy until the orchestrator stands its children down.
        await this.discard(client);
        throw error;
      }
      if (this.current !== client || !this.connected) {
        throw new Error("lease connection ended during acquisition");
      }
      const locked = rows[0]?.locked;
      if (locked === false) return null;
      if (locked !== true) {
        // A missing/malformed verdict is ambiguous: the server may have taken
        // the lock even though we cannot prove it. End the session to release
        // that possible lock and invalidate every existing lease on it.
        await this.discard(client);
        throw new Error("lease acquisition returned no lock verdict");
      }

      const state: HeldLease = { client, active: true };
      this.held.set(id, state);
      acquired = true;
      let releasePromise: Promise<void> | null = null;
      return {
        tenant,
        backend: "postgres",
        healthy: () => state.active && this.current === client && this.connected,
        release: () => {
          if (!releasePromise) releasePromise = this.release(id, key, state);
          return releasePromise;
        },
      };
    } finally {
      this.acquiring.delete(id);
      if (!acquired && this.keyOwners.get(key) === id) this.keyOwners.delete(key);
    }
  }

  private async release(id: string, key: string, state: HeldLease): Promise<void> {
    state.active = false;
    try {
      if (this.current !== state.client || !this.connected) return;
      const { rows } = await this.query(state.client, "SELECT pg_advisory_unlock($1::bigint) AS unlocked", [key]);
      if (rows[0]?.unlocked !== true) {
        // An unexplained missing lock makes every other lock on this session
        // suspect as well. Close it; never claim those children are protected.
        await this.discard(state.client);
      }
    } catch {
      await this.discard(state.client);
    } finally {
      // Keep the entry until the unlock settles: a concurrent reacquire on the
      // same session must not increment PostgreSQL's reentrant lock count.
      if (this.held.get(id) === state) this.held.delete(id);
      if (this.keyOwners.get(key) === id) this.keyOwners.delete(key);
    }
  }
}

/** An explicit upper bound on long-lived lease connections per orchestrator. */
export const MAX_LEASE_SESSIONS_PER_PROCESS = 8;

/** A tenant always chooses the same local session, on every replica. */
export function leaseShard(tenant: string): number {
  return Number(BigInt.asUintN(64, leaseKey(tenant)) % BigInt(MAX_LEASE_SESSIONS_PER_PROCESS));
}

export class PgTenantLeaseFleet {
  private readonly shards: PgTenantLeaseManager[];

  constructor(makeClient: (shard: number) => Promise<PgLeaseClient>, onLoss: () => void = () => {}) {
    this.shards = Array.from({ length: MAX_LEASE_SESSIONS_PER_PROCESS }, (_, shard) =>
      new PgTenantLeaseManager(() => makeClient(shard), onLoss));
  }

  acquire(tenant: `0x${string}`): Promise<TenantLease | null> {
    return this.shards[leaseShard(tenant)]!.acquire(tenant);
  }
}

const fleets = new Map<string, PgTenantLeaseFleet>();
let leaseLossHandler: (() => void) | null = null;

/** The orchestrator installs its immediate stand-down before acquiring leases. */
export function setTenantLeaseLossHandler(handler: (() => void) | null): void {
  leaseLossHandler = handler;
}

function fleetFor(url: string): PgTenantLeaseFleet {
  let fleet = fleets.get(url);
  if (fleet) return fleet;
  fleet = new PgTenantLeaseFleet(async () => {
    // pg is runtime-only: installed on the hosted image, absent from the
    // self-hosted install. The import is gated on DATABASE_URL.
    // @ts-expect-error pg has no types here; webpackIgnore stops bundler resolution
    const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
      Client: new (c: { connectionString: string }) => PgLeaseClient;
    };
    return new pg.Client({ connectionString: url });
  }, () => leaseLossHandler?.());
  fleets.set(url, fleet);
  return fleet;
}

/** The always-granted hold used when there is no shared database to contend over. */
function noopLease(tenant: `0x${string}`): TenantLease {
  return {
    tenant,
    backend: "none",
    healthy: () => true,
    async release() {
      /* nothing to release — the hold was implicit */
    },
  };
}

/**
 * Try to lease `tenant`. Returns the held lease, or NULL when another replica
 * already holds it (the caller must then NOT arm this tenant and retry on a
 * later reconcile — the other replica may hand it back). Throws only on an
 * unexpected database error, which the caller treats as "skip this tenant this
 * reconcile", never as "arm anyway".
 *
 * Without DATABASE_URL this is the no-op hold (single process by construction).
 */
export async function acquireTenantLease(tenant: `0x${string}`): Promise<TenantLease | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return noopLease(tenant);
  return fleetFor(url).acquire(tenant);
}
