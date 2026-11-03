import { decodeEventLog, erc20Abi, parseAbi, toEventSelector, zeroAddress, type Address, type Hex } from "viem";
import { getEntryPoint } from "@zerodev/sdk/constants";
import { GLOAM_WITHDRAWAL_MEMO_BOARD, GLOAM_WITHDRAWAL_POOL, GLOAM_WITHDRAWAL_USDG } from "./gloam-withdrawal-contracts";
import type { GloamWithdrawalReceipt, GloamWithdrawalRecord } from "./gloam-withdrawal";

export const GLOAM_RECEIPT_EVENTS = parseAbi([
  "event BeforeExecution()",
  "event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)",
  "event Shielded(bytes32 indexed commitment,address indexed asset,uint256 amount,uint256 leafIndex,address indexed from)",
  "event PaymentMemo(bytes32 indexed paymentCommitment,bytes memo)",
]);
const ENTRYPOINT = getEntryPoint("0.7").address;
const BEFORE = toEventSelector("BeforeExecution()").toLowerCase();
const USER_OP = toEventSelector("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)").toLowerCase();
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

interface ReceiptLog {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number | null;
  removed?: boolean;
}
export interface GloamChainReceipt {
  status: "success" | "reverted";
  transactionHash: Hex;
  logs: readonly ReceiptLog[];
}
const topics = (log: ReceiptLog): [Hex, ...Hex[]] => {
  if (!log.topics[0]) throw new Error("The receipt contains an undecodable log.");
  return [log.topics[0], ...log.topics.slice(1)];
};

/**
 * Only a matching EntryPoint event is authority for the operation's success.
 * Transfers and notes must belong to THAT operation, not to another operation
 * sharing its bundle. EntryPoint emits BeforeExecution after validation, then
 * each UserOperationEvent after its operation's execution.
 */
export function verifyGloamWithdrawalReceipt(
  record: Pick<GloamWithdrawalRecord, "account" | "hash" | "amount" | "commitment" | "memo">
    & { operation: Pick<GloamWithdrawalRecord["operation"], "nonce"> },
  receipt: GloamChainReceipt,
): GloamWithdrawalReceipt {
  if (receipt.status !== "success" || !/^0x[0-9a-f]{64}$/i.test(receipt.transactionHash)) {
    throw new Error("The withdrawal transaction is not confirmed successful on-chain.");
  }
  const indices = new Set<number>();
  for (const log of receipt.logs) {
    if (log.removed || log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || indices.has(log.logIndex)) {
      throw new Error("The withdrawal receipt does not have a complete, ordered log history.");
    }
    indices.add(log.logIndex);
  }
  const logs = [...receipt.logs].sort((left, right) => left.logIndex! - right.logIndex!);
  let executing = false;
  let pending: ReceiptLog[] = [];
  let found: { success: boolean; logs: ReceiptLog[] } | null = null;
  for (const log of logs) {
    const fromEntryPoint = same(log.address, ENTRYPOINT);
    const selector = log.topics[0]?.toLowerCase();
    if (fromEntryPoint && selector === BEFORE) {
      executing = true;
      pending = [];
      continue;
    }
    if (fromEntryPoint && selector === USER_OP) {
      const event = decodeEventLog({ abi: GLOAM_RECEIPT_EVENTS, eventName: "UserOperationEvent", data: log.data, topics: topics(log) });
      if (same(event.args.userOpHash, record.hash)) {
        if (found || !executing || !same(event.args.sender, record.account)
          || !same(event.args.paymaster, zeroAddress) || event.args.nonce !== BigInt(record.operation.nonce)) {
          throw new Error("The on-chain operation does not match this saved withdrawal.");
        }
        found = { success: event.args.success, logs: pending };
      }
      pending = [];
      continue;
    }
    if (executing) pending.push(log);
  }
  if (!found) throw new Error("The receipt does not contain this saved withdrawal's EntryPoint operation.");
  if (!found.success) return { success: false, transactionHash: receipt.transactionHash };

  const hasTransfer = found.logs.some((log) => {
    if (!same(log.address, GLOAM_WITHDRAWAL_USDG)) return false;
    try {
      const event = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: topics(log) });
      return same(event.args.from, record.account) && same(event.args.to, GLOAM_WITHDRAWAL_POOL)
        && event.args.value === BigInt(record.amount);
    } catch { return false; }
  });
  const hasShield = found.logs.some((log) => {
    if (!same(log.address, GLOAM_WITHDRAWAL_POOL)) return false;
    try {
      const event = decodeEventLog({ abi: GLOAM_RECEIPT_EVENTS, eventName: "Shielded", data: log.data, topics: topics(log) });
      return same(event.args.commitment, record.commitment) && same(event.args.asset, GLOAM_WITHDRAWAL_USDG)
        && same(event.args.from, record.account) && event.args.amount === BigInt(record.amount);
    } catch { return false; }
  });
  const hasMemo = found.logs.some((log) => {
    if (!same(log.address, GLOAM_WITHDRAWAL_MEMO_BOARD)) return false;
    try {
      const event = decodeEventLog({ abi: GLOAM_RECEIPT_EVENTS, eventName: "PaymentMemo", data: log.data, topics: topics(log) });
      return same(event.args.paymentCommitment, record.commitment) && same(event.args.memo, record.memo);
    } catch { return false; }
  });
  if (!hasTransfer || !hasShield || !hasMemo) {
    throw new Error("This operation does not confirm the USDG deposit and its encrypted recovery memo. Keep the saved withdrawal and check again.");
  }
  return { success: true, transactionHash: receipt.transactionHash };
}
