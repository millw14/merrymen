/** A point-in-time, bounded news observation for one perps candidate.
 * The orchestrator owns the paid provider key. This child only reads its
 * already-normalized research file, and no URL or provider credential crosses
 * into a Brain request.
 */
import type { ResearchFile } from "../research-files";
import { NEWS_WINDOW_SEC, sanitizeText, selectNews, type NewsItem } from "../research/news";
import { SETTINGS_DEFAULTS } from "../../../packages/core/src/index";

const invisible = /[\p{Cc}\p{Cf}]/u;
const cleanText = (raw: string, max: number): string => sanitizeText(raw, max)
  .replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

export const PERPS_NEWS_FRESH_MS = 2 * 60 * 60 * 1000;
export const PERPS_NEWS_MAX_ITEMS = 8;
export type PerpsNewsStatus = "ok" | "no-articles" | "not-fetched" | "fetch-failed" | "stale";
export interface PerpsNewsItem {
  id: string; source: string; published_at_ms: number;
  headline: string; summary: string | null;
  relevance: number | null; sentiment: number | null;
}
export interface PerpsNewsEvidence {
  status: PerpsNewsStatus;
  /** Timestamp of this symbol's successful provider request, not the fleet's. */
  checked_at_ms: number;
  items: PerpsNewsItem[];
}

const SYMBOLS: Record<string, string> = {
  "BTC-PERP": "CC:BTC", "ETH-PERP": "CC:ETH", "SOL-PERP": "CC:SOL",
};
export function perpsNewsSymbol(market: string): string | null { return SYMBOLS[market] ?? null; }

/** Mirror the child's absent-versus-explicit-empty market setting. */
export function perpsNewsSymbolsForSettings(settings: {
  perpsEnabled?: boolean; perpsDriver?: string; perpsMarkets?: unknown;
} | null): string[] {
  if (!settings?.perpsEnabled || settings.perpsDriver !== "brain") return [];
  const markets = Array.isArray(settings.perpsMarkets) ? settings.perpsMarkets : SETTINGS_DEFAULTS.perpsMarkets;
  return [...new Set(markets.map(market => typeof market === "string" ? perpsNewsSymbol(market) : null)
    .filter((symbol): symbol is string => symbol !== null))];
}

export function perpsNewsAvailable(news: PerpsNewsEvidence, asOfMs: number): boolean {
  return !!news && typeof news === "object" && (news.status === "ok" || news.status === "no-articles") &&
    Number.isSafeInteger(asOfMs) && Number.isSafeInteger(news.checked_at_ms) &&
    news.checked_at_ms > 0 && news.checked_at_ms <= asOfMs &&
    asOfMs - news.checked_at_ms <= PERPS_NEWS_FRESH_MS &&
    Array.isArray(news.items) && news.items.length <= PERPS_NEWS_MAX_ITEMS &&
    (news.status === "ok" ? news.items.length > 0 : news.items.length === 0) &&
    news.items.every(it => !!it && typeof it === "object" && typeof it.id === "string" && it.id.length > 0 && it.id.length <= 64 && !invisible.test(it.id) &&
      typeof it.source === "string" && it.source.length > 0 && it.source.length <= 64 && cleanText(it.source, 64) === it.source &&
      Number.isSafeInteger(it.published_at_ms) && it.published_at_ms > 0 && it.published_at_ms <= asOfMs &&
      it.published_at_ms > asOfMs - NEWS_WINDOW_SEC * 1000 &&
      typeof it.headline === "string" && it.headline.length > 0 && it.headline.length <= 200 && cleanText(it.headline, 200) === it.headline &&
      (it.summary === null || typeof it.summary === "string" && it.summary.length <= 320 && cleanText(it.summary, 320) === it.summary) &&
      (it.relevance === null || typeof it.relevance === "number" && Number.isFinite(it.relevance) && it.relevance >= 0 && it.relevance <= 1) &&
      (it.sentiment === null || typeof it.sentiment === "number" && Number.isFinite(it.sentiment) && it.sentiment >= -1 && it.sentiment <= 1));
}

/** `not-fetched` and `stale` are explicit gaps; neither can approve an entry. */
export function perpsNewsFromResearch(research: ResearchFile | null, market: string, asOfMs: number): PerpsNewsEvidence {
  const unavailable = (status: PerpsNewsStatus, checked_at_ms = 0): PerpsNewsEvidence => ({ status, checked_at_ms, items: [] });
  const symbol = perpsNewsSymbol(market);
  if (!symbol || !research || !Number.isSafeInteger(asOfMs) || asOfMs <= 0) return unavailable("not-fetched");
  const checkedSec = research.news.perpsCheckedAt?.[symbol];
  if (!research.news.asked.includes(symbol) || !Number.isSafeInteger(checkedSec) || !checkedSec || checkedSec <= 0)
    return unavailable("not-fetched");
  const checkedAt = checkedSec * 1000;
  if (!Number.isSafeInteger(checkedAt) || checkedAt > asOfMs ||
      !Number.isSafeInteger(research.at) || research.at < checkedSec || research.at * 1000 > asOfMs ||
      !Number.isSafeInteger(research.news.askedAt?.[symbol]) || research.news.askedAt![symbol]! < checkedSec ||
      !Number.isSafeInteger(research.news.fetchedAt) || research.news.fetchedAt < checkedSec ||
      research.news.fetchedAt > research.at)
    return unavailable("stale", checkedAt);
  if (asOfMs - checkedAt > PERPS_NEWS_FRESH_MS) return unavailable("stale", checkedAt);
  if (research.news.invalidItems) return unavailable("fetch-failed", checkedAt);
  const direct = research.news.perpsDirect?.[symbol];
  if (!direct || typeof direct.hadRows !== "boolean" || !Array.isArray(direct.items))
    return unavailable("fetch-failed", checkedAt);

  const asOfSec = Math.floor(asOfMs / 1000);
  let malformed = false;
  const normalized: NewsItem[] = [];
  for (const raw of [...direct.items, ...research.news.items]) {
    if (!raw.symbols?.includes(symbol)) continue;
    // A malformed matching row must never turn a broken feed into the assertion
    // that the provider returned no relevant articles.
    if (!Number.isSafeInteger(raw.publishedAt) || raw.publishedAt <= 0 ||
        typeof raw.id !== "string" || !raw.id || raw.id.length > 64 ||
        typeof raw.url !== "string" || typeof raw.source !== "string" || typeof raw.headline !== "string" ||
        !(raw.summary === null || typeof raw.summary === "string") ||
        !(raw.relevance === null || typeof raw.relevance === "number" && Number.isFinite(raw.relevance) && raw.relevance >= 0 && raw.relevance <= 1) ||
        !(raw.sentiment === null || typeof raw.sentiment === "number" && Number.isFinite(raw.sentiment) && raw.sentiment >= -1 && raw.sentiment <= 1)) {
      malformed = true; continue;
    }
    const id = cleanText(raw.id, 64), source = cleanText(raw.source, 64), headline = cleanText(raw.headline, 200);
    if (!id || !source || !headline) { malformed = true; continue; }
    if (raw.publishedAt > research.news.fetchedAt) { malformed = true; continue; }
    normalized.push({ ...raw, id, source, headline, summary: raw.summary === null ? null : cleanText(raw.summary, 320) || null });
  }
  if (malformed) return unavailable("fetch-failed", checkedAt);
  const items = selectNews(normalized, { symbol, asOf: asOfSec, limit: PERPS_NEWS_MAX_ITEMS })
    .map(it => ({ id: it.id, source: it.source, published_at_ms: it.publishedAt * 1000,
      headline: it.headline, summary: it.summary, relevance: it.relevance, sentiment: it.sentiment }));
  if (!items.length && direct.hadRows) return unavailable("fetch-failed", checkedAt);
  const evidence: PerpsNewsEvidence = { status: items.length ? "ok" : "no-articles", checked_at_ms: checkedAt, items };
  return perpsNewsAvailable(evidence, asOfMs) ? evidence : unavailable("fetch-failed", checkedAt);
}
