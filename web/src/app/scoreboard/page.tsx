"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogoMark } from "@/components/Logo";
import type { ScoreboardAgent, ScoreboardResponse } from "@/app/api/scoreboard/route";

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function EquityCurve({ points }: { points: number[] }) {
  if (points.length < 2) return <span className="dim mono">no history yet</span>;
  const w = 220;
  const h = 48;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const up = points[points.length - 1]! >= points[0]!;
  const path = points
    .map((v, i) => `${(i * step).toFixed(1)},${(h - 4 - ((v - min) / span) * (h - 8)).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline className={up ? "up" : "down"} points={path} />
    </svg>
  );
}

function AgentRow({ a }: { a: ScoreboardAgent }) {
  const pnl = a.pnl_usdg;
  const total = a.trades.landed + a.trades.rejected + a.trades.reverted;
  return (
    <div className="agent-card real">
      <div className="agent-head">
        <div className="agent-sigil">🏹</div>
        <div>
          <div className="agent-name">{a.name}</div>
          <div className="agent-strategy mono">
            {short(a.smart_account)} · chain {a.chain_id}
          </div>
        </div>
        <div className="agent-status">
          <span className="status-dot" />
          {a.status}
        </div>
      </div>

      <div className="real-balances mono" style={{ alignItems: "center" }}>
        <EquityCurve points={a.equity.map((p) => p.equity_usdg)} />
        <span>
          P&amp;L{" "}
          {pnl === null ? (
            <b className="dim">—</b>
          ) : (
            <b style={{ color: pnl >= 0 ? "var(--green)" : "var(--red)" }}>
              {pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)}
            </b>
          )}
        </span>
        <span>
          max dd <b>{(a.max_drawdown_bps / 100).toFixed(2)}%</b>
        </span>
        <span>
          hwm <b>{a.hwm_usdg.toFixed(2)}</b>
        </span>
        <span>
          fees accrued <b>{a.accrued_fee_usdg.toFixed(2)} USDG</b>
        </span>
      </div>

      <div className="caps">
        <span className="cap">
          <b>{a.trades.landed}</b>/{total} landed
        </span>
        <span className="cap">
          <b>{a.trades.rejected}</b> rejected by policy
        </span>
        <span className="cap">
          <b>{a.trades.reverted}</b> reverted
        </span>
        <span className="cap">
          volume <b>{a.trades.volume_usdg.toFixed(2)} USDG</b>
        </span>
        {a.caps.perTradeUsdg != null && (
          <span className="cap">
            wall: <b>{a.caps.perTradeUsdg}</b>/trade · <b>{a.caps.dailyUsdg}</b>/day ·{" "}
            <b>{a.caps.maxDrawdownPct}%</b> breaker
          </span>
        )}
      </div>
    </div>
  );
}

export default function ScoreboardPage() {
  const [data, setData] = useState<ScoreboardResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/scoreboard");
        if (alive && res.ok) setData((await res.json()) as ScoreboardResponse);
      } catch {
        /* keep last state */
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand" style={{ color: "inherit", textDecoration: "none" }}>
          <span className="arrow"><LogoMark size={20} /></span>
          <span>merrymen</span>
          <span className="tagline">the honest scoreboard</span>
        </Link>
        <Link href="/" className="connect-btn" style={{ textDecoration: "none" }}>
          back to the band
        </Link>
      </header>

      <main className="shell" style={{ gridTemplateColumns: "1fr" }}>
        <section className="agents">
          <div className="section-title">
            every agent · full history · rejections shown with the same weight as wins
          </div>

          {data === null && <div className="market-empty mono">tallying the ledger…</div>}
          {data !== null && data.agents.length === 0 && (
            <div className="empty-state">
              <div className="empty-sigil"><LogoMark size={56} /></div>
              <div className="empty-title mono">no agents have run yet</div>
              <p className="empty-sub">
                The scoreboard fills itself from the worker&apos;s ledger — deploy an agent and
                every trade, rejection, and fee lands here, unedited.
              </p>
            </div>
          )}
          <div className="agent-grid" style={{ gridTemplateColumns: "1fr" }}>
            {data?.agents.map((a) => <AgentRow key={a.smart_account} a={a} />)}
          </div>
        </section>
      </main>
    </>
  );
}
