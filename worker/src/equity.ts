/**
 * What the book is worth, and what of that the agent actually earned.
 *
 * Pure, and extracted deliberately. All of it lived inside closures in
 * index.ts — a 1,900-line file with zero exports — so nothing here was
 * reachable from a test. That is how a set of money bugs survived next to a
 * green suite: the arithmetic was never wrong in a way a unit test could see,
 * because no unit test could see the arithmetic.
 */

/**
 * THE VENUE'S SIDE OF THE BOOK (docs/perps.md rule 12): what this account holds
 * at Lighter, as five terms, every one integer micro-USDG — the SAME unit as
 * every other BookParts field (6dp USDG as bigint), so no term is converted on
 * its way into the sum.
 *
 * C, ΣM and ΣU come from ONE /api/v1/account response, the one whose
 * `transaction_time` is `snapshotTime`: opening an isolated position moves
 * margin from C into M atomically and funding debits M between reads, so terms
 * taken from two responses can count a margin twice or not at all.
 *
 * Kept as terms rather than one pre-summed figure because two readers need
 * more than the total: every PEAK subtracts `unrealizedGainMicro` (peakBasis),
 * and the breaker's held observation subtracts `inTransitMicro` (rule 12c).
 */
export interface PerpBookPart {
  /** C — the account's cross collateral (`collateral`). Excludes isolated margin. */
  collateralMicro: bigint;
  /** ΣM — `allocated_margin` over the isolated positions. Never negative. */
  isolatedMarginMicro: bigint;
  /** ΣU — every position's `unrealized_pnl` at mark, signed. */
  unrealizedMicro: bigint;
  /**
   * Σ max(0, Uᵢ), PER POSITION — never max(0, ΣU). A wick gain on one market
   * netted against a real loss on another would otherwise lift a peak on the
   * wick (the accounting finding peak-basis-not-applied-to-all-peaks).
   */
  unrealizedGainMicro: bigint;
  /** T_in + T_out — our deposits landed and not credited, our withdrawals executed and not paid. Never negative. */
  inTransitMicro: bigint;
  /** The snapshot's `transaction_time` (µs); null only on paper, where there is no venue response. */
  snapshotTime: number | null;
}

/**
 * The venue term as a tick knows it:
 *
 *   undefined       — this agent has NO perps (no marker and no venue account):
 *                     a KNOWN zero, and Lighter is never read (rule 11). Every
 *                     path is byte-identical to before perps existed.
 *   "unread"        — the agent has perps and this tick could not read them:
 *                     the book cannot be totalled (bookGaps), and unknown is
 *                     never zero.
 *   a PerpBookPart  — read, from one snapshot.
 */
export type PerpBookTerm = PerpBookPart | "unread" | undefined;

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
  /** The venue's side of the book — see PerpBookTerm. Absent is the known zero of an agent with no perps. */
  perp?: PerpBookTerm;
}

/** perpAccountUsdg = C + ΣM + ΣU + T (rule 12), micro-USDG; 0n for an agent with no perps. */
export function perpAccountUsdg(perp: PerpBookPart | undefined): bigint {
  if (perp === undefined) return 0n;
  return perp.collateralMicro + perp.isolatedMarginMicro + perp.unrealizedMicro + perp.inTransitMicro;
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
 *
 * PRESENT, AND NOT FUEL: THE PERP VENUE (docs/perps.md rule 12). Margin posted
 * to Lighter is the owner's USDG in an account keyed on this one, and every
 * withdrawal from it can only come back here — so it is the book, and leaving
 * it out would read every deposit as a loss of its whole size and trip the
 * breaker on money that merely moved. It enters as C + ΣM + ΣU + T. The
 * unrealized term is in EQUITY (the breaker sees every unrealized loss) but
 * never in a PEAK — see peakBasisUsdg.
 *
 * AN UNREAD VENUE THROWS rather than composing without it. Callers stop at
 * bookGaps first; a total that silently dropped the venue would be the partial
 * sum this function exists to prevent, and the drawdown it implied would be
 * arithmetic, not loss.
 */
export function composeEquityUsdg(parts: BookParts): bigint {
  const spot = parts.cashUsdg + parts.vaultUsdg + parts.positionsUsdg + parts.quarantinedCostUsdg;
  // Absent is the pre-perps sum, byte for byte — not `spot + 0n` through a
  // second path a later edit could make differ.
  if (parts.perp === undefined) return spot;
  if (parts.perp === "unread") {
    throw new RangeError("composeEquityUsdg: the perp venue was not read this tick — the book is a gap, not a total");
  }
  return spot + perpAccountUsdg(parts.perp);
}

/**
 * THE EQUITY EVERY PEAK RATCHETS ON (rule 12): equity − Σ max(0, Uᵢ).
 *
 * An open perp winner is not yet money. The lifetime high-water mark (and the
 * performance fee charged above it), the risk-period peak, the paper peak and
 * the held-look breaker lift are all one-way ratchets; lifted on a gain that can
 * still evaporate, each would charge a fee on — or measure a drawdown from — a
 * number the account never realised, and nothing walks a ratchet back. Losers
 * stay IN: a loss is real until it recovers, and subtracting it would lower a
 * peak the owner is owed.
 *
 * The breaker's CURRENT figure stays full equity (AgentState.equityUsdg), so
 * every unrealized loss is still judged. What that trades away, said out loud
 * as the contract requires: giving back an unrealized perp gain is never
 * counted as drawdown — only a fall below realized equity is. The venue stop
 * (rule 7) and protect.ts bound the give-back instead.
 *
 * Realizing a gain G raises the basis by exactly G (U becomes R), so the fee
 * is charged on G once, at the close. With no perps — `perp` undefined — the
 * basis IS equity and every ratchet behaves exactly as before.
 */
export function peakBasisUsdg(equityUsdg: bigint, perp: PerpBookPart | undefined): bigint {
  if (perp === undefined) return equityUsdg;
  if (perp.unrealizedGainMicro < 0n) {
    // Σ max(0, Uᵢ) is non-negative by construction; a negative figure would
    // RAISE every peak above equity. A parse that produced one is not read.
    throw new RangeError("peakBasisUsdg: the unrealized gain term cannot be negative");
  }
  return equityUsdg - perp.unrealizedGainMicro;
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
  /**
   * The venue term (rule 11). "unread" is a gap exactly like an unread
   * balance — the holding is there and its size is unknown. Absent or read is
   * no gap: an agent with no perps is a known zero, never a question.
   */
  perp?: PerpBookTerm;
}): string[] {
  const gaps: string[] = [...args.unreadBalances];
  if (args.positionsReadFailed) gaps.push("positions");
  gaps.push(...args.missingPrice);
  if (args.perp === "unread") gaps.push(PERP_VENUE_GAP);
  return gaps;
}

/** How an unread venue is named among the gaps — what the owner reads in "couldn't read …". */
export const PERP_VENUE_GAP = "Lighter";
