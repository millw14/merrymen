import type { LiveAgent, LiveToken, Thesis } from "./live";
import { strategyForSlug, strategyName, type StrategyId } from "./strategy";
import { takeFor } from "./why";

export type WindowId = "1H" | "4H" | "1D" | "7D" | "1M" | "ALL";
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

export function windowSpec(id: WindowId): {
  interval: string;
  range: string;
  cut?: number;
} {
  switch (id) {
    case "1H":
      return { interval: "1m", range: "1d", cut: 3600 };
    case "4H":
      return { interval: "5m", range: "1d", cut: 14400 };
    case "1D":
      return { interval: "5m", range: "1d" };
    case "7D":
      return { interval: "15m", range: "5d" };
    case "1M":
      return { interval: "60m", range: "1mo" };
    case "ALL":
      return { interval: "1d", range: "5y" };
    default: {
      const _x: never = id;
      return _x;
    }
  }
}

export async function loadBars(
  token: LiveToken,
  window: WindowId,
): Promise<Bar[]> {
  if (token.kind === "memecoin") {
    try {
      const r=await fetch(`/api/tokens/${encodeURIComponent(token.id)}?window=${window==="1H"?"15m":window==="ALL"?"1d":"1h"}`, {signal:AbortSignal.timeout(20000)});
      if(!r.ok)return [];
      const data=await r.json();
      const bars: Bar[] = (data.candles?.candles ?? []).map((b:{t:number;o:number;h:number;l:number;c:number})=>({time:b.t,open:b.o,high:b.h,low:b.l,close:b.c}));
      const durations: Record<WindowId, number> = {"1H":3600,"4H":14400,"1D":86400,"7D":604800,"1M":2592000,"ALL":Infinity};
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
  const { interval, range } = windowSpec(window);
  try {
    const r = await fetch(
      `/yahoo/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`, {signal:AbortSignal.timeout(20000)},
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
