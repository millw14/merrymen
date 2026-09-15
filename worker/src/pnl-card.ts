/**
 * The card a Merryman sends when it closes a position.
 *
 * WHAT IT IS: `pnl/PNL.jpg` is the house template — logo, wordmark, the ETH
 * mark, and three labels already set in Geist Pixel: `invested`, `position`,
 * `pnl`. Those three labels are exactly the three numbers a closed round trip
 * produces, so this draws the values into the columns the template already has
 * rather than inventing a layout beside them.
 *
 * WHERE THE NUMBERS COME FROM — `applyFill` in basis.ts, on the sell that takes
 * a position to zero:
 *
 *   invested  = costOutUsdg   the cost basis the sale consumed
 *   position  = cashUsdg      what the sale actually returned
 *   pnl       = realizedUsdg  proceeds minus that basis
 *
 * so the card is the fill's own arithmetic and not a second, drifting estimate.
 *
 * NO FONT IS USED AT RENDER TIME. Text is emitted as paths from baked outlines
 * (`pnl-glyphs.ts`) because sharp's SVG renderer resolves families through the
 * system font stack and silently falls back — on a container with no fonts it
 * would draw a card with no numbers and report success. See the generator for
 * the measurements behind that.
 *
 * THE SVG BUILDER IS PURE and exported on its own: it needs no image library,
 * so the layout, the formatting and the refusals are all testable without
 * rasterising anything.
 */

import { fileURLToPath } from "node:url";

import { PNL_GLYPHS, PNL_GLYPH_EM } from "./pnl-glyphs";

/** Template geometry, measured off `pnl/PNL.jpg` (1280x853). */
const CARD = { width: 1280, height: 853 } as const;

/** The x of each baked label, so a value sits under the word it belongs to. */
const COLUMN = { invested: 50, position: 385, pnl: 723 } as const;

/** Baseline for the value row, just under the labels at y=686. */
const VALUE_BASELINE = 748;
const VALUE_SIZE = 40;

/** The headline block sits to the right of the ETH mark (which ends at x~155). */
const HEAD_X = 250;
const SYMBOL_BASELINE = 398;
const SYMBOL_SIZE = 46;
const ROI_BASELINE = 520;
const ROI_SIZE = 116;

/**
 * The headline must not run into the diagonal pattern on the right edge, which
 * starts around x=1000 and would make a big number unreadable.
 */
const HEAD_MAX_WIDTH = 720;
const SYMBOL_MAX_WIDTH = 720;

const GAIN = "#b6f03c";
const LOSS = "#ff6b5e";
const WHITE = "#ffffff";
const DIM = "#98a09a";

/** USDG is 6dp everywhere in this codebase. */
const USDG_DECIMALS = 6;

export interface PnlCardData {
  /** The token that was closed, e.g. "DOGGOS". */
  symbol: string;
  /** Cost basis the sale consumed, in USDG base units. */
  investedUsdg: bigint;
  /** What the sale returned, in USDG base units. */
  proceedsUsdg: bigint;
  /** Proceeds minus basis, in USDG base units. Signed. */
  realisedUsdg: bigint;
}

/** Fixed-point USDG to a 2dp string, without going through a float. */
export function formatUsdg(raw: bigint, signed = false): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const scale = 10n ** BigInt(USDG_DECIMALS);
  // Round half-up at the second decimal rather than truncating, so a card and a
  // ledger that both claim 2dp cannot disagree by a cent.
  const hundredths = (abs * 100n + scale / 2n) / scale;
  const whole = hundredths / 100n;
  const cents = hundredths % 100n;
  const body = `${whole}.${cents.toString().padStart(2, "0")}`;
  if (neg) return `-${body}`;
  return signed ? `+${body}` : body;
}

/**
 * Return on the capital that was actually at risk.
 *
 * Null when there is no basis to divide by. A position with no recorded cost
 * has an UNKNOWABLE return, not an infinite one — `applyFill` already refuses
 * to book P&L in that case (`basisUnknown`), and printing "+∞%" or "+0.0%" over
 * it would be the card inventing a number the ledger declined to state.
 */
export function roiPercent(investedUsdg: bigint, realisedUsdg: bigint): number | null {
  if (investedUsdg <= 0n) return null;
  return (Number(realisedUsdg) / Number(investedUsdg)) * 100;
}

/** The headline, e.g. "+247.8%" — or a plain dash when there is no basis. */
export function formatRoi(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "--";
  const sign = pct >= 0 ? "+" : "-";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Advance width of `text` at `size`, in px. Unknown characters cost nothing. */
export function measure(text: string, size: number): number {
  let w = 0;
  for (const ch of text) {
    const g = PNL_GLYPHS[ch];
    if (g) w += (g.a * size) / PNL_GLYPH_EM;
  }
  return w;
}

/**
 * Lay a string out as paths.
 *
 * One `<path>` per glyph, deliberately. Concatenating a run into a single `d`
 * is the obvious shape and it silently loses text: librsvg stops parsing an
 * attribute somewhere past ~100kB, which with a display-size face truncated
 * "+247.8%" to "+24" with no error anywhere.
 */
function textPaths(text: string, x: number, baseline: number, size: number, fill: string): string {
  const scale = size / PNL_GLYPH_EM;
  let cursor = x;
  const out: string[] = [];
  for (const ch of text) {
    const g = PNL_GLYPHS[ch];
    // Unknown characters are SKIPPED, not substituted. A card is a record of a
    // trade; a box glyph or a wrong character in a token symbol is worse than
    // a slightly short one.
    if (!g) continue;
    if (g.d) {
      out.push(
        `<path transform="translate(${round(cursor)} ${baseline}) scale(${round(scale, 5)})" d="${g.d}" fill="${fill}"/>`,
      );
    }
    cursor += g.a * scale;
  }
  return out.join("");
}

const round = (n: number, dp = 2) => Number(n.toFixed(dp));

/** Shrink `size` until `text` fits `maxWidth`. Never grows it. */
function fitSize(text: string, size: number, maxWidth: number): number {
  const w = measure(text, size);
  if (w <= maxWidth || w === 0) return size;
  return Math.max(12, Math.floor((size * maxWidth) / w));
}

/**
 * The overlay, as SVG. Pure — no filesystem, no image library.
 *
 * Returned WITHOUT the template behind it: the caller composites it, which
 * keeps this function testable by reading strings rather than pixels.
 */
export function pnlCardSvg(data: PnlCardData): string {
  const gain = data.realisedUsdg >= 0n;
  const accent = gain ? GAIN : LOSS;

  const symbol = data.symbol.trim().toUpperCase();
  const roi = formatRoi(roiPercent(data.investedUsdg, data.realisedUsdg));

  const parts = [
    textPaths(symbol, HEAD_X, SYMBOL_BASELINE, fitSize(symbol, SYMBOL_SIZE, SYMBOL_MAX_WIDTH), DIM),
    textPaths(roi, HEAD_X, ROI_BASELINE, fitSize(roi, ROI_SIZE, HEAD_MAX_WIDTH), accent),
    textPaths(formatUsdg(data.investedUsdg), COLUMN.invested, VALUE_BASELINE, VALUE_SIZE, WHITE),
    textPaths(formatUsdg(data.proceedsUsdg), COLUMN.position, VALUE_BASELINE, VALUE_SIZE, WHITE),
    textPaths(formatUsdg(data.realisedUsdg, true), COLUMN.pnl, VALUE_BASELINE, VALUE_SIZE, accent),
  ];

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD.width}" height="${CARD.height}" ` +
    `viewBox="0 0 ${CARD.width} ${CARD.height}"><title>${escapeAttr(symbol)} ${escapeAttr(roi)}</title>` +
    parts.join("") +
    `</svg>`
  );
}

/**
 * A `trades` row, narrowed to what a card needs. The columns are REAL in
 * SQLite, so they arrive as floats already rounded by storage.
 */
export interface ClosedFillRow {
  target?: string | null;
  fill_side?: string | null;
  fill_cash_usdg?: number | null;
  realized_pnl_usdg?: number | null;
  status?: string | null;
}

/** USDG float (as stored) to base units, without compounding the rounding. */
const toBase = (n: number) => BigInt(Math.round(n * 10 ** USDG_DECIMALS));

/**
 * The card for a sale that realised a P&L — or null when there is nothing to
 * show.
 *
 * WHAT COUNTS. A sell with a `realized_pnl_usdg` on it: `bookFill` writes that
 * column only when the basis was known, so its presence IS the statement that
 * the P&L is attributable. A buy, a refusal, and an unbacked sell all produce
 * no card rather than a card full of zeroes.
 *
 * INVESTED IS DERIVED, NOT STORED. `realized = proceeds - costOut` is the
 * definition `applyFill` uses, so `costOut = proceeds - realized` recovers the
 * basis exactly from the two columns the row already carries. Recomputing it
 * from the basis table instead would be a second read that can disagree with
 * the fill it is describing.
 *
 * NOTE this fires on any realised sale, including a partial trim: the three
 * figures are then the ones for the portion sold, which is what the row says
 * and what the labels mean. It is not restricted to a position reaching zero,
 * because the trades table does not record the remaining quantity.
 */
export function pnlCardFromFill(row: ClosedFillRow): PnlCardData | null {
  if (row.fill_side !== "sell") return null;
  if (row.realized_pnl_usdg === null || row.realized_pnl_usdg === undefined) return null;
  if (row.fill_cash_usdg === null || row.fill_cash_usdg === undefined) return null;
  const symbol = (row.target ?? "").trim();
  if (!symbol) return null;

  const proceeds = toBase(row.fill_cash_usdg);
  const realised = toBase(row.realized_pnl_usdg);
  return { symbol, investedUsdg: proceeds - realised, proceedsUsdg: proceeds, realisedUsdg: realised };
}

/**
 * Where the template lives, resolved from this module rather than the cwd.
 *
 * `fileURLToPath` and not `.pathname`: the latter leaves a URL-encoded string,
 * so a checkout under "milla projects" resolved to "milla%20projects" and the
 * card failed to render on the developer's own machine.
 */
export function templatePath(): string {
  return fileURLToPath(new URL("../../pnl/PNL.jpg", import.meta.url));
}

/**
 * Composite the overlay onto the template and return a PNG.
 *
 * `sharp` is imported LAZILY and on purpose. It is a native module, and the
 * worker must not fail to start — or a trade fail to book — because an image
 * library could not load on some host. A card that cannot be drawn is a missing
 * picture, never a missing sell.
 */
export async function renderPnlCard(data: PnlCardData, template = templatePath()): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(template)
    .composite([{ input: Buffer.from(pnlCardSvg(data)), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/**
 * The line that goes with the card, for a chat that cannot show one.
 *
 * THE NO-BASIS CASE GETS ITS OWN SENTENCE. Deriving the verb from the sign of
 * `realisedUsdg` alone read "closed up --" for a position with no cost on
 * record: `applyFill` books that as a zero it explicitly declines to interpret,
 * so a zero there means UNKNOWN, and calling it "up" is the card asserting a
 * profit the ledger refused to claim.
 */
export function pnlCaption(data: PnlCardData): string {
  const symbol = data.symbol.toUpperCase();
  const back = `back ${formatUsdg(data.proceedsUsdg)} USDG`;
  const pct = roiPercent(data.investedUsdg, data.realisedUsdg);
  if (pct === null) {
    return `${symbol} closed — ${back}. No cost basis on record, so this trade's P&L isn't attributable.`;
  }
  return (
    `${symbol} closed ${data.realisedUsdg >= 0n ? "up" : "down"} ${formatRoi(pct)} — ` +
    `invested ${formatUsdg(data.investedUsdg)} USDG, ` +
    `${back}, ` +
    `P&L ${formatUsdg(data.realisedUsdg, true)} USDG`
  );
}
