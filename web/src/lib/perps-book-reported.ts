/** Hosted: whether a Perps account's book has reached the shared database. Server-only. */
import type { Db } from "../../../worker/src/db";

/**
 * HAS THIS PERPS ACCOUNT'S WORKER REPORTED ITS BOOK: its `agents` row in the
 * shared database, which the worker writes when it arms and the ledger mirror
 * carries up (agent-perps.ts reads `agents.perps` from the same row).
 *
 * A PERPS OWNER COMMAND IS QUEUED ONLY ONTO A BOOK THAT HAS ONE. An
 * agent_commands row is ledger history (ledger-import.ts sharedLedgerHistory),
 * and hosted, the orchestrator starts a Perps worker for the first time only
 * on an account with none (registerLedgerSource's new-book branch, run for
 * the Perps worker's home too). A Close, a Close all or a practice reset
 * queued before that first start refused it on every pass after, and nothing
 * told the owner (orchestrator.ts reportFleetSource records no hold for a
 * Perps worker) or ever removed the row. Once the `agents` row is there it is
 * history itself, so a command queued beside it gives the start nothing new
 * to refuse on. Nothing deletes an `agents` row, so a row found here is still
 * there when the command is inserted.
 *
 * A read that fails throws; every caller refuses on that.
 */
export async function perpsBookReported(db: Pick<Db, "prepare">, account: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS one FROM agents WHERE LOWER(smart_account) = ? LIMIT 1").get(account.toLowerCase());
  return row !== undefined;
}

/** A Perps exit refused because the book has not reported (409, nothing queued). */
export const PERPS_EXIT_NOT_REPORTED =
  "Your Perps wallet has not reported its practice book yet, so there is no position here to close. Nothing was queued; try again once your Perps wallet shows its book.";

/** A Perps practice reset refused because the book has not reported (409, nothing queued). */
export const PERPS_RESET_NOT_REPORTED =
  "Your Perps wallet has not reported its practice book yet, so there is no book to reset. No practice reset was queued; try again once your Perps wallet shows its book.";
