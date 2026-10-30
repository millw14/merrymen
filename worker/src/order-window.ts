/** Browser-safe order deadlines shared by HTTP and owner Telegram admission. */
/**
 * How long after its expiry an UNCLAIMED row may still hold the one-at-a-time
 * slot, and how long GET waits before calling it expired.
 *
 * The expiry is enforced in the CHILD, at the claim, so a row can legitimately
 * be a ferry pass and a tick behind its own deadline while it is genuinely
 * being decided. Past that it either answered or never will.
 *
 * The orchestrator's ORDER_GRACE_MS is the same figure, stated there because
 * the two processes share no module: the ferry must not close a row before the
 * route would free its slot, or a second order is admitted beside a live one.
 */
export const ORDER_STALE_GRACE_MS = 2 * 60_000;

/**
 * How long past deadline AND grace a CLAIMED row goes on holding the slot.
 *
 * A claimed order may be waiting on its receipt well after its deadline — the
 * deadline bounds when the order STARTS (the worker refuses a late claim, and
 * refuses an order its intent queue reaches late), not when it finishes. So
 * the slot is released only once the order's own run cannot still be filling
 * it; freeing it earlier is "ask again" with the first order on chain. The
 * orchestrator's sweep closes such a row at the same moment, with a sentence
 * that does not claim to know.
 * Stated again in worker/src/command-files.ts for that sweep; a test holds the
 * two equal.
 */
export const ORDER_IN_FLIGHT_MS = 10 * 60_000;

/** The shortest an order window may ever be, whatever the tick. */
export const ORDER_TTL_FLOOR_MS = 5 * 60_000;

/**
 * How long an order stays willing to fill, for a given tick.
 *
 * Two ticks plus a ferry pass is the smallest window that survives missing one
 * — the child drains at most ONE command per tick — with the original five
 * minutes as a floor so a fast tick does not make orders expire faster than a
 * person can watch them. The route supplies the CALLER's tick, not the
 * container's.
 */
export function orderTtlMs(tickSeconds: number): number {
  return Math.max(ORDER_TTL_FLOOR_MS, (2 * tickSeconds + 15) * 1000);
}

export type OrderState = "queued" | "running" | "done" | "expired";

/**
 * The deadline an order was placed with, or null when it carries none.
 *
 * NULL IS NOT "ALREADY EXPIRED". The worker's `isExpired` treats a missing
 * `expiresAt` as no expiry at all, so an order without one can still be run —
 * and saying it expired would be telling the owner nothing was sent about an
 * order that may yet fill.
 */
export function orderExpiresAt(args: unknown): number | null {
  let bag: unknown = args;
  if (typeof args === "string") {
    try {
      bag = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!bag || typeof bag !== "object") return null;
  const v = (bag as { expiresAt?: unknown }).expiresAt;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The one rule, for a table row and a command file alike. */
export function orderStateOf(
  o: { done: boolean; claimed: boolean; expiresAt: number | null },
  nowMs: number,
): OrderState {
  if (o.done) return "done";
  if (o.claimed) return "running";
  if (o.expiresAt !== null && nowMs > o.expiresAt + ORDER_STALE_GRACE_MS) return "expired";
  return "queued";
}

/** An unanswered order, as the one-at-a-time rule reads it. */
export interface SlotHolder {
  claimed: boolean;
  expiresAt: number | null;
  /** Placed (or, for a self-hosted marker, claimed) — used only when there is no deadline. */
  at: number;
}

/**
 * The moment an unanswered order stops holding the owner's slot.
 *
 * UNCLAIMED: at the instant GET first says "expired" — never earlier, or a
 * second order is admitted while the first can still be claimed; never later,
 * or the owner is told to ask again and then refused for asking.
 *
 * CLAIMED: the in-flight bound after that, because a claimed order can still
 * be trading. Not for ever: a child SIGKILLed mid-trade — the watchdog does
 * that in bulk on this fleet — never answers, and a row nothing can finish
 * used to refuse every future order from that owner, for good.
 *
 * NO DEADLINE (legacy rows only; nothing the route writes today) AND NOT YET
 * CLAIMED: never, until it is claimed. The worker's `isExpired` runs such an
 * order whenever it gets to it, and GET calls it queued for as long as it
 * waits, so there is no moment at which it stops being able to fill. It used
 * to let go at the floor window and its grace — the orchestrator's old seven
 * minutes — and admit a second order beside one the worker would still run.
 * Hosted, the ferry ends the wait: it delivers the row, or closes it as never
 * delivered. Self-hosted, the worker's next armed tick does.
 *
 * NO DEADLINE, CLAIMED: the floor window from when it was placed (or, for a
 * marker, claimed), and the in-flight bound after it, as for any claimed order.
 */
export function slotFreesAt(o: SlotHolder): number {
  if (o.expiresAt === null && !o.claimed) return Number.POSITIVE_INFINITY;
  const deadline = o.expiresAt ?? o.at + ORDER_TTL_FLOOR_MS;
  return deadline + ORDER_STALE_GRACE_MS + (o.claimed ? ORDER_IN_FLIGHT_MS : 0);
}

export function holdsSlot(o: SlotHolder, nowMs: number): boolean {
  return nowMs <= slotFreesAt(o);
}

