import type { LiveAgent, LiveToken, Thesis } from "./live";
import { strategyForSlug, strategyName, type StrategyId } from "./strategy";
import { takeFor } from "./why";
import { CHART_WINDOWS, type ChartWindow } from "@/lib/venue";

/**
 * The chart windows, taken FROM THE VENUE ALLOW-LIST so the two cannot drift.
 *
 * "7D" is gone and "5D" is in its place. The button said 7D and asked Yahoo for
 * `range=5d`, because Yahoo’s grid is 1d/5d/1mo/… and has no 7d — so the
 * chart, its axis and the percentage under it were five days of data wearing a
 * week’s name. See lib/venue.ts.
 */
export type WindowId = ChartWindow;
export type ChartKind = "candle" | "line";

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Seat {
  /**
   * A PRETEND FILL MUST NOT LOOK LIKE A REAL ONE.
   *
   * `paper` is a simulated book; `basisSource` says how the entry price was
   * obtained — 'receipt' off a settled transaction, 'paper' exact but
   * simulated, 'quote' a pre-trade estimate. read-token.ts carries both and
   * says why: "Travels with the price because a pretend fill must not look like
   * a real one." The port dropped them, so every marker on the public token
   * chart read as somebody’s money.
   */
  paper: boolean;
  basisSource: "receipt" | "paper" | "quote" | null;
  slug: string;
  name: string;
  handle: string | null;
  owner: string | null;
  strategy: string;
  strategyId: StrategyId;
  position: number;
  pnlBps: number | null;
  avgEntry: number;
  thesis: string;
  time: number;
  price: number;
}

/** The upstream shape of a window. One table, in lib/venue.ts, shared with the route. */
export function windowSpec(id: WindowId): { interval: string; range: string; cut: number | null } {
  return CHART_WINDOWS[id];
}

/** How much history each window claims to show. Used to trim, never to pad. */
export const WINDOW_SECONDS: Record<WindowId, number> = {
  "1H": 3_600,
  "4H": 14_400,
  "1D": 86_400,
  "5D": 432_000,
  "1M": 2_592_000,
  ALL: Number.POSITIVE_INFINITY,
};

export async function loadBars(
  token: LiveToken,
  window: WindowId,
): Promise<Bar[]> {
  if (token.kind === "memecoin") {
    try {
      const r=await fetch(`/api/tokens/${encodeURIComponent(token.id)}?window=${window==="1H"||window==="4H"?"15m":window==="ALL"||window==="1M"?"1d":"1h"}`, {signal:AbortSignal.timeout(20000)});
      if(!r.ok)return [];
      const data=await r.json();
      const bars: Bar[] = (data.candles?.candles ?? []).map((b:{t:number;o:number;h:number;l:number;c:number})=>({time:b.t,open:b.o,high:b.h,low:b.l,close:b.c}));
      const durations = WINDOW_SECONDS;
      const end = bars.at(-1)?.time ?? 0;
      return bars.filter(bar=>bar.time >= end - durations[window]);
    } catch {return [];}
  }
  const bars = await yahooBars(token.symbol, window);
  const multiplier = token.uiMultiplier ?? 1;
  return bars.map((bar) => ({
    ...bar,
    open: bar.open * multiplier,
    high: bar.high * multiplier,
    low: bar.low * multiplier,
    close: bar.close * multiplier,
  }));
}

async function yahooBars(symbol: string, window: WindowId): Promise<Bar[]> {
  
  try {
    const r = await fetch(
      `/api/venue?desk=chart&symbol=${encodeURIComponent(symbol)}&window=${encodeURIComponent(window)}`,
      {signal:AbortSignal.timeout(20000)},
    );
    if (!r.ok) return [];
    const j = (await r.json()) as {
      chart?: {
        result?: {
          timestamp?: number[];
          indicators?: {
            quote?: {
              open?: (number | null)[];
              high?: (number | null)[];
              low?: (number | null)[];
              close?: (number | null)[];
            }[];
          };
        }[];
      };
    };
    const row = j.chart?.result?.[0];
    const ts = row?.timestamp ?? [];
    const q = row?.indicators?.quote?.[0];
    if (!q || ts.length === 0) return [];
    const out: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const open = q.open?.[i];
      const high = q.high?.[i];
      const low = q.low?.[i];
      const close = q.close?.[i];
      if (
        ![open, high, low, close].every(
          (n) => typeof n === "number" && Number.isFinite(n),
        )
      )
        continue;
      out.push({
        time: ts[i]!,
        open: open!,
        high: high!,
        low: low!,
        close: close!,
      });
    }
    const cut = windowSpec(window).cut;
    if (cut && out.length) {
      const end = out[out.length - 1]!.time;
      return out.filter((b) => b.time >= end - cut);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * A cap on how many blank slots one hole may consume.
 *
 * The same 500 CandleChart uses. A pool that published four bars in a year
 * would otherwise pad tens of thousands of empty slots and the real bars would
 * be a smudge at the right-hand edge.
 */
const MAX_WHITESPACE = 500;

/**
 * The venue's bar size, in seconds — the MODE of the gaps, not the median.
 *
 * The interval is a property of the request ("give me 5-minute bars"), so the
 * right estimate of it is the spacing that occurs most often, not the middle
 * one. A median is wrong here in exactly the case that matters: a series of
 * five-minute bars with one weekend in it has gaps [300, 300, …, 250000], and
 * on a short series the median lands between the two — 750 seconds of nothing
 * anybody asked for, which then pads the hole at the wrong resolution.
 *
 * Ties go to the smaller gap, because bars cannot be closer together than the
 * resolution: the smallest spacing observed is an upper bound on the bar size.
 */
export function barInterval(bars: readonly Bar[]): number {
  if (bars.length < 2) return 0;
  const seen = new Map<number, number>();
  for (let i = 1; i < bars.length; i += 1) {
    const d = bars[i]!.time - bars[i - 1]!.time;
    if (d > 0) seen.set(d, (seen.get(d) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [gap, count] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = gap;
      bestCount = count;
    }
  }
  return best;
}

/**
 * THE BARS, WITH THE HOLES LEFT AS HOLES.
 *
 * lightweight-charts places bars at CONSECUTIVE time-scale slots, so it does
 * not matter that the timestamps are hours apart: handed the bars alone, a
 * 63-hour hole renders as zero horizontal distance and the line is drawn
 * straight across it. `components/CandleChart.tsx` calls that "THE LARGEST
 * HONESTY DEFECT IN THE FIRST VERSION" and measured it on a real pool — 421
 * bars over 792 hours, 47% of the range missing, the longest run 63 hours.
 *
 * The terminal's chart reintroduced it by calling `setData(bars.map(...))`
 * directly. Whitespace entries are the library's own mechanism for this, and it
 * belongs in the renderer rather than the reader: the read returns facts, the
 * renderer decides spacing.
 *
 * PriceLine's caption says what a viewer is looking at — "the hours the feed
 * published nothing are left out rather than drawn across, which is what the
 * breaks are" — and that is still the promise this keeps.
 */
export function withGaps(
  bars: readonly Bar[],
): { data: ({ time: number } & Partial<Omit<Bar, "time">>)[]; truncated: boolean } {
  const interval = barInterval(bars);
  const out: ({ time: number } & Partial<Omit<Bar, "time">>)[] = [];
  let padded = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const prev = bars[i - 1];
    if (prev && interval > 0) {
      for (let t = prev.time + interval; t < bar.time && padded < MAX_WHITESPACE; t += interval) {
        out.push({ time: t });
        padded += 1;
      }
    }
    out.push(bar);
  }
  return { data: out, truncated: padded >= MAX_WHITESPACE };
}

/**
 * WHY THIS ENTRY PRICE IS NOT A SETTLED FILL — or "" when it is.
 *
 * Three different things reach the token page's holder list and the chart's
 * entry markers: a receipt read off a settled transaction, a paper fill that is
 * exact but simulated, and a pre-trade quote that is an estimate of a price
 * nothing traded at. `read-token.ts` carries the distinction and states the
 * rule — "a pretend fill must not look like a real one" — and the port dropped
 * it, so all three rendered as somebody's money on a public page.
 */
export function entryCaveat(seat: Pick<Seat, "paper" | "basisSource">): string {
  if (seat.paper) return " — on paper, not a real fill";
  if (seat.basisSource === "quote") return " — an estimate, not a settled fill";
  if (seat.basisSource === null) return " — entry price unrecorded";
  return "";
}
