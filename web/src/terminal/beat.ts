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
  /**
   * NOTHING CAME OF IT, AND NOTHING COULD HAVE.
   *
   * Carried onto the beat because the rail renders a sentence and the verb is
   * the part that makes the claim. A shadow decision is a real row with a real
   * action and a real size — thesis-policy.ts calls it "indistinguishable, to
   * every gate below, from a real buy" — so a rail reading only `action`
   * published "@robin bought TSLA" about a decision that never reached an
   * executor. worker/src/brain-disconnected.test.ts pins this as a product
   * invariant, not a wording preference.
   */
  shadow: boolean;
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

/**
 * The verb, and the conditional that has to survive into it.
 *
 * "would buy" and "bought" are the difference between a stated intention and a
 * trade, and this is the one string on the rail that decides which a reader
 * sees. The publisher already bakes the conditional into `head` for exactly
 * this reason; the rail lays the facts out itself, so it has to make the same
 * distinction rather than inherit it.
 */
export function verbOf(b: Beat): string {
  const many = b.kind === "chorus";
  // The conditional is the same for one agent or twenty: "would buy" already
  // says nothing happened, and there is no plural of it that says less.
  if (b.shadow) return `would ${b.action}`;
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
  const parts: (Part & { action: Action; symbol: string; shadow: boolean })[] = [];

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
      reason: takeFor(t.reason, bySlug.get(actor.slug)?.thesis),
      action,
      symbol,
      // Carried from the published row. `shadow` is set by the publisher; the
      // `outcome` check is the belt to it, for a row written before the flag
      // existed.
      shadow: t.shadow === true || t.outcome === "shadow",
    });
  }

  parts.sort((a, b) => b.at - a.at);

  return parts.map((p) => ({
    id: `${p.symbol}-${p.action}-${p.actor.slug}-${p.at}`,
    at: p.at,
    action: p.action,
    symbol: p.symbol,
    sizeUsd: p.sizeUsd,
    shadow: p.shadow,
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
