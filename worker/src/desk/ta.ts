/**
 * THE DESK'S INDICATORS. Pure arithmetic over hourly candles, no I/O.
 *
 * Everything here describes a chart that already printed: trend, momentum,
 * range, participation and the levels price has respected. None of it is a
 * forecast, and none of it decides a trade — the Brain and the trading wall do
 * that elsewhere. What it buys a group answer is evidence a model can reason
 * over instead of a 24h-change echo.
 *
 * NULL MEANS "NOT ENOUGH CANDLES", never zero. A coin with eleven hours of
 * history has no EMA50, and printing one computed from eleven bars would be a
 * number that looks measured and is not.
 */

export interface Bar {
  /** Unix seconds at the bar's open. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** USD volume in the bar, when the index reported it. */
  volume: number | null;
}

/** Exponential moving average, seeded with the simple mean of the first `period` values. */
export function ema(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI on closes. Null below `period + 1` closes. */
export function rsi(closes: readonly number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Wilder's average true range. Null below `period + 1` bars. */
export function atr(bars: readonly Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const tr = (i: number): number => {
    const b = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  };
  let value = 0;
  for (let i = 1; i <= period; i++) value += tr(i);
  value /= period;
  for (let i = period + 1; i < bars.length; i++) value = (value * (period - 1) + tr(i)) / period;
  return value;
}

/** Volume-weighted typical price. Null when no bar carries volume. */
export function vwap(bars: readonly Bar[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    if (b.volume === null || !(b.volume > 0)) continue;
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : null;
}

export interface Pivot {
  time: number;
  price: number;
  kind: "high" | "low";
}

/**
 * Swing points: a bar whose high (low) is the extreme of the `span` bars on
 * either side. The newest `span` bars cannot be confirmed yet and are skipped,
 * which is the honest reading of a swing that is still forming.
 *
 * A tie goes to the FIRST bar: an hourly top usually prints the same high on
 * the candle that made it and the one that rejected it, and requiring both
 * sides strictly lower would call that top no swing at all.
 */
export function pivots(bars: readonly Bar[], span = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = span; i < bars.length - span; i++) {
    const b = bars[i]!;
    let high = true;
    let low = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      const before = j < i;
      if (before ? bars[j]!.high >= b.high : bars[j]!.high > b.high) high = false;
      if (before ? bars[j]!.low <= b.low : bars[j]!.low < b.low) low = false;
    }
    if (high) out.push({ time: b.time, price: b.high, kind: "high" });
    if (low) out.push({ time: b.time, price: b.low, kind: "low" });
  }
  return out;
}

export interface Level {
  price: number;
  /** How many swing points sit in this zone. */
  touches: number;
  /** Unix seconds of the most recent touch. */
  lastTime: number;
  /** Why it is a level, for a reader: "3 touches", "7d high". */
  label: string;
}

/**
 * Support and resistance from swing points, clustered.
 *
 * Pivots within a zone half an ATR wide (never under 1.5% of price) are one
 * level, priced at their mean. The 7d extremes are added as levels of their
 * own when no cluster already covers them: an all-time-in-window high is a
 * level every holder on the chart is looking at, touched once or not.
 */
export function levels(
  bars: readonly Bar[],
  price: number,
  atrValue: number | null,
): { supports: Level[]; resistances: Level[] } {
  if (!bars.length || !(price > 0)) return { supports: [], resistances: [] };
  const width = Math.max((atrValue ?? 0) * 0.5, price * 0.015);
  const sorted = pivots(bars).sort((a, b) => a.price - b.price);
  const clusters: { sum: number; n: number; last: number; min: number; max: number }[] = [];
  for (const p of sorted) {
    const c = clusters.at(-1);
    if (c && p.price - c.sum / c.n <= width) {
      c.sum += p.price;
      c.n += 1;
      c.last = Math.max(c.last, p.time);
      c.max = Math.max(c.max, p.price);
    } else {
      clusters.push({ sum: p.price, n: 1, last: p.time, min: p.price, max: p.price });
    }
  }
  const zones: Level[] = clusters.map((c) => ({
    price: c.sum / c.n,
    touches: c.n,
    lastTime: c.last,
    label: c.n > 1 ? `${c.n} touches` : "swing",
  }));
  const high = Math.max(...bars.map((b) => b.high));
  const low = Math.min(...bars.map((b) => b.low));
  const span = bars.length >= 120 ? "7d" : `${Math.max(1, Math.round(bars.length))}h`;
  const covers = (x: number) => zones.some((z) => Math.abs(z.price - x) <= width);
  if (!covers(high)) zones.push({ price: high, touches: 1, lastTime: bars.find((b) => b.high === high)!.time, label: `${span} high` });
  else for (const z of zones) if (Math.abs(z.price - high) <= width) z.label = `${span} high zone`;
  if (!covers(low)) zones.push({ price: low, touches: 1, lastTime: bars.find((b) => b.low === low)!.time, label: `${span} low` });
  else for (const z of zones) if (Math.abs(z.price - low) <= width) z.label = `${span} low zone`;

  // A level price is sitting inside is neither above nor below it: keep it off
  // both lists rather than call the candle it is on "support".
  const gap = width * 0.5;
  const rank = (a: Level, b: Level) => b.touches - a.touches || b.lastTime - a.lastTime;
  const supports = zones.filter((z) => z.price < price - gap);
  const resistances = zones.filter((z) => z.price > price + gap);
  // Nearest two each side, the stronger first only when they are equally near.
  const nearest = (list: Level[], below: boolean) =>
    [...list].sort((a, b) => (below ? b.price - a.price : a.price - b.price) || rank(a, b)).slice(0, 2);
  return { supports: nearest(supports, true), resistances: nearest(resistances, false) };
}

export type Trend = "uptrend" | "downtrend" | "range";
export type Structure = "higher highs and higher lows" | "lower highs and lower lows" | "mixed swings" | "too few swings";

export interface Technicals {
  bars: number;
  /** Hours of history the bars cover. */
  hours: number;
  last: number;
  ema20: number | null;
  ema50: number | null;
  /** EMA20's change over the last 6 bars, in percent. */
  ema20Slope6hPct: number | null;
  rsi14: number | null;
  /** ATR14 as a percent of price. */
  atrPct: number | null;
  atr: number | null;
  trend: Trend;
  structure: Structure;
  high24h: number | null;
  low24h: number | null;
  rangeHigh: number;
  rangeLow: number;
  /** Where price sits in the full window's range, 0–100. */
  rangePositionPct: number | null;
  /** Percent below the window high (positive = below). */
  belowHighPct: number;
  /** Percent above the window low. */
  aboveLowPct: number;
  vwap24h: number | null;
  /** Percent price sits above (+) or below (−) the 24h VWAP. */
  vsVwapPct: number | null;
  /** Average hourly volume of the last 6 bars over the 18 before them. */
  volume6hVsPrior: number | null;
  /** Last 24 bars' volume over the 24 before them. */
  volume24hVsPrior: number | null;
  /** Hourly returns of the last three closed bars, oldest first, percent. */
  lastBarsPct: number[];
  /** Std-dev of hourly log returns, percent. */
  hourlyVolPct: number | null;
  /** Measured change across the whole window, percent. */
  windowChangePct: number | null;
  supports: Level[];
  resistances: Level[];
}

const pct = (a: number, b: number): number => (a / b - 1) * 100;

function structureOf(bars: readonly Bar[]): Structure {
  const ps = pivots(bars);
  const highs = ps.filter((p) => p.kind === "high").slice(-3);
  const lows = ps.filter((p) => p.kind === "low").slice(-3);
  if (highs.length < 2 || lows.length < 2) return "too few swings";
  const rising = (xs: Pivot[]) => xs.every((p, i) => !i || p.price > xs[i - 1]!.price);
  const falling = (xs: Pivot[]) => xs.every((p, i) => !i || p.price < xs[i - 1]!.price);
  if (rising(highs) && rising(lows)) return "higher highs and higher lows";
  if (falling(highs) && falling(lows)) return "lower highs and lower lows";
  return "mixed swings";
}

function volumeRatio(bars: readonly Bar[], recent: number, prior: number): number | null {
  if (bars.length < recent + prior) return null;
  const vols = bars.slice(-(recent + prior)).map((b) => b.volume);
  if (vols.some((v) => v === null)) return null;
  const a = (vols.slice(-recent) as number[]).reduce((s, v) => s + v, 0) / recent;
  const b = (vols.slice(0, prior) as number[]).reduce((s, v) => s + v, 0) / prior;
  return b > 0 ? a / b : null;
}

/** Every reading the desk takes from one hourly series. Null for too few bars. */
export function technicals(input: readonly Bar[]): Technicals | null {
  const bars = [...input].filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0).sort((a, b) => a.time - b.time);
  if (bars.length < 6) return null;
  const closes = bars.map((b) => b.close);
  const last = closes.at(-1)!;
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const ema20 = e20.at(-1) ?? null;
  const ema50 = e50.at(-1) ?? null;
  const ema20Ago = e20.length > 6 ? e20.at(-7) ?? null : null;
  const atrValue = atr(bars, 14);
  const day = bars.slice(-24);
  const rangeHigh = Math.max(...bars.map((b) => b.high));
  const rangeLow = Math.min(...bars.map((b) => b.low));
  const vw = vwap(day);
  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
  const mean = returns.reduce((s, r) => s + r, 0) / Math.max(1, returns.length);
  const slope = ema20 !== null && ema20Ago !== null ? pct(ema20, ema20Ago) : null;

  let trend: Trend = "range";
  if (ema20 !== null && ema50 !== null && slope !== null) {
    if (last > ema20 && ema20 > ema50 && slope > 0) trend = "uptrend";
    else if (last < ema20 && ema20 < ema50 && slope < 0) trend = "downtrend";
  } else if (ema20 !== null && slope !== null) {
    if (last > ema20 && slope > 0) trend = "uptrend";
    else if (last < ema20 && slope < 0) trend = "downtrend";
  }

  const { supports, resistances } = levels(bars, last, atrValue);
  return {
    bars: bars.length,
    hours: Math.round((bars.at(-1)!.time - bars[0]!.time) / 3600) + 1,
    last,
    ema20,
    ema50,
    ema20Slope6hPct: slope,
    rsi14: rsi(closes, 14),
    atrPct: atrValue !== null ? (atrValue / last) * 100 : null,
    atr: atrValue,
    trend,
    structure: structureOf(bars),
    high24h: day.length ? Math.max(...day.map((b) => b.high)) : null,
    low24h: day.length ? Math.min(...day.map((b) => b.low)) : null,
    rangeHigh,
    rangeLow,
    rangePositionPct: rangeHigh > rangeLow ? ((last - rangeLow) / (rangeHigh - rangeLow)) * 100 : null,
    belowHighPct: (1 - last / rangeHigh) * 100,
    aboveLowPct: pct(last, rangeLow),
    vwap24h: vw,
    vsVwapPct: vw !== null ? pct(last, vw) : null,
    volume6hVsPrior: volumeRatio(bars, 6, 18),
    volume24hVsPrior: volumeRatio(bars, 24, 24),
    lastBarsPct: bars.slice(-3).map((b) => pct(b.close, b.open)),
    hourlyVolPct: returns.length >= 2 ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length) * 100 : null,
    windowChangePct: pct(last, bars[0]!.open),
    supports,
    resistances,
  };
}
