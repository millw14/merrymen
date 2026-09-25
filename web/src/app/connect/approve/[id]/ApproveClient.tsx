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
import { fullDateTime, timeOnly } from "@/lib/format";
import { SignIn } from "@/terminal/HostedControls";
import { BrandLockup } from "../../BrandLockup";

interface View {
  id: string;
  kind: "trade" | "settings" | "agent_draft" | "post";
  status: string;
  binding: Record<string, unknown>;
  binding_hash: string;
  summary: Record<string, unknown>;
  requested_by: string | null;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  result: Record<string, unknown> | null;
  fresh_quote: { quoted: boolean; why_not: string | null; expected_out: { human: number | null } | null; min_out: { human: number | null } | null; price_impact_bps: number | null; impact_verdict: { ok: boolean; detail: string | null } } | null;
}

const TERMINAL = new Set(["confirmed", "paper_filled", "refused", "failed", "expired", "cancelled", "rejected", "applied"]);
const STATUS_TEXT: Record<string, string> = {
  awaiting_approval: "Waiting for your decision",
  approved: "Approved — handing it to your agent",
  submitted: "Queued for your agent",
  executing: "Your agent is executing it",
  filled_awaiting_ledger: "Filled — waiting for the ledger to confirm",
  confirmed: "Confirmed on chain",
  paper_filled: "Filled in your practice book (no real money moved)",
  refused: "Refused by your agent's limits or permission — nothing was traded",
  failed: "Did not complete",
  expired: "Expired — nothing was sent",
  cancelled: "Cancelled — nothing was sent",
  rejected: "You declined it",
  applied: "Approved and applied",
};

async function call<T>(id: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/mcp/approvals/${encodeURIComponent(id)}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error("signed-out"), { signedOut: true });
  if (!res.ok) throw new Error(typeof data.error_description === "string" ? data.error_description : res.status === 404 ? "There is no such request for this account. Check you are signed in as the agent's owner." : `Request failed (${res.status}).`);
  return data as T;
}

const text = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
const short = (a: unknown) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 8)}…${a.slice(-6)}` : text(a));

function Details({ v }: { v: View }) {
  const b = v.binding;
  const s = v.summary;
  if (v.kind === "trade") {
    const book = String(b.book);
    return <>
      {book === "live"
        ? <div className="connect-boundary mcp-warn"><AlertTriangle size={18} aria-hidden /><p><b>Real money.</b> Your agent trades live: approving queues a real order from your agent’s account.</p></div>
        : <div className="connect-boundary"><ShieldCheck size={18} aria-hidden /><p>{book === "paper" ? "Practice mode: approving books a simulated trade. No money moves." : "Your agent’s current mode is unknown; it will apply whatever mode it is in."}</p></div>}
      <ul className="mcp-checks">
        <li><label><span><strong>{text(s.action)}</strong><span>Token {short(b.token)} ({text(b.symbol)}) · chain {text(b.chain_id)}</span></span></label></li>
        <li><label><span><strong>Expected / at least</strong><span>{text(s.expected_out)} / {text(s.min_out)} {b.side === "buy" ? String(b.symbol) : "USDG"} · max slippage {Number(b.slippage_bps) / 100}%</span></span></label></li>
        {v.fresh_quote && <li><label><span><strong>Price right now</strong><span>{v.fresh_quote.quoted ? `expect ${text(v.fresh_quote.expected_out?.human)} · impact ${v.fresh_quote.price_impact_bps ?? "unknown"} bps${v.fresh_quote.impact_verdict.ok ? "" : ` · ${v.fresh_quote.impact_verdict.detail}`}` : `no quote: ${v.fresh_quote.why_not}`}</span></span></label></li>}
        <li><label><span><strong>Your limits</strong><span>per trade {text((b.limits as Record<string, unknown>)?.per_trade_usdg)} USDG · owner-order ceiling {text((b.limits as Record<string, unknown>)?.chat_ceiling_usdg)} · per day {text((b.limits as Record<string, unknown>)?.daily_usdg)}</span></span></label></li>
      </ul>
      <p className="mcp-note">After you approve, your agent re-checks its limits, the market and its permission before it executes, and may still refuse. You can cancel from your assistant until the agent picks the order up.</p>
    </>;
  }
  if (v.kind === "settings") {
    const diff = (s.diff as Array<{ label: string; current: string; proposed: string; help: string }>) ?? [];
    return <ul className="mcp-checks">{diff.map((d) => <li key={d.label}><label><span><strong>{d.label}: {d.current} → {d.proposed}</strong><span>{d.help}</span></span></label></li>)}</ul>;
  }
  if (v.kind === "agent_draft") {
    const settings = (b.settings as Record<string, unknown>) ?? {};
    return <>
      <ul className="mcp-checks">{Object.entries(settings).map(([k, val]) => <li key={k}><label><span><strong>{k}</strong><span>{text(val)}</span></span></label></li>)}</ul>
      <p className="mcp-note">This saves settings only. Your agent cannot trade until you choose its limits and sign its trading permission yourself.</p>
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

  const load = useCallback(async () => {
    setError("");
    try {
      const next = await call<View>(id);
      setV(next);
      setSignedOut(false);
      if (!TERMINAL.has(next.status) && next.status !== "awaiting_approval") poll.current = setTimeout(() => void load(), 5000);
    } catch (e) {
      if ((e as { signedOut?: boolean }).signedOut) setSignedOut(true);
      else setError(e instanceof Error ? e.message : "Could not load this request.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); return () => { if (poll.current) clearTimeout(poll.current); }; }, [load]);

  async function decide(decision: "approve" | "reject") {
    if (!v || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await call<View>(id, { decision, hash: v.binding_hash });
      setV(next);
      if (!TERMINAL.has(next.status)) poll.current = setTimeout(() => void load(), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete this.");
      void load();
    } finally {
      setBusy(false);
    }
  }

  const expired = v ? v.expires_at * 1000 < Date.now() : false;
  const deciding = v?.status === "awaiting_approval";
  const noun = v?.kind === "trade" ? "Trade" : v?.kind === "settings" ? "Setting changes" : v?.kind === "agent_draft" ? "Agent setup" : v?.kind === "post" ? "Post" : "Request";
  const title = v && !deciding ? `${noun}: ${(STATUS_TEXT[v.status] ?? v.status).toLowerCase()}` : v?.kind === "trade" ? "Approve this trade?" : v?.kind === "settings" ? "Approve these setting changes?" : v?.kind === "agent_draft" ? "Approve this agent setup?" : v?.kind === "post" ? "Approve this post?" : "Review a request";

  return (
    <div className="terminal-host partner-connect mcp-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> Approval</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">PREPARED BY YOUR ASSISTANT</span>
          <h1>{v && v.status !== "awaiting_approval" ? STATUS_TEXT[v.status] ?? v.status : <>You decide.</>}</h1>
          <p>Your AI assistant prepared this. Nothing happens unless you approve it here{v?.kind === "trade" ? ", and your agent’s own limits still apply after that" : ""}.</p>
          {v && <div className="connect-app"><div><strong>Requested by {v.requested_by ?? "an AI assistant"}</strong><span>{fullDateTime(v.created_at * 1000)} · {v.status === "awaiting_approval" ? `expires ${timeOnly(v.expires_at * 1000)}` : STATUS_TEXT[v.status]}</span></div></div>}
        </div>
        <section className="connect-panel" aria-busy={loading || busy}>
          {loading && <div className="connect-wait" role="status"><span className="connect-spinner" aria-hidden />Loading…</div>}
          {!loading && signedOut && <><h2>Sign in as the agent’s owner.</h2><SignIn onDone={() => void load()} /></>}
          {!loading && v && <>
            <span className="connect-step-label">{v.kind.replace("_", " ").toUpperCase()}</span>
            <h2>{title}</h2>
            {typeof v.summary.assistant_note === "string" && <p className="mcp-note">Assistant’s note (unverified): “{v.summary.assistant_note}”</p>}
            <Details v={v} />
            {v.result && <details open={TERMINAL.has(v.status)}><summary>Result</summary><pre className="mcp-activity">{JSON.stringify(v.result, null, 2)}</pre></details>}
            {v.status === "awaiting_approval" && !expired && <>
              <button className="flow-primary" disabled={busy} onClick={() => void decide("approve")}>{busy ? "Working…" : "Approve"} {!busy && <ArrowRight size={16} aria-hidden />}</button>
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
