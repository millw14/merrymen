import { useEffect, useRef, useState } from "react";
import { LIGHTER_MARKETS_V1 } from "@merrymen/core";
import type { ChartBook, ChartResponse, ChartWindow } from "../lib/perps-chart-data";
import type { DeskPerps } from "./live";
import { money } from "./live";
import { PerpsPanel } from "./PerpsPanel";
import { PerpsChart, entryDescription, executionTime } from "./PerpsChart";
import { TradingModeToggle } from "./TradingModeToggle";
import { startRefreshLoop } from "./refresh-loop";
import { playChime, unlockAudio } from "./chime";

export interface PerpsScreenProps {
  perps: DeskPerps | null | undefined;
  hasAgent: boolean;
  ownerKey: string | null;
  onSpot: () => void;
  onSettings: () => void;
}

/** Changing or removing the owner drops every private chart and its seen-fill baseline. */
export function PerpsScreen(props: PerpsScreenProps) {
  return <OwnerPerpsScreen key={props.ownerKey ?? "signed-out"} {...props} />;
}

function OwnerPerpsScreen({ perps, hasAgent, ownerKey, onSpot, onSettings }: PerpsScreenProps) {
  const [market, setMarket] = useState("BTC-PERP");
  const [chosenBook, setBook] = useState<ChartBook | null>(null);
  const book = chosenBook ?? perps?.book ?? "paper";
  const [windowKey, setWindowKey] = useState<ChartWindow>("24h");
  const [sound, setSound] = useState(false);
  const [audioUnavailable, setAudioUnavailable] = useState(false);
  const ready = ownerKey !== null && hasAgent;
  const readable = perps?.read === "ok" && perps.venueRead;
  return <main className="perps-screen">
    <div className="perps-mobile-mode"><TradingModeToggle mode="perps" onChange={(mode) => { if (mode === "spot") onSpot(); }} /></div>
    <header className="perps-screen-head"><div><span className="perps-eyebrow">THE PERPETUALS DESK</span><h1>Hold your ground<span aria-hidden="true">↗</span></h1><p>Your agent’s entries, right where they happened.</p></div><button className="perps-settings" type="button" onClick={onSettings}>Perps setup <span aria-hidden="true">↗</span></button></header>
    <div className="perps-status-strip">
      <div><span>AGENT MODE</span><strong>{!ownerKey ? "Signed out" : !hasAgent ? "No agent" : perps?.mode === "paper" ? "Paper practice" : perps?.mode === "live" ? "Live money" : perps?.mode === "off" ? "Perps off" : perps?.mode === "refuse" ? "Blocked" : "Not read"}</strong></div>
      <div><span>{perps?.book === "paper" ? "PAPER PERPS" : perps?.book === "live" ? "AT LIGHTER" : "PERPS BALANCE"}</span><strong>{ready && readable && perps.atLighterUsd !== null && perps.book !== null ? money(perps.atLighterUsd) : "Not read"}{ready && readable && perps.stale ? <small> · last read</small> : null}</strong></div>
      <div><span>OPEN POSITIONS</span><strong>{ready && readable ? `${perps.rows.length}${perps.stale ? " · last read" : ""}` : "Unknown"}</strong></div>
      <div className="perps-owner-note"><span className="perps-status-dot" aria-hidden="true" /><span>Only your agent<br /><small>Owner-only entry history</small></span></div>
    </div>
    <section className="perps-arena" aria-label="Perpetuals market and entries">
      <div className="perps-chart-toolbar"><label className="perps-market-picker"><span className="perps-control-label">MARKET</span><select value={market} onChange={(event) => setMarket(event.target.value)}>{LIGHTER_MARKETS_V1.map((m) => <option key={m.key} value={m.key}>{m.key}</option>)}</select></label>
        <div className="perps-segment" role="group" aria-label="Entry book">{(["paper", "live"] as const).map((b) => <button key={b} type="button" aria-pressed={book === b} onClick={() => setBook(b)}>{b === "paper" ? "Paper" : "Live"}</button>)}</div>
        <div className="perps-segment perps-windows" role="group" aria-label="Chart time window">{(["24h", "7d", "30d"] as const).map((w) => <button key={w} type="button" aria-pressed={windowKey === w} onClick={() => setWindowKey(w)}>{w}</button>)}</div>
        <button type="button" className="perps-sound" aria-pressed={sound} onClick={() => { if (sound) { setSound(false); return; } void unlockAudio().then((ok) => { setSound(ok); setAudioUnavailable(!ok); }); }}><span aria-hidden="true">{sound ? "♪" : "♩"}</span> Sound {sound ? "on" : "off"}</button>
      </div>
      <div className={`perps-book-banner is-${book}`}><span>{book === "paper" ? "PAPER PRACTICE" : "LIVE BOOK"}</span>{book === "paper" ? "Simulated entries · no real money" : "Recorded real-money executions"}<small>Changing this view does not change your agent’s trading mode.</small></div>
      {audioUnavailable ? <p className="perps-data-note" role="status">Sound could not be enabled in this browser.</p> : null}
      {ready ? <LiveChart key={`${market}:${book}:${windowKey}`} market={market} book={book} windowKey={windowKey} sound={sound} /> : <div className="perps-chart-empty"><span className="perps-empty-grid" aria-hidden="true">⌁</span><strong>{ownerKey ? "Your agent’s next chapter" : "Your entries belong to you"}</strong><p>{ownerKey ? "Set up your agent to follow its perpetual entries here." : "Sign in to see your agent’s private perpetual entry history."}</p><button type="button" className="perps-settings" onClick={onSettings}>{ownerKey ? "Set up perpetuals" : "Account settings"} ↗</button></div>}
    </section>
    {ready ? <section className="perps-position-section"><div className="perps-section-heading"><h2>Current positions</h2><span>Worker-reported account · independent of chart filters</span></div>{perps ? <PerpsPanel perps={perps} /> : <p className="perps-data-note">{perps === undefined ? "The account feed has not supplied a perpetuals report. Current positions are unknown." : "Your worker has not reported its perpetuals yet. Current positions are unknown."}</p>}</section> : null}
  </main>;
}

function LiveChart({ market, book, windowKey, sound }: { market: string; book: ChartBook; windowKey: ChartWindow; sound: boolean }) {
  const [data, setData] = useState<ChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [freshIds, setFreshIds] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const soundRef = useRef(sound);
  const retry = useRef<(() => void) | null>(null);
  useEffect(() => { soundRef.current = sound; }, [sound]);
  useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;
    let baselineAt: number | null = null;
    const seen = new Set<string>();
    let retryAfterMs = 0;
    const loop = startRefreshLoop({
      everyMs: 30_000,
      paused: () => document.hidden || Date.now() < retryAfterMs,
      report: () => {},
      onFlight: (inFlight) => { if (!stopped) setBusy(inFlight); },
      pass: async () => {
        if (Date.now() < retryAfterMs) return false;
        let failureMessage = "The chart could not be refreshed. Retrying automatically.";
        controller = new AbortController();
        const timeout = globalThis.setTimeout(() => controller?.abort(), 12_000);
        try {
          const params = new URLSearchParams({ market, book, window: windowKey });
          const response = await fetch(`/api/perps/chart?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
          if (stopped) return false;
          if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
              setData(null); setFreshIds([]); setAnnouncement(""); setSelectedId(null); seen.clear(); baselineAt = null;
              failureMessage = "Sign in again to read your private entry history.";
            } else if (response.status === 429) {
              const retrySeconds = Number(response.headers.get("Retry-After"));
              retryAfterMs = Date.now() + Math.min(300, Math.max(60, Number.isFinite(retrySeconds) ? retrySeconds : 60)) * 1000;
              failureMessage = "Chart refreshes are temporarily limited. Waiting before trying again.";
            }
            throw new Error(failureMessage);
          }
          const next = await response.json() as ChartResponse;
          if (stopped) return false;
          failureMessage = "The chart response could not be read. Retrying automatically.";
          if (!next || next.market !== market || next.book !== book || next.window !== windowKey || !Number.isFinite(next.generatedAtMs) || !Array.isArray(next.entries) || !Array.isArray(next.candles?.bars)) throw new Error("The chart response could not be read. Retrying automatically.");
          if (next.state !== "ok" && next.state !== "not-configured") {
            failureMessage = "Entry history could not be read. Entry counts are unknown.";
            throw new Error(failureMessage);
          }
          const fresh = baselineAt === null ? [] : next.entries.filter((entry) => !seen.has(entry.id) && entry.timeMs > baselineAt!);
          if (baselineAt === null) baselineAt = next.generatedAtMs;
          // Remember observed IDs for this mounted query, even across temporary history omissions.
          for (const entry of next.entries) seen.add(entry.id);
          setData(next);
          setError(null);
          if (fresh.length > 0 && !document.hidden) {
            setFreshIds(fresh.map((entry) => entry.id));
            setAnnouncement(`${fresh.length} new ${book} ${fresh.length === 1 ? "entry" : "entries"} recorded for ${market}.`);
            if (soundRef.current) playChime(fresh.at(-1)!.side === "long" ? "buy" : "sell");
          }
          return true;
        } catch (cause) {
          if (!stopped) setError(cause instanceof Error && cause.name === "AbortError" ? "The chart read timed out. Retrying automatically." : failureMessage);
          return false;
        } finally { globalThis.clearTimeout(timeout); }
      },
    });
    retry.current = loop.retryNow;
    const wake = () => { if (!document.hidden) loop.wake(); };
    document.addEventListener("visibilitychange", wake);
    return () => { stopped = true; controller?.abort(); loop.stop(); retry.current = null; document.removeEventListener("visibilitychange", wake); };
  }, [market, book, windowKey]);
  useEffect(() => {
    if (freshIds.length === 0) return;
    const timer = globalThis.setTimeout(() => setFreshIds([]), 2_400);
    return () => globalThis.clearTimeout(timer);
  }, [freshIds]);
  const entries = data ? [...data.entries].reverse() : [];
  const shown = expanded ? entries : entries.slice(0, 8);
  return <>
    <div className="perps-read-line"><span>{error ? "Read interrupted" : !data ? "Reading your chart…" : data.state === "not-configured" ? "Perpetuals not configured" : busy ? "Refreshing…" : `Updated ${new Date(data.generatedAtMs).toLocaleTimeString("en-GB", { timeZone: "UTC" })} UTC`}</span><button type="button" onClick={() => retry.current?.()} disabled={busy}>{busy ? "Reading…" : "Refresh"}</button></div>
    {error ? <p className="perps-data-note is-warning" role="status">{error}{data ? ` Showing the last successful read from ${executionTime(data.generatedAtMs)}; it may have changed.` : ""}</p> : null}
    <div className="perps-sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    {data ? <>
      {data.state === "not-configured" ? <p className="perps-data-note">No perpetuals configuration was available for this account. This is not confirmation of an empty venue account.</p> : null}
      {data.candles.state !== "ok" ? <p className="perps-data-note is-warning">{data.candles.state === "unreadable" ? "Lighter mark candles could not be read." : "No Lighter mark candles were returned for this window."} Recorded entries retain their exact execution prices.</p> : data.candles.stale ? <p className="perps-data-note is-warning">Mark candles are stale{data.candles.asOfMs !== null ? `; the last candle ended ${executionTime(data.candles.asOfMs)}` : ""}.</p> : null}
      {data.candles.gaps.length > 0 ? <p className="perps-data-note">{data.candles.gaps.length} {data.candles.gaps.length === 1 ? "gap" : "gaps"} in mark-price history. Shaded intervals are missing candles.</p> : null}
      <PerpsChart data={data} freshIds={freshIds} selectedId={selectedId} onSelect={setSelectedId} />
      <div className="perps-entry-history"><div className="perps-section-heading"><h2>Entry log <span>{entries.length}</span></h2><span>{book === "paper" ? "Paper practice" : "Live executions"} · {windowKey}</span></div><p className="perps-history-help">Opens, additions and reversals at recorded execution prices. Closing fills are not entry markers.</p>
        {data.truncated ? <p className="perps-data-note is-warning">Partial history: only the latest 500 fills were examined. Earlier entries in this window may be missing.</p> : null}
        {data.unknownFills > 0 ? <p className="perps-data-note is-warning">{data.unknownFills} {data.unknownFills === 1 ? "fill could" : "fills could"} not be classified from its record. No entry marker has been inferred for {data.unknownFills === 1 ? "it" : "them"}.</p> : null}
        {entries.length === 0 ? <p className="perps-history-empty">{data.state !== "ok" ? "Entry history is unavailable." : data.unknownFills || data.truncated ? "No confirmed entry markers in the available records. History is incomplete." : "No recorded entries in this market, book and time window."} This does not establish whether positions are open now.</p> : <ul className="perps-entry-list">{shown.map((entry) => <li key={entry.id}><button type="button" aria-pressed={selectedId === entry.id} className={`perps-entry-row${freshIds.includes(entry.id) ? " is-fresh" : ""}`} onClick={() => setSelectedId(entry.id)} aria-label={entryDescription(entry)}><span className={`perps-entry-badge is-${entry.side}`} aria-hidden="true">{entry.side === "long" ? "↗" : "↘"}</span><span className="perps-entry-name"><strong>{entry.side === "long" ? "Long" : "Short"} <small>{entry.kind}</small></strong><span>{entry.size} · {entry.book === "paper" ? "Paper" : "Live"} · epoch {entry.epoch}</span></span><span className="perps-entry-price"><strong>${entry.priceExact}</strong><time dateTime={new Date(entry.timeMs).toISOString()}>{executionTime(entry.timeMs)}</time></span></button></li>)}</ul>}
        {entries.length > 8 ? <button className="perps-show-history" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show recent entries" : `Show all ${entries.length} entries`}</button> : null}
      </div>
    </> : <div className="perps-chart-empty" aria-busy={busy}><span className="perps-empty-grid" aria-hidden="true">⌁</span><strong>{error ? "Your chart could not be read" : "Reading the market"}</strong><p>{error ? "Entry history is unknown until a read succeeds." : "Loading Lighter mark candles and your private entry history."}</p></div>}
  </>;
}
