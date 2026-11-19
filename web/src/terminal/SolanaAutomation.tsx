"use client";
import { useEffect, useRef, useState } from "react";
import type { SolanaBinding, SolanaStrategy } from "@/lib/solana-binding-store";
import { solanaUnits, displaySolanaAmount } from "../lib/solana-amounts";
import { pacedAnswer } from "./SolanaOwnerActions";

export type SolanaApi = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
/**
 * `modeSwitch`: whether this account can choose its mode at all (SolanaScreen's offersLive). One that can only paper trade
 * is told nothing about modes; live is always named, since it trades real funds.
 */
export function SolanaAutomation({ binding, api, refresh, workerOnline, modeSwitch = true }: { binding: SolanaBinding; api: SolanaApi; refresh: () => Promise<void>; workerOnline: boolean; modeSwitch?: boolean }) {
  const [enabled, setEnabled] = useState(false), [target, setTarget] = useState("50"), [threshold, setThreshold] = useState("5");
  const [size, setSize] = useState("1"), [interval, setInterval] = useState("60");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  // A paced answer (pacedAnswer): a wait, not a failure.
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  // The card stays folded to its status and one button until the owner opens it: a page of strategy fields nobody asked
  // for pushed everything under it out of reach.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const saved = binding.strategy;
    setEnabled(saved?.enabled ?? false); setTarget(String((saved?.targetSolBps ?? 5000) / 100));
    setThreshold(String((saved?.rebalanceBps ?? 500) / 100)); setSize(displaySolanaAmount(saved?.tradeUsdgRaw ?? "1000000"));
    setInterval(String(saved?.intervalSeconds ?? 60));
  }, [binding.revision, binding.strategy]);
  const saved = binding.strategy;
  const state = saved?.enabled
    ? workerOnline ? "Solana worker connected. Execution still requires available quotes, valid limits, and the appropriate portfolio or live permission." : "Waiting for Solana worker. Your strategy is saved, but no recent worker heartbeat has been received."
    : "Autonomous trading is disabled.";
  if (!open) return <div id="solana-automation" className="solana-card"><h2>Autonomous rebalancing</h2>
    {saved?.enabled && <p>Keeps {saved.targetSolBps / 100}% in wrapped SOL, in trades of up to {displaySolanaAmount(saved.tradeUsdgRaw)} USDG, checked every {saved.intervalSeconds} seconds.</p>}
    <p role="status">{state}</p>
    <button type="button" className="solana-secondary" onClick={() => setOpen(true)}>{saved?.enabled ? "Change strategy" : "Set up automation"}</button>
  </div>;
  return <form id="solana-automation" className="solana-card" onSubmit={(event) => {
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
    {modeSwitch ? <p>Keep a target balance of USDG and wrapped SOL. The agent uses this account’s saved mode and trading limits. Switching modes disables the strategy until you enable it again.</p>
      : <p>Keep a target balance of USDG and wrapped SOL, within this account’s saved trading limits.</p>}
    {error && <p role="alert" className="solana-error">{error}</p>}
    {notice && <p role="status" className="solana-notice">{notice}</p>}
    <fieldset disabled={busy}><legend>Strategy settings</legend>
      <label><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enable autonomous trading{modeSwitch || binding.requestedMode === "live" ? ` in ${binding.requestedMode} mode` : ""}</label>
      <div className="solana-fields">
        <label>Target wrapped SOL (%)<input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
        <label>Rebalance threshold (%)<input inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
        <label>Maximum USDG per strategy trade<input inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} /></label>
        <label>Check every (seconds)<input type="number" min="30" max="86400" value={interval} onChange={(e) => setInterval(e.target.value)} /></label>
      </div>
      {binding.requestedMode === "live" && <p>Each live trade must be worth at least 1 USDG, so set at least 1 USDG per strategy trade. A rebalance worth less waits until it grows, checked once per interval.</p>}
      <button>Save autonomous strategy</button>
    </fieldset>
    <p role="status">{state}</p>
  </form>;
}
