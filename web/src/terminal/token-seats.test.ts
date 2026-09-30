/**
 * THE HOLDERS LIST DOES NOT BLANK WHEN THE FEED REFRESHES.
 *
 * The token page built its seats — the holders, each with the thesis its agent
 * last posted about this token — inside the effect that READS the holders, and
 * that effect listed `theses` among its dependencies. The feed is read every
 * ten seconds now, so every feed read would have emptied the list, shown the
 * loading skeleton and fetched the ledger again. The thesis is now laid over
 * the holders the read returned, as a derivation, and only the token changing
 * re-reads anything.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Thesis } from "./live";
import { seatsOf } from "./token-seats";

const holder = (slug: string | null, over: Record<string, unknown> = {}) => ({
  slug,
  name: slug ?? "Private",
  handle: null,
  paper: false,
  valueUsdg: 10,
  costUsdg: 9,
  pnlBps: 1100,
  enteredAt: 1_700_000_000,
  entryPriceUsd: 3.1,
  basisSource: "receipt" as const,
  ...over,
});
const post = (slug: string, symbol: string, reason: string): Thesis =>
  ({ name: slug, slug, handle: null, action: "buy", symbol, sizeUsdg: 5, reason, paper: false, head: "" }) as Thesis;

describe("seats on the token page", () => {
  it("lay each holder's latest thesis about THIS token over what the ledger read", () => {
    const seats = seatsOf([holder("shogun")], [post("shogun", "NVDA", "other"), post("shogun", "tsla", "cheap")], "TSLA", false);
    assert.equal(seats.length, 1);
    assert.equal(seats[0]!.thesis, "cheap", "case-insensitive on the symbol, and not another token's thesis");
    assert.equal(seats[0]!.position, 10);
    assert.equal(seats[0]!.avgEntry, 3.1);
    assert.equal(seats[0]!.time, 1_700_000_000);
  });

  it("a newer feed changes the thesis and keeps the holders", () => {
    const holders = [holder("shogun")];
    assert.equal(seatsOf(holders, [], "TSLA", false)[0]!.thesis, "");
    assert.equal(seatsOf(holders, [post("shogun", "TSLA", "later")], "TSLA", false)[0]!.thesis, "later");
  });

  it("says nothing on a symbol two tokens share — the post may be about the other one", () => {
    assert.equal(seatsOf([holder("shogun")], [post("shogun", "TSLA", "cheap")], "TSLA", true)[0]!.thesis, "");
  });

  it("keeps a holder with no public slug off the list, as the page always has", () => {
    assert.deepEqual(seatsOf([holder(null), holder("robin")], [], "TSLA", false).map((s) => s.slug), ["robin"]);
  });
});
