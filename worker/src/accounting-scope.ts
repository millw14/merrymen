/**
 * WHICH FRAME EACH MONEY FIGURE LIVES IN.
 *
 * merrymen has accounting EPOCHS. An epoch is opened when the rows before it
 * cannot be audited — pre-flow-tracking balances, fills booked off a slippage
 * floor — and everything before the boundary is kept for forensics but excluded
 * from performance. `openNextEpoch` bridges the two by writing the closing
 * equity of the old epoch as an OPENING BALANCE flow in the new one.
 *
 * THAT BRIDGE IS ONLY CORRECT IF CONTRIBUTIONS ARE READ PER EPOCH, and one of
 * the two readers was not. `getNetContributionsUsdg` summed `FROM flows WHERE
 * agent_id = ?` with no epoch predicate while the web's identical query carried
 * one. The mismatch was invisible because the only agents ever bumped were those
 * with pre-fix rows, and pre-fix rows predate the flows table — so epoch 1 held
 * no flows and lifetime happened to equal current-epoch.
 *
 * Accidentally correct is not correct. Fund an agent today (a real chain-log
 * flow in epoch 1), bump it for any future reason, and the lifetime sum counts
 * that deposit AND the opening balance derived from it: contributions double,
 * P&L goes as negative as the deposit was large, and nothing anywhere notices.
 *
 * So the frames are written down, and the queries are made to match them.
 */

/**
 * The frame a figure is measured in.
 *
 *   lifetime      every row the account ever wrote, across all epochs
 *   epoch         only the current accounting epoch
 *   monotonic     a ratchet that never decreases and never resets at a boundary
 *   carried       reset at a boundary, with the closing value bridged forward
 *                 as an explicit opening record in the new epoch
 */
export type AccountingScope = "lifetime" | "epoch" | "monotonic" | "carried";

/**
 * THE REGISTER. Every money figure in the system, and the frame it belongs to.
 *
 * This is documentation that a test can read. `accounting-scope.test.ts` asserts
 * that the queries behind the epoch-scoped entries actually carry an epoch
 * predicate — so a future reader who adds a figure here without scoping its
 * query gets a failure rather than a comment that has quietly become false.
 */
export const ACCOUNTING_SCOPES = {
  /**
   * Σ flows in − Σ flows out. EPOCH-scoped, because the epoch boundary writes an
   * opening balance equal to what was carried: summing across the boundary
   * counts the same capital twice, once as the original deposit and once as the
   * bridge derived from it.
   */
  netContributionsUsdg: "epoch",
  /**
   * Realized P&L on closing fills. EPOCH-scoped: it is performance, and
   * performance before an unauditable boundary is exactly what the boundary
   * exists to exclude.
   */
  realizedPnlUsdg: "epoch",
  /**
   * Gas burned. EPOCH-scoped for the same reason as realized P&L — it is a cost
   * of trading and belongs to the period whose performance it reduces.
   */
  gasUsdg: "epoch",
  /**
   * The high-water mark. MONOTONIC and deliberately NOT reset at a boundary.
   *
   * `setAgentHwm` is `MAX(hwm_usdg, ?)` in SQL — a one-way door with a real
   * performance fee written in the same breath, and no procedure walks either
   * back. Resetting it at a boundary would re-charge the owner for profit
   * already paid on. The bridge keeps the frames consistent: the new epoch opens
   * with the old one's equity as contributed capital, so the peak that equity
   * reached is still the right thing to measure against.
   */
  hwmUsdg: "monotonic",
  /** What the house has earned, ever. MONOTONIC — a boundary does not un-earn a fee. */
  accruedFeeUsdg: "monotonic",
  /**
   * Equity. LIFETIME by nature: it is a balance reading, not an accumulation.
   * An epoch cannot reset what the account is worth right now.
   */
  equityUsdg: "lifetime",
  /** Cash, positions and vault — components of that same balance reading. */
  cashUsdg: "lifetime",
  positionsUsdg: "lifetime",
  vaultUsdg: "lifetime",
  /**
   * Cost basis of open positions. CARRIED: the holdings survive a boundary, so
   * their basis must too, or the first sale after a bump books the entire
   * proceeds as realized profit.
   */
  costBasisUsdg: "carried",
} as const satisfies Record<string, AccountingScope>;

export type ScopedFigure = keyof typeof ACCOUNTING_SCOPES;

/** Figures that MUST be read with an epoch predicate. */
export const EPOCH_SCOPED: readonly ScopedFigure[] = (
  Object.keys(ACCOUNTING_SCOPES) as ScopedFigure[]
).filter((k) => ACCOUNTING_SCOPES[k] === "epoch");

/**
 * The flow-evidence rule is DEFINED IN core, not here.
 *
 * The worker and the web were each carrying their own answer and the two
 * disagreed in both directions, so an agent past an epoch boundary was publicly
 * told its bridged capital was guesswork while the anchor counted the same row
 * as evidence. Re-exported rather than redefined so there is exactly one rule.
 */
export { EVIDENCED_FLOW_SOURCES, isEvidencedFlow, type FlowEvidence } from "../../packages/core/src/flow-evidence";


/**
 * Does an epoch-opening balance agree with what the previous epoch closed at?
 *
 * This is what makes `epoch-carry` evidence rather than assertion. The carry is
 * `lastKnownEquityUsdg` of the closing epoch, so it must equal the final
 * `equityUsdg` mark before the boundary. If it does not, the bridge is not a
 * bridge and the total resting on it is unknown.
 *
 * Pure, so an auditor with only an export can run it.
 */
export function reconcileEpochCarry(args: {
  openingBalanceUsdg: number;
  priorEpochClosingEquityUsdg: number | null;
  toleranceUsdg?: number;
}): { reconciles: boolean; why: string } {
  const tol = args.toleranceUsdg ?? 0.0001;
  if (args.priorEpochClosingEquityUsdg === null) {
    return {
      reconciles: false,
      why:
        "the previous epoch recorded no closing equity, so there is nothing to check the opening " +
        "balance against — the carried capital is unverified rather than wrong",
    };
  }
  const diff = args.openingBalanceUsdg - args.priorEpochClosingEquityUsdg;
  if (Math.abs(diff) <= tol) {
    return {
      reconciles: true,
      why: `opening balance ${args.openingBalanceUsdg.toFixed(6)} matches the previous epoch's closing equity`,
    };
  }
  return {
    reconciles: false,
    why:
      `opening balance ${args.openingBalanceUsdg.toFixed(6)} does not match the previous epoch's closing ` +
      `equity ${args.priorEpochClosingEquityUsdg.toFixed(6)} (off by ${diff.toFixed(6)}) — the bridge does ` +
      `not carry what the old epoch actually held`,
  };
}
