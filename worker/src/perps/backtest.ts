/** Offline recorded-feed replay. No keys, network, production ledger or fabricated depth.
 * Uses the real trend, wall, protection evaluator and paper settlement engine.
 * Sampling and funding-price approximations are returned with every result.
 */
import { SETTINGS_DEFAULTS, perpsNumberOk, type PerpsNumKey } from "../../../packages/core/src/settings";
import { leverageTarget, perpMarketByKey, perpMarketById, type PerpKey } from "../../../packages/core/src/perps";
import { checkPolicy, type AgentLimits } from "../policy";
import { parseLighterFeed, type LighterFeedRead } from "./feed-reader";
import { buildPerpsView, buildPerpPolicyState, perpsUsdgToMicro, type PerpsViewInput, type PerpsViewSettings, type PerpsViewLedgerRow } from "./view";
import { perpTrendTick, type PerpTrendCtx, type PerpTrendResult } from "./perp-trend";
import { emptyProtectMemory, evaluateProtection } from "./protect";
import { applyPaperOpen, applyPaperClose, applyPaperReduce, applyPaperFunding, evaluatePaperTriggers, paperFundingTerms, paperPerpTerms, simulateTakerFill, type PaperPerpBook, type PaperStep } from "./paper";
import type { PerpIntentDraft } from "./drafts";
import type { PerpsNewsEvidence } from "./news";
import type { PerpsView } from "../strategies/types";
import { createReplayTradeTracker, replayTradeMetrics } from "./replay-metrics";
export interface PerpsReplayConfig {
  initialCashUsdg: number;
  /** Omitted settings use the shipped defaults, including their small position cap. */
  settings?: Partial<PerpsViewSettings>;
  perTradeUsdg?: number;
  dailyUsdg?: number;
  maxOpsPerDay?: number;
  energyOpensPerDay?: number;
  maxDrawdownBps?: number;
}
export interface PerpsReplayFrame {
  atMs: number;
  feed: unknown;
  /** Independently captured news observation at this frame; absent means no entry approval. */
  news?: { market: string; evidence: PerpsNewsEvidence };
}
/** Offline producers receive only the current frame and causal account state. */
export interface PerpsReplayProducer {
  id: string;
  diagnostics?(): unknown;
  tick(input: {
    frame: PerpsReplayFrame;
    feed: LighterFeedRead;
    view: PerpsView | null;
    settings: PerpsViewSettings;
    context: PerpTrendCtx;
    trend: PerpTrendResult;
  }): PerpTrendResult;
}
export const REPLAY_LIMITS = [
  "Stops, liquidation and protection run only at recorded snapshots; crossings between samples are unknown.",
  "IOC fills use recorded depth, without latency or market impact; the book is not depleted between actions.",
  "Funding uses the index from the replay snapshot that books it, not a historical hourly index.",
  "No live signing, deposits, withdrawals, outages, ADL or venue liquidation queue are simulated.",
  "Tail positions remain open and marked; no end-of-run sale or annualized return is invented.",
  "A recorded Brain approval needs a news observation at the execution frame; feed-only captures cannot prove unchanged news.",
] as const;
function positive(v: number, name: string, integer = false): number {
  if (!Number.isFinite(v) || v <= 0 || v > 100000000 || (integer && !Number.isSafeInteger(v)))
    throw new RangeError(`invalid ${name}`);
  return v;
}
export function replaySettings(over: Partial<PerpsViewSettings> = {}): PerpsViewSettings {
  const keys = ["perpsMaxLeverage", "perpsPerTradeUsdg", "perpsMaxOpenNotionalUsdg", "perpsMaxCollateralUsdg", "perpsMaxOpensPerDay", "perpsStopLossPct", "perpsStopSlipBps", "perpsLiqBufferPct", "perpsMaxSlippageBps"] as const;
  const s = { perpsMarkets: [...SETTINGS_DEFAULTS.perpsMarkets] as PerpKey[], perpsEntriesHalted: false } as PerpsViewSettings;
  for (const key of keys) {
    const value = over[key] ?? SETTINGS_DEFAULTS[key];
    if (!perpsNumberOk(key as PerpsNumKey, value))
      throw new RangeError(`invalid ${key}`);
    s[key] = value;
  }
  if (over.perpsMarkets !== undefined)
    s.perpsMarkets = [...over.perpsMarkets];
  if (!s.perpsMarkets.length || s.perpsMarkets.length > 8 || new Set(s.perpsMarkets).size !== s.perpsMarkets.length || s.perpsMarkets.some(k => !perpMarketByKey(k)))
    throw new RangeError("invalid perpsMarkets");
  if (over.perpsEntriesHalted !== undefined) {
    if (typeof over.perpsEntriesHalted !== "boolean")
      throw new RangeError("invalid perpsEntriesHalted");
    s.perpsEntriesHalted = over.perpsEntriesHalted;
  }
  if (s.perpsPerTradeUsdg > s.perpsMaxOpenNotionalUsdg)
    throw new RangeError("per-trade cap exceeds total notional cap");
  return s;
}
export function runPerpsReplay(config: PerpsReplayConfig, frames: readonly PerpsReplayFrame[], producer?: PerpsReplayProducer) {
  const settings = replaySettings(config.settings);
  const initial = perpsUsdgToMicro(positive(config.initialCashUsdg, "initialCashUsdg"));
  const sealed = perpsUsdgToMicro(positive(config.perTradeUsdg ?? 50, "perTradeUsdg"));
  const daily = perpsUsdgToMicro(positive(config.dailyUsdg ?? 500, "dailyUsdg"));
  const maxOps = positive(config.maxOpsPerDay ?? 50, "maxOpsPerDay", true);
  const energy = positive(config.energyOpensPerDay ?? 2, "energyOpensPerDay", true);
  const breakerBps = positive(config.maxDrawdownBps ?? 500, "maxDrawdownBps", true);
  if (breakerBps > 10000 || initial <= 0n || sealed <= 0n || daily <= 0n)
    throw new RangeError("invalid cash or breaker cap");
  if (!frames.length)
    throw new RangeError("at least one feed snapshot is required");
  let previous = -1;
  for (const f of frames) {
    if (!Number.isSafeInteger(f.atMs) || f.atMs <= previous || f.atMs < 0)
      throw new RangeError("snapshot times must strictly increase");
    previous = f.atMs;
  }
  let book: PaperPerpBook = { cashMicro: initial, positions: new Map() };
  let memory = emptyProtectMemory();
  let realized = 0n, funding = 0n, fees = 0n, peak = initial, breakerPeak = initial, maxDrawdownMicro = 0n;
  let failure: {
    atMs: number;
    reason: string;
  } | null = null;
  let maxSampleGapMs = 0;
  const lastEntryCandleT = new Map<PerpKey, number>();
  const lastExit = new Map<PerpKey, {
    atSec: number;
    cause: "strategy" | "risk";
  }>();
  const opens: {
    atSec: number;
    notional: bigint;
  }[] = [];
  const operations: number[] = [];
  const events: {
    atMs: number;
    kind: string;
    marketId?: number;
    detail?: string;
    step?: PaperStep;
  }[] = [];
  const curve: {
    atMs: number;
    equityMicro: bigint;
    cashMicro: bigint;
    marginMicro: bigint;
    unrealizedMicro: bigint;
  }[] = [];
  let sequence = 0;
  let now = 0;
  const trades = createReplayTradeTracker();
  const limits: AgentLimits = { perTradeUsdg: sealed, dailyUsdg: daily, maxOpsPerDay: maxOps, maxDrawdownBps: breakerBps, expiresAt: Number.MAX_SAFE_INTEGER, allowedTargets: [], allowedAssets: [], cashToken: "0x0000000000000000000000000000000000000000" };
  const record = (step: PaperStep, kind: string) => {
    trades.record(step, now, kind);
    book = step.book;
    for (const f of step.fills) {
      realized += f.realizedMicro;
      fees += f.feeMicro;
    }
    if (step.funding)
      funding += step.funding.paymentMicro;
    if (step.before && !step.after) {
      const key = perpMarketById(step.marketId)?.key;
      if (key)
        lastExit.set(key, { atSec: Math.floor(now / 1000), cause: kind === "strategy-close" ? "strategy" : "risk" });
    }
    // Keep settlement facts, not a full copy of every prior book in the JSON report.
    events.push({ atMs: now, kind, marketId: step.marketId, step });
  };
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    now = frame.atMs;
    if (i)
      maxSampleGapMs = Math.max(maxSampleGapMs, now - frames[i - 1]!.atMs);
    // Live ingestion tolerates clock skew; historical evaluation cannot borrow
    // even a few seconds of future observations to improve a simulated fill.
    const future = frame.feed && typeof frame.feed === "object" && "observedAt" in frame.feed &&
      typeof frame.feed.observedAt === "number" && frame.feed.observedAt > now;
    const feed = future ? null : parseLighterFeed(frame.feed, now);
    const fail = (reason: string) => { failure = { atMs: now, reason }; };
    if (!feed) {
      fail("feed unread or invalid");
      break;
    }
    const nowSec = Math.floor(now / 1000);
    // Check ALL held markets before booking any part of this sample. Unknown funding
    // is not a zero payment and cannot silently disappear when a position closes.
    for (const p of book.positions.values()) {
      const m = feed.markets.get(p.marketId);
      if (!m?.fresh || !m.bookFresh) {
        fail(`held market ${p.marketId} has unread prices/depth`);
        break;
      }
      const rates = new Map((m.fundingHistory ?? []).map(r => [r.atSec, r]));
      for (let h = (p.fundingHourApplied ?? Math.floor(p.openedAtSec / 3600) * 3600) + 3600; h <= Math.floor(nowSec / 3600) * 3600; h += 3600) {
        const r = rates.get(h);
        if (!r || r.ratePpm < 0) {
          fail(`funding gap for market ${p.marketId} at ${h}`);
          break;
        }
      }
      if (failure)
        break;
    }
    if (failure)
      break;
    for (const p of [...book.positions.values()]) {
      const m = feed.markets.get(p.marketId)!;
      const rates = new Map((m.fundingHistory ?? []).map(r => [r.atSec, r]));
      for (let h = (p.fundingHourApplied ?? Math.floor(p.openedAtSec / 3600) * 3600) + 3600; h <= Math.floor(nowSec / 3600) * 3600; h += 3600) {
        const r = rates.get(h)!;
        const terms = paperFundingTerms({ index: m.index, ratePpm: r.ratePpm, spec: m.spec });
        const step = applyPaperFunding({ book, marketId: p.marketId, fundingHour: h, ...terms, direction: r.direction, creditReceiver: true, ratePpm: r.direction === "short" ? -r.ratePpm : r.ratePpm, spec: m.spec });
        if (step)
          record(step, "funding");
      }
    }
    const triggers = evaluatePaperTriggers({ book, nowMs: now, seq: ++sequence, markets: new Map([...feed.markets].map(([id, m]) => [id, { mark: m.fresh ? m.mark : null, levels: m.bookFresh ? { bids: m.bids, asks: m.asks } : null, spec: m.spec, takerFeePpm: m.takerFeePpm }])) });
    for (const e of triggers.events)
      record(e.step, e.kind);
    const today = () => opens.filter(o => o.atSec > nowSec - 86400);
    const spent = () => today().reduce((n, o) => n + o.notional, 0n);
    const ops = () => operations.filter(t => t > nowSec - 86400).length;
    const valuation = () => paperPerpTerms(book, new Map([...feed.markets].map(([id, m]) => [id, m.fresh ? m.mark : null])), new Map([...feed.markets].map(([id, m]) => [id, m.spec])))!;
    const input = (): PerpsViewInput => {
      const positions: PerpsViewLedgerRow[] = [...feed.markets.values()].map(m => {
        const p = book.positions.get(m.marketId);
        return { marketId: m.marketId, side: p?.side ?? null, base: p?.baseAmount ?? 0n, entryPrice: p?.entryPrice ?? 0n, allocatedMarginMicro: p?.allocatedMarginMicro ?? 0n, imfBp: p?.imfBp ?? leverageTarget(settings.perpsMaxLeverage, m.spec).imfBp, marginMode: "isolated", fundingMicro: p?.fundingMicro ?? 0n, stopTrigger: p?.stop?.trigger ?? null, stopPrice: p?.stop?.price ?? null, takeTrigger: p?.take?.trigger ?? null, takePrice: p?.take?.price ?? null, openedAt: p?.openedAtSec ?? null };
      });
      return { mode: "paper", nowSec, feed, settings, grant: { perTradeSealedMicro: sealed, expiresAtSec: null }, ledger: { positions, paperCashMicro: book.cashMicro, paperCollateralMicro: 0n, unresolvedMarkets: new Set(), unresolvedOpenMarkets: new Set(), closeInFlightMarkets: new Set(), pendingOpenNotionalMicro: 0n, opensToday: today().length, lastExit, lastEntryCandleT, depositsInTransitMicro: 0n, withdrawalsInTransitMicro: 0n, incident: false, entriesHalted: settings.perpsEntriesHalted } };
    };
    const execute = (intent: PerpIntentDraft, kind: string) => {
      const state = input(), view = buildPerpsView(state), term = valuation();
      const verdict = checkPolicy(intent, limits, { spentTodayUsdg: spent(), opsToday: ops(), highWaterMarkUsdg: breakerPeak, equityUsdg: book.cashMicro + term.isolatedMarginMicro + term.unrealizedMicro, nowSec, perp: buildPerpPolicyState(state, view, { mode: "paper" }) });
      if (!verdict.ok) {
        events.push({ atMs: now, kind: "refused", marketId: intent.marketId, detail: verdict.rule });
        return;
      }
      const m = feed.markets.get(intent.marketId);
      if (!m?.fresh || !m.bookFresh) {
        events.push({ atMs: now, kind: "refused", marketId: intent.marketId, detail: "depth-unread" });
        return;
      }
      const fill = simulateTakerFill({ isAsk: intent.effect === "open" ? intent.side === "short" : intent.side === "long", baseAmount: intent.baseAmount, worstPrice: intent.worstPrice, book: { bids: m.bids, asks: m.asks }, spec: m.spec, takerFeePpm: m.takerFeePpm });
      const args = { book, marketId: intent.marketId, fill, spec: m.spec, nowMs: now, tradeId: `replay:${++sequence}` };
      const step = intent.effect === "open" ? applyPaperOpen({ ...args, side: intent.side, imfBp: intent.imfBp, stop: { trigger: intent.stopTrigger, price: intent.stopPrice } }) :
        intent.effect === "reduce" ? applyPaperReduce({ ...args, leg: "close" }) : applyPaperClose(args);
      record(step, kind);
      if (step.fills.length) {
        operations.push(nowSec);
        if (intent.effect === "open")
          opens.push({ atSec: nowSec, notional: intent.notionalUsdg });
      }
    };
    const protectedPass = evaluateProtection({ view: buildPerpsView(input()), nowSec, settings, prior: memory, feedFresh: true, book: "paper" });
    memory = protectedPass.memory;
    for (const action of protectedPass.actions) {
      if (action.kind === "close")
        execute(action.intent, "risk-close");
      if (action.kind === "replace-stop") {
        const p = book.positions.get(action.marketId);
        if (p)
          book = { ...book, positions: new Map(book.positions).set(action.marketId, { ...p, stop: { trigger: action.trigger, price: action.price } }) };
      }
    }
    const term = valuation();
    const equity = book.cashMicro + term.isolatedMarginMicro + term.unrealizedMicro;
    breakerPeak = breakerPeak > equity - term.unrealizedGainMicro ? breakerPeak : equity - term.unrealizedGainMicro;
    const view = buildPerpsView(input());
    const context: PerpTrendCtx = { equityMicro: equity, breakerIdle: equity * 10000n >= breakerPeak * BigInt(10000 - breakerBps), breakerLimitBps: breakerBps, energyEntriesLeft: today().length < energy, opsHeadroom: ops() < maxOps, spendHeadroomMicro: daily > spent() ? daily - spent() : 0n, perTradeSealedMicro: sealed, nowSec };
    const baseline = perpTrendTick(view, settings, context);
    const trend = producer?.tick({ frame, feed, view, settings, context, trend: baseline }) ?? baseline;
    for (const exit of trend.exits)
      execute(exit, "strategy-close");
    if (trend.entry) {
      if (trend.entryCandleT !== null)
        lastEntryCandleT.set(trend.entry.market, trend.entryCandleT);
      execute(trend.entry, "open");
    }
    else if (trend.idle)
      events.push({ atMs: now, kind: "idle", detail: trend.idle.code });
    const end = valuation(), value = book.cashMicro + end.isolatedMarginMicro + end.unrealizedMicro;
    peak = peak > value ? peak : value;
    if (peak - value > maxDrawdownMicro)
      maxDrawdownMicro = peak - value;
    if (value !== initial + realized + funding - fees + end.unrealizedMicro)
      throw new Error("replay accounting identity failed");
    curve.push({ atMs: now, equityMicro: value, cashMicro: book.cashMicro, marginMicro: end.isolatedMarginMicro, unrealizedMicro: end.unrealizedMicro });
  }
  return {
    strategy: producer?.id ?? "perp-trend", complete: failure === null, failure: failure as {
      atMs: number;
      reason: string;
    } | null, settings,
    limits: { perTradeMicro: sealed, dailyMicro: daily, maxOpsPerDay: maxOps, energyOpensPerDay: energy, maxDrawdownBps: breakerBps, budgetWindow: "trailing-24-hours" },
    assumptions: REPLAY_LIMITS, maxSampleGapMs, snapshotsProcessed: curve.length,
    initialCashMicro: initial, finalEquityMicro: failure ? null : curve.at(-1)!.equityMicro,
    realizedMicro: realized, fundingMicro: funding, feesMicro: fees, maxDrawdownMicro,
    tailPositions: [...book.positions.values()], curve,
    completedTrades: trades.completed(), openTrades: trades.open(),
    metrics: replayTradeMetrics({ completed: trades.completed(), open: trades.open(), initialCashMicro: initial, curve, complete: failure === null }),
    producerDiagnostics: producer?.diagnostics?.(),
    events: events.map(({ step, ...e }) => step ? { ...e, fills: step.fills, funding: step.funding, cashDeltaMicro: step.cashDeltaMicro } : e),
  };
}
