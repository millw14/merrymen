/**
 * WHICH RESEARCH DESK AN INSTRUMENT GETS, and why it cannot be a guess.
 *
 * The worker hardcoded `"equity-token"` for every Brain run. That was true only
 * because the shadow cohort was one agent holding TSLA. The moment a second
 * agent holds a discovered token, the hardcode hands a launchpad memecoin the
 * equity desk — technical, news, sentiment and FUNDAMENTALS — and a
 * fundamentals analyst asked about a memecoin produces confident text about
 * nothing. That is worse than no analyst at all: it arrives looking like
 * evidence, and the manager weighs it as such.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STOCK_TOKENS, instrumentClassOf, tradesAroundTheClock } from "./tokens";

describe("the desk comes from the token, not from an assumption", () => {
  it("routes issuer-backed stocks and ETFs to the equity desk", () => {
    const stock = STOCK_TOKENS.find((t) => t.kind === "stock")!;
    assert.equal(instrumentClassOf(stock.address), "equity-token");
    const etf = STOCK_TOKENS.find((t) => t.kind === "etf");
    if (etf) assert.equal(instrumentClassOf(etf.address), "equity-token");
  });

  it("routes anything not in the table to the memecoin desk", () => {
    // Discovered tokens arrive from the launchpad scanner and are never in
    // STOCK_TOKENS. Unknown is the CAUTIOUS arm — liquidity and on-chain lenses,
    // away from fundamentals — which is the right treatment for something
    // nobody has verified.
    assert.equal(instrumentClassOf("0x1111111111111111111111111111111111111111"), "memecoin");
  });

  it("matches on address, never on symbol", () => {
    // A discovered token may call itself AAPL. Matching on the name would let a
    // launchpad token pick its own research desk.
    const aapl = STOCK_TOKENS.find((t) => t.symbol === "AAPL")!;
    assert.equal(instrumentClassOf(aapl.address), "equity-token");
    assert.equal(
      instrumentClassOf("0x000000000000000000000000000000000000dEaD"),
      "memecoin",
      "an impostor at a different address gets the unverified desk",
    );
  });

  it("is case-insensitive, because addresses arrive checksummed and not", () => {
    const t = STOCK_TOKENS[0]!;
    assert.equal(instrumentClassOf(t.address.toLowerCase()), instrumentClassOf(t.address.toUpperCase()));
    assert.equal(instrumentClassOf(`  ${t.address}  `), "equity-token", "and tolerates stray whitespace");
  });
});

describe("stale means two different things and the caller has to know which", () => {
  it("says a tokenised equity does NOT trade around the clock", () => {
    // Its Chainlink feed is 24/5. Outside US market hours the price is
    // legitimately hours old, `staleFeeds` marks it, and Brain correctly
    // refuses to act — that is the market being shut, not a fault.
    const stock = STOCK_TOKENS.find((t) => t.kind === "stock")!;
    assert.equal(tradesAroundTheClock(stock.address), false);
  });

  it("says a pool-priced token does", () => {
    // Here a stale reading means the POOL stopped being readable, which is a
    // fault rather than a weekend — and it is why a 24/7 instrument is what
    // makes shadow observation possible outside market hours.
    assert.equal(tradesAroundTheClock("0x1111111111111111111111111111111111111111"), true);
  });
});
