/**
 * The proposal boundary — the ONLY thing a model may hand the system.
 *
 * A proposal is symbols and USDG sizes. No addresses, no calldata, no targets,
 * no free-form parameters. Deterministic code (this file) validates every
 * proposal against the strategy's own universe and converts survivors into
 * typed TradeIntents, which then face checkPolicy → quote simulation → the
 * on-chain session-key wall like every other intent. The model's words never
 * touch money; only validated structure does.
 */

import { baseForNotional, isPerpKey, isolatedMarginMicro, type PerpKey } from "../../../packages/core/src/perps";
import { buildExitDraft, buildOpenDraft, clampReduce, type PerpIntentDraft } from "../perps/drafts";
import type { TradeIntent } from "../policy";
import type { ResolvedConfig } from "../settings";
import type { PerpsView, Snapshot } from "../strategies/types";
import {
  curveBuyOut,
  curveSellOut,
  curveMinOut,
  curveGraduated,
  type CurveReserves,
  curveBuyImpactBps,
} from "../venues/pons-price";

export interface ProposedAction {
  action: "buy" | "sell" | "hold";
  symbol: string;
  /** USDG size for buy/sell; ignored for hold. */
  sizeUsdg: number;
  /** Model's reasoning — logged for the human, never parsed, never trusted. */
  reason: string;
}

/**
 * Where a symbol trades when it trades on a bonding curve.
 *
 * WHY THE UNIVERSE CARRIES A QUOTE. This file is pure and synchronous on
 * purpose — the boundary a model's words cross has no I/O, so nothing it says
 * can make a network call. But a curve trade needs a `minAmountOutRaw`, and
 * deriving one needs the curve's reserves. So the RESERVES ride here, read once
 * per tick by the caller, and the arithmetic (curveBuyOut / curveMinOut) stays
 * pure and happens below.
 *
 * That also fixes the thing the intent type asks for by name: the quote that
 * sizes the trade and the floor the chain enforces come from ONE reading of a
 * curve the repo's own prose says can move 1,546 bps at p99 over four minutes.
 */
export interface CurveLeg {
  /** The bonding curve. An argument the wall cannot pin — see wall.ts. */
  curve: `0x${string}`;
  /** What the curve is quoted in. `0x000…0` means native ETH, which is unreachable. */
  quoteToken: `0x${string}`;
  /** The PonsSelfTrade adapter sealed into THIS grant — never from settings. */
  adapter: `0x${string}`;
  /** Reserves as of this tick, for the quote. */
  reserves: CurveReserves;
}

export interface StrategistUniverse {
  /** symbol → token for every tradable leg. Anything else is rejected. */
  legs: ReadonlyMap<string, `0x${string}`>;
  swapRouter: `0x${string}`;
  usdg: `0x${string}`;
  /** Hard per-proposal ceiling (6dp) — independent of, and beneath, grant caps. */
  maxPerActionUsdg: bigint;
  /**
   * How far a single BUY may move a bonding curve, in bps.
   *
   * Optional so every existing caller and fixture is unchanged, and absent
   * means unchecked — which is exactly what the autonomous curve path was
   * before this, and why the one caller that can produce a curve trade passes
   * it explicitly.
   */
  maxImpactBps?: number;
  maxActionsPerTick: number;
  /**
   * symbol → its bonding curve, for tokens that trade on one.
   *
   * Optional so every existing caller and fixture keeps working unchanged: a
   * universe without curve legs behaves exactly as it did, which is what makes
   * this additive rather than a rewrite of the boundary.
   */
  curveLegs?: ReadonlyMap<string, CurveLeg>;
  /** symbol → token address for curve legs. Kept beside `legs`, not merged into
   *  it, because `legs` means “has a pool” to every other arm in this file. */
  curveTokens?: ReadonlyMap<string, `0x${string}`>;
  /** Slippage tolerance for a derived curve floor, bps. Defaults to 100. */
  slippageBps?: number;
}

export interface ValidationResult {
  intents: TradeIntent[];
  /** The originating action for each survivor — accepted[i] produced intents[i].
   * Lets the caller journal each decision (symbol/action/size/reason) without
   * re-deriving the pairing, while intents stays a pure TradeIntent[]. */
  accepted: ProposedAction[];
  /** Human-readable reasons for every dropped action — honesty in the log. */
  rejected: string[];
}

const usdg6 = (v: number) => BigInt(Math.round(v * 1e6));

/**
 * Validate a model's proposals against the universe and the live snapshot,
 * converting survivors to TradeIntents. Anything malformed, out-of-universe,
 * oversized, or unaffordable is dropped with a reason — never "fixed up".
 */
export function proposalsToIntents(
  proposals: readonly ProposedAction[],
  universe: StrategistUniverse,
  snap: Snapshot,
): ValidationResult {
  const intents: TradeIntent[] = [];
  const accepted: ProposedAction[] = [];
  const rejected: string[] = [];
  let cashLeft = snap.cashUsdg;

  for (const [i, p] of proposals.entries()) {
    if (intents.length >= universe.maxActionsPerTick) {
      rejected.push(`#${i} ${p.symbol}: max ${universe.maxActionsPerTick} actions per tick reached`);
      continue;
    }
    if (p.action === "hold") continue;

    // A PERP KEY IS NEVER A SPOT SYMBOL (docs/perps.md rule 11). "TSLA-PERP"
    // cannot resolve to a leg today — spot maps are keyed by bare symbol — and
    // this says so by name, so no future leg source can make a perp proposal
    // spelled buy/sell into a swap. Perps travel only as perpActions.
    if (/-PERP$/i.test(p.symbol)) {
      rejected.push(`#${i} ${p.symbol}: a perp market is not a spot symbol — perps are proposed as perpActions`);
      continue;
    }

    if (!Number.isFinite(p.sizeUsdg) || p.sizeUsdg <= 0) {
      rejected.push(`#${i} ${p.symbol}: size ${p.sizeUsdg} is not a positive number`);
      continue;
    }
    const size = usdg6(p.sizeUsdg);

    // ── THE CEILING, ABOVE BOTH VENUES ────────────────────────────────────
    //
    // This used to sit below the curve branch's `continue`, so it applied to
    // pool swaps and to nothing else. A curve trade — the least priceable asset
    // class on this chain — was the one venue with no per-action ceiling at all.
    // Nothing exercised that, because no production caller has ever supplied
    // curve legs; the moment one does, the gap becomes an unbounded proposal
    // size into exactly the assets that are hardest to value.
    //
    // Venue-agnostic by construction now: it reads `size`, computed once above,
    // and it is the last thing between a number the model chose and a number
    // that reaches the wall.
    // A SELL IS NOT SPENDING, so the ceiling does not bound it.
    //
    // THE SAME MIRROR ERROR, ONE LAYER UP. policy.ts fixed this at the wall:
    // the chain caps the USDG approve that FUNDS a buy and emits the sell-side
    // approve with no amount condition at all, so bounding a sell there was the
    // mirror being stricter than the chain. This boundary reproduced it — the
    // ceiling sat above the buy/sell split and applied to both.
    //
    // What that cost, concretely: on this owner grant the ceiling is
    // min(llmMaxActionUsdg 50, perTradeCap 10) = 10 USDG. A position grown past
    // 10 USDG could never be fully sold by the strategist, and one that doubled
    // could not be sold at all — structurally able to exit its losers and unable
    // to exit its winners, which presents as a stuck position rather than an
    // error. llmMaxActionUsdg stays a bound on what one action may SPEND, which
    // is what its own name says. Buys are untouched.
    if (p.action !== "sell" && size > universe.maxPerActionUsdg) {
      rejected.push(`#${i} ${p.symbol}: ${p.sizeUsdg} USDG exceeds strategist ceiling`);
      continue;
    }

    // ── the curve venue ───────────────────────────────────────────────────
    //
    // THE STAGE THAT MAKES THE AGENT ABLE TO PROPOSE ONE AT ALL. Every arm below
    // constructs `kind: "swap"` against a single `swapRouter`, so no matter what
    // else shipped, the strategist could never emit a curve trade — while
    // memecoin-scout already tells the model that coins launch on the Pons
    // launchpad. The model could name a curve coin and this boundary would
    // always answer "not in the tradable universe".
    //
    // Checked BEFORE the pool legs, because a token that trades on a curve has
    // no pool: routing it to the swap router builds an operation against a pool
    // that does not exist.
    const curveLeg = universe.curveLegs?.get(p.symbol);
    if (curveLeg) {
      const token = universe.curveTokens?.get(p.symbol);
      if (!token) {
        rejected.push(`#${i} ${p.symbol}: curve leg with no token address`);
        continue;
      }
      if (snap.pausedTokens.has(token.toLowerCase())) {
        rejected.push(`#${i} ${p.symbol}: token is paused`);
        continue;
      }
      // NATIVE-QUOTED CURVES ARE UNREACHABLE, and saying so beats a revert. The
      // adapter is non-payable and every wall permission carries valueLimit 0.
      if (/^0x0{40}$/i.test(curveLeg.quoteToken)) {
        rejected.push(`#${i} ${p.symbol}: curve is quoted in native ETH, which this adapter cannot trade`);
        continue;
      }
      if (curveGraduated(curveLeg.reserves)) {
        rejected.push(`#${i} ${p.symbol}: curve has graduated — its market is a pool now`);
        continue;
      }

      const isBuy = p.action === "buy";
      let amountInRaw: bigint;
      let assetIn: `0x${string}`;
      let assetOut: `0x${string}`;
      if (isBuy) {
        // Only a USDG-quoted curve is one hop from the agent's cash. Anything
        // else needs a hop through the quote asset first, which is not built.
        if (curveLeg.quoteToken.toLowerCase() !== universe.usdg.toLowerCase()) {
          rejected.push(`#${i} ${p.symbol}: curve is not quoted in USDG, so buying it needs a hop I don't do yet`);
          continue;
        }
        if (size > cashLeft) {
          rejected.push(`#${i} ${p.symbol}: buy ${p.sizeUsdg} USDG exceeds available cash`);
          continue;
        }
        assetIn = universe.usdg;
        assetOut = token;
        amountInRaw = size;
      } else {
        const held = snap.holdings.get(p.symbol);
        if (!held || held.rawBalance === 0n) {
          rejected.push(`#${i} ${p.symbol}: nothing held to sell`);
          continue;
        }
        assetIn = token;
        assetOut = curveLeg.quoteToken;
        // Proportional where the holding has a value, whole where it does not.
        // A curve token the guard refuses to price has valueUsdg 0, and the
        // right answer there is to sell all of it rather than nothing.
        amountInRaw =
          held.valueUsdg > 0n && size < held.valueUsdg
            ? (held.rawBalance * size) / held.valueUsdg
            : held.rawBalance;
      }
      if (amountInRaw <= 0n) {
        rejected.push(`#${i} ${p.symbol}: size rounds to zero`);
        continue;
      }

      // ── IMPACT, ON THE THINNEST VENUE ON THE CHAIN ────────────────────
      //
      // Both swap branches call judgeImpact, and the owner-typed chat producer
      // checks curveBuyImpactBps against the same ceiling. The AUTONOMOUS curve
      // path had neither — which cost nothing while no production caller
      // supplied curve legs, and became the gap the moment one did.
      //
      // Checked in the producer, like the chat path, because this is where the
      // reserves are: the executor holds only an intent and would have to read
      // them again, and curve-prices.ts is explicit that two reads of one tick
      // are two different markets.
      //
      // Buys only. Impact on the way OUT is a cost of leaving, and refusing an
      // exit because leaving is expensive is how an agent locks itself into the
      // position it most needs to close.
      if (isBuy && universe.maxImpactBps !== undefined) {
        const impact = curveBuyImpactBps(curveLeg.reserves, amountInRaw);
        if (impact !== null && impact > universe.maxImpactBps) {
          rejected.push(
            `#${i} ${p.symbol}: this size moves the curve ${(impact / 100).toFixed(1)}%, ` +
              `over the ${(universe.maxImpactBps / 100).toFixed(1)}% ceiling`,
          );
          continue;
        }
      }

      const quoted = isBuy
        ? curveBuyOut(curveLeg.reserves, amountInRaw)
        : curveSellOut(curveLeg.reserves, amountInRaw);
      if (quoted === null) {
        rejected.push(`#${i} ${p.symbol}: the curve's reserves don't support a trade this size`);
        continue;
      }
      const minAmountOutRaw = curveMinOut(quoted, universe.slippageBps ?? 100);
      if (minAmountOutRaw === null || minAmountOutRaw <= 0n) {
        rejected.push(`#${i} ${p.symbol}: no slippage floor could be derived — refusing to size it blind`);
        continue;
      }

      if (isBuy) cashLeft -= size;
      intents.push({
        kind: "curve-trade",
        target: curveLeg.adapter,
        curve: curveLeg.curve,
        assetIn,
        assetOut,
        amountInRaw,
        minAmountOutRaw,
        notionalUsdg: isBuy ? size : quoted,
      });
      accepted.push(p);
      continue;
    }

    /**
     * AN EXIT MUST ALWAYS BE ATTEMPTABLE, and this line refused one.
     *
     * `universe.legs` is what may be BOUGHT — it is narrowed by the basket, and
     * now by the owner's asset mode. Judging a SELL against it means an agent
     * holding a position can be refused the way out by our own boundary, while
     * the wall itself would have allowed it: `policy.ts` says in as many words
     * that "Sells are never blocked by this rule" and judges direction "by what
     * is being BOUGHT".
     *
     * THIS IS A LATENT BUG, NOT A NEW ONE. Any owner who un-ticks a basket
     * symbol while holding it is already in this state today; the asset mode
     * only makes it easy to reach. So a sell resolves its address from
     * `snap.holdings` — the chain read — when the leg set does not carry it.
     *
     * Strictly narrower than widening `legs`: it can only ever produce a SELL of
     * something the account demonstrably holds, and it cannot create a buy.
     */
    const token =
      universe.legs.get(p.symbol) ??
      (p.action === "sell" ? snap.holdings.get(p.symbol)?.token : undefined);
    if (!token) {
      rejected.push(`#${i} ${p.symbol}: not in the tradable universe`);
      continue;
    }
    if (snap.pausedTokens.has(token.toLowerCase())) {
      rejected.push(`#${i} ${p.symbol}: token is paused`);
      continue;
    }

    if (p.action === "buy") {
      if (size > cashLeft) {
        rejected.push(`#${i} ${p.symbol}: buy ${p.sizeUsdg} USDG exceeds available cash`);
        continue;
      }
      cashLeft -= size;
      intents.push({
        kind: "swap",
        target: universe.swapRouter,
        sellToken: universe.usdg,
        buyToken: token,
        sellAmountRaw: size,
        notionalUsdg: size,
      });
      accepted.push(p);
    } else {
      const held = snap.holdings.get(p.symbol);
      if (!held || held.rawBalance === 0n) {
        rejected.push(`#${i} ${p.symbol}: nothing held to sell`);
        continue;
      }
      // Sell size → raw shares, proportional to the holding's current value.
      // Capped at the full holding; tiny valuations sell everything.
      const sellRaw =
        held.valueUsdg > 0n && size < held.valueUsdg
          ? (held.rawBalance * size) / held.valueUsdg
          : held.rawBalance;
      const notional = size < held.valueUsdg ? size : held.valueUsdg;
      if (sellRaw === 0n) {
        rejected.push(`#${i} ${p.symbol}: sell size rounds to zero shares`);
        continue;
      }
      intents.push({
        kind: "swap",
        target: universe.swapRouter,
        sellToken: token,
        buyToken: universe.usdg,
        sellAmountRaw: sellRaw,
        notionalUsdg: notional,
      });
      accepted.push(p);
    }
  }

  return { intents, accepted, rejected };
}

export interface EquityUniverse {
  /** Uppercase tickers the strategy may touch. Anything else is rejected. */
  tickers: ReadonlySet<string>;
  /** Hard per-proposal ceiling (6dp) — independent of, and beneath, grant caps. */
  maxPerActionUsdg: bigint;
  maxActionsPerTick: number;
}

/**
 * The equities twin of proposalsToIntents — same boundary, different rail.
 *
 * What is deliberately ABSENT is the point: no addresses, no router, no
 * paused-token set, and none of the 18dp share arithmetic — an equity order
 * carries a dollar notional and shares are derived at the fill, never proposed.
 * The model's output stays symbols-and-sizes on both rails; only the validated
 * structure differs.
 *
 * Buys are gated on SETTLED CASH, which the caller supplies — never buying
 * power, because margin is not money (DESIGN.md §6). Sells are capped at the
 * held value: you cannot sell what you do not hold, and a clamped sell is
 * recorded as a clamp, not silently resized.
 */
export function proposalsToEquityIntents(
  proposals: readonly ProposedAction[],
  universe: EquityUniverse,
  book: {
    /** Settled cash, 6dp. NOT buying power. */
    cashUsdg: bigint;
    /** Current value of the holding in this symbol, 6dp; 0n = nothing held. */
    heldValueUsdg: (symbol: string) => bigint;
  },
): ValidationResult {
  const intents: TradeIntent[] = [];
  const accepted: ProposedAction[] = [];
  const rejected: string[] = [];
  let cashLeft = book.cashUsdg;

  for (const [i, p] of proposals.entries()) {
    if (intents.length >= universe.maxActionsPerTick) {
      rejected.push(`#${i} ${p.symbol}: max ${universe.maxActionsPerTick} actions per tick reached`);
      continue;
    }
    if (p.action === "hold") continue;

    const ticker = p.symbol.toUpperCase();
    if (!universe.tickers.has(ticker)) {
      rejected.push(`#${i} ${p.symbol}: not in the tradable universe`);
      continue;
    }
    if (!Number.isFinite(p.sizeUsdg) || p.sizeUsdg <= 0) {
      rejected.push(`#${i} ${p.symbol}: size ${p.sizeUsdg} is not a positive number`);
      continue;
    }
    const size = usdg6(p.sizeUsdg);
    // A SELL IS NOT SPENDING, so the ceiling does not bound it.
    //
    // THE SAME MIRROR ERROR, ONE LAYER UP. policy.ts fixed this at the wall:
    // the chain caps the USDG approve that FUNDS a buy and emits the sell-side
    // approve with no amount condition at all, so bounding a sell there was the
    // mirror being stricter than the chain. This boundary reproduced it — the
    // ceiling sat above the buy/sell split and applied to both.
    //
    // What that cost, concretely: on this owner grant the ceiling is
    // min(llmMaxActionUsdg 50, perTradeCap 10) = 10 USDG. A position grown past
    // 10 USDG could never be fully sold by the strategist, and one that doubled
    // could not be sold at all — structurally able to exit its losers and unable
    // to exit its winners, which presents as a stuck position rather than an
    // error. llmMaxActionUsdg stays a bound on what one action may SPEND, which
    // is what its own name says. Buys are untouched.
    if (p.action !== "sell" && size > universe.maxPerActionUsdg) {
      rejected.push(`#${i} ${p.symbol}: ${p.sizeUsdg} USDG exceeds strategist ceiling`);
      continue;
    }

    if (p.action === "buy") {
      if (size > cashLeft) {
        rejected.push(`#${i} ${p.symbol}: buy ${p.sizeUsdg} USDG exceeds available cash`);
        continue;
      }
      cashLeft -= size;
      intents.push({ kind: "equity-order", ticker, side: "buy", notionalUsdg: size });
      accepted.push(p);
    } else {
      const held = book.heldValueUsdg(ticker);
      if (held <= 0n) {
        rejected.push(`#${i} ${p.symbol}: nothing held to sell`);
        continue;
      }
      const notional = size < held ? size : held;
      intents.push({ kind: "equity-order", ticker, side: "sell", notionalUsdg: notional });
      accepted.push(p);
    }
  }

  return { intents, accepted, rejected };
}

/** Shape-check raw model output into ProposedActions; junk is dropped, not repaired. */
export function parseProposals(raw: unknown): { actions: ProposedAction[]; malformed: number } {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { actions?: unknown }).actions)) {
    return { actions: [], malformed: 1 };
  }
  const actions: ProposedAction[] = [];
  let malformed = 0;
  for (const a of (raw as { actions: unknown[] }).actions) {
    if (
      a &&
      typeof a === "object" &&
      ["buy", "sell", "hold"].includes((a as ProposedAction).action) &&
      typeof (a as ProposedAction).symbol === "string" &&
      (((a as ProposedAction).action === "hold") || typeof (a as ProposedAction).sizeUsdg === "number")
    ) {
      const p = a as ProposedAction;
      actions.push({
        action: p.action,
        symbol: p.symbol,
        sizeUsdg: p.action === "hold" ? 0 : p.sizeUsdg,
        reason: typeof p.reason === "string" ? p.reason.slice(0, 300) : "",
      });
    } else {
      malformed += 1;
    }
  }
  return { actions, malformed };
}

// ── perpetuals: what a model may hand the perps route ───────────────────────
//
// docs/perps.md rule 15: THE MODEL PROPOSES, DETERMINISTIC CODE DISPOSES. A
// perp proposal names a market KEY, an effect, the side, a notional in USDG
// and — for an open — a stop distance. Never a leverage (it is venue state
// set from the owner's perpsMaxLeverage, rule 6), a market id, a price
// integer, a key or an address; the schema has no field any of those fit in.
// A short is a SIDE, never spelled "sell".
//
// OPENS ARE REFUSED, NEVER REPAIRED. An open outside the owner's markets,
// without a stop, with a stop outside [PERP_STOP_FLOOR_PCT, perpsStopLossPct],
// under the venue minimum or over any cap, on a market already holding a
// position or an unresolved order, is dropped with its reason — not moved to
// the nearest thing that would pass. A model that asked for 60 USDG on a 25
// USDG cap asked for something else, and quietly sending 25 would be the
// boundary choosing a trade nobody proposed.
//
// EXITS ARE CLAMPED, NEVER REFUSED FOR SIZE (rule 8). A reduce is cut to the
// venue-read position, raised to the venue minimum, and a remainder under the
// minimum becomes a close; a close is always the whole venue-read size. What
// an exit IS still held to is being an exit: a position must be held there,
// on the side named — a close naming the wrong side is refused
// (`perp-side-mismatch`), never reinterpreted, because reinterpreting it is
// how a close becomes an open.

/** One perp action as a model proposes it. */
export interface PerpProposal {
  /** A key of LIGHTER_MARKETS_V1, e.g. "BTC-PERP". */
  market: PerpKey;
  effect: "open" | "reduce" | "close";
  /** For an open, the side to take; for a reduce or close, the side HELD. */
  side: "long" | "short";
  /** USDG. An open's size (its full notional, not its margin); a reduce's size; ignored for a close. */
  notionalUsdg: number;
  /** An open's stop distance from the entry, percent. Required for an open; ignored otherwise. */
  stopPct?: number;
  /** The model's reasoning — logged for the human, never parsed, never trusted. */
  reason: string;
}

/**
 * The narrowest stop a model may ask for, in percent. A stop tighter than one
 * percent on a 4 h-volatile crypto perp is a stop that fires on noise, and a
 * model asking for one is buying a guaranteed loss. Settings keep
 * perpsStopLossPct ≥ this (its bounds are 1–25), so the range is never empty.
 */
export const PERP_STOP_FLOOR_PCT = 1;

/** The settings the boundary reads. */
export type PerpBoundarySettings = Pick<
  ResolvedConfig,
  | "perpsEnabled"
  | "perpsDriver"
  | "perpsMarkets"
  | "perpsPerTradeUsdg"
  | "perpsStopLossPct"
  | "perpsStopSlipBps"
  | "perpsMaxSlippageBps"
  | "perpsLiqBufferPct"
  | "perpsTakeProfitPct"
>;

/** The ceilings the caller measured this window. */
export interface PerpBoundaryCaps {
  /** The grant's sealed per-trade cap, micro-USDG. */
  perTradeSealedMicro: bigint;
  /** The strategist ceiling on what one action may spend (llmMaxActionUsdg), micro-USDG. */
  maxPerActionMicro: bigint;
  /** Today's spend headroom, micro-USDG; null = not read (then it does not bind here; the wall's daily cap still does). */
  spendHeadroomMicro: bigint | null;
  /** New positions this window may still add (maxActionsPerTick less the spot actions kept). Exits never count. */
  maxOpens?: number;
}

export interface PerpValidationResult {
  /** Survivors, fully built. accepted[i] produced intents[i]. */
  intents: PerpIntentDraft[];
  accepted: PerpProposal[];
  /** Every refusal: the proposal, a rule slug, and the reason in words. */
  dropped: { proposal: PerpProposal; why: string; detail: string }[];
}

const usdgMicroOf = (v: number) => BigInt(Math.round(v * 1e6));
const money = (micro: bigint) => `${(Number(micro) / 1e6).toFixed(2)} USDG`;

/**
 * Validate a model's perp proposals against this window's venue read and the
 * owner's settings, building survivors into perp-order intents (no
 * decisionId: the strategist journals them under `perp:strategist`).
 *
 * NOTHING UNLESS THE STRATEGIST IS THE DRIVER. One writer per book: under
 * `perp-trend` or `manual` every proposal is dropped, whatever it says.
 * Nothing either when Lighter was not read: an exit sized off a position
 * nobody read is a guess.
 */
export function proposalsToPerpIntents(
  proposals: readonly PerpProposal[],
  view: PerpsView | null | undefined,
  settings: PerpBoundarySettings,
  caps: PerpBoundaryCaps,
): PerpValidationResult {
  const out: PerpValidationResult = { intents: [], accepted: [], dropped: [] };
  const drop = (proposal: PerpProposal, why: string, detail: string) => out.dropped.push({ proposal, why, detail });
  if (settings.perpsDriver !== "strategist") {
    for (const p of proposals) drop(p, "perp-not-driver", "the perps driver is not the strategist, so it proposes no perp actions");
    return out;
  }
  if (!view) {
    for (const p of proposals) drop(p, "perp-unpriced", "Lighter could not be read this window");
    return out;
  }
  const allowed = new Set<string>(settings.perpsMarkets);
  const touched = new Set<string>();
  let opens = 0;
  let openNotionalLeft = view.headroom.openNotionalLeftMicro;
  let collateralLeft = view.account.freeCollateralMicro + view.headroom.collateralLeftMicro;
  let spendLeft = caps.spendHeadroomMicro;
  const perTrade = [usdgMicroOf(settings.perpsPerTradeUsdg), caps.perTradeSealedMicro, caps.maxPerActionMicro, view.headroom.perTradeNotionalMicro].reduce((a, b) =>
    b < a ? b : a,
  );

  for (const p of proposals) {
    const key = p.market;
    if (!isPerpKey(key)) {
      drop(p, "perp-market-not-allowed", `${String(key)} is not a perp market`);
      continue;
    }
    if (touched.has(key)) {
      drop(p, "perp-duplicate", `one action per market per window; ${key} already has one`);
      continue;
    }
    const m = view.markets.get(key);

    if (p.effect === "reduce" || p.effect === "close") {
      const pos = view.positions.get(key);
      if (pos === undefined || pos.baseAmount <= 0n) {
        drop(p, "perp-no-position", `nothing is held on ${key}`);
        continue;
      }
      if (p.side !== pos.side) {
        drop(p, "perp-side-mismatch", `the ${key} position is ${pos.side}; an exit names the side held`);
        continue;
      }
      if (m === undefined) {
        drop(p, "perp-unpriced", `${key}'s mark could not be read this window`);
        continue;
      }
      let effect: "reduce" | "close" = "close";
      let base = pos.baseAmount;
      if (p.effect === "reduce") {
        const n = p.notionalUsdg;
        if (Number.isNaN(n) || typeof n !== "number") {
          drop(p, "non-positive", `a reduce of ${String(n)} USDG is not a size`);
          continue;
        }
        let requested: bigint;
        if (!Number.isFinite(n) || n > 1e12) requested = pos.baseAmount;
        else if (n <= 0) requested = 1n; // raised to the venue minimum below
        else {
          try {
            requested = baseForNotional(usdgMicroOf(n), m.markPrice, m.spec, "floor");
          } catch {
            requested = 1n;
          }
          if (requested <= 0n) requested = 1n;
        }
        const c = clampReduce(pos, requested, m);
        if (c === null) {
          drop(p, "perp-no-position", `nothing is held on ${key}`);
          continue;
        }
        effect = c.effect;
        base = c.baseAmount;
      }
      const draft = buildExitDraft({ market: m, position: pos, effect, baseAmount: base, maxSlippageBps: settings.perpsMaxSlippageBps });
      if (draft === null) {
        drop(p, "perp-unpriced", `${key}'s mark cannot bound an exit this window`);
        continue;
      }
      touched.add(key);
      out.intents.push(draft);
      out.accepted.push(p);
      continue;
    }

    if (p.effect !== "open") {
      drop(p, "perp-order-malformed", `"${String(p.effect)}" is not an effect`);
      continue;
    }
    // ── an open: every rule, in the order an owner would ask them ──────
    if (!settings.perpsEnabled) {
      drop(p, "perp-not-enabled", "perpetuals are off for this agent");
      continue;
    }
    if (!allowed.has(key)) {
      drop(p, "perp-market-not-allowed", `${key} is not one of the perp markets the owner allowed`);
      continue;
    }
    if (m === undefined) {
      drop(p, "perp-unpriced", `${key}'s terms could not be read this window`);
      continue;
    }
    if (m.status !== "active") {
      drop(p, "perp-market-inactive", `${key} is ${m.status} at the venue`);
      continue;
    }
    if (view.opensBlocked !== null) {
      drop(p, "perp-opens-blocked", `no new positions right now (${view.opensBlocked})`);
      continue;
    }
    if (view.positions.has(key)) {
      drop(p, "perp-add-to-position", `there is already a ${view.positions.get(key)!.side} ${key} position; an open never adds to one or flips it`);
      continue;
    }
    if (view.unresolved.has(key)) {
      drop(p, "perp-order-unresolved", `an order on ${key} has no final outcome yet`);
      continue;
    }
    if (caps.maxOpens !== undefined && opens >= caps.maxOpens) {
      drop(p, "max-actions", `no more new positions this window`);
      continue;
    }
    if (p.side !== "long" && p.side !== "short") {
      drop(p, "perp-order-malformed", `"${String(p.side)}" is not a side`);
      continue;
    }
    const stopPct = p.stopPct;
    if (typeof stopPct !== "number" || !Number.isFinite(stopPct)) {
      drop(p, "perp-stop-required", "every open carries a stop distance");
      continue;
    }
    if (stopPct < PERP_STOP_FLOOR_PCT || stopPct > settings.perpsStopLossPct) {
      drop(p, "perp-stop-out-of-range", `a ${stopPct}% stop is outside ${PERP_STOP_FLOOR_PCT}–${settings.perpsStopLossPct}%`);
      continue;
    }
    if (typeof p.notionalUsdg !== "number" || !Number.isFinite(p.notionalUsdg) || p.notionalUsdg <= 0 || p.notionalUsdg > 1e12) {
      drop(p, "non-positive", `${String(p.notionalUsdg)} USDG is not a size`);
      continue;
    }
    const want = usdgMicroOf(p.notionalUsdg);
    if (want > perTrade) {
      drop(p, "perp-per-trade-cap", `${money(want)} is over the ${money(perTrade)} most one new position may be`);
      continue;
    }
    if (want > openNotionalLeft) {
      drop(p, "perp-open-notional-cap", `${money(want)} is over the ${money(openNotionalLeft > 0n ? openNotionalLeft : 0n)} of open size left`);
      continue;
    }
    if (spendLeft !== null && want > spendLeft) {
      drop(p, "daily-cap", `${money(want)} is over what is left of today's spending`);
      continue;
    }
    if (want < m.effMinNotionalMicro) {
      drop(p, "perp-below-min", `${money(want)} is under Lighter's ${money(m.effMinNotionalMicro)} minimum on ${key}`);
      continue;
    }
    let margin: bigint;
    try {
      margin = isolatedMarginMicro(want, m.imfBp);
    } catch {
      drop(p, "perp-order-malformed", `${key} carries no usable margin fraction`);
      continue;
    }
    if (margin > collateralLeft) {
      drop(p, "perp-collateral-cap", `its ${money(margin)} of margin is more than can be committed at Lighter`);
      continue;
    }
    const built = buildOpenDraft({
      market: m,
      side: p.side,
      notionalCapMicro: want,
      stopBps: Math.round(stopPct * 100),
      maxSlippageBps: settings.perpsMaxSlippageBps,
      stopSlipBps: settings.perpsStopSlipBps,
      liqBufferBps: Math.round(settings.perpsLiqBufferPct * 100),
      takeProfitBps: Math.round(settings.perpsTakeProfitPct * 100),
    });
    if (!built.ok) {
      if (built.rule === "perp-below-min") drop(p, "perp-below-min", `under Lighter's ${money(built.minMicro)} minimum on ${key}`);
      else if (built.rule === "perp-stop-inside-liquidation") drop(p, "perp-stop-inside-liquidation", `a ${stopPct}% stop would fill after the venue liquidates at this leverage`);
      else drop(p, "perp-order-malformed", built.detail);
      continue;
    }
    touched.add(key);
    opens += 1;
    openNotionalLeft -= built.draft.notionalUsdg;
    collateralLeft -= margin;
    if (spendLeft !== null) spendLeft -= built.draft.notionalUsdg;
    out.intents.push(built.draft);
    out.accepted.push(p);
  }
  return out;
}

/**
 * Shape-check a model's `perpActions` (read off the tool input) into
 * PerpProposals; junk is dropped, never repaired. ABSENT is not malformed —
 * the field is optional in the schema and most windows have nothing to do on
 * perps. A market that is not a key of LIGHTER_MARKETS_V1 is junk here; an
 * allowed-or-not key is the boundary's to judge (and journal).
 */
export function parsePerpProposals(raw: unknown): { actions: PerpProposal[]; malformed: number } {
  if (!raw || typeof raw !== "object") return { actions: [], malformed: 0 };
  const list = (raw as { perpActions?: unknown }).perpActions;
  if (list === undefined) return { actions: [], malformed: 0 };
  if (!Array.isArray(list)) return { actions: [], malformed: 1 };
  const actions: PerpProposal[] = [];
  let malformed = 0;
  for (const a of list) {
    if (!a || typeof a !== "object") {
      malformed += 1;
      continue;
    }
    const o = a as Record<string, unknown>;
    const market = o.market;
    const effect = o.effect;
    const side = o.side;
    if (
      !isPerpKey(market) ||
      (effect !== "open" && effect !== "reduce" && effect !== "close") ||
      (side !== "long" && side !== "short") ||
      typeof o.notionalUsdg !== "number" ||
      (o.stopPct !== undefined && typeof o.stopPct !== "number")
    ) {
      malformed += 1;
      continue;
    }
    actions.push({
      market,
      effect,
      side,
      notionalUsdg: o.notionalUsdg,
      ...(typeof o.stopPct === "number" ? { stopPct: o.stopPct } : {}),
      reason: typeof o.reason === "string" ? o.reason.trim().slice(0, 300) : "",
    });
  }
  return { actions, malformed };
}

/** The decision-row action for a perp intent: open-long, reduce-short, close-long… never buy or sell. */
export function perpActionLabel(i: Pick<PerpIntentDraft, "effect" | "side">): string {
  return `${i.effect}-${i.side}`;
}
