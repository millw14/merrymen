/**
 * THE TRENDING BRAIN, PER AGENT — from a shared snapshot to one BrainDecision,
 * through the deterministic layer on both sides of the model.
 *
 *   trending snapshot (shared, EVERY quote asset)
 *     → deterministic safety prefilter     scoreLeg with the OWNER'S thresholds,
 *                                          depth judged in USD whatever the quote
 *     → profile ranking of the survivors   trading-profile.ts, no thresholds
 *     → Brain research, top-N survivors    one /v1/decide per candidate
 *     → BrainDecision                      thesis BEFORE any intent exists
 *     → executability                      the LIVE route enters from USDG only;
 *                                          a better pick it cannot reach is NAMED
 *     → deterministic entry + policy       buildClassEntry, then checkPolicy
 *     → (simulation, when a caller supplies one)
 *
 * WHAT THE BRAIN IS GIVEN AND WHAT IT IS NOT. It is asked about ONE candidate
 * per request, named by an opaque handle (`c03`) and a sanitised symbol —
 * never an address, never a curve. Its material is three lens strings built
 * from the snapshot's own measurements, in USD wherever the quote can be
 * priced and in the quote asset's own units beside it. It returns an action, a
 * confidence, a size suggestion and prose. Trusted code maps the handle back to
 * the leg, rebuilds the intent from the reserves it already read, and hands
 * that intent to `checkPolicy` exactly as the tick would. The Brain never sees
 * calldata, never names a target, and cannot reach a candidate the prefilter
 * refused because it is never told such a candidate exists.
 *
 * RESEARCH IS WIDER THAN EXECUTION. The owner's ruling of 2026-09-16: research
 * every quote asset in shadow, execute none of the new ones until a
 * deterministic multi-quote route is proven on a canary. So the Brain is asked
 * about an ETH- or NVDA-quoted curve exactly as it is asked about a USDG one
 * and is not told which is which — executability is not a market fact and
 * would only teach it to hold. The DECISION then says two things separately:
 * the best opportunity across everything researched, and the action, which
 * can only be a buy of an executable candidate. When those differ, `holdWhy`
 * names the missed opportunity and the reason the route cannot reach it.
 *
 * SELECTION-ONLY SIZING, stated as a decision rather than left to happen. The
 * Brain's `suggested_delta_usdg` is recorded as what it WANTED; the size that
 * goes into the intent is the deterministic `spend` the tick would use
 * (`classSpendFor`). Two reasons. The brief says the profile changes selection
 * and not safety, and size is safety. And the Brain's own sizing depends on a
 * portfolio gate whose runtime inputs this harness cannot vouch for; a shadow
 * whose every decision is a gate-forced hold measures nothing.
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
import { classifyQuote, depthUsd6, quoteRawToUsd6, spendInQuoteRaw, unpricedWhy } from "./venues/quote-assets";
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
  /** The USD entry size expressed in the curve's quote units. Null when unpriced. */
  spendQuoteRaw: bigint | null;
  ok: boolean;
  refusal: { kind: RefusalKind; reason: string } | null;
  /** The deterministic scorer's own ordering figure. */
  score: number;
  /**
   * May the LIVE route enter this today? False for every non-USDG quote.
   * RE-DERIVED from the curve's quote token by `prefilter`, never read from
   * the candidate record — a replayed file can claim anything.
   */
  executable: boolean;
  /** The reason when `executable` is false, from the same derivation. */
  executableWhy: string | null;
}

/** The best buy the Brain found, whether or not the route can reach it. */
export interface BestOpportunity {
  candidateId: string;
  symbol: string;
  quoteSymbol: string;
  confidence: number;
  executable: boolean;
  /** Null when executable; otherwise the deterministic layer's reason. */
  executableWhy: string | null;
  thesis: string;
  decisionId: string;
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
  quoteSymbol: string | null;
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
  /**
   * The hold's KIND, so a report can tell "the floor was not cleared" from
   * "no buy was ever evaluated" — five of the hold paths never compare a
   * confidence to anything, and printing the floor sentence for them would
   * be a claim about a comparison that did not happen. Null for a buy.
   */
  holdKind: HoldKind | null;
  /**
   * The best buy across EVERYTHING researched, executable or not. When it is
   * not executable this differs from the action above, and `holdWhy` says so.
   */
  bestOpportunity: BestOpportunity | null;
}

export type HoldKind =
  | "no-survivors"
  | "nothing-researched"
  | "no-answer"
  | "mismatched"
  | "all-held"
  | "under-floor"
  | "unexecutable";

export interface ResearchedCandidate {
  candidateId: string;
  symbol: string;
  quoteSymbol: string;
  executable: boolean;
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
  /** What `chooseEntry` would have bought — the existing path, unchanged. Executable legs only. */
  deterministicPick: { candidateId: string; symbol: string; score: number } | null;
  ranked: RankedCandidate[];
  researched: ResearchedCandidate[];
  decision: TrendingBrainDecision;
  entry: ClassEntryResult | null;
  intent: TradeIntent | null;
  policy: PolicyVerdict | null;
  /**
   * True when the Brain landed on the same candidate `chooseEntry` did (or
   * both held). NULL when no executable candidate existed this pass — then
   * the deterministic path never ran and there is nothing to agree with; a
   * report renders that as "n/a", never as a yes.
   */
  agreesWithDeterministic: boolean | null;
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
const fmtUsd = (raw6: bigint) => `${(Number(raw6) / 1e6).toFixed(2)} USD`;
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
 * snapshot's candidates — with depth judged in USD so a curve quoted in NVDA
 * meets the same floor a USDG curve does. A candidate whose quote cannot be
 * priced is refused as unpriceable: a depth nobody can value is not a small
 * depth, and it is never a pass. A candidate whose reserves could not be read
 * has no leg and is refused the same way — never skipped silently.
 *
 * `spendUsd6` is the owner's entry size in USD at 6dp (USDG raw); it is
 * converted into the curve's quote units to measure impact and round trip,
 * which are ratios and therefore quote-agnostic once the spend is in the
 * right units.
 */
export function prefilter(snapshot: TrendingSnapshot, cfg: ClassRouteConfig, spendUsd6: bigint): PrefilteredLeg[] {
  const t = thresholdsFor(cfg);
  // The tick's activity figure is the 9,000-block (~15 min) tape; the middle
  // window is the same span. A hole in it makes the count UNKNOWN, and the
  // scorer refuses unknown, exactly as the tick refuses a null tape.
  const out: PrefilteredLeg[] = [];
  for (const c of snapshot.candidates) {
    const mid = c.trend.windows[Math.min(1, c.trend.windows.length - 1)]!;
    const real = c.reserves ? realQuoteRaw(c.reserves) : null;
    const depth6 = real === null ? null : depthUsd6(real, c.quoteDecimals, c.quoteUsd8, c.quoteUiMultiplier);
    const spendQuoteRaw = spendInQuoteRaw(spendUsd6, c.quoteDecimals, c.quoteUsd8, c.quoteUiMultiplier);
    const leg: VenueLeg = {
      venue: "pons",
      token: c.token,
      symbol: c.symbol,
      decimals: c.decimals,
      route: c.curve,
      quoteToken: c.quoteToken,
      realDepthRaw: depth6 ?? 0n,
      graduationBps: c.graduationBps,
      ageSec: c.ageSec,
      recentTrades: mid.incomplete ? null : mid.trades,
    };
    let entry: VenueQuote | null = null;
    if (c.reserves && spendQuoteRaw !== null && spendQuoteRaw > 0n) {
      const outRaw = curveBuyOut(c.reserves, spendQuoteRaw);
      const back = outRaw === null || outRaw <= 0n ? null : curveSellOut(c.reserves, outRaw);
      const costBps = back === null ? null : Math.max(0, Number(((spendQuoteRaw - back) * 10_000n) / spendQuoteRaw));
      entry = outRaw === null || outRaw <= 0n ? null : { amountOutRaw: outRaw, costBps };
    }
    // EXECUTABILITY IS RE-DERIVED FROM THE ADDRESS HERE, never trusted from
    // the record. A snapshot can be replayed from a file, and a file can say
    // anything; the one fact that decides whether an intent may be built is
    // the quote token the curve actually names.
    const quoteNow = classifyQuote(c.quoteToken);
    const executable = quoteNow.executable;
    const base = { candidate: c, leg, entry, spendQuoteRaw, executable, executableWhy: quoteNow.executableWhy };
    const refuse = (kind: RefusalKind, reason: string) => out.push({ ...base, ok: false, refusal: { kind, reason }, score: 0 });
    if (quoteNow.address !== c.quote.address) {
      refuse("venue", `${c.symbol}: the record's quote (${c.quote.symbol}) does not match the curve's quote token — refused`);
      continue;
    }
    // UNREAD IS NOT ZERO. A curve whose reserves (or whose quote's decimals)
    // could not be read has no depth figure at all; handing scoreLeg a 0n
    // would print "only 0.00 USDG of real liquidity" about a measurement
    // that was never made. The tick's own words for the same condition.
    if (!c.reserves) {
      refuse(
        "unpriceable",
        c.quoteDecimalsKnown
          ? `${c.symbol}: its curve would not report reserves this pass`
          : `${c.symbol}: its quote's (${c.quote.symbol}) decimals could not be read this pass, so no figure from its curve is real`,
      );
      continue;
    }
    if (c.quoteUsd8 === null || depth6 === null) {
      refuse(
        "unpriceable",
        `${c.symbol} is quoted in ${c.quote.symbol} and ${unpricedWhy(c.quote, c.quotePriceWhy)}, so its depth cannot be judged against the owner's floor`,
      );
      continue;
    }
    const v = scoreLeg(leg, t, entry);
    // scoreLeg formats its depth refusal in USDG, which is the right word for
    // the one quote it was written for and the wrong word for every other:
    // an NVDA-quoted curve holds no USDG at all. Restate the same refusal in
    // USD with the quote-unit figure beside it.
    const reason =
      v.ok || v.kind !== "depth" || c.quote.kind === "usdg"
        ? v.reason
        : `only ${fmtUsd(depth6)} of real liquidity (${c.depthQuote === null ? "?" : c.depthQuote.toPrecision(4)} ${c.quote.symbol}) — the owner's floor is ${fmtUsd(t.minRealDepthRaw)}`;
    out.push({
      ...base,
      ok: v.ok,
      refusal: v.ok ? null : { kind: v.kind ?? "venue", reason: reason ?? "did not qualify" },
      score: v.score,
    });
  }
  return out;
}

// ── the three lenses, rendered from measurements ──────────────────────────

const LENS_MAX = 2_600;

function quoteWords(c: TrendingCandidate): { usd: (raw: bigint) => string; quoteAmt: (raw: bigint) => string; priceLine: string } {
  const dec = c.quoteDecimals;
  const usd = (raw: bigint) => {
    const v = quoteRawToUsd6(raw, dec, c.quoteUsd8, c.quoteUiMultiplier);
    return v === null ? "an unknown USD value" : `${(Number(v) / 1e6).toFixed(2)} USD`;
  };
  const quoteAmt = (raw: bigint) => `${((Number(raw) / 10 ** dec) * (Number(c.quoteUiMultiplier) / 1e18)).toPrecision(4)} ${c.quote.symbol}`;
  const priceLine =
    c.quote.kind === "usdg"
      ? "The curve is quoted in USDG, a dollar."
      : c.quoteUsd8 === null
        ? `The curve is quoted in ${c.quote.symbol}, which has NO USD price available — every USD figure below is unknown.`
        : `The curve is quoted in ${c.quote.symbol}, priced at ${(Number(c.quoteUsd8) / 1e8).toFixed(2)} USD by its Chainlink feed` +
          `${c.quotePriceStale ? " — that feed is STALE (older than two hours), so USD figures are approximate" : ""}.`;
  return { usd, quoteAmt, priceLine };
}

function windowLine(c: TrendingCandidate, i: number, label: string, q: ReturnType<typeof quoteWords>): string {
  const w = c.trend.windows[Math.min(i, c.trend.windows.length - 1)]!;
  return (
    `${label}: ${w.trades} trades (${w.buys} buys / ${w.sells} sells) by ${w.traders} distinct traders` +
    `${w.newTraders ? `, ${w.newTraders} new to this token` : ""}; ${q.usd(w.volume)} turned over (${q.quoteAmt(w.volume)}: ` +
    `${q.quoteAmt(w.quoteIn)} in, ${q.quoteAmt(w.quoteOut)} out); ` +
    `buy-side share of quote ${w.imbalanceQuote === null ? "unknown" : ((w.imbalanceQuote + 1) / 2 * 100).toFixed(0) + "%"}` +
    `${w.incomplete ? " — PARTIAL, part of this window could not be read" : ""}.`
  );
}

export function renderTrendingLens(c: TrendingCandidate): string {
  const t = c.trend;
  const q = quoteWords(c);
  const accel = t.tradeAcceleration === null ? "unknown" : `${t.tradeAcceleration.toFixed(2)}x`;
  const vaccel = t.volumeAcceleration === null ? "unknown" : `${t.volumeAcceleration.toFixed(2)}x`;
  const age = c.ageSec === null ? "of unknown age" : `${Math.floor(c.ageSec / 60)} minutes old`;
  const lines = [
    `${c.symbol} is a Pons launchpad token ${age}, trading on its bonding curve. ${q.priceLine} ` +
      `On-chain tape, measured from every trade event, three windows ending now:`,
    windowLine(c, 0, "Last 5 minutes", q),
    windowLine(c, 1, "Last 15 minutes", q),
    windowLine(c, 2, "Last hour", q),
    // MEASUREMENTS ONLY. The universe's own ranking score is not a fact about
    // the market — the first smoke run showed the model citing "high trending
    // rank (score 99)" as a catalyst, which is our arithmetic reflected back
    // as evidence. The model gets what was measured and draws its own line.
    `Trade-rate acceleration (5m rate over 1h rate): ${accel}. Volume acceleration: ${vaccel}. ` +
      `Net quote flow into the curve over the hour: ${q.usd(t.netQuoteFlow)} (${q.quoteAmt(t.netQuoteFlow)}).`,
    `Acceleration above 1x means the last five minutes were busier than the hour's average; ` +
      `below 1x means activity is fading. A crowd of one address looping does not count as a crowd.`,
  ];
  return lines.join("\n").slice(0, LENS_MAX);
}

export function renderLiquidityLens(c: TrendingCandidate, spendUsd6: bigint, leg: PrefilteredLeg): string {
  if (!c.reserves) return `${c.symbol}: its curve would not report reserves, so depth and impact are unknown.`;
  const q = quoteWords(c);
  const cost = leg.entry?.costBps ?? null;
  const depth =
    c.depthUsd === null
      ? `${c.depthQuote === null ? "unknown" : c.depthQuote.toPrecision(4) + " " + c.quote.symbol} (no USD value available)`
      : `${c.depthUsd.toFixed(2)} USD (${c.depthQuote?.toPrecision(4)} ${c.quote.symbol})`;
  const lines = [
    `${c.symbol} liquidity, from the curve's own reserves: real depth ${depth} (the virtual seed is excluded — it is not money). ${q.priceLine} ` +
      `Progress toward graduation ${c.graduationBps === null ? "unknown" : (c.graduationBps / 100).toFixed(1) + "%"}; ` +
      `a graduated curve can no longer be sold from the vault, and the exit rule fires before that.`,
    `A ${fmtUsd(spendUsd6)} entry${leg.spendQuoteRaw === null ? "" : ` (${q.quoteAmt(leg.spendQuoteRaw)})`} would cost ` +
      `${cost === null ? "an unknown amount" : `${(cost / 100).toFixed(2)}% round trip`} (fee 0.99% each side plus impact). ` +
      `The deterministic prefilter has ALREADY judged this candidate ${leg.ok ? "eligible under the owner's limits" : `ineligible: ${leg.refusal?.reason ?? ""}`}.`,
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
    `${c.symbol} marked at ${c.priceUsd ?? "an unknown price in"} USD from its bonding curve, quoted in ${c.quote.symbol} (a curve quote, not an oracle).`,
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
  // Every string the client serialises, including the ids — a replayed
  // snapshot file could name itself anything.
  const fields = [
    args.runId,
    args.triggerId,
    args.market.snapshot_id,
    args.market.price_usd ?? "",
    args.market.instrument_id,
    args.market.symbol,
    args.persona ?? "",
    ...Object.values(args.market.signals),
    ...(args.memory ?? []),
  ];
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

  // The existing deterministic path, run on the EXECUTABLE survivors only, so
  // the comparison is against what the tick could actually have done.
  const executableLegs = legs.filter((l) => l.executable);
  const choice = chooseEntry(executableLegs.map((l) => ({ leg: l.leg, entry: l.entry })), thresholds);
  const deterministicPick = choice.pick
    ? (() => {
        const l = executableLegs.find((x) => x.leg.token === choice.pick!.token)!;
        return { candidateId: l.candidate.id, symbol: l.candidate.symbol, score: choice.score };
      })()
    : null;

  // Profile ranking sees SURVIVORS ONLY — every quote, since research is
  // wider than execution.
  const survivors = legs.filter((l) => l.ok);
  const rankable: RankableCandidate[] = survivors.map((l) => ({
    key: l.candidate.id,
    symbol: l.candidate.symbol,
    depthUsd: l.candidate.depthUsd ?? 0,
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
      quoteSymbol: c.quote.symbol,
      executable: leg.executable,
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
    // A buy is only ever chosen from executable candidates — and that is
    // checked AGAIN here against the curve's own quote token, because this is
    // the one place an intent comes into existence. `spend` is USDG raw, so
    // it is in the curve's units exactly when the quote is USDG.
    if (classifyQuote(leg.candidate.quoteToken).kind !== "usdg") {
      entry = { ok: false, why: `${leg.candidate.symbol} is quoted in ${leg.candidate.quote.symbol}; the live route funds entries in USDG only, so no intent is built` };
    } else entry = buildClassEntry({
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

  const agrees: boolean | null =
    executableLegs.length === 0
      ? null
      : (decision.action === "hold" && deterministicPick === null) ||
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
 * candidate separately; the BEST OPPORTUNITY is the buy it was most confident
 * in across everything, and the ACTION is the most confident buy among the
 * candidates the live route can execute — provided it clears the profile's
 * floor. When the two differ, the hold reason names what was missed and why.
 * Ties fall to the higher profile rank — deterministic, the same reason every
 * time.
 */
export function chooseDecision(
  researched: readonly ResearchedCandidate[],
  agent: TrendingAgent,
  spend: bigint,
  order: readonly RankedCandidate[],
  survivors: readonly PrefilteredLeg[],
): TrendingBrainDecision {
  const hold = (kind: HoldKind, why: string, best: BestOpportunity | null = null): TrendingBrainDecision => ({
    action: "hold",
    candidateId: null,
    token: null,
    symbol: null,
    quoteSymbol: null,
    confidence: 0,
    sizeUsdg: 0,
    brainSuggestedUsdg: null,
    thesis: "",
    catalysts: [],
    risks: [],
    invalidation: [],
    decisionId: null,
    holdWhy: why,
    holdKind: kind,
    bestOpportunity: best,
  });
  if (survivors.length === 0) return hold("no-survivors", "no candidate passed the deterministic prefilter");
  if (researched.length === 0) return hold("nothing-researched", "nothing was researched");

  const answered = researched.filter((r): r is ResearchedCandidate & { result: { ok: true; decision: BrainDecision; seconds: number } } => r.result.ok);
  if (answered.length === 0) {
    const why = researched.map((r) => (r.result.ok ? "" : `${r.symbol}: ${r.result.kind}${"detail" in r.result ? ` (${r.result.detail.slice(0, 120)})` : ""}`)).filter(Boolean);
    return hold("no-answer", `the Brain gave no usable answer — ${why.join("; ")}`);
  }

  const rankOf = (id: string) => order.findIndex((o) => o.key === id);
  const byConfidence = (a: ResearchedCandidate & { result: { decision: BrainDecision } }, b: ResearchedCandidate & { result: { decision: BrainDecision } }) =>
    b.result.decision.confidence - a.result.decision.confidence || rankOf(a.candidateId) - rankOf(b.candidateId);

  // The Brain must have answered about the candidate it was asked about. An
  // answer about something else is not a hold and not a buy — it is a
  // mismatch, and the record says so rather than filing it under "held".
  const mismatched = answered.filter((r) => r.result.decision.instrument_id !== r.request.instrumentId);
  const echoed = answered.filter((r) => r.result.decision.instrument_id === r.request.instrumentId);
  const buys = echoed.filter((r) => r.result.decision.action === "buy").sort(byConfidence);
  const held = echoed.filter((r) => r.result.decision.action !== "buy");
  const confident = buys.filter((r) => r.result.decision.confidence >= agent.profile.convictionMin);

  const bestOf = (r: (typeof buys)[number]): BestOpportunity => {
    const leg = survivors.find((l) => l.candidate.id === r.candidateId)!;
    return {
      candidateId: r.candidateId,
      symbol: r.symbol,
      quoteSymbol: r.quoteSymbol,
      confidence: r.result.decision.confidence,
      executable: leg.executable,
      executableWhy: leg.executableWhy,
      thesis: r.result.decision.thesis,
      decisionId: r.result.decision.decision_id,
    };
  };
  const best = confident[0] ? bestOf(confident[0]) : null;

  const executable = confident.filter((r) => r.executable);
  if (executable.length === 0) {
    if (best && !best.executable) {
      const others = confident.length > 1 ? ` (${confident.length - 1} further confident buy${confident.length > 2 ? "s" : ""}, none executable)` : "";
      return hold(
        "unexecutable",
        `the best opportunity is ${best.symbol} quoted in ${best.quoteSymbol} at ${best.confidence.toFixed(2)} confidence, ` +
          `and the live route cannot execute it: ${best.executableWhy}${others}`,
        best,
      );
    }
    const top = buys[0];
    if (top) {
      const topLeg = survivors.find((l) => l.candidate.id === top.candidateId)!;
      return hold(
        "under-floor",
        `the Brain's best buy was ${top.symbol} at ${top.result.decision.confidence.toFixed(2)} confidence, under the ${agent.profile.convictionMin.toFixed(2)} this profile acts on` +
          (topLeg.executable ? "" : ` — and it is quoted in ${top.quoteSymbol}, which the live route could not have executed either: ${topLeg.executableWhy}`),
        best,
      );
    }
    const mismatchNote = mismatched.length
      ? `the Brain answered about a different instrument than it was asked for ${mismatched.map((r) => `${r.symbol} (echoed ${r.result.decision.instrument_id})`).join(", ")}`
      : "";
    if (held.length === 0) return hold("mismatched", mismatchNote, best);
    return hold(
      "all-held",
      `the Brain held on every researched candidate (${held.map((r) => `${r.symbol}: ${r.result.decision.hold_kind ?? r.result.decision.action}`).join(", ")})` +
        (mismatchNote ? `; ${mismatchNote}` : ""),
      best,
    );
  }

  const win = executable[0]!;
  const leg = survivors.find((l) => l.candidate.id === win.candidateId)!;
  const d = win.result.decision;
  return {
    action: "buy",
    candidateId: win.candidateId,
    token: leg.candidate.token,
    symbol: leg.candidate.symbol,
    quoteSymbol: leg.candidate.quote.symbol,
    confidence: d.confidence,
    sizeUsdg: Number(spend) / 1e6,
    brainSuggestedUsdg: Number.isFinite(d.suggested_delta_usdg) ? d.suggested_delta_usdg / 1e6 : null,
    thesis: d.thesis,
    catalysts: d.catalysts ?? [],
    risks: d.risks,
    invalidation: d.invalidation,
    decisionId: d.decision_id,
    holdKind: null,
    // Names the better pick the route could not reach, when there is one.
    holdWhy:
      best && best.candidateId !== win.candidateId && !best.executable
        ? `note: a better opportunity, ${best.symbol} quoted in ${best.quoteSymbol} at ${best.confidence.toFixed(2)}, was not executable: ${best.executableWhy}`
        : null,
    bestOpportunity: best,
  };
}
