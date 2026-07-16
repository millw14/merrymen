/**
 * The Merry Circle — read a holder's $MERRYMEN balance and resolve their tier.
 *
 * $MERRYMEN lives on Robinhood Chain mainnet (4663), so the balance is read
 * there regardless of which chain the agent trades on. Read-only: this only ever
 * calls balanceOf; the holder address is never a spend key. The tier lowers the
 * platform performance fee (worker/src/index.ts) and unlocks perks — utility,
 * not a return.
 */

import { createPublicClient, erc20Abi, http, type PublicClient } from "viem";
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
    const client: PublicClient = createPublicClient({
      chain: robinhoodChain,
      transport: http(rpcMainnet),
    });
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
