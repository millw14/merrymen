/**
 * THE WEB PROCESS'S FOMO RUNTIME — one research service per web process, for
 * app chat, MCP and the owner status route.
 *
 * WHERE ITS PIECES COME FROM, and why each is the trusted one:
 *
 *   database   hosted: the shared Postgres the web already holds (mcp/db.ts),
 *              the same store the orchestrator writes, so caches, subject
 *              memory, watches and the credit counters are one set for the
 *              fleet. Self-hosted: fomo.sqlite in MERRYMEN_HOME, which the
 *              local worker opens too (worker/src/fomo/local-db.ts). The
 *              ledger stays single-writer; Fomo never touches it.
 *   key        hosted: MERRYMEN_FOMO_API_KEY, else FOMO_API_KEY, read HERE and
 *              in no other web file (worker/src/fomo/boundary.test.ts). A
 *              blank value is no key. Self-hosted: the install's own
 *              resolveConfig().fomoApiKey (settings file, then the same env
 *              names). No key is `null`: every lookup answers "not
 *              configured" honestly and nothing reaches the provider.
 *   access     hosted: the tenant's sealed settings through the allowlisted
 *              projection (settings-view.ts) — fomoDataAccess defaults ON,
 *              monitoring and follow default OFF, exactly as the orchestrator
 *              reads them. Self-hosted: the install's resolveConfig(). A
 *              tenant the process cannot vouch for gets no access at all.
 *   plan       MERRYMEN_FOMO_PLAN_CREDITS, a positive number, read the way the
 *              orchestrator reads it: the two processes share the fomo_meta
 *              allowance counters, so they must agree on the pool.
 *
 * WHO THE TENANT IS never comes from here or from a request body: hosted it is
 * the verified session cookie (or an MCP principal), self-hosted it is the
 * fixed SELF_HOSTED_TENANT. fomoTenantFor() is the one place that rule lives.
 *
 * HOSTED OR NOT IS THE CALLER'S TO SAY, as order-ceiling.ts and x-connect.ts
 * take it: a route handler passes its own isHostedMode(), and the MCP tools
 * pass true because MCP runs on hosted Merrymen only (mcp/config.ts). A
 * module under lib/ never reads the mode itself (lib/client-env.test.ts).
 *
 * MEMOISED AS A PROMISE, one per mode, and dropped on failure, so a database
 * that was down at the first question is retried at the next one instead of
 * forever.
 */
import type { Db } from "../../../worker/src/db";
import { SELF_HOSTED_TENANT, type FomoAccess } from "../../../worker/src/fomo/contract";
import { openLocalFomoDb } from "../../../worker/src/fomo/local-db";
import { createFomoRuntime, type FomoRuntime } from "../../../worker/src/fomo/runtime";
import type { FomoDialect } from "../../../worker/src/fomo/store";
import { resolveConfig } from "../../../worker/src/settings";
import { mcpDb } from "../mcp/db";
import { settingsReader } from "./services/settings-view";

export type { FomoRuntime };

const TENANT = /^0x[0-9a-fA-F]{40}$/;
const NO_ACCESS: FomoAccess = Object.freeze({ dataAccess: false, monitoring: false, follow: false });

type Env = Record<string, string | undefined>;

/**
 * The hosted key. The house's name first, then the provider docs' name; a
 * blank value is no key. MERRYMEN_FOMO_ENABLED=0 (the orchestrator's switch)
 * turns the web's lookups off too: they answer "not configured".
 */
export function hostedFomoApiKey(env: Env = process.env): string | null {
  if (env.MERRYMEN_FOMO_ENABLED === "0") return null;
  return env.MERRYMEN_FOMO_API_KEY?.trim() || env.FOMO_API_KEY?.trim() || null;
}

/** The self-hosted key: the install's own settings (file first, then env), as the local worker reads it. */
function selfHostedFomoApiKey(env: Env = process.env): string | null {
  if (env.MERRYMEN_FOMO_ENABLED === "0") return null;
  const key = resolveConfig().fomoApiKey;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

/** The provider plan's monthly credits, exactly as orchestrator.ts fomoSetup reads them; undefined lets the runtime default apply. */
export function fomoPlanCredits(env: Env = process.env): number | undefined {
  const plan = Number(env.MERRYMEN_FOMO_PLAN_CREDITS);
  return Number.isFinite(plan) && plan > 0 ? plan : undefined;
}

/**
 * A hosted tenant's Fomo permissions from its sealed settings. A view that was
 * never stored (null), or a field never set, takes the catalogue default:
 * data access on, monitoring and following off. A read that throws is left to
 * throw — the service treats an unreadable permission as no permission.
 */
export async function hostedFomoAccess(tenant: string): Promise<FomoAccess> {
  if (typeof tenant !== "string" || !TENANT.test(tenant)) return NO_ACCESS;
  const view = await settingsReader().settingsFor(tenant.toLowerCase() as `0x${string}`);
  return {
    dataAccess: view?.fomoDataAccess ?? true,
    monitoring: view?.fomoMonitoringEnabled ?? false,
    follow: view?.fomoFollowEnabled ?? false,
  };
}

/** The self-hosted install's permissions. Only the install's own fixed tenant has any. */
export async function selfHostedFomoAccess(tenant: string): Promise<FomoAccess> {
  if (tenant !== SELF_HOSTED_TENANT) return NO_ACCESS;
  const cfg = resolveConfig();
  return { dataAccess: cfg.fomoDataAccess, monitoring: cfg.fomoMonitoringEnabled, follow: cfg.fomoFollowEnabled };
}

/**
 * The Fomo tenant for a caller this process already authenticated. Hosted: the
 * verified session (or MCP principal) tenant, lowercased, or null when there is
 * none — never a value from a body, a model or a file. Self-hosted: the
 * install's one fixed tenant.
 */
export function fomoTenantFor(trusted: string | null | undefined, hosted: boolean): string | null {
  if (!hosted) return SELF_HOSTED_TENANT;
  return typeof trusted === "string" && TENANT.test(trusted) ? trusted.toLowerCase() : null;
}

export interface WebFomoRuntimeOptions {
  hosted: boolean;
  db: Db;
  dialect: FomoDialect;
  apiKey: string | null;
  planCreditsPerMonth?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Tests only: the provider client's fetch (fixture-backed). Production passes nothing. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a runtime with the web's trusted access reader for the mode. Exported
 * so tests run the real access path against a fixture-backed provider; the
 * process itself goes through fomoRuntime().
 */
export function createWebFomoRuntime(o: WebFomoRuntimeOptions): Promise<FomoRuntime> {
  return createFomoRuntime({
    db: o.db,
    dialect: o.dialect,
    apiKey: o.apiKey,
    access: o.hosted ? hostedFomoAccess : selfHostedFomoAccess,
    planCreditsPerMonth: o.planCreditsPerMonth,
    now: o.now,
    log: o.log ?? ((line) => console.warn(line)),
    fetchImpl: o.fetchImpl,
  });
}

async function build(hosted: boolean): Promise<FomoRuntime> {
  if (hosted) {
    const { db, dialect } = await mcpDb();
    return createWebFomoRuntime({ hosted: true, db, dialect, apiKey: hostedFomoApiKey(), planCreditsPerMonth: fomoPlanCredits() });
  }
  // createFomoRuntime ensures the schema (ensureFomoSchema(db, "sqlite")) before anything else touches it.
  return createWebFomoRuntime({ hosted: false, db: openLocalFomoDb(), dialect: "sqlite", apiKey: selfHostedFomoApiKey(), planCreditsPerMonth: fomoPlanCredits() });
}

const memo: { hosted: Promise<FomoRuntime> | null; self: Promise<FomoRuntime> | null } = { hosted: null, self: null };
let override: Promise<FomoRuntime> | null = null;

/** The process's one runtime for its mode. A failed build is forgotten, so the next caller tries again. */
export function fomoRuntime(hosted: boolean): Promise<FomoRuntime> {
  if (override) return override;
  const slot = hosted ? "hosted" : "self";
  const held = memo[slot];
  if (held) return held;
  const attempt = build(hosted);
  memo[slot] = attempt;
  attempt.catch(() => {
    if (memo[slot] === attempt) memo[slot] = null;
  });
  return attempt;
}

/** Test seam: serve this runtime (or, with null, go back to building the real one). */
export function setFomoRuntimeForTest(rt: FomoRuntime | Promise<FomoRuntime> | null): void {
  override = rt ? Promise.resolve(rt) : null;
  memo.hosted = null;
  memo.self = null;
}
