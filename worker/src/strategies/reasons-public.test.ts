/**
 * THE PUBLIC SENTENCE CARRIES NO FIGURE OF THE BOOK.
 *
 * A decision row's `reason` is written in the public register (index.ts) and
 * read back by every surface that publishes the row — the feed, the profile,
 * the peer files, /api/decision. Whose book is private is decided when it is
 * READ, so the sentence has to be safe for the book that shows least: a
 * private book publishes no size (thesis-policy.ts `sizeUsdg`), and a size, a
 * cost, the proceeds, the cash or the floor in the reason beside it is the
 * same dollars in a sentence. Measured: "selling all 4.40 USDG of it against
 * the 5.00 paid" was published beside a withheld realizedUsd, and was that
 * figure outright.
 *
 * Every code is here, typed so a new one fails to compile until it is placed,
 * each with figures nobody could print by accident.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderWhy, type Why } from "./reasons";

type Every = { [K in Why["code"]]: Extract<Why, { code: K }>[] };

/** Distinctive raw amounts, so a leak is found by its own digits. */
const A = 4_400_000n; // 4.40
const B = 5_170_000n; // 5.17
const C = 61_230_000n; // 61.23
const BIG = 1_234_567_890n; // 1,234.56

const EVERY: Every = {
  "dca-leg": [{ code: "dca-leg", symbol: "NVDA", usdgRaw: A, weightBps: 3_333, legs: 3 }],
  park: [
    { code: "park", usdgRaw: A, floorRaw: C, clamped: false },
    { code: "park", usdgRaw: BIG, floorRaw: C, clamped: true },
  ],
  unpark: [{ code: "unpark", usdgRaw: A, needRaw: B }],
  "all-legs-stale": [{ code: "all-legs-stale", legs: 3, paused: 1 }],
  "under-one-buy": [
    { code: "under-one-buy", cashRaw: A, needRaw: B, vaultRaw: C },
    { code: "under-one-buy", cashRaw: A, needRaw: B, vaultRaw: 0n },
  ],
  "budget-spent": [{ code: "budget-spent", capRaw: B }],
  "ops-spent": [{ code: "ops-spent" }],
  "breaker-tripped": [{ code: "breaker-tripped", limitBps: 1_000 }],
  "take-profit": [{ code: "take-profit", symbol: "TSLA", gainBps: 2_000, usdgRaw: C, costRaw: B }],
  "stop-floor": [
    { code: "stop-floor", symbol: "TSLA", lossBps: 1_200, usdgRaw: A, costRaw: B },
    { code: "stop-floor", symbol: "TSLA", lossBps: 1_200, usdgRaw: A, costRaw: B, floorBps: 800, floorWhy: "8% — a thin curve." },
    { code: "stop-floor", symbol: "TSLA", lossBps: 1_200, usdgRaw: A, costRaw: B, floorBps: 800, floorWhy: null },
  ],
  "model-held": [{ code: "model-held", held: 2, considered: 3, dropped: 1 }],
  "stale-fallback": [{ code: "stale-fallback", symbol: "BTC", usdgRaw: A, legs: 3 }],
  "gap-enter": [{ code: "gap-enter", symbol: "AAPL", usdgRaw: C }],
  "gap-exit": [{ code: "gap-exit", symbol: "AAPL" }],
  "keel-seed": [
    { code: "keel-seed", usdgRaw: BIG, legs: 3 },
    { code: "keel-seed", usdgRaw: A, legs: 3, capped: true },
  ],
  "keel-trim": [{ code: "keel-trim", symbol: "TSLA", overRaw: A }],
  "keel-top": [
    { code: "keel-top", symbol: "PLTR", underRaw: B },
    { code: "keel-top", symbol: "PLTR", underRaw: B, capped: true },
  ],
  dip: [
    { code: "dip", symbol: "NVDA", dipBps: 240, priced: 4, usdgRaw: C },
    { code: "dip", symbol: "NVDA", dipBps: 240, priced: 4, usdgRaw: C, capped: true },
  ],
  "trench-enter": [{ code: "trench-enter", symbol: "WIF", liqUsd: 41_000, fdvUsd: 820_000, ageSec: 2_820, usdgRaw: A }],
  "trench-exit": [{ code: "trench-exit", symbol: "WIF", cause: "stop", pct: -31.4 }],
  "class-enter": [
    { code: "class-enter", symbol: "T3139F043B88", usdgRaw: A, trades: 32, traders: 20, depthRaw: C, impactBps: 40, costBps: 90, graduationBps: 4_130, field: 3 },
    { code: "class-enter", symbol: "T3139F043B88", usdgRaw: A, trades: null, traders: null, depthRaw: C, impactBps: 40, costBps: null, graduationBps: 4_130, field: 1 },
  ],
  "class-exit": [
    { code: "class-exit", symbol: "T3139F043B88", cause: "cliff", heldSec: 7_200, graduationBps: 9_100, proceedsRaw: C },
    { code: "class-exit", symbol: "T3139F043B88", cause: "clock", heldSec: 21_600, graduationBps: null, proceedsRaw: C },
  ],
};
const ALL: Why[] = Object.values(EVERY).flat();

/** Every amount of the book this Why carries, as `usdg()` would print it. */
function figuresOf(w: Why): string[] {
  return Object.values(w)
    .filter((v): v is bigint => typeof v === "bigint" && v !== 0n)
    .map((raw) => {
      const whole = raw / 1_000_000n;
      const cents = (raw % 1_000_000n) / 10_000n;
      return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
    });
}

describe("the public register names no figure of the book", () => {
  it("covers every code", () => {
    for (const [code, list] of Object.entries(EVERY)) assert.ok(list.length > 0, `${code} has no case`);
  });

  it("NO AMOUNT, IN ANY SENTENCE, FOR ANY CODE — the size, the cost, the proceeds, the cash, the floor", () => {
    for (const w of ALL) {
      const s = renderWhy(w, "public");
      for (const f of figuresOf(w)) assert.ok(!s.includes(f), `${w.code} published ${f}: "${s}"`);
      assert.doesNotMatch(s, /\d\s*USDG/, `${w.code} published a USDG amount: "${s}"`);
      assert.doesNotMatch(s, /\d[\d,]*\.\d{2}\b/, `${w.code} published a two-decimal figure: "${s}"`);
    }
  });

  it("still says something real: the coin, the percentages and the counts survive", () => {
    for (const w of ALL) {
      const pub = renderWhy(w, "public");
      const own = renderWhy(w, "owner");
      assert.ok(pub.length > 20 && pub.length < 220, `${w.code}: "${pub}"`);
      assert.doesNotMatch(pub, /undefined|NaN|\[object|\s{2}|\s[,.]/, `${w.code} reads broken: "${pub}"`);
      if ("symbol" in w) assert.ok(pub.includes(w.symbol), `${w.code} lost its coin: "${pub}"`);
      // A percentage the owner is told is a percentage the public default shows.
      for (const p of own.match(/\d+(?:\.\d)?%/g) ?? []) assert.ok(pub.includes(p), `${w.code} lost ${p}: "${pub}"`);
    }
  });

  it("the OWNER keeps every figure — the register only changes who reads it", () => {
    for (const w of ALL) {
      const own = renderWhy(w, "owner");
      for (const f of figuresOf(w).filter((f) => !(w.code === "unpark" && f === "5.17") && !(w.code === "class-enter" && f === "61.23"))) {
        // unpark's need and class-enter's depth were never in either sentence.
        assert.ok(own.includes(f), `${w.code}: the owner lost ${f}: "${own}"`);
      }
      assert.equal(renderWhy(w), own, "the default register is still the owner's");
    }
  });

  it("the market's own figures stay: a pool's depth and FDV are not the book", () => {
    const s = renderWhy(EVERY["trench-enter"][0]!, "public");
    assert.match(s, /41,000 deep, FDV 820,000, 47m old/);
  });
});
