import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { PerpsStyleId } from "@merrymen/core";
import type { SettingsView } from "../app/api/settings/route";
import { PerpsSettings } from "./PerpsSettings";
import { getPerpsStyle, isPerpsStyle, DEFAULT_PERPS_STYLE } from "@merrymen/core";
import { useNow } from "./clock";
import { fullDateTime } from "../lib/format";
import { money, type DeskPerps } from "./live";

const SignIn = lazy(() => import("./HostedControls").then((module) => ({ default: module.SignIn })));
export interface PerpsControlDeskProps {
  workerAliveAt?: number | null;
  ownerKey: string | null;
  session: { hosted: boolean; address: string | null } | null;
  hasAgent: boolean;
  perps: DeskPerps | null | undefined;
  styleRequest: { style: PerpsStyleId; revision: number } | null;
  onCreate: () => void;
  onFund: () => void;
  onPermission: () => void;
  onRefreshAccount: () => void;
}

/** All controls use the existing owner-bound settings and consent paths. */
export default function PerpsControlDesk(props: PerpsControlDeskProps) {
  return <OwnerControlDesk key={`${props.ownerKey ?? "visitor"}:${props.session?.address ?? "local"}`} {...props} />;
}

function OwnerControlDesk({ workerAliveAt, ownerKey, session, hasAgent, perps, styleRequest, onCreate, onFund, onPermission, onRefreshAccount }: PerpsControlDeskProps) {
  const now = useNow(30_000);
  const heartbeatMs = typeof workerAliveAt === "number" && Number.isFinite(workerAliveAt) && workerAliveAt > 0 ? workerAliveAt * 1000 : null;
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseNote, setPauseNote] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const settingsRequest = useRef<AbortController | null>(null);
  const active = ownerKey !== null && hasAgent && session !== null;
  const hosted = session?.hosted ?? null;
  const address = session?.address?.toLowerCase() ?? null;
  const load = useCallback(async () => {
    if (!active) return;
    const id = ++generation.current;
    settingsRequest.current?.abort();
    setBusy(true); setError(null);
    const abort = new AbortController();
    settingsRequest.current = abort;
    const timeout = globalThis.setTimeout(() => abort.abort(), 12_000);
    try {
      const response = await fetch("/api/settings?purpose=perps", { credentials: "same-origin", cache: "no-store", signal: abort.signal });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Sign in again to read your trading controls." : "Your trading controls could not be loaded.");
      const next = await response.json() as SettingsView;
      if (!next || typeof next !== "object" || !next.values || !next.defaults || (hosted && next.owner?.toLowerCase() !== address)) throw new Error("The settings response does not match this account.");
      if (!isPerpsStyle(next.values.perpsStyle ?? next.defaults.perpsStyle ?? DEFAULT_PERPS_STYLE)) throw new Error("The saved doctrine could not be read. Refresh your account before changing controls.");
      if (mounted.current && generation.current === id) setSettings(next);
    } catch (cause) {
      if (mounted.current && generation.current === id) { setSettings(null); setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "Reading trading controls timed out."); }
    } finally {
      globalThis.clearTimeout(timeout);
      if (mounted.current && generation.current === id) setBusy(false);
    }
  }, [active, hosted, address]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; generation.current++; settingsRequest.current?.abort(); };
  }, [load]);
  const saved = async () => { await load(); onRefreshAccount(); };
  const pause = async () => {
    if (!settings || pauseBusy) return;
    const id = generation.current;
    setPauseBusy(true); setPauseNote(null);
    const abort = new AbortController();
    const timeout = globalThis.setTimeout(() => abort.abort(), 12_000);
    try {
      const response = await fetch("/api/settings?purpose=perps", { method: "PUT", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ perpsEnabled: false, ...(settings.owner !== null ? { owner: settings.owner } : {}) }), signal: abort.signal });
      if (!response.ok) throw new Error("The pause was not confirmed. Refresh before trying again.");
      if (!mounted.current || generation.current !== id) return;
      await saved();
      if (mounted.current) setPauseNote("New entries are disabled in settings. Existing positions still need protective exits; an operation already in flight may finish.");
    } catch (cause) {
      if (mounted.current && generation.current === id) setPauseNote(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "The pause response timed out. Refresh to check whether it was saved.");
    } finally { globalThis.clearTimeout(timeout); if (mounted.current) setPauseBusy(false); }
  };
  return <section className="perps-control-desk" aria-labelledby="perps-control-heading">
    <header className="perps-control-heading"><div><span className="perps-eyebrow">YOUR AGENT / CONTROL ROOM</span><h2 id="perps-control-heading">Put your rules to work.</h2><p>Choose a doctrine, keep your limits, and let the worker handle eligible entries and protective exits.</p></div>{active ? <button type="button" className="perps-control-secondary" onClick={() => void load()} disabled={busy}>Refresh controls</button> : null}</header>
    {!session ? <p className="perps-data-note">Reading your account. Trading controls will appear after your session is confirmed.</p> : session.hosted && !session.address ? <div className="perps-control-onboarding"><h3>Connect your account</h3><p>Market prices are public. Your positions, history and trading authority stay private.</p><Suspense fallback={<p>Loading sign-in…</p>}><SignIn onDone={onRefreshAccount} /></Suspense></div> : !hasAgent ? <div className="perps-control-onboarding"><h3>Give your agent a mission</h3><p>Create your agent and set its permissions. Then choose a perpetuals doctrine here, begin with paper, and review real-money consent separately.</p><button type="button" className="perps-settings" onClick={onCreate}>Create your Perps wallet ↗</button></div> : <>
      <div className="perps-control-actions"><button type="button" className="perps-control-secondary" onClick={onFund}>Fund Perps wallet ↗</button><button type="button" className="perps-control-secondary" onClick={onPermission}>Review signed permission ↗</button>{settings ? <button type="button" className="perps-control-pause" disabled={pauseBusy || (settings.values.perpsEnabled ?? settings.defaults.perpsEnabled) === false} onClick={() => void pause()}>{pauseBusy ? "Saving pause…" : (settings.values.perpsEnabled ?? settings.defaults.perpsEnabled) === false ? "New entries disabled" : "Pause new entries"}</button> : null}</div>
      <p className="perps-data-note">Worker heartbeat: {heartbeatMs === null ? "not reported" : `${fullDateTime(heartbeatMs)} · ${now < heartbeatMs || now - heartbeatMs > 300_000 ? "not current" : "recently reported"}`}. A heartbeat does not confirm a trade.</p>
      <div className="perps-control-evaluation"><span className="perps-eyebrow">LAST WORKER EVALUATION</span>{perps?.automation ? <><strong>{perps.automation.state === "candidate" ? "Entry candidate evaluated" : perps.automation.state === "manual" ? "Manual entry control" : "Waiting for criteria"}</strong><p>{perps.automation.reason}</p><small>{fullDateTime(perps.automation.evaluatedAt * 1000)} · {perps.stale || now < perps.automation.evaluatedAt * 1000 || now - perps.automation.evaluatedAt * 1000 > 300_000 ? "Past evaluation; current activity unknown" : "Reported evaluation"}. A candidate is not a confirmed fill.</small></> : <p>No completed evaluation has been reported. Enabling entries alone does not confirm the worker is scanning.</p>}</div>
      {pauseNote ? <p className="perps-control-notice" role="status">{pauseNote}</p> : null}
      {error ? <p className="perps-control-notice is-warning" role="alert">{error} <button type="button" onClick={() => void load()}>Retry controls</button></p> : null}
      {!settings ? busy ? <p className="perps-data-note" aria-busy="true">Reading your saved doctrine, limits and consent…</p> : null : <>
        <div className="perps-control-saved"><div><span>SAVED DOCTRINE</span><strong>{getPerpsStyle(settings.values.perpsStyle ?? settings.defaults.perpsStyle ?? DEFAULT_PERPS_STYLE).label}</strong></div><div><span>PER-TRADE LIMIT</span><strong>{money(settings.values.perpsPerTradeUsdg ?? settings.defaults.perpsPerTradeUsdg)}</strong></div><div><span>WORKER REPORT</span><strong>{perps?.read === "ok" ? perps.stale ? "Last read is stale" : perps.mode === "live" ? "Live money" : perps.mode === "paper" ? "Paper practice" : perps.mode === "off" ? "Entries off" : "Blocked" : "Not read"}</strong></div></div>
        <div className="perps-control-form"><PerpsSettings purpose="perps" values={settings.values} defaults={settings.defaults} owner={settings.owner} hosted={hosted} onSaved={saved} styleRequest={styleRequest ?? undefined} /></div>
      </>}
    </>}
  </section>;
}
