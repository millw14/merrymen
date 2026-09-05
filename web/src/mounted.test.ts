/**
 * A GUARD OVER A FILE NOBODY RENDERS GUARDS NOTHING.
 *
 * This repo protects claims-made-in-words by reading source in a test:
 * `honesty.test.ts` opens a component and asserts the sentence is still there.
 * That works exactly as long as the component is on a screen. The terminal
 * redesign moved every route body to `return null` and put the product in
 * `web/src/terminal/`, and the old components stayed in the tree — so a dozen
 * assertions kept passing over disclosures no user could reach. The suite was
 * green and the property was gone. Nothing failed, which is the whole problem:
 * a silent regression in the mechanism that exists to make regressions loud.
 *
 * So this walks the import graph from the route entrypoints, and checks that
 * every file a test reads is somewhere in it.
 *
 * IT IS AN ALLOW-LIST, NOT A BAN, and deliberately. The unmounted files are
 * still the written record of rules the live screens do not yet enforce —
 * `docs/terminal-port-debt.md` lists what has to move before each can go — so
 * deleting them today would destroy the specification before the
 * implementation exists. What this pins is the SET: it can shrink as
 * disclosures are ported and their assertions move, and any new entry fails
 * here with the name of the file and the test that was fooled.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.dirname(fileURLToPath(import.meta.url));

function walk(dir: string, keep: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(entry)) out.push(full);
  }
  return out;
}

const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

/** Resolve an import specifier to a file under src, or null if it leaves. */
function resolve(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // a package, or a @merrymen/* alias into worker/core
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Everything Next will actually load, and everything those files pull in.
 *
 * The roots are the file names the app router treats as entrypoints. A layout
 * counts even when it ignores `children` — `(app)/layout.tsx` renders the whole
 * terminal and never touches them, which is exactly why the route bodies are
 * empty and the components below them are not reachable through the pages.
 */
function mounted(): Set<string> {
  const ROOTS = /^(page|layout|route|error|not-found|global-error|template|middleware)\.(ts|tsx)$/;
  const seen = new Set<string>();
  const queue = walk(path.join(SRC, "app"), (f) => ROOTS.test(f));
  try {
    queue.push(path.join(SRC, "middleware.ts"));
  } catch {
    /* optional */
  }
  while (queue.length) {
    const file = queue.pop()!;
    const key = rel(file);
    if (seen.has(key)) continue;
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    seen.add(key);
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)) {
      const next = resolve(file, m[1]!);
      if (next) queue.push(next);
    }
  }
  return seen;
}

/**
 * Every source file a test opens to read.
 *
 * Matched on the PATH LITERAL rather than on the call, because these tests
 * reach the file three different ways — `readFileSync(new URL(p, …))` inline, a
 * local `at("…")` helper that builds the URL for you, and `code(at("…"))` —
 * and a matcher tied to one of them would quietly miss the other two, which is
 * the same class of hole this whole file exists to close.
 */
function readsOf(testFile: string): string[] {
  const src = readFileSync(testFile, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/["'](\.\.?\/[^"']+\.tsx?)["']/g)) {
    const resolved = resolve(testFile, m[1]!);
    if (resolved && resolved.startsWith(SRC) && /\.(ts|tsx)$/.test(resolved)) out.push(rel(resolved));
  }
  return out;
}

/**
 * Tests known to read a file no route mounts, and the file each one reads.
 *
 * EVERY LINE HERE IS DEBT. It means an assertion is passing about a sentence
 * nobody can see. `docs/terminal-port-debt.md` says what has to move onto the
 * live screen before the entry can go, component by component.
 */
const KNOWN_DEBT: Record<string, string[]> = {
  "app/(app)/t/[token]/honesty.test.ts": ["components/TokenFacts.tsx", "components/EntryTimeline.tsx"],
  "app/(app)/captions.test.ts": ["components/PriceLine.tsx"],
  "app/api/discoveries/honesty.test.ts": ["components/TokenCards.tsx", "app/(app)/tokens/TokensClient.tsx"],
  "components/equity-line-gate.test.ts": ["components/EquityLine.tsx"],
  "lib/rail-notices.test.ts": ["app/(app)/you/YouClient.tsx"],
  "lib/clear-grant.test.ts": ["components/KillSwitch.tsx"],
};

describe("a source-reading test reads a file that ships", () => {
  const live = mounted();
  const tests = walk(SRC, (f) => f.endsWith(".test.ts"));

  it("the walk found the app, and the app is bigger than its route files", () => {
    assert.ok(live.size > 30, `only ${live.size} files reachable — the import walk is broken`);
    assert.ok(live.has("terminal/App.tsx"), "the terminal shell must be reachable from (app)/layout.tsx");
    assert.ok(live.has("terminal/screens/Token.tsx"), "and the screens it mounts");
  });

  it("no test pins an unmounted file except the ones we have written down", () => {
    const found: Record<string, string[]> = {};
    for (const t of tests) {
      const orphans = readsOf(t).filter((r) => !live.has(r) && !r.endsWith(".test.ts"));
      if (orphans.length) found[rel(t)] = [...new Set(orphans)].sort();
    }
    for (const [test, files] of Object.entries(found)) {
      const allowed = KNOWN_DEBT[test];
      assert.ok(
        allowed,
        `${test} reads ${files.join(", ")}, which no route mounts — so its assertions ` +
          `pass over a screen nobody sees. Port the disclosure to the live screen and move ` +
          `the assertion, or add an entry to KNOWN_DEBT with a line in docs/terminal-port-debt.md.`,
      );
      for (const f of files) {
        assert.ok(
          allowed!.includes(f),
          `${test} now also reads the unmounted ${f} — a new vacuous guard`,
        );
      }
    }
  });

  it("the debt only shrinks: every entry we wrote down is still real", () => {
    // If a file in the list has been mounted or deleted, the entry is stale and
    // the list must be trimmed — otherwise it stops meaning anything.
    for (const [test, files] of Object.entries(KNOWN_DEBT)) {
      const actual = new Set(readsOf(path.join(SRC, test)));
      for (const f of files) {
        assert.ok(
          actual.has(f),
          `${test} no longer reads ${f} — remove it from KNOWN_DEBT`,
        );
        assert.ok(
          !live.has(f),
          `${f} is mounted again — remove it from KNOWN_DEBT, the guard is real now`,
        );
      }
    }
  });
});
