/** Public index reads for the reply-only recovery service. No cache, keys or account state. */
import { coinBrief, coinFloor, coinHeader, marketBrief, marketFloor, marketHeader, measureCoin, measureMarket, type DeskReads } from "../desk/evidence";
import { coinChartSvg, marketChartSvg, renderPng } from "../desk/chart";
import { DeskBudget, type DeskReadOptions } from "../desk/deadline";
import { coinIndicatorFloors, coinScenarioFloors } from "../desk/scenarios";
import { marketScenarioFloors } from "../desk/market-scenarios";
import { utcClock } from "../desk/format";
import type { BarsRead } from "../desk/gecko";
import type { LoreRead } from "../desk/lore";
import type { GeckoFetch, GeckoPool, GeckoWindow } from "../venues/geckoterminal";
import type { TgDeskAsk, TgDeskOutcome } from "./tg-groups/types";

const ORIGIN = "https://api.geckoterminal.com/api/v2";
const NETWORK = "robinhood";
export const RECOVERY_PUBLIC_MAX_BYTES = 256 * 1024;
const WINDOWS: readonly GeckoWindow[] = ["m5", "h1", "h6", "h24"];
const ADDRESS = /^0x[0-9a-f]{40}$/;
const POOL = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const unavailable = (): TgDeskOutcome => ({ ok: false, why: "unavailable" });

export interface RecoveryPublicReadOptions {
  timeoutMs: number;
  signal: AbortSignal;
}
export type RecoveryPublicLook = (ask: TgDeskAsk, options: RecoveryPublicReadOptions) => Promise<TgDeskOutcome>;
export interface RecoveryPublicTransportDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  render?: (svg: string | null, options?: DeskReadOptions) => Promise<Uint8Array | null>;
}

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown, max: number): string => typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u.test(v) ? v : "";
const number = (v: unknown, negative = false): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() && v.length <= 48 ? Number(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= 1e18 && (negative || n >= 0) ? n : null;
};
const count = (v: unknown): number | null => { const n = number(v); return n !== null && Number.isSafeInteger(n) ? n : null; };
const ticker = (v: unknown): string => { const s = string(v, 16); return /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(s) ? s : ""; };

/** Strict network/contract identity; never resolve a requested token by a matching name. */
function poolProjection(raw: unknown, now: number): GeckoPool | null {
  const row = record(raw), a = record(row.attributes), rel = record(row.relationships);
  const poolId = string(a.address, 66).toLowerCase();
  const tokenId = string(record(record(rel.base_token).data).id, 80).toLowerCase();
  const token = tokenId.slice(`${NETWORK}_`.length);
  if (!POOL.test(poolId) || row.id !== `${NETWORK}_${poolId}` || tokenId !== `${NETWORK}_${token}` || !ADDRESS.test(token)) return null;
  const pct = record(a.price_change_percentage), volume = record(a.volume_usd), tx = record(a.transactions);
  const buckets = Object.fromEntries(WINDOWS.map((window) => {
    const t = record(tx[window]);
    return [window, { changePct: number(pct[window], true), volumeUsd: number(volume[window]), buys: count(t.buys), sells: count(t.sells), buyers: count(t.buyers), sellers: count(t.sellers) }];
  })) as GeckoPool["buckets"];
  const created = typeof a.pool_created_at === "string" ? Date.parse(a.pool_created_at) : NaN;
  return {
    poolId, poolAddress: ADDRESS.test(poolId) ? poolId as `0x${string}` : null, tokenAddress: token as `0x${string}`,
    name: string(a.name, 128), dex: string(record(record(rel.dex).data).id, 64),
    priceUsd: number(a.base_token_price_usd), reserveUsd: number(a.reserve_in_usd), fdvUsd: number(a.fdv_usd),
    volume24hUsd: buckets.h24.volumeUsd, change24hPct: buckets.h24.changePct, change1hPct: buckets.h1.changePct,
    buys24h: buckets.h24.buys, sells24h: buckets.h24.sells, buyers24h: buckets.h24.buyers, buckets,
    createdAt: Number.isFinite(created) && created > 0 && created <= now ? Math.floor(created / 1000) : null,
  };
}

/** Require a streaming body, enforce the byte bound while reading, and cancel on expiry. */
async function boundedJson(res: Response, signal: AbortSignal): Promise<unknown | null> {
  const declared = res.headers.get("content-length");
  if (signal.aborted || !res.body || (declared !== null && Number(declared) > RECOVERY_PUBLIC_MAX_BYTES)) {
    void res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let stop!: () => void;
  const aborted = new Promise<null>((resolve) => { stop = () => { chunks.length = 0; void reader.cancel().catch(() => {}); resolve(null); }; });
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) { stop(); return null; }
    for (;;) {
      const part = await Promise.race([reader.read(), aborted]);
      if (!part || signal.aborted) return null;
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > RECOVERY_PUBLIC_MAX_BYTES) { stop(); return null; }
      chunks.push(part.value);
    }
    const joined = new Uint8Array(bytes);
    let at = 0;
    for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)) as unknown;
  } catch { return null; }
  finally { chunks.length = 0; signal.removeEventListener("abort", stop); try { reader.releaseLock(); } catch {} }
}

function cleanDescription(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 8000) return "";
  const text = raw.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, " ").replace(/\s+/g, " ").trim();
  return /(?:ignore|disregard|override).{0,40}(?:instructions|prompt|rules)|\b(?:system|assistant|developer)\s*:|\b(?:reveal|exfiltrate).{0,30}(?:secret|key|credential)/i.test(text) ? "" : text.slice(0, 500);
}

/** No request occurs at construction. Each call has its own cancellation and no retained memo. */
export function createRecoveryPublicLook(deps: RecoveryPublicTransportDeps = {}): RecoveryPublicLook {
  const read = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const render = deps.render ?? renderPng;
  return async (ask, options) => {
    const ms = typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? Math.floor(Math.min(10_000, options.timeoutMs)) : 0;
    if (ms < 1 || options?.signal?.aborted || !options?.signal || ask?.kind === "comparison") return unavailable();
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    let expire!: () => void;
    const stopped = new Promise<TgDeskOutcome>((resolve) => { expire = () => { controller.abort(); resolve(unavailable()); }; });
    const timer = setTimeout(expire, ms);
    controller.signal.addEventListener("abort", expire, { once: true });
    const budget = new DeskBudget(ms);
    const get = async (route: string, slice?: DeskReadOptions): Promise<{ body: unknown; observedAt: number } | null> => {
      if (controller.signal.aborted || slice?.signal?.aborted) return null;
      const left = Math.floor(Math.min(8000, budget.remaining(), slice?.timeoutMs ?? 8000));
      if (left < 1) return null;
      const signal = AbortSignal.any([controller.signal, ...(slice?.signal ? [slice.signal] : []), AbortSignal.timeout(left)]);
      const observedAt = now();
      try {
        const res = await read(`${ORIGIN}${route}`, { headers: { accept: "application/json" }, redirect: "error", signal });
        if (!res.ok || signal.aborted) { void res.body?.cancel().catch(() => {}); return null; }
        const body = await boundedJson(res, signal);
        return body !== null && !signal.aborted ? { body, observedAt } : null;
      } catch { return null; }
    };
    const pools = async (route: string, slice?: DeskReadOptions): Promise<GeckoFetch> => {
      const result = await get(route, slice);
      const data = result && record(result.body).data;
      if (!result || !Array.isArray(data) || data.length > 100) return { pools: [], failed: true, failure: "unavailable" };
      const projected = data.map((row) => poolProjection(row, now())).filter((p): p is GeckoPool => p !== null);
      return data.length && !projected.length ? { pools: [], failed: true, failure: "invalid-shape" }
        : { pools: projected, failed: false, observedAt: result.observedAt };
    };
    const reads: DeskReads = {
      now,
      search: (query, slice) => /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,23}$/.test(query) ? pools(`/search/pools?query=${encodeURIComponent(query)}&network=${NETWORK}&page=1`, slice) : Promise.resolve({ pools: [], failed: true, failure: "invalid-query" }),
      tokenPools: (token, slice) => ADDRESS.test(token) ? pools(`/networks/${NETWORK}/tokens/${token}/pools?page=1`, slice) : Promise.resolve({ pools: [], failed: true, failure: "invalid-token" }),
      feed: (feed, slice) => ["trending_pools", "pools", "new_pools"].includes(feed) ? pools(`/networks/${NETWORK}/${feed}?page=1`, slice) : Promise.resolve({ pools: [], failed: true }),
      hourly: async (pool, token, slice): Promise<BarsRead> => {
        const missing: BarsRead = { bars: [], failed: true, failure: "unavailable" };
        if (!POOL.test(pool) || !ADDRESS.test(token)) return missing;
        const result = await get(`/networks/${NETWORK}/pools/${pool}/ohlcv/hour?aggregate=1&limit=168&currency=usd&token=${token}`, slice);
        if (!result) return missing;
        const body = record(result.body), meta = record(body.meta), base = record(meta.base);
        const rows = record(record(body.data).attributes).ohlcv_list;
        if (string(base.address, 42).toLowerCase() !== token || !Array.isArray(rows) || rows.length > 168) return missing;
        const bars = new Map<number, BarsRead["bars"][number]>();
        for (const row of rows) {
          if (!Array.isArray(row)) continue;
          const time = number(row[0]), open = number(row[1]), high = number(row[2]), low = number(row[3]), close = number(row[4]);
          if (!time || time % 3600 || time > now() / 1000 || !open || !high || !low || !close || low > Math.min(open, close) || high < Math.max(open, close)) continue;
          bars.set(time, { time, open, high, low, close, volume: number(row[5]) });
        }
        const ordered = [...bars.values()].sort((a, b) => a.time - b.time);
        if (!ordered.length || now() / 1000 - ordered[ordered.length - 1]!.time > 7200) return missing;
        return { failed: false, observedAt: result.observedAt, bars: ordered, symbol: ticker(base.symbol), quoteSymbol: ticker(record(meta.quote).symbol) };
      },
      lore: async (token, slice): Promise<LoreRead> => {
        if (!ADDRESS.test(token)) return { failed: true };
        const result = await get(`/networks/${NETWORK}/tokens/${token}/info`, slice);
        if (!result) return { failed: true };
        const row = record(record(result.body).data), a = record(row.attributes);
        if (row.type !== "token" || string(row.id, 80).toLowerCase() !== `${NETWORK}_${token}` || string(a.address, 42).toLowerCase() !== token) return { failed: true };
        const description = cleanDescription(a.description);
        return { failed: false, observedAt: result.observedAt, ...(description ? { profile: { token: token as `0x${string}`, chainId: 4663 as const, description, source: "GeckoTerminal token info" as const, url: `https://www.geckoterminal.com/robinhood/tokens/${token}`, observedAtMs: result.observedAt } } : {}) };
      },
    };
    const work = async (): Promise<TgDeskOutcome> => {
      if (controller.signal.aborted) return unavailable();
      if (ask?.kind === "market") {
        const measured = await measureMarket(reads, (s) => Boolean(ticker(s)), budget);
        if (!measured.ok || controller.signal.aborted) return measured.ok ? unavailable() : { ok: false, why: measured.why };
        const market = measured.market;
        const chart = await budget.run((slice) => render(marketChartSvg(market), { ...slice, signal: AbortSignal.any([controller.signal, slice.signal!]) }), null, 1000);
        return { ok: true, evidence: { kind: "market", subject: "market", reference: { kind: "market" }, header: marketHeader(market), brief: marketBrief(market), floor: marketFloor(market), scenarios: marketScenarioFloors(market), source: `GeckoTerminal ${utcClock(market.observedAtMs)} UTC`, observedAtMs: market.observedAtMs, chart } };
      }
      if (ask?.kind !== "coin") return unavailable();
      const measured = await measureCoin(ask, reads, (s) => Boolean(ticker(s)), budget);
      if (!measured.ok || controller.signal.aborted) return measured.ok ? unavailable() : { ok: false, why: measured.why };
      const coin = measured.coin;
        const svg = coinChartSvg(coin);
        const chart = svg ? await budget.run((slice) => render(svg, { ...slice, signal: AbortSignal.any([controller.signal, slice.signal!]) }), null, 1000) : null;
      return { ok: true, evidence: { kind: "coin", subject: coin.symbol, reference: { kind: "coin", address: coin.token }, header: coinHeader(coin), brief: coinBrief(coin), floor: coinFloor(coin), scenarios: coinScenarioFloors(coin), indicators: coinIndicatorFloors(coin), source: `GeckoTerminal ${utcClock(coin.observedAtMs)} UTC`, observedAtMs: coin.observedAtMs, chart, ...(coin.lore ? { lore: { description: coin.lore.description, source: coin.lore.source, url: coin.lore.url, observedAtMs: coin.lore.observedAtMs } } : {}) } };
    };
    try {
      const value = await Promise.race([Promise.resolve().then(work).catch(unavailable), stopped]);
      return controller.signal.aborted ? unavailable() : value;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", expire);
      options.signal.removeEventListener("abort", abort);
      controller.abort();
    }
  };
}
