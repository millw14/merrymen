/** A price-only numeric vocabulary; participation and indicators like RSI cannot supply entries. */
import type { CoinMeasure } from "./evidence";
import { fmtPrice } from "./format";

export function coinPriceBrief(c: CoinMeasure): string {
  const t = c.tech;
  const values = [c.pool.priceUsd, t?.last, t?.ema20, t?.ema50, t?.vwap24h, t?.high24h, t?.low24h, t?.rangeHigh, t?.rangeLow,
    ...(t?.supports.map((x) => x.price) ?? []), ...(t?.resistances.map((x) => x.price) ?? [])];
  return [...new Set(values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0).map((v) => `$${fmtPrice(v)}`))].join(" ");
}

/** Compatibility for existing code-built briefs; extract labelled price values, never all numbers. */
export function labelledPriceBrief(brief: string): string {
  const number = "(?:\\d+(?:\\.\\d+)?)";
  const values: string[] = [];
  const labels = new RegExp(`\\b(?:price|ema\\s*20|ema\\s*50|(?:24h\\s+)?vwap|supports?(?: below)?|resistances?(?: above)?)\\s*[:=]?\\s*\\$?(${number})(?![\\d.%x])`, "giu");
  for (const match of brief.matchAll(labels)) values.push(`$${match[1]}`);
  for (const line of brief.split("\n")) {
    if (!/^\s*-?\s*(?:supports? below|resistances? above)\s*:/iu.test(line)) continue;
    const levels = line.replace(/\([^)]*\)/g, "").split(":").slice(1).join(":");
    for (const match of levels.matchAll(/(?:^|,)\s*\$?(\d+(?:\.\d+)?)(?![\d.%x])/gu)) values.push(`$${match[1]}`);
  }
  return [...new Set(values)].join(" ");
}
