/** Active workers revisit their book at least every five minutes when reads complete. */
export const MAX_DECISION_INTERVAL_SEC = 300;

/**
 * Budget preparation before a review deadline. A shorter read may finish in
 * this early window, so the trigger and fallback use this same allowance.
 * Limit it to half an interval: a slow observation must not authorize an
 * unbounded catch-up loop or silently become a one-second research cadence.
 */
export function reviewLookaheadSec(preparationMs = 0, intervalSec = MAX_DECISION_INTERVAL_SEC): number {
  if (!Number.isFinite(preparationMs) || preparationMs <= 0 || !Number.isFinite(intervalSec) || intervalSec <= 0) return 0;
  return Math.min(Math.ceil(preparationMs / 1000), intervalSec / 2);
}

export function tickIntervalMs(seconds: number): number {
  const bounded = Number.isFinite(seconds) ? Math.max(15, Math.min(seconds, MAX_DECISION_INTERVAL_SEC)) : 60;
  return bounded * 1000;
}

/**
 * Schedule from the start of the previous tick, so processing time does not
 * accumulate as drift. A Brain deadline can bring the next tick forward.
 * Called only after the previous tick settles: overdue work never overlaps.
 */
export function nextTickDelayMs(args: {
  startedAt: number;
  now: number;
  tickSeconds: number;
  nextReviewAt?: number | null;
  preparationMs?: number;
  reviewIntervalSec?: number;
}): number {
  const regular = args.startedAt + tickIntervalMs(args.tickSeconds);
  const deadline = args.nextReviewAt != null && Number.isFinite(args.nextReviewAt)
    ? args.nextReviewAt * 1000
    : Infinity;
  const early = deadline - reviewLookaheadSec(args.preparationMs, args.reviewIntervalSec) * 1000;
  // An early tick can be withheld by a cooldown or a publication gate. Once
  // its preparation window has passed, retry at the real deadline, not every
  // second until that deadline arrives.
  const review = early > args.now ? early : deadline;
  return Math.max(1000, Math.min(regular, review) - args.now);
}
