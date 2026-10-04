/**
 * THE FOMO RESEARCH SERVICE — the one dispatcher every surface reaches.
 *
 * App chat, Telegram DMs and groups, MCP and the orchestrator's background
 * passes all call `invoke(ctx, tool, args)` (directly, or through a broker that
 * stamps the tenant). Nothing else in the subsystem talks to the provider for
 * a person's question, so every rule below holds for every surface at once.
 *
 * ── ORDER OF CHECKS, AND WHY THAT ORDER ──────────────────────────────────
 *
 *   1. A tenant from TRUSTED context. Never from a message, a model argument
 *      or a file the tenant controls; the validators refuse a `tenant` key.
 *   2. The tenant's data-access permission. Off means not-authorized with NO
 *      provider call and NO cache read: a switched-off owner learns nothing,
 *      not even what is cached.
 *   3. The audience. A group may read public data (its renderer strips
 *      identities); the owner's private state and the two mutations are
 *      owner-only.
 *   4. The arguments, against the tool's own validator (tools.ts).
 *   5. Freshness, budget and single-flight, per read (see `read`).
 *
 * ── WHAT A READ COSTS, AND WHO PAYS ──────────────────────────────────────
 *
 * Every upstream call is charged BEFORE it is made, against the caller's own
 * tenant, group and priority limits (budget.ts), from the provider's documented
 * price (provider.ts ROUTE_COST). The charge is settled with the provider's
 * `x-credits-cost` header and refunded only when the call certainly was not
 * billed: never sent, a 401 or 402, or this caller joined someone else's
 * in-flight fetch. The provider documents no unbilled 503, so none is assumed.
 *
 * Cache keys are PUBLIC (`fomo:v1:<route>:<canonical args>`, no tenant): every
 * read here is public provider data, so ten owners asking about one coin share
 * one copy. Tenant-private state (watches, assessments, jobs) is never cached.
 *
 * ── WHAT THIS MODULE IS NOT ALLOWED TO DO ────────────────────────────────
 *
 * Read-only research on the PROPOSE side. It places no order, builds no
 * calldata, reads no key (the client arrives built), widens no permission and
 * relaxes no limit. Provider money is display data and never accounting. The
 * only tenant state a lookup writes is the request audit log; the only tools
 * that write anything else are fomo_watch_coin and fomo_unwatch_coin, and a
 * deep research request registers one bounded job. Thesis, comment, handle and
 * token-name text is untrusted data: it is sanitised on the way in, bounded,
 * redacted of links and addresses in excerpts, and never interpreted.
 */

import { createHash } from "node:crypto";
import type { Db } from "../db";
import { sanitizeText } from "../research/news";
import type { FomoBudget, ChargeResult } from "./budget";
import { CAPABILITY_FOR_ROUTE, capabilityFromCall, mergeCapability } from "./capabilities";
import type { BrokerReport, FomoAccess, FomoService, FomoServiceHealth } from "./contract";
import {
  buildDossier,
  eventTime,
  FEED_FLOOR_NOTE,
  parseWindowMs,
  planThesisFetch,
  readThesisText,
  redactExecutables,
  resolveFamilies,
  THESIS_PAGE_SIZE,
  type DossierClaimDetail,
} from "./dossier";
import { dedupeEvents } from "./events";
import { changeSummary, earlyDiscovery, participationBreadth } from "./features";
import { SingleFlight, buildFreshness, decideRead, type CacheEntryState } from "./freshness";
import { chainFromUserText, executionAvailabilityOf, isRobinhoodToken, ROBINHOOD_NETWORK_ID, tokenFromKey, tokenIdentity } from "./identity";
import {
  ROUTE_COST,
  expectedCredits,
  type AlertsPage,
  type BalancesSnapshot,
  type FomoClient,
  type LeaderboardPage,
  type PositionsPage,
  type ProviderFailure,
  type ProviderResult,
  type RouteName,
  type SearchPage,
  type SwapsPage,
  type ThesesPage,
  type ThesisNetwork,
  type TokenBoardPage,
  type TokenSearchPage,
} from "./provider";
import * as store from "./store";
import type { FomoDialect, StoredTraderEvent } from "./store";
import {
  FOMO_TOOL_DEFS,
  isFomoToolName,
  isMutationTool,
  type ActivityEventView,
  type ClaimView,
  type CohortActor,
  type FillView,
  type HoldingView,
  type OpportunitiesData,
  type OpportunityRow,
  type PositionView,
  type RankingsData,
  type ResearchCoinData,
  type ResearchStatusData,
  type ResolveData,
  type ThesisView,
  type TokenActivityData,
  type TokenRef,
  type TokenThesesData,
  type ToolArgs,
  type ToolWindow,
  type TraderActivityData,
  type TraderContextData,
  type TraderRef,
  type WatchData,
} from "./tools";
import type {
  CapabilityRecord,
  CoinDossier,
  CohortMember,
  Coverage,
  EvidenceKind,
  EvidenceRef,
  ExecutionAvailability,
  FomoCallContext,
  FomoEnvelope,
  FomoSurface,
  FomoToolName,
  Freshness,
  FreshnessClass,
  FreshnessMode,
  RankingWindow,
  ResolvedSubject,
  ResultStatus,
  RetrievalPriority,
  SubjectCandidate,
  Thesis,
  TokenIdentity,
  TokenLabel,
  TokenStats,
  TraderEvent,
  TraderIdentity,
  TraderProfile,
} from "./types";
import type { UsageMeter } from "./budget";

// ── Public shapes ────────────────────────────────────────────────────────

export interface FomoServiceDeps {
  /** The ROOT db: store functions open their own transactions. */
  db: Db;
  dialect: FomoDialect;
  /** Null when no provider key is configured on this install. */
  client: FomoClient | null;
  /** The tenant's permissions, from TRUSTED settings. */
  access(tenant: string): Promise<FomoAccess>;
  budget: FomoBudget;
  /**
   * The budget background shared research (refreshDossier) is charged to.
   * Same counters' pool, but its pseudo-tenant caps are the pool itself, so
   * fleet research is bounded by the shared pool and its discovery share,
   * not by one owner's caps. Defaults to `budget`.
   */
  backgroundBudget?: FomoBudget;
  flight?: SingleFlight<unknown>;
  usage?: UsageMeter;
  now?: () => number;
  log?: (line: string) => void;
  /** Our agents' names, so a thesis that cites us is not counted as independent support. */
  selfNames?: readonly string[];
}

/**
 * The call context, plus the Telegram group id. The budget caps each group
 * separately and refuses a group charge that cannot name its group, so a
 * broker serving a group MUST pass it (from the trusted chat id, never from
 * message text).
 */
export interface FomoInvokeContext extends FomoCallContext {
  groupId?: string | null;
}

/** Who pays for a background or job read. */
export interface ChargeAs {
  tenant: string;
  surface: FomoSurface;
  priority: RetrievalPriority;
  groupId?: string | null;
}

export interface RefreshOutcome {
  dossier: CoinDossier | null;
  changed: boolean;
  status: ResultStatus;
  reason: string | null;
  /** True when the evidence behind the dossier was read successfully just now (a check that can support "no change"). */
  checked: boolean;
  usage: { providerCalls: number; cacheHits: number; creditsCharged: number | null };
  notes: string[];
}

export interface FomoServiceExt extends FomoService {
  /** Tenants that reported holding each token recently (position-protection routing for the orchestrator pass). */
  heldTokensSnapshot(now?: number): Map<string, string[]>;
  /** A dossier refresh charged to a named payer, optionally inside a credit allowance (research jobs). */
  refreshDossierAs(
    payer: ChargeAs,
    token: TokenIdentity,
    label: TokenLabel,
    opts: { depth: "quick" | "standard" | "deep"; now: number; signal?: AbortSignal; creditCap?: number | null; mode?: FreshnessMode },
  ): Promise<RefreshOutcome>;
  readonly usage: UsageMeter | null;
}

/** Background shared research is charged to this pseudo-tenant: it belongs to nobody. */
export const SHARED_RESEARCH_TENANT = "fomo-shared-research";
/** A deep read: bounded in time and credits, registered before anything promises it. */
export const DEEP_JOB_KIND = "research-coin-deep";
export const DEEP_JOB_DEADLINE_MS = 10 * 60_000;
export const DEEP_JOB_CREDIT_ALLOWANCE = 15_000;

// ── Constants ────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EXCERPT_MAX = 280;
const MAX_EVENTS_SHOWN = 50;
const MAX_HOLDINGS_SHOWN = 25;
const MAX_EVIDENCE = 60;
const CAPABILITY_THROTTLE_MS = 5 * MIN;
const COHORT_MEMO_MS = MIN;
/** The stream record counts as current when the shared ingestion advanced its checkpoint this recently. */
const STREAM_CURRENT_MS = 2 * MIN;
const HELD_TTL_MS = 6 * HOUR;
const FIRST_SEEN_LOOKBACK_MS = 7 * DAY;
/** Provider pages are fetched at a fixed size so every caller shares one cached copy. */
const BOARD_LIMIT = 100;
const FEED_LIMIT = 100;
const LOCAL_EVENT_LIMIT = 500;

/** Failures that mean the provider (or our entitlement) is not answering at all. */
const PROVIDER_DOWN: ReadonlySet<ProviderFailure> = new Set(["unauthorized", "credits-exhausted", "entitlement", "server-error", "unreachable", "no-key"]);

// ── Small helpers ────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function errText(e: unknown): string {
  return sanitizeText(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 160);
}

/** `fomo:v1:<route>:<canonical args>`: public, tenant-free, stable across callers. */
export function cacheKeyOf(route: RouteName, params: Record<string, string | number | boolean | null | undefined>): string {
  const parts = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(String(params[k]))}`);
  const key = `fomo:v1:${route}:${parts.join("&")}`;
  return key.length <= 280 ? key : `fomo:v1:${route}:h=${sha(parts.join("&")).slice(0, 40)}`;
}

/** A token read back from a cache or another process: kept only if its key is one identity.ts would write. */
function validToken(t: unknown): TokenIdentity | null {
  if (!isObj(t) || typeof t.key !== "string" || typeof t.address !== "string") return null;
  const parsed = tokenFromKey(t.key);
  if (!parsed || parsed.address !== t.address) return null;
  const c = isObj(t.chain) ? t.chain : {};
  const slug = typeof c.slug === "string" && /^[a-z][a-z0-9-]{0,23}$/.test(c.slug) ? c.slug : parsed.chain.slug;
  return { ...parsed, chain: { ...parsed.chain, slug } };
}

function windowMsOf(w: ToolWindow | null): number | null {
  if (w === null || w === "all") return null;
  const ms = parseWindowMs(w);
  return typeof ms === "number" ? ms : null;
}

function chainMatches(requested: ReturnType<typeof chainFromUserText>, t: TokenIdentity | null): boolean {
  if (!requested) return true;
  if (!t) return false;
  if (requested.networkId !== null) return t.chain.networkId === requested.networkId && t.chain.namespace === requested.namespace;
  return t.chain.slug === requested.slug && t.chain.namespace === requested.namespace;
}

function sameAddress(a: string, b: string): boolean {
  return a.startsWith("0x") || b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function thesisNetworkOf(t: TokenIdentity): ThesisNetwork | undefined {
  if (isRobinhoodToken(t)) return "robinhood";
  if (t.chain.namespace === "solana") return "sol";
  if (t.chain.slug === "arc" && t.chain.networkId === 5042) return "arc";
  if (t.chain.namespace === "eip155" && t.chain.slug === "base") return "base";
  if (t.chain.namespace === "eip155" && t.chain.slug === "eth") return "eth";
  if (t.chain.namespace === "eip155" && t.chain.slug === "bsc") return "bnb";
  return undefined;
}

/** The provider's chain filter spelling for a token, when we know one. */
function feedChainOf(t: TokenIdentity): string | undefined {
  if (isRobinhoodToken(t)) return "robinhood";
  if (t.chain.namespace === "solana" && t.chain.networkId !== null) return "solana";
  return undefined;
}

function availabilityOf(t: TokenIdentity | null): ExecutionAvailability {
  // The service cannot verify a route, so nothing here is ever "supported".
  return executionAvailabilityOf(t, { routeVerified: null, permitted: false });
}

function cleanLabel(l: TokenLabel | null | undefined): TokenLabel {
  return { symbol: l?.symbol ? sanitizeText(l.symbol, 24) || null : null, name: l?.name ? sanitizeText(l.name, 64) || null : null };
}

/** A display label for a resolved token, from the first row that carries one when resolution had none. */
function fillLabel(label: TokenLabel | null, rows: readonly { token: TokenIdentity | null; label: TokenLabel }[], key: string): TokenLabel {
  const have = cleanLabel(label);
  if (have.symbol) return have;
  const hit = rows.find((r) => r.token?.key === key && r.label.symbol);
  return hit ? cleanLabel(hit.label) : have;
}

function excerptOf(text: string): string {
  return sanitizeText(redactExecutables(sanitizeText(text, 2_000)), EXCERPT_MAX);
}

function handleOf(h: string | null | undefined): string | null {
  if (typeof h !== "string") return null;
  const s = sanitizeText(h, 64).replace(/^@/, "");
  return /^[A-Za-z0-9_.-]{1,40}$/.test(s) ? s : null;
}

function eventView(e: TraderEvent, source: ActivityEventView["source"], cohort: ReadonlySet<string> | null): ActivityEventView {
  return {
    evidenceId: `fomo:event/${e.eventKey}`,
    kind: e.kind,
    trader: { userId: e.trader.userId, handle: handleOf(e.trader.handle) },
    token: e.token,
    label: cleanLabel(e.tokenLabel),
    fillUsd: e.fillUsd,
    positionValueUsd: e.positionValueUsd,
    positionRealizedPnlUsdCumulative: e.positionRealizedPnlUsdCumulative,
    at: eventTime(e),
    verification: e.verification,
    source,
    inCohort: cohort ? cohort.has(e.trader.userId) : null,
  };
}

// ── Cache payload revivers ───────────────────────────────────────────────
//
// The cache is shared and written by more than one process; its payload
// comes back parsed but unvalidated. Each reviver checks the shape we wrote
// and re-validates every token identity, so a damaged or foreign row is
// dropped rather than half-trusted.

function reviveRows<T>(p: unknown, rowOk: (r: Rec) => boolean): T | null {
  if (!isObj(p) || !Array.isArray(p.rows) || !finite(p.dropped)) return null;
  const rows = p.rows.filter((r): r is Rec => isObj(r) && rowOk(r));
  return { ...p, rows } as T;
}

const tokenOkOrNull = (t: unknown): boolean => t === null || validToken(t) !== null;
const R = {
  tokensSearch: (p: unknown) => reviveRows<TokenSearchPage>(p, (r) => validToken(r.token) !== null),
  search: (p: unknown) =>
    reviveRows<SearchPage>(p, (r) => (r.kind === "trader" ? isObj(r.trader) && typeof r.trader.userId === "string" : r.kind === "token" && validToken(r.token) !== null)),
  balances: (p: unknown) => reviveRows<BalancesSnapshot>(p, (r) => tokenOkOrNull(r.token)),
  positions: (p: unknown) => reviveRows<PositionsPage>(p, (r) => tokenOkOrNull(r.token)),
  swaps: (p: unknown) => reviveRows<SwapsPage>(p, () => true),
  theses: (p: unknown) =>
    reviveRows<ThesesPage>(p, (r) => typeof r.id === "string" && typeof r.text === "string" && isObj(r.author) && typeof r.author.userId === "string" && tokenOkOrNull(r.token)),
  board: (p: unknown) => reviveRows<TokenBoardPage>(p, (r) => validToken(r.token) !== null),
  leaderboard: (p: unknown) => reviveRows<LeaderboardPage>(p, (r) => isObj(r.trader) && typeof r.trader.userId === "string"),
  alerts: (p: unknown): AlertsPage | null => {
    if (!isObj(p) || !Array.isArray(p.rows) || !finite(p.dropped)) return null;
    // The store's own field-by-field event normaliser is the strictest we have.
    const rows = p.rows.map((r) => store.traderEventOf(r)).filter((e): e is TraderEvent => e !== null);
    return { ...(p as unknown as AlertsPage), rows };
  },
  stats: (p: unknown): TokenStats | null => (isObj(p) && isObj(p.windows) && tokenOkOrNull(p.token) ? (p as unknown as TokenStats) : null),
  profile: (p: unknown): TraderProfile | null => (isObj(p) && isObj(p.trader) && typeof p.trader.userId === "string" && isObj(p.pnlUsd) ? (p as unknown as TraderProfile) : null),
};

/** A stored dossier, accepted only if it is recognisably one built for this token. */
function asDossier(v: unknown, token: TokenIdentity): CoinDossier | null {
  if (!isObj(v)) return null;
  if (typeof v.dossierId !== "string" || !Number.isSafeInteger(v.revision) || (v.revision as number) < 1) return null;
  if (!isObj(v.token) || v.token.key !== token.key) return null;
  if (!Array.isArray(v.claims) || !isObj(v.coverage) || !Array.isArray(v.evidence) || !Array.isArray(v.unknowns)) return null;
  return v as unknown as CoinDossier;
}

// ── Reads ────────────────────────────────────────────────────────────────

type SectionStatus = "ok" | "stale" | "failed" | "unavailable" | "budget-limited" | "not-found";

interface Section<T> {
  name: string;
  route: RouteName | null;
  data: T | null;
  status: SectionStatus;
  reason: string | null;
  servedFrom: Freshness["servedFrom"];
  retrievedAt: number | null;
  providerAsOf: number | null;
  lastAttemptAt: number | null;
  lastOutcome: Freshness["lastRefreshOutcome"];
  providerCalls: number;
  cacheHits: number;
  /** Credits this caller was billed for this section; null when the provider did not say. */
  credits: number | null;
  creditsRemaining: number | null;
  pages: number;
  /** A resolution read: metered, but not part of the answer's data age or page count. */
  identity?: boolean;
}

interface ReadSpec<T> {
  name: string;
  route: RouteName;
  params: Record<string, string | number | boolean | null | undefined>;
  pages?: number;
  cls: FreshnessClass;
  call(c: FomoClient): Promise<ProviderResult<T>>;
  revive(payload: unknown): T | null;
  notFoundIsSubject?: boolean;
}

/** Who pays, at what priority, with what clock; plus an optional allowance (a research job's). */
interface ChargeContext {
  tenant: string;
  surface: FomoSurface;
  priority: RetrievalPriority;
  groupId: string | null;
  now: number;
  signal?: AbortSignal;
  cap: { limit: number; spent: number } | null;
  /** Which budget pays; the tenant budget unless this is background shared research. */
  budget?: FomoBudget;
}

function localSection<T>(name: string, data: T, retrievedAt: number | null, servedFrom: Freshness["servedFrom"] = "cache"): Section<T> {
  return {
    name,
    route: null,
    data,
    status: "ok",
    reason: null,
    servedFrom,
    retrievedAt,
    providerAsOf: null,
    lastAttemptAt: null,
    lastOutcome: null,
    providerCalls: 0,
    cacheHits: 0,
    credits: 0,
    creditsRemaining: null,
    pages: 0,
  };
}

function failureStatus(f: ProviderFailure | "not-configured" | "aborted" | "internal-error"): SectionStatus {
  if (f === "not-found") return "not-found";
  if (f === "not-configured" || PROVIDER_DOWN.has(f as ProviderFailure)) return "unavailable";
  return "failed";
}

// ── The answer under construction ────────────────────────────────────────

class Answer {
  readonly sections: Section<unknown>[] = [];
  private readonly refs = new Map<string, EvidenceRef>();
  readonly notes: string[] = [];
  readonly missing: string[] = [];
  requested: Coverage["requested"] = {};
  achieved: Coverage["achieved"] = {};
  pagesRequested = 0;
  pagesReturned = 0;
  duplicatesRemoved = 0;
  providerTotal: number | null = null;
  capped = false;
  partial = false;
  readonly sourceTimes: (number | null)[] = [];

  add<T>(s: Section<T>): Section<T> {
    this.sections.push(s as Section<unknown>);
    if (s.route) {
      this.pagesRequested += s.pages;
      if (s.data !== null) this.pagesReturned += s.pages;
      else if (!this.missing.includes(s.name)) this.missing.push(s.name);
    }
    return s;
  }

  ref(kind: EvidenceKind, id: string, at?: number | null): string {
    const full = `fomo:${kind}/${id}${finite(at) ? `@${Math.trunc(at)}` : ""}`;
    if (!this.refs.has(full) && this.refs.size < MAX_EVIDENCE) this.refs.set(full, { id: full, kind, sourceUrl: null });
    return full;
  }

  addRef(r: EvidenceRef): void {
    if (!this.refs.has(r.id) && this.refs.size < MAX_EVIDENCE) this.refs.set(r.id, { id: r.id, kind: r.kind, sourceUrl: null });
  }

  evidence(): EvidenceRef[] {
    return [...this.refs.values()];
  }

  note(s: string): void {
    const t = sanitizeText(s, 240);
    if (t && !this.notes.includes(t) && this.notes.length < 12) this.notes.push(t);
  }
}

interface FinishOpts<T> {
  cls: FreshnessClass;
  mode: FreshnessMode;
  subject: ResolvedSubject | null;
  data: T | null;
  /** Matching rows; 0 makes an otherwise complete answer "empty". */
  rows: number;
  /** Sections that must have data for the answer to exist. */
  essential: Section<unknown>[];
  status?: ResultStatus;
  reason?: string | null;
  message?: string | null;
  candidates?: SubjectCandidate[];
  dossierRevision?: { dossierId: string; revision: number } | null;
}

const OUTCOME_RANK: Record<NonNullable<Freshness["lastRefreshOutcome"]>, number> = { "skipped-fresh": 0, ok: 1, "skipped-budget": 2, failed: 3 };

function defaultMessage(status: ResultStatus, reason: string | null): string | null {
  switch (status) {
    case "not-authorized":
      return reason === "owner-only"
        ? "That is the owner's private research and is only answered in a direct conversation."
        : "Fomo data access is switched off for this account.";
    case "unavailable":
      return reason === "not-configured" ? "Fomo data is not configured on this install." : "The Fomo data provider is not available right now.";
    case "failed":
      return reason === "invalid-args" ? "That request could not be read as a Fomo lookup." : "The Fomo lookup failed; nothing is shown rather than a guess.";
    case "budget-limited":
      return "Fomo research is rationed right now: the retrieval budget refused this read.";
    case "stale":
      return "Only an older copy is available; it is shown with its age.";
    case "partial":
      return "Part of this answer could not be read; the rest is real.";
    case "empty":
      return "No matching records were returned for that scope.";
    case "capped":
      return "More records exist than were read.";
    case "not-found":
      return "Fomo does not know that subject.";
    default:
      return null;
  }
}

// ── The service ──────────────────────────────────────────────────────────

export function createFomoService(deps: FomoServiceDeps): FomoServiceExt {
  const db = deps.db;
  const client = deps.client;
  const budget = deps.budget;
  const clock = deps.now ?? Date.now;
  const flight = deps.flight ?? new SingleFlight<unknown>({ now: clock });
  const usage = deps.usage ?? null;
  const log = deps.log ?? (() => {});
  const selfNames = deps.selfNames ?? [];

  let lastProviderOkAt: number | null = null;
  let lastProviderFailure: { at: number; reason: string; down: boolean } | null = null;
  let lastBudgetRefusalAt: number | null = null;
  let capabilityPrior: Map<string, CapabilityRecord> | null = null;
  const capabilityWrittenAt = new Map<string, { at: number; status: string }>();
  const held = new Map<string, { keys: string[]; at: number }>();
  let cohortMemo: { at: number; value: CohortSnap } | null = null;

  interface CohortSnap {
    ids: Set<string>;
    byId: Map<string, CohortMember>;
    version: number | null;
    size: number | null;
    target: number;
    shortfallReason: string | null;
  }

  async function cohortSnapshot(now: number): Promise<CohortSnap> {
    if (cohortMemo && now - cohortMemo.at >= 0 && now - cohortMemo.at < COHORT_MEMO_MS) return cohortMemo.value;
    let value: CohortSnap = { ids: new Set(), byId: new Map(), version: null, size: null, target: 150, shortfallReason: null };
    try {
      const c = await store.latestCohort(db);
      if (c) {
        const byId = new Map(c.cohort.members.map((m) => [m.trader.userId, m]));
        value = {
          ids: new Set(byId.keys()),
          byId,
          version: c.cohort.version,
          size: c.cohort.members.length,
          target: c.cohort.target,
          shortfallReason: c.cohort.shortfallReason,
        };
      }
    } catch (e) {
      log(`fomo: cohort read failed: ${errText(e)}`);
    }
    cohortMemo = { at: now, value };
    return value;
  }

  async function streamCurrent(now: number): Promise<boolean> {
    try {
      const cp = await store.getCheckpoint(db, "alerts");
      return !!cp && now - cp.updatedAtMs >= 0 && now - cp.updatedAtMs <= STREAM_CURRENT_MS;
    } catch {
      return false;
    }
  }

  async function recordCapability(route: RouteName, r: ProviderResult<unknown>, notFoundIsSubject: boolean): Promise<void> {
    if (r.meta.attempts === 0) return;
    const name = CAPABILITY_FOR_ROUTE[route];
    const next = capabilityFromCall(name, ROUTE_COST[route].template, r, { notFoundIsSubject });
    const last = capabilityWrittenAt.get(name);
    // At most once per capability per few minutes, unless the verdict changed.
    if (last && next.verifiedAt - last.at < CAPABILITY_THROTTLE_MS && last.status === next.status) return;
    try {
      if (!capabilityPrior) capabilityPrior = new Map((await store.listCapabilities(db)).map((c) => [c.capability, c]));
      const merged = mergeCapability(capabilityPrior.get(name), next);
      capabilityPrior.set(name, merged);
      await store.upsertCapability(db, merged);
      capabilityWrittenAt.set(name, { at: next.verifiedAt, status: next.status });
    } catch (e) {
      log(`fomo: capability write failed: ${errText(e)}`);
    }
  }

  /** Settle, meter and cache one upstream answer. Runs only for the caller whose call reached upstream. */
  async function afterCall(spec: ReadSpec<unknown>, key: string, r: ProviderResult<unknown>, grant: Extract<ChargeResult, { ok: true }>, cc: ChargeContext, estimate: number): Promise<void> {
    const m = r.meta;
    const certainlyUnbilled = m.attempts === 0 || (!r.ok && (r.failure === "unauthorized" || r.failure === "credits-exhausted"));
    try {
      if (certainlyUnbilled) await grant.refund();
      else await grant.settle(m.creditsCost);
    } catch (e) {
      log(`fomo: budget settle failed: ${errText(e)}`);
    }
    if (cc.cap && !certainlyUnbilled) cc.cap.spent += m.creditsCost ?? estimate;
    const at = m.retrievedAt;
    if (m.attempts > 0) {
      const bucket = CAPABILITY_FOR_ROUTE[spec.route];
      usage?.recordCall({ now: at, bucket, credits: m.creditsCost });
      usage?.recordRemaining({ now: at, remaining: m.creditsRemaining });
      try {
        await store.recordUsage(db, store.usageDay(at), bucket, 1, m.creditsCost);
      } catch (e) {
        log(`fomo: usage write failed: ${errText(e)}`);
      }
      if (r.ok || r.failure === "not-found") lastProviderOkAt = Math.max(lastProviderOkAt ?? 0, at);
      else lastProviderFailure = { at, reason: r.failure, down: PROVIDER_DOWN.has(r.failure) };
      await recordCapability(spec.route, r, spec.notFoundIsSubject === true);
    }
    try {
      if (r.ok) {
        await store.cachePut(db, {
          cacheKey: key,
          dataClass: spec.cls,
          payload: r.data,
          retrievedAtMs: at,
          providerAsOfMs: m.providerAsOf,
          // Metadata only; never a provider body.
          meta: { route: m.route, credits: m.creditsCost, source: m.providerSource, stale: m.providerStale },
        });
      } else if (m.attempts > 0) {
        await store.cacheMarkAttempt(db, key, spec.cls, "failed", at);
      }
    } catch (e) {
      log(`fomo: cache write failed: ${errText(e)}`);
    }
  }

  /**
   * ONE READ, following freshness.ts's recommended flow:
   *   decideRead → (serve cache | budget.tryCharge → SingleFlight → settle/refund
   *   → cachePut/cacheMarkAttempt) → a Section saying honestly what was served.
   */
  async function read<T>(cc: ChargeContext, spec: ReadSpec<T>, mode: FreshnessMode): Promise<Section<T>> {
    const key = cacheKeyOf(spec.route, spec.params);
    const now = cc.now;
    const pages = Math.max(1, spec.pages ?? 1);
    let entry: store.CacheEntry | null = null;
    try {
      entry = await store.cacheGet(db, key);
    } catch (e) {
      log(`fomo: cache read failed: ${errText(e)}`);
    }
    const heldData = entry && entry.retrievedAtMs !== null ? spec.revive(entry.payload) : null;
    const state: CacheEntryState | null = entry
      ? {
          retrievedAt: heldData !== null ? entry.retrievedAtMs : null,
          providerAsOf: heldData !== null ? entry.providerAsOfMs : null,
          lastAttemptAt: entry.lastAttemptAtMs,
          lastAttemptOutcome: entry.lastAttemptOutcome,
        }
      : null;
    const base = (over: Partial<Section<T>>): Section<T> => ({
      name: spec.name,
      route: spec.route,
      data: null,
      status: "ok",
      reason: null,
      servedFrom: "none",
      retrievedAt: null,
      providerAsOf: null,
      lastAttemptAt: state?.lastAttemptAt ?? null,
      lastOutcome: state?.lastAttemptOutcome ?? null,
      providerCalls: 0,
      cacheHits: 0,
      credits: 0,
      creditsRemaining: null,
      pages,
      ...over,
    });
    const heldCopy = (status: SectionStatus, reason: string | null, outcome: Freshness["lastRefreshOutcome"]): Section<T> =>
      base({
        data: heldData,
        status,
        reason,
        servedFrom: "stale-cache",
        retrievedAt: state?.retrievedAt ?? null,
        providerAsOf: state?.providerAsOf ?? null,
        lastOutcome: outcome,
        cacheHits: 1,
      });

    const first = decideRead({ entry: state, cls: spec.cls, mode, now, budgetAvailable: true });
    if (first.action === "serve-cache" && heldData !== null) {
      usage?.recordCacheHit({ now, bucket: CAPABILITY_FOR_ROUTE[spec.route] });
      return base({
        data: heldData,
        servedFrom: "cache",
        retrievedAt: state?.retrievedAt ?? null,
        providerAsOf: state?.providerAsOf ?? null,
        lastOutcome: "skipped-fresh",
        cacheHits: 1,
      });
    }
    if (first.action === "serve-stale" && heldData !== null) return heldCopy("stale", "recent-failure", first.lastRefreshOutcome);
    if (first.action !== "fetch") return base({ status: "failed", reason: first.reason === "invalid-clock" ? "invalid-clock" : "recent-failure" });

    // Upstream is wanted.
    if (!client) {
      return first.onFailure === "serve-stale" && heldData !== null
        ? heldCopy("stale", "not-configured", state?.lastAttemptOutcome ?? null)
        : base({ status: "unavailable", reason: "not-configured" });
    }
    const estimate = expectedCredits(spec.route, pages);
    const refused = async (reason: string): Promise<Section<T>> => {
      lastBudgetRefusalAt = now;
      usage?.recordRefusal({ now, bucket: CAPABILITY_FOR_ROUTE[spec.route] });
      const second = decideRead({ entry: state, cls: spec.cls, mode, now, budgetAvailable: false });
      return second.action === "serve-stale" && heldData !== null
        ? heldCopy("stale", reason, "skipped-budget")
        : base({ status: "budget-limited", reason, lastOutcome: "skipped-budget" });
    };
    if (cc.cap && cc.cap.spent + estimate > cc.cap.limit) return refused("job-allowance");
    let grant: ChargeResult;
    try {
      grant = await (cc.budget ?? budget).tryCharge({ priority: cc.priority, tenant: cc.tenant, surface: cc.surface, groupId: cc.groupId, credits: estimate, now });
    } catch (e) {
      // A budget that cannot answer is a refusal: no upstream call.
      log(`fomo: budget check failed: ${errText(e)}`);
      return refused("budget-error");
    }
    if (!grant.ok) return refused(`budget-${grant.reason}`);
    const g = grant;

    let ran = false;
    let result: ProviderResult<T> | null = null;
    let thrown: string | null = null;
    try {
      result = (await flight.run(
        key,
        async () => {
          ran = true;
          let r: ProviderResult<unknown>;
          try {
            r = await spec.call(client);
          } catch (e) {
            // The client promises never to throw; if it does, treat it as an unbilled-unknown failure.
            r = {
              ok: false,
              failure: "unreadable",
              detail: errText(e),
              meta: { route: ROUTE_COST[spec.route].template, status: null, attempts: 1, retrievedAt: clock(), creditsCost: null, creditsRemaining: null, unmetered: null, providerAsOf: null, providerSource: null, providerStale: null, providerAgeSeconds: null },
            };
          }
          await afterCall(spec as ReadSpec<unknown>, key, r, g, cc, estimate);
          return r;
        },
        { force: mode === "force-refresh", requestedAt: now, signal: cc.signal },
      )) as ProviderResult<T>;
    } catch (e) {
      thrown = cc.signal?.aborted ? "aborted" : "internal-error";
      log(`fomo: read ${spec.route} did not complete: ${errText(e)}`);
    } finally {
      // A caller that joined someone else's fetch (or never reached upstream) did not pay for one.
      if (!ran) await g.refund().catch(() => {});
    }

    if (!result) {
      return first.onFailure === "serve-stale" && heldData !== null ? heldCopy("stale", thrown, "failed") : base({ status: "failed", reason: thrown, lastOutcome: "failed" });
    }
    const m = result.meta;
    const mine = ran && m.attempts > 0;
    const callUsage = { providerCalls: mine ? 1 : 0, cacheHits: ran ? 0 : 1, credits: mine ? m.creditsCost : 0, creditsRemaining: m.creditsRemaining };
    if (result.ok) {
      const revived = spec.revive(JSON.parse(JSON.stringify(result.data)) as unknown) ?? result.data;
      return base({
        data: revived,
        servedFrom: "live",
        retrievedAt: m.retrievedAt,
        providerAsOf: m.providerAsOf,
        lastAttemptAt: m.retrievedAt,
        lastOutcome: "ok",
        ...callUsage,
      });
    }
    const status = failureStatus(result.failure);
    if (status !== "not-found" && first.onFailure === "serve-stale" && heldData !== null) {
      return { ...heldCopy("stale", result.failure, "failed"), lastAttemptAt: m.retrievedAt, ...callUsage, cacheHits: 1 };
    }
    return base({ status, reason: result.failure, lastAttemptAt: m.attempts > 0 ? m.retrievedAt : state?.lastAttemptAt ?? null, lastOutcome: m.attempts > 0 ? "failed" : state?.lastAttemptOutcome ?? null, ...callUsage });
  }

  // ── Read specs ──────────────────────────────────────────────────────

  const specs = {
    tokensSearch: (q: string): ReadSpec<TokenSearchPage> => ({
      name: "token-search",
      route: "tokensSearch",
      params: { q, limit: 25 },
      cls: "profile",
      call: (c) => c.tokensSearch(q, 25),
      revive: R.tokensSearch,
    }),
    traderSearch: (q: string): ReadSpec<SearchPage> => ({
      name: "trader-search",
      route: "search",
      params: { q: q.toLowerCase(), type: "traders", limit: 10 },
      cls: "profile",
      call: (c) => c.search(q, "traders", 10),
      revive: R.search,
    }),
    balances: (userId: string): ReadSpec<BalancesSnapshot> => ({
      name: "holdings",
      route: "balances",
      params: { userId },
      cls: "holdings",
      call: (c) => c.balances(userId),
      revive: R.balances,
    }),
    profile: (userId: string): ReadSpec<TraderProfile> => ({
      name: "profile",
      route: "traderById",
      params: { userId },
      cls: "profile",
      call: (c) => c.traderById(userId),
      revive: R.profile,
      notFoundIsSubject: true,
    }),
    positions: (userId: string): ReadSpec<PositionsPage> => ({
      name: "positions",
      route: "positions",
      params: { userId, status: "all", limit: 100 },
      cls: "holdings",
      call: (c) => c.positions(userId, { status: "all", limit: 100 }),
      revive: R.positions,
    }),
    swaps: (userId: string, tokenAddress: string): ReadSpec<SwapsPage> => ({
      name: "fills",
      route: "swaps",
      params: { userId, tokenAddress, limit: 100 },
      cls: "activity",
      call: (c) => c.swaps(userId, { tokenAddress, limit: 100 }),
      revive: R.swaps,
    }),
    feed: (q: { userId?: string; token?: string; chain?: string }): ReadSpec<AlertsPage> => ({
      name: "feed",
      route: "alerts",
      params: { userId: q.userId, token: q.token, chain: q.chain, limit: FEED_LIMIT },
      cls: "activity",
      call: (c) => c.alerts({ ...q, limit: FEED_LIMIT }, "rest-lookup"),
      revive: R.alerts,
    }),
    thesesByToken: (t: TokenIdentity, pages: number): ReadSpec<ThesesPage> => {
      const network = thesisNetworkOf(t);
      return {
        name: "theses",
        route: "thesesByToken",
        params: { address: t.address, network, pages },
        pages,
        cls: "theses",
        call: (c) => c.thesesByToken(t.address, { network, ...(pages > 1 ? { pages } : {}) }),
        revive: R.theses,
      };
    },
    thesesByUser: (userId: string, limit: number): ReadSpec<ThesesPage> => ({
      name: "theses",
      route: "thesesByUser",
      params: { userId, limit },
      cls: "theses",
      call: (c) => c.thesesByUser(userId, { limit }),
      revive: R.theses,
    }),
    thesesByUserToken: (userId: string, t: TokenIdentity, limit: number): ReadSpec<ThesesPage> => ({
      name: "theses",
      route: "thesesByUserToken",
      params: { userId, address: t.address, limit },
      cls: "theses",
      call: (c) => c.thesesByUserToken(userId, t.address, { limit }),
      revive: R.theses,
    }),
    tokenStats: (t: TokenIdentity): ReadSpec<TokenStats> => {
      const networkId = isRobinhoodToken(t) ? ROBINHOOD_NETWORK_ID : undefined;
      return {
        name: "token-stats",
        route: "tokenStats",
        params: { address: t.address, networkId },
        cls: "token-stats",
        call: (c) => c.tokenStats(t.address, networkId !== undefined ? { networkId } : {}),
        revive: R.stats,
      };
    },
    leaderboard: (window: RankingWindow): ReadSpec<LeaderboardPage> => ({
      name: "leaderboard",
      route: "leaderboard",
      params: { window, limit: BOARD_LIMIT },
      cls: "rankings",
      call: (c) => c.leaderboard(window, BOARD_LIMIT),
      revive: R.leaderboard,
    }),
    tokenBoard: (board: "trending" | "graduated" | "most-held"): ReadSpec<TokenBoardPage> => ({
      name: `board-${board}`,
      route: board === "trending" ? "tokenBoardTrending" : board === "graduated" ? "tokenBoardGraduated" : "tokenBoardMostHeld",
      params: { limit: BOARD_LIMIT },
      cls: "boards",
      call: (c) => c.tokenBoard(board, BOARD_LIMIT),
      revive: R.board,
    }),
  };

  // ── Resolution ──────────────────────────────────────────────────────

  type Fail = { ok: false; status: ResultStatus; reason: string; message: string | null; candidates: SubjectCandidate[] };
  type TokenResolution = { ok: true; token: TokenIdentity; label: TokenLabel; match: string; marketCapUsd: number | null } | Fail;
  type TraderResolution = { ok: true; trader: TraderIdentity; match: string; formerHandle: boolean; hit: Extract<SearchPage["rows"][number], { kind: "trader" }> | null } | Fail;

  function sectionFail(s: Section<unknown>): Fail {
    const status: ResultStatus = s.status === "ok" || s.status === "stale" ? "failed" : s.status;
    return { ok: false, status, reason: s.reason ?? status, message: null, candidates: [] };
  }

  async function knownLabel(t: TokenIdentity): Promise<TokenLabel> {
    try {
      const d = await store.latestDossier(db, t.key);
      const dossier = d ? asDossier(d.dossier, t) : null;
      if (dossier) return cleanLabel(dossier.label);
    } catch {
      // A label is display only; none is fine.
    }
    return { symbol: null, name: null };
  }

  async function resolveToken(cc: ChargeContext, a: Answer, ref: TokenRef, chainSlug: string | null, mode: FreshnessMode): Promise<TokenResolution> {
    const chain = chainSlug ? chainFromUserText(chainSlug) : null;
    if (ref.kind === "address" && chain) {
      const t = tokenIdentity(chain, ref.value);
      if (!t) {
        return { ok: false, status: "needs-clarification", reason: "address-chain-mismatch", message: `That address can't be on ${chain.slug ?? "that chain"}. Which chain is it on?`, candidates: [] };
      }
      return { ok: true, token: t, label: await knownLabel(t), match: "exact-address-on-chain", marketCapUsd: null };
    }
    // An address with no chain, or a ticker: ask the provider where it lives.
    // Search answers are identity data and cached for an hour, shared by every caller.
    // Resolution is identity, not the answer's retrieval: it is metered but not counted as a page of the answer.
    const s = a.add({ ...(await read(cc, specs.tokensSearch(ref.value), mode === "force-refresh" ? "prefer-fresh" : mode)), pages: 0, identity: true });
    if (!s.data) return sectionFail(s);
    const rows = s.data.rows;
    const matches =
      ref.kind === "address"
        ? rows.filter((r) => sameAddress(r.token.address, ref.value))
        : rows.filter((r) => (r.label.symbol ?? "").replace(/^\$/, "").toUpperCase() === ref.value);
    const unique = [...new Map(matches.map((m) => [m.token.key, m])).values()];
    const onChain = chain ? unique.filter((m) => chainMatches(chain, m.token)) : unique;
    if (onChain.length === 1) {
      const m = onChain[0]!;
      return { ok: true, token: m.token, label: cleanLabel(m.label), match: ref.kind === "address" ? "exact-address" : "exact-symbol", marketCapUsd: m.marketCapUsd };
    }
    if (onChain.length > 1) {
      // NEVER silently choose: the same ticker (or the same hex) on two chains is two coins.
      const candidates: SubjectCandidate[] = onChain.slice(0, 6).map((m) => ({
        subject: { kind: "token", token: m.token, label: cleanLabel(m.label) },
        match: ref.kind === "address" ? `same address on ${m.token.chain.slug ?? "an unnamed chain"}` : `symbol ${ref.value} on ${m.token.chain.slug ?? "an unnamed chain"}`,
      }));
      const chains = [...new Set(onChain.map((m) => m.token.chain.slug ?? "an unnamed chain"))];
      return {
        ok: false,
        status: "needs-clarification",
        reason: ref.kind === "address" ? "address-on-several-chains" : "symbol-on-several-chains",
        message: `${ref.kind === "symbol" ? ref.value : "That address"} exists on ${chains.join(", ")}${chains.length < onChain.length ? " (more than one coin)" : ""}. Which one do you mean?`,
        candidates,
      };
    }
    if (ref.kind === "address") {
      return { ok: false, status: "not-found", reason: "address-not-placed", message: "I could not place that address on any chain Fomo reports. Which chain is it on?", candidates: [] };
    }
    if (chain && unique.length > 0) {
      return { ok: false, status: "not-found", reason: "symbol-not-on-chain", message: `No coin with the ticker ${ref.value} was found on ${chain.slug}.`, candidates: [] };
    }
    return { ok: false, status: "not-found", reason: "symbol-not-found", message: `No coin with the ticker ${ref.value} was found on Fomo.`, candidates: [] };
  }

  async function resolveTrader(cc: ChargeContext, a: Answer, ref: TraderRef, mode: FreshnessMode): Promise<TraderResolution> {
    if (ref.kind === "user-id") {
      // The id is the identity. Our own record is free; a 2,500-credit profile read is not spent to learn a handle.
      const local = await store.traderById(db, ref.value).catch(() => null);
      if (local) return { ok: true, trader: { userId: local.userId, handle: local.handle, displayName: local.displayName, verified: local.verified }, match: "user-id", formerHandle: false, hit: null };
      return { ok: true, trader: { userId: ref.value, handle: null, displayName: null, verified: null }, match: "user-id-unseen", formerHandle: false, hit: null };
    }
    const local = await store.traderByHandle(db, ref.value).catch(() => null);
    if (local) {
      return {
        ok: true,
        trader: { userId: local.userId, handle: local.handle, displayName: local.displayName, verified: local.verified },
        match: local.handleIsCurrent ? "local-handle" : "former-handle",
        formerHandle: !local.handleIsCurrent,
        hit: null,
      };
    }
    // Search (250 credits) rather than the profile route (2,500): only the user id is needed.
    const s = a.add({ ...(await read(cc, specs.traderSearch(ref.value), mode === "force-refresh" ? "prefer-fresh" : mode)), pages: 0, identity: true });
    if (!s.data) return sectionFail(s);
    const want = ref.value.toLowerCase();
    const hits = s.data.rows.filter((r): r is Extract<typeof r, { kind: "trader" }> => r.kind === "trader" && (r.trader.handle ?? "").toLowerCase() === want);
    const unique = [...new Map(hits.map((h) => [h.trader.userId, h])).values()];
    if (unique.length === 0) return { ok: false, status: "not-found", reason: "handle-not-found", message: "No Fomo trader with that handle was found.", candidates: [] };
    if (unique.length > 1) {
      return {
        ok: false,
        status: "needs-clarification",
        reason: "handle-ambiguous",
        message: "More than one Fomo account answers to that handle. Which one do you mean?",
        candidates: unique.slice(0, 5).map((h) => ({ subject: { kind: "trader", trader: h.trader }, match: "exact handle" })),
      };
    }
    const hit = unique[0]!;
    try {
      await store.upsertTrader(db, hit.trader, cc.now);
    } catch (e) {
      log(`fomo: trader identity write failed: ${errText(e)}`);
    }
    return { ok: true, trader: hit.trader, match: "search-handle", formerHandle: false, hit };
  }

  // ── Envelope assembly ───────────────────────────────────────────────

  function finish<T>(ic: Inv, a: Answer, o: FinishOpts<T>): FomoEnvelope<T> {
    let status: ResultStatus;
    let reason: string | null = o.reason ?? null;
    let data: T | null = o.data;
    if (o.status) {
      status = o.status;
    } else {
      const withData = o.essential.filter((s) => s.data !== null);
      if (o.essential.length > 0 && withData.length === 0) {
        const st = o.essential.map((s) => s.status);
        status = st.includes("budget-limited") ? "budget-limited" : st.every((x) => x === "unavailable") ? "unavailable" : st.includes("not-found") ? "not-found" : "failed";
        reason = reason ?? o.essential[0]?.reason ?? null;
        // Nothing essential was read: an empty-looking payload here would read as "no records", which is a different fact.
        data = null;
      } else if (a.sections.some((s) => s.data === null) || a.missing.length > 0 || a.partial) {
        status = "partial";
        reason = reason ?? a.sections.find((s) => s.data === null)?.reason ?? null;
      } else if (a.sections.some((s) => s.status === "stale")) {
        status = "stale";
        reason = reason ?? a.sections.find((s) => s.status === "stale")?.reason ?? null;
      } else if (a.capped) status = "capped";
      else if (o.rows === 0) status = "empty";
      else status = "ok";
    }
    // The answer's age is the age of its data, not of the identity lookup that found the subject.
    const pool = a.sections.some((s) => !s.identity) ? a.sections.filter((s) => !s.identity) : a.sections;
    const served = pool.filter((s) => s.data !== null && s.servedFrom !== "none");
    const servedFrom: Freshness["servedFrom"] = served.length === 0
      ? "none"
      : served.some((s) => s.servedFrom === "stale-cache")
        ? "stale-cache"
        : served.some((s) => s.servedFrom === "cache")
          ? "cache"
          : "live";
    const minOf = (xs: (number | null)[]): number | null => {
      const f = xs.filter(finite);
      return f.length ? Math.min(...f) : null;
    };
    const attempts = pool.map((s) => s.lastAttemptAt).filter(finite);
    let outcome: Freshness["lastRefreshOutcome"] = null;
    for (const s of pool) if (s.lastOutcome && (outcome === null || OUTCOME_RANK[s.lastOutcome] > OUTCOME_RANK[outcome])) outcome = s.lastOutcome;
    const freshness = buildFreshness({
      cls: o.cls,
      mode: o.mode,
      now: ic.now,
      servedFrom,
      retrievedAt: minOf(served.map((s) => s.retrievedAt)),
      providerAsOf: minOf(served.map((s) => s.providerAsOf)),
      sourceEventTimes: a.sourceTimes,
      lastRefreshAttemptAt: attempts.length ? Math.max(...attempts) : null,
      lastRefreshOutcome: outcome,
    });
    const calls = a.sections.reduce((n, s) => n + s.providerCalls, 0);
    const unknownCredits = a.sections.some((s) => s.providerCalls > 0 && s.credits === null);
    const remaining = [...a.sections].reverse().find((s) => s.creditsRemaining !== null)?.creditsRemaining ?? null;
    const coverage: Coverage = {
      requested: a.requested,
      achieved: a.achieved,
      pagesRequested: a.pagesRequested,
      pagesReturned: a.pagesReturned,
      itemsReturned: o.rows,
      duplicatesRemoved: a.duplicatesRemoved,
      providerTotal: a.providerTotal,
      capped: a.capped,
      missing: [...a.missing],
      notes: [...a.notes],
    };
    return {
      requestId: ic.requestId,
      tool: ic.tool,
      status,
      subject: o.subject,
      candidates: o.candidates ?? [],
      data,
      evidence: a.evidence(),
      freshness,
      coverage,
      usage: {
        providerCalls: calls,
        cacheHits: a.sections.reduce((n, s) => n + s.cacheHits, 0),
        creditsCharged: unknownCredits ? null : a.sections.reduce((n, s) => n + (s.credits ?? 0), 0),
        creditsRemaining: remaining,
      },
      dossierRevision: o.dossierRevision ?? null,
      reason: status === "ok" ? null : reason,
      message: o.message !== undefined ? o.message : defaultMessage(status, reason),
    };
  }

  function bare<T>(ic: Inv, status: ResultStatus, reason: string | null, message?: string | null, extra: Partial<FomoEnvelope<T>> = {}): FomoEnvelope<T> {
    const a = new Answer();
    const def = isFomoToolName(ic.tool) ? FOMO_TOOL_DEFS[ic.tool] : null;
    return {
      ...finish<T>(ic, a, { cls: def?.freshness ?? "profile", mode: "prefer-fresh", subject: null, data: null, rows: 0, essential: [], status, reason, message: message === undefined ? undefined : message }),
      ...extra,
    };
  }

  function fromFail<T>(ic: Inv, a: Answer, cls: FreshnessClass, mode: FreshnessMode, f: Fail): FomoEnvelope<T> {
    return finish<T>(ic, a, { cls, mode, subject: null, data: null, rows: 0, essential: [], status: f.status, reason: f.reason, message: f.message ?? undefined, candidates: f.candidates });
  }

  // ── Tool handlers ───────────────────────────────────────────────────

  interface Inv {
    tool: FomoToolName;
    requestId: string;
    now: number;
    cc: ChargeContext;
    audience: "owner" | "group";
    surface: FomoSurface;
    conversationKey: string | null;
  }

  async function toolResolve(ic: Inv, args: ToolArgs["fomo_resolve_subject"]): Promise<FomoEnvelope<ResolveData>> {
    const a = new Answer();
    a.requested = { query: args.query.kind, kind: args.kind, chain: args.chain };
    if (args.query.kind === "address" || args.query.kind === "symbol") {
      const r = await resolveToken(ic.cc, a, args.query as TokenRef, args.chain, "prefer-fresh");
      if (!r.ok) return fromFail(ic, a, "profile", "prefer-fresh", r);
      a.achieved = { chain: r.token.chain.slug, networkId: r.token.chain.networkId };
      if (r.token.chain.networkId === null) a.note("The provider gave no network id for this coin; it is never treated as executable.");
      return finish(ic, a, {
        cls: "profile",
        mode: "prefer-fresh",
        subject: { kind: "token", token: r.token, label: r.label },
        data: { kind: "token", match: r.match, formerHandle: false, executionAvailability: availabilityOf(r.token), marketCapUsd: r.marketCapUsd },
        rows: 1,
        essential: [],
      });
    }
    const r = await resolveTrader(ic.cc, a, args.query as TraderRef, "prefer-fresh");
    if (!r.ok) return fromFail(ic, a, "profile", "prefer-fresh", r);
    if (r.formerHandle) a.note("That handle is one this trader used before; the account has since renamed.");
    if (r.match === "user-id-unseen") a.note("This user id has not been seen by Merrymen before; its handle is unknown.");
    return finish(ic, a, {
      cls: "profile",
      mode: "prefer-fresh",
      subject: { kind: "trader", trader: r.trader },
      data: { kind: "trader", match: r.match, formerHandle: r.formerHandle, executionAvailability: null, marketCapUsd: null },
      rows: 1,
      essential: [],
    });
  }

  async function profileFromHeld(userId: string, now: number, cohort: CohortSnap, hit: TraderResolution extends infer X ? (X extends { ok: true; hit: infer H } ? H : null) : null): Promise<TraderContextData["profile"]> {
    // Only data already held: cohort evidence, a cached leaderboard row, or the search hit. Never a 2,500-credit read for a holdings question.
    const member = cohort.byId.get(userId);
    if (member) {
      const p = member.evidence.providerReported;
      const pnl: Partial<Record<RankingWindow, number | null>> = {};
      for (const w of ["24h", "7d", "30d", "all"] as const) if (`pnlUsd.${w}` in p) pnl[w] = p[`pnlUsd.${w}`] ?? null;
      return { source: "cohort-evidence", pnlUsd: pnl, volumeUsd: p["volumeUsd.24h"] ?? null, trades: p.trades ?? null, accountAgeDays: p.accountAgeDays ?? null, averageHoldTimeSeconds: p.averageHoldTimeSeconds ?? null };
    }
    const pnl: Partial<Record<RankingWindow, number | null>> = {};
    let volume: number | null = null;
    let trades: number | null = null;
    for (const w of ["24h", "7d", "30d", "all"] as const) {
      try {
        const e = await store.cacheGet(db, cacheKeyOf("leaderboard", { window: w, limit: BOARD_LIMIT }));
        const page = e && e.retrievedAtMs !== null && now - e.retrievedAtMs < DAY ? R.leaderboard(e.payload) : null;
        const row = page?.rows.find((r) => r.trader.userId === userId);
        if (row) {
          pnl[w] = row.pnlUsd;
          if (w === "24h") {
            volume = row.volumeUsd;
            trades = row.trades;
          }
        }
      } catch {
        // Optional context.
      }
    }
    if (Object.keys(pnl).length) return { source: "leaderboard", pnlUsd: pnl, volumeUsd: volume, trades, accountAgeDays: null, averageHoldTimeSeconds: null };
    // A search hit states a P&L without saying over which window; it is not filed under one.
    if (hit) return { source: "search", pnlUsd: {}, volumeUsd: hit.volumeUsd, trades: null, accountAgeDays: null, averageHoldTimeSeconds: null };
    return null;
  }

  async function toolTraderContext(ic: Inv, args: ToolArgs["fomo_get_trader_context"]): Promise<FomoEnvelope<TraderContextData>> {
    const a = new Answer();
    const focus = args.focus === "holdings" ? "holdings" : "context";
    a.requested = { trader: args.trader.kind, focus, window: args.window, depth: args.depth };
    const r = await resolveTrader(ic.cc, a, args.trader, args.freshness);
    if (!r.ok) return fromFail(ic, a, "holdings", args.freshness, r);
    const userId = r.trader.userId;
    const bal = a.add(await read(ic.cc, specs.balances(userId), args.freshness));
    let holdings: TraderContextData["holdings"] = null;
    if (bal.data) {
      const snap = bal.data;
      const rows: HoldingView[] = snap.rows.map((h) => ({
        token: h.token,
        symbol: cleanLabel(h.label).symbol,
        chain: h.token?.chain.slug ?? null,
        amount: h.amount,
        priceUsd: h.priceUsd,
        valueUsd: h.valueUsd,
        change24hPct: h.change24hPct,
        robinhood: isRobinhoodToken(h.token),
      }));
      rows.sort((x, y) => (y.valueUsd ?? -1) - (x.valueUsd ?? -1));
      const byChain = new Map<string, { rows: number; value: number | null }>();
      for (const h of rows) {
        const k = h.chain ?? "unknown";
        const cur = byChain.get(k) ?? { rows: 0, value: 0 };
        cur.rows++;
        cur.value = cur.value === null || h.valueUsd === null ? null : cur.value + h.valueUsd;
        byChain.set(k, cur);
      }
      holdings = {
        rows: rows.slice(0, MAX_HOLDINGS_SHOWN),
        rowsTotal: rows.length,
        truncated: snap.truncated,
        totalValueUsdFloor: snap.totalValueUsdFloor,
        complete: snap.complete,
        dropped: snap.dropped,
        byChain: [...byChain.entries()].map(([chain, v]) => ({ chain, rows: v.rows, valueUsd: v.value })),
      };
      a.ref("holdings", userId, bal.retrievedAt);
      if (snap.truncated) {
        a.capped = true;
        a.note("The provider caps holdings at about 100 rows, so the total is a floor, not the whole portfolio.");
      }
      if (rows.length > MAX_HOLDINGS_SHOWN) a.note(`Showing the ${MAX_HOLDINGS_SHOWN} largest of ${rows.length} holdings.`);
      if (snap.dropped > 0) a.note(`${snap.dropped} holding row(s) could not be placed on a chain and were left out.`);
      a.note("Holdings are a snapshot valued at current prices: a change in value can be price, not buying. The total excludes perps and other equity.");
      a.achieved = { holdingsRows: rows.length, truncated: snap.truncated };
    }
    let cohort: TraderContextData["cohort"] = null;
    let profile: TraderContextData["profile"] = null;
    if (focus === "context") {
      const snap = await cohortSnapshot(ic.now);
      const m = snap.byId.get(userId);
      cohort = { member: !!m, followable: m ? m.followable : null, version: snap.version, size: snap.size };
      if (args.depth === "deep") {
        const p = a.add(await read(ic.cc, specs.profile(userId), args.freshness));
        if (p.data) {
          profile = { source: "profile-read", pnlUsd: p.data.pnlUsd, volumeUsd: p.data.volumeUsd, trades: p.data.trades, accountAgeDays: p.data.accountAgeDays, averageHoldTimeSeconds: p.data.averageHoldTimeSeconds };
          a.ref("profile", userId, p.retrievedAt);
        }
      } else {
        profile = await profileFromHeld(userId, ic.now, snap, r.hit);
      }
      if (profile && Object.keys(profile.pnlUsd).length) a.note("P&L figures are provider-reported realised P&L, not a measure of skill.");
      if (args.window === "1h") a.note("Provider P&L windows start at 24h; there is no 1h figure.");
    }
    if (r.formerHandle) a.note("That handle is one this trader used before; the account has since renamed.");
    return finish(ic, a, {
      cls: "holdings",
      mode: args.freshness,
      subject: { kind: "trader", trader: r.trader },
      data: { trader: r.trader, formerHandle: r.formerHandle, focus, holdings, cohort, profile },
      rows: holdings?.rowsTotal ?? 0,
      essential: [bal],
    });
  }

  function inWindow(t: number | null, since: number | null): boolean {
    return since === null || (t !== null && t >= since);
  }

  async function toolTraderActivity(ic: Inv, args: ToolArgs["fomo_get_trader_activity"]): Promise<FomoEnvelope<TraderActivityData>> {
    const a = new Answer();
    a.requested = { window: args.window, side: args.side, token: args.token ? args.token.kind : null, chain: args.chain, limit: args.limit };
    const r = await resolveTrader(ic.cc, a, args.trader, args.freshness);
    if (!r.ok) return fromFail(ic, a, "activity", args.freshness, r);
    let token: TokenIdentity | null = null;
    if (args.token) {
      const t = await resolveToken(ic.cc, a, args.token, args.chain, args.freshness);
      if (!t.ok) return fromFail(ic, a, "activity", args.freshness, t);
      token = t.token;
    }
    const userId = r.trader.userId;
    const winMs = windowMsOf(args.window);
    const since = winMs === null ? null : ic.now - winMs;
    const cohort = await cohortSnapshot(ic.now);
    // CHOICE: positions (the reconciled lots, cumulative P&L) and the feed (typed events with event times) answer
    // "what has X been doing"; individual fills are read only when a coin was named, where they add exact amounts.
    const pos = a.add(await read(ic.cc, specs.positions(userId), args.freshness));
    const feed = a.add(await read(ic.cc, specs.feed({ userId, token: token?.address, chain: token ? feedChainOf(token) : undefined }), args.freshness));
    const fillsRead = token ? a.add(await read(ic.cc, specs.swaps(userId, token.address), args.freshness)) : null;
    const sources = ["positions", "feed", ...(token ? ["fills"] : [])];

    let positions: PositionView[] = [];
    if (pos.data) {
      a.ref("positions", userId, pos.retrievedAt);
      positions = pos.data.rows
        .filter((p) => !token || p.token?.key === token.key)
        .filter((p) => {
          if (args.side === "buy") return inWindow(p.openedAt, since);
          if (args.side === "sell") return inWindow(p.closedAt, since) || ((p.soldAmount ?? 0) > 0 && inWindow(p.openedAt, since));
          return inWindow(p.openedAt, since) || inWindow(p.closedAt, since) || (since === null);
        })
        .map((p) => ({
          tradeId: p.tradeId,
          token: p.token,
          label: cleanLabel(p.label),
          status: p.status,
          costBasisUsd: p.costBasisUsd,
          realizedPnlUsd: p.realizedPnlUsd,
          unrealizedPnlUsd: p.unrealizedPnlUsd,
          boughtAmount: p.boughtAmount,
          soldAmount: p.soldAmount,
          transferredInAmount: p.transferredInAmount,
          transferredOutAmount: p.transferredOutAmount,
          openedAt: p.openedAt,
          closedAt: p.closedAt,
          source: p.source,
        }));
      if (pos.data.truncated) a.note("The provider cut the positions page; older positions are not shown.");
      if (positions.some((p) => (p.transferredInAmount ?? 0) > 0 && (p.boughtAmount ?? 0) === 0)) {
        a.note("Some positions were received by transfer, not bought.");
      }
    }
    let events: ActivityEventView[] = [];
    const counts = { buys: 0, sells: 0, transfers: 0, other: 0 };
    if (feed.data) {
      const matching = feed.data.rows
        .filter((e) => e.trader.userId === userId)
        .filter((e) => !token || e.token?.key === token.key)
        .filter((e) => inWindow(eventTime(e), since))
        .filter((e) => (args.side === null ? true : e.kind === args.side));
      for (const e of matching) {
        if (e.kind === "buy") counts.buys++;
        else if (e.kind === "sell") counts.sells++;
        else if (e.kind === "transfer-in" || e.kind === "transfer-out" || e.kind === "airdrop") counts.transfers++;
        else counts.other++;
        a.sourceTimes.push(eventTime(e));
      }
      matching.sort((x, y) => eventTime(y) - eventTime(x));
      if (matching.length > args.limit) a.capped = true;
      events = matching.slice(0, args.limit).map((e) => eventView(e, "rest-lookup", cohort.ids));
      for (const e of events) a.ref("event", e.evidenceId.slice("fomo:event/".length));
      if (feed.data.hasMore === true && matching.length > 0) a.note("The feed has more history than one page; older events in the window may be missing.");
      a.note(FEED_FLOOR_NOTE);
    }
    let fills: FillView[] = [];
    if (fillsRead?.data && token) {
      const t = token;
      a.ref("fills", `${userId}:${t.key}`, fillsRead.retrievedAt);
      const all = fillsRead.data.rows
        .filter((f) => inWindow(f.at, since))
        .map((f): FillView => {
          const bought = f.tokenOut.token?.key === t.key;
          const sold = f.tokenIn.token?.key === t.key;
          const leg = bought ? f.tokenOut : sold ? f.tokenIn : null;
          return { swapId: f.swapId, side: bought ? "buy" : sold ? "sell" : "swap", token: leg?.token ?? null, tokenAmount: leg?.amount ?? null, usd: leg?.usd ?? null, at: f.at };
        })
        .filter((f) => args.side === null || f.side === args.side);
      if (all.length > args.limit || fillsRead.data.moreAvailable === true) a.capped = true;
      fills = all.slice(0, args.limit);
    }
    if (positions.length > args.limit) a.capped = true;
    positions = positions.slice(0, args.limit);
    a.achieved = { window: args.window, positions: positions.length, events: events.length, fills: fills.length };
    a.note("A transfer or airdrop is not a purchase; a position's mark and its cumulative P&L are not fill sizes.");
    return finish(ic, a, {
      cls: "activity",
      mode: args.freshness,
      subject: { kind: "trader", trader: r.trader },
      data: { trader: r.trader, token, window: args.window, side: args.side, sources, positions, fills, events, counts },
      rows: positions.length + events.length + fills.length,
      essential: [pos, feed],
    });
  }

  function thesisViews(rows: readonly Thesis[]): { views: ThesisView[]; stance: TokenThesesData["stance"]; families: number; authors: number } {
    const fam = resolveFamilies(rows);
    const stance = { supporting: 0, opposing: 0, neutral: 0 };
    const views: ThesisView[] = rows.map((t) => {
      const s = readThesisText(t.text).stance;
      stance[s]++;
      return {
        evidenceId: `fomo:thesis/${t.id}`,
        author: { userId: t.author.userId, handle: handleOf(t.author.handle) },
        token: t.token,
        postedAt: t.postedAt,
        stance: s,
        excerpt: excerptOf(t.text),
        likes: t.likes,
        isDev: t.isDev,
        family: fam.get(t.id) ?? t.familyKey,
      };
    });
    return { views, stance, families: new Set(views.map((v) => v.family)).size, authors: new Set(rows.map((t) => t.author.userId)).size };
  }

  async function previousDossier(t: TokenIdentity): Promise<CoinDossier | null> {
    try {
      const s = await store.latestDossier(db, t.key);
      return s ? asDossier(s.dossier, t) : null;
    } catch {
      return null;
    }
  }

  /** Thesis pages for a token: one, expanded only as planThesisFetch allows. Each page is 1,250 credits. */
  async function readTokenTheses(cc: ChargeContext, a: Answer, t: TokenIdentity, depth: "quick" | "standard" | "deep", mode: FreshnessMode): Promise<{ section: Section<ThesesPage>; rows: Thesis[]; pages: number; capped: boolean }> {
    const first = a.add(await read(cc, specs.thesesByToken(t, 1), mode));
    if (!first.data) return { section: first, rows: [], pages: 1, capped: false };
    let page = first.data;
    let section = first;
    const total = page.totalAvailable;
    const capped = page.rows.length >= THESIS_PAGE_SIZE || (total !== null && total > page.rows.length);
    const firstStances = page.rows.map((x) => readThesisText(x.text).stance);
    const plan = planThesisFetch(
      await previousDossier(t),
      {
        capped,
        uniqueAuthors: new Set(page.rows.map((x) => x.author.userId)).size,
        providerTotal: total,
        contested: firstStances.includes("supporting") && firstStances.includes("opposing") ? true : undefined,
      },
      { depth },
    );
    let pages = 1;
    if (plan.pages > 1) {
      // The provider's `pages` returns pages 1..N in one billed read, so page one is paid again; bounded by planThesisFetch.
      const more = a.add(await read(cc, specs.thesesByToken(t, plan.pages), mode));
      if (more.data) {
        page = more.data;
        section = more;
        pages = plan.pages;
      } else a.note("The wider thesis read did not complete; only the first page is used.");
    }
    a.note(`Thesis pages: ${plan.reason}.`);
    const stillCapped = page.rows.length >= pages * THESIS_PAGE_SIZE || (page.totalAvailable !== null && page.totalAvailable > page.rows.length);
    return { section, rows: page.rows, pages, capped: stillCapped };
  }

  async function toolTokenTheses(ic: Inv, args: ToolArgs["fomo_get_token_theses"]): Promise<FomoEnvelope<TokenThesesData>> {
    const a = new Answer();
    a.requested = { token: args.token?.kind ?? null, trader: args.trader?.kind ?? null, chain: args.chain, window: args.window, limit: args.limit, depth: args.depth };
    let token: TokenIdentity | null = null;
    let label: TokenLabel | null = null;
    let trader: TraderIdentity | null = null;
    if (args.token) {
      const t = await resolveToken(ic.cc, a, args.token, args.chain, args.freshness);
      if (!t.ok) return fromFail(ic, a, "theses", args.freshness, t);
      token = t.token;
      label = t.label;
    }
    if (args.trader) {
      const r = await resolveTrader(ic.cc, a, args.trader, args.freshness);
      if (!r.ok) return fromFail(ic, a, "theses", args.freshness, r);
      trader = r.trader;
    }
    let section: Section<ThesesPage>;
    let rows: Thesis[] = [];
    let page: ThesesPage | null = null;
    if (token && trader) {
      section = a.add(await read(ic.cc, specs.thesesByUserToken(trader.userId, token, Math.min(100, Math.max(args.limit, 25))), args.freshness));
      page = section.data;
      rows = page?.rows ?? [];
    } else if (token) {
      const r = await readTokenTheses(ic.cc, a, token, args.depth, args.freshness);
      section = r.section;
      page = section.data;
      rows = r.rows;
      if (r.capped) a.capped = true;
    } else {
      section = a.add(await read(ic.cc, specs.thesesByUser(trader!.userId, Math.min(100, Math.max(args.limit, 25))), args.freshness));
      page = section.data;
      rows = page?.rows ?? [];
    }
    let honoured: boolean | null = null;
    if (page) {
      const before = rows.length;
      const byId = new Map<string, Thesis>();
      for (const t of rows) if (!byId.has(t.id)) byId.set(t.id, t);
      rows = [...byId.values()];
      a.duplicatesRemoved = before - rows.length;
      a.providerTotal = page.totalAvailable;
      honoured = page.chainFilterHonoured;
      if (token) {
        const t = token;
        // Robinhood is fetched without a network parameter (the provider's enum lacks it), so the rows decide.
        const off = rows.filter((x) => x.token !== null && x.token.key !== t.key).length;
        rows = rows.filter((x) => x.token === null || x.token.key === t.key);
        if (off > 0) {
          honoured = false;
          a.note(`${off} thesis row(s) were about a coin on another chain and were removed.`);
        }
      }
      if (trader) {
        const u = trader.userId;
        rows = rows.filter((x) => x.author.userId === u);
      }
      const winMs = windowMsOf(args.window);
      if (winMs !== null) rows = rows.filter((x) => x.postedAt !== null && x.postedAt >= ic.now - winMs);
      if (page.stale === true) a.note(`The provider served a stored thesis snapshot${page.ageSeconds !== null ? ` about ${Math.round(page.ageSeconds / 3600)}h old` : ""}, not a live pull.`);
      if (page.partial === true) a.partial = true;
      if (page.totalAvailable !== null && page.totalAvailable > rows.length && !a.capped && !trader) a.capped = true;
    }
    rows.sort((x, y) => (y.postedAt ?? 0) - (x.postedAt ?? 0));
    if (token) label = fillLabel(label, rows.map((x) => ({ token: x.token, label: x.tokenLabel })), token.key);
    if (rows.length > args.limit) a.capped = true;
    const shown = rows.slice(0, args.limit);
    const tv = thesisViews(rows);
    const shownViews = tv.views.slice(0, args.limit);
    for (const v of shownViews) {
      a.ref("thesis", v.evidenceId.slice("fomo:thesis/".length));
      a.sourceTimes.push(v.postedAt);
    }
    a.achieved = { theses: rows.length, shown: shown.length, families: tv.families, authors: tv.authors, chainFilterHonoured: honoured };
    a.note("Theses are their authors' claims, not verified facts; stance is Merrymen's reading of the text.");
    const subject: ResolvedSubject | null = token ? { kind: "token", token, label: label ?? { symbol: null, name: null } } : trader ? { kind: "trader", trader } : null;
    return finish(ic, a, {
      cls: "theses",
      mode: args.freshness,
      subject,
      data: { token, label, trader, theses: shownViews, stance: tv.stance, families: tv.families, uniqueAuthors: tv.authors, chainFilterHonoured: honoured },
      rows: rows.length,
      essential: [section],
    });
  }

  async function cohortEvents(snap: CohortSnap, since: number, perTrader: number): Promise<StoredTraderEvent[]> {
    const out: StoredTraderEvent[] = [];
    for (const id of snap.ids) {
      try {
        out.push(...(await store.eventsForTrader(db, id, since, perTrader)));
      } catch (e) {
        log(`fomo: cohort event read failed: ${errText(e)}`);
        break;
      }
    }
    return out;
  }

  async function gapNote(a: Answer, since: number, now: number): Promise<void> {
    try {
      const gaps = await store.listOpenGaps(db, null, 50);
      const overlapping = gaps.filter((g) => g.toMs >= since && g.fromMs <= now);
      if (overlapping.length) {
        a.partial = true;
        const mins = Math.round(overlapping.reduce((n, g) => n + (Math.min(g.toMs, now) - Math.max(g.fromMs, since)), 0) / MIN);
        a.note(`The shared feed record has ${overlapping.length} open gap(s) in this window (about ${mins} min not yet recovered); activity there may be missing.`);
      }
    } catch {
      // Without the gap ledger the answer says nothing about gaps rather than claiming none.
    }
  }

  async function toolTokenActivity(ic: Inv, args: ToolArgs["fomo_get_token_activity"]): Promise<FomoEnvelope<TokenActivityData>> {
    const a = new Answer();
    a.requested = { token: args.token?.kind ?? null, chain: args.chain, side: args.side, window: args.window, cohortOnly: args.cohortOnly, limit: args.limit };
    let token: TokenIdentity | null = null;
    let label: TokenLabel | null = null;
    if (args.token) {
      const t = await resolveToken(ic.cc, a, args.token, args.chain, args.freshness);
      if (!t.ok) return fromFail(ic, a, "activity", args.freshness, t);
      token = t.token;
      label = t.label;
    }
    const winMs = windowMsOf(args.window);
    const since = winMs === null ? 0 : ic.now - winMs;
    const cohort = await cohortSnapshot(ic.now);
    const essential: Section<unknown>[] = [];
    let local: StoredTraderEvent[] = [];
    let rest: TraderEvent[] = [];
    let statsSection: Section<TokenStats> | null = null;
    const current = await streamCurrent(ic.now);
    if (token) {
      local = await store.eventsForToken(db, token.key, since, LOCAL_EVENT_LIMIT).catch(() => []);
      const localSec = a.add(localSection("stream-record", local, local.length ? Math.max(...local.map((e) => e.observedAt)) : null));
      // The shared stream already records every Robinhood event; a REST read adds nothing unless the record is behind or "now" was asked.
      if (isRobinhoodToken(token) && current && args.freshness !== "force-refresh") {
        a.note("Served from the live shared feed record.");
        essential.push(localSec);
      } else {
        const t = token;
        const feed = a.add(await read(ic.cc, specs.feed({ token: t.address, chain: feedChainOf(t) }), args.freshness));
        if (feed.data) {
          rest = feed.data.rows.filter((e) => e.token?.key === t.key);
          if (feed.data.chainFilterHonoured === false) a.note("The provider ignored the chain filter; rows on other chains were removed.");
          if (feed.data.hasMore === true) a.note("The feed has more history than one page; older events in the window may be missing.");
        }
        // Local events stand in for a failed REST read only when there are some.
        essential.push(feed, ...(local.length ? [localSec] : []));
      }
      statsSection = a.add(await read(ic.cc, specs.tokenStats(token), args.freshness));
      if (statsSection.data?.token && statsSection.data.token.key !== token.key) {
        a.note("The provider's stats were for a different network; they are not shown.");
        statsSection = { ...statsSection, data: null };
      } else if (statsSection.data) a.ref("token-stats", token.key, statsSection.retrievedAt);
    } else {
      if (args.cohortOnly) {
        local = await cohortEvents(cohort, since, 100);
        const localSec = a.add(localSection("stream-record", local, local.length ? Math.max(...local.map((e) => e.observedAt)) : null));
        essential.push(localSec);
        if (cohort.size === null) a.note("No followed cohort has been built yet.");
      } else {
        const chain = args.chain ?? undefined;
        const feed = a.add(await read(ic.cc, specs.feed({ chain }), args.freshness));
        if (feed.data) {
          rest = feed.data.rows;
          if (feed.data.chainFilterHonoured === false) a.note("The provider ignored the chain filter; rows on other chains were removed.");
        }
        essential.push(feed);
        a.note("Whole-feed reads cover the latest page of the feed only.");
      }
    }
    const merged = dedupeEvents([...local, ...rest]);
    a.duplicatesRemoved = merged.duplicates;
    if (token) label = fillLabel(label, merged.events.map((e) => ({ token: e.token, label: e.tokenLabel })), token.key);
    const restKeys = new Set(rest.map((e) => e.eventKey));
    const chainReq = args.chain && !token ? chainFromUserText(args.chain) : null;
    const inScope = merged.events
      .filter((e) => eventTime(e) >= since)
      .filter((e) => (token ? e.token?.key === token.key : chainReq ? chainMatches(chainReq, e.token) : true))
      .filter((e) => e.kind !== "thesis" && e.kind !== "listing")
      .filter((e) => !args.cohortOnly || cohort.ids.has(e.trader.userId));
    const matching = inScope.filter((e) => (args.side === null ? true : e.kind === args.side)).sort((x, y) => eventTime(y) - eventTime(x));
    const anyActivityRead = essential.some((s) => s.data !== null);
    const buyers = new Set(inScope.filter((e) => e.kind === "buy").map((e) => e.trader.userId));
    const sellers = new Set(inScope.filter((e) => e.kind === "sell").map((e) => e.trader.userId));
    let cohortView: TokenActivityData["cohort"] = null;
    if (args.cohortOnly || cohort.ids.size > 0) {
      const latest = new Map<string, CohortActor>();
      for (const e of [...inScope].sort((x, y) => eventTime(y) - eventTime(x))) {
        if (!cohort.ids.has(e.trader.userId) || (e.kind !== "buy" && e.kind !== "sell") || latest.has(e.trader.userId)) continue;
        latest.set(e.trader.userId, { userId: e.trader.userId, handle: handleOf(e.trader.handle), latestAction: e.kind, at: eventTime(e) });
      }
      const actors = [...latest.values()];
      cohortView = {
        buyers: actors.filter((x) => x.latestAction === "buy").slice(0, MAX_EVENTS_SHOWN),
        sellers: actors.filter((x) => x.latestAction === "sell").slice(0, MAX_EVENTS_SHOWN),
        version: cohort.version,
        size: cohort.size,
      };
    }
    let breadth: TokenActivityData["breadth"] = null;
    if (token) {
      const t = token;
      const b = participationBreadth(inScope, winMs ?? 365 * DAY, ic.now).find((x) => x.tokenKey === t.key);
      if (b) breadth = { distinctBuyers: b.distinctBuyers, buyEvents: b.buyEvents, repeatAdds: b.repeatAdds, reading: b.reading, notes: b.notes };
    }
    if (matching.length > args.limit) a.capped = true;
    const shown = matching.slice(0, args.limit).map((e) => eventView(e, restKeys.has(e.eventKey) && !local.some((l) => l.eventKey === e.eventKey) ? "rest-lookup" : "stream-record", cohort.ids));
    for (const e of shown) {
      a.ref("event", e.evidenceId.slice("fomo:event/".length));
      a.sourceTimes.push(e.at);
    }
    if (local.length || rest.length || token) await gapNote(a, since, ic.now);
    a.note(FEED_FLOOR_NOTE);
    a.note("Distinct wallets are not proven to be distinct people.");
    const s = statsSection?.data ?? null;
    a.achieved = { window: args.window, events: matching.length, shown: shown.length, localEvents: local.length, restEvents: rest.length, cohortOnly: args.cohortOnly };
    return finish(ic, a, {
      cls: "activity",
      mode: args.freshness,
      subject: token ? { kind: "token", token, label: label ?? { symbol: null, name: null } } : { kind: "market" },
      data: {
        token,
        label,
        window: args.window,
        side: args.side,
        cohortOnly: args.cohortOnly,
        events: shown,
        distinctBuyers: anyActivityRead ? buyers.size : null,
        distinctSellers: anyActivityRead ? sellers.size : null,
        cohort: cohortView,
        breadth,
        stats: s ? { holders: s.holders, top10HoldersPercent: s.top10HoldersPercent, window24h: s.windows["24h"] ?? null, window1h: s.windows["1h"] ?? null } : null,
        localEvents: local.length,
        restEvents: rest.length,
      },
      rows: matching.length,
      essential,
    });
  }

  async function toolRankings(ic: Inv, args: ToolArgs["fomo_get_rankings"]): Promise<FomoEnvelope<RankingsData>> {
    const a = new Answer();
    a.requested = { board: args.board, window: args.board === "traders" ? args.window : null, chain: args.chain, limit: args.limit, cohortOnly: args.cohortOnly };
    if (args.board === "traders") {
      const lb = a.add(await read(ic.cc, specs.leaderboard(args.window), args.freshness));
      const cohort = await cohortSnapshot(ic.now);
      let rows = lb.data?.rows ?? [];
      if (lb.data) {
        a.ref("ranking", args.window, lb.retrievedAt);
        try {
          await store.upsertTraders(db, rows.map((r) => r.trader), ic.now);
        } catch (e) {
          log(`fomo: trader identity write failed: ${errText(e)}`);
        }
      }
      if (args.cohortOnly) rows = rows.filter((r) => cohort.ids.has(r.trader.userId));
      const traders = rows.slice(0, args.limit).map((r) => ({
        rank: r.rank,
        trader: { ...r.trader, handle: handleOf(r.trader.handle) },
        pnlUsd: r.pnlUsd,
        volumeUsd: r.volumeUsd,
        trades: r.trades,
        inCohort: cohort.size === null ? null : cohort.ids.has(r.trader.userId),
      }));
      a.note("P&L is the provider-reported realised P&L for the window, not a measure of skill; follower counts are not used.");
      if (args.cohortOnly) a.note("Limited to Merrymen's followed traders who appear on this board.");
      a.achieved = { rows: traders.length, boardRows: lb.data?.rows.length ?? null };
      return finish(ic, a, {
        cls: "rankings",
        mode: args.freshness,
        subject: { kind: "market" },
        data: { board: args.board, window: args.window, basis: "provider-reported P&L, not skill", traders, tokens: [] },
        rows: traders.length,
        essential: [lb],
      });
    }
    const board = args.board === "trending-tokens" ? "trending" : args.board === "graduated-tokens" ? "graduated" : "most-held";
    const tb = a.add(await read(ic.cc, specs.tokenBoard(board), args.freshness));
    const chain = args.chain ? chainFromUserText(args.chain) : null;
    const rows = (tb.data?.rows ?? []).filter((r) => chainMatches(chain, r.token));
    if (tb.data) a.ref("board", board, tb.retrievedAt);
    const tokens = rows.slice(0, args.limit).map((r) => ({
      rank: r.rank,
      token: r.token,
      label: cleanLabel(r.label),
      holders: r.holders,
      priceUsd: r.priceUsd,
      change24hPct: r.change24hPct,
      marketCapUsd: r.marketCapUsd,
      volume24hUsd: r.volume24hUsd,
      executionAvailability: availabilityOf(r.token),
    }));
    if (tokens.some((t) => t.marketCapUsd === null)) a.note("A blank market cap is unknown, not zero.");
    a.note("Board position reflects popularity on Fomo, not quality.");
    a.achieved = { rows: tokens.length, chain: args.chain };
    return finish(ic, a, {
      cls: "boards",
      mode: args.freshness,
      subject: { kind: "market" },
      data: { board: args.board, window: null, basis: "provider token board", traders: [], tokens },
      rows: tokens.length,
      essential: [tb],
    });
  }

  async function toolOpportunities(ic: Inv, args: ToolArgs["fomo_find_opportunities"]): Promise<FomoEnvelope<OpportunitiesData>> {
    const a = new Answer();
    a.requested = { chain: args.chain, window: args.window, limit: args.limit, cohortOnly: args.cohortOnly, maxMarketCapUsd: args.maxMarketCapUsd };
    const winMs = windowMsOf(args.window) ?? 30 * DAY;
    const since = ic.now - winMs;
    const chain = args.chain ? chainFromUserText(args.chain) : null;
    const cohort = await cohortSnapshot(ic.now);
    const graduated = a.add(await read(ic.cc, specs.tokenBoard("graduated"), args.freshness));
    const trending = a.add(await read(ic.cc, specs.tokenBoard("trending"), args.freshness));
    // Local cohort record (free): first purchases and breadth over the window; a 7-day lookback decides "first seen".
    const lookback = Math.min(since, ic.now - FIRST_SEEN_LOOKBACK_MS);
    const events = cohort.ids.size ? await cohortEvents(cohort, lookback, 100) : [];
    const localSec = a.add(localSection("cohort-record", events, events.length ? Math.max(...events.map((e) => e.observedAt)) : null));
    const before = events.filter((e) => eventTime(e) < since);
    const inWin = events.filter((e) => eventTime(e) >= since);
    const firstSeen = new Map<string, number>();
    for (const e of before) if (e.token) firstSeen.set(e.token.key, Math.min(firstSeen.get(e.token.key) ?? Infinity, eventTime(e)));
    const early = new Map(earlyDiscovery(inWin, firstSeen, cohort.ids).map((d) => [d.tokenKey, d]));
    const breadth = new Map(participationBreadth(inWin, winMs, ic.now).map((b) => [b.tokenKey, b]));

    interface Cand { token: TokenIdentity; label: TokenLabel; cap: number | null; boards: Set<string>; cohortBuyers: Set<string>; buyers: Set<string>; latestBuyAt: number | null; newThesis: boolean; refs: string[] }
    const cands = new Map<string, Cand>();
    const get = (t: TokenIdentity, l: TokenLabel): Cand => {
      let c = cands.get(t.key);
      if (!c) {
        c = { token: t, label: cleanLabel(l), cap: null, boards: new Set(), cohortBuyers: new Set(), buyers: new Set(), latestBuyAt: null, newThesis: false, refs: [] };
        cands.set(t.key, c);
      }
      if (!c.label.symbol && l.symbol) c.label = cleanLabel(l);
      return c;
    };
    for (const [sec, name] of [[graduated, "graduated"], [trending, "trending"]] as const) {
      if (!sec.data) continue;
      a.ref("board", name, sec.retrievedAt);
      for (const r of sec.data.rows) {
        if (!r.token) continue;
        const c = get(r.token, r.label);
        c.boards.add(name);
        if (r.marketCapUsd !== null) c.cap = r.marketCapUsd;
      }
    }
    for (const e of inWin) {
      if (!e.token) continue;
      if (e.kind === "buy") {
        const c = get(e.token, e.tokenLabel);
        c.buyers.add(e.trader.userId);
        if (cohort.ids.has(e.trader.userId)) c.cohortBuyers.add(e.trader.userId);
        const at = eventTime(e);
        c.latestBuyAt = c.latestBuyAt === null ? at : Math.max(c.latestBuyAt, at);
        if (c.refs.length < 5) c.refs.push(`fomo:event/${e.eventKey}`);
      } else if (e.kind === "thesis") {
        get(e.token, e.tokenLabel).newThesis = true;
      }
    }
    let filteredByCap = 0;
    const rows: OpportunityRow[] = [];
    for (const c of cands.values()) {
      if (!chainMatches(chain, c.token)) continue;
      if (args.cohortOnly && c.cohortBuyers.size === 0) continue;
      if (args.maxMarketCapUsd !== null && c.cap !== null && c.cap > args.maxMarketCapUsd) {
        filteredByCap++;
        continue;
      }
      const firstSeenInWindow = early.has(c.token.key);
      // EARLY-SIGNAL EVIDENCE, NOT SIZE: market cap, volume, holders and board rank are never scored.
      const recent = c.latestBuyAt !== null && ic.now - c.latestBuyAt <= 6 * HOUR ? 1 : 0;
      const score =
        3 * c.cohortBuyers.size +
        1 * Math.max(0, c.buyers.size - c.cohortBuyers.size) * 0.5 +
        2 * (firstSeenInWindow ? 1 : 0) +
        1 * (c.newThesis ? 1 : 0) +
        1 * (c.boards.has("graduated") ? 1 : 0) +
        0.5 * (c.boards.has("trending") ? 1 : 0) +
        recent;
      const availability = availabilityOf(c.token);
      rows.push({
        token: c.token,
        label: c.label,
        marketCapUsd: c.cap,
        marketCapKnown: c.cap !== null,
        signals: {
          cohortBuyers: c.cohortBuyers.size,
          distinctBuyers: breadth.get(c.token.key)?.distinctBuyers ?? c.buyers.size,
          latestBuyAt: c.latestBuyAt,
          firstSeenInWindow,
          newThesis: c.newThesis,
          boards: [...c.boards].sort(),
        },
        score: Math.round(score * 100) / 100,
        executionAvailability: availability,
        routeNote: isRobinhoodToken(c.token) ? "route not yet verified by Merrymen" : availability === "unsupported-chain" ? "not on a chain Merrymen trades" : "chain not resolved",
        evidence: c.refs,
      });
    }
    rows.sort((x, y) => y.score - x.score || (y.signals.latestBuyAt ?? 0) - (x.signals.latestBuyAt ?? 0) || (x.token.key < y.token.key ? -1 : 1));
    if (rows.length > args.limit) a.capped = true;
    const shown = rows.slice(0, args.limit);
    for (const r of shown) for (const id of r.evidence) a.addRef({ id, kind: "event", sourceUrl: null });
    if (filteredByCap) a.note(`${filteredByCap} coin(s) above the market-cap limit were left out; coins with an unknown market cap were kept and are labelled.`);
    if (cohort.size === null) a.note("No followed cohort has been built yet, so only the boards were used.");
    a.note("Ranked by early-signal evidence (distinct followed buyers, recency, new theses, first appearance), not by size or popularity.");
    a.note("Research leads only: no route has been verified and nothing here is a reason to buy.");
    a.achieved = { candidates: rows.length, shown: shown.length, cohortEvents: inWin.length };
    return finish(ic, a, {
      cls: "boards",
      mode: args.freshness,
      subject: { kind: "market" },
      data: { window: args.window, ranking: "early-signal evidence, not size", rows: shown, filteredByMarketCap: filteredByCap },
      rows: shown.length,
      essential: [graduated, trending, localSec].filter((s) => s.route !== null || cohort.ids.size > 0),
    });
  }

  // ── Dossier refresh ─────────────────────────────────────────────────

  async function refreshCore(
    cc: ChargeContext,
    a: Answer,
    token: TokenIdentity,
    label: TokenLabel,
    o: { depth: "quick" | "standard" | "deep"; mode: FreshnessMode },
  ): Promise<RefreshOutcome> {
    const before = a.sections.length;
    const previous = await previousDossier(token);
    const th = await readTokenTheses(cc, a, token, o.depth, o.mode);
    const usageNow = (): RefreshOutcome["usage"] => {
      const mine = a.sections.slice(before);
      return {
        providerCalls: mine.reduce((n, s) => n + s.providerCalls, 0),
        cacheHits: mine.reduce((n, s) => n + s.cacheHits, 0),
        creditsCharged: mine.some((s) => s.providerCalls > 0 && s.credits === null) ? null : mine.reduce((n, s) => n + (s.credits ?? 0), 0),
      };
    };
    if (!th.section.data) {
      // No thesis evidence: the previous dossier stands, and nothing is rebuilt from less.
      const st = th.section.status;
      const status: ResultStatus = st === "budget-limited" ? "budget-limited" : previous ? "stale" : st === "ok" || st === "stale" ? "failed" : st;
      return { dossier: previous, changed: false, status, reason: th.section.reason, checked: false, usage: usageNow(), notes: [] };
    }
    const since = cc.now - DAY;
    const local = await store.eventsForToken(db, token.key, since, LOCAL_EVENT_LIMIT).catch(() => [] as StoredTraderEvent[]);
    let rest: TraderEvent[] = [];
    let activityRead: boolean;
    if (isRobinhoodToken(token) && (await streamCurrent(cc.now)) && o.mode !== "force-refresh") {
      activityRead = true;
    } else {
      const feed = a.add(await read(cc, specs.feed({ token: token.address, chain: feedChainOf(token) }), o.mode));
      if (feed.data) rest = feed.data.rows.filter((e) => e.token?.key === token.key);
      activityRead = feed.data !== null;
    }
    const stats = a.add(await read(cc, specs.tokenStats(token), o.mode));
    const statsData = stats.data && (!stats.data.token || stats.data.token.key === token.key) ? stats.data : null;
    const refusedBy = a.sections.slice(before).find((s) => s.reason !== null && (s.reason.startsWith("budget-") || s.reason === "job-allowance"));
    if (refusedBy && previous) {
      // Never rebuild from less because a budget said no: the previous revision stands, said so.
      return { dossier: previous, changed: false, status: "budget-limited", reason: refusedBy.reason, checked: false, usage: usageNow(), notes: [] };
    }
    const cohort = await cohortSnapshot(cc.now);
    const events = dedupeEvents([...local, ...rest]).events;
    const page = th.section.data;
    const built = buildDossier({
      token,
      label: fillLabel(label, th.rows.map((x) => ({ token: x.token, label: x.tokenLabel })), token.key),
      theses: th.rows,
      thesisCoverage: {
        pagesRequested: th.pages,
        pagesReturned: th.pages,
        providerTotal: page.totalAvailable,
        capped: th.capped,
        stale: page.stale,
        ageSeconds: page.ageSeconds,
        chainFilterHonoured: page.chainFilterHonoured,
      },
      events,
      cohortUserIds: cohort.ids,
      stats: statsData,
      marketContext: [],
      routeContext: [isRobinhoodToken(token) ? "On Robinhood Chain; a trading route has not been verified by Merrymen." : "Not on a chain Merrymen trades; research only."],
      ownFamilies: new Set<string>(),
      selfNames,
      previous,
      now: cc.now,
      window: "24h",
      activityRead,
    });
    let dossier = built.dossier;
    let changed = built.changed;
    if (built.changed) {
      try {
        const stored = await store.insertDossierRevision(db, token.key, dossier.inputsHash, dossier, dossier.builtAt);
        if (!stored.created) {
          // Another builder stored these exact inputs first; its revision is the one to cite.
          dossier = asDossier(stored.dossier.dossier, token) ?? { ...dossier, revision: stored.dossier.revision };
          changed = false;
        } else if (stored.dossier.revision !== dossier.revision) {
          dossier = { ...dossier, revision: stored.dossier.revision };
        }
      } catch (e) {
        log(`fomo: dossier write failed: ${errText(e)}`);
      }
    }
    const thesisLive = th.section.status === "ok";
    const anyMissing = a.sections.slice(before).some((s) => s.data === null) || !activityRead;
    const anyStale = a.sections.slice(before).some((s) => s.status === "stale");
    const status: ResultStatus = anyMissing ? "partial" : anyStale ? "stale" : "ok";
    return { dossier, changed, status, reason: status === "ok" ? null : a.sections.slice(before).find((s) => s.status !== "ok")?.reason ?? null, checked: thesisLive && activityRead, usage: usageNow(), notes: [] };
  }

  function claimView(c: CoinDossier["claims"][number] | null): ClaimView | null {
    if (!c) return null;
    const d = c as Partial<DossierClaimDetail> & typeof c;
    const q = d.quoted && typeof d.quoted.text === "string" && typeof d.quoted.evidenceId === "string" ? { text: excerptOf(d.quoted.text), evidenceId: d.quoted.evidenceId } : null;
    return { claimKey: c.claimKey, stance: c.stance, summary: sanitizeText(c.summary, 240), support: c.support, familyCount: c.familyCount, authorCount: c.authorCount, quoted: q };
  }

  async function toolResearchCoin(ic: Inv, args: ToolArgs["fomo_research_coin"]): Promise<FomoEnvelope<ResearchCoinData>> {
    const a = new Answer();
    a.requested = { token: args.token.kind, chain: args.chain, depth: args.depth, focus: args.focus, sinceRevision: args.sinceRevision, window: args.window };
    const t = await resolveToken(ic.cc, a, args.token, args.chain, args.freshness);
    if (!t.ok) return fromFail(ic, a, "theses", args.freshness, t);
    const token = t.token;
    let job: ResearchCoinData["job"] = null;
    let depth = args.depth;
    if (args.depth === "deep") {
      if (ic.audience !== "owner") {
        depth = "standard";
        a.note("Deep research runs only in a direct conversation; this is the standard read.");
      } else {
        // The job is registered BEFORE anything promises later delivery; a refused job promises nothing.
        const day = new Date(ic.now).toISOString().slice(0, 10);
        try {
          const q = await store.enqueueJob(db, {
            tenant: ic.cc.tenant,
            idempotencyKey: `research-deep:${day}:${sha(`${ic.cc.tenant.toLowerCase()}|${token.key}`).slice(0, 32)}`,
            conversationKey: ic.conversationKey,
            surface: ic.surface,
            kind: DEEP_JOB_KIND,
            params: { tokenKey: token.key, symbol: t.label.symbol, name: t.label.name },
            deadlineMs: ic.now + DEEP_JOB_DEADLINE_MS,
            costAllowanceCredits: DEEP_JOB_CREDIT_ALLOWANCE,
            nowMs: ic.now,
          });
          if (q.ok) job = { id: q.job.id, deadlineMs: q.job.deadlineMs, status: q.job.status, created: q.created };
          else a.note(q.reason === "quota-exceeded" ? "Deeper research could not be scheduled: too many research jobs are already running." : "Deeper research for this coin was already scheduled differently today.");
        } catch (e) {
          log(`fomo: job enqueue failed: ${errText(e)}`);
          a.note("Deeper research could not be scheduled.");
        }
        depth = "quick";
      }
    }
    const r = await refreshCore(ic.cc, a, token, t.label, { depth, mode: args.freshness });
    if (!r.dossier) {
      return finish<ResearchCoinData>(ic, a, {
        cls: "theses",
        mode: args.freshness,
        subject: { kind: "token", token, label: t.label },
        data: null,
        rows: 0,
        essential: [],
        status: r.status === "ok" ? "failed" : r.status,
        reason: r.reason,
      });
    }
    const d = r.dossier;
    if (!r.checked && !r.changed && (r.status === "stale" || r.status === "budget-limited")) {
      // The previous revision stands: its age is the dossier's own build time.
      a.add({ ...localSection("stored-dossier", true, d.builtAt, "stale-cache"), status: "stale" });
      a.note("This is the last stored research; it could not be refreshed now.");
    }
    let changes: ResearchCoinData["changes"] = null;
    if (args.sinceRevision !== null) {
      const base = await store.dossierRevision(db, token.key, args.sinceRevision).catch(() => null);
      const baseline = base ? asDossier(base.dossier, token) : null;
      const scope = d.coverage.windowRequested;
      const cs = changeSummary(
        baseline ? { dossier: baseline, checkedAt: base!.builtAtMs, scope: baseline.coverage.windowRequested } : null,
        { dossier: d, checkedAt: ic.now, scope, succeeded: r.checked },
      );
      changes = { comparable: cs.comparable, noChange: cs.noChange, changes: cs.changes.map((c) => sanitizeText(c, 240)).slice(0, 12), reason: cs.reason, sinceRevision: args.sinceRevision };
      if (!cs.comparable) a.note(cs.reason === "no-baseline" ? `Revision ${args.sinceRevision} is not on record, so no comparison was made.` : `No comparison was made (${cs.reason}).`);
    }
    for (const e of d.evidence.slice(0, 30)) a.addRef(e);
    a.ref("dossier", `${d.dossierId}r${d.revision}`);
    a.pagesRequested = Math.max(a.pagesRequested, d.coverage.pagesRequested);
    a.providerTotal = d.coverage.providerTotal;
    a.duplicatesRemoved = d.coverage.duplicatesRemoved;
    for (const l of d.coverage.limitations.slice(0, 4)) a.note(l);
    for (const m of d.coverage.missingSections) if (m === "theses" || m === "activity" || m === "token-stats") if (!a.missing.includes(m)) a.missing.push(m);
    a.sourceTimes.push(d.coverage.oldestSourceAt, d.coverage.newestSourceAt);
    a.note("This is Merrymen's analysis of third-party claims and observed activity, not permission to trade.");
    a.achieved = { revision: d.revision, depth, uniqueTheses: d.coverage.uniqueTheses, uniqueAuthors: d.coverage.uniqueAuthors };
    const data: ResearchCoinData = {
      token,
      label: cleanLabel(d.label),
      dossierId: d.dossierId,
      revision: d.revision,
      builtAt: d.builtAt,
      focus: args.focus,
      strongestSupport: claimView(d.strongestSupport),
      strongestOpposition: claimView(d.strongestOpposition),
      claims: d.claims.slice(0, 6).map((c) => claimView(c)!),
      flow: d.flow,
      wordsVsActions: d.wordsVsActions.slice(0, 5).map((w) => ({
        userId: w.userId,
        handle: handleOf(w.handle),
        statement: sanitizeText(w.statement, 200),
        action: sanitizeText(w.action, 200),
        evidence: w.evidence.map((e) => e.id).slice(0, 5),
      })),
      unknowns: d.unknowns.slice(0, 6).map((u) => sanitizeText(u, 200)),
      changeConditions: d.changeConditions.slice(0, 5).map((c) => sanitizeText(c, 200)),
      coverage: d.coverage,
      changes,
      job,
      executionAvailability: availabilityOf(token),
    };
    const status: ResultStatus | undefined =
      job !== null ? "partial" : r.status === "budget-limited" ? "budget-limited" : r.status === "stale" ? "stale" : r.status === "partial" ? "partial" : undefined;
    return finish(ic, a, {
      cls: "theses",
      mode: args.freshness,
      subject: { kind: "token", token, label: cleanLabel(d.label.symbol ? d.label : t.label) },
      data,
      rows: d.coverage.uniqueTheses + (d.flow ? (d.flow.distinctBuyers ?? 0) + (d.flow.distinctSellers ?? 0) : 0),
      essential: [],
      status: status ?? (d.coverage.uniqueTheses === 0 && !d.flow ? "empty" : "ok"),
      reason: job !== null ? "deep-research-queued" : r.reason,
      dossierRevision: { dossierId: d.dossierId, revision: d.revision },
    });
  }

  async function toolResearchStatus(ic: Inv, args: ToolArgs["fomo_get_research_status"]): Promise<FomoEnvelope<ResearchStatusData>> {
    const a = new Answer();
    a.requested = { token: args.token?.kind ?? null, requestId: args.requestId !== null };
    const tenant = ic.cc.tenant;
    let token: TokenIdentity | null = null;
    let label: TokenLabel | null = null;
    if (args.token) {
      const t = await resolveToken(ic.cc, a, args.token, args.chain, "cached-ok");
      if (!t.ok) return fromFail(ic, a, "profile", "cached-ok", t);
      token = t.token;
      label = t.label;
    }
    a.add(localSection("owner-state", true, ic.now, "live"));
    const assessment = token ? await store.latestAssessment(db, tenant, token.key).catch(() => null) : null;
    const funnel = token ? await store.funnelForToken(db, tenant, token.key, 10).catch(() => []) : [];
    const watches = await store.activeWatches(db, tenant, ic.now).catch(() => []);
    const jobs = await store.recentJobs(db, tenant, 5).catch(() => []);
    const request = args.requestId ? await store.getRequest(db, tenant, args.requestId).catch(() => null) : null;
    const cohort = await cohortSnapshot(ic.now);
    const health = await healthOf(ic.now);
    const caps: Record<string, number> = {};
    try {
      for (const c of await store.listCapabilities(db)) caps[c.status] = (caps[c.status] ?? 0) + 1;
    } catch {
      // Counts are context only.
    }
    if (assessment) a.ref("assessment", assessment.id);
    if (token && !assessment && funnel.length === 0) a.note("Merrymen has not assessed this coin for you; nothing was skipped because nothing was reviewed.");
    const data: ResearchStatusData = {
      token,
      assessment: assessment
        ? {
            id: assessment.id,
            state: assessment.state,
            reasonCodes: assessment.reasonCodes.slice(0, 10).map((r) => sanitizeText(r, 80)),
            createdAt: assessment.createdAt,
            executionAvailability: assessment.executionAvailability,
            sizeCeilingUsdg6: assessment.sizeCeilingUsdg6,
          }
        : null,
      funnel: funnel.map((f) => ({ stage: f.stage, detail: f.detail ? sanitizeText(f.detail, 200) : null, atMs: f.atMs })),
      watches: watches.map((w) => ({ tokenKey: w.tokenKey, symbol: w.label.symbol ? sanitizeText(w.label.symbol, 24) : null, expiresAtMs: w.expiresAtMs })),
      jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, deadlineMs: j.deadlineMs, createdAtMs: j.createdAtMs, delivered: j.deliveredAtMs !== null })),
      request: request ? { requestId: request.requestId, tool: request.tool, status: request.status, createdAtMs: request.createdAtMs } : null,
      cohort: cohort.size !== null && cohort.version !== null ? { size: cohort.size, version: cohort.version, target: cohort.target, shortfallReason: cohort.shortfallReason } : null,
      health: { state: health.state, detail: health.detail, configured: health.configured, creditsRemaining: health.creditsRemaining },
      capabilities: caps,
    };
    return finish(ic, a, {
      cls: "profile",
      mode: "cached-ok",
      subject: token ? { kind: "token", token, label: label ?? { symbol: null, name: null } } : null,
      data,
      rows: 1,
      essential: [],
      status: "ok",
    });
  }

  async function toolWatch(ic: Inv, args: ToolArgs["fomo_watch_coin"] | ToolArgs["fomo_unwatch_coin"], watch: boolean): Promise<FomoEnvelope<WatchData>> {
    const a = new Answer();
    a.requested = { token: args.token.kind, chain: args.chain, days: "days" in args ? args.days : null };
    const t = await resolveToken(ic.cc, a, args.token, args.chain, "cached-ok");
    if (!t.ok) return fromFail(ic, a, "profile", "cached-ok", t);
    a.add(localSection("owner-state", true, ic.now, "live"));
    const subject: ResolvedSubject = { kind: "token", token: t.token, label: t.label };
    const tenant = ic.cc.tenant;
    if (watch) {
      const days = "days" in args ? args.days : 7;
      const r = await store.addWatch(db, { tenant, tokenKey: t.token.key, label: t.label, nowMs: ic.now, expiresAtMs: ic.now + days * DAY, createdVia: ic.surface });
      const active = (await store.activeWatches(db, tenant, ic.now).catch(() => [])).length;
      if (!r.ok) {
        return finish(ic, a, {
          cls: "profile",
          mode: "cached-ok",
          subject,
          data: { action: "watch", token: t.token, label: t.label, created: false, removed: null, expiresAtMs: null, activeWatches: active },
          rows: 0,
          essential: [],
          status: "failed",
          reason: r.reason === "cap-reached" ? "watch-cap-reached" : r.reason,
          message: r.reason === "cap-reached" ? "You are already watching the most coins allowed; stop watching one first." : "That watch length is not allowed.",
        });
      }
      return finish(ic, a, {
        cls: "profile",
        mode: "cached-ok",
        subject,
        data: { action: "watch", token: t.token, label: t.label, created: r.created, removed: null, expiresAtMs: r.watch.expiresAtMs, activeWatches: active },
        rows: 1,
        essential: [],
        status: "ok",
      });
    }
    const removed = await store.removeWatch(db, tenant, t.token.key);
    const active = (await store.activeWatches(db, tenant, ic.now).catch(() => [])).length;
    return finish(ic, a, {
      cls: "profile",
      mode: "cached-ok",
      subject,
      data: { action: "unwatch", token: t.token, label: t.label, created: null, removed, expiresAtMs: null, activeWatches: active },
      rows: removed ? 1 : 0,
      essential: [],
      status: removed ? "ok" : "empty",
      message: removed ? null : "You were not watching that coin.",
    });
  }

  // ── Health ──────────────────────────────────────────────────────────

  async function healthOf(now: number): Promise<FomoServiceHealth> {
    const creditsRemaining = usage?.snapshot().lastCreditsRemaining?.value ?? null;
    const budgetLimited = lastBudgetRefusalAt !== null && now - lastBudgetRefusalAt >= 0 && now - lastBudgetRefusalAt < 15 * MIN;
    const base = { configured: client !== null, lastProviderOkAt, lastProviderFailure: lastProviderFailure ? { at: lastProviderFailure.at, reason: lastProviderFailure.reason } : null, creditsRemaining, budgetLimited };
    if (!client) return { ...base, state: "not-configured", detail: "Fomo data is not configured on this install (no provider key is set)." };
    if (lastProviderFailure?.down && (lastProviderOkAt === null || lastProviderFailure.at > lastProviderOkAt)) {
      return { ...base, state: "provider-unavailable", detail: `The Fomo data provider is not answering (${lastProviderFailure.reason}); answers use stored copies where they exist.` };
    }
    if (budgetLimited) return { ...base, state: "budget-limited", detail: "Fomo research is being rationed: the retrieval budget refused a read in the last 15 minutes." };
    if ((lastProviderOkAt !== null && now - lastProviderOkAt <= 15 * MIN) || (await streamCurrent(now))) {
      return { ...base, state: "receiving-fresh-data", detail: "Fomo data is arriving normally." };
    }
    return { ...base, state: "research-only", detail: "Fomo is configured; nothing has been read from it recently." };
  }

  // ── The dispatcher ──────────────────────────────────────────────────

  async function invoke(ctx: FomoCallContext, tool: FomoToolName, args: Record<string, unknown>): Promise<FomoEnvelope> {
    const now = finite(ctx?.now) ? ctx.now : clock();
    const requestId = typeof ctx?.requestId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(ctx.requestId) ? ctx.requestId : `fr_${sha(`${now}:${Math.random()}`).slice(0, 24)}`;
    const surface: FomoSurface = ctx?.surface ?? "background";
    const audience = ctx?.audience === "owner" ? "owner" : "group";
    const tenant = typeof ctx?.tenant === "string" ? ctx.tenant.trim() : "";
    const groupId = typeof (ctx as FomoInvokeContext)?.groupId === "string" ? (ctx as FomoInvokeContext).groupId! : null;
    const ic: Inv = {
      tool,
      requestId,
      now,
      audience,
      surface,
      conversationKey: ctx?.conversationKey ?? null,
      // One owner is one budget: the store lowercases tenants, so the budget keys must too.
      cc: { tenant: store.tenantKey(tenant), surface, priority: ctx?.priority ?? "interactive", groupId, now, signal: ctx?.signal, cap: null },
    };
    if (!isFomoToolName(tool)) return bare({ ...ic, tool: "fomo_resolve_subject" }, "failed", "unknown-tool", "That is not a Fomo research tool.");
    if (!tenant) return bare(ic, "failed", "no-tenant", "The request carried no trusted account.");

    // 1. Permission FIRST: no cache read and no provider call for an owner who switched Fomo off.
    let access: FomoAccess | null = null;
    try {
      access = await deps.access(tenant);
    } catch (e) {
      log(`fomo: access check failed: ${errText(e)}`);
    }
    const audit = async (status: ResultStatus, meta: Record<string, unknown>): Promise<void> => {
      try {
        await store.completeRequest(db, tenant, requestId, status, clock(), meta);
      } catch (e) {
        log(`fomo: request log failed: ${errText(e)}`);
      }
    };
    try {
      await store.logRequest(db, { requestId, tenant, surface, tool, nowMs: now, meta: { audience, priority: ic.cc.priority } });
    } catch (e) {
      log(`fomo: request log failed: ${errText(e)}`);
    }
    if (!access || access.dataAccess !== true) {
      const env = bare(ic, "not-authorized", "data-access-off");
      await audit(env.status, { reason: env.reason });
      return env;
    }
    // 2. Audience: private state and mutations belong to the owner, in a direct conversation.
    const def = FOMO_TOOL_DEFS[tool];
    if ((def.ownerOnly || isMutationTool(tool)) && audience !== "owner") {
      const env = bare(ic, "not-authorized", "owner-only");
      await audit(env.status, { reason: env.reason });
      return env;
    }
    // 3. Arguments, against the tool's own validator.
    const v = def.validate(args);
    if (!v.ok) {
      const env = bare(ic, "failed", "invalid-args", `That request could not be read as a Fomo lookup (${v.reason}).`);
      await audit(env.status, { reason: env.reason, detail: v.reason });
      return env;
    }
    let env: FomoEnvelope;
    try {
      env = await dispatch(ic, tool, v.args);
    } catch (e) {
      log(`fomo: ${tool} failed: ${errText(e)}`);
      env = bare(ic, "failed", "internal-error");
    }
    const subjectKey = env.subject?.kind === "token" ? env.subject.token.key : env.subject?.kind === "trader" ? env.subject.trader.userId : null;
    await audit(env.status, { reason: env.reason, subjectKey, providerCalls: env.usage.providerCalls, cacheHits: env.usage.cacheHits, credits: env.usage.creditsCharged });
    return env;
  }

  async function dispatch(ic: Inv, tool: FomoToolName, args: unknown): Promise<FomoEnvelope> {
    switch (tool) {
      case "fomo_resolve_subject":
        return toolResolve(ic, args as ToolArgs[typeof tool]);
      case "fomo_get_trader_context":
        return toolTraderContext(ic, args as ToolArgs[typeof tool]);
      case "fomo_get_trader_activity":
        return toolTraderActivity(ic, args as ToolArgs[typeof tool]);
      case "fomo_get_token_theses":
        return toolTokenTheses(ic, args as ToolArgs[typeof tool]);
      case "fomo_get_token_activity":
        return toolTokenActivity(ic, args as ToolArgs[typeof tool]);
      case "fomo_get_rankings":
        return toolRankings(ic, args as ToolArgs[typeof tool]);
      case "fomo_find_opportunities":
        return toolOpportunities(ic, args as ToolArgs[typeof tool]);
      case "fomo_research_coin":
        return toolResearchCoin(ic, args as ToolArgs[typeof tool]);
      case "fomo_get_research_status":
        return toolResearchStatus(ic, args as ToolArgs[typeof tool]);
      case "fomo_watch_coin":
        return toolWatch(ic, args as ToolArgs[typeof tool], true);
      case "fomo_unwatch_coin":
        return toolWatch(ic, args as ToolArgs[typeof tool], false);
    }
  }

  async function refreshDossierAs(
    payer: ChargeAs,
    token: TokenIdentity,
    label: TokenLabel,
    opts: { depth: "quick" | "standard" | "deep"; now: number; signal?: AbortSignal; creditCap?: number | null; mode?: FreshnessMode },
    payWith: FomoBudget = budget,
  ): Promise<RefreshOutcome> {
    const now = finite(opts.now) ? opts.now : clock();
    const cc: ChargeContext = {
      budget: payWith,
      tenant: store.tenantKey(payer.tenant),
      surface: payer.surface,
      priority: payer.priority,
      groupId: payer.groupId ?? null,
      now,
      signal: opts.signal,
      cap: opts.creditCap !== undefined && opts.creditCap !== null ? { limit: opts.creditCap, spent: 0 } : null,
    };
    try {
      return await refreshCore(cc, new Answer(), token, label, { depth: opts.depth, mode: opts.mode ?? "prefer-fresh" });
    } catch (e) {
      log(`fomo: dossier refresh failed: ${errText(e)}`);
      return { dossier: null, changed: false, status: "failed", reason: "internal-error", checked: false, usage: { providerCalls: 0, cacheHits: 0, creditsCharged: 0 }, notes: [] };
    }
  }

  const service: FomoServiceExt = {
    invoke,
    usage,

    async memoryGet(tenant, conversationKey) {
      try {
        return (await store.getSubject(db, tenant, conversationKey))?.json ?? null;
      } catch (e) {
        log(`fomo: memory read failed: ${errText(e)}`);
        return null;
      }
    },
    async memorySet(tenant, conversationKey, json, nowMs) {
      try {
        await store.setSubject(db, tenant, conversationKey, json, nowMs);
      } catch (e) {
        log(`fomo: memory write failed: ${errText(e)}`);
      }
    },
    async memoryClear(tenant, conversationKey) {
      try {
        await store.clearSubject(db, tenant, conversationKey);
      } catch (e) {
        log(`fomo: memory clear failed: ${errText(e)}`);
      }
    },

    async report(tenant: string, r: BrokerReport, nowMs: number): Promise<void> {
      // The tenant is STAMPED by the receiving process; a report can only ever be about the reporter's own book.
      const t = store.tenantKey(tenant);
      if (!t || !r || typeof r !== "object") return;
      try {
        switch (r.kind) {
          case "assessment":
            if (store.tenantKey(r.assessment?.tenant) !== t) {
              log("fomo: refused an assessment whose tenant differs from the reporting tenant");
              return;
            }
            await store.insertAssessment(db, r.assessment);
            return;
          case "funnel":
            await store.insertFunnel(db, { tenant: t, tokenKey: r.tokenKey, stage: r.stage, detail: r.detail, decisionId: r.decisionId, atMs: r.atMs });
            return;
          case "position-dependency":
            await store.addPositionDep(db, { tenant: t, userId: r.userId, tokenKey: r.tokenKey, reason: r.reason, nowMs, expiresAtMs: r.expiresAtMs });
            return;
          case "outcome":
            await store.upsertOutcome(db, { tenant: t, assessmentId: r.assessmentId, horizonLabel: r.horizonLabel, observedAtMs: r.observedAtMs, price8: r.price8, note: r.note });
            return;
          case "held-tokens": {
            const keys = Array.isArray(r.tokenKeys) ? [...new Set(r.tokenKeys.filter((k) => typeof k === "string" && tokenFromKey(k)?.key === k))].slice(0, 200) : [];
            held.set(t, { keys, at: finite(r.atMs) ? Math.min(r.atMs, nowMs) : nowMs });
            return;
          }
          default:
            return;
        }
      } catch (e) {
        log(`fomo: report ${String((r as { kind?: unknown }).kind)} not stored: ${errText(e)}`);
      }
    },

    configured() {
      return client !== null;
    },

    async refreshDossier(token, label, opts) {
      // Shared research is charged to the pool through the background budget, never to an owner.
      const r = await refreshDossierAs(
        { tenant: SHARED_RESEARCH_TENANT, surface: "background", priority: opts.priority },
        token,
        label,
        { depth: opts.depth, now: opts.now, signal: opts.signal },
        deps.backgroundBudget ?? budget,
      );
      return { dossier: r.dossier, changed: r.changed, status: r.status, reason: r.reason };
    },

    refreshDossierAs: (payer, token, label, opts) => refreshDossierAs(payer, token, label, opts),

    health(now) {
      return healthOf(finite(now) ? now : clock());
    },

    heldTokensSnapshot(now?: number) {
      const at = finite(now) ? now : clock();
      const out = new Map<string, string[]>();
      for (const [tenant, h] of held) {
        if (at - h.at > HELD_TTL_MS) continue;
        for (const k of h.keys) {
          const list = out.get(k) ?? [];
          list.push(tenant);
          out.set(k, list);
        }
      }
      for (const list of out.values()) list.sort();
      return out;
    },
  };
  return service;
}

// ── Background research jobs ─────────────────────────────────────────────

/**
 * Claim and run queued deep-research jobs. Each runs a deep dossier refresh
 * charged to the owner who asked, inside the job's own credit allowance and
 * deadline, and finishes FENCED on the attempt it claimed. Delivery is left to
 * the surfaces (store.jobsAwaitingDelivery / markJobDelivered), which know
 * where the owner is.
 */
export async function runPendingJobs(
  service: FomoServiceExt,
  db: Db,
  opts: { now?: () => number; limit?: number; leaseMs?: number; log?: (line: string) => void } = {},
): Promise<{ claimed: number; done: number; failed: number }> {
  const now = opts.now ?? Date.now;
  const limit = Math.max(1, Math.min(20, Math.floor(opts.limit ?? 3)));
  const leaseMs = Math.max(30_000, Math.floor(opts.leaseMs ?? DEEP_JOB_DEADLINE_MS + MIN));
  const log = opts.log ?? (() => {});
  const out = { claimed: 0, done: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    let job: store.ClaimedFomoJob | null;
    try {
      job = await store.claimJob(db, now(), leaseMs);
    } catch (e) {
      log(`fomo: job claim failed: ${errText(e)}`);
      break;
    }
    if (!job) break;
    out.claimed++;
    const finishWith = async (status: "done" | "failed", result: unknown): Promise<void> => {
      const ok = await store.finishJob(db, job!, { status, result }).catch(() => false);
      if (!ok) log(`fomo: job ${job!.id} was no longer ours to finish`);
      if (status === "done") out.done++;
      else out.failed++;
    };
    const p = isObj(job.params) ? job.params : {};
    const token = typeof p.tokenKey === "string" ? tokenFromKey(p.tokenKey) : null;
    if (job.kind !== DEEP_JOB_KIND || !token) {
      await finishWith("failed", { reason: "bad-job" });
      continue;
    }
    const started = now();
    if (started >= job.deadlineMs) {
      await finishWith("failed", { reason: "deadline" });
      continue;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("job deadline")), Math.max(1, job.deadlineMs - started));
    (timer as { unref?: () => void }).unref?.();
    try {
      const label: TokenLabel = {
        symbol: typeof p.symbol === "string" ? sanitizeText(p.symbol, 24) || null : null,
        name: typeof p.name === "string" ? sanitizeText(p.name, 64) || null : null,
      };
      const r = await service.refreshDossierAs({ tenant: job.tenant, surface: job.surface, priority: "interactive" }, token, label, {
        depth: "deep",
        now: started,
        signal: ac.signal,
        creditCap: job.costAllowanceCredits ?? DEEP_JOB_CREDIT_ALLOWANCE,
      });
      const result = {
        tokenKey: token.key,
        dossierId: r.dossier?.dossierId ?? null,
        revision: r.dossier?.revision ?? null,
        changed: r.changed,
        status: r.status,
        reason: r.reason,
        credits: r.usage.creditsCharged,
      };
      // "Done" means the deeper read happened; a refused budget or a failed read is reported as such, with the reason.
      const deeper = r.dossier !== null && (r.status === "ok" || r.status === "partial" || r.status === "stale");
      await finishWith(deeper ? "done" : "failed", deeper ? result : { ...result, reason: r.reason ?? r.status });
    } catch (e) {
      log(`fomo: job ${job.id} failed: ${errText(e)}`);
      await finishWith("failed", { reason: "internal-error" });
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}
