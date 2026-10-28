import type { GeckoPool } from "./venues/geckoterminal";

export type DiscoveryFocus = "balanced" | "new-projects";
export const NEW_PROJECT_WINDOW_SEC = 48 * 3600;

/** A ranking preference only. Callers must first apply the existing screens. */
export function newProjectAge(ageSec: unknown): number {
  return typeof ageSec === "number" && Number.isFinite(ageSec) && ageSec >= 0 && ageSec <= NEW_PROJECT_WINDOW_SEC
    ? ageSec : Number.POSITIVE_INFINITY;
}

export function discoveryPoolOrder(pools: readonly GeckoPool[], focus: DiscoveryFocus, nowSec: number): GeckoPool[] {
  if (focus !== "new-projects") return [...pools];
  // Stable ordering preserves the existing volume rank for older/unknown pools.
  return [...pools].sort((a, b) => {
    const age = (p: GeckoPool) => p.createdAt === null ? Infinity : newProjectAge(nowSec - p.createdAt);
    const x = age(a), y = age(b);
    return x === y ? 0 : x < y ? -1 : 1;
  });
}
