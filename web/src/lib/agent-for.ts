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
 *
 * ONE WALLET, NAMED BY THE CALLER. A login has two (Spot and Perps, grant.ts
 * GrantPurpose), each its own account, grant and book. Both resolvers take the
 * wallet with no default, as the stores and `purposeHome` do, so a route says
 * which it means; a default of Spot is how the perps branch's reads came to
 * miss the Perps wallet. And a grant that names the other wallet answers null:
 * one wallet's question is never answered with the other's account.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { grantPurpose, isGrantPurpose, type GrantPurpose } from "@merrymen/core";
import { purposeHome } from "@merrymen/home";
import { getGrantStore } from "@merrymen/grant-store";
import { tenantOf } from "@/lib/auth";

/**
 * The signed-in tenant's smart account in `wallet`, or null when there is no
 * session or no grant. HOSTED ONLY — the caller cannot name the agent, so one
 * tenant can never read (or spend the gas of) another's.
 */
export async function hostedAgentFor(req: Request, wallet: GrantPurpose): Promise<`0x${string}` | null> {
  if (!isGrantPurpose(wallet)) throw new Error("Unrecognised wallet purpose");
  const tenant = tenantOf(req);
  if (!tenant) return null;
  try {
    const grant = await getGrantStore(wallet).get(tenant);
    if (!grant || grantPurpose(grant) !== wallet) return null;
    return (grant.smartAccount as `0x${string}`) ?? null;
  } catch {
    // An unreadable store is "we cannot tell", and the honest render of that is
    // an empty panel — never someone else's rows.
    return null;
  }
}

/**
 * The account of whichever grant is on disk in `wallet`'s home (`purposeHome`:
 * Spot's grant.json where it has always been, Perps's under accounts/perps).
 * SELF-HOSTED ONLY: there is no auth there, the localhost middleware is the
 * perimeter, and the machine owns exactly one agent per wallet.
 */
export async function diskAgent(wallet: GrantPurpose): Promise<`0x${string}` | null> {
  // Outside the try: an unnamed wallet is the caller's bug, not an empty disk.
  const file = path.join(purposeHome(wallet), "grant.json");
  try {
    const g = JSON.parse(await readFile(file, "utf8")) as { smartAccount?: string; purpose?: unknown };
    if (grantPurpose(g) !== wallet) return null;
    return (g.smartAccount as `0x${string}`) ?? null;
  } catch {
    return null;
  }
}

