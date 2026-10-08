import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { diskAgent, hostedAgentFor } from "@/lib/agent-for";
import { withReadDb } from "@/lib/ledger";
import { NO_STORE_HEADERS, perRouteLimiter } from "@/lib/perp-custody";
import { perpsActivityQuery, type PerpsActivityResponse } from "@/lib/perps-activity";
import { readPerpsActivityData } from "@/lib/perps-activity-data";
import { readPerpsMarketSpec } from "@/lib/perps-market-data";
export const dynamic = "force-dynamic";
const limit = perRouteLimiter(12);
const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) => NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, ...extra } });
export async function GET(req: Request) {
  const hosted = isHostedMode(), tenant = hosted ? tenantOf(req) : null;
  if (hosted && !tenant) return reply({ error: "not signed in" }, 401);
  const q = perpsActivityQuery(req.url);
  if (!q) return reply({ error: "expected one market and book" }, 400);
  const allowed = limit(tenant ?? "self-hosted");
  if (!allowed.ok) return reply({ error: "activity requested too often" }, 429, { "Retry-After": String(allowed.retryAfterSec) });
  const agent = hosted ? await hostedAgentFor(req) : await diskAgent(), nowMs = Date.now();
  const answer: PerpsActivityResponse = { ...q, state: agent || hosted ? "unreadable" : "not-configured", generatedAtMs: nowMs, items: [], unknownRows: 0, truncated: false };
  if (!agent) return reply(answer);
  try {
    const spec = await readPerpsMarketSpec(q.market, nowMs);
    if (!spec) return reply(answer);
    const data = await withReadDb(db => db ? readPerpsActivityData(db, agent, q, spec, nowMs) : Promise.resolve(null));
    if (data !== null) Object.assign(answer, data, { state: "ok" });
  } catch { /* Unreadable history is never a known empty trading record. */ }
  return reply(answer);
}
