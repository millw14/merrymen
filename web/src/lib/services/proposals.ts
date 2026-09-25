/**
 * Proposals: actions an assistant PREPARES and the owner APPROVES in Merrymen.
 *
 * The state machine (one row per proposal, in mcp_proposals):
 *
 *   awaiting_approval ─┬─ owner approves ──► approved ─► submitted ─► executing ─┬─► confirmed      (trade: on-chain receipt + reconciled fill)
 *                      │                              (trade only)               ├─► paper_filled   (practice book; no money moved)
 *                      │                                                          ├─► refused        (the worker's gates or the wall said no)
 *                      │                                                          ├─► failed         (reverted, or never recorded)
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
 * inside the signed per-trade cap and the owner's ceiling, the token still
 * unambiguous and covered, and — for a buy — the price has not moved past the
 * slippage the quote was bound with). A client-supplied "approved" flag means
 * nothing anywhere in this file.
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
import { placeHostedOrder, readHostedOrder, orderTtlMs } from "../order-state";

export type ProposalKind = "trade" | "settings" | "agent_draft" | "post";
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
  settings: Record<string, unknown>;
  risk_level: string | null;
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
  return rest;
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

interface TradeRowLite { status: string; tx_hash: string | null; created_at: number; fill_cash_usdg: number | null; fill_qty_raw: string | null; basis_source: string | null; reject_rule: string | null }

/**
 * Follow a submitted trade through the order queue and the ledger and settle
 * its status. "confirmed" requires BOTH the worker's filled receipt AND the
 * mirrored trade row that says landed with the same transaction hash.
 */
export async function followTrade(mcp: Db, ledger: Db, row: ProposalRow, now: number): Promise<ProposalRow> {
  if (row.kind !== "trade" || !row.order_id || !row.agent_account || !["submitted", "executing", "filled_awaiting_ledger"].includes(row.status)) return row;
  const binding = JSON.parse(row.binding_json) as TradeBinding;
  const order = await readHostedOrder(ledger, row.agent_account, row.order_id, now * 1000);
  if (order.status !== 200) return row; // unreadable: keep the last known state, never guess
  const body = order.body as { state: string; result?: string | null; receipt?: { status: string; txHash: string | null; rejectRule: string | null; usdgActual: number | null } };
  let next: ProposalStatus = row.status;
  let result: Record<string, unknown> | undefined;
  if (body.state === "none") return row;
  if (body.state === "queued") next = "submitted";
  else if (body.state === "running") next = "executing";
  else if (body.state === "expired") { next = "expired"; result = { why: "the agent did not pick the order up before its window closed; nothing was sent" }; }
  else if (body.state === "done") {
    const receipt = body.receipt;
    const line = typeof body.result === "string" ? body.result.slice(0, 300) : null;
    if (receipt?.status === "filled" && receipt.txHash) {
      const landed = await ledger.prepare(`SELECT status, tx_hash, created_at, fill_cash_usdg, fill_qty_raw, basis_source, reject_rule FROM trades
        WHERE lower(agent_id) = ? AND lower(tx_hash) = ? ORDER BY id DESC LIMIT 1`).get(row.agent_account.toLowerCase(), receipt.txHash.toLowerCase()) as TradeRowLite | undefined;
      if (landed?.status === "landed") {
        next = "confirmed";
        result = { tx_hash: receipt.txHash, usdg_actual: receipt.usdgActual, fill_qty_raw: landed.fill_qty_raw, basis_source: landed.basis_source, worker_line: line };
      } else {
        next = "filled_awaiting_ledger";
        result = { tx_hash: receipt.txHash, note: "the agent reported a fill; waiting for the ledger to record the landed trade before calling it confirmed", worker_line: line };
      }
    } else if (receipt?.status === "refused") { next = "refused"; result = { rule: receipt.rejectRule, worker_line: line }; }
    else if (receipt?.status === "failed") { next = "failed"; result = { rule: receipt.rejectRule, tx_hash: receipt.txHash, worker_line: line }; }
    else if (receipt?.status === "expired") { next = "expired"; result = { why: "the order's window closed before it ran; nothing was sent", worker_line: line }; }
    else {
      // No receipt: the worker booked it on paper, or sent it and is still
      // waiting for the chain. Tell the two apart from the ledger row.
      const trade = await ledger.prepare(`SELECT status, tx_hash, created_at, fill_cash_usdg, fill_qty_raw, basis_source, reject_rule FROM trades
        WHERE lower(agent_id) = ? AND created_at >= ? AND (lower(buy_token) = ? OR lower(sell_token) = ?) ORDER BY id DESC LIMIT 1`)
        .get(row.agent_account.toLowerCase(), (row.decided_at ?? row.created_at) - 5, binding.token.toLowerCase(), binding.token.toLowerCase()) as TradeRowLite | undefined;
      if (trade?.status === "paper") { next = "paper_filled"; result = { note: "a simulated fill in the practice book; no money moved", worker_line: line }; }
      else if (trade?.status === "submitted") { next = "executing"; result = { tx_hash: trade.tx_hash, note: "sent to the chain; waiting for the receipt", worker_line: line }; }
      else { next = "failed"; result = { why: "the agent finished the order without a recorded fill", worker_line: line }; }
    }
  }
  if (next !== row.status || result) {
    await setStatus(mcp, row.id, ["submitted", "executing", "filled_awaiting_ledger"], next, now, result ? { result } : {});
    return { ...row, status: next, updated_at: now, result_json: result ? JSON.stringify(result) : row.result_json };
  }
  return row;
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
