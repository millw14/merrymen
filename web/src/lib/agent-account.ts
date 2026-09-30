/**
 * THE AGENT'S OWN ACCOUNT, AND WHICH CHAIN IT LIVES ON — for the standing.
 *
 * $MERRYMEN counts toward the Merry Circle tier and toward an agent's energy
 * wherever the owner keeps it: in their own wallet, or in the agent's account
 * (packages/core/src/energy.ts). The second half is new, and it is the half
 * every "send $MERRYMEN to my account" and "ask me to get my $MERRYMEN" relies
 * on: tokens bought or received land in `grant.smartAccount`, which no web
 * route used to read. /api/tier, /api/circle and /api/alpha all ask this
 * module for it, so the three cannot disagree about whose tokens count.
 *
 * THE CHAIN TRAVELS WITH THE ADDRESS. The account is only counted when the
 * grant is on Robinhood Chain (the chain $MERRYMEN lives on): a grant for any
 * other network has a counterfactual address there that the owner cannot
 * recover funds from through this app, so tokens sent to it must never be
 * reported as counting. Deciding that is the caller's (merrymen-standing.ts
 * countedAgent); this only reports what the grant says.
 *
 * NO MODE SWITCH HERE, for the reason agent-for.ts gives: `isHostedMode()` is
 * always false in a browser bundle and client-env.test.ts refuses it outside
 * app/api. The route, which is server-side, passes `hosted`.
 *
 * HOSTED, AN UNREADABLE GRANT STORE THROWS rather than answering "no agent".
 * "No agent" would drop the account out of the sum and render a holder who
 * keeps their tokens with their agent as short of them — the sentence that
 * sends somebody to buy what they already own. The routes turn a throw into
 * their `unreadable` answer.
 */
import { readFile } from "node:fs/promises";
import { homePaths } from "@merrymen/home";
import { getGrantStore } from "@merrymen/grant-store";
import { tenantOf } from "@/lib/auth";

export interface AgentAccount {
  address: `0x${string}`;
  chainId: number;
}

const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** The account and chain of a stored grant, or null for anything that is not one. */
export function accountOfGrant(g: unknown): AgentAccount | null {
  if (!g || typeof g !== "object") return null;
  const { smartAccount, chainId } = g as { smartAccount?: unknown; chainId?: unknown };
  if (!isAddr(smartAccount) || typeof chainId !== "number" || !Number.isInteger(chainId)) return null;
  return { address: smartAccount, chainId };
}

/**
 * The caller's agent account. Hosted: the signed-in tenant's grant — the caller
 * can never name somebody else's. Self-hosted: the grant on this disk, the one
 * agent this machine owns. Null when there is none.
 */
export async function agentAccountFor(req: Request, hosted: boolean): Promise<AgentAccount | null> {
  if (hosted) {
    const tenant = tenantOf(req);
    if (!tenant) return null;
    // Deliberately NOT caught — see the header.
    return accountOfGrant(await getGrantStore().get(tenant));
  }
  try {
    return accountOfGrant(JSON.parse(await readFile(homePaths.grant(), "utf8")));
  } catch {
    // No grant on disk is no agent, exactly as /api/grants answers it.
    return null;
  }
}
