/**
 * THE DESK'S EXTRA READS: a name search, an hourly chart and token metadata.
 *
 * Everything else the desk needs is already read elsewhere (a token's pools,
 * the trending/top/new feeds — venues/geckoterminal.ts). These reads
 * go through the same fleet quota (`cachedGeckoDetail`: one spacing
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
import { safeFetchUrl } from "../../../packages/core/src/index";
import { sanitizeMeta } from "../venues/pons-meta";

const MEMO_MS = 60_000;
const FAIL_MEMO_MS = 5_000;
const memo = new Map<string, { until: number; value: unknown }>();
const pending = new Map<string, Promise<unknown>>();

/** One request per key per minute, shared by every caller in this process. */
export async function memoized<T extends FeedResult>(key: string, run: () => Promise<T>, unavailable: (why: string) => T): Promise<T> {
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

export async function getJson(route: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: true; body: unknown; observedAt: number } | { ok: false; failure: string; retryAfterMs?: number }> {
  // Fleet pacing can outlive an optional caller's read budget. Never begin a
  // request after that caller has already cancelled it.
  if (signal?.aborted || timeoutMs < 1) return { ok: false, failure: "unavailable" };
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

/** Plain, bounded project prose; still untrusted publisher data, never instructions. */
export function cleanProjectText(raw: unknown, max = 500): string {
  if (typeof raw !== "string") return "";
  const plain = raw.slice(0, 8000)
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, (s) => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" }[s.toLowerCase()] ?? " "))
    .replace(/&#(x[\da-f]{1,6}|\d{1,7});/gi, (_whole, value: string) => {
      const point = value[0]?.toLowerCase() === "x" ? Number.parseInt(value.slice(1), 16) : Number.parseInt(value, 10);
      return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : " ";
    })
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ");
  const clean = sanitizeMeta(plain, max);
  // Reject obvious attempts to turn a published description into a model
  // instruction. The remaining prose is ALSO explicitly treated as a claim.
  return /(?:ignore|disregard|override).{0,40}(?:instructions|system prompt|previous rules)|\b(?:system|assistant|developer)\s*:|<\|(?:im_start|system)|\b(?:reveal|print|exfiltrate).{0,30}(?:secret|api key|credential)/i.test(clean) ? "" : clean;
}

/** A published link can be shown, but is never fetched by this reader. */
export function projectLink(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 500 || /[\u0000-\u0020\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(raw)) return undefined;
  const safe = safeFetchUrl(raw);
  if (!safe) return undefined;
  // Query strings are not needed for attribution, and can carry access tokens.
  safe.search = "";
  safe.hash = "";
  const out = safe.toString();
  return out.length <= 300 ? out : undefined;
}

export interface IndexedTokenInfo {
  token: `0x${string}`;
  name?: string;
  description: string;
  website?: string;
  twitter?: string;
}

export interface TokenInfoRead extends FeedResult {
  info?: IndexedTokenInfo;
}

/** Accept only the requested contract AND network, never a matching ticker. */
export function parseTokenInfo(body: unknown, token: string): IndexedTokenInfo | null {
  if (!/^0x[\da-f]{40}$/i.test(token)) return null;
  const data = (body as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object") return null;
  const d = data as { id?: unknown; type?: unknown; attributes?: unknown };
  if (d.type !== "token" || typeof d.id !== "string" || d.id.toLowerCase() !== `${GECKO_NETWORK}_${token.toLowerCase()}` || !d.attributes || typeof d.attributes !== "object") return null;
  const a = d.attributes as Record<string, unknown>;
  if (typeof a.address !== "string" || a.address.toLowerCase() !== token.toLowerCase()) return null;
  const name = cleanProjectText(a.name, 64);
  const description = cleanProjectText(a.description);
  const website = Array.isArray(a.websites) ? a.websites.slice(0, 5).map(projectLink).find(Boolean) : undefined;
  const handle = typeof a.twitter_handle === "string" && /^@?[a-z0-9_]{1,15}$/i.test(a.twitter_handle) ? a.twitter_handle.replace(/^@/, "") : undefined;
  const twitter = handle ? `https://x.com/${handle}` : undefined;
  return { token: token.toLowerCase() as `0x${string}`, ...(name ? { name } : {}), description, ...(website ? { website } : {}), ...(twitter ? { twitter } : {}) };
}

/** Metadata spends the existing fleet detail quota; the fixed origin keeps keys private. */
export async function readTokenInfo(address: string, timeoutMs = 3000, signal?: AbortSignal): Promise<TokenInfoRead> {
  const token = typeof address === "string" ? address.toLowerCase() : "";
  if (!/^0x[\da-f]{40}$/.test(token)) return { failed: true, failure: "invalid-token" };
  return memoized<TokenInfoRead>(
    `info:${GECKO_NETWORK}:${token}`,
    async () => {
      const r = await getJson(`/networks/${GECKO_NETWORK}/tokens/${token}/info`, timeoutMs, signal);
      if (!r.ok) return { failed: true, failure: r.failure, ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}) };
      const info = parseTokenInfo(r.body, token);
      return info ? { failed: false, observedAt: r.observedAt, info } : { failed: true, failure: "invalid-shape" };
    },
    (failure) => ({ failed: true, failure }),
  );
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
