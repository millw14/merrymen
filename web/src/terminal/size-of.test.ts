/**
 * THE "$0.00" ON THE FEED CARD.
 *
 * A Brain hold arrives with sizeUsdg 0. `sizeOf` used to treat 0 as "not
 * given" and fall through to a regex over the head — which re-parsed the
 * "0.00 USDG" out of "hold NVDA 0.00 USDG" and handed the card a figure to
 * print beside a real 24h change. Not a price, not a size: a measured zero
 * round-tripped through text and shown as money.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sizeOf, type Thesis } from "./live";

const t = (over: Partial<Thesis>): Thesis =>
  ({ name: "Gary", slug: null, handle: null, action: "hold", symbol: "NVDA", sizeUsdg: null, reason: null, paper: false, head: "", ...over }) as Thesis;

describe("sizeOf", () => {
  it("does not print a zero size", () => {
    assert.equal(sizeOf(t({ sizeUsdg: 0, head: "hold NVDA 0.00 USDG" })), null);
  });

  it("trusts a numeric size from the API without re-reading the head", () => {
    // The head is deliberately contradictory; the number wins.
    assert.equal(sizeOf(t({ sizeUsdg: 5, head: "buy NVDA 999.00 USDG" })), 5);
  });

  it("a numeric zero is an answer — it must not fall through to the head", () => {
    // THE MUTATION THIS CATCHES: `sizeUsdg > 0 ? sizeUsdg : <regex>`. With the
    // API saying 0 and a head that happens to carry a figure, the old code
    // printed the head's figure as if it were the size. 0 means 0.
    assert.equal(sizeOf(t({ sizeUsdg: 0, head: "buy NVDA 8.33 USDG" })), null);
  });

  it("falls back to the head only when the API gave no number", () => {
    assert.equal(sizeOf(t({ sizeUsdg: null, head: "buy NVDA 8.33 USDG" })), 8.33);
    assert.equal(sizeOf(t({ sizeUsdg: undefined as never, head: "buy NVDA 8.33 USDG" })), 8.33);
  });

  it("never returns a zero from the head either", () => {
    assert.equal(sizeOf(t({ sizeUsdg: null, head: "hold NVDA 0.00 USDG" })), null);
  });

  it("returns null when there is nothing to show", () => {
    assert.equal(sizeOf(t({ sizeUsdg: null, head: "" })), null);
  });
});
