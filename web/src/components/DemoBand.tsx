"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { MarketData } from "@/lib/market";

/**
 * The 5-second demo — what the dashboard looks like with a band riding.
 * Entirely client-side make-believe on top of REAL live Chainlink prices:
 * nothing is signed, nothing touches ~/.merrymen, nothing is written anywhere
 * (the flag lives in localStorage). Every surface is stamped DEMO so this can
 * never be mistaken for the honest ledger.
 */

// Match the real default basket (v3-tradeable) so the demo mirrors what a fresh
// agent actually trades.
const DEMO_SYMBOLS = ["QQQ", "NVDA", "TSLA"] as const;
const START_EQUITY = 500;

interface DemoFill {
  id: number;
  side: "buy" | "sell";
  symbol: string;
  usdg: number;
  price: number | null;
  note: string;
}

const NOTES = [
  "passed the policy wall · simulated first",
  "quote met minimum-out · loosed",
  "within per-trade cap · landed",
  "DCA tick · basket rebalanced",
  "strategist proposed · code disposed",
];

export function DemoBand({ onExit }: { onExit: () => void }) {
  const [market, setMarket] = useState<MarketData | null>(null);
  const [fills, setFills] = useState<DemoFill[]>([]);
  const [equity, setEquity] = useState<number[]>([START_EQUITY]);
  const nextId = useRef(1);

  // Real prices, so the demo shows the actual market the band would ride.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/market");
        if (alive && r.ok) setMarket((await r.json()) as MarketData);
      } catch {
        /* demo works without prices too */
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // A simulated fill every ~2.5s, equity drifting with it.
  useEffect(() => {
    const tick = () => {
      const symbol = DEMO_SYMBOLS[Math.floor(Math.random() * DEMO_SYMBOLS.length)]!;
      const side: "buy" | "sell" = Math.random() < 0.62 ? "buy" : "sell";
      const usdg = Math.round((5 + Math.random() * 20) * 100) / 100;
      const price = market?.tokens.find((t) => t.symbol === symbol)?.priceUsd ?? null;
      const note = NOTES[Math.floor(Math.random() * NOTES.length)]!;
      setFills((f) => [{ id: nextId.current++, side, symbol, usdg, price, note }, ...f].slice(0, 6));
      setEquity((e) => {
        const drift = (Math.random() - 0.44) * 1.6; // gentle up-drift, honest wobble
        return [...e, Math.max(0, e[e.length - 1]! + drift)].slice(-40);
      });
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => clearInterval(id);
  }, [market]);

  const delta = equity[equity.length - 1]! - equity[0]!;
  const positions = DEMO_SYMBOLS.map((s) => ({
    symbol: s,
    price: market?.tokens.find((t) => t.symbol === s)?.priceUsd ?? null,
  }));

  return (
    <div className="agent-card real active demo-card">
      <div className="demo-banner mono">
        DEMO — simulated fills on live Chainlink prices. Nothing is real, nothing is signed,
        nothing is stored.
      </div>

      <div className="agent-head">
        <div className="agent-sigil">🏹</div>
        <div>
          <div className="agent-name">Will Scarlet <span className="demo-tag mono">demo</span></div>
          <div className="agent-strategy">steady-basket · AAPL MSFT QQQ · pretend-net</div>
        </div>
        <div className="agent-status">
          <span className="status-dot" />
          riding
        </div>
      </div>

      <div className="real-balances mono">
        <span><b>{(START_EQUITY - equity[equity.length - 1]! * 0.2).toFixed(2)}</b> USDG cash</span>
        <span><b>{(equity[equity.length - 1]! * 0.2).toFixed(2)}</b> USDG deployed</span>
        <span style={{ marginLeft: "auto" }}>
          <b style={{ color: delta >= 0 ? "var(--green)" : "var(--red)" }}>
            {delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)}
          </b>{" "}
          <span className="dim">since you opened the demo</span>
        </span>
      </div>

      <div className="positions mono">
        {positions.map((p) => (
          <span key={p.symbol} className="position">
            <b>{p.symbol}</b>
            <span className="dim"> {p.price ? `$${p.price.toFixed(2)} live` : "px …"}</span>
          </span>
        ))}
      </div>

      <div className="demo-fills mono">
        {fills.map((f) => (
          <div key={f.id} className="demo-fill">
            <span className={f.side === "buy" ? "up" : "down"} style={{ color: f.side === "buy" ? "var(--green)" : "var(--red)" }}>
              {f.side}
            </span>{" "}
            <b>{f.usdg.toFixed(2)} USDG</b> {f.symbol}
            {f.price ? <span className="dim"> @ ${f.price.toFixed(2)}</span> : null}
            <span className="dim"> · {f.note}</span>
          </div>
        ))}
      </div>

      <div className="demo-actions">
        <Link href="/grant" className="grant-btn demo-cta">
          this, but real — create your agent wallet
        </Link>
        <button className="btn-kill" onClick={onExit}>
          end demo
        </button>
      </div>
    </div>
  );
}
