/** Owner-scoped ledger reader. No venue account reads and no inferred decimals. */
import { perpMarketByKey, perpMarketById, type PerpMarketSpec } from "@merrymen/core";
import type { Db } from "../../../worker/src/db";
import type { PerpsActivityItem, PerpsActivityQuery, PerpsActivityResponse } from "./perps-activity";
const integer = (x: unknown): bigint | null => typeof x === "string" && x.length <= 100 && /^-?\d+$/.test(x) ? BigInt(x) : null;
function scaled(n: bigint, decimals: number): string {
  const s = n.toString().padStart(decimals + 1, "0");
  return decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}
export async function readPerpsActivityData(db: Db, agentId: string, q: PerpsActivityQuery, precision: PerpMarketSpec | ((market: string) => Promise<PerpMarketSpec | null>), nowMs: number): Promise<Pick<PerpsActivityResponse, "items" | "unknownRows" | "truncated">> {
  const marketId = q.market === "all" ? null : perpMarketByKey(q.market)!.marketId, start = nowMs - 30 * 86400_000;
  if (typeof precision !== "function" && precision.marketId !== marketId) throw new Error("activity precision belongs to another market");
  const args = [agentId.toLowerCase(), q.book, ...(marketId === null ? [] : [marketId])];
  const marketClause = marketId === null ? "" : " AND market_id = ?";
  const fills = await db.prepare(`SELECT market_id, epoch, venue_trade_id, side_role, side, base, price, position_before, realized_micro, fee_micro, attribution, trade_type, venue_ts_ms
    FROM perp_fills WHERE agent_id = ? AND mode = ? ${marketClause} AND venue_ts_ms >= ? AND venue_ts_ms <= ?
    ORDER BY venue_ts_ms DESC, venue_trade_id DESC, side_role DESC LIMIT 101`).all(...args, start, nowMs);
  const funding = await db.prepare(`SELECT market_id, epoch, funding_id, funding_hour, payment_micro FROM perp_funding
    WHERE agent_id = ? AND mode = ? ${marketClause} AND funding_hour >= ? AND funding_hour <= ?
    ORDER BY funding_hour DESC, funding_id DESC LIMIT 101`).all(...args, Math.ceil(start / 1000), Math.floor(nowMs / 1000));
  let unknownRows = 0;
  const items: PerpsActivityItem[] = [];
  const precisions = new Map<number, PerpMarketSpec | null>();
  if (typeof precision === "function") {
    // At most 101 bounded rows and only supported markets. Resolve public
    // precisions concurrently; a slow venue must not multiply request time.
    const ids = new Set((fills as Record<string, unknown>[]).map(row => marketId ?? Number(row.market_id)));
    await Promise.all([...ids].map(async id => {
      const market = perpMarketById(id);
      if (market) precisions.set(id, await precision(market.key).catch(() => null));
    }));
  }
  for (const row of fills as Record<string, unknown>[]) {
    const market = marketId === null ? perpMarketById(Number(row.market_id)) : perpMarketByKey(q.market);
    if (!market) { unknownRows++; continue; }
    if (!precisions.has(market.marketId)) precisions.set(market.marketId, typeof precision === "function" ? await precision(market.key).catch(() => null) : precision);
    const spec = precisions.get(market.marketId);
    if (!spec || spec.marketId !== market.marketId) { unknownRows++; continue; }
    const base = integer(row.base), price = integer(row.price), before = integer(row.position_before), fee = integer(row.fee_micro), realized = integer(row.realized_micro);
    const timeMs = Number(row.venue_ts_ms), epoch = Number(row.epoch);
    if (base === null || base <= 0n || price === null || price <= 0n || fee === null ||
        (row.realized_micro !== null && realized === null) || !Number.isSafeInteger(timeMs) || timeMs < start || timeMs > nowMs ||
        !Number.isSafeInteger(epoch) || epoch < 1 || !["long", "short"].includes(String(row.side)) || !["bid", "ask"].includes(String(row.side_role)) ||
        typeof row.venue_trade_id !== "string" || !row.venue_trade_id || typeof row.attribution !== "string" || typeof row.trade_type !== "string") { unknownRows++; continue; }
    const opposing = before !== null && (row.side_role === "bid" ? before < 0n : before > 0n);
    const magnitude = before === null ? 0n : before < 0n ? -before : before;
    const effect = before === null ? "unknown" : before === 0n ? "open" : !opposing ? "add" : base < magnitude ? "reduce" : base === magnitude ? "close" : "reverse";
    // For opposing executions, side names the position reduced/closed. A
    // reversal also closes that prior side before opening the opposite side;
    // the recorded base remains the complete execution, not its closing leg.
    // Reconciliation may have recorded order direction when cost basis was
    // unavailable, but the signed pre-fill position still proves this side.
    const side = opposing && before !== null ? before > 0n ? "long" : "short" : row.side as "long" | "short";
    items.push({ ...q, market: market.key, id: `${q.market === "all" ? `${market.marketId}:` : ""}fill:${epoch}:${row.venue_trade_id}:${row.side_role}`, kind: "fill", timeMs,
      side, effect, priceExact: scaled(price, spec.priceDecimals), sizeExact: scaled(base, spec.sizeDecimals),
      realizedMicro: realized?.toString() ?? null, feeMicro: fee.toString(), attribution: row.attribution, tradeType: row.trade_type });
  }
  for (const row of funding as Record<string, unknown>[]) {
    const market = marketId === null ? perpMarketById(Number(row.market_id)) : perpMarketByKey(q.market);
    if (!market) { unknownRows++; continue; }
    const payment = integer(row.payment_micro), timeMs = Number(row.funding_hour) * 1000, epoch = Number(row.epoch);
    if (payment === null || !Number.isSafeInteger(timeMs) || timeMs < start || timeMs > nowMs || timeMs % 3600_000 !== 0 ||
        !Number.isSafeInteger(epoch) || epoch < 1 || typeof row.funding_id !== "string" || !row.funding_id) { unknownRows++; continue; }
    items.push({ ...q, market: market.key, id: `${q.market === "all" ? `${market.marketId}:` : ""}funding:${epoch}:${row.funding_id}`, kind: "funding", timeMs, paymentMicro: payment.toString() });
  }
  items.sort((a, b) => b.timeMs - a.timeMs || a.id.localeCompare(b.id));
  return { items: items.slice(0, 100), unknownRows, truncated: fills.length > 100 || funding.length > 100 || items.length > 100 };
}
