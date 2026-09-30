import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAmount, toAsciiDigits, type AmountField } from "./parse-amount";

/**
 * THE PROMISE: THE APP NEVER GUESSES WHICH NUMBER SOMEBODY MEANT.
 *
 * Every case below is a real string a real keyboard produces. The ones that
 * matter most are not the refusals — they are the two places where a plausible
 * implementation silently returns the wrong number:
 *
 *   `10,50` stripped of commas is 1050, a hundred times too big.
 *   `1.000` read by `Number` is 1, a thousand times too small.
 *
 * The second is not hypothetical. It is what the settings route does today.
 */

/** Money: dollars and cents, the shape of a per-trade cap. */
const MONEY: AmountField = { maxDecimals: 2, min: 0.01, max: 1_000_000 };
/** A whole-number guard, the shape of `minPoolLiquidityUsdg`. */
const WHOLE: AmountField = { maxDecimals: 0, min: 0, max: 100_000_000 };

describe("the decimal separator is read, not assumed", () => {
  it("ACCEPTS A COMMA DECIMAL, which most of the world types", () => {
    // The field is inputMode="decimal", which renders a comma key on a Spanish,
    // German, French, Portuguese, Turkish or Indonesian keyboard. Refusing the
    // separator we asked for is the dead end the bug report described.
    assert.deepEqual(parseAmount("10,50", MONEY), { ok: true, value: 10.5 });
    assert.deepEqual(parseAmount("2,5", MONEY), { ok: true, value: 2.5 });
    assert.deepEqual(parseAmount("0,01", MONEY), { ok: true, value: 0.01 });
  });

  it("still accepts a dot decimal, because nothing about English changed", () => {
    assert.deepEqual(parseAmount("10.50", MONEY), { ok: true, value: 10.5 });
    assert.deepEqual(parseAmount("10.5", MONEY), { ok: true, value: 10.5 });
    assert.deepEqual(parseAmount("1", MONEY), { ok: true, value: 1 });
  });

  it("NEVER TURNS 10,50 INTO 1050 — the hundredfold error", () => {
    // Stripping commas is the obvious way to 'add European support' and it is
    // the single most expensive thing anyone could do to this file. A $10.50
    // per-trade cap becoming $1,050 is a real loss on a signed grant that
    // cannot be edited afterwards.
    const r = parseAmount("10,50", MONEY);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value, 10.5);
    assert.notEqual(r.ok && r.value, 1050);
  });

  it("reads grouping in both conventions", () => {
    assert.deepEqual(parseAmount("1,000", MONEY), { ok: true, value: 1000 });
    assert.deepEqual(parseAmount("1.000", MONEY), { ok: true, value: 1000 });
    assert.deepEqual(parseAmount("1,234.56", MONEY), { ok: true, value: 1234.56 });
    assert.deepEqual(parseAmount("1.234,56", MONEY), { ok: true, value: 1234.56 });
  });

  it("A GROUPED NUMBER IS NOT SILENTLY DIVIDED BY A THOUSAND", () => {
    // `Number("1.000")` is 1. That is what the settings route stores today for
    // a German, Spanish, Italian, Dutch, Brazilian or Turkish user, in range
    // and with no error, while the UI prints "Changes saved".
    assert.deepEqual(parseAmount("1.000", MONEY), { ok: true, value: 1000 });
    assert.notEqual(Number("1.000"), 1000); // the coercion this replaces
  });
});

describe("what is genuinely ambiguous is refused, not guessed", () => {
  it("25.000 INTO THE PRICE-MANIPULATION GUARD READS AS TWENTY-FIVE THOUSAND", () => {
    // `Number("25.000")` is 25, and 25 sits inside minPoolLiquidityUsdg's
    // [0, 100_000_000] bounds, so today it saves — a guard set a thousandfold
    // too low while the UI prints "Changes saved". The field takes no decimals,
    // so there is exactly one reading of this string and no dialog is needed.
    assert.deepEqual(parseAmount("25.000", WHOLE), { ok: true, value: 25000 });
    assert.equal(Number("25.000"), 25); // what it does today
  });

  it("a field whose precision can absorb a whole group DOES ask", () => {
    // This is the shape that has no honest answer: three decimal places are
    // legal here, so `1.000` is one thousand under grouping and one under the
    // decimal reading, both in range. Nothing in the string decides it.
    const PRECISE: AmountField = { maxDecimals: 3, min: 0, max: 1_000_000 };
    const r = parseAmount("1.000", PRECISE);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "ambiguous");
    assert.deepEqual(r.ok === false && r.reason === "ambiguous" && r.readings, [1, 1000]);
  });

  it("range kills a reading rather than surfacing a choice nobody can make", () => {
    // expiryDays is capped at 90 by the signer. One thousand days is not a
    // thing the signer will accept, so the refusal names the range instead of
    // offering a number that would be rejected later anyway.
    const DAYS: AmountField = { maxDecimals: 0, min: 1, max: 90 };
    const r = parseAmount("1.000", DAYS);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "out-of-range");
  });
});

describe("shapes that are not numbers are refused", () => {
  it("an empty field is EMPTY, never zero and never the floor", () => {
    // `Number("")` is 0 and 0 is finite, so every guard shaped
    // `!Number.isFinite(n)` misses it. That is how an empty cap field became a
    // cap of 1 sealed into a signature.
    assert.deepEqual(parseAmount("", MONEY), { ok: false, reason: "empty" });
    assert.deepEqual(parseAmount("   ", MONEY), { ok: false, reason: "empty" });
    assert.equal(Number(""), 0); // the coercion this replaces
    assert.equal(Number.isFinite(Number("")), true);
  });

  it("refuses text, signs and partial numbers", () => {
    for (const bad of ["abc", "$10", "10$", "-5", "1e3", ".", ",", "1..2", "1,,2", "10-50"]) {
      const r = parseAmount(bad, MONEY);
      assert.equal(r.ok, false, `"${bad}" must be refused`);
    }
  });

  it("A SPACE IS GROUPING, so 10 50 is malformed rather than 1050", () => {
    // Deleting spaces before validating grouping destroys the evidence that
    // would have refused this. `[10][50]` is not a legal grouping in any
    // locale, so the string has no reading at all.
    assert.deepEqual(parseAmount("10 50", MONEY), { ok: false, reason: "malformed" });
    // But a legal space grouping is fine: fr-FR and ru-RU both produce this.
    assert.deepEqual(parseAmount("1 000", MONEY), { ok: true, value: 1000 });
    assert.deepEqual(parseAmount("1 234", MONEY), { ok: true, value: 1234 });
    assert.deepEqual(parseAmount("1 234", MONEY), { ok: true, value: 1234 });
  });

  it("de-CH apostrophe grouping is read", () => {
    assert.deepEqual(parseAmount("1’234", MONEY), { ok: true, value: 1234 });
    assert.deepEqual(parseAmount("1'234", MONEY), { ok: true, value: 1234 });
  });

  it("an illegal group width has no reading", () => {
    assert.deepEqual(parseAmount("1,0000", WHOLE), { ok: false, reason: "malformed" });
    // en-IN groups 3 then 2s, so this is twelve lakh thirty-four thousand five
    // hundred and sixty-seven. WHOLE, because it is over MONEY's ceiling.
    assert.deepEqual(parseAmount("12,34,567", WHOLE), { ok: true, value: 1234567 });
  });

  it("more precision than the field holds is refused, not rounded", () => {
    // Four digits after the mark is neither a legal group nor a legal
    // fraction here, so it has no reading at all.
    assert.equal(parseAmount("10.5555", MONEY).ok, false);
    assert.equal(parseAmount("0.5", WHOLE).ok, false);
  });

  it("but THREE digits after a dot is a group, not over-precision", () => {
    // `10.555` is ten thousand five hundred and fifty-five to most of Europe,
    // and reading it as over-precise English is how the grouping reading gets
    // quietly dropped. The fraction reading dies on the field's two-decimal
    // limit; the grouping reading survives and is the answer.
    assert.deepEqual(parseAmount("10.555", MONEY), { ok: true, value: 10555 });
  });

  it("out of range says so, so the message can name the real problem", () => {
    const r = parseAmount("9999999", MONEY);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "out-of-range");
  });
});

describe("non-Latin digits are read", () => {
  it("maps every supported numbering system to ASCII", () => {
    assert.equal(toAsciiDigits("١٢٣"), "123"); // Arabic-Indic
    assert.equal(toAsciiDigits("۱۲۳"), "123"); // Persian
    assert.equal(toAsciiDigits("१२३"), "123"); // Devanagari
    assert.equal(toAsciiDigits("১২৩"), "123"); // Bengali
    assert.equal(toAsciiDigits("๑๒๓"), "123"); // Thai
    assert.equal(toAsciiDigits("１２３"), "123"); // Fullwidth
    assert.equal(toAsciiDigits("plain 12"), "plain 12");
  });

  it("READS BACK WHAT Intl ITSELF PRODUCES, separators included", () => {
    // Mapping digits is not enough: `Intl.NumberFormat("ar-EG").format(1234.5)`
    // is "١٬٢٣٤٫٥", whose U+066C group mark and U+066B decimal mark survive
    // digit mapping untouched. A parser that cannot read its own formatter's
    // output is not a parser.
    const arabic = new Intl.NumberFormat("ar-EG").format(1234.5);
    assert.deepEqual(parseAmount(arabic, MONEY), { ok: true, value: 1234.5 });
  });

  it("the Arabic decimal mark is unambiguous, so it never asks", () => {
    assert.deepEqual(parseAmount("10٫5", MONEY), { ok: true, value: 10.5 });
    assert.deepEqual(parseAmount("١٠٫٥", MONEY), { ok: true, value: 10.5 });
  });
});

describe("round-trip: everything Intl formats, we can read", () => {
  it("survives a formatter sweep across locales", () => {
    // The strongest available check that the reader and the writer agree. If a
    // locale is ever added to the display layer, this is what catches a value
    // the input layer cannot take back.
    const locales = ["en-US", "de-DE", "fr-FR", "es-ES", "pt-BR", "it-IT", "nl-NL",
      "tr-TR", "ru-RU", "id-ID", "pl-PL", "de-CH", "en-IN", "ja-JP", "ko-KR", "zh-CN"];
    const values = [1, 10.5, 1000, 1234.56, 999999];
    for (const loc of locales) {
      for (const v of values) {
        const s = new Intl.NumberFormat(loc, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        }).format(v);
        const r = parseAmount(s, MONEY);
        assert.ok(
          r.ok || (r.reason === "ambiguous" && r.readings.includes(v)),
          `${loc} formatted ${v} as "${s}" and it came back ${JSON.stringify(r)}`,
        );
        if (r.ok) assert.equal(r.value, v, `${loc} "${s}" round-tripped to ${r.value}`);
      }
    }
  });
});
