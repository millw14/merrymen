import { createPublicClient, http } from "viem";
import { robinhoodChain, robinhoodTestnet, PONS_SELF_TRADE } from "@merrymen/core";

/** Only an explicitly selected, supported deployment may become a token spender. */
export async function verifiedAdapter(
  address: `0x${string}` | undefined,
  chainId: number,
  onStatus: (s: string) => void,
): Promise<`0x${string}` | undefined> {
  if (!address) return undefined;
  const chain = chainId === robinhoodTestnet.id ? robinhoodTestnet : chainId === robinhoodChain.id ? robinhoodChain : null;
  const supported = PONS_SELF_TRADE[chainId];
  if (!chain || !supported || address.toLowerCase() !== supported.toLowerCase()) {
    throw new Error(
      `The curve adapter ${address} is not a supported deployment on chain ${chainId}. ` +
        "Nothing was signed. Clear the curve adapter setting or select the supported deployment for this network.",
    );
  }

  onStatus("checking the supported curve adapter deployment…");
  const client = createPublicClient({ chain, transport: http() });
  try {
    if (await client.getChainId() !== chainId) {
      throw new Error("The RPC answered for a different network.");
    }
    const code = await client.getCode({ address });
    if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) {
      throw new Error("No readable contract code exists at the supported address.");
    }
  } catch (error) {
    throw new Error(
      `Could not check the curve adapter deployment on ${chain.name}: ${error instanceof Error ? error.message : String(error)} ` +
        "Nothing was signed. Try again when this network can be verified.",
    );
  }

  // Identity comes from the reviewed per-chain registry. An arbitrary contract
  // can mimic tradeExactIn or revert from fallback, so a deliberately invalid
  // call is not evidence of identity. No runtime hash is published for this
  // deployment; do not present a shape probe as bytecode verification.
  onStatus("supported curve adapter deployment checked.");
  return supported.toLowerCase() as `0x${string}`;
}
