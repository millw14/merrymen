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
 *   access     hosted: ONLY AN OWNER WITH AN AGENT (a stored grant with a smart
 *              account, the fleet the orchestrator serves), then that owner's
 *              sealed settings through the allowlisted projection
 *              (settings-view.ts) — fomoDataAccess defaults ON, monitoring and
 *              follow default OFF, exactly as the orchestrator reads them.
 *              Self-hosted: the install's resolveConfig(). A tenant the
 *              process cannot vouch for gets no access at all.
 *   model      a per-tenant ModelBudget (analysis-model calls and tokens per
 *              UTC day) on the same fomo_meta allowance counters, checked by
 *              the app chat before Fomo evidence is handed to a model.
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
import { getGrantStore } from "@merrymen/grant-store";
import type { Db } from "../../../worker/src/db";
import { ModelBudget, type ModelBudgetConfig } from "../../../worker/src/fomo/budget";
import { SELF_HOSTED_TENANT, type FomoAccess } from "../../../worker/src/fomo/contract";
import { openLocalFomoDb } from "../../../worker/src/fomo/local-db";
import { createFomoRuntime, storeAllowancePort, type FomoRuntime as BaseFomoRuntime } from "../../../worker/src/fomo/runtime";
import type { FomoDialect } from "../../../worker/src/fomo/store";
import { resolveConfig } from "../../../worker/src/settings";
import { mcpDb } from "../mcp/db";
import { settingsReader } from "./services/settings-view";

/** The worker runtime plus the web's per-tenant analysis-model budget. */
export type FomoRuntime = BaseFomoRuntime & { modelBudget: ModelBudget };

const TENANT = /^0x[0-9a-fA-F]{40}$/;
const NO_ACCESS: FomoAccess = Object.freeze({ dataAccess: false, monitoring: false, follow: false });

/**
 * Per-tenant, per-UTC-day caps on the analysis model a Fomo answer is handed to
 * (docs/fomo.md "Cost model": "model-call caps apply"). An app-chat analysis
 * turn is one call of at most ~1,000 reply tokens over ≤6,000 chars of
 * evidence plus the rules, so the call cap binds first; the token cap stops a
 * run of maximal evidence blocks. Construction-time constants: nothing a
 * tenant, a request or a model says can raise them.
 */
export const FOMO_MODEL_BUDGET: Readonly<ModelBudgetConfig> = Object.freeze({ callsPerDay: 40, tokensPerDay: 160_000 });

/** Said to a hosted wallet with no agent: Fomo research is for owners, and the fleet's credits are theirs. */
export const FOMO_NEEDS_AGENT = "Fomo research is for Merrymen owners. Create your agent first, then ask me again.";

/**
 * Whether a hosted tenant owns an agent. THROWS when the grant store cannot
 * be read: "could not tell" is never answered as "has no agent" (which would
 * tell a real owner they are not one) nor as "has one" (which would let any
 * wallet spend the fleet's credits during an outage).
 */
export interface FomoOwnerReader {
  hasAgent(tenant: `0x${string}`): Promise<boolean>;
}

/**
 * THE GRANT STORE IS THE ROSTER. Sign-in is open, so a signed-in wallet is not
 * an owner: anyone can mint fresh wallets, and each one used to be a Fomo
 * tenant with its own per-tenant caps, all drawing on the ONE shared credit
 * pool every real owner's questions and the fleet's discovery spend. The
 * orchestrator serves only tenants with a grant; the web now asks the same
 * question (the group chat's agentOf does too: a grant with a smart account).
 */
export const grantStoreOwnerReader: FomoOwnerReader = {
  async hasAgent(tenant) {
    const grant = await getGrantStore().get(tenant);
    const account = grant?.smartAccount;
    return typeof account === "string" && TENANT.test(account);
  },
};

let ownerReader: FomoOwnerReader = grantStoreOwnerReader;

/** Whether this hosted tenant owns an agent. Not a tenant is false; an unreadable store throws. */
export async function hostedFomoOwner(tenant: string): Promise<boolean> {
  if (typeof tenant !== "string" || !TENANT.test(tenant)) return false;
  return ownerReader.hasAgent(tenant.toLowerCase() as `0x${string}`);
}

/** Test seam: answer "has an agent" from this reader (or, with null, from the grant store again). */
export function setFomoOwnerReaderForTest(r: FomoOwnerReader | null): void {
  ownerReader = r ?? grantStoreOwnerReader;
}

type Env = Record<string, string | undefined>;

/** Said where a hosted deployment has not opted in to Fomo research (MERRYMEN_FOMO_ENABLED=1). */
export const FOMO_NOT_ENABLED = "Fomo research is not enabled on this deployment.";

/**
 * HOSTED FOMO IS OPT-IN: on only when MERRYMEN_FOMO_ENABLED is exactly "1",
 * the orchestrator's own switch (worker/src/orchestrator.ts fomoSetup). Off,
 * the web builds no runtime — no fomo_* DDL, no Fomo reads or writes on the
 * shared database — and the chat leaves every message to its existing
 * handlers, so landing this code changes nothing until an operator turns it
 * on. Self-hosted installs are unaffected (their key is their own setting).
 */
export function hostedFomoEnabled(env: Env = process.env): boolean {
  return env.MERRYMEN_FOMO_ENABLED === "1";
}

/** Thrown by fomoRuntime(true) while hosted Fomo is not enabled: nothing was built. */
export class FomoNotEnabledError extends Error {
  constructor() {
    super(FOMO_NOT_ENABLED);
    this.name = "FomoNotEnabledError";
  }
}

/**
 * The hosted key. The house's name first, then the provider docs' name; a
 * blank value is no key. None at all unless hosted Fomo is enabled.
 */
export function hostedFomoApiKey(env: Env = process.env): string | null {
  if (!hostedFomoEnabled(env)) return null;
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
 * A hosted tenant's Fomo permissions: none at all unless it owns an agent,
 * then its sealed settings. A view that was never stored (null), or a field
 * never set, takes the catalogue default: data access on, monitoring and
 * following off. A read that throws (grants or settings) is left to throw —
 * the service treats an unreadable permission as no permission.
 *
 * The agent check lives HERE, in the one reader every web surface's lookups
 * pass through (app chat, MCP, the status route), so no surface can forget
 * it. The surfaces ask hostedFomoOwner() first as well, only to say why in
 * plain words rather than "switched off".
 */
export async function hostedFomoAccess(tenant: string): Promise<FomoAccess> {
  if (typeof tenant !== "string" || !TENANT.test(tenant)) return NO_ACCESS;
  if (!(await hostedFomoOwner(tenant))) return NO_ACCESS;
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
export async function createWebFomoRuntime(o: WebFomoRuntimeOptions): Promise<FomoRuntime> {
  const log = o.log ?? ((line: string) => console.warn(line));
  const rt = await createFomoRuntime({
    db: o.db,
    dialect: o.dialect,
    apiKey: o.apiKey,
    access: o.hosted ? hostedFomoAccess : selfHostedFomoAccess,
    planCreditsPerMonth: o.planCreditsPerMonth,
    now: o.now,
    log,
    fetchImpl: o.fetchImpl,
  });
  // The same durable fomo_meta counters the credit budget uses (createFomoRuntime
  // ensured the schema above), so every web replica and a restart see one
  // day's model spend per tenant.
  const modelBudget = new ModelBudget({
    port: storeAllowancePort(o.db, o.now ?? Date.now),
    config: FOMO_MODEL_BUDGET,
    now: o.now,
    onError: (op, err) => log(`fomo: model budget ${op} error: ${err instanceof Error ? err.message.slice(0, 160) : "unknown"}`),
  });
  return { ...rt, modelBudget };
}

async function build(hosted: boolean): Promise<FomoRuntime> {
  if (hosted) {
    // Before the database is opened: a deployment that has not opted in gets no schema and no Fomo rows.
    if (!hostedFomoEnabled()) throw new FomoNotEnabledError();
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
