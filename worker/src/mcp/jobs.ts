/**
 * Durable jobs behind the MCP `jobs:run` scope: a queue in `mcp_jobs` that the
 * web tier writes and the orchestrator drains, at most one job per pass.
 *
 * WHY A QUEUE AND NOT THE CONNECTION. A tool call has a 15-second budget and a
 * client can vanish mid-call; a backtest over two months of hourly bars and four
 * variants does not fit either. So the tool only validates and enqueues, and the
 * work happens here, in the orchestrator's process, where it survives the client
 * disconnecting and is bounded by budgets the client cannot change.
 *
 * The state machine, and who moves it:
 *
 *   queued  ──claim──▶ running ──▶ succeeded | failed | cancelled | expired   (the runner)
 *   queued  ──────────────────────▶ cancelled                                  (the owner)
 *   queued  ──────────────────────▶ expired                                    (sweep, past deadline)
 *   running, lease lapsed ────────▶ running again, attempts + 1                (claim; at most 3 attempts)
 *                         ────────▶ cancelled | expired | failed(worker_lost)  (sweep)
 *
 * Every write the runner makes is FENCED on (status = 'running', attempts = the
 * attempt it claimed). A worker that stalled past its lease and was re-claimed by
 * another cannot overwrite the newer attempt's progress or result; it finds zero
 * rows changed and stops.
 *
 * Nothing here reads a secret or a ledger row. A job's inputs are its validated
 * params and public price history; its output is a simulation that says so.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db";
import type { Bar, BacktestConfig, BacktestResult } from "../backtest";
import type { FeedHistory, FeedPoint } from "../read-feed-history";
import type { Strategy } from "../strategies/types";
// The two leaf modules, not the core index: the web tier imports this file for
// the queue functions and has no use for the rest of core's graph here.
import { CASH, STOCK_TOKENS } from "../../../packages/core/src/tokens";
import { MORPHO } from "../../../packages/core/src/protocols";

// ── limits ──────────────────────────────────────────────────────────────────

export const JOB_LIMITS = {
  /** Queued + running jobs one owner may have at once. */
  maxActivePerTenant: 2,
  /** Claims of one job before a lapsed lease is treated as a job that kills its worker. */
  maxAttempts: 3,
  /** A job not finished this long after it was queued is expired, running or not. */
  deadlineSec: 3600,
  /** Wall-clock budget for one pass (and so for one job: a job never spans passes). */
  passBudgetMs: 20_000,
  /** Lease = the pass budget plus this, renewed on every progress write. */
  leaseSlackSec: 60,
  resultMaxBytes: 64 * 1024,
  maxVariants: 4,
  maxSymbols: 8,
  oracleMaxDays: 60,
  syntheticMaxDays: 365,
  minInitialUsdg: 100,
  maxInitialUsdg: 1_000_000,
  maxUsdgSetting: 1_000_000,
  maxExecutionCostBps: 500,
  equityPoints: 100,
} as const;

export const BACKTEST_STRATEGIES = ["steady-basket", "weekend-gap"] as const;
export type BacktestStrategy = (typeof BACKTEST_STRATEGIES)[number];
export type BacktestData = "oracle" | "synthetic";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(["succeeded", "failed", "cancelled", "expired"]);

/** Error codes a finished job can carry. Messages are always this module's own text. */
export type JobErrorCode = "timeout" | "expired" | "upstream_unavailable" | "insufficient_data" | "invalid_params" | "worker_lost" | "internal";

/**
 * An oracle round older than this at a bar marks the symbol stale there. It is
 * the LIVE agent's rule (snapshot.ts: `now - updatedAt > 2 * 3600`), not a
 * chart's: weekend-gap enters on stale and the basket strategies skip stale
 * legs, so a different threshold here would replay different decisions from
 * the ones the agent makes. jobs.test.ts pins the two together.
 */
export const ORACLE_STALE_AFTER_SEC = 2 * 3600;
/** A silence longer than this is a session break (a night or a weekend); coverage counts them. */
export const ORACLE_SESSION_BREAK_SEC = 6 * 3600;
const HOUR = 3600;
const DAY = 86_400;

/** Namespace for the per-tenant advisory lock that makes the active-job quota race-free on Postgres. */
const JOBS_LOCK_NS = 1_297_692_103;

// ── params ──────────────────────────────────────────────────────────────────

export interface BacktestVariant {
  label: string;
  buy_per_tick_usdg?: number;
  idle_floor_usdg?: number;
  gap_enter_budget_usdg?: number;
  per_trade_usdg?: number;
  daily_usdg?: number;
  max_drawdown_pct?: number;
  execution_cost_bps?: number;
}

export interface BacktestParams {
  strategy: BacktestStrategy;
  symbols: string[];
  data: BacktestData;
  days: number;
  initial_usdg: number;
  /** Synthetic only; the seed actually used (42 when none was given). Null for oracle data. */
  seed: number | null;
  variants: BacktestVariant[];
}

const PARAM_KEYS = new Set(["strategy", "symbols", "data", "days", "initial_usdg", "seed", "variants"]);
const VARIANT_USDG_KEYS = ["buy_per_tick_usdg", "idle_floor_usdg", "gap_enter_budget_usdg", "per_trade_usdg", "daily_usdg"] as const;
const VARIANT_KEYS = new Set(["label", ...VARIANT_USDG_KEYS, "max_drawdown_pct", "execution_cost_bps"]);
export const VARIANT_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
const DEFAULT_SEED = 42;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cents = (v: number) => Math.round(v * 100) / 100;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The one validator for backtest params, used by the tool before it enqueues
 * AND by the runner before it runs: a row is data at rest, and the runner does
 * not take the web tier's word for what is in it.
 *
 * Returns the NORMALISED params (canonical symbols, money rounded to cents, the
 * seed made explicit), in a fixed key order, so equal requests serialise to
 * equal JSON and the idempotency check can compare strings.
 */
export function validateBacktestParams(raw: unknown): { ok: true; params: BacktestParams } | { ok: false; why: string } {
  const fail = (why: string) => ({ ok: false as const, why });
  if (!isObj(raw)) return fail("params must be an object");
  for (const k of Object.keys(raw)) if (!PARAM_KEYS.has(k)) return fail(`unknown field "${k.slice(0, 32)}"`);

  const strategy = raw.strategy;
  if (typeof strategy !== "string" || !(BACKTEST_STRATEGIES as readonly string[]).includes(strategy)) {
    return fail(`strategy must be one of ${BACKTEST_STRATEGIES.join(", ")} (llm-strategist and trencher depend on live inputs — a model, launchpad candidates — that have no history to replay; the holder-only strategies are not offered here)`);
  }
  const data = raw.data;
  if (data !== "oracle" && data !== "synthetic") return fail("data must be 'oracle' or 'synthetic'");

  const maxDays = data === "oracle" ? JOB_LIMITS.oracleMaxDays : JOB_LIMITS.syntheticMaxDays;
  if (!finite(raw.days) || !Number.isInteger(raw.days) || raw.days < 1 || raw.days > maxDays) {
    return fail(data === "oracle"
      ? `days must be a whole number from 1 to ${maxDays} for oracle data (the feeds keep about two months of rounds)`
      : `days must be a whole number from 1 to ${maxDays} for synthetic data`);
  }
  if (!finite(raw.initial_usdg) || raw.initial_usdg < JOB_LIMITS.minInitialUsdg || raw.initial_usdg > JOB_LIMITS.maxInitialUsdg) {
    return fail(`initial_usdg must be from ${JOB_LIMITS.minInitialUsdg} to ${JOB_LIMITS.maxInitialUsdg}`);
  }

  let seed: number | null = null;
  if (raw.seed !== undefined && raw.seed !== null) {
    if (data !== "synthetic") return fail("seed only applies to synthetic data");
    if (!finite(raw.seed) || !Number.isInteger(raw.seed) || raw.seed < 0 || raw.seed > 2_147_483_647) return fail("seed must be a whole number from 0 to 2147483647");
    seed = raw.seed;
  } else if (data === "synthetic") {
    seed = DEFAULT_SEED;
  }

  if (!Array.isArray(raw.symbols) || raw.symbols.length < 1 || raw.symbols.length > JOB_LIMITS.maxSymbols) {
    return fail(`symbols must list 1 to ${JOB_LIMITS.maxSymbols} stock or ETF tokens`);
  }
  const symbols: string[] = [];
  for (const s of raw.symbols) {
    if (typeof s !== "string" || !/^[A-Za-z0-9]{1,12}$/.test(s)) return fail("each symbol must be a ticker such as NVDA");
    const token = STOCK_TOKENS.find((t) => t.symbol.toUpperCase() === s.toUpperCase());
    // The kind check is belt and braces: the registry holds only stocks and
    // ETFs today, and a memecoin added to it later must not become backtestable
    // by accident — a curve has no history and no fill model here.
    if (!token || token.kind === "memecoin") return fail(`${s} is not one of Merrymen's stock or ETF tokens (memecoins and launchpad coins cannot be backtested: they have no price history to replay)`);
    if (symbols.includes(token.symbol)) return fail(`${token.symbol} is listed twice`);
    if (data === "oracle" && !token.chainlinkFeed) return fail(`${token.symbol} has no Chainlink feed, so there is no oracle history for it; use data 'synthetic' or another symbol`);
    symbols.push(token.symbol);
  }

  if (!Array.isArray(raw.variants) || raw.variants.length < 1 || raw.variants.length > JOB_LIMITS.maxVariants) {
    return fail(`variants must list 1 to ${JOB_LIMITS.maxVariants} settings to compare`);
  }
  const variants: BacktestVariant[] = [];
  const labels = new Set<string>();
  for (const v of raw.variants) {
    if (!isObj(v)) return fail("each variant must be an object");
    for (const k of Object.keys(v)) if (!VARIANT_KEYS.has(k)) return fail(`unknown variant field "${k.slice(0, 32)}"`);
    if (typeof v.label !== "string" || !VARIANT_LABEL_RE.test(v.label)) return fail("each variant needs a label: 1-40 letters, digits, spaces, _ . or -");
    const key = v.label.toLowerCase();
    if (labels.has(key)) return fail(`variant label "${v.label}" is used twice`);
    labels.add(key);
    const out: BacktestVariant = { label: v.label };
    for (const k of VARIANT_USDG_KEYS) {
      const x = v[k];
      if (x === undefined) continue;
      if (!finite(x) || cents(x) <= 0 || x > JOB_LIMITS.maxUsdgSetting) return fail(`${v.label}: ${k} must be above 0 and at most ${JOB_LIMITS.maxUsdgSetting}`);
      out[k] = cents(x);
    }
    if (v.max_drawdown_pct !== undefined) {
      if (!finite(v.max_drawdown_pct) || v.max_drawdown_pct < 1 || v.max_drawdown_pct > 100) return fail(`${v.label}: max_drawdown_pct must be from 1 to 100`);
      out.max_drawdown_pct = cents(v.max_drawdown_pct);
    }
    if (v.execution_cost_bps !== undefined) {
      const c = v.execution_cost_bps;
      if (!finite(c) || !Number.isInteger(c) || c < 0 || c > JOB_LIMITS.maxExecutionCostBps) return fail(`${v.label}: execution_cost_bps must be a whole number from 0 to ${JOB_LIMITS.maxExecutionCostBps}`);
      out.execution_cost_bps = c;
    }
    variants.push(out);
  }

  return {
    ok: true,
    params: { strategy: strategy as BacktestStrategy, symbols, data, days: raw.days, initial_usdg: cents(raw.initial_usdg), seed, variants },
  };
}

/**
 * Settings a variant leaves unset: `merrymen strategy backtest`'s defaults
 * (25 / 50 / 100 / 500 / 500 on 1,000 USDG, 30 bps, 20% drawdown), scaled to
 * the run's starting cash so a 100,000 USDG run is not a 1,000 USDG run with
 * idle money.
 */
export function resolveVariant(p: BacktestParams, v: BacktestVariant) {
  const i = p.initial_usdg;
  return {
    buy_per_tick_usdg: v.buy_per_tick_usdg ?? cents(i * 0.025),
    idle_floor_usdg: v.idle_floor_usdg ?? cents(i * 0.05),
    gap_enter_budget_usdg: v.gap_enter_budget_usdg ?? cents(i * 0.1),
    per_trade_usdg: v.per_trade_usdg ?? cents(i * 0.5),
    daily_usdg: v.daily_usdg ?? cents(i * 0.5),
    max_drawdown_pct: v.max_drawdown_pct ?? 20,
    execution_cost_bps: v.execution_cost_bps ?? 30,
  };
}

// ── rows ────────────────────────────────────────────────────────────────────

export interface JobRow {
  id: string;
  tenant: string;
  connection_id: string | null;
  kind: string;
  params_json: string;
  status: JobStatus;
  progress: number;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string | null;
  cancel_requested: number;
  attempts: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  lease_until: number | null;
  deadline_at: number;
}

/** Every column but the result, for listings that must stay small. */
const LIST_COLUMNS = "id, tenant, connection_id, kind, params_json, status, progress, NULL AS result_json, error_code, error_message, idempotency_key, cancel_requested, attempts, created_at, started_at, finished_at, lease_until, deadline_at";
const ALL_COLUMNS = "id, tenant, connection_id, kind, params_json, status, progress, result_json, error_code, error_message, idempotency_key, cancel_requested, attempts, created_at, started_at, finished_at, lease_until, deadline_at";

/** Postgres hands REAL/BIGINT back as numbers (db.ts), sqlite as numbers too; this only guards nulls and strings. */
function normalizeRow(r: Record<string, unknown>): JobRow {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    ...(r as unknown as JobRow),
    progress: Number(r.progress ?? 0),
    cancel_requested: Number(r.cancel_requested ?? 0),
    attempts: Number(r.attempts ?? 0),
    created_at: Number(r.created_at),
    started_at: n(r.started_at),
    finished_at: n(r.finished_at),
    lease_until: n(r.lease_until),
    deadline_at: Number(r.deadline_at),
  };
}

export class JobError extends Error {
  constructor(readonly code: "conflict" | "quota_exceeded" | "not_found", message: string) {
    super(message);
    this.name = "JobError";
  }
}

function tenantLockKey(tenant: string): number {
  return createHash("sha256").update(`mcp-jobs:${tenant}`).digest().readInt32BE(0);
}

async function rowFor(db: Db, tenant: string, id: string): Promise<JobRow | null> {
  const r = await db.prepare(`SELECT ${ALL_COLUMNS} FROM mcp_jobs WHERE id = ? AND tenant = ?`).get(id, tenant) as Record<string, unknown> | undefined;
  return r ? normalizeRow(r) : null;
}

/**
 * Queue a backtest for an owner.
 *
 * The same idempotency key with the same params returns the existing job (any
 * status); with different params it is a conflict. A new job is refused while
 * the owner already has `maxActivePerTenant` queued or running — checked and
 * inserted under a per-tenant advisory lock on Postgres (sqlite serialises
 * writers on its own), so two simultaneous calls cannot both slip under it.
 */
export async function enqueueJob(db: Db, input: {
  tenant: string;
  connectionId: string | null;
  params: BacktestParams;
  idempotencyKey: string | null;
  now: number;
  dialect?: "postgres" | "sqlite";
}): Promise<{ row: JobRow; created: boolean }> {
  const tenant = input.tenant.toLowerCase();
  const paramsJson = JSON.stringify(input.params);
  const key = input.idempotencyKey;
  const sameOrConflict = (existing: JobRow) => {
    if (existing.kind !== "backtest" || existing.params_json !== paramsJson) {
      throw new JobError("conflict", "idempotency_key was already used for a different job");
    }
    return { row: existing, created: false };
  };
  try {
    return await db.tx(async (tx) => {
      if (input.dialect === "postgres") await tx.prepare("SELECT pg_advisory_xact_lock(?, ?)").get(JOBS_LOCK_NS, tenantLockKey(tenant));
      if (key) {
        const r = await tx.prepare(`SELECT ${ALL_COLUMNS} FROM mcp_jobs WHERE tenant = ? AND idempotency_key = ?`).get(tenant, key) as Record<string, unknown> | undefined;
        if (r) return sameOrConflict(normalizeRow(r));
      }
      const active = await tx.prepare("SELECT COUNT(*) AS n FROM mcp_jobs WHERE tenant = ? AND status IN ('queued', 'running')").get(tenant) as { n: number | string };
      if (Number(active.n) >= JOB_LIMITS.maxActivePerTenant) {
        throw new JobError("quota_exceeded", `You already have ${JOB_LIMITS.maxActivePerTenant} backtests queued or running. Wait for one to finish (get_job) or cancel one (cancel_job).`);
      }
      const id = `job_${randomBytes(16).toString("hex")}`;
      await tx.prepare(`INSERT INTO mcp_jobs (id, tenant, connection_id, kind, params_json, status, progress, result_json, error_code, error_message,
          idempotency_key, cancel_requested, attempts, created_at, started_at, finished_at, lease_until, deadline_at)
        VALUES (?, ?, ?, 'backtest', ?, 'queued', 0, NULL, NULL, NULL, ?, 0, 0, ?, NULL, NULL, NULL, ?)`)
        .run(id, tenant, input.connectionId, paramsJson, key, input.now, input.now + JOB_LIMITS.deadlineSec);
      const row = await tx.prepare(`SELECT ${ALL_COLUMNS} FROM mcp_jobs WHERE id = ?`).get(id) as Record<string, unknown>;
      return { row: normalizeRow(row), created: true };
    });
  } catch (error) {
    // Two submissions with one key from different processes: the unique index picked a winner.
    if (key && !(error instanceof JobError) && /unique|duplicate|constraint/i.test(error instanceof Error ? error.message : String(error))) {
      const r = await db.prepare(`SELECT ${ALL_COLUMNS} FROM mcp_jobs WHERE tenant = ? AND idempotency_key = ?`).get(tenant, key) as Record<string, unknown> | undefined;
      if (r) return sameOrConflict(normalizeRow(r));
    }
    throw error;
  }
}

/** One owner's job, or null (another owner's job is null too). */
export function getJobRow(db: Db, tenant: string, id: string): Promise<JobRow | null> {
  return rowFor(db, tenant.toLowerCase(), id);
}

/** One owner's jobs, newest first, without results. `before` is the last row of the previous page. */
export async function listJobRows(db: Db, tenant: string, o: { limit: number; before?: { created_at: number; id: string } | null }): Promise<JobRow[]> {
  const t = tenant.toLowerCase();
  const limit = Math.max(1, Math.min(100, Math.floor(o.limit)));
  const rows = o.before
    ? await db.prepare(`SELECT ${LIST_COLUMNS} FROM mcp_jobs WHERE tenant = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(t, o.before.created_at, o.before.created_at, o.before.id, limit)
    : await db.prepare(`SELECT ${LIST_COLUMNS} FROM mcp_jobs WHERE tenant = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(t, limit);
  return (rows as Record<string, unknown>[]).map(normalizeRow);
}

export type CancelOutcome = "cancelled" | "requested" | "already_finished";

/**
 * Cancel an owner's job. A queued job is cancelled on the spot; a running one
 * is asked to stop, and the runner does so before its next variant (or at its
 * next checkpoint inside one). Cancelling a finished job changes nothing.
 */
export async function cancelJob(db: Db, tenant: string, id: string, now: number): Promise<{ row: JobRow; outcome: CancelOutcome }> {
  const t = tenant.toLowerCase();
  const before = await rowFor(db, t, id);
  if (!before) throw new JobError("not_found", "No such job.");
  const queued = await db.prepare(`UPDATE mcp_jobs SET status = 'cancelled', cancel_requested = 1, finished_at = ?, lease_until = NULL
    WHERE id = ? AND tenant = ? AND status = 'queued'`).run(now, id, t);
  if (queued.changes === 1) return { row: (await rowFor(db, t, id))!, outcome: "cancelled" };
  // Claimed between the read and the update, or already running: ask it to stop.
  const running = await db.prepare(`UPDATE mcp_jobs SET cancel_requested = 1 WHERE id = ? AND tenant = ? AND status = 'running'`).run(id, t);
  const after = (await rowFor(db, t, id))!;
  return { row: after, outcome: running.changes === 1 ? "requested" : "already_finished" };
}

/**
 * Settle jobs nobody will finish: queued past the deadline, and running with a
 * lapsed lease that was cancelled, is past the deadline, or has used every
 * attempt. Scoped to one tenant when the web tier calls it (so a status read is
 * honest even while the orchestrator is down), fleet-wide from the pass.
 */
export async function sweepJobs(db: Db, now: number, tenant?: string): Promise<{ expired: number; cancelled: number; lost: number }> {
  const scope = tenant ? " AND tenant = ?" : "";
  const tp = tenant ? [tenant.toLowerCase()] : [];
  const expiredQueued = await db.prepare(`UPDATE mcp_jobs SET status = 'expired', finished_at = ?, error_code = 'expired', error_message = ?
    WHERE status = 'queued' AND deadline_at <= ?${scope}`)
    .run(now, "The background worker did not start it before its deadline.", now, ...tp);
  const cancelled = await db.prepare(`UPDATE mcp_jobs SET status = 'cancelled', finished_at = ?, lease_until = NULL
    WHERE status = 'running' AND lease_until < ? AND cancel_requested = 1${scope}`)
    .run(now, now, ...tp);
  const expiredRunning = await db.prepare(`UPDATE mcp_jobs SET status = 'expired', finished_at = ?, lease_until = NULL, error_code = 'expired', error_message = ?
    WHERE status = 'running' AND lease_until < ? AND deadline_at <= ?${scope}`)
    .run(now, "It passed its deadline before it could finish.", now, now, ...tp);
  const lost = await db.prepare(`UPDATE mcp_jobs SET status = 'failed', finished_at = ?, lease_until = NULL, error_code = 'worker_lost', error_message = ?
    WHERE status = 'running' AND lease_until < ? AND attempts >= ?${scope}`)
    .run(now, `The background worker stopped ${JOB_LIMITS.maxAttempts} times while running it, so it will not be tried again.`, now, JOB_LIMITS.maxAttempts, ...tp);
  return { expired: expiredQueued.changes + expiredRunning.changes, cancelled: cancelled.changes, lost: lost.changes };
}

export interface ClaimedJob {
  id: string;
  tenant: string;
  kind: string;
  params_json: string;
  /** The fencing token: every later write of this run is conditioned on it. */
  attempts: number;
  deadline_at: number;
}

/**
 * Claim the oldest runnable job: queued, or running with a lapsed lease and
 * attempts left (its worker died). Race-safe on both backends: the claim is
 * ONE UPDATE whose WHERE re-states the runnable condition. On Postgres, a
 * second claimer that picked the same id blocks on the row lock and, once the
 * first commits, re-checks that condition against the updated row (now running
 * with a fresh lease), so it updates nothing and gets no row back. sqlite runs
 * one writer at a time.
 */
export async function claimNextJob(db: Db, now: number, leaseSec: number): Promise<ClaimedJob | null> {
  const runnable = "status IN ('queued', 'running') AND deadline_at > ? AND cancel_requested = 0 AND (status = 'queued' OR (lease_until < ? AND attempts < ?))";
  const rows = await db.prepare(`UPDATE mcp_jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, started_at = COALESCE(started_at, ?)
    WHERE id = (SELECT id FROM mcp_jobs WHERE ${runnable} ORDER BY created_at, id LIMIT 1)
      AND ${runnable}
    RETURNING id, tenant, kind, params_json, attempts, deadline_at`)
    .all(now + leaseSec, now, now, now, JOB_LIMITS.maxAttempts, now, now, JOB_LIMITS.maxAttempts) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    tenant: String(r.tenant),
    kind: String(r.kind),
    params_json: String(r.params_json),
    attempts: Number(r.attempts),
    deadline_at: Number(r.deadline_at),
  };
}

/** Renew the lease and record progress. False when this attempt no longer owns the job. */
export async function heartbeatJob(db: Db, job: ClaimedJob, progress: number, now: number, leaseSec: number): Promise<boolean> {
  const p = Math.max(0, Math.min(1, progress));
  const r = await db.prepare("UPDATE mcp_jobs SET progress = ?, lease_until = ? WHERE id = ? AND status = 'running' AND attempts = ?")
    .run(Math.round(p * 1000) / 1000, now + leaseSec, job.id, job.attempts);
  return r.changes === 1;
}

/** Finish this attempt. False when it no longer owns the job (its lease lapsed and another attempt took over). */
export async function finishJob(db: Db, job: ClaimedJob, now: number, outcome:
  | { status: "succeeded"; result: unknown }
  | { status: "failed" | "expired"; code: JobErrorCode; message: string }
  | { status: "cancelled" }): Promise<boolean> {
  const result = outcome.status === "succeeded" ? JSON.stringify(outcome.result) : null;
  const code = outcome.status === "failed" || outcome.status === "expired" ? outcome.code : null;
  const message = outcome.status === "failed" || outcome.status === "expired" ? outcome.message : null;
  // Progress is decided here rather than in SQL: a bare `? = 'succeeded'`
  // leaves Postgres two untyped operands to guess at.
  const r = await db.prepare(`UPDATE mcp_jobs SET status = ?, progress = COALESCE(?, progress), result_json = ?,
      error_code = ?, error_message = ?, finished_at = ?, lease_until = NULL
    WHERE id = ? AND status = 'running' AND attempts = ?`)
    .run(outcome.status, outcome.status === "succeeded" ? 1 : null, result, code, message, now, job.id, job.attempts);
  return r.changes === 1;
}

async function controlOf(db: Db, job: ClaimedJob): Promise<{ owned: boolean; cancel: boolean }> {
  const r = await db.prepare("SELECT status, attempts, cancel_requested FROM mcp_jobs WHERE id = ?").get(job.id) as
    { status: string; attempts: number | string; cancel_requested: number | string } | undefined;
  if (!r || r.status !== "running" || Number(r.attempts) !== job.attempts) return { owned: false, cancel: false };
  return { owned: true, cancel: Number(r.cancel_requested) === 1 };
}

// ── oracle history → bars ───────────────────────────────────────────────────

export interface SymbolCoverage {
  symbol: string;
  /** Oracle rounds inside the window (synthetic: one per bar). */
  points: number;
  first_point_at: string | null;
  last_point_at: string | null;
  /** Share of bars at which this symbol was marked stale (market closed / feed silent). */
  stale_share: number;
  /** Silences between consecutive rounds longer than 6 hours (session breaks). Null for synthetic data. */
  gaps_over_6h: number | null;
  longest_gap_hours: number | null;
}

export interface DataCoverage {
  source: BacktestData;
  bar_interval: "1h" | "1d";
  bars: number;
  span: { from: string | null; to: string | null };
  requested_days: number;
  covered_days: number;
  method: string;
  symbols: SymbolCoverage[];
}

const iso = (sec: number) => new Date(sec * 1000).toISOString();
const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * Put each feed's rounds on one hourly grid.
 *
 * FORWARD-FILL, NEVER INTERPOLATE. A bar carries the last round published at
 * or before its time. Drawing between two rounds would state prices nobody
 * published — across a weekend, 64 hours of a closed market — and would leak
 * the NEXT round into the bars before it, which is lookahead.
 *
 * STALE IS AGE, NOT A CALENDAR. A symbol whose last round is older than
 * `staleAfterSec` (default: the live agent's 2 hours) at a bar is marked stale
 * there, which is what the live worker sees when a feed goes quiet and what
 * weekend-gap trades on. Holidays need no table: a silent feed is a silent feed.
 *
 * THE GRID STARTS WHERE EVERY SYMBOL HAS A PRICE. A feed keeps ~400 rounds, so a
 * busy feed reaches back fewer days than a quiet one; before a symbol's first
 * round it has no price, and a strategy holding it would be valued at nothing.
 * The window is shortened instead, and the coverage says by how much.
 */
export function resampleOracle(
  series: readonly { symbol: string; points: readonly FeedPoint[] }[],
  o: { endSec: number; days: number; stepSec?: number; staleAfterSec?: number },
): { bars: Bar[]; coverage: DataCoverage; warnings: string[] } {
  const step = o.stepSec ?? HOUR;
  const staleAfter = o.staleAfterSec ?? ORACLE_STALE_AFTER_SEC;
  const staleHours = round(staleAfter / HOUR, 2);
  const end = Math.floor(o.endSec / step) * step;
  const requestedStart = end - o.days * DAY;
  const clean = series.map((s) => ({
    symbol: s.symbol,
    points: s.points.filter((p) => Number.isFinite(p.at) && p.at > 0 && Number.isFinite(p.px) && p.px > 0 && p.at <= end)
      .slice().sort((a, b) => a.at - b.at),
  }));
  const empty = clean.some((s) => s.points.length === 0);
  const commonFirst = empty ? Infinity : Math.max(...clean.map((s) => s.points[0]!.at));
  const start = Math.max(requestedStart, Math.ceil(commonFirst / step) * step);

  const bars: Bar[] = [];
  const staleCount = new Map<string, number>(clean.map((s) => [s.symbol, 0]));
  if (Number.isFinite(start) && start <= end) {
    const cursor = new Map<string, number>(clean.map((s) => [s.symbol, -1]));
    for (let t = start; t <= end; t += step) {
      const prices = new Map<string, bigint>();
      const stale = new Set<string>();
      for (const s of clean) {
        let i = cursor.get(s.symbol)!;
        while (i + 1 < s.points.length && s.points[i + 1]!.at <= t) i += 1;
        cursor.set(s.symbol, i);
        if (i < 0) continue; // cannot happen after the common start; never priced as zero
        const p = s.points[i]!;
        prices.set(s.symbol, BigInt(Math.round(p.px * 1e8)));
        if (t - p.at > staleAfter) {
          stale.add(s.symbol);
          staleCount.set(s.symbol, staleCount.get(s.symbol)! + 1);
        }
      }
      bars.push({ tSec: t, prices, ...(stale.size ? { staleSymbols: stale } : {}) });
    }
  }

  const warnings: string[] = [];
  const symbols: SymbolCoverage[] = clean.map((s) => {
    const inWindow = bars.length ? s.points.filter((p) => p.at >= bars[0]!.tSec && p.at <= end) : [];
    let gaps = 0;
    let longest: number | null = null;
    for (let i = 1; i < inWindow.length; i++) {
      const g = inWindow[i]!.at - inWindow[i - 1]!.at;
      if (g > ORACLE_SESSION_BREAK_SEC) gaps += 1;
      longest = longest === null ? g : Math.max(longest, g);
    }
    const share = bars.length ? staleCount.get(s.symbol)! / bars.length : 0;
    if (bars.length && inWindow.length === 0) {
      warnings.push(`${s.symbol}: no oracle round inside the window; it is held at its last earlier round and marked stale wherever that round is over ${staleHours} hours old.`);
    } else if (share > 0.5) {
      warnings.push(`${s.symbol} was marked stale at ${Math.round(share * 100)}% of bars (market closed or feed silent).`);
    }
    return {
      symbol: s.symbol,
      points: inWindow.length,
      first_point_at: inWindow.length ? iso(inWindow[0]!.at) : null,
      last_point_at: inWindow.length ? iso(inWindow[inWindow.length - 1]!.at) : null,
      stale_share: round(share, 3),
      gaps_over_6h: gaps,
      longest_gap_hours: longest === null ? null : round(longest / HOUR, 1),
    };
  });

  const covered = bars.length > 1 ? round((bars[bars.length - 1]!.tSec - bars[0]!.tSec) / DAY, 1) : 0;
  if (bars.length > 1 && covered < o.days - 0.5) {
    warnings.push(`Oracle history covered ${covered} of the ${o.days} requested days (each feed keeps about 400 rounds, and the window starts where every symbol has one); results cover the shorter window.`);
  }
  return {
    bars,
    warnings,
    coverage: {
      source: "oracle",
      bar_interval: "1h",
      bars: bars.length,
      span: { from: bars.length ? iso(bars[0]!.tSec) : null, to: bars.length ? iso(bars[bars.length - 1]!.tSec) : null },
      requested_days: o.days,
      covered_days: covered,
      method: `Chainlink rounds resampled to an hourly grid by forward-fill (the last round at or before each bar; never interpolated). A symbol is stale at a bar when its last round is over ${staleHours} hours old, the live agent's rule.`,
      symbols,
    },
  };
}

// ── results ─────────────────────────────────────────────────────────────────

export interface VariantResult {
  label: string;
  settings: ReturnType<typeof resolveVariant>;
  final_equity_usdg: number;
  pnl_usdg: number;
  return_pct: number;
  max_drawdown_bps: number;
  /** Intents the policy wall passed: swaps and vault moves. */
  executed_operations: number;
  /** Swaps that actually filled (a passed intent can still find no price or no cash). */
  swap_fills: number;
  turnover_usdg: number;
  rejected_by_rule: { rule: string; count: number }[];
  equity_series: { t: string; equity_usdg: number }[];
}

export interface BacktestJobResult {
  kind: "backtest";
  strategy: BacktestStrategy;
  data: BacktestData;
  symbols: string[];
  initial_usdg: number;
  seed: number | null;
  variants: VariantResult[];
  assumptions: {
    execution_cost_bps: string;
    fills: string;
    budgets: string;
    vault_apy_bps: number;
    vault_apy_note: string;
    limits: string;
    defaults: string;
  };
  data_coverage: DataCoverage;
  warnings: string[];
  limitations: string[];
  lookahead: string;
  disclaimer: string;
  computed_at: string;
  compute_ms: number;
}

const usdgNum = (raw: bigint) => round(Number(raw) / 1e6, 2);
const usdg6 = (v: number) => BigInt(Math.round(v * 1e6));

/** Evenly spaced points, always keeping the first and the last. */
export function downsample<T>(xs: readonly T[], max: number): T[] {
  if (xs.length <= max) return [...xs];
  if (max <= 1) return xs.length ? [xs[xs.length - 1]!] : [];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (max - 1))]!);
  return out;
}

function variantResult(p: BacktestParams, label: string, settings: ReturnType<typeof resolveVariant>, r: BacktestResult, points: number): VariantResult {
  const initial = usdg6(p.initial_usdg);
  return {
    label,
    settings,
    final_equity_usdg: usdgNum(r.finalEquityUsdg),
    pnl_usdg: usdgNum(r.pnlUsdg),
    return_pct: initial > 0n ? round((Number(r.pnlUsdg) / Number(initial)) * 100, 2) : 0,
    max_drawdown_bps: r.maxDrawdownBps,
    executed_operations: r.executed,
    swap_fills: r.swapFills,
    turnover_usdg: usdgNum(r.turnoverUsdg),
    rejected_by_rule: [...r.rejected].sort((a, b) => b.count - a.count).slice(0, 20),
    equity_series: downsample(r.equitySeries, points).map((e) => ({ t: iso(e.tSec), equity_usdg: usdgNum(e.equityUsdg) })),
  };
}

const LIMITATIONS_COMMON = [
  "No memecoins or launchpad coins: they have no oracle history, and bonding-curve fills are not simulated. Only stock and ETF tokens.",
  "Only steady-basket and weekend-gap: llm-strategist and trencher depend on live inputs (a model, launchpad candidates) that have no history to replay, and the holder-only strategies are not offered here.",
  "Settings a variant does not list (take-profit, custom tokens, Telegram controls) are off.",
];
const LIMITATIONS_ORACLE = [
  "The oracle is not a market: prices are what Chainlink published (about 400 rounds, roughly two months per feed), while the token itself trades around the clock at its own pool price.",
  "Weekends and closures: the feed is silent, so prices are held at the last round and marked stale once it is over 2 hours old, as the live agent does; weekend-gap enters and exits at oracle prices, not at the token's weekend market price.",
];
const LIMITATIONS_SYNTHETIC = [
  "Synthetic data is a seeded random walk, not history: it shows how the strategy and its limits behave, not how it would have done.",
];

function assumptions(): BacktestJobResult["assumptions"] {
  return {
    execution_cost_bps: "Per variant (settings.execution_cost_bps, default 30): a flat cost taken from every fill's notional.",
    fills: "At the bar's price, with no depth, queue, price impact or MEV: size never moves the price.",
    budgets: "The daily spend and operation budgets reset at each calendar day (UTC); a live agent's budget is a rolling 24 hours.",
    vault_apy_bps: 0,
    vault_apy_note: "Cash steady-basket parks in the savings vault earns nothing here: there is no vault rate history to replay.",
    limits: "Per-trade, daily and drawdown limits come from each variant's settings; at most 500 operations a day; the permission never expires inside the run.",
    defaults: "Unset settings take `merrymen strategy backtest`'s defaults scaled to initial_usdg: buy per tick 2.5%, idle floor 5%, gap budget 10%, per trade 50%, daily 50%, drawdown 20%, cost 30 bps.",
  };
}

// ── the pass ────────────────────────────────────────────────────────────────

export interface McpJobsPassDeps {
  /** Logical clock, unix seconds (timestamps, leases, deadlines). */
  now?: () => number;
  /**
   * Oracle history for one feed: `oracleFeedReader(process.env.MERRYMEN_RPC_MAINNET)`
   * in the orchestrator, built once per process (read-feed-history.ts says why
   * the caller supplies the client). Absent, oracle jobs fail with
   * upstream_unavailable rather than reach for a client of their own.
   */
  readFeed?: (feed: `0x${string}`) => Promise<FeedHistory>;
  /** Wall-clock budget for this pass, ms. Default JOB_LIMITS.passBudgetMs. */
  maxMs?: number;
  /** Called after each progress write (metrics; a test seam). */
  onProgress?: (jobId: string, progress: number) => void | Promise<void>;
  log?: (message: string) => void;
  /** Monotonic wall clock in ms for the compute budget and the stuck-pass guard. Default performance.now (a test seam). */
  clockMs?: () => number;
}

export interface McpJobsPassSummary {
  skipped: "busy" | null;
  swept: { expired: number; cancelled: number; lost: number };
  job: { id: string; outcome: JobStatus | "lease_lost"; attempt: number; ms: number } | null;
  /** Set when the pass itself failed (for example the database was unreachable). Never a raw error text. */
  error: string | null;
}

class Stop extends Error {
  constructor(readonly outcome: "cancelled" | "expired" | "timeout" | "lease_lost") {
    super(outcome);
    this.name = "Stop";
  }
}
class JobFailure extends Error {
  constructor(readonly code: JobErrorCode, message: string) {
    super(message);
    this.name = "JobFailure";
  }
}

/** Ticks between event-loop yields and control checks (cancel, deadline, lease) inside one variant. */
const CHECK_EVERY_TICKS = 200;
/** The simulation's router and vault are addresses the policy allowlist names; nothing is ever sent to them. */
const SIM_ROUTER = "0x0000000000000000000000000000000000000001" as const;

/**
 * The pass running in this process, if any. `staleAt` is when its lease runs
 * out: a pass still "running" after that is wedged (a database call that never
 * answers), its job is claimable again anyway, and every write it might still
 * make is fenced — so it stops blocking the next pass instead of silencing the
 * queue in this process until a restart. `gen` keeps a wedged pass that finally
 * returns from clearing a newer pass's guard.
 */
let inFlight: { gen: number; staleAt: number } | null = null;
let generation = 0;

/**
 * One background pass: settle abandoned jobs, then claim AT MOST ONE job and
 * run it to an end state within `maxMs` of wall time.
 *
 * Self-contained: it never throws, and a second call while one is running
 * returns `skipped: "busy"` at once, so the orchestrator can fire it on every
 * reconcile without awaiting it. The runner yields to the event loop every
 * few hundred bars, so the order ferry and the reconcile keep their timers.
 */
export async function runMcpJobsPass(shared: Db, deps: McpJobsPassDeps = {}): Promise<McpJobsPassSummary> {
  const summary: McpJobsPassSummary = { skipped: null, swept: { expired: 0, cancelled: 0, lost: 0 }, job: null, error: null };
  const clock = deps.clockMs ?? (() => performance.now());
  const log = deps.log ?? ((m: string) => console.log(`[mcp-jobs] ${m}`));
  const maxMs = Math.max(0, deps.maxMs ?? JOB_LIMITS.passBudgetMs);
  const leaseSec = Math.ceil(maxMs / 1000) + JOB_LIMITS.leaseSlackSec;
  const started = clock();
  if (inFlight && started < inFlight.staleAt) return { ...summary, skipped: "busy" };
  if (inFlight) log("the previous pass outlived its lease; starting a new one (its writes are fenced)");
  const gen = ++generation;
  inFlight = { gen, staleAt: started + leaseSec * 1000 };
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  try {
    summary.swept = await sweepJobs(shared, now());
    const job = await claimNextJob(shared, now(), leaseSec);
    if (!job) return summary;
    const outcome = await runClaimed(shared, job, { ...deps, now, log, clockMs: clock }, { started, maxMs, leaseSec });
    summary.job = { id: job.id, outcome, attempt: job.attempts, ms: Math.round(clock() - started) };
    if (outcome !== "succeeded") log(`job ${job.id} attempt ${job.attempts}: ${outcome}`);
    return summary;
  } catch (error) {
    // The database, most likely. A claimed job keeps its lease until it lapses
    // and is then re-claimed (attempts + 1), which is the recovery path.
    summary.error = error instanceof Error ? error.name : "error";
    log(`pass failed: ${summary.error}`);
    return summary;
  } finally {
    if (inFlight?.gen === gen) inFlight = null;
  }
}

/** Test seam: clear the in-flight guard. */
export function resetMcpJobsForTest(): void {
  inFlight = null;
}

/**
 * The `readFeed` the orchestrator hands the pass: readFeedHistory over ONE
 * client for the life of the process, built on robinhoodChain. The chain
 * definition is not decoration — the 400-round walk is a multicall, and a
 * bare-transport client (what the orchestrator builds elsewhere) knows no
 * Multicall3 address, so every read would fail and every oracle job would end
 * as unavailable. Nothing is imported or connected until the first read.
 */
export function oracleFeedReader(rpcUrl?: string): (feed: `0x${string}`) => Promise<FeedHistory> {
  let reader: Promise<(feed: `0x${string}`) => Promise<FeedHistory>> | null = null;
  const build = async () => {
    const [{ createPublicClient, http }, { robinhoodChain }, { readFeedHistory }] = await Promise.all([
      import(/* webpackIgnore: true */ "viem"),
      import(/* webpackIgnore: true */ "../../../packages/core/src/chain"),
      import(/* webpackIgnore: true */ "../read-feed-history"),
    ]);
    const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) });
    return (feed: `0x${string}`) => readFeedHistory(feed, client);
  };
  return async (feed) => {
    reader ??= build().catch((error) => {
      reader = null;
      throw error;
    });
    return (await reader)(feed);
  };
}

interface Budget { started: number; maxMs: number; leaseSec: number }
type RunDeps = Required<Pick<McpJobsPassDeps, "now" | "log" | "clockMs">> & McpJobsPassDeps;

async function runClaimed(db: Db, job: ClaimedJob, deps: RunDeps, budget: Budget): Promise<JobStatus | "lease_lost"> {
  const clock = deps.clockMs;
  const t0 = clock();
  let progress = 0;
  const overBudget = () => clock() - budget.started > budget.maxMs;
  // Cancel, deadline and lease are checked together, at every checkpoint.
  const checkpoint = async () => {
    const c = await controlOf(db, job);
    if (!c.owned) throw new Stop("lease_lost");
    if (c.cancel) throw new Stop("cancelled");
    if (deps.now() >= job.deadline_at) throw new Stop("expired");
    if (overBudget()) throw new Stop("timeout");
  };
  const report = async (p: number) => {
    progress = p;
    if (!(await heartbeatJob(db, job, p, deps.now(), budget.leaseSec))) throw new Stop("lease_lost");
    await deps.onProgress?.(job.id, p);
  };

  try {
    if (job.kind !== "backtest") throw new JobFailure("invalid_params", "Unknown job kind.");
    const parsed = (() => {
      try {
        return validateBacktestParams(JSON.parse(job.params_json));
      } catch {
        return { ok: false as const, why: "unreadable params" };
      }
    })();
    if (!parsed.ok) throw new JobFailure("invalid_params", `The job's parameters are not valid: ${parsed.why}.`);
    const p = parsed.params;
    await checkpoint();

    // Loaded on first use, and hidden from the bundler, so the web tier — which
    // imports this module for the queue functions only — never pulls the
    // strategy registry (and the model drivers behind it) into its build. The
    // web never runs a job; only the orchestrator reaches this line.
    const [{ runBacktest }, { buildScenario }, { buildStrategy, legsForUniverse }] = await Promise.all([
      import(/* webpackIgnore: true */ "../backtest"),
      import(/* webpackIgnore: true */ "../backtest-scenario"),
      import(/* webpackIgnore: true */ "../strategies/registry"),
    ]);

    let bars: Bar[];
    let coverage: DataCoverage;
    const warnings: string[] = [];
    if (p.data === "synthetic") {
      bars = buildScenario({ symbols: p.symbols, startPrice: {}, days: p.days, seed: p.seed ?? DEFAULT_SEED });
      const staleShare = (s: string) => bars.length ? bars.filter((b) => b.staleSymbols?.has(s)).length / bars.length : 0;
      coverage = {
        source: "synthetic",
        bar_interval: "1d",
        bars: bars.length,
        span: { from: coverageFrom(bars), to: coverageTo(bars) },
        requested_days: p.days,
        // One daily bar per requested day: the series is generated, so it always covers the request.
        covered_days: bars.length,
        method: `Seeded random walk (seed ${p.seed ?? DEFAULT_SEED}): 25% annualised volatility, 6% annual drift, every symbol starting at $100, daily bars from 2024-01-01; weekends held flat and marked stale.`,
        symbols: p.symbols.map((s) => ({
          symbol: s, points: bars.length,
          first_point_at: coverageFrom(bars), last_point_at: coverageTo(bars),
          stale_share: round(staleShare(s), 3), gaps_over_6h: null, longest_gap_hours: null,
        })),
      };
    } else {
      const readFeed = deps.readFeed;
      if (!readFeed) throw new JobFailure("upstream_unavailable", "Oracle history cannot be read by the background worker right now. Try data 'synthetic', or retry later.");
      const series: { symbol: string; points: FeedPoint[] }[] = [];
      for (const symbol of p.symbols) {
        const feed = STOCK_TOKENS.find((t) => t.symbol === symbol)?.chainlinkFeed ?? null;
        if (!feed) throw new JobFailure("invalid_params", `${symbol} has no Chainlink feed.`);
        // Serial, not parallel: eight 400-round multicalls at once is the burst
        // this chain refuses. Each read is held to what is left of the pass, so
        // a hung RPC ends the job as unavailable instead of pinning the pass.
        const left = budget.maxMs - (clock() - budget.started);
        const h = left > 0 ? await withinMs(Promise.resolve().then(() => readFeed(feed)), left) : null;
        if (!h || !h.read) throw new JobFailure("upstream_unavailable", `The ${symbol} oracle could not be read just now. Retry later.`);
        if (!h.points.length) throw new JobFailure("insufficient_data", `The ${symbol} oracle returned no history.`);
        series.push({ symbol, points: h.points });
        await checkpoint();
      }
      const r = resampleOracle(series, { endSec: deps.now(), days: p.days });
      if (r.bars.length < 2) throw new JobFailure("insufficient_data", "The oracle histories of these symbols do not overlap enough to backtest. Try fewer symbols or fewer days.");
      bars = r.bars;
      coverage = r.coverage;
      warnings.push(...r.warnings);
    }
    if (bars.length < 1) throw new JobFailure("insufficient_data", "There are no bars to backtest.");
    await report(0.1);

    const legs = new Map(legsForUniverse(p.symbols).map((l) => [l.symbol, l.token] as const));
    if (legs.size !== p.symbols.length) throw new JobFailure("invalid_params", "Some symbols are not tradable legs.");
    const lastT = bars[bars.length - 1]!.tSec;
    const variants: VariantResult[] = [];
    for (const [i, v] of p.variants.entries()) {
      await checkpoint();
      const settings = resolveVariant(p, v);
      const inner = buildStrategy(p.strategy, {
        swapRouter: SIM_ROUTER,
        usdg6,
        basketSymbols: p.symbols,
        buyPerTickUsdg: settings.buy_per_tick_usdg,
        idleFloorUsdg: settings.idle_floor_usdg,
        gapEnterBudgetUsdg: settings.gap_enter_budget_usdg,
        llm: { creds: null, intervalMin: 60, maxActionUsdg: 0 },
      });
      let ticks = 0;
      // The engine has no abort signal of its own, but it awaits the strategy
      // every bar — so the strategy is where the budget and the cancel bind.
      const strategy: Strategy = {
        name: inner.name,
        async tick(snap) {
          ticks += 1;
          if (overBudget()) throw new Stop("timeout");
          if (ticks % CHECK_EVERY_TICKS === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            await checkpoint();
          }
          return inner.tick(snap);
        },
      };
      const cfg: BacktestConfig = {
        strategy,
        legs,
        initialCashUsdg: usdg6(p.initial_usdg),
        executionCostBps: settings.execution_cost_bps,
        vaultApyBps: 0,
        limits: {
          perTradeUsdg: usdg6(settings.per_trade_usdg),
          dailyUsdg: usdg6(settings.daily_usdg),
          allowedTargets: [SIM_ROUTER, MORPHO.steakhouseUsdgVault as `0x${string}`],
          allowedAssets: [CASH.USDG as `0x${string}`, ...legs.values()],
          maxOpsPerDay: 500,
          maxDrawdownBps: Math.round(settings.max_drawdown_pct * 100),
          expiresAt: lastT + 2 * DAY,
        },
      };
      const r = await runBacktest(cfg, bars);
      const vr = variantResult(p, v.label, settings, r, JOB_LIMITS.equityPoints);
      // Swaps, not operations: a run of vault deposits alone passed the policy but traded nothing.
      if (vr.swap_fills === 0) warnings.push(`${v.label} filled no swaps over the window.`);
      variants.push(vr);
      await report(0.1 + (0.9 * (i + 1)) / p.variants.length - (i + 1 === p.variants.length ? 0.001 : 0));
    }

    const result: BacktestJobResult = {
      kind: "backtest",
      strategy: p.strategy,
      data: p.data,
      symbols: p.symbols,
      initial_usdg: p.initial_usdg,
      seed: p.seed,
      variants,
      assumptions: assumptions(),
      data_coverage: coverage,
      warnings: warnings.slice(0, 20),
      limitations: [...LIMITATIONS_COMMON, ...(p.data === "oracle" ? LIMITATIONS_ORACLE : LIMITATIONS_SYNTHETIC)],
      lookahead: "Each bar only sees prices up to that bar: an oracle bar carries the last round published at or before its time (forward-filled, never interpolated), and every decision fills at that same bar's price.",
      disclaimer: "Simulated; not a promise of live returns.",
      computed_at: iso(deps.now()),
      compute_ms: Math.round(clock() - t0),
    };
    const bounded = boundResult(result);
    if (!bounded) throw new JobFailure("internal", "The result was too large to store.");
    // A cancel that arrived during the last variant is honoured: cancel_job told
    // the owner it would stop. Budget and deadline are not re-checked here — the
    // work is done, and a finished answer is not thrown away for being late.
    const last = await controlOf(db, job);
    if (!last.owned) throw new Stop("lease_lost");
    if (last.cancel) throw new Stop("cancelled");
    return (await finishJob(db, job, deps.now(), { status: "succeeded", result: bounded })) ? "succeeded" : "lease_lost";
  } catch (error) {
    const end = async (o: Parameters<typeof finishJob>[3]): Promise<JobStatus | "lease_lost"> =>
      (await finishJob(db, job, deps.now(), o)) ? o.status : "lease_lost";
    if (error instanceof Stop) {
      if (error.outcome === "lease_lost") return "lease_lost";
      if (error.outcome === "cancelled") return end({ status: "cancelled" });
      if (error.outcome === "expired") return end({ status: "expired", code: "expired", message: "It passed its deadline before it could finish." });
      return end({
        status: "failed", code: "timeout",
        message: `The backtest needed more than its ${Math.round(budget.maxMs / 1000)} s compute budget (it was ${Math.round(progress * 100)}% done). Try fewer variants, symbols or days.`,
      });
    }
    if (error instanceof JobFailure) return end({ status: "failed", code: error.code, message: error.message });
    deps.log(`job ${job.id} crashed: ${error instanceof Error ? error.name : "error"}`);
    return end({ status: "failed", code: "internal", message: "The backtest failed unexpectedly." });
  }
}

function coverageFrom(bars: readonly Bar[]): string | null {
  return bars.length ? iso(bars[0]!.tSec) : null;
}
function coverageTo(bars: readonly Bar[]): string | null {
  return bars.length ? iso(bars[bars.length - 1]!.tSec) : null;
}

/** The read's answer, or null if it failed or did not answer within `ms`. Never throws. */
async function withinMs<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([work.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keep the stored result under resultMaxBytes by thinning the equity series; null if even that is not enough. */
export function boundResult(result: BacktestJobResult): BacktestJobResult | null {
  const size = (r: BacktestJobResult) => Buffer.byteLength(JSON.stringify(r), "utf8");
  if (size(result) <= JOB_LIMITS.resultMaxBytes) return result;
  const thinned: BacktestJobResult = {
    ...result,
    variants: result.variants.map((v) => ({ ...v, equity_series: downsample(v.equity_series, 25) })),
    warnings: [...result.warnings, "Equity series were thinned to 25 points to keep the result small."],
  };
  return size(thinned) <= JOB_LIMITS.resultMaxBytes ? thinned : null;
}
