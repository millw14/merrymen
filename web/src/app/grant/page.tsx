"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  clearGrant,
  grantSessionKey,
  loadGrant,
  type Grant,
  type GrantCaps,
} from "@/lib/session";

const DEFAULTS: GrantCaps = {
  perTradeUsdg: 50,
  dailyUsdg: 500,
  expiryDays: 14,
  maxDrawdownPct: 10,
  maxOpsPerDay: 48,
};

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function GrantPage() {
  const [caps, setCaps] = useState<GrantCaps>(DEFAULTS);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<Grant | null>(null);

  useEffect(() => {
    setGrant(loadGrant());
  }, []);

  const set = (k: keyof GrantCaps) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCaps((c) => ({ ...c, [k]: Number(e.target.value) }));

  async function onGrant() {
    setError(null);
    setStatus("starting…");
    try {
      const g = await grantSessionKey(caps, setStatus);
      setGrant(g);
      setStatus(null);
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand" style={{ color: "inherit", textDecoration: "none" }}>
          <span className="arrow">➳</span>
          <span>merrymen</span>
        </Link>
        <span className="chain-pill">
          <span className="dot" />
          testnet · 46630
        </span>
      </header>

      <main className="grant-shell">
        {!grant ? (
          <div className="grant-panel">
            <h1 className="grant-title">raise the permission wall</h1>
            <p className="grant-sub">
              Your agent gets a session key that the <b>account contract itself</b> constrains —
              these caps are enforced on-chain, not promises. One signature; revoke or let it
              expire any time.
            </p>

            <div className="grant-fields">
              <label className="field">
                <span className="field-label">max per trade</span>
                <span className="field-input">
                  <input type="number" min={1} value={caps.perTradeUsdg} onChange={set("perTradeUsdg")} />
                  <span className="field-unit">USDG</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">max per day</span>
                <span className="field-input">
                  <input type="number" min={1} value={caps.dailyUsdg} onChange={set("dailyUsdg")} />
                  <span className="field-unit">USDG</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">key expires in</span>
                <span className="field-input">
                  <input type="number" min={1} max={90} value={caps.expiryDays} onChange={set("expiryDays")} />
                  <span className="field-unit">days</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">max ops per day</span>
                <span className="field-input">
                  <input type="number" min={1} value={caps.maxOpsPerDay} onChange={set("maxOpsPerDay")} />
                  <span className="field-unit">ops</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">drawdown breaker</span>
                <span className="field-input">
                  <input type="number" min={1} max={50} value={caps.maxDrawdownPct} onChange={set("maxDrawdownPct")} />
                  <span className="field-unit">%</span>
                </span>
              </label>
            </div>

            <div className="grant-summary mono">
              this key may ONLY: approve USDG to Rialto router / Morpho vault (≤{" "}
              {caps.perTradeUsdg} USDG) · call the Rialto router · deposit ≤ {caps.dailyUsdg} USDG
              to the vault · withdraw from the vault · ≤ {caps.maxOpsPerDay} ops/day · dead in{" "}
              {caps.expiryDays}d regardless
            </div>

            <button className="grant-btn" onClick={onGrant} disabled={status !== null}>
              {status ?? "connect wallet & raise the wall"}
            </button>
            {error && <div className="grant-error mono">{error}</div>}

            <div className="grant-note">
              testnet demo: the session key stays in your browser so you can inspect it —
              production keys live in a TEE and never leave it. drawdown breaker is
              worker-enforced until the breaker contract ships.
            </div>
          </div>
        ) : (
          <div className="grant-panel">
            <h1 className="grant-title">the wall is up</h1>
            <p className="grant-sub">
              Grant signed. Nothing is deployed yet — the smart account materializes with the
              agent&apos;s first trade, and the caps below travel with every operation.
            </p>

            <div className="grant-result mono">
              <div>
                <span className="rk">smart account</span>
                <span className="rv">{short(grant.smartAccount)}</span>
              </div>
              <div>
                <span className="rk">owner</span>
                <span className="rv">{short(grant.owner)}</span>
              </div>
              <div>
                <span className="rk">session key</span>
                <span className="rv">{short(grant.sessionKeyAddress)}</span>
              </div>
              <div>
                <span className="rk">expires</span>
                <span className="rv">{new Date(grant.expiresAt * 1000).toLocaleString()}</span>
              </div>
            </div>

            <div className="caps" style={{ justifyContent: "center" }}>
              <span className="cap">max <b>{grant.caps.perTradeUsdg} USDG</b>/trade</span>
              <span className="cap"><b>{grant.caps.dailyUsdg} USDG</b>/day</span>
              <span className="cap"><b>{grant.caps.maxOpsPerDay}</b> ops/day</span>
              <span className="cap">breaker <b>{grant.caps.maxDrawdownPct}%</b></span>
            </div>

            <div className="grant-actions">
              <Link href="/" className="grant-btn" style={{ textAlign: "center", textDecoration: "none" }}>
                back to the band
              </Link>
              <button
                className="btn-kill"
                style={{ padding: "10px 16px" }}
                onClick={() => {
                  clearGrant();
                  setGrant(null);
                }}
              >
                discard grant
              </button>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
