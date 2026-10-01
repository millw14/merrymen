import type { Hex } from "viem";
import type { RpcUserOperation } from "viem/account-abstraction";

/**
 * Kernel v3.3's validation nonce is separate from the EntryPoint transaction
 * nonce. Raising validNonceFrom invalidates installed permissions AND changes
 * the enable digest of grants which have not been installed yet. The root
 * owner is exempt, so withdrawal and a subsequent fresh grant still work.
 *
 * Source: zerodevapp/kernel tag v3.3 (cd697c7),
 * src/core/ValidationManager.sol _invalidateNonce/_enableDigest and
 * src/Kernel.sol validateUserOp. Do not replace this with server-side deletion
 * or uninstalling just the current permission: neither revokes copied grants.
 */
export const KERNEL_REVOCATION_ABI = [
  { type: "function", name: "currentNonce", inputs: [], outputs: [{ type: "uint32" }], stateMutability: "view" },
  { type: "function", name: "validNonceFrom", inputs: [], outputs: [{ type: "uint32" }], stateMutability: "view" },
  { type: "function", name: "invalidateNonce", inputs: [{ name: "nonce", type: "uint32" }], outputs: [], stateMutability: "payable" },
] as const;

export interface PendingRevocation {
  hash: Hex;
  nonce: number;
  /** Public signed RPC payload, never an owner/session private key. */
  operation: RpcUserOperation<"0.7">;
  /** Fee replacements share one EntryPoint nonce; any earlier hash may win. */
  previousOperations?: Array<Pick<PendingRevocation, "hash" | "operation">>;
}

export interface RevocationReceipt {
  success: boolean;
  transactionHash: Hex;
}

export interface RevocationIO {
  readNonce(): Promise<number>;
  prepare(nonce: number): Promise<{ hash: Hex; operation: RpcUserOperation<"0.7"> }>;
  reprice(pending: PendingRevocation): Promise<{ hash: Hex; operation: RpcUserOperation<"0.7"> }>;
  nonceConsumed(pending: PendingRevocation): Promise<boolean>;
  send(pending: PendingRevocation): Promise<Hex>;
  receipt(hash: Hex): Promise<RevocationReceipt | null>;
  wait(hash: Hex): Promise<RevocationReceipt>;
  readValidNonceFrom(): Promise<number>;
  pending(): PendingRevocation | null;
  save(pending: PendingRevocation): void;
  clear(): void;
  status(message: string): void;
}

export interface RevocationResult {
  userOpHash: Hex;
  transactionHash: Hex;
  validNonceFrom: number;
}

export function nextRevocationNonce(current: number): number {
  if (!Number.isInteger(current) || current < 0 || current >= 0xffff_fffe) {
    throw new Error("The account's permission nonce cannot be safely advanced. Contact support; no permission was replaced.");
  }
  // An undeployed account's first enabled permissions use nonce 1.
  return Math.max(1, current) + 1;
}

/** Journal before broadcasting, and never mint a replacement on an unknown result. */
export async function invalidatePermissions(io: RevocationIO): Promise<RevocationResult> {
  let pending = io.pending();
  let receipt: RevocationReceipt | null = null;
  let confirmedHash: Hex | undefined;
  if (pending) {
    for (const hash of [pending.hash, ...(pending.previousOperations ?? []).map(previous => previous.hash)]) {
      receipt = await io.receipt(hash);
      if (receipt) { confirmedHash = hash; break; }
    }
    if (!receipt) {
      if (await io.nonceConsumed(pending)) {
        // Chain proof that every saved operation is now impossible to replay.
        // Do not infer revocation: a withdrawal may have consumed this nonce.
        io.clear();
        pending = null;
      } else {
        io.status("Refreshing network fees for the same revocation. Approve with your owner wallet.");
        const replacement = await io.reprice(pending);
        if (replacement.operation.nonce !== pending.operation.nonce ||
            replacement.operation.sender.toLowerCase() !== pending.operation.sender.toLowerCase() ||
            replacement.operation.callData !== pending.operation.callData) {
          throw new Error("A fee replacement changed the revocation. Nothing was submitted.");
        }
        pending = { ...replacement, nonce: pending.nonce, previousOperations: [{ hash: pending.hash, operation: pending.operation }, ...(pending.previousOperations ?? [])] };
        io.save(pending);
      }
    }
  }
  if (!pending) {
    io.status("Preparing an owner-authorized revocation. This transaction uses network fees.");
    const nonce = nextRevocationNonce(await io.readNonce());
    const prepared = await io.prepare(nonce);
    pending = { ...prepared, nonce };
    // If browser storage is unavailable, refuse BEFORE sending a transaction
    // whose result we could lose on a refresh.
    io.save(pending);
  }
  // Check first, then re-submit the IDENTICAL signed operation if necessary.
  // EntryPoint's transaction nonce makes replay harmless; a lost HTTP response
  // must not strand a permanently unbroadcast pending hash in this browser.
  receipt ??= await io.receipt(pending.hash);
  let submitError: unknown;
  if (!receipt) {
    io.status("Submitting the saved revocation operation…");
    let sent: Hex | undefined;
    try { sent = await io.send(pending); } catch (e) { submitError = e; }
    if (sent && sent.toLowerCase() !== pending.hash.toLowerCase()) {
      throw new Error("The relay returned an unexpected operation hash. Revocation is unconfirmed; your wallet and recovery access were kept.");
    }
  }
  io.status("Waiting for the revocation receipt. Your wallet and recovery access are kept.");
  try { receipt ??= await io.wait(pending.hash); } catch (e) {
    throw submitError ?? e;
  }
  if (!receipt.success) {
    io.clear();
    throw new Error("The revocation transaction failed. Earlier permissions may still work; your wallet was kept. You can retry.");
  }
  const validNonceFrom = await io.readValidNonceFrom();
  if (!Number.isSafeInteger(validNonceFrom) || validNonceFrom < pending.nonce) {
    throw new Error("The receipt arrived, but the chain has not confirmed permission invalidation. Nothing new was signed; check again.");
  }
  io.clear();
  return { userOpHash: confirmedHash ?? pending.hash, transactionHash: receipt.transactionHash, validNonceFrom };
}
