"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { USDG_DECIMALS } from "@merrymen/core";
import type { AgentStatus } from "@/app/api/grants/route";
import { clearGrant } from "@/lib/session";
import { AgentCard } from "./AgentCard";
import { AGENTS } from "@/lib/mock";

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

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/grants");
        if (res.ok && alive) setStatus((await res.json()) as AgentStatus);
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
      </div>

      <div className="caps">
        <span className="cap">max <b>{g.caps.perTradeUsdg} USDG</b>/trade</span>
        <span className="cap"><b>{g.caps.dailyUsdg} USDG</b>/day</span>
        <span className="cap"><b>{g.caps.maxOpsPerDay}</b> ops/day</span>
        <span className="cap">breaker <b>{g.caps.maxDrawdownPct}%</b></span>
        <span className="cap">key dies in <b>{countdown(g.expiresAt)}</b></span>
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
