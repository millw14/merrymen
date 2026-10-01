import type { Address } from "viem";
import { formatUserOperation, getUserOperationHash } from "viem/account-abstraction";
import { getEntryPoint } from "@zerodev/sdk/constants";
import type { PendingRevocation } from "./permission-revocation";
import { permissionRevocationNonce } from "./recovery-shape";

/** Every receipt hash is bound to the exact account, chain, call and nonce. */
export function readRevocationRecord(raw: string, account: Address, chainId: number): PendingRevocation {
  try {
    const value = JSON.parse(raw) as PendingRevocation;
    if (!Number.isInteger(value.nonce) || value.nonce < 2 || value.nonce > 0xffff_ffff) throw new Error();
    if (value.previousOperations !== undefined && !Array.isArray(value.previousOperations)) throw new Error();
    for (const previous of [{ hash: value.hash, operation: value.operation }, ...(value.previousOperations ?? [])]) {
      const operation = previous.operation;
      if (!/^0x[0-9a-fA-F]{64}$/.test(previous.hash) || operation.sender.toLowerCase() !== account.toLowerCase() ||
          !/^0x[0-9a-fA-F]+$/.test(operation.nonce) || operation.nonce !== value.operation.nonce ||
          operation.callData !== value.operation.callData || permissionRevocationNonce(operation.callData, account) !== value.nonce) throw new Error();
      const computed = getUserOperationHash({
        userOperation: formatUserOperation(operation), chainId,
        entryPointAddress: getEntryPoint("0.7").address, entryPointVersion: "0.7",
      });
      if (computed.toLowerCase() !== previous.hash.toLowerCase()) throw new Error();
    }
    return value;
  } catch {
    throw new Error("The pending revocation record cannot be verified. Your wallet was kept. Contact support before trying another transaction.");
  }
}
