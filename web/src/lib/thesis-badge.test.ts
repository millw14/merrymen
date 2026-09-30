/**
 * THE WORD ON THE CARD IS A CLAIM ABOUT WHAT AN AGENT DID.
 *
 * `badgeOf` is one line of text, which is why it is easy to treat as styling.
 * It is not styling: it is the sentence a reader believes. "bought" says money
 * moved, "buying" says money is moving, "thesis" says an opinion was formed.
 *
 * The case these tests exist for is Brain in shadow mode. Its decision arrives
 * as a buy, with a symbol and a size and NO status — which is byte-for-byte
 * what a real buy looks like before its trade lands. Every test in this
 * function was written before Brain existed, and the buy arm reads exactly that
 * shape as "buying". An agent with no path to the executor would have announced
 * that it was trading, in its own voice, on a page anybody can read.
 *
 * So `shadow` is checked FIRST, and the ordering is the property.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IN_FLIGHT_TEXT, outcomeOf } from "../../../worker/src/thesis-policy";
import { badgeOf, hasTrade, inFlightOf } from "./thesis-badge";
import type { PublicThesis } from "./thesis";

const post = (over: Partial<PublicThesis> = {}): PublicThesis => ({
  name: "Much",
  slug: null,
  handle: null,
  head: "buy TSLA 5.00 USDG",
  action: "buy",
  symbol: "TSLA",
  sizeUsdg: 5,
  paper: false,
  outcome: "pending",
  // An order in flight: the publisher's own sentence for a submitted trade.
  outcomeText: "sent, waiting on the chain",
  shadow: false,
  reason: "momentum is intact",

  post: null,
  said: 1,
  at: 1_700_000_000,
  firstAt: 1_700_000_000,
  ...over,
});

describe("a shadow post never claims a trade", () => {
  it("says 'would buy', not 'buying'", () => {
    // The exact regression: same row, one flag apart.
    assert.deepEqual(badgeOf(post()), { label: "buying", kind: "bought" });
    assert.deepEqual(badgeOf(post({ shadow: true, outcome: "shadow" })), {
      label: "would buy",
      kind: "thesis",
    });
  });

  it("says 'would sell', not 'selling'", () => {
    assert.deepEqual(badgeOf(post({ shadow: true, outcome: "shadow", action: "sell" })), {
      label: "would sell",
      kind: "thesis",
    });
  });

  it("wins over every other arm, whatever else the row says", () => {
    // A shadow row carrying a trade status is a contradiction that
    // `publishableThesis` drops before it can reach here. If one ever does
    // reach here, the conditional still wins — the badge is the last surface
    // before a reader, and it fails toward the claim that is safe to be wrong
    // about.
    for (const outcome of ["landed", "reverted", "refused", "dropped", "pending"] as const) {
      const b = badgeOf(post({ shadow: true, outcome }));
      assert.equal(b.kind, "thesis", `${outcome} must not out-rank shadow`);
      assert.ok(!/^(bought|sold|buying|selling)$/.test(b.label), `${outcome} produced "${b.label}"`);
    }
  });

  it("keeps its strip, because that is where the disclaimer renders", () => {
    // `outcomeText` — "a stated intention — not traded" — is rendered inside the
    // trade strip and nowhere else. Suppressing the strip for a shadow post,
    // which is what a thesis badge normally does, leaves a card reading "would
    // buy" with no name, no size and nothing saying the trade did not happen.
    assert.equal(hasTrade(post({ shadow: true, outcome: "shadow" })), true);
    // But a shadow post about the book rather than one name still has none.
    assert.equal(
      hasTrade(post({ shadow: true, outcome: "shadow", symbol: null, sizeUsdg: null })),
      false,
    );
    assert.equal(hasTrade(post()), true);
    assert.equal(hasTrade(post({ action: "hold", outcome: "view" })), false);
  });

  it("leaves every non-shadow badge exactly as it was", () => {
    assert.deepEqual(badgeOf(post({ outcome: "landed" })), { label: "bought", kind: "bought" });
    assert.deepEqual(badgeOf(post({ action: "sell", outcome: "landed" })), {
      label: "sold",
      kind: "sold",
    });
    assert.deepEqual(badgeOf(post({ outcome: "refused" })), { label: "turned back", kind: "turned" });
    assert.deepEqual(badgeOf(post({ outcome: "dropped" })), {
      label: "thought better of it",
      kind: "quiet",
    });
    assert.deepEqual(badgeOf(post({ action: "hold", outcome: "view" })), {
      label: "thesis",
      kind: "thesis",
    });
  });
});

(globalThis as unknown as { React: typeof React }).React = React;

/**
 * "BUYING" IS A CLAIM THAT AN ORDER IS ON ITS WAY (FE7).
 *
 * The publisher files two facts under "pending": a submitted trade ("sent,
 * waiting on the chain") and a buy or sell decision nothing was ever sent for
 * ("no trade came of it"). The feed rows tell them apart; the card and the rail
 * read this badge, which said "buying" in the money colour, with the unsettled
 * edge, about an order that never left.
 */
describe("a decision nothing came of is not buying", () => {
  const nothing = post({ outcomeText: outcomeOf(null, null).text });
  const sent = post({ outcomeText: outcomeOf("submitted", null).text });

  it("says it tried, muted, and is over", () => {
    assert.equal(nothing.outcomeText, "no trade came of it");
    assert.deepEqual(badgeOf(nothing), { label: "tried to buy", kind: "quiet" });
    assert.deepEqual(badgeOf({ ...nothing, action: "sell" }), { label: "tried to sell", kind: "quiet" });
    assert.equal(inFlightOf(nothing), false);
  });

  it("an order really in flight is still buying, and unsettled", () => {
    assert.equal(sent.outcomeText, IN_FLIGHT_TEXT);
    assert.deepEqual(badgeOf(sent), { label: "buying", kind: "bought" });
    assert.deepEqual(badgeOf({ ...sent, action: "sell" }), { label: "selling", kind: "sold" });
    assert.equal(inFlightOf(sent), true);
  });

  it("the owner's desk tape, whose rows are all trades and carry no sentence, keeps its word", () => {
    assert.deepEqual(badgeOf({ action: "buy", outcome: "pending", outcomeText: null }), { label: "buying", kind: "bought" });
    assert.deepEqual(badgeOf({ action: "buy", outcome: "pending" }), { label: "buying", kind: "bought" });
  });

  it("keeps its strip, which is where it says what happened", () => {
    assert.equal(hasTrade(nothing), true);
  });

  it("THE CARD AND THE RAIL: no 'buying', and no unsettled edge, for an order that was never sent", async () => {
    const { ThesisCard } = await import("../components/ThesisCard");
    const { AlertRow } = await import("../components/shell/RailAlerts");
    for (const Row of [ThesisCard, AlertRow] as const) {
      const never = renderToStaticMarkup(createElement(Row as never, { t: nothing }));
      assert.match(never, />tried to buy</);
      assert.doesNotMatch(never, /buying|unsettled/);
      const inFlight = renderToStaticMarkup(createElement(Row as never, { t: sent }));
      assert.match(inFlight, /class="mm-chip up unsettled">buying</);
    }
  });
});
