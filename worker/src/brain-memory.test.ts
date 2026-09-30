/**
 * THE BRAIN REMEMBERS WHAT IT DID, NOT WHAT IT KEPT SAYING.
 *
 * Its memory was the agent's last six published rows. A Trencher reviews every
 * thirty seconds, so those six were its own holds from the last three minutes:
 * it was shown a template ("edge unclear, so hold") and repeated it. What an
 * agent learns from is what it actually did and how that ended, plus where it
 * last stood on each name — so memory is now the last few LANDED trades with
 * their results, and the latest view per name, one line each. NOT ITS OWN
 * HOLDS, not even the latest one per name: the first cut kept those as views,
 * and a Trencher's memory still opened with three of the template it repeats.
 *
 * Every line is still rendered from gated output only (brain-material.test.ts
 * pins that), and a result is shown only when it was read — never a 0%.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryLines } from "./brain-material";
import type { PublicThesis } from "./thesis-policy";

const NOW = 1_800_000_000;
const post = (over: Partial<PublicThesis> = {}): PublicThesis => ({
  name: "Shogun",
  slug: null,
  handle: null,
  head: "hold CASHCAT (TA151B4A9E1B)",
  action: "hold",
  symbol: "TA151B4A9E1B",
  sizeUsdg: null,
  paper: false,
  outcome: "view",
  outcomeText: "held — no trade, by choice",
  shadow: false,
  reason: "Edge unclear, so hold.",
  post: null,
  said: 1,
  at: NOW - 60,
  firstAt: NOW - 60,
  ...over,
});
const trade = (i: number, over: Partial<PublicThesis> = {}) =>
  post({
    head: `buy COIN${i} (T0000000000${i}) 5.00 USDG`,
    action: "buy",
    symbol: `T0000000000${i}`,
    sizeUsdg: 5,
    outcome: "landed",
    outcomeText: "landed",
    reason: `Entry ${i}: flow turned.`,
    at: NOW - 3600 * (i + 1),
    firstAt: NOW - 3600 * (i + 1),
    ...over,
  });

/** A Trencher's feed: a hold every thirty seconds across three coins, newest first. */
const chatter = Array.from({ length: 30 }, (_, i) =>
  post({ symbol: `TAAAAAAAAAA${i % 3}`, head: `hold TAAAAAAAAAA${i % 3}`, reason: `Review ${i}: edge unclear, so hold.`, at: NOW - 30 * i }),
);

/** A shadow agent's stated calls — views that are not holds — every thirty seconds across three coins. */
const calls = Array.from({ length: 30 }, (_, i) =>
  post({
    symbol: `TCCCCCCCCCC${i % 3}`,
    head: `would buy TCCCCCCCCCC${i % 3} 5.00 USDG`,
    action: "buy",
    sizeUsdg: 5,
    outcome: "shadow",
    outcomeText: "a stated intention — not traded",
    shadow: true,
    reason: `Call ${i}: flow is turning.`,
    at: NOW - 30 * i,
  }),
);

describe("memory is what the agent did, and where it last stood", () => {
  it("THE LANDED TRADES SURVIVE THIRTY NEWER HOLDS — and only the last three of them", () => {
    const lines = memoryLines([...chatter, trade(1), trade(2), trade(3), trade(4)], NOW);
    const trades = lines.filter((l) => /Entry \d/.test(l));
    assert.equal(trades.length, 3);
    assert.ok(trades.some((l) => l.includes("Entry 1")) && trades.some((l) => l.includes("Entry 3")));
    assert.ok(!lines.some((l) => l.includes("Entry 4")), "the fourth-newest trade is left out");
  });

  it("ITS OWN HOLDS ARE NOT MEMORY — not the stream of them, and not the latest one per name", () => {
    // Thirty reviews of three coins, all holds. The first cut kept the newest
    // hold per name as a "view", so this handed the Brain three copies of the
    // sentence it was repeating.
    assert.deepEqual(memoryLines(chatter, NOW), []);
    // A shadow agent's hold is still a hold.
    assert.deepEqual(memoryLines(chatter.map((t) => ({ ...t, outcome: "shadow" as const, shadow: true })), NOW), []);
  });

  it("MEMORY NEVER LEADS WITH A HOLD, however much newer the holds are", () => {
    const lines = memoryLines([...chatter, trade(1)], NOW);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /Entry 1/, "what it did leads");
    assert.ok(!lines.some((l) => /edge unclear, so hold/.test(l)));
  });

  it("A VIEW ABOUT THE BOOK is still remembered — a view is not a hold", () => {
    const book = post({ head: "", action: null, symbol: null, outcomeText: "a view, no trade", reason: "Staying flat until breadth returns." });
    const lines = memoryLines([...chatter, book], NOW);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /Staying flat until breadth returns/);
  });

  it("ONE LINE PER NAME for views — its latest, not its last ten repeats", () => {
    const lines = memoryLines(calls, NOW);
    const views = lines.filter((l) => l.includes("would buy TCCCCCCCCCC"));
    assert.equal(views.length, 3, "three coins, three lines");
    for (const coin of ["TCCCCCCCCCC0", "TCCCCCCCCCC1", "TCCCCCCCCCC2"]) {
      assert.equal(views.filter((l) => l.includes(coin)).length, 1, coin);
    }
    assert.ok(lines.some((l) => l.includes("Call 0:")), "the newest word on the first coin");
    assert.ok(!lines.some((l) => l.includes("Call 3:")), "not an older repeat of it");
  });

  it("A NAME CALLED TEN TIMES IN A ROW IS STILL ONE LINE, and the next names get theirs", () => {
    const again = Array.from({ length: 10 }, (_, i) =>
      post({ ...calls[0]!, symbol: "TBBBBBBBBBBB", head: "would buy TBBBBBBBBBBB 5.00 USDG", reason: `Again ${i}.`, at: NOW - 10 * i }));
    const lines = memoryLines([...again, ...calls.map((t) => ({ ...t, at: t.at - 600 }))], NOW);
    assert.equal(lines.filter((l) => l.includes("TBBBBBBBBBBB")).length, 1);
    assert.equal(lines.length, 3, "the repeated name and two other names");
  });

  it("a refused or pending trade is not remembered as a trade", () => {
    const lines = memoryLines(
      [trade(1, { outcome: "refused", outcomeText: "the drawdown breaker was tripped" }), trade(2, { outcome: "pending", outcomeText: "no trade came of it" })],
      NOW,
    );
    assert.deepEqual(lines, []);
  });

  it("A CLOSED TRADE CARRIES ITS RESULT, when the result was read", () => {
    const [line] = memoryLines([trade(1, { action: "sell", head: "sell COIN1 (T00000000001) 6.50 USDG", realizedPct: 30 })], NOW);
    assert.match(line!, /landed, \+30\.0% realized/);
    const [loss] = memoryLines([trade(1, { action: "sell", realizedPct: -12.345 })], NOW);
    assert.match(loss!, /-12\.3% realized/);
  });

  it("AND NOTHING when it was not — never a 0%", () => {
    const [line] = memoryLines([trade(1, { action: "sell", realizedPct: null })], NOW);
    assert.doesNotMatch(line!, /%/);
    const [older] = memoryLines([trade(1, { action: "sell" })], NOW);
    assert.doesNotMatch(older!, /%/, "a post from an older server has no figure either");
  });

  it("an open buy carries what it paid, so the next call can compare", () => {
    const [line] = memoryLines([trade(1, { entryPriceUsd: 0.00042 })], NOW);
    assert.match(line!, /landed at 0\.00042 USD/);
  });

  it("newest first across both, and bounded", () => {
    const lines = memoryLines([...chatter, ...calls, trade(1), trade(2), trade(3), trade(4)], NOW);
    assert.equal(lines.length, 6, "three trades and three names — and none of the holds");
    assert.match(lines[0]!, /Call 0:/, "the newest thing it said leads");
    assert.match(lines.at(-1)!, /Entry 3/, "the oldest remembered trade ends it");
  });
});
