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
const { scanAndBookDepositWindow } = await import("./deposit-scan");

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
    const look = source.slice(source.indexOf("const covered = scan ? await scanChainFlows(scan) : false;"));
    assert.ok(look.indexOf("const listedAt") < look.indexOf("takeSettlements()"));
    const retry = source.slice(source.indexOf("const reconcileFlowsOrRetry = async"), source.indexOf("let highWaterMarkUsdg = 0n;"));
    assert.match(retry, /catch \(e\) \{[\s\S]*return "held";/);
    assert.match(block, /if \(mark === null\)[\s\S]*chainScanCursor = head;\s*return false;/);
  });
});
