/**
 * PRICING GAS THAT LANDED WITHOUT A PRICE.
 *
 * `trades.gas_usdg` is written once, at execution time, from the ETH/USD feed as
 * it read in that moment. When that read fails the row keeps its `gas_wei` and
 * gets a NULL `gas_usdg`, and every P&L computed over it is GROSS of that trade's
 * gas while claiming nothing about it either way.
 *
 * ON A SMALL BOOK THAT IS MOST OF THE NUMBER. The canary burned 0.002595505 ETH
 * across four fills — about 6.52 USDG — on a book that only ever deployed 6.666
 * USDG of capital. The same four trades read −0.127 gross and −6.649 net. A model
 * comparing gross history against net future returns is not comparing returns.
 *
 * WHY A BACKFILL IS POSSIBLE AT ALL, which was not obvious. The chain's public
 * RPC is NOT an archive node: `eth_call` at a historical block fails with
 * "metadata is not found", so the feed cannot be re-read as of the trade. But a
 * Chainlink aggregator keeps its past rounds readable from CURRENT state via
 * `getRoundData(uint80)` — so the round that was IN FORCE when the trade landed
 * is recoverable without an archive node at all. Measured on the canary: all four
 * fills priced from a round at most 41 minutes old.
 *
 * THAT LAG IS THE HONEST CAVEAT. A Chainlink round updates on a deviation
 * threshold or a heartbeat, so "the price in force" is the last published round,
 * not the price at the instant of the trade. It is the same figure the executor
 * would have used had its own read succeeded — which is the point: this
 * reconstructs what the row SHOULD have held, not a better number than the live
 * path would have produced.
 */

/** One published round of a Chainlink aggregator, reduced to what pricing needs. */
export interface FeedRound {
  roundId: bigint;
  /** The answer, already scaled out of the feed's decimals. */
  priceUsd: number;
  /** Unix seconds the round was published. Zero means the round is unset. */
  updatedAt: number;
}

/**
 * How stale a round may be and still be accepted as "the price in force".
 *
 * Six hours. A feed that has not published in longer than that was not tracking
 * the market when the trade ran, and pricing against it would invent precision
 * the data does not have. The refusal leaves the row unpriced, which is the
 * state it is already in — a backfill that cannot do better must not pretend to.
 */
export const MAX_ROUND_LAG_SEC = 6 * 3600;

export type GasPricing =
  | {
      kind: "priced";
      usdg: number;
      priceUsd: number;
      roundId: bigint;
      /** How long before the trade the round was published. Reported, not hidden. */
      lagSec: number;
    }
  | { kind: "no-round"; why: string }
  | { kind: "too-stale"; why: string; lagSec: number };

/**
 * Price one trade's gas from the round in force when it landed. PURE.
 *
 * Takes the already-found round so the search (which needs a chain) stays out of
 * the decision (which does not). Everything a reviewer might dispute — the
 * staleness bound, the direction of the lag, the arithmetic — is here and
 * testable without a network.
 */
export function priceGasAtRound(args: {
  gasWei: bigint;
  tradeAtSec: number;
  round: FeedRound | null;
}): GasPricing {
  if (args.round === null || args.round.updatedAt === 0) {
    return { kind: "no-round", why: "no published round at or before the trade" };
  }
  const lagSec = args.tradeAtSec - args.round.updatedAt;
  // A round published AFTER the trade is not the price that was in force. The
  // search should never return one, and accepting it here would let a search bug
  // become a wrong number instead of a caught one.
  if (lagSec < 0) {
    return { kind: "no-round", why: `round ${args.round.roundId} was published after the trade` };
  }
  if (lagSec > MAX_ROUND_LAG_SEC) {
    return {
      kind: "too-stale",
      lagSec,
      why:
        `the newest round at the time was ${Math.round(lagSec / 3600)}h old — the feed was not tracking ` +
        `the market, so this stays unpriced rather than priced badly`,
    };
  }
  if (!Number.isFinite(args.round.priceUsd) || args.round.priceUsd <= 0) {
    return { kind: "no-round", why: `round ${args.round.roundId} carries no usable price` };
  }
  return {
    kind: "priced",
    usdg: (Number(args.gasWei) / 1e18) * args.round.priceUsd,
    priceUsd: args.round.priceUsd,
    roundId: args.round.roundId,
    lagSec,
  };
}

/**
 * The newest round published at or before `atSec`, by binary search over round
 * ids.
 *
 * `read` is injected so this is testable without a chain, and so the caller owns
 * the RPC budget. Round ids on a Chainlink proxy are `(phase << 64) | aggregator
 * round`, so they are monotonic within a phase but NOT dense across one — an
 * unset round reads `updatedAt == 0`, and the search treats that as "too early"
 * and moves right, which is what keeps a phase boundary from ending the walk.
 */
export async function findRoundAt(
  atSec: number,
  latest: FeedRound,
  read: (roundId: bigint) => Promise<FeedRound | null>,
  window = 20_000n,
): Promise<FeedRound | null> {
  if (latest.updatedAt !== 0 && latest.updatedAt <= atSec) return latest;

  // SEARCH THE AGGREGATOR ROUND, NOT THE PROXY ID.
  //
  // A Chainlink proxy id is `(phase << 64) | aggregatorRound`, so the ids are
  // enormous (the live feed's latest is 18446744073709553622) while the part
  // that actually counts is small and DENSE — that same id is phase 1, round
  // 2006. Bisecting the raw proxy id searches a mostly-empty 2^64 space, and the
  // hole-stepping below then does most of the work: measured 822 RPC calls to
  // price four trades, which on a rate-limited public node is its own outage.
  //
  // Decomposing first puts the search back in the space where rounds are
  // consecutive. Same four trades, eleven reads.
  const AGG_MASK = (1n << 64n) - 1n;
  const phase = latest.roundId >> 64n;
  const latestAgg = latest.roundId & AGG_MASK;
  const inPhase = (agg: bigint) => (phase << 64n) | agg;

  let lo = latestAgg > window ? inPhase(latestAgg - window) : inPhase(1n);
  let hi = latest.roundId;
  let best: FeedRound | null = null;

  /**
   * The nearest PUBLISHED round at or below `from`, without going under `floor`.
   *
   * The round space is sparse, and a plain binary search cannot cope with that:
   * landing on an unset id tells you nothing about which way the answer lies, so
   * treating it as "too early" and moving right walks straight past the answer.
   * (It did — the first version returned no round for any moment that happened
   * to bisect onto a gap.) Stepping down to the nearest real round turns the hole
   * into a data point, and the bound keeps a pathological gap from making the
   * whole search linear.
   */
  const nearestBelow = async (from: bigint, floor: bigint): Promise<FeedRound | null> => {
    for (let j = from, steps = 0; j >= floor && steps < 64; steps++) {
      let r: FeedRound | null = null;
      try {
        r = await read(j);
      } catch {
        // A 429 is not evidence that a round is unset. Keep walking rather than
        // concluding "no round", which would silently under-report gas.
        r = null;
      }
      if (r !== null && r.updatedAt !== 0) return r;
      if (j === 0n) break;
      j -= 1n;
    }
    return null;
  };

  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const r = await nearestBelow(mid, lo);
    if (r === null) {
      // Nothing published anywhere in [lo, mid] — the answer, if any, is above.
      lo = mid + 1n;
      continue;
    }
    if (r.updatedAt <= atSec) {
      best = r;
      lo = r.roundId + 1n;
    } else {
      if (r.roundId === 0n) break;
      hi = r.roundId - 1n;
    }
  }
  return best;
}
