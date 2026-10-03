/**
 * THE DESK'S CHARTS, as SVG and then PNG.
 *
 * TEXT IS DRAWN AS GLYPH OUTLINES, the P&L card's way (pnl-glyphs.ts): sharp
 * renders SVG through librsvg, and the worker's container has no fonts, so a
 * <text> element renders as nothing at all. Characters with no outline are
 * skipped, not boxed.
 *
 * `sharp` is imported lazily, as the card does: a host where the native image
 * library cannot load gets an answer without a picture, never no answer.
 */
import { PNL_GLYPH_EM, PNL_GLYPHS } from "../pnl-glyphs";
import type { CoinMeasure, MarketMeasure } from "./evidence";
import { coinHeader, marketHeader, marketStats } from "./evidence";
import { fmtPct, fmtPrice, fmtUsd, utcClock } from "./format";
import { ema } from "./ta";
import type { DeskReadOptions } from "./deadline";

const W = 1200;
const H = 675;
const C = {
  bg: "#0d1117",
  panel: "#11161d",
  grid: "#1e2631",
  text: "#e6edf3",
  dim: "#8b949e",
  up: "#26d07c",
  down: "#ff5a5f",
  ema20: "#f5b942",
  ema50: "#5aa9ff",
  vwap: "#c38bff",
} as const;

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The face has a bullet but no middle dot; the captions use the dot. */
const drawable = (text: string): string => text.replace(/·/g, "•");

export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of drawable(text)) {
    const g = PNL_GLYPHS[ch];
    if (g) w += (g.a * size) / PNL_GLYPH_EM;
  }
  return w;
}

/** A string as glyph paths. One <path> per glyph: librsvg drops very long `d` attributes. */
export function textSvg(text: string, x: number, baseline: number, size: number, fill: string, anchor: "start" | "middle" | "end" = "start"): string {
  const width = textWidth(text, size);
  let cursor = anchor === "end" ? x - width : anchor === "middle" ? x - width / 2 : x;
  const scale = size / PNL_GLYPH_EM;
  const out: string[] = [];
  for (const ch of drawable(text)) {
    const g = PNL_GLYPHS[ch];
    if (!g) continue;
    if (g.d) out.push(`<path transform="translate(${r2(cursor)} ${r2(baseline)}) scale(${Number(scale.toFixed(5))})" d="${g.d}" fill="${fill}"/>`);
    cursor += g.a * scale;
  }
  return out.join("");
}

/** Round-number ticks between lo and hi, about `count` of them. */
function ticks(lo: number, hi: number, count = 5): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 1) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function frame(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${C.bg}"/>${inner}</svg>`;
}

/** Candles, EMA20/50, the nearest levels and volume, for one coin's hourly chart. */
export function coinChartSvg(c: CoinMeasure): string | null {
  const t = c.tech;
  const bars = c.bars.slice(-168);
  if (!t || bars.length < 6) return null;
  const parts: string[] = [];
  const [title, sub] = coinHeader(c);
  const head = (title ?? "").split(" · ");
  parts.push(textSvg(`${head[0] ?? c.symbol} · 1h`, 32, 48, 30, C.text));
  const ch24 = c.pool.buckets.h24.changePct;
  if (head[2]) parts.push(textSvg(head[2], W - 32, 48, 26, typeof ch24 === "number" && ch24 < 0 ? C.down : C.up, "end"));
  if (sub) parts.push(textSvg(sub, 32, 80, 18, C.dim));

  const left = 32;
  const right = W - 130;
  const top = 104;
  const priceBottom = 520;
  const volTop = 540;
  const volBottom = 620;
  const closes = bars.map((b) => b.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const levelPrices = [...t.supports, ...t.resistances].map((l) => l.price);
  let lo = Math.min(...bars.map((b) => b.low));
  let hi = Math.max(...bars.map((b) => b.high));
  // Levels just off the visible window still belong on it, within reason.
  for (const p of levelPrices) if (p >= lo * 0.85 && p <= hi * 1.15) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
  const pad = (hi - lo) * 0.06 || hi * 0.02;
  lo -= pad;
  hi += pad;
  const y = (p: number) => priceBottom - ((p - lo) / (hi - lo)) * (priceBottom - top);
  const step = (right - left) / bars.length;
  const x = (i: number) => left + step * (i + 0.5);

  parts.push(`<rect x="${left}" y="${top}" width="${right - left}" height="${priceBottom - top}" fill="${C.panel}"/>`);
  parts.push(`<rect x="${left}" y="${volTop}" width="${right - left}" height="${volBottom - volTop}" fill="${C.panel}"/>`);
  for (const v of ticks(lo, hi, 5)) {
    if (v < lo || v > hi) continue;
    parts.push(`<line x1="${left}" x2="${right}" y1="${r2(y(v))}" y2="${r2(y(v))}" stroke="${C.grid}" stroke-width="1"/>`);
    parts.push(textSvg(fmtPrice(v), right + 10, y(v) + 6, 15, C.dim));
  }
  // Day boundaries, UTC.
  for (let i = 1; i < bars.length; i++) {
    const d = new Date(bars[i]!.time * 1000);
    if (d.getUTCHours() !== 0) continue;
    parts.push(`<line x1="${r2(x(i) - step / 2)}" x2="${r2(x(i) - step / 2)}" y1="${top}" y2="${volBottom}" stroke="${C.grid}" stroke-width="1"/>`);
    parts.push(textSvg(`${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`, x(i) - step / 2, volBottom + 24, 15, C.dim, "middle"));
  }
  const maxVol = Math.max(0, ...bars.map((b) => b.volume ?? 0));
  const body = Math.max(1, Math.min(9, step * 0.68));
  bars.forEach((b, i) => {
    const color = b.close >= b.open ? C.up : C.down;
    const cx = r2(x(i));
    parts.push(`<line x1="${cx}" x2="${cx}" y1="${r2(y(b.high))}" y2="${r2(y(b.low))}" stroke="${color}" stroke-width="1.2"/>`);
    const yo = y(b.open);
    const yc = y(b.close);
    parts.push(`<rect x="${r2(x(i) - body / 2)}" y="${r2(Math.min(yo, yc))}" width="${r2(body)}" height="${r2(Math.max(1, Math.abs(yo - yc)))}" fill="${color}"/>`);
    if (maxVol > 0 && b.volume !== null) {
      const h = ((b.volume ?? 0) / maxVol) * (volBottom - volTop - 6);
      parts.push(`<rect x="${r2(x(i) - body / 2)}" y="${r2(volBottom - h)}" width="${r2(body)}" height="${r2(Math.max(0.5, h))}" fill="${color}" fill-opacity="0.45"/>`);
    }
  });
  const line = (series: (number | null)[], color: string) => {
    const pts = series.map((v, i) => (v === null ? null : `${r2(x(i))},${r2(y(v))}`)).filter(Boolean);
    if (pts.length > 1) parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2"/>`);
  };
  line(e20, C.ema20);
  line(e50, C.ema50);
  // Axis tags: the levels and the last price, nudged apart so none hides another.
  const tags: { y: number; text: string; fill: string; ink: string; label?: string }[] = [];
  const level = (p: number, color: string, label: string) => {
    if (p < lo || p > hi) return;
    const yy = r2(y(p));
    parts.push(`<line x1="${left}" x2="${right}" y1="${yy}" y2="${yy}" stroke="${color}" stroke-width="1.5" stroke-dasharray="8 6" stroke-opacity="0.9"/>`);
    tags.push({ y: yy, text: fmtPrice(p), fill: color, ink: C.bg, label });
  };
  for (const s of t.supports) level(s.price, C.up, "support");
  for (const r of t.resistances) level(r.price, C.down, "resistance");
  tags.push({ y: r2(y(t.last)), text: fmtPrice(t.last), fill: C.text, ink: C.bg });
  tags.sort((a, b) => a.y - b.y);
  for (let i = 1; i < tags.length; i++) if (tags[i]!.y - tags[i - 1]!.y < 26) tags[i]!.y = tags[i - 1]!.y + 26;
  for (const tag of tags) {
    parts.push(`<rect x="${right + 4}" y="${r2(tag.y - 12)}" width="${r2(textWidth(tag.text, 15) + 14)}" height="24" rx="4" fill="${tag.fill}"/>`);
    parts.push(textSvg(tag.text, right + 11, tag.y + 6, 15, tag.ink));
    if (tag.label) {
      // The level's name on a pill at the left edge, clear of the newest candles.
      const w = textWidth(tag.label, 14) + 12;
      parts.push(`<rect x="${left + 6}" y="${r2(tag.y - 11)}" width="${r2(w)}" height="22" rx="4" fill="${C.bg}" fill-opacity="0.85"/>`);
      parts.push(textSvg(tag.label, left + 12, tag.y + 5, 14, tag.fill));
    }
  }
  // Legend and stamp.
  const legend = [
    ["EMA20", C.ema20],
    ["EMA50", C.ema50],
  ] as const;
  let lx = left + 12;
  for (const [name, color] of legend) {
    parts.push(`<rect x="${lx}" y="${top + 12}" width="18" height="4" fill="${color}"/>`);
    parts.push(textSvg(name, lx + 24, top + 20, 15, C.dim));
    lx += 24 + textWidth(name, 15) + 20;
  }
  if (t.rsi14 !== null) parts.push(textSvg(`RSI ${Number(t.rsi14.toFixed(1))}`, lx + 4, top + 20, 15, C.dim));
  parts.push(textSvg("volume", left + 10, volTop + 18, 14, C.dim));
  parts.push(textSvg(`merrymen · GeckoTerminal ${utcClock(c.observedAtMs)} UTC`, W - 32, H - 14, 15, C.dim, "end"));
  return frame(parts.join(""));
}

/** The 24h change of the busiest coins, as horizontal bars, with the board's breadth on top. */
export function marketChartSvg(m: MarketMeasure): string | null {
  const s = marketStats(m);
  const rows = s.byVolume.filter((c) => typeof c.change24h === "number").slice(0, 12);
  if (rows.length < 3) return null;
  const parts: string[] = [];
  const [title, sub] = marketHeader(m);
  parts.push(textSvg(title ?? "", 32, 48, 30, C.text));
  if (sub) parts.push(textSvg(sub, 32, 80, 18, C.dim));
  const top = 112;
  const bottom = H - 48;
  const labelW = 170;
  const volW = 150;
  const left = 32 + labelW;
  const right = W - 32 - volW;
  const zero = (left + right) / 2;
  const half = (right - left) / 2 - 70;
  const cap = Math.min(200, Math.max(10, ...rows.map((c) => Math.abs(c.change24h!))));
  const rowH = (bottom - top) / rows.length;
  parts.push(`<line x1="${zero}" x2="${zero}" y1="${top - 8}" y2="${bottom}" stroke="${C.grid}" stroke-width="2"/>`);
  rows.forEach((c, i) => {
    const cy = top + rowH * (i + 0.5);
    const v = c.change24h!;
    const len = (Math.min(Math.abs(v), cap) / cap) * half;
    const color = v >= 0 ? C.up : C.down;
    const barH = Math.min(26, rowH * 0.62);
    if (i % 2 === 0) parts.push(`<rect x="32" y="${r2(cy - rowH / 2)}" width="${W - 64}" height="${r2(rowH)}" fill="${C.panel}"/>`);
    parts.push(textSvg(c.symbol.slice(0, 12), 44, cy + 7, 19, C.text));
    parts.push(`<rect x="${r2(v >= 0 ? zero : zero - len)}" y="${r2(cy - barH / 2)}" width="${r2(Math.max(2, len))}" height="${r2(barH)}" rx="3" fill="${color}"/>`);
    parts.push(textSvg(fmtPct(v), v >= 0 ? zero + len + 8 : zero - len - 8, cy + 6, 17, color, v >= 0 ? "start" : "end"));
    parts.push(textSvg(`vol ${fmtUsd(c.volume24h)}`, W - 44, cy + 6, 16, C.dim, "end"));
  });
  parts.push(textSvg(`top ${rows.length} by 24h volume · merrymen · GeckoTerminal ${utcClock(m.observedAtMs)} UTC`, W - 32, H - 14, 15, C.dim, "end"));
  return frame(parts.join(""));
}

/** SVG → PNG. Null when the image library is unavailable or the SVG does not render. */
export async function renderPng(svg: string | null, options?: DeskReadOptions): Promise<Uint8Array | null> {
  if (!svg || options?.signal?.aborted) return null;
  try {
    const { default: sharp } = await import("sharp");
    if (options?.signal?.aborted) return null;
    const image = sharp(Buffer.from(svg)).png({ compressionLevel: 9 });
    // libvips also gets a processing ceiling; a caller timing out must not
    // leave native rendering running indefinitely behind its text answer.
    if (options?.timeoutMs) image.timeout({ seconds: Math.max(1, Math.ceil(options.timeoutMs / 1000)) });
    const abort = () => image.destroy();
    options?.signal?.addEventListener("abort", abort, { once: true });
    try {
      const png = await image.toBuffer();
      return options?.signal?.aborted ? null : new Uint8Array(png);
    } finally {
      options?.signal?.removeEventListener("abort", abort);
    }
  } catch {
    return null;
  }
}
