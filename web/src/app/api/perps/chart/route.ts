import { readRequestPurpose } from "@/lib/account-purpose";
/**
 * The signed-in owner's own execution markers over Lighter MARK candles.
 * The tenant's grant selects the account. Query parameters select only a
 * frozen market, paper/live book, and bounded window; they cannot select an
 * account. No perp orders, positions, fills or keys enter public routes.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { hostedAgentFor, diskAgent } from "@/lib/agent-for";
import { withReadDb } from "@/lib/ledger";
import { NO_STORE_HEADERS, perRouteLimiter } from "@/lib/perp-custody";
import { chartQuery, chartResponse, entriesFromFills, readChartFills } from "@/lib/perps-chart-data";
import { readPerpsMarketSpec, readPerpsMarketCandles } from "@/lib/perps-market-data";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Six chart reads per signed-in owner per minute. The venue client also has a
// shared public-IP budget, a fleet cooldown, bounded response and 4.5 s timeout.
const limit = perRouteLimiter(6);
function reply(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, ...extra } });
}

export async function GET(req: Request) {
  const hosted = isHostedMode();
  const tenant = hosted ? tenantOf(req) : null;
  if (hosted && !tenant) return reply({ error: "not signed in", code: "not-signed-in" }, 401);
  const purpose = readRequestPurpose(req);
  if (!purpose) return reply({ error: "Invalid account purpose" }, 400);

  const q = chartQuery(req.url);
  if (!q) return reply({ error: "expected one market, book and window", code: "bad-request" }, 400);

  // A grant is the only tenant→agent index. Self-hosted has one disk agent
  // behind the existing localhost perimeter. Neither route uses a request
  // account, even if a caller supplies one under another parameter name.
  const agent = hosted ? await hostedAgentFor(req, purpose) : await diskAgent(purpose);
  const allowed = limit(tenant ?? "self-hosted");
  if (!allowed.ok) return reply({ error: "chart requested too often — try again shortly", code: "rate-limited" }, 429,
    { "Retry-After": String(allowed.retryAfterSec) });
  const nowMs = Date.now();
  const answer = chartResponse(q, agent || hosted ? "unreadable" : "not-configured", nowMs);
  let spec = null;
  try { spec = await readPerpsMarketSpec(q.market, nowMs); } catch { /* public market unavailable */ }
  answer.candles = await readPerpsMarketCandles(q, nowMs, spec);
  if (agent && spec) {
    try {
      const rows = await withReadDb(async db => db ? readChartFills(db, agent, q, nowMs) : null, hosted ? "spot" : purpose);
      if (rows !== null) Object.assign(answer, { state: "ok", ...entriesFromFills(rows, q, spec) });
    } catch { /* Keep public candles while explicitly marking private history unreadable. */ }
  }
  return reply(answer);
}
