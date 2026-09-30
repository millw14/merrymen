/**
 * THE PAPER VENUE — Lighter's own rules, run against Lighter's own live book,
 * with nothing sent anywhere (docs/perps.md rule 14).
 *
 * "Paper first, at live prices, with the venue's own rules": an IOC walks the
 * book the feed carries and never fills past its worst price; margin is
 * isolated, posted from the paper book's cash at the venue's IMF and returned
 * with the realized P&L on the way out; funding is hourly on the venue's
 * published rate; a resting stop is a bounded-price IOC that a gap can leave
 * unfilled; and a position whose mark crosses its maintenance line is
 * liquidated with the venue's fee. A paper book that is kinder than the venue
 * in any of these teaches an owner that leverage is safer than it is, so
 * every rounding and every modelling choice below leans AGAINST the account.
 *
 * PURE. No clock, no file, no database, no feed: the executor (executor.ts)
 * reads those and books what these functions return, one action per
 * transaction. Every function takes the book it acts on and returns the next
 * one beside the facts that moved it — the fills, the funding, the cash delta,
 * the resting children that ended — so a test can drive the venue without a
 * ledger and the ledger can refuse a step computed from a book it no longer
 * holds (store.ts bookPaperPerp's `expect`).
 *
 * THE VENUE MODEL, and where each piece comes from (the research notes cite
 * Lighter's docs and the probes; review notes by finding id):
 *
 *   Matching     A market order is an IOC with a worst price; its unfilled
 *                remainder is cancelled (docs/perps.md venue table, "Orders").
 *                The official lighter-python paper client walks the live book
 *                the same way — it is the reference for book-walking ONLY
 *                (venue-signer-spike.md liquidation-and-margin-units: it is
 *                cross-margin, fee-less and funding-less, and is not ported).
 *   Settlement   A multi-level IOC settles at ONE whole-tick price, the
 *                volume-weighted average rounded against the taker (a buy up,
 *                a sell down). A position's entry is one integer price in the
 *                ledger and in the checkpoint (perp_positions.entry_price), so
 *                the paper book's cost basis is exactly entry × size by
 *                construction and the sub-tick of a walk is never the
 *                account's. The levels actually taken ride along for the
 *                receipt.
 *   Fees         Taker fee in parts per million of the settled notional, from
 *                the feed (orderBookDetails), rounded UP. Standard accounts
 *                are 0/0 today, so this is usually zero — but it is read, not
 *                assumed.
 *   Margin       Isolated only. Allocated margin at open = notional at fill ×
 *                IMF (isolatedMarginMicro, rounded up), drawn from the paper
 *                book's cash with the fee (spike: "Allocated margin at open =
 *                notional × IMF_user", 4838 LIT 1546.17 vs 7731.15 × 0.20).
 *                Realized P&L and fees settle INTO the isolated margin, and a
 *                reduce releases its proportional share of the margin plus
 *                that P&L to cash. A loss larger than the share comes out of
 *                the margin left behind, never out of cash; a loss larger than
 *                the whole margin is the insurance fund's (isolation is the
 *                point of isolated margin), and the booked realized is capped
 *                so the book's identity still closes.
 *   Funding      Hourly, peer to peer. `value = index × rate` per whole base
 *                unit, paid by the side `direction` names (venue table,
 *                "Funding"; funding-units). Lighter's docs give payment =
 *                −position × index × rate, so a POSITIVE rate has longs pay
 *                and a negative one has shorts pay. A negative rate has never
 *                been observed on this instance, so the paper book follows
 *                the documented convention for the payer and credits the
 *                receiver NOTHING: a cost is booked on the documented rule, a
 *                gain is never booked on a guess. Funding debits and credits
 *                the position's allocated margin (liquidation-and-margin-
 *                units: "fees and funding debit AM"), capped at what is there.
 *   Stops        STOP_LOSS / TAKE_PROFIT children fire on MARK (venue table,
 *                "Orders"): long stop at mark ≤ trigger, short at mark ≥
 *                trigger (the take mirrors). A fired child is a reduce-only
 *                IOC bounded by its own price, sized to the position; it is
 *                consumed whether it fills, part-fills or finds no liquidity
 *                inside its bound — so a gap leaves the position OPEN and
 *                without that child, exactly as the venue does (rule 7), and
 *                the protective loop is what puts one back.
 *   Liquidation  Lighter's waterfall (research_lighter-api.md, docs.lighter.xyz
 *                trading/liquidations-and-llp-insurance-fund): healthy →
 *                pre-liquidation → PARTIAL (MMR > TAV ≥ CMR: orders
 *                cancelled, the position sold at a "zero price" IOC, a fee of
 *                up to liquidation_fee = 1% of notional to the insurance
 *                fund) → FULL (TAV < CMR: the LLP takes the position over and
 *                the margin with it). Isolated positions liquidate on their
 *                own margin alone. Paper, per position, with TAV = AM + U at
 *                mark, MMR = |s| × mark × MMF and CMR = |s| × mark × closeout:
 *                  · triggered when mark crosses the isolated liquidation
 *                    price (core isolatedLiqPrice with the MARKET's MMF —
 *                    liquidation-and-margin-units — rounded toward the entry,
 *                    so paper liquidates a tick sooner, never later);
 *                  · TAV ≥ CMR: closed at the liquidation price, or at the
 *                    mark if the mark has already gapped past it (a zero-price
 *                    IOC is never filled better than the mark the venue saw);
 *                    fee = liquidation_fee × notional, capped at the margin
 *                    left; the rest of the margin comes home;
 *                  · TAV < CMR: taken over — closed at the mark and every
 *                    micro of margin left is forfeited (booked as the fee).
 *                Every resting child of the market is cancelled first.
 *
 * WHAT IS NOT MODELLED, said so it is not mistaken for modelled: the venue's
 * 300 ms taker latency (the paper IOC fills against the book as read); ADL of
 * profitable positions; the book a paper fill consumes (it is not depleted for
 * the next one); cross margin, which merrymen never uses; and THE TIME THE
 * WORKER WAS NOT RUNNING. Stops, take-profits and liquidation are judged only
 * on the mark a pass reads: a mark that crossed a stop or the liquidation
 * line while nothing was running, and came back, leaves the paper position
 * open where the venue would have closed it — there is no candle replay
 * (docs/perps.md, "Honest limits"). Missed FUNDING is not in that list: every
 * owed hour is charged from the feed's hourly history (executor.ts tick),
 * and an hour the feed does not carry is unread, never zero.
 */

import {
  PERP_MAX_ORDER_PRICE,
  fundingPaymentMicro,
  isolatedLiqPrice,
  isolatedMarginMicro,
  notionalMicro,
  unrealizedPnlMicro,
  type PerpMarketSpec,
  type PerpSide,
} from "../../../packages/core/src/perps";
import type { PerpAttribution, PerpLegStatus, PerpTradeType } from "../perp-ledger-rules";
import type { DepthLevel } from "./markets";

// ── the refusal both executors throw ────────────────────────────────────────

/**
 * AN ORDER THE VENUE (OR ITS PAPER TWIN) WILL NOT TAKE, with the rule slug the
 * owner is told (thesis-policy.ts WITHHELD_REJECT_RULES carries the words).
 * Nothing was booked when this is thrown.
 *
 * Defined here, in the lowest layer, because the pure engine refuses too (an
 * open that would add to a position, margin the paper cash cannot fund) and
 * executor.ts re-exports it for both of its implementations.
 */
export class PerpRefused extends Error {
  constructor(
    readonly rule: string,
    readonly detail: string,
  ) {
    super(`${rule}: ${detail}`);
    this.name = "PerpRefused";
  }
}

// ── units ───────────────────────────────────────────────────────────────────

const MICRO = 1_000_000n;
const BP = 10_000n;
const HOUR_SEC = 3600;

/**
 * Lighter's liquidation fee when a spec does not carry one: orderBookDetails
 * reads `liquidation_fee "1.0000"` (percent) on every perp today, and the docs
 * call it "up to 1%". The maximum, so an unread fee is never smaller than the
 * venue's.
 */
export const PAPER_DEFAULT_LIQUIDATION_FEE_BP = 100;

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a > 0n ? q + 1n : q;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** The start of the hour a unix-second instant falls in. */
export function hourOf(sec: number): number {
  return Math.floor(sec / HOUR_SEC) * HOUR_SEC;
}

// ── the book walk ───────────────────────────────────────────────────────────

/** One market's book as the feed carries it: venue integers, best first. */
export interface PaperBookLevels {
  bids: readonly DepthLevel[];
  asks: readonly DepthLevel[];
}

export interface TakerFill {
  /** A sell (walks the bids) when true, a buy (walks the asks) when false. */
  isAsk: boolean;
  requestedBase: bigint;
  filledBase: bigint;
  /**
   * What the paper venue SETTLES: filledBase at avgPrice, micro-USDG, rounded
   * against the taker (a buy pays the ceiling, a sell receives the floor).
   */
  filledQuoteMicro: bigint;
  /** The whole-tick settlement price — the VWAP rounded against the taker; null when nothing filled. */
  avgPrice: bigint | null;
  /** Taker fee on filledQuoteMicro, rounded up. */
  feeMicro: bigint;
  /** The levels actually taken, best first, at their own prices — for the receipt. */
  levels: DepthLevel[];
}

function assertBook(levels: readonly DepthLevel[], dir: "bids" | "asks"): void {
  let prev: bigint | null = null;
  for (const lv of levels) {
    if (typeof lv.price !== "bigint" || typeof lv.baseAmount !== "bigint" || lv.price <= 0n || lv.baseAmount <= 0n) {
      throw new RangeError(`simulateTakerFill: a ${dir} level is not a positive venue price and size`);
    }
    if (prev !== null && (dir === "bids" ? lv.price >= prev : lv.price <= prev)) {
      throw new RangeError(`simulateTakerFill: the ${dir} are not strictly ${dir === "bids" ? "descending" : "ascending"}`);
    }
    prev = lv.price;
  }
}

/**
 * AN IOC TAKER ORDER AGAINST THE BOOK, exactly as far as the venue would take
 * it: level by level from the best price, never past `worstPrice` (a sell
 * takes no bid below it, a buy no ask above it), and whatever is left is
 * cancelled, not rested. The settlement price rounds against the taker, and so
 * does the notional and the fee — the paper account never gets the sub-tick.
 *
 * Throws on a malformed input (a size or bound that is not a positive venue
 * integer, a book out of order): the caller built something wrong, and a
 * fill against a book we cannot trust is not a fill.
 */
export function simulateTakerFill(args: {
  isAsk: boolean;
  baseAmount: bigint;
  worstPrice: bigint;
  book: PaperBookLevels;
  spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals">;
  takerFeePpm: number;
}): TakerFill {
  const { isAsk, baseAmount, worstPrice } = args;
  if (typeof baseAmount !== "bigint" || baseAmount <= 0n) throw new RangeError("simulateTakerFill: baseAmount must be a positive bigint");
  if (typeof worstPrice !== "bigint" || worstPrice <= 0n || worstPrice > PERP_MAX_ORDER_PRICE) {
    throw new RangeError("simulateTakerFill: worstPrice must be a venue price in 1..2^32−1");
  }
  if (!Number.isSafeInteger(args.takerFeePpm) || args.takerFeePpm < 0 || args.takerFeePpm > 1_000_000) {
    throw new RangeError("simulateTakerFill: takerFeePpm must be an integer in 0..1000000");
  }
  const side = isAsk ? args.book.bids : args.book.asks;
  assertBook(side, isAsk ? "bids" : "asks");

  let remaining = baseAmount;
  let cost = 0n; // Σ size × price, venue units — exact
  const levels: DepthLevel[] = [];
  for (const lv of side) {
    if (remaining === 0n) break;
    if (isAsk ? lv.price < worstPrice : lv.price > worstPrice) break;
    const take = minBig(remaining, lv.baseAmount);
    levels.push({ price: lv.price, baseAmount: take });
    cost += take * lv.price;
    remaining -= take;
  }
  const filledBase = baseAmount - remaining;
  if (filledBase === 0n) {
    return { isAsk, requestedBase: baseAmount, filledBase: 0n, filledQuoteMicro: 0n, avgPrice: null, feeMicro: 0n, levels: [] };
  }
  // Every level taken is inside the bound, so the rounded VWAP is too: a
  // sell's floor is ≥ the worst price, a buy's ceiling ≤ it.
  const avgPrice = isAsk ? floorDiv(cost, filledBase) : ceilDiv(cost, filledBase);
  const filledQuoteMicro = notionalMicro(filledBase, avgPrice, args.spec, isAsk ? "floor" : "ceil");
  const feeMicro = ceilDiv(filledQuoteMicro * BigInt(args.takerFeePpm), MICRO);
  return { isAsk, requestedBase: baseAmount, filledBase, filledQuoteMicro, avgPrice, feeMicro, levels };
}

// ── the book ────────────────────────────────────────────────────────────────

/** A resting child's trigger (mark) and IOC bound, venue integers. */
export interface PaperTrigger {
  trigger: bigint;
  price: bigint;
}

/**
 * One isolated position. `entryPrice × baseAmount` IS the cost basis — see
 * "Settlement" above. `realizedMicro` and `fundingMicro` are what this
 * position has booked since it opened (display and the report); money moves
 * through cash and `allocatedMarginMicro` alone.
 */
export interface PaperPerpPosition {
  marketId: number;
  side: PerpSide;
  baseAmount: bigint;
  entryPrice: bigint;
  allocatedMarginMicro: bigint;
  imfBp: number;
  realizedMicro: bigint;
  fundingMicro: bigint;
  stop: PaperTrigger | null;
  take: PaperTrigger | null;
  openedAtSec: number;
  /** The last funding hour charged (unix seconds, on the hour) — the idempotency key. */
  fundingHourApplied: number | null;
}

/** The paper venue: the paper_book cash that funds perps, and every open position by market id. */
export interface PaperPerpBook {
  cashMicro: bigint;
  positions: ReadonlyMap<number, PaperPerpPosition>;
}

/** A fill as the ledger books it (store.ts PaperPerpFillBooking, before the leg is resolved). */
export interface PaperFillFact {
  venueTradeId: string;
  marketId: number;
  /** The POSITION side this fill trades — never "sell" (rule 15). */
  side: PerpSide;
  sideRole: "ask" | "bid";
  base: bigint;
  price: bigint;
  quoteMicro: bigint;
  feeMicro: bigint;
  realizedMicro: bigint;
  /** Signed: + long, − short. */
  positionBefore: bigint;
  entryQuoteBeforeMicro: bigint;
  tradeType: PerpTradeType;
  attribution: PerpAttribution;
  /** The leg that executed: the action's own entry/close, a resting sl/tp, or none (venue-forced). */
  leg: "entry" | "close" | "sl" | "tp" | null;
  venueTsMs: number;
}

export interface PaperFundingFact {
  fundingId: string;
  marketId: number;
  fundingHour: number;
  /** Signed from the holder's view: + received, − paid. */
  paymentMicro: bigint;
  ratePpm: number | null;
  positionBase: bigint;
  positionSide: PerpSide;
}

/** One step of the paper venue: the next book and everything that moved it. */
export interface PaperStep {
  book: PaperPerpBook;
  marketId: number;
  /** The position as the step found it — what the booking must still find. */
  before: PaperPerpPosition | null;
  /** The position after; null = flat. */
  after: PaperPerpPosition | null;
  fills: PaperFillFact[];
  funding: PaperFundingFact | null;
  /** Into (+) or out of (−) the paper book's cash. */
  cashDeltaMicro: bigint;
  /** Resting children of this market that end with the step. */
  restingEnds: { role: "sl" | "tp"; status: PerpLegStatus }[];
}

function withPosition(book: PaperPerpBook, marketId: number, pos: PaperPerpPosition | null, cashDelta: bigint): PaperPerpBook {
  const positions = new Map(book.positions);
  if (pos === null) positions.delete(marketId);
  else positions.set(marketId, pos);
  return { cashMicro: book.cashMicro + cashDelta, positions };
}

function unchanged(book: PaperPerpBook, marketId: number): PaperStep {
  const pos = book.positions.get(marketId) ?? null;
  return { book, marketId, before: pos, after: pos, fills: [], funding: null, cashDeltaMicro: 0n, restingEnds: [] };
}

function signedBase(p: PaperPerpPosition): bigint {
  return p.side === "long" ? p.baseAmount : -p.baseAmount;
}

function assertTrigger(side: PerpSide, t: PaperTrigger, kind: "stop" | "take"): void {
  const ok =
    typeof t.trigger === "bigint" &&
    typeof t.price === "bigint" &&
    t.trigger > 0n &&
    t.price > 0n &&
    t.trigger <= PERP_MAX_ORDER_PRICE &&
    t.price <= PERP_MAX_ORDER_PRICE &&
    // Both children EXIT: a long's sell takes no less than its bound, which
    // sits at or below the trigger; a short's buy mirrors it.
    (side === "long" ? t.price <= t.trigger : t.price >= t.trigger);
  if (!ok) throw new PerpRefused(kind === "stop" ? "perp-stop-required" : "perp-order-malformed", `the ${kind}'s trigger and bound are not an exit for a ${side}`);
}

// ── opening ─────────────────────────────────────────────────────────────────

/**
 * AN OPEN FILLED (or not) against the book: the position it makes, the margin
 * and fee it draws from cash, and its fill. The stop is a REQUIRED argument —
 * there is no way to call this without one (rule 7) — and it rests for as long
 * as the position lives. Refuses (PerpRefused, nothing moved) an open that
 * would add to a position (rule 6) or that the paper cash cannot margin.
 *
 * A zero fill is the IOC cancelled: the book is unchanged and there is no fact.
 */
export function applyPaperOpen(args: {
  book: PaperPerpBook;
  marketId: number;
  side: PerpSide;
  fill: TakerFill;
  imfBp: number;
  stop: PaperTrigger;
  take?: PaperTrigger | null;
  spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals">;
  nowMs: number;
  tradeId: string;
}): PaperStep {
  const { book, marketId, side, fill } = args;
  if (side !== "long" && side !== "short") throw new RangeError("applyPaperOpen: side must be long or short");
  if (fill.isAsk !== (side === "short")) throw new RangeError("applyPaperOpen: a long opens with a buy and a short with a sell");
  if (!Number.isSafeInteger(args.imfBp) || args.imfBp < 1 || args.imfBp > 10_000) throw new RangeError("applyPaperOpen: imfBp must be in 1..10000");
  if (book.positions.has(marketId)) {
    throw new PerpRefused("perp-add-to-position", "an open never adds to a position already held in this market (rule 6)");
  }
  if (!args.stop) throw new PerpRefused("perp-stop-required", "every open carries its own stop (rule 7)");
  assertTrigger(side, args.stop, "stop");
  const take = args.take ?? null;
  if (take !== null) assertTrigger(side, take, "take");
  if (fill.filledBase === 0n || fill.avgPrice === null) return unchanged(book, marketId);

  const entry = fill.avgPrice;
  // A stop that would fire the instant the position exists is not a stop.
  if (side === "long" ? args.stop.trigger >= entry : args.stop.trigger <= entry) {
    throw new PerpRefused("perp-stop-required", "the stop sits on the winning side of the fill, so it would close the position at once");
  }
  const margin = isolatedMarginMicro(fill.filledQuoteMicro, args.imfBp);
  const debit = margin + fill.feeMicro;
  if (book.cashMicro < debit) {
    throw new PerpRefused(
      "perp-collateral-cap",
      `the paper book holds ${book.cashMicro} micro-USDG and this open needs ${debit} as margin and fee`,
    );
  }
  const nowSec = Math.floor(args.nowMs / 1000);
  const after: PaperPerpPosition = {
    marketId,
    side,
    baseAmount: fill.filledBase,
    entryPrice: entry,
    allocatedMarginMicro: margin,
    imfBp: args.imfBp,
    realizedMicro: 0n,
    fundingMicro: 0n,
    stop: { trigger: args.stop.trigger, price: args.stop.price },
    take: take === null ? null : { trigger: take.trigger, price: take.price },
    openedAtSec: nowSec,
    // Funding is paid by positions held AT the hour: the hour already begun
    // is not this position's.
    fundingHourApplied: hourOf(nowSec),
  };
  const fact: PaperFillFact = {
    venueTradeId: args.tradeId,
    marketId,
    side,
    sideRole: fill.isAsk ? "ask" : "bid",
    base: fill.filledBase,
    price: entry,
    quoteMicro: fill.filledQuoteMicro,
    feeMicro: fill.feeMicro,
    realizedMicro: 0n,
    positionBefore: 0n,
    entryQuoteBeforeMicro: 0n,
    tradeType: "trade",
    attribution: "intent",
    leg: "entry",
    venueTsMs: args.nowMs,
  };
  return {
    book: withPosition(book, marketId, after, -debit),
    marketId,
    before: null,
    after,
    fills: [fact],
    funding: null,
    cashDeltaMicro: -debit,
    restingEnds: [],
  };
}

// ── reducing and closing ────────────────────────────────────────────────────

/**
 * A REDUCE-ONLY FILL against a position: realized P&L at the settlement price,
 * the margin share and P&L to cash (see "Margin" above), the position shrunk
 * or gone. Reduce-only NEVER FLIPS: a fill larger than the position throws —
 * the executor clamps an exit to the position before it walks the book, so
 * reaching this with more is a bug, not an order.
 *
 * `leg` says which order executed: the action's own `close` leg, or a resting
 * `sl`/`tp` child (which ends here: filled, or partial). When the position
 * goes flat every other resting child is cancelled with it.
 */
export function applyPaperReduce(args: {
  book: PaperPerpBook;
  marketId: number;
  fill: TakerFill;
  spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals">;
  nowMs: number;
  tradeId: string;
  leg: "close" | "sl" | "tp";
  attribution?: PerpAttribution;
}): PaperStep {
  const { book, marketId, fill } = args;
  const pos = book.positions.get(marketId);
  if (!pos) throw new PerpRefused("perp-no-position", "there is no paper position in this market to reduce");
  if (fill.isAsk !== (pos.side === "long")) throw new RangeError("applyPaperReduce: a long exits with a sell and a short with a buy");
  if (fill.filledBase > pos.baseAmount) throw new RangeError("applyPaperReduce: a reduce-only fill larger than the position would flip it");
  if (fill.filledBase === 0n || fill.avgPrice === null) return unchanged(book, marketId);

  const exit = fill.avgPrice;
  const closing = fill.filledBase === pos.baseAmount;
  let realized = unrealizedPnlMicro({ side: pos.side, baseAmount: fill.filledBase, entryPrice: pos.entryPrice, markPrice: exit, spec: args.spec });
  const share = closing ? pos.allocatedMarginMicro : floorDiv(pos.allocatedMarginMicro * fill.filledBase, pos.baseAmount);
  const out = share + realized - fill.feeMicro;
  let cashDelta: bigint;
  let marginAfter: bigint;
  if (out >= 0n) {
    cashDelta = out;
    marginAfter = pos.allocatedMarginMicro - share;
  } else {
    // Isolated: the shortfall comes out of the margin left behind, never cash.
    cashDelta = 0n;
    marginAfter = pos.allocatedMarginMicro - share + out;
    if (marginAfter < 0n) {
      // Past the whole margin: the insurance fund's, not the account's.
      realized -= marginAfter;
      marginAfter = 0n;
    }
  }

  const restingEnds: PaperStep["restingEnds"] = [];
  let stop = pos.stop;
  let take = pos.take;
  if (args.leg === "sl" || args.leg === "tp") {
    restingEnds.push({ role: args.leg, status: fill.filledBase === fill.requestedBase ? "filled" : "partial" });
    if (args.leg === "sl") stop = null;
    else take = null;
  }
  const after: PaperPerpPosition | null = closing
    ? null
    : {
        ...pos,
        baseAmount: pos.baseAmount - fill.filledBase,
        allocatedMarginMicro: marginAfter,
        realizedMicro: pos.realizedMicro + realized,
        stop,
        take,
      };
  if (after === null) {
    if (stop !== null) restingEnds.push({ role: "sl", status: "cancelled" });
    if (take !== null) restingEnds.push({ role: "tp", status: "cancelled" });
  }
  const fact: PaperFillFact = {
    venueTradeId: args.tradeId,
    marketId,
    side: pos.side,
    sideRole: fill.isAsk ? "ask" : "bid",
    base: fill.filledBase,
    price: exit,
    quoteMicro: fill.filledQuoteMicro,
    feeMicro: fill.feeMicro,
    realizedMicro: realized,
    positionBefore: signedBase(pos),
    entryQuoteBeforeMicro: notionalMicro(pos.baseAmount, pos.entryPrice, args.spec, "ceil"),
    tradeType: "trade",
    attribution: args.attribution ?? (args.leg === "close" ? "intent" : "venue-stop"),
    leg: args.leg,
    venueTsMs: args.nowMs,
  };
  return {
    book: withPosition(book, marketId, after, cashDelta),
    marketId,
    before: pos,
    after,
    fills: [fact],
    funding: null,
    cashDeltaMicro: cashDelta,
    restingEnds,
  };
}

/**
 * A CLOSE: a reduce whose order asked for the WHOLE position (rule 8: "a close
 * is always the full venue-read size"). It can still part-fill — an IOC is an
 * IOC — and then the position stays open, smaller, with its children.
 */
export function applyPaperClose(args: Omit<Parameters<typeof applyPaperReduce>[0], "leg">): PaperStep {
  const pos = args.book.positions.get(args.marketId);
  if (!pos) throw new PerpRefused("perp-no-position", "there is no paper position in this market to close");
  if (args.fill.requestedBase !== pos.baseAmount) throw new RangeError("applyPaperClose: a close asks for the whole position");
  return applyPaperReduce({ ...args, leg: "close" });
}

// ── funding ─────────────────────────────────────────────────────────────────

/**
 * The funding terms for one hour from the feed's rate, with the sign
 * convention written down once (see "Funding" above): the payer, the value
 * per whole base unit at a precision that loses nothing, and whether the
 * receiving side may be credited.
 *
 *   value per base (USDG) = index × rate = (index / 10^pd) × (ppm / 10^6)
 * so at valueDecimals = pd + 6 the scaled value is exactly index × |ppm|.
 */
export function paperFundingTerms(args: {
  index: bigint;
  ratePpm: number;
  spec: Pick<PerpMarketSpec, "priceDecimals">;
}): { valuePerBase: bigint; valueDecimals: number; direction: PerpSide; creditReceiver: boolean } {
  if (typeof args.index !== "bigint" || args.index <= 0n) throw new RangeError("paperFundingTerms: index must be a positive venue price");
  if (!Number.isSafeInteger(args.ratePpm)) throw new RangeError("paperFundingTerms: ratePpm must be an integer");
  const valueDecimals = args.spec.priceDecimals + 6;
  if (!Number.isSafeInteger(valueDecimals) || valueDecimals > 18) throw new RangeError("paperFundingTerms: price decimals out of range");
  const negative = args.ratePpm < 0;
  return {
    valuePerBase: args.index * BigInt(Math.abs(args.ratePpm)),
    valueDecimals,
    direction: negative ? "short" : "long",
    creditReceiver: !negative,
  };
}

/**
 * ONE HOUR'S FUNDING on one position, idempotent by the hour: an hour at or
 * before `fundingHourApplied` is null (already charged, or before the position
 * existed), so the same hour applied twice — a retried tick, a restart that
 * re-reads the same feed — moves nothing the second time. The caller books
 * the step with its `paper:funding:<market>:<hour>` identity, which the ledger
 * also keeps UNIQUE per market-hour.
 *
 * The payment moves the position's allocated margin; a charge larger than the
 * margin takes only what is there (the position is past liquidation, and the
 * trigger pass closes it).
 */
export function applyPaperFunding(args: {
  book: PaperPerpBook;
  marketId: number;
  fundingHour: number;
  valuePerBase: bigint;
  valueDecimals?: number;
  direction: PerpSide;
  creditReceiver?: boolean;
  ratePpm?: number | null;
  spec: Pick<PerpMarketSpec, "sizeDecimals">;
}): PaperStep | null {
  const pos = args.book.positions.get(args.marketId);
  if (!pos) return null;
  if (!Number.isSafeInteger(args.fundingHour) || args.fundingHour < 0 || args.fundingHour % HOUR_SEC !== 0) {
    throw new RangeError("applyPaperFunding: fundingHour must be unix seconds on the hour");
  }
  if (pos.fundingHourApplied !== null && args.fundingHour <= pos.fundingHourApplied) return null;
  // Only a position held AT the hour pays or receives it.
  if (pos.openedAtSec >= args.fundingHour) return null;
  let payment = fundingPaymentMicro({
    side: pos.side,
    baseAmount: pos.baseAmount,
    valuePerBase: args.valuePerBase,
    direction: args.direction,
    spec: args.spec,
    valueDecimals: args.valueDecimals ?? 6,
  });
  if (payment > 0n && args.creditReceiver === false) payment = 0n;
  if (pos.allocatedMarginMicro + payment < 0n) payment = -pos.allocatedMarginMicro;
  const after: PaperPerpPosition = {
    ...pos,
    allocatedMarginMicro: pos.allocatedMarginMicro + payment,
    fundingMicro: pos.fundingMicro + payment,
    fundingHourApplied: args.fundingHour,
  };
  return {
    book: withPosition(args.book, args.marketId, after, 0n),
    marketId: args.marketId,
    before: pos,
    after,
    fills: [],
    funding: {
      fundingId: `paper:funding:${args.marketId}:${args.fundingHour}`,
      marketId: args.marketId,
      fundingHour: args.fundingHour,
      paymentMicro: payment,
      ratePpm: args.ratePpm ?? null,
      positionBase: pos.baseAmount,
      positionSide: pos.side,
    },
    cashDeltaMicro: 0n,
    restingEnds: [],
  };
}

// ── liquidation ─────────────────────────────────────────────────────────────

/**
 * Where this position liquidates, from its CURRENT margin (funding moves it),
 * rounded toward the entry by core. Null: no positive price exists (a long
 * margined at 1x).
 */
export function paperLiqPrice(pos: PaperPerpPosition, spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals" | "mmfBp">): bigint | null {
  return isolatedLiqPrice({
    side: pos.side,
    entryPrice: pos.entryPrice,
    baseAmount: pos.baseAmount,
    allocatedMarginMicro: pos.allocatedMarginMicro,
    mmfBp: spec.mmfBp,
    spec,
  });
}

/** The liquidation the venue would run at `mark`, or null when the position is above its line. */
export function paperLiquidation(
  pos: PaperPerpPosition,
  mark: bigint,
  spec: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals" | "mmfBp" | "closeoutBp" | "liquidationFeeBp">,
): {
  liqPrice: bigint;
  kind: "partial" | "takeover";
  price: bigint;
  realizedMicro: bigint;
  feeMicro: bigint;
  returnedMicro: bigint;
} | null {
  if (mark <= 0n) throw new RangeError("paperLiquidation: mark must be positive");
  const liq = paperLiqPrice(pos, spec);
  if (liq === null) return null;
  const crossed = pos.side === "long" ? mark <= liq : mark >= liq;
  if (!crossed) return null;
  const am = pos.allocatedMarginMicro;
  const upnlAtMark = unrealizedPnlMicro({ side: pos.side, baseAmount: pos.baseAmount, entryPrice: pos.entryPrice, markPrice: mark, spec });
  const tav = am + upnlAtMark;
  const cmr = ceilDiv(notionalMicro(pos.baseAmount, mark, spec, "ceil") * BigInt(spec.closeoutBp), BP);
  const kind: "partial" | "takeover" = tav < cmr ? "takeover" : "partial";
  // A zero-price IOC is never filled better than the mark the venue saw.
  const price = kind === "takeover" ? mark : pos.side === "long" ? minBig(liq, mark) : mark > liq ? mark : liq;
  let realized = unrealizedPnlMicro({ side: pos.side, baseAmount: pos.baseAmount, entryPrice: pos.entryPrice, markPrice: price, spec });
  if (am + realized < 0n) realized = -am;
  const left = am + realized;
  const feeBp = BigInt(spec.liquidationFeeBp ?? PAPER_DEFAULT_LIQUIDATION_FEE_BP);
  const fee =
    kind === "takeover" ? left : minBig(ceilDiv(notionalMicro(pos.baseAmount, price, spec, "ceil") * feeBp, BP), left);
  return { liqPrice: liq, kind, price, realizedMicro: realized, feeMicro: fee, returnedMicro: left - fee };
}

// ── the resting orders and the liquidation engine ───────────────────────────

/** What the trigger pass knows about one market this tick. */
export interface PaperMarketRead {
  /** Fresh mark; null = unread (nothing fires on a price we do not have). */
  mark: bigint | null;
  /** Fresh book; null = too old to fill against (a stop cannot fire into it). */
  levels: PaperBookLevels | null;
  spec: PerpMarketSpec;
  takerFeePpm: number;
}

export type PaperTriggerKind = "sl" | "tp" | "liq";

export interface PaperTriggerEvent {
  kind: PaperTriggerKind;
  marketId: number;
  /** `paper:<kind>:<market>:<seq>` — the fill's venue identity. */
  id: string;
  mark: bigint;
  /** closed / reduced: the child filled; gapped: it fired and found nothing inside its bound. */
  outcome: "closed" | "reduced" | "gapped" | "liquidated" | "taken-over";
  step: PaperStep;
}

/**
 * A market the trigger pass could not judge, and which way: `mark` — no fresh
 * mark, so nothing fires (the protective loop's P7 speaks for a price
 * outage); `book` — a child the mark HAS crossed waits for a book fresh
 * enough to fill it against (the owner is told: a stop that should have fired
 * has not).
 */
export interface PaperTriggerUnread {
  marketId: number;
  kind: "mark" | "book";
  why: string;
}

/** The identity of a paper venue event. */
export function paperEventId(kind: string, marketId: number, seq: bigint | number): string {
  return `paper:${kind}:${marketId}:${seq}`;
}

function fireChild(
  book: PaperPerpBook,
  pos: PaperPerpPosition,
  kind: "sl" | "tp",
  child: PaperTrigger,
  read: PaperMarketRead & { mark: bigint; levels: PaperBookLevels },
  nowMs: number,
  seq: bigint | number,
): PaperTriggerEvent {
  const id = paperEventId(kind, pos.marketId, seq);
  const fill = simulateTakerFill({
    isAsk: pos.side === "long",
    baseAmount: pos.baseAmount,
    worstPrice: child.price,
    book: read.levels,
    spec: read.spec,
    takerFeePpm: read.takerFeePpm,
  });
  if (fill.filledBase === 0n) {
    // The venue's triggered IOC found nothing inside its bound and was
    // cancelled: the child is gone and the position is still open.
    const after: PaperPerpPosition = { ...pos, stop: kind === "sl" ? null : pos.stop, take: kind === "tp" ? null : pos.take };
    return {
      kind,
      marketId: pos.marketId,
      id,
      mark: read.mark,
      outcome: "gapped",
      step: {
        book: withPosition(book, pos.marketId, after, 0n),
        marketId: pos.marketId,
        before: pos,
        after,
        fills: [],
        funding: null,
        cashDeltaMicro: 0n,
        restingEnds: [{ role: kind, status: "cancelled" }],
      },
    };
  }
  const step = applyPaperReduce({ book, marketId: pos.marketId, fill, spec: read.spec, nowMs, tradeId: id, leg: kind, attribution: "venue-stop" });
  return { kind, marketId: pos.marketId, id, mark: read.mark, outcome: step.after === null ? "closed" : "reduced", step };
}

function liquidate(
  book: PaperPerpBook,
  pos: PaperPerpPosition,
  mark: bigint,
  spec: PerpMarketSpec,
  nowMs: number,
  seq: bigint | number,
): PaperTriggerEvent | null {
  const l = paperLiquidation(pos, mark, spec);
  if (l === null) return null;
  const id = paperEventId("liq", pos.marketId, seq);
  const restingEnds: PaperStep["restingEnds"] = [];
  if (pos.stop !== null) restingEnds.push({ role: "sl", status: "cancelled" });
  if (pos.take !== null) restingEnds.push({ role: "tp", status: "cancelled" });
  const fact: PaperFillFact = {
    venueTradeId: id,
    marketId: pos.marketId,
    side: pos.side,
    sideRole: pos.side === "long" ? "ask" : "bid",
    base: pos.baseAmount,
    price: l.price,
    quoteMicro: notionalMicro(pos.baseAmount, l.price, spec, pos.side === "long" ? "floor" : "ceil"),
    feeMicro: l.feeMicro,
    realizedMicro: l.realizedMicro,
    positionBefore: signedBase(pos),
    entryQuoteBeforeMicro: notionalMicro(pos.baseAmount, pos.entryPrice, spec, "ceil"),
    tradeType: "liquidation",
    attribution: "venue-forced",
    leg: null,
    venueTsMs: nowMs,
  };
  return {
    kind: "liq",
    marketId: pos.marketId,
    id,
    mark,
    outcome: l.kind === "takeover" ? "taken-over" : "liquidated",
    step: {
      book: withPosition(book, pos.marketId, null, l.returnedMicro),
      marketId: pos.marketId,
      before: pos,
      after: null,
      fills: [fact],
      funding: null,
      cashDeltaMicro: l.returnedMicro,
      restingEnds,
    },
  };
}

/**
 * WHAT THE VENUE WOULD HAVE DONE TO THE RESTING ORDERS AND THE MARGIN at these
 * marks: per position, in market order, the stop (or the take) that the mark
 * has crossed fires into the book, then liquidation is judged on what is left.
 * Every event's step is computed on the book the previous one left, so the
 * executor books them in order and stops at the first it cannot.
 *
 * Pure and deterministic: the same book, reads and `seq` give the same events
 * with the same identities — `paper:<kind>:<market>:<seq>`, at most one of
 * each kind per market per pass. `unread` names the markets that could not be
 * judged: no fresh mark (nothing fires on a price we do not have), or a child
 * that should fire into a book too old to fill against (it waits; the
 * liquidation line, which needs only the mark, is still judged).
 */
export function evaluatePaperTriggers(args: {
  book: PaperPerpBook;
  markets: ReadonlyMap<number, PaperMarketRead>;
  nowMs: number;
  seq: bigint | number;
}): { book: PaperPerpBook; events: PaperTriggerEvent[]; unread: PaperTriggerUnread[] } {
  let book = args.book;
  const events: PaperTriggerEvent[] = [];
  const unread: PaperTriggerUnread[] = [];
  const ids = [...book.positions.keys()].sort((a, b) => a - b);
  for (const marketId of ids) {
    let pos = book.positions.get(marketId);
    if (!pos) continue;
    const read = args.markets.get(marketId);
    if (!read || read.mark === null) {
      unread.push({ marketId, kind: "mark", why: "no fresh mark" });
      continue;
    }
    const mark = read.mark;
    const stopHit = pos.stop !== null && (pos.side === "long" ? mark <= pos.stop.trigger : mark >= pos.stop.trigger);
    const takeHit = !stopHit && pos.take !== null && (pos.side === "long" ? mark >= pos.take.trigger : mark <= pos.take.trigger);
    if (stopHit || takeHit) {
      if (read.levels === null) {
        unread.push({ marketId, kind: "book", why: `the ${stopHit ? "stop" : "take-profit"} fired into a book too old to fill against` });
      } else {
        const kind = stopHit ? "sl" : "tp";
        const child = (stopHit ? pos.stop : pos.take) as PaperTrigger;
        const ev = fireChild(book, pos, kind, child, { ...read, mark, levels: read.levels }, args.nowMs, args.seq);
        events.push(ev);
        book = ev.step.book;
        pos = book.positions.get(marketId);
        if (!pos) continue;
      }
    }
    const liq = liquidate(book, pos, mark, read.spec, args.nowMs, args.seq);
    if (liq !== null) {
      events.push(liq);
      book = liq.step.book;
    }
  }
  return { book, events, unread };
}

// ── what the book is worth ──────────────────────────────────────────────────

/**
 * The paper venue's terms of rule 12 at these marks: ΣM, ΣU, Σ max(0, Uᵢ) per
 * position, and the open notional at mark. NULL when any open position has no
 * mark — unknown is never zero (rule 11), and a sum that skipped one would be
 * a book short by a whole position.
 */
export function paperPerpTerms(
  book: PaperPerpBook,
  marks: ReadonlyMap<number, bigint | null>,
  specs: ReadonlyMap<number, Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals">>,
): { isolatedMarginMicro: bigint; unrealizedMicro: bigint; unrealizedGainMicro: bigint; openNotionalMicro: bigint } | null {
  let m = 0n;
  let u = 0n;
  let g = 0n;
  let n = 0n;
  for (const pos of book.positions.values()) {
    const mark = marks.get(pos.marketId) ?? null;
    const spec = specs.get(pos.marketId);
    if (mark === null || mark <= 0n || spec === undefined) return null;
    const upnl = unrealizedPnlMicro({ side: pos.side, baseAmount: pos.baseAmount, entryPrice: pos.entryPrice, markPrice: mark, spec });
    m += pos.allocatedMarginMicro;
    u += upnl;
    if (upnl > 0n) g += upnl;
    n += notionalMicro(pos.baseAmount, mark, spec, "ceil");
  }
  return { isolatedMarginMicro: m, unrealizedMicro: u, unrealizedGainMicro: g, openNotionalMicro: n };
}
