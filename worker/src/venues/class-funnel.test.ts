/**
 * A FUNNEL THAT LOSES A STAGE IS WORSE THAN NO FUNNEL.
 *
 * Shogun sat for hours printing `1 passed graduation safety → 0 qualified`.
 * Every number was true. The candidate had been refused on ACTIVITY — a stage
 * the line did not name — so the drop had nothing under it, and because nothing
 * else logs `choice.refused`, the reason existed nowhere at all. The line
 * invited exactly one reading ("something after graduation, work out what") and
 * that is the reading that wasted the hours.
 *
 * These tests pin the property the arithmetic has to have: every candidate that
 * enters leaves as a survivor or as a NAMED refusal, and anything else shows up
 * as a number rather than disappearing between two stages.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RefusalKind } from "./candidate-score";
import { classFunnelKey, classFunnelLine, classFunnelStages, type ClassScanCounts } from "./class-funnel";

const scan = (over: Partial<ClassScanCounts> = {}): ClassScanCounts => ({
  discovered: 9,
  withCurve: 9,
  tradable: 1,
  refused: [],
  picked: false,
  buying: true,
  ...over,
});

const refusals = (...kinds: RefusalKind[]) => kinds.map((kind) => ({ kind }));

describe("the stage that went missing", () => {
  it("SHOGUN'S ACTUAL TICK — the activity refusal is a stage, not a vanishing", () => {
    // Nine rows, one quoted in USDG, deep enough, cheap enough, far enough from
    // graduating — and a tape too quiet to buy into.
    const c = scan({ refused: refusals("activity") });
    const s = classFunnelStages(c);
    assert.equal(s.passedDepth, 1);
    assert.equal(s.passedImpact, 1);
    assert.equal(s.passedGraduation, 1);
    assert.equal(s.passedActivity, 0, "the activity refusal must land on the activity stage");
    assert.equal(s.qualified, 0);
    assert.equal(s.unaccounted, 0, "and must NOT show up as an unexplained residue");

    const line = classFunnelLine(c, s);
    assert.match(line, /1 passed graduation safety → 0 passed activity → 0 qualified/);
    assert.doesNotMatch(line, /no stage above names/);
  });

  it("names the stage for every kind the scorer can emit", () => {
    // The union is the contract. A kind added to `RefusalKind` that nobody
    // wires in here starts silently eating candidates — which is the whole bug.
    const KINDS: RefusalKind[] = ["depth", "impact", "graduation", "age", "activity", "unpriceable"];
    for (const kind of KINDS) {
      const s = classFunnelStages(scan({ refused: refusals(kind) }));
      assert.equal(
        s.unaccounted,
        0,
        `a "${kind}" refusal is not accounted for by any named stage — it would vanish from the line`,
      );
    }
  });

  it("and a kind NO stage names is reported as a number, not swallowed", () => {
    // `venue` is chooseEntry's fallback. It has no stage of its own on purpose:
    // the point is that the residue is visible rather than that every kind is
    // pre-empted. This is the tripwire for the next `activity`.
    const c = scan({ refused: refusals("venue") });
    const s = classFunnelStages(c);
    assert.equal(s.passedActivity, 1);
    assert.equal(s.qualified, 0);
    assert.equal(s.unaccounted, 1);
    assert.match(classFunnelLine(c, s), /1 refused for a reason no stage above names/);
  });
});

describe("the labels say where each filter actually ran", () => {
  it("does not claim the USDG filter ran a stage before it did", () => {
    // The real tick: nine rows carry a curve, exactly one is quoted in USDG.
    // The old line said `9 usdg pairs → 1 tradable` while the census beside it
    // said `usdg 1`, and reconciling the two is not something a reader should
    // have to do.
    const c = scan({ withCurve: 9, tradable: 1 });
    const line = classFunnelLine(c, classFunnelStages(c));
    assert.match(line, /scanned 9 → 9 with a curve → 1 tradable in USDG/);
    assert.doesNotMatch(line, /usdg pairs/);
  });

  it("says plainly when the pass could only ever look", () => {
    const c = scan({ buying: false });
    assert.match(classFunnelLine(c, classFunnelStages(c)), /BUYING OFF \(scan only\)/);
  });
});

describe("the change key", () => {
  it("moves when the stage a candidate died at moves, though the ends match", () => {
    // Both are "1 tradable, 0 qualified". They are different diagnoses, and a
    // key built only from the ends would print the first and suppress the
    // second — leaving the operator looking at a stale reason.
    const depth = scan({ refused: refusals("depth") });
    const activity = scan({ refused: refusals("activity") });
    assert.notEqual(
      classFunnelKey(depth, classFunnelStages(depth)),
      classFunnelKey(activity, classFunnelStages(activity)),
    );
  });

  it("holds steady when nothing changed, so the log is not a wall", () => {
    const a = scan({ refused: refusals("activity") });
    const b = scan({ refused: refusals("activity") });
    assert.equal(classFunnelKey(a, classFunnelStages(a)), classFunnelKey(b, classFunnelStages(b)));
  });
});
