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

export function windowSpec(id: WindowId): { interval: string; range: string; cut?: number } {
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

export async function loadBars(token: LiveToken, window: WindowId): Promise<Bar[]> {
  const bars =
    token.kind !== "memecoin"
      ? await yahooBars(token.symbol, window).then((live) => (live.length > 2 ? live : walkBars(token, window)))
      : walkBars(token, window);
  const last = bars[bars.length - 1];
  const now = token.priceUsd;
  if (last && now && now > 0) {
    last.close = now;
    last.high = Math.max(last.high, now);
    last.low = Math.min(last.low, now);
  }
  return bars;
}

async function yahooBars(symbol: string, window: WindowId): Promise<Bar[]> {
  const { interval, range } = windowSpec(window);
  try {
    const r = await fetch(`/yahoo/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`);
    if (!r.ok) return [];
    const j = (await r.json()) as {
      chart?: {
        result?: {
          timestamp?: number[];
          indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[] }[] };
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
      if (![open, high, low, close].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
      out.push({ time: ts[i]!, open: open!, high: high!, low: low!, close: close! });
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

function walkSpec(id: WindowId): { n: number; step: number } {
  switch (id) {
    case "1H":
      return { n: 60, step: 60 };
    case "4H":
      return { n: 48, step: 300 };
    case "1D":
      return { n: 78, step: 300 };
    case "7D":
      return { n: 84, step: 900 };
    case "1M":
      return { n: 120, step: 3600 };
    case "ALL":
      return { n: 160, step: 86400 };
    default: {
      const _x: never = id;
      return _x;
    }
  }
}

function walkBars(token: LiveToken, window: WindowId): Bar[] {
  const last = token.priceUsd ?? token.marks.at(-1) ?? 100;
  const { n, step } = walkSpec(window);
  const end = Math.floor(Date.now() / 1000);
  const start = end - n * step;
  const state = { n: seed(token.symbol + window) };
  const marks = token.marks.length > 4 ? token.marks : null;
  const out: Bar[] = [];
  let px = last * 0.985;
  for (let i = 0; i < n; i++) {
    const t = start + i * step;
    const target = marks ? marks[Math.min(marks.length - 1, Math.floor((i / n) * marks.length))]! : last;
    const drift = (target - px) * 0.08 + (rand(state) - 0.5) * last * 0.004;
    const open = px;
    const close = Math.max(0.0001, px + drift);
    const high = Math.max(open, close) * (1 + rand(state) * 0.003);
    const low = Math.min(open, close) * (1 - rand(state) * 0.003);
    out.push({ time: t, open, high, low, close });
    px = close;
  }
  if (out.length) out[out.length - 1]!.close = last;
  return out;
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
      pnlBps: avg > 0 && now > 0 ? Math.round(((now - avg) / avg) * 10_000) : agent?.pnlBps ?? null,
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
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rand(state: { n: number }): number {
  state.n = (Math.imul(state.n, 1664525) + 1013904223) >>> 0;
  return state.n / 2 ** 32;
}
