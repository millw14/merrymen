import { isAddress, type Address } from "viem";

/**
 * Resolving the per-account CLASS VAULT at signing time.
 *
 * THE VAULT ADDRESS IS NOT A SETTING. Every other address the wall pins is a
 * deployment constant an operator types into /settings once — the Pons adapter,
 * the v4 adapter — and the same value is correct for every account. A class
 * vault is PER ACCOUNT: `PonsClassVaultFactory` salts CREATE2 with the owner, so
 * one vault belongs to one smart account and pinning the wrong one seals a grant
 * whose only class target reverts `NotOwner()` on every call.
 *
 * That is also why the caller cannot simply pass it in. On a fresh mint the
 * smart account does not exist until the signer derives it, several steps into
 * the flow — so the address is not knowable to whoever opened the page. The
 * signer resolves it here, from the account it just derived, and both signers
 * call THIS function so the phone and the dashboard cannot pin different vaults.
 *
 * The read is a `view` on the factory and works BEFORE the vault is deployed —
 * that is the entire reason the factory has `vaultFor`. Deployment is
 * permissionless and can happen any time before the first class trade.
 */

/**
 * `vaultFor` alone, and `deploy` deliberately elsewhere.
 *
 * This used to say "a signer never deploys anything", which was true of the
 * signer and became the wrong reason to keep the selector out of this file. The
 * WALL needs `deploy` to pin it as a permission and the WORKER needs it to
 * encode the call, so it lives in abis.ts with every other wall ABI — one
 * constant, both readers, no chance of the pinned selector and the encoded
 * selector disagreeing.
 *
 * What stays true is the split this file is for: `vaultFor` is a read a signer
 * makes, `deploy` is a write a session key makes, and they are used at different
 * moments by different code.
 */
export const PONS_CLASS_VAULT_FACTORY_ABI = [
  {
    type: "function",
    name: "vaultFor",
    stateMutability: "view",
    inputs: [{ name: "owner_", type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

/**
 * What a v2 factory answers that a v1 factory does not.
 *
 * A SEPARATE CONSTANT, and v1's above is not touched: its bytecode is frozen at
 * a deployed address and a vault minted from it may hold a position right now.
 *
 * WHY THIS HAS TO EXIST AT ALL. `vaultFor`, `deploy`, `buy`, `sell` and `sweep`
 * have IDENTICAL signatures in both versions, so they have identical selectors.
 * Nothing about a calldata dump, a simulation, an explorer or the wall itself
 * can tell a v1 vault from a v2 one. But they do not behave the same: v1 charges
 * every buy against ONE global ceiling whatever asset funded it, and v2 charges
 * against a ceiling keyed by that asset. Paste a v1 address where a v2 was meant
 * and a USDG trade still works — quietly, under a limit nobody chose — while a
 * non-USDG trade is refused by eight orders of magnitude.
 *
 * `FACTORY_VERSION` is therefore the only discriminator that exists, and the
 * shape it takes is not "answers 1" but "the call REVERTS": v1 declares no such
 * function and has no fallback.
 */
export const PONS_CLASS_VAULT_FACTORY_V2_ABI = [
  {
    type: "function",
    name: "vaultFor",
    stateMutability: "view",
    inputs: [{ name: "owner_", type: "address" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "FACTORY_VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "seedQuoteSet",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }, { type: "uint256[]" }],
  },
] as const;

/**
 * The narrowest slice of a viem PublicClient this needs.
 *
 * Typed structurally rather than as `PublicClient` so packages/core does not
 * take a position on which transport, chain or account type a caller built —
 * the phone and the dashboard construct theirs differently and both satisfy
 * this.
 */
export interface ClassVaultReader {
  readContract(parameters: {
    address: Address;
    abi: typeof PONS_CLASS_VAULT_FACTORY_ABI;
    functionName: "vaultFor";
    args: readonly [Address];
  }): Promise<Address>;
}

/**
 * The version probe's own reader, SEPARATE from the one above on purpose.
 *
 * A second call signature on `ClassVaultReader` would make it an overload set,
 * and viem's generic `readContract` stops inferring through an overload set —
 * so widening that interface silently breaks every caller that passes a real
 * PublicClient. Two narrow readers cost one extra type and keep both working.
 *
 * It returns `unknown` DELIBERATELY. These values come off an untrusted chain
 * read of an address a person pasted into a text box, and a declared return type
 * would be a promise the compiler cannot keep. They are validated below instead.
 */
export interface ClassFactoryReader {
  readContract(parameters: {
    address: Address;
    abi: typeof PONS_CLASS_VAULT_FACTORY_V2_ABI;
    functionName: "FACTORY_VERSION" | "seedQuoteSet";
  }): Promise<unknown>;
}

/** Which vault family a factory mints. Not a number to do arithmetic on. */
export type ClassVaultVersion = 1 | 2;

/**
 * Ask a factory which family it mints, and what its vaults are born holding.
 *
 * A REVERT IS AN ANSWER HERE, not an error, and getting that backwards is the
 * whole trap. v1 declares no `FACTORY_VERSION` and has no fallback function, so
 * the read reverts — which is exactly what a v1 factory looks like and must be
 * reported as version 1 rather than as a failure. An unreachable RPC looks the
 * same from here, which is why this is never the only gate: the caller still has
 * to read `vaultFor`, and a factory that answers neither fails there.
 */
export async function probeClassFactory(
  client: ClassFactoryReader,
  factory: Address,
): Promise<{ version: ClassVaultVersion; seedQuotes: readonly Address[]; seedCaps: readonly bigint[] }> {
  let answered: unknown;
  try {
    answered = await client.readContract({
      address: factory,
      abi: PONS_CLASS_VAULT_FACTORY_V2_ABI,
      functionName: "FACTORY_VERSION",
    });
  } catch {
    // No such function. That IS a v1 factory.
    return { version: 1, seedQuotes: [], seedCaps: [] };
  }
  // ANYTHING THAT IS NOT THE NUMBER 2 IS NOT A V2 FACTORY. A contract with a
  // fallback answers every call, so "it did not throw" is not the same as "it
  // said two" — and 2 is the only value this may ever be read as.
  if (Number(answered) !== 2) return { version: 1, seedQuotes: [], seedCaps: [] };

  try {
    const seed = await client.readContract({
      address: factory,
      abi: PONS_CLASS_VAULT_FACTORY_V2_ABI,
      functionName: "seedQuoteSet",
    });
    if (!Array.isArray(seed) || seed.length !== 2 || !Array.isArray(seed[0]) || !Array.isArray(seed[1])) {
      throw new Error("its seed did not decode as a pair of arrays");
    }
    const seedQuotes = seed[0] as readonly Address[];
    const seedCaps = (seed[1] as readonly unknown[]).map((c) => BigInt(c as string | number | bigint));
    if (seedQuotes.length !== seedCaps.length) throw new Error("its seed lists and caps are different lengths");
    return { version: 2, seedQuotes, seedCaps };
  } catch (e) {
    // A contract that says it is version 2 and cannot say what it seeds is not
    // something to guess about. The caps it mints are the ones that bind the
    // owner's first trade, and there is no second transaction to fix them in.
    throw new Error(
      `the factory at ${factory} reports version 2 but would not say what it seeds ` +
        `(${e instanceof Error ? e.message : String(e)}). Its seed caps are what every vault it ` +
        `makes is born with, so this grant is not signed at all.`,
    );
  }
}

/**
 * The vault address to seal into this grant, or a throw.
 *
 * IT THROWS RATHER THAN RETURNING NULL, and that is the whole design of this
 * function. Reaching it means the owner asked for the class permission — they
 * passed a factory address. Three outcomes are possible and only one of them is
 * a grant:
 *
 *   - the factory answers      → pin that address, mint the marker
 *   - the RPC does not answer  → THROW. Silently dropping the permission would
 *     hand back a grant that looks signed, carries no class capability, and
 *     tells the owner nothing — the "unreadable became absent" failure this
 *     repo refuses everywhere else. Re-signing is cheap; a wall that quietly
 *     omits what was asked for is not.
 *   - the factory answers zero → THROW. `address(0)` is what a call to a
 *     contract that isn't there decodes to on some transports, so treating it
 *     as an address would pin the wall's class target at nothing.
 *
 * The caller decides whether to ask at all. Passing no factory means no class
 * permission and no marker, which is the ordinary grant and needs no read.
 */
export async function resolveClassVault(
  client: ClassVaultReader,
  factory: Address,
  smartAccount: Address,
): Promise<Address> {
  if (!isAddress(factory)) {
    throw new Error(
      `refusing to seal a class permission: "${factory}" is not a class-vault factory address.`,
    );
  }

  let vault: Address;
  try {
    vault = await client.readContract({
      address: factory,
      abi: PONS_CLASS_VAULT_FACTORY_ABI,
      functionName: "vaultFor",
      args: [smartAccount],
    });
  } catch (e) {
    throw new Error(
      `refusing to seal a class permission: the class-vault factory at ${factory} could not be ` +
        `read (${e instanceof Error ? e.message : String(e)}). The wall would have to pin a vault ` +
        `address nothing confirmed, so this grant is not signed at all. Try again, or sign ` +
        `without the class route.`,
    );
  }

  if (!isAddress(vault) || /^0x0{40}$/i.test(vault)) {
    throw new Error(
      `refusing to seal a class permission: the factory at ${factory} answered ${vault} for this ` +
        `account, which is not a vault. That is what a call to a contract that isn't deployed ` +
        `looks like — check the factory address for this chain.`,
    );
  }

  return vault.toLowerCase() as Address;
}
