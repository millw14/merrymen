/**
 * THE SCORER'S JOB IS TO SAY NO, and these pin the ways it must say it.
 *
 * An autonomous trader is one decision away from being an indiscriminate one.
 * Everything here is about the boundary: what it refuses, what it refuses to
 * GUESS at, and the fact that "no pick" is a correct answer rather than a
 * failure to find one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chooseEntry,
  scoreLeg,
  styleFitsExit,
  thresholdsFor,
  type RiskStyle,
} from "./candidate-score";
import type { VenueLeg, VenueQuote } from "./venue";

const leg = (over: Partial<VenueLeg> = {}): VenueLeg => ({
  venue: "pons",
  token: "0x1111111111111111111111111111111111111111",
  symbol: "BONKER",
  decimals: 18,
  route: "0x2222222222222222222222222222222222222222",
  quoteToken: "0x3333333333333333333333333333333333333333",
  realDepthRaw: 5_000_000_000n, // 5,000 USDG — deep enough for every style
  graduationBps: 1_000,
  ageSec: 7200,
  recentTrades: 50,
  ...over,
});

const quote = (costBps: number | null): VenueQuote => ({ amountOutRaw: 1n, costBps });

describe("a signal that could not be measured is a refusal, never a pass", () => {
  // The single most dangerous failure mode: an unreadable market looks exactly
  // like a clean one to any check written as `if (x > limit)`.
  const cases: { what: string; over: Partial<VenueLeg>; entry: VenueQuote | null }[] = [
    { what: "no entry price at all", over: {}, entry: null },
    { what: "an unmeasurable round-trip cost", over: {}, entry: quote(null) },
    { what: "unknown graduation progress", over: { graduationBps: null }, entry: quote(100) },
    { what: "unknown age", over: { ageSec: null }, entry: quote(100) },
    { what: "unknown recent activity", over: { recentTrades: null }, entry: quote(100) },
  ];

  for (const c of cases) {
    it(`refuses on ${c.what}`, () => {
      const v = scoreLeg(leg(c.over), "conservative", c.entry);
      assert.equal(v.ok, false, `${c.what} must not qualify`);
      assert.ok(v.reason, "and must say why");
      assert.equal(v.score, 0);
    });
  }
});

describe("the graduation trap", () => {
  it("REFUSES A TOKEN TOO CLOSE TO GRADUATING — the vault cannot sell a graduated curve", () => {
    // The milestone's central risk. Graduation is the SUCCESS case, and it is
    // also the moment the exit closes, so entry must leave room.
    const v = scoreLeg(leg({ graduationBps: 9_000 }), "aggressive", quote(100));
    assert.equal(v.ok, false);
    assert.equal(v.kind, "graduation");
    assert.match(v.reason!, /can no longer be sold/);
  });

  it("and every style stops well short of the default 85% exit", () => {
    for (const style of ["conservative", "balanced", "aggressive"] as RiskStyle[]) {
      assert.ok(
        styleFitsExit(style, 8_500),
        `${style} must leave room before the exit cliff, ceiling is ${thresholdsFor(style).maxGraduationBps}`,
      );
    }
  });

  it("and a style is refused outright when the owner moves the exit down to meet it", () => {
    // An owner who sets the graduation exit to 55% leaves Conservative (50%)
    // with a 5% window. That combination must be caught, not traded.
    assert.equal(styleFitsExit("conservative", 5_500), false);
  });
});

describe("the styles actually differ", () => {
  it("aggressive takes a thin, new market that conservative refuses", () => {
    const thin = leg({ realDepthRaw: 300_000_000n, ageSec: 60, recentTrades: 0 });
    assert.equal(scoreLeg(thin, "conservative", quote(250)).ok, false);
    assert.equal(scoreLeg(thin, "aggressive", quote(250)).ok, true);
  });

  it("but aggressive still refuses a market it cannot measure", () => {
    // Taste may loosen; safety may not.
    const unknowable = leg({ realDepthRaw: 300_000_000n, graduationBps: null });
    assert.equal(scoreLeg(unknowable, "aggressive", quote(250)).ok, false);
  });

  it("and aggressive still refuses one that is simply too expensive", () => {
    assert.equal(scoreLeg(leg(), "aggressive", quote(2_000)).ok, false);
  });
});

describe("choosing, and choosing nothing", () => {
  it("RETURNS NO PICK WHEN NOTHING QUALIFIES, and that is a correct answer", () => {
    const out = chooseEntry(
      [
        { leg: leg({ symbol: "DOGE2", realDepthRaw: 41_000_000n }), entry: quote(100) },
        { leg: leg({ symbol: "THIN", realDepthRaw: 10_000_000n }), entry: quote(100) },
      ],
      "balanced",
    );
    assert.equal(out.pick, null, "it must not reach for the least-bad option");
    assert.equal(out.refused.length, 2);
    assert.ok(out.refused.every((r) => r.kind === "depth"));
  });

  it("carries a sentence and a groupable cause for every reject", () => {
    const out = chooseEntry([{ leg: leg({ symbol: "DOGE2", realDepthRaw: 41_000_000n }), entry: quote(100) }], "balanced");
    const r = out.refused[0]!;
    assert.equal(r.symbol, "DOGE2");
    assert.equal(r.kind, "depth");
    // The brief's own example: "Rejected DOGE2 — only $41 real liquidity".
    assert.match(r.reason, /41\.00 USDG of real liquidity/);
  });

  it("picks the deepest when several qualify", () => {
    const out = chooseEntry(
      [
        { leg: leg({ symbol: "SHALLOW", realDepthRaw: 600_000_000n }), entry: quote(100) },
        { leg: leg({ symbol: "DEEP", realDepthRaw: 9_000_000_000n }), entry: quote(100) },
      ],
      "balanced",
    );
    assert.equal(out.pick?.symbol, "DEEP");
  });

  it("and an empty universe is not an error", () => {
    const out = chooseEntry([], "balanced");
    assert.equal(out.pick, null);
    assert.deepEqual(out.refused, []);
  });
});
