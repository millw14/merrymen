import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { hostedAgentFor } from "@/lib/agent-for";
import { tenantOf } from "@/lib/auth";
import { withReadDb } from "@/lib/ledger";
import { OWNER_CHANGED_PNL_LOOKUP, ownerMismatch } from "@/lib/order-owner";
import { findLatestCardableInDb } from "@/lib/pnl-latest";

/**
 * The owner's latest cardable closed trade, as JSON — the lookup half of the
 * chat `pnl` command. The picture itself still comes from GET /api/pnl, so
 * there is exactly one renderer; this route answers only "WHICH trade",
 * never drawing anything.
 *
 * CARDABLE, not merely closed: fill_side sell, realized + cash present, a
 * nameable coin, and at least a cent invested (see findLatestCardable — same
 * gates as pnlCardFromFill, which re-validates before drawing). The sell
 * predicate lives in SQL with keyset pagination, so newer buys/refusals can
 * never truncate a valid close out of the window.
 *
 * FOUR answers, and the panel words each differently:
 * - the trade — `{ tradeId, symbol, status, realizedPnlUsdg }`
 * - `{ none: true }` — the ledger was read to its end and holds nothing
 *   cardable. Only this means "no closed trades".
 * - `{ incomplete: true }` — the page budget ran out with rows unexamined.
 *   The panel says the search stopped, never that the history is empty.
 * - `{ unavailable: true }` (503) — the ledger could not be read at all.
 *   A failure to look is not an empty history either.
 *
 * SCOPED exactly like /api/pnl: agent bound from the session's grant, never
 * the query. Signed-out callers get 404, for the same reason (existence is
 * not theirs to learn). And FOR THE OWNER WHO CONFIRMED, like the orders
 * lookup: the request names `owner`, and a session that is not that owner's
 * (another tab signed a different wallet in) gets 409, never that wallet's
 * trade captioned into this one's thread.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: Request) {
  const agent = await hostedAgentFor(req);
  if (!agent) return new NextResponse("not found", { status: 404 });

  const params = new URL(req.url).searchParams;
  if (isHostedMode() && ownerMismatch(params.get("owner"), tenantOf(req))) {
    return NextResponse.json({ error: OWNER_CHANGED_PNL_LOOKUP }, { status: 409, headers: NO_STORE });
  }

  let unreadable = false;
  const result = await withReadDb(async (db) => {
    if (!db) {
      unreadable = true;
      return null;
    }
    try {
      return await findLatestCardableInDb(db, agent);
    } catch {
      unreadable = true;
      return null;
    }
  });

  if (unreadable || !result) {
    return NextResponse.json({ unavailable: true }, { status: 503, headers: NO_STORE });
  }
  if (result.outcome === "incomplete") {
    return NextResponse.json({ incomplete: true }, { headers: NO_STORE });
  }
  if (result.outcome === "none") {
    return NextResponse.json({ none: true }, { headers: NO_STORE });
  }
  return NextResponse.json(result.trade, { headers: NO_STORE });
}
