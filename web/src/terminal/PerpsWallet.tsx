"use client";

import { useEffect, useRef, useState } from "react";
import { createPrivyOwnedWallet, loadGrant, localGrantsSnapshot, preflightAgentGrant, retryGrantHandoff, sameGrantPermission, type Grant, type GrantCaps } from "../lib/session";
import { loadRecoveryGrants, saveRecoveryGrant, trustedSavedGrant } from "../lib/saved-grant-binding";
import { needsPermissionReplacement, markPermissionForReplacement } from "../lib/permission-replacement";
import { renewalSkipsRevocation } from "../lib/perps-renewal";
import { stopAgentForReplacement } from "../lib/stop-agent";
import { assertRevocationFunded, revokeFromBrowser } from "../lib/revoke-client";
import { walletUrl } from "../lib/wallet-param";
import { fullDateTime } from "../lib/format";
import { fetchAccountForSession } from "./account-session";
import { guardPerpsSigner } from "./perps-client";
import { requestJson } from "./request-json";
import { usePerpsAccount } from "./usePerpsAccount";
import { PRIVY_BETA, SignIn } from "./HostedControls";
import { usePrivyOwner, type PrivyOwner } from "./usePrivyOwner";
import { PerpsLinks } from "./PerpsScreen";
import "./perps-desk.css";

const DEFAULT_CAPS: GrantCaps = { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 7, maxDrawdownPct: 10, maxOpsPerDay: 48 };
const CAP_FIELDS: [keyof GrantCaps, string, number, number][] = [["perTradeUsdg", "Per-trade limit (USDG)", 1, 100_000], ["dailyUsdg", "Daily limit (USDG)", 1, 100_000], ["expiryDays", "Permission lifetime (days)", 1, 90], ["maxDrawdownPct", "Maximum drawdown (%)", 1, 50], ["maxOpsPerDay", "Maximum operations per day", 1, 10_000]];
async function requirePaperOffering() {
  const result = await requestJson<{ offered: boolean; mode: string }>(walletUrl("/api/perps/offered", "perps"));
  if (result?.offered !== true || result.mode !== "paper") throw new Error("Paper Perps wallets are not offered here. Nothing was stopped or signed.");
}
export function PerpsWallet({ offered, creating = false }: { offered: boolean; creating?: boolean }) {
  return PRIVY_BETA ? <PrivyPerpsWallet offered={offered} creating={creating}/> : <PerpsWalletView offered={offered} creating={creating} signer={null}/>;
}
function PrivyPerpsWallet(props: { offered: boolean; creating: boolean }) {
  return <PerpsWalletView {...props} signer={usePrivyOwner()}/>;
}

export function PerpsWalletView({ offered, creating, signer }: { offered: boolean; creating: boolean; signer: PrivyOwner | null }) {
  const { account, busy: reading, error: readError, refresh } = usePerpsAccount(false);
  const [saved, setSaved] = useState<Grant | null>(null);
  const [savedRead, setSavedRead] = useState(false);
  const [caps, setCaps] = useState<Record<keyof GrantCaps, string>>({ perTradeUsdg: "25", dailyUsdg: "100", expiryDays: "7", maxDrawdownPct: "10", maxOpsPerDay: "48" });
  const [ack, setAck] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const owner = account?.session.address ?? null;
  const identity = `${account?.session.hosted}:${owner}:${account?.status.grant?.sessionKeyAddress ?? ""}`;
  const authority = `${account?.session.hosted}:${owner}:${signer?.account.address}:${signer?.did}`;
  const currentIdentity = useRef(authority);
  const authorityGeneration = useRef(0);
  if (currentIdentity.current !== authority) { currentIdentity.current = authority; authorityGeneration.current++; }
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setSaved(null); setSavedRead(false); setAck(false);
    if (!account) return;
    void (async () => {
      const local = loadGrant("perps");
      const candidates = [local, ...loadRecoveryGrants("perps"), account.status.grant as Grant | undefined];
      for (const candidate of candidates) {
        if (candidate?.purpose === "perps" && candidate.chainId === 4663 && candidate.owner?.toLowerCase() === (account.session.hosted ? owner : signer?.account.address)?.toLowerCase() && (!candidate.binding?.ownerSignature || await trustedSavedGrant(candidate, account.session, window.location.origin))) {
          if (account.status.grant && !sameGrantPermission(account.status.grant, candidate)) continue;
          if (active) { setSaved(candidate); setCaps(Object.fromEntries(CAP_FIELDS.map(([key]) => [key, String(candidate.caps[key] ?? DEFAULT_CAPS[key])])) as Record<keyof GrantCaps, string>); }
          break;
        }
      }
      if (active) setSavedRead(true);
    })().catch(() => { if (active) setMessage("Saved wallet details could not be verified. Keep recovery access and reload before signing."); });
    return () => { active = false; };
  }, [identity, !!account, signer?.account.address]);

  async function checkedAccount() {
    if (!account) throw new Error("Reload your account before signing.");
    const result = await fetchAccountForSession(account.session, "perps");
    if (result.kind !== "ready") throw new Error("Your signed-in account changed. Reload before signing.");
    if (!signer || result.account.session.hosted && signer.account.address.toLowerCase() !== result.account.session.address?.toLowerCase()) throw new Error("Wait for the protected signing wallet for this account.");
    return result.account;
  }
  async function sign() {
    if (!account || !signer || !ack || flight.current || !savedRead || !offered) return;
    flight.current = true; setBusy(true); setMessage("");
    const startingIdentity = authority;
    const startedGeneration = authorityGeneration.current;
    let stopped = false;
    const assertCurrent = () => { if (!mounted.current || currentIdentity.current !== startingIdentity || authorityGeneration.current !== startedGeneration) throw new Error("Your account changed while preparing this permission. Reload before continuing."); };
    const ownerSigner = guardPerpsSigner(signer.account, assertCurrent);
    try {
      await requirePaperOffering();
      const current = await checkedAccount(); assertCurrent();
      const chosen = {} as GrantCaps;
      for (const [key, label, min, max] of CAP_FIELDS) {
        const raw = caps[key].trim(), value = /^\d+(?:\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isFinite(value) || value < min || value > max || !["perTradeUsdg", "dailyUsdg"].includes(key) && !Number.isInteger(value)) throw new Error(`${label}: enter a valid number from ${min} to ${max}.`);
        chosen[key] = value;
      }
      if (chosen.perTradeUsdg > chosen.dailyUsdg) throw new Error("The per-trade limit must not exceed the daily limit.");
      const previous = current.status.exists ? current.status.grant : null;
      if (saved && (saved.purpose !== "perps" || saved.owner.toLowerCase() !== signer.account.address.toLowerCase() || (saved.binding?.ownerSignature && !await trustedSavedGrant(saved, current.session, window.location.origin)))) throw new Error("The signing wallet does not own this saved Perps permission.");
      if (previous && (!saved || !sameGrantPermission(previous, saved))) throw new Error("The active Perps permission changed. Reload to review it.");
      const snapshots = localGrantsSnapshot("perps");
      if (!saved && (snapshots.current || (snapshots.archived?.length ?? 0))) throw new Error("A saved Perps wallet needs review. Open Wallet & permission before creating a new permission.");
      const options = { purpose: "perps" as const, chainId: 4663, caps: chosen, onStatus: (value: string) => { assertCurrent(); setStatus(value); }, assertCurrent, beforeCommit: async () => { await requirePaperOffering(); await checkedAccount(); assertCurrent(); }, hostedAs: current.session.hosted ? current.session.address as `0x${string}` : undefined,
        ...(saved ? { expectAccount: saved.smartAccount as `0x${string}` } : {}), previousGrant: previous, localGrants: snapshots };
      await preflightAgentGrant(ownerSigner, options); assertCurrent();
      const skip = !!saved && renewalSkipsRevocation(saved) && (previous === null || renewalSkipsRevocation(previous));
      const wallet = saved ? { smartAccount: saved.smartAccount as `0x${string}`, chainId: saved.chainId, ownerAccount: ownerSigner, purpose: "perps" as const } : null;
      if (wallet && !skip) await assertRevocationFunded(wallet);
      // The gate and identity are rechecked after potentially slow chain reads, before stopping anything.
      await requirePaperOffering();
      const beforeStop = await checkedAccount(); assertCurrent();
      if (beforeStop.status.exists !== current.status.exists || beforeStop.status.exists && !sameGrantPermission(beforeStop.status.grant, current.status.grant!)) throw new Error("The active Perps permission changed during preflight. Reload before continuing.");
      let minimumValidationNonce: number | undefined;
      if (saved) {
        saveRecoveryGrant(saved); markPermissionForReplacement(saved);
        await stopAgentForReplacement("perps", current.session.hosted ? current.session.address : undefined, saved.smartAccount, saved.sessionKeyAddress);
        stopped = true; assertCurrent();
        if (!skip && wallet) minimumValidationNonce = (await revokeFromBrowser(wallet, setStatus)).validNonceFrom;
      }
      await checkedAccount(); assertCurrent();
      const result = await createPrivyOwnedWallet(ownerSigner, signer.did, { ...options, minimumValidationNonce });
      assertCurrent();
      if (mounted.current) { setSaved(result.local); setMessage(result.handoff.ok ? "Paper permission activated. Open Perps settings to explicitly enable or adjust paper entries." : result.handoff.error ?? "Your signed permission is saved, but activation was not confirmed. Review and retry activation below."); setAck(false); refresh(); }
    } catch (error) { if (mounted.current && currentIdentity.current === startingIdentity && authorityGeneration.current === startedGeneration) setMessage(`${stopped ? "The old Perps permission was stopped. Its saved recovery record was kept. " : ""}${error instanceof Error ? error.message : "The permission could not be activated."}`); }
    finally { flight.current = false; if (mounted.current) { setBusy(false); setStatus(""); } }
  }
  async function activate() {
    if (!account || !saved || !signer || flight.current || !offered) return;
    flight.current = true; setBusy(true); setMessage("");
    const startingIdentity = authority;
    const startedGeneration = authorityGeneration.current;
    const assertCurrent = () => { if (!mounted.current || currentIdentity.current !== startingIdentity || authorityGeneration.current !== startedGeneration) throw new Error("Your account changed while activating this permission. Reload before continuing."); };
    const ownerSigner = guardPerpsSigner(signer.account, assertCurrent);
    try {
      await requirePaperOffering();
      const current = await checkedAccount(); assertCurrent();
      if (needsPermissionReplacement(saved)) throw new Error("This permission was selected for replacement. Renew it; it must not be activated again.");
      if (current.status.exists && !sameGrantPermission(current.status.grant, saved)) throw new Error("Another Perps permission is active. Reload before continuing.");
      const proof = { tenant: current.session.address as `0x${string}`, ownerSigner: { account: ownerSigner, binding: "privy-did-owner-v1" as const, did: signer.did }, beforeSubmit: async () => {
        assertCurrent();
        await requirePaperOffering();
        const latest = await checkedAccount(); assertCurrent();
        if ((latest.session.hosted && !await trustedSavedGrant(saved, latest.session, window.location.origin)) || needsPermissionReplacement(saved) || latest.status.exists && !sameGrantPermission(latest.status.grant, saved)) throw new Error("This permission changed while you confirmed it. Reload before continuing.");
      } };
      if (!current.session.hosted) await proof.beforeSubmit();
      assertCurrent();
      const result = await retryGrantHandoff(saved, current.session.hosted ? proof : undefined, assertCurrent);
      assertCurrent();
      setMessage(result.ok ? "The paper permission is activated. Its settings are unchanged." : result.error ?? "Activation was not confirmed."); refresh();
    } catch (error) { if (mounted.current && currentIdentity.current === startingIdentity && authorityGeneration.current === startedGeneration) setMessage(error instanceof Error ? error.message : "Activation was not confirmed."); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  const signedOut = account?.session.hosted && !owner;
  return <section className="perps-desk"><h1>{creating && !saved ? "Create a paper Perps wallet" : "Perps wallet & permission"}</h1><PerpsLinks/><p>A separate account owned by your protected signing wallet. This paper permission cannot spend on-chain. No deposit or live trading is required.</p>
    {!offered && <p role="status">Paper Perps creation and renewal are disabled on this server. Withdrawal and recovery remain available.</p>}
    {(reading && !account) && <p>Checking your wallet…</p>}{readError && <p role="alert">{readError}</p>}
    {signedOut && <SignIn onDone={refresh}/>}
    {account && !signedOut && !signer && <p>Your protected signing wallet is not ready. {PRIVY_BETA ? "Sign in with the account that owns this wallet and wait for it to become ready." : "Protected wallet sign-in is not configured on this installation."}</p>}
    {saved && <><p className="perps-address">Perps account <code>{saved.smartAccount}</code></p><p>Owner <code>{saved.owner}</code></p><p>Permission expires {fullDateTime(saved.expiresAt * 1000)}.</p></>}
    {account && !signedOut && <><div className="perps-settings-grid">{CAP_FIELDS.map(([key, label]) => <label key={key}>{label}<input inputMode={key === "perTradeUsdg" || key === "dailyUsdg" ? "decimal" : "numeric"} value={caps[key]} disabled={busy || !offered} onChange={event => setCaps(value => ({ ...value, [key]: event.target.value }))}/></label>)}</div><label><input type="checkbox" checked={ack} disabled={busy || !offered} onChange={event => setAck(event.target.checked)}/>{saved ? "I want to replace this Perps permission with the limits above. Recovery access stays with the same owner." : "I understand this is simulated trading and my sign-in controls the separate Perps wallet."}</label><button disabled={!offered || !signer || !savedRead || !ack || busy} onClick={() => void sign()}>{busy ? "Working…" : saved ? "Renew paper Perps permission" : "Create paper Perps wallet"}</button>
      {saved?.serialized && saved.demoSessionPrivateKey && !account.status.exists && !needsPermissionReplacement(saved) && <button disabled={!offered || !signer || busy} onClick={() => void activate()}>Retry saved permission activation</button>}</>}
    {status && <p role="status">{status}</p>}{message && <p role="status">{message}</p>}<p><a href="/withdraw?wallet=perps">Withdraw or recover this wallet</a></p>
  </section>;
}
