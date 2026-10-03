import { parseAbi, type Address, type PublicClient } from "viem";
import { robinhoodChain, UNISWAP } from "@merrymen/core";

const POOL_MANAGER_ABI = parseAbi(["function poolManager() view returns (address)"]);
const readableCode = (code: unknown): code is `0x${string}` =>
  typeof code === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(code);

/**
 * Check the selected v4 route before a grant can be signed or replaced.
 *
 * The owner still chooses the adapter. This is an availability and network
 * check, not proof that an arbitrary contract implements the reviewed adapter:
 * a getter alone cannot establish what its swap function does.
 */
export async function assertV4Deployment(
  client: PublicClient,
  address: Address | undefined,
  chainId: number,
  onStatus: (message: string) => void,
): Promise<void> {
  if (!address) return;
  if (chainId !== robinhoodChain.id) {
    throw new Error(
      `Uniswap v4 is not available on chain ${chainId}. Nothing was signed. ` +
      "Clear the v4 adapter setting or select its deployed network before renewing permission.",
    );
  }
  if (!/^0x[0-9a-f]{40}$/i.test(address)) {
    throw new Error("The v4 adapter is not a valid contract address. Nothing was signed.");
  }

  onStatus("checking your Uniswap v4 adapter deployment…");
  try {
    if (await client.getChainId() !== chainId) {
      throw new Error("The RPC answered for a different network.");
    }
    if (!readableCode(await client.getCode({ address }))) {
      throw new Error("No readable contract code exists at your v4 adapter address.");
    }
    const manager = await client.readContract({ address, abi: POOL_MANAGER_ABI, functionName: "poolManager" });
    if (manager.toLowerCase() !== UNISWAP.v4PoolManager.toLowerCase()) {
      throw new Error("Your v4 adapter uses a different PoolManager from this network's trading route.");
    }
    if (!readableCode(await client.getCode({ address: manager }))) {
      throw new Error("The v4 PoolManager has no readable contract code on this network.");
    }
  } catch (error) {
    throw new Error(
      `Could not check Uniswap v4 on ${robinhoodChain.name}: ${error instanceof Error ? error.message : String(error)} ` +
      "Nothing was signed. Check the v4 adapter setting and retry when this network can be verified.",
    );
  }
  onStatus("Uniswap v4 adapter deployment checked.");
}
