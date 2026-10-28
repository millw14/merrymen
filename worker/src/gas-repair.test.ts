/**
 * Completing the gas of rows already written. What matters: only the rows the
 * board counts as missing are read; only NULL columns are filled, and only from
 * the row's own receipt and the round in force at its block; a disagreement is
 * left for a person; apply is all or nothing; a revert puts back exactly what
 * was there. "Postgres" here is a real sqlite ledger with the store's schema.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, parseAbi, toHex, type Hex } from "viem";
import { CASH_FEEDS, CHAINLINK_ABI, ENTRYPOINT } from "../../packages/core/src/index";
import type { RpcCall } from "./chain-capital";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import {
  applyGasRepair, CHAIN_ID, GasRepairRefused, parseApplyReport, planGasRepair, readGasSnapshot, REPAIRS_SCHEMA, REPAIRS_TABLE, repairOf, revertGasRepair, stampCommitOutcome,
  type GasRepairPlan,
} from "./gas-repair";
import { createRepairRpc, main, parseRepairArgs } from "./gas-repair-cli";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./chain-gap-booking-cli";

const EP_ABI = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
const A = "0x00000000000000000000000000000000000a0001";
const B = "0x00000000000000000000000000000000000b0002";
const ZERO = "0x0000000000000000000000000000000000000000";
const SPONSOR = "0x00000000000000000000000000000000005b0000";
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const handles: DatabaseSync[] = [];
after(() => { for (const r of handles) r.close(); });

async function ledger(): Promise<Db> {
  const raw = new DatabaseSync(":memory:"); handles.push(raw);
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  return db;
}
async function trade(db: Db, o: { agent: string; status: string; op?: Hex | null; tx?: Hex | null; gasWei?: string | null; sponsored?: string | null; usd?: number | null; units?: string | null }): Promise<number> {
  const row = await db.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, gas_wei, sponsored_gas_wei, gas_usdg, gas_units)
      VALUES (?, 'swap', ?, 2.5, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(o.agent, o.agent, o.op ?? null, o.tx ?? null, o.status, o.gasWei ?? null, o.sponsored ?? null, o.usd ?? null, o.units ?? null) as Record<string, unknown>;
  return Number(row.id);
}
/** A plain object: node:sqlite rows have a null prototype, which deepStrictEqual tells apart. */
const gasCols = async (db: Db, id: number) =>
  ({ ...(await db.prepare("SELECT gas_wei, sponsored_gas_wei, gas_units, gas_usdg FROM trades WHERE id = ?").get(id) as Record<string, unknown>) });

/** One UserOperationEvent log, as a receipt carries it. */
function opLog(op: Hex, sender: string, o: { success?: boolean; gasWei?: bigint; units?: bigint; paymaster?: string } = {}) {
  return {
    address: ENTRYPOINT.v07,
    topics: encodeEventTopics({ abi: EP_ABI, eventName: "UserOperationEvent", args: { userOpHash: op, sender: sender as `0x${string}`, paymaster: (o.paymaster ?? ZERO) as `0x${string}` } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [1n, o.success ?? true, o.gasWei ?? 2_000_000_000_000_000n, o.units ?? 300_000n]),
  };
}

/**
 * A chain: receipts by tx, block times by number, and an ETH/USD feed whose
 * rounds are $2,000 from t=1,000 and $4,000 from t=50,000 (8 decimals).
 */
function chain(receipts: Record<string, { block: number; logs: unknown[] }>, blockTimes: Record<number, number>, chainId = CHAIN_ID): RpcCall & { calls: string[] } {
  const phase = 1n << 64n;
  const rounds = [{ at: 1_000, px: 2_000_00000000n }, { at: 50_000, px: 4_000_00000000n }];
  const roundData = (i: number) => encodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "getRoundData",
    result: [phase | BigInt(i + 1), rounds[i]!.px, 0n, BigInt(rounds[i]!.at), phase | BigInt(i + 1)] });
  const calls: string[] = [];
  const rpc = (async (method: string, params: unknown[]) => {
    calls.push(method);
    if (method === "eth_chainId") return toHex(chainId);
    if (method === "eth_getTransactionReceipt") {
      const r = receipts[String(params[0]).toLowerCase()];
      return r ? { blockNumber: toHex(r.block), logs: r.logs } : null;
    }
    if (method === "eth_getBlockByNumber") return { timestamp: toHex(blockTimes[Number(BigInt(String(params[0])))]!) };
    if (method === "eth_call") {
      const { to, data } = params[0] as { to: string; data: string };
      assert.equal(to.toLowerCase(), CASH_FEEDS.ETH_USD.toLowerCase());
      if (data === encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "decimals" })) return encodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "decimals", result: 8 });
      if (data === encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "latestRoundData" })) {
        return encodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "latestRoundData", result: [phase | 2n, rounds[1]!.px, 0n, BigInt(rounds[1]!.at), phase | 2n] });
      }
      const id = BigInt(`0x${data.slice(10)}`) & ((1n << 64n) - 1n);
      if (id >= 1n && id <= 2n) return roundData(Number(id) - 1);
      return encodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "getRoundData", result: [phase | id, 0n, 0n, 0n, phase | id] });
    }
    throw new Error(`unexpected ${method}`);
  }) as RpcCall & { calls: string[] };
  rpc.calls = calls;
  return rpc;
}
const plan = (db: Db, rpc: RpcCall, tenant: string | null = null) =>
  db.tx(async (tx) => readGasSnapshot(tx, tenant ? { tenant } : {}))
    .then((rows) => planGasRepair(rows, rpc, { tenant, target: "t".repeat(64), source: { "gas-repair.ts": "s" }, maxReceipts: 500 }));

describe("readGasSnapshot — the rows the board counts as missing, and no others", () => {
  it("reads unrecorded and unpriced rows; skips priced, sponsored, free and unsettled ones", async () => {
    const db = await ledger();
    const unrecorded = await trade(db, { agent: A, status: "reverted", op: h(1), tx: h(11) });
    const unpriced = await trade(db, { agent: A, status: "landed", op: h(2), tx: h(12), gasWei: "100" });
    await trade(db, { agent: A, status: "landed", op: h(3), tx: h(13), gasWei: "100", usd: 0.1 });
    await trade(db, { agent: A, status: "landed", op: h(4), tx: h(14), sponsored: "100" });
    await trade(db, { agent: A, status: "landed", op: h(5), tx: h(15), gasWei: "0" });
    await trade(db, { agent: A, status: "submitted", op: h(6) });
    await trade(db, { agent: B, status: "landed", op: h(7), tx: h(17) });
    const all = await db.tx((tx) => readGasSnapshot(tx));
    assert.deepEqual(all.map((r) => r.id).slice(0, 2), [unrecorded, unpriced]);
    assert.equal(all.length, 3);
    assert.equal((await db.tx((tx) => readGasSnapshot(tx, { tenant: A }))).length, 2);
  });
});

describe("planGasRepair — from the receipt and the round in force", () => {
  it("completes an owner-paid revert with its receipt's cost, priced at its block's round", async () => {
    const db = await ledger();
    const id = await trade(db, { agent: A, status: "reverted", op: h(1), tx: h(11) });
    const rpc = chain({ [h(11)]: { block: 100, logs: [opLog(h(1), A, { success: false })] } }, { 100: 10_000 });
    const p = await plan(db, rpc);
    assert.equal(p.repairs.length, 1);
    const r = p.repairs[0]!;
    assert.equal(r.id, id);
    // 0.002 ETH at the $2,000 round in force at t=10,000 — not today's $4,000.
    assert.deepEqual(r.after, { gas_wei: "2000000000000000", sponsored_gas_wei: null, gas_units: "300000", gas_usdg: 4 });
    assert.equal(r.priced?.priceUsd, 2_000);
    assert.match(p.previewDigest, /^[0-9a-f]{64}$/);
  });

  it("books a sponsor-paid cost as the sponsor's, with no price", async () => {
    const db = await ledger();
    await trade(db, { agent: A, status: "landed", op: h(1), tx: h(11) });
    const p = await plan(db, chain({ [h(11)]: { block: 100, logs: [opLog(h(1), A, { paymaster: SPONSOR })] } }, { 100: 10_000 }));
    assert.deepEqual(p.repairs[0]!.after, { gas_wei: null, sponsored_gas_wei: "2000000000000000", gas_units: "300000", gas_usdg: null });
  });

  it("prices recorded wei that had no price, and keeps the wei it had", async () => {
    const db = await ledger();
    await trade(db, { agent: A, status: "landed", op: h(1), tx: h(11), gasWei: "2000000000000000" });
    const p = await plan(db, chain({ [h(11)]: { block: 100, logs: [opLog(h(1), A)] } }, { 100: 60_000 }));
    assert.equal(p.repairs[0]!.after.gas_usdg, 8);
    assert.equal(p.repairs[0]!.before.gas_wei, "2000000000000000");
  });

  it("leaves an owner cost it cannot price for a later run — never half-completed, never a guessed price", async () => {
    const db = await ledger();
    const id = await trade(db, { agent: A, status: "landed", op: h(1), tx: h(11) });
    const p = await plan(db, chain({ [h(11)]: { block: 100, logs: [opLog(h(1), A)] } }, { 100: 500 }));
    assert.equal(p.repairs.length, 0);
    assert.match(p.unresolved.find((u) => u.id === id)!.why, /no Chainlink round prices it yet/);
  });

  it("leaves every disagreement for a person", async () => {
    const db = await ledger();
    const wrongWei = await trade(db, { agent: A, status: "landed", op: h(1), tx: h(11), gasWei: "5" });
    const wrongPayer = await trade(db, { agent: A, status: "landed", op: h(2), tx: h(12), gasWei: "2000000000000000" });
    const wrongStatus = await trade(db, { agent: A, status: "landed", op: h(3), tx: h(13) });
    const wrongSender = await trade(db, { agent: A, status: "landed", op: h(4), tx: h(14) });
    const noTx = await trade(db, { agent: A, status: "landed", op: h(5), tx: null });
    // The sponsor column must agree with the receipt too, both ways.
    const bothPayers = await trade(db, { agent: A, status: "landed", op: h(6), tx: h(16), gasWei: "2000000000000000", sponsored: "2000000000000000" });
    const placeholder = await trade(db, { agent: A, status: "landed", op: h(7), tx: h(17), sponsored: "0" });
    const rpc = chain({
      [h(11)]: { block: 100, logs: [opLog(h(1), A)] },
      [h(12)]: { block: 100, logs: [opLog(h(2), A, { paymaster: SPONSOR })] },
      [h(13)]: { block: 100, logs: [opLog(h(3), A, { success: false })] },
      [h(14)]: { block: 100, logs: [opLog(h(4), B)] },
      [h(16)]: { block: 100, logs: [opLog(h(6), A)] },
      [h(17)]: { block: 100, logs: [opLog(h(7), A, { paymaster: SPONSOR })] },
    }, { 100: 10_000 });
    const p = await plan(db, rpc);
    assert.equal(p.repairs.length, 0);
    const why = new Map(p.unresolved.map((u) => [u.id, u.why]));
    assert.match(why.get(wrongWei)!, /differs from its receipt/);
    assert.match(why.get(wrongPayer)!, /sponsor paid/);
    assert.match(why.get(wrongStatus)!, /reverted, the row says landed/);
    assert.match(why.get(wrongSender)!, /no single UserOperationEvent/);
    assert.match(why.get(noTx)!, /no transaction hash/);
    assert.match(why.get(bothPayers)!, /books a sponsor cost, and the receipt says the owner paid/);
    assert.match(why.get(placeholder)!, /recorded sponsor cost differs from its receipt/);
  });

  it("refuses a chain that is not Robinhood Chain", async () => {
    const db = await ledger();
    await assert.rejects(plan(db, chain({}, {}, 1)), (e: unknown) => e instanceof GasRepairRefused && e.code === "chain");
  });

  it("is the same plan, digest and all, when read twice", async () => {
    const db = await ledger();
    await trade(db, { agent: A, status: "reverted", op: h(1), tx: h(11) });
    const rpc = chain({ [h(11)]: { block: 100, logs: [opLog(h(1), A, { success: false })] } }, { 100: 10_000 });
    assert.equal((await plan(db, rpc)).previewDigest, (await plan(db, rpc)).previewDigest);
  });

  it("never fills a column the row already holds", () => {
    const row = { id: 1, account: A, status: "landed" as const, userOpHash: h(1), txHash: h(11), gas_wei: null, sponsored_gas_wei: null, gas_units: "7", gas_usdg: null };
    const priced = { usdg: 0.01, round: { roundId: "1", priceUsd: 2_000, lagSec: 5 } };
    const r = repairOf(row, { blockNumber: 1, blockTime: 1, success: true, gasWei: 10n, gasUnits: 7n, payer: "owner" }, priced);
    assert.ok("repair" in r);
    assert.equal(r.repair.after.gas_units, "7");
    assert.ok("why" in repairOf({ ...row, gas_units: "8" }, { blockNumber: 1, blockTime: 1, success: true, gasWei: 10n, gasUnits: 7n, payer: "owner" }, priced));
  });
});

describe("applyGasRepair and revertGasRepair", () => {
  async function planned(): Promise<{ db: Db; p: GasRepairPlan; ids: number[] }> {
    const db = await ledger();
    const ids = [
      await trade(db, { agent: A, status: "reverted", op: h(1), tx: h(11) }),
      await trade(db, { agent: A, status: "landed", op: h(2), tx: h(12) }),
    ];
    const rpc = chain({
      [h(11)]: { block: 100, logs: [opLog(h(1), A, { success: false })] },
      [h(12)]: { block: 101, logs: [opLog(h(2), A, { paymaster: SPONSOR })] },
    }, { 100: 10_000, 101: 10_002 });
    return { db, p: await plan(db, rpc), ids };
  }

  it("writes exactly the plan, a receipt each, and the board stops counting the rows", async () => {
    const { db, p, ids } = await planned();
    let persisted = 0;
    const report = await applyGasRepair(db, p, { confirm: p.previewDigest, backupRef: "railway-pitr-1", repairId: "r1", nowMs: 1, persist: () => { persisted++; } });
    assert.equal(persisted, 1, "the report is persisted inside the transaction, before the COMMIT");
    assert.equal(report.rows.length, 2);
    assert.deepEqual(await gasCols(db, ids[0]!), { gas_wei: "2000000000000000", sponsored_gas_wei: null, gas_units: "300000", gas_usdg: 4 });
    assert.deepEqual(await gasCols(db, ids[1]!), { gas_wei: null, sponsored_gas_wei: "2000000000000000", gas_units: "300000", gas_usdg: null });
    assert.equal((await db.tx((tx) => readGasSnapshot(tx))).length, 0);
    const receipts = await db.prepare(`SELECT state FROM ${REPAIRS_TABLE} WHERE repair_id = 'r1'`).all() as Record<string, unknown>[];
    assert.deepEqual(receipts.map((r) => r.state), ["applied", "applied"]);
  });

  it("refuses an unconfirmed digest and an unnamed backup, writing nothing", async () => {
    const { db, p } = await planned();
    await assert.rejects(applyGasRepair(db, p, { confirm: "0".repeat(64), backupRef: "railway-pitr-1", repairId: "r1", nowMs: 1 }),
      (e: unknown) => e instanceof GasRepairRefused && e.code === "confirm-mismatch");
    await assert.rejects(applyGasRepair(db, p, { confirm: p.previewDigest, backupRef: "", repairId: "r1", nowMs: 1 }),
      (e: unknown) => e instanceof GasRepairRefused && e.code === "backup-ref");
    assert.equal((await db.tx((tx) => readGasSnapshot(tx))).length, 2);
  });

  it("is all or nothing: one row that moved since the preview refuses the whole apply", async () => {
    const { db, p, ids } = await planned();
    await db.prepare("UPDATE trades SET gas_units = '1' WHERE id = ?").run(ids[1]!);
    await assert.rejects(applyGasRepair(db, p, { confirm: p.previewDigest, backupRef: "railway-pitr-1", repairId: "r1", nowMs: 1 }),
      (e: unknown) => e instanceof GasRepairRefused && e.code === "row-moved");
    assert.deepEqual(await gasCols(db, ids[0]!), { gas_wei: null, sponsored_gas_wei: null, gas_units: null, gas_usdg: null }, "the first row was rolled back too");
  });

  it("reverts exactly what it wrote, once", async () => {
    const { db, p, ids } = await planned();
    const report = await applyGasRepair(db, p, { confirm: p.previewDigest, backupRef: "railway-pitr-1", repairId: "r1", nowMs: 1 });
    const parsed = parseApplyReport(JSON.stringify(stampCommitOutcome(report, "committed")));
    assert.equal((await revertGasRepair(db, parsed, { nowMs: 2 })).outcome, "reverted");
    assert.deepEqual(await gasCols(db, ids[0]!), { gas_wei: null, sponsored_gas_wei: null, gas_units: null, gas_usdg: null });
    assert.equal((await revertGasRepair(db, parsed, { nowMs: 3 })).outcome, "already-reverted");
  });

  it("refuses to revert a row changed since the apply", async () => {
    const { db, p, ids } = await planned();
    const report = await applyGasRepair(db, p, { confirm: p.previewDigest, backupRef: "railway-pitr-1", repairId: "r1", nowMs: 1 });
    await db.prepare("UPDATE trades SET gas_usdg = 9 WHERE id = ?").run(ids[0]!);
    await assert.rejects(revertGasRepair(db, report, { nowMs: 2 }), (e: unknown) => e instanceof GasRepairRefused && e.code === "row-changed");
  });

  it("names a row that already holds an applied repair, and writes nothing", async () => {
    const { db, p, ids } = await planned();
    for (const statement of REPAIRS_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.exec(statement);
    await db.prepare(`INSERT INTO ${REPAIRS_TABLE} (repair_id, trade_id, account, before_json, after_json, evidence_json, preview_digest, backup_ref, state, applied_at_ms)
        VALUES ('r0', ?, ?, '{}', '{}', '{}', 'd', 'b', 'applied', 0)`).run(ids[1]!, A);
    await assert.rejects(applyGasRepair(db, p, { confirm: p.previewDigest, backupRef: "railway-pitr-1", repairId: "r1", nowMs: 1 }),
      (e: unknown) => e instanceof GasRepairRefused && e.code === "already-repaired");
    assert.deepEqual(await gasCols(db, ids[0]!), { gas_wei: null, sponsored_gas_wei: null, gas_units: null, gas_usdg: null });
  });

  it("refuses a report that does not verify", () => {
    assert.throws(() => parseApplyReport(JSON.stringify({ format: "merrymen.gas-repair.apply.v1", rows: [] })), (e: unknown) => e instanceof GasRepairRefused);
  });
});

describe("the shell", () => {
  it("parses the four modes, and refuses half of one", () => {
    assert.deepEqual(parseRepairArgs(["--output", "/tmp/p.json"]), { mode: "preview", output: "/tmp/p.json", tenant: null, maxReceipts: 500 });
    assert.equal((parseRepairArgs(["--apply", "--confirm", "a".repeat(64), "--backup-ref", "b1", "--output", "/tmp/a.json"]) as { mode: string }).mode, "apply");
    assert.equal((parseRepairArgs(["--check", "/tmp/a.json", "--output", "/tmp/c.json"]) as { mode: string }).mode, "check");
    assert.equal((parseRepairArgs(["--revert", "/tmp/a.json", "--output", "/tmp/r.json"]) as { mode: string }).mode, "revert");
    for (const bad of [["--output", "rel.json"], ["--confirm", "a".repeat(64), "--output", "/tmp/p.json"], ["--apply", "--output", "/tmp/a.json"],
      ["--revert", "/tmp/a.json", "--tenant", A, "--output", "/tmp/r.json"]]) {
      assert.throws(() => parseRepairArgs(bad), (e: unknown) => e instanceof CliError && e.code === "invalid-arguments");
    }
  });

  it("reads an apply that died before its report as one that never committed", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gas-repair-")));
    const report = path.join(dir, "apply.json");
    writeFileSync(report, "");
    for (const mode of ["--check", "--revert"]) {
      await assert.rejects(main([mode, report, "--output", path.join(dir, `${mode.slice(2)}.json`)], { DATABASE_URL: "postgres://db.internal:5432/ledger" }, { out: () => {} }),
        (e: unknown) => e instanceof GasRepairRefused && e.code === "report-unfinished");
    }
  });

  it("talks to a node only through its read allowlist", async () => {
    const rpc = createRepairRpc("https://rpc.example", (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }))) as typeof fetch);
    await assert.rejects(rpc("eth_sendRawTransaction", ["0x"]), (e: unknown) => e instanceof CliError && e.code === "rpc-method-outside-read-allowlist");
    await assert.rejects(rpc("eth_call", [{ to: A, data: "0x313ce567" }, "latest"]), (e: unknown) => e instanceof CliError && e.code === "rpc-call-outside-read-allowlist");
    await assert.rejects(rpc("eth_call", [{ to: CASH_FEEDS.ETH_USD, data: "0xa9059cbb" }, "latest"]), (e: unknown) => e instanceof CliError && e.code === "rpc-call-outside-read-allowlist");
    assert.equal(await rpc("eth_call", [{ to: CASH_FEEDS.ETH_USD, data: "0x313ce567" }, "latest"]), "0x1");
  });
});
