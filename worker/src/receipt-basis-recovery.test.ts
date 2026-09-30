import assert from "node:assert/strict";
import { it } from "node:test";
import type { Hex } from "viem";
import { recoverReceiptBasis } from "./receipt-basis-recovery";
import { addressTopic, type ReconcileChain, type RawLog } from "./inflight-reconcile";
import type { ReceiptLog } from "./fills";

const account = `0x${"1".repeat(40)}` as Hex;
const router = `0x${"2".repeat(40)}` as Hex;
const token = `0x${"3".repeat(40)}` as Hex;
const usdgToken = `0x${"4".repeat(40)}` as Hex;
const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const hex = (v: bigint) => `0x${v.toString(16)}` as Hex;
function fixture(fills: { qty: bigint; cash: bigint; sell?: boolean }[], heldRaw: bigint) {
  const logs: RawLog[] = [];
  const receipts = new Map<string, ReceiptLog[]>();
  fills.forEach((f, i) => {
    const tx = `0x${(i+1).toString(16).padStart(64,"0")}` as Hex;
    const asset = { address: token, topics: [transfer, addressTopic(f.sell ? account : router), addressTopic(f.sell ? router : account)], data: hex(f.qty) };
    logs.push({ ...asset, transactionHash: tx, blockNumber: hex(BigInt(i+1)), logIndex: "0x0" });
    receipts.set(tx, [asset, { address: usdgToken, topics: [transfer, addressTopic(f.sell ? router : account), addressTopic(f.sell ? account : router)], data: hex(f.cash) }]);
  });
  const chain: ReconcileChain = {
    getBlockNumber: async () => 100n,
    getLogs: async ({ topics }) => logs.filter(l => topics[2] ? l.topics[2] === topics[2] : l.topics[1] === topics[1]).reverse(),
    getReceiptLogs: async tx => receipts.get(tx) ?? null,
  };
  return { opts: { chain, token, account, usdgToken, heldRaw, lookbackBlocks: 100n }, logs, receipts };
}
it("recovers weighted basis from multiple buys and a partial sale in chain order", async () => {
  const { opts } = fixture([{ qty: 10n, cash: 100n }, { qty: 10n, cash: 200n }, { qty: 5n, cash: 90n, sell: true }], 15n);
  const result = await recoverReceiptBasis(opts);
  assert.deepEqual(result?.basis, { qtyRaw: 15n, costUsdg: 225n });
  assert.equal(result?.transactions.length, 3);
});
it("refuses missing opening inventory, mismatched closing inventory, and unavailable receipts", async () => {
  const opening = fixture([{ qty: 5n, cash: 90n, sell: true }, { qty: 10n, cash: 200n }], 5n);
  assert.equal(await recoverReceiptBasis(opening.opts), null);
  const mismatch = fixture([{ qty: 10n, cash: 100n }], 20n);
  assert.equal(await recoverReceiptBasis(mismatch.opts), null);
  const missing = fixture([{ qty: 10n, cash: 100n }], 10n);
  missing.receipts.clear();
  assert.equal(await recoverReceiptBasis(missing.opts), null);
});
it("never assigns a purchase price to a transferred-in holding", async () => {
  const f = fixture([{ qty: 10n, cash: 100n }], 10n);
  for (const [tx, logs] of f.receipts) f.receipts.set(tx, logs.slice(0,1));
  assert.equal(await recoverReceiptBasis(f.opts), null);
});

it("recovers closed-position sale P&L only after proving the closing inventory", async () => {
  const {opts}=fixture([{qty:10n,cash:100n},{qty:10n,cash:80n,sell:true}],0n);
  assert.equal(await recoverReceiptBasis(opts),null);
  const result=await recoverReceiptBasis({...opts,allowClosed:true});
  assert.equal(result?.realized[0]?.pnl,-20n);
  assert.equal(await recoverReceiptBasis({...opts,heldRaw:1n,allowClosed:true}),null);
});
it("deduplicates transfers within a transaction and refuses unknown ordering", async () => {
  const f = fixture([{ qty: 10n, cash: 100n }], 10n);
  f.logs.push({ ...f.logs[0]! });
  assert.deepEqual((await recoverReceiptBasis(f.opts))?.basis, { qtyRaw: 10n, costUsdg: 100n });
  delete f.logs[0]!.blockNumber;
  assert.equal(await recoverReceiptBasis(f.opts), null);
});
it("a hanging recovery cannot consume the next trading decision's deadline", async () => {
  const f = fixture([{ qty: 10n, cash: 100n }], 10n);
  f.opts.chain.getLogs = () => new Promise(() => {});
  assert.equal(await recoverReceiptBasis({ ...f.opts, budgetMs: 10 }), null);
  assert.equal(await recoverReceiptBasis({ ...f.opts, budgetMs: 0 }), null);
});
