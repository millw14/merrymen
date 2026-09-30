/**
 * A FEED ROW IN FOMO'S SHAPE: a Buy or Sell pill, "Tried" when the wall said
 * no, "$5.00 at $3.1M MC" when the market cap at decision time was recorded —
 * and a Trades pill that shows trades, not refusals.
 *
 * The verb stayed inline and colourless ("Shogun bought CASHCAT"), so a reader
 * skimming for what moved had to read every sentence; the Trades filter kept
 * every refusal, so a stuck strategy filled it with "tried to buy" rows; and
 * nothing said how big the coin was when the agent bought it. Paper and real
 * money sat in one list with no way to see only the money.
 *
 * Built through `beatsOf`, `pillOf`, `pillBeats` and the rendered `Wire`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { IN_FLIGHT_TEXT } from "@merrymen/thesis";
import { beatsOf, emptyFor, lanesOf, pillBeats, pillOf, verbOf, type Beat, type FeedRow, type TradeBeat } from "./beat";
import type { LiveAgent } from "./live";

(globalThis as unknown as { React: typeof React }).React = React;

const NOW = 1_790_000_000;
const none = new Map<string, unknown>();
/** The publisher's two "pending" sentences (thesis-policy.ts outcomeOf). */
const SENT = IN_FLIGHT_TEXT;
const NOTHING = "no trade came of it";

let seq = 0;
const row = (over: Partial<FeedRow> = {}): FeedRow =>
  ({
    name: "Shogun",
    slug: "shogun",
    handle: null,
    action: "buy",
    symbol: "CASHCAT",
    sizeUsdg: 5,
    reason: "Curve filling.",
    paper: false,
    head: "buy CASHCAT 5.00 USDG",
    outcome: "landed",
    outcomeText: "filled",
    said: 1,
    at: NOW - seq++,
    firstAt: NOW,
    unchangedSince: NOW,
    postId: null,
    ...over,
  }) as FeedRow;

const agents = [
  { slug: "shogun", name: "Shogun", handle: null, owner: null, pnlBps: null, curve: [], landed: 0, last: null, glance: { id: "custom", label: "Strategy" }, thesis: "" },
  { slug: "sirsendit", name: "SirSendIt", handle: null, owner: null, pnlBps: null, curve: [], landed: 0, last: null, glance: { id: "custom", label: "Strategy" }, thesis: "" },
] as unknown as LiveAgent[];

const trade = (over: Partial<FeedRow> = {}): TradeBeat => {
  const [b] = beatsOf([row(over)], agents);
  assert.ok(b && b.kind === "trade");
  return b;
};

async function render(rows: FeedRow[]): Promise<string> {
  const { Wire } = await import("./wire");
  return renderToStaticMarkup(createElement(Wire, { lanes: lanesOf(beatsOf(rows, agents)), tokens: [] }));
}

describe("the pill says what kind of trade, and whether money moved", () => {
  it("a landed buy is a green Buy, a landed sell a red Sell", () => {
    assert.deepEqual(pillOf(trade()), { label: "Buy", tone: "buy", unsettled: false });
    assert.deepEqual(pillOf(trade({ action: "sell", head: "sell CASHCAT 5.00 USDG" })), { label: "Sell", tone: "sell", unsettled: false });
  });

  it("A REFUSAL IS A MUTED 'TRIED' — never the colour that means money moved", () => {
    for (const outcome of ["refused", "reverted", "dropped"] as const) {
      assert.deepEqual(pillOf(trade({ outcome })), { label: "Tried", tone: "muted", unsettled: false }, outcome);
    }
  });

  it("a shadow call keeps its conditional in the pill too", () => {
    assert.deepEqual(pillOf(trade({ shadow: true, outcome: "shadow" })), { label: "Would buy", tone: "muted", unsettled: false });
    assert.deepEqual(pillOf(trade({ action: "sell", shadow: true, outcome: "shadow" })), { label: "Would sell", tone: "muted", unsettled: false });
  });

  it("an order still in flight wears its colour with an unsettled edge", () => {
    assert.deepEqual(pillOf(trade({ outcome: "pending", outcomeText: SENT })), { label: "Buy", tone: "buy", unsettled: true });
  });

  it("A DECISION NO TRADE CAME OF IS NOT IN FLIGHT — it is muted and says so (FE7)", async () => {
    // The publisher files every buy or sell decision with no trade row and
    // no dropped rule as "pending", "no trade came of it" (thesis-policy.ts
    // outcomeOf). Only "sent, waiting on the chain" is an order on its way;
    // the other is a permanent non-event, and it wore the money colour.
    const nothing = trade({ outcome: "pending", outcomeText: NOTHING });
    assert.deepEqual(pillOf(nothing), { label: "Tried", tone: "muted", unsettled: false });
    assert.equal(verbOf(nothing), "tried to buy", "never 'is buying' about an order that was never sent");
    const html = await render([row({ outcome: "pending", outcomeText: NOTHING })]);
    assert.ok(!html.includes("wire-pill buy"));
    assert.match(html, /no trade came of it/);
    assert.match(html, /class="wire-beat buy turned/, "and the row's accent is not the money colour either");
  });

  it("the row renders the pill beside the sentence, which keeps its tense", async () => {
    const html = await render([row()]);
    assert.match(html, /<span class="wire-pill buy">Buy<\/span>/);
    assert.match(html, /bought/, "the sentence still says what happened");
    const tried = await render([row({ outcome: "refused", outcomeText: "past today's spending cap" })]);
    assert.match(tried, /<span class="wire-pill muted">Tried<\/span>/);
    assert.ok(!tried.includes('wire-pill buy'));
  });
});

describe("the size, at the market cap it was bought at", () => {
  it("'$5.00 at $3.1M MC' when the decision recorded a market cap", async () => {
    const html = await render([row({ mcapUsd: 3_100_000 })]);
    assert.match(html, /<b>\$5\.00<\/b>/);
    assert.match(html, /at \$3\.1M MC/);
  });

  it("no market cap read: the size alone, never 'at $0 MC'", async () => {
    for (const mcapUsd of [undefined, null, 0, Number.NaN]) {
      const html = await render([row({ mcapUsd })]);
      assert.match(html, /<b>\$5\.00<\/b>/);
      assert.ok(!/ MC\b/.test(html), String(mcapUsd));
    }
  });
});

describe("the Trades pill shows trades", () => {
  const read = [
    row({ outcome: "landed", symbol: "A", head: "buy A 5.00 USDG" }),
    row({ outcome: "pending", outcomeText: SENT, symbol: "B", head: "buy B 5.00 USDG" }),
    row({ outcome: "pending", outcomeText: NOTHING, symbol: "H", head: "buy H 5.00 USDG" }),
    row({ outcome: "refused", symbol: "C", head: "buy C 5.00 USDG", outcomeText: "past today's spending cap" }),
    row({ outcome: "reverted", symbol: "D", head: "buy D 5.00 USDG" }),
    row({ outcome: "dropped", symbol: "E", head: "buy E 5.00 USDG" }),
    row({ outcome: "shadow", shadow: true, symbol: "F", head: "would buy F 5.00 USDG" }),
    row({ outcome: undefined, symbol: "G", head: "buy G 5.00 USDG" }),
  ];

  it("LANDED AND IN FLIGHT ONLY — a refusal is not a trade, and neither is a decision nothing was sent for", () => {
    const shown = pillBeats(beatsOf(read, agents), "trades", none, {});
    assert.deepEqual(shown.map((b) => (b as TradeBeat).symbol).sort(), ["A", "B"]);
  });

  it("and All still says what the wall turned back", () => {
    const all = pillBeats(beatsOf(read, agents), "all", none, {});
    assert.ok(all.some((b) => b.kind === "trade" && b.outcome === "refused"), "refusals are demoted from Trades, not hidden");
  });
});

describe("Real money hides paper", () => {
  const read = [
    row({ symbol: "REAL", head: "buy REAL 5.00 USDG" }),
    row({ symbol: "PRETEND", head: "buy PRETEND 5.00 USDG", paper: true }),
    row({ action: "hold", outcome: "view", symbol: "HOLD", head: "hold HOLD", paper: true, sizeUsdg: null }),
  ];
  const symbols = (bs: Beat[]) => bs.map((b) => (b.kind === "trade" || b.kind === "view" ? b.symbol : b.kind)).sort();

  it("off by default: everything read is shown, paper labelled", () => {
    assert.deepEqual(symbols(pillBeats(beatsOf(read, agents), "all", none, {})), ["HOLD", "PRETEND", "REAL"]);
  });

  it("on: nothing on a paper book, in any pill", () => {
    const beats = beatsOf(read, agents);
    assert.deepEqual(symbols(pillBeats(beats, "all", none, {}, { realOnly: true })), ["REAL"]);
    assert.deepEqual(symbols(pillBeats(beats, "trades", none, {}, { realOnly: true })), ["REAL"]);
    assert.deepEqual(symbols(pillBeats(beats, "holds", none, {}, { realOnly: true })), []);
  });

  it("A CROWD IS COUNTED FROM REAL ROWS ONLY — a paper member does not make a chorus", () => {
    const hold = (slug: string, paper: boolean) =>
      row({ slug, name: slug, action: "hold", outcome: "view", symbol: "TSLA", head: "hold TSLA", sizeUsdg: null, reason: "Range-bound.", paper });
    const beats = beatsOf([hold("shogun", false), hold("sirsendit", true)], agents);
    assert.equal(pillBeats(beats, "holds", none, {})[0]!.kind, "chorus", "two agents, one hold");
    const real = pillBeats(beats, "holds", none, {}, { realOnly: true });
    assert.deepEqual(real.map((b) => b.kind), ["view"], "one real agent is a post, not a crowd");
  });

  it("an empty real-money feed says so, rather than 'Quiet.'", () => {
    assert.equal(emptyFor("all", false, true), "No real-money posts in this window.");
    assert.equal(emptyFor("trades", false, true), "No real-money trades in this window.");
    assert.equal(emptyFor("trades", false, false), "No trades in this window.");
    assert.equal(emptyFor("all", false, false), "Quiet.");
  });
});
