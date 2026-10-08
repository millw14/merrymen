/**
 * THE FOMO BROKER — the one door every surface uses to reach the research
 * service, whether that service runs in this process or in the orchestrator
 * on the far side of an IPC channel.
 *
 *   createDirectBroker     self-hosted worker (and tests): wraps a local
 *                          FomoService with a FIXED tenant.
 *   createIpcBroker        hosted tenant child: holds no key and no database,
 *                          so it asks the orchestrator over the fork channel.
 *   serveBrokerRequests    orchestrator: answers ONE child, stamping the tenant
 *                          it already knows that child belongs to.
 *
 * WHO CHOOSES THE TENANT. Nobody on the asking side. The wire format has no
 * tenant field (contract.ts BrokerRequest), and the serving end ignores one if
 * a child sends it anyway: the tenant comes from which ChildProcess the bytes
 * arrived on, which the child cannot forge. Everything a tenant scopes —
 * permissions, budgets, subject memory, assessments — therefore follows the
 * process boundary rather than the contents of a message, a model argument or
 * a file the tenant can write.
 *
 * WHAT A CHILD IS TRUSTED WITH. Its own conversation keys and tool arguments,
 * which the service validates against each tool's schema anyway. Not its
 * tenant, not a surface it does not have (app chat, MCP), not the fleet's
 * position-protection budget reserve from a conversation, and not unbounded
 * concurrency, rate or message size. Every refusal is an envelope or a short
 * error code; nothing here throws at a caller, and nothing here reaches an
 * order, a key, a grant or a limit. Research proposes; it never disposes.
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sanitizeText } from "../research/news";
import type { BrokerCallOptions, BrokerReport, BrokerRequest, BrokerResponse, FomoBroker, FomoService, MemoryRead } from "./contract";
import { tokenFromKey } from "./identity";
import { followAssessmentOf, tenantKey } from "./store";
import type {
  FomoCallContext,
  FomoEnvelope,
  FomoSurface,
  FomoToolName,
  Freshness,
  FreshnessClass,
  FunnelStage,
  ResultStatus,
  RetrievalPriority,
} from "./types";

// ── limits ──────────────────────────────────────────────────────────────────

export const BROKER_LIMITS = Object.freeze({
  /**
   * A child's default bound on one request, IPC included. Above the
   * orchestrator's own ceiling (serveMaxCallMs), so the orchestrator answers
   * first, and that is above the provider's 45 s per-read deadline: live reads
   * took up to 11 s an attempt, and a bound below the provider's would turn a
   * slow but billed answer into "took too long".
   */
  childTimeoutMs: 55_000,
  /** Requests one child broker keeps open at once before answering "broker-busy". */
  childMaxInFlight: 8,
  /** The longest timeout any caller may ask for. */
  maxTimeoutMs: 120_000,
  /** The direct broker's bound when a caller gives none (above the provider's 45 s read deadline). */
  directTimeoutMs: 50_000,
  /** Tool calls one child may have running in the orchestrator at once. */
  serveMaxInFlight: 4,
  /** Tool calls one child may start per rolling minute. */
  servePerMinute: 30,
  /** Memory and report operations get this many times the call allowance (they are cheap, but not free). */
  serveStoreFactor: 4,
  /** The orchestrator's own ceiling on one tool call, whatever the child asked for (above the provider's 45 s read deadline). */
  serveMaxCallMs: 50_000,
  maxRequestBytes: 16 * 1024,
  maxResponseBytes: 256 * 1024,
  configuredRefreshMs: 60_000,
  idChars: 64,
  conversationKeyChars: 200,
  groupIdChars: 64,
  /** store.ts FOMO_LIMITS.subjectJsonChars. */
  memoryJsonChars: 16_384,
  heldTokens: 200,
  reportTextChars: 500,
  reportIdChars: 128,
});

// ── vocabularies ────────────────────────────────────────────────────────────
//
// Record<Union, true> (as store.ts does): the compiler insists every member of
// the union in types.ts is listed, so a tool or status added there cannot be
// silently refused here.

/**
 * Every registered tool, with the freshness class a failure envelope for it is
 * labelled with. A broker failure retrieved nothing, so the class only names
 * what KIND of data was being asked for.
 */
const TOOL_FRESHNESS: Readonly<Record<FomoToolName, FreshnessClass>> = {
  fomo_resolve_subject: "profile",
  fomo_get_trader_context: "holdings",
  fomo_get_trader_activity: "activity",
  fomo_get_token_theses: "theses",
  fomo_get_token_activity: "activity",
  fomo_get_rankings: "rankings",
  fomo_find_opportunities: "boards",
  fomo_research_coin: "theses",
  fomo_get_research_status: "activity",
  fomo_watch_coin: "activity",
  fomo_unwatch_coin: "activity",
  fomo_tail_trader: "activity",
  fomo_untail_trader: "activity",
  fomo_extend_tail: "activity",
};

/** The registered tool names (read-only and mutation), for both ends of the wire. */
export const FOMO_TOOL_NAMES: readonly FomoToolName[] = Object.freeze(Object.keys(TOOL_FRESHNESS) as FomoToolName[]);

export function isFomoToolName(v: unknown): v is FomoToolName {
  return typeof v === "string" && Object.hasOwn(TOOL_FRESHNESS, v);
}

const SURFACES: Record<FomoSurface, true> = { "app-chat": true, "telegram-dm": true, "telegram-group": true, mcp: true, background: true };

/**
 * The surfaces a hosted child actually has. App chat and MCP run in the web
 * process against its own service; a child claiming one is lying about where
 * the question came from, and surface drives budgets and audience rules.
 */
const CHILD_SURFACES: ReadonlySet<FomoSurface> = new Set<FomoSurface>(["telegram-dm", "telegram-group", "background"]);

const PRIORITIES: Record<RetrievalPriority, true> = { "position-protection": true, interactive: true, discovery: true };
const AUDIENCES: Record<"owner" | "group", true> = { owner: true, group: true };

const RESULT_STATUSES: Record<ResultStatus, true> = {
  ok: true,
  empty: true,
  partial: true,
  capped: true,
  stale: true,
  failed: true,
  unavailable: true,
  "not-authorized": true,
  "budget-limited": true,
  "needs-clarification": true,
  "not-found": true,
};

const SERVED_FROM: Record<Freshness["servedFrom"], true> = { live: true, cache: true, "stale-cache": true, none: true };

const FUNNEL_STAGES: Record<FunnelStage, true> = {
  NOT_DISCOVERED: true,
  DISCOVERY_SCREENED_OUT: true,
  RESEARCH_INCOMPLETE: true,
  MODEL_HOLD: true,
  GATE_FORCED_HOLD: true,
  PERMISSION_BLOCKED: true,
  UNSUPPORTED_ROUTE: true,
  SIZE_BELOW_ECONOMIC_FLOOR: true,
  SPONSORSHIP_UNAVAILABLE: true,
  BUDGET_EXHAUSTED: true,
  SUBMISSION_FAILED: true,
  SETTLEMENT_PENDING: true,
  LANDED: true,
};

const OPS: Record<BrokerRequest["op"], readonly string[]> = {
  call: ["tool", "args", "opts"],
  "memory-get": ["conversationKey"],
  "memory-read": ["conversationKey"],
  "memory-set": ["conversationKey", "json"],
  "memory-clear": ["conversationKey"],
  report: ["report"],
  configured: [],
};

const CALL_OPTION_FIELDS: ReadonlySet<string> = new Set(["surface", "audience", "conversationKey", "priority", "groupId", "timeoutMs"]);

/** Reasons that mean "not reachable or not set up" rather than "tried and failed". */
const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(["broker-unavailable", "not-configured", "no-key", "provider-unavailable"]);

function isIn<T extends string>(set: Record<T, true>, v: unknown): v is T {
  return typeof v === "string" && Object.hasOwn(set, v);
}

// ── small helpers ───────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A JSON-style object: what tool args must be. Not an array, a Date, a Map or a class instance. */
function isPlainRecord(v: unknown): v is Rec {
  if (!isRecord(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** UTF-8 size of the JSON the channel would carry, or null when it cannot be serialised at all. */
function jsonBytes(v: unknown): number | null {
  try {
    const s = JSON.stringify(v);
    return typeof s === "string" ? Buffer.byteLength(s, "utf8") : null;
  } catch {
    return null;
  }
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const REASON_SHAPE = /^[a-z0-9][a-z0-9:-]{0,63}$/;
const FIELD_SHAPE = /^[A-Za-z0-9_.-]{1,40}$/;
const PRICE8 = /^\d{1,24}(\.\d{1,8})?$/;

/** A bounded string with no control characters, or null. Not trimmed: keys are exact. */
function boundedString(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max && !CONTROL.test(v) ? v : null;
}

function idOf(v: unknown, max: number = BROKER_LIMITS.idChars): string | null {
  return typeof v === "string" && v.length <= max && ID_SHAPE.test(v) ? v : null;
}

/** A machine reason that is safe to put in an envelope: a short slug, never a free-text error. */
function reasonCode(v: unknown, fallback: string): string {
  return typeof v === "string" && REASON_SHAPE.test(v) ? v : fallback;
}

function timeOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && Number.isSafeInteger(Math.trunc(v)) ? Math.trunc(v) : null;
}

/** A caller's timeout, clamped to something sane; anything unusable is "use the default". */
function timeoutOf(v: unknown, fallback: number, ceiling: number = BROKER_LIMITS.maxTimeoutMs): number {
  const n = typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : fallback;
  return Math.max(1, Math.min(n, ceiling));
}

function requireTenant(tenant: string): string {
  if (typeof tenant !== "string" || !tenantKey(tenant) || tenant.length > 256 || CONTROL.test(tenant)) {
    // A broker without a tenant would either answer for nobody or for whoever
    // the service defaults to. Neither is a state worth starting in.
    throw new TypeError("fomo broker: a tenant from trusted context is required");
  }
  return tenant;
}

const errorName = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

// ── envelopes ───────────────────────────────────────────────────────────────

/**
 * A complete envelope for a call the broker could not complete. Matches
 * types.ts field for field so a surface renders it like any other answer.
 *
 * Every clock is null and servedFrom is "none": nothing was retrieved, so
 * there is no copy whose age could be stated. `now` only seeds the fallback
 * request id; it is never written into a freshness field.
 */
export function brokerFailureEnvelope(
  tool: FomoToolName,
  reason: string,
  message: string,
  now: number,
  requestId?: string,
  status?: "failed" | "unavailable",
): FomoEnvelope {
  const code = reasonCode(reason, "broker-error");
  return {
    requestId: idOf(requestId, 128) ?? `brk-${Number.isFinite(now) ? Math.trunc(now) : 0}-${randomUUID().slice(0, 8)}`,
    tool: isFomoToolName(tool) ? tool : "fomo_get_research_status",
    status: status ?? (UNAVAILABLE_REASONS.has(code) ? "unavailable" : "failed"),
    subject: null,
    candidates: [],
    data: null,
    evidence: [],
    freshness: {
      policy: isFomoToolName(tool) ? TOOL_FRESHNESS[tool] : "activity",
      mode: "prefer-fresh",
      retrievedAt: null,
      providerAsOf: null,
      sourceEventAt: { oldest: null, newest: null },
      lastRefreshAttemptAt: null,
      lastRefreshOutcome: null,
      cacheAgeMs: null,
      servedFrom: "none",
    },
    coverage: {
      requested: {},
      achieved: {},
      pagesRequested: 0,
      pagesReturned: 0,
      itemsReturned: 0,
      duplicatesRemoved: 0,
      providerTotal: null,
      capped: false,
      missing: [],
      notes: [],
    },
    usage: { providerCalls: 0, cacheHits: 0, creditsCharged: null, creditsRemaining: null },
    dossierRevision: null,
    reason: code,
    message: sanitizeText(message, 300) || null,
  };
}

/**
 * An envelope as it came back from a service or across the wire, or null when
 * it is not one. Shallow on purpose: the service owns `data`'s shape; this
 * only guarantees the fields every surface reads exist with the right types,
 * so a broken answer becomes a failure envelope instead of a crash.
 */
export function envelopeOf(v: unknown, tool?: FomoToolName): FomoEnvelope | null {
  if (!isRecord(v)) return null;
  if (typeof v.requestId !== "string" || v.requestId.length === 0 || v.requestId.length > 128) return null;
  if (!isFomoToolName(v.tool) || (tool !== undefined && v.tool !== tool)) return null;
  if (!isIn(RESULT_STATUSES, v.status)) return null;
  if (!(v.subject === null || v.subject === undefined || isRecord(v.subject))) return null;
  if (!Array.isArray(v.candidates) || !Array.isArray(v.evidence)) return null;
  const f = v.freshness;
  if (!isRecord(f) || !isIn(SERVED_FROM, f.servedFrom)) return null;
  const c = v.coverage;
  if (!isRecord(c) || !Array.isArray(c.notes) || !Array.isArray(c.missing)) return null;
  if (!isRecord(v.usage)) return null;
  const d = v.dossierRevision;
  if (!(d === null || d === undefined || (isRecord(d) && typeof d.dossierId === "string" && Number.isSafeInteger(d.revision)))) return null;
  if (!(v.reason === null || v.reason === undefined || typeof v.reason === "string")) return null;
  if (!(v.message === null || v.message === undefined || typeof v.message === "string")) return null;
  return {
    ...(v as unknown as FomoEnvelope),
    subject: (v.subject ?? null) as FomoEnvelope["subject"],
    data: v.data === undefined ? null : v.data,
    dossierRevision: (d ?? null) as FomoEnvelope["dossierRevision"],
    reason: (v.reason ?? null) as string | null,
    message: (v.message ?? null) as string | null,
  };
}

const TRIM_NOTE = "The full result was too large to pass along here; ask a narrower question to see the rest.";

/**
 * Fit an envelope into `maxBytes` of wire message. Data goes first (the
 * status then says partial, never ok, and coverage says why), then the long
 * lists, and if even that is too big the answer becomes a failure envelope.
 * Null only when the limit is too small for any envelope at all.
 */
function fitEnvelope(env: FomoEnvelope, id: string, maxBytes: number, now: number): FomoEnvelope | null {
  const fits = (e: FomoEnvelope): boolean => {
    const b = jsonBytes({ fomo: 1, id, ok: true, result: e });
    return b !== null && b <= maxBytes;
  };
  if (fits(env)) return env;
  const notes = Array.isArray(env.coverage.notes) ? env.coverage.notes : [];
  const missing = Array.isArray(env.coverage.missing) ? env.coverage.missing : [];
  // A trimmed "ok" is no longer ok. Every other status (stale, failed,
  // not-authorized…) is a fact about the read that trimming does not change.
  const status: ResultStatus = env.status === "ok" || env.status === "capped" ? "partial" : env.status;
  const withoutData: FomoEnvelope = {
    ...env,
    status,
    data: null,
    coverage: {
      ...env.coverage,
      capped: true,
      missing: missing.includes("data") ? missing : [...missing, "data"],
      notes: [...notes, TRIM_NOTE],
    },
  };
  if (fits(withoutData)) return withoutData;
  const bare: FomoEnvelope = {
    ...withoutData,
    candidates: [],
    evidence: [],
    coverage: { ...withoutData.coverage, requested: {}, achieved: {}, missing: ["data", "evidence"], notes: [TRIM_NOTE] },
  };
  if (fits(bare)) return bare;
  const failed = brokerFailureEnvelope(env.tool, "response-too-large", "The result was too large to pass along here.", now, env.requestId);
  return fits(failed) ? failed : null;
}

// ── call options ────────────────────────────────────────────────────────────

type WireCallOptions = Omit<BrokerCallOptions, "signal">;

/** What the service receives: the contract context plus the Telegram group id budgets need (budget.ts ChargeRequest.groupId). */
export type BrokerCallContext = FomoCallContext & { groupId: string | null };

type ParsedOptions = { ok: true; opts: WireCallOptions; extras: string[] } | { ok: false; reason: string };

/**
 * Validate call options. `surfaces` limits who may be claimed (a child has
 * only its Telegram surfaces and background work).
 *
 * POSITION PROTECTION IS A BACKGROUND CLASS. Its reserved budget share exists
 * so the tick can always check a held coin; a conversation that labelled its
 * questions that way would spend the fleet's protection reserve on chat. A
 * conversational surface asking for it is served as interactive: mislabelled
 * work is demoted, never promoted (budget.ts says the same of an unknown
 * priority).
 */
function parseCallOptions(v: unknown, surfaces: ReadonlySet<FomoSurface> | null): ParsedOptions {
  if (!isRecord(v)) return { ok: false, reason: "invalid-request" };
  if (!isIn(SURFACES, v.surface) || (surfaces !== null && !surfaces.has(v.surface))) return { ok: false, reason: "invalid-request" };
  if (!isIn(AUDIENCES, v.audience)) return { ok: false, reason: "invalid-request" };
  // A group can never be the owner's audience: private research state stays in DMs.
  if (v.surface === "telegram-group" && v.audience !== "group") return { ok: false, reason: "invalid-request" };
  if (!isIn(PRIORITIES, v.priority)) return { ok: false, reason: "invalid-request" };
  let conversationKey: string | null = null;
  if (v.conversationKey !== null && v.conversationKey !== undefined) {
    conversationKey = boundedString(v.conversationKey, BROKER_LIMITS.conversationKeyChars);
    if (conversationKey === null) return { ok: false, reason: "invalid-request" };
  }
  let groupId: string | null = null;
  if (v.groupId !== null && v.groupId !== undefined) {
    groupId = boundedString(v.groupId, BROKER_LIMITS.groupIdChars);
    if (groupId === null) return { ok: false, reason: "invalid-request" };
  }
  let timeoutMs: number | undefined;
  if (v.timeoutMs !== undefined && v.timeoutMs !== null) {
    if (typeof v.timeoutMs !== "number" || !Number.isFinite(v.timeoutMs) || v.timeoutMs <= 0) return { ok: false, reason: "invalid-request" };
    timeoutMs = Math.min(Math.trunc(v.timeoutMs) || 1, BROKER_LIMITS.maxTimeoutMs);
  }
  const priority: RetrievalPriority = v.priority === "position-protection" && v.surface !== "background" ? "interactive" : v.priority;
  const extras = Object.keys(v).filter((k) => !CALL_OPTION_FIELDS.has(k) && k !== "signal");
  const opts: WireCallOptions = { surface: v.surface, audience: v.audience, conversationKey, priority, groupId };
  if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs;
  return { ok: true, opts, extras };
}

// ── requests ────────────────────────────────────────────────────────────────

export type ParsedBrokerRequest = { ok: true; request: BrokerRequest; extras: string[] } | { ok: false; reason: string };

/**
 * Validate one wire request from a child. Fields the op does not define are
 * returned as `extras` and never read — a `tenant` among them included; the
 * caller stamps the tenant it knows. A report is only checked to be an object
 * here; validateBrokerReport judges it against the stamped tenant.
 */
export function parseBrokerRequest(v: unknown): ParsedBrokerRequest {
  if (!isRecord(v) || v.fomo !== 1) return { ok: false, reason: "invalid-request" };
  const id = idOf(v.id);
  if (!id) return { ok: false, reason: "invalid-request" };
  if (typeof v.op !== "string" || !Object.hasOwn(OPS, v.op)) return { ok: false, reason: "unknown-op" };
  const op = v.op as BrokerRequest["op"];
  const allowed = new Set(["fomo", "id", "op", ...OPS[op]]);
  const extras = Object.keys(v).filter((k) => !allowed.has(k));
  switch (op) {
    case "call": {
      if (!isFomoToolName(v.tool)) return { ok: false, reason: "unknown-tool" };
      if (!isPlainRecord(v.args)) return { ok: false, reason: "invalid-request" };
      const o = parseCallOptions(v.opts, CHILD_SURFACES);
      if (!o.ok) return o;
      return { ok: true, request: { fomo: 1, id, op, tool: v.tool, args: v.args, opts: o.opts }, extras: [...extras, ...o.extras.map((k) => `opts.${k}`)] };
    }
    case "memory-get":
    case "memory-read":
    case "memory-clear": {
      const conversationKey = boundedString(v.conversationKey, BROKER_LIMITS.conversationKeyChars);
      if (!conversationKey) return { ok: false, reason: "invalid-request" };
      return { ok: true, request: { fomo: 1, id, op, conversationKey }, extras };
    }
    case "memory-set": {
      const conversationKey = boundedString(v.conversationKey, BROKER_LIMITS.conversationKeyChars);
      if (!conversationKey) return { ok: false, reason: "invalid-request" };
      if (typeof v.json !== "string" || v.json.length === 0 || v.json.length > BROKER_LIMITS.memoryJsonChars) return { ok: false, reason: "invalid-request" };
      return { ok: true, request: { fomo: 1, id, op, conversationKey, json: v.json }, extras };
    }
    case "report":
      if (!isRecord(v.report)) return { ok: false, reason: "invalid-report" };
      return { ok: true, request: { fomo: 1, id, op, report: v.report as unknown as BrokerReport }, extras };
    case "configured":
      return { ok: true, request: { fomo: 1, id, op }, extras };
  }
}

// ── strict memory reads ────────────────────────────────────────────────────

/**
 * A strict read as the service (or the wire) answered it, checked for shape.
 * Anything but `ok: true` with a null or an in-bounds string value is a
 * failure: a malformed answer never reads as "nothing stored".
 */
export function memoryReadOf(v: unknown, failure = "bad-response"): MemoryRead {
  if (!isRecord(v) || v.ok !== true || !Object.hasOwn(v, "value")) return { ok: false, reason: failure };
  if (v.value === null) return { ok: true, value: null };
  if (typeof v.value === "string" && v.value.length <= BROKER_LIMITS.memoryJsonChars) return { ok: true, value: v.value };
  return { ok: false, reason: failure };
}

// ── reports ─────────────────────────────────────────────────────────────────

export type ReportCheck = { ok: true; report: BrokerReport } | { ok: false; reason: "invalid-report" | "wrong-tenant" };

function tokenKeyOf(v: unknown): string | null {
  return typeof v === "string" && v.length <= 256 && tokenFromKey(v) !== null ? v : null;
}

function textOf(v: unknown, max: number): string | null {
  return typeof v === "string" ? sanitizeText(v, max) || null : null;
}

/**
 * Rebuild a report field by field for the stamped tenant, or refuse it. A
 * report can only ever be about the reporter's own book: an assessment whose
 * tenant is anyone else's is refused outright (not rewritten — a child that
 * sends one has a bug or an intent, and either should be visible).
 */
export function validateBrokerReport(v: unknown, tenant: string): ReportCheck {
  const invalid: ReportCheck = { ok: false, reason: "invalid-report" };
  if (!isRecord(v)) return invalid;
  switch (v.kind) {
    case "assessment": {
      const a = followAssessmentOf(v.assessment);
      if (!a) return invalid;
      const stamped = tenantKey(tenant);
      if (!stamped || a.tenant !== stamped) return { ok: false, reason: "wrong-tenant" };
      return { ok: true, report: { kind: "assessment", assessment: a } };
    }
    case "funnel": {
      const tokenKey = tokenKeyOf(v.tokenKey);
      const atMs = timeOf(v.atMs);
      const detail = typeof v.detail === "string" ? sanitizeText(v.detail, BROKER_LIMITS.reportTextChars) : null;
      const decisionId = v.decisionId === null || v.decisionId === undefined ? null : idOf(v.decisionId, BROKER_LIMITS.reportIdChars);
      if (!tokenKey || atMs === null || detail === null || !isIn(FUNNEL_STAGES, v.stage)) return invalid;
      if (v.decisionId !== null && v.decisionId !== undefined && decisionId === null) return invalid;
      return { ok: true, report: { kind: "funnel", tokenKey, stage: v.stage, detail, decisionId, atMs } };
    }
    case "position-dependency": {
      const userId = idOf(v.userId, BROKER_LIMITS.reportIdChars);
      const tokenKey = tokenKeyOf(v.tokenKey);
      const reason = textOf(v.reason, 200);
      const expiresAtMs = timeOf(v.expiresAtMs);
      if (!userId || !tokenKey || !reason || expiresAtMs === null) return invalid;
      return { ok: true, report: { kind: "position-dependency", userId, tokenKey, reason, expiresAtMs } };
    }
    case "outcome": {
      const assessmentId = idOf(v.assessmentId, BROKER_LIMITS.reportIdChars);
      const horizonLabel = textOf(v.horizonLabel, 32);
      const observedAtMs = timeOf(v.observedAtMs);
      if (!assessmentId || !horizonLabel || observedAtMs === null) return invalid;
      // Our own 8dp quote, or unknown. Never a guessed number.
      if (!(v.price8 === null || (typeof v.price8 === "string" && PRICE8.test(v.price8)))) return invalid;
      if (!(v.note === null || v.note === undefined || typeof v.note === "string")) return invalid;
      return {
        ok: true,
        report: { kind: "outcome", assessmentId, horizonLabel, observedAtMs, price8: v.price8, note: textOf(v.note, BROKER_LIMITS.reportTextChars) },
      };
    }
    case "held-tokens": {
      const atMs = timeOf(v.atMs);
      if (atMs === null || !Array.isArray(v.tokenKeys) || v.tokenKeys.length > BROKER_LIMITS.heldTokens) return invalid;
      const keys: string[] = [];
      for (const k of v.tokenKeys) {
        // One bad key refuses the whole report: silently dropping a held coin
        // would quietly remove it from position protection.
        const key = tokenKeyOf(k);
        if (!key) return invalid;
        if (!keys.includes(key)) keys.push(key);
      }
      return { ok: true, report: { kind: "held-tokens", tokenKeys: keys, atMs } };
    }
    default:
      return invalid;
  }
}

// ── bounded execution ───────────────────────────────────────────────────────

type Bounded<T> = { kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" } | { kind: "aborted" };

/**
 * Run `work` with an AbortSignal that fires on timeout or on the caller's own
 * abort. `outcome` resolves at the first of: result, error, timeout, abort.
 * `settled` resolves only when the work itself has finished, which is what a
 * concurrency slot must wait for: a timed-out call that is still running is
 * still load.
 */
function runBounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | null,
  outer?: AbortSignal,
): { outcome: Promise<Bounded<T>>; settled: Promise<void> } {
  if (outer?.aborted) return { outcome: Promise.resolve({ kind: "aborted" }), settled: Promise.resolve() };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  let resolveOutcome!: (b: Bounded<T>) => void;
  const outcome = new Promise<Bounded<T>>((resolve) => {
    resolveOutcome = resolve;
  });
  const onAbort = (): void => {
    controller.abort();
    finish({ kind: "aborted" });
  };
  function finish(b: Bounded<T>): void {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
    resolveOutcome(b);
  }
  outer?.addEventListener("abort", onAbort, { once: true });
  if (timeoutMs !== null) {
    timer = setTimeout(() => {
      controller.abort();
      finish({ kind: "timeout" });
    }, timeoutMs);
  }
  let p: Promise<T>;
  try {
    p = Promise.resolve(work(controller.signal));
  } catch (error) {
    p = Promise.reject(error);
  }
  const settled = p.then(
    (value) => finish({ kind: "ok", value }),
    (error: unknown) => finish({ kind: "error", error }),
  );
  return { outcome, settled };
}

const MESSAGES = {
  timeout: "The research took too long to answer.",
  aborted: "The research request was cancelled.",
  serviceError: "The research service could not answer this time.",
  invalid: "That research request was not in a shape the service accepts.",
  unknownTool: "That research tool does not exist.",
  rateLimited: "Too many research requests from this agent just now; try again in a minute.",
  unavailable: "Research is not reachable from this agent right now.",
  busy: "This agent already has several research requests open; try again shortly.",
  badResponse: "The research answer arrived in a shape this agent could not read.",
  tooLarge: "That research request was too large to send.",
} as const;

const TIMEOUT_NOTE = "No answer arrived in time; work may have continued upstream, so usage here is not a complete count.";

function withNote(env: FomoEnvelope, note: string): FomoEnvelope {
  return { ...env, coverage: { ...env.coverage, notes: [...env.coverage.notes, note] } };
}

/** Turn a bounded service call into the envelope a surface sees. */
function envelopeFromOutcome(out: Bounded<unknown>, tool: FomoToolName, now: number, requestId: string): FomoEnvelope {
  switch (out.kind) {
    case "ok":
      return envelopeOf(out.value, tool) ?? brokerFailureEnvelope(tool, "service-error", MESSAGES.serviceError, now, requestId);
    case "error":
      // Never the error's own text: it can carry a URL, a header or a stack.
      return brokerFailureEnvelope(tool, "service-error", MESSAGES.serviceError, now, requestId);
    case "timeout":
      return withNote(brokerFailureEnvelope(tool, "timeout", MESSAGES.timeout, now, requestId), TIMEOUT_NOTE);
    case "aborted":
      return brokerFailureEnvelope(tool, "aborted", MESSAGES.aborted, now, requestId);
  }
}

// ── direct broker (self-hosted, tests) ─────────────────────────────────────

export interface DirectBrokerOptions {
  now?: () => number;
  newId?: () => string;
  /** Bound for a call that names no timeout (default 50 s). */
  defaultTimeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * A broker over a service in this process, for ONE fixed tenant (the
 * self-hosted worker passes SELF_HOSTED_TENANT). The same option rules as the
 * IPC path apply, so a surface behaves identically hosted or self-hosted.
 *
 * Memory and report never reject: subject memory is a convenience whose
 * absence the surfaces already handle (a fresh conversation), and reports are
 * best effort by contract.
 */
export function createDirectBroker(service: FomoService, tenant: string, opts: DirectBrokerOptions = {}): FomoBroker {
  const fixed = requireTenant(tenant);
  const clock = opts.now ?? Date.now;
  const newId = opts.newId ?? randomUUID;
  const defaultTimeout = timeoutOf(opts.defaultTimeoutMs, BROKER_LIMITS.directTimeoutMs);
  const log = opts.log ?? (() => {});

  return {
    async call(tool, args, callOpts) {
      const now = clock();
      const requestId = newId();
      if (!isFomoToolName(tool)) return brokerFailureEnvelope("fomo_get_research_status", "unknown-tool", MESSAGES.unknownTool, now, requestId);
      const parsed = parseCallOptions(callOpts, null);
      if (!parsed.ok || !isPlainRecord(args)) return brokerFailureEnvelope(tool, "invalid-request", MESSAGES.invalid, now, requestId);
      const o = parsed.opts;
      const timeout = timeoutOf(o.timeoutMs, defaultTimeout);
      const { outcome } = runBounded(
        (signal) => {
          const ctx: BrokerCallContext = {
            tenant: fixed,
            surface: o.surface,
            audience: o.audience,
            conversationKey: o.conversationKey,
            requestId,
            now,
            priority: o.priority,
            groupId: o.groupId ?? null,
            signal,
            budgetMs: timeout,
          };
          return service.invoke(ctx, tool, args);
        },
        timeout,
        callOpts?.signal,
      );
      const out = await outcome;
      if (out.kind === "error") log(`fomo broker: ${tool} failed in the service (${errorName(out.error)})`);
      return envelopeFromOutcome(out, tool, now, requestId);
    },
    memory: {
      async get(conversationKey) {
        const key = boundedString(conversationKey, BROKER_LIMITS.conversationKeyChars);
        if (!key) return null;
        try {
          const v = await service.memoryGet(fixed, key);
          return typeof v === "string" ? v : null;
        } catch (e) {
          log(`fomo broker: memory read failed (${errorName(e)})`);
          return null;
        }
      },
      async read(conversationKey) {
        const key = boundedString(conversationKey, BROKER_LIMITS.conversationKeyChars);
        if (!key) return { ok: false, reason: "invalid-request" };
        // A service that cannot tell a store error from "nothing stored" proves nothing.
        if (typeof service.memoryRead !== "function") return { ok: false, reason: "strict-read-unsupported" };
        try {
          return memoryReadOf(await service.memoryRead(fixed, key), "memory-read-failed");
        } catch (e) {
          log(`fomo broker: strict memory read failed (${errorName(e)})`);
          return { ok: false, reason: "memory-read-failed" };
        }
      },
      async set(conversationKey, json) {
        const key = boundedString(conversationKey, BROKER_LIMITS.conversationKeyChars);
        if (!key || typeof json !== "string" || json.length === 0 || json.length > BROKER_LIMITS.memoryJsonChars) return;
        try {
          await service.memorySet(fixed, key, json, clock());
        } catch (e) {
          log(`fomo broker: memory write failed (${errorName(e)})`);
        }
      },
      async clear(conversationKey) {
        const key = boundedString(conversationKey, BROKER_LIMITS.conversationKeyChars);
        if (!key) return;
        try {
          await service.memoryClear(fixed, key);
        } catch (e) {
          log(`fomo broker: memory clear failed (${errorName(e)})`);
        }
      },
    },
    async report(r) {
      const checked = validateBrokerReport(r, fixed);
      if (!checked.ok) {
        log(`fomo broker: report refused (${checked.reason})`);
        return;
      }
      try {
        await service.report(fixed, checked.report, clock());
      } catch (e) {
        log(`fomo broker: report failed (${errorName(e)})`);
      }
    },
    configured() {
      try {
        return service.configured() === true;
      } catch {
        return false;
      }
    },
  };
}

// ── the channel ─────────────────────────────────────────────────────────────

/**
 * One end of a message channel. `send` returns false when the message was not
 * accepted (closed channel, unserialisable message). Messages that are not
 * Fomo broker messages may arrive on the same channel and are ignored.
 */
export interface BrokerPort {
  send(msg: BrokerRequest | BrokerResponse): boolean;
  onMessage(handler: (msg: unknown) => void): () => void;
  connected(): boolean;
  /** Optional: lets pending requests fail at once when the channel closes, instead of at their timeout. */
  onDisconnect?(handler: () => void): () => void;
}

/**
 * The forked child's end of the IPC channel, or null when this process has
 * none (self-hosted, or a child spawned without "ipc" in its stdio).
 *
 * WHY send() PASSES A CALLBACK. Without one, a send on a channel that has just
 * closed emits 'error' on `process`, and an unhandled 'error' event kills the
 * child. A closed channel is already visible through connected().
 *
 * WHY true EVEN WHEN process.send RETURNS false. Node returns false for a
 * backlog too, and a backlogged message is still queued and still delivered;
 * reporting it as unsent would answer "unavailable" for a request that is
 * about to be served. A truly closed channel is caught by connected() first.
 */
export function processBrokerPort(proc: NodeJS.Process = process): BrokerPort | null {
  if (typeof proc.send !== "function") return null;
  return {
    send(msg) {
      if (proc.connected !== true || typeof proc.send !== "function") return false;
      try {
        proc.send(msg, undefined, undefined, () => {});
        return true;
      } catch {
        return false;
      }
    },
    onMessage(handler) {
      const listener = (m: unknown): void => handler(m);
      proc.on("message", listener);
      return () => {
        proc.off("message", listener);
      };
    },
    connected: () => proc.connected === true,
    onDisconnect(handler) {
      proc.on("disconnect", handler);
      return () => {
        proc.off("disconnect", handler);
      };
    },
  };
}

/** The orchestrator's end of one child's IPC channel. The child must be spawned with "ipc" in its stdio. */
export function childProcessBrokerPort(child: ChildProcess): BrokerPort {
  return {
    send(msg) {
      if (child.connected !== true || typeof child.send !== "function") return false;
      try {
        // The callback swallows a close race: an unhandled 'error' on a
        // ChildProcess would take the orchestrator down with it.
        child.send(msg, () => {});
        return true;
      } catch {
        return false;
      }
    },
    onMessage(handler) {
      const listener = (m: unknown): void => handler(m);
      child.on("message", listener);
      return () => {
        child.off("message", listener);
      };
    },
    connected: () => child.connected === true,
    onDisconnect(handler) {
      child.on("disconnect", handler);
      return () => {
        child.off("disconnect", handler);
      };
    },
  };
}

// ── IPC broker (hosted child) ───────────────────────────────────────────────

export interface IpcBrokerOptions {
  /** Default bound on one request, IPC included (55 s). A call's own timeoutMs wins. */
  timeoutMs?: number;
  now?: () => number;
  newId?: () => string;
  /** Open requests before "broker-busy" (8). */
  maxInFlight?: number;
  /** Refuse to send a request larger than this (16 KiB, the orchestrator's limit). */
  maxRequestBytes?: number;
  log?: (line: string) => void;
}

type Wire =
  | { kind: "result"; result: unknown }
  | { kind: "refused"; error: string }
  | { kind: "bad-response" }
  | { kind: "timeout" }
  | { kind: "unavailable" }
  | { kind: "busy" }
  | { kind: "aborted" }
  | { kind: "too-large" }
  | { kind: "invalid" };

function wireFailure(tool: FomoToolName, w: Exclude<Wire, { kind: "result" }>, now: number, id: string | undefined): FomoEnvelope {
  switch (w.kind) {
    case "refused": {
      const msg =
        w.error === "rate-limited" ? MESSAGES.rateLimited : w.error === "unknown-tool" ? MESSAGES.unknownTool : w.error === "request-too-large" ? MESSAGES.tooLarge : MESSAGES.invalid;
      return brokerFailureEnvelope(tool, w.error, msg, now, id, "failed");
    }
    case "bad-response":
      return brokerFailureEnvelope(tool, "broker-bad-response", MESSAGES.badResponse, now, id);
    case "timeout":
      return withNote(brokerFailureEnvelope(tool, "broker-timeout", MESSAGES.timeout, now, id), TIMEOUT_NOTE);
    case "unavailable":
      return brokerFailureEnvelope(tool, "broker-unavailable", MESSAGES.unavailable, now, id, "unavailable");
    case "busy":
      return brokerFailureEnvelope(tool, "broker-busy", MESSAGES.busy, now, id);
    case "aborted":
      return brokerFailureEnvelope(tool, "aborted", MESSAGES.aborted, now, id);
    case "too-large":
      return brokerFailureEnvelope(tool, "request-too-large", MESSAGES.tooLarge, now, id);
    case "invalid":
      return brokerFailureEnvelope(tool, "invalid-request", MESSAGES.invalid, now, id);
  }
}

/**
 * The hosted child's broker. Every request carries a fresh id; a response is
 * matched ONLY by that id and checked for shape before anything reads it.
 *
 * WHY IT LISTENS ONLY WHILE A REQUEST IS OPEN. A 'message' listener on
 * `process` holds the IPC channel open, which keeps a child alive that would
 * otherwise exit. Subscribing only while something is pending means wiring a
 * broker into a child never changes when that child can exit.
 */
export function createIpcBroker(port: BrokerPort, opts: IpcBrokerOptions = {}): FomoBroker & { close(): void } {
  const clock = opts.now ?? Date.now;
  const newId = opts.newId ?? randomUUID;
  const defaultTimeout = timeoutOf(opts.timeoutMs, BROKER_LIMITS.childTimeoutMs);
  const maxInFlight = Math.max(1, Math.trunc(opts.maxInFlight ?? BROKER_LIMITS.childMaxInFlight));
  const maxRequestBytes = Math.max(256, Math.trunc(opts.maxRequestBytes ?? BROKER_LIMITS.maxRequestBytes));
  const log = opts.log ?? (() => {});
  const pending = new Map<string, (w: Wire) => void>();
  let unsubscribe: (() => void) | null = null;
  let unsubscribeDisconnect: (() => void) | null = null;
  let closed = false;

  const onMessage = (msg: unknown): void => {
    if (!isRecord(msg) || msg.fomo !== 1 || typeof msg.id !== "string") return;
    const settle = pending.get(msg.id);
    if (!settle) return;
    if (msg.ok === true && Object.hasOwn(msg, "result")) settle({ kind: "result", result: msg.result });
    else if (msg.ok === false) settle({ kind: "refused", error: reasonCode(msg.error, "broker-refused") });
    else settle({ kind: "bad-response" });
  };
  const onDisconnect = (): void => {
    for (const settle of [...pending.values()]) settle({ kind: "unavailable" });
  };
  const subscribe = (): void => {
    if (unsubscribe) return;
    unsubscribe = port.onMessage(onMessage);
    unsubscribeDisconnect = port.onDisconnect?.(onDisconnect) ?? null;
  };
  const unsubscribeIfIdle = (): void => {
    if (pending.size > 0 || !unsubscribe) return;
    unsubscribe();
    unsubscribe = null;
    unsubscribeDisconnect?.();
    unsubscribeDisconnect = null;
  };
  const isConnected = (): boolean => {
    try {
      return port.connected() === true;
    } catch {
      return false;
    }
  };

  function request(build: (id: string) => BrokerRequest, timeoutMs: number, signal?: AbortSignal): Promise<{ id: string | undefined; wire: Wire }> {
    if (closed) return Promise.resolve({ id: undefined, wire: { kind: "unavailable" } });
    if (signal?.aborted) return Promise.resolve({ id: undefined, wire: { kind: "aborted" } });
    if (pending.size >= maxInFlight) return Promise.resolve({ id: undefined, wire: { kind: "busy" } });
    if (!isConnected()) return Promise.resolve({ id: undefined, wire: { kind: "unavailable" } });
    const fresh = idOf(newId());
    const id = fresh && !pending.has(fresh) ? fresh : randomUUID();
    const msg = build(id);
    const bytes = jsonBytes(msg);
    if (bytes === null) return Promise.resolve({ id, wire: { kind: "invalid" } });
    if (bytes > maxRequestBytes) return Promise.resolve({ id, wire: { kind: "too-large" } });
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = (): void => settle({ kind: "aborted" });
      function settle(w: Wire): void {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pending.delete(id);
        unsubscribeIfIdle();
        resolve({ id, wire: w });
      }
      // Registered BEFORE send, so even a synchronous reply finds its request.
      pending.set(id, settle);
      subscribe();
      timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      let sent = false;
      try {
        sent = port.send(msg) === true;
      } catch {
        sent = false;
      }
      if (!sent) settle({ kind: "unavailable" });
    });
  }

  // configured() is synchronous by contract, so it answers from a cache that
  // is refreshed in the background at most once a minute. Unknown is false:
  // "not configured" is the honest answer until the orchestrator has said so.
  let configuredKnown: boolean | null = null;
  let configuredAskedAt = Number.NEGATIVE_INFINITY;
  let configuredAsking = false;
  const refreshConfigured = (): void => {
    const now = clock();
    if (closed || configuredAsking || now - configuredAskedAt < BROKER_LIMITS.configuredRefreshMs) return;
    configuredAsking = true;
    configuredAskedAt = now;
    void request((id) => ({ fomo: 1, id, op: "configured" }), defaultTimeout).then(({ wire }) => {
      configuredAsking = false;
      if (wire.kind === "result" && typeof wire.result === "boolean") configuredKnown = wire.result;
      // Never sent at all: ask again on the next look rather than a minute later.
      else if (wire.kind === "unavailable" || wire.kind === "busy") configuredAskedAt = Number.NEGATIVE_INFINITY;
    });
  };

  const broker: FomoBroker & { close(): void } = {
    async call(tool, args, callOpts) {
      const now = clock();
      if (!isFomoToolName(tool)) return brokerFailureEnvelope("fomo_get_research_status", "unknown-tool", MESSAGES.unknownTool, now);
      const parsed = parseCallOptions(callOpts, CHILD_SURFACES);
      if (!parsed.ok || !isPlainRecord(args)) return brokerFailureEnvelope(tool, "invalid-request", MESSAGES.invalid, now);
      const wireOpts = parsed.opts;
      const timeout = timeoutOf(wireOpts.timeoutMs, defaultTimeout);
      // The orchestrator bounds its own work by the same number.
      const sentOpts: WireCallOptions = { ...wireOpts, timeoutMs: timeout };
      const { id, wire } = await request((rid) => ({ fomo: 1, id: rid, op: "call", tool, args, opts: sentOpts }), timeout, callOpts?.signal);
      if (wire.kind === "result") {
        const env = envelopeOf(wire.result, tool);
        if (env) return env;
        log(`fomo broker: ${tool} answer had the wrong shape`);
        return wireFailure(tool, { kind: "bad-response" }, now, id);
      }
      return wireFailure(tool, wire, now, id);
    },
    memory: {
      async get(conversationKey) {
        const key = boundedString(conversationKey, BROKER_LIMITS.conversationKeyChars);
        if (!key) return null;
        const { wire } = await request((id) => ({ fomo: 1, id, op: "memory-get", conversationKey: key }), defaultTimeout);
        if (wire.kind !== "result") return null;
        return typeof wire.result === "string" && wire.result.length <= BROKER_LIMITS.memoryJsonChars ? wire.result : null;
      },
      async read(conversationKey) {
        const key = boundedString(conversationKey, BROKER_LIMITS.conversationKeyChars);
        if (!key) return { ok: false, reason: "invalid-request" };
        const { wire } = await request((id) => ({ fomo: 1, id, op: "memory-read", conversationKey: key }), defaultTimeout);
        // Busy, unavailable, a timeout, a refusal (rate limit, store error, an
        // orchestrator that does not know the op): not an answer.
        if (wire.kind !== "result") return { ok: false, reason: wire.kind === "refused" ? wire.error : wire.kind };
        // The answer is `{ value }`, never a bare null: no other reply can pass for one.
        const res = wire.result;
        if (!isRecord(res) || !Object.hasOwn(res, "value")) return { ok: false, reason: "bad-response" };
        return memoryReadOf({ ok: true, value: res.value });
      },
      async set(conversationKey, json) {
        const key = boundedString(conversationKey, BROKER_LIMITS.conversationKeyChars);
        if (!key || typeof json !== "string" || json.length === 0 || json.length > BROKER_LIMITS.memoryJsonChars) return;
        await request((id) => ({ fomo: 1, id, op: "memory-set", conversationKey: key, json }), defaultTimeout);
      },
      async clear(conversationKey) {
        const key = boundedString(conversationKey, BROKER_LIMITS.conversationKeyChars);
        if (!key) return;
        await request((id) => ({ fomo: 1, id, op: "memory-clear", conversationKey: key }), defaultTimeout);
      },
    },
    async report(r) {
      if (!isRecord(r)) return;
      const { wire } = await request((id) => ({ fomo: 1, id, op: "report", report: r }), defaultTimeout);
      if (wire.kind !== "result") log(`fomo broker: report not recorded (${wire.kind === "refused" ? wire.error : wire.kind})`);
    },
    configured() {
      refreshConfigured();
      return configuredKnown === true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const settle of [...pending.values()]) settle({ kind: "unavailable" });
      unsubscribeIfIdle();
    },
  };
  refreshConfigured();
  return broker;
}

// ── serving (orchestrator) ──────────────────────────────────────────────────

export interface ServeBrokerOptions {
  now?: () => number;
  newId?: () => string;
  log?: (line: string) => void;
  /** Tool calls running at once for this child (4). Memory/report ops have their own lane of the same width. */
  maxInFlight?: number;
  /** Tool calls started per rolling minute (30). Memory/report ops get serveStoreFactor times this. */
  perMinute?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  /** Ceiling on one tool call however long the child said it would wait (50 s). */
  maxCallMs?: number;
}

interface Lane {
  admit(now: number): boolean;
  release(): void;
}

/** A per-child concurrency and rolling-minute cap. Refused requests do not count against the minute. */
function lane(maxInFlight: number, perMinute: number): Lane {
  let inFlight = 0;
  const started: number[] = [];
  return {
    admit(now) {
      while (started.length > 0 && now - started[0]! >= 60_000) started.shift();
      if (inFlight >= maxInFlight || started.length >= perMinute) return false;
      inFlight++;
      started.push(now);
      return true;
    },
    release() {
      inFlight = Math.max(0, inFlight - 1);
    },
  };
}

/**
 * Answer one child's requests. `tenant` is the tenant the orchestrator spawned
 * this child for — the ONLY tenant any of its requests will ever run as.
 * Returns the unsubscribe; call it when the child exits.
 */
export function serveBrokerRequests(port: BrokerPort, tenant: string, service: FomoService, opts: ServeBrokerOptions = {}): () => void {
  const stamped = requireTenant(tenant);
  const clock = opts.now ?? Date.now;
  const newId = opts.newId ?? randomUUID;
  const log = opts.log ?? (() => {});
  const maxInFlight = Math.max(1, Math.trunc(opts.maxInFlight ?? BROKER_LIMITS.serveMaxInFlight));
  const perMinute = Math.max(1, Math.trunc(opts.perMinute ?? BROKER_LIMITS.servePerMinute));
  const maxRequestBytes = Math.max(256, Math.trunc(opts.maxRequestBytes ?? BROKER_LIMITS.maxRequestBytes));
  const maxResponseBytes = Math.max(256, Math.trunc(opts.maxResponseBytes ?? BROKER_LIMITS.maxResponseBytes));
  const maxCallMs = timeoutOf(opts.maxCallMs, BROKER_LIMITS.serveMaxCallMs);
  const calls = lane(maxInFlight, perMinute);
  const store = lane(maxInFlight, perMinute * BROKER_LIMITS.serveStoreFactor);
  const inFlightIds = new Set<string>();
  const said = new Set<string>();
  const tag = `fomo broker [${stamped.slice(0, 10)}]`;
  let closed = false;

  /** Log a kind of event once per child, so a looping child cannot flood the orchestrator's log. */
  const sayOnce = (key: string, line: string): void => {
    if (said.has(key) || said.size >= 64) return;
    said.add(key);
    log(`${tag}: ${line}`);
  };
  const reply = (r: BrokerResponse): void => {
    if (closed) return;
    try {
      port.send(r);
    } catch {
      // The child is gone; its requests die with it.
    }
  };
  const refuse = (id: string, error: string): void => reply({ fomo: 1, id, ok: false, error });

  async function serveCall(req: Extract<BrokerRequest, { op: "call" }>, now: number): Promise<void> {
    const { id, tool, args, opts: o } = req;
    if (!calls.admit(now)) {
      sayOnce("rate-limited", "tool calls rate-limited for this child");
      reply({ fomo: 1, id, ok: true, result: brokerFailureEnvelope(tool, "rate-limited", MESSAGES.rateLimited, now) });
      return;
    }
    inFlightIds.add(id);
    const requestId = newId();
    const run = runBounded(
      (signal) => {
        const ctx: BrokerCallContext = {
          tenant: stamped,
          surface: o.surface,
          audience: o.audience,
          conversationKey: o.conversationKey,
          requestId,
          now,
          priority: o.priority,
          groupId: o.groupId ?? null,
          signal,
          budgetMs: timeoutOf(o.timeoutMs, maxCallMs, maxCallMs),
        };
        return service.invoke(ctx, tool, args);
      },
      timeoutOf(o.timeoutMs, maxCallMs, maxCallMs),
    );
    // The slot is held until the service is actually done, not merely until
    // the child stopped waiting: a call that outlived its timeout is still load.
    void run.settled.then(() => {
      calls.release();
      inFlightIds.delete(id);
    });
    const out = await run.outcome;
    if (out.kind === "error") log(`${tag}: ${tool} failed in the service (${errorName(out.error)})`);
    const env = envelopeFromOutcome(out, tool, now, requestId);
    const fitted = fitEnvelope(env, id, maxResponseBytes, now);
    if (fitted !== env) sayOnce(`trimmed:${tool}`, `${tool} answer trimmed to fit ${maxResponseBytes} bytes`);
    if (fitted) reply({ fomo: 1, id, ok: true, result: fitted });
    else refuse(id, "response-too-large");
  }

  async function serveStore(req: Exclude<BrokerRequest, { op: "call" } | { op: "configured" }>, now: number): Promise<void> {
    const { id } = req;
    if (!store.admit(now)) {
      sayOnce("store-rate-limited", "memory/report operations rate-limited for this child");
      refuse(id, "rate-limited");
      return;
    }
    inFlightIds.add(id);
    try {
      switch (req.op) {
        case "memory-get": {
          const v = await service.memoryGet(stamped, req.conversationKey);
          const json = typeof v === "string" && v.length <= BROKER_LIMITS.memoryJsonChars ? v : null;
          reply({ fomo: 1, id, ok: true, result: json });
          return;
        }
        case "memory-read": {
          // STRICT: answered only when the store answered. A store error (or
          // a service without the strict read) is a refusal, never a null.
          const r = typeof service.memoryRead === "function" ? memoryReadOf(await service.memoryRead(stamped, req.conversationKey)) : null;
          if (!r || !r.ok) {
            sayOnce("memory-read-failed", `memory-read not answered (${r ? r.reason : "strict-read-unsupported"})`);
            refuse(id, "memory-read-failed");
            return;
          }
          reply({ fomo: 1, id, ok: true, result: { value: r.value } });
          return;
        }
        case "memory-set":
          await service.memorySet(stamped, req.conversationKey, req.json, now);
          reply({ fomo: 1, id, ok: true, result: null });
          return;
        case "memory-clear":
          await service.memoryClear(stamped, req.conversationKey);
          reply({ fomo: 1, id, ok: true, result: null });
          return;
        case "report": {
          const checked = validateBrokerReport(req.report, stamped);
          if (!checked.ok) {
            log(`${tag}: report refused (${checked.reason})`);
            refuse(id, checked.reason);
            return;
          }
          await service.report(stamped, checked.report, now);
          reply({ fomo: 1, id, ok: true, result: null });
          return;
        }
      }
    } catch (e) {
      log(`${tag}: ${req.op} failed (${errorName(e)})`);
      refuse(id, `${req.op}-failed`);
    } finally {
      store.release();
      inFlightIds.delete(id);
    }
  }

  async function handle(msg: unknown): Promise<void> {
    // Not ours: other users of the channel may share it.
    if (closed || !isRecord(msg) || msg.fomo !== 1) return;
    const id = idOf(msg.id);
    if (!id) {
      sayOnce("bad-id", "ignored a request without a usable id");
      return;
    }
    // A reused id would let one reply settle another request on the child.
    if (inFlightIds.has(id)) {
      sayOnce("duplicate-id", "ignored a request reusing an id still in flight");
      return;
    }
    const bytes = jsonBytes(msg);
    if (bytes === null || bytes > maxRequestBytes) {
      sayOnce("too-large", `refused a request over ${maxRequestBytes} bytes`);
      refuse(id, "request-too-large");
      return;
    }
    const parsed = parseBrokerRequest(msg);
    if (!parsed.ok) {
      sayOnce(`invalid:${parsed.reason}`, `refused a request (${parsed.reason})`);
      refuse(id, parsed.reason);
      return;
    }
    for (const field of parsed.extras) {
      const name = FIELD_SHAPE.test(field) ? field : "?";
      // Never read, never used: the tenant is the one this child was spawned for.
      sayOnce(`extra:${name}`, `ignored unexpected field "${name}" on a request`);
    }
    const req = parsed.request;
    const now = clock();
    switch (req.op) {
      case "configured": {
        let configured = false;
        try {
          configured = service.configured() === true;
        } catch {
          configured = false;
        }
        reply({ fomo: 1, id, ok: true, result: configured });
        return;
      }
      case "call":
        return serveCall(req, now);
      default:
        return serveStore(req, now);
    }
  }

  const unsubscribe = port.onMessage((msg) => {
    handle(msg).catch((e: unknown) => log(`${tag}: request handling failed (${errorName(e)})`));
  });
  return () => {
    if (closed) return;
    closed = true;
    unsubscribe();
  };
}
