"use client";

/**
 * WHAT IS IN THIS ACCOUNT — answered from an address, with no key and no login.
 *
 * WHY IT EXISTS. `planRecovery` has always been signer-independent: it needs the
 * owner's ADDRESS to rebuild the Kernel account and read it, and nothing more.
 * `ownerFromAddress` was written to say exactly that and was exposed nowhere, so
 * the only way to see what an agent held was to hold something that could spend
 * it. People locked out of an agent were being asked for a private key to answer
 * a question that needs no key at all.
 *
 * IT TRIES BOTH READINGS, and that is the whole point rather than a convenience.
 * There are three different addresses in this system and they are easy to
 * confuse:
 *
 *   the TENANT   — the wallet you signed in with. Identity, never custody.
 *   the OWNER    — the key that controls the account. In a legacy wallet this
 *                  was GENERATED IN THE BROWSER and shown once as the recovery
 *                  key; it is NOT the wallet you signed in with.
 *   the ACCOUNT  — the ERC-4337 smart account that actually holds the money.
 *
 * Someone who pastes their MetaMask address into an "owner" field gets a
 * derived account that was never created, reads zero, and concludes their funds
 * are gone. So this reads the address BOTH ways — as an owner, and as an account
 * — and reports what each one found. The caller can then say which of the three
 * the person is holding instead of making them guess.
 *
 * RUNS IN THE BROWSER. The chain's RPC answers browsers directly, so there is no
 * server route to rate-limit or turn into an RPC proxy, and the lookup keeps
 * working when nobody is signed in — which is the case it exists for.
 *
 * READ-ONLY BY CONSTRUCTION. `ownerFromAddress` builds an account whose signing
 * methods throw, so nothing reachable from here can authorise a transfer even if
 * a later caller asked it to.
 */

import { createPublicClient, erc20Abi, formatUnits, http, type Address, type Chain } from "viem";
import { robinhoodChain, robinhoodTestnet } from "@merrymen/core";
import { classifyBalance, ownerFromAddress, planRecovery, sweepList } from "@merrymen/recover";

export interface Holding {
  symbol: string;
  address: Address;
  raw: bigint;
  decimals: number;
  /** Human-readable, for display only. */
  amount: string;
}

export interface Reading {
  address: Address;
  /**
   * Does code exist at this address?
   *
   * Load-bearing for the message, not decoration. An undeployed account that
   * reads zero has never been used; a DEPLOYED account that reads zero has been
   * emptied. Telling those apart is the difference between "this is the wrong
   * address" and "your funds have already moved".
   *
   * Null means the probe itself failed — which is neither of the above.
   */
  deployed: boolean | null;
  /** Native balance, or null when it could not be read. */
  nativeWei: bigint | null;
  holdings: Holding[];
  /**
   * What could not be READ, as distinct from what is not held. A lookup that
   * reports an empty account because an RPC blinked is how someone concludes
   * their money is gone.
   */
  unreadable: string[];
}

export interface Lookup {
  input: Address;
  chainId: number;
  /** The address read AS AN OWNER: the account it derives, and what that holds. */
  asOwner: { derived: Address; reading: Reading; classVault: Address | null; classHoldings: Holding[] } | null;
  /** Why the owner reading is absent, when it is. */
  ownerError: string | null;
  /** The address read AS AN ACCOUNT, directly. */
  asAccount: Reading | null;
  accountError: string | null;
}

export const CHAINS: Record<number, Chain> = {
  [robinhoodChain.id]: robinhoodChain,
  [robinhoodTestnet.id]: robinhoodTestnet,
};

const clientFor = (chain: Chain) => createPublicClient({ chain, transport: http() });

const shortReason = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  // viem puts the whole request URL in metaMessages; keep the first line only.
  return m.split("\n")[0]!.slice(0, 160);
};

/** Read one address directly — no derivation, no assumptions about what it is. */
export async function readAddress(chain: Chain, address: Address): Promise<Reading> {
  const client = clientFor(chain);
  const tokens = sweepList();
  const unreadable: string[] = [];

  const deployed = await client
    .getCode({ address })
    .then((code) => code !== undefined && code !== "0x")
    .catch(() => null);

  const nativeWei = await client
    .getBalance({ address })
    .catch(() => {
      unreadable.push("native balance");
      return null;
    });

  const raws = await Promise.all(
    tokens.map(async (t) => {
      // The engine's own three-way split: read, genuinely absent, or unknown.
      // Collapsing the last two is what turns "we could not ask" into "empty".
      const outcome = await classifyBalance({
        balanceOf: () =>
          client.readContract({
            address: t.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          }) as Promise<bigint>,
        getCode: () => client.getCode({ address: t.address }),
      });
      if (outcome.kind === "read") return outcome.raw;
      if (outcome.kind === "absent") return 0n;
      unreadable.push(t.symbol);
      return null;
    }),
  );

  const holdings: Holding[] = [];
  tokens.forEach((t, i) => {
    const raw = raws[i];
    if (raw === null || raw === undefined || raw <= 0n) return;
    holdings.push({ symbol: t.symbol, address: t.address, raw, decimals: t.decimals, amount: formatUnits(raw, t.decimals) });
  });

  return { address, deployed, nativeWei, holdings, unreadable };
}

export type OwnerReading = NonNullable<Lookup["asOwner"]>;

/**
 * Read the address AS AN OWNER: derive its account and read that.
 *
 * MUCH SLOWER THAN THE DIRECT READ, and separated from it for exactly that
 * reason. `planRecovery` also looks for a class vault, which means scanning a
 * very large block range for the log that names it — measured at roughly thirty
 * seconds against chain 4663. Awaiting both halves together made the whole page
 * wait on this one, so somebody who pasted their account address sat in front of
 * "reading the chain…" for half a minute before seeing a balance that had been
 * available in two seconds.
 */
export async function readAsOwner(chain: Chain, address: Address): Promise<OwnerReading> {
  const plan = await planRecovery({ chain, owner: ownerFromAddress(address) });
  const deployed = await clientFor(chain)
    .getCode({ address: plan.smartAccount })
    .then((code) => code !== undefined && code !== "0x")
    .catch(() => null);
  return {
    derived: plan.smartAccount,
    reading: {
      address: plan.smartAccount,
      deployed,
      nativeWei: plan.gasWei,
      holdings: plan.balances.map((b) => ({
        symbol: b.symbol,
        address: b.address,
        raw: b.raw,
        decimals: b.decimals,
        amount: b.amount,
      })),
      unreadable: plan.unreadable,
    } satisfies Reading,
    classVault: plan.classVault ?? null,
    classHoldings: plan.classHoldings.map((h) => ({
      symbol: h.symbol,
      address: h.token,
      raw: h.raw,
      decimals: h.decimals,
      amount: h.amount,
    })),
  };
}

/** The chain for an id, or a refusal naming it. */
export function chainFor(chainId: number): Chain {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`unknown chain ${chainId}`);
  return chain;
}

/**
 * Both readings of one address. Neither failure hides the other.
 *
 * The UI drives the two halves separately so the fast one can render first;
 * this composes them for callers that just want the finished answer.
 */
export async function lookupAddress(address: Address, chainId: number): Promise<Lookup> {
  const chain = chainFor(chainId);

  // Settled, not all: an owner derivation that fails on a flaky RPC must not
  // cost the person the direct reading, which is often the one they wanted.
  const [owner, account] = await Promise.allSettled([
    readAsOwner(chain, address),
    readAddress(chain, address),
  ]);

  return {
    input: address,
    chainId,
    asOwner: owner.status === "fulfilled" ? owner.value : null,
    ownerError: owner.status === "rejected" ? shortReason(owner.reason) : null,
    asAccount: account.status === "fulfilled" ? account.value : null,
    accountError: account.status === "rejected" ? shortReason(account.reason) : null,
  };
}

/** Does a reading show anything at all? */
export const hasValue = (r: Reading | null | undefined): boolean =>
  !!r && (r.holdings.length > 0 || (r.nativeWei !== null && r.nativeWei > 0n));

export type Verdict =
  | { kind: "owner"; }
  | { kind: "account" }
  | { kind: "both" }
  | { kind: "empty-deployed" }
  | { kind: "nothing" }
  | { kind: "unreadable" };

/**
 * What the two readings mean, together.
 *
 * Kept separate from the rendering and from the fetching so the sentence a
 * locked-out person reads is decided by a pure function with tests on it,
 * rather than by whichever branch of some JSX happened to match.
 */
export function verdictOf(l: Lookup): Verdict {
  const ownerReading = l.asOwner?.reading ?? null;
  const ownerHas = hasValue(ownerReading) || (l.asOwner?.classHoldings.length ?? 0) > 0;
  const accountHas = hasValue(l.asAccount);

  if (ownerHas && accountHas) return { kind: "both" };
  if (ownerHas) return { kind: "owner" };
  if (accountHas) return { kind: "account" };

  // Nothing found. Say WHY nothing, which is three different situations.
  const couldNotRead =
    (l.ownerError !== null && l.accountError !== null) ||
    (ownerReading?.unreadable.length ?? 0) > 0 ||
    (l.asAccount?.unreadable.length ?? 0) > 0;
  if (couldNotRead) return { kind: "unreadable" };

  // A deployed-but-empty account has been used and emptied — very different
  // from an address that never had an agent behind it.
  if (l.asAccount?.deployed === true || ownerReading?.deployed === true) {
    return { kind: "empty-deployed" };
  }
  return { kind: "nothing" };
}
