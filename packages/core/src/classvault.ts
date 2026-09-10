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
