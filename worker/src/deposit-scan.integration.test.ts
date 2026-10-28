/** Receipt retries must never duplicate capital or split a flow from its peaks. */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import type { RawLog, ReconcileChain } from "./inflight-reconcile";
import type { ReceiptLog } from "./fills";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-deposit-scan-"));
process.env.MERRYMEN_HOME = HOME;
const store = await import("./store");
const { homePaths } = await import("./home");
const { CASH } = await import("../../packages/core/src/index");
const { TRANSFER_TOPIC } = await import("./deposit-log");
const { bookInferredReceipt, scanAndBookDepositWindow } = await import("./deposit-scan");
const { deriveBootstrapAccounting } = await import("./bootstrap-source");
const { accountingLicence } = await import("./bootstrap-state");
const { wrapSqlite } = await import("./db");
const { receiptFloorAfter, receiptWindow } = await import("./flow-inference");

const ACCOUNT = "0x00000000000000000000000000000000000d0033";
const OWNER = "0x00000000000000000000000000000000000d0044";
const USDG = CASH.USDG as Hex;
const RISK = "deposit-scan-risk";
const GRANT = {
  smartAccount: ACCOUNT,
  owner: OWNER,
  sessionKeyAddress: "0x00000000000000000000000000000000000000fe",
  chainId: 4663,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 24 },
  grantedAt: 1_700_000_000,
  expiresAt: 2_000_000_000,
} as never;
const topic = (address: string): Hex => `0x${address.slice(2).padStart(64, "0")}`;
const hash = (id: number): Hex => `0x${id.toString(16).padStart(64, "0")}`;

function transfer(direction: "in" | "out", amount: bigint, index: number, tx = hash(index + 1)): RawLog {
  return {
    topics: [TRANSFER_TOPIC, topic(direction === "in" ? OWNER : ACCOUNT), topic(direction === "in" ? ACCOUNT : OWNER)],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
    transactionHash: tx,
    blockNumber: "0x64",
    logIndex: `0x${index.toString(16)}`,
  };
}

function chain(logs: RawLog[], over: Partial<ReconcileChain> = {}): ReconcileChain {
  return {
    getBlockNumber: async () => 100n,
    getLogs: async ({ topics }) => logs.filter((log) => topics[1] === null || log.topics[1] === topics[1])
      .filter((log) => topics[2] === null || log.topics[2] === topics[2]),
    getReceiptLogs: async (tx) => logs.filter((log) => log.transactionHash === tx).map((log): ReceiptLog => ({
      address: USDG,
      topics: log.topics,
      data: log.data,
      logIndex: Number(log.logIndex),
      blockNumber: 100n,
    })),
    ...over,
  };
}

function sql<T = unknown>(query: string, ...params: (string | number | null)[]): T {
  const db = new DatabaseSync(homePaths.db());
  try {
    return db.prepare(query).get(...params) as T;
  } finally {
    db.close();
  }
}
function exec(query: string): void {
  const db = new DatabaseSync(homePaths.db());
  try { db.exec(query); } finally { db.close(); }
}
const peak = async () => (await store.getAgentFinancials(ACCOUNT)).hwmUsdg;
const flowCount = () => Number(sql<{ n: number }>("SELECT COUNT(*) AS n FROM flows WHERE agent_id = ?", ACCOUNT).n);
const flowsBySource = (source: string) => Number(sql<{ n: number }>("SELECT COUNT(*) AS n FROM flows WHERE agent_id = ? AND source = ?", ACCOUNT, source).n);
const journalCount = () => Number(sql<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE agent_id = ? AND kind = 'flow'", ACCOUNT).n);
const riskPeak = () => Number(sql<{ hwm_usdg: number }>("SELECT hwm_usdg FROM risk_periods WHERE id = ?", RISK).hwm_usdg);

const window = (client: ReconcileChain) => ({
  chain: client,
  smartAccount: ACCOUNT as Hex,
  usdgToken: USDG,
  fromBlock: 100n,
  toBlock: 100n,
  // Deliberately stale: safety cannot depend on a pre-read dedup set.
  knownKeys: new Set<string>(),
  tradeTxHashes: new Set<string>(),
  chainId: 4663,
});

before(async () => { await store.initStore(); });
beforeEach(async () => {
  exec("DROP TRIGGER IF EXISTS fail_deposit_peak");
  for (const table of ["agents", "flows", "journal", "risk_periods"]) exec(`DELETE FROM ${table}`);
  await store.ensureAgent(GRANT);
  await store.adjustAgentHwm(ACCOUNT, 100);
  exec(`UPDATE agents SET mode = 'live' WHERE smart_account = '${ACCOUNT}'`);
  exec(`INSERT INTO risk_periods (id, agent_id, started_at, baseline_usdg, hwm_usdg, withdrawn_usdg, reason)
    VALUES ('${RISK}', '${ACCOUNT}', 1700000000, 100, 100, 0, 'owner-authorised')`);
});
after(() => {
  store.closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("receipt capital scan", () => {
  it("concurrent scans with stale keys book each deposit and withdrawal once", async () => {
    const client = chain([transfer("in", 30_000_000n, 1), transfer("out", 5_000_000n, 2)]);
    const events: number[] = [];
    const accounting = { agentId: ACCOUNT, mode: "live" as const, afterBooked: async (flow: { logIndex: number }) => { events.push(flow.logIndex); } };
    await Promise.all([scanAndBookDepositWindow(window(client), accounting), scanAndBookDepositWindow(window(client), accounting)]);
    assert.equal(flowCount(), 2);
    assert.equal(journalCount(), 2);
    assert.equal(await peak(), 125);
    assert.equal(riskPeak(), 130);
    assert.equal(sql<{ withdrawn_usdg: number }>("SELECT withdrawn_usdg FROM risk_periods WHERE id = ?", RISK).withdrawn_usdg, 5);
    assert.deepEqual(events.sort(), [1, 2]);
  });

  it("a crash after the first commit retries the same block without moving that peak again", async () => {
    const tx = hash(99);
    const client = chain([transfer("in", 20_000_000n, 1, tx), transfer("in", 15_000_000n, 2, tx)]);
    await assert.rejects(scanAndBookDepositWindow(window(client), {
      agentId: ACCOUNT, mode: "live", afterBooked: async () => { throw new Error("process stopped after commit"); },
    }), /process stopped/);
    assert.equal(flowCount(), 1);
    assert.equal(await peak(), 120);
    await scanAndBookDepositWindow(window(client), { agentId: ACCOUNT, mode: "live" });
    assert.equal(flowCount(), 2);
    assert.equal(journalCount(), 2);
    assert.equal(await peak(), 135);
    assert.equal(riskPeak(), 135);
  });

  it("an unreadable receipt holds the entire window, then books on a successful retry", async () => {
    const logs = [transfer("in", 25_000_000n, 1)];
    await assert.rejects(scanAndBookDepositWindow(window(chain(logs, { getReceiptLogs: async () => null })), {
      agentId: ACCOUNT, mode: "live",
    }), /receipt.*could not be read/);
    assert.equal(flowCount(), 0);
    assert.equal(await peak(), 100);
    await scanAndBookDepositWindow(window(chain(logs)), { agentId: ACCOUNT, mode: "live" });
    assert.equal(flowCount(), 1);
    assert.equal(await peak(), 125);
  });

  it("a failed log window is held rather than treated as an empty scan", async () => {
    const logs = [transfer("in", 25_000_000n, 1)];
    await assert.rejects(scanAndBookDepositWindow(window(chain(logs, {
      getLogs: async () => { throw new Error("unauthorized RPC request"); },
    })), { agentId: ACCOUNT, mode: "live" }), /covered only/);
    assert.equal(flowCount(), 0);
    assert.equal(await peak(), 100);
    await scanAndBookDepositWindow(window(chain(logs)), { agentId: ACCOUNT, mode: "live" });
    assert.equal(flowCount(), 1);
    assert.equal(await peak(), 125);
  });

  it("a peak write failure rolls back its receipt, journal and risk-period move together", async () => {
    exec(`CREATE TRIGGER fail_deposit_peak BEFORE UPDATE OF hwm_usdg ON agents
      BEGIN SELECT RAISE(ABORT, 'peak storage failed'); END`);
    const scan = window(chain([transfer("in", 25_000_000n, 1)]));
    await assert.rejects(scanAndBookDepositWindow(scan, { agentId: ACCOUNT, mode: "live" }), /peak storage failed/);
    assert.equal(flowCount(), 0);
    assert.equal(journalCount(), 0);
    assert.equal(await peak(), 100);
    assert.equal(riskPeak(), 100);
    exec("DROP TRIGGER fail_deposit_peak");
    await scanAndBookDepositWindow(scan, { agentId: ACCOUNT, mode: "live" });
    assert.equal(flowCount(), 1);
    assert.equal(await peak(), 125);
  });

  it("refuses to book one account's receipts into a different account", async () => {
    await assert.rejects(scanAndBookDepositWindow(window(chain([transfer("in", 25_000_000n, 1)])), {
      agentId: OWNER, mode: "live",
    }), /account does not match/);
    assert.equal(flowCount(), 0);
  });

  it("the worker holds a failed established scan before consuming its cash baseline or settlement queue", () => {
    // main() cannot be safely imported: it starts the live worker. The scanner
    // and real ledger run above; this pin covers its one fail-closed caller.
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const block = source.slice(source.indexOf("const scanChainFlows = async"), source.indexOf("// EXACT BEFORE INFERRED."));
    const failure = block.slice(block.lastIndexOf("} catch (e) {"));
    assert.match(failure, /throw new Error\(`chain scan held/);
    assert.doesNotMatch(failure.slice(0, failure.indexOf("chainScanCursor = head;")), /return false/);
    const look = source.slice(source.indexOf("let covered = false;"));
    assert.ok(look.indexOf("const listedAt") < look.indexOf("takeSettlements()"));
    const retry = source.slice(source.indexOf("const reconcileFlowsOrRetry = async"), source.indexOf("let highWaterMarkUsdg = 0n;"));
    assert.match(retry, /catch \(e\) \{[\s\S]*return "held";/);
    assert.match(block, /if \(mark === null\)[\s\S]*chainScanCursor = head;\s*return false;/);
  });
});

describe("a change inference would book, booked as its receipt instead (flow-inference.ts RULE 4)", () => {
  /** Alan's 10-18 top-up: 59.954460 USDG from an outside wallet, nothing else in the window. */
  const TOP_UP = 59_954_460n;
  const booked = (tx: string) => store.hasFlowForTx(ACCOUNT, tx);
  const infer = (client: ReconcileChain, deltaUsdg6: bigint, over: Partial<Parameters<typeof bookInferredReceipt>[1]> = {}) =>
    bookInferredReceipt(window(client), { agentId: ACCOUNT, mode: "live", deltaUsdg6, flowBookedForTx: booked, ...over });
  const row = () => ({ ...sql<{ source: string; tx_hash: string | null; block_number: number | null; log_index: number | null; amount_usdg: number; direction: string }>(
    "SELECT source, tx_hash, block_number, log_index, amount_usdg, direction FROM flows WHERE agent_id = ? ORDER BY id DESC LIMIT 1", ACCOUNT) });
  /** The peaks are REAL columns: compared in micro-USDG, as the anchor reads them. */
  const micro = (usdg: number) => Math.round(usdg * 1e6);
  const raised = 100_000_000 + Number(TOP_UP);
  /** The hosted anchor the orchestrator would derive from this ledger at the next spawn. */
  const anchor = async () => {
    const raw = new DatabaseSync(homePaths.db());
    try {
      const a = await deriveBootstrapAccounting(wrapSqlite(raw), ACCOUNT, 1_800_000_000);
      assert.equal(a.kind, "established");
      return a;
    } finally {
      raw.close();
    }
  };
  const known = (a: Awaited<ReturnType<typeof anchor>>) =>
    accountingLicence({ kind: "valid", state: {} as never, accounting: a }, { hosted: true }).contributionsKnown;

  it("THE BUG, AS IT WAS: a top-up booked by inference is unevidenced at the next spawn, so contributions read unknown", async () => {
    // What record() does with no receipt: a row with no transaction.
    assert.equal(await store.addFlow({ agentId: ACCOUNT, direction: "in", amountUsdg: Number(TOP_UP) / 1e6, source: "inferred", mode: "live" }), true);
    const a = await anchor();
    assert.equal(a.kind === "established" && a.unanchoredFlowCount, 1);
    assert.equal(known(a), false, "the Brain refused every entry on exactly this");
  });

  it("booked as its one receipt: chain-log, both peaks moved once, and the next spawn's anchor calls it evidence", async () => {
    const r = await infer(chain([transfer("in", TOP_UP, 1)]), TOP_UP);
    assert.equal(r.kind, "booked");
    assert.deepEqual(row(), { source: "chain-log", tx_hash: hash(2), block_number: 100, log_index: 1, amount_usdg: 59.95446, direction: "in" });
    assert.equal(flowCount(), 1);
    assert.equal(journalCount(), 1);
    // The same two peaks inference moves (adjustAgentHwm), in one transaction with the row.
    assert.equal(micro(await peak()), raised);
    assert.equal(micro(riskPeak()), raised);
    const a = await anchor();
    assert.equal(a.kind === "established" && a.unanchoredFlowCount, 0);
    assert.equal(a.kind === "established" && a.anchoredContributionsUsdg, a.kind === "established" && a.netContributionsUsdg);
    assert.equal(known(a), true, "a restart resumes with contributions known");
  });

  it("a withdrawal to an outside wallet is booked the same way and lowers the effective peak once", async () => {
    const r = await infer(chain([transfer("out", 5_000_000n, 1)]), -5_000_000n);
    assert.equal(r.kind, "booked");
    assert.equal(row().direction, "out");
    assert.equal(await peak(), 95);
    assert.equal(sql<{ withdrawn_usdg: number }>("SELECT withdrawn_usdg FROM risk_periods WHERE id = ?", RISK).withdrawn_usdg, 5);
  });

  it("NOTHING TWICE: a look retried after the booking committed finds no receipt left, and a racing booker's copy moves nothing", async () => {
    const client = chain([transfer("in", TOP_UP, 1)]);
    assert.equal((await infer(client, TOP_UP)).kind, "booked");
    // Retried with the same stale identity set: the transaction is on the books now.
    const again = await infer(client, TOP_UP);
    assert.equal(again.kind, "unmatched", "index.ts counts the booked receipt first, so a retry never infers it either");
    // A ledger that said "not booked" a moment too early: the store's identity gate still holds.
    const raced = await infer(client, TOP_UP, { flowBookedForTx: async () => false });
    assert.equal(raced.kind, "already");
    assert.equal(flowCount(), 1);
    assert.equal(journalCount(), 1);
    assert.equal(micro(await peak()), raised);
    assert.equal(micro(riskPeak()), raised);
  });

  it("no receipt for two transfers, for one of another amount or direction, or for none — nothing is booked, and the caller infers as before", async () => {
    for (const [logs, delta] of [
      [[transfer("in", 30_000_000n, 1), transfer("in", 29_954_460n, 2)], TOP_UP],
      [[transfer("in", TOP_UP + 1n, 1)], TOP_UP],
      [[transfer("out", TOP_UP, 1)], TOP_UP],
      [[], TOP_UP],
    ] as const) {
      const r = await infer(chain([...logs]), delta);
      assert.equal(r.kind, "unmatched");
    }
    assert.equal(flowCount(), 0);
    assert.equal(await peak(), 100);
  });

  it("the executor's own transfer home, booked with its tx and no log index, is never booked again from its log", async () => {
    const tx = hash(77);
    assert.equal(await store.addFlow({ agentId: ACCOUNT, direction: "out", amountUsdg: 5, source: "transfer-intent", txHash: tx, mode: "live" }), true);
    const r = await infer(chain([transfer("out", 5_000_000n, 1, tx)]), -5_000_000n);
    assert.equal(r.kind, "unmatched");
    assert.equal(flowCount(), 1);
    // And a ledger that cannot say is not taken for "not booked".
    const unread = await infer(chain([transfer("in", TOP_UP, 2)]), TOP_UP, { flowBookedForTx: async () => null });
    assert.equal(unread.kind, "unmatched");
    assert.equal(flowCount(), 1);
  });

  it("a chain that will not answer, or a receipt it will not give, books nothing and says why — it never throws into the look", async () => {
    const logs = [transfer("in", TOP_UP, 1)];
    const failed = await infer(chain(logs, { getLogs: async () => { throw new Error("HTTP request failed. Status: 429 Too Many Requests"); } }), TOP_UP);
    assert.ok(failed.kind === "unmatched" && /could not be read/.test(failed.why));
    const noReceipt = await infer(chain(logs, { getReceiptLogs: async () => null }), TOP_UP);
    assert.ok(noReceipt.kind === "unmatched" && /could not be read/.test(noReceipt.why));
    assert.equal(flowCount(), 0);
    assert.equal(await peak(), 100);
  });

  it("paper books no capital, and one account's receipt is never booked into another", async () => {
    const client = chain([transfer("in", TOP_UP, 1)]);
    // The store would admit a real receipt in paper mode; a simulated change has none.
    const paper = await infer(client, TOP_UP, { mode: "paper" });
    assert.ok(paper.kind === "unmatched" && /simulated/.test(paper.why));
    const other = await bookInferredReceipt(window(client), { agentId: OWNER, mode: "live", deltaUsdg6: TOP_UP, flowBookedForTx: booked });
    assert.equal(other.kind, "unmatched");
    assert.equal(flowCount(), 0);
  });

  it("THE FLOOR: money a look booked by inference is never read again as the receipt for a later change", async () => {
    // A chain that answers by block range, as a node does.
    const at = (log: RawLog, block: number): RawLog => ({ ...log, blockNumber: `0x${block.toString(16)}` });
    const ranged = (logs: RawLog[]): ReconcileChain => ({
      ...chain(logs),
      getLogs: async ({ fromBlock, toBlock, topics }) => logs
        .filter((l) => BigInt(l.blockNumber!) >= fromBlock && BigInt(l.blockNumber!) <= toBlock)
        .filter((l) => (topics[1] === null || l.topics[1] === topics[1]) && (topics[2] === null || l.topics[2] === topics[2])),
    });
    const deposit = at(transfer("in", TOP_UP, 1, hash(41)), 1_300);
    const scanOf = (client: ReconcileChain, w: { fromBlock: bigint; toBlock: bigint }) =>
      ({ ...window(client), ...w });
    // Look 1 (head 1,500) could not read the chain, so the deposit at block
    // 1,300 was booked by inference, and the floor went above that look's head.
    const floor = receiptFloorAfter(receiptFloorAfter(null, 1_000n), 1_500n);
    assert.equal(await store.addFlow({ agentId: ACCOUNT, direction: "in", amountUsdg: Number(TOP_UP) / 1e6, source: "inferred", mode: "live" }), true);
    await store.adjustAgentHwm(ACCOUNT, Number(TOP_UP) / 1e6);
    // Look 2 (head 1,650): the cash rose by the same amount again, from something
    // no capital transfer explains — an unrecorded swap's proceeds, say.
    const w = receiptWindow({ baselineHead: 1_500n, floor, head: 1_650n });
    assert.ok(!("none" in w) && w.fromBlock > 1_300n, "the window starts above the inferred deposit's block");
    if ("none" in w) return;
    const r = await bookInferredReceipt(scanOf(ranged([deposit]), w), {
      agentId: ACCOUNT, mode: "live", deltaUsdg6: TOP_UP, flowBookedForTx: booked,
    });
    assert.equal(r.kind, "unmatched");
    assert.equal(flowsBySource("chain-log"), 0);
    // Without the floor, the same look reaches the deposit's log, finds nothing
    // naming it (an inferred row has no tx), and books the money a second time.
    const unguarded = receiptWindow({ baselineHead: 1_500n, floor: 0n, head: 1_650n });
    assert.ok(!("none" in unguarded) && unguarded.fromBlock <= 1_300n);
    if ("none" in unguarded) return;
    const twice = await bookInferredReceipt(scanOf(ranged([deposit]), unguarded), {
      agentId: ACCOUNT, mode: "live", deltaUsdg6: TOP_UP, flowBookedForTx: booked,
    });
    assert.equal(twice.kind, "booked", "this is the double count the floor exists to prevent");
    assert.equal(micro(await peak()), 100_000_000 + 2 * Number(TOP_UP), "and the one-way peak raised twice");
  });

  it("a database error in the booking itself throws, rolled back, so the look is retried whole", async () => {
    exec(`CREATE TRIGGER fail_deposit_peak BEFORE UPDATE OF hwm_usdg ON agents
      BEGIN SELECT RAISE(ABORT, 'peak storage failed'); END`);
    await assert.rejects(infer(chain([transfer("in", TOP_UP, 1)]), TOP_UP), /peak storage failed/);
    assert.equal(flowCount(), 0);
    assert.equal(await peak(), 100);
    exec("DROP TRIGGER fail_deposit_peak");
    assert.equal((await infer(chain([transfer("in", TOP_UP, 1)]), TOP_UP)).kind, "booked");
  });
});

describe("the deposit scan never resumes across a flow booked by inference", () => {
  const insert = (source: string, at: number, block: number | null, tx: string | null, logIndex: number | null) =>
    exec(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
      VALUES ('${ACCOUNT}', 'in', 10, ${tx ? `'${tx}'` : "NULL"}, ${block ?? "NULL"}, ${logIndex ?? "NULL"}, '${source}', 1, 4663, ${at})`);

  it("an inferred flow booked after the mark's receipt refuses the resume; one long before it does not", async () => {
    insert("chain-log", 1_700_000_000, 100, hash(5), 0);
    assert.equal(await store.lastChainLogBlock(ACCOUNT), 100);
    assert.equal(await store.inferredFlowSinceChainLog(ACCOUNT, 100), false, "no inferred flow at all");
    insert("inferred", 1_700_000_000 - 7_200, null, null, null);
    assert.equal(await store.inferredFlowSinceChainLog(ACCOUNT, 100), false, "booked two hours before the receipt: its money is older");
    insert("inferred", 1_700_000_000 - 600, null, null, null);
    assert.equal(await store.inferredFlowSinceChainLog(ACCOUNT, 100), true, "within the slack of a receipt booked late");
  });

  it("after the mark, in any epoch, it refuses — and a mark with no receipt row to date it refuses too", async () => {
    insert("chain-log", 1_700_000_000, 100, hash(5), 0);
    insert("inferred", 1_700_000_500, null, null, null);
    assert.equal(await store.inferredFlowSinceChainLog(ACCOUNT, 100), true);
    exec(`UPDATE flows SET epoch = 2 WHERE source = 'inferred'`);
    assert.equal(await store.inferredFlowSinceChainLog(ACCOUNT, 100), true, "the mark spans epochs, so the guard does");
    assert.equal(await store.inferredFlowSinceChainLog(ACCOUNT, 999), true, "no receipt at that block: dated zero, so any inferred flow refuses");
  });
});
