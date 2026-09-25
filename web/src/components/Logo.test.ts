/**
 * ONE MARK, THREE COPIES, AND NOTHING KEEPING THEM TOGETHER BUT THIS.
 *
 * The pill mark exists as JSX (`LogoMark` in Logo.tsx), as the favicon the site
 * and README use (site/public/favicon.svg), and as the web app's own favicon,
 * which scripts/pwa-icons.mjs copies from the site's and rasterises into every
 * PWA icon. After the 2026-09-05 redesign only the terminal's JSX changed, and
 * the browser tab, the home-screen icon and the legacy shell went on showing
 * the old feather-arrow for weeks. It looked fine wherever anyone was looking.
 *
 * So the geometry is compared here, pill by pill. Change the mark in one place
 * and this fails until the other copies match: edit the favicon, run
 * `node scripts/pwa-icons.mjs`, and bring the JSX along.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

type Pill = [x: number, y: number, w: number, h: number, rx: number];

function pills(src: string): Pill[] {
  return [...src.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"/g)].map(
    (m) => m.slice(1).map(Number) as Pill,
  );
}

const component = at("./Logo.tsx");
const siteFavicon = at("../../../site/public/favicon.svg");
const webFavicon = at("../../public/favicon.svg");

describe("the brand mark is one shape", () => {
  it("LogoMark draws the pill mark", () => {
    assert.equal(pills(component).length, 19);
    assert.match(component, /viewBox="0 0 940 630"/);
    assert.doesNotMatch(component, /rotate\(45/, "the feather-arrow is back in Logo.tsx");
  });

  it("the site favicon carries the same pills as LogoMark", () => {
    assert.deepEqual(pills(siteFavicon), pills(component));
  });

  it("the web app's favicon is the site's, unchanged", () => {
    // Line endings aside: a Windows checkout may write either file with CRLF.
    const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();
    assert.equal(norm(webFavicon), norm(siteFavicon), "run `node scripts/pwa-icons.mjs`");
  });

  it("the terminal re-exports the mark instead of drawing its own", () => {
    const ui = at("../terminal/ui.tsx");
    assert.doesNotMatch(ui, /function LogoMark\b/, "terminal/ui.tsx has its own LogoMark again");
    assert.match(ui, /import \{ LogoMark \} from "@\/components\/Logo"/);
  });
});
