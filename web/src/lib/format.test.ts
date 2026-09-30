import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  coinPrice,
  compactUsd,
  count,
  dayLabel,
  displayLocale,
  fullDateTime,
  pct,
  pctBps,
  pctPts,
  shortDateTime,
  subCentUsd,
  timeOnly,
  usd,
  usdAdaptive,
  usdFixed,
} from "./format";
import { DEFAULT_LOCALE } from "./locale";

/**
 * THE SEAM, AND THE THREE THINGS IT EXISTS TO STOP.
 *
 * Every figure in the product now passes through format.ts, and today that
 * renders "en-US" for everyone — so the first group below is an ordinary
 * regression pin on what an English reader sees.
 *
 * The second group is the interesting one. It asserts the BEHAVIOUR the seam's
 * design rests on, by running `Intl` directly across the shipped locales. Those
 * claims are the reason the hand-written formatters had to go, and if an ICU
 * upgrade ever changes one of them, this is what says so rather than a user.
 *
 * The third group is a source scan, because a seam that anything can route
 * around is not a seam.
 */

const DASH = "—";

describe("a figure we do not have is never a figure of zero", () => {
  it("every formatter answers with an em dash, never a number", () => {
    // The house rule, stated in format.ts's own header: a null rendered as 0
    // is a claim that a thing was measured and found to be nothing.
    for (const [name, out] of [
      ["usd", usd(null)],
      ["compactUsd", compactUsd(null)],
      ["coinPrice", coinPrice(null)],
      ["pct", pct(null)],
      ["pctPts", pctPts(null)],
      ["pctBps", pctBps(null)],
      ["count", count(null)],
      ["usdAdaptive", usdAdaptive(null)],
      ["subCentUsd", subCentUsd(null)],
      ["usdFixed", usdFixed(null, 2)],
      ["shortDateTime", shortDateTime(null)],
      ["fullDateTime", fullDateTime(null)],
      ["dayLabel", dayLabel(null)],
      ["timeOnly", timeOnly(null)],
    ] as const) {
      assert.equal(out, DASH, `${name}(null) must be an em dash`);
    }
  });

  it("and an unreadable number is the same answer as no number", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(usd(bad), DASH);
      assert.equal(compactUsd(bad), DASH);
      assert.equal(count(bad), DASH);
    }
  });

  it("but a real zero is a real measurement and still renders", () => {
    assert.equal(usd(0), "$0.00");
    assert.equal(count(0), "0");
    assert.equal(pct(0), "0.0%");
  });
});

describe("what an English reader sees, pinned", () => {
  it("money, counts and percentages", () => {
    // Under `node:test` there is no `document`, so `displayLocale()` answers
    // the default — which is the same answer the SERVER gives, and these are
    // therefore the figures the server renders. `en` and `en-US` produce
    // identical output for every shape below; the tag is shorter because it is
    // the one the picker offers.
    assert.equal(displayLocale(), DEFAULT_LOCALE);
    assert.equal(usd(1234.5), "$1,234.50");
    assert.equal(count(1234), "1,234");
    assert.equal(pct(40.8), "+40.8%");
    assert.equal(pct(-2.2), "-2.2%");
    assert.equal(pct(150), "+150%");
    assert.equal(pctPts(2.5), "+2.50%");
    assert.equal(pctPts(-2.5), "-2.50%");
    assert.equal(pctBps(1234), "+12.3%");
    assert.equal(usdAdaptive(12.34), "$12.34");
    assert.equal(usdAdaptive(1284), "$1,284");
  });

  it("pctBps keeps the TRUE MINUS SIGN, which is a grid decision not a typo", () => {
    // These fill a monospace column where a hyphen is too short to read as a
    // minus at a glance. `Intl`'s own signDisplay would give the locale's sign,
    // so the number is formatted unsigned and this sign is prefixed.
    assert.equal(pctBps(-1234), "−12.3%");
    assert.ok(!pctBps(-1234).includes("-"), "a hyphen is not a minus here");
  });

  it("compact notation rounds to something a reader can act on", () => {
    assert.equal(compactUsd(1.234e9), "$1.2B");
    assert.equal(compactUsd(1e6), "$1M");
    assert.equal(compactUsd(84_000), "$84K");
    assert.equal(compactUsd(912), "$912");
    // The hand-written version did Math.round(n / 1e3) and printed "$2k" for
    // this, a third more than the number it was describing.
    assert.equal(compactUsd(1500), "$1.5K");
  });

  it("a coin price keeps its significant figures below a cent", () => {
    // $0.0000 for a coin that genuinely trades at 2.8e-6 is the same failure
    // as rendering a null as zero: a real number displayed as nothing.
    assert.equal(coinPrice(2.8e-6), "$0.00000280");
    assert.equal(coinPrice(0.005), "$0.00500");
    assert.equal(coinPrice(5), "$5.0000");
  });
});

describe("THE THREE CLAIMS THE SEAM RESTS ON", () => {
  const LOCALES = ["en-US", "es-ES", "pt-BR", "id-ID", "vi-VN", "tr-TR", "ru-RU", "th-TH", "zh-CN", "ko-KR", "ja-JP"];

  it("COMPACT NOTATION CANNOT BE A LOOKUP TABLE, because the groups differ", () => {
    // A table keyed on k/M/B has no row that could express these. Chinese,
    // Japanese and Korean regroup at 10^8, so 1.234e9 is twelve-point-three of
    // a unit English does not have a word for.
    const compact = (l: string) =>
      new Intl.NumberFormat(l, {
        style: "currency",
        currency: "USD",
        notation: "compact",
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }).format(1.234e9);
    assert.ok(compact("zh-CN").includes("亿"), "Chinese regroups at 10^8");
    assert.ok(compact("ja-JP").includes("億"), "Japanese regroups at 10^8");
    assert.ok(compact("ko-KR").includes("억"), "Korean regroups at 10^8");
    assert.ok(compact("ru-RU").includes("млрд"), "Russian names the unit");
    // And the reason it matters beyond aesthetics: "B" is a FALSE FRIEND. On
    // the long scale — German, Italian, Spanish, Dutch, European Portuguese —
    // a billion is 10^12, so "$1.2B" read there is a thousandfold overstatement
    // with nothing on screen to notice.
    assert.ok(!compact("es-ES").includes("B"), "Spanish must not be handed a bare B");
  });

  it("A HAND-WRITTEN SIGN LANDS IN THE WRONG PLACE in Turkish", () => {
    // Turkish writes the percent symbol before the number, so the old
    // `${n > 0 ? "+" : ""}${n}%` produced a sign and a symbol at opposite ends.
    const tr = new Intl.NumberFormat("tr-TR", {
      style: "percent",
      signDisplay: "exceptZero",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(0.408);
    assert.equal(tr, "+%40,8");
    assert.ok(tr.indexOf("%") < tr.indexOf("4"), "the symbol precedes the digits");
  });

  it("THE CURRENCY SYMBOL IS NOT ALWAYS A PREFIX", () => {
    // `$${n}` is wrong for five of the eleven shipped locales.
    const money = (l: string) =>
      new Intl.NumberFormat(l, { style: "currency", currency: "USD" }).format(1234.5);
    for (const l of ["es-ES", "vi-VN", "ru-RU"]) {
      assert.ok(/[\d\s]$|\$$/.test(money(l).trim().slice(-1)) || !money(l).startsWith("$"),
        `${l} does not lead with the symbol: ${money(l)}`);
    }
  });

  it("and every shipped locale renders in Latin digits, which the money face requires", () => {
    // Geist Pixel is the face used for every balance, at 52-56px, and its
    // unicode-range covers Latin only. A locale that switched the digit SET
    // would paint the balance in a fallback face inside a box laid out for a
    // different one.
    for (const l of LOCALES) {
      const out = new Intl.NumberFormat(l, {
        numberingSystem: "latn",
        style: "currency",
        currency: "USD",
      }).format(1234.5);
      assert.ok(/[0-9]/.test(out), `${l} must render ASCII digits: ${out}`);
      assert.ok(!/[٠-٩۰-۹๐-๙]/.test(out), `${l} leaked non-Latin digits`);
    }
  });
});

describe("the seam is the only way through", () => {
  const SRC = fileURLToPath(new URL("../..", import.meta.url));

  /** Every non-test source file, from git so ignored paths cannot pollute it. */
  function sources(): string[] {
    const out = execFileSync("git", ["ls-files", "src"], { cwd: SRC, encoding: "utf8" });
    return out
      .split("\n")
      .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."));
  }

  it("NO CALL SITE NAMES A LOCALE OF ITS OWN", () => {
    // Ten sites pinned "en-US" and one passed `undefined`, which means the
    // browser's locale — so the chat confirmation card, the last sentence read
    // before an order is placed, rendered its number in a different system
    // from the balance above it. One answer for the whole app, or none.
    const offenders: string[] = [];
    for (const f of sources()) {
      if (f.endsWith("src/lib/format.ts")) continue; // the seam itself
      const body = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
      for (const m of body.matchAll(/\.toLocale(?:String|DateString|TimeString)\(/g)) {
        // A comment explaining what was removed is not a call site.
        const line = body.slice(body.lastIndexOf("\n", m.index) + 1, body.indexOf("\n", m.index));
        if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) continue;
        offenders.push(`${f}: ${line.trim().slice(0, 90)}`);
      }
    }
    assert.deepEqual(offenders, [], "these must go through format.ts");
  });

  it("and NO CALL SITE PUTS A CURRENCY SYMBOL THERE ITSELF", () => {
    // `$${n}` is the other way round the seam, and it is wrong in five of the
    // eleven shipped locales before anyone has typed a translation: Spanish,
    // Vietnamese, Russian and Indonesian suffix the symbol, Brazilian
    // Portuguese writes `US$ `.
    //
    // MATCHED ON THE LITERAL `$`, not on what follows it. The first version of
    // this test looked for `$${n.toFixed(2)}` — the shape that existed at the
    // time — so when those call sites were rewritten to `$${usd(n)}` the test
    // went green while the screen read `$$50.00`. A dollar sign glued to an
    // interpolation is the defect; what is inside the braces is beside the
    // point.
    const offenders: string[] = [];
    for (const f of sources()) {
      if (f.endsWith("src/lib/format.ts")) continue;
      const body = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
      for (const m of body.matchAll(/\$\$\{([^}]{1,60})\}/g)) {
        const line = body.slice(body.lastIndexOf("\n", m.index) + 1, body.indexOf("\n", m.index));
        if (/^\s*(\*|\/\/)/.test(line)) continue; // prose about the rule
        offenders.push(`${f}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, [], "a currency symbol is the locale's to place");
  });
});
