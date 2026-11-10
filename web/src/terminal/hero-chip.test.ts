/**
 * THE HERO'S STATUS CHIP KEEPS TO ITS STAGE.
 *
 * `.mm-chip` is not the hero's alone: the example buttons under "Tell your
 * agent how to work" in Settings carry the class too. The chip's rule was
 * written for every .mm-chip in the terminal, so it also took those four
 * buttons out of their row and set them on one spot at the foot of the first
 * screen (position: absolute; left and bottom 14px), one on top of another and
 * over whatever was there. Only the last of the four could be tapped.
 *
 * Nothing errors when that happens, so this reads the shipped stylesheets, not
 * a list kept beside them, and pins where the chip's rules may reach.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";

interface Rule { file: string; selector: string; body: string }

const here = (path: string) => new URL(path, import.meta.url);
const bare = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** A selector list split at its own commas, not at those inside :where(), :not() or an attribute. */
function selectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < list.length; at++) {
    const ch = list[at];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) { out.push(list.slice(start, at)); start = at + 1; }
  }
  out.push(list.slice(start));
  return out.map((selector) => selector.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** Every style rule of every sheet the terminal can load, one entry per selector, in and out of media queries. */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const dir of ["./", "../merryman/"]) {
    for (const file of readdirSync(here(dir)).filter((name) => name.endsWith(".css"))) {
      const css = bare(readFileSync(here(dir + file), "utf8"));
      for (const match of css.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g)) {
        for (const selector of selectors(match[1]!)) out.push({ file, selector, body: match[2]! });
      }
    }
  }
  return out;
}

/** The class itself: not .mm-chips, the row, and not .mm-chip-x, the remove button. */
const CHIP = /\.mm-chip(?![\w-])/;
/** The chip reached through the hero's stage and through nothing else. */
const ON_STAGE = /(?<!:not\()\.mm-hero-stage(?![\w-])\)?[\s>]+(?:\S+[\s>]+)*?\S*\.mm-chip(?![\w-])/;

describe("the hero's status chip", () => {
  it("is styled on the hero's stage and nowhere else: no rule reaches a .mm-chip outside it", () => {
    const chip = rules().filter((rule) => CHIP.test(rule.selector));
    assert.ok(
      chip.some((rule) => rule.file === "merryman-shell.css" && /\.mm-chip$/.test(rule.selector) && /position:\s*absolute/.test(rule.body)),
      "the chip's own rule, the one that places it, in merryman-shell.css",
    );
    for (const rule of chip) {
      assert.match(rule.selector, ON_STAGE, `${rule.file}: "${rule.selector}" would also style the example buttons in Settings`);
    }
  });

  it("has one selector in its own sheet and in Ledger, so Ledger's type wins as the tie it is", () => {
    const whole = rules().filter((rule) => /\.mm-chip$/.test(rule.selector));
    const own = whole.filter((rule) => rule.file === "merryman-shell.css" && /position:\s*absolute/.test(rule.body));
    const ledger = whole.filter((rule) => rule.file === "ledger.css");
    assert.equal(own.length, 1, "the rule that places the chip");
    assert.equal(ledger.length, 1, "the rule that sets the chip's type in Ledger");
    assert.match(ledger[0]!.body, /font-size:\s*10px/);
    // Ledger loads last and restates the chip's type. It wins because the two
    // selectors weigh the same; a heavier one in the chip's own sheet would
    // hand the chip back its old bold 13px.
    assert.equal(ledger[0]!.selector, own[0]!.selector);
  });
});
