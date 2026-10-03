"use client";

import { createPublicClient, encodeFunctionData, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { formatUserOperation, formatUserOperationRequest, getUserOperationHash, type RpcUserOperation, type UserOperation } from "viem/account-abstraction";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { assertDerivedAccount, robinhoodChain, robinhoodTestnet } from "@merrymen/core";
import { userOpGasConfig } from "../../../worker/src/gas";
import { createSponsor } from "../../../worker/src/paymaster";
import { getRecoveryTicket, ownerGasError, relayUrl, type BrowserWallet } from "./recover-client";
import { invalidatePermissions, nextRevocationNonce, KERNEL_REVOCATION_ABI, type PendingRevocation } from "./permission-revocation";
import { readRevocationRecord } from "./revocation-journal";

/** The signed operation is public, contains no private key, and survives reloads. */
function pendingStore(w: BrowserWallet) {
  const key = `merrymen.permission-revocation.v1.${w.chainId}.${w.smartAccount.toLowerCase()}`;
  return {
    pending(): PendingRevocation | null {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return readRevocationRecord(raw, w.smartAccount, w.chainId);
    },
    save(value: PendingRevocation) { localStorage.setItem(key, JSON.stringify(value)); },
    clear() { localStorage.removeItem(key); },
  };
}

/** Owner signature stays in the browser; the relay cannot spend or sign for it. */
async function revocationContext(w: BrowserWallet) {
  const chain = w.chainId === robinhoodChain.id ? robinhoodChain : w.chainId === robinhoodTestnet.id ? robinhoodTestnet : null;
  if (!chain) throw new Error("Unknown account network; refusing to revoke on another chain.");
  const signer = w.ownerAccount ?? (w.ownerKey ? privateKeyToAccount(w.ownerKey) : null);
  if (!signer) throw new Error("Sign in as this wallet's owner, or unlock its recovery key, to revoke permissions on-chain.");
  const publicClient = createPublicClient({ chain, transport: http() });
  const entryPoint = getEntryPoint("0.7");
  const sudo = await signerToEcdsaValidator(publicClient, { signer, entryPoint, kernelVersion: KERNEL_V3_3 });
  const account = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo } });
  assertDerivedAccount(account.address, "owner permission revocation");
  if (account.address.toLowerCase() !== w.smartAccount.toLowerCase()) {
    throw new Error("This owner controls a different account. No revocation was signed.");
  }
  // Receipt reconciliation must remain available if coverage has since stopped.
  // The relay checks coverage when these hooks actually request a new quote.
  await getRecoveryTicket(w);
  const url = relayUrl(w.chainId, w.apiOrigin);
  const sponsor = createSponsor({ url, credentials: "include" });
  const client = createKernelAccountClient({ account, chain, bundlerTransport: http(url, { fetchOptions: { credentials: "include" } }), paymaster: sponsor.paymaster, paymasterContext: sponsor.paymasterContext, userOperation: userOpGasConfig(publicClient, url) });
  const readNonce = async () => {
    const code = await publicClient.request({ method: "eth_getCode", params: [account.address, "latest"] });
    if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(code)) {
      throw new Error("Could not confirm the account's permission nonce. No revocation was signed; retry when the network is available.");
    }
    if (code === "0x") return 1;
    return publicClient.readContract({ address: account.address, abi: KERNEL_REVOCATION_ABI, functionName: "currentNonce" });
  };
  return { chain, publicClient, account, client, entryPoint, readNonce };
}

/** Obtain an actual sponsored estimate before stopping or replacing an agent. */
export async function preflightRevocationFromBrowser(w: BrowserWallet): Promise<void> {
  try {
  const { account, client, publicClient, readNonce } = await revocationContext(w);
  const pending = pendingStore(w).pending();
  if (pending) {
    for (const hash of [pending.hash, ...(pending.previousOperations ?? []).map(previous => previous.hash)]) {
      try {
        const receipt = await client.getUserOperationReceipt({ hash });
        if (receipt.success && await publicClient.readContract({ address: account.address, abi: KERNEL_REVOCATION_ABI, functionName: "validNonceFrom" }) >= pending.nonce) return;
      } catch (e) {
        if (!(e instanceof Error && e.name === "UserOperationReceiptNotFoundError")) throw e;
      }
    }
  }
  const nonce = nextRevocationNonce(await readNonce());
  await client.prepareUserOperation({ calls: [{ to: account.address, value: 0n,
    data: encodeFunctionData({ abi: KERNEL_REVOCATION_ABI, functionName: "invalidateNonce", args: [nonce] }),
  }] });
  } catch (e) {
    throw new Error(`${w.chainId === robinhoodTestnet.id ? robinhoodTestnet.name : robinhoodChain.name} (${w.chainId}): ${ownerGasError(e, w.ownerKey)} No revocation was submitted; your existing wallet was kept.`);
  }
}

export async function revokeFromBrowser(w: BrowserWallet, onStatus: (message: string) => void) {
  try {
    const { chain, publicClient, account, client, entryPoint, readNonce } = await revocationContext(w);
    return await invalidatePermissions({
      ...pendingStore(w),
      status: onStatus,
      readNonce,
      prepare: async (nonce) => {
        const operation = await client.prepareUserOperation({ calls: [{
          to: account.address, value: 0n,
          data: encodeFunctionData({ abi: KERNEL_REVOCATION_ABI, functionName: "invalidateNonce", args: [nonce] }),
        }] });
        const signature = await account.signUserOperation(operation);
        const signed = { ...operation, signature };
        const hash = getUserOperationHash({ userOperation: signed, chainId: chain.id, entryPointAddress: entryPoint.address, entryPointVersion: "0.7" });
        return { hash, operation: formatUserOperationRequest(signed) as RpcUserOperation<"0.7"> };
      },
      reprice: async ({ operation }) => {
        const original = formatUserOperation(operation) as UserOperation<"0.7">;
        const fees = await publicClient.estimateFeesPerGas();
        const bump = (old: bigint, current: bigint) => {
          const raised = old * 125n / 100n + 1n;
          return raised > current ? raised : current;
        };
        const repriced = await client.prepareUserOperation({ ...original,
          // Sponsor data signs the fee fields too. A fee replacement must get
          // a fresh quote, while preserving its EntryPoint nonce and call.
          paymaster: undefined, paymasterData: undefined,
          paymasterVerificationGasLimit: undefined, paymasterPostOpGasLimit: undefined,
          signature: undefined,
          maxFeePerGas: bump(original.maxFeePerGas, fees.maxFeePerGas),
          maxPriorityFeePerGas: bump(original.maxPriorityFeePerGas, fees.maxPriorityFeePerGas),
        }) as UserOperation<"0.7">;
        const signed = { ...repriced, signature: await account.signUserOperation(repriced) };
        const hash = getUserOperationHash({ userOperation: signed, chainId: chain.id, entryPointAddress: entryPoint.address, entryPointVersion: "0.7" });
        return { hash, operation: formatUserOperationRequest(signed) as RpcUserOperation<"0.7"> };
      },
      nonceConsumed: async ({ operation }) => {
        const nonce = BigInt(operation.nonce);
        const current = await publicClient.readContract({
          address: entryPoint.address,
          abi: [{ type: "function", name: "getNonce", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint192" }], outputs: [{ type: "uint256" }] }],
          functionName: "getNonce", args: [account.address, nonce >> 64n],
        });
        return current > nonce;
      },
      // Raw RPC preserves the exact nonce, gas and signature across retries.
      // Running SDK preparation again could silently change the stored hash.
      send: ({ operation }) => client.request({ method: "eth_sendUserOperation", params: [operation as never, entryPoint.address] }),
      receipt: async (hash) => {
        try {
          const receipt = await client.getUserOperationReceipt({ hash });
          return { success: receipt.success, transactionHash: receipt.receipt.transactionHash };
        } catch (e) {
          if (e instanceof Error && e.name === "UserOperationReceiptNotFoundError") return null;
          throw e;
        }
      },
      wait: async (hash: Hex) => {
        const receipt = await client.waitForUserOperationReceipt({ hash, timeout: 60_000 });
        return { success: receipt.success, transactionHash: receipt.receipt.transactionHash };
      },
      readValidNonceFrom: () => publicClient.readContract({ address: account.address, abi: KERNEL_REVOCATION_ABI, functionName: "validNonceFrom" }),
    });
  } catch (error) {
    throw new Error(`${w.chainId === robinhoodTestnet.id ? robinhoodTestnet.name : robinhoodChain.name} (${w.chainId}): ${ownerGasError(error, w.ownerKey)} Earlier permissions are not confirmed revoked. Your wallet and recovery access were kept; retry checks saved receipts and obtains fresh gas coverage for the same revocation.`);
  }
}
