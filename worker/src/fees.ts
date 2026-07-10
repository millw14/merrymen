/**
 * Performance-fee accounting — the Hyperliquid-proven model:
 * fees ONLY on profit above the high-water mark. No management fee, no fee on
 * losses, no fee on recovering back to a previous peak. The HWM is persistent
 * (survives worker restarts) and monotonic — it never goes down.
 *
 * Accrual-only for now: the ledger records what is owed; actual collection
 * (transfer to the platform) ships with the funded-account flow so the ledger
 * is auditable before any money moves.
 */

export interface FeeAccrual {
  /** New high-water mark after this observation (== equity when profit was made). */
  newHwmUsdg: bigint;
  /** Profit above the previous HWM (0 when flat or under water). */
  profitUsdg: bigint;
  /** Fee accrued on that profit at feeBps. */
  feeUsdg: bigint;
}

/**
 * One equity observation against the current HWM.
 * equity <= hwm → nothing accrues, HWM unchanged (recovering isn't profit).
 * equity >  hwm → fee accrues on the excess and the HWM ratchets up to equity.
 */
export function accrueAboveHwm(
  equityUsdg: bigint,
  hwmUsdg: bigint,
  feeBps: number,
): FeeAccrual {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) {
    throw new Error(`feeBps out of range: ${feeBps}`);
  }
  if (equityUsdg <= hwmUsdg) {
    return { newHwmUsdg: hwmUsdg, profitUsdg: 0n, feeUsdg: 0n };
  }
  const profitUsdg = equityUsdg - hwmUsdg;
  return {
    newHwmUsdg: equityUsdg,
    profitUsdg,
    feeUsdg: (profitUsdg * BigInt(feeBps)) / 10_000n,
  };
}
