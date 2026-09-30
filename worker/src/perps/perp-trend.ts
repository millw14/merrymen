/**
 * PERP-TREND — the perps route's deterministic producer (docs/perps.md, "The
 * perps route"; the review's perp-trend-algorithm).
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * IT IS NOT ALPHA. It is the plainest trend rule that can be written down in
 * integers — a 12-bar channel breakout confirmed by a 24-bar EMA, on closed
 * 4 h mark candles, with a volatility stop — and it exists so that an owner who
 * switches perps on gets a producer whose every decision can be re-derived
 * from the candles, not one that sounds clever. The spike backtest
 * (scratchpad bt.py, 1x notional, 5 bp slippage, funding applied), on about
 * 277 days of UTC-aligned 4 h BTC/ETH/SOL bars, ended each market between
 * x0.99 and x1.65 with 12–24% maximum drawdown at 1x (BTC 70 trades x0.99 /
 * 23.9%, ETH 48 x1.11 / 18.1%, SOL 36 x1.65 / 12.1%). Moving the bar phase by
 * one to three hours alone swung a market's result by up to 0.5x — BTC
 * between x0.99 and x1.29, SOL between x1.11 and x1.65 — so those figures are
 * noise, not a point estimate. With a 3% stop ceiling it traded ETH 7 times
 * and SOL 4 times in the whole sample: at tight owner stops it is mostly
 * idle, and it says so (`perp-too-volatile`) rather than widening anything. A
 * take-profit at twice the stop made every case worse, so it never carries
 * one, whatever `perpsTakeProfitPct` says. The 8 h funding gate never bound in
 * 2,277 hours; it is a tail guard. What it IS: sized so that a stop costs at
 * most 1% of equity, never the owner's leverage choice, never a model's.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * UNIVERSE  perpsMarkets ∩ PERP_TREND_UNIVERSE (BTC, ETH, SOL). Anything else
 *           the owner allowed is `perp-market-not-covered`: it stays open to
 *           the owner's own orders, never to this.
 * SIGNAL    Closed 4 h MARK candles only (≥ 100 contiguous; the one in progress
 *           is dropped at THIS clock, again, whatever the view says). EMA24 of
 *           close and Wilder ATR14, each seeded with the simple mean of its
 *           first n values in the window, in bigint fixed point — paper, live
 *           and tests compute the same numbers. HH12/LL12 are the high/low of
 *           the 12 closed candles BEFORE the last closed one; HH6/LL6 the same
 *           over 6, for exits.
 * ENTER     long when close > HH12 and close > EMA24 (short: the mirror), and
 *           ALL of: market active; no position, resting order or unresolved
 *           row there; cooldown clear (8 h after a strategy exit, 24 h after a
 *           stop, take, risk exit, forced fill or an exit of unknown cause);
 *           not the candle the last entry was taken on (policy refusals
 *           included — a refused entry waits for the next close); fewer than
 *           2 positions; breaker idle, energy and ops headroom left; the grant
 *           good for another 168 h; the 8 h mean funding against the side
 *           ≤ 0.005%/h. One open per tick: the largest (close − channel)/ATR.
 * STOP      max(1.5%, 3 × ATR14 / close). Above perpsStopLossPct it idles
 *           `perp-too-volatile` — the owner's number is a ceiling, never raised
 *           to make a trade happen, and the stop is never tightened below
 *           3 ATR. It must still beat liquidation by the owner's buffer.
 * SIZE      min(perpsPerTradeUsdg, sealed per-trade, the view's per-trade and
 *           open-notional headroom, the day's spend headroom, 0.95 × L × usable
 *           collateral, 1% of equity / stop). Under the venue minimum it idles
 *           `perp-below-min`; nothing is raised to reach it. USABLE is core
 *           perpOpenMarginBudgetMicro — checkPerpOpen's committed + margin ≤
 *           cap solved for the margin (paper: min(paper cash, cap − ΣM)) —
 *           never free cash ADDED to the room: an open sized past the cap is
 *           an open the wall refuses on every signal bar.
 * EXIT      any of, judged on the last closed candle: a long's close under
 *           LL6 or under EMA24 (short: the mirror) → `trend`; held ≥ 168 h →
 *           `aged`. Always the whole venue position, reduce-only. Risk exits
 *           (stops, liquidation distance, funding bleed, market status) are
 *           protect.ts's, never this file's, and no exit here reads the
 *           breaker, energy, ops, a cap or the grant.
 *
 * PURE. No clock (ctx.nowSec), no I/O, no state between calls: the cooldown
 * clock and the last entry's candle come from the view (the ledger), so a
 * restart forgets nothing.
 */

import { PERP_TREND_UNIVERSE, leverageFromImfBp, perpOpenMarginBudgetMicro, type PerpKey, type PerpSide } from "../../../packages/core/src/perps";
import type { ResolvedConfig } from "../settings";
import type { Why } from "../strategies/reasons";
import type { PerpMarketView, PerpPositionView, PerpsView } from "../strategies/types";
import { buildExitDraft, buildOpenDraft, type PerpExitDraft, type PerpOpenDraft } from "./drafts";
import { usableClosedCandles } from "./feed-reader";

/**
 * FROZEN, like TRENCHER_DEFAULTS: these are the strategy, not settings. An
 * owner tunes the caps and the stop ceiling; nobody tunes the rule.
 */
export const PERP_TREND_DEFAULTS = Object.freeze({
  candleMs: 14_400_000,
  minCandles: 100,
  emaPeriod: 24,
  atrPeriod: 14,
  entryChannel: 12,
  exitChannel: 6,
  /** stop = max(minStopBps, atrStopMult × ATR / close) */
  atrStopMult: 3,
  minStopBps: 150,
  maxPositions: 2,
  maxHoldHours: 168,
  cooldownAfterStrategyHours: 8,
  cooldownAfterRiskHours: 24,
  fundingHours: 8,
  /** 0.005 %/h, in parts per million of notional per hour. */
  maxFundingAgainstPpmPerHour: 50,
  /** Margin may use at most this share of the usable collateral (0.95 × L × usable). */
  collateralUseBps: 9_500,
  /** A stop costs at most this share of equity. */
  riskPerTradeBps: 100,
  /** A mark older than this is unread for an open (docs/perps.md, feed.ts: 30 s). */
  markMaxAgeSec: 30,
});

/** The settings perp-trend reads — nothing else about the account. */
export type PerpTrendSettings = Pick<
  ResolvedConfig,
  "perpsMarkets" | "perpsPerTradeUsdg" | "perpsStopLossPct" | "perpsStopSlipBps" | "perpsMaxSlippageBps" | "perpsLiqBufferPct"
>;

/**
 * What the tick knows that the perps view does not. Every brake is a boolean
 * the CALLER measured; none of them binds an exit.
 */
export interface PerpTrendCtx {
  /** Total equity, micro-USDG (composeEquityUsdg, the venue included). Null = unknown: nothing opens. */
  equityMicro: bigint | null;
  /** True while the drawdown breaker is NOT tripped (breakerIdle(snap) === undefined). */
  breakerIdle: boolean;
  /** The sealed drawdown limit, for the owner's `breaker-tripped` sentence; absent = say nothing. */
  breakerLimitBps?: number | null;
  /** Today's energy still allows a new position. */
  energyEntriesLeft: boolean;
  /** The day's operation count is not spent. */
  opsHeadroom: boolean;
  /** USDG still spendable today, micro; null = not read (then it does not size — policy's daily cap still binds). */
  spendHeadroomMicro: bigint | null;
  /** The grant's sealed per-trade cap, micro-USDG. */
  perTradeSealedMicro: bigint;
  nowSec: number;
}

export interface PerpTrendResult {
  /** Reduce-only closes of whole venue positions, universe order. */
  exits: PerpExitDraft[];
  /** At most one open. */
  entry: PerpOpenDraft | null;
  /** why[i] explains exits[i]; when there is an entry, why[exits.length] explains it. */
  why: Why[];
  /** Why no entry, when there is none — the one sentence for Tick.idle; null when there is nothing to say. */
  idle: Why | null;
  /** Each covered market's own reason for not opening, universe order (diagnostics; the idle picks from these). */
  blocked: Why[];
  /** The candle `t` (ms) the entry was taken on — the lane records it as that market's lastEntryCandleT. */
  entryCandleT: number | null;
}

// ── indicators, in bigint fixed point ───────────────────────────────────────

/** Fixed-point scale for EMA and ATR: prices are < 2^32, so ×10^12 stays far inside exact bigint. */
export const TREND_SCALE = 10n ** 12n;

export type TrendCandle = { t: number; o: bigint; h: bigint; l: bigint; c: bigint };

export interface TrendRead {
  /** The last CLOSED candle's open time, ms. */
  lastT: number;
  close: bigint;
  /** EMA24 of close at the last candle, × TREND_SCALE. */
  emaS: bigint;
  /** Wilder ATR14 at the last candle, × TREND_SCALE. */
  atrS: bigint;
  hh12: bigint;
  ll12: bigint;
  hh6: bigint;
  ll6: bigint;
}

const absB = (x: bigint) => (x < 0n ? -x : x);
const maxB = (...xs: bigint[]) => xs.reduce((a, b) => (b > a ? b : a));
const minB = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));

/**
 * EMA(period) of close at the last candle, × TREND_SCALE: seeded with the
 * mean of the first `period` closes, then e = (2c + (n−1)e) / (n+1), floored
 * at every step. Null when there are fewer than `period` candles.
 */
export function emaScaled(candles: readonly TrendCandle[], period: number): bigint | null {
  if (candles.length < period || period < 1) return null;
  let sum = 0n;
  for (let i = 0; i < period; i++) sum += (candles[i] as TrendCandle).c;
  let e = (sum * TREND_SCALE) / BigInt(period);
  const n1 = BigInt(period + 1);
  const nm1 = BigInt(period - 1);
  for (let i = period; i < candles.length; i++) e = (2n * (candles[i] as TrendCandle).c * TREND_SCALE + nm1 * e) / n1;
  return e;
}

/**
 * Wilder ATR(period) at the last candle, × TREND_SCALE: TR from the second
 * candle on (the first has no previous close), seeded with the mean of the
 * first `period` TRs, then a = ((n−1)a + tr) / n, floored. Null when too short.
 */
export function atrScaled(candles: readonly TrendCandle[], period: number): bigint | null {
  if (candles.length < period + 1 || period < 1) return null;
  const tr = (i: number): bigint => {
    const c = candles[i] as TrendCandle;
    const prev = (candles[i - 1] as TrendCandle).c;
    return maxB(c.h - c.l, absB(c.h - prev), absB(c.l - prev));
  };
  let sum = 0n;
  for (let i = 1; i <= period; i++) sum += tr(i);
  let a = (sum * TREND_SCALE) / BigInt(period);
  const n = BigInt(period);
  for (let i = period + 1; i < candles.length; i++) a = ((n - 1n) * a + tr(i) * TREND_SCALE) / n;
  return a;
}

/** Everything the rule reads off one market's closed candles, or null when there are too few. */
export function trendRead(candles: readonly TrendCandle[]): TrendRead | null {
  const D = PERP_TREND_DEFAULTS;
  const n = candles.length;
  if (n < D.minCandles) return null;
  const last = candles[n - 1] as TrendCandle;
  const emaS = emaScaled(candles, D.emaPeriod);
  const atrS = atrScaled(candles, D.atrPeriod);
  if (emaS === null || atrS === null) return null;
  // The channels exclude the last closed candle itself: "a close through the
  // 12-bar high" is a close above the highs BEFORE it.
  const prior12 = candles.slice(n - 1 - D.entryChannel, n - 1);
  const prior6 = candles.slice(n - 1 - D.exitChannel, n - 1);
  return {
    lastT: last.t,
    close: last.c,
    emaS,
    atrS,
    hh12: maxB(...prior12.map((c) => c.h)),
    ll12: minB(...prior12.map((c) => c.l)),
    hh6: maxB(...prior6.map((c) => c.h)),
    ll6: minB(...prior6.map((c) => c.l)),
  };
}

/** The entry signal on a read: which side, if any. */
export function entrySignal(r: TrendRead): PerpSide | null {
  const cS = r.close * TREND_SCALE;
  if (r.close > r.hh12 && cS > r.emaS) return "long";
  if (r.close < r.ll12 && cS < r.emaS) return "short";
  return null;
}

/** The strategy's trend exit for a held side: the close back through the 6-bar channel or the EMA. */
export function trendExit(r: TrendRead, held: PerpSide): boolean {
  const cS = r.close * TREND_SCALE;
  return held === "long" ? r.close < r.ll6 || cS < r.emaS : r.close > r.hh6 || cS > r.emaS;
}

/** max(1.5%, 3 × ATR / close) in bp, rounded UP — never tighter than three ATRs. */
export function trendStopBps(r: TrendRead): number {
  const D = PERP_TREND_DEFAULTS;
  const den = r.close * TREND_SCALE;
  if (den <= 0n) return Number.MAX_SAFE_INTEGER;
  const num = BigInt(D.atrStopMult) * r.atrS * 10_000n;
  const bps = (num + den - 1n) / den;
  const b = bps > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bps);
  return b > D.minStopBps ? b : D.minStopBps;
}

// ── the tick ────────────────────────────────────────────────────────────────

/** Settings dollars (≤ 2 dp) → micro-USDG, exactly. */
function usdgMicro(v: number): bigint {
  return BigInt(Math.round(v * 1_000_000));
}

/** A settings percent (≤ 2 dp) → bp, exactly. */
function pctBps(v: number): number {
  return Math.round(v * 100);
}

function cooldownOf(
  last: { atSec: number; cause: "strategy" | "stop" | "take" | "risk" | "forced" | "unknown" } | undefined,
  nowSec: number,
  key: PerpKey,
): Why | null {
  if (last === undefined) return null;
  const D = PERP_TREND_DEFAULTS;
  const hours = last.cause === "strategy" ? D.cooldownAfterStrategyHours : D.cooldownAfterRiskHours;
  if (nowSec >= last.atSec + hours * 3600) return null;
  // The sentence names what the owner can recognise; a take or an exit of
  // unknown cause reads as "an exit", with the longer pause it earns.
  const after = last.cause === "stop" ? "stop" : last.cause === "risk" ? "risk" : last.cause === "forced" ? "forced" : "strategy";
  return { code: "perp-cooldown", market: key, hours, after };
}

/** The idle a view-level blocker implies, when there is a sentence for it. */
function blockerIdle(b: NonNullable<PerpsView["opensBlocked"]>, ctx: PerpTrendCtx): Why | null {
  switch (b) {
    case "perps-venue-unreachable":
      return { code: "perp-signal-unread", market: null };
    case "perps-grant-expiring":
      return { code: "perp-grant-expiring", withinHours: 24 };
    case "breaker-tripped":
      return typeof ctx.breakerLimitBps === "number" && Number.isFinite(ctx.breakerLimitBps)
        ? { code: "breaker-tripped", limitBps: ctx.breakerLimitBps }
        : null;
    default:
      // The rest are the dashboard's to explain (agents.perps' blocker); the
      // idle channel says nothing rather than something approximate.
      return null;
  }
}

/**
 * One tick of perp-trend. Exits first (they read nothing but the position,
 * the market and the candles), then at most one entry. `view` null or absent
 * is Lighter unread: nothing at all — an exit is never originated from state
 * nobody read (protect.ts reads the account itself).
 */
export function perpTrendTick(view: PerpsView | null | undefined, s: PerpTrendSettings, ctx: PerpTrendCtx): PerpTrendResult {
  const D = PERP_TREND_DEFAULTS;
  const out: PerpTrendResult = { exits: [], entry: null, why: [], idle: null, blocked: [], entryCandleT: null };
  if (!view) {
    out.idle = { code: "perp-signal-unread", market: null };
    return out;
  }
  const nowMs = ctx.nowSec * 1000;
  const reads = new Map<PerpKey, TrendRead | null>();
  const readOf = (m: PerpMarketView): TrendRead | null => {
    if (!reads.has(m.key)) {
      const candles = usableClosedCandles(m.closed4h, nowMs);
      reads.set(m.key, candles === null ? null : trendRead(candles));
    }
    return reads.get(m.key) ?? null;
  };
  const universe = PERP_TREND_UNIVERSE as readonly PerpKey[];

  // ── EXITS, whatever else is true ──────────────────────────────────────
  //
  // Every position in the universe, allowed or not: an owner who un-ticks a
  // market while holding it has not asked for the position to lose its exit.
  // Skipped only where the answer cannot be built — no market read (no mark
  // to bound the IOC), or an order still unresolved there (a close already in
  // flight; a second one would be a second decision row for the same exit).
  for (const key of universe) {
    const pos: PerpPositionView | undefined = view.positions.get(key);
    if (pos === undefined || pos.baseAmount <= 0n) continue;
    if (view.unresolved.has(key)) continue;
    const m = view.markets.get(key);
    if (m === undefined) continue;
    const r = readOf(m);
    let cause: "trend" | "aged" | null = null;
    if (r !== null && trendExit(r, pos.side)) cause = "trend";
    else if (ctx.nowSec - pos.openedAtSec >= D.maxHoldHours * 3600) cause = "aged";
    if (cause === null) continue;
    const draft = buildExitDraft({ market: m, position: pos, effect: "close", maxSlippageBps: s.perpsMaxSlippageBps });
    if (draft === null) continue;
    out.exits.push(draft);
    out.why.push({ code: "perp-exit", market: key, side: pos.side, cause });
  }

  // ── ONE ENTRY, behind every brake ─────────────────────────────────────
  const allowed = new Set<string>(s.perpsMarkets);
  const covered = universe.filter((k) => allowed.has(k));
  const gate = ((): Why | null | "open" => {
    if (view.opensBlocked !== null) return blockerIdle(view.opensBlocked, ctx);
    if (!ctx.breakerIdle) {
      return typeof ctx.breakerLimitBps === "number" && Number.isFinite(ctx.breakerLimitBps)
        ? { code: "breaker-tripped", limitBps: ctx.breakerLimitBps }
        : null;
    }
    if (!ctx.energyEntriesLeft) return null;
    if (!ctx.opsHeadroom) return { code: "ops-spent" };
    if (!(view.headroom.opensLeftToday > 0)) return null;
    if (ctx.equityMicro === null) return { code: "perp-signal-unread", market: null };
    if (view.positions.size >= D.maxPositions) return { code: "perp-max-positions", max: D.maxPositions };
    const needSec = ctx.nowSec + D.maxHoldHours * 3600;
    // A live grant must be good for as long as a position may be held; a
    // paper book has no grant to outlive (null there is not "unknown").
    if (view.grantExpiresAtSec === null ? view.mode === "live" : view.grantExpiresAtSec <= needSec) {
      return { code: "perp-grant-expiring", withinHours: D.maxHoldHours };
    }
    if (covered.length === 0) {
      const first = s.perpsMarkets[0];
      return first !== undefined ? { code: "perp-market-not-covered", market: first } : null;
    }
    return "open";
  })();
  if (gate !== "open") {
    out.idle = gate;
    return out;
  }

  const equity = ctx.equityMicro as bigint;
  type Candidate = { draft: PerpOpenDraft; stopBps: number; t: number; num: bigint; den: bigint };
  let best: Candidate | null = null;
  const unread: Why[] = [];
  for (const key of covered) {
    const m = view.markets.get(key);
    if (m === undefined || ctx.nowSec - m.observedAtSec > D.markMaxAgeSec) {
      unread.push({ code: "perp-signal-unread", market: key });
      continue;
    }
    const r = readOf(m);
    if (r === null) {
      unread.push({ code: "perp-signal-unread", market: key });
      continue;
    }
    const side = entrySignal(r);
    // No signal, a market the venue has stopped, a position already there, or
    // this very candle already acted on: nothing to say about this market.
    if (side === null || m.status !== "active" || view.positions.has(key)) continue;
    if (view.lastEntryCandleT.get(key) === r.lastT) continue;
    if (view.unresolved.has(key)) {
      out.blocked.push({ code: "perp-order-unresolved", market: key });
      continue;
    }
    const cool = cooldownOf(view.lastExit.get(key), ctx.nowSec, key);
    if (cool !== null) {
      out.blocked.push(cool);
      continue;
    }
    const f8 = m.funding8h;
    if (!f8 || f8.length < D.fundingHours) {
      unread.push({ code: "perp-signal-unread", market: key });
      continue;
    }
    // Positive ppm means longs pay; against a short it is the negation. The
    // mean over the eight hours, compared exactly as a sum.
    const recent = f8.slice(f8.length - D.fundingHours);
    const against = recent.reduce((a, x) => a + (side === "long" ? x.ppmPerHour : -x.ppmPerHour), 0);
    if (!Number.isFinite(against) || against > D.maxFundingAgainstPpmPerHour * D.fundingHours) {
      out.blocked.push({ code: "perp-funding-against", market: key, side });
      continue;
    }
    const stopBps = trendStopBps(r);
    const maxStopBps = pctBps(s.perpsStopLossPct);
    if (stopBps > maxStopBps) {
      out.blocked.push({ code: "perp-too-volatile", market: key, stopPct: stopBps / 100, maxStopPct: s.perpsStopLossPct });
      continue;
    }

    // SIZE: the smallest of every cap and both risk budgets. The collateral
    // budget is the POLICY's arithmetic (core perpOpenMarginBudgetMicro): the
    // margin must fit under perpsMaxCollateralUsdg on top of what is already
    // committed AND come from money that is there. Summing free cash and the
    // room — as this once did — sized opens the collateral cap then refused.
    const usable = perpOpenMarginBudgetMicro({ mode: view.mode, freeMicro: view.account.freeCollateralMicro, roomMicro: view.headroom.collateralLeftMicro });
    const byCollateral = usable > 0n && m.imfBp > 0 ? (usable * BigInt(D.collateralUseBps)) / BigInt(m.imfBp) : 0n;
    const byRisk = equity > 0n ? (equity * BigInt(D.riskPerTradeBps)) / BigInt(stopBps) : 0n;
    const caps = [
      usdgMicro(s.perpsPerTradeUsdg),
      ctx.perTradeSealedMicro,
      view.headroom.perTradeNotionalMicro,
      view.headroom.openNotionalLeftMicro,
      byCollateral,
      byRisk,
      ...(ctx.spendHeadroomMicro === null ? [] : [ctx.spendHeadroomMicro]),
    ];
    let n = minB(...caps);
    if (n < 0n) n = 0n;
    if (n < m.effMinNotionalMicro) {
      out.blocked.push({ code: "perp-below-min", market: key, minRaw: m.effMinNotionalMicro, capRaw: n });
      continue;
    }
    const built = buildOpenDraft({
      market: m,
      side,
      notionalCapMicro: n,
      stopBps,
      maxSlippageBps: s.perpsMaxSlippageBps,
      stopSlipBps: s.perpsStopSlipBps,
      liqBufferBps: pctBps(s.perpsLiqBufferPct),
    });
    if (!built.ok) {
      if (built.rule === "perp-below-min") {
        out.blocked.push({ code: "perp-below-min", market: key, minRaw: built.minMicro, capRaw: built.capMicro });
      } else if (built.rule === "perp-stop-inside-liquidation") {
        // The stop the market needs does not fit inside liquidation at this
        // leverage: the same sentence as a ceiling, with the room there is.
        out.blocked.push({ code: "perp-too-volatile", market: key, stopPct: stopBps / 100, maxStopPct: built.maxStopBps / 100 });
      }
      continue;
    }
    // Strength of the break, in ATRs: (close − channel) / ATR, compared as
    // exact cross-products. Ties keep universe order.
    const num = (side === "long" ? r.close - r.hh12 : r.ll12 - r.close) * TREND_SCALE;
    const den = r.atrS > 0n ? r.atrS : 1n;
    if (best === null || num * best.den > best.num * den) best = { draft: built.draft, stopBps, t: r.lastT, num, den };
  }

  if (best !== null) {
    out.entry = best.draft;
    out.entryCandleT = best.t;
    out.why.push({
      code: "perp-open",
      market: best.draft.market,
      side: best.draft.side,
      leverage: leverageFromImfBp(best.draft.imfBp),
      stopPct: best.stopBps / 100,
    });
    return out;
  }
  out.blocked.push(...unread);
  // A market that signalled and was held back says more than one that could
  // not be read; one that could not be read says more than "no signal".
  out.idle = out.blocked[0] ?? { code: "perp-no-signal", markets: covered.length };
  return out;
}
