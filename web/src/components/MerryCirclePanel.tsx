"use client";

import { useEffect, useState } from "react";

/**
 * The Merry Circle — your $MERRYMEN holder tier, shown live. The material perk is
 * a lower platform fee (applied in the worker's real accrual); the rest is a
 * badge, governance weight, and the bonus strategy pack. Utility only — no price
 * or return language anywhere. merrymen stays free whether you hold or not.
 */

interface TierView {
  id: string;
  name: string;
  emoji: string;
  minTokens: number;
  feeDiscountBps: number;
  voteWeight: number;
  bonusStrategies: boolean;
  perks: string[];
  effectiveFeeBps?: number;
}
interface CircleData {
  configured: boolean;
  holderAddress?: string;
  balance?: number;
  baseFeeBps: number;
  effectiveFeeBps?: number;
  tier?: TierView;
  next?: (TierView & { tokensToGo: number }) | null;
  error?: string;
  token: { symbol: string; address: string; chainId: number; explorer: string };
  tiers: TierView[];
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
const num = (n: number) => n.toLocaleString("en-US");

export function MerryCirclePanel() {
  const [data, setData] = useState<CircleData | null>(null);
  const [addr, setAddr] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function load() {
    try {
      const r = await fetch("/api/circle");
      if (r.ok) setData((await r.json()) as CircleData);
    } catch {
      /* keep last */
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save(value: string) {
    setErr(null);
    if (value && !/^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
      setErr("that isn't a valid address (0x + 40 hex).");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holderAddress: value.trim() }),
      });
      if (!r.ok) {
        const j = (await r.json()) as { errors?: string[] };
        setErr(j.errors?.[0] ?? "couldn't save.");
      } else {
        setEditing(false);
        setAddr("");
        await load();
      }
    } catch {
      setErr("couldn't reach settings.");
    }
    setSaving(false);
  }

  if (!data) return null;

  const tier = data.tier;
  const isHolder = data.configured && tier && tier.id !== "outsider";

  return (
    <div className="panel circle-panel">
      <div className="section-title">the merry circle</div>

      {isHolder ? (
        <>
          <div className="circle-badge">
            <span className="circle-emoji">{tier!.emoji}</span>
            <div className="circle-badge-txt">
              <span className="circle-tier-name">{tier!.name}</span>
              <span className="circle-tier-sub mono">
                {num(data.balance ?? 0)} ${data.token.symbol}
              </span>
            </div>
          </div>

          <div className="circle-fee">
            <span>
              your platform fee: <b>{pct(data.effectiveFeeBps ?? data.baseFeeBps)}</b>
            </span>
            {tier!.feeDiscountBps > 0 && (
              <span className="circle-save">
                {pct(tier!.feeDiscountBps)} off <span className="mono">(base {pct(data.baseFeeBps)})</span>
              </span>
            )}
          </div>

          <ul className="circle-perks">
            {tier!.perks.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>

          {data.next && (
            <p className="circle-next">
              Hold <b>{num(data.next.tokensToGo)}</b> more ${data.token.symbol} to reach{" "}
              {data.next.emoji} <b>{data.next.name}</b> — {pct(data.next.feeDiscountBps)} off.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="circle-sub">
            Hold <b>${data.token.symbol}</b> to join the Circle: a lower platform fee, a badge,
            governance weight, and bonus strategies. merrymen stays free either way — the token buys
            perks, never the product.
          </p>

          {data.configured && data.error ? (
            <p className="circle-err mono">couldn&apos;t read your balance — {data.error}</p>
          ) : (
            data.configured && (
              <p className="circle-sub">
                No ${data.token.symbol} at{" "}
                <span className="mono">
                  {data.holderAddress?.slice(0, 6)}…{data.holderAddress?.slice(-4)}
                </span>{" "}
                yet — you&apos;re on the standard <b>{pct(data.baseFeeBps)}</b> fee.
              </p>
            )
          )}
        </>
      )}

      {/* tier ladder — always visible so everyone sees the path */}
      <div className="circle-ladder">
        {data.tiers
          .filter((t) => t.id !== "outsider")
          .map((t) => (
            <div key={t.id} className={`circle-rung ${tier?.id === t.id ? "here" : ""}`}>
              <span className="circle-rung-name">
                {t.emoji} {t.name}
              </span>
              <span className="circle-rung-req mono">
                {num(t.minTokens)}+ · {pct(t.feeDiscountBps)} off
              </span>
            </div>
          ))}
      </div>

      {/* set / change holder wallet */}
      {editing || !data.configured ? (
        <div className="circle-set">
          <input
            className="circle-input mono"
            type="text"
            placeholder="your $MERRYMEN wallet (0x…)"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            autoComplete="off"
          />
          <div className="circle-set-actions">
            <button className="circle-btn go" onClick={() => void save(addr)} disabled={saving}>
              {saving ? "saving…" : "check my tier"}
            </button>
            {data.configured && (
              <button className="circle-btn" onClick={() => void save("")} disabled={saving}>
                clear
              </button>
            )}
          </div>
        </div>
      ) : (
        <button className="circle-btn" onClick={() => setEditing(true)}>
          change holder wallet
        </button>
      )}
      {err && <p className="circle-err mono">{err}</p>}

      <p className="circle-note">
        Read-only — merrymen only checks this wallet&apos;s balance, never spends from it.{" "}
        <a href={data.token.explorer} target="_blank" rel="noreferrer">
          ${data.token.symbol} ↗
        </a>{" "}
        ·{" "}
        <a href="https://merrymen.dev/token" target="_blank" rel="noreferrer">
          the Circle ↗
        </a>
      </p>
    </div>
  );
}
