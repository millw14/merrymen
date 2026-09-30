"use client";

/**
 * Where an export's download link lands. The file itself is served by
 * /api/mcp/exports/<id>, which refuses cross-site requests and only answers the
 * owner's own session — so a link clicked inside an AI assistant (a cross-site
 * navigation, which also never carries the SameSite=Strict session cookie)
 * cannot fetch it directly. This page is an ordinary navigation target: it
 * loads, asks the API about the file same-origin, and offers a Download button
 * whose same-origin request carries the owner's session.
 */
import { useCallback, useEffect, useState } from "react";
import { Download, FileText, ShieldCheck } from "lucide-react";
import { count, fullDateTime } from "@/lib/format";
import { SignIn } from "@/terminal/HostedControls";
import { BrandLockup } from "../../BrandLockup";

interface Info {
  id: string;
  kind: string;
  format: string;
  filename: string;
  bytes: number;
  created_at: number;
  expires_at: number;
}

type State =
  | { phase: "loading" }
  | { phase: "signed-out" }
  | { phase: "missing" }
  | { phase: "expired" }
  | { phase: "error"; message: string }
  | { phase: "ready"; info: Info };

export function ExportClient({ id }: { id: string }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const href = `/api/mcp/exports/${encodeURIComponent(id)}`;

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const res = await fetch(`${href}?info=1`, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(30_000) });
      if (res.status === 401) return setState({ phase: "signed-out" });
      if (res.status === 404) return setState({ phase: "missing" });
      if (res.status === 410) return setState({ phase: "expired" });
      if (!res.ok) return setState({ phase: "error", message: `Merrymen could not read this export right now (${res.status}). Try again shortly.` });
      setState({ phase: "ready", info: await res.json() as Info });
    } catch {
      setState({ phase: "error", message: "Merrymen took too long to answer. Check your connection and try again." });
    }
  }, [href]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="terminal-host partner-connect mcp-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> Export</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">PREPARED BY YOUR ASSISTANT</span>
          <h1>Your export.</h1>
          <p>An assistant you connected asked Merrymen to prepare this file. Only you, signed in as the agent’s owner, can download it, and it expires a day after it was made.</p>
        </div>
        <section className="connect-panel" aria-busy={state.phase === "loading"}>
          {state.phase === "loading" && <div className="connect-wait" role="status"><span className="connect-spinner" aria-hidden />Loading…</div>}
          {state.phase === "signed-out" && <><h2>Sign in as the agent’s owner.</h2><SignIn onDone={() => void load()} /></>}
          {state.phase === "missing" && <><h2>No such export for this account.</h2><p className="mcp-note">Check you are signed in as the agent’s owner, or ask your assistant to create a new export.</p></>}
          {state.phase === "expired" && <><h2>This export has expired.</h2><p className="mcp-note">Ask your assistant to create a new one.</p></>}
          {state.phase === "error" && <div className="connect-error" role="alert"><p>{state.message}</p><button onClick={() => void load()}>Try again</button></div>}
          {state.phase === "ready" && <>
            <span className="connect-step-label">{state.info.kind.toUpperCase()} · {state.info.format.toUpperCase()}</span>
            <h2>{state.info.filename}</h2>
            <ul className="mcp-checks">
              <li><label><FileText size={16} aria-hidden /><span><strong>{count(state.info.bytes)} bytes</strong><span>Made {fullDateTime(state.info.created_at * 1000)} · expires {fullDateTime(state.info.expires_at * 1000)}</span></span></label></li>
            </ul>
            <a className="flow-primary" href={href} download={state.info.filename}>Download <Download size={16} aria-hidden /></a>
          </>}
        </section>
      </main>
      <footer className="connect-footer">Manage what your assistants can do at <a href="/connect/apps">Connected apps</a>.</footer>
    </div>
  );
}
