/**
 * THIS AGENT'S ENERGY, AS ITS WORKER REPORTED IT — read, never computed.
 *
 * The worker is the one process that throttles, so it is the only one that
 * knows how many AI reviews and new trades it has let itself start today, and
 * whether it could read the $MERRYMEN balances it throttles on. It writes that
 * verdict to `agents.energy` (a JSON column, see packages/core/src/energy.ts
 * EnergyStatus) and this reads it back for /api/grants and /api/chat.
 *
 * A SECOND ANSWER COMPUTED HERE WOULD EVENTUALLY DISAGREE WITH THE FIRST. The
 * web service is a different container with a different clock, a different
 * RPC budget and no view of the child's counters; the same reasoning that
 * keeps `liveBlocker` and `gasSponsored` worker-reported keeps this one so.
 *
 * NULL IS "NOT SAID YET", NEVER "NOTHING". No row, no column (a ledger older
 * than the migration), a value that is not exactly the v1 shape, or any read
 * that throws — all of them are null, and every surface renders null as
 * "I can't see my energy", never as an empty allowance or a zero balance.
 * parseEnergyStatus is the whitelist: it never turns a null count into 0,
 * which is the number that sends somebody to buy tokens they already hold.
 *
 * Server-only: it opens the ledger.
 */
import { parseEnergyStatus, type EnergyStatus } from "@merrymen/core";
import type { Db } from "../../../worker/src/db";
import { withReadDb } from "./ledger";

/** The ledger seam, so a test can hand it a stub database. */
export type ReadDb = <T>(fn: (db: Db | null) => Promise<T>) => Promise<T>;

export async function readAgentEnergy(
  account: string | null | undefined,
  readDb: ReadDb = withReadDb,
): Promise<EnergyStatus | null> {
  if (!account) return null;
  try {
    const row = await readDb(async (db) =>
      db
        ? ((await db.prepare("SELECT energy FROM agents WHERE smart_account = ?").get(account)) as
            | { energy?: unknown }
            | undefined)
        : undefined,
    );
    // Absent row and NULL column are the same answer: the worker has not said.
    return parseEnergyStatus(row?.energy ?? null);
  } catch {
    // A missing column (a ledger from before the migration) or an unreadable
    // ledger is "we cannot see it", which is null — never a guess.
    return null;
  }
}
