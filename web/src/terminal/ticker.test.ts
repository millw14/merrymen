/**
 * THE TAPE, FROM WHAT THE SHELL ALREADY READ.
 *
 * components/shell/Ticker.tsx was built, fetched /api/market and /api/wall-tape
 * on its own minute, and was mounted by nothing. The terminal already reads the
 * market every thirty seconds, so its tape is drawn from that read: no request
 * of its own, and it moves when the market read moves.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { liveOf, seedSources, withQuotes, withRead, type LiveToken } from "./live";
import { ticksOf } from "./ticker";

const NOW = 1_800_000_000;
const TSLA = "0x322f0929c4625ed5bad873c95208d54e1c003b2d";
const tok = (over: Partial<LiveToken>): LiveToken => ({
  id: "0x1",
  symbol: "X",
  name: "X",
  logo: "",
  priceUsd: 1,
  change24hPct: null,
  fdvUsd: null,
  holders: null,
  agents: null,
  buys: null,
  kind: "stock",
  marks: [],
  cast: [],
  ...over,
});

describe("the tape", () => {
  it("lists only what has a price, and at most fourteen", () => {
    const tokens = [tok({ id: "a", priceUsd: null }), ...Array.from({ length: 20 }, (_, i) => tok({ id: `p${i}`, priceUsd: i + 1 }))];
    const ticks = ticksOf(tokens, NOW);
    assert.equal(ticks.length, 14);
    assert.ok(!ticks.some((t) => t.id === "a"), "an unpriced token has nothing to put on a tape");
  });

  it("says halted only when the chain said so — an unread halt is not 'trading normally', nor a halt", () => {
    assert.equal(ticksOf([tok({ halted: true })], NOW)[0]!.halted, true);
    assert.equal(ticksOf([tok({ halted: null })], NOW)[0]!.halted, false);
    assert.equal(ticksOf([tok({})], NOW)[0]!.halted, false);
  });

  it("says stale when the price's own clock is over an hour old, and only when it has one", () => {
    assert.equal(ticksOf([tok({ feedUpdatedAt: NOW - 7200 })], NOW)[0]!.stale, true);
    assert.equal(ticksOf([tok({ feedUpdatedAt: NOW - 60 })], NOW)[0]!.stale, false);
    assert.equal(ticksOf([tok({})], NOW)[0]!.stale, false, "no clock, no claim");
    // What liveOf hands over when the market read had no feed time: null, which
    // arithmetic treats as zero — the epoch, and so "stale" on every row.
    assert.equal(ticksOf([tok({ feedUpdatedAt: null })], NOW)[0]!.stale, false, "an unread clock is not a clock at 1970");
    assert.equal(
      ticksOf([tok({ priceSource: "robinhood", priceUpdatedAt: NOW - 30, feedUpdatedAt: NOW - 7200 })], NOW)[0]!.stale,
      false,
      "a fresh quote is dated by the quote, not by the feed it replaced",
    );
  });

  it("is fed by the market read the shell already made", () => {
    const market = {
      text: JSON.stringify({
        tokens: [
          { symbol: "TSLA", name: "Tesla", kind: "stock", address: TSLA, logo: "", priceUsd: 400, holders: 3, paused: false, volume24hUsd: 12_000, priceUpdatedAt: NOW - 100 },
        ],
      }),
      answered: true,
    };
    let s = withRead(seedSources(), "market", market, true);
    const tsla = ticksOf(liveOf(s).tokens, NOW).find((t) => t.id === TSLA)!;
    assert.equal(tsla.priceUsd, 400);
    assert.equal(tsla.volume24hUsd, 12_000);
    assert.equal(tsla.halted, false);
    s = withQuotes(s, new Map([[TSLA, { priceUsd: 401, priceUpdatedAt: NOW, uiMultiplier: 1 }]]));
    assert.equal(ticksOf(liveOf(s).tokens, NOW).find((t) => t.id === TSLA)!.priceUsd, 401, "and moves with the quotes");
  });
});
