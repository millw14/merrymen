/**
 * TEST FIXTURES ONLY — a perps view for the route's tests (perp-trend.test.ts,
 * route.test.ts, strategist/perp-boundary.test.ts). Nothing in production
 * imports this file.
 *
 * Markets are the live orderBookDetails capture (fixtures/), so decimals,
 * minimums and margin fractions are the venue's own; candles are synthetic on
 * the real 4 h grid, so each test can say exactly which bar breaks what. The
 * policy helper runs a draft through the REAL checkPolicy with a state built
 * from the same view — a producer whose output the wall refuses is a producer
 * that spends an open a candle on a refusal.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { effectiveMinNotionalMicro, leverageTarget, perpMarketByKey, type PerpKey } from "../../../packages/core/src/perps";
import { checkPolicy, type AgentLimits, type AgentState, type PerpPolicyState, type TradeIntent, type Verdict } from "../policy";
import type { PerpMarketView, PerpPositionView, PerpsView } from "../strategies/types";
import { parseOrderBookDetails } from "./markets";

export const u = (n: number) => BigInt(Math.round(n * 1e6));
export const H4 = 14_400_000;
/** The last CLOSED candle in every synthetic series opens here (a 4 h boundary, 2026-09-29 16:00 UTC). */
export const T_LAST = 1_790_697_600_000;
/** "Now": one hour into the candle after the last closed one. */
export const NOW_SEC = (T_LAST + H4 + 3_600_000) / 1000;
const DAY = 86_400;

const DETAILS = parseOrderBookDetails(
  JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "orderBookDetails.perp.json"), "utf8")),
)!;

export type Candle = { t: number; o: bigint; h: bigint; l: bigint; c: bigint };

/** The base price per market, in its own price decimals (BTC 80,000.0 · ETH 2,681.00 · SOL 118.450). */
export const BASE: Record<string, bigint> = { "BTC-PERP": 800_000n, "ETH-PERP": 268_100n, "SOL-PERP": 118_450n, "TSLA-PERP": 35_356n };

/**
 * Closed 4 h candles ending with the one at T_LAST: each opens at the previous
 * close and spans ±range around its body. `closes` are the closes, oldest first.
 */
export function candles(closes: readonly bigint[], range: bigint, lastT = T_LAST): Candle[] {
  const n = closes.length;
  const out: Candle[] = [];
  let prev = closes[0] as bigint;
  for (let i = 0; i < n; i++) {
    const c = closes[i] as bigint;
    const o = prev;
    const hi = (o > c ? o : c) + range;
    const lo = (o < c ? o : c) - range;
    out.push({ t: lastT - (n - 1 - i) * H4, o, h: hi, l: lo, c });
    prev = c;
  }
  return out;
}

/**
 * 119 flat candles at the market's base, then a last close `move` away
 * (positive: up through the channel). `move` is in the market's own price
 * units; `btcRange` is the candles' half-range in BTC tenths, scaled.
 */
export function breakout(key: string, move: bigint, btcRange = 200n, n = 120): Candle[] {
  const base = BASE[key] as bigint;
  const closes = Array.from({ length: n - 1 }, () => base);
  closes.push(base + move);
  return candles(closes, scaleRange(key, btcRange));
}

/** A range in BTC units (tenths of a dollar) scaled to the market's own price. */
export function scaleRange(key: string, btcRange: bigint): bigint {
  const base = BASE[key] as bigint;
  const r = (btcRange * base) / 800_000n;
  return r > 0n ? r : 1n;
}

/** Eight settled hours of funding, all at `ppm` (positive: longs pay). */
export function funding(ppm: number, endSec = NOW_SEC - 1_800): { atSec: number; ppmPerHour: number }[] {
  const last = Math.floor(endSec / 3600) * 3600;
  return Array.from({ length: 8 }, (_, i) => ({ atSec: last - (7 - i) * 3600, ppmPerHour: ppm }));
}

export function marketView(key: PerpKey, over: Partial<PerpMarketView> = {}, maxLeverage = 2): PerpMarketView {
  const mk = perpMarketByKey(key)!;
  const spec = DETAILS.markets.get(mk.marketId)!.spec;
  const series = over.closed4h === undefined ? breakout(key, scaleRange(key, 5_000n)) : over.closed4h;
  const lastClose = series && series.length > 0 ? (series[series.length - 1] as Candle).c : (BASE[key] as bigint);
  const mark = over.markPrice ?? lastClose;
  const lt = leverageTarget(maxLeverage, spec);
  return {
    key,
    marketId: mk.marketId,
    cls: mk.cls,
    status: "active",
    spec,
    markPrice: mark,
    indexPrice: mark,
    fundingPpmPerHour: 10,
    lastFunding: null,
    effMinNotionalMicro: effectiveMinNotionalMicro(spec, mark),
    leverage: lt.leverage,
    imfBp: lt.imfBp,
    venueImfBp: lt.imfBp,
    venueMarginMode: "isolated",
    bestBid: null,
    bestAsk: null,
    observedAtSec: NOW_SEC - 2,
    closed4h: series,
    funding8h: funding(10),
    ...over,
  };
}

export function position(key: PerpKey, side: "long" | "short", over: Partial<PerpPositionView> = {}): PerpPositionView {
  const mk = perpMarketByKey(key)!;
  const spec = DETAILS.markets.get(mk.marketId)!.spec;
  const base = over.baseAmount ?? spec.minBaseAmount * 2n;
  const px = BASE[key] as bigint;
  return {
    key,
    marketId: mk.marketId,
    side,
    baseAmount: base,
    entryPrice: px,
    markPrice: px,
    notionalMicro: (base * px * 1_000_000n) / 10n ** BigInt(spec.sizeDecimals + spec.priceDecimals),
    unrealizedMicro: 0n,
    allocatedMarginMicro: u(10),
    imfBp: 5_000,
    liqPrice: null,
    stop: null,
    take: null,
    openedAtSec: NOW_SEC - 3_600,
    fundingMicro: 0n,
    ...over,
  };
}

export function view(over: Partial<PerpsView> = {}, markets: PerpKey[] = ["BTC-PERP", "ETH-PERP"]): PerpsView {
  return {
    mode: "paper",
    readAtSec: NOW_SEC - 1,
    account: { collateralMicro: 0n, freeCollateralMicro: 0n, accountValueMicro: 0n, inTransitMicro: 0n },
    positions: new Map(),
    markets: new Map(markets.map((k) => [k, marketView(k)])),
    unresolved: new Set(),
    headroom: { perTradeNotionalMicro: u(25), openNotionalLeftMicro: u(50), collateralLeftMicro: u(30), opensLeftToday: 4 },
    opensBlocked: null,
    lastExit: new Map(),
    lastEntryCandleT: new Map(),
    grantExpiresAtSec: NOW_SEC + 30 * DAY,
    ...over,
  };
}

/** The route's settings, as the resolved config carries them. */
export interface TestSettings {
  perpsEnabled: boolean;
  perpsDriver: "perp-trend" | "strategist" | "manual";
  perpsMarkets: PerpKey[];
  perpsMaxLeverage: number;
  perpsPerTradeUsdg: number;
  perpsMaxOpenNotionalUsdg: number;
  perpsMaxCollateralUsdg: number;
  perpsMaxOpensPerDay: number;
  perpsStopLossPct: number;
  perpsStopSlipBps: number;
  perpsTakeProfitPct: number;
  perpsLiqBufferPct: number;
  perpsMaxSlippageBps: number;
}
/** At their shipped defaults (docs/perps.md "Settings"), perps on. */
export const SETTINGS: Readonly<TestSettings> = Object.freeze<TestSettings>({
  perpsEnabled: true,
  perpsDriver: "perp-trend",
  perpsMarkets: ["BTC-PERP", "ETH-PERP"],
  perpsMaxLeverage: 2,
  perpsPerTradeUsdg: 25,
  perpsMaxOpenNotionalUsdg: 50,
  perpsMaxCollateralUsdg: 30,
  perpsMaxOpensPerDay: 4,
  perpsStopLossPct: 5,
  perpsStopSlipBps: 200,
  perpsTakeProfitPct: 0,
  perpsLiqBufferPct: 2,
  perpsMaxSlippageBps: 50,
});
export const settings = (over: Partial<TestSettings> = {}): TestSettings => ({ ...SETTINGS, perpsMarkets: [...SETTINGS.perpsMarkets], ...over });

export interface TestCtx {
  equityMicro: bigint | null;
  breakerIdle: boolean;
  breakerLimitBps?: number | null;
  energyEntriesLeft: boolean;
  opsHeadroom: boolean;
  spendHeadroomMicro: bigint | null;
  perTradeSealedMicro: bigint;
  nowSec: number;
}
export const CTX: Readonly<TestCtx> = Object.freeze<TestCtx>({
  equityMicro: u(1_000),
  breakerIdle: true,
  energyEntriesLeft: true,
  opsHeadroom: true,
  spendHeadroomMicro: u(100),
  perTradeSealedMicro: u(100),
  nowSec: NOW_SEC,
});
export const ctx = (over: Partial<TestCtx> = {}): TestCtx => ({ ...CTX, ...over });

/**
 * checkPolicy's verdict on `intent`, with the policy state built from the same
 * view and settings the producer read: the wall the draft will actually meet.
 */
export function policyVerdict(intent: TradeIntent, v: PerpsView, s: TestSettings = settings()): Verdict {
  const markets: PerpPolicyState["markets"] = new Map(
    [...v.markets.values()].map((m) => [
      m.marketId,
      {
        status: m.status,
        effMinNotionalMicro: m.effMinNotionalMicro,
        imfBpTarget: m.imfBp,
        venueImfBp: m.venueImfBp,
        venueMarginMode: m.venueMarginMode,
        mmfBp: m.spec.mmfBp,
        spec: m.spec,
      },
    ]),
  );
  const limits: AgentLimits = {
    perTradeUsdg: u(100),
    dailyUsdg: u(1_000),
    allowedTargets: [],
    allowedAssets: [],
    cashToken: "0x00000000000000000000000000000000000000dd",
    maxDrawdownBps: 1_500,
    expiresAt: NOW_SEC + 30 * DAY,
    maxOpsPerDay: 50,
  };
  const state: AgentState = {
    spentTodayUsdg: 0n,
    opsToday: 0,
    highWaterMarkUsdg: 0n,
    equityUsdg: 0n,
    nowSec: NOW_SEC,
    perp: {
      mode: "paper",
      refuseRule: null,
      settings: {
        markets: s.perpsMarkets,
        maxLeverage: s.perpsMaxLeverage,
        perTradeMicro: u(s.perpsPerTradeUsdg),
        maxOpenNotionalMicro: u(s.perpsMaxOpenNotionalUsdg),
        maxCollateralMicro: u(s.perpsMaxCollateralUsdg),
        maxOpensPerDay: s.perpsMaxOpensPerDay,
        stopLossBps: Math.round(s.perpsStopLossPct * 100),
        stopSlipBps: s.perpsStopSlipBps,
        liqBufferBps: Math.round(s.perpsLiqBufferPct * 100),
        maxSlippageBps: s.perpsMaxSlippageBps,
      },
      openNotionalMicro: 0n,
      committedCollateralMicro: 0n,
      opensToday: 0,
      positions: new Map([...v.positions.values()].map((p) => [p.marketId, { side: p.side, baseAmount: p.baseAmount }])),
      markets,
      unresolvedMarkets: new Set([...v.unresolved].map((k) => perpMarketByKey(k)!.marketId)),
      closeInFlightMarkets: new Set(),
      incident: false,
      entriesHalted: false,
      grantExpiresAtSec: v.grantExpiresAtSec,
      nowSec: NOW_SEC,
    },
  };
  return checkPolicy(intent, limits, state);
}
