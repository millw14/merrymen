/** Public search's agent rows: identity fields only; no book, trade or settings read. */
import { tablePresent, type Db } from "../../../worker/src/db";

/** How many of the newest agents a search looks through. */
export const AGENT_SEARCH_WINDOW = 200;

export interface AgentSearchRow {
  smart_account: string;
  name: string;
  x_handle: string | null;
  mode: string;
}

/**
 * THE NEWEST LIVE OR PAPER AGENTS THAT COULD EVER BE A HIT, newest first.
 *
 * A PERPS WALLET NEVER IS ONE: it has no public slug (D2). So it is left out
 * BEFORE the window, as the directory leaves it out before it ranks
 * (agent-directory.ts). Every hosted Perps worker writes its own `agents` row,
 * newer than most Spot agents. Dropped only after the LIMIT, those rows took
 * the places an older Spot agent needed, and search never found it.
 *
 * The catalogue is asked first (perps-wallets.ts), so a fleet that has never
 * had a Perps wallet sends no failing statement. A table that is there and
 * cannot be read throws: the caller answers no agent hits rather than risk one.
 */
export async function readAgentSearchWindow(db: Pick<Db, "prepare">): Promise<AgentSearchRow[]> {
  const notPerps = (await tablePresent(db, "perps_wallets"))
    ? " AND LOWER(smart_account) NOT IN (SELECT smart_account FROM perps_wallets)"
    : "";
  return (await db
    .prepare(
      `SELECT smart_account, name, x_handle, COALESCE(mode, 'idle') AS mode
         FROM agents
        WHERE mode IN ('live','paper') AND smart_account NOT LIKE 'rh:%'${notPerps}
        ORDER BY created_at DESC LIMIT ${AGENT_SEARCH_WINDOW}`,
    )
    .all()) as AgentSearchRow[];
}
