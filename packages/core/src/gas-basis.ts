/**
 * WHETHER A P&L FIGURE HAS HAD ITS GAS TAKEN OUT — asked once, for every surface.
 *
 * Three sites derived this independently and all three derived it wrong in the
 * same way: `usdg > 0 ? "net" : "unknown"`. That reads a ZERO as an absence, and
 * on this fleet the zero is usually a measurement — gas is sponsored, the
 * paymaster settles with the EntryPoint directly, and the account never handles
 * ETH. Its trading gas genuinely costs the owner nothing.
 *
 * WHAT THAT COST. The caveat this produces says "trading costs are not
 * subtracted, so small edges are overstated". For a sponsored book that is
 * false: there is nothing to subtract and nothing is overstated. But the Brain's
 * gate counts caveats, and at three it downgrades every decision to hold. A
 * hardcoded `auditPassed: false` supplied one, this supplied a second, and the
 * whole fleet sat one real problem away from being unable to trade — on a
 * caveat that was not true of any of them.
 *
 * THE RULE, STATED ONCE:
 *
 *   unreadable            unknown   we asked and the ledger did not answer
 *   some fills unpriced   gross     gas was paid; part of it has no USDG figure
 *   everything priced     net       including a measured zero
 *
 * A MEASURED ZERO IS NET. Subtracting zero is subtracting correctly, and the
 * figure is exactly as net-of-gas as one where the subtraction was large. That
 * is the whole correction, and it rests on `read` — an explicit signal from the
 * reader, never inferred from the numbers, so a catch can never present itself
 * as a measurement. This is the same rule the rest of this codebase keeps about
 * empty versus unavailable; it was simply not kept here.
 */
export type GasBasis = "gross" | "net" | "unknown";

export interface GasCoverage {
  /**
   * DID THE LEDGER ANSWER? Not "is the number non-zero".
   *
   * Carried explicitly because the reader's failure path used to return the
   * same `{ usdg: 0, unpricedTrades: 0 }` as a book that had paid no gas, which
   * made a read failure and a sponsored fleet literally indistinguishable. A
   * boolean the reader sets is the only thing that can tell them apart, and
   * inferring it downstream would rebuild the bug in a new place.
   */
  read: boolean;
  /** Landed trades whose gas is known to have been paid but carries no USDG figure. */
  unpricedTrades: number;
}

export function gasBasisOf(g: GasCoverage): GasBasis {
  // ORDER MATTERS. An unreadable ledger may still report zero unpriced trades —
  // it reports zero of everything — so the read has to be asked first or a
  // failure would come back as a confident "net".
  if (!g.read) return "unknown";
  if (g.unpricedTrades > 0) return "gross";
  return "net";
}
