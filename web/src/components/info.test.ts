/**
 * A TOOLTIP WITH NO STYLESHEET IS NOT A TOOLTIP — IT IS THE TEXT, PRINTED.
 *
 * <Info> hides its explanation with CSS alone. There is no JS, no `hidden`
 * attribute and no conditional render: `.info-pop` is an ordinary span that
 * happens to be absolutely positioned at opacity 0 until somebody hovers the
 * glyph. Every one of those words is a stylesheet rule.
 *
 * So when the component was first used on a terminal screen, it did not
 * degrade. legacy.css — the only sheet that had ever styled it — is quarantined
 * by import site, and the terminal layout does not import it. The caps row
 * would have rendered four full paragraphs of explanation inline, in the middle
 * of the wallet, permanently. A component whose failure mode is "publish the
 * hidden text" has to have its styles pinned rather than assumed.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The sheets a screen actually loads, by the import that loads them. */
function sheetsImportedBy(file: string): string[] {
  const src = read(file);
  const dir = file.slice(0, file.lastIndexOf("/"));
  return [...src.matchAll(/^import\s+"([^"]+\.css)";/gm)].map((m) => {
    const spec = m[1]!;
    return spec.startsWith("@/") ? `web/src/${spec.slice(2)}` : `${dir}/${spec.replace(/^\.\//, "")}`;
  });
}

/** The block for a selector, or "" — comments stripped so prose cannot match. */
function ruleFor(css: string, selector: string): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const found: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const heads = m[1]!.split(",").map((h) => h.trim());
    if (heads.some((h) => h.endsWith(selector) || h.endsWith(`${selector}:hover`))) found.push(m[2]!);
  }
  return found.join(" ");
}

function sources(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name)) out.push(rel);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

describe("the info tooltip is styled wherever it can render", () => {
  /**
   * The ONE entry point whose imports decide what an <Info> on a terminal
   * screen is styled by. legacy.css — the sheet the component was written
   * against — is imported by nothing at all today, so it is not a fallback and
   * is not listed here.
   */
  const LAYOUT = "web/src/app/layout.tsx";

  it("the terminal hides .info-pop by default", () => {
    const css = sheetsImportedBy(LAYOUT)
      .map((p) => {
        try {
          return read(p);
        } catch {
          return "";
        }
      })
      .join("\n");
    const pop = ruleFor(css, ".info-pop");
    assert.ok(pop.length > 0, "the terminal renders <Info> but no imported sheet styles .info-pop");
    assert.match(pop, /position:\s*absolute/, ".info-pop must be lifted out of the flow");
    assert.match(
      pop,
      /opacity:\s*0|display:\s*none/,
      ".info-pop must start HIDDEN — without this the explanation simply prints",
    );
    // And something must bring it back, or the text is unreachable.
    assert.match(css, /\.info:(hover|focus)[^{]*\.info-pop/, "nothing reveals the tooltip");
  });

  it("EVERY <Info> RENDERS UNDER A SHEET THAT HIDES IT", () => {
    // The bug was never a wrong rule. It was a screen nobody had checked: the
    // component worked in the sheet it was written for and printed its own
    // tooltip text in the one that was actually loaded. So the check is not
    // "does .info-pop exist" but "is every USE of it covered".
    const users = sources(["web/src"]).filter(
      (f) => !f.endsWith("Info.tsx") && !f.endsWith(".test.ts") && /<Info[\s>]/.test(read(f)),
    );
    assert.ok(users.length > 0, "<Info> is unused — delete it or use it, do not leave it half-wired");
    const stray = users.filter((f) => !f.startsWith("web/src/terminal/"));
    assert.deepEqual(
      stray,
      [],
      `these render <Info> outside .terminal-host, where nothing hides the popover: ${stray.join(", ")}`,
    );
  });
});
