/**
 * HOW THE DESK WRITES A NUMBER — one way, everywhere.
 *
 * The brief a model reads, the caption a group reads and the labels on the
 * chart all print figures through these functions, because the group gate
 * checks every figure in a model's read against the figures in its brief
 * (tg-groups/desk.ts). Two spellings of one price would turn a faithful read
 * into a refused one. No thousands separators: "1,234" is two numbers to a
 * tokenizer and to the gate.
 */

/** A price to four significant figures, never in exponent form: 0.0002345, 0.1556, 1234. */
export function fmtPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "?";
  if (p >= 1000) return String(Math.round(p));
  if (p >= 1) return String(Number(p.toPrecision(4)));
  const digits = Math.min(18, Math.max(4, 3 - Math.floor(Math.log10(p))));
  return p.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

/** Dollars, compact: $512, $9.4k, $2.24m, $1.2b. */
export function fmtUsd(v: number): string {
  if (!Number.isFinite(v) || v < 0) return "?";
  const scale = v >= 1e9 ? [1e9, "b"] as const : v >= 1e6 ? [1e6, "m"] as const : v >= 1e3 ? [1e3, "k"] as const : [1, ""] as const;
  const n = v / scale[0];
  return `$${n >= 100 ? Math.round(n) : Number(n.toFixed(n >= 10 ? 1 : 2))}${scale[1]}`;
}

/** A signed percent: +12.4%, -3.1%, 0%. Over a thousand percent loses its decimal. */
export function fmtPct(v: number, signed = true): string {
  if (!Number.isFinite(v)) return "?";
  const r = Math.abs(v) >= 1000 ? Math.round(v) : Math.abs(v) >= 10 ? Number(v.toFixed(1)) : Number(v.toFixed(2));
  return `${signed && r > 0 ? "+" : ""}${r}%`;
}

/** A plain ratio: 1.8x. */
export function fmtX(v: number): string {
  return Number.isFinite(v) ? `${Number(v.toFixed(v >= 10 ? 0 : 1))}x` : "?";
}

/** A count: 1234 → 1234 (no separator, see above). */
export function fmtInt(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v)) : "?";
}

/** An age: 45m, 7h, 12d. */
export function fmtAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** HH:MM UTC. */
export function utcClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}
