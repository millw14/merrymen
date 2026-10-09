/**
 * Gap strategy — the strategy class that only exists here: tokenized equities
 * trade 24/7 while the underlying markets close every night and weekend.
 *
 * Deterministic state machine, keyed off feed staleness (robust to holidays —
 * no market calendar needed):
 *
 *   leg's feed goes stale (market just closed / is closed) and we hold none
 *     → ENTER: buy the leg's slice of the budget. Token keeps trading; the
 *       underlying is frozen at the close print.
 *   leg's feed is fresh (market open) and we hold the leg
 *     → EXIT: sell the full holding back to USDG, realizing the gap between
 *       the close and the open.
 *
 * The strategy is stateless: entered/exited is derived from holdings, so a
 * worker restart mid-weekend picks up exactly where it left off.
 */

import { entryGateFor, lockedLegs } from "../entry-gates";
import type { TradeIntent } from "../policy";
import { breakerIdle, type Snapshot, type Tick } from "./types";
import type { Why } from "./reasons";

export interface GapLeg {
  symbol: string;
  token: `0x${string}`;
  weightBps: number; // sums to 10_000 across legs
}

export interface WeekendGapConfig {
  legs: GapLeg[];
  /** Total USDG (6dp) deployed per gap window across all legs. */
  enterBudgetUsdg: bigint;
  swapRouter: `0x${string}`;
  usdg: `0x${string}`;
}

export function weekendGapTick(cfg: WeekendGapConfig, snap: Snapshot): Tick {
  if (!snap.sequencerUp) return { intents: [], why: [] };

  const intents: TradeIntent[] = [];
  const why: (Why | null)[] = [];
  // Tripped, the wall refuses every entry at the close; the exit at the open
  // is a sell into cash and still goes. `withheld` is what lets a tick that
  // did nothing BECAUSE of it say so.
  const brake = breakerIdle(snap);
  let withheld = false;
  // Entries skipped because the signed key cannot sell the leg back — the exit
  // at the open would be the sell it cannot make, so the wall refuses the buy.
  let locked = 0;

  for (const leg of cfg.legs) {
    if (snap.pausedTokens.has(leg.token.toLowerCase())) continue;
    const held = snap.holdings.get(leg.symbol);
    const marketClosed = snap.staleFeeds.has(leg.symbol);

    if (marketClosed && !held) {
      // ENTER at the close. Budget is split up front; insufficient cash for
      // the full slice means we skip the leg rather than size down silently.
      const slice = (cfg.enterBudgetUsdg * BigInt(leg.weightBps)) / 10_000n;
      if (slice === 0n || snap.cashUsdg < slice) continue;
      if (brake) {
        withheld = true;
        continue;
      }
      // Behind the breaker, which withholds every entry and says so first.
      if (entryGateFor(snap.entryGates, leg.token)) {
        locked += 1;
        continue;
      }
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: cfg.usdg,
        buyToken: leg.token,
        sellAmountRaw: slice,
        notionalUsdg: slice,
      });
      why.push({ code: "gap-enter", symbol: leg.symbol, usdgRaw: slice });
    } else if (!marketClosed && held && held.rawBalance > 0n) {
      // EXIT at the open — full position, back to cash.
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: leg.token,
        buyToken: cfg.usdg,
        sellAmountRaw: held.rawBalance,
        notionalUsdg: held.valueUsdg,
      });
      why.push({ code: "gap-exit", symbol: leg.symbol });
    }
  }

  // A gap strategy enters only at the close, so "every leg it could have
  // entered" is the honest reading of legs-locked here: nothing was proposed,
  // and every entry the window offered was one the key does not cover.
  return brake && withheld && intents.length === 0
    ? { intents, why, idle: brake }
    : locked > 0 && intents.length === 0
      ? { intents, why, idle: { code: "legs-locked", legs: cfg.legs.length, locked: lockedLegs(snap.entryGates, cfg.legs) } }
      : { intents, why };
}
