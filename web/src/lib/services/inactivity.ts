/**
 * "Why hasn't my agent traded?", answered from the shared ledger alone.
 *
 * The honest answer is almost never one fact. An agent can be armed, funded
 * and alive and still hold for a day because its model keeps saying hold; it
 * can be proposing every tick and be refused on the daily cap; its permission
 * can have expired a week ago, which also freezes its heartbeat — and a frozen
 * heartbeat read on its own looks exactly like a dead worker. So this reads
 * every shared record that bears on the question, turns each into a CHECK with
 * a status and the observed value it was judged on, and only then picks the
 * one cause that explains the silence best, in a fixed order: a thing that
 * stops everything (no permission, both books off, a pause, a dead worker, a
 * broken live rail, no gas) outranks what the agent did with the time it had
 * (refusals, failed quotes, reverts, holds).
 *
 * SPLIT IN TWO so the judgement can be tested without a database:
 * `readInactivityInputs` does the bounded SQL, `diagnoseInactivity` is a pure
 * function over its result.
 *
 * WHAT IT CANNOT KNOW, it says. The pause flag, the worker's own logs, the
 * Brain's gate reasons and any setting overridden on the agent's own machine
 * never reach shared storage; each appears in `unknown_from_shared_records`
 * rather than being guessed. Event text is used to CLASSIFY and never
 * returned: it carries raw provider errors, chat ids and addresses.
 *
 * Reuses: agent-status.ts (the agents row, `freshWithin` — the watchdog's one
 * freshness rule — and `blockerView`), core's `liveBlockerText`, live-blocker's
 * `blockerAdvice`, and decisions.ts (`describeRule`, `tallyRefusals`, which in
 * turn use thesis-policy's labels and remedies).
 */
import { liveBlockerText, type RefuseRule } from "@merrymen/core";
import type { Db } from "../../../../worker/src/db";
import { PRIVATE_REVIEW_SOURCE } from "../../../../worker/src/market-review";
import { rejectRuleRemedy } from "../../../../worker/src/thesis-policy";
import { blockerAdvice } from "../live-blocker";
import { blockerView, freshWithin, readAgentRow, type AgentLedgerRow } from "./agent-status";
import {
  FILL_KINDS, REVIEW_SOURCES, SHADOW_DECISION_SOURCES, countFills, normAccounts, readWindowTrades, tallyRefusals, txHashOrNull,
  type RefusalBucket, type RuleFamily, type Scalar, type WindowTrade,
} from "./decisions";
import type { SettingsView } from "./settings-view";

// ── inputs ───────────────────────────────────────────────────────────────────

/**
 * The window's decisions by what they were. `total` counts only rows that
 * could lead to a trade: a Brain SHADOW run is recorded to be watched and is
 * never sent (thesis-policy SHADOW_SOURCES), so its buys are not attempts and
 * its failures stop nothing; those are counted apart, in `shadow_*`.
 */
export interface DecisionTally {
  total: number;
  buys: number;
  sells: number;
  other_actions: number;
  model_holds: number;
  gate_forced_holds: number;
  stale_mark_holds: number;
  unknown_holds: number;
  /** Quiet-market reviews (market-review.ts): written while the strategy proposes nothing. */
  quiet_reviews: number;
  views: number;
  brain_refused: number;
  brain_unreachable: number;
  brain_malformed: number;
  dropped: number;
  shadow_decisions: number;
  shadow_failures: number;
  first_at: number | null;
  last_at: number | null;
  /** When the live (non-shadow) Brain runs in the window failed, first and last. */
  brain_failure_first_at: number | null;
  brain_failure_last_at: number | null;
}

export const EMPTY_TALLY: DecisionTally = {
  total: 0, buys: 0, sells: 0, other_actions: 0, model_holds: 0, gate_forced_holds: 0, stale_mark_holds: 0, unknown_holds: 0,
  quiet_reviews: 0, views: 0, brain_refused: 0, brain_unreachable: 0, brain_malformed: 0, dropped: 0,
  shadow_decisions: 0, shadow_failures: 0, first_at: null, last_at: null, brain_failure_first_at: null, brain_failure_last_at: null,
};

/**
 * `brain_failure` is kept apart from `provider_failure`: every failed Brain run
 * writes BOTH an event and a decision row (brain-shadow.ts), and the decision
 * row is the one that says whether it was a live or a shadow run — so Brain
 * failures are counted from decisions, and the event is only reported.
 */
export type EventKind = "market_unreadable" | "provider_failure" | "brain_failure" | "brain_refused" | "execution_failure" | "policy_notice" | "arm_failure" | "funding_notice" | "consent_notice" | "other";

/**
 * What a warn/err event is about, from the fixed openings the worker writes
 * (index.ts, strategist/strategy.ts, strategist/desk.ts, brain-shadow.ts).
 * Matching the opening only: the rest of the line is where raw error text sits.
 */
export function classifyEvent(message: string): EventKind {
  const m = message.slice(0, 120);
  if (/^the market could not be read this tick/i.test(m)) return "market_unreadable";
  if (/^brain (unreachable|malformed):/i.test(m)) return "brain_failure";
  if (/^(strategist driver failed|desk: the model could not be reached|desk: the model stopped without|desk: ran out of steps|strategist emitted \d+ malformed)/i.test(m)) return "provider_failure";
  if (/^brain refused:/i.test(m)) return "brain_refused";
  if (/^this agent CANNOT START/.test(m)) return "arm_failure";
  if (/^no ETH in the account/i.test(m)) return "funding_notice";
  // index.ts trenchCandidates: the Trencher's feed is empty because a setting says so.
  if (/^trencher is running but (live trenching is off|your asset mode is Stocks only)/i.test(m)) return "consent_notice";
  if (/^policy rejected /i.test(m)) return "policy_notice";
  if (/ (reverted on-chain|failed before submit)[: ]|not retried again until the next arm|the gas sponsor declined/i.test(m)) return "execution_failure";
  return "other";
}

export interface EventCount { count: number; first_at: number | null; last_at: number | null }
export type EventTally = Record<EventKind, EventCount> & { scanned: number; truncated: boolean };

const emptyCount = (): EventCount => ({ count: 0, first_at: null, last_at: null });
export function emptyEvents(): EventTally {
  return {
    market_unreadable: emptyCount(), provider_failure: emptyCount(), brain_failure: emptyCount(), brain_refused: emptyCount(), execution_failure: emptyCount(),
    policy_notice: emptyCount(), arm_failure: emptyCount(), funding_notice: emptyCount(), consent_notice: emptyCount(), other: emptyCount(), scanned: 0, truncated: false,
  };
}

export function tallyEvents(rows: ReadonlyArray<{ message: string; created_at: number }>, truncated: boolean): EventTally {
  const t = emptyEvents();
  for (const r of rows) {
    const c = t[classifyEvent(r.message)];
    c.count += 1;
    c.first_at = c.first_at === null ? r.created_at : Math.min(c.first_at, r.created_at);
    c.last_at = c.last_at === null ? r.created_at : Math.max(c.last_at, r.created_at);
  }
  t.scanned = rows.length;
  t.truncated = truncated;
  return t;
}

/** The live-rail notice the worker writes once per change (index.ts), read for the one fact it alone carries. */
export interface RailNotice {
  at: number;
  state: "live" | "paper" | "off" | "blocked";
  /** What would still block live trading once the owner turns it on — published only in this line. */
  wouldBlock: RefuseRule | null;
}

const RULES: readonly RefuseRule[] = ["not-armed", "dead-policy", "grant-too-wide", "no-executor", "live-not-enabled", "wrong-chain", "no-gas", "no-cash"];

export function parseRailNotice(message: string, at: number): RailNotice | null {
  const ruleIn = (text: string): RefuseRule | null => RULES.find((r) => text.includes(liveBlockerText(r))) ?? null;
  if (/^trading for real — every leg/.test(message)) return { at, state: "live", wouldBlock: null };
  if (/^NOT trading for real yet: /.test(message)) return { at, state: "blocked", wouldBlock: ruleIn(message) };
  const later = /One thing to know first: when you do turn it on, (.*)$/s.exec(message);
  if (/^Paper mode: /.test(message)) return { at, state: "paper", wouldBlock: later ? ruleIn(later[1]) : null };
  if (/^Live trading is off and paper trading is off too/.test(message)) return { at, state: "off", wouldBlock: later ? ruleIn(later[1]) : null };
  return null;
}

export interface InactivityInputs {
  now: number;
  windowSec: number;
  /** The current smart account (the agents row and the books live under it). */
  account: string | null;
  permission: { grantedAt: number | null; expiresAt: number | null };
  agentRow: AgentLedgerRow | null;
  settings: SettingsView | null;
  /** Newest complete valuation (equity row) of the current account, either book. */
  valuation: { at: number; mode: string | null } | null;
  /** Newest LIVE-book valuation of the current account: the only honest funding figure. */
  liveFunding: { at: number; cash_usdg: number | null; eth_wei: string | null } | null;
  decisions: DecisionTally;
  /** The newest view the strategy wrote (no action), within 30 days — written once per change, so often older than the window. */
  latestView: { at: number; reason: string | null } | null;
  trades: { rows: WindowTrade[]; truncated: boolean };
  lastLive: { at: number; tx_hash: string | null } | null;
  lastPaper: { at: number } | null;
  /**
   * The newest strategy decision or trade row written AFTER a recorded /pause.
   * Both are produced past the worker's pause gate, so either proves the pause
   * no longer holds. Brain rows do not count: its shadow run decides before
   * that gate and keeps writing while the agent is paused.
   */
  actedAfterPause: number | null;
  events: EventTally;
  railNotice: RailNotice | null;
  pause: { state: "paused" | "resumed"; at: number } | null;
  killAt: number | null;
  expiryNoticeAt: number | null;
  /** mirror_state.updated_at for this owner; "unavailable" when the table cannot be read. */
  mirrorUpdatedAt: number | null | "unavailable";
}

const holes = (n: number) => Array.from({ length: n }, () => "?").join(", ");
const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

const EVENT_SCAN_CAP = 1000;

/**
 * Every bounded read the diagnosis needs. `accounts` is the identity's whole
 * account history (activity in the window is read across all of it); the
 * books, the heartbeat and the rail are read for the CURRENT account only.
 */
export async function readInactivityInputs(db: Db, a: {
  tenant: string;
  account: string | null;
  accounts: readonly string[];
  grantedAt: number | null;
  expiresAt: number | null;
  settings: SettingsView | null;
  now: number;
  windowSec: number;
}): Promise<InactivityInputs> {
  const acc = normAccounts(a.accounts);
  const current = a.account ? a.account.toLowerCase() : null;
  const since = a.now - a.windowSec;
  const inList = `lower(agent_id) IN (${holes(Math.max(acc.length, 1))})`;
  const accParams = acc.length ? acc : ["0x"];

  const agentRow = current ? await readAgentRow(db, current) : null;
  const valuation = current
    ? ((await db.prepare("SELECT at, mode FROM equity WHERE lower(agent_id) = ? ORDER BY at DESC LIMIT 1").get(current)) as { at: number; mode: string | null } | undefined) ?? null
    : null;
  const live = current
    ? ((await db.prepare("SELECT at, cash_usdg, eth_wei FROM equity WHERE lower(agent_id) = ? AND mode = 'live' ORDER BY at DESC LIMIT 1").get(current)) as Record<string, unknown> | undefined)
    : undefined;

  // Private reviews are the unchanged ones (market-review.ts): the same quiet
  // tick as a published review, so they are counted with it, not dropped.
  const shadowList = SHADOW_DECISION_SOURCES.map(() => "?").join(", ");
  const reviewList = REVIEW_SOURCES.map(() => "?").join(", ");
  const groups = (await db.prepare(`SELECT action, hold_kind,
        CASE WHEN dropped_rule IN ('brain-refused', 'brain-unreachable', 'brain-malformed') THEN dropped_rule
             WHEN dropped_rule IS NOT NULL THEN 'dropped' ELSE NULL END AS drop_kind,
        CASE WHEN source IN (${shadowList}) THEN 'shadow' WHEN source IN (${reviewList}) THEN 'review' ELSE 'own' END AS origin,
        COUNT(*) AS n, MIN(at) AS first_at, MAX(at) AS last_at
      FROM decisions WHERE ${inList} AND at >= ?
      GROUP BY 1, 2, 3, 4 LIMIT 400`).all(...SHADOW_DECISION_SOURCES, ...REVIEW_SOURCES, ...accParams, since)) as Array<Record<string, unknown>>;
  const decisions = { ...EMPTY_TALLY };
  for (const g of groups) {
    const count = n(g.n) ?? 0;
    const action = g.action === null || g.action === undefined ? null : String(g.action);
    const drop = g.drop_kind === null || g.drop_kind === undefined ? null : String(g.drop_kind);
    if (g.origin === "shadow") {
      decisions.shadow_decisions += count;
      if (drop === "brain-unreachable" || drop === "brain-malformed") decisions.shadow_failures += count;
      continue;
    }
    decisions.total += count;
    const f = n(g.first_at);
    const l = n(g.last_at);
    if (f !== null) decisions.first_at = decisions.first_at === null ? f : Math.min(decisions.first_at, f);
    if (l !== null) decisions.last_at = decisions.last_at === null ? l : Math.max(decisions.last_at, l);
    if (g.origin === "review") decisions.quiet_reviews += count;
    else if (drop === "brain-refused") decisions.brain_refused += count;
    else if (drop === "brain-unreachable" || drop === "brain-malformed") {
      if (drop === "brain-unreachable") decisions.brain_unreachable += count;
      else decisions.brain_malformed += count;
      if (f !== null) decisions.brain_failure_first_at = decisions.brain_failure_first_at === null ? f : Math.min(decisions.brain_failure_first_at, f);
      if (l !== null) decisions.brain_failure_last_at = decisions.brain_failure_last_at === null ? l : Math.max(decisions.brain_failure_last_at, l);
    }
    else if (drop === "dropped") decisions.dropped += count;
    else if (action === "buy") decisions.buys += count;
    else if (action === "sell") decisions.sells += count;
    else if (action === "hold") {
      const k = g.hold_kind;
      if (k === "MODEL_HOLD") decisions.model_holds += count;
      else if (k === "GATE_FORCED_HOLD") decisions.gate_forced_holds += count;
      else if (k === "STALE_MARK_HOLD") decisions.stale_mark_holds += count;
      else decisions.unknown_holds += count;
    } else if (action === null) decisions.views += count;
    else decisions.other_actions += count;
  }

  const view = (await db.prepare(`SELECT reason, at FROM decisions WHERE ${inList} AND action IS NULL AND dropped_rule IS NULL AND source <> ? AND at >= ?
      ORDER BY at DESC LIMIT 1`).get(...accParams, PRIVATE_REVIEW_SOURCE, a.now - 30 * 86_400)) as { reason: string | null; at: number } | undefined;

  const trades = acc.length ? await readWindowTrades(db, acc, since) : { rows: [], truncated: false };
  // A fill of a market position: a landed transfer or vault deposit is not a trade.
  const fillKinds = FILL_KINDS.map(() => "?").join(", ");
  const lastLive = (await db.prepare(`SELECT created_at, tx_hash FROM trades WHERE ${inList} AND status = 'landed' AND kind IN (${fillKinds})
      ORDER BY created_at DESC LIMIT 1`).get(...accParams, ...FILL_KINDS)) as { created_at: number; tx_hash: string | null } | undefined;
  const lastPaper = (await db.prepare(`SELECT created_at FROM trades WHERE ${inList} AND status = 'paper' AND kind IN (${fillKinds})
      ORDER BY created_at DESC LIMIT 1`).get(...accParams, ...FILL_KINDS)) as { created_at: number } | undefined;

  // Messages are read to be CLASSIFIED in memory and are never returned.
  const eventRows = (await db.prepare(`SELECT message, created_at FROM events WHERE ${inList} AND created_at >= ? AND level IN ('warn', 'err')
      ORDER BY created_at DESC LIMIT ?`).all(...accParams, since, EVENT_SCAN_CAP + 1)) as Array<{ message: string; created_at: number }>;
  const events = tallyEvents(eventRows.slice(0, EVENT_SCAN_CAP).map((r) => ({ message: String(r.message), created_at: Number(r.created_at) })), eventRows.length > EVENT_SCAN_CAP);

  const railRow = current
    ? ((await db.prepare(`SELECT message, created_at FROM events WHERE lower(agent_id) = ?
        AND (message LIKE 'Paper mode:%' OR message LIKE 'Live trading is off and paper trading is off too%' OR message LIKE 'trading for real%' OR message LIKE 'NOT trading for real yet:%')
        ORDER BY created_at DESC, id DESC LIMIT 1`).get(current)) as { message: string; created_at: number } | undefined)
    : undefined;

  // The pause flag lives in the worker's home, which belongs to the OWNER, not
  // to one smart account — so a /pause recorded under an earlier account still counts.
  const control = (await db.prepare(`SELECT message, created_at FROM events WHERE ${inList}
      AND (message LIKE 'Telegram: paused by chat%' OR message LIKE 'Telegram: resumed by chat%' OR message LIKE 'KILL SWITCH%' OR message LIKE 'Telegram: KILL by chat%' OR message LIKE 'session key expired%')
      ORDER BY created_at DESC, id DESC LIMIT 20`).all(...accParams)) as Array<{ message: string; created_at: number }>;
  let pause: InactivityInputs["pause"] = null;
  let killAt: number | null = null;
  let expiryNoticeAt: number | null = null;
  for (const c of control) {
    const at = Number(c.created_at);
    if (!pause && /^Telegram: (paused|resumed) by chat/.test(c.message)) pause = { state: c.message.startsWith("Telegram: paused") ? "paused" : "resumed", at };
    if (killAt === null && /^(KILL SWITCH|Telegram: KILL by chat)/.test(c.message)) killAt = at;
    if (expiryNoticeAt === null && /^session key expired/.test(c.message)) expiryNoticeAt = at;
  }

  let actedAfterPause: number | null = null;
  if (pause?.state === "paused") {
    // Past the pause gate only. The Brain decides before it; an owner's chat
    // transfer (submitChatTransfer) never consults it and writes a `chat`
    // decision and a `transfer` trade while paused, so neither proves a resume.
    const dAfter = (await db.prepare(`SELECT MAX(at) AS at FROM decisions WHERE ${inList} AND at > ?
        AND source NOT IN ('brain', 'brain-shadow', 'chat') AND COALESCE(provenance, '') NOT IN ('brain', 'owner-command')`)
      .get(...accParams, pause.at)) as { at: number | null } | undefined;
    const tAfter = (await db.prepare(`SELECT MAX(created_at) AS at FROM trades WHERE ${inList} AND created_at > ? AND kind IN (${fillKinds})`)
      .get(...accParams, pause.at, ...FILL_KINDS)) as { at: number | null } | undefined;
    const both = [n(dAfter?.at), n(tAfter?.at)].filter((x): x is number => x !== null);
    actedAfterPause = both.length ? Math.max(...both) : null;
  }

  let mirrorUpdatedAt: InactivityInputs["mirrorUpdatedAt"];
  try {
    const m = (await db.prepare("SELECT MAX(updated_at) AS at FROM mirror_state WHERE lower(tenant) = ?").get(a.tenant.toLowerCase())) as { at: number | null } | undefined;
    mirrorUpdatedAt = n(m?.at);
  } catch {
    // The table belongs to the orchestrator's mirror; a database without it (self-hosted, tests) cannot say.
    mirrorUpdatedAt = "unavailable";
  }

  return {
    now: a.now,
    windowSec: a.windowSec,
    account: current,
    permission: { grantedAt: a.grantedAt, expiresAt: a.expiresAt },
    agentRow,
    settings: a.settings,
    valuation: valuation ? { at: Number(valuation.at), mode: valuation.mode ?? null } : null,
    liveFunding: live ? { at: Number(live.at), cash_usdg: n(live.cash_usdg), eth_wei: live.eth_wei === null || live.eth_wei === undefined ? null : String(live.eth_wei) } : null,
    decisions,
    latestView: view ? { at: Number(view.at), reason: view.reason ?? null } : null,
    trades,
    lastLive: lastLive ? { at: Number(lastLive.created_at), tx_hash: lastLive.tx_hash ?? null } : null,
    lastPaper: lastPaper ? { at: Number(lastPaper.created_at) } : null,
    actedAfterPause,
    events,
    railNotice: railRow ? parseRailNotice(String(railRow.message), Number(railRow.created_at)) : null,
    pause,
    killAt,
    expiryNoticeAt,
    mirrorUpdatedAt,
  };
}

// ── the diagnosis ────────────────────────────────────────────────────────────

/** Every check, in the order they are reported. */
export const CHECK_ORDER = [
  "permission", "worker_liveness", "live_rail", "funding", "settings_consent", "paused", "market_data",
  "provider", "model_holds", "policy_refusals", "quote_failures", "execution_failures", "data_freshness",
] as const;
export type CheckCategory = (typeof CHECK_ORDER)[number];

export const CHECK_STATUSES = ["ok", "blocking", "warning", "unknown"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** What a cause IS, in the terms an owner asks about. Distinct kinds, never merged. */
export const CAUSE_KINDS = [
  "not_permitted", "permission_pending", "worker_not_reporting", "live_rail_blocked", "unfunded", "consent_off",
  "paper_by_choice", "paused", "missing_data", "provider_failure", "model_hold", "brain_gate_hold", "stale_mark_hold",
  "hold_kind_unrecorded", "brain_refused", "strategy_idle", "proposal_dropped", "no_trade_reached_wall", "policy_refusal",
  "quote_failure", "execution_failure", "awaiting_confirmation", "unrecognised_refusal", "stale_records", "trading", "no_activity",
] as const;
export type CauseKind = (typeof CAUSE_KINDS)[number];

export interface Check {
  category: CheckCategory;
  status: CheckStatus;
  /** What this check means when it is the cause; null when it is fine. */
  kind: CauseKind | null;
  summary: string;
  observed: Record<string, Scalar>;
  threshold: Record<string, Scalar> | null;
  /** When the deciding record was written (unix seconds). */
  recorded_at: number | null;
  /** When the condition started, where the records say. */
  since: number | null;
  evidence: string[];
  remedy: string[];
}

export interface Diagnosis {
  primary: { category: CheckCategory | "none" | "unknown"; kind: CauseKind; summary: string; evidence: string[]; since: number | null };
  other_factors: Array<{ category: CheckCategory; status: CheckStatus; kind: CauseKind | null; summary: string }>;
  checks: Check[];
  decisions: DecisionTally;
  refusals: RefusalBucket[];
  /** Warn/err events in the window by kind: counts only, their text is never relayed. */
  events: EventTally;
  fills_in_window: { live_landed: number; live_confirmed: number; paper: number; submitted_unresolved: number };
  last_successful_cycle: { at: number; book: "paper" | "live" | null } | null;
  last_trade: { live: { at: number; tx_hash: string | null; confirmed: boolean } | null; paper: { at: number } | null };
  latest_view: { at: number; reason: string | null } | null;
  what_owner_can_do: string[];
  unknown_from_shared_records: string[];
  truncated: { trades: boolean; events: boolean };
}

const iso = (s: number | null | undefined): string => (typeof s === "number" && Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : "unknown");
const ago = (now: number, s: number) => `${Math.max(0, now - s)}s ago`;

export const UNKNOWN_FROM_SHARED = [
  "Whether the agent is paused right now: the pause flag is kept on the agent's own machine; shared records hold only the Telegram /pause and /resume commands.",
  "The worker's own logs and raw error text: policy details, which market reads failed, and provider errors.",
  "Why the Brain's gate shut, and Brain runs that were skipped (not configured or not triggered): these are logged, not stored.",
  "Settings overridden on the agent's own machine (its environment), which this server cannot see.",
  "Orders still in flight that have not reached the shared ledger: it lags the worker by about one tick plus the ~15 s mirror.",
];

const RAIL_BLOCKERS: ReadonlySet<string> = new Set(["not-armed", "dead-policy", "grant-too-wide", "no-executor", "wrong-chain"]);

function railRemedy(rule: string): string[] {
  const r = rejectRuleRemedy(rule);
  if (r) return [r];
  const advice = blockerAdvice(rule);
  return advice && (advice.resign || advice.funding) ? [advice.say] : [];
}

function wei(v: string | null): bigint | null {
  return v !== null && /^\d{1,78}$/.test(v) ? BigInt(v) : null;
}

/** The judgement: every check, then the one cause that best explains the silence. Pure. */
export function diagnoseInactivity(i: InactivityInputs): Diagnosis {
  const row = i.agentRow;
  const s = i.settings;
  const within = freshWithin(s?.tickSeconds);
  const beat = row?.beat_at ?? null;
  const beatAge = beat === null ? null : Math.max(0, i.now - beat);
  const heartbeatFresh = beatAge === null ? null : beatAge <= within;
  const status = row?.status ?? null;
  const expired = i.permission.expiresAt !== null && i.now >= i.permission.expiresAt;
  const notArmed = !i.account || expired || status === "killed" || status === "expired" || status === "error";
  // A permission signed after the worker's last report is one it has not picked up yet ("checking").
  const pendingGrant = i.permission.grantedAt !== null && beat !== null && i.permission.grantedAt > beat && !expired;
  const liveIntended = s ? s.liveTradingEnabled : row?.mode === "live";
  const blocker = row?.live_blocker ?? null;

  const rows = i.trades.rows;
  const fills = countFills(rows);
  const refusals = tallyRefusals(rows);
  const family = (f: RuleFamily | RuleFamily[]) => {
    const fs = Array.isArray(f) ? f : [f];
    return refusals.filter((b) => fs.includes(b.family));
  };
  const countOf = (bs: RefusalBucket[]) => bs.reduce((x, b) => x + b.count, 0);
  const anyFill = fills.live_landed + fills.paper > 0;

  const checks: Check[] = [];
  const add = (c: Omit<Check, "evidence" | "remedy" | "threshold" | "since" | "recorded_at"> & Partial<Pick<Check, "evidence" | "remedy" | "threshold" | "since" | "recorded_at">>) =>
    checks.push({ threshold: null, since: null, recorded_at: null, evidence: [], remedy: [], ...c });

  // ── permission ──
  {
    const observed = { signed: !!i.account, expires_at: i.permission.expiresAt === null ? null : iso(i.permission.expiresAt), agent_status: status, expired };
    const threshold = { expires_after: iso(i.now) };
    const resign = "Re-sign your trading permission at /grant — it is free and nothing moves on-chain.";
    if (!i.account) {
      add({ category: "permission", status: "blocking", kind: "not_permitted", summary: "No trading permission has been signed yet, so the agent cannot run.", observed, threshold, remedy: ["Sign a trading permission for your agent at /grant."] });
    } else if (pendingGrant && (status === "killed" || status === "expired" || status === "error")) {
      add({ category: "permission", status: "warning", kind: "permission_pending", summary: `A new permission was signed at ${iso(i.permission.grantedAt)}, after the worker's last report; it is picked up on the worker's next tick.`, observed, threshold, recorded_at: i.permission.grantedAt, since: i.permission.grantedAt });
    } else if (status === "killed") {
      add({ category: "permission", status: "blocking", kind: "not_permitted", summary: "The kill switch was used: the stored trading key was removed, so the agent cannot sign anything. Funds stay in your smart account.", observed, threshold, recorded_at: i.killAt ?? beat, since: i.killAt, remedy: ["Sign a new trading permission at /grant to start the agent again."] });
    } else if (expired || status === "expired") {
      const at = expired ? i.permission.expiresAt : (i.expiryNoticeAt ?? row?.expires_at ?? null);
      add({ category: "permission", status: "blocking", kind: "not_permitted", summary: `The signed trading permission expired at ${iso(at)}, so the agent cannot trade.`, observed, threshold, recorded_at: at, since: at, remedy: [resign] });
    } else if (status === "error") {
      add({ category: "permission", status: "blocking", kind: "not_permitted", summary: "The worker could not arm the signed permission, so it is not trading. The error text is only in the agent's own log.", observed, threshold, recorded_at: i.events.arm_failure.last_at ?? beat, since: i.events.arm_failure.first_at, remedy: [resign, "If it still cannot start after re-signing, contact Merrymen support."] });
    } else if (i.permission.expiresAt !== null && i.permission.expiresAt - i.now < 3 * 86_400) {
      add({ category: "permission", status: "warning", kind: null, summary: `The permission is valid but expires soon, at ${iso(i.permission.expiresAt)}.`, observed, threshold, recorded_at: i.permission.grantedAt, remedy: [resign] });
    } else {
      add({ category: "permission", status: "ok", kind: null, summary: `Signed${i.permission.expiresAt !== null ? `; valid until ${iso(i.permission.expiresAt)}` : ""}.`, observed, threshold, recorded_at: i.permission.grantedAt });
    }
  }

  // ── worker liveness ──
  {
    const observed = { heartbeat_at: beat === null ? null : iso(beat), heartbeat_age_s: beatAge, agent_status: status };
    const threshold = { fresh_within_s: within };
    if (!row) {
      add({ category: "worker_liveness", status: "unknown", kind: null, summary: i.account ? "The worker has never reported for this account." : "No account yet, so there is no worker to report.", observed, threshold });
    } else if (beat === null) {
      add({ category: "worker_liveness", status: "unknown", kind: null, summary: "No heartbeat is on record.", observed, threshold });
    } else if (heartbeatFresh) {
      add({ category: "worker_liveness", status: "ok", kind: null, summary: `Heartbeat ${ago(i.now, beat)} (fresh within ${within}s).`, observed, threshold, recorded_at: beat });
    } else if (notArmed) {
      add({ category: "worker_liveness", status: "unknown", kind: null, summary: `Heartbeat frozen at ${iso(beat)}. That is expected: a worker stops publishing its heartbeat once it is not armed (expired, killed or unable to arm), so this does not mean the worker died.`, observed, threshold, recorded_at: beat });
    } else {
      add({ category: "worker_liveness", status: "blocking", kind: "worker_not_reporting", summary: `No heartbeat for ${beatAge}s (fresh within ${within}s): the worker or the ledger mirror has stopped, and shared records cannot tell which.`, observed, threshold, recorded_at: beat, since: beat, remedy: ["Nothing is needed from you at first: Merrymen's watchdog restarts a worker whose heartbeat goes stale. If it stays stale, contact Merrymen support."] });
    }
  }

  // ── live rail ──
  {
    const view = blockerView(blocker);
    const observed = { mode: row?.mode ?? null, live_blocker: blocker === null ? null : blocker.slice(0, 40), live_trading_intended: liveIntended };
    if (!row) {
      add({ category: "live_rail", status: "unknown", kind: null, summary: "The worker has not reported its live rail.", observed });
    } else if (row.mode === "live" && !blocker) {
      add({ category: "live_rail", status: "ok", kind: null, summary: "Trading for real: every leg of the live rail is available.", observed, recorded_at: beat });
    } else if (blocker === "live-not-enabled") {
      if (liveIntended) {
        add({ category: "live_rail", status: "unknown", kind: null, summary: "Your settings say live trading is on, but the worker last reported it off. It picks the change up on its next tick, unless a setting on the agent's own machine overrides it.", observed, recorded_at: beat });
      } else if (i.railNotice?.wouldBlock) {
        const r = i.railNotice.wouldBlock;
        // Written once per CHANGE of the blocker (index.ts), so a later fix (a
        // funded account) does not refresh it while live stays off: dated.
        add({ category: "live_rail", status: "warning", kind: "live_rail_blocked", summary: `Live trading is off. As of ${iso(i.railNotice.at)}, when you turn it on: ${liveBlockerText(r)}.`, observed: { ...observed, would_block_live: r }, recorded_at: i.railNotice.at, remedy: railRemedy(r) });
      } else if (i.railNotice && (i.railNotice.state === "paper" || i.railNotice.state === "off")) {
        add({ category: "live_rail", status: "ok", kind: null, summary: `Live trading is off by choice; as of ${iso(i.railNotice.at)} nothing else would block it once you turn it on.`, observed, recorded_at: i.railNotice.at });
      } else {
        add({ category: "live_rail", status: "unknown", kind: null, summary: "Live trading is off by choice. Whether the rest of the rail would work once it is on is not in the shared records yet.", observed, recorded_at: beat });
      }
    } else if (blocker === "no-gas" || blocker === "no-cash") {
      add({ category: "live_rail", status: "ok", kind: null, summary: "Every leg of the live rail except funding is available (see funding).", observed, recorded_at: beat });
    } else if (blocker && RAIL_BLOCKERS.has(blocker)) {
      add({ category: "live_rail", status: liveIntended ? "blocking" : "warning", kind: "live_rail_blocked", summary: `${liveIntended ? "Not trading for real" : "Live trading is off; when turned on it would not trade for real"}: ${view?.text ?? blocker}.`, observed, recorded_at: beat, remedy: railRemedy(blocker), evidence: view?.is_fault && !view.owner_can_fix ? ["This is on Merrymen's side to fix, not yours."] : [] });
    } else if (blocker) {
      add({ category: "live_rail", status: liveIntended ? "blocking" : "warning", kind: "live_rail_blocked", summary: `The worker reports a live-rail blocker this server does not recognise (${blocker.slice(0, 40)}).`, observed, recorded_at: beat });
    } else {
      add({ category: "live_rail", status: "unknown", kind: null, summary: `The worker reported no blocker while in mode "${row.mode ?? "unknown"}".`, observed, recorded_at: beat });
    }
  }

  // ── funding (live book only: paper cash is simulated) ──
  {
    const f = i.liveFunding;
    const eth = wei(f?.eth_wei ?? null);
    const sponsored = row?.sponsor_gas === null || row?.sponsor_gas === undefined ? null : row.sponsor_gas === 1;
    const observed = { book: "live", cash_usdg: f?.cash_usdg ?? null, eth_wei: f?.eth_wei ?? null, gas_sponsored: sponsored, valued_at: f ? iso(f.at) : null };
    const threshold = { eth_wei: "> 0 unless gas is sponsored", cash_usdg: "> 0 to buy (sells need no USDG)" };
    const liveRefusals = family("funding");
    const since = liveRefusals.length ? Math.min(...liveRefusals.map((b) => b.first_at)) : null;
    if (blocker === "no-gas" || blocker === "no-cash") {
      add({ category: "funding", status: liveIntended ? "blocking" : "warning", kind: "unfunded", summary: blocker === "no-gas" ? "The account holds no ETH and its gas is not sponsored, so no operation can reach the chain." : "The account holds no USDG to trade with.", observed, threshold, recorded_at: f?.at ?? beat, since, remedy: railRemedy(blocker) });
    } else if (!f) {
      add({ category: "funding", status: "unknown", kind: null, summary: "No live-book valuation is on record, so cash and gas are unknown (not zero).", observed, threshold });
    } else if (eth === 0n && sponsored !== true) {
      const unknownSponsor = sponsored === null;
      // The worker's own verdict is newer than any mark: if it reports every
      // leg available, a zero read here is a warning, not a block.
      const workerSaysLive = row?.mode === "live" && !blocker;
      add({ category: "funding", status: liveIntended && !unknownSponsor && !workerSaysLive ? "blocking" : "warning", kind: "unfunded", summary: `The last live valuation (${iso(f.at)}) read 0 ETH${unknownSponsor ? ", and whether gas is sponsored is not recorded" : " and gas is not sponsored"}: operations cannot pay their fee.`, observed, threshold, recorded_at: f.at, since, remedy: [rejectRuleRemedy("no-gas")!] });
    } else if (f.cash_usdg !== null && f.cash_usdg <= 0) {
      add({ category: "funding", status: "warning", kind: "unfunded", summary: `The last live valuation (${iso(f.at)}) read no USDG: it cannot buy, though it can still sell what it holds.`, observed, threshold, recorded_at: f.at, remedy: [rejectRuleRemedy("no-cash")!] });
    } else if (eth === null || f.cash_usdg === null) {
      add({ category: "funding", status: "unknown", kind: null, summary: "Part of the last live valuation was unreadable, so funding is unknown (not zero).", observed, threshold, recorded_at: f.at });
    } else {
      add({ category: "funding", status: "ok", kind: null, summary: `Funded as of ${iso(f.at)}: ${f.cash_usdg} USDG cash, ${sponsored ? "gas sponsored" : `${eth.toString()} wei of ETH for gas`}.`, observed, threshold, recorded_at: f.at });
    }
  }

  // ── settings / consent ──
  {
    if (!s) {
      add({ category: "settings_consent", status: "unknown", kind: null, summary: "The agent's settings could not be read.", observed: {} });
    } else {
      // THE TRENCHER'S OWN GATES (worker index.ts trenchCandidates, the same
      // reading as the terminal's trencherRow): its candidate feed is empty —
      // it never opens a position — when the asset mode is Stocks only (on
      // either book), and while it trades live unless live trenching
      // (trencherLiveEnabled, off by default) is on. The worker announces the
      // second as a warn event once per arm.
      const trencher = s.strategy === "trencher";
      const trencherStocks = trencher && s.assetMode === "stocks";
      const trencherLiveOff = trencher && s.trencherLiveEnabled !== true;
      const trencherNotice = i.events.consent_notice;
      const observed = {
        live_trading_enabled: s.liveTradingEnabled, paper_trading_enabled: s.paperTradingEnabled, asset_mode: s.assetMode, strategy: s.strategy,
        launch_buying_enabled: s.launchBuying.enabled, scout_enabled: s.scoutEnabled, scout_budget_usdg: s.scoutBudgetUsdg,
        trencher_live_enabled: s.trencherLiveEnabled,
      };
      const evidence: string[] = [];
      if (!s.launchBuying.enabled) evidence.push("Launch buying is off, so it does not buy new launches.");
      if (s.scoutEnabled && s.scoutBudgetUsdg !== null && s.scoutBudgetUsdg <= 0) evidence.push("The scout budget is 0, so coins it discovers are never bought.");
      else if (s.scoutEnabled && s.scoutBudgetUsdg === null) evidence.push("No scout budget is set; the default is 0, so coins it discovers are not bought unless the agent's own machine sets one.");
      if (s.assetMode) evidence.push(`Asset mode: ${s.assetMode}.`);
      if (trencherNotice.count) evidence.push(`The worker reported at ${iso(trencherNotice.last_at)} that the Trencher's candidate feed is empty because of a setting.`);
      const turnOn = "Turn on Live trading in Settings when you want it to trade your real funds.";
      const trencherLiveRemedy = "Turn on “let trencher trade for real” in Settings so it can open real positions.";
      const liveTrenchingState = s.trencherLiveEnabled === false ? "is off" : "is not set, and it is off by default";
      if (!s.liveTradingEnabled && !s.paperTradingEnabled) {
        add({ category: "settings_consent", status: "blocking", kind: "consent_off", summary: "Live trading and paper trading are both off, so the agent does nothing at all: no real orders and no simulated ones.", observed, evidence, remedy: ["Turn on Live trading in Settings to trade real funds, or Paper trading to practise."] });
      } else if (trencherStocks) {
        add({ category: "settings_consent", status: "blocking", kind: "consent_off", summary: "The strategy is Trencher, but the asset mode is Stocks only. Every Trencher candidate is a coin, so its candidate feed is empty and it never opens a position, on paper or live.", observed, evidence, remedy: ["Switch Asset mode to All assets or Crypto only in Settings, or pick a strategy that trades stock tokens."] });
      } else if (s.liveTradingEnabled && trencherLiveOff) {
        add({ category: "settings_consent", status: "blocking", kind: "consent_off", summary: `Live trading is on and the strategy is Trencher, but live trenching (“let trencher trade for real”) ${liveTrenchingState}. While it trades live the worker gives the Trencher no candidates, so it never opens a position.`, observed, evidence, recorded_at: trencherNotice.last_at, since: trencherNotice.first_at, remedy: [trencherLiveRemedy] });
      } else if (s.liveTradingEnabled && trencher && trencherNotice.count) {
        // Settings say on, yet the worker said off inside the window: the change
        // may postdate that notice, or the agent's own machine may override it.
        add({ category: "settings_consent", status: "warning", kind: "consent_off", summary: `Your settings have live trenching on, but at ${iso(trencherNotice.last_at)} the worker reported the Trencher's candidate feed empty because of a setting (live trenching off, or a Stocks-only asset mode). It picks up a change on its next settings reload, unless a setting on the agent's own machine overrides it.`, observed, evidence, recorded_at: trencherNotice.last_at, remedy: [trencherLiveRemedy] });
      } else if (!s.liveTradingEnabled) {
        if (trencherLiveOff) evidence.push(`Live trenching ${liveTrenchingState}: once Live trading is on, the Trencher opens no real position until “let trencher trade for real” is on too.`);
        add({ category: "settings_consent", status: "warning", kind: "paper_by_choice", summary: "Live trading is off, so it places no real orders; it practises on paper.", observed, evidence, remedy: [turnOn] });
      } else {
        add({ category: "settings_consent", status: "ok", kind: null, summary: "Live trading is on.", observed, evidence });
      }
    }
  }

  // ── pause ──
  {
    const caveat = "The pause flag itself is kept on the agent's own machine; shared records hold only the chat command that set it, and a restart of the worker may have cleared it.";
    if (i.pause?.state === "paused" && i.actedAfterPause !== null && i.actedAfterPause > i.pause.at) {
      add({ category: "paused", status: "warning", kind: null, summary: `A Telegram /pause is on record at ${iso(i.pause.at)}, but its strategy decided or it attempted a trade after that (at ${iso(i.actedAfterPause)}), so that pause is no longer in effect.`, observed: { last_command: "pause", at: iso(i.pause.at) }, recorded_at: i.pause.at, evidence: [caveat] });
    } else if (i.pause?.state === "paused") {
      add({ category: "paused", status: "blocking", kind: "paused", summary: `The last pause command on record is a Telegram /pause at ${iso(i.pause.at)}, and its strategy has not decided or traded since. Pausing stops the whole trading cycle, exits included.`, observed: { last_command: "pause", at: iso(i.pause.at) }, recorded_at: i.pause.at, since: i.pause.at, evidence: [caveat], remedy: ["Send /resume to your agent in Telegram."] });
    } else if (i.pause) {
      add({ category: "paused", status: "ok", kind: null, summary: `The last pause command on record is /resume at ${iso(i.pause.at)}.`, observed: { last_command: "resume", at: iso(i.pause.at) }, recorded_at: i.pause.at, evidence: [caveat] });
    } else {
      add({ category: "paused", status: "ok", kind: null, summary: "No /pause is on record. The only way to pause (Telegram /pause) always leaves one.", observed: { last_command: null }, evidence: [caveat] });
    }
  }

  // ── market data ──
  {
    const e = i.events.market_unreadable;
    const v = i.valuation;
    const vAge = v ? Math.max(0, i.now - v.at) : null;
    const observed = { unreadable_ticks_in_window: e.count, last_unreadable_at: e.last_at === null ? null : iso(e.last_at), last_valuation_at: v ? iso(v.at) : null, last_valuation_age_s: vAge, stale_mark_holds: i.decisions.stale_mark_holds };
    const threshold = { last_valuation_within_s: within };
    if (!v) {
      add({ category: "market_data", status: e.count ? "warning" : "unknown", kind: e.count ? "missing_data" : null, summary: `No complete valuation is on record${e.count ? `, and ${e.count} tick(s) in the window could not read the market` : ""}.`, observed, threshold, recorded_at: e.last_at });
    } else if (heartbeatFresh && vAge !== null && vAge > within) {
      add({ category: "market_data", status: "blocking", kind: "missing_data", summary: `The worker is running, but the last complete valuation was at ${iso(v.at)}: its ticks are ending early because the market could not be read or a price was missing, and nothing trades on such a tick.`, observed, threshold, recorded_at: v.at, since: v.at, evidence: e.count ? [`${e.count} tick(s) in the window reported an unreadable market (last at ${iso(e.last_at)}).`] : [] });
    } else if (heartbeatFresh === false) {
      add({ category: "market_data", status: "unknown", kind: null, summary: `Last complete valuation at ${iso(v.at)}. With no fresh heartbeat this says nothing about the market data itself.`, observed, threshold, recorded_at: v.at });
    } else if (e.count) {
      add({ category: "market_data", status: "warning", kind: "missing_data", summary: `${e.count} tick(s) in the window could not read the market (last at ${iso(e.last_at)}); nothing trades on those ticks. It says nothing about prices.`, observed, threshold, recorded_at: e.last_at, since: e.first_at });
    } else if (i.decisions.stale_mark_holds) {
      add({ category: "market_data", status: "warning", kind: "stale_mark_hold", summary: `${i.decisions.stale_mark_holds} hold(s) in the window were made on a stale price mark.`, observed, threshold, recorded_at: v.at });
    } else {
      add({ category: "market_data", status: "ok", kind: null, summary: `Last complete valuation at ${iso(v.at)} (${v.mode ?? "unknown"} book).`, observed, threshold, recorded_at: v.at });
    }
  }

  // ── provider (model / Brain service) ──
  {
    // A failed Brain run writes an event AND a decision row; it is counted once,
    // from the row, which also says whether it was a live or a shadow run. A
    // shadow run's failure stops nothing, so it is reported and never blocks.
    const d0 = i.decisions;
    const failures = i.events.provider_failure.count + d0.brain_unreachable + d0.brain_malformed;
    // Quiet-market reviews are written by the tick whatever the model did, so
    // they are not evidence that a model or Brain run succeeded.
    const made = d0.total - d0.brain_unreachable - d0.brain_malformed - d0.quiet_reviews;
    const observed = {
      failures_in_window: failures, brain_unreachable: d0.brain_unreachable, brain_malformed: d0.brain_malformed,
      model_failure_events: i.events.provider_failure.count, shadow_brain_failures: d0.shadow_failures, decisions_made: made,
    };
    const lasts = [i.events.provider_failure.last_at, d0.brain_failure_last_at].filter((x): x is number => x !== null);
    const firsts = [i.events.provider_failure.first_at, d0.brain_failure_first_at].filter((x): x is number => x !== null);
    const last = lasts.length ? Math.max(...lasts) : null;
    const remedy = ["If the agent uses your own model provider key (Settings), check that it is valid and has credit; otherwise this is on Merrymen's side."];
    const shadowNote = d0.shadow_failures ? [`${d0.shadow_failures} Brain shadow run(s) also failed; shadow runs are only watched, so they stop nothing.`] : [];
    if (!failures) {
      add({ category: "provider", status: "ok", kind: null, summary: "No model or Brain service failure that could stop trading is recorded in the window.", observed, evidence: shadowNote });
    } else if (made <= 0) {
      add({ category: "provider", status: "blocking", kind: "provider_failure", summary: `Every model or Brain run recorded in the window failed (${failures} failure(s)); no decision was made. The error text stays in the agent's own log.`, observed, recorded_at: last, since: firsts.length ? Math.min(...firsts) : null, remedy, evidence: shadowNote });
    } else {
      add({ category: "provider", status: "warning", kind: "provider_failure", summary: `${failures} model or Brain run(s) in the window failed; ${made} decision(s) were still made.`, observed, recorded_at: last, remedy, evidence: shadowNote });
    }
  }

  // ── what the model / strategy chose ──
  const d = i.decisions;
  // A quiet-market review and a view with no action are the same fact: its
  // strategy had nothing to propose.
  const holdKinds: Array<[CauseKind, number]> = [
    ["model_hold", d.model_holds], ["brain_gate_hold", d.gate_forced_holds], ["stale_mark_hold", d.stale_mark_holds],
    ["hold_kind_unrecorded", d.unknown_holds], ["strategy_idle", d.views + d.quiet_reviews], ["brain_refused", d.brain_refused], ["proposal_dropped", d.dropped],
  ];
  const topHold = [...holdKinds].sort((a, b) => b[1] - a[1])[0];
  {
    const observed: Record<string, Scalar> = {
      decisions: d.total, buys: d.buys, sells: d.sells, model_holds: d.model_holds, gate_forced_holds: d.gate_forced_holds, stale_mark_holds: d.stale_mark_holds,
      holds_kind_unrecorded: d.unknown_holds, quiet_market_reviews: d.quiet_reviews, views: d.views, brain_refused: d.brain_refused, proposals_dropped: d.dropped,
      brain_shadow_decisions: d.shadow_decisions,
    };
    const breakdown = `${d.model_holds} model hold(s), ${d.gate_forced_holds} gate-forced hold(s), ${d.stale_mark_holds} stale-mark hold(s), ${d.unknown_holds} hold(s) of unrecorded kind, ${d.views} view(s) with no action, ${d.quiet_reviews} quiet-market review(s), ${d.brain_refused} Brain refusal(s), ${d.dropped} proposal(s) dropped`;
    const viewNote = i.latestView ? [`The newest reason it gave for not acting was written at ${iso(i.latestView.at)} (see latest_view).`] : [];
    const shadowNote = d.shadow_decisions ? [`${d.shadow_decisions} Brain shadow decision(s) are not counted: shadow runs are recorded to be watched and are never sent as orders.`] : [];
    const choseNot = holdKinds.reduce((x, [, v]) => x + v, 0);
    if (d.total === 0) {
      add({ category: "model_holds", status: "unknown", kind: null, summary: "No decisions that could lead to a trade were recorded in the window. A strategy that proposes nothing writes its reason only when the reason changes, so it may be older than the window.", observed, evidence: [...viewNote, ...shadowNote] });
    } else if (d.buys + d.sells === 0 && choseNot > 0) {
      add({ category: "model_holds", status: "warning", kind: topHold[0], summary: `${d.total} decision(s) in the window, none a buy or sell: ${breakdown}.`, observed, recorded_at: d.last_at, since: d.first_at, evidence: [...viewNote, ...shadowNote] });
    } else if (d.buys + d.sells === 0) {
      // Every row was a failed run or another action: not a choice to hold (see provider).
      add({ category: "model_holds", status: "unknown", kind: null, summary: `${d.total} decision row(s) in the window, none a buy, sell, hold or view: failed model or Brain runs (see provider) or other actions (${d.other_actions}).`, observed, recorded_at: d.last_at, evidence: shadowNote });
    } else {
      add({ category: "model_holds", status: "ok", kind: null, summary: `It decided to buy or sell ${d.buys + d.sells} time(s) in the window (${d.buys} buy, ${d.sells} sell).`, observed, recorded_at: d.last_at });
    }
  }

  // ── refusals, quotes, execution ──
  const failureCheck = (category: CheckCategory, fams: RuleFamily[], kind: CauseKind, noun: string) => {
    const bs = family(fams);
    const total = countOf(bs);
    const observed: Record<string, Scalar> = { count_in_window: total };
    for (const b of bs.slice(0, 6)) observed[b.key] = b.count;
    const remedy = [...new Set(bs.map((b) => b.remedy).filter((r): r is string => !!r))].slice(0, 3);
    if (!total) {
      add({ category, status: "ok", kind: null, summary: `No ${noun} in the window.`, observed });
      return;
    }
    const top = bs.slice(0, 3).map((b) => `${b.label ?? b.key} ×${b.count}`).join("; ");
    add({
      category, status: anyFill ? "warning" : "blocking", kind, observed, remedy,
      summary: `${total} ${noun} in the window${i.trades.truncated ? " (at least; the scan was capped)" : ""}: ${top}.`,
      recorded_at: Math.max(...bs.map((b) => b.last_at)), since: Math.min(...bs.map((b) => b.first_at)),
    });
  };
  failureCheck("policy_refusals", ["policy", "preflight"], "policy_refusal", "policy refusal(s)");
  failureCheck("quote_failures", ["quote"], "quote_failure", "quote or route failure(s)");
  failureCheck("execution_failures", ["execution"], "execution_failure", "execution failure(s)");
  if (fills.submitted_unresolved) {
    const exec = checks.find((c) => c.category === "execution_failures")!;
    exec.evidence.push(`${fills.submitted_unresolved} operation(s) in the window are still "submitted" in the shared records; one that settled more than 6 hours after submission is no longer re-checked by the mirror, so it may have settled since.`);
    if (exec.status === "ok") { exec.status = "warning"; exec.summary = `No failures, but ${fills.submitted_unresolved} operation(s) are not yet confirmed.`; }
  }

  // ── data freshness ──
  {
    const m = i.mirrorUpdatedAt;
    const observed = { mirror_updated_at: typeof m === "number" ? iso(m) : null, heartbeat_age_s: beatAge };
    const threshold = { fresh_within_s: within };
    if (heartbeatFresh) {
      add({ category: "data_freshness", status: "ok", kind: null, summary: `Shared records are current: the last heartbeat arrived ${ago(i.now, beat!)}.`, observed, threshold, recorded_at: beat });
    } else if (m === "unavailable" || m === null) {
      add({ category: "data_freshness", status: "unknown", kind: null, summary: "The ledger mirror's own state is not available here, so its freshness is unknown.", observed, threshold });
    } else if (notArmed) {
      add({ category: "data_freshness", status: "ok", kind: null, summary: `The mirror last copied rows at ${iso(m)}; a worker that is not armed writes little, so a quiet mirror is expected.`, observed, threshold, recorded_at: m });
    } else if (i.now - m > within) {
      add({ category: "data_freshness", status: "warning", kind: "stale_records", summary: `Nothing new has reached the shared records since ${iso(m)}. Either the worker or the mirror stopped; shared records cannot tell which.`, observed, threshold, recorded_at: m, since: m });
    } else {
      add({ category: "data_freshness", status: "ok", kind: null, summary: `The mirror copied rows at ${iso(m)}.`, observed, threshold, recorded_at: m });
    }
  }

  const by = new Map(checks.map((c) => [c.category, c]));
  const fromCheck = (c: Check): Diagnosis["primary"] => ({ category: c.category, kind: c.kind ?? "no_activity", summary: c.summary, evidence: c.evidence, since: c.since });

  // ── the one cause ──
  let primary: Diagnosis["primary"] | null = null;
  // 1. Anything that stops every tick, most fundamental first.
  for (const cat of ["permission", "settings_consent", "paused", "worker_liveness", "live_rail", "funding", "market_data"] as const) {
    const c = by.get(cat)!;
    if (c.status === "blocking") { primary = fromCheck(c); break; }
  }
  // A new permission the stopped worker has not picked up yet: until it does,
  // nothing else can move, so that is the answer rather than a softer factor.
  if (!primary && by.get("permission")!.kind === "permission_pending") primary = fromCheck(by.get("permission")!);
  // 2. It traded.
  if (!primary && fills.live_landed > 0) {
    primary = { category: "none", kind: "trading", since: null, evidence: [],
      summary: `It has traded in this window: ${fills.live_landed} live fill(s), ${fills.live_confirmed} confirmed with a transaction hash${fills.paper ? `, plus ${fills.paper} paper fill(s)` : ""}.` };
  }
  if (!primary && fills.paper > 0) {
    const rail = by.get("live_rail")!;
    if (!liveIntended) {
      primary = { category: "settings_consent", kind: "paper_by_choice", since: null, evidence: [],
        summary: `It is trading on paper, as configured: ${fills.paper} simulated fill(s) in the window. Live trading is off, so no real orders are placed.` };
    } else if (rail.status !== "ok") {
      primary = { category: "live_rail", kind: "live_rail_blocked", since: null, evidence: [rail.summary],
        summary: `It filled ${fills.paper} time(s) on paper although live trading is on: the live rail was not available for those fills.` };
    }
    // Live on and the rail now reported available: those paper fills predate the
    // switch or a blocker that has since cleared, so they explain nothing about
    // why there is no live fill. The steps below decide.
  }
  // 3. It tried, and every attempt was turned back: the most frequent kind of
  //    "no" — unless it mostly chose not to try, in which case the holds are the
  //    story and the refusals are a factor beside it.
  const choseNotTo = d.total - d.buys - d.sells - d.brain_unreachable - d.brain_malformed - d.other_actions;
  if (!primary && countOf(refusals) >= choseNotTo) {
    const lanes: Array<[RefusalBucket[], CheckCategory | "unknown", CauseKind]> = [
      [family(["policy", "preflight"]), "policy_refusals", "policy_refusal"],
      [family("quote"), "quote_failures", "quote_failure"],
      [family("execution"), "execution_failures", "execution_failure"],
      [family("live_rail"), "live_rail", "live_rail_blocked"],
      [family("funding"), "funding", "unfunded"],
      [family("consent"), "settings_consent", "consent_off"],
      [family("other"), "unknown", "unrecognised_refusal"],
    ];
    const [laneBuckets, cat, kind] = lanes.sort((a, b) => countOf(b[0]) - countOf(a[0]))[0];
    const count = countOf(laneBuckets);
    if (count > 0) {
      const c = cat === "unknown" ? null : by.get(cat)!;
      const buckets = laneBuckets.slice(0, 3).map((b) => `${b.label ?? b.key}: ${b.count}× (last ${iso(b.last_at)})`);
      primary = c && (c.status === "blocking" || c.status === "warning") && c.kind === kind
        ? { ...fromCheck(c), evidence: [...buckets, ...c.evidence] }
        : { category: cat, kind, since: Math.min(...laneBuckets.map((b) => b.first_at)), evidence: buckets,
          summary: cat === "unknown" ? `Its attempts in the window were refused by a rule this server does not recognise (${count}×), and none filled live.` : `Its attempts in the window were turned back (${count}×), and none filled live.` };
    }
  }
  // 4. Nothing reached the wall: the model's service failed, or it chose not to act.
  if (!primary && by.get("provider")!.status === "blocking") primary = fromCheck(by.get("provider")!);
  if (!primary && d.total > 0) {
    const holds = by.get("model_holds")!;
    const refused = countOf(refusals);
    if (holds.status === "warning") {
      primary = fromCheck(holds);
    } else if (choseNotTo > refused && topHold[1] > 0) {
      primary = { category: "model_holds", kind: topHold[0], since: d.first_at, evidence: [holds.summary],
        summary: `Mostly it chose not to trade: ${choseNotTo} of ${d.total} decision(s) in the window were holds, views or refusals to decide${refused ? `, and the ${refused} attempt(s) it did make were turned back` : ""}.` };
    } else if (fills.submitted_unresolved > 0) {
      primary = { category: "execution_failures", kind: "awaiting_confirmation", since: null, evidence: by.get("execution_failures")!.evidence,
        summary: `${fills.submitted_unresolved} operation(s) were sent and are not yet confirmed in the shared records.` };
    } else if (fills.paper > 0) {
      primary = { category: "model_holds", kind: "no_trade_reached_wall", since: d.first_at, evidence: [by.get("live_rail")!.summary],
        summary: `Its only fills in the window were on paper (${fills.paper}). Live trading is on and the rail now reports available, so those came before the switch or before a blocker cleared; no live fill is on record since.` };
    } else if (d.buys + d.sells > 0) {
      primary = { category: "model_holds", kind: "no_trade_reached_wall", since: d.first_at, evidence: [],
        summary: `It decided to buy or sell ${d.buys + d.sells} time(s), but no trade reached the wall, or its record has not arrived yet.` };
    }
    // Otherwise every row was a failed run or another action: the softer signals decide.
  }
  // 5. Softer signals.
  for (const cat of ["provider", "settings_consent", "market_data", "data_freshness"] as const) {
    if (primary) break;
    const c = by.get(cat)!;
    if (c.status === "warning" && c.kind) primary = fromCheck(c);
  }
  if (!primary) {
    primary = { category: "unknown", kind: "no_activity", since: null, evidence: i.latestView ? [`Its newest stated reason for not acting was written at ${iso(i.latestView.at)} (see latest_view).`] : [],
      summary: fills.paper
        ? `No live fill and no decision that could lead to one is recorded in this window (only ${fills.paper} paper fill(s)), and nothing in the shared records blocks it. If the strategy proposed nothing, the reason is only in the agent's own log.`
        : `No decisions that could lead to a trade, no trades and no failures were recorded in this window${d.shadow_decisions ? ` (only ${d.shadow_decisions} Brain shadow decision(s), which are never sent)` : ""}, and nothing in the shared records blocks it. If the strategy proposed nothing, the reason is only in the agent's own log.` };
  }

  const other_factors = CHECK_ORDER.map((c) => by.get(c)!)
    .filter((c) => (c.status === "blocking" || c.status === "warning") && c.category !== primary!.category)
    .map((c) => ({ category: c.category, status: c.status, kind: c.kind, summary: c.summary }));

  const remedies: string[] = [];
  const primaryCheck = primary.category === "none" || primary.category === "unknown" ? null : by.get(primary.category);
  for (const r of primaryCheck?.remedy ?? []) remedies.push(r);
  for (const st of ["blocking", "warning"] as const) {
    for (const c of CHECK_ORDER.map((x) => by.get(x)!)) if (c.status === st) remedies.push(...c.remedy);
  }

  return {
    primary,
    other_factors,
    checks: CHECK_ORDER.map((c) => by.get(c)!),
    decisions: d,
    refusals,
    events: i.events,
    fills_in_window: fills,
    last_successful_cycle: i.valuation ? { at: i.valuation.at, book: i.valuation.mode === "paper" || i.valuation.mode === "live" ? i.valuation.mode : null } : null,
    last_trade: {
      live: i.lastLive ? { at: i.lastLive.at, tx_hash: txHashOrNull(i.lastLive.tx_hash), confirmed: txHashOrNull(i.lastLive.tx_hash) !== null } : null,
      paper: i.lastPaper,
    },
    latest_view: i.latestView,
    what_owner_can_do: [...new Set(remedies)].slice(0, 8),
    unknown_from_shared_records: [...UNKNOWN_FROM_SHARED],
    truncated: { trades: i.trades.truncated, events: i.events.truncated },
  };
}
