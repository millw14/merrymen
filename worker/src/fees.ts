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

/**
 * THE PER-TRADE FEE — the second fee, and a different animal from the first.
 *
 * The performance fee below is charged on PROFIT above a high-water mark: no
 * profit, no fee, and recovering back to a previous peak is free. This one is
 * charged on TURNOVER, so it is owed whether the trade made money or lost it.
 * That is a real difference to an owner and the two are kept apart everywhere —
 * separate function, separate rate, separate column — so neither can be mistaken
 * for the other in an audit or on a screen.
 *
 * ACCRUAL ONLY, deliberately, and for the reason this file already gives about
 * the other one: "the ledger records what is owed; actual collection (transfer
 * to the platform) ships with the funded-account flow so the ledger is
 * auditable before any money moves." Nothing here moves anything. Collection
 * needs a `transfer` permission sealed into the wall — which no existing grant
 * carries, because `withdrawalAddresses` has always been empty — so it cannot
 * happen for any agent until that agent's owner re-signs.
 *
 * ON THE NOTIONAL, NOT THE FILL. `notionalUsdg` is what the intent asked for and
 * what every cap in the wall is denominated in, so a fee derived from it can be
 * checked against the same number an owner already agreed to. A fee derived
 * from the received amount would move with slippage, which is not something
 * either side controls.
 */
export function tradeFeeUsdg(notionalUsdg: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) {
    throw new Error(`trade feeBps out of range: ${feeBps}`);
  }
  // A NEGATIVE NOTIONAL IS NOT A REBATE. Sizes are unsigned everywhere upstream;
  // if one ever arrives signed, charging a negative fee would credit the owner
  // out of the fee account. Refuse the input rather than invent a payout.
  if (notionalUsdg <= 0n) return 0n;
  // Integer division truncates, so the fee rounds DOWN — toward the owner, on
  // every trade, forever. That is the correct direction for a rounding error
  // nobody will audit.
  return (notionalUsdg * BigInt(feeBps)) / 10_000n;
}

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
