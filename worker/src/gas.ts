/**
 * UserOperation gas-price estimation that works with ANY bundler.
 *
 * ZeroDev's createKernelAccountClient, when handed no `userOperation.estimateFeesPerGas`,
 * installs a default that calls the ZeroDev-ONLY RPC method `zd_getUserOperationGasPrice`.
 * Pimlico (merrymen's default bundler), Alchemy, and self-hosted bundlers don't implement
 * it, so every UserOp throws inside sendUserOperation — before it's ever submitted. That's
 * the "The method zd_getUserOperationGasPrice does not exist" error, and it broke trades,
 * transfers, vault deposits, selftest, and fund recovery alike.
 *
 * Supplying our own estimator makes the SDK skip that path entirely:
 *   - Pimlico bundler → its own `pimlico_getUserOperationGasPrice` oracle (the bundler is
 *     guaranteed to accept the fees it quotes — avoids "maxFeePerGas too low" rejects).
 *   - any other bundler, or if that call fails → the chain's public RPC: EIP-1559 fees,
 *     or legacy `eth_gasPrice` when the chain has no base fee (Robinhood Chain is an
 *     Arbitrum-based L3 and may not expose EIP-1559).
 *
 * The account self-pays gas from its own ETH; there is no paymaster.
 */

import type { Client, PublicClient } from "viem";

export interface UserOpFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Pimlico's gas-price oracle response — hex values, one set per speed tier. */
interface PimlicoGasPrice {
  slow: { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}` };
  standard: { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}` };
  fast: { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}` };
}

/** ~1.25× headroom so a base-fee bump between estimate and inclusion doesn't strand the op. */
const bump = (v: bigint) => (v * 5n) / 4n;

/** Chain-derived fees: EIP-1559 where a base fee exists, else legacy gas price for both fields. */
export async function chainFees(publicClient: PublicClient): Promise<UserOpFees> {
  try {
    const f = await publicClient.estimateFeesPerGas();
    if (f.maxFeePerGas > 0n) {
      return { maxFeePerGas: bump(f.maxFeePerGas), maxPriorityFeePerGas: f.maxPriorityFeePerGas };
    }
  } catch {
    // Eip1559FeesNotSupportedError — this L3 has no base fee. Fall back to legacy gas price.
  }
  const gasPrice = bump(await publicClient.getGasPrice());
  return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
}

/**
 * The `userOperation` config object to pass to createKernelAccountClient. Closes over the
 * chain's public client so it never depends on the bundler exposing a proprietary method.
 */
export function userOpGasConfig(publicClient: PublicClient, bundlerUrl: string) {
  const isPimlico = /pimlico\.io/i.test(bundlerUrl);
  return {
    estimateFeesPerGas: async ({ bundlerClient }: { bundlerClient: Client }): Promise<UserOpFees> => {
      if (isPimlico) {
        try {
          // The vendor method isn't in viem's RPC schema — cast the request.
          const request = bundlerClient.request as unknown as (args: {
            method: "pimlico_getUserOperationGasPrice";
            params: [];
          }) => Promise<PimlicoGasPrice>;
          const gp = await request({ method: "pimlico_getUserOperationGasPrice", params: [] });
          return {
            maxFeePerGas: BigInt(gp.standard.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(gp.standard.maxPriorityFeePerGas),
          };
        } catch {
          // Pimlico oracle unavailable — fall through to the chain RPC.
        }
      }
      return chainFees(publicClient);
    },
  };
}
