/** Paper desk reads. No venue account calls, signing, or execution paths. */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { perpsOffered } from "@/lib/perps-enabled";
import { NO_STORE_HEADERS, perRouteLimiter } from "@/lib/route-guard";
import { selectPerpsAccount, withPerpsReadDb } from "./read-store";
import { readAgentPerpsFrom } from "@/lib/agent-perps";
import { readPerpsActivityData } from "@/lib/perps-activity-data";
import { perpsActivityQuery, type PerpsActivityResponse } from "@/lib/perps-activity";
import { chartQuery, chartResponse, entriesFromFills, readChartFills } from "@/lib/perps-chart-data";
import { readPerpsMarketSpec, readPerpsMarketCandles } from "@/lib/perps-market-data";
import type { PerpsAccountResponse } from "@/lib/perps-account";
const json = (value: unknown, status = 200, headers = {}) => NextResponse.json(value, { status, headers: { ...NO_STORE_HEADERS, ...headers } });
export function perpsReadGate(req: Request, wallet: string, publicRead = false): Response | null {
  if (wallet !== "perps") return json({ error: "This route requires wallet=perps." }, 400);
  if (!perpsOffered()) return json({ error: "Perps paper trading is not offered.", code: "perps-wallet-not-offered" }, 404);
  if (!publicRead && isHostedMode() && !tenantOf(req)) return json({ error: "Sign in to read your Perps wallet." }, 401);
  return null;
}
const limits = { account: perRouteLimiter(30), activity: perRouteLimiter(12), chart: perRouteLimiter(12), market: perRouteLimiter(60) };
// Anonymous callers share a bounded process-wide public budget. Forwarded IPs
// are not trusted and cannot create unlimited buckets or bypass this budget.
function limited(req: Request, kind: keyof typeof limits): Response | null {
  const result = limits[kind](kind === "market" ? "public" : isHostedMode() ? tenantOf(req) ?? "anonymous" : "local");
  return result.ok ? null : json({ error: "Too many reads; try again shortly." }, 429, { "Retry-After": String(result.retryAfterSec) });
}
export const perpsReadDeps = { select: selectPerpsAccount, db: withPerpsReadDb, spec: readPerpsMarketSpec, candles: readPerpsMarketCandles, now: Date.now };
type Deps = typeof perpsReadDeps;
export async function readPerpsAccountResponse(req: Request, deps: Deps = perpsReadDeps): Promise<Response> {
  if (new URL(req.url).searchParams.size !== 1) return json({ error: "Unexpected account query." }, 400);
  const refusal = limited(req, "account"); if (refusal) return refusal;
  const selected = await deps.select(req);
  const out: PerpsAccountResponse = { ...selected, generatedAtMs: deps.now(), account: selected.account ? { ...selected.account, agentId: selected.account.smartAccount.toLowerCase(), collateral: null } : null,
    report: selected.state === "unread" ? { state: "unreadable" } : { state: "not-said" }, activityCounts: { state: "unread", paper: null, scope: "recorded-fills-all-epochs" } };
  if (out.account) try {
    await deps.db(async db => {
      out.report = await readAgentPerpsFrom(db, out.account!.smartAccount);
      if (out.report.state === "ok" && out.report.report.mode === "live") out.report = { state: "unreadable" };
      if (!db) return;
      try {
        const row = await db.prepare("SELECT COUNT(*) AS n FROM perp_fills WHERE agent_id = ? AND mode = ?").get(out.account!.agentId, "paper") as { n?: unknown } | undefined;
        const n = Number(row?.n);
        if (row?.n !== null && row?.n !== undefined && Number.isSafeInteger(n) && n >= 0) out.activityCounts = { ...out.activityCounts, state: "ready", paper: n };
      } catch { /* Unknown is not zero. */ }
    });
  } catch { out.report = { state: "unreadable" }; }
  return json(out);
}
export async function readPerpsActivityResponse(req: Request, deps: Deps = perpsReadDeps): Promise<Response> {
  const q = perpsActivityQuery(req.url); if (!q) return json({ error: "Invalid paper activity query." }, 400);
  const refusal = limited(req, "activity"); if (refusal) return refusal;
  const selected = await deps.select(req), now = deps.now();
  const out: PerpsActivityResponse = { ...q, owner: selected.owner, account: selected.account, state: selected.state === "not-configured" ? "not-configured" : "unreadable", generatedAtMs: now, items: [], unknownRows: 0, truncated: false };
  if (selected.account) try {
    await deps.db(async db => { if (db) { Object.assign(out, await readPerpsActivityData(db, selected.account!.smartAccount, q, market => deps.spec(market, now), now)); out.state = "ok"; } });
  } catch { out.state = "unreadable"; out.items = []; }
  return json(out);
}
export async function readPerpsChartResponse(req: Request, publicRead = false, deps: Deps = perpsReadDeps): Promise<Response> {
  let url = req.url;
  if (publicRead) {
    const parsed = new URL(url);
    if (parsed.searchParams.has("book")) return json({ error: "Unexpected market query." }, 400);
    parsed.searchParams.set("book", "paper"); url = parsed.toString();
  }
  const q = chartQuery(url); if (!q) return json({ error: "Invalid paper chart query." }, 400);
  const refusal = limited(req, publicRead ? "market" : "chart"); if (refusal) return refusal;
  const now = deps.now();
  const selected = publicRead ? { state: "not-configured" as const, owner: null, account: null } : await deps.select(req);
  const out = { ...chartResponse(q, selected.state === "not-configured" ? "not-configured" : "unreadable", now), owner: selected.owner, account: selected.account };
  const spec = await deps.spec(q.market, now).catch(() => null);
  out.candles = await deps.candles(q, now, spec).catch(() => out.candles);
  if (selected.account && spec) try {
    await deps.db(async db => { if (db) { Object.assign(out, entriesFromFills(await readChartFills(db, selected.account!.smartAccount, q, now), q, spec)); out.state = "ok"; } });
  } catch { out.state = "unreadable"; out.entries = []; }
  return json(out);
}
