/**
 * Synthetic ERC-20 receipts for the Gloam funding handoff, through the real
 * scanner and ledger. These exercise accounting, not the pool's proofs or a
 * live deployment. The pool address and USDG are the documented mainnet route;
 * the accounts, transaction hashes and fee example are fixture data.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import type { RawLog, ReconcileChain } from "./inflight-reconcile";
import { accrueAboveHwm } from "./fees";
import { pnlUsdg } from "./equity";

const testHome = mkdtempSync(path.join(os.tmpdir(), "merrymen-gloam-funding-"));
process.env.MERRYMEN_HOME = testHome;
const store = await import("./store");
const { homePaths } = await import("./home");
const { CASH } = await import("../../packages/core/src/index");
const { TRANSFER_TOPIC, findTransferFlows } = await import("./deposit-log");
const { scanAndBookDepositWindow } = await import("./deposit-scan");

const ACCOUNT = "0x00000000000000000000000000000000000d0033" as const;
const OWNER = "0x00000000000000000000000000000000000d0044" as const;
const POOL = "0x39e28cde55cab798874746ac52cb4b5cc99a0194" as const;
const COLLECTOR = "0x00000000000000000000000000000000000d0055" as const;
const OTHER_TOKEN = "0x00000000000000000000000000000000000d0066" as const;
const USDG = CASH.USDG as Hex;
const RISK = "gloam-funding-risk";
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
type FixtureLog = RawLog & { address: string };

function transfer(from: string, to: string, amount: bigint, tx: number, index: number, token: string = USDG): FixtureLog {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, topic(from), topic(to)],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
    transactionHash: hash(tx), blockNumber: "0x64", logIndex: `0x${index.toString(16)}`,
  };
}

function receiptChain(logs: FixtureLog[], unreadable = false): ReconcileChain {
  return {
    getBlockNumber: async () => 100n,
    getLogs: async ({ address, topics }) => logs.filter(log => log.address?.toLowerCase() === address.toLowerCase())
      .filter(log => topics.every((wanted, i) => wanted === null || wanted === undefined
        || (Array.isArray(wanted) ? wanted : [wanted]).includes(log.topics[i]!))),
    getReceiptLogs: async tx => unreadable ? null : logs.filter(log => log.transactionHash === tx).map(log => ({
      address: log.address!, topics: log.topics, data: log.data,
      logIndex: Number(log.logIndex), blockNumber: 100n,
    })),
  };
}

function withDb<T>(read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(homePaths.db());
  try { return read(db); } finally { db.close(); }
}
const sql = <T>(query: string, ...params: (string | number)[]) => withDb(db => db.prepare(query).get(...params)) as T;
const exec = (query: string) => withDb(db => db.exec(query));
const rows = () => withDb(db => db.prepare("SELECT direction, amount_usdg, source, tx_hash, log_index FROM flows WHERE agent_id = ? ORDER BY log_index").all(ACCOUNT));
const peak = async () => (await store.getAgentFinancials(ACCOUNT)).hwmUsdg;
const scan = (chain: ReconcileChain) => ({
  chain, smartAccount: ACCOUNT, usdgToken: USDG, fromBlock: 100n, toBlock: 100n,
  // Stale on purpose: durable booking, not this cached set, must deduplicate.
  knownKeys: new Set<string>(), tradeTxHashes: new Set<string>(), chainId: 4663,
});
const book = (logs: FixtureLog[], unreadable = false) => scanAndBookDepositWindow(scan(receiptChain(logs, unreadable)), {
  agentId: ACCOUNT, mode: "live",
});

before(async () => { await store.initStore(); });
beforeEach(async () => {
  for (const table of ["agents", "flows", "journal", "risk_periods"]) exec(`DELETE FROM ${table}`);
  await store.ensureAgent(GRANT);
  await store.adjustAgentHwm(ACCOUNT, 100);
  exec(`UPDATE agents SET mode = 'live' WHERE smart_account = '${ACCOUNT}'`);
  exec(`INSERT INTO risk_periods (id, agent_id, started_at, baseline_usdg, hwm_usdg, withdrawn_usdg, reason)
    VALUES ('${RISK}', '${ACCOUNT}', 1700000000, 100, 100, 0, 'owner-authorised')`);
});
after(() => {
  store.closeStoreForTest();
  rmSync(testHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("Gloam funding receipts are external capital, not trading gains", () => {
  it("credits only the net USDG delivered, keeps receipt evidence and charges no performance fee on funding", async () => {
    // Example gross cash-out 100 USDG, with 0.25 going to a provider fee
    // collector. The agent receives 99.75; the provider's fee is not its loss.
    const logs = [
      transfer(POOL, ACCOUNT, 99_750_000n, 1, 2),
      transfer(POOL, COLLECTOR, 250_000n, 1, 3),
    ];
    await book(logs);
    assert.deepEqual(rows().map(row => ({ ...row })), [{
      direction: "in", amount_usdg: 99.75, source: "chain-log", tx_hash: hash(1), log_index: 2,
    }]);
    assert.equal(await peak(), 199.75);
    assert.equal(sql<{ hwm_usdg: number }>("SELECT hwm_usdg FROM risk_periods WHERE id = ?", RISK).hwm_usdg, 199.75);
    const fees = accrueAboveHwm(199_750_000n, BigInt(Math.round((await peak()) * 1e6)), 1_000);
    assert.equal(fees.profitUsdg, 0n);
    assert.equal(fees.feeUsdg, 0n);
    await book(logs);
    assert.equal(rows().length, 1);
    assert.equal(await peak(), 199.75, "rereading the receipt cannot inflate the peak");
  });

  it("books split payouts once even after a crash between commits and a same-block retry", async () => {
    const logs = [transfer(POOL, ACCOUNT, 20_000_000n, 2, 4), transfer(POOL, ACCOUNT, 30_000_000n, 3, 5)];
    await assert.rejects(scanAndBookDepositWindow(scan(receiptChain(logs)), {
      agentId: ACCOUNT, mode: "live", afterBooked: async () => { throw new Error("process stopped after commit"); },
    }), /process stopped/);
    assert.equal(rows().length, 1);
    await book(logs);
    await book(logs);
    assert.equal(rows().length, 2);
    assert.equal(await peak(), 150);
    assert.equal(sql<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE agent_id = ? AND kind = 'flow'", ACCOUNT).n, 2);
  });

  it("books an owner shield as capital out without a trading loss, performance fee or duplicate withdrawal", async () => {
    // The fixture already has a 100 USDG peak. Record its opening contribution
    // without moving that peak again, then scan the actual shield-side debit.
    assert.equal(await store.addFlow({
      agentId: ACCOUNT, direction: "in", amountUsdg: 100, source: "chain-log",
      mode: "live", chainId: 4663, txHash: hash(8), blockNumber: 99, logIndex: 0,
    }), true);
    assert.equal(pnlUsdg(100, await store.getNetContributionsUsdg(ACCOUNT), 0), 0);
    const logs = [transfer(ACCOUNT, POOL, 25_000_000n, 9, 11)];

    for (let attempt = 0; attempt < 2; attempt++) {
      await book(logs);
      assert.deepEqual(rows().map(row => ({ ...row })), [
        { direction: "in", amount_usdg: 100, source: "chain-log", tx_hash: hash(8), log_index: 0 },
        { direction: "out", amount_usdg: 25, source: "chain-log", tx_hash: hash(9), log_index: 11 },
      ]);
      const netContributions = await store.getNetContributionsUsdg(ACCOUNT);
      assert.equal(netContributions, 75);
      // Fixture gas is zero: moving 25 USDG into the owner's private note
      // leaves 75 USDG in the account, but does not lose 25 USDG in trading.
      assert.equal(pnlUsdg(75, netContributions, 0), 0);
      assert.equal(await store.getRealizedPnlUsdg(ACCOUNT, "live"), 0);
      const financials = await store.getAgentFinancials(ACCOUNT);
      assert.deepEqual(financials, {
        hwmUsdg: 75, hwmGrossUsdg: 100, hwmWithdrawnUsdg: 25, accruedFeeUsdg: 0,
      });
      const risk = sql<{ hwm_usdg: number; withdrawn_usdg: number }>(
        "SELECT hwm_usdg, withdrawn_usdg FROM risk_periods WHERE id = ?", RISK,
      );
      assert.equal(risk.hwm_usdg, 100);
      assert.equal(risk.withdrawn_usdg, 25);
      const fees = accrueAboveHwm(75_000_000n, BigInt(financials.hwmUsdg * 1e6), 1_000);
      assert.equal(fees.profitUsdg, 0n);
      assert.equal(fees.feeUsdg, 0n);
      assert.equal(sql<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE agent_id = ? AND kind = 'flow'", ACCOUNT).n, 2);
    }
  });

  it("does not guess a deposit from a receipt that cannot be read", async () => {
    const logs = [transfer(POOL, ACCOUNT, 10_000_000n, 4, 6)];
    await assert.rejects(book(logs, true), /receipt.*could not be read/);
    assert.equal(rows().length, 0);
    assert.equal(await peak(), 100);
  });

  it("does not credit a different token or treat a paired swap as new funding", async () => {
    await book([transfer(POOL, ACCOUNT, 10_000_000n, 5, 7, OTHER_TOKEN)]);
    assert.equal(rows().length, 0);
    await book([
      transfer(POOL, ACCOUNT, 10_000_000n, 6, 8),
      transfer(ACCOUNT, POOL, 1_000_000n, 6, 9, OTHER_TOKEN),
    ]);
    assert.equal(rows().length, 0);
    assert.equal(await peak(), 100);
  });

  it("requires a classification review if the pool becomes a trading venue", async () => {
    await assert.rejects(findTransferFlows({
      ...scan(receiptChain([transfer(POOL, ACCOUNT, 10_000_000n, 7, 10)])),
      protocolAddresses: [POOL],
    }), /could not be classified.*known protocol address/);
    assert.equal(rows().length, 0, "an unpaired known-venue movement holds the scan rather than becoming a deposit");
  });
});
