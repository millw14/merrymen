import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderWhy, type Why } from "./reasons";

/**
 * These strings go on a PUBLIC page, under an agent's name, next to somebody's
 * money. They are the only prose a deterministic strategy ever publishes, and
 * `renderWhy` is the only function allowed to produce them — which is what makes
 * "is this safe to publish?" a question about types rather than about vigilance.
 *
 * So the tests here are about the two things that would embarrass us: a sentence
 * that reads badly, and a sentence that claims something the strategy cannot
 * actually know.
 */

const ALL: Why[] = [
  { code: "dca-leg", symbol: "NVDA", usdgRaw: 16_660_000n, weightBps: 3_333, legs: 3 },
  { code: "park", usdgRaw: 24_100_000n, floorRaw: 50_000_000n, clamped: false },
  { code: "park", usdgRaw: 24_100_000n, floorRaw: 50_000_000n, clamped: true },
  { code: "unpark", usdgRaw: 66_000_000n, needRaw: 66_000_000n },
  { code: "gap-enter", symbol: "AAPL", usdgRaw: 33_330_000n },
  { code: "gap-exit", symbol: "AAPL" },
  { code: "keel-seed", usdgRaw: 20_000_000n, legs: 3 },
  { code: "keel-trim", symbol: "TSLA", overRaw: 12_400_000n },
  { code: "keel-top", symbol: "PLTR", underRaw: 9_800_000n },
  { code: "dip", symbol: "NVDA", dipBps: 240, priced: 3, usdgRaw: 25_000_000n },
  { code: "trench-enter", symbol: "WIF", liqUsd: 41_000, fdvUsd: 820_000, ageSec: 2_820, usdgRaw: 5_000_000n },
  { code: "trench-exit", symbol: "WIF", cause: "drain", pct: 62 },
  { code: "trench-exit", symbol: "WIF", cause: "stop", pct: -31.4 },
  { code: "trench-exit", symbol: "WIF", cause: "take", pct: 48.2 },
  { code: "trench-exit", symbol: "WIF", cause: "aged" },
  { code: "trench-exit", symbol: "WIF", cause: "unpriceable" },
];

describe("every reason is publishable prose", () => {
  it("renders a real sentence for every case", () => {
    for (const w of ALL) {
      const s = renderWhy(w);
      assert.ok(s.length > 20, `too short for ${w.code}: ${s}`);
      assert.ok(s.length < 220, `over the /why truncation point for ${w.code}: ${s.length}`);
      assert.doesNotMatch(s, /undefined|NaN|\[object/, `leaked a value in ${w.code}: ${s}`);
    }
  });

  it("never promises anything", () => {
    // The strategy proposes trades. It does not know whether one filled, at what
    // price, or what happened next — so it must not say. This is the same rule
    // the scoreboard applies to P&L: do not publish what you cannot back.
    for (const w of ALL) {
      const s = renderWhy(w);
      // Whole words on BOTH sides: a loose \bwin matched "window" in "held past
      // the window I give a launch", which promises nothing at all.
      assert.doesNotMatch(
        s,
        /\b(?:profits?|gains?|wins?|will|should|expects?|guarantee[ds]?)\b/i,
        `a claim in ${w.code}: ${s}`,
      );
      assert.doesNotMatch(s, /!/, `an exclamation in ${w.code}: ${s}`);
    }
  });

  it("formats money the way every other surface does", () => {
    // 6dp raw in, two decimals out. Getting this wrong publishes a number that
    // is a million times off and looks entirely plausible.
    assert.match(renderWhy(ALL[0]!), /16\.66 USDG into NVDA/);
    assert.match(renderWhy({ code: "keel-seed", usdgRaw: 1_234_567_890n, legs: 2 }), /1,234\.56 USDG/);
    assert.match(renderWhy({ code: "keel-trim", symbol: "X", overRaw: 5_000_000n }), /5\.00 USDG/);
  });

  it("trims percentages instead of printing 33.0%", () => {
    assert.match(renderWhy(ALL[0]!), /33% of a 3-leg basket/);
    assert.match(renderWhy(ALL[9]!), /2\.4% off its rolling high/);
  });

  it("says something DIFFERENT when the budget clamped the sweep", () => {
    // Otherwise the agent claims it parked the idle cash when it parked part of
    // it, and the balance the reader sees will not match the sentence.
    const plain = renderWhy(ALL[1]!);
    const clamped = renderWhy(ALL[2]!);
    assert.notEqual(plain, clamped);
    assert.match(clamped, /what today's budget still allows/);
  });

  it("an exit says WHY it left, and each cause reads differently", () => {
    // The exit rule writes its own sentence for the owner's notes. The public
    // one is rendered from the CODE instead, so no string crosses the boundary —
    // and if two causes rendered the same, that distinction would be lost.
    const said = new Set(
      (["drain", "stop", "take", "aged", "unpriceable"] as const).map((cause) =>
        renderWhy({ code: "trench-exit", symbol: "WIF", cause, pct: 12 }),
      ),
    );
    assert.equal(said.size, 5, "every exit cause needs its own sentence");
  });

  it("an exit with no percentage still reads as a sentence", () => {
    // `pct` is absent for the aged and unpriceable causes, and a bare
    // "undefined%" is the classic way that leaks onto a page.
    for (const cause of ["aged", "unpriceable"] as const) {
      const s = renderWhy({ code: "trench-exit", symbol: "WIF", cause });
      assert.doesNotMatch(s, /undefined|NaN|%/, s);
    }
  });

  it("the gap exit makes no claim about what it made", () => {
    // The tempting sentence here is "...locking in the gap", which the strategy
    // has no way to know. It knows the feed came back; that is all.
    const s = renderWhy({ code: "gap-exit", symbol: "AAPL" });
    assert.match(s, /the market reopened/);
    assert.doesNotMatch(s, /lock|captur|profit|made/i);
  });
});

/**
 * THE SENTENCE THAT SAID THE OPPOSITE OF THE TRUTH, TWO DAYS IN SEVEN.
 *
 * `all-legs-stale` closed with "This is a fact about the feeds, not about the
 * market." It was written for the case where our own reads failed, and then
 * became the only sentence for both causes. Stock feeds are 24/5, so on any
 * weekend — and on any weekday after 20:00 UTC — the stale feed IS the market
 * being shut, and the agent told its owner otherwise.
 */
describe("a stale feed says WHICH kind of stale it is", () => {
  it("a closed market is named as a closed market", () => {
    const text = renderWhy({ code: "all-legs-stale", legs: 3, paused: 0, marketShut: true });
    assert.match(text, /market is closed/i);
    assert.ok(
      !/not about the market/.test(text),
      "on a Saturday this clause is exactly backwards",
    );
  });

  it("and it tells the owner it clears itself, because that is the remedy", () => {
    const text = renderWhy({ code: "all-legs-stale", legs: 3, paused: 0, marketShut: true });
    assert.match(text, /reopens/);
  });

  it("an OPEN market with stale feeds points at us, not at the schedule", () => {
    const text = renderWhy({ code: "all-legs-stale", legs: 3, paused: 0, marketShut: false });
    assert.match(text, /our own read path/);
    assert.ok(!/market is closed/i.test(text));
  });

  it("an unestablished flag keeps the old wording rather than inventing a claim", () => {
    // A fixture that never worked it out must not have an answer made up for it.
    const text = renderWhy({ code: "all-legs-stale", legs: 3, paused: 0 });
    assert.match(text, /not about the market/);
  });

  it("the paused clause still renders alongside either branch", () => {
    for (const marketShut of [true, false]) {
      const text = renderWhy({ code: "all-legs-stale", legs: 3, paused: 2, marketShut });
      assert.match(text, /2 of them are paused/);
    }
  });
});
