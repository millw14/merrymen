"use client";

import { createContext, useContext, useMemo } from "react";

import { DEFAULT_LOCALE, type LocaleTag } from "./locale";
import { EN, type MessageKey } from "./messages/en";
import { CATALOGUES } from "./messages";

/**
 * THE UI'S OWN WORDS.
 *
 * ── THE RULE THAT SHAPES EVERYTHING HERE ─────────────────────────────────
 *
 * A HALF-TRANSLATED SCREEN IS WORSE THAN AN ENGLISH ONE. An English screen is
 * a screen somebody cannot read; a screen where four sentences are Spanish and
 * the fifth is English is a screen where the reader cannot tell whether that
 * fifth sentence is untranslated or is a term they do not know. The first has
 * an obvious remedy — find a translation. The second reads as their failure.
 *
 * So the fallback is per SCREEN, not per string. A namespace (`create.*`,
 * `tour.*`) is either complete in a locale and shown in it, or incomplete and
 * shown entirely in English. There is no arrangement of a missing key that
 * produces a mixed screen, which means a translation in progress can sit in the
 * repo without anybody seeing it until it is finished.
 *
 * ── WHY THE LOCALE ARRIVES AS A PROP AND NOT FROM THE DOM ────────────────
 *
 * `displayLocale()` in format.ts reads `html[lang]`, and that is safe there for
 * a reason that does not transfer: every figure is null at SSR, so what the
 * server renders is an em dash in any language. COPY IS NOT NULL. It renders on
 * the first paint with no data behind it, so if the server said "Meet your next
 * agent." and the client said "Conoce a tu próximo agente.", React would find a
 * mismatch on text the reader is looking at.
 *
 * The server therefore has to know. `(app)/layout.tsx` reads the cookie and
 * passes it down, which costs those routes their static rendering — they are
 * the app shell behind a sign-in, not a page anybody links to — and buys a
 * correct first paint for every reader who is not English.
 */

const LocaleContext = createContext<LocaleTag>(DEFAULT_LOCALE);

export function LocaleProvider({
  locale,
  children,
}: {
  locale: LocaleTag;
  children: React.ReactNode;
}) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/** Values substituted into a message. Never concatenated — see `format`. */
export type Vars = Record<string, string | number>;

const NS = (key: string) => key.slice(0, key.indexOf("."));

/**
 * Which namespaces are complete in which locale, worked out once.
 *
 * A namespace counts as covered only when EVERY English key under it has a
 * non-empty translation. Anything less and the whole namespace reads English,
 * which is the guarantee the header describes.
 */
/**
 * A NAMESPACE THAT TALKS ABOUT ANOTHER ONE'S CONTROLS DEPENDS ON IT.
 *
 * Found by three translation reviewers working on different languages, all
 * pointing at the same sentence: the tour tells a reader to "check the mode
 * shown on your agent". Ship that in Indonesian while the mode itself still
 * reads "Paper" / "Live" and you have not helped — you have given somebody a
 * clear instruction to look for a word that is not on their screen, which is a
 * worse dead end than an English sentence they knew they could not read.
 *
 * So completeness is not just "this namespace is finished". It is "this
 * namespace is finished AND everything it refers to is". A tour whose
 * vocabulary is still English falls back to English with it.
 */
const REQUIRES: Record<string, readonly string[]> = {
  tour: ["mode"],
  create: ["mode"],
  // Settings carries the SECOND live-trading switch. A translated Settings page
  // whose trading-mode row still read English would be the same dead end, on
  // the one screen somebody opens specifically to change that.
  settings: ["mode"],
  // The strip says an agent is trading "practice money" or "real money" — the
  // mode vocabulary, in its own words. Shipping those sentences in a language
  // whose mode pill still reads English would leave a reader comparing two
  // descriptions of the same thing and finding only one of them.
  strip: ["mode"],
};

const coverage = new Map<string, Set<string>>();
function coveredNamespaces(locale: LocaleTag): Set<string> {
  let found = coverage.get(locale);
  if (found) return found;
  found = new Set<string>();
  const table = CATALOGUES[locale];
  if (table) {
    const total = new Map<string, number>();
    const done = new Map<string, number>();
    for (const key of Object.keys(EN) as MessageKey[]) {
      const ns = NS(key);
      total.set(ns, (total.get(ns) ?? 0) + 1);
      const value = table[key];
      if (typeof value === "string" && value.trim() !== "") {
        done.set(ns, (done.get(ns) ?? 0) + 1);
      }
    }
    for (const [ns, n] of total) if (done.get(ns) === n) found.add(ns);
    // Then withdraw any namespace whose vocabulary is not also ready. Repeated
    // to a fixpoint rather than checked once, so a dependency that is itself
    // withdrawn takes its dependants with it.
    for (let changed = true; changed; ) {
      changed = false;
      for (const ns of [...found]) {
        if ((REQUIRES[ns] ?? []).some((need) => !found!.has(need))) {
          found.delete(ns);
          changed = true;
        }
      }
    }
  }
  coverage.set(locale, found);
  return found;
}

/** The namespaces a reader in this locale will actually see translated. */
export function translatedNamespaces(locale: LocaleTag): string[] {
  return locale === DEFAULT_LOCALE
    ? [...new Set((Object.keys(EN) as MessageKey[]).map(NS))].sort()
    : [...coveredNamespaces(locale)].sort();
}

/**
 * Substitute `{name}` placeholders.
 *
 * PLACEHOLDERS, NEVER CONCATENATION. `"Held by " + n + " agents"` forces every
 * language into English word order, and several of the shipped ones do not use
 * it — a translator needs to move the number, not receive it glued to a phrase.
 * An unknown placeholder is left exactly as written rather than blanked, so a
 * typo in a translation shows up as `{nmae}` on screen instead of a sentence
 * with a hole in it.
 */
function fill(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * Look a message up, in the locale given.
 *
 * Exported for the handful of callers that are not React components. Prefer
 * `useT()` inside a component so the locale comes from context rather than
 * being threaded by hand.
 */
export function translate(locale: LocaleTag, key: MessageKey, vars?: Vars): string {
  const english = EN[key];
  if (locale === DEFAULT_LOCALE) return fill(english, vars);
  if (!coveredNamespaces(locale).has(NS(key))) return fill(english, vars);
  const value = CATALOGUES[locale]?.[key];
  // Belt and braces: coverage already guarantees this, and a bad catalogue
  // should still never put a key name or an empty string on a screen.
  return fill(typeof value === "string" && value !== "" ? value : english, vars);
}

/**
 * A message whose VALUES are emphasised, without the translation carrying
 * markup.
 *
 * The wallet's grant summary reads "at most **$10** per trade, **$50** per
 * day…", and the bold is doing real work: it is the figure somebody is about
 * to sign. Two ways of keeping it are both worse than this one.
 *
 * Putting `<b>` inside the message makes the translator responsible for HTML,
 * and a mistyped tag on the signing screen is a rendering bug in a sentence
 * about money. Splitting the sentence into fragments around each figure forces
 * English word order on every language, which is the thing placeholders exist
 * to avoid.
 *
 * So the translation stays plain text with `{placeholders}`, and whatever is
 * substituted comes back wrapped. The translator moves the figures wherever
 * their language wants them and the emphasis follows.
 */
export function useRichT(): (key: MessageKey, vars: Vars) => React.ReactNode {
  const locale = useContext(LocaleContext);
  return useMemo(
    () => (key: MessageKey, vars: Vars) => {
      const template = translate(locale, key);
      const out: React.ReactNode[] = [];
      let last = 0;
      let n = 0;
      for (const m of template.matchAll(/\{(\w+)\}/g)) {
        const name = m[1]!;
        if (!(name in vars)) continue; // left visible, as `fill` does
        out.push(template.slice(last, m.index));
        out.push(<b key={`v${n++}`}>{String(vars[name])}</b>);
        last = m.index! + m[0].length;
      }
      out.push(template.slice(last));
      return out;
    },
    [locale],
  );
}

/** The message lookup for the current reader. */
export function useT(): (key: MessageKey, vars?: Vars) => string {
  const locale = useContext(LocaleContext);
  return useMemo(() => (key: MessageKey, vars?: Vars) => translate(locale, key, vars), [locale]);
}

/** The current reader's locale, for the rare caller that needs the tag itself. */
export function useLocale(): LocaleTag {
  return useContext(LocaleContext);
}
