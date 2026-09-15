/**
 * A FUNNEL CENSUS THAT DOES NOT ADD UP IS WORSE THAN NO CENSUS.
 *
 * `PonsScanCensus` was written to settle one disagreement: the chain and the
 * launch parser both put USDG-quoted launches near 10-18%, and the class
 * producer's feed showed ~0.5%. It answers by counting the launches dropped at
 * each of the four stages between them, plus the quote mix on either side of
 * the filter.
 *
 * Its whole value rests on the counts closing:
 *
 *     considered = dropSeen + dropUnreadable + dropGraduated + dropShallow + found
 *
 * If one `continue` in that loop leaves without incrementing anything, the
 * arithmetic silently springs a leak — and a leak in a diagnostic reads as a
 * real drop with no stage attached, which is the single most misleading thing
 * this file could produce. I would go looking for a fifth filter that does not
 * exist.
 *
 * THESE ARE SOURCE-READ, deliberately. `discoverPonsLaunches` takes a live viem
 * client and reads logs and contracts; this repo has no fixture for one, and
 * building a fake deep enough to drive four distinct drop paths would be
 * asserting against my own mock rather than against the function. The property
 * is structural anyway — "every exit from the loop is accounted for" is a fact
 * about the code's shape, and a shape test cannot pass on a branch that never
 * ran, which is precisely the risk with a mocked client.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SRC = readFileSync(new URL("./discovery.ts", import.meta.url), "utf8");

/** The filter loop, from its head to the start of the enrichment pass. */
const LOOP = SRC.slice(SRC.indexOf("  for (const launch of considered) {"), SRC.indexOf("  const found: Discovery[] = [];"));

describe("the Pons scan census closes", () => {
  it("every early exit from the filter loop increments exactly one counter", () => {
    // Split on `continue;` — each fragment is one path out of the loop, and the
    // increment that accounts for it must be inside that fragment, not merely
    // somewhere in the file.
    const exits = LOOP.split("continue;").slice(0, -1);
    assert.ok(exits.length >= 4, `expected at least four drop paths, found ${exits.length}`);
    for (const exit of exits) {
      const bumps = exit.match(/census\.drop[A-Za-z]+ \+= 1;/g) ?? [];
      // The LAST bump in the fragment is the one guarding this continue; an
      // earlier fragment's bump cannot appear here because the split consumed
      // its `continue`.
      assert.equal(
        bumps.length,
        1,
        `a path out of the filter loop counts ${bumps.length} drops instead of 1:\n${exit.trim().slice(-240)}`,
      );
    }
  });

  it("names all four drop reasons, so a drop always has a stage attached", () => {
    // A single `dropped` total would report the same number and answer nothing:
    // "the dedupe ate them" and "they were all too shallow" are different bugs
    // with different fixes, and the ratio line that existed before could not
    // distinguish them.
    for (const field of ["dropSeen", "dropUnreadable", "dropGraduated", "dropShallow"]) {
      assert.ok(LOOP.includes(`census.${field} += 1;`), `${field} is never counted`);
    }
  });

  it("counts the quote mix going IN after the dedupe, not before it", () => {
    // `quoteIn` is compared against the chain's own mix, so it must describe
    // launches this pass actually evaluated. Counted before the dedupe it would
    // include rows already discovered on an earlier pass and drift upward on
    // every re-scan of an overlapping window — a number that looks like a
    // measurement and tracks the overlap setting instead.
    const seenDrop = LOOP.indexOf("census.dropSeen += 1;");
    const mixIn = LOOP.indexOf("bumpQuote(census.quoteIn");
    assert.ok(seenDrop >= 0 && mixIn >= 0);
    assert.ok(mixIn > seenDrop, "quoteIn must be tallied after the dedupe drop");
  });

  it("counts the quote mix coming OUT only for rows that actually survive", () => {
    // quoteOut must match `found`, or the comparison between the two mixes —
    // the entire point — is between populations of different sizes.
    const mixOut = LOOP.indexOf("bumpQuote(census.quoteOut");
    const push = LOOP.indexOf("survivors.push(");
    assert.ok(mixOut >= 0 && push > mixOut, "quoteOut is tallied on the survivor path");
    // And nothing between them can skip the push.
    assert.doesNotMatch(LOOP.slice(mixOut, push), /continue;|return/);
  });

  it("returns an all-zero census on the failed path, and the caller does not print it", () => {
    // The measured-zero-vs-no-measurement rule. A refused scan must not report
    // "0 launches, 0 USDG" as though it had looked — so the caller returns
    // before the census line rather than printing zeroes.
    const failLine = SRC.slice(SRC.indexOf("if (scan.failed) return {"));
    assert.match(failLine.slice(0, 200), /census \}/, "the failed path returns the untouched census");

    const IDX = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const pons = IDX.slice(IDX.indexOf("if (scan.failed) {"), IDX.indexOf("[pons census]"));
    assert.match(pons, /return;/, "the caller returns on a refused scan");
    // The census line sits after `lastPonsAt = nowSec`, which only a successful
    // scan reaches.
    assert.ok(
      IDX.indexOf("lastPonsAt = nowSec;") < IDX.indexOf("[pons census]"),
      "the census line is only reached by a scan that succeeded",
    );
  });

  it("is emitted even when the pass finds nothing, which is the pass that happens", () => {
    // The whole reason this exists. `!scan.found.length` returns early with at
    // most a bare count, and that is the overwhelmingly common outcome — so a
    // census printed only on a productive pass would never print at all during
    // exactly the stretch anyone wants to inspect.
    const IDX = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.ok(
      IDX.indexOf("[pons census]") < IDX.indexOf("if (!scan.found.length) {"),
      "the census must be emitted before the nothing-found return",
    );
  });
});
