import type { ChartResponse } from "../../../lib/perps-chart-data";
import type { DeskPerps } from "../../../terminal/live";

/** Fixed fictional session, imported only by the explicitly labelled design preview. */
const END = Date.UTC(2026, 9, 8, 0, 0);
const bars = Array.from({ length: 288 }, (_, i) => {
  const mid = 62_000 + i * 4.1 + Math.sin(i / 17) * 225 + Math.sin(i / 5) * 51;
  const open = Math.round(mid * 100) / 100;
  const close = Math.round((mid + Math.sin(i * 1.7) * 48 + 5) * 100) / 100;
  return { timeMs: END - (288 - i) * 300_000, open, close, high: Math.max(open, close) + 32, low: Math.min(open, close) - 24 };
});
const entryBar = bars[185]!;
const entryPrice = entryBar.close;
const mark = bars.at(-1)!.close;
export const RADAR_SAMPLE_CHART: ChartResponse = {
  state: "ok", market: "BTC-PERP", book: "paper", window: "24h", generatedAtMs: END,
  candles: { state: "ok", bars, gaps: [], stale: false, asOfMs: END }, unknownFills: 0, truncated: false,
  entries: [
    { id: "sample-open-1", timeMs: bars[49]!.timeMs + 72_000, price: bars[49]!.close, priceExact: bars[49]!.close.toFixed(2), size: "0.015", side: "short", book: "paper", epoch: 1, attribution: "agent", kind: "open" },
    { id: "sample-open-2", timeMs: entryBar.timeMs + 96_000, price: entryPrice, priceExact: entryPrice.toFixed(2), size: "0.025", side: "long", book: "paper", epoch: 1, attribution: "agent", kind: "open" },
    { id: "sample-add-2", timeMs: bars[212]!.timeMs + 181_000, price: bars[212]!.close, priceExact: bars[212]!.close.toFixed(2), size: "0.010", side: "long", book: "paper", epoch: 1, attribution: "agent", kind: "add" },
  ],
};
const average = (entryPrice * .025 + bars[212]!.close * .01) / .035;
export const RADAR_SAMPLE_POSITIONS: DeskPerps = {
  read: "ok", mode: "paper", book: "paper", paper: true, active: true, venueRead: true, venueReadAt: END,
  stale: false, atLighterUsd: 4_218.75, minLiqDistancePct: 31.1, stopsMissing: 0, incident: false, blocker: null,
  rows: [
    { market: "BTC-PERP", side: "long", paper: true, size: "0.035", entry: average.toFixed(2), mark: mark.toFixed(2), leverage: 2, marginUsd: average * .035 / 2, liqPrice: "41680.50", liqDistancePct: 34.1, unrealisedUsd: (mark - average) * .035, stopTrigger: (average * .985).toFixed(2), fundingUsd: -.17 },
    { market: "ETH-PERP", side: "short", paper: true, size: "0.45", entry: "2584.75", mark: "2557.30", leverage: 2, marginUsd: 581.57, liqPrice: "3369.20", liqDistancePct: 31.7, unrealisedUsd: 12.35, stopTrigger: "2636.45", fundingUsd: .08 },
  ],
};
