/**
 * WHICH AGENT a request may read or act for.
 *
 * THE TENANT IS NOT THE AGENT. `tenantOf` returns the signed-in wallet address;
 * `agent_id` throughout this ledger is the ERC-4337 SMART ACCOUNT, because
 * `ensureAgent` returns `grant.smartAccount` and the worker claims against that.
 *
 * WHY THIS MODULE EXISTS. Three routes needed the same answer and two of them
 * computed it a way that cannot work hosted:
 *
 *     SELECT smart_account FROM agents WHERE LOWER(owner_address) = <tenant>
 *
 * `agents.owner_address` is written from `grant.owner` (worker/src/store.ts),
 * and hosted, `grant.owner` is the owner key the BROWSER generated — it is never
 * the tenant, and `api/grants/route.ts` documents that requiring them to match
 * rejected every hosted grant ever submitted. So that comparison matched zero
 * rows for every hosted user, and the feed and scoreboard failed CLOSED: an
 * empty tape and an empty board, indistinguishable from a quiet agent. Balances
 * still rendered, because those are read from the chain directly — which is
 * exactly why it looked like a working dashboard.
 *
 * The grant store is the real tenant→account index: `tenant` is its primary key
 * and the account is the value. It is also the only one that stays correct when
 * the owner key stops being browser-generated, which is why this is worth
 * sharing rather than fixing twice.
 *
 * NO MODE SWITCH HERE. This module lives under web/src/lib, which
 * client-env.test.ts scans: `isHostedMode()` reads process.env and Next never
 * inlines that into the browser bundle, so it is always false there. The two
 * resolvers are exported separately and each route — which IS server-side —
 * picks the one its deployment needs.
 *
 * ONE ACCOUNT, NOT A HISTORY. The store holds one grant per tenant, so this
 * returns the CURRENT account. A tenant who re-granted has older accounts with
 * rows still in the ledger; they are not reachable here and are not meant to be
 * — mixing two accounts' books is the bug the epoch filter exists to prevent.
 */
import { grantPurpose, type GrantPurpose } from "@merrymen/core";
import { readFile } from "node:fs/promises";
import { homePaths } from "@merrymen/home";
import { getGrantStore } from "@merrymen/grant-store";
import { tenantOf } from "@/lib/auth";

/**
 * The signed-in tenant's smart account, or null when there is no session or no
 * grant. HOSTED ONLY — the caller cannot name the agent, so one tenant can never
 * read (or spend the gas of) another's.
 */
export async function hostedAgentFor(req: Request, purpose: GrantPurpose = "spot"): Promise<`0x${string}` | null> {
  const tenant = tenantOf(req);
  if (!tenant) return null;
  try {
    const grant = await getGrantStore(purpose).get(tenant);
    return (grant?.smartAccount as `0x${string}`) ?? null;
  } catch {
    // An unreadable store is "we cannot tell", and the honest render of that is
    // an empty panel — never someone else's rows.
    return null;
  }
}

/**
 * The account of whichever grant is on disk. SELF-HOSTED ONLY: there is no auth
 * there, the localhost middleware is the perimeter, and the machine owns exactly
 * one agent.
 */
export async function diskAgent(purpose: GrantPurpose = "spot"): Promise<`0x${string}` | null> {
  try {
    const g = JSON.parse(await readFile(homePaths.grant(purpose), "utf8")) as { smartAccount?: string; purpose?: unknown };
    if (grantPurpose(g) !== purpose) return null;
    return (g.smartAccount as `0x${string}`) ?? null;
  } catch {
    return null;
  }
}

