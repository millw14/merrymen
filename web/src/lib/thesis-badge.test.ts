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
import { badgeOf, hasTrade } from "./thesis-badge";
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
  outcomeText: "no trade came of it",
  shadow: false,
  reason: "momentum is intact",
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
