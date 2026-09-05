import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * A STYLESHEET THAT CLAIMS TO BE SCOPED MUST ACTUALLY BE.
 *
 * console.css opens with "every rule is scoped under .sc-root". It was wrong
 * about thirty selectors, in two blocks, and nothing caught it — CSS has no
 * build error for a rule that is broader than its author intended. The leak had
 * two consequences and the second was worse than the first: those rules applied
 * on /grant, which also loads console.css; and they resolved --border, --bg-2,
 * --green from globals.css's :root while sitting in a sheet whose own palette
 * is --line/--panel/--mint, so four blocks of the console rendered in the OLD
 * terminal palette inside the new one, and deleting a globals token would have
 * broken them silently.
 *
 * So the new sheets state their prefix and this test enforces it. The repo
 * already works this way — client-env, honesty, imports and identity are all
 * tests that pin a property a reviewer would otherwise have to remember.
 */

const DIR = path.join(process.cwd(), "web", "src", "styles");

/**
 * The two sheets that are deliberately NOT scoped.
 *
 * They are the old system, quarantined by IMPORT SITE rather than by prefix:
 * only /grant and /settings pull them in, and those two pages want exactly the
 * unscoped element rules the rest of the product is being moved off. Holding
 * them to the .mm rule would mean rewriting 1,500 lines of stylesheet that
 * serve a wallet wizard nobody should be restyling during a redesign.
 *
 * They live in this directory so that everything with a stylesheet is in one
 * place and their quarantine is visible, not so that they are covered here.
 */
const QUARANTINED = new Set(["legacy.css", "legacy-console.css"]);

/** Selectors that may legitimately sit unscoped at the top level. */
const ALLOWED_BARE = new Set([":root", "html", "body", "*", "from", "to"]);

/** Strip comments, then collect every selector list that opens a block. */
function selectorsOf(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];

  const walk = (text: string, insideKeyframes: boolean): void => {
    let i = 0;
    let prelude = "";
    while (i < text.length) {
      const c = text[i]!;
      if (c === "{") {
        // Find the matching close brace.
        let depth = 1;
        let j = i + 1;
        while (j < text.length && depth > 0) {
          if (text[j] === "{") depth++;
          else if (text[j] === "}") depth--;
          j++;
        }
        const body = text.slice(i + 1, j - 1);
        const head = prelude.trim();

        if (head.startsWith("@")) {
          const kind = head.split(/[\s(]/)[0]!.toLowerCase();
          // A conditional group's contents are real selectors and must be
          // checked; keyframe stops (0%, from, to) are not selectors at all.
          if (kind === "@media" || kind === "@supports" || kind === "@layer" || kind === "@container") {
            walk(body, insideKeyframes);
          } else if (kind === "@keyframes" || kind === "@-webkit-keyframes") {
            /* percentages, not selectors */
          }
        } else if (head && !insideKeyframes) {
          out.push(head);
        }

        prelude = "";
        i = j;
        continue;
      }
      if (c === "}") {
        prelude = "";
        i++;
        continue;
      }
      if (c === ";" && prelude.trim().startsWith("@")) {
        // A statement at-rule such as @import or @charset.
        prelude = "";
        i++;
        continue;
      }
      prelude += c;
      i++;
    }
  };

  walk(src, false);
  return out;
}

/**
 * Every part of a selector list, trimmed.
 *
 * Splits on TOP-LEVEL commas only. A naive split tears
 * `.mm :where(h1, h2, p)` into fragments like "h2" and "p)", which then look
 * like unscoped element selectors — the checker would report the one thing it
 * exists to allow.
 */
function parts(selectorList: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of selectorList) {
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

describe("the new stylesheets are scoped, provably", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".css") && !QUARANTINED.has(f));

  it("there are stylesheets to check", () => {
    assert.ok(files.length > 0, "no .css under web/src/styles");
  });

  it("the quarantined sheets are only reachable from the pages that want them", () => {
    // The exclusion above is only safe while nothing else imports them. If a
    // third page picks one up, the old palette and its fixed background photo
    // are back on a surface that was moved off them deliberately.
    const web = path.join(process.cwd(), "web", "src");
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else if (/\.tsx?$/.test(e.name)) {
          const src = readFileSync(p, "utf8");
          // An IMPORT, not a mention. layout.tsx's comment explains why it no
          // longer imports these, and a looser pattern counted that as a
          // violation of the rule the comment describes.
          if (/import\s+["']@\/styles\/legacy(-console)?\.css["']/.test(src)) {
            importers.push(path.relative(web, p));
          }
        }
      }
    };
    walk(web);
    assert.deepEqual(
      importers.map((p) => p.split(path.sep).join("/")).sort(),
      // /settings migrated to the new system; /grant is deliberately not
      // being restyled until its guards are pinned — and /swap is the same
      // money-flow world as /grant (same permission, same wall), so it
      // carries the same .sc-root tokens on purpose. A fourth importer is
      // the one that needs to justify itself, not this one.
      ["app/grant/page.tsx", "app/swap/page.tsx"],
    );
  });

  for (const file of files) {
    it(`${file} scopes every rule under .mm`, () => {
      const css = readFileSync(path.join(DIR, file), "utf8");
      const offenders: string[] = [];

      for (const list of selectorsOf(css)) {
        for (const sel of parts(list)) {
          if (ALLOWED_BARE.has(sel)) continue;
          // `.mm`, `.mm-anything`, and any descendant of them.
          if (/^\.mm(?![a-zA-Z0-9])/.test(sel) || /^\.mm-[a-zA-Z0-9-]+/.test(sel)) continue;
          // `:where(.mm) button` — scoped under .mm, and deliberately carrying
          // no specificity so a reset loses to every class instead of beating
          // them. Still scoped; :where() changes only the weight.
          if (/^:where\(\.mm\)\s/.test(sel)) continue;
          offenders.push(sel);
        }
      }

      assert.deepEqual(
        offenders,
        [],
        `${file} has ${offenders.length} unscoped selector(s). Every rule must start with .mm ` +
          `or .mm-*, or the sheet leaks onto /grant and /settings the way console.css did.`,
      );
    });
  }

  it("catches an unscoped rule when there is one", () => {
    // The test's own regression guard. A checker that silently matches nothing
    // passes forever, which is precisely how the last claim went unverified.
    const bad = ".statusline { color: red; }\n@media (min-width: 860px) { .acct { color: blue; } }";
    const found = selectorsOf(bad).flatMap(parts);
    assert.deepEqual(found, [".statusline", ".acct"], "both the bare and the nested rule are seen");
  });

  it("does not tear a :where() list into fake element selectors", () => {
    // The bug this checker had on its first run: a naive comma split turned
    // `.mm :where(h1, p)` into ".mm :where(h1" and "p)", and reported "p)" as
    // an unscoped element rule.
    assert.deepEqual(parts(".mm :where(h1, h2, p), .mm-x"), [".mm :where(h1, h2, p)", ".mm-x"]);
  });

  it("does not mistake keyframe stops for selectors", () => {
    const css = "@keyframes spin { from { opacity: 0 } to { opacity: 1 } }\n.mm-x { color: red }";
    assert.deepEqual(selectorsOf(css).flatMap(parts), [".mm-x"]);
  });
});

describe("one sheet owns each component class", () => {
  /**
   * A CLASS DEFINED IN TWO SHEETS IS A COLLISION NOBODY GETS TOLD ABOUT.
   *
   * This test exists because it happened, in this repo, while adding the block
   * that renders the worker's warnings: `.mm-rail` was already the navigation
   * rail in shell.css, and a second definition in you.css silently reset the
   * nav's padding, its border and its `ul` layout on every page. CSS has no
   * error for it; load order decides, and the loser is whichever sheet imports
   * first. The page still rendered, which is why it nearly shipped.
   *
   * Two exceptions, both deliberate: `.mm` is the scope root every sheet nests
   * under by design, and `.mm-btn` is a shared control three sheets extend.
   */
  const SHARED = new Set([".mm", ".mm-btn"]);

  it("no component class is defined at the top level of two sheets", () => {
    const owners = new Map<string, Set<string>>();
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".css") && !QUARANTINED.has(f))) {
      const css = readFileSync(path.join(DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/^(\.[A-Za-z0-9_-]+)[^{}]*\{/gm)) {
        const cls = m[1]!;
        if (SHARED.has(cls)) continue;
        if (!owners.has(cls)) owners.set(cls, new Set());
        owners.get(cls)!.add(file);
      }
    }
    const collisions = [...owners]
      .filter(([, files]) => files.size > 1)
      .map(([cls, files]) => `${cls} in ${[...files].join(" and ")}`);
    assert.deepEqual(
      collisions,
      [],
      `two sheets define the same class, so load order decides which wins:\n  ${collisions.join("\n  ")}`,
    );
  });

  it("catches a collision when there is one", () => {
    // The checker's own regression guard, same as the unscoped test above: a
    // matcher that finds nothing passes forever.
    const owners = new Map<string, Set<string>>();
    for (const [file, css] of [
      ["a.css", ".mm-x { color: red }"],
      ["b.css", ".mm-x { color: blue }\n.mm-y { color: green }"],
    ] as const) {
      for (const m of css.matchAll(/^(\.[A-Za-z0-9_-]+)[^{}]*\{/gm)) {
        const cls = m[1]!;
        if (!owners.has(cls)) owners.set(cls, new Set());
        owners.get(cls)!.add(file);
      }
    }
    assert.deepEqual(
      [...owners].filter(([, f]) => f.size > 1).map(([c]) => c),
      [".mm-x"],
    );
  });
});
