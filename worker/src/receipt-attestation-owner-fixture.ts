/** Synthetic confirmed revocations for SQLite and opt-in local PostgreSQL tests. */
import { createHash } from "node:crypto";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { ENTRYPOINT, CASH } from "../../packages/core/src/index";
import { BEFORE_EXECUTION_TOPIC, USER_OPERATION_EVENT_TOPIC } from "./asset-movements";
import type { RpcCall } from "./chain-capital";
import { OWNER_OPERATION_COLUMNS, ownerOperationOf, ownerOperationRow } from "./owner-operations";
import { receiptFixture, TEST_ACCOUNT, TEST_TENANT } from "./receipt-attestation-fixture";

export const OWNER_HANDLE_OPS_ABI = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
]);
const NONCE_ABI = parseAbi(["function invalidateNonce(uint32 nonce) payable"]);
const ZERO = `0x${"0".repeat(40)}` as Hex, WORD = `0x${"0".repeat(64)}` as Hex;
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const topic = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}`;
export interface SyntheticOwnerLog { address: string; topics: string[]; data: string; logIndex: string; blockNumber: string; blockHash: string; transactionHash: string; removed: false }
export interface SyntheticOwnerReceipt { status: string; transactionHash: string; blockNumber: string; blockHash: string; logs: SyntheticOwnerLog[] }

export async function seedOwnerRevocations(f: Awaited<ReturnType<typeof receiptFixture>>, count = 2) {
  const receipts = new Map<string, SyntheticOwnerReceipt>();
  const transactions = new Map<string, { hash: string; blockHash: string; blockNumber: string; to: string; value: string; input: string }>();
  const opLogs: SyntheticOwnerLog[] = [];
  for (let i = 1; i <= count; i++) {
    const tx = `0x${createHash("sha256").update(`synthetic owner tx ${i}`).digest("hex")}`;
    const opHash = `0x${createHash("sha256").update(`synthetic owner op ${i}`).digest("hex")}`;
    const base = { blockNumber: "0x58", blockHash: `0x${"ba".repeat(32)}`, transactionHash: tx, removed: false as const };
    const logs: SyntheticOwnerLog[] = [
      { ...base, address: ENTRYPOINT.v07, topics: [BEFORE_EXECUTION_TOPIC], data: "0x", logIndex: "0x0" },
      { ...base, address: ENTRYPOINT.v07, topics: [USER_OPERATION_EVENT_TOPIC, opHash, topic(TEST_ACCOUNT), topic(ZERO)],
        data: `0x${word(BigInt(i))}${word(1n)}${word(777n)}${word(55n)}`, logIndex: "0x1" },
    ];
    opLogs.push(logs[1]!);
    receipts.set(tx, { status: "0x1", transactionHash: tx, blockNumber: base.blockNumber, blockHash: base.blockHash, logs });
    const callData = encodeFunctionData({ abi: NONCE_ABI, functionName: "invalidateNonce", args: [i + 1] });
    transactions.set(tx, { hash: tx, blockHash: base.blockHash, blockNumber: base.blockNumber, to: ENTRYPOINT.v07, value: "0x0",
      input: encodeFunctionData({ abi: OWNER_HANDLE_OPS_ABI, functionName: "handleOps", args: [[{ sender: TEST_ACCOUNT.toLowerCase() as Hex, nonce: BigInt(i),
        initCode: "0x", callData, accountGasLimits: WORD, preVerificationGas: 1n, gasFees: WORD, paymasterAndData: "0x", signature: "0x" }], ZERO] }) });
    const reading = ownerOperationOf({ receiptLogs: logs, userOpHash: opHash, txHash: tx, account: TEST_ACCOUNT, custody: [], usdg: CASH.USDG, chainId: 4663 })!;
    const row = ownerOperationRow(reading, { agentId: TEST_ACCOUNT, chainId: 4663, blockNumber: 88, blockTime: 1791581459, recordedEpoch: 1 });
    for (const [db, id, tenant] of [[f.local, i, null], [f.shared, 100 + i, TEST_TENANT]] as const) {
      await db.prepare(`INSERT INTO owner_operations(id,tenant,${OWNER_OPERATION_COLUMNS.join(",")},created_at) VALUES(?,?,${OWNER_OPERATION_COLUMNS.map(() => "?").join(",")},?)`)
        .run(id, tenant, ...OWNER_OPERATION_COLUMNS.map(c => row[c]), 1791595802);
    }
  }
  if (count) await f.shared.prepare("INSERT INTO mirror_state(tenant,table_name,last_id,last_stamp,updated_at) VALUES(?,'owner_operations',?,1791595802,1791595803)").run(TEST_TENANT, count);
  const rpc: RpcCall = async (method, params) => {
    if (method === "eth_getTransactionReceipt" && receipts.has(String(params[0]))) return receipts.get(String(params[0]));
    if (method === "eth_getTransactionByHash" && transactions.has(String(params[0]))) return transactions.get(String(params[0]));
    if (method === "eth_getLogs") {
      const filter = params[0] as { topics: unknown[]; fromBlock: string; toBlock: string };
      if (filter.topics[0] === USER_OPERATION_EVENT_TOPIC) return opLogs.filter(log => BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock));
    }
    return f.rpc(method, params);
  };
  f.options.rpc = rpc;
  return { rpc, receipts, transactions, opLogs };
}
