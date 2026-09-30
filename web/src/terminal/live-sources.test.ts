/**
 * EACH READ LANDS ON ITS OWN, AND NOTHING ELSE MOVES.
 *
 * The shell used to rebuild the whole screen from one pass over six reads. It
 * now keeps the latest answer of each read and derives the screen from all of
 * them (`liveOf`), so a feed answer can arrive while the launchpad sweep is
 * still out. These pin what one arrival may and may not change.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { liveOf, marketTokensOf, seedSources, withChanges, withQuotes, withRead, type RawRead } from "./live";

const TSLA = "0x322f0929c4625ed5bad873c95208d54e1c003b2d";

const ok = (body: unknown): RawRead => ({ text: JSON.stringify(body), answered: true });
const failed: RawRead = { text: null, answered: true };
const silent: RawRead = { text: null, answered: false };

const market = (price: number | null) =>
  ok({
    source: "chain",
    tokens: [{ symbol: "TSLA", name: "Tesla", kind: "stock", address: TSLA, logo: "", priceUsd: price, holders: 12 }],
  });
const theses = (rows: Array<Record<string, unknown>>) => ok({ source: "sqlite", theses: rows });
const buy = { name: "Shogun", slug: "shogun", handle: null, action: "buy", symbol: "TSLA", sizeUsdg: 5, reason: "r", paper: false, head: "bought TSLA", outcome: "landed", at: 100, postId: "a".repeat(32) };

describe("one read's answer, applied", () => {
  it("a readable answer replaces the last, and an identical one changes nothing at all", () => {
    const first = withRead(seedSources(), "theses", theses([buy]), true);
    assert.equal(first.theses.read, "ok");
    const again = withRead(first, "theses", theses([buy]), true);
    assert.equal(again, first, "the same bytes must not re-render every screen every ten seconds");
    const next = withRead(first, "theses", theses([]), true);
    assert.notEqual(next, first);
    assert.equal(liveOf(next).theses.length, 0, "a newer, empty answer is an answer");
  });

  it("A FAILURE AFTER A GOOD READ leaves the good one on screen, where the outage line dates it", () => {
    const good = withRead(seedSources(), "theses", theses([buy]), true);
    for (const bad of [failed, silent, ok({ source: "none", theses: [] })]) {
      const after = withRead(good, "theses", bad, true);
      assert.equal(after, good);
      assert.equal(liveOf(after).reads.theses, "ok");
      assert.equal(liveOf(after).theses.length, 1);
    }
  });

  it("a failure with nothing good before it is shown as unreadable, never as an empty feed", () => {
    const s = withRead(seedSources(), "theses", failed, true);
    assert.equal(liveOf(s).reads.theses, "unreadable");
    assert.equal(liveOf(seedSources()).reads.theses, "unread", "and nobody asking yet is a third thing");
  });

  it("the owner's book is not kept past a failure: it is not on the outage line, so stale would be unsaid", () => {
    const book = ok({ source: "sqlite", agent: { name: "Shogun", slug: "shogun" }, equity: [{ equity_usdg: 20 }] });
    const good = withRead(seedSources(), "feed", book, false);
    assert.equal(liveOf(good).mine?.equity, 20);
    const after = withRead(good, "feed", failed, false);
    assert.equal(liveOf(after).reads.mine, "unreadable");
    assert.equal(liveOf(after).mine, null);
  });
});

describe("the screen, derived from every read's latest answer", () => {
  it("a feed answer arriving alone reaches the token rows that count it — no other read has to land", () => {
    const s = withRead(withRead(seedSources(), "market", market(400), true), "theses", theses([buy]), true);
    const tsla = liveOf(s).tokens.find((t) => t.id === TSLA)!;
    assert.equal(tsla.buys, 1);
    assert.deepEqual(tsla.cast.map((c) => c.slug), ["shogun"]);
    assert.equal(liveOf(s).reads.discoveries, "unread", "the sweep is still out, and says so");
  });

  it("a quote is kept, per token, until a newer quote for that token replaces it", () => {
    const q = (price: number, at: number) => new Map([[TSLA, { priceUsd: price, priceUpdatedAt: at, uiMultiplier: 1 }]]);
    let s = withQuotes(withRead(seedSources(), "market", market(400), true), q(401, 10));
    assert.equal(liveOf(s).tokens.find((t) => t.id === TSLA)!.priceUsd, 401);
    s = withRead(s, "market", market(399), true);
    assert.equal(liveOf(s).tokens.find((t) => t.id === TSLA)!.priceUsd, 401, "a market answer does not wipe the quote");
    assert.equal(withQuotes(s, new Map()), s, "the venue refusing leaves the last quote, dated as it was");
    assert.equal(withQuotes(s, q(401, 10)), s, "and an unchanged quote changes nothing");
    s = withQuotes(s, q(402, 20));
    assert.equal(liveOf(s).tokens.find((t) => t.id === TSLA)!.priceUsd, 402);
    assert.equal(liveOf(s).tokens.find((t) => t.id === TSLA)!.priceUpdatedAt, 20);
  });

  it("a token the venue did not quote this time keeps its last quote rather than losing its price", () => {
    const USAR = "0xd917b029c761d264c6a312bbbcda868658ef86a6";
    const quote = (priceUsd: number) => ({ priceUsd, priceUpdatedAt: 1, uiMultiplier: 1 });
    let s = withQuotes(seedSources(), new Map([[TSLA, quote(401)], [USAR, quote(7)]]));
    s = withQuotes(s, new Map([[TSLA, quote(402)]]));
    assert.equal(liveOf(s).tokens.find((t) => t.id === USAR)!.priceUsd, 7);
    assert.equal(liveOf(s).tokens.find((t) => t.id === TSLA)!.priceUsd, 402);
  });

  it("a session change lands on the stock it was read for, and an unread one stays null", () => {
    let s = withRead(seedSources(), "market", market(400), true);
    assert.equal(liveOf(s).tokens.find((t) => t.id === TSLA)!.change24hPct, null);
    s = withChanges(s, new Map([[TSLA, -1.5]]));
    assert.equal(liveOf(s).tokens.find((t) => t.id === TSLA)!.change24hPct, -1.5);
    assert.equal(withChanges(s, new Map([[TSLA, -1.5]])), s);
  });

  it("the market answer alone names the stocks the session-change read needs", () => {
    assert.ok(marketTokensOf(market(400)).some((t) => t.id === TSLA && t.priceUsd === 400));
    assert.ok(marketTokensOf(failed).length > 0, "the registry seed still lists them when the market failed");
  });
});
