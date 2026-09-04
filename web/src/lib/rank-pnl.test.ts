import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankPnl, unrankedLabel, unrankedShort } from "./rank-pnl";

/**
 * A PUBLIC RANKING MAY NOT PUBLISH A NUMBER IT CANNOT BACK.
 *
 * This shipped and was caught in production within the hour. The board showed
 * an agent at **+2643.3%**, top of the table, and every figure behind it was
 * real — the arithmetic was simply measuring the wrong two things against each
 * other:
 *
 *   equity curve : a flat 1000.0000 across all 39 points
 *   contributed  : about 36 USDG
 *   landed       : 0        refused: 1,225
 *
 * 1000.0000, flat, is the PAPER BOOK'S OPENING BALANCE. `agents.mode` is only
 * the last heartbeat's value and `equity` carries no per-row mode, so an agent
 * that wrote those rows while simulating and is labelled live now hands the
 * ranking a pretend balance to divide by a real deposit.
 *
 * The fix is not a smarter formula, it is a refusal: an agent that has never
 * filled a trade has not produced a return, and the board already has a word
 * for that.
 */

describe("what may be ranked", () => {
  it("ranks an agent that actually traded", () => {
    const r = rankPnl({ contributed: 500, latest: 612.4, gasUsdg: 0.04, landed: 3, contributionsKnown: true });
    assert.equal(r.unrankedWhy, null);
    // (612.4 − 500 − 0.04) / 500 = 22.47%
    assert.equal(r.pnlBps, 2247);
  });

  it("a loss is published as readily as a gain", () => {
    const r = rankPnl({ contributed: 250, latest: 231.8, gasUsdg: 0.04, landed: 2, contributionsKnown: true });
    assert.equal(r.pnlBps, -730);
  });

  it("THE +2643% ROW: pretend equity over a real deposit is NOT a return", () => {
    // The exact production figures.
    const r = rankPnl({ contributed: 36.45, latest: 1000, gasUsdg: 0, landed: 0 });
    assert.equal(r.pnlBps, null, "an agent with no fills has no return to publish");
    assert.equal(r.unrankedWhy, "never-filled");
  });

  it("no deposit and no fill are DIFFERENT answers", () => {
    // Only one of them is fixed by depositing, so the page must not say the
    // wrong one — it would send an owner to do work that will not help.
    assert.equal(rankPnl({ contributed: null, latest: 100, gasUsdg: 0, landed: 9 }).unrankedWhy, "no-deposit");
    assert.equal(rankPnl({ contributed: 0, latest: 100, gasUsdg: 0, landed: 9 }).unrankedWhy, "no-deposit");
    assert.equal(rankPnl({ contributed: 100, latest: 120, gasUsdg: 0, landed: 0 }).unrankedWhy, "never-filled");
  });

  it("an equity reading is required, not assumed", () => {
    // A funded agent that has filled but whose equity history is missing has an
    // unknown return, not a zero one.
    const r = rankPnl({ contributed: 100, latest: null, gasUsdg: 0, landed: 4 });
    assert.equal(r.pnlBps, null);
  });

  it("never returns a number and a reason at the same time", () => {
    // They are the two arms of one answer; both set would mean the page could
    // render a rank and an excuse for not having one.
    for (const a of [
      { contributed: 500, latest: 600, gasUsdg: 0, landed: 1, contributionsKnown: true },
      { contributed: null, latest: 600, gasUsdg: 0, landed: 1 },
      { contributed: 500, latest: 600, gasUsdg: 0, landed: 0 },
      { contributed: 500, latest: null, gasUsdg: 0, landed: 1 },
    ]) {
      const r = rankPnl(a);
      assert.equal(
        (r.pnlBps === null) !== (r.unrankedWhy === null),
        true,
        `exactly one of pnlBps / unrankedWhy must be set for ${JSON.stringify(a)}`,
      );
    }
  });

  it("AN UNEVIDENCED DENOMINATOR IS NOT A RETURN", () => {
    // The whole reason this arm exists. A hosted redeploy used to book the
    // account's entire balance as a fresh "opening balance" contribution, so the
    // denominator was inflated by capital that never arrived. Every figure was a
    // real column; the arithmetic was over a number nobody could point at.
    const r = rankPnl({ contributed: 500, latest: 612.4, gasUsdg: 0, landed: 3, contributionsKnown: false });
    assert.equal(r.pnlBps, null, "a percentage over inference is worse than a dash");
    assert.equal(r.unrankedWhy, "contributions-unevidenced");
  });

  it("NOT ASSESSED IS NOT PERMISSION — and it is its own answer", () => {
    // NULL means the worker has not written a verdict for this agent yet. It is
    // not false (the capital may be perfectly evidenced) and it is certainly not
    // true. Both wrong answers are available and neither is taken.
    for (const q of [null, undefined]) {
      const r = rankPnl({ contributed: 500, latest: 612.4, gasUsdg: 0, landed: 3, contributionsKnown: q });
      assert.equal(r.pnlBps, null);
      assert.equal(r.unrankedWhy, "quality-unknown");
    }
    // And a caller written before quality existed gets the same refusal rather
    // than silently keeping its old behaviour.
    assert.equal(rankPnl({ contributed: 500, latest: 612.4, gasUsdg: 0, landed: 3 }).unrankedWhy, "quality-unknown");
  });

  it("the four refusals are DIFFERENT answers, and each has its own words", () => {
    // Only one of them is fixed by depositing and only one by waiting, so a page
    // that collapses them sends an owner to do work that will not help.
    const seen = new Set<string>();
    for (const why of ["no-deposit", "never-filled", "contributions-unevidenced", "quality-unknown"] as const) {
      seen.add(unrankedLabel(why));
      seen.add(unrankedShort(why));
      assert.notEqual(unrankedLabel(why), "", `${why} must have words`);
    }
    assert.equal(seen.size, 8, "no two refusals may share a label");
  });

  it("evidence is checked LAST, so the more basic refusals still win", () => {
    // An unfunded agent should be told to fund, not that its (absent) capital
    // cannot be evidenced.
    assert.equal(
      rankPnl({ contributed: null, latest: 100, gasUsdg: 0, landed: 9, contributionsKnown: false }).unrankedWhy,
      "no-deposit",
    );
    assert.equal(
      rankPnl({ contributed: 100, latest: 100, gasUsdg: 0, landed: 0, contributionsKnown: false }).unrankedWhy,
      "never-filled",
    );
  });

  it("gas is charged against the return, not ignored", () => {
    const withGas = rankPnl({ contributed: 100, latest: 110, gasUsdg: 5, landed: 1, contributionsKnown: true }).pnlBps;
    const without = rankPnl({ contributed: 100, latest: 110, gasUsdg: 0, landed: 1, contributionsKnown: true }).pnlBps;
    assert.equal(without, 1000);
    assert.equal(withGas, 500, "net of gas, or the board overstates every agent");
  });
});
