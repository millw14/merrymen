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
 * reached. The database work is bounded too (boundedDb): every call gives up
 * after CALL_TIMEOUT_MS, and inside a transaction Postgres itself cancels a
 * statement past STATEMENT_TIMEOUT_MS or a lock wait past LOCK_TIMEOUT_MS.
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

/** Rejects with DbCallTimeout when `p` has not settled within `ms`. `p` itself is not cancelled. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DbCallTimeout()), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface DbBounds {
  /** Client-side: the most any one call is waited on. */
  callMs: number;
  /** Server-side, inside transactions (Postgres only). */
  statementMs: number;
  lockMs: number;
  postgres: boolean;
}

/**
 * The shared Db, bounded for background work. Every call races `callMs`, so a
 * pass cannot wait for ever on a pool that never hands out a connection, a
 * half-open socket or a row lock; it fails, logs, and the next tick retries.
 * Every transaction starts with SET LOCAL statement_timeout and lock_timeout,
 * so Postgres also cancels the statement itself and hands the connection back
 * clean. SET LOCAL ends with the transaction, so nothing leaks onto the pooled
 * connection the mirror shares; statements outside a transaction have only the
 * client-side bound (a session-level SET would leak, and the Db seam has no
 * per-statement options). Retention runs each DELETE in its own transaction
 * for that reason (maintenance.ts).
 */
export function boundedDb(db: Db, b: DbBounds): Db {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => withDeadline(stmt.run(...params), b.callMs),
        get: (...params) => withDeadline(stmt.get(...params), b.callMs),
        all: (...params) => withDeadline(stmt.all(...params), b.callMs),
      };
    },
    exec: (sql) => withDeadline(db.exec(sql), b.callMs),
    tx: (fn) =>
      db.tx(async (tx) => {
        const bounded = boundedDb(tx, b);
        if (b.postgres) {
          // Integers are milliseconds to Postgres; SET takes no bind parameters.
          await bounded.prepare(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(b.statementMs))}`).run();
          await bounded.prepare(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(b.lockMs))}`).run();
        }
        return fn(bounded);
      }),
  };
}

type PassName = "jobs" | "notify" | "maintenance";

/** Returns a tick function for the reconcile loop. Cheap when there is nothing to do. */
export function makeMcpBackground(o: McpBackgroundOptions): () => void {
  const env = o.env ?? process.env;
  const clock = o.clockMs ?? (() => performance.now());
  const leaseMs = o.leaseMs ?? PASS_LEASE_MS;
  const bounds: DbBounds = { callMs: o.callTimeoutMs ?? CALL_TIMEOUT_MS, statementMs: STATEMENT_TIMEOUT_MS, lockMs: LOCK_TIMEOUT_MS, postgres: true };
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
