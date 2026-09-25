/**
 * Proposals: actions an assistant PREPARES and the owner APPROVES in Merrymen.
 *
 * The state machine (one row per proposal, in mcp_proposals):
 *
 *   awaiting_approval ─┬─ owner approves ──► approved ─► submitted ─► executing ─┬─► confirmed      (trade: on-chain receipt + reconciled fill)
 *                      │                              (trade only)               ├─► paper_filled   (practice book; no money moved)
 *                      │                                                          ├─► refused        (the worker's gates or the wall said no)
 *                      │                                                          ├─► failed         (reverted, or its outcome could not be confirmed in time)
 *                      │                                                          └─► expired        (the agent never picked it up in time)
 *                      │                              (settings/draft/post) ─► applied | failed
 *                      ├─ owner declines ─► rejected
 *                      ├─ assistant or owner cancels ─► cancelled   (also a submitted trade the agent has not picked up)
 *                      └─ time passes ─► expired
 *
 * WHAT BINDS AN APPROVAL. The approval page shows the exact binding and posts
 * back its hash; the server approves only if the stored binding still has
 * that hash, the owner's own session is the proposal's tenant, the proposal is
 * unexpired and still awaiting, and a fresh re-validation passes (the agent is
 * still theirs on the same account, the permission unexpired, the amount
 * inside the signed per-trade cap and the owner's ceiling, the token still in
 * the worker's watch set, unambiguous and covered, and — for a buy — the price has not moved past the
 * slippage the quote was bound with). A client-supplied "approved" flag means
 * nothing anywhere in this file.
 *
 * WHAT APPROVAL DOES NOT BIND. The order the agent receives is side, symbol
 * and USDG size — nothing more (the worker's owner-order path takes no
 * minimum and no book). So the bound minimum and the practice/live mode are
 * checked AT APPROVAL only: the agent takes a fresh price when it executes,
 * with its own slippage limit at that moment, and trades in whatever mode it
 * is in when it picks the order up. Every surface that shows a trade proposal
 * says exactly that, and no more.
 *
 * THE APP THAT ASKED MUST STILL BE ALLOWED TO ASK. A proposal is only as good
 * as the connection that prepared it. Disconnecting an app cancels what it
 * left waiting (cancelAwaitingForConnection), and the approval page and the
 * approval itself re-check that the connection is still active, still holds
 * the scope for this kind and, for a proposal about an agent, still has that
 * agent shared (connectionStanding). One that no longer does is cancelled,
 * never approved. An order the owner already approved is not withdrawn by a
 * disconnect: that decision was the owner's own.
 *
 * WHY EXECUTION CAN'T HAPPEN TWICE. The approval is an atomic
 * awaiting_approval → approved transition; the order id is derived from the
 * proposal id, so even a replayed placement collides on the order queue's
 * primary key instead of queueing a second trade. The worker then applies its
 * own one-order-at-a-time slot, expiry, caps and policy, and the on-chain
 * permission wall applies after that.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../../../../worker/src/db";
import { resolveConfig } from "../../../../worker/src/settings";
import { formatSettingValue, specFor } from "../../../../worker/src/telegram/setting-spec";
import { untrusted } from "../../mcp/tools/shared";
import { scopeFor, type Capability } from "../../mcp/scopes";
import { chatOrderCeiling, placeHostedOrder, readHostedOrder, orderTtlMs } from "../order-state";
import { describeRule } from "./decisions";
import { settingsReader, type SettingsView } from "./settings-view";

export type ProposalKind = "trade" | "settings" | "agent_draft" | "post";

/** The capability a connection needs to prepare, see or keep standing behind each kind of proposal. */
export const KIND_CAPABILITY: Readonly<Record<ProposalKind, Capability>> = {
  trade: "trade.propose",
  settings: "drafts.write",
  agent_draft: "drafts.write",
  post: "social.write",
};

export type ProposalStatus =
  | "awaiting_approval" | "approved" | "submitted" | "executing" | "confirmed" | "paper_filled" | "filled_awaiting_ledger"
  | "refused" | "failed" | "expired" | "cancelled" | "rejected" | "applied";

export const TERMINAL: ReadonlySet<ProposalStatus> = new Set(["confirmed", "paper_filled", "refused", "failed", "expired", "cancelled", "rejected", "applied"]);

export const PROPOSAL_TTL_SEC: Record<ProposalKind, number> = {
  trade: 15 * 60,
  settings: 24 * 3600,
  agent_draft: 24 * 3600,
  post: 24 * 3600,
};
export const MAX_OPEN_PROPOSALS = 20;

export interface TradeBinding {
  v: 1;
  kind: "trade";
  tenant: string;
  agent_slug: string;
  account: string;
  /** The account spelled as the order queue expects it (see OwnedAgent.orderAgentId). */
  order_agent_id: string;
  chain_id: number;
  side: "buy" | "sell";
  token: string;
  symbol: string;
  amount_usdg: number;
  slippage_bps: number;
  book: "live" | "paper" | "unknown";
  quote: { expected_out_raw: string; min_out_raw: string; price_impact_bps: number | null; block: string | null } | null;
  limits: { per_trade_usdg: number | null; chat_ceiling_usdg: number | null; daily_usdg: number | null; permission_expires_at: number | null };
  expires_at: number;
}
export interface SettingsBinding {
  v: 1;
  kind: "settings";
  tenant: string;
  agent_slug: string | null;
  changes: Record<string, unknown>;
  before: Record<string, unknown>;
  expires_at: number;
}
export interface DraftBinding {
  v: 1;
  kind: "agent_draft";
  tenant: string;
  /** Only chat-settable keys (SETTING_SPECS) plus a validated agentName. */
  settings: Record<string, unknown>;
  /** Each drafted key's value when it was drafted (null = not set). Approval refuses when any has changed since. */
  before: Record<string, unknown>;
  risk_level: string | null;
  /** Risk-profile keys a draft may not carry (not chat-settable), named so the owner sees what was left out. */
  left_out: string[];
  /**
   * Random. `before` holds the owner's current settings and the binding's hash
   * is shown to any drafts connection, including one with no agent shared: a
   * one-key draft ("strategy") would otherwise let it brute-force the current
   * value from the hash over a handful of candidates.
   */
  salt: string;
  expires_at: number;
}
export interface PostBinding {
  v: 1;
  kind: "post";
  tenant: string;
  agent_slug: string;
  text: string;
  expires_at: number;
}
export type Binding = TradeBinding | SettingsBinding | DraftBinding | PostBinding;

export interface ProposalRow {
  id: string;
  tenant: string;
  agent_slug: string | null;
  agent_account: string | null;
  connection_id: string | null;
  client_name: string | null;
  kind: ProposalKind;
  status: ProposalStatus;
  version: number;
  binding_json: string;
  binding_hash: string;
  summary_json: string;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  decided_at: number | null;
  order_id: string | null;
  result_json: string | null;
}

export class ProposalError extends Error {
  constructor(public code: "not_found" | "conflict" | "expired" | "invalid_input" | "quota_exceeded" | "upstream_unavailable" | "refused", message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

/** JSON with keys sorted at every level: the same binding always hashes the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function bindingHash(b: Binding): string {
  return createHash("sha256").update(canonical(b)).digest("hex");
}

/** The order-queue id for a trade proposal: deterministic, so a replay collides instead of trading twice. */
export function orderIdFor(proposalId: string): string {
  return createHash("sha256").update(`mcp-proposal|${proposalId}`).digest("hex").slice(0, 32);
}

const SELECT = `SELECT id, tenant, agent_slug, agent_account, connection_id, client_name, kind, status, version, binding_json, binding_hash,
  summary_json, idempotency_key, created_at, updated_at, expires_at, decided_at, order_id, result_json FROM mcp_proposals`;

export async function proposalRow(db: Db, tenant: string, id: string): Promise<ProposalRow | null> {
  if (!/^prp_[0-9a-f]{32}$/.test(id)) return null;
  return (await db.prepare(`${SELECT} WHERE id = ? AND tenant = ?`).get(id, tenant.toLowerCase()) as ProposalRow | undefined) ?? null;
}

export async function listProposalRows(db: Db, tenant: string, o: { status?: ProposalStatus | "open"; limit: number }): Promise<ProposalRow[]> {
  const t = tenant.toLowerCase();
  if (o.status === "open") {
    return await db.prepare(`${SELECT} WHERE tenant = ? AND status IN ('awaiting_approval','approved','submitted','executing','filled_awaiting_ledger') ORDER BY created_at DESC LIMIT ?`).all(t, o.limit) as ProposalRow[];
  }
  if (o.status) return await db.prepare(`${SELECT} WHERE tenant = ? AND status = ? ORDER BY created_at DESC LIMIT ?`).all(t, o.status, o.limit) as ProposalRow[];
  return await db.prepare(`${SELECT} WHERE tenant = ? ORDER BY created_at DESC LIMIT ?`).all(t, o.limit) as ProposalRow[];
}

/** The binding minus fields that legitimately differ between two submissions of the same request. */
function stable(b: Binding): unknown {
  const { expires_at: _e, ...rest } = b as Binding & { quote?: unknown };
  if (rest.kind === "trade") {
    const { quote: _q, ...t } = rest as Omit<TradeBinding, "expires_at">;
    return t;
  }
  if (rest.kind === "agent_draft") {
    // The salt differs every time by design, and `before` is the owner's state
    // rather than the request: a retry of the same draft returns the same
    // proposal (whose own `before` the approval re-checks), and a reply that
    // differed with the owner's settings would tell a caller they had changed.
    const { salt: _s, before: _b, ...d } = rest as Omit<DraftBinding, "expires_at">;
    return d;
  }
  return rest;
}

// ── settings: what is proposed, against what is there now ──────────────────

/** One changed setting as the owner reads it. */
export interface ChangeRow { key: string; label: string; current: string; proposed: string; help: string }

/** A setting (a chat-settable key, or a draft's agentName) in the owner's words. */
export function changeRow(key: string, current: unknown, proposed: unknown): ChangeRow {
  if (key === "agentName") {
    return { key, label: "agent name", current: typeof current === "string" && current ? current : "not set", proposed: String(proposed), help: "what your agent is called" };
  }
  const spec = specFor(key);
  if (!spec) return { key, label: key, current: current === null || current === undefined ? "not set" : String(current), proposed: String(proposed), help: "" };
  return { key, label: spec.label, current: formatSettingValue(spec, current), proposed: formatSettingValue(spec, proposed), help: spec.help };
}

/**
 * The owner's CURRENT value of each key (null = not set), read the way a
 * proposal's `before` was read: the chat-settable projection, plus the name.
 */
export async function currentValues(tenant: `0x${string}`, keys: readonly string[], view?: SettingsView | null): Promise<Record<string, unknown>> {
  const reader = settingsReader();
  const spec = (await reader.specValuesFor?.(tenant)) ?? {};
  let named = view;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === "agentName") {
      if (named === undefined) named = await reader.settingsFor(tenant);
      out[k] = named?.agentName ?? null;
    } else {
      out[k] = spec[k] ?? null;
    }
  }
  return out;
}

/**
 * Keys whose current value is no longer the one the proposal was made
 * against. A proposal says "10% → 8%"; if the owner has since set 5% on the
 * dashboard, approving it would LOOSEN the stop loss while the page read as a
 * tightening. So a difference refuses the approval and asks for a fresh one.
 */
export function changedSince(before: Record<string, unknown>, current: Record<string, unknown>): string[] {
  return Object.keys(before).filter((k) => canonical(before[k] ?? null) !== canonical(current[k] ?? null));
}

// ── the owner-order ceiling ─────────────────────────────────────────────────

/**
 * The most one owner order may spend, resolved exactly as POST /api/orders
 * resolves it (lib/order-ceiling.ts → chatOrderCeiling): the owner's stored
 * value when there is a usable one, else the house's. It used to be read as
 * "no ceiling" when the owner never stored one, so a proposal the worker then
 * refused at its default (25 USDG) was accepted and shown with no ceiling.
 *
 * `hosted: true` because MCP exists only on hosted Merrymen (mcp/config.ts
 * refuses to enable it otherwise), which is the branch the route takes there.
 * Zero is an owner's explicit "no chat ceiling".
 */
export function ownerOrderCeiling(tenant: string, settings: SettingsView | null): Promise<number> {
  return chatOrderCeiling({
    hosted: true,
    tenant,
    fallback: resolveConfig().telegramMaxActionUsdg,
    stored: async () => ({ telegramMaxActionUsdg: settings?.telegram.maxActionUsdg ?? undefined }),
  });
}

export async function createProposal(db: Db, input: {
  tenant: string;
  connectionId: string | null;
  clientName: string | null;
  binding: Binding;
  summary: Record<string, unknown>;
  idempotencyKey: string | null;
  agentSlug: string | null;
  agentAccount: string | null;
  now: number;
}): Promise<{ row: ProposalRow; created: boolean }> {
  const tenant = input.tenant.toLowerCase();
  if (input.idempotencyKey) {
    const existing = await db.prepare(`${SELECT} WHERE tenant = ? AND idempotency_key = ?`).get(tenant, input.idempotencyKey) as ProposalRow | undefined;
    if (existing) {
      const prior = JSON.parse(existing.binding_json) as Binding;
      if (existing.kind !== input.binding.kind || canonical(stable(prior)) !== canonical(stable(input.binding))) {
        throw new ProposalError("conflict", "idempotency_key was already used for a different proposal");
      }
      return { row: existing, created: false };
    }
  }
  const open = await db.prepare("SELECT COUNT(*) AS n FROM mcp_proposals WHERE tenant = ? AND status = 'awaiting_approval' AND expires_at > ?").get(tenant, input.now) as { n: number | string };
  if (Number(open.n) >= MAX_OPEN_PROPOSALS) {
    throw new ProposalError("quota_exceeded", `There are already ${MAX_OPEN_PROPOSALS} proposals waiting for approval. Approve, decline or cancel some first.`);
  }
  const id = `prp_${randomBytes(16).toString("hex")}`;
  const hash = bindingHash(input.binding);
  try {
    await db.prepare(`INSERT INTO mcp_proposals (id, tenant, agent_slug, agent_account, connection_id, client_name, kind, status, version, binding_json, binding_hash,
      summary_json, idempotency_key, created_at, updated_at, expires_at, decided_at, order_id, result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`)
      .run(id, tenant, input.agentSlug, input.agentAccount, input.connectionId, input.clientName, input.binding.kind, JSON.stringify(input.binding), hash,
        JSON.stringify(input.summary), input.idempotencyKey, input.now, input.now, input.binding.expires_at);
  } catch (error) {
    // Two concurrent submissions with one idempotency key: the unique index picked a winner.
    if (input.idempotencyKey && /unique|duplicate|constraint/i.test(error instanceof Error ? error.message : String(error))) {
      const winner = await db.prepare(`${SELECT} WHERE tenant = ? AND idempotency_key = ?`).get(tenant, input.idempotencyKey) as ProposalRow | undefined;
      if (winner) return { row: winner, created: false };
    }
    throw error;
  }
  return { row: (await proposalRow(db, tenant, id))!, created: true };
}

async function setStatus(db: Db, id: string, from: readonly ProposalStatus[], to: ProposalStatus, now: number, extra: { order_id?: string; result?: unknown; decided?: boolean } = {}): Promise<boolean> {
  const placeholders = from.map(() => "?").join(", ");
  const res = await db.prepare(`UPDATE mcp_proposals SET status = ?, updated_at = ?${extra.order_id ? ", order_id = ?" : ""}${extra.result !== undefined ? ", result_json = ?" : ""}${extra.decided ? ", decided_at = ?" : ""}
    WHERE id = ? AND status IN (${placeholders})`)
    .run(...[to, now,
      ...(extra.order_id ? [extra.order_id] : []),
      ...(extra.result !== undefined ? [JSON.stringify(extra.result)] : []),
      ...(extra.decided ? [now] : []),
      id, ...from]);
  return res.changes === 1;
}

/** Lazily move an unapproved, past-deadline proposal to expired. */
export async function expireIfDue(db: Db, row: ProposalRow, now: number): Promise<ProposalRow> {
  if (row.status === "awaiting_approval" && row.expires_at <= now) {
    await setStatus(db, row.id, ["awaiting_approval"], "expired", now, { result: { why: "not approved before it expired" } });
    return { ...row, status: "expired", updated_at: now };
  }
  return row;
}

interface TradeRowLite {
  status: string;
  tx_hash: string | null;
  created_at: number;
  amount_usdg: number | null;
  fill_cash_usdg: number | null;
  fill_qty_raw: string | null;
  basis_source: string | null;
  reject_rule: string | null;
}
const TRADE_COLS = "t.status, t.tx_hash, t.created_at, t.amount_usdg, t.fill_cash_usdg, t.fill_qty_raw, t.basis_source, t.reject_rule";

/**
 * How far a trade row's clock may sit outside its order's claim-to-answer
 * window. The orchestrator stamps the claim and the answer, the agent's
 * process stamps the row, on the same machine; this is skew, not slack.
 */
export const ROW_SKEW_SEC = 10;

/**
 * How long past the order's own deadline (or its answer, if later) the ledger
 * gets to show the trade row of a finished order with no receipt. The row
 * reaches the shared ledger through the orchestrator's mirror, which runs
 * every 15 s or more; ten minutes is dozens of passes. Past it the outcome
 * is called unknown, never "did not happen".
 */
export const EVIDENCE_GRACE_SEC = 10 * 60;

/**
 * How long after an order's window closes before ONE row that fits it is taken
 * as this order's. Every row that could fit was written by the window's end,
 * and the mirror copies them in the order they were written. A Telegram owner
 * order for the same token and side, answered inside this order's window, can
 * reach the ledger a pass before this order's own row does; read then, it
 * would be the only row and would be taken as this one. The orchestrator's
 * loop runs the mirror, then the rest of its pass (builder, news, the command
 * ferry, fleet health), and only then sleeps RECONCILE_MS (15 s), so passes
 * are 15 s PLUS a whole loop apart, not 15 s. Three minutes covers several
 * slow loops and is still well inside EVIDENCE_GRACE_SEC. An ASSUMPTION about
 * loop time, not a guarantee: a loop slower than this can still let the first
 * row through alone.
 */
export const SETTLE_AFTER_SEC = 180;

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * A reject rule in Merrymen's own vocabulary (services/decisions.ts): the slug,
 * its family, our sentence and the owner's remedy. The raw text a rule can
 * carry (a provider error after "couldn't submit", a revert string) is never
 * relayed — describeRule withholds it and so does this.
 */
function ruleFields(raw: string | null | undefined, tradeStatus: string): Record<string, unknown> {
  const v = describeRule(raw, tradeStatus);
  if (!v) return { rule: null };
  return { rule: v.key, rule_family: v.family, rule_label: v.label, rule_remedy: v.remedy, ...(v.detail_withheld ? { rule_detail_withheld: true } : {}) };
}

/**
 * The worker's own sentence, for the one case with no rule to describe
 * instead: a refusal decided inside the agent before anything was built
 * (paused, over its chat ceiling, a symbol it does not watch). Everything
 * from a pre-submission failure on is provider text — the bundler's or the
 * RPC's error, which can carry the endpoint and its key — and is cut; a
 * parenthesised tail survives only as a bare rule slug; no link survives at
 * all. What is left is still the agent's text, not Merrymen's, so it is
 * marked untrusted and bounded.
 */
export function workerSentence(line: string | null | undefined): string | null {
  if (typeof line !== "string") return null;
  let s = line;
  const cut = s.search(/\(?\s*couldn.?t submit/i);
  if (cut >= 0) s = s.slice(0, cut);
  s = s.replace(/\s*\(([^()]*)\)?/g, (_m, inner: string) => (/^[a-z0-9][a-z0-9-]{0,63}$/i.test(inner.trim()) ? ` (${inner.trim()})` : ""));
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "").replace(/\s+/g, " ");
  return untrusted(s, 200);
}

/**
 * THIS order's trade row, or that it cannot be named (yet).
 *
 * An owner order leaves no id of its own on the trade row, so it is named by
 * everything the worker does leave, together:
 *  - the account, and a decision minted for an OWNER order (source 'chat',
 *    submitChatTrade) — a strategy's own trade of the same token is not this
 *    order;
 *  - the leg the order was about: what a buy bought (buy_token), what a sell
 *    sold (sell_token). That alone fixes the side. The decision's action does
 *    not: describeIntent (worker/src/index.ts) calls a curve trade a buy
 *    whenever its output is not USDG, so selling a launchpad coin whose curve
 *    is quoted in WETH is recorded as action 'buy' on a row whose sell_token
 *    is the coin;
 *  - a row written between the claim and the answer. The worker writes its
 *    row (paper, submitted, or the outcome) before it answers, and settles a
 *    submitted row IN PLACE, so the row keeps that created_at when it lands.
 *    An earlier trade of the same token is outside the window.
 * Two rows that fit are two owner orders for one token in one window (a
 * Telegram order beside this one): ambiguous, so neither is taken. And one
 * row is only "one" once the window has settled (SETTLE_AFTER_SEC): before
 * that, the other order's row may simply not have arrived yet.
 */
async function orderTrade(ledger: Db, o: { account: string; side: "buy" | "sell"; token: string; fromSec: number; toSec: number; settleSec: number; now: number }): Promise<{ kind: "none" | "ambiguous" | "unsettled" } | { kind: "one"; row: TradeRowLite }> {
  const leg = o.side === "buy" ? "t.buy_token" : "t.sell_token";
  const rows = await ledger.prepare(`SELECT ${TRADE_COLS} FROM trades t JOIN decisions d ON d.id = t.decision_id
    WHERE lower(t.agent_id) = ? AND lower(d.agent_id) = ? AND d.source = 'chat' AND lower(${leg}) = ?
      AND t.created_at >= ? AND t.created_at <= ?
    ORDER BY t.id ASC LIMIT 2`)
    .all(o.account.toLowerCase(), o.account.toLowerCase(), o.token.toLowerCase(), o.fromSec, o.toSec) as TradeRowLite[];
  if (rows.length > 1) return { kind: "ambiguous" };
  if (!rows.length) return { kind: "none" };
  return o.now >= o.settleSec ? { kind: "one", row: rows[0]! } : { kind: "unsettled" };
}

/** The claim-to-answer window of a finished order, when one row in it can be taken as the order's, and how long its evidence may take. */
async function orderWindow(ledger: Db, row: ProposalRow, expiresAtMs: number | null, now: number): Promise<{ fromSec: number; toSec: number; settleSec: number; deadlineSec: number }> {
  const cmd = await ledger.prepare("SELECT claimed_at, done_at FROM agent_commands WHERE id = ? AND agent_id = ?")
    .get(row.order_id, row.agent_account) as { claimed_at: unknown; done_at: unknown } | undefined;
  const claimedMs = num(cmd?.claimed_at) ?? (row.decided_at ?? row.created_at) * 1000;
  const doneMs = num(cmd?.done_at) ?? now * 1000;
  const toSec = Math.ceil(doneMs / 1000) + ROW_SKEW_SEC;
  return {
    fromSec: Math.floor(claimedMs / 1000) - ROW_SKEW_SEC,
    toSec,
    settleSec: toSec + SETTLE_AFTER_SEC,
    deadlineSec: Math.ceil(Math.max(expiresAtMs ?? doneMs, doneMs) / 1000) + EVIDENCE_GRACE_SEC,
  };
}

/** A trade row by its transaction hash: exact, so it needs no window. */
async function rowByTx(ledger: Db, account: string, txHash: string): Promise<TradeRowLite | null> {
  return (await ledger.prepare(`SELECT ${TRADE_COLS} FROM trades t
    WHERE lower(t.agent_id) = ? AND lower(t.tx_hash) = ? ORDER BY t.id DESC LIMIT 1`).get(account.toLowerCase(), txHash.toLowerCase()) as TradeRowLite | undefined) ?? null;
}

/** The USDG a landed row moved, only when known exactly (the rule order-receipt.ts applies to a receipt). */
function usdgMoved(side: "buy" | "sell", t: TradeRowLite): number | null {
  if (t.basis_source === "receipt" && typeof t.fill_cash_usdg === "number" && t.fill_cash_usdg >= 0) return t.fill_cash_usdg;
  if (side === "buy" && typeof t.amount_usdg === "number" && t.amount_usdg > 0) return t.amount_usdg;
  return null;
}

const WAITING_NOTE = "The agent finished the order; waiting for its trade record to reach the ledger, and for the ledger to settle, before saying what happened. This usually takes a few minutes.";

/**
 * Follow a submitted trade through the order queue and the ledger and settle
 * its status. "confirmed" requires an on-chain receipt AND the ledger's landed
 * row for the same transaction: the worker's filled receipt plus the mirrored
 * row with its hash, or — when the worker answered before the chain did —
 * this order's own row (see orderTrade), settled to landed from the chain's
 * receipt, with its hash.
 *
 * A MISSING ROW IS NOT A FAILED TRADE. The row reaches the shared ledger on
 * the mirror's schedule, later than the answer, and a live row the worker left
 * 'submitted' is settled in place long after. So a finished order with no
 * receipt stays 'executing' until its row says what happened, and only past
 * EVIDENCE_GRACE_SEC is it closed — as an outcome that could not be confirmed.
 *
 * NOR IS THE FIRST ROW TO ARRIVE NECESSARILY THIS ORDER'S. Nothing is read off
 * a row found by the window (orderTrade) until the window has settled, so a
 * second owner order's row shows up as ambiguity rather than being taken.
 *
 * Results are built from the receipt's status and the reject-rule vocabulary;
 * the worker's own line is never relayed raw (see workerSentence).
 */
export async function followTrade(mcp: Db, ledger: Db, row: ProposalRow, now: number): Promise<ProposalRow> {
  if (row.kind !== "trade" || !row.order_id || !row.agent_account || !["submitted", "executing", "filled_awaiting_ledger"].includes(row.status)) return row;
  const binding = JSON.parse(row.binding_json) as TradeBinding;
  const order = await readHostedOrder(ledger, row.agent_account, row.order_id, now * 1000);
  if (order.status !== 200) return row; // unreadable: keep the last known state, never guess
  const body = order.body as { state: string; result?: string | null; expiresAt?: number | null; receipt?: { status: string; txHash: string | null; rejectRule: string | null; usdgActual: number | null; token?: string | null } };
  let next: ProposalStatus = row.status;
  let result: Record<string, unknown> | undefined;
  const mine = async () => {
    const w = await orderWindow(ledger, row, typeof body.expiresAt === "number" ? body.expiresAt : null, now);
    return { w, m: await orderTrade(ledger, { account: row.agent_account!, side: binding.side, token: binding.token, ...w, now }) };
  };
  if (body.state === "none") return row;
  if (body.state === "queued") next = "submitted";
  else if (body.state === "running") next = "executing";
  else if (body.state === "expired") { next = "expired"; result = { why: "the agent did not pick the order up before its window closed; nothing was sent" }; }
  else if (body.state === "done") {
    const receipt = body.receipt;
    const line = typeof body.result === "string" ? body.result : null;
    // A refusal or a failure with no rule slug on its receipt: the rule may
    // still be on this order's own row (free text the slug check dropped), and
    // is described from there — the row with the receipt's hash, or the one
    // row in a settled window. Failing that, the agent's own sentence, cut:
    // it is this order's by construction, where an unsettled row may not be.
    // A receipt with no token was decided before any intent was built (paused,
    // over the chat ceiling, an unwatched symbol) and wrote NO row, so the
    // window is not searched then: a row found there would be another order's.
    const explain = async (slug: string | null, status: string, txHash: string | null): Promise<Record<string, unknown>> => {
      if (slug) return ruleFields(slug, status);
      const own = txHash ? await rowByTx(ledger, row.agent_account!, txHash)
        : receipt?.token ? await mine().then(({ m }) => (m.kind === "one" ? m.row : null))
          : null;
      if (own?.reject_rule) return ruleFields(own.reject_rule, own.status);
      return { rule: null, agent_said_untrusted: workerSentence(line) };
    };
    if (receipt?.status === "filled" && receipt.txHash) {
      const landed = await rowByTx(ledger, row.agent_account, receipt.txHash);
      if (landed?.status === "landed") {
        next = "confirmed";
        result = { tx_hash: receipt.txHash, usdg_actual: receipt.usdgActual, fill_qty_raw: landed.fill_qty_raw, basis_source: landed.basis_source };
      } else {
        next = "filled_awaiting_ledger";
        result = { tx_hash: receipt.txHash, note: "the agent reported a fill; waiting for the ledger to record the landed trade before calling it confirmed" };
      }
    } else if (receipt?.status === "refused") {
      next = "refused";
      result = { why: "the agent's limits, policy or on-chain permission refused it; nothing was sent", ...(await explain(receipt.rejectRule, "rejected", null)) };
    } else if (receipt?.status === "failed") {
      next = "failed";
      result = receipt.txHash
        ? { why: "it reached the chain and reverted; nothing moved but the gas", tx_hash: receipt.txHash, ...(await explain(receipt.rejectRule, "reverted", receipt.txHash)) }
        : { why: "the agent handed the order to execution and no trade was recorded for it", tx_hash: null, ...(await explain(receipt.rejectRule, "rejected", null)) };
    } else if (receipt?.status === "expired") {
      next = "expired";
      result = { why: "the order's window closed before it ran; nothing was sent" };
    } else {
      // No receipt: the worker booked it on paper, or sent it and answered
      // before the chain did (or it is a worker that writes no receipts).
      // Only this order's own row says which — and until it is in the shared
      // ledger, nothing is concluded.
      const { w, m } = await mine();
      const t = m.kind === "one" ? m.row : null;
      if (t?.status === "paper") {
        next = "paper_filled";
        result = { note: "a simulated fill in the practice book; no money moved", ...(t.reject_rule ? { simulated_because: ruleFields(t.reject_rule, "paper") } : {}) };
      } else if (t?.status === "submitted") {
        next = "executing";
        result = { tx_hash: t.tx_hash, note: "sent to the chain; waiting for the ledger to record whether it landed" };
      } else if (t?.status === "landed" && t.tx_hash) {
        next = "confirmed";
        result = { tx_hash: t.tx_hash, usdg_actual: usdgMoved(binding.side, t), fill_qty_raw: t.fill_qty_raw, basis_source: t.basis_source };
      } else if (t?.status === "reverted") {
        next = "failed";
        result = { why: "it reached the chain and reverted; nothing moved but the gas", tx_hash: t.tx_hash, ...ruleFields(t.reject_rule, "reverted") };
      } else if (t?.status === "rejected") {
        next = "refused";
        result = { why: "the agent's limits, policy or on-chain permission refused it; nothing was sent", ...ruleFields(t.reject_rule, "rejected") };
      } else if (now > w.deadlineSec) {
        next = "failed";
        result = {
          why: "the agent finished the order, but no trade record that is clearly this order's reached the ledger in time, so its outcome could not be confirmed. Check the agent's trades before proposing it again.",
          outcome_unknown: true,
        };
      } else {
        next = "executing";
        result = { note: WAITING_NOTE };
      }
    }
  }
  const json = result ? JSON.stringify(result) : null;
  if (next !== row.status || (json !== null && json !== row.result_json)) {
    if (!(await setStatus(mcp, row.id, ["submitted", "executing", "filled_awaiting_ledger"], next, now, result ? { result } : {}))) {
      // Moved on under us (a cancel, or another reader settling it): report what is stored.
      return (await proposalRow(mcp, row.tenant, row.id)) ?? row;
    }
    return { ...row, status: next, updated_at: now, result_json: json ?? row.result_json };
  }
  return row;
}

/** A stored result, minus anything a result must no longer carry (a raw worker line from before workerSentence). */
export function resultView(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  const { worker_line: _w, ...rest } = JSON.parse(json) as Record<string, unknown>;
  return rest;
}

// ── the app that asked ──────────────────────────────────────────────────────

/** Why a proposal is cancelled when its app is disconnected (stored as result.why). */
export const DISCONNECTED_WHY = "the app that prepared it was disconnected";

/**
 * Whether the connection that prepared a proposal still stands behind it: it
 * is still active, still holds the scope for this kind, and — for a proposal
 * about an agent — still has that agent shared. A proposal made under a grant
 * the owner has since withdrawn (a disconnect, a narrower re-consent, an agent
 * no longer shared) must not be approvable: the owner withdrew the app's
 * standing to ask for it. A proposal with no recorded connection cannot be
 * traced to an app at all, and fails closed.
 */
export async function connectionStanding(mcp: Db, row: Pick<ProposalRow, "tenant" | "connection_id" | "kind" | "agent_slug">): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!row.connection_id) return { ok: false, why: "Merrymen cannot tell which app prepared it" };
  const c = await mcp.prepare("SELECT status, scopes, agent_slugs FROM mcp_connections WHERE id = ? AND tenant = ?")
    .get(row.connection_id, row.tenant.toLowerCase()) as { status: string; scopes: string; agent_slugs: string } | undefined;
  if (!c || c.status !== "active") return { ok: false, why: DISCONNECTED_WHY };
  if (!c.scopes.split(" ").includes(scopeFor(KIND_CAPABILITY[row.kind]))) {
    return { ok: false, why: "the app that prepared it is no longer allowed to ask for this (you changed what it may do)" };
  }
  if (row.agent_slug !== null) {
    let slugs: unknown = [];
    try { slugs = JSON.parse(c.agent_slugs); } catch { slugs = []; }
    if (!Array.isArray(slugs) || !slugs.includes(row.agent_slug)) {
      return { ok: false, why: "the app that prepared it no longer has access to this agent (you stopped sharing it)" };
    }
  }
  return { ok: true };
}

/**
 * A proposal still waiting for the owner whose app no longer stands behind it
 * (connectionStanding) is cancelled, with the reason. Anything past waiting is
 * returned as it is: a decision the owner already made is theirs.
 */
export async function cancelIfUnbacked(mcp: Db, row: ProposalRow, now: number): Promise<ProposalRow> {
  if (row.status !== "awaiting_approval") return row;
  const standing = await connectionStanding(mcp, row);
  if (standing.ok) return row;
  const result = { why: standing.why, requester_withdrawn: true };
  if (await setStatus(mcp, row.id, ["awaiting_approval"], "cancelled", now, { result })) {
    return { ...row, status: "cancelled", updated_at: now, result_json: JSON.stringify(result) };
  }
  return (await proposalRow(mcp, row.tenant, row.id)) ?? row;
}

/**
 * The owner disconnected an app: everything it left waiting for approval is
 * cancelled, so a link to it in the owner's chat history approves nothing.
 * Only 'awaiting_approval' rows — an order the owner already approved is not
 * withdrawn by a disconnect. Returns how many were cancelled.
 */
export async function cancelAwaitingForConnection(mcp: Db, tenant: string, connectionId: string, now: number): Promise<number> {
  const res = await mcp.prepare("UPDATE mcp_proposals SET status = 'cancelled', updated_at = ?, result_json = ? WHERE tenant = ? AND connection_id = ? AND status = 'awaiting_approval'")
    .run(now, JSON.stringify({ why: DISCONNECTED_WHY, requester_withdrawn: true }), tenant.toLowerCase(), connectionId);
  return Number(res.changes ?? 0);
}

// ── what the settings route said ────────────────────────────────────────────

/**
 * An approved settings change or draft, as the settings route answered it.
 * The route saves nothing when any field fails validation (not ok). When it
 * merely IGNORES a key it does not know, it still answers 200 and saves the
 * rest — so a change whose every key was ignored changed nothing and is
 * 'failed', and one with some keys ignored is 'applied' only with `partial`
 * and the keys that were not applied named.
 */
export function settingsOutcome(changes: Record<string, unknown>, res: { ok: boolean; body: { errors?: unknown; ignored?: unknown } }): { status: "applied" | "failed"; result: Record<string, unknown> } {
  const keys = Object.keys(changes);
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  if (!res.ok) {
    return { status: "failed", result: { why: "Merrymen's settings check refused it; nothing was changed.", errors: strings(res.body.errors).slice(0, 5) } };
  }
  const ignored = strings(res.body.ignored).filter((k) => keys.includes(k));
  const applied = keys.filter((k) => !ignored.includes(k));
  if (!applied.length) {
    return { status: "failed", result: { why: "Merrymen's settings route did not accept any of these changes; nothing was changed.", not_applied: ignored } };
  }
  return {
    status: "applied",
    result: { applied, ...(ignored.length ? { partial: true, not_applied: ignored, note: "Merrymen's settings route did not accept these keys; they were not changed." } : {}) },
  };
}

export async function cancelProposal(mcp: Db, ledger: Db | null, tenant: string, id: string, now: number): Promise<ProposalRow> {
  const row = await proposalRow(mcp, tenant, id);
  if (!row) throw new ProposalError("not_found", "No such proposal.");
  if (row.status === "awaiting_approval") {
    if (await setStatus(mcp, id, ["awaiting_approval"], "cancelled", now, { result: { why: "cancelled before approval" } })) return { ...row, status: "cancelled" };
  }
  if (row.kind === "trade" && row.status === "submitted" && row.order_id && row.agent_account && ledger) {
    // Only an order nobody has claimed can be withdrawn. Claiming it here with
    // a final result is atomic against the orchestrator's own claim
    // (`WHERE claimed_at IS NULL`): exactly one of the two wins.
    const nowMs = now * 1000;
    const res = await ledger.prepare(`UPDATE agent_commands SET claimed_at = ?, done_at = ?, result = ?
      WHERE id = ? AND agent_id = ? AND kind = 'trade' AND claimed_at IS NULL AND done_at IS NULL`)
      .run(nowMs, nowMs, "cancelled by the owner before the agent picked it up; nothing was sent", row.order_id, row.agent_account);
    if (res.changes === 1) {
      await setStatus(mcp, id, ["submitted"], "cancelled", now, { result: { why: "withdrawn from the queue before the agent picked it up; nothing was sent" } });
      return { ...row, status: "cancelled" };
    }
    throw new ProposalError("conflict", "Too late to cancel: the agent has already picked this order up.");
  }
  throw new ProposalError("conflict", `A proposal that is ${row.status.replace(/_/g, " ")} cannot be cancelled.`);
}

export async function rejectProposal(mcp: Db, tenant: string, id: string, hash: string, now: number): Promise<ProposalRow> {
  const row = await proposalRow(mcp, tenant, id);
  if (!row) throw new ProposalError("not_found", "No such proposal.");
  if (row.binding_hash !== hash) throw new ProposalError("conflict", "This page is out of date. Reload it.");
  if (!(await setStatus(mcp, id, ["awaiting_approval"], "rejected", now, { decided: true, result: { why: "declined by the owner" } }))) {
    throw new ProposalError("conflict", `It is already ${row.status.replace(/_/g, " ")}.`);
  }
  return { ...row, status: "rejected" };
}

/** Result of re-checking a binding at approval time. */
export type Revalidation = { ok: true; notes: string[] } | { ok: false; why: string };

/**
 * Approve: check the binding, re-validate it now, then transition once and
 * act. `act` performs the effect for this kind (queue the order, apply the
 * settings, publish the post) and returns the terminal or next status.
 */
export async function approveProposal(mcp: Db, tenant: string, id: string, hash: string, now: number, steps: {
  revalidate(binding: Binding, row: ProposalRow): Promise<Revalidation>;
  act(binding: Binding, row: ProposalRow): Promise<{ status: ProposalStatus; order_id?: string; result: Record<string, unknown> } | { retry: string }>;
}): Promise<ProposalRow> {
  const row = await proposalRow(mcp, tenant, id);
  if (!row) throw new ProposalError("not_found", "No such proposal.");
  if (row.binding_hash !== hash) throw new ProposalError("conflict", "This page is out of date. Reload it and review the proposal again.");
  if (row.status !== "awaiting_approval") throw new ProposalError("conflict", `It is already ${row.status.replace(/_/g, " ")}.`);
  if (row.expires_at <= now) {
    await expireIfDue(mcp, row, now);
    throw new ProposalError("expired", "This proposal expired. Ask your assistant for a fresh one.");
  }
  const binding = JSON.parse(row.binding_json) as Binding;
  if (binding.tenant.toLowerCase() !== tenant.toLowerCase()) throw new ProposalError("not_found", "No such proposal.");
  // Before anything else is weighed: the app that asked must still be allowed to ask.
  const standing = await connectionStanding(mcp, row);
  if (!standing.ok) {
    await setStatus(mcp, id, ["awaiting_approval"], "cancelled", now, { result: { why: standing.why, requester_withdrawn: true } });
    throw new ProposalError("refused", `This was cancelled, not approved: ${standing.why}. Nothing was sent.`);
  }
  const check = await steps.revalidate(binding, row);
  if (!check.ok) throw new ProposalError("refused", check.why);
  if (!(await setStatus(mcp, id, ["awaiting_approval"], "approved", now, { decided: true }))) {
    throw new ProposalError("conflict", "It was approved or changed a moment ago. Reload the page.");
  }
  const outcome = await steps.act(binding, row).catch((error: unknown) => ({ retry: error instanceof ProposalError ? error.message : "Something went wrong applying it; nothing was changed. Try again." }));
  if ("retry" in outcome) {
    // Nothing happened: give the owner the approval back rather than a dead end.
    await setStatus(mcp, id, ["approved"], "awaiting_approval", now);
    throw new ProposalError("upstream_unavailable", outcome.retry);
  }
  await setStatus(mcp, id, ["approved"], outcome.status, now, { order_id: outcome.order_id, result: { ...outcome.result, notes: check.notes } });
  return (await proposalRow(mcp, tenant, id))!;
}

/** Queue an approved trade on the existing owner-order path (the same one the dashboard chat uses). */
export async function queueApprovedTrade(ledger: Db | null, binding: TradeBinding, proposalId: string, tickSeconds: number, nowMs: number): Promise<{ status: ProposalStatus; order_id?: string; result: Record<string, unknown> } | { retry: string }> {
  const id = orderIdFor(proposalId);
  const expiresAt = nowMs + orderTtlMs(tickSeconds);
  const placed = await placeHostedOrder(ledger, {
    agent: binding.order_agent_id,
    id,
    args: { side: binding.side, symbol: binding.symbol, usdgAmount: binding.amount_usdg, source: "mcp-proposal", proposal: proposalId },
    expiresAt,
    now: nowMs,
  });
  if (!placed.ok) {
    return { retry: placed.why === "in-flight" ? "Another order for this agent is still waiting. Approve again once it has finished." : "The order queue could not be reached. Try again in a moment." };
  }
  return { status: "submitted", order_id: id, result: { order_expires_at: Math.floor(expiresAt / 1000), duplicate: placed.duplicate === true } };
}
