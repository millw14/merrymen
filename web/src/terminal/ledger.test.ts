/**
 * LEDGER, THE TERMINAL'S LOOK, HOLDS ONLY WHILE A FEW THINGS STAY TRUE.
 *
 * A look is easy to erode one rule at a time: a sheet imported after it, a
 * faint grey that drops below what can be read, a second palette on one
 * screen. None of those is an error anywhere, so these pin them. They read the
 * shipped stylesheets, not a list kept beside them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const bare = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The terminal's tokens, from the one block that defines them. */
function tokens(): Record<string, string> {
  const block = /\n\.terminal-host \{([^}]*--bg:[^}]*)\}/.exec(bare(read("terminal.css")))?.[1];
  assert.ok(block, "the token block in terminal.css");
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));
}

/** WCAG contrast between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("Ledger, the terminal's look", () => {
  it("loads after every other stylesheet the terminal imports", () => {
    const imports = [...read("App.tsx").matchAll(/^import "\.\/([^"]+\.css)";$/gm)].map((match) => match[1]);
    assert.ok(imports.length > 5);
    assert.equal(imports.at(-1), "ledger.css", "a sheet imported after it would win back the rules it restates");
    assert.equal(imports.filter((name) => name === "ledger.css").length, 1);
  });

  it("is scoped to the terminal, in and out of its media queries", () => {
    const css = bare(read("ledger.css"));
    // A selector list splits on its top-level commas only: `:where(:not(.a *, .b *))` is one selector.
    const split = (list: string) => {
      const out: string[] = []; let depth = 0, start = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i] === "(") depth++; else if (list[i] === ")") depth--;
        else if (list[i] === "," && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
      }
      return [...out, list.slice(start)];
    };
    const selectors = [...css.matchAll(/(?:^|[{}])\s*([^{}@]+?)\s*\{/g)].flatMap((match) => split(match[1]!)).map((selector) => selector.trim()).filter(Boolean);
    assert.ok(selectors.length > 40);
    for (const selector of selectors) assert.ok(selector.startsWith(".terminal-host"), `unscoped selector: ${selector}`);
  });

  it("keeps every text colour readable, on the page and on a raised surface", () => {
    const t = tokens();
    for (const name of ["bg", "card", "raised", "tx", "tx-2", "faint", "line", "lime", "ink", "down"]) assert.match(t[name] ?? "", /^#[0-9a-f]{6}$/, `--${name} is a plain hex colour`);
    assert.ok(contrast(t.tx!, t.bg!) >= 12, "text on the page");
    for (const surface of ["bg", "card", "raised"]) {
      assert.ok(contrast(t["tx-2"]!, t[surface]!) >= 4.5, `secondary text on --${surface}`);
      assert.ok(contrast(t.faint!, t[surface]!) >= 4.5, `faint labels on --${surface}`);
    }
    // What sits on the cream pill and on lime.
    assert.ok(contrast(t.ink!, t.tx!) >= 7); assert.ok(contrast(t.ink!, t.lime!) >= 7);
    assert.ok(contrast(t.down!, t.bg!) >= 4.5, "the stop and a loss");
    // Neither end of the palette is pure: cream on a warm black.
    assert.notEqual(t.tx, "#ffffff"); assert.notEqual(t.bg, "#000000");
  });

  it("paints no button lime: the next thing to do is cream, and lime is left to the trade", () => {
    const css = bare(read("ledger.css"));
    assert.doesNotMatch(css, /background(-color)?:\s*var\(--lime\)/);
    // The rules that used to paint a button lime are restated in cream.
    for (const selector of [".flow-primary", ".mm-action.primary", ".account-fund", ".desk-composer button", ".tour-next"]) assert.ok(css.includes(selector), selector);
    assert.match(css, /background:\s*var\(--tx\);\s*border-color:\s*transparent;\s*color:\s*var\(--ink\)/);
    // A trade's own confirm button is where money moves: Ledger leaves it as terminal.css paints it.
    assert.doesNotMatch(css, /\.desk-confirm-row button\s*\{/);
  });

  it("the Solana screen has no palette of its own: its colours are the terminal's, with matching fallbacks", () => {
    const css = bare(read("SolanaScreen.css")), t = tokens();
    assert.doesNotMatch(css, /#14f195/i, "Solana's green is gone");
    const mapped = [...css.matchAll(/--s-([a-z0-9]+):\s*var\(--([a-z0-9-]+),\s*(#[0-9a-f]{6})\)/g)];
    assert.ok(mapped.length >= 9);
    for (const [, local, token, fallback] of mapped) assert.equal(fallback, t[token!], `--s-${local} falls back to --${token}'s own value`);
  });
});
