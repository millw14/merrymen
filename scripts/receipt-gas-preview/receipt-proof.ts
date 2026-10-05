import { decodeEventLog, formatUnits, parseAbi, type Hex, type PublicClient } from "viem";
import { CASH_FEEDS } from "../../packages/core/src/tokens.ts";
import { CHAINLINK_ABI } from "../../packages/core/src/abis.ts";
import { ENTRYPOINT, robinhoodChain } from "../../packages/core/src/chain.ts";
import { findRoundAt, priceGasAtRound, type FeedRound } from "../../worker/src/gas-backfill.ts";

const EVENT = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ZERO = /^0x0{40}$/i;
const CONFIRMATIONS = 64n;

export interface GasRecoveryRow {
  id: number; agent_id: string; epoch: number; status: "landed" | "reverted";
  user_op_hash: string; tx_hash: string; user_op_nonce: string | null;
  gas_wei: string | null; sponsored_gas_wei: string | null; gas_units: string | null;
  gas_usdg: number | null; gas_recorded_at: number | null;
}
export interface GasReceipt {
  transactionHash: string; blockHash: string; blockNumber: bigint; status: string;
  logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[];
}
export interface GasRecoveryChain {
  chainId(): Promise<number>;
  head(): Promise<bigint>;
  receipt(hash: Hex): Promise<GasReceipt>;
  block(number: bigint): Promise<{ hash: string | null; timestamp: bigint }>;
  latestRound(): Promise<FeedRound | null>;
  round(id: bigint): Promise<FeedRound | null>;
}
export interface RecoveredGas {
  account: string; epoch: number; chainId: number; userOpHash: string; txHash: string;
  blockHash: string; blockNumber: string; at: number; nonce: string;
  gasWei: string; gasUnits: string; payer: "owner" | "sponsor";
  usdg: number | null;
  price?: { feed: string; roundId: string; priceUsd: number; updatedAt: number };
}

/** Receipt reads only. It cannot sign, broadcast, settle a budget, or change a trade's verdict. */
export function gasRecoveryChain(client: PublicClient): GasRecoveryChain {
  let decimals: Promise<number> | undefined;
  const rounds = new Map<string, FeedRound>();
  const round = async (id?: bigint): Promise<FeedRound | null> => {
    if (id !== undefined && rounds.has(id.toString())) return rounds.get(id.toString())!;
    if (!decimals) {
      const pending = client.readContract({ address: CASH_FEEDS.ETH_USD, abi: CHAINLINK_ABI, functionName: "decimals" });
      decimals = pending;
      void pending.catch(() => { if (decimals === pending) decimals = undefined; });
    }
    const [places, data] = await Promise.all([decimals, id === undefined
      ? client.readContract({ address: CASH_FEEDS.ETH_USD, abi: CHAINLINK_ABI, functionName: "latestRoundData" })
      : client.readContract({ address: CASH_FEEDS.ETH_USD, abi: CHAINLINK_ABI, functionName: "getRoundData", args: [id] })]);
    if (places < 0 || places > 18 || data[0] <= 0n || data[1] <= 0n || data[3] <= 0n ||
      data[4] < data[0] || (id !== undefined && data[0] !== id)) return null;
    const updatedAt = Number(data[3]);
    const priceUsd = Number(formatUnits(data[1], places));
    if (!Number.isSafeInteger(updatedAt) || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
    const result = { roundId: data[0], priceUsd, updatedAt };
    rounds.set(result.roundId.toString(), result);
    return result;
  };
  return {
    chainId: () => client.getChainId(), head: () => client.getBlockNumber(),
    receipt: hash => client.getTransactionReceipt({ hash }),
    block: blockNumber => client.getBlock({ blockNumber }),
    latestRound: () => round(), round: id => round(id),
  };
}

/** Exact event identity and confirmation depth are checked before accepting even a sponsored zero owner expense. */
export async function recoverGasProof(row: GasRecoveryRow, chain: GasRecoveryChain,
  chainId: number, head: bigint): Promise<RecoveredGas | null> {
  if (!ADDRESS.test(row.agent_id) || !HASH.test(row.tx_hash) || !HASH.test(row.user_op_hash)) return null;
  if (row.gas_usdg !== null && (!Number.isFinite(row.gas_usdg) || row.gas_usdg < 0)) return null;
  const receipt = await chain.receipt(row.tx_hash as Hex);
  if (receipt.transactionHash.toLowerCase() !== row.tx_hash.toLowerCase() || receipt.status !== "success" ||
    !HASH.test(receipt.blockHash) || receipt.blockNumber <= 0n || head - receipt.blockNumber < CONFIRMATIONS) return null;
  const matches = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ENTRYPOINT.v07.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: EVENT, topics: log.topics as [Hex, ...Hex[]], data: log.data });
      if (event.args.userOpHash.toLowerCase() === row.user_op_hash.toLowerCase()) matches.push(event.args);
    } catch { /* unrelated receipt log */ }
  }
  if (matches.length !== 1) return null;
  const event = matches[0]!;
  if (event.sender.toLowerCase() !== row.agent_id.toLowerCase() ||
    event.success !== (row.status === "landed") || event.actualGasCost < 0n || event.actualGasUsed < 0n ||
    (row.user_op_nonce !== null && row.user_op_nonce !== "" && row.user_op_nonce !== event.nonce.toString())) return null;
  const block = await chain.block(receipt.blockNumber);
  const at = Number(block.timestamp);
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase() || !Number.isSafeInteger(at) || at <= 0) return null;
  const payer = ZERO.test(event.paymaster) ? "owner" : "sponsor";
  // A stale/corrupt record never gets papered over by recovered evidence.
  if ((payer === "owner" && row.sponsored_gas_wei !== null) ||
    (payer === "sponsor" && row.gas_wei !== null) ||
    (row.gas_units !== null && row.gas_units !== event.actualGasUsed.toString()) ||
    (row.gas_recorded_at !== null && row.gas_recorded_at !== at) ||
    (payer === "owner" && row.gas_wei !== null && row.gas_wei !== event.actualGasCost.toString()) ||
    (payer === "sponsor" && row.sponsored_gas_wei !== null && row.sponsored_gas_wei !== event.actualGasCost.toString()) ||
    ((payer === "sponsor" || event.actualGasCost === 0n) && row.gas_usdg !== null && row.gas_usdg !== 0)) return null;
  const proof: RecoveredGas = { account: row.agent_id, epoch: row.epoch, chainId,
    userOpHash: row.user_op_hash, txHash: row.tx_hash, blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(), at, nonce: event.nonce.toString(),
    gasWei: event.actualGasCost.toString(), gasUnits: event.actualGasUsed.toString(), payer,
    usdg: payer === "sponsor" || event.actualGasCost === 0n ? 0 : null };
  if (payer === "owner" && event.actualGasCost > 0n) {
    // The registered mainnet feed is the only historical pricing source here.
    // No present-day price, spot quote, stale round, or other-chain feed is accepted.
    if (chainId !== robinhoodChain.id) return row.gas_usdg === null ? proof : null;
    try {
      const latest = await chain.latestRound();
      if (latest) {
        const historical = await findRoundAt(at, latest, id => chain.round(id));
        // A skipped/unreadable round in the search cannot establish the price
        // in force. Its immediate successor must prove the chosen round still
        // governed this block; unavailable boundaries keep the cost unpriced.
        const successor = historical && historical.roundId < latest.roundId
          ? await chain.round(historical.roundId + 1n) : null;
        const boundaryKnown = historical && (historical.roundId === latest.roundId ||
          (successor !== null && successor.roundId === historical.roundId + 1n && successor.updatedAt > at));
        const price = priceGasAtRound({ gasWei: event.actualGasCost, tradeAtSec: at, round: historical });
        if (boundaryKnown && price.kind === "priced" && historical && Number.isFinite(price.usdg) && price.usdg >= 0) {
          proof.usdg = Math.trunc(price.usdg * 1e6) / 1e6;
          proof.price = { feed: CASH_FEEDS.ETH_USD, roundId: historical.roundId.toString(),
            priceUsd: historical.priceUsd, updatedAt: historical.updatedAt };
        }
      }
    } catch { /* receipt cost survives an unavailable historical price */ }
    // Filling receipt fields can make a stored cost newly publishable. That
    // monetary value must agree with independent historical evidence first;
    // an unknown or conflicting price leaves the existing record untouched.
    if (row.gas_usdg !== null && row.gas_usdg !== proof.usdg) return null;
  }
  return proof;
}
