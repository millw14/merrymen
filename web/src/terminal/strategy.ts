/** What an agent runs, and the few numbers that strategy cares about. */

export const STRATEGY_IDS = [
  "steady-basket",
  "weekend-gap",
  "even-keel",
  "dip-hunter",
  "trencher",
  "llm-strategist",
  "custom",
] as const;

export type StrategyId = (typeof STRATEGY_IDS)[number];

export interface BasketLeg {
  symbol: string;
  /** Share of the book, 0–100. */
  weight: number;
  /** even-keel only: how far off equal, + overweight. */
  drift?: number;
}

export interface TrenchSeat {
  symbol: string;
  pnlPct: number;
  /** How much further it can fall before the stop. */
  stopIn?: number;
}

export interface DipWatch {
  symbol: string;
  /** Percent off the recent high. */
  offHigh: number;
}

export interface StrategyGlance {
  id: StrategyId;
  /** Short, human. Shown next to the agent's name. */
  label: string;
  legs?: BasketLeg[];
  cashUsd?: number;
  vaultUsd?: number;
  nextBuyUsd?: number;
  market?: "open" | "closed";
  parked?: string[];
  waiting?: string[];
  deepest?: DipWatch | null;
  watching?: DipWatch[];
  open?: TrenchSeat[];
  watchingN?: number;
  scoutLeftUsd?: number;
  nextLook?: string;
}

export function isStrategyId(v: string | null | undefined): v is StrategyId {
  return !!v && (STRATEGY_IDS as readonly string[]).includes(v);
}

/** The rulebook name. Not the glance, not the size of this buy. */
export function strategyName(id: StrategyId): string {
  switch (id) {
    case "steady-basket":
      return "Steady basket";
    case "weekend-gap":
      return "Weekend gap";
    case "even-keel":
      return "Even keel";
    case "dip-hunter":
      return "Dip hunter";
    case "trencher":
      return "Trencher";
    case "llm-strategist":
      return "Strategist";
    case "custom":
      return "Its own rules";
    default: {
      const _x: never = id;
      return _x;
    }
  }
}

export function strategyLabel(id: StrategyId): string {
  switch (id) {
    case "steady-basket":
      return "five names";
    case "weekend-gap":
      return "overnight gap";
    case "even-keel":
      return "even book";
    case "dip-hunter":
      return "buys the dip";
    case "trencher":
      return "new pairs";
    case "llm-strategist":
      return "decides";
    case "custom":
      return "its own rules";
    default: {
      const _x: never = id;
      return _x;
    }
  }
}

export function parseStrategy(raw: string | null | undefined): StrategyId {
  if (!raw) return "custom";
  const key = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if (key === "steady" || key === "basket") return "steady-basket";
  if (key === "gap" || key === "weekend") return "weekend-gap";
  if (key === "keel" || key === "even") return "even-keel";
  if (key === "dip" || key === "dip-fox") return "dip-hunter";
  if (key === "trench" || key === "trench-kid") return "trencher";
  if (key === "llm" || key === "strategist" || key === "whisper") return "llm-strategist";
  return isStrategyId(key) ? key : "custom";
}

export function stampFor(slug: string, glance?: StrategyId | null): string {
  return strategyName(strategyForSlug(slug, glance));
}

/** One strategy per agent. Do not collapse everyone onto the schedule. */
export function strategyForSlug(slug: string, glance?: StrategyId | null): StrategyId {

  if (glance && glance !== "custom") return glance;
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) h = Math.imul(h ^ slug.charCodeAt(i), 16777619);
  return STRATEGY_IDS[(h >>> 0) % STRATEGY_IDS.length]!;
}

export function ownerTag(handle: string | null | undefined): string {
  if (!handle) return "";
  return handle.startsWith("@") ? handle : `@${handle}`;
}
