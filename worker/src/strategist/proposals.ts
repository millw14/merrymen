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

import type { TradeIntent } from "../policy";
import type { Snapshot } from "../strategies/types";
import {
  curveBuyOut,
  curveSellOut,
  curveMinOut,
  curveGraduated,
  type CurveReserves,
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

    if (!Number.isFinite(p.sizeUsdg) || p.sizeUsdg <= 0) {
      rejected.push(`#${i} ${p.symbol}: size ${p.sizeUsdg} is not a positive number`);
      continue;
    }
    const size = usdg6(p.sizeUsdg);

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

    const token = universe.legs.get(p.symbol);
    if (!token) {
      rejected.push(`#${i} ${p.symbol}: not in the tradable universe`);
      continue;
    }
    if (snap.pausedTokens.has(token.toLowerCase())) {
      rejected.push(`#${i} ${p.symbol}: token is paused`);
      continue;
    }

    if (size > universe.maxPerActionUsdg) {
      rejected.push(`#${i} ${p.symbol}: ${p.sizeUsdg} USDG exceeds strategist ceiling`);
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
    if (size > universe.maxPerActionUsdg) {
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
