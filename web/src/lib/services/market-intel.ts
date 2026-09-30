/**
 * Market intelligence for surfaces other than the dashboard (the MCP server
 * first): token search, one token's market facts, candles, pool flow, the
 * screened discovery lists, and the owner's watchlist.
 *
 * NO READS OF ITS OWN. Every provider behind this chain's market data is
 * rate-limited and already refuses the fleet at times (read-candles.ts,
 * read-discoveries.ts). A second surface asking on its own would spend the
 * budget the dashboard lives on. So every answer here comes from the readers
 * the dashboard already shares — sharedPools/sharedRead, fetchMarket,
 * readCandles, readPoolEvidence — each memoised and single-flight. The one
 * memo added here is over fetchMarket, which had none.
 *
 * PUBLIC CACHES ONLY HOLD PUBLIC DATA. Those memos are shared by every caller.
 * The owner's own tokens (custom tokens, watchlist) are passed in per call and
 * never stored in any of them.
 *
 * THREE QUESTIONS, NEVER MERGED. Discoverable (a discovery source lists it),
 * priceable (Merrymen would trust a price for it) and executable (a given
 * agent could buy it, eligibility.ts). A coin can be the first without the
 * second and the second without the third.
 *
 * IDENTITY IS THE LOWERCASED ADDRESS. A symbol is whatever the deployer typed —
 * the live market carries five coins called NEON (snipe-target.ts) — so symbols
 * are grouped and flagged here, never used to pick a token.
 *
 * Third-party text (pool labels, launcher descriptions, scout reasons, symbols
 * read from contracts) is returned RAW by this module; the surface that shows
 * it must mark it untrusted.
 */
import {
  CASH,
  SETTINGS_DEFAULTS,
  STOCK_TOKENS,
  instrumentClassOf,
  officialCoinByAddress,
  officialCoinsFor,
  type StockToken,
} from "@merrymen/core";
import type { Db } from "../../../../worker/src/db";
import { screenPools, type GeckoPool } from "../../../../worker/src/venues/geckoterminal";
import { readPoolEvidence, summarizeEvidence, type PoolEvidence } from "../../../../worker/src/venues/pool-evidence";
import { ACTIVITY_GATE } from "../../../../worker/src/venues/pons-activity";
import { tokenLabelSync } from "../../../../worker/src/token-label";
import { usdFixed } from "@/lib/format";
import { fetchMarket, type MarketData, type MarketToken } from "@/lib/market";
import { readCandles, type CandleRead, type CandleWindow } from "@/lib/read-candles";
import { sharedPools, sharedRead, type DiscoveryRow, type FreshRow, type Payload } from "@/lib/read-discoveries";

// ── readers ─────────────────────────────────────────────────────────────────

/** What sharedPools returns, narrowed to what this module reads. */
export interface PoolsSnapshot {
  /** Every pool the index returned, one per token (its busiest venue), unscreened. */
  byToken: ReadonlyMap<string, DiscoveryRow>;
  /** Feeds asked and answered on page one. None answering = the index was unreachable. */
  asked: number;
  reached: number;
  /** The walk was cut short, so the list is a prefix of the market. */
  truncated: boolean;
  /** Unix seconds the sweep started. */
  nowSec: number;
}

/**
 * The shared readers, injectable so tests never touch a network. Production
 * passes nothing and gets the dashboard's own memoised reads.
 */
export interface MarketReaders {
  pools(): Promise<PoolsSnapshot>;
  discoveries(): Promise<Payload>;
  stocks(): Promise<MarketData>;
  candles(poolId: string, token: string, window: CandleWindow): Promise<CandleRead>;
  evidence(poolId: string, token: string): Promise<PoolEvidence>;
}

/**
 * fetchMarket has no memo of its own (the /api/market route caches by HTTP),
 * and each call is two multicalls against a keyless RPC. Sixty seconds shared
 * by every caller; a failure is remembered for ten so an outage is not asked
 * again on every call, and it never replaces the last good read.
 */
const STOCKS_TTL_MS = 60_000;
const STOCKS_FAILED_TTL_MS = 10_000;
let stocksGood: { at: number; data: MarketData } | null = null;
let stocksFailedAt = 0;
let stocksInFlight: Promise<MarketData> | null = null;

function memoStocks(): Promise<MarketData> {
  const now = Date.now();
  if (stocksGood && now - stocksGood.at < STOCKS_TTL_MS) return Promise.resolve(stocksGood.data);
  if (now - stocksFailedAt < STOCKS_FAILED_TTL_MS) return Promise.reject(new Error("stock market read failed recently"));
  if (stocksInFlight) return stocksInFlight;
  stocksInFlight = fetchMarket()
    .then((data) => {
      stocksGood = { at: Date.now(), data };
      return data;
    }, (error: unknown) => {
      stocksFailedAt = Date.now();
      throw error;
    })
    .finally(() => {
      stocksInFlight = null;
    });
  return stocksInFlight;
}

export const sharedMarketReaders: MarketReaders = {
  pools: () => sharedPools(),
  discoveries: () => sharedRead(),
  stocks: () => memoStocks(),
  candles: (poolId, token, window) => readCandles(poolId, token, window),
  evidence: (poolId, token) => readPoolEvidence(poolId, token),
};

let readers: MarketReaders = sharedMarketReaders;
export function marketReaders(): MarketReaders {
  return readers;
}
export function setMarketReadersForTest(r: MarketReaders | null): void {
  readers = r ?? sharedMarketReaders;
}

// ── small shared facts ──────────────────────────────────────────────────────

export type Tri = "yes" | "no" | "unknown";
export interface Verdict {
  state: Tri;
  reasons: string[];
}

/** A caller-supplied argument this module refuses (the adapter maps it to its own error). */
export class MarketInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketInputError";
  }
}

/** A read the answer depends on entirely could not be made. */
export class MarketUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketUnavailableError";
  }
}

/**
 * A pool id as the index spells it: a 20-byte pool contract or a 32-byte v4/Pons
 * poolId. The same check readPoolEvidence applies (pool-evidence.ts), required
 * here BEFORE an id reaches readCandles, which puts it straight into a provider
 * URL that may carry the Pro key header.
 */
export const POOL_ID_RE = /^0x([0-9a-f]{40}|[0-9a-f]{64})$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const CUSTOM_SYMBOL_RE = /^[A-Za-z0-9._-]{1,16}$/;
const USDG = (CASH.USDG as string).toLowerCase();
const WETH = (CASH.WETH as string).toLowerCase();

export const INDEX_SOURCE = "GeckoTerminal (CoinGecko on-chain) index";
export const CHAINLINK_SOURCE = "Chainlink feed, read on chain";

const iso = (sec: number | null | undefined): string | null =>
  typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null;
const dollars = (v: number): string => usdFixed(v, 0);

/**
 * The dashboard's display screen. read-discoveries.ts keeps it as a private
 * `LIMITS` constant; these are the same three numbers, so "the dashboard shows
 * it" and "this says it clears the screen" cannot disagree.
 */
export const DISPLAY_SCREEN = { minReserveUsd: 25_000, minVolume24hUsd: 50_000, minBuyers24h: 100 } as const;

/**
 * The price-manipulation floors the worker applies before it trusts a pool
 * price (packages/core/src/settings.ts). An owner can change both; the
 * projection this server reads does not carry them, so these are the
 * defaults and every sentence built on them says so.
 */
export const PRICE_FLOORS = {
  minPoolLiquidityUsdg: SETTINGS_DEFAULTS.minPoolLiquidityUsdg,
  maxPriceDivergenceBps: SETTINGS_DEFAULTS.maxPriceDivergenceBps,
} as const;

// ── identity ────────────────────────────────────────────────────────────────

/** An owner-added token as the settings projection carries it. */
export interface OwnerToken {
  symbol: string;
  address: string;
}

/**
 * The owner's custom tokens as the worker would accept them: well-formed
 * (isValidCustomToken's symbol and address rules) and the first entry per
 * address, at most 50 (worker/src/settings.ts). Anything else never reaches
 * an agent, so it must not be described as the owner's token here either.
 */
export function ownerTokens(list: readonly OwnerToken[] | null | undefined): OwnerToken[] {
  const seen = new Set<string>();
  const out: OwnerToken[] = [];
  for (const t of list ?? []) {
    const address = String(t.address).toLowerCase();
    if (!CUSTOM_SYMBOL_RE.test(t.symbol) || !ADDRESS_RE.test(address) || seen.has(address)) continue;
    seen.add(address);
    out.push({ symbol: t.symbol, address });
    if (out.length >= 50) break;
  }
  return out;
}

export type TrustedSource = "cash" | "stock" | "official" | "custom";
export interface TrustedIdentity {
  symbol: string;
  name: string | null;
  source: TrustedSource;
}

/**
 * A name Merrymen or the owner vouches for: cash, a listed stock token, an
 * official coin, or one of the owner's own tokens. Reuses tokenLabelSync with
 * no database, which answers from exactly those local sources and nothing a
 * coin can say about itself.
 */
export function trustedIdentity(address: string, customTokens: readonly OwnerToken[]): TrustedIdentity | null {
  // tokenLabelSync reads only symbol and address; the decimals are a
  // placeholder its CustomToken type demands and nothing here uses.
  const custom = customTokens.map((t) => ({ symbol: t.symbol, address: t.address as `0x${string}`, decimals: 18 }));
  const label = tokenLabelSync(null, null, address, { customTokens: custom });
  if (!label.trusted || !label.ticker) return null;
  if (label.source !== "cash" && label.source !== "stock" && label.source !== "official" && label.source !== "custom") return null;
  return { symbol: label.ticker, name: label.name, source: label.source };
}

/**
 * worker/src/token-label.ts guardKey (not exported there): a ticker reduced to
 * letters and digits, so "$USDG", "usdg." and "t-sla" are still caught.
 */
export function guardKey(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Tickers an untrusted label may not borrow, and the addresses that own them:
 * the same set token-label.ts guards (USDG, WETH, ETH, the stock registry, the
 * owner's own tokens) plus official coins. A key can have several owners — an
 * owner may have added a coin under a registry ticker — so it maps to a set.
 */
export function trustedTickers(customTokens: readonly OwnerToken[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const put = (symbol: string, address: string) => {
    const k = guardKey(symbol);
    if (!k) return;
    const set = m.get(k) ?? new Set<string>();
    set.add(address.toLowerCase());
    m.set(k, set);
  };
  put("USDG", USDG);
  put("WETH", WETH);
  put("ETH", WETH);
  for (const t of STOCK_TOKENS) put(t.symbol, t.address);
  for (const c of officialCoinsFor(4663)) put(c.symbol, c.address);
  for (const t of customTokens) put(t.symbol, t.address);
  return m;
}

/** Does an UNTRUSTED symbol copy a trusted ticker that belongs to another address? */
export function impersonates(address: string, symbol: string | null, guard: Map<string, Set<string>>): boolean {
  if (!symbol) return false;
  const owners = guard.get(guardKey(symbol));
  return !!owners && !owners.has(address.toLowerCase());
}

/**
 * The index's pool label is "CHUMP / WETH 1%": the base token's ticker, as
 * whoever made the pool wrote it. It is the only symbol the index hands over,
 * so it is used — as an untrusted label, never as identity.
 */
export function poolSymbol(row: Pick<DiscoveryRow, "name">): string | null {
  const m = /^\s*(.+?)\s+\/\s+/.exec(row.name ?? "");
  const s = m?.[1]?.trim() ?? "";
  return s ? s.slice(0, 32) : null;
}

export type TokenKind = "stock" | "established" | "memecoin" | "unknown";
export type TokenFlag = "impersonates_trusted_ticker" | "duplicate_symbol";

/**
 * What kind of thing an address is. Listed stock tokens are "stock"; cash and
 * official coins "established"; anything else a source knows is what
 * instrumentClassOf calls it — "memecoin", its cautious arm. An address no
 * source knows is "unknown", which Merrymen still treats with memecoin rules.
 */
export function tokenKind(address: string, known: boolean): TokenKind {
  const a = address.toLowerCase();
  if (STOCK_TOKENS.some((t) => t.address.toLowerCase() === a)) return "stock";
  if (a === USDG || a === WETH || officialCoinByAddress(4663, a)) return "established";
  if (!known) return "unknown";
  return instrumentClassOf(a) === "equity-token" ? "stock" : "memecoin";
}

export function stockOf(address: string): StockToken | null {
  const a = address.toLowerCase();
  return STOCK_TOKENS.find((t) => t.address.toLowerCase() === a) ?? null;
}

// ── the index's facts about one token ───────────────────────────────────────

function asGeckoPool(row: DiscoveryRow): GeckoPool {
  return {
    poolId: row.poolId,
    poolAddress: null,
    tokenAddress: row.token as `0x${string}`,
    name: row.name,
    dex: row.dex,
    priceUsd: row.priceUsd,
    reserveUsd: row.reserveUsd,
    fdvUsd: row.fdvUsd,
    volume24hUsd: row.volume24hUsd,
    change24hPct: row.change24hPct,
    change1hPct: row.buckets.h1.changePct,
    buys24h: row.buckets.h24.buys,
    sells24h: row.buckets.h24.sells,
    buyers24h: row.buyers24h,
    buckets: row.buckets,
    createdAt: null,
  };
}

/** The dashboard's screen, run through the worker's own screenPools so the reasons are its words. */
export function screenRow(row: DiscoveryRow): { passed: boolean; reasons: string[] } {
  const { dropped } = screenPools([asGeckoPool(row)], DISPLAY_SCREEN);
  return { passed: dropped.length === 0, reasons: dropped.map((d) => d.why) };
}

export type IndexRead = "found" | "absent" | "unread";
export interface IndexState {
  /**
   * found  — the index answered and described this token.
   * absent — it answered and this token was not among what it returned.
   * unread — it could not be asked (read-token-market.ts draws the same line).
   */
  read: IndexRead;
  observed_at: string | null;
  truncated: boolean;
}

export function indexStateOf(pools: PoolsSnapshot | null, row: DiscoveryRow | null): IndexState {
  if (!pools || (pools.asked > 0 && pools.reached === 0)) return { read: "unread", observed_at: null, truncated: false };
  return { read: row ? "found" : "absent", observed_at: iso(pools.nowSec), truncated: pools.truncated };
}

export interface TokenFacts {
  address: string;
  identity: TrustedIdentity | null;
  stock: StockToken | null;
  row: DiscoveryRow | null;
  index: IndexState;
  /** Chainlink/contract/Blockscout facts, read only for a listed stock token and only when asked for. */
  stockMarket: { row: MarketToken | null; read: "found" | "unread" | "not_applicable"; fetched_at: string | null };
}

export async function readTokenFacts(
  address: string,
  o: { readers: MarketReaders; customTokens: readonly OwnerToken[]; stockMarket: boolean },
): Promise<TokenFacts> {
  const a = address.toLowerCase();
  const stock = stockOf(a);
  const pools = await o.readers.pools().catch(() => null);
  const row = pools?.byToken.get(a) ?? null;
  let stockMarket: TokenFacts["stockMarket"] = { row: null, read: "not_applicable", fetched_at: null };
  if (stock && o.stockMarket) {
    try {
      const m = await o.readers.stocks();
      const r = m.tokens.find((t) => t.address.toLowerCase() === a) ?? null;
      stockMarket = { row: r, read: r ? "found" : "unread", fetched_at: iso(m.fetchedAt) };
    } catch {
      stockMarket = { row: null, read: "unread", fetched_at: null };
    }
  }
  return { address: a, identity: trustedIdentity(a, o.customTokens), stock, row, index: indexStateOf(pools, row), stockMarket };
}

/**
 * The facts that need no market read: identity and registry membership only.
 * For an agent on another chain, where every market read here (the index, the
 * Chainlink/halt read) describes mainnet and would be the wrong chain's facts.
 */
export function localTokenFacts(address: string, customTokens: readonly OwnerToken[]): TokenFacts {
  const a = address.toLowerCase();
  return {
    address: a,
    identity: trustedIdentity(a, customTokens),
    stock: stockOf(a),
    row: null,
    index: { read: "unread", observed_at: null, truncated: false },
    stockMarket: { row: null, read: "not_applicable", fetched_at: null },
  };
}

/** Is it listed by something that finds tokens? A custom token is the owner's choice, not a discovery. */
export function discoverability(f: Pick<TokenFacts, "identity" | "row" | "index">): Verdict {
  if (f.identity && f.identity.source !== "custom") {
    return { state: "yes", reasons: [`Listed in Merrymen's curated registry (${f.identity.source === "stock" ? "Robinhood stock tokens" : f.identity.source === "cash" ? "cash tokens" : "official coins"}), so it is known without discovery.`] };
  }
  if (f.row) {
    const s = screenRow(f.row);
    return {
      state: "yes",
      reasons: [
        "Among the pools the market index returned from its trending, new and top-pool feeds.",
        s.passed
          ? `It clears the dashboard's display screen (${dollars(DISPLAY_SCREEN.minReserveUsd)} reserve, ${dollars(DISPLAY_SCREEN.minVolume24hUsd)} 24h volume, ${DISPLAY_SCREEN.minBuyers24h} distinct buyers).`
          : `It does not clear the dashboard's display screen: ${s.reasons.join("; ")}.`,
      ],
    };
  }
  if (f.index.read === "unread") return { state: "unknown", reasons: ["The market index could not be read just now, so whether discovery lists it is unknown."] };
  return {
    state: "no",
    reasons: ["Not among the pools the market index returned. Those come from the first pages of three feeds, roughly the top of the chain, so this is not proof the index has never seen it."],
  };
}

/**
 * Would Merrymen trust a price for it? Mirrors the worker's rules: a Chainlink
 * feed for a stock token; for anything else a pool deep enough and close
 * enough to its time-averaged price (pool-price.ts), where a bonding-curve
 * price is good enough to value a holding and never enough to authorise a buy
 * (tokens.ts PriceQuote.source). What the index says can only ever rule a
 * pool OUT — the worker's on-chain depth and divergence reads cannot run here.
 */
export function priceability(f: Pick<TokenFacts, "address" | "stock" | "row" | "index">): Verdict {
  const a = f.address.toLowerCase();
  if (a === USDG) return { state: "yes", reasons: ["USDG is the agents' cash token, valued at one dollar."] };
  if (a === WETH) return { state: "yes", reasons: ["WETH is priced from the Chainlink ETH/USD feed."] };
  if (f.stock) {
    return f.stock.chainlinkFeed
      ? { state: "yes", reasons: ["Priced from its Chainlink feed. The feed follows the underlying market (24/5), so weekend prices are stale by design."] }
      : { state: "no", reasons: ["No Chainlink feed is published for this stock token yet, so Merrymen cannot price it."] };
  }
  const floor = dollars(PRICE_FLOORS.minPoolLiquidityUsdg);
  const floorNote = "(the default; an owner can change it)";
  if (!f.row) {
    return f.index.read === "unread"
      ? { state: "unknown", reasons: ["The market index could not be read, and an agent reads pool depth on chain only when it trades."] }
      : { state: "unknown", reasons: ["The market index does not list a pool for it; an agent reads pool depth on chain only when it trades."] };
  }
  if (f.row.onCurve) {
    return {
      state: "no",
      reasons: ["It is still on a Pons bonding curve. A curve price has no oracle and no divergence check, so Merrymen uses it to value a holding but never to authorise a buy; buying it needs scout mode with a budget, or the class route."],
    };
  }
  if (f.row.reserveUsd === null) {
    return { state: "unknown", reasons: ["The index reports no reserve figure for its pool, so the depth floor cannot be checked from here."] };
  }
  if (f.row.reserveUsd < PRICE_FLOORS.minPoolLiquidityUsdg) {
    return {
      state: "no",
      reasons: [`The index reports ${dollars(f.row.reserveUsd)} of reserve, under the ${floor} depth floor ${floorNote} an agent requires before it trusts a pool price; a pool that thin can be pushed for pocket change.`],
    };
  }
  return {
    state: "unknown",
    reasons: [
      `The index reports ${dollars(f.row.reserveUsd)} of reserve, above the ${floor} floor ${floorNote}.`,
      `An agent still reads route depth on chain and refuses a price more than ${(PRICE_FLOORS.maxPriceDivergenceBps / 100).toFixed(2)}% from the pool's time-averaged price; neither check can run from here.`,
    ],
  };
}

// ── one token, for display ──────────────────────────────────────────────────

export interface FactOf<T> {
  value: T | null;
  source: string | null;
  missing_reason: string | null;
}
const have = <T>(value: T | null | undefined, source: string, missing: string): FactOf<T> =>
  value === null || value === undefined ? { value: null, source: null, missing_reason: missing } : { value, source, missing_reason: null };

export interface TokenView {
  address: string;
  chain_id: 4663;
  kind: TokenKind;
  stock_kind: "stock" | "etf" | null;
  /** Raw: trusted when symbol_trusted, otherwise the pool's own label. */
  symbol: string | null;
  symbol_trusted: boolean;
  name: string | null;
  name_trusted: boolean;
  flags: TokenFlag[];
  index: IndexState;
  price: FactOf<number> & { observed_at: string | null; updated_at: string | null };
  liquidity_usd: FactOf<number> & { on_curve: boolean | null; note: string | null };
  volume_24h_usd: FactOf<number>;
  holders: FactOf<number>;
  fdv_usd: FactOf<number>;
  change_24h_pct: FactOf<number>;
  buyers_24h: FactOf<number>;
  age_days: FactOf<number>;
  tape: Array<{ window: string; change_pct: number | null; volume_usd: number | null; buys: number | null; sells: number | null; buyers: number | null; sellers: number | null }>;
  /** Raw pool label; attacker-chosen. */
  pool: { pool_id: string; venue: string; on_curve: boolean; graduated: boolean; label: string; note: string } | null;
  stock: { has_feed: boolean; paused: boolean | null; ui_multiplier: number | null; rialto_liquid: boolean | null; read: "found" | "unread" } | null;
  discoverable: Verdict;
  priceable: Verdict;
  warnings: string[];
}

export function tokenView(f: TokenFacts, customTokens: readonly OwnerToken[]): TokenView {
  const known = !!(f.identity || f.row || f.stock);
  const kind = tokenKind(f.address, known);
  const indexedSymbol = f.row ? poolSymbol(f.row) : null;
  const symbol = f.identity?.symbol ?? indexedSymbol;
  const symbolTrusted = !!f.identity;
  const flags: TokenFlag[] = [];
  if (!symbolTrusted && impersonates(f.address, symbol, trustedTickers(customTokens))) flags.push("impersonates_trusted_ticker");
  const warnings: string[] = [];
  if (flags.includes("impersonates_trusted_ticker")) {
    warnings.push(`This token's label copies the trusted ticker ${symbol ? guardKey(symbol) : ""} but it is a different address. It is not that asset.`);
  }
  const unread = f.index.read === "unread" ? "The market index could not be read just now." : null;
  const notIndexed = unread ?? (f.stock ? "The index lists no pool for this stock token; its price comes from Chainlink." : "The market index does not list a pool for this token.");

  let price: TokenView["price"];
  const sm = f.stockMarket.row;
  if (f.stock) {
    if (!f.stock.chainlinkFeed) price = { value: null, source: null, missing_reason: "No Chainlink feed is published for this stock token yet.", observed_at: null, updated_at: null };
    else if (sm?.priceUsd !== null && sm?.priceUsd !== undefined) price = { value: sm.priceUsd, source: CHAINLINK_SOURCE, missing_reason: null, observed_at: f.stockMarket.fetched_at, updated_at: iso(sm.priceUpdatedAt) };
    else price = { value: null, source: null, missing_reason: f.stockMarket.read === "unread" ? "The Chainlink feed could not be read just now." : "The Chainlink read returned no price.", observed_at: f.stockMarket.fetched_at, updated_at: null };
  } else if (f.row && f.row.priceUsd !== null) {
    price = { value: f.row.priceUsd, source: INDEX_SOURCE, missing_reason: null, observed_at: f.index.observed_at, updated_at: null };
  } else {
    price = { value: null, source: null, missing_reason: f.row ? "The index reports no price for its pool." : notIndexed, observed_at: f.index.observed_at, updated_at: null };
  }
  if (!f.stock && price.value !== null) warnings.push("The price is the index's claim about the pool; an agent reads its own price on chain before it trades.");

  const liquidity: TokenView["liquidity_usd"] = f.row
    ? {
      ...have(f.row.reserveUsd, INDEX_SOURCE, "The index reports no reserve figure."),
      on_curve: f.row.onCurve,
      note: f.row.onCurve ? "On a bonding curve this is mostly a virtual seed, not money anyone can sell into." : "Total value in the pool as the index reports it; not a depth you can trade against.",
    }
    : { value: null, source: null, missing_reason: notIndexed, on_curve: null, note: null };

  const volume = f.stock
    ? have(sm?.volume24hUsd ?? null, "Blockscout", f.stockMarket.read === "unread" ? "The stock market read failed." : "Blockscout did not report 24h volume (it often refuses server requests).")
    : f.row ? have(f.row.volume24hUsd, INDEX_SOURCE, "The index reports no 24h volume.") : { value: null, source: null, missing_reason: notIndexed };
  const holders = f.stock
    ? have(sm?.holders ?? null, "Blockscout", f.stockMarket.read === "unread" ? "The stock market read failed." : "Blockscout did not report a holder count.")
    : { value: null, source: null, missing_reason: "No holder-count source is wired for coins on this server." };
  const fromRow = <K extends "fdvUsd" | "change24hPct" | "buyers24h" | "ageDays">(k: K, missing: string): FactOf<number> =>
    f.row ? have<number>(f.row[k], INDEX_SOURCE, missing) : { value: null, source: null, missing_reason: notIndexed };

  return {
    address: f.address,
    chain_id: 4663,
    kind,
    stock_kind: f.stock ? (f.stock.kind === "etf" ? "etf" : "stock") : null,
    symbol,
    symbol_trusted: symbolTrusted,
    name: f.identity ? (f.identity.name ?? f.identity.symbol) : null,
    name_trusted: !!f.identity,
    flags,
    index: f.index,
    price,
    liquidity_usd: liquidity,
    volume_24h_usd: volume,
    holders,
    fdv_usd: fromRow("fdvUsd", "The index reports no fully diluted value."),
    change_24h_pct: fromRow("change24hPct", "The index reports no 24h change."),
    buyers_24h: fromRow("buyers24h", "The index reports no buyer count."),
    age_days: fromRow("ageDays", "The index reports no pool creation time."),
    tape: f.row
      ? (["m5", "h1", "h6", "h24"] as const).map((w) => ({
        window: w,
        change_pct: f.row!.buckets[w].changePct,
        volume_usd: f.row!.buckets[w].volumeUsd,
        buys: f.row!.buckets[w].buys,
        sells: f.row!.buckets[w].sells,
        buyers: f.row!.buckets[w].buyers,
        sellers: f.row!.buckets[w].sellers,
      }))
      : [],
    pool: f.row
      ? {
        pool_id: f.row.poolId,
        venue: f.row.dex,
        on_curve: f.row.onCurve,
        graduated: f.row.graduated,
        label: f.row.name,
        note: "The index keeps this token's busiest pool only; other pools are not listed.",
      }
      : null,
    stock: f.stock
      ? { has_feed: !!f.stock.chainlinkFeed, paused: sm?.paused ?? null, ui_multiplier: sm?.uiMultiplier ?? null, rialto_liquid: sm?.rialtoLiquid ?? null, read: f.stockMarket.read === "found" ? "found" : "unread" }
      : null,
    discoverable: discoverability(f),
    priceable: priceability(f),
    warnings,
  };
}

// ── search ──────────────────────────────────────────────────────────────────

export type SearchSource = "registry" | "discovery" | "custom_token" | "watchlist";
export type MatchedOn = "address" | "symbol" | "name" | "watchlist_label";

interface Candidate {
  address: string;
  symbol: string | null;
  symbolTrusted: boolean;
  name: string | null;
  nameTrusted: boolean;
  sources: Set<SearchSource>;
  row: DiscoveryRow | null;
  label: string | null;
}

export interface SearchHit {
  address: string;
  chain_id: 4663;
  symbol: string | null;
  symbol_trusted: boolean;
  name: string | null;
  name_trusted: boolean;
  kind: TokenKind;
  sources: SearchSource[];
  matched_on: MatchedOn;
  flags: TokenFlag[];
  /** The owner's own watchlist label, when the token is on it. */
  watchlist_label: string | null;
  price_usd: number | null;
  reserve_usd: number | null;
  volume_24h_usd: number | null;
  discoverable: Verdict;
  priceable: Verdict;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  next_offset: number | null;
  symbol_groups: Array<{ symbol_key: string; addresses: string[]; trusted_addresses: string[]; duplicate: boolean }>;
  /** Whether the market index answered; when it did not, only local sources were searched. */
  index: { reachable: boolean; observed_at: string | null; truncated: boolean };
}

const WATCHLIST_SEARCH_SQL = "SELECT token, label FROM mcp_watchlist WHERE tenant = ? AND chain_id = 4663 ORDER BY created_at DESC, token ASC LIMIT 100";

/**
 * Search the tokens this caller can see: the curated registry, the index's
 * pools, and the caller's own custom tokens and watchlist. `db` holds the
 * watchlist; `tenant` scopes it. Nothing per-owner is kept after the call.
 *
 * The caller decides what private sources the connection may see: pass no
 * custom tokens and `includeWatchlist: false` for a connection holding only
 * the public market scope.
 */
export async function searchTokens(db: Db, o: {
  tenant: string;
  query: string;
  customTokens: readonly OwnerToken[];
  includeWatchlist: boolean;
  readers: MarketReaders;
  offset: number;
  limit: number;
}): Promise<SearchResult> {
  const cands = new Map<string, Candidate>();
  const get = (address: string): Candidate => {
    const a = address.toLowerCase();
    let c = cands.get(a);
    if (!c) {
      c = { address: a, symbol: null, symbolTrusted: false, name: null, nameTrusted: false, sources: new Set(), row: null, label: null };
      cands.set(a, c);
    }
    return c;
  };
  const trust = (c: Candidate, symbol: string, name: string | null) => {
    c.symbol = symbol;
    c.symbolTrusted = true;
    if (name) {
      c.name = name;
      c.nameTrusted = true;
    }
  };

  for (const t of STOCK_TOKENS) {
    const c = get(t.address);
    c.sources.add("registry");
    trust(c, t.symbol, t.name);
  }
  for (const [address, symbol, name] of [[USDG, "USDG", "Global Dollar (USDG)"], [WETH, "WETH", "Wrapped Ether"]] as const) {
    const c = get(address);
    c.sources.add("registry");
    trust(c, symbol, name);
  }
  for (const coin of officialCoinsFor(4663)) {
    const c = get(coin.address);
    c.sources.add("registry");
    trust(c, coin.symbol, coin.name);
  }
  for (const t of o.customTokens) {
    const c = get(t.address);
    c.sources.add("custom_token");
    if (!c.symbolTrusted) trust(c, t.symbol, null);
  }
  const watched = o.includeWatchlist
    ? await db.prepare(WATCHLIST_SEARCH_SQL).all(o.tenant.toLowerCase()) as Array<{ token: string; label: string | null }>
    : [];
  for (const w of watched) {
    if (!ADDRESS_RE.test(String(w.token).toLowerCase())) continue;
    const c = get(w.token);
    c.sources.add("watchlist");
    c.label = w.label;
    // No symbol is taken from the row: trust is re-derived from what vouches
    // for the address NOW (the registry and custom-token loops above), so a
    // ticker the owner has since removed is not still presented as trusted.
  }

  const pools = await o.readers.pools().catch(() => null);
  const reachable = indexStateOf(pools, null).read !== "unread";
  for (const row of pools?.byToken.values() ?? []) {
    if (!ADDRESS_RE.test(row.token.toLowerCase())) continue;
    const c = get(row.token);
    c.sources.add("discovery");
    c.row = row;
    if (!c.symbolTrusted) c.symbol = poolSymbol(row);
    if (!c.nameTrusted) c.name = row.name || null;
  }

  // ── match ──
  const q = o.query.trim();
  const ranked: Array<{ c: Candidate; tier: number; on: MatchedOn }> = [];
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    const c = cands.get(q.toLowerCase());
    if (c) ranked.push({ c, tier: 0, on: "address" });
  } else {
    // A leading $ is how people write tickers and is never part of one; what is
    // left must not be empty, or it would match everything (snipe-target.ts).
    const bare = q.replace(/^\$+/, "").trim().toLowerCase();
    const key = guardKey(bare);
    if (bare) {
      for (const c of cands.values()) {
        const sym = (c.symbol ?? "").toLowerCase();
        const name = (c.name ?? "").toLowerCase();
        const label = (c.label ?? "").toLowerCase();
        if (sym && (sym === bare || (key && guardKey(sym) === key))) ranked.push({ c, tier: 0, on: "symbol" });
        else if (sym && sym.includes(bare)) ranked.push({ c, tier: 1, on: "symbol" });
        else if (name && name.includes(bare)) ranked.push({ c, tier: 2, on: "name" });
        else if (label && label.includes(bare)) ranked.push({ c, tier: 3, on: "watchlist_label" });
      }
    }
  }
  ranked.sort((x, y) =>
    x.tier - y.tier
    || Number(y.c.symbolTrusted) - Number(x.c.symbolTrusted)
    || (y.c.row?.volume24hUsd ?? -1) - (x.c.row?.volume24hUsd ?? -1)
    || (x.c.address < y.c.address ? -1 : 1));

  // Duplicates are judged against EVERYTHING this caller can see, not just the
  // matches: a coin sharing its ticker with an address outside this page is
  // still ambiguous.
  const groups = new Map<string, Set<string>>();
  for (const c of cands.values()) {
    const k = c.symbol ? guardKey(c.symbol) : "";
    if (!k) continue;
    const set = groups.get(k) ?? new Set<string>();
    set.add(c.address);
    groups.set(k, set);
  }
  const guard = trustedTickers(o.customTokens);

  const hitOf = (c: Candidate, on: MatchedOn): SearchHit => {
    const flags: TokenFlag[] = [];
    if (!c.symbolTrusted && impersonates(c.address, c.symbol, guard)) flags.push("impersonates_trusted_ticker");
    if (c.symbol && (groups.get(guardKey(c.symbol))?.size ?? 0) > 1) flags.push("duplicate_symbol");
    const stock = stockOf(c.address);
    const facts = { address: c.address, identity: trustedIdentity(c.address, o.customTokens), stock, row: c.row, index: indexStateOf(pools, c.row) };
    return {
      address: c.address,
      chain_id: 4663,
      symbol: c.symbol,
      symbol_trusted: c.symbolTrusted,
      name: c.name,
      name_trusted: c.nameTrusted,
      // Known only when a source describes it; a watchlist entry alone is the
      // owner's note about an address, not a fact about it (as get_token says).
      kind: tokenKind(c.address, !!(c.row || c.symbolTrusted)),
      sources: [...c.sources].sort(),
      matched_on: on,
      flags,
      watchlist_label: c.label,
      price_usd: c.row?.priceUsd ?? null,
      reserve_usd: c.row?.reserveUsd ?? null,
      volume_24h_usd: c.row?.volume24hUsd ?? null,
      discoverable: discoverability(facts),
      priceable: priceability(facts),
    };
  };

  const page = ranked.slice(o.offset, o.offset + o.limit);
  const hits = page.map(({ c, on }) => hitOf(c, on));
  const keys = new Set(ranked.map(({ c }) => (c.symbol ? guardKey(c.symbol) : "")).filter(Boolean));
  const symbol_groups = [...keys].slice(0, 20).map((k) => {
    const addresses = [...(groups.get(k) ?? [])].sort().slice(0, 20);
    return {
      symbol_key: k,
      addresses,
      trusted_addresses: [...(guard.get(k) ?? [])].sort(),
      duplicate: (groups.get(k)?.size ?? 0) > 1,
    };
  });
  return {
    hits,
    total: ranked.length,
    next_offset: o.offset + o.limit < ranked.length ? o.offset + o.limit : null,
    symbol_groups,
    index: { reachable, observed_at: reachable && pools ? iso(pools.nowSec) : null, truncated: reachable && !!pools?.truncated },
  };
}

// ── candles and pool flow ───────────────────────────────────────────────────

export type PoolSource = "argument" | "discovery";

/**
 * The pool to ask about: the caller's id after the format check, or the one the
 * index listed for this token. A caller-supplied id is only ever a name the
 * provider looks up; the reader then checks the bars' base token against
 * `token` and refuses a series about the other side of the pair.
 *
 * `listedOnly` pins a caller's id to the pool the index lists for the token.
 * readCandles caches by pool and window, NOT by token, and that cache is the
 * one the public token pages read (/api/tokens/[address] asks for exactly the
 * listed pool of the token in its URL, with no base check on a cache hit). A
 * caller asking for another token's listed pool with the OTHER side of its pair
 * would get a verified series about that side — which is then cached under the
 * pool and served to every viewer of the first token's page as its chart. So
 * for candles the only (pool, token) pair ever read is the one the dashboard
 * itself reads. Pool evidence is cached per pool AND token, so it needs no pin.
 */
async function resolvePool(address: string, poolId: string | undefined, r: MarketReaders, listedOnly = false): Promise<
  { poolId: string; source: PoolSource } | { poolId: null; state: "no_pool" | "index_unreachable" }
> {
  let id: string | null = null;
  if (poolId !== undefined) {
    id = poolId.toLowerCase();
    if (!POOL_ID_RE.test(id)) throw new MarketInputError("pool_id must be a 0x-prefixed 20-byte pool address or 32-byte pool id");
    if (!listedOnly) return { poolId: id, source: "argument" };
  }
  const pools = await r.pools().catch(() => null);
  if (!pools || (pools.asked > 0 && pools.reached === 0)) return { poolId: null, state: "index_unreachable" };
  const row = pools.byToken.get(address.toLowerCase());
  const listed = row && POOL_ID_RE.test(row.poolId.toLowerCase()) ? row.poolId.toLowerCase() : null;
  if (id !== null && id !== listed) {
    throw new MarketInputError(listed
      ? "pool_id is not the pool the index lists for this token; omit it to use that pool (see get_token pool.pool_id)."
      : "The index lists no pool for this token, so no pool_id can be charted for it.");
  }
  if (!listed) return { poolId: null, state: "no_pool" };
  return { poolId: listed, source: id !== null ? "argument" : "discovery" };
}

const CANDLE_CACHE_S: Record<CandleWindow, number> = { "15m": 120, "1h": 300, "4h": 900, "1d": 1800 };

export interface CandleView {
  address: string;
  pool_id: string | null;
  pool_source: PoolSource | null;
  window: CandleWindow;
  state: "ok" | "none" | "mismatch" | "refused" | "no_pool" | "index_unreachable";
  reason: string | null;
  interval_s: number | null;
  bars: Array<{ time: string; open: number; high: number; low: number; close: number; volume_display_only: number }>;
  gaps: number | null;
  last_bar_partial: boolean | null;
  last_bar_age_s: number | null;
  stale: boolean;
  /** Raw, from the index. */
  quote_symbol: string | null;
  source: string;
  max_cache_age_s: number;
}

export async function candlesFor(o: { address: string; poolId?: string; window: CandleWindow; readers: MarketReaders }): Promise<CandleView> {
  const address = o.address.toLowerCase();
  const pool = await resolvePool(address, o.poolId, o.readers, true);
  const base = {
    address,
    window: o.window,
    source: `${INDEX_SOURCE}, OHLCV in USD`,
    max_cache_age_s: CANDLE_CACHE_S[o.window],
  };
  if (pool.poolId === null) {
    return {
      ...base, pool_id: null, pool_source: null, state: pool.state,
      reason: pool.state === "no_pool" ? "The index lists no pool for this token, so there is no chart for it here." : "The market index could not be read just now.",
      interval_s: null, bars: [], gaps: null, last_bar_partial: null, last_bar_age_s: null, stale: false, quote_symbol: null,
    };
  }
  let read = await o.readers.candles(pool.poolId, address, o.window);
  // readCandles caches by pool and window, not by token: its base check ran
  // against whichever token first asked. The pool is pinned to this token's
  // listed pool above, so that is the dashboard's own pair; the base is still
  // checked again here, failing closed, in case anything else fed that cache.
  if (read.state === "ok" && (read.base ?? "") !== address) {
    read = { ...read, state: "mismatch", candles: [], gaps: 0, lastBarAgeSec: null, stale: false };
  }
  const bars = read.candles.slice(-300).map((c) => ({ time: new Date(c.t * 1000).toISOString(), open: c.o, high: c.h, low: c.l, close: c.c, volume_display_only: c.v }));
  return {
    ...base,
    pool_id: pool.poolId,
    pool_source: pool.source,
    state: read.state,
    reason: read.state === "refused" ? (read.reason ?? "unreachable")
      : read.state === "mismatch" ? "The pool's bars describe the other token in the pair, so they are not this token's price."
        : read.state === "none" ? "The index has no bars for this pool in that window." : null,
    interval_s: read.interval || null,
    bars,
    gaps: read.state === "ok" ? read.gaps : null,
    // The newest bar is always still forming (read-candles.ts lastBarAgeSec).
    last_bar_partial: read.state === "ok" && read.lastBarAgeSec !== null && read.interval > 0 ? read.lastBarAgeSec < read.interval : null,
    last_bar_age_s: read.lastBarAgeSec,
    stale: read.stale === true,
    quote_symbol: read.quoteSymbol,
  };
}

export interface ActivityView {
  address: string;
  pool_id: string | null;
  pool_source: PoolSource | null;
  state: "ok" | "no_pool" | "index_unreachable";
  source: string;
  candle_leg: { observed_at: string | null; failure: string | null };
  trade_leg: { observed_at: string | null; failure: string | null };
  completed_five_minute_bars: number | null;
  contiguous: boolean | null;
  window_start: string | null;
  window_end: string | null;
  measured_return_pct: number | null;
  five_minute_volatility_pct: number | null;
  latest_five_minute_return_pct: number | null;
  sampled_trades_5m: number | null;
  sampled_buy_usd_5m: number | null;
  sampled_sell_usd_5m: number | null;
  sampled_buy_share_pct_5m: number | null;
  recent_trades: Array<{ tx: string; time: string; side: "buy" | "sell"; usd: number | null; price_usd: number | null }>;
  caveat: string;
}

const msIso = (ms: number | null | undefined): string | null => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);

/**
 * Buy/sell flow for one pool: readPoolEvidence + summarizeEvidence, the same
 * reader and the same summary the worker's reviews use, so a figure here means
 * what it means there — including null (not zero) for a leg that did not land.
 */
export async function poolActivity(o: { address: string; poolId?: string; readers: MarketReaders; nowMs: number }): Promise<ActivityView> {
  const address = o.address.toLowerCase();
  const pool = await resolvePool(address, o.poolId, o.readers);
  const empty = {
    candle_leg: { observed_at: null, failure: null }, trade_leg: { observed_at: null, failure: null },
    completed_five_minute_bars: null, contiguous: null, window_start: null, window_end: null, measured_return_pct: null,
    five_minute_volatility_pct: null, latest_five_minute_return_pct: null, sampled_trades_5m: null, sampled_buy_usd_5m: null,
    sampled_sell_usd_5m: null, sampled_buy_share_pct_5m: null, recent_trades: [],
  };
  const source = `${INDEX_SOURCE}, indexed pool trades and 5-minute bars`;
  if (pool.poolId === null) {
    return { address, pool_id: null, pool_source: null, state: pool.state, source, ...empty, caveat: pool.state === "no_pool" ? "The index lists no pool for this token; pass pool_id if you know it." : "The market index could not be read just now." };
  }
  const e = await o.readers.evidence(pool.poolId, address);
  const s = summarizeEvidence(e, o.nowMs);
  return {
    address,
    pool_id: pool.poolId,
    pool_source: pool.source,
    state: "ok",
    source,
    candle_leg: { observed_at: msIso(s.candleObservedAt), failure: s.candleFailure },
    trade_leg: { observed_at: msIso(s.tradeObservedAt), failure: s.tradeFailure },
    completed_five_minute_bars: s.completedFiveMinuteBars,
    contiguous: s.contiguous,
    window_start: iso(s.start),
    window_end: iso(s.end),
    measured_return_pct: s.measuredReturnPct,
    five_minute_volatility_pct: s.fiveMinuteLogReturnStdDevPct,
    latest_five_minute_return_pct: s.latestFiveMinuteReturnPct,
    sampled_trades_5m: s.sampledTrades5m,
    sampled_buy_usd_5m: s.sampledBuyUsd5m,
    sampled_sell_usd_5m: s.sampledSellUsd5m,
    sampled_buy_share_pct_5m: s.sampledBuySharePct5m,
    recent_trades: e.trades.failed ? [] : e.trades.data.slice(0, 25).map((t) => ({
      tx: t.tx, time: new Date(t.time * 1000).toISOString(), side: t.side, usd: t.usd, price_usd: t.priceUsd,
    })),
    caveat: s.caveat,
  };
}

// ── discovery lists ─────────────────────────────────────────────────────────

export type DiscoverList = "trending" | "new" | "high_volume" | "established";

export type DiscoverItem =
  | {
    origin: "index_pool";
    address: string;
    /** Raw pool-label ticker and label. */
    symbol: string | null;
    name: string;
    kind: TokenKind;
    venue: string;
    pool_id: string;
    on_curve: boolean;
    graduated: boolean;
    price_usd: number | null;
    reserve_usd: number | null;
    fdv_usd: number | null;
    volume_24h_usd: number | null;
    change_24h_pct: number | null;
    buyers_24h: number | null;
    age_days: number | null;
    buyers_1h: number | null;
    volume_1h_usd: number | null;
    screen: { passed: boolean; reasons: string[] };
    /** The display scout's line, model-written. Null when it passed or could not look. */
    scout_verdict: { conviction: number; reason: string } | null;
    flags: TokenFlag[];
    caveats: string[];
  }
  | {
    origin: "launchpad";
    address: string;
    /** Raw, from the token contract. */
    symbol: string | null;
    name: string | null;
    kind: TokenKind;
    curve: string;
    trades: number;
    traders: number;
    age_s: number | null;
    progress_bps: number | null;
    /** Raw launcher text. */
    description: string | null;
    published_socials: boolean | null;
    flags: TokenFlag[];
    caveats: string[];
  }
  | {
    origin: "registry";
    address: string;
    symbol: string;
    name: string;
    kind: TokenKind;
    stock_kind: "stock" | "etf";
    price_usd: number | null;
    price_source: string | null;
    price_missing_reason: string | null;
    price_updated_at: string | null;
    paused: boolean | null;
    volume_24h_usd: number | null;
    holders: number | null;
    flags: TokenFlag[];
    caveats: string[];
  };

export interface DiscoverView {
  list: DiscoverList;
  ranking: string;
  items: DiscoverItem[];
  total: number;
  next_offset: number | null;
  observed_at: string | null;
  truncated: boolean | null;
  degraded: boolean | null;
  scout_verdicts: "present_where_given" | "no-model" | "model-failed" | "not_applicable";
  caveats: string[];
}

const INDEX_CAVEAT = "These are the index's claims about the market, used to decide what is worth looking at. Nothing here was checked against the chain, and none of it is a recommendation or a permission to trade.";

function flagDuplicates(items: DiscoverItem[], customTokens: readonly OwnerToken[]): void {
  const guard = trustedTickers(customTokens);
  const groups = new Map<string, Set<string>>();
  for (const it of items) {
    const k = it.symbol ? guardKey(it.symbol) : "";
    if (!k) continue;
    groups.set(k, (groups.get(k) ?? new Set()).add(it.address));
  }
  for (const it of items) {
    if (it.origin !== "registry" && impersonates(it.address, it.symbol, guard)) it.flags.push("impersonates_trusted_ticker");
    if (it.symbol && (groups.get(guardKey(it.symbol))?.size ?? 0) > 1) it.flags.push("duplicate_symbol");
  }
}

function poolItem(r: DiscoveryRow): DiscoverItem {
  const caveats = [INDEX_CAVEAT];
  if (r.onCurve) caveats.push("Still on its bonding curve: the reserve is mostly a virtual seed, not money anyone can sell into.");
  return {
    origin: "index_pool",
    address: r.token.toLowerCase(),
    symbol: poolSymbol(r),
    name: r.name,
    kind: tokenKind(r.token, true),
    venue: r.dex,
    pool_id: r.poolId,
    on_curve: r.onCurve,
    graduated: r.graduated,
    price_usd: r.priceUsd,
    reserve_usd: r.reserveUsd,
    fdv_usd: r.fdvUsd,
    volume_24h_usd: r.volume24hUsd,
    change_24h_pct: r.change24hPct,
    buyers_24h: r.buyers24h,
    age_days: r.ageDays,
    buyers_1h: r.buckets.h1.buyers,
    volume_1h_usd: r.buckets.h1.volumeUsd,
    screen: screenRow(r),
    scout_verdict: r.verdict ? { conviction: r.verdict.conviction, reason: r.verdict.reason } : null,
    flags: [],
    caveats,
  };
}

function launchItem(r: FreshRow, metaRead: boolean): DiscoverItem {
  return {
    origin: "launchpad",
    address: r.token.toLowerCase(),
    symbol: r.symbol || null,
    name: r.name || null,
    kind: tokenKind(r.token, true),
    curve: r.curve.toLowerCase(),
    trades: r.trades,
    traders: r.traders,
    age_s: r.ageSec,
    progress_bps: r.progressBps,
    description: r.description || null,
    // Only a successful metadata read can say "none"; an unread coin's blank
    // socials are unknown, not absent (read-discoveries.ts on `bare`).
    published_socials: r.twitter || r.telegram || r.website ? true : metaRead ? false : null,
    flags: [],
    caveats: [
      "A launch from the last ~15 minutes on its bonding curve. It has no pool price Merrymen trusts; buying it needs scout mode with a budget or the class route.",
      "The name, symbol and description are the launcher's own claims.",
    ],
  };
}

/**
 * The four lists, each from the dashboard's own shared payload. `trending` and
 * `high_volume` are the SCREENED pools (the display floor), in the coins
 * panel's order and by 24h volume respectively; `new` is the launchpad funnel;
 * `established` is the curated stock-token registry with its Chainlink reads.
 */
export async function discoverTokens(o: { list: DiscoverList; readers: MarketReaders; customTokens: readonly OwnerToken[]; offset: number; limit: number }): Promise<DiscoverView> {
  let items: DiscoverItem[];
  let ranking: string;
  let observedAt: string | null = null;
  let truncated: boolean | null = null;
  let degraded: boolean | null = null;
  let scout: DiscoverView["scout_verdicts"] = "not_applicable";
  const caveats: string[] = [];

  if (o.list === "established") {
    let market: MarketData;
    try {
      market = await o.readers.stocks();
    } catch {
      throw new MarketUnavailableError("The stock-token market read failed; retry shortly.");
    }
    observedAt = iso(market.fetchedAt);
    const byAddress = new Map(market.tokens.map((t) => [t.address.toLowerCase(), t]));
    ranking = "The curated stock-token registry, by 24h volume where Blockscout reported one (unknown volume last).";
    items = [...STOCK_TOKENS]
      .map((t) => ({ t, m: byAddress.get(t.address.toLowerCase()) ?? null }))
      .sort((x, y) => (y.m?.volume24hUsd ?? -1) - (x.m?.volume24hUsd ?? -1) || x.t.symbol.localeCompare(y.t.symbol))
      .map(({ t, m }): DiscoverItem => ({
        origin: "registry",
        address: t.address.toLowerCase(),
        symbol: t.symbol,
        name: t.name,
        kind: "stock",
        stock_kind: t.kind === "etf" ? "etf" : "stock",
        price_usd: m?.priceUsd ?? null,
        price_source: m?.priceUsd !== null && m?.priceUsd !== undefined ? CHAINLINK_SOURCE : null,
        price_missing_reason: m?.priceUsd !== null && m?.priceUsd !== undefined ? null : !t.chainlinkFeed ? "No Chainlink feed is published for this stock token yet." : "The Chainlink feed could not be read just now.",
        price_updated_at: iso(m?.priceUpdatedAt ?? null),
        paused: m?.paused ?? null,
        volume_24h_usd: m?.volume24hUsd ?? null,
        holders: m?.holders ?? null,
        flags: [],
        caveats: ["Issuer-backed stock token. The Chainlink feed follows the underlying market (24/5), so weekend prices are stale by design."],
      }));
  } else {
    let payload: Payload;
    try {
      payload = await o.readers.discoveries();
    } catch {
      throw new MarketUnavailableError("The discovery read failed; retry shortly.");
    }
    observedAt = iso(payload.fetchedAt);
    truncated = payload.truncated;
    degraded = payload.degraded;
    if (o.list === "new") {
      if (!payload.chain.launchpad) throw new MarketUnavailableError("The launchpad could not be read from the chain just now; retry shortly.");
      ranking = `Launchpad coins from the last ~15 minutes with at least ${ACTIVITY_GATE.minTrades} trades from ${ACTIVITY_GATE.minTraders} addresses, by distinct traders.`;
      items = payload.fresh.map((r) => launchItem(r, payload.chain.meta));
      if (!payload.chain.meta || !payload.chain.facts) caveats.push("Some launch details (names, descriptions, curve progress) could not be read this time; missing ones are null.");
    } else {
      if (payload.indexUnreachable) throw new MarketUnavailableError("The market index could not be read just now; retry shortly.");
      scout = payload.verdictsWhy ?? "present_where_given";
      const rows = [...payload.rows];
      if (o.list === "high_volume") {
        rows.sort((a, b) => (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1));
        ranking = "Pools clearing the display screen, by 24h volume.";
      } else {
        ranking = "Pools clearing the display screen, in the coins panel's order: graduated first, then by 24h price change.";
      }
      items = rows.map(poolItem);
      if (truncated) caveats.push("The index cut its walk short, so this is a prefix of the market rather than all of it.");
    }
  }
  flagDuplicates(items, o.customTokens);
  return {
    list: o.list,
    ranking,
    items: items.slice(o.offset, o.offset + o.limit),
    total: items.length,
    next_offset: o.offset + o.limit < items.length ? o.offset + o.limit : null,
    observed_at: observedAt,
    truncated,
    degraded,
    scout_verdicts: scout,
    caveats,
  };
}

// ── watchlist ───────────────────────────────────────────────────────────────

/** Per owner. A watchlist is a list of things to look at, not a portfolio. */
export const WATCHLIST_MAX = 100;

export class WatchlistFullError extends Error {
  constructor() {
    super("watchlist is full");
    this.name = "WatchlistFullError";
  }
}

export interface WatchlistRow {
  chain_id: number;
  address: string;
  /** A public registry ticker (cash, stock token, official coin) recorded when the token was added; null otherwise. */
  symbol: string | null;
  /** The owner's own words (raw). */
  label: string | null;
  note: string | null;
  added_at: string | null;
}

interface WatchDbRow { chain_id: number | string; token: string; symbol: string | null; label: string | null; note: string | null; created_at: number | string }
const watchRow = (r: WatchDbRow): WatchlistRow => ({
  chain_id: Number(r.chain_id),
  address: String(r.token).toLowerCase(),
  symbol: r.symbol ?? null,
  label: r.label ?? null,
  note: r.note ?? null,
  added_at: iso(Number(r.created_at)),
});

/** Every row is filtered by the owner's tenant; nothing else can reach another owner's list. */
export async function listWatchlist(db: Db, tenant: string): Promise<WatchlistRow[]> {
  const rows = await db.prepare(`SELECT chain_id, token, symbol, label, note, created_at FROM mcp_watchlist
    WHERE tenant = ? ORDER BY created_at DESC, token ASC LIMIT ${WATCHLIST_MAX}`).all(tenant.toLowerCase()) as WatchDbRow[];
  return rows.map(watchRow);
}

/**
 * Add a token, or update the label and note of one already watched. A field
 * left undefined keeps what is stored; an explicit null clears it. Watching
 * never buys anything: nothing reads this table to trade.
 *
 * The stored symbol is a PUBLIC registry ticker only (cash, stock tokens,
 * official coins), never the owner's own custom ticker: that is a setting, and
 * a connection allowed to manage the watchlist is not thereby allowed to read
 * settings. Surfaces that may see the owner's tokens derive it at read time.
 *
 * Under concurrent adds on Postgres the cap can be overshot by the number of
 * adds in flight (each counts before the other commits); the insert itself is
 * conflict-safe, so a race on the SAME token updates instead of failing.
 */
export async function addToWatchlist(db: Db, o: {
  tenant: string;
  chainId: number;
  address: string;
  label?: string | null;
  note?: string | null;
  now: number;
}): Promise<{ added: boolean; row: WatchlistRow; count: number }> {
  const tenant = o.tenant.toLowerCase();
  const token = o.address.toLowerCase();
  if (!ADDRESS_RE.test(token)) throw new MarketInputError("address must be a 0x-prefixed 20-byte address");
  const symbol = o.chainId === 4663 ? trustedIdentity(token, [])?.symbol ?? null : null;
  return db.tx(async (tx) => {
    const existing = await tx.prepare("SELECT token FROM mcp_watchlist WHERE tenant = ? AND chain_id = ? AND token = ?").get(tenant, o.chainId, token);
    let added = false;
    if (!existing) {
      const n = await tx.prepare("SELECT COUNT(*) AS n FROM mcp_watchlist WHERE tenant = ?").get(tenant) as { n: number | string };
      if (Number(n.n) >= WATCHLIST_MAX) throw new WatchlistFullError();
      const r = await tx.prepare(`INSERT INTO mcp_watchlist (tenant, chain_id, token, symbol, label, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant, chain_id, token) DO NOTHING`)
        .run(tenant, o.chainId, token, symbol, o.label ?? null, o.note ?? null, o.now);
      added = r.changes > 0;
    }
    if (!added) {
      if (o.label !== undefined) await tx.prepare("UPDATE mcp_watchlist SET label = ? WHERE tenant = ? AND chain_id = ? AND token = ?").run(o.label, tenant, o.chainId, token);
      if (o.note !== undefined) await tx.prepare("UPDATE mcp_watchlist SET note = ? WHERE tenant = ? AND chain_id = ? AND token = ?").run(o.note, tenant, o.chainId, token);
      await tx.prepare("UPDATE mcp_watchlist SET symbol = ? WHERE tenant = ? AND chain_id = ? AND token = ?").run(symbol, tenant, o.chainId, token);
    }
    const row = await tx.prepare("SELECT chain_id, token, symbol, label, note, created_at FROM mcp_watchlist WHERE tenant = ? AND chain_id = ? AND token = ?").get(tenant, o.chainId, token) as WatchDbRow;
    const n = await tx.prepare("SELECT COUNT(*) AS n FROM mcp_watchlist WHERE tenant = ?").get(tenant) as { n: number | string };
    return { added, row: watchRow(row), count: Number(n.n) };
  });
}

/** True when a row of THIS owner's was removed; another owner's row is indistinguishable from none. */
export async function removeFromWatchlist(db: Db, o: { tenant: string; chainId: number; address: string }): Promise<boolean> {
  const r = await db.prepare("DELETE FROM mcp_watchlist WHERE tenant = ? AND chain_id = ? AND token = ?")
    .run(o.tenant.toLowerCase(), o.chainId, o.address.toLowerCase());
  return r.changes > 0;
}
