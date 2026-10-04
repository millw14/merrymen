/**
 * THE MONITORED COHORT: which 150 traders Merrymen watches closely, and why.
 *
 * Monitoring is the expensive part of this subsystem (stream attention,
 * profile refreshes, research runs), so the cohort decides where attention
 * goes. It does not decide trades. A cohort member's buy is still only a
 * reason to investigate; the selective-following review judges the coin, and
 * the existing executor is the only thing that ever acts.
 *
 * ── WHAT A SCORE IS ALLOWED TO REWARD ─────────────────────────────────────
 *
 * The leaderboard is ranked by dollar P&L, and the obvious cohort ("the top
 * 150 by P&L") is wrong in a specific way: one lucky coin puts a one-trade
 * account at rank 1 of the 24h board, and a dollar figure rewards size, not
 * judgement. So the score is built from things that predict whether WATCHING
 * this person helps Merrymen find and act on opportunities:
 *
 *   consistency        presence across several windows, not one big window
 *   relevant chain     how much of their activity is on the chain we trade
 *   early discovery    coins they bought before broad cohort participation
 *   holding period     whether the opportunity outlives our own latency
 *   exit behaviour     taking gains and cutting losses vs holding bags
 *   concentration      one oversized position is drawdown waiting to happen
 *   execution capacity whether their typical position is big enough for the
 *                      coins they trade to carry our size too
 *   thesis usefulness  whether their written theses held up when we checked
 *   account age        a days-old account is the cheapest lucky streak to buy
 *
 * Dollar P&L enters ONLY as a damped within-window RANK percentile, and its
 * share of the score is capped even when everything else is missing, so it
 * can never be the reason somebody is in.
 *
 * FOLLOWERS AND POPULARITY ARE NOT AN INPUT. A follower count is the one
 * number anyone can inflate for free (follow-store.ts writes the same rule
 * for our own followers), and the moment it moves selection, minting accounts
 * becomes a way to steer what Merrymen watches. `CohortCandidate.followers`
 * exists only so a caller can pass a raw row through; normalisation drops it
 * before anything reads the candidate, and a test proves the output is
 * byte-identical whatever it says.
 *
 * ── UNKNOWN IS NOT BAD, AND IT IS NOT GOOD EITHER ─────────────────────────
 *
 * Most candidates arrive with holes: no profile fetched, no thesis history,
 * no Merrymen measurement yet. A component without data gets NO weight (it is
 * never scored as zero and never filled in), and what was not measured lowers
 * CONFIDENCE instead. Confidence and the trade count together decide how far
 * the raw score is trusted:
 *
 *   score = (n_eff · raw + K · PRIOR) / (n_eff + K),  n_eff = trades × confidence
 *
 * PRIOR sits below the admission floor on purpose. A trader we know nothing
 * about is not penalised for it, but nobody is admitted for being unknown:
 * admission takes evidence.
 *
 * ── WHY THE COHORT CHANGES SLOWLY ─────────────────────────────────────────
 *
 * Every membership change costs something downstream: a stream subscription,
 * a backfill, a broken continuity in "what did this trader do since we
 * started watching". Rank noise would churn the bottom of a naively re-sorted
 * list every refresh. So refresh is gradual and hysteretic: an incumbent goes
 * only for a stated reason (private or restricted, inactive, below a floor
 * that is lower than the admission floor, or beaten by a clear margin after
 * serving a minimum tenure), and only a bounded number of discretionary
 * changes happen per refresh. Privacy is the exception to the bound: a
 * profile that went private leaves at once.
 *
 * NEVER PADDED. When fewer suitable traders exist than seats, the cohort is
 * smaller and says why. A seat is never filled with someone who did not clear
 * the floor, and never with an identity we did not observe.
 *
 * PURE. No clock, no I/O, no environment. Same inputs, same cohort, in any
 * input order. Untrusted handle and name text is sanitised and never appears
 * in a reason; reasons are built only from this module's own vocabulary,
 * numbers and opaque provider ids.
 */

import { sanitizeText } from "../research/news";
import { EVENT_GUARDS } from "./events";
import type { CohortChange, CohortMember, CohortVersion, RankingWindow, TraderIdentity } from "./types";

// ── Constants ─────────────────────────────────────────────────────────────

export const COHORT_TARGET = 150;

export const RANKING_WINDOWS: readonly RankingWindow[] = ["24h", "7d", "30d", "all"];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Design weights. They sum to 1; a component without data drops out and the
 * rest are renormalised, which is why confidence (below) exists.
 */
export const COMPONENT_WEIGHTS = {
  consistency: 0.22,
  earlyDiscovery: 0.14,
  relevantChain: 0.12,
  exitBehaviour: 0.12,
  holdingPeriod: 0.08,
  thesisUsefulness: 0.08,
  pnlRank: 0.08,
  concentration: 0.06,
  executionCapacity: 0.06,
  accountAge: 0.04,
} as const;

export type ScoredComponentKey = keyof typeof COMPONENT_WEIGHTS;

/**
 * The most the P&L rank may contribute to the raw score, as a share of the
 * weight actually in use. Renormalisation would otherwise hand P&L most of
 * the score for a candidate known only from the leaderboard.
 */
export const PNL_RANK_WEIGHT_CAP = 0.08;

/** Where an unproven trader's score sits. Deliberately below the admission floor. */
export const SCORE_PRIOR = 0.4;

/** Pseudo-count, in trades, of the prior. A 1-trade record is mostly prior; 200 trades is mostly evidence. */
export const SHRINK_K = 20;

/** Pseudo-count for per-component rates (early discoveries, theses, exits, chain share). */
const RATE_K = 4;

/**
 * Below this average hold, the trader's position is usually gone before
 * Merrymen has observed the buy, researched it and quoted. Useful for
 * narrative discovery, not for following.
 */
export const MIN_FOLLOWABLE_HOLD_SECONDS = 30 * 60;

/** Damping of the P&L rank percentile: rank 1 maps to 0.75, the last rank to 0.25. */
const PNL_DAMPING = 0.5;

export const COHORT_DEFAULTS = {
  /** Score a newcomer must reach. */
  minScore: 0.45,
  /** An incumbent is held to minScore minus this, so rank noise at the floor does not churn. */
  floorHysteresis: 0.03,
  /** A challenger must beat an incumbent by this much to replace it. */
  replaceMargin: 0.05,
  /** Discretionary changes per refresh (privacy removals and empty-seat fills are not discretionary). */
  maxChangesPerRefresh: 10,
  /** An incumbent cannot be displaced by a challenger before this. */
  minTenureMs: 7 * DAY,
  /** Known inactivity beyond this is a reason to leave. Unknown activity is not. */
  inactiveAfterMs: 14 * DAY,
} as const;

export const POSITION_DEP_CAP_PER_TENANT = 30;
export const POSITION_DEP_CAP_TOTAL = 300;
/** No position dependency is tracked longer than this without being renewed. */
export const POSITION_DEP_MAX_TTL_MS = 14 * DAY;

const { UUIDISH, OPAQUE_ID } = EVENT_GUARDS;

// ── Input types ───────────────────────────────────────────────────────────

export interface CohortWindowStats {
  /** Provider leaderboard rank (1 = top P&L) in this window. */
  rank: number | null;
  pnlUsd: number | null;
  volumeUsd: number | null;
  trades: number | null;
}

export interface CohortCandidateProfile {
  averageHoldTimeSeconds: number | null;
  accountAgeDays: number | null;
  /** Lifetime trade count, when the profile states one. */
  trades: number | null;
  private?: boolean;
  restricted?: boolean;
}

export interface CohortCandidate {
  trader: TraderIdentity;
  windows: Partial<Record<RankingWindow, CohortWindowStats>>;
  profile?: CohortCandidateProfile | null;
  /** Reconstructed from the trader's history: share of activity on Robinhood Chain. */
  chainActivity?: { robinhoodShare: number | null; sampleSize: number | null } | null;
  /** Measured by Merrymen: coins bought before broad cohort participation, out of `sample` coins. */
  earlyDiscoveries?: { count: number; sample: number } | null;
  /** Reconstructed from positions: how closed and open positions ended up. */
  exits?: { closedWithGain: number | null; closedWithLoss: number | null; heldUnderwater: number | null } | null;
  /** Largest position as a share of the trader's book. */
  concentration?: { topPositionShare: number | null } | null;
  /** Median position size in USD (provider float, research only). */
  executionCapacity?: { medianPositionUsd: number | null } | null;
  /** Measured by Merrymen, prospectively: theses that held up when checked. */
  thesisUsefulness?: { useful: number; total: number } | null;
  lastActiveAt: number | null;
  /** IGNORED. Present so raw rows can pass through; dropped before anything reads it. */
  followers?: number | null;
  /** Caller's own 0..1 estimate of how complete this candidate's data is. */
  completeness?: number;
}

export interface CohortScoringOptions {
  /**
   * How many rows each window's leaderboard returned: the denominator of a
   * rank percentile. selectCohort derives it from the candidates when absent;
   * scoreCandidate without it leaves the P&L rank unmeasured.
   */
  windowPopulation?: Partial<Record<RankingWindow, number>>;
  /**
   * Windows actually read this refresh. Absence from a window we did not read
   * is unknown, not absence. Default: all four.
   */
  observedWindows?: readonly RankingWindow[];
  minFollowableHoldSeconds?: number;
}

export interface CohortComponent {
  /** 0..1, or null when not measured. */
  value: number | null;
  /** Share of the raw score this component carried (0 when not measured). */
  weight: number;
  note: string;
}

export interface CandidateScore {
  score: number;
  reasons: string[];
  followable: boolean;
  /** Trades behind the record; null when unknown. */
  sampleSize: number | null;
  components: Record<string, CohortComponent>;
  /** Weighted mean of the measured components before shrinkage; null when nothing was measured. */
  raw: number | null;
  /** Share of the design weight that was measured, times the caller's completeness. */
  confidence: number;
  evidence: CohortMember["evidence"];
}

export interface CohortSelectionOptions extends CohortScoringOptions {
  now: number;
  target?: number;
  minScore?: number;
  floorHysteresis?: number;
  replaceMargin?: number;
  maxChangesPerRefresh?: number;
  minTenureMs?: number;
  inactiveAfterMs?: number;
}

export interface CohortPlanDiagnostics {
  candidatesIn: number;
  unique: number;
  /** Extra rows for a trader already seen (another window, an overlapping page). */
  duplicatesMerged: number;
  invalidIds: number;
  /** Non-members that could have been admitted this refresh. */
  eligibleChallengers: number;
  belowFloor: number;
  privateOrRestricted: number;
  inactive: number;
  /** Incumbents that qualified for removal but stayed because the change budget ran out. */
  deferredRemovals: number;
  discretionaryChanges: number;
}

export interface CohortPlan {
  version: CohortVersion;
  diagnostics: CohortPlanDiagnostics;
}

// ── Small, strict readers ─────────────────────────────────────────────────

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function count(x: unknown): number | null {
  const n = num(x);
  return n !== null && n >= 0 ? Math.floor(n) : null;
}

function nonNegNum(x: unknown): number | null {
  const n = num(x);
  return n !== null && n >= 0 ? n : null;
}

function share(x: unknown): number | null {
  const n = num(x);
  return n !== null && n >= 0 && n <= 1 ? n : null;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A provider user id in its canonical form, or null. UUIDs compare case-insensitively. */
export function canonicalUserId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!OPAQUE_ID.test(s)) return null;
  return UUIDISH.test(s) ? s.toLowerCase() : s;
}

function cleanLabel(raw: unknown, max: number): string | null {
  const s = sanitizeText(raw, max);
  return s ? s : null;
}

function cleanTrader(t: Partial<TraderIdentity> | null | undefined, userId: string): TraderIdentity {
  return {
    userId,
    handle: cleanLabel(t?.handle, 64),
    displayName: cleanLabel(t?.displayName, 80),
    verified: typeof t?.verified === "boolean" ? t.verified : null,
  };
}

function humanDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** Shrink a 0..1 rate measured over n observations toward a neutral 0.5. */
function shrinkRate(value: number, n: number): number {
  return (n * value + RATE_K * 0.5) / (n + RATE_K);
}

// ── Normalisation (followers are dropped here) ────────────────────────────

/** A candidate after validation. No follower field exists on it. */
export interface NormalizedCandidate {
  trader: TraderIdentity;
  windows: Partial<Record<RankingWindow, CohortWindowStats>>;
  profile: CohortCandidateProfile | null;
  chainActivity: { robinhoodShare: number | null; sampleSize: number | null } | null;
  earlyDiscoveries: { count: number; sample: number } | null;
  exits: { closedWithGain: number | null; closedWithLoss: number | null; heldUnderwater: number | null } | null;
  concentration: { topPositionShare: number | null } | null;
  executionCapacity: { medianPositionUsd: number | null } | null;
  thesisUsefulness: { useful: number; total: number } | null;
  lastActiveAt: number | null;
  completeness: number | null;
}

function normWindow(w: CohortWindowStats | undefined): CohortWindowStats | null {
  if (!w || typeof w !== "object") return null;
  const rank = count(w.rank);
  const out: CohortWindowStats = {
    rank: rank !== null && rank >= 1 ? rank : null,
    pnlUsd: num(w.pnlUsd),
    volumeUsd: num(w.volumeUsd),
    trades: count(w.trades),
  };
  return out.rank === null && out.pnlUsd === null && out.volumeUsd === null && out.trades === null ? null : out;
}

function normalize(c: CohortCandidate, userId: string): NormalizedCandidate {
  const windows: Partial<Record<RankingWindow, CohortWindowStats>> = {};
  for (const w of RANKING_WINDOWS) {
    const s = normWindow(c.windows?.[w]);
    if (s) windows[w] = s;
  }
  const p = c.profile && typeof c.profile === "object" ? c.profile : null;
  const profile: CohortCandidateProfile | null = p
    ? {
        averageHoldTimeSeconds: nonNegNum(p.averageHoldTimeSeconds),
        accountAgeDays: nonNegNum(p.accountAgeDays),
        trades: count(p.trades),
        private: p.private === true,
        restricted: p.restricted === true,
      }
    : null;
  const ca = c.chainActivity;
  const ed = c.earlyDiscoveries;
  const ex = c.exits;
  const tu = c.thesisUsefulness;
  const edCount = ed ? count(ed.count) : null;
  const edSample = ed ? count(ed.sample) : null;
  const tuUseful = tu ? count(tu.useful) : null;
  const tuTotal = tu ? count(tu.total) : null;
  return {
    trader: cleanTrader(c.trader, userId),
    windows,
    profile,
    chainActivity: ca ? { robinhoodShare: share(ca.robinhoodShare), sampleSize: count(ca.sampleSize) } : null,
    earlyDiscoveries:
      edCount !== null && edSample !== null && edSample > 0 ? { count: Math.min(edCount, edSample), sample: edSample } : null,
    exits: ex ? { closedWithGain: count(ex.closedWithGain), closedWithLoss: count(ex.closedWithLoss), heldUnderwater: count(ex.heldUnderwater) } : null,
    concentration: c.concentration ? { topPositionShare: share(c.concentration.topPositionShare) } : null,
    executionCapacity: c.executionCapacity ? { medianPositionUsd: nonNegNum(c.executionCapacity.medianPositionUsd) } : null,
    thesisUsefulness:
      tuUseful !== null && tuTotal !== null && tuTotal > 0 ? { useful: Math.min(tuUseful, tuTotal), total: tuTotal } : null,
    lastActiveAt: num(c.lastActiveAt),
    completeness: share(c.completeness),
  };
}

/** Key-sorted JSON, so duplicate rows merge the same way whatever order they arrived in. */
function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x) ?? "null";
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

function firstNonNull<T>(xs: readonly (T | null | undefined)[]): T | null {
  for (const x of xs) if (x !== null && x !== undefined) return x;
  return null;
}

function mergeWindow(entries: CohortWindowStats[]): CohortWindowStats {
  // The best-ranked copy leads; the others only fill what it lacks.
  const sorted = [...entries].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  return {
    rank: firstNonNull(sorted.map((e) => e.rank)),
    pnlUsd: firstNonNull(sorted.map((e) => e.pnlUsd)),
    volumeUsd: firstNonNull(sorted.map((e) => e.volumeUsd)),
    trades: firstNonNull(sorted.map((e) => e.trades)),
  };
}

/**
 * Several rows for one trader (the 24h and 7d boards, an overlapping page, a
 * profile fetched separately) are ONE trader. Windows merge; anything known
 * in one copy fills what another lacks; a private flag anywhere wins.
 */
function mergeGroup(group: NormalizedCandidate[]): NormalizedCandidate {
  if (group.length === 1) return group[0]!;
  const g = [...group].sort((a, b) => cmpStr(canonicalJson(a), canonicalJson(b)));
  const windows: Partial<Record<RankingWindow, CohortWindowStats>> = {};
  for (const w of RANKING_WINDOWS) {
    const entries = g.map((c) => c.windows[w]).filter((x): x is CohortWindowStats => !!x);
    if (entries.length) windows[w] = mergeWindow(entries);
  }
  const profiles = g.map((c) => c.profile).filter((p): p is CohortCandidateProfile => !!p);
  const profile: CohortCandidateProfile | null = profiles.length
    ? {
        averageHoldTimeSeconds: firstNonNull(profiles.map((p) => p.averageHoldTimeSeconds)),
        accountAgeDays: firstNonNull(profiles.map((p) => p.accountAgeDays)),
        trades: firstNonNull(profiles.map((p) => p.trades)),
        private: profiles.some((p) => p.private === true),
        restricted: profiles.some((p) => p.restricted === true),
      }
    : null;
  const verified = g.some((c) => c.trader.verified === true) ? true : g.some((c) => c.trader.verified === false) ? false : null;
  const actives = g.map((c) => c.lastActiveAt).filter((x): x is number => x !== null);
  const completes = g.map((c) => c.completeness).filter((x): x is number => x !== null);
  return {
    trader: {
      userId: g[0]!.trader.userId,
      handle: firstNonNull(g.map((c) => c.trader.handle)),
      displayName: firstNonNull(g.map((c) => c.trader.displayName)),
      verified,
    },
    windows,
    profile,
    chainActivity: firstNonNull(g.map((c) => c.chainActivity)),
    earlyDiscoveries: firstNonNull(g.map((c) => c.earlyDiscoveries)),
    exits: firstNonNull(g.map((c) => c.exits)),
    concentration: firstNonNull(g.map((c) => c.concentration)),
    executionCapacity: firstNonNull(g.map((c) => c.executionCapacity)),
    thesisUsefulness: firstNonNull(g.map((c) => c.thesisUsefulness)),
    lastActiveAt: actives.length ? Math.max(...actives) : null,
    completeness: completes.length ? Math.max(...completes) : null,
  };
}

/**
 * Validate and collapse candidates to one per user id. A row without a
 * usable id is dropped and counted, never given an invented one.
 */
export function dedupeCandidates(candidates: readonly CohortCandidate[]): {
  unique: NormalizedCandidate[];
  duplicatesMerged: number;
  invalidIds: number;
} {
  const groups = new Map<string, NormalizedCandidate[]>();
  let invalidIds = 0;
  for (const c of candidates) {
    const id = c && typeof c === "object" && c.trader ? canonicalUserId(c.trader.userId) : null;
    if (!id) {
      invalidIds++;
      continue;
    }
    const n = normalize(c, id);
    const g = groups.get(id);
    if (g) g.push(n);
    else groups.set(id, [n]);
  }
  let duplicatesMerged = 0;
  const unique: NormalizedCandidate[] = [];
  for (const id of [...groups.keys()].sort(cmpStr)) {
    const g = groups.get(id)!;
    duplicatesMerged += g.length - 1;
    unique.push(mergeGroup(g));
  }
  return { unique, duplicatesMerged, invalidIds };
}

// ── Scoring ───────────────────────────────────────────────────────────────

function windowFacts(c: NormalizedCandidate, observedOpt: readonly RankingWindow[] | undefined) {
  const observed = new Set<RankingWindow>(observedOpt && observedOpt.length ? observedOpt : RANKING_WINDOWS);
  const present: RankingWindow[] = [];
  for (const w of RANKING_WINDOWS) {
    const s = c.windows[w];
    if (!s) continue;
    // A row we hold is a window we observed, whatever the caller listed.
    observed.add(w);
    const onBoard = s.rank !== null || s.pnlUsd !== null;
    const losing = s.pnlUsd !== null && s.pnlUsd < 0;
    if (onBoard && !losing) present.push(w);
  }
  return { observed: RANKING_WINDOWS.filter((w) => observed.has(w)), present };
}

function sampleSizeOf(c: NormalizedCandidate): number | null {
  const xs = [c.profile?.trades ?? null, ...RANKING_WINDOWS.map((w) => c.windows[w]?.trades ?? null)].filter(
    (x): x is number => x !== null,
  );
  return xs.length ? Math.max(...xs) : null;
}

function evidenceOf(c: NormalizedCandidate): CohortMember["evidence"] {
  const providerReported: Record<string, number | null> = {};
  for (const w of RANKING_WINDOWS) {
    const s = c.windows[w];
    if (!s) continue;
    providerReported[`rank.${w}`] = s.rank;
    providerReported[`pnlUsd.${w}`] = s.pnlUsd;
    providerReported[`volumeUsd.${w}`] = s.volumeUsd;
    providerReported[`trades.${w}`] = s.trades;
  }
  if (c.profile) {
    providerReported.averageHoldTimeSeconds = c.profile.averageHoldTimeSeconds;
    providerReported.accountAgeDays = c.profile.accountAgeDays;
    providerReported.trades = c.profile.trades;
  }
  const reconstructed: Record<string, number | null> = {};
  if (c.chainActivity) {
    reconstructed.robinhoodShare = c.chainActivity.robinhoodShare;
    reconstructed.chainSampleSize = c.chainActivity.sampleSize;
  }
  if (c.exits) {
    reconstructed.closedWithGain = c.exits.closedWithGain;
    reconstructed.closedWithLoss = c.exits.closedWithLoss;
    reconstructed.heldUnderwater = c.exits.heldUnderwater;
  }
  if (c.concentration) reconstructed.topPositionShare = c.concentration.topPositionShare;
  if (c.executionCapacity) reconstructed.medianPositionUsd = c.executionCapacity.medianPositionUsd;
  const prospective: Record<string, number | null> = {};
  if (c.earlyDiscoveries) {
    prospective.earlyDiscoveryCount = c.earlyDiscoveries.count;
    prospective.earlyDiscoverySample = c.earlyDiscoveries.sample;
  }
  if (c.thesisUsefulness) {
    prospective.thesisUseful = c.thesisUsefulness.useful;
    prospective.thesisTotal = c.thesisUsefulness.total;
  }
  return { providerReported, reconstructed, prospective };
}

type Measured = { value: number | null; note: string };

function measure(c: NormalizedCandidate, opts: CohortScoringOptions, minHold: number): Record<ScoredComponentKey, Measured> {
  const { observed, present } = windowFacts(c, opts.observedWindows);

  // Consistency needs at least two windows to mean anything.
  const consistency: Measured =
    observed.length >= 2
      ? { value: present.length / observed.length, note: `on the board in ${present.length} of ${observed.length} windows read (${present.join(", ") || "none"})` }
      : { value: null, note: "fewer than two windows read" };

  const pcts: number[] = [];
  for (const w of present) {
    const rank = c.windows[w]?.rank ?? null;
    const pop = count(opts.windowPopulation?.[w]);
    if (rank === null || pop === null || pop < 1) continue;
    const p = clamp01(1 - (rank - 1) / pop);
    pcts.push(0.5 + PNL_DAMPING * (p - 0.5));
  }
  const pnlRank: Measured = pcts.length
    ? { value: pcts.reduce((a, b) => a + b, 0) / pcts.length, note: `damped P&L rank percentile over ${pcts.length} window(s)` }
    : { value: null, note: "no rank with a known board size" };

  const rh = c.chainActivity?.robinhoodShare ?? null;
  const rhN = c.chainActivity?.sampleSize ?? null;
  const relevantChain: Measured =
    rh === null
      ? { value: null, note: "chain mix not measured" }
      : rhN === null
        ? { value: rh, note: `${Math.round(rh * 100)}% of activity on Robinhood Chain (sample size unknown)` }
        : { value: shrinkRate(rh, rhN), note: `${Math.round(rh * 100)}% of ${rhN} on Robinhood Chain` };

  const ed = c.earlyDiscoveries;
  // Half of a trader's coins bought early is already exceptional; that is full marks.
  const earlyDiscovery: Measured = ed
    ? { value: shrinkRate(clamp01(ed.count / ed.sample / 0.5), ed.sample), note: `${ed.count} of ${ed.sample} coins bought before broad participation` }
    : { value: null, note: "early discovery not yet measured" };

  const hold = c.profile?.averageHoldTimeSeconds ?? null;
  const holdingPeriod: Measured =
    hold === null
      ? { value: null, note: "average hold not reported" }
      : hold < minHold
        ? { value: 0.15, note: `average hold ${humanDuration(hold)} is under the ${humanDuration(minHold)} followable minimum` }
        : {
            value: clamp01(0.5 + (0.5 * Math.log(hold / minHold)) / Math.log(Math.max(2, 86_400 / minHold))),
            note: `average hold ${humanDuration(hold)} outlasts our latency`,
          };

  const ex = c.exits;
  const gain = ex?.closedWithGain ?? null;
  const loss = ex?.closedWithLoss ?? null;
  const under = ex?.heldUnderwater ?? null;
  const exitN = (gain ?? 0) + (loss ?? 0) + (under ?? 0);
  // A cut loss is half credit: better than a bag held underwater, worse than a gain.
  const exitBehaviour: Measured =
    ex && exitN > 0
      ? {
          value: shrinkRate(((gain ?? 0) + 0.5 * (loss ?? 0)) / exitN, exitN),
          note: `${gain ?? "?"} closed up, ${loss ?? "?"} cut, ${under ?? "?"} held underwater`,
        }
      : { value: null, note: "exit behaviour not reconstructed" };

  const top = c.concentration?.topPositionShare ?? null;
  const concentration: Measured =
    top === null
      ? { value: null, note: "concentration not measured" }
      : { value: Math.max(0.1, Math.min(1, 1 - ((top - 0.2) / 0.7) * 0.9)), note: `largest position ${Math.round(top * 100)}% of the book` };

  const med = c.executionCapacity?.medianPositionUsd ?? null;
  const executionCapacity: Measured =
    med === null
      ? { value: null, note: "typical position size unknown" }
      : { value: med <= 100 ? 0 : clamp01(Math.log10(med / 100) / 2), note: `median position about $${Math.round(med)}` };

  const tu = c.thesisUsefulness;
  const thesisUsefulness: Measured = tu
    ? { value: shrinkRate(tu.useful / tu.total, tu.total), note: `${tu.useful} of ${tu.total} theses held up when checked` }
    : { value: null, note: "no theses checked yet" };

  const age = c.profile?.accountAgeDays ?? null;
  const accountAge: Measured =
    age === null
      ? { value: null, note: "account age unknown" }
      : { value: Math.max(0.1, Math.min(1, 0.1 + (0.9 * Math.log(1 + age)) / Math.log(181))), note: `account ${Math.round(age)} day(s) old` };

  return {
    consistency,
    earlyDiscovery,
    relevantChain,
    exitBehaviour,
    holdingPeriod,
    thesisUsefulness,
    pnlRank,
    concentration,
    executionCapacity,
    accountAge,
  };
}

function scoreNormalized(c: NormalizedCandidate, opts: CohortScoringOptions): CandidateScore {
  const mh = num(opts.minFollowableHoldSeconds);
  const minHold = mh !== null && mh > 0 ? mh : MIN_FOLLOWABLE_HOLD_SECONDS;
  const m = measure(c, opts, minHold);
  const keys = Object.keys(COMPONENT_WEIGHTS) as ScoredComponentKey[];

  const applied: Record<ScoredComponentKey, number> = {} as Record<ScoredComponentKey, number>;
  let otherW = 0;
  for (const k of keys) {
    applied[k] = m[k].value === null ? 0 : COMPONENT_WEIGHTS[k];
    if (k !== "pnlRank") otherW += applied[k];
  }
  // Cap P&L's share of whatever weight is actually in use. With nothing else
  // measured this is zero: P&L alone is never a score.
  let pnlCapped = false;
  const maxPnl = (otherW * PNL_RANK_WEIGHT_CAP) / (1 - PNL_RANK_WEIGHT_CAP);
  if (applied.pnlRank > maxPnl + 1e-12) {
    applied.pnlRank = maxPnl;
    pnlCapped = true;
  }
  const total = otherW + applied.pnlRank;
  let raw: number | null = null;
  if (total > 0) {
    let acc = 0;
    for (const k of keys) if (applied[k] > 0) acc += applied[k] * (m[k].value as number);
    raw = acc / total;
  }

  const coverage = total; // design weights sum to 1
  const completeness = c.completeness ?? 1;
  const confidence = clamp01(coverage * completeness);
  const sampleSize = sampleSizeOf(c);
  const nEff = (sampleSize ?? 0) * confidence;
  const score = round4(raw === null ? SCORE_PRIOR : (nEff * raw + SHRINK_K * SCORE_PRIOR) / (nEff + SHRINK_K));

  const components: Record<string, CohortComponent> = {};
  for (const k of keys) {
    const v = m[k].value;
    components[k] = { value: v === null ? null : round4(v), weight: total > 0 ? round4(applied[k] / total) : 0, note: m[k].note };
  }
  components.completeness = {
    value: round4(confidence),
    weight: 0,
    note: `${Math.round(coverage * 100)}% of the design weight measured, caller completeness ${Math.round(completeness * 100)}%; acts through shrinkage, not the raw score`,
  };

  const isPrivate = c.profile?.private === true;
  const isRestricted = c.profile?.restricted === true;
  const hold = c.profile?.averageHoldTimeSeconds ?? null;
  const holdOk = hold !== null && hold >= minHold;
  const followable = !isPrivate && !isRestricted && holdOk;

  const reasons: string[] = [];
  if (isPrivate) reasons.push("flag:private-profile private profiles are not monitored");
  if (isRestricted) reasons.push("flag:restricted-profile restricted by the provider; not monitored");
  if (hold === null) reasons.push("flag:hold-unknown average hold not measured; not followable until it is");
  else if (!holdOk) reasons.push(`flag:short-hold average hold ${humanDuration(hold)} under ${humanDuration(minHold)}; narrative discovery only, not followable`);
  if (sampleSize === null) reasons.push("flag:sample-unknown trade count unknown; score held at the prior");
  else if (sampleSize < SHRINK_K) reasons.push(`flag:small-sample ${sampleSize} trade(s); shrunk toward the prior`);
  if (pnlCapped) reasons.push(`flag:pnl-rank-capped P&L rank limited to ${Math.round(PNL_RANK_WEIGHT_CAP * 100)}% of the measured weight`);
  const byWeight = [...keys].sort((a, b) => COMPONENT_WEIGHTS[b] - COMPONENT_WEIGHTS[a] || cmpStr(a, b));
  for (const k of byWeight) {
    const v = m[k].value;
    if (v !== null && v >= 0.65) reasons.push(`strength:${k} ${m[k].note}`);
  }
  for (const k of byWeight) {
    const v = m[k].value;
    if (v !== null && v <= 0.35) reasons.push(`weakness:${k} ${m[k].note}`);
  }
  const unknown = byWeight.filter((k) => m[k].value === null);
  if (unknown.length) reasons.push(`unknown:${unknown.join(",")} not measured; no weight, lower confidence`);
  reasons.push(
    `score:${score.toFixed(4)} raw ${raw === null ? "none" : raw.toFixed(4)}, confidence ${confidence.toFixed(2)}, n ${sampleSize ?? "unknown"}`,
  );

  return { score, reasons, followable, sampleSize, components, raw: raw === null ? null : round4(raw), confidence: round4(confidence), evidence: evidenceOf(c) };
}

/**
 * Score one candidate. Explainable by construction: every component says
 * what it measured, what share of the raw score it carried, and components
 * that were not measured carry none. Followers are not read.
 */
export function scoreCandidate(c: CohortCandidate, opts: CohortScoringOptions = {}): CandidateScore {
  const id = canonicalUserId(c?.trader?.userId) ?? "";
  return scoreNormalized(normalize(c, id), opts);
}

// ── Selection ─────────────────────────────────────────────────────────────

/** Board size per window from the candidates themselves: the deepest rank seen, or the row count. */
function derivePopulation(unique: readonly NormalizedCandidate[]): Partial<Record<RankingWindow, number>> {
  const out: Partial<Record<RankingWindow, number>> = {};
  for (const w of RANKING_WINDOWS) {
    let rows = 0;
    let deepest = 0;
    for (const c of unique) {
      const s = c.windows[w];
      if (!s) continue;
      rows++;
      if (s.rank !== null && s.rank > deepest) deepest = s.rank;
    }
    if (rows > 0) out[w] = Math.max(rows, deepest);
  }
  return out;
}

interface Scored {
  cand: NormalizedCandidate;
  result: CandidateScore;
  privacy: "private" | "restricted" | null;
  /** Known inactivity in ms beyond the limit, or null (active or unknown). */
  inactiveMs: number | null;
}

function nonNegInt(x: unknown, fallback: number): number {
  const n = num(x);
  return n !== null && n >= 0 ? Math.floor(n) : fallback;
}

function nonNeg(x: unknown, fallback: number): number {
  const n = num(x);
  return n !== null && n >= 0 ? n : fallback;
}

function days(ms: number): string {
  return `${Math.round(ms / DAY)}d`;
}

function memberFrom(s: Scored, includedAt: number, prior: TraderIdentity | null): CohortMember {
  const t = s.cand.trader;
  return {
    // A new handle replaces the old one; an unknown one does not erase it.
    trader: {
      userId: t.userId,
      handle: t.handle ?? prior?.handle ?? null,
      displayName: t.displayName ?? prior?.displayName ?? null,
      verified: t.verified ?? prior?.verified ?? null,
    },
    score: s.result.score,
    reasons: s.result.reasons,
    followable: s.result.followable,
    evidence: s.result.evidence,
    sampleSize: s.result.sampleSize,
    includedAt,
  };
}

/** Member order: score descending, user id ascending. */
function memberOrder(a: CohortMember, b: CohortMember): number {
  return b.score - a.score || cmpStr(a.trader.userId, b.trader.userId);
}

const CHANGE_ORDER: Record<CohortChange, number> = { removed: 0, added: 1, retained: 2 };

/**
 * Plan the next cohort version and report how it was reached. `selectCohort`
 * is this without the diagnostics.
 */
export function planCohort(prev: CohortVersion | null, candidates: readonly CohortCandidate[], opts: CohortSelectionOptions): CohortPlan {
  const now = num(opts.now);
  if (now === null) throw new Error("planCohort: opts.now must be a finite number");
  const target = nonNegInt(opts.target, COHORT_TARGET);
  const minScore = nonNeg(opts.minScore, COHORT_DEFAULTS.minScore);
  const retainFloor = minScore - nonNeg(opts.floorHysteresis, COHORT_DEFAULTS.floorHysteresis);
  const replaceMargin = nonNeg(opts.replaceMargin, COHORT_DEFAULTS.replaceMargin);
  const maxChanges = nonNegInt(opts.maxChangesPerRefresh, COHORT_DEFAULTS.maxChangesPerRefresh);
  const minTenureMs = nonNeg(opts.minTenureMs, COHORT_DEFAULTS.minTenureMs);
  const inactiveAfterMs = nonNeg(opts.inactiveAfterMs, COHORT_DEFAULTS.inactiveAfterMs);

  const { unique, duplicatesMerged, invalidIds } = dedupeCandidates(candidates);
  const scoring: CohortScoringOptions = {
    windowPopulation: opts.windowPopulation ?? derivePopulation(unique),
    observedWindows: opts.observedWindows,
    minFollowableHoldSeconds: opts.minFollowableHoldSeconds,
  };

  const scored = new Map<string, Scored>();
  for (const c of unique) {
    const result = scoreNormalized(c, scoring);
    const privacy = c.profile?.private ? "private" : c.profile?.restricted ? "restricted" : null;
    const idle = c.lastActiveAt === null ? null : now - c.lastActiveAt;
    scored.set(c.trader.userId, { cand: c, result, privacy, inactiveMs: idle !== null && idle > inactiveAfterMs ? idle : null });
  }

  const changes: CohortVersion["changes"] = [];
  const members = new Map<string, CohortMember>();
  const retainNote = new Map<string, string[]>();
  const note = (id: string, s: string) => {
    const xs = retainNote.get(id);
    if (xs) xs.push(s);
    else retainNote.set(id, [s]);
  };
  let budget = maxChanges;
  let deferredRemovals = 0;

  // ── 1. Incumbents: refresh what we know, drop what must go now. ─────────
  type Soft = { id: string; kind: "inactive" | "floor"; why: string; inactiveMs: number; score: number };
  const soft: Soft[] = [];
  const seenPrev = new Set<string>();
  const prevMembers = [...(prev?.members ?? [])].sort((a, b) => cmpStr(String(a?.trader?.userId), String(b?.trader?.userId)));
  for (const pm of prevMembers) {
    const id = canonicalUserId(pm?.trader?.userId);
    if (!id) {
      changes.push({ userId: sanitizeText(pm?.trader?.userId, 128), change: "removed", reason: "stored member has no usable user id" });
      continue;
    }
    if (seenPrev.has(id)) continue;
    seenPrev.add(id);
    const includedAt = num(pm.includedAt) ?? now;
    const s = scored.get(id);
    if (!s) {
      // No fresh data is not evidence against them. Carry the last score; a
      // challenger can still displace them by margin after tenure.
      const carried = num(pm.score) ?? SCORE_PRIOR;
      members.set(id, { ...pm, trader: cleanTrader(pm.trader, id), score: carried, includedAt });
      note(id, `no fresh data this refresh; carried score ${carried.toFixed(4)}`);
      continue;
    }
    if (s.privacy) {
      // Privacy is a consent matter, not a ranking one: out at once, uncapped.
      changes.push({ userId: id, change: "removed", reason: `profile is ${s.privacy}` });
      continue;
    }
    const m = memberFrom(s, includedAt, cleanTrader(pm.trader, id));
    members.set(id, m);
    if (pm.trader.handle !== null && s.cand.trader.handle !== null && cleanLabel(pm.trader.handle, 64) !== s.cand.trader.handle) {
      note(id, "handle changed; membership and inclusion time kept");
    }
    if (s.inactiveMs !== null) {
      soft.push({ id, kind: "inactive", why: `inactive for ${days(s.inactiveMs)} (limit ${days(inactiveAfterMs)})`, inactiveMs: s.inactiveMs, score: m.score });
    } else if (m.score < retainFloor) {
      soft.push({ id, kind: "floor", why: `score ${m.score.toFixed(4)} below the retention floor ${retainFloor.toFixed(4)}`, inactiveMs: 0, score: m.score });
    }
  }

  // ── 2. Discretionary removals, worst first, within the change budget. ────
  soft.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "inactive" ? -1 : 1) ||
      b.inactiveMs - a.inactiveMs ||
      a.score - b.score ||
      cmpStr(a.id, b.id),
  );
  const deferred = new Set<string>();
  for (const r of soft) {
    if (budget > 0) {
      budget--;
      members.delete(r.id);
      changes.push({ userId: r.id, change: "removed", reason: r.why });
    } else {
      deferred.add(r.id);
      deferredRemovals++;
      note(r.id, `removal deferred, change budget used: ${r.why}`);
    }
  }

  // ── 3. A lowered target trims the weakest (a configuration change, uncapped). ─
  if (members.size > target) {
    const weakest = [...members.values()].sort(memberOrder).slice(target);
    for (const m of weakest) {
      members.delete(m.trader.userId);
      changes.push({ userId: m.trader.userId, change: "removed", reason: `target reduced to ${target}` });
    }
  }

  // ── 4. Challengers fill empty seats (no one leaves for these, so uncapped). ─
  let belowFloor = 0;
  let privateOrRestricted = 0;
  let inactive = 0;
  const challengers: Scored[] = [];
  for (const s of scored.values()) {
    const id = s.cand.trader.userId;
    if (seenPrev.has(id)) continue;
    if (s.privacy) privateOrRestricted++;
    else if (s.inactiveMs !== null) inactive++;
    else if (s.result.score < minScore) belowFloor++;
    else challengers.push(s);
  }
  challengers.sort((a, b) => b.result.score - a.result.score || cmpStr(a.cand.trader.userId, b.cand.trader.userId));
  const eligibleChallengers = challengers.length;
  let ci = 0;
  while (members.size < target && ci < challengers.length) {
    const s = challengers[ci++]!;
    members.set(s.cand.trader.userId, memberFrom(s, now, null));
    changes.push({ userId: s.cand.trader.userId, change: "added", reason: `filled an open seat: score ${s.result.score.toFixed(4)}` });
  }

  // ── 5. Replacements: a clear margin, after tenure, within the budget. ────
  const displaceable = [...members.values()]
    .filter((m) => seenPrev.has(m.trader.userId) && !deferred.has(m.trader.userId) && now - m.includedAt >= minTenureMs)
    .sort((a, b) => memberOrder(b, a));
  let di = 0;
  while (budget > 0 && ci < challengers.length && di < displaceable.length) {
    const ch = challengers[ci]!;
    const inc = displaceable[di]!;
    // Challengers descend and incumbents ascend, so the first miss ends it.
    if (ch.result.score < inc.score + replaceMargin - 1e-9) break;
    ci++;
    di++;
    budget--;
    const chId = ch.cand.trader.userId;
    const incId = inc.trader.userId;
    members.delete(incId);
    members.set(chId, memberFrom(ch, now, null));
    changes.push({
      userId: incId,
      change: "removed",
      reason: `replaced by ${chId}: score ${inc.score.toFixed(4)} vs ${ch.result.score.toFixed(4)} (margin ${replaceMargin}, tenure ${days(now - inc.includedAt)})`,
    });
    changes.push({ userId: chId, change: "added", reason: `replaced ${incId}: score ${ch.result.score.toFixed(4)} vs ${inc.score.toFixed(4)}` });
  }

  // ── 6. Everyone who stayed says why. ─────────────────────────────────────
  for (const m of members.values()) {
    const id = m.trader.userId;
    if (!seenPrev.has(id)) continue;
    const extra = retainNote.get(id) ?? [];
    const base = scored.has(id) && !deferred.has(id) ? `still suitable: score ${m.score.toFixed(4)}` : null;
    changes.push({ userId: id, change: "retained", reason: [base, ...extra].filter((x): x is string => !!x).join("; ") });
  }
  changes.sort((a, b) => CHANGE_ORDER[a.change] - CHANGE_ORDER[b.change] || cmpStr(a.userId, b.userId) || cmpStr(a.reason, b.reason));

  const list = [...members.values()].sort(memberOrder);
  const shortfallReason =
    list.length < target
      ? `${list.length} of ${target} seats filled; no other candidate was suitable this refresh: ` +
        `${belowFloor} below the score floor ${minScore}, ${privateOrRestricted} private or restricted, ` +
        `${inactive} inactive beyond ${days(inactiveAfterMs)}, ${invalidIds} without a usable user id. Seats stay empty rather than padded.`
      : null;

  return {
    version: {
      version: (num(prev?.version) ?? 0) + 1,
      createdAt: now,
      target,
      members: list,
      shortfallReason,
      changes,
    },
    diagnostics: {
      candidatesIn: candidates.length,
      unique: unique.length,
      duplicatesMerged,
      invalidIds,
      eligibleChallengers,
      belowFloor,
      privateOrRestricted,
      inactive,
      deferredRemovals,
      discretionaryChanges: maxChanges - budget,
    },
  };
}

/**
 * The next cohort version. Deduplicated by user id, gradual (hysteresis,
 * tenure, a per-refresh change budget), never padded, deterministic.
 */
export function selectCohort(prev: CohortVersion | null, candidates: readonly CohortCandidate[], opts: CohortSelectionOptions): CohortVersion {
  return planCohort(prev, candidates, opts).version;
}

// ── Position dependencies ─────────────────────────────────────────────────

/**
 * A tenant holds a position it entered (in part) because of a trader who is
 * NOT in the cohort, and so still needs that trader's exits watched.
 */
export interface PositionDependency {
  tenant: string;
  userId: string;
  tokenKey: string;
  expiresAt: number;
}

export interface TrackedDependency {
  userId: string;
  tenants: string[];
  tokenKeys: string[];
  /** Latest expiry across the dependencies, after the TTL clamp. */
  expiresAt: number;
  dependencies: number;
}

export type DependencyDropReason = "invalid" | "expired" | "duplicate" | "tenant-cap" | "total-cap";

export interface PositionDependencyPlan {
  /** Monitored separately from the cohort and never counted toward its target. */
  tracked: TrackedDependency[];
  /**
   * The surviving dependencies with their expiry CLAMPED. The store must
   * persist these in place of what it passed in: the clamp is relative to
   * `now`, so it only bounds anything if the clamped expiry is what gets
   * re-read next time.
   */
  kept: PositionDependency[];
  /** Already watched as cohort members, so nothing extra is tracked for them. */
  coveredByCohort: PositionDependency[];
  dropped: { dep: PositionDependency; reason: DependencyDropReason }[];
  /** Distinct tracked traders per tenant. */
  perTenant: Record<string, number>;
}

const TENANT_SHAPE = /^[^\u0000-\u001f\u007f]{1,128}$/;

/**
 * Which non-cohort traders get temporary watching because a held position
 * depends on them.
 *
 * WHY THIS IS SEPARATE FROM THE COHORT. A trader can fall out of the cohort
 * (or never have been in it: a dependency can come from a one-off nomination)
 * while a tenant still holds the coin they led us into. Their exit is then
 * position-protection evidence, so it keeps being watched. But it must not
 * quietly turn into a second, unbounded cohort, so it is visible on its own,
 * capped per tenant and in total, and every entry expires and must be renewed
 * by whoever still holds the position.
 */
export function positionDependencies(
  deps: readonly PositionDependency[],
  cohortUserIds: ReadonlySet<string>,
  now: number,
  capPerTenant: number = POSITION_DEP_CAP_PER_TENANT,
  capTotal: number = POSITION_DEP_CAP_TOTAL,
  maxTtlMs: number = POSITION_DEP_MAX_TTL_MS,
): PositionDependencyPlan {
  const perTenantCap = nonNegInt(capPerTenant, POSITION_DEP_CAP_PER_TENANT);
  const totalCap = nonNegInt(capTotal, POSITION_DEP_CAP_TOTAL);
  const horizon = now + nonNeg(maxTtlMs, POSITION_DEP_MAX_TTL_MS);
  const cohort = new Set<string>();
  for (const u of cohortUserIds) {
    const id = canonicalUserId(u);
    if (id) cohort.add(id);
  }

  const dropped: PositionDependencyPlan["dropped"] = [];
  const coveredByCohort: PositionDependency[] = [];
  type Clean = PositionDependency & { original: PositionDependency };
  const valid: Clean[] = [];
  for (const d of deps) {
    const userId = canonicalUserId(d?.userId);
    const tenant = typeof d?.tenant === "string" && TENANT_SHAPE.test(d.tenant) ? d.tenant : null;
    const tokenKey = typeof d?.tokenKey === "string" && d.tokenKey.length > 0 && d.tokenKey.length <= 256 ? d.tokenKey : null;
    const expiresAt = num(d?.expiresAt);
    if (!userId || !tenant || !tokenKey || expiresAt === null) {
      dropped.push({ dep: d, reason: "invalid" });
      continue;
    }
    const bounded = Math.min(expiresAt, horizon);
    if (bounded <= now) {
      dropped.push({ dep: d, reason: "expired" });
      continue;
    }
    if (cohort.has(userId)) {
      coveredByCohort.push(d);
      continue;
    }
    valid.push({ tenant, userId, tokenKey, expiresAt: bounded, original: d });
  }

  // One entry per (tenant, trader, token): the latest expiry wins.
  valid.sort(
    (a, b) => cmpStr(a.tenant, b.tenant) || cmpStr(a.userId, b.userId) || cmpStr(a.tokenKey, b.tokenKey) || b.expiresAt - a.expiresAt,
  );
  const unique: Clean[] = [];
  for (const d of valid) {
    const last = unique[unique.length - 1];
    if (last && last.tenant === d.tenant && last.userId === d.userId && last.tokenKey === d.tokenKey) {
      dropped.push({ dep: d.original, reason: "duplicate" });
      continue;
    }
    unique.push(d);
  }

  // Per tenant: distinct traders, longest-needed first.
  const byTenant = new Map<string, Map<string, Clean[]>>();
  for (const d of unique) {
    let t = byTenant.get(d.tenant);
    if (!t) byTenant.set(d.tenant, (t = new Map()));
    const xs = t.get(d.userId);
    if (xs) xs.push(d);
    else t.set(d.userId, [d]);
  }
  const survivors: Clean[] = [];
  for (const tenant of [...byTenant.keys()].sort(cmpStr)) {
    const traders = [...byTenant.get(tenant)!.entries()].sort(
      (a, b) => Math.max(...b[1].map((d) => d.expiresAt)) - Math.max(...a[1].map((d) => d.expiresAt)) || cmpStr(a[0], b[0]),
    );
    traders.forEach(([, ds], i) => {
      if (i < perTenantCap) survivors.push(...ds);
      else for (const d of ds) dropped.push({ dep: d.original, reason: "tenant-cap" });
    });
  }

  // In total: distinct traders, most-shared first, then longest-needed.
  const byTrader = new Map<string, Clean[]>();
  for (const d of survivors) {
    const xs = byTrader.get(d.userId);
    if (xs) xs.push(d);
    else byTrader.set(d.userId, [d]);
  }
  const ranked = [...byTrader.entries()]
    .map(([userId, ds]) => ({ userId, ds, tenants: new Set(ds.map((d) => d.tenant)).size, expiresAt: Math.max(...ds.map((d) => d.expiresAt)) }))
    .sort((a, b) => b.tenants - a.tenants || b.expiresAt - a.expiresAt || cmpStr(a.userId, b.userId));
  const tracked: TrackedDependency[] = [];
  const kept: PositionDependency[] = [];
  const perTenant: Record<string, number> = {};
  ranked.forEach((r, i) => {
    if (i >= totalCap) {
      for (const d of r.ds) dropped.push({ dep: d.original, reason: "total-cap" });
      return;
    }
    for (const d of r.ds) kept.push({ tenant: d.tenant, userId: d.userId, tokenKey: d.tokenKey, expiresAt: d.expiresAt });
    const tenants = [...new Set(r.ds.map((d) => d.tenant))].sort(cmpStr);
    for (const t of tenants) perTenant[t] = (perTenant[t] ?? 0) + 1;
    tracked.push({
      userId: r.userId,
      tenants,
      tokenKeys: [...new Set(r.ds.map((d) => d.tokenKey))].sort(cmpStr),
      expiresAt: r.expiresAt,
      dependencies: r.ds.length,
    });
  });
  tracked.sort((a, b) => cmpStr(a.userId, b.userId));
  kept.sort((a, b) => cmpStr(a.tenant, b.tenant) || cmpStr(a.userId, b.userId) || cmpStr(a.tokenKey, b.tokenKey));
  return { tracked, kept, coveredByCohort, dropped, perTenant };
}

// ── Diff ──────────────────────────────────────────────────────────────────

const SAFE_HANDLE = /^[A-Za-z0-9_.-]{1,32}$/;

/** `@handle (1a2b3c4d)` when the handle is plain, else just the id prefix. Never free text. */
function label(t: TraderIdentity): string {
  const short = t.userId.slice(0, 8);
  return t.handle && SAFE_HANDLE.test(t.handle) ? `@${t.handle} (${short})` : short;
}

/**
 * Plain summary lines for operators and owners: who came, who went and why,
 * handle and followability changes, and any shortfall. Computed from the two
 * member lists, so it works for any pair of versions.
 */
export function cohortDiff(prev: CohortVersion | null, next: CohortVersion, maxLines = 40): string[] {
  const before = new Map((prev?.members ?? []).map((m) => [m.trader.userId, m]));
  const after = new Map(next.members.map((m) => [m.trader.userId, m]));
  const why = (id: string, change: CohortChange) => next.changes.find((c) => c.userId === id && c.change === change)?.reason ?? "no reason recorded";
  const added = [...after.keys()].filter((id) => !before.has(id)).sort(cmpStr);
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort(cmpStr);
  const kept = [...after.keys()].filter((id) => before.has(id)).sort(cmpStr);

  const head = [
    `cohort v${prev ? prev.version : "-"} -> v${next.version}: ${before.size} -> ${after.size} members (target ${next.target})`,
    `added ${added.length}, removed ${removed.length}, retained ${kept.length}`,
  ];
  const body: string[] = [];
  for (const id of added) body.push(`+ ${label(after.get(id)!.trader)}: ${why(id, "added")}`);
  for (const id of removed) body.push(`- ${label(before.get(id)!.trader)}: ${why(id, "removed")}`);
  for (const id of kept) {
    const a = before.get(id)!;
    const b = after.get(id)!;
    if (a.trader.handle !== b.trader.handle) body.push(`~ ${label(b.trader)}: handle changed, included since ${new Date(b.includedAt).toISOString()}`);
    if (a.followable !== b.followable) body.push(`~ ${label(b.trader)}: ${b.followable ? "now followable" : "no longer followable"}`);
  }
  const tail = next.shortfallReason ? [`shortfall: ${next.shortfallReason}`] : [];
  const room = Math.max(0, maxLines - head.length - tail.length);
  const shown =
    body.length <= room ? body : room === 0 ? [] : [...body.slice(0, room - 1), `... and ${body.length - (room - 1)} more`];
  return [...head, ...shown, ...tail];
}
