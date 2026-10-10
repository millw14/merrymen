/** Receipt evidence for a genuinely new hosted book. Never an established-book backfill. */
import { CASH } from "../../packages/core/src/index";
import { scanFleetCapital, TRANSFER_TOPIC, type RawChainLog, type RpcCall } from "./chain-capital";
import { BOOKING_CONFIRMATIONS } from "./chain-confirmations";

export interface InitialCapitalDeposit {
  txHash: string;
  blockNumber: number;
  logIndex: number;
  at: number;
  amountUsdg6: bigint;
}
export interface InitialCapital {
  account: string;
  chainId: number;
  blockNumber: bigint;
  blockHash: string;
  cashUsdg6: bigint;
  deposits: InitialCapitalDeposit[];
}
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const HEX = /^0x[0-9a-f]+$/i;
const MAX_DEPOSITS = 64;
const refused = () => new Error("Initial capital receipts are incomplete or do not describe an untouched funded account.");
const integer = (value: unknown): bigint => {
  if (typeof value !== "string" || !HEX.test(value)) throw refused();
  return BigInt(value);
};
const logKey = (l: RawChainLog) => `${l.transactionHash.toLowerCase()}:${integer(l.logIndex)}`;
function sameLog(a: RawChainLog, b: RawChainLog): boolean {
  return a.address.toLowerCase() === b.address.toLowerCase() && a.data.toLowerCase() === b.data.toLowerCase()
    && a.blockNumber.toLowerCase() === b.blockNumber.toLowerCase()
    && JSON.stringify(a.topics.map(t => t.toLowerCase())) === JSON.stringify(b.topics.map(t => t.toLowerCase()));
}

/**
 * Scan genesis through one confirmed snapshot, then reconcile receipts with
 * balanceOf at that same block. Require the unconfirmed tail to be empty in
 * both directions, so recent or offsetting flows cannot hide from this proof.
 * Only deposits are accepted: a withdrawal, swap, reserve
 * purchase, missing receipt, conflicting log or reorg holds the first funding.
 * The caller must possess the bootstrap's new-account or untouched-book
 * receipt licence. An RPC failure never licenses an inferred opening balance.
 */
export async function readInitialCapital(rpc: RpcCall, o: {
  account: string; chainId: number; licence: string;
}): Promise<InitialCapital> {
  if (!["new-account", "untouched-book"].includes(o.licence)) throw refused();
  return readUntouchedFundingReceipts(rpc, o);
}

/** Chain evidence only; this grants no permission to change an accounting book. */
export async function readUntouchedFundingReceipts(rpc: RpcCall, o: {
  account: string; chainId: number;
}): Promise<InitialCapital> {
  if (!ADDRESS.test(o.account) || !Number.isSafeInteger(o.chainId) || o.chainId <= 0) throw refused();
  if (integer(await rpc("eth_chainId", [])) !== BigInt(o.chainId)) throw refused();
  const head = integer(await rpc("eth_blockNumber", []));
  if (head < BOOKING_CONFIRMATIONS || head > BigInt(Number.MAX_SAFE_INTEGER)) throw refused();
  const blockNumber = head - BOOKING_CONFIRMATIONS;
  const tag = `0x${blockNumber.toString(16)}`;
  const headTag = `0x${head.toString(16)}`;
  const first = await rpc("eth_getBlockByNumber", [tag, false]) as { number?: unknown; hash?: unknown } | null;
  if (!first || integer(first.number) !== blockNumber || typeof first.hash !== "string" || !HASH.test(first.hash)) throw refused();
  const firstHead = await rpc("eth_getBlockByNumber", [headTag, false]) as { number?: unknown; hash?: unknown } | null;
  if (!firstHead || integer(firstHead.number) !== head || typeof firstHead.hash !== "string" || !HASH.test(firstHead.hash)) throw refused();
  const account = o.account.toLowerCase();
  const accountTopic = `0x${account.slice(2).padStart(64, "0")}`;
  // The maintenance reader has no tick balance to compare against. Prove that
  // nothing moved after the confirmed snapshot, even if it moved out and back.
  // This fixed 64-block window needs no broad historical fallback: unread holds.
  for (const topics of [[TRANSFER_TOPIC, accountTopic], [TRANSFER_TOPIC, null, accountTopic]]) {
    const tail = await rpc("eth_getLogs", [{ address: CASH.USDG, topics,
      fromBlock: `0x${(blockNumber + 1n).toString(16)}`, toBlock: headTag }]);
    if (!Array.isArray(tail) || tail.length !== 0) throw refused();
  }
  const found = new Map<string, RawChainLog & { blockHash: string }>();
  const verified: RpcCall = async (method, params) => {
    const value = await rpc(method, params);
    if (method === "eth_getLogs") {
      if (!Array.isArray(value)) throw refused();
      for (const raw of value) {
        const l = raw as RawChainLog & { removed?: unknown; blockHash: string };
        if (!l || !ADDRESS.test(l.address) || !HASH.test(l.transactionHash) || !Array.isArray(l.topics)
          || l.topics.length !== 3 || l.topics.some(t => !HASH.test(t)) || !/^0x[0-9a-f]{64}$/i.test(l.data)
          || !HASH.test(l.blockHash) || l.removed === true || integer(l.blockNumber) > blockNumber || integer(l.logIndex) > BigInt(Number.MAX_SAFE_INTEGER)) throw refused();
        const prior = found.get(logKey(l));
        if (prior && (!sameLog(prior, l) || prior.blockHash !== l.blockHash)) throw refused();
        found.set(logKey(l), l);
        if (found.size > MAX_DEPOSITS) throw refused();
      }
    }
    if (method === "eth_getTransactionReceipt") {
      const r = value as { status?: unknown; transactionHash?: unknown; blockNumber?: unknown; blockHash?: unknown; logs?: RawChainLog[] } | null;
      if (!r || r.status !== "0x1" || typeof r.transactionHash !== "string"
        || r.transactionHash.toLowerCase() !== String(params[0]).toLowerCase() || !Array.isArray(r.logs)) throw refused();
      for (const l of found.values()) {
        if (l.transactionHash.toLowerCase() !== r.transactionHash.toLowerCase()) continue;
        if (integer(r.blockNumber) !== integer(l.blockNumber) || r.blockHash !== l.blockHash) throw refused();
        const matches = r.logs.filter(x => x.transactionHash?.toLowerCase() === l.transactionHash.toLowerCase()
          && typeof x.logIndex === "string" && integer(x.logIndex) === integer(l.logIndex));
        if (matches.length !== 1 || !sameLog(l, matches[0]!)) throw refused();
      }
    }
    if (method === "eth_getBlockByNumber") {
      const header = value as { number?: unknown; hash?: unknown } | null;
      if (!header || integer(header.number) !== integer(params[0])) throw refused();
      for (const l of found.values()) if (integer(l.blockNumber) === integer(header.number) && header.hash !== l.blockHash) throw refused();
    }
    return value;
  };
  const capital = (await scanFleetCapital(verified, { accounts: [account], usdgToken: CASH.USDG,
    fromBlock: 0n, toBlock: blockNumber, includeCapitalTimestamps: true })).get(account);
  if (!capital?.complete || capital.movements.length !== found.size || !capital.movements.length
    || capital.movements.some(m => m.classification.kind !== "capital-in" || m.direction !== "in" || !m.at)) throw refused();
  const cashUsdg6 = integer(await rpc("eth_call", [{ to: CASH.USDG,
    data: `0x70a08231${account.slice(2).padStart(64, "0")}` }, tag]));
  if (cashUsdg6 <= 0n || cashUsdg6 > BigInt(Number.MAX_SAFE_INTEGER)
    || capital.movements.reduce((n, m) => n + BigInt(m.amountRaw), 0n) !== cashUsdg6) throw refused();
  const last = await rpc("eth_getBlockByNumber", [tag, false]) as { number?: unknown; hash?: unknown } | null;
  const lastHead = await rpc("eth_getBlockByNumber", [headTag, false]) as { number?: unknown; hash?: unknown } | null;
  if (!last || integer(last.number) !== blockNumber || last.hash !== first.hash
    || !lastHead || integer(lastHead.number) !== head || lastHead.hash !== firstHead.hash) throw refused();
  return { account, chainId: o.chainId, blockNumber, blockHash: first.hash, cashUsdg6,
    deposits: capital.movements.map(m => ({ txHash: m.txHash, blockNumber: m.blockNumber,
      logIndex: m.logIndex, at: m.at!, amountUsdg6: BigInt(m.amountRaw) })) };
}
