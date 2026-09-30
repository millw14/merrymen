import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { averageHoldSec, holdWords, openingOf, PAPER_DUST_RAW, type HoldFill } from "./hold-time";

const buy = (coin: string, qty: bigint, at: number, source: string | null = "receipt"): HoldFill => ({ side: "buy", coin, qty, at, source });
const sell = (coin: string, qty: bigint, at: number): HoldFill => ({ side: "sell", coin, qty, at, source: "receipt" });
/** Nothing carried into the period. */
const FLAT = new Map<string, bigint | null>();

describe("average hold is FIFO round trips, and nothing else", () => {
  it("a sell closes the OLDEST open buy of its coin first", () => {
    // Bought at 0 and at 100, sold one lot at 1,000: FIFO says the lot from 0
    // closed, so the hold is 1,000 — LIFO would say 900.
    assert.equal(averageHoldSec([buy("CASH", 5n, 0), buy("CASH", 5n, 100), sell("CASH", 5n, 1_000)], FLAT), 1_000);
  });

  it("a sell larger than one lot reaches into the next, each piece one round trip", () => {
    // 10 sold at 1,000 closes both lots: holds 1,000 and 900, mean 950.
    assert.equal(averageHoldSec([buy("CASH", 5n, 0), buy("CASH", 5n, 100), sell("CASH", 10n, 1_000)], FLAT), 950);
  });

  it("a partial sell leaves the rest of the lot open for the next sell", () => {
    // Lot of 10 at 0; sells of 4 at 100 and 6 at 300 — both close the same lot.
    assert.equal(averageHoldSec([buy("X", 10n, 0), sell("X", 4n, 100), sell("X", 6n, 300)], FLAT), 200);
  });

  it("coins are paired only with themselves, case-insensitively", () => {
    // Selling CHUMP must close the CHUMP lot from 100, not the older CASH lot.
    assert.equal(averageHoldSec([buy("CASH", 1n, 0), buy("chump", 1n, 100), sell("CHUMP", 1n, 150)], FLAT), 50);
    // CHUMP 100, CASH 400.
    assert.equal(averageHoldSec([buy("CASH", 1n, 0), buy("chump", 1n, 50), sell("CHUMP", 1n, 150), sell("cash", 1n, 400)], FLAT), 250);
  });

  it("quantity decides which lots close, but never WEIGHTS the mean", () => {
    // Raw units across coins with different decimals are not comparable, so a
    // huge-unit memecoin must not drown a small-unit stock token.
    const meme = 10n ** 27n;
    assert.equal(averageHoldSec([buy("MEME", meme, 0), sell("MEME", meme, 100), buy("TSLA", 1n, 0), sell("TSLA", 1n, 900)], FLAT), 500);
  });

  it("no round trip is null, not zero", () => {
    assert.equal(averageHoldSec([], FLAT), null);
    assert.equal(averageHoldSec([buy("X", 1n, 0), buy("Y", 1n, 5)], FLAT), null, "buys alone never closed");
  });

  it("a sell beyond everything open is left out, never paired with a later buy", () => {
    assert.equal(averageHoldSec([sell("OLD", 5n, 10)], FLAT), null);
    assert.equal(averageHoldSec([sell("OLD", 5n, 10), buy("X", 1n, 0), sell("X", 1n, 60)], FLAT), 60);
  });

  it("ANY unread input is a refusal, because FIFO is order-dependent", () => {
    const whole = [buy("X", 1n, 0), sell("X", 1n, 60)];
    assert.equal(averageHoldSec(whole, FLAT), 60);
    assert.equal(averageHoldSec([...whole, { side: null, coin: "X", qty: 1n, at: 70 }], FLAT), null, "unknown side");
    assert.equal(averageHoldSec([...whole, { side: "sell", coin: null, qty: 1n, at: 70 }], FLAT), null, "unknown coin");
    assert.equal(averageHoldSec([...whole, { side: "buy", coin: "X", qty: null, at: 70 }], FLAT), null, "unknown quantity");
    assert.equal(averageHoldSec([...whole, { side: "buy", coin: "X", qty: 0n, at: 70 }], FLAT), null, "a zero fill is not a fill");
  });
});

describe("a position carried into the period is sold first, and is no round trip", () => {
  // PF2: an agent carrying 1,000 TSLA buys 10 and trims 10 a minute later.
  // FIFO with no opening lots paired the trim with the minute-old buy and
  // printed "avg hold 1m", where the trim closed units held for weeks.
  const carried = new Map<string, bigint | null>([["tsla", 1_000n]]);

  it("a trim of a carried position closes carried units, not the buy beside it", () => {
    assert.equal(averageHoldSec([buy("TSLA", 10n, 0), sell("TSLA", 10n, 60)], carried), null);
    assert.equal(averageHoldSec([buy("TSLA", 10n, 0), sell("TSLA", 500n, 60)], carried), null, "any sell the carried units cover");
    // Selling everything closes the carried 1,000 AND the 10 bought at 0 — and
    // those 10 were bought and sold inside the period: one round trip of 60s.
    assert.equal(averageHoldSec([buy("TSLA", 10n, 0), sell("TSLA", 1_010n, 60)], carried), 60);
  });

  it("a sell that reaches past the carried units closes the period's buys in order", () => {
    // 1,005 sold at 60: the carried 1,000 first (no pair), then 5 of the lot from 0.
    assert.equal(averageHoldSec([buy("TSLA", 10n, 0), sell("TSLA", 1_005n, 60)], carried), 60);
    // A coin nothing was carried of pairs exactly as before.
    assert.equal(averageHoldSec([buy("TSLA", 10n, 0), sell("TSLA", 10n, 60), buy("CASH", 1n, 0), sell("CASH", 1n, 300)], carried), 300);
  });

  it("an opening that could not be read refuses the hold for any coin the period sold", () => {
    const unknown = new Map<string, bigint | null>([["tsla", null]]);
    assert.equal(averageHoldSec([buy("TSLA", 10n, 0), sell("TSLA", 10n, 60)], unknown), null);
    // Only bought: whatever was carried closed nothing this period.
    assert.equal(averageHoldSec([buy("TSLA", 10n, 0), buy("CASH", 1n, 0), sell("CASH", 1n, 300)], unknown), 300);
    assert.equal(averageHoldSec([buy("CASH", 1n, 0), sell("CASH", 1n, 300)], null), null, "nothing known about what was carried");
    // Sold before anything was bought this period: still a sell of an unknown opening.
    assert.equal(averageHoldSec([buy("CASH", 1n, 0), sell("CASH", 1n, 300), sell("TSLA", 10n, 400)], unknown), null);
  });
});

describe("paper dust is not a position", () => {
  // paper.ts keeps a paper holding's share count to six decimals after every
  // sell, so its fills and its book drift by up to half a millionth of a share
  // per sell. A leftover of that size is not a lot to pair a later sell with.
  const ONE = 10n ** 18n;
  const drift = 5n * 10n ** 11n;

  it("a lot left with only rounding in it is closed, not paired months later", () => {
    const fills = [buy("TSLA", ONE, 0), sell("TSLA", ONE - drift, 100), buy("TSLA", ONE, 200), sell("TSLA", ONE, 300)];
    assert.equal(averageHoldSec(fills, FLAT, PAPER_DUST_RAW), 100);
    assert.equal(averageHoldSec(fills, FLAT, 0n), 500 / 3, "exact books keep every unit");
  });

  it("a sell no bigger than the rounding is not a round trip", () => {
    // paper.ts sells min(wanted, held): a leftover sold on its own is rounding.
    const fills = [buy("TSLA", ONE, 0), sell("TSLA", drift, 50), sell("TSLA", ONE - drift, 100)];
    assert.equal(averageHoldSec(fills, FLAT, PAPER_DUST_RAW), 100);
  });
});

describe("what was carried into the period, from the fills before it", () => {
  const complete = { complete: true, dust: 0n };

  it("a position still held is carried; one sold out is not", () => {
    assert.deepEqual(openingOf([buy("TSLA", 1_000n, 0), buy("CASH", 5n, 1), sell("CASH", 5n, 2)], complete), new Map([["tsla", 1_000n], ["cash", 0n]]));
  });

  it("an ESTIMATED quantity cannot be carried: it could close the wrong lots", () => {
    // A buy booked from the quote (or before basis_source existed) recorded the
    // slippage floor, not what arrived.
    assert.deepEqual(openingOf([buy("TSLA", 1_000n, 0, "quote")], complete), new Map([["tsla", null]]));
    assert.deepEqual(openingOf([buy("TSLA", 1_000n, 0, null)], complete), new Map([["tsla", null]]));
    // Sold out since, it is gone either way.
    assert.deepEqual(openingOf([buy("TSLA", 1_000n, 0, "quote"), sell("TSLA", 1_000n, 1)], complete), new Map([["tsla", 0n]]));
    // And what is bought after that flat point, from a receipt, is carried whole.
    assert.deepEqual(openingOf([buy("TSLA", 1_000n, 0, "quote"), sell("TSLA", 1_000n, 1), buy("TSLA", 5n, 2)], complete), new Map([["tsla", 5n]]));
  });

  it("an unread fill, a sell of more than was bought, or a cut read is unknown", () => {
    assert.deepEqual(openingOf([buy("TSLA", 10n, 0), { side: null, coin: "TSLA", qty: 1n, at: 1 }], complete), new Map([["tsla", null]]));
    assert.deepEqual(openingOf([buy("TSLA", 10n, 0), sell("TSLA", 11n, 1)], complete), new Map([["tsla", null]]), "something the tape never saw came in");
    assert.equal(openingOf([buy("TSLA", 10n, 0)], { complete: false, dust: 0n }), null);
    assert.equal(openingOf([{ side: "buy", coin: null, qty: 1n, at: 0 }], complete), null, "a fill of an unknown coin could be any coin's");
  });

  it("a paper position sold to its rounding is flat", () => {
    const ONE = 10n ** 18n;
    assert.deepEqual(openingOf([buy("TSLA", ONE, 0, "paper"), sell("TSLA", ONE - 5n * 10n ** 11n, 1)], { complete: true, dust: PAPER_DUST_RAW }), new Map([["tsla", 0n]]));
  });
});

describe("a hold in words", () => {
  it("uses the two largest units, and nothing for nothing", () => {
    assert.equal(holdWords(45), "45s");
    assert.equal(holdWords(12 * 60), "12m");
    assert.equal(holdWords(3 * 3600 + 20 * 60), "3h 20m");
    assert.equal(holdWords(3 * 3600), "3h");
    assert.equal(holdWords(2 * 86_400 + 4 * 3600), "2d 4h");
    assert.equal(holdWords(null), null);
    assert.equal(holdWords(Number.NaN), null);
  });
});
