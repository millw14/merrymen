/**
 * Generate the dashboard's brand icon set from site/public/favicon.svg — the
 * pill mark on its dark tile, the same file the README and merrymen.dev use.
 *
 * Run: node scripts/pwa-icons.mjs
 *
 * One source. The favicon is copied into web/public byte for byte, and every
 * raster below is drawn from the pills parsed out of it, so the tab icon, the
 * home-screen icon and the in-app `LogoMark` (web/src/components/Logo.tsx)
 * cannot drift apart. `web/src/components/Logo.test.ts` pins the component and
 * both SVGs to the same geometry. The outputs are committed; regenerate only if
 * the mark changes.
 *
 * Three shapes are needed and they are not interchangeable:
 *   any       — the favicon's rounded tile, squared off, transparent corners.
 *   apple     — full bleed. iOS applies its own rounding and paints transparent
 *               corners black, so the tile has to reach the edges.
 *   maskable  — Android crops icons to a platform shape (circle, squircle,
 *               teardrop). Only a centred circle of radius 40% is guaranteed to
 *               survive, so the mark is scaled until its farthest point sits
 *               inside that circle. Shipping only an "any" icon is how logos end
 *               up beheaded on a Pixel launcher.
 */

import sharp from "sharp";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "site", "public", "favicon.svg");
const OUT = path.join(ROOT, "web", "public");

const svg = readFileSync(SRC, "utf8");
const viewBox = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
const tile = svg.match(/<rect[^>]*\brx="([\d.]+)"[^>]*\bfill="(#[0-9a-f]{6})"/i);
const group = svg.match(/<g fill="(#[0-9a-f]{6})">([\s\S]*?)<\/g>/i);
if (!tile || !group) throw new Error(`[icons] ${SRC} no longer has a tile rect and a <g fill> of pills`);
const [, tileRx, bg] = tile;
const [, lime, pillsXml] = group;
const pills = [...pillsXml.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"/g)].map((m) =>
  m.slice(1).map(Number),
);
if (pills.length === 0) throw new Error("[icons] no pills parsed from the favicon");

// The mark's own box, and how far its farthest edge reaches from the centre.
// Each pill is a stadium: two end caps of radius rx joined by a bar, so its
// farthest point from any centre is a cap centre's distance plus rx.
const minX = Math.min(...pills.map(([x]) => x));
const minY = Math.min(...pills.map(([, y]) => y));
const maxX = Math.max(...pills.map(([x, , w]) => x + w));
const maxY = Math.max(...pills.map(([, y, , h]) => y + h));
const cx = (minX + maxX) / 2;
const cy = (minY + maxY) / 2;
const reach = Math.max(
  ...pills.flatMap(([x, y, w, h, rx]) =>
    [x + rx, x + w - rx].map((capX) => Math.hypot(capX - cx, y + h / 2 - cy) + rx),
  ),
);
console.log(`[icons] ${pills.length} pills, ${maxX - minX}×${maxY - minY}, reach ${reach.toFixed(1)} from centre`);

// The favicon's tile is 1100×990. Square it about its own centre (which is the
// mark's), keeping the tile's width and corner radius, so every square icon is
// the favicon with a little more ground above and below.
const [vx, vy, vw, vh] = viewBox;
const side = Math.max(vw, vh);
const sx = vx + (vw - side) / 2;
const sy = vy + (vh - side) / 2;
const marks = `<g fill="${lime}">${pillsXml}</g>`;

function squareSvg(size, { rounded }) {
  const rx = rounded ? ` rx="${tileRx}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${sx} ${sy} ${side} ${side}"><rect x="${sx}" y="${sy}" width="${side}" height="${side}"${rx} fill="${bg}"/>${marks}</svg>`;
}

/** Full bleed, with the mark's farthest point at `safe` of the icon's width from centre. */
function maskableSvg(size, safe = 0.36) {
  const k = (safe * size) / reach;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${bg}"/><g transform="translate(${size / 2} ${size / 2}) scale(${k}) translate(${-cx} ${-cy})">${marks}</g></svg>`;
}

async function png(svgText, name) {
  await sharp(Buffer.from(svgText)).png({ compressionLevel: 9 }).toFile(path.join(OUT, name));
  const { width, height } = await sharp(path.join(OUT, name)).metadata();
  console.log(`[icons] ${name} (${width}×${height})`);
}

copyFileSync(SRC, path.join(OUT, "favicon.svg"));
console.log("[icons] favicon.svg (copied from site/public)");

await png(squareSvg(192, { rounded: true }), "icon-192.png");
await png(squareSvg(512, { rounded: true }), "icon-512.png");
// The 1024 master other tools (store listings, partner dashboards) take a
// raster from. package.json keeps it out of the npm tarball.
await png(squareSvg(1024, { rounded: true }), "merrymenlogo.png");
// iOS ignores the manifest's maskable hint and applies its own rounding, so the
// apple icon is full-bleed at the size iOS actually asks for.
await png(squareSvg(180, { rounded: false }), "apple-touch-icon.png");
await png(maskableSvg(512), "icon-maskable-512.png");
await png(maskableSvg(192), "icon-maskable-192.png");

// The standalone lockup (mark, wordmark, strapline) for anything that hotlinks
// app.merrymen.dev/logo.svg. Same tile colour and pills as the favicon.
const lockupK = 130 / (maxY - minY);
writeFileSync(
  path.join(OUT, "logo.svg"),
  `<svg width="520" height="300" viewBox="0 0 520 300" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- merrymen — autonomous trading agents for Robinhood Chain. Generated by scripts/pwa-icons.mjs from site/public/favicon.svg. -->
  <rect width="520" height="300" rx="24" fill="${bg}"/>
  <g transform="translate(260 99) scale(${+lockupK.toFixed(5)}) translate(${-cx} ${-cy})" fill="${lime}">${pillsXml.trim().replace(/\s*\n\s*/g, "\n    ")}
  </g>
  <text x="260" y="228" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="52" font-weight="700" letter-spacing="1" fill="#f5faee">merrymen</text>
  <text x="260" y="262" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="15" font-weight="600" letter-spacing="3" fill="#9ca3af">— AUTONOMOUS TRADING AGENTS —</text>
  <text x="260" y="284" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="14" font-weight="600" letter-spacing="3" fill="${lime}">FOR ROBINHOOD CHAIN</text>
</svg>
`,
);
console.log("[icons] logo.svg (520×300 lockup)");
