/** Read-only sale evidence for X. Raw money stays here and never enters a model prompt. */
import type { Db } from "./db";
import { PUBLISHABLE_SOURCES } from "./thesis-policy";
import { distinctTrades } from "./distinct-trades";
import { OP_KEY, readEvidencedSells } from "./trade-evidence";
import { liveSellCard, type PnlCardData } from "./pnl-card";
import { BUY_FRESH_MS, BUY_STALE_MS, type PlanSell, type SaleOutcome } from "./xpost/planner";

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;

/** A measured gross result. No tolerance turns a small loss into break-even. */
export function grossSaleOutcome(row: { pnl: unknown; cash: unknown }, costEvidenced: boolean): SaleOutcome {
  if (!costEvidenced || row.pnl === null || row.cash === null || row.pnl === undefined || row.cash === undefined) return "unknown";
  const pnl = Number(row.pnl);
  const cash = Number(row.cash);
  if (!Number.isFinite(pnl) || !Number.isFinite(cash) || cash < 0 || cash - pnl <= 0) return "unknown";
  return pnl > 0 ? "profit" : pnl < 0 ? "loss" : "flat";
}

/** The measured gross gain on cost, in percent, under the same evidence rule as the outcome. */
export function grossGainPct(row: { pnl: unknown; cash: unknown }, costEvidenced: boolean): number | null {
  if (grossSaleOutcome(row, costEvidenced) === "unknown") return null;
  const pnl = Number(row.pnl);
  const cost = Number(row.cash) - pnl;
  const pct = (pnl / cost) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/**
 * The receipt-backed live exits of the current grant's account and chain, and
 * which of them have vouched proceeds and cost. One read, for both a sale's
 * post (readSaleResults) and its profit card (readSaleCard), so the two can
 * never be about different trades. Throws on a read failure, except the cost
 * replay's, which only vouches for nothing.
 */
async function readSales(db: Db, agentId: string, chainId: number, nowSec: number): Promise<{ valid: Record<string, unknown>[]; evidenced: Set<string> } | null> {
  if (!ADDRESS.test(agentId) || !Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isFinite(nowSec)) return null;
  const account = await db.prepare("SELECT smart_account, chain_id, epoch FROM agents WHERE LOWER(smart_account) = LOWER(?)").get(agentId) as Record<string, unknown> | undefined;
  if (!account || Number(account.chain_id) !== chainId || !Number.isSafeInteger(Number(account.epoch))) return null;
  const spelling = String(account.smart_account);
  const rows = await db.prepare(`
    SELECT ${OP_KEY} AS op, t.decision_id, t.sell_token AS token, t.tx_hash, t.fill_qty_raw,
           COALESCE(t.fill_symbol, d.symbol) AS symbol, d.display_name AS name,
           t.created_at, t.realized_pnl_usdg AS pnl, t.fill_cash_usdg AS cash,
           t.status, t.fill_side, t.kind
      FROM ${distinctTrades("LOWER(t.agent_id) = LOWER(?) AND t.epoch = ?")}
      JOIN decisions d ON d.id = t.decision_id AND LOWER(d.agent_id) = LOWER(t.agent_id)
     WHERE t.status = 'landed' AND t.basis_source = 'receipt' AND t.fill_side = 'sell'
       AND t.kind IN ('swap', 'curve-trade') AND d.action = 'sell'
       AND d.source IN (${PUBLISHABLE_SOURCES.map(() => "?").join(",")})
       AND t.created_at > ? AND t.created_at <= ?
     ORDER BY t.created_at DESC, t.id DESC LIMIT 50
  `).all(spelling, Number(account.epoch), ...PUBLISHABLE_SOURCES, nowSec - (BUY_STALE_MS + BUY_FRESH_MS) / 1000, nowSec) as Record<string, unknown>[];
  const valid = rows.filter((r) => HASH.test(String(r.op)) && HASH.test(String(r.tx_hash)) && ADDRESS.test(String(r.token)) && /^\d+$/.test(String(r.fill_qty_raw)) && BigInt(String(r.fill_qty_raw)) > 0n && typeof r.decision_id === "string" && r.decision_id.length > 0);
  let evidenced = new Set<string>();
  try {
    evidenced = await readEvidencedSells(db, spelling, "landed", valid.map((r) => ({ op: String(r.op), token: String(r.token).toLowerCase() })));
  } catch {
    // Unread/estimated cost cannot become an emotional performance claim.
  }
  return { valid, evidenced };
}

/**
 * Only the current verified grant's account/chain and receipt-backed live
 * exits. Partial sells say sold, never fully closed. A cost replay failure
 * removes the result claim, not the independently proven sale. The SQL is
 * scoped before operation deduplication and the decision join binds its agent.
 */
export async function readSaleResults(db: Db, agentId: string, chainId: number, nowSec: number): Promise<PlanSell[]> {
  try {
    const read = await readSales(db, agentId, chainId, nowSec);
    if (!read) return [];
    const { valid, evidenced } = read;
    return valid.map((r) => ({
      side: "sell",
      operationKey: String(r.op).toLowerCase(),
      token: String(r.token).toLowerCase(),
      decisionId: String(r.decision_id),
      symbol: typeof r.symbol === "string" ? r.symbol : null,
      name: typeof r.name === "string" ? r.name : null,
      paper: false,
      atSec: Number(r.created_at),
      outcome: grossSaleOutcome({ pnl: r.pnl, cash: r.cash }, evidenced.has(String(r.op))),
      gainPct: grossGainPct({ pnl: r.pnl, cash: r.cash }, evidenced.has(String(r.op))),
    }));
  } catch {
    return [];
  }
}

/** A stored USDG figure as liveSellCard reads it: a finite number, or null. Never 0 for a missing one. */
const figure = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * THE PROFIT CARD of one sale, or null: the sale `operationKey` names, in the
 * same receipt-backed read as its post (readSales), with a measured gross
 * PROFIT on vouched cost (grossSaleOutcome), that passes the one live-sale card
 * rule the owner's desk uses (liveSellCard). Never a loss, a flat or unknown
 * result, a paper trade, another account's or another chain's. Raw figures
 * stay in the card; nothing here reaches a model. Never throws.
 */
export async function readSaleCard(db: Db, agentId: string, chainId: number, operationKey: string, nowSec: number): Promise<PnlCardData | null> {
  if (!HASH.test(operationKey)) return null;
  try {
    const read = await readSales(db, agentId, chainId, nowSec);
    const row = read?.valid.find((r) => String(r.op).toLowerCase() === operationKey.toLowerCase());
    if (!read || !row) return null;
    const vouched = read.evidenced.has(String(row.op));
    if (grossSaleOutcome({ pnl: row.pnl, cash: row.cash }, vouched) !== "profit") return null;
    const r = await liveSellCard({
      status: typeof row.status === "string" ? row.status : null,
      fill_side: typeof row.fill_side === "string" ? row.fill_side : null,
      kind: typeof row.kind === "string" ? row.kind : null,
      sell_token: String(row.token).toLowerCase(),
      fill_cash_usdg: figure(row.cash),
      realized_pnl_usdg: figure(row.pnl),
      coin_symbol: typeof row.symbol === "string" ? row.symbol : null,
      display_name: typeof row.name === "string" ? row.name : null,
    }, async () => vouched);
    return r.kind === "card" && r.card.realisedUsdg > 0n ? r.card : null;
  } catch {
    return null;
  }
}
