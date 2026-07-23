"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { USDG_DECIMALS, explorerFor } from "@merrymen/core";
import type { AgentStatus } from "@/app/api/grants/route";
import type { FeedResponse } from "@/app/api/feed/route";
import { clearGrant } from "@/lib/session";
import { DemoBand } from "./DemoBand";
import { LogoMark } from "./Logo";

const DEMO_KEY = "merrymen.demo.v1";

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
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    setDemo(localStorage.getItem(DEMO_KEY) === "1");
  }, []);

  function setDemoMode(on: boolean) {
    if (on) localStorage.setItem(DEMO_KEY, "1");
    else localStorage.removeItem(DEMO_KEY);
    setDemo(on);
  }

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
    if (demo) return <DemoBand onExit={() => setDemoMode(false)} />;
    return (
      <div className="empty-state">
        <div className="empty-sigil"><LogoMark size={56} /></div>
        <div className="empty-title mono">Let&apos;s set up your trading agent</div>
        <p className="empty-sub">Three steps. It starts trading on paper right away — no money needed.</p>

        <ol className="start-steps">
          <li>
            <span className="start-n">1</span>
            <div>
              <b>Create your agent&apos;s wallet.</b> merrymen makes the keys and hands them to you —
              nothing to connect, no sign-up. You set the spending limits.
            </div>
          </li>
          <li>
            <span className="start-n">2</span>
            <div>
              <b>It starts trading on paper — instantly.</b> Real market prices, pretend money. Watch
              your agent work before risking a cent.
            </div>
          </li>
          <li>
            <span className="start-n">3</span>
            <div>
              <b>Go live when you&apos;re ready.</b> Add one key in Settings and the same agent trades
              for real — inside the exact same limits.
            </div>
          </li>
        </ol>

        <div className="empty-actions">
          <Link href="/grant" className="grant-btn empty-cta">
            Create my agent →
          </Link>
          <button className="demo-btn mono" onClick={() => setDemoMode(true)}>
            ⚡ or watch a 5-second demo first — nothing real
          </button>
        </div>
      </div>
    );
  }

  const g = status.grant;
  const now = Math.floor(Date.now() / 1000);
  const expired = now >= g.expiresAt;
  const workerAlive = status.workerAliveAt != null && now - status.workerAliveAt < 90;
  const state = expired ? "expired" : workerAlive ? "active" : "armed";
  const paper = status.mode === "paper";

  // In paper mode the on-chain balances are 0; the real book is the equity
  // ledger the worker writes each tick (cash/vault come straight from it).
  const lastEq = feed?.equity?.[feed.equity.length - 1];
  const eth = paper ? 0 : status.balances ? Number(formatUnits(BigInt(status.balances.ethWei), 18)) : 0;
  const cash = paper
    ? lastEq?.cash_usdg ?? 0
    : status.balances ? Number(formatUnits(BigInt(status.balances.cashUsdg), USDG_DECIMALS)) : 0;
  const vault = paper
    ? lastEq?.vault_usdg ?? 0
    : status.balances ? Number(formatUnits(BigInt(status.balances.vaultUsdg), USDG_DECIMALS)) : 0;

  // Testnet reality: the token registry is mainnet-only, so on-chain reads on
  // 46630 return 0 no matter how much faucet USDG you sent. A bare "0.00" reads
  // as lost funds — say what's actually happening instead.
  const testnet = g.chainId === 46630;
  const balancesUnread = testnet && !paper;
  // The paper book only exists once the worker has written its first equity row.
  const paperPending = paper && !lastEq;

  return (
    <div className={`agent-card real ${state === "active" ? "active" : state === "expired" ? "paused" : "armed"}`}>
      {status.exists && !workerAlive && (
        <div className="worker-down mono">
          ● worker not running — nothing trades until you run <b>merrymen start</b>
        </div>
      )}

      <div className="agent-head">
        <div className="agent-sigil">🏹</div>
        <div>
          <div className="agent-name">
            {feed?.agent?.name ?? "Robin"}
            {paper && <span className="paper-badge mono">📜 paper</span>}
          </div>
          <div className="agent-strategy">
            {feed?.agent
              ? `${feed.agent.strategy} · ${feed.agent.basket.join(" ")}`
              : "…"}{" "}
            · {g.chainId === 46630 ? "testnet" : "mainnet"} {g.chainId}
          </div>
        </div>
        <div className="agent-status">
          <span className="status-dot" />
          {state}
        </div>
      </div>

      {paper && (
        <div className="paper-note mono">
          fills simulate at live oracle prices · nothing signs · add a Pimlico key in{" "}
          <Link href="/settings">settings</Link> to trade live
        </div>
      )}

      {testnet && (
        <div className="paper-note mono">
          testnet = <b>practice</b>. Funds you send here are <b>never used and never shown</b> —
          merrymen only knows mainnet token addresses, so a funded testnet balance reads 0. Swaps
          only simulate. For real trades: switch to mainnet, add a bundler key in{" "}
          <Link href="/settings">settings</Link>, and fund the smart account.
        </div>
      )}

      <div className="real-balances mono">
        {!paper && !balancesUnread && (
          <span>
            <b>{eth.toFixed(4)}</b> ETH
          </span>
        )}
        {balancesUnread ? (
          <span className="dim">on-chain balances aren&apos;t read on testnet — see above</span>
        ) : paperPending ? (
          <span className="dim">paper book opens on the first tick</span>
        ) : (
          <>
            <span>
              <b>{cash.toFixed(2)}</b> {paper ? "USDG paper cash" : "USDG cash"}
            </span>
            <span>
              <b>{vault.toFixed(2)}</b> USDG in vault
            </span>
          </>
        )}
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
          href={`${explorerFor(g.chainId)}/address/${g.smartAccount}`}
          target="_blank"
          rel="noreferrer"
        >
          account {short(g.smartAccount)}
        </a>
        <a
          href={`${explorerFor(g.chainId)}/address/${g.sessionKeyAddress}`}
          target="_blank"
          rel="noreferrer"
        >
          session key {short(g.sessionKeyAddress)}
        </a>
        <a
          href={`${explorerFor(g.chainId)}/address/${g.owner}`}
          target="_blank"
          rel="noreferrer"
        >
          owner {short(g.owner)}
        </a>
      </div>

      {state === "armed" && (
        <div className="real-hint mono">
          wall is up — run <b>merrymen start</b>, add a bundler URL in{" "}
          <Link href="/settings">settings</Link>, and fund the account to go active
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
