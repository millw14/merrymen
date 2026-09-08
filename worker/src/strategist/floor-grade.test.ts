/**
 * A FLOOR THAT FITS THE POSITION IT IS UNDER.
 *
 * One number across a whole book is the wrong shape for this one. A 12% floor
 * under a launchpad memecoin fires on the venue rather than the trade — p99
 * movement among active curves is 1,546bps over four minutes — and a 35% floor
 * under a well-evidenced equity is not caution, it is 35% of somebody's money.
 *
 * The tests that matter here are the REFUSALS. A grader that only ever tightens
 * looks correct in a demo and takes the owner's money on the one position it
 * was wrong about; a grader that widens on the model's own confidence gives the
 * most room to exactly the reasoning that was most sure and most wrong.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { gradeFloor, TIGHT_RATIO, WIDE_RATIO, type FloorInputs } from "./floor-grade";

const OWNER = 2_500; // the owner's dial, and the band this was specified against

const grade = (over: Partial<FloorInputs> = {}) =>
  gradeFloor({
    instrumentClass: "equity-token",
    overhangBps: null,
    evidence: [],
    economics: null,
    ownerBps: OWNER,
    ...over,
  });

const strong = [
  { lens: "technical", evidenceStrength: 0.8 },
  { lens: "news", evidenceStrength: 0.7 },
];

describe("the band, at the dial it was specified against", () => {
  it("IS 12 / 25 / 35 AT A 2,500 BPS FLOOR", () => {
    // The numbers the owner asked for, arrived at as ratios so the dial keeps
    // meaning rather than being quietly ignored on two thirds of the book.
    assert.equal(Math.round(OWNER * TIGHT_RATIO), 1_200);
    assert.equal(OWNER, 2_500);
    assert.equal(Math.round(OWNER * WIDE_RATIO), 3_500);
  });

  it("and the whole band moves with the dial", () => {
    // An owner who halves their floor must not find two thirds of their
    // positions still sitting at the old level.
    const half = grade({ ownerBps: 1_250, evidence: strong });
    assert.equal(half.rung, "tight");
    assert.equal(half.bps, 600);
  });
});

describe("the owner decides WHETHER, the grade decides only WHERE", () => {
  it("NO FLOOR ARMED MEANS NO FLOOR, however good the evidence", () => {
    // A grade is a level, never a permission. An agent whose owner has armed
    // nothing must not acquire a stop because four analysts had a lot to say.
    const off = grade({ ownerBps: 0, evidence: strong, overhangBps: 100 });
    assert.equal(off.bps, 0);
    assert.equal(off.rung, "off");
    assert.equal(off.why, "");
  });

  it("and a nonsense dial is treated as off, not as a default", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(grade({ ownerBps: bad, evidence: strong }).bps, 0, `${bad} must not arm a floor`);
    }
  });
});

describe("what widens it", () => {
  it("A CURVE THAT CAN FALL A THIRD ON ITS OWN", () => {
    // Past about a tenth of the way to graduation, the curve alone exceeds a
    // 3,500bps stop — so anything tighter measures the venue, not the trade.
    const g = grade({ instrumentClass: "memecoin", overhangBps: 3_600, evidence: strong });
    assert.equal(g.rung, "wide");
    assert.equal(g.bps, 3_500);
    assert.match(g.why, /would fall 36% on its own/);
  });

  it("AND A MEMECOIN WHOSE CURVE COULD NOT BE READ", () => {
    // Not the same as an equity with no curve: there the absence is a fact
    // about the instrument, here it is a gap in the one risk that matters most.
    const g = grade({ instrumentClass: "memecoin", overhangBps: null, evidence: strong });
    assert.equal(g.rung, "wide");
    assert.match(g.why, /could not read this coin's curve/);
  });

  it("AND A LAUNCHPAD COIN NOBODY COULD SAY ANYTHING ABOUT", () => {
    // The owner's own phrase for this rung: thin-evidence memecoin, where
    // anything tighter is paying the spread to be stopped out by noise.
    const g = grade({
      instrumentClass: "memecoin",
      overhangBps: 500,
      evidence: [{ lens: "technical", evidenceStrength: 0.9 }],
    });
    assert.equal(g.rung, "wide");
    assert.match(g.why, /only 1 of my analysts/);
  });

  it("and widening beats tightening when both could apply", () => {
    // Strong evidence on a deep curve is still a deep curve. The venue's own
    // arithmetic outranks anything a model said about the token.
    const g = grade({ instrumentClass: "memecoin", overhangBps: 6_213, evidence: strong });
    assert.equal(g.rung, "wide");
  });
});

describe("what tightens it", () => {
  it("REAL MATERIAL, ON SOMETHING THAT IS NOT A CURVE", () => {
    const g = grade({ evidence: strong });
    assert.equal(g.rung, "tight");
    assert.equal(g.bps, 1_200);
    assert.match(g.why, /2 analysts had real material/);
    assert.match(g.why, /not on a bonding curve/);
  });

  it("and a shallow curve tightens too, and says so differently", () => {
    const g = grade({ instrumentClass: "memecoin", overhangBps: 1_500, evidence: strong });
    assert.equal(g.rung, "tight");
    assert.match(g.why, /its curve is shallow/);
  });

  it("ONE ANALYST IS NOT A CONSENSUS", () => {
    const g = grade({ evidence: [{ lens: "technical", evidenceStrength: 0.95 }] });
    assert.equal(g.rung, "default");
  });

  it("AND THIN MATERIAL IS NOT REAL MATERIAL", () => {
    // Two lenses that answered from almost nothing is not a considered view,
    // and this is the distinction Brain's own schema draws: how much a lens had
    // to work with, as distinct from how sure it is.
    const g = grade({
      evidence: [
        { lens: "technical", evidenceStrength: 0.3 },
        { lens: "news", evidenceStrength: 0.2 },
      ],
    });
    assert.equal(g.rung, "default");
  });

  it("and a trade that could not pay for itself does not earn a closer floor", () => {
    // Economics is a bar to tightening, never a reason for it: a trade whose
    // edge does not clear its gas is not one to take a smaller loss on with
    // confidence, it is one that should not have been sized.
    for (const e of ["uneconomic", "marginal"] as const) {
      assert.equal(grade({ evidence: strong, economics: e }).rung, "default", e);
    }
    assert.equal(grade({ evidence: strong, economics: "viable" }).rung, "tight");
    assert.equal(grade({ evidence: strong, economics: "unknown" }).rung, "tight");
  });
});

describe("what it will not look at", () => {
  it("CONFIDENCE IS NOT AN INPUT, AND CANNOT BE PASSED", () => {
    // The rule this module exists to hold. Both confidences Brain produces are
    // a model's self-report about its own output; scaling risk by one means a
    // confidently wrong model earns a wider floor, which is backwards at
    // exactly the moment the floor matters. Enforced by the shape of the input
    // rather than by a comment, and pinned here so a later hand cannot quietly
    // widen the interface.
    const src = new URL("./floor-grade.ts", import.meta.url);
    return import("node:fs").then(({ readFileSync }) => {
      const text = readFileSync(src, "utf8");
      const iface = text.slice(text.indexOf("export interface FloorInputs"), text.indexOf("export interface FloorGrade"));
      assert.ok(!/\bconfidence\b\s*[?:]/.test(iface), "FloorInputs must not accept a confidence");
      assert.match(text, /evidenceStrength/, "evidence_strength is the sound half and is accepted");
    });
  });

  it("and a lens that did not answer is absent, not weak", () => {
    // The caller filters the failure arms out; this pins the consequence, which
    // is that an empty list grades as ungraded rather than as thin evidence.
    const g = grade({ evidence: [] });
    assert.equal(g.rung, "default");
    assert.match(g.why, /No analyst had material/);
  });
});

describe("the default rung says whose number it is", () => {
  it("IT IS THE OWNER'S, VERBATIM", () => {
    const g = grade();
    assert.equal(g.bps, OWNER);
    assert.match(g.why, /25% — your own floor/);
  });
});

/**
 * THE WIRING, WHICH IS WHERE A GRADER LIKE THIS USUALLY DIES.
 *
 * A pure grader that nothing calls, or that is called at the wrong moment with
 * empty inputs, passes every test above and grades nothing in production. These
 * read the source because that is where the property lives.
 */
describe("it is stamped once, at an entry that could actually be graded", () => {
  const worker = async () => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  };

  it("STAMPED AT THE LIVE FILL, not inside bookFill", async () => {
    // bookFill has five callers and two of them are arm-time recovery paths
    // that run before any pricing pass — where `lastCurveLegs` is empty and a
    // memecoin would be graded as though its venue were unreadable, which is
    // the WIDE rung. Grading there would stamp the most permissive floor on the
    // riskiest asset for no reason but call ordering.
    const src = await worker();
    assert.match(src, /if \(liveFill\?\.side === "buy" && liveFill\.qtyRaw > 0n\) \{\s*\n\s*await stampFloorFor\(/);
    assert.ok(!/async function bookFill[\s\S]{0,4000}stampFloorFor/.test(src), "must not be inside bookFill");
  });

  it("AND ONLY WHILE THE OWNER HAS A FLOOR ARMED", async () => {
    const src = await worker();
    assert.match(src, /if \(!cfg\.strategistStopLossBps \|\| cfg\.strategistStopLossBps <= 0\) return;/);
  });

  it("and the overhang comes from THIS tick's reserves", async () => {
    // Not a cached figure: curve-prices.ts forbids caching reserves and says
    // why — p99 movement is 1,546bps over 240 seconds, so two reads of one tick
    // are two different markets.
    const src = await worker();
    assert.match(src, /const leg = lastCurveLegs\.get\(symbol\);/);
    assert.match(src, /const overhangBps = leg \? curveFloorDrawdownBps\(leg\.reserves\) : null;/);
  });

  it("and a stale Brain reading does not grade a new entry", async () => {
    // Brain runs on a 900s cooldown, so the decision behind a buy is minutes
    // old. An hour-old reading describes a different market, and grading from
    // it would be worse than not grading at all.
    const src = await worker();
    assert.match(src, /BRAIN_GRADE_TTL_SEC/);
    assert.match(src, /Date\.now\(\) \/ 1000\) - g\.at <= BRAIN_GRADE_TTL_SEC \? g : null/);
  });

  it("and the grade is captured for EVERY run, not only live ones", async () => {
    // A hold that becomes a buy two ticks later was still reasoned from that
    // material, and a shadow agent's grades must be ready the day its owner
    // turns execution on.
    const src = await worker();
    const capture = src.indexOf("brainGrade.set(");
    const liveArm = src.indexOf("brainLiveEnabledFor(agentId)) {\n            const d = outcome.result.decision;");
    assert.ok(capture > 0, "the capture must exist");
    assert.ok(liveArm < 0 || capture < liveArm, "and sit outside the live-only arm");
  });

  it("and only lenses that ANSWERED are counted as evidence", async () => {
    // no-data, parse-failed, provider-failed and the rest are absent rather
    // than zero: four broken analysts must not read as a considered view.
    const src = await worker();
    assert.match(src, /\.filter\(\(v\) => v\.direction === "buy" \|\| v\.direction === "sell" \|\| v\.direction === "hold"\)/);
  });

  it("and the floor is read back for the SAME book as the basis", async () => {
    // A paper entry price must never set the level under a funded position.
    const src = await worker();
    assert.match(src, /const floorsBySymbol = await positionFloors\(active\.agentId, basisMode\);/);
  });
});

describe("first write wins, and it dies with the position", () => {
  it("THE DATABASE ENFORCES THE ONE-STAMP RULE", async () => {
    // Not a caller remembering: a top-up must not move the reference, which
    // trench_positions already records as "turning averaging down into a way of
    // never stopping out".
    const { readFileSync } = await import("node:fs");
    const store = readFileSync(new URL("../store.ts", import.meta.url), "utf8");
    assert.match(store, /INSERT INTO position_floors[\s\S]{0,200}ON CONFLICT\(agent_id, mode, symbol\) DO NOTHING/);
  });

  it("AND IT IS DROPPED WITH THE COST BASIS", async () => {
    // A floor is a distance from an entry price. Left behind, the NEXT entry in
    // that symbol inherits a level graded from a market and an analysis that
    // are both gone.
    const { readFileSync } = await import("node:fs");
    const store = readFileSync(new URL("../store.ts", import.meta.url), "utf8");
    const setBasis = store.slice(store.indexOf("export async function setBasis"));
    const closeArm = setBasis.slice(0, setBasis.indexOf("ON CONFLICT"));
    assert.match(closeArm, /DELETE FROM cost_basis/);
    assert.match(closeArm, /DELETE FROM position_floors/);
  });
});
