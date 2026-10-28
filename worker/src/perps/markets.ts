/**
 * WHAT LIGHTER SAID, IN NUMBERS WE CAN DO ARITHMETIC ON — OR NOTHING.
 *
 * Every response api.ts gets from api.rh.lighter.xyz passes through one of the
 * parsers below before anything else in the worker sees it. They are strict
 * whitelist parsers with one rule (docs/perps.md rule 11): a field that is
 * not exactly what it should be makes the answer UNREAD — null — never a
 * zero, never a best guess. An unread venue account is a book gap, and a
 * book gap refuses opens; a zero would be a confident statement that the
 * money is gone (or that a position is flat), which is the one thing we must
 * never invent.
 *
 * THREE KINDS OF NUMBER ARRIVE, and each has its own treatment:
 *
 *   exact decimals   money (6 dp: collateral, allocated_margin, unrealized_pnl,
 *                    usd_amount…) and venue-precision prices and sizes. Parsed
 *                    by core's parseMicroUsdg / parseDecimalToScaled: more
 *                    decimals than the field carries is refused, not rounded.
 *   float renderings total_asset_value ("1679.8316029999999"), liquidation
 *                    price ("218.0989960890466"). Never money. Parsed
 *                    tolerantly, rounded in a named direction, and used only
 *                    as a cross-check or a display.
 *   JSON numbers     mark candles and small integers. Candles are read through
 *                    their shortest round-trip rendering and then held to the
 *                    market's price decimals exactly like a string would be.
 *
 * FIELDS LIGHTER OMITS WHEN ZERO are an explicit allowlist per parser (the
 * accounting review's omitempty finding). Absent-and-allowlisted is 0/false;
 * absent-and-not-allowlisted is a refusal. A parser that treated every absent
 * field as unknown would refuse every real account; one that treated every
 * absent field as zero would violate rule 11.
 */

import {
  LIGHTER_ROUTE_V1,
  imfPercentToBp,
  parseDecimalToScaled,
  parseMicroUsdg,
  perpMarketById,
  type PerpKey,
  type PerpMarket,
  type PerpMarketSpec,
  type PerpSide,
} from "../../../packages/core/src/index";

// ── small strict readers ────────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function safeInt(x: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= min && x <= max ? x : null;
}

/** An integer the venue may omit when zero (and only then). */
function omitZeroInt(r: Record<string, unknown>, k: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  if (!(k in r)) return 0;
  return safeInt(r[k], min, max);
}

function omitFalse(r: Record<string, unknown>, k: string): boolean | null {
  if (!(k in r)) return false;
  return typeof r[k] === "boolean" ? r[k] : null;
}

/** Decimal digits of a venue id rendered as a string (trade_id_str, ask_id_str…). */
const ID_STR_RE = /^\d{1,20}$/;
const HASH_RE = /^[0-9a-f]{80}$/;
const LOOSE_DECIMAL_RE = /^(-?)(\d{1,30})(?:\.(\d{1,40}))?$/;

/**
 * A float-rendered decimal string scaled to `decimals`, rounded in a NAMED
 * direction. Only for fields the venue renders through a float and which we
 * never book as money: the rounding direction is chosen by the caller so it
 * errs toward refusing (a liquidation price toward the entry).
 */
export function scaleLooseDecimal(s: unknown, decimals: number, rounding: "floor" | "ceil" | "nearest"): bigint | null {
  if (typeof s !== "string") return null;
  const m = LOOSE_DECIMAL_RE.exec(s);
  if (m === null) return null;
  const neg = m[1] === "-";
  const int = m[2] ?? "0";
  const frac = m[3] ?? "";
  const kept = frac.slice(0, decimals).padEnd(decimals, "0");
  const dropped = frac.slice(decimals);
  let mag = BigInt(int + kept);
  const anyDropped = /[1-9]/.test(dropped);
  if (anyDropped) {
    // Magnitude grows for: nearest when the first dropped digit is ≥ 5; ceil
    // of a positive; floor of a negative.
    const up = rounding === "nearest" ? dropped.charCodeAt(0) - 48 >= 5 : rounding === "ceil" ? !neg : neg;
    if (up) mag += 1n;
  }
  return neg ? -mag : mag;
}

/** A positive venue integer at the market's precision, or null. */
function positiveScaled(s: unknown, decimals: number): bigint | null {
  const v = parseDecimalToScaled(s, decimals);
  return v !== null && v > 0n ? v : null;
}

/** Percent with 4 dp ("0.0350", "1.0000") → parts per million, exactly. */
function percent4ToPpm(s: unknown): number | null {
  const v = parseDecimalToScaled(s, 4);
  if (v === null || v < 0n || v > 1_000_000n) return null;
  return Number(v);
}

// ── market details ──────────────────────────────────────────────────────────

export interface PerpDecimals {
  sizeDecimals: number;
  priceDecimals: number;
}

/**
 * One market as the venue describes it right now, joined to the frozen table.
 *
 * `spec.status` is the ONE field policy reads to decide whether an open may go
 * out, so everything that should stop an open is folded into it: a
 * force-reduce-only market is "reduce-only" (the contract), and a market the
 * venue has hidden or restricted to trading hours is "inactive" — the
 * review's "a non-empty trading_hours is a book gap for opens". The raw facts
 * stay alongside for display, so the owner is told why rather than just that.
 */
export interface PerpMarketView {
  market: PerpMarket;
  spec: PerpMarketSpec;
  /** venue integer price (mark × 10^priceDecimals) */
  markPrice: bigint;
  indexPrice: bigint;
  venueStatus: "active" | "inactive";
  forceReduceOnly: boolean;
  /** "" when the market trades around the clock. */
  tradingHours: string;
  hidden: boolean;
  /** market_config.market_margin_mode, as the venue sent it (0 on every market at ship time). */
  marketMarginMode: number;
  takerFeePpm: number;
  makerFeePpm: number;
  liquidationFeePpm: number;
  orderQuoteLimitMicro: bigint;
  fundingPremiumMultiplier: number;
}

export type MarketRefusal = { marketId: number | null; symbol: string | null; reason: string };

export interface OrderBookDetailsRead {
  /** Markets of LIGHTER_MARKETS_V1 that parsed and whose id and symbol agree with the table. */
  markets: ReadonlyMap<number, PerpMarketView>;
  /** Every row that did not make it into `markets`, and why. Failed is not empty. */
  refused: readonly MarketRefusal[];
  /**
   * Size and price decimals for EVERY perp row whose decimals parsed, listed
   * or not. parseAccount needs them to read a position exactly — including
   * one in a market we would never trade, which is exactly the position an
   * incident review needs to see.
   */
  decimals: ReadonlyMap<number, PerpDecimals>;
}

function parseDecimalsOf(r: Record<string, unknown>): PerpDecimals | null {
  const sizeDecimals = safeInt(r.size_decimals, 0, 18);
  const priceDecimals = safeInt(r.price_decimals, 0, 18);
  return sizeDecimals === null || priceDecimals === null ? null : { sizeDecimals, priceDecimals };
}

function parseMarketRow(r: Record<string, unknown>, market: PerpMarket, d: PerpDecimals): PerpMarketView | string {
  if (r.status !== "active" && r.status !== "inactive") return "status";
  const minBaseAmount = positiveScaled(r.min_base_amount, d.sizeDecimals);
  const minQuoteMicro = parseMicroUsdg(r.min_quote_amount);
  if (minBaseAmount === null) return "min_base_amount";
  if (minQuoteMicro === null || minQuoteMicro <= 0n) return "min_quote_amount";
  const defaultImfBp = safeInt(r.default_initial_margin_fraction, 1, 10_000);
  const minImfBp = safeInt(r.min_initial_margin_fraction, 1, 10_000);
  const mmfBp = safeInt(r.maintenance_margin_fraction, 1, 9_999);
  const closeoutBp = safeInt(r.closeout_margin_fraction, 1, 9_999);
  if (defaultImfBp === null || minImfBp === null || mmfBp === null || closeoutBp === null) return "margin fractions";
  // The ordering every liquidation formula assumes: closeout < maintenance <
  // minimum initial ≤ default. A market that says otherwise is one whose
  // liquidation price we would compute on the wrong side of the truth.
  if (!(closeoutBp < mmfBp && mmfBp < minImfBp && minImfBp <= defaultImfBp)) return "margin fraction ordering";
  const markPrice = positiveScaled(r.mark_price, d.priceDecimals);
  const indexPrice = positiveScaled(r.index_price, d.priceDecimals);
  if (markPrice === null) return "mark_price";
  if (indexPrice === null) return "index_price";
  const takerFeePpm = percent4ToPpm(r.taker_fee);
  const makerFeePpm = percent4ToPpm(r.maker_fee);
  const liquidationFeePpm = percent4ToPpm(r.liquidation_fee);
  if (takerFeePpm === null || makerFeePpm === null || liquidationFeePpm === null) return "fees";
  const orderQuoteLimitMicro = parseMicroUsdg(r.order_quote_limit);
  if (orderQuoteLimitMicro === null || orderQuoteLimitMicro <= 0n) return "order_quote_limit";
  const fundingPremiumMultiplier = safeInt(r.funding_premium_multiplier, 0, 1_000_000);
  if (fundingPremiumMultiplier === null) return "funding_premium_multiplier";
  const cfg = r.market_config;
  if (!isRecord(cfg)) return "market_config";
  if (typeof cfg.force_reduce_only !== "boolean" || typeof cfg.trading_hours !== "string" || typeof cfg.hidden !== "boolean") {
    return "market_config fields";
  }
  const marketMarginMode = safeInt(cfg.market_margin_mode, 0, 255);
  if (marketMarginMode === null) return "market_config.market_margin_mode";
  const venueStatus = r.status;
  const status: PerpMarketSpec["status"] = cfg.force_reduce_only
    ? "reduce-only"
    : venueStatus === "active" && cfg.trading_hours === "" && !cfg.hidden
      ? "active"
      : "inactive";
  const spec: PerpMarketSpec = {
    marketId: market.marketId,
    sizeDecimals: d.sizeDecimals,
    priceDecimals: d.priceDecimals,
    minBaseAmount,
    minQuoteMicro,
    minImfBp,
    defaultImfBp,
    mmfBp,
    closeoutBp,
    // A fee is a cost: a fraction of a bp rounds UP.
    liquidationFeeBp: Math.ceil(liquidationFeePpm / 100),
    status,
  };
  return {
    market,
    spec,
    markPrice,
    indexPrice,
    venueStatus,
    forceReduceOnly: cfg.force_reduce_only,
    tradingHours: cfg.trading_hours,
    hidden: cfg.hidden,
    marketMarginMode,
    takerFeePpm,
    makerFeePpm,
    liquidationFeePpm,
    orderQuoteLimitMicro,
    fundingPremiumMultiplier,
  };
}

/**
 * GET /api/v1/orderBookDetails (any filter) → the markets we may trade.
 *
 * Null only when the envelope itself is wrong. A bad ROW refuses that market
 * alone and says why in `refused`; the others stand. Each listed market is
 * cross-checked against LIGHTER_MARKETS_V1: an id whose venue symbol is not
 * the table's symbol is refused outright, because signing against it would
 * trade whatever the venue now calls that id. Perp-ness is `market_type`,
 * never an id range (lighter-go: the split is no longer a guarantee); spot
 * rows arrive in their own array and are never read. A market id that appears
 * twice is refused both times — which one would we believe?
 */
export function parseOrderBookDetails(raw: unknown): OrderBookDetailsRead | null {
  if (!isRecord(raw) || !Array.isArray(raw.order_book_details)) return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  const markets = new Map<number, PerpMarketView>();
  const decimals = new Map<number, PerpDecimals>();
  const refused: MarketRefusal[] = [];
  const seen = new Map<number, number>();
  for (const row of raw.order_book_details) {
    const id = isRecord(row) ? safeInt(row.market_id, 0, 32_767) : null;
    if (id !== null) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const row of raw.order_book_details) {
    if (!isRecord(row)) {
      refused.push({ marketId: null, symbol: null, reason: "row is not an object" });
      continue;
    }
    const id = safeInt(row.market_id, 0, 32_767);
    const symbol = typeof row.symbol === "string" ? row.symbol : null;
    if (id === null || symbol === null) {
      refused.push({ marketId: id, symbol, reason: "market_id or symbol" });
      continue;
    }
    if ((seen.get(id) ?? 0) > 1) {
      refused.push({ marketId: id, symbol, reason: "duplicate market_id" });
      continue;
    }
    if (row.market_type !== "perp") {
      refused.push({ marketId: id, symbol, reason: "not a perp" });
      continue;
    }
    const d = parseDecimalsOf(row);
    if (d === null) {
      refused.push({ marketId: id, symbol, reason: "decimals" });
      continue;
    }
    decimals.set(id, d);
    const market = perpMarketById(id);
    if (market === null) {
      refused.push({ marketId: id, symbol, reason: "not in LIGHTER_MARKETS_V1" });
      continue;
    }
    if (market.symbol !== symbol) {
      refused.push({ marketId: id, symbol, reason: `symbol mismatch: table says ${market.symbol}` });
      continue;
    }
    const view = parseMarketRow(row, market, d);
    if (typeof view === "string") {
      refused.push({ marketId: id, symbol, reason: `malformed ${view}` });
      continue;
    }
    markets.set(id, view);
  }
  return { markets, refused, decimals };
}

/** GET /api/v1/orderBooks → the venue's market list (id, symbol, type, status), or null. */
export interface OrderBookListing {
  marketId: number;
  symbol: string;
  marketType: "perp" | "spot";
  status: "active" | "inactive";
}

export function parseOrderBooks(raw: unknown): OrderBookListing[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.order_books)) return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  const out: OrderBookListing[] = [];
  for (const r of raw.order_books) {
    if (!isRecord(r)) return null;
    const marketId = safeInt(r.market_id, 0, 32_767);
    if (marketId === null || typeof r.symbol !== "string") return null;
    if (r.market_type !== "perp" && r.market_type !== "spot") return null;
    if (r.status !== "active" && r.status !== "inactive") return null;
    out.push({ marketId, symbol: r.symbol, marketType: r.market_type, status: r.status });
  }
  return out;
}

// ── the account ─────────────────────────────────────────────────────────────

/**
 * One row of an account's `positions`. The venue lists a row for every market
 * the account has touched, including flat ones — which is where per-market
 * margin mode and IMF live while flat, and rule 6 refuses an open unless the
 * market already reads isolated at exactly IMF_m. So flat rows are kept, with
 * `side: null` and `baseAmount: 0n`.
 */
export interface PerpAccountPosition {
  marketId: number;
  symbol: string;
  /** null when the market is not in LIGHTER_MARKETS_V1 (never ours to trade; still exposure). */
  key: PerpKey | null;
  /** From `sign`; null when flat. `position` itself is unsigned. */
  side: PerpSide | null;
  /** |position| in venue base units, exact. */
  baseAmount: bigint;
  /** The venue's displayed average entry, venue price units (rounded to the tick by the venue). */
  avgEntryPrice: bigint;
  positionValueMicro: bigint;
  allocatedMarginMicro: bigint;
  marginMode: "cross" | "isolated";
  /** Position IMF, normalised from the PERCENT string ("8.33") to bp (833). */
  imfBp: number;
  unrealizedMicro: bigint;
  realizedMicro: bigint;
  /**
   * The venue's liquidation price, rounded TOWARD THE ENTRY (up for a long,
   * down for a short) because it arrives float-rendered; null when the venue
   * reports none ("0") or the market is flat.
   */
  liqPrice: bigint | null;
  totalFundingPaidOutMicro: bigint;
  positionTiedOrderCount: number;
  openOrderCount: number;
  pendingOrderCount: number;
}

export interface PerpAccountRead {
  accountIndex: number;
  /** lowercase */
  l1Address: `0x${string}`;
  /** C: the cross/free balance. EXCLUDES every isolated position's margin. */
  collateralMicro: bigint;
  positions: PerpAccountPosition[];
  /** Σ allocated_margin (all isolated — a cross row carrying margin refuses the read). */
  isolatedMarginMicro: bigint;
  /** Σ unrealized_pnl at the venue's mark. */
  unrealizedMicro: bigint;
  /** Σ max(0, unrealized) per position — what peakBasis subtracts (rule 12). */
  unrealizedGainMicro: bigint;
  /** C + ΣM + ΣU: the venue term of rule 12 before transfers in transit. */
  venueValueMicro: bigint;
  /** total_asset_value, float-rendered by the venue: a CROSS-CHECK only, rounded to the nearest micro. */
  totalAssetValueMicro: bigint | null;
  /** µs; identifies the ONE snapshot C, M and U came from. */
  transactionTimeUs: number;
  accountType: number;
  status: number;
  totalOrderCount: number;
  pendingOrderCount: number;
  /** Public-pool share entries (rule 5 flatness counts pool shares). */
  poolShareCount: number;
  /**
   * Every `assets` entry holding anything in the SPOT route — a non-zero
   * `balance` or `locked_balance`, USDG or any stock token. This money is
   * OUTSIDE C + ΣM + ΣU, and total_asset_value leaves it out too (account 39:
   * 308,244.59 USDG locked in spot, total_asset_value equal to the perps sum
   * to the micro), so the rule-12 cross-check can never catch it. The worker
   * never moves funds to spot (it never signs Transfer, rule 2), yet the API
   * key can sign a perps→spot route change: an entry here is exposure (not
   * flat, named in custody text) and a venue incident (rule 16).
   */
  spotHoldings: SpotHolding[];
  /** USDG in the spot route (balance + locked), micro — part of spotHoldings, summed. */
  spotUsdgMicro: bigint;
  /**
   * Entries in `pending_unlocks`. Never observed non-empty, so the shape is
   * unknown and each entry counts as exposure, whatever it holds.
   */
  pendingUnlockCount: number;
}

/** One non-zero spot-route balance. Amounts are the venue's exact decimal strings (stock tokens carry up to 10+ dp). */
export interface SpotHolding {
  assetId: number;
  symbol: string;
  balance: string;
  lockedBalance: string;
}

/** A non-negative exact decimal as the venue renders an asset balance, or null. */
const ASSET_AMOUNT_RE = /^\d{1,30}(?:\.\d{1,30})?$/;
const ZERO_AMOUNT_RE = /^0+(?:\.0+)?$/;

/**
 * The account's `assets` → the non-zero spot holdings and the spot USDG, or
 * null (the whole account is then unread). Strict: a known field of the wrong
 * shape refuses, and USDG (asset 3, the collateral asset) must carry exactly
 * the 6 dp money has — a USDG amount we cannot book exactly is not one we
 * may call zero.
 */
function parseSpotAssets(assets: unknown): { holdings: SpotHolding[]; usdgMicro: bigint } | null {
  if (!Array.isArray(assets)) return null;
  const holdings: SpotHolding[] = [];
  const seen = new Set<number>();
  let usdgMicro = 0n;
  for (const x of assets) {
    if (!isRecord(x)) return null;
    const assetId = safeInt(x.asset_id, 0, 65_535);
    if (assetId === null || seen.has(assetId) || typeof x.symbol !== "string") return null;
    seen.add(assetId);
    const { balance, locked_balance: locked } = x;
    if (typeof balance !== "string" || typeof locked !== "string" || !ASSET_AMOUNT_RE.test(balance) || !ASSET_AMOUNT_RE.test(locked)) return null;
    if (assetId === LIGHTER_ROUTE_V1.assetIndex) {
      // The collateral asset renumbered is not an asset we can reason about.
      if (x.symbol !== "USDG") return null;
      const b = parseMicroUsdg(balance);
      const l = parseMicroUsdg(locked);
      if (b === null || l === null) return null;
      usdgMicro = b + l;
    }
    if (!ZERO_AMOUNT_RE.test(balance) || !ZERO_AMOUNT_RE.test(locked)) {
      holdings.push({ assetId, symbol: x.symbol, balance, lockedBalance: locked });
    }
  }
  return { holdings, usdgMicro };
}

function parsePosition(p: unknown, decimals: ReadonlyMap<number, PerpDecimals>): PerpAccountPosition | null {
  if (!isRecord(p)) return null;
  const marketId = safeInt(p.market_id, 0, 32_767);
  if (marketId === null || typeof p.symbol !== "string") return null;
  const listed = perpMarketById(marketId);
  // A listed id carrying another symbol means the venue renumbered: nothing
  // about this row can be trusted to mean the market we think it does.
  if (listed !== null && listed.symbol !== p.symbol) return null;
  const sign = p.sign;
  if (sign !== 1 && sign !== -1 && sign !== 0) return null;
  const marginMode = p.margin_mode === 1 ? "isolated" : p.margin_mode === 0 ? "cross" : null;
  if (marginMode === null) return null;
  const imfBp = imfPercentToBp(p.initial_margin_fraction);
  if (imfBp === null) return null;
  const positionValueMicro = parseMicroUsdg(p.position_value);
  const unrealizedMicro = parseMicroUsdg(p.unrealized_pnl);
  const realizedMicro = parseMicroUsdg(p.realized_pnl);
  const allocatedMarginMicro = parseMicroUsdg(p.allocated_margin);
  if (positionValueMicro === null || unrealizedMicro === null || realizedMicro === null || allocatedMarginMicro === null) return null;
  if (allocatedMarginMicro < 0n) return null;
  // Margin allocated to a CROSS row has no place in C + ΣM_iso + ΣU: counting
  // it double-counts, dropping it loses money. Neither is a number we book.
  if (marginMode === "cross" && allocatedMarginMicro !== 0n) return null;
  // omitempty allowlist: both are absent when zero (99 of 210 live rows lack
  // total_funding_paid_out; every row lacks total_discount).
  const totalFundingPaidOutMicro = "total_funding_paid_out" in p ? parseMicroUsdg(p.total_funding_paid_out) : 0n;
  if (totalFundingPaidOutMicro === null) return null;
  if ("total_discount" in p && parseMicroUsdg(p.total_discount) === null) return null;
  const positionTiedOrderCount = safeInt(p.position_tied_order_count, 0);
  const openOrderCount = safeInt(p.open_order_count, 0);
  const pendingOrderCount = safeInt(p.pending_order_count, 0);
  if (positionTiedOrderCount === null || openOrderCount === null || pendingOrderCount === null) return null;

  const d = decimals.get(marketId);
  let baseAmount: bigint;
  let avgEntryPrice: bigint;
  if (d === undefined) {
    // No decimals for this market: we can only read it if it is flat. A
    // non-zero size we cannot scale is exposure we cannot state.
    if (typeof p.position !== "string" || !/^0+(\.0+)?$/.test(p.position)) return null;
    baseAmount = 0n;
    avgEntryPrice = 0n;
  } else {
    const b = parseDecimalToScaled(p.position, d.sizeDecimals);
    const e = parseDecimalToScaled(p.avg_entry_price, d.priceDecimals);
    if (b === null || b < 0n || e === null || e < 0n) return null;
    baseAmount = b;
    avgEntryPrice = e;
  }
  let side: PerpSide | null = null;
  let liqPrice: bigint | null = null;
  if (baseAmount > 0n) {
    if (sign === 0) return null;
    side = sign === 1 ? "long" : "short";
    if (avgEntryPrice <= 0n || d === undefined) return null;
    if (p.liquidation_price !== "0") {
      liqPrice = scaleLooseDecimal(p.liquidation_price, d.priceDecimals, side === "long" ? "ceil" : "floor");
      if (liqPrice === null || liqPrice < 0n) return null;
      if (liqPrice === 0n) liqPrice = null;
    }
  } else if (typeof p.liquidation_price !== "string") {
    return null;
  }
  return {
    marketId,
    symbol: p.symbol,
    key: listed?.key ?? null,
    side,
    baseAmount,
    avgEntryPrice,
    positionValueMicro,
    allocatedMarginMicro,
    marginMode,
    imfBp,
    unrealizedMicro,
    realizedMicro,
    liqPrice,
    totalFundingPaidOutMicro,
    positionTiedOrderCount,
    openOrderCount,
    pendingOrderCount,
  };
}

/**
 * GET /api/v1/account?by=index|l1_address → exactly one account, or null.
 *
 * Rule 12's venue term is C + ΣM_iso + ΣU from THIS one response (one
 * `transaction_time`): opening an isolated position moves margin from C to M
 * atomically and funding debits M between reads, so parts from two reads do
 * not add up to anything. `collateral` alone is NOT the account's money — it
 * excludes isolated margin (account 22149: collateral 0.33, total 150.86).
 *
 * `decimals` comes from the same cycle's parseOrderBookDetails. `expect`
 * guards against the venue answering for a different account than asked.
 */
export function parseAccount(
  raw: unknown,
  decimals: ReadonlyMap<number, PerpDecimals>,
  expect?: { accountIndex?: number; l1Address?: string },
): PerpAccountRead | null {
  if (!isRecord(raw) || !Array.isArray(raw.accounts) || raw.accounts.length !== 1) return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  const a = raw.accounts[0];
  if (!isRecord(a)) return null;
  const accountIndex = safeInt(a.index, 1);
  if (accountIndex === null || a.account_index !== accountIndex) return null;
  if (typeof a.l1_address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a.l1_address)) return null;
  const l1Address = a.l1_address.toLowerCase() as `0x${string}`;
  if (expect?.accountIndex !== undefined && expect.accountIndex !== accountIndex) return null;
  if (expect?.l1Address !== undefined && expect.l1Address.toLowerCase() !== l1Address) return null;
  const collateralMicro = parseMicroUsdg(a.collateral);
  if (collateralMicro === null) return null;
  const transactionTimeUs = safeInt(a.transaction_time, 1);
  const accountType = safeInt(a.account_type, 0, 255);
  const status = safeInt(a.status, 0, 255);
  const totalOrderCount = safeInt(a.total_order_count, 0);
  const pendingOrderCount = safeInt(a.pending_order_count, 0);
  if (transactionTimeUs === null || accountType === null || status === null || totalOrderCount === null || pendingOrderCount === null) return null;
  if (!Array.isArray(a.positions) || !Array.isArray(a.shares)) return null;
  // Present on every one of 20 live captures, so absent is a refusal, not an
  // omitted zero: money outside the perps route must be read, not assumed away.
  const spot = parseSpotAssets(a.assets);
  if (spot === null || !Array.isArray(a.pending_unlocks) || !a.pending_unlocks.every(isRecord)) return null;
  const positions: PerpAccountPosition[] = [];
  const seen = new Set<number>();
  let isolatedMarginMicro = 0n;
  let unrealizedMicro = 0n;
  let unrealizedGainMicro = 0n;
  for (const row of a.positions) {
    const p = parsePosition(row, decimals);
    // ONE bad row refuses the whole account: dropping it would present a book
    // with a leveraged position missing — the "No positions" rule 11 forbids.
    if (p === null || seen.has(p.marketId)) return null;
    seen.add(p.marketId);
    positions.push(p);
    isolatedMarginMicro += p.allocatedMarginMicro;
    unrealizedMicro += p.unrealizedMicro;
    if (p.unrealizedMicro > 0n) unrealizedGainMicro += p.unrealizedMicro;
  }
  return {
    accountIndex,
    l1Address,
    collateralMicro,
    positions,
    isolatedMarginMicro,
    unrealizedMicro,
    unrealizedGainMicro,
    venueValueMicro: collateralMicro + isolatedMarginMicro + unrealizedMicro,
    totalAssetValueMicro: scaleLooseDecimal(a.total_asset_value, 6, "nearest"),
    transactionTimeUs,
    accountType,
    status,
    totalOrderCount,
    pendingOrderCount,
    poolShareCount: a.shares.length,
    spotHoldings: spot.holdings,
    spotUsdgMicro: spot.usdgMicro,
    pendingUnlockCount: a.pending_unlocks.length,
  };
}

/**
 * This ONE account read holds nothing at all: no position, order, collateral,
 * isolated margin, pool share, spot balance or pending unlock. Rule 5's
 * "provably flat" also needs every other account under the L1 address and the
 * contract's pending balance to read empty — this is one account's part.
 */
export function accountReadsEmpty(acct: PerpAccountRead): boolean {
  return (
    acct.collateralMicro === 0n &&
    acct.isolatedMarginMicro === 0n &&
    openPositions(acct).length === 0 &&
    acct.totalOrderCount === 0 &&
    acct.pendingOrderCount === 0 &&
    acct.positions.every((p) => p.openOrderCount === 0 && p.pendingOrderCount === 0 && p.positionTiedOrderCount === 0) &&
    acct.poolShareCount === 0 &&
    acct.spotHoldings.length === 0 &&
    acct.pendingUnlockCount === 0
  );
}

/** Positions that are not flat. */
export function openPositions(acct: PerpAccountRead): PerpAccountPosition[] {
  return acct.positions.filter((p) => p.baseAmount > 0n);
}

/**
 * The rule-12 cross-check: |total_asset_value − (C + ΣM + ΣU)| ≤ 2 micro ×
 * (open positions + 1).
 *
 * The venue renders total_asset_value through a float, so it misses the exact
 * sum by a micro or two per position (observed 0–2 on 1–4 positions, 9 on
 * 23). A tolerance scaled by positions accepts that noise and nothing
 * resembling a missing margin. False — including when total_asset_value was
 * unreadable — is a book gap under rule 11.
 */
export function totalAssetValueConsistent(acct: PerpAccountRead): boolean {
  if (acct.totalAssetValueMicro === null) return false;
  const diff = acct.totalAssetValueMicro - acct.venueValueMicro;
  const tol = 2n * BigInt(openPositions(acct).length + 1);
  return (diff < 0n ? -diff : diff) <= tol;
}

/** GET /api/v1/accountsByL1Address → the account indexes under an L1 address (master and subs), or null. */
export interface L1Accounts {
  l1Address: `0x${string}`;
  accounts: Array<{ accountIndex: number; accountType: number; collateralMicro: bigint }>;
  nextCursor: string | null;
}

export function parseAccountsByL1Address(raw: unknown, expectL1?: string): L1Accounts | null {
  if (!isRecord(raw) || !Array.isArray(raw.sub_accounts)) return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  if (typeof raw.l1_address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw.l1_address)) return null;
  const l1Address = raw.l1_address.toLowerCase() as `0x${string}`;
  if (expectL1 !== undefined && expectL1.toLowerCase() !== l1Address) return null;
  const accounts: L1Accounts["accounts"] = [];
  for (const s of raw.sub_accounts) {
    if (!isRecord(s)) return null;
    const accountIndex = safeInt(s.index, 1);
    const accountType = safeInt(s.account_type, 0, 255);
    const collateralMicro = parseMicroUsdg(s.collateral);
    if (accountIndex === null || accountType === null || collateralMicro === null) return null;
    if (typeof s.l1_address === "string" && s.l1_address.toLowerCase() !== l1Address) return null;
    accounts.push({ accountIndex, accountType, collateralMicro });
  }
  const nextCursor = typeof raw.next_cursor === "string" && raw.next_cursor !== "" ? raw.next_cursor : null;
  return { l1Address, accounts, nextCursor };
}

/** GET /api/v1/apikeys → registered keys. `publicKey` is normalised to 0x + lowercase. */
export interface ApiKeyRead {
  accountIndex: number;
  apiKeyIndex: number;
  nonce: number;
  publicKey: `0x${string}`;
}

export function parseApiKeys(raw: unknown): ApiKeyRead[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.api_keys)) return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  const out: ApiKeyRead[] = [];
  for (const k of raw.api_keys) {
    if (!isRecord(k)) return null;
    const accountIndex = safeInt(k.account_index, 1);
    const apiKeyIndex = safeInt(k.api_key_index, 0, 254);
    const nonce = safeInt(k.nonce, 0);
    // Lighter renders the key as 80 hex WITHOUT 0x; accept either and compare
    // canonically, since the wall seals `0x` + lowercase.
    const pk = typeof k.public_key === "string" ? k.public_key.replace(/^0x/, "") : "";
    if (accountIndex === null || apiKeyIndex === null || nonce === null || !/^[0-9a-fA-F]{80}$/.test(pk)) return null;
    out.push({ accountIndex, apiKeyIndex, nonce, publicKey: `0x${pk.toLowerCase()}` });
  }
  return out;
}

/** GET /api/v1/nextNonce → the next nonce for (account, key), or null. */
export function parseNextNonce(raw: unknown): number | null {
  if (!isRecord(raw) || (raw.code !== undefined && raw.code !== 200)) return null;
  return safeInt(raw.nonce, 0);
}

/** GET /api/v1/withdrawalDelay → seconds (observed 626–1314, varies), or null. */
export function parseWithdrawalDelay(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  return safeInt(raw.seconds, 0, 30 * 86_400);
}

// ── depth ───────────────────────────────────────────────────────────────────

export interface DepthLevel {
  /** venue integer price */
  price: bigint;
  /** remaining base, venue units */
  baseAmount: bigint;
}

export interface DepthRead {
  marketId: number;
  /** best first: highest bid first */
  bids: DepthLevel[];
  /** best first: lowest ask first */
  asks: DepthLevel[];
}

/**
 * GET /api/v1/orderBookOrders?market_id&limit → top-of-book as venue integers.
 *
 * Every returned order is checked, not just the top N kept: a malformed row
 * anywhere is a book we do not understand. Side ordering must be monotone
 * (equal prices from different orders are fine), and a crossed book —
 * best bid at or above best ask — is refused: a paper fill walked through it
 * would be a price no one could have traded at.
 */
export function parseDepth(raw: unknown, marketId: number, d: PerpDecimals, topN = 20): DepthRead | null {
  if (!isRecord(raw) || !Array.isArray(raw.asks) || !Array.isArray(raw.bids)) return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  if (!Number.isSafeInteger(topN) || topN < 1) return null;
  const side = (rows: unknown[], dir: 1 | -1): DepthLevel[] | null => {
    const out: DepthLevel[] = [];
    let prev: bigint | null = null;
    for (const r of rows) {
      if (!isRecord(r)) return null;
      const price = positiveScaled(r.price, d.priceDecimals);
      const baseAmount = positiveScaled(r.remaining_base_amount, d.sizeDecimals);
      if (price === null || baseAmount === null) return null;
      if (prev !== null && (dir === 1 ? price < prev : price > prev)) return null;
      prev = price;
      out.push({ price, baseAmount });
    }
    return out.slice(0, topN);
  };
  const asks = side(raw.asks, 1);
  const bids = side(raw.bids, -1);
  if (asks === null || bids === null) return null;
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (bestBid !== undefined && bestAsk !== undefined && bestBid.price >= bestAsk.price) return null;
  return { marketId, bids, asks };
}

// ── funding ─────────────────────────────────────────────────────────────────

/** /fundings `value` precision: 8 dp on every row observed ("0.00109405"). */
export const FUNDING_VALUE_DECIMALS = 8;

export interface FundingRow {
  /** unix SECONDS, on the hour */
  timestampSec: number;
  /**
   * USDG per ONE WHOLE base unit, scaled by 10^FUNDING_VALUE_DECIMALS — what
   * core's fundingPaymentMicro takes as valuePerBase with valueDecimals 8.
   */
  valuePerBase: bigint;
  /** `rate` is PERCENT per hour with 4 dp; as parts per million it is exact ("0.0012" → 12). */
  ratePpm: number;
  /** The side that PAYS. */
  direction: PerpSide;
}

/**
 * GET /api/v1/fundings → hourly rows, oldest first, or null.
 *
 * Not /funding-rates: that one is an 8-hour-normalised FRACTION and mixes in
 * Binance, Bybit and Hyperliquid rows. Negative values and rates parse (their
 * sign convention is unobserved) and are left for the consumer to refuse —
 * fundingPaymentMicro already throws on a negative value.
 */
export function parseFundings(raw: unknown): { resolution: string; fundings: FundingRow[] } | null {
  if (!isRecord(raw) || !Array.isArray(raw.fundings) || typeof raw.resolution !== "string") return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  const step = raw.resolution === "1h" ? 3600 : raw.resolution === "1d" ? 86_400 : null;
  if (step === null) return null;
  const out: FundingRow[] = [];
  let prev = -1;
  for (const f of raw.fundings) {
    if (!isRecord(f)) return null;
    const timestampSec = safeInt(f.timestamp, 0, 1e11);
    const valuePerBase = parseDecimalToScaled(f.value, FUNDING_VALUE_DECIMALS);
    const rate = parseDecimalToScaled(f.rate, 4);
    if (timestampSec === null || valuePerBase === null || rate === null) return null;
    if (f.direction !== "long" && f.direction !== "short") return null;
    if (timestampSec % step !== 0 || timestampSec <= prev) return null;
    if (rate > 1_000_000n || rate < -1_000_000n) return null;
    prev = timestampSec;
    out.push({ timestampSec, valuePerBase, ratePpm: Number(rate), direction: f.direction });
  }
  return { resolution: raw.resolution, fundings: out };
}

/** One authenticated positionFunding row: the venue-authoritative payment (rule 10). */
export interface PositionFundingRow {
  timestampSec: number;
  marketId: number;
  /** The venue's identity for the payment; the ledger's primary key. */
  fundingId: string;
  /** Signed change to the position's money, micro-USDG. */
  changeMicro: bigint;
  discountMicro: bigint;
  ratePpm: number;
  /** position size at funding, venue units when decimals are known */
  positionSize: bigint;
  positionSide: PerpSide;
}

/**
 * GET /api/v1/positionFunding (auth) → payments, or null. Shape per
 * lighter-python's openapi (no live capture: it needs the account's own auth
 * token). Units are held to the same rules as everything else: `change` is
 * exact 6-dp money or the page is unread.
 */
export function parsePositionFunding(
  raw: unknown,
  decimals: ReadonlyMap<number, PerpDecimals>,
): { rows: PositionFundingRow[]; nextCursor: string | null } | null {
  if (!isRecord(raw) || !Array.isArray(raw.position_fundings)) return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  const rows: PositionFundingRow[] = [];
  for (const f of raw.position_fundings) {
    if (!isRecord(f)) return null;
    const timestampSec = safeInt(f.timestamp, 0, 1e11);
    const marketId = safeInt(f.market_id, 0, 32_767);
    const fundingId = typeof f.funding_id === "number" && Number.isSafeInteger(f.funding_id) && f.funding_id >= 0 ? String(f.funding_id) : typeof f.funding_id === "string" && ID_STR_RE.test(f.funding_id) ? f.funding_id : null;
    const changeMicro = parseMicroUsdg(f.change);
    const discountMicro = parseMicroUsdg(f.discount);
    const rate = parseDecimalToScaled(f.rate, 4);
    if (timestampSec === null || marketId === null || fundingId === null || changeMicro === null || discountMicro === null || rate === null) return null;
    if (f.position_side !== "long" && f.position_side !== "short") return null;
    const d = decimals.get(marketId);
    if (d === undefined) return null;
    const size = parseDecimalToScaled(f.position_size, d.sizeDecimals);
    if (size === null || size < 0n) return null;
    rows.push({ timestampSec, marketId, fundingId, changeMicro, discountMicro, ratePpm: Number(rate), positionSize: size, positionSide: f.position_side });
  }
  const nextCursor = typeof raw.next_cursor === "string" && raw.next_cursor !== "" ? raw.next_cursor : null;
  return { rows, nextCursor };
}

// ── mark candles ────────────────────────────────────────────────────────────

export interface MarkCandle {
  /** candle OPEN time, ms */
  tMs: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
}

const RESOLUTION_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
};

/** A JSON-number price at the market's decimals, through its shortest round-trip rendering; exponent forms are refused. */
function numberPrice(x: unknown, priceDecimals: number): bigint | null {
  if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) return null;
  return positiveScaled(String(x), priceDecimals);
}

/**
 * GET /api/v1/markPriceCandles → candles oldest first, as venue integers, or
 * null. Prices arrive as JSON numbers ("o": 88109.9); each must be exactly
 * representable at the market's price decimals — a float artefact past them is
 * refused like an over-precise string would be. Times must be strictly
 * increasing and on the resolution's grid; high/low must bound open/close.
 * The candle still in progress is the CONSUMER's to drop (perp-trend ignores
 * it); this parser cannot know the time.
 */
export function parseMarkCandles(raw: unknown, priceDecimals: number): { resolution: string; candles: MarkCandle[] } | null {
  if (!isRecord(raw) || !Array.isArray(raw.c) || typeof raw.r !== "string") return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  const step = RESOLUTION_MS[raw.r];
  if (step === undefined) return null;
  const candles: MarkCandle[] = [];
  let prev = -1;
  for (const c of raw.c) {
    if (!isRecord(c)) return null;
    const tMs = safeInt(c.t, 0);
    const open = numberPrice(c.o, priceDecimals);
    const high = numberPrice(c.h, priceDecimals);
    const low = numberPrice(c.l, priceDecimals);
    const close = numberPrice(c.c, priceDecimals);
    if (tMs === null || open === null || high === null || low === null || close === null) return null;
    if (tMs % step !== 0 || tMs <= prev) return null;
    if (high < open || high < close || low > open || low > close) return null;
    prev = tMs;
    candles.push({ tMs, open, high, low, close });
  }
  return { resolution: raw.r, candles };
}

// ── transactions ────────────────────────────────────────────────────────────

/**
 * The venue's lifecycle stage, by lighter-ts `TX_STATUSES`: 0 Failed,
 * 1 Pending, 2 Executed, then 3 Packed, 4 Committed, 5 Verified — the last
 * three are the executed tx being batched, committed and proven on L1, all
 * AFTER execution. A tx reaches Committed within about a minute and Verified
 * within minutes, so a parser that knew only 0..3 would turn every later
 * lookup of our own executed tx into `malformed`: a rule-9 row read after a
 * restart, a slow reconcile or a timed-out sendTx could then never resolve.
 */
export type TxStatus = "failed" | "pending" | "executed" | "packed" | "committed" | "verified";

const TX_STATUS: readonly TxStatus[] = ["failed", "pending", "executed", "packed", "committed", "verified"];

/**
 * What rule 9 does with the row — the one field a caller branches on.
 *
 *   rejected   status 0: failed, FINAL, the nonce consumed.
 *   app-error  the venue executed the tx and its application refused it
 *              (`event_info.ae` non-empty — lighter-ts' checkTxStatus counts
 *              `status === Failed || !!ae` as a failure). FINAL, the nonce
 *              consumed, and NOT executed: whatever the order was, it did not
 *              happen as asked. Any fill the venue did make is still ingested
 *              by venue identity (rule 10), never booked from this row.
 *   pending    status 1: still `submitted`.
 *   executed   status 2..5 with no application error: ingest fills.
 */
export type TxOutcome = "rejected" | "app-error" | "pending" | "executed";

export interface TxRead {
  hash: string;
  type: number;
  /** The venue's lifecycle stage (see TxStatus). Callers resolve on `outcome`. */
  status: TxStatus;
  statusCode: 0 | 1 | 2 | 3 | 4 | 5;
  /** Rule 9's resolution of this read (see TxOutcome). */
  outcome: TxOutcome;
  /** The tx_info as the venue stored it. */
  info: string;
  accountIndex: number;
  apiKeyIndex: number;
  nonce: number;
  expireAtMs: number;
  blockHeight: number;
  queuedAtMs: number;
  executedAtMs: number;
  /** The venue's application error ("" when none; null when event_info did not carry one). */
  appError: string | null;
  marketId: number | null;
  /**
   * The taker order's venue order index (`to.i`) — what trades are filtered
   * by — as a decimal string, like VenueOrder.orderIndex and the
   * PerpTrade.*OrderIndex fields. Null when absent, or when this runtime
   * could not recover the exact digits of a value past 2^53.
   */
  orderIndex: string | null;
  /** The taker order's client order index (`to.u`); the venue caps these at 2^48 − 1. */
  clientOrderIndex: number | null;
}

/**
 * JSON.parse reviver: an integer past 2^53 comes back as a bigint read from
 * its SOURCE TEXT (the reviver's third argument), never as the rounded double
 * JSON.parse already made of it. Lighter order indexes are
 * `(market_id + 1) << 48` plus a sequence, so every order on a market with id
 * ≥ 31 — MU, PLTR, XAU, TSM, AMC and twenty more of the 57 — has one. A
 * runtime without source access leaves the rounded number, which the caller
 * treats as unrepresentable (null), never as the index.
 */
function exactBigInts(_key: string, value: unknown, context?: { source?: unknown }): unknown {
  if (typeof value === "number" && !Number.isSafeInteger(value) && typeof context?.source === "string" && /^-?\d{1,40}$/.test(context.source)) {
    return BigInt(context.source);
  }
  return value;
}

/**
 * A venue order index as a decimal string; null when it is an integer this
 * runtime could only see rounded; undefined when it is not an order index at
 * all (a string, a fraction, zero or below — the answer is malformed).
 */
function exactOrderIndex(x: unknown): string | null | undefined {
  if (typeof x === "bigint") return x >= 1n && x < 2n ** 64n ? x.toString() : undefined;
  if (typeof x !== "number" || !Number.isInteger(x) || x < 1) return undefined;
  return Number.isSafeInteger(x) ? String(x) : null;
}

/**
 * GET /api/v1/tx?by=hash → one tx, or null.
 *
 * `event_info` is read tolerantly on purpose: its shape was observed for
 * CreateOrder only (`m`, `to.i`, `to.u`, `ae`); for grouped orders and
 * cancels it is unknown, and a row must still resolve on `status`. So known
 * fields are extracted when present, a known field of the WRONG type refuses
 * the read, and event_info that is not JSON at all refuses it too. An order
 * index too large for a double is NOT the wrong type: it is read exactly from
 * the text (event_info is JSON inside a JSON string, so its digits reach us
 * intact), or left null — it never makes the whole tx unread.
 */
export function parseTx(raw: unknown, expectHash?: string): TxRead | null {
  if (!isRecord(raw)) return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  const hash = typeof raw.hash === "string" ? raw.hash.replace(/^0x/, "").toLowerCase() : "";
  if (!HASH_RE.test(hash)) return null;
  if (expectHash !== undefined && expectHash.replace(/^0x/, "").toLowerCase() !== hash) return null;
  const type = safeInt(raw.type, 0, 255);
  const statusCode = safeInt(raw.status, 0, 5) as 0 | 1 | 2 | 3 | 4 | 5 | null;
  const accountIndex = safeInt(raw.account_index, 0);
  const apiKeyIndex = safeInt(raw.api_key_index, 0, 255);
  const nonce = safeInt(raw.nonce, 0);
  const expireAtMs = safeInt(raw.expire_at, 0);
  const blockHeight = safeInt(raw.block_height, 0);
  const queuedAtMs = safeInt(raw.queued_at, 0);
  const executedAtMs = safeInt(raw.executed_at, 0);
  if (
    type === null ||
    statusCode === null ||
    accountIndex === null ||
    apiKeyIndex === null ||
    nonce === null ||
    expireAtMs === null ||
    blockHeight === null ||
    queuedAtMs === null ||
    executedAtMs === null ||
    typeof raw.info !== "string"
  ) {
    return null;
  }
  let appError: string | null = null;
  let marketId: number | null = null;
  let orderIndex: string | null = null;
  let clientOrderIndex: number | null = null;
  if (typeof raw.event_info !== "string") return null;
  if (raw.event_info !== "") {
    let ev: unknown;
    try {
      ev = JSON.parse(raw.event_info, exactBigInts as Parameters<typeof JSON.parse>[1]);
    } catch {
      return null;
    }
    if (!isRecord(ev)) return null;
    if ("ae" in ev) {
      if (typeof ev.ae !== "string") return null;
      appError = ev.ae;
    }
    if ("m" in ev) {
      marketId = safeInt(ev.m, 0, 32_767);
      if (marketId === null) return null;
    }
    if ("to" in ev) {
      if (!isRecord(ev.to)) return null;
      const oi = exactOrderIndex(ev.to.i);
      clientOrderIndex = safeInt(ev.to.u, 0);
      if (oi === undefined || clientOrderIndex === null) return null;
      orderIndex = oi;
    }
  }
  const outcome: TxOutcome =
    statusCode === 0 ? "rejected" : appError !== null && appError !== "" ? "app-error" : statusCode === 1 ? "pending" : "executed";
  return {
    hash,
    type,
    status: TX_STATUS[statusCode] as TxStatus,
    statusCode,
    outcome,
    info: raw.info,
    accountIndex,
    apiKeyIndex,
    nonce,
    expireAtMs,
    blockHeight,
    queuedAtMs,
    executedAtMs,
    appError,
    marketId,
    orderIndex,
    clientOrderIndex,
  };
}

/** POST /api/v1/sendTx 200 body → the venue's receipt, or null. */
export function parseSendTx(raw: unknown): { txHash: string; predictedExecutionMs: number | null; volumeQuotaRemaining: number | null } | null {
  if (!isRecord(raw) || raw.code !== 200) return null;
  const txHash = typeof raw.tx_hash === "string" ? raw.tx_hash.replace(/^0x/, "").toLowerCase() : "";
  if (!HASH_RE.test(txHash)) return null;
  const predicted = "predicted_execution_time_ms" in raw ? safeInt(raw.predicted_execution_time_ms, 0) : null;
  const quota = "volume_quota_remaining" in raw ? safeInt(raw.volume_quota_remaining) : null;
  return { txHash, predictedExecutionMs: predicted, volumeQuotaRemaining: quota };
}

// ── trades ──────────────────────────────────────────────────────────────────

export type TradeType = "trade" | "liquidation" | "deleverage" | "market-settlement";
const TRADE_TYPES: readonly TradeType[] = ["trade", "liquidation", "deleverage", "market-settlement"];

/** Our side of a trade. A self-trade (our close hitting our own resting order) is TWO of these. */
export interface OurTradeSide {
  side: "ask" | "bid";
  role: "maker" | "taker";
  /** millionths of notional (maker_fee 102 = 0.0102%) */
  feePpm: number;
}

export interface PerpTrade {
  /** trade_id_str — the string, because ids are compared and stored, never added. */
  tradeId: string;
  txHash: string;
  type: TradeType;
  marketId: number;
  /** venue base units */
  size: bigint;
  /** venue price units */
  price: bigint;
  usdAmountMicro: bigint;
  askOrderIndex: string;
  bidOrderIndex: string;
  askClientOrderIndex: string;
  bidClientOrderIndex: string;
  askAccountIndex: number;
  bidAccountIndex: number;
  isMakerAsk: boolean;
  /** ms */
  timestampMs: number;
  /** µs */
  transactionTimeUs: number;
  blockHeight: number;
  takerFeePpm: number;
  makerFeePpm: number;
  takerPositionSignChanged: boolean;
  makerPositionSignChanged: boolean;
  /** Signed, venue base units. */
  takerPositionSizeBefore: bigint;
  makerPositionSizeBefore: bigint;
  takerEntryQuoteBeforeMicro: bigint;
  makerEntryQuoteBeforeMicro: bigint;
  /** Absent in public responses: null is "not said", never zero. */
  askAccountPnlMicro: bigint | null;
  bidAccountPnlMicro: bigint | null;
  /** Filled only when parseTrades is given the account to look for. */
  ours: OurTradeSide[];
}

/**
 * GET /api/v1/trades or /recentTrades → trades, or null.
 *
 * omitempty allowlist (absent = 0 / false): taker_fee, maker_fee,
 * integrator_{taker,maker}_fee, *_position_sign_changed,
 * *_initial_margin_fraction_before. `ask_account_pnl`/`bid_account_pnl` are
 * absent from public responses and become null — unknown, not zero. Every
 * other field is required; one bad trade refuses the page (a fill silently
 * skipped is money the venue-delta identity will never explain).
 */
export function parseTrades(
  raw: unknown,
  decimals: ReadonlyMap<number, PerpDecimals>,
  opts?: { accountIndex?: number },
): { trades: PerpTrade[]; nextCursor: string | null } | null {
  if (!isRecord(raw) || !Array.isArray(raw.trades)) return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  const trades: PerpTrade[] = [];
  for (const t of raw.trades) {
    if (!isRecord(t)) return null;
    const tradeId = typeof t.trade_id_str === "string" && ID_STR_RE.test(t.trade_id_str) ? t.trade_id_str : null;
    const txHash = typeof t.tx_hash === "string" && HASH_RE.test(t.tx_hash) ? t.tx_hash : null;
    const type = TRADE_TYPES.find((x) => x === t.type) ?? null;
    const marketId = safeInt(t.market_id, 0, 32_767);
    if (tradeId === null || txHash === null || type === null || marketId === null) return null;
    const d = decimals.get(marketId);
    if (d === undefined) return null;
    const size = positiveScaled(t.size, d.sizeDecimals);
    const price = positiveScaled(t.price, d.priceDecimals);
    const usdAmountMicro = parseMicroUsdg(t.usd_amount);
    if (size === null || price === null || usdAmountMicro === null || usdAmountMicro < 0n) return null;
    const ids = [t.ask_id_str, t.bid_id_str, t.ask_client_id_str, t.bid_client_id_str];
    if (!ids.every((x) => typeof x === "string" && ID_STR_RE.test(x))) return null;
    const askAccountIndex = safeInt(t.ask_account_id, 0);
    const bidAccountIndex = safeInt(t.bid_account_id, 0);
    const timestampMs = safeInt(t.timestamp, 0);
    const transactionTimeUs = safeInt(t.transaction_time, 0);
    const blockHeight = safeInt(t.block_height, 0);
    if (askAccountIndex === null || bidAccountIndex === null || timestampMs === null || transactionTimeUs === null || blockHeight === null) return null;
    if (typeof t.is_maker_ask !== "boolean") return null;
    const takerFeePpm = omitZeroInt(t, "taker_fee", 0, 1_000_000);
    const makerFeePpm = omitZeroInt(t, "maker_fee", -1_000_000, 1_000_000);
    const itf = omitZeroInt(t, "integrator_taker_fee", 0, 1_000_000);
    const imf = omitZeroInt(t, "integrator_maker_fee", 0, 1_000_000);
    const takerPositionSignChanged = omitFalse(t, "taker_position_sign_changed");
    const makerPositionSignChanged = omitFalse(t, "maker_position_sign_changed");
    const tImf = omitZeroInt(t, "taker_initial_margin_fraction_before", 0, 10_000);
    const mImf = omitZeroInt(t, "maker_initial_margin_fraction_before", 0, 10_000);
    if (
      takerFeePpm === null ||
      makerFeePpm === null ||
      itf === null ||
      imf === null ||
      takerPositionSignChanged === null ||
      makerPositionSignChanged === null ||
      tImf === null ||
      mImf === null
    ) {
      return null;
    }
    const takerPositionSizeBefore = parseDecimalToScaled(t.taker_position_size_before, d.sizeDecimals);
    const makerPositionSizeBefore = parseDecimalToScaled(t.maker_position_size_before, d.sizeDecimals);
    const takerEntryQuoteBeforeMicro = parseMicroUsdg(t.taker_entry_quote_before);
    const makerEntryQuoteBeforeMicro = parseMicroUsdg(t.maker_entry_quote_before);
    if (takerPositionSizeBefore === null || makerPositionSizeBefore === null || takerEntryQuoteBeforeMicro === null || makerEntryQuoteBeforeMicro === null) {
      return null;
    }
    const pnl = (k: string): bigint | null | "bad" => {
      if (!(k in t)) return null;
      const v = parseMicroUsdg(t[k]);
      return v === null ? "bad" : v;
    };
    const askAccountPnlMicro = pnl("ask_account_pnl");
    const bidAccountPnlMicro = pnl("bid_account_pnl");
    if (askAccountPnlMicro === "bad" || bidAccountPnlMicro === "bad") return null;
    const ours: OurTradeSide[] = [];
    const me = opts?.accountIndex;
    if (me !== undefined) {
      // Maker/taker per side from is_maker_ask; a self-trade matches both.
      if (askAccountIndex === me) ours.push({ side: "ask", role: t.is_maker_ask ? "maker" : "taker", feePpm: t.is_maker_ask ? makerFeePpm : takerFeePpm });
      if (bidAccountIndex === me) ours.push({ side: "bid", role: t.is_maker_ask ? "taker" : "maker", feePpm: t.is_maker_ask ? takerFeePpm : makerFeePpm });
    }
    trades.push({
      tradeId,
      txHash,
      type,
      marketId,
      size,
      price,
      usdAmountMicro,
      askOrderIndex: t.ask_id_str as string,
      bidOrderIndex: t.bid_id_str as string,
      askClientOrderIndex: t.ask_client_id_str as string,
      bidClientOrderIndex: t.bid_client_id_str as string,
      askAccountIndex,
      bidAccountIndex,
      isMakerAsk: t.is_maker_ask,
      timestampMs,
      transactionTimeUs,
      blockHeight,
      takerFeePpm,
      makerFeePpm,
      takerPositionSignChanged,
      makerPositionSignChanged,
      takerPositionSizeBefore,
      makerPositionSizeBefore,
      takerEntryQuoteBeforeMicro,
      makerEntryQuoteBeforeMicro,
      askAccountPnlMicro,
      bidAccountPnlMicro,
      ours,
    });
  }
  const nextCursor = typeof raw.next_cursor === "string" && raw.next_cursor !== "" ? raw.next_cursor : null;
  return { trades, nextCursor };
}

// ── orders ──────────────────────────────────────────────────────────────────

export const ORDER_STATUSES = [
  "in-progress",
  "pending",
  "open",
  "filled",
  "canceled",
  "canceled-post-only",
  "canceled-reduce-only",
  "canceled-position-not-allowed",
  "canceled-margin-not-allowed",
  "canceled-too-much-slippage",
  "canceled-not-enough-liquidity",
  "canceled-self-trade",
  "canceled-expired",
  "canceled-oco",
  "canceled-child",
  "canceled-liquidation",
  "canceled-invalid-balance",
] as const;
export type VenueOrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TYPES = [
  "limit",
  "market",
  "stop-loss",
  "stop-loss-limit",
  "take-profit",
  "take-profit-limit",
  "twap",
  "twap-sub",
  "liquidation",
] as const;
export type VenueOrderType = (typeof ORDER_TYPES)[number];

export interface VenueOrder {
  /** order_id: the venue's order index, as a string (it reaches 2^60). */
  orderIndex: string;
  /** client_order_id; "0" when the order has none (grouped children unless we assign one). */
  clientOrderIndex: string;
  marketId: number;
  ownerAccountIndex: number;
  isAsk: boolean;
  type: VenueOrderType;
  timeInForce: "good-till-time" | "immediate-or-cancel" | "post-only" | "Unknown";
  reduceOnly: boolean;
  status: VenueOrderStatus;
  triggerStatus: "na" | "ready" | "mark-price" | "twap" | "parent-order";
  /** venue price units */
  price: bigint;
  /** 0n when the order has no trigger */
  triggerPrice: bigint;
  /** venue base units; 0n on a position-tied order (it closes whatever is held) */
  initialBaseAmount: bigint;
  remainingBaseAmount: bigint;
  filledBaseAmount: bigint;
  filledQuoteMicro: bigint;
  /** ms; 0 when none */
  orderExpiryMs: number;
  nonce: number;
  /** "0" when not a child */
  parentOrderIndex: string;
  timestampMs: number;
}

/**
 * GET /api/v1/accountActiveOrders | accountInactiveOrders (auth) → orders, or
 * null. Built from lighter-python's openapi — these endpoints need the
 * account's own token, so there is no live capture yet (a Phase-0 checklist
 * item). The omitempty allowlist is the Go zero values the schema marks
 * required: is_ask/reduce_only (false), order_expiry/trigger_time and
 * parent_order_index (0). Everything else is required.
 */
export function parseOrders(raw: unknown, decimals: ReadonlyMap<number, PerpDecimals>): { orders: VenueOrder[]; nextCursor: string | null } | null {
  if (!isRecord(raw) || !Array.isArray(raw.orders)) return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  const orders: VenueOrder[] = [];
  for (const o of raw.orders) {
    if (!isRecord(o)) return null;
    const marketId = safeInt(o.market_index, 0, 32_767);
    if (marketId === null) return null;
    const d = decimals.get(marketId);
    if (d === undefined) return null;
    const orderIndex = typeof o.order_id === "string" && ID_STR_RE.test(o.order_id) ? o.order_id : null;
    const clientOrderIndex = typeof o.client_order_id === "string" && ID_STR_RE.test(o.client_order_id) ? o.client_order_id : null;
    const ownerAccountIndex = safeInt(o.owner_account_index, 0);
    const isAsk = omitFalse(o, "is_ask");
    const reduceOnly = omitFalse(o, "reduce_only");
    const type = ORDER_TYPES.find((t) => t === o.type) ?? null;
    const status = ORDER_STATUSES.find((s) => s === o.status) ?? null;
    const tif =
      o.time_in_force === "good-till-time" || o.time_in_force === "immediate-or-cancel" || o.time_in_force === "post-only" || o.time_in_force === "Unknown"
        ? o.time_in_force
        : null;
    const triggerStatus =
      o.trigger_status === "na" || o.trigger_status === "ready" || o.trigger_status === "mark-price" || o.trigger_status === "twap" || o.trigger_status === "parent-order"
        ? o.trigger_status
        : null;
    const price = parseDecimalToScaled(o.price, d.priceDecimals);
    const triggerPrice = parseDecimalToScaled(o.trigger_price, d.priceDecimals);
    const initialBaseAmount = parseDecimalToScaled(o.initial_base_amount, d.sizeDecimals);
    const remainingBaseAmount = parseDecimalToScaled(o.remaining_base_amount, d.sizeDecimals);
    const filledBaseAmount = parseDecimalToScaled(o.filled_base_amount, d.sizeDecimals);
    const filledQuoteMicro = parseMicroUsdg(o.filled_quote_amount);
    const orderExpiryMs = omitZeroInt(o, "order_expiry");
    const nonce = safeInt(o.nonce, 0);
    const parentIdx = "parent_order_id" in o ? o.parent_order_id : "0";
    const parentOrderIndex = typeof parentIdx === "string" && ID_STR_RE.test(parentIdx) ? parentIdx : null;
    const timestampMs = safeInt(o.timestamp, 0);
    if (
      orderIndex === null ||
      clientOrderIndex === null ||
      ownerAccountIndex === null ||
      isAsk === null ||
      reduceOnly === null ||
      type === null ||
      status === null ||
      tif === null ||
      triggerStatus === null ||
      price === null ||
      price < 0n ||
      triggerPrice === null ||
      triggerPrice < 0n ||
      initialBaseAmount === null ||
      initialBaseAmount < 0n ||
      remainingBaseAmount === null ||
      remainingBaseAmount < 0n ||
      filledBaseAmount === null ||
      filledBaseAmount < 0n ||
      filledQuoteMicro === null ||
      filledQuoteMicro < 0n ||
      orderExpiryMs === null ||
      nonce === null ||
      parentOrderIndex === null ||
      timestampMs === null
    ) {
      return null;
    }
    orders.push({
      orderIndex,
      clientOrderIndex,
      marketId,
      ownerAccountIndex,
      isAsk,
      type,
      timeInForce: tif,
      reduceOnly,
      status,
      triggerStatus,
      price,
      triggerPrice,
      initialBaseAmount,
      remainingBaseAmount,
      filledBaseAmount,
      filledQuoteMicro,
      orderExpiryMs,
      nonce,
      parentOrderIndex,
      timestampMs,
    });
  }
  const nextCursor = typeof raw.next_cursor === "string" && raw.next_cursor !== "" ? raw.next_cursor : null;
  return { orders, nextCursor };
}

// ── withdrawals ─────────────────────────────────────────────────────────────

export interface WithdrawHistoryRow {
  id: string;
  amountMicro: bigint;
  timestampSec: number;
  status: "failed" | "pending" | "claimable" | "refunded" | "completed";
  type: "secure" | "fast";
  l1TxHash: string | null;
  assetId: number;
}

const WITHDRAW_STATUS = ["failed", "pending", "claimable", "refunded", "completed"] as const;

/** GET /api/v1/withdraw/history (auth) → rows, or null. Shape per openapi (no live capture: auth-gated). */
export function parseWithdrawHistory(raw: unknown): { rows: WithdrawHistoryRow[]; cursor: string | null } | null {
  if (!isRecord(raw) || !Array.isArray(raw.withdraws)) return null;
  if (raw.code !== undefined && raw.code !== 200) return null;
  const rows: WithdrawHistoryRow[] = [];
  for (const w of raw.withdraws) {
    if (!isRecord(w)) return null;
    const id = typeof w.id === "string" && w.id !== "" && w.id.length <= 100 ? w.id : null;
    const amountMicro = parseMicroUsdg(w.amount);
    const timestampSec = safeInt(w.timestamp, 0);
    const assetId = safeInt(w.asset_id, 0, 32_767);
    const status = WITHDRAW_STATUS.find((s) => s === w.status) ?? null;
    const type = w.type === "secure" || w.type === "fast" ? w.type : null;
    if (id === null || amountMicro === null || amountMicro < 0n || timestampSec === null || assetId === null || status === null || type === null) return null;
    if (typeof w.l1_tx_hash !== "string") return null;
    const l1TxHash = /^0x[0-9a-fA-F]{64}$/.test(w.l1_tx_hash) ? w.l1_tx_hash.toLowerCase() : null;
    rows.push({ id, amountMicro, timestampSec, status, type, l1TxHash, assetId });
  }
  const cursor = typeof raw.cursor === "string" && raw.cursor !== "" ? raw.cursor : null;
  return { rows, cursor };
}
