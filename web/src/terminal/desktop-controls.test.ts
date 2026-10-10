import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

type Rule = { at: string | null; selectors: string[]; body: string; order: number };

// Like desk-scroll.test.ts, inspect declarations and their media scope rather
// than matching explanatory comments or a declaration on a different control.
function sheet(file: string): Rule[] {
  const css = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  const rules: Rule[] = [];
  const at: string[] = [];
  let prelude = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (ch === "{") {
      const head = prelude.trim().replace(/\s+/g, " ");
      prelude = "";
      if (head.startsWith("@")) {
        at.push(head.replace(/\s*:\s*/g, ": "));
        continue;
      }
      const end = css.indexOf("}", i);
      assert.ok(end > i, `unclosed CSS rule: ${head}`);
      rules.push({ at: at.at(-1) ?? null, selectors: head.split(/\s*,\s*/), body: css.slice(i + 1, end), order: rules.length });
      i = end;
    } else if (ch === "}") {
      at.pop();
      prelude = "";
    } else {
      prelude += ch;
    }
  }
  return rules;
}

const rules = sheet("./desktop.css");
const PHONE = "@media (max-width: 1099px)";
const FORM = ".terminal-host .terminal-form-page ";
const secondary = [".mm-chips button", ".cap", ".copy-btn", ".mm-btn", ".mode-tab", ".btn-kill"];
const primary = [".mm-btn.primary", ".grant-btn"];

function decl(rule: Rule, property: string): string | null {
  return rule.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1]?.trim() ?? null;
}

function ruleFor(selector: string, at: string | null, property?: string): Rule {
  const matches = rules.filter(rule => rule.at === at && rule.selectors.includes(selector) && (!property || decl(rule, property) !== null));
  assert.equal(matches.length, 1, `expected exactly one ${at ?? "global"} ${property ?? ""} rule for ${selector}`);
  return matches[0]!;
}

// The compared button selectors contain only classes and a possible `button`
// type. Include that type so the comparison follows their actual specificity.
function specificity(selector: string): number {
  return (selector.match(/\.[\w-]+/g)?.length ?? 0) * 100 + (/\bbutton\b/.test(selector) ? 1 : 0);
}

function wins(winner: Rule, selector: string, loser: Rule, otherSelector: string): void {
  assert.ok(
    specificity(selector) > specificity(otherSelector)
      || (specificity(selector) === specificity(otherSelector) && winner.order > loser.order),
    `${selector} must outrank ${otherSelector}`,
  );
}

describe("form controls remain usable on phones", () => {
  for (const control of secondary) {
    it(`${control} keeps a 44px target over the compact desktop rule`, () => {
      const selector = FORM + control;
      const mobile = ruleFor(selector, PHONE);
      const compact = ruleFor(selector, null, "min-height");
      assert.equal(decl(mobile, "min-height"), "44px");
      assert.equal(decl(mobile, "min-width"), "44px");
      assert.equal(decl(mobile, "padding"), "10px 14px");
      assert.equal(decl(mobile, "font-size"), "13px");
      // A floor in an earlier or weaker rule would leave the original bug.
      wins(mobile, selector, compact, selector);
      assert.equal(decl(compact, "min-height"), "0");
      assert.equal(decl(compact, "font-size"), "11px");
    });
  }

  for (const control of primary) {
    it(`${control} retains its 46px permission/save target`, () => {
      const selector = FORM + control;
      const mobile = ruleFor(selector, PHONE);
      assert.equal(decl(mobile, "min-height"), "46px");
      assert.equal(decl(mobile, "padding"), "14px 22px");
      assert.equal(decl(mobile, "font-size"), "14px");
      wins(mobile, selector, ruleFor(selector, null, "min-height"), selector);
      if (control === ".mm-btn.primary") {
        wins(mobile, selector, ruleFor(FORM + ".mm-btn", PHONE), FORM + ".mm-btn");
      }
    });
  }
});

describe("native form choices retain a visible keyboard focus indicator", () => {
  it("only text-like fields replace their outline with an underline", () => {
    const underline = ruleFor(FORM + "input:not([type=checkbox]):not([type=radio]):focus-visible", null);
    assert.equal(decl(underline, "outline"), "0");
    assert.equal(decl(underline, "border-bottom-color"), "var(--tx)");
    assert.ok(!rules.some(rule => rule.selectors.includes(FORM + "input:focus-visible") && decl(rule, "outline") === "0"));
  });

  for (const type of ["checkbox", "radio"]) {
    it(`${type} has its own outline at every width`, () => {
      const ring = ruleFor(FORM + `input[type=${type}]:focus-visible`, null);
      assert.equal(decl(ring, "outline"), "2px solid var(--tx)");
      assert.equal(decl(ring, "outline-offset"), "2px");
    });
  }
});

describe("the native search dialog's CSS", () => {
  it("does not override the browser's closed state or constrain its full-screen backdrop", () => {
    const backdrop = ruleFor(".terminal-host .search-dialog-backdrop", null);
    assert.equal(decl(backdrop, "display"), "none");
    assert.equal(decl(backdrop, "margin"), "0");
    assert.equal(decl(backdrop, "border"), "0");
    assert.equal(decl(backdrop, "box-sizing"), "border-box");
    for (const dimension of ["width", "height"]) {
      assert.equal(decl(backdrop, dimension), "100%");
      assert.equal(decl(backdrop, `max-${dimension}`), "none");
    }
    assert.equal(decl(ruleFor(".terminal-host .search-dialog-backdrop[open]", null), "display"), "flex");
  });

  it("keeps the explicit close control visible, touch-sized and keyboard-visible", () => {
    const close = ruleFor(".terminal-host .search-dialog-close", null);
    assert.equal(decl(close, "display"), "inline-flex");
    assert.equal(decl(close, "min-width"), "44px");
    assert.equal(decl(close, "min-height"), "44px");
    const focus = ruleFor(".terminal-host .search-dialog-close:focus-visible", null);
    assert.equal(decl(focus, "outline"), "2px solid var(--tx)");
    assert.equal(decl(focus, "outline-offset"), "2px");
  });
});
