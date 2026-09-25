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
  /** Settings and drafts only, while awaiting: each key as proposed against, now, and proposed — read live. */
  settings_check: SettingsCheck | null;
  /** Trades only, until finished: the agent's book as it last reported it (what approving is checked against). */
  current_book?: Book | null;
}

type Book = "live" | "paper" | "unknown";

interface SettingsCheck {
  rows: Array<{ key: string; label: string; when_proposed: string; current: string; proposed: string; help: string; changed: boolean }>;
  /** Keys whose value moved since the proposal: approving is refused until a fresh one. */
  changed_since: string[];
  /** The owner runs an agent with a signed permission: saving applies to it at once. */
  applies_to_running_agent: boolean;
  left_out: string[];
}

const TERMINAL = new Set(["confirmed", "paper_filled", "refused", "failed", "expired", "cancelled", "rejected", "applied"]);
const STATUS_TEXT: Record<string, string> = {
  awaiting_approval: "Waiting for your decision",
  approved: "Approved — handing it to your agent",
  submitted: "Queued for your agent",
  executing: "Your agent is executing it, or its result is on its way",
  filled_awaiting_ledger: "Filled — waiting for the ledger to confirm",
  confirmed: "Confirmed on chain",
  paper_filled: "Filled in your practice book (no real money moved)",
  refused: "Refused by your agent's limits or permission — nothing was traded",
  failed: "Did not complete, or could not be confirmed — see the result",
  expired: "Expired — nothing was sent",
  cancelled: "Cancelled — nothing was sent",
  rejected: "You declined it",
  applied: "Approved and applied",
};

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

const text = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
const short = (a: unknown) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 8)}…${a.slice(-6)}` : text(a));

const usdg = (v: unknown) => (typeof v === "number" ? `${v} USDG` : "—");

/**
 * The book a finished trade actually used, from its outcome (the rule the MCP
 * Apps view uses, mcp/apps.ts outcomeBook): a fill the chain or the ledger
 * reported, or a revert with a transaction, is live; a practice fill is paper.
 * Null when the outcome does not say.
 */
export function outcomeBook(status: string, result: Record<string, unknown> | null): "live" | "paper" | null {
  if (status === "confirmed" || status === "filled_awaiting_ledger") return "live";
  if (status === "paper_filled") return "paper";
  if (status === "failed" && typeof result?.tx_hash === "string" && result.tx_hash) return "live";
  return null;
}

const bookOf = (v: unknown): Book => (v === "live" || v === "paper" ? v : "unknown");
const wasIn = (b: Book) => (b === "live" ? "trading live" : b === "paper" ? "in practice mode" : "in a mode it had not reported");

/**
 * The practice / real-money box of a trade, as it stands NOW. Before a
 * decision it is the agent's current mode (what approving is checked against,
 * and approving is refused when it moved since the proposal); once there is an
 * outcome, the book that outcome used, saying so when it differs from the
 * proposal; on the way, the mode the agent is in now. A mode the agent never
 * reported is a warning: it may be live.
 */
export function bookBox(v: Pick<View, "status" | "binding" | "result" | "current_book">): { warn: boolean; text: string } {
  const proposed = bookOf(v.binding.book);
  const actual = outcomeBook(v.status, v.result);
  if (actual === "live") {
    // Each live outcome says only what its evidence shows.
    const what = v.status === "confirmed"
      ? "Real money. This trade went on chain with your agent’s real funds."
      : v.status === "filled_awaiting_ledger"
        ? "Real money. Your agent reports this trade went on chain with its real funds; the ledger has not confirmed it yet."
        : "Real money. This was sent live and reverted on chain: nothing was traded, and only gas was spent.";
    return { warn: true, text: `${what}${proposed !== "live" ? ` It was proposed while your agent was ${wasIn(proposed)}.` : ""}` };
  }
  if (actual === "paper") {
    return { warn: false, text: `Practice. This was filled in your practice book; no money moved.${proposed !== "paper" ? ` It was proposed while your agent was ${wasIn(proposed)}.` : ""}` };
  }
  if (TERMINAL.has(v.status)) {
    if (v.result?.outcome_unknown === true) return { warn: true, text: "Its outcome could not be confirmed, so Merrymen cannot say whether it traded or in which mode. Check your agent’s trades before asking for it again." };
    if (v.status === "failed") return { warn: false, text: "No trade was recorded for it." };
    return { warn: false, text: "Nothing was traded, so no money moved." };
  }
  const now = v.current_book ? bookOf(v.current_book) : proposed;
  if (v.status === "awaiting_approval") {
    const base = now === "live"
      ? "Real money. Your agent trades live right now: approving queues a real order from your agent’s account."
      : now === "paper"
        ? "Your agent is in practice mode right now. If it still is when it executes, the trade is simulated and no money moves."
        : "Your agent has not reported whether it is in practice or live mode. It trades in whatever mode it is in when it picks the order up, which may be live: real money.";
    const moved = now !== proposed ? ` When this was proposed it was ${wasIn(proposed)}, so approving is refused; ask your assistant for a fresh proposal.` : "";
    return { warn: now !== "paper" || moved !== "", text: base + moved };
  }
  const base = now === "live"
    ? "Real money. Your agent trades live right now; it executes this order in whatever mode it is in when it picks it up."
    : now === "paper"
      ? "Your agent is in practice mode right now. If it still is when it executes, the trade is simulated and no money moves."
      : "Your agent has not reported its mode. It executes this order in whatever mode it is in when it picks it up, which may be live: real money.";
  return { warn: now !== "paper", text: `${base}${now !== proposed ? ` It was proposed while your agent was ${wasIn(proposed)}.` : ""}` };
}

/** Whether the page offers Approve: the server refuses a moved setting or a moved book, so no button offers them. */
export function approvable(v: Pick<View, "kind" | "status" | "binding" | "settings_check" | "current_book">): boolean {
  if (v.status !== "awaiting_approval") return false;
  if (v.settings_check && v.settings_check.changed_since.length > 0) return false;
  if (v.kind === "trade" && v.current_book && bookOf(v.current_book) !== bookOf(v.binding.book)) return false;
  return true;
}

/** The page's headline for a decided proposal. */
export function headline(v: Pick<View, "status" | "result">): string {
  if (v.status === "applied" && v.result?.partial === true) return "Approved, but only some of it was applied — see the result";
  return STATUS_TEXT[v.status] ?? v.status;
}

/**
 * After signing in again, whether the decision the owner pressed while their
 * session had ended can be finished as it was: the same proposal (same
 * binding hash), still waiting, and — for an approval — still one the page
 * would offer. Anything else is left for the owner to look at again.
 */
export function resumeDecision(pending: { decision: "approve" | "reject"; hash: string } | null, next: View | null, nowMs: number): "approve" | "reject" | null {
  if (!pending || !next) return null;
  if (next.status !== "awaiting_approval" || next.binding_hash !== pending.hash || next.expires_at * 1000 <= nowMs) return null;
  if (pending.decision === "approve" && !approvable(next)) return null;
  return pending.decision;
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
