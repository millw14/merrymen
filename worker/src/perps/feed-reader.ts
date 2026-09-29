/**
 * THE FLEET'S LIGHTER MARKET DATA, READ FROM A FILE — AND NOT TRUSTED FOR IT.
 *
 * docs/perps.md ("feed.ts" under Worker) is the contract: ONE process holds
 * the one public market-data WebSocket and writes `lighter-feed.json`
 * atomically every few seconds; every consumer — a hosted child, the
 * self-hosted worker, a paper book — reads the file. This module is the whole
 * of the reading side, and it is deliberately small:
 *
 *   NO NETWORK, EVER   The file is the only input. A paper child makes no
 *                      Lighter request at all, and a stale feed is a book gap
 *                      for it (opens refused), never a reason to go and ask
 *                      the venue itself — every child falling back to REST at
 *                      once is exactly the per-IP stampede the feed exists to
 *                      prevent. Nothing here imports api.ts or feed.ts.
 *   NEVER THROWS       Absent, unreadable, half-written, garbled, the wrong
 *                      version: all of them are null, which callers treat as
 *                      "Lighter's prices are unread" (rule 11). A throw would
 *                      take a tick down over data that is only ever a reason
 *                      to refuse something.
 *   STRICT             The writer is our own process, but the file lives in a
 *                      directory every hosted child can write (children share
 *                      an OS user — the contract's honest limits). So every
 *                      field is re-validated: integers are canonical decimal
 *                      strings, books are sorted and uncrossed, every time is
 *                      no later than the file's own, the spec's margin
 *                      fractions are ordered. ONE bad market makes the whole
 *                      file null — a file that is wrong about one market is a
 *                      file we cannot say is right about the others.
 *   FRESHNESS IS TWO   `stale` — a market's prices older than 30 s are unread
 *   CLOCKS             FOR OPENS (the refusal is `perp-unpriced`). `staleBooks`
 *                      — a book older than 10 s is not one a paper fill may
 *                      walk. Both are stamped on each market too (`fresh`,
 *                      `bookFresh`), and the two helpers at the bottom return
 *                      null for anything stale, so the fail-closed path is the
 *                      short one to write. Options can only TIGHTEN these
 *                      limits: a caller asking for 60 s gets 30.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseDecimalToScaled, perpMarketById, type PerpKey, type PerpMarketSpec } from "../../../packages/core/src/index";
import type { DepthLevel } from "./markets";

// ── the file ────────────────────────────────────────────────────────────────

export const LIGHTER_FEED_FILE = "lighter-feed.json";
export const LIGHTER_FEED_VERSION = 1;
/** Price levels per side the file carries (best first). */
export const FEED_BOOK_LEVELS = 10;

/**
 * Where the feed file lives: the FLEET home when the orchestrator set one — a
 * child's own home is private to it, and the feed is one file for the whole
 * container (the lighterCooldownFile pattern) — else this process's home
 * (self-hosted, where the feed runs in-process).
 */
export function lighterFeedPath(home: string): string {
  const fleet = process.env.MERRYMEN_FLEET_HOME?.trim();
  return path.join(fleet && fleet.length > 0 ? fleet : home, LIGHTER_FEED_FILE);
}

/** PerpMarketSpec with its bigints as decimal strings (JSON has no bigint). */
export interface FeedSpecJson {
  marketId: number;
  sizeDecimals: number;
  priceDecimals: number;
  minBaseAmount: string;
  minQuoteMicro: string;
  minImfBp: number;
  defaultImfBp: number;
  mmfBp: number;
  closeoutBp: number;
  liquidationFeeBp?: number;
  status: PerpMarketSpec["status"];
}

/** One price level: [venue integer price, venue integer base size], both decimal strings. */
export type FeedLevelJson = [price: string, size: string];

/**
 * One market as the file carries it. Every venue number is an INTEGER at the
 * market's own precision (price × 10^priceDecimals, size × 10^sizeDecimals),
 * written as a decimal string. Each part carries its own observation time,
 * because the parts come from different places at different rates.
 */
export interface LighterFeedFileMarket {
  /** ms: when mark/index (and funding) were last known current. */
  observedAt: number;
  /** Where mark/index came from: the WebSocket, or orderBookDetails (the REST fallback, ≤ 1 per 5 min). */
  priceSource: "ws" | "rest";
  mark: string;
  index: string;
  /**
   * The venue's `current_funding_rate` — its estimate of the NEXT hourly
   * payment — exactly as rendered: percent per hour, 4 dp, signed ("0.0012",
   * "-0.0005"), the unit `/fundings` uses. Absent when not read (REST prices
   * carry no funding).
   */
  fundingRatePctPerHour?: string;
  /** The venue's `funding_rate`: the LAST hourly payment's rate, same unit. */
  lastFundingRatePctPerHour?: string;
  /** ms: `funding_timestamp`, when that last payment happened. */
  lastFundingAt?: number;
  /** = spec.status, repeated so a reader never has to dig for the one field policy branches on. */
  status: PerpMarketSpec["status"];
  spec: FeedSpecJson;
  /** ms: when orderBookDetails (the only source of decimals, minimums and margins) was read. */
  specObservedAt: number;
  /** Venue fees in millionths of notional (maker_fee "0.0102" percent = 102). Paper fills charge these (rule 14). */
  takerFeePpm: number;
  makerFeePpm: number;
  /** Best first: highest bid first, lowest ask first; at most FEED_BOOK_LEVELS each. */
  bids: FeedLevelJson[];
  asks: FeedLevelJson[];
  /** ms: when this book was last known current. */
  bookObservedAt: number;
  bookSource: "ws" | "rest";
}

export interface LighterFeedFile {
  v: typeof LIGHTER_FEED_VERSION;
  /** ms: when the writer built this file. Every other time in it is ≤ this. */
  observedAt: number;
  /** Keyed by the venue market id as a decimal string. Only markets with a spec, a price AND a book appear. */
  markets: Record<string, LighterFeedFileMarket>;
}

/** The writer's half of the spec round-trip. */
export function specToJson(spec: PerpMarketSpec): FeedSpecJson {
  const out: FeedSpecJson = {
    marketId: spec.marketId,
    sizeDecimals: spec.sizeDecimals,
    priceDecimals: spec.priceDecimals,
    minBaseAmount: spec.minBaseAmount.toString(),
    minQuoteMicro: spec.minQuoteMicro.toString(),
    minImfBp: spec.minImfBp,
    defaultImfBp: spec.defaultImfBp,
    mmfBp: spec.mmfBp,
    closeoutBp: spec.closeoutBp,
    status: spec.status,
  };
  if (spec.liquidationFeeBp !== undefined) out.liquidationFeeBp = spec.liquidationFeeBp;
  return out;
}

// ── what a reader gets ──────────────────────────────────────────────────────

export interface PerpFeedMarket {
  marketId: number;
  key: PerpKey;
  symbol: string;
  /** ms */
  observedAt: number;
  priceSource: "ws" | "rest";
  /** venue integer price */
  mark: bigint;
  index: bigint;
  /**
   * Estimated next hourly funding, signed, in PARTS PER MILLION PER HOUR
   * (percent with 4 dp is exact at this scale: "0.0012" % → 12). Null when
   * the feed did not read it — unknown, never zero.
   */
  fundingRatePpm: number | null;
  /** The last hourly payment's rate (same unit) and when it happened; null when unread. */
  lastFunding: { ratePpm: number; atMs: number } | null;
  status: PerpMarketSpec["status"];
  spec: PerpMarketSpec;
  specObservedAt: number;
  takerFeePpm: number;
  makerFeePpm: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
  bookObservedAt: number;
  bookSource: "ws" | "rest";
  /** Prices (and spec) fresh enough to open against: `!stale.has(marketId)`. */
  fresh: boolean;
  /** Book fresh enough for a paper fill to walk: `!staleBooks.has(marketId)`. */
  bookFresh: boolean;
}

export interface LighterFeedRead {
  /** ms: when the writer built the file. */
  observedAt: number;
  /** Every market in the file, fresh or not (a display may show the last known). */
  markets: Map<number, PerpFeedMarket>;
  /** Markets UNREAD FOR OPENS: prices older than maxAgeOpenSec, or a spec older than maxSpecAgeSec. */
  stale: Set<number>;
  /** Markets whose book no paper fill may walk: older than maxBookAgeSec. */
  staleBooks: Set<number>;
}

export interface LighterFeedReadOptions {
  /** ≤ 30 (the contract): prices older than this are unread for opens. */
  maxAgeOpenSec?: number;
  /** ≤ 10 (the contract): a paper fill needs a book at most this old. */
  maxBookAgeSec?: number;
  /**
   * ≤ 900: decimals, minimums, margin fractions and STATUS come from
   * orderBookDetails, refreshed every 5 min. A spec three refreshes old may be
   * missing a market going reduce-only, so the market is unread for opens.
   */
  maxSpecAgeSec?: number;
}

export const LIGHTER_FEED_READ_DEFAULTS = Object.freeze({
  maxAgeOpenSec: 30,
  maxBookAgeSec: 10,
  maxSpecAgeSec: 900,
});

/**
 * Clock skew tolerated before a time "from the future" is garbage. The writer
 * and every reader share one host clock; 5 s only absorbs the millisecond a
 * rename and a read can straddle, and a loaded box's scheduler.
 */
const FUTURE_SKEW_MS = 5_000;
/** The largest file we will read. A full file (57 markets × 20 levels) is ~60 KB. */
const MAX_FILE_BYTES = 2_000_000;

/** Tightening only: anything missing, non-finite, non-positive or looser than the contract is the contract. */
function limit(requested: number | undefined, contractMax: number): number {
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? Math.min(requested, contractMax) : contractMax;
}

// ── strict readers ──────────────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function intIn(x: unknown, min: number, max: number): number | null {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= min && x <= max ? x : null;
}

/** A positive venue integer written canonically (no sign, no leading zero, ≤ 30 digits). */
const POS_INT_RE = /^[1-9]\d{0,29}$/;
function posInt(x: unknown): bigint | null {
  return typeof x === "string" && POS_INT_RE.test(x) ? BigInt(x) : null;
}

/** Percent per hour as the venue renders it: signed, ≤ 4 dp, bounded (100 %/h is not a rate, it is garbage). */
const PCT4_RE = /^-?\d{1,3}(?:\.\d{1,4})?$/;
function pctToPpm(x: unknown): number | null {
  if (typeof x !== "string" || !PCT4_RE.test(x)) return null;
  const v = parseDecimalToScaled(x, 4);
  return v === null ? null : Number(v);
}

const STATUSES: ReadonlySet<string> = new Set(["active", "inactive", "reduce-only"]);

function parseSpec(raw: unknown, marketId: number): PerpMarketSpec | null {
  if (!isRecord(raw)) return null;
  if (raw.marketId !== marketId) return null;
  const sizeDecimals = intIn(raw.sizeDecimals, 0, 18);
  const priceDecimals = intIn(raw.priceDecimals, 0, 18);
  const minBaseAmount = posInt(raw.minBaseAmount);
  const minQuoteMicro = posInt(raw.minQuoteMicro);
  const minImfBp = intIn(raw.minImfBp, 1, 10_000);
  const defaultImfBp = intIn(raw.defaultImfBp, 1, 10_000);
  const mmfBp = intIn(raw.mmfBp, 1, 9_999);
  const closeoutBp = intIn(raw.closeoutBp, 1, 9_999);
  if (
    sizeDecimals === null ||
    priceDecimals === null ||
    minBaseAmount === null ||
    minQuoteMicro === null ||
    minImfBp === null ||
    defaultImfBp === null ||
    mmfBp === null ||
    closeoutBp === null
  ) {
    return null;
  }
  // markets.ts refuses a venue row that breaks this ordering; a file claiming
  // one is not a file markets.ts's output went into.
  if (!(closeoutBp < mmfBp && mmfBp < minImfBp && minImfBp <= defaultImfBp)) return null;
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) return null;
  const spec: PerpMarketSpec = {
    marketId,
    sizeDecimals,
    priceDecimals,
    minBaseAmount,
    minQuoteMicro,
    minImfBp,
    defaultImfBp,
    mmfBp,
    closeoutBp,
    status: raw.status as PerpMarketSpec["status"],
  };
  if ("liquidationFeeBp" in raw) {
    const fee = intIn(raw.liquidationFeeBp, 0, 10_000);
    if (fee === null) return null;
    spec.liquidationFeeBp = fee;
  }
  return spec;
}

/**
 * One side of a book, best first: strictly monotone prices (a level appears
 * once), positive sizes, at most FEED_BOOK_LEVELS.
 */
function parseSide(raw: unknown, dir: "bids" | "asks"): DepthLevel[] | null {
  if (!Array.isArray(raw) || raw.length > FEED_BOOK_LEVELS) return null;
  const out: DepthLevel[] = [];
  for (const lv of raw) {
    if (!Array.isArray(lv) || lv.length !== 2) return null;
    const price = posInt(lv[0]);
    const baseAmount = posInt(lv[1]);
    if (price === null || baseAmount === null) return null;
    const prev = out[out.length - 1];
    if (prev !== undefined && (dir === "bids" ? price >= prev.price : price <= prev.price)) return null;
    out.push({ price, baseAmount });
  }
  return out;
}

/**
 * One market entry of a file stamped `fileAt`, parsed strictly, or null.
 * Freshness is not judged here (see parseLighterFeed). Exported so the WRITER
 * holds itself to the reader's rules: feed.ts leaves out any entry this
 * refuses, rather than writing a file that one venue glitch would make
 * unreadable for every market.
 */
export function parseLighterFeedMarket(key: string, raw: unknown, fileAt: number): Omit<PerpFeedMarket, "fresh" | "bookFresh"> | null {
  if (!/^\d{1,5}$/.test(key) || !isRecord(raw)) return null;
  const marketId = Number(key);
  const market = perpMarketById(marketId);
  if (market === null || String(marketId) !== key) return null;
  // Every time is a positive ms integer no later than the file itself: the
  // writer stamps the file last, so a part claiming to be newer is corrupt.
  const time = (x: unknown) => intIn(x, 1, fileAt);
  const observedAt = time(raw.observedAt);
  const specObservedAt = time(raw.specObservedAt);
  const bookObservedAt = time(raw.bookObservedAt);
  if (observedAt === null || specObservedAt === null || bookObservedAt === null) return null;
  if (raw.priceSource !== "ws" && raw.priceSource !== "rest") return null;
  if (raw.bookSource !== "ws" && raw.bookSource !== "rest") return null;
  const mark = posInt(raw.mark);
  const index = posInt(raw.index);
  if (mark === null || index === null) return null;
  const spec = parseSpec(raw.spec, marketId);
  if (spec === null || raw.status !== spec.status) return null;
  const takerFeePpm = intIn(raw.takerFeePpm, 0, 1_000_000);
  const makerFeePpm = intIn(raw.makerFeePpm, 0, 1_000_000);
  if (takerFeePpm === null || makerFeePpm === null) return null;

  // Funding is optional; present-and-wrong is still wrong.
  let fundingRatePpm: number | null = null;
  if ("fundingRatePctPerHour" in raw) {
    fundingRatePpm = pctToPpm(raw.fundingRatePctPerHour);
    if (fundingRatePpm === null) return null;
  }
  let lastFunding: PerpFeedMarket["lastFunding"] = null;
  const hasRate = "lastFundingRatePctPerHour" in raw;
  const hasAt = "lastFundingAt" in raw;
  if (hasRate !== hasAt) return null;
  if (hasRate) {
    const ratePpm = pctToPpm(raw.lastFundingRatePctPerHour);
    // A payment is on or before the moment the feed saw it reported.
    const atMs = intIn(raw.lastFundingAt, 1, fileAt);
    if (ratePpm === null || atMs === null) return null;
    lastFunding = { ratePpm, atMs };
  }

  const bids = parseSide(raw.bids, "bids");
  const asks = parseSide(raw.asks, "asks");
  if (bids === null || asks === null) return null;
  const bestBid = bids[0];
  const bestAsk = asks[0];
  // A crossed book is a price no one could have traded at (markets.ts's parseDepth rule).
  if (bestBid !== undefined && bestAsk !== undefined && bestBid.price >= bestAsk.price) return null;

  return {
    marketId,
    key: market.key,
    symbol: market.symbol,
    observedAt,
    priceSource: raw.priceSource,
    mark,
    index,
    fundingRatePpm,
    lastFunding,
    status: spec.status,
    spec,
    specObservedAt,
    takerFeePpm,
    makerFeePpm,
    bids,
    asks,
    bookObservedAt,
    bookSource: raw.bookSource,
  };
}

// ── the readers ─────────────────────────────────────────────────────────────

/**
 * An already-parsed feed value (the file's JSON, or feed.ts's snapshot()) →
 * markets with their freshness judged at `nowMs`, or null. Never throws.
 */
export function parseLighterFeed(raw: unknown, nowMs: number, opts: LighterFeedReadOptions = {}): LighterFeedRead | null {
  try {
    if (!Number.isFinite(nowMs)) return null;
    if (!isRecord(raw) || raw.v !== LIGHTER_FEED_VERSION || !isRecord(raw.markets)) return null;
    const observedAt = intIn(raw.observedAt, 1, Number.MAX_SAFE_INTEGER);
    // A file from the future was not written by a writer sharing our clock.
    if (observedAt === null || observedAt > nowMs + FUTURE_SKEW_MS) return null;
    const maxOpenMs = limit(opts.maxAgeOpenSec, LIGHTER_FEED_READ_DEFAULTS.maxAgeOpenSec) * 1000;
    const maxBookMs = limit(opts.maxBookAgeSec, LIGHTER_FEED_READ_DEFAULTS.maxBookAgeSec) * 1000;
    const maxSpecMs = limit(opts.maxSpecAgeSec, LIGHTER_FEED_READ_DEFAULTS.maxSpecAgeSec) * 1000;
    const markets = new Map<number, PerpFeedMarket>();
    const stale = new Set<number>();
    const staleBooks = new Set<number>();
    for (const [key, value] of Object.entries(raw.markets)) {
      const m = parseLighterFeedMarket(key, value, observedAt);
      if (m === null) return null;
      const fresh = nowMs - m.observedAt <= maxOpenMs && nowMs - m.specObservedAt <= maxSpecMs;
      const bookFresh = nowMs - m.bookObservedAt <= maxBookMs;
      if (!fresh) stale.add(m.marketId);
      if (!bookFresh) staleBooks.add(m.marketId);
      markets.set(m.marketId, { ...m, fresh, bookFresh });
    }
    return { observedAt, markets, stale, staleBooks };
  } catch {
    return null;
  }
}

/**
 * Read `lighter-feed.json` (lighterFeedPath). Null when the file is absent,
 * too large, unreadable, not JSON (a writer caught mid-way — which the
 * rename-into-place makes impossible for OUR writer, but not for a stray one),
 * or anything parseLighterFeed refuses. Never throws, never touches the
 * network.
 */
export function readLighterFeed(file: string, nowMs: number, opts: LighterFeedReadOptions = {}): LighterFeedRead | null {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return null;
    const text = readFileSync(file, "utf8");
    if (text.length > MAX_FILE_BYTES) return null;
    return parseLighterFeed(JSON.parse(text) as unknown, nowMs, opts);
  } catch {
    return null;
  }
}

/**
 * The market an OPEN may price against, or null — for an unread feed, a
 * market the feed does not carry, or one whose prices or spec are stale.
 * Null is `perp-unpriced`; it is never a reason to ask the venue directly.
 */
export function feedMarketForOpen(read: LighterFeedRead | null, marketId: number): PerpFeedMarket | null {
  const m = read?.markets.get(marketId);
  return m !== undefined && m.fresh && read?.stale.has(marketId) === false ? m : null;
}

/**
 * The book a PAPER fill may walk, or null (rule 14: the paper order is then
 * refused, not filled at some older price). Only the book's own age matters
 * here, so a paper exit can still fill while prices are stale for opens.
 */
export function feedBookForPaperFill(
  read: LighterFeedRead | null,
  marketId: number,
): { bids: DepthLevel[]; asks: DepthLevel[]; bookObservedAt: number; spec: PerpMarketSpec } | null {
  const m = read?.markets.get(marketId);
  if (m === undefined || !m.bookFresh || read?.staleBooks.has(marketId) !== false) return null;
  return { bids: m.bids, asks: m.asks, bookObservedAt: m.bookObservedAt, spec: m.spec };
}
