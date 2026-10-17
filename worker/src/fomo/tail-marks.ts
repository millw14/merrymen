/**
 * TAIL CALL MARKS — the measurement behind the tail leaderboard (and, next
 * PR, the ghost ledger). Pure: deciding and aggregating live here; reading,
 * writing and sending live elsewhere (store.ts fomo_tail_marks, the
 * tail-notifier pass, tail-notices.ts end summaries).
 *
 * One MARK per tail buy: the entry price when the buy was told, then two
 * horizon re-quotes (+1h, +24h) taken by the notifier pass when due. A move
 * is (horizon − entry) / entry, in percent. No price, no mark: a buy that
 * cannot be quoted is never invented, and a leaderboard built on fewer calls
 * says its sample size every time.
 */

export const TAIL_MARK_HORIZONS = [
  { key: "h1", afterMs: 60 * 60_000 },
  { key: "h24", afterMs: 24 * 60 * 60_000 },
] as const;

export type TailMarkHorizon = (typeof TAIL_MARK_HORIZONS)[number]["key"];

export interface TailCallMark {
  /** The tail buy notice's event key — one mark per told buy, never remade. */
  eventKey: string;
  /** Provider user id of the tailed trader (never a handle). */
  traderUserId: string;
  /** Display handle at mark time (display only). */
  handle: string | null;
  /** Token key (`namespace:network:address`), storage/join key. */
  tokenKey: string;
  /** USD entry price and when it was read. */
  entryPriceUsd: number;
  entryAtMs: number;
  /** Horizon marks, when taken. Absent = not due or not yet taken. */
  h1PriceUsd?: number | null;
  h1AtMs?: number | null;
  h24PriceUsd?: number | null;
  h24AtMs?: number | null;
}

/** Which horizons of a mark are due at `nowMs` and still untaken. */
export function dueHorizons(mark: TailCallMark, nowMs: number): TailMarkHorizon[] {
  const out: TailMarkHorizon[] = [];
  if ((mark.h1PriceUsd === undefined || mark.h1PriceUsd === null) && nowMs - mark.entryAtMs >= TAIL_MARK_HORIZONS[0].afterMs) {
    out.push("h1");
  }
  if ((mark.h24PriceUsd === undefined || mark.h24PriceUsd === null) && nowMs - mark.entryAtMs >= TAIL_MARK_HORIZONS[1].afterMs) {
    out.push("h24");
  }
  return out;
}

/** Percent move entry → price, or null when either end is missing. */
export function movePct(entryPriceUsd: number, horizonPriceUsd: number | null | undefined): number | null {
  if (typeof entryPriceUsd !== "number" || !Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;
  if (typeof horizonPriceUsd !== "number" || !Number.isFinite(horizonPriceUsd) || horizonPriceUsd < 0) return null;
  return ((horizonPriceUsd / entryPriceUsd) - 1) * 100;
}

export interface TraderTally {
  traderUserId: string;
  handle: string | null;
  calls: number;
  /** Calls with a settled h1 mark. */
  settledH1: number;
  settledH24: number;
  avgH1Pct: number | null;
  avgH24Pct: number | null;
  /** Share of settled h1 marks above zero. */
  hitRateH1: number | null;
}

/** Fold settled marks into one row per trader (hers-only: the caller scopes the input). */
export function tallyMarks(marks: readonly TailCallMark[]): TraderTally[] {
  const byTrader = new Map<string, { handle: string | null; h1: number[]; h24: number[]; calls: number }>();
  for (const m of marks) {
    let t = byTrader.get(m.traderUserId);
    if (!t) {
      t = { handle: m.handle, h1: [], h24: [], calls: 0 };
      byTrader.set(m.traderUserId, t);
    }
    t.calls += 1;
    if (m.handle) t.handle = m.handle;
    const h1 = movePct(m.entryPriceUsd, m.h1PriceUsd);
    if (h1 !== null) t.h1.push(h1);
    const h24 = movePct(m.entryPriceUsd, m.h24PriceUsd);
    if (h24 !== null) t.h24.push(h24);
  }
  const avg = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  return [...byTrader.entries()].map(([traderUserId, t]) => ({
    traderUserId,
    handle: t.handle,
    calls: t.calls,
    settledH1: t.h1.length,
    settledH24: t.h24.length,
    avgH1Pct: avg(t.h1),
    avgH24Pct: avg(t.h24),
    hitRateH1: t.h1.length === 0 ? null : t.h1.filter((x) => x > 0).length / t.h1.length,
  }));
}

/** Ranked for display: most settled h1 first, then best average. */
export function rankTally(rows: readonly TraderTally[]): TraderTally[] {
  return [...rows].sort((a, b) => b.settledH1 - a.settledH1 || (b.avgH1Pct ?? -Infinity) - (a.avgH1Pct ?? -Infinity));
}

/** A USD float to an 8dp decimal string for the mark ledger, or null when it cannot be measured. */
export function toPrice8(priceUsd: unknown): string | null {
  if (typeof priceUsd !== "number" || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const s = priceUsd.toFixed(8);
  if (!/^\d{1,24}(\.\d{1,8})?$/.test(s) || Number(s) <= 0) return null;
  return s;
}

/** A store row to the mark the tally folds. Rows that cannot be measured are dropped, never zeroed. */
export function rowToMark(r: {
  eventKey: string; traderUserId: string; handle: string | null; tokenKey: string;
  entryPrice8: string; entryAtMs: number; h1Price8: string | null; h1AtMs: number | null; h24Price8: string | null; h24AtMs: number | null;
}): TailCallMark | null {
  const entry = Number(r.entryPrice8);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  return {
    eventKey: r.eventKey, traderUserId: r.traderUserId, handle: r.handle, tokenKey: r.tokenKey,
    entryPriceUsd: entry, entryAtMs: r.entryAtMs,
    h1PriceUsd: r.h1Price8 === null ? undefined : Number(r.h1Price8),
    h1AtMs: r.h1AtMs, h24PriceUsd: r.h24Price8 === null ? undefined : Number(r.h24Price8), h24AtMs: r.h24AtMs,
  };
}

const fmtPct = (x: number | null): string => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);

/** One leaderboard line per trader, for end summaries and /tails. Sample size is always said. */
export function leaderboardLines(rows: readonly TraderTally[]): string[] {
  return rankTally(rows).map((t) => {
    const who = t.handle ? `@${t.handle}` : "a trader";
    return `${who}: ${t.calls} ${t.calls === 1 ? "call" : "calls"} tailed, +1h avg ${fmtPct(t.avgH1Pct)} over ${t.settledH1} settled${t.hitRateH1 === null ? "" : `, ${Math.round(t.hitRateH1 * 100)}% green`}`;
  });
}
