/**
 * THE TRENDING BRAIN, PER AGENT — from a shared snapshot to one BrainDecision,
 * through the deterministic layer on both sides of the model.
 *
 *   trending snapshot (shared)
 *     → deterministic safety prefilter     scoreLeg with the OWNER'S thresholds
 *     → profile ranking of the survivors   trading-profile.ts, no thresholds
 *     → Brain research, top-N survivors    one /v1/decide per candidate
 *     → BrainDecision                      thesis BEFORE any intent exists
 *     → deterministic entry + policy       buildClassEntry, then checkPolicy
 *     → (simulation, when a caller supplies one)
 *
 * WHAT THE BRAIN IS GIVEN AND WHAT IT IS NOT. It is asked about ONE candidate
 * per request, named by an opaque handle (`c03`) and a sanitised symbol —
 * never an address, never a curve. Its material is three lens strings built
 * from the snapshot's own measurements. It returns an action, a confidence, a
 * size suggestion and prose. Trusted code maps the handle back to the leg,
 * rebuilds the intent from the reserves it already read, and hands that intent
 * to `checkPolicy` exactly as the tick would. The Brain never sees calldata,
 * never names a target, and cannot reach a candidate the prefilter refused
 * because it is never told such a candidate exists.
 *
 * SELECTION-ONLY SIZING, stated as a decision rather than left to happen. The
 * Brain's `suggested_delta_usdg` is recorded as what it WANTED; the size that
 * goes into the intent is the deterministic `spend` the tick would use
 * (`classSpendFor`). Two reasons. The brief says the profile changes selection
 * and not safety, and size is safety. And the Brain's own sizing depends on a
 * portfolio gate whose runtime inputs this harness cannot vouch for; a shadow
 * whose every decision is a gate-forced hold measures nothing. When the shadow
 * tape says the Brain's sizes were sane, letting it size WITHIN `spend` is a
 * one-line change here and nowhere else.
 *
 * SHADOW FIRST. This module executes nothing and imports nothing that can. A
 * caller that wants execution has to take the returned intent to the tick's
 * own `processIntent`, which is a diff a reviewer can see.
 */
import type { PortfolioSnapshot } from "../../packages/core/src/portfolio-snapshot";
import { decide as decideDefault, type BrainConfig, type BrainDecision, type BrainResult, type DecideArgs } from "./brain-client";
import { scoutFlagsFor } from "./class-side";
import {
  checkPolicy,
  type AgentLimits,
  type AgentState,
  type ScoutContext,
  type TradeIntent,
  type Verdict as PolicyVerdict,
} from "./policy";
import { profileSentence, rankForProfile, type RankableCandidate, type RankedCandidate, type TradingProfile } from "./trading-profile";
import type { TrendingCandidate, TrendingSnapshot } from "./trending-snapshot";
import { chooseEntry, scoreLeg, type RefusalKind, type StyleThresholds } from "./venues/candidate-score";
import { buildClassEntry, classSpendFor, type ClassEntryResult } from "./venues/class-entry";
import { ACTIVITY_GATE } from "./venues/pons-activity";
import { curveBuyOut, curveSellOut, realQuoteRaw } from "./venues/pons-price";
import type { VenueLeg, VenueQuote } from "./venues/venue";

/** The owner's numbers the class route already enforces. Nothing new. */
export interface ClassRouteConfig {
  classMinDepthUsdg: number;
  maxImpactBps: number;
  slippageBps: number;
  classExitAtGraduationPct: number;
  classPerEntryUsdg: number;
  scoutEnabled: boolean;
  scoutBudgetUsdg: number;
  scoutPerTokenUsdg: number;
}

export interface TrendingAgent {
  agentId: string;
  name: string;
  profile: TradingProfile;
  vault: `0x${string}`;
  cfg: ClassRouteConfig;
  /** What `checkPolicy` judges against — the grant's limits as the tick holds them. */
  limits: AgentLimits;
  state: AgentState;
  /** USDG (6dp) already sunk into class positions — the scout budget's `quarantinedUsdg`. */
  heldClassCostUsdg: bigint;
  /** The canonical portfolio the Brain reasons over. */
  portfolio: PortfolioSnapshot;
  /** The agent's own published theses, if any. Fenced by the service. */
  memory: string[];
}

/** The graduation margin the tick applies between entry ceiling and exit. */
const ENTRY_MARGIN_BPS = 1_000;

export interface PrefilteredLeg {
  candidate: TrendingCandidate;
  leg: VenueLeg;
  entry: VenueQuote | null;
  ok: boolean;
  refusal: { kind: RefusalKind; reason: string } | null;
  /** The deterministic scorer's own ordering figure. */
  score: number;
}

/**
 * THE ONE OBJECT that drives the Telegram line, the social post, the intent
 * and the reflection. Written before any intent exists; never rewritten after.
 */
export interface TrendingBrainDecision {
  action: "buy" | "hold";
  /** The handle the Brain answered about. Null for a hold with no candidate. */
  candidateId: string | null;
  /** Resolved by trusted code from the handle. Never from the Brain's text. */
  token: `0x${string}` | null;
  symbol: string | null;
  confidence: number;
  /** The deterministic entry size, whole USDG. Zero for a hold. */
  sizeUsdg: number;
  /** What the Brain asked for, whole USDG. Recorded, not obeyed. */
  brainSuggestedUsdg: number | null;
  thesis: string;
  catalysts: string[];
  risks: string[];
  invalidation: string[];
  /** The service's own id for the winning run, so a fill can find its reasoning. */
  decisionId: string | null;
  /** Why a hold was a hold, in one sentence. */
  holdWhy: string | null;
}

export interface ResearchedCandidate {
  candidateId: string;
  symbol: string;
  profileRank: number;
  /** Everything the Brain was told — kept so the record can be audited for leaks. */
  request: { instrumentId: string; persona: string; signals: Record<string, string>; riskAppetite: string };
  result: BrainResult;
}

export interface AgentShadowRun {
  agentId: string;
  name: string;
  snapshotId: string;
  profile: TradingProfile;
  thresholds: StyleThresholds;
  spendUsdg: number;
  legs: PrefilteredLeg[];
  /** What `chooseEntry` would have bought — the existing path, unchanged. */
  deterministicPick: { candidateId: string; symbol: string; score: number } | null;
  ranked: RankedCandidate[];
  researched: ResearchedCandidate[];
  decision: TrendingBrainDecision;
  entry: ClassEntryResult | null;
  intent: TradeIntent | null;
  policy: PolicyVerdict | null;
  /** True when the Brain landed on the same candidate `chooseEntry` did (or both held). */
  agreesWithDeterministic: boolean;
}

export interface ResearchDeps {
  brain: BrainConfig | null;
  /** Injectable for tests; the real client otherwise. */
  decideFn?: (cfg: BrainConfig, args: DecideArgs) => Promise<BrainResult>;
  /** Marginal gas for the next trade, micro-USDG. Null = could not price it. */
  expectedTradeGasUsdg: number | null;
  runId: string;
  now: () => number;
}

const usdgRaw = (n: number) => BigInt(Math.round(n * 1e6));
const fmtUsdg = (raw: bigint) => `${(Number(raw) / 1e6).toFixed(2)} USDG`;
const pct = (x: number | null, dp = 1) => (x === null ? "unknown" : `${(x * 100).toFixed(dp)}%`);

/** The owner's thresholds, built EXACTLY as proposeClassEntries builds them. */
export function thresholdsFor(cfg: ClassRouteConfig): StyleThresholds {
  return {
    minRealDepthRaw: usdgRaw(cfg.classMinDepthUsdg),
    maxCostBps: cfg.maxImpactBps,
    minAgeSec: 0,
    maxGraduationBps: Math.max(0, cfg.classExitAtGraduationPct * 100 - ENTRY_MARGIN_BPS),
    minRecentTrades: ACTIVITY_GATE.minTrades,
  };
}

/**
 * Step one: the deterministic prefilter, the class route's own scorer on the
 * snapshot's candidates. A candidate whose reserves could not be read has no
 * leg and is refused as unpriceable — never skipped silently.
 */
export function prefilter(snapshot: TrendingSnapshot, cfg: ClassRouteConfig, spend: bigint): PrefilteredLeg[] {
  const t = thresholdsFor(cfg);
  // The tick's activity figure is the 9,000-block (~15 min) tape; the middle
  // window is the same span. A hole in it makes the count UNKNOWN, and the
  // scorer refuses unknown, exactly as the tick refuses a null tape.
  const out: PrefilteredLeg[] = [];
  for (const c of snapshot.candidates) {
    const mid = c.trend.windows[Math.min(1, c.trend.windows.length - 1)]!;
    const leg: VenueLeg = {
      venue: "pons",
      token: c.token,
      symbol: c.symbol,
      decimals: c.decimals,
      route: c.curve,
      quoteToken: c.quoteToken,
      realDepthRaw: c.reserves ? realQuoteRaw(c.reserves) : 0n,
      graduationBps: c.graduationBps,
      ageSec: c.ageSec,
      recentTrades: mid.incomplete ? null : mid.trades,
    };
    let entry: VenueQuote | null = null;
    if (c.reserves) {
      const outRaw = curveBuyOut(c.reserves, spend);
      const back = outRaw === null || outRaw <= 0n ? null : curveSellOut(c.reserves, outRaw);
      const costBps = back === null || spend <= 0n ? null : Math.max(0, Number(((spend - back) * 10_000n) / spend));
      entry = outRaw === null || outRaw <= 0n ? null : { amountOutRaw: outRaw, costBps };
    }
    const v = scoreLeg(leg, t, entry);
    out.push({
      candidate: c,
      leg,
      entry,
      ok: v.ok,
      refusal: v.ok ? null : { kind: v.kind ?? "venue", reason: v.reason ?? "did not qualify" },
      score: v.score,
    });
  }
  return out;
}

// ── the three lenses, rendered from measurements ──────────────────────────

const LENS_MAX = 2_400;

function windowLine(c: TrendingCandidate, i: number, label: string): string {
  const w = c.trend.windows[Math.min(i, c.trend.windows.length - 1)]!;
  const vol = (Number(w.volume) / 1e6).toFixed(2);
  return (
    `${label}: ${w.trades} trades (${w.buys} buys / ${w.sells} sells) by ${w.traders} distinct traders` +
    `${w.newTraders ? `, ${w.newTraders} new to this token` : ""}; ${vol} USDG turned over ` +
    `(${(Number(w.quoteIn) / 1e6).toFixed(2)} in, ${(Number(w.quoteOut) / 1e6).toFixed(2)} out); ` +
    `buy-side share of quote ${w.imbalanceQuote === null ? "unknown" : ((w.imbalanceQuote + 1) / 2 * 100).toFixed(0) + "%"}` +
    `${w.incomplete ? " — PARTIAL, part of this window could not be read" : ""}.`
  );
}

export function renderTrendingLens(c: TrendingCandidate): string {
  const t = c.trend;
  const accel = t.tradeAcceleration === null ? "unknown" : `${t.tradeAcceleration.toFixed(2)}x`;
  const vaccel = t.volumeAcceleration === null ? "unknown" : `${t.volumeAcceleration.toFixed(2)}x`;
  const age = c.ageSec === null ? "of unknown age" : `${Math.floor(c.ageSec / 60)} minutes old`;
  const lines = [
    `${c.symbol} is a Pons launchpad token ${age}, trading on its bonding curve. ` +
      `On-chain tape, measured from every trade event, three windows ending now:`,
    windowLine(c, 0, "Last 5 minutes"),
    windowLine(c, 1, "Last 15 minutes"),
    windowLine(c, 2, "Last hour"),
    // MEASUREMENTS ONLY. The universe's own ranking score is not a fact about
    // the market — the first smoke run showed the model citing "high trending
    // rank (score 99)" as a catalyst, which is our arithmetic reflected back
    // as evidence. The model gets what was measured and draws its own line.
    `Trade-rate acceleration (5m rate over 1h rate): ${accel}. Volume acceleration: ${vaccel}. ` +
      `Net quote flow into the curve over the hour: ${(Number(t.netQuoteFlow) / 1e6).toFixed(2)} USDG.`,
    `Acceleration above 1x means the last five minutes were busier than the hour's average; ` +
      `below 1x means activity is fading. A crowd of one address looping does not count as a crowd.`,
  ];
  return lines.join("\n").slice(0, LENS_MAX);
}

export function renderLiquidityLens(c: TrendingCandidate, spend: bigint, leg: PrefilteredLeg): string {
  if (!c.reserves) return `${c.symbol}: its curve would not report reserves, so depth and impact are unknown.`;
  const cost = leg.entry?.costBps ?? null;
  const lines = [
    `${c.symbol} liquidity, from the curve's own reserves: real depth ${c.depthUsdg === null ? "unknown" : c.depthUsdg.toFixed(2) + " USDG"} ` +
      `(the virtual seed is excluded — it is not money). ` +
      `Progress toward graduation ${c.graduationBps === null ? "unknown" : (c.graduationBps / 100).toFixed(1) + "%"}; ` +
      `a graduated curve can no longer be sold from the vault, and the exit rule fires before that.`,
    `A ${fmtUsdg(spend)} entry would cost ${cost === null ? "an unknown amount" : `${(cost / 100).toFixed(2)}% round trip`} ` +
      `(fee 0.99% each side plus impact). The deterministic prefilter has ALREADY judged this candidate ` +
      `${leg.ok ? "eligible under the owner's limits" : `ineligible: ${leg.refusal?.reason ?? ""}`}.`,
    `Price momentum from implied fills over 15 minutes: ${pct(c.trend.windows[1]?.momentum ?? null, 1)}; over the hour: ${pct(c.trend.windows[2]?.momentum ?? null, 1)}.`,
  ];
  return lines.join("\n").slice(0, LENS_MAX);
}

export function renderTechnicalLens(c: TrendingCandidate, portfolio: PortfolioSnapshot): string {
  const w5 = c.trend.windows[0]!;
  const w15 = c.trend.windows[1] ?? w5;
  const w60 = c.trend.windows[2] ?? w15;
  const held = portfolio.positions.find((p) => p.symbol === c.symbol);
  const position = held
    ? `The book holds ${(held.valueUsdg / 1e6).toFixed(2)} USDG of ${c.symbol}.`
    : `The book holds NONE of ${c.symbol}. This is a candidate to open, not a position to manage.`;
  const lines = [
    `${c.symbol} marked at ${c.priceUsd ?? "unknown"} USD from its bonding curve (a curve quote, not an oracle).`,
    `Implied fill-price change: 5m ${pct(w5.momentum)}, 15m ${pct(w15.momentum)}, 1h ${pct(w60.momentum)}.`,
    `Trades per minute: 5m ${w5.tradesPerMin.toFixed(1)}, 15m ${w15.tradesPerMin.toFixed(1)}, 1h ${w60.tradesPerMin.toFixed(1)}.`,
    position,
    `Uncommitted cash is ${(portfolio.cashUsdg / 1e6).toFixed(2)} USDG; total equity ${(portfolio.equityUsdg / 1e6).toFixed(2)} USDG.`,
  ];
  return lines.join(" ").slice(0, LENS_MAX);
}

// ── the run ────────────────────────────────────────────────────────────────

const ADDRESSY = /0x[0-9a-fA-F]{16,}/;

/** Refuse to SEND anything address-shaped, the mirror of what the client refuses to accept. */
function assertNoAddresses(args: DecideArgs): void {
  const fields = [args.market.instrument_id, args.market.symbol, args.persona ?? "", ...Object.values(args.market.signals), ...(args.memory ?? [])];
  for (const f of fields) {
    if (ADDRESSY.test(f)) throw new Error("refusing to send the Brain an address-shaped string");
  }
}

export async function researchForAgent(
  snapshot: TrendingSnapshot,
  agent: TrendingAgent,
  deps: ResearchDeps,
): Promise<AgentShadowRun> {
  const spend = classSpendFor({ classPerEntryUsdg: agent.cfg.classPerEntryUsdg, perTradeUsdg: agent.limits.perTradeUsdg });
  const thresholds = thresholdsFor(agent.cfg);
  const legs = prefilter(snapshot, agent.cfg, spend);

  // The existing deterministic path, run on the same survivors, so the
  // comparison is against what the tick would actually have done.
  const choice = chooseEntry(legs.map((l) => ({ leg: l.leg, entry: l.entry })), thresholds);
  const deterministicPick = choice.pick
    ? (() => {
        const l = legs.find((x) => x.leg.token === choice.pick!.token)!;
        return { candidateId: l.candidate.id, symbol: l.candidate.symbol, score: choice.score };
      })()
    : null;

  // Profile ranking sees SURVIVORS ONLY.
  const survivors = legs.filter((l) => l.ok);
  const rankable: RankableCandidate[] = survivors.map((l) => ({
    key: l.candidate.id,
    symbol: l.candidate.symbol,
    depthUsdg: l.candidate.depthUsdg ?? 0,
    costBps: l.entry?.costBps ?? Number.MAX_SAFE_INTEGER,
    graduationBps: l.candidate.graduationBps ?? 10_000,
    ageSec: l.candidate.ageSec,
    trend: l.candidate.trend,
  }));
  const ranked = rankForProfile(rankable, agent.profile);
  const toResearch = ranked.slice(0, agent.profile.researchTopN);

  const persona = `You are ${agent.name}, a Merryman. Trading profile: ${profileSentence(agent.profile)}`;
  const researched: ResearchedCandidate[] = [];
  const decideFn = deps.decideFn ?? decideDefault;
  for (const [i, r] of toResearch.entries()) {
    const leg = survivors.find((l) => l.candidate.id === r.key)!;
    const c = leg.candidate;
    const instrumentId = `pons:${c.id}:${c.symbol.toLowerCase()}`;
    const signals = {
      onchain: renderTrendingLens(c),
      liquidity: renderLiquidityLens(c, spend, leg),
      technical: renderTechnicalLens(c, agent.portfolio),
    };
    const args: DecideArgs = {
      runId: `${deps.runId}-${c.id}`,
      agentId: agent.agentId,
      triggerId: `trending:${snapshot.id}`,
      snapshot: agent.portfolio,
      market: {
        snapshot_id: snapshot.id,
        as_of: snapshot.asOf,
        instrument_id: instrumentId,
        symbol: c.symbol,
        instrument_class: "memecoin",
        price_usd: c.priceUsd,
        signals,
        expected_trade_gas_usdg: deps.expectedTradeGasUsdg,
      },
      persona,
      memory: agent.memory,
      riskAppetite: agent.profile.riskAppetite,
      tier: "research",
    };
    assertNoAddresses(args);
    const result: BrainResult = deps.brain
      ? await decideFn(deps.brain, args)
      : { ok: false, kind: "unreachable", detail: "no Brain configured — deterministic dry run" };
    researched.push({
      candidateId: c.id,
      symbol: c.symbol,
      profileRank: i + 1,
      request: { instrumentId, persona, signals, riskAppetite: agent.profile.riskAppetite },
      result,
    });
  }

  const decision = chooseDecision(researched, agent, spend, toResearch, survivors);

  let entry: ClassEntryResult | null = null;
  let intent: TradeIntent | null = null;
  let policy: PolicyVerdict | null = null;
  if (decision.action === "buy" && decision.candidateId) {
    const leg = survivors.find((l) => l.candidate.id === decision.candidateId)!;
    entry = buildClassEntry({
      leg: {
        token: leg.candidate.token,
        symbol: leg.candidate.symbol,
        curve: leg.candidate.curve,
        quoteToken: leg.candidate.quoteToken,
        reserves: leg.candidate.reserves!,
      },
      vault: agent.vault,
      spend,
      rules: {
        maxImpactBps: agent.cfg.maxImpactBps,
        slippageBps: agent.cfg.slippageBps,
        exitAtGraduationPct: agent.cfg.classExitAtGraduationPct,
      },
    });
    if (entry.ok) {
      intent = entry.intent;
      const flags = scoutFlagsFor(intent, {
        vault: agent.limits.ponsClassVault,
        cash: intent.kind === "curve-trade" ? intent.assetIn : ("0x" as `0x${string}`),
        lastUnpriceable: new Set(),
      });
      const scout: ScoutContext = {
        limits: {
          enabled: agent.cfg.scoutEnabled,
          budgetUsdg: usdgRaw(agent.cfg.scoutBudgetUsdg),
          perTokenUsdg: usdgRaw(agent.cfg.scoutPerTokenUsdg),
        },
        buyUnpriceable: flags.buyUnpriceable,
        existingCostUsdg: 0n,
        quarantinedUsdg: agent.heldClassCostUsdg,
      };
      policy = checkPolicy(intent, agent.limits, agent.state, scout);
    }
  }

  const agrees =
    (decision.action === "hold" && deterministicPick === null) ||
    (decision.action === "buy" && deterministicPick !== null && decision.candidateId === deterministicPick.candidateId);

  return {
    agentId: agent.agentId,
    name: agent.name,
    snapshotId: snapshot.id,
    profile: agent.profile,
    thresholds,
    spendUsdg: Number(spend) / 1e6,
    legs,
    deterministicPick,
    ranked,
    researched,
    decision,
    entry,
    intent,
    policy,
    agreesWithDeterministic: agrees,
  };
}

/**
 * From N per-candidate decisions to one. The Brain answered about each
 * candidate separately; the pick is the buy it was most confident in, provided
 * that confidence clears the profile's floor. Ties fall to the higher profile
 * rank — deterministic, and the same reason every time.
 */
export function chooseDecision(
  researched: readonly ResearchedCandidate[],
  agent: TrendingAgent,
  spend: bigint,
  order: readonly RankedCandidate[],
  survivors: readonly PrefilteredLeg[],
): TrendingBrainDecision {
  const hold = (why: string): TrendingBrainDecision => ({
    action: "hold",
    candidateId: null,
    token: null,
    symbol: null,
    confidence: 0,
    sizeUsdg: 0,
    brainSuggestedUsdg: null,
    thesis: "",
    catalysts: [],
    risks: [],
    invalidation: [],
    decisionId: null,
    holdWhy: why,
  });
  if (survivors.length === 0) return hold("no candidate passed the deterministic prefilter");
  if (researched.length === 0) return hold("nothing was researched");

  const answered = researched.filter((r): r is ResearchedCandidate & { result: { ok: true; decision: BrainDecision; seconds: number } } => r.result.ok);
  if (answered.length === 0) {
    const why = researched.map((r) => (r.result.ok ? "" : `${r.symbol}: ${r.result.kind}${"detail" in r.result ? ` (${r.result.detail.slice(0, 120)})` : ""}`)).filter(Boolean);
    return hold(`the Brain gave no usable answer — ${why.join("; ")}`);
  }

  const buys = answered
    .filter((r) => r.result.decision.action === "buy")
    // The Brain must have answered about the candidate it was asked about.
    .filter((r) => r.result.decision.instrument_id === r.request.instrumentId);
  const confident = buys.filter((r) => r.result.decision.confidence >= agent.profile.convictionMin);
  if (confident.length === 0) {
    const best = buys.sort((a, b) => b.result.decision.confidence - a.result.decision.confidence)[0];
    return hold(
      best
        ? `the Brain's best buy was ${best.symbol} at ${best.result.decision.confidence.toFixed(2)} confidence, under the ${agent.profile.convictionMin.toFixed(2)} this profile acts on`
        : `the Brain held on every researched candidate (${answered.map((r) => `${r.symbol}: ${r.result.decision.hold_kind ?? r.result.decision.action}`).join(", ")})`,
    );
  }
  confident.sort(
    (a, b) =>
      b.result.decision.confidence - a.result.decision.confidence ||
      order.findIndex((o) => o.key === a.candidateId) - order.findIndex((o) => o.key === b.candidateId),
  );
  const win = confident[0]!;
  const leg = survivors.find((l) => l.candidate.id === win.candidateId)!;
  const d = win.result.decision;
  return {
    action: "buy",
    candidateId: win.candidateId,
    token: leg.candidate.token,
    symbol: leg.candidate.symbol,
    confidence: d.confidence,
    sizeUsdg: Number(spend) / 1e6,
    brainSuggestedUsdg: Number.isFinite(d.suggested_delta_usdg) ? d.suggested_delta_usdg / 1e6 : null,
    thesis: d.thesis,
    catalysts: d.catalysts ?? [],
    risks: d.risks,
    invalidation: d.invalidation,
    decisionId: d.decision_id,
    holdWhy: null,
  };
}
