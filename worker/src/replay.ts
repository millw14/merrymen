/**
 * WAS THE CALL RIGHT? Scored against what actually happened next.
 *
 * Live shadow tells us about freshness, latency, triggering and product
 * behaviour. It cannot tell us whether the decisions had any signal in them,
 * because nothing looks at what the price did afterwards. This does, and it is
 * deliberately v0: no backtesting framework, no simulated fills, no alternative
 * histories. One question, asked of decisions we already made.
 *
 * THE PRICE SERIES IS THE DECISION TAPE ITSELF. Every shadow run persists the
 * mark it decided against, so a sequence of runs on one instrument IS a series
 * of observations — irregular, roughly one every fifteen to twenty minutes, and
 * existing only while an agent is actually shadowing that instrument. That is a
 * real limitation and it is stated rather than hidden: `scoreable` says which
 * decisions could be judged at all, and the report never prints a hit rate over
 * a handful of them.
 *
 * WHAT IT REFUSES TO SCORE, and why each one would otherwise flatter us:
 *
 *   stale mark        a call made against a two-hour-old equity price is not a
 *                     call about the market; scoring it measures the feed
 *   no future yet     the horizon has not elapsed. Scoring the observations we
 *                     happen to have would silently shorten every horizon to
 *                     "as far as the data goes", which is survivorship by
 *                     another name
 *   too few points    MFE and MAE over two observations are the endpoints with
 *                     a longer name
 *
 * PURE. It is handed observations and returns verdicts.
 */

export interface PricedDecision {
  decisionId: string;
  agentId: string;
  agentName: string;
  symbol: string;
  at: number;
  action: string;
  confidence: number;
  /** The mark the decision was made against. Null when it could not be read. */
  priceUsd: number | null;
  /** Was that mark stale? A stale call is about the feed, not the market. */
  priceStale: boolean;
  economics: string;
  deltaUsdg: number;
}

export interface Horizon {
  label: string;
  seconds: number;
}

/**
 * The windows worth asking about.
 *
 * 1h is the shortest that contains more than a couple of observations at the
 * current cadence; 7d is the longest a shadow cohort will plausibly have data
 * for. Anything shorter measures the sampling interval and anything longer
 * measures nothing at all yet.
 */
export const HORIZONS: readonly Horizon[] = [
  { label: "1h", seconds: 3600 },
  { label: "24h", seconds: 86_400 },
  { label: "7d", seconds: 604_800 },
];

/** Fewest observations inside a window before an excursion means anything. */
const MIN_POINTS_FOR_EXCURSION = 3;

/**
 * How far past a horizon an observation may sit and still count as "at" it.
 *
 * The tape is irregular, so demanding an exact timestamp would score nothing.
 * A quarter of the horizon is generous enough to find a point and tight enough
 * that a 1h verdict is not quietly a 90-minute one.
 */
const HORIZON_TOLERANCE = 0.25;

export type Verdict = "right" | "wrong" | "flat" | "unscoreable";

export interface HorizonOutcome {
  label: string;
  /** The observation used, and how far from the horizon it actually sat. */
  futurePrice: number | null;
  observedAtLagSec: number | null;
  returnPct: number | null;
  /** Best and worst the price got, SIGNED to the decision's direction. */
  mfePct: number | null;
  maePct: number | null;
  points: number;
  verdict: Verdict;
  why: string;
}

export interface ScoredDecision extends PricedDecision {
  outcomes: HorizonOutcome[];
}

/** A price the tape observed, from any decision on the same instrument. */
export interface Observation {
  at: number;
  priceUsd: number;
}

/**
 * What counts as a real move.
 *
 * Below this a "right" call is noise wearing a verdict. Deliberately NOT tied
 * to the gas threshold: this measures whether the reasoning saw something, and
 * whether a trade would have paid for itself is a separate question the
 * economics verdict already answers.
 */
const FLAT_BAND_PCT = 0.5;

/**
 * Score one decision against the observations that followed it. PURE.
 *
 * `series` must be every observation for the SAME instrument, ascending. It may
 * include the decision's own point; it is ignored for the future.
 */
export function scoreDecision(
  d: PricedDecision,
  series: readonly Observation[],
  now: number,
  horizons: readonly Horizon[] = HORIZONS,
): ScoredDecision {
  const outcomes = horizons.map((h) => scoreHorizon(d, series, now, h));
  return { ...d, outcomes };
}

function unscoreable(label: string, why: string, points = 0): HorizonOutcome {
  return {
    label,
    futurePrice: null,
    observedAtLagSec: null,
    returnPct: null,
    mfePct: null,
    maePct: null,
    points,
    verdict: "unscoreable",
    why,
  };
}

function scoreHorizon(
  d: PricedDecision,
  series: readonly Observation[],
  now: number,
  h: Horizon,
): HorizonOutcome {
  if (d.priceUsd === null || d.priceUsd <= 0) {
    return unscoreable(h.label, "no mark was recorded for this decision");
  }
  if (d.priceStale) {
    // A call made against a two-hour-old equity price is a call about the feed.
    // Scoring it would credit or blame the reasoner for the market's hours.
    return unscoreable(h.label, "the mark was stale, so this is not a call about the market");
  }

  const target = d.at + h.seconds;
  if (now < target) {
    // NOT YET. Scoring against whatever we happen to have would silently
    // shorten every horizon to "as far as the data goes".
    return unscoreable(h.label, `the ${h.label} horizon has not elapsed yet`);
  }

  const window = series.filter((o) => o.at > d.at && o.at <= target && o.priceUsd > 0);
  const tolerance = h.seconds * HORIZON_TOLERANCE;
  const at = [...window]
    .filter((o) => o.at >= target - tolerance)
    .sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target))[0];
  if (!at) {
    return unscoreable(h.label, `no observation within ${Math.round(tolerance / 60)}m of the horizon`, window.length);
  }

  const base = d.priceUsd;
  const ret = ((at.priceUsd - base) / base) * 100;

  // EXCURSIONS ARE SIGNED TO THE DECISION. For a sell, a fall is favourable.
  // For a hold there is no direction, so the excursions describe what was left
  // on the table in each direction and the verdict asks whether staying out was
  // right — which it was if nothing much happened.
  const dir = d.action === "buy" ? 1 : d.action === "sell" ? -1 : 0;
  const moves = window.map((o) => ((o.priceUsd - base) / base) * 100);
  const best = moves.length ? Math.max(...moves) : null;
  const worst = moves.length ? Math.min(...moves) : null;
  const mfe = best === null || worst === null ? null : dir === 0 ? Math.max(best, -worst) : dir > 0 ? best : -worst;
  const mae = best === null || worst === null ? null : dir === 0 ? Math.min(Math.abs(best), Math.abs(worst)) : dir > 0 ? worst : -best;

  if (window.length < MIN_POINTS_FOR_EXCURSION) {
    // The return is still real; the excursions are the endpoints with a longer
    // name, so they are withheld rather than presented as a path.
    return {
      label: h.label,
      futurePrice: at.priceUsd,
      observedAtLagSec: at.at - target,
      returnPct: ret,
      mfePct: null,
      maePct: null,
      points: window.length,
      verdict: verdictFor(d.action, ret),
      why: `only ${window.length} observation(s) in the window — return is real, excursions are not`,
    };
  }

  return {
    label: h.label,
    futurePrice: at.priceUsd,
    observedAtLagSec: at.at - target,
    returnPct: ret,
    mfePct: mfe,
    maePct: mae,
    points: window.length,
    verdict: verdictFor(d.action, ret),
    why: verdictWhy(d.action, ret),
  };
}

function verdictFor(action: string, ret: number): Verdict {
  if (Math.abs(ret) < FLAT_BAND_PCT) {
    // A hold through a flat window is a correct hold. A buy or sell through one
    // is neither right nor wrong — it is a trade that cost gas for nothing, and
    // the economics verdict is where that is judged.
    return action === "hold" ? "right" : "flat";
  }
  if (action === "buy") return ret > 0 ? "right" : "wrong";
  if (action === "sell") return ret < 0 ? "right" : "wrong";
  if (action === "hold") return "wrong";
  // A refusal is not a call, so there is nothing to be right or wrong about.
  return "unscoreable";
}

function verdictWhy(action: string, ret: number): string {
  const moved = `${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%`;
  if (Math.abs(ret) < FLAT_BAND_PCT) {
    return action === "hold"
      ? `nothing happened (${moved}) and it stayed out`
      : `nothing happened (${moved}), so the trade would have paid gas for noise`;
  }
  if (action === "hold") return `it stayed out and the price moved ${moved}`;
  return `${action} and the price moved ${moved}`;
}

const pctStr = (n: number | null): string => (n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);

/**
 * The report.
 *
 * NEVER PRINTS A HIT RATE OVER A HANDFUL. A percentage computed from three
 * scoreable decisions reads as a measurement and is a coin flip, and this whole
 * exercise exists because a number that looks like evidence and is not is worse
 * than no number.
 */
const MIN_FOR_A_RATE = 10;

export function replayLines(scored: readonly ScoredDecision[], horizons: readonly Horizon[] = HORIZONS): string[] {
  const out: string[] = [];
  if (scored.length === 0) return ["no priced shadow decisions to replay yet"];

  out.push(`${scored.length} decision(s) with a recorded mark`);
  for (const h of horizons) {
    const at = scored.map((s) => s.outcomes.find((o) => o.label === h.label)!);
    const done = at.filter((o) => o.verdict !== "unscoreable");
    const right = done.filter((o) => o.verdict === "right").length;
    const wrong = done.filter((o) => o.verdict === "wrong").length;
    const flat = done.filter((o) => o.verdict === "flat").length;

    // WHY the rest could not be scored, counted — it is the more useful number
    // while a cohort is young, and it says what to fix.
    // Grouped on the raw sentence. An earlier version normalised digits away to
    // merge near-identical reasons, which also turned "the 1h horizon" into
    // "the Nh horizon" — a report about horizons that could not name one. The
    // reasons are a fixed handful and the tolerance is constant within a
    // horizon, so there is nothing to merge.
    const reasons: Record<string, number> = {};
    for (const o of at) if (o.verdict === "unscoreable") reasons[o.why] = (reasons[o.why] ?? 0) + 1;

    out.push(
      `  ${h.label.padEnd(4)} scoreable ${String(done.length).padStart(3)}/${scored.length} · ` +
        `right ${right} wrong ${wrong} flat ${flat}` +
        (done.length >= MIN_FOR_A_RATE
          ? ` · ${((right / done.length) * 100).toFixed(0)}% right`
          : ` · too few to state a rate (needs ${MIN_FOR_A_RATE})`),
    );
    for (const [why, n] of Object.entries(reasons)) out.push(`       ${n} unscoreable: ${why}`);
  }

  // The individual calls, so a verdict can be argued with rather than believed.
  const judged = scored.filter((s) => s.outcomes.some((o) => o.verdict !== "unscoreable"));
  for (const s of judged.slice(0, 20)) {
    const when = new Date(s.at * 1000).toISOString().slice(5, 16).replace("T", " ");
    const parts = s.outcomes
      .filter((o) => o.verdict !== "unscoreable")
      .map((o) => `${o.label} ${o.verdict} ${pctStr(o.returnPct)} (mfe ${pctStr(o.mfePct)} mae ${pctStr(o.maePct)})`);
    out.push(`  ${when} ${s.agentName} ${s.action.toUpperCase()} ${s.symbol} @${s.priceUsd} · ${parts.join(" · ")}`);
  }
  return out;
}
