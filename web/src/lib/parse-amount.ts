/**
 * READING A NUMBER A PERSON TYPED, WITHOUT GUESSING.
 *
 * `1.000` is one thousand in Berlin and one in Boston. Both readings are
 * sincere, and no amount of cleverness about the browser's locale settles it,
 * because the person may not be typing in the locale their device is set to.
 * The mistake this module exists to prevent is the app picking one silently.
 *
 * The repo has already paid for the general form of this bug once, and wrote
 * the invoice at `packages/core/src/tokens.ts:111` — a regex over prose that
 * `toLocaleString` had formatted "matched nothing for every pool over $1,000"
 * on a dot-grouping host, which turned off trencher's rug defence and pinned a
 * position's entry baseline at 0 for its whole life. Its conclusion was that a
 * number should never be round-tripped through a sentence. This is the other
 * half of that rule: a number should never be recovered from a string by
 * assuming which sentence the string came from.
 *
 * THE PROCEDURE IS TOTAL AND HAS NO REPAIR STEP. Enumerate every reading the
 * field's own constraints permit; refuse if none survive, accept if exactly one
 * does, and if two survive, say so and let the person choose. That shape is
 * borrowed from `admitPost` in `worker/src/social-post.ts`, which argues it is
 * safe precisely because it is decidable and contains no judgement.
 *
 * WHAT IT REPLACES, AND WHY EACH WAS DANGEROUS:
 *
 *   - `validAmount` accepted only a dot decimal, so `10,50` was a dead end on
 *     the one screen where a person bounds their own risk. It fails safe, but
 *     it fails: the field is `inputMode="decimal"`, which on a Spanish, German,
 *     French, Portuguese, Turkish or Indonesian keyboard renders a comma key.
 *     The app handed the user the separator its only validator refused.
 *
 *   - `Number(raw)` in the settings route, over ten plain-text fields. This is
 *     the one path that produced a WRONG NUMBER rather than a refusal:
 *     `Number("25.000")` is 25, which is inside `minPoolLiquidityUsdg`'s bounds,
 *     so it saved — a price-manipulation guard set a thousandfold too low, with
 *     "Changes saved" on screen.
 *
 *   - `Number("")` is 0, and 0 is finite. Any guard shaped `!Number.isFinite(n)`
 *     misses an empty field entirely. An empty string is a null, and this repo's
 *     own rule (`web/src/lib/format.ts:9`) is that a null rendered as a number
 *     is a claim that a thing was measured.
 *
 * DIGITS AND SEPARATORS ARE SEPARATE PROBLEMS. Mapping `١٢٣` to `123` does not
 * help if `١٬٢٣٤٫٥` still carries U+066C and U+066B, which is exactly what
 * `Intl.NumberFormat("ar-EG")` produces. Both layers are normalised below.
 */

import { MAX_USDG_UI } from "@merrymen/core";

/** The result of reading a typed amount. Never a bare number. */
export type ParsedAmount =
  | { ok: true; value: number }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "malformed" }
  | { ok: false; reason: "out-of-range"; min: number; max: number }
  | { ok: false; reason: "ambiguous"; readings: number[] };

export type AmountField = {
  /** Decimal places the field accepts. 0 means whole numbers only. */
  maxDecimals: number;
  min: number;
  max: number;
};

/**
 * A USD spending cap: the per-trade and per-day limits in the create wizard,
 * and the same two on the wallet screen.
 *
 * ONE DEFINITION FOR BOTH SCREENS, because they currently disagree about the
 * same number in a way the owner can feel: the wizard refuses a cap it cannot
 * read, while the wallet screen rewrites it to the floor and seals it into a
 * signature that cannot be edited for the life of the grant. Two behaviours
 * for one concept is how one of them stays wrong.
 *
 * The ceiling is the wall's own, so a cap that parses here cannot throw later
 * in `usdgUnits`. Refusing at type time beats throwing at spend time.
 */
export const CAP_FIELD: AmountField = { maxDecimals: 2, min: 0.01, max: MAX_USDG_UI };

/**
 * How many decimal places a SETTING accepts, derived from its name rather than
 * listed beside it.
 *
 * Derived on purpose. The settings route records three separate incidents where
 * a field missing from a list was silently dropped while the PUT answered
 * `{ok:true}` — `maxImpactBps`, `takeProfitBps` and `ponsAdapterAddress`. A
 * second list keyed on field name would be a fourth place to forget. A rule
 * that reads the name cannot be forgotten.
 *
 * Money is quoted to cents. Everything else — basis points, seconds, minutes,
 * counts, hours, steps — is a whole number by construction, and saying so is
 * what lets `25.000` be read as twenty-five thousand with no question asked:
 * the decimal reading needs three places and the field has none, so only one
 * reading survives.
 *
 * HERE RATHER THAN IN THE ROUTE because the settings SCREEN needs the same
 * answer. Two copies of this rule would drift, and the direction it would drift
 * in is a field the screen accepts and the server rejects.
 */
export function settingDecimals(key: string): number {
  return /Usdg?$/.test(key) ? 2 : 0;
}

/**
 * Can this be read as a number at all, without asking whether it is in range?
 *
 * The SHAPE question, which is the client's half. Bounds stay on the server,
 * where the table that defines them lives — mirroring thirty min/max pairs into
 * the browser is exactly the duplication the route's own comments warn about.
 * So this answers "I cannot read that" and never "that is too large".
 */
export function unreadableSetting(key: string, raw: string): string | null {
  if (raw.trim() === "") return null; // empty means "clear to default"
  const r = parseAmount(raw, {
    maxDecimals: settingDecimals(key),
    min: -Number.MAX_SAFE_INTEGER,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (r.ok) return null;
  if (r.reason === "ambiguous") return `reads as either ${r.readings.join(" or ")}`;
  return "not a number";
}

/**
 * Non-ASCII decimal digits, by numbering system.
 *
 * Each run is ten consecutive code points, zero first, which is guaranteed by
 * Unicode for decimal-digit scripts (General_Category Nd). Listing the zero is
 * therefore enough to map the whole set.
 */
const DIGIT_ZEROS = [
  0x0660, // arab      Arabic-Indic        ٠١٢٣٤٥٦٧٨٩
  0x06f0, // arabext   Extended Arabic     ۰۱۲۳۴۵۶۷۸۹  (fa, ur)
  0x0966, // deva      Devanagari          ०१२३४५६७८९
  0x09e6, // beng      Bengali             ০১২৩৪৫৬৭৮৯
  0x0a66, // guru      Gurmukhi
  0x0ae6, // gujr      Gujarati
  0x0b66, // orya      Oriya
  0x0be6, // tamldec   Tamil
  0x0c66, // telu      Telugu
  0x0ce6, // knda      Kannada
  0x0d66, // mlym      Malayalam
  0x0e50, // thai      Thai                ๐๑๒๓๔๕๖๗๘๙
  0x0ed0, // laoo      Lao
  0x0f20, // tibt      Tibetan
  0x1040, // mymr      Myanmar
  0x17e0, // khmr      Khmer
  0xff10, // fullwide  Fullwidth           ０１２３４５６７８９
];

/**
 * Characters that group digits and can NEVER be a decimal mark, in any locale.
 *
 * Stripping these is lossless in value but NOT in evidence, which is why the
 * procedure below records that grouping was present rather than simply deleting
 * it. `10 50` must not become `1050`: a space is a grouping character, and
 * `[10][50]` is not a legal grouping, so that input is malformed rather than
 * silently a hundred times larger.
 *
 *   U+0020 space          en, and most locales when typed casually
 *   U+00A0 no-break space fr-FR historically
 *   U+202F narrow nbsp    fr-FR today: Intl gives "1 234 567"
 *   U+2019 right quote    de-CH: Intl gives "1’234’567.5"
 *   U+0027 apostrophe     what a person actually types for the above
 *   U+066C arabic 1000s   ar: Intl gives "١٬٢٣٤٫٥"
 *   U+2009 thin space     seen in pasted text
 */
const GROUP_ONLY = /[   ’'٬ ]/g;

/**
 * U+066B ARABIC DECIMAL SEPARATOR is unambiguous: it is always the decimal
 * mark, never grouping. Folding it to "." would make it ambiguous again, so it
 * is folded to a private marker that the reader treats as decimal-only.
 */
const DEFINITE_DECIMAL = "٫";

/** Map any supported script's digits to ASCII, leaving everything else alone. */
export function toAsciiDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    let mapped = ch;
    for (const zero of DIGIT_ZEROS) {
      if (cp >= zero && cp <= zero + 9) {
        mapped = String.fromCharCode(48 + (cp - zero));
        break;
      }
    }
    out += mapped;
  }
  return out;
}

/**
 * Is `digits` a legal grouping under `sep`, given the whole integer part?
 *
 * Western grouping is 3s throughout. Indian grouping is 3 then 2s, so
 * `12,34,567` is one crore twenty-three lakh forty-five thousand six hundred
 * and sixty-seven and is what an `en-IN` user types. Both are accepted; a
 * mixture is not, and neither is a trailing group of the wrong width, which is
 * what makes `10,50` unreadable as grouping and therefore unambiguously
 * ten-point-five.
 */
function legalGrouping(parts: string[]): boolean {
  if (parts.length === 1) return true;
  if (parts[0].length < 1 || parts[0].length > 3) return false;
  const rest = parts.slice(1);
  if (rest.some((p) => !/^\d+$/.test(p))) return false;
  const western = rest.every((p) => p.length === 3);
  // Indian: the last group is 3, every group before it is 2.
  const indian =
    rest.length >= 2 &&
    rest[rest.length - 1].length === 3 &&
    rest.slice(0, -1).every((p) => p.length === 2);
  return western || indian;
}

/** Build the numeric value of a reading, or null if the shape is illegal. */
function readingValue(
  intPart: string,
  fracPart: string | null,
  groupSep: string | null,
  field: AmountField,
): number | null {
  const parts = groupSep ? intPart.split(groupSep) : [intPart];
  if (parts.some((p) => p === "")) return null;
  if (!/^\d+$/.test(parts.join(""))) return null;
  if (groupSep && !legalGrouping(parts)) return null;
  if (!groupSep && !/^\d+$/.test(intPart)) return null;

  const digits = parts.join("");
  if (fracPart !== null && !/^\d+$/.test(fracPart)) return null;
  // WRITTEN places, not significant places, and the difference decides how
  // often this module interrupts somebody.
  //
  // Counting significant digits would make `1.000` mean either one thousand or
  // one, and `25.000` either twenty-five thousand or twenty-five — so every
  // grouped number a German, Spanish, Italian or Brazilian user typed would
  // raise a dialog. Counting written digits resolves both, correctly, in
  // silence: nobody types `1.000` to mean one dollar. They type `1` or `1.00`.
  // Three trailing zeros is how one thousand is written and nothing else, so a
  // field that takes two decimals has exactly one reading of it.
  //
  // A genuine ambiguity still exists and is still refused — it needs a field
  // whose precision can absorb a full group, which `readingValue` decides here
  // rather than anywhere else.
  if (fracPart !== null && fracPart.length > field.maxDecimals) return null;

  const n = Number(fracPart !== null ? `${digits}.${fracPart}` : digits);
  if (!Number.isFinite(n)) return null;

  // Carried over from the validator this replaces: a value whose minor units
  // cannot be represented exactly is not a usable amount. `usdgUnits` throws
  // above MAX_USDG_UI, and a signed cap that throws at spend time is worse than
  // one refused at type time.
  if (field.maxDecimals > 0) {
    const scale = 10 ** field.maxDecimals;
    if (!Number.isSafeInteger(Math.round(n * scale))) return null;
  } else if (!Number.isSafeInteger(n)) return null;

  return n;
}

/**
 * Read a typed amount, refusing rather than guessing.
 *
 * The readings considered are exactly two, because a number can carry at most
 * one decimal mark and it must be last:
 *
 *   A. every ambiguous separator groups   `1.000` -> 1000
 *   B. the last ambiguous separator is the decimal mark, earlier ones group
 *                                          `1.000` -> 1
 *
 * A field that takes no decimals does not collapse this to one reading, because
 * `25.000` is a whole number under both. That case is genuinely ambiguous and
 * is the one the settings route silently got wrong.
 */
export function parseAmount(raw: string, field: AmountField): ParsedAmount {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { ok: false, reason: "empty" };

  // Digits first, then the separators that digit-mapping leaves behind.
  let s = toAsciiDigits(trimmed);
  const hadDefiniteDecimal = s.includes(DEFINITE_DECIMAL);
  s = s.replace(new RegExp(DEFINITE_DECIMAL, "g"), ".");

  // A character that can ONLY group settles the whole string, because nothing
  // groups with two different marks: any "." or "," still present must be the
  // decimal mark. So this branch has exactly one reading and never asks.
  //
  // The grouping must be checked against the INTEGER part alone. Folding the
  // fraction in is how `1 234,56` — which is literally what `fr-FR` produces —
  // came back malformed, because "234,56" is not a run of digits. And the check
  // has to happen BEFORE the separators are removed, or `10 50` quietly becomes
  // 1050 instead of being refused as an illegal grouping.
  const spaced = GROUP_ONLY.test(s);
  GROUP_ONLY.lastIndex = 0;
  if (spaced) {
    const at = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
    const head = at === -1 ? s : s.slice(0, at);
    const tail = at === -1 ? null : s.slice(at + 1);
    if (tail !== null && /[.,]/.test(head)) return { ok: false, reason: "malformed" };
    const groups = head.split(GROUP_ONLY).filter((p) => p !== "");
    if (!legalGrouping(groups)) return { ok: false, reason: "malformed" };
    const v = readingValue(groups.join(""), tail, null, field);
    if (v === null) return { ok: false, reason: "malformed" };
    if (v < field.min || v > field.max) {
      return { ok: false, reason: "out-of-range", min: field.min, max: field.max };
    }
    return { ok: true, value: v };
  }

  if (!/^\d[\d.,]*$/.test(s)) return { ok: false, reason: "malformed" };

  const candidates: number[] = [];
  const seps = [...s].filter((c) => c === "." || c === ",");

  if (hadDefiniteDecimal) {
    // U+066B settles it: the "." we folded it to is the decimal mark, and any
    // remaining comma groups.
    const at = s.lastIndexOf(".");
    const v = readingValue(s.slice(0, at), s.slice(at + 1), s.includes(",") ? "," : null, field);
    if (v !== null) candidates.push(v);
  } else if (seps.length === 0) {
    const v = readingValue(s, null, null, field);
    if (v !== null) candidates.push(v);
  } else {
    const distinct = new Set(seps);

    // Reading A: all separators group. Only coherent with a single separator
    // character, since no locale groups with two different marks.
    if (distinct.size === 1) {
      const sep = seps[0];
      const v = readingValue(s, null, sep, field);
      if (v !== null) candidates.push(v);
    }

    // Reading B: the last separator is the decimal mark.
    const at = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
    const decimalMark = s[at];
    const head = s.slice(0, at);
    const tail = s.slice(at + 1);
    const earlier = [...head].filter((c) => c === "." || c === ",");
    // A decimal mark cannot also be the grouping mark, and grouping must be
    // uniform: `1.234.56` has no coherent reading B.
    const groupSep = earlier.length ? earlier[0] : null;
    const coherent =
      (!groupSep || (groupSep !== decimalMark && new Set(earlier).size === 1)) && tail !== "";
    if (coherent) {
      const v = readingValue(head, tail, groupSep, field);
      if (v !== null) candidates.push(v);
    }
  }

  const readings = [...new Set(candidates)];
  if (readings.length === 0) {
    // Distinguish "I cannot read this" from "I read it and it is too big", so
    // the message can name the real problem rather than the generic one. The
    // wizard's old message named neither.
    const loose = Number(s.replace(/,/g, ""));
    if (Number.isFinite(loose) && (loose < field.min || loose > field.max)) {
      return { ok: false, reason: "out-of-range", min: field.min, max: field.max };
    }
    return { ok: false, reason: "malformed" };
  }

  const inRange = readings.filter((n) => n >= field.min && n <= field.max);
  if (inRange.length === 0) {
    return { ok: false, reason: "out-of-range", min: field.min, max: field.max };
  }
  if (inRange.length === 1) return { ok: true, value: inRange[0] };
  return { ok: false, reason: "ambiguous", readings: inRange.sort((a, b) => a - b) };
}
