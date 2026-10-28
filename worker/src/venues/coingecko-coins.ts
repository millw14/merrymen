/**
 * COINS BY NAME OR TICKER, FROM COINGECKO'S MAIN API — what an active agent
 * reads when someone tags it about bitcoin, eth or $SOL (docs/x-posting.md
 * "Research for answers"). Three reads, each on the fleet's CoinGecko Pro lane
 * (geckoterminal.ts cachedCoinGecko: the spacing slot, cooldown, plan latch,
 * monthly credit ceiling and a minute's cache per page):
 *
 *   /search?query=…            which coins go by that name or ticker
 *   /coins/markets?ids=…       one coin's rank, price, market cap, volume, 24h and 7d change
 *   /search/trending           CoinGecko's own trending list
 *
 * A MAJOR IS AN EXACT MATCH THAT RANKS. `pickMajor` takes a coin only when its
 * symbol or its name is exactly what was asked, case aside, and its market-cap
 * rank is at most MAJORS_MAX_RANK; between several, the best rank. "BTC2",
 * "Bitcoin Inu", an unranked token or one at #900 is no major, whatever it is
 * called, and gets no figures.
 *
 * NOTHING HERE DECIDES A TRADE. These coins are not Robinhood Chain tokens;
 * nothing read here is nominated, written where a trading decision reads, or
 * shown as anything but what CoinGecko listed. Provider text never leaves:
 * a coin's id is a lookup key, and only its symbol, through the figures
 * line's own sanitiser (xpost/figures.ts cleanTicker), is ever shown.
 */
import { readBoundedJson } from "../bounded-read";
import type { FeedResult } from "./fleet-feed-cache";
import { cachedCoinGecko, cachedGeckoDetail, GECKO_NETWORK, geckoRefusal, geckoSource, type GeckoLane } from "./geckoterminal";

/** The worst market-cap rank a coin may hold and still be answered as a major. */
export const MAJORS_MAX_RANK = 200;

/** One coin a search found: a lookup key, its symbol and name as listed, its rank (null: unranked). */
export interface CoinHit {
  id: string;
  symbol: string;
  name: string;
  rank: number | null;
}

/** One coin's market, USD. Every figure null when CoinGecko left it out; never a silent zero. */
export interface CoinMarket {
  id: string;
  symbol: string;
  name: string;
  rank: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  change7dPct: number | null;
}

export interface CoinSearchRead extends FeedResult { hits: CoinHit[] }
export interface CoinMarketRead extends FeedResult { market: CoinMarket | null }
export interface CoinTrendingRead extends FeedResult { coins: CoinHit[] }

/** A lookup key as CoinGecko writes one ("bitcoin", "shiba-inu", "the-open-network"), and nothing else. */
const COIN_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * WHAT MAY BE SEARCHED FOR: one to three words of letters and digits, a
 * cashtag's $ off, lowercase, at most forty characters. Anything else is
 * null and nothing is asked: a question's other words never reach the URL.
 */
export function coinQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.trim().replace(/^\$/, "").replace(/\s+/g, " ").toLowerCase();
  return /^[a-z0-9]+(?: [a-z0-9]+){0,2}$/.test(q) && q.length <= 40 ? q : null;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function rankOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

/** A hit as the search lists it, or null: an id that is a lookup key, and a symbol and a name that are strings. */
function hitOf(raw: unknown): CoinHit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !COIN_ID.test(r.id) || typeof r.symbol !== "string" || typeof r.name !== "string") return null;
  return { id: r.id, symbol: r.symbol.slice(0, 32), name: r.name.slice(0, 80), rank: rankOf(r.market_cap_rank) };
}

/** /search's coins, at most fifty; a body of any other shape is none. */
export function parseCoinSearch(body: unknown): CoinHit[] {
  const coins = (body as { coins?: unknown } | null)?.coins;
  return Array.isArray(coins) ? coins.slice(0, 50).map(hitOf).filter((h): h is CoinHit => h !== null) : [];
}

/** /search/trending's coins, in its order, at most fifteen. */
export function parseCoinTrending(body: unknown): CoinHit[] {
  const coins = (body as { coins?: unknown } | null)?.coins;
  return Array.isArray(coins) ? coins.slice(0, 15).map((c) => hitOf((c as { item?: unknown } | null)?.item)).filter((h): h is CoinHit => h !== null) : [];
}

/** /coins/markets' row for exactly this id, or null: another coin's row is never this one's. */
export function parseCoinMarket(body: unknown, id: string): CoinMarket | null {
  if (!Array.isArray(body)) return null;
  const row = body.find((r) => (r as { id?: unknown } | null)?.id === id) as Record<string, unknown> | undefined;
  const hit = hitOf(row);
  if (!row || !hit) return null;
  return {
    ...hit,
    priceUsd: finite(row.current_price),
    marketCapUsd: finite(row.market_cap),
    volume24hUsd: finite(row.total_volume),
    change24hPct: finite(row.price_change_percentage_24h_in_currency) ?? finite(row.price_change_percentage_24h),
    change7dPct: finite(row.price_change_percentage_7d_in_currency),
  };
}

/**
 * THE MAJOR A QUESTION NAMED, OR NONE: a hit whose symbol or name is exactly
 * the query (case aside, a cashtag's $ off), ranked at most `maxRank`; the
 * best rank among several. Never a near match.
 */
export function pickMajor(query: string, hits: readonly CoinHit[], maxRank = MAJORS_MAX_RANK): CoinHit | null {
  const q = coinQuery(query);
  if (!q) return null;
  const exact = hits.filter((h) => h.rank !== null && h.rank <= maxRank && (h.symbol.toLowerCase() === q || h.name.toLowerCase() === q));
  return exact.sort((a, b) => a.rank! - b.rank!)[0] ?? null;
}

type Raw = { ok: true; body: unknown; observedAt: number } | { ok: false; failure: string; retryAfterMs?: number };

/** One GET on the main API's fixed origin: the key in a header, no redirect, a bounded body, a safe failure code. */
async function getMain(base: string, headers: Readonly<Record<string, string>>, route: string, timeoutMs: number): Promise<Raw> {
  const observedAt = Date.now();
  try {
    const res = await fetch(`${base}${route}`, { headers: { ...headers }, redirect: "error", signal: AbortSignal.timeout(Math.max(1, timeoutMs)) });
    if (!res.ok) return { ok: false, ...await geckoRefusal(res) };
    const read = await readBoundedJson(res);
    return read.ok ? { ok: true, body: read.value, observedAt } : { ok: false, failure: "invalid-body" };
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

export interface CoinReadOptions {
  /** The whole read's budget, slot wait included: past it the read is skipped, never waited on. */
  timeoutMs: number;
  /** The fleet lane, named by a reader in the orchestrator (geckoterminal.ts GeckoLane). */
  fleet?: GeckoLane;
}

/** Someone is waiting on an answer: the evidence row, priority and never extra quota (fleet-feed-cache.ts FeedLane). */
const LANE = "evidence" as const;

/** Which coins go by this name or ticker. A query that is not one (coinQuery) asks nothing. */
export async function searchCoinList(query: string, o: CoinReadOptions): Promise<CoinSearchRead> {
  const q = coinQuery(query);
  if (!q) return { hits: [], failed: true, failure: "invalid-query" };
  const route = `/search?query=${encodeURIComponent(q)}`;
  return cachedCoinGecko<CoinSearchRead>(`search:${q}`, async (headers, base, remainingMs) => {
    const r = await getMain(base, headers, route, Math.min(o.timeoutMs, remainingMs));
    return r.ok ? { hits: parseCoinSearch(r.body), failed: false, observedAt: r.observedAt } : { hits: [], failed: true, failure: r.failure, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
  }, (failure) => ({ hits: [], failed: true, failure }), { lane: LANE, route, budgetMs: o.timeoutMs, ...(o.fleet ? { fleet: o.fleet } : {}) });
}

/** One coin's market, by its lookup key. A key that is not one asks nothing. */
export async function readCoinMarket(id: string, o: CoinReadOptions): Promise<CoinMarketRead> {
  if (typeof id !== "string" || !COIN_ID.test(id)) return { market: null, failed: true, failure: "invalid-id" };
  const route = `/coins/markets?vs_currency=usd&ids=${id}&price_change_percentage=24h,7d`;
  return cachedCoinGecko<CoinMarketRead>(`markets:${id}`, async (headers, base, remainingMs) => {
    const r = await getMain(base, headers, route, Math.min(o.timeoutMs, remainingMs));
    if (!r.ok) return { market: null, failed: true, failure: r.failure, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
    const market = parseCoinMarket(r.body, id);
    return market ? { market, failed: false, observedAt: r.observedAt } : { market: null, failed: true, failure: "invalid-shape" };
  }, (failure) => ({ market: null, failed: true, failure }), { lane: LANE, route, budgetMs: o.timeoutMs, ...(o.fleet ? { fleet: o.fleet } : {}) });
}

/** Several coins' markets, in the asked order: only rows whose id was asked, one each. */
export interface CoinMarketsRead extends FeedResult { markets: CoinMarket[] }

/** At most this many coins in one markets read. */
export const MARKETS_MAX = 5;

/**
 * SEVERAL COINS' MARKETS IN ONE READ (2026-10-12): what "how's the market?"
 * reads for the big coins (bitcoin, ethereum, solana), one /coins/markets
 * page on the fleet's CoinGecko Pro lane instead of one read per coin. Ids
 * that are no lookup key, past MARKETS_MAX, or repeated are dropped before
 * anything is asked; a row for an id not asked is never read as one asked.
 * A page with none of the asked rows is a failure, never an empty market.
 */
export async function readCoinMarkets(ids: readonly string[], o: CoinReadOptions): Promise<CoinMarketsRead> {
  const want = [...new Set(ids.filter((id) => typeof id === "string" && COIN_ID.test(id)))].slice(0, MARKETS_MAX);
  if (!want.length) return { markets: [], failed: true, failure: "invalid-id" };
  const route = `/coins/markets?vs_currency=usd&ids=${want.join(",")}&price_change_percentage=24h,7d`;
  return cachedCoinGecko<CoinMarketsRead>(`markets:${want.join(",")}`, async (headers, base, remainingMs) => {
    const r = await getMain(base, headers, route, Math.min(o.timeoutMs, remainingMs));
    if (!r.ok) return { markets: [], failed: true, failure: r.failure, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
    const markets = want.map((id) => parseCoinMarket(r.body, id)).filter((m): m is CoinMarket => m !== null);
    return markets.length ? { markets, failed: false, observedAt: r.observedAt } : { markets: [], failed: true, failure: "invalid-shape" };
  }, (failure) => ({ markets: [], failed: true, failure }), { lane: LANE, route, budgetMs: o.timeoutMs, ...(o.fleet ? { fleet: o.fleet } : {}) });
}

/** CoinGecko's trending coins, in its order. */
export async function readCoinTrending(o: CoinReadOptions): Promise<CoinTrendingRead> {
  const route = "/search/trending";
  return cachedCoinGecko<CoinTrendingRead>("trending", async (headers, base, remainingMs) => {
    const r = await getMain(base, headers, route, Math.min(o.timeoutMs, remainingMs));
    return r.ok ? { coins: parseCoinTrending(r.body), failed: false, observedAt: r.observedAt } : { coins: [], failed: true, failure: r.failure, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
  }, (failure) => ({ coins: [], failed: true, failure }), { lane: LANE, route, budgetMs: o.timeoutMs, ...(o.fleet ? { fleet: o.fleet } : {}) });
}

// ── the biggest coins, for the copycat screen ───────────────────────────────

/** CoinGecko's biggest coins by market cap, as the copycat screen reads them. */
export interface CoinTopRead extends FeedResult { coins: CoinHit[] }
/** How many of them: one page of /coins/markets. */
export const TOP_COINS = 250;

/**
 * COINGECKO'S BIGGEST COINS, BY MARKET CAP (red-team 2026-10-12): one page of
 * /coins/markets, the symbols and names a chain coin may not trend under
 * ("$WLFI", "$MNT", "$SONIC" from a chain memecoin read as World Liberty
 * Financial, Mantle and Sonic moving). An answer reads it at most once a day
 * (orchestrator-xpost-research.ts); a page with no coin on it is a failure,
 * never an empty list: no list is no screen, and the screen fails closed.
 */
export async function readTopCoins(o: CoinReadOptions): Promise<CoinTopRead> {
  const route = `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${TOP_COINS}&page=1`;
  return cachedCoinGecko<CoinTopRead>(`top:${TOP_COINS}`, async (headers, base, remainingMs) => {
    const r = await getMain(base, headers, route, Math.min(o.timeoutMs, remainingMs));
    if (!r.ok) return { coins: [], failed: true, failure: r.failure, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
    const coins = Array.isArray(r.body) ? r.body.slice(0, TOP_COINS).map(hitOf).filter((h): h is CoinHit => h !== null) : [];
    return coins.length ? { coins, failed: false, observedAt: r.observedAt } : { coins: [], failed: true, failure: "invalid-shape" };
  }, (failure) => ({ coins: [], failed: true, failure }), { lane: LANE, route, budgetMs: o.timeoutMs, ...(o.fleet ? { fleet: o.fleet } : {}) });
}

// ── a chain coin CoinGecko lists, by its address ────────────────────────────

/**
 * ONE ROBINHOOD CHAIN TOKEN COINGECKO LISTS, BY ITS ADDRESS (red-team
 * 2026-10-12): the coin GeckoTerminal's own token record names for that
 * contract (`coingecko_coin_id`), with that coin's symbol, name and
 * market-cap rank as CoinGecko's main API lists them (rank null: listed,
 * not ranked). What vouches for a chain coin's ticker before "what's hot"
 * shows it: whoever deploys a token names its pool, so a pool's own name is
 * never enough.
 */
export interface ChainListing {
  /** The token's contract, lowercase. */
  address: string;
  id: string;
  symbol: string;
  name: string;
  rank: number | null;
}
export interface ChainListingsRead extends FeedResult { listings: ChainListing[] }

/** At most this many contracts in one read. */
export const LISTINGS_MAX = 10;

const CONTRACT = /^0x[0-9a-f]{40}$/;

/**
 * GeckoTerminal's tokens page: each asked contract's CoinGecko coin id, only
 * for a record that is that exact contract on this chain. A token with no
 * coin id, another network's, another address's or an id that is no lookup
 * key is left out: not listed.
 */
export function parseTokenCoinIds(body: unknown, asked: readonly string[]): Map<string, string> {
  const want = new Set(asked.map((a) => String(a).toLowerCase()));
  const out = new Map<string, string>();
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const raw of data.slice(0, 50)) {
    const d = raw as { id?: unknown; type?: unknown; attributes?: Record<string, unknown> } | null;
    if (!d || d.type !== "token" || typeof d.id !== "string" || !d.attributes || typeof d.attributes !== "object") continue;
    const address = typeof d.attributes.address === "string" ? d.attributes.address.toLowerCase() : "";
    if (!CONTRACT.test(address) || !want.has(address) || d.id.toLowerCase() !== `${GECKO_NETWORK}_${address}`) continue;
    const id = d.attributes.coingecko_coin_id;
    if (typeof id === "string" && COIN_ID.test(id)) out.set(address, id);
  }
  return out;
}

type TokenIdsRead = FeedResult & { ids: [string, string][] };

/** The onchain tokens page for these contracts, on the fleet lane (the index's detail quota). */
async function readTokenCoinIds(list: readonly string[], o: CoinReadOptions): Promise<TokenIdsRead> {
  const route = `/networks/${GECKO_NETWORK}/tokens/multi/${list.join(",")}`;
  return cachedGeckoDetail<TokenIdsRead>(`tokensmulti:${list.join(",")}`, async (source, remainingMs) => {
    const observedAt = Date.now();
    try {
      const res = await fetch(`${source.base}${route}`, { headers: { ...source.headers }, redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(o.timeoutMs, remainingMs))) });
      if (!res.ok) return { ids: [], failed: true, ...await geckoRefusal(res) };
      const read = await readBoundedJson(res);
      if (!read.ok) return { ids: [], failed: true, failure: "invalid-body" };
      if (!Array.isArray((read.value as { data?: unknown } | null)?.data)) return { ids: [], failed: true, failure: "invalid-shape" };
      return { ids: [...parseTokenCoinIds(read.value, list)], failed: false, observedAt };
    } catch {
      return { ids: [], failed: true, failure: "unavailable" };
    }
  }, (failure) => ({ ids: [], failed: true, failure }), { lane: LANE, route, budgetMs: o.timeoutMs, ...(o.fleet ? { fleet: o.fleet } : {}) });
}

/**
 * THE CHAIN COINS COINGECKO LISTS, OF THESE CONTRACTS: GeckoTerminal's token
 * record for each (one read for up to LISTINGS_MAX), then CoinGecko's own
 * market row for every coin id found (one read), each on the fleet's lane
 * and inside `timeoutMs` in all. Only with a Pro key (the main API has no
 * public source): keyless is `no-pro-key` and nothing is asked. A contract
 * with no coin id, or whose coin has no market row, is simply not in the
 * list: not listed. Either read failing is a failure, never an empty list.
 */
export async function readChainListings(addresses: readonly string[], o: CoinReadOptions): Promise<ChainListingsRead> {
  const list = [...new Set(addresses.map((a) => String(a ?? "").toLowerCase()))].filter((a) => CONTRACT.test(a)).sort().slice(0, LISTINGS_MAX);
  if (!list.length) return { listings: [], failed: false };
  if (geckoSource().id !== "coingecko-pro") return { listings: [], failed: true, failure: "no-pro-key" };
  const started = Date.now();
  const tokens = await readTokenCoinIds(list, o);
  if (tokens.failed) return { listings: [], failed: true, failure: tokens.failure ?? "failed" };
  const byId = new Map<string, string[]>();
  for (const [address, id] of tokens.ids) byId.set(id, [...(byId.get(id) ?? []), address]);
  if (!byId.size) return { listings: [], failed: false, observedAt: tokens.observedAt ?? started };
  const ids = [...byId.keys()].sort();
  const left = o.timeoutMs - (Date.now() - started);
  if (left <= 0) return { listings: [], failed: true, failure: "request-budget" };
  const route = `/coins/markets?vs_currency=usd&ids=${ids.join(",")}`;
  const markets = await cachedCoinGecko<FeedResult & { rows: CoinHit[] }>(`listings:${ids.join(",")}`, async (headers, base, remainingMs) => {
    const r = await getMain(base, headers, route, Math.min(left, remainingMs));
    if (!r.ok) return { rows: [], failed: true, failure: r.failure, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
    if (!Array.isArray(r.body)) return { rows: [], failed: true, failure: "invalid-shape" };
    return { rows: r.body.slice(0, 50).map(hitOf).filter((h): h is CoinHit => h !== null), failed: false, observedAt: r.observedAt };
  }, (failure) => ({ rows: [], failed: true, failure }), { lane: LANE, route, budgetMs: left, ...(o.fleet ? { fleet: o.fleet } : {}) });
  if (markets.failed) return { listings: [], failed: true, failure: markets.failure ?? "failed" };
  const listings: ChainListing[] = [];
  const seen = new Set<string>();
  for (const row of markets.rows) {
    // One row per coin: a second row for the same id is not a second listing.
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    for (const address of byId.get(row.id) ?? []) listings.push({ address, id: row.id, symbol: row.symbol, name: row.name, rank: row.rank });
  }
  return { listings, failed: false, observedAt: markets.observedAt ?? started };
}
