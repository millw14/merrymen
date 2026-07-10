"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { USDG_DECIMALS } from "@merrymen/core";
import type { AgentStatus } from "@/app/api/grants/route";
import type { FeedResponse } from "@/app/api/feed/route";
import { clearGrant } from "@/lib/session";
import { AgentCard } from "./AgentCard";
import { AGENTS } from "@/lib/mock";

function EquitySparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 96;
  const h = 28;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const up = points[points.length - 1]! >= points[0]!;
  const path = points
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline className={up ? "up" : "down"} points={path} />
    </svg>
  );
}

function countdown(expiresAt: number): string {
  const s = expiresAt - Math.floor(Date.now() / 1000);
  if (s <= 0) return "expired";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function BandSection() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [feed, setFeed] = useState<FeedResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [gRes, fRes] = await Promise.all([fetch("/api/grants"), fetch("/api/feed")]);
        if (!alive) return;
        if (gRes.ok) setStatus((await gRes.json()) as AgentStatus);
        if (fRes.ok) setFeed((await fRes.json()) as FeedResponse);
      } catch {
        // dashboard stays on last known state
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function discard() {
    await fetch("/api/grants", { method: "DELETE" }).catch(() => {});
    clearGrant();
    setStatus({ exists: false });
  }

  if (status === null) {
    return <div className="market-empty mono">rallying the band…</div>;
  }

  if (!status.exists || !status.grant) {
    return (
      <>
        <div className="empty-state">
          <div className="empty-sigil">➳</div>
          <div className="empty-title mono">no agents yet</div>
          <p className="empty-sub">
            Raise the permission wall to deploy your first agent — one signature,
            hard on-chain caps, revocable any time.
          </p>
          <Link href="/grant" className="grant-btn empty-cta">
            raise the wall
          </Link>
        </div>

        <div className="demo-wrap">
          <div className="demo-banner mono">▼ demo data — what a running band looks like. none of this is real.</div>
          <div className="agent-grid demo-cards">
            {AGENTS.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>
        </div>
      </>
    );
  }

  const g = status.grant;
  const now = Math.floor(Date.now() / 1000);
  const expired = now >= g.expiresAt;
  const workerAlive = status.workerAliveAt != null && now - status.workerAliveAt < 90;
  const state = expired ? "expired" : workerAlive ? "active" : "armed";

  const eth = status.balances ? Number(formatUnits(BigInt(status.balances.ethWei), 18)) : 0;
  const cash = status.balances ? Number(formatUnits(BigInt(status.balances.cashUsdg), USDG_DECIMALS)) : 0;
  const vault = status.balances ? Number(formatUnits(BigInt(status.balances.vaultUsdg), USDG_DECIMALS)) : 0;

  return (
    <div className={`agent-card real ${state === "active" ? "active" : state === "expired" ? "paused" : "armed"}`}>
      <div className="agent-head">
        <div className="agent-sigil">🏹</div>
        <div>
          <div className="agent-name">Robin</div>
          <div className="agent-strategy">steady basket DCA · AAPL MSFT QQQ · chain {g.chainId}</div>
        </div>
        <div className="agent-status">
          <span className="status-dot" />
          {state}
        </div>
      </div>

      <div className="real-balances mono">
        <span>
          <b>{eth.toFixed(4)}</b> ETH
        </span>
        <span>
          <b>{cash.toFixed(2)}</b> USDG cash
        </span>
        <span>
          <b>{vault.toFixed(2)}</b> USDG in vault
        </span>
        {(() => {
          const series = (feed?.equity ?? []).map((p) => p.equity_usdg);
          if (series.length < 2) {
            return <span className="dim">P&amp;L — no history yet</span>;
          }
          const delta = series[series.length - 1]! - series[0]!;
          return (
            <span style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
              <b className={delta >= 0 ? "up" : "down"} style={{ color: delta >= 0 ? "var(--green)" : "var(--red)" }}>
                {delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)}
              </b>
              <EquitySparkline points={series} />
            </span>
          );
        })()}
      </div>

      {(feed?.positions ?? []).length > 0 && (
        <div className="positions mono">
          {feed!.positions.map((p) => {
            const shares =
              (Number(BigInt(p.raw_balance) / 10n ** 9n) / 1e9) *
              (Number(BigInt(p.ui_multiplier) / 10n ** 9n) / 1e9);
            return (
              <span key={p.symbol} className="position">
                <b>{shares.toFixed(4)}</b> {p.symbol}
                <span className="dim">
                  {" "}
                  ${p.value_usdg.toFixed(2)}
                  {p.price_stale ? " · px 24/5" : ""}
                </span>
              </span>
            );
          })}
        </div>
      )}

      <div className="caps">
        <span className="cap">max <b>{g.caps.perTradeUsdg} USDG</b>/trade</span>
        <span className="cap"><b>{g.caps.dailyUsdg} USDG</b>/day</span>
        <span className="cap"><b>{g.caps.maxOpsPerDay}</b> ops/day</span>
        <span className="cap">breaker <b>{g.caps.maxDrawdownPct}%</b></span>
        <span className="cap">key dies in <b>{countdown(g.expiresAt)}</b></span>
        {feed?.financials && feed.financials.hwm_usdg > 0 && (
          <span className="cap">
            hwm <b>{feed.financials.hwm_usdg.toFixed(2)}</b> · fee accrued{" "}
            <b>{feed.financials.accrued_fee_usdg.toFixed(2)} USDG</b>
          </span>
        )}
      </div>

      <div className="real-meta mono">
        <a
          href={`https://explorer.testnet.chain.robinhood.com/address/${g.smartAccount}`}
          target="_blank"
          rel="noreferrer"
        >
          account {short(g.smartAccount)}
        </a>
        <span>session key {short(g.sessionKeyAddress)}</span>
        <span>owner {short(g.owner)}</span>
      </div>

      {state === "armed" && (
        <div className="real-hint mono">
          wall is up — start the worker (npm run dev in worker/) and fund the account to go active
        </div>
      )}

      <div className="agent-actions">
        <button className="btn-kill" onClick={discard}>
          discard grant (local)
        </button>
      </div>
    </div>
  );
}
