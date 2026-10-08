import { readRequestPurpose } from "./account-purpose";
/**
 * Owner-only perps chart data. Mark candles and executions have different
 * prices: a marker is placed at the fill's exact venue time and execution
 * price, never snapped to a candle or inferred from a position average.
 */
import { perpMarketByKey, type PerpMarketSpec } from "@merrymen/core";
import type { Db } from "../../../worker/src/db";
import type { MarkCandle } from "../../../worker/src/perps/markets";

export const CHART_WINDOWS = {
  "24h": { durationMs: 24 * 60 * 60_000, stepMs: 5 * 60_000, resolution: "5m", countBack: 300 },
  "7d": { durationMs: 7 * 24 * 60 * 60_000, stepMs: 60 * 60_000, resolution: "1h", countBack: 175 },
  "30d": { durationMs: 30 * 24 * 60 * 60_000, stepMs: 4 * 60 * 60_000, resolution: "4h", countBack: 190 },
} as const;

export type ChartWindow = keyof typeof CHART_WINDOWS;
export type ChartBook = "paper" | "live";
export type ChartState = "ok" | "unreadable" | "not-configured";
export interface ChartQuery { market: string; book: ChartBook; window: ChartWindow }
export interface ChartEntry {
  id: string;
  timeMs: number;
  /** Execution price, independent of the venue's mark-price candles. */
  price: number;
  priceExact: string;
  /** Opened base only, at the market's size precision (not the whole fill when it reversed). */
  size: string;
  side: "long" | "short";
  book: ChartBook;
  epoch: number;
  attribution: string;
  kind: "open" | "add" | "reverse";
}
export interface ChartBar { timeMs: number; open: number; high: number; low: number; close: number }
export interface ChartResponse {
  state: ChartState;
  market: string;
  book: ChartBook;
  window: ChartWindow;
  /** Server clock used for both the bounded fill and candle window. */
  generatedAtMs: number;
  /** Lighter MARK prices. An execution may lie between or outside these bars. */
  candles: {
    state: "ok" | "none" | "unreadable";
    bars: ChartBar[];
    gaps: { startMs: number; endMs: number }[];
    stale: boolean;
    asOfMs: number | null;
  };
  entries: ChartEntry[];
  /** Rows whose before-state is absent or invalid; no entry assertion is made. */
  unknownFills: number;
  /** The latest 500 fills are shown when this is true; earlier ones were omitted. */
  truncated: boolean;
}

export interface PerpFillChartRow {
  epoch: unknown;
  venue_trade_id: unknown;
  side_role: unknown;
  base: unknown;
  price: unknown;
  position_before: unknown;
  attribution: unknown;
  venue_ts_ms: unknown;
}

const MAX_FILLS = 500;
const int = (x: unknown): bigint | null =>
  typeof x === "string" && /^-?(?:0|[1-9]\d*)$/.test(x) ? BigInt(x) : null;

export function scaled(v: bigint, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("invalid market precision");
  const sign = v < 0n ? "-" : "";
  const s = (v < 0n ? -v : v).toString().padStart(decimals + 1, "0");
  return decimals === 0 ? `${sign}${s}` : `${sign}${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

export function chartQuery(url: string): ChartQuery | null {
  if (!readRequestPurpose({ url })) return null;
  const p = new URL(url).searchParams;
  p.delete("purpose");
  const market = p.get("market");
  const book = p.get("book");
  const window = p.get("window");
  if (!market || !perpMarketByKey(market) || (book !== "paper" && book !== "live") ||
    (window !== "24h" && window !== "7d" && window !== "30d")) return null;
  // Reject duplicate/unknown params instead of silently accepting a second,
  // conflicting account or market identifier supplied by a caller.
  if (p.size !== 3 || [...p.keys()].some((key) => !["market", "book", "window"].includes(key))) return null;
  return { market, book, window };
}

/** A bound ledger query, across epochs. No caller-supplied account is accepted. */
export async function readChartFills(db: Db, agentId: string, q: ChartQuery, nowMs: number): Promise<PerpFillChartRow[]> {
  const market = perpMarketByKey(q.market);
  if (!market) throw new Error("invalid chart market");
  const start = nowMs - CHART_WINDOWS[q.window].durationMs;
  return await db.prepare(
    `SELECT epoch, venue_trade_id, side_role, base, price, position_before, attribution, venue_ts_ms
       FROM perp_fills
      WHERE agent_id = ? AND mode = ? AND market_id = ? AND venue_ts_ms >= ? AND venue_ts_ms <= ?
      ORDER BY venue_ts_ms DESC, venue_trade_id DESC, side_role DESC LIMIT 501`,
  ).all(agentId.toLowerCase(), q.book, market.marketId, start, nowMs) as PerpFillChartRow[];
}

export function entriesFromFills(rows: readonly PerpFillChartRow[], q: ChartQuery, spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals">):
  Pick<ChartResponse, "entries" | "unknownFills" | "truncated"> {
  const entries: ChartEntry[] = [];
  let unknownFills = 0;
  const truncated = rows.length > MAX_FILLS;
  // The SQL returns newest first. The 501st row only proves truncation; it is
  // never silently drawn as if this were the complete historical tape.
  for (const r of rows.slice(0, MAX_FILLS).reverse()) {
    const before = int(r.position_before);
    const base = int(r.base);
    const price = int(r.price);
    const time = Number(r.venue_ts_ms);
    const epoch = Number(r.epoch);
    if (before === null || base === null || base <= 0n || price === null || price <= 0n ||
      (r.side_role !== "bid" && r.side_role !== "ask") ||
      !Number.isSafeInteger(time) || time <= 0 || !Number.isSafeInteger(epoch) || epoch < 1 ||
      typeof r.venue_trade_id !== "string" || !r.venue_trade_id || typeof r.attribution !== "string") {
      unknownFills++;
      continue;
    }
    const bid = r.side_role === "bid";
    const opposing = bid ? before < 0n : before > 0n;
    const closing = opposing ? (base < (before < 0n ? -before : before) ? base : before < 0n ? -before : before) : 0n;
    const opening = base - closing;
    if (opening <= 0n) continue; // close or partial close, not an entry
    const priceExact = scaled(price, spec.priceDecimals);
    const priceNumber = Number(priceExact);
    if (!Number.isFinite(priceNumber) || priceNumber <= 0) { unknownFills++; continue; }
    entries.push({
      id: `${epoch}:${r.venue_trade_id}:${r.side_role}`,
      timeMs: time,
      price: priceNumber,
      priceExact,
      size: scaled(opening, spec.sizeDecimals),
      side: bid ? "long" : "short",
      book: q.book,
      epoch,
      attribution: r.attribution,
      kind: opposing ? "reverse" : before === 0n ? "open" : "add",
    });
  }
  return { entries, unknownFills, truncated };
}

export function candlesFromVenue(rows: readonly MarkCandle[] | null, q: ChartQuery, decimals: number, nowMs: number): ChartResponse["candles"] {
  const blank = (state: "none" | "unreadable"): ChartResponse["candles"] => ({ state, bars: [], gaps: [], stale: true, asOfMs: null });
  if (rows === null) return blank("unreadable");
  const { durationMs, stepMs } = CHART_WINDOWS[q.window];
  const floor = Math.floor((nowMs - durationMs) / stepMs) * stepMs;
  const closed = rows.filter((r) => r.tMs >= floor && r.tMs + stepMs <= nowMs);
  if (closed.length === 0) return blank("none");
  const bars: ChartBar[] = [];
  const gaps: { startMs: number; endMs: number }[] = [];
  let previous: number | null = null;
  for (const r of closed) {
    if (previous !== null && r.tMs > previous + stepMs) gaps.push({ startMs: previous + stepMs, endMs: r.tMs });
    const p = [r.open, r.high, r.low, r.close].map((x) => Number(scaled(x, decimals)));
    if (p.some((x) => !Number.isFinite(x) || x <= 0)) return blank("unreadable");
    bars.push({ timeMs: r.tMs, open: p[0]!, high: p[1]!, low: p[2]!, close: p[3]! });
    previous = r.tMs;
  }
  const asOfMs = (previous as number) + stepMs;
  // One fully missing interval is already stale; the still-forming current
  // candle is deliberately excluded and does not count as missing.
  return { state: "ok", bars, gaps, stale: nowMs - asOfMs > stepMs, asOfMs };
}

export function chartResponse(q: ChartQuery, state: ChartState = "unreadable", generatedAtMs = Date.now()): ChartResponse {
  return { state, market: q.market, book: q.book, window: q.window, generatedAtMs,
    candles: { state: "unreadable", bars: [], gaps: [], stale: true, asOfMs: null },
    entries: [], unknownFills: 0, truncated: false };
}

/** Do not cache a just-closed candle's publication delay for a whole 4h window. */
export function chartCandleCacheMs(rows: readonly MarkCandle[], stepMs: number, nowMs: number): number {
  const expected = Math.floor(nowMs / stepMs) * stepMs - stepMs;
  return rows.some(bar => bar.tMs === expected) ? stepMs : 30_000;
}
