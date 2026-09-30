import type { Hex } from "viem";
import { applyFill, type BasisRow, ZERO_BASIS } from "./basis";
import { acquiredLegOf, addressTopic, getLogsAdaptive, type ReconcileChain } from "./inflight-reconcile";
import { boundedRead } from "./optional-read-deadline";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

/** Reconstruct only a complete, receipt-backed position. Never infer cost from a mark. */
export async function recoverReceiptBasis(opts: {
  chain: ReconcileChain; token: Hex; account: string; usdgToken: string;
  allowClosed?: boolean; heldRaw: bigint; lookbackBlocks: bigint; maxSpan?: bigint; budgetMs?: number;
}): Promise<{ basis: BasisRow; transactions: string[]; realized: {tx:string; pnl:bigint}[] } | null> {
  const budgetMs = Math.max(0, Math.min(20_000, opts.budgetMs ?? 20_000));
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return null;
  const deadline = Date.now() + budgetMs;
  // Stop issuing requests after the outer deadline; an in-flight RPC may finish
  // later, but its result cannot write accounting state or start another scan.
  const read = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (Date.now() >= deadline) throw new Error("recovery budget exhausted");
    return fn();
  };
  const original = opts.chain;
  const chain: ReconcileChain = {
    getBlockNumber: () => read(() => original.getBlockNumber()),
    getLogs: args => read(() => original.getLogs(args)),
    getReceiptLogs: tx => read(() => original.getReceiptLogs(tx)),
  };
  return boundedRead(() => replayReceiptBasis({ ...opts, chain }), budgetMs);
}

async function replayReceiptBasis(opts: {
  chain: ReconcileChain; token: Hex; account: string; usdgToken: string;
  allowClosed?: boolean; heldRaw: bigint; lookbackBlocks: bigint; maxSpan?: bigint;
}): Promise<{ basis: BasisRow; transactions: string[]; realized: {tx:string; pnl:bigint}[] } | null> {
  if (opts.heldRaw < 0n || (opts.heldRaw === 0n && !opts.allowClosed)) return null;
  const head = await opts.chain.getBlockNumber();
  const from = head > opts.lookbackBlocks ? head - opts.lookbackBlocks : 0n;
  const inbound = await getLogsAdaptive(opts.chain,
    { address: opts.token, topics: [TRANSFER, null, addressTopic(opts.account)] },
    from, head, opts.maxSpan ?? 50_000n);
  if (!inbound.complete) return null;
  const outbound = await getLogsAdaptive(opts.chain,
    { address: opts.token, topics: [TRANSFER, addressTopic(opts.account)] },
    from, head, opts.maxSpan ?? 50_000n);
  if (!outbound.complete) return null;
  const logs = [...inbound.logs, ...outbound.logs];
  if (logs.some(l => l.blockNumber == null || l.logIndex == null)) return null;
  logs.sort((a, b) => {
    const block = BigInt(a.blockNumber!) - BigInt(b.blockNumber!);
    const order = block || BigInt(a.logIndex!) - BigInt(b.logIndex!);
    return order < 0n ? -1 : order > 0n ? 1 : 0;
  });
  const transactions = [...new Set(logs.map(l => l.transactionHash.toLowerCase()))];
  if (!transactions.length || transactions.length > 128) return null;
  let basis: BasisRow = { ...ZERO_BASIS };
  const realized: {tx:string; pnl:bigint}[] = [];
  for (const tx of transactions) {
    const fill = await acquiredLegOf(opts.chain, tx as Hex, opts.account, opts.usdgToken);
    // Transfers, ambiguous routes, and unavailable receipts leave cost unknown.
    if (!fill || fill.token.toLowerCase() !== opts.token.toLowerCase() || fill.cashUsdg <= 0n) return null;
    const next = applyFill(basis, fill);
    if (next.basisUnknown) return null;
    if (fill.side === "sell") realized.push({tx,pnl:next.realizedUsdg});
    basis = next.basis;
  }
  // This also proves the window started flat: an omitted opening quantity
  // would leave the replay short. Partial histories never become full basis.
  if (basis.qtyRaw !== opts.heldRaw || (opts.heldRaw > 0n && basis.costUsdg <= 0n)) return null;
  return { basis, transactions, realized };
}
