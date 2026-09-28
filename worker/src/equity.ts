/**
 * What the book is worth, and what of that the agent actually earned.
 *
 * Pure, and extracted deliberately. All of it lived inside closures in
 * index.ts — a 1,900-line file with zero exports — so nothing here was
 * reachable from a test. That is how a set of money bugs survived next to a
 * green suite: the arithmetic was never wrong in a way a unit test could see,
 * because no unit test could see the arithmetic.
 */

/** Everything that counts toward the book's value, in 6dp USDG units. */
export interface BookParts {
  cashUsdg: bigint;
  vaultUsdg: bigint;
  positionsUsdg: bigint;
  /**
   * Cost sitting in positions we cannot currently price (see quarantine.ts).
   * Carried at COST, not at a mark, because a mark is exactly what we don't
   * have — but dropping it entirely would understate the book by the whole
   * value of the holding.
   */
  quarantinedCostUsdg: bigint;
}

/**
 * The one definition of equity.
 *
 * There used to be two. index.ts summed cash + vault + positions + quarantine
 * for the high-water mark, the performance fee and the drawdown breaker, while
 * addEquity RE-derived the total from three of those four fields for the row it
 * wrote. So the curve everyone reads sat below the figure the fee ratcheted on,
 * permanently, by the quarantined cost.
 *
 * NOTE what is deliberately absent: ETH. Gas is paid from it, so it is real
 * money, but folding a volatile asset into equity would feed it to the
 * high-water mark and the drawdown breaker — an ETH rally would ratchet the HWM
 * and accrue a performance fee on the gas float, and an hour where the WETH
 * pool is refused would drop equity by the whole ETH balance and read as a
 * genuine drawdown.
 *
 * So the book is the USDG book, and ETH is fuel: its CONSUMPTION is charged
 * against P&L at the price on the day it was burned (trades.gas_usdg, priced
 * from the WETH pool TWAP), rather than its BALANCE being marked. See pnlUsdg.
 *
 * ALSO ABSENT: THE ENERGY RESERVE ($MERRYMEN in the account). It sits outside
 * the book exactly as ETH does — never watched, never a position, never valued
 * here, never sold by a strategy — and for the same reasons: marked, an owner's
 * in-kind top-up would ratchet the peak as profit, and a refused price read
 * would read as a drawdown. But it is not fuel. It is BOUGHT with book capital
 * and KEPT, not burned, so its purchase is not an expense charged to P&L (that
 * would show a loss equal to the spend and could trip the breaker). It is booked
 * as capital leaving the book: an 'energy-buy' out-flow with both peaks lowered
 * by the same amount in one transaction (store.bookCapitalFlow,
 * energy-accounting.ts). Equity and the peak drop together, so P&L and the
 * drawdown are what they were.
 *
 * KNOWN LIMITS, both of which the operator tools cover: a purchase made with
 * the OWNER's key out of the account's USDG is not booked by the worker (owners
 * are told to send $MERRYMEN directly instead), and a redeploy during the
 * purchase's receipt wait leaves it unbooked until hwm-repair / reconstruction
 * restore it — the audit's envelope floor is the detector.
 */
export function composeEquityUsdg(parts: BookParts): bigint {
  return parts.cashUsdg + parts.vaultUsdg + parts.positionsUsdg + parts.quarantinedCostUsdg;
}

/**
 * Profit: what the book is worth, less what its owner put into it.
 *
 * Returns null when contributions are UNKNOWN, which is not the same as zero. A
 * ledger written before flow tracking existed knows nothing about deposits, and
 * `equity - 0` is the bankroll — reporting that as profit is the original bug.
 * Callers must show nothing rather than something wrong.
 */
export function pnlUsdg(
  equityUsdg: number,
  netContributionsUsdg: number | null,
  /**
   * Gas paid, in USDG, priced when it was burned. Subtracted because it is a
   * real cost of trading that equity cannot see: gas leaves the account in ETH,
   * and `equity_usdg` is cash + vault + positions. Pass 0 only when you know
   * the figure is zero — for "not known", see gasPriced below.
   */
  gasUsdg = 0,
): number | null {
  if (netContributionsUsdg === null) return null;
  return equityUsdg - netContributionsUsdg - gasUsdg;
}

/** What a P&L figure is net of, so a surface can say so rather than imply it. */
export interface GasCoverage {
  /** USDG of gas that could be priced. */
  usdg: number;
  /** Landed trades whose gas could NOT be priced — the figure is gross of these. */
  unpricedTrades: number;
}

/**
 * How to describe a P&L figure honestly given what is known about gas.
 *
 * "Net of gas" is a claim, and it is only true if every trade's gas was
 * priceable. When some was not, the figure is net of SOME gas — and saying so
 * is the difference between a number and a number you can rely on.
 */
export function gasQualifier(cov: GasCoverage): string {
  if (cov.unpricedTrades === 0) return cov.usdg > 0 ? "net of gas" : "no gas costs recorded";
  return `net of ${cov.usdg.toFixed(2)} USDG gas, but ${cov.unpricedTrades} trade(s) had unpriceable gas — this is not the full cost`;
}

/**
 * Drawdown from the high-water mark, in basis points, floored at zero.
 *
 * The mark is expected to have already moved with any capital that crossed the
 * boundary (see store.adjustAgentHwm) — otherwise a withdrawal reads as a loss
 * of exactly the amount withdrawn and trips the breaker on an owner who simply
 * took their money home.
 */
export function drawdownBps(highWaterMarkUsdg: bigint, equityUsdg: bigint): number {
  if (highWaterMarkUsdg <= 0n) return 0;
  if (equityUsdg >= highWaterMarkUsdg) return 0;
  return Number(((highWaterMarkUsdg - equityUsdg) * 10_000n) / highWaterMarkUsdg);
}

/**
 * Can this tick's book be believed?
 *
 * Any gap means the answer is no, and the tick must write nothing — an unknown
 * booked as a zero becomes the baseline every later figure is measured against.
 * Returns the reasons so the operator is told which, rather than just "paused".
 */
export function bookGaps(args: {
  /** Balances the chain would not report (snapshot.readAccountBalances). */
  unreadBalances: readonly string[];
  /** The whole position read failed — empty means unknown, not unheld. */
  positionsReadFailed: boolean;
  /** Held symbols with a configured feed that did not price this tick. */
  missingPrice: readonly string[];
}): string[] {
  const gaps: string[] = [...args.unreadBalances];
  if (args.positionsReadFailed) gaps.push("positions");
  gaps.push(...args.missingPrice);
  return gaps;
}
