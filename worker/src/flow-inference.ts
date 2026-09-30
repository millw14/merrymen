/**
 * WHEN A CASH CHANGE MAY BE CALLED CAPITAL — the inference half of
 * index.ts reconcileFlows, lifted out so a test can run it.
 *
 * Inference is the narrow fallback for when the deposit scan did not cover the
 * window (off by default, or its RPC failed): cash moved and nothing the agent
 * did explains it, so it is booked as a deposit or a withdrawal with the peak
 * moved beside it.
 *
 * THE HOLE THIS CLOSES, TWICE.
 *
 * First version: "nothing explains it" was measured by `ledgerWrites`, which
 * only recordTrade moves. An op whose outcome the worker never heard — the
 * bundler's receipt wait timed out (UserOpUnresolved), or an energy purchase's
 * receipt could not be re-read — stays 'submitted' with no recordTrade while
 * its money DOES move on-chain. The next tick booked the drop as a withdrawal;
 * minutes later the stranded-op resolver booked the same energy purchase AGAIN
 * as capital out. Peak and contributions 10 USDG too low: a fee on principal.
 *
 * Second version (the ACC1 fix) held inference while such an op was in flight
 * and let the resolver bump `ledgerWrites` when it settled one, so the interval
 * closed as "explained". That explained far too much: the WHOLE held interval,
 * whatever else moved in it. A deposit the owner made while any op was stranded
 * was never booked (and was charged a fee on the held ticks, whose peak was the
 * pre-deposit one); a stranded transfer home was never booked at all; a
 * REVERTED op, which moved nothing, closed the interval just the same.
 *
 * THE RULE NOW: A SETTLEMENT EXPLAINS ONLY ITS OWN CASH.
 *
 *   1. While an op the resolver may still settle is in flight, the look HOLDS:
 *      the baseline stays, the write snapshot stays, and the tick accrues no fee
 *      and ratchets no lifetime peak (command-wake.ts tickRatchets `held`). The
 *      drawdown breaker's peak keeps observing, with a figure no unbooked cash
 *      can reach (heldBreakerObservationUsdg). The hold is asked BEFORE the
 *      ledger-write rule, so a trade landing beside a stranded op cannot close
 *      the interval over it.
 *   2. When the resolver settles an op as LANDED it queues that op's own USDG
 *      movement, read off its receipt (`Settlement`). The next look folds it
 *      into the baseline, so the residual — cash − (baseline + Σ settled) — is
 *      exactly what no settlement explains: a deposit or a withdrawal. A
 *      REVERTED op queues nothing. A movement nobody could read is not guessed:
 *      contributions are marked unknown and the interval closes uninferred.
 *   3. When the hold ends: a ledger write in the interval still explains it
 *      (the known limitation for trade intervals — a fill's cash leg is a
 *      pre-trade bound, not a receipt); otherwise the residual is booked.
 *
 * WHICH SETTLEMENTS A BASELINE MAY TAKE — `since`. A settlement shifts a
 * baseline only when the op was created at or after the moment that baseline's
 * cash was established (the look's ledger read, or when the restart's durable
 * reading's cash was READ — store.ts `cash_read_at`, never the row's later
 * insert, which a mid-tick op can precede). An op created before it was either
 * settled and in that cash already, or was not holding when the baseline
 * advanced over it — shifting by it again would book its movement a second
 * time with the opposite sign.
 */

/**
 * The stranded-op resolver's lookback, seconds: the 24h cap window plus two
 * hours (index.ts runStrandedResolve and reconcileInFlightAtArm scan this far
 * back for an op's UserOperationEvent).
 */
export const STRANDED_RESOLVE_WINDOW_SEC = 26 * 3600;

/**
 * DOES AN OP IN FLIGHT HOLD INFERENCE? True while the ledger has a 'submitted'
 * op the resolver may still settle: one in the current accounting epoch
 * (the resolver skips any other) created within its lookback.
 *
 * A DROPPED OP ENDS ITS HOLD WHEN IT PROVABLY CANNOT LAND. A userOp the bundler
 * dropped is never found by its hash, and used to hold for the whole window —
 * 26 hours in which a deposit was not booked. Once another op of ours, signed
 * with the same nonce, has executed, the EntryPoint can never include it: the
 * resolver writes it off as 'dropped' (inflight-reconcile.ts findDroppedOps),
 * it is no longer 'submitted', and the next look no longer holds on it. It
 * moved nothing, so it queues no settlement. One that nothing has superseded
 * could still be included by anyone holding it, and keeps holding.
 *
 * WHY BOUNDED, and not "any submitted row". A dropped op nothing proves dead —
 * no later op spent its nonce, or its row predates the recorded nonce — is
 * never found and its row stays 'submitted' for ever, as does a row from an
 * earlier epoch (left for `merrymen verify`). Holding inference on those would
 * switch it off for good — every later deposit booked as profit and charged a
 * fee. Past the resolver's window an op that ever landed did so long before the
 * cash baseline this process holds, so it cannot be inside the interval.
 */
export function opsHoldInference(
  ops: readonly { createdAt: number; epoch: number }[],
  at: { epoch: number; nowSec: number },
): boolean {
  return ops.some((o) => o.epoch === at.epoch && o.createdAt >= at.nowSec - STRANDED_RESOLVE_WINDOW_SEC);
}

/** One op the stranded resolver settled as landed, queued for the next look. */
export interface Settlement {
  userOpHash: string;
  /** The op row's created_at (unix seconds) — when it was submitted. */
  createdAt: number;
  /**
   * The account's USDG movement this settlement EXPLAINS, 6dp, signed (a
   * purchase or a transfer home is negative). Null when the movement could not
   * be read — never guessed at.
   */
  usdgDelta6: bigint | null;
}

/**
 * WHAT ONE RESOLVED OP EXPLAINS — the resolver's half of rule 2, pure.
 *
 *   reverted            → nothing is queued: it moved no USDG.
 *   a capital op        → an energy purchase or a transfer home is capital, not
 *                         a trade: its movement is explained only when its
 *                         booking STOOD (booked now, or already on the books).
 *                         A refused booking explains nothing (0n), so inference
 *                         sees that cash and books it once rather than never.
 *   anything else       → a trade: its own receipt movement, or null (unread).
 *
 * `capitalBooked` is null for a trade, true/false for a capital op.
 */
export function settlementDelta(a: {
  success: boolean;
  /** The receipt's net USDG movement for the account; null when the receipt could not be read. */
  receiptUsdgDelta6: bigint | null;
  capitalBooked: boolean | null;
}): { queue: false } | { queue: true; usdgDelta6: bigint | null } {
  if (!a.success) return { queue: false };
  if (a.capitalBooked === false) return { queue: true, usdgDelta6: 0n };
  return { queue: true, usdgDelta6: a.receiptUsdgDelta6 };
}

/**
 * Rule 2's other half: what a batch of settlements does to a baseline whose
 * cash was established at `since`. `since` null means no baseline exists yet,
 * so nothing is folded (and nothing is unread).
 */
export function attributeSettlements(
  settled: readonly Settlement[],
  since: number | null,
): { shiftUsdg6: bigint; unread: Settlement[] } {
  let shiftUsdg6 = 0n;
  const unread: Settlement[] = [];
  if (since === null) return { shiftUsdg6, unread };
  for (const s of settled) {
    // Already in the baseline's cash: see the header, WHICH SETTLEMENTS.
    if (s.createdAt < since) continue;
    if (s.usdgDelta6 === null) unread.push(s);
    else shiftUsdg6 += s.usdgDelta6;
  }
  return { shiftUsdg6, unread };
}

export type LookVerdict =
  /** An op is in flight: book nothing and KEEP the baseline, so the interval stays open. */
  | { action: "hold" }
  /**
   * Nothing is inferred and the baseline advances: a ledger write in the
   * interval explains it, or a settlement in it moved cash nobody could read
   * (the caller has marked contributions unknown for that one).
   */
  | { action: "explained"; why: "ledger-write" | "unread-settlement" }
  /** Cash moved and nothing explains it: book `deltaUsdg` (signed) as capital. */
  | { action: "infer"; deltaUsdg: bigint };

export interface Look {
  /**
   * The baseline with this look's settlements folded in. The caller keeps it
   * whether or not the look holds: a settled op's movement is explained for
   * good, and folding it now is what lets a later look see only the residual.
   */
  baselineUsdg: bigint;
  /** Settlements that moved cash nobody could read, newly seen by this look. */
  unread: Settlement[];
  /** Whether the open interval now holds an unread settlement. */
  unattributed: boolean;
  verdict: LookVerdict;
}

/**
 * ONE LOOK AT THE CASH, against a baseline — the whole of rules 1–3.
 *
 * Used for the steady state and for the self-hosted first look after a restart
 * (whose baseline is the last durable reading): one rule for both, so a
 * stranded op's cash is never booked as "changed while the worker was
 * stopped" where the steady state would have explained it.
 */
export function lookAtCash(a: {
  baselineUsdg: bigint;
  since: number | null;
  /** The interval already holds an unread settlement (from an earlier, held look). */
  unattributed: boolean;
  settled: readonly Settlement[];
  cashUsdg: bigint;
  opsInFlight: boolean;
  /** Did anything the agent recorded (recordTrade) move money in the interval? */
  writesInInterval: boolean;
}): Look {
  const { shiftUsdg6, unread } = attributeSettlements(a.settled, a.since);
  const baselineUsdg = a.baselineUsdg + shiftUsdg6;
  const unattributed = a.unattributed || unread.length > 0;
  // THE HOLD FIRST. Asked after the write rule, one trade landing beside a
  // stranded op closed the interval over the op's cash and everything else in
  // it — the ACC1 fix's masking.
  const verdict: LookVerdict = a.opsInFlight
    ? { action: "hold" }
    : a.writesInInterval
      ? { action: "explained", why: "ledger-write" }
      : unattributed
        ? { action: "explained", why: "unread-settlement" }
        : { action: "infer", deltaUsdg: a.cashUsdg - baselineUsdg };
  return { baselineUsdg, unread, unattributed, verdict };
}

/**
 * THE CASH A HELD LOOK EXPECTS: a baseline's cash with every queued
 * settlement's own movement folded in, by the same `since` rule a look uses
 * (attributeSettlements) — what the account would hold now if nothing unbooked
 * had crossed its boundary. Null when there is no baseline at all. A settlement
 * nobody could read shifts nothing here: guessing at it is what rule 2 forbids,
 * and the caller only ever uses this figure to take cash OUT of an observation.
 */
export function expectedCashUsdg(
  baseline: { cashUsdg: bigint; since: number | null } | null,
  queued: readonly Settlement[],
): bigint | null {
  if (baseline === null) return null;
  return baseline.cashUsdg + attributeSettlements(queued, baseline.since).shiftUsdg6;
}

/**
 * WHAT A HELD LOOK MAY STILL SHOW THE DRAWDOWN BREAKER.
 *
 * A held tick accrues no fee and moves no lifetime peak, because a deposit made
 * during the hold is in this equity and not yet in the peak (rule 1). But the
 * breaker's peak froze with them, and a dropped userOp holds for the resolver's
 * whole window — 26 hours — so a book that ran 100 → 150 → 110 under a hold
 * was judged at 110 against 100: no drawdown, where a 5% limit sees 26.7%, and
 * every non-exit buy went out for a day. A risk limit may not switch off
 * because the accounting is waiting.
 *
 * So the breaker keeps observing, with a figure that CANNOT contain an unbooked
 * deposit: equity less any cash above what the account is expected to hold
 * (`expectedCashUsdg`). A deposit or a sell during the hold raises cash above
 * that and is taken straight back out; a buy, a purchase or a withdrawal only
 * lowers cash and changes nothing here. Every error is downward — a peak not
 * raised — which is the direction the breaker's reference already errs in when
 * it is frozen, never a deposit counted into a peak twice once it is booked.
 * With no baseline at all, every dollar of cash is treated as possibly unbooked.
 */
export function heldBreakerObservationUsdg(a: {
  equityUsdg: bigint;
  cashUsdg: bigint;
  expectedCashUsdg: bigint | null;
}): bigint {
  const unexplained = a.cashUsdg - (a.expectedCashUsdg ?? 0n);
  const observed = a.equityUsdg - (unexplained > 0n ? unexplained : 0n);
  return observed > 0n ? observed : 0n;
}

/**
 * DID AN EARLIER PROCESS WRITE TO THE LEDGER AFTER THE RESTART'S READING? The
 * first look's durable stand-in for the write rule: `earlierLanded` are the
 * landed rows created after the last durable cash reading and before this
 * process started (store.ts landedOpsBetween). A row this process's own
 * resolver settled is NOT a write — its settlement explains exactly its own
 * movement — and any other is: a fill recorded, or a stranded op settled, by a
 * process that stopped before its next reading. A row with no op hash counts.
 */
export function wroteSince(earlierLanded: readonly (string | null)[], settledHere: ReadonlySet<string>): boolean {
  return earlierLanded.some((h) => h === null || !settledHere.has(h));
}
