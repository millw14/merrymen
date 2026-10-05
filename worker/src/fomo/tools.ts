/**
 * THE REGISTERED FOMO TOOLS — names, model-facing descriptions, JSON Schemas
 * and the validators the service runs on EVERY call, whoever made it.
 *
 * WHY A HAND-WRITTEN VALIDATOR PER TOOL. Arguments arrive from three kinds of
 * caller: the deterministic planner (intent.ts), a model in a tool loop, and
 * an IPC peer. None of them is trusted to name a tenant, a credential, a host,
 * a path or a URL, and none of them may widen a read beyond the tool's own
 * bounds. So each validator:
 *
 *   - refuses a non-object, and any key the tool does not declare (a `tenant`
 *     key is simply an unknown key, refused like any other);
 *   - accepts each value only in one closed shape: an EVM address, a Solana
 *     mint, an UPPERCASE ticker, a provider user id, a plain handle, a chain
 *     slug identity.ts knows, an enum member, a bounded integer;
 *   - refuses control characters, and with them anything URL-, host- or
 *     path-shaped, because no declared shape admits `:`, `/` or `.`;
 *   - fills defaults so the service never guesses at a missing value.
 *
 * The argument names follow intent.ts PLAN_ARG_KEYS exactly (plus `query`,
 * `kind`, `request_id`, `days` and `max_market_cap_usd`, which only these
 * tools take), so a plan always validates.
 *
 * MUTATIONS ARE A SEPARATE REGISTRY. `fomo_watch_coin` and `fomo_unwatch_coin`
 * write the owner's state; `toolSpecs` never offers them to a model loop, and
 * the service refuses them for any audience but the owner.
 */

import type { ToolSpec } from "../llm";
import { chainFromUserText, IDENTITY_GUARDS } from "./identity";
import type {
  ChainIdentity,
  CoinDossier,
  DossierCoverage,
  EvidenceRef,
  ExecutionAvailability,
  FlowSummary,
  FomoMutationToolName,
  FomoReadToolName,
  FomoToolName,
  FreshnessClass,
  FreshnessMode,
  FunnelStage,
  RankingWindow,
  ResearchState,
  StatsWindow,
  TokenIdentity,
  TokenLabel,
  TraderIdentity,
} from "./types";

// ── Shapes ────────────────────────────────────────────────────────────────

const { EVM_ADDRESS, SOLANA_MINT } = IDENTITY_GUARDS;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** A Fomo handle as intent.ts emits it: no dots, so a host name can never pass as one. */
const HANDLE = /^[A-Za-z0-9_]{1,30}$/;
/** A ticker. No dots or slashes either. */
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;
const SLUG = /^[a-z][a-z0-9-]{0,23}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
// Any C0/C1 control, DEL, zero-width or bidi override.
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;

export const TOOL_WINDOWS = ["1h", "24h", "7d", "30d", "all"] as const;
export type ToolWindow = (typeof TOOL_WINDOWS)[number];
export const RANKING_WINDOWS: readonly RankingWindow[] = ["24h", "7d", "30d", "all"];
export const FRESHNESS_MODES: readonly FreshnessMode[] = ["cached-ok", "prefer-fresh", "force-refresh"];
export const DEPTHS = ["quick", "standard", "deep"] as const;
export type Depth = (typeof DEPTHS)[number];
export const BOARDS = ["traders", "trending-tokens", "graduated-tokens", "most-held-tokens"] as const;
export type Board = (typeof BOARDS)[number];

/** Per-tool row limits: the most any one answer will carry. */
export const TOOL_LIMITS = {
  activity: { max: 50, default: 20 },
  theses: { max: 50, default: 25 },
  tokenActivity: { max: 50, default: 25 },
  rankings: { max: 50, default: 10 },
  opportunities: { max: 25, default: 10 },
  watchDays: { min: 1, max: 30, default: 7 },
} as const;

export const READ_TOOL_NAMES: readonly FomoReadToolName[] = [
  "fomo_resolve_subject",
  "fomo_get_trader_context",
  "fomo_get_trader_activity",
  "fomo_get_token_theses",
  "fomo_get_token_activity",
  "fomo_get_rankings",
  "fomo_find_opportunities",
  "fomo_research_coin",
  "fomo_get_research_status",
];
export const MUTATION_TOOL_NAMES: readonly FomoMutationToolName[] = ["fomo_watch_coin", "fomo_unwatch_coin"];
export const TOOL_NAMES: readonly FomoToolName[] = [...READ_TOOL_NAMES, ...MUTATION_TOOL_NAMES];

export function isFomoToolName(v: unknown): v is FomoToolName {
  return typeof v === "string" && (TOOL_NAMES as readonly string[]).includes(v);
}

export function isMutationTool(v: FomoToolName): v is FomoMutationToolName {
  return (MUTATION_TOOL_NAMES as readonly string[]).includes(v);
}

// ── Typed arguments ───────────────────────────────────────────────────────

/** A coin reference: an address (EVM lowercased, mint as typed) or an UPPERCASE ticker. */
export interface TokenRef {
  kind: "address" | "symbol";
  value: string;
}

/** A trader reference: a provider user id (lowercased) or a handle without `@`. */
export interface TraderRef {
  kind: "user-id" | "handle";
  value: string;
}

export interface ResolveArgs {
  query: TokenRef | TraderRef;
  kind: "any" | "trader" | "token";
  chain: string | null;
}
export interface TraderContextArgs {
  trader: TraderRef;
  /** Which provider P&L window to show; "1h" is accepted and answered with the shortest window the provider has (24h), said so. */
  window: ToolWindow | null;
  focus: "holdings" | null;
  depth: Depth;
  freshness: FreshnessMode;
}
export interface TraderActivityArgs {
  trader: TraderRef;
  token: TokenRef | null;
  chain: string | null;
  side: "buy" | "sell" | null;
  window: ToolWindow;
  limit: number;
  freshness: FreshnessMode;
}
export interface TokenThesesArgs {
  token: TokenRef | null;
  chain: string | null;
  trader: TraderRef | null;
  window: ToolWindow | null;
  limit: number;
  depth: Depth;
  freshness: FreshnessMode;
}
export interface TokenActivityArgs {
  token: TokenRef | null;
  chain: string | null;
  side: "buy" | "sell" | null;
  window: ToolWindow;
  cohortOnly: boolean;
  limit: number;
  freshness: FreshnessMode;
}
export interface RankingsArgs {
  board: Board;
  window: RankingWindow;
  chain: string | null;
  limit: number;
  cohortOnly: boolean;
  freshness: FreshnessMode;
}
export interface OpportunitiesArgs {
  chain: string | null;
  window: ToolWindow;
  limit: number;
  cohortOnly: boolean;
  maxMarketCapUsd: number | null;
  freshness: FreshnessMode;
}
export interface ResearchCoinArgs {
  token: TokenRef;
  chain: string | null;
  depth: Depth;
  focus: "words-vs-actions" | null;
  sinceRevision: number | null;
  window: ToolWindow;
  freshness: FreshnessMode;
}
export interface ResearchStatusArgs {
  token: TokenRef | null;
  chain: string | null;
  requestId: string | null;
}
export interface WatchArgs {
  token: TokenRef;
  chain: string | null;
  days: number;
}
export interface UnwatchArgs {
  token: TokenRef;
  chain: string | null;
}

export interface ToolArgs {
  fomo_resolve_subject: ResolveArgs;
  fomo_get_trader_context: TraderContextArgs;
  fomo_get_trader_activity: TraderActivityArgs;
  fomo_get_token_theses: TokenThesesArgs;
  fomo_get_token_activity: TokenActivityArgs;
  fomo_get_rankings: RankingsArgs;
  fomo_find_opportunities: OpportunitiesArgs;
  fomo_research_coin: ResearchCoinArgs;
  fomo_get_research_status: ResearchStatusArgs;
  fomo_watch_coin: WatchArgs;
  fomo_unwatch_coin: UnwatchArgs;
}

export type ValidateResult<A> = { ok: true; args: A } | { ok: false; reason: string };

export interface FomoToolDef<A> {
  /** Model-facing, short and honest about what the data is. */
  description: string;
  /** JSON Schema, `additionalProperties: false`, every property typed and bounded. */
  schema: Record<string, unknown>;
  /** The freshness class of the tool's primary read; null for the owner's own state. */
  freshness: FreshnessClass | null;
  mutation: boolean;
  ownerOnly: boolean;
  validate(raw: unknown): ValidateResult<A>;
}

// ── Per-tool data payloads (FomoEnvelope.data) ───────────────────────────

/** A display view of one event. Fill size, position mark and cumulative P&L stay separate fields. */
export interface ActivityEventView {
  evidenceId: string;
  kind: string;
  trader: { userId: string; handle: string | null };
  token: TokenIdentity | null;
  label: TokenLabel;
  /** Exact on-chain fill in USD; null means the size of this trade is unknown. */
  fillUsd: number | null;
  /** The position's mark after the event. Never a fill amount. */
  positionValueUsd: number | null;
  /** The position's cumulative realised P&L at this event. Never summed. */
  positionRealizedPnlUsdCumulative: number | null;
  at: number | null;
  verification: string;
  source: "stream-record" | "rest-lookup";
  inCohort: boolean | null;
}

export interface ResolveData {
  kind: "token" | "trader";
  /** How the match was made: exact-address, exact-symbol, user-id, local-handle, search-handle… */
  match: string;
  /** The handle typed is one this trader used before, not the current one. */
  formerHandle: boolean;
  /** Tokens: whether Merrymen could act at all (research is always available). */
  executionAvailability: ExecutionAvailability | null;
  /** Provider-reported market cap; null is unknown, never zero. */
  marketCapUsd: number | null;
}

export interface HoldingView {
  token: TokenIdentity | null;
  symbol: string | null;
  chain: string | null;
  amount: number | null;
  priceUsd: number | null;
  /** Valued at current prices: a rise here can be price, not accumulation. */
  valueUsd: number | null;
  change24hPct: number | null;
  /** The row is on Robinhood Chain by the network id the provider returned. */
  robinhood: boolean;
}

export interface TraderContextData {
  trader: TraderIdentity;
  formerHandle: boolean;
  focus: "holdings" | "context";
  holdings: {
    rows: HoldingView[];
    rowsTotal: number;
    truncated: boolean;
    /** Sum of the rows served; a FLOOR when truncated; excludes perps and other equity. */
    totalValueUsdFloor: number | null;
    complete: boolean | null;
    dropped: number;
    /** Per chain: the sum of rows with a value (null when none has one) and how many rows have no value (unpriced). */
    byChain: { chain: string; rows: number; valueUsd: number | null; unpricedRows: number }[];
  } | null;
  cohort: { member: boolean; followable: boolean | null; version: number | null; size: number | null } | null;
  profile: {
    /** Where the figures came from; none of them is a skill measure. */
    source: "cohort-evidence" | "leaderboard" | "search" | "profile-read";
    /**
     * When the figures were read; null when unknown. A windowed P&L describes
     * the window ending THEN, so it is shown with this time, and a figure
     * older than its own window is left out (a 24h figure from five days ago
     * describes a different day).
     */
    asOf: number | null;
    /** True when asOf is only an upper bound (cohort evidence can be carried from an earlier refresh). */
    mayBeOlder: boolean;
    pnlUsd: Partial<Record<RankingWindow, number | null>>;
    volumeUsd: number | null;
    trades: number | null;
    accountAgeDays: number | null;
    averageHoldTimeSeconds: number | null;
  } | null;
}

export interface PositionView {
  tradeId: string | null;
  token: TokenIdentity | null;
  label: TokenLabel;
  status: "open" | "closed" | null;
  costBasisUsd: number | null;
  /** Position-level cumulative realised P&L, not a per-fill figure. */
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  boughtAmount: number | null;
  soldAmount: number | null;
  transferredInAmount: number | null;
  transferredOutAmount: number | null;
  openedAt: number | null;
  closedAt: number | null;
  source: "captured" | "feed" | "unknown";
}

export interface FillView {
  swapId: string | null;
  /** buy/sell relative to the asked-about token; "swap" when no token was named. */
  side: "buy" | "sell" | "swap";
  token: TokenIdentity | null;
  tokenAmount: number | null;
  /** The fill's own USD amount (provider-reported). */
  usd: number | null;
  at: number | null;
}

export interface TraderActivityData {
  trader: TraderIdentity;
  token: TokenIdentity | null;
  window: ToolWindow;
  side: "buy" | "sell" | null;
  /** Reads used: positions always, the feed always, fills only when a coin was named. */
  sources: string[];
  positions: PositionView[];
  fills: FillView[];
  events: ActivityEventView[];
  counts: { buys: number; sells: number; transfers: number; other: number };
}

export interface ThesisView {
  evidenceId: string;
  author: { userId: string; handle: string | null };
  token: TokenIdentity | null;
  postedAt: number | null;
  /** Merrymen's lexicon reading of the text; not the author's label. */
  stance: "supporting" | "opposing" | "neutral";
  /** THEIR words: sanitised, links and addresses redacted, at most 280 characters. */
  excerpt: string;
  likes: number | null;
  isDev: boolean | null;
  family: string;
}

export interface TokenThesesData {
  token: TokenIdentity | null;
  label: TokenLabel | null;
  trader: TraderIdentity | null;
  theses: ThesisView[];
  stance: { supporting: number; opposing: number; neutral: number };
  families: number;
  uniqueAuthors: number;
  chainFilterHonoured: boolean | null;
}

export interface CohortActor {
  userId: string;
  handle: string | null;
  latestAction: "buy" | "sell";
  at: number | null;
}

export interface TokenActivityData {
  token: TokenIdentity | null;
  label: TokenLabel | null;
  window: ToolWindow;
  side: "buy" | "sell" | null;
  cohortOnly: boolean;
  events: ActivityEventView[];
  /** Distinct observed buyers/sellers in the window (wallets are not proven people). */
  distinctBuyers: number | null;
  distinctSellers: number | null;
  cohort: { buyers: CohortActor[]; sellers: CohortActor[]; version: number | null; size: number | null } | null;
  breadth: { distinctBuyers: number; buyEvents: number; repeatAdds: number; reading: string; notes: string[] } | null;
  stats: { holders: number | null; top10HoldersPercent: number | null; window24h: StatsWindow | null; window1h: StatsWindow | null } | null;
  localEvents: number;
  restEvents: number;
}

export interface RankingTraderRow {
  rank: number | null;
  trader: TraderIdentity;
  /** Provider-reported realised P&L in the window. Not skill. */
  pnlUsd: number | null;
  volumeUsd: number | null;
  trades: number | null;
  inCohort: boolean | null;
}

export interface RankingTokenRow {
  rank: number | null;
  token: TokenIdentity | null;
  label: TokenLabel;
  holders: number | null;
  priceUsd: number | null;
  change24hPct: number | null;
  /** Null is unknown, never zero. */
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  executionAvailability: ExecutionAvailability;
}

export interface RankingsData {
  board: Board;
  window: RankingWindow | null;
  basis: string;
  traders: RankingTraderRow[];
  tokens: RankingTokenRow[];
}

export interface OpportunityRow {
  token: TokenIdentity;
  label: TokenLabel;
  marketCapUsd: number | null;
  marketCapKnown: boolean;
  signals: {
    cohortBuyers: number;
    distinctBuyers: number;
    latestBuyAt: number | null;
    /**
     * The cohort's first appearance on this coin falls in the window. Null
     * when that cannot be judged: the record before the window was not read
     * in full (older than retention, a trader's read hit its limit, or the
     * read failed). Only true scores.
     */
    firstSeenInWindow: boolean | null;
    newThesis: boolean;
    boards: string[];
  };
  /** Early-signal score: evidence of fresh attention, never size or popularity. */
  score: number;
  executionAvailability: ExecutionAvailability;
  routeNote: string | null;
  evidence: string[];
}

export interface OpportunitiesData {
  window: ToolWindow;
  ranking: string;
  rows: OpportunityRow[];
  filteredByMarketCap: number;
}

export interface ClaimView {
  claimKey: string;
  stance: "supporting" | "opposing" | "neutral";
  /** Merrymen's paraphrase. */
  summary: string;
  support: string;
  familyCount: number;
  authorCount: number;
  /** Third-party words, for humans only. */
  quoted: { text: string; evidenceId: string } | null;
}

export interface ResearchCoinData {
  token: TokenIdentity;
  label: TokenLabel;
  dossierId: string;
  revision: number;
  builtAt: number;
  focus: "words-vs-actions" | null;
  strongestSupport: ClaimView | null;
  strongestOpposition: ClaimView | null;
  claims: ClaimView[];
  flow: FlowSummary | null;
  wordsVsActions: { userId: string; handle: string | null; statement: string; action: string; evidence: string[] }[];
  unknowns: string[];
  changeConditions: string[];
  coverage: DossierCoverage;
  changes: { comparable: boolean; noChange: boolean; changes: string[]; reason: string; sinceRevision: number } | null;
  /** A deep read registered as a bounded job, BEFORE anything promised later delivery. */
  job: { id: string; deadlineMs: number; status: string; created: boolean } | null;
  executionAvailability: ExecutionAvailability;
}

export interface ResearchStatusData {
  token: TokenIdentity | null;
  assessment: {
    id: string;
    state: ResearchState;
    reasonCodes: string[];
    createdAt: number;
    executionAvailability: ExecutionAvailability;
    sizeCeilingUsdg6: string | null;
  } | null;
  funnel: { stage: FunnelStage; detail: string | null; atMs: number }[];
  watches: { tokenKey: string; symbol: string | null; expiresAtMs: number }[];
  /**
   * The owner's recent research jobs. `status` is the stored status, except
   * that a job still queued or running past its deadline reads "expired":
   * nothing will finish it, so it is never shown as in progress.
   */
  jobs: { id: string; kind: string; status: string; deadlineMs: number; createdAtMs: number; delivered: boolean }[];
  request: { requestId: string; tool: string; status: string; createdAtMs: number } | null;
  cohort: { size: number; version: number; target: number; shortfallReason: string | null } | null;
  /** The OWNER's health: their switches, the shared feed's freshness and gaps, the provider, and the budget (theirs and the fleet's). */
  health: { state: string; detail: string; configured: boolean; creditsRemaining: number | null };
  /** Provider capabilities by status: the documented baseline with every observation folded in. */
  capabilities: Record<string, number>;
  /** Capabilities Merrymen uses that no call has verified yet (still only documented). Absent from older producers. */
  capabilitiesUnverified?: string[];
  /** Capabilities Merrymen uses that the provider refused or could not serve when last called. */
  capabilitiesDown?: string[];
}

export interface WatchData {
  action: "watch" | "unwatch";
  token: TokenIdentity;
  label: TokenLabel;
  created: boolean | null;
  removed: boolean | null;
  expiresAtMs: number | null;
  activeWatches: number;
}

/** Re-exported so renderers need only this module for the payload contract. */
export type { CoinDossier, EvidenceRef, ChainIdentity };

// ── Field validators ──────────────────────────────────────────────────────

type Field<T> = { ok: true; value: T } | { ok: false; reason: string };
const okv = <T>(value: T): Field<T> => ({ ok: true, value });
const bad = <T>(reason: string): Field<T> => ({ ok: false, reason });

function str(v: unknown, name: string, max: number): Field<string> {
  if (typeof v !== "string") return bad(`${name}-not-a-string`);
  const t = v.trim();
  if (!t || t.length > max) return bad(`${name}-length`);
  if (CONTROL.test(v)) return bad(`${name}-control-characters`);
  return okv(t);
}

/** A coin: an address (EVM lowercased, mint case kept) or a ticker (UPPERCASED, `$` dropped). */
export function parseTokenRef(v: unknown): TokenRef | null {
  const s = str(v, "token", 64);
  if (!s.ok) return null;
  const t = s.value;
  if (EVM_ADDRESS.test(t)) return { kind: "address", value: t.toLowerCase() };
  if (SOLANA_MINT.test(t)) return { kind: "address", value: t };
  const sym = t.replace(/^\$/, "");
  if (SYMBOL.test(sym)) return { kind: "symbol", value: sym.toUpperCase() };
  return null;
}

/** A trader: a provider user id (lowercased) or a handle (`@` dropped). */
export function parseTraderRef(v: unknown): TraderRef | null {
  const s = str(v, "trader", 64);
  if (!s.ok) return null;
  const t = s.value;
  if (UUID.test(t)) return { kind: "user-id", value: t.toLowerCase() };
  const h = t.replace(/^@/, "");
  if (HANDLE.test(h)) return { kind: "handle", value: h };
  return null;
}

/** A chain slug identity.ts recognises, returned in its canonical spelling. */
export function parseChain(v: unknown): string | null {
  const s = str(v, "chain", 24);
  if (!s.ok) return null;
  const t = s.value.toLowerCase();
  if (!SLUG.test(t)) return null;
  const c: ChainIdentity | null = chainFromUserText(t);
  return c?.slug ?? null;
}

function oneOf<T extends string>(v: unknown, set: readonly T[]): T | null {
  return typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : null;
}

function intIn(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : null;
}

/**
 * The shared skeleton: a plain object, only declared keys, each through its
 * own parser. Returns the first refusal reason so a caller learns what to fix
 * without being told anything about our internals.
 */
function checkObject(raw: unknown, allowed: readonly string[]): { ok: true; obj: Record<string, unknown> } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, obj: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "arguments-not-an-object" };
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return { ok: false, reason: "arguments-not-a-plain-object" };
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) return { ok: false, reason: `unknown-argument:${k.replace(/[^A-Za-z0-9_-]/g, "?").slice(0, 32)}` };
  }
  return { ok: true, obj };
}

type Parsed<A> = ValidateResult<A>;

function freshnessOf(v: unknown): Field<FreshnessMode> {
  if (v === undefined) return okv("prefer-fresh");
  const m = oneOf(v, FRESHNESS_MODES);
  return m ? okv(m) : bad("freshness-invalid");
}

function chainArg(v: unknown): Field<string | null> {
  if (v === undefined) return okv(null);
  const c = parseChain(v);
  return c ? okv(c) : bad("chain-unknown");
}

function tokenArg(v: unknown, required: boolean): Field<TokenRef | null> {
  if (v === undefined) return required ? bad("token-required") : okv(null);
  const s = str(v, "token", 64);
  if (!s.ok) return bad(s.reason);
  const t = parseTokenRef(v);
  return t ? okv(t) : bad("token-invalid");
}

function traderArg(v: unknown, required: boolean): Field<TraderRef | null> {
  if (v === undefined) return required ? bad("trader-required") : okv(null);
  const s = str(v, "trader", 64);
  if (!s.ok) return bad(s.reason);
  const t = parseTraderRef(v);
  return t ? okv(t) : bad("trader-invalid");
}

function windowArg(v: unknown, fallback: ToolWindow | null): Field<ToolWindow | null> {
  if (v === undefined) return okv(fallback);
  const w = oneOf(v, TOOL_WINDOWS);
  return w ? okv(w) : bad("window-invalid");
}

function rankingWindowArg(v: unknown): Field<RankingWindow> {
  if (v === undefined) return okv("24h");
  const w = oneOf(v, RANKING_WINDOWS);
  return w ? okv(w) : bad("window-not-offered-for-rankings");
}

function limitArg(v: unknown, max: number, fallback: number): Field<number> {
  if (v === undefined) return okv(fallback);
  const n = intIn(v, 1, max);
  return n !== null ? okv(n) : bad("limit-out-of-range");
}

function sideArg(v: unknown): Field<"buy" | "sell" | null> {
  if (v === undefined) return okv(null);
  return v === "buy" || v === "sell" ? okv(v) : bad("side-invalid");
}

function cohortArg(v: unknown): Field<boolean> {
  if (v === undefined) return okv(false);
  return typeof v === "boolean" ? okv(v) : bad("cohort_only-invalid");
}

function depthArg(v: unknown, fallback: Depth): Field<Depth> {
  if (v === undefined) return okv(fallback);
  const d = oneOf(v, DEPTHS);
  return d ? okv(d) : bad("depth-invalid");
}

/** Run every field parser; the first refusal wins. */
function collect<A>(fields: { [K in keyof A]: Field<A[K]> }): Parsed<A> {
  const out = {} as A;
  for (const k of Object.keys(fields) as (keyof A)[]) {
    const f = fields[k];
    if (!f.ok) return { ok: false, reason: f.reason };
    out[k] = f.value;
  }
  return { ok: true, args: out };
}

// ── JSON Schema fragments ─────────────────────────────────────────────────

const S = {
  token: {
    type: "string",
    maxLength: 64,
    pattern: "^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|\\$?[A-Za-z0-9][A-Za-z0-9_-]{0,19})$",
    description: "Contract address, Solana mint, or ticker (e.g. PONS).",
  },
  trader: {
    type: "string",
    maxLength: 64,
    pattern: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|@?[A-Za-z0-9_]{1,30})$",
    description: "Fomo user id (UUID) or handle without @.",
  },
  chain: { type: "string", maxLength: 24, pattern: "^[a-z][a-z0-9-]{0,23}$", description: "Chain slug, e.g. robinhood, solana, base." },
  window: { type: "string", enum: [...TOOL_WINDOWS] },
  rankingWindow: { type: "string", enum: [...RANKING_WINDOWS] },
  side: { type: "string", enum: ["buy", "sell"] },
  freshness: {
    type: "string",
    enum: [...FRESHNESS_MODES],
    description: "force-refresh only when the user asks for the latest / right now.",
  },
  depth: { type: "string", enum: [...DEPTHS] },
  cohortOnly: { type: "boolean", description: "Only Merrymen's followed traders." },
  limit: (max: number) => ({ type: "integer", minimum: 1, maximum: max }),
} as const;

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

// ── The registry ─────────────────────────────────────────────────────────

export const FOMO_TOOL_DEFS: { [K in FomoToolName]: FomoToolDef<ToolArgs[K]> } = {
  fomo_resolve_subject: {
    description:
      "Resolve a coin (contract address, Solana mint or ticker) or a Fomo trader (handle or user id) to one exact identity. " +
      "When a ticker or address exists on several chains it returns the candidates instead of choosing.",
    schema: schema(
      {
        query: { type: "string", maxLength: 64, description: "Address, mint, ticker, handle or user id." },
        kind: { type: "string", enum: ["any", "trader", "token"] },
        chain: S.chain,
      },
      ["query"],
    ),
    freshness: "profile",
    mutation: false,
    ownerOnly: false,
    validate(raw) {
      const c = checkObject(raw, ["query", "kind", "chain"]);
      if (!c.ok) return c;
      const o = c.obj;
      const kind = o.kind === undefined ? "any" : oneOf(o.kind, ["any", "trader", "token"] as const);
      if (!kind) return { ok: false, reason: "kind-invalid" };
      if (o.query === undefined) return { ok: false, reason: "query-required" };
      const asText = str(o.query, "query", 64);
      if (!asText.ok) return { ok: false, reason: asText.reason };
      // "@x" is always a handle, "$X" always a ticker; otherwise the requested kind decides.
      let query: TokenRef | TraderRef | null = null;
      const q = asText.value;
      const trader = kind !== "token" ? parseTraderRef(q) : null;
      const token = kind !== "trader" ? parseTokenRef(q) : null;
      if (q.startsWith("@")) query = trader;
      else if (q.startsWith("$")) query = token;
      else if (kind === "trader") query = trader;
      else if (kind === "token") query = token;
      else if (token?.kind === "address") query = token;
      else if (trader?.kind === "user-id") query = trader;
      // A bare word under kind "any": a ticker when it is uppercase, else a handle.
      else if (token && /^[A-Z0-9][A-Z0-9_-]*$/.test(q)) query = token;
      else query = trader ?? token;
      if (!query) return { ok: false, reason: "query-invalid" };
      const chain = chainArg(o.chain);
      if (!chain.ok) return { ok: false, reason: chain.reason };
      return { ok: true, args: { query, kind, chain: chain.value } };
    },
  },

  fomo_get_trader_context: {
    description:
      "A Fomo trader's current holdings snapshot (provider-reported, valued at current prices; a truncated list is a floor, not a total) " +
      "and whether they are in Merrymen's followed cohort. A snapshot is not transaction history.",
    schema: schema(
      {
        trader: S.trader,
        window: S.window,
        focus: { type: "string", enum: ["holdings"] },
        depth: S.depth,
        freshness: S.freshness,
      },
      ["trader"],
    ),
    freshness: "holdings",
    mutation: false,
    ownerOnly: false,
    validate(raw) {
      const c = checkObject(raw, ["trader", "window", "focus", "depth", "freshness"]);
      if (!c.ok) return c;
      const o = c.obj;
      const focus: Field<"holdings" | null> = o.focus === undefined ? okv(null) : o.focus === "holdings" ? okv("holdings") : bad("focus-invalid");
      return collect<TraderContextArgs>({
        trader: traderArg(o.trader, true) as Field<TraderRef>,
        window: windowArg(o.window, null),
        focus,
        depth: depthArg(o.depth, "standard"),
        freshness: freshnessOf(o.freshness),
      });
    },
  },

  fomo_get_trader_activity: {
    description:
      "A Fomo trader's recent positions and feed events in a window. Buys, sells, transfers and airdrops are kept distinct; " +
      "the fill amount, the position's mark and its cumulative P&L are separate fields. No matching records is not proof of no trading.",
    schema: schema(
      {
        trader: S.trader,
        token: S.token,
        chain: S.chain,
        side: S.side,
        window: S.window,
        limit: S.limit(TOOL_LIMITS.activity.max),
        freshness: S.freshness,
      },
      ["trader"],
    ),
    freshness: "activity",
    mutation: false,
    ownerOnly: false,
    validate(raw) {
      const c = checkObject(raw, ["trader", "token", "chain", "side", "window", "limit", "freshness"]);
      if (!c.ok) return c;
      const o = c.obj;
      return collect<TraderActivityArgs>({
        trader: traderArg(o.trader, true) as Field<TraderRef>,
        token: tokenArg(o.token, false),
        chain: chainArg(o.chain),
        side: sideArg(o.side),
        window: windowArg(o.window, "7d") as Field<ToolWindow>,
        limit: limitArg(o.limit, TOOL_LIMITS.activity.max, TOOL_LIMITS.activity.default),
        freshness: freshnessOf(o.freshness),
      });
    },
  },

  fomo_get_token_theses: {
    description:
      "Written theses about a coin (or by a trader) on Fomo: short excerpts in the authors' own words, stance counts and evidence families. " +
      "Theses are claims to evaluate, not facts. Give a token, a trader, or both.",
    schema: schema({
      token: S.token,
      chain: S.chain,
      trader: S.trader,
      window: S.window,
      limit: S.limit(TOOL_LIMITS.theses.max),
      depth: S.depth,
      freshness: S.freshness,
    }),
    freshness: "theses",
    mutation: false,
    ownerOnly: false,
    validate(raw) {
      const c = checkObject(raw, ["token", "chain", "trader", "window", "limit", "depth", "freshness"]);
      if (!c.ok) return c;
      const o = c.obj;
      const r = collect<TokenThesesArgs>({
        token: tokenArg(o.token, false),
        chain: chainArg(o.chain),
        trader: traderArg(o.trader, false),
        window: windowArg(o.window, null),
        limit: limitArg(o.limit, TOOL_LIMITS.theses.max, TOOL_LIMITS.theses.default),
        // One page unless a wider read is asked for: each page is 1,250 credits.
        depth: depthArg(o.depth, "quick"),
        freshness: freshnessOf(o.freshness),
      });
      if (r.ok && !r.args.token && !r.args.trader) return { ok: false, reason: "token-or-trader-required" };
      return r;
    },
  },

  fomo_get_token_activity: {
    description:
      "Who has been buying or selling on Fomo in a window, for one coin or the whole feed. The feed only carries positions above roughly $3,000, " +
      "so counts are a floor. cohort_only limits it to Merrymen's followed traders.",
    schema: schema({
      token: S.token,
      chain: S.chain,
      side: S.side,
      window: S.window,
      cohort_only: S.cohortOnly,
      limit: S.limit(TOOL_LIMITS.tokenActivity.max),
      freshness: S.freshness,
    }),
    freshness: "activity",
    mutation: false,
    ownerOnly: false,
    validate(raw) {
      const c = checkObject(raw, ["token", "chain", "side", "window", "cohort_only", "limit", "freshness"]);
      if (!c.ok) return c;
      const o = c.obj;
      return collect<TokenActivityArgs>({
        token: tokenArg(o.token, false),
        chain: chainArg(o.chain),
        side: sideArg(o.side),
        window: windowArg(o.window, "24h") as Field<ToolWindow>,
        cohortOnly: cohortArg(o.cohort_only),
        limit: limitArg(o.limit, TOOL_LIMITS.tokenActivity.max, TOOL_LIMITS.tokenActivity.default),
        freshness: freshnessOf(o.freshness),
      });
    },
  },

  fomo_get_rankings: {
    description:
      "Fomo leaderboards: traders ranked by provider-reported P&L (not a skill measure), or the trending, graduated and most-held token boards.",
    schema: schema({
      board: { type: "string", enum: [...BOARDS] },
      window: S.rankingWindow,
      chain: S.chain,
      limit: S.limit(TOOL_LIMITS.rankings.max),
      cohort_only: S.cohortOnly,
      freshness: S.freshness,
    }),
    freshness: "rankings",
    mutation: false,
    ownerOnly: false,
    validate(raw) {
      const c = checkObject(raw, ["board", "window", "chain", "limit", "cohort_only", "freshness"]);
      if (!c.ok) return c;
      const o = c.obj;
      const board: Field<Board> = o.board === undefined ? okv("traders") : oneOf(o.board, BOARDS) ? okv(o.board as Board) : bad("board-invalid");
      return collect<RankingsArgs>({
        board,
        window: rankingWindowArg(o.window),
        chain: chainArg(o.chain),
        limit: limitArg(o.limit, TOOL_LIMITS.rankings.max, TOOL_LIMITS.rankings.default),
        cohortOnly: cohortArg(o.cohort_only),
        freshness: freshnessOf(o.freshness),
      });
    },
  },

  fomo_find_opportunities: {
    description:
      "Smaller coins getting fresh attention: followed traders' first purchases, new theses and new graduations, ranked by early-signal evidence, " +
      "not by size or popularity. Research leads only; nothing here is a reason to buy.",
    schema: schema({
      chain: S.chain,
      window: S.window,
      limit: S.limit(TOOL_LIMITS.opportunities.max),
      cohort_only: S.cohortOnly,
      max_market_cap_usd: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000_000_000 },
      freshness: S.freshness,
    }),
    freshness: "boards",
    mutation: false,
    ownerOnly: false,
    validate(raw) {
      const c = checkObject(raw, ["chain", "window", "limit", "cohort_only", "max_market_cap_usd", "freshness"]);
      if (!c.ok) return c;
      const o = c.obj;
      const cap = o.max_market_cap_usd;
      const capField: Field<number | null> =
        cap === undefined ? okv(null) : typeof cap === "number" && Number.isFinite(cap) && cap > 0 && cap <= 1e12 ? okv(cap) : bad("max_market_cap_usd-invalid");
      return collect<OpportunitiesArgs>({
        chain: chainArg(o.chain),
        window: windowArg(o.window, "24h") as Field<ToolWindow>,
        limit: limitArg(o.limit, TOOL_LIMITS.opportunities.max, TOOL_LIMITS.opportunities.default),
        cohortOnly: cohortArg(o.cohort_only),
        maxMarketCapUsd: capField,
        freshness: freshnessOf(o.freshness),
      });
    },
  },

  fomo_research_coin: {
    description:
      "Merrymen's shared research dossier for a coin: strongest support and objection, trader flow, words versus actions, unknowns and what " +
      "would change the view. since_revision reports what changed. Analysis only, never permission to trade.",
    schema: schema(
      {
        token: S.token,
        chain: S.chain,
        depth: S.depth,
        focus: { type: "string", enum: ["words-vs-actions"] },
        since_revision: { type: "integer", minimum: 1, maximum: 1_000_000_000 },
        window: S.window,
        freshness: S.freshness,
      },
      ["token"],
    ),
    freshness: "theses",
    mutation: false,
    ownerOnly: false,
    validate(raw) {
      const c = checkObject(raw, ["token", "chain", "depth", "focus", "since_revision", "window", "freshness"]);
      if (!c.ok) return c;
      const o = c.obj;
      const focus: Field<"words-vs-actions" | null> =
        o.focus === undefined ? okv(null) : o.focus === "words-vs-actions" ? okv("words-vs-actions") : bad("focus-invalid");
      const since: Field<number | null> =
        o.since_revision === undefined ? okv(null) : intIn(o.since_revision, 1, 1_000_000_000) !== null ? okv(o.since_revision as number) : bad("since_revision-invalid");
      return collect<ResearchCoinArgs>({
        token: tokenArg(o.token, true) as Field<TokenRef>,
        chain: chainArg(o.chain),
        depth: depthArg(o.depth, "standard"),
        focus,
        sinceRevision: since,
        window: windowArg(o.window, "24h") as Field<ToolWindow>,
        freshness: freshnessOf(o.freshness),
      });
    },
  },

  fomo_get_research_status: {
    description:
      "The owner's own Fomo research state: latest assessment and decision funnel for a coin, active watches, research jobs, the followed cohort " +
      "and whether Fomo data is healthy. Owner only.",
    schema: schema({
      token: S.token,
      chain: S.chain,
      request_id: { type: "string", maxLength: 128, pattern: "^[A-Za-z0-9_-]{1,128}$" },
    }),
    freshness: null,
    mutation: false,
    ownerOnly: true,
    validate(raw) {
      const c = checkObject(raw, ["token", "chain", "request_id"]);
      if (!c.ok) return c;
      const o = c.obj;
      const rid: Field<string | null> =
        o.request_id === undefined
          ? okv(null)
          : typeof o.request_id === "string" && REQUEST_ID.test(o.request_id)
            ? okv(o.request_id)
            : bad("request_id-invalid");
      return collect<ResearchStatusArgs>({ token: tokenArg(o.token, false), chain: chainArg(o.chain), requestId: rid });
    },
  },

  fomo_watch_coin: {
    description: "Owner only: watch a coin for Fomo activity for 1 to 30 days (default 7). Watching is not buying.",
    schema: schema(
      { token: S.token, chain: S.chain, days: { type: "integer", minimum: TOOL_LIMITS.watchDays.min, maximum: TOOL_LIMITS.watchDays.max } },
      ["token"],
    ),
    freshness: null,
    mutation: true,
    ownerOnly: true,
    validate(raw) {
      const c = checkObject(raw, ["token", "chain", "days"]);
      if (!c.ok) return c;
      const o = c.obj;
      const days: Field<number> =
        o.days === undefined
          ? okv(TOOL_LIMITS.watchDays.default)
          : intIn(o.days, TOOL_LIMITS.watchDays.min, TOOL_LIMITS.watchDays.max) !== null
            ? okv(o.days as number)
            : bad("days-out-of-range");
      return collect<WatchArgs>({ token: tokenArg(o.token, true) as Field<TokenRef>, chain: chainArg(o.chain), days });
    },
  },

  fomo_unwatch_coin: {
    description: "Owner only: stop watching a coin.",
    schema: schema({ token: S.token, chain: S.chain }, ["token"]),
    freshness: null,
    mutation: true,
    ownerOnly: true,
    validate(raw) {
      const c = checkObject(raw, ["token", "chain"]);
      if (!c.ok) return c;
      const o = c.obj;
      return collect<UnwatchArgs>({ token: tokenArg(o.token, true) as Field<TokenRef>, chain: chainArg(o.chain) });
    },
  },
};

/**
 * Tool specs for a model loop: READ tools only. A mutation is never offered
 * to a model, whatever names are asked for; the owner reaches those through
 * the deterministic planner and an owner-only surface.
 */
export function toolSpecs(names?: readonly FomoToolName[]): ToolSpec[] {
  const wanted = names ?? READ_TOOL_NAMES;
  const out: ToolSpec[] = [];
  for (const n of READ_TOOL_NAMES) {
    if (!wanted.includes(n)) continue;
    const d = FOMO_TOOL_DEFS[n];
    out.push({ name: n, description: d.description, schema: structuredClone(d.schema) });
  }
  return out;
}
