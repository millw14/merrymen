import { useEffect, useId, useRef, useState } from "react";
import { ChartNoAxesCombined } from "lucide-react";
import type { ChartResponse } from "../lib/perps-chart-data";
import { chartDayUtc, chartTimeUtc, fullDateTime, marketPrice } from "../lib/format";

/** Mark candles and execution prices have independent coordinates; missing bars remain gaps. */
export function PerpsChart({ data }: { data: ChartResponse }) {
  const clipId = useId();
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(810);
  const readable = data.state !== "unreadable" && data.candles.state !== "unreadable";
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => { const next = Math.floor(node.getBoundingClientRect().width); if (next > 0) setWidth(Math.max(300, next)); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [readable]);
  if (data.state === "unreadable" || data.candles.state === "unreadable") return <div className="perps-empty-state" role="status"><ChartNoAxesCombined size={28} aria-hidden="true"/><h3>Market history unavailable</h3><p>No price or trade is inferred.</p></div>;
  const bars = data.candles.bars;
  const duration = data.window === "24h" ? 86_400_000 : data.window === "7d" ? 604_800_000 : 2_592_000_000;
  const start = data.generatedAtMs - duration;
  const prices = [...bars.flatMap(bar => [bar.low, bar.high]), ...data.entries.map(entry => entry.price)];
  const hasPrices = prices.length > 0;
  const low = hasPrices ? Math.min(...prices) : 0, high = hasPrices ? Math.max(...prices) : 1;
  const padding = (high - low || high * .02 || 1) * .1;
  const lower = Math.max(0, low - padding), upper = high + padding;
  const range = upper - lower;
  const plotRight = width - 94;
  const x = (time: number) => 18 + (time - start) / duration * (plotRight - 18);
  const y = (price: number) => 314 - (price - lower) / range * 282;
  const last = bars[bars.length - 1];
  const candleCount = data.window === "24h" ? 288 : data.window === "7d" ? 168 : 180;
  const candleWidth = Math.max(.6, (plotRight - 18) / candleCount * .7);
  const timeLabel = data.window === "24h" ? chartTimeUtc : chartDayUtc;
  return <div ref={frame}>
    {!hasPrices ? <div className="perps-empty-state"><ChartNoAxesCombined size={28} aria-hidden="true"/><h3>No market history in this window</h3><p>No candles or recorded entries were reported.</p></div> : <svg className="perps-chart" viewBox={`0 0 ${width} 354`} role="img" aria-label={`${data.market} mark candles and ${data.entries.length} recorded entries; ${data.window}`}>
      <defs><clipPath id={clipId}><rect x="16" y="25" width={plotRight - 14} height="300"/></clipPath></defs>
      {(width < 500 ? [0, 2, 4] : [0, 1, 2, 3, 4]).map(tick => {
        const price = lower + range * tick / 4;
        const time = start + duration * tick / 4;
        return <g key={tick} className="perps-chart-grid"><line x1="18" x2={plotRight} y1={y(price)} y2={y(price)}/><text x={plotRight + 13} y={y(price) + 4}>{marketPrice(price)}</text><line x1={x(time)} x2={x(time)} y1="32" y2="314"/><text x={x(time)} y="342" textAnchor={tick === 0 ? "start" : tick === 4 ? "end" : "middle"}>{timeLabel(time)}</text></g>;
      })}
      <g clipPath={`url(#${clipId})`}>
        {bars.map(bar => <g key={bar.timeMs} className={bar.close >= bar.open ? "perps-candle-up" : "perps-candle-down"}><title>{new Date(bar.timeMs).toISOString()}: open {bar.open}, high {bar.high}, low {bar.low}, close {bar.close}</title><line x1={x(bar.timeMs)} x2={x(bar.timeMs)} y1={y(bar.high)} y2={y(bar.low)}/><rect x={x(bar.timeMs) - candleWidth / 2} y={Math.min(y(bar.open), y(bar.close))} width={candleWidth} height={Math.max(1, Math.abs(y(bar.open) - y(bar.close)))}/></g>)}
        {data.entries.map(entry => <circle key={entry.id} cx={x(entry.timeMs)} cy={y(entry.price)} r="3" className="perps-entry"><title>{entry.side} {entry.size} at {entry.priceExact} · {new Date(entry.timeMs).toISOString()}</title></circle>)}
        {last && <line className="perps-last-price" x1="18" x2={plotRight} y1={y(last.close)} y2={y(last.close)}/>}
      </g>
      {last && <g className="perps-price-label"><rect x={plotRight + 5} y={y(last.close) - 10} width="86" height="20" rx="3"/><text x={plotRight + 12} y={y(last.close) + 4}>{marketPrice(last.close)}</text></g>}
    </svg>}
    <div className="perps-chart-meta"><span>Lighter mark candles <span aria-hidden="true">·</span> UTC</span><span>{data.entries.length} recorded entries</span></div>
    {data.candles.stale && <p className="perps-notice" role="status">Market candles are stale; this is historical data.</p>}
    {data.candles.gaps.length > 0 && <p className="perps-chart-note">{data.candles.gaps.length} gaps in candle history. No prices are drawn through the gaps.</p>}
    <p className="perps-chart-note">As of {data.candles.asOfMs === null ? "not reported" : fullDateTime(data.candles.asOfMs)}. Window change uses the first and last available candles.</p>
    {data.unknownFills > 0 && <p className="perps-notice">{data.unknownFills} fills lack enough evidence to mark an entry.</p>}{data.truncated && <p className="perps-chart-note">Only the latest recorded fills are included.</p>}
    {data.entries.length > 0 && <details className="perps-chart-details"><summary>Exact recorded entries ({data.entries.length})</summary><p>Dots use each execution&apos;s exact time and price.</p><div className="perps-table-wrap"><table><thead><tr><th>Time</th><th>Side</th><th>Size</th><th>Execution price</th><th>Epoch</th></tr></thead><tbody>{data.entries.map(entry => <tr key={entry.id}><td><time dateTime={new Date(entry.timeMs).toISOString()} title={new Date(entry.timeMs).toISOString()}>{fullDateTime(entry.timeMs)}</time></td><td>{entry.side}</td><td>{entry.size}</td><td>{entry.priceExact}</td><td>{entry.epoch}</td></tr>)}</tbody></table></div></details>}
  </div>;
}
