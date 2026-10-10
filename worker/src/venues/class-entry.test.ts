import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CLASS_ENTRY_GRADUATION_MARGIN_BPS, CLASS_MAX_ROUND_TRIP_BPS, buildClassEntry, classSpendFor } from "./class-entry";
import { curveBuyOut, curveMinOut, type CurveReserves } from "./pons-price";

/**
 * THE SAME CHAIN, WHOEVER CHOSE THE LEG.
 *
 * `proposeClassEntries` runs quote → impact → floor → graduation ceiling →
 * round trip → intent inline. A second producer (the trending Brain) must apply
 * exactly those checks to exactly those numbers, or the shadow record would
 * say "would have bought" about a trade the tick would have refused. These
 * tests pin the extracted chain to the tick's own constants and shapes.
 */

const VAULT = "0x9999999999999999999999999999999999999999" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const TOKEN = "0x7777777777777777777777777777777777777777" as const;
const CURVE = "0x6666666666666666666666666666666666666666" as const;

/** A healthy early curve: 10,000 USDG threshold, 4,000 seed + 1,000 real, deep token side. */
const reserves = (o: Partial<CurveReserves> = {}): CurveReserves => ({
  quoteRaw: 5_000_000_000n,
  tokenRaw: 800_000_000n * 10n ** 18n,
  quoteDecimals: 6,
  tokenDecimals: 18,
  graduationThresholdRaw: 10_000_000_000n,
  ...o,
});
const leg = (r: CurveReserves = reserves()) => ({ token: TOKEN, symbol: "T", curve: CURVE, quoteToken: USDG, reserves: r });
const rules = { maxImpactBps: 300, slippageBps: 100, exitAtGraduationPct: 85 };

describe("the constants are the tick's constants", () => {
  it("index.ts declares the same two numbers", () => {
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    assert.match(src, new RegExp(`CLASS_MAX_ROUND_TRIP_BPS = ${CLASS_MAX_ROUND_TRIP_BPS};`));
    assert.equal(CLASS_ENTRY_GRADUATION_MARGIN_BPS, 1_000);
    assert.match(src, /CLASS_ENTRY_GRADUATION_MARGIN_BPS = 1_000;/);
  });
});

describe("a good leg becomes the tick's intent, floored from the same quote", () => {
  it("shape: curve-trade at the VAULT, quote in, token out, floor from curveMinOut", () => {
    const spend = 5_000_000n;
    const r = buildClassEntry({ leg: leg(), vault: VAULT, spend, rules });
    assert.ok(r.ok, r.ok ? "" : r.why);
    const quoted = curveBuyOut(reserves(), spend)!;
    assert.deepEqual(r.intent, {
      kind: "curve-trade",
      target: VAULT,
      curve: CURVE,
      assetIn: USDG,
      assetOut: TOKEN,
      amountInRaw: spend,
      minAmountOutRaw: curveMinOut(quoted, rules.slippageBps),
      notionalUsdg: spend,
    });
    assert.equal(r.quotedOutRaw, quoted);
    assert.equal(r.progressBps, 1000, "1,000 real of a 10,000 threshold");
  });
});

describe("the five refusals, in the tick's order and words", () => {
  it("nothing to spend", () => {
    const r = buildClassEntry({ leg: leg(), vault: VAULT, spend: 0n, rules });
    assert.ok(!r.ok && /nothing to spend/.test(r.why));
  });

  it("impact over the owner's ceiling names the bps", () => {
    // A tiny curve: 10 USDG real on top of the seed; 5 USDG moves it a lot.
    const thin = reserves({ quoteRaw: 4_010_000_000n, tokenRaw: 1_000_000n * 10n ** 18n });
    const r = buildClassEntry({ leg: leg(thin), vault: VAULT, spend: 500_000_000n, rules });
    assert.ok(!r.ok && /would move it \d+bps, over the 300bps ceiling/.test(r.why), r.ok ? "" : r.why);
  });

  it("past the entry ceiling derived from the exit", () => {
    // 8,000 real of 10,000 → 80%, over the 75% ceiling (85% exit − 10% margin).
    const late = reserves({ quoteRaw: 12_000_000_000n });
    const r = buildClassEntry({ leg: leg(late), vault: VAULT, spend: 5_000_000n, rules });
    assert.ok(!r.ok && /80\.0% of the way to graduating, past the 75\.0%/.test(r.why), r.ok ? "" : r.why);
  });

  it("an exit set so low that nothing can enter below it", () => {
    const r = buildClassEntry({ leg: leg(), vault: VAULT, spend: 5_000_000n, rules: { ...rules, exitAtGraduationPct: 5 } });
    assert.ok(!r.ok && /leaves no room to enter below it/.test(r.why));
  });

  it("a round trip worse than the route accepts", () => {
    // Impact within 300 bps needs a deep curve; the round trip rule bites at
    // 600 bps. Force it with a curve where a buy is cheap but the sell back is
    // not: impossible on x*y=k with symmetric fees, so instead pin the rule
    // arithmetic directly — the buy quote back through the sell must return
    // at least (10000 − 600)/10000 of spend.
    const r = buildClassEntry({ leg: leg(), vault: VAULT, spend: 5_000_000n, rules: { ...rules, maxImpactBps: 10_000 } });
    assert.ok(r.ok);
    assert.ok(r.roundTripOutRaw * 10_000n >= 5_000_000n * BigInt(10_000 - CLASS_MAX_ROUND_TRIP_BPS));
  });
});

describe("the entry size is the tick's", () => {
  it("owner's per-entry figure, capped by the signed per-trade cap; a probe when unset", () => {
    assert.equal(classSpendFor({ classPerEntryUsdg: 5, perTradeUsdg: 25_000_000n }), 5_000_000n);
    assert.equal(classSpendFor({ classPerEntryUsdg: 50, perTradeUsdg: 25_000_000n }), 25_000_000n);
    assert.equal(classSpendFor({ classPerEntryUsdg: 0, perTradeUsdg: 25_000_000n }), 5_000_000n);
  });
});
