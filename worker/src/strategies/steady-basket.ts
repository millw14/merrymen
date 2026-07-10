/**
 * Steady Basket — Phase 1's deterministic strategy. No LLM anywhere.
 * DCA a fixed USDG amount into a weighted stock-token basket on a schedule,
 * park idle USDG in the Morpho Steakhouse vault between buys.
 *
 * A Strategy NEVER executes anything. It reads a snapshot and returns intents;
 * the runner pushes each intent through checkPolicy → simulate → execute.
 */

import type { TradeIntent } from "../policy";

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

export interface Snapshot {
  cashUsdg: bigint;
  vaultUsdg: bigint;
  /** Per-token pause state read from the Stock contract — never trade a paused token. */
  pausedTokens: Set<string>;
  /** Chainlink staleness per symbol; weekends are expected-stale for stocks. */
  staleFeeds: Set<string>;
  sequencerUp: boolean;
}

export function steadyBasketTick(cfg: SteadyBasketConfig, snap: Snapshot): TradeIntent[] {
  if (!snap.sequencerUp) return [];

  // Cash can't cover a buy but the vault can: pull enough back to fund the next
  // tick's buy plus the liquidity floor. Withdraw-only tick — buys resume next
  // tick once the cash has actually landed.
  if (snap.cashUsdg < cfg.buyPerTickUsdg && snap.vaultUsdg > 0n) {
    const need = cfg.buyPerTickUsdg + cfg.idleFloorUsdg - snap.cashUsdg;
    const amountUsdg = need > snap.vaultUsdg ? snap.vaultUsdg : need;
    return [{ kind: "vault-withdraw", target: cfg.vault, amountUsdg }];
  }

  const intents: TradeIntent[] = [];

  if (snap.cashUsdg >= cfg.buyPerTickUsdg) {
    for (const leg of cfg.legs) {
      if (snap.pausedTokens.has(leg.token.toLowerCase())) continue;
      if (snap.staleFeeds.has(leg.symbol)) continue; // no reference price → no trade
      const legAmount = (cfg.buyPerTickUsdg * BigInt(leg.weightBps)) / 10_000n;
      if (legAmount === 0n) continue;
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: cfg.usdg,
        buyToken: leg.token,
        sellAmountUsdg: legAmount,
      });
    }
  }

  const idleAfterBuys = snap.cashUsdg - (intents.length ? cfg.buyPerTickUsdg : 0n);
  if (idleAfterBuys > cfg.idleFloorUsdg) {
    intents.push({
      kind: "vault-deposit",
      target: cfg.vault,
      amountUsdg: idleAfterBuys - cfg.idleFloorUsdg,
    });
  }

  return intents;
}
