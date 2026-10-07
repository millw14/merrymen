/**
 * THE FOMO RUNTIME — the one place a hosting process (orchestrator, web,
 * self-hosted worker) turns a key, a database and a permission lookup into a
 * working research service.
 *
 *   - The provider key arrives as an ARGUMENT. This module reads no
 *     environment; the hosting process resolves the key (orchestrator.ts,
 *     settings.ts, web fomo-runtime.ts are the only readers) and a missing key
 *     is `null`, which makes every upstream read answer "not configured"
 *     honestly while cached public data can still be served.
 *   - The schema is ensured BEFORE anything else touches the tables.
 *   - The retrieval budget's counters live in the shared store (fomo_meta),
 *     so every replica draws on the same allowance and a restart does not
 *     reset a day's spend.
 *   - The shared daily pool is derived from the plan's monthly credits with a
 *     20% safety reserve over a 31-day month (a billing period is never
 *     assumed shorter than it might be). Per-tenant and per-group caps are
 *     conservative fractions under it.
 *
 * Nothing here can raise a limit at runtime: overrides are construction-time
 * configuration from the hosting process, never from a tenant or a model.
 */

import type { Db } from "../db";
import { deriveDailyCredits, FomoBudget, UsageMeter, type AllowancePort, type FomoBudgetConfig } from "./budget";
import { fomoTailsOn, type FomoAccess } from "./contract";
import { SingleFlight } from "./freshness";
import { createFomoClient, type FomoClient } from "./provider";
import { createFomoService, runPendingJobs, type FomoServiceExt } from "./service";
import * as store from "./store";
import type { FomoDialect } from "./store";

export { runPendingJobs } from "./service";

/** The Free plan's monthly credits, the default when the plan is not known. */
export const FREE_PLAN_CREDITS_PER_MONTH = 250_000;
/** Held back from the monthly allowance: the budget never plans to spend the last fifth. */
export const PLAN_SAFETY_FRACTION = 0.2;

/**
 * Conservative per-tenant and per-group caps. One standard coin research costs
 * about 1,500–2,000 credits (one thesis page, one feed page, token stats, maybe
 * a search); a tenant can ask a handful of those an hour and a few dozen a day,
 * and a group less. The shared pool still bounds the whole fleet.
 */
export const DEFAULT_TENANT_HOURLY_CREDITS = 6_000;
export const DEFAULT_TENANT_DAILY_CREDITS = 20_000;
export const DEFAULT_GROUP_HOURLY_CREDITS = 2_500;

export interface FomoRuntimeOptions {
  db: Db;
  dialect: FomoDialect;
  /** The provider key, resolved by the hosting process. Null (or blank) means "not configured". */
  apiKey: string | null;
  access(tenant: string): Promise<FomoAccess>;
  now?: () => number;
  log?: (line: string) => void;
  /** Tests only: the provider client's fetch. Production passes nothing. */
  fetchImpl?: typeof fetch;
  /** Monthly credits on the provider plan (default 250,000, the Free plan). */
  planCreditsPerMonth?: number;
  budget?: Partial<FomoBudgetConfig>;
  /** Our agents' names, so a thesis that cites us is not independent support. */
  selfNames?: readonly string[];
  /**
   * Whether this install has the hosted fleet's live feed, which tails are
   * told from (service.ts FomoServiceDeps.liveFeed). Defaults to the hosted
   * dialect: Postgres is the fleet's store, sqlite a self-hosted install's.
   */
  liveFeed?: boolean;
  /** The operator's tail switch (contract.ts fomoTailsOn); defaults to reading MERRYMEN_FOMO_TAILS. */
  tailsEnabled?: boolean;
}

export interface FomoRuntime {
  service: FomoServiceExt;
  /** The owners' budget: per-tenant and per-group caps under the shared pool. */
  budget: FomoBudget;
  /**
   * The budget for fleet reads that belong to no owner (shared research, stream recovery): the same
   * shared pool and priority shares, without one owner's caps. Charge it with SHARED_RESEARCH_TENANT.
   */
  backgroundBudget: FomoBudget;
  usage: UsageMeter;
  client: FomoClient | null;
  /**
   * One pass of the deep-research job queue (claim, run, finish fenced); delivery stays with the surfaces.
   * A job whose owner switched data access off since asking is cancelled before anything is read.
   */
  runJobs(now?: number, limit?: number): Promise<{ claimed: number; done: number; failed: number; cancelled: number }>;
}

/**
 * An AllowancePort over the store's atomic counters (`takeAllowance` /
 * `returnAllowance` on fomo_meta): a conditional add that cannot pass its
 * limit even with several replicas racing, and a give-back clamped at zero.
 */
export function storeAllowancePort(db: Db, now: () => number = Date.now): AllowancePort {
  return {
    take(key, amount, limit, nowMs) {
      return store.takeAllowance(db, key, amount, limit, nowMs);
    },
    give(key, amount) {
      return store.returnAllowance(db, key, amount, now());
    },
  };
}

/** The budget configuration a plan supports, with any construction-time overrides applied and clamped. */
export function budgetConfigFor(planCreditsPerMonth: number, over: Partial<FomoBudgetConfig> = {}): FomoBudgetConfig {
  const derived = deriveDailyCredits(planCreditsPerMonth, 31, PLAN_SAFETY_FRACTION);
  // An unusable plan figure is not a big plan: spend nothing rather than guess.
  const shared = over.sharedDailyCredits ?? derived ?? 0;
  const cap = (v: number | undefined, fallback: number): number => Math.min(shared, Math.max(0, v ?? fallback));
  return {
    ...over,
    sharedDailyCredits: shared,
    tenantHourlyCredits: cap(over.tenantHourlyCredits, DEFAULT_TENANT_HOURLY_CREDITS),
    tenantDailyCredits: cap(over.tenantDailyCredits, DEFAULT_TENANT_DAILY_CREDITS),
    groupHourlyCredits: cap(over.groupHourlyCredits, DEFAULT_GROUP_HOURLY_CREDITS),
  };
}

export async function createFomoRuntime(opts: FomoRuntimeOptions): Promise<FomoRuntime> {
  await store.ensureFomoSchema(opts.db, opts.dialect);
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const key = typeof opts.apiKey === "string" && opts.apiKey.trim() ? opts.apiKey.trim() : null;
  const client = key ? createFomoClient({ apiKey: key, fetchImpl: opts.fetchImpl, now }) : null;
  const config = budgetConfigFor(opts.planCreditsPerMonth ?? FREE_PLAN_CREDITS_PER_MONTH, opts.budget);
  const port = storeAllowancePort(opts.db, now);
  const onError = (op: string, err: unknown) => log(`fomo: budget ${op} error: ${err instanceof Error ? err.message.slice(0, 160) : "unknown"}`);
  const budget = new FomoBudget({ port, config, now, onError });
  // Background shared research belongs to no owner: it draws on the same shared pool (same counters, so the
  // fleet-wide bound and the discovery share still hold) without being squeezed under one owner's caps.
  const backgroundBudget = new FomoBudget({
    port,
    config: { ...config, tenantHourlyCredits: config.sharedDailyCredits, tenantDailyCredits: config.sharedDailyCredits },
    now,
    onError,
  });
  const usage = new UsageMeter();
  const service = createFomoService({
    db: opts.db,
    dialect: opts.dialect,
    client,
    access: opts.access,
    budget,
    backgroundBudget,
    flight: new SingleFlight<unknown>({ now }),
    usage,
    now,
    log,
    selfNames: opts.selfNames,
    liveFeed: opts.liveFeed ?? opts.dialect === "postgres",
    tailsEnabled: opts.tailsEnabled ?? fomoTailsOn(),
  });
  return {
    service,
    budget,
    backgroundBudget,
    usage,
    client,
    runJobs: (at?: number, limit = 1) => runPendingJobs(service, opts.db, { now: at === undefined ? now : () => at, limit, log }),
  };
}
