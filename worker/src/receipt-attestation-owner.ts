/** Read-only proof for preserved owner records beside a sole USDG deposit. */
import { createHash } from "node:crypto";
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from "viem";
import { CASH, ENTRYPOINT, GRANT_PONS_CLASS, GRANT_TRENCHER, grantPonsClassVault, grantTrencher } from "../../packages/core/src/index";
import { opsOfHandleOps, USER_OPERATION_EVENT_TOPIC } from "./asset-movements";
import { classifyRpcError, TRANSFER_TOPIC, type RpcCall } from "./chain-capital";
import { custodyAddressesOf } from "./custody";
import { OWNER_OPERATION_COLUMNS, ownerOperationOf, ownerOperationRow, type OwnerOperationRow } from "./owner-operations";
import { canonicalJson } from "./store";

type Row = Record<string, unknown>;
const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i, QUANTITY = /^0x[0-9a-f]{1,64}$/i;
const ZERO = `0x${"0".repeat(40)}`;
const NONCE_ABI = parseAbi(["function invalidateNonce(uint32 nonce) payable"]);
export const MAX_ATTESTED_OWNER_OPERATIONS = 64;
function refuse(): never { throw new Error("Original receipt attestation refused: owner operations lack complete confirmed no-movement evidence. Preserve the original home and maintenance hold."); }
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function integer(v: unknown): number {
  if ((typeof v !== "number" && (typeof v !== "string" || !/^\d+$/.test(v))) || !Number.isSafeInteger(Number(v)) || Number(v) < 0) refuse();
  return Number(v);
}
function quantity(v: unknown): bigint { if (typeof v !== "string" || !QUANTITY.test(v)) refuse(); return BigInt(v); }
const number = (v: unknown) => { const n = quantity(v); if (n > BigInt(Number.MAX_SAFE_INTEGER)) refuse(); return Number(n); };
const lower = (v: unknown, re: RegExp) => { if (typeof v !== "string" || !re.test(v)) refuse(); return v.toLowerCase(); };
const topic = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;

/** Only public grant fields are queried/persisted. Missing or malformed custody refuses. */
export function attestationCustody(grant: Row): string[] {
  const features = grant.grantFeatures == null ? [] : typeof grant.grantFeatures === "string" ? JSON.parse(grant.grantFeatures) : grant.grantFeatures;
  if (!Array.isArray(features) || features.some(v => typeof v !== "string")) refuse();
  const g = { grantFeatures: features as string[], ponsClassVaultAddress: grant.ponsClassVaultAddress as string | undefined,
    trencherVaultAddress: grant.trencherVaultAddress as string | undefined, trencherFactoryAddress: grant.trencherFactoryAddress as string | undefined };
  if ((features.includes(GRANT_PONS_CLASS) && !grantPonsClassVault(g)) || (features.includes(GRANT_TRENCHER) && !grantTrencher(g))) refuse();
  return [...new Set(custodyAddressesOf(g))].map(a => a.toLowerCase()).sort();
}

/** The original raw rows remain separately bound; this projection compares their meaning. */
export function attestationOwnerRows(rows: Row[], o: { account: string; tenant: string; local: boolean; chainId: number }): OwnerOperationRow[] {
  if (rows.length > MAX_ATTESTED_OWNER_OPERATIONS) refuse();
  const out: OwnerOperationRow[] = [], seen = new Set<string>();
  for (const r of rows) {
    if ((o.local ? r.tenant !== null : r.tenant !== o.tenant) || lower(r.agent_id, ADDRESS) !== o.account
      || integer(r.chain_id) !== o.chainId || r.validator !== "root" || r.disposition !== "acknowledged" || r.review_reason !== null
      || r.source !== "arm-reconcile" || integer(r.recorded_epoch) !== 1 || r.usdg_legs_json !== "[]" || r.covers_logs_json !== "[]" || r.token_moves_json !== "[]"
      || lower(r.paymaster, ADDRESS) !== ZERO || typeof r.gas_wei !== "string" || !/^(0|[1-9]\d*)$/.test(r.gas_wei)) refuse();
    integer(r.id); integer(r.created_at);
    const n = quantity(r.nonce), nonce = `0x${n.toString(16)}`;
    const record = Object.fromEntries(OWNER_OPERATION_COLUMNS.map(c => [c, r[c]])) as unknown as OwnerOperationRow;
    Object.assign(record, { agent_id: o.account, chain_id: o.chainId, user_op_hash: lower(r.user_op_hash, HASH), tx_hash: lower(r.tx_hash, HASH), nonce,
      block_number: integer(r.block_number), block_time: integer(r.block_time), log_index: integer(r.log_index), recorded_epoch: 1, paymaster: ZERO });
    if (seen.has(record.user_op_hash)) refuse();
    seen.add(record.user_op_hash); out.push(record);
  }
  return out.sort((a, b) => a.user_op_hash.localeCompare(b.user_op_hash));
}

export interface AttestedOwnerProof {
  custody: string[];
  operations: Array<{ record: OwnerOperationRow; blockHash: string; callDataHash: string; callKind: "invalidate-nonce" }>;
}

/** Complete bounded coverage; a refused window is never accepted as empty. */
async function ownerEvents(rpc: RpcCall, account: string, head: bigint): Promise<unknown[]> {
  let requests = 0;
  const read = async (from: bigint, to: bigint, depth: number): Promise<unknown[]> => {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (++requests > 256) refuse();
      try {
        const found = await rpc("eth_getLogs", [{ address: ENTRYPOINT.v07, topics: [USER_OPERATION_EVENT_TOPIC, null, topic(account)],
          fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
        if (!Array.isArray(found) || found.length > MAX_ATTESTED_OWNER_OPERATIONS) refuse();
        return found;
      } catch (error) {
        const kind = classifyRpcError(error);
        if (kind === "too-many-results" && from < to && depth < 24) {
          const mid = (from + to) / 2n;
          const left = await read(from, mid, depth + 1), right = await read(mid + 1n, to, depth + 1);
          if (left.length + right.length > MAX_ATTESTED_OWNER_OPERATIONS) refuse();
          return [...left, ...right];
        }
        if (kind !== "rate-limited" || attempt === 5) refuse();
        await new Promise(resolve => setTimeout(resolve, 1_000 * 2 ** attempt));
      }
    }
    return refuse();
  };
  return read(0n, head, 0);
}
interface Log { address: string; topics: string[]; data: string; logIndex: string; blockNumber: string; blockHash: string; transactionHash: string }
function logOf(value: unknown): Log {
  if (!value || typeof value !== "object") refuse();
  const r = value as Row;
  if (!Array.isArray(r.topics) || r.topics.length > 4 || typeof r.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(r.data)
    || (r.removed !== undefined && r.removed !== false)) refuse();
  return { address: lower(r.address, ADDRESS), topics: r.topics.map(t => lower(t, HASH)), data: r.data.toLowerCase(),
    logIndex: `0x${number(r.logIndex).toString(16)}`, blockNumber: `0x${number(r.blockNumber).toString(16)}`,
    blockHash: lower(r.blockHash, HASH), transactionHash: lower(r.transactionHash, HASH) };
}

/**
 * The whole EntryPoint history must equal the recorded set, including an empty
 * set. Unknown, reverted, session-key and unconfirmed operations all refuse.
 * Header fences cover this entire read, not merely the funding receipt read.
 */
export async function proveAttestationOwnerOperations(rpc: RpcCall, o: {
  account: string; chainId: number; custody: string[]; records: OwnerOperationRow[];
  confirmedBlock: bigint; confirmedHash: string; observedHead: bigint; observedHash: string;
}): Promise<AttestedOwnerProof | undefined> {
  const account = lower(o.account, ADDRESS), ep = ENTRYPOINT.v07.toLowerCase(), book = new Set([account, ...o.custody]);
  const confirmedTag = `0x${o.confirmedBlock.toString(16)}`, headTag = `0x${o.observedHead.toString(16)}`;
  const raw = await ownerEvents(rpc, account, o.observedHead);
  if (!Array.isArray(raw) || raw.length !== o.records.length || raw.length > MAX_ATTESTED_OWNER_OPERATIONS) refuse();
  const events = raw.map(logOf), eventsByOp = new Map<string, Log>();
  for (const event of events) {
    if (event.address !== ep || event.topics.length !== 4 || event.topics[0] !== USER_OPERATION_EVENT_TOPIC || event.topics[2] !== topic(account)
      || quantity(event.blockNumber) > o.confirmedBlock || eventsByOp.has(event.topics[1]!)) refuse();
    eventsByOp.set(event.topics[1]!, event);
  }
  const operations: AttestedOwnerProof["operations"] = [];
  const receipts = new Map<string, { logs: Log[]; blockHash: string; blockNumber: number; at: number; input: string }>();
  for (const record of o.records) {
    const event = eventsByOp.get(record.user_op_hash);
    if (!event || event.transactionHash !== record.tx_hash || number(event.blockNumber) !== record.block_number || number(event.logIndex) !== record.log_index) refuse();
    let receipt = receipts.get(record.tx_hash);
    if (!receipt) {
      const r = await rpc("eth_getTransactionReceipt", [record.tx_hash]) as Row | null;
      if (!r || r.status !== "0x1" || lower(r.transactionHash, HASH) !== record.tx_hash || number(r.blockNumber) !== record.block_number
        || lower(r.blockHash, HASH) !== event.blockHash || !Array.isArray(r.logs)) refuse();
      const logs = r.logs.map(logOf), seen = new Set<string>();
      for (const l of logs) {
        if (l.transactionHash !== record.tx_hash || l.blockHash !== event.blockHash || number(l.blockNumber) !== record.block_number || seen.has(l.logIndex)) refuse();
        seen.add(l.logIndex);
        // Include validation, other segments, custody and zero/self transfers.
        // Even an irrelevant malformed Transfer is not evidence of no movement.
        if (l.topics[0] === TRANSFER_TOPIC && (l.topics.length < 3 || (l.topics.length === 3 && !QUANTITY.test(l.data))
          || [l.topics[1], l.topics[2]].some(t => t && book.has(`0x${t.slice(-40)}`)))) refuse();
      }
      const b = await rpc("eth_getBlockByNumber", [event.blockNumber, false]) as Row | null;
      if (!b || number(b.number) !== record.block_number || lower(b.hash, HASH) !== event.blockHash || number(b.timestamp) !== record.block_time) refuse();
      const t = await rpc("eth_getTransactionByHash", [record.tx_hash]) as Row | null;
      if (!t || lower(t.hash, HASH) !== record.tx_hash || lower(t.blockHash, HASH) !== event.blockHash || number(t.blockNumber) !== record.block_number
        || lower(t.to, ADDRESS) !== ep || quantity(t.value) !== 0n || typeof t.input !== "string") refuse();
      receipt = { logs, blockHash: event.blockHash, blockNumber: record.block_number, at: record.block_time, input: t.input };
      receipts.set(record.tx_hash, receipt);
    }
    const matches = receipt.logs.filter(l => l.logIndex === event.logIndex);
    if (matches.length !== 1 || !same(matches[0], event)) refuse();
    const reading = ownerOperationOf({ receiptLogs: receipt.logs, userOpHash: record.user_op_hash, txHash: record.tx_hash,
      account, custody: o.custody, usdg: CASH.USDG, chainId: o.chainId });
    if (!reading || reading.disposition !== "acknowledged" || reading.usdgLegs.length || reading.covers.length || reading.tokenMoves.length
      || !same(ownerOperationRow(reading, { agentId: account, chainId: o.chainId, blockNumber: receipt.blockNumber, blockTime: receipt.at, recordedEpoch: 1 }), record)) refuse();
    const calls = opsOfHandleOps(receipt.input)?.filter(call => call.sender === account && call.nonce === BigInt(record.nonce));
    if (!calls || calls.length !== 1) refuse();
    const data = calls[0]!.callData.toLowerCase();
    // ONLY the canonical direct Kernel authority-removal call is allowed.
    // A generic zero-value execute can still ask another contract to send ETH.
    try {
      const decoded = decodeFunctionData({ abi: NONCE_ABI, data: data as Hex });
      if (decoded.functionName !== "invalidateNonce" || encodeFunctionData({ abi: NONCE_ABI, functionName: "invalidateNonce", args: decoded.args }) !== data) refuse();
    } catch { refuse(); }
    operations.push({ record, blockHash: receipt.blockHash, callDataHash: createHash("sha256").update(data).digest("hex"),
      callKind: "invalidate-nonce" });
  }
  for (const [tag, expected] of [[confirmedTag, o.confirmedHash], [headTag, o.observedHash]] as const) {
    const header = await rpc("eth_getBlockByNumber", [tag, false]) as Row | null;
    if (!header || quantity(header.number) !== BigInt(tag) || lower(header.hash, HASH) !== expected.toLowerCase()) refuse();
  }
  return operations.length ? { custody: [...o.custody], operations } : undefined;
}
