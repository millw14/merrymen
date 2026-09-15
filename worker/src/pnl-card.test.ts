import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import {
  formatRoi,
  formatUsdg,
  measure,
  pnlCaption,
  pnlCardFromFill,
  pnlCardSvg,
  roiPercent,
  templatePath,
  type PnlCardData,
} from "./pnl-card";
import { PNL_GLYPHS } from "./pnl-glyphs";

const usdg = (n: number) => BigInt(Math.round(n * 1e6));

const WIN: PnlCardData = {
  symbol: "DOGGOS",
  investedUsdg: usdg(5),
  proceedsUsdg: usdg(17.39),
  realisedUsdg: usdg(12.39),
};

describe("the numbers on the card are the fill's own arithmetic", () => {
  it("formats USDG at 2dp without going through a float", () => {
    assert.equal(formatUsdg(usdg(5)), "5.00");
    assert.equal(formatUsdg(usdg(1840.02)), "1840.02");
    assert.equal(formatUsdg(0n), "0.00");
    // Half-up at the second decimal, not truncation.
    assert.equal(formatUsdg(1_005_000n), "1.01");
    assert.equal(formatUsdg(1_004_999n), "1.00");
  });

  it("keeps full precision on sums a float would round", () => {
    // 9,007,199,254.740993 USDG is past 2^53 base units: if this ever goes
    // through Number the last digit is lost, and a P&L card that disagrees
    // with the ledger is worse than no card.
    assert.equal(formatUsdg(9_007_199_254_740_993n), "9007199254.74");
  });

  it("signs the P&L column and only that column", () => {
    assert.equal(formatUsdg(usdg(12.39), true), "+12.39");
    assert.equal(formatUsdg(usdg(-9.53), true), "-9.53");
    assert.equal(formatUsdg(usdg(12.39)), "12.39");
  });

  it("returns ROI against the capital actually at risk", () => {
    assert.equal(roiPercent(usdg(5), usdg(12.39))?.toFixed(1), "247.8");
    assert.equal(roiPercent(usdg(25), usdg(-9.53))?.toFixed(1), "-38.1");
  });

  it("refuses an ROI with no basis to divide by, rather than inventing one", () => {
    // applyFill books an unbacked sell as realised 0 and flags basisUnknown.
    // Dividing by that zero is where "+0.0%" or "+Infinity%" would come from.
    assert.equal(roiPercent(0n, 0n), null);
    assert.equal(roiPercent(0n, usdg(9.1)), null);
    assert.equal(formatRoi(null), "--");
    assert.equal(formatRoi(Infinity), "--");
  });
});

describe("the overlay lands in the template's own columns", () => {
  const svg = pnlCardSvg(WIN);

  it("is a well-formed 1280x853 overlay, matching pnl/PNL.jpg", () => {
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1280" height="853"/);
    assert.ok(svg.endsWith("</svg>"));
  });

  it("puts each value under the label it belongs to", () => {
    // The baked labels sit at x=50 (invested), x=385 (position), x=723 (pnl),
    // so the first glyph of each value must start there.
    for (const x of [50, 385, 723]) {
      assert.ok(
        svg.includes(`translate(${x} 748)`),
        `no value column starting at x=${x} — the row no longer lines up with the template`,
      );
    }
  });

  it("draws text as PATHS and never as <text>", () => {
    // A <text> element would resolve through the system font stack, which is
    // how a card renders with no numbers on a container with no fonts.
    assert.ok(svg.includes("<path "), "expected glyph paths");
    assert.ok(!/<text[\s>]/.test(svg), "a font-dependent <text> element crept back in");
    assert.ok(!svg.includes("font-family"), "font-family must never appear on this card");
  });

  it("emits one path per glyph, so no attribute can be silently truncated", () => {
    // librsvg stops parsing a `d` past roughly 100kB. "+247.8%" as a single
    // run rendered "+24" with no error anywhere.
    const longest = Math.max(...[...svg.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]!.length));
    assert.ok(longest < 20_000, `a single path is ${longest} chars — close to the limit that truncates`);
  });

  it("colours a win and a loss differently, in both the headline and the column", () => {
    const loss = pnlCardSvg({ ...WIN, realisedUsdg: usdg(-9.53), proceedsUsdg: usdg(15.47) });
    assert.ok(svg.includes("#b6f03c"), "a win should use the template's lime");
    assert.ok(!svg.includes("#ff6b5e"), "a win must not use the loss colour");
    assert.ok(loss.includes("#ff6b5e"), "a loss should be red");
    assert.ok(!loss.includes("#b6f03c"), "a loss must not use the win colour");
  });
});

describe("a card cannot overflow the art it is drawn on", () => {
  it("shrinks a long symbol and a huge ROI to fit, rather than running off", () => {
    // The diagonal pattern starts around x=1000; text reaching it is unreadable.
    const svg = pnlCardSvg({
      symbol: "VERYLONGTICKERNAME",
      investedUsdg: usdg(2.5),
      proceedsUsdg: usdg(1840.02),
      realisedUsdg: usdg(1837.52),
    });
    const xs = [...svg.matchAll(/translate\(([\d.]+) /g)].map((m) => Number(m[1]));
    assert.ok(Math.max(...xs) < 1000, `a glyph starts at x=${Math.max(...xs)}, inside the pattern`);
  });

  it("measures zero for characters it has no outline for", () => {
    // Unknown characters are skipped rather than substituted, so they must not
    // consume width either — otherwise the fit calculation drifts.
    assert.equal(measure("中文", 40), 0);
    assert.ok(measure("5.00", 40) > 0);
  });

  it("drops an unknown character instead of drawing a box", () => {
    const svg = pnlCardSvg({ ...WIN, symbol: "AB中CD" });
    const paths = [...svg.matchAll(/<path /g)].length;
    const plain = [...pnlCardSvg({ ...WIN, symbol: "ABCD" }).matchAll(/<path /g)].length;
    assert.equal(paths, plain, "the unknown character added a glyph");
  });
});

describe("the caption says only what the ledger supports", () => {
  it("states the direction, the return and all three figures", () => {
    const c = pnlCaption(WIN);
    assert.match(c, /DOGGOS closed up \+247\.8%/);
    assert.match(c, /invested 5\.00 USDG/);
    assert.match(c, /back 17\.39 USDG/);
    assert.match(c, /P&L \+12\.39 USDG/);
  });

  it("does not call an unattributable close a profit", () => {
    // The bug this pins: the verb came from the sign of realisedUsdg, and a
    // no-basis sell books a zero that means UNKNOWN — so it read "closed up --".
    const c = pnlCaption({ symbol: "MYSTERY", investedUsdg: 0n, proceedsUsdg: usdg(9.1), realisedUsdg: 0n });
    assert.ok(!/closed up/.test(c), `claimed a gain it cannot know: ${c}`);
    assert.match(c, /isn't attributable/);
  });
});

describe("the template the card is drawn on", () => {
  it("resolves to a file that exists, from this module and not the cwd", () => {
    const p = templatePath();
    assert.ok(existsSync(p), `template missing at ${p}`);
    // A URL-encoded path is the failure this guards: `.pathname` turned
    // "milla projects" into "milla%20projects" and sharp reported a missing file.
    assert.ok(!p.includes("%20"), `template path is URL-encoded: ${p}`);
  });

  it("has an outline for every character a formatted card can print", () => {
    for (const ch of "0123456789+-.%") {
      assert.ok(PNL_GLYPHS[ch], `no baked outline for ${JSON.stringify(ch)}`);
    }
  });
});

describe("a trade row becomes a card only when it closed something knowable", () => {
  const sell = { target: "DOGGOS", fill_side: "sell", fill_cash_usdg: 17.39, realized_pnl_usdg: 12.39 };

  it("recovers the basis exactly from the two columns the row carries", () => {
    // realized = proceeds - costOut, so costOut = proceeds - realized. Reading
    // the basis table instead would be a second source that can disagree with
    // the fill it is describing.
    const card = pnlCardFromFill(sell);
    assert.ok(card);
    assert.equal(formatUsdg(card.investedUsdg), "5.00");
    assert.equal(formatUsdg(card.proceedsUsdg), "17.39");
    assert.equal(formatUsdg(card.realisedUsdg, true), "+12.39");
    assert.equal(card.symbol, "DOGGOS");
  });

  it("carries a loss through with its sign intact", () => {
    const card = pnlCardFromFill({ ...sell, fill_cash_usdg: 15.47, realized_pnl_usdg: -9.53 });
    assert.ok(card);
    assert.equal(formatUsdg(card.investedUsdg), "25.00");
    assert.equal(formatUsdg(card.realisedUsdg, true), "-9.53");
  });

  it("draws nothing for a buy, a refusal, or a sell with no attributable P&L", () => {
    assert.equal(pnlCardFromFill({ ...sell, fill_side: "buy" }), null);
    assert.equal(pnlCardFromFill({ ...sell, fill_side: null }), null);
    // bookFill writes realized_pnl_usdg ONLY when the basis was known, so a
    // null there IS the ledger saying the P&L is not attributable.
    assert.equal(pnlCardFromFill({ ...sell, realized_pnl_usdg: null }), null);
    assert.equal(pnlCardFromFill({ ...sell, realized_pnl_usdg: undefined }), null);
    assert.equal(pnlCardFromFill({ ...sell, fill_cash_usdg: null }), null);
    assert.equal(pnlCardFromFill({ ...sell, target: "  " }), null);
  });

  it("treats a realised zero as a real close, not as absent", () => {
    // Breaking exactly even is a closed trade with a P&L of 0.00, and `0` is
    // falsy — the reason this is checked against null/undefined and not truth.
    const card = pnlCardFromFill({ ...sell, fill_cash_usdg: 5, realized_pnl_usdg: 0 });
    assert.ok(card, "an even close must still produce a card");
    assert.equal(formatUsdg(card.realisedUsdg, true), "+0.00");
    assert.equal(formatUsdg(card.investedUsdg), "5.00");
  });
});
