/**
 * THE FOMO PROVIDER ADAPTER — the only file in this repository that names the
 * API host. Everything above it speaks `types.ts`; everything below it is one
 * vendor's JSON. A boundary test greps for the host and expects this file and
 * nothing else.
 *
 * WHAT THIS IS ALLOWED TO BE. A read-only research source on the PROPOSE side
 * of the wall. It issues GETs against an allowlist of documented read routes
 * and turns the answers into the vendor-neutral contract. It never places an
 * order, never builds calldata, never touches a wallet key, and every money
 * figure it returns is a provider float for display and research. The vendor
 * also sells an order-placing account product under `/v2/trading/*` and a
 * payment flow under `/pay/*`; both are refused before a request exists, by
 * template and again by the final URL, so no caller bug can reach them.
 *
 * THE KEY NEVER LEAVES ONE HEADER. It arrives as an argument (this module reads
 * no environment — there is a test), travels as exactly one
 * `authorization: Bearer` header, and is scrubbed from every detail string we
 * return. The vendor ALSO accepts the key on the query string; we never use
 * that for HTTP, because query strings land in proxy and CDN logs. The
 * websockets have no other way to take one, so `alertsStreamUrl` and
 * `tradesStreamUrl` return the real URL beside a redacted copy, and only the
 * redacted copy is fit for a log line.
 *
 * ── RETRIES: WHY EACH STATUS IS TREATED THE WAY IT IS ─────────────────────
 *
 * The vendor publishes its own policy (errors/retries/credits guide, fetched
 * 2026-10-04) and this follows it, because every retry of a billed route can
 * spend credits:
 *
 *   400/401/402/403/404  terminal. Repeating a bad request, a bad key, an
 *                        empty balance or a missing subject cannot succeed.
 *   409                  retried ONLY when the body says `retryable: true`
 *                        (a wallet still resolving). A bare 409 is terminal.
 *   429                  `Retry-After` is honoured only when the wait fits
 *                        inside the caller's overall deadline; otherwise the
 *                        wait is RETURNED so the caller's scheduler can honour
 *                        it instead of a worker sleeping on it.
 *   5xx, connect errors  bounded exponential backoff with full jitter. Every
 *                        5xx, 502 included (live: `upstream_unavailable`, "the
 *                        cursor is still valid, try again"). A 5xx whose body
 *                        says `retryable: true` or `upstream_unavailable` is
 *                        the vendor's UPSTREAM being slow for one subject, not
 *                        the API being down; the failure carries
 *                        `retryable: true` so callers can tell the two apart.
 *   a timed-out attempt  terminal. The vendor may have answered and billed a
 *                        call we stopped listening to; retrying would pay
 *                        twice for one answer. The deadline is the bound. If
 *                        an EARLIER attempt was answered (a 503, say), the
 *                        result reports that answer's failure and status, with
 *                        the cost unknown: the last attempt may have billed.
 *
 * TIMEOUTS. Live reads (2026-10-04) took 0.6–11 s: holdings and theses about
 * 7 s, fills about 5 s, and token stats 11 s before the vendor's own upstream
 * cutoff answered 503. An attempt gets 20 s, so the vendor's free, retryable
 * 503 arrives instead of our abort; the 45 s deadline fits two such attempts.
 *
 * THE CALLER'S CLOCK BINDS TOO. One tool call runs several reads in a row, and
 * the broker answers "took too long" at 50 s whatever is still running; a read
 * left running after that keeps listening and may bill. So `bound({signal,
 * deadlineAt})` returns a view of this client whose every call aborts its fetch
 * the moment `signal` fires, clamps each attempt (and every retry wait) to what
 * is left before `deadlineAt`, and does not START an attempt with less than
 * MIN_ATTEMPT_MS left: that read is refused unsent (`cancelled`, attempts 0),
 * never begun and then abandoned. A call our own deadline or abort cut short
 * mid-flight is `cancelled` too, never `timeout`: it is not evidence that the
 * vendor is slow, and its cost is unknown (it may have billed).
 *
 * ── NORMALISATION ────────────────────────────────────────────────────────
 *
 * Every body is read through the bounded reader, must be a JSON object, and
 * goes through a hand-written normaliser from `unknown`. Unknown fields are
 * ignored. A list item missing what makes it joinable (a user id, a token
 * that fits its chain, a thesis id) is DROPPED AND COUNTED, never patched: a
 * row we cannot attribute is not evidence about anyone. Every untrusted string
 * goes through `sanitizeText` — thesis, comment, handle and token-name text is
 * a prompt-injection vector and is data, never instructions.
 */

import { createHash } from "node:crypto";
import { readBoundedJson, MAX_READ_BYTES } from "../bounded-read";
import { sanitizeText } from "../research/news";
import { eventIdentity, EVENT_GUARDS } from "./events";
import { chainFromProvider, chainFromUserText, filterCheckIdentity, IDENTITY_GUARDS, tokenIdentity, verifyChainFilter } from "./identity";
import type {
  ActivityKind,
  ChainIdentity,
  EventSource,
  FillRow,
  HoldingRow,
  HoldingsSnapshot,
  PerpDetail,
  PositionRow,
  RankingRow,
  RankingWindow,
  StatsWindow,
  StatsWindowKey,
  Thesis,
  ThesisComment,
  TokenBoard,
  TokenBoardRow,
  TokenIdentity,
  TokenLabel,
  TokenStats,
  TopTokenHolding,
  TraderEvent,
  TraderIdentity,
  TraderProfile,
  WalletEvidence,
} from "./types";

/** The vendor's API origin. Fixed here, never configurable. */
export const FOMO_ORIGIN = "https://api.fomoapi.io";
/** The same host for the two websockets. Derived so the host is written once. */
const WS_ORIGIN = FOMO_ORIGIN.replace(/^https:/, "wss:");

// ── Public result contract ───────────────────────────────────────────────

export type ProviderFailure =
  | "no-key"
  | "bad-request"
  | "unauthorized"
  | "credits-exhausted"
  | "entitlement"
  | "not-found"
  | "conflict-retryable"
  | "rate-limited"
  | "server-error"
  | "unreachable"
  | "timeout"
  /** The CALLER stopped the call (its abort signal, or its deadline left no time): not the vendor's answer. */
  | "cancelled"
  | "unreadable"
  | "invalid-shape"
  | "refused-path";

export interface CallMeta {
  /** The route TEMPLATE (never the filled URL, which can carry identifiers). */
  route: string;
  /** HTTP status of the last attempt; null when no request was made or none answered. */
  status: number | null;
  /** Requests actually sent. 0 when refused before the network. */
  attempts: number;
  /** When WE finished reading the answer (or gave up). */
  retrievedAt: number;
  /**
   * What this call was billed across EVERY attempt it sent: the sum of each
   * answer's `x-credits-cost`. Null when any sent attempt's cost is unknown
   * (no header, or no answer at all). A retried 5xx, 429 or 409 is counted,
   * not just the answer that ended the call: settle budgets with
   * billedCreditsFor, never with this field alone.
   */
  creditsCost: number | null;
  /** The part of the cost the provider reported: the sum of every answer's header. Absent: none sent. */
  creditsPriced?: number;
  /** Attempts sent whose cost is unknown: an answer without the header, or no answer at all. */
  creditsUnpricedAttempts?: number;
  /** `x-credits-remaining` of the last answer; null when absent. */
  creditsRemaining: number | null;
  /** `x-credits-unmetered`; null when absent. */
  unmetered: boolean | null;
  /** When the vendor says ITS copy was captured (`capturedAt` and kin), ms. */
  providerAsOf: number | null;
  providerSource: "live" | "snapshot" | "captured" | null;
  providerStale: boolean | null;
  providerAgeSeconds: number | null;
}

/**
 * WHAT A CALL COST THE BUDGET, conservatively: every cost the provider
 * reported, plus `estimatePerAttempt` for each sent attempt whose cost is
 * unknown — a retry during an outage is never cheaper than one call. Null
 * only when nothing was sent (refund). Meta without the per-attempt fields
 * (built by hand, or before them) reads as one unpriced attempt when its cost
 * is unknown, exactly what keeping the reservation used to mean.
 */
export function billedCreditsFor(meta: CallMeta, estimatePerAttempt: number): number | null {
  if (!(meta.attempts > 0)) return null;
  const estimate = Number.isFinite(estimatePerAttempt) && estimatePerAttempt > 0 ? estimatePerAttempt : 0;
  const unpriced = meta.creditsUnpricedAttempts ?? (meta.creditsCost === null ? 1 : 0);
  const priced = meta.creditsPriced ?? meta.creditsCost ?? 0;
  if (unpriced === 0) return Math.max(0, priced);
  return Math.max(0, priced) + unpriced * estimate;
}

export type ProviderResult<T> =
  | { ok: true; data: T; meta: CallMeta }
  | {
      ok: false;
      failure: ProviderFailure;
      detail: string;
      retryAfterMs?: number;
      /**
       * The vendor marked this failure transient (a 5xx with `retryable: true`
       * or `upstream_unavailable`): its upstream did not answer for this one
       * subject in time. Not evidence that the API is down.
       */
      retryable?: boolean;
      meta: CallMeta;
    };

/** Every list answer carries what was kept AND how many rows were refused. */
export interface RowsPage<T> {
  rows: T[];
  /** Items present in the answer but missing what makes them joinable. Never silently zero. */
  dropped: number;
}

export interface LeaderboardPage extends RowsPage<RankingRow> {
  window: RankingWindow;
  /** The vendor's own `count`, when stated. */
  providerCount: number | null;
  /**
   * Top-token objects across all rows that could not be placed on a chain.
   * Always set by the adapter; optional so older cached boards still parse.
   */
  topTokensDropped?: number;
}

export interface PositionsPage extends RowsPage<PositionRow> {
  userId: string;
  nextCursor: string | null;
  /** The vendor cut the page (opens sort first and fill it). */
  truncated: boolean | null;
  openCount: number | null;
  closedCount: number | null;
  closedTotalOnFomo: number | null;
  /** The vendor states a full history is never obtainable; this is its flag, not ours. */
  complete: boolean | null;
  partial: boolean | null;
  available: boolean | null;
}

export interface SwapsPage extends RowsPage<FillRow> {
  userId: string;
  nextCursor: string | null;
  /**
   * The vendor's `moreAvailable` when it says so. Live answers do not send it;
   * a page that hands back a cursor is then read as "more may exist" (true),
   * never as "this is all".
   */
  moreAvailable: boolean | null;
  /**
   * The vendor's completeness flags. Live (2026-10-04): `complete: false`, with
   * a note that at most 100 swaps are served per trader with no cursor past
   * them: a RECENT WINDOW of fills, not the trader's history.
   */
  complete: boolean | null;
  partial: boolean | null;
  sourceCapped: boolean | null;
  providerCount: number | null;
}

/** A holdings snapshot plus the read's own bookkeeping. Assignable to `HoldingsSnapshot`. */
export interface BalancesSnapshot extends HoldingsSnapshot {
  dropped: number;
  upstreamRows: number | null;
  available: boolean | null;
  /** Rows the provider has no price for (it sends price 0): their value is unknown, not zero. */
  unpricedRows: number;
  /** Rows the provider itself excludes from its total (`includeInEquity: false`). */
  excludedRows: number;
  /** The vendor's own sum over the rows it served: a cross-check for the floor, never a portfolio value. */
  providerTotalValueUsd: number | null;
  /**
   * What the vendor reports but EXCLUDES from every total (perps, other
   * equity, native EVM balances). Stated so a reader knows they exist; never
   * added to the floor.
   */
  excluded: {
    otherEquityUsd: number | null;
    livePerpPnlUsd: number | null;
    perpPositions: number | null;
    nativeEvmRows: number | null;
  };
}

export interface FollowedTrader {
  trader: TraderIdentity;
  followers: number | null;
  following: number | null;
  trades: number | null;
  volumeUsd: number | null;
  pnl24hUsd: number | null;
  accountAgeDays: number | null;
}

export interface FollowingPage extends RowsPage<FollowedTrader> {
  userId: string;
  truncated: boolean | null;
  complete: boolean | null;
  partial: boolean | null;
  sourceCapped: boolean | null;
  /** The vendor's profile count of follows, when it holds one. */
  profileFollowing: number | null;
}

export interface SpotlightItem {
  tradeId: string;
  token: TokenIdentity | null;
  label: TokenLabel;
  avgEntryPrice: number | null;
  avgExitPrice: number | null;
  costBasisUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  /** Sanitised, capped. Untrusted. */
  thesisText: string | null;
  thesisLikes: number | null;
  openedAt: number | null;
  closedAt: number | null;
}

export interface SpotlightResult {
  userId: string;
  handle: string | null;
  bestTrades: SpotlightItem[];
  bestTheses: SpotlightItem[];
  dropped: number;
}

/** Where a thesis read came from and how much of it there is. */
export interface ThesesPage extends RowsPage<Thesis> {
  /** The vendor's own count for the subject, when stated. */
  totalAvailable: number | null;
  source: "live" | "snapshot" | "captured" | null;
  stale: boolean | null;
  ageSeconds: number | null;
  pagesRequested: number;
  partial: boolean | null;
  /** The minimum position size the vendor says it applied. */
  threshold: number | null;
  chainFilterRequested: string | null;
  chainFilterHonoured: boolean | null;
  available: boolean | null;
}

export interface TradeDetail {
  tradeId: string;
  position: PositionRow;
  traderHandle: string | null;
  isDev: boolean | null;
  thesisText: string | null;
  thesisLikes: number | null;
  /** Count only: one position has been measured at 2,243 swaps, and picking one by time is a guess. */
  swapCount: number | null;
  transferCount: number | null;
}

export interface CommentsPage extends RowsPage<ThesisComment> {
  tradeId: string;
  hasNextPage: boolean | null;
}

export interface TokenDevRow {
  handle: string | null;
  userId: string | null;
  isDev: boolean | null;
  tradeId: string | null;
  amount: number | null;
  valueUsd: number | null;
  costBasisUsd: number | null;
  averageEntryPrice: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  averageHoldTimeSeconds: number | null;
  /** The dev's own thesis on their own token. Sanitised, capped, untrusted. */
  thesisText: string | null;
}

export interface TokenDevsPage extends RowsPage<TokenDevRow> {
  token: TokenIdentity | null;
}

export interface TokenHolderRow {
  handle: string;
  userId: string | null;
  amount: number | null;
  valueUsd: number | null;
  priceUsd: number | null;
}

export interface TokenHoldersPage extends RowsPage<TokenHolderRow> {
  available: boolean | null;
}

export interface TokenBoardPage extends RowsPage<TokenBoardRow> {
  board: TokenBoard;
}

export interface TraderSearchHit {
  kind: "trader";
  trader: TraderIdentity;
  volumeUsd: number | null;
  followers: number | null;
  /** True only when an EVM wallet is resolved. Read with `walletStatus`: false while `resolving` is not "none". */
  hasEvmWallet: boolean;
  evmWalletEvidence: WalletEvidence | null;
  walletsVerified: boolean | null;
  /** `resolving`: the provider has not finished looking; the wallets are unknown, not absent. */
  walletStatus: TraderProfile["walletStatus"];
  /** Where the provider found the trader: a leaderboard row (with stats) or its directory (identity only). */
  source: "leaderboard" | "directory" | null;
  /**
   * The provider's leaderboard figures for this trader, from a window and a
   * time the answer DOES NOT STATE (live: rank 2 and a P&L that matched no
   * board we read). Never merge them into windowed P&L. Null when absent.
   */
  unwindowedRanking: { rank: number | null; pnlUsd: number | null; window: null } | null;
}

export type SearchHit = TraderSearchHit | { kind: "token"; token: TokenIdentity; label: TokenLabel; marketCapUsd: number | null };

export type SearchPage = RowsPage<SearchHit>;

export interface TokenSearchHit {
  token: TokenIdentity;
  label: TokenLabel;
  marketCapUsd: number | null;
}

export type TokenSearchPage = RowsPage<TokenSearchHit>;

export interface AlertsPage extends RowsPage<TraderEvent> {
  /** Store this; resume with `cursor` for strictly-newer events (`since` is inclusive). */
  nextCursor: string | null;
  /** Pass as `before` while `hasMore` to walk back through a gap. */
  oldestCursor: string | null;
  hasMore: boolean | null;
  newestTs: number | null;
  oldestTs: number | null;
  chainFilterRequested: string | null;
  /**
   * From the rows' own networks. When no row could speak to it, the server's
   * echo of the filter it applied is a secondary signal that can only say
   * "not honoured" (an echo naming another chain or none); an echo naming
   * ours proves nothing, so it never makes this true.
   */
  chainFilterHonoured: boolean | null;
  /** The vendor's own `count`, when stated. */
  providerCount: number | null;
  available: boolean | null;
  /**
   * Where the vendor served the page from. Live: `memory`, its in-memory ring
   * (the stream reports 10,000 buffered), so how far back recovery can walk is
   * bounded by eviction. Deliberately NOT a `providerSource`: it is the live
   * feed, not a stored fallback.
   */
  backend: "memory" | null;
  /** The filter the server says it applied (sanitised short values only). */
  filterEcho: { chain: string | null; type: string | null; source: string | null } | null;
  /** The vendor's stated order (live: "ts desc, then id desc"), sanitised. */
  order: string | null;
}

/** `/v2/me`: the zero-credit entitlement probe. */
export interface AccountInfo {
  plan: string | null;
  /** The plan's daily credit cap (live: `dailyLimit`), separate from the monthly bucket. */
  dailyLimit: number | null;
  credits: { monthly: number | null; usedThisMonth: number | null; prepaid: number | null; remaining: number | null };
  /** Whether the plan includes each stream. Live sends `{path, included}`; the documentation, a bare boolean. Both are read. */
  streams: { appFeed: boolean | null; onChain: boolean | null };
  /** The socket path the vendor names for each stream, when it names one. */
  streamPaths: { appFeed: string | null; onChain: string | null };
  /** When the plan expires (live: `planExpiresAt`; documented as `expiresAt`). */
  planExpiresAt: number | null;
  /** The same instant as `planExpiresAt`, kept for existing readers. */
  expiresAt: number | null;
}

export interface AlertsQuery {
  /** Opaque `nextCursor` from a previous page: strictly newer events. */
  cursor?: string;
  /** Opaque `oldestCursor`: strictly older events, for walking back through a gap. */
  before?: string;
  /** Inclusive lower bound, ms or ISO. Prefer `cursor`: timestamps are not unique. */
  since?: number | string;
  chain?: string;
  type?: string;
  /** FOMO user id. The handle filter is deliberately not offered: handles are renameable. */
  userId?: string;
  /** Symbol or contract address. */
  token?: string;
  limit?: number;
}

/** The thesis-by-token `network` values. `robinhood` is ours: the vendor's enum lacks it. */
export type ThesisNetwork = "robinhood" | "sol" | "bnb" | "base" | "eth" | "arc";

export interface FomoClient {
  leaderboard(window: RankingWindow, limit?: number): Promise<ProviderResult<LeaderboardPage>>;
  /** 2,500 credits on a hit. Prefer `search` (250) when only a user id is needed. */
  traderByHandle(handle: string): Promise<ProviderResult<TraderProfile>>;
  /** 2,500 credits. */
  traderById(userId: string): Promise<ProviderResult<TraderProfile>>;
  positions(userId: string, opts?: { status?: "open" | "closed" | "all"; cursor?: string; limit?: number }): Promise<ProviderResult<PositionsPage>>;
  swaps(userId: string, opts?: { cursor?: string; limit?: number; tokenAddress?: string }): Promise<ProviderResult<SwapsPage>>;
  balances(userId: string, opts?: { chain?: string }): Promise<ProviderResult<BalancesSnapshot>>;
  following(userId: string, opts?: { limit?: number }): Promise<ProviderResult<FollowingPage>>;
  spotlight(userId: string): Promise<ProviderResult<SpotlightResult>>;
  theses(opts?: { chain?: string; limit?: number; sort?: "recent" | "equity" | "pnl" }): Promise<ProviderResult<ThesesPage>>;
  /** 1,250 credits PER PAGE. */
  thesesByToken(
    address: string,
    opts?: { network?: ThesisNetwork; sort?: "likes" | "recent"; pages?: number; threshold?: number; limit?: number },
  ): Promise<ProviderResult<ThesesPage>>;
  thesesByUser(userId: string, opts?: { chain?: string; limit?: number; sort?: "likes" | "recent" }): Promise<ProviderResult<ThesesPage>>;
  thesesByUserToken(userId: string, address: string, opts?: { limit?: number }): Promise<ProviderResult<ThesesPage>>;
  trade(tradeId: string): Promise<ProviderResult<TradeDetail>>;
  tradeComments(tradeId: string, opts?: { limit?: number }): Promise<ProviderResult<CommentsPage>>;
  tokenStats(address: string, opts?: { networkId?: number }): Promise<ProviderResult<TokenStats>>;
  tokenDevs(address: string, opts?: { networkId?: number }): Promise<ProviderResult<TokenDevsPage>>;
  tokenHolders(address: string, opts?: { limit?: number }): Promise<ProviderResult<TokenHoldersPage>>;
  tokenBoard(board: TokenBoard, limit?: number): Promise<ProviderResult<TokenBoardPage>>;
  search(q: string, type?: "traders" | "tokens" | "all", limit?: number): Promise<ProviderResult<SearchPage>>;
  tokensSearch(q: string, limit?: number): Promise<ProviderResult<TokenSearchPage>>;
  alerts(query: AlertsQuery, source: "rest-recovery" | "rest-lookup"): Promise<ProviderResult<AlertsPage>>;
  me(): Promise<ProviderResult<AccountInfo>>;
  /**
   * This client, bound to a caller's abort signal and absolute deadline (ms on
   * the client's clock). Every call through the view aborts its fetch when the
   * signal fires and never runs past the deadline; binding a bound view again
   * keeps both signals and the earlier deadline. See the module comment.
   */
  bound(scope: CallScope): FomoClient;
}

/** A caller's limits on the calls it makes through `FomoClient.bound`. */
export interface CallScope {
  signal?: AbortSignal | null;
  /** Absolute, in ms on the client's clock (`now`). */
  deadlineAt?: number | null;
}

export interface FomoClientOptions {
  apiKey: string;
  /** Injected by tests. Production passes nothing and gets global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Per attempt. */
  timeoutMs?: number;
  /** Overall, across every attempt and every wait. */
  deadlineMs?: number;
  /** The least time left before a bound caller's deadline that an attempt may start with. Defaults to MIN_ATTEMPT_MS. */
  minAttemptMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Success-body cap. Defaults to the shared 2 MB bound. */
  maxBytes?: number;
}

// ── Routes, cost and the allowlist ───────────────────────────────────────

interface RouteSpec {
  template: string;
  /** Credits per call (per PAGE when `perPage`), from the pricing table fetched 2026-10-04. */
  credits: number;
  perPage: boolean;
  /** Wallet resolution: ten ordinary reads. Budgets should treat it as a deliberate act. */
  expensive: boolean;
  /** Documented `limit` maximum; null when the route takes none. */
  maxLimit: number | null;
}

/**
 * Every route this client can reach, with its documented price. This table IS
 * the allowlist: a template not in it cannot be requested.
 *
 * Per-trader routes use the `{userId}` form. The vendor accepts a handle in the
 * same slot, and this client refuses one there: every result type is keyed on
 * the user id, and a handle can be renamed between the call and the write, so
 * an answer fetched by handle could be filed under the wrong person. Handles
 * enter only through resolution (`search`, `traderByHandle`).
 */
export const ROUTE_COST = {
  me: { template: "/v2/me", credits: 0, perPage: false, expensive: false, maxLimit: null },
  leaderboard: { template: "/v2/leaderboard/{window}", credits: 250, perPage: false, expensive: false, maxLimit: 150 },
  traderByHandle: { template: "/v2/users/{handle}", credits: 2_500, perPage: false, expensive: true, maxLimit: null },
  traderById: { template: "/v2/users/id/{userId}", credits: 2_500, perPage: false, expensive: true, maxLimit: null },
  positions: { template: "/v2/users/{userId}/positions", credits: 250, perPage: true, expensive: false, maxLimit: 100 },
  swaps: { template: "/v2/users/{userId}/swaps", credits: 250, perPage: true, expensive: false, maxLimit: 100 },
  balances: { template: "/v2/users/{userId}/balances", credits: 250, perPage: false, expensive: false, maxLimit: null },
  following: { template: "/v2/users/{userId}/following", credits: 250, perPage: false, expensive: false, maxLimit: 300 },
  spotlight: { template: "/v2/users/{userId}/spotlight", credits: 250, perPage: false, expensive: false, maxLimit: null },
  theses: { template: "/v2/thesis", credits: 1_250, perPage: true, expensive: false, maxLimit: 100 },
  thesesByToken: { template: "/v2/thesis/token/{address}", credits: 1_250, perPage: true, expensive: false, maxLimit: 100 },
  thesesByUser: { template: "/v2/thesis/user/{userId}", credits: 1_250, perPage: true, expensive: false, maxLimit: 100 },
  thesesByUserToken: { template: "/v2/thesis/user/{userId}/token/{address}", credits: 1_250, perPage: true, expensive: false, maxLimit: 100 },
  trade: { template: "/v2/trades/{tradeId}", credits: 250, perPage: false, expensive: false, maxLimit: null },
  tradeComments: { template: "/v2/trades/{tradeId}/comments", credits: 250, perPage: false, expensive: false, maxLimit: 200 },
  tokenStats: { template: "/v2/token/{address}/stats", credits: 250, perPage: false, expensive: false, maxLimit: null },
  tokenDevs: { template: "/v2/token/{address}/devs", credits: 250, perPage: false, expensive: false, maxLimit: null },
  tokenHolders: { template: "/token/{address}/holders", credits: 250, perPage: false, expensive: false, maxLimit: 100 },
  tokenBoardTrending: { template: "/v2/leaderboard/tokens/trending", credits: 250, perPage: false, expensive: false, maxLimit: 100 },
  tokenBoardGraduated: { template: "/v2/leaderboard/tokens/graduated", credits: 250, perPage: false, expensive: false, maxLimit: 100 },
  tokenBoardMostHeld: { template: "/v2/leaderboard/tokens/most-held", credits: 250, perPage: false, expensive: false, maxLimit: 100 },
  search: { template: "/v2/search", credits: 250, perPage: false, expensive: false, maxLimit: 100 },
  tokensSearch: { template: "/v2/tokens/search", credits: 250, perPage: false, expensive: false, maxLimit: 100 },
  alerts: { template: "/v2/alerts", credits: 125, perPage: false, expensive: false, maxLimit: 100 },
} as const satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof ROUTE_COST;

/** What a call should cost before it is made, for budget reservation. Pages only matter on per-page routes. */
export function expectedCredits(route: RouteName, pages = 1): number {
  const r: RouteSpec = ROUTE_COST[route];
  return r.perPage ? r.credits * Math.max(1, Math.floor(pages)) : r.credits;
}

const TEMPLATES: ReadonlyMap<string, RegExp> = new Map(
  Object.values(ROUTE_COST).map((r) => [r.template, new RegExp("^" + r.template.replace(/\{[^}]+\}/g, "[^/]+") + "$")]),
);

/**
 * The vendor's order-placing and payment surfaces. Refused by prefix on the
 * template AND on the final pathname, so neither a new table entry nor a
 * crafted path segment can reach them.
 */
const FORBIDDEN_PATH = /^\/(?:v\d+\/)?(?:trading|pay)(?:\/|$)/i;
/** Query names that would carry the key. HTTP never sends it there. */
const KEY_QUERY_NAMES = /^(?:key|apikey|api_key|api-key)$/i;
/** One path segment after our own validation: no separators, no escapes, no dot-segments. */
const SAFE_SEGMENT = /^[A-Za-z0-9_@-][A-Za-z0-9_.@-]{0,127}$/;

export type QueryValue = string | number | boolean | null | undefined;

/**
 * The only way a URL is made. Exported so the tests can attack it directly.
 *
 * WHY DOT-SEGMENTS GET THEIR OWN CHECK: `encodeURIComponent("..")` is `..`, and
 * the URL parser resolves a `..` segment (and `%2e%2e`) upward — so a "handle"
 * of `..` would turn `/v2/users/{handle}` into `/v2/`. The segment rule refuses
 * a leading dot, and the final pathname is matched against the template anyway.
 */
export function buildFomoUrl(
  template: string,
  params: Readonly<Record<string, string>>,
  query: Readonly<Record<string, QueryValue>> = {},
): { ok: true; url: string } | { ok: false; failure: "refused-path" | "bad-request"; detail: string } {
  const shape = TEMPLATES.get(template);
  if (FORBIDDEN_PATH.test(template) || !shape) {
    return { ok: false, failure: "refused-path", detail: "route is not on the read allowlist" };
  }
  let path = template;
  for (const name of template.match(/\{[^}]+\}/g) ?? []) {
    const value = params[name.slice(1, -1)];
    if (typeof value !== "string" || value === "") return { ok: false, failure: "bad-request", detail: `missing ${name}` };
    if (!SAFE_SEGMENT.test(value)) return { ok: false, failure: "refused-path", detail: `unsafe path segment for ${name}` };
    path = path.replace(name, encodeURIComponent(value));
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (KEY_QUERY_NAMES.test(k)) return { ok: false, failure: "refused-path", detail: "the key never rides in a query string" };
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)) return { ok: false, failure: "bad-request", detail: "unsupported query parameter" };
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }
  let url: URL;
  try {
    url = new URL(path + (qs.size ? "?" + qs.toString() : ""), FOMO_ORIGIN);
  } catch {
    return { ok: false, failure: "bad-request", detail: "the URL could not be built" };
  }
  if (url.origin !== FOMO_ORIGIN || url.username || url.password || url.hash || FORBIDDEN_PATH.test(url.pathname) || !shape.test(url.pathname)) {
    return { ok: false, failure: "refused-path", detail: "the built URL left the read allowlist" };
  }
  return { ok: true, url: url.toString() };
}

// ── Small readers over `unknown` ─────────────────────────────────────────

type Rec = Record<string, unknown>;
type Norm<T> = { ok: true; data: T } | { ok: false; detail: string };

const { EVM_ADDRESS, SOLANA_MINT } = IDENTITY_GUARDS;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HANDLE = /^@?[A-Za-z0-9_.-]{1,40}$/;
/** Ids that go into a path: no dots, so no dot-segment can be formed. */
const PATH_ID = /^[A-Za-z0-9_:-]{1,128}$/;
/** Opaque ids read from bodies (thesis, comment, swap ids). */
const BODY_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Opaque cursors (`start`, a trade id, `<ts>.<id>`). Read off a response, never built. */
const CURSOR = /^[A-Za-z0-9_.:-]{1,160}$/;
/** A usable key: printable ASCII, no whitespace — anything else could split a header. */
const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/;
const TOKEN_SYMBOL = /^\$?[A-Za-z0-9._-]{1,24}$/;
const ALERT_TYPE = /^[a-z][a-z_]{0,23}$/;
const TOKEN_HINT = /^(?:0x[0-9a-fA-F]{1,40}|[1-9A-HJ-NP-Za-km-z]{1,44})$/;
/** The app feed's alert id: `alrt_<13-digit ms>_<global sequence>`. */
const PROVIDER_ALERT_ID = /^alrt_\d{13}_(\d{1,12})$/;
/** Short provider vocabulary echoed back (filter values, a price source). */
const SHORT_SLUG = /^[a-z0-9][a-z0-9_-]{0,23}$/;
/** A websocket path the vendor names in `/v2/me`. */
const STREAM_PATH = /^\/ws\/[a-z][a-z-]{0,23}$/;
/**
 * A perp alert's text as observed live: `<handle> Open Long 10x $SYM perp`.
 * End-anchored and strict; anything else yields no perp detail rather than a guess.
 */
const PERP_TEXT = / (Open|Close) (Long|Short) (\d{1,3})x \$[A-Za-z0-9._-]{1,24} perp$/;
/**
 * The money parenthetical the vendor appends to buy and sell alert text:
 * `($12K size)` is the position MARK, `(-$20K realized)` the CUMULATIVE
 * realised P&L. Neither is the fill, and the structured fields already carry
 * both under names that say so; left in the text, a reader takes the mark for
 * the purchase size. Stripped, end-anchored, buy and sell only.
 */
const MONEY_PAREN = /\s*\((?:[+-]?\$[\d.,]+[KMBkmb]?) (?:size|realized)\)$/;

const MIN_TS = Date.UTC(2015, 0, 1);
const MAX_TS = Date.UTC(2100, 0, 1);

const NAME_MAX = 80;
const SYMBOL_MAX = 32;
const THESIS_TEXT_MAX = 1_000;
const COMMENT_TEXT_MAX = 1_000;
const ALERT_TEXT_MAX = 280;
const PLAN_MAX = 32;
const DETAIL_MAX = 160;
const QUERY_MAX = 64;
/** Error bodies are read only for a code and a `retryable` flag. */
const ERROR_BODY_MAX_BYTES = 16_384;
/** The vendor's documented holdings ceiling; a page this full without a flag is treated as cut. */
const HOLDINGS_CAP = 100;
const TOKEN_HINTS_MAX = 10;
const MAX_RETRY_AFTER_MS = 86_400_000;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DEADLINE_MS = 45_000;
const DEFAULT_MAX_ATTEMPTS = 3;
/**
 * An attempt is not started with less than this left before the caller's
 * deadline. The fastest live read took 0.6 s and most took several; a call
 * begun with less would mostly be abandoned mid-flight, after it may have billed.
 */
export const MIN_ATTEMPT_MS = 2_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const RETRY_AFTER_JITTER_MS = 250;

function isObj(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function obj(v: unknown): Rec {
  return isObj(v) ? v : {};
}

/** A finite number, or a plain numeric string (the vendor sends some volumes as strings). Never a coerced zero. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function nonNeg(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
}

/** A count: a non-negative safe integer, or null. */
function count(v: unknown): number | null {
  const n = num(v);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function text(v: unknown, max: number): string | null {
  return sanitizeText(v, max) || null;
}

function uuidOf(v: unknown): string | null {
  return typeof v === "string" && UUID.test(v.trim()) ? v.trim().toLowerCase() : null;
}

function idOf(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return BODY_ID.test(s) ? s : null;
}

function cursorOf(v: unknown): string | null {
  return typeof v === "string" && CURSOR.test(v.trim()) ? v.trim() : null;
}

/** A provider handle for display, `@` stripped. Free text belongs in displayName, not here. */
function handleOf(v: unknown): string | null {
  const s = sanitizeText(v, 64);
  return HANDLE.test(s) && !/^@?\.+$/.test(s) ? s.replace(/^@/, "") : null;
}

/** Unix ms from ms, seconds or ISO. Anything outside 2015–2100 is unreadable, not clamped. */
function toMs(v: unknown): number | null {
  let ms = NaN;
  if (typeof v === "number" && Number.isFinite(v)) ms = v >= 1e12 ? v : v >= 1e9 ? v * 1000 : NaN;
  else if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    ms = /^\d{9,13}(?:\.\d+)?$/.test(t) ? (Number(t) >= 1e12 ? Number(t) : Number(t) * 1000) : Date.parse(t);
  }
  if (!Number.isFinite(ms)) return null;
  ms = Math.round(ms);
  return ms >= MIN_TS && ms <= MAX_TS ? ms : null;
}

function labelFrom(symbol: unknown, name: unknown): TokenLabel {
  return { symbol: text(symbol, SYMBOL_MAX), name: text(name, NAME_MAX) };
}

function hasEvmWallet(wallets: unknown): boolean {
  const evm = obj(wallets).evm;
  return typeof evm === "string" && EVM_ADDRESS.test(evm.trim());
}

/**
 * How the provider knows the EVM wallet belongs to the trader (live:
 * `wallets.evidence.evm`). `provider-claimed` is the vendor's lead, unproven
 * on chain; it is reported, never upgraded. Null when there is no EVM wallet.
 */
function evmWalletEvidenceOf(wallets: unknown): WalletEvidence | null {
  if (!hasEvmWallet(wallets)) return null;
  const e = obj(obj(wallets).evidence).evm;
  return e === "onchain-holdings" || e === "provider-claimed" ? e : null;
}

/** "resolving" means the provider has not finished; holdings unknown, not empty. */
function walletStatusOf(wallets: unknown): TraderProfile["walletStatus"] {
  const w = obj(wallets);
  return w.status === "resolving"
    ? "resolving"
    : typeof w.evm === "string" || typeof w.solana === "string"
      ? "resolved"
      : isObj(wallets) && (w.evm === null || w.solana === null)
        ? "none"
        : "unknown";
}

function sourceOf(v: unknown): CallMeta["providerSource"] {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  // `fomo-live` is the live leaderboard's spelling (observed 2026-10-04).
  if (s === "live" || s === "live-fomo" || s === "fomo-live") return "live";
  if (s === "snapshot") return "snapshot";
  if (s === "captured") return "captured";
  return null;
}

/**
 * The list a body carries under `field`. An explicit `available: false` with
 * no list is an empty answer ("nothing captured for this subject yet"); a body
 * that simply lacks the list is a contract break, and the caller must not be
 * told "empty" when the truth is "unreadable".
 */
function listOf(body: Rec, field: string): unknown[] | null {
  const v = body[field];
  if (Array.isArray(v)) return v;
  if ((v === undefined || v === null) && body.available === false) return [];
  return null;
}

function missingList(field: string): { ok: false; detail: string } {
  return { ok: false, detail: `the answer carried no ${field} list` };
}

function tokenFrom(address: unknown, networkId: unknown, slug: unknown): TokenIdentity | null {
  return tokenIdentity(chainFromProvider(networkId, slug), address);
}

function isTokenAddress(raw: string): boolean {
  return EVM_ADDRESS.test(raw) || SOLANA_MINT.test(raw);
}

/**
 * A chain filter as the vendor spells it, plus the identity we will check the
 * returned rows against. Raw numeric ids are accepted (the vendor documents
 * them) and checked by number. A named EVM network the vendor does not number
 * (bsc, eth, base) is checked against the id its rows were observed carrying
 * (`filterCheckIdentity`), so "bsc" can be verified rather than always reading
 * "nothing to check". The PARAMETER sent is unchanged: whether the vendor
 * wants `eth` or `ethereum` is unverified.
 */
function chainFilter(raw: string): { param: string; identity: ChainIdentity } | null {
  const t = raw.trim().toLowerCase();
  if (/^\d{1,12}$/.test(t)) {
    const id = Number(t);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return { param: t, identity: chainFromProvider(id, undefined) };
  }
  const c = chainFromUserText(t);
  if (!c || !c.slug) return null;
  // Our canonical slugs (robinhood, solana, base, bsc, eth, arc, monad,
  // hyperliquid, …) are the vendor's own filter spellings.
  return { param: c.slug, identity: filterCheckIdentity(c) };
}

// ── Thesis families ──────────────────────────────────────────────────────

/**
 * Evidence family for a thesis: copies, reposts and lightly-edited duplicates
 * share one, so ten accounts pasting one call count once.
 *
 * Normalised before hashing: NFKC (folds full-width lookalikes), lowercase,
 * URLs removed (a repost often only swaps the link), punctuation and symbols
 * removed (`$PONS` and `pons`, `🚀🚀` and nothing), whitespace collapsed.
 * Text that is nothing but a link keeps its link, so two different links do
 * not merge into one empty family.
 */
export function thesisFamilyKey(raw: string): string {
  const base = sanitizeText(raw, THESIS_TEXT_MAX).normalize("NFKC").toLowerCase();
  const norm = base
    .replace(/\b(?:https?:\/\/|www\.)\S+/g, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const material = norm || base;
  return "thf:" + createHash("sha256").update(material).digest("hex").slice(0, 20);
}

// ── Alert and trade frames → TraderEvent ─────────────────────────────────

const CONTROL_FRAMES = new Set(["welcome", "heartbeat", "subscribed", "unsubscribed", "error", "ping", "pong", "retract", "trade"]);

function transferDirection(frame: Rec): "in" | "out" | null {
  for (const v of [frame.direction, frame.side]) {
    if (typeof v !== "string") continue;
    const s = v.trim().toLowerCase();
    if (s === "in" || s === "received" || s === "receive" || s === "incoming") return "in";
    if (s === "out" || s === "sent" || s === "send" || s === "outgoing") return "out";
  }
  return null;
}

/**
 * What the event IS. The vendor's names vary between the stream, REST and the
 * upstream app (`buy`, `large_buy`); every spelling of a purchase maps to
 * `buy`, and nothing that is not a purchase ever does: a transfer moved tokens
 * without paying for them, an airdrop arrived unasked. A transfer whose
 * direction is not stated becomes `other` rather than a guessed direction.
 *
 * A Hyperliquid row with no contract is a PERP whatever its type says: a perp
 * long is a position on a market symbol, not a coin anyone can buy.
 */
function alertKind(alertType: string, chain: ChainIdentity, hasContract: boolean, frame: Rec): ActivityKind {
  const t = alertType.trim().toLowerCase().replace(/-/g, "_");
  if (t === "thesis" || t === "thesis_created") return "thesis";
  if (t === "perp" || (chain.namespace === "hyperliquid" && !hasContract)) return "perp";
  if (t === "buy" || t === "large_buy") return "buy";
  if (t === "sell" || t === "large_sell") return "sell";
  if (t === "listing") return "listing";
  if (t === "airdrop" || t === "airdrop_received") return "airdrop";
  if (t === "transfer_in" || t === "transferin" || t === "received" || t === "receive") return "transfer-in";
  if (t === "transfer_out" || t === "transferout" || t === "sent" || t === "send") return "transfer-out";
  if (t === "transfer") {
    const d = transferDirection(frame);
    return d === "in" ? "transfer-in" : d === "out" ? "transfer-out" : "other";
  }
  return "other";
}

function txHashOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!EVENT_GUARDS.TX_HASH.test(s)) return null;
  return s.startsWith("0x") ? s.toLowerCase() : s;
}

/** The feed's `alrt_<ms>_<seq>` id and its sequence, or nulls for anything else (a doc fixture's UUID id). */
function providerAlertIdOf(v: unknown): { id: string | null; seq: number | null } {
  if (typeof v !== "string") return { id: null, seq: null };
  const s = v.trim();
  const m = PROVIDER_ALERT_ID.exec(s);
  if (!m?.[1]) return { id: null, seq: null };
  const seq = Number(m[1]);
  return Number.isSafeInteger(seq) ? { id: s, seq } : { id: null, seq: null };
}

/** A perp's action, side and leverage from its (sanitised) alert text, or null when the text is not the one known shape. */
function perpFromText(t: string | null): PerpDetail | null {
  if (!t) return null;
  const m = PERP_TEXT.exec(t);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const leverage = Number(m[3]);
  if (!Number.isSafeInteger(leverage) || leverage < 1) return null;
  return { action: m[1] === "Open" ? "open" : "close", side: m[2] === "Long" ? "long" : "short", leverage };
}

/**
 * Alert text, sanitised and capped. A thesis alert carries the thesis itself
 * (live: up to 340 characters), so it gets the thesis cap. A buy or sell loses
 * the vendor's trailing money parenthetical (see MONEY_PAREN).
 */
function alertText(raw: unknown, kind: ActivityKind): string | null {
  const t = text(raw, kind === "thesis" ? THESIS_TEXT_MAX : ALERT_TEXT_MAX);
  if (t === null || (kind !== "buy" && kind !== "sell")) return t;
  return t.replace(MONEY_PAREN, "").trim() || null;
}

/**
 * One app-feed alert — a REST `/v2/alerts` row or a `/ws/alerts` frame, which
 * share a shape — as a `TraderEvent`. Null for control frames and for alerts
 * that name no user id (push-sourced alerts carry none, and an event we cannot
 * attribute to a stable trader is not one we can file).
 *
 * THE MONEY FIELDS ARE THE DANGEROUS PART, and each is read from exactly one
 * source field:
 *
 *   positionValueUsd   ONLY `positionValueUsd`: the position's mark AFTER the
 *                      fill. On an add to a $40k position it is ~$40k, however
 *                      small the add.
 *   fillUsd            ONLY `tradeUsd`, ONLY when `fillMatch` is
 *                      `onchain-exact` — the vendor matched exactly one on-chain
 *                      execution — and ONLY on a buy or a sell. `ambiguous`
 *                      (several candidates) attaches no fill, and neither does
 *                      an absent match. A transfer, airdrop, listing, thesis,
 *                      perp or unknown alert never gets a fill, a fill basis or
 *                      `provider-verified`, whatever its `fillMatch` says: a
 *                      received token is not a purchase, and a matched
 *                      execution on one is not a price paid.
 *   cumulative PnL     `realizedPnlUsd` is the position's RUNNING TOTAL; it is
 *                      carried per event and never summed (summing four sells
 *                      of one position was measured at 2.6x the real loss).
 *
 * `usdValue` is NOT read for any of them. It mirrors whichever of the mark or
 * the cumulative PnL applies to that alert type, so using it as a fill size
 * would book a $40k position mark as a $40k purchase, or a running loss as a
 * sale amount. (Live census, 2026-10-04: on every buy it equalled the mark, on
 * every sell the cumulative P&L, and no sell carried a mark at all.)
 *
 * The block time (`execTs`) is gated exactly like the fill and the hash: a
 * time from a match the vendor did not call exact is not this event's time.
 *
 * REST rows name the kind in `type`; stream frames say `type: "alert"` and
 * name it in `alertType`. Both are read.
 */
export function alertFrameToEvent(frame: unknown, observedAt: number, source: EventSource): TraderEvent | null {
  if (!isObj(frame)) return null;
  const type = typeof frame.type === "string" ? frame.type.trim().toLowerCase() : null;
  if (type && CONTROL_FRAMES.has(type)) return null;
  const alertType =
    typeof frame.alertType === "string" ? frame.alertType : type && type !== "alert" ? type : null;
  if (!alertType || !alertType.trim()) return null;
  const userId = uuidOf(frame.userId);
  if (!userId) return null;

  const tokenObj = obj(frame.token);
  const rawAddress = frame.tokenAddress ?? tokenObj.address;
  const hasContract = typeof rawAddress === "string" && rawAddress.trim() !== "";
  const chain = chainFromProvider(frame.chainId ?? tokenObj.networkId, frame.chain ?? tokenObj.chain);
  const kind = alertKind(alertType, chain, hasContract, frame);
  // A perp names a market, not a contract: there is no token identity to have.
  const token = kind === "perp" ? null : tokenIdentity(chain, rawAddress);
  const symbol = typeof frame.token === "string" ? frame.token : tokenObj.symbol;

  const exact = frame.fillMatch === "onchain-exact";
  // Only a buy or a sell is a fill: the gate below holds whatever the vendor's match says about another kind.
  const fillKind = kind === "buy" || kind === "sell";
  const tradeUsd = typeof frame.tradeUsd === "number" && Number.isFinite(frame.tradeUsd) && frame.tradeUsd > 0 ? frame.tradeUsd : null;
  const fillUsd = exact && fillKind ? tradeUsd : null;
  const positionValueUsd =
    typeof frame.positionValueUsd === "number" && Number.isFinite(frame.positionValueUsd) && frame.positionValueUsd >= 0
      ? frame.positionValueUsd
      : null;
  const realized = typeof frame.realizedPnlUsd === "number" && Number.isFinite(frame.realizedPnlUsd) ? frame.realizedPnlUsd : null;
  // A hash the vendor did not claim to have matched is not evidence of which execution this was.
  const txHash = exact ? txHashOf(frame.txHash) : null;
  const swapId = idOf(frame.swapId);
  const sourceEventAt = toMs(frame.ts);
  const traderObj = obj(frame.trader);
  const handle = handleOf(typeof frame.trader === "string" ? frame.trader : traderObj.handle ?? frame.handle);
  const alertId = providerAlertIdOf(frame.id);
  const body = alertText(frame.text, kind);
  const priceSource = typeof frame.tradeUsdSource === "string" ? frame.tradeUsdSource.trim().toLowerCase() : "";

  const ident = eventIdentity({
    eventId: frame.eventId ?? frame.id,
    swapId,
    txHash,
    userId,
    actor: handle ?? undefined,
    tokenKey: token?.key ?? null,
    kind,
    sourceEventAt,
    usd: frame.usdValue,
  });

  return {
    eventKey: ident.eventKey,
    identityBasis: ident.basis,
    identityAmbiguous: ident.ambiguous,
    source,
    kind,
    trader: {
      userId,
      handle,
      displayName: text(frame.displayName ?? traderObj.displayName, NAME_MAX),
      verified: bool(frame.verified ?? traderObj.verified),
    },
    token,
    tokenLabel: { symbol: text(symbol, SYMBOL_MAX), name: text(tokenObj.name, NAME_MAX) },
    tradeId: idOf(frame.tradeId),
    swapId,
    transferId: idOf(frame.transferId),
    txHash,
    fillUsd,
    fillUsdBasis: fillUsd !== null ? "onchain-exact" : fillKind && frame.fillMatch === "ambiguous" ? "ambiguous" : null,
    positionValueUsd,
    positionRealizedPnlUsdCumulative: realized,
    sourceEventAt,
    execAt: exact ? toMs(frame.execTs) : null,
    observedAt,
    verification: exact && fillKind ? "provider-verified" : "provider-reported",
    text: body,
    replay: source === "stream" && frame.replay === true,
    providerAlertId: alertId.id,
    providerAlertSeq: alertId.seq,
    fillUsdSource: fillUsd !== null && SHORT_SLUG.test(priceSource) ? priceSource : null,
    perp: kind === "perp" ? perpFromText(body) : null,
  };
}

/** A `/ws/trades` retraction: the vendor decided an already-sent trade was not one of its users'. */
export interface TradeRetraction {
  retract: string;
  /** The key the retracted trade was filed under, when it carried this id. */
  eventKey: string;
}

/**
 * One `/ws/trades` frame (the on-chain stream) as a `TraderEvent`.
 *
 * An on-chain frame names a WALLET, not a person: `trader: {wallet, handle}`.
 * `TraderIdentity` is keyed on the vendor's user id, and a wallet-shaped stand-in
 * there would leak an address into every join and render. So the frame becomes
 * an event only when it carries a user id or the caller's `resolveUserId` maps
 * the wallet to one (from wallets it already resolved); otherwise it is null.
 * The wallet is handed to the resolver and never copied into the event.
 *
 * The fill size IS exact here: the frame is the execution itself, read off the
 * chain. What `verified` grades is whether the wallet belongs to a vendor user:
 * `db` and `relay` are the vendor's own confirmations; `code` is a shape rule
 * with confirmation pending, so it stays provider-reported.
 */
export function tradeFrameToEvent(
  frame: unknown,
  observedAt: number,
  resolveUserId?: (wallet: string, chain: ChainIdentity) => string | null,
): TraderEvent | TradeRetraction | null {
  if (!isObj(frame)) return null;
  if (frame.type === "retract") {
    const id = idOf(frame.id);
    return id ? { retract: id, eventKey: eventIdentity({ eventId: id, kind: "other" }).eventKey } : null;
  }
  if (frame.type !== "trade") return null;
  const chain = chainFromProvider(frame.chainId, frame.chain);
  const traderObj = obj(frame.trader);
  const walletRaw = typeof traderObj.wallet === "string" ? traderObj.wallet.trim() : "";
  const wallet = isTokenAddress(walletRaw) ? (walletRaw.startsWith("0x") ? walletRaw.toLowerCase() : walletRaw) : null;
  let userId = uuidOf(traderObj.userId) ?? uuidOf(frame.userId);
  if (!userId && wallet && resolveUserId) userId = uuidOf(resolveUserId(wallet, chain));
  if (!userId) return null;

  const side = typeof frame.side === "string" ? frame.side.trim().toLowerCase() : "";
  const kind: ActivityKind = side === "buy" ? "buy" : side === "sell" ? "sell" : "other";
  const tokenObj = obj(frame.token);
  const token = tokenIdentity(chain, tokenObj.address);
  // As on the app feed: a frame that is not a buy or a sell is not a fill, whatever value it carries.
  const fillUsd = (kind === "buy" || kind === "sell") && typeof frame.usdValue === "number" && Number.isFinite(frame.usdValue) && frame.usdValue > 0 ? frame.usdValue : null;
  const at = toMs(frame.blockTs);
  const txHash = txHashOf(frame.txHash);
  const verified = typeof frame.verified === "string" ? frame.verified.trim().toLowerCase() : "";
  const handle = handleOf(traderObj.handle);
  const ident = eventIdentity({
    eventId: frame.id,
    txHash,
    logIndex: frame.logIndex,
    userId,
    tokenKey: token?.key ?? null,
    kind,
    sourceEventAt: at,
    amountToken: frame.amountToken,
    usd: frame.usdValue,
  });
  return {
    eventKey: ident.eventKey,
    identityBasis: ident.basis,
    identityAmbiguous: ident.ambiguous,
    source: "stream",
    kind,
    trader: { userId, handle, displayName: null, verified: null },
    token,
    tokenLabel: { symbol: text(tokenObj.symbol, SYMBOL_MAX), name: text(tokenObj.name, NAME_MAX) },
    tradeId: idOf(frame.tradeId),
    swapId: null,
    transferId: null,
    txHash,
    fillUsd,
    fillUsdBasis: fillUsd !== null ? "onchain-exact" : null,
    positionValueUsd: null,
    positionRealizedPnlUsdCumulative: null,
    sourceEventAt: at,
    execAt: at,
    observedAt,
    // Verification is a claim about a fill: only a buy or sell frame can carry it.
    verification: (kind === "buy" || kind === "sell") && (verified === "db" || verified === "relay") ? "provider-verified" : "provider-reported",
    text: null,
    replay: frame.replay === true,
  };
}

// ── Websocket URLs ───────────────────────────────────────────────────────

export interface AlertsStreamFilters {
  userId?: string;
  chain?: string;
  type?: string;
  token?: string;
  source?: "feed" | "push";
}

export interface TradesStreamFilters {
  chain?: "robinhood" | "solana";
  /** A handle. Wallet filters are not offered: wallets are not surfaced by this subsystem. */
  trader?: string;
  token?: string;
  side?: "buy" | "sell";
  minUsd?: number;
}

/**
 * A stream URL. `url` carries the key and must never be logged; `redacted` is
 * the same URL with the key replaced by `***`.
 */
export type StreamUrl = { ok: true; url: string; redacted: string } | { ok: false; failure: "no-key" | "bad-request"; detail: string };

/** Remove key values from ANY string: `key=`, `apiKey=`, `api_key=` query parameters. */
export function redactUrl(raw: string): string {
  return String(raw).replace(/([?&;](?:amp;)?)(key|apikey|api_key|api-key)=([^&#\s"'<>]*)/gi, (_m, sep: string, name: string) => `${sep}${name}=***`);
}

function streamUrl(path: string, apiKey: string, filters: Array<[string, string]>): StreamUrl {
  if (!apiKey) return { ok: false, failure: "no-key", detail: "no provider key is configured" };
  if (!KEY_SHAPE.test(apiKey)) return { ok: false, failure: "no-key", detail: "the configured key has an unusable shape" };
  const url = new URL(path, WS_ORIGIN);
  for (const [k, v] of filters) url.searchParams.set(k, v);
  // Last, so a log line cut short by width is less likely to reach it. The redaction is the real guard.
  url.searchParams.set("key", apiKey);
  const s = url.toString();
  return { ok: true, url: s, redacted: redactUrl(s) };
}

function tokenFilter(raw: string): string | null {
  const t = raw.trim();
  if (EVM_ADDRESS.test(t)) return t.toLowerCase();
  if (SOLANA_MINT.test(t) || TOKEN_SYMBOL.test(t)) return t;
  return null;
}

export function alertsStreamUrl(apiKey: string, filters: AlertsStreamFilters = {}): StreamUrl {
  const out: Array<[string, string]> = [];
  if (filters.userId !== undefined) {
    const u = uuidOf(filters.userId);
    if (!u) return { ok: false, failure: "bad-request", detail: "userId must be a FOMO user id (UUID)" };
    out.push(["userId", u]);
  }
  if (filters.chain !== undefined) {
    const c = chainFilter(filters.chain);
    if (!c) return { ok: false, failure: "bad-request", detail: "unknown chain filter" };
    out.push(["chain", c.param]);
  }
  if (filters.type !== undefined) {
    if (!ALERT_TYPE.test(filters.type)) return { ok: false, failure: "bad-request", detail: "unknown alert type" };
    out.push(["type", filters.type]);
  }
  if (filters.token !== undefined) {
    const t = tokenFilter(filters.token);
    if (!t) return { ok: false, failure: "bad-request", detail: "token must be a symbol or a contract address" };
    out.push(["token", t]);
  }
  if (filters.source !== undefined) {
    if (filters.source !== "feed" && filters.source !== "push") return { ok: false, failure: "bad-request", detail: "source must be feed or push" };
    out.push(["source", filters.source]);
  }
  return streamUrl("/ws/alerts", apiKey, out);
}

export function tradesStreamUrl(apiKey: string, filters: TradesStreamFilters = {}): StreamUrl {
  const out: Array<[string, string]> = [];
  if (filters.chain !== undefined) {
    if (filters.chain !== "robinhood" && filters.chain !== "solana") return { ok: false, failure: "bad-request", detail: "the on-chain stream covers robinhood and solana only" };
    out.push(["chain", filters.chain]);
  }
  if (filters.trader !== undefined) {
    const h = HANDLE.test(filters.trader) && !/^@?\.+$/.test(filters.trader) ? filters.trader.replace(/^@/, "") : null;
    if (!h) return { ok: false, failure: "bad-request", detail: "trader must be a handle" };
    out.push(["trader", h]);
  }
  if (filters.token !== undefined) {
    const t = tokenFilter(filters.token);
    if (!t || !(EVM_ADDRESS.test(t) || SOLANA_MINT.test(t))) return { ok: false, failure: "bad-request", detail: "token must be a contract address" };
    out.push(["token", t]);
  }
  if (filters.side !== undefined) {
    if (filters.side !== "buy" && filters.side !== "sell") return { ok: false, failure: "bad-request", detail: "side must be buy or sell" };
    out.push(["side", filters.side]);
  }
  if (filters.minUsd !== undefined) {
    if (!Number.isFinite(filters.minUsd) || filters.minUsd < 0 || filters.minUsd > 1e9) return { ok: false, failure: "bad-request", detail: "minUsd out of range" };
    out.push(["minUsd", String(Math.floor(filters.minUsd))]);
  }
  return streamUrl("/ws/trades", apiKey, out);
}

// ── Normalisers (pure; body → contract) ──────────────────────────────────

function positionFromRow(row: Rec): PositionRow | null {
  const tok = obj(row.token);
  const chain = chainFromProvider(row.chainId ?? tok.networkId ?? row.networkId, row.chain ?? tok.chain);
  const token = tokenIdentity(chain, tok.address ?? row.tokenAddress);
  const tradeId = idOf(row.tradeId);
  // A row that names neither a position nor a token cannot be joined to anything.
  if (!token && !tradeId) return null;
  const bought = nonNeg(row.boughtAmount);
  const sold = nonNeg(row.soldAmount);
  const tin = nonNeg(row.transferredInAmount);
  const tout = nonNeg(row.transferredOutAmount);
  // The vendor's reconciliation (149/150 exact). Derived only when every term is known.
  const derived = bought !== null && sold !== null && tin !== null && tout !== null ? bought - sold + tin - tout : null;
  const status = row.status === "open" || row.status === "closed" ? row.status : null;
  return {
    tradeId,
    token,
    label: labelFrom(tok.symbol ?? row.symbol, tok.name),
    status,
    costBasisUsd: nonNeg(row.costBasisUsd),
    boughtAmount: bought,
    soldAmount: sold,
    transferredInAmount: tin,
    transferredOutAmount: tout,
    amount: nonNeg(row.amount) ?? derived,
    // Null EXACTLY when the position was never bought (received, not purchased). Kept null.
    avgEntryPrice: nonNeg(row.avgEntryPrice),
    avgExitPrice: nonNeg(row.avgExitPrice),
    realizedPnlUsd: num(row.realizedPnlUsd),
    unrealizedPnlUsd: num(row.unrealizedPnlUsd),
    openedAt: toMs(row.createdAt ?? row.openedAt),
    closedAt: toMs(row.closedAt),
    source: row.source === "captured" ? "captured" : row.source === "feed" ? "feed" : "unknown",
  };
}

function normalizeLeaderboard(body: Rec, window: RankingWindow): Norm<LeaderboardPage> {
  if (typeof body.window === "string" && body.window !== window) {
    return { ok: false, detail: "the board answered for a different window" };
  }
  const list = listOf(body, "traders");
  if (!list) return missingList("traders");
  const rows: RankingRow[] = [];
  let dropped = 0;
  let topTokensDropped = 0;
  for (const raw of list) {
    const r = obj(raw);
    const userId = uuidOf(r.userId);
    if (!userId) {
      dropped++;
      continue;
    }
    // Two shapes: the documentation's truncated address prefixes (strings),
    // and the live answer's full objects {tokenAddress, networkId, value, pnl, …}.
    const hints: string[] = [];
    const topTokens: TopTokenHolding[] = [];
    for (const el of Array.isArray(r.topTokens) ? r.topTokens : []) {
      if (typeof el === "string") {
        const h = sanitizeText(el, 44);
        if (TOKEN_HINT.test(h) && hints.length < TOKEN_HINTS_MAX) hints.push(h);
        continue;
      }
      const t = obj(el);
      const token = isObj(el) ? tokenFrom(t.tokenAddress ?? t.address, t.networkId ?? t.chainId, t.chain ?? t.network) : null;
      if (!token) {
        topTokensDropped++;
        continue;
      }
      // The per-token `pnl` carries no window, whatever board it came on: it is never the row's window P&L.
      if (topTokens.length < TOKEN_HINTS_MAX) topTokens.push({ token, valueUsd: nonNeg(t.value ?? t.valueUsd), unwindowedPnlUsd: num(t.pnl ?? t.pnlUsd) });
    }
    const rank = count(r.rank);
    rows.push({
      rank: rank !== null && rank >= 1 ? rank : null,
      window,
      // `verified` here is the PROFILE badge; `wallets.verified` is a different fact (walletsVerified).
      trader: { userId, handle: handleOf(r.handle), displayName: text(r.displayName, NAME_MAX), verified: bool(r.verified) },
      pnlUsd: num(r.pnlUsd),
      volumeUsd: nonNeg(r.volumeUsd),
      trades: count(r.trades),
      followers: count(r.followers),
      holdingsCount: count(r.holdings),
      topTokenHints: hints,
      // Whether one was resolved, never which: the address itself is not surfaced.
      hasEvmWallet: hasEvmWallet(r.wallets),
      topTokens,
      evmWalletEvidence: evmWalletEvidenceOf(r.wallets),
      walletsVerified: bool(obj(r.wallets).verified),
      following: count(r.following),
      accountCreatedAt: toMs(r.createdAt),
    });
  }
  return { ok: true, data: { rows, dropped, window, providerCount: count(body.count), topTokensDropped } };
}

function normalizeProfile(body: Rec, expectUserId: string | null): Norm<TraderProfile> {
  const userId = uuidOf(body.userId);
  if (!userId) return { ok: false, detail: "the profile carried no user id" };
  if (expectUserId && userId !== expectUserId) return { ok: false, detail: "the profile is for a different user id" };
  const pnl = obj(body.pnl);
  const profile = obj(body.profile);
  const wallets = body.wallets;
  const walletStatus = walletStatusOf(wallets);
  return {
    ok: true,
    data: {
      trader: {
        userId,
        handle: handleOf(body.handle ?? body.userHandle),
        displayName: text(body.displayName, NAME_MAX),
        verified: bool(body.verified),
      },
      pnlUsd: { "24h": num(pnl["24h"]), "7d": num(pnl["7d"]), "30d": num(pnl["30d"]), all: num(pnl.all) ?? num(body.pnlUsd) },
      volumeUsd: nonNeg(body.volumeUsd) ?? nonNeg(body.totalVolume),
      trades: count(body.trades) ?? count(body.numTrades),
      followers: count(body.followers) ?? count(profile.followers),
      following: count(body.following),
      accountAgeDays: count(body.accountAgeDays) ?? count(profile.accountAgeDays),
      averageHoldTimeSeconds: nonNeg(body.averageHoldTimeSeconds) ?? nonNeg(profile.averageHoldTimeSeconds),
      hasEvmWallet: hasEvmWallet(wallets),
      walletStatus,
    },
  };
}

/**
 * A body that names a different trader than we asked about is not an answer
 * about ours. Live per-trader answers also name the subject as `key` (the
 * user id), and the holdings answer carries no `userId` at all, so `key` is
 * the check there. Where `userId` is present it is the authority: `key` is
 * not observed on every route, and its meaning is only known where it was.
 */
function sameUser(body: Rec, userId: string): boolean {
  const named = uuidOf(body.userId) ?? (body.userId === undefined || body.userId === null ? uuidOf(body.key) : null);
  return named === null || named === userId;
}

function normalizePositions(body: Rec, userId: string): Norm<PositionsPage> {
  if (!sameUser(body, userId)) return { ok: false, detail: "the answer is for a different user id" };
  const list = listOf(body, "trades") ?? listOf(body, "positions");
  if (!list) return missingList("trades");
  const rows: PositionRow[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = obj(raw);
    const owner = uuidOf(r.userId);
    const p = isObj(raw) && (owner === null || owner === userId) ? positionFromRow(r) : null;
    if (!p) {
      dropped++;
      continue;
    }
    rows.push(p);
  }
  return {
    ok: true,
    data: {
      rows,
      dropped,
      userId,
      nextCursor: cursorOf(body.nextCursor),
      truncated: bool(body.truncated),
      openCount: count(body.openCount),
      closedCount: count(body.closedCount),
      closedTotalOnFomo: count(body.closedTotalOnFomo),
      complete: bool(body.complete),
      partial: bool(body.partial),
      available: bool(body.available),
    },
  };
}

const NO_CHAIN: ChainIdentity = { namespace: "unknown", networkId: null, slug: null };

/** The chain a leg names for itself, when it names a recognisable one (live legs name none). */
function legChainOf(l: Rec): ChainIdentity | null {
  const id = l.chainId ?? l.networkId;
  const slug = l.chain ?? l.network;
  if ((id === undefined || id === null) && (slug === undefined || slug === null)) return null;
  const c = chainFromProvider(id, slug);
  return c.namespace === "unknown" ? null : c;
}

/**
 * One leg of a fill. The row's chain describes the NON-cash leg only: live
 * fills on Robinhood, Ethereum and BNB pay with a Solana USDC leg. So a leg is
 * placed on the row's chain only when it IS the row's own token (`own`: the
 * leg a position id names) or when the leg names its own chain. Any other leg
 * is the cash side and is placed by its shape alone, on an unknown network: a
 * base58 mint becomes Solana with no network id, a 0x address EVM with no
 * network id. Readable, never executable: an EVM-shaped cash leg is never
 * assumed to be on the row's chain, so a stablecoin on another EVM chain can
 * never pass for a Robinhood token. (A base58 leg on a Solana row stays on it:
 * its shape alone places it there.)
 */
function leg(raw: unknown, rowChain: ChainIdentity, own: boolean): FillRow["tokenIn"] {
  const l = obj(raw);
  const stated = legChainOf(l);
  const place = stated ?? (own || rowChain.namespace === "solana" ? rowChain : NO_CHAIN);
  const token = tokenIdentity(place, l.address) ?? tokenIdentity(NO_CHAIN, l.address);
  return { token, amount: nonNeg(l.amount), usd: nonNeg(l.usd) };
}

/**
 * Which legs are the row's own token. A position id names it (live: exactly
 * one of `tradeIdIn`/`tradeIdOut` on every fill, the bought or sold token).
 * With neither id, the one leg whose shape fits the row's chain is its own when
 * exactly one does; with two EVM legs and no id, neither is assumed to be.
 */
function ownLegs(r: Rec, rowChain: ChainIdentity): { inOwn: boolean; outOwn: boolean } {
  const inOwn = idOf(r.tradeIdIn) !== null;
  const outOwn = idOf(r.tradeIdOut) !== null;
  if (inOwn || outOwn) return { inOwn, outOwn };
  // On an EVM row a cash leg from another EVM network has the same shape as
  // the row's own token, so shape cannot tell them apart: with no position id,
  // neither leg is placed on the row's network (and so neither can ever pass
  // isRobinhoodToken). Shape still decides on a non-EVM row.
  if (rowChain.namespace === "eip155") return { inOwn: false, outOwn: false };
  const fits = (raw: unknown): boolean => tokenIdentity(rowChain, obj(raw).address) !== null;
  const fi = fits(r.tokenIn);
  const fo = fits(r.tokenOut);
  return fi !== fo ? { inOwn: fi, outOwn: fo } : { inOwn: false, outOwn: false };
}

/** Whether two placed legs are on different chains; null when either network is not known. */
function legsCrossChain(a: TokenIdentity | null, b: TokenIdentity | null): boolean | null {
  if (!a || !b) return null;
  if (a.chain.namespace !== b.chain.namespace) return true;
  if (a.chain.networkId === null || b.chain.networkId === null) return null;
  return a.chain.networkId !== b.chain.networkId;
}

function normalizeSwaps(body: Rec, userId: string): Norm<SwapsPage> {
  if (!sameUser(body, userId)) return { ok: false, detail: "the answer is for a different user id" };
  const list = listOf(body, "swaps");
  if (!list) return missingList("swaps");
  const rows: FillRow[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = obj(raw);
    const chain = chainFromProvider(r.chainId, r.chain);
    const own = ownLegs(r, chain);
    const tokenIn = leg(r.tokenIn, chain, own.inOwn);
    const tokenOut = leg(r.tokenOut, chain, own.outOwn);
    if (!isObj(raw) || (!tokenIn.token && !tokenOut.token)) {
      dropped++;
      continue;
    }
    rows.push({
      swapId: idOf(r.swapId),
      chain,
      tokenIn,
      tokenOut,
      tradeIdIn: idOf(r.tradeIdIn),
      tradeIdOut: idOf(r.tradeIdOut),
      at: toMs(r.at),
      crossChain: legsCrossChain(tokenIn.token, tokenOut.token),
    });
  }
  const nextCursor = cursorOf(body.nextCursor);
  return {
    ok: true,
    data: {
      rows,
      dropped,
      userId,
      nextCursor,
      // A cursor handed back means more MAY exist; only the vendor's own word says there is no more.
      moreAvailable: bool(body.moreAvailable) ?? (nextCursor !== null ? true : null),
      complete: bool(body.complete),
      partial: bool(body.partial),
      sourceCapped: bool(body.sourceCapped),
      providerCount: count(body.count),
    },
  };
}

function normalizeBalances(body: Rec, userId: string, filter: { slug: string; identity: ChainIdentity } | null): Norm<BalancesSnapshot> {
  if (!sameUser(body, userId)) return { ok: false, detail: "the answer is for a different user id" };
  const list = listOf(body, "holdings");
  if (!list) return missingList("holdings");
  const rows: HoldingRow[] = [];
  let dropped = 0;
  let unpricedRows = 0;
  let excludedRows = 0;
  for (const raw of list) {
    const r = obj(raw);
    const tok = obj(r.token);
    const token = tokenFrom(tok.address, tok.networkId ?? r.networkId ?? r.chainId, r.chain ?? tok.chain);
    if (!token) {
      dropped++;
      continue;
    }
    // The vendor sends price 0 (and value 0) for a token it cannot price,
    // however many units are held: that is "no price", never "worthless".
    // A nonzero price whose value rounds to 0 is real dust and stays 0.
    const price = nonNeg(r.priceUsd);
    const unpriced = price === 0;
    const valueUsd = unpriced ? null : nonNeg(r.valueUsd);
    const excluded = r.includeInEquity === false;
    if (unpriced) unpricedRows++;
    if (excluded) excludedRows++;
    rows.push({
      token,
      label: labelFrom(tok.symbol, tok.name),
      amount: nonNeg(r.amount),
      priceUsd: unpriced ? null : price,
      valueUsd,
      change24hPct: num(r.change24h),
      includedInTotal: valueUsd !== null && !excluded,
    });
  }
  // Our sum over the rows we KEPT that count toward a total (priced, not
  // excluded by the vendor). The vendor's totalValueUsd is the same sum over
  // the rows it served; ours stays consistent with what we hold when a row
  // was dropped. Either way it excludes perps, other equity and anything past
  // the cap, so it is a floor, never the portfolio.
  const known = rows.filter((r) => r.includedInTotal).map((r) => r.valueUsd as number);
  const floor = known.length > 0 ? known.reduce((a, b) => a + b, 0) : rows.length === 0 ? nonNeg(body.totalValueUsd) : null;
  const perps = obj(body.hyperliquidPerps);
  const upstreamRows = count(body.upstreamRows);
  // The vendor flags the cut. A page AT the documented cap with no flag is
  // treated as cut too: "the cap was not hit" is the claim that needs proof.
  const truncated =
    body.truncated === true || (typeof body.truncated !== "boolean" && (upstreamRows ?? list.length) >= HOLDINGS_CAP);
  const vendorComplete = bool(body.complete);
  return {
    ok: true,
    data: {
      trader: { userId, handle: handleOf(body.handle), displayName: null, verified: null },
      rows,
      truncated,
      totalValueUsdFloor: floor,
      complete: dropped > 0 || truncated ? false : vendorComplete,
      chainFilterRequested: filter?.slug ?? null,
      // Accepting `?chain=` proves nothing; only the rows' own networks do.
      chainFilterHonoured: filter ? verifyChainFilter(filter.identity, rows.map((r) => r.token)).honoured : null,
      dropped,
      upstreamRows,
      available: bool(body.available),
      unpricedRows,
      excludedRows,
      providerTotalValueUsd: nonNeg(body.totalValueUsd),
      excluded: {
        otherEquityUsd: num(body.otherEquity),
        livePerpPnlUsd: num(body.livePerpPnl),
        perpPositions: Array.isArray(perps.positions) ? perps.positions.length : null,
        nativeEvmRows: Array.isArray(body.nativeEvmBalances) ? body.nativeEvmBalances.length : null,
      },
    },
  };
}

function normalizeFollowing(body: Rec, userId: string): Norm<FollowingPage> {
  if (!sameUser(body, userId)) return { ok: false, detail: "the answer is for a different user id" };
  const list = listOf(body, "following");
  if (!list) return missingList("following");
  const rows: FollowedTrader[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = obj(raw);
    const id = uuidOf(r.userId);
    if (!id) {
      dropped++;
      continue;
    }
    rows.push({
      trader: { userId: id, handle: handleOf(r.handle), displayName: text(r.displayName, NAME_MAX), verified: bool(r.verified) },
      followers: count(r.followers),
      following: count(r.following),
      trades: count(r.trades),
      volumeUsd: nonNeg(r.volumeUsd),
      pnl24hUsd: num(r.pnl24h),
      accountAgeDays: count(r.accountAgeDays),
    });
  }
  return {
    ok: true,
    data: {
      rows,
      dropped,
      userId,
      truncated: bool(body.truncated),
      complete: bool(body.complete),
      partial: bool(body.partial),
      sourceCapped: bool(body.sourceCapped),
      profileFollowing: count(body.profileFollowing),
    },
  };
}

function spotlightItem(raw: unknown): SpotlightItem | null {
  if (!isObj(raw)) return null;
  const tradeId = idOf(raw.tradeId);
  if (!tradeId) return null;
  const tok = obj(raw.token);
  const thesis = raw.thesis;
  return {
    tradeId,
    token: tokenFrom(tok.address, raw.chainId ?? tok.networkId ?? raw.networkId, raw.chain ?? tok.chain),
    label: labelFrom(tok.symbol, tok.name),
    avgEntryPrice: nonNeg(raw.avgEntryPrice),
    avgExitPrice: nonNeg(raw.avgExitPrice),
    costBasisUsd: nonNeg(raw.costBasisUsd),
    realizedPnlUsd: num(raw.realizedPnlUsd),
    unrealizedPnlUsd: num(raw.unrealizedPnlUsd),
    thesisText: text(isObj(thesis) ? thesis.text : thesis, THESIS_TEXT_MAX),
    thesisLikes: count(raw.thesisLikes ?? (isObj(thesis) ? thesis.likes : undefined)),
    openedAt: toMs(raw.openedAt),
    closedAt: toMs(raw.closedAt),
  };
}

function normalizeSpotlight(body: Rec, userId: string): Norm<SpotlightResult> {
  if (!sameUser(body, userId)) return { ok: false, detail: "the answer is for a different user id" };
  const trades = listOf(body, "bestTrades");
  const theses = listOf(body, "bestTheses");
  if (!trades && !theses) return missingList("bestTrades");
  let dropped = 0;
  const pick = (list: unknown[] | null): SpotlightItem[] => {
    const out: SpotlightItem[] = [];
    for (const raw of list ?? []) {
      const it = spotlightItem(raw);
      if (it) out.push(it);
      else dropped++;
    }
    return out;
  };
  const bestTrades = pick(trades);
  const bestTheses = pick(theses);
  return { ok: true, data: { userId, handle: handleOf(body.handle), bestTrades, bestTheses, dropped } };
}

interface ThesisContext {
  filter: { slug: string; identity: ChainIdentity } | null;
  pagesRequested: number;
  /** For per-coin routes: rows may omit the token they are about. */
  defaultAddress: string | null;
  /** For per-user routes: a row by someone else is not this user's thesis. */
  expectUserId: string | null;
  /**
   * Whether the route populates `equity`. Only the global feed does: the
   * per-coin route sent `equity: 0` on every row live, including authors with
   * open positions, so there it is "not populated", never a $0 stake.
   */
  equityMeaningful: boolean;
}

function sameAddress(a: string, b: string): boolean {
  return a.startsWith("0x") || b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The author's stake on the coin, only where the route populates it and only when it does not contradict the position. */
function authorEquityOf(r: Rec, meaningful: boolean): number | null {
  if (!meaningful) return null;
  const e = nonNeg(r.equity);
  if (e !== 0) return e;
  // A zero stake beside an open position's P&L or a positive trade size is a placeholder, not a stake.
  const unrealized = num(r.unrealizedPnlUsd);
  const trade = nonNeg(r.tradeUsd);
  return (unrealized !== null && unrealized !== 0) || (trade !== null && trade > 0) ? null : 0;
}

function authorPositionOf(r: Rec): Thesis["authorPosition"] {
  const p = { tradeUsd: nonNeg(r.tradeUsd), realizedPnlUsd: num(r.realizedPnlUsd), unrealizedPnlUsd: num(r.unrealizedPnlUsd) };
  return p.tradeUsd === null && p.realizedPnlUsd === null && p.unrealizedPnlUsd === null ? null : p;
}

function normalizeTheses(body: Rec, ctx: ThesisContext): Norm<ThesesPage> {
  // Live per-coin answers name their subject as `key`. One that names another
  // coin is not an answer about ours (an address-shaped key only: other routes
  // use other key forms).
  const keyed = typeof body.key === "string" ? body.key.trim() : "";
  if (ctx.defaultAddress && isTokenAddress(keyed) && !sameAddress(keyed, ctx.defaultAddress)) {
    return { ok: false, detail: "the answer is for a different token" };
  }
  const list = listOf(body, "theses");
  if (!list) return missingList("theses");
  const rows: Thesis[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = obj(raw);
    const id = idOf(r.id);
    const userId = uuidOf(r.userId);
    const body_ = text(r.text, THESIS_TEXT_MAX);
    if (!id || !userId || !body_ || (ctx.expectUserId && userId !== ctx.expectUserId)) {
      dropped++;
      continue;
    }
    const tok = obj(r.token);
    const chain = chainFromProvider(r.networkId ?? tok.networkId, r.chain ?? tok.chain);
    rows.push({
      id,
      tradeId: idOf(r.tradeId),
      author: { userId, handle: handleOf(r.handle), displayName: text(r.name, NAME_MAX), verified: null },
      token: tokenIdentity(chain, tok.address ?? r.tokenAddress ?? ctx.defaultAddress),
      tokenLabel: labelFrom(tok.symbol ?? r.symbol, tok.name),
      text: body_,
      likes: count(r.likes),
      replies: count(r.replies),
      authorEquityUsd: authorEquityOf(r, ctx.equityMeaningful),
      authorPosition: authorPositionOf(r),
      isDev: bool(r.isDev),
      postedAt: toMs(r.ts ?? r.createdAt),
      familyKey: thesisFamilyKey(body_),
    });
  }
  return {
    ok: true,
    data: {
      rows,
      dropped,
      totalAvailable: count(body.totalAvailable),
      source: sourceOf(body.source),
      stale: bool(body.stale),
      ageSeconds: nonNeg(body.ageSeconds),
      pagesRequested: ctx.pagesRequested,
      partial: bool(body.partial),
      threshold: nonNeg(body.threshold),
      chainFilterRequested: ctx.filter?.slug ?? null,
      chainFilterHonoured: ctx.filter ? verifyChainFilter(ctx.filter.identity, rows.map((r) => r.token)).honoured : null,
      available: bool(body.available),
    },
  };
}

function normalizeTrade(body: Rec, tradeId: string): Norm<TradeDetail> {
  const named = idOf(body.tradeId);
  if (named && named !== tradeId) return { ok: false, detail: "the answer is for a different trade" };
  const position = positionFromRow({ ...body, tradeId });
  if (!position) return { ok: false, detail: "the trade carried no position" };
  const thesis = body.thesis;
  return {
    ok: true,
    data: {
      tradeId,
      position,
      traderHandle: handleOf(typeof body.trader === "string" ? body.trader : obj(body.trader).handle),
      isDev: bool(body.isDev),
      thesisText: text(isObj(thesis) ? thesis.text : thesis, THESIS_TEXT_MAX),
      thesisLikes: count(body.thesisLikes ?? (isObj(thesis) ? thesis.likes : undefined)),
      swapCount: Array.isArray(body.swaps) ? body.swaps.length : null,
      transferCount: Array.isArray(body.transfers) ? body.transfers.length : null,
    },
  };
}

function normalizeComments(body: Rec, tradeId: string): Norm<CommentsPage> {
  const list = listOf(body, "comments");
  if (!list) return missingList("comments");
  const rows: ThesisComment[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = obj(raw);
    const id = idOf(r.id);
    const t = text(r.text, COMMENT_TEXT_MAX);
    if (!id || !t) {
      dropped++;
      continue;
    }
    rows.push({
      id,
      tradeId: idOf(r.tradeId) ?? tradeId,
      authorUserId: uuidOf(r.userId),
      text: t,
      likes: count(r.likes),
      createdAt: toMs(r.createdAt ?? r.ts),
      parentId: idOf(r.parentId),
    });
  }
  return { ok: true, data: { rows, dropped, tradeId, hasNextPage: bool(body.hasNextPage) } };
}

const STATS_WINDOWS: readonly StatsWindowKey[] = ["5m", "1h", "4h", "24h"];

function statsWindow(raw: Rec): StatsWindow {
  const buys = count(raw.buys);
  const sells = count(raw.sells);
  const given = nonNeg(raw.buySellRatio);
  // "Buys per sell" has no value when nobody sold; null, never Infinity and never 0.
  const ratio = sells === 0 ? null : given ?? (buys !== null && sells !== null ? buys / sells : null);
  const buyVol = nonNeg(raw.buyVolumeUsd);
  const sellVol = nonNeg(raw.sellVolumeUsd);
  return {
    buys,
    sells,
    uniqueBuyers: count(raw.uniqueBuyers),
    uniqueSellers: count(raw.uniqueSellers),
    buyVolumeUsd: buyVol,
    sellVolumeUsd: sellVol,
    netVolumeUsd: num(raw.netVolumeUsd) ?? (buyVol !== null && sellVol !== null ? buyVol - sellVol : null),
    buySellRatio: ratio,
  };
}

function tokenFromBody(body: Rec, requestedAddress: string): TokenIdentity | null {
  const tok = body.token;
  const address = typeof tok === "string" ? tok : obj(tok).address ?? requestedAddress;
  return tokenFrom(address, body.networkId ?? obj(tok).networkId, body.chain ?? obj(tok).chain);
}

function normalizeTokenStats(body: Rec, address: string): Norm<TokenStats> {
  const windows: Partial<Record<StatsWindowKey, StatsWindow>> = {};
  const w = obj(body.windows);
  for (const k of STATS_WINDOWS) {
    const raw = w[k];
    if (isObj(raw)) windows[k] = statsWindow(raw);
  }
  const top10 = num(body.top10HoldersPercent);
  return {
    ok: true,
    data: {
      token: tokenFromBody(body, address),
      holders: count(body.holders),
      top10HoldersPercent: top10 !== null && top10 >= 0 && top10 <= 100 ? top10 : null,
      windows,
    },
  };
}

function normalizeDevs(body: Rec, address: string): Norm<TokenDevsPage> {
  const list = listOf(body, "devs");
  if (!list) return missingList("devs");
  const rows: TokenDevRow[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = obj(raw);
    const handle = handleOf(r.handle);
    const tradeId = idOf(r.tradeId);
    if (!isObj(raw) || (!handle && !tradeId)) {
      dropped++;
      continue;
    }
    const thesis = r.thesis;
    rows.push({
      handle,
      userId: uuidOf(r.userId),
      isDev: bool(r.isDev),
      tradeId,
      amount: nonNeg(r.amount),
      valueUsd: nonNeg(r.valueUsd),
      costBasisUsd: nonNeg(r.costBasisUsd),
      averageEntryPrice: nonNeg(r.averageEntryPrice),
      realizedPnlUsd: num(r.realizedPnlUsd),
      unrealizedPnlUsd: num(r.unrealizedPnlUsd),
      averageHoldTimeSeconds: nonNeg(r.averageHoldTimeSeconds),
      // `wallet` is deliberately not read: wallets are not surfaced by this subsystem.
      thesisText: text(isObj(thesis) ? thesis.text : thesis, THESIS_TEXT_MAX),
    });
  }
  return { ok: true, data: { rows, dropped, token: tokenFromBody(body, address) } };
}

function normalizeHolders(body: Rec): Norm<TokenHoldersPage> {
  const list = listOf(body, "holders");
  if (!list) return missingList("holders");
  const rows: TokenHolderRow[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = obj(raw);
    const handle = handleOf(r.handle);
    if (!handle) {
      dropped++;
      continue;
    }
    rows.push({ handle, userId: uuidOf(r.userId), amount: nonNeg(r.amount), valueUsd: nonNeg(r.valueUsd), priceUsd: nonNeg(r.priceUsd) });
  }
  return { ok: true, data: { rows, dropped, available: bool(body.available) } };
}

function normalizeBoard(body: Rec, board: TokenBoard): Norm<TokenBoardPage> {
  if (typeof body.board === "string" && body.board !== board) return { ok: false, detail: "the answer is for a different board" };
  const list = listOf(body, "tokens");
  if (!list) return missingList("tokens");
  const rows: TokenBoardRow[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = obj(raw);
    const tok = obj(r.token);
    const network = r.network;
    const token = tokenFrom(
      tok.address,
      r.networkId ?? tok.networkId ?? (typeof network === "number" ? network : undefined),
      typeof network === "string" ? network : r.chain ?? tok.chain,
    );
    if (!token) {
      dropped++;
      continue;
    }
    const rank = count(r.rank);
    rows.push({
      board,
      rank: rank !== null && rank >= 1 ? rank : null,
      token,
      label: labelFrom(tok.symbol, tok.name),
      holders: count(r.holders),
      priceUsd: nonNeg(r.priceUsd),
      change24hPct: num(r.change24h),
      marketCapUsd: nonNeg(r.marketCapUsd),
      volume24hUsd: nonNeg(r.volume24hUsd),
    });
  }
  return { ok: true, data: { rows, dropped, board } };
}

function tokenHit(r: Rec): TokenSearchHit | null {
  const token = tokenFrom(r.address, r.networkId, r.chain ?? r.network);
  return token ? { token, label: labelFrom(r.symbol, r.name), marketCapUsd: nonNeg(r.marketCapUsd) } : null;
}

function normalizeSearch(body: Rec): Norm<SearchPage> {
  const list = listOf(body, "results");
  if (!list) return missingList("results");
  const rows: SearchHit[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = obj(raw);
    if (r.type === "trader") {
      const userId = uuidOf(r.userId);
      // Kept even when sparse (a `directory` row carries identity only): resolution needs the user id.
      if (userId) {
        const rank = count(r.rank);
        const pnlUsd = num(r.pnlUsd);
        rows.push({
          kind: "trader",
          trader: { userId, handle: handleOf(r.handle), displayName: text(r.displayName, NAME_MAX), verified: bool(r.verified) },
          volumeUsd: nonNeg(r.volumeUsd),
          followers: count(r.followers),
          hasEvmWallet: hasEvmWallet(r.wallets),
          evmWalletEvidence: evmWalletEvidenceOf(r.wallets),
          walletsVerified: bool(obj(r.wallets).verified),
          walletStatus: walletStatusOf(r.wallets),
          source: r.source === "leaderboard" || r.source === "directory" ? r.source : null,
          unwindowedRanking: rank === null && pnlUsd === null ? null : { rank: rank !== null && rank >= 1 ? rank : null, pnlUsd, window: null },
        });
        continue;
      }
    } else if (r.type === "token") {
      const hit = tokenHit(r);
      if (hit) {
        rows.push({ kind: "token", ...hit });
        continue;
      }
    }
    dropped++;
  }
  return { ok: true, data: { rows, dropped } };
}

/**
 * The live answer carries its rows under `results` (each typed `token`); the
 * documentation names the list `tokens`. Both are read, `results` first. A
 * typed row that says it is something other than a token is dropped.
 */
function normalizeTokensSearch(body: Rec): Norm<TokenSearchPage> {
  const list = Array.isArray(body.results) ? body.results : Array.isArray(body.tokens) ? body.tokens : listOf(body, "results");
  if (!list) return missingList("results");
  const rows: TokenSearchHit[] = [];
  let dropped = 0;
  for (const raw of list) {
    const typed = isObj(raw) && raw.type !== undefined && raw.type !== null;
    const hit = isObj(raw) && (!typed || raw.type === "token") ? tokenHit(raw) : null;
    if (hit) rows.push(hit);
    else dropped++;
  }
  return { ok: true, data: { rows, dropped } };
}

/** A short echoed value (a filter, a source) or null. Never free text. */
function shortSlug(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return SHORT_SLUG.test(s) ? s : null;
}

/**
 * The server's echo of the chain filter, as a secondary signal for when no
 * row could speak to it: false when the echo names another chain or none,
 * null when it names ours (accepting a filter proves nothing) or cannot be read.
 */
function echoSaysIgnored(filter: { slug: string; identity: ChainIdentity }, filters: unknown): boolean | null {
  if (!isObj(filters) || !("chain" in filters)) return null;
  const echoed = filters.chain;
  if (echoed === null || echoed === undefined || echoed === "") return true;
  const e = shortSlug(typeof echoed === "number" ? String(echoed) : echoed);
  if (e === null) return null;
  if (/^\d+$/.test(e)) return filter.identity.networkId !== null ? Number(e) !== filter.identity.networkId : null;
  const c = chainFromUserText(e);
  return c?.slug ? c.slug !== filter.slug : null;
}

function normalizeAlerts(
  body: Rec,
  observedAt: number,
  source: "rest-recovery" | "rest-lookup",
  filter: { slug: string; identity: ChainIdentity } | null,
): Norm<AlertsPage> {
  const list = listOf(body, "alerts");
  if (!list) return missingList("alerts");
  const rows: TraderEvent[] = [];
  let dropped = 0;
  for (const raw of list) {
    const e = alertFrameToEvent(raw, observedAt, source);
    if (e) rows.push(e);
    else dropped++;
  }
  // Perps carry no token, so they cannot speak to a token-chain filter either way.
  const placed = rows.filter((e) => e.kind !== "perp").map((e) => e.token);
  const byRows = filter ? verifyChainFilter(filter.identity, placed).honoured : null;
  // The echo only ever adds "not honoured", and only when the rows were silent.
  const honoured = filter && byRows === null && echoSaysIgnored(filter, body.filters) === true ? false : byRows;
  const echo = isObj(body.filters) ? body.filters : null;
  const order = typeof body.order === "string" ? sanitizeText(body.order, 40).toLowerCase() : "";
  return {
    ok: true,
    data: {
      rows,
      dropped,
      nextCursor: cursorOf(body.nextCursor),
      oldestCursor: cursorOf(body.oldestCursor),
      hasMore: bool(body.hasMore),
      newestTs: toMs(body.newestTs),
      oldestTs: toMs(body.oldestTs),
      chainFilterRequested: filter?.slug ?? null,
      chainFilterHonoured: honoured,
      providerCount: count(body.count),
      available: bool(body.available),
      backend: body.source === "memory" ? "memory" : null,
      filterEcho: echo
        ? { chain: shortSlug(typeof echo.chain === "number" ? String(echo.chain) : echo.chain), type: shortSlug(echo.type), source: shortSlug(echo.source) }
        : null,
      order: /^[a-z ,]{1,40}$/.test(order) ? order : null,
    },
  };
}

/** A stream entitlement: the documentation's bare boolean, or the live `{path, included}` object. */
function streamFlag(v: unknown): boolean | null {
  return bool(v) ?? bool(obj(v).included);
}

function streamPath(v: unknown): string | null {
  const p = obj(v).path;
  return typeof p === "string" && STREAM_PATH.test(p.trim()) ? p.trim() : null;
}

function normalizeMe(body: Rec): Norm<AccountInfo> {
  const credits = obj(body.credits);
  const streams = obj(body.streams);
  if (!isObj(body.credits) && typeof body.plan !== "string") return { ok: false, detail: "the account answer carried neither a plan nor credits" };
  const plan = sanitizeText(body.plan, PLAN_MAX).toLowerCase();
  const expires = toMs(body.planExpiresAt ?? body.expiresAt);
  return {
    ok: true,
    data: {
      plan: /^[a-z0-9_-]{1,32}$/.test(plan) ? plan : null,
      dailyLimit: count(body.dailyLimit ?? credits.dailyLimit),
      credits: {
        monthly: count(credits.monthly),
        usedThisMonth: count(credits.usedThisMonth),
        prepaid: count(credits.prepaid),
        remaining: count(credits.remaining),
      },
      streams: { appFeed: streamFlag(streams.appFeed), onChain: streamFlag(streams.onChain) },
      streamPaths: { appFeed: streamPath(streams.appFeed), onChain: streamPath(streams.onChain) },
      planExpiresAt: expires,
      expiresAt: expires,
    },
  };
}

// ── The client ───────────────────────────────────────────────────────────

interface HeaderView {
  get(name: string): string | null;
}

type Attempt =
  | { kind: "transport"; failure: "timeout" | "unreachable" | "cancelled"; detail: string }
  | { kind: "response"; status: number; headers: HeaderView; body: unknown; readError: string | null };

/** A view's limits: every signal it was bound to, and the earliest deadline. */
interface Scope {
  signals: readonly AbortSignal[];
  deadlineAt: number | null;
}

const ROOT_SCOPE: Scope = { signals: [], deadlineAt: null };

function isSignal(v: unknown): v is AbortSignal {
  return typeof v === "object" && v !== null && typeof (v as AbortSignal).aborted === "boolean" && typeof (v as AbortSignal).addEventListener === "function";
}

/** A narrower scope: both signals, the earlier deadline. A deadline that is not a number fails closed (already passed). */
function narrowScope(s: Scope, o: CallScope | null | undefined): Scope {
  const sig = o?.signal;
  const signals = isSignal(sig) && !s.signals.includes(sig) ? [...s.signals, sig] : s.signals;
  const raw = o?.deadlineAt;
  const d = raw === undefined || raw === null ? null : typeof raw === "number" && !Number.isNaN(raw) ? raw : -Infinity;
  return { signals, deadlineAt: d === null ? s.deadlineAt : s.deadlineAt === null ? d : Math.min(s.deadlineAt, d) };
}

function headerNum(h: HeaderView, name: string): number | null {
  const v = h.get(name);
  if (v === null || v.trim() === "") return null;
  const n = Number(v.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function headerBool(h: HeaderView, name: string): boolean | null {
  const v = h.get(name)?.trim().toLowerCase();
  return v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : null;
}

function freshnessOf(body: unknown): Pick<CallMeta, "providerAsOf" | "providerSource" | "providerStale" | "providerAgeSeconds"> {
  const b = obj(body);
  const hours = nonNeg(b.ageHours) ?? nonNeg(b.newestEventAgeHours);
  return {
    providerAsOf: toMs(b.capturedAt ?? b.asOf ?? b.generatedAt),
    providerSource: sourceOf(b.source),
    providerStale: bool(b.stale),
    providerAgeSeconds: nonNeg(b.ageSeconds) ?? (hours !== null ? hours * 3600 : null),
  };
}

/**
 * A short code from an error body, never the body itself. Judged on the RAW
 * length: truncating a long string would turn prose into something that looks
 * like a code.
 */
function errorCode(body: unknown): string {
  const raw = obj(body).error;
  if (typeof raw !== "string" || raw.length > 48) return "";
  const c = sanitizeText(raw, 48);
  return /^[A-Za-z0-9 _.-]{1,48}$/.test(c) ? ` (${c})` : "";
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

export function createFomoClient(opts: FomoClientOptions): FomoClient {
  const key = typeof opts.apiKey === "string" ? opts.apiKey : "";
  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadlineMs = Math.max(1, opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const minAttemptMs = typeof opts.minAttemptMs === "number" && Number.isFinite(opts.minAttemptMs) && opts.minAttemptMs > 0 ? opts.minAttemptMs : MIN_ATTEMPT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const maxBytes = opts.maxBytes ?? MAX_READ_BYTES;

  /**
   * Every detail string leaves through here. The key is removed BEFORE the
   * string is capped, so a truncation can never leave half a key behind.
   */
  function scrub(raw: string): string {
    let s = key ? raw.split(key).join("***") : raw;
    s = redactUrl(s).replace(/Bearer\s+[^\s"',;]+/gi, "Bearer ***");
    return sanitizeText(s, DETAIL_MAX);
  }

  function blankMeta(route: string, at: number): CallMeta {
    return {
      route,
      status: null,
      attempts: 0,
      retrievedAt: at,
      creditsCost: null,
      creditsRemaining: null,
      unmetered: null,
      providerAsOf: null,
      providerSource: null,
      providerStale: null,
      providerAgeSeconds: null,
    };
  }

  function fail<T>(failure: ProviderFailure, detail: string, meta: CallMeta, retryAfterMs?: number, retryable?: boolean): ProviderResult<T> {
    return {
      ok: false,
      failure,
      detail: scrub(detail),
      meta,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(retryable === true ? { retryable } : {}),
    };
  }

  /** The vendor's word that a 5xx is its upstream being slow for this subject, not the API being down. */
  function transient5xx(body: unknown): boolean {
    const b = obj(body);
    return b.retryable === true || b.error === "upstream_unavailable";
  }

  /** Full jitter: a uniform wait up to the capped exponential ceiling. */
  function backoff(attempt: number): number {
    return Math.floor(random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)));
  }

  function retryAfterOf(h: HeaderView, body: unknown): number | undefined {
    const raw = h.get("retry-after")?.trim();
    if (raw) {
      if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.min(MAX_RETRY_AFTER_MS, Math.round(Number(raw) * 1000));
      const at = Date.parse(raw);
      if (Number.isFinite(at)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now()));
    }
    const s = nonNeg(obj(body).retryAfterSeconds);
    return s !== null ? Math.min(MAX_RETRY_AFTER_MS, Math.round(s * 1000)) : undefined;
  }

  /**
   * One request. Its fetch is aborted by our per-attempt timer OR by any of the
   * caller's signals; which one fired decides `timeout` (the vendor was slow)
   * versus `cancelled` (the caller stopped listening).
   */
  async function attempt(url: string, budgetMs: number, signals: readonly AbortSignal[]): Promise<Attempt> {
    const ctl = new AbortController();
    let byCaller = false;
    const onCallerAbort = (): void => {
      byCaller = true;
      ctl.abort();
    };
    for (const sg of signals) {
      if (sg.aborted) onCallerAbort();
      else sg.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timer = setTimeout(() => ctl.abort(), Math.max(1, budgetMs));
    const stopped = (what: string): Attempt =>
      byCaller ? { kind: "transport", failure: "cancelled", detail: "cancelled by the caller" } : { kind: "transport", failure: "timeout", detail: what };
    try {
      if (byCaller) return stopped("");
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "GET",
          headers: { authorization: `Bearer ${key}`, accept: "application/json" },
          signal: ctl.signal,
          // A redirect could carry the Authorization header to a host we never chose.
          redirect: "error",
        });
      } catch (e) {
        return ctl.signal.aborted ? stopped(`no answer within ${budgetMs} ms`) : { kind: "transport", failure: "unreachable", detail: errText(e) };
      }
      const success = res.status >= 200 && res.status < 300;
      let body: unknown = undefined;
      let readError: string | null = null;
      try {
        const read = await readBoundedJson<unknown>(res, success ? maxBytes : ERROR_BODY_MAX_BYTES);
        if (read.ok) body = read.value;
        else if (ctl.signal.aborted) return stopped(`the body did not finish within ${budgetMs} ms`);
        // The bound's own wording is ours and safe. A JSON parse error is NOT:
        // current engines quote a slice of the input in the message, which
        // would echo the vendor's body into a detail string.
        else readError = /byte limit/.test(read.detail) ? read.detail : "the answer was not valid JSON";
      } catch (e) {
        if (ctl.signal.aborted) return stopped(`the body did not finish within ${budgetMs} ms`);
        readError = "the answer could not be read";
      }
      return { kind: "response", status: res.status, headers: res.headers, body, readError };
    } finally {
      clearTimeout(timer);
      for (const sg of signals) sg.removeEventListener("abort", onCallerAbort);
    }
  }

  /** A retry wait that ends early when the caller aborts (the loop then stops before the next attempt). */
  async function pause(ms: number, signals: readonly AbortSignal[]): Promise<void> {
    if (signals.length === 0) return sleep(ms);
    if (signals.some((sg) => sg.aborted)) return;
    let wake: () => void = () => {};
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    for (const sg of signals) sg.addEventListener("abort", wake, { once: true });
    try {
      await Promise.race([sleep(ms), woken]);
    } finally {
      for (const sg of signals) sg.removeEventListener("abort", wake);
    }
  }

  async function callIn<T>(
    scope: Scope,
    route: RouteName,
    params: Record<string, string>,
    query: Record<string, QueryValue>,
    normalize: (body: Rec, retrievedAt: number) => Norm<T>,
  ): Promise<ProviderResult<T>> {
    const template = ROUTE_COST[route].template;
    const startedAt = now();
    const meta = blankMeta(template, startedAt);
    if (!key) return fail("no-key", "no provider key is configured", meta);
    if (!KEY_SHAPE.test(key)) return fail("no-key", "the configured key has an unusable shape", meta);
    const built = buildFomoUrl(template, params, query);
    if (!built.ok) return fail(built.failure, built.detail, meta);

    const signals = scope.signals;
    const callerAborted = (): boolean => signals.some((sg) => sg.aborted);
    /** Time left before the CALLER's deadline; unbounded for an unbound client. */
    const callerLeft = (): number => (scope.deadlineAt === null ? Infinity : scope.deadlineAt - now());
    // Our own deadline, and the earlier of it and the caller's: no wait or attempt runs past either.
    const ownDeadlineAt = startedAt + deadlineMs;
    const deadlineAt = Math.min(ownDeadlineAt, scope.deadlineAt ?? Infinity);
    // A wait fits when it ends inside our deadline AND leaves the caller time for one more attempt.
    const fits = (ms: number) => now() + ms <= ownDeadlineAt && callerLeft() - ms >= minAttemptMs;
    let attempts = 0;
    /**
     * EVERY ATTEMPT'S COST, not just the last answer's: a 5xx, 429 or 409 we
     * retried past may have been billed too. `priced` sums the costs the
     * provider reported; `unpriced` counts attempts sent whose cost is unknown
     * (an answer without the header, or a timeout or dropped connection after
     * sending), which a budget charges at its estimate (billedCreditsFor).
     */
    let priced = 0;
    let unpriced = 0;
    const costMeta = (): Pick<CallMeta, "creditsCost" | "creditsPriced" | "creditsUnpricedAttempts"> => ({
      creditsCost: unpriced === 0 ? priced : null,
      creditsPriced: priced,
      creditsUnpricedAttempts: unpriced,
    });
    /**
     * The last HTTP answer we chose to retry past. If the retries then end in
     * a timeout or no connection, THAT answer is what we know about the
     * vendor: its failure and status are reported, with the cost of every
     * attempt sent (costMeta), unknown wherever an attempt's was.
     */
    let prior: { failure: ProviderFailure; detail: string; meta: CallMeta; retryAfterMs?: number; retryable: boolean } | null = null;
    const afterPrior = (why: string): ProviderResult<T> | null =>
      prior
        ? fail<T>(
            prior.failure,
            `${prior.detail}; then ${why}`,
            { ...prior.meta, attempts, retrievedAt: now(), ...costMeta() },
            prior.retryAfterMs,
            prior.retryable,
          )
        : null;
    for (;;) {
      // The caller's limits come first: a call they no longer want is never started.
      if (callerAborted()) {
        const why = attempts === 0 ? "cancelled by the caller before it was sent" : "cancelled by the caller";
        return afterPrior(why) ?? fail("cancelled", why, { ...meta, attempts, retrievedAt: now(), ...(attempts > 0 ? costMeta() : {}) });
      }
      const left = callerLeft();
      if (left < minAttemptMs) {
        const why = `not sent: ${Math.max(0, Math.round(left))} ms left before the caller's deadline`;
        return afterPrior(why) ?? fail("cancelled", why, { ...meta, attempts, retrievedAt: now(), ...(attempts > 0 ? costMeta() : {}) });
      }
      const remaining = ownDeadlineAt - now();
      if (remaining <= 0) {
        return afterPrior("the overall deadline passed") ?? fail("timeout", "the overall deadline passed", { ...meta, attempts, retrievedAt: now(), ...(attempts > 0 ? costMeta() : {}) });
      }
      attempts++;
      const budgetMs = Math.min(timeoutMs, remaining, left);
      // The caller's deadline, not ours, sets this attempt's limit: running out of it is the caller's cut, not a slow vendor.
      const callerCut = left < Math.min(timeoutMs, remaining);
      const a = await attempt(built.url, budgetMs, signals);

      if (a.kind === "transport") {
        // Sent, and no answer to say what it cost: possibly billed, so unpriced.
        unpriced++;
        const m: CallMeta = { ...meta, attempts, retrievedAt: now(), ...costMeta() };
        const failure: ProviderFailure = a.failure === "timeout" && callerCut ? "cancelled" : a.failure;
        const detail = failure === "cancelled" && a.failure === "timeout" ? `the caller's deadline passed after ${budgetMs} ms` : a.detail;
        if (a.failure === "unreachable" && attempts < maxAttempts) {
          const d = backoff(attempts);
          if (fits(d)) {
            await pause(d, signals);
            continue;
          }
        }
        return afterPrior(detail) ?? fail(failure, detail, m);
      }

      const cost = headerNum(a.headers, "x-credits-cost");
      if (cost === null || cost < 0) unpriced++;
      else priced += cost;
      const m: CallMeta = {
        ...meta,
        status: a.status,
        attempts,
        retrievedAt: now(),
        ...costMeta(),
        creditsRemaining: headerNum(a.headers, "x-credits-remaining"),
        unmetered: headerBool(a.headers, "x-credits-unmetered"),
        ...freshnessOf(a.body),
      };
      const s = a.status;

      if (s >= 200 && s < 300) {
        if (a.readError !== null) return fail("unreadable", a.readError, m);
        if (!isObj(a.body)) return fail("invalid-shape", "the answer was not a JSON object", m);
        const n = normalize(a.body, m.retrievedAt);
        return n.ok ? { ok: true, data: n.data, meta: m } : fail("invalid-shape", n.detail, m);
      }

      const code = errorCode(a.body);
      const retryAfterMs = retryAfterOf(a.headers, a.body);

      if (s === 409) {
        // Only the vendor's explicit `retryable: true` (a wallet still resolving) earns a retry.
        if (obj(a.body).retryable !== true) return fail("bad-request", `http 409${code}, not marked retryable`, m);
        if (attempts < maxAttempts) {
          const d = retryAfterMs ?? backoff(attempts);
          if (fits(d)) {
            prior = { failure: "conflict-retryable", detail: `http 409${code}`, meta: m, retryAfterMs, retryable: false };
            await pause(d, signals);
            continue;
          }
        }
        return fail("conflict-retryable", `http 409${code}`, m, retryAfterMs);
      }

      if (s === 429) {
        if (attempts < maxAttempts) {
          if (retryAfterMs !== undefined) {
            if (fits(retryAfterMs)) {
              prior = { failure: "rate-limited", detail: `http 429${code}`, meta: m, retryAfterMs, retryable: false };
              await pause(Math.min(retryAfterMs + Math.floor(random() * RETRY_AFTER_JITTER_MS), Math.max(0, deadlineAt - now())), signals);
              continue;
            }
          } else {
            const d = backoff(attempts);
            if (fits(d)) {
              prior = { failure: "rate-limited", detail: `http 429${code}`, meta: m, retryAfterMs, retryable: false };
              await pause(d, signals);
              continue;
            }
          }
        }
        return fail("rate-limited", `http 429${code}`, m, retryAfterMs);
      }

      if (s >= 500 && s <= 599) {
        // Every 5xx is retried, 502 included; the body only decides whether the failure is labelled transient.
        const transient = transient5xx(a.body);
        if (attempts < maxAttempts) {
          const d = retryAfterMs ?? backoff(attempts);
          if (fits(d)) {
            prior = { failure: "server-error", detail: `http ${s}${code}`, meta: m, retryAfterMs, retryable: transient };
            await pause(d, signals);
            continue;
          }
        }
        return fail("server-error", `http ${s}${code}`, m, retryAfterMs, transient);
      }

      const terminal: ProviderFailure =
        s === 400
          ? "bad-request"
          : s === 401
            ? "unauthorized"
            : s === 402
              ? "credits-exhausted"
              : s === 403
                ? "entitlement"
                : s === 404
                  ? "not-found"
                  : s >= 300 && s < 400
                    ? "unreachable"
                    : "bad-request";
      return fail(terminal, `http ${s}${code}`, m);
    }
  }

  /** Refused before the network: nothing was sent and nothing was billed. */
  function refuse<T>(route: RouteName, detail: string): Promise<ProviderResult<T>> {
    return Promise.resolve(fail<T>("bad-request", detail, blankMeta(ROUTE_COST[route].template, now())));
  }

  function limitOf(route: RouteName, raw: number | undefined, max?: number): { ok: true; value: number | undefined } | { ok: false } {
    if (raw === undefined) return { ok: true, value: undefined };
    if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false };
    const ceiling = max ?? ROUTE_COST[route].maxLimit ?? 100;
    return { ok: true, value: Math.min(ceiling, Math.max(1, Math.floor(raw))) };
  }

  function addressOf(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const t = raw.trim();
    if (EVM_ADDRESS.test(t)) return t.toLowerCase();
    // Base58 is case-sensitive: a mint is passed exactly as given.
    return SOLANA_MINT.test(t) ? t : null;
  }

  const userIdError = "per-trader routes are keyed on the FOMO user id (UUID); resolve a handle first";

  /**
   * The client as one caller sees it. Every view shares this client's key,
   * clock and policy; a bound view only adds the caller's signal and deadline.
   */
  function view(scope: Scope): FomoClient {
    const call = <T>(
      route: RouteName,
      params: Record<string, string>,
      query: Record<string, QueryValue>,
      normalize: (body: Rec, retrievedAt: number) => Norm<T>,
    ): Promise<ProviderResult<T>> => callIn<T>(scope, route, params, query, normalize);

    const client: FomoClient = {
      leaderboard(window, limit) {
        if (window !== "24h" && window !== "7d" && window !== "30d" && window !== "all") return refuse("leaderboard", "window must be 24h, 7d, 30d or all");
        // The board's own ceiling: 150 rows, 100 on `all`. Billed per call at any limit.
        const l = limitOf("leaderboard", limit, window === "all" ? 100 : 150);
        if (!l.ok) return refuse("leaderboard", "limit must be a number");
        return call("leaderboard", { window }, { limit: l.value }, (b) => normalizeLeaderboard(b, window));
      },

      traderByHandle(handle) {
        const h = typeof handle === "string" ? handle.trim() : "";
        if (!HANDLE.test(h) || /^@?\.+$/.test(h)) return refuse("traderByHandle", "not a handle");
        return call("traderByHandle", { handle: h.replace(/^@/, "") }, {}, (b) => normalizeProfile(b, null));
      },

      traderById(userId) {
        const u = uuidOf(userId);
        if (!u) return refuse("traderById", "userId must be a UUID");
        return call("traderById", { userId: u }, {}, (b) => normalizeProfile(b, u));
      },

      positions(userId, o = {}) {
        const u = uuidOf(userId);
        if (!u) return refuse("positions", userIdError);
        if (o.status !== undefined && o.status !== "open" && o.status !== "closed" && o.status !== "all") return refuse("positions", "status must be open, closed or all");
        if (o.cursor !== undefined && !CURSOR.test(o.cursor)) return refuse("positions", "cursor is not one this API issued");
        const l = limitOf("positions", o.limit);
        if (!l.ok) return refuse("positions", "limit must be a number");
        return call("positions", { userId: u }, { status: o.status, cursor: o.cursor, limit: l.value }, (b) => normalizePositions(b, u));
      },

      swaps(userId, o = {}) {
        const u = uuidOf(userId);
        if (!u) return refuse("swaps", userIdError);
        if (o.cursor !== undefined && !CURSOR.test(o.cursor)) return refuse("swaps", "cursor is not one this API issued");
        const tokenAddress = o.tokenAddress === undefined ? undefined : addressOf(o.tokenAddress);
        if (tokenAddress === null) return refuse("swaps", "tokenAddress must be an EVM address or a Solana mint");
        const l = limitOf("swaps", o.limit);
        if (!l.ok) return refuse("swaps", "limit must be a number");
        return call("swaps", { userId: u }, { cursor: o.cursor, limit: l.value, tokenAddress }, (b) => normalizeSwaps(b, u));
      },

      balances(userId, o = {}) {
        const u = uuidOf(userId);
        if (!u) return refuse("balances", userIdError);
        const f = o.chain === undefined ? null : chainFilter(o.chain);
        if (o.chain !== undefined && !f) return refuse("balances", "unknown chain filter");
        const filter = f ? { slug: f.identity.slug ?? f.param, identity: f.identity } : null;
        return call("balances", { userId: u }, { chain: f?.param }, (b) => normalizeBalances(b, u, filter));
      },

      following(userId, o = {}) {
        const u = uuidOf(userId);
        if (!u) return refuse("following", userIdError);
        const l = limitOf("following", o.limit);
        if (!l.ok) return refuse("following", "limit must be a number");
        return call("following", { userId: u }, { limit: l.value }, (b) => normalizeFollowing(b, u));
      },

      spotlight(userId) {
        const u = uuidOf(userId);
        if (!u) return refuse("spotlight", userIdError);
        return call("spotlight", { userId: u }, {}, (b) => normalizeSpotlight(b, u));
      },

      theses(o = {}) {
        const f = o.chain === undefined ? null : chainFilter(o.chain);
        if (o.chain !== undefined && !f) return refuse("theses", "unknown chain filter");
        if (o.sort !== undefined && o.sort !== "recent" && o.sort !== "equity" && o.sort !== "pnl") return refuse("theses", "sort must be recent, equity or pnl");
        const l = limitOf("theses", o.limit);
        if (!l.ok) return refuse("theses", "limit must be a number");
        const filter = f ? { slug: f.identity.slug ?? f.param, identity: f.identity } : null;
        return call("theses", {}, { chain: f?.param, sort: o.sort, limit: l.value }, (b) =>
          normalizeTheses(b, { filter, pagesRequested: 1, defaultAddress: null, expectUserId: null, equityMeaningful: true }),
        );
      },

      thesesByToken(address, o = {}) {
        const a = addressOf(address);
        if (!a) return refuse("thesesByToken", "address must be an EVM address or a Solana mint");
        const net = o.network;
        const NETWORKS: Record<ThesisNetwork, string> = { robinhood: "robinhood", sol: "solana", bnb: "bsc", base: "base", eth: "eth", arc: "arc" };
        if (net !== undefined && !(net in NETWORKS)) return refuse("thesesByToken", "network must be robinhood, sol, bnb, base, eth or arc");
        const requested = net !== undefined ? chainFromUserText(NETWORKS[net]) : null;
        if (requested && !tokenIdentity(requested, a)) return refuse("thesesByToken", "the address does not fit that network");
        if (o.sort !== undefined && o.sort !== "likes" && o.sort !== "recent") return refuse("thesesByToken", "sort must be likes or recent");
        if (o.pages !== undefined && !Number.isFinite(o.pages)) return refuse("thesesByToken", "pages must be a number");
        const pages = o.pages === undefined ? 1 : Math.min(10, Math.max(1, Math.floor(o.pages)));
        if (o.threshold !== undefined && (!Number.isFinite(o.threshold) || o.threshold < 0)) return refuse("thesesByToken", "threshold must be a non-negative number");
        const l = limitOf("thesesByToken", o.limit);
        if (!l.ok) return refuse("thesesByToken", "limit must be a number");
        // THE VENDOR'S `network` ENUM HAS NO ROBINHOOD VALUE (openapi, fetched
        // 2026-10-04: sol|bnb|base|eth|arc). Sending a value it does not know
        // could be ignored or misread, so for Robinhood we send none and check
        // every returned row's own network instead.
        const param = net === undefined || net === "robinhood" ? undefined : net;
        const filter = requested ? { slug: requested.slug ?? net ?? "", identity: requested } : null;
        return call(
          "thesesByToken",
          { address: a },
          { network: param, sort: o.sort, pages: o.pages === undefined ? undefined : pages, threshold: o.threshold, limit: l.value },
          (b) => normalizeTheses(b, { filter, pagesRequested: pages, defaultAddress: a, expectUserId: null, equityMeaningful: false }),
        );
      },

      thesesByUser(userId, o = {}) {
        const u = uuidOf(userId);
        if (!u) return refuse("thesesByUser", userIdError);
        const f = o.chain === undefined ? null : chainFilter(o.chain);
        if (o.chain !== undefined && !f) return refuse("thesesByUser", "unknown chain filter");
        if (o.sort !== undefined && o.sort !== "likes" && o.sort !== "recent") return refuse("thesesByUser", "sort must be likes or recent");
        const l = limitOf("thesesByUser", o.limit);
        if (!l.ok) return refuse("thesesByUser", "limit must be a number");
        const filter = f ? { slug: f.identity.slug ?? f.param, identity: f.identity } : null;
        return call("thesesByUser", { userId: u }, { chain: f?.param, sort: o.sort, limit: l.value }, (b) =>
          normalizeTheses(b, { filter, pagesRequested: 1, defaultAddress: null, expectUserId: u, equityMeaningful: false }),
        );
      },

      thesesByUserToken(userId, address, o = {}) {
        const u = uuidOf(userId);
        if (!u) return refuse("thesesByUserToken", userIdError);
        const a = addressOf(address);
        if (!a) return refuse("thesesByUserToken", "address must be an EVM address or a Solana mint");
        const l = limitOf("thesesByUserToken", o.limit);
        if (!l.ok) return refuse("thesesByUserToken", "limit must be a number");
        return call("thesesByUserToken", { userId: u, address: a }, { limit: l.value }, (b) =>
          normalizeTheses(b, { filter: null, pagesRequested: 1, defaultAddress: a, expectUserId: u, equityMeaningful: false }),
        );
      },

      trade(tradeId) {
        const t = typeof tradeId === "string" ? tradeId.trim() : "";
        if (!PATH_ID.test(t)) return refuse("trade", "not a trade id");
        return call("trade", { tradeId: t }, {}, (b) => normalizeTrade(b, t));
      },

      tradeComments(tradeId, o = {}) {
        const t = typeof tradeId === "string" ? tradeId.trim() : "";
        if (!PATH_ID.test(t)) return refuse("tradeComments", "not a trade id");
        const l = limitOf("tradeComments", o.limit);
        if (!l.ok) return refuse("tradeComments", "limit must be a number");
        return call("tradeComments", { tradeId: t }, { limit: l.value }, (b) => normalizeComments(b, t));
      },

      tokenStats(address, o = {}) {
        const a = addressOf(address);
        if (!a) return refuse("tokenStats", "address must be an EVM address or a Solana mint");
        if (o.networkId !== undefined && !(Number.isSafeInteger(o.networkId) && o.networkId > 0)) return refuse("tokenStats", "networkId must be a positive integer");
        return call("tokenStats", { address: a }, { networkId: o.networkId }, (b) => normalizeTokenStats(b, a));
      },

      tokenDevs(address, o = {}) {
        const a = addressOf(address);
        if (!a) return refuse("tokenDevs", "address must be an EVM address or a Solana mint");
        if (o.networkId !== undefined && !(Number.isSafeInteger(o.networkId) && o.networkId > 0)) return refuse("tokenDevs", "networkId must be a positive integer");
        return call("tokenDevs", { address: a }, { networkId: o.networkId }, (b) => normalizeDevs(b, a));
      },

      tokenHolders(address, o = {}) {
        const a = addressOf(address);
        if (!a) return refuse("tokenHolders", "address must be an EVM address or a Solana mint");
        const l = limitOf("tokenHolders", o.limit);
        if (!l.ok) return refuse("tokenHolders", "limit must be a number");
        return call("tokenHolders", { address: a }, { limit: l.value }, (b) => normalizeHolders(b));
      },

      tokenBoard(board, limit) {
        const route: RouteName | null =
          board === "trending" ? "tokenBoardTrending" : board === "graduated" ? "tokenBoardGraduated" : board === "most-held" ? "tokenBoardMostHeld" : null;
        if (!route) return refuse("tokenBoardTrending", "board must be trending, graduated or most-held");
        const l = limitOf(route, limit);
        if (!l.ok) return refuse(route, "limit must be a number");
        return call(route, {}, { limit: l.value }, (b) => normalizeBoard(b, board));
      },

      search(q, type, limit) {
        const s = sanitizeText(q, QUERY_MAX);
        if (!s) return refuse("search", "empty query");
        if (type !== undefined && type !== "traders" && type !== "tokens" && type !== "all") return refuse("search", "type must be traders, tokens or all");
        const l = limitOf("search", limit);
        if (!l.ok) return refuse("search", "limit must be a number");
        return call("search", {}, { q: s, type, limit: l.value }, (b) => normalizeSearch(b));
      },

      tokensSearch(q, limit) {
        const s = sanitizeText(q, QUERY_MAX);
        if (!s) return refuse("tokensSearch", "empty query");
        const l = limitOf("tokensSearch", limit);
        if (!l.ok) return refuse("tokensSearch", "limit must be a number");
        return call("tokensSearch", {}, { q: s, limit: l.value }, (b) => normalizeTokensSearch(b));
      },

      alerts(query, source) {
        if (source !== "rest-recovery" && source !== "rest-lookup") return refuse("alerts", "source must be rest-recovery or rest-lookup");
        const q = query ?? {};
        if (q.cursor !== undefined && !CURSOR.test(q.cursor)) return refuse("alerts", "cursor is not one this API issued");
        if (q.before !== undefined && !CURSOR.test(q.before)) return refuse("alerts", "before is not a cursor this API issued");
        let since: number | undefined;
        if (q.since !== undefined) {
          const ms = toMs(q.since);
          if (ms === null) return refuse("alerts", "since must be a timestamp");
          since = ms;
        }
        const f = q.chain === undefined ? null : chainFilter(q.chain);
        if (q.chain !== undefined && !f) return refuse("alerts", "unknown chain filter");
        if (q.type !== undefined && !ALERT_TYPE.test(q.type)) return refuse("alerts", "unknown alert type");
        const userId = q.userId === undefined ? undefined : uuidOf(q.userId);
        if (userId === null) return refuse("alerts", userIdError);
        const token = q.token === undefined ? undefined : tokenFilter(q.token);
        if (token === null) return refuse("alerts", "token must be a symbol or a contract address");
        const l = limitOf("alerts", q.limit);
        if (!l.ok) return refuse("alerts", "limit must be a number");
        const filter = f ? { slug: f.identity.slug ?? f.param, identity: f.identity } : null;
        return call(
          "alerts",
          {},
          { cursor: q.cursor, before: q.before, since, chain: f?.param, type: q.type, userId, token, limit: l.value },
          (b, at) => normalizeAlerts(b, at, source, filter),
        );
      },

      me() {
        return call("me", {}, {}, (b) => normalizeMe(b));
      },

      bound(o) {
        return view(narrowScope(scope, o));
      },
    };
    return client;
  }
  return view(ROOT_SCOPE);
}

/** Pinned by the tests so they restate nothing. */
export const PROVIDER_GUARDS = {
  FORBIDDEN_PATH,
  KEY_SHAPE,
  HANDLE,
  UUID,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_ATTEMPTS,
  MIN_ATTEMPT_MS,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  ERROR_BODY_MAX_BYTES,
  HOLDINGS_CAP,
  THESIS_TEXT_MAX,
  ALERT_TEXT_MAX,
  PROVIDER_ALERT_ID,
  MONEY_PAREN,
  PERP_TEXT,
} as const;
