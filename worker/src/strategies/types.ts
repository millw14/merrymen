/**
 * Strategy contract: a strategy is a pure function from a market/account
 * snapshot to a list of typed intents. It NEVER executes anything, never
 * holds state the snapshot can't reconstruct, and never talks to a model —
 * the runner pushes every intent through checkPolicy → simulate → execute.
 */

import type { PriceQuote } from "../../../packages/core/src/index";
import type { TradeIntent } from "../policy";
import type { TokenDepth } from "../venues/depth-cache";
import type { Why } from "./reasons";

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
  /**
   * Native ETH held by the account, in wei — the fuel, not the capital.
   *
   * The account self-pays gas with no paymaster, so at zero every operation
   * fails before it reaches the chain. The worker refuses such an intent
   * outright, but a strategy that knows its own gas position can simply not
   * propose, which is cheaper and quieter than proposing and being refused.
   *
   * Absent or NULL means "not read this tick" — different from zero, and a
   * strategy must not treat the two alike. Optional for the same reason `depth`
   * is: a backtest or a fixture has no chain to read it from, and a field that
   * forces every caller to invent a value teaches them to invent zero.
   */
  ethWei?: bigint | null;
  /** Current stock holdings by symbol. */
  holdings: Map<string, Holding>;
  /**
   * Latest USD prices (8dp) by symbol — stale prices flagged, not hidden.
   * `source` says whether a price is a Chainlink feed or a Uniswap TWAP; a
   * strategy that wants to treat those differently can, and one that doesn't
   * gets a price that already passed the depth and divergence guards.
   */
  prices: Map<string, PriceQuote>;
  /** Per-token pause state read from the Stock contract — never trade a paused token. */
  pausedTokens: Set<string>;
  /** Chainlink staleness per symbol; stale = underlying market closed (nights/weekends). */
  staleFeeds: Set<string>;
  sequencerUp: boolean;
  /**
   * USDG (6dp) still spendable today: the grant's daily cap minus what's already
   * gone. Zero means the budget is used up.
   *
   * Strategies should SIZE to this instead of proposing what they wish for. The
   * wall still rejects anything over — this just stops a strategy re-proposing an
   * oversized intent every tick forever, which fills the ledger with rejections
   * and stalls the position. It is a hint for sizing, never a permission: the
   * proposer shrinks itself; checkPolicy and the on-chain caps remain the wall.
   */
  spendHeadroomUsdg: bigint;
  /** The grant's per-trade cap (6dp) — the ceiling for a single swap. Deposits are
   * capped at the DAILY limit instead (see policy.ts), hence the separate figure. */
  perTradeCapUsdg: bigint;
  /**
   * Pool liquidity by symbol — how much can be traded before the price moves,
   * and where liquidity clusters. See venues/depth.ts; there is no order book on
   * this chain and this is not one.
   *
   * OPTIONAL, and deliberately so. It is context that makes a proposal better
   * sized, never a permission and never a prerequisite: the backtest replays fed
   * bars with no chain to read, a cold cache has nothing yet, and a failed read
   * is simply absent. Anything that would break without it is reaching for the
   * wrong input — the wall is what decides, and the wall never sees this.
   */
  depth?: ReadonlyMap<string, TokenDepth>;
}

/**
 * What a strategy proposed, and why — the reasons paired positionally with the
 * intents that carry them.
 *
 * PARALLEL ARRAYS rather than a reason on the intent itself, because
 * `policy.ts` states that free text lives only in the decisions table and never
 * on a TradeIntent: nothing the wall inspects may take a string that originated
 * outside it. The strategist already pairs its proposals with its reasoning this
 * exact way, so this is the existing shape, not a new one.
 *
 * `why[i]` may be null — a strategy can propose something it has nothing to say
 * about, and null is the honest value for that.
 */
export interface Tick {
  intents: TradeIntent[];
  why: (Why | null)[];
  /**
   * WHY THIS TICK PROPOSED NOTHING — unpaired, because there is no intent to
   * pair it with.
   *
   * `why` is positionally paired with `intents`, so a tick that produces no
   * intents can carry no reason at all, and an empty tick is exactly what a
   * healthy quiet tick looks like too. That silence cost a weekend: every
   * basket agent skipped every leg on a stale feed and reported nothing, and
   * the owners read it as a broken product.
   *
   * Only the strategy knows WHY it proposed nothing; the caller can see the
   * empty array and nothing else. Optional, so every existing strategy and
   * fixture is unchanged.
   */
  idle?: Why;
}

export interface Strategy {
  name: string;
  /**
   * Async allowed: the LLM strategist awaits a model at decision windows.
   *
   * A bare array is still valid and means 'no reasons' — which is what a
   * tenant's own strategy file returns, and why one can never publish prose.
   */
  tick(snap: Snapshot): TradeIntent[] | Tick | Promise<TradeIntent[] | Tick>;
}

/** Normalise either return shape. The one place that knows about both. */
export function takeTick(r: TradeIntent[] | Tick): Tick {
  return Array.isArray(r) ? { intents: r, why: r.map(() => null) } : r;
}
