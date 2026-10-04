/**
 * SELECTIVE FOLLOWING — what a cohort trader's buy may become, and what it
 * may never become.
 *
 * A trader buying a coin is a reason to investigate, not an instruction to
 * buy. This module turns the investigation into a research STATE and, for
 * the narrow case where Merrymen could act, into a HINT for the path that
 * already exists: a nomination with a priority and a per-entry ceiling for
 * the Trencher review, or a sooner review of a coin already held. It never
 * produces an order, never builds calldata and never sizes from a provider
 * figure. The Brain still decides, `take()` still validates (60 s, 2% band,
 * `maxUsdg`), checkPolicy still bounds the autonomous entry, and the wall
 * still refuses anything over.
 *
 * ── THE STATES, WORST FIRST ──────────────────────────────────────────────
 *
 *   RESEARCH_ONLY    Merrymen cannot or may not act (unsupported chain, no
 *                    verified route, follow off, permission missing, the
 *                    rail refuses). The research is still produced, and the
 *                    state it WOULD have reached is kept as `would-be:<state>`
 *                    so the funnel can tell a permission block from a pass.
 *   REJECT_SETUP     A hard failure: a stale or unusable quote, the price
 *                    ran past the limit since the signal (the opportunity is
 *                    gone, chasing it is buying someone else's exit), the
 *                    setup expired, an observed-action / verified-fact
 *                    objection (a dev dumping), or a route too thin for our
 *                    size.
 *   WATCH            Ordinary uncertainty, entries paused, a size under the
 *                    economic floor, or a condition still awaited (a second
 *                    distinct cohort buyer). WATCH is never bearish: thin
 *                    research and conflicting opinions are not evidence
 *                    against a coin, only the absence of a case for it.
 *   PROBE_CANDIDATE  Early — ONE distinct cohort buyer — with no hard
 *                    failure and a probe size above the floor.
 *   ENTRY_CANDIDATE  Breadth (≥ 2 distinct cohort buyers in the window; one
 *                    trader adding repeatedly is not breadth), a supportive
 *                    dossier without a strong objection, a fresh quote, no
 *                    run-away price, and a ceiling above the floor.
 *   ADD_CANDIDATE    Held AND in profit or with a strengthened case. Never
 *                    because the price fell: that is averaging down.
 *   HOLD_POSITION / REDUCE_CANDIDATE / EXIT_CANDIDATE
 *                    Held positions, from lifecycle.ts.
 *
 * ── TEXT CANNOT MOVE THE STATE ───────────────────────────────────────────
 *
 * Thesis, comment, handle and token-name text is untrusted and is a prompt-
 * injection vector. Nothing here reads it to decide anything: the state is a
 * function of event KINDS and trader ids, dossier claim STANCE / SUPPORT /
 * family counts, our own quote, our own route and our own limits. Labels are
 * sanitised for display and that is all they are. A test feeds an
 * instruction-shaped thesis through every text field and asserts that the
 * assessment does not change.
 */

import { createHash } from "node:crypto";
import type {
  CoinDossier,
  EvidenceRef,
  ExecutionAvailability,
  FollowAssessment,
  ResearchState,
  TokenIdentity,
  TokenLabel,
  TraderEvent,
} from "./types";
import { isRobinhoodToken } from "./identity";
import { sanitizeText } from "../research/news";
import { probeSize, type EntryCeiling } from "./sizing";
import { dossierStrength, type HeldReview } from "./lifecycle";

// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface FollowPermissions {
  /** The owner's `fomoFollowEnabled`. */
  followEnabled: boolean;
  /** Entries paused (the agent, the token, or the breaker). Exits are never paused here. */
  paused: boolean;
  /** Which rail an entry would go through; `refuse` means none may. */
  railMode: "paper" | "live" | "refuse";
  /** Live follow entries are a separate owner consent from paper ones. */
  liveFollowAllowed: boolean;
  /** The owner's signed permission covers this token (vault-verified asset). */
  grantCoversToken: boolean;
}

/** Merrymen's OWN quote, never a provider price. */
export interface FollowQuote {
  price8: bigint;
  at: number;
  source: string;
}

export interface FollowRoute {
  verified: boolean | null;
  depthUsd: number | null;
  quoteAgeMs: number | null;
  impactBps: number | null;
}

export interface FollowHeld {
  held: boolean;
  costBasis6: bigint | null;
  unrealizedPct: number | null;
  entryAssessmentId: string | null;
  /** lifecycle.thesisStrengthened(rationale.strengthAtEntry, dossierStrength(now)). Null = unknown = no. */
  thesisStrengthened?: boolean | null;
  /** reviewHeldPosition(...) for this position, computed on the fast path. */
  review?: HeldReview | null;
}

export interface FollowConfig {
  maxQuoteAgeMs: number;
  /** Price rise since the signal past which the opportunity is gone (percent). */
  maxRunUpPct: number;
  /** Price fall since the signal past which we wait rather than catch it (percent). */
  maxFallSinceSignalPct: number;
  minBreadthForEntry: number;
  /** Cohort buys older than this do not count toward breadth. */
  breadthWindowMs: number;
  /** A setup lives this long after its newest cohort buy. NOMINATE.ttlMs. */
  setupTtlMs: number;
  /** take()'s band: a decision quote this far from the current one is a different decision. */
  priceBandBps: number;
  maxImpactBps: number;
  /** TRENCHER_DEFAULTS.minLiquidityUsd. */
  minRouteDepthUsd: number;
  /** Route depth must be at least this multiple of our intended size. */
  minDepthMultiple: number;
  probesEnabled: boolean;
  probeFractionBps: number;
  probeCap6: bigint;
  /** A dossier claim made of source statements needs this many independent families (and two authors). */
  minIndependentFamilies: number;
  maxDossierAgeMs: number;
  maxFutureSkewMs: number;
  /** TRENCHER_FAST.maxHoldSec, stated as a horizon. */
  horizon: string;
}

export const FOLLOW_DEFAULTS: Readonly<FollowConfig> = Object.freeze({
  maxQuoteAgeMs: 60_000,
  maxRunUpPct: 15,
  maxFallSinceSignalPct: 15,
  minBreadthForEntry: 2,
  breadthWindowMs: 30 * 60_000,
  setupTtlMs: 15 * 60_000,
  priceBandBps: 200,
  maxImpactBps: 300,
  minRouteDepthUsd: 25_000,
  minDepthMultiple: 1_000,
  probesEnabled: true,
  probeFractionBps: 5_000,
  probeCap6: 2_500_000n,
  minIndependentFamilies: 2,
  maxDossierAgeMs: 30 * 60_000,
  maxFutureSkewMs: 5_000,
  horizon: "30m",
});

export interface FollowInput {
  tenant: string;
  token: TokenIdentity;
  label: TokenLabel;
  /** Cohort events that prompted the review (any token; others are ignored). */
  triggers: readonly TraderEvent[];
  dossier: CoinDossier | null;
  now: number;
  quote: FollowQuote | null;
  /** Our own price at the triggering buy, USD. Null = unknown, which is not permission. */
  signalPriceUsd: number | null;
  held: FollowHeld;
  permissions: FollowPermissions;
  availability: ExecutionAvailability;
  route: FollowRoute;
  sizing: EntryCeiling;
  config?: Partial<FollowConfig>;
}

// ─── Cohort flow from structured events ─────────────────────────────────────

interface Flow {
  buyers: number;
  sellers: number;
  repeatAdds: number;
  buyEvents: TraderEvent[];
  sellEvents: TraderEvent[];
  newestBuy: TraderEvent | null;
  newestAny: TraderEvent | null;
}

const eventTime = (e: TraderEvent): number | null => {
  const t = typeof e.sourceEventAt === "number" && Number.isFinite(e.sourceEventAt) ? e.sourceEventAt : e.observedAt;
  return typeof t === "number" && Number.isFinite(t) ? t : null;
};

/**
 * DISTINCT TRADERS, BY THEIR LATEST ACTION IN THE WINDOW. A trader who
 * bought three times is one buyer; one who bought and then sold is a seller.
 * A transfer or an airdrop is never a buy. Ties at the provider's 5 s quantum
 * go to the sell: counting someone as a buyer who may have left is the
 * mistake that costs money.
 */
function cohortFlow(triggers: readonly TraderEvent[], tokenKey: string, now: number, cfg: FollowConfig): Flow {
  const latest = new Map<string, { kind: "buy" | "sell"; at: number; e: TraderEvent }>();
  let buyCount = 0;
  let newestBuy: TraderEvent | null = null;
  let newestAny: TraderEvent | null = null;
  const seen = new Set<string>();
  for (const e of Array.isArray(triggers) ? triggers : []) {
    if (!e || !e.token || e.token.key !== tokenKey) continue;
    if (typeof e.eventKey === "string") {
      if (seen.has(e.eventKey)) continue;
      seen.add(e.eventKey);
    }
    const uid = typeof e.trader?.userId === "string" ? e.trader.userId.trim().toLowerCase() : "";
    if (!uid) continue;
    const at = eventTime(e);
    if (at === null || at - now > cfg.maxFutureSkewMs || now - at > cfg.breadthWindowMs) continue;
    if (!newestAny || at > (eventTime(newestAny) ?? -Infinity)) newestAny = e;
    if (e.kind !== "buy" && e.kind !== "sell") continue;
    if (e.kind === "buy") {
      buyCount++;
      if (!newestBuy || at > (eventTime(newestBuy) ?? -Infinity)) newestBuy = e;
    }
    const prev = latest.get(uid);
    const replaces = !prev || at > prev.at || (at === prev.at && e.kind === "sell" && prev.kind === "buy");
    if (replaces) latest.set(uid, { kind: e.kind, at, e });
  }
  const buyEvents: TraderEvent[] = [];
  const sellEvents: TraderEvent[] = [];
  for (const v of latest.values()) (v.kind === "buy" ? buyEvents : sellEvents).push(v.e);
  const byKey = (a: TraderEvent, b: TraderEvent) => (a.eventKey < b.eventKey ? -1 : a.eventKey > b.eventKey ? 1 : 0);
  buyEvents.sort(byKey);
  sellEvents.sort(byKey);
  return {
    buyers: buyEvents.length,
    sellers: sellEvents.length,
    repeatAdds: Math.max(0, buyCount - buyEvents.length - sellEvents.length),
    buyEvents,
    sellEvents,
    newestBuy,
    newestAny,
  };
}

// ─── Evidence references ────────────────────────────────────────────────────

const REF_KINDS: ReadonlySet<string> = new Set([
  "event", "thesis", "comment", "holdings", "positions", "fills", "profile", "ranking", "board", "token-stats", "dossier", "assessment", "decision",
]);
const MAX_REFS = 24;

function cleanRef(r: unknown): EvidenceRef | null {
  if (!r || typeof r !== "object") return null;
  const x = r as Record<string, unknown>;
  const id = sanitizeText(x.id, 200);
  const kind = typeof x.kind === "string" && REF_KINDS.has(x.kind) ? (x.kind as EvidenceRef["kind"]) : null;
  if (!id || !kind) return null;
  const url = typeof x.sourceUrl === "string" ? sanitizeText(x.sourceUrl, 300) : "";
  return { id, kind, sourceUrl: /^https:\/\/[^\s]+$/.test(url) ? url : null };
}

function pushRefs(out: EvidenceRef[], refs: readonly unknown[] | undefined): void {
  for (const r of refs ?? []) {
    if (out.length >= MAX_REFS) return;
    const c = cleanRef(r);
    if (c && !out.some((o) => o.id === c.id)) out.push(c);
  }
}

const eventRef = (e: TraderEvent): EvidenceRef => ({ id: `fomo:event/${sanitizeText(e.eventKey, 160)}`, kind: "event", sourceUrl: null });

// ─── The assessment ─────────────────────────────────────────────────────────

const ENTRY_STATES: ReadonlySet<ResearchState> = new Set(["ENTRY_CANDIDATE", "PROBE_CANDIDATE", "ADD_CANDIDATE"]);

/**
 * The two states a NEW follow entry may come from (an ADD is a held coin's
 * research state the existing path cannot take; see toExecutionHint). A
 * nomination whose coin's latest assessment is anything else no longer has a
 * setup behind it.
 */
export function isNewEntryState(state: unknown): boolean {
  return state === "ENTRY_CANDIDATE" || state === "PROBE_CANDIDATE";
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

function cleanLabel(l: TokenLabel | null | undefined): TokenLabel {
  return { symbol: sanitizeText(l?.symbol, 32) || null, name: sanitizeText(l?.name, 64) || null };
}

/** Why Merrymen may not act on this at all, independent of how good the setup is. */
function researchOnlyReasons(i: FollowInput): string[] {
  const out: string[] = [];
  if (i.availability !== "supported-authorized") out.push(`execution:${i.availability}`);
  else if (!isRobinhoodToken(i.token)) out.push("execution:identity-not-robinhood");
  if (i.route?.verified !== true) out.push("route-unverified");
  const p = i.permissions;
  if (p?.followEnabled !== true) out.push("follow-disabled");
  if (p?.railMode === "refuse" || (p?.railMode !== "paper" && p?.railMode !== "live")) out.push("rail-refused");
  else if (p.railMode === "live" && p.liveFollowAllowed !== true) out.push("live-follow-not-allowed");
  if (p?.grantCoversToken !== true) out.push("permission-missing");
  return out;
}

function assessmentId(i: FollowInput, triggerKeys: readonly string[]): string {
  const h = createHash("sha256")
    .update(JSON.stringify([i.tenant, i.token.key, [...triggerKeys].sort(), i.now, i.dossier ? [i.dossier.dossierId, i.dossier.revision] : null]))
    .digest("hex");
  return `fa_${h.slice(0, 24)}`;
}

/**
 * THE RESEARCH-STATE MACHINE. Deterministic: the same input gives the same
 * assessment, id included. Every reason is a stable code.
 */
export function assessFollow(input: FollowInput): FollowAssessment {
  const cfg: FollowConfig = { ...FOLLOW_DEFAULTS, ...(input.config ?? {}) };
  const now = input.now;
  const token = input.token;
  const flow = cohortFlow(input.triggers, token.key, now, cfg);
  const dossier = input.dossier && input.dossier.token?.key === token.key ? input.dossier : null;
  const strength = dossierStrength(dossier);
  const sizing = input.sizing;

  // ── timing ─────────────────────────────────────────────────────────────
  const anchor = flow.newestBuy ?? flow.newestAny;
  const anchorAt = anchor ? eventTime(anchor) : null;
  const setupExpiresAt = (anchorAt ?? now) + cfg.setupTtlMs;
  const signalDelayMs =
    anchor && typeof anchor.sourceEventAt === "number" && Number.isFinite(anchor.sourceEventAt)
      ? Math.max(0, anchor.observedAt - anchor.sourceEventAt)
      : null;
  const researchDelayMs = anchor && Number.isFinite(anchor.observedAt) ? Math.max(0, now - anchor.observedAt) : null;

  // ── our own quote ──────────────────────────────────────────────────────
  const q = input.quote;
  const quoteValid = !!q && typeof q.price8 === "bigint" && q.price8 > 0n && Number.isFinite(q.at);
  const quoteFresh = quoteValid && now - q!.at <= cfg.maxQuoteAgeMs && q!.at - now <= cfg.maxFutureSkewMs;
  const priceNow = quoteValid ? Number(q!.price8) / 1e8 : null;
  const signal = typeof input.signalPriceUsd === "number" && Number.isFinite(input.signalPriceUsd) && input.signalPriceUsd > 0 ? input.signalPriceUsd : null;
  const priceMovePct = priceNow !== null && signal !== null ? round4((priceNow / signal - 1) * 100) : null;

  // ── intended size: an entry's ceiling, or a probe's slice of it ────────
  const breadth = flow.buyers;
  const wantsEntry = breadth >= cfg.minBreadthForEntry;
  const probe6 = cfg.probesEnabled ? probeSize(sizing.ceiling6, cfg.probeFractionBps, cfg.probeCap6) : 0n;
  // Held: the route must carry the whole position after an add, not just the add.
  const heldCost6 = input.held?.held === true && typeof input.held.costBasis6 === "bigint" && input.held.costBasis6 > 0n ? input.held.costBasis6 : 0n;
  const intended6 = (wantsEntry || breadth === 0 || input.held?.held === true ? sizing.ceiling6 : probe6) + heldCost6;
  const intendedUsd = Number(intended6 > 0n ? intended6 : 0n) / 1e6;
  const requiredDepthUsd = Math.max(cfg.minRouteDepthUsd, intendedUsd * cfg.minDepthMultiple);

  const reject: string[] = [];
  const watch: string[] = [];
  const notes: string[] = [];

  // ── hard failures ──────────────────────────────────────────────────────
  if (q && !quoteValid) reject.push("quote-invalid");
  else if (quoteValid && !quoteFresh) reject.push("stale-quote");
  if (priceMovePct !== null && priceMovePct > cfg.maxRunUpPct) reject.push("ran-past-limit");
  if (anchor && now >= setupExpiresAt) reject.push("setup-expired");
  if (strength && strength.strongOpposition > 0) reject.push("verified-objection");
  const depth = typeof input.route?.depthUsd === "number" && Number.isFinite(input.route.depthUsd) && input.route.depthUsd >= 0 ? input.route.depthUsd : null;
  const impact = typeof input.route?.impactBps === "number" && Number.isFinite(input.route.impactBps) ? input.route.impactBps : null;
  if ((depth !== null && depth < requiredDepthUsd) || (impact !== null && impact > cfg.maxImpactBps)) reject.push("route-too-thin");

  // ── ordinary uncertainty and awaited conditions ────────────────────────
  if (!q) watch.push("quote-missing");
  if (quoteValid && priceMovePct === null) watch.push("price-move-unknown");
  if (priceMovePct !== null && priceMovePct < -cfg.maxFallSinceSignalPct) watch.push("price-fell-since-signal");
  if (!dossier) watch.push(input.dossier ? "dossier-token-mismatch" : "dossier-missing");
  else if (!(Number.isFinite(dossier.builtAt) && now - dossier.builtAt <= cfg.maxDossierAgeMs)) watch.push("dossier-stale");
  if (strength && strength.opposeFamilies >= 2 && strength.opposeFamilies >= strength.supportFamilies) watch.push("conflicting-opinions");
  else if (strength && strength.opposeFamilies > 0) notes.push("opposition-noted");
  if (dossier && Array.isArray(dossier.wordsVsActions) && dossier.wordsVsActions.length > 0) watch.push("words-vs-actions");
  if (flow.sellers > 0 && flow.sellers >= flow.buyers) watch.push("cohort-flow-mixed");
  if (depth === null) watch.push("route-depth-unknown");
  const routeAge = input.route?.quoteAgeMs;
  if (!(typeof routeAge === "number" && Number.isFinite(routeAge) && routeAge >= 0 && routeAge <= cfg.maxQuoteAgeMs)) watch.push("route-quote-stale");
  if (input.permissions?.paused === true) watch.push("entries-paused");
  if (flow.repeatAdds > 0) notes.push("repeat-adds-not-breadth");

  const supportive = !!strength && (strength.strongSupport > 0 || (strength.supportFamilies >= cfg.minIndependentFamilies && strength.supportAuthors >= 2));
  const entryWatch: string[] = [];
  const probeWatch: string[] = [];
  if (!supportive) entryWatch.push("thin-thesis");
  if (sizing.economic !== "ok" || sizing.ceiling6 <= 0n) {
    entryWatch.push("below-economic-floor");
    notes.push(`sizing:${sanitizeText(sizing.binding, 48)}`);
  }
  if (!cfg.probesEnabled) probeWatch.push("awaiting-second-buyer");
  else if (probe6 <= 0n || probe6 < sizing.floor6) {
    probeWatch.push("below-economic-floor");
    if (sizing.economic === "ok") notes.push("sizing:probe-below-floor");
  }

  // ── the state, before permission ───────────────────────────────────────
  const triggerKeys = [...flow.buyEvents, ...flow.sellEvents].map((e) => e.eventKey);
  let state: ResearchState;
  let codes: string[];
  let size6: bigint | null = null;
  if (input.held?.held === true) {
    ({ state, codes, size6 } = heldState(input, reject, watch, sizing, dossier !== null));
  } else if (reject.length > 0) {
    state = "REJECT_SETUP";
    codes = [...reject, ...watch];
  } else if (breadth === 0) {
    state = "WATCH";
    codes = ["awaiting-cohort-buyer", ...watch];
  } else if (wantsEntry) {
    const w = [...watch, ...entryWatch];
    if (w.length > 0) {
      state = "WATCH";
      codes = w;
    } else {
      state = "ENTRY_CANDIDATE";
      codes = ["breadth-confirmed"];
      size6 = sizing.ceiling6;
    }
  } else {
    const w = [...watch, ...probeWatch];
    if (w.length > 0) {
      state = "WATCH";
      codes = [...w, ...(w.includes("awaiting-second-buyer") ? [] : ["awaiting-second-buyer"])];
    } else {
      state = "PROBE_CANDIDATE";
      codes = ["early-single-buyer"];
      notes.push("awaiting-second-buyer");
      size6 = probe6;
    }
  }

  // ── permission last, so the research above survives it ─────────────────
  const blocked = researchOnlyReasons(input);
  if (blocked.length > 0) {
    codes = [...blocked, `would-be:${state}`, ...codes];
    state = "RESEARCH_ONLY";
    size6 = null;
  }

  const rail = input.permissions?.railMode;
  const railCode = `rail:${rail === "paper" || rail === "live" ? rail : "refuse"}`;
  const reasonCodes = dedupe([...codes, ...notes, `breadth:${breadth}`, railCode]);

  const supporting: EvidenceRef[] = [];
  const opposing: EvidenceRef[] = [];
  for (const e of flow.buyEvents) if (supporting.length < MAX_REFS) supporting.push(eventRef(e));
  for (const e of flow.sellEvents) if (opposing.length < MAX_REFS) opposing.push(eventRef(e));
  if (dossier) {
    for (const c of dossier.claims ?? []) {
      if (c?.stance === "supporting") pushRefs(supporting, c.evidence);
      else if (c?.stance === "opposing") pushRefs(opposing, c.evidence);
    }
    for (const w of dossier.wordsVsActions ?? []) pushRefs(opposing, w?.evidence);
  }

  const candidate = ENTRY_STATES.has(state);
  const invalidation = candidate
    ? [
        `quote-older-than:${cfg.maxQuoteAgeMs}ms`,
        `price-band:${cfg.priceBandBps}bps-from-decision-quote`,
        `setup-expires-at:${setupExpiresAt}`,
        "cohort-sellers-reach-buyers",
        "verified-objection-appears",
        `route-depth-below:${Math.ceil(requiredDepthUsd)}usd`,
        "permission-or-pause-change",
        "sizing-below-floor",
      ]
    : [];

  return {
    id: assessmentId(input, triggerKeys),
    tenant: input.tenant,
    token,
    label: cleanLabel(input.label),
    triggerEventKeys: triggerKeys,
    state,
    reasonCodes,
    supporting,
    opposing,
    signalDelayMs,
    researchDelayMs,
    priceMovePct,
    decisionQuote: quoteValid ? { price8: q!.price8.toString(), at: q!.at, source: sanitizeText(q!.source, 40) || "unknown" } : null,
    setupExpiresAt,
    horizon: candidate ? cfg.horizon : null,
    invalidation,
    sizeCeilingUsdg6: size6 !== null && size6 > 0n ? size6.toString() : null,
    dossierRevision: dossier ? { dossierId: sanitizeText(dossier.dossierId, 120), revision: dossier.revision } : null,
    executionAvailability: input.availability,
    createdAt: now,
  };
}

/** Watch reasons that also block an add (the rest are about a new entry's signal). */
const ADD_BLOCKING_WATCH: ReadonlySet<string> = new Set([
  "quote-missing",
  "dossier-missing",
  "dossier-token-mismatch",
  "dossier-stale",
  "conflicting-opinions",
  "words-vs-actions",
  "cohort-flow-mixed",
  "route-depth-unknown",
  "route-quote-stale",
  "entries-paused",
]);

/**
 * A HELD POSITION: lifecycle first, an add only on strength.
 *
 * The lifecycle verdict (computed synchronously on the fast path and passed
 * in) decides HOLD / REDUCE / EXIT. An ADD is considered only when that
 * verdict is a plain hold, the position is NOT under water, and either it is
 * in profit or the case got stronger. An unknown P&L is not "not under
 * water": it blocks the add.
 */
function heldState(
  i: FollowInput,
  reject: readonly string[],
  watch: readonly string[],
  sizing: EntryCeiling,
  hasDossier: boolean,
): { state: ResearchState; codes: string[]; size6: bigint | null } {
  const review: HeldReview = i.held.review ?? { action: "review", urgency: "normal", reasons: ["held-review-missing"] };
  const life = [`held-review:${review.action}`, `urgency:${review.urgency}`, ...review.reasons.map((r) => `lifecycle:${sanitizeText(r, 48)}`)];
  if (review.action === "exit-candidate") return { state: "EXIT_CANDIDATE", codes: life, size6: null };
  if (review.action === "reduce-candidate") return { state: "REDUCE_CANDIDATE", codes: life, size6: null };
  if (review.action !== "hold") return { state: "HOLD_POSITION", codes: life, size6: null };

  const block: string[] = [];
  const pnl = typeof i.held.unrealizedPct === "number" && Number.isFinite(i.held.unrealizedPct) ? i.held.unrealizedPct : null;
  if (typeof i.held.costBasis6 !== "bigint" || i.held.costBasis6 < 0n) block.push("add-cost-basis-unknown");
  if (pnl === null) block.push("add-pnl-unknown");
  else if (pnl < 0) block.push("no-averaging-down");
  else if (!(pnl > 0 || i.held.thesisStrengthened === true)) block.push("add-not-earned");
  block.push(...reject);
  for (const w of watch) if (ADD_BLOCKING_WATCH.has(w)) block.push(w);
  if (!hasDossier && !block.includes("dossier-missing")) block.push("dossier-missing");
  if (sizing.economic !== "ok" || sizing.ceiling6 <= 0n) block.push("below-economic-floor");
  if (block.length > 0) return { state: "HOLD_POSITION", codes: [...life, ...block], size6: null };
  return {
    state: "ADD_CANDIDATE",
    codes: [...life, pnl! > 0 ? "add-in-profit" : "add-thesis-strengthened"],
    size6: sizing.ceiling6,
  };
}

function dedupe(xs: readonly string[]): string[] {
  const out: string[] = [];
  for (const x of xs) if (!out.includes(x)) out.push(x);
  return out;
}

// ─── Execution hint ─────────────────────────────────────────────────────────

export type ExecutionHint =
  | { kind: "none" }
  | {
      kind: "nominate";
      tokenAddress: `0x${string}`;
      /** Higher first. ENTRY 2, PROBE 1. A RANKING input only: it never makes a coin eligible. */
      priority: number;
      /** The per-entry ceiling to pass to take() as maxUsdg (after min with every existing bound). */
      maxUsdg6: bigint;
      probe: boolean;
      expiresAt: number;
      assessmentId: string;
    }
  | { kind: "review-held"; tokenAddress: `0x${string}`; urgency: "normal" | "soon"; assessmentId: string };

const DECIMAL = /^[1-9]\d{0,17}$/;

/**
 * WHAT THE EXISTING PATH MAY BE TOLD — and only for a Robinhood token
 * Merrymen is authorised on. Everything else is `none`.
 *
 * ADD_CANDIDATE is `none` on purpose: Trencher v1 does not add to an open
 * position (trencher.ts drops a held symbol from the entry loop, and the
 * review refuses a BUY of a held coin), so an add hint would be a buy that is
 * decided and then silently not executed. It stays a research state until the
 * strategy supports adds.
 */
export function toExecutionHint(a: FollowAssessment): ExecutionHint {
  if (!a || a.executionAvailability !== "supported-authorized" || !isRobinhoodToken(a.token)) return { kind: "none" };
  const tokenAddress = a.token.address;
  if (a.state === "ENTRY_CANDIDATE" || a.state === "PROBE_CANDIDATE") {
    if (typeof a.sizeCeilingUsdg6 !== "string" || !DECIMAL.test(a.sizeCeilingUsdg6)) return { kind: "none" };
    if (typeof a.setupExpiresAt !== "number" || !(a.setupExpiresAt > a.createdAt)) return { kind: "none" };
    const maxUsdg6 = BigInt(a.sizeCeilingUsdg6);
    if (maxUsdg6 <= 0n) return { kind: "none" };
    const probe = a.state === "PROBE_CANDIDATE";
    return { kind: "nominate", tokenAddress, priority: probe ? 1 : 2, maxUsdg6, probe, expiresAt: a.setupExpiresAt, assessmentId: a.id };
  }
  if (a.state === "EXIT_CANDIDATE" || a.state === "REDUCE_CANDIDATE") {
    return { kind: "review-held", tokenAddress, urgency: "soon", assessmentId: a.id };
  }
  if (a.state === "HOLD_POSITION" && a.reasonCodes.includes("held-review:review")) {
    const soon = a.reasonCodes.includes("urgency:soon") || a.reasonCodes.includes("urgency:immediate");
    return { kind: "review-held", tokenAddress, urgency: soon ? "soon" : "normal", assessmentId: a.id };
  }
  return { kind: "none" };
}

// ─── Revalidation, right before submission ──────────────────────────────────

export interface RevalidateInput {
  now: number;
  quote: FollowQuote | null;
  permissions: FollowPermissions;
  sizing: EntryCeiling;
  /** Is the gas sponsor answering for this agent right now? Null = unknown. */
  sponsorshipAvailable: boolean | null;
  /** Was this entry planned on a sponsored flow? */
  sponsoredFlow: boolean;
  /**
   * The coin's LATEST assessment, when one newer than `a` exists. The
   * nomination carries the assessment it was made from; research keeps
   * running after it, and a later verdict that is no longer an entry (cohort
   * sellers caught up, a verified objection appeared, the setup turned to
   * WATCH or research-only) is exactly "a change that would have produced a
   * different assessment".
   */
  latest?: FollowAssessment | null;
  config?: Partial<FollowConfig>;
}

export type RevalidateResult = { ok: true; maxUsdg6: bigint } | { ok: false; reason: string };

/**
 * RESEARCH FINISHES LATE; THE WORLD MOVES. Called immediately before the
 * existing path submits an entry that came from an assessment. Any change
 * that would have produced a different assessment fails it with one stable
 * reason, the first found:
 *
 *   setup-deteriorated, setup-expired, follow-disabled, entries-paused,
 *   rail-refused, live-follow-not-allowed, permission-missing,
 *   rail-mode-changed, sponsorship-unavailable, quote-missing, stale-quote,
 *   no-decision-quote, price-moved, size-below-floor
 *
 * THE LATEST ASSESSMENT GOVERNS. A newer assessment of the same coin that is
 * not an entry state fails it as `setup-deteriorated`, whatever the
 * nomination-time assessment said: the invalidation conditions it published
 * ("cohort-sellers-reach-buyers", "verified-objection-appears", …) are
 * checked by the machine that wrote them, on the newer inputs.
 *
 * SPONSORSHIP FAILS CLOSED. An entry planned on a sponsored flow whose
 * sponsor is unavailable (or unknown) is refused, never re-routed onto the
 * owner's own gas: that would charge them for something they did not choose.
 *
 * On success, `maxUsdg6` is the smaller of the assessed ceiling and what the
 * limits allow NOW — sizing can shrink between research and submission, and
 * the smaller number is the one that holds.
 */
export function revalidate(a: FollowAssessment, current: RevalidateInput): RevalidateResult {
  const cfg: FollowConfig = { ...FOLLOW_DEFAULTS, ...(current.config ?? {}) };
  const fail = (reason: string): RevalidateResult => ({ ok: false, reason });
  if (!a || !ENTRY_STATES.has(a.state)) return fail("not-an-entry-candidate");
  const latest = current.latest;
  if (latest && latest !== a && latest.id !== a.id && latest.token?.key === a.token?.key && !isNewEntryState(latest.state)) {
    return fail("setup-deteriorated");
  }
  if (a.executionAvailability !== "supported-authorized" || !isRobinhoodToken(a.token)) return fail("execution-unavailable");
  const now = current.now;
  if (typeof a.setupExpiresAt !== "number" || !Number.isFinite(now) || now >= a.setupExpiresAt) return fail("setup-expired");

  const p = current.permissions;
  if (p?.followEnabled !== true) return fail("follow-disabled");
  if (p.paused === true) return fail("entries-paused");
  if (p.railMode !== "paper" && p.railMode !== "live") return fail("rail-refused");
  if (p.railMode === "live" && p.liveFollowAllowed !== true) return fail("live-follow-not-allowed");
  if (p.grantCoversToken !== true) return fail("permission-missing");
  if (!a.reasonCodes.includes(`rail:${p.railMode}`)) return fail("rail-mode-changed");

  if (current.sponsoredFlow === true && current.sponsorshipAvailable !== true) return fail("sponsorship-unavailable");

  const q = current.quote;
  if (!q || typeof q.price8 !== "bigint" || q.price8 <= 0n || !Number.isFinite(q.at)) return fail("quote-missing");
  if (now - q.at > cfg.maxQuoteAgeMs || q.at - now > cfg.maxFutureSkewMs) return fail("stale-quote");
  const d = a.decisionQuote;
  if (!d || !/^[1-9]\d{0,30}$/.test(d.price8)) return fail("no-decision-quote");
  const before = BigInt(d.price8);
  const diff = q.price8 > before ? q.price8 - before : before - q.price8;
  // bigint, so the band is exact: |now − then| / then > band.
  if (diff * 10_000n > before * BigInt(Math.max(0, Math.floor(cfg.priceBandBps)))) return fail("price-moved");

  const s = current.sizing;
  if (!s || typeof s.ceiling6 !== "bigint" || typeof a.sizeCeilingUsdg6 !== "string" || !DECIMAL.test(a.sizeCeilingUsdg6)) return fail("size-below-floor");
  const assessed = BigInt(a.sizeCeilingUsdg6);
  const probe = a.state === "PROBE_CANDIDATE";
  const allowedNow = probe ? probeSize(s.ceiling6, cfg.probeFractionBps, cfg.probeCap6) : s.economic === "ok" ? s.ceiling6 : 0n;
  const maxUsdg6 = assessed < allowedNow ? assessed : allowedNow;
  if (maxUsdg6 <= 0n || maxUsdg6 < s.floor6) return fail("size-below-floor");
  return { ok: true, maxUsdg6 };
}

// ─── The follow book ────────────────────────────────────────────────────────

/**
 * Caps, all EXTRA caps on top of every existing limit. None can raise what
 * the vault, the wall, the scout budget or the breaker allow.
 */
export const FOLLOW_BOOK = {
  /** A follow nomination with no outcome by now is `expired` (also bounded by the setup's own expiry). */
  ttlMs: 15 * 60_000,
  /** How long past the TTL a claimed, in-flight entry may still wait for its fill. */
  entryInFlightGraceMs: 10 * 60_000,
  /** Unresolved follow nominations held at once. */
  maxOpen: 3,
  /** Follow-sourced entries per agent per UTC day, counted durably (claim before, refund on no fill). */
  entriesPerDay: 3,
  /** The same token is not nominated again this soon after a verdict. */
  tokenCooldownMs: 2 * 3_600_000,
  /**
   * A nomination WITHDRAWN because its coin's newer assessment is no longer an
   * entry is not offered again this soon: a setup flickering between WATCH and
   * ENTRY must not churn the early book's daily offers or its review slots.
   */
  withdrawHoldMs: 10 * 60_000,
  /** A held-review request lapses after this. */
  heldReviewTtlMs: 10 * 60_000,
  heldReviewMax: 20,
} as const;

/**
 * Durable day counter, implemented by the store. A take writes before it
 * returns true; a take that throws is read as a refusal (fail closed).
 */
export interface FollowCounters {
  takeFollowEntry(day: string, limit: number): boolean;
  /** Give back one entry claimed on `day`; a day no longer current should give back nothing. */
  refundFollowEntry(day: string): void;
}

export type FollowOfferResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "duplicate" | "cooldown" | "busy" };

export type FollowOutcome =
  | { kind: "bought"; address: string; assessmentId: string; decisionId: string; paper: boolean }
  | { kind: "passed"; address: string; assessmentId: string; decisionId: string | null }
  | { kind: "skipped"; address: string; assessmentId: string; decisionId: string | null }
  | { kind: "expired"; address: string; assessmentId: string }
  | { kind: "withdrawn"; address: string; assessmentId: string };

export type FollowEntryClaim = "taken" | "cap" | "not-nominated";

interface Pending {
  address: string;
  assessmentId: string;
  priority: number;
  maxUsdg6: bigint;
  probe: boolean;
  queuedAtMs: number;
  /** min(setup expiry, queued + TTL). */
  expiresAtMs: number;
  awaitingFill: boolean;
  entryInFlightAtMs?: number;
}

const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const lower = (a: unknown) => (typeof a === "string" ? a.toLowerCase() : "");
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = "0x" + "0".repeat(40);
const validId = (id: unknown): id is string => typeof id === "string" && id.trim().length > 0;

/**
 * THE FOLLOW NOMINATIONS ONE AGENT IS HOLDING — modelled on NominationBook
 * (trencher-nominate.ts), and for the same reasons.
 *
 * In memory on purpose: a restart forgets every pending nomination, so a
 * crash can drop a follow, never replay it into a second look or a second
 * buy. The day's entry count is the exception and lives behind
 * `FollowCounters`, because a restart must not hand out a fresh day's
 * allowance.
 *
 * Every nomination gets exactly one outcome — a review verdict, a fill, its
 * expiry, a reset or a withdrawal (its setup deteriorated) — and outcomes are
 * keyed by ADDRESS for reviews and by
 * DECISION ID for fills, never by "the latest decision": the rotation may
 * have reviewed another coin in between. Claim before an entry, refund on no
 * fill: a crash in between under-spends by one, never over-spends.
 */
export class FollowBook {
  private queue: Pending[] = [];
  private outbox: FollowOutcome[] = [];
  private verdictAt = new Map<string, number>();
  /** Address → when its nomination was withdrawn (see `withdraw`). */
  private withdrawnAt = new Map<string, number>();
  private buys = new Map<string, Pending>();
  private claims = new Map<string, { day: string; atMs: number }[]>();
  private heldReviews = new Map<string, { urgency: "normal" | "soon"; assessmentId: string; atMs: number }>();

  constructor(
    private readonly counters: FollowCounters,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Take a nominate hint. Everything decidable from the book is decided
   * before anything durable is touched; offering never spends a counter (the
   * day's ENTRY counter is spent only by `claimEntry`). A full book refuses
   * the newcomer rather than dropping an older nomination. A second hint for
   * an open token is a duplicate, never an upgrade of its ceiling.
   */
  offer(h: ExecutionHint): FollowOfferResult {
    if (!h || h.kind !== "nominate") return { ok: false, reason: "invalid" };
    const address = lower(h.tokenAddress);
    if (!ADDRESS.test(address) || address === ZERO_ADDRESS) return { ok: false, reason: "invalid" };
    if (typeof h.maxUsdg6 !== "bigint" || h.maxUsdg6 <= 0n || !validId(h.assessmentId)) return { ok: false, reason: "invalid" };
    if (!Number.isFinite(h.priority) || !Number.isFinite(h.expiresAt)) return { ok: false, reason: "invalid" };
    const t = this.now();
    if (!Number.isFinite(t)) return { ok: false, reason: "invalid" };
    this.sweep(t);
    if (h.expiresAt <= t) return { ok: false, reason: "expired" };
    if (this.find(address)) return { ok: false, reason: "duplicate" };
    const v = this.verdictAt.get(address);
    if (v !== undefined && t - v < FOLLOW_BOOK.tokenCooldownMs) return { ok: false, reason: "cooldown" };
    const w = this.withdrawnAt.get(address);
    if (w !== undefined && t - w < FOLLOW_BOOK.withdrawHoldMs) return { ok: false, reason: "cooldown" };
    if (this.queue.length >= FOLLOW_BOOK.maxOpen) return { ok: false, reason: "busy" };
    this.queue.push({
      address,
      assessmentId: h.assessmentId,
      priority: h.priority,
      maxUsdg6: h.maxUsdg6,
      probe: h.probe === true,
      queuedAtMs: t,
      expiresAtMs: Math.min(h.expiresAt, t + FOLLOW_BOOK.ttlMs),
      awaitingFill: false,
    });
    return { ok: true };
  }

  /**
   * Addresses still waiting for their review, highest priority first, then
   * queue order — for the review rotation's priority hint (trencher-brain.ts
   * `candidate`), merged by the caller with the Telegram book's. A hint moves
   * a coin up the queue; it never puts one on it.
   */
  priority(): ReadonlySet<string> {
    const t = this.now();
    this.sweep(t);
    const waiting = this.queue.filter((p) => this.waiting(p, t));
    const order = waiting.map((p, idx) => ({ p, idx })).sort((a, b) => b.p.priority - a.p.priority || a.idx - b.idx);
    return new Set(order.map((o) => o.p.address));
  }

  /** The open nomination's per-entry ceiling, micro-USDG, or null. */
  ceilingFor(address: string): bigint | null {
    const t = this.now();
    this.sweep(t);
    return this.open(lower(address), t)?.maxUsdg6 ?? null;
  }

  /**
   * The same ceiling as take()'s `maxUsdg` (a USDG number), rounded DOWN to
   * the cent: orderFromDecision floors to cents too, so this cannot be the
   * number that rounds a size up past a limit.
   */
  maxUsdgFor(address: string): number | null {
    const c = this.ceilingFor(address);
    return c === null ? null : Number(c / 10_000n) / 100;
  }

  nominated(address: string): { assessmentId: string; maxUsdg6: bigint; probe: boolean } | null {
    const t = this.now();
    this.sweep(t);
    const p = this.open(lower(address), t);
    return p ? { assessmentId: p.assessmentId, maxUsdg6: p.maxUsdg6, probe: p.probe } : null;
  }

  /**
   * A Brain review of a nominated token. BUY records the decision id and waits
   * for the fill; a later HOLD/SELL cannot overwrite a recorded BUY (a trade
   * may be in flight). A BUY without a decision id can never be taken, so it
   * is `skipped` at once.
   */
  onReviewed(address: string, d: { action: "buy" | "sell" | "hold"; decisionId: string | null }): FollowOutcome | null {
    const t = this.now();
    this.sweep(t);
    const p = this.open(lower(address), t);
    if (!p || !d) return null;
    if (d.action === "buy") {
      if (!validId(d.decisionId)) return p.awaitingFill ? null : this.resolve(p, { kind: "skipped", address: p.address, assessmentId: p.assessmentId, decisionId: null }, t);
      p.awaitingFill = true;
      this.buys.set(d.decisionId, p);
      return null;
    }
    if (p.awaitingFill) return null;
    if (d.action !== "hold" && d.action !== "sell") return null;
    return this.resolve(p, { kind: "passed", address: p.address, assessmentId: p.assessmentId, decisionId: validId(d.decisionId) ? d.decisionId : null }, t);
  }

  /** `landed` and `paper` are fills; `submitted` is not an answer yet; anything else is `skipped`. */
  onFill(decisionId: string, status: string, paper: boolean): FollowOutcome | null {
    const t = this.now();
    this.sweep(t);
    if (!validId(decisionId)) return null;
    const p = this.buys.get(decisionId);
    if (!p || !this.queue.includes(p)) return null;
    if (status === "submitted") return null;
    if (status === "landed" || status === "paper") {
      this.spendClaim(p.address);
      return this.resolve(p, { kind: "bought", address: p.address, assessmentId: p.assessmentId, decisionId, paper: status === "paper" || paper === true }, t);
    }
    return this.resolve(p, { kind: "skipped", address: p.address, assessmentId: p.assessmentId, decisionId }, t);
  }

  /**
   * CLAIM A FOLLOW-SOURCED ENTRY before the entry path starts one. `taken`
   * wrote a durable claim and is the only answer a refund may follow;
   * `not-nominated` took nothing (expired, resolved, never offered).
   */
  claimEntry(address: string): FollowEntryClaim {
    const t = this.now();
    this.sweep(t);
    const a = lower(address);
    const p = this.open(a, t);
    if (!p) return "not-nominated";
    let day = "";
    let ok = false;
    try {
      day = utcDay(t);
      ok = this.counters.takeFollowEntry(day, FOLLOW_BOOK.entriesPerDay) === true;
    } catch {
      ok = false;
    }
    if (!ok) return "cap";
    const list = this.claims.get(a) ?? [];
    list.push({ day, atMs: t });
    this.claims.set(a, list);
    p.entryInFlightAtMs = t;
    return "taken";
  }

  /** The claimed entry produced no fill: its claim goes back to the day it came from. */
  refundEntry(address: string): void {
    const a = lower(address);
    const p = this.find(a);
    if (p) p.entryInFlightAtMs = undefined;
    const c = this.spendClaim(a);
    if (!c) return;
    try {
      this.counters.refundFollowEntry(c.day);
    } catch {
      // A refund that did not write under-spends by one: the safe side.
    }
  }

  expire(): FollowOutcome[] {
    this.sweep(this.now());
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  /**
   * A context change (paper/live flip, new grant, follow turned off): every
   * pending nomination is `expired` now. Caps and outstanding claims survive,
   * so flipping a setting never hands out fresh allowance. A nomination whose
   * claimed entry is in flight waits for that fill.
   */
  reset(): FollowOutcome[] {
    const t = this.now();
    this.sweep(t);
    for (const p of [...this.queue]) {
      if (p.entryInFlightAtMs !== undefined) continue;
      this.outbox.push({ kind: "expired", address: p.address, assessmentId: p.assessmentId });
      this.retire(p);
    }
    this.heldReviews.clear();
    return this.expire();
  }

  /**
   * THE SETUP IS GONE: the coin's newer assessment is no longer an entry. The
   * open nomination is `withdrawn` now rather than at its TTL, so the review
   * rotation stops favouring it and no later BUY can be matched to it. A
   * nomination whose claimed entry is already in flight is left to its fill
   * (`in-flight`), exactly as `reset` leaves it: that entry passed the gate
   * before the setup changed, and its claim and outcome must still resolve.
   */
  withdraw(address: string): "withdrawn" | "in-flight" | "none" {
    const t = this.now();
    this.sweep(t);
    const a = lower(address);
    const p = this.find(a);
    if (!p) return "none";
    if (p.entryInFlightAtMs !== undefined) return "in-flight";
    this.outbox.push({ kind: "withdrawn", address: p.address, assessmentId: p.assessmentId });
    this.retire(p);
    this.withdrawnAt.set(a, t);
    return "withdrawn";
  }

  // ── sooner reviews of held positions ────────────────────────────────────

  /** Ask for a sooner review of a held coin. A `soon` never downgrades to `normal`. */
  requestHeldReview(h: ExecutionHint): boolean {
    if (!h || h.kind !== "review-held") return false;
    const address = lower(h.tokenAddress);
    if (!ADDRESS.test(address) || !validId(h.assessmentId)) return false;
    const t = this.now();
    this.sweep(t);
    const prior = this.heldReviews.get(address);
    if (!prior && this.heldReviews.size >= FOLLOW_BOOK.heldReviewMax) return false;
    const urgency = prior?.urgency === "soon" ? "soon" : h.urgency === "soon" ? "soon" : "normal";
    this.heldReviews.set(address, { urgency, assessmentId: h.assessmentId, atMs: t });
    return true;
  }

  /** Requested held reviews, `soon` first, then oldest first. */
  heldReviewRequests(): { address: string; urgency: "normal" | "soon"; assessmentId: string }[] {
    this.sweep(this.now());
    return [...this.heldReviews.entries()]
      .sort((a, b) => (a[1].urgency === b[1].urgency ? a[1].atMs - b[1].atMs : a[1].urgency === "soon" ? -1 : 1))
      .map(([address, r]) => ({ address, urgency: r.urgency, assessmentId: r.assessmentId }));
  }

  /** The review ran: the request is answered. */
  clearHeldReview(address: string): void {
    this.heldReviews.delete(lower(address));
  }

  // ── internals ───────────────────────────────────────────────────────────

  private find(address: string): Pending | undefined {
    return address ? this.queue.find((p) => p.address === address) : undefined;
  }

  private open(address: string, t: number): Pending | undefined {
    const p = this.find(address);
    return p && t < p.expiresAtMs ? p : undefined;
  }

  private waiting(p: Pending, t: number): boolean {
    return !p.awaitingFill && t < p.expiresAtMs;
  }

  private retire(p: Pending): void {
    this.queue = this.queue.filter((q) => q !== p);
    for (const [id, b] of this.buys) if (b === p) this.buys.delete(id);
  }

  private resolve(p: Pending, o: FollowOutcome, t: number): FollowOutcome {
    this.retire(p);
    if (o.kind !== "expired") this.verdictAt.set(p.address, t);
    return o;
  }

  private spendClaim(address: string): { day: string; atMs: number } | undefined {
    const list = this.claims.get(address);
    const c = list?.pop();
    if (list && list.length === 0) this.claims.delete(address);
    return c;
  }

  private sweep(t: number): void {
    for (const p of [...this.queue]) {
      if (t < p.expiresAtMs) continue;
      if (p.entryInFlightAtMs !== undefined && t < p.expiresAtMs + FOLLOW_BOOK.entryInFlightGraceMs) continue;
      this.outbox.push({ kind: "expired", address: p.address, assessmentId: p.assessmentId });
      this.retire(p);
    }
    for (const [a, at] of this.verdictAt) if (t - at >= FOLLOW_BOOK.tokenCooldownMs) this.verdictAt.delete(a);
    for (const [a, at] of this.withdrawnAt) if (t - at >= FOLLOW_BOOK.withdrawHoldMs) this.withdrawnAt.delete(a);
    for (const [a, list] of this.claims) {
      const kept = list.filter((c) => t - c.atMs < DAY_MS);
      if (kept.length) this.claims.set(a, kept);
      else this.claims.delete(a);
    }
    for (const [a, r] of this.heldReviews) if (t - r.atMs >= FOLLOW_BOOK.heldReviewTtlMs) this.heldReviews.delete(a);
  }
}
