import type { ChartResponse } from "../lib/perps-chart-data";

/** Historical candles only: missing or unreadable data must never turn into a zero quote. */
export function marketSummary(data: ChartResponse | null) {
  if (!data || data.state === "unreadable" || data.candles.state !== "ok" || data.candles.bars.length === 0) return null;
  const bars = data.candles.bars;
  const first = bars[0]!, last = bars[bars.length - 1]!;
  let high = -Infinity, low = Infinity;
  for (const bar of bars) {
    if (![bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0)) return null;
    high = Math.max(high, bar.high); low = Math.min(low, bar.low);
  }
  const changePct = (last.close / first.open - 1) * 100;
  if (!Number.isFinite(changePct)) return null;
  return { last: last.close, high, low, changePct };
}

export function marketPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value !== 0 && (Math.abs(value) < .000001 || Math.abs(value) >= 1_000_000_000)) return value.toExponential(3);
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 6 : 2 });
}
