/**
 * A CALL IS MEASURED FROM WHEN IT WAS MADE — and only from figures somebody read.
 *
 * The feed put the token's 24h change beside a trade, and a reader took the
 * token's day for the agent's result. The figures that answer the real
 * question were in the ledger all along — the fill price a buy paid, the P&L a
 * sell booked — and a view had no mark at all. These pin the half of that the
 * publication gate owns: which of those figures a post may carry, and when it
 * must carry NOTHING rather than a number (never a 0 standing in for unread).
 *
 * The inputs are what the reader's SQL hands over — already folded per group,
 * and already null when any copy in the group was not evidenced — so every
 * case here is a row, and the gate's job is the arithmetic and the rules.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publishableThesis, type ThesisRow } from "./thesis-policy";

const row = (over: Partial<ThesisRow> = {}): ThesisRow => ({
  agent_id: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
  name: "Shogun",
  source: "brain",
  action: "buy",
  symbol: "T3139F043B88",
  size_usdg: 5,
  reason: "Flow flipped to net buying on rising volume; a small entry.",
  status: "landed",
  said: 1,
  last_at: 1_800_000_000,
  first_at: 1_800_000_000,
  mode: "live",
  ...over,
});

describe("a buy carries what it paid", () => {
  it("a landed buy publishes its entry price", () => {
    assert.equal(publishableThesis(row({ entry_price_usd: 0.00042 }))!.entryPriceUsd, 0.00042);
  });

  it("a paper fill is a fill — labelled paper, and still measured", () => {
    const post = publishableThesis(row({ status: "paper", mode: "paper", entry_price_usd: 3.1 }))!;
    assert.equal(post.entryPriceUsd, 3.1);
    assert.equal(post.paper, true);
  });

  it("NOTHING when the price was not read — never a zero", () => {
    assert.equal(publishableThesis(row())!.entryPriceUsd, null);
    assert.equal(publishableThesis(row({ entry_price_usd: 0 }))!.entryPriceUsd, null);
    assert.equal(publishableThesis(row({ entry_price_usd: -1 }))!.entryPriceUsd, null);
    assert.equal(publishableThesis(row({ entry_price_usd: Number.NaN }))!.entryPriceUsd, null);
  });

  it("NOTHING on a buy that did not fill — a refusal paid no price", () => {
    const post = publishableThesis(row({ status: "rejected", reject_rule: "slippage", entry_price_usd: 3.1 }))!;
    assert.equal(post.outcome, "refused");
    assert.equal(post.entryPriceUsd, null);
  });

  it("and a sell has no entry — its figure is what it booked", () => {
    assert.equal(publishableThesis(row({ action: "sell", entry_price_usd: 3.1 }))!.entryPriceUsd, null);
  });

  it("READS POSTGRES'S STRINGS AS NUMBERS, not as unread", () => {
    // node-postgres hands some aggregates back as strings; "3.1" is a read.
    assert.equal(publishableThesis(row({ entry_price_usd: "3.1" as unknown as number }))!.entryPriceUsd, 3.1);
  });
});

describe("a sell carries what it made", () => {
  const sell = (over: Partial<ThesisRow> = {}) =>
    row({ action: "sell", realized_pnl_usdg: 1, closed_cash_usdg: 5, ...over });

  it("realized percent is the P&L over the cost it closed", () => {
    // Received 5, booked +1, so the cost closed was 4: +25%.
    assert.equal(publishableThesis(sell())!.realizedPct, 25);
  });

  it("a loss is negative, not hidden", () => {
    // Received 3, booked -1, cost 4: -25%.
    assert.equal(publishableThesis(sell({ realized_pnl_usdg: -1, closed_cash_usdg: 3 }))!.realizedPct, -25);
  });

  it("A FLAT CLOSE IS 0% BECAUSE IT WAS READ as zero, not because nothing was read", () => {
    assert.equal(publishableThesis(sell({ realized_pnl_usdg: 0, closed_cash_usdg: 5 }))!.realizedPct, 0);
  });

  it("NOTHING when either input is unread, or the cost it closed is not positive", () => {
    assert.equal(publishableThesis(sell({ realized_pnl_usdg: null }))!.realizedPct, null);
    assert.equal(publishableThesis(sell({ closed_cash_usdg: null }))!.realizedPct, null);
    // Booked more than it received: a cost of zero or less is not a cost.
    assert.equal(publishableThesis(sell({ realized_pnl_usdg: 5, closed_cash_usdg: 5 }))!.realizedPct, null);
    assert.equal(publishableThesis(sell({ realized_pnl_usdg: 6, closed_cash_usdg: 5 }))!.realizedPct, null);
  });

  it("NOTHING on a sell that did not fill", () => {
    assert.equal(publishableThesis(sell({ status: "reverted" }))!.realizedPct, null);
  });

  it("a buy books nothing — its P&L column is not a result", () => {
    assert.equal(publishableThesis(row({ realized_pnl_usdg: 0, closed_cash_usdg: 5 }))!.realizedPct, null);
  });
});

describe("dollars are the owner's to publish", () => {
  const sell = (over: Partial<ThesisRow> = {}) =>
    row({ action: "sell", realized_pnl_usdg: 1.5, closed_cash_usdg: 6.5, ...over });

  it("PERCENTAGES ARE THE PUBLIC DEFAULT — no dollars unless the book is public", () => {
    const post = publishableThesis(sell())!;
    assert.equal(post.realizedPct, 30);
    assert.equal(post.realizedUsd, null);
    assert.equal(publishableThesis(sell({ public_book: false }))!.realizedUsd, null);
  });

  it("an owner who opted in shows the dollars", () => {
    assert.equal(publishableThesis(sell({ public_book: true }))!.realizedUsd, 1.5);
  });

  it("only an explicit true opts in — a truthy stray does not", () => {
    assert.equal(publishableThesis(sell({ public_book: "true" as unknown as boolean }))!.realizedUsd, null);
    assert.equal(publishableThesis(sell({ public_book: 1 as unknown as boolean }))!.realizedUsd, null);
  });

  it("and never a dollar figure the percent could not be computed from", () => {
    assert.equal(publishableThesis(sell({ public_book: true, closed_cash_usdg: null }))!.realizedUsd, null);
  });
});

describe("a view carries the price it saw, and a memecoin its size", () => {
  it("a view publishes its mark", () => {
    const post = publishableThesis(row({ action: "hold", status: null, mark_usd: 412.5 }))!;
    assert.equal(post.outcome, "view");
    assert.equal(post.markUsd, 412.5);
  });

  it("NOTHING when the mark was unread or not a price", () => {
    for (const mark_usd of [null, undefined, 0, -3, Number.POSITIVE_INFINITY]) {
      assert.equal(publishableThesis(row({ action: "hold", status: null, mark_usd }))!.markUsd, null, String(mark_usd));
    }
  });

  it("a market cap rides the post when the tape gave one", () => {
    assert.equal(publishableThesis(row({ mcap_usd: 3_100_000 }))!.mcapUsd, 3_100_000);
    assert.equal(publishableThesis(row({ mcap_usd: null }))!.mcapUsd, null);
    assert.equal(publishableThesis(row({ mcap_usd: 0 }))!.mcapUsd, null);
  });

  it("every figure defaults to null on a row that carries none — the peer path's shape", () => {
    const post = publishableThesis(row())!;
    for (const k of ["entryPriceUsd", "realizedPct", "realizedUsd", "markUsd", "mcapUsd"] as const) {
      assert.equal(post[k], null, k);
    }
  });
});
