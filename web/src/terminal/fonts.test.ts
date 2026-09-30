import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * CAN THE PRODUCT ACTUALLY WRITE THE LANGUAGES IT CLAIMS TO SPEAK.
 *
 * A missing glyph is not an error anywhere. The browser silently substitutes
 * another face, the page still renders, every test still passes, and the only
 * signal is that somebody in Bangkok sees a different typeface from somebody in
 * Madrid — or, in the case Vietnamese was in, sees two typefaces inside a single
 * word. Nothing catches that except measuring it, so this measures it.
 *
 * It reads the shipped CSS rather than a list kept beside it. A test that
 * restated the ranges would pass while the stylesheet said something else,
 * which is the failure it exists to prevent.
 */

const CSS = readFileSync(new URL("./terminal.css", import.meta.url), "utf8");
const FONT_DIR = fileURLToPath(new URL("../../public/fonts/", import.meta.url));

/** Every `@font-face` in the stylesheet: family, file, and the range it covers. */
function faces(): { family: string; file: string; ranges: [number, number][] }[] {
  const out: { family: string; file: string; ranges: [number, number][] }[] = [];
  for (const block of CSS.split("@font-face").slice(1)) {
    const body = block.slice(0, block.indexOf("}"));
    const family = body.match(/font-family:\s*"([^"]+)"/)?.[1];
    const file = body.match(/url\("\/fonts\/([^"]+)"\)/)?.[1];
    const range = body.match(/unicode-range:\s*([^;]+);/)?.[1];
    if (!family || !file || !range) continue;
    out.push({
      family,
      file,
      ranges: range.split(",").map((t) => {
        const [a, b] = t.trim().replace(/^U\+/, "").split("-");
        return [parseInt(a!, 16), parseInt(b ?? a!, 16)] as [number, number];
      }),
    });
  }
  return out;
}

/** The `--sans` stack a given `lang` resolves to, as the stylesheet declares it. */
function stackFor(lang: string): string[] {
  const base = CSS.match(/\n\.terminal-host \{[\s\S]*?--sans:\s*([^;]+);/)?.[1];
  assert.ok(base, "the default --sans must exist");
  let chosen = base;
  // Later, more specific rules win — same as the cascade, since these are all
  // `html[lang…] .terminal-host` and therefore equal in specificity to each
  // other and higher than the bare class.
  for (const m of CSS.matchAll(/html\[lang([|]?)="([a-z-]+)"\][^{]*\{\s*--sans:\s*([^;]+);/g)) {
    const [, prefix, value, stack] = m;
    const hit = prefix === "|" ? lang === value || lang.startsWith(`${value}-`) : lang === value;
    // A rule can carry several selectors; re-read the whole selector list.
    const selectorStart = CSS.lastIndexOf("}", m.index) + 1;
    const selectors = CSS.slice(selectorStart, CSS.indexOf("{", selectorStart));
    const listed = [...selectors.matchAll(/html\[lang([|]?)="([a-z-]+)"\]/g)].some(
      ([, p, v]) => (p === "|" ? lang === v || lang.startsWith(`${v}-`) : lang === v),
    );
    if (hit || listed) chosen = stack!;
  }
  return chosen
    .split(",")
    .map((f) => f.trim().replace(/^"|"$/g, "").replace(/\s+/g, " "));
}

const SAMPLES: Record<string, string> = {
  // Covered by DM Sans today; here so a regression in the base stack shows up.
  en: "Buy TSLA within your daily limit",
  es: "Comprar dentro de su límite diario de operación",
  "pt-BR": "Comprar dentro do seu limite diário de negociação",
  id: "Beli dalam batas harian Anda",
  tr: "Günlük işlem sınırınız içinde satın alın",
  // The six that needed work.
  vi: "Mua trong giới hạn hằng ngày của bạn — Tiếng Việt",
  ru: "Купить в пределах вашего дневного лимита",
  th: "ซื้อภายในขีดจำกัดรายวันของคุณ",
  "zh-CN": "在您的每日限额内买入",
  ja: "1日の上限の範囲内で買う",
  ko: "일일 한도 내에서 매수",
};

/** Families that come from the reader's device rather than from us. */
const SYSTEM = new Set([
  "system-ui", "sans-serif", "ui-monospace", "monospace",
  "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC",
  "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Noto Sans CJK JP",
  "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR",
]);

describe("every shipped language has glyphs to render it", () => {
  const FACES = faces();
  const covers = (family: string, cp: number) =>
    FACES.some((f) => f.family === family && f.ranges.some(([a, b]) => cp >= a && cp <= b));

  for (const [lang, sample] of Object.entries(SAMPLES)) {
    it(`${lang} is written by a face we ship, or by a named system face`, () => {
      const stack = stackFor(lang);
      assert.ok(stack.length > 0, `${lang} resolved to an empty stack`);
      const unresolved: string[] = [];
      for (const ch of [...new Set([...sample])]) {
        if (!ch.trim()) continue;
        const cp = ch.codePointAt(0)!;
        // The first family in the stack that either declares this codepoint or
        // is a system face (which we cannot introspect, and trust by name).
        const served = stack.some((f) => covers(f, cp) || SYSTEM.has(f));
        if (!served) unresolved.push(`${ch} (U+${cp.toString(16).toUpperCase()})`);
      }
      assert.deepEqual(unresolved, [], `${lang}: no family in [${stack.join(", ")}] claims these`);
    });
  }

  it("VIETNAMESE IS NOT STITCHED TOGETHER FROM TWO FACES", () => {
    // The bug this whole arrangement exists for. DM Sans covers the base
    // letters of "Tiếng Việt" and not the tone-marked ones, so served through
    // the default stack the word renders in two typefaces at once — which is
    // more jarring than a script that falls back wholesale.
    const stack = stackFor("vi");
    const webFaces = stack.filter((f) => !SYSTEM.has(f));
    const sample = [...SAMPLES.vi!].filter((c) => c.trim());
    for (const face of webFaces) {
      const missing = sample.filter((c) => !covers(face, c.codePointAt(0)!));
      // At least one shipped face must carry the WHOLE sample on its own.
      if (missing.length === 0) return;
    }
    assert.fail(`no single face in [${webFaces.join(", ")}] covers Vietnamese alone`);
  });

  it("and the default stack really is short of it, which is why vi differs", () => {
    // If DM Sans ever gains a Vietnamese subset this fails, and the override
    // above becomes dead weight that should be removed rather than left.
    const short = [..."ếệễộồặớạ"].filter((c) => !covers("DM Sans", c.codePointAt(0)!));
    assert.ok(short.length > 0, "DM Sans now covers Vietnamese; drop the vi override");
  });
});

describe("the digits stay put", () => {
  it("GEIST NUMERALS IS FIRST IN EVERY STACK, or the money stops lining up", () => {
    // It carries U+0030-0039 and nothing else, and being first is the entire
    // mechanism: digits come from it, letters from whatever follows. Demote it
    // in one locale and that locale's figures lose their equal widths — which
    // looks like a rendering quirk and is actually a column of numbers no
    // longer comparable down the page.
    const stacks = [...CSS.matchAll(/--sans:\s*([^;]+);/g)].map((m) => m[1]!);
    assert.ok(stacks.length >= 6, "expected a default stack plus the locale overrides");
    for (const s of stacks) {
      assert.match(s.trim(), /^"Geist Numerals"/, `Geist Numerals must lead: ${s.trim()}`);
    }
  });

  it("the money face is never asked to render prose", () => {
    // `--pixel` is Latin-only and stays that way. That is safe ONLY because
    // every selector using it renders formatter output — a balance, a funding
    // amount, a percentage — and never a translated sentence. Currency here is
    // always USD and digits are pinned to Latin, so the face needs no script
    // it does not already have.
    const users = [...CSS.matchAll(/([^{}]+)\{[^}]*font-family:\s*var\(--pixel\)/g)].map((m) =>
      m[1]!.trim().split("\n").pop()!.trim(),
    );
    assert.ok(users.length > 0, "something should use the money face");
    // NAMED, NOT PATTERN-MATCHED. A regex over selector names would quietly
    // admit `.summary-text` for containing "sum". Each entry here is a claim
    // that the element renders the output of a formatter, and adding one means
    // checking that it still does — because the day it renders a sentence, a
    // Russian or Thai reader gets a box instead.
    const FIGURES_ONLY = new Set([
      ":where(.terminal-host) .public-return", // pct()
      ":where(.terminal-host) .fund-amount-input", // the deposit field
      ":where(.terminal-host) .fund-review-amount strong", // usd()
      ":where(.terminal-host) .balance", // <BalanceFigure/>
      ":where(.terminal-host) .amt", // usdAdaptive()
      ":where(.terminal-host) .desk-equity", // <BalanceFigure/>
      ":where(.terminal-host) .account-balance > strong", // <BalanceFigure/>
      ":where(.terminal-host) .desktop-balance", // <BalanceFigure/>
    ]);
    // A rule nothing renders cannot show anybody a missing glyph, so the
    // question only applies to classes a component actually uses. `.hero-fig`
    // is the live example: three rules in the stylesheet and no reference in
    // any component.
    const TSX = execFileSync("git", ["grep", "-lF", "--", "className"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      // Components only. A test that names a class in a comment is not a
      // component rendering it — and this file names `.hero-fig` two dozen
      // lines up, so without this the scan reads its own prose back.
      .filter((f) => !f.includes(".test."))
      .map((f) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"))
      .join("\n");

    for (const sel of users) {
      if (FIGURES_ONLY.has(sel)) continue;
      const cls = sel.match(/\.([a-z][\w-]*)(?:\s|$)/)?.[1];
      assert.ok(
        cls && !TSX.includes(cls),
        `${sel} uses the Latin-only money face. If it renders a formatter's output, add it to FIGURES_ONLY; if it renders copy, it needs a face that can write the shipped languages.`,
      );
    }
    // And the list may not rot in the other direction either.
    for (const sel of FIGURES_ONLY) {
      assert.ok(users.includes(sel), `${sel} no longer uses the money face — drop it from the list`);
    }
  });
});

describe("what we vendor is present and licensed", () => {
  it("every font the stylesheet references exists on disk", () => {
    for (const f of faces()) {
      assert.ok(existsSync(FONT_DIR + f.file), `${f.file} is referenced but missing`);
    }
  });

  it("and nothing shipped is implausibly small, which is what a failed fetch leaves", () => {
    // A redirect or an error page saved as .woff2 is a few hundred bytes and
    // fails silently at render time, not at build time.
    for (const f of faces()) {
      const size = statSync(FONT_DIR + f.file).size;
      assert.ok(size > 4000, `${f.file} is ${size} bytes — that is not a font`);
    }
  });

  it("EVERY VENDORED FAMILY CARRIES ITS LICENCE", () => {
    // These are OFL fonts redistributed from the Google Fonts API. The licence
    // travelling with the binary is a condition of that, not a courtesy.
    for (const family of new Set(faces().map((f) => f.family))) {
      const slug = family.replace(/\s+/g, "");
      const candidates = [`${slug}-OFL.txt`, `${slug.replace(/Pixel|Numerals/, "")}-OFL.txt`];
      assert.ok(
        candidates.some((c) => existsSync(FONT_DIR + c)),
        `${family} has no licence file (looked for ${candidates.join(", ")})`,
      );
    }
  });
});
