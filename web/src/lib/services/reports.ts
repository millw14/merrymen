/**
 * Owner reports and exports, computed from the shared ledger.
 *
 * Everything here is scoped by an account list the CALLER resolved from the
 * authenticated owner, never from anything a client typed, and compared
 * lowercased because the ledger's agent_id spelling is not normalised.
 *
 *  - readReportSummary: what one agent did over a trailing day or week, kept
 *    BOOK BY BOOK. Paper is simulated money and live is the owner's; a figure
 *    that added the two would describe no account that exists, so every number
 *    lives under exactly one book (refusals and decisions moved no money and
 *    sit beside the books, not in them).
 *  - buildExport: the rows behind a downloadable file (trades, decisions or the
 *    latest portfolio), bounded in rows and bytes, with CSV cells neutralised
 *    against formula injection. decisions.signals_json is never selected.
 *  - the mcp_exports store: an export belongs to one owner and lives a day.
 *
 * REUSED, NOT RE-DERIVED. Each of these is a rule an owner already reads
 * somewhere else, and a second copy would drift from it:
 *   one row per operation ............ distinct-trades.ts (redeploy copies)
 *   which realized figures are measured profile-trades.ts readEvidencedSells
 *   how an equity change splits ....... worker period-pnl.ts attributeBook
 *   holdings, cost and its provenance . desk-positions.ts readDeskPositions
 *   refusal wording and remedies ...... thesis-policy.ts, live-blocker.ts
 *   status, blockers, freshness ....... agent-status.ts; flow evidence: core
 *
 * UNKNOWN IS NULL. A book with no valuation, a sell whose cost was estimated,
 * gas nobody priced: each is null with a note, never a zero that reads as a
 * measurement.
 */
import { randomBytes } from "node:crypto";
import { isEvidencedFlow } from "@merrymen/core";
import type { Db } from "../../../../worker/src/db";
import { attributeBook, type BookFlow } from "../../../../worker/src/period-pnl";
import { isRestartCopy, sideOf } from "../../../../worker/src/token-label";
import { REJECT_RULES, rejectRuleLabel, rejectRuleRemedy } from "../../../../worker/src/thesis-policy";
import { blockerAdvice } from "../live-blocker";
import { basisUsdg } from "../basis-usdg";
import { distinctTrades, OP_COPY_REACH_SEC } from "../distinct-trades";
import { OP_KEY, readEvidencedSells } from "../profile-trades";
import { readDeskPositions } from "../desk-positions";
import { readAgentStatus, type AgentStatusView } from "./agent-status";
import { readTradeSpelling } from "./portfolio";
import { explanationOf, FILL_KINDS } from "./decisions";
import type { SettingsView } from "./settings-view";

export type BookName = "paper" | "live";

/** Sanitiser for third-party text (symbols, coin names, model reasons). The caller supplies it. */
export type TextCleaner = (text: string | null | undefined, max: number) => string | null;

// ── scoping ─────────────────────────────────────────────────────────────────

const ADDRESS = /^0x[0-9a-f]{40}$/;
/** An identity has held a handful of accounts at most; this bounds the IN list. */
const MAX_ACCOUNTS = 32;

interface Scope {
  /** `lower(<col>) IN (?, …)`, or a clause that matches nothing. */
  on(col: string): string;
  args: string[];
}

function scopeOf(accounts: readonly string[]): Scope {
  const list = [...new Set(accounts.map((a) => a.toLowerCase()).filter((a) => ADDRESS.test(a)))].slice(0, MAX_ACCOUNTS);
  return {
    on: (col) => (list.length ? `lower(${col}) IN (${list.map(() => "?").join(", ")})` : "1 = 0"),
    args: list,
  };
}

/** A number from either backend (Postgres BIGINT/NUMERIC can arrive as a string), else null. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const iso = (sec: number): string => new Date(sec * 1000).toISOString();

// ── refusal rules ───────────────────────────────────────────────────────────

/**
 * Wording for the refusals whose `reject_rule` is a prefix plus author-written
 * detail ("preflight: …", "couldn't submit: <raw provider text>"). The detail
 * is never published: it can carry raw RPC error text, addresses or a
 * model-supplied symbol. Only the prefix is kept.
 */
const PREFIX_RULES: Record<string, { rule: string; label: string }> = {
  preflight: { rule: "preflight", label: "the decision could not become an order (for example, below the minimum size)" },
  paper: { rule: "paper-refused", label: "the simulated fill was refused" },
  review: { rule: "review-refused", label: "the order review refused it" },
  "couldn't submit": { rule: "submit-failed", label: "the order could not be submitted to the chain" },
};
const KNOWN_RULES = new Set(REJECT_RULES);
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** A refusal rule reduced to a slug that is safe to publish, with our own wording when we have it. */
export function normalizeRefusal(raw: string | null | undefined): { rule: string; label: string | null; remedy: string | null } {
  const r = typeof raw === "string" ? raw.trim() : "";
  if (!r) return { rule: "unspecified", label: "no rule was recorded", remedy: null };
  if (KNOWN_RULES.has(r)) return { rule: r, label: rejectRuleLabel(r), remedy: rejectRuleRemedy(r) };
  if (SLUG.test(r)) return { rule: r, label: null, remedy: null };
  const colon = r.indexOf(":");
  const prefix = colon > 0 ? r.slice(0, colon).trim().toLowerCase() : "";
  const known = PREFIX_RULES[prefix];
  if (known) return { rule: known.rule, label: known.label, remedy: null };
  // Free text with an unknown head is not a rule: the head is as author-written
  // as the tail (it could be a provider name, a host or a key), so none of it
  // is published.
  return { rule: "other", label: "a refusal whose detail is not published", remedy: null };
}

// ── summary ─────────────────────────────────────────────────────────────────

export interface Mark {
  at: number;
  equity_usdg: number;
  cash_usdg: number;
  epoch: number | null;
  account: string;
}

export interface BookValuation {
  /** The last mark at or before the window opened (else the run's first inside it). */
  start: Mark | null;
  /** The newest mark at or before the window closed. */
  end: Mark | null;
  change_usdg: number | null;
  /**
   * The change split the way the owner's chat splits it (period-pnl.ts):
   * money moved in or out, change no record explains, and the rest (trading
   * and price moves). Null when it could not be computed.
   */
  attribution: { flows_usdg: number; unattributed_usdg: number; trading_usdg: number } | null;
  marks_in_window: number;
  notes: string[];
}

export interface TradeLine {
  at: number;
  account: string;
  kind: string;
  status: string;
  side: "buy" | "sell" | null;
  /** Third-party text: the coin's own symbol and name. Untrusted. */
  symbol: string | null;
  name: string | null;
  token: string | null;
  /** Cash that moved in the fill when recorded, else the order amount (see usdg_basis). */
  usdg: number | null;
  usdg_basis: "fill" | "order";
  tx_hash: string | null;
}

export interface RealizedView {
  /** Sum over evidenced sells only; null when there is none. */
  usdg: number | null;
  evidenced_sells: number;
  sells: number;
  notes: string[];
}

export interface LiveBookSummary {
  valuation: BookValuation;
  net_flows: { in_usdg: number; out_usdg: number; net_usdg: number; count: number; unevidenced_count: number; notes: string[] };
  trades: { confirmed_count: number; confirmed: TradeLine[]; landed_without_tx_count: number; submitted_count: number; reverted_count: number };
  realized_pnl: RealizedView;
  fees: { accrued_usdg: number; accruals: number };
  /**
   * `usdg` sums the priced part; null when landed operations paid gas and none
   * of it was priced. `complete` is false when some landed operation's gas is
   * unpriced or unrecorded, so a non-null `usdg` is then a floor.
   */
  gas: { usdg: number | null; complete: boolean; priced_ops: number; unpriced_ops: number; sponsored_ops: number; unrecorded_ops: number; notes: string[] };
}

export interface PaperBookSummary {
  valuation: BookValuation;
  trades: { paper_fill_count: number; paper_fills: TradeLine[] };
  realized_pnl: RealizedView;
}

export interface Blocker {
  kind: "permission" | "status" | "worker" | "live_blocker";
  code: string;
  text: string;
  owner_can_fix: boolean;
}

export interface ActionItem {
  action: string;
  because: string;
}

export interface ReportSummary {
  generated_at: number;
  since: number;
  until: number;
  mode: AgentStatusView["mode"] | null;
  status: AgentStatusView["status"] | null;
  live: LiveBookSummary;
  paper: PaperBookSummary;
  refusals: { total: number; top: Array<{ rule: string; label: string | null; count: number }> };
  decisions: { total: number; by_action: Array<{ action: string; count: number }>; dropped: number; quiet_reviews: number };
  blockers: Blocker[];
  action_items: ActionItem[];
  warnings: string[];
}

export interface SummaryInput {
  /** Every account the agent has held, from the owner's identity (never from a client). */
  accounts: readonly string[];
  /** The current smart account, or null before the first signed permission. */
  currentAccount: string | null;
  since: number;
  until: number;
  now: number;
  permissionExpiresAt: number | null;
  settings: SettingsView | null;
}

/** Marks read to attribute one book's change. A week at the fastest tick (15 s) is ~40k. */
export const SUMMARY_MARKS_MAX = 50_000;
/** Newest trades listed per book in a summary. */
export const SUMMARY_TRADES_LISTED = 20;
/** Sells replayed for realized P&L in one summary. */
const SUMMARY_SELLS_MAX = 5_000;
const FLOWS_MAX = 5_000;
/** Distinct stored refusal rules grouped per summary; the total is counted separately. */
const REFUSAL_GROUPS_MAX = 500;
const EXPIRY_WARN_SEC = 7 * 86_400;
/**
 * The fill kinds (decisions.ts FILL_KINDS) as an SQL list. Constants of our
 * own, never input, so inlined rather than bound: the counts read groups on it
 * in its SELECT, where a bound list would have to be passed twice.
 */
const FILL_KINDS_SQL = FILL_KINDS.filter((k) => /^[a-z-]+$/.test(k)).map((k) => `'${k}'`).join(", ");

interface FlowRow {
  at: number;
  signed: number;
  evidenced: boolean;
  source: string;
}

/** Flows de-duplicated by chain identity: an account's two spellings can each hold the same log. */
function flowRows(rows: Record<string, unknown>[]): FlowRow[] {
  const seen = new Set<string>();
  const out: FlowRow[] = [];
  for (const r of rows) {
    const at = num(r.at);
    const amount = num(r.amount_usdg);
    // 'in' | 'out' (store.ts). Anything else carries no sign we can trust, so it is not counted either way.
    if (at === null || amount === null || (r.direction !== "in" && r.direction !== "out")) continue;
    const tx = str(r.tx_hash)?.toLowerCase() ?? null;
    const li = num(r.log_index);
    if (tx && li !== null) {
      const k = `${tx}:${li}`;
      if (seen.has(k)) continue;
      seen.add(k);
    }
    const source = str(r.source) ?? "";
    out.push({ at, signed: r.direction === "out" ? -amount : amount, evidenced: isEvidencedFlow(source), source });
  }
  return out;
}

function markOf(r: Record<string, unknown> | undefined): Mark | null {
  if (!r) return null;
  const at = num(r.at);
  const equity = num(r.equity_usdg);
  const cash = num(r.cash_usdg);
  const account = str(r.agent_id);
  if (at === null || equity === null || cash === null || !account) return null;
  return { at, equity_usdg: equity, cash_usdg: cash, epoch: num(r.epoch), account };
}

/**
 * One book's valuation over [since, until]: its own marks only, from one
 * account and one run. A different account (a re-signed agent) or a different
 * run (a paper reset, an accounting epoch) is not the same money, so the change
 * is never measured across either.
 */
async function readBookValuation(db: Db, scope: Scope, book: BookName, since: number, until: number): Promise<BookValuation> {
  const notes: string[] = [];
  const end = markOf(await db.prepare(
    `SELECT e.agent_id, e.at, e.equity_usdg, e.cash_usdg, e.epoch FROM equity e
      WHERE ${scope.on("e.agent_id")} AND e.mode = ? AND e.at <= ? ORDER BY e.at DESC, e.id DESC LIMIT 1`,
  ).get(...scope.args, book, until) as Record<string, unknown> | undefined);
  if (!end) {
    return { start: null, end: null, change_usdg: null, attribution: null, marks_in_window: 0, notes: [`No ${book} valuation has been recorded for this agent.`] };
  }
  const acct = end.account.toLowerCase();
  const run = end.epoch === null ? "" : " AND e.epoch = ?";
  const runArg = end.epoch === null ? [] : [end.epoch];
  const inWindow = await db.prepare(
    `SELECT COUNT(*) AS n FROM equity e WHERE lower(e.agent_id) = ? AND e.mode = ?${run} AND e.at >= ? AND e.at <= ?`,
  ).get(acct, book, ...runArg, since, until) as Record<string, unknown> | undefined;
  const marksInWindow = num(inWindow?.n) ?? 0;
  const others = await db.prepare(
    `SELECT COUNT(*) AS n FROM equity e WHERE ${scope.on("e.agent_id")} AND e.mode = ? AND e.at >= ? AND e.at <= ?
       AND NOT (lower(e.agent_id) = ?${end.epoch === null ? "" : " AND e.epoch = ?"})`,
  ).get(...scope.args, book, since, until, acct, ...runArg) as Record<string, unknown> | undefined;
  const otherMarks = num(others?.n) ?? 0;
  if (otherMarks > 0) {
    notes.push(`${otherMarks} ${book} valuation(s) in this window belong to an earlier run or account and are not compared with the current one.`);
  }
  if (marksInWindow === 0) {
    notes.push(`No ${book} valuation was recorded in this window; the last one was at ${iso(end.at)}, so no change is reported.`);
    return { start: null, end, change_usdg: null, attribution: null, marks_in_window: 0, notes };
  }
  let start = markOf(await db.prepare(
    `SELECT e.agent_id, e.at, e.equity_usdg, e.cash_usdg, e.epoch FROM equity e
      WHERE lower(e.agent_id) = ? AND e.mode = ?${run} AND e.at <= ? ORDER BY e.at DESC, e.id DESC LIMIT 1`,
  ).get(acct, book, ...runArg, since) as Record<string, unknown> | undefined);
  if (!start) {
    start = markOf(await db.prepare(
      `SELECT e.agent_id, e.at, e.equity_usdg, e.cash_usdg, e.epoch FROM equity e
        WHERE lower(e.agent_id) = ? AND e.mode = ?${run} AND e.at >= ? ORDER BY e.at ASC, e.id ASC LIMIT 1`,
    ).get(acct, book, ...runArg, since) as Record<string, unknown> | undefined);
    if (start) notes.push(`This ${book} run began inside the window; the change is measured from its first valuation at ${iso(start.at)}.`);
  }
  if (!start || start.at >= end.at) {
    notes.push(`Only one ${book} valuation falls in this window, so no change is reported.`);
    return { start: start ?? end, end, change_usdg: null, attribution: null, marks_in_window: marksInWindow, notes };
  }
  const change = end.equity_usdg - start.equity_usdg;

  // THE SPLIT, the way the chat's "how did I do" computes it: every mark of
  // this run between the two ends, the book's own flows (paper takes none:
  // its cash is simulated) and its trade times, restart copies excluded.
  const markRows = (await db.prepare(
    `SELECT e.at, e.equity_usdg, e.cash_usdg FROM equity e
      WHERE lower(e.agent_id) = ? AND e.mode = ?${run} AND e.at >= ? AND e.at <= ? ORDER BY e.at ASC, e.id ASC LIMIT ?`,
  ).all(acct, book, ...runArg, start.at, end.at, SUMMARY_MARKS_MAX + 1)) as Record<string, unknown>[];
  if (markRows.length > SUMMARY_MARKS_MAX) {
    notes.push(`Too many valuations to attribute the change (over ${SUMMARY_MARKS_MAX}); only the total change is reported.`);
    return { start, end, change_usdg: change, attribution: null, marks_in_window: marksInWindow, notes };
  }
  const marks = markRows
    .map((r) => ({ at: num(r.at), equity: num(r.equity_usdg), cash: num(r.cash_usdg) }))
    .filter((m): m is { at: number; equity: number; cash: number } => m.at !== null && m.equity !== null && m.cash !== null);
  let flows: BookFlow[] = [];
  if (book === "live") {
    const fr = (await db.prepare(
      `SELECT f.at, f.direction, f.amount_usdg, f.source, f.tx_hash, f.log_index FROM flows f
        WHERE lower(f.agent_id) = ?${end.epoch === null ? "" : " AND f.epoch = ?"} AND f.at > ? AND f.at <= ? ORDER BY f.at ASC LIMIT ?`,
    ).all(acct, ...runArg, start.at, end.at, FLOWS_MAX + 1)) as Record<string, unknown>[];
    if (fr.length > FLOWS_MAX) {
      notes.push("Too many capital flows to attribute the change; only the total change is reported.");
      return { start, end, change_usdg: change, attribution: null, marks_in_window: marksInWindow, notes };
    }
    flows = flowRows(fr).map(({ at, signed, evidenced }) => ({ at, signed, evidenced }));
  }
  const tr = (await db.prepare(
    `SELECT t.kind, t.target, t.agent_id, t.decision_id, t.fill_side, t.created_at FROM trades t
      WHERE lower(t.agent_id) = ? AND t.created_at >= ? AND t.created_at < ? AND t.status IN (${book === "paper" ? "'paper'" : "'landed','submitted'"})
      ORDER BY t.created_at ASC LIMIT ?`,
  ).all(acct, start.at, end.at, SUMMARY_MARKS_MAX + 1)) as Record<string, unknown>[];
  if (tr.length > SUMMARY_MARKS_MAX) {
    notes.push("Too many trades to attribute the change; only the total change is reported.");
    return { start, end, change_usdg: change, attribution: null, marks_in_window: marksInWindow, notes };
  }
  const times = tr
    .filter((r) => !isRestartCopy({ kind: str(r.kind) ?? "", target: str(r.target), agent_id: str(r.agent_id) ?? "", decision_id: str(r.decision_id), fill_side: str(r.fill_side) }))
    .map((r) => num(r.created_at))
    .filter((t): t is number => t !== null);
  const cum = attributeBook(marks, flows, times);
  const last = cum[cum.length - 1];
  if (!last) return { start, end, change_usdg: change, attribution: null, marks_in_window: marksInWindow, notes };
  if (Math.abs(last.unattributed) >= 0.01) {
    notes.push(`${last.unattributed.toFixed(2)} USDG of the change is not explained by any trade or recorded flow (for example, a deposit while the agent was down); it is reported as unattributed, not as trading.`);
  }
  return {
    start,
    end,
    change_usdg: change,
    attribution: { flows_usdg: last.flows, unattributed_usdg: last.unattributed, trading_usdg: change - last.flows - last.unattributed },
    marks_in_window: marksInWindow,
    notes,
  };
}

const TRADE_LINE_COLS = `t.id, t.agent_id, t.kind, t.status, t.fill_side, t.sell_token, t.buy_token, t.amount_usdg, t.fill_cash_usdg,
  t.tx_hash, t.created_at, COALESCE(t.fill_symbol, d.symbol) AS symbol, d.display_name, d.action`;
const DECISION_JOIN = "LEFT JOIN decisions d ON d.id = t.decision_id AND LOWER(d.agent_id) = LOWER(t.agent_id)";

function tradeLine(r: Record<string, unknown>, clean: TextCleaner): TradeLine {
  const recorded = sideOf({ fill_side: str(r.fill_side), sell_token: str(r.sell_token), buy_token: str(r.buy_token) });
  const side = recorded ?? (r.action === "buy" || r.action === "sell" ? r.action : null);
  const fill = num(r.fill_cash_usdg);
  return {
    at: num(r.created_at) ?? 0,
    account: (str(r.agent_id) ?? "").toLowerCase(),
    kind: clean(str(r.kind), 32) ?? "unknown",
    status: str(r.status) ?? "unknown",
    side,
    symbol: clean(str(r.symbol), 32),
    name: clean(str(r.display_name), 64),
    token: side === "buy" ? str(r.buy_token)?.toLowerCase() ?? null : side === "sell" ? str(r.sell_token)?.toLowerCase() ?? null : null,
    usdg: fill ?? num(r.amount_usdg),
    usdg_basis: fill !== null ? "fill" : "order",
    tx_hash: str(r.tx_hash)?.toLowerCase() ?? null,
  };
}

/**
 * Realized P&L per book over the window, from evidenced sells only
 * (readEvidencedSells, the rule the desk and the profile already print by).
 * The replay runs per ACCOUNT, as the ledger spells it: cost basis is kept per
 * account and never crosses to a re-signed one.
 */
async function readRealized(db: Db, scope: Scope, since: number, until: number): Promise<Record<BookName, RealizedView>> {
  const rows = (await db.prepare(
    `SELECT t.agent_id, t.status, t.sell_token, t.realized_pnl_usdg, ${OP_KEY} AS op_key
       FROM ${distinctTrades(`${scope.on("t.agent_id")} AND t.created_at >= ?`)}
      WHERE t.created_at >= ? AND t.created_at < ? AND t.status IN ('landed','paper') AND t.fill_side = 'sell'
      ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
  ).all(...scope.args, since - OP_COPY_REACH_SEC, since, until, SUMMARY_SELLS_MAX + 1)) as Record<string, unknown>[];
  const cut = rows.length > SUMMARY_SELLS_MAX;
  const out: Record<BookName, RealizedView> = {
    live: { usdg: null, evidenced_sells: 0, sells: 0, notes: [] },
    paper: { usdg: null, evidenced_sells: 0, sells: 0, notes: [] },
  };
  const groups = new Map<string, { account: string; book: BookName; sells: Array<{ op: string; token: string; pnl: number | null }> }>();
  for (const r of rows.slice(0, SUMMARY_SELLS_MAX)) {
    const book: BookName = r.status === "paper" ? "paper" : "live";
    out[book].sells += 1;
    const account = str(r.agent_id);
    const token = str(r.sell_token);
    const op = str(r.op_key);
    if (!account || !token || !op) continue;
    // Grouped per ACCOUNT, not per spelling: the replay must see the whole tape.
    const key = `${account.toLowerCase()}|${book}`;
    const g = groups.get(key) ?? { account: account.toLowerCase(), book, sells: [] };
    groups.set(key, g);
    g.sells.push({ op, token, pnl: num(r.realized_pnl_usdg) });
  }
  let replayFailed = false;
  let splitSpelling = false;
  for (const g of groups.values()) {
    const candidates = g.sells.filter((s) => s.pnl !== null);
    let vouched = new Set<string>();
    try {
      // The replay matches agent_id exactly. An account written under two
      // spellings would replay as two partial tapes, and a partial replay can
      // vouch for a sell whose estimated buy sits under the other spelling —
      // so that case vouches for nothing (the rule portfolio.ts applies).
      const spelling = await readTradeSpelling(db, g.account);
      if (spelling === null) splitSpelling = true;
      else vouched = await readEvidencedSells(db, spelling === "none" ? g.account : spelling, g.book === "paper" ? "paper" : "landed", candidates);
    } catch {
      replayFailed = true;
    }
    for (const s of candidates) {
      if (!vouched.has(s.op)) continue;
      out[g.book].evidenced_sells += 1;
      out[g.book].usdg = (out[g.book].usdg ?? 0) + (s.pnl as number);
    }
  }
  for (const book of ["live", "paper"] as const) {
    const v = out[book];
    const unverified = v.sells - v.evidenced_sells;
    if (unverified > 0) v.notes.push(`${unverified} sell(s) have no evidenced proceeds or cost (the fill or its basis was estimated), so their P&L is left out.`);
    if (v.sells > 0 && v.evidenced_sells === 0) v.notes.push("No sell in this window has an evidenced result, so realized P&L is unknown (null), not zero.");
    if (cut) v.notes.push(`Only the newest ${SUMMARY_SELLS_MAX} sells were replayed.`);
    if (replayFailed) v.notes.push("The cost replay could not be read for some sells; they are left out.");
    if (splitSpelling) v.notes.push("An account's trades are recorded under two spellings of its address, so its sells cannot be replayed whole and are left out.");
  }
  return out;
}

function expiryBlockers(expiresAt: number | null, now: number): { blockers: Blocker[]; items: ActionItem[] } {
  if (expiresAt === null) return { blockers: [], items: [] };
  if (expiresAt <= now) {
    return {
      blockers: [{ kind: "permission", code: "permission-expired", text: `The trading permission expired at ${iso(expiresAt)}.`, owner_can_fix: true }],
      items: [{ action: "Re-sign the trading permission in Merrymen. It is free and nothing moves on chain.", because: "permission-expired" }],
    };
  }
  if (expiresAt - now <= EXPIRY_WARN_SEC) {
    const days = Math.max(0, Math.floor((expiresAt - now) / 86_400));
    return {
      blockers: [{ kind: "permission", code: "permission-expiring", text: `The trading permission expires at ${iso(expiresAt)} (${days === 0 ? "within a day" : `in ${days} day(s)`}).`, owner_can_fix: true }],
      items: [{ action: `Re-sign the trading permission in Merrymen before ${iso(expiresAt)} so the agent keeps running.`, because: "permission-expiring" }],
    };
  }
  return { blockers: [], items: [] };
}

/** What one agent did over [since, until), book by book. THROWS when the ledger cannot be read. */
export async function readReportSummary(db: Db, input: SummaryInput, clean: TextCleaner): Promise<ReportSummary> {
  const { since, until, now } = input;
  const scope = scopeOf(input.accounts);
  const warnings: string[] = [];
  const reach = since - OP_COPY_REACH_SEC;

  const [liveVal, paperVal] = [await readBookValuation(db, scope, "live", since, until), await readBookValuation(db, scope, "paper", since, until)];
  const unlabelled = await db.prepare(
    `SELECT COUNT(*) AS n FROM equity e WHERE ${scope.on("e.agent_id")} AND e.mode IS NULL AND e.at >= ? AND e.at <= ?`,
  ).get(...scope.args, since, until) as Record<string, unknown> | undefined;
  if ((num(unlabelled?.n) ?? 0) > 0) warnings.push(`${num(unlabelled?.n)} valuation(s) in this window predate book labels and are counted in neither book.`);

  // Operation counts and gas, one row per operation.
  //
  // THE LIVE COUNTS ARE OPERATIONS, and are published as such ("confirmed
  // operations"): a landed transfer or vault move is money the owner's account
  // really moved and paid gas for, so it belongs in them. THE PAPER COUNT IS
  // PUBLISHED AS FILLS, so it counts fills only (swaps and curve trades), the
  // rule the summary alert and explain_agent_inactivity count fills by: a
  // simulated vault move is not a fill.
  const counts = (await db.prepare(
    `SELECT t.status AS status, CASE WHEN t.tx_hash IS NOT NULL AND t.tx_hash <> '' THEN 1 ELSE 0 END AS has_tx,
            CASE WHEN t.kind IN (${FILL_KINDS_SQL}) THEN 1 ELSE 0 END AS is_fill, COUNT(*) AS n,
            SUM(CASE WHEN t.gas_usdg IS NOT NULL THEN t.gas_usdg ELSE 0 END) AS gas_usdg,
            SUM(CASE WHEN t.gas_usdg IS NOT NULL THEN 1 ELSE 0 END) AS gas_priced,
            SUM(CASE WHEN t.gas_wei IS NOT NULL AND t.gas_usdg IS NULL THEN 1 ELSE 0 END) AS gas_unpriced,
            SUM(CASE WHEN t.gas_wei IS NULL AND t.gas_usdg IS NULL AND t.sponsored_gas_wei IS NOT NULL THEN 1 ELSE 0 END) AS gas_sponsored,
            SUM(CASE WHEN t.gas_wei IS NULL AND t.gas_usdg IS NULL AND t.sponsored_gas_wei IS NULL THEN 1 ELSE 0 END) AS gas_missing
       FROM ${distinctTrades(`${scope.on("t.agent_id")} AND t.created_at >= ?`)}
      WHERE t.created_at >= ? AND t.created_at < ? AND t.status IN ('landed','submitted','reverted','paper')
      GROUP BY t.status, CASE WHEN t.tx_hash IS NOT NULL AND t.tx_hash <> '' THEN 1 ELSE 0 END, CASE WHEN t.kind IN (${FILL_KINDS_SQL}) THEN 1 ELSE 0 END`,
  ).all(...scope.args, reach, since, until)) as Record<string, unknown>[];
  let confirmed = 0, landedNoTx = 0, submitted = 0, reverted = 0, paperFills = 0, paperOther = 0;
  let gasUsdg = 0, gasPriced = 0, gasUnpriced = 0, gasSponsored = 0, gasMissing = 0;
  for (const c of counts) {
    const n = num(c.n) ?? 0;
    const hasTx = num(c.has_tx) === 1;
    if (c.status === "landed") {
      if (hasTx) confirmed += n; else landedNoTx += n;
      // The worker's own rule (getGasPaidUsdg): gas is what landed operations paid.
      gasUsdg += num(c.gas_usdg) ?? 0;
      gasPriced += num(c.gas_priced) ?? 0;
      gasUnpriced += num(c.gas_unpriced) ?? 0;
      gasSponsored += num(c.gas_sponsored) ?? 0;
      gasMissing += num(c.gas_missing) ?? 0;
    } else if (c.status === "submitted") submitted += n;
    else if (c.status === "reverted") reverted += n;
    else if (c.status === "paper") {
      if (num(c.is_fill) === 1) paperFills += n; else paperOther += n;
    }
  }
  if (submitted > 0) warnings.push(`${submitted} live operation(s) were submitted and have no final outcome in the ledger yet; they are not counted as confirmed.`);
  if (landedNoTx > 0) warnings.push(`${landedNoTx} landed operation(s) carry no transaction hash, so they are not reported as confirmed.`);
  if (paperOther > 0) warnings.push(`${paperOther} paper (simulated) operation(s) in this window were not swaps or curve trades (for example a simulated vault move), so they are not counted as paper fills.`);

  const listed = async (where: string) => ((await db.prepare(
    `SELECT ${TRADE_LINE_COLS} FROM ${distinctTrades(`${scope.on("t.agent_id")} AND t.created_at >= ?`)} ${DECISION_JOIN}
      WHERE t.created_at >= ? AND t.created_at < ? AND ${where}
      ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
  ).all(...scope.args, reach, since, until, SUMMARY_TRADES_LISTED)) as Record<string, unknown>[]).map((r) => tradeLine(r, clean));
  const confirmedList = await listed("t.status = 'landed' AND t.tx_hash IS NOT NULL AND t.tx_hash <> ''");
  const paperList = await listed(`t.status = 'paper' AND t.kind IN (${FILL_KINDS_SQL})`);

  const realized = await readRealized(db, scope, since, until);

  const flowRaw = (await db.prepare(
    `SELECT f.at, f.direction, f.amount_usdg, f.source, f.tx_hash, f.log_index FROM flows f
      WHERE ${scope.on("f.agent_id")} AND f.at >= ? AND f.at < ? ORDER BY f.at ASC LIMIT ?`,
  ).all(...scope.args, since, until, FLOWS_MAX + 1)) as Record<string, unknown>[];
  const flowNotes: string[] = [];
  if (flowRaw.length > FLOWS_MAX) flowNotes.push(`Only the first ${FLOWS_MAX} flows in the window are counted.`);
  let flowIn = 0, flowOut = 0, flowCount = 0, unevidenced = 0, carries = 0;
  for (const f of flowRows(flowRaw.slice(0, FLOWS_MAX))) {
    // An epoch carry bridges a closed run's equity into the next one. It is
    // bookkeeping, not money the owner moved, so it is not a flow here.
    if (f.source === "epoch-carry") { carries += 1; continue; }
    flowCount += 1;
    if (f.signed >= 0) flowIn += f.signed; else flowOut += -f.signed;
    if (!f.evidenced) unevidenced += 1;
  }
  if (carries > 0) flowNotes.push(`${carries} run carry-over(s) (a closed run's balance bridged into the next) are not counted as deposits.`);
  if (unevidenced > 0) flowNotes.push(`${unevidenced} flow(s) have no on-chain log behind them (an own transfer or an inferred cash change).`);

  const fee = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(f.fee_usdg), 0) AS fee FROM fee_accruals f WHERE ${scope.on("f.agent_id")} AND f.at >= ? AND f.at < ?`,
  ).get(...scope.args, since, until) as Record<string, unknown> | undefined;

  const gasNotes: string[] = [];
  if (gasUnpriced > 0) gasNotes.push(`${gasUnpriced} landed operation(s) paid gas that could not be priced in USDG; the total excludes them.`);
  if (gasSponsored > 0) gasNotes.push(`${gasSponsored} operation(s) were sponsored: the sponsor paid their gas, not the owner.`);
  if (gasMissing > 0) gasNotes.push(`${gasMissing} landed operation(s) carry no gas record at all; the total excludes them.`);
  // Zero only when it was measured: nothing landed, or everything that landed was sponsored.
  const gasTotal = gasPriced > 0 ? gasUsdg : gasUnpriced > 0 || gasMissing > 0 ? null : 0;
  const gasComplete = gasUnpriced === 0 && gasMissing === 0;
  if (gasTotal !== null && !gasComplete) gasNotes.push("The gas total is a floor: it covers only the operations whose gas was priced (complete is false).");

  // Refusals: rows that moved nothing. Grouped by a publishable slug, never the raw detail.
  // The total is counted on its own: free-text rules ("couldn't submit: …")
  // are distinct per row, so the grouped read below can stop before the tail.
  const refusalCount = await db.prepare(
    `SELECT COUNT(*) AS n FROM trades t WHERE ${scope.on("t.agent_id")} AND t.status = 'rejected' AND t.created_at >= ? AND t.created_at < ?`,
  ).get(...scope.args, since, until) as Record<string, unknown> | undefined;
  const refusalRows = (await db.prepare(
    `SELECT t.reject_rule AS rule, COUNT(*) AS n FROM trades t
      WHERE ${scope.on("t.agent_id")} AND t.status = 'rejected' AND t.created_at >= ? AND t.created_at < ?
      GROUP BY t.reject_rule ORDER BY n DESC LIMIT ${REFUSAL_GROUPS_MAX + 1}`,
  ).all(...scope.args, since, until)) as Record<string, unknown>[];
  const byRule = new Map<string, { rule: string; label: string | null; remedy: string | null; count: number }>();
  let grouped = 0;
  for (const r of refusalRows.slice(0, REFUSAL_GROUPS_MAX)) {
    const n = num(r.n) ?? 0;
    grouped += n;
    const norm = normalizeRefusal(str(r.rule));
    const cur = byRule.get(norm.rule) ?? { ...norm, count: 0 };
    cur.count += n;
    byRule.set(norm.rule, cur);
  }
  const refusalTotal = num(refusalCount?.n) ?? grouped;
  if (refusalTotal > grouped) {
    warnings.push(`${refusalTotal - grouped} refusal(s) carry rare free-text rules and are counted in the total but not in the top rules.`);
  }
  const topRefusals = [...byRule.values()].sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)).slice(0, 5);

  const decisionRows = (await db.prepare(
    `SELECT d.action AS action, CASE WHEN d.source = 'market-review-private' THEN 1 ELSE 0 END AS quiet,
            CASE WHEN d.dropped_rule IS NOT NULL THEN 1 ELSE 0 END AS dropped, COUNT(*) AS n
       FROM decisions d WHERE ${scope.on("d.agent_id")} AND d.at >= ? AND d.at < ?
      GROUP BY d.action, CASE WHEN d.source = 'market-review-private' THEN 1 ELSE 0 END, CASE WHEN d.dropped_rule IS NOT NULL THEN 1 ELSE 0 END
      LIMIT 500`,
  ).all(...scope.args, since, until)) as Record<string, unknown>[];
  const byAction = new Map<string, number>();
  let decisionTotal = 0, dropped = 0, quiet = 0;
  for (const r of decisionRows) {
    const n = num(r.n) ?? 0;
    decisionTotal += n;
    if (num(r.dropped) === 1) dropped += n;
    // A quiet market review is written every few minutes by an agent with
    // nothing to say; counted apart so it does not bury the decisions.
    if (num(r.quiet) === 1) { quiet += n; continue; }
    const a = typeof r.action === "string" && /^[a-z][a-z_-]{0,23}$/.test(r.action) ? r.action : r.action == null ? "none" : "other";
    byAction.set(a, (byAction.get(a) ?? 0) + n);
  }

  // Blockers and what the owner can do about them.
  const blockers: Blocker[] = [];
  const items: ActionItem[] = [];
  let status: AgentStatusView | null = null;
  if (!input.currentAccount) {
    blockers.push({ kind: "permission", code: "no-permission", text: "No trading permission has been signed yet, so the agent cannot run.", owner_can_fix: true });
    items.push({ action: "Sign a trading permission in Merrymen to start the agent.", because: "no-permission" });
  } else {
    status = await readAgentStatus(db, input.currentAccount, input.settings, now);
    if (status.status === "killed") blockers.push({ kind: "status", code: "killed", text: "The kill switch is on: the agent can no longer sign anything. Funds stay in the owner's smart account.", owner_can_fix: false });
    if (status.status === "error") blockers.push({ kind: "status", code: "error", text: "The agent could not arm its trading key.", owner_can_fix: false });
    if ((status.status === "active" || status.status === "armed") && status.freshness.worker_fresh === false && status.freshness.heartbeat_at !== null) {
      blockers.push({ kind: "worker", code: "worker-stale", text: `The agent's worker has not reported since ${iso(status.freshness.heartbeat_at)}.`, owner_can_fix: false });
    }
    if (status.live_blocker) {
      const b = status.live_blocker;
      blockers.push({ kind: "live_blocker", code: b.rule, text: b.text, owner_can_fix: b.owner_can_fix });
      const remedy = rejectRuleRemedy(b.rule) ?? blockerAdvice(b.rule)?.say ?? null;
      if (b.owner_can_fix && remedy) items.push({ action: remedy, because: b.rule });
    }
  }
  const exp = expiryBlockers(input.permissionExpiresAt, now);
  blockers.push(...exp.blockers);
  items.push(...exp.items);
  for (const r of topRefusals) {
    // live-not-enabled is a choice, not a fault; the blocker already says so.
    if (!r.remedy || r.rule === "live-not-enabled" || items.some((i) => i.because === r.rule)) continue;
    items.push({ action: r.remedy, because: r.rule });
  }

  return {
    generated_at: now,
    since,
    until,
    mode: status?.mode ?? null,
    status: status?.status ?? null,
    live: {
      valuation: liveVal,
      net_flows: { in_usdg: flowIn, out_usdg: flowOut, net_usdg: flowIn - flowOut, count: flowCount, unevidenced_count: unevidenced, notes: flowNotes },
      trades: { confirmed_count: confirmed, confirmed: confirmedList, landed_without_tx_count: landedNoTx, submitted_count: submitted, reverted_count: reverted },
      realized_pnl: realized.live,
      fees: { accrued_usdg: num(fee?.fee) ?? 0, accruals: num(fee?.n) ?? 0 },
      gas: { usdg: gasTotal, complete: gasComplete, priced_ops: gasPriced, unpriced_ops: gasUnpriced, sponsored_ops: gasSponsored, unrecorded_ops: gasMissing, notes: gasNotes },
    },
    paper: {
      valuation: paperVal,
      trades: { paper_fill_count: paperFills, paper_fills: paperList },
      realized_pnl: realized.paper,
    },
    refusals: { total: refusalTotal, top: topRefusals.map(({ rule, label, count }) => ({ rule, label, count })) },
    decisions: { total: decisionTotal, by_action: [...byAction.entries()].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count), dropped, quiet_reviews: quiet },
    blockers,
    action_items: items,
    warnings,
  };
}

// ── exports ─────────────────────────────────────────────────────────────────

export type ExportKind = "trades" | "decisions" | "portfolio";
export type ExportFormat = "csv" | "json";
export const EXPORT_MAX_ROWS = 5_000;
export const EXPORT_MAX_BYTES = 2 * 1024 * 1024;
export const EXPORT_TTL_SEC = 86_400;
/**
 * What one owner may hold in unexpired exports at once. The hourly budget alone
 * would let a runaway client park 480 files of 2 MB in shared Postgres per day.
 */
export const EXPORT_LIVE_MAX_COUNT = 50;
export const EXPORT_LIVE_MAX_BYTES = 50 * 1024 * 1024;
/** Head room kept for the header, the JSON envelope and the truncation note. */
const ENVELOPE_RESERVE = 8 * 1024;

type Cell = string | number | boolean | null;

interface Table {
  columns: string[];
  /** Newest first; truncation keeps the head. */
  rows: Cell[][];
  /** More rows matched than were read. */
  more: boolean;
  notes: string[];
  untrusted: string[];
}

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (leading =, +,
 * -, @, or a tab/CR, also after leading spaces) gets an apostrophe in front, so
 * a coin named `=HYPERLINK(…)` opens as text. Numbers WE produce are written
 * as numbers and left alone: they come from numeric columns, cannot be a
 * formula, and a -12.5 P&L has to stay a number.
 */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) || /^\s+[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function truncationText(kept: number): string {
  return `Truncated: only the newest ${kept} row(s) are included (limit ${EXPORT_MAX_ROWS} rows or ${EXPORT_MAX_BYTES / (1024 * 1024)} MB). Narrow since/until to export the rest.`;
}

function renderCsv(t: Table): { content: string; rows: number; truncated: boolean } {
  const lines = [`${t.columns.map(csvCell).join(",")}\r\n`];
  let bytes = Buffer.byteLength(lines[0]!);
  let kept = 0;
  let truncated = t.more || t.rows.length > EXPORT_MAX_ROWS;
  for (const row of t.rows.slice(0, EXPORT_MAX_ROWS)) {
    const line = `${row.map(csvCell).join(",")}\r\n`;
    const b = Buffer.byteLength(line);
    if (bytes + b > EXPORT_MAX_BYTES - ENVELOPE_RESERVE) {
      truncated = true;
      break;
    }
    lines.push(line);
    bytes += b;
    kept += 1;
  }
  // The note row goes last, in the first column, so every data row above it is intact.
  if (truncated) lines.push(`${csvCell(`# ${truncationText(kept)}`)}\r\n`);
  return { content: lines.join(""), rows: kept, truncated };
}

function renderJson(t: Table, meta: Record<string, unknown>): { content: string; rows: number; truncated: boolean } {
  const parts: string[] = [];
  let bytes = 0;
  let truncated = t.more || t.rows.length > EXPORT_MAX_ROWS;
  for (const row of t.rows.slice(0, EXPORT_MAX_ROWS)) {
    const s = JSON.stringify(Object.fromEntries(t.columns.map((c, i) => [c, row[i] ?? null])));
    const b = Buffer.byteLength(s) + 1;
    if (bytes + b > EXPORT_MAX_BYTES - ENVELOPE_RESERVE) {
      truncated = true;
      break;
    }
    parts.push(s);
    bytes += b;
  }
  const head = JSON.stringify({
    ...meta,
    columns: t.columns,
    row_count: parts.length,
    truncated,
    truncated_note: truncated ? truncationText(parts.length) : null,
    notes: t.notes,
    untrusted_fields: t.untrusted,
  });
  return { content: `${head.slice(0, -1)},"rows":[${parts.join(",")}]}`, rows: parts.length, truncated };
}

export interface ExportInput {
  kind: ExportKind;
  format: ExportFormat;
  agentSlug: string;
  accounts: readonly string[];
  /** Trades and decisions only; ignored for the portfolio, which is the latest state. */
  since: number;
  until: number;
  now: number;
  includeRefusals: boolean;
}

export interface BuiltExport {
  filename: string;
  mimeType: string;
  content: string;
  bytes: number;
  rows: number;
  truncated: boolean;
  notes: string[];
  untrusted: string[];
}

function bookOfTrade(status: string, rule: string | null): BookName | "none" {
  if (status === "paper") return "paper";
  if (status === "landed" || status === "submitted" || status === "reverted") return "live";
  // A refusal moved no money; one from the paper fill says so in its prefix.
  return rule?.trim().toLowerCase().startsWith("paper:") ? "paper" : "none";
}

async function tradesTable(db: Db, scope: Scope, since: number, until: number, includeRefusals: boolean, clean: TextCleaner): Promise<Table> {
  const statuses = includeRefusals ? "" : " AND t.status <> 'rejected'";
  const rows = (await db.prepare(
    `SELECT t.id, t.agent_id, t.kind, t.status, t.fill_side, t.sell_token, t.buy_token, t.amount_usdg, t.fill_cash_usdg, t.fill_price_usd,
            t.fill_qty_raw, t.realized_pnl_usdg, t.basis_source, t.gas_usdg, t.gas_wei, t.sponsored_gas_wei, t.tx_hash, t.reject_rule,
            t.decision_id, t.created_at, COALESCE(t.fill_symbol, d.symbol) AS symbol, d.display_name, d.action, ${OP_KEY} AS op_key
       FROM ${distinctTrades(`${scope.on("t.agent_id")} AND t.created_at >= ?`)} ${DECISION_JOIN}
      WHERE t.created_at >= ? AND t.created_at < ?${statuses}
      ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
  ).all(...scope.args, since - OP_COPY_REACH_SEC, since, until, EXPORT_MAX_ROWS + 1)) as Record<string, unknown>[];
  const more = rows.length > EXPORT_MAX_ROWS;
  const kept = rows.slice(0, EXPORT_MAX_ROWS);
  const notes: string[] = [
    "One row per operation. book: paper = simulated, live = the owner's funds, none = a refusal that moved nothing.",
    "confirmed is true only for a landed operation with a transaction hash; submitted has no final outcome yet.",
    "realized_pnl_usdg is filled only when both the sell's proceeds and its cost basis were evidenced (realized_pnl_status evidenced); otherwise it is blank.",
    "order_usdg is the amount the order asked for; fill_cash_usdg is the cash that actually moved, when recorded.",
  ];
  // Which recorded realized figures are measurements, per account and book.
  const vouched = new Set<string>();
  const groups = new Map<string, { account: string; book: "landed" | "paper"; sells: Array<{ op: string; token: string }> }>();
  for (const r of kept) {
    if (r.fill_side !== "sell" || num(r.realized_pnl_usdg) === null || (r.status !== "landed" && r.status !== "paper")) continue;
    const account = str(r.agent_id);
    const token = str(r.sell_token);
    const op = str(r.op_key);
    if (!account || !token || !op) continue;
    const book = r.status === "paper" ? "paper" : "landed";
    const key = `${account.toLowerCase()}|${book}`;
    const g = groups.get(key) ?? { account: account.toLowerCase(), book, sells: [] };
    groups.set(key, g);
    g.sells.push({ op, token });
  }
  let replayFailed = false;
  let splitSpelling = false;
  for (const g of groups.values()) {
    try {
      // Same rule as readRealized: two spellings vouch for nothing.
      const spelling = await readTradeSpelling(db, g.account);
      if (spelling === null) { splitSpelling = true; continue; }
      for (const op of await readEvidencedSells(db, spelling === "none" ? g.account : spelling, g.book, g.sells)) vouched.add(op);
    } catch {
      replayFailed = true;
    }
  }
  if (replayFailed) notes.push("The cost replay could not be read for some sells; their realized P&L is left blank.");
  if (splitSpelling) notes.push("An account's trades are recorded under two spellings of its address; its sells cannot be replayed whole, so their realized P&L is left blank (unverified).");
  const out: Cell[][] = kept.map((r) => {
    const status = str(r.status) ?? "unknown";
    const rule = str(r.reject_rule);
    const refusal = status === "rejected" || status === "reverted" ? normalizeRefusal(rule) : null;
    const side = sideOf({ fill_side: str(r.fill_side), sell_token: str(r.sell_token), buy_token: str(r.buy_token) })
      ?? (r.action === "buy" || r.action === "sell" ? r.action : null);
    const pnl = num(r.realized_pnl_usdg);
    const isSell = r.fill_side === "sell" && (status === "landed" || status === "paper");
    const evidenced = isSell && pnl !== null && vouched.has(String(r.op_key));
    const gasUsdg = num(r.gas_usdg);
    const gasStatus = status !== "landed" ? "none"
      : gasUsdg !== null ? "priced"
        : r.gas_wei != null ? "unpriced"
          : r.sponsored_gas_wei != null ? "sponsored" : "not_recorded";
    const tx = str(r.tx_hash)?.toLowerCase() ?? null;
    return [
      iso(num(r.created_at) ?? 0),
      (str(r.agent_id) ?? "").toLowerCase(),
      bookOfTrade(status, rule),
      status,
      status === "landed" && tx !== null,
      clean(str(r.kind), 32),
      side,
      clean(str(r.symbol), 32),
      clean(str(r.display_name), 64),
      side === "buy" ? str(r.buy_token)?.toLowerCase() ?? null : side === "sell" ? str(r.sell_token)?.toLowerCase() ?? null : null,
      str(r.sell_token)?.toLowerCase() ?? null,
      str(r.buy_token)?.toLowerCase() ?? null,
      num(r.amount_usdg),
      num(r.fill_cash_usdg),
      num(r.fill_price_usd),
      str(r.fill_qty_raw),
      evidenced ? pnl : null,
      !isSell ? "none" : evidenced ? "evidenced" : "unverified",
      status === "landed" ? gasUsdg : null,
      gasStatus,
      tx,
      refusal?.rule ?? null,
      refusal?.label ?? null,
      clean(str(r.decision_id), 80),
    ];
  });
  return {
    columns: ["at", "account", "book", "status", "confirmed", "kind", "side", "symbol", "name", "token", "sell_token", "buy_token",
      "order_usdg", "fill_cash_usdg", "fill_price_usd", "fill_qty_raw", "realized_pnl_usdg", "realized_pnl_status", "gas_usdg", "gas_status",
      "tx_hash", "refusal_rule", "refusal_label", "decision_id"],
    rows: out,
    more,
    notes,
    untrusted: ["symbol", "name"],
  };
}

async function decisionsTable(db: Db, scope: Scope, since: number, until: number, clean: TextCleaner): Promise<Table> {
  // signals_json and evidence_json are never selected: the first is the
  // owner's whole balance sheet at decision time, and neither belongs in a file.
  const rows = (await db.prepare(
    `SELECT d.id, d.agent_id, d.at, d.source, d.action, d.symbol, d.display_name, d.size_usdg, d.reason, d.dropped_rule, d.hold_kind
       FROM decisions d WHERE ${scope.on("d.agent_id")} AND d.at >= ? AND d.at < ?
      ORDER BY d.at DESC, d.id DESC LIMIT ?`,
  ).all(...scope.args, since, until, EXPORT_MAX_ROWS + 1)) as Record<string, unknown>[];
  const more = rows.length > EXPORT_MAX_ROWS;
  const out: Cell[][] = rows.slice(0, EXPORT_MAX_ROWS).map((r) => {
    const hold = str(r.hold_kind);
    const action = str(r.action);
    // A Brain run that could not reach or parse its service stored the raw
    // service error as its reason (URLs, internals): the decisions service's own
    // rule withholds it, and a file must not carry what the tools withhold.
    const explanation = explanationOf(str(r.reason), str(r.dropped_rule));
    return [
      clean(str(r.id), 80),
      iso(num(r.at) ?? 0),
      (str(r.agent_id) ?? "").toLowerCase(),
      clean(str(r.source), 64),
      action && /^[a-z][a-z_-]{0,23}$/.test(action) ? action : action === null ? null : "other",
      clean(str(r.symbol), 32),
      clean(str(r.display_name), 64),
      num(r.size_usdg),
      clean(explanation.text, 2000),
      explanation.withheld !== null,
      clean(str(r.dropped_rule), 200),
      hold && /^[A-Z_]{1,32}$/.test(hold) ? hold : null,
    ];
  });
  return {
    columns: ["id", "at", "account", "source", "action", "symbol", "name", "size_usdg", "reason", "reason_withheld", "dropped_rule", "hold_kind"],
    rows: out,
    more,
    notes: [
      "Every decision the agent recorded, including dropped proposals and holds. Decisions belong to no book and moved no money by themselves.",
      "reason is the deciding model's or strategy's own words; dropped_rule can embed a symbol the model supplied.",
      "reason_withheld is true when the stored text is a raw service error (a Brain run that could not reach or parse its service); it is not exported, and the agent's activity log in Merrymen shows it.",
      "source market-review-private is a quiet market review the agent writes every few minutes when nothing changed.",
    ],
    untrusted: ["symbol", "name", "reason", "dropped_rule"],
  };
}

async function portfolioTable(db: Db, scope: Scope, clean: TextCleaner): Promise<Table> {
  const latest = async (book: BookName) => (await db.prepare(
    `SELECT e.agent_id, e.at, e.cash_usdg, e.vault_usdg, e.positions_usdg, e.equity_usdg, e.epoch FROM equity e
      WHERE ${scope.on("e.agent_id")} AND e.mode = ? ORDER BY e.at DESC, e.id DESC LIMIT 1`,
  ).get(...scope.args, book)) as Record<string, unknown> | undefined;
  const marks: Record<BookName, Record<string, unknown> | undefined> = { live: await latest("live"), paper: await latest("paper") };
  const at = (b: BookName) => num(marks[b]?.at) ?? -1;
  const current: BookName | null = marks.live || marks.paper ? (at("live") >= at("paper") ? "live" : "paper") : null;
  const notes: string[] = [
    "book: paper = simulated, live = the owner's funds. Valuation rows are the latest equity mark of each book.",
    "The positions table holds holdings only for the book the agent is running now; the other book lists its cost basis without a value.",
    "unrealized_pnl_usdg is blank when the price is stale or the cost is unknown or includes a fill booked from a pre-trade quote.",
    "raw_balance is the token's raw on-chain units; the ledger does not record decimals, so no human quantity is derived.",
  ];
  if (!current) notes.push("No valuation has been recorded for this agent, so its current book and holdings are unknown.");
  const rows: Cell[][] = [];
  const blank = (n: number) => Array<Cell>(n).fill(null);
  for (const book of current === "paper" ? (["paper", "live"] as const) : (["live", "paper"] as const)) {
    const m = marks[book];
    if (!m) {
      rows.push([book, "valuation", null, null, null, ...blank(9), null, null, null, null, `No ${book} valuation recorded.`]);
      continue;
    }
    const account = (str(m.agent_id) ?? "").toLowerCase();
    rows.push([book, "valuation", iso(num(m.at) ?? 0), account, num(m.epoch), ...blank(9),
      num(m.cash_usdg), num(m.vault_usdg), num(m.positions_usdg), num(m.equity_usdg),
      "equity can exceed cash + vault + positions by USDG held in launch or Trencher vaults and by holdings carried at cost; gas ETH is excluded"]);
    if (book === current) {
      const spellings = (await db.prepare("SELECT DISTINCT p.agent_id FROM positions p WHERE lower(p.agent_id) = ? LIMIT 4").all(account)) as Record<string, unknown>[];
      // readDeskPositions replays each holding's cost under the POSITIONS
      // spelling; that replay is only whole when the trades carry that same
      // single spelling. Otherwise no holding's provenance is vouched for.
      const tradeSpelled = await readTradeSpelling(db, account).catch(() => null);
      for (const s of spellings) {
        const spelled = str(s.agent_id);
        if (!spelled) continue;
        const wholeTape = tradeSpelled === "none" || tradeSpelled === spelled;
        const updated = await db.prepare("SELECT MAX(p.updated_at) AS at FROM positions p WHERE p.agent_id = ?").get(spelled) as Record<string, unknown> | undefined;
        const valuedAt = num(updated?.at);
        for (const p of await readDeskPositions(db, spelled, book)) {
          const cost = p.cost_usdg ?? null;
          const stale = Number(p.price_stale) === 1;
          const value = num(p.value_usdg);
          const fromQuote = wholeTape ? p.cost_from_quote ?? null : null;
          const unrealized = cost !== null && value !== null && !stale && fromQuote === false ? value - cost : null;
          const why = cost === null ? "no cost basis on record"
            : stale ? "price is stale"
              : fromQuote === true ? "cost includes a fill booked from a pre-trade quote"
                : fromQuote !== false ? "cost provenance could not be checked" : null;
          rows.push([book, "position", valuedAt === null ? null : iso(valuedAt), spelled.toLowerCase(), null, clean(p.symbol, 32),
            clean(p.raw_balance, 80), num(p.price_usd), stale, clean(p.price_source, 16), value, cost, unrealized,
            fromQuote, null, null, null, null, why]);
        }
      }
    } else {
      const basis = (await db.prepare(
        `SELECT b.symbol, b.qty_raw, b.cost_usdg, b.updated_at FROM cost_basis b
          WHERE lower(b.agent_id) = ? AND b.mode = ? ORDER BY b.updated_at DESC LIMIT 500`,
      ).all(account, book)) as Record<string, unknown>[];
      for (const b of basis) {
        const qty = str(b.qty_raw);
        if (!qty || /^0+$/.test(qty.trim())) continue;
        const updated = num(b.updated_at);
        rows.push([book, "cost_basis", updated === null ? null : iso(updated), account, null, clean(str(b.symbol), 32), clean(qty, 80),
          null, null, null, null, basisUsdg(b.cost_usdg), null, null, null, null, null, null,
          `not valued: the agent is running its ${current ?? "other"} book now`]);
      }
    }
  }
  return {
    columns: ["book", "row_type", "valued_at", "account", "epoch", "symbol", "raw_balance", "price_usd", "price_stale", "price_source",
      "value_usdg", "cost_usdg", "unrealized_pnl_usdg", "cost_from_quote", "cash_usdg", "vault_usdg", "positions_usdg", "equity_usdg", "note"],
    rows,
    more: false,
    notes,
    untrusted: ["symbol"],
  };
}

function stamp(sec: number): string {
  return iso(sec).replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function exportMimeType(format: ExportFormat): string {
  return format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";
}

/** Build one export. THROWS when the ledger cannot be read. */
export async function buildExport(db: Db, input: ExportInput, clean: TextCleaner): Promise<BuiltExport> {
  const scope = scopeOf(input.accounts);
  const table = input.kind === "trades"
    ? await tradesTable(db, scope, input.since, input.until, input.includeRefusals, clean)
    : input.kind === "decisions"
      ? await decisionsTable(db, scope, input.since, input.until, clean)
      : await portfolioTable(db, scope, clean);
  const windowed = input.kind !== "portfolio";
  const rendered = input.format === "csv"
    ? renderCsv(table)
    : renderJson(table, {
      format: "merrymen-export",
      version: 1,
      kind: input.kind,
      agent: input.agentSlug,
      generated_at: iso(input.now),
      window: windowed ? { since: iso(input.since), until: iso(input.until) } : null,
    });
  const notes = [...table.notes];
  if (rendered.truncated) notes.push(truncationText(rendered.rows));
  return {
    filename: `merrymen-${input.agentSlug}-${input.kind}-${stamp(input.now)}.${input.format}`,
    mimeType: exportMimeType(input.format),
    content: rendered.content,
    bytes: Buffer.byteLength(rendered.content),
    rows: rendered.rows,
    truncated: rendered.truncated,
    notes,
    untrusted: table.untrusted,
  };
}

// ── the export store (mcp_exports) ──────────────────────────────────────────

export const EXPORT_ID = /^exp_[0-9a-f]{32}$/;

export function newExportId(): string {
  return `exp_${randomBytes(16).toString("hex")}`;
}

/**
 * The agent an export describes, from the filename this module wrote. The
 * table has no agent column, and a connection may only read exports about
 * agents it was given; the filename is ours, so its shape is fixed.
 */
export function exportAgentSlug(filename: string): string | null {
  const m = /^merrymen-([0-9a-hjkmnp-tv-z]{16})-(?:trades|decisions|portfolio)-/.exec(filename);
  return m ? m[1]! : null;
}

export interface ExportRecord {
  id: string;
  tenant: string;
  connection_id: string | null;
  kind: ExportKind;
  format: ExportFormat;
  filename: string;
  bytes: number;
  created_at: number;
  expires_at: number;
  content?: string;
}

function recordOf(r: Record<string, unknown>, withContent: boolean): ExportRecord | null {
  const kind = r.kind === "trades" || r.kind === "decisions" || r.kind === "portfolio" ? r.kind : null;
  const format = r.format === "csv" || r.format === "json" ? r.format : null;
  const id = str(r.id);
  const tenant = str(r.tenant);
  const filename = str(r.filename);
  const created = num(r.created_at);
  const expires = num(r.expires_at);
  if (!kind || !format || !id || !tenant || !filename || created === null || expires === null) return null;
  return {
    id, tenant, connection_id: str(r.connection_id), kind, format, filename, bytes: num(r.bytes) ?? 0, created_at: created, expires_at: expires,
    ...(withContent && typeof r.content === "string" ? { content: r.content } : {}),
  };
}

export async function saveExport(db: Db, rec: ExportRecord & { content: string }): Promise<void> {
  await db.prepare(`INSERT INTO mcp_exports (id, tenant, connection_id, kind, format, filename, content, bytes, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(rec.id, rec.tenant.toLowerCase(), rec.connection_id, rec.kind, rec.format, rec.filename, rec.content, rec.bytes, rec.created_at, rec.expires_at);
}

/** One export of this owner, expired or not (the caller decides what expiry means). Null for anyone else's. */
export async function readExport(db: Db, tenant: string, id: string, withContent: boolean): Promise<ExportRecord | null> {
  if (!EXPORT_ID.test(id)) return null;
  const row = await db.prepare(
    `SELECT id, tenant, connection_id, kind, format, filename, bytes, created_at, expires_at${withContent ? ", content" : ""}
       FROM mcp_exports WHERE id = ? AND tenant = ?`,
  ).get(id, tenant.toLowerCase()) as Record<string, unknown> | undefined;
  return row ? recordOf(row, withContent) : null;
}

/**
 * This owner's unexpired exports about the given agents, newest first.
 * `before` continues a page (created_at, id). Metadata only.
 */
export async function listExports(
  db: Db,
  tenant: string,
  now: number,
  o: { agentSlugs: readonly string[]; before?: { created_at: number; id: string } | null; limit: number },
): Promise<ExportRecord[]> {
  const slugs = o.agentSlugs.filter((s) => /^[0-9a-hjkmnp-tv-z]{16}$/.test(s)).slice(0, 32);
  if (!slugs.length) return [];
  const byAgent = slugs.map(() => "filename LIKE ?").join(" OR ");
  const page = o.before ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : "";
  const rows = (await db.prepare(
    `SELECT id, tenant, connection_id, kind, format, filename, bytes, created_at, expires_at FROM mcp_exports
      WHERE tenant = ? AND expires_at > ? AND (${byAgent})${page}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(tenant.toLowerCase(), now, ...slugs.map((s) => `merrymen-${s}-%`),
    ...(o.before ? [o.before.created_at, o.before.created_at, o.before.id] : []), Math.max(1, Math.min(o.limit, 200)))) as Record<string, unknown>[];
  return rows.map((r) => recordOf(r, false)).filter((r): r is ExportRecord => r !== null);
}

/** How much this owner holds in unexpired exports right now. */
export async function liveExportUsage(db: Db, tenant: string, now: number): Promise<{ count: number; bytes: number; oldestExpiresAt: number | null }> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b, MIN(expires_at) AS oldest FROM mcp_exports WHERE tenant = ? AND expires_at > ?",
  ).get(tenant.toLowerCase(), now) as Record<string, unknown> | undefined;
  return { count: num(row?.n) ?? 0, bytes: num(row?.b) ?? 0, oldestExpiresAt: num(row?.oldest) };
}

/** Drop this owner's expired exports; they can no longer be read by anyone. */
export async function purgeExpiredExports(db: Db, tenant: string, now: number): Promise<void> {
  await db.prepare("DELETE FROM mcp_exports WHERE tenant = ? AND expires_at <= ?").run(tenant.toLowerCase(), now);
}
