import { useId, useState } from "react";
import type { ChartEntry, ChartResponse } from "../lib/perps-chart-data";
import { chartGeometry, chartPoint, chartX, chartY } from "./perps-chart-geometry";

const WINDOW_MS = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };
const STEP_MS = { "24h": 300_000, "7d": 3_600_000, "30d": 14_400_000 };
const priceText = (n: number) => n.toLocaleString("en-US", { maximumSignificantDigits: 7 });
export const executionTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", " UTC");
export const entryDescription = (entry: ChartEntry) =>
  `${entry.book === "paper" ? "Paper" : "Live"} ${entry.side} ${entry.kind} · ${entry.size} @ $${entry.priceExact} · ${executionTime(entry.timeMs)} · epoch ${entry.epoch} · ${entry.attribution}`;

/** Candles are mark prices; each marker has its own exact execution coordinates. */
export function PerpsChart({ data, freshIds = [], selectedId, onSelect }: {
  data: ChartResponse;
  freshIds?: readonly string[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const chartId = useId();
  const clipId = `${chartId}-clip`;
  const [hovered, setHovered] = useState<string | null>(null);
  const start = data.generatedAtMs - WINDOW_MS[data.window];
  const bars = data.candles.bars.filter((b) => b.timeMs >= start && b.timeMs <= data.generatedAtMs);
  const entries = data.entries.filter((e) => e.timeMs >= start && e.timeMs <= data.generatedAtMs);
  const g = chartGeometry(bars, entries, start, data.generatedAtMs);
  const selected = entries.find((e) => e.id === (hovered ?? selectedId));
  if (!g) return <div className="perps-chart-empty">
    <span className="perps-empty-grid" aria-hidden="true">⌁</span>
    <strong>{data.candles.state === "unreadable" ? "Market chart unavailable" : "Waiting for market history"}</strong>
    <p>{data.candles.state === "unreadable" ? "Lighter mark candles could not be read. Entry history is listed below when available." : "No mark candles or recorded entries are available in this window."}</p>
  </div>;
  const ticks = Array.from({ length: 5 }, (_, i) => g.priceMin + (g.priceMax - g.priceMin) * i / 4);
  const timeTicks = Array.from({ length: 5 }, (_, i) => start + WINDOW_MS[data.window] * i / 4);
  const candleWidth = Math.max(1, Math.min(10, (g.right - g.left) * STEP_MS[data.window] / WINDOW_MS[data.window] * 0.65));
  const last = bars.at(-1);
  const highlight = selected ? chartPoint(g, selected) : null;
  return <div className="perps-chart">
    <svg viewBox={`0 0 ${g.width} ${g.height}`} role="group" aria-labelledby={`${chartId}-title ${chartId}-desc`}>
      <title id={`${chartId}-title`}>{data.market} Lighter mark-price chart</title>
      <desc id={`${chartId}-desc`}>Candles show Lighter mark prices. Long and short entry markers show exact recorded execution prices and times. Use the entry history below to inspect every marker. All times UTC.</desc>
      <defs><clipPath id={clipId}><rect x={g.left - 8} y={g.top - 8} width={g.right - g.left + 16} height={g.bottom - g.top + 16} /></clipPath></defs>
      {ticks.map((p) => <g key={p} className="perps-chart-grid"><line x1={g.left} x2={g.right} y1={chartY(g, p)} y2={chartY(g, p)} /><text x={g.left - 12} y={chartY(g, p) + 4} textAnchor="end">{priceText(p)}</text></g>)}
      {timeTicks.map((t) => <g key={t} className="perps-chart-grid"><line x1={chartX(g, t)} x2={chartX(g, t)} y1={g.top} y2={g.bottom} /><text x={chartX(g, t)} y={g.bottom + 27} textAnchor={t === start ? "start" : t === data.generatedAtMs ? "end" : "middle"}>{new Date(t).toLocaleString("en-GB", { timeZone: "UTC", ...(data.window === "24h" ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "2-digit" }) })}</text></g>)}
      <g clipPath={`url(#${clipId})`}>
        {data.candles.gaps.map((gap) => <rect key={gap.startMs} className="perps-chart-gap" x={chartX(g, gap.startMs)} y={g.top} width={Math.max(0, chartX(g, gap.endMs) - chartX(g, gap.startMs))} height={g.bottom - g.top}><title>Missing mark-price candles from {executionTime(gap.startMs)} to {executionTime(gap.endMs)}</title></rect>)}
        {last && <line className="perps-chart-last" x1={g.left} x2={g.right} y1={chartY(g, last.close)} y2={chartY(g, last.close)} />}
        {bars.map((bar) => <g key={bar.timeMs} className={`perps-candle ${bar.close >= bar.open ? "is-up" : "is-down"}`}>
          <line x1={chartX(g, bar.timeMs)} x2={chartX(g, bar.timeMs)} y1={chartY(g, bar.high)} y2={chartY(g, bar.low)} />
          <rect x={chartX(g, bar.timeMs) - candleWidth / 2} y={Math.min(chartY(g, bar.open), chartY(g, bar.close))} width={candleWidth} height={Math.max(1, Math.abs(chartY(g, bar.close) - chartY(g, bar.open)))} />
        </g>)}
        {highlight && <g className="perps-chart-crosshair"><line x1={highlight.x} x2={highlight.x} y1={g.top} y2={g.bottom} /><line x1={g.left} x2={g.right} y1={highlight.y} y2={highlight.y} /></g>}
        {entries.map((entry) => {
          const p = chartPoint(g, entry);
          if (!p) return null;
          return <g key={entry.id} transform={`translate(${p.x} ${p.y})`} className={`perps-entry-marker is-${entry.side}${freshIds.includes(entry.id) ? " is-fresh" : ""}${selected?.id === entry.id ? " is-selected" : ""}`} role="button" tabIndex={0} aria-label={entryDescription(entry)} aria-pressed={selectedId === entry.id} onMouseEnter={() => setHovered(entry.id)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(entry.id)} onBlur={() => setHovered(null)} onClick={() => onSelect?.(entry.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect?.(entry.id); } }}>
            <title>{entryDescription(entry)}</title><circle className="perps-marker-hit" r={12} /><circle className="perps-marker-ring" r={9} />
            <path d={entry.side === "long" ? "M 0 -5 L 5 4 L -5 4 Z" : "M 0 5 L 5 -4 L -5 -4 Z"} />
          </g>;
        })}
      </g>
    </svg>
    <div className="perps-chart-caption">{selected ? <><span className={`perps-direction is-${selected.side}`}>{selected.side === "long" ? "↗" : "↘"} {selected.side}</span><span>{entryDescription(selected)}</span></> : <><span>LIGHTER · MARK PRICE</span><span>▲ Long entry · ▼ Short entry · UTC</span></>}</div>
  </div>;
}
