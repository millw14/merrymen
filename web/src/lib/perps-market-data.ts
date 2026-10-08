/** Server-only shared cache. Contains public market facts, never account data. */
import { perpMarketByKey, type PerpMarketSpec } from "@merrymen/core";
import { merrymenHome } from "@merrymen/home";
import { createLighterApi } from "../../../worker/src/perps/api";
import { lighterFeedPath, readLighterFeed } from "../../../worker/src/perps/feed-reader";
import type { MarkCandle } from "../../../worker/src/perps/markets";
import { createPublicReadCache } from "./public-perps-chart-cache";
import { CHART_WINDOWS, candlesFromVenue, chartCandleCacheMs, chartResponse, type ChartQuery, type ChartResponse } from "./perps-chart-data";
const specs = createPublicReadCache<PerpMarketSpec>();
const candles = createPublicReadCache<readonly MarkCandle[]>();
export async function readPerpsMarketSpec(marketKey: string, nowMs: number): Promise<PerpMarketSpec | null> {
  const market = perpMarketByKey(marketKey);
  if (!market) return null;
  const home = merrymenHome();
  const feed = readLighterFeed(lighterFeedPath(home), nowMs)?.markets.get(market.marketId);
  if (feed && nowMs >= feed.specObservedAt && nowMs - feed.specObservedAt <= 15 * 60_000) return feed.spec;
  return specs.read(`${home}:${market.marketId}`, nowMs, 60_000, async () => {
    const result = await createLighterApi({ home, budgetKey: "public", timeoutMs: 4_500 }).orderBookDetails(market.marketId);
    return result.ok ? result.value.markets.get(market.marketId)?.spec ?? null : null;
  });
}
export async function readPerpsMarketCandles(q: ChartQuery, nowMs: number, spec: PerpMarketSpec | null): Promise<ChartResponse["candles"]> {
  const blank = chartResponse(q, "unreadable", nowMs).candles;
  if (!spec) return blank;
  const home = merrymenHome(), { durationMs, stepMs, resolution, countBack } = CHART_WINDOWS[q.window];
  try {
    const bars = await candles.read(`${home}:${spec.marketId}:${resolution}:${spec.priceDecimals}:${Math.floor(nowMs / stepMs)}`, nowMs, stepMs, async () => {
      const result = await createLighterApi({ home, budgetKey: "public", timeoutMs: 4_500 }).markPriceCandles({
        marketId: spec.marketId, resolution, priceDecimals: spec.priceDecimals,
        startSec: Math.floor(Math.floor((nowMs - durationMs) / stepMs) * stepMs / 1000), endSec: Math.floor(nowMs / 1000), countBack,
      });
      return result.ok && result.value.resolution === resolution ? result.value.candles : null;
    }, rows => chartCandleCacheMs(rows, stepMs, nowMs));
    return candlesFromVenue(bars, q, spec.priceDecimals, nowMs);
  } catch { return blank; }
}
