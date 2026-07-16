/**
 * Agent executor — turns an approved, simulated intent into a UserOperation
 * signed by the agent's session key. The Kernel account contract re-checks the
 * grant's policies on-chain; this code cannot exceed them even if buggy.
 *
 * Needs a bundler:
 *   MERRYMEN_BUNDLER_URL   e.g. Pimlico/Alchemy bundler RPC for chain 46630/4663
 *
 * The serialized grant embeds the session private key for the TESTNET demo
 * (mirrors web/src/lib/session.ts). Production: Turnkey TEE holds the key and
 * this module signs via its API instead of deserializing a local key.
 */

import { http, createPublicClient, type Chain, type Hex } from "viem";
import { createKernelAccountClient } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { deserializePermissionAccount } from "@zerodev/permissions";
import { userOpGasConfig } from "./gas";

export interface Call {
  to: `0x${string}`;
  value: bigint;
  data: Hex;
}

export interface AgentExecutor {
  /** Counterfactual smart-account address (deploys itself on first op). */
  address: `0x${string}`;
  /** Send a batch of calls as one UserOperation; resolves to the tx hash. */
  execute(calls: Call[]): Promise<`0x${string}`>;
}

export async function createAgentExecutor(opts: {
  chain: Chain;
  serializedGrant: string;
  bundlerUrl: string;
  /** RPC override (settings rpcMainnet/rpcTestnet) — falls back to the chain default. */
  rpcUrl?: string;
}): Promise<AgentExecutor> {
  const publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  const entryPoint = getEntryPoint("0.7");

  const account = await deserializePermissionAccount(
    publicClient,
    entryPoint,
    KERNEL_V3_3,
    opts.serializedGrant,
  );

  const client = createKernelAccountClient({
    account,
    chain: opts.chain,
    bundlerTransport: http(opts.bundlerUrl),
    // Without this the SDK calls the ZeroDev-only `zd_getUserOperationGasPrice`,
    // which Pimlico/Alchemy/self-hosted bundlers reject — see worker/src/gas.ts.
    userOperation: userOpGasConfig(publicClient, opts.bundlerUrl),
  });

  return {
    address: account.address,
    async execute(calls: Call[]) {
      const userOpHash = await client.sendUserOperation({
        callData: await account.encodeCalls(calls),
      });
      const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
      if (!receipt.success) {
        // Surface the on-chain revert reason when the bundler provides one.
        const reason = (receipt as { reason?: string }).reason;
        throw new Error(`reverted on-chain${reason ? `: ${reason}` : ""} (${userOpHash})`);
      }
      return receipt.receipt.transactionHash;
    },
  };
}
