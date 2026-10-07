/**
 * THE OWNER'S OPERATIONS IN A REAL LEDGER: recorded once, known to the sweep,
 * counted by no limit, and no longer hiding a withdrawal from the deposit scan.
 *
 * Against a real sqlite file (the MERRYMEN_HOME pattern of
 * inflight-row.integration.test.ts), with the 0x4b6dcd account's own root-key
 * operations read off the public chain (testdata/owner-operations-receipts.json):
 * an invalidateNonce, its vault's sweep(USDG) and its recoverFunds.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hex } from "viem";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-owner-ops-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, getOpsToday, getSpentTodayUsdg, listOpHashes, recentTradeTxHashes, recordOwnerOperation } = await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");
const { ownerOperationOf, ownerOperationRow } = await import("./owner-operations");
const { findTransferFlows } = await import("./deposit-log");

type FixtureLog = [string, string[], string, string];
const FX = JSON.parse(readFileSync(new URL("./testdata/owner-operations-receipts.json", import.meta.url), "utf8")) as
  Record<string, { tx: string; block: string; timestamp: number; logs: FixtureLog[] }>;
const ACCOUNT = "0xa96bf429888e1aab4255762d17d29c53f6a0370d";
const VAULT = "0xc8776faff15212c359b23bae531ff3ac7d760e0f";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const OPS = {
  invalidateNonce: "0x496e7211db25d250d9142105ab5024debcf05519c734d83191145af8eac09ffa",
  vaultSweep: "0x0ea85970d6cd230721eb03d667ad46795f1f215647cbad9d1f456779be91c9b9",
  recoverFunds: "0x04f8241f6d02241469b9c2bc2d2f8cc4cca719eb5c6d54f3a77077c7e41ab3a7",
} as const;
const receipt = (name: string) => FX[name]!.logs.map(([address, topics, data, logIndex]) => ({ address, topics, data, logIndex }));
const rowOf = (name: keyof typeof OPS) => {
  const r = ownerOperationOf({ receiptLogs: receipt(name), userOpHash: OPS[name], txHash: FX[name]!.tx, account: ACCOUNT, custody: [VAULT], usdg: USDG, chainId: 4663 })!;
  return ownerOperationRow(r, { agentId: ACCOUNT, chainId: 4663, blockNumber: BigInt(FX[name]!.block), blockTime: FX[name]!.timestamp, recordedEpoch: 1 });
};

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const raw = <T>(fn: (db: InstanceType<typeof DatabaseSync>) => T): T => {
  const db = new DatabaseSync(homePaths.db());
  try { return fn(db); } finally { db.close(); }
};

describe("recording the owner's operations", () => {
  it("initialises", async () => {
    await initStore();
  });

  it("records each once: 'inserted', then 'present' — a crash on either side replays nothing", async () => {
    for (const name of Object.keys(OPS) as Array<keyof typeof OPS>) assert.equal(await recordOwnerOperation(rowOf(name)), "inserted", name);
    for (const name of Object.keys(OPS) as Array<keyof typeof OPS>) assert.equal(await recordOwnerOperation(rowOf(name)), "present", name);
    const n = raw((db) => (db.prepare("SELECT COUNT(*) AS n FROM owner_operations").get() as { n: number }).n);
    assert.equal(n, 3);
    const recover = raw((db) => db.prepare("SELECT disposition, review_reason, tenant, block_time, recorded_epoch FROM owner_operations WHERE user_op_hash = ?").get(OPS.recoverFunds)) as
      Record<string, unknown>;
    assert.deepEqual({ ...recover }, { disposition: "review", review_reason: "token-departed", tenant: null, block_time: 1790947791, recorded_epoch: 1 });
  });

  it("the table refuses what it must never hold: a validator other than root, an acknowledged row with a reason, a review without one", () => {
    let n = 0;
    const insert = (validator: string, disposition: string, reason: string | null) => raw((db) =>
      db.prepare(`INSERT INTO owner_operations (agent_id, chain_id, user_op_hash, tx_hash, block_number, block_time, log_index, nonce, validator, disposition,
          review_reason, usdg_legs_json, covers_logs_json, token_moves_json, paymaster, gas_wei, source, recorded_epoch)
        VALUES (?, 4663, ?, ?, 1, 1, 0, '0x0', ?, ?, ?, '[]', '[]', '[]', '0x', NULL, 'test', 1)`)
        .run(ACCOUNT, `0x${"9".repeat(63)}${++n}`, `0x${"8".repeat(64)}`, validator, disposition, reason));
    assert.throws(() => insert("permission", "acknowledged", null), /CHECK/);
    assert.throws(() => insert("root", "acknowledged", "token-arrived"), /CHECK/);
    assert.throws(() => insert("root", "review", null), /CHECK/);
    assert.throws(() => insert("root", "settled", null), /CHECK/);
  });

  it("the sweep knows them: listOpHashes includes every recorded owner operation, so a later arm does not find them again", async () => {
    const known = await listOpHashes(ACCOUNT);
    for (const h of Object.values(OPS)) assert.ok(known.has(h), h);
  });

  it("no limit counts them and no tape shows them: the trades table is empty, and ops and spend today are zero", async () => {
    assert.equal(raw((db) => (db.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n), 0);
    assert.equal(await getOpsToday(ACCOUNT), 0);
    assert.equal(await getSpentTodayUsdg(ACCOUNT), 0);
  });

  it("and the recoverFunds withdrawal is no longer hidden from the deposit scan: its USDG leg (log 8) is booked as capital-out", async () => {
    // What the scan reads: the account's USDG Transfer logs, and each receipt.
    const f = FX.recoverFunds!;
    const usdgLog = f.logs.find(([address, topics]) => address === USDG && topics[0]?.startsWith("0xddf252ad"))!;
    const chain = {
      async getBlockNumber() { return BigInt(f.block); },
      async getLogs(a: { topics: (Hex | Hex[] | null)[] }) {
        // The outbound scan (topic1 = the account) finds it; the inbound one finds nothing.
        return a.topics[1] ? [{ topics: usdgLog[1] as Hex[], data: usdgLog[2] as Hex, transactionHash: f.tx as Hex, blockNumber: f.block as Hex, logIndex: usdgLog[3] as Hex }] : [];
      },
      async getReceiptLogs() { return receipt("recoverFunds"); },
    };
    const scan = (tradeTxHashes: Set<string>) => findTransferFlows({ chain, smartAccount: ACCOUNT as `0x${string}`, usdgToken: USDG as `0x${string}`,
      fromBlock: BigInt(f.block), toBlock: BigInt(f.block), knownKeys: new Set(), tradeTxHashes, custodyAddresses: [VAULT], chainId: 4663 });
    const tradeTxs = await recentTradeTxHashes(ACCOUNT);
    assert.equal(tradeTxs.has(f.tx), false, "an owner operation is not a trade the scan skips");
    const flows = await scan(tradeTxs);
    assert.deepEqual(flows.map((x) => [x.direction, x.amountUsdg6, x.logIndex]), [["out", 348_368488n, 8]]);
    // THE OLD SUPPRESSION, for contrast: a 'swap' row carrying this tx hid the withdrawal, and the peak never came down.
    assert.deepEqual(await scan(new Set([f.tx])), []);
  });
});
