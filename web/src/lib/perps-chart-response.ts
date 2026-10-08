import type { ChartQuery, ChartResponse } from "./perps-chart-data";
const STEPS = { "24h": 300_000, "7d": 3_600_000, "30d": 14_400_000 };
const DURATIONS = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const integer = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const time = (x: unknown): x is number => integer(x) && x > 0 && x <= 8_640_000_000_000_000;
const price = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
const decimal = (x: unknown): x is string => typeof x === "string" && x.length <= 100 && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(x) && price(Number(x));

/** A malformed response is unknown, never a partial tape or an inferred book. */
export function readChartResponse(raw: unknown, q: ChartQuery): ChartResponse | null {
  if (!record(raw) || raw.market !== q.market || raw.book !== q.book || raw.window !== q.window ||
      !["ok", "unreadable", "not-configured"].includes(String(raw.state)) || !time(raw.generatedAtMs) ||
      !integer(raw.unknownFills) || typeof raw.truncated !== "boolean" || !Array.isArray(raw.entries) || raw.entries.length > 500 || !record(raw.candles)) return null;
  const end = raw.generatedAtMs, start = end - DURATIONS[q.window], step = STEPS[q.window];
  const ids = new Set<string>();
  let previousTime = -Infinity;
  for (const entry of raw.entries) {
    if (!record(entry) || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || entry.book !== q.book ||
        !time(entry.timeMs) || entry.timeMs < start || entry.timeMs > end || entry.timeMs < previousTime ||
        !price(entry.price) || !decimal(entry.priceExact) || Number(entry.priceExact) !== entry.price || !decimal(entry.size) ||
        (entry.side !== "long" && entry.side !== "short") || !["open", "add", "reverse"].includes(String(entry.kind)) ||
        !integer(entry.epoch) || entry.epoch < 1 || typeof entry.attribution !== "string" || !entry.attribution) return null;
    ids.add(entry.id); previousTime = entry.timeMs;
  }
  const candles = raw.candles;
  if (!["ok", "none", "unreadable"].includes(String(candles.state)) || typeof candles.stale !== "boolean" ||
      !Array.isArray(candles.bars) || candles.bars.length > 500 || !Array.isArray(candles.gaps)) return null;
  previousTime = -Infinity;
  for (const bar of candles.bars) {
    if (!record(bar) || !time(bar.timeMs) || bar.timeMs % step !== 0 || bar.timeMs < Math.floor(start / step) * step ||
        bar.timeMs + step > end || bar.timeMs <= previousTime || !price(bar.open) || !price(bar.high) || !price(bar.low) || !price(bar.close) ||
        bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) return null;
    previousTime = bar.timeMs;
  }
  for (const gap of candles.gaps) {
    if (!record(gap) || !time(gap.startMs) || !time(gap.endMs) || gap.startMs >= gap.endMs ||
        gap.startMs < Math.floor(start / step) * step || gap.endMs > end || gap.startMs % step || gap.endMs % step) return null;
  }
  if (candles.state === "ok") {
    if (!candles.bars.length || candles.asOfMs !== previousTime + step) return null;
  } else if (candles.bars.length || candles.gaps.length || candles.asOfMs !== null) return null;
  return raw as unknown as ChartResponse;
}
