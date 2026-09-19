import type { Db } from "./db";

/** A recorded cash-only opening of this paper period, never the live wallet's deposits. */
export async function paperBrainCapital(db: Db, agentId: string, epoch: number): Promise<number | null> {
  try {
    const first = await db.prepare(`SELECT at, cash_usdg, vault_usdg, positions_usdg, equity_usdg FROM equity
      WHERE agent_id = ? AND epoch = ? AND mode = 'paper'
      AND id > COALESCE((SELECT MAX(id) FROM equity WHERE agent_id = ? AND epoch = ? AND (mode IS NULL OR mode <> 'paper')), 0)
      ORDER BY at, id LIMIT 1`).get(agentId, epoch, agentId, epoch) as { at: number; cash_usdg: number; vault_usdg: number; positions_usdg: number; equity_usdg: number } | undefined;
    if (!first || first.cash_usdg <= 0 || first.vault_usdg !== 0 || first.positions_usdg !== 0 ||
        first.equity_usdg !== first.cash_usdg || !Number.isFinite(first.cash_usdg)) return null;
    const missing = await db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE agent_id = ? AND epoch = ?
      AND status = 'paper' AND kind = 'swap' AND created_at >= ?
      AND (fill_qty_raw IS NULL OR fill_cash_usdg IS NULL OR fill_side IS NULL)`)
      .get(agentId, epoch, first.at) as { n: number };
    return Number(missing.n) === 0 ? Math.round(first.cash_usdg * 1e6) : null;
  } catch { return null; }
}
