/**
 * WHAT MAY BE PRINTED AS A COIN'S NAME.
 *
 * This rule was a closure in index.ts, called from one place, and it was
 * correct only because of that one place. It returns "Tesla" for TSLA, which
 * was harmless while the Brain path — whose symbols are always address-derived
 * — was the sole caller, and became a fleet-wide copy change the moment the
 * deterministic strategies started calling it. The stock clause below is what
 * makes it safe to call from anywhere, and the test is why it stays.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { coinDisplayName } from "./coin-name";

const coin = (name: string, symbol = "T7631DACC21B") => ({ symbol, name, kind: "memecoin" });

describe("a discovered coin gets its name", () => {
  it("takes the label the tape gave", () => {
    assert.equal(coinDisplayName(coin("CASHCAT")), "CASHCAT");
  });

  it("keeps only the coin from a pool label, not the venue", () => {
    // GeckoTerminal names a POOL: "CASHCAT / WETH 1%". The pair and the fee
    // tier are the venue and would read as part of the coin's name.
    assert.equal(coinDisplayName(coin("CASHCAT / WETH 1%")), "CASHCAT");
  });

  it("strips characters a third party chose that we will not print", () => {
    assert.equal(coinDisplayName(coin("CASH<script>CAT")), "CASHscriptCAT");
  });

  it("caps the length", () => {
    assert.equal(coinDisplayName(coin("A".repeat(80)))?.length, 24);
  });
});

describe("what is never printed as a name", () => {
  it("refuses an address-shaped one", () => {
    // A post may not carry an address. This is the only string here that
    // somebody else wrote, so the refusal is on our side, not theirs.
    assert.equal(coinDisplayName(coin("0xdeadbeefcafe")), null);
  });

  it("refuses a Solana key, which the 24-character cap would otherwise hide (Solana P0)", () => {
    assert.equal(coinDisplayName(coin(SOLANA_USDG_MINT)), null);
    assert.equal(coinDisplayName(coin(`${SOLANA_USDG_MINT} / SOL`)), null);
    // Characters stripped from it do not make it a name either.
    assert.equal(coinDisplayName(coin(`${SOLANA_USDG_MINT.slice(0, 20)}#${SOLANA_USDG_MINT.slice(20)}`)), null);
    assert.equal(coinDisplayName(coin("CASHCAT / SOL")), "CASHCAT");
  });

  it("refuses a name with a whole 0x address or hash inside it (tightened in Solana P0)", () => {
    // Before, the 24-character cap printed this as "PEPE 0x2ca2b5bd3b6635d63",
    // a partial address. Core's detector sees the whole one first.
    assert.equal(coinDisplayName(coin("PEPE 0x2ca2b5bd3b6635d630419c57a13c6b6a856ec96d")), null);
    assert.equal(coinDisplayName(coin(`PEPE 0x${"ab".repeat(32)} / WETH`)), null);
    assert.equal(coinDisplayName(coin("PEPE 2 / WETH 1%")), "PEPE 2");
  });

  it("refuses one that is only punctuation", () => {
    assert.equal(coinDisplayName(coin("!!! ###")), null);
    assert.equal(coinDisplayName(coin("   ")), null);
  });

  it("refuses the id back again", () => {
    // trencher-discovery falls back to the synthetic symbol as the name when
    // the tape carried none, and "T763… (T763…)" is noise.
    assert.equal(coinDisplayName(coin("T7631DACC21B")), null);
  });

  it("returns absent, not a placeholder, for a token it does not have", () => {
    assert.equal(coinDisplayName(undefined), null);
    assert.equal(coinDisplayName(null), null);
  });
});

describe("an issuer-backed ticker is left alone", () => {
  it("does not rename a stock", () => {
    // THE CLAUSE THIS WHOLE FILE EXISTS FOR. Every deterministic strategy
    // trades these and now asks for a name; "buy Tesla (TSLA) 5.00 USDG" is
    // a change to every row in the fleet's feed, and nobody asked for it.
    assert.equal(coinDisplayName({ symbol: "TSLA", name: "Tesla", kind: "stock" }), null);
  });

  it("does not rename an ETF", () => {
    assert.equal(coinDisplayName({ symbol: "QQQ", name: "Invesco QQQ", kind: "etf" }), null);
  });

  it("refuses a token whose kind is unknown rather than guessing", () => {
    // Fail closed: an unclassified token is not established to be a coin, and
    // the cost of being wrong is a stock ticker rewritten in public.
    assert.equal(coinDisplayName({ symbol: "T7631DACC21B", name: "CASHCAT" }), null);
  });
});
