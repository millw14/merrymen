/**
 * THE CHAINLINK ETH/USD FEED, FOR WHAT GAS COST.
 *
 * gas-price.ts says "there is no Chainlink ETH/USD feed on this chain". There is
 * (CASH_FEEDS.ETH_USD, read by the web's trade quote), and the worker never used
 * it. Gas was priced only off the WETH/USDG pool's TWAP, so every tick that pool
 * was refused left a landed trade's gas unpriced — and an operation settled
 * later (the stranded-op resolver, the orphan sweep) was never priced at all,
 * because the pool can only say what ETH is worth NOW.
 *
 * The feed answers both:
 *
 *  - NOW, as the fallback when the pool is refused (`ethPrice8FromFeed`).
 *  - THEN, for a cost settled after the fact: an aggregator keeps its past
 *    rounds readable from current state, so the round in force at the
 *    operation's block is recoverable without an archive node
 *    (gas-backfill.ts findRoundAt). `priceGasAt` prices a recovered cost the
 *    way the live path would have, at the moment it was burned — so it is
 *    written with its row, into the same journal entry, and no row has to be
 *    revised later.
 *
 * A round older than MAX_ROUND_LAG_SEC is not "the price in force"; the cost
 * stays unpriced rather than priced badly, exactly as gas-backfill.ts rules.
 */
import type { PublicClient } from "viem";
import { CASH_FEEDS, CHAINLINK_ABI } from "../../packages/core/src/index";
import { findRoundAt, MAX_ROUND_LAG_SEC, priceGasAtRound, type FeedRound } from "./gas-backfill";

export interface EthFeed {
  /** The newest round, with its raw answer at 8dp. Null when the feed did not answer. */
  latest(): Promise<(FeedRound & { price8: bigint }) | null>;
  /** One past round. Null when it could not be read; `updatedAt` 0 when it is unset. */
  round(roundId: bigint): Promise<FeedRound | null>;
}

/** The answer at the feed's decimals → 8dp, exactly. */
function toPrice8(answer: bigint, decimals: number): bigint {
  return decimals >= 8 ? answer / 10n ** BigInt(decimals - 8) : answer * 10n ** BigInt(8 - decimals);
}

/** The feed, read through `client`. Decimals are read once and remembered. */
export function ethUsdFeed(client: Pick<PublicClient, "readContract">): EthFeed {
  const address = CASH_FEEDS.ETH_USD as `0x${string}`;
  let decimals: number | null = null;
  const scale = async (): Promise<number> => {
    if (decimals === null) decimals = Number(await client.readContract({ address, abi: CHAINLINK_ABI, functionName: "decimals" }));
    return decimals;
  };
  const shape = (r: readonly [bigint, bigint, bigint, bigint, bigint], d: number) => ({
    roundId: r[0],
    priceUsd: Number(r[1]) / 10 ** d,
    updatedAt: Number(r[3]),
  });
  return {
    async latest() {
      try {
        const [d, r] = await Promise.all([
          scale(),
          client.readContract({ address, abi: CHAINLINK_ABI, functionName: "latestRoundData" }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
        ]);
        return { ...shape(r, d), price8: toPrice8(r[1], d) };
      } catch {
        return null;
      }
    },
    async round(roundId) {
      try {
        const [d, r] = await Promise.all([
          scale(),
          client.readContract({ address, abi: CHAINLINK_ABI, functionName: "getRoundData", args: [roundId] }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
        ]);
        return shape(r, d);
      } catch {
        return null;
      }
    },
  };
}

/** ETH at 8dp from the newest round, or why not. A round past MAX_ROUND_LAG_SEC is refused. */
export async function ethPrice8FromFeed(feed: EthFeed, nowSec: number): Promise<{ price8: bigint | null; reason?: string }> {
  const r = await feed.latest();
  if (!r || r.updatedAt === 0) return { price8: null, reason: "the Chainlink ETH/USD feed did not answer" };
  if (r.price8 <= 0n) return { price8: null, reason: "the Chainlink ETH/USD feed answered no price" };
  if (nowSec - r.updatedAt > MAX_ROUND_LAG_SEC) {
    return { price8: null, reason: `the Chainlink ETH/USD feed last published ${Math.round((nowSec - r.updatedAt) / 3600)}h ago` };
  }
  return { price8: r.price8 };
}

/**
 * What `gasWei` cost in USDG at `atSec`, from the round then in force. Null when
 * there is no honest answer: no round, a stale one, or a read that failed.
 */
export async function priceGasAt(feed: EthFeed, gasWei: bigint, atSec: number): Promise<number | null> {
  if (gasWei <= 0n) return 0;
  try {
    const latest = await feed.latest();
    if (!latest) return null;
    const round = await findRoundAt(atSec, latest, (id) => feed.round(id));
    const priced = priceGasAtRound({ gasWei, tradeAtSec: atSec, round });
    return priced.kind === "priced" ? priced.usdg : null;
  } catch {
    return null;
  }
}
