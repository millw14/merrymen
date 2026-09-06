/**
 * Steady Basket — Phase 1's deterministic strategy. No LLM anywhere.
 * DCA a fixed USDG amount into a weighted stock-token basket on a schedule,
 * park idle USDG in the Morpho Steakhouse vault between buys.
 *
 * A Strategy NEVER executes anything. It reads a snapshot and returns intents;
 * the runner pushes each intent through checkPolicy → simulate → execute.
 */

import type { TradeIntent } from "../policy";
import type { Snapshot, Tick } from "./types";
import type { Why } from "./reasons";

export type { Snapshot };

export interface BasketLeg {
  symbol: string;
  token: `0x${string}`;
  weightBps: number; // sums to 10_000 across legs
}

export interface SteadyBasketConfig {
  legs: BasketLeg[];
  buyPerTickUsdg: bigint;
  /** Idle USDG above this floor gets deposited to the vault. */
  idleFloorUsdg: bigint;
  /** Venue-agnostic: Rialto meta-router or Uniswap SwapRouter02, runner's pick. */
  swapRouter: `0x${string}`;
  vault: `0x${string}`;
  usdg: `0x${string}`;
}

export function steadyBasketTick(cfg: SteadyBasketConfig, snap: Snapshot): Tick {
  if (!snap.sequencerUp) return { intents: [], why: [] };

  // Cash can't cover a buy but the vault can: pull enough back to fund the next
  // tick's buy plus the liquidity floor. Withdraw-only tick — buys resume next
  // tick once the cash has actually landed.
  if (snap.cashUsdg < cfg.buyPerTickUsdg && snap.vaultUsdg > 0n) {
    const need = cfg.buyPerTickUsdg + cfg.idleFloorUsdg - snap.cashUsdg;
    const amountUsdg = need > snap.vaultUsdg ? snap.vaultUsdg : need;
    return {
      intents: [{ kind: "vault-withdraw", target: cfg.vault, amountUsdg }],
      why: [{ code: "unpark", usdgRaw: amountUsdg, needRaw: need }],
    };
  }

  const intents: TradeIntent[] = [];
  // Positionally paired with `intents` — see Tick. Pushed together, always.
  const why: (Why | null)[] = [];

  // Counted so the tick can say WHY it bought nothing. An empty intent list
  // reads identically whether the schedule declined, the feeds were stale, or
  // the cash was short — and only this function can tell them apart.
  let skippedStale = 0;
  let skippedPaused = 0;

  if (snap.cashUsdg >= cfg.buyPerTickUsdg) {
    for (const leg of cfg.legs) {
      if (snap.pausedTokens.has(leg.token.toLowerCase())) {
        skippedPaused += 1;
        continue;
      }
      if (snap.staleFeeds.has(leg.symbol)) {
        skippedStale += 1;
        continue; // no reference price → no trade
      }
      const legAmount = (cfg.buyPerTickUsdg * BigInt(leg.weightBps)) / 10_000n;
      if (legAmount === 0n) continue;
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: cfg.usdg,
        buyToken: leg.token,
        sellAmountRaw: legAmount,
        notionalUsdg: legAmount,
      });
      why.push({
        code: "dca-leg",
        symbol: leg.symbol,
        usdgRaw: legAmount,
        weightBps: leg.weightBps,
        legs: cfg.legs.length,
      });
    }
  }

  const idleAfterBuys = snap.cashUsdg - (intents.length ? cfg.buyPerTickUsdg : 0n);
  if (idleAfterBuys > cfg.idleFloorUsdg) {
    const excess = idleAfterBuys - cfg.idleFloorUsdg;
    // Size the sweep to what the wall will actually take. A deposit is capped at
    // the DAILY limit (policy.ts), and this tick's buys have already eaten into
    // today's budget — so proposing the whole excess on a small grant meant the
    // deposit was rejected every single tick, forever, while the cash never moved.
    // Sweep what fits now; the rest goes next tick. Nothing here loosens a cap:
    // the proposal only ever shrinks.
    const spentOnBuys = intents.reduce(
      (sum, i) => sum + (i.kind === "swap" ? i.notionalUsdg : 0n),
      0n,
    );
    const headroom = snap.spendHeadroomUsdg - spentOnBuys;
    const amountUsdg = excess < headroom ? excess : headroom;
    if (amountUsdg > 0n) {
      intents.push({ kind: "vault-deposit", target: cfg.vault, amountUsdg });
      // `clamped` when the daily budget cut the sweep short. Saying 'parked the
      // idle cash' while parking part of it would leave the sentence and the
      // balance disagreeing in front of the owner.
      why.push({
        code: "park",
        usdgRaw: amountUsdg,
        floorRaw: cfg.idleFloorUsdg,
        clamped: amountUsdg < excess,
      });
    }
  }

  // NOTHING BOUGHT, AND THE FEEDS ARE WHY.
  //
  // Only reported when the schedule genuinely wanted to buy — cash was
  // sufficient and there were legs — and every one of them was skipped. A tick
  // that bought nothing because it had no cash is a different silence with a
  // different remedy, and saying "the feeds are stale" about it would be
  // wrong. A sweep to the vault is not a buy, so this still fires beside one:
  // over a weekend that sweep is the only thing an agent does, and its owner is
  // still owed the sentence about why.
  const bought = intents.some((i) => i.kind === "swap");
  const idle: Why | undefined =
    !bought && snap.cashUsdg >= cfg.buyPerTickUsdg && skippedStale + skippedPaused === cfg.legs.length && cfg.legs.length > 0
      ? { code: "all-legs-stale", legs: cfg.legs.length, paused: skippedPaused }
      : undefined;

  return idle ? { intents, why, idle } : { intents, why };
}
