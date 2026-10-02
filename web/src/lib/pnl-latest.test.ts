import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite } from "../../../worker/src/db";
import { findLatestCardable, findLatestCardableInDb, type LatestTradeRow } from "./pnl-latest";

const sell = (over: Partial<LatestTradeRow> = {}): LatestTradeRow => ({
  id: 7,
  target: "0xrouter",
  fill_side: "sell",
  fill_cash_usdg: 120,
  realized_pnl_usdg: 20,
  status: "landed",
  coin_symbol: "NEON",
  ...over,
});

describe("findLatestCardable — which trade the chat card shows", () => {
  it("returns the latest cardable close with paper status intact", () => {
    assert.deepEqual(findLatestCardable([sell({ status: "paper" })]), {
      tradeId: 7,
      symbol: "NEON",
      status: "paper",
      realizedPnlUsdg: 20,
    });
  });

  it("skips buys, refusals-shaped rows, unbacked and dust sells", () => {
    assert.equal(
      findLatestCardable([
        { ...sell(), id: 9, fill_side: "buy" },
        { ...sell(), id: 8, realized_pnl_usdg: null },
        { ...sell(), id: 7, fill_cash_usdg: 0.005, realized_pnl_usdg: -0.001 },
      ]),
      null,
    );
  });

  it("an unnameable coin does not hide the cardable close behind it", () => {
    const found = findLatestCardable([
      { ...sell(), id: 9, coin_symbol: "0xabc123" },
      { ...sell(), id: 8, coin_symbol: "TABCDEF12345" },
      { ...sell(), id: 7, coin_symbol: "NEON" },
    ]);
    assert.equal(found?.tradeId, 7);
    assert.equal(found?.symbol, "NEON");
  });

  it("empty ledger and malformed rows yield none, never throw", () => {
    assert.equal(findLatestCardable([]), null);
    assert.equal(findLatestCardable([{ id: -1 } as never]), null);
    assert.equal(findLatestCardable([{ id: 3, fill_side: "sell" } as never]), null);
  });
});

describe("findLatestCardableInDb — the sell predicate lives in SQL", () => {
  /** Minimal ledger: only the columns the lookup query touches. */
  function memoryLedger() {
    const raw = new DatabaseSync(":memory:");
    raw.exec(`
      CREATE TABLE decisions (id INTEGER PRIMARY KEY, agent_id TEXT, symbol TEXT);
      CREATE TABLE trades (id INTEGER PRIMARY KEY, target TEXT, fill_side TEXT,
        fill_cash_usdg REAL, realized_pnl_usdg REAL, status TEXT,
        fill_symbol TEXT, decision_id INTEGER, agent_id TEXT);
    `);
    return { raw, db: wrapSqlite(raw) };
  }

  function insertTrade(
    raw: DatabaseSync,
    id: number,
    over: { side?: string; cash?: number | null; realized?: number | null; symbol?: string | null } = {},
  ) {
    const side = over.side ?? "buy";
    raw
      .prepare(
        `INSERT INTO trades (id, target, fill_side, fill_cash_usdg, realized_pnl_usdg, status, fill_symbol, decision_id, agent_id)
         VALUES (?, '0xrouter', ?, ?, ?, 'landed', ?, NULL, 'agent-1')`,
      )
      .run(id, side, over.cash ?? null, over.realized ?? null, over.symbol ?? "NEON");
  }

  it("a valid close behind 25 newer buys is still found (the old LIMIT-20 truncation)", async () => {
    const { raw, db } = memoryLedger();
    try {
      insertTrade(raw, 1, { side: "sell", cash: 120, realized: 20 });
      for (let id = 2; id <= 26; id++) insertTrade(raw, id, { side: "buy" });
      const result = await findLatestCardableInDb(db, "agent-1");
      assert.equal(result.outcome, "found");
      assert.equal(result.outcome === "found" && result.trade.tradeId, 1);
      assert.equal(result.outcome === "found" && result.trade.symbol, "NEON");
    } finally {
      raw.close();
    }
  });

  it("walks past dust and unbacked sells across page boundaries", async () => {
    const { raw, db } = memoryLedger();
    try {
      insertTrade(raw, 1, { side: "sell", cash: 120, realized: 20 });
      insertTrade(raw, 2, { side: "sell", cash: 0.005, realized: -0.001 });
      insertTrade(raw, 3, { side: "sell", cash: null, realized: null });
      // Small pages force the cursor path after only two rows.
      const result = await findLatestCardableInDb(db, "agent-1", 2);
      assert.equal(result.outcome, "found");
      assert.equal(result.outcome === "found" && result.trade.tradeId, 1);
    } finally {
      raw.close();
    }
  });

  it("returns none when no sell is cardable, and scopes to the agent", async () => {
    const { raw, db } = memoryLedger();
    try {
      insertTrade(raw, 1, { side: "buy" });
      insertTrade(raw, 2, { side: "sell", cash: 0.005, realized: -0.001 });
      assert.deepEqual(await findLatestCardableInDb(db, "agent-1"), { outcome: "none" });
      assert.deepEqual(await findLatestCardableInDb(db, "agent-2"), { outcome: "none" });
    } finally {
      raw.close();
    }
  });

  it("says incomplete, never none, when the budget runs out with rows unexamined", async () => {
    const { raw, db } = memoryLedger();
    try {
      // The only cardable close sits beneath more uncardable sells than one
      // page of two holds — a capped search must admit it stopped looking.
      insertTrade(raw, 1, { side: "sell", cash: 120, realized: 20 });
      insertTrade(raw, 2, { side: "sell", cash: 0.005, realized: -0.001 });
      insertTrade(raw, 3, { side: "sell", cash: null, realized: null });
      insertTrade(raw, 4, { side: "sell", cash: 0.004, realized: -0.002 });
      insertTrade(raw, 5, { side: "sell", cash: null, realized: 10 });
      assert.deepEqual(await findLatestCardableInDb(db, "agent-1", 2, 1), { outcome: "incomplete" });
      // ...while the same ledger with room to finish finds trade 1.
      const finished = await findLatestCardableInDb(db, "agent-1", 2, 10);
      assert.equal(finished.outcome, "found");
      assert.equal(finished.outcome === "found" && finished.trade.tradeId, 1);
    } finally {
      raw.close();
    }
  });
});
