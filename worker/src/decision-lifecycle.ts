import type { Db } from "./db";

/** One decision, and everything that happened because of it. */
export interface DecisionLifecycle {
  decision: {
    id: string;
    agent_id: string;
    source: string;
    provenance: string | null;
    action: string | null;
    symbol: string | null;
    size_usdg: number | null;
    reason: string | null;
    dropped_rule: string | null;
    evidence_json: string | null;
    hold_kind: string | null;
    at: number;
  };
  /** Every trade that attached to it, oldest first. Normally one; never assumed. */
  trades: {
    status: string;
    reject_rule: string | null;
    user_op_hash: string | null;
    tx_hash: string | null;
    amount_usdg: number | null;
    fill_side: string | null;
    fill_qty_raw: string | null;
    fill_cash_usdg: number | null;
    fill_price_usd: number | null;
    realized_pnl_usdg: number | null;
    basis_source: string | null;
    created_at: number;
  }[];
  /** What the agent said about it in its own voice, if anything. */
  post: { body: string; created_at: number } | null;
}

/**
 * THE WHOLE LIFE OF ONE DECISION, from its id.
 *
 * decision created -> intent -> submitted -> landed/refused/reverted ->
 * economic fill -> realised result -> what the agent said. A reader hands this
 * one id and gets the entire chain; that is the property the id exists for, and
 * until the id actually survived into execution it was not reconstructable at
 * all — the thesis row and the trade carried different ids.
 *
 * READS, NEVER INFERS. A stage that has not happened is absent rather than
 * zero: no trade row means the intent has not reached the wall (or was dropped
 * before it), `realized_pnl_usdg` null means the result is not known yet, and
 * neither is reported as a number. `trades` is an ARRAY because the schema
 * permits several rows against one decision — a retry writes a second — and a
 * reader that assumed one would quietly show the first and hide the rest.
 *
 * Returns null when the decision does not exist or cannot be read. The caller
 * cannot tell those apart here on purpose: a public surface answers 404 to
 * both, and distinguishing them would leak whether an id exists.
 */
export async function readDecisionLifecycle(db: Db, decisionId: string): Promise<DecisionLifecycle | null> {
  try {
    const d = (await db
      .prepare(
        `SELECT id, agent_id, source, provenance, action, symbol, size_usdg,
                reason, dropped_rule, evidence_json, hold_kind, at
           FROM decisions WHERE id = ? LIMIT 1`,
      )
      .get(decisionId)) as Record<string, unknown> | undefined;
    if (!d) return null;

    const trades = (await db
      .prepare(
        `SELECT status, reject_rule, user_op_hash, tx_hash, amount_usdg,
                fill_side, fill_qty_raw, fill_cash_usdg, fill_price_usd,
                realized_pnl_usdg, basis_source, created_at
           FROM trades WHERE decision_id = ? AND LOWER(agent_id) = LOWER(?) ORDER BY created_at ASC, id ASC`,
      )
      .all(decisionId, d.agent_id)) as Record<string, unknown>[];

    const post = (await db
      .prepare("SELECT body, created_at FROM posts WHERE decision_id = ? AND LOWER(agent_id) = LOWER(?) LIMIT 1")
      .get(decisionId, d.agent_id)) as { body: string; created_at: number } | undefined;

    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

    return {
      decision: {
        id: String(d.id),
        agent_id: String(d.agent_id),
        source: String(d.source),
        provenance: str(d.provenance),
        action: str(d.action),
        symbol: str(d.symbol),
        size_usdg: num(d.size_usdg),
        reason: str(d.reason),
        dropped_rule: str(d.dropped_rule),
        evidence_json: str(d.evidence_json),
        hold_kind: str(d.hold_kind),
        at: Number(d.at),
      },
      trades: trades.map((t) => ({
        status: String(t.status),
        reject_rule: str(t.reject_rule),
        user_op_hash: str(t.user_op_hash),
        tx_hash: str(t.tx_hash),
        amount_usdg: num(t.amount_usdg),
        fill_side: str(t.fill_side),
        fill_qty_raw: str(t.fill_qty_raw),
        fill_cash_usdg: num(t.fill_cash_usdg),
        fill_price_usd: num(t.fill_price_usd),
        realized_pnl_usdg: num(t.realized_pnl_usdg),
        basis_source: str(t.basis_source),
        created_at: Number(t.created_at),
      })),
      post: post ? { body: String(post.body), created_at: Number(post.created_at) } : null,
    };
  } catch {
    return null;
  }
}
