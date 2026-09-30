/**
 * THE LIVE PERP TERM OF EQUITY — the hook the perp lane calls once it reads
 * the live venue (docs/perps.md rules 11 and 12; the
 * perp-equity-omits-isolated-margin and margin-in-transit amendments).
 *
 *   perpAccountUsdg = C + ΣM_iso + ΣU + T_in + T_out
 *
 * C, ΣM and ΣU from ONE /api/v1/account response (its transaction_time is the
 * snapshot), `total_asset_value` only as the cross-check (markets.ts
 * totalAssetValueConsistent), and T_in + T_out from the tick's payout step
 * (perps/payout-look.ts → payouts.ts inTransit): the open perp_transfers rows
 * read after that step's payouts were booked, checked against
 * getPendingBalance(self, 3) at the block the cash was read at.
 *
 * UNKNOWN IS NEVER ZERO. Any one of these makes the term "unread" — a book gap
 * (equity.ts bookGaps): no equity row, no ratchet, no fee, and every non-exit
 * refused while the last known venue money was not a read zero (policy.ts
 * perp-unpriced) — never a partial sum:
 *   - the account read failed;
 *   - the cross-check failed;
 *   - transit could not be established (the payout step's fold or the ledger
 *     read failed), or the contract's pending balance is unread or larger than
 *     every withdrawal the ledger knows is on its way (a withdrawal nobody
 *     recorded — rule 12b).
 *
 * `venueMoneyMicro` is what exec-mode.ts canTradeForReal asks (rule 8a(f)):
 * USDG this account holds AT the venue — C + ΣM + T_in + T_out, the money
 * committed there whatever the marks say — so posting the last USDG as
 * margin does not read the account as broke. Null when unread (not zero).
 *
 * PURE. The lane (step 2) calls it with its one venue read; index.ts takes the
 * result through noteLivePerpTerm.
 */

import type { PerpBookPart, PerpBookTerm } from "../equity";
import { totalAssetValueConsistent, type PerpAccountRead } from "./markets";
import type { InTransit } from "./payouts";

export interface LivePerpTerm {
  /** equity.ts's term: a read part, or "unread". */
  book: Exclude<PerpBookTerm, undefined>;
  /** C + ΣM + ΣU + T when read — the venue money a later unread tick judges against (perpLastKnownMicro); null when not. */
  valueMicro: bigint | null;
  /** C + ΣM + T_in + T_out when read — "funded at the venue" (rule 8a(f)); null when not. */
  venueMoneyMicro: bigint | null;
  /** Why the term is unread, for the operator line; null when read. */
  why: string | null;
}

export function livePerpTerm(a: {
  /** ONE /api/v1/account read of this account; null = the read failed. */
  account: PerpAccountRead | null;
  /** runPayoutStep().transit — T_in/T_out and the pending check at N; null = could not be established. */
  transit: InTransit | null;
}): LivePerpTerm {
  const unread = (why: string): LivePerpTerm => ({ book: "unread", valueMicro: null, venueMoneyMicro: null, why });
  const acct = a.account;
  if (acct === null) return unread("the Lighter account could not be read");
  if (!totalAssetValueConsistent(acct)) return unread("the Lighter account's parts do not add up to its total_asset_value");
  const t = a.transit;
  if (t === null) return unread("margin in transit could not be established (the payout step or the transfer ledger did not read)");
  if (t.gap) {
    return unread(
      t.why === "pending-exceeds-transit"
        ? "more is pending on the Lighter contract than any withdrawal the ledger knows is on its way"
        : "the pending balance on the Lighter contract could not be read",
    );
  }
  const inTransitMicro = t.tInMicro + t.tOutMicro;
  const book: PerpBookPart = {
    collateralMicro: acct.collateralMicro,
    isolatedMarginMicro: acct.isolatedMarginMicro,
    unrealizedMicro: acct.unrealizedMicro,
    unrealizedGainMicro: acct.unrealizedGainMicro,
    inTransitMicro,
    snapshotTime: acct.transactionTimeUs,
  };
  return {
    book,
    valueMicro: acct.collateralMicro + acct.isolatedMarginMicro + acct.unrealizedMicro + inTransitMicro,
    venueMoneyMicro: acct.collateralMicro + acct.isolatedMarginMicro + inTransitMicro,
    why: null,
  };
}

/**
 * The money AT the venue a book term says (C + ΣM + T), for canTradeForReal:
 * null for an unread term — never zero. (An agent with no perps has no term
 * at all and is not asked.)
 */
export function venueMoneyOf(book: Exclude<PerpBookTerm, undefined>): bigint | null {
  return book === "unread" ? null : book.collateralMicro + book.isolatedMarginMicro + book.inTransitMicro;
}
