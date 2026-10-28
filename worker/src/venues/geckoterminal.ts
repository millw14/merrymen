/**
 * GeckoTerminal — what is actually trading on this chain, including tokens the
 * agent would otherwise never hear about.
 *
 * WHAT THIS ADDS. merrymen only ever saw tokens at the moment a pool was
 * created: discovery watches Initialize events, so a coin that launched last
 * week and is up 40% today is invisible to it. The owner's ask was to consider
 * trending and established coins too, not only fresh launches. This is that
 * source — and it is the only free one that also indexes PRE-GRADUATION Pons
 * curves (DexScreener returns `pairs:null` for those), so one API covers both
 * halves of this chain's market.
 *
 * WHY NOT A HEADLESS BROWSER. The idea was a browser on Railway, like the one
 * used for research. For this job an API is strictly better: a browser costs
 * memory and breaks whenever a page changes, to obtain data that arrives here
 * already structured and typed. Keep a browser for the one thing an API cannot
 * do — reading a token's own site or socials for rug signals — and only once
 * this path is earning its keep.
 *
 * SHAPE OF THE TRUST. Everything here is a THIRD PARTY'S CLAIM about a market.
 * It is used to decide what is worth LOOKING at; it must never be the thing
 * that decides what is safe to buy. Prices for anything held are read from the
 * chain (venues/pool-price.ts, venues/pons-price.ts), and the wall and the
 * scout budget remain the boundary. A feed that could open a position by
 * asserting a number is a feed that decides what to buy.
 *
 * Free and keyless, with a modest rate limit, so this runs on a slow cadence of
 * its own — never in the trading tick.
 */

import { readBounded, readBoundedJson } from "../bounded-read";
import { FleetFeedCache, LocalFeedCache, REAL_FEED_CLOCK, credentialFingerprint, type FeedCache, type FeedClock, type FeedLane, type FeedResult } from "./fleet-feed-cache";
import { proPacing } from "./coingecko-pacing";
import path from "node:path";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

/** Credentials go only to CoinGecko's fixed server-side origin, in headers. */
export function geckoSource(
  env: { MERRYMEN_COINGECKO_PRO_API_KEY?: string } = {
    MERRYMEN_COINGECKO_PRO_API_KEY: process.env.MERRYMEN_COINGECKO_PRO_API_KEY,
  },
): { id: NonNullable<FeedResult["provider"]>; base: string; headers: Record<string, string> } {
  const key = env.MERRYMEN_COINGECKO_PRO_API_KEY?.trim();
  return key
    ? { id: "coingecko-pro", base: "https://pro-api.coingecko.com/api/v3/onchain", headers: { accept: "application/json", "x-cg-pro-api-key": key } as Record<string, string> }
    : { id: "geckoterminal-public", base: GECKO_BASE, headers: { accept: "application/json" } as Record<string, string> };
}
export type GeckoSource = ReturnType<typeof geckoSource>;

const feedCaches = new Map<string, FeedCache>();
let feedClock = REAL_FEED_CLOCK;

/** Test seam: real production clocks and persistent cache files are unchanged. */
export function resetGeckoFeedsForTest(clock: FeedClock = REAL_FEED_CLOCK): void {
  for (const cache of feedCaches.values()) cache.close();
  feedCaches.clear(); tokenPoolsMemo.clear(); tokenPoolsPending.clear();
  feedClock = clock;
}

/** Each operator note once per process, however many lanes are rebuilt. */
const saidNotes = new Set<string>();
function sayOnce(line: string): void {
  if (saidNotes.has(line)) return;
  saidNotes.add(line);
  console.warn(`[gecko] ${line}`);
}

/**
 * The pace a source's lane runs at.
 *
 * Public swagger documents approximately 10/min (the older FAQ says 30), so
 * the public lane keeps the stricter bound and is not configurable: there is
 * no plan to buy more of it. Pro is the operator's plan, so its pace is the
 * operator's knob, clamped to the monthly credit ceiling (coingecko-pacing.ts).
 * A fleet home means the shared worker lane; anything else is process-local
 * (the web service, a self-hosted worker) and gets the smaller share.
 */
export function laneSpacingMs(source: GeckoSource, fleet: boolean, env: Parameters<typeof proPacing>[0] = process.env): number {
  if (source.id === "geckoterminal-public") return 6500;
  const pacing = proPacing(env, fleet ? "fleet" : "local");
  for (const note of pacing.notes) sayOnce(note);
  return pacing.spacingMs;
}

/**
 * WHICH LANE A READ SPENDS: the fleet's, named explicitly. A child inherits
 * MERRYMEN_FLEET_HOME from the orchestrator, which never sets it on itself
 * (the variable is the children's). So a read made IN the orchestrator — an
 * X answer's coin facts — passes the fleet home here and shares the
 * children's spacing slot, cooldowns and plan latch, instead of a private
 * lane that would coordinate with nobody. Absent: the environment's, as before.
 */
export interface GeckoLane {
  fleetHome?: string;
}

function cacheFor(source: GeckoSource, lane?: GeckoLane): FeedCache {
  const home = (lane?.fleetHome ?? process.env.MERRYMEN_FLEET_HOME)?.trim();
  const pro = source.id === "coingecko-pro";
  // Which key this lane sends, as a fingerprint only (never the key): a plan
  // latch belongs to the credential that was refused, so a fixed or rotated
  // key starts clean — in this process, and in the fleet's persistent file.
  const credential = pro ? credentialFingerprint(source.headers["x-cg-pro-api-key"] ?? "") : "";
  const key = `${home ? path.resolve(home) : "local"}:${source.id}:${credential}`;
  let cache = feedCaches.get(key);
  if (!cache) {
    const spacing = laneSpacingMs(source, Boolean(home));
    // Only the credit-metered lane latches plan refusals; the public lane has
    // no plan, and a 401 there would be a different fact. And only that lane
    // has the evidence row: the public lane's 6.5 s spacing is its whole
    // defence against a ~10/min limit, so every public request, whoever
    // asked, keeps to it (fleet-feed-cache.ts FeedLane).
    const options = { latchRefusals: pro, priorityRow: pro, credential };
    cache = home ? new FleetFeedCache(path.join(home, source.id), spacing, feedClock, options) : new LocalFeedCache(spacing, feedClock, options);
    feedCaches.set(key, cache);
  }
  return cache;
}

/** How one read wants to be queued; every field is optional and defaults to the old behaviour. */
export interface GeckoReadOptions {
  /**
   * Pacing row (fleet-feed-cache.ts FeedLane). Omitted: the default row.
   * Honoured on the Pro lane only; a public read (keyless, or the fallback
   * during a Pro outage) always takes the public lane's one row.
   */
  lane?: FeedLane;
  /**
   * The provider route asked for, path and query, as spliced after the base.
   * Its template keys the Pro lane's one-hour plan-refusal latch. Omitted: no
   * latch for this read.
   */
  route?: string;
  /**
   * The whole read's budget across both sources, at most the shared 30 s.
   * For a caller somebody is waiting on (a page request, a Brain evidence
   * leg), so a busy lane answers `request-budget` WITHOUT claiming a slot
   * rather than holding the caller open or spending a credit nobody waits for.
   */
  budgetMs?: number;
  /** The fleet lane named explicitly (GeckoLane); omitted, the environment's. */
  fleet?: GeckoLane;
}

/** A separately offered public source, never a retry with another credential.
 * No fallback on rejected authority (401/403, a latched plan refusal), bad
 * requests, or broken cache. Both sources retain their own pacing, observation
 * age and 429 cooldowns. */
async function readGecko<T extends FeedResult>(key: string, request: (source: GeckoSource, remainingMs: number) => Promise<T>, unavailable: (reason: string) => T, opts: GeckoReadOptions = {}): Promise<T> {
  const budget = Math.min(30_000, Math.max(0, opts.budgetMs ?? 30_000));
  const primary = geckoSource(), deadline = feedClock.now() + budget;
  const read = async (source: GeckoSource): Promise<T> => {
    try {
      return await cacheFor(source, opts.fleet).get(`${GECKO_NETWORK}:${key}`, async () => {
        const remaining = deadline - feedClock.now();
        const result = remaining > 0 ? await request(source, remaining) : unavailable("request-budget");
        return { ...result, provider: source.id };
      }, failure => ({ ...unavailable(failure), provider: source.id }), deadline, { lane: opts.lane, route: opts.route });
    } catch { return { ...unavailable("cache-unavailable"), provider: source.id }; }
  };
  const result = await read(primary);
  if (primary.id !== "coingecko-pro" || !result.failed ||
    !/^(?:http-(?:429|408|5\d\d)|provider-cooldown|network|timeout|unavailable)$/.test(result.failure ?? "")) return result;
  return { ...await read(geckoSource({})), primaryFailure: result.failure };
}

/** CoinGecko's MAIN API (coins, search, trending), on the Pro key's own fixed origin. */
export const COINGECKO_PRO_MAIN = "https://pro-api.coingecko.com/api/v3";

/**
 * ONE READ OF COINGECKO'S MAIN API — a coin by name or ticker, its market,
 * the trending list — on the Pro lane: the same spacing slot (and evidence
 * row), 429 cooldown, plan latch and monthly credit ceiling as every onchain
 * read, its pages kept apart (`coins:`). `route` names the endpoint for the
 * latch ("search", "coins/markets", "search/trending").
 *
 * ONLY WITH A PRO KEY, AND NEVER A FALLBACK. The keyless public GeckoTerminal
 * source has no such endpoints, and the key never goes anywhere but this
 * origin: keyless is `no-pro-key`, and nothing is asked. `budgetMs` bounds
 * the whole read, slot wait included, so a caller with seconds to spare is
 * told `request-budget` rather than kept waiting or charged for an answer
 * nobody hears.
 */
export async function cachedCoinGecko<T extends FeedResult>(
  key: string,
  request: (headers: Readonly<Record<string, string>>, base: string, remainingMs: number) => Promise<T>,
  unavailable: (reason: string) => T,
  opts: GeckoReadOptions = {},
): Promise<T> {
  const source = geckoSource();
  if (source.id !== "coingecko-pro") return unavailable("no-pro-key");
  const deadline = feedClock.now() + Math.min(30_000, Math.max(0, opts.budgetMs ?? 30_000));
  try {
    return await cacheFor(source, opts.fleet).get(`coins:${key}`, async () => {
      const remaining = deadline - feedClock.now();
      const result = remaining > 0 ? await request(source.headers, COINGECKO_PRO_MAIN, remaining) : unavailable("request-budget");
      return { ...result, provider: source.id };
    }, failure => ({ ...unavailable(failure), provider: source.id }), deadline, { lane: opts.lane, route: opts.route });
  } catch { return { ...unavailable("cache-unavailable"), provider: source.id }; }
}

/**
 * A refused response, reduced to a safe failure code and a Retry-After.
 *
 * ONE COPY, because four readers each parsed Retry-After by hand. And one
 * place to recognise CoinGecko's plan refusal: error_code 10005 ("you may not
 * have access to this endpoint") becomes `plan-restricted`, which the Pro lane
 * latches for an hour. The body is peeked only for a client refusal (never a
 * 429 or 5xx), bounded to 4 KB, and never returned — provider text stays out
 * of every result and log.
 */
export async function geckoRefusal(res: Pick<Response, "status"> & Partial<Pick<Response, "headers" | "body" | "text">>): Promise<{ failure: string; retryAfterMs: number }> {
  let retryAfterMs = 0;
  try {
    const retry = res.headers?.get("retry-after") ?? null;
    const parsed = retry === null ? 0 : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
    retryAfterMs = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  } catch { /* an unreadable header is no Retry-After */ }
  let failure = `http-${res.status}`;
  if (res.status >= 400 && res.status < 500 && res.status !== 429 && typeof res.text === "function" && res.headers) {
    try {
      const peek = await readBounded(res as Response, 4096);
      if (peek.ok && /"error_code"\s*:\s*10005\b/.test(peek.text)) failure = "plan-restricted";
    } catch { /* unreadable is not a plan refusal */ }
  }
  // Already drained by the peek, or a test double without a stream: either way nothing to release.
  try { await res.body?.cancel(); } catch { /* released or never there */ }
  return { failure, retryAfterMs };
}

/** The network slug for Robinhood Chain (4663) in GeckoTerminal's namespace. */
export const GECKO_NETWORK = "robinhood";

/** Which list to ask for. Each answers a different question about a market. */
export type PoolFeed = "trending_pools" | "new_pools" | "pools";

/**
 * One pool, reduced to the facts a trading decision could use.
 *
 * Deliberately NOT the raw API object: every numeric field arrives as a string
 * and several can be absent, so parsing at the edge means the rest of the
 * codebase never handles a `"0.0000058"` that might also be `undefined`.
 */
/**
 * The windows GeckoTerminal publishes a tape for.
 *
 * FOUR, AND NOT THE FOUR THE REFERENCE PRODUCT SHOWS. Their grid reads
 * 5M / 1H / 4H / 1D. This index has no four-hour bucket, so ours reads
 * 5M / 1H / 6H / 24H — relabelling h6 as "4H" would be a fabrication that
 * nothing downstream could detect.
 */
export const GECKO_WINDOWS = ["m5", "h1", "h6", "h24"] as const;
export type GeckoWindow = (typeof GECKO_WINDOWS)[number];

/** One window of a pool's tape. Every field is null when the index omitted it. */
export interface GeckoBucket {
  /** Percent change across the window (17.691 = +17.691%). */
  changePct: number | null;
  volumeUsd: number | null;
  buys: number | null;
  sells: number | null;
  /** Distinct addresses. Harder to fake than the transaction count. */
  buyers: number | null;
  sellers: number | null;
}

export interface GeckoPool {
  /**
   * The pool's identifier, lowercased, exactly as the index gives it.
   *
   * TWO WIDTHS, AND THE DIFFERENCE MATTERS. A v2/v3 pool is its own contract,
   * so this is 20 bytes. A Uniswap-v4-style pool is an entry in a singleton, so
   * this is a 32-byte poolId — the hash of a PoolKey, NOT something that can be
   * called. On this chain that second kind is not an edge case: the v4, Pons
   * and Bankr pools are all identified that way, and they are most of what this
   * pivot is about.
   */
  poolId: string;
  /**
   * The pool CONTRACT, when one exists — null for a 32-byte poolId.
   *
   * Kept separate from `poolId` so the difference cannot be lost in transit: a
   * caller wanting somewhere to send an eth_call gets an address or nothing,
   * rather than a 32-byte hash that would fail somewhere far from here.
   */
  poolAddress: `0x${string}` | null;
  /** The non-quote token — what you would actually be buying. Lowercased. */
  tokenAddress: `0x${string}`;
  /** Human label as GeckoTerminal renders it, e.g. "CHUMP / WETH 1%". */
  name: string;
  /** Which venue it trades on, e.g. "uniswap-v3-robinhood" or a Pons curve. */
  dex: string;
  priceUsd: number | null;
  /**
   * Total value the index reports in the pool, USD.
   *
   * NOT a depth figure you may trade on, and specifically not for the Pons
   * rows this feed also returns: a bonding curve is opened with a VIRTUAL quote
   * reserve of 40% of its graduation threshold while holding none of the quote
   * asset, and an indexer reading reserves sees that seed like anyone else. Use
   * it to rank what is worth looking at; read real depth from the chain
   * (venues/pons-price.ts realQuoteRaw) before it decides anything.
   */
  reserveUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  /** Percent change over 24h, as a number (17.691 = +17.691%). */
  change24hPct: number | null;
  /** Percent change over 1h — a trend can reverse inside a day. */
  change1hPct: number | null;
  buys24h: number | null;
  sells24h: number | null;
  /** Distinct buyers in 24h. Harder to fake than transaction count. */
  buyers24h: number | null;
  /**
   * The same tape across every window the index publishes.
   *
   * The flat fields above are this record's h24 entry under older names, kept
   * because the scout's filters and their tests are written against them. Read
   * this for anything new — it is the only place the shorter windows exist.
   */
  buckets: Record<GeckoWindow, GeckoBucket>;
  /** Unix seconds the pool was created, or null when unparseable. */
  createdAt: number | null;
}

/**
 * A tape with nothing in it.
 *
 * Exists so a caller that must hand over a pool without having read one names
 * the absence once, rather than hand-writing two dozen nulls and getting one
 * of them wrong.
 */
export function emptyGeckoBuckets(): Record<GeckoWindow, GeckoBucket> {
  return Object.fromEntries(
    GECKO_WINDOWS.map((w) => [
      w,
      { changePct: null, volumeUsd: null, buys: null, sells: null, buyers: null, sellers: null },
    ]),
  ) as Record<GeckoWindow, GeckoBucket>;
}

/** A number that arrived as a string, or null — never NaN, never a silent 0. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

/** `robinhood_0xabc…` → `0xabc…`. Returns null for anything else. */
function tokenIdToAddress(id: unknown): `0x${string}` | null {
  if (typeof id !== "string") return null;
  const m = /(0x[0-9a-fA-F]{40})$/.exec(id);
  return m ? (m[1]!.toLowerCase() as `0x${string}`) : null;
}

/**
 * Parse one API pool object.
 *
 * Returns null rather than a partly-filled record when the two things that
 * IDENTIFY a pool — its own address and the token it trades — cannot both be
 * read. Every other field is allowed to be null, because a missing volume is a
 * missing fact the caller can weigh, whereas a missing token address is a row
 * about nothing.
 */
export function parseGeckoPool(raw: unknown): GeckoPool | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as {
    attributes?: Record<string, unknown>;
    relationships?: { base_token?: { data?: { id?: unknown } }; dex?: { data?: { id?: unknown } } };
  };
  const a = r.attributes;
  if (!a) return null;

  // Accept BOTH widths. An earlier draft of this required 20 bytes and so
  // silently dropped every v4, Pons and Bankr pool — 9 of 20 trending rows, and
  // exactly the venues this source exists to reach. A parser that discards most
  // of its input while reporting success is worse than one that throws.
  const addr = typeof a.address === "string" ? a.address.toLowerCase() : "";
  const isContract = /^0x[0-9a-f]{40}$/.test(addr);
  const isPoolId = /^0x[0-9a-f]{64}$/.test(addr);
  const tokenAddress = tokenIdToAddress(r.relationships?.base_token?.data?.id);
  if ((!isContract && !isPoolId) || !tokenAddress) return null;

  const pct = (a.price_change_percentage ?? {}) as Record<string, unknown>;
  const vol = (a.volume_usd ?? {}) as Record<string, unknown>;
  const tx = (a.transactions ?? {}) as Record<
    string,
    { buys?: unknown; sells?: unknown; buyers?: unknown; sellers?: unknown } | undefined
  >;

  // Every window, parsed once. The flat 24h fields below are DERIVED from this
  // rather than read a second time, so what a page draws and what the scout
  // filters on cannot drift apart.
  const buckets = Object.fromEntries(
    GECKO_WINDOWS.map((w) => {
      const t = tx[w] ?? {};
      return [
        w,
        {
          changePct: num(pct[w]),
          volumeUsd: num(vol[w]),
          buys: int(t.buys),
          sells: int(t.sells),
          buyers: int(t.buyers),
          sellers: int(t.sellers),
        },
      ];
    }),
  ) as Record<GeckoWindow, GeckoBucket>;

  const createdRaw = a.pool_created_at;
  const createdMs = typeof createdRaw === "string" ? Date.parse(createdRaw) : NaN;

  return {
    poolId: addr,
    poolAddress: isContract ? (addr as `0x${string}`) : null,
    tokenAddress,
    name: typeof a.name === "string" ? a.name : "",
    dex: typeof r.relationships?.dex?.data?.id === "string" ? r.relationships.dex.data.id : "",
    priceUsd: num(a.base_token_price_usd),
    reserveUsd: num(a.reserve_in_usd),
    fdvUsd: num(a.fdv_usd),
    volume24hUsd: buckets.h24.volumeUsd,
    change24hPct: buckets.h24.changePct,
    change1hPct: buckets.h1.changePct,
    buys24h: buckets.h24.buys,
    sells24h: buckets.h24.sells,
    buyers24h: buckets.h24.buyers,
    buckets,
    createdAt: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : null,
  };
}

/** A pool list, and whether the index could actually be asked. */
export interface GeckoFetch extends FeedResult {
  pools: GeckoPool[];
  /**
   * True when the request failed — a rate limit, an outage, a changed shape.
   *
   * SEPARATE FROM AN EMPTY LIST ON PURPOSE, because the two are different facts
   * and one of them is a lie when reported as the other. This API is keyless
   * and rate-limited, so a refusal is routine; a dashboard that renders it as
   * "nothing is trading right now" states something false about the market
   * while looking completely normal. The same mistake has been made twice in
   * this repo already — the node's 10,000-log cap turned into `[]`, and a null
   * activity map read as a quiet launchpad.
   */
  failed: boolean;
  /** Safe diagnostic codes only; never provider bodies or credential-bearing URLs. */
  failure?: string;
  observedAt?: number;
  retryAfterMs?: number;
}

/**
 * Fetch one of GeckoTerminal's pool lists for this chain, saying whether it
 * could be reached.
 */
export async function fetchGeckoPoolsResult(
  feed: PoolFeed,
  opts: { timeoutMs?: number; page?: number } & Pick<GeckoReadOptions, "budgetMs" | "fleet" | "lane"> = {},
): Promise<GeckoFetch> {
  return readGecko(`${feed}:${opts.page ?? 1}`,
    (source, remainingMs) => requestGeckoPools(feed, { timeoutMs: Math.min(opts.timeoutMs ?? 10_000, remainingMs), ...(opts.page !== undefined ? { page: opts.page } : {}) }, source),
    failure => ({ pools: [], failed: true, failure }),
    // A caller someone is waiting on (an X answer) names its budget, its row
    // and the fleet lane; the tape names none and reads as it always did.
    { route: poolsRoute(feed, opts.page), ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}), ...(opts.fleet ? { fleet: opts.fleet } : {}), ...(opts.lane ? { lane: opts.lane } : {}) });
}

const poolsRoute = (feed: PoolFeed, page = 1) => `/networks/${GECKO_NETWORK}/${feed}?page=${page}`;

/**
 * Detail reads spend the same fleet quota as discovery, including cooldowns.
 * `options` opts a read into the evidence row, names its route for the plan
 * latch, or bounds it for a waiting page — see GeckoReadOptions.
 */
export async function cachedGeckoDetail<T extends FeedResult>(key: string, request: (source: GeckoSource, remainingMs: number) => Promise<T>, unavailable: (reason: string) => T, options: GeckoReadOptions = {}): Promise<T> {
  return readGecko(`detail:${key}`, request, unavailable, options);
}

async function requestGeckoPools(feed: PoolFeed, opts: { timeoutMs?: number; page?: number }, source: GeckoSource): Promise<GeckoFetch> {
  const observedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(`${source.base}${poolsRoute(feed, opts.page)}`, {
      headers: source.headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (!res.ok) return { pools: [], failed: true, ...await geckoRefusal(res) };
    // Bounded: an unbounded read hands a third party this worker's memory
    // ceiling. A refusal reads as `failed`, which is already the "we could not
    // learn anything" branch — never as an empty market.
    const read = await readBoundedJson<{ data?: unknown[] }>(res);
    if (!read.ok) return { pools: [], failed: true, failure: "invalid-body" };
    const body = read.value;
    // A body with no `data` array is a shape we do not understand, not an empty
    // market. An empty `data` array IS an empty market, and reads as one.
    if (!Array.isArray(body?.data)) return { pools: [], failed: true, failure: "invalid-shape" };
    return {
      pools: body.data.map(parseGeckoPool).filter((p): p is GeckoPool => p !== null),
      failed: false,
      observedAt,
    };
  } catch {
    return { pools: [], failed: true, failure: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ONE TOKEN'S OWN POOLS — GeckoTerminal's `/tokens/{address}/pools` page.
 *
 * The only per-token read this module makes, and it exists for one caller
 * shape: somebody handed the agent an ADDRESS (a coin posted in a Telegram
 * group, docs/tg-groups.md) and the question is which of its pools the index
 * knows about. The feed lists answer "what is busy", which a coin nobody has
 * traded much yet is never on. The answer is a lookup, not a verdict: the
 * pools found here are ranked and screened like every tape row
 * (highVolumePools), and a v3 pool is still verified on chain by
 * trencher-discovery.ts before anything can be bought.
 *
 * ONLY POOLS WHOSE BASE TOKEN IS THIS ADDRESS. The page also lists pools where
 * the token is the QUOTE side, and `tokenAddress` on those is the other coin —
 * something nobody asked about. Kept out here so no caller can mistake a pool
 * against this token for a pool of it.
 *
 * A 404 IS AN ANSWER, NOT A FAILURE. The index returns it for an address it
 * has never seen trade — a wallet, a router, a coin with no pool — and that is
 * exactly the fact the caller is asking for. It reads as an empty, healthy
 * page; the chain (getCode) decides what the address actually is. Every other
 * refusal, timeout or odd body is `failed`, because unreadable is not absent.
 *
 * THE FLEET QUOTA IS SHARED, so this goes through `cachedGeckoDetail` (one
 * spacing slot and one cooldown for every tenant on the host) and through a
 * small in-process memo on top, so a coin looked at and then kept on the tape
 * costs one request a minute rather than one per caller. Self-hosted has no
 * fleet cache and uses a process-local pacing/cache lane instead.
 */
export async function readTokenPoolsResult(address: string, opts: { timeoutMs?: number } = {}): Promise<GeckoFetch> {
  const token = typeof address === "string" ? address.toLowerCase() : "";
  // A lookup key, validated before it becomes part of a URL: nothing but an
  // address may be spliced into the provider's path.
  if (!/^0x[0-9a-f]{40}$/.test(token)) return { pools: [], failed: true, failure: "invalid-address" };
  const source = geckoSource();
  const memoKey = `${source.id}:${token}`;
  const cached = tokenPoolsMemo.get(memoKey);
  if (cached && cached.until > Date.now()) return cached.value;
  const inFlight = tokenPoolsPending.get(memoKey);
  if (inFlight) return inFlight;
  const unavailable = (failure: string): GeckoFetch => ({ pools: [], failed: true, failure });
  const job = cachedGeckoDetail(`tokenpools:${token}`, (source, remainingMs) => requestTokenPools(token, { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? 10_000, remainingMs) }, source), unavailable,
    { route: tokenPoolsRoute(token) })
    .catch(() => unavailable("unavailable"))
    .then((value) => {
      if (tokenPoolsMemo.size >= 256) tokenPoolsMemo.delete(tokenPoolsMemo.keys().next().value!);
      // The same lifetimes the fleet cache gives a page: a healthy answer for a
      // minute from when it was OBSERVED (a cache hit never renews it), a
      // failure for five seconds so a blip does not pin a coin as unreadable.
      tokenPoolsMemo.set(memoKey, { until: value.failed ? Date.now() + 5000 : (value.observedAt ?? 0) + 60_000, value });
      return value;
    })
    .finally(() => tokenPoolsPending.delete(memoKey));
  tokenPoolsPending.set(memoKey, job);
  return job;
}

/** The pools as a list, or null when the index could not be read. See readTokenPoolsResult. */
export async function readTokenPools(address: string): Promise<GeckoPool[] | null> {
  const r = await readTokenPoolsResult(address);
  return r.failed ? null : r.pools;
}

const tokenPoolsMemo = new Map<string, { until: number; value: GeckoFetch }>();
const tokenPoolsPending = new Map<string, Promise<GeckoFetch>>();
const tokenPoolsRoute = (token: string) => `/networks/${GECKO_NETWORK}/tokens/${token}/pools?page=1`;

async function requestTokenPools(token: string, opts: { timeoutMs?: number }, source: GeckoSource): Promise<GeckoFetch> {
  const observedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(`${source.base}${tokenPoolsRoute(token)}`, {
      headers: source.headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return { pools: [], failed: false, observedAt };
    }
    if (!res.ok) return { pools: [], failed: true, ...await geckoRefusal(res) };
    const read = await readBoundedJson<{ data?: unknown[] }>(res);
    if (!read.ok) return { pools: [], failed: true, failure: "invalid-body" };
    if (!Array.isArray(read.value?.data)) return { pools: [], failed: true, failure: "invalid-shape" };
    return {
      pools: read.value.data
        .map(parseGeckoPool)
        .filter((p): p is GeckoPool => p !== null && p.tokenAddress === token),
      failed: false,
      observedAt,
    };
  } catch {
    return { pools: [], failed: true, failure: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The same fetch, as a plain list.
 *
 * Kept because the tick genuinely wants this shape: discovery is not a trading
 * dependency and must never be able to take the loop down, so "could not ask"
 * and "nothing to consider" lead to the same action there. Anything that
 * REPORTS to a human should use `fetchGeckoPoolsResult` instead — see its
 * `failed` field for why.
 */
export async function fetchGeckoPools(
  feed: PoolFeed,
  opts: { timeoutMs?: number; page?: number } = {},
): Promise<GeckoPool[]> {
  return (await fetchGeckoPoolsResult(feed, opts)).pools;
}

/** What a pool has to clear before it is even worth an opinion. */
export interface ScreenLimits {
  minReserveUsd: number;
  minVolume24hUsd: number;
  /** Distinct buyers, not trades — a wash-trader can inflate the latter cheaply. */
  minBuyers24h: number;
  /**
   * Smallest fully diluted value worth considering, USD. 0 or absent = no floor.
   *
   * THE "CAP" IN "HIGH CAP", and the one figure here that is about SIZE rather
   * than activity. Depth, volume and buyers all describe how busy a pool is
   * this week; two coins can match on all three and be a $40k novelty and a
   * $4M one. An owner who wants the larger end of the chain has, until now, had
   * no way to say so.
   *
   * FDV AND NOT MARKET CAP, because market cap needs a circulating-supply
   * figure nobody on this chain publishes honestly. FDV is supply times price
   * and both are readable, so it is the number that can actually be checked —
   * and it is the CONSERVATIVE one for this purpose: it counts tokens that have
   * never been sold into the pool, which is exactly the overhang the scout is
   * already told to weigh against.
   */
  minFdvUsd?: number;
}

/**
 * THE DISCOVERY SCREEN: what a trending coin has to clear before the scout is
 * even asked about it (index.ts discoverTrending) — at least $25k in the pool
 * (the Trencher's own price floor, strategies/trencher.ts minLiquidityUsd),
 * $50k of volume and a hundred distinct buyers in a day. Measured against live
 * data it keeps roughly 32 of 56 distinct pools: a cheapness filter, not a
 * judgement. Exported so an X answer's "what's hot" shows only coins the
 * fleet's own discovery would look at (orchestrator-xpost-research.ts).
 */
export const DISCOVERY_SCREEN: Readonly<ScreenLimits> = Object.freeze({
  minReserveUsd: 25_000,
  minVolume24hUsd: 50_000,
  minBuyers24h: 100,
});

/**
 * Drop pools not worth considering, and say why for the ones dropped.
 *
 * This is a CHEAPNESS filter, not a safety one. It exists so that the expensive
 * steps downstream — on-chain reads, and a language model's attention — are
 * spent on things that could plausibly be traded, and so a quiet chain produces
 * an empty list rather than noise. Nothing here makes a token safe to buy; the
 * wall and the scout budget do that.
 *
 * A pool missing the figure a limit tests is REFUSED, not waved through. On a
 * screening step, absent evidence is not evidence of soundness.
 */
export function screenPools(
  pools: readonly GeckoPool[],
  limits: ScreenLimits,
): { kept: GeckoPool[]; dropped: { name: string; why: string }[] } {
  const kept: GeckoPool[] = [];
  const dropped: { name: string; why: string }[] = [];
  for (const p of pools) {
    const label = p.name || p.tokenAddress;
    if (p.reserveUsd === null || p.reserveUsd < limits.minReserveUsd) {
      dropped.push({ name: label, why: `depth ${p.reserveUsd === null ? "unknown" : `$${Math.round(p.reserveUsd)}`} < $${limits.minReserveUsd}` });
      continue;
    }
    if (p.volume24hUsd === null || p.volume24hUsd < limits.minVolume24hUsd) {
      dropped.push({ name: label, why: `24h volume ${p.volume24hUsd === null ? "unknown" : `$${Math.round(p.volume24hUsd)}`} < $${limits.minVolume24hUsd}` });
      continue;
    }
    if (p.buyers24h === null || p.buyers24h < limits.minBuyers24h) {
      dropped.push({ name: label, why: `${p.buyers24h ?? "unknown"} buyers < ${limits.minBuyers24h}` });
      continue;
    }
    // AN UNKNOWN FDV IS REFUSED, like every other absent figure here — see the
    // header. A coin whose size cannot be read is not a coin that passed a size
    // floor. Skipped entirely when no floor is set, so an unreadable FDV costs
    // nothing to anyone who has not asked about size.
    if (limits.minFdvUsd && limits.minFdvUsd > 0) {
      if (p.fdvUsd === null || p.fdvUsd < limits.minFdvUsd) {
        dropped.push({
          name: label,
          why: `FDV ${p.fdvUsd === null ? "unknown" : `$${Math.round(p.fdvUsd).toLocaleString()}`} < $${limits.minFdvUsd.toLocaleString()}`,
        });
        continue;
      }
    }
    kept.push(p);
  }
  return { kept, dropped };
}
