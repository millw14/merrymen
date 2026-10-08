/**
 * The signed-in owner's own execution markers over Lighter MARK candles.
 * The tenant's grant selects the account. Query parameters select only a
 * frozen market, paper/live book, and bounded window; they cannot select an
 * account. No perp orders, positions, fills or keys enter public routes.
 */
import { NextResponse } from "next/server";
import { isHostedMode, perpMarketByKey } from "@merrymen/core";
import { merrymenHome } from "@merrymen/home";
import { tenantOf } from "@/lib/auth";
import { hostedAgentFor, diskAgent } from "@/lib/agent-for";
import { withReadDb } from "@/lib/ledger";
import { NO_STORE_HEADERS, perRouteLimiter } from "@/lib/perp-custody";
import { CHART_WINDOWS, chartCandleCacheMs, candlesFromVenue, chartQuery, chartResponse, entriesFromFills, readChartFills } from "@/lib/perps-chart-data";
import { createPublicReadCache } from "@/lib/public-perps-chart-cache";
import { createLighterApi } from "../../../../../../worker/src/perps/api";
import { lighterFeedPath, readLighterFeed } from "../../../../../../worker/src/perps/feed-reader";
import type { PerpMarketSpec } from "@merrymen/core";
import type { MarkCandle } from "../../../../../../worker/src/perps/markets";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Six chart reads per signed-in owner per minute. The venue client also has a
// shared public-IP budget, a fleet cooldown, bounded response and 4.5 s timeout.
const limit = perRouteLimiter(6);
// Shared only across public venue market reads in this server process. A venue
// candle is identical for every owner; an owner's fills never use this cache.
const publicSpecs = createPublicReadCache<PerpMarketSpec>();
const publicCandles = createPublicReadCache<readonly MarkCandle[]>();

function reply(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, ...extra } });
}

export async function GET(req: Request) {
  const hosted = isHostedMode();
  const tenant = hosted ? tenantOf(req) : null;
  if (hosted && !tenant) return reply({ error: "not signed in", code: "not-signed-in" }, 401);

  const q = chartQuery(req.url);
  if (!q) return reply({ error: "expected one market, book and window", code: "bad-request" }, 400);
  const market = perpMarketByKey(q.market)!;

  // A grant is the only tenant→agent index. Self-hosted has one disk agent
  // behind the existing localhost perimeter. Neither route uses a request
  // account, even if a caller supplies one under another parameter name.
  const agent = hosted ? await hostedAgentFor(req) : await diskAgent();
  if (!agent) return reply(chartResponse(q, hosted ? "unreadable" : "not-configured"));

  const allowed = limit(tenant ?? "self-hosted");
  if (!allowed.ok) return reply({ error: "chart requested too often — try again shortly", code: "rate-limited" }, 429,
    { "Retry-After": String(allowed.retryAfterSec) });

  const nowMs = Date.now();
  const initial = chartResponse(q, "unreadable", nowMs);
  let rows: Awaited<ReturnType<typeof readChartFills>> | null = null;
  try {
    rows = await withReadDb(async (db) => db ? await readChartFills(db, agent, q, nowMs) : null);
  } catch {
    // Old/unreadable ledger is unknown history, never a known empty tape.
    return reply(initial);
  }
  if (rows === null) return reply(initial);

  // The fleet feed carries the venue-validated market spec. If it is missing
  // or too old, resolve the precision through the same bounded public Lighter
  // client used by the worker; never guess decimals from the chart or a fill.
  const home = merrymenHome();
  const venue = createLighterApi({ home, budgetKey: "public", timeoutMs: 4_500 });
  const feedMarket = readLighterFeed(lighterFeedPath(home), nowMs)?.markets.get(market.marketId);
  let spec = feedMarket && nowMs - feedMarket.specObservedAt <= 15 * 60_000 ? feedMarket.spec : null;
  if (!spec) {
    spec = await publicSpecs.read(`${home}:${market.marketId}`, nowMs, 60_000, async () => {
      const detail = await venue.orderBookDetails(market.marketId);
      return detail.ok ? detail.value.markets.get(market.marketId)?.spec ?? null : null;
    });
  }
  if (!spec) return reply(initial);

  let fills: ReturnType<typeof entriesFromFills>;
  try {
    fills = entriesFromFills(rows, q, spec);
  } catch {
    return reply(initial);
  }

  const answer = { ...initial, state: "ok" as const, ...fills };
  const { durationMs, stepMs, resolution, countBack } = CHART_WINDOWS[q.window];
  const alignedStartMs = Math.floor((nowMs - durationMs) / stepMs) * stepMs;
  try {
    const bucket = Math.floor(nowMs / stepMs);
    const candles = await publicCandles.read(`${home}:${market.marketId}:${resolution}:${spec.priceDecimals}:${bucket}`,
      nowMs, stepMs, async () => {
        const read = await venue.markPriceCandles({
          marketId: market.marketId,
          resolution,
          startSec: Math.floor(alignedStartMs / 1000),
          endSec: Math.floor(nowMs / 1000),
          countBack,
          priceDecimals: spec.priceDecimals,
        });
        return read.ok && read.value.resolution === resolution ? read.value.candles : null;
    }, (bars) => chartCandleCacheMs(bars, stepMs, nowMs));
    if (candles) {
      answer.candles = candlesFromVenue(candles, q, spec.priceDecimals, nowMs);
    }
  } catch { /* Exact fills still render; the mark history is explicitly unreadable. */ }
  return reply(answer);
}
