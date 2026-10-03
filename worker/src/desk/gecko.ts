/**
 * THE DESK'S TWO EXTRA READS: a name search and an hourly chart.
 *
 * Everything else the desk needs is already read elsewhere (a token's pools,
 * the trending/top/new feeds — venues/geckoterminal.ts). These two are new,
 * and they go through the same fleet quota (`cachedGeckoDetail`: one spacing
 * slot and one cooldown for every tenant on the host) plus a one-minute memo
 * here, so a coin three people ask about in a minute costs one request.
 *
 * NOTHING HERE DECIDES A TRADE. A name resolved by search is a lookup for a
 * group answer; it is never nominated, never written to discovery, and never
 * reaches the trading wall (docs/tg-groups.md rule 1). A coin that trades still
 * gets there only as an address someone posted.
 */
import { readBoundedJson } from "../bounded-read";
import { cachedGeckoDetail, geckoSource, GECKO_NETWORK, parseGeckoPool, type GeckoFetch, type GeckoPool } from "../venues/geckoterminal";
import type { FeedResult } from "../venues/fleet-feed-cache";
import type { Bar } from "./ta";

const MEMO_MS = 60_000;
const FAIL_MEMO_MS = 5_000;
const memo = new Map<string, { until: number; value: unknown }>();
const pending = new Map<string, Promise<unknown>>();

/** One request per key per minute, shared by every caller in this process. */
async function memoized<T extends FeedResult>(key: string, run: () => Promise<T>, unavailable: (why: string) => T): Promise<T> {
  const k = `${geckoSource().id}:${key}`;
  const hit = memo.get(k);
  if (hit && hit.until > Date.now()) return hit.value as T;
  const inFlight = pending.get(k);
  if (inFlight) return inFlight as Promise<T>;
  const job = cachedGeckoDetail(`desk:${key}`, run, unavailable)
    .catch(() => unavailable("unavailable"))
    .then((value) => {
      if (memo.size >= 256) memo.delete(memo.keys().next().value!);
      memo.set(k, { until: value.failed ? Date.now() + FAIL_MEMO_MS : (value.observedAt ?? Date.now()) + MEMO_MS, value });
      return value;
    })
    .finally(() => pending.delete(k));
  pending.set(k, job);
  return job;
}

/** Test seam: forget every memoised read. */
export function resetDeskReadsForTest(): void {
  memo.clear();
  pending.clear();
}

async function getJson(route: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: true; body: unknown; observedAt: number } | { ok: false; failure: string; retryAfterMs?: number }> {
  const source = geckoSource();
  const observedAt = Date.now();
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${source.base}${route}`, { headers: source.headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) {
      const retry = res.headers.get("retry-after");
      const ms = retry === null ? 0 : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      await res.body?.cancel().catch(() => {});
      return { ok: false, failure: `http-${res.status}`, retryAfterMs: Number.isFinite(ms) ? Math.max(0, ms) : 0 };
    }
    const read = await readBoundedJson(res);
    return read.ok ? { ok: true, body: read.value, observedAt } : { ok: false, failure: "invalid-body" };
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

/**
 * What may be searched for. Letters, digits, spaces and a few joiners, 2–24
 * characters — a coin name, never a URL fragment or a query string. Anything
 * else is refused before it is spliced into a request.
 */
export function searchable(query: string): string | null {
  const q = typeof query === "string" ? query.trim().replace(/^\$/, "") : "";
  return /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,23}$/u.test(q) ? q : null;
}

/** GeckoTerminal's pool search, on Robinhood Chain only. Pools are parsed like every other feed. */
export async function searchPools(query: string, timeoutMs = 8000, signal?: AbortSignal): Promise<GeckoFetch> {
  const q = searchable(query);
  if (!q) return { pools: [], failed: true, failure: "invalid-query" };
  return memoized<GeckoFetch>(
    `search:${q.toLowerCase()}`,
    async () => {
      const r = await getJson(`/search/pools?query=${encodeURIComponent(q)}&network=${GECKO_NETWORK}&page=1`, timeoutMs, signal);
      if (!r.ok) return { pools: [], failed: true, failure: r.failure, ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}) };
      const data = (r.body as { data?: unknown })?.data;
      if (!Array.isArray(data)) return { pools: [], failed: true, failure: "invalid-shape" };
      return { pools: data.map(parseGeckoPool).filter((p): p is GeckoPool => p !== null), failed: false, observedAt: r.observedAt };
    },
    (failure) => ({ pools: [], failed: true, failure }),
  );
}

export interface BarsRead extends FeedResult {
  bars: Bar[];
  /** The token's own symbol and name, as the index's chart metadata gives them. */
  symbol?: string;
  name?: string;
  quoteSymbol?: string;
}

const finitePositive = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Hourly OHLCV rows → bars, oldest first. A row whose wicks do not contain its
 * body, or that is in the future, is dropped rather than repaired. The bar
 * still forming is kept: its close IS the current price.
 */
export function parseHourlyBars(body: unknown, token: string, now = Date.now()): Omit<BarsRead, keyof FeedResult> | null {
  const j = (body ?? {}) as { data?: { attributes?: { ohlcv_list?: unknown } }; meta?: { base?: Record<string, unknown>; quote?: Record<string, unknown> } };
  const rows = j.data?.attributes?.ohlcv_list;
  const base = j.meta?.base ?? {};
  if (!Array.isArray(rows) || typeof base.address !== "string" || base.address.toLowerCase() !== token.toLowerCase()) return null;
  const byTime = new Map<number, Bar>();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const time = finitePositive(row[0]);
    const [open, high, low, close] = [row[1], row[2], row[3], row[4]].map(finitePositive);
    const volume = typeof row[5] === "number" && Number.isFinite(row[5]) && row[5] >= 0 ? row[5] : null;
    if (!time || !open || !high || !low || !close || time % 3600 !== 0 || time > now / 1000) continue;
    if (low > Math.min(open, close) || high < Math.max(open, close)) continue;
    byTime.set(time, { time, open, high, low, close, volume });
  }
  const label = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);
  const symbol = label(base.symbol, 24);
  const name = label(base.name, 48);
  const quoteSymbol = label(j.meta?.quote?.symbol, 12);
  return {
    bars: [...byTime.values()].sort((a, b) => a.time - b.time),
    ...(symbol ? { symbol } : {}),
    ...(name ? { name } : {}),
    ...(quoteSymbol ? { quoteSymbol } : {}),
  };
}

/** Up to a week of hourly candles for one pool, priced in USD for `token`. */
export async function readHourlyBars(poolId: string, token: string, limit = 168, timeoutMs = 8000, signal?: AbortSignal): Promise<BarsRead> {
  const pool = typeof poolId === "string" ? poolId.toLowerCase() : "";
  const tok = typeof token === "string" ? token.toLowerCase() : "";
  if (!/^0x([\da-f]{40}|[\da-f]{64})$/.test(pool) || !/^0x[\da-f]{40}$/.test(tok)) return { failed: true, failure: "invalid-market", bars: [] };
  const n = Math.max(24, Math.min(168, Math.floor(limit)));
  return memoized<BarsRead>(
    `hour:${pool}:${tok}:${n}`,
    async () => {
      const r = await getJson(`/networks/${GECKO_NETWORK}/pools/${pool}/ohlcv/hour?aggregate=1&limit=${n}&currency=usd&token=${tok}`, timeoutMs, signal);
      if (!r.ok) return { failed: true, failure: r.failure, bars: [], ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}) };
      const parsed = parseHourlyBars(r.body, tok);
      return parsed ? { failed: false, observedAt: r.observedAt, ...parsed } : { failed: true, failure: "invalid-shape", bars: [] };
    },
    (failure) => ({ failed: true, failure, bars: [] }),
  );
}
