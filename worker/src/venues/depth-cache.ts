/**
 * Depth for the tick: cached, bounded, and never load-bearing.
 *
 * depth.ts knows how to map one pool. This is what the loop calls, and it adds
 * the three things a trading loop needs that a single read does not:
 *
 *  1. A CACHE, because liquidity moves far slower than price. A range is capital
 *     someone committed; it does not reprice every fifteen seconds the way a
 *     quote does. Reading it per tick would spend RPC re-deriving a number that
 *     had not changed.
 *
 *  2. A BUDGET. Depth is 3 multicalls per token. Fourteen tokens every tick is
 *     42 calls for context, next to a routed price read that already spends 28
 *     for a number the agent cannot trade without. So a bounded number of stale
 *     entries refresh per tick, oldest first, and everything else is served from
 *     cache. The whole set converges within a few ticks and stays there.
 *
 *  3. FAILURE THAT COSTS NOTHING. Depth is colour, not a price. If a read throws
 *     the entry is simply absent and the strategist proposes without it, exactly
 *     as it did before this existed. Nothing downstream may require it — which
 *     is also why it is optional on Snapshot rather than required.
 *
 * WHAT THIS IS NOT ALLOWED TO BECOME. Depth informs proposals. It must never
 * reach policy.ts, because a cap that moved with liquidity would be a cap an
 * attacker can manufacture by adding to a pool. depth.invariant.test.ts pins it.
 */

import type { PublicClient } from "viem";
import type { StockToken } from "../../../packages/core/src/index";
import { cashToNumber, cashWithinBps, readPoolDepth, type PoolDepth } from "./depth";
import { bestCashPool } from "./pool-price";

/**
 * How long a depth map stays fresh.
 *
 * Five minutes, against the price cache's sixty seconds, because the two answer
 * different questions. A price is what the next trade executes at; depth is the
 * shape of the book behind it, and that shape is capital people have parked. It
 * still churns — one pool showed 695 mints and 310 burns in a day — so this is
 * not "liquidity is static", it is "a five-minute-old shape is still the right
 * shape to size a $50 trade against".
 */
export const DEFAULT_DEPTH_TTL_SEC = 300;

/** Stale entries refreshed per tick. Bounds the RPC cost of context. */
export const DEFAULT_MAX_REFRESH_PER_TICK = 4;

/** The band the headline "trade without moving it" figure is measured over. */
export const DEPTH_IMPACT_BPS = 50;

export interface TokenDepth {
  symbol: string;
  /** USDG that can be spent before price rises more than DEPTH_IMPACT_BPS. */
  buyUsdg: number;
  /** USDG that can be realised before price falls that far. */
  sellUsdg: number;
  /** Nearest liquidity cluster below spot, as a price. Null when there is none. */
  supportUsd: number | null;
  /** Nearest cluster above spot. */
  resistanceUsd: number | null;
  /** The ladder hit the read cap — the figures are floors, not totals. */
  partial: boolean;
  /** When this was read, so a consumer can tell fresh from merely cached. */
  readAtSec: number;
}

/**
 * The nearest liquidity shelf either side of spot, as a price — reported at its
 * FAR edge, the point where that shelf is exhausted.
 *
 * The facing edge is the obvious choice and it is useless. The nearest cluster
 * nearly always abuts spot, so both sides come back as spot: live, NVDA reported
 * support 217.40 and resistance 217.40 against a spot of 217.22. Arithmetically
 * correct, and it tells a model nothing — worse, it reads as a bug. The far edge
 * answers the question actually being asked: how far can price run before the
 * liquidity holding it up, or capping it, runs out.
 *
 * Exported so that stays pinned. It is one line to "fix" it back.
 */
export function nearestLevel(depth: PoolDepth, side: "support" | "resistance"): number | null {
  const own = depth.zones.filter((z) => z.side === side).sort((a, b) => a.distanceBps - b.distanceBps);
  const z = own[0];
  if (!z) return null;
  return Number(side === "support" ? z.priceLow8 : z.priceHigh8) / 1e8;
}

export interface DepthReader {
  /**
   * Depth for the given symbols. Returns what is known NOW: cached entries
   * immediately, plus whatever a bounded refresh managed to add. Never throws.
   */
  read(symbols: readonly string[]): Promise<Map<string, TokenDepth>>;
  reset(): void;
}

interface Entry {
  depth: TokenDepth;
  atSec: number;
}

export function createDepthReader(args: {
  /**
   * READ THROUGH A CLOSURE, not captured once — for exactly the reason
   * `tokens` below is.
   *
   * This took a PublicClient by value, and index.ts passed `mainnetClient()`,
   * so the reader held whichever client existed when it was constructed.
   * setMainnetRpc REBINDS snapshot.ts's module-level client rather than
   * mutating it, so after a connection-settings change every other consumer
   * moved to the new endpoint and this one kept talking to the old one, for the
   * life of the process. Right next door, index.ts resets the pool-price cache
   * on that same change precisely because stale routes outlive the setting.
   *
   * A thunk fixes it WITHOUT giving up connection reuse: the client it returns
   * is snapshot's long-lived one, rebuilt only when the URL actually changes,
   * so this re-reads a reference rather than opening a socket.
   */
  client: () => PublicClient;
  /** The watch set — resolved the same way trades resolve a symbol. */
  tokens: () => readonly StockToken[];
  cash: `0x${string}`;
  cashDecimals: number;
  ttlSec?: number;
  maxRefreshPerTick?: number;
  now?: () => number;
  /**
   * Test seam. The valuable behaviour here is the CACHE POLICY — what refreshes,
   * how often, what happens when a read fails — and none of that should need a
   * chain to exercise. Production never passes this.
   */
  readOne?: (token: StockToken, atSec: number) => Promise<TokenDepth | null>;
}): DepthReader {
  const cache = new Map<string, Entry>();
  const now = args.now ?? Date.now;
  const ttl = args.ttlSec ?? DEFAULT_DEPTH_TTL_SEC;
  const budget = args.maxRefreshPerTick ?? DEFAULT_MAX_REFRESH_PER_TICK;

  const refresh = args.readOne ?? defaultRefresh;

  async function defaultRefresh(token: StockToken, atSec: number): Promise<TokenDepth | null> {
    const best = await bestCashPool(args.client(), {
      token: token.address as `0x${string}`,
      cash: args.cash,
    });
    if (!best) return null;

    const d = await readPoolDepth(args.client(), {
      pool: best.pool,
      token: token.address as `0x${string}`,
      // Stock tokens are 18dp and the registry omits the field for them. Passing
      // undefined through would make readPoolDepth throw — which it should, and
      // which is why this defaults rather than forwarding the hole.
      tokenDecimals: token.decimals ?? 18,
      cashDecimals: args.cashDecimals,
    });
    if (!d) return null;

    return {
      symbol: token.symbol,
      buyUsdg: cashToNumber(cashWithinBps(d, DEPTH_IMPACT_BPS, "ask"), args.cashDecimals),
      sellUsdg: cashToNumber(cashWithinBps(d, DEPTH_IMPACT_BPS, "bid"), args.cashDecimals),
      supportUsd: nearestLevel(d, "support"),
      resistanceUsd: nearestLevel(d, "resistance"),
      partial: d.truncated,
      readAtSec: atSec,
    };
  }

  return {
    async read(symbols) {
      const atSec = Math.floor(now() / 1000);
      const wanted = new Set(symbols);
      const known = args.tokens().filter((t) => wanted.has(t.symbol));

      // Oldest first, unread before read — so a cold start converges over a few
      // ticks instead of starving whichever symbol happens to sort last.
      const stale = known
        .filter((t) => {
          const e = cache.get(t.symbol);
          return !e || atSec - e.atSec >= ttl;
        })
        .sort((a, b) => (cache.get(a.symbol)?.atSec ?? 0) - (cache.get(b.symbol)?.atSec ?? 0))
        .slice(0, budget);

      for (const token of stale) {
        try {
          const depth = await refresh(token, atSec);
          if (depth) cache.set(token.symbol, { depth, atSec });
          // A null result means "no pool worth mapping". Leave any previous entry
          // in place rather than deleting: a transient RPC hiccup and a genuinely
          // drained pool look identical from here, and dropping context is the
          // more disruptive of the two guesses.
        } catch {
          /* colour, not a price — a failed read is simply not this tick's news */
        }
      }

      const out = new Map<string, TokenDepth>();
      for (const symbol of wanted) {
        const e = cache.get(symbol);
        if (e) out.set(symbol, e.depth);
      }
      return out;
    },
    reset() {
      cache.clear();
    },
  };
}
