/**
 * The store side of reading deposits off the chain.
 *
 * `findTransferFlows` is pure and tested without a chain; these three helpers
 * are the part that touches the ledger, and between them they are what stops a
 * deposit being counted twice.
 *
 * WHY THAT MATTERS MORE THAN IT SOUNDS. The scan deliberately re-reads its last
 * block on every pass — a block can carry several transfers, and a crash between
 * two of them would otherwise strand the rest permanently. So the same log IS
 * seen again, every tick, by design. `knownFlowKeys` is the only thing standing
 * between that and a contribution booked twice, and contributions are what P&L
 * is measured against: double one and the account reports a loss it never took.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-flows-"));
process.env.MERRYMEN_HOME = HOME;

const {
  closeStoreForTest,
  initStore,
  addFlow,
  addTrade,
  ensureAgent,
  knownFlowKeys,
  lastChainLogBlock,
  recentTradeTxHashes,
} = await import("./store");
const { flowKey } = await import("./deposit-log");

await initStore();
after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const grant = (account: string) =>
  ({
    smartAccount: account,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    chainId: 4663,
  }) as never;

describe("flows read from the chain", () => {
  it("keeps the evidence — transaction, block and log index", async () => {
    const id = await ensureAgent(grant("0x00000000000000000000000000000000000000f1"));
    await addFlow({
      agentId: id,
      direction: "in",
      amountUsdg: 250,
      source: "chain-log",
      txHash: "0xAABB",
      blockNumber: 900,
      logIndex: 3,
    });
    // The index is the half that was missing: without it the row cannot be told
    // apart from another transfer in the same transaction.
    assert.deepEqual([...(await knownFlowKeys(id, 0))], [flowKey("0xAABB", 3)]);
    assert.equal(await lastChainLogBlock(id), 900);
  });

  it("watermarks on chain-read flows ONLY", async () => {
    // An inferred flow has no block behind it, and a transfer-intent row is the
    // agent's own outbound move. Letting either set the watermark would advance
    // the scan past blocks it never actually read.
    const id = await ensureAgent(grant("0x00000000000000000000000000000000000000f2"));
    assert.equal(await lastChainLogBlock(id), null, "nothing scanned yet");

    await addFlow({ agentId: id, direction: "in", amountUsdg: 100, source: "inferred" });
    assert.equal(await lastChainLogBlock(id), null, "an inference is not a scan");

    await addFlow({
      agentId: id, direction: "out", amountUsdg: 5, source: "transfer-intent", txHash: "0xcc",
    });
    assert.equal(await lastChainLogBlock(id), null, "our own transfer is not a scan either");

    await addFlow({
      agentId: id, direction: "in", amountUsdg: 60, source: "chain-log", txHash: "0xdd",
      blockNumber: 1_000, logIndex: 0,
    });
    assert.equal(await lastChainLogBlock(id), 1_000);
  });

  it("takes the HIGHEST block, not the latest row", async () => {
    // Flows are booked in the order they are read, and a re-read can insert an
    // older block after a newer one. MIN or "last written" would walk the
    // watermark backwards and re-scan forever.
    const id = await ensureAgent(grant("0x00000000000000000000000000000000000000f3"));
    for (const [b, i] of [[2_000, 0], [1_500, 1], [1_800, 2]] as const) {
      await addFlow({
        agentId: id, direction: "in", amountUsdg: 1, source: "chain-log",
        txHash: `0x${b.toString(16)}`, blockNumber: b, logIndex: i,
      });
    }
    assert.equal(await lastChainLogBlock(id), 2_000);
  });

  it("returns the keys a re-read must skip, and only from the block asked for", async () => {
    const id = await ensureAgent(grant("0x00000000000000000000000000000000000000f4"));
    await addFlow({
      agentId: id, direction: "in", amountUsdg: 10, source: "chain-log",
      txHash: "0x01", blockNumber: 500, logIndex: 0,
    });
    await addFlow({
      agentId: id, direction: "in", amountUsdg: 20, source: "chain-log",
      txHash: "0x02", blockNumber: 900, logIndex: 1,
    });

    const fromLast = await knownFlowKeys(id, 900);
    assert.deepEqual([...fromLast], [flowKey("0x02", 1)], "only the window being re-read");
    // The scan resumes at the last recorded block, so THAT key must be present —
    // it is the one the re-read will encounter again.
    assert.equal(fromLast.has(flowKey("0x02", 1)), true);

    const all = await knownFlowKeys(id, 0);
    assert.equal(all.size, 2);
  });

  it("omits flows that have no index to key on", async () => {
    // An inferred flow has no transaction and no index. Emitting a key for it
    // would be inventing one, and the shape it would collide with is a real
    // chain-read flow.
    const id = await ensureAgent(grant("0x00000000000000000000000000000000000000f5"));
    await addFlow({ agentId: id, direction: "in", amountUsdg: 999, source: "inferred" });
    assert.equal((await knownFlowKeys(id, 0)).size, 0);
  });

  it("lists trade transactions case-folded, so a fill is never read as capital", async () => {
    // The comparison is against a log's transactionHash, whose case is whatever
    // the RPC returned. A case-sensitive miss here books a swap's USDG leg as a
    // deposit — which inflates contributions by the account's whole turnover.
    const id = await ensureAgent(grant("0x00000000000000000000000000000000000000f6"));
    await addTrade({
      agent_id: id, kind: "swap", target: id, amount_usdg: 25,
      tx_hash: "0xFEEDFACE", status: "landed",
    });
    const hashes = await recentTradeTxHashes(id);
    assert.equal(hashes.has("0xfeedface"), true);
  });

  it("scopes every helper to one agent", async () => {
    // The ledger is shared. A watermark that leaked across agents would skip
    // another account's deposits entirely.
    const a = await ensureAgent(grant("0x00000000000000000000000000000000000000f7"));
    const b = await ensureAgent(grant("0x00000000000000000000000000000000000000f8"));
    await addFlow({
      agentId: a, direction: "in", amountUsdg: 5, source: "chain-log",
      txHash: "0x77", blockNumber: 7_777, logIndex: 0,
    });
    assert.equal(await lastChainLogBlock(a), 7_777);
    assert.equal(await lastChainLogBlock(b), null);
    assert.equal((await knownFlowKeys(b, 0)).size, 0);
  });
});
