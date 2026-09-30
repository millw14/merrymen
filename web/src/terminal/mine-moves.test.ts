/**
 * THE OWNER'S TAPE CARRIES WHAT IT ALREADY READS (D3).
 *
 * lib/desk-trades.ts selects, for every row of the owner's own tape, the
 * coin's name from the decision, the fill's transaction hash and the realized
 * P&L the executor booked on a sell. mineOf dropped all three on the floor, so
 * the desk could only print a symbol and no result, and the chat thread could
 * not tell a sell's receipt from the tape fill it produced except by guessing
 * from amounts and times. They ride on each `moves` row now, and nothing is
 * invented where the ledger said nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DatabaseSync } from "node:sqlite";

import { wrapSqlite } from "../../../worker/src/db";
import { readDeskTrades } from "@/lib/desk-trades";
import { fmtEpoch } from "@/lib/ledger";
import { mineOf } from "./live";

const HASH = `0x${"ab".repeat(32)}`;
const row = (over: Record<string, unknown>) => ({
  kind: "curve-trade",
  buy_token: "0xUSDG",
  sell_token: "0xcoin",
  amount_usdg: 6,
  status: "landed",
  created_at: "2026-09-23 10:00:00",
  fill_side: "sell",
  symbol: "CASHCAT",
  ...over,
});
const movesOf = (trades: ReturnType<typeof row>[]) =>
  mineOf({ agent: { name: "Shogun", strategy: "trencher", slug: null }, trades: trades as never }, [])!.moves;

describe("the owner's tape rows", () => {
  it("carry the coin's name, the fill's hash and the realized P&L the ledger booked", () => {
    const [sell] = movesOf([row({ display_name: "Cash Cat", tx_hash: HASH, realized_pnl_usdg: 1.25 })]);
    assert.equal(sell!.displayName, "Cash Cat");
    assert.equal(sell!.txHash, HASH);
    assert.equal(sell!.realizedPnlUsdg, 1.25);
  });

  it("a loss is a number, not a missing one", () => {
    const [sell] = movesOf([row({ realized_pnl_usdg: -0.4 })]);
    assert.equal(sell!.realizedPnlUsdg, -0.4);
    assert.equal(movesOf([row({ realized_pnl_usdg: 0 })])[0]!.realizedPnlUsdg, 0, "and a flat trade is zero, which is a result");
  });

  it("say nothing where the ledger said nothing — an older ledger, a refusal, an unpriced sell", () => {
    const [bare] = movesOf([row({})]);
    assert.equal(bare!.displayName, null);
    assert.equal(bare!.txHash, null);
    assert.equal(bare!.realizedPnlUsdg, null);
    const [blank] = movesOf([row({ display_name: "  ", tx_hash: "", realized_pnl_usdg: null })]);
    assert.equal(blank!.displayName, null, "a blank name is no name");
    assert.equal(blank!.txHash, null);
    assert.equal(blank!.realizedPnlUsdg, null, "unknown P&L is not a zero");
  });

  it("from the ledger read the route serves: the columns the desk tape selects reach the move", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await db.exec(`CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT, reason TEXT);
        CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, sell_token TEXT, buy_token TEXT,
          amount_usdg REAL, tx_hash TEXT, status TEXT, reject_rule TEXT, sim_quote_out TEXT, sim_min_out TEXT, sim_fee_tier INTEGER,
          sim_gas TEXT, created_at INTEGER, user_op_hash TEXT, decision_id TEXT, fill_side TEXT, fill_symbol TEXT,
          realized_pnl_usdg REAL, epoch INTEGER);
        INSERT INTO decisions VALUES ('d2','0xA','sell','CASHCAT','Cash Cat','took the move');`);
      const now = 1_800_000_000;
      await db
        .prepare(
          `INSERT INTO trades (agent_id, kind, sell_token, buy_token, amount_usdg, tx_hash, status, created_at, user_op_hash,
                               decision_id, fill_side, realized_pnl_usdg, epoch)
           VALUES ('0xA','curve-trade','0xCASHCAT','0xUSDG',6,?,'landed',?,'0xOP2','d2','sell',1.25,1)`,
        )
        .run(HASH, now - 60);
      const rows = await readDeskTrades(db, "0xA", 1, now - 3600);
      const [sell] = movesOf(rows.map((r) => ({ ...r, created_at: fmtEpoch(r.created_at) })) as never);
      assert.deepEqual([sell!.displayName, sell!.txHash, sell!.realizedPnlUsdg], ["Cash Cat", HASH, 1.25]);
    } finally {
      raw.close();
    }
  });

  it("a figure a database handed back as text is still read, and junk is not", () => {
    assert.equal(movesOf([row({ realized_pnl_usdg: "2.5" })])[0]!.realizedPnlUsdg, 2.5);
    assert.equal(movesOf([row({ realized_pnl_usdg: "" })])[0]!.realizedPnlUsdg, null, "an empty string is not a zero");
    assert.equal(movesOf([row({ realized_pnl_usdg: "n/a" })])[0]!.realizedPnlUsdg, null);
  });
});
