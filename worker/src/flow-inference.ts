/**
 * WHEN A CASH CHANGE MAY BE CALLED CAPITAL — the inference half of
 * index.ts reconcileFlows, lifted out so a test can run it.
 *
 * Inference is the narrow fallback for when the deposit scan did not cover the
 * window (off by default, or its RPC failed): cash moved and NOTHING was
 * written to the ledger in between, so nothing the agent did explains it, and
 * it is booked as a deposit or a withdrawal with the peak moved beside it.
 *
 * THE HOLE THIS CLOSES. "Nothing written in between" was measured by
 * `ledgerWrites`, which only recordTrade moves. An op whose outcome the worker
 * never heard — the bundler's receipt wait timed out (UserOpUnresolved), or an
 * energy purchase's receipt could not be re-read — stays 'submitted' with no
 * recordTrade, while its money DOES move on-chain. The next tick saw cash drop
 * with no write and booked it as a withdrawal, lowering both peaks; minutes
 * later the stranded-op resolver settled the same op, and for an energy
 * purchase booked it AGAIN as capital out (bookCapitalFlow dedupes on the
 * receipt's identity, which the hash-less inferred row does not have). Peak
 * and contributions 10 USDG too low: a performance fee on the owner's
 * principal, a published +10, and a breaker judged against a peak that low.
 * The same root cause booked every stranded SWAP's cash leg as a withdrawal.
 *
 * So: while the ledger holds an op the resolver may still settle, nothing is
 * inferred and the baseline is KEPT — the interval stays open until the op is
 * settled, and the resolver moves `ledgerWrites` when it settles one, so that
 * interval is then explained by the row it wrote.
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
 * WHY BOUNDED, and not "any submitted row". A userOp the bundler dropped is
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

export type SteadyInference =
  /** Cash moved and nothing explains it: book `deltaUsdg` (signed) as capital. */
  | { action: "infer"; deltaUsdg: bigint }
  /** An op is in flight: book nothing and KEEP the baseline, so the interval stays open. */
  | { action: "hold" }
  /** A ledger write explains the interval: book nothing and advance the baseline. */
  | { action: "explained" };

/**
 * The steady-state decision (a baseline exists and the scan did not cover the
 * window). A ledger write in the interval explains it first — the original
 * narrow rule; then an op in flight holds it; only then is the change inferred.
 */
export function steadyStateInference(a: {
  lastCashUsdg: bigint;
  cashUsdg: bigint;
  ledgerWrites: number;
  ledgerWritesAtSnapshot: number;
  opsInFlight: boolean;
}): SteadyInference {
  if (a.ledgerWrites !== a.ledgerWritesAtSnapshot) return { action: "explained" };
  if (a.opsInFlight) return { action: "hold" };
  return { action: "infer", deltaUsdg: a.cashUsdg - a.lastCashUsdg };
}
