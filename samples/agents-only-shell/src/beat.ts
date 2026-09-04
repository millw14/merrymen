import { sizeOf, type LiveAgent, type Thesis } from "./live";
import { SAMPLE_CHG } from "./sample";
import { strategyForSlug, type StrategyId } from "./strategy";
import { takeFor } from "./why";

export type Action = "buy" | "sell" | "hold";

export interface Actor {
  slug: string;
  name: string;
  handle: string;
  strategy: StrategyId;
}

export interface Part {
  actor: Actor;
  at: number;
  sizeUsd: number | null;
  weight: number | null;
  reason: string;
}

interface Core {
  id: string;
  at: number;
  action: Action;
  symbol: string;
  sizeUsd: number | null;
  /** Share of the actor's book this name carries. A dollar figure alone says nothing. */
  weight: number | null;
  /** Agents holding this name right now, the actor included. */
  crowd: number;
}

/**
 * One thing an agent did, at a time. Attribution is not optional: a beat with
 * nobody attached cannot be built.
 */
export type Beat =
  | (Core & { kind: "trade"; actor: Actor; reason: string })
  | (Core & { kind: "chorus"; actors: Actor[]; parts: Part[] });

/** What the rail draws, top to bottom. Presentation, not domain. */
export type Lane =
  | { kind: "span"; id: string; label: string; trades: number; agents: number; movedUsd: number }
  | { kind: "beat"; id: string; beat: Beat; big: number | null }
  | { kind: "lull"; id: string; ms: number };

export function castOf(b: Beat): Actor[] {
  return b.kind === "chorus" ? b.actors : [b.actor];
}

export function verbOf(b: Beat): string {
  const many = b.kind === "chorus";
  switch (b.action) {
    case "buy":
      return many ? "all bought" : "bought";
    case "sell":
      return many ? "all sold" : "sold";
    case "hold":
      return many ? "are holding" : "is holding";
    default: {
      const _x: never = b.action;
      return _x;
    }
  }
}

export function whoOf(b: Beat): string {
  if (b.kind === "trade") return b.actor.handle;
  return spellCast(b.actors.map((a) => a.handle));
}

export function spellCast(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** A sell only stings if the name kept going. Real 24h change, sells only. */
export function regretOf(b: Beat): number | null {
  if (b.action !== "sell") return null;
  const chg = SAMPLE_CHG[b.symbol];
  return chg != null && chg > 0 ? chg : null;
}

const CHORUS_WINDOW_MS = 2 * 3_600_000;

function actorOf(t: Thesis, agents: Map<string, LiveAgent>): Actor | null {
  const slug = t.slug;
  if (!slug) return null;
  return {
    slug,
    name: t.name,
    handle: t.handle ?? t.name,
    strategy: strategyForSlug(slug, agents.get(slug)?.glance.id),
  };
}

function weightOf(agent: LiveAgent | undefined, symbol: string): number | null {
  const legs = agent?.glance.legs;
  if (!legs?.length) return null;
  const total = legs.reduce((n, l) => n + (l.weight || 1), 0) || 1;
  const leg = legs.find((l) => l.symbol.toUpperCase() === symbol);
  return leg ? Math.round(((leg.weight || 1) / total) * 100) : null;
}

/** An agent is in a name until it sells: the newest action per agent per symbol decides. */
function crowdsOf(theses: Thesis[]): Map<string, number> {
  const last = new Map<string, "in" | "out">();
  for (const t of [...theses].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    if (!t.symbol || !t.slug) continue;
    if (t.action !== "buy" && t.action !== "sell" && t.action !== "hold") continue;
    last.set(`${t.slug}|${t.symbol.toUpperCase()}`, t.action === "sell" ? "out" : "in");
  }
  const crowds = new Map<string, number>();
  for (const [key, state] of last) {
    if (state === "out") continue;
    const symbol = key.split("|")[1]!;
    crowds.set(symbol, (crowds.get(symbol) ?? 0) + 1);
  }
  return crowds;
}

export function beatsOf(theses: Thesis[], agents: LiveAgent[]): Beat[] {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const crowds = crowdsOf(theses);
  const parts: (Part & { action: Action; symbol: string })[] = [];

  for (const t of theses) {
    const action = t.action;
    if (action !== "buy" && action !== "sell" && action !== "hold") continue;
    if (!t.symbol || t.at == null) continue;
    const actor = actorOf(t, bySlug);
    if (!actor) continue;
    const symbol = t.symbol.toUpperCase();
    parts.push({
      actor,
      at: t.at,
      sizeUsd: sizeOf(t),
      weight: weightOf(bySlug.get(actor.slug), symbol),
      reason: takeFor(actor.slug, t.symbol, t.reason, bySlug.get(actor.slug)?.thesis, actor.strategy),
      action,
      symbol,
    });
  }

  parts.sort((a, b) => b.at - a.at);

  const groups: (typeof parts)[] = [];
  const openBy = new Map<string, (typeof parts)[number][]>();
  for (const p of parts) {
    const key = `${p.symbol}|${p.action}`;
    const open = openBy.get(key);
    if (open && open[0]!.at - p.at <= CHORUS_WINDOW_MS && !open.some((q) => q.actor.slug === p.actor.slug)) {
      open.push(p);
      continue;
    }
    const fresh = [p];
    openBy.set(key, fresh);
    groups.push(fresh);
  }

  return groups.map((g) => {
    const head = g[0]!;
    const sized = g.filter((p) => p.sizeUsd != null);
    const sizeUsd = sized.length > 0 ? sized.reduce((n, p) => n + (p.sizeUsd ?? 0), 0) : null;
    const core: Core = {
      id: `${head.symbol}-${head.action}-${head.at}`,
      at: head.at,
      action: head.action,
      symbol: head.symbol,
      sizeUsd,
      weight: head.weight,
      crowd: crowds.get(head.symbol) ?? 0,
    };
    if (g.length === 1) {
      return { ...core, kind: "trade", actor: head.actor, reason: head.reason };
    }
    return {
      ...core,
      kind: "chorus",
      weight: null,
      actors: g.map((p) => p.actor),
      parts: g.map(({ actor, at, sizeUsd: s, weight, reason }) => ({ actor, at, sizeUsd: s, weight, reason })),
    };
  });
}

const SPANS: { label: string; withinMs: number }[] = [
  { label: "in the last five minutes", withinMs: 5 * 60_000 },
  { label: "five to fifteen minutes ago", withinMs: 15 * 60_000 },
  { label: "fifteen to thirty minutes ago", withinMs: 30 * 60_000 },
  { label: "thirty to sixty minutes ago", withinMs: 3_600_000 },
  { label: "earlier today", withinMs: 24 * 3_600_000 },
  { label: "earlier this week", withinMs: 7 * 24 * 3_600_000 },
  { label: "more than a week ago", withinMs: Number.POSITIVE_INFINITY },
];

const LULL_MS = 3 * 3_600_000;
const BIG_MULTIPLE = 3;

/** A trade only counts as outsized against what a normal one looks like here. */
function typicalSize(beats: Beat[]): number {
  const sizes = beats
    .filter((b) => b.kind === "trade" && b.sizeUsd != null)
    .map((b) => b.sizeUsd!)
    .sort((a, b) => a - b);
  if (sizes.length === 0) return Number.POSITIVE_INFINITY;
  return sizes[Math.floor(sizes.length / 2)]!;
}

export function lanesOf(beats: Beat[], now: number): Lane[] {
  const out: Lane[] = [];
  const typical = typicalSize(beats);
  let spanAt = -1;

  beats.forEach((beat, i) => {
    const age = now - beat.at;
    const next = SPANS.findIndex((s) => age < s.withinMs);
    const idx = next === -1 ? SPANS.length - 1 : next;
    if (idx !== spanAt) {
      spanAt = idx;
      const within = beats.filter((b) => {
        const a = now - b.at;
        const lower = idx === 0 ? 0 : SPANS[idx - 1]!.withinMs;
        return a >= lower && a < SPANS[idx]!.withinMs;
      });
      out.push({
        kind: "span",
        id: `span-${idx}`,
        label: SPANS[idx]!.label,
        trades: within.reduce((n, b) => n + (b.kind === "chorus" ? b.parts.length : 1), 0),
        agents: new Set(within.flatMap((b) => castOf(b).map((a) => a.slug))).size,
        movedUsd: within.reduce((n, b) => n + (b.sizeUsd ?? 0), 0),
      });
    } else {
      const prev = beats[i - 1];
      const gap = prev ? prev.at - beat.at : 0;
      if (gap >= LULL_MS && idx <= 4) out.push({ kind: "lull", id: `lull-${beat.id}`, ms: gap });
    }
    const big =
      beat.kind === "trade" && beat.sizeUsd != null && beat.sizeUsd >= typical * BIG_MULTIPLE
        ? Math.round(beat.sizeUsd / typical)
        : null;
    out.push({ kind: "beat", id: beat.id, beat, big });
  });

  return out;
}

/** Returns over a slice of the tail of the curve, in bps. */
export function curveReturn(curve: number[], points: number): number | null {
  if (curve.length < 2) return null;
  const slice = curve.slice(-Math.max(2, Math.min(points, curve.length)));
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  if (first === 0) return null;
  return ((last - first) / first) * 10000;
}
