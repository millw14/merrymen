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
