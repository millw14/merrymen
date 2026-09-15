/**
 * ENTRY MUST LEAVE ROOM BEFORE THE EXIT'S OWN DEADLINE.
 *
 * `PonsClassVault.sell` reverts `CurveGraduated()` by name, so a position whose
 * curve graduates stops being sellable through the vault and needs the owner's
 * own sweep. Graduation is the SUCCESS case — the better the token does, the
 * sooner its exit closes.
 *
 * `proposeClassExits` sells at `classExitAtGraduationPct` for exactly that
 * reason. Entry had no ceiling at all, so the route would buy at 84% against an
 * 85% exit: one percent of a curve to live in, and the two likeliest outcomes
 * are a forced sale within a tick or two (paying two lots of 99bps curve fees
 * for nothing) or a graduation that traps the position.
 *
 * Asserted against the SOURCE because `proposeClassEntries` is a closure inside
 * a 9,000-line tick with a live chain client, a grant and a store behind it —
 * there is no seam to call it through. So these pin the properties that would
 * be silently lost: that the ceiling exists, that it is derived from the exit
 * rather than configured apart from it, and that an unreadable progress is
 * refused rather than treated as early.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "index.ts"), "utf8");
/** Comments quote the thresholds they explain; only real code counts. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the class route will not buy into a closing exit", () => {
  it("HAS AN ENTRY CEILING AT ALL", () => {
    assert.match(CODE, /CLASS_ENTRY_GRADUATION_MARGIN_BPS/, "the margin constant must exist");
    assert.match(CODE, /entryCeilingBps/, "and be applied as a ceiling on entry");
  });

  it("DERIVES IT FROM THE EXIT, so the two cannot be configured into contradiction", () => {
    // A second setting would let an owner set entry 90 / exit 85 and buy
    // straight past the deadline. The subtraction is what makes that
    // unrepresentable.
    assert.match(
      CODE,
      /entryCeilingBps\s*=\s*exitAtBps\s*-\s*CLASS_ENTRY_GRADUATION_MARGIN_BPS/,
      "the ceiling must be the exit minus the margin",
    );
    assert.match(CODE, /exitAtBps\s*=\s*cfg\.classExitAtGraduationPct\s*\*\s*100/);
  });

  it("and the margin is real room, not a token gap", () => {
    const m = CODE.match(/CLASS_ENTRY_GRADUATION_MARGIN_BPS\s*=\s*([0-9_]+)/);
    assert.ok(m, "the margin must be a literal this test can read");
    const bps = Number(m[1]!.replace(/_/g, ""));
    assert.ok(bps >= 500, `a ${bps}bps margin is not room to hold a position in`);
  });

  it("REFUSES an unreadable progress rather than reading it as early", () => {
    // The null-is-not-zero rule, on the one measurement that decides whether a
    // position can be got out of. A curve whose progress cannot be read is one
    // whose deadline cannot be read either.
    assert.match(CODE, /progress\s*===\s*null/);
    assert.match(SRC, /could not be read, and a position that graduates cannot be sold/);
  });

  it("measures with the SAME function the exit uses", () => {
    // Two measures of "how far along is this curve" would disagree exactly at
    // the boundary, which is the only place this matters.
    const entry = CODE.includes("const progress = curveDepthFraction(leg.reserves)");
    const exit = CODE.includes("curveDepthFraction(reserves)");
    assert.ok(entry, "entry must use curveDepthFraction");
    assert.ok(exit, "and so must the exit");
  });

  it("and refuses outright when the exit is set so low there is no room to enter", () => {
    assert.match(CODE, /entryCeilingBps\s*<=\s*0/);
    assert.match(SRC, /leaves no room to enter below it/);
  });

  it("the ceiling is checked BEFORE the trade is built", () => {
    // A check after the intent is constructed would still refuse, but the
    // ordering is what keeps the refusal legible in the log alongside the other
    // sizing refusals rather than arriving from the executor.
    const ceiling = CODE.indexOf("progressBps > entryCeilingBps");
    const intent = CODE.indexOf('kind: "curve-trade"');
    assert.ok(ceiling > 0 && intent > 0, "both landmarks must exist");
    assert.ok(ceiling < intent, "the ceiling must gate the intent, not follow it");
  });
});
