/**
 * End-to-end proof of the attribution substrate against a REAL sqlite db (a
 * throwaway MERRYMEN_HOME): a decision is written, a trade links to it via
 * decision_id, and /why joins them exactly — no time-window guessing.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(), so the whole test
 * operates on an isolated temp database. node's --test runs each file in its own
 * process, so this env override never leaks into other suites.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-dec-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, addDecision, addTrade, newDecisionId, getBasis, setBasis, getRealizedPnlUsdg } =
  await import("./store");
const { readWhyEvidence, readPnl } = await import("./telegram/reads");
const { applyFill } = await import("./basis");

const AGENT = "0x000000000000000000000000000000000000a9e7";

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("decisions substrate — /why joins the trade to its own decision", () => {
  it("a strategist trade resolves to the exact reasoning that produced it", async () => {
    initStore();
    const id = newDecisionId();
    await addDecision({
      id,
      agent_id: AGENT,
      source: "strategist",
      strategy: "llm-strategist(groq)",
      provider: "groq",
      model: "llama-3.3-70b",
      symbol: "AAPL",
      action: "buy",
      size_usdg: 25,
      reason: "gap-down into a strong open — buying the dip before Monday",
      signals_json: '{"cashUsdg":1000}',
    });
    await addTrade({
      agent_id: AGENT,
      kind: "swap",
      target: "0x0000000000000000000000000000000000000001",
      amount_usdg: 25,
      status: "landed",
      tx_hash: "0xdeadbeef",
      decision_id: id,
    });

    const why = readWhyEvidence();
    assert.equal(why.hasTrade, true);
    assert.match(why.text, /buy AAPL/); // decision head
    assert.match(why.text, /gap-down into a strong open/); // the model's own reason
    assert.match(why.text, /via strategist/); // source label
    // The legacy "approx" time-window path must NOT be used for a linked trade.
    assert.doesNotMatch(why.text, /approx/);
  });

  it("a full round trip persists basis and books realized P&L to the ledger", async () => {
    initStore();
    const SHARE = 10n ** 18n;
    const usdg6 = (v: number) => BigInt(Math.round(v * 1e6));
    const SYM = "TSLA";

    // BUY 2 shares for 200 USDG → basis persists, no realized P&L booked.
    const buy = applyFill(await getBasis(AGENT, "paper", SYM), { side: "buy", qtyRaw: 2n * SHARE, cashUsdg: usdg6(200) });
    await setBasis(AGENT, "paper", SYM, buy.basis);
    await addTrade({
      agent_id: AGENT, kind: "swap", target: "0x0000000000000000000000000000000000000002",
      amount_usdg: 200, status: "paper",
      fill_side: "buy", fill_qty_raw: (2n * SHARE).toString(), fill_price_usd: 100, basis_source: "paper",
    });
    const afterBuy = await getBasis(AGENT, "paper", SYM);
    assert.equal(afterBuy.qtyRaw, 2n * SHARE, "basis survives the round trip through sqlite");
    assert.equal(afterBuy.costUsdg, usdg6(200));
    assert.equal(await getRealizedPnlUsdg(AGENT, "paper"), 0, "a buy books no realized P&L");

    // SELL 1 share for 150 USDG → +50 realized against the 100 average cost.
    const sell = applyFill(afterBuy, { side: "sell", qtyRaw: SHARE, cashUsdg: usdg6(150) });
    await setBasis(AGENT, "paper", SYM, sell.basis);
    assert.equal(sell.realizedUsdg, usdg6(50));
    await addTrade({
      agent_id: AGENT, kind: "swap", target: "0x0000000000000000000000000000000000000002",
      amount_usdg: 150, status: "paper",
      fill_side: "sell", fill_qty_raw: SHARE.toString(), fill_price_usd: 150,
      realized_pnl_usdg: 50, basis_source: "paper",
    });

    const afterSell = await getBasis(AGENT, "paper", SYM);
    assert.equal(afterSell.qtyRaw, SHARE, "one share still held");
    assert.equal(afterSell.costUsdg, usdg6(100), "its half of the cost stays on the books");
    assert.equal(await getRealizedPnlUsdg(AGENT, "paper"), 50, "realized P&L is now queryable — previously impossible");

    // And it surfaces to the owner rather than hiding in the schema.
    assert.match(readPnl(), /realized/);

    // Closing the rest zeroes the basis row entirely.
    const close = applyFill(afterSell, { side: "sell", qtyRaw: SHARE, cashUsdg: usdg6(90) });
    await setBasis(AGENT, "paper", SYM, close.basis);
    assert.equal(close.realizedUsdg, usdg6(-10), "a losing close books a negative figure");
    const flat = await getBasis(AGENT, "paper", SYM);
    assert.equal(flat.qtyRaw, 0n);
    assert.equal(flat.costUsdg, 0n);
  });

  // Paper and live are different money against different assets. Sharing a basis
  // row would let a simulated fill price a real sell — or delete a real position's
  // cost outright (the paper dust reconciliation would have done exactly that).
  it("paper and live basis are separate books that cannot touch each other", async () => {
    initStore();
    const SHARE = 10n ** 18n;
    const SYM = "NVDA";

    await setBasis(AGENT, "live", SYM, { qtyRaw: 4n * SHARE, costUsdg: 400_000_000n });
    await setBasis(AGENT, "paper", SYM, { qtyRaw: 1n * SHARE, costUsdg: 50_000_000n });

    assert.equal((await getBasis(AGENT, "live", SYM)).costUsdg, 400_000_000n, "live book untouched by the paper write");
    assert.equal((await getBasis(AGENT, "paper", SYM)).costUsdg, 50_000_000n);

    // Closing the PAPER position (what the dust reconciliation does) must leave
    // the live position's cost completely intact.
    await setBasis(AGENT, "paper", SYM, { qtyRaw: 0n, costUsdg: 0n });
    assert.equal((await getBasis(AGENT, "paper", SYM)).qtyRaw, 0n, "paper closed");
    assert.equal((await getBasis(AGENT, "live", SYM)).qtyRaw, 4n * SHARE, "real position survives — was previously deleted");
    assert.equal((await getBasis(AGENT, "live", SYM)).costUsdg, 400_000_000n);
  });

  it("realized P&L never mixes paper money with live money", async () => {
    initStore();
    const A = "0x000000000000000000000000000000000000bbbb";
    await addTrade({
      agent_id: A, kind: "swap", target: "0x0000000000000000000000000000000000000003",
      amount_usdg: 100, status: "paper",
      fill_side: "sell", realized_pnl_usdg: 25, basis_source: "paper",
    });
    await addTrade({
      agent_id: A, kind: "swap", target: "0x0000000000000000000000000000000000000003",
      amount_usdg: 100, status: "landed",
      fill_side: "sell", realized_pnl_usdg: -7, basis_source: "quote",
    });
    assert.equal(await getRealizedPnlUsdg(A, "paper"), 25, "paper book stands alone");
    assert.equal(await getRealizedPnlUsdg(A, "live"), -7, "live book stands alone");
  });

  it("a sell with no basis records NO realized figure — it is excluded, not counted as profit", async () => {
    initStore();
    const A = "0x000000000000000000000000000000000000cccc";
    const SHARE = 10n ** 18n;
    // The upgrade case: a real position exists, no basis row was ever written.
    const r = applyFill(await getBasis(A, "paper", "QQQ"), { side: "sell", qtyRaw: SHARE, cashUsdg: 888_410_000n });
    assert.equal(r.basisUnknown, true);
    await addTrade({
      agent_id: A, kind: "swap", target: "0x0000000000000000000000000000000000000004",
      amount_usdg: 888.41, status: "paper",
      fill_side: "sell", basis_source: "paper",
      // bookFill leaves this undefined when basisUnknown — the whole point.
      realized_pnl_usdg: r.basisUnknown ? undefined : 888.41,
    });
    assert.equal(await getRealizedPnlUsdg(A, "paper"), 0, "an unknown-cost sale contributes nothing, rather than +$888");
  });

  it("a trade with no decision_id still explains itself (legacy fallback, no crash)", async () => {
    await addTrade({
      agent_id: AGENT,
      kind: "swap",
      target: "0x0000000000000000000000000000000000000001",
      amount_usdg: 10,
      status: "rejected",
      reject_rule: "no-route",
      // no decision_id — an old row from before this migration
    });
    const why = readWhyEvidence();
    assert.equal(why.hasTrade, true);
    assert.match(why.text, /no-route/); // still shows the trade + its outcome
  });
});
