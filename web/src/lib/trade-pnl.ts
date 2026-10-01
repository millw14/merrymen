import type { Db } from "../../../worker/src/db";
import { pnlCardFromFill, type ClosedFillRow, type PnlCardData } from "../../../worker/src/pnl-card";
import { distinctTrades } from "./distinct-trades";
import { OP_KEY, readEvidencedSells } from "./profile-trades";
import { readRunEpoch } from "./desk-trades";

export type TradePnlResult =
  | { kind: "card"; card: PnlCardData }
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "ineligible"; reason: string };

/** The same measured, live sell the owner's desk can state a realized P&L for. */
export async function readTradePnl(db: Db, account: string, id: number): Promise<TradePnlResult> {
  type Row = ClosedFillRow & { kind: string; sell_token: string | null; coin_symbol: string | null; display_name: string | null; op_key: string };
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
    // The house card has no practice watermark, so paper trades must never be
    // presented as a real result. Refusals and pending attempts moved nothing.
    if (row.status !== "landed" || row.fill_side !== "sell" || !["swap", "curve-trade"].includes(row.kind)) {
      return { kind: "ineligible", reason: "P&L images are available for completed live sells only." };
    }
    if (typeof row.fill_cash_usdg !== "number" || !Number.isFinite(row.fill_cash_usdg) || row.fill_cash_usdg < 0 ||
        typeof row.realized_pnl_usdg !== "number" || !Number.isFinite(row.realized_pnl_usdg) || !row.sell_token) {
      return { kind: "ineligible", reason: "That trade has no measured realized P&L to print." };
    }
    const vouched = await readEvidencedSells(db, account, "landed", [{ op: row.op_key, token: row.sell_token }]);
    if (!vouched.has(row.op_key)) return { kind: "ineligible", reason: "The trade's proceeds and cost basis could not both be verified." };

    // Autonomous token IDs and router addresses are not coin names. Match the
    // desk's preference for a human name when the symbol is only an identifier.
    const printable = (value: string | null) => {
      const name = (value ?? "").trim();
      return name && name.length <= 64 && /^[\x20-\x7e]+$/.test(name) && !/^0x/i.test(name) && !/^T[0-9A-F]{11}$/i.test(name) ? name : null;
    };
    const coin = printable(row.coin_symbol) ?? printable(row.display_name);
    if (!coin) return { kind: "ineligible", reason: "The coin's name is unknown, so there is no P&L image to print." };
    const card = pnlCardFromFill({ ...row, target: null }, coin);
    return card ? { kind: "card", card } : { kind: "ineligible", reason: "That trade has no measured realized P&L large enough to print." };
  } catch {
    return { kind: "unreadable" };
  }
}
