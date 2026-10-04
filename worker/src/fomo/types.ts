/**
 * THE SOCIAL-TRADING RESEARCH CONTRACT — vendor-neutral types shared by every
 * module under worker/src/fomo/ and by every surface that asks it a question
 * (app chat, Telegram DM, Telegram groups, MCP, the orchestrator's shared
 * ingestion and the tenant child's selective-following review).
 *
 * WHAT THIS SUBSYSTEM IS ALLOWED TO BE. A read-only research source on the
 * PROPOSE side of the wall. A trader buying a coin is a reason to investigate,
 * not an instruction to buy; a bullish thesis is a claim to evaluate, not a
 * fact. Nothing typed here reaches equity, P&L, the high-water mark, the
 * drawdown breaker, a grant or a cap. Execution stays in the existing executor,
 * reached only through the existing intent contract (policy.ts TradeIntent).
 *
 * ── UNITS ─────────────────────────────────────────────────────────────────
 *
 * TIME is unix MILLISECONDS everywhere in this subsystem (`*At`, `*Ms`), like
 * the desk and xpost. Five different clocks are kept apart on purpose:
 *
 *   retrievedAt          when WE fetched the bytes we are holding
 *   providerAsOf         when the provider says its own copy was captured
 *   sourceEventAt        when the underlying thing happened (a fill, a post)
 *   lastRefreshAttemptAt when we last TRIED to refresh, successful or not
 *   cacheAgeMs           now - retrievedAt, at the moment of answering
 *
 * Fetching a response now does not prove its observations are current.
 *
 * MONEY from the provider is a JSON float in USD. It is DISPLAY AND RESEARCH
 * DATA ONLY. It never becomes a bigint on the money path; sizing in this
 * subsystem is computed in micro-USDG bigint from the agent's OWN signed limits
 * and the agent's OWN quotes (see sizing.ts), never from a provider figure.
 *
 * NULL IS UNKNOWN, NEVER ZERO. A missing market cap is not a zero market cap,
 * an empty list is not "nobody traded", a truncated holdings list is a floor.
 */

// ── Identity ──────────────────────────────────────────────────────────────

/** CAIP-2 style namespace. `unknown` means the provider gave nothing usable. */
export type ChainNamespace = "eip155" | "solana" | "hyperliquid" | "unknown";

export interface ChainIdentity {
  namespace: ChainNamespace;
  /**
   * The network id AS RETURNED by the provider (4663 Robinhood Chain,
   * 1399811149 Solana, 5042 Arc, 1337 Hyperliquid). Null when the row carried
   * none — a missing id is never assumed to be the chain we asked for.
   */
  networkId: number | null;
  /** The provider's slug as returned ("robinhood", "solana", …), sanitised. */
  slug: string | null;
}

/**
 * A token is (namespace, network, address). Symbols and names are NOT identity.
 *
 *   EVM      address lowercased; the SAME hex on two networks is two tokens.
 *   Solana   base58 mint, case PRESERVED (base58 is case-sensitive).
 */
export interface TokenIdentity {
  chain: ChainIdentity;
  address: string;
  /** `${namespace}:${networkId ?? "?"}:${address}` — the only key used for storage and joins. */
  key: string;
}

/** Display-only labels. Untrusted, sanitised, never used to resolve identity. */
export interface TokenLabel {
  symbol: string | null;
  name: string | null;
}

/**
 * Whether Merrymen could act on a researched token at all. Research is
 * available for every value; execution only for the first.
 */
export type ExecutionAvailability =
  | "supported-authorized"
  | "supported-permission-missing"
  | "unsupported-venue"
  | "unsupported-chain"
  | "unresolved-identity";

/** A trader is their stable provider user id. Handles are renameable labels. */
export interface TraderIdentity {
  /** Provider user id (a UUID). The primary key; never a handle. */
  userId: string;
  /** Latest handle seen, display only. */
  handle: string | null;
  displayName: string | null;
  verified: boolean | null;
}

// ── What the data actually means ─────────────────────────────────────────

/**
 * What an observed event IS. A transfer or an airdrop is never a purchase; a
 * change in holdings value from price movement is not an event at all.
 */
export type ActivityKind =
  | "buy"
  | "sell"
  | "transfer-in"
  | "transfer-out"
  | "airdrop"
  | "thesis"
  | "perp"
  | "listing"
  | "other";

/**
 * Who stands behind an observation:
 *   provider-reported      the provider says so; nobody checked
 *   provider-verified      the provider says IT matched it on chain
 *   independently-verified Merrymen read the chain/venue itself
 */
export type ObservationBasis = "provider-reported" | "provider-verified" | "independently-verified";

/** How an event's identity was established (see events.ts). */
export type EventIdentityBasis = "provider-event-id" | "fill-identity" | "fingerprint";

export type EventSource = "stream" | "rest-recovery" | "rest-lookup";

/**
 * One normalised trader event. Every money field says what it is, and the
 * dangerous ones are named so they cannot be mistaken for each other.
 */
export interface TraderEvent {
  /** Canonical, durable identity (events.ts). Dedupe key across WS, REST and restarts. */
  eventKey: string;
  identityBasis: EventIdentityBasis;
  /** True when identity is a conservative fingerprint that might merge or split events. */
  identityAmbiguous: boolean;
  source: EventSource;
  kind: ActivityKind;
  trader: TraderIdentity;
  token: TokenIdentity | null;
  tokenLabel: TokenLabel;
  /** Provider position id the event belongs to. */
  tradeId: string | null;
  /** Provider fill id when present. A tx hash may carry several fills. */
  swapId: string | null;
  transferId: string | null;
  txHash: string | null;
  /**
   * THE ACTUAL FILL SIZE IN USD — set ONLY when the provider matched an exact
   * on-chain fill. Otherwise null: the size of this trade is unknown.
   */
  fillUsd: number | null;
  fillUsdBasis: "onchain-exact" | "ambiguous" | null;
  /**
   * The position's mark AFTER the fill (provider `positionValueUsd`). NEVER a
   * fill amount: a $40k position that added $50 shows $40k here.
   */
  positionValueUsd: number | null;
  /**
   * The position's CUMULATIVE realised P&L as of this event. Repeated on every
   * sell of the same position; NEVER summed across events (see normalize.ts).
   */
  positionRealizedPnlUsdCumulative: number | null;
  /** Provider event time (quantised by the provider to 5 s). */
  sourceEventAt: number | null;
  /** Block time of the matched fill, when matched. */
  execAt: number | null;
  /** When Merrymen received it. */
  observedAt: number;
  verification: ObservationBasis;
  /** Sanitised, capped alert/thesis text. Untrusted data, never instructions. */
  text: string | null;
  /** The stream re-sent this on (re)connect. Already-seen replays are dropped by eventKey. */
  replay: boolean;
}

/** One row of a holdings snapshot. A snapshot is not transaction history. */
export interface HoldingRow {
  token: TokenIdentity | null;
  label: TokenLabel;
  /** Token units as the provider returned them (float, display only). */
  amount: number | null;
  priceUsd: number | null;
  /** Current valuation. A rise here can be price, not accumulation. */
  valueUsd: number | null;
  change24hPct: number | null;
}

export interface HoldingsSnapshot {
  trader: TraderIdentity;
  rows: HoldingRow[];
  /** Upstream caps holdings (~100 rows); when true the total is a FLOOR. */
  truncated: boolean;
  /** Sum of served rows only; a floor when truncated; excludes perps/other equity. */
  totalValueUsdFloor: number | null;
  complete: boolean | null;
  /** Chain filter requested, and what the rows actually carried (filter verification). */
  chainFilterRequested: string | null;
  chainFilterHonoured: boolean | null;
}

/** A position (provider "trade"): the reconciled lot, not a fill. */
export interface PositionRow {
  tradeId: string | null;
  token: TokenIdentity | null;
  label: TokenLabel;
  status: "open" | "closed" | null;
  costBasisUsd: number | null;
  boughtAmount: number | null;
  soldAmount: number | null;
  transferredInAmount: number | null;
  transferredOutAmount: number | null;
  /** Current quantity: bought - sold + transferredIn - transferredOut. */
  amount: number | null;
  avgEntryPrice: number | null;
  avgExitPrice: number | null;
  /** Position-level cumulative realised P&L. Not a per-fill figure. */
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  openedAt: number | null;
  closedAt: number | null;
  /** Provider capture class: `captured` rows carry lot fields; `feed` rows do not. */
  source: "captured" | "feed" | "unknown";
}

/** One individual fill (swap). Joins back to positions via tradeIdIn/Out. */
export interface FillRow {
  swapId: string | null;
  chain: ChainIdentity;
  tokenIn: { token: TokenIdentity | null; amount: number | null; usd: number | null };
  tokenOut: { token: TokenIdentity | null; amount: number | null; usd: number | null };
  tradeIdIn: string | null;
  tradeIdOut: string | null;
  at: number | null;
}

/** A written thesis. A claim to evaluate, never a verified fact. */
export interface Thesis {
  /** Provider's stable id (dedupe). */
  id: string;
  tradeId: string | null;
  author: TraderIdentity;
  token: TokenIdentity | null;
  tokenLabel: TokenLabel;
  /** Sanitised, capped. Untrusted. */
  text: string;
  likes: number | null;
  replies: number | null;
  /** Author's position value on the coin when known (provider float). */
  authorEquityUsd: number | null;
  isDev: boolean | null;
  postedAt: number | null;
  /**
   * Evidence family. Copies, reposts and near-duplicates of one underlying
   * thesis share a family and count ONCE (dossier.ts). Merrymen's own posts
   * are a family that never counts as independent confirmation.
   */
  familyKey: string;
}

export interface ThesisComment {
  id: string;
  tradeId: string | null;
  authorUserId: string | null;
  text: string;
  likes: number | null;
  createdAt: number | null;
  parentId: string | null;
}

export type RankingWindow = "24h" | "7d" | "30d" | "all";

/** A leaderboard row. Provider-reported performance, not reconstructed skill. */
export interface RankingRow {
  rank: number | null;
  window: RankingWindow;
  trader: TraderIdentity;
  /** Realised P&L in the window, as the provider reports it. */
  pnlUsd: number | null;
  volumeUsd: number | null;
  trades: number | null;
  followers: number | null;
  holdingsCount: number | null;
  /** Provider-truncated token address prefixes; display only, never identity. */
  topTokenHints: string[];
  /** Whether the provider resolved an EVM wallet (the wallet itself is never surfaced). */
  hasEvmWallet: boolean;
}

export type TokenBoard = "trending" | "graduated" | "most-held";

export interface TokenBoardRow {
  board: TokenBoard;
  rank: number | null;
  token: TokenIdentity | null;
  label: TokenLabel;
  holders: number | null;
  priceUsd: number | null;
  change24hPct: number | null;
  /** Unknown is null, never 0. */
  marketCapUsd: number | null;
  volume24hUsd: number | null;
}

export type StatsWindowKey = "5m" | "1h" | "4h" | "24h";

export interface StatsWindow {
  buys: number | null;
  sells: number | null;
  uniqueBuyers: number | null;
  uniqueSellers: number | null;
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  netVolumeUsd: number | null;
  /** Null when there were no sells. */
  buySellRatio: number | null;
}

export interface TokenStats {
  token: TokenIdentity | null;
  holders: number | null;
  top10HoldersPercent: number | null;
  windows: Partial<Record<StatsWindowKey, StatsWindow>>;
}

export interface TraderProfile {
  trader: TraderIdentity;
  /** Provider-reported realised P&L per window. Not skill. */
  pnlUsd: Partial<Record<RankingWindow, number | null>>;
  volumeUsd: number | null;
  trades: number | null;
  followers: number | null;
  following: number | null;
  accountAgeDays: number | null;
  averageHoldTimeSeconds: number | null;
  hasEvmWallet: boolean;
  /** "resolving" means the provider has not finished; holdings unknown, not empty. */
  walletStatus: "resolved" | "resolving" | "none" | "unknown";
}

// ── Freshness, coverage, envelopes ────────────────────────────────────────

/** Separate freshness policies per data class (freshness.ts holds the numbers). */
export type FreshnessClass = "activity" | "holdings" | "rankings" | "theses" | "token-stats" | "profile" | "boards";

/**
 * What the caller asked for:
 *   cached-ok      a fresh-enough cache entry may answer
 *   prefer-fresh   refresh when older than the class policy (the default)
 *   force-refresh  "refresh", "latest", "check now", "right now": attempt upstream
 */
export type FreshnessMode = "cached-ok" | "prefer-fresh" | "force-refresh";

export interface Freshness {
  policy: FreshnessClass;
  mode: FreshnessMode;
  retrievedAt: number | null;
  providerAsOf: number | null;
  sourceEventAt: { oldest: number | null; newest: number | null };
  lastRefreshAttemptAt: number | null;
  lastRefreshOutcome: "ok" | "failed" | "skipped-budget" | "skipped-fresh" | null;
  cacheAgeMs: number | null;
  /** live: fetched for this request; cache: served from a fresh-enough entry; stale-cache: refresh failed, older copy shown and labelled. */
  servedFrom: "live" | "cache" | "stale-cache" | "none";
}

export interface Coverage {
  /** Scope requested, in plain fields (window, chain, side, limit…). */
  requested: Record<string, string | number | boolean | null>;
  /** Scope actually achieved. Differences are the honest part of the answer. */
  achieved: Record<string, string | number | boolean | null>;
  pagesRequested: number;
  pagesReturned: number;
  itemsReturned: number;
  duplicatesRemoved: number;
  /** Provider's own total when it states one; null when unknown. */
  providerTotal: number | null;
  /** True when a page/row cap was reached: "no more rows" is unknown, not proven. */
  capped: boolean;
  /** Sections that could not be read at all. */
  missing: string[];
  /** Short, plain notes on material limitations (floor-sized feed, ignored filter…). */
  notes: string[];
}

export interface Usage {
  providerCalls: number;
  cacheHits: number;
  /** From the provider's credit header when present; null when unknown. */
  creditsCharged: number | null;
  creditsRemaining: number | null;
}

/**
 * Every result's status. These are distinct facts and are never collapsed:
 *   ok                   the stated scope was read
 *   empty                a successful read returned no matching records (≠ "nobody traded")
 *   partial              some sections/pages failed; the rest are real
 *   capped               a page/row limit was reached
 *   stale                only an old copy is available; it is labelled with its age
 *   failed               the read failed and nothing usable is held
 *   unavailable          not configured, entitlement missing, or provider down
 *   not-authorized       the tenant's data-access permission is off (or audience forbids it)
 *   budget-limited       a retrieval budget refused the upstream call
 *   needs-clarification  the subject is ambiguous in a way that changes the answer
 *   not-found            the provider does not know this subject
 */
export type ResultStatus =
  | "ok"
  | "empty"
  | "partial"
  | "capped"
  | "stale"
  | "failed"
  | "unavailable"
  | "not-authorized"
  | "budget-limited"
  | "needs-clarification"
  | "not-found";

export type EvidenceKind =
  | "event"
  | "thesis"
  | "comment"
  | "holdings"
  | "positions"
  | "fills"
  | "profile"
  | "ranking"
  | "board"
  | "token-stats"
  | "dossier"
  | "assessment"
  | "decision";

/**
 * An opaque, traceable reference: `fomo:<kind>/<id>[@<retrievedAt>]`.
 * `sourceUrl` is set ONLY when the provider supplied a verified link; Merrymen
 * never invents a permalink.
 */
export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  sourceUrl: string | null;
}

/** What the caller asked about, before resolution. */
export type SubjectQuery =
  | { kind: "trader"; userId?: string; handle?: string }
  | { kind: "token"; address?: string; chain?: string; symbol?: string; name?: string }
  | { kind: "market" };

/** A resolved subject — the thing an answer is about. */
export type ResolvedSubject =
  | { kind: "trader"; trader: TraderIdentity }
  | { kind: "token"; token: TokenIdentity; label: TokenLabel }
  | { kind: "market" };

/** One candidate when resolution is ambiguous. Never silently chosen. */
export interface SubjectCandidate {
  subject: ResolvedSubject;
  /** Why it matched: exact address, exact handle, symbol on another chain… */
  match: string;
}

/** The registered read-only tool names (tools.ts). Merrymen names, not provider routes. */
export type FomoReadToolName =
  | "fomo_resolve_subject"
  | "fomo_get_trader_context"
  | "fomo_get_trader_activity"
  | "fomo_get_token_theses"
  | "fomo_get_token_activity"
  | "fomo_get_rankings"
  | "fomo_find_opportunities"
  | "fomo_research_coin"
  | "fomo_get_research_status";

/** Authorized mutations — a separate registry, never offered where read-only tools are. */
export type FomoMutationToolName = "fomo_watch_coin" | "fomo_unwatch_coin";

export type FomoToolName = FomoReadToolName | FomoMutationToolName;

/** The machine-readable envelope every tool returns. */
export interface FomoEnvelope<T = unknown> {
  requestId: string;
  tool: FomoToolName;
  status: ResultStatus;
  subject: ResolvedSubject | null;
  /** Present for needs-clarification: the choices, none picked. */
  candidates: SubjectCandidate[];
  data: T | null;
  evidence: EvidenceRef[];
  freshness: Freshness;
  coverage: Coverage;
  usage: Usage;
  dossierRevision: { dossierId: string; revision: number } | null;
  /** Stable machine reason when status is not ok (e.g. "http-429", "no-key"). */
  reason: string | null;
  /** One plain sentence safe to show. Never a secret, never a raw provider body. */
  message: string | null;
}

// ── Trusted call context ─────────────────────────────────────────────────

export type FomoSurface = "app-chat" | "telegram-dm" | "telegram-group" | "mcp" | "background";

/**
 * Who is asking, derived ONLY from trusted server context (session cookie,
 * the orchestrator's knowledge of which child sent a request, the Telegram
 * owner link). A model never supplies any field of this.
 */
export interface FomoCallContext {
  tenant: string;
  surface: FomoSurface;
  /**
   * owner: may see this tenant's private research state (watches,
   *        assessments, decisions). group: public data only, ever.
   */
  audience: "owner" | "group";
  conversationKey: string | null;
  requestId: string;
  now: number;
  /** Retrieval priority class for budget reservation (budget.ts). */
  priority: RetrievalPriority;
  signal?: AbortSignal;
}

/**
 * Retrieval priority, highest first. Position protection and interactive
 * questions have reserved capacity; optional discovery is shed first when a
 * budget runs low.
 */
export type RetrievalPriority = "position-protection" | "interactive" | "discovery";

// ── Cohort ───────────────────────────────────────────────────────────────

export type CohortChange = "added" | "retained" | "removed";

export interface CohortMember {
  trader: TraderIdentity;
  score: number;
  /** Explainable reasons (stable codes + short words), never a bare number. */
  reasons: string[];
  /** Useful for narrative discovery but NOT for following (opportunity gone before we can act). */
  followable: boolean;
  /** Provider-reported figures used, kept apart from reconstructed and prospective ones. */
  evidence: {
    providerReported: Record<string, number | null>;
    reconstructed: Record<string, number | null>;
    prospective: Record<string, number | null>;
  };
  sampleSize: number | null;
  includedAt: number;
}

export interface CohortVersion {
  version: number;
  createdAt: number;
  target: number;
  members: CohortMember[];
  /** Why the cohort is smaller than target, when it is. Never padded. */
  shortfallReason: string | null;
  changes: { userId: string; change: CohortChange; reason: string }[];
}

// ── Dossier ──────────────────────────────────────────────────────────────

/** Separates what kind of support a claim has. */
export type ClaimSupport = "source-statement" | "observed-action" | "verified-fact" | "inference";

export interface DossierClaim {
  claimKey: string;
  stance: "supporting" | "opposing" | "neutral";
  /** Merrymen's paraphrase, sanitised and short; never a copied third-party thesis. */
  summary: string;
  support: ClaimSupport;
  /** Distinct evidence families behind the claim (independent confirmations). */
  familyCount: number;
  /** Distinct authors. Separate wallets are not proven independent people. */
  authorCount: number;
  evidence: EvidenceRef[];
}

export interface DossierCoverage {
  uniqueTheses: number;
  uniqueAuthors: number;
  windowRequested: string;
  oldestSourceAt: number | null;
  newestSourceAt: number | null;
  providerTotal: number | null;
  pagesRequested: number;
  pagesReturned: number;
  duplicatesRemoved: number;
  sourceCaps: string[];
  missingSections: string[];
  limitations: string[];
}

export interface FlowSummary {
  window: string;
  /** Distinct observed buyers/sellers (wallets are not proven distinct people). */
  distinctBuyers: number | null;
  distinctSellers: number | null;
  cohortBuyers: number | null;
  cohortSellers: number | null;
  /** One trader adding repeatedly is not breadth. */
  repeatAddsBySameTrader: number;
  notes: string[];
}

export interface CoinDossier {
  dossierId: string;
  revision: number;
  token: TokenIdentity;
  label: TokenLabel;
  builtAt: number;
  /** Hash of the evidence ids that went in; unchanged inputs ⇒ no new revision. */
  inputsHash: string;
  strongestSupport: DossierClaim | null;
  strongestOpposition: DossierClaim | null;
  claims: DossierClaim[];
  flow: FlowSummary | null;
  /** Words vs actions: authors whose statements and observed actions disagree. */
  wordsVsActions: { userId: string; handle: string | null; statement: string; action: string; evidence: EvidenceRef[] }[];
  marketContext: string[];
  routeContext: string[];
  unknowns: string[];
  changeConditions: string[];
  coverage: DossierCoverage;
  versions: { schema: string; prompt: string | null; model: string | null };
  evidence: EvidenceRef[];
  /** Sections refreshed in this revision; the rest carried from the previous one. */
  refreshedSections: string[];
}

// ── Selective following ──────────────────────────────────────────────────

export type ResearchState =
  | "WATCH"
  | "PROBE_CANDIDATE"
  | "ENTRY_CANDIDATE"
  | "ADD_CANDIDATE"
  | "HOLD_POSITION"
  | "REDUCE_CANDIDATE"
  | "EXIT_CANDIDATE"
  | "REJECT_SETUP"
  | "RESEARCH_ONLY";

export interface FollowAssessment {
  id: string;
  tenant: string;
  token: TokenIdentity;
  label: TokenLabel;
  /** The events that prompted this review. */
  triggerEventKeys: string[];
  state: ResearchState;
  reasonCodes: string[];
  supporting: EvidenceRef[];
  opposing: EvidenceRef[];
  /** Source event → our observation. */
  signalDelayMs: number | null;
  /** Our observation → this assessment. */
  researchDelayMs: number | null;
  /** Price move since the triggering trader's event, when measurable. */
  priceMovePct: number | null;
  /** The quote this assessment was judged at (8dp USD string), from Merrymen's own pricing. */
  decisionQuote: { price8: string; at: number; source: string } | null;
  setupExpiresAt: number | null;
  horizon: string | null;
  invalidation: string[];
  /** Deterministic ceiling in micro-USDG (decimal string), or null when no entry is permitted. */
  sizeCeilingUsdg6: string | null;
  dossierRevision: { dossierId: string; revision: number } | null;
  executionAvailability: ExecutionAvailability;
  /** Model confidence is NOT a calibrated probability; it is never stored as one. */
  createdAt: number;
}

// ── Diagnosis, health, capabilities, publication ─────────────────────────

/** Where a candidate stopped (decision-funnel.ts). Mirrors the existing vocabulary. */
export type FunnelStage =
  | "NOT_DISCOVERED"
  | "DISCOVERY_SCREENED_OUT"
  | "RESEARCH_INCOMPLETE"
  | "MODEL_HOLD"
  | "GATE_FORCED_HOLD"
  | "PERMISSION_BLOCKED"
  | "UNSUPPORTED_ROUTE"
  | "SIZE_BELOW_ECONOMIC_FLOOR"
  | "SPONSORSHIP_UNAVAILABLE"
  | "BUDGET_EXHAUSTED"
  | "SUBMISSION_FAILED"
  | "SETTLEMENT_PENDING"
  | "LANDED";

/** Understandable health, shown to owners so nobody reads worker logs. */
export type FomoHealthState =
  | "not-configured"
  | "disabled"
  | "permission-required"
  | "provider-unavailable"
  | "budget-limited"
  | "research-only"
  | "watching-condition"
  | "researching"
  | "receiving-fresh-data";

export type CapabilityStatus =
  | "DOCUMENTED"
  | "AUTHENTICATED_TESTED"
  | "PARTIAL"
  | "ENTITLEMENT_BLOCKED"
  | "UNAVAILABLE"
  | "UNSUPPORTED";

export interface CapabilityRecord {
  /** Merrymen's name for the capability (e.g. "leaderboard", "ws-alerts"). */
  capability: string;
  /** Provider route/stream it relies on, for operators. */
  route: string;
  status: CapabilityStatus;
  /** What the status rests on: doc section, observed status code, filter check. */
  evidence: string;
  verifiedAt: number;
}

/** The status a public post must match exactly (publish.ts). */
export type PublicationKind =
  | "researching"
  | "watching"
  | "considering-entry"
  | "submitted"
  | "paper-traded"
  | "confirmed-purchase"
  | "confirmed-reduction"
  | "confirmed-exit"
  | "correction";

export type PublicationState =
  | "draft"
  | "blocked-policy"
  | "blocked-consent"
  | "suppressed-duplicate"
  | "queued"
  | "sending"
  | "sent"
  | "uncertain"
  | "reconciled-sent"
  | "reconciled-absent"
  | "cancelled"
  | "failed";
