/**
 * THE FOUR SHAPES THAT WERE LIVE ON THE PUBLIC FEED, 2026-09-17.
 *
 * Sampled from /api/theses: 40 rows, 32 suspect. Each describe below is one
 * of them, pinned on the published shape rather than on source text.
 *
 *   28/40 rows were EXACTLY 220 characters, cut mid-word ("...230.01 res").
 *   "no decision (refused): portfolio-quality-insufficient: core reports
 *    performance unmeasurable: contributions unknown" — a Brain gate refusal
 *    published as a post, with the "dropped" badge.
 *   "vault-deposit 0.00 USDG — 0.00 USDG idle above the 50.00 floor" — a
 *    sub-cent park the wall refused, published with the "refused" badge.
 *   "hold NVDA 0.00 USDG" — a hold wearing a size, which the feed card then
 *    re-parsed and printed as "$0.00" beside a real 24h change.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clip, publishableThesis, REASON_MAX, type ThesisRow } from "./thesis-policy";

const row = (over: Partial<ThesisRow> = {}): ThesisRow => ({
  name: "Milla",
  slug: "0123456789abcdef",
  source: "strategist",
  action: null,
  symbol: null,
  size_usdg: null,
  reason: "Nothing has moved since my last pass.",
  status: null,
  said: 1,
  last_at: 1_700_000_000,
  first_at: 1_700_000_000,
  mode: "live",
  ...over,
});

describe("a long reason is cut at a boundary, and says that it was cut", () => {
  const long =
    "Nothing has moved since my last pass. My only position is 7.91 USDG of NVDA, stale at 219.67 because the " +
    "underlying market is shut — an old price, not a wrong one — sitting mid-range between 210.01 support and 230.01 resistance " +
    "with deep two-sided depth, so there is no edge to act on and I am staying flat.";

  it("never exceeds the cap", () => {
    assert.ok(clip(long).length <= REASON_MAX, `${clip(long).length} > ${REASON_MAX}`);
  });

  it("ends on a word, not inside one, with an ellipsis", () => {
    const c = clip(long);
    assert.ok(c.endsWith("…"), `must end with an ellipsis: "${c}"`);
    const body = c.slice(0, -1);
    // THE LIVE FAILURE: the last token before the cut was "res" — the front of
    // "resistance". After the cut the last token must be a whole word of the
    // source: it must be followed by a space or punctuation in the original.
    const lastWord = body.split(/\s+/).pop()!;
    const at = long.indexOf(body) + body.length;
    assert.ok(/[\s.,;:!?—–-]/.test(long.charAt(at)) || at === long.length, `cut inside "${lastWord}" at ${at}: "${long.slice(at - 8, at + 8)}"`);
  });

  it("prefers a sentence end when one falls late enough", () => {
    const twoSentences = "First sentence that is fairly long and sets up the view for the reader who was not here today. " + "x".repeat(200);
    const c = clip(twoSentences);
    assert.ok(c.startsWith("First sentence that is fairly long"), c);
    assert.ok(c.endsWith("…"), c);
    assert.ok(!c.includes("xxxx"), `must not carry the run-on second sentence: "${c}"`);
  });

  it("leaves a short reason exactly alone", () => {
    assert.equal(clip("Short and fine."), "Short and fine.");
    assert.equal(clip("  padded  "), "padded");
  });

  it("applies to model reasons through the gate, and to the agent's own post", () => {
    const t = publishableThesis(row({ reason: long, post: long }))!;
    assert.ok(t.reason!.length <= REASON_MAX && t.reason!.endsWith("…"), t.reason!);
    assert.ok(t.post!.length <= REASON_MAX && t.post!.endsWith("…"), t.post!);
  });

  it("does not touch a strategy source's sentence, which is ours and already bounded", () => {
    // renderWhy output is under 220 by its own test; the policy must not start
    // trimming a strategy sentence just because clip exists.
    // (A public book, so the sentence is exactly as written: a private book's
    // loses its figures first — private-book.test.ts.)
    const t = publishableThesis(row({ source: "strategy:even-keel", public_book: true, reason: "AAPL is 0.27 USDG under its equal weight — topping it up from cash" }))!;
    assert.equal(t.reason, "AAPL is 0.27 USDG under its equal weight — topping it up from cash");
  });
});

describe("a Brain gate refusal is the owner's fact, not a post", () => {
  it("drops the live-enrolled row", () => {
    const t = publishableThesis(
      row({
        source: "brain",
        reason: "no decision (refused): portfolio-quality-insufficient: core reports performance unmeasurable: contributions unknown",
        dropped_rule: "brain-refused",
      }),
    );
    assert.equal(t, null);
  });

  it("drops the shadow row the same way (it already did, by the contradiction rule)", () => {
    assert.equal(publishableThesis(row({ source: "brain-shadow", reason: "no decision (refused): x", dropped_rule: "brain-refused" })), null);
  });

  it("still publishes a real Brain thesis", () => {
    const t = publishableThesis(row({ source: "brain", action: "hold", symbol: "NVDA", size_usdg: 0, reason: "Weak tape, staying put." }));
    assert.ok(t !== null);
  });
});

describe("cash management that did not happen is not a post", () => {
  const park = (over: Partial<ThesisRow>) =>
    row({
      source: "strategy:steady-basket",
      action: "vault-deposit",
      size_usdg: 0,
      reason: "0.00 USDG idle above the 50.00 floor — parking it in the vault until the next buy",
      ...over,
    });

  it("drops a refused park", () => {
    assert.equal(publishableThesis(park({ status: "rejected", reject_rule: "deposit-cap" })), null);
  });

  it("drops a pending or dropped park", () => {
    assert.equal(publishableThesis(park({ status: null })), null);
    assert.equal(publishableThesis(park({ status: null, dropped_rule: "#0: nothing" })), null);
  });

  it("keeps a park that landed — it happened, and it is the owner's money", () => {
    const t = publishableThesis(park({ status: "landed", size_usdg: 25, reason: "25.00 USDG idle above the 50.00 floor — parking it in the vault until the next buy" }));
    assert.ok(t !== null);
    assert.equal(t.outcome, "landed");
  });

  it("does not gate an ordinary refused BUY from a strategy — that is a different rule", () => {
    // The strategist's refused buys are its thesis with an honest badge; only
    // class-route (TRADED_ONLY) and cash moves are kept off the feed.
    const t = publishableThesis(row({ source: "strategist", action: "buy", symbol: "AAPL", size_usdg: 5, reason: "Cheap here.", status: "rejected", reject_rule: "per-trade-cap" }));
    assert.ok(t !== null);
    assert.equal(t.outcome, "refused");
  });
});

describe("a hold has no size", () => {
  it("renders the head without a figure", () => {
    const t = publishableThesis(row({ source: "brain-shadow", action: "hold", symbol: "NVDA", size_usdg: 0, reason: "Weak tape." }))!;
    assert.equal(t.head, "hold NVDA");
  });

  // A size is printed only for a PUBLIC book — private-book.test.ts.
  it("keeps the size on a public book's buy and sell", () => {
    assert.equal(publishableThesis(row({ source: "strategist", action: "buy", symbol: "NVDA", size_usdg: 5, reason: "x", status: "landed", public_book: true }))!.head, "buy NVDA 5.00 USDG");
    assert.equal(publishableThesis(row({ source: "strategist", action: "sell", symbol: "NVDA", size_usdg: 3.6, reason: "x", status: "landed", public_book: true }))!.head, "sell NVDA 3.60 USDG");
  });
});

describe("an operational notice is not a market thesis", () => {
  it("drops typed gate holds even when the manager supplied fluent prose", () => {
    assert.equal(publishableThesis(row({ source: "brain", action: "hold", hold_kind: "GATE_FORCED_HOLD", reason: "Price recovered but volume is uncertain." })), null);
    assert.ok(publishableThesis(row({ source: "brain", action: "hold", hold_kind: "MODEL_HOLD", reason: "Price recovered but volume is uncertain." })));
  });

  it("does not turn an error-only or missing reason into a public view", () => {
    for (const reason of ["", "nothing held to sell", "I cannot sell NVDA because no position exists.", "nothing bought — today's buying budget is spent.", "nothing bought — I looked at 3 names and held all of them. A decision, not a quiet tick", "nothing in your basket is a stock, and your asset mode is Stocks only — so there is nothing to trade", "provider failed: timeout", "no decision (error): unavailable"]) {
      assert.equal(publishableThesis(row({ reason, action: "hold" })), null, reason);
    }
    assert.equal(publishableThesis(row({ reason: null, dropped_rule: "#0 NVDA: nothing held to sell" })), null);
  });

  it("retains actual views and their failed execution outcomes without rewriting owner records", () => {
    for (const status of ["rejected", "reverted"]) {
      const original = row({ action: "sell", symbol: "NVDA", reason: "Depth has thinned since my last review; I would reduce exposure, but recovery would invalidate that view.", status, reject_rule: "nothing-held" });
      const snapshot = { ...original };
      const published = publishableThesis(original)!;
      assert.ok(published);
      assert.equal(published.reason, original.reason);
      assert.equal(published.outcome, status === "rejected" ? "refused" : "reverted");
      assert.deepEqual(original, snapshot);
    }
    assert.ok(publishableThesis(row({ reason: "I cannot justify selling while depth and price hold; weakening either would change my view." })));
  });

  it("uses an admitted post when no reason exists, but rejects operational post prose", () => {
    const actual = "Buyers broadened while depth held. A narrower buyer base would weaken my view.";
    assert.equal(publishableThesis(row({ reason: null, post: actual }))?.post, actual);
    assert.equal(publishableThesis(row({ reason: null, post: "Error: cannot sell" })), null);
  });

  it("admits deterministic market reviews with a real hold view", () => {
    assert.ok(publishableThesis(row({ source: "market-review", action: "hold", symbol: "NVDA", reason: "The fresh quote is unchanged. Hold pending another quote; a sustained move would change this view." })));
  });
});
