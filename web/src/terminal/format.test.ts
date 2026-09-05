/**
 * THE TERMINAL'S NUMBERS, AND THE ONE RULE THEY ALL SHARE.
 *
 * 29,000 lines of new interface arrived with no tests. These are the pure
 * functions underneath it — the ones that turn a number, or the absence of one,
 * into what a person reads. They are where this product's defining property
 * lives or dies, because the property is not "the maths is right", it is:
 *
 *     A BALANCE OF ZERO AND A FIGURE WE COULD NOT FETCH ARE DIFFERENT FACTS
 *     AND MUST NEVER RENDER THE SAME.
 *
 * "$0.00" is a statement about an account. "—" is a statement about us. A
 * formatter that turns null into 0 erases the second and replaces it with a
 * confident version of the first, and nothing downstream can recover the
 * difference — which is why it is tested here, at the only place it is still
 * visible.
 *
 * The colour rule is the same rule wearing different clothes, and it is the one
 * that actually shipped broken: every change column read
 * `(n ?? 0) < 0 ? "down" : "up"`, so a change we could not read printed "—" in
 * text and green in colour. On a table of twenty-five tokens colour is what a
 * reader takes in first, and green is a claim.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validAmount } from "./amount";
import { barInterval, withGaps } from "./bars";
import { dailyChange, spentToday } from "./account";
import { elapsed, countdown } from "./clock";
import {
  ageOf,
  coinPrice,
  compactUsd,
  deltaClass,
  money,
  pctBps,
  pctPts,
  quoteTitle,
  seedLive,
  sizeOf,
  thesesForSymbol,
  tokenById,
  type LiveMine,
  type LiveToken,
  type Thesis,
} from "./live";
import { isStrategyId, parseStrategy, strategyLabel, strategyName } from "./strategy";

const token = (over: Partial<LiveToken> = {}): LiveToken =>
  ({
    id: "0xabc",
    symbol: "TSLA",
    name: "Tesla",
    logo: null,
    priceUsd: 100,
    change24hPct: 1,
    fdvUsd: null,
    holders: null,
    agents: 0,
    buys: 0,
    kind: "stock",
    marks: [],
    cast: [],
    ...over,
  }) as LiveToken;

const thesis = (over: Partial<Thesis> = {}): Thesis =>
  ({ slug: "s", name: "n", action: "buy", symbol: "TSLA", ...over }) as Thesis;

describe("a figure we do not have is never a figure of zero", () => {
  it("money", () => {
    assert.equal(money(0), "$0.00", "a real zero balance is a real zero balance");
    assert.equal(money(null), "—", "and an unknown one is not");
    assert.equal(money(Number.NaN), "—");
    assert.equal(money(Number.POSITIVE_INFINITY), "—");
    assert.equal(money(1234.5), "$1,234.50");
  });

  it("pctPts", () => {
    assert.equal(pctPts(0), "0.00%", "flat is a measurement");
    assert.equal(pctPts(null), "—", "unmeasured is not");
    assert.equal(pctPts(Number.NaN), "—");
    assert.equal(pctPts(2.5), "+2.50%");
    assert.equal(pctPts(-2.5), "-2.50%");
  });

  it("pctBps", () => {
    assert.equal(pctBps(null), "—");
    assert.equal(pctBps(0), "0.0%");
    assert.equal(pctBps(1234), "+12.3%");
    assert.equal(pctBps(-1234), "−2.3%".replace("2.3", "12.3"));
  });

  it("coinPrice and compactUsd", () => {
    assert.equal(coinPrice(null), "—");
    assert.equal(compactUsd(null), "—");
    assert.equal(compactUsd(0), "$0", "a token with no float has none; that is a number");
  });
});

describe("colour never claims a direction we did not measure", () => {
  it("REGRESSION: an unknown change is flat, not green", () => {
    // This is the bug that shipped. `(n ?? 0) < 0 ? "down" : "up"` made every
    // unreadable change render in the up colour beside a "—".
    assert.equal(deltaClass(null), "flat");
    assert.equal(deltaClass(undefined), "flat");
    assert.equal(deltaClass(Number.NaN), "flat");
  });

  it("a measured zero is still up-coloured, because zero is a measurement", () => {
    assert.equal(deltaClass(0), "up");
    assert.equal(deltaClass(0.01), "up");
    assert.equal(deltaClass(-0.01), "down");
  });
});

describe("the seed list is the real universe with the numbers left out", () => {
  it("seeds from the canonical token registry, not from invented rows", () => {
    const seeded = seedLive();
    assert.ok(seeded.tokens.length > 10, "the listed universe is seeded so the shell has a market list");
    assert.deepEqual(seeded.agents, [], "but nobody is invented");
    assert.deepEqual(seeded.theses, [], "and nothing is quoted");
    assert.equal(seeded.mine, null);
  });

  it("every price-shaped field on a seeded token is null, never zero", () => {
    // A seeded row exists so the shell can render a market list before the
    // fetch returns. Every number on it is unknown at that moment, and a zero
    // would be a figure this app is asserting about a real listed instrument.
    for (const t of seedLive().tokens) {
      for (const field of ["priceUsd", "change24hPct", "fdvUsd", "holders"] as const) {
        assert.equal(t[field], null, `${t.symbol}.${field} must be null before it is known`);
      }
    }
  });

  it("REGRESSION: participation counts are unknown before the ledger answers", () => {
    // `agents` and `buys` shipped as literal 0 on the seed while their
    // neighbours were null, so an unloaded market table stated "0 agents hold
    // this" for all twenty-five listed tokens — and then stated exactly the same
    // thing once the ledger came back and the real answer was zero. Two
    // different facts, one rendering.
    for (const t of seedLive().tokens) {
      assert.equal(t.agents, null, `${t.symbol}.agents must not claim zero before the ledger is read`);
      assert.equal(t.buys, null, `${t.symbol}.buys must not claim zero before the ledger is read`);
    }
  });
});

describe("looking things up", () => {
  it("tokenById is case-insensitive on the address", () => {
    const list = [token({ id: "0xaabb" })];
    assert.ok(tokenById(list, "0xAABB"));
    assert.equal(tokenById(list, "0xdead"), undefined);
  });

  it("thesesForSymbol does not match a different name", () => {
    const list = [thesis({ symbol: "TSLA" }), thesis({ symbol: "NVDA" })];
    assert.equal(thesesForSymbol(list, "tsla").length, 1);
    assert.equal(thesesForSymbol(list, "AAPL").length, 0);
  });

  it("quoteTitle attributes the price to its source, or says nothing", () => {
    assert.equal(quoteTitle(token({ priceSource: "chainlink" } as Partial<LiveToken>)), undefined);
    const titled = quoteTitle(token({ priceSource: "robinhood", priceUpdatedAt: 1_788_000_000 } as Partial<LiveToken>));
    assert.ok(titled && titled.includes("Robinhood"), "a price from a venue says which venue");
  });
});

describe("sizes and ages", () => {
  it("sizeOf prefers the field and falls back to the published head", () => {
    assert.equal(sizeOf(thesis({ sizeUsdg: 5 })), 5);
    assert.equal(sizeOf(thesis({ sizeUsdg: null, head: "would buy TSLA 12.50 USDG" })), 12.5);
    assert.equal(sizeOf(thesis({ sizeUsdg: null, head: "held TSLA" })), null, "no size is null, not zero");
  });

  it("ageOf takes seconds or milliseconds and never renders a negative age", () => {
    const now = 1_788_600_000_000;
    assert.equal(ageOf(thesis({ at: now / 1000 - 90 }), now), "2m");
    assert.equal(ageOf(thesis({ at: now + 60_000 }), now), "0s", "a future stamp is not a negative age");
    assert.equal(ageOf(thesis({ at: undefined, said: undefined }), now), "", "no stamp says nothing at all");
  });

  it("elapsed steps through its units without skipping one", () => {
    const now = 1_000_000_000_000;
    assert.equal(elapsed(now, now).text, "0s");
    assert.equal(elapsed(now - 59_000, now).text, "59s");
    assert.equal(elapsed(now - 60_000, now).text, "1m");
    assert.equal(elapsed(now - 3_600_000, now).text, "1h");
    assert.equal(elapsed(now - 48 * 3_600_000, now).text, "2d");
    assert.equal(elapsed(now + 5_000, now).text, "0s", "a clock skew is not a negative age");
  });

  it("countdown pads and never goes below zero", () => {
    assert.equal(countdown(0).text, "00:00");
    assert.equal(countdown(-5_000).text, "00:00");
    assert.equal(countdown(61_000).text, "01:01");
    assert.equal(countdown(3_661_000).text, "1:01:01");
  });
});

describe("what the owner is allowed to type into a money field", () => {
  it("takes a plain positive amount with at most two decimals", () => {
    for (const good of ["1", "0.5", "12.34", "1000"]) assert.ok(validAmount(good), good);
  });

  it("refuses everything that is not one", () => {
    for (const bad of ["", "0", "-1", "1.234", "1e3", " 1", "1 ", "abc", "1.2.3", ".5", "+1", "Infinity", "NaN"]) {
      assert.equal(validAmount(bad), false, `"${bad}" must be refused`);
    }
  });
});

describe("the book's own figures", () => {
  const mine = (over: Partial<LiveMine> = {}): LiveMine =>
    ({ equity: 1000, chg24: 10, moves: [], glance: { id: "custom", label: "Strategy" }, ...over }) as LiveMine;

  it("dailyChange refuses to divide by a book that did not exist", () => {
    assert.equal(dailyChange(mine({ equity: null })), null);
    assert.equal(dailyChange(mine({ chg24: null })), null);
    assert.equal(dailyChange(mine({ equity: 10, chg24: 10 })), null, "a book that started at zero has no percentage");
    const pct = dailyChange(mine({ equity: 110, chg24: 10 }));
    assert.ok(pct !== null && Math.abs(pct - 10) < 1e-9);
  });

  it("spentToday counts only today's landed buys and sells", () => {
    const now = Date.UTC(2026, 8, 5, 12, 0, 0);
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const t = (offsetSec: number) => Math.floor(midnight.getTime() / 1000) + offsetSec;
    const moves = [
      { action: "buy", outcome: "landed", at: t(60), sizeUsdg: 10 },
      { action: "sell", outcome: "landed", at: t(120), sizeUsdg: 5 },
      { action: "buy", outcome: "refused", at: t(180), sizeUsdg: 100 },
      { action: "hold", outcome: "landed", at: t(240), sizeUsdg: 100 },
      { action: "buy", outcome: "landed", at: t(-3600), sizeUsdg: 100 },
      { action: "buy", outcome: "landed", at: Math.floor(now / 1000) + 3600, sizeUsdg: 100 },
    ];
    assert.equal(spentToday(mine({ moves: moves as LiveMine["moves"] }), now), 15);
  });

  it("a refused trade spent nothing, and must not count against the day", () => {
    const now = Date.UTC(2026, 8, 5, 12, 0, 0);
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const moves = [
      { action: "buy", outcome: "refused", at: Math.floor(midnight.getTime() / 1000) + 60, sizeUsdg: 999 },
    ];
    assert.equal(spentToday(mine({ moves: moves as LiveMine["moves"] }), now), 0);
  });
});

describe("strategy identity survives a round trip", () => {
  it("parseStrategy only accepts the ids the worker actually runs", () => {
    assert.equal(parseStrategy("steady-basket"), "steady-basket");
    assert.equal(parseStrategy("not-a-strategy"), "custom", "an unknown rulebook is custom, not a guess");
    assert.equal(parseStrategy(null), "custom");
    assert.equal(parseStrategy(undefined), "custom");
  });

  it("isStrategyId is a guard and not a vibe", () => {
    assert.ok(isStrategyId("trencher"));
    assert.equal(isStrategyId("Trencher"), false);
    assert.equal(isStrategyId(""), false);
    assert.equal(isStrategyId(null), false);
  });

  it("every id has a name and a label, so no screen can render an id", () => {
    for (const id of ["steady-basket", "weekend-gap", "even-keel", "dip-hunter", "trencher", "llm-strategist", "custom"] as const) {
      assert.ok(strategyName(id).length > 0, id);
      assert.ok(strategyLabel(id).length > 0, id);
      assert.ok(!strategyLabel(id).includes("-"), `${id} label still reads like an id`);
    }
  });
});

describe("the chart leaves holes as holes", () => {
  const bar = (time: number, close = 100) => ({ time, open: close, high: close, low: close, close });

  it("finds the usual spacing from the median, not the mean", () => {
    // One long weekend must not set the interval for the whole series.
    const bars = [bar(0), bar(300), bar(600), bar(900), bar(900 + 250_000)];
    assert.equal(barInterval(bars), 300);
    assert.equal(barInterval([bar(0)]), 0, "one bar has no spacing");
    assert.equal(barInterval([]), 0);
  });

  it("REGRESSION: a hole is padded with blank slots, not drawn across", () => {
    // lightweight-charts places bars at CONSECUTIVE slots, so an unpadded
    // series renders a 63-hour hole as zero horizontal distance and draws a
    // straight line through prices that never existed. CandleChart calls this
    // "THE LARGEST HONESTY DEFECT IN THE FIRST VERSION"; the terminal's chart
    // reintroduced it by calling setData on the raw bars.
    const { data, truncated } = withGaps([bar(0), bar(300), bar(1_500)]);
    assert.equal(truncated, false);
    assert.deepEqual(
      data.map((d) => d.time),
      [0, 300, 600, 900, 1200, 1500],
      "the missing slots are present and empty",
    );
    for (const slot of data.filter((d) => ![0, 300, 1500].includes(d.time))) {
      assert.equal(slot.close, undefined, "a padded slot carries no price");
    }
  });

  it("a contiguous series is returned untouched", () => {
    const bars = [bar(0), bar(300), bar(600)];
    const { data, truncated } = withGaps(bars);
    assert.equal(truncated, false);
    assert.deepEqual(data, bars);
  });

  it("one enormous hole is capped rather than swamping the real bars", () => {
    const { data, truncated } = withGaps([bar(0), bar(300), bar(300 + 300 * 5_000)]);
    assert.equal(truncated, true, "the cap is reported, not hidden");
    assert.ok(data.length <= 503, `padded to ${data.length} slots`);
  });

  it("a series too short to have an interval is left alone", () => {
    assert.deepEqual(withGaps([bar(0)]).data, [bar(0)]);
    assert.deepEqual(withGaps([]).data, []);
  });
});
