/**
 * HELD-POSITION LIFECYCLE — what social data may and may not do to a position
 * Merrymen already holds.
 *
 * SYNCHRONOUS AND CHEAP, ON PURPOSE. Risk reduction must never queue behind a
 * model call or a provider read: `reviewHeldPosition` takes numbers the caller
 * already has and answers in microseconds. It decides nothing either. Its
 * strongest word is `exit-candidate`, which becomes a sooner review in the
 * existing Trencher path; the mechanical exits there (`shouldExit`, run first
 * on every tick) are untouched by anything here and keep running whether or
 * not this module is ever called.
 *
 * THE ORDER IS THE POINT
 *
 *   1. OUR OWN EXIT CONDITION FIRST. A stop, a take-profit or the holding
 *      window met is an exit candidate whatever the cohort is doing. We never
 *      wait for a trader's sell alert to leave: they may never send one, and
 *      they did not size our position.
 *   2. Liquidity judged against the CURRENT size, adds included. A route that
 *      was deep enough for the entry can be too thin for the position.
 *   3. Independent deterioration: several cohort sellers AND flow reversing
 *      AND a strengthened objection. Each alone is a reason to look, not to
 *      leave; a single trader selling is never a mirrored exit — they may be
 *      rebalancing, taking tax losses, or simply wrong.
 *   4. Missing critical data asks for a review, never an exit. Not knowing is
 *      not evidence of anything.
 *
 * THESIS TEXT NEVER APPEARS HERE. Every input is a number, a timestamp or a
 * boolean the caller derived from structured fields; a thesis saying "sell
 * everything now" has no way in.
 */

import type { ClaimSupport, CoinDossier, FollowAssessment } from "./types";
import { sanitizeText } from "../research/news";

/**
 * Defaults mirror TRENCHER_FAST (strategies/trencher.ts) so the research view
 * and the mechanical exits agree on what "our own exit" means. Not imported:
 * nothing under fomo/ reaches a module that builds intents. A test pins the
 * values to the strategy's.
 */
export const LIFECYCLE_DEFAULTS = {
  stopLossBps: 1_000,
  takeProfitBps: 2_000,
  maxHoldMs: 30 * 60_000,
  maxQuoteAgeMs: 60_000,
  /** TRENCHER_DEFAULTS.minLiquidityUsd: below this no position of any size should be in the coin. */
  minRouteDepthUsd: 25_000,
  /** Route depth must be at least this multiple of the position's current value. */
  minDepthMultiple: 1_000,
  /** "Several" cohort sellers. One is a review. */
  minSellersForDeterioration: 2,
  maxFutureSkewMs: 5_000,
} as const;

export type LifecycleConfig = { -readonly [K in keyof typeof LIFECYCLE_DEFAULTS]: number };

export type LifecycleAction = "hold" | "review" | "reduce-candidate" | "exit-candidate";
export type LifecycleUrgency = "none" | "normal" | "soon" | "immediate";

export interface HeldPositionInput {
  now: number;
  /** When our entry filled (ms). */
  entryAt: number | null;
  entryPrice8: bigint | null;
  /** Our own current mark. */
  quote: { price8: bigint; at: number } | null;
  /** The position's current value in USD from our own mark, adds included. Display float. */
  positionValueUsd: number | null;
  /** Our own verified route depth for the exit, USD. */
  routeDepthUsd: number | null;
  /** End of the horizon the entry rationale gave. */
  horizonEndsAt?: number | null;
  setupExpiresAt?: number | null;
  /** Distinct cohort traders whose latest action since our entry is a sell / a buy. */
  cohort: { sellers: number | null; buyers: number | null };
  /** Net flow turned against the position (from structured flow counts). */
  flowReversed: boolean | null;
  /** The dossier's opposition grew since entry (see `objectionStrengthened`). */
  objectionStrengthened: boolean | null;
  config?: Partial<LifecycleConfig>;
}

export interface HeldReview {
  action: LifecycleAction;
  urgency: LifecycleUrgency;
  /** Stable codes. */
  reasons: string[];
}

const SEVERITY: Record<LifecycleAction, number> = { hold: 0, review: 1, "reduce-candidate": 2, "exit-candidate": 3 };
const URGENCY_RANK: Record<LifecycleUrgency, number> = { none: 0, normal: 1, soon: 2, immediate: 3 };

function priceMoveBps(entry8: bigint, now8: bigint): number {
  return Number(((now8 - entry8) * 10_000n) / entry8);
}

export function reviewHeldPosition(i: HeldPositionInput): HeldReview {
  const cfg: LifecycleConfig = { ...LIFECYCLE_DEFAULTS, ...(i.config ?? {}) };
  const now = i.now;
  const findings: HeldReview[] = [];
  const add = (action: LifecycleAction, urgency: LifecycleUrgency, ...reasons: string[]) =>
    findings.push({ action, urgency, reasons });

  // ── 1. our own exit condition, before any social reading ──────────────
  const q = i.quote;
  const quoteValid = !!q && typeof q.price8 === "bigint" && q.price8 > 0n && Number.isFinite(q.at);
  const quoteFresh = quoteValid && now - q!.at <= cfg.maxQuoteAgeMs && q!.at - now <= cfg.maxFutureSkewMs;
  const entryValid = typeof i.entryPrice8 === "bigint" && i.entryPrice8 > 0n;
  const own: string[] = [];
  if (quoteFresh && entryValid) {
    const bps = priceMoveBps(i.entryPrice8!, q!.price8);
    if (bps <= -cfg.stopLossBps) own.push("stop-loss");
    if (bps >= cfg.takeProfitBps) own.push("take-profit");
  }
  if (typeof i.entryAt === "number" && Number.isFinite(i.entryAt) && now - i.entryAt > cfg.maxHoldMs) own.push("max-hold");
  if (own.length > 0) add("exit-candidate", "immediate", "own-exit-condition", ...own);

  // ── 2. liquidity for the CURRENT size ─────────────────────────────────
  const depth = typeof i.routeDepthUsd === "number" && Number.isFinite(i.routeDepthUsd) && i.routeDepthUsd >= 0 ? i.routeDepthUsd : null;
  const size = typeof i.positionValueUsd === "number" && Number.isFinite(i.positionValueUsd) && i.positionValueUsd >= 0 ? i.positionValueUsd : null;
  if (depth !== null) {
    if (depth < cfg.minRouteDepthUsd) add("exit-candidate", "soon", "liquidity-below-floor");
    else if (size !== null && depth < size * cfg.minDepthMultiple) add("reduce-candidate", "soon", "liquidity-below-size-requirement");
  }

  // ── 3. independent deterioration ──────────────────────────────────────
  const sellers = typeof i.cohort?.sellers === "number" && Number.isInteger(i.cohort.sellers) && i.cohort.sellers >= 0 ? i.cohort.sellers : null;
  const several = sellers !== null && sellers >= cfg.minSellersForDeterioration;
  const flow = i.flowReversed === true;
  const objection = i.objectionStrengthened === true;
  if (several && flow && objection) {
    add("exit-candidate", "soon", "independent-deterioration", "cohort-sellers", "flow-reversal", "objection-strengthened");
  } else if (several && (flow || objection)) {
    add("reduce-candidate", "soon", "partial-deterioration", "cohort-sellers", flow ? "flow-reversal" : "objection-strengthened");
  } else if (sellers !== null && sellers >= 1) {
    // One trader selling, or several without anything independent behind
    // them: a reason to look sooner, never a mirrored exit.
    add("review", "normal", sellers === 1 ? "single-trader-sell" : "cohort-sellers-unconfirmed");
  }

  // ── 4. missing critical data: review, not exit ────────────────────────
  if (!quoteValid) add("review", "soon", "missing:price");
  else if (!quoteFresh) add("review", "soon", "price-stale");
  if (!entryValid) add("review", "normal", "missing:entry-price");
  if (!(typeof i.entryAt === "number" && Number.isFinite(i.entryAt))) add("review", "normal", "missing:entry-time");
  if (depth === null) add("review", "normal", "missing:route-depth");
  if (size === null) add("review", "normal", "missing:position-size");
  // Unknown cohort flow is NOT a review on its own: it protects nothing, and
  // treating it as one would re-review every quiet holding every pass.

  // ── 5. the rationale's own clock ──────────────────────────────────────
  if (typeof i.horizonEndsAt === "number" && now >= i.horizonEndsAt) add("review", "normal", "horizon-expired");
  if (typeof i.setupExpiresAt === "number" && now >= i.setupExpiresAt) add("review", "normal", "setup-expired");

  if (findings.length === 0) return { action: "hold", urgency: "none", reasons: ["no-change"] };
  let action: LifecycleAction = "hold";
  let urgency: LifecycleUrgency = "none";
  for (const f of findings) {
    if (SEVERITY[f.action] > SEVERITY[action]) action = f.action;
  }
  const reasons: string[] = [];
  // The deciding findings' reasons first, then everything else seen, once each.
  for (const pass of [true, false]) {
    for (const f of findings) {
      if ((f.action === action) !== pass) continue;
      if (pass && URGENCY_RANK[f.urgency] > URGENCY_RANK[urgency]) urgency = f.urgency;
      for (const r of f.reasons) if (!reasons.includes(r)) reasons.push(r);
    }
  }
  return { action, urgency, reasons };
}

// ─── Dossier strength (structured fields only) ──────────────────────────────

/**
 * How strong a dossier's case is, from STRUCTURED fields only: stance,
 * support class and family counts. Claim summaries are never read, so a
 * thesis worded as an instruction counts exactly like one worded as a
 * thesis — once, as a source statement.
 */
export interface DossierStrength {
  /** Supporting claims backed by an observed action or a verified fact. */
  strongSupport: number;
  /** Most independent families behind any one supporting claim. */
  supportFamilies: number;
  /** Most distinct authors behind that claim. */
  supportAuthors: number;
  strongOpposition: number;
  opposeFamilies: number;
}

const STRONG: ReadonlySet<ClaimSupport> = new Set(["observed-action", "verified-fact"]);
const nonNegInt = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0);

export function dossierStrength(d: CoinDossier | null | undefined): DossierStrength | null {
  if (!d || !Array.isArray(d.claims)) return null;
  const s: DossierStrength = { strongSupport: 0, supportFamilies: 0, supportAuthors: 0, strongOpposition: 0, opposeFamilies: 0 };
  for (const c of d.claims) {
    if (!c) continue;
    const strong = STRONG.has(c.support);
    const families = nonNegInt(c.familyCount);
    if (c.stance === "supporting") {
      if (strong) s.strongSupport++;
      else if (families > s.supportFamilies || (families === s.supportFamilies && nonNegInt(c.authorCount) > s.supportAuthors)) {
        s.supportFamilies = families;
        s.supportAuthors = nonNegInt(c.authorCount);
      }
    } else if (c.stance === "opposing") {
      if (strong) s.strongOpposition++;
      else if (families > s.opposeFamilies) s.opposeFamilies = families;
    }
  }
  return s;
}

/**
 * Did the case for a held coin get stronger since entry? More independent
 * observed/verified support, or two more independent families behind the
 * thesis, AND no growth in opposition. Null when either side is unknown —
 * which an add reads as "no".
 */
export function thesisStrengthened(atEntry: DossierStrength | null | undefined, now: DossierStrength | null | undefined): boolean | null {
  if (!atEntry || !now) return null;
  const stronger = now.strongSupport > atEntry.strongSupport || now.supportFamilies >= atEntry.supportFamilies + 2;
  const noNewOpposition = now.strongOpposition <= atEntry.strongOpposition && now.opposeFamilies <= atEntry.opposeFamilies;
  return stronger && noNewOpposition;
}

/** Did the opposition grow since entry? Null when either side is unknown. */
export function objectionStrengthened(atEntry: DossierStrength | null | undefined, now: DossierStrength | null | undefined): boolean | null {
  if (!atEntry || !now) return null;
  return now.strongOpposition > atEntry.strongOpposition || now.opposeFamilies > atEntry.opposeFamilies;
}

// ─── Rationale, append-only ─────────────────────────────────────────────────

/**
 * WHY A POSITION WAS OPENED, kept as it was written. An add, a reduce or a new
 * dossier revision appends a revision; nothing rewrites the entry. The point
 * is outcome measurement: a rationale edited after the fact would grade the
 * desk on reasons it did not have when it bought.
 */
export interface PositionRationale {
  entryAssessmentId: string;
  dossierRevision: { dossierId: string; revision: number } | null;
  reasons: string[];
  invalidation: string[];
  horizon: string | null;
  /** Micro-USDG allocated to the position at this revision (decimal string). */
  riskAllocation6: string;
  createdAt: number;
  /** The dossier's strength when this was written, for `thesisStrengthened` later. */
  strengthAtEntry?: DossierStrength | null;
}

export interface RationaleRevision extends PositionRationale {
  /** 0 for the entry rationale, then 1, 2, … */
  seq: number;
  /** What prompted it: "entry", "add", "reduce", "dossier-revision", "review". */
  cause: string;
}

export type RationaleHistory = readonly Readonly<RationaleRevision>[];

export type RationaleResult = { ok: true; history: RationaleHistory } | { ok: false; reason: string };

const DECIMAL6 = /^(0|[1-9]\d{0,17})$/;
const CAUSE = /^[a-z][a-z-]{0,31}$/;

function cleanList(xs: unknown, max = 12): string[] {
  if (!Array.isArray(xs)) return [];
  const out: string[] = [];
  for (const x of xs) {
    const s = sanitizeText(x, 120);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function freezeRevision(r: PositionRationale, seq: number, cause: string): Readonly<RationaleRevision> | null {
  if (typeof r.entryAssessmentId !== "string" || !r.entryAssessmentId.trim()) return null;
  if (typeof r.riskAllocation6 !== "string" || !DECIMAL6.test(r.riskAllocation6)) return null;
  if (!Number.isFinite(r.createdAt)) return null;
  if (!CAUSE.test(cause)) return null;
  const dossierRevision = r.dossierRevision
    ? Object.freeze({ dossierId: String(r.dossierRevision.dossierId), revision: Number(r.dossierRevision.revision) })
    : null;
  const strength = r.strengthAtEntry ? Object.freeze({ ...r.strengthAtEntry }) : null;
  return Object.freeze({
    entryAssessmentId: r.entryAssessmentId,
    dossierRevision,
    reasons: Object.freeze(cleanList(r.reasons)) as string[],
    invalidation: Object.freeze(cleanList(r.invalidation)) as string[],
    horizon: r.horizon === null ? null : sanitizeText(r.horizon, 32) || null,
    riskAllocation6: r.riskAllocation6,
    createdAt: r.createdAt,
    strengthAtEntry: strength,
    seq,
    cause,
  });
}

/** Start a history with the entry rationale (seq 0, cause "entry"). */
export function openRationale(entry: PositionRationale): RationaleResult {
  const r = freezeRevision(entry, 0, "entry");
  return r ? { ok: true, history: Object.freeze([r]) } : { ok: false, reason: "invalid-rationale" };
}

/**
 * Append a revision. The input history is never mutated and its entries are
 * never rewritten: the result is a new frozen array that starts with the very
 * same frozen objects. A revision for another position, or one dated before
 * the last, is refused.
 */
export function reviseRationale(history: RationaleHistory, revision: PositionRationale & { cause: string }): RationaleResult {
  const first = history?.[0];
  const last = history?.[history.length - 1];
  if (!first || !last) return { ok: false, reason: "no-entry-rationale" };
  if (revision.entryAssessmentId !== first.entryAssessmentId) return { ok: false, reason: "different-position" };
  if (!(revision.createdAt >= last.createdAt)) return { ok: false, reason: "out-of-order" };
  if (revision.cause === "entry") return { ok: false, reason: "entry-already-recorded" };
  // The entry's own strength stays the baseline for every later comparison.
  const r = freezeRevision({ ...revision, strengthAtEntry: first.strengthAtEntry ?? null }, last.seq + 1, revision.cause);
  if (!r) return { ok: false, reason: "invalid-rationale" };
  return { ok: true, history: Object.freeze([...history, r]) };
}

/** The entry rationale for a filled ENTRY / PROBE / ADD assessment. */
export function rationaleFromAssessment(
  a: FollowAssessment,
  riskAllocation6: bigint,
  createdAt: number,
  strengthAtEntry: DossierStrength | null,
): PositionRationale {
  return {
    entryAssessmentId: a.id,
    dossierRevision: a.dossierRevision ? { ...a.dossierRevision } : null,
    reasons: [...a.reasonCodes],
    invalidation: [...a.invalidation],
    horizon: a.horizon,
    riskAllocation6: (riskAllocation6 > 0n ? riskAllocation6 : 0n).toString(),
    createdAt,
    strengthAtEntry,
  };
}
