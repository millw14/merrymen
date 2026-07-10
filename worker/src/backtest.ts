/**
 * Backtest-lite — run a REAL strategy through the REAL policy layer over a
 * price series. Not a market simulator: fills are naive (price × size with a
 * flat cost in bps), there is no depth, no queue, no MEV. What it IS good for:
 * proving a strategy's decision logic and the policy wall behave sanely over
 * time — entries/exits fire when they should, caps bind, the breaker trips.
 *
 * The same steadyBasketTick/weekendGapTick/checkPolicy code that trades real
 * money runs here — no forked logic to drift out of sync.
 */

import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";
import type { Holding, Snapshot, Strategy } from "./strategies/types";

/** One bar of the input series. Prices in USD (8dp bigint), per symbol. */
export interface Bar {
  tSec: number;
  /** symbol → price8; a missing symbol means no feed this bar. */
  prices: Map<string, bigint>;
  /** Symbols whose underlying market is closed at this bar. */
  staleSymbols?: Set<string>;
}

export interface BacktestConfig {
  strategy: Strategy;
  limits: AgentLimits;
  /** symbol → token, the tradable universe (must match the strategy's). */
  legs: ReadonlyMap<string, `0x${string}`>;
  initialCashUsdg: bigint;
  /** Flat execution cost applied to every swap, in bps of notional. */
  executionCostBps?: number;
  /** Simple vault APY in bps applied to vault balance over elapsed time. */
  vaultApyBps?: number;
}

export interface BacktestResult {
  finalEquityUsdg: bigint;
  pnlUsdg: bigint;
  maxDrawdownBps: number;
  equitySeries: { tSec: number; equityUsdg: bigint }[];
  executed: number;
  rejected: { rule: string; count: number }[];
}

const ONE = 10n ** 18n;
const YEAR_SEC = 365n * 86_400n;

/** shares(18dp) valued at price8 → USDG 6dp. */
function valueUsdg(shares: bigint, price8: bigint): bigint {
  return (shares * price8) / 10n ** 20n;
}

/** USDG 6dp → shares(18dp) at price8. */
function sharesFor(usdg: bigint, price8: bigint): bigint {
  return price8 > 0n ? (usdg * 10n ** 20n) / price8 : 0n;
}

export async function runBacktest(cfg: BacktestConfig, bars: readonly Bar[]): Promise<BacktestResult> {
  const costBps = BigInt(cfg.executionCostBps ?? 30);
  const apyBps = BigInt(cfg.vaultApyBps ?? 0);
  const tokenToSymbol = new Map([...cfg.legs.entries()].map(([s, t]) => [t.toLowerCase(), s]));

  let cash = cfg.initialCashUsdg;
  let vault = 0n;
  const shares = new Map<string, bigint>(); // symbol → raw 18dp
  let hwm = 0n;
  let spentToday = 0n; // simplification: no daily reset within a run shorter than 24h bars
  let ops = 0;
  let peak = 0n;
  let maxDrawdownBps = 0;
  let executed = 0;
  const rejectCounts = new Map<string, number>();
  const equitySeries: { tSec: number; equityUsdg: bigint }[] = [];
  let prevT: number | null = null;

  for (const bar of bars) {
    // Vault accrues simple interest over elapsed time.
    if (prevT !== null && apyBps > 0n && vault > 0n) {
      vault += (vault * apyBps * BigInt(bar.tSec - prevT)) / (10_000n * YEAR_SEC);
    }
    prevT = bar.tSec;

    const stale = bar.staleSymbols ?? new Set<string>();
    const holdings = new Map<string, Holding>();
    let positionsUsdg = 0n;
    for (const [symbol, raw] of shares) {
      if (raw === 0n) continue;
      const price = bar.prices.get(symbol) ?? 0n;
      const v = valueUsdg(raw, price);
      positionsUsdg += v;
      holdings.set(symbol, {
        token: cfg.legs.get(symbol)!,
        rawBalance: raw,
        valueUsdg: v,
        priceStale: stale.has(symbol),
      });
    }

    const equity = cash + vault + positionsUsdg;
    hwm = equity > hwm ? equity : hwm;
    peak = equity > peak ? equity : peak;
    if (peak > 0n && equity < peak) {
      const dd = Number(((peak - equity) * 10_000n) / peak);
      if (dd > maxDrawdownBps) maxDrawdownBps = dd;
    }
    equitySeries.push({ tSec: bar.tSec, equityUsdg: equity });

    const snap: Snapshot = {
      cashUsdg: cash,
      vaultUsdg: vault,
      holdings,
      prices: new Map(
        [...bar.prices.entries()].map(([s, p]) => [s, { price8: p, stale: stale.has(s) }]),
      ),
      pausedTokens: new Set(),
      staleFeeds: stale,
      sequencerUp: true,
    };

    const intents = await cfg.strategy.tick(snap);
    for (const intent of intents) {
      const state: AgentState = {
        spentTodayUsdg: spentToday,
        opsToday: ops,
        highWaterMarkUsdg: hwm,
        equityUsdg: equity,
        nowSec: bar.tSec,
      };
      const verdict = checkPolicy(intent, cfg.limits, state);
      if (!verdict.ok) {
        rejectCounts.set(verdict.rule, (rejectCounts.get(verdict.rule) ?? 0) + 1);
        continue;
      }
      applyFill(intent);
      ops += 1;
      executed += 1;
      if (intent.kind !== "vault-withdraw") {
        spentToday += intent.kind === "swap" ? intent.notionalUsdg : intent.amountUsdg;
      }
    }

    function applyFill(intent: TradeIntent) {
      if (intent.kind !== "swap") {
        if (intent.kind === "vault-deposit") {
          const amt = intent.amountUsdg > cash ? cash : intent.amountUsdg;
          cash -= amt;
          vault += amt;
        } else {
          const amt = intent.amountUsdg > vault ? vault : intent.amountUsdg;
          vault -= amt;
          cash += amt;
        }
        return;
      }
      const buySymbol = tokenToSymbol.get(intent.buyToken.toLowerCase());
      const sellSymbol = tokenToSymbol.get(intent.sellToken.toLowerCase());
      if (buySymbol) {
        // USDG → stock
        const price = bar.prices.get(buySymbol);
        if (!price || price === 0n || intent.sellAmountRaw > cash) return;
        const spend = intent.sellAmountRaw;
        const afterCost = (spend * (10_000n - costBps)) / 10_000n;
        cash -= spend;
        shares.set(buySymbol, (shares.get(buySymbol) ?? 0n) + sharesFor(afterCost, price));
      } else if (sellSymbol) {
        // stock → USDG
        const price = bar.prices.get(sellSymbol);
        const held = shares.get(sellSymbol) ?? 0n;
        if (!price || price === 0n || held === 0n) return;
        const raw = intent.sellAmountRaw > held ? held : intent.sellAmountRaw;
        const gross = valueUsdg(raw, price);
        cash += (gross * (10_000n - costBps)) / 10_000n;
        shares.set(sellSymbol, held - raw);
      }
    }
  }

  const last = equitySeries[equitySeries.length - 1];
  const finalEquity = last ? last.equityUsdg : cfg.initialCashUsdg;
  return {
    finalEquityUsdg: finalEquity,
    pnlUsdg: finalEquity - cfg.initialCashUsdg,
    maxDrawdownBps,
    equitySeries,
    executed,
    rejected: [...rejectCounts.entries()].map(([rule, count]) => ({ rule, count })),
  };
}

export { ONE };
