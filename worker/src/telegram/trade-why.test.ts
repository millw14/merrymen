/**
 * WHAT A MODEL IS ALLOWED TO KNOW ABOUT THE OWNER'S MONEY.
 *
 * The trade push now carries a sentence explaining why the trade happened. The
 * receipt above it — kind, amount, status, hash — is still built by code and
 * sent verbatim, and this boundary is what keeps the two apart.
 *
 * Two properties, and both are about failure rather than feature:
 *
 *   NO FIGURES CROSS. If an amount is in the prompt, a model can restate it,
 *   and a wrong number sitting beside the right one is worse than no sentence.
 *   The evidence carries the symbol, the side, the stated reason and headlines.
 *   Nothing countable.
 *
 *   NO INVENTION BEHIND IT. With no recorded reason and no matching news there
 *   is nothing to explain from, so the builder returns null and the caller
 *   sends the receipt alone. An agent that cannot say why it traded must not be
 *   handed a model and asked to improvise a motive.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tradeWhyEvidence, type NewsLite } from "./notifier";

const FILL = { kind: "swap", status: "landed" } as const;

const NEWS: NewsLite[] = [
  {
    headline: "Chipmaker lifts guidance on datacentre demand",
    source: "reuters.com",
    symbols: ["NVDA"],
  },
  { headline: "Retailer warns on holiday spending", source: "ft.com", symbols: ["WMT"] },
];

describe("the evidence a trade explanation is built from", () => {
  it("CARRIES NO FIGURES — the receipt above it owns every number", () => {
    const ev = tradeWhyEvidence(FILL, { symbol: "NVDA", action: "buy", reason: "Momentum held." }, NEWS);
    assert.ok(ev, "there was a reason, so there is evidence");
    // Any digit at all is a smell here: the builder is handed a row that has an
    // amount and an id, and must pass neither.
    assert.doesNotMatch(ev, /\d/, `no numeral may reach the prompt, got: ${ev}`);
    assert.doesNotMatch(ev, /0x[0-9a-f]/i, "and no hash");
  });

  it("passes the decision's own stated reason through", () => {
    const ev = tradeWhyEvidence(
      FILL,
      { symbol: "NVDA", action: "buy", reason: "Adding on the pullback while the trend held." },
      [],
    );
    assert.match(ev!, /Adding on the pullback while the trend held\./);
  });

  it("RETURNS NULL when there is nothing to explain from", () => {
    // No reason recorded, no news matched. The caller sends the receipt alone
    // rather than asking a model to supply a motive.
    assert.equal(tradeWhyEvidence(FILL, { symbol: "NVDA", action: "buy", reason: null }, []), null);
    assert.equal(tradeWhyEvidence(FILL, null, NEWS), null, "news alone, with no symbol to match, is not evidence");
    assert.equal(tradeWhyEvidence(FILL, { symbol: "", action: null, reason: "   " }, []), null, "whitespace is not a reason");
  });

  it("matches news to the traded symbol and leaves everybody else's out", () => {
    const ev = tradeWhyEvidence(FILL, { symbol: "NVDA", action: "buy", reason: null }, NEWS);
    assert.ok(ev, "a matching story is enough on its own");
    assert.match(ev, /datacentre demand/);
    assert.doesNotMatch(ev, /holiday spending/, "WMT's news is not NVDA's evidence");
  });

  it("says so EXPLICITLY when the desk held nothing, so the model cannot imply otherwise", () => {
    const ev = tradeWhyEvidence(FILL, { symbol: "TSLA", action: "sell", reason: "Floor hit." }, NEWS);
    assert.match(ev!, /no stories for TSLA/i);
    assert.match(ev!, /Do not imply there were any/i);
  });

  it("never renders a url, even though the news item has one", () => {
    // Same rule renderNews states: a link is an instruction-shaped thing to
    // hand a model. NewsLite does not carry one, and that is the point — the
    // field is dropped at the type boundary rather than filtered later.
    const ev = tradeWhyEvidence(FILL, { symbol: "NVDA", action: "buy", reason: "x" }, NEWS);
    assert.doesNotMatch(ev!, /https?:\/\//);
  });

  it("and a paper fill is described as a paper fill", () => {
    // The one place the wording must differ: telling an owner a swap "went
    // through" when it filled on the paper book is the simulated-money lie this
    // repo keeps having to remove.
    const ev = tradeWhyEvidence(
      { kind: "swap", status: "paper" },
      { symbol: "NVDA", action: "buy", reason: "Momentum." },
      [],
    );
    assert.match(ev!, /paper book/);
    assert.doesNotMatch(ev!, /went through/);
  });
});
