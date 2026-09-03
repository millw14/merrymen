/**
 * The Merry Circle — read a holder's $MERRYMEN balance and resolve their tier.
 *
 * $MERRYMEN lives on Robinhood Chain mainnet (4663), so the balance is read
 * there regardless of which chain the agent trades on. Read-only: this only ever
 * calls balanceOf; the holder address is never a spend key. The tier lowers the
 * platform performance fee (worker/src/index.ts) and unlocks perks — utility,
 * not a return.
 */

import { createPublicClient, erc20Abi, type PublicClient } from "viem";
import { countedHttp } from "./rpc-meter";
import {
  CIRCLE_TIERS,
  MERRYMEN_TOKEN,
  robinhoodChain,
  tierForBalance,
  type CircleTier,
} from "../../packages/core/src/index";

export interface HolderStatus {
  tier: CircleTier;
  rawBalance: bigint;
}

const OUTSIDER: HolderStatus = { tier: CIRCLE_TIERS[0]!, rawBalance: 0n };

/**
 * ONE CLIENT, NOT ONE PER TICK.
 *
 * This built a fresh createPublicClient AND a fresh transport inside
 * readHolderStatus's body, and readHolderStatus runs once per tick from the fee
 * path — so every tick got a brand-new undici connection pool and never reused a
 * socket.
 *
 * MEASURED COST, 2026-09-03, against this endpoint: the first second of requests
 * on a cold pool averaged 743ms; once keep-alive was warm the same requests
 * averaged 293-298ms. A 2.5x penalty, paid every tick, on a call whose answer
 * changes when somebody moves tokens.
 *
 * Keyed on the URL so a connection-settings change still takes effect — the same
 * shape as snapshot.ts's setMainnetRpc, and the reason this is a cache rather
 * than a module constant. The chain is always 4663 (see the header), so the URL
 * is the whole key.
 *
 * NOT keyed on the holder address: the address is an argument to balanceOf, not
 * a property of the connection, and keying on it would rebuild the pool for
 * every owner and reintroduce exactly the cost this removes.
 */
let cached: { url: string | undefined; client: PublicClient } | null = null;

function clientFor(rpcMainnet: string | undefined): PublicClient {
  if (cached && cached.url === rpcMainnet) return cached.client;
  const client: PublicClient = createPublicClient({
    chain: robinhoodChain,
    transport: countedHttp(rpcMainnet, "read", robinhoodChain.id),
  });
  cached = { url: rpcMainnet, client };
  return client;
}

/** Test seam: forget the cached client so a test can change the URL. */
export function resetCircleClientForTest(): void {
  cached = null;
}

/**
 * Resolve the Circle tier for a holder wallet. No address → the outsider floor.
 * Any read failure fails closed to the outsider (never blocks a tick; never
 * grants a discount it can't verify).
 */
export async function readHolderStatus(
  rpcMainnet: string | undefined,
  holderAddress: `0x${string}` | undefined,
): Promise<HolderStatus> {
  if (!holderAddress) return OUTSIDER;
  try {
    const client = clientFor(rpcMainnet);
    const raw = (await client.readContract({
      address: MERRYMEN_TOKEN.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holderAddress],
    })) as bigint;
    return { tier: tierForBalance(raw), rawBalance: raw };
  } catch {
    return OUTSIDER;
  }
}
