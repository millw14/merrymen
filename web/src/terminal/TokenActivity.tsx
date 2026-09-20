import React from "react";
import type { PoolEvidence } from '../../../worker/src/venues/pool-evidence';
import type { DiscoveryRow } from '@/lib/read-discoveries';
import { coinPrice, compactUsd, money } from './live';

export function TokenActivity({ coin, evidence, loading }: { coin: DiscoveryRow | null; evidence: PoolEvidence | null; loading: boolean }) {
  if (loading) return <section className="token-activity" aria-busy="true"><h3>Market activity</h3><p>Loading pool activity…</p></section>;
  if (!coin) return <section className="token-activity"><h3>Market activity</h3><p>Pool activity is unavailable for this token.</p></section>;
  const trades = evidence?.trades;
  const stale = !trades?.observedAt || Date.now() - trades.observedAt > 120000;
  return <section className="token-activity">
    <header><h3>Market activity</h3><span>{coin.venue} · Indexed pool data</span></header>
    <div className="activity-facts">
      <div><span>24h volume</span><strong>{compactUsd(coin.volume24hUsd)}</strong></div>
      <div><span>{coin.onCurve ? 'Virtual / indexed reserve' : 'Indexed liquidity'}</span><strong>{compactUsd(coin.reserveUsd)}</strong></div>
      <div><span>24h buyers</span><strong>{coin.buyers24h?.toLocaleString() ?? '—'}</strong></div>
    </div>
    <p className="activity-note">{coin.onCurve ? 'Curve reserves can include virtual liquidity and are not an available exit quote.' : 'Indexed liquidity is not a guaranteed execution price.'}</p>
    <div className="activity-scroll"><table className="activity-windows"><caption>Reported trading windows</caption><thead><tr><th scope="col">Window</th><th scope="col">Volume</th><th scope="col">Buys</th><th scope="col">Sells</th></tr></thead><tbody>
      {(['m5', 'h1', 'h6', 'h24'] as const).map((w, i) => <tr key={w}><th scope="row">{['5m', '1h', '6h', '24h'][i]}</th><td>{compactUsd(coin.buckets[w].volumeUsd)}</td><td>{coin.buckets[w].buys?.toLocaleString() ?? '—'}</td><td>{coin.buckets[w].sells?.toLocaleString() ?? '—'}</td></tr>)}
    </tbody></table></div>
    <h4>Recent pool buys & sells</h4>
    <p className="activity-note">Public market trades, not your agent’s fills. Latest indexed sample; may omit trades.</p>
    {!trades || trades.failed ? <p role="status">Recent trades are temporarily unavailable.</p> : <>
      <p className="activity-note">{stale ? 'Older snapshot' : 'Snapshot'} · {trades.observedAt ? new Date(trades.observedAt).toLocaleString() : 'Time unavailable'}</p>
      {trades.data.length === 0 ? <p>No matching trades were returned in this sample.</p> : <div className="activity-scroll"><table><thead><tr><th scope="col">Side</th><th scope="col">Value</th><th scope="col">Token price</th><th scope="col">Time / transaction</th></tr></thead><tbody>
        {trades.data.slice(0, 12).map(t => <tr key={t.id}><td className={t.side === 'buy' ? 'activity-buy' : 'activity-sell'}>{t.side === 'buy' ? 'Buy' : 'Sell'}</td><td>{t.usd === null ? "—" : money(t.usd)}</td><td>{coinPrice(t.priceUsd)}</td><td><a href={`https://robinhoodchain.blockscout.com/tx/${t.tx}`} target="_blank" rel="noreferrer" aria-label={`View ${t.side} transaction ${t.tx}`}>{new Date(t.time * 1000).toLocaleTimeString()} ↗</a></td></tr>)}
      </tbody></table></div>}
    </>}
  </section>;
}
