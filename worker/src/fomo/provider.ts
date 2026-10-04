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
 *   5xx, connect errors  bounded exponential backoff with full jitter.
 *   a timed-out attempt  terminal. The vendor may have answered and billed a
 *                        call we stopped listening to; retrying would pay
 *                        twice for one answer. The deadline is the bound.
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
import { chainFromProvider, chainFromUserText, IDENTITY_GUARDS, tokenIdentity, verifyChainFilter } from "./identity";
import type {
  ActivityKind,
  ChainIdentity,
  EventSource,
  FillRow,
  HoldingRow,
  HoldingsSnapshot,
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
  TraderEvent,
  TraderIdentity,
  TraderProfile,
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
  /** `x-credits-cost` of the last answer; null when absent. */
  creditsCost: number | null;
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

export type ProviderResult<T> =
  | { ok: true; data: T; meta: CallMeta }
  | { ok: false; failure: ProviderFailure; detail: string; retryAfterMs?: number; meta: CallMeta };

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
  moreAvailable: boolean | null;
}

/** A holdings snapshot plus the read's own bookkeeping. Assignable to `HoldingsSnapshot`. */
export interface BalancesSnapshot extends HoldingsSnapshot {
  dropped: number;
  upstreamRows: number | null;
  available: boolean | null;
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

export type SearchHit =
  | { kind: "trader"; trader: TraderIdentity; pnlUsd: number | null; volumeUsd: number | null; followers: number | null; hasEvmWallet: boolean }
  | { kind: "token"; token: TokenIdentity; label: TokenLabel; marketCapUsd: number | null };

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
  chainFilterHonoured: boolean | null;
}

/** `/v2/me`: the zero-credit entitlement probe. */
export interface AccountInfo {
  plan: string | null;
  credits: { monthly: number | null; usedThisMonth: number | null; prepaid: number | null; remaining: number | null };
  streams: { appFeed: boolean | null; onChain: boolean | null };
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

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DEADLINE_MS = 25_000;
const DEFAULT_MAX_ATTEMPTS = 3;
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

function sourceOf(v: unknown): CallMeta["providerSource"] {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "live" || s === "live-fomo") return "live";
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
 * them) and checked by number.
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
  return { param: c.slug, identity: c };
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
 *   fillUsd            ONLY `tradeUsd`, and ONLY when `fillMatch` is
 *                      `onchain-exact` — the vendor matched exactly one on-chain
 *                      execution. `ambiguous` (several candidates) attaches no
 *                      fill, and neither does an absent match.
 *   cumulative PnL     `realizedPnlUsd` is the position's RUNNING TOTAL; it is
 *                      carried per event and never summed (summing four sells
 *                      of one position was measured at 2.6x the real loss).
 *
 * `usdValue` is NOT read for any of them. It mirrors whichever of the mark or
 * the cumulative PnL applies to that alert type, so using it as a fill size
 * would book a $40k position mark as a $40k purchase, or a running loss as a
 * sale amount.
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
  const tradeUsd = typeof frame.tradeUsd === "number" && Number.isFinite(frame.tradeUsd) && frame.tradeUsd > 0 ? frame.tradeUsd : null;
  const fillUsd = exact ? tradeUsd : null;
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
    fillUsdBasis: fillUsd !== null ? "onchain-exact" : frame.fillMatch === "ambiguous" ? "ambiguous" : null,
    positionValueUsd,
    positionRealizedPnlUsdCumulative: realized,
    sourceEventAt,
    execAt: toMs(frame.execTs),
    observedAt,
    verification: exact ? "provider-verified" : "provider-reported",
    text: text(frame.text, ALERT_TEXT_MAX),
    replay: source === "stream" && frame.replay === true,
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
  const fillUsd = typeof frame.usdValue === "number" && Number.isFinite(frame.usdValue) && frame.usdValue > 0 ? frame.usdValue : null;
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
    verification: verified === "db" || verified === "relay" ? "provider-verified" : "provider-reported",
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
  for (const raw of list) {
    const r = obj(raw);
    const userId = uuidOf(r.userId);
    if (!userId) {
      dropped++;
      continue;
    }
    const hints = Array.isArray(r.topTokens)
      ? r.topTokens
          .map((h) => sanitizeText(h, 44))
          .filter((h) => TOKEN_HINT.test(h))
          .slice(0, TOKEN_HINTS_MAX)
      : [];
    const rank = count(r.rank);
    rows.push({
      rank: rank !== null && rank >= 1 ? rank : null,
      window,
      trader: { userId, handle: handleOf(r.handle), displayName: text(r.displayName, NAME_MAX), verified: bool(r.verified) },
      pnlUsd: num(r.pnlUsd),
      volumeUsd: nonNeg(r.volumeUsd),
      trades: count(r.trades),
      followers: count(r.followers),
      holdingsCount: count(r.holdings),
      topTokenHints: hints,
      // Whether one was resolved, never which: the address itself is not surfaced.
      hasEvmWallet: hasEvmWallet(r.wallets),
    });
  }
  return { ok: true, data: { rows, dropped, window, providerCount: count(body.count) } };
}

function normalizeProfile(body: Rec, expectUserId: string | null): Norm<TraderProfile> {
  const userId = uuidOf(body.userId);
  if (!userId) return { ok: false, detail: "the profile carried no user id" };
  if (expectUserId && userId !== expectUserId) return { ok: false, detail: "the profile is for a different user id" };
  const pnl = obj(body.pnl);
  const profile = obj(body.profile);
  const wallets = body.wallets;
  const w = obj(wallets);
  const walletStatus: TraderProfile["walletStatus"] =
    w.status === "resolving"
      ? "resolving"
      : typeof w.evm === "string" || typeof w.solana === "string"
        ? "resolved"
        : isObj(wallets) && (w.evm === null || w.solana === null)
          ? "none"
          : "unknown";
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

/** A body that names a different trader than we asked about is not an answer about ours. */
function sameUser(body: Rec, userId: string): boolean {
  const named = uuidOf(body.userId);
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

function leg(raw: unknown, chain: ChainIdentity): FillRow["tokenIn"] {
  const l = obj(raw);
  return { token: tokenIdentity(chain, l.address), amount: nonNeg(l.amount), usd: nonNeg(l.usd) };
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
    const tokenIn = leg(r.tokenIn, chain);
    const tokenOut = leg(r.tokenOut, chain);
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
    });
  }
  return { ok: true, data: { rows, dropped, userId, nextCursor: cursorOf(body.nextCursor), moreAvailable: bool(body.moreAvailable) } };
}

function normalizeBalances(body: Rec, userId: string, filter: { slug: string; identity: ChainIdentity } | null): Norm<BalancesSnapshot> {
  if (!sameUser(body, userId)) return { ok: false, detail: "the answer is for a different user id" };
  const list = listOf(body, "holdings");
  if (!list) return missingList("holdings");
  const rows: HoldingRow[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = obj(raw);
    const tok = obj(r.token);
    const token = tokenFrom(tok.address, tok.networkId ?? r.networkId ?? r.chainId, r.chain ?? tok.chain);
    if (!token) {
      dropped++;
      continue;
    }
    rows.push({
      token,
      label: labelFrom(tok.symbol, tok.name),
      amount: nonNeg(r.amount),
      priceUsd: nonNeg(r.priceUsd),
      valueUsd: nonNeg(r.valueUsd),
      change24hPct: num(r.change24h),
    });
  }
  // Our sum over the rows we KEPT. The vendor's totalValueUsd is the same sum
  // over the rows it served; ours stays consistent with what we hold when a
  // row was dropped. Either way it excludes perps, other equity and anything
  // past the cap, so it is a floor, never the portfolio.
  const known = rows.map((r) => r.valueUsd).filter((v): v is number => v !== null);
  const floor = known.length > 0 ? known.reduce((a, b) => a + b, 0) : rows.length === 0 ? nonNeg(body.totalValueUsd) : null;
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
}

function normalizeTheses(body: Rec, ctx: ThesisContext): Norm<ThesesPage> {
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
      authorEquityUsd: nonNeg(r.equity),
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
      if (userId) {
        rows.push({
          kind: "trader",
          trader: { userId, handle: handleOf(r.handle), displayName: text(r.displayName, NAME_MAX), verified: bool(r.verified) },
          pnlUsd: num(r.pnlUsd),
          volumeUsd: nonNeg(r.volumeUsd),
          followers: count(r.followers),
          hasEvmWallet: hasEvmWallet(r.wallets),
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

function normalizeTokensSearch(body: Rec): Norm<TokenSearchPage> {
  const list = listOf(body, "tokens");
  if (!list) return missingList("tokens");
  const rows: TokenSearchHit[] = [];
  let dropped = 0;
  for (const raw of list) {
    const hit = isObj(raw) ? tokenHit(raw) : null;
    if (hit) rows.push(hit);
    else dropped++;
  }
  return { ok: true, data: { rows, dropped } };
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
      chainFilterHonoured: filter ? verifyChainFilter(filter.identity, placed).honoured : null,
    },
  };
}

function normalizeMe(body: Rec): Norm<AccountInfo> {
  const credits = obj(body.credits);
  const streams = obj(body.streams);
  if (!isObj(body.credits) && typeof body.plan !== "string") return { ok: false, detail: "the account answer carried neither a plan nor credits" };
  const plan = sanitizeText(body.plan, PLAN_MAX).toLowerCase();
  return {
    ok: true,
    data: {
      plan: /^[a-z0-9_-]{1,32}$/.test(plan) ? plan : null,
      credits: {
        monthly: count(credits.monthly),
        usedThisMonth: count(credits.usedThisMonth),
        prepaid: count(credits.prepaid),
        remaining: count(credits.remaining),
      },
      streams: { appFeed: bool(streams.appFeed), onChain: bool(streams.onChain) },
      expiresAt: toMs(body.expiresAt ?? body.planExpiresAt),
    },
  };
}

// ── The client ───────────────────────────────────────────────────────────

interface HeaderView {
  get(name: string): string | null;
}

type Attempt =
  | { kind: "transport"; failure: "timeout" | "unreachable"; detail: string }
  | { kind: "response"; status: number; headers: HeaderView; body: unknown; readError: string | null };

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

  function fail<T>(failure: ProviderFailure, detail: string, meta: CallMeta, retryAfterMs?: number): ProviderResult<T> {
    return { ok: false, failure, detail: scrub(detail), meta, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
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

  async function attempt(url: string, budgetMs: number): Promise<Attempt> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(1, budgetMs));
    try {
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
        return ctl.signal.aborted
          ? { kind: "transport", failure: "timeout", detail: `no answer within ${budgetMs} ms` }
          : { kind: "transport", failure: "unreachable", detail: errText(e) };
      }
      const success = res.status >= 200 && res.status < 300;
      let body: unknown = undefined;
      let readError: string | null = null;
      try {
        const read = await readBoundedJson<unknown>(res, success ? maxBytes : ERROR_BODY_MAX_BYTES);
        if (read.ok) body = read.value;
        // The bound's own wording is ours and safe. A JSON parse error is NOT:
        // current engines quote a slice of the input in the message, which
        // would echo the vendor's body into a detail string.
        else readError = /byte limit/.test(read.detail) ? read.detail : "the answer was not valid JSON";
      } catch (e) {
        if (ctl.signal.aborted) return { kind: "transport", failure: "timeout", detail: `the body did not finish within ${budgetMs} ms` };
        readError = "the answer could not be read";
      }
      return { kind: "response", status: res.status, headers: res.headers, body, readError };
    } finally {
      clearTimeout(timer);
    }
  }

  async function call<T>(
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

    const deadlineAt = startedAt + deadlineMs;
    const fits = (ms: number) => now() + ms <= deadlineAt;
    let attempts = 0;
    for (;;) {
      const remaining = deadlineAt - now();
      if (remaining <= 0) return fail("timeout", "the overall deadline passed", { ...meta, attempts, retrievedAt: now() });
      attempts++;
      const a = await attempt(built.url, Math.min(timeoutMs, remaining));

      if (a.kind === "transport") {
        const m: CallMeta = { ...meta, attempts, retrievedAt: now() };
        if (a.failure === "unreachable" && attempts < maxAttempts) {
          const d = backoff(attempts);
          if (fits(d)) {
            await sleep(d);
            continue;
          }
        }
        return fail(a.failure, a.detail, m);
      }

      const m: CallMeta = {
        ...meta,
        status: a.status,
        attempts,
        retrievedAt: now(),
        creditsCost: headerNum(a.headers, "x-credits-cost"),
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
            await sleep(d);
            continue;
          }
        }
        return fail("conflict-retryable", `http 409${code}`, m, retryAfterMs);
      }

      if (s === 429) {
        if (attempts < maxAttempts) {
          if (retryAfterMs !== undefined) {
            if (fits(retryAfterMs)) {
              await sleep(Math.min(retryAfterMs + Math.floor(random() * RETRY_AFTER_JITTER_MS), Math.max(0, deadlineAt - now())));
              continue;
            }
          } else {
            const d = backoff(attempts);
            if (fits(d)) {
              await sleep(d);
              continue;
            }
          }
        }
        return fail("rate-limited", `http 429${code}`, m, retryAfterMs);
      }

      if (s >= 500 && s <= 599) {
        if (attempts < maxAttempts) {
          const d = retryAfterMs ?? backoff(attempts);
          if (fits(d)) {
            await sleep(d);
            continue;
          }
        }
        return fail("server-error", `http ${s}${code}`, m, retryAfterMs);
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
        normalizeTheses(b, { filter, pagesRequested: 1, defaultAddress: null, expectUserId: null }),
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
        (b) => normalizeTheses(b, { filter, pagesRequested: pages, defaultAddress: a, expectUserId: null }),
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
        normalizeTheses(b, { filter, pagesRequested: 1, defaultAddress: null, expectUserId: u }),
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
        normalizeTheses(b, { filter: null, pagesRequested: 1, defaultAddress: a, expectUserId: u }),
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
  };
  return client;
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
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  ERROR_BODY_MAX_BYTES,
  HOLDINGS_CAP,
  THESIS_TEXT_MAX,
  ALERT_TEXT_MAX,
} as const;
