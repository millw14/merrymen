/**
 * NO % ON A COST THE LEDGER CANNOT VOUCH FOR.
 *
 * When the worker cannot read a fill's receipt it books the cost from the
 * pre-trade quote, and marks the TRADE row `basis_source = 'quote'`. The cost
 * that reaches `cost_basis` carries no such mark, /api/feed passed it to the
 * desk, and the desk began printing a definite "+20.00%" computed from it — a
 * precise figure resting on an estimate, with nothing on the row to say so.
 *
 * Driven end to end: the ledger read the route now calls, the terminal's mapping,
 * and what the desk and the chat are handed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { PROVENANCE_ROWS, costFromQuote, readDeskPositions, type BasisFill } from "./desk-positions";
import { mineOf } from "../terminal/live";
import { chatPositionsOf, positionsOf } from "../terminal/account";

const buy = (qty: number, source = "receipt"): BasisFill => ({ side: "buy", qtyRaw: String(qty), source });
const sell = (qty: number, source = "receipt"): BasisFill => ({ side: "sell", qtyRaw: String(qty), source });

describe("replaying the fills behind a holding", () => {
  it("a quote-booked buy still held is in the cost", () => {
    assert.equal(costFromQuote([buy(10, "quote"), buy(10)], true), true);
    assert.equal(costFromQuote([buy(10, "quote"), sell(5)], true), true, "half of it is still held, and so is half its cost");
  });

  it("every fill from a receipt vouches for the cost", () => {
    assert.equal(costFromQuote([buy(10), sell(4), buy(3)], true), false);
    assert.equal(costFromQuote([], true), false);
  });

  it("a quote-booked position that closed leaves nothing in the cost of the next one", () => {
    assert.equal(costFromQuote([buy(10, "quote"), sell(10), buy(7)], true), false);
    assert.equal(costFromQuote([buy(10, "quote"), sell(12), buy(7)], true), false, "a sell past the holding closes it too");
  });

  it("a row that moved the token without a quantity stops a later sell clearing the quote", () => {
    // The reconciler books a cost for an op it recovers and writes no fill
    // columns: the replay can no longer tell whether that sell closed anything.
    const unknown: BasisFill = { side: null, qtyRaw: null, source: "receipt" };
    assert.equal(costFromQuote([buy(10, "quote"), unknown, sell(10), buy(7)], true), true);
  });

  it("a truncated read clears nothing it cannot see the start of", () => {
    assert.equal(costFromQuote([buy(10, "quote"), sell(10), buy(7)], false), true);
  });

  it("and vouches for nothing it did not read: no quote in a truncated read is not no quote", () => {
    // This said `false` — "a quote it never read is not invented" — and that
    // was the bug. The quote-booked fill can sit in exactly the rows the read
    // cut off, and false is the one answer the desk prints a % on.
    assert.equal(costFromQuote([buy(7)], false), null);
    assert.equal(costFromQuote([], false), null);
    assert.equal(costFromQuote([buy(10), sell(10), buy(7)], false), null, "a sell that looks flat cannot be told flat without the start");
  });
});

async function ledger(withTrades = true) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await db.exec(`CREATE TABLE positions(agent_id TEXT, symbol TEXT, token TEXT, raw_balance TEXT, ui_multiplier TEXT,
      price_usd REAL, price_stale INTEGER, price_source TEXT, value_usdg REAL, updated_at INTEGER);
    CREATE TABLE cost_basis(agent_id TEXT, mode TEXT, symbol TEXT, qty_raw TEXT, cost_usdg TEXT, updated_at INTEGER);
    CREATE TABLE position_floors(agent_id TEXT, mode TEXT, symbol TEXT, stop_bps INTEGER, rung TEXT, why TEXT, at INTEGER);
    INSERT INTO positions VALUES
      ('0xA','CASHCAT','0xCASHCAT','10','1',1.2,0,'pool',12,0),
      ('0xA','CHUMP','0xChump','7','1',1,0,'pool',7,0),
      ('0xA','REOPEN','0xreopen','7','1',1,0,'pool',8,0),
      ('0xA','NOBASIS','0xnobasis','1','1',1,0,'pool',3,0);
    INSERT INTO cost_basis VALUES
      ('0xA','live','CASHCAT','10','10000000',0),
      ('0xA','live','CHUMP','7','5000000',0),
      ('0xA','live','REOPEN','7','4000000',0),
      ('0xA','paper','CASHCAT','10','99000000',0);`);
  if (withTrades) {
    await db.exec(`CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, status TEXT,
        buy_token TEXT, sell_token TEXT, user_op_hash TEXT, decision_id TEXT, fill_side TEXT, fill_qty_raw TEXT,
        basis_source TEXT, created_at INTEGER);
      INSERT INTO trades (agent_id, kind, status, buy_token, sell_token, user_op_hash, fill_side, fill_qty_raw, basis_source, created_at) VALUES
        ('0xA','swap','landed','0xcashcat','0xUSDG','0xOP1','buy','10','quote',100),
        ('0xA','swap','landed','0xcashcat','0xUSDG','0xop1',NULL,NULL,NULL,900),
        ('0xA','swap','landed','0xCHUMP','0xUSDG','0xOP2','buy','7','receipt',110),
        ('0xA','swap','landed','0xreopen','0xUSDG','0xOP3','buy','10','quote',120),
        ('0xA','swap','landed','0xUSDG','0xreopen','0xOP4','sell','10','receipt',130),
        ('0xA','swap','landed','0xreopen','0xUSDG','0xOP5','buy','7','receipt',140),
        ('0xA','swap','paper','0xchump','0xUSDG',NULL,'buy','7','quote',150),
        ('0xB','swap','landed','0xchump','0xUSDG','0xOP6','buy','7','quote',160);`);
  }
  return { raw, db };
}

describe("the owner's positions, as /api/feed reads them", () => {
  it("say, per holding, whether a quote-booked fill may be in its cost", async () => {
    const { raw, db } = await ledger();
    try {
      const rows = await readDeskPositions(db, "0xA", "live");
      const by = new Map(rows.map((r) => [r.symbol, r]));
      assert.equal(by.get("CASHCAT")!.cost_usdg, 10, "micro-USDG converted at the boundary");
      assert.equal(by.get("CASHCAT")!.cost_from_quote, true, "its only fill was booked from the quote — the re-recorded copy is not a second one");
      assert.equal(by.get("CHUMP")!.cost_from_quote, false, "a paper fill and another agent's quote fill are not this book's");
      assert.equal(by.get("REOPEN")!.cost_from_quote, false, "the quote-booked position closed before this one opened");
      assert.equal(by.get("NOBASIS")!.cost_usdg, null);
      assert.equal(by.get("NOBASIS")!.cost_from_quote, null, "no cost, nothing to vouch for");
      assert.ok(!("token" in by.get("CASHCAT")!), "the address is read to replay the fills, not sent");
    } finally {
      raw.close();
    }
  });

  it("an unreadable fill history vouches for nothing, and the positions still arrive", async () => {
    const { raw, db } = await ledger(false);
    try {
      const rows = await readDeskPositions(db, "0xA", "live");
      assert.equal(rows.length, 4);
      assert.ok(rows.every((r) => r.cost_from_quote === null));
    } finally {
      raw.close();
    }
  });

  it("the desk withholds the % it cannot vouch for, and still prints the value", async () => {
    const { raw, db } = await ledger();
    try {
      const positions = await readDeskPositions(db, "0xA", "live");
      const mine = mineOf({ agent: { name: "Shogun", strategy: "trencher", slug: null }, positions }, [])!;
      const desk = new Map(positionsOf(mine as never).map((p) => [p.symbol, p]));
      assert.equal(desk.get("CASHCAT")!.pnl, null, "a return computed from a quote is not printed as a fact");
      assert.equal(desk.get("CASHCAT")!.detail, "$12.00 · cost unconfirmed");
      assert.ok(desk.get("CHUMP")!.pnl !== null && Math.abs(desk.get("CHUMP")!.pnl! - 40) < 1e-9, "7 on a receipt cost of 5 is +40%");
      assert.equal(desk.get("CHUMP")!.detail, "$7.00");
      const chat = new Map(chatPositionsOf(mine as never).map((p) => [p.symbol, p]));
      assert.equal(chat.get("CASHCAT")!.unrealisedPct, null, "nor handed to the model to state");
      assert.equal(chat.get("CASHCAT")!.costConfirmed, false);
      assert.equal(chat.get("CASHCAT")!.costUsd, 10, "the ledger's figure still travels, marked");
      assert.equal(chat.get("CHUMP")!.unrealisedPct, 40);
      assert.equal(chat.get("CHUMP")!.costConfirmed, true);
      assert.equal(chat.get("NOBASIS")!.costConfirmed, null);
    } finally {
      raw.close();
    }
  });

  it("a fill history too long to replay is not vouched for, and the desk and chat say so", async () => {
    // The oldest fill was booked from the quote and the holding never went
    // flat after it; then PROVENANCE_ROWS receipt round trips pushed it out of
    // the read. The read sees only receipts. It used to answer "no quote" and
    // the desk printed +20% on a cost that is an estimate.
    const { raw, db } = await ledger();
    try {
      const ins = raw.prepare(
        `INSERT INTO trades (agent_id, kind, status, buy_token, sell_token, user_op_hash, fill_side, fill_qty_raw, basis_source, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      raw.exec(`INSERT INTO positions VALUES ('0xA','TSLA','0xtsla','1000','1',1.2,0,'pool',1200,0);
        INSERT INTO cost_basis VALUES ('0xA','live','TSLA','1000','1000000000',0);`);
      raw.exec("BEGIN");
      ins.run("0xA", "swap", "landed", "0xtsla", "0xusdg", "0xq0", "buy", "1000", "quote", 1);
      for (let i = 0; i < PROVENANCE_ROWS; i++) {
        const side = i % 2 === 0 ? "buy" : "sell";
        ins.run("0xA", "swap", "landed", side === "buy" ? "0xtsla" : "0xusdg", side === "buy" ? "0xusdg" : "0xtsla", `0xr${i}`, side, "1", "receipt", 1000 + i);
      }
      raw.exec("COMMIT");
      const positions = await readDeskPositions(db, "0xA", "live");
      const tsla = positions.find((p) => p.symbol === "TSLA")!;
      assert.equal(tsla.cost_usdg, 1000);
      assert.equal(tsla.cost_from_quote, null, "the quote fill is in the rows the read cut off");
      const mine = mineOf({ agent: { name: "Shogun", strategy: "steady-basket", slug: null }, positions }, [])!;
      const desk = positionsOf(mine as never).find((p) => p.symbol === "TSLA")!;
      assert.equal(desk.pnl, null, "no % on a cost nobody could vouch for");
      assert.equal(desk.detail, "$1,200.00 · cost unconfirmed");
      const chat = chatPositionsOf(mine as never).find((p) => p.symbol === "TSLA")!;
      assert.equal(chat.unrealisedPct, null);
      assert.equal(chat.costConfirmed, false);
    } finally {
      raw.close();
    }
  });

  it("a feed from a server that does not say where the cost came from shows no %", () => {
    const mine = mineOf(
      { agent: { name: "Shogun", strategy: "trencher", slug: null }, positions: [{ symbol: "CASHCAT", value_usdg: 12, price_stale: 0, cost_usdg: 10 }] },
      [],
    )!;
    const [p] = positionsOf(mine as never);
    assert.equal(p!.pnl, null);
    assert.equal(p!.detail, "$12.00 · cost unconfirmed");
  });
});
