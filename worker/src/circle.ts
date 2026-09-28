/**
 * The Merry Circle — read a holder's $MERRYMEN balance and resolve their tier.
 *
 * $MERRYMEN lives on Robinhood Chain mainnet (4663), so the balance is read
 * there regardless of which chain the agent trades on. Read-only: this only ever
 * calls balanceOf; neither address is ever a spend key. The balance that counts
 * is the owner's holder wallet PLUS the agent's own account (core energy.ts,
 * D1), for both the tier and energy. The tier lowers the platform performance
 * fee (worker/src/index.ts) and unlocks perks; energy is the agent's daily
 * capacity — utility, not a return.
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
  | { ok: true; status: HolderStatus; parts: HolderParts }
  /** A chain read would not answer. Says nothing whatever about the wallet. */
  | { ok: false; status: HolderStatus; parts: HolderParts };

/**
 * What each counted address held, as read — for the energy gate, which may
 * act on a lower bound where the tier may not.
 *
 * A bigint was read; `null` is a read that FAILED; `undefined` is no such
 * address (no wallet configured, no account passed, or the account IS the
 * holder wallet and was counted once, under `holder`).
 */
export interface HolderParts {
  holder: bigint | null | undefined;
  account: bigint | null | undefined;
}

/**
 * THE COMBINED BALANCE: the owner's holder wallet PLUS the agent's own
 * account, which is where $MERRYMEN an agent buys or is sent lands.
 *
 * `account` is passed only when it counts — the caller passes the smart
 * account only for a Robinhood Chain (4663) grant, because an account on any
 * other network has a different history at the same address here, and tokens
 * sent to it there would not be this agent's. When it equals the holder wallet
 * it is read and counted ONCE.
 *
 * ONE CLIENT, ONE METERED TRANSPORT (stop-the-loop.test.ts counts them), up to
 * two balanceOf calls through it — chainRead batches them into one request.
 *
 * `ok` ONLY WHEN EVERY PRESENT ADDRESS ANSWERED. The tier is a fee and a
 * permission, and a sum with a missing term is not a balance: a failed half
 * keeps the last known-good tier exactly as a failed whole did. `parts` says
 * which half failed, so the energy gate can still use the half that answered
 * as a lower bound.
 */
export async function readHolderStatusResult(
  rpcMainnet: string | undefined,
  holderAddress: `0x${string}` | undefined,
  account?: `0x${string}`,
  /**
   * PIN BOTH READS TO ONE BLOCK, no earlier than `atLeastBlock` — for the
   * energy BUY, which sizes a spend from this answer. Both halves are read at
   * max(this node's head, atLeastBlock): one block, so the sum is a balance at
   * one moment; and never before the block the last energy purchase landed
   * in, so a load-balanced node still behind that block answers with an ERROR
   * (unread, and the buy refuses) rather than a stale balance the buy would
   * then top up a second time. Absent — the tick's read — nothing changes.
   */
  pin?: { atLeastBlock: bigint },
): Promise<HolderRead> {
  const holder = holderAddress ? (holderAddress.toLowerCase() as `0x${string}`) : undefined;
  const acct =
    account && account.toLowerCase() !== holder ? (account.toLowerCase() as `0x${string}`) : undefined;
  // No address configured is a real, knowable answer: there is no wallet to
  // hold anything, so the outsider floor is the truth rather than a fallback.
  if (!holder && !acct) return { ok: true, status: OUTSIDER, parts: { holder: undefined, account: undefined } };
  let read: (a: `0x${string}`) => Promise<bigint>;
  try {
    const client: PublicClient = createPublicClient({
      chain: robinhoodChain,
      transport: chainRead(rpcMainnet),
    });
    // The pinned block, asked of the same client: a head read that fails is a
    // read that failed, and every present half is then unread.
    const blockNumber = pin
      ? await client.getBlockNumber().then((head) => (head > pin.atLeastBlock ? head : pin.atLeastBlock))
      : undefined;
    read = async (a) =>
      (await client.readContract({
        address: MERRYMEN_TOKEN.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [a],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      })) as bigint;
  } catch {
    return {
      ok: false,
      status: OUTSIDER,
      parts: { holder: holder ? null : undefined, account: acct ? null : undefined },
    };
  }
  const [h, a] = await Promise.allSettled([
    holder ? read(holder) : Promise.resolve(undefined),
    acct ? read(acct) : Promise.resolve(undefined),
  ]);
  const part = (r: PromiseSettledResult<bigint | undefined>, present: boolean): bigint | null | undefined =>
    !present ? undefined : r.status === "fulfilled" && typeof r.value === "bigint" ? r.value : null;
  const parts: HolderParts = { holder: part(h, !!holder), account: part(a, !!acct) };
  if (parts.holder === null || parts.account === null) return { ok: false, status: OUTSIDER, parts };
  const raw = (parts.holder ?? 0n) + (parts.account ?? 0n);
  return { ok: true, status: { tier: tierForBalance(raw), rawBalance: raw }, parts };
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
