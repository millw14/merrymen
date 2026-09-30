import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { SUPPORTED } from "./locale";
import {
  coinPrice,
  compactUsd,
  count,
  dayLabel,
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

/**
 * WHY `displayLocale()` MAY READ THE DOM WITHOUT CAUSING A HYDRATION MISMATCH.
 *
 * The fear is specific and worth stating plainly: the server renders
 * `$1,234.50`, the client re-renders `1 234,50 $`, and React reconciles the
 * difference — a flicker, or a warning, on a screen full of money.
 *
 * A COMMON WRONG ANSWER IS "format.ts only runs on the client". It does not.
 * `(app)/layout.tsx` renders `<Providers><App/></Providers>`, `App` carries
 * `"use client"`, and Next server-renders client components. Every formatter in
 * this app executes on the server on every request.
 *
 * The real invariant is narrower and it is this:
 *
 *     WHATEVER THE SERVER RENDERS IS LOCALE-INDEPENDENT.
 *
 * It holds because the server tree is handed NO DATA — figures arrive from
 * client fetches — so at SSR every value is null, every formatter returns the
 * em dash before it reaches `Intl`, and the em dash is one string in all
 * eleven languages. The first client render runs with that same empty state and
 * produces the same markup. The locale only starts mattering once data lands,
 * which is after hydration.
 *
 * Each of those three clauses is pinned below, because each is one edit away
 * from being false: a data prop on `<App/>`, a seeded figure that is 0 rather
 * than null, or a null check moved below the `Intl` call.
 */

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p: string) => readFileSync(path.join(SRC, p), "utf8");

describe("the server tree is handed nothing to format", () => {
  it("THE APP RECEIVES NO DATA FROM THE SERVER", () => {
    // One prop carrying a balance or a price would be rendered server-side, in
    // whatever locale the server guessed, and then re-rendered on the client in
    // the reader's own. This is the edit that would break everything below it.
    const layout = read("app/(app)/layout.tsx");
    assert.match(layout, /<App \/>/, "App must be rendered without props");
    assert.ok(!/<App\s+\w/.test(layout), "a prop on <App/> would put server data in the tree");
  });

  it("and no route outside that tree formats a figure of its own", () => {
    // `(app)` renders through the client tree. Anything else — /app, /connect,
    // /lookup — is its own page, and a figure formatted there WOULD be server
    // markup that a locale could change.
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/^page\.tsx$/.test(entry)) pages.push(full);
      }
    };
    walk(path.join(SRC, "app"));
    const offenders = pages
      .filter((p) => !p.includes(`app${path.sep}(app)${path.sep}`))
      .filter((p) => /from "@\/lib\/format"/.test(readFileSync(p, "utf8")))
      .map((p) => path.relative(SRC, p));
    assert.deepEqual(offenders, [], "these render figures outside the client tree");
  });
});

describe("what the server renders reads the same in every language", () => {
  const CALLS: [string, () => string][] = [
    ["usd", () => usd(null)],
    ["compactUsd", () => compactUsd(null)],
    ["coinPrice", () => coinPrice(null)],
    ["pct", () => pct(null)],
    ["pctPts", () => pctPts(null)],
    ["pctBps", () => pctBps(null)],
    ["count", () => count(null)],
    ["usdAdaptive", () => usdAdaptive(null)],
    ["subCentUsd", () => subCentUsd(null)],
    ["usdFixed", () => usdFixed(null, 2)],
    ["shortDateTime", () => shortDateTime(null)],
    ["fullDateTime", () => fullDateTime(null)],
    ["dayLabel", () => dayLabel(null)],
    ["timeOnly", () => timeOnly(null)],
  ];

  it("THE NULL BRANCH RETURNS BEFORE `Intl` IS EVER CONSULTED", () => {
    // The behaviour above is only stable because the em dash is returned by an
    // early return rather than produced by a formatter. If a null check moved
    // below its `nf(...)` call, the answer would become locale-shaped and the
    // hydration guarantee would quietly stop holding — with nothing failing.
    // EOL-agnostic, and it REFUSES to skip. An extraction that quietly found
    // nothing would turn this into a test that always passes, which is worse
    // than not having it.
    const src = read("lib/format.ts").split("\r\n").join("\n");
    let checked = 0;
    for (const [name] of CALLS) {
      const at = src.indexOf(`export function ${name}(`);
      assert.ok(at > -1, `${name} is exported but not declared as a function`);
      const body = src.slice(at);
      const end = body.indexOf("\n}\n");
      assert.ok(end > 0, `could not find the end of ${name}`);
      const decl = body.slice(0, end);
      const guard = decl.search(/return DASH;/);
      const intl = decl.search(/\b(nf|dtf)\(/);
      assert.ok(guard > -1, `${name} must have a DASH guard`);
      if (intl > -1) {
        assert.ok(guard < intl, `${name} consults Intl before checking for null`);
        checked++;
      }
    }
    // Most of them reach Intl; if that stops being true the shape has changed
    // enough that this test is no longer measuring what it claims to.
    assert.ok(checked >= 10, `only ${checked} formatters actually reach Intl`);
  });

  it("and every one of them answers with the same em dash", () => {
    // A dash is a dash in Spanish, Thai and Japanese alike. That is the whole
    // reason the server may render it without knowing who is reading.
    for (const [name, call] of CALLS) {
      assert.equal(call(), "—", `${name}(null) must be the locale-independent dash`);
    }
  });

  it("no formatter can be reached with a locale we do not ship", () => {
    // `displayLocale()` reads an attribute, and an attribute is writable by
    // anything on the origin. It is normalised against the shipped list, so a
    // junk value renders English rather than throwing inside `Intl`.
    const src = read("lib/format.ts");
    assert.match(
      src,
      /normalizeLocale\(document\.documentElement\.lang\) \?\? DEFAULT_LOCALE/,
      "the attribute must be normalised, never passed to Intl raw",
    );
  });
});

describe("the seed carries no figures for the server to render", () => {
  it("EVERY PRICE-SHAPED FIELD ON A SEEDED TOKEN IS NULL", () => {
    // The market list exists before any fetch so the shell has something to
    // draw. Every number on it is unknown at that moment — and a 0 here would
    // be a real figure rendered on the server, in the server's locale, and then
    // re-rendered in the reader's. `live.ts` states the rule for its own
    // reasons; this test is the second half of why it matters.
    const src = read("terminal/live.ts");
    const seed = src.slice(src.indexOf("export function seedLive"));
    const body = seed.slice(0, seed.indexOf("\n}\n"));
    for (const field of ["priceUsd", "change24hPct", "fdvUsd", "holders", "agents", "buys"]) {
      assert.ok(
        !new RegExp(`${field}:\\s*[0-9]`).test(body),
        `${field} is seeded with a number; it must be null until the ledger answers`,
      );
    }
  });
});

describe("the languages and the formatter agree on what exists", () => {
  it("every shipped tag is one Intl can actually format", () => {
    // A tag in the picker that `Intl` does not recognise falls back silently to
    // the host default, which is neither what the reader chose nor English.
    for (const { tag } of SUPPORTED) {
      const resolved = new Intl.NumberFormat(tag, { style: "currency", currency: "USD" })
        .resolvedOptions().locale;
      assert.ok(
        resolved.toLowerCase().startsWith(tag.split("-")[0]!.toLowerCase()),
        `${tag} resolved to ${resolved}`,
      );
    }
  });
});
