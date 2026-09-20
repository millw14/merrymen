/**
 * WHEN IS IT WORTH WAKING BRAIN AT ALL?
 *
 * Events can bring research forward, and a quiet market still gets a review
 * within five minutes. The gate remains deterministic and per-reason cooldowns
 * prevent repeated events from spending the model budget on every poll.
 *
 * COOLDOWN IS PER REASON, not global. A price move and a portfolio change are
 * different questions, and a global cooldown would let a stale price trigger
 * suppress a genuine risk event minutes later.
 */
import { MAX_DECISION_INTERVAL_SEC, reviewLookaheadSec } from "./decision-cadence";

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
  lastInstrumentId?: string;
  lastEquityUsdg: number | null;
  lastNewsKey: string | null;
}

export interface TriggerInputs {
  now: number;
  /** Observed time needed to prepare a tick; permits a bounded early review. */
  reviewPreparationMs?: number;
  priceUsd: number | null;
  instrumentId?: string;
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

/**
 * How long Brain may sleep with nothing happening, in seconds.
 *
 * Five minutes by default and at most five minutes, including deployments that
 * still carry the old four-hour environment setting. A shorter explicit
 * interval is allowed down to one minute. Model/run budgets remain in force.
 */
export function scheduledInterval(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number((env.MERRYMEN_BRAIN_INTERVAL_SEC ?? "").trim());
  if (!Number.isFinite(raw) || raw < 60) return MAX_DECISION_INTERVAL_SEC;
  return Math.min(MAX_DECISION_INTERVAL_SEC, Math.floor(raw));
}

/** The next quiet-market review, including after a non-scheduled trigger. */
export function nextReviewAt(state: TriggerState, now: number, cfg: TriggerConfig = DEFAULT_TRIGGERS): number {
  const last = Math.max(0, ...Object.values(state.lastFiredAt).filter((v): v is number => v !== undefined));
  return last === 0 ? now : last + cfg.scheduledIntervalSec;
}

export const DEFAULT_TRIGGERS: TriggerConfig = {
  scheduledIntervalSec: scheduledInterval(),
  priceMovePct: 0.03,
  equityMovePct: 0.05,
  cooldownSec: {
    "price-move": 1800,
    "portfolio-change": 1800,
    "news-event": 900,
    // Never longer than the interval itself — a cooldown above it would silence
    // the very review it is meant to space out, which is how a configurable
    // cadence quietly becomes no cadence.
    "scheduled-review": Math.min(3600, Math.max(30, Math.floor(scheduledInterval() / 2))),
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

  const priceMove = input.instrumentId === state.lastInstrumentId
    ? pctMove(input.priceUsd, state.lastPriceUsd) : 0;
  if (priceMove >= cfg.priceMovePct) candidates.push("price-move");

  const lastAny = Math.max(0, ...Object.values(state.lastFiredAt).filter((v): v is number => v !== undefined));
  const lookahead = reviewLookaheadSec(input.reviewPreparationMs, cfg.scheduledIntervalSec);
  if (lastAny === 0 || input.now + lookahead - lastAny >= cfg.scheduledIntervalSec) candidates.push("scheduled-review");

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
    ...(input.instrumentId ? { lastInstrumentId: input.instrumentId } : {}),
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
