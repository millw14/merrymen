/** Public mark-price history. This route never opens a ledger or resolves an owner. */
import { NextResponse } from "next/server";
import { chartQuery, chartResponse } from "@/lib/perps-chart-data";
import { readPerpsMarketSpec, readPerpsMarketCandles } from "@/lib/perps-market-data";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.size !== 2 || [...url.searchParams.keys()].some(key => key !== "market" && key !== "window"))
    return NextResponse.json({ error: "expected market and window" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  url.searchParams.set("book", "paper");
  const q = chartQuery(url.href);
  if (!q) return NextResponse.json({ error: "invalid market or window" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const nowMs = Date.now(), answer = chartResponse(q, "not-configured", nowMs);
  let spec = null;
  try { spec = await readPerpsMarketSpec(q.market, nowMs); } catch { /* unavailable public precision */ }
  answer.candles = await readPerpsMarketCandles(q, nowMs, spec);
  return NextResponse.json(answer, { headers: { "Cache-Control": "no-store" } });
}
