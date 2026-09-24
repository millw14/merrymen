/**
 * The coin's name, stored with the fill (store.ts fillSymbolOfRow → token-label
 * fillSymbolFor), on a real sqlite ledger.
 *
 * What these protect: every fill is written with a name an owner can read,
 * taken from the most trustworthy source there is; a launchpad coin can never
 * be stored under a stock's or the cash token's ticker (the dashboard shows the
 * column with no guard of its own); a resolution that knows no name keeps the
 * one its placeholder had; and a name that cannot be read costs only the name.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-fillsym-"));
process.env.MERRYMEN_HOME = HOME;
delete process.env.DATABASE_URL;

const S = await import("./store");
const { fillSymbolFor } = await import("./token-label");
const { CASH, STOCK_TOKENS } = await import("../../packages/core/src/index");
const { DatabaseSync } = await import("node:sqlite");

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const USDG = CASH.USDG;
const COIN = "0x1111111111111111111111111111111111111111";
const CLASS = "0x2222222222222222222222222222222222222222";
const FAKE = "0x3333333333333333333333333333333333333333";
const STOCK = STOCK_TOKENS[0]!;
const op = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const file = () => new DatabaseSync(path.join(HOME, "merrymen.db"));

function row(hash: string): Record<string, unknown> {
  const db = file();
  try {
    return db.prepare("SELECT status, fill_symbol FROM trades WHERE user_op_hash = ?").get(hash) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

const decision = (id: string, agent: string, symbol: string | null, display_name: string | null) =>
  S.addDecision({ id, agent_id: agent, source: "test", symbol, action: "buy", size_usdg: 5, display_name } as never);

before(async () => {
  await S.initStore();
});

after(() => {
  S.closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("fillSymbolFor", () => {
  it("a curated address answers with its own ticker, whatever the candidates say", () => {
    assert.equal(fillSymbolFor(STOCK.address, ["WRONG"]), STOCK.symbol);
  });
  it("skips what is not a name: a Trencher id, an address, a shortened address, spaces, too long", () => {
    assert.equal(fillSymbolFor(COIN, ["T11111111111", "0xabc", "0x1111…1111", "two words", "X".repeat(33), "CASHCAT"]), "CASHCAT");
    assert.equal(fillSymbolFor(COIN, ["T11111111111", "0x1111…1111"]), null);
  });
  it("never stores a coin under a trusted ticker it does not own", () => {
    for (const fake of [STOCK.symbol, "$USDG", "usdg.", "ETH", "WETH"]) {
      assert.equal(fillSymbolFor(FAKE, [fake]), null, fake);
    }
    assert.equal(fillSymbolFor(FAKE, [STOCK.symbol, "REALNAME"]), "REALNAME", "the next candidate is used");
    const custom = [{ address: "0x4444444444444444444444444444444444444444", symbol: "MINE" }] as never;
    assert.equal(fillSymbolFor(FAKE, ["MINE"], custom), null, "an owner-added ticker is guarded too");
  });
  it("the cash legs and non-addresses have no fill name", () => {
    assert.equal(fillSymbolFor(USDG, ["X"]), null);
    assert.equal(fillSymbolFor(CASH.WETH, ["X"]), null);
    assert.equal(fillSymbolFor("NVDA", ["X"]), null);
  });
});

describe("addTrade stores the coin's name with the fill", () => {
  it("a Trencher buy is named from its decision's display name, not its T-id", async () => {
    await decision("d-trench", A, "T11111111111", "CASHCAT");
    assert.equal(await S.addTrade({ agent_id: A, kind: "swap", target: "0xrouter", sell_token: USDG, buy_token: COIN, amount_usdg: 5, user_op_hash: op(1), status: "landed", decision_id: "d-trench", fill_side: "buy" }), true);
    assert.equal(row(op(1)).fill_symbol, "CASHCAT");
  });

  it("a stock is named by its address even when the decision says otherwise", async () => {
    await decision("d-stock", A, "WRONG", null);
    await S.addTrade({ agent_id: A, kind: "swap", target: "0xrouter", sell_token: STOCK.address, buy_token: USDG, amount_usdg: 5, user_op_hash: op(2), status: "landed", decision_id: "d-stock", fill_side: "sell" });
    assert.equal(row(op(2)).fill_symbol, STOCK.symbol);
  });

  it("a coin calling itself a stock's ticker is stored nameless", async () => {
    await decision("d-fake", A, STOCK.symbol, null);
    await S.addTrade({ agent_id: A, kind: "curve-trade", target: "0xvault", sell_token: USDG, buy_token: FAKE, amount_usdg: 5, user_op_hash: op(3), status: "landed", decision_id: "d-fake", fill_side: "buy" });
    assert.equal(row(op(3)).fill_symbol, null);
  });

  it("a launchpad exit is named from what discovery read off the coin", async () => {
    const db = file();
    db.prepare("INSERT INTO discovered_pools (address, symbol) VALUES (?, ?)").run(CLASS, "PONSY");
    db.close();
    await decision("d-exit", A, "0x2222…2222", null);
    await S.addTrade({ agent_id: A, kind: "curve-trade", target: "0xvault", sell_token: CLASS, buy_token: USDG, amount_usdg: 5, user_op_hash: op(4), status: "landed", decision_id: "d-exit", fill_side: "sell" });
    assert.equal(row(op(4)).fill_symbol, "PONSY");
  });

  it("a resolution that knows no name keeps the one its placeholder was written with", async () => {
    await S.addTrade({ agent_id: A, kind: "swap", target: "0xrouter", sell_token: USDG, buy_token: COIN, amount_usdg: 5, user_op_hash: op(5), status: "submitted", decision_id: "d-trench" });
    assert.equal(row(op(5)).fill_symbol, "CASHCAT");
    // A stranded op resolved from its receipt: no legs, no decision.
    await S.addTrade({ agent_id: A, kind: "swap", target: "0xrouter", amount_usdg: 5, user_op_hash: op(5), tx_hash: "0xtx", status: "landed", basis_source: "receipt" });
    assert.deepEqual({ ...row(op(5)) }, { status: "landed", fill_symbol: "CASHCAT" });
  });

  it("a refusal is not a fill, and another agent's decision is never read", async () => {
    await S.addTrade({ agent_id: A, kind: "swap", target: "0xrouter", sell_token: USDG, buy_token: COIN, amount_usdg: 5, user_op_hash: op(6), status: "rejected", reject_rule: "x", decision_id: "d-trench" });
    assert.equal(row(op(6)).fill_symbol, null);
    await S.addTrade({ agent_id: B, kind: "swap", target: "0xrouter", sell_token: USDG, buy_token: COIN, amount_usdg: 5, user_op_hash: op(7), status: "landed", decision_id: "d-trench" });
    assert.equal(row(op(7)).fill_symbol, null);
  });

  it("an explicit name is kept as given", async () => {
    await S.addTrade({ agent_id: A, kind: "swap", target: "0xrouter", sell_token: USDG, buy_token: COIN, amount_usdg: 5, user_op_hash: op(8), status: "paper", fill_side: "buy", fill_symbol: "GIVEN" });
    assert.equal(row(op(8)).fill_symbol, "GIVEN");
  });

  it("the audit journal's fill payload is unchanged — the name is display text, not evidence", () => {
    const db = file();
    try {
      const j = db.prepare("SELECT payload_json FROM journal WHERE kind = 'fill' ORDER BY seq DESC LIMIT 1").get() as { payload_json: string };
      assert.ok(!Object.keys(JSON.parse(j.payload_json)).some((k) => /symbol/i.test(k)));
    } finally {
      db.close();
    }
  });
});
