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

export interface ProposedAction {
  action: "buy" | "sell" | "hold";
  symbol: string;
  /** USDG size for buy/sell; ignored for hold. */
  sizeUsdg: number;
  /** Model's reasoning — logged for the human, never parsed, never trusted. */
  reason: string;
}

export interface StrategistUniverse {
  /** symbol → token for every tradable leg. Anything else is rejected. */
  legs: ReadonlyMap<string, `0x${string}`>;
  swapRouter: `0x${string}`;
  usdg: `0x${string}`;
  /** Hard per-proposal ceiling (6dp) — independent of, and beneath, grant caps. */
  maxPerActionUsdg: bigint;
  maxActionsPerTick: number;
}

export interface ValidationResult {
  intents: TradeIntent[];
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
  const rejected: string[] = [];
  let cashLeft = snap.cashUsdg;

  for (const [i, p] of proposals.entries()) {
    if (intents.length >= universe.maxActionsPerTick) {
      rejected.push(`#${i} ${p.symbol}: max ${universe.maxActionsPerTick} actions per tick reached`);
      continue;
    }
    if (p.action === "hold") continue;

    const token = universe.legs.get(p.symbol);
    if (!token) {
      rejected.push(`#${i} ${p.symbol}: not in the tradable universe`);
      continue;
    }
    if (snap.pausedTokens.has(token.toLowerCase())) {
      rejected.push(`#${i} ${p.symbol}: token is paused`);
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
      intents.push({
        kind: "swap",
        target: universe.swapRouter,
        sellToken: universe.usdg,
        buyToken: token,
        sellAmountRaw: size,
        notionalUsdg: size,
      });
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
    }
  }

  return { intents, rejected };
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
