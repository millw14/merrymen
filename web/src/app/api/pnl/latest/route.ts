import { NextResponse } from "next/server";
import { hostedAgentFor } from "@/lib/agent-for";
import { withReadDb } from "@/lib/ledger";
import { findLatestCardable, type LatestTradeRow } from "@/lib/pnl-latest";

/**
 * The owner's latest cardable closed trade, as JSON — the lookup half of the
 * chat `pnl` command. The picture itself still comes from GET /api/pnl, so
 * there is exactly one renderer and one row query shape; this route answers
 * only "WHICH trade", never drawing anything.
 *
 * CARDABLE, not merely closed: fill_side sell, realized + cash present, and a
 * nameable coin (see findLatestCardable — same gates as pnlCardFromFill, which
 * re-validates before drawing). Walks back at most 20 recent trades so one
 * uncardable close does not hide the cardable one behind it. No closed trades
 * at all (or none cardable) is `{ none: true }`, not an error — the panel says
 * so plainly instead of failing.
 *
 * SCOPED exactly like /api/pnl: agent bound from the session's grant, never
 * the query. Signed-out callers get 404, for the same reason (existence is
 * not theirs to learn).
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Row = LatestTradeRow;

function nameOf(row: Row): string | null {
  const coin = (row.coin_symbol ?? "").trim();
  const named = coin && !/^0x/i.test(coin) && !/^T[0-9A-F]{11}$/.test(coin) ? coin : null;
  return named;
}

export async function GET(req: Request) {
  const agent = await hostedAgentFor(req);
  if (!agent) return new NextResponse("not found", { status: 404 });

  const found = await withReadDb(async (db) => {
    if (!db) return null;
    try {
      const rows = (await db
        .prepare(
          `SELECT t.id, t.target, t.fill_side, t.fill_cash_usdg, t.realized_pnl_usdg, t.status,
                  COALESCE(t.fill_symbol, d.symbol) AS coin_symbol
             FROM trades t LEFT JOIN decisions d ON d.id = t.decision_id AND d.agent_id = t.agent_id
            WHERE t.agent_id = ?
            ORDER BY t.id DESC LIMIT 20`,
        )
        .all(agent)) as unknown as Row[];
      return findLatestCardable(rows);
    } catch {
      return null;
    }
  });

  if (!found) return NextResponse.json({ none: true }, { headers: { "Cache-Control": "private, no-store" } });
  return NextResponse.json(found, { headers: { "Cache-Control": "private, no-store" } });
}
