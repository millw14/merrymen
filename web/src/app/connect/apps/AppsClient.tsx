"use client";

/**
 * Connected apps: every AI assistant connection and personal access token that
 * can reach this owner's Merrymen, what each may do, what it did recently, and
 * a Disconnect button that takes effect on the assistant's next request.
 */
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plug, ShieldCheck, Unplug } from "lucide-react";
import { SignIn } from "@/terminal/HostedControls";
import { BrandLockup } from "../BrandLockup";

interface ScopeTag { id: string; title: string; level: string }
interface Connection {
  id: string;
  kind: "oauth" | "personal";
  clientName: string | null;
  clientHost: string | null;
  clientId: string;
  scopes: ScopeTag[];
  agentSlugs: string[];
  createdAt: number;
  lastUsedAt: number | null;
  recent: Array<{ action: string; outcome: string; at: number }>;
}
interface AvailableScope { id: string; title: string; detail: string; level: string; needsAgent: boolean }
interface Listing { endpoint: string; connections: Connection[]; agents: Array<{ slug: string; account: string | null }>; available_scopes: AvailableScope[] }

const when = (sec: number | null) => sec ? new Date(sec * 1000).toLocaleString() : "never";

async function call<T>(method: "GET" | "POST", body?: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/mcp/connections", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw Object.assign(new Error("signed-out"), { signedOut: true });
  if (!response.ok) throw new Error(typeof data.error_description === "string" ? data.error_description : `Request failed (${response.status}).`);
  return data as T;
}

export function AppsClient() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("Codex on my laptop");
  const [days, setDays] = useState(30);
  const [tokenScopes, setTokenScopes] = useState<Set<string>>(new Set(["market:read", "agents:read", "portfolio:read", "decisions:read"]));
  const [issued, setIssued] = useState<{ token: string; expires_at: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setListing(await call<Listing>("GET"));
      setSignedOut(false);
    } catch (e) {
      if ((e as { signedOut?: boolean }).signedOut) setSignedOut(true);
      else setError(e instanceof Error ? e.message : "Could not load your connections.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function revoke(id: string) {
    setBusy(id);
    setError("");
    try {
      await call("POST", { action: "revoke", id });
      setConfirm(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect.");
    } finally {
      setBusy(null);
    }
  }

  async function createToken() {
    setBusy("create");
    setError("");
    try {
      const agents = listing?.agents.map((a) => a.slug) ?? [];
      const out = await call<{ token: string; expires_at: number }>("POST", { action: "create_token", label, days, scopes: [...tokenScopes], agents });
      setIssued(out);
      setCreating(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the token.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="terminal-host partner-connect mcp-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> Connected apps</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">WHO CAN REACH YOUR AGENT</span>
          <h1>Connected<br />apps.</h1>
          <p>AI assistants you connected (Claude, Codex and others) and personal access tokens. Disconnecting takes effect on the app’s next request. Your agent keeps running either way.</p>
          {listing && <p className="mcp-note">Server address: <code>{listing.endpoint}</code> · <a href="/connect/mcp">How to connect</a></p>}
        </div>
        <section className="connect-panel" aria-busy={loading}>
          {loading && <div className="connect-wait" role="status"><span className="connect-spinner" aria-hidden />Loading…</div>}
          {!loading && signedOut && <><h2>Sign in to see your connected apps.</h2><SignIn onDone={() => void load()} /></>}
          {!loading && listing && <>
            {listing.connections.length === 0 && <p className="mcp-note">Nothing is connected. Add Merrymen to your assistant with the server address on the left.</p>}
            <ul className="mcp-apps">{listing.connections.map((c) => (
              <li key={c.id} className="mcp-app">
                <header>
                  <div>
                    <h3>{c.kind === "personal" ? <><KeyRound size={14} aria-hidden /> {c.clientName ?? "Personal token"}</> : <><Plug size={14} aria-hidden /> {c.clientName ?? c.clientHost ?? "AI assistant"}</>}</h3>
                    <div className="mcp-meta">{c.kind === "personal" ? "Personal access token" : `via ${c.clientHost ?? c.clientId}`} · connected {when(c.createdAt)} · last used {when(c.lastUsedAt)}</div>
                    <div className="mcp-meta">Agents: {c.agentSlugs.length ? c.agentSlugs.join(", ") : "none (research only)"}</div>
                  </div>
                </header>
                <ul className="mcp-tags">{c.scopes.filter((s) => s.id !== "offline_access").map((s) => <li key={s.id} className={s.level === "sensitive" ? "sensitive" : ""}>{s.title}</li>)}</ul>
                {c.recent.length > 0 && <details><summary>Recent activity</summary><ul className="mcp-activity">{c.recent.map((r, i) => <li key={i}>{when(r.at)} · {r.action.replace(/^tool:/, "")} · {r.outcome}</li>)}</ul></details>}
                {confirm === c.id
                  ? <div className="connect-disconnect"><p>Disconnect {c.clientName ?? "this app"}? It will stop working immediately.</p><div><button className="connect-danger" disabled={busy === c.id} onClick={() => void revoke(c.id)}>{busy === c.id ? "Disconnecting…" : "Disconnect"}</button><button className="connect-cancel" onClick={() => setConfirm(null)}>Keep</button></div></div>
                  : <button className="connect-cancel" onClick={() => setConfirm(c.id)}><Unplug size={15} aria-hidden /> Disconnect</button>}
              </li>
            ))}</ul>

            {issued && <div className="connect-boundary"><KeyRound size={18} aria-hidden /><div><p>Copy this token now; it won’t be shown again. It expires {when(issued.expires_at)}.</p><p className="mcp-token">{issued.token}</p></div></div>}

            {creating
              ? <div className="mcp-app">
                <h3>New personal access token</h3>
                <p className="mcp-note">For assistants that can’t sign in through a browser. It can only do what you tick, only for your own agent, and expires on its own.</p>
                <label className="mcp-field">Name<input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} /></label>
                <label className="mcp-field">Expires after<select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
                <ul className="mcp-checks">{listing.available_scopes.map((s) => (
                  <li key={s.id}><label><input type="checkbox" checked={tokenScopes.has(s.id)} onChange={() => { const n = new Set(tokenScopes); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); setTokenScopes(n); }} /><span><strong>{s.title}</strong><span>{s.detail}</span></span></label></li>
                ))}</ul>
                <button className="flow-primary" disabled={busy === "create" || !tokenScopes.size} onClick={() => void createToken()}>{busy === "create" ? "Creating…" : "Create token"}</button>
                <button className="connect-cancel" onClick={() => setCreating(false)}>Cancel</button>
              </div>
              : <button className="connect-cancel" onClick={() => { setCreating(true); setIssued(null); }}><KeyRound size={15} aria-hidden /> Create a personal access token</button>}
          </>}
          {error && <div className="connect-error" role="alert"><p>{error}</p><button onClick={() => void load()}>Try again</button></div>}
        </section>
      </main>
      <footer className="connect-footer">Merrymen never shares your keys or moves funds for a connected app.</footer>
    </div>
  );
}
