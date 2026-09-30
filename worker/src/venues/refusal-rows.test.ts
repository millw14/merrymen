/**
 * A MEASUREMENT MUST OUTLIVE AN ABSENCE.
 *
 * The pricing pass tries v3, then v4, then the curve, and one row list carries
 * the outcome — `poolRefusals` is rebuilt from it wholesale, so that list is
 * the only thing the owner is ever told. Two inline bugs lived in the ten lines
 * that maintained it, and both replaced something measured with something that
 * found nothing:
 *
 *   A v4 refusal was written straight into `poolRefusals` and never into the
 *   row list, so the rebuild discarded it every time and a pool turned down for
 *   an 86% fee was reported as "no Uniswap v3 pool — nothing to price it from".
 *
 *   The curve pass replaced whatever row was there, although its own comment
 *   says it replaces the pool's "no-pool".
 *
 * Neither produced an error. Both produced a plausible sentence about the wrong
 * thing, which is why they survived.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMeasured, upsertRefusal, type RefusalRow } from "./refusal-rows";

const row = (symbol: string, kind: string, reason = `because ${kind}`): RefusalRow => ({ symbol, kind, reason });

describe("what counts as a measurement", () => {
  it("treats a venue that found nothing to look at as an absence", () => {
    assert.equal(isMeasured("no-pool"), false);
    assert.equal(isMeasured("curve-no-curve"), false);
  });

  it("treats every judged outcome as a measurement", () => {
    // These are the real kinds the three pricers emit. A pool charging 86% a
    // trade was LOOKED AT; that is the most informative thing we know about it.
    for (const kind of [
      "too-thin", "divergent", "no-twap", "stale-read",
      "v4-extortionate-fee", "v4-too-thin", "v4-wide-round-trip", "v4-no-price",
      "curve-graduated", "curve-too-thin", "curve-impact-cap", "curve-overhang",
    ]) {
      assert.equal(isMeasured(kind), true, `${kind} is a judgement, not an absence`);
    }
  });
});

describe("later venues cannot erase what an earlier one measured", () => {
  it("lets a v4 measurement replace the v3 no-pool it followed", () => {
    // The ordinary path: v3 found no route, v4 found a pool and refused it.
    const rows = [row("MEME", "no-pool", "no Uniswap v3 pool against USDG or WETH")];
    assert.equal(upsertRefusal(rows, row("MEME", "v4-extortionate-fee", "this pool charges 86% a trade")), true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "v4-extortionate-fee");
    assert.match(rows[0]!.reason, /86%/);
  });

  it("REFUSES to let a curve absence overwrite that v4 measurement", () => {
    // The second bug. "I know this token but not where it trades" is the
    // opposite of what v4 had just measured, and it ran afterwards.
    const rows = [row("MEME", "v4-extortionate-fee", "this pool charges 86% a trade")];
    assert.equal(upsertRefusal(rows, row("MEME", "curve-no-curve", "I know this token but not where it trades")), false);
    assert.equal(rows[0]!.kind, "v4-extortionate-fee", "the measurement must survive");
  });

  it("still lets a curve MEASUREMENT replace a no-pool", () => {
    // The behaviour the original comment described and intended, which must
    // keep working: a curve that was read and judged is more informative than
    // the v3 pricer having found no pool.
    const rows = [row("MEME", "no-pool")];
    assert.equal(upsertRefusal(rows, row("MEME", "curve-graduated", "this curve has graduated")), true);
    assert.equal(rows[0]!.kind, "curve-graduated");
  });

  it("lets one measurement update another from the same venue", () => {
    // Two measurements are not an absence overwriting a measurement; the later
    // read is the current one.
    const rows = [row("MEME", "v4-too-thin")];
    assert.equal(upsertRefusal(rows, row("MEME", "v4-extortionate-fee")), true);
    assert.equal(rows[0]!.kind, "v4-extortionate-fee");
  });

  it("adds a token that no venue had refused yet", () => {
    const rows: RefusalRow[] = [];
    assert.equal(upsertRefusal(rows, row("NEW", "curve-no-curve")), true);
    assert.equal(rows.length, 1);
  });

  it("touches only the token named", () => {
    const rows = [row("AAA", "v4-extortionate-fee"), row("BBB", "no-pool")];
    upsertRefusal(rows, row("BBB", "curve-graduated"));
    assert.equal(rows[0]!.kind, "v4-extortionate-fee", "AAA must be untouched");
    assert.equal(rows[1]!.kind, "curve-graduated");
    assert.equal(rows.length, 2, "no duplicate rows");
  });

  it("keeps one row per symbol however many venues refuse it", () => {
    // `poolRefusals` is a Map built from this list, so a duplicate would make
    // which reason wins depend on list order rather than on the rule.
    const rows: RefusalRow[] = [];
    for (const kind of ["no-pool", "v4-too-thin", "curve-no-curve", "v4-extortionate-fee"]) {
      upsertRefusal(rows, row("MEME", kind));
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "v4-extortionate-fee");
  });
});
