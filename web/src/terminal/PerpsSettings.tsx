"use client";

import { useEffect, useRef, useState } from "react";
import { LIGHTER_MARKETS_V1, SETTINGS_DEFAULTS, PERPS_NUM_BOUNDS } from "@merrymen/core";
import { walletUrl } from "../lib/wallet-param";
import { fetchAccountForSession } from "./account-session";
import { requestJson } from "./request-json";
import { PerpsLinks } from "./PerpsScreen";
import { usePerpsAccount } from "./usePerpsAccount";
import { SignIn } from "./HostedControls";
import "./perps-desk.css";

const FIELDS = [
  ["perpsMaxLeverage", "Maximum leverage"], ["perpsPerTradeUsdg", "Maximum opening notional (USDG)"],
  ["perpsMaxOpenNotionalUsdg", "Total open notional limit (USDG)"], ["perpsMaxCollateralUsdg", "Collateral limit (USDG)"],
  ["perpsMaxOpensPerDay", "Maximum opens per day"], ["perpsStopLossPct", "Stop distance (% of price)"],
  ["perpsTakeProfitPct", "Take-profit distance (%; zero means none)"], ["perpsLiqBufferPct", "Liquidation buffer (% of entry)"],
  ["perpsMaxSlippageBps", "Maximum slippage (basis points)"], ["perpsStopSlipBps", "Stop slippage (basis points)"],
] as const;
type NumericKey = typeof FIELDS[number][0];
type Values = Partial<Record<NumericKey, number>> & { perpsEnabled?: boolean; perpsMarkets?: string[]; perpsDriver?: string };
interface SettingsRead { values: Values; version: string; owner: string | null }
export function PerpsSettings({ offered }: { offered: boolean }) {
  const { account, error: accountError, refresh } = usePerpsAccount(false);
  const [settings, setSettings] = useState<SettingsRead | null>(null);
  const [text, setText] = useState<Partial<Record<NumericKey, string>>>({});
  const [markets, setMarkets] = useState<string[]>([]);
  const [driver, setDriver] = useState("perp-trend");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const [revision, setRevision] = useState(0);
  const owner = account?.session.address ?? null;
  const authority = `${account?.session.hosted}:${owner}:${account?.status.grant?.smartAccount}:${account?.status.grant?.sessionKeyAddress}`;
  const currentAuthority = useRef(authority);
  const authorityGeneration = useRef(0);
  if (currentAuthority.current !== authority) { currentAuthority.current = authority; authorityGeneration.current++; }
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setSettings(null); setText({}); setMessage("");
    if (!account || account.session.hosted && !owner) return;
    void requestJson<SettingsRead>(walletUrl("/api/settings", "perps")).then(async value => {
      const verified = await fetchAccountForSession(account.session, "perps");
      if (!active) return;
      if (verified.kind !== "ready" || !value || typeof value.values !== "object" || value.values === null || typeof value.version !== "string" || (value.owner?.toLowerCase() !== owner?.toLowerCase())) throw new Error("Settings could not be verified for this account.");
      setSettings(value); setMarkets(value.values.perpsMarkets ?? SETTINGS_DEFAULTS.perpsMarkets); setDriver(value.values.perpsDriver ?? SETTINGS_DEFAULTS.perpsDriver);
    }).catch(error => { if (active) setMessage(error instanceof Error ? error.message : "Could not read Perps settings."); });
    return () => { active = false; };
  }, [owner, account?.session.hosted, !!account, revision]);
  async function save(enabled?: boolean) {
    if (!account || (!settings && enabled !== false) || flight.current) return;
    flight.current = true; setBusy(true); setMessage("");
    const started = authority;
    const startedGeneration = authorityGeneration.current;
    const assertCurrent = () => { if (!mounted.current || currentAuthority.current !== started || authorityGeneration.current !== startedGeneration) throw new Error("Your account changed. Reload before saving settings."); };
    try {
      const current = await fetchAccountForSession(account.session, "perps");
      assertCurrent();
      if (current.kind !== "ready") throw new Error("Your account changed. Reload before saving settings.");
      const body: Record<string, unknown> = { owner: account.session.hosted ? owner : undefined };
      if (enabled !== undefined) {
        body.perpsEnabled = enabled;
        if (enabled) {
          if (driver !== "perp-trend" && driver !== "manual") throw new Error("Choose a supported paper driver before enabling entries.");
          body.expectedVersion = settings!.version; body.perpsDriver = driver;
        }
      } else {
        body.perpsMarkets = markets;
        if (driver !== (settings!.values.perpsDriver ?? SETTINGS_DEFAULTS.perpsDriver)) body.perpsDriver = driver;
        for (const [key, label] of FIELDS) {
          if (text[key] === undefined) continue;
          const raw = text[key]!.trim();
          const value = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
          const bounds = PERPS_NUM_BOUNDS[key];
          if (!Number.isFinite(value) || value < bounds.min || value > bounds.max || Number(value.toFixed(bounds.decimals)) !== value) throw new Error(`${label}: enter ${bounds.min}–${bounds.max}, with at most ${bounds.decimals} decimal places.`);
          body[key] = value;
        }
      }
      await requestJson(walletUrl("/api/settings", "perps"), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assertCurrent();
      setMessage(enabled === false ? "New Perps entries switched off. Held positions keep their protective rules." : enabled === true ? "Paper entries enabled. The worker still applies its risk and signal checks." : "Paper risk settings saved.");
      setRevision(value => value + 1); refresh();
    } catch (error) { if (mounted.current && currentAuthority.current === started && authorityGeneration.current === startedGeneration) setMessage(error instanceof Error ? error.message : "The settings save was not confirmed. Reload before trying again."); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="perps-desk"><h1>Paper Perps settings</h1><PerpsLinks/><p>Settings apply only to your Perps wallet. Leverage magnifies simulated gains and losses. The signed grant remains an additional limit.</p>
    {accountError && <p role="alert">{accountError}</p>}{account?.session.hosted && !owner && <SignIn onDone={refresh}/>}
    {!account && !accountError && <p>Loading your account…</p>}
    {!offered && account && !settings && <button disabled={busy} onClick={() => void save(false)}>Switch entries off</button>}
    {account && settings && settings.owner?.toLowerCase() === owner?.toLowerCase() && <><p>New entries: {settings.values.perpsEnabled ? "enabled" : "off"}. Driver: {settings.values.perpsDriver ?? SETTINGS_DEFAULTS.perpsDriver}.</p><div className="perps-actions"><button disabled={busy || !offered || settings.values.perpsEnabled === true} onClick={() => void save(true)}>Enable paper entries</button><button disabled={busy} onClick={() => void save(false)}>Switch entries off</button></div>{!offered && <p>Paper perpetuals are disabled on this server. Switching entries off and recovery remain available.</p>}
      <label>Paper driver<select value={driver} disabled={busy || !offered} onChange={event => setDriver(event.target.value)}><option value="perp-trend">Deterministic trend rules</option><option value="manual">Manual — no automatic entries</option>{!["perp-trend", "manual"].includes(driver) && <option value={driver} disabled>Unsupported stored driver</option>}</select></label>
      <fieldset disabled={busy || !offered}><legend>Markets the worker may open</legend>{LIGHTER_MARKETS_V1.map(market => <label key={market.key}><input type="checkbox" checked={markets.includes(market.key)} onChange={event => setMarkets(value => event.target.checked ? [...value, market.key] : value.filter(key => key !== market.key))}/>{market.key}</label>)}</fieldset>
      <div className="perps-settings-grid">{FIELDS.map(([key, label]) => <label key={key}>{label}<input inputMode={PERPS_NUM_BOUNDS[key].decimals === 0 ? "numeric" : "decimal"} value={text[key] ?? String(settings.values[key] ?? SETTINGS_DEFAULTS[key])} disabled={busy || !offered} onChange={event => setText(value => ({ ...value, [key]: event.target.value }))}/></label>)}</div>
      <button disabled={busy || !offered} onClick={() => void save()}>Save paper risk settings</button><p>Saving risk settings never switches entries back on. Close all&apos;s halt is lifted only by an explicit practice reset.</p></>}
    {message && <p role="status">{message}</p>}<button disabled={busy} onClick={() => { refresh(); setRevision(value => value + 1); }}>Reload settings</button>
  </section>;
}
