import type { Db } from "../../../worker/src/db";
import { liveSellCard, type LiveSellRow, type PnlCardData } from "../../../worker/src/pnl-card";
import { distinctTrades } from "./distinct-trades";
import { OP_KEY, readEvidencedSells } from "./profile-trades";
import { readRunEpoch } from "./desk-trades";

export type TradePnlResult =
  | { kind: "card"; card: PnlCardData }
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "ineligible"; reason: string };

/**
 * The same measured, live sell the owner's desk can state a realized P&L for.
 * The rule itself is liveSellCard (worker/src/pnl-card.ts), which an active
 * agent's sale on X asks too, so the two can never print different cards.
 */
export async function readTradePnl(db: Db, account: string, id: number): Promise<TradePnlResult> {
  type Row = LiveSellRow & { kind: string; op_key: string };
  try {
    const epoch = await readRunEpoch(db, account);
    const row = await db.prepare(`
      SELECT t.target, t.fill_side, t.fill_cash_usdg, t.realized_pnl_usdg, t.status, t.kind, t.sell_token,
             COALESCE(t.fill_symbol, d.symbol) AS coin_symbol, d.display_name, ${OP_KEY} AS op_key
        FROM ${distinctTrades(`t.agent_id = ?${epoch === null ? "" : " AND t.epoch = ?"}`)}
        LEFT JOIN decisions d ON d.id = t.decision_id AND LOWER(d.agent_id) = LOWER(t.agent_id)
       WHERE t.id = ?
    `).get(account, ...(epoch === null ? [] : [epoch]), id) as Row | undefined;
    if (!row) return { kind: "missing" };
    return await liveSellCard(row, async () =>
      (await readEvidencedSells(db, account, "landed", [{ op: row.op_key, token: row.sell_token! }])).has(row.op_key));
  } catch {
    return { kind: "unreadable" };
  }
}
