import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishesIdle, renderWhy, type Why } from "./reasons";

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
  { code: "ops-spent" },
  { code: "breaker-tripped", limitBps: 1_000 },
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

/**
 * PERPETUALS (docs/perps.md). Never published in v1 — but the sentence is
 * written before anyone knows who reads it back, so both registers are held to
 * the file's rules anyway, on the LONGEST market key the frozen table has.
 */
describe("the perp reasons", () => {
  const M = "ANTHROPIC-PERP" as const;
  const PERP: Why[] = [
    { code: "perp-open", market: M, side: "long", leverage: 2, stopPct: 5 },
    { code: "perp-open", market: M, side: "short", leverage: 3.33, stopPct: 1.5 },
    ...(["trend", "aged", "funding", "market", "session", "owner", "venue-take"] as const).map(
      (cause): Why => ({ code: "perp-exit", market: M, side: "short", cause }),
    ),
    ...(
      [
        "venue-stop",
        "stop-breached",
        "stop-missing",
        "liq-proximity",
        "liq-inside-stop",
        "funding-bleed",
        "market-status",
        "unknown-activity",
        "stand-down",
        "kill",
        "expiry",
      ] as const
    ).map((cause): Why => ({ code: "perp-risk-exit", market: M, side: "long", cause })),
    { code: "perp-signal-unread", market: null },
    { code: "perp-signal-unread", market: M },
    { code: "perp-no-signal", markets: 3 },
    { code: "perp-market-not-covered", market: M },
    { code: "perp-too-volatile", market: M, stopPct: 12.5, maxStopPct: 25 },
    { code: "perp-below-min", market: M, minRaw: 123_456_789_000n, capRaw: 100_000_000_000n },
    { code: "perp-cooldown", market: M, hours: 24, after: "forced" },
    { code: "perp-funding-against", market: M, side: "short" },
    { code: "perp-max-positions", max: 5 },
    { code: "perp-order-unresolved", market: M },
    { code: "perp-grant-expiring", withinHours: 168 },
  ];

  it("every sentence, both registers, is under the /why truncation point and reads as prose", () => {
    for (const w of PERP) {
      for (const who of ["owner", "public"] as const) {
        const s = renderWhy(w, who);
        assert.ok(s.length > 20 && s.length < 220, `${w.code} (${who}) is ${s.length}: ${s}`);
        assert.doesNotMatch(s, /undefined|NaN|\[object|\?x|\?%|\s{2}/, `${w.code} (${who}): ${s}`);
      }
    }
  });

  it("never promises anything — no profit, gain, win, will, should, expect", () => {
    for (const w of PERP) {
      for (const who of ["owner", "public"] as const) {
        const s = renderWhy(w, who);
        assert.doesNotMatch(s, /\b(?:profits?|gains?|wins?|will|should|expects?|guarantee[ds]?)\b/i, `${w.code}: ${s}`);
        assert.doesNotMatch(s, /!/, `${w.code}: ${s}`);
      }
    }
  });

  it("THE PUBLIC REGISTER NAMES NO SIZE, NO LEVERAGE AND NO SIDE — only the market and the owner's own percentages", () => {
    for (const w of PERP) {
      const pub = renderWhy(w, "public");
      assert.doesNotMatch(pub, /\d(?:\.\d+)?\s*[x×]\b/, `${w.code} published a leverage: ${pub}`);
      assert.doesNotMatch(pub, /\b(?:long|short)\b/i, `${w.code} published the side: ${pub}`);
      assert.doesNotMatch(pub, /USDG|\d[\d,]*\.\d{2}\b/, `${w.code} published a figure of the book: ${pub}`);
      if ("market" in w && w.market) assert.ok(pub.includes(w.market), `${w.code} lost its market: ${pub}`);
    }
  });

  it("the owner is told the leverage and the side", () => {
    const own = renderWhy({ code: "perp-open", market: "BTC-PERP", side: "short", leverage: 3.33, stopPct: 1.5 });
    assert.match(own, /short on BTC-PERP at 3\.33x/);
    assert.match(own, /1\.5%/);
  });

  it("a risk exit and a view changing do not read the same", () => {
    const risk = renderWhy({ code: "perp-risk-exit", market: "BTC-PERP", side: "long", cause: "venue-stop" });
    const view = renderWhy({ code: "perp-exit", market: "BTC-PERP", side: "long", cause: "trend" });
    assert.notEqual(risk, view);
    assert.match(risk, /rule, not a view/i);
  });

  it("NO PERP REASON IS EVER A PUBLIC POST (rule 17) — publishesIdle is false for every perp code", () => {
    for (const w of PERP) assert.equal(publishesIdle(w), false, w.code);
    // …and the rest of the idle channel is untouched.
    assert.equal(publishesIdle({ code: "ops-spent" }), true);
    assert.equal(publishesIdle({ code: "breaker-tripped", limitBps: 1_000 }), false);
  });
});

