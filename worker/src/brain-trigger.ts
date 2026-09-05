/**
 * WHEN IS IT WORTH WAKING BRAIN AT ALL?
 *
 * The tick runs every 240 seconds. A Brain run costs 5-11 model calls and 4-10
 * seconds; wiring it to the tick unconditionally would be 360 runs per agent per
 * day, 24 agents, for a market that mostly did nothing — and the fleet has
 * already had one incident where an unwatched background feature emptied a daily
 * token allowance.
 *
 * So the expensive thing is gated by a cheap one. This module is deterministic,
 * pure, and calls no model: it looks at what changed since the last run and
 * decides whether anything did. THAT IS THE POINT — a trigger layer that needed
 * a model to decide whether to call a model would cost what it was meant to save.
 *
 * COOLDOWN IS PER REASON, not global. A price move and a portfolio change are
 * different questions, and a global cooldown would let a stale price trigger
 * suppress a genuine risk event minutes later.
 */

export type TriggerReason =
  | "scheduled-review"
  | "price-move"
  | "portfolio-change"
  | "news-event"
  | "user-request";

export interface TriggerState {
  /** Unix seconds of the last run per reason. Persisted across restarts. */
  lastFiredAt: Partial<Record<TriggerReason, number>>;
  /** What the world looked like when Brain last ran. */
  lastPriceUsd: number | null;
  lastEquityUsdg: number | null;
  lastNewsKey: string | null;
}

export interface TriggerInputs {
  now: number;
  priceUsd: number | null;
  equityUsdg: number;
  /** A stable identity for the latest material news item, or null. */
  newsKey: string | null;
  /** Set when a human asked. Bypasses every cooldown but its own. */
  userRequested: boolean;
}

export interface TriggerConfig {
  /** Longest Brain may sleep with nothing happening. */
  scheduledIntervalSec: number;
  /** Fractional move that counts as meaningful. 0.03 = 3%. */
  priceMovePct: number;
  /** Fractional equity change that counts as a portfolio event. */
  equityMovePct: number;
  /** Minimum gap between runs for the SAME reason. */
  cooldownSec: Partial<Record<TriggerReason, number>>;
}

export const DEFAULT_TRIGGERS: TriggerConfig = {
  // Four hours. Long enough that a quiet market costs six runs a day rather
  // than 360; short enough that an agent is never silent for a session.
  scheduledIntervalSec: 4 * 3600,
  priceMovePct: 0.03,
  equityMovePct: 0.05,
  cooldownSec: {
    "price-move": 1800,
    "portfolio-change": 1800,
    "news-event": 900,
    "scheduled-review": 3600,
    // A person asking is not rate-limited to half an hour, but it is still
    // bounded — a stuck client must not become a spend loop.
    "user-request": 60,
  },
};

export interface TriggerVerdict {
  fire: boolean;
  reason: TriggerReason | null;
  detail: string;
  /** Every reason that qualified, for the record. The first is what fires. */
  candidates: TriggerReason[];
}

const pctMove = (now: number | null, before: number | null): number => {
  if (now === null || before === null || before === 0) return 0;
  return Math.abs(now - before) / Math.abs(before);
};

/**
 * Should Brain run? PURE.
 *
 * Reasons are checked in priority order: a person asking beats a risk event
 * beats a price move beats the clock. Only the winner fires, so one tick cannot
 * produce two runs, and its cooldown is the one that is checked.
 */
export function shouldWake(
  state: TriggerState,
  input: TriggerInputs,
  cfg: TriggerConfig = DEFAULT_TRIGGERS,
): TriggerVerdict {
  const candidates: TriggerReason[] = [];
  const cooled = (r: TriggerReason): boolean => {
    const last = state.lastFiredAt[r];
    const gap = cfg.cooldownSec[r] ?? 0;
    return last === undefined || input.now - last >= gap;
  };

  if (input.userRequested) candidates.push("user-request");

  const equityMove = pctMove(input.equityUsdg, state.lastEquityUsdg);
  if (equityMove >= cfg.equityMovePct) candidates.push("portfolio-change");

  if (input.newsKey && input.newsKey !== state.lastNewsKey) candidates.push("news-event");

  const priceMove = pctMove(input.priceUsd, state.lastPriceUsd);
  if (priceMove >= cfg.priceMovePct) candidates.push("price-move");

  const lastAny = Math.max(0, ...Object.values(state.lastFiredAt).filter((v): v is number => v !== undefined));
  if (lastAny === 0 || input.now - lastAny >= cfg.scheduledIntervalSec) candidates.push("scheduled-review");

  for (const r of candidates) {
    if (cooled(r)) {
      return {
        fire: true,
        reason: r,
        detail: describe(r, { equityMove, priceMove, newsKey: input.newsKey }),
        candidates,
      };
    }
  }

  return {
    fire: false,
    reason: null,
    detail: candidates.length
      ? `${candidates.join(", ")} qualified but every one is still cooling down`
      : "nothing changed enough to be worth thinking about",
    candidates,
  };
}

function describe(
  r: TriggerReason,
  ctx: { equityMove: number; priceMove: number; newsKey: string | null },
): string {
  switch (r) {
    case "user-request":
      return "a person asked";
    case "portfolio-change":
      return `equity moved ${(ctx.equityMove * 100).toFixed(1)}%`;
    case "news-event":
      return `new material item ${ctx.newsKey}`;
    case "price-move":
      return `price moved ${(ctx.priceMove * 100).toFixed(1)}%`;
    case "scheduled-review":
      return "the scheduled review interval elapsed";
  }
}

/** What the state becomes after a run fires. PURE. */
export function afterFiring(
  state: TriggerState,
  reason: TriggerReason,
  input: TriggerInputs,
): TriggerState {
  return {
    lastFiredAt: { ...state.lastFiredAt, [reason]: input.now },
    // THE BASELINE MOVES ON EVERY FIRE, whatever the reason. Otherwise a
    // scheduled review leaves an old price in place and the next tick reads the
    // same drift as a fresh move — one real movement billing twice.
    lastPriceUsd: input.priceUsd,
    lastEquityUsdg: input.equityUsdg,
    lastNewsKey: input.newsKey,
  };
}

export const EMPTY_TRIGGER_STATE: TriggerState = {
  lastFiredAt: {},
  lastPriceUsd: null,
  lastEquityUsdg: null,
  lastNewsKey: null,
};
