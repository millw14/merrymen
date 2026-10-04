import { decodeEventLog, formatUnits, parseAbi, type Hex, type PublicClient } from "viem";
import { CASH_FEEDS, CHAINLINK_ABI, ENTRYPOINT, robinhoodChain } from "../../packages/core/src/index";
import type { Db } from "./db";
import { findRoundAt, priceGasAtRound, type FeedRound } from "./gas-backfill";
import { boundedRead } from "./optional-read-deadline";
import { createHash } from "node:crypto";

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

/** Exact event identity and finality are checked before accepting even a sponsored zero owner expense. */
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

/** A compare-and-fill update. Existing authority, verdict, timestamps for caps, and monetary evidence stay intact. */
export async function writeRecoveredGas(db: Db, row: GasRecoveryRow, proof: RecoveredGas): Promise<boolean> {
  if (proof.account.toLowerCase() !== row.agent_id.toLowerCase() || proof.epoch !== row.epoch ||
    proof.userOpHash.toLowerCase() !== row.user_op_hash.toLowerCase() ||
    proof.txHash.toLowerCase() !== row.tx_hash.toLowerCase()) return false;
  const paid = proof.payer === "owner" ? proof.gasWei : null;
  const sponsored = proof.payer === "sponsor" ? proof.gasWei : null;
  if ((paid === null || row.gas_wei !== null) && (sponsored === null || row.sponsored_gas_wei !== null) &&
    row.gas_units !== null && (proof.usdg === null || row.gas_usdg !== null) && row.gas_recorded_at !== null) return false;
  const updated = await db.prepare(`UPDATE trades SET gas_wei = COALESCE(gas_wei, ?),
    sponsored_gas_wei = COALESCE(sponsored_gas_wei, ?), gas_units = COALESCE(gas_units, ?),
    gas_usdg = COALESCE(gas_usdg, ?), gas_recorded_at = COALESCE(gas_recorded_at, ?)
    WHERE id = ? AND LOWER(agent_id) = ? AND epoch = ? AND status = ?
      AND LOWER(user_op_hash) = ? AND LOWER(tx_hash) = ?
      AND COALESCE(user_op_nonce, '') = ?
      AND COALESCE(gas_wei, '') = ? AND COALESCE(sponsored_gas_wei, '') = ?
      AND COALESCE(gas_units, '') = ? AND COALESCE(gas_usdg, -1) = ?
      AND COALESCE(gas_recorded_at, -1) = ?
      AND EXISTS (SELECT 1 FROM agents a WHERE LOWER(a.smart_account) = ? AND a.epoch = ? AND a.chain_id = ?)
      AND NOT EXISTS (SELECT 1 FROM agents a WHERE LOWER(a.smart_account) = ? AND a.epoch > ?)
      AND ? = (SELECT a.chain_id FROM agents a WHERE LOWER(a.smart_account) = ?
        ORDER BY a.epoch DESC, COALESCE(a.beat_at, 0) DESC, a.created_at DESC, a.smart_account LIMIT 1)`)
    .run(paid, sponsored, proof.gasUnits, proof.usdg, proof.at,
      row.id, row.agent_id.toLowerCase(), row.epoch, row.status,
      row.user_op_hash.toLowerCase(), row.tx_hash.toLowerCase(), row.user_op_nonce ?? "",
      row.gas_wei ?? "", row.sponsored_gas_wei ?? "", row.gas_units ?? "", row.gas_usdg ?? -1,
      row.gas_recorded_at ?? -1, row.agent_id.toLowerCase(), row.epoch, proof.chainId,
      row.agent_id.toLowerCase(), row.epoch, proof.chainId, row.agent_id.toLowerCase());
  return updated.changes > 0;
}

/** Bounded retry cursor prevents one unreadable old receipt starving the rest of an agent's history. */
export async function recoverSettledGas(opts: {
  db: Db; chain: GasRecoveryChain; account: string; epoch: number; chainId: number;
  afterId?: number; limit?: number; budgetMs?: number;
  record(row: GasRecoveryRow, proof: RecoveredGas): Promise<boolean>;
}): Promise<{ afterId: number; recovered: number }> {
  const afterId = opts.afterId ?? 0;
  const budget = Math.max(1, Math.min(8_000, opts.budgetMs ?? 8_000));
  const deadline = Date.now() + budget;
  const read = async <T>(fn: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("gas recovery budget exhausted");
    const result = await boundedRead(fn, remaining);
    if (result === null) throw new Error("gas recovery read unavailable");
    return result;
  };
  let cursor = afterId, recovered = 0;
  try {
    if (!ADDRESS.test(opts.account) || !Number.isSafeInteger(opts.epoch) || opts.epoch < 1 ||
      await read(() => opts.chain.chainId()) !== opts.chainId) return { afterId, recovered };
    const rows = await read(() => opts.db.prepare(`SELECT id, agent_id, epoch, status, user_op_hash, tx_hash, user_op_nonce,
      gas_wei, sponsored_gas_wei, gas_units, gas_usdg, gas_recorded_at FROM trades
      WHERE LOWER(agent_id) = ? AND epoch = ? AND status IN ('landed', 'reverted')
      AND id > ? AND user_op_hash IS NOT NULL AND tx_hash IS NOT NULL
      AND (gas_recorded_at IS NULL OR gas_units IS NULL OR
        (gas_wei IS NULL AND sponsored_gas_wei IS NULL) OR
        (gas_wei IS NOT NULL AND gas_wei <> '0' AND gas_usdg IS NULL))
      ORDER BY id LIMIT ?`).all(opts.account.toLowerCase(), opts.epoch, afterId,
        Math.max(1, Math.min(5, opts.limit ?? 5)))) as GasRecoveryRow[];
    if (!rows.length) return { afterId: 0, recovered: 0 };
    const head = await read(() => opts.chain.head());
    const guarded: GasRecoveryChain = {
      chainId: () => read(() => opts.chain.chainId()), head: () => read(() => opts.chain.head()),
      receipt: h => read(() => opts.chain.receipt(h)), block: n => read(() => opts.chain.block(n)),
      latestRound: () => read(() => opts.chain.latestRound()), round: id => read(() => opts.chain.round(id)),
    };
    for (const row of rows) {
      if (Date.now() >= deadline) break;
      cursor = row.id;
      try {
        const proof = await recoverGasProof(row, guarded, opts.chainId, head);
        if (proof && Date.now() < deadline && await opts.record(row, proof)) recovered++;
      } catch { /* retain unknown evidence and retry on the next cursor cycle */ }
    }
  } catch { /* recovery cannot prevent normal ledger reads or trading checks */ }
  return { afterId: cursor, recovered };
}

export const GAS_RECOVERY_SCHEMA = `CREATE TABLE IF NOT EXISTS gas_recovery_receipts (
  proof_hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, epoch INTEGER NOT NULL,
  user_op_hash TEXT NOT NULL, tx_hash TEXT NOT NULL, proof_json TEXT NOT NULL,
  recovered_at INTEGER NOT NULL
)`;

/** Additive evidence is durable in the shared ledger, including after a child directory is rebuilt. */
export async function recordRecoveredGas(db: Db, row: GasRecoveryRow, proof: RecoveredGas): Promise<boolean> {
  return db.tx(async tx => {
    if (!await writeRecoveredGas(tx, row, proof)) return false;
    const json = JSON.stringify(proof);
    await tx.prepare(`INSERT INTO gas_recovery_receipts
      (proof_hash, agent_id, epoch, user_op_hash, tx_hash, proof_json, recovered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (proof_hash) DO NOTHING`)
      .run(createHash("sha256").update(json).digest("hex"), proof.account.toLowerCase(), proof.epoch,
        proof.userOpHash.toLowerCase(), proof.txHash.toLowerCase(), json, Math.floor(Date.now() / 1000));
    return true;
  });
}

/** Canonical current books only; a historical alias cannot drag another epoch into a return. */
export async function gasRecoveryAccounts(db: Db): Promise<{ account: string; epoch: number; chainId: number }[]> {
  const rows = await db.prepare(`WITH ranked AS (
    SELECT smart_account, epoch, chain_id, ROW_NUMBER() OVER (
      PARTITION BY LOWER(smart_account) ORDER BY epoch DESC, COALESCE(beat_at, 0) DESC, created_at DESC, smart_account
    ) AS rank FROM agents
  ) SELECT LOWER(a.smart_account) AS account, a.epoch, a.chain_id FROM ranked a
    WHERE a.rank = 1 AND a.chain_id = ? AND EXISTS (
      SELECT 1 FROM trades t WHERE LOWER(t.agent_id) = LOWER(a.smart_account) AND t.epoch = a.epoch
      AND t.status IN ('landed', 'reverted') AND t.user_op_hash IS NOT NULL AND t.tx_hash IS NOT NULL
      AND (t.gas_recorded_at IS NULL OR t.gas_units IS NULL OR (t.gas_wei IS NULL AND t.sponsored_gas_wei IS NULL)
        OR (t.gas_wei IS NOT NULL AND t.gas_wei <> '0' AND t.gas_usdg IS NULL))
    ) ORDER BY account`).all(robinhoodChain.id) as { account: string; epoch: number; chain_id: number }[];
  return rows.map(row => ({ account: row.account, epoch: Number(row.epoch), chainId: Number(row.chain_id) }));
}
