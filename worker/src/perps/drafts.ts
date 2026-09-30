/**
 * PERP INTENTS, BUILT ONCE — the integer half every perp producer shares.
 *
 * docs/perps.md ("The perps route", rules 6, 7, 8, 15) is the contract. Two
 * producers make perp orders on their own — perp-trend (deterministic) and the
 * strategist's `perpActions` (a model, through `proposalsToPerpIntents`) — and
 * both hand the lane the SAME shape, so the arithmetic that turns "a long on
 * BTC-PERP for 25 USDG with a 3% stop" into venue integers lives here and
 * nowhere else. Two copies of "worst price" are how one producer's order passes
 * policy and the other's is refused by a tick.
 *
 * WHAT THIS FILE DOES NOT DO: decide. Nothing here reads a signal, a cap or a
 * brake. A caller says what it wants and how big it may be; this answers with
 * a fully built draft or with the one reason it cannot be built. It never
 * widens anything to make an order fit: a size under the venue minimum is
 * refused (rule 6: nothing relaxes a sealed cap to reach it), a stop that
 * cannot beat liquidation is refused (rule 7), never moved.
 *
 * THE ROUNDINGS ARE core perps.ts's, named there: size floors under a cap,
 * notional ceils, the worst price and the stop round toward the mark. This
 * file only chooses which reference each is computed from, and says why.
 */

import {
  baseForNotional,
  isolatedLiqPrice,
  minOpenBase,
  notionalMicro,
  stopBeatsLiquidation,
  stopPrices,
  takePrices,
  worstPriceForTaker,
  type PerpSide,
} from "../../../packages/core/src/perps";
import type { PerpOrderIntent } from "../policy";
import type { PerpMarketView, PerpPositionView } from "../strategies/types";

// ── the draft ───────────────────────────────────────────────────────────────

/** Omit, distributed over a union — plain Omit collapses the discriminants. */
type DraftOf<T> = T extends unknown ? Omit<T, "decisionId"> : never;

/**
 * A perp-order intent as a PRODUCER hands it over: every venue integer built,
 * no `decisionId`. The decision row is written by whoever journals it
 * (`ensureDecision(intent, "perp-route", …)` in the lane, or the strategist
 * under `perp:strategist`), and an id minted here would be an id with no row.
 * Assignable to TradeIntent as it stands.
 */
export type PerpIntentDraft = DraftOf<PerpOrderIntent>;
export type PerpOpenDraft = Extract<PerpIntentDraft, { effect: "open" }>;
export type PerpExitDraft = Extract<PerpIntentDraft, { reduceOnly: true }>;

const BP = 10_000n;

// ── opens ───────────────────────────────────────────────────────────────────

export interface OpenDraftArgs {
  market: PerpMarketView;
  side: PerpSide;
  /** The most this open may be, micro-USDG, judged at max(worst, mark) — already the min of every cap. */
  notionalCapMicro: bigint;
  /** The stop's distance from the entry reference, bp (perpsStopLossPct × 100 at most). */
  stopBps: number;
  /** perpsMaxSlippageBps: the IOC's worst price vs mark. */
  maxSlippageBps: number;
  /** perpsStopSlipBps: the stop's execution bound vs its trigger. */
  stopSlipBps: number;
  /** perpsLiqBufferPct × 100: how far the stop's worst price must beat liquidation. */
  liqBufferBps: number;
  /** perpsTakeProfitPct × 100, or 0/absent for none. perp-trend never passes one. */
  takeProfitBps?: number;
}

export type OpenDraftResult =
  | { ok: true; draft: PerpOpenDraft; stopBps: number }
  | {
      ok: false;
      /** perp-below-min: the caps cannot reach the venue minimum. */
      rule: "perp-below-min";
      /** The smallest notional the venue takes here, micro-USDG. */
      minMicro: bigint;
      capMicro: bigint;
    }
  | {
      ok: false;
      /** The stop would fill after the venue liquidates (rule 7). */
      rule: "perp-stop-inside-liquidation";
      /** Roughly the widest stop that would still beat liquidation at this leverage, bp; 0 when none would. */
      maxStopBps: number;
    }
  | { ok: false; rule: "perp-order-malformed"; detail: string };

/**
 * An open's venue integers, or the one reason it cannot be built.
 *
 * WORST PRICE: `worstPriceForTaker(mark, perpsMaxSlippageBps)` — a long buys
 * no higher than mark × (1 + slip), a short sells no lower than mark × (1 −
 * slip).
 *
 * SIZE AT max(worst, mark), FLOORED. policy.ts judges an open's notional at
 * the WORSE of its two prices (a short filled low is a short sized by its best
 * fill). Sizing a short at its worst price alone would floor a base whose
 * notional at the mark is OVER the cap, and the order would be refused for
 * the cap it was sized to. So the base is floored at the higher price and the
 * notional ceiled at it: ceil(floor(N·k/p)·p/k) ≤ N for integer N.
 *
 * THE MINIMUM IS CHECKED, NEVER REACHED. Below it is `perp-below-min`, both
 * minimums: min_base, and min_quote at the LOWER of the two prices (a short's
 * IOC is quoted at its worst price, under the mark).
 *
 * THE STOP IS BUILT FROM THE WORST PRICE (rule 7's entry reference: the entry
 * the position can actually get), with core `stopPrices`. When the owner's
 * slippage is wider than the stop — a long's worst sits so far above the mark
 * that worst × (1 − stop) is not below the mark — a stop from there would sit
 * on the WINNING side of where the market is, and policy refuses it. Then the
 * reference is the mark instead: the stop keeps its distance from the price
 * that is actually trading, and is only ever farther from the fill, never on
 * the wrong side of it.
 *
 * THE LIQUIDATION CHECK IS POLICY'S, LINE FOR LINE (checkPerpOpen): margin at
 * the worst price rounded down, isolated liquidation at the worst price, the
 * market's own maintenance fraction, the stop's WORST price against it by the
 * owner's buffer. A producer that proposed what policy is certain to refuse
 * would spend an open a candle on a refusal.
 */
export function buildOpenDraft(a: OpenDraftArgs): OpenDraftResult {
  const m = a.market;
  const spec = m.spec;
  const mark = m.markPrice;
  if (a.side !== "long" && a.side !== "short") return { ok: false, rule: "perp-order-malformed", detail: "side must be long or short" };
  // The IMF the open asserts is the market's target (rule 6: never chosen here);
  // one outside a fraction's range is a view built wrong, not a leverage.
  if (!Number.isSafeInteger(m.imfBp) || m.imfBp < 1 || m.imfBp > 10_000) {
    return { ok: false, rule: "perp-order-malformed", detail: `market ${m.key} carries no usable margin fraction` };
  }
  if (a.notionalCapMicro <= 0n) return { ok: false, rule: "perp-below-min", minMicro: m.effMinNotionalMicro, capMicro: a.notionalCapMicro < 0n ? 0n : a.notionalCapMicro };
  let worst: bigint;
  try {
    worst = worstPriceForTaker({ isAsk: a.side === "short", mark, maxSlippageBps: a.maxSlippageBps });
  } catch (e) {
    return { ok: false, rule: "perp-order-malformed", detail: `no worst price: ${e instanceof Error ? e.message : String(e)}` };
  }
  const hi = worst > mark ? worst : mark;
  const lo = worst < mark ? worst : mark;
  let base: bigint;
  let notional: bigint;
  let minAtLo: bigint;
  try {
    base = baseForNotional(a.notionalCapMicro, hi, spec, "floor");
    notional = notionalMicro(base, hi, spec, "ceil");
    minAtLo = minOpenBase(spec, lo);
  } catch (e) {
    return { ok: false, rule: "perp-order-malformed", detail: `sizing failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (base <= 0n || base < spec.minBaseAmount || base < minAtLo || notional < m.effMinNotionalMicro) {
    // The larger of the two minimums as the owner would read it: the view's
    // figure at the mark, or what min_base/min_quote need at the lower price.
    let need = m.effMinNotionalMicro;
    try {
      const atLo = notionalMicro(minAtLo, hi, spec, "ceil");
      if (atLo > need) need = atLo;
    } catch {
      /* the view's figure stands */
    }
    return { ok: false, rule: "perp-below-min", minMicro: need, capMicro: a.notionalCapMicro };
  }

  let stop: { trigger: bigint; price: bigint } | null = null;
  for (const ref of [worst, mark]) {
    try {
      const s = stopPrices({ side: a.side, entryRefPrice: ref, stopLossBps: a.stopBps, stopSlipBps: a.stopSlipBps });
      if (a.side === "long" ? s.trigger < lo : s.trigger > hi) {
        stop = s;
        break;
      }
    } catch {
      /* try the next reference */
    }
  }
  if (stop === null) return { ok: false, rule: "perp-order-malformed", detail: "no stop can be placed on the losing side of the mark at this distance" };

  let beats = false;
  let liq: bigint | null = null;
  try {
    const notionalAtWorst = notionalMicro(base, worst, spec, "floor");
    const am = (notionalAtWorst * BigInt(m.imfBp)) / BP;
    liq = isolatedLiqPrice({ side: a.side, entryPrice: worst, baseAmount: base, allocatedMarginMicro: am, mmfBp: spec.mmfBp, spec });
    beats = stopBeatsLiquidation({ side: a.side, stopPrice: stop.price, liqPrice: liq, entryPrice: worst, bufferBps: a.liqBufferBps });
  } catch {
    beats = false;
  }
  if (!beats) {
    // For the owner's sentence only: the distance to liquidation from the
    // fill, less the buffer and the stop's own slippage — the room a stop has.
    let maxStopBps = 0;
    if (liq !== null && liq > 0n) {
      const gap = a.side === "long" ? worst - liq : liq - worst;
      const d = Number((gap * BP) / worst) - a.liqBufferBps - a.stopSlipBps;
      maxStopBps = d > 0 ? d : 0;
    }
    return { ok: false, rule: "perp-stop-inside-liquidation", maxStopBps };
  }

  const draft: PerpOpenDraft = {
    kind: "perp-order",
    venue: "lighter",
    market: m.key,
    marketId: m.marketId,
    effect: "open",
    side: a.side,
    reduceOnly: false,
    baseAmount: base,
    worstPrice: worst,
    markPrice: mark,
    notionalUsdg: notional,
    imfBp: m.imfBp,
    stopTrigger: stop.trigger,
    stopPrice: stop.price,
  };
  // A take-profit only when asked, and only one that can fire: a short cannot
  // take profit at a 100% fall, and a take that rounds onto the entry is none.
  // Skipped rather than refused — the open is then OTO, which is still an
  // open with its stop (the thing rule 7 is about).
  const tp = a.takeProfitBps ?? 0;
  if (Number.isSafeInteger(tp) && tp > 0 && !(a.side === "short" && tp >= 10_000)) {
    try {
      const t = takePrices({ side: a.side, entryRefPrice: worst, takeProfitBps: tp, stopSlipBps: a.stopSlipBps });
      if (a.side === "long" ? t.trigger > hi : t.trigger < lo) {
        draft.takeTrigger = t.trigger;
        draft.takePrice = t.price;
      }
    } catch {
      /* OTO */
    }
  }
  return { ok: true, draft, stopBps: a.stopBps };
}

// ── exits ───────────────────────────────────────────────────────────────────

/**
 * How much a reduce may take, CLAMPED, NEVER REFUSED, FOR SIZE (rule 8).
 *
 *   cut to the venue-read position  — a reduce is never bigger than what is held
 *   raised to the venue minimum     — a reduce too small to be an order is the
 *                                     smallest order, still within the position
 *   a remainder under the minimum   — becomes a close: a dust position left
 *                                     behind could never be closed on its own
 *   the whole position              — is a close
 *
 * The minimum is min_base and min_quote at the mark (minOpenBase), the same
 * figure an open is held to. Returns null only for a request that is not a
 * size at all (≤ 0), which is garbage, not a size to clamp.
 */
export function clampReduce(
  position: Pick<PerpPositionView, "baseAmount">,
  requestedBase: bigint,
  market: Pick<PerpMarketView, "markPrice" | "spec" | "effMinNotionalMicro">,
): { effect: "reduce" | "close"; baseAmount: bigint } | null {
  const held = position.baseAmount;
  if (held <= 0n || requestedBase <= 0n) return null;
  let minBase: bigint;
  try {
    minBase = minOpenBase(market.spec, market.markPrice);
  } catch {
    // Without a minimum the only size that is certainly an order is all of it.
    return { effect: "close", baseAmount: held };
  }
  let b = requestedBase < held ? requestedBase : held;
  if (b < minBase) b = minBase < held ? minBase : held;
  const rest = held - b;
  if (rest > 0n) {
    let restNotional: bigint;
    try {
      restNotional = notionalMicro(rest, market.markPrice, market.spec, "floor");
    } catch {
      restNotional = 0n;
    }
    if (rest < minBase || restNotional < market.effMinNotionalMicro) return { effect: "close", baseAmount: held };
    return { effect: "reduce", baseAmount: b };
  }
  return { effect: "close", baseAmount: held };
}

/**
 * A reduce-only IOC for a held position, built from the market's mark.
 *
 * `side` is the side HELD (the intent's contract), and the order's direction
 * follows from it: closing a long sells (isAsk), closing a short buys. The
 * worst price is the owner's perpsMaxSlippageBps from the mark, toward the
 * side that lets the exit fill. A close is always the full venue-read size;
 * a reduce's size must already be clamped (clampReduce). Null only when the
 * mark cannot carry a worst price at all — an exit this cannot price is left
 * to protect.ts, which reads the account itself.
 */
export function buildExitDraft(a: {
  market: Pick<PerpMarketView, "key" | "marketId" | "markPrice" | "spec">;
  position: Pick<PerpPositionView, "side" | "baseAmount">;
  effect: "reduce" | "close";
  baseAmount?: bigint;
  maxSlippageBps: number;
}): PerpExitDraft | null {
  const base = a.effect === "close" ? a.position.baseAmount : (a.baseAmount ?? 0n);
  if (base <= 0n || base > a.position.baseAmount) return null;
  let worst: bigint;
  let notional: bigint;
  try {
    worst = worstPriceForTaker({ isAsk: a.position.side === "long", mark: a.market.markPrice, maxSlippageBps: a.maxSlippageBps });
    notional = notionalMicro(base, a.market.markPrice, a.market.spec, "ceil");
  } catch {
    return null;
  }
  return {
    kind: "perp-order",
    venue: "lighter",
    market: a.market.key,
    marketId: a.market.marketId,
    effect: a.effect,
    side: a.position.side,
    reduceOnly: true,
    baseAmount: base,
    worstPrice: worst,
    markPrice: a.market.markPrice,
    notionalUsdg: notional,
  };
}
