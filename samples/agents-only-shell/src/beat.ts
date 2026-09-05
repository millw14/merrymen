import { sizeOf, type LiveAgent, type Thesis } from "./live";
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
  reason: string;
}

interface Core {
  id: string;
  at: number;
  action: Action;
  symbol: string;
  sizeUsd: number | null;
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
  | { kind: "beat"; id: string; beat: Beat }
  | { kind: "lull"; id: string; ms: number };

export function castOf(b: Beat): Actor[] {
  return b.kind === "chorus" ? b.actors : [b.actor];
}

export function verbOf(b: Beat): string {
  const many = b.kind === "chorus";
  switch (b.action) {
    case "buy":
      return "bought";
    case "sell":
      return "sold";
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

/** Home's form, so the two screens agree: three names, then a count. */
export function spellCast(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
}

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

export function beatsOf(theses: Thesis[], agents: LiveAgent[]): Beat[] {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const parts: (Part & { action: Action; symbol: string })[] = [];

  for (const t of theses) {
    const action = t.action;
    if (action !== "buy" && action !== "sell") continue;
    if (!t.symbol || t.at == null) continue;
    const actor = actorOf(t, bySlug);
    if (!actor) continue;
    const symbol = t.symbol.toUpperCase();
    parts.push({
      actor,
      at: t.at,
      sizeUsd: sizeOf(t),
      reason: takeFor(actor.slug, t.symbol, t.reason, bySlug.get(actor.slug)?.thesis, actor.strategy),
      action,
      symbol,
    });
  }

  parts.sort((a, b) => b.at - a.at);

  return parts.map((p) => ({
    id: `${p.symbol}-${p.action}-${p.actor.slug}-${p.at}`,
    at: p.at,
    action: p.action,
    symbol: p.symbol,
    sizeUsd: p.sizeUsd,
    kind: "trade" as const,
    actor: p.actor,
    reason: p.reason,
  }));
}

const LULL_MS = 3 * 3_600_000;

export function lanesOf(beats: Beat[]): Lane[] {
  const out: Lane[] = [];

  beats.forEach((beat, i) => {
    const prev = beats[i - 1];
    const gap = prev ? prev.at - beat.at : 0;
    if (gap >= LULL_MS) out.push({ kind: "lull", id: `lull-${beat.id}`, ms: gap });
    out.push({ kind: "beat", id: beat.id, beat });
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
