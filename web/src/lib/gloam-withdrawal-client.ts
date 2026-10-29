"use client";

import { createPublicClient, erc20Abi, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { formatUserOperation, formatUserOperationRequest, type RpcUserOperation, type UserOperation } from "viem/account-abstraction";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { assertDerivedAccount, robinhoodChain } from "@merrymen/core";
import { userOpGasConfig } from "../../../worker/src/gas";
import { getRecoveryTicket, relayUrl, type BrowserWallet } from "./recover-client";
import { GLOAM_WITHDRAWAL_CHAIN_ID, GLOAM_WITHDRAWAL_POOL, GLOAM_WITHDRAWAL_USDG } from "./gloam-withdrawal-contracts";
import { gloamOperationHash, gloamWithdrawalAmount, gloamWithdrawalCalls, readGloamWithdrawal, submitSavedGloamWithdrawal, type GloamWithdrawalRecord } from "./gloam-withdrawal";
import { verifyGloamWithdrawalReceipt } from "./gloam-withdrawal-receipt";

const POOL_READ_ABI = parseAbi(["function commitmentSeen(bytes32) view returns (bool)"]);
const NONCE_ABI = parseAbi(["function getNonce(address,uint192) view returns (uint256)"]);
const keyOf = (account: Address) => `merrymen.gloam-withdrawal.v1.${GLOAM_WITHDRAWAL_CHAIN_ID}.${account.toLowerCase()}`;

export function loadGloamWithdrawal(account: Address): GloamWithdrawalRecord | null {
  const raw = localStorage.getItem(keyOf(account));
  return raw ? readGloamWithdrawal(raw, account) : null;
}
function save(r: GloamWithdrawalRecord) {
  const raw = JSON.stringify(r);
  readGloamWithdrawal(raw, r.account);
  localStorage.setItem(keyOf(r.account), raw);
  if (localStorage.getItem(keyOf(r.account)) !== raw) throw new Error("Could not save the withdrawal. Nothing new was submitted.");
}

async function exclusive<T>(account: Address, run: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("Use a browser with Web Locks support for this beta withdrawal. Your regular recovery option remains available.");
  return navigator.locks.request(keyOf(account), { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("A Gloam withdrawal is already open in another tab. Finish it there first.");
    return run();
  });
}

async function ownerClient(w: BrowserWallet) {
  if (w.chainId !== GLOAM_WITHDRAWAL_CHAIN_ID) throw new Error("Gloam withdrawals support USDG on Robinhood mainnet only.");
  const signer = w.ownerKey ? privateKeyToAccount(w.ownerKey) : w.ownerAccount;
  if (!signer) throw new Error("Sign in with this agent's owner wallet to approve a withdrawal.");
  const chain = robinhoodChain;
  const publicClient = createPublicClient({ chain, cacheTime: 0, transport: http(undefined, { timeout: 15_000 }) });
  const entryPoint = getEntryPoint("0.7");
  const sudo = await signerToEcdsaValidator(publicClient, { signer, entryPoint, kernelVersion: KERNEL_V3_3 });
  const account = await createKernelAccount(publicClient, { entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo } });
  assertDerivedAccount(account.address, "Gloam withdrawal");
  if (account.address.toLowerCase() !== w.smartAccount.toLowerCase()) throw new Error("This wallet does not own the selected agent. Nothing was signed or sent.");
  await getRecoveryTicket(w);
  const url = relayUrl(chain.id);
  const client = createKernelAccountClient({ account, chain, bundlerTransport: http(url), userOperation: userOpGasConfig(publicClient, url) });
  return { account, publicClient, client, entryPoint };
}

/** Build and estimate only. A distinct confirmation is required before signing the payment. */
export async function prepareGloamWithdrawal(w: BrowserWallet, receiveTag: string, amountText: string, status: (message: string) => void): Promise<GloamWithdrawalRecord> {
  return exclusive(w.smartAccount, async () => {
    if (loadGloamWithdrawal(w.smartAccount)) throw new Error("Finish or explicitly clear the previous withdrawal before preparing another.");
    const amount = gloamWithdrawalAmount(amountText);
    status("Checking the owner and available USDG…");
    const { publicClient, client } = await ownerClient(w);
    const balance = await publicClient.readContract({ address: GLOAM_WITHDRAWAL_USDG, abi: erc20Abi, functionName: "balanceOf", args: [w.smartAccount] });
    if (amount > balance) throw new Error("This account does not have that much available USDG. Investments are not sold automatically.");
    status("Preparing the private payment on your device. This can take a moment…");
    const { prepareGloamShield } = await import("./gloam-proof");
    const shield = await prepareGloamShield({ amountWei: amount, receiveTag: receiveTag.trim() });
    status("Checking the transaction and estimating its ETH fee…");
    const operation = formatUserOperationRequest(await client.prepareUserOperation({ calls: gloamWithdrawalCalls(amount, shield) })) as RpcUserOperation<"0.7">;
    const record: GloamWithdrawalRecord = { version: 1, account: w.smartAccount, chainId: GLOAM_WITHDRAWAL_CHAIN_ID,
      amount: amount.toString(), receiveTag: receiveTag.trim(), commitment: shield.commitment, memo: shield.memo,
      operation, hash: gloamOperationHash(operation), state: "prepared", createdAt: new Date().toISOString() };
    save(record);
    return record;
  });
}

/** Validate the real receipt against the chain, not only the bundler's success flag. */
async function submit(record: GloamWithdrawalRecord, context: Awaited<ReturnType<typeof ownerClient>>) {
  const { publicClient, client, entryPoint } = context;
  const verify = async (receipt: Awaited<ReturnType<typeof client.getUserOperationReceipt>>) => {
    if (receipt.userOpHash.toLowerCase() !== record.hash.toLowerCase()
      || receipt.sender.toLowerCase() !== record.account.toLowerCase()) throw new Error("The receipt does not match this saved withdrawal.");
    const onchain = await publicClient.getTransactionReceipt({ hash: receipt.receipt.transactionHash });
    if (onchain.transactionHash.toLowerCase() !== receipt.receipt.transactionHash.toLowerCase()) {
      throw new Error("The chain returned a different withdrawal transaction receipt.");
    }
    // The bundler's success field is not authoritative, including when it says
    // the operation reverted. Check the exact EntryPoint event and this
    // operation's deposit/memo logs before permitting its journal to be cleared.
    return verifyGloamWithdrawalReceipt(record, onchain);
  };
  return submitSavedGloamWithdrawal(record, {
    save,
    receipt: async (hash) => {
      try { return await verify(await client.getUserOperationReceipt({ hash })); }
      catch (error) {
        if (error instanceof Error && error.name === "UserOperationReceiptNotFoundError") return null;
        throw error;
      }
    },
    commitmentSeen: (commitment) => publicClient.readContract({ address: GLOAM_WITHDRAWAL_POOL, abi: POOL_READ_ABI, functionName: "commitmentSeen", args: [commitment] }),
    nonceConsumed: async (operation) => {
      const nonce = BigInt(operation.nonce);
      const next = await publicClient.readContract({ address: entryPoint.address, abi: NONCE_ABI, functionName: "getNonce", args: [record.account, nonce >> 64n] });
      return next > nonce;
    },
    send: (operation) => client.request({ method: "eth_sendUserOperation", params: [operation as never, entryPoint.address] }),
    wait: async (hash) => verify(await client.waitForUserOperationReceipt({ hash, timeout: 45_000 })),
  });
}

/** Only this explicit user action signs. Retries never prepare a new note or nonce. */
export async function approveGloamWithdrawal(w: BrowserWallet, expectedHash: Hex, status: (message: string) => void): Promise<GloamWithdrawalRecord> {
  return exclusive(w.smartAccount, async () => {
    let r = loadGloamWithdrawal(w.smartAccount);
    if (!r || r.hash !== expectedHash) throw new Error("The saved withdrawal changed. Review it again before approving.");
    const context = await ownerClient(w);
    if (r.state === "prepared") {
      status("Approve this withdrawal in your owner wallet…");
      const op = formatUserOperation(r.operation) as UserOperation<"0.7">;
      const signature = await context.account.signUserOperation(op);
      const operation = { ...r.operation, signature };
      r = { ...r, operation, hash: gloamOperationHash(operation), state: "signed" };
      save(r); // A failure here must prevent broadcast.
    }
    status("Checking and submitting the saved withdrawal…");
    return submit(r, context);
  });
}

/** Only an unsigned plan or chain-confirmed result may be replaced. */
export async function clearGloamWithdrawal(w: BrowserWallet): Promise<void> {
  return exclusive(w.smartAccount, async () => {
    const r = loadGloamWithdrawal(w.smartAccount);
    if (!r) return;
    if (r.state === "signed") throw new Error("This transaction may still be pending. Check it before starting another withdrawal.");
    if (r.state !== "prepared") await submit(r, await ownerClient(w));
    localStorage.removeItem(keyOf(w.smartAccount));
  });
}
