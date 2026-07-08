"use client";

import { useEffect, useState } from "react";
import type { MarketData, MarketToken } from "@/lib/market";

function fmtPrice(p: number | null): string {
  if (p === null) return "—";
  return p >= 1000
    ? p.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtCompact(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function feedAge(updatedAt: number | null, now: number): string {
  if (updatedAt === null) return "no feed";
  const s = Math.max(0, now - updatedAt);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function status(t: MarketToken, now: number): { label: string; cls: string } {
  if (t.paused) return { label: "paused", cls: "st-paused" };
  if (t.priceUpdatedAt === null) return { label: "no feed", cls: "st-nofeed" };
  // Feeds run 24/5 — hours-stale on weekends is by design, not an outage.
  if (now - t.priceUpdatedAt > 2 * 3600) return { label: "stale 24/5", cls: "st-stale" };
  return { label: "live", cls: "st-live" };
}

export function MarketTable() {
  const [data, setData] = useState<MarketData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/market");
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as MarketData;
        if (alive) {
          setData(j);
          setError(false);
        }
      } catch {
        if (alive) setError(true);
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!data) {
    return (
      <div className="market-empty mono">
        {error ? "market data unavailable — retrying…" : "reading Sherwood…"}
      </div>
    );
  }

  const now = data.fetchedAt;

  return (
    <div className="market-wrap">
      <table className="market-table">
        <thead>
          <tr>
            <th>token</th>
            <th className="num">price</th>
            <th className="num">feed age</th>
            <th className="num">24h vol</th>
            <th className="num">holders</th>
            <th>rialto</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          {data.tokens.map((t) => {
            const st = status(t, now);
            return (
              <tr key={t.address}>
                <td>
                  <span className="tok">
                    {/* Blockscout/Robinhood CDN logo; hide broken images gracefully */}
                    <img
                      className="tok-logo"
                      src={t.logo}
                      alt=""
                      loading="lazy"
                      onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
                    />
                    <b className="mono">{t.symbol}</b>
                    <span className="tok-name">{t.name}</span>
                    {t.kind === "etf" && <span className="tok-etf mono">ETF</span>}
                  </span>
                </td>
                <td className="num mono">${fmtPrice(t.priceUsd)}</td>
                <td className="num mono dim">{feedAge(t.priceUpdatedAt, now)}</td>
                <td className="num mono">{fmtCompact(t.volume24hUsd)}</td>
                <td className="num mono dim">{fmtCompact(t.holders)}</td>
                <td className="mono dim">{t.rialtoLiquid ? "✓ liquid" : "—"}</td>
                <td>
                  <span className={`st ${st.cls}`}>{st.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
