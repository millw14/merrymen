/**
 * The MCP server's durable background work, driven by the orchestrator's
 * reconcile loop: backtest jobs, notification evaluation and delivery, and
 * table retention.
 *
 * WHY HERE. The web process answers requests and may be scaled or restarted at
 * any time; the orchestrator is the one long-lived scheduler this deployment
 * has. None of this touches trading: it reads the shared ledger, writes only
 * its own tables (mcp_jobs, notify_*) and sends Telegram messages through each
 * owner's own bot. Trading and protective exits never wait on it.
 *
 * NEVER BLOCKS THE LOOP. Each pass is started, not awaited, behind its own
 * in-flight slot, and each has its own time budget; a slow pass skips the
 * next tick instead of stacking up. A failure is logged and the next tick
 * tries again.
 *
 * AND NEVER WEDGES IT. A slot is a lease, not a flag: a pass still running
 * PASS_LEASE_MS after it started is presumed hung (a database call that never
 * answers), and the next tick starts another beside it. That is safe because
 * every pass is already safe to run twice at once — two replicas do exactly
 * that: jobs fence their writes by lease and attempt (jobs.ts), notify claims
 * each subscription and delivery by compare-and-set (notify.ts), and retention
 * is idempotent DELETEs. Without the lease one hung call silenced that pass
 * until the process restarted, and jobs.ts's own stale-pass recovery was never
 * reached. The WAIT on the database is bounded too (boundedDb): the pass stops
 * waiting on any one statement after CALL_TIMEOUT_MS and on a whole transaction
 * (asking the pool for a connection, its statements and COMMIT) after
 * TX_TIMEOUT_MS, and inside a transaction Postgres itself cancels a statement
 * past STATEMENT_TIMEOUT_MS or a lock wait past LOCK_TIMEOUT_MS. What those
 * bounds do not reach is in boundedDb's comment.
 */
import { createPublicClient, http } from "viem";
import { robinhoodChain } from "../../../packages/core/src/index";
import type { Db } from "../db";
import { ensureMcpSchema } from "./schema";
import { JOB_LIMITS, oracleFeedReader, runMcpJobsPass } from "./jobs";
import { chainlinkPriceReader, hostedNotifyDeps, runNotifyPass, type NotifyDeps } from "./notify";
import { runMcpMaintenancePass } from "./maintenance";

/**
 * How long a pass may hold its slot before the next tick may start another.
 * Longer than any pass runs when it is healthy (a jobs pass's own lease is its
 * 20 s budget plus 60 s, a notify pass stops at its 8 s budget plus one send's
 * 10 s timeout), so a live pass is never doubled; short enough that a hung one
 * costs minutes, not the rest of the process's life.
 */
export const PASS_LEASE_MS = Math.max(120_000, (JOB_LIMITS.passBudgetMs + JOB_LIMITS.leaseSlackSec * 1000) + 10_000);
/** Postgres cancels one statement of a background transaction after this (SET LOCAL statement_timeout). */
export const STATEMENT_TIMEOUT_MS = 15_000;
/** Postgres gives up one lock wait of a background transaction after this (SET LOCAL lock_timeout). */
export const LOCK_TIMEOUT_MS = 5_000;
/** The pass stops waiting on any one database call after this: past the server's own cut-off, so that normally fires first. */
export const CALL_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 5_000;
/**
 * The pass stops waiting on one transaction after this, from asking the pool
 * for a connection to COMMIT: longer than any one call it holds, so a single
 * slow statement is cut by the server or by CALL_TIMEOUT_MS first, and well
 * inside PASS_LEASE_MS.
 */
export const TX_TIMEOUT_MS = CALL_TIMEOUT_MS + 10_000;

export interface McpBackgroundOptions {
  /** The shared Postgres (the same pooled driver the mirror uses). */
  shared: () => Promise<Db>;
  log: (line: string) => void;
  rpcUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seams. Milliseconds, monotonic by default. */
  clockMs?: () => number;
  leaseMs?: number;
  callTimeoutMs?: number;
  txTimeoutMs?: number;
}

export function mcpBackgroundEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.DATABASE_URL && env.MERRYMEN_MCP_ENABLED !== "0";
}

/** A database call that did not answer within the pass's bound. Its name is all a log line carries. */
export class DbCallTimeout extends Error {
  constructor() {
    super("database call timed out");
    this.name = "DbCallTimeout";
  }
}

/**
 * Rejects with DbCallTimeout when `p` has not settled within `ms`, calling
 * `onTimeout` first. `p` itself is not cancelled (a later rejection of it is
 * handled by the race, never unhandled).
 */
function withDeadline<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new DbCallTimeout());
      }, ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface DbBounds {
  /** Client-side: the most any one call is waited on. */
  callMs: number;
  /** Client-side: the most one transaction is waited on, pool checkout and COMMIT included. */
  txMs: number;
  /** Server-side, inside transactions (Postgres only). */
  statementMs: number;
  lockMs: number;
  postgres: boolean;
}

/**
 * The shared Db, bounded for background work, so a pass cannot wait for ever
 * on a pool that never hands out a connection, a half-open socket or a row
 * lock: it fails, logs, and the next tick retries.
 *
 * - Every statement races `callMs`.
 * - Every transaction races `txMs` as a whole: the pool checkout (the pool has
 *   no connection timeout of its own), each statement, COMMIT. A transaction
 *   the pass has stopped waiting for is ABANDONED: if the pool hands it a
 *   connection later it runs nothing and rolls back, a statement it has not
 *   sent yet is never sent, and work that finishes late rolls back instead of
 *   committing. (One the deadline catches inside COMMIT may still commit;
 *   every pass is safe with that, as it is with a second replica.)
 * - Every transaction starts with SET LOCAL statement_timeout and lock_timeout,
 *   so Postgres also cancels a slow statement itself and hands the connection
 *   back clean. SET LOCAL ends with the transaction, so nothing leaks onto the
 *   pooled connection the mirror shares.
 *
 * NOT BOUNDED HERE, because the Db seam cannot reach it: the CONNECTION. A
 * statement stuck on a half-open socket keeps its connection checked out, and
 * a ROLLBACK queues behind it, until the socket itself fails; the pool sets no
 * query timeout or keepalive (worker/src/db.ts). A statement outside a
 * transaction that the pass stopped waiting for still runs whenever the pool
 * gets to it, and has only the client-side bound (a session-level SET would
 * leak onto the shared connection, and the seam has no per-statement options);
 * retention runs each DELETE in its own transaction for that reason
 * (maintenance.ts).
 */
export function boundedDb(db: Db, b: DbBounds): Db {
  return boundedWithin(db, b, () => false);
}

/** `boundedDb` for a handle inside a transaction: `abandoned` says the pass has stopped waiting for that transaction. */
function boundedWithin(db: Db, b: DbBounds, abandoned: () => boolean): Db {
  const call = <T>(send: () => Promise<T>): Promise<T> =>
    abandoned() ? Promise.reject(new DbCallTimeout()) : withDeadline(send(), b.callMs);
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => call(() => stmt.run(...params)),
        get: (...params) => call(() => stmt.get(...params)),
        all: (...params) => call(() => stmt.all(...params)),
      };
    },
    exec: (sql) => call(() => db.exec(sql)),
    tx: (fn) => {
      let gaveUp = false;
      const dropped = () => gaveUp || abandoned();
      const work = db.tx(async (tx) => {
        // Handed a connection after the pass stopped waiting: do nothing, roll back, give it back.
        if (dropped()) throw new DbCallTimeout();
        const bounded = boundedWithin(tx, b, dropped);
        if (b.postgres) {
          // Integers are milliseconds to Postgres; SET takes no bind parameters.
          await bounded.prepare(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(b.statementMs))}`).run();
          await bounded.prepare(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(b.lockMs))}`).run();
        }
        const out = await fn(bounded);
        // Never COMMIT what the pass has already reported as failed.
        if (dropped()) throw new DbCallTimeout();
        return out;
      });
      return withDeadline(work, b.txMs, () => {
        gaveUp = true;
      });
    },
  };
}

type PassName = "jobs" | "notify" | "maintenance";

/** Returns a tick function for the reconcile loop. Cheap when there is nothing to do. */
export function makeMcpBackground(o: McpBackgroundOptions): () => void {
  const env = o.env ?? process.env;
  const clock = o.clockMs ?? (() => performance.now());
  const leaseMs = o.leaseMs ?? PASS_LEASE_MS;
  const bounds: DbBounds = {
    callMs: o.callTimeoutMs ?? CALL_TIMEOUT_MS,
    txMs: o.txTimeoutMs ?? TX_TIMEOUT_MS,
    statementMs: STATEMENT_TIMEOUT_MS,
    lockMs: LOCK_TIMEOUT_MS,
    postgres: true,
  };
  let schema: Promise<boolean> | null = null;
  /** Each pass's slot: when the running one started, and which one it is (a late finisher must not free a newer pass's slot). */
  const slots = new Map<PassName, { gen: number; startedAt: number }>();
  let generation = 0;
  let notifyDeps: NotifyDeps | null = null;
  const readFeed = oracleFeedReader(o.rpcUrl);
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const ready = async (db: Db): Promise<boolean> => {
    if (!schema) {
      const attempt: Promise<boolean> = ensureMcpSchema(db, "postgres").then(() => true, (error: unknown) => {
        o.log(`mcp: could not create its tables (${reason(error)}); retrying next pass`);
        if (schema === attempt) schema = null;
        return false;
      });
      schema = attempt;
    }
    const current = schema;
    // The schema step is one shared promise: if it hangs, every pass would
    // hang on it with it, so it is waited on no longer than one call.
    try {
      return await withDeadline(current, bounds.callMs);
    } catch {
      if (schema === current) schema = null;
      o.log("mcp: creating its tables did not finish in time; retrying next pass");
      return false;
    }
  };

  const start = (name: PassName, run: (db: Db) => Promise<unknown>) => {
    const now = clock();
    const held = slots.get(name);
    if (held && now - held.startedAt < leaseMs) return;
    if (held) o.log(`mcp: the ${name} pass started ${Math.round((now - held.startedAt) / 1000)} s ago has not finished; starting another beside it`);
    const mine = { gen: ++generation, startedAt: now };
    slots.set(name, mine);
    void (async () => {
      try {
        const db = boundedDb(await withDeadline(o.shared(), bounds.callMs), bounds);
        if (!(await ready(db))) return;
        await run(db);
      } catch (error) {
        o.log(`mcp: ${name} pass failed (${reason(error)})`);
      } finally {
        if (slots.get(name)?.gen === mine.gen) slots.delete(name);
      }
    })();
  };

  return () => {
    if (!mcpBackgroundEnabled(env)) return;
    start("jobs", async (db) => {
      const r = await runMcpJobsPass(db, { readFeed, log: o.log });
      if (r.job) o.log(`mcp: backtest ${r.job.id} ${r.job.outcome} (attempt ${r.job.attempt}, ${r.job.ms} ms)`);
      if (r.error) o.log(`mcp: jobs pass error (${r.error})`);
    });
    start("notify", async (db) => {
      notifyDeps ??= hostedNotifyDeps(db, {
        price: chainlinkPriceReader(createPublicClient({ chain: robinhoodChain, transport: http(o.rpcUrl) }) as never),
        log: o.log,
      });
      await runNotifyPass(db, notifyDeps);
    });
    start("maintenance", async (db) => {
      const r = await runMcpMaintenancePass(db);
      if (r.ran && r.errors) o.log(`mcp: retention pass finished with ${r.errors} statement error(s)`);
    });
  };
}
