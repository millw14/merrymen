/**
 * /api/decision/<id> IS A PUBLIC PAGE, SO A PRIVATE BOOK'S DOLLARS STAY OFF IT.
 *
 * D1: a book that is not public publishes no dollars, and a size is dollars.
 * The feed withholds a private book's size, its realized dollars and anything
 * a holding can be read from — and every post carries the id this route
 * answers for. It spread each trade row as read, so one request away from any
 * post were the trade's amount, the cash its fill moved, the quantity it
 * filled and the P&L it booked. These run the real reader on the real schema.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import { readPublicDecisionLifecycle } from "./read-decision-lifecycle";

const NOW = Math.floor(Date.now() / 1000);
const AGENT = "0xAaAa000000000000000000000000000000000001";
const USDG = "0x05d0000000000000000000000000000000000005";
const TSLA = "0x7e5a000000000000000000000000000000007e5a";

async function lifecycle(settings: (tenant: `0x${string}`) => Promise<unknown>, reason = "Selling TSLA into strength.") {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  raw
    .prepare(
      `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, created_at, name, mode, beat_at)
       VALUES (?, '0x0000000000000000000000000000000000000abc', '0x0000000000000000000000000000000000000def', 4663, '{}', ?, ?, 'armed', ?, 'Shogun', 'live', ?)`,
    )
    .run(AGENT, NOW - 86400, NOW + 86400, NOW - 86400, NOW - 30);
  raw
    .prepare(`INSERT INTO decisions (id, agent_id, source, action, symbol, size_usdg, reason, at) VALUES ('dec_sell_fixture', ?, ?, 'sell', 'TSLA', 4, ?, ?)`)
    .run(AGENT, reason.startsWith("TSLA is") ? "strategy:steady-basket" : "brain", reason, NOW - 600);
  raw
    .prepare(
      `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, decision_id, fill_side, fill_qty_raw, fill_price_usd, fill_cash_usdg, realized_pnl_usdg, basis_source, created_at)
       VALUES (?, 'swap', '0x0', ?, ?, 4, 'landed', 'dec_sell_fixture', 'sell', '20000000000000000', 200, 4, -1, 'receipt', ?)`,
    )
    .run(AGENT, TSLA, USDG, NOW - 590);
  const identities = async () => [{ tenant: "0x1" as const, accounts: [AGENT.toLowerCase()] }];
  try {
    return await readPublicDecisionLifecycle("dec_sell_fixture", (fn) => fn(db), identities, settings);
  } finally {
    raw.close();
  }
}

describe("a decision's page follows the feed's dollar rule", () => {
  it("A PRIVATE BOOK: no amount, no fill cash, no quantity, no P&L — and no size on the decision", async () => {
    const life = (await lifecycle(async () => ({ publicBook: false })))!;
    assert.ok(life, "the decision is still published");
    const [t] = life.trades;
    assert.equal(t!.amount_usdg, null);
    assert.equal(t!.fill_cash_usdg, null);
    assert.equal(t!.fill_qty_raw, null);
    assert.equal(t!.realized_pnl_usdg, null);
    assert.equal(life.decision.size_usdg, null);
    assert.equal(t!.fill_price_usd, 200, "a price is not a holding, and the feed shows it too");
    assert.equal(t!.status, "landed");
    assert.ok(!JSON.stringify(life).includes("20000000000000000"), "the filled quantity is nowhere");
  });

  it("A PUBLIC BOOK keeps what its owner chose to show", async () => {
    const life = (await lifecycle(async (tenant) => ({ publicBook: tenant === "0x1" })))!;
    const [t] = life.trades;
    assert.equal(t!.amount_usdg, 4);
    assert.equal(t!.fill_cash_usdg, 4);
    assert.equal(t!.fill_qty_raw, "20000000000000000");
    assert.equal(t!.realized_pnl_usdg, -1);
    assert.equal(life.decision.size_usdg, 4);
  });

  it("only an explicit true opens it — a stray value, no setting, or a failed read is private", async () => {
    for (const settings of [
      async () => ({ publicBook: "true" }),
      async () => ({ publicBook: 1 }),
      async () => null,
      async () => {
        throw new Error("settings store down");
      },
    ]) {
      const life = (await lifecycle(settings))!;
      assert.equal(life.trades[0]!.realized_pnl_usdg, null);
      assert.equal(life.trades[0]!.amount_usdg, null);
    }
  });

  it("the reason goes through the same gate: a private book's old strategy sentence loses its figures", async () => {
    const life = (await lifecycle(
      async () => ({ publicBook: false }),
      "TSLA is 20% below what it cost — selling all 4.00 USDG of it against the 5.00 paid. A floor, not a view: the rule fired, I did not change my mind",
    ))!;
    assert.equal(life.decision.reason, "TSLA is 20% below what it cost — selling all of it. A floor, not a view: the rule fired, I did not change my mind");
  });
});
