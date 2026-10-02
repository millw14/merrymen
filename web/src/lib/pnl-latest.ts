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

/** USDG float (as stored) to base units — same conversion pnl-card.ts uses. */
const USDG_DECIMALS = 6;
const toBase = (n: number): bigint => BigInt(Math.round(n * 10 ** USDG_DECIMALS));

/** One cent, in USDG base units — below this invested prints as 0.00, so no card. */
const DUST_USDG = 10_000n;

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
    // Dust gate in integer base units, mirroring pnlCardFromFill (worker/src/pnl-card.ts):
    // a close with under a cent INVESTED (proceeds − realised) gets no card.
    // Float `< 0.01` can round either side of exactly one cent and disagree with
    // the renderer, which answers 409 while the lookup said cardable.
    if (toBase(proceeds) - toBase(realised) < DUST_USDG) continue;
    if (!Number.isInteger(row.id) || row.id <= 0) continue;
    return { tradeId: row.id, symbol, status: row.status ?? null, realizedPnlUsdg: realised };
  }
  return null;
}

/** Minimal Db surface the lookup needs (worker/src/db.ts Db, minus the writes). */
export interface CardableDb {
  prepare(sql: string): { all(...params: unknown[]): Promise<unknown[]> };
}

const LOOKUP_COLUMNS = `t.id, t.target, t.fill_side, t.fill_cash_usdg, t.realized_pnl_usdg, t.status,
                 COALESCE(t.fill_symbol, d.symbol) AS coin_symbol`;
const LOOKUP_JOIN = `FROM trades t LEFT JOIN decisions d ON d.id = t.decision_id AND d.agent_id = t.agent_id`;

/**
 * The owner's latest cardable closed trade, straight from the ledger.
 *
 * The sell predicate lives in SQL, not in memory: the query only ever sees
 * sells, so a valid close is never truncated away by newer buys/refusals.
 * Keyset pagination (`id < ?`) walks back past uncardable sells (dust,
 * unbacked, unnameable) until a cardable one or exhaustion — bounded by
 * maxPages so a pathological ledger cannot page forever.
 *
 * THREE answers, never two: `found`, `none` (the ledger was read to its end
 * and holds nothing cardable), or `incomplete` (the page budget ran out with
 * rows unexamined). An exhausted search and a capped one are different facts
 * and the chat describes them differently — "no closed trades" for a search
 * that merely stopped looking is the lie this exists to prevent.
 */
export type LatestCardableOutcome =
  | { outcome: "found"; trade: LatestCardable }
  | { outcome: "none" }
  | { outcome: "incomplete" };

export async function findLatestCardableInDb(
  db: CardableDb,
  agent: string,
  pageSize = 50,
  maxPages = 10,
): Promise<LatestCardableOutcome> {
  let cursor: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const rows = (await db
      .prepare(
        `SELECT ${LOOKUP_COLUMNS}
           ${LOOKUP_JOIN}
          WHERE t.agent_id = ? AND t.fill_side = 'sell'` +
          (cursor === null ? `` : ` AND t.id < ?`) +
          `
          ORDER BY t.id DESC LIMIT ?`,
      )
      .all(...(cursor === null ? [agent, pageSize] : [agent, cursor, pageSize]))) as unknown as LatestTradeRow[];
    const found = findLatestCardable(rows);
    if (found) return { outcome: "found", trade: found };
    if (rows.length < pageSize) return { outcome: "none" };
    const last = rows[rows.length - 1]!;
    if (!Number.isInteger(last.id)) return { outcome: "none" };
    cursor = last.id;
  }
  return { outcome: "incomplete" };
}
