/**
 * Backtest jobs: queue a strategy test, follow it, list and cancel it.
 *
 * These tools never run a backtest. run_backtest validates the request and
 * writes a row to the durable queue (worker/src/mcp/jobs.ts); Merrymen's
 * orchestrator claims it on its own schedule and runs it under budgets the
 * client cannot change. So a job outlives the connection that asked for it,
 * and a slow or abandoned client costs nothing but a row.
 *
 * Jobs are the owner's, not an agent's: a backtest replays public prices
 * through the real strategy and policy code with settings the request names,
 * and reads nothing from the owner's ledger, grant or settings.
 */
import * as z from "zod";
import { STOCK_TOKENS } from "@merrymen/core";
import {
  BACKTEST_STRATEGIES, JOB_LIMITS, JobError, VARIANT_LABEL_RE, cancelJob, enqueueJob, getJobRow, listJobRows, sweepJobs, validateBacktestParams,
  type BacktestParams, type CancelOutcome, type JobRow, type JobStatus,
} from "../../../../worker/src/mcp/jobs";
import { McpError } from "../errors";
import { defineTool, type ToolContext } from "../tool";
import { LIMIT_ARG, decodeCursor, encodeCursor, isCursorInt, isoOrNull, untrusted } from "./shared";

/** Stock and ETF tokens with a Chainlink feed: the only ones oracle data can replay. */
export const ORACLE_SYMBOLS: readonly string[] = STOCK_TOKENS.filter((t) => t.chainlinkFeed && t.kind !== "memecoin").map((t) => t.symbol);
const ALL_SYMBOLS: readonly string[] = STOCK_TOKENS.filter((t) => t.kind !== "memecoin").map((t) => t.symbol);

const WHERE_IT_RUNS = "Jobs run in Merrymen's background worker, not in this connection: they keep going if you disconnect, and any connection of the same owner can follow them with get_job.";

// ── schemas ─────────────────────────────────────────────────────────────────

const USDG_SETTING = z.number().positive().max(JOB_LIMITS.maxUsdgSetting);

const VARIANT_IN = z.object({
  label: z.string().regex(VARIANT_LABEL_RE, "1-40 letters, digits, spaces, _ . or -").describe("A short name for this settings variant, e.g. 'base' or 'cheap fills'"),
  buy_per_tick_usdg: USDG_SETTING.optional().describe("steady-basket: USDG bought per bar (default 2.5% of initial_usdg)"),
  idle_floor_usdg: USDG_SETTING.optional().describe("steady-basket: cash kept out of the savings vault (default 5%)"),
  gap_enter_budget_usdg: USDG_SETTING.optional().describe("weekend-gap: USDG spread across the basket at a market close (default 10%)"),
  per_trade_usdg: USDG_SETTING.optional().describe("Policy limit per trade (default 50%)"),
  daily_usdg: USDG_SETTING.optional().describe("Policy limit per day (default 50%)"),
  max_drawdown_pct: z.number().min(1).max(100).optional().describe("Drawdown at which the policy stops new buys (default 20)"),
  execution_cost_bps: z.number().int().min(0).max(JOB_LIMITS.maxExecutionCostBps).optional().describe("Flat cost taken from every fill, in bps (default 30)"),
}).strict();

const IDEMPOTENCY = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "8-128 letters, digits, _ or -")
  .describe("A key you choose. Resending the same key with the same request returns the same job instead of queueing another.");

const JOB_ID = z.string().regex(/^job_[0-9a-f]{32}$/, "a job id from run_backtest or list_jobs");

const SETTINGS_OUT = z.object({
  buy_per_tick_usdg: z.number(),
  idle_floor_usdg: z.number(),
  gap_enter_budget_usdg: z.number(),
  per_trade_usdg: z.number(),
  daily_usdg: z.number(),
  max_drawdown_pct: z.number(),
  execution_cost_bps: z.number(),
});

const PARAMS_OUT = z.object({
  strategy: z.enum(BACKTEST_STRATEGIES),
  symbols: z.array(z.string()),
  data: z.enum(["oracle", "synthetic"]),
  days: z.number(),
  initial_usdg: z.number(),
  seed: z.number().nullable(),
  variants: z.array(z.object({
    label: z.string(),
    buy_per_tick_usdg: z.number().optional(),
    idle_floor_usdg: z.number().optional(),
    gap_enter_budget_usdg: z.number().optional(),
    per_trade_usdg: z.number().optional(),
    daily_usdg: z.number().optional(),
    max_drawdown_pct: z.number().optional(),
    execution_cost_bps: z.number().optional(),
  })),
});

const VARIANT_RESULT = z.object({
  label: z.string(),
  settings: SETTINGS_OUT.describe("The settings this variant ran with, defaults filled in"),
  final_equity_usdg: z.number().describe("Cash + vault + holdings valued at the last bar's price, before that bar's own trades; simulated"),
  pnl_usdg: z.number(),
  return_pct: z.number(),
  max_drawdown_bps: z.number().describe("Largest fall from a running peak of equity, in bps"),
  executed_operations: z.number().describe("Intents the policy passed: swaps and vault moves, including ones that then found no price or cash"),
  swap_fills: z.number().describe("Swaps that actually filled"),
  turnover_usdg: z.number().describe("USDG notional of the filled swaps (buy spend plus sell proceeds, before the execution cost)"),
  rejected_by_rule: z.array(z.object({ rule: z.string(), count: z.number() })).describe("Intents the policy refused, by rule (top 20)"),
  equity_series: z.array(z.object({ t: z.string(), equity_usdg: z.number() })).describe("Equity downsampled to at most 100 points, first and last kept"),
});

const COVERAGE = z.object({
  source: z.enum(["oracle", "synthetic"]),
  bar_interval: z.enum(["1h", "1d"]),
  bars: z.number(),
  span: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  requested_days: z.number(),
  covered_days: z.number(),
  method: z.string(),
  symbols: z.array(z.object({
    symbol: z.string(),
    points: z.number(),
    first_point_at: z.string().nullable(),
    last_point_at: z.string().nullable(),
    stale_share: z.number(),
    gaps_over_6h: z.number().nullable(),
    longest_gap_hours: z.number().nullable(),
  })),
});

export const BACKTEST_RESULT = z.object({
  kind: z.literal("backtest"),
  strategy: z.enum(BACKTEST_STRATEGIES),
  data: z.enum(["oracle", "synthetic"]),
  symbols: z.array(z.string()),
  initial_usdg: z.number(),
  seed: z.number().nullable(),
  variants: z.array(VARIANT_RESULT),
  assumptions: z.object({
    execution_cost_bps: z.string(),
    fills: z.string(),
    budgets: z.string(),
    vault_apy_bps: z.number(),
    vault_apy_note: z.string(),
    limits: z.string(),
    defaults: z.string(),
  }),
  data_coverage: COVERAGE,
  warnings: z.array(z.string()),
  limitations: z.array(z.string()),
  lookahead: z.string(),
  disclaimer: z.string(),
  computed_at: z.string(),
  compute_ms: z.number(),
});

const STATUS = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "expired"]);

const JOB_BASE = z.object({
  job_id: z.string(),
  kind: z.string(),
  status: STATUS,
  status_explained: z.string(),
  terminal: z.boolean(),
  /** 0..1; 1 only once succeeded. */
  progress: z.number(),
  attempts: z.number(),
  cancel_requested: z.boolean(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  deadline_at: z.string(),
  params: PARAMS_OUT.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

const JOB_VIEW = JOB_BASE.extend({
  result: BACKTEST_RESULT.nullable(),
  result_note: z.string().nullable(),
});

// ── shaping ─────────────────────────────────────────────────────────────────

const EXPLAIN: Record<JobStatus, string> = {
  queued: "Waiting for Merrymen's background worker to pick it up. It keeps its place if you disconnect.",
  running: "Running in Merrymen's background worker.",
  succeeded: "Finished. The result is a simulation, not a promise of live returns.",
  failed: "It did not finish; see error.",
  cancelled: "Cancelled before it finished; there is no result.",
  expired: "It passed its deadline before it could finish (the background worker was busy or unavailable). Run it again.",
};
const TERMINAL = new Set<JobStatus>(["succeeded", "failed", "cancelled", "expired"]);

/** Labels were chosen by whichever client queued the job, possibly another app of this owner: data, not instructions. */
const label = (s: string) => untrusted(s, 40) ?? "";

function paramsOf(row: JobRow): z.infer<typeof PARAMS_OUT> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.params_json);
  } catch {
    return null;
  }
  const v = validateBacktestParams(raw);
  if (!v.ok) return null;
  return { ...v.params, variants: v.params.variants.map((x) => ({ ...x, label: label(x.label) })) };
}

function explain(row: JobRow, status: JobStatus, now: number): string {
  if (status !== "running") return EXPLAIN[status];
  if (row.cancel_requested === 1) return "Running; a cancel was requested and it stops at its next checkpoint.";
  // The sweep before every read has already settled a lapsed lease that is
  // cancelled, past its deadline or out of attempts; what is left will be retried.
  if (row.lease_until !== null && row.lease_until < now) {
    return `Its background worker stopped while running it (attempt ${row.attempts} of ${JOB_LIMITS.maxAttempts}); it will be retried when a worker is free, or end as failed or expired.`;
  }
  return EXPLAIN.running;
}

function baseOf(row: JobRow, now: number): z.infer<typeof JOB_BASE> {
  const status = STATUS.safeParse(row.status).success ? row.status : "failed";
  return {
    job_id: row.id,
    kind: row.kind,
    status,
    status_explained: explain(row, status, now),
    terminal: TERMINAL.has(status),
    progress: Math.max(0, Math.min(1, row.progress)),
    attempts: row.attempts,
    cancel_requested: row.cancel_requested === 1,
    created_at: new Date(row.created_at * 1000).toISOString(),
    started_at: isoOrNull(row.started_at),
    finished_at: isoOrNull(row.finished_at),
    deadline_at: new Date(row.deadline_at * 1000).toISOString(),
    params: paramsOf(row),
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? "" } : null,
  };
}

function viewOf(row: JobRow, now: number): z.infer<typeof JOB_VIEW> {
  const base = baseOf(row, now);
  if (base.status !== "succeeded") return { ...base, result: null, result_note: null };
  let parsed: z.infer<typeof BACKTEST_RESULT> | null = null;
  try {
    const r = BACKTEST_RESULT.safeParse(JSON.parse(row.result_json ?? "null"));
    parsed = r.success ? r.data : null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    // A result written by an older runner: say so rather than fail the whole read.
    return { ...base, result: null, result_note: "The stored result is in a format this server no longer reads. Run the backtest again." };
  }
  return { ...base, result: { ...parsed, variants: parsed.variants.map((v) => ({ ...v, label: label(v.label) })) }, result_note: null };
}

function translate(e: unknown): never {
  if (e instanceof JobError) {
    throw new McpError(e.code, e.message, e.code === "quota_exceeded" ? { retryAfterSec: 60 } : {});
  }
  throw e;
}

async function ownedJob(ctx: ToolContext, id: string): Promise<JobRow> {
  const d = await ctx.mcp();
  // Settle this owner's abandoned jobs first, so a status read is honest even
  // while the background worker is down.
  await sweepJobs(d.db, ctx.now(), ctx.principal.tenant);
  const row = await getJobRow(d.db, ctx.principal.tenant, id);
  if (!row) throw new McpError("not_found", "No such job.");
  return row;
}

// ── tools ───────────────────────────────────────────────────────────────────

const runBacktestTool = defineTool({
  name: "run_backtest",
  title: "Run a backtest",
  description: [
    "Queue a backtest of steady-basket or weekend-gap over stock and ETF tokens, comparing 1-4 settings variants. It replays the agent's real strategy and policy code with naive fills (at the bar's price, flat cost, no depth or MEV).",
    `data 'oracle' replays Chainlink history (hourly bars, up to ${JOB_LIMITS.oracleMaxDays} days, symbols: ${ORACLE_SYMBOLS.join(", ")}); data 'synthetic' is a seeded random walk (daily bars, up to ${JOB_LIMITS.syntheticMaxDays} days, any of ${ALL_SYMBOLS.join(", ")}).`,
    `Returns a job_id at once. ${WHERE_IT_RUNS} Poll get_job for progress and the result.`,
    `At most ${JOB_LIMITS.maxActivePerTenant} queued or running per owner. Results are simulations, never promises of live returns. Memecoins and launchpad coins cannot be backtested.`,
  ].join(" "),
  capability: "jobs.run",
  input: z.object({
    strategy: z.enum(BACKTEST_STRATEGIES),
    symbols: z.array(z.string().regex(/^[A-Za-z0-9]{1,12}$/, "a ticker such as NVDA")).min(1).max(JOB_LIMITS.maxSymbols),
    data: z.enum(["oracle", "synthetic"]),
    days: z.number().int().min(1).max(JOB_LIMITS.syntheticMaxDays).describe(`Oracle: 1-${JOB_LIMITS.oracleMaxDays}. Synthetic: 1-${JOB_LIMITS.syntheticMaxDays}.`),
    initial_usdg: z.number().min(JOB_LIMITS.minInitialUsdg).max(JOB_LIMITS.maxInitialUsdg),
    seed: z.number().int().min(0).max(2_147_483_647).optional().describe("Synthetic only (default 42): the same seed replays the same series"),
    variants: z.array(VARIANT_IN).min(1).max(JOB_LIMITS.maxVariants),
    idempotency_key: IDEMPOTENCY.optional(),
  }).strict(),
  output: JOB_BASE.extend({ created: z.boolean(), next_steps: z.string() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  budget: { bucket: "backtest", perHour: 10, perDay: 30 },
  async handler(args, ctx) {
    const { idempotency_key, ...request } = args;
    const v = validateBacktestParams(request);
    if (!v.ok) throw new McpError("invalid_input", v.why);
    const d = await ctx.mcp();
    const now = ctx.now();
    // An expired job must not hold one of the owner's two slots.
    await sweepJobs(d.db, now, ctx.principal.tenant);
    const params: BacktestParams = v.params;
    const { row, created } = await enqueueJob(d.db, {
      tenant: ctx.principal.tenant, connectionId: ctx.principal.connectionId, params, idempotencyKey: idempotency_key ?? null, now, dialect: d.dialect,
    }).catch(translate);
    const base = baseOf(row, now);
    return {
      data: { ...base, created, next_steps: `${WHERE_IT_RUNS} Poll get_job with this job_id (every 10-30 s is plenty); cancel_job stops it.` },
      summary: `Backtest ${row.id} is ${base.status}${created ? "" : " (an existing job for this idempotency_key)"}. It runs in Merrymen's background worker; poll get_job.`,
    };
  },
});

const getJob = defineTool({
  name: "get_job",
  title: "Backtest job status and result",
  description: `The status of a backtest job (queued, running, succeeded, failed, cancelled or expired), its progress and timestamps, and the result once it succeeded: per variant final equity, P&L, return, max drawdown, trades, turnover, refusals by policy rule and a downsampled equity curve, plus the assumptions, data coverage, limitations and a no-lookahead statement. ${WHERE_IT_RUNS}`,
  capability: "jobs.run",
  input: z.object({ job_id: JOB_ID }).strict(),
  output: JOB_VIEW,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const view = viewOf(await ownedJob(ctx, args.job_id), ctx.now());
    return { data: view, summary: `${view.job_id}: ${view.status} (${Math.round(view.progress * 100)}%). ${view.status_explained}` };
  },
});

const listJobs = defineTool({
  name: "list_jobs",
  title: "List backtest jobs",
  description: `This owner's backtest jobs from any connection, newest first, without results (get_job has those). ${WHERE_IT_RUNS}`,
  capability: "jobs.run",
  input: z.object({
    limit: LIMIT_ARG(50, 10),
    cursor: z.string().max(512).optional().describe("next_cursor from a previous list_jobs call"),
  }).strict(),
  output: z.object({ jobs: z.array(JOB_BASE), next_cursor: z.string().nullable() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const tenant = ctx.principal.tenant;
    let before: { created_at: number; id: string } | null = null;
    if (args.cursor !== undefined) {
      const c = decodeCursor(tenant, "list_jobs", args.cursor);
      if (!c || !isCursorInt(c.c) || typeof c.i !== "string" || !/^job_[0-9a-f]{32}$/.test(c.i)) {
        throw new McpError("invalid_input", "cursor is not a list_jobs cursor from this connection's owner.");
      }
      before = { created_at: c.c, id: c.i };
    }
    const d = await ctx.mcp();
    const now = ctx.now();
    await sweepJobs(d.db, now, tenant);
    const rows = await listJobRows(d.db, tenant, { limit: args.limit + 1, before });
    const page = rows.slice(0, args.limit);
    const last = page[page.length - 1];
    const next = rows.length > args.limit && last ? encodeCursor(tenant, "list_jobs", { c: last.created_at, i: last.id }) : null;
    return { data: { jobs: page.map((r) => baseOf(r, now)), next_cursor: next } };
  },
});

const CANCEL_NOTE: Record<CancelOutcome, string> = {
  cancelled: "It had not started, so it was cancelled at once.",
  requested: "It is running; the background worker stops it at its next checkpoint (between variants, within a few hundred bars, or before it stores a result). Poll get_job to see it end as cancelled.",
  already_finished: "It had already finished, so nothing changed.",
};

const cancelJobTool = defineTool({
  name: "cancel_job",
  title: "Cancel a backtest job",
  description: "Cancel one of this owner's backtest jobs. A queued job is cancelled at once; a running one is asked to stop and does so at its next checkpoint; a finished one is left as it is.",
  capability: "jobs.run",
  input: z.object({ job_id: JOB_ID }).strict(),
  output: JOB_BASE.extend({ outcome: z.enum(["cancelled", "requested", "already_finished"]), note: z.string() }),
  // Destructive: a cancelled job cannot be resumed and keeps no result; it has to be run again from the start.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async handler(args, ctx) {
    await ownedJob(ctx, args.job_id);
    const d = await ctx.mcp();
    const now = ctx.now();
    const { outcome } = await cancelJob(d.db, ctx.principal.tenant, args.job_id, now).catch(translate);
    // A cancelled job whose worker is already gone is settled now rather than at the next pass.
    await sweepJobs(d.db, now, ctx.principal.tenant);
    const row = await getJobRow(d.db, ctx.principal.tenant, args.job_id);
    if (!row) throw new McpError("not_found", "No such job.");
    return { data: { ...baseOf(row, now), outcome, note: CANCEL_NOTE[outcome] }, summary: `${row.id}: ${CANCEL_NOTE[outcome]}` };
  },
});

export const JOBS_TOOLS = [runBacktestTool, getJob, listJobs, cancelJobTool];
