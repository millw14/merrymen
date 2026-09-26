/**
 * "Which trade does the chat PnL card show?" — the lookup half of the panel
 * `pnl` command. Pure: takes latest-first ledger rows, returns the first
 * CARDABLE one (same gates as pnlCardFromFill — a buy, a refusal, an unbacked
 * or dust sell, or an unnameable coin has no card to draw). The route wraps
 * this with tenant scoping; the picture itself still comes from GET /api/pnl.
 */
export interface LatestTradeRow {
  id: number;
  target?: string | null;
  fill_side?: string | null;
  fill_cash_usdg?: number | null;
  realized_pnl_usdg?: number | null;
  status?: string | null;
  coin_symbol?: string | null;
}

export interface LatestCardable {
  tradeId: number;
  symbol: string;
  status: string | null;
  realizedPnlUsdg: number;
}

function nameOf(row: LatestTradeRow): string | null {
  const coin = (row.coin_symbol ?? "").trim();
  if (coin && !/^0x/i.test(coin) && !/^T[0-9A-F]{11}$/.test(coin)) return coin;
  const target = (row.target ?? "").trim();
  if (target && !/^0x/i.test(target)) return target;
  return null;
}

export function findLatestCardable(rows: readonly LatestTradeRow[]): LatestCardable | null {
  for (const row of rows) {
    if (row.fill_side !== "sell") continue;
    if (row.realized_pnl_usdg === null || row.realized_pnl_usdg === undefined) continue;
    if (row.fill_cash_usdg === null || row.fill_cash_usdg === undefined) continue;
    const symbol = nameOf(row);
    if (!symbol) continue;
    const proceeds = Number(row.fill_cash_usdg);
    const realised = Number(row.realized_pnl_usdg);
    if (!Number.isFinite(proceeds) || !Number.isFinite(realised)) continue;
    if (proceeds - realised < 0.01) continue; // dust close — no card, like pnlCardFromFill
    if (!Number.isInteger(row.id) || row.id <= 0) continue;
    return { tradeId: row.id, symbol, status: row.status ?? null, realizedPnlUsdg: realised };
  }
  return null;
}
