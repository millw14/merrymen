/**
 * The per-tenant advisory lease. The fake below models PostgreSQL session-lock
 * reentrancy and cross-session contention, so the bounded-session fleet change is
 * checked without risking a connection to the production database.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acquireTenantLease, leaseKey, leaseShard, MAX_LEASE_SESSIONS_PER_PROCESS, PgTenantLeaseFleet, PgTenantLeaseManager } from "./tenant-lease";

const A = "0xABCdef0000000000000000000000000000000001" as const;
const B = "0x0000000000000000000000000000000000000002" as const;

class FakePg {
  readonly locks = new Map<string, { client: FakeClient; depth: number }>();
  readonly clients: FakeClient[] = [];
  open(failConnect = false): FakeClient {
    const client = new FakeClient(this, failConnect);
    this.clients.push(client);
    return client;
  }
  drop(client: FakeClient): void {
    for (const [key, hold] of this.locks) if (hold.client === client) this.locks.delete(key);
  }
}

class FakeClient {
  private readonly listeners = new Map<"error" | "end", ((...args: unknown[]) => void)[]>();
  connected = false;
  ended = false;
  failUnlock = false;
  throwEnd = false;
  omitTryVerdict = false;
  private queryRunning = false;
  beforeTry: (() => Promise<void>) | null = null;
  beforeUnlock: (() => Promise<void>) | null = null;
  constructor(private readonly db: FakePg, private readonly failConnect: boolean) {}
  on(event: "error" | "end", listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  private emit(event: "error" | "end"): void {
    for (const listener of this.listeners.get(event) ?? []) listener(new Error("socket lost"));
  }
  async connect(): Promise<void> {
    if (this.failConnect) throw new Error("connection slots exhausted");
    this.connected = true;
  }
  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    if (this.queryRunning) throw new Error("overlapping query on one lease session");
    this.queryRunning = true;
    try {
      if (!this.connected) throw new Error("connection lost");
      const key = String(params[0]);
      if (sql.includes("pg_try_advisory_lock")) {
        await this.beforeTry?.();
        if (!this.connected) throw new Error("connection lost");
        const prior = this.db.locks.get(key);
        if (prior && prior.client !== this) return { rows: [{ locked: false }] };
        this.db.locks.set(key, { client: this, depth: (prior?.depth ?? 0) + 1 });
        if (this.omitTryVerdict) return { rows: [] };
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        await this.beforeUnlock?.();
        if (this.failUnlock) throw new Error("unlock query failed");
        if (!this.connected) throw new Error("connection lost");
        const prior = this.db.locks.get(key);
        if (!prior || prior.client !== this) return { rows: [{ unlocked: false }] };
        if (prior.depth === 1) this.db.locks.delete(key);
        else this.db.locks.set(key, { client: this, depth: prior.depth - 1 });
        return { rows: [{ unlocked: true }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    } finally {
      this.queryRunning = false;
    }
  }
  end(): Promise<void> {
    if (this.throwEnd) throw new Error("end threw synchronously");
    if (this.ended) return Promise.resolve();
    this.ended = true;
    this.connected = false;
    this.db.drop(this);
    this.emit("end");
    return Promise.resolve();
  }
  fail(): void {
    this.connected = false;
    this.db.drop(this);
    this.emit("error");
    this.emit("end");
  }
}

function manager(db: FakePg): PgTenantLeaseManager {
  return new PgTenantLeaseManager(async () => db.open());
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("leaseKey", () => {
  it("is deterministic and case-insensitive on the tenant address", () => {
    assert.equal(leaseKey(A), leaseKey(A.toLowerCase()));
    assert.equal(leaseKey(A), leaseKey(A.toUpperCase()));
    // Two replicas computing the same key is the whole point — they must contend
    // over ONE lock, so the function cannot depend on anything but the address.
    assert.equal(leaseKey(A), leaseKey(A));
  });

  it("separates distinct tenants", () => {
    assert.notEqual(leaseKey(A), leaseKey(B));
  });

  it("stays inside signed 64-bit range (a valid Postgres bigint)", () => {
    const MIN = -(2n ** 63n);
    const MAX = 2n ** 63n - 1n;
    for (const t of [A, B, `0x${"ff".repeat(20)}`, `0x${"00".repeat(20)}`, "0xabc"]) {
      const k = leaseKey(t);
      assert.ok(typeof k === "bigint", `${t} → not a bigint`);
      assert.ok(k >= MIN && k <= MAX, `${t} → ${k} out of signed bigint range`);
    }
  });
});

describe("acquireTenantLease without a shared database", () => {
  it("grants an always-healthy no-op hold (single process by construction)", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL; // force the no-DB path; never touches pg
    try {
      const lease = await acquireTenantLease(A);
      assert.ok(lease, "the no-database acquire must always succeed");
      assert.equal(lease.backend, "none");
      assert.equal(lease.healthy(), true);
      assert.equal(lease.tenant, A);
      // release() is idempotent — the orchestrator may call it more than once
      // (kill switch, then shutdown) and it must never throw.
      await lease.release();
      await lease.release();
      assert.equal(lease.healthy(), true, "the no-op hold has nothing to lose");
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });
});

describe("shared Postgres advisory lease session", () => {
  it("holds a fleet on one connection while tenants release independently across replicas", async () => {
    const db = new FakePg();
    const first = manager(db);
    const second = manager(db);
    const tenants = Array.from({ length: 87 }, (_, i) =>
      `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`,
    );
    const leases = await Promise.all(tenants.map((tenant) => first.acquire(tenant)));
    assert.equal(leases.filter(Boolean).length, 87);
    assert.equal(db.clients.length, 1, "the fleet must use one session, not one per tenant");
    assert.equal(db.locks.size, 87);
    assert.equal(await second.acquire(tenants[1]!), null, "another replica cannot arm a held tenant");

    await leases[0]!.release();
    assert.equal(leases[0]!.healthy(), false);
    assert.equal(leases[1]!.healthy(), true, "releasing one tenant keeps the others protected");
    assert.equal(db.locks.size, 86);
    const taken = await second.acquire(tenants[0]!);
    assert.ok(taken, "the other replica may take only the released tenant");
    assert.equal(await first.acquire(tenants[0]!), null);
    await taken.release();
    await Promise.all(leases.map((lease) => lease?.release()));
    assert.equal(db.locks.size, 0);
  });

  it("refuses a duplicate before or after the first acquisition settles, avoiding reentrant locks", async () => {
    const db = new FakePg();
    const client = db.open();
    const entered = deferred();
    const go = deferred();
    client.beforeTry = async () => { entered.resolve(); await go.promise; };
    const leases = new PgTenantLeaseManager(async () => client);
    const pending = leases.acquire(A);
    await entered.promise;
    assert.equal(await leases.acquire(A.toLowerCase() as `0x${string}`), null);
    go.resolve();
    const held = await pending;
    assert.ok(held);
    assert.equal(await leases.acquire(A), null);
    assert.equal(db.locks.get(leaseKey(A).toString())?.depth, 1);
    await held.release();
    assert.equal(db.locks.size, 0);
    const again = await leases.acquire(A);
    assert.ok(again);
    await again.release();
  });

  it("keeps a tenant reserved while its unlock is in flight", async () => {
    const db = new FakePg();
    const client = db.open();
    const leases = new PgTenantLeaseManager(async () => client);
    const held = await leases.acquire(A);
    assert.ok(held);
    const entered = deferred();
    const go = deferred();
    client.beforeUnlock = async () => { entered.resolve(); await go.promise; };
    const releasing = held.release();
    await entered.promise;
    assert.equal(held.healthy(), false);
    assert.equal(await leases.acquire(A), null);
    go.resolve();
    await releasing;
    assert.equal(db.locks.size, 0);
  });

  it("marks every lease unhealthy on socket loss and reconnects without releasing another replica's lock", async () => {
    const db = new FakePg();
    let losses = 0;
    let unhealthyAtSignal = false;
    let a: Awaited<ReturnType<PgTenantLeaseManager["acquire"]>> = null;
    let b: Awaited<ReturnType<PgTenantLeaseManager["acquire"]>> = null;
    const first = new PgTenantLeaseManager(async () => db.open(), () => {
      losses++;
      unhealthyAtSignal = a?.healthy() === false && b?.healthy() === false;
    });
    const second = manager(db);
    a = await first.acquire(A);
    b = await first.acquire(B);
    assert.ok(a && b);
    db.clients[0]!.fail();
    assert.equal(losses, 1, "the orchestrator is signaled in the socket event turn");
    assert.equal(unhealthyAtSignal, true, "every child sees an unhealthy lease before the callback runs");
    assert.equal(a.healthy(), false);
    assert.equal(b.healthy(), false);
    assert.equal(db.locks.size, 0, "Postgres releases session locks on disconnect");
    const takeover = await second.acquire(A);
    assert.ok(takeover);
    assert.equal(await first.acquire(A), null, "stale local lease blocks a second arm until stand-down");
    const c = await first.acquire("0x0000000000000000000000000000000000000003");
    assert.ok(c, "a new session can lease another tenant");
    assert.equal(db.clients.length, 3);
    await a.release();
    await b.release();
    assert.equal(takeover.healthy(), true);
    assert.equal(db.locks.get(leaseKey(A).toString())?.client, db.clients[1]);
    assert.equal(await first.acquire(A), null, "the other replica still owns A");
    await c.release();
    await takeover.release();
  });

  it("forgets a failed connect and closes every lease if a query fails", async () => {
    const db = new FakePg();
    let calls = 0;
    const leases = new PgTenantLeaseManager(async () => db.open(++calls === 1));
    await assert.rejects(leases.acquire(A), /connection slots exhausted/);
    const a = await leases.acquire(A);
    const b = await leases.acquire(B);
    assert.ok(a && b);
    assert.equal(calls, 2);
    db.clients[1]!.failUnlock = true;
    await a.release();
    assert.equal(a.healthy(), false);
    assert.equal(b.healthy(), false, "a failed unlock cannot leave other children claiming a lock");
    assert.equal(db.locks.size, 0);
    await b.release();
    const c = await leases.acquire(A);
    assert.ok(c, "a later reconcile can use a fresh session");
    await c.release();
  });

  it("discards an ambiguous acquisition verdict, including locks already held", async () => {
    const db = new FakePg();
    let losses = 0;
    const leases = new PgTenantLeaseManager(async () => db.open(), () => { losses++; });
    const a = await leases.acquire(A);
    assert.ok(a);
    db.clients[0]!.omitTryVerdict = true;
    await assert.rejects(leases.acquire(B), /no lock verdict/);
    assert.equal(losses, 1);
    assert.equal(a.healthy(), false);
    assert.equal(db.locks.size, 0, "the ambiguous new lock and old lock both close with the session");
    await a.release();
    const retry = await leases.acquire(B);
    assert.ok(retry, "a fresh session can reacquire after the failed response");
    await retry.release();
  });

  it("survives a synchronous close error after socket loss", async () => {
    const db = new FakePg();
    let losses = 0;
    const leases = new PgTenantLeaseManager(async () => db.open(), () => { losses++; });
    const held = await leases.acquire(A);
    assert.ok(held);
    db.clients[0]!.throwEnd = true;
    db.clients[0]!.fail();
    assert.equal(losses, 1);
    assert.equal(held.healthy(), false);
    await held.release();
    const fresh = await leases.acquire(A);
    assert.ok(fresh);
    await fresh.release();
  });
});

describe("bounded lease fleet", () => {
  const tenants = Array.from({ length: 87 }, (_, i) =>
    `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`,
  );

  it("uses at most eight sessions for 87 tenants and arbitrates against another replica", async () => {
    const db = new FakePg();
    const first = new PgTenantLeaseFleet(async () => db.open());
    const second = new PgTenantLeaseFleet(async () => db.open());
    const leases = await Promise.all(tenants.map((tenant) => first.acquire(tenant)));
    assert.equal(leases.filter(Boolean).length, 87);
    assert.equal(db.clients.length, MAX_LEASE_SESSIONS_PER_PROCESS);
    assert.equal(db.locks.size, 87);
    assert.equal(await second.acquire(tenants[0]!), null);
    await leases[0]!.release();
    assert.equal(leases[1]!.healthy(), true);
    const takeover = await second.acquire(tenants[0]!);
    assert.ok(takeover);
    assert.equal(await first.acquire(tenants[0]!), null);
    await takeover.release();
    await Promise.all(leases.map((lease) => lease?.release()));
    assert.equal(db.locks.size, 0);
  });

  it("signals and stands down only the tenants on a lost shard", async () => {
    const db = new FakePg();
    const byShard = new Map<number, FakeClient>();
    let callbacks = 0;
    let leases: (Awaited<ReturnType<PgTenantLeaseFleet["acquire"]>>)[] = [];
    const lostShard = leaseShard(tenants[0]!);
    let unhealthyAtCallback = false;
    const first = new PgTenantLeaseFleet(async (shard) => {
      const client = db.open();
      byShard.set(shard, client);
      return client;
    }, () => {
      callbacks++;
      unhealthyAtCallback = leases.every((lease, i) =>
        lease?.healthy() === (leaseShard(tenants[i]!) !== lostShard));
    });
    const second = new PgTenantLeaseFleet(async () => db.open());
    leases = await Promise.all(tenants.map((tenant) => first.acquire(tenant)));
    assert.equal(byShard.size, MAX_LEASE_SESSIONS_PER_PROCESS);
    const lost = byShard.get(lostShard)!;
    lost.fail();
    assert.equal(callbacks, 1, "the callback runs in the socket-loss event turn");
    assert.equal(unhealthyAtCallback, true, "only the lost shard's children are unprotected when signaled");
    const affected = tenants.filter((tenant) => leaseShard(tenant) === lostShard);
    assert.ok(affected.length > 1 && affected.length < tenants.length);
    const takeover = await second.acquire(affected[0]!);
    assert.ok(takeover);
    const unaffected = tenants.find((tenant) => leaseShard(tenant) !== lostShard)!;
    assert.equal(await second.acquire(unaffected), null, "other shards remain leased");
    await Promise.all(leases.map((lease) => lease?.release()));
    assert.equal(takeover.healthy(), true, "stale releases cannot unlock the new replica");
    await takeover.release();
  });
});
