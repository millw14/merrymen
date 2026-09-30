import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  SUPPORTED,
  localeBootScript,
  negotiateLocale,
  normalizeLocale,
} from "./locale";

/**
 * WHICH LANGUAGE THE READER IS IN, AND THE WAYS THAT ANSWER GOES WRONG.
 *
 * All three failures here are silent. A tag that does not normalise sends a
 * Brazilian reader to English because their browser wrote `pt-br` in lower
 * case. A boot script that throws leaves the page in whatever language the
 * server guessed, with nothing in the console for anyone who is not looking.
 * And a language added to the picker without a font stack renders in a
 * substitute face, which looks like a design choice.
 */

describe("a tag the browser offers becomes a tag we ship", () => {
  it("matches exactly first, so a region tag is not eaten by its language", () => {
    assert.equal(normalizeLocale("zh-CN"), "zh-CN");
    assert.equal(normalizeLocale("pt-BR"), "pt-BR");
  });

  it("IS CASE-INSENSITIVE, because browsers do not agree on the case", () => {
    // `navigator.language` gives "pt-BR" in Chrome and "pt-br" in some others,
    // and an Accept-Language header is lower case by convention. Keying on the
    // literal string sends half of Brazil to English.
    assert.equal(normalizeLocale("pt-br"), "pt-BR");
    assert.equal(normalizeLocale("ZH-CN"), "zh-CN");
  });

  it("falls back to the language subtag, so a region we do not ship still lands", () => {
    // We ship pt-BR and not pt-PT. A Portuguese reader is better served by
    // Brazilian Portuguese than by English, and the difference between them is
    // smaller than the difference between either and not understanding.
    assert.equal(normalizeLocale("pt-PT"), "pt-BR");
    assert.equal(normalizeLocale("es-MX"), "es");
    assert.equal(normalizeLocale("zh-TW"), "zh-CN");
  });

  it("and answers null for anything we do not have", () => {
    // Null rather than the default, because "we could not tell" and "they chose
    // English" are different facts — only the second should stop us guessing
    // better on a later visit.
    for (const miss of ["", "  ", "xx", "de", "fr", "ar", null, undefined]) {
      assert.equal(normalizeLocale(miss), null, `${JSON.stringify(miss)} must not match`);
    }
  });
});

describe("negotiating from a browser's list", () => {
  it("honours quality values rather than taking the first entry", () => {
    // A header can list a language we ship at a LOWER preference than one we
    // do not. Reading left to right would pick the wrong one.
    assert.equal(negotiateLocale("de;q=0.9,ru;q=0.8,en;q=0.1"), "ru");
    assert.equal(negotiateLocale("fr-CH, fr;q=0.9, en;q=0.8, ja;q=0.7"), "en");
  });

  it("takes an array, which is what navigator.languages gives", () => {
    assert.equal(negotiateLocale(["de-DE", "th-TH", "en-US"]), "th");
  });

  it("and gives up rather than guessing when nothing matches", () => {
    assert.equal(negotiateLocale("de,fr,ar"), null);
    assert.equal(negotiateLocale(""), null);
    assert.equal(negotiateLocale(null), null);
  });
});

describe("the script that runs before the first paint", () => {
  const SRC = localeBootScript();

  it("CANNOT THROW, whatever the document hands it", () => {
    // It runs blocking, in <head>, before anything else. An exception here is a
    // white page — so the whole body is wrapped, and every failure leaves the
    // document exactly as the server rendered it.
    assert.match(SRC, /^\(function\(\)\{try\{/);
    assert.match(SRC, /\}catch\(e\)\{\}\}\)\(\);$/);
  });

  it("carries the SAME cookie name and tag list as the module", () => {
    // Two copies of either would drift, and the direction of the drift is a
    // reader whose choice is written in one place and read from another.
    assert.ok(SRC.includes(LOCALE_COOKIE), "the cookie name must match");
    for (const l of SUPPORTED) {
      assert.ok(SRC.includes(`"${l.tag}"`), `${l.tag} is missing from the boot script`);
    }
  });

  it("writes nothing but the lang attribute", () => {
    // It runs with full page authority before anything else has loaded. The
    // only thing it is allowed to touch is the attribute the font stacks key on.
    const writes = [...SRC.matchAll(/document\.(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(writes)].sort(), ["cookie", "documentElement"]);
    assert.ok(!/innerHTML|createElement|fetch|eval|localStorage/.test(SRC));
  });

  it("only ever assigns a tag from the list, never the raw cookie", () => {
    // The cookie is attacker-writable in the sense that anything on the origin
    // can set it. It is echoed into an attribute, so it is validated against
    // the list before use rather than assigned through.
    assert.match(SRC, /document\.documentElement\.lang=S\[k\]/);
    assert.ok(!/documentElement\.lang=want/.test(SRC), "the raw value must not be assigned");
  });
});

describe("the picker and the fonts agree", () => {
  const CSS = readFileSync(new URL("../terminal/terminal.css", import.meta.url), "utf8");

  it("EVERY LANGUAGE OFFERED HAS GLYPHS TO RENDER IT", () => {
    // The cross-file rule. Adding a row to the picker without a font stack
    // gives that reader a substitute face rather than an error, which reads as
    // a design choice rather than a missing file.
    //
    // A tag needs a rule of its own only if DM Sans cannot write it; the five
    // Latin-script languages are served by the default stack.
    const LATIN_OK = new Set(["en", "es", "pt-BR", "id", "tr"]);
    for (const { tag } of SUPPORTED) {
      if (LATIN_OK.has(tag)) continue;
      const base = tag.split("-")[0]!;
      const hasRule =
        CSS.includes(`html[lang="${tag}"]`) || CSS.includes(`html[lang|="${base}"]`);
      assert.ok(hasRule, `${tag} is offered but terminal.css gives it no font stack`);
    }
  });

  it("and the five Latin ones are deliberately left on the default", () => {
    // Stated rather than assumed: if one of these ever gains a rule, it is
    // because somebody found a glyph DM Sans is missing, and that belongs in
    // fonts.test.ts as a measurement rather than here as a silent change.
    for (const tag of ["en", "es", "pt-BR", "id", "tr"]) {
      assert.ok(!CSS.includes(`html[lang="${tag}"]`), `${tag} unexpectedly has its own stack`);
    }
  });
});

describe("the list itself", () => {
  it("has no duplicates and a default that is in it", () => {
    const tags = SUPPORTED.map((l) => l.tag);
    assert.equal(new Set(tags).size, tags.length, "a duplicate tag would shadow itself");
    assert.ok(tags.includes(DEFAULT_LOCALE));
  });

  it("NAMES EACH LANGUAGE IN ITS OWN WORDS", () => {
    // The point of the control. "Russian" is a word in the language the reader
    // is trying to leave; "Русский" is the one they are looking for.
    for (const l of SUPPORTED) {
      assert.ok(l.endonym.length > 0, `${l.tag} has no endonym`);
      if (l.tag === "en") continue;
      assert.notEqual(l.endonym, l.label, `${l.tag}'s endonym is just the English name`);
    }
  });
});
