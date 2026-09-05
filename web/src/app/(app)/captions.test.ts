import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * SENTENCES THAT ARE DOING WORK, PINNED BEFORE ANYONE TIDIES THEM.
 *
 * A cleanliness pass deletes prose. Most of the prose on these pages is
 * decoration and should go; a few paragraphs are the only thing standing
 * between a figure and a misreading of it, and they look exactly like the rest.
 *
 * This file exists so the difference is mechanical rather than remembered. Each
 * assertion names what the sentence prevents. If one fails, the question is not
 * "restore the wording" — it is "does the page still say this, somehow".
 */

const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("the leaderboard explains its two refusals", () => {
  const PAGE = at("../../terminal/screens/Board.tsx");

  it("distinguishes no-deposit from never-filled in words", () => {
    // rank-pnl publishes "unranked" for two unrelated reasons and the board
    // sorts both to the bottom together. Without this paragraph an agent that
    // has funded and never traded is indistinguishable from one nobody has put
    // a penny into — and the second is a dormant account while the first is the
    // exact shape that once published +2643%.
    assert.match(PAGE, /no capital to measure a return against/);
    assert.match(PAGE, /no return to measure/);
  });

  it("says why a simulated book cannot be divided by a real deposit", () => {
    // This is the incident, stated in the product rather than only in a commit
    // message. It is the reason the refusal exists at all.
    assert.match(PAGE, /pretend book/);
    assert.match(PAGE, /publishes a number that never happened/);
  });
});

describe("the token page says how much of the book it is showing", () => {
  const PAGE = at("../../terminal/screens/Token.tsx");

  it("publishes the count of agents who opted in, against the total", () => {
    // Holdings are opt-in per agent. Without this line a short list reads as
    // the whole one, which understates who is in a token and overstates how
    // much of it we can see.
    assert.match(PAGE, /\{holderCoverage\.published\} of \{holderCoverage\.total\}/);
    assert.match(PAGE, /published:data\.ledger\.holders\.length,total:data\.ledger\.holders\.length\+data\.ledger\.privateHolders/);
    assert.match(PAGE, /publish their positions/);
  });
});

describe("the oracle chart says what its axis is", () => {
  const LINE = at("../../components/PriceLine.tsx");

  it("states that it is a feed and not a market", () => {
    // Every other figure on that page is a market number. Without this the line
    // is read as one, and a Chainlink series is not a price anyone traded at.
    assert.match(LINE, /not a market/);
  });

  it("states that the axis is compressed and the gaps are real", () => {
    // The component's own header gives the reason: a compressed axis a reader
    // has not been told about is the dishonest version. The alternative it
    // rejected — a true wall-clock axis — was measured at 28% coverage.
    // Whitespace-tolerant: JSX wraps these across lines and a reformat must not
    // read as the sentence having been deleted.
    assert.match(LINE, /Time\s+runs\s+to\s+scale\s+within\s+a\s+session/);
    assert.match(LINE, /left\s+out\s+rather\s+than\s+drawn\s+across/);
  });
});

describe("the agent profile says what its return is net of", () => {
  const PAGE = at("../../terminal/screens/Profile.tsx");

  it("keeps the unpriced-gas caveat inline with the figure", () => {
    // A fill whose gas could not be priced contributes nothing to the sum and
    // is never counted, so the return silently understates its own cost. This
    // sentence is the only thing distinguishing "net of gas" from "net of some
    // of the gas", and it has to sit with the number it qualifies.
    assert.match(PAGE, /had gas we could not price/);
    assert.match(PAGE, /not the full cost/);
  });
});
