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
  if (token.kind === "memecoin") return [];
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
      `/yahoo/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`,
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

export function seatsOf(
  theses: Thesis[],
  agents: LiveAgent[],
  token: LiveToken,
  bars: Bar[],
): Seat[] {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const seen = new Set<string>();
  const seats: Seat[] = [];
  for (const t of theses) {
    if ((t.symbol ?? "").toUpperCase() !== token.symbol.toUpperCase()) continue;
    if (t.action !== "buy" && t.action !== "hold") continue;
    const slug = t.slug ?? t.name;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const bar = pickBar(bars, slug, t.at);
    const avg = bar?.close ?? token.priceUsd ?? 0;
    const now = token.priceUsd ?? avg;
    const agent = t.slug ? bySlug.get(t.slug) : undefined;
    const position = t.sizeUsdg ?? 0;
    const strategyId = strategyForSlug(slug, agent?.glance.id);
    seats.push({
      slug,
      name: t.name,
      handle: t.handle ?? agent?.handle ?? null,
      owner: agent?.owner ?? t.handle,
      strategy: strategyName(strategyId),
      strategyId,
      position,
      pnlBps:
        avg > 0 && now > 0
          ? Math.round(((now - avg) / avg) * 10_000)
          : (agent?.pnlBps ?? null),
      avgEntry: avg,
      thesis: takeFor(slug, token.symbol, t.reason, agent?.thesis),
      time: bar?.time ?? 0,
      price: avg,
    });
  }
  return seats;
}

function pickBar(bars: Bar[], slug: string, at?: number): Bar | undefined {
  if (bars.length === 0) return undefined;
  if (at && at > 0) {
    let best = bars[0]!;
    let dist = Math.abs(best.time - at);
    for (const b of bars) {
      const d = Math.abs(b.time - at);
      if (d < dist) {
        best = b;
        dist = d;
      }
    }
    return best;
  }
  const i = seed(slug) % bars.length;
  return bars[i]!;
}

function seed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
