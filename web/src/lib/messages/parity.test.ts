/**
 * THE CATALOGUE PARITY LOCK.
 *
 * `i18n.tsx` falls back a whole namespace at a time: one missing key and the
 * entire namespace reads English. That makes a half-finished translation safe
 * to ship — and makes a finished one easy to break by adding an English key
 * and forgetting the translated files. So every COMPLETE locale is locked:
 * the moment it drops a key, gains one English does not have, leaves one
 * empty, or loses a `{placeholder}` the rendering code splices in, this fails.
 *
 * A locale joins COMPLETE the PR its catalogue is finished in — Spanish first.
 * Partial locales still get the placeholder rule on the keys they DO carry,
 * so a half-done file cannot corrupt the half it covers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EN } from "./en";
import { CATALOGUES } from "./index";
import type { LocaleTag } from "../locale";

/** Locales whose catalogue covers every English key. Extend per language PR. */
const COMPLETE: LocaleTag[] = ["es"];

/**
 * Namespaces English keeps but NO locale ships — translated once, then
 * withdrawn (see web/src/terminal/strip-i18n.test.ts for strip: Home and the
 * desktop rail are still English, so a translated strip would strand the
 * reader half in each language). Parity locks what ships, not what was
 * withdrawn; the withdrawal tests lock the rest.
 */
const WITHDRAWN = ["strip"];
const EN_KEYS = Object.keys(EN).filter((k) => !WITHDRAWN.some((ns) => k === ns || k.startsWith(`${ns}.`)));

/** Every withdrawn namespace must have a test saying so — or this silently rots. */
const WITHDRAWAL_TESTS: Record<string, string> = {
  strip: "web/src/terminal/strip-i18n.test.ts",
};

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
}

function placeholderGaps(tag: string, catalogue: Partial<Record<string, string>>): string[] {
  const bad: string[] = [];
  for (const k of EN_KEYS) {
    if (!(k in catalogue)) continue;
    const want = placeholders(EN[k as keyof typeof EN]);
    const got = placeholders(catalogue[k] ?? "");
    if (want.join(",") !== got.join(",")) bad.push(`${k} (en: {${want.join("},{")}} vs ${tag}: {${got.join("},{")}}})`);
  }
  return bad;
}

describe("complete locales carry the whole English catalogue", () => {
  it("every withdrawn namespace names its withdrawal test", () => {
    assert.deepEqual(Object.keys(WITHDRAWAL_TESTS).sort(), WITHDRAWN.sort());
  });

  for (const tag of COMPLETE) {
    const catalogue = CATALOGUES[tag] ?? {};
    it(`${tag}: no missing keys`, () => {
      const missing = EN_KEYS.filter((k) => !(k in catalogue));
      assert.deepEqual(missing, [], `${tag} is missing ${missing.length} keys: ${missing.slice(0, 5).join(", ")}`);
    });

    it(`${tag}: no extra keys English does not have`, () => {
      const extra = Object.keys(catalogue).filter((k) => !(k in EN));
      assert.deepEqual(extra, [], `${tag} has ${extra.length} keys English lacks: ${extra.slice(0, 5).join(", ")}`);
    });

    it(`${tag}: no empty strings`, () => {
      const empty = Object.entries(catalogue).filter(([, v]) => (v ?? "").trim().length === 0).map(([k]) => k);
      assert.deepEqual(empty, [], `${tag} has ${empty.length} empty strings`);
    });

    it(`${tag}: every placeholder survives translation`, () => {
      const bad = placeholderGaps(tag, catalogue as Record<string, string>);
      assert.deepEqual(bad, [], `${tag} drops or invents placeholders: ${bad.slice(0, 3).join("; ")}`);
    });
  }
});

describe("partial locales keep the placeholders on the keys they carry", () => {
  for (const [tag, catalogue] of Object.entries(CATALOGUES)) {
    if ((COMPLETE as string[]).includes(tag)) continue;
    it(`${tag}: no dropped or invented placeholders`, () => {
      const bad = placeholderGaps(tag, (catalogue ?? {}) as Record<string, string>);
      assert.deepEqual(bad, [], `${tag} drops or invents placeholders: ${bad.slice(0, 3).join("; ")}`);
    });
  }
});
