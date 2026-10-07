import type { DeskPerpRow } from "./live";
import type { ChartBook } from "../lib/perps-chart-data";
import type { ChartBar, ChartEntry } from "../lib/perps-chart-data";

export interface ChartGeometry {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  timeStart: number;
  timeEnd: number;
  priceMin: number;
  priceMax: number;
}

/** Both axes use real venue coordinates. A fill is never snapped to a candle. */
export function chartGeometry(
  bars: readonly ChartBar[],
  entries: readonly ChartEntry[],
  timeStart: number,
  timeEnd: number,
  width = 1040,
  height = 400,
): ChartGeometry | null {
  if (!Number.isFinite(timeStart) || !Number.isFinite(timeEnd) || timeEnd <= timeStart) return null;
  const prices = [
    ...bars.flatMap((b) => [b.low, b.high]),
    ...entries.map((e) => e.price),
  ].filter((n) => Number.isFinite(n) && n > 0);
  if (prices.length === 0) return null;
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const pad = Math.max((high - low) * 0.07, high * 0.0005);
  return {
    // Leave room for the larger mobile axis labels without clipping price digits.
    width, height, left: 104, right: width - 24, top: 24, bottom: height - 47,
    timeStart, timeEnd,
    priceMin: Math.max(0, low - pad), priceMax: high + pad,
  };
}

export function chartX(g: ChartGeometry, timeMs: number): number {
  return g.left + (timeMs - g.timeStart) / (g.timeEnd - g.timeStart) * (g.right - g.left);
}

export function chartY(g: ChartGeometry, price: number): number {
  return g.bottom - (price - g.priceMin) / (g.priceMax - g.priceMin) * (g.bottom - g.top);
}

export function chartPoint(g: ChartGeometry, entry: Pick<ChartEntry, "timeMs" | "price">): { x: number; y: number } | null {
  if (!Number.isFinite(entry.timeMs) || entry.timeMs < g.timeStart || entry.timeMs > g.timeEnd || !Number.isFinite(entry.price) || entry.price <= 0) return null;
  return { x: chartX(g, entry.timeMs), y: chartY(g, entry.price) };
}

export interface PositionReference {
  id: string;
  kind: "entry" | "stop" | "liquidation";
  label: string;
  price: number;
  priceExact: string;
  side: DeskPerpRow["side"];
  book: ChartBook;
}

function positiveDecimal(value: string | null): number | null {
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Snapshot levels carry no opening timestamp and must never become executions. */
export function positionReferences(rows: readonly DeskPerpRow[], market: string, book: ChartBook): PositionReference[] {
  return rows.flatMap((row, index) => {
    if (row.market !== market || row.paper !== (book === "paper")) return [];
    const values = [
      ["entry", "Average entry", row.entry],
      ["stop", "Stop trigger", row.stopTrigger],
      ["liquidation", "Liquidation reference", row.liqPrice],
    ] as const;
    return values.flatMap(([kind, label, value]) => {
      const price = positiveDecimal(value);
      return price === null ? [] : [{ id: `${index}-${kind}`, kind, label, price, priceExact: value!, side: row.side, book }];
    });
  });
}

/** Off-scale risk levels are listed explicitly, never clamped onto a false price. */
export function referenceRange(g: ChartGeometry, price: number): "above" | "below" | "visible" {
  return price > g.priceMax ? "above" : price < g.priceMin ? "below" : "visible";
}
