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
import { readdirSync, readFileSync } from "node:fs";

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

  it("what is chosen is cream, and the Perps desk sits on the terminal's neutrals", () => {
    const css = bare(read("ledger.css"));
    // Each of these said "selected" in lime or mint before.
    for (const rule of [
      /\.feed-views button\[aria-pressed="true"\]\s*\{[^}]*border-bottom-color:\s*var\(--tx\)/,
      /\.risk-option\.on\s*\{\s*border-color:\s*var\(--tx\)/,
      /\.mm-wardrobe\s*\{\s*--wd-accent:\s*var\(--tx\)/,
      /\.alpha-gate \.flow-primary\s*\{[^}]*background:\s*var\(--tx\)/,
    ]) assert.match(css, rule);
    // The desk keeps its accent and its softer up and down; its page, panels, rules and text are the terminal's.
    const desk = /\.terminal-host \.perps-desk\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    for (const [local, token] of [["bg", "bg"], ["panel", "card"], ["raised", "raised"], ["line", "line"], ["text", "tx"], ["muted", "tx-2"], ["accent", "lime"]])
      assert.match(desk, new RegExp(`--perps-${local}:\\s*var\\(--${token}\\)`), `--perps-${local}`);
    assert.doesNotMatch(desk, /--perps-(up|down)/, "the desk's own up and down stay");
    // Its controls' resting border is a variable the desk's own base rule reads. A rule here for every button, select
    // and input of the desk would outrank the desk's exceptions to that base: borderless tabs, Stop all's red edge.
    assert.match(desk, /--perps-control-line:\s*#[0-9a-f]{6}/);
    assert.doesNotMatch(css, /\.perps-desk\s+(button|select|input)\s*[,{]/, "no rule for every control of the desk");
    const perps = bare(read("perps-desk.css"));
    assert.equal(perps.match(/border:\s*1px solid var\(--perps-control-line, #3a493e\)/g)?.length, 2, "both of the desk's base control rules read it");
    assert.doesNotMatch(perps, /border:\s*1px solid #3a493e/);
    // The feed's chosen view is cream text only where it is an underlined label (a phone). On a desktop it is a cream
    // pill with ink on it, so the same colour outside the phone's query would be cream on cream.
    const outside = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    assert.doesNotMatch(outside, /\.feed-views/, "no feed-view rule outside a media query");
    assert.match(css, /@media \(max-width: 1099px\) \{\s*\.terminal-host \.feed-views button\[aria-pressed="true"\]\s*\{[^}]*color:\s*var\(--tx\)/);
    // The chain that is not open is quieter than the one that is, and outweighs the rule for unstyled links.
    assert.match(bare(read("SolanaNavigation.css")), /a:not\(\[aria-current\]\)\s*\{\s*color:\s*var\(--tx-2,/);
  });

  it("does not paint over a state of what it restyles: a disabled or pressed control keeps its own colours", () => {
    // This sheet loads last, so `.terminal-host X` beats `:where(.terminal-host) X:disabled` (equal weight) on every
    // property both set, and a send button with nothing to send showed as ready. Each such state is restated here.
    // A state written with `.terminal-host` in front, or with two parts (`:hover:not(:disabled)`), outweighs this
    // sheet and needs nothing.
    const split = (list: string) => {
      const out: string[] = []; let depth = 0, start = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i] === "(" || list[i] === "[") depth++; else if (list[i] === ")" || list[i] === "]") depth--;
        else if (list[i] === "," && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
      }
      return [...out, list.slice(start)].map((selector) => selector.replace(/\s+/g, " ").replace(/"/g, "").trim()).filter(Boolean);
    };
    const rules = (css: string) => [...bare(css).matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].flatMap((match) => {
      const props = new Set([...match[2]!.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map((declaration) => declaration[1]!));
      return split(match[1]!).map((selector) => ({ selector, props }));
    });
    // The properties a state is told apart by, and the shorthand that also sets each.
    const GROUPS = [["background", "background-color"], ["color"], ["border-color", "border"]];
    const shares = (a: Set<string>, b: Set<string>) => GROUPS.some((group) => group.some((prop) => a.has(prop)) && group.some((prop) => b.has(prop)));
    const mine = rules(read("ledger.css")), restated = new Set(mine.map((rule) => rule.selector));
    const others = [new URL("./", import.meta.url), new URL("../merryman/", import.meta.url)].flatMap((dir) =>
      readdirSync(dir).filter((name) => name.endsWith(".css") && name !== "ledger.css").flatMap((name) => rules(readFileSync(new URL(name, dir), "utf8"))));
    assert.ok(others.length > 2000 && mine.length > 100, `rules read: ${others.length} and ${mine.length}`);
    const STATE = /^(?::(?!:)[a-z-]+(?:\([^()]*\))?|\[[^\]]+\]|\.[\w-]+)$/;
    const painted: string[] = [];
    for (const rule of mine) {
      if (!rule.selector.startsWith(".terminal-host ")) continue;
      const thing = rule.selector.slice(".terminal-host ".length).replace(/:where\(:not\([^()]*\)\)/g, "");
      for (const other of others) {
        const theirs = other.selector.replace(/^:where\(\.terminal-host\) /, "");
        if (theirs.startsWith(".terminal-host ") || !theirs.startsWith(thing)) continue;
        const state = theirs.slice(thing.length);
        if (!STATE.test(state) || !shares(rule.props, other.props)) continue;
        if (!restated.has(`.terminal-host ${thing}${state}`)) painted.push(`${other.selector} is outranked by ${rule.selector}`);
      }
    }
    assert.deepEqual([...new Set(painted)], []);
    // The two that slipped through once.
    assert.match(bare(read("ledger.css")), /\.gc-composer button:disabled,\s*\.terminal-host \.desk-composer button:disabled\s*\{\s*background:\s*var\(--raised\);\s*color:\s*var\(--faint\)/);
  });

  it("the Solana screen has no palette of its own: its colours are the terminal's, with matching fallbacks", () => {
    const css = bare(read("SolanaScreen.css")), t = tokens();
    // Solana's green is gone from the screen and from the switch between the two chains.
    for (const sheet of [css, bare(read("SolanaNavigation.css"))]) assert.doesNotMatch(sheet, /#14f195|#223b32|#30353b/i);
    assert.match(bare(read("SolanaNavigation.css")), /a\[aria-current=page\]\s*\{[^}]*color:\s*var\(--tx,/, "the chain you are on is cream");
    // Of two sign-in buttons only the first is the cream pill.
    assert.match(css, /\.solana-screen \.flow-secondary\s*\{[^}]*background:\s*transparent/);
    const mapped = [...css.matchAll(/--s-([a-z0-9]+):\s*var\(--([a-z0-9-]+),\s*(#[0-9a-f]{6})\)/g)];
    assert.ok(mapped.length >= 9);
    for (const [, local, token, fallback] of mapped) assert.equal(fallback, t[token!], `--s-${local} falls back to --${token}'s own value`);
  });
});
