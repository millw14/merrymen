"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { CASH, STOCK_TOKENS, explorerFor, robinhoodChain } from "@merrymen/core";
import type { AgentStatus } from "@/app/api/grants/route";
import type { FeedResponse, TradeRecord } from "@/app/api/feed/route";

const SYMBOLS = new Map<string, string>([
  [CASH.USDG.toLowerCase(), "USDG"],
  ...STOCK_TOKENS.map((t) => [t.address.toLowerCase(), t.symbol] as [string, string]),
]);

function sym(addr: string | null): string {
  if (!addr) return "—";
  return SYMBOLS.get(addr.toLowerCase()) ?? `${addr.slice(0, 6)}…`;
}

function describe(t: TradeRecord): string {
  if (t.kind === "swap") return `${t.amount_usdg.toFixed(2)} ${sym(t.sell_token)} → ${sym(t.buy_token)}`;
  if (t.kind === "vault-deposit") return `${t.amount_usdg.toFixed(2)} USDG → vault`;
  if (t.kind === "vault-withdraw") return `vault → ${t.amount_usdg.toFixed(2)} USDG`;
  return t.kind;
}

function receipt(t: TradeRecord): string | null {
  if (!t.sim_quote_out || !t.sim_min_out) return null;
  // Stock tokens are 18dp; quote/min are raw buy-token amounts.
  const q = Number(formatUnits(BigInt(t.sim_quote_out), 18));
  const m = Number(formatUnits(BigInt(t.sim_min_out), 18));
  const tier = t.sim_fee_tier != null ? ` @ ${(t.sim_fee_tier / 10_000).toFixed(2)}%` : "";
  return `sim ✓ ${q.toFixed(5)} min ${m.toFixed(5)}${tier}${t.sim_gas ? ` · gas ~${Number(t.sim_gas).toLocaleString()}` : ""}`;
}

export function TradesPanel() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [trades, setTrades] = useState<TradeRecord[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [gRes, fRes] = await Promise.all([fetch("/api/grants"), fetch("/api/feed")]);
        if (!alive) return;
        if (gRes.ok) setStatus((await gRes.json()) as AgentStatus);
        if (fRes.ok) setTrades(((await fRes.json()) as FeedResponse).trades ?? []);
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

  // No grant or nothing recorded → nothing to show; the feed panel covers status.
  if (!status?.exists || trades.length === 0) return null;

  return (
    <>
      <div className="section-title market-title">trade record · every attempt, simulated first</div>
      <table className="market trades">
        <thead>
          <tr>
            <th>time</th>
            <th>trade</th>
            <th>status</th>
            <th>simulation receipt</th>
            <th>on-chain proof</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={i}>
              <td className="mono dim">
                {new Date(t.created_at + "Z").toLocaleTimeString([], { hour12: false })}
              </td>
              <td className="mono">{describe(t)}</td>
              <td className="mono">
                {t.status === "landed" && <span className="ok">landed</span>}
                {t.status === "paper" && <span className="paper-chip">📜 paper</span>}
                {t.status === "reverted" && <span className="err">reverted</span>}
                {t.status === "rejected" && (
                  <span className="warn">rejected · {t.reject_rule ?? "policy"}</span>
                )}
              </td>
              <td className="mono dim">{receipt(t) ?? "—"}</td>
              <td className="mono">
                {t.tx_hash ? (
                  <a
                    className="tx-proof"
                    href={`${explorerFor(status?.grant?.chainId ?? robinhoodChain.id)}/tx/${t.tx_hash}`}
                    target="_blank"
                    rel="noreferrer"
                    title={t.tx_hash}
                  >
                    proof ↗
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
