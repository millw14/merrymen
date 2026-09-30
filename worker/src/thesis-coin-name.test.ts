/**
 * THE FEED SHOULD SAY WHAT WAS TRADED.
 *
 * A real post, live on 2026-09-20:
 *
 *     shogun hold T7631DACC21B
 *
 * That id is address-derived on purpose — `T` plus eleven hex of the contract —
 * because a coin's own `symbol()` is text its deployer chose and can change,
 * and one calling itself NVDA must never resolve to a stock's price. The
 * property is worth keeping. Printing it at a reader on its own is not.
 *
 * So the name rides ALONGSIDE the id. Not instead of it: the id is what
 * everything prices, routes and settles against, two coins may call themselves
 * the same thing on the same day, and a feed that dropped it would be the one
 * surface that cannot be reconciled against the ledger.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishableThesis, readerHead } from "./thesis-policy";

const row = (over: Record<string, unknown> = {}) => ({
  agent_id: "0xabc",
  name: "shogun",
  source: "brain",
  action: "hold",
  symbol: "T7631DACC21B",
  size_usdg: 0,
  reason: "Flow is thin and the book is shallow; nothing worth taking here.",
  said: 1,
  last_at: 1_789_000_000,
  ...over,
});

const head = (over: Record<string, unknown> = {}) =>
  publishableThesis(row(over) as never)?.head ?? "";

describe("the coin is named when the tape gave a name", () => {
  it("shows the name and keeps the id beside it", () => {
    assert.equal(head({ display_name: "CASHCAT" }), "hold CASHCAT (T7631DACC21B)");
  });

  // A size is in the head only for a PUBLIC book (private-book.test.ts), so the
  // layout around one is pinned on one.
  it("names it on a buy, with the size", () => {
    assert.equal(
      head({ action: "buy", size_usdg: 5, display_name: "CHUMP", public_book: true }),
      "buy CHUMP (T7631DACC21B) 5.00 USDG",
    );
  });

  it("names it on a sell too", () => {
    assert.match(head({ action: "sell", size_usdg: 5, display_name: "CASHCAT" }), /^sell CASHCAT \(T7631DACC21B\)/);
  });
});

describe("what it does when there is no name", () => {
  it("prints the id alone rather than a placeholder", () => {
    assert.equal(head(), "hold T7631DACC21B");
    assert.equal(head({ display_name: null }), "hold T7631DACC21B");
  });

  it("does not print the id twice when the name IS the id", () => {
    // trencher-discovery falls back to the synthetic symbol as the name when
    // the tape carried none, and "T763… (T763…)" is noise.
    assert.equal(head({ display_name: "T7631DACC21B" }), "hold T7631DACC21B");
  });

  it("leaves an ordinary stock ticker untouched", () => {
    // Stocks already have a name a reader knows; there is nothing to add.
    assert.equal(head({ symbol: "TSLA", action: "buy", size_usdg: 5, public_book: true }), "buy TSLA 5.00 USDG");
  });
});

describe("the id is never dropped", () => {
  it("keeps it even when the name is long", () => {
    const h = head({ display_name: "A Very Long Coin Name Here" });
    assert.match(h, /T7631DACC21B/, "the ledger key must stay readable from the feed");
  });

  it("still refuses to publish what it refused before", () => {
    // A name is a display change and may not widen what may be said. An
    // operational notice is not a thesis, with or without one.
    assert.equal(
      publishableThesis(row({ display_name: "CASHCAT", reason: "error: provider unavailable" }) as never),
      null,
    );
  });
});

/**
 * THE NAME TRAVELS AS A FIELD, NOT ONLY INSIDE A SENTENCE.
 *
 * The head carries "(T3139F043B88)" because /why and the peer files reconcile
 * against the ledger by it. Every surface that lays the facts out itself — the
 * rail, the alerts column, a trade line — had only `symbol` to print, so it
 * printed the machine id at a reader. `displayName` is the name on its own;
 * `readerHead` is the head a reader sees, with the id left to a tooltip.
 */
describe("a reader sees the coin's name, and the ledger keeps its id", () => {
  it("publishes the name beside the id, not instead of it", () => {
    const post = publishableThesis(row({ display_name: "JUGGERNAUT" }) as never)!;
    assert.equal(post.displayName, "JUGGERNAUT");
    assert.equal(post.symbol, "T7631DACC21B", "the id is still the symbol");
    assert.equal(post.head, "hold JUGGERNAUT (T7631DACC21B)", "and still in the head /why and peers read");
    assert.equal(readerHead(post), "hold JUGGERNAUT");
  });

  it("names it on a trade with the size kept", () => {
    const post = publishableThesis(row({ action: "buy", size_usdg: 5, display_name: "CHUMP", public_book: true }) as never)!;
    assert.equal(readerHead(post), "buy CHUMP 5.00 USDG");
  });

  it("no name, or a name that IS the id, is null — never a placeholder", () => {
    for (const display_name of [null, "", "   ", "T7631DACC21B"]) {
      const post = publishableThesis(row({ display_name }) as never)!;
      assert.equal(post.displayName, null);
      assert.equal(readerHead(post), "hold T7631DACC21B", "the id alone is what there is to say");
    }
  });

  it("a stock ticker is left exactly as it was", () => {
    const post = publishableThesis(row({ symbol: "TSLA", action: "buy", size_usdg: 5 }) as never)!;
    assert.equal(post.displayName, null);
    assert.equal(readerHead(post), post.head);
  });

  it("the name is user-supplied text and passes the address backstop like everything else", () => {
    // Deployer-chosen, so it is treated as hostile: an address in it costs the
    // whole post, exactly as it would in the head.
    assert.equal(publishableThesis(row({ display_name: "send to 0xdeadbeefcafe1234" }) as never), null);
  });
});
