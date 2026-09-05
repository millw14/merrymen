/**
 * WHAT THE ORACLE PUBLISHED, over the last couple of months.
 *
 * The only price history this product can honestly draw. A Chainlink feed keeps
 * every round it has ever written and each one carries its own timestamp, so
 * the series is real observations rather than anything reconstructed — and it
 * costs ONE request: 400 rounds go into a single Multicall3 batch, measured at
 * 710ms against this chain with 400 of 400 answering.
 *
 * THIS IS NOT A MARKET. It is what the oracle said, and the page must say so.
 * The feed runs 24/5 while the token trades 24/7, so between Friday's close and
 * Monday's open the feed is silent and the token is not.
 *
 * STOCK AND ETF TOKENS ONLY. A coin has no feed; its history would have to come
 * from the index, which is a different source with different failure modes and
 * a per-token request this file deliberately avoids making.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { CHAINLINK_ABI, robinhoodChain } from "../../packages/core/src/index";

/**
 * The reader for callers with no client of their own — the web tier.
 *
 * The WORKER passes its own. It holds the house RPC url and a metered
 * transport, and a second unmetered client issuing 400-round multicalls behind
 * the meter is exactly the traffic this chain rate-limits.
 */
const fallbackClient = createPublicClient({ chain: robinhoodChain, transport: http() });

/** Only the two methods this module uses, so any client shape satisfies it. */
type FeedClient = Pick<PublicClient, "readContract" | "multicall">;

export interface FeedPoint {
  /** Unix seconds the round was written. */
  at: number;
  /** The answer, in dollars. */
  px: number;
}

export interface FeedHistory {
  points: FeedPoint[];
  /**
   * Whether the chain answered at all.
   *
   * Separate from an empty series, as everywhere else here: "this feed has no
   * history" and "we could not ask" are different facts and the page renders
   * them differently.
   */
  read: boolean;
}

/** Rounds to walk back. 400 covered 61 days of AAPL when this was measured. */
const ROUNDS = 400;

/**
 * A gap longer than this breaks the line rather than being drawn across.
 *
 * Measured on the AAPL feed: median gap 44 minutes, MAXIMUM GAP 79.7 HOURS.
 * That long one is a weekend, and a segment drawn straight across it states a
 * price for every hour of a market that was closed — a line through prices that
 * never existed, which is the one thing a price chart must not do.
 */
const BREAK_SEC = 6 * 3600;

/** Beyond this multiple of the median, an answer came from another aggregator. */
const WILD = 100;

/** Rounds are identical for every viewer, so one read serves all of them. */
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: FeedHistory }>();

export async function readFeedHistory(
  feed: `0x${string}` | null,
  client: FeedClient = fallbackClient,
): Promise<FeedHistory> {
  if (!feed) return { points: [], read: true }; // no feed is a fact, not a failure

  const key = feed.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  try {
    const [latest, decimals] = await Promise.all([
      client.readContract({ address: feed, abi: CHAINLINK_ABI, functionName: "latestRoundData" }),
      client.readContract({ address: feed, abi: CHAINLINK_ABI, functionName: "decimals" }),
    ]);

    // Phase-encoded: keep the high 64 bits and walk the low half down. Crossing
    // into the previous phase reaches a different aggregator entirely.
    const roundId = latest[0];
    const phase = roundId >> 64n;
    const round = roundId & ((1n << 64n) - 1n);

    const ids: bigint[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const r = round - BigInt(i);
      if (r <= 0n) break;
      ids.push((phase << 64n) | r);
    }
    if (!ids.length) return remember(key, { points: [], read: true });

    const res = await client.multicall({
      contracts: ids.map((id) => ({
        address: feed,
        abi: CHAINLINK_ABI,
        functionName: "getRoundData" as const,
        args: [id] as const,
      })),
      // One HTTP request. The whole point: this chain refuses bursts, and a
      // walk issued as 400 separate calls is exactly the burst it refuses.
      batchSize: 20_000,
      allowFailure: true,
    });

    const scale = 10 ** Number(decimals);
    const raw: FeedPoint[] = [];
    for (const r of res) {
      if (r.status !== "success") continue;
      const [, answer, , updatedAt] = r.result as readonly [bigint, bigint, bigint, bigint, bigint];
      const at = Number(updatedAt);
      // An unwritten round reports updatedAt 0, which would land in 1970 and
      // stretch the axis across half a century.
      if (at <= 0) continue;
      raw.push({ at, px: Number(answer) / scale });
    }
    if (!raw.length) return remember(key, { points: [], read: true });

    // The magnitude guard. A round from before a phase boundary decodes at a
    // different scale — one such answer is 1e18 times the price and would flatten
    // every real point onto the axis.
    const sorted = [...raw].map((p) => p.px).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const points = raw
      .filter((p) => p.px > 0 && p.px <= median * WILD && p.px >= median / WILD)
      .sort((a, b) => a.at - b.at);

    return remember(key, { points, read: true });
  } catch {
    // A refused read is not an empty history.
    return { points: [], read: false };
  }
}

function remember(key: string, value: FeedHistory): FeedHistory {
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Split a series wherever the feed went quiet for longer than a session break.
 *
 * Returned as separate runs so the chart draws separate polylines. The caller
 * cannot get this wrong by accident, which is the reason it is not left to it.
 */
export function segments(points: FeedPoint[]): FeedPoint[][] {
  const out: FeedPoint[][] = [];
  let run: FeedPoint[] = [];
  for (const p of points) {
    const prev = run[run.length - 1];
    if (prev && p.at - prev.at > BREAK_SEC) {
      out.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length) out.push(run);
  return out;
}

/** Exposed for the tests that pin the two guards. */
export const FEED_GUARDS = { BREAK_SEC, WILD, ROUNDS } as const;
