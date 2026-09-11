/**
 * THE CENSUS MUST AGREE WITH THE QUERY IT IS MEASURING.
 *
 * `classCandidateCensus` exists to answer one question — where the USDG-quoted
 * candidates go between the launch scan and the class producer — by counting
 * the same population at three narrowing stages. That only works if all three
 * stages define "a candidate" the way `recentCandidates` does.
 *
 * The first draft did not. It tested `curve IS NOT NULL` at the early stages
 * and `quote_token != null` at the last, while `recentCandidates` requires all
 * three columns together. A row with a curve and no threshold was therefore a
 * candidate at one stage and not the next, and the census would have reported a
 * drop that was purely its own definition changing. A diagnostic that invents a
 * discrepancy is worse than no diagnostic: it sends you hunting a bug in code
 * that is behaving — exactly the hours this census was written to save.
 *
 * Two of these are behavioural, over real sqlite, asserting the census against
 * what the producer actually receives rather than against hand-counted
 * constants. Two are source-read, and each says in place why it has to be:
 * the state they describe is not reachable through the public API.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-census-"));
process.env.MERRYMEN_HOME = HOME;

const { initStore, classCandidateCensus, recentCandidates, recordCandidate } = await import("./store");
const { CASH } = await import("@merrymen/core");

await initStore();
after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* Windows holds the sqlite handle a moment longer; the dir is disposable */
  }
});

const STORE = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
const CENSUS_SRC = STORE.slice(
  STORE.indexOf("export async function classCandidateCensus("),
  STORE.indexOf("export async function recentCandidates("),
);
const RECENT_SRC = STORE.slice(STORE.indexOf("export async function recentCandidates("));

const NATIVE = `0x${"0".repeat(40)}`;
const USDG = CASH.USDG as string;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

/** A launch-scan row, shaped exactly as runPonsDiscovery writes one. */
const launch = async (n: number, quote: string, opts: { curve?: boolean } = {}) =>
  recordCandidate({
    address: addr(n),
    symbol: `T${n}`,
    decimals: 18,
    liquidityUsd: 0,
    fdvUsd: 0,
    firstSeen: 0,
    ...(opts.curve === false
      ? {}
      : { curve: { curve: addr(n + 0x1000), quoteToken: quote, graduationThresholdRaw: "4200000000000000000" } }),
  });

describe("the candidate census measures the producer's own slice", () => {
  it("counts exactly the rows recentCandidates hands over with a curve", async () => {
    // Six USDG and six native, interleaved so neither is favoured by insertion
    // order, plus one row with no curve at all — the pool discoverer's shape.
    for (let i = 1; i <= 12; i += 1) await launch(i, i % 2 === 0 ? USDG : NATIVE);
    await launch(99, NATIVE, { curve: false });

    const rows = await recentCandidates(6 * 3600, 40);
    const withCurve = rows.filter((r) => r.curve);
    const census = await classCandidateCensus(6 * 3600, 40);
    assert.ok(census, "the census must be readable over a healthy store");

    // THE PROPERTY. Not "12" or any other constant — the census's own idea of
    // the returned population must equal the producer's, whatever the fixture.
    assert.equal(census.returned, withCurve.length);
    assert.ok(census.returned > 0, "a fixture that returns nothing would assert nothing");
    assert.equal(
      census.usdgReturned,
      withCurve.filter((r) => r.curve!.quoteToken.toLowerCase() === USDG.toLowerCase()).length,
    );
    // The three buckets must partition the returned slice. If they did not, a
    // missing USDG row could hide in an arithmetic gap rather than showing as a
    // drop — which is the one thing this diagnostic must never do.
    assert.equal(census.usdgReturned + census.nativeReturned + census.otherReturned, census.returned);
    // And the curveless row is a candidate at no stage.
    assert.equal(census.allWithCurve, 12);
  });

  it("shows displacement by the LIMIT, which is the whole point of three stages", async () => {
    // The hypothesis the census was written to test: USDG rows exist but are
    // pushed out of the 40-row slice by newer ones. A LIMIT of 2 against a
    // table of twelve reproduces it deterministically.
    const narrow = await classCandidateCensus(6 * 3600, 2);
    const wide = await classCandidateCensus(6 * 3600, 1000);
    assert.ok(narrow && wide);
    assert.ok(narrow.returned <= 2, "the slice honours the LIMIT");
    assert.ok(wide.returned > narrow.returned, "and widening it returns more");
    // `allWithCurve` is LIMIT-independent by construction. If it moved with the
    // LIMIT, the census would be measuring the slice at all three stages and
    // could never tell "displaced by newer rows" from "never written at all" —
    // which are the two answers it exists to separate.
    assert.equal(narrow.allWithCurve, wide.allWithCurve);
    assert.equal(narrow.usdgAll, wide.usdgAll);
  });

  it("uses the SAME three-column predicate at every stage, by construction", () => {
    // The half-written row — a curve and a quote token but no threshold — is
    // what broke the first draft, and it is NOT reachable through the public
    // API: recordCandidate writes the three columns together or not at all, and
    // the upsert COALESCEs each one, so they move as a unit.
    //
    // That is precisely why this is pinned rather than exercised. A drift
    // between the census's predicate and recentCandidates' produces no failure
    // today and a phantom drop the moment anything writes the columns
    // separately — and being trusted about drops is the census's only job.
    assert.match(
      CENSUS_SRC,
      /const HAS_CURVE = `curve IS NOT NULL AND quote_token IS NOT NULL AND graduation_threshold IS NOT NULL`/,
      "one predicate, defined once",
    );
    assert.equal(
      (CENSUS_SRC.match(/\$\{HAS_CURVE\}/g) ?? []).length,
      5,
      "and interpolated into every counting query, so no stage can be edited out of step",
    );
    // Any surviving bare `curve IS NOT NULL` is a stage that kept its own
    // shorter definition. Two things legitimately contain that string and must
    // come out first: the declaration above, and the COMMENTS — this codebase
    // explains its refusals right where it makes them, so the prose describing
    // the forbidden shape would otherwise fail the rule forbidding it. Same
    // strip, same reason, as web/src/app/settings/honesty.test.ts.
    const code = CENSUS_SRC.replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/const HAS_CURVE = `[^`]*`;/, "");
    assert.doesNotMatch(code, /curve IS NOT NULL/, "no stage may keep a shorter predicate of its own");

    // The JS-side slice filter cannot use the SQL constant — the LIMIT is
    // applied by the database, so filtering in SQL would refill the window from
    // older rows and measure a slice the producer never receives. It must
    // therefore test the same three columns as recentCandidates' own mapping.
    const shape = /r\.curve != null && r\.quote_token != null && r\.graduation_threshold != null/;
    assert.match(CENSUS_SRC, shape, "the returned-slice filter");
    assert.match(RECENT_SRC, shape, "and the query it is measuring");
  });

  it("an unreadable census reads as unavailable, not as zero candidates", () => {
    // A negative LIMIT was my first attempt at forcing the failure and it is
    // not one — sqlite reads LIMIT -1 as unlimited, so it returned a perfectly
    // good census and the test was asserting a fiction. No public API breaks
    // the read, so the property is pinned where it actually matters: at the
    // caller, which must not print a failed read as an empty table.
    const IDX = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const handler = IDX.slice(IDX.indexOf("const cc = await classCandidateCensus("));
    assert.match(handler.slice(0, 200), /if \(cc\) \{/, "a null census must not fall through into the counts");
    const nullArm = handler.slice(handler.indexOf("} else {"), handler.indexOf("if (candidates.length === 0)"));
    assert.match(nullArm, /unavailable, not zero/, "the empty-vs-unavailable rule, said out loud");
    // And the census still swallows its own errors rather than taking a tick
    // down with it — a diagnostic must never be the thing that breaks one.
    assert.match(CENSUS_SRC, /\} catch \{[\s\S]*?return null;/);
  });
});
