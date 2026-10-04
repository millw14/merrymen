/** Compare two public snapshots, preserving missing data and mismatched windows. */
import type { TgDeskThought } from "../telegram/tg-groups/types";
import { coinBrief, flowOf, latestCandle, type CoinMeasure } from "./evidence";
import { fmtUsd } from "./format";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function comparisonBrief(a: CoinMeasure, b: CoinMeasure): string {
  return `PUBLIC ASSET COMPARISON: two independently resolved coins on the same chain. Each flow window is labelled; liquidity is indexed, not an executable quote.\nFIRST ASSET:\n${coinBrief(a)}\nSECOND ASSET:\n${coinBrief(b)}\nCOMPARISON LIMITS: no private positions, news verification or contract audit; hourly history windows or observation times may differ, so do not invent matched historical returns or rank predicted profits.`;
}

export function comparisonFloor(a: CoinMeasure, b: CoinMeasure): TgDeskThought {
  if (a.token.toLowerCase() === b.token.toLowerCase()) return {
    read: "Both names resolve to the same token. There aren't two different assets to compare here.", stance: "neutral",
    watch: "Name a different coin or supply its contract for a second public snapshot.", invalidation: "Different tickers or pool names alone don't prove different assets.",
  };
  const trend = (c: CoinMeasure) => c.tech ? `${c.symbol} has ${c.tech.trend === "range" ? "sideways or unresolved structure" : `an hourly ${c.tech.trend}`}` : `${c.symbol}'s hourly trend is unavailable`;
  const parts = [`${trend(a)}; ${trend(b)}.`];
  if (a.tech && b.tech) {
    const strength = (c: CoinMeasure) => c.tech!.trend === "uptrend" ? 1 : c.tech!.trend === "downtrend" ? -1 : 0;
    const diff = strength(a) - strength(b);
    parts.push(diff === 0 ? "Neither has a clear structural advantage from hourly direction alone." : `${diff > 0 ? a.symbol : b.symbol} has the firmer hourly direction in these snapshots; that doesn't predict returns.`);
  } else parts.push("Without both hourly charts, I can't establish which has the stronger structure.");
  if (finite(a.pool.reserveUsd) && finite(b.pool.reserveUsd)) parts.push(`Indexed main-pool reserves are ${fmtUsd(a.pool.reserveUsd)} for ${a.symbol} and ${fmtUsd(b.pool.reserveUsd)} for ${b.symbol}; this isn't an executable-size comparison.`);
  else parts.push("Liquidity is incomplete for one asset, so their execution depth can't be compared.");
  if (a.pool.dex === "pons-v2" || b.pool.dex === "pons-v2") parts.push("A bonding curve's listed reserves include virtual liquidity.");
  const candleA = latestCandle(a);
  const candleB = latestCandle(b);
  const mismatched = Math.abs(a.observedAtMs - b.observedAtMs) > 60_000 || (a.tech && b.tech && a.tech.hours !== b.tech.hours)
    || !candleA || !candleB || candleA.openedUtc !== candleB.openedUtc;
  if (mismatched) parts.push("Candle freshness or history windows differ or are incomplete; this isn't a matched historical-performance comparison.");
  const flow = (c: CoinMeasure) => {
    const f = flowOf(c.pools, "h1");
    return finite(f.buys) && finite(f.sells) ? `${c.symbol}: ${f.buys > f.sells ? "buy transactions lead" : f.buys < f.sells ? "sell transactions lead" : "transaction counts are balanced"}` : `${c.symbol}: hourly transaction flow is incomplete`;
  };
  return {
    read: parts.join(" "), stance: "cautious",
    watch: `${flow(a)}; ${flow(b)}. Check whether participation persists and real depth supports execution.`,
    invalidation: "A change in structure or disappearing real liquidity can overturn this comparison; it doesn't establish contract safety.",
  };
}
