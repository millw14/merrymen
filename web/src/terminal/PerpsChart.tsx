import type { ChartResponse } from "../lib/perps-chart-data";
import { fullDateTime } from "../lib/format";

/** Mark candles and execution prices have independent coordinates; missing bars remain gaps. */
export function PerpsChart({ data }: { data: ChartResponse }) {
  if (data.state === "unreadable" || data.candles.state === "unreadable") return <p role="status">Market history could not be read. No price or trade is inferred.</p>;
  const bars = data.candles.bars;
  const duration = data.window === "24h" ? 86_400_000 : data.window === "7d" ? 604_800_000 : 2_592_000_000;
  const start = data.generatedAtMs - duration;
  const prices = [...bars.flatMap(bar => [bar.low, bar.high]), ...data.entries.map(entry => entry.price)];
  const low = Math.min(...prices), high = Math.max(...prices);
  const range = high - low || high * .02 || 1;
  const x = (time: number) => 48 + (time - start) / duration * 680;
  const y = (price: number) => 220 - (price - low) / range * 180;
  return <div>
    <p>Lighter mark candles. Dots are recorded entry executions at their own exact time and price.</p>
    {prices.length === 0 ? <p>No candles or recorded entries in this window.</p> : <svg className="perps-chart" viewBox="0 0 760 260" role="img" aria-label={`${data.market} mark candles and ${data.entries.length} recorded entries; ${data.window}`}>
      <text x="48" y="20">{high.toPrecision(7)}</text><text x="48" y="245">{low.toPrecision(7)}</text>
      {bars.map(bar => <g key={bar.timeMs} className={bar.close >= bar.open ? "perps-candle-up" : "perps-candle-down"}><title>{new Date(bar.timeMs).toISOString()}: open {bar.open}, high {bar.high}, low {bar.low}, close {bar.close}</title><line x1={x(bar.timeMs)} x2={x(bar.timeMs)} y1={y(bar.high)} y2={y(bar.low)}/><rect x={x(bar.timeMs) - 1.5} y={Math.min(y(bar.open), y(bar.close))} width="3" height={Math.max(1, Math.abs(y(bar.open) - y(bar.close)))}/></g>)}
      {data.entries.map(entry => <circle key={entry.id} cx={x(entry.timeMs)} cy={y(entry.price)} r="3" className="perps-entry"><title>{entry.side} {entry.size} at {entry.priceExact} · {new Date(entry.timeMs).toISOString()}</title></circle>)}
    </svg>}
    {data.candles.stale && <p role="status">Market candles are stale; this is historical data.</p>}
    {data.candles.gaps.length > 0 && <p>{data.candles.gaps.length} gaps in candle history. No prices are drawn through the gaps.</p>}
    <p>Market data as of {data.candles.asOfMs === null ? "not reported" : fullDateTime(data.candles.asOfMs)}.</p>
    {data.unknownFills > 0 && <p>{data.unknownFills} fills lack enough evidence to mark an entry.</p>}{data.truncated && <p>Only the latest recorded fills are included.</p>}
    {data.entries.length > 0 && <details><summary>Exact recorded entries ({data.entries.length})</summary><div className="perps-table-wrap"><table><thead><tr><th>Time</th><th>Side</th><th>Size</th><th>Execution price</th><th>Epoch</th></tr></thead><tbody>{data.entries.map(entry => <tr key={entry.id}><td><time dateTime={new Date(entry.timeMs).toISOString()} title={new Date(entry.timeMs).toISOString()}>{fullDateTime(entry.timeMs)}</time></td><td>{entry.side}</td><td>{entry.size}</td><td>{entry.priceExact}</td><td>{entry.epoch}</td></tr>)}</tbody></table></div></details>}
  </div>;
}
