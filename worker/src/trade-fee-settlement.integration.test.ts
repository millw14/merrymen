/** Exercise the real submitted -> settled writer, not an SQL text assertion. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TradeRow } from "./store";
import { distinctTrades } from "./distinct-trades";

const home = mkdtempSync(path.join(tmpdir(), "mm-trade-fee-settlement-"));
process.env.MERRYMEN_HOME = home;
const { addTrade, closeStoreForTest, initStore } = await import("./store");
const { homePaths } = await import("./home");
const account = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

before(initStore);
after(() => { closeStoreForTest(); rmSync(home, { recursive: true, force: true }); });

function withRaw<T>(fn: (raw: DatabaseSync) => T): T {
  const raw = new DatabaseSync(homePaths.db());
  try { return fn(raw); } finally { raw.close(); }
}
function rows(agent: string, op: string): Record<string, unknown>[] {
  return withRaw((raw) => raw.prepare("SELECT id, status, epoch, created_at, trade_fee_usdg, user_op_nonce FROM trades WHERE agent_id=? AND user_op_hash=? ORDER BY id").all(agent, op));
}
function canonicalFee(agent: string, op: string): unknown {
  return withRaw((raw) => raw.prepare(`SELECT t.trade_fee_usdg FROM ${distinctTrades("t.agent_id = ?")} WHERE t.user_op_hash = ?`).get(agent, op)?.trade_fee_usdg);
}
function journalCount(agent: string): number {
  return withRaw((raw) => Number(raw.prepare("SELECT COUNT(*) AS n FROM journal WHERE agent_id=?").get(agent)?.n));
}
function proposal(n: number): TradeRow {
  return { agent_id: account(n), kind: "swap", target: account(100), amount_usdg: 10,
    sell_token: account(200), buy_token: account(300), user_op_hash: hash(n), user_op_nonce: "7", status: "submitted" };
}
function settled(p: TradeRow, fee?: number): TradeRow {
  return { ...p, status: "landed", tx_hash: hash(10_000 + Number(BigInt(p.user_op_hash!))),
    fill_side: "buy", fill_qty_raw: "100", fill_cash_usdg: 10, realized_pnl_usdg: 0,
    basis_source: "receipt", gas_wei: "1", gas_usdg: 0.1,
    ...(fee === undefined ? {} : { trade_fee_usdg: fee }) };
}

describe("turnover fee follows the settled operation", () => {
  it("persists the supplied fee on the original submitted row without adding another operation", async () => {
    const p = proposal(1);
    assert.equal(await addTrade(p), true);
    const before = rows(p.agent_id, p.user_op_hash!)[0]!;
    assert.equal(before.trade_fee_usdg, null);
    assert.equal(await addTrade(settled(p, 0.05)), true);
    const after = rows(p.agent_id, p.user_op_hash!);
    assert.equal(after.length, 1);
    assert.equal(after[0]!.id, before.id);
    assert.equal(after[0]!.epoch, before.epoch);
    assert.equal(after[0]!.created_at, before.created_at);
    assert.equal(after[0]!.user_op_nonce, "7");
    assert.equal(after[0]!.status, "landed");
    assert.equal(after[0]!.trade_fee_usdg, 0.05);
    assert.equal(journalCount(p.agent_id), 1);
  });

  it("keeps an explicitly assessed zero distinct from a receipt with no fee assessment", async () => {
    for (const [n, fee] of [[2, 0], [3, undefined]] as const) {
      const p = proposal(n);
      assert.equal(await addTrade(p), true);
      assert.equal(await addTrade(settled(p, fee)), true);
      assert.equal(canonicalFee(p.agent_id, p.user_op_hash!), fee ?? null);
    }
  });

  it("recovers the placeholder across a process restart and persists its fee across another restart", async () => {
    const p = proposal(4);
    assert.equal(await addTrade(p), true);
    const id = rows(p.agent_id, p.user_op_hash!)[0]!.id;
    closeStoreForTest(); await initStore();
    assert.equal(await addTrade(settled(p, 0.05)), true);
    closeStoreForTest(); await initStore();
    const result = rows(p.agent_id, p.user_op_hash!);
    assert.equal(result.length, 1); assert.equal(result[0]!.id, id);
    assert.equal(result[0]!.trade_fee_usdg, 0.05); assert.equal(journalCount(p.agent_id), 1);
  });

  it("a failed journal append rolls the fee and settlement back together; retry records each once", async () => {
    const p = proposal(5);
    assert.equal(await addTrade(p), true);
    withRaw((raw) => raw.exec(`CREATE TRIGGER fail_fee_journal BEFORE INSERT ON journal
      WHEN NEW.agent_id = '${p.agent_id}' BEGIN SELECT RAISE(ABORT, 'test journal unavailable'); END;`));
    try {
      assert.equal(await addTrade(settled(p, 0.05)), false);
      const failed = rows(p.agent_id, p.user_op_hash!);
      assert.equal(failed.length, 1); assert.equal(failed[0]!.status, "submitted");
      assert.equal(failed[0]!.trade_fee_usdg, null); assert.equal(journalCount(p.agent_id), 0);
    } finally { withRaw((raw) => raw.exec("DROP TRIGGER fail_fee_journal")); }
    assert.equal(await addTrade(settled(p, 0.05)), true);
    assert.equal(rows(p.agent_id, p.user_op_hash!).length, 1);
    assert.equal(canonicalFee(p.agent_id, p.user_op_hash!), 0.05); assert.equal(journalCount(p.agent_id), 1);
  });

  it("late copies never rewrite the settled fee or charge the canonical operation twice", async () => {
    const p = proposal(6);
    assert.equal(await addTrade(p), true); assert.equal(await addTrade(settled(p, 0.05)), true);
    assert.equal(await addTrade(settled(p, 0.99)), true);
    const result = rows(p.agent_id, p.user_op_hash!);
    // The store deliberately preserves duplicate arrivals as separate raw rows;
    // the canonical operation reader is the existing deduplication boundary.
    assert.equal(result.length, 2); assert.equal(result[0]!.trade_fee_usdg, 0.05);
    assert.equal(canonicalFee(p.agent_id, p.user_op_hash!), 0.05);
    const sum = withRaw((raw) => raw.prepare(`SELECT COUNT(*) AS n, SUM(t.trade_fee_usdg) AS fee FROM ${distinctTrades("t.agent_id = ?")}`).get(p.agent_id));
    assert.equal(sum?.n, 1); assert.equal(sum?.fee, 0.05);
    assert.equal(withRaw((raw) => raw.prepare("SELECT COUNT(*) AS n FROM fee_accruals WHERE agent_id=?").get(p.agent_id)?.n), 0);
  });

  it("does not invent a retrospective fee for an already-settled unknown assessment or another tenant", async () => {
    const p = proposal(7), other = { ...p, agent_id: account(8) };
    assert.equal(await addTrade(p), true); assert.equal(await addTrade(other), true);
    assert.equal(await addTrade(settled(p)), true);
    assert.equal(await addTrade(settled(p, 0.05)), true);
    assert.equal(canonicalFee(p.agent_id, p.user_op_hash!), null);
    assert.equal(rows(other.agent_id, other.user_op_hash!)[0]!.status, "submitted");
    assert.equal(rows(other.agent_id, other.user_op_hash!)[0]!.trade_fee_usdg, null);
  });
});
