/**
 * Strategy contract: a strategy is a pure function from a market/account
 * snapshot to a list of typed intents. It NEVER executes anything, never
 * holds state the snapshot can't reconstruct, and never talks to a model —
 * the runner pushes every intent through checkPolicy → simulate → execute.
 */

import type { TradeIntent } from "../policy";

/** One current holding, as the strategy sees it. */
export interface Holding {
  token: `0x${string}`;
  /** Raw ERC-20 balance (18dp for stock tokens). */
  rawBalance: bigint;
  /** Multiplier-aware USDG value (6dp). */
  valueUsdg: bigint;
  /** The holding's Chainlink feed is stale (market closed) right now. */
  priceStale: boolean;
}

export interface Snapshot {
  cashUsdg: bigint;
  vaultUsdg: bigint;
  /** Current stock holdings by symbol. */
  holdings: Map<string, Holding>;
  /** Per-token pause state read from the Stock contract — never trade a paused token. */
  pausedTokens: Set<string>;
  /** Chainlink staleness per symbol; stale = underlying market closed (nights/weekends). */
  staleFeeds: Set<string>;
  sequencerUp: boolean;
}

export interface Strategy {
  name: string;
  tick(snap: Snapshot): TradeIntent[];
}
