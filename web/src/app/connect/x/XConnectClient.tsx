"use client";

/**
 * WHERE X SENDS AN OWNER BACK AFTER THEY APPROVE (OR DON'T) — the one
 * registered callback, `${MERRYMEN_PUBLIC_ORIGIN}/connect/x`.
 *
 * A PAGE, NOT AN API ROUTE, and that is forced: the middleware refuses a
 * cross-site request on /api/*, and the SameSite=Strict session cookie is not
 * sent on a navigation that started at x.com. A page loads anyway; its own
 * same-origin POST then carries the session, and the finish route checks that
 * session against the owner who started the connect.
 *
 * THE CODE LEAVES THE ADDRESS BAR FIRST. It is read once and the URL is
 * scrubbed with history.replaceState before anything else happens, so it is
 * not left in history, a bookmark or a screenshot; next.config.mjs sends this
 * path no-referrer and forbids framing, so it cannot leak through a Referer or
 * be clickjacked either.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: retry. The finish spends the pending
 * connect on its first arrival and X's code lives about thirty seconds, so a
 * second try can only fail; the owner is sent back to Settings to start again.
 *
 * IT SAYS POSTING IS ON ONLY WHEN THE FINISH SAYS SO. Connecting is not
 * consent, and the Settings switch, behind its warning, is the only way on —
 * but a reconnect of the SAME X account after X revoked it keeps the consent
 * the owner already gave that account, so posting resumes from the next pass.
 * The finish reads back `postingEnabled` after its write; when it is true the
 * page says posting is back on, and never "won't post anything yet".
 */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { xHandleTag } from "@/lib/x-handle";
import { BrandLockup } from "../BrandLockup";
import { readCallback } from "./callback";

type Phase =
  | { kind: "working" }
  | { kind: "handoff"; href: string }
  | { kind: "connected"; handle: string | null; postingEnabled: boolean }
  | { kind: "declined" }
  | { kind: "nothing" }
  | { kind: "failed"; message: string };

const SETTINGS = "/settings#x-posting";

async function finishConnect(code: string, state: string): Promise<Phase> {
  let res: Response;
  try {
    res = await fetch("/api/x/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "finish", code, state }),
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { kind: "failed", message: "Couldn't reach merrymen to finish connecting X. Start again from Settings." };
  }
  const data = (await res.json().catch(() => null)) as
    | { ok?: unknown; username?: unknown; postingEnabled?: unknown; error?: unknown }
    | null;
  if (res.ok && data?.ok === true) {
    return {
      kind: "connected",
      handle: xHandleTag(typeof data.username === "string" ? data.username : null),
      // Only a plain true is "on"; an older server's answer without it is off.
      postingEnabled: data.postingEnabled === true,
    };
  }
  if (res.status === 401) {
    return { kind: "failed", message: "Sign in to merrymen in this browser, then connect X again from Settings." };
  }
  // The route's sentences are written for owners and never carry what X said.
  if (typeof data?.error === "string" && data.error) return { kind: "failed", message: data.error };
  return { kind: "failed", message: `Couldn't finish connecting X (${res.status}). Start again from Settings.` };
}

export function XConnectClient() {
  const [phase, setPhase] = useState<Phase>({ kind: "working" });
  // Once per page load, including under StrictMode's double effect: the URL
  // is scrubbed on the first run, and a second finish could only be refused.
  const began = useRef(false);

  useEffect(() => {
    if (began.current) return;
    began.current = true;
    const callback = readCallback(window.location.search);
    if (window.location.search || window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    if (callback.kind === "ios") {
      setPhase({ kind: "handoff", href: callback.href });
      window.location.replace(callback.href);
      return;
    }
    if (callback.kind === "declined" || callback.kind === "nothing") {
      setPhase({ kind: callback.kind });
      return;
    }
    if (callback.kind === "failed") {
      setPhase(callback);
      return;
    }
    // No cleanup that drops the answer: under StrictMode the effect's first
    // run is torn down and the second returns early above, so a "still
    // mounted?" flag here would leave the page on "Finishing…" for good. A
    // state update after a real unmount is a no-op.
    void finishConnect(callback.code, callback.state).then(setPhase);
  }, []);

  return (
    <div className="terminal-host partner-connect mcp-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> Posting on X</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">YOUR MERRYMAN, ON X</span>
          <h1>Connect X.</h1>
          <p>Your Merryman posts only after you turn posting on in Settings. Each post then waits there under Coming up for at least ten minutes, and you can skip it.</p>
        </div>
        <section className="connect-panel" aria-busy={phase.kind === "working"} aria-live="polite">
          {phase.kind === "working" && (
            <div className="connect-wait" role="status"><span className="connect-spinner" aria-hidden />Finishing with X…</div>
          )}
          {phase.kind === "handoff" && (
            <>
              <h2>Back to the merrymen app…</h2>
              <p>If the app doesn&apos;t open by itself, <a href={phase.href}>open it here</a>.</p>
            </>
          )}
          {phase.kind === "connected" && (
            <>
              <h2>{phase.handle ? `Connected as ${phase.handle}` : "Connected."}</h2>
              {phase.postingEnabled ? (
                <p>
                  Posting is back on: you allowed your Merryman to post from {phase.handle ?? "this account"} before, so it
                  posts from it again. Each post waits under Coming up in Settings for at least ten minutes, where you can
                  skip it or turn posting off.
                </p>
              ) : (
                <p>Your Merryman won&apos;t post anything yet. Turn posting on in Settings when you&apos;re ready — you&apos;ll see exactly which account it posts from first.</p>
              )}
              <a className="flow-primary" href={SETTINGS}><ArrowLeft size={16} aria-hidden /> Back to Settings</a>
            </>
          )}
          {phase.kind === "declined" && (
            <>
              <h2>You didn&apos;t connect an X account.</h2>
              <p>Nothing was saved. You can connect one any time from Settings.</p>
              <a className="flow-primary" href={SETTINGS}><ArrowLeft size={16} aria-hidden /> Back to Settings</a>
            </>
          )}
          {phase.kind === "nothing" && (
            <>
              <h2>Nothing to finish here.</h2>
              <p>This page finishes connecting an X account. Start from Settings.</p>
              <a className="flow-primary" href={SETTINGS}><ArrowLeft size={16} aria-hidden /> Go to Settings</a>
            </>
          )}
          {phase.kind === "failed" && (
            <>
              <h2>X isn&apos;t connected.</h2>
              <div className="connect-error" role="alert"><p>{phase.message}</p></div>
              <a className="flow-primary" style={{ marginTop: 20 }} href={SETTINGS}><ArrowLeft size={16} aria-hidden /> Back to Settings</a>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
