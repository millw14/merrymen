/**
 * An account whose ledger rows carry two spellings of its address (the mirror
 * copies agent_id as each worker incarnation wrote it). The evidence replays
 * match agent_id exactly, so a replay of one spelling is a partial tape that
 * can vouch for a sell whose quote-booked buy sits under the other. Reports and
 * exports must then vouch for nothing — the rule get_trades already applies.
 */
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CASH } from "@merrymen/core";
import { runTool, type ToolDef } from "../tool";
import { ACCOUNT_A, OWNER_A, connectAs, installFixtures, makeDeps, makeTestDb } from "../testing";
import { REPORTS_TOOLS } from "./reports";
import { PORTFOLIO_TOOLS } from "./portfolio";

const NOW = 1_800_000_000;
const USDG = CASH.USDG.toLowerCase();
const ROUTER = "0x00000000000000000000000000000000000000f1";
const TOKEN = "0x00000000000000000000000000000000000c0de1";
// A second spelling of the same account, as a redeploy can write it.
const OTHER_SPELLING = ACCOUNT_A.replace("a001", "A001");

function trade(raw: DatabaseSync, t: Record<string, string | number | null>) {
  raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, reject_rule, created_at,
      decision_id, fill_side, fill_symbol, fill_qty_raw, realized_pnl_usdg, basis_source, gas_wei, gas_usdg, fill_cash_usdg, epoch)
    VALUES (?, 'swap', ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 'TKN', ?, ?, ?, NULL, NULL, ?, 1)`).run(
    t.agent, ROUTER, t.sell, t.buy, t.amount ?? 10, t.op, t.tx, t.status, t.at, t.side, t.qty, t.pnl ?? null, t.basis, t.cash);
}

async function setup() {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  const restore = installFixtures(d, { settings: { [OWNER_A]: { agentName: "Shogun" } } });
  d.raw.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, mode, beat_at, live_blocker, epoch)
    VALUES (?, 'Agent', ?, '0x1', 4663, '{}', 1700000000, 4102444800, 'active', 'live', ?, NULL, 1)`).run(ACCOUNT_A, OWNER_A, NOW - 30);
  const a = await connectAs(deps, OWNER_A, { scopes: ["reports:read", "portfolio:read", "agents:read", "offline_access"] });
  const run = (defs: readonly unknown[], name: string, args: unknown) =>
    runTool((defs as ToolDef[]).find((t) => t.name === name)!, args, a.principal, "t", { now: () => NOW });
  const exported = async (kind: string) => {
    const ex = (await run(REPORTS_TOOLS, "create_export", { kind, format: "json" })).structuredContent as Record<string, string>;
    return JSON.parse((d.raw.prepare("SELECT content FROM mcp_exports WHERE id = ?").get(ex.export_id) as { content: string }).content) as { rows: Array<Record<string, unknown>>; notes?: string[] };
  };
  return { d, run, exported, restore };
}

test("two spellings: the summary and the trades export vouch for no sell (as get_trades does)", async () => {
  assert.notEqual(OTHER_SPELLING, ACCOUNT_A);
  const { d, run, exported, restore } = await setup();
  try {
    // A buy booked from the QUOTE (estimated cost), under the other spelling.
    trade(d.raw, { agent: OTHER_SPELLING, status: "landed", at: NOW - 40_000, op: "0xop1", tx: "0x" + "1".repeat(64), side: "buy", sell: USDG, buy: TOKEN, qty: "100", basis: "quote", cash: 20 });
    // A sell with a receipt, realised +5 against that estimated cost.
    trade(d.raw, { agent: ACCOUNT_A, status: "landed", at: NOW - 30_000, op: "0xop2", tx: "0x" + "2".repeat(64), side: "sell", sell: TOKEN, buy: USDG, qty: "100", basis: "receipt", cash: 25, pnl: 5 });

    const trades = (await run(PORTFOLIO_TOOLS, "get_trades", { book: "all", status: "all" })).structuredContent as { trades: Array<Record<string, unknown>> };
    assert.equal(trades.trades.find((t) => t.side === "sell")?.realized_pnl_measured, null, "get_trades already refuses");

    const s = (await run(REPORTS_TOOLS, "get_summary", { period: "day" })).structuredContent as { live: { realized_pnl: { usdg: number | null; evidenced_sells: number; notes: string[] } } };
    assert.equal(s.live.realized_pnl.evidenced_sells, 0);
    assert.equal(s.live.realized_pnl.usdg, null, "unknown, not 5 and not 0");
    assert.ok(s.live.realized_pnl.notes.some((n) => /two spellings/.test(n)));

    const ex = await exported("trades");
    const sells = ex.rows.filter((r) => r.side === "sell");
    assert.equal(sells.length, 1);
    assert.notEqual(sells[0]!.realized_pnl_status, "evidenced");
    assert.equal(sells[0]!.realized_pnl_usdg ?? null, null);
  } finally {
    restore();
  }
});

test("two spellings: the portfolio export does not state an unrealized P&L whose cost provenance it could not replay whole", async () => {
  const { d, exported, restore } = await setup();
  try {
    d.raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at) VALUES (?, '0', 10, 0, 30, 40, 1, 'live', ?)").run(ACCOUNT_A, NOW - 100);
    d.raw.prepare("INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg, updated_at) VALUES (?, 'TKN', ?, '100', '1', 0.3, 0, 30, ?)").run(ACCOUNT_A, TOKEN, NOW - 100);
    d.raw.prepare("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES (?, 'live', 'TKN', '100', '20000000', ?)").run(ACCOUNT_A, NOW - 100);
    // The buy that built the holding was booked from the quote, under the other spelling.
    trade(d.raw, { agent: OTHER_SPELLING, status: "landed", at: NOW - 40_000, op: "0xop1", tx: "0x" + "1".repeat(64), side: "buy", sell: USDG, buy: TOKEN, qty: "100", basis: "quote", cash: 20 });
    trade(d.raw, { agent: ACCOUNT_A, status: "landed", at: NOW - 30_000, op: "0xop9", tx: "0x" + "9".repeat(64), side: "buy", sell: USDG, buy: "0x00000000000000000000000000000000000c0de9", qty: "1", basis: "receipt", cash: 1 });

    const ex = await exported("portfolio");
    const pos = ex.rows.filter((r) => r.row_type === "position");
    assert.equal(pos.length, 1);
    assert.equal(pos[0]!.cost_from_quote ?? null, null, "not vouched for");
    assert.equal(pos[0]!.unrealized_pnl_usdg ?? null, null, "no unrealized figure over an estimate");
    assert.match(String(pos[0]!.note), /could not be checked/);
  } finally {
    restore();
  }
});
