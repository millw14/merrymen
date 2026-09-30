/** Verify public recovery evidence; never clear an incident or send a transaction here. */
import { decodeEventLog, parseAbi, toEventSelector, type Hex } from "viem";
import { ENTRYPOINT, LIGHTER_ROUTE_V1, readPerpRecoveryReference, type PerpRecoveryReference } from "../../../packages/core/src/index";
import type { ReceiptLog } from "../fills";
import { opLogsOf } from "../inflight-reconcile";
import { changePubKeyOf, LIGHTER_PRIORITY_REQUEST_TOPIC, PRIORITY_ABI } from "./legs";

export type OwnerRecoveryReference = PerpRecoveryReference;
export interface RecoveryReceipt {
  status: "success" | "reverted";
  transactionHash: string;
  blockHash: string;
  blockNumber: bigint;
  logs: readonly ReceiptLog[];
}
export interface VerifiedOwnerRecovery {
  reference: PerpRecoveryReference;
  blockHash: string;
  blockNumber: bigint;
  rotationLogIndex: number;
}
export interface OwnerRecoveryProofDeps {
  now(): number;
  smartAccount: string;
  incidentId: string;
  evidenceDigest: string;
  oldPublicKey: string;
  newPublicKey: string;
  retiredKeys: readonly string[];
  readChainId(): Promise<number>;
  readReceipt(hash: `0x${string}`): Promise<RecoveryReceipt | null>;
  readCanonicalBlockHash(blockNumber: bigint): Promise<string | null>;
  readAccountIndex(): Promise<bigint | null>;
  readSlot(): Promise<string | null>;
  /** True only for fresh, exact account evidence: zero positions/orders and no unresolved local operations. */
  readFlat(): Promise<boolean | null>;
}
export type OwnerRecoveryProofResult = { ok: true; verified: VerifiedOwnerRecovery } | { ok: false; why: string };
const USEROP_ABI = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
const USEROP_TOPIC = toEventSelector(USEROP_ABI[0]).toLowerCase();
const HASH = /^0x[a-f0-9]{64}$/;
const REFUSAL_WINDOW_MS = 15 * 60_000;
const refuse = (why: string): OwnerRecoveryProofResult => ({ ok: false, why });
function logIndex(value: ReceiptLog["logIndex"]): number | null {
  if (typeof value !== "number" && typeof value !== "bigint" && !(typeof value === "string" && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** The caller authenticates the owner, and atomically rechecks the incident/evidence before committing this result. */
export async function verifyOwnerRecoveryProof(value: unknown, d: OwnerRecoveryProofDeps): Promise<OwnerRecoveryProofResult> {
  const ref = readPerpRecoveryReference(value);
  if (!ref) return refuse("The recovery reference is malformed.");
  const validTime = () => Number.isSafeInteger(d.now()) && d.now() < ref.notAfterMs && ref.notAfterMs <= d.now() + REFUSAL_WINDOW_MS;
  if (!validTime()) return refuse("The recovery acknowledgement expired or exceeds its review window.");
  if (ref.smartAccount !== d.smartAccount.toLowerCase() || ref.incidentId !== d.incidentId || ref.evidenceDigest !== d.evidenceDigest ||
      ref.oldPublicKey !== d.oldPublicKey.toLowerCase() || ref.newPublicKey !== d.newPublicKey.toLowerCase()) {
    return refuse("The recovery does not match this account, incident, evidence or signed key.");
  }
  if (d.retiredKeys.some(k => k.toLowerCase() === ref.newPublicKey)) return refuse("A retired trading key cannot be re-enabled.");
  try {
    if (await d.readChainId() !== LIGHTER_ROUTE_V1.chainId) return refuse("The recovery was read on another chain.");
    const receipt = await d.readReceipt(ref.txHash);
    if (!receipt || receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== ref.txHash ||
        typeof receipt.blockNumber !== "bigint" || receipt.blockNumber < 0n || !HASH.test(receipt.blockHash.toLowerCase())) {
      return refuse("The recovery transaction is not confirmed with a readable receipt.");
    }
    if ((await d.readCanonicalBlockHash(receipt.blockNumber))?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      return refuse("The recovery receipt is no longer on the canonical chain.");
    }
    const indexes = new Set<number>();
    const operations: { index: number; sender: string; success: boolean }[] = [];
    for (const log of receipt.logs) {
      const index = logIndex(log.logIndex);
      if (index === null || indexes.has(index) || (log as ReceiptLog & { removed?: boolean }).removed === true ||
          (log.transactionHash != null && log.transactionHash.toLowerCase() !== ref.txHash)) {
        return refuse("The recovery receipt has ambiguous or removed log positions.");
      }
      indexes.add(index);
      if (log.address.toLowerCase() !== ENTRYPOINT.v07.toLowerCase() || String(log.topics[0]).toLowerCase() !== USEROP_TOPIC) continue;
      const event = decodeEventLog({ abi: USEROP_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
      if (event.args.userOpHash.toLowerCase() === ref.userOpHash) operations.push({ index, sender: event.args.sender.toLowerCase(), success: event.args.success });
    }
    if (operations.length !== 1 || !operations[0]!.success || operations[0]!.sender !== ref.smartAccount) {
      return refuse("The receipt does not prove one successful operation for this account.");
    }
    const ownLogs = opLogsOf(receipt.logs, operations[0]!.index);
    if (!ownLogs) return refuse("The recovery operation could not be isolated from its bundle.");
    const rotations: { index: number; key: NonNullable<ReturnType<typeof changePubKeyOf>> }[] = [];
    for (const log of ownLogs) {
      if (log.address.toLowerCase() !== LIGHTER_ROUTE_V1.proxy || String(log.topics[0]).toLowerCase() !== LIGHTER_PRIORITY_REQUEST_TOPIC) continue;
      const event = decodeEventLog({ abi: PRIORITY_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
      if (event.args.sender.toLowerCase() !== ref.smartAccount) return refuse("The recovery contains a priority request for another account.");
      if (Number(event.args.pubdataType) !== 62) continue; // Owner recovery also cancels and withdraws.
      const key = changePubKeyOf(event.args.pubData);
      if (!key) return refuse("The recovery key-change event is malformed.");
      rotations.push({ index: logIndex(log.logIndex)!, key });
    }
    if (rotations.length !== 1) return refuse("The recovery must contain exactly one verified key rotation.");
    const rotation = rotations[0]!;
    if (rotation.key.accountIndex !== BigInt(ref.accountIndex) || rotation.key.masterAccountIndex !== BigInt(ref.accountIndex) ||
        rotation.key.apiKeyIndex !== ref.apiKeyIndex || rotation.key.publicKey !== ref.recoveryPublicKey) {
      return refuse("The recovery rotated a different account, slot or public key.");
    }
    const [index, slot, flat] = await Promise.all([d.readAccountIndex(), d.readSlot(), d.readFlat()]);
    if (index !== BigInt(ref.accountIndex) || slot?.toLowerCase() !== ref.recoveryPublicKey || flat !== true) {
      return refuse("The current venue mapping, recovery key or flat account could not be verified.");
    }
    if (!validTime()) return refuse("The recovery acknowledgement expired while verification was running.");
    return { ok: true, verified: { reference: ref, blockHash: receipt.blockHash.toLowerCase(), blockNumber: receipt.blockNumber, rotationLogIndex: rotation.index } };
  } catch {
    return refuse("Recovery evidence could not be read or decoded; trading remains halted.");
  }
}
