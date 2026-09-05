/**
 * WHAT A TECHNICAL ANALYST CAN HONESTLY BE TOLD.
 *
 * The measured problem: across 33 production decisions and 120 analyst
 * readings, 106 came back `no-data` and not one lens ever returned a buy or
 * sell. The technical lens was being handed a single sentence containing one
 * spot price, usually marked stale. Asked to do technical analysis on that, an
 * analyst correctly answers that it has nothing — and every hold the desk
 * produced was a hold about the pipeline rather than about the market.
 *
 * So: a real series, and indicators computed from it. The series comes from the
 * Chainlink aggregator's own published rounds — no vendor, no new dependency,
 * and the same feed the mark already comes from.
 *
 * THE DISCIPLINE THAT MATTERS IS REFUSING TO OVERSTATE THE SERIES. Thirty
 * rounds on a 24/5 equity feed might cover two hours or two days depending on
 * how often the aggregator publishes, and the code cannot know which in
 * advance. So every figure carries the window it was actually computed over,
 * and any window the series does not cover returns NULL rather than being
 * quietly computed from whatever is there. A "24h return" derived from forty
 * minutes of data is not a smaller version of the truth; it is a different
 * number wearing its name.
 *
 * VOLUME IS ABSENT AND SAYS SO. A Chainlink price feed publishes prices, not
 * turnover. There is no honest volume figure to give an equity-token analyst
 * today, and inventing a proxy would be exactly the synthetic-neutral failure
 * this work exists to avoid.
 *
 * PURE. Given points, returns figures.
 */

export interface PricePoint {
  /** Unix seconds the round was published. */
  at: number;
  priceUsd: number;
}

/** A figure and the window it was actually measured over. */
export interface Windowed {
  label: string;
  /** Null when the series does not span this window. */
  value: number | null;
  /** Seconds the figure genuinely covers. Null when it was not computed. */
  spanSec: number | null;
  why?: string;
}

export interface TechnicalMaterial {
  asOf: number;
  symbol: string;
  price: number;
  priceSource: string;
  /** Seconds between the newest round and `asOf`. */
  freshnessSec: number | null;
  stale: boolean;
  series: {
    points: number;
    spanSec: number;
    oldestAt: number;
    newestAt: number;
    /** Median gap between rounds — says how dense the history really is. */
    medianGapSec: number | null;
  };
  returns: Windowed[];
  movingAverages: Windowed[];
  /** Annualised realised volatility, percent. */
  volatility: Windowed | null;
  range: { high: number; low: number; positionPct: number; spanSec: number } | null;
  /**
   * Turnover. ALWAYS NULL for a Chainlink-priced instrument, and the reason
   * travels with it so an analyst is not left guessing whether we forgot.
   */
  volume: { value: null; why: string };
}

/** Windows worth asking about, shortest first. */
const RETURN_WINDOWS: readonly { label: string; sec: number }[] = [
  { label: "15m", sec: 900 },
  { label: "1h", sec: 3600 },
  { label: "4h", sec: 14_400 },
  { label: "24h", sec: 86_400 },
];

const MA_WINDOWS: readonly { label: string; sec: number }[] = [
  { label: "1h", sec: 3600 },
  { label: "4h", sec: 14_400 },
  { label: "24h", sec: 86_400 },
];

/** Fewest points before a mean or a deviation describes anything. */
const MIN_POINTS_FOR_MEAN = 3;
const MIN_POINTS_FOR_VOL = 8;

const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * The value at or before `at`, or null when the series does not reach back.
 *
 * REACHING BACK IS THE WHOLE CHECK. Returning the oldest point when the series
 * is too short would turn "the last 40 minutes" into a 24-hour return, which is
 * the specific lie this module is built to refuse.
 */
function priceAt(points: readonly PricePoint[], at: number): PricePoint | null {
  if (!points.length) return null;
  if (points[0]!.at > at) return null;
  let best: PricePoint | null = null;
  for (const p of points) {
    if (p.at <= at) best = p;
    else break;
  }
  return best;
}

export function buildTechnical(args: {
  symbol: string;
  asOf: number;
  price: number;
  priceSource: string;
  stale: boolean;
  /** Ascending by time. The newest point is the current mark's round. */
  points: readonly PricePoint[];
}): TechnicalMaterial {
  const pts = [...args.points].filter((p) => p.priceUsd > 0 && p.at > 0).sort((a, b) => a.at - b.at);
  const newest = pts[pts.length - 1] ?? null;
  const oldest = pts[0] ?? null;
  const spanSec = newest && oldest ? newest.at - oldest.at : 0;

  const gaps: number[] = [];
  for (let i = 1; i < pts.length; i += 1) gaps.push(pts[i]!.at - pts[i - 1]!.at);

  const short = (label: string, need: number): Windowed => ({
    label,
    value: null,
    spanSec: null,
    why: `the series covers ${Math.round(spanSec / 60)}m, less than the ${Math.round(need / 60)}m this needs`,
  });

  // ── RETURNS ─────────────────────────────────────────────────────────────
  const returns: Windowed[] = RETURN_WINDOWS.map((w) => {
    if (spanSec < w.sec) return short(w.label, w.sec);
    const then = priceAt(pts, args.asOf - w.sec);
    if (!then || then.priceUsd <= 0) return short(w.label, w.sec);
    return {
      label: w.label,
      value: ((args.price - then.priceUsd) / then.priceUsd) * 100,
      spanSec: args.asOf - then.at,
    };
  });

  // ── MOVING AVERAGES ─────────────────────────────────────────────────────
  const movingAverages: Windowed[] = MA_WINDOWS.map((w) => {
    const inWindow = pts.filter((p) => p.at >= args.asOf - w.sec);
    if (spanSec < w.sec || inWindow.length < MIN_POINTS_FOR_MEAN) {
      return {
        label: w.label,
        value: null,
        spanSec: null,
        why:
          spanSec < w.sec
            ? `the series covers ${Math.round(spanSec / 60)}m, less than the ${Math.round(w.sec / 60)}m this needs`
            : `only ${inWindow.length} round(s) in the window, fewer than the ${MIN_POINTS_FOR_MEAN} a mean needs`,
      };
    }
    const mean = inWindow.reduce((s, p) => s + p.priceUsd, 0) / inWindow.length;
    return { label: w.label, value: mean, spanSec: args.asOf - inWindow[0]!.at };
  });

  // ── VOLATILITY ──────────────────────────────────────────────────────────
  //
  // Realised, from log returns between consecutive rounds, annualised by the
  // MEDIAN gap rather than an assumed bar size — the rounds are irregular and
  // pretending they are minutes would scale the answer by whatever the feed's
  // cadence happens to be.
  let volatility: Windowed | null = null;
  if (pts.length >= MIN_POINTS_FOR_VOL) {
    const rets: number[] = [];
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1]!.priceUsd;
      const b = pts[i]!.priceUsd;
      if (a > 0 && b > 0) rets.push(Math.log(b / a));
    }
    const gap = median(gaps);
    if (rets.length >= MIN_POINTS_FOR_VOL - 1 && gap !== null && gap > 0) {
      const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
      const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
      const perPeriod = Math.sqrt(variance);
      const periodsPerYear = (365 * 24 * 3600) / gap;
      volatility = {
        label: "realised",
        value: perPeriod * Math.sqrt(periodsPerYear) * 100,
        spanSec,
      };
    }
  } else {
    volatility = {
      label: "realised",
      value: null,
      spanSec: null,
      why: `only ${pts.length} round(s); a deviation needs at least ${MIN_POINTS_FOR_VOL}`,
    };
  }

  // ── RANGE ───────────────────────────────────────────────────────────────
  let range: TechnicalMaterial["range"] = null;
  if (pts.length >= MIN_POINTS_FOR_MEAN) {
    const prices = pts.map((p) => p.priceUsd);
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    range = {
      high,
      low,
      // Where the current mark sits between them. 0 is the low, 100 the high.
      positionPct: high > low ? ((args.price - low) / (high - low)) * 100 : 50,
      spanSec,
    };
  }

  return {
    asOf: args.asOf,
    symbol: args.symbol,
    price: args.price,
    priceSource: args.priceSource,
    freshnessSec: newest ? args.asOf - newest.at : null,
    stale: args.stale,
    series: {
      points: pts.length,
      spanSec,
      oldestAt: oldest?.at ?? 0,
      newestAt: newest?.at ?? 0,
      medianGapSec: median(gaps),
    },
    returns,
    movingAverages,
    volatility,
    range,
    volume: {
      value: null,
      why: "a Chainlink price feed publishes prices, not turnover — no volume source exists for this instrument",
    },
  };
}

const pct = (n: number | null): string => (n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
const mins = (s: number | null): string => (s === null ? "—" : `${Math.round(s / 60)}m`);

/**
 * The technical material as the analyst reads it.
 *
 * Every figure states its window, and every absence states why. A lens told
 * "24h return: unavailable, the series covers 41m" knows something; one told
 * nothing at all correctly reports no-data, which is what the fleet has been
 * doing for 106 of 120 readings.
 */
export function renderTechnical(t: TechnicalMaterial): string {
  const lines: string[] = [];
  lines.push(
    `${t.symbol} ${t.price} USD from ${t.priceSource}` +
      (t.stale ? " — STALE, the feed has stopped updating; treat this price as unreliable" : "") +
      (t.freshnessSec === null ? "" : ` (published ${mins(t.freshnessSec)} ago)`),
  );
  lines.push(
    `Series: ${t.series.points} published round(s) covering ${mins(t.series.spanSec)}, ` +
      `median ${mins(t.series.medianGapSec)} between rounds. Every figure below is measured over that window and no further.`,
  );

  const ret = t.returns
    .map((r) => (r.value === null ? `${r.label} unavailable (${r.why})` : `${r.label} ${pct(r.value)}`))
    .join(" · ");
  lines.push(`Returns: ${ret}`);

  const ma = t.movingAverages
    .map((m) =>
      m.value === null
        ? `${m.label} unavailable (${m.why})`
        : `${m.label} mean ${m.value.toFixed(4)} (price is ${pct(((t.price - m.value) / m.value) * 100)} against it)`,
    )
    .join(" · ");
  lines.push(`Moving averages: ${ma}`);

  if (t.volatility) {
    lines.push(
      t.volatility.value === null
        ? `Volatility: unavailable (${t.volatility.why})`
        : `Volatility: ${t.volatility.value.toFixed(1)}% annualised, realised over ${mins(t.volatility.spanSec)}`,
    );
  }

  if (t.range) {
    lines.push(
      `Range over ${mins(t.range.spanSec)}: low ${t.range.low.toFixed(4)}, high ${t.range.high.toFixed(4)}, ` +
        `and the mark sits ${t.range.positionPct.toFixed(0)}% of the way up it.`,
    );
  }

  lines.push(`Volume: none available — ${t.volume.why}.`);
  return lines.join("\n");
}
