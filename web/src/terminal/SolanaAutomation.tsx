"use client";
import { useEffect, useRef, useState } from "react";
import type { SolanaBinding, SolanaStrategy } from "@/lib/solana-binding-store";
import { solanaUnits, displaySolanaAmount } from "../lib/solana-amounts";
import { pacedAnswer } from "./SolanaOwnerActions";

export type SolanaApi = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export function SolanaAutomation({ binding, api, refresh, workerOnline }: { binding: SolanaBinding; api: SolanaApi; refresh: () => Promise<void>; workerOnline: boolean }) {
  const [enabled, setEnabled] = useState(false), [target, setTarget] = useState("50"), [threshold, setThreshold] = useState("5");
  const [size, setSize] = useState("1"), [interval, setInterval] = useState("60");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  // A paced answer (pacedAnswer): a wait, not a failure.
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    const saved = binding.strategy;
    setEnabled(saved?.enabled ?? false); setTarget(String((saved?.targetSolBps ?? 5000) / 100));
    setThreshold(String((saved?.rebalanceBps ?? 500) / 100)); setSize(displaySolanaAmount(saved?.tradeUsdgRaw ?? "1000000"));
    setInterval(String(saved?.intervalSeconds ?? 60));
  }, [binding.revision, binding.strategy]);
  return <form className="solana-card" onSubmit={(event) => {
    event.preventDefault(); if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(""); setNotice("");
    void (async () => {
      const targetSolBps = Number(solanaUnits(target, 2, true));
      const strategy: SolanaStrategy = { enabled, targetSolBps, rebalanceBps: Number(solanaUnits(threshold, 2)), tradeUsdgRaw: solanaUnits(size, 6), intervalSeconds: Number(interval) };
      await api("strategy", { strategy, revision: binding.revision }); await refresh();
    })().catch((e: unknown) => {
      const paced = pacedAnswer(e);
      if (paced !== null) setNotice(paced); else setError(e instanceof Error ? e.message : "Could not save this strategy.");
    })
      .finally(() => { inFlight.current = false; setBusy(false); });
  }}><h2>Autonomous rebalancing</h2>
    <p>Keep a target balance of USDG and wrapped SOL. The agent uses this account’s saved mode and trading limits. Switching modes disables the strategy until you enable it again.</p>
    {error && <p role="alert" className="solana-error">{error}</p>}
    {notice && <p role="status" className="solana-notice">{notice}</p>}
    <fieldset disabled={busy}><legend>Strategy settings</legend>
      <label><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enable autonomous trading in {binding.requestedMode} mode</label>
      <div className="solana-fields">
        <label>Target wrapped SOL (%)<input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
        <label>Rebalance threshold (%)<input inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
        <label>Maximum USDG per strategy trade<input inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} /></label>
        <label>Check every (seconds)<input type="number" min="30" max="86400" value={interval} onChange={(e) => setInterval(e.target.value)} /></label>
      </div>
      {binding.requestedMode === "live" && <p>Each live trade must be worth at least 1 USDG, so set at least 1 USDG per strategy trade. A rebalance worth less waits until it grows, checked once per interval.</p>}
      <button>Save autonomous strategy</button>
    </fieldset>
    <p role="status">{binding.strategy?.enabled
      ? workerOnline ? "Solana worker connected. Execution still requires available quotes, valid limits, and the appropriate portfolio or live permission." : "Waiting for Solana worker. Your strategy is saved, but no recent worker heartbeat has been received."
      : "Autonomous trading is disabled."}</p>
  </form>;
}
