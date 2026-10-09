/**
 * A COIN'S MEASURED FACTS, ON ANY CHAIN THE INDEX COVERS (docs/tg-groups.md
 * "A coin's facts, on request"; Milla, 2026-10-09).
 *
 * "What happened to auton", "why did it rug", "show me the data", "did the
 * dev dump" are answered with what the public index measured, never a guess:
 * GeckoTerminal's pools for the token (the main pool: credible, deepest),
 * that pool's hourly closes (about 41 days), and, when asked about the data
 * or the dev, the token's info (holders, the top ten's share, the creator's
 * holding share as the index lists it). Fomo's own token stats carry no price
 * and no high, so they cannot measure a collapse; this can.
 *
 * WHAT IS NEVER KEPT: an address of any kind beyond the one asked about (no
 * pool address leaves this file, no creator address is read into a field),
 * a reason, a person. The highest HOURLY CLOSE, never a wick: a wick is one
 * trade, a close is where the hour settled. A high before the bars reach
 * (a pre-migration bonding curve, a pool older than the bars) is not seen,
 * which understates a fall: the safe direction.
 *
 * NOTHING HERE TRADES. A token address is a lookup key for a room's answer;
 * it is never nominated, never written to discovery, never reaches trading
 * (docs/tg-groups.md rule 1). Reads share the fleet GeckoTerminal quota and
 * the desk's one-minute memo (gecko.ts), are bounded per chat and per agent
 * (FactsLimiter) and in time (the caller's timeout), and never retry.
 *
 * No DexScreener fallback (follow-up F11): venues/dexscreener.ts is trading
 * machinery, and this file never touches it.
 */
import { collapseOf, type CoinFacts, type CoinFactsRead, type CoinFactsReader, type FactsNetwork } from "../coin-facts-types";
import { GECKO_NETWORK } from "../venues/geckoterminal";
import type { FeedResult } from "../venues/fleet-feed-cache";
import { getJson, memoized, parseHourlyBars } from "./gecko";
import type { Bar } from "./ta";

export { collapseOf };

/** GeckoTerminal's network ids for the chains a room's coin may be on. */
export const FACTS_NETWORK_IDS: Readonly<Record<FactsNetwork, string>> = {
  robinhood: GECKO_NETWORK,
  solana: "solana",
  base: "base",
  ethereum: "eth",
  bsc: "bsc",
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Whether `address` can be a token on `network`. A Solana mint is case-sensitive and is never lowercased. */
export function factsAddressOk(network: unknown, address: unknown): boolean {
  if (typeof network !== "string" || !Object.hasOwn(FACTS_NETWORK_IDS, network) || typeof address !== "string") return false;
  return network === "solana" ? SOLANA_MINT.test(address) : EVM_ADDRESS.test(address);
}

const sameAddress = (network: FactsNetwork, a: string, b: string): boolean => (network === "solana" ? a === b : a.toLowerCase() === b.toLowerCase());

/** Index ids are "<network>_<address>": split at the first "_", the prefix checked. */
function idAddress(id: unknown, net: string): string | null {
  if (typeof id !== "string") return null;
  const at = id.indexOf("_");
  if (at <= 0 || id.slice(0, at) !== net) return null;
  return id.slice(at + 1);
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const pos = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const count = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 && Number.isSafeInteger(n) ? n : null;
};
const when = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** One pool of the coin, reduced to what the facts use. `poolAddress` is a lookup key here and never leaves this file in a fact. */
export interface FactsPool {
  poolAddress: string;
  /** The coin is the pool's base token (its price, FDV, change and buyers are the coin's). */
  isBase: boolean;
  priceUsd: number;
  fdvUsd: number | null;
  reserveUsd: number | null;
  volume24hUsd: number | null;
  createdAtMs: number | null;
  change24hPct: number | null;
  buyers24h: number | null;
  sellers24h: number | null;
}

/** The token's pools as the index lists them; a row that is not about this coin, or junk, is skipped. Never throws. */
export function parseFactsPools(body: unknown, network: FactsNetwork, address: string): FactsPool[] {
  const net = FACTS_NETWORK_IDS[network];
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: FactsPool[] = [];
  for (const row of data) {
    try {
      if (!row || typeof row !== "object") continue;
      const r = row as { id?: unknown; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id?: unknown } }> };
      const a = r.attributes ?? {};
      const poolAddress = (typeof a.address === "string" ? a.address : null) ?? idAddress(r.id, net);
      if (!poolAddress || !(network === "solana" ? SOLANA_MINT.test(poolAddress) : /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(poolAddress))) continue;
      const base = idAddress(r.relationships?.base_token?.data?.id, net);
      const quote = idAddress(r.relationships?.quote_token?.data?.id, net);
      const isBase = base !== null && sameAddress(network, base, address);
      const isQuote = quote !== null && sameAddress(network, quote, address);
      if (!isBase && !isQuote) continue;
      const priceUsd = pos(isBase ? a.base_token_price_usd : a.quote_token_price_usd);
      if (priceUsd === null) continue;
      const tx = (a.transactions as Record<string, Record<string, unknown>> | undefined)?.h24;
      out.push({
        poolAddress,
        isBase,
        priceUsd,
        fdvUsd: isBase ? pos(a.fdv_usd) : null,
        reserveUsd: num(a.reserve_in_usd),
        volume24hUsd: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
        createdAtMs: when(a.pool_created_at),
        change24hPct: isBase ? num((a.price_change_percentage as Record<string, unknown> | undefined)?.h24) : null,
        buyers24h: isBase ? count(tx?.buyers) : null,
        sellers24h: isBase ? count(tx?.sellers) : null,
      });
    } catch {
      /* one malformed row costs that row */
    }
  }
  return out;
}

/** The least liquidity a pool needs to say anything about a coin's price. */
export const MAIN_POOL_MIN_RESERVE_USD = 1_000;

/**
 * THE MAIN POOL: of the credible ones (at least MAIN_POOL_MIN_RESERVE_USD of
 * liquidity, and some volume in 24h), the deepest. A dust pool's price, or a
 * stale pool nobody trades with a stranded reserve (AUTON/STONK: $39k reserve,
 * no volume, a price a hundred times the market's), is never the coin's.
 */
export function mainPoolOf(pools: readonly FactsPool[]): FactsPool | null {
  let best: FactsPool | null = null;
  for (const p of pools) {
    if (p.reserveUsd === null || p.reserveUsd < MAIN_POOL_MIN_RESERVE_USD) continue;
    if (p.volume24hUsd === null || !(p.volume24hUsd > 0)) continue;
    if (!best || p.reserveUsd > best.reserveUsd!) best = p;
  }
  return best;
}

/** The biggest fall kept, between closes at most this many hours apart, and the least worth saying. */
export const STEEPEST_MAX_HOURS = 3;
export const STEEPEST_MIN_PCT = 50;

/**
 * What the hourly closes measure against the price now: the highest close
 * (never a wick) and when it settled, how far below it the coin is, and the
 * biggest fall between closes one to three hours apart (from the first
 * close's time). A bar's time is its start; its close settles at its end, or
 * at `nowMs` for the bar still forming.
 */
export function measureBars(bars: readonly Bar[], priceNow: number, supply: number | null, nowMs = Infinity): Pick<CoinFacts, "high" | "barsFromMs" | "drawdownPct" | "steepest"> {
  const sorted = [...bars].filter((b) => b && Number.isFinite(b.close) && b.close > 0 && Number.isFinite(b.time)).sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return { high: null, barsFromMs: null, drawdownPct: null, steepest: null };
  let top = sorted[0]!;
  for (const b of sorted) if (b.close > top.close) top = b;
  // When that close settled: its bar's end, as the steepest drop below is timed (review, 2026-10-09).
  const high = { closeUsd: top.close, fdvUsd: supply !== null ? top.close * supply : null, atMs: Math.min((top.time + 3600) * 1000, nowMs) };
  const drawdownPct = Math.max(0, (1 - priceNow / top.close) * 100);
  let steepest: CoinFacts["steepest"] = null;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const hours = (sorted[j]!.time - sorted[i]!.time) / 3600;
      if (hours > STEEPEST_MAX_HOURS) break;
      const pct = (1 - sorted[j]!.close / sorted[i]!.close) * 100;
      // From when the earlier close settled (its bar's end), for that many hours.
      if (pct >= STEEPEST_MIN_PCT && (!steepest || pct > steepest.pct)) steepest = { pct, fromMs: (sorted[i]!.time + 3600) * 1000, hours };
    }
  }
  return { high, barsFromMs: sorted[0]!.time * 1000, drawdownPct, steepest };
}

/** The token's info: holders, the top ten's share and when counted, the creator's share. Never the creator's address. */
export function parseFactsInfo(body: unknown, network: FactsNetwork, address: string): Pick<CoinFacts, "holders" | "creatorHoldingPct"> | null {
  try {
    const d = (body as { data?: { id?: unknown; attributes?: Record<string, unknown> } } | null)?.data;
    const id = idAddress(d?.id, FACTS_NETWORK_IDS[network]);
    if (!d || !id || !sameAddress(network, id, address) || !d.attributes) return null;
    const a = d.attributes;
    const h = a.holders as { count?: unknown; distribution_percentage?: Record<string, unknown>; last_updated?: unknown } | undefined;
    const c = count(h?.count);
    const top = num(h?.distribution_percentage?.top_10);
    const holders = c !== null && c > 0 ? { count: c, top10Pct: top !== null && top >= 0 && top <= 100 ? top : null, updatedAtMs: when(h?.last_updated) } : null;
    const dev = num(a.developer_holding_percentage);
    return { holders, creatorHoldingPct: dev !== null && dev >= 0 && dev <= 100 ? dev : null };
  } catch {
    return null;
  }
}

/** How one index read went: its body, or why not. */
export type FactsFetch = (route: string, timeoutMs: number) => Promise<{ ok: true; body: unknown; observedAt: number } | { ok: false; failure: string }>;

interface RawRead extends FeedResult {
  body?: unknown;
}

/**
 * A BOUND ON HOW OFTEN ONE ROOM, AND THIS AGENT, MAY ASK: by default 4 facts
 * reads per chat per 10 minutes and 20 per agent per hour. A read past either
 * is "busy" and costs nothing. In memory: a restart forgets it, which is safe.
 */
export class FactsLimiter {
  private readonly chats = new Map<number, number[]>();
  private agent: number[] = [];
  private readonly now: () => number;
  private readonly perChat: number;
  private readonly chatWindowMs: number;
  private readonly perAgent: number;
  private readonly agentWindowMs: number;

  constructor(o: { perChat?: number; chatWindowMs?: number; perAgent?: number; agentWindowMs?: number; now?: () => number } = {}) {
    this.now = o.now ?? Date.now;
    this.perChat = o.perChat ?? 4;
    this.chatWindowMs = o.chatWindowMs ?? 10 * 60_000;
    this.perAgent = o.perAgent ?? 20;
    this.agentWindowMs = o.agentWindowMs ?? 60 * 60_000;
  }

  /** Takes one read for this chat, or false when the chat or the agent has had its share. */
  take(chatId: number): boolean {
    const t = this.now();
    const mine = (this.chats.get(chatId) ?? []).filter((at) => t - at < this.chatWindowMs);
    this.agent = this.agent.filter((at) => t - at < this.agentWindowMs);
    if (mine.length >= this.perChat || this.agent.length >= this.perAgent) {
      this.chats.set(chatId, mine);
      return false;
    }
    mine.push(t);
    this.agent.push(t);
    if (!this.chats.has(chatId) && this.chats.size >= 512) this.chats.delete(this.chats.keys().next().value!);
    this.chats.set(chatId, mine);
    return true;
  }
}

/** The most one facts answer may take (the room's reply has 30 s in all). */
export const FACTS_TIMEOUT_MS = 10_000;
/** One index read's longest share. */
const READ_MS = 4_000;
/** Hourly closes asked for: about 41 days. */
const BARS_LIMIT = 1_000;

/**
 * THE READER (index.ts wires it into the group research port). Never throws:
 * an address that cannot be on the network, or a network the index does not
 * cover, is "unsupported" before anything is fetched; the limiter's "no" is
 * "busy"; a read that failed or ran out of time is "unavailable"; no credible
 * pool is "not-found".
 */
export function createCoinFactsReader(o: { fetchJson?: FactsFetch; now?: () => number; limiter?: FactsLimiter } = {}): CoinFactsReader {
  const fetchJson: FactsFetch = o.fetchJson ?? ((route, timeoutMs) => getJson(route, timeoutMs));
  const now = o.now ?? Date.now;
  const limiter = o.limiter ?? new FactsLimiter({ now });
  const read = (key: string, route: string, timeoutMs: number): Promise<RawRead> =>
    memoized<RawRead>(
      `facts:${key}`,
      async () => {
        const r = await fetchJson(route, timeoutMs);
        return r.ok ? { failed: false, observedAt: r.observedAt, body: r.body } : { failed: true, failure: r.failure };
      },
      (failure) => ({ failed: true, failure }),
    );

  return async (q): Promise<CoinFactsRead> => {
    try {
      if (!q || !factsAddressOk(q.network, q.address)) return { ok: false, why: "unsupported" };
      if (!limiter.take(q.chatId)) return { ok: false, why: "busy" };
      const network = q.network;
      const net = FACTS_NETWORK_IDS[network];
      // A Solana mint is never lowercased, in a route or a memo key.
      const addr = network === "solana" ? q.address : q.address.toLowerCase();
      const budget = Math.max(1, Math.min(FACTS_TIMEOUT_MS, Number.isFinite(q.timeoutMs) ? q.timeoutMs : FACTS_TIMEOUT_MS));
      const until = now() + budget;
      const left = (): number => until - now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<CoinFactsRead>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, why: "unavailable" }), budget);
        (timer as { unref?: () => void }).unref?.();
      });
      const work = (async (): Promise<CoinFactsRead> => {
        const pools = await read(`pools:${net}:${addr}`, `/networks/${net}/tokens/${addr}/pools?page=1`, Math.min(READ_MS, left()));
        if (pools.failed) return { ok: false, why: "unavailable" };
        const all = parseFactsPools(pools.body, network, addr);
        const main = mainPoolOf(all);
        if (!main) return { ok: false, why: "not-found" };
        const observedAt = typeof pools.observedAt === "number" ? pools.observedAt : now();
        const [barsRead, infoRead] = await Promise.all([
          left() > 250
            ? read(`hour:${net}:${main.poolAddress}:${addr}`, `/networks/${net}/pools/${main.poolAddress}/ohlcv/hour?aggregate=1&limit=${BARS_LIMIT}&currency=usd&token=${addr}`, Math.min(READ_MS, left()))
            : Promise.resolve<RawRead>({ failed: true, failure: "late" }),
          q.withInfo && left() > 250
            ? read(`info:${net}:${addr}`, `/networks/${net}/tokens/${addr}/info`, Math.min(READ_MS, left()))
            : Promise.resolve<RawRead | null>(null),
        ]);
        const bars = barsRead.failed ? [] : parseHourlyBars(barsRead.body, addr, now())?.bars ?? [];
        const supply = main.isBase && main.fdvUsd !== null ? main.fdvUsd / main.priceUsd : null;
        const measured = measureBars(bars, main.priceUsd, supply, observedAt);
        const info = infoRead && !infoRead.failed ? parseFactsInfo(infoRead.body, network, addr) : null;
        const facts: CoinFacts = {
          network,
          observedAt,
          priceUsd: main.priceUsd,
          fdvNowUsd: main.fdvUsd,
          ...measured,
          poolCreatedAtMs: main.createdAtMs,
          liquidityUsd: main.reserveUsd,
          change24hPct: main.change24hPct,
          buyers24h: main.buyers24h,
          sellers24h: main.sellers24h,
          holders: info?.holders ?? null,
          creatorHoldingPct: info?.creatorHoldingPct ?? null,
          info: !q.withInfo ? "not-asked" : info ? "read" : "failed",
          poolsSeen: all.length,
        };
        return { ok: true, facts };
      })().catch((): CoinFactsRead => ({ ok: false, why: "unavailable" }));
      try {
        return await Promise.race([work, late]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      return { ok: false, why: "unavailable" };
    }
  };
}
