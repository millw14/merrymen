/**
 * "GASLESS: EVERY TRADE SPONSORED" — a claim a profile makes only once it is
 * measured.
 *
 * Sponsorship spends house money and is off by design, so gasless is never a
 * default and never a promise. A sponsored agent's page used to say "Net of
 * $0.00 in priced gas", which is true and reads like a rounding error; the
 * accurate sentence is that somebody else paid, and it may be printed only when
 * the ledger shows that for EVERY landed operation of the period. One self-paid
 * op ends the claim, and a period with nothing landed has nothing to claim.
 *
 * "Sponsored" is the rule gas-audit.ts already uses: `sponsored_gas_wei` is set
 * and not empty. That column is what the EntryPoint charged the sponsor, kept
 * apart from `gas_wei`, which is what the owner spent.
 *
 * Operations, not rows (distinct-trades.ts): a redeploy's re-recorded copy of a
 * sponsored op carries no gas at all, and read as its own row it would end the
 * claim with a fill that never happened twice.
 */
import type { Db } from "../../../worker/src/db";
import { distinctTrades } from "./distinct-trades";

/** THROWS on a failed read; the caller's answer to "unread" is "no claim". */
export async function everyLandedOpSponsored(db: Db, account: string, epoch: number): Promise<boolean> {
  const row = (await db
    .prepare(
      `SELECT COUNT(*) AS landed,
              COALESCE(SUM(CASE WHEN t.sponsored_gas_wei IS NULL OR t.sponsored_gas_wei = '' THEN 1 ELSE 0 END), 0) AS self_paid
         FROM ${distinctTrades("t.agent_id = ? AND t.epoch = ?")}
        WHERE t.status = 'landed'`,
    )
    .get(account, epoch)) as { landed: number | null; self_paid: number | null } | undefined;
  const landed = Number(row?.landed ?? 0);
  const selfPaid = Number(row?.self_paid ?? 0);
  return Number.isFinite(landed) && landed > 0 && selfPaid === 0;
}
