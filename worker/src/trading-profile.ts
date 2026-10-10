/**
 * A MERRYMAN'S TASTE — the durable per-agent profile that changes SELECTION,
 * and can change nothing else.
 *
 * THE PROBLEM THIS SOLVES. Every agent on the class route runs the same scan,
 * the same eight reserves reads, the same tape and the same `chooseEntry`
 * argmax, so Shogun and SirSendIt bought the SAME launch 442 blocks apart. A
 * fleet of identical pickers is one picker with extra gas. The brief asks for
 * agents that differ — and asks, in the same breath, that the difference come
 * from preferences, memory and theses, NEVER from random noise. Noise makes two
 * agents look different while giving neither a reason; a profile gives each a
 * reason, and the same profile on the same snapshot gives the same answer.
 *
 * WHAT A PROFILE MAY NEVER DO is loosen a signed or owner-set limit. The
 * deterministic prefilter (`scoreLeg` with the owner's classMinDepthUsdg,
 * maxImpactBps and graduation ceiling) decides WHO IS ELIGIBLE, and this module
 * only ORDERS the survivors and shapes what the Brain is told. It is fed the
 * survivors and nothing else, so it cannot reach a candidate the wall refused —
 * candidate-score.ts:16-20 states the rule for styles and it holds here word
 * for word. `rankForProfile` takes no thresholds and returns no thresholds.
 *
 * CLOSED ENUMS, NO FREE TEXT. The profile is rendered into a prompt. soul.ts
 * records why user-supplied prose must be sanitised before it reaches a model;
 * a profile made of enum words has nothing to sanitise, and the settings route
 * can validate it by membership the way it validates `assetMode`.
 */
import {
  PROFILE_HOLDS,
  PROFILE_LIQUIDITIES,
  PROFILE_MOMENTUMS,
  PROFILE_TURNOVERS,
  SETTINGS_DEFAULTS,
  type ProfileHold,
  type ProfileLiquidity,
  type ProfileMomentum,
  type ProfileTurnover,
} from "../../packages/core/src/index";
import type { RiskStyle } from "./venues/candidate-score";
import { isRiskStyle } from "./venues/candidate-score";
import type { CurveTrend } from "./venues/pons-tape";

/** When in a move the agent likes to enter. */
export type MomentumTaste = ProfileMomentum;
/** How much real depth it insists on before caring about anything else. */
export type LiquidityTaste = ProfileLiquidity;
/** How busy a market it wants. */
export type TurnoverTaste = ProfileTurnover;
/** How long it means to stay. */
export type HoldTaste = ProfileHold;

export interface TradingProfile {
  /** Sent to the Brain as `risk_appetite`; it already understands the three words. */
  riskAppetite: RiskStyle;
  momentum: MomentumTaste;
  liquidity: LiquidityTaste;
  turnover: TurnoverTaste;
  hold: HoldTaste;
  /** The Brain's `confidence` must reach this for a buy to count. 0..1. */
  convictionMin: number;
  /** How many ranked survivors the Brain is asked to research. 1..5. */
  researchTopN: number;
}

/** The vocabulary lives in core so the settings route and the worker cannot drift. */
export const MOMENTUM_TASTES: readonly MomentumTaste[] = PROFILE_MOMENTUMS;
export const LIQUIDITY_TASTES: readonly LiquidityTaste[] = PROFILE_LIQUIDITIES;
export const TURNOVER_TASTES: readonly TurnoverTaste[] = PROFILE_TURNOVERS;
export const HOLD_TASTES: readonly HoldTaste[] = PROFILE_HOLDS;

/** The defaults are core's defaults — one source, the same one the settings page shows. */
export const PROFILE_DEFAULTS: TradingProfile = Object.freeze({
  riskAppetite: SETTINGS_DEFAULTS.profileRiskAppetite,
  momentum: SETTINGS_DEFAULTS.profileMomentum,
  liquidity: SETTINGS_DEFAULTS.profileLiquidity,
  turnover: SETTINGS_DEFAULTS.profileTurnover,
  hold: SETTINGS_DEFAULTS.profileHold,
  convictionMin: SETTINGS_DEFAULTS.profileConvictionMin,
  researchTopN: SETTINGS_DEFAULTS.profileResearchTopN,
});

/**
 * The profile as the worker's resolved settings carry it — the durable seat.
 * `ResolvedConfig` has already validated every field against the enums and
 * bounds, so this is a rename, not a second parse.
 */
export function profileFromSettings(cfg: {
  profileRiskAppetite: RiskStyle;
  profileMomentum: MomentumTaste;
  profileLiquidity: LiquidityTaste;
  profileTurnover: TurnoverTaste;
  profileHold: HoldTaste;
  profileConvictionMin: number;
  profileResearchTopN: number;
}): TradingProfile {
  return {
    riskAppetite: cfg.profileRiskAppetite,
    momentum: cfg.profileMomentum,
    liquidity: cfg.profileLiquidity,
    turnover: cfg.profileTurnover,
    hold: cfg.profileHold,
    convictionMin: cfg.profileConvictionMin,
    researchTopN: cfg.profileResearchTopN,
  };
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * Coerce an untrusted record into a profile. Unknown words fall back to the
 * default for that field rather than failing the whole profile: a settings
 * blob written by an older build must still yield an agent with a taste.
 */
export function parseProfile(raw: Record<string, unknown> | null | undefined): TradingProfile {
  const r = raw ?? {};
  const conviction = typeof r.convictionMin === "number" && Number.isFinite(r.convictionMin)
    ? Math.min(1, Math.max(0, r.convictionMin))
    : PROFILE_DEFAULTS.convictionMin;
  const topN = typeof r.researchTopN === "number" && Number.isFinite(r.researchTopN)
    ? Math.min(5, Math.max(1, Math.round(r.researchTopN)))
    : PROFILE_DEFAULTS.researchTopN;
  return {
    riskAppetite: isRiskStyle(r.riskAppetite) ? r.riskAppetite : PROFILE_DEFAULTS.riskAppetite,
    momentum: oneOf(r.momentum, MOMENTUM_TASTES, PROFILE_DEFAULTS.momentum),
    liquidity: oneOf(r.liquidity, LIQUIDITY_TASTES, PROFILE_DEFAULTS.liquidity),
    turnover: oneOf(r.turnover, TURNOVER_TASTES, PROFILE_DEFAULTS.turnover),
    hold: oneOf(r.hold, HOLD_TASTES, PROFILE_DEFAULTS.hold),
    convictionMin: conviction,
    researchTopN: topN,
  };
}

/** The profile as one sentence a model can hold in mind — enum words only. */
export function profileSentence(p: TradingProfile): string {
  const momentum = {
    early: "enters EARLY, on acceleration before the crowd confirms it",
    confirming: "enters once a move is CONFIRMING — activity and price agree",
    late: "enters LATE, only into markets that have already proven they survive",
  }[p.momentum];
  const liquidity = {
    "thin-ok": "will accept thin liquidity",
    "prefer-deep": "prefers deep liquidity and pays for it in missed early moves",
  }[p.liquidity];
  const turnover = { low: "wants quiet markets", medium: "wants a normally busy market", high: "wants a very busy market" }[p.turnover];
  const hold = { quick: "takes quick exits", ride: "rides a winner and needs runway before the graduation cliff" }[p.hold];
  return (
    `Risk appetite ${p.riskAppetite}; ${momentum}; ${liquidity}; ${turnover}; ${hold}. ` +
    `Acts on a buy only above ${p.convictionMin.toFixed(2)} confidence.`
  );
}

/**
 * What the ranker looks at for one SURVIVOR. Every number was measured by the
 * deterministic layer; the ranker adds no reads and takes no thresholds.
 */
export interface RankableCandidate {
  /** Opaque key the caller maps back to its leg. */
  key: string;
  symbol: string;
  /** Real depth in whole USD, whatever the curve is quoted in. */
  depthUsd: number;
  /** Measured round-trip cost at the agent's entry size, bps. */
  costBps: number;
  /** 0..10000 along the curve. */
  graduationBps: number;
  /** Seconds since launch, or null when the clock could not be read. */
  ageSec: number | null;
  trend: CurveTrend;
}

export interface RankTerm {
  feature: string;
  /** Percentile rank of this candidate on the feature, 0..1, after direction. */
  rank: number;
  weight: number;
  /** rank × weight. */
  contribution: number;
}

export interface RankedCandidate {
  key: string;
  symbol: string;
  score: number;
  terms: RankTerm[];
  /** One sentence naming the two terms that decided it. Deterministic. */
  reasoning: string;
}

interface FeatureSpec {
  feature: string;
  weight: number;
  /** Higher raw value ranks higher when true. */
  higherIsBetter: boolean;
  value: (c: RankableCandidate) => number | null;
}

const win = (c: RankableCandidate, i: number) => c.trend.windows[Math.min(i, c.trend.windows.length - 1)]!;

/**
 * The weights behind each taste. Read them as "how much this agent cares".
 *
 * Kept as data rather than branches so a test can assert the two properties
 * that matter: every taste yields a weight table, and no table contains a
 * threshold. The numbers are a starting point for shadow comparison, not a
 * fitted model — fitting comes after the shadow tape says what predicted an
 * exit that paid.
 */
export function featureWeights(p: TradingProfile): FeatureSpec[] {
  const m = p.momentum;
  const busy = p.turnover === "high" ? 1.5 : p.turnover === "low" ? 0.5 : 1;
  const deep = p.liquidity === "prefer-deep";
  const ride = p.hold === "ride";
  const specs: FeatureSpec[] = [
    {
      feature: "trade acceleration (5m rate ÷ 1h rate)",
      weight: m === "early" ? 3 : m === "confirming" ? 1.5 : 0.5,
      higherIsBetter: true,
      value: (c) => c.trend.tradeAcceleration,
    },
    {
      feature: "volume acceleration (5m ÷ 1h)",
      weight: m === "early" ? 2 : m === "confirming" ? 1.5 : 0.5,
      higherIsBetter: true,
      value: (c) => c.trend.volumeAcceleration,
    },
    {
      feature: "trades in 15m",
      weight: (m === "late" ? 2 : m === "confirming" ? 2 : 1) * busy,
      higherIsBetter: true,
      value: (c) => win(c, 1).trades,
    },
    {
      feature: "trades in 1h",
      weight: (m === "late" ? 3 : 0.5) * busy,
      higherIsBetter: true,
      value: (c) => win(c, 2).trades,
    },
    {
      feature: "new traders in 5m",
      weight: m === "early" ? 2 : 1,
      higherIsBetter: true,
      value: (c) => win(c, 0).newTraders,
    },
    {
      feature: "distinct traders in 1h",
      weight: m === "late" ? 2 : 1,
      higherIsBetter: true,
      value: (c) => win(c, 2).traders,
    },
    {
      feature: "buy-side quote imbalance 5m",
      weight: m === "confirming" ? 1.5 : 1,
      higherIsBetter: true,
      value: (c) => win(c, 0).imbalanceQuote,
    },
    {
      feature: "price momentum 15m",
      weight: m === "confirming" ? 2 : m === "late" ? 2 : 0.5,
      higherIsBetter: true,
      value: (c) => win(c, 1).momentum,
    },
    {
      feature: "real depth",
      weight: deep ? 2.5 : 0.5,
      higherIsBetter: true,
      value: (c) => c.depthUsd,
    },
    {
      feature: "round-trip cost",
      weight: deep ? 2 : 1,
      higherIsBetter: false,
      value: (c) => c.costBps,
    },
    {
      feature: "room before graduation",
      weight: ride ? 2 : 0.5,
      higherIsBetter: false,
      value: (c) => c.graduationBps,
    },
    {
      feature: "age",
      weight: m === "early" ? 1.5 : m === "late" ? 1 : 0.5,
      // Early wants YOUNG (lower age ranks higher); late wants OLD.
      higherIsBetter: m === "late",
      value: (c) => c.ageSec,
    },
  ];
  return specs;
}

/**
 * Percentile rank of each value within the set, 0..1, ties sharing a rank.
 * Null values rank at the bottom regardless of direction — "could not measure"
 * is never a reason to prefer a candidate.
 */
function percentileRanks(values: (number | null)[], higherIsBetter: boolean): number[] {
  const known = values
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v !== null && Number.isFinite(x.v));
  const out = values.map(() => 0);
  if (known.length === 0) return out;
  if (known.length === 1) {
    out[known[0]!.i] = 1;
    return out;
  }
  const sorted = [...known].sort((a, b) => (higherIsBetter ? a.v - b.v : b.v - a.v));
  // Average rank for ties, then normalise to 0..1.
  let k = 0;
  while (k < sorted.length) {
    let j = k;
    while (j + 1 < sorted.length && sorted[j + 1]!.v === sorted[k]!.v) j++;
    const avg = (k + j) / 2;
    for (let q = k; q <= j; q++) out[sorted[q]!.i] = avg / (sorted.length - 1);
    k = j + 1;
  }
  return out;
}

/**
 * Order the survivors by this agent's taste. PURE and DETERMINISTIC: the same
 * profile on the same candidates gives the same order, and two profiles differ
 * only through their weight tables. Ties keep input order, which is the
 * deterministic scorer's order — so a profile that is indifferent falls back to
 * exactly what `chooseEntry` would have done.
 */
export function rankForProfile(candidates: readonly RankableCandidate[], profile: TradingProfile): RankedCandidate[] {
  if (candidates.length === 0) return [];
  const specs = featureWeights(profile);
  const ranks = specs.map((s) => percentileRanks(candidates.map(s.value), s.higherIsBetter));
  const scored = candidates.map((c, i) => {
    const terms: RankTerm[] = specs.map((s, si) => {
      const r = ranks[si]![i]!;
      return { feature: s.feature, rank: r, weight: s.weight, contribution: Math.round(r * s.weight * 1000) / 1000 };
    });
    const score = Math.round(terms.reduce((a, t) => a + t.contribution, 0) * 1000) / 1000;
    const top = [...terms].sort((a, b) => b.contribution - a.contribution).slice(0, 2);
    const reasoning =
      `${c.symbol} ranks on ${top.map((t) => `${t.feature} (${(t.rank * 100).toFixed(0)}th pct × ${t.weight})`).join(" and ")}`;
    return { key: c.key, symbol: c.symbol, score, terms, reasoning, index: i };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(({ index: _i, ...rest }) => rest);
}
