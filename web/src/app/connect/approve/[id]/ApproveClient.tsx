"use client";

/**
 * The owner's approval screen for something an AI assistant prepared: a trade,
 * a settings change, an agent setup or a group-chat post. It shows exactly what
 * will happen (the stored binding the server will check), who asked for it,
 * and — for a trade — a fresh quote and whether it is real money or practice.
 * Approve or Decline posts the binding's hash back, so the server acts only on
 * what this page displayed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, ShieldCheck, X } from "lucide-react";
import { fullDateTime } from "@/lib/format";
import { SignIn } from "@/terminal/HostedControls";
import { BrandLockup } from "../../BrandLockup";

import { TERMINAL, approvable, bookBox, headline, resumeDecision, short, text, usdg, type SettingsCheck, type View } from "./approve-view";
export { approvable, bookBox, headline, outcomeBook, resumeDecision } from "./approve-view";

/** What the owner reads when their session ended mid-decision: never a bare status word. */
export const SESSION_ENDED = "Your session ended; sign in to finish.";

const isSignedOut = (e: unknown) => (e as { signedOut?: boolean } | null)?.signedOut === true;

export async function call<T>(id: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/mcp/approvals/${encodeURIComponent(id)}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error(SESSION_ENDED), { signedOut: true });
  if (!res.ok) throw new Error(typeof data.error_description === "string" ? data.error_description : res.status === 404 ? "There is no such request for this account. Check you are signed in as the agent's owner." : `Request failed (${res.status}).`);
  return data as T;
}


/**
 * Settings changes and drafts, as the owner decides them: each setting as it
 * is NOW (read live, not when the assistant asked) and as it would become.
 * A setting that moved since the proposal is flagged, and the server refuses
 * the approval until a fresh proposal.
 */
function SettingsRows({ c }: { c: SettingsCheck }) {
  return <>
    {c.changed_since.length > 0 && <div className="connect-boundary mcp-warn"><AlertTriangle size={18} aria-hidden /><p><b>Your settings changed since this was proposed.</b> Approving is refused; ask your assistant for a fresh proposal.</p></div>}
    <ul className="mcp-checks">{c.rows.map((d) => <li key={d.key}><label><span>
      <strong>{d.label}: {d.current === d.proposed ? <>{d.current} (no change)</> : <>{d.current} → {d.proposed}</>}</strong>
      <span>{d.changed ? `It was ${d.when_proposed} when this was proposed. ` : ""}{d.help}</span>
    </span></label></li>)}</ul>
  </>;
}

function Details({ v }: { v: View }) {
  const b = v.binding;
  const s = v.summary;
  if (v.kind === "trade") {
    const box = bookBox(v);
    const limits = (b.limits as Record<string, unknown>) ?? {};
    const ceiling = limits.chat_ceiling_usdg;
    return <>
      {box.warn
        ? <div className="connect-boundary mcp-warn"><AlertTriangle size={18} aria-hidden /><p>{box.text}</p></div>
        : <div className="connect-boundary"><ShieldCheck size={18} aria-hidden /><p>{box.text}</p></div>}
      <ul className="mcp-checks">
        <li><label><span><strong>{text(s.action)}</strong><span>Token {short(b.token)} ({text(b.symbol)}) · chain {text(b.chain_id)}</span></span></label></li>
        <li><label><span><strong>Quoted: expect / at least</strong><span>{text(s.expected_out)} / {text(s.min_out)} {b.side === "buy" ? String(b.symbol) : "USDG"} · your agent’s slippage limit when proposed {Number(b.slippage_bps) / 100}%</span></span></label></li>
        {v.fresh_quote && <li><label><span><strong>Price right now</strong><span>{v.fresh_quote.quoted ? `expect ${text(v.fresh_quote.expected_out?.human)} · impact ${v.fresh_quote.price_impact_bps ?? "unknown"} bps${v.fresh_quote.impact_verdict.ok ? "" : ` · ${v.fresh_quote.impact_verdict.detail}`}` : `no quote: ${v.fresh_quote.why_not}`}</span></span></label></li>}
        <li><label><span><strong>Your limits</strong><span>per trade {usdg(limits.per_trade_usdg)} · owner-order ceiling {ceiling === 0 ? "none" : usdg(ceiling)} · per day {usdg(limits.daily_usdg)}</span></span></label></li>
      </ul>
      <p className="mcp-note">
        What approving checks, and what it does not: {b.side === "buy" ? "approving re-quotes this buy and refuses if the price has moved past the “at least” figure, or if your agent’s practice/live mode (as it last reported it) has changed. " : "approving refuses if your agent’s practice/live mode (as it last reported it) has changed. "}
        After that, your agent takes a fresh price when it executes, with its own slippage limit at that moment, so the fill can differ from the figures above; and it trades in whatever mode it is in when it picks the order up. It also re-checks its limits and permission, and may still refuse. You can cancel from your assistant until the agent picks the order up.
      </p>
    </>;
  }
  if (v.kind === "settings") {
    if (v.settings_check) return <><SettingsRows c={v.settings_check} /><p className="mcp-note">These apply to your running agent as soon as you approve.</p></>;
    const diff = (s.diff as Array<{ label: string; current: string; proposed: string; help: string }>) ?? [];
    return <ul className="mcp-checks">{diff.map((d) => <li key={d.label}><label><span><strong>{d.label}: {d.current} → {d.proposed}</strong><span>{d.help}</span></span></label></li>)}</ul>;
  }
  if (v.kind === "agent_draft") {
    const c = v.settings_check;
    if (!c) {
      const settings = (b.settings as Record<string, unknown>) ?? {};
      return <>
        <ul className="mcp-checks">{Object.entries(settings).map(([k, val]) => <li key={k}><label><span><strong>{k}</strong><span>{text(val)}</span></span></label></li>)}</ul>
        {v.status === "awaiting_approval" && <p className="mcp-note">Your current settings could not be read just now. If you already run an agent, approving applies these to it immediately.</p>}
      </>;
    }
    return <>
      {c.applies_to_running_agent && <div className="connect-boundary mcp-warn"><AlertTriangle size={18} aria-hidden /><p><b>This changes your running agent.</b> Approving saves these settings and they apply to your agent immediately, including its trading limits below.</p></div>}
      <SettingsRows c={c} />
      {c.left_out.length > 0 && <p className="mcp-note">Left out of this draft: {c.left_out.join(", ")}. Safety floors such as the price-impact cap are only changed in Settings.</p>}
      {!c.applies_to_running_agent && <p className="mcp-note">This saves settings only. Your agent cannot trade until you choose its limits and sign its trading permission yourself.</p>}
    </>;
  }
  return <div className="connect-boundary"><p>“{text(b.text)}”</p></div>;
}

export function ApproveClient({ id }: { id: string }) {
  const [v, setV] = useState<View | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A decision pressed after the session had ended: finished once the owner signs in again (resumeDecision). */
  const pending = useRef<{ decision: "approve" | "reject"; hash: string } | null>(null);
  const [resuming, setResuming] = useState<"approve" | "reject" | null>(null);

  const load = useCallback(async (): Promise<View | null> => {
    setError("");
    try {
      const next = await call<View>(id);
      setV(next);
      setSignedOut(false);
      if (!TERMINAL.has(next.status) && next.status !== "awaiting_approval") poll.current = setTimeout(() => void load(), 5000);
      return next;
    } catch (e) {
      if (isSignedOut(e)) setSignedOut(true);
      else setError(e instanceof Error ? e.message : "Could not load this request.");
      return null;
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); return () => { if (poll.current) clearTimeout(poll.current); }; }, [load]);

  async function decide(decision: "approve" | "reject", on: View | null = v) {
    if (!on || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await call<View>(id, { decision, hash: on.binding_hash });
      setV(next);
      if (!TERMINAL.has(next.status)) poll.current = setTimeout(() => void load(), 5000);
    } catch (e) {
      if (isSignedOut(e)) {
        // Nothing was decided. Keep what was pressed, take the buttons away,
        // and finish it once the owner has signed in again.
        pending.current = { decision, hash: on.binding_hash };
        setResuming(decision);
        setSignedOut(true);
      } else {
        setError(e instanceof Error ? e.message : "Could not complete this.");
        void load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function afterSignIn() {
    const p = pending.current;
    pending.current = null;
    setResuming(null);
    const next = await load();
    const decision = resumeDecision(p, next, Date.now());
    if (decision && next) await decide(decision, next);
    else if (p && next) setError(`Your ${p.decision === "approve" ? "approval" : "decline"} was not sent: this request is no longer waiting as it was when you pressed it. Review it again below.`);
  }

  const expired = v ? v.expires_at * 1000 < Date.now() : false;
  const deciding = v?.status === "awaiting_approval";
  const noun = v?.kind === "trade" ? "Trade" : v?.kind === "settings" ? "Setting changes" : v?.kind === "agent_draft" ? "Agent setup" : v?.kind === "post" ? "Post" : "Request";
  const title = v && !deciding ? `${noun}: ${headline(v).toLowerCase()}` : v?.kind === "trade" ? "Approve this trade?" : v?.kind === "settings" ? "Approve these setting changes?" : v?.kind === "agent_draft" ? "Approve this agent setup?" : v?.kind === "post" ? "Approve this post?" : "Review a request";

  return (
    <div className="terminal-host partner-connect mcp-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> Approval</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">PREPARED BY YOUR ASSISTANT</span>
          <h1>{v && v.status !== "awaiting_approval" ? headline(v) : <>You decide.</>}</h1>
          <p>Your AI assistant prepared this. Nothing happens unless you approve it here{v?.kind === "trade" ? ", and your agent’s own limits still apply after that" : ""}.</p>
          {v && <div className="connect-app"><div><strong>Requested by {v.requested_by ?? "an AI assistant"}</strong><span>{fullDateTime(v.created_at * 1000)} · {v.status === "awaiting_approval" ? `expires ${fullDateTime(v.expires_at * 1000)}` : headline(v)}</span></div></div>}
        </div>
        <section className="connect-panel" aria-busy={loading || busy}>
          {loading && <div className="connect-wait" role="status"><span className="connect-spinner" aria-hidden />Loading…</div>}
          {!loading && signedOut && <>
            <h2>{resuming ? `Your session ended; sign in to finish ${resuming === "approve" ? "approving" : "declining"}.` : "Sign in as the agent’s owner."}</h2>
            {resuming && <p className="mcp-note">Nothing was {resuming === "approve" ? "approved" : "declined"} yet. Once you are signed in as the agent’s owner, it is sent as you pressed it, if the request is still waiting unchanged.</p>}
            <SignIn onDone={() => void afterSignIn()} />
          </>}
          {!loading && v && <>
            <span className="connect-step-label">{v.kind.replace("_", " ").toUpperCase()}</span>
            <h2>{title}</h2>
            {typeof v.summary.assistant_note === "string" && <p className="mcp-note">Assistant’s note (unverified): “{v.summary.assistant_note}”</p>}
            {v.status === "cancelled" && v.result?.requester_withdrawn === true && typeof v.result.why === "string" && <div className="connect-boundary mcp-warn"><AlertTriangle size={18} aria-hidden /><p>Cancelled because {v.result.why}. Nothing was sent, and it can no longer be approved.</p></div>}
            <Details v={v} />
            {v.result && <details open={TERMINAL.has(v.status)}><summary>Result</summary><pre className="mcp-activity">{JSON.stringify(v.result, null, 2)}</pre></details>}
            {/* No decision is offered while signed out: pressing it could not be sent. */}
            {v.status === "awaiting_approval" && !expired && !signedOut && <>
              {/* A settings change whose "before" moved, or a trade whose book moved, is refused by the server; no button offers it. */}
              {approvable(v) && <button className="flow-primary" disabled={busy} onClick={() => void decide("approve")}>{busy ? "Working…" : "Approve"} {!busy && <ArrowRight size={16} aria-hidden />}</button>}
              <button className="connect-cancel" disabled={busy} onClick={() => void decide("reject")}><X size={15} aria-hidden /> Decline</button>
            </>}
            {v.status === "awaiting_approval" && expired && <p className="mcp-note">This request expired. Ask your assistant for a fresh one.</p>}
            {v.status === "confirmed" && <div className="connect-success-icon"><Check size={25} aria-hidden /></div>}
          </>}
          {error && <div className="connect-error" role="alert"><p>{error}</p><button onClick={() => void load()}>Reload</button></div>}
        </section>
      </main>
      <footer className="connect-footer">Manage what your assistants can do at <a href="/connect/apps">Connected apps</a>.</footer>
    </div>
  );
}
