/**
 * Fomo social-trading research (fomoapi.io, an independent provider not
 * affiliated with fomo.family), as MCP tools.
 *
 * One tool per REGISTERED read tool (worker/src/fomo/tools.ts), with the same
 * names, so a call here and a question in the app chat or Telegram reach the
 * same dispatcher — the research service's invoke() — with the same rules:
 * the owner's data-access permission first (fomoDataAccess, from the owner's
 * own settings), then the audience, then each tool's own validator, then
 * freshness, the shared credit budget and single-flight. This module adds the
 * MCP contract around it: a strict zod input that mirrors the registry's JSON
 * Schema (and the registry's validator as the final check), the capability,
 * a per-connection rate bucket shared by every provider-reading tool, and an
 * output schema for the research envelope with third-party text labelled.
 *
 * WHO IS ASKING is the connection's principal — never an argument. Public
 * research needs market:read; the owner's own research state (watches, jobs,
 * assessments, the decision funnel) needs agents:read. Either way the
 * principal must own an agent: the provider credits are the fleet's.
 *
 * WHAT IS NOT HERE, ON PURPOSE:
 *
 *   fomo_watch_coin / fomo_unwatch_coin. Watching is an owner-only mutation
 *   the subsystem offers ONLY through its deterministic planner (an owner's
 *   explicit "keep an eye on X" in the app chat or a Telegram DM), never to a
 *   model choosing tools — and an MCP client is exactly that. Nor does an
 *   existing scope describe it honestly: watchlist:manage promises that
 *   watching "does not change what any agent trades", while a Fomo watch
 *   routes the coin's activity into the owner's selective-following review
 *   (orchestrator-fomo.ts, reason "watched"). Granting it under that consent
 *   text would be the wrong promise.
 *
 *   A deep fomo_research_coin. A deep read enqueues a durable, owner-charged
 *   background job (up to 15,000 credits) whose result is delivered on chat
 *   surfaces; a market:read tool marked read-only must not start one. The
 *   depth here is quick or standard.
 */
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { fomoRuntime, fomoTenantFor, hostedFomoOwner } from "@/lib/fomo-runtime";
import { FOMO_ATTRIBUTION, renderEnvelope } from "../../../../worker/src/fomo/render";
import { BOARDS, DEPTHS, FOMO_TOOL_DEFS, FRESHNESS_MODES, RANKING_WINDOWS, TOOL_LIMITS, TOOL_WINDOWS } from "../../../../worker/src/fomo/tools";
import type { EvidenceKind, FomoEnvelope, FomoReadToolName, FreshnessClass, Freshness, ResultStatus } from "../../../../worker/src/fomo/types";
import { McpError } from "../errors";
import type { Capability } from "../scopes";
import { defineTool, type Budget, type ToolContext, type ToolDef } from "../tool";
import { UNTRUSTED_NOTE, refuseControls, stripControls } from "./shared";

// ── vocabularies, exhaustive against the contract ──────────────────────────
// Record<Union, true>: the compiler insists every member of the union in
// types.ts is listed, so a status added there cannot fail the output schema.

const STATUSES = Object.keys({
  ok: true, empty: true, partial: true, capped: true, stale: true, failed: true, unavailable: true,
  "not-authorized": true, "budget-limited": true, "needs-clarification": true, "not-found": true,
} satisfies Record<ResultStatus, true>) as [ResultStatus, ...ResultStatus[]];

const FRESHNESS_CLASSES = Object.keys({
  activity: true, holdings: true, rankings: true, theses: true, "token-stats": true, profile: true, boards: true,
} satisfies Record<FreshnessClass, true>) as [FreshnessClass, ...FreshnessClass[]];

const EVIDENCE_KINDS = Object.keys({
  event: true, thesis: true, comment: true, holdings: true, positions: true, fills: true, profile: true,
  ranking: true, board: true, "token-stats": true, dossier: true, assessment: true, decision: true,
} satisfies Record<EvidenceKind, true>) as [EvidenceKind, ...EvidenceKind[]];

const REFRESH_OUTCOMES = Object.keys({
  ok: true, failed: true, "skipped-budget": true, "skipped-fresh": true,
} satisfies Record<NonNullable<Freshness["lastRefreshOutcome"]>, true>) as [string, ...string[]];

const SERVED_FROM = Object.keys({ live: true, cache: true, "stale-cache": true, none: true } satisfies Record<Freshness["servedFrom"], true>) as [
  Freshness["servedFrom"],
  ...Freshness["servedFrom"][],
];

// ── inputs: the registry's JSON Schema, in zod ─────────────────────────────

const TOKEN = refuseControls(z.string().min(1).max(64))
  .regex(/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|\$?[A-Za-z0-9][A-Za-z0-9_-]{0,19})$/, "a contract address, a Solana mint or a ticker")
  .describe("Contract address, Solana mint, or ticker (e.g. PONS).");
const TRADER = refuseControls(z.string().min(1).max(64))
  .regex(/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|@?[A-Za-z0-9_]{1,30})$/, "a Fomo user id (UUID) or a handle")
  .describe("Fomo user id (UUID) or handle, with or without @.");
const CHAIN = refuseControls(z.string().min(1).max(24))
  .regex(/^[a-z][a-z0-9-]{0,23}$/, "a lowercase chain slug")
  .describe("Chain slug, e.g. robinhood, solana, base.");
const WINDOW = z.enum(TOOL_WINDOWS).describe("Time window.");
const SIDE = z.enum(["buy", "sell"]);
const FRESHNESS = z.enum(FRESHNESS_MODES as unknown as [string, ...string[]])
  .describe("cached-ok accepts a fresh-enough stored copy; prefer-fresh (the default) refreshes when the copy is older than its data class allows; force-refresh attempts an upstream read now.");
const DEPTH = z.enum(DEPTHS).describe("How much to read: quick is one page; standard and deep read further and cost more credits.");
const COHORT_ONLY = z.boolean().describe("Only Merrymen's watched traders.");
const LIMIT = (max: number) => z.number().int().min(1).max(max);

const INPUTS = {
  fomo_resolve_subject: z.object({
    query: refuseControls(z.string().min(1).max(64)).describe("Address, mint, ticker, handle or user id."),
    kind: z.enum(["any", "trader", "token"]).optional(),
    chain: CHAIN.optional(),
  }).strict(),
  fomo_get_trader_context: z.object({
    trader: TRADER,
    window: WINDOW.optional(),
    focus: z.enum(["holdings"]).optional(),
    depth: DEPTH.optional(),
    freshness: FRESHNESS.optional(),
  }).strict(),
  fomo_get_trader_activity: z.object({
    trader: TRADER,
    token: TOKEN.optional(),
    chain: CHAIN.optional(),
    side: SIDE.optional(),
    window: WINDOW.optional(),
    limit: LIMIT(TOOL_LIMITS.activity.max).optional(),
    freshness: FRESHNESS.optional(),
  }).strict(),
  fomo_get_token_theses: z.object({
    token: TOKEN.optional(),
    chain: CHAIN.optional(),
    trader: TRADER.optional(),
    window: WINDOW.optional(),
    limit: LIMIT(TOOL_LIMITS.theses.max).optional(),
    depth: DEPTH.optional(),
    freshness: FRESHNESS.optional(),
  }).strict().refine((a) => a.token !== undefined || a.trader !== undefined, { message: "give a token, a trader, or both" }),
  fomo_get_token_activity: z.object({
    token: TOKEN.optional(),
    chain: CHAIN.optional(),
    side: SIDE.optional(),
    window: WINDOW.optional(),
    cohort_only: COHORT_ONLY.optional(),
    limit: LIMIT(TOOL_LIMITS.tokenActivity.max).optional(),
    freshness: FRESHNESS.optional(),
  }).strict(),
  fomo_get_rankings: z.object({
    board: z.enum(BOARDS).optional(),
    window: z.enum(RANKING_WINDOWS as unknown as [string, ...string[]]).optional(),
    chain: CHAIN.optional(),
    limit: LIMIT(TOOL_LIMITS.rankings.max).optional(),
    cohort_only: COHORT_ONLY.optional(),
    freshness: FRESHNESS.optional(),
  }).strict(),
  fomo_find_opportunities: z.object({
    chain: CHAIN.optional(),
    window: WINDOW.optional(),
    limit: LIMIT(TOOL_LIMITS.opportunities.max).optional(),
    cohort_only: COHORT_ONLY.optional(),
    max_market_cap_usd: z.number().gt(0).max(1_000_000_000_000).optional(),
    freshness: FRESHNESS.optional(),
  }).strict(),
  fomo_research_coin: z.object({
    token: TOKEN,
    chain: CHAIN.optional(),
    // No "deep" here: a deep read starts a background job (see the header).
    depth: z.enum(["quick", "standard"]).optional().describe("How much to read: quick or standard (the default)."),
    focus: z.enum(["words-vs-actions"]).optional(),
    since_revision: z.number().int().min(1).max(1_000_000_000).optional().describe("A dossier revision you already have: the answer says what changed since."),
    window: WINDOW.optional(),
    freshness: FRESHNESS.optional(),
  }).strict(),
  fomo_get_research_status: z.object({
    token: TOKEN.optional(),
    chain: CHAIN.optional(),
    request_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "a request id").optional().describe("A research request id to look up."),
  }).strict(),
} satisfies Record<FomoReadToolName, z.ZodType>;

// ── output: the research envelope ──────────────────────────────────────────

/** The most of one envelope's payload a result carries; past it the payload is withheld and said to be. */
export const DATA_MAX_CHARS = 200_000;
const PART_MAX_CHARS = 20_000;
const EVIDENCE_MAX = 100;
const CANDIDATES_MAX = 20;

const bounded = (max: number) => z.unknown().refine((v) => {
  try {
    return (JSON.stringify(v ?? null) ?? "").length <= max;
  } catch {
    return false;
  }
}, `larger than ${max} characters`);

const ms = z.number().nullable();

const envelopeOut = z.object({
  request_id: z.string(),
  tool: z.enum(Object.keys(INPUTS) as [FomoReadToolName, ...FomoReadToolName[]]),
  status: z.enum(STATUSES).describe("ok, empty (a successful read with no matching records — not proof nobody traded), partial, capped (a row or page limit was reached), stale (an older copy, labelled with its age), failed, unavailable (not configured or provider down), not-authorized (the owner's Fomo data access is off), budget-limited, needs-clarification or not-found."),
  reason: z.string().nullable().describe("A stable machine reason when status is not ok."),
  message: z.string().nullable(),
  answer: z.string().describe("Merrymen's plain-text rendering of this result: the answer first, then its freshness and coverage limits and the attribution."),
  subject: bounded(PART_MAX_CHARS).nullable().describe("The resolved subject (a coin, a trader or the market), or null."),
  candidates: z.array(bounded(PART_MAX_CHARS)).max(CANDIDATES_MAX).describe("For needs-clarification: the choices, none picked."),
  data: bounded(DATA_MAX_CHARS).nullable().describe("The tool's payload (worker/src/fomo/tools.ts). Null means unknown, never zero; provider figures are display and research data only."),
  data_omitted: z.boolean().describe("True when the payload was too large to return."),
  evidence: z.array(z.object({ id: z.string(), kind: z.enum(EVIDENCE_KINDS), sourceUrl: z.string().nullable() })).max(EVIDENCE_MAX),
  freshness: z.object({
    policy: z.enum(FRESHNESS_CLASSES),
    mode: z.enum(FRESHNESS_MODES as unknown as [string, ...string[]]),
    retrievedAt: ms.describe("Unix milliseconds: when Merrymen fetched it."),
    providerAsOf: ms,
    sourceEventAt: z.object({ oldest: ms, newest: ms }),
    lastRefreshAttemptAt: ms,
    lastRefreshOutcome: z.enum(REFRESH_OUTCOMES).nullable(),
    cacheAgeMs: ms,
    servedFrom: z.enum(SERVED_FROM),
  }),
  coverage: z.object({
    requested: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    achieved: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    pagesRequested: z.number(),
    pagesReturned: z.number(),
    itemsReturned: z.number(),
    duplicatesRemoved: z.number(),
    providerTotal: z.number().nullable(),
    capped: z.boolean(),
    missing: z.array(z.string()),
    notes: z.array(z.string()),
  }),
  usage: z.object({
    providerCalls: z.number(),
    cacheHits: z.number(),
    creditsCharged: z.number().nullable(),
    creditsRemaining: z.number().nullable(),
  }),
  dossier_revision: z.object({ dossier_id: z.string(), revision: z.number() }).nullable(),
  attribution: z.string(),
  untrusted_note: z.string(),
  observed_at: z.string(),
});

export type FomoToolOutput = z.infer<typeof envelopeOut>;

/** Every string, anywhere in a payload, with control and format characters stripped; non-finite numbers are unknown. */
function clean(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return stripControls(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (v === null || typeof v !== "object") return null;
  if (depth > 12) return null;
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clean(x, depth + 1);
  return out;
}

const size = (v: unknown): number => {
  try {
    return (JSON.stringify(v ?? null) ?? "").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/** The envelope as this tool returns it. */
export function shapeEnvelope(env: FomoEnvelope, nowMs: number): FomoToolOutput {
  const data = clean(env.data);
  const omitted = size(data) > DATA_MAX_CHARS;
  const part = (v: unknown) => {
    const c = clean(v);
    return size(c) <= PART_MAX_CHARS ? c : null;
  };
  return {
    request_id: env.requestId,
    tool: env.tool as FomoReadToolName,
    status: env.status,
    reason: env.reason === null ? null : stripControls(env.reason).slice(0, 200),
    message: env.message === null ? null : stripControls(env.message).slice(0, 500),
    answer: renderEnvelope(env, { audience: "owner", maxChars: 1_500, now: nowMs }),
    subject: part(env.subject),
    candidates: env.candidates.slice(0, CANDIDATES_MAX).map(part),
    data: omitted ? null : data,
    data_omitted: omitted,
    evidence: env.evidence.slice(0, EVIDENCE_MAX).map((e) => ({ id: stripControls(e.id), kind: e.kind, sourceUrl: e.sourceUrl === null ? null : stripControls(e.sourceUrl) })),
    freshness: { ...env.freshness, sourceEventAt: { ...env.freshness.sourceEventAt } },
    coverage: clean(env.coverage) as FomoToolOutput["coverage"],
    usage: { ...env.usage },
    dossier_revision: env.dossierRevision ? { dossier_id: env.dossierRevision.dossierId, revision: env.dossierRevision.revision } : null,
    attribution: FOMO_ATTRIBUTION,
    untrusted_note: UNTRUSTED_NOTE,
    observed_at: new Date(nowMs).toISOString(),
  };
}

// ── the tools ──────────────────────────────────────────────────────────────

/** Every provider-reading Fomo tool shares one bucket: they spend the same credits. */
const PROVIDER_BUDGET: Budget = { bucket: "fomo-provider", perMinute: 10, perHour: 120 };
/** The owner's research status reads only Merrymen's own store. */
const STATUS_BUDGET: Budget = { bucket: "fomo-status", perMinute: 30, perHour: 600 };
const TIMEOUT_MS = 25_000;
/** The refusal for a connection whose owner has no agent (no grant): the research credits are the fleet's owners'. */
const NEEDS_AGENT = "Fomo research is for Merrymen owners, and this account has no agent yet.";

const TITLES: Record<FomoReadToolName, string> = {
  fomo_resolve_subject: "Resolve a Fomo coin or trader",
  fomo_get_trader_context: "Fomo trader holdings",
  fomo_get_trader_activity: "Fomo trader activity",
  fomo_get_token_theses: "Fomo theses on a coin",
  fomo_get_token_activity: "Fomo activity on a coin",
  fomo_get_rankings: "Fomo leaderboards",
  fomo_find_opportunities: "Fomo early opportunities",
  fomo_research_coin: "Fomo research dossier",
  fomo_get_research_status: "My Fomo research status",
};

/** Run one registered read through the research service for this connection's owner. */
async function invokeFor(name: FomoReadToolName, args: Record<string, unknown>, ctx: ToolContext): Promise<{ data: FomoToolOutput; summary: string }> {
  // The registry's own validator is the final word on arguments, after zod.
  const checked = FOMO_TOOL_DEFS[name].validate(args);
  if (!checked.ok) throw new McpError("invalid_input", `That request could not be read as a Fomo lookup (${checked.reason}).`);
  // MCP runs on hosted Merrymen only (mcp/config.ts refuses to enable it otherwise), so the mode is hosted.
  const tenant = fomoTenantFor(ctx.principal.tenant, true);
  if (!tenant) throw new McpError("forbidden", "This connection has no owner Merrymen can vouch for.");
  // ONLY AN OWNER WITH AN AGENT. market:read needs no agent, and sign-in is
  // open, so without this any fresh wallet's connection spent the fleet's one
  // shared credit pool under caps of its own. The access reader refuses such
  // a tenant too (fomo-runtime.ts hostedFomoAccess); asking here first is what
  // makes the refusal say why. An unreadable grant store is "retry", never "no".
  let owner: boolean;
  try {
    owner = await hostedFomoOwner(tenant);
  } catch {
    throw new McpError("upstream_unavailable", "Fomo research is not reachable right now.", { retryAfterSec: 30 });
  }
  if (!owner) throw new McpError("forbidden", NEEDS_AGENT);
  let rt;
  try {
    rt = await fomoRuntime(true);
  } catch {
    throw new McpError("upstream_unavailable", "Fomo research is not reachable right now.", { retryAfterSec: 30 });
  }
  const nowMs = ctx.now() * 1000; // ctx.now() is unix SECONDS; the research subsystem counts milliseconds.
  const env = await rt.service.invoke(
    {
      tenant,
      surface: "mcp",
      audience: "owner",
      conversationKey: null,
      // Traceable to this MCP call, and unique per call (the request log is keyed by it).
      requestId: `${ctx.traceId.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 100)}.${randomUUID().slice(0, 8)}`,
      now: nowMs,
      priority: "interactive",
      signal: ctx.signal,
    },
    name,
    args,
  );
  const data = shapeEnvelope(env, nowMs);
  return { data, summary: data.answer };
}

function fomoTool<N extends FomoReadToolName>(name: N, capability: Capability) {
  const isStatus = capability === "agents.read";
  return defineTool({
    name,
    title: TITLES[name],
    // Public reads carry the provider's attribution; the owner's own status is Merrymen's record.
    description: isStatus ? FOMO_TOOL_DEFS[name].description : `${FOMO_TOOL_DEFS[name].description} ${FOMO_ATTRIBUTION}.`,
    capability,
    input: INPUTS[name] as (typeof INPUTS)[N],
    output: envelopeOut,
    // Reads only. The provider is outside Merrymen; the owner's status is not.
    annotations: { readOnlyHint: true, openWorldHint: !isStatus },
    budget: isStatus ? STATUS_BUDGET : PROVIDER_BUDGET,
    timeoutMs: TIMEOUT_MS,
    async handler(args, ctx) {
      return invokeFor(name, args as Record<string, unknown>, ctx);
    },
  });
}

export const FOMO_MCP_TOOLS = [
  fomoTool("fomo_resolve_subject", "market.read"),
  fomoTool("fomo_get_trader_context", "market.read"),
  fomoTool("fomo_get_trader_activity", "market.read"),
  fomoTool("fomo_get_token_theses", "market.read"),
  fomoTool("fomo_get_token_activity", "market.read"),
  fomoTool("fomo_get_rankings", "market.read"),
  fomoTool("fomo_find_opportunities", "market.read"),
  fomoTool("fomo_research_coin", "market.read"),
  fomoTool("fomo_get_research_status", "agents.read"),
] as unknown as readonly ToolDef[];
