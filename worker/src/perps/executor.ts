/**
 * PerpExecutor — the Lighter sibling of AgentExecutor and OrderExecutor
 * (docs/perps.md, "Worker": executor.ts).
 *
 * NOT A WIDENING OF EITHER. AgentExecutor is EVM-shaped (calls in, a UserOp
 * hash out) and OrderExecutor is a brokerage's notional order; an L2 perp
 * order is neither — it has a market id, a venue-integer size and worst price,
 * a stop child it may not exist without, and a nonce its client order indexes
 * are derived from. Sibling types keep the compiler from letting a perp order
 * fall through a path built for calldata, which is how a venue mistake becomes
 * a money mistake.
 *
 * The safety pair is the brokerage rail's (executor-order.ts):
 *
 *   review()  — the DRY RUN: the order priced against the book as it stands —
 *               expected fill, settlement price, notional at fill, fee, margin
 *               it needs, the liquidation price it would carry. The lane runs
 *               checkPolicy's second pass on THESE terms. Throws PerpRefused
 *               (`perp-unpriced`) when it cannot price: an unread feed, prices
 *               older than 30 s for an open, a book older than 10 s.
 *   place()   — the dispose half, taking the review it must honour. It
 *               re-prices against the book at the moment it runs (the venue
 *               fills against the book it sees, not the one reviewed) but
 *               never beyond the intent's worst price, which is what the
 *               caps judged.
 *   tick()    — paper only: what the venue does on its own clock — hourly
 *               funding, resting stops and take-profits firing, liquidation.
 *               Live has none: there the venue does it and reconcile.ts
 *               ingests it.
 *
 * ONLY THE PAPER IMPLEMENTATION LIVES HERE TODAY, and it never loads the
 * signer (rule 14: "paper never loads it") — nothing below imports signer.ts,
 * api.ts or feed.ts. Its whole input is the fleet feed file (feed-reader.ts)
 * and the ledger. The live executor, with rule 9's persist-before-send, is a
 * second implementation of the same interface.
 *
 * EVERY PAPER ACTION IS ONE TRANSACTION (store.ts bookPaperPerp): the rule-9
 * order row resolved on the spot, its legs (entry, the stop child, the take
 * child — resting paper orders), the journaled fill, the position and the
 * paper_book cash the margin comes from. A crash between any two of those
 * would leave margin in two places or none, and the checkpoint would carry the
 * hole into shared storage.
 *
 * RUN IT UNDER THE LANE'S INTENT LOCK. index.ts's spot paper fill writes
 * paper_book cash as an ABSOLUTE value it computed from an earlier read
 * (setPaperBook); a perp delta applied between that read and that write would
 * be overwritten. The lane's lock (processIntentLocked) serialises the two.
 * The booking's own guard — `expect`, the position as this executor read it —
 * catches the rest: a concurrent tick or reset refuses the second booking
 * rather than applying a delta twice.
 */

import { randomUUID } from "node:crypto";
import {
  isolatedLiqPrice,
  isolatedMarginMicro,
  notionalMicro,
  perpCoi,
  perpMarketByKey,
  effectiveMinNotionalMicro,
  PERP_LEG,
  type PerpMarketSpec,
  type PerpSide,
} from "../../../packages/core/src/perps";
import type { PerpOrderIntent } from "../policy";
import type { PaperPerpBooking, PaperPerpExpect, PerpPositionInput, PerpPositionRow } from "../store";
import type { PerpLegRole, PerpLegStatus } from "../perp-ledger-rules";
import { feedBookForPaperFill, feedMarketForOpen, type LighterFeedRead } from "./feed-reader";
import type { DepthLevel } from "./markets";
import {
  PerpRefused,
  applyPaperFunding,
  applyPaperOpen,
  applyPaperReduce,
  evaluatePaperTriggers,
  hourOf,
  paperEventId,
  paperFundingTerms,
  paperLiqPrice,
  simulateTakerFill,
  type PaperMarketRead,
  type PaperPerpBook,
  type PaperPerpPosition,
  type PaperStep,
  type PaperTriggerEvent,
} from "./paper";

export { PerpRefused };

// ── the interface ───────────────────────────────────────────────────────────

/** The priced terms of one perp order — what checkPolicy's second pass judges. */
export interface PerpReview {
  /** What this review priced; place() re-derives it and refuses an open whose terms moved. */
  intentKey: string;
  marketId: number;
  /** An exit clamped to the whole position is reported as the close it became (rule 8). */
  effect: "open" | "reduce" | "close";
  /** The POSITION side: opened, or held. */
  side: PerpSide;
  /** The venue's IsAsk: a sell when true. */
  isAsk: boolean;
  /** What the order asks for — for an exit, clamped to the position. */
  baseAmount: bigint;
  worstPrice: bigint;
  /** The fresh mark, or null when prices are stale (an exit may still be priced from the book). */
  mark: bigint | null;
  expectedFill: "full" | "partial" | "none";
  filledBase: bigint;
  /** The whole-tick settlement price; null when nothing would fill. */
  avgPrice: bigint | null;
  /** micro-USDG at avgPrice. */
  notionalAtFillMicro: bigint;
  feeMicro: bigint;
  /** An open's isolated margin at fill + its fee; 0 for an exit. */
  marginNeededMicro: bigint;
  /** An open's liquidation price at its expected fill and margin; null for an exit or when none exists. */
  liqPriceEstimate: bigint | null;
  levels: DepthLevel[];
  /** ms */
  bookObservedAt: number;
  detail: string;
}

export interface PerpPlaceContext {
  decisionId: string | null;
  agentId: string;
  /** Owner command expiry, absolute ms. Absent for autonomous protective exits. */
  notAfterMs?: number;
}

export interface PerpPlaceResult {
  /** `submitted` is the live rail's until reconcile resolves it; paper is final on return. */
  status: "filled" | "partial" | "cancelled" | "rejected" | "submitted";
  orderRowId: string;
  nonce: bigint | null;
  filledBase: bigint;
  filledQuoteMicro: bigint;
  avgPrice: bigint | null;
  feeMicro: bigint;
  /** Exits: the P&L the fill realized (after the isolated cap). */
  realizedMicro?: bigint;
  detail: string;
}

/** One thing the paper venue did on its own clock, as booked. */
export interface PerpTickEvent {
  kind: "funding" | "sl" | "tp" | "liq";
  marketId: number;
  id: string;
  outcome: "paid" | "received" | "closed" | "reduced" | "gapped" | "liquidated" | "taken-over";
  /** Booked now, or already booked by an earlier pass (an idempotent re-run). */
  booked: "booked" | "duplicate";
  realizedMicro: bigint;
  feeMicro: bigint;
  paymentMicro: bigint;
  cashDeltaMicro: bigint;
}

/**
 * A market the venue's clock could not run for, and which part:
 *   mark         no fresh mark: no child fires, no liquidation is judged
 *   book         a child the mark crossed waits for a book fresh enough to fill
 *   funding      the market's funding could not be read this pass (the feed is
 *                stale or carries no payment); the hours owed are charged, in
 *                order, as soon as it reads — nothing is skipped meanwhile
 *   funding-gap  an hour the position owes is not in the feed at all: every
 *                hour before it was charged, none after it is (its funding is
 *                UNREAD from `sinceHour` on), and the hour is not assumed zero
 */
export interface PerpTickUnread {
  marketId: number;
  kind: "mark" | "book" | "funding" | "funding-gap";
  why: string;
  /** funding-gap: the first hour (unix s) the position owes that the feed does not carry. */
  sinceHour?: number;
}

export interface PerpTickResult {
  events: PerpTickEvent[];
  /** Markets the venue's clock could not be run for this pass, and why — a gap, never "nothing happened". */
  unread: PerpTickUnread[];
  /** The first booking that failed; every event after it waits for the next pass. */
  failed: { marketId: number; kind: string; error: string } | null;
}

export interface PerpExecutor {
  readonly mode: "paper" | "live";
  review(intent: PerpOrderIntent): Promise<PerpReview>;
  place(intent: PerpOrderIntent, review: PerpReview, ctx: PerpPlaceContext): Promise<PerpPlaceResult>;
  /** Paper: the venue's own clock. */
  tick?(nowMs?: number): Promise<PerpTickResult>;
  /**
   * Set a market's isolated leverage while it is flat — the paper twin of an
   * L2 UpdateLeverage (rule 6). An open is refused until the market reads
   * isolated at exactly the IMF it asserts.
   */
  setLeverage?(marketId: number, imfBp: number): Promise<void>;
  /**
   * PUT A STOP BACK UNDER A POSITION THAT HAS NONE — the paper twin of a
   * standalone position-tied STOP_LOSS (protect.ts P3 `replace-stop`). A fired
   * stop is consumed as on the venue, so a gapped or part-filled one leaves
   * the position open with none; this is how the protective loop re-places
   * it. Refused unless the stop sits on the LOSING side of a fresh mark (a
   * stop the mark is already past is a close by another name, P2's to make)
   * with its bound on the far side of its trigger.
   */
  setStop?(marketId: number, stop: { trigger: bigint; price: bigint }): Promise<void>;
}

// ── the paper executor ──────────────────────────────────────────────────────

/** The ledger functions the paper executor books through — store.ts's own, injectable for a test. */
export interface PaperPerpStore {
  bumpNonceHighWater(agentId: string, mode: "paper", floor: bigint | number): Promise<bigint>;
  getPerpPositions(agentId: string, mode: "paper", opts?: { includeFlat?: boolean }): Promise<PerpPositionRow[]>;
  getPaperBook(agentId: string, startUsdg: number): Promise<{ cashUsdg: number }>;
  bookPaperPerp(b: PaperPerpBooking): Promise<"booked" | "duplicate">;
}

interface LoadedBook {
  book: PaperPerpBook;
  /** Every row, flat ones included: a flat row is the market's leverage state. */
  rows: Map<number, PerpPositionRow>;
}

function positionOf(r: PerpPositionRow): PaperPerpPosition {
  const where = `paper position in market ${r.marketId}`;
  if (r.side === null || r.entryPrice === null || r.entryPrice <= 0n || r.imfBp === null) throw new Error(`${where} is unreadable: no side, entry or IMF`);
  if ((r.stopTrigger === null) !== (r.stopPrice === null) || (r.takeTrigger === null) !== (r.takePrice === null)) {
    throw new Error(`${where} is unreadable: a child with a trigger and no bound`);
  }
  return {
    marketId: r.marketId,
    side: r.side,
    baseAmount: r.base,
    entryPrice: r.entryPrice,
    allocatedMarginMicro: r.allocatedMarginMicro,
    imfBp: r.imfBp,
    // Display accumulators only — money is cash and margin. A restored
    // checkpoint may carry them NULL, which is "none booked since open".
    realizedMicro: r.realizedMicro ?? 0n,
    fundingMicro: r.fundingMicro ?? 0n,
    stop: r.stopTrigger !== null && r.stopPrice !== null ? { trigger: r.stopTrigger, price: r.stopPrice } : null,
    take: r.takeTrigger !== null && r.takePrice !== null ? { trigger: r.takeTrigger, price: r.takePrice } : null,
    openedAtSec: r.openedAt ?? 0,
    fundingHourApplied: r.fundingHourApplied,
  };
}

function expectOf(marketId: number, p: PaperPerpPosition | null): PaperPerpExpect {
  return {
    marketId,
    held:
      p === null
        ? null
        : {
            side: p.side,
            base: p.baseAmount,
            entryPrice: p.entryPrice,
            allocatedMarginMicro: p.allocatedMarginMicro,
            stopTrigger: p.stop?.trigger ?? null,
            takeTrigger: p.take?.trigger ?? null,
            fundingHourApplied: p.fundingHourApplied,
          },
  };
}

type PositionWrite = Omit<PerpPositionInput, "agentId" | "mode" | "source">;

function positionWrite(marketId: number, p: PaperPerpPosition | null, imfBp: number | null): PositionWrite {
  if (p === null) {
    // Flat keeps the market's leverage state: it is venue state that outlives a position.
    return {
      marketId,
      side: null,
      base: 0n,
      entryPrice: null,
      allocatedMarginMicro: 0n,
      imfBp,
      marginMode: imfBp === null ? null : "isolated",
      realizedMicro: null,
      fundingMicro: null,
      stopTrigger: null,
      stopPrice: null,
      takeTrigger: null,
      takePrice: null,
      fundingHourApplied: null,
      openedAt: null,
    };
  }
  return {
    marketId,
    side: p.side,
    base: p.baseAmount,
    entryPrice: p.entryPrice,
    allocatedMarginMicro: p.allocatedMarginMicro,
    imfBp: p.imfBp,
    marginMode: "isolated",
    realizedMicro: p.realizedMicro,
    fundingMicro: p.fundingMicro,
    stopTrigger: p.stop?.trigger ?? null,
    stopPrice: p.stop?.price ?? null,
    takeTrigger: p.take?.trigger ?? null,
    takePrice: p.take?.price ?? null,
    fundingHourApplied: p.fundingHourApplied,
    openedAt: p.openedAtSec,
  };
}

/** A resting child's end, in the venue's own word beside ours (the two-vocabulary rule). */
const END_WORD: Record<string, string> = {
  sl: "paper-stop",
  tp: "paper-take",
  liq: "paper-liquidated",
  close: "paper-flat",
  gapped: "paper-gapped",
};

/**
 * The paper executor. `feed` is the fleet feed as this tick read it (null =
 * unread); `now` is ms; `epoch` is the accounting epoch the lane is in — a
 * getter, because a paper reset moves it and an action computed in the old
 * epoch must not land in the new one. `paperStartUsdg` seeds the paper_book
 * row exactly as index.ts does, should this be its first touch.
 */
export function createPaperPerpExecutor(opts: {
  agentId: string;
  epoch: number | (() => number);
  feed: () => LighterFeedRead | null;
  store: PaperPerpStore;
  now: () => number;
  paperStartUsdg: number;
}): PerpExecutor {
  const { agentId, store } = opts;
  const epochNow = (): number => (typeof opts.epoch === "function" ? opts.epoch() : opts.epoch);

  async function load(): Promise<LoadedBook> {
    const rows = await store.getPerpPositions(agentId, "paper", { includeFlat: true });
    const bookRow = await store.getPaperBook(agentId, opts.paperStartUsdg);
    if (!Number.isFinite(bookRow.cashUsdg)) throw new Error("the paper book's cash is unreadable");
    const positions = new Map<number, PaperPerpPosition>();
    const byMarket = new Map<number, PerpPositionRow>();
    for (const r of rows) {
      byMarket.set(r.marketId, r);
      if (r.base > 0n) positions.set(r.marketId, positionOf(r));
    }
    // REAL USDG → micro, to the nearest micro: the column holds a 6-dp value
    // through a float, and the booking's own in-transaction check is the
    // authority on whether a debit fits.
    return { book: { cashMicro: BigInt(Math.round(bookRow.cashUsdg * 1e6)), positions }, rows: byMarket };
  }

  function unpriced(detail: string): PerpRefused {
    return new PerpRefused("perp-unpriced", detail);
  }

  /** The intent's own shape, checked where nothing downstream can re-check it. */
  function shapeOf(intent: PerpOrderIntent): { exit: boolean } {
    const x = intent as PerpOrderIntent & Record<string, unknown>;
    if (x.kind !== "perp-order" || x.venue !== "lighter") throw new PerpRefused("perp-order-malformed", "not a Lighter perp order");
    const listed = perpMarketByKey(String(x.market));
    if (listed === null || listed.marketId !== x.marketId) {
      throw new PerpRefused("perp-order-malformed", `${String(x.market)} is not market ${String(x.marketId)} on Lighter`);
    }
    if (x.side !== "long" && x.side !== "short") throw new PerpRefused("perp-order-malformed", "a perp order names the side long or short");
    if (typeof x.baseAmount !== "bigint" || x.baseAmount <= 0n || typeof x.worstPrice !== "bigint" || x.worstPrice <= 0n) {
      throw new PerpRefused("perp-order-malformed", "size and worst price must be positive venue integers");
    }
    if (x.effect === "open" && x.reduceOnly === false) return { exit: false };
    if ((x.effect === "reduce" || x.effect === "close") && x.reduceOnly === true) return { exit: true };
    throw new PerpRefused("perp-order-malformed", "an open is never reduce-only and an exit always is (rule 8)");
  }

  async function price(intent: PerpOrderIntent): Promise<{ review: PerpReview; loaded: LoadedBook; spec: PerpMarketSpec; takerFeePpm: number }> {
    const { exit } = shapeOf(intent);
    const marketId = intent.marketId;
    const read = opts.feed();
    const m = read?.markets.get(marketId);
    if (!read || !m) throw unpriced(`${intent.market} is not in the Lighter feed this tick`);
    const fresh = feedMarketForOpen(read, marketId);
    if (!exit && fresh === null) throw unpriced(`${intent.market}'s prices are older than 30 s`);
    if (!exit && m.status !== "active") throw new PerpRefused("perp-market-inactive", `${intent.market} is ${m.status} at the venue`);
    const levels = feedBookForPaperFill(read, marketId);
    // Rule 14: a paper order is refused, never filled at some older price.
    if (levels === null) throw unpriced(`${intent.market}'s order book is older than 10 s, so a paper fill cannot walk it`);
    const spec = levels.spec;
    const loaded = await load();
    const held = loaded.book.positions.get(marketId) ?? null;
    const mark = fresh?.mark ?? null;

    if (!exit) {
      const o = intent as Extract<PerpOrderIntent, { effect: "open" }>;
      if (held !== null) throw new PerpRefused("perp-add-to-position", `${intent.market} already holds a ${held.side}; an open never adds to it`);
      if (typeof o.stopTrigger !== "bigint" || typeof o.stopPrice !== "bigint" || o.stopTrigger <= 0n || o.stopPrice <= 0n) {
        throw new PerpRefused("perp-stop-required", "every open carries its own stop (rule 7)");
      }
      const lev = loaded.rows.get(marketId);
      if (lev === undefined || lev.imfBp === null || lev.marginMode !== "isolated") {
        throw new PerpRefused("perp-leverage-unset", `${intent.market} has no isolated leverage set on the paper venue yet`);
      }
      if (lev.imfBp !== o.imfBp) {
        throw new PerpRefused("perp-leverage-mismatch", `${intent.market} is isolated at ${lev.imfBp} bp, not the ${o.imfBp} this open asserts`);
      }
      const isAsk = o.side === "short";
      const fill = simulateTakerFill({ isAsk, baseAmount: o.baseAmount, worstPrice: o.worstPrice, book: levels, spec, takerFeePpm: m.takerFeePpm });
      const margin = fill.filledBase > 0n ? isolatedMarginMicro(fill.filledQuoteMicro, o.imfBp) : 0n;
      const liq =
        fill.avgPrice === null
          ? null
          : isolatedLiqPrice({ side: o.side, entryPrice: fill.avgPrice, baseAmount: fill.filledBase, allocatedMarginMicro: margin, mmfBp: spec.mmfBp, spec });
      return {
        review: reviewOf(intent, "open", o.side, isAsk, o.baseAmount, fill, mark, margin + fill.feeMicro, liq, levels.bookObservedAt),
        loaded,
        spec,
        takerFeePpm: m.takerFeePpm,
      };
    }

    if (held === null) throw new PerpRefused("perp-no-position", `there is no paper ${intent.market} position to ${intent.effect}`);
    if (held.side !== intent.side) {
      throw new PerpRefused("perp-side-mismatch", `${intent.market} holds a ${held.side}, not the ${intent.side} this ${intent.effect} names`);
    }
    // Rule 8: clamped, never refused, for size. A close is the whole
    // position; a reduce is cut to it; a remainder under the market minimum
    // becomes a close (a stub below the venue's minimum could not be closed
    // on its own later).
    let base = intent.effect === "close" ? held.baseAmount : intent.baseAmount < held.baseAmount ? intent.baseAmount : held.baseAmount;
    const refPrice = mark ?? held.entryPrice;
    if (base < held.baseAmount && notionalMicro(held.baseAmount - base, refPrice, spec, "floor") < effectiveMinNotionalMicro(spec, refPrice)) {
      base = held.baseAmount;
    }
    const effect = base === held.baseAmount ? "close" : "reduce";
    const isAsk = held.side === "long";
    const fill = simulateTakerFill({ isAsk, baseAmount: base, worstPrice: intent.worstPrice, book: levels, spec, takerFeePpm: m.takerFeePpm });
    return {
      review: reviewOf(intent, effect, held.side, isAsk, base, fill, mark, 0n, null, levels.bookObservedAt),
      loaded,
      spec,
      takerFeePpm: m.takerFeePpm,
    };
  }

  function reviewOf(
    intent: PerpOrderIntent,
    effect: PerpReview["effect"],
    side: PerpSide,
    isAsk: boolean,
    base: bigint,
    fill: ReturnType<typeof simulateTakerFill>,
    mark: bigint | null,
    marginNeeded: bigint,
    liq: bigint | null,
    bookObservedAt: number,
  ): PerpReview {
    const expectedFill = fill.filledBase === 0n ? "none" : fill.filledBase === base ? "full" : "partial";
    return {
      intentKey: `${intent.marketId}|${effect}|${side}|${base}|${intent.worstPrice}`,
      marketId: intent.marketId,
      effect,
      side,
      isAsk,
      baseAmount: base,
      worstPrice: intent.worstPrice,
      mark,
      expectedFill,
      filledBase: fill.filledBase,
      avgPrice: fill.avgPrice,
      notionalAtFillMicro: fill.filledQuoteMicro,
      feeMicro: fill.feeMicro,
      marginNeededMicro: marginNeeded,
      liqPriceEstimate: liq,
      levels: fill.levels,
      bookObservedAt,
      detail:
        `paper ${effect} ${side} ${intent.market}: ${fill.filledBase}/${base} base` +
        (fill.avgPrice === null ? " — nothing inside the worst price" : ` @ ${fill.avgPrice}`),
    };
  }

  function legsOf(nonce: bigint, entries: readonly [PerpLegRole, PerpLegStatus][]) {
    return entries.map(([role, status]) => ({ role, status, clientOrderIndex: Number(perpCoi(nonce, PERP_LEG[role])) }));
  }

  function orderStatus(filled: bigint, asked: bigint): "filled" | "partial" | "cancelled" {
    return filled === 0n ? "cancelled" : filled === asked ? "filled" : "partial";
  }

  function restingEndsOf(step: PaperStep, word: string): NonNullable<PaperPerpBooking["restingEnd"]> {
    return step.restingEnds.map((r) => ({ marketId: step.marketId, role: r.role, status: r.status, venueStatus: word }));
  }

  function fillsOf(step: PaperStep): NonNullable<PaperPerpBooking["fills"]> {
    return step.fills.map((f) => ({
      venueTradeId: f.venueTradeId,
      marketId: f.marketId,
      side: f.side,
      sideRole: f.sideRole,
      base: f.base,
      price: f.price,
      quoteMicro: f.quoteMicro,
      feeMicro: f.feeMicro,
      realizedMicro: f.realizedMicro,
      positionBefore: f.positionBefore,
      entryQuoteBeforeMicro: f.entryQuoteBeforeMicro,
      tradeType: f.tradeType,
      attribution: f.attribution,
      leg: f.leg === null ? null : f.leg === "sl" || f.leg === "tp" ? { resting: f.leg } : { own: f.leg },
      venueTsMs: f.venueTsMs,
    }));
  }

  return {
    mode: "paper",

    async review(intent) {
      return (await price(intent)).review;
    },

    async place(intent, review, ctx) {
      if (typeof ctx.agentId !== "string" || ctx.agentId.toLowerCase() !== agentId.toLowerCase()) {
        throw new PerpRefused("perp-order-malformed", "this order was placed for another agent's paper venue");
      }
      // Re-priced at the moment of placing: the venue fills against the book
      // it sees now, bounded by the same worst price the caps judged.
      const { review: now, loaded, spec } = await price(intent);
      if (now.effect === "open" ? now.intentKey !== review.intentKey : now.marketId !== review.marketId || now.side !== review.side) {
        throw new PerpRefused("perp-order-malformed", "the order is not the one that was reviewed");
      }
      const nowMs = opts.now();
      const nonce = await store.bumpNonceHighWater(agentId, "paper", Math.max(1, Math.floor(nowMs)));
      if (ctx.notAfterMs !== undefined && (!Number.isSafeInteger(ctx.notAfterMs) || opts.now() >= ctx.notAfterMs)) {
        throw new PerpRefused("perp-unpriced", "the owner's request expired before the practice order could be booked");
      }
      const marketId = intent.marketId;
      // The fill priced a moment ago IS the fill: price() walked the book this
      // call read, and reading the feed again here could pair a book with a
      // position read from another instant.
      const walked = {
        isAsk: now.isAsk,
        requestedBase: now.baseAmount,
        filledBase: now.filledBase,
        filledQuoteMicro: now.notionalAtFillMicro,
        avgPrice: now.avgPrice,
        feeMicro: now.feeMicro,
        levels: now.levels,
      };
      const before = loaded.book.positions.get(marketId) ?? null;
      const worst = notionalMicro(now.baseAmount, intent.worstPrice, spec, "ceil");

      if (now.effect === "open") {
        const o = intent as Extract<PerpOrderIntent, { effect: "open" }>;
        const hasTake = typeof o.takeTrigger === "bigint" && typeof o.takePrice === "bigint";
        if (!hasTake && (o.takeTrigger !== undefined || o.takePrice !== undefined)) {
          throw new PerpRefused("perp-order-malformed", "a take-profit carries both its trigger and its bound, or neither");
        }
        const step = applyPaperOpen({
          book: loaded.book,
          marketId,
          side: o.side,
          fill: walked,
          imfBp: o.imfBp,
          stop: { trigger: o.stopTrigger, price: o.stopPrice },
          take: hasTake ? { trigger: o.takeTrigger as bigint, price: o.takePrice as bigint } : null,
          spec,
          nowMs,
          tradeId: paperEventId("open", marketId, nonce),
        });
        const status = orderStatus(walked.filledBase, now.baseAmount);
        // OTO / OTOCO: the children rest once the entry executed, and die with it otherwise.
        const child: PerpLegStatus = walked.filledBase > 0n ? "open" : "cancelled";
        const legs = legsOf(nonce, [["entry", status], ["sl", child], ...(hasTake ? ([["tp", child]] as [PerpLegRole, PerpLegStatus][]) : [])]);
        const booking: PaperPerpBooking = {
          agentId,
          epoch: epochNow(),
          expect: [{ ...expectOf(marketId, null), isolatedImfBp: o.imfBp }],
          order: {
            nonce,
            effect: "open",
            reduceOnly: false,
            marketId,
            status,
            worstNotionalMicro: worst,
            filledBase: walked.filledBase,
            filledQuoteMicro: walked.filledQuoteMicro,
            decisionId: ctx.decisionId,
            legs,
          },
          fills: fillsOf(step),
          positions: step.after === null ? [] : [positionWrite(marketId, step.after, o.imfBp)],
          cashDeltaMicro: step.cashDeltaMicro,
        };
        const id = await book(booking);
        return {
          status,
          orderRowId: id,
          nonce,
          filledBase: walked.filledBase,
          filledQuoteMicro: walked.filledQuoteMicro,
          avgPrice: walked.avgPrice,
          feeMicro: walked.feeMicro,
          detail: now.detail,
        };
      }

      // An exit: the reduce-only IOC against the position as read.
      const step = applyPaperReduce({
        book: loaded.book,
        marketId,
        fill: walked,
        spec,
        nowMs,
        tradeId: paperEventId(now.effect, marketId, nonce),
        leg: "close",
      });
      const status = orderStatus(walked.filledBase, now.baseAmount);
      const imf = loaded.rows.get(marketId)?.imfBp ?? null;
      const booking: PaperPerpBooking = {
        agentId,
        epoch: epochNow(),
        expect: [expectOf(marketId, before)],
        order: {
          nonce,
          effect: now.effect,
          reduceOnly: true,
          marketId,
          status,
          worstNotionalMicro: worst,
          filledBase: walked.filledBase,
          filledQuoteMicro: walked.filledQuoteMicro,
          decisionId: ctx.decisionId,
          legs: legsOf(nonce, [["close", status]]),
        },
        fills: fillsOf(step),
        restingEnd: restingEndsOf(step, END_WORD.close as string),
        positions: walked.filledBase > 0n ? [positionWrite(marketId, step.after, imf)] : [],
        cashDeltaMicro: step.cashDeltaMicro,
      };
      const id = await book(booking);
      return {
        status,
        orderRowId: id,
        nonce,
        filledBase: walked.filledBase,
        filledQuoteMicro: walked.filledQuoteMicro,
        avgPrice: walked.avgPrice,
        feeMicro: walked.feeMicro,
        realizedMicro: step.fills[0]?.realizedMicro ?? 0n,
        detail: now.detail,
      };
    },

    async setLeverage(marketId, imfBp) {
      const read = opts.feed();
      const m = read?.markets.get(marketId);
      // The market's minimum IMF is venue state we must read to honour; an
      // unread spec is not a licence to set any leverage at all.
      if (!m) throw unpriced(`market ${marketId} is not in the Lighter feed, so its leverage bounds are unread`);
      if (!Number.isSafeInteger(imfBp) || imfBp < m.spec.minImfBp || imfBp > 10_000) {
        throw new PerpRefused("perp-leverage-mismatch", `${imfBp} bp is outside ${m.key}'s ${m.spec.minImfBp}..10000`);
      }
      const loaded = await load();
      if (loaded.book.positions.has(marketId)) {
        throw new PerpRefused("perp-leverage-mismatch", `${m.key}'s leverage changes only while it is flat (rule 6)`);
      }
      await book({
        agentId,
        epoch: epochNow(),
        expect: [expectOf(marketId, null)],
        positions: [positionWrite(marketId, null, imfBp)],
        cashDeltaMicro: 0n,
      });
    },

    async setStop(marketId, stop) {
      const read = opts.feed();
      const fresh = feedMarketForOpen(read, marketId);
      // Which side of the market the stop sits on is judged at a CURRENT mark:
      // one read a minute ago could place a stop the market is already past.
      if (fresh === null) throw unpriced(`market ${marketId}'s prices are older than 30 s, so a stop cannot be placed against them`);
      const loaded = await load();
      const held = loaded.book.positions.get(marketId) ?? null;
      if (held === null) throw new PerpRefused("perp-no-position", `there is no paper position in market ${marketId} to put a stop under`);
      const { trigger, price: bound } = stop;
      if (typeof trigger !== "bigint" || typeof bound !== "bigint" || trigger <= 0n || bound <= 0n) {
        throw new PerpRefused("perp-stop-required", "a stop names a positive trigger and bound");
      }
      const losing = held.side === "long" ? trigger < fresh.mark && bound <= trigger : trigger > fresh.mark && bound >= trigger;
      if (!losing) {
        throw new PerpRefused(
          "perp-stop-required",
          `a ${held.side} stop at ${trigger} (bound ${bound}) is not on the losing side of the mark ${fresh.mark}`,
        );
      }
      const after: PaperPerpPosition = { ...held, stop: { trigger, price: bound } };
      const imf = loaded.rows.get(marketId)?.imfBp ?? held.imfBp;
      const out = await store.bookPaperPerp({
        agentId,
        epoch: epochNow(),
        expect: [expectOf(marketId, held)],
        positions: [positionWrite(marketId, after, imf)],
        cashDeltaMicro: 0n,
      });
      // No identity rides this booking (no fill, no funding), so it cannot be
      // a duplicate; anything else is the store saying the book moved.
      if (out !== "booked") throw new Error("the paper stop was not booked");
    },

    async tick(nowMsArg) {
      const nowMs = nowMsArg ?? opts.now();
      const result: PerpTickResult = { events: [], unread: [], failed: null };
      let loaded = await load();
      if (loaded.book.positions.size === 0) return result;
      const read = opts.feed();

      // ── funding: EVERY settled hour the position has not been charged ───
      //
      // The venue charges every hour a position is held, whether or not this
      // worker was looking. So the clock owes each hour in
      // (fundingHourApplied, the latest hour the feed names] — not just the
      // latest: charging only that one and moving the high-water past the
      // rest booked every hour this worker slept through (a laptop overnight,
      // a restart, an hour-long feed stall) as ZERO, a paper book kinder than
      // the venue (rules 11 and 14; the review's R3-PAPER-FUNDING-GAP).
      //
      //   the rates   the feed's hourly history (`fundingHistory`: rate and
      //               paying side, per hour) and the last payment
      //               market_stats reports (`lastFunding`, which wins for its
      //               own hour — the one the clock has always charged)
      //   in order    one booking per hour, oldest first, each on the book the
      //               one before it left; a failure stops the pass there
      //   a gap       an owed hour neither carries is NOT skipped: every hour
      //               before it is charged, the high-water stays under it, and
      //               the market is `funding-gap` — unread, said to the owner
      //               by the lane — so if a later feed carries the hour (the
      //               history is fetched at hour + 90 s, after a restart
      //               within a minute) it is charged then, in order
      //   the index   the feed keeps no hourly index, so each replayed hour is
      //               valued at the index read now — an approximation, and
      //               the only price there is
      for (const [marketId, pos] of [...loaded.book.positions].sort((a, b) => a[0] - b[0])) {
        const m = read?.markets.get(marketId);
        if (!m || !m.fresh) {
          result.unread.push({ marketId, kind: "funding", why: "funding unread" });
          continue;
        }
        const rates = new Map<number, { ratePpm: number; direction: PerpSide | null }>();
        for (const row of m.fundingHistory ?? []) rates.set(row.atSec, { ratePpm: row.ratePpm, direction: row.direction });
        // market_stats' own last payment is SIGNED (+ longs pay): its payer is the sign's.
        if (m.lastFunding !== null) rates.set(hourOf(Math.floor(m.lastFunding.atMs / 1000)), { ratePpm: m.lastFunding.ratePpm, direction: null });
        let latest: number | null = null;
        for (const h of rates.keys()) if (latest === null || h > latest) latest = h;
        if (latest === null) {
          result.unread.push({ marketId, kind: "funding", why: "funding unread" });
          continue;
        }
        let first: number;
        if (pos.fundingHourApplied !== null) {
          first = pos.fundingHourApplied + 3600;
        } else if (pos.openedAtSec > 0) {
          // The first hour a position is held AT: the one after it opened.
          first = hourOf(pos.openedAtSec) + 3600;
        } else {
          // No open time (a book restored without one): which hours it was
          // held for is not known, so only the latest is charged, and the
          // ones before it are said to be unknown rather than zero.
          first = latest;
          result.unread.push({ marketId, kind: "funding", why: "the position's open time is unknown, so funding before the latest hour is not charged" });
        }
        for (let hour = first; hour <= latest; hour += 3600) {
          const rate = rates.get(hour);
          // A NEGATIVE /fundings rate has a sign convention nobody has
          // observed on this instance: unread, never guessed (feed-reader.ts
          // usableFunding8h's rule). market_stats' signed rate is the
          // documented one and paperFundingTerms reads it.
          if (rate === undefined || (rate.direction !== null && rate.ratePpm < 0)) {
            const owed = (latest - hour) / 3600 + 1;
            result.unread.push({
              marketId,
              kind: "funding-gap",
              sinceHour: hour,
              why:
                `funding for ${owed} hour(s) from ${new Date(hour * 1000).toISOString()} is not in the feed` +
                (rate === undefined ? "" : " (a negative rate, whose convention is unread)") +
                ` — charged up to the hour before, nothing after it until the feed carries it`,
            });
            break;
          }
          const terms =
            rate.direction === null
              ? paperFundingTerms({ index: m.index, ratePpm: rate.ratePpm, spec: m.spec })
              : // /fundings names the payer outright: value = index × rate, paid by
                // `direction`, credited to the other side (not a guess — the venue said who pays).
                { ...paperFundingTerms({ index: m.index, ratePpm: rate.ratePpm, spec: m.spec }), direction: rate.direction, creditReceiver: true };
          const step = applyPaperFunding({
            book: loaded.book,
            marketId,
            fundingHour: hour,
            valuePerBase: terms.valuePerBase,
            valueDecimals: terms.valueDecimals,
            direction: terms.direction,
            creditReceiver: terms.creditReceiver,
            ratePpm: rate.direction === "short" ? -rate.ratePpm : rate.ratePpm,
            spec: m.spec,
          });
          if (step === null || step.funding === null) continue;
          try {
            const booked = await store.bookPaperPerp({
              agentId,
              epoch: epochNow(),
              expect: [expectOf(marketId, step.before)],
              funding: step.funding,
              positions: [positionWrite(marketId, step.after, pos.imfBp)],
              cashDeltaMicro: 0n,
            });
            result.events.push({
              kind: "funding",
              marketId,
              id: step.funding.fundingId,
              outcome: step.funding.paymentMicro < 0n ? "paid" : "received",
              booked,
              realizedMicro: 0n,
              feeMicro: 0n,
              paymentMicro: step.funding.paymentMicro,
              cashDeltaMicro: 0n,
            });
            // A duplicate means another pass booked this hour first: the book
            // this pass holds is stale for it, so read it again — and the
            // position's high-water with it.
            loaded = booked === "booked" ? { ...loaded, book: step.book } : await load();
            if (booked !== "booked") break;
          } catch (e) {
            result.failed = { marketId, kind: "funding", error: e instanceof Error ? e.message : String(e) };
            return result;
          }
        }
      }

      // ── the resting children and the liquidation engine ─────────────────
      const markets = new Map<number, PaperMarketRead>();
      for (const marketId of loaded.book.positions.keys()) {
        const m = read?.markets.get(marketId);
        if (!m) continue;
        const levels = feedBookForPaperFill(read, marketId);
        markets.set(marketId, {
          mark: m.fresh ? m.mark : null,
          levels: levels === null ? null : { bids: levels.bids, asks: levels.asks },
          spec: m.spec,
          takerFeePpm: m.takerFeePpm,
        });
      }
      const dry = evaluatePaperTriggers({ book: loaded.book, markets, nowMs, seq: 0 });
      for (const u of dry.unread) if (!result.unread.some((x) => x.marketId === u.marketId && x.why === u.why)) result.unread.push({ ...u });
      if (dry.events.length === 0) return result;
      // One nonce for the pass, taken only when something fired: every event's
      // identity is `paper:<kind>:<market>:<nonce>`, unique for the life of the
      // ledger, and re-evaluating with it is the same pure computation.
      const seq = await store.bumpNonceHighWater(agentId, "paper", Math.max(1, Math.floor(nowMs)));
      const { events } = evaluatePaperTriggers({ book: loaded.book, markets, nowMs, seq });
      for (const ev of events) {
        try {
          const booked = await bookEvent(ev, loaded);
          const fill = ev.step.fills[0];
          result.events.push({
            kind: ev.kind,
            marketId: ev.marketId,
            id: ev.id,
            outcome: ev.outcome,
            booked,
            realizedMicro: fill?.realizedMicro ?? 0n,
            feeMicro: fill?.feeMicro ?? 0n,
            paymentMicro: 0n,
            cashDeltaMicro: ev.step.cashDeltaMicro,
          });
        } catch (e) {
          result.failed = { marketId: ev.marketId, kind: ev.kind, error: e instanceof Error ? e.message : String(e) };
          return result;
        }
      }
      return result;
    },
  };

  async function bookEvent(ev: PaperTriggerEvent, loaded: LoadedBook): Promise<"booked" | "duplicate"> {
    const imf = loaded.rows.get(ev.marketId)?.imfBp ?? ev.step.before?.imfBp ?? null;
    const word = ev.outcome === "gapped" ? END_WORD.gapped : END_WORD[ev.kind];
    return store.bookPaperPerp({
      agentId,
      epoch: epochNow(),
      expect: [expectOf(ev.marketId, ev.step.before)],
      fills: fillsOf(ev.step),
      restingEnd: restingEndsOf(ev.step, word as string),
      positions: [positionWrite(ev.marketId, ev.step.after, imf)],
      cashDeltaMicro: ev.step.cashDeltaMicro,
    });
  }

  /** Book one action; the order row's id is what the caller gets back. */
  async function book(b: PaperPerpBooking): Promise<string> {
    // perp_orders.id is unique across every agent, so it is not derived from
    // a nonce two agents can share (both are "now" in ms).
    const withId: PaperPerpBooking = b.order ? { ...b, order: { ...b.order, id: b.order.id ?? randomUUID() } } : b;
    const out = await store.bookPaperPerp(withId);
    // A fresh nonce's identities cannot already be booked; one that is means
    // the high-water went backwards, and saying "done" would hide it.
    if (out !== "booked") throw new Error("a paper order under a fresh nonce was already booked — the nonce high-water moved backwards");
    return withId.order?.id ?? "";
  }
}

/** The paper venue's liquidation price for a ledger position row, for the report and the protective lane. */
export function paperPositionLiqPrice(r: PerpPositionRow, spec: PerpMarketSpec): bigint | null {
  return r.base > 0n ? paperLiqPrice(positionOf(r), spec) : null;
}
