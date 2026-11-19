/**
 * HAS IT LANDED? Answered from the agent's own USDG balance, which is the one
 * thing this page can read about a deposit the owner signed somewhere else.
 *
 * The first slice signs on relay.link, so this page never sees a request id.
 * What it does see is `balances.cashUsdg` from /api/grants: the chain's own
 * answer, refreshed on the account clock, and `null` whenever that read failed
 * (grant-balances.ts). So the tracker does three things:
 * - It takes a reading when the owner leaves for Relay.
 * - It compares each later reading against that one.
 * - It says only what that comparison can support.
 *
 * WHAT IT WILL NOT SAY:
 * - "Failed". A rise that never came may be a deposit not signed yet, a fill
 *   that is still running, or one Relay refunded. None of those is visible
 *   from here, so a late deposit is "not seen yet", with Relay's own record as
 *   the place to look.
 * - Zero. A failed read is "unread", and a missing starting reading is
 *   "no-baseline". Comparing against a guessed starting point would say
 *   "arrived" or "nothing yet" about a number nobody measured.
 * - That the agent's trading was the deposit. A buy can spend USDG in the same
 *   minute the deposit lands, so a rise smaller than the quote's minimum is
 *   "partial", in the owner's words "some USDG arrived, less than the minimum",
 *   rather than either verdict.
 */

/** Past this, a deposit that has not shown up is "not seen yet" rather than "waiting". */
export const ARRIVAL_PATIENCE_MS = 15 * 60_000;

export interface ArrivalWatch {
  /** The agent's USDG base units when the owner left for Relay, or null if that read had failed. */
  baseline: bigint | null;
  /** The quote's minimum, in USDG base units. Relay refunds rather than deliver less. */
  minOut: bigint;
  /** When the owner opened Relay (ms). Signing happens some time after this. */
  openedAt: number;
}

export type Arrival =
  | { kind: "no-baseline"; current: bigint | null }
  | { kind: "unread" }
  | { kind: "waiting"; elapsedMs: number }
  | { kind: "late"; elapsedMs: number }
  | { kind: "partial"; rise: bigint }
  | { kind: "arrived"; rise: bigint };

/** A /api/grants balance string as base units, or null where the read failed. */
export function balanceOf(value: string | null | undefined): bigint | null {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

export function arrivalOf(watch: ArrivalWatch, current: bigint | null, now: number): Arrival {
  if (watch.baseline === null) return { kind: "no-baseline", current };
  if (current === null) return { kind: "unread" };
  const rise = current - watch.baseline;
  if (rise >= watch.minOut) return { kind: "arrived", rise };
  if (rise > 0n) return { kind: "partial", rise };
  const elapsedMs = Math.max(0, now - watch.openedAt);
  return elapsedMs >= ARRIVAL_PATIENCE_MS ? { kind: "late", elapsedMs } : { kind: "waiting", elapsedMs };
}
