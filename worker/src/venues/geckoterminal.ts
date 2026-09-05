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

import { readBoundedJson } from "../bounded-read";

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

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
export interface GeckoFetch {
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
}

/**
 * Fetch one of GeckoTerminal's pool lists for this chain, saying whether it
 * could be reached.
 */
export async function fetchGeckoPoolsResult(
  feed: PoolFeed,
  opts: { timeoutMs?: number; page?: number } = {},
): Promise<GeckoFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(`${GECKO_BASE}/networks/${GECKO_NETWORK}/${feed}?page=${opts.page ?? 1}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return { pools: [], failed: true };
    // Bounded: an unbounded read hands a third party this worker's memory
    // ceiling. A refusal reads as `failed`, which is already the "we could not
    // learn anything" branch — never as an empty market.
    const read = await readBoundedJson<{ data?: unknown[] }>(res);
    if (!read.ok) return { pools: [], failed: true };
    const body = read.value;
    // A body with no `data` array is a shape we do not understand, not an empty
    // market. An empty `data` array IS an empty market, and reads as one.
    if (!Array.isArray(body?.data)) return { pools: [], failed: true };
    return {
      pools: body.data.map(parseGeckoPool).filter((p): p is GeckoPool => p !== null),
      failed: false,
    };
  } catch {
    return { pools: [], failed: true };
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
}

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
    kept.push(p);
  }
  return { kept, dropped };
}
