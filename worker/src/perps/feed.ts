/**
 * THE ONE LIGHTER MARKET-DATA FEED — one WebSocket for the whole fleet, one
 * file every consumer reads.
 *
 * docs/perps.md ("feed.ts" under Worker, the venue table's rate-limit row) is
 * the contract. The problem it solves is arithmetic: every hosted child sits
 * behind ONE egress IP, Standard-tier REST is 60 requests per rolling minute
 * per IP, a limit trip is a static 60 s firewall block for the whole IP (and
 * throttles WebSockets too), and paper tenants have no Lighter account to
 * authenticate with. Seventy children each polling marks and depth would be
 * over the line before anyone traded. So public market data comes from here
 * only — hosted, the orchestrator runs this and children read the file;
 * self-hosted it runs in-process — and nothing else in the fleet makes an
 * unauthenticated Lighter request.
 *
 * WHAT IT HOLDS AND WHY:
 *
 *   ONE SOCKET      `market_stats/all` (mark, index, funding for every perp,
 *                   one subscription) plus `order_book/{id}` for each market
 *                   in use. Client messages are paced (subscribe/unsubscribe
 *                   ≥ 600 ms apart, so ≤ 100/min against the venue's 200 per
 *                   IP) and the spacing survives reconnects, so a flapping
 *                   socket cannot burst. A ping goes out at least every
 *                   20 s (the venue closes a socket silent for 2 min); a
 *                   socket that says nothing for 45 s is dead and replaced.
 *   BOOKS THAT ARE  A book is a snapshot plus deltas, and a delta is only
 *   PROVABLY WHOLE  applied if its `begin_nonce` equals the previous frame's
 *                   `nonce` (the venue's own continuity check, observed exact
 *                   on the live stream). On a gap — or a level we cannot
 *                   parse, or a crossed book — the book is DROPPED, the
 *                   market leaves the file, and we unsubscribe and subscribe
 *                   again for a fresh snapshot. A gapped book is never served:
 *                   a paper fill walked through it would be a price that
 *                   never existed.
 *   "NO NEWS" IS    Lighter sends a book delta only when the book changes and
 *   NEWS, BRIEFLY   a `market_stats/all` entry only when that market's stats
 *                   change; quiet markets (SGOV, SOFI) were measured silent for
 *                   36 s. On a healthy socket with the subscription in sync,
 *                   silence means "unchanged", so a synced book or stats entry
 *                   is current as of the socket's latest frame (TCP delivers
 *                   the channel's earlier frames first). That inference is
 *                   bounded: a book silent for 2 min is re-snapshotted, and
 *                   stats silent for 5 min trigger a fresh `market_stats/all`
 *                   snapshot, rather than trusting silence forever.
 *   SPEC FROM REST  Decimals, minimums, margin fractions, fees and status exist
 *                   only in orderBookDetails (one call covers every perp). It
 *                   is read at start and every 5 min — every 1 min while the
 *                   last read failed — and a market without a spec is not in
 *                   the file: without decimals no venue number can be written.
 *   REST FALLBACK   Only while the WebSocket has been down ≥ 5 s: top-of-book
 *                   depth for the markets in use, round-robin, ≤ 20 requests
 *                   per minute in total (one per 3 s); marks fall back to the
 *                   5-minute orderBookDetails read, honestly stamped, so they
 *                   go stale for opens rather than pretend.
 *   THE FLEET       Any Lighter 429/405 anywhere in the container publishes
 *   COOLDOWN        `lighter-cooldown.json` (api.ts). While it stands this
 *                   module sends NO REST at all — the file is re-read right
 *                   before every REST call. The socket carries on: WebSocket
 *                   connects have their own per-IP budget, the firewall block
 *                   is static (retrying does not extend it), and the backoff
 *                   below keeps attempts to a handful a minute.
 *   RECONNECTS      Exponential backoff from 2 s to 60 s, half of it jittered,
 *                   reset once a connection has stayed up a minute; the first
 *                   connect is jittered too, so a fleet restart is not a
 *                   thundering herd.
 *   HISTORY, AT     The strategies read native CLOSED 5m, 15m, 1h and 4h mark
 *   THE CLOSE       candles plus the last eight hourly fundings. No child may
 *                   fetch them itself. Universe markets in use share one read
 *                   per resolution per candle close + 60 s, count_back 499,
 *                   with start/end in seconds. Healthy steady-state history is
 *                   under one request/minute across the three-market universe.
 *                   The forming candle is dropped before writing; a response
 *                   with a different resolution is refused. Each timeframe has
 *                   an independent cache, retry clock and freshness check.
 *                   Funding is read at the hour + 90 s. All history shares the
 *                   paced REST slot (one request per depthSpacingMs) and fleet
 *                   cooldown. Failures retry no sooner than a minute; lagging
 *                   bars retry for at most 15 min or one timeframe, whichever
 *                   is shorter, before waiting for the next close.
 *                   HELD MARKETS GET THEIR FUNDING HISTORY TOO, whatever the
 *                   universe: a paper position's venue clock charges every
 *                   owed hour from these rows and stops at the first one it
 *                   cannot find (executor.ts funding-gap), and a live book's
 *                   funding is reconciled against the same hours — so a
 *                   position in TSLA-PERP after an hour of downtime used to
 *                   read "funding unread" until it closed. `heldMarketIds`
 *                   names them; each costs one `fundings` read an hour (no
 *                   candles — only perp-trend reads those), inside the same
 *                   paced REST slot, so the fleet budget grows by at most one
 *                   request an hour per held market. Every candle is a venue integer at the market's
 *                   price decimals, as a string, and history at a precision
 *                   the market no longer has is dropped with its books.
 *   IDLE IS SILENT  With no market in use there is no socket and no REST: the
 *                   feed never contacts Lighter on behalf of nobody.
 *   AN ATOMIC FILE  Every 2 s (the contract: ≤ 5 s), tmp file then rename, so
 *                   no reader can see half of it. Every venue number is an
 *                   integer at the market's own precision, written as a string.
 *                   A market appears only when it has a spec, a price AND a
 *                   book; each part carries its own observation time and the
 *                   reader (feed-reader.ts) judges freshness — 30 s for opens,
 *                   10 s for a paper fill — never this writer.
 *
 * The file format lives in feed-reader.ts, which children import; this module
 * (the socket, the timers, the REST client) is imported only by whoever runs
 * the feed.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  LIGHTER_ROUTE_V1,
  PERP_TREND_UNIVERSE,
  parseDecimalToScaled,
  perpMarketById,
  perpMarketByKey,
  type PerpMarket,
  type PerpMarketSpec,
} from "../../../packages/core/src/index";
import { readLighterCooldown, type LighterApi } from "./api";
import {
  FEED_BOOK_LEVELS,
  FEED_TIMEFRAMES,
  type FeedTimeframe,
  FEED_MAX_CANDLES,
  FEED_MIN_CANDLES,
  LIGHTER_FEED_VERSION,
  parseLighterFeedMarket,
  specToJson,
  type FeedCandleJson,
  type FeedFundingJson,
  type FeedLevelJson,
  type LighterFeedFile,
  type LighterFeedFileMarket,
} from "./feed-reader";
import type { DepthLevel, DepthRead, FundingRow, MarkCandle, OrderBookDetailsRead, PerpDecimals, PerpMarketView } from "./markets";

// ── injectable edges ────────────────────────────────────────────────────────

/**
 * The slice of api.ts the feed uses. It must be the "public" client: a token
 * would count against someone's L1 address. The two history reads are
 * optional so a client without them (a test double, an old wiring) simply
 * carries no candles — which the route reads as `perp-signal-unread`, never as
 * a quiet market.
 */
export type LighterFeedApi = Pick<LighterApi, "budgetKey" | "orderBookDetails" | "orderBookOrders"> &
  Partial<Pick<LighterApi, "markPriceCandles" | "fundings">>;

/** The markets whose history the feed fetches: the perps route's universe, by venue id. */
const HISTORY_MARKET_IDS: ReadonlySet<number> = new Set(
  PERP_TREND_UNIVERSE.map((k) => perpMarketByKey(k)?.marketId).filter((x): x is number => x !== undefined),
);
const HOUR_MS = 3_600_000;

/**
 * The slice of the WHATWG WebSocket the feed uses — Node 22's global
 * `WebSocket` satisfies it, and tests inject a fake with no network.
 */
export interface FeedSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type FeedSocketCtor = new (url: string) => FeedSocket;

export interface FeedTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const WS_OPEN = 1;
/** An empty market set this long closes the socket (see manageSocket). */
const IDLE_CLOSE_MS = 60_000;

// ── tuning ──────────────────────────────────────────────────────────────────

export const LIGHTER_FEED_DEFAULTS = Object.freeze({
  /** One heartbeat drives everything below; every other interval is a timestamp comparison inside it. */
  pumpMs: 200,
  /** ≤ 5_000 (the contract). */
  writeIntervalMs: 2_000,
  /** How often marketIds() is asked for the markets in use. */
  marketsRefreshMs: 2_000,
  /** ≤ 60_000. The venue closes a socket that sends nothing for 2 min. */
  pingIntervalMs: 20_000,
  /** No frame at all for this long (market_stats/all alone ticks several times a second, plus our pongs) is a dead socket. */
  idleTimeoutMs: 45_000,
  /** Open plus the venue's `connected` frame within this, or the attempt is abandoned. */
  connectTimeoutMs: 15_000,
  /** ≥ 600: subscribe/unsubscribe messages ≤ 100/min, half the venue's 200 client messages per IP. */
  subscribeSpacingMs: 600,
  reconnectBaseMs: 2_000,
  reconnectMaxMs: 60_000,
  /** A connection up this long resets the backoff. */
  healthyResetMs: 60_000,
  startJitterMs: 1_000,
  /** A subscription with no snapshot after this is asked for again. */
  subscribePendingMs: 30_000,
  /** A synced book with no frame of its own for this long is re-snapshotted (see "NO NEWS"). */
  bookRefreshMs: 120_000,
  /** A market's stats entry silent this long triggers a fresh market_stats/all snapshot; until it lands, its prices stop aging forward. */
  statsSilenceMs: 300_000,
  /** This many gaps on one market within a minute and the next resubscribe waits subscribePendingMs: a venue sending a level we cannot parse must not make us spin. */
  gapBurst: 3,
  /** ≥ 300_000 (the contract: orderBookDetails ≤ 1 per 5 min). */
  detailsIntervalMs: 300_000,
  /** ≥ 60_000: after a failed read. A failure spent at most one request, or tripped the cooldown that blocks the retry anyway. */
  detailsRetryMs: 60_000,
  /** The socket must be down this long before REST depth is spent on it: a routine reconnect takes ~2 s. */
  restFallbackAfterMs: 5_000,
  /** ≥ 3_000: REST depth ≤ 20 requests per minute, fleet-wide. */
  depthSpacingMs: 3_000,
  /** Orders per side asked of orderBookOrders (≤ 250); aggregated into FEED_BOOK_LEVELS levels. */
  depthOrders: 100,
  /** The largest frame accepted. A BTC snapshot measured 290 KB (≈ 7,800 levels). */
  maxMessageChars: 8_000_000,
  /** A snapshot side larger than this is refused. */
  maxLevelsPerSide: 50_000,
  /** Native candles asked per history read: the one in progress plus ≥ FEED_MIN_CANDLES closed. */
  candleCountBack: 499,
  /** ≥ 60_000: candles are re-read this long after each native candle close (the contract: close + 60 s). */
  candleRefreshLagMs: 60_000,
  /** ≥ 60_000: hourly fundings are re-read this long after each hour. */
  fundingRefreshLagMs: 90_000,
  /** ≥ 60_000: a failed history read, or one that came back without the period that just closed, waits this long. */
  historyRetryMs: 60_000,
  /** How long after a close the feed keeps asking for a period the venue has not published yet. */
  historyLagWindowMs: 900_000,
});

export type LighterFeedTuning = { -readonly [K in keyof typeof LIGHTER_FEED_DEFAULTS]: number };

/** Bounds the contract sets. Tuning may be stricter, never looser. */
function checkTuning(t: LighterFeedTuning): void {
  const bad = (what: string) => {
    throw new Error(`lighter feed: ${what}`);
  };
  for (const [k, v] of Object.entries(t)) if (!Number.isSafeInteger(v) || v <= 0) bad(`${k} must be a positive integer`);
  if (t.writeIntervalMs > 5_000) bad("writeIntervalMs must be ≤ 5000 (the file is rewritten at least every 5 s)");
  if (t.pingIntervalMs > 60_000) bad("pingIntervalMs must be ≤ 60000");
  if (t.idleTimeoutMs <= t.pingIntervalMs) bad("idleTimeoutMs must exceed pingIntervalMs");
  if (t.subscribeSpacingMs < 600) bad("subscribeSpacingMs must be ≥ 600 (≤ 100 subscribe messages per minute)");
  if (t.detailsIntervalMs < 300_000) bad("detailsIntervalMs must be ≥ 300000 (orderBookDetails ≤ 1 per 5 min)");
  if (t.detailsRetryMs < 60_000) bad("detailsRetryMs must be ≥ 60000");
  if (t.depthSpacingMs < 3_000) bad("depthSpacingMs must be ≥ 3000 (REST depth ≤ 20 per minute)");
  if (t.depthOrders > 250) bad("depthOrders must be ≤ 250 (the endpoint's limit)");
  if (t.reconnectMaxMs < t.reconnectBaseMs) bad("reconnectMaxMs must be ≥ reconnectBaseMs");
  if (t.candleCountBack <= FEED_MIN_CANDLES || t.candleCountBack >= FEED_MAX_CANDLES) bad(`candleCountBack must be in ${FEED_MIN_CANDLES + 1}..${FEED_MAX_CANDLES - 1}`);
  if (t.candleRefreshLagMs < 60_000 || t.fundingRefreshLagMs < 60_000) bad("history refresh lags must be ≥ 60000 (the period must have closed at the venue)");
  if (t.historyRetryMs < 60_000) bad("historyRetryMs must be ≥ 60000");
}

export interface LighterFeedOptions {
  /** The union of markets in use (venue market ids). Asked every marketsRefreshMs; ids outside LIGHTER_MARKETS_V1 are ignored. */
  marketIds: () => readonly number[];
  /**
   * The markets a book HOLDS a position in (a subset of marketIds'): their
   * hourly funding history is fetched whether or not they are in the perps
   * route's universe, so a held position's funding never stalls on a market
   * perp-trend does not trade. Absent: the universe only (the old behaviour).
   */
  heldMarketIds?: () => readonly number[];
  /** Defaults to every native strategy timeframe; all share the fleet REST pacing slot. */
  candleTimeframes?: readonly FeedTimeframe[];
  /** Where the file goes: lighterFeedPath(fleetHome). */
  outPath: string;
  /** The home whose fleet cooldown file applies (api.ts lighterCooldownFile: MERRYMEN_FLEET_HOME when set, else this). */
  home: string;
  /** The public (budgetKey "public") client; never an address-keyed one. */
  api: LighterFeedApi;
  /** Default: Lighter's Robinhood stream, read-only mode. */
  wsUrl?: string;
  /** Default: Node's global WebSocket. */
  WebSocketImpl?: FeedSocketCtor;
  now?: () => number;
  logger?: (line: string) => void;
  /** [0, 1); jitter only. */
  random?: () => number;
  timers?: FeedTimers;
  tuning?: Partial<LighterFeedTuning>;
}

export interface LighterFeedHealth {
  /** A socket is open and the venue said `connected`. */
  wsUp: boolean;
  /** ms since when the socket has been down; null while up. */
  wsDownSince: number | null;
  connects: number;
  reconnectAttempt: number;
  /** Book gaps (nonce discontinuities, unparseable levels, crossed books) since start. */
  gaps: number;
  /** Books currently in sync on the socket. */
  syncedBooks: number;
  detailsAt: number | null;
  lastWriteAt: number | null;
  /** The cooldown this feed last saw standing, ms, or null. */
  cooldownUntil: number | null;
}

export interface LighterFeedHandle {
  /** Close the socket and stop every timer. The file is left in place and ages into staleness. */
  stop(): void;
  /** The file's content as of now (what the next write would contain). */
  snapshot(): LighterFeedFile;
  health(): LighterFeedHealth;
}

// ── venue frames ────────────────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** A positive decimal as the venue renders prices. */
const DECIMAL_RE = /^\d{1,30}(?:\.\d{1,30})?$/;
/** Funding: percent per hour, signed, ≤ 4 dp — what feed-reader.ts accepts. */
const FUNDING_RE = /^-?\d{1,3}(?:\.\d{1,4})?$/;
const BOOK_CHANNEL_RE = /^order_book:(\d{1,5})$/;
const STATS_CHANNEL = "market_stats:all";

interface StatsEntry {
  mark: string;
  index: string;
  funding: string | null;
  lastFunding: string | null;
  lastFundingAt: number | null;
  /** When this market's own entry last arrived. */
  entryAt: number;
  /** When it was last known current (entryAt, carried forward by the socket's liveness — "NO NEWS"). */
  observedAt: number;
  conn: number;
}

/**
 * One market_stats entry, checked against the frozen table: an id whose
 * symbol is not the table's means the venue renumbered, and nothing in the
 * entry can be trusted to describe the market we would sign against.
 * Prices stay strings here; they are scaled with the spec's decimals at
 * write time, when a spec is known.
 */
function parseStatsEntry(v: unknown, mk: PerpMarket): Omit<StatsEntry, "entryAt" | "observedAt" | "conn"> | null {
  if (!isRecord(v) || v.market_id !== mk.marketId || v.symbol !== mk.symbol) return null;
  if (typeof v.mark_price !== "string" || !DECIMAL_RE.test(v.mark_price)) return null;
  if (typeof v.index_price !== "string" || !DECIMAL_RE.test(v.index_price)) return null;
  const funding = typeof v.current_funding_rate === "string" && FUNDING_RE.test(v.current_funding_rate) ? v.current_funding_rate : null;
  const lastRate = typeof v.funding_rate === "string" && FUNDING_RE.test(v.funding_rate) ? v.funding_rate : null;
  const lastAt = typeof v.funding_timestamp === "number" && Number.isSafeInteger(v.funding_timestamp) && v.funding_timestamp > 0 ? v.funding_timestamp : null;
  // The last payment is a pair: a rate with no time (or the reverse) is not one.
  const paired = lastRate !== null && lastAt !== null;
  return { mark: v.mark_price, index: v.index_price, funding, lastFunding: paired ? lastRate : null, lastFundingAt: paired ? lastAt : null };
}

/** A level list from a book frame → [price, size] venue integers; size 0 only where `zeroOk` (a delta's deletion). Null on anything else. */
function parseLevels(raw: unknown, d: PerpDecimals, zeroOk: boolean, max: number): Array<[bigint, bigint]> | null {
  if (!Array.isArray(raw) || raw.length > max) return null;
  const out: Array<[bigint, bigint]> = [];
  for (const lv of raw) {
    if (!isRecord(lv)) return null;
    const price = parseDecimalToScaled(lv.price, d.priceDecimals);
    const size = parseDecimalToScaled(lv.size, d.sizeDecimals);
    if (price === null || price <= 0n || size === null || size < 0n || (size === 0n && !zeroOk)) return null;
    out.push([price, size]);
  }
  return out;
}

function nonceOf(x: unknown): number | null {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null;
}

const byPriceAsc = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** Best FEED_BOOK_LEVELS of one side of a full book. */
function topOf(side: Map<bigint, bigint>, dir: "bids" | "asks"): DepthLevel[] {
  const prices = [...side.keys()].sort(byPriceAsc);
  if (dir === "bids") prices.reverse();
  return prices.slice(0, FEED_BOOK_LEVELS).map((price) => ({ price, baseAmount: side.get(price) as bigint }));
}

/**
 * orderBookOrders answers ORDERS, best first; the file carries LEVELS. Equal
 * prices are adjacent (parseDepth enforces monotone sides), so a run is one
 * level. When the page came back full, the deepest level may continue past
 * it, so it is dropped rather than understated as a whole level.
 */
function levelsFromOrders(orders: readonly DepthLevel[], pageFull: boolean): DepthLevel[] {
  const out: DepthLevel[] = [];
  for (const o of orders) {
    const last = out[out.length - 1];
    if (last !== undefined && last.price === o.price) last.baseAmount += o.baseAmount;
    else out.push({ price: o.price, baseAmount: o.baseAmount });
  }
  if (pageFull) out.pop();
  return out.slice(0, FEED_BOOK_LEVELS);
}

const crossed = (bids: readonly DepthLevel[], asks: readonly DepthLevel[]) => {
  const b = bids[0];
  const a = asks[0];
  return b !== undefined && a !== undefined && b.price >= a.price;
};

const sameDecimals = (a: PerpDecimals, b: PerpDecimals) => a.sizeDecimals === b.sizeDecimals && a.priceDecimals === b.priceDecimals;

const levelJson = (l: DepthLevel): FeedLevelJson => [l.price.toString(), l.baseAmount.toString()];

// ── state ───────────────────────────────────────────────────────────────────

interface WsBook {
  conn: number;
  phase: "pending" | "synced";
  /**
   * The venue holds (or may hold) a subscription for this book: a subscribe
   * went out and no unsubscribe since. Decides whether a re-snapshot needs an
   * unsubscribe first, and whether dropping the market needs one at all.
   */
  live: boolean;
  /** When the current subscribe went out; null while one is queued. The no-snapshot timeout counts from here. */
  sentAt: number | null;
  /** A pending book waits until this before asking again (gap burst, unparseable snapshot). */
  retryAt: number | null;
  decimals: PerpDecimals;
  bids: Map<bigint, bigint>;
  asks: Map<bigint, bigint>;
  nonce: number;
  /** When a frame for THIS book last arrived. */
  lastFrameAt: number;
  /** A refresh re-snapshot is in flight: keep serving the book, but no newer than this. */
  frozenAt: number | null;
}

/** A book no longer being maintained: a WS book frozen when its socket died, or a REST read. */
interface HeldBook {
  bids: DepthLevel[];
  asks: DepthLevel[];
  observedAt: number;
  decimals: PerpDecimals;
  source: "ws" | "rest";
}

interface Conn {
  id: number;
  socket: FeedSocket;
  openedAt: number;
  /** When the venue's `connected` frame arrived; null until then. */
  connectedAt: number | null;
  /** When the last well-formed frame (any channel) arrived. */
  lastFrameAt: number;
  lastPingAt: number;
  closed: boolean;
  queue: Array<{ op: "subscribe" | "unsubscribe"; channel: string }>;
  /** market_stats/all, as WsBook's live/sentAt; plus whether its snapshot arrived and when it was last re-asked. */
  statsLive: boolean;
  statsSentAt: number | null;
  statsSynced: boolean;
  statsRefreshAt: number;
}

// ── the feed ────────────────────────────────────────────────────────────────

export function startLighterFeed(opts: LighterFeedOptions): LighterFeedHandle {
  const tune: LighterFeedTuning = { ...LIGHTER_FEED_DEFAULTS, ...(opts.tuning ?? {}) };
  checkTuning(tune);
  if (opts.api.budgetKey !== "public") {
    // An address-keyed client would bill the whole fleet's market data to one tenant's L1 bucket (and api.ts refuses its unauthenticated reads anyway).
    throw new Error('lighter feed: api must be the "public" client (budgetKey "public")');
  }
  const wsUrl = opts.wsUrl ?? `${LIGHTER_ROUTE_V1.wsUrl}?readonly=true`;
  // Never a plaintext socket to a venue, whatever a config says.
  if (!/^wss:\/\/[^\s]+$/.test(wsUrl)) throw new Error("lighter feed: wsUrl must be a wss:// URL");
  const maybeCtor = opts.WebSocketImpl ?? (globalThis as unknown as { WebSocket?: FeedSocketCtor }).WebSocket;
  if (maybeCtor === undefined) throw new Error("lighter feed: no WebSocket implementation (Node ≥ 22 has one built in)");
  const Ctor: FeedSocketCtor = maybeCtor;
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const logger = opts.logger ?? ((line: string) => console.log(line));
  const timers: FeedTimers = opts.timers ?? {
    setTimeout: (fn, ms) => {
      const h = setTimeout(fn, ms);
      // The feed never holds a process open on its own; whoever started it decides when to stop.
      (h as { unref?: () => void }).unref?.();
      return h;
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };

  const t0 = now();
  let stopped = false;
  let timer: unknown = null;

  let desired = new Set<number>();
  let lastMarketsAt = -Infinity;
  let emptySince: number | null = t0;

  let details: { at: number; read: OrderBookDetailsRead } | null = null;
  let detailsNextAt = t0;
  let detailsInFlight = false;

  const stats = new Map<number, StatsEntry>();
  const books = new Map<number, WsBook>();
  const held = new Map<number, HeldBook>(); // WS books frozen by a dead socket
  const rest = new Map<number, HeldBook>(); // REST depth reads
  const gapLog = new Map<number, number[]>();
  let gaps = 0;

  let conn: Conn | null = null;
  let connSeq = 0;
  let connects = 0;
  let attempt = 0;
  let reconnectAt = t0 + Math.floor(random() * tune.startJitterMs);
  let wsDownSince: number | null = t0;
  /** Global, so the ≤ 100/min pacing holds across reconnects. */
  let lastPacedSendAt = -Infinity;

  /** Also the fleet REST pacing slot the history reads share (≤ one REST read per depthSpacingMs between them). */
  let depthNextAt = t0;
  let depthInFlight = false;
  let depthCursor = 0;

  /** Per universe market in use: the last candle and funding reads, and when each is next due. */
  interface MarketHistory {
    candles: { at: number; rows: MarkCandle[]; priceDecimals: number } | null;
    fundings: { at: number; rows: FundingRow[] } | null;
    candlesNextAt: number;
    frames: Partial<Record<FeedTimeframe, { candles: MarketHistory["candles"]; nextAt: number }>>;
    fundingsNextAt: number;
  }
  const history = new Map<number, MarketHistory>();
  let historyInFlight = false;
  // Keep the legacy 4h read first; funding is checked before extra frames.
  const candleTimeframes = [...new Set(opts.candleTimeframes ?? ["4h", "1h", "15m", "5m"])] as FeedTimeframe[];
  if (candleTimeframes.some((frame) => !Object.hasOwn(FEED_TIMEFRAMES, frame))) throw new Error("lighter feed: invalid candle timeframe");
  const historyOf = (id: number, t: number): MarketHistory => {
    let h = history.get(id);
    if (h === undefined) {
      h = { candles: null, fundings: null, candlesNextAt: t, fundingsNextAt: t, frames: {} };
      history.set(id, h);
    }
    return h;
  };

  let localCooldownUntil = 0;
  let seenCooldownUntil: number | null = null;
  let lastWriteAt: number | null = null;

  const lastLogged = new Map<string, number>();
  /** One line per key per minute: a reconnect loop must not flood the log. */
  const log = (key: string, msg: string) => {
    const t = now();
    const prev = lastLogged.get(key);
    if (prev !== undefined && t - prev < 60_000) return;
    // Keys can carry caller-supplied ids; a long-lived process must not grow this without bound.
    if (lastLogged.size > 1_000) lastLogged.clear();
    lastLogged.set(key, t);
    try {
      logger(`[lighter-feed] ${msg}`);
    } catch {
      /* a logger that throws must not take the feed down */
    }
  };

  const specOf = (id: number): PerpMarketView | null => (desired.has(id) ? (details?.read.markets.get(id) ?? null) : null);
  const decimalsOf = (spec: PerpMarketSpec): PerpDecimals => ({ sizeDecimals: spec.sizeDecimals, priceDecimals: spec.priceDecimals });

  /**
   * The cooldown standing now, ms, or 0. The FILE is re-read every time: any
   * process in the container may have tripped it since we last looked.
   */
  const coolingUntil = (t: number): number => {
    const file = readLighterCooldown(opts.home, t) ?? 0;
    const until = Math.max(file, localCooldownUntil);
    seenCooldownUntil = until > t ? until : null;
    return until > t ? until : 0;
  };

  // ── the socket ──────────────────────────────────────────────────────────

  function sendRaw(c: Conn, msg: object): boolean {
    if (c.closed || c.socket.readyState !== WS_OPEN) return false;
    try {
      c.socket.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      drop(c, `send failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  const queued = (c: Conn, channel: string) => c.queue.some((q) => q.channel === channel);

  /**
   * Ask for a (fresh) subscription: unsubscribe first when the venue may still
   * hold one — a second subscribe's behaviour is undocumented, unsubscribe
   * then subscribe was observed to deliver a new snapshot — and replace
   * whatever was queued for the channel, so the queue can never end on an
   * unsubscribe behind a stale subscribe.
   */
  function ask(c: Conn, channel: string, live: boolean): void {
    c.queue = c.queue.filter((q) => q.channel !== channel);
    if (live) c.queue.push({ op: "unsubscribe", channel });
    c.queue.push({ op: "subscribe", channel });
  }

  function askBook(c: Conn, id: number, b: WsBook): void {
    b.sentAt = null;
    b.retryAt = null;
    ask(c, `order_book/${id}`, b.live);
  }

  function connect(t: number): void {
    let socket: FeedSocket;
    try {
      socket = new Ctor(wsUrl);
    } catch (e) {
      log("ctor", `could not open the socket: ${e instanceof Error ? e.message : String(e)}`);
      scheduleReconnect(t, false);
      return;
    }
    connects++;
    const c: Conn = {
      id: ++connSeq,
      socket,
      openedAt: t,
      connectedAt: null,
      lastFrameAt: t,
      lastPingAt: t,
      closed: false,
      queue: [],
      statsLive: false,
      statsSentAt: null,
      statsSynced: false,
      statsRefreshAt: t,
    };
    conn = c;
    socket.onopen = () => {
      /* the venue's `connected` frame, not the open event, starts the session */
    };
    socket.onmessage = (ev) => {
      if (conn !== c || c.closed) return;
      try {
        onFrame(c, ev.data);
      } catch (e) {
        log("frame-throw", `frame handler failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    socket.onclose = (ev) => {
      if (conn === c) drop(c, `closed by the venue (${ev?.code ?? "?"})`);
    };
    socket.onerror = () => {
      if (conn === c) drop(c, "socket error");
    };
  }

  function scheduleReconnect(t: number, healthy: boolean): void {
    if (healthy) attempt = 0;
    const d = Math.min(tune.reconnectMaxMs, tune.reconnectBaseMs * 2 ** Math.min(attempt, 20));
    attempt++;
    reconnectAt = t + Math.floor(d / 2 + random() * (d / 2));
  }

  /** Tear a connection down. Books it kept in sync are held, frozen at the last moment they were known current. */
  function drop(c: Conn, why: string): void {
    if (c.closed) return;
    c.closed = true;
    const t = now();
    try {
      c.socket.close();
    } catch {
      /* already gone */
    }
    for (const [id, b] of books) {
      if (b.conn !== c.id || b.phase !== "synced") continue;
      const bids = topOf(b.bids, "bids");
      const asks = topOf(b.asks, "asks");
      if (!crossed(bids, asks)) held.set(id, { bids, asks, observedAt: b.frozenAt ?? c.lastFrameAt, decimals: b.decimals, source: "ws" });
    }
    books.clear();
    const wasUp = c.connectedAt !== null;
    if (conn === c) conn = null;
    if (wsDownSince === null) wsDownSince = t;
    scheduleReconnect(t, wasUp && c.connectedAt !== null && t - c.connectedAt >= tune.healthyResetMs);
    log("drop", `socket down (${why}); reconnect in ${Math.max(0, reconnectAt - t)} ms`);
  }

  function gap(c: Conn, id: number, why: string): void {
    const b = books.get(id);
    if (b === undefined) return;
    const t = now();
    gaps++;
    unsync(b, id);
    const recent = (gapLog.get(id) ?? []).filter((x) => t - x < 60_000);
    recent.push(t);
    gapLog.set(id, recent);
    const burst = recent.length >= tune.gapBurst;
    if (!burst) {
      // A subscribe still queued (never sent) will bring the snapshot by itself.
      if (b.sentAt !== null || !queued(c, `order_book/${id}`)) askBook(c, id, b);
    } else {
      b.retryAt = t + tune.subscribePendingMs;
    }
    log(`gap-${id}`, `order_book/${id}: ${why}; book dropped, re-snapshotting${burst ? ` in ${tune.subscribePendingMs} ms (gap burst)` : ""}`);
  }

  /** Forget a book's content. Nothing older may stand in for it either: the market leaves the file until a fresh snapshot. */
  function unsync(b: WsBook, id: number): void {
    b.phase = "pending";
    b.bids = new Map();
    b.asks = new Map();
    b.frozenAt = null;
    held.delete(id);
    rest.delete(id);
  }

  function onFrame(c: Conn, data: unknown): void {
    if (typeof data !== "string") {
      log("binary", "ignored a non-text frame");
      return;
    }
    if (data.length > tune.maxMessageChars) {
      drop(c, `a ${data.length}-char frame exceeds the ${tune.maxMessageChars} cap`);
      return;
    }
    let m: unknown;
    try {
      m = JSON.parse(data);
    } catch {
      log("json", "ignored a frame that is not JSON");
      return;
    }
    if (!isRecord(m)) return;
    const t = now();
    c.lastFrameAt = t;
    switch (m.type) {
      case "connected":
        if (c.connectedAt === null) {
          c.connectedAt = t;
          c.lastPingAt = t;
          wsDownSince = null;
          ask(c, "market_stats/all", false);
          c.statsRefreshAt = t;
          log("up", "socket up");
        }
        return;
      case "ping":
        sendRaw(c, { type: "pong" });
        return;
      case "subscribed/market_stats":
      case "update/market_stats":
        onStats(c, m, m.type === "subscribed/market_stats", t);
        return;
      case "subscribed/order_book":
      case "update/order_book":
        onBook(c, m, m.type === "subscribed/order_book", t);
        return;
      default:
        // pong, unsubscribed, and anything new: liveness only.
        if (isRecord(m.error)) log(`venue-error-${String(m.error.code)}`, `venue error ${String(m.error.code)}: ${String(m.error.message).slice(0, 120)}`);
    }
  }

  function onStats(c: Conn, m: Record<string, unknown>, snapshot: boolean, t: number): void {
    if (m.channel !== STATS_CHANNEL || !isRecord(m.market_stats)) {
      log("stats-shape", "ignored a market_stats frame of an unexpected shape");
      return;
    }
    if (snapshot) {
      // A snapshot is complete: whatever it leaves out is not known now.
      stats.clear();
      c.statsSynced = true;
      c.statsRefreshAt = t;
    } else if (!c.statsSynced) {
      return;
    }
    for (const [k, v] of Object.entries(m.market_stats)) {
      const id = /^\d{1,5}$/.test(k) ? Number(k) : null;
      const mk = id === null ? null : perpMarketById(id);
      if (id === null || mk === null) continue; // spot, or a listing newer than the frozen table: never ours
      const e = parseStatsEntry(v, mk);
      if (e === null) {
        // Unread, not "as before": the previous entry is no longer what the venue says.
        stats.delete(id);
        log(`stats-${id}`, `market_stats for ${mk.key} did not parse; unread until the next good entry`);
        continue;
      }
      stats.set(id, { ...e, entryAt: t, observedAt: t, conn: c.id });
    }
    // NO NEWS: every entry this subscription delivered, and not silent past the bound, is current as of this frame.
    for (const s of stats.values()) if (s.conn === c.id && t - s.entryAt <= tune.statsSilenceMs) s.observedAt = t;
  }

  function onBook(c: Conn, m: Record<string, unknown>, snapshot: boolean, t: number): void {
    const ch = typeof m.channel === "string" ? BOOK_CHANNEL_RE.exec(m.channel) : null;
    if (ch === null) return;
    const id = Number(ch[1]);
    const b = books.get(id);
    // Frames for a market we no longer follow, or from before a re-snapshot, change nothing.
    if (b === undefined || b.conn !== c.id) return;
    const ob = m.order_book;
    if (!isRecord(ob) || (ob.code !== undefined && ob.code !== 0)) {
      if (b.phase === "synced") gap(c, id, "book frame of an unexpected shape");
      return;
    }
    if (snapshot) {
      const nonce = nonceOf(ob.nonce);
      const asks = parseLevels(ob.asks, b.decimals, false, tune.maxLevelsPerSide);
      const bids = parseLevels(ob.bids, b.decimals, false, tune.maxLevelsPerSide);
      const bidMap = bids === null ? null : new Map(bids);
      const askMap = asks === null ? null : new Map(asks);
      // A price listed twice in a snapshot is a snapshot we do not understand.
      if (nonce === null || bids === null || asks === null || bidMap === null || askMap === null || bidMap.size !== bids.length || askMap.size !== asks.length) {
        unsync(b, id);
        b.retryAt = t + tune.subscribePendingMs;
        log(`snap-${id}`, `order_book/${id}: snapshot did not parse; retrying in ${tune.subscribePendingMs} ms`);
        return;
      }
      b.bids = bidMap;
      b.asks = askMap;
      b.nonce = nonce;
      b.phase = "synced";
      b.lastFrameAt = t;
      b.frozenAt = null;
      b.retryAt = null;
      if (crossed(topOf(b.bids, "bids"), topOf(b.asks, "asks"))) {
        gap(c, id, "crossed snapshot");
        return;
      }
      // Superseded: the socket's book is the one to serve.
      held.delete(id);
      rest.delete(id);
      return;
    }
    if (b.phase !== "synced") return; // in flight from before a resubscribe
    const begin = nonceOf(ob.begin_nonce);
    const nonce = nonceOf(ob.nonce);
    if (begin === null || nonce === null) return gap(c, id, "update without nonces");
    if (begin !== b.nonce) return gap(c, id, `nonce gap (have ${b.nonce}, update begins at ${begin})`);
    if (nonce < begin) return gap(c, id, `nonce went backwards (${begin} → ${nonce})`);
    const asks = parseLevels(ob.asks, b.decimals, true, tune.maxLevelsPerSide);
    const bids = parseLevels(ob.bids, b.decimals, true, tune.maxLevelsPerSide);
    if (asks === null || bids === null) return gap(c, id, "update level did not parse");
    for (const [p, s] of asks) {
      if (s === 0n) b.asks.delete(p);
      else b.asks.set(p, s);
    }
    for (const [p, s] of bids) {
      if (s === 0n) b.bids.delete(p);
      else b.bids.set(p, s);
    }
    b.nonce = nonce;
    b.lastFrameAt = t;
  }

  // ── housekeeping (every pump) ───────────────────────────────────────────

  function refreshDesired(t: number): void {
    if (t - lastMarketsAt < tune.marketsRefreshMs) return;
    lastMarketsAt = t;
    let ids: unknown;
    try {
      ids = opts.marketIds();
    } catch (e) {
      log("markets-throw", `marketIds() threw; keeping the previous set: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!Array.isArray(ids)) {
      log("markets-shape", "marketIds() did not return an array; keeping the previous set");
      return;
    }
    const next = new Set<number>();
    for (const x of ids) {
      if (typeof x === "number" && Number.isSafeInteger(x) && perpMarketById(x) !== null) next.add(x);
      else log(`markets-bad-${String(x)}`, `ignored market id ${String(x)}: not in LIGHTER_MARKETS_V1`);
    }
    desired = next;
    if (desired.size > 0) emptySince = null;
    else if (emptySince === null) emptySince = t;
    for (const id of [...held.keys()]) if (!desired.has(id)) held.delete(id);
    for (const id of [...rest.keys()]) if (!desired.has(id)) rest.delete(id);
    for (const id of [...history.keys()]) if (!desired.has(id)) history.delete(id);
  }

  function manageSocket(t: number): void {
    const c = conn;
    // NOTHING IN USE, NOTHING SENT: with no market to follow the feed does not
    // talk to Lighter at all — a self-hosted owner with perps off never has a
    // socket open to the venue on their behalf. A set empty for a moment (a
    // settings reload) is not a reason to drop a good socket, so it is closed
    // only once the set has stayed empty a minute.
    if (desired.size === 0) {
      if (c !== null && emptySince !== null && t - emptySince >= IDLE_CLOSE_MS) {
        drop(c, "no market in use");
        attempt = 0;
        reconnectAt = t;
      }
      if (c === null || c.closed) return;
    }
    if (c === null) {
      if (t >= reconnectAt) connect(t);
      return;
    }
    if (c.connectedAt === null) {
      if (t - c.openedAt > tune.connectTimeoutMs) drop(c, "no `connected` frame in time");
      return;
    }
    if (t - c.lastFrameAt > tune.idleTimeoutMs) {
      drop(c, `silent for ${t - c.lastFrameAt} ms`);
      return;
    }
    if (t - c.lastPingAt >= tune.pingIntervalMs) {
      c.lastPingAt = t;
      if (!sendRaw(c, { type: "ping" })) return;
    }

    // market_stats/all: re-ask a subscription that never answered; re-snapshot when a market in use has gone quiet too long.
    const statsCh = "market_stats/all";
    if (!c.statsSynced && c.statsSentAt !== null && t - c.statsSentAt > tune.subscribePendingMs) {
      c.statsSentAt = null;
      ask(c, statsCh, c.statsLive);
    } else if (c.statsSynced && !queued(c, statsCh) && t - c.statsRefreshAt > tune.statsSilenceMs) {
      const quiet = [...desired].some((id) => {
        const s = stats.get(id);
        return s === undefined || s.conn !== c.id || t - s.entryAt > tune.statsSilenceMs;
      });
      if (quiet) {
        c.statsRefreshAt = t;
        log("stats-refresh", "a market in use has had no market_stats entry for 5 min; re-snapshotting market_stats/all");
        ask(c, statsCh, c.statsLive);
      }
    }

    for (const id of desired) {
      const view = specOf(id);
      if (view === null) continue; // no decimals yet: nothing we could parse
      const dec = decimalsOf(view.spec);
      const ch = `order_book/${id}`;
      const b = books.get(id);
      if (b === undefined || b.conn !== c.id) {
        const nb: WsBook = { conn: c.id, phase: "pending", live: false, sentAt: null, retryAt: null, decimals: dec, bids: new Map(), asks: new Map(), nonce: 0, lastFrameAt: t, frozenAt: null };
        books.set(id, nb);
        askBook(c, id, nb);
        continue;
      }
      if (!sameDecimals(b.decimals, dec)) {
        // The venue changed the market's precision: every integer in the book is at the old scale.
        b.decimals = dec;
        gap(c, id, "market decimals changed");
        continue;
      }
      if (queued(c, ch)) continue; // an ask is on its way
      if (b.phase === "pending") {
        if (b.retryAt !== null) {
          if (t >= b.retryAt) askBook(c, id, b);
        } else if (b.sentAt === null || t - b.sentAt > tune.subscribePendingMs) {
          // Never asked on this socket, or asked and no snapshot came.
          askBook(c, id, b);
        }
      } else if (b.frozenAt === null) {
        if (t - b.lastFrameAt > tune.bookRefreshMs) {
          // Silent too long to keep inferring "unchanged": serve it frozen while a fresh snapshot is fetched.
          b.frozenAt = t;
          askBook(c, id, b);
        }
      } else if (b.sentAt !== null && t - b.sentAt > tune.subscribePendingMs) {
        // The refresh never produced a snapshot; the frozen book has aged out of any use.
        unsync(b, id);
        askBook(c, id, b);
      }
    }
    for (const [id, b] of [...books]) {
      if (desired.has(id) && specOf(id) !== null) continue;
      books.delete(id);
      const ch = `order_book/${id}`;
      c.queue = c.queue.filter((q) => q.channel !== ch);
      if (b.conn === c.id && b.live) c.queue.push({ op: "unsubscribe", channel: ch });
    }

    // One paced message per pump, at most one per subscribeSpacingMs.
    const next = c.queue[0];
    if (next !== undefined && t - lastPacedSendAt >= tune.subscribeSpacingMs) {
      c.queue.shift();
      if (!sendRaw(c, { type: next.op, channel: next.channel })) return;
      lastPacedSendAt = t;
      const bookId = /^order_book\/(\d{1,5})$/.exec(next.channel);
      const b = bookId === null ? undefined : books.get(Number(bookId[1]));
      if (next.channel === statsCh) {
        c.statsLive = next.op === "subscribe";
        c.statsSentAt = next.op === "subscribe" ? t : null;
        // Updates between here and the new snapshot belong to the old subscription; the snapshot replaces everything.
        if (next.op === "subscribe") c.statsSynced = false;
      } else if (b !== undefined && b.conn === c.id) {
        b.live = next.op === "subscribe";
        if (next.op === "subscribe") b.sentAt = t;
      }
    }
  }

  function manageRest(t: number): void {
    if (desired.size === 0) return; // see manageSocket: nothing in use, nothing sent
    if (!detailsInFlight && t >= detailsNextAt) {
      const cool = coolingUntil(t);
      if (cool > 0) {
        detailsNextAt = cool;
      } else {
        detailsInFlight = true;
        const started = t;
        let p: ReturnType<LighterFeedApi["orderBookDetails"]>;
        try {
          p = opts.api.orderBookDetails();
        } catch (e) {
          detailsInFlight = false;
          detailsNextAt = t + tune.detailsRetryMs;
          log("details-throw", `orderBookDetails threw: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        p.then(
          (r) => {
            detailsInFlight = false;
            if (stopped) return;
            const t2 = now();
            if (!r.ok) {
              if (r.error.kind === "rate-limited") localCooldownUntil = Math.max(localCooldownUntil, t2 + r.error.retryAfterMs);
              detailsNextAt = t2 + tune.detailsRetryMs;
              log("details-fail", `orderBookDetails failed (${r.error.kind}): ${r.error.detail}`);
              return;
            }
            // Stamped with when we ASKED: the answer is at least that fresh, and no fresher can be proven.
            details = { at: started, read: r.value };
            detailsNextAt = started + tune.detailsIntervalMs;
            for (const id of desired) {
              if (!r.value.markets.has(id)) {
                const why = r.value.refused.find((x) => x.marketId === id)?.reason ?? "absent";
                log(`refused-${id}`, `market ${id} is not usable from orderBookDetails (${why}); it stays out of the file`);
              }
            }
            // Held books at a stale precision are not books at this one.
            for (const map of [held, rest]) {
              for (const [id, h] of [...map]) {
                const v = r.value.markets.get(id);
                if (v === undefined || !sameDecimals(h.decimals, decimalsOf(v.spec))) map.delete(id);
              }
            }
            // Nor are candles: every integer in them is at the old scale. Re-read now.
            for (const [id, h] of history) {
              const v = r.value.markets.get(id);
              for (const state of Object.values(h.frames)) {
                if (state.candles !== null && (v === undefined || v.spec.priceDecimals !== state.candles.priceDecimals)) {
                  state.candles = null;
                  state.nextAt = t2;
                }
              }
              if (h.candles !== null && (v === undefined || v.spec.priceDecimals !== h.candles.priceDecimals)) {
                h.candles = null;
                h.candlesNextAt = t2;
              }
            }
          },
          (e: unknown) => {
            detailsInFlight = false;
            detailsNextAt = now() + tune.detailsRetryMs;
            log("details-reject", `orderBookDetails rejected: ${e instanceof Error ? e.message : String(e)}`);
          },
        );
      }
    }

    manageHistory(t);

    // REST depth only while the socket has been down a while — and never during a cooldown.
    const wsDown = conn === null || conn.connectedAt === null;
    if (!wsDown || wsDownSince === null || t - wsDownSince < tune.restFallbackAfterMs || depthInFlight || t < depthNextAt) return;
    const candidates = [...desired].filter((id) => specOf(id) !== null).sort((a, b) => a - b);
    if (candidates.length === 0) return;
    const cool = coolingUntil(t);
    if (cool > 0) {
      depthNextAt = cool;
      return;
    }
    const id = candidates[depthCursor++ % candidates.length] as number;
    const view = specOf(id) as PerpMarketView;
    const dec = decimalsOf(view.spec);
    depthInFlight = true;
    depthNextAt = t + tune.depthSpacingMs;
    const started = t;
    let p: ReturnType<LighterFeedApi["orderBookOrders"]>;
    try {
      p = opts.api.orderBookOrders(id, tune.depthOrders, dec);
    } catch (e) {
      depthInFlight = false;
      log("depth-throw", `orderBookOrders threw: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    p.then(
      (r) => {
        depthInFlight = false;
        if (stopped) return;
        if (!r.ok) {
          if (r.error.kind === "rate-limited") localCooldownUntil = Math.max(localCooldownUntil, now() + r.error.retryAfterMs);
          log(`depth-fail-${id}`, `orderBookOrders(${id}) failed (${r.error.kind}): ${r.error.detail}`);
          return;
        }
        const d: DepthRead = r.value;
        const cur = specOf(id);
        if (d.marketId !== id || cur === null || !sameDecimals(decimalsOf(cur.spec), dec)) return;
        const bids = levelsFromOrders(d.bids, d.bids.length >= tune.depthOrders);
        const asks = levelsFromOrders(d.asks, d.asks.length >= tune.depthOrders);
        if (crossed(bids, asks)) return;
        rest.set(id, { bids, asks, observedAt: started, decimals: dec, source: "rest" });
      },
      (e: unknown) => {
        depthInFlight = false;
        log("depth-reject", `orderBookOrders rejected: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  }

  /**
   * THE ROUTE'S HISTORY: one read at a time, for the first universe market in
   * use whose candles (then fundings) are due, in the REST pacing slot depth
   * uses, never in a cooldown. Each answer is stamped with when it was ASKED
   * — it is at least that fresh and no fresher can be proven — and the candle
   * in progress at that moment is dropped before it is stored.
   */
  /** Held markets as the lane last said, ids in LIGHTER_MARKETS_V1 only; a throwing or malformed answer is "none extra". */
  function heldNow(): ReadonlySet<number> {
    const out = new Set<number>();
    if (opts.heldMarketIds === undefined) return out;
    let ids: unknown;
    try {
      ids = opts.heldMarketIds();
    } catch {
      return out;
    }
    if (!Array.isArray(ids)) return out;
    for (const x of ids) if (typeof x === "number" && Number.isSafeInteger(x) && perpMarketById(x) !== null) out.add(x);
    return out;
  }

  function manageHistory(t: number): void {
    if (historyInFlight || t < depthNextAt) return;
    const api = opts.api;
    let job: { id: number; kind: "candles" | "fundings"; frame?: FeedTimeframe; view: PerpMarketView } | null = null;
    // The universe gets candles AND fundings; a held market outside it gets
    // fundings only (see the header). Both only while in use (`desired`).
    const held = heldNow();
    for (const id of [...desired].filter((x) => HISTORY_MARKET_IDS.has(x) || held.has(x)).sort((a, b) => a - b)) {
      const view = specOf(id);
      if (view === null) continue; // no decimals yet: no candle could be scaled
      const h = historyOf(id, t);
      if (HISTORY_MARKET_IDS.has(id) && candleTimeframes.includes("4h") && api.markPriceCandles !== undefined && t >= h.candlesNextAt) {
        job = { id, kind: "candles", frame: "4h", view };
        break;
      }
      if (api.fundings !== undefined && t >= h.fundingsNextAt) {
        job = { id, kind: "fundings", view };
        break;
      }
      if (HISTORY_MARKET_IDS.has(id) && api.markPriceCandles !== undefined) {
        const frame = candleTimeframes.find((f) => f !== "4h" && t >= (h.frames[f]?.nextAt ?? t));
        if (frame !== undefined) {
          h.frames[frame] ??= { candles: null, nextAt: t };
          job = { id, kind: "candles", frame, view };
          break;
        }
      }
    }
    if (job === null) return;
    const cool = coolingUntil(t);
    if (cool > 0) {
      depthNextAt = Math.max(depthNextAt, cool);
      return;
    }
    const { id, kind } = job;
    const frame = job.frame ?? "4h";
    const candleMs = FEED_TIMEFRAMES[frame];
    const started = t;
    const endSec = Math.floor(started / 1000);
    historyInFlight = true;
    depthNextAt = t + tune.depthSpacingMs;
    const fail = (why: string) => {
      historyInFlight = false;
      const h = history.get(id);
      if (h !== undefined) {
        if (kind === "candles") {
          if (frame === "4h") h.candlesNextAt = now() + tune.historyRetryMs;
          else h.frames[frame]!.nextAt = now() + tune.historyRetryMs;
        }
        else h.fundingsNextAt = now() + tune.historyRetryMs;
      }
      log(`history-${kind}-${id}`, `${kind} for market ${id} not read (${why}); retrying in ${tune.historyRetryMs} ms`);
    };

    if (kind === "candles") {
      const priceDecimals = job.view.spec.priceDecimals;
      let p: ReturnType<NonNullable<LighterFeedApi["markPriceCandles"]>>;
      try {
        p = (api.markPriceCandles as NonNullable<LighterFeedApi["markPriceCandles"]>)({
          marketId: id,
          resolution: frame,
          startSec: endSec - tune.candleCountBack * (candleMs / 1000),
          endSec,
          countBack: tune.candleCountBack,
          priceDecimals,
        });
      } catch (e) {
        fail(`threw: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      p.then(
        (r) => {
          if (stopped) return;
          if (!r.ok) {
            if (r.error.kind === "rate-limited") localCooldownUntil = Math.max(localCooldownUntil, now() + r.error.retryAfterMs);
            fail(`${r.error.kind}: ${r.error.detail}`);
            return;
          }
          if (r.value.resolution !== frame) {
            fail(`answered resolution ${r.value.resolution}, not ${frame}`);
            return;
          }
          historyInFlight = false;
          const h = history.get(id);
          if (h === undefined) return; // the market left the set meanwhile
          // The one in progress is always last; a signal read off it is from the future.
          const closed = r.value.candles.filter((c) => c.tMs + candleMs <= started).slice(-(FEED_MAX_CANDLES - 1));
          const result = { at: started, rows: closed, priceDecimals };
          const periodStart = Math.floor(started / candleMs) * candleMs;
          const lastT = closed[closed.length - 1]?.tMs ?? -Infinity;
          const lagging = lastT < periodStart - candleMs;
          const nextAt = lagging && started < periodStart + Math.min(tune.historyLagWindowMs, candleMs) ? now() + tune.historyRetryMs : periodStart + candleMs + tune.candleRefreshLagMs;
          if (frame === "4h") {
            h.candles = result;
            h.candlesNextAt = nextAt;
          } else h.frames[frame] = { candles: result, nextAt };
        },
        (e: unknown) => fail(`rejected: ${e instanceof Error ? e.message : String(e)}`),
      );
      return;
    }

    let p: ReturnType<NonNullable<LighterFeedApi["fundings"]>>;
    try {
      p = (api.fundings as NonNullable<LighterFeedApi["fundings"]>)({ marketId: id, resolution: "1h", startSec: endSec - 12 * 3600, endSec, countBack: 12 });
    } catch (e) {
      fail(`threw: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    p.then(
      (r) => {
        if (stopped) return;
        if (!r.ok) {
          if (r.error.kind === "rate-limited") localCooldownUntil = Math.max(localCooldownUntil, now() + r.error.retryAfterMs);
          fail(`${r.error.kind}: ${r.error.detail}`);
          return;
        }
        if (r.value.resolution !== "1h") {
          fail(`answered resolution ${r.value.resolution}, not 1h`);
          return;
        }
        historyInFlight = false;
        const h = history.get(id);
        if (h === undefined) return;
        const rows = r.value.fundings.filter((f) => f.timestampSec * 1000 <= started).slice(-24);
        h.fundings = { at: started, rows };
        const hourStart = Math.floor(started / HOUR_MS) * HOUR_MS;
        const lastMs = (rows[rows.length - 1]?.timestampSec ?? -Infinity) * 1000;
        const lagging = lastMs < hourStart;
        h.fundingsNextAt = lagging && started < hourStart + tune.historyLagWindowMs ? now() + tune.historyRetryMs : hourStart + HOUR_MS + tune.fundingRefreshLagMs;
      },
      (e: unknown) => fail(`rejected: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  // ── the file ────────────────────────────────────────────────────────────

  /** A venue funding rate (ppm per hour) back in the file's unit: percent with 4 dp. */
  const pct4 = (ppm: number): string => {
    const a = Math.abs(ppm);
    return `${ppm < 0 ? "-" : ""}${Math.floor(a / 10_000)}.${String(a % 10_000).padStart(4, "0")}`;
  };

  /** The history fields for one market's entry, at the precision it is being written at; {} when there is none. */
  function historyFields(id: number, priceDecimals: number): Pick<LighterFeedFileMarket, "closed4h" | "closedByTimeframe" | "candlesObservedAt" | "fundings1h" | "fundingsObservedAt"> {
    const h = history.get(id);
    const out: Pick<LighterFeedFileMarket, "closed4h" | "closedByTimeframe" | "candlesObservedAt" | "fundings1h" | "fundingsObservedAt"> = {};
    if (h === undefined) return out;
    if (h.candles !== null && h.candles.priceDecimals === priceDecimals && h.candles.rows.length > 0) {
      out.closed4h = h.candles.rows.map((c): FeedCandleJson => ({ t: c.tMs, o: c.open.toString(), h: c.high.toString(), l: c.low.toString(), c: c.close.toString() }));
      out.candlesObservedAt = h.candles.at;
    }
    const frames: NonNullable<LighterFeedFileMarket["closedByTimeframe"]> = {};
    for (const frame of candleTimeframes) {
      const c = frame === "4h" ? h.candles : h.frames[frame]?.candles;
      if (c && c.priceDecimals === priceDecimals && c.rows.length > 0) {
        frames[frame] = { observedAt: c.at, rows: c.rows.map((bar) => ({ t: bar.tMs, o: bar.open.toString(), h: bar.high.toString(), l: bar.low.toString(), c: bar.close.toString() })) };
      }
    }
    if (Object.keys(frames).length > 0) out.closedByTimeframe = frames;
    if (h.fundings !== null && h.fundings.rows.length > 0) {
      out.fundings1h = h.fundings.rows.map((f): FeedFundingJson => ({ t: f.timestampSec, rate: pct4(f.ratePpm), direction: f.direction }));
      out.fundingsObservedAt = h.fundings.at;
    }
    return out;
  }

  /** The freshest book we can stand behind for a market, or null. */
  function bookFor(id: number, dec: PerpDecimals): HeldBook | null {
    let best: HeldBook | null = null;
    const b = books.get(id);
    const c = conn;
    if (b !== undefined && b.phase === "synced" && c !== null && b.conn === c.id && !c.closed && sameDecimals(b.decimals, dec)) {
      const bids = topOf(b.bids, "bids");
      const asks = topOf(b.asks, "asks");
      if (crossed(bids, asks)) {
        gap(c, id, "crossed book");
      } else {
        // NO NEWS: in sync on a live socket → current as of the socket's last frame (or frozen while re-snapshotting).
        best = { bids, asks, observedAt: b.frozenAt ?? c.lastFrameAt, decimals: dec, source: "ws" };
      }
    }
    for (const h of [held.get(id), rest.get(id)]) {
      if (h !== undefined && sameDecimals(h.decimals, dec) && (best === null || h.observedAt > best.observedAt)) best = h;
    }
    return best;
  }

  function priceFor(id: number, view: PerpMarketView, specAt: number): Pick<LighterFeedFileMarket, "observedAt" | "priceSource" | "mark" | "index" | "fundingRatePctPerHour" | "lastFundingRatePctPerHour" | "lastFundingAt"> {
    const s = stats.get(id);
    if (s !== undefined && s.observedAt >= specAt) {
      const mark = parseDecimalToScaled(s.mark, view.spec.priceDecimals);
      const index = parseDecimalToScaled(s.index, view.spec.priceDecimals);
      if (mark !== null && mark > 0n && index !== null && index > 0n) {
        const out: ReturnType<typeof priceFor> = { observedAt: s.observedAt, priceSource: "ws", mark: mark.toString(), index: index.toString() };
        if (s.funding !== null) out.fundingRatePctPerHour = s.funding;
        if (s.lastFunding !== null && s.lastFundingAt !== null && s.lastFundingAt <= s.observedAt) {
          out.lastFundingRatePctPerHour = s.lastFunding;
          out.lastFundingAt = s.lastFundingAt;
        }
        return out;
      }
      log(`stats-scale-${id}`, `market_stats for market ${id} carries more decimals than the market's ${view.spec.priceDecimals}; using the orderBookDetails price`);
    }
    // The REST read's own prices, honestly as old as the read.
    return { observedAt: specAt, priceSource: "rest", mark: view.markPrice.toString(), index: view.indexPrice.toString() };
  }

  function build(t: number): LighterFeedFile {
    const markets: Record<string, LighterFeedFileMarket> = {};
    const d = details;
    if (d !== null) {
      for (const id of [...desired].sort((a, b) => a - b)) {
        const view = d.read.markets.get(id);
        if (view === undefined) continue;
        const dec = decimalsOf(view.spec);
        const book = bookFor(id, dec);
        if (book === null) continue;
        const price = priceFor(id, view, d.at);
        const entry: LighterFeedFileMarket = {
          ...price,
          status: view.spec.status,
          spec: specToJson(view.spec),
          specObservedAt: d.at,
          takerFeePpm: view.takerFeePpm,
          makerFeePpm: view.makerFeePpm,
          bids: book.bids.map(levelJson),
          asks: book.asks.map(levelJson),
          bookObservedAt: book.observedAt,
          bookSource: book.source,
        };
        // Held to the reader's own rules: ONE entry the reader refuses makes it
        // refuse the whole file, so a venue glitch on one market (a 40-digit
        // price) must cost that market, not every market in the fleet. And a
        // glitch in its HISTORY costs only the history: the market's prices
        // and book are still written, and the route reads no candles.
        const hist = historyFields(id, view.spec.priceDecimals);
        const withHistory: LighterFeedFileMarket = { ...entry, ...hist };
        if (parseLighterFeedMarket(String(id), withHistory, t) !== null) {
          markets[String(id)] = withHistory;
          continue;
        }
        if (Object.keys(hist).length > 0) log(`invalid-history-${id}`, `market ${id}'s candles or fundings failed the reader's checks; written without them`);
        if (parseLighterFeedMarket(String(id), entry, t) === null) {
          log(`invalid-${id}`, `market ${id}'s entry failed the reader's checks; left out of the file`);
          continue;
        }
        markets[String(id)] = entry;
      }
    }
    return { v: LIGHTER_FEED_VERSION, observedAt: t, markets };
  }

  function write(t: number): void {
    const file = build(t);
    const tmp = `${opts.outPath}.${process.pid}.tmp`;
    try {
      mkdirSync(path.dirname(opts.outPath), { recursive: true });
      writeFileSync(tmp, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
      // rename is atomic within a filesystem; a reader sees the old file or the new one, never half of either.
      renameSync(tmp, opts.outPath);
      lastWriteAt = t;
    } catch (e) {
      log("write", `could not write ${opts.outPath}: ${e instanceof Error ? e.message : String(e)}`);
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  // ── the heartbeat ───────────────────────────────────────────────────────

  function pump(): void {
    timer = null;
    if (stopped) return;
    const t = now();
    for (const [name, step] of [
      ["markets", () => refreshDesired(t)],
      ["socket", () => manageSocket(t)],
      ["rest", () => manageRest(t)],
      [
        "write",
        () => {
          if (lastWriteAt === null || t - lastWriteAt >= tune.writeIntervalMs) write(t);
        },
      ],
    ] as const) {
      try {
        step();
      } catch (e) {
        // One failing step must not stop the heartbeat: a feed that dies silently is a fleet with no prices.
        log(`pump-${name}`, `${name} step failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!stopped) timer = timers.setTimeout(pump, tune.pumpMs);
  }

  timer = timers.setTimeout(pump, 0);

  return {
    stop() {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      const c = conn;
      conn = null;
      if (c !== null) {
        c.closed = true;
        try {
          c.socket.close();
        } catch {
          /* already gone */
        }
      }
    },
    snapshot() {
      return build(now());
    },
    health() {
      const c = conn;
      let synced = 0;
      for (const b of books.values()) if (b.phase === "synced") synced++;
      return {
        wsUp: c !== null && c.connectedAt !== null && !c.closed,
        wsDownSince,
        connects,
        reconnectAttempt: attempt,
        gaps,
        syncedBooks: synced,
        detailsAt: details?.at ?? null,
        lastWriteAt,
        cooldownUntil: seenCooldownUntil,
      };
    },
  };
}
