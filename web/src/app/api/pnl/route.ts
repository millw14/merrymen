import { NextResponse } from "next/server";
import { hostedAgentFor } from "@/lib/agent-for";
import { withReadDb } from "@/lib/ledger";
import { pnlCardFromFill, renderPnlCard, type ClosedFillRow } from "@merrymen/pnl-card";

/**
 * The P&L card for one closed trade, as a downloadable PNG.
 *
 * SAME RENDERER AS TELEGRAM. The worker sends this exact image when a position
 * closes; this route exists so the owner can get it again from the site — after
 * the chat has scrolled, or to post it somewhere. Drawing it twice from two
 * layouts is how the picture in the chat and the picture on the site start
 * disagreeing about a number, so both call `renderPnlCard`.
 *
 * SCOPED TO THE CALLER'S OWN AGENT, and that is the whole security story here.
 * `agent_id = ?` is bound from the session's grant, never from the query, so a
 * guessed or enumerated trade id returns 404 rather than a picture of somebody
 * else's position. A signed-out caller gets 404 for the same reason — not 401,
 * because whether a given id exists is itself not theirs to learn.
 *
 * NOT CACHED at the CDN. It is per-tenant by construction, and a shared cache
 * keyed on the URL alone would serve one owner's trade to the next caller.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("trade"));
  if (!Number.isInteger(id) || id <= 0) {
    return new NextResponse("missing or malformed trade id", { status: 400 });
  }

  const agent = await hostedAgentFor(req);
  if (!agent) return new NextResponse("not found", { status: 404 });

  const row = await withReadDb(async (db) => {
    if (!db) return null;
    try {
      const rows = (await db
        .prepare(
          `SELECT target, fill_side, fill_cash_usdg, realized_pnl_usdg, status
           FROM trades WHERE id = ? AND agent_id = ?`,
        )
        .all(id, agent)) as unknown as ClosedFillRow[];
      return rows[0] ?? null;
    } catch {
      // Ledger not created yet, or a schema without the fill columns.
      return null;
    }
  });
  if (!row) return new NextResponse("not found", { status: 404 });

  // A buy, a refusal, or a sale with no cost basis has no card to draw. That is
  // a 409 and not a 500: the trade is real, it simply has no P&L to state.
  const card = pnlCardFromFill(row);
  if (!card) {
    return new NextResponse("that trade did not close a position at a knowable P&L", { status: 409 });
  }

  let png: Buffer;
  try {
    png = await renderPnlCard(card);
  } catch {
    // The image library is optional infrastructure. Say so plainly rather than
    // returning a broken image the browser will render as a torn icon.
    return new NextResponse("the card could not be rendered", { status: 503 });
  }

  const name = `${card.symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "position"}-pnl.png`;
  return new NextResponse(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      // `attachment` is the point of this route — the card is a file the owner
      // keeps, not another image embedded in the page.
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
