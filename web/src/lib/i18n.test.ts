import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { translate, translatedNamespaces } from "./i18n";
import { EN, type MessageKey } from "./messages/en";
import { CATALOGUES } from "./messages";
import { DEFAULT_LOCALE, SUPPORTED, type LocaleTag } from "./locale";

/**
 * THE PROMISE: NOBODY EVER SEES HALF A SCREEN IN THEIR LANGUAGE.
 *
 * An English screen is a screen somebody cannot read, and the remedy is
 * obvious. A screen where four sentences are Spanish and the fifth is English
 * is a screen where the reader cannot tell whether that fifth sentence is
 * untranslated or is a term they do not know — and that reads as their failure
 * rather than ours.
 *
 * So the fallback is per NAMESPACE, and these tests are the reason that
 * property can be relied on while translations are still arriving.
 */

const NS = (key: string) => key.slice(0, key.indexOf("."));
const ALL_NS = [...new Set((Object.keys(EN) as MessageKey[]).map(NS))];
const keysIn = (ns: string) => (Object.keys(EN) as MessageKey[]).filter((k) => NS(k) === ns);

/**
 * Namespaces that depend on nothing, used where a test is about completeness
 * ALONE. `tour` and `create` both require `mode`, so building a catalogue that
 * finishes only one of them proves nothing about the fallback — it would be
 * withheld for the dependency instead, and the test would pass for the wrong
 * reason.
 */
const STANDALONE = ["lang", "mode"] as const;

/** Populate a fake locale, run something, and always take it back out. */
function withCatalogue(
  tag: string,
  table: Partial<Record<MessageKey, string>>,
  run: (tag: LocaleTag) => void,
): void {
  (CATALOGUES as Record<string, unknown>)[tag] = table;
  try {
    run(tag as LocaleTag);
  } finally {
    delete (CATALOGUES as Record<string, unknown>)[tag];
  }
}

describe("a namespace is all one language or all the other", () => {
  it("ENGLISH IS THE SOURCE AND IS ALWAYS COMPLETE", () => {
    // Nothing can make English wrong: `translate` returns `EN[key]` directly
    // for the default locale rather than looking it up in the table.
    for (const key of Object.keys(EN) as MessageKey[]) {
      assert.equal(translate(DEFAULT_LOCALE, key), EN[key]);
      assert.notEqual(EN[key].trim(), "", `${key} is empty in the source`);
    }
  });

  it("A NAMESPACE MISSING ONE KEY FALLS BACK WHOLE", () => {
    // The guarantee, exercised against a catalogue built to be one short.
    // Every key in that namespace must read English, not just the missing one.
    // A namespace that depends on nothing, so the fallback under test is
    // completeness rather than a missing dependency.
    const ns = "mode";
    const keys = keysIn(ns);
    assert.ok(keys.length > 2, "need a namespace with several keys to prove this");
    const nearly: Partial<Record<MessageKey, string>> = {};
    for (const k of keys.slice(1)) nearly[k] = `TRANSLATED ${k}`;

    // Stand a fake locale up in the real table, so this exercises the shipped
    // code path rather than a copy of its logic.
    withCatalogue("zz", nearly, (FAKE) => {
      for (const k of keys) {
        assert.equal(translate(FAKE, k), EN[k], `${k} should have fallen back with its namespace`);
      }
    });
  });

  it("and a COMPLETE namespace is shown, while an incomplete sibling is not", () => {
    const [a, b] = STANDALONE;
    const table: Partial<Record<MessageKey, string>> = {};
    for (const k of keysIn(a)) table[k] = `DONE ${k}`;
    withCatalogue("zy", table, (FAKE) => {
      assert.equal(translate(FAKE, keysIn(a)[0]!), `DONE ${keysIn(a)[0]!}`, "a finished namespace should show");
      assert.equal(translate(FAKE, keysIn(b)[0]!), EN[keysIn(b)[0]!], "an untouched one should not");
      assert.deepEqual(translatedNamespaces(FAKE), [a]);
    });
  });

  it("A NAMESPACE THAT TALKS ABOUT ANOTHER ONE'S CONTROLS WAITS FOR IT", () => {
    // Three translation reviewers, on three different languages, independently
    // raised the same sentence: the tour says "check the mode shown on your
    // agent". Translating that while the mode still reads "Paper" / "Live" in
    // English sends somebody looking for a word that is not on their screen —
    // a worse dead end than an English sentence they knew they could not read.
    //
    // So a finished `tour` is not enough on its own.
    const table: Partial<Record<MessageKey, string>> = {};
    for (const k of keysIn("tour")) table[k] = `DONE ${k}`;
    withCatalogue("zv", table, (FAKE) => {
      const stop = keysIn("tour")[0]!;
      assert.equal(translate(FAKE, stop), EN[stop], "the tour must wait for the vocabulary it uses");
      assert.ok(!translatedNamespaces(FAKE).includes("tour"));
    });

    // And with `mode` finished too, it is released.
    for (const k of keysIn("mode")) table[k] = `DONE ${k}`;
    withCatalogue("zu", table, (FAKE) => {
      const stop = keysIn("tour")[0]!;
      assert.equal(translate(FAKE, stop), `DONE ${stop}`, "both finished, so the tour shows");
      assert.ok(translatedNamespaces(FAKE).includes("tour"));
    });
  });

  it("AN EMPTY STRING IS NOT A TRANSLATION", () => {
    // A translator leaving a value blank is the likeliest way to get an empty
    // label onto a button. It counts as missing, so the namespace falls back.
    const keys = keysIn("mode");
    const table: Partial<Record<MessageKey, string>> = {};
    for (const k of keys) table[k] = k === keys[0] ? "   " : `X ${k}`;
    withCatalogue("zx", table, (FAKE) => {
      assert.equal(translate(FAKE, keys[1]!), EN[keys[1]!], "a blank sibling must sink the namespace");
    });
  });
});

describe("values go into sentences, never onto the end of them", () => {
  it("fills placeholders wherever the translation put them", () => {
    // The point of a placeholder: a translator moves it. The same message with
    // the value at the front must fill just as well as with it at the back.
    const key = (Object.keys(EN) as MessageKey[]).find((k) => EN[k].includes("{"))!;
    assert.ok(key, "the catalogue should carry at least one placeholder message");
    const names = [...EN[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    const vars = Object.fromEntries(names.map((n) => [n, `<${n}>`]));
    // Reversed, so the test fails if the implementation ever assumes English
    // order rather than substituting where the translation put them.
    const moved = names.map((n) => `{${n}}`).reverse().join(" ") + " tail";

    // EVERY namespace, not just this key's. Filling only its own would leave a
    // dependency short, the whole thing would fall back to English — and the
    // English carries the same placeholders, so the assertions below would pass
    // while testing nothing.
    const table: Partial<Record<MessageKey, string>> = {};
    for (const k of Object.keys(EN) as MessageKey[]) table[k] = k === key ? moved : `x ${k}`;

    withCatalogue("zw", table, (FAKE) => {
      const out = translate(FAKE, key, vars);
      assert.ok(out.endsWith("tail"), "the translation should have been used, not the English");
      for (const n of names) assert.ok(out.includes(`<${n}>`), `${n} was dropped`);
      assert.ok(!out.includes("{"), `a placeholder survived unfilled: ${out}`);
    });
  });

  it("A MISSPELLED PLACEHOLDER IS LEFT VISIBLE, not blanked", () => {
    // `{nmae}` on screen is a bug somebody reports. A sentence with a hole in
    // it is a bug nobody can describe.
    const key = (Object.keys(EN) as MessageKey[]).find((k) => EN[k].includes("{"))!;
    const out = translate(DEFAULT_LOCALE, key, {});
    assert.ok(out.includes("{"), "an unsupplied placeholder should stay visible");
  });
});

describe("the catalogues on disk", () => {
  it("every shipped locale has a file, even an empty one", () => {
    for (const { tag } of SUPPORTED) {
      if (tag === DEFAULT_LOCALE) continue;
      assert.ok(tag in CATALOGUES, `${tag} is offered in the picker with no catalogue`);
    }
  });

  it("NO CATALOGUE CARRIES A KEY ENGLISH NO LONGER HAS", () => {
    // A stale key is a translation of a sentence that is not on the screen any
    // more, and it silently counts towards nothing. It is also the shape a
    // typo in a key name takes.
    const known = new Set(Object.keys(EN));
    for (const [tag, table] of Object.entries(CATALOGUES)) {
      const stale = Object.keys(table ?? {}).filter((k) => !known.has(k));
      assert.deepEqual(stale, [], `${tag} has keys English does not`);
    }
  });

  it("and no translation is left as the English it was copied from", () => {
    // Not an error in every case — a product name is the same everywhere — but
    // a whole namespace of identical strings means somebody pasted the source
    // and called it done.
    for (const [tag, table] of Object.entries(CATALOGUES)) {
      const entries = Object.entries(table ?? {});
      if (entries.length < 5) continue;
      const same = entries.filter(([k, v]) => v === EN[k as MessageKey]);
      assert.ok(
        same.length < entries.length * 0.5,
        `${tag}: ${same.length} of ${entries.length} values are identical to English`,
      );
    }
  });
});

describe("a namespace does not ship until its SCREEN is extracted", () => {
  it("SETTINGS IS TRANSLATED AND DELIBERATELY NOT SHIPPED", () => {
    // All 149 `settings.*` keys exist in every language. Shipping them would
    // still be wrong: the extraction caught `label=`, `hint=` and four element
    // shapes, and an audit of the remainder found 132 more user-facing strings
    // on the same screen — 1,156 words — including the two that decide whether
    // an agent spends real money:
    //
    //   "ON — real orders, real money, within your signed caps"
    //   "OFF — Paper mode: practising with simulated money at live prices"
    //
    // A Spanish Settings page whose live-trading explanation is English is the
    // exact failure the namespace rule exists to prevent, on the screen where
    // that switch lives. The catalogue is complete; the SCREEN is not, and the
    // rule is about the screen.
    //
    // This test comes OFF when the rest is extracted, and not before.
    for (const [tag, table] of Object.entries(CATALOGUES)) {
      const shipped = Object.keys(table ?? {}).filter((k) => k.startsWith("settings."));
      assert.deepEqual(
        shipped,
        [],
        `${tag} ships ${shipped.length} settings keys while the screen is still half English`,
      );
    }
    // And the English keys stay, because the screen already renders from them.
    assert.ok(
      (Object.keys(EN) as MessageKey[]).filter((k) => k.startsWith("settings.")).length > 100,
      "the settings catalogue should still exist in English",
    );
  });

  it("so no locale claims Settings is translated", () => {
    for (const { tag } of SUPPORTED) {
      if (tag === DEFAULT_LOCALE) continue;
      assert.ok(
        !translatedNamespaces(tag).includes("settings"),
        `${tag} would render a half-translated Settings page`,
      );
    }
  });
});

describe("the tour has no English left in it", () => {
  const SRC = readFileSync(new URL("../terminal/FirstVisit.tsx", import.meta.url), "utf8");

  it("EVERY STOP NAMES A KEY THAT EXISTS", () => {
    const keys = [...SRC.matchAll(/(?:titleKey|copyKey): "([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(keys.length >= 50, `expected both keys on every stop, found ${keys.length}`);
    for (const k of keys) assert.ok(k in EN, `${k} is used by a stop and missing from en.ts`);
  });

  it("and the card's own controls are keyed too", () => {
    // The way OUT of the tour matters most. A reader who cannot read the card
    // needs "Skip" in their language more than they need any of the stops.
    for (const key of ["tour.skip", "tour.next", "tour.finish", "tour.back", "tour.topics"]) {
      assert.ok(SRC.includes(`t("${key}")`), `${key} is in the catalogue but not used`);
    }
    for (const english of ["Skip tour", ">Topics<", "Show me around"]) {
      assert.ok(!SRC.includes(english), `"${english}" is still hardcoded`);
    }
  });
});
