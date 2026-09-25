"use client";

/**
 * The MCP consent screen. An AI assistant (Claude, Codex, …) sent the owner
 * here to ask for access. The owner signs in with their own Merrymen account,
 * sees exactly who is asking and what they would allow, picks the agents and
 * permissions, and approves or declines. Approving sends the browser back to
 * the assistant with a one-time code; nothing here moves funds or changes the
 * agent.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, Cpu, Laptop, ShieldCheck, Unplug } from "lucide-react";
import { SignIn } from "@/terminal/HostedControls";
import { BrandLockup } from "../BrandLockup";

const STORAGE = "merrymen.mcp-consent";

interface ScopeView { id: string; title: string; detail: string; level: "read" | "write" | "sensitive" | "staff"; needsAgent: boolean; defaultOn: boolean }
interface ConsentView {
  client: { name: string | null; host: string; registration: "metadata-document" | "dynamic"; redirectHost: string; local: boolean };
  scopes: ScopeView[];
  agents: Array<{ slug: string; account: string | null }>;
  signedIn: boolean;
  expiresAt: number;
  /** A connection lasts at most this many days before the owner approves it again. */
  maxDays?: number;
}

async function consent<T>(body: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/mcp/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Merrymen took too long to answer. Check your connection and try again.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error_description === "string" ? data.error_description : `Could not load this request (${response.status}).`);
  return data as T;
}

const LEVEL_LABEL: Record<ScopeView["level"], string> = { read: "Read", write: "Change", sensitive: "Needs your approval each time", staff: "Staff" };

export function ConsentClient() {
  const [request, setRequest] = useState<string | null>(null);
  const [view, setView] = useState<ConsentView | null>(null);
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [agents, setAgents] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"approved" | "declined" | null>(null);
  const [error, setError] = useState("");
  const version = useRef(0);

  useEffect(() => {
    // The request handle arrives in the fragment (never sent to a server or a
    // Referer). Keep it for this tab through sign-in, and clear the address bar.
    const supplied = new URLSearchParams(window.location.hash.slice(1)).get("request");
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    let value = supplied;
    try {
      if (supplied) sessionStorage.setItem(STORAGE, supplied);
      else value = sessionStorage.getItem(STORAGE);
    } catch { /* tab storage is optional */ }
    if (!value || value.length > 200) {
      setLoading(false);
      setError("Start the connection from your AI assistant (for example “Add connector” in Claude, or `codex mcp login merrymen`). This page opens by itself.");
      return;
    }
    setRequest(value);
  }, []);

  const load = useCallback(async () => {
    if (!request) return;
    const v = ++version.current;
    setLoading(true);
    setError("");
    try {
      const next = await consent<ConsentView>({ action: "describe", request });
      if (v !== version.current) return;
      setView(next);
      setScopes(new Set(next.scopes.filter((s) => s.defaultOn).map((s) => s.id)));
      setAgents(new Set(next.agents.map((a) => a.slug)));
    } catch (cause) {
      if (v === version.current) setError(cause instanceof Error ? cause.message : "Could not load this request.");
    } finally {
      if (v === version.current) setLoading(false);
    }
  }, [request]);

  useEffect(() => { if (request) void load(); }, [request, load]);

  async function decide(approve: boolean) {
    if (!request || busy) return;
    setBusy(true);
    setError("");
    try {
      const out = await consent<{ redirect: string }>({ action: "decide", request, approve, scopes: [...scopes], agents: [...agents] });
      try { sessionStorage.removeItem(STORAGE); } catch { /* optional */ }
      setDone(approve ? "approved" : "declined");
      window.location.assign(out.redirect);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not complete this. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const toggle = (set: Set<string>, id: string, update: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    update(next);
  };

  const appName = view?.client.name ?? view?.client.host ?? "An AI assistant";
  const noAgent = !!view && view.signedIn && view.agents.length === 0;
  // The server never offers offline_access (it controls nothing: every
  // connection can refresh until it is disconnected or reaches its limit).
  // Filtered here too, so an older server can never show it as a choice.
  const visibleScopes = view ? view.scopes.filter((s) => s.id !== "offline_access") : [];
  const chosenUseful = [...scopes].some((s) => s !== "offline_access" && (agents.size > 0 || !view?.scopes.find((x) => x.id === s)?.needsAgent));

  return (
    <div className="terminal-host partner-connect mcp-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> AI assistant connection</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">YOUR AGENT, IN YOUR ASSISTANT</span>
          <h1>{done === "approved" ? "Connected." : done === "declined" ? "Declined." : <>Connect your<br />assistant.</>}</h1>
          <p>{done ? "Returning you to your assistant…" : "Review who is asking and what they could do. You can change your mind at any time on the Connected apps page."}</p>
          {view && (
            <div className="connect-app">
              <span className="connect-app-icon">{view.client.local ? <Laptop size={20} aria-hidden /> : <Cpu size={20} aria-hidden />}</span>
              <div>
                <strong>{appName}</strong>
                <span>{view.client.registration === "metadata-document" ? `Verified at ${view.client.host}` : `Registered app — not verified by Merrymen`}</span>
                <span>Returns to <b className="mcp-host">{view.client.redirectHost}</b>{view.client.local ? " (a program on this computer)" : ""}</span>
              </div>
            </div>
          )}
        </div>

        <section className="connect-panel" aria-label="Approve access" aria-busy={loading || busy}>
          {loading && <div className="connect-wait" role="status"><span className="connect-spinner" aria-hidden />Checking the request…</div>}

          {!loading && view && !view.signedIn && <>
            <span className="connect-step-label">01 · SIGN IN</span>
            <h2>Sign in to Merrymen.</h2>
            <p>{appName} wants to connect to your Merrymen. Sign in first; you will review exactly what it could do before anything is shared.</p>
            <SignIn onDone={() => void load()} />
          </>}

          {!loading && view && view.signedIn && !done && <>
            <span className="connect-step-label">02 · CHOOSE ACCESS</span>
            <h2>Allow {appName}?</h2>
            {view.client.registration === "dynamic" && <div className="connect-boundary mcp-warn"><AlertTriangle size={18} aria-hidden /><p>Merrymen cannot confirm who made this app. Only continue if you just started this connection yourself and recognise <b>{view.client.redirectHost}</b>.</p></div>}

            <h3 className="mcp-subhead">Agents it can see</h3>
            {noAgent
              ? <p className="mcp-note">You don’t have an agent yet, so only market research can be shared. You can reconnect after creating one.</p>
              : <ul className="mcp-checks">{view.agents.map((a) => (
                <li key={a.slug}><label><input type="checkbox" checked={agents.has(a.slug)} onChange={() => toggle(agents, a.slug, setAgents)} />
                  <span><strong>Agent {a.slug}</strong><span>{a.account ? `Account ${a.account.slice(0, 6)}…${a.account.slice(-4)}` : "No trading permission signed yet"}</span></span></label></li>))}</ul>}

            <h3 className="mcp-subhead">What it can do</h3>
            <ul className="mcp-checks">{visibleScopes.map((s) => {
              const disabled = s.needsAgent && agents.size === 0;
              return (
                <li key={s.id} className={s.level === "sensitive" ? "mcp-sensitive" : ""}>
                  <label>
                    <input type="checkbox" disabled={disabled} checked={scopes.has(s.id) && !disabled} onChange={() => toggle(scopes, s.id, setScopes)} />
                    <span><strong>{s.title} <em className={`mcp-level mcp-level-${s.level}`}>{LEVEL_LABEL[s.level]}</em></strong><span>{s.detail}</span></span>
                  </label>
                </li>
              );
            })}</ul>

            <div className="connect-boundary"><ShieldCheck size={19} aria-hidden /><p>
              {appName} can never move your funds, see your keys, turn on live trading or loosen your limits. Trades and setting changes it suggests only happen if you approve them in Merrymen, and your agent keeps running on its own whether or not the assistant is connected. It stays connected until you disconnect it{view.maxDays ? `, for at most ${view.maxDays} days before you are asked again` : ""}. Disconnect it any time at <a href="/connect/apps">Connected apps</a>; that ends its access at once.
            </p></div>

            <button className="flow-primary" disabled={busy || !chosenUseful} onClick={() => void decide(true)}>{busy ? "Connecting…" : `Allow ${appName}`} {!busy && <ArrowRight size={16} aria-hidden />}</button>
            <button className="connect-cancel" disabled={busy} onClick={() => void decide(false)}><Unplug size={15} aria-hidden /> Decline</button>
          </>}

          {done && <><div className="connect-success-icon"><Check size={25} aria-hidden /></div><h2>{done === "approved" ? `Back to ${appName}.` : "Nothing was shared."}</h2><p>If your assistant doesn’t open, switch back to it yourself.</p></>}

          {error && <div className="connect-error" role="alert"><p>{error}</p>{request && <button disabled={loading || busy} onClick={() => void load()}>Try again</button>}</div>}
        </section>
      </main>
      <footer className="connect-footer">Merrymen stays the source of truth. Assistants only get the access you choose here.</footer>
    </div>
  );
}
