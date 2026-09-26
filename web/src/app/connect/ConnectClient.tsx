"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Link2, ShieldCheck, Unplug } from "lucide-react";
import {
  FundingPanel,
  SignIn,
  requestJson,
  type AccountState,
} from "@/terminal/HostedControls";
import { CreateAgent } from "@/terminal/screens/CreateAgent";
import { loadGrant, type Grant } from "@/lib/session";
import { BrandLockup } from "./BrandLockup";

const TOKEN_STORAGE = "merrymen.partner-connect";

interface Connection {
  id: string;
  partner_name: string;
  name: string;
  scopes: string[];
  status: "pending" | "linked" | "revoked";
  signed_in: boolean;
  has_agent: boolean;
}

const ACCESS: Record<string, { title: string; detail: string }> = {
  "read:agents": { title: "Read your agent’s status", detail: "See its current setup and whether it is ready to work." },
  "chat:agents": { title: "Talk with your agent", detail: "Send messages and receive answers that may include your private portfolio and trade information." },
};

async function connectRequest<T>(body: Record<string, string>): Promise<T> {
  const response = await fetch("/api/partner-connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : data.error?.message;
    throw new Error(message || `Could not complete this request (${response.status}). Try again.`);
  }
  return data as T;
}

async function readAccount(): Promise<AccountState> {
  const [session, status] = await Promise.all([
    requestJson<AccountState["session"]>("/api/auth/session"),
    requestJson<AccountState["status"]>("/api/grants"),
  ]);
  return { session, status };
}

// A grant can already be on the server while its owner is still at the backup
// step. Reloading this page must not turn that into permission to skip backup.
function needsBackup(account: AccountState): boolean {
  const local = loadGrant();
  if (!local || local.smartAccount.toLowerCase() !== account.status.grant?.smartAccount.toLowerCase()) return false;
  return localStorage.getItem(`merrymen.backup.${local.smartAccount.toLowerCase()}`) !== "1";
}

export function ConnectClient() {
  const [token, setToken] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [showFunding, setShowFunding] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const requestVersion = useRef(0);

  useEffect(() => {
    // Fragments are not sent to the server. Keep the credential in this tab
    // through sign-in, and immediately remove it from the address/history bar.
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const supplied = fragment.get("token");
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    let value = supplied;
    try {
      if (supplied !== null) sessionStorage.setItem(TOKEN_STORAGE, supplied);
      else value = sessionStorage.getItem(TOKEN_STORAGE);
    } catch {
      // The current page can still finish when tab storage is unavailable.
    }
    if (!value || value.length > 4096) {
      setToken("");
      setLoading(false);
      setError("Open the connection link from the app you want to use with Merrymen.");
      return;
    }
    setToken(value);
  }, []);

  const refresh = useCallback(async (finishSetup = false) => {
    if (!token) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const next = await connectRequest<Connection>({ action: "inspect", token });
      const nextAccount = next.signed_in ? await readAccount() : null;
      if (version !== requestVersion.current) return;
      setConnection(next);
      setAccount(nextAccount);
      if (next.status === "pending" && nextAccount) {
        const backupPending = needsBackup(nextAccount);
        if (backupPending) setShowSetup(true);
        else if (finishSetup && next.has_agent) setShowSetup(false);
      }
    } catch (cause) {
      if (version === requestVersion.current) {
        setError(cause instanceof Error ? cause.message : "Could not load this connection. Try again.");
      }
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) void refresh();
    return () => { requestVersion.current += 1; };
  }, [token, refresh]);

  const refreshAccount = useCallback(() => {
    void readAccount().then(setAccount).catch(() => {
      setError("Could not refresh your agent. Try again before connecting the app.");
    });
  }, []);

  async function allowAccess() {
    if (!token || !connection || busy || loading) return;
    setBusy(true);
    setError("");
    try {
      await connectRequest<{ connected: true; id: string }>({ action: "connect", token });
      setConnection({ ...connection, status: "linked" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect this app. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!connection || busy) return;
    setBusy(true);
    setError("");
    try {
      await connectRequest({ action: "disconnect", id: connection.id });
      setConnection({ ...connection, status: "revoked" });
      setRemoveConfirm(false);
      try { sessionStorage.removeItem(TOKEN_STORAGE); } catch { /* Optional tab storage. */ }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect this app. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function openFunding(grant: Grant) {
    setAccount(current => current ? { ...current, status: { ...current.status, exists: true, grant } } : current);
    setShowFunding(true);
  }

  function finishSetup() {
    setShowFunding(false);
    void refresh(true);
  }

  const appName = connection?.partner_name || "This app";
  const pending = connection?.status === "pending";
  const needsRenewal = pending && connection.signed_in && !connection.has_agent && account?.status.exists;
  const setup = pending && connection.signed_in && showSetup && !needsRenewal;
  const step = connection?.status === "linked" ? 3 : !connection?.signed_in ? 0 : !connection.has_agent || showSetup ? 1 : 2;

  return (
    <div className="terminal-host partner-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> App connection</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">YOUR AGENT, IN YOUR APPS</span>
          <h1>{connection?.status === "linked" ? "You’re connected." : connection?.status === "revoked" ? "Access is disconnected." : <>Bring your agent<br />along.</>}</h1>
          <p>{connection?.status === "linked"
            ? `${appName} can now use the access you approved. Return to that app to continue.`
            : connection?.status === "revoked"
              ? `${appName} no longer has access through this connection. Your Merrymen agent remains yours.`
              : connection
                ? `${appName} wants to connect with your Merrymen agent. Review the access, then decide.`
                : "Connect an app to your agent with access you choose."}</p>
          {connection && connection.status !== "revoked" && (
            <ol className="connect-progress" aria-label="Connection progress">
              {["Sign in", "Your agent", "Allow access"].map((label, index) => (
                <li key={label} className={step >= index ? "active" : ""} aria-current={step === index ? "step" : undefined}>
                  <span>{step > index ? <Check size={13} aria-hidden /> : index + 1}</span>{label}
                </li>
              ))}
            </ol>
          )}
          {connection && <div className="connect-app"><span className="connect-app-icon"><Link2 size={20} aria-hidden /></span><div><strong>{appName}</strong><span>{connection.name || "Merrymen connection"}</span></div></div>}
        </div>

        <section className={`connect-panel${setup ? " connect-panel-setup" : ""}`} aria-label="Connect your agent" aria-busy={loading || busy}>
          {!connection && loading && <div className="connect-wait" role="status"><span className="connect-spinner" aria-hidden />Checking the connection…</div>}
          {!connection && !loading && <><h2>Start from your app.</h2><p>Ask the app for a new Merrymen connection link, then open it in this browser.</p></>}

          {pending && !connection.signed_in && <>
            <span className="connect-step-label">01 · SIGN IN</span>
            <h2>Make it your agent.</h2>
            <p>Sign in to choose your existing Merrymen agent or set up a new one. You’ll approve {appName}’s access afterward.</p>
            <SignIn onDone={() => void refresh()} />
          </>}

          {needsRenewal && <>
            <span className="connect-step-label">02 · YOUR AGENT</span>
            <h2>Renew your agent’s permission.</h2>
            <p>Your agent already exists, but it needs a current signed permission before it can connect. Review its wallet permissions, then return to this page.</p>
            <a className="flow-primary" href="/grant">Review wallet permissions <ArrowRight size={16} aria-hidden /></a>
            <button className="connect-cancel" disabled={loading} onClick={() => void refresh(true)}>I’ve updated my permission</button>
          </>}

          {pending && connection.signed_in && !connection.has_agent && !showSetup && !needsRenewal && <>
            <span className="connect-step-label">02 · YOUR AGENT</span>
            <h2>Give your agent a home.</h2>
            <p>Choose its name, strategy, and trading limits. You’ll keep control of its wallet and complete the recovery step before connecting {appName}.</p>
            <button className="flow-primary" disabled={loading} onClick={() => setShowSetup(true)}>Set up your agent <ArrowRight size={16} aria-hidden /></button>
          </>}

          {setup && (showFunding && account
            ? <><FundingPanel mode="deposit" account={account} onClose={finishSetup} /><button className="flow-primary" disabled={loading} onClick={finishSetup}>Continue to app access <ArrowRight size={16} aria-hidden /></button></>
            : <><div className="connect-setup-note">Setting up your agent for {appName}. You’ll review app access next.</div><CreateAgent account={account} onRefresh={refreshAccount} onBack={() => setShowSetup(false)} onDone={finishSetup} onFund={openFunding} /></>)}

          {pending && connection.signed_in && connection.has_agent && !showSetup && <>
            <span className="connect-step-label">03 · ALLOW ACCESS</span>
            <h2>Connect to {appName}?</h2>
            <p>This gives the app the following access to your agent:</p>
            <ul className="connect-permissions">{connection.scopes.map(scope => <li key={scope}><Check size={17} aria-hidden /><div><strong>{ACCESS[scope]?.title || scope}</strong><span>{ACCESS[scope]?.detail || "This permission is requested by the app."}</span></div></li>)}</ul>
            <div className="connect-boundary"><ShieldCheck size={19} aria-hidden /><p>Your owner key stays with you. Connecting this app does not change your trading settings or limits. You can disconnect its access here.</p></div>
            <button className="flow-primary" disabled={busy || loading} onClick={() => void allowAccess()}>{busy ? "Connecting…" : `Allow ${appName}`} {!busy && <ArrowRight size={16} aria-hidden />}</button>
            <a className="connect-cancel" href="/">Cancel</a>
          </>}

          {connection?.status === "linked" && <>
            <div className="connect-success-icon"><Check size={25} aria-hidden /></div>
            <h2>Back to {appName}.</h2>
            <p>The connection is ready. Switch back to your original app {connection.scopes.includes("chat:agents") ? "to talk with your agent or check its status." : "to check your agent’s status."}</p>
            <p className="connect-subtle">Connection access is separate from trading. Your agent’s actual readiness and trading mode are shown in Merrymen.</p>
            <a className="flow-primary" href="/agent">View your agent <ArrowRight size={16} aria-hidden /></a>
            <div className="connect-disconnect">
              {removeConfirm ? <><p>Remove {appName}’s access? Your agent will remain in Merrymen.</p><div><button className="connect-danger" disabled={busy} onClick={() => void disconnect()}>{busy ? "Disconnecting…" : "Disconnect app"}</button><button className="connect-cancel" disabled={busy} onClick={() => setRemoveConfirm(false)}>Keep connected</button></div></>
                : <button className="connect-cancel" onClick={() => setRemoveConfirm(true)}><Unplug size={15} aria-hidden /> Disconnect app</button>}
            </div>
          </>}

          {connection?.status === "revoked" && <><Unplug className="connect-revoked-icon" size={30} aria-hidden /><h2>You’re in control.</h2><p>To connect again, request a fresh link from {appName}.</p><a className="flow-primary" href="/agent">Go to your agent <ArrowRight size={16} aria-hidden /></a></>}

          {error && <div className="connect-error" role="alert"><p>{error}</p>{token && <button disabled={loading || busy} onClick={() => void refresh()}>Try again</button>}</div>}
        </section>
      </main>
      <footer className="connect-footer">Built on Merrymen. Controlled by you.</footer>
    </div>
  );
}
