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
  /**
   * IS THAT ACTUALLY THIS AGENT’S RULEBOOK, or just the default we fell back to?
   *
   * The public wire carries no strategy — /api/leaderboard and /api/theses
   * publish what an agent SAID, not how it is configured. The terminal filled
   * the gap with `{id:"custom"}`, and "custom" renders as "Its own rules",
   * which is a claim: an agent running steady-basket was published as running
   * its own. Absent when the value is real (the owner’s own agent, read from
   * settings); false when nobody told us.
   */
  known?: boolean;
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

/**
 * The strategy we were told this agent runs, or "custom" when we were told
 * nothing.
 *
 * IT USED TO HASH THE SLUG. With no strategy on the public wire the `glance`
 * argument was always "custom", so the guard never fired and every public agent
 * was assigned one of the seven rulebooks by FNV-1a of its slug — stable,
 * plausible, and unrelated to anything it actually runs. Nothing rendered it at
 * the time, which is the only reason this was not a published lie; leaving a
 * fabrication one `{actor.strategy}` away from a screen is not a defence.
 */
export function strategyForSlug(_slug: string, glance?: StrategyId | null): StrategyId {
  return glance ?? "custom";
}

export function ownerTag(handle: string | null | undefined): string {
  if (!handle) return "";
  return handle.startsWith("@") ? handle : `@${handle}`;
}

/**
 * The strategies the WORKER will only run for a $MERRYMEN holder.
 *
 * Mirrors CIRCLE_STRATEGIES in worker/src/strategies/registry.ts. Kept here
 * rather than imported because every consumer is a client component, and
 * importing the registry would pull every strategy implementation into the
 * browser bundle for the sake of two strings. circle-strategies.test.ts holds
 * the two lists together — add one to the gate without adding it here and it
 * fails, which is the only thing stopping the next one being offered to
 * somebody who cannot run it.
 */
export const CIRCLE_STRATEGY_IDS: readonly string[] = ["even-keel", "dip-hunter"];

/** Is this a strategy that stays idle below the Merry Man tier? */
export const isCircleStrategyId = (id: string): boolean => CIRCLE_STRATEGY_IDS.includes(id);
