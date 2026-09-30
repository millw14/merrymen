/**
 * AN ORDER'S RECEIPT IS FACTS, OR IT IS NOTHING.
 *
 * The chat renders "[Buy] $5.00 CASHCAT · Filled" from this and from nothing
 * else, so every figure in it has to be one the ledger actually holds. These
 * hold the three places that goes wrong in practice: a quote dressed as a fill,
 * a state the contract has no word for squeezed into one it does, and a label
 * printed for an argument the worker refused.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { expiredOrderReceipt, ledgerFactsOf, orderReceipt, orderSubject, type LedgerFacts } from "./order-receipt";

const CASHCAT = "0x00000000000000000000000000000000000ca7ca";
const USDG = "0x0000000000000000000000000000000000005d6c";
const TX = "0x" + "ab".repeat(32);
const buy = { side: "buy" as const, symbol: "CASHCAT" };
const sell = { side: "sell" as const, symbol: "CASHCAT" };
const ledger = (facts: LedgerFacts) => ({ kind: "ledger" as const, facts });

describe("a landed order is a fill, and says only what the ledger knows", () => {
  it("A BUY READ OFF THE CHAIN reports the cash that moved, the coin it bought and the hash", () => {
    const r = orderReceipt(
      buy,
      ledger({ status: "landed", txHash: TX, sellToken: USDG, buyToken: CASHCAT, amountUsdg: 5, fillCashUsdg: 4.98, basisSource: "receipt" }),
    );
    assert.deepEqual(r, {
      status: "filled",
      side: "buy",
      symbol: "CASHCAT",
      token: CASHCAT,
      usdgActual: 4.98,
      txHash: TX,
      rejectRule: null,
    });
  });

  it("a buy booked from the QUOTE still knows what it spent: its own exact input", () => {
    const r = orderReceipt(
      buy,
      ledger({ status: "landed", txHash: TX, sellToken: USDG, buyToken: CASHCAT, amountUsdg: 5, fillCashUsdg: 5, basisSource: "quote" }),
    );
    assert.equal(r?.usdgActual, 5);
  });

  it("A SELL BOOKED FROM THE QUOTE HAS NO FIGURE — what came back is an estimate until the receipt is read", () => {
    const r = orderReceipt(
      sell,
      ledger({ status: "landed", txHash: TX, sellToken: CASHCAT, buyToken: USDG, amountUsdg: 12, fillCashUsdg: 11.7, basisSource: "quote" }),
    );
    assert.equal(r?.status, "filled");
    assert.equal(r?.usdgActual, null, "a quoted return is never printed as money received");
    assert.equal(r?.token, CASHCAT, "a sell is about the coin it sold");
  });

  it("and a sell read off the chain carries what it actually received", () => {
    const r = orderReceipt(
      sell,
      ledger({ status: "landed", txHash: TX, sellToken: CASHCAT, buyToken: USDG, amountUsdg: 12, fillCashUsdg: 11.7, basisSource: "receipt" }),
    );
    assert.equal(r?.usdgActual, 11.7);
  });

  it("a landed row with no hash says null, never an empty string", () => {
    assert.equal(orderReceipt(buy, ledger({ status: "landed", amountUsdg: 5 }))?.txHash, null);
  });
});

describe("the wall said no, the chain said no, or nothing came back", () => {
  it("A WALL REFUSAL IS `refused` WITH THE RULE THE ROW CARRIES, and nothing moved", () => {
    const r = orderReceipt(buy, ledger({ status: "rejected", rejectRule: "per-trade-cap", sellToken: USDG, buyToken: CASHCAT, amountUsdg: 5 }));
    assert.deepEqual(r, {
      status: "refused",
      side: "buy",
      symbol: "CASHCAT",
      token: CASHCAT,
      usdgActual: null,
      txHash: null,
      rejectRule: "per-trade-cap",
    });
  });

  it("A REVERT IS `failed`, with the hash to look it up and no USDG figure — only the gas moved", () => {
    const r = orderReceipt(sell, ledger({ status: "reverted", txHash: TX, rejectRule: "TooLittleReceived", sellToken: CASHCAT, buyToken: USDG, amountUsdg: 12, fillCashUsdg: 12, basisSource: "receipt" }));
    assert.equal(r?.status, "failed");
    assert.equal(r?.txHash, TX);
    assert.equal(r?.usdgActual, null);
    assert.equal(r?.rejectRule, "TooLittleReceived");
  });

  it("a reject rule is bounded, because a revert reason is chain text", () => {
    const r = orderReceipt(buy, ledger({ status: "rejected", rejectRule: "x".repeat(900) }));
    assert.equal(r?.rejectRule?.length, 120);
  });

  it("HANDED TO THE PIPELINE AND NO ROW CAME BACK is `failed`, not a refusal and not a fill", () => {
    assert.equal(orderReceipt(buy, { kind: "no-row" })?.status, "failed");
  });

  it("A WORKER-SIDE NO (paused, over the ceiling, unreadable market) is `refused` with no rule of the wall's", () => {
    const r = orderReceipt(buy, undefined);
    assert.deepEqual(r, { status: "refused", side: "buy", symbol: "CASHCAT", token: null, usdgActual: null, txHash: null, rejectRule: null });
  });

  it("REACHED AFTER ITS WINDOW is `expired`, with every ledger field empty", () => {
    const r = orderReceipt(buy, { kind: "late" });
    assert.deepEqual(r, { status: "expired", side: "buy", symbol: "CASHCAT", token: null, usdgActual: null, txHash: null, rejectRule: null });
  });
});

describe("the states the contract has no honest word for", () => {
  it("IN FLIGHT HAS NO RECEIPT — `filled` would announce a fill the ledger has not seen", () => {
    assert.equal(orderReceipt(buy, ledger({ status: "submitted", rejectRule: "receipt-unresolved", txHash: TX })), undefined);
  });

  it("A PAPER FILL HAS NO RECEIPT — a practice trade must not read as money", () => {
    assert.equal(orderReceipt(buy, ledger({ status: "paper", amountUsdg: 5, fillCashUsdg: 5, basisSource: "paper" })), undefined);
  });
});

describe("labels, never a second gate", () => {
  it("A VALID SIDE AND SYMBOL ARE PRINTED the way the worker normalises them", () => {
    assert.deepEqual(orderSubject({ side: "sell", symbol: " cashcat " }), { side: "sell", symbol: "CASHCAT" });
  });

  it("AND AN ARGUMENT THE WORKER WOULD REFUSE IS NEVER PRINTED", () => {
    assert.deepEqual(orderSubject({ side: "yolo", symbol: "../../etc" }), { side: null, symbol: null });
    assert.deepEqual(orderSubject({ side: "buy", symbol: "WAYTOOLONGSYMBOL" }), { side: "buy", symbol: null });
    assert.deepEqual(orderSubject(undefined), { side: null, symbol: null });
  });

  it("an expired order's receipt is built from its own arguments", () => {
    assert.deepEqual(expiredOrderReceipt({ side: "buy", symbol: "tsla", usdgAmount: 25 }), {
      status: "expired",
      side: "buy",
      symbol: "TSLA",
      token: null,
      usdgActual: null,
      txHash: null,
      rejectRule: null,
    });
  });
});

describe("the facts are lifted off the row that was written, and nothing is added", () => {
  it("A ROW'S FIELDS MAP ACROSS UNCHANGED, and an absent one stays absent", () => {
    const facts = ledgerFactsOf({
      status: "landed",
      tx_hash: TX,
      sell_token: USDG,
      buy_token: CASHCAT,
      amount_usdg: 5,
      fill_cash_usdg: 4.98,
      basis_source: "receipt",
    });
    assert.deepEqual(facts, {
      status: "landed",
      txHash: TX,
      sellToken: USDG,
      buyToken: CASHCAT,
      amountUsdg: 5,
      fillCashUsdg: 4.98,
      basisSource: "receipt",
    });
    assert.deepEqual(ledgerFactsOf({ status: "rejected", reject_rule: "ops-cap" }), { status: "rejected", rejectRule: "ops-cap" });
  });
});

describe("the energy buy's receipt", () => {
  // The get-energy card places {side:'buy', symbol:'MERRYMEN', usdgAmount: the
  // owner's MOST for this ask}; the worker spends only what the chain says is
  // missing, under every cap. The receipt must print what the ROW says moved —
  // the chunk actually bought — never the order's ceiling.
  const MERRY = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";
  const energy = orderSubject({ side: "buy", symbol: "MERRYMEN", usdgAmount: 25 });

  it("a landed energy buy is FILLED with the reserve token and the row's own amount, not the order's max", () => {
    const facts = ledgerFactsOf({ status: "landed", tx_hash: TX, sell_token: USDG, buy_token: MERRY, amount_usdg: 7.25 });
    assert.deepEqual(orderReceipt(energy, ledger(facts)), {
      status: "filled",
      side: "buy",
      symbol: "MERRYMEN",
      token: MERRY,
      usdgActual: 7.25,
      txHash: TX,
      rejectRule: null,
    });
  });

  it("refused on the live rule, it is REFUSED with the rule; in flight, there is no receipt at all", () => {
    const refused = orderReceipt(energy, ledger(ledgerFactsOf({ status: "rejected", reject_rule: "energy-needs-live", sell_token: USDG, buy_token: MERRY })));
    assert.equal(refused?.status, "refused");
    assert.equal(refused?.rejectRule, "energy-needs-live");
    assert.equal(refused?.usdgActual, null);
    assert.equal(orderReceipt(energy, ledger({ status: "submitted", rejectRule: "unsettled-after-submit" })), undefined);
  });
});
