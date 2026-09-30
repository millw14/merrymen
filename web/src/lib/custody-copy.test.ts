/**
 * NO WEB SURFACE SENDS THE MONEY HOME BY CONSTANT (docs/perps.md rule 13).
 *
 * The one sentence that says the funds are in the smart account belongs to
 * core's custodySentence, which says it only for `none`. The web used to carry
 * its own copies — the kill switch's "positions untouched", the discard
 * guard's "they stay in the smart account", the killed-agent status lines'
 * "Funds stay in your smart account" — each true of a spot book and false the
 * moment collateral or a leveraged position is on Lighter, or Lighter cannot
 * be read. This scans the web's CODE (comments stripped: the files that
 * explain the rule name the phrases) for any of them, so a new constant
 * cannot slip back in beside the builder.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const SRC = path.join(process.cwd(), "web", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source with comments removed — only what can reach a screen counts. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const PHRASES = [
  /stay in (?:your|the owner's|the) smart account/i,
  /funds stay in/i,
  /positions untouched/i,
  /does not sell them/i,
  /sit in the smart account/i,
];

test("no web module says where the money is with a constant — only custodySentence does", () => {
  const hits: string[] = [];
  for (const file of walk(SRC)) {
    const src = code(file);
    for (const re of PHRASES) {
      const m = src.match(re);
      if (m) hits.push(`${path.relative(SRC, file)}: "${m[0]}"`);
    }
  }
  assert.deepEqual(hits, [], "build the sentence with core custodySentence (lib/perps-view.ts) instead");
});
