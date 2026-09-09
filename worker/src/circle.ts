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
import { chainRead } from "./rpc-meter";
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
 * Resolve the Circle tier for a holder wallet.
 *
 * NO ADDRESS AND NO ANSWER ARE DIFFERENT FACTS, and collapsing them cost money.
 *
 * This returned OUTSIDER for both, which reads as "you hold nothing". Two
 * things then happened on the SAME tick, on a fleet whose mainnet reads are
 * routinely refused — one egress IP, `retryCount: 0`, a shared breaker:
 *
 *   the owner was told "no $MERRYMEN at your holder wallet; standard platform
 *   fee applies", a confident statement about a wallet nobody had managed to
 *   read; and
 *
 *   `effectivePerfFeeBps` took the outsider rate, so if that tick also set a
 *   new high-water mark the UNDISCOUNTED performance fee was accrued to the
 *   ledger — permanently, on a holder who had paid for the discount.
 *
 * A read failure is now its own arm. Failing closed is still right for a
 * PERMISSION — nothing here grants a discount it cannot verify — but the
 * caller has to be able to tell the two apart before it charges anybody or
 * says anything about their wallet, which is the same three-way distinction
 * /api/alpha spells out: "you are not signed in", "your wallet does not hold
 * enough" and "we could not read your balance" are three facts with three
 * remedies, and only one of them is about the reader.
 */
export type HolderRead =
  | { ok: true; status: HolderStatus }
  /** The chain would not answer. Says nothing whatever about the wallet. */
  | { ok: false; status: HolderStatus };

export async function readHolderStatusResult(
  rpcMainnet: string | undefined,
  holderAddress: `0x${string}` | undefined,
): Promise<HolderRead> {
  // No address configured is a real, knowable answer: there is no wallet to
  // hold anything, so the outsider floor is the truth rather than a fallback.
  if (!holderAddress) return { ok: true, status: OUTSIDER };
  try {
    const client: PublicClient = createPublicClient({
      chain: robinhoodChain,
      transport: chainRead(rpcMainnet),
    });
    const raw = (await client.readContract({
      address: MERRYMEN_TOKEN.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holderAddress],
    })) as bigint;
    return { ok: true, status: { tier: tierForBalance(raw), rawBalance: raw } };
  } catch {
    return { ok: false, status: OUTSIDER };
  }
}

/**
 * The old shape, kept for callers that genuinely only want a floor.
 *
 * Anything that CHARGES or makes a claim about the owner's wallet must use
 * `readHolderStatusResult` instead — this one cannot tell you whether the
 * answer was read or assumed.
 */
export async function readHolderStatus(
  rpcMainnet: string | undefined,
  holderAddress: `0x${string}` | undefined,
): Promise<HolderStatus> {
  // ONE READ, ONE TRANSPORT. Delegating rather than repeating the call keeps a
  // single metered client in this file — stop-the-loop.test.ts counts them, and
  // it was right to: two copies of a chain read are two places for one to stop
  // going through the meter.
  return (await readHolderStatusResult(rpcMainnet, holderAddress)).status;
}
