import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { LIGHTER_MARKETS_V1, type PerpsStyleId } from "@merrymen/core";
import { readChartResponse } from "../lib/perps-chart-response";
import type { ChartBook, ChartResponse, ChartWindow } from "../lib/perps-chart-data";
import { PerpsMobileNav, usePerpsMobile, type PerpsMobileView } from "./PerpsMobileNav";
import { LogoMark } from "./LogoMark";
import type { DeskPerpRow, DeskPerps } from "./live";
import { usdExact, utcTimeOnly } from "../lib/format";
import { money } from "./live";
import { PerpsDoctrines } from "./PerpsDoctrines";
import { PerpsPanel } from "./PerpsPanel";
import { PerpsChart, entryDescription, executionTime } from "./PerpsChart";
import { TradingModeToggle } from "./TradingModeToggle";
import { startRefreshLoop } from "./refresh-loop";
import { playChime, unlockAudio } from "./chime";

const PerpsControlDesk = lazy(() => import("./PerpsControlDesk"));
import { PerpsActivity } from "./PerpsActivity";

export interface PerpsScreenProps {
  session?: { hosted: boolean; address: string | null } | null;
  workerAliveAt?: number | null;
  onCreate?: (style?: PerpsStyleId) => void;
  onFund?: () => void;
  onPermission?: () => void;
  onRefreshAccount?: () => void;
  onReviewExit?: (scope: { market?: string; book?: ChartBook }) => void;
  perps: DeskPerps | null | undefined;
  hasAgent: boolean;
  ownerKey: string | null;
  onSpot: () => void;
  onSettings: (style?: PerpsStyleId) => void;
}

/** Changing or removing the owner drops every private chart and its seen-fill baseline. */
export function PerpsScreen(props: PerpsScreenProps) {
  return <OwnerPerpsScreen key={props.ownerKey ?? "signed-out"} {...props} />;
}

/** Isolated design harness: never mounted by the authenticated terminal. */
export function PerpsScreenPreview({ data, ...props }: PerpsScreenProps & { data: ChartResponse }) {
  return <OwnerPerpsScreen {...props} previewData={data} />;
}

function RadarSymbol() {
  return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="15" /><circle cx="20" cy="20" r="7" /><path d="M20 0v10m0 20v10M0 20h10m20 0h10M20 20 31 9" /><path d="m29 8 4-1-1 4" /><circle cx="20" cy="20" r="2" fill="currentColor" /></svg>;
}

function OwnerPerpsScreen({ perps, hasAgent, ownerKey, onSpot, onSettings, session = null, workerAliveAt, onCreate, onFund, onPermission, onRefreshAccount, onReviewExit, previewData }: PerpsScreenProps & { previewData?: ChartResponse }) {
  const mobile = usePerpsMobile();
  const panelId = useId();
  const [mobileView, setMobileView] = useState<PerpsMobileView>("radar");
  const [controlVisited, setControlVisited] = useState(false);
  const [styleRequest, setStyleRequest] = useState<{style: PerpsStyleId; revision: number} | null>(null);
  const openControl = (style?: PerpsStyleId) => {
    if (style) setStyleRequest(current => ({style, revision: (current?.revision ?? 0) + 1}));
    changeMobileView("control");
  };
  const panelTop = useRef<HTMLDivElement>(null);
  const changeMobileView = (view: PerpsMobileView) => {
    setMobileView(view);
    if (view === "control") setControlVisited(true);
    // A dock tap from deep in the playbook returns to the start of the new panel.
    requestAnimationFrame(() => panelTop.current?.scrollIntoView?.({ block: "start", behavior: "instant" }));
  };
  const panelProps = (view: PerpsMobileView) => ({
    id: `${panelId}-panel-${view}`,
    hidden: mobile ? mobileView !== view : view === "control" ? mobileView !== "control" : mobileView === "control",
    role: mobile ? "tabpanel" : undefined,
    "aria-labelledby": mobile ? `${panelId}-tab-${view}` : undefined,
    tabIndex: mobile ? 0 : undefined,
  });
  const [market, setMarket] = useState("BTC-PERP");
  const [chosenBook, setBook] = useState<ChartBook | null>(null);
  const book = chosenBook ?? perps?.book ?? "paper";
  const [windowKey, setWindowKey] = useState<ChartWindow>("24h");
  const [sound, setSound] = useState(false);
  const [audioUnavailable, setAudioUnavailable] = useState(false);
  const ready = ownerKey !== null && hasAgent;
  const readable = perps?.read === "ok" && perps.venueRead;
  return <main className="perps-screen" data-mobile-view={mobileView}>
    {previewData ? <div className="perps-preview-notice">DESIGN PREVIEW · FICTIONAL DATA · NO TRADING</div> : null}
    <div className="perps-mobile-mode"><TradingModeToggle mode="perps" onChange={(mode) => { if (mode === "spot") onSpot(); }} /></div>
    <header className="perps-screen-head"><div className="perps-identity"><span className="perps-brand-mark"><LogoMark size={46} /></span><div><span className="perps-eyebrow">MERRYMEN / PERPETUALS DIVISION</span><h1 tabIndex={-1}>TACTICAL RADAR<span aria-hidden="true">_</span></h1><p>Your agent. Your positions. Every entry in sight.</p></div></div><div className="perps-head-actions"><span className="perps-radar-symbol"><RadarSymbol /></span><button className="perps-settings" type="button" onClick={() => openControl()}>Control room <span aria-hidden="true">↗</span></button></div></header>
    <div className="perps-status-strip" hidden={mobile && mobileView !== "positions"}>
      <div><span>AGENT MODE</span><strong>{!session ? "Reading account" : !ownerKey ? "Signed out" : !hasAgent ? "No agent" : perps?.mode === "paper" ? "Paper practice" : perps?.mode === "live" ? "Live money" : perps?.mode === "off" ? "Perps off" : perps?.mode === "refuse" ? "Blocked" : "Not read"}</strong></div>
      <div><span>{perps?.book === "paper" ? "PAPER PERPS" : perps?.book === "live" ? "AT LIGHTER" : "PERPS BALANCE"}</span><strong>{ready && readable && perps.atLighterUsd !== null && perps.book !== null ? money(perps.atLighterUsd) : "Not read"}{ready && readable && perps.stale ? <small> · last read</small> : null}</strong></div>
      <div><span>OPEN POSITIONS</span><strong>{ready && readable ? `${perps.rows.length}${perps.stale ? " · last read" : ""}` : "Unknown"}</strong></div>
      <div className="perps-owner-note"><span className="perps-status-dot" aria-hidden="true" /><span>Only your agent<br /><small>Owner-only entry history</small></span></div>
    </div>
    {mobile ? <PerpsMobileNav view={mobileView} onChange={changeMobileView} idPrefix={panelId} positionCount={ready && readable ? perps.rows.length : null} positionStatus={!ready || !readable ? "positions unknown" : `${perps.rows.length} positions${perps.stale ? ", last read" : ""}${perps.incident || perps.stopsMissing > 0 ? ", review required" : ""}`} attention={ready && (!readable || !!perps?.stale || !!perps?.incident || (perps?.stopsMissing ?? 0) > 0)} /> : null}
    <nav className="perps-desktop-navigation" aria-label="Perpetuals workspace"><button type="button" aria-pressed={mobileView !== "control"} onClick={() => changeMobileView("radar")}>Radar & positions</button><button type="button" aria-pressed={mobileView === "control"} onClick={() => openControl()}>Control room</button></nav>
    <div className="perps-panel-top" ref={panelTop} />
    <div className="perps-command-grid">
    <section {...panelProps("radar")} className="perps-arena" aria-label="Perpetuals market and entries">
      <div className="perps-chart-toolbar"><label className="perps-market-picker"><span className="perps-control-label">MARKET</span><select value={market} onChange={(event) => setMarket(event.target.value)}>{LIGHTER_MARKETS_V1.map((m) => <option key={m.key} value={m.key}>{m.key}</option>)}</select></label>
        {ready ? <div className="perps-segment" role="group" aria-label="Entry book">{(["paper", "live"] as const).map((b) => <button key={b} type="button" aria-pressed={book === b} onClick={() => setBook(b)}>{b === "paper" ? "Paper" : "Live"}</button>)}</div> : null}
        <div className="perps-segment perps-windows" role="group" aria-label="Chart time window">{(["24h", "7d", "30d"] as const).map((w) => <button key={w} type="button" aria-pressed={windowKey === w} onClick={() => setWindowKey(w)}>{w}</button>)}</div>
        <button type="button" className="perps-sound" aria-pressed={sound} onClick={() => { if (sound) { setSound(false); return; } void unlockAudio().then((ok) => { setSound(ok); setAudioUnavailable(!ok); }); }}><span aria-hidden="true">{sound ? "♪" : "♩"}</span> Sound {sound ? "on" : "off"}</button>
      </div>
      <div className={`perps-book-banner is-${ready ? book : "market"}`}><span>{!ready ? "LIVE MARKET DATA" : book === "paper" ? "PAPER PRACTICE" : "LIVE BOOK"}</span>{!ready ? "Lighter mark prices" : book === "paper" ? "Simulated entries · no real money" : "Recorded real-money executions"}{ready ? <small>Changing this view does not change your agent’s trading mode.</small> : null}</div>
      {audioUnavailable ? <p className="perps-data-note" role="status">Sound could not be enabled in this browser.</p> : null}
      {!ready ? <p className="perps-data-note">Live market prices. <button type="button" onClick={() => openControl()}>{!session ? "Account controls" : ownerKey ? "Set up your agent" : "Sign in"}</button> to see private executions and use trading controls.</p> : null}
      <LiveChart key={`${ready}:${market}:${book}:${windowKey}`} privateReady={ready} market={market} book={book} windowKey={windowKey} sound={sound} positions={ready && readable && perps.book !== null ? perps.rows : undefined} positionsStale={perps?.stale} previewData={previewData} />
      {ready && !previewData ? <PerpsActivity key={`${market}:${book}`} market={market} book={book} /> : null}
    </section>
    {ready ? <section {...panelProps("positions")} className="perps-position-section"><div className="perps-section-heading"><h2>Open positions</h2><span>OWNER ONLY</span></div><p className="perps-position-explainer">Your worker’s full account. Positions stay visible across chart filters.</p>{perps ? <PerpsPanel perps={perps} onClose={onReviewExit && perps.book ? market => onReviewExit({market, book: perps.book!}) : undefined} onFlatten={onReviewExit && perps.book ? () => onReviewExit({book: perps.book!}) : undefined} /> : <p className="perps-data-note">{perps === undefined ? "The account feed has not supplied a perpetuals report. Current positions are unknown." : "Your worker has not reported its perpetuals yet. Current positions are unknown."}</p>}</section> : <aside {...panelProps("positions")} className="perps-position-section"><div className="perps-section-heading"><h2>Open positions</h2><span>PRIVATE</span></div><p className="perps-data-note">Sign in and set up your agent to read your positions. Only the owner can access this account.</p></aside>}
    </div>
    <div {...panelProps("playbook")} className="perps-playbook-panel"><PerpsDoctrines onConfigure={openControl} /></div>
    <div {...panelProps("control")} className="perps-control-panel">{controlVisited ? <Suspense fallback={<p className="perps-data-note">Loading trading controls…</p>}><PerpsControlDesk workerAliveAt={workerAliveAt} ownerKey={ownerKey} session={session} hasAgent={hasAgent} perps={perps} styleRequest={styleRequest} onCreate={() => onCreate ? onCreate(styleRequest?.style) : onSettings(styleRequest?.style)} onFund={onFund ?? (() => onSettings())} onPermission={onPermission ?? (() => onSettings())} onRefreshAccount={onRefreshAccount ?? (() => {})} /></Suspense> : null}</div>
  </main>;
}

function LiveChart({ privateReady, market, book, windowKey, sound, positions, positionsStale, previewData }: { privateReady: boolean; market: string; book: ChartBook; windowKey: ChartWindow; sound: boolean; positions?: DeskPerpRow[]; positionsStale?: boolean; previewData?: ChartResponse }) {
  const [data, setData] = useState<ChartResponse | null>(previewData ? { ...previewData, market, book, window: windowKey, entries: previewData.market === market && previewData.book === book ? previewData.entries : [], candles: previewData.market === market ? previewData.candles : { state: "none", bars: [], gaps: [], stale: false, asOfMs: null } } : null);
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
    if (previewData) { setBusy(false); return; }
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
          const params = new URLSearchParams({ market, ...(privateReady ? {book} : {}), window: windowKey });
          const response = await fetch(`/api/perps/${privateReady ? "chart" : "market"}?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
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
          const next = readChartResponse(await response.json(), { market, book: privateReady ? book : "paper", window: windowKey });
          if (stopped) return false;
          failureMessage = "The chart response could not be read. Retrying automatically.";
          if (!next) throw new Error("The chart response could not be read. Retrying automatically.");
          const fresh = next.state !== "ok" || baselineAt === null ? [] : next.entries.filter((entry) => !seen.has(entry.id) && entry.timeMs > baselineAt!);
          if (next.state === "ok" && baselineAt === null) baselineAt = next.generatedAtMs;
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
  }, [market, book, windowKey, previewData, privateReady]);
  useEffect(() => {
    if (freshIds.length === 0) return;
    const timer = globalThis.setTimeout(() => setFreshIds([]), 2_400);
    return () => globalThis.clearTimeout(timer);
  }, [freshIds]);
  const entries = data ? [...data.entries].reverse() : [];
  const shown = expanded ? entries : entries.slice(0, 8);
  return <>
    <div className="perps-read-line"><span>{error ? "Read interrupted" : !data ? "Reading your chart…" : !privateReady ? "Public market prices" : data.state === "unreadable" ? "Private history unreadable" : data.state === "not-configured" ? "Perpetuals not configured" : busy ? "Refreshing…" : `Updated ${utcTimeOnly(data.generatedAtMs)} UTC`}</span><button type="button" onClick={() => retry.current?.()} disabled={busy || !!previewData}>{previewData ? "Preview snapshot" : busy ? "Reading…" : "Refresh"}</button></div>
    {error ? <p className="perps-data-note is-warning" role="status">{error}{data ? ` Showing the last successful read from ${executionTime(data.generatedAtMs)}; it may have changed.` : ""}</p> : null}
    <div className="perps-sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    {data ? <>
      {privateReady && data.state === "unreadable" ? <p className="perps-data-note is-warning">Private entry history could not be read. Entry counts are unknown; market candles remain available.</p> : null}
      {privateReady && data.state === "not-configured" ? <p className="perps-data-note">No perpetuals configuration was available for this account. This is not confirmation of an empty venue account.</p> : null}
      {data.candles.state !== "ok" ? <p className="perps-data-note is-warning">{data.candles.state === "unreadable" ? "Lighter mark candles could not be read." : "No Lighter mark candles were returned for this window."}{privateReady ? " Recorded entries retain their exact execution prices." : ""}</p> : data.candles.stale ? <p className="perps-data-note is-warning">Mark candles are stale{data.candles.asOfMs !== null ? `; the last candle ended ${executionTime(data.candles.asOfMs)}` : ""}.</p> : null}
      {data.candles.gaps.length > 0 ? <p className="perps-data-note">{data.candles.gaps.length} {data.candles.gaps.length === 1 ? "gap" : "gaps"} in mark-price history. Shaded intervals are missing candles.</p> : null}
      <PerpsChart positions={positions} positionsStale={positionsStale} data={data} freshIds={freshIds} selectedId={selectedId} onSelect={setSelectedId} />
      {privateReady ? <div className="perps-entry-history"><div className="perps-section-heading"><h2>Entry log <span>{entries.length}</span></h2><span>{book === "paper" ? "Paper practice" : "Live executions"} · {windowKey}</span></div><p className="perps-history-help">Opens, additions and reversals at recorded execution prices. Closing fills are not entry markers.</p>
        {data.truncated ? <p className="perps-data-note is-warning">Partial history: only the latest 500 fills were examined. Earlier entries in this window may be missing.</p> : null}
        {data.unknownFills > 0 ? <p className="perps-data-note is-warning">{data.unknownFills} {data.unknownFills === 1 ? "fill could" : "fills could"} not be classified from its record. No entry marker has been inferred for {data.unknownFills === 1 ? "it" : "them"}.</p> : null}
        {entries.length === 0 ? <p className="perps-history-empty">{data.state !== "ok" ? "Entry history is unavailable." : data.unknownFills || data.truncated ? "No confirmed entry markers in the available records. History is incomplete." : "No recorded entries in this market, book and time window."} This does not establish whether positions are open now.</p> : <ul className="perps-entry-list">{shown.map((entry) => <li key={entry.id}><button type="button" aria-pressed={selectedId === entry.id} className={`perps-entry-row${freshIds.includes(entry.id) ? " is-fresh" : ""}`} onClick={() => setSelectedId(entry.id)} aria-label={entryDescription(entry)}><span className={`perps-entry-badge is-${entry.side}`} aria-hidden="true">{entry.side === "long" ? "↗" : "↘"}</span><span className="perps-entry-name"><strong>{entry.side === "long" ? "Long" : "Short"} <small>{entry.kind}</small></strong><span>{entry.size} · {entry.book === "paper" ? "Paper" : "Live"} · epoch {entry.epoch}</span></span><span className="perps-entry-price"><strong>{usdExact(entry.priceExact)}</strong><time dateTime={new Date(entry.timeMs).toISOString()}>{executionTime(entry.timeMs)}</time></span></button></li>)}</ul>}
        {entries.length > 8 ? <button className="perps-show-history" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show recent entries" : `Show all ${entries.length} entries`}</button> : null}
      </div> : null}
    </> : <div className="perps-chart-empty" aria-busy={busy}><span className="perps-empty-grid" aria-hidden="true">⌁</span><strong>{error ? "Your chart could not be read" : "Reading the market"}</strong><p>{error ? (privateReady ? "Entry history is unknown until a read succeeds." : "Market prices are unavailable until a read succeeds.") : privateReady ? "Loading Lighter mark candles and your private entry history." : "Loading Lighter mark candles."}</p></div>}
  </>;
}
