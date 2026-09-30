/**
 * The ledger's database driver — one async interface, two backends.
 *
 * The store (store.ts) is the single writer of the trade/equity/position/basis
 * ledger. It used to talk to node:sqlite synchronously. To let a HOSTED deploy
 * put that ledger in shared Postgres — so the web service can read what a worker
 * child writes, and it survives a redeploy — every store call is now async and
 * goes through this `Db` seam:
 *
 *   - SqliteDb (the default, and all self-hosted) wraps node:sqlite. Its
 *     operations are synchronous under the hood. Access to the connection is
 *     queued so an awaited transaction cannot absorb another caller's writes.
 *   - PgDb (added in the next stage, selected by DATABASE_URL) will run the same
 *     SQL against Postgres with placeholder + dialect translation.
 *
 * `?` placeholders and the sqlite spelling of SQL are the lingua franca here; a
 * Postgres backend translates them. Transactions run through `tx()` so the
 * Postgres backend can pin them to one connection (a pool.query-per-statement
 * transaction would scatter across connections and never commit as a unit).
 */
import { DatabaseSync } from "node:sqlite";

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Stmt {
  run(...params: unknown[]): Promise<RunResult>;
  get(...params: unknown[]): Promise<unknown>;
  all(...params: unknown[]): Promise<unknown[]>;
}

export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): Promise<void>;
  /** Use the supplied db for every operation in `fn`; it is scoped to this transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

// ── sqlite backend ─────────────────────────────────────────────────────────

class SqliteDb implements Db {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private raw: DatabaseSync,
    private scope?: { active: boolean },
  ) {}

  private access<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.scope) {
      if (!this.scope.active) return Promise.reject(new Error("transaction is no longer active"));
      try {
        return Promise.resolve(operation());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const run = this.pending.then(operation);
    // A failed statement or rollback must not poison the next caller's work.
    this.pending = run.then(() => undefined, () => undefined);
    return run;
  }

  prepare(sql: string): Stmt {
    return {
      run: (...params) => this.access(() => this.raw.prepare(sql).run(...(params as never[])) as RunResult),
      get: (...params) => this.access(() => this.raw.prepare(sql).get(...(params as never[]))),
      all: (...params) => this.access(() => this.raw.prepare(sql).all(...(params as never[]))),
    };
  }
  exec(sql: string): Promise<void> {
    return this.access(() => this.raw.exec(sql));
  }
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.scope) return Promise.reject(new Error("nested transactions are not supported"));
    return this.access(async () => {
      // Hold the queue through COMMIT/ROLLBACK. Only this scoped handle bypasses
      // it, so unrelated calls wait while the callback yields to the event loop.
      this.raw.exec("BEGIN");
      const scope = { active: true };
      try {
        const out = await fn(new SqliteDb(this.raw, scope));
        this.raw.exec("COMMIT");
        return out;
      } catch (error) {
        try {
          this.raw.exec("ROLLBACK");
        } catch {
          /* the transaction may already be gone */
        }
        throw error;
      } finally {
        scope.active = false;
      }
    });
  }
}

const sqliteWrappers = new WeakMap<DatabaseSync, Db>();

/**
 * Wrap an already-open node:sqlite connection as the async Db. store.ts opens the
 * connection and runs the schema SYNCHRONOUSLY (sqlite allows it, and that keeps
 * self-hosted's lazy-on-first-use init byte-for-byte); only the per-query calls
 * the store makes are routed through the async interface. Postgres selection
 * (DATABASE_URL) is added in the next stage as a sibling factory.
 */
export function wrapSqlite(raw: DatabaseSync): Db {
  // Multiple wrappers around one connection must share the same queue.
  let db = sqliteWrappers.get(raw);
  if (!db) {
    db = new SqliteDb(raw);
    sqliteWrappers.set(raw, db);
  }
  return db;
}

// ── sqlite → postgres translation ────────────────────────────────────────────
//
// The store writes SQL in the sqlite dialect (that is the self-hosted default and
// the only backend the test suite exercises). These pure functions rewrite it for
// Postgres. They are exported so they can be unit-tested WITHOUT a live database —
// the translation is the part that can silently be wrong, so it is the part with
// tests. The live Postgres round-trip itself is gated before any funding deploy
// (docs/hosted-platform-plan.md), exactly like the grant store's PG backend.

/** Rewrite `?` positional placeholders to Postgres `$1,$2,…`, skipping any inside
 *  single-quoted string literals (the store has none today, but a `?` in a string
 *  must never be renumbered). */
export function toPgPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (ch === "?" && !inStr) {
      out += "$" + ++n;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Translate ONE store query (not schema) to Postgres. */
export function translateQuery(sql: string): string {
  let s = sql;
  // `INSERT OR IGNORE INTO t (...) VALUES (...)` → append ON CONFLICT DO NOTHING.
  // Both store sites are single-statement with no existing conflict clause.
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(s)) {
    s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO");
    if (!/ON\s+CONFLICT/i.test(s)) s = s.replace(/\s*;?\s*$/, " ON CONFLICT DO NOTHING");
  }
  // sqlite tolerates `ON CONFLICT(cols)`; Postgres wants a space before the list.
  s = s.replace(/ON CONFLICT\(/g, "ON CONFLICT (");
  // `unixepoch()` is sqlite-only; Postgres computes the same integer this way.
  s = s.replace(/unixepoch\(\)/g, "EXTRACT(EPOCH FROM now())::bigint");
  return toPgPlaceholders(s);
}

/** Translate the DDL (CREATE block + an ALTER) to Postgres. Case-sensitive on the
 *  UPPERCASE type/keyword tokens the schema uses, so lowercase prose in the SQL
 *  comments (`the real thing`, `an INTEGER`) is never mistaken for a type. */
export function translateSchema(sql: string): string {
  let s = sql;
  s = s.replace(/PRAGMA[^;]*;/gi, ""); // WAL etc. — no Postgres equivalent, and not needed
  // Auto-increment PK first, before the generic INTEGER rule eats the word.
  s = s.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY");
  s = s.replace(/\bINTEGER\b/g, "BIGINT"); // sqlite INTEGER is 64-bit; match it, and epoch/block fit
  s = s.replace(/\bREAL\b/g, "DOUBLE PRECISION");
  s = s.replace(/unixepoch\(\)/g, "EXTRACT(EPOCH FROM now())::bigint");
  s = s.replace(/ADD COLUMN /g, "ADD COLUMN IF NOT EXISTS "); // idempotent re-runs on an existing db
  return s;
}

// ── postgres backend ─────────────────────────────────────────────────────────

/** The slice of a pg pool/client this driver uses. Kept minimal so `pg` stays a
 *  runtime-only dependency — no `@types/pg`, nothing to resolve at build. Mirrors
 *  grant-store.ts's PgClientLike. */
interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClientLike>;
}
interface PgClientLike extends PgQueryable {
  /** Back to the pool; given an error, the pool closes the connection instead (pg-pool's release(err)). */
  release(err?: Error): void;
  on?(event: "error", listener: (e: unknown) => void): unknown;
  removeListener?(event: "error", listener: (e: unknown) => void): unknown;
}

/** Params sqlite bound loosely, made safe for pg's stricter serializer: bigints as
 *  decimal strings (the columns that hold them are TEXT), undefined as null. */
function coerceParams(params: unknown[]): unknown[] {
  return params.map((p) => (typeof p === "bigint" ? p.toString() : p === undefined ? null : p));
}

class PgDb implements Db {
  constructor(
    private q: PgQueryable,
    /** For a connection pinned from a pool (sessionLock), the pool's own Db: see rootDb. */
    readonly root?: PgDb,
  ) {}
  prepare(sql: string): Stmt {
    const text = translateQuery(sql);
    const q = this.q;
    return {
      async run(...params) {
        const r = await q.query(text, coerceParams(params));
        // The store never reads lastInsertRowid (verified), so 0 is a safe stand-in
        // rather than an extra RETURNING round-trip on every insert.
        return { changes: r.rowCount ?? 0, lastInsertRowid: 0 };
      },
      async get(...params) {
        const r = await q.query(text, coerceParams(params));
        return r.rows[0];
      },
      async all(...params) {
        const r = await q.query(text, coerceParams(params));
        return r.rows;
      },
    };
  }
  async exec(sql: string): Promise<void> {
    // exec carries only DDL here (schema + ALTERs), so it takes the schema dialect.
    await this.q.query(translateSchema(sql));
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    // Pin the transaction to ONE checked-out connection. A pool.query-per-statement
    // transaction would scatter BEGIN/…/COMMIT across connections and never commit
    // as a unit — the reason the seam routes transactions through tx() at all.
    const pool = this.q as PgPoolLike;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(new PgDb(client));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* the transaction may already be gone */
      }
      throw e;
    } finally {
      client.release();
    }
  }
  /** withAdvisoryLock's Postgres half: see there. */
  async sessionLock<T>(cls: number, key: number, deadline: number, fn: (db: Db) => Promise<T>, held: () => void): Promise<T> {
    const pool = this.q as PgPoolLike;
    if (typeof pool.connect !== "function") throw new Error("an advisory session lock is taken on a pool, not inside a transaction");
    for (let pause = 20; ; pause = Math.min(pause * 2, 250)) {
      const client = await pool.connect();
      let got = false;
      try {
        const r = await client.query("SELECT pg_try_advisory_lock($1::int, $2::int) AS ok", [cls, key]);
        got = r.rows[0]?.ok === true;
      } catch (e) {
        // Closed, not pooled: the lock may have been taken before the answer was lost.
        client.release(e instanceof Error ? e : new Error(String(e)));
        throw e;
      }
      if (got) {
        held();
        return this.holding(client, cls, key, fn);
      }
      client.release();
      if (Date.now() + pause > deadline) throw new LockBusyError();
      await new Promise((r) => setTimeout(r, pause));
    }
  }
  private async holding<T>(client: PgClientLike, cls: number, key: number, fn: (db: Db) => Promise<T>): Promise<T> {
    // The pool listens for a connection's errors only while it is idle. Held
    // here while `fn` awaits other things, a connection the server drops would
    // otherwise emit an error nobody handles, and that ends the process; with
    // this, the statements on it fail instead, and it is closed below.
    const quiet = () => {};
    client.on?.("error", quiet);
    try {
      return await fn(new PgDb(client, this));
    } finally {
      let broken: Error | undefined;
      try {
        await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [cls, key]);
      } catch (e) {
        broken = e instanceof Error ? e : new Error(String(e));
      }
      client.removeListener?.("error", quiet);
      // A connection that could not say it let go is closed, never pooled: a
      // session lock goes with its connection, and a pooled one would keep it.
      client.release(broken);
    }
  }
}

/** The lock was still held elsewhere when the wait ran out. */
export class LockBusyError extends Error {
  constructor() {
    super("the lock is held elsewhere; try again");
    this.name = "LockBusyError";
  }
}

/** Per Db, per lock: the tail of this process's queue for it. */
const queued = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * ONE HOLDER AT A TIME, ACROSS PROCESSES, OF THE LOCK (cls, key), WHILE `fn`
 * RUNS — and `fn`'s statements go through the Db it is handed.
 *
 * On Postgres that is a SESSION-level advisory lock, the two-int form, on one
 * connection checked out of the pool for the whole of `fn`, and the Db handed
 * to `fn` runs its statements on that same connection, one at a time and each
 * committed as it runs (no transaction: nobody waits on a row it wrote).
 * Everything `fn` does through the database takes that one connection, so a
 * pool full of holders can never be a pool full of holders each waiting for a
 * second connection. The lock is TRIED, never waited on with a connection
 * held: a caller that finds it taken gives the connection back and tries again
 * shortly, until `waitMs` has passed, and then gets LockBusyError. A process
 * that dies holding it closes the connection, and Postgres lets go.
 *
 * Within this process callers queue first (a caller that gives up keeps its
 * place only until the one before it is done), so a burst from one process
 * holds one connection, not one each. On sqlite, and any Db that is not a
 * Postgres pool, that queue is the whole lock: one process by construction.
 */
export async function withAdvisoryLock<T>(db: Db, cls: number, key: number, fn: (db: Db) => Promise<T>, waitMs = 15_000): Promise<T> {
  const deadline = Date.now() + waitMs;
  const name = `${cls}:${key}`;
  let queue = queued.get(db);
  if (!queue) queued.set(db, (queue = new Map()));
  let counts = waiting.get(db);
  if (!counts) waiting.set(db, (counts = new Map()));
  const ahead = queue.get(name) ?? Promise.resolve();
  let leave!: () => void;
  const left = new Promise<void>((r) => (leave = r));
  // The next caller's turn: once the one ahead of this one is done AND this
  // one has left. A caller that gives up leaves at once, so whoever is next
  // still waits for the holder, never for somebody who has gone.
  const tail = ahead.then(() => left);
  queue.set(name, tail);
  counts.set(name, (counts.get(name) ?? 0) + 1);
  let isWaiting = true;
  const stopWaiting = () => {
    if (!isWaiting) return;
    isWaiting = false;
    const n = (counts.get(name) ?? 1) - 1;
    if (n > 0) counts.set(name, n);
    else counts.delete(name);
  };
  try {
    if (!(await settlesBy(ahead, deadline))) throw new LockBusyError();
    if (db instanceof PgDb) return await db.sessionLock(cls, key, deadline, fn, stopWaiting);
    stopWaiting();
    return await fn(db);
  } finally {
    stopWaiting();
    leave();
    if (queue.get(name) === tail) queue.delete(name);
  }
}

/** True once `p` settles, false if `deadline` comes first. */
async function settlesBy(p: Promise<void>, deadline: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Per Db, per lock: callers in this process that want it and do not hold it yet. */
const waiting = new WeakMap<object, Map<string, number>>();

/**
 * How many callers in this process are waiting for the lock: queued behind
 * another here, or (Postgres) trying it while another process holds it. For a
 * test to wait on, never for code to decide by.
 */
export function advisoryLockWaitersForTest(db: Db, cls: number, key: number): number {
  return waiting.get(db)?.get(`${cls}:${key}`) ?? 0;
}

/**
 * The Db a connection pinned by withAdvisoryLock was taken from, or `db`
 * itself: what per-database memos (a table made once) are keyed on, so each
 * pinned connection does not count as a database of its own.
 */
export function rootDb(db: Db): Db {
  return db instanceof PgDb && db.root ? db.root : db;
}

/**
 * ONE POOL PER URL, FOR THE LIFE OF THE PROCESS.
 *
 * A pg.Pool is designed to be long-lived and shared — that is the entire point
 * of a pool — so building one per call and never ending it is not a small
 * waste, it is an unbounded one. The orchestrator called makePgDb from three
 * places on its 15-second reconcile, which is three fresh pools every fifteen
 * seconds, each holding its own sockets, for as long as the service runs.
 *
 * The web tier had already worked around it by memoising the driver by hand,
 * which is the tell: the footgun was in this function's contract rather than in
 * its callers. Memoising HERE removes it for every caller, present and future.
 *
 * Keyed on the URL because a process could legitimately talk to two databases,
 * and the promise (not the resolved Db) is cached so concurrent first callers
 * share one in-flight connect rather than racing to build two pools.
 */
const pools = new Map<string, Promise<Db>>();

export function makePgDb(url: string): Promise<Db> {
  const existing = pools.get(url);
  if (existing) return existing;
  const started = openPgDb(url).catch((e) => {
    // A failed connect must not poison the cache: the next tick should get a
    // fresh attempt rather than inheriting this rejection for ever.
    pools.delete(url);
    throw e;
  });
  pools.set(url, started);
  return started;
}

/** Test seam: drop the cached pools so a test can change the environment. */
export function resetPgPoolsForTest(): void {
  pools.clear();
}

/**
 * Open the Postgres backend: dynamic-import `pg` (runtime-only, absent from this
 * repo and from any self-hosted install), teach it to hand back int8/BIGINT as a
 * JS number so the store's readers see the same shape sqlite gave them, and pool
 * the connections. The schema is run by the caller through `exec()`.
 */
async function openPgDb(url: string): Promise<Db> {
  // @ts-expect-error pg has no types here (runtime-only); webpackIgnore stops the bundler resolving it
  const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
    Pool: new (c: { connectionString: string; max?: number }) => PgPoolLike;
    types: { setTypeParser(oid: number, fn: (v: string) => unknown): void };
  };
  // int8 (oid 20) defaults to a JS string in node-postgres; sqlite returned a
  // number. Every int8 column here (epoch seconds, block numbers, ids, chat ids)
  // is well within 2^53, so Number is exact and keeps the store's read code — which
  // does arithmetic and comparisons on these — unchanged.
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  const pool = new pg.Pool({ connectionString: url });
  return new PgDb(pool);
}
