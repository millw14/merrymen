/**
 * A PRIVATE BOOK PUBLISHES NO DOLLARS — AND A SIZE IS DOLLARS.
 *
 * Wave 2 made a sell's realized PERCENT public for every book and kept its
 * dollars behind the owner's `publicBook` opt-in. The size stayed public, in
 * `sizeUsdg` and in the head ("sell AAPL 4.00 USDG"), and a sell's size is its
 * proceeds — so the withheld P&L was `size × pct / (100 + pct)`, one line of
 * arithmetic from the same row. Measured by the review on the ledger itself:
 * a private "sell AAPL 4.00 USDG" at −20% is exactly the −1.00 USDG the gate
 * printed as `realizedUsd: null`. A buy's size over its published entry price
 * is the quantity it holds.
 *
 * The owner's rule (the forbidden list): percentages are the public default,
 * and sizes, dollar P&L and holdings are opt-in. So the gate withholds the
 * size wherever it would be printed — the field and the sentence — for every
 * outcome, and a public book keeps both.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publishableThesis, withoutBookFigures, type ThesisRow } from "./thesis-policy";
import { renderWhy, type Why } from "./strategies/reasons";

const row = (over: Partial<ThesisRow> = {}): ThesisRow => ({
  agent_id: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
  name: "SirSendIt",
  source: "brain",
  action: "sell",
  symbol: "AAPL",
  size_usdg: 4,
  reason: "Cutting AAPL: the gap filled and the bid thinned.",
  status: "landed",
  said: 1,
  last_at: 1_800_000_000,
  first_at: 1_800_000_000,
  mode: "live",
  ...over,
});

/** Every number a reader could get from the published post, as text. */
const published = (over: Partial<ThesisRow>) => JSON.stringify(publishableThesis(row(over)));

describe("a private book's post carries no size", () => {
  it("THE REVIEW'S CASE: a −20% sell cannot be turned back into −1.00 USDG", () => {
    const post = publishableThesis(row({ realized_pnl_usdg: -1, closed_cash_usdg: 4 }))!;
    assert.equal(post.realizedPct, -20, "the percent is the public default and stays");
    assert.equal(post.realizedUsd, null);
    assert.equal(post.sizeUsdg, null, "the size was the other half of the dollars");
    assert.equal(post.head, "sell AAPL");
    assert.ok(!/4\.00|USDG/.test(JSON.stringify(post)), "no size anywhere on the post");
  });

  it("a buy's size over its entry price is its holding — withheld too", () => {
    const post = publishableThesis(
      row({ action: "buy", symbol: "T3139F043B88", display_name: "JUGGERNAUT", size_usdg: 5, entry_price_usd: 0.0004 }),
    )!;
    assert.equal(post.entryPriceUsd, 0.0004, "the entry is a price, not a holding, and stays");
    assert.equal(post.sizeUsdg, null);
    assert.equal(post.head, "buy JUGGERNAUT (T3139F043B88)");
  });

  it("EVERY OUTCOME, not only a fill — a refusal, a pending order, a shadow call and a vault move all name a size", () => {
    const cases: Partial<ThesisRow>[] = [
      { action: "buy", status: "rejected", reject_rule: "slippage" },
      { action: "buy", status: "submitted" },
      { action: "buy", status: null },
      { action: "buy", status: "reverted" },
      { action: "buy", status: null, dropped_rule: "#0 AAPL: exceeds available cash" },
      { action: "buy", status: null, source: "brain-shadow" },
      { action: "vault-deposit", symbol: null, status: "landed", source: "strategy:steady-basket", reason: "parking idle cash" },
    ];
    for (const over of cases) {
      const post = publishableThesis(row(over));
      assert.ok(post, JSON.stringify(over));
      assert.equal(post.sizeUsdg, null, JSON.stringify(over));
      assert.ok(!/\d\.\d\d USDG/.test(post.head), `${post.head} — ${JSON.stringify(over)}`);
    }
    // The conditional survives losing the size: "would buy AAPL", not "buy".
    assert.equal(publishableThesis(row({ action: "buy", status: null, source: "brain-shadow" }))!.head, "would buy AAPL");
  });

  it("only an explicit true opens the book — absence, false, a string or a 1 do not", () => {
    for (const public_book of [undefined, null, false, "true", 1] as unknown as boolean[]) {
      assert.ok(!published({ public_book }).includes("4.00"), String(public_book));
      assert.equal(publishableThesis(row({ public_book }))!.sizeUsdg, null, String(public_book));
    }
  });
});

describe("a public book keeps what its owner chose to show", () => {
  it("the size, the sized head and the dollars", () => {
    const post = publishableThesis(row({ public_book: true, realized_pnl_usdg: -1, closed_cash_usdg: 4 }))!;
    assert.equal(post.sizeUsdg, 4);
    assert.equal(post.head, "sell AAPL 4.00 USDG");
    assert.equal(post.realizedPct, -20);
    assert.equal(post.realizedUsd, -1);
  });

  it("a hold still has no size, public or not — it is an answer, not a quantity", () => {
    assert.equal(publishableThesis(row({ public_book: true, action: "hold", status: null, size_usdg: 0 }))!.head, "hold AAPL");
  });
});

/**
 * AND OUR OWN SENTENCE CARRIES NONE OF THEM EITHER.
 *
 * The review's probe (CF1): with the head and `sizeUsdg` withheld, the STRATEGY
 * reason still said it — "selling all 4.40 USDG of it against the 5.00 paid" is
 * the realized P&L outright, "out of T3139F043B88 with 6.00 USDG" beside a
 * published +20% is 1.00 of it, "5.00 USDG into TSLA" beside the entry price
 * is the holding, and "5.00 USDG idle above the 50.00 floor" is the cash. New
 * rows are written without them (reasons.ts, public register); these are the
 * rows already written, replayed in the exact register that wrote them.
 */
describe("a private book's strategy reason carries no figure — the rows already written", () => {
  const strategyRow = (reason: string, over: Partial<ThesisRow> = {}) =>
    row({ source: "strategy:steady-basket", reason, action: "buy", symbol: "TSLA", size_usdg: 5, status: "landed", ...over });

  // [the old public register's sentence, the Why that wrote it]
  const LEGACY: [string, Why][] = [
    ["the schedule says buy — 4.40 USDG into NVDA, its 33% of a 3-leg basket", { code: "dca-leg", symbol: "NVDA", usdgRaw: 4_400_000n, weightBps: 3_333, legs: 3 }],
    ["4.40 USDG idle above the 61.23 floor — parking it in the vault until the next buy", { code: "park", usdgRaw: 4_400_000n, floorRaw: 61_230_000n, clamped: false }],
    ["parking 4.40 USDG of the cash idle above the 61.23 floor — what today's budget still allows", { code: "park", usdgRaw: 4_400_000n, floorRaw: 61_230_000n, clamped: true }],
    ["cash is under one tick's buy — pulling 4.40 USDG back from the vault so the next tick can trade", { code: "unpark", usdgRaw: 4_400_000n, needRaw: 5_170_000n }],
    ["nothing bought — 4.40 USDG on hand and one buy costs 5.17. There is 61.23 USDG in the vault I can pull back, so this should clear itself", { code: "under-one-buy", cashRaw: 4_400_000n, needRaw: 5_170_000n, vaultRaw: 61_230_000n }],
    ["nothing bought — 4.40 USDG on hand and one buy costs 5.17, and the vault is empty", { code: "under-one-buy", cashRaw: 4_400_000n, needRaw: 5_170_000n, vaultRaw: 0n }],
    ["nothing bought — today's buying budget is spent. That is the daily cap in your signature doing its job, not a fault: I buy 5.17 USDG a tick, so a small cap is gone quickly. Selling is never blocked by this", { code: "budget-spent", capRaw: 5_170_000n }],
    ["TSLA is up 20% on what it cost — selling all 61.23 USDG of it against the 5.17 paid, and taking the profit rather than watching it", { code: "take-profit", symbol: "TSLA", gainBps: 2_000, usdgRaw: 61_230_000n, costRaw: 5_170_000n }],
    ["TSLA is 12% below what it cost — selling all 4.40 USDG of it against the 5.17 paid. A floor, not a view: the rule fired, I did not change my mind. Its floor was graded at 8% when I bought it, not your usual level", { code: "stop-floor", symbol: "TSLA", lossBps: 1_200, usdgRaw: 4_400_000n, costRaw: 5_170_000n, floorBps: 800 }],
    ["all 3 equity feeds are shut, so putting 4.40 USDG into BTC — a coin I hold a signed permission for, on a market that does not close", { code: "stale-fallback", symbol: "BTC", usdgRaw: 4_400_000n, legs: 3 }],
    ["AAPL's feed has gone stale — its market is shut and the token keeps trading, so 61.23 USDG in at the close print", { code: "gap-enter", symbol: "AAPL", usdgRaw: 61_230_000n }],
    ["nothing invested yet — laying down an equal-weight entry, 1,234.56 USDG into each of 3", { code: "keel-seed", usdgRaw: 1_234_567_890n, legs: 3 }],
    ["nothing invested yet — laying down an equal-weight entry, 4.40 USDG into each of 3 — cut to what the signed key allows", { code: "keel-seed", usdgRaw: 4_400_000n, legs: 3, capped: true }],
    ["TSLA is 4.40 USDG over its equal weight — trimming it back toward the line", { code: "keel-trim", symbol: "TSLA", overRaw: 4_400_000n }],
    ["PLTR is 5.17 USDG under its equal weight — topping it up from cash — cut to what the signed key allows", { code: "keel-top", symbol: "PLTR", underRaw: 5_170_000n, capped: true }],
    ["NVDA is 2.4% off its rolling high, the deepest of the 4 I priced — 61.23 USDG in", { code: "dip", symbol: "NVDA", dipBps: 240, priced: 4, usdgRaw: 61_230_000n }],
    ["NVDA is 2.4% off its rolling high, the deepest of the 4 I priced — 61.23 USDG in — cut to what the signed key allows", { code: "dip", symbol: "NVDA", dipBps: 240, priced: 4, usdgRaw: 61_230_000n, capped: true }],
    ["WIF: 41,000 deep, FDV 820,000, 47m old — inside every entry bound, 4.40 USDG in", { code: "trench-enter", symbol: "WIF", liqUsd: 41_000, fdvUsd: 820_000, ageSec: 2_820, usdgRaw: 4_400_000n }],
    ["taking 4.40 USDG of T3139F043B88 — 20 different buyers have been through it, and it was the best of 3 I priced", { code: "class-enter", symbol: "T3139F043B88", usdgRaw: 4_400_000n, trades: 32, traders: 20, depthRaw: 1n, impactBps: 40, costBps: 90, graduationBps: 4_130, field: 3 }],
    ["taking 4.40 USDG of T3139F043B88 — early on the curve", { code: "class-enter", symbol: "T3139F043B88", usdgRaw: 4_400_000n, trades: null, traders: null, depthRaw: 1n, impactBps: 40, costBps: null, graduationBps: 4_130, field: 1 }],
    ["out of T3139F043B88 with 61.23 USDG — it is close enough to graduating that the vault would soon not be able to sell it at all", { code: "class-exit", symbol: "T3139F043B88", cause: "cliff", heldSec: 7_200, graduationBps: 9_100, proceedsRaw: 61_230_000n }],
    ["out of T3139F043B88 with 61.23 USDG — 6h is as long as I hold one of these", { code: "class-exit", symbol: "T3139F043B88", cause: "clock", heldSec: 21_600, graduationBps: null, proceedsRaw: 61_230_000n }],
  ];

  it("EVERY OLD SENTENCE READS BACK AS THE NEW ONE — exactly what the public register now writes", () => {
    for (const [old, w] of LEGACY) {
      assert.equal(withoutBookFigures(old), renderWhy(w, "public"), old);
    }
  });

  it("through the gate: the review's four probes publish their percent and none of their dollars", () => {
    const stop = publishableThesis(
      strategyRow(
        "TSLA is 12% below what it cost — selling all 4.40 USDG of it against the 5.00 paid. A floor, not a view: the rule fired, I did not change my mind",
        { action: "sell", realized_pnl_usdg: -0.6, closed_cash_usdg: 4.4 },
      ),
    )!;
    assert.equal(stop.reason, "TSLA is 12% below what it cost — selling all of it. A floor, not a view: the rule fired, I did not change my mind");
    const exit = publishableThesis(
      strategyRow("out of T3139F043B88 with 6.00 USDG — 6h is as long as I hold one of these", {
        source: "class-route",
        action: "sell",
        symbol: "T3139F043B88",
        realized_pnl_usdg: 1,
        closed_cash_usdg: 6,
      }),
    )!;
    assert.equal(exit.realizedPct, 20, "the percent is the public default");
    assert.equal(exit.reason, "out of T3139F043B88 — 6h is as long as I hold one of these");
    const leg = publishableThesis(strategyRow("the schedule says buy — 5.00 USDG into TSLA, its 20% of a 5-leg basket", { entry_price_usd: 250 }))!;
    assert.equal(leg.entryPriceUsd, 250);
    assert.equal(leg.reason, "the schedule says buy — cash into TSLA, its 20% of a 5-leg basket");
    const park = publishableThesis(
      strategyRow("5.00 USDG idle above the 50.00 floor — parking it in the vault until the next buy", { action: "vault-deposit", symbol: null }),
    )!;
    assert.equal(park.reason, "cash idle above the floor — parking it in the vault until the next buy");
    for (const post of [stop, exit, leg, park]) {
      assert.doesNotMatch(`${post.head} ${post.reason}`, /USDG|\d\.\d\d\b/, JSON.stringify(post));
      assert.equal(post.sizeUsdg, null);
      assert.equal(post.realizedUsd ?? null, null);
    }
  });

  it("A FIGURE NO RULE UNDERSTOOD COSTS THE SENTENCE, NOT JUST THE NUMBER — it fails closed", () => {
    // An older wording, or a template nobody listed: not redacted, dropped.
    assert.equal(withoutBookFigures("Parking 25.00 USDG idle above the 50.00 floor."), null);
    assert.equal(publishableThesis(strategyRow("Parking 25.00 USDG idle above the 50.00 floor.", { action: "vault-deposit", symbol: null })), null);
    // A rule that matched half a sentence leaves the other half's figure, and
    // that is still a figure.
    assert.equal(withoutBookFigures("TSLA is 4.40 USDG over its equal weight — and 3.00 USDG more"), null);
    // Nor is a bare amount the rule left behind: "the 50.00 floor" is the cash.
    assert.equal(withoutBookFigures("TSLA is 4.40 USDG over its equal weight — with 50.00 left above the floor"), null);
    // The agent's own post still carries a trade whose reason could not.
    const withPost = publishableThesis(strategyRow("Parking 25.00 USDG idle above the 50.00 floor.", { post: "Cash waits in the vault." }))!;
    assert.equal(withPost.reason, null);
    assert.equal(withPost.post, "Cash waits in the vault.");
  });

  it("a sentence with no figure of the book is untouched — a market's own prices included", () => {
    for (const s of [
      "AAPL's feed is live again — the market reopened, so the whole position goes back to cash",
      "TSLA +2.4% over 3h, above its mean — two fresh oracle rounds above the $342.79 high.",
    ]) {
      assert.equal(withoutBookFigures(s), s);
      assert.equal(publishableThesis(strategyRow(s, { source: "market-review", action: "hold", status: null }))!.reason, s);
    }
  });

  it("A PUBLIC BOOK keeps its sentence as it was written — its owner chose to show it", () => {
    const old =
      "TSLA is 12% below what it cost — selling all 4.40 USDG of it against the 5.00 paid. A floor, not a view: the rule fired, I did not change my mind";
    assert.equal(publishableThesis(strategyRow(old, { public_book: true, action: "sell" }))!.reason, old);
  });
});
