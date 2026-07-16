/**
 * Fund recovery — sweep an agent's smart account back to a wallet you control,
 * signed by the OWNER key (the account's sudo validator), NOT the session key.
 *
 * Why this exists: the address you funded is an ERC-4337 (ZeroDev Kernel) smart
 * account — a counterfactual contract, not a plain EOA. Its owner private key
 * derives a DIFFERENT address, so importing that key into MetaMask shows an
 * empty wallet while the funds sit in the smart account. And after a kill switch
 * the session key is gone. The one thing that always works: rebuild the account
 * from the owner key as the sudo signer and have IT move the money out.
 *
 * The sudo validator has no session-key policies attached, so recovery is not
 * bound by the per-trade / daily caps — it can move the whole balance in one op.
 * The account pays its own gas from its native ETH (no paymaster), exactly like
 * the trading executor. Nothing here transmits the key: it signs one UserOp
 * locally and only the signed op reaches the bundler.
 */

import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  type Address,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { CASH, STOCK_TOKENS, USDG_DECIMALS } from "../../packages/core/src/index";
import { userOpGasConfig } from "./gas";

export interface TokenBalance {
  symbol: string;
  address: Address;
  raw: bigint;
  decimals: number;
  /** Human-readable amount, for display only. */
  amount: string;
}

export interface RecoverPlan {
  smartAccount: Address;
  ownerAddress: Address;
  /** Every token the account holds with a non-zero balance. */
  balances: TokenBalance[];
  gasWei: bigint;
}

export interface RecoverResult extends RecoverPlan {
  /** null when there was nothing to sweep. */
  txHash: `0x${string}` | null;
  to: Address;
}

/** USDG + every basket stock token, so a recovery never leaves value stranded. */
const SWEEPABLE: { symbol: string; address: Address; decimals: number }[] = [
  { symbol: "USDG", address: CASH.USDG as Address, decimals: USDG_DECIMALS },
  ...STOCK_TOKENS.map((t) => ({ symbol: t.symbol, address: t.address as Address, decimals: 18 })),
];

/**
 * Rebuild the smart account from the owner key and read what it holds. Read-only
 * — no bundler, no signing. Use this to show the user what recovery will move
 * (and to verify the owner key actually controls the expected account) before
 * they commit.
 */
export async function planRecovery(opts: {
  chain: Chain;
  ownerPrivateKey: `0x${string}`;
  rpcUrl?: string;
  /** If given, throw when the derived account doesn't match (wrong owner key). */
  expectedSmartAccount?: Address;
}): Promise<RecoverPlan> {
  const publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  const entryPoint = getEntryPoint("0.7");
  const ownerAccount = privateKeyToAccount(opts.ownerPrivateKey);

  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });
  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator },
  });

  if (
    opts.expectedSmartAccount &&
    account.address.toLowerCase() !== opts.expectedSmartAccount.toLowerCase()
  ) {
    throw new Error(
      `this owner key controls ${account.address}, not the expected ${opts.expectedSmartAccount}. ` +
        `Wrong key, or the account was created with a different Kernel version.`,
    );
  }

  const [gasWei, ...raws] = await Promise.all([
    publicClient.getBalance({ address: account.address }).catch(() => 0n),
    ...SWEEPABLE.map((t) =>
      publicClient
        .readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })
        .then((v) => v as bigint)
        .catch(() => 0n),
    ),
  ]);

  const balances: TokenBalance[] = SWEEPABLE.map((t, i) => {
    const raw = raws[i] ?? 0n;
    return { symbol: t.symbol, address: t.address, raw, decimals: t.decimals, amount: formatUnits(raw, t.decimals) };
  }).filter((b) => b.raw > 0n);

  return { smartAccount: account.address, ownerAddress: ownerAccount.address, balances, gasWei };
}

/**
 * Sweep every non-zero token balance to `to` in a single owner-signed UserOp
 * (the account deploys itself on this same op if it never traded). Requires a
 * bundler — a counterfactual smart account cannot move funds any other way.
 * ETH is left behind: it pays for this op's gas, and the remainder is dust.
 */
export async function recoverFunds(opts: {
  chain: Chain;
  ownerPrivateKey: `0x${string}`;
  bundlerUrl: string;
  rpcUrl?: string;
  to: Address;
  expectedSmartAccount?: Address;
}): Promise<RecoverResult> {
  const plan = await planRecovery({
    chain: opts.chain,
    ownerPrivateKey: opts.ownerPrivateKey,
    rpcUrl: opts.rpcUrl,
    expectedSmartAccount: opts.expectedSmartAccount,
  });

  if (plan.balances.length === 0) {
    return { ...plan, txHash: null, to: opts.to };
  }

  const publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  const entryPoint = getEntryPoint("0.7");
  const ownerAccount = privateKeyToAccount(opts.ownerPrivateKey);
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });
  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator },
  });
  const client = createKernelAccountClient({
    account,
    chain: opts.chain,
    bundlerTransport: http(opts.bundlerUrl),
    // See worker/src/gas.ts — required so recovery works with a Pimlico bundler.
    userOperation: userOpGasConfig(publicClient, opts.bundlerUrl),
  });

  const calls = plan.balances.map((b) => ({
    to: b.address,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [opts.to, b.raw] }),
  }));

  const userOpHash = await client.sendUserOperation({ callData: await account.encodeCalls(calls) });
  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
  if (!receipt.success) {
    throw new Error(`recovery UserOp reverted on-chain: ${userOpHash}`);
  }
  return { ...plan, txHash: receipt.receipt.transactionHash, to: opts.to };
}
