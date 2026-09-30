/**
 * What the approval page says about a proposal, as pure functions, so the
 * native app can run the same rules (ios-native/Signing/feed.ts) — above all
 * the real-money / practice wording in bookBox. ApproveClient renders these.
 */
export interface View {
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

export type Book = "live" | "paper" | "unknown";

export interface SettingsCheck {
  rows: Array<{ key: string; label: string; when_proposed: string; current: string; proposed: string; help: string; changed: boolean }>;
  /** Keys whose value moved since the proposal: approving is refused until a fresh one. */
  changed_since: string[];
  /** The owner runs an agent with a signed permission: saving applies to it at once. */
  applies_to_running_agent: boolean;
  left_out: string[];
}

export const TERMINAL = new Set(["confirmed", "paper_filled", "refused", "failed", "expired", "cancelled", "rejected", "applied"]);
export const STATUS_TEXT: Record<string, string> = {
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


export const text = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
export const short = (a: unknown) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 8)}…${a.slice(-6)}` : text(a));

export const usdg = (v: unknown) => (typeof v === "number" ? `${v} USDG` : "—");

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

export const bookOf = (v: unknown): Book => (v === "live" || v === "paper" ? v : "unknown");
export const wasIn = (b: Book) => (b === "live" ? "trading live" : b === "paper" ? "in practice mode" : "in a mode it had not reported");

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
  // Once the agent has sent or finished the order, its CURRENT mode says
  // nothing about what this order did: a live order already on chain stays
  // real money even if live trading was switched off since.
  // A 'submitted' ledger row is only ever written for a live send (paper fills are 'paper'), so
  // "sent to the chain" is live even before the row carries its transaction hash.
  const sentLive = (typeof v.result?.tx_hash === "string" && v.result.tx_hash !== "") || (typeof v.result?.note === "string" && v.result.note.startsWith("sent to the chain"));
  if (v.status === "executing" && sentLive) {
    return { warn: true, text: `Real money. Your agent sent this order on chain with its real funds; the ledger has not recorded whether it landed yet.${proposed !== "live" ? ` It was proposed while your agent was ${wasIn(proposed)}.` : ""}` };
  }
  if (v.status === "executing" && v.result && typeof v.result.note === "string") {
    return { warn: true, text: "Your agent has finished this order. Until its trade record reaches the ledger, Merrymen cannot say whether it traded live (real money) or in practice." };
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
