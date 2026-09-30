/**
 * THE FACT LAYER — and above all, what it refuses to say.
 *
 * Two properties are load-bearing here and the rest is detail:
 *
 *   1. AN UNREADABLE MEASUREMENT PRODUCES NO BAND AT ALL. Not "quiet", not
 *      "low", not a zero — nothing. A social writer handed these bands can only
 *      talk about what is in them, so an absent key is the mechanism that stops
 *      an agent claiming a curve was quiet when we simply could not hear it.
 *
 *   2. `everyBand()` IS COMPLETE. The anti-fabrication check downstream treats
 *      the band vocabulary as total: a word in a post that is not in this set
 *      did not come from evidence. If `everyBand()` misses a value that
 *      `classEvidenceOf` can emit, the validator rejects truthful posts; if it
 *      contains a word no bander emits, it admits an unvouched one. So it is
 *      tested against the banders rather than trusted.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activityBand,
  breadthBand,
  classEvidenceOf,
  costBand,
  curveBand,
  depthBand,
  everyBand,
  heldBand,
  impactBand,
  type BandBounds,
} from "./class-evidence";
import type { Why } from "./strategies/reasons";

const BOUNDS: BandBounds = {
  depthFloorUsdg: 100,
  roundTripCeilingBps: 600,
  exitAtBps: 8500,
  activityFloorTrades: 25,
  impactCeilingBps: 300,
  maxHoldSec: 21600,
};

const enter = (over: Partial<Extract<Why, { code: "class-enter" }>> = {}): Why => ({
  code: "class-enter",
  symbol: "MOON",
  usdgRaw: 5_000_000n,
  trades: 60,
  traders: 20,
  depthRaw: 400_000_000n,
  impactBps: 40,
  costBps: 120,
  graduationBps: 2000,
  field: 4,
  ...over,
});

const exit = (over: Partial<Extract<Why, { code: "class-exit" }>> = {}): Why => ({
  code: "class-exit",
  symbol: "MOON",
  cause: "clock",
  heldSec: 21600,
  graduationBps: 4100,
  proceedsRaw: 3_600_000n,
  ...over,
});

describe("an unreadable measurement contributes no evidence", () => {
  it("drops activity entirely when the tape could not be read", () => {
    const e = classEvidenceOf(enter({ trades: null, traders: null }), BOUNDS)!;
    assert.ok(!("activity" in e.bands), "a null tape must not become an activity band");
    assert.ok(!("breadth" in e.bands), "and it must not become a breadth band either");
    // The raw figures keep the null so the drill-down can say "we could not
    // read it" rather than showing a zero somebody will read as measured.
    assert.equal(e.raw.trades, null);
    assert.equal(e.raw.traders, null);
  });

  it("KEEPS a measured zero as a measured zero", () => {
    // The other half, and the one that makes the first meaningful. A tape we
    // DID read that showed no trades is a fact about the curve, and it must
    // reach the row — it is only the UNREADABLE case that says nothing.
    const e = classEvidenceOf(enter({ trades: 0, traders: 0 }), BOUNDS)!;
    assert.equal(e.raw.trades, 0, "a measured zero is not an absence");
    assert.ok("activity" in e.bands, "a curve with no trades still has an activity band");
    assert.ok(!("breadth" in e.bands), "but zero trades supports no claim about who was in it");
  });

  it("drops the cost band when the round trip could not be priced", () => {
    const e = classEvidenceOf(enter({ costBps: null }), BOUNDS)!;
    assert.ok(!("cost" in e.bands));
    assert.equal(e.raw.costBps, null);
  });

  it("drops the curve band on an exit whose depth fraction was unreadable", () => {
    // The gate coalesces this to zero so an unreadable curve never trips the
    // cliff. Coalescing it here too would publish "curve early" about a curve
    // nobody could see.
    const e = classEvidenceOf(exit({ graduationBps: null }), BOUNDS)!;
    assert.ok(!("curve" in e.bands), "an unreadable curve gets no band");
    assert.equal(e.raw.graduationBps, null);
    assert.ok("held" in e.bands, "the clock is still knowable and still reported");
  });
});

describe("breadth separates a crowd from a pair of bots", () => {
  it("calls two addresses passing it back and forth what it is", () => {
    assert.equal(breadthBand(2, 40), "the same few hands");
  });

  it("recognises genuine spread", () => {
    assert.equal(breadthBand(30, 40), "buyers mostly new");
  });

  it("refuses to divide by a measured-zero tape", () => {
    // 0 trades and 0 traders is a real reading and supports NO statement about
    // who is in it. Returning a band here would be inventing one from 0/0.
    assert.equal(breadthBand(0, 0), null);
  });
});

describe("the two exits are told apart, and only those two exist", () => {
  it("names the cliff as a door closing, not as a target being hit", () => {
    const e = classEvidenceOf(exit({ cause: "cliff", graduationBps: 8600 }), BOUNDS)!;
    assert.match(e.bands.why!, /vault cannot sell it once it graduates/);
    assert.equal(e.raw.cause, "cliff");
  });

  it("lets the clock speak through the held band rather than saying it twice", () => {
    // heldBand already returns "held its full window" for any exit the clock
    // could have fired, so a separate cause band would duplicate it — two slots
    // of a small evidence budget spent on one fact. The raw value still
    // distinguishes them for the drill-down and for any later reader.
    const e = classEvidenceOf(exit({ cause: "clock" }), BOUNDS)!;
    assert.match(e.bands.why!, /my own time limit/);
    assert.equal(e.bands.held, "held its full window");
    assert.equal(e.raw.cause, "clock");
    const values = Object.values(e.bands);
    assert.equal(new Set(values).size, values.length, "no band may be repeated");
  });
});

describe("provenance is recorded, not assumed", () => {
  it("marks a deterministic class decision as decided by rule", () => {
    assert.equal(classEvidenceOf(enter(), BOUNDS)!.decidedBy, "rule");
    assert.equal(classEvidenceOf(exit(), BOUNDS)!.decidedBy, "rule");
  });

  it("produces nothing for a Why that is not a class decision", () => {
    // Fail closed: evidence about the wrong trade is worse than none.
    assert.equal(classEvidenceOf({ code: "gap-exit", symbol: "AAPL" }, BOUNDS), null);
    assert.equal(classEvidenceOf(null, BOUNDS), null);
    assert.equal(classEvidenceOf(undefined, BOUNDS), null);
  });
});

describe("the band vocabulary is total", () => {
  it("contains every word the banders can produce", () => {
    // Swept across each bander's whole range at a finer grain than everyBand()
    // uses, so a band edge everyBand's sample happens to step over is caught.
    const seen = new Set<string>();
    for (let i = 0; i <= 400; i++) {
      const m = i / 25;
      seen.add(depthBand(BOUNDS.depthFloorUsdg * m, BOUNDS.depthFloorUsdg));
      seen.add(costBand(BOUNDS.roundTripCeilingBps * m, BOUNDS.roundTripCeilingBps));
      seen.add(curveBand(Math.round(BOUNDS.exitAtBps * m), BOUNDS.exitAtBps));
      seen.add(activityBand(Math.round(BOUNDS.activityFloorTrades * m), BOUNDS.activityFloorTrades));
      seen.add(impactBand(Math.round(BOUNDS.impactCeilingBps * m), BOUNDS.impactCeilingBps));
      seen.add(heldBand(Math.round(BOUNDS.maxHoldSec * m), BOUNDS.maxHoldSec));
    }
    for (let traders = 0; traders <= 40; traders++) {
      for (const trades of [1, 4, 10, 40, 100]) {
        const b = breadthBand(traders, trades);
        if (b) seen.add(b);
      }
    }
    seen.add("picked over others");
    seen.add("sold because the vault cannot sell it once it graduates, not because of the price");
    seen.add("sold on my own time limit, not on anything the market did");

    const declared = everyBand();
    for (const word of seen) {
      assert.ok(declared.has(word), `everyBand() is missing "${word}" — a truthful post would be rejected`);
    }
    for (const word of declared) {
      assert.ok(seen.has(word), `everyBand() declares "${word}", which no bander emits — an unvouched word`);
    }
  });

  it("every band a real decision produces is in the vocabulary", () => {
    const declared = everyBand();
    for (const w of [
      enter(),
      enter({ trades: null, traders: null }),
      enter({ costBps: null, field: 1 }),
      enter({ trades: 0, traders: 0, graduationBps: 8600, impactBps: 290, depthRaw: 100_000_000n }),
      exit(),
      exit({ cause: "cliff", graduationBps: 9000 }),
      exit({ graduationBps: null, heldSec: 100 }),
    ]) {
      const e = classEvidenceOf(w, BOUNDS)!;
      for (const [key, value] of Object.entries(e.bands)) {
        assert.ok(declared.has(value), `band ${key}="${value}" is outside the declared vocabulary`);
      }
    }
  });
});

describe("bands are anchored to the route's own thresholds", () => {
  it("calls depth thin only just above the floor the route refuses below", () => {
    assert.equal(depthBand(150, 100), "liquidity thin");
    assert.equal(depthBand(1200, 100), "liquidity deep");
  });

  it("moves with the owner's settings rather than fixed numbers", () => {
    // The same measurement means different things to two owners, and it must:
    // "our size moves it" is a claim relative to the impact ceiling THEY set.
    assert.equal(impactBand(250, 300), "our size moves it");
    assert.equal(impactBand(250, 3000), "our size barely moves it");
  });

  it("treats a nonsensical ceiling as no claim rather than dividing by it", () => {
    assert.equal(impactBand(250, 0), "our size barely moves it");
    assert.equal(heldBand(100, 0), "held its full window");
  });
});
