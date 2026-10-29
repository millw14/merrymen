import { encodeFunctionData, erc20Abi, parseUnits, type Address, type Hex } from "viem";
import { formatUserOperation, getUserOperationHash, type RpcUserOperation } from "viem/account-abstraction";
import { getEntryPoint } from "@zerodev/sdk/constants";
import { isGloamOwnerNonce, parseGloamWithdrawalShape } from "./gloam-withdrawal-shape";
import {
  GLOAM_MEMO_BOARD_ABI, GLOAM_SHIELD_BOUND_ABI, GLOAM_WITHDRAWAL_CHAIN_ID,
  GLOAM_WITHDRAWAL_MAX_AMOUNT, GLOAM_WITHDRAWAL_POOL, GLOAM_WITHDRAWAL_USDG,
  GLOAM_WITHDRAWAL_MEMO_BOARD, type GloamWithdrawalCall,
} from "./gloam-withdrawal-contracts";

export type GloamWithdrawalState = "prepared" | "signed" | "confirmed" | "reverted";

/** Public operation + encrypted memo only. Never persist a note secret or owner key. */
export interface GloamWithdrawalRecord {
  version: 1;
  account: Address;
  chainId: 4663;
  amount: string;
  receiveTag: string;
  commitment: Hex;
  memo: Hex;
  operation: RpcUserOperation<"0.7">;
  hash: Hex;
  state: GloamWithdrawalState;
  createdAt: string;
  transactionHash?: Hex;
}

export function gloamWithdrawalAmount(input: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(input.trim())) {
    throw new Error("Enter a USDG amount with up to six decimal places.");
  }
  const amount = parseUnits(input.trim(), 6);
  if (amount <= 0n || amount > GLOAM_WITHDRAWAL_MAX_AMOUNT) {
    throw new Error("Enter more than 0 and at most 500 USDG for this beta withdrawal.");
  }
  return amount;
}

export function gloamWithdrawalCalls(amount: bigint, shield: { commitment: Hex; proof: Hex; memo: Hex }): GloamWithdrawalCall[] {
  if (amount <= 0n || amount > GLOAM_WITHDRAWAL_MAX_AMOUNT) throw new Error("Invalid Gloam withdrawal amount.");
  return [
    { to: GLOAM_WITHDRAWAL_USDG, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GLOAM_WITHDRAWAL_POOL, amount] }) },
    { to: GLOAM_WITHDRAWAL_POOL, value: 0n, data: encodeFunctionData({ abi: GLOAM_SHIELD_BOUND_ABI, functionName: "shieldBound", args: [GLOAM_WITHDRAWAL_USDG, amount, shield.commitment, shield.proof] }) },
    { to: GLOAM_WITHDRAWAL_MEMO_BOARD, value: 0n, data: encodeFunctionData({ abi: GLOAM_MEMO_BOARD_ABI, functionName: "postMemo", args: [shield.commitment, shield.memo] }) },
    { to: GLOAM_WITHDRAWAL_USDG, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GLOAM_WITHDRAWAL_POOL, 0n] }) },
  ];
}

export function gloamOperationHash(operation: RpcUserOperation<"0.7">): Hex {
  return getUserOperationHash({ userOperation: formatUserOperation(operation), chainId: GLOAM_WITHDRAWAL_CHAIN_ID,
    entryPointAddress: getEntryPoint("0.7").address, entryPointVersion: "0.7" });
}

/** Match the owner relay: explicit empty data and zero gas are not sponsorship. */
function hasPaymaster(operation: Record<string, unknown>): boolean {
  const empty = (value: unknown) => value === undefined || value === null || value === "" || value === "0x";
  const zero = (value: unknown) => {
    if (empty(value)) return true;
    try { return BigInt(value as string | number | bigint) === 0n; }
    catch { return false; }
  };
  return (!empty(operation.paymaster) && !/^0x0{40}$/i.test(String(operation.paymaster)))
    || !empty(operation.paymasterData) || !empty(operation.paymasterAndData)
    || !zero(operation.paymasterPostOpGasLimit) || !zero(operation.paymasterVerificationGasLimit);
}

/** Reject a corrupt/cross-account record before any signature or resubmission. */
export function readGloamWithdrawal(raw: string, account: Address): GloamWithdrawalRecord {
  try {
    const r = JSON.parse(raw) as GloamWithdrawalRecord;
    if (r.version !== 1 || r.chainId !== GLOAM_WITHDRAWAL_CHAIN_ID || r.account.toLowerCase() !== account.toLowerCase()
      || !["prepared", "signed", "confirmed", "reverted"].includes(r.state)
      || !/^\d+$/.test(r.amount) || !/^gloamr1\.[A-Za-z0-9_-]+$/.test(r.receiveTag)
      || !/^0x[\da-f]{64}$/i.test(r.commitment) || !Number.isFinite(Date.parse(r.createdAt))) throw new Error();
    const op = r.operation;
    const shape = parseGloamWithdrawalShape(op.callData);
    if (!shape.ok || op.sender.toLowerCase() !== account.toLowerCase() || !isGloamOwnerNonce(op.nonce)
      || hasPaymaster(op)
      || shape.amount.toString() !== r.amount || shape.commitment.toLowerCase() !== r.commitment.toLowerCase()
      || shape.memo.toLowerCase() !== r.memo.toLowerCase() || gloamOperationHash(op).toLowerCase() !== r.hash.toLowerCase()
      || !/^0x(?:[\da-f]{2})+$/i.test(op.signature)) throw new Error();
    if (r.transactionHash && !/^0x[\da-f]{64}$/i.test(r.transactionHash)) throw new Error();
    return r;
  } catch {
    throw new Error("The saved Gloam withdrawal could not be verified. Keep its backup and resolve it before starting another withdrawal.");
  }
}

export interface GloamWithdrawalReceipt { success: boolean; transactionHash: Hex }
export interface GloamSubmissionDependencies {
  save(record: GloamWithdrawalRecord): void;
  receipt(hash: Hex): Promise<GloamWithdrawalReceipt | null>;
  commitmentSeen(commitment: Hex): Promise<boolean>;
  nonceConsumed(operation: RpcUserOperation<"0.7">): Promise<boolean>;
  send(operation: RpcUserOperation<"0.7">): Promise<Hex>;
  wait(hash: Hex): Promise<GloamWithdrawalReceipt>;
}

/** A timeout never becomes permission to create a second payment. Retry the SAME signed bytes. */
export async function submitSavedGloamWithdrawal(record: GloamWithdrawalRecord, deps: GloamSubmissionDependencies): Promise<GloamWithdrawalRecord> {
  const r = readGloamWithdrawal(JSON.stringify(record), record.account);
  if (r.state === "prepared") throw new Error("Approve this withdrawal with its owner wallet first.");
  const finish = (receipt: GloamWithdrawalReceipt) => {
    const result: GloamWithdrawalRecord = { ...r, state: receipt.success ? "confirmed" : "reverted", transactionHash: receipt.transactionHash };
    deps.save(result);
    return result;
  };
  const previous = await deps.receipt(r.hash);
  if (previous) return finish(previous);
  // A saved UI status is not evidence that an RPC confirmed this operation.
  if (r.state === "confirmed" || r.state === "reverted") throw new Error("The saved receipt is not currently available. Check again before starting another withdrawal.");
  if (await deps.commitmentSeen(r.commitment)) {
    throw new Error("This Gloam note already exists on-chain. Open Gloam to claim it; keep this record while its transaction receipt is checked. Nothing was sent again.");
  }
  if (await deps.nonceConsumed(r.operation)) {
    throw new Error("This owner transaction's nonce has already been used. Keep this record and check its receipt before starting another withdrawal.");
  }
  // Must succeed before the network write; quota/private-mode failures stop submission.
  deps.save(r);
  const hash = await deps.send(r.operation);
  if (hash.toLowerCase() !== r.hash.toLowerCase()) throw new Error("The relay returned a different transaction identifier. Keep this record and check again; do not create another withdrawal.");
  return finish(await deps.wait(r.hash));
}
