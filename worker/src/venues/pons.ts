/**
 * Pons launches — seeing the memecoins that never touch a Uniswap pool.
 *
 * WHY THIS EXISTS. Discovery finds tokens by watching Uniswap Initialize
 * events (via Bitquery, the only source that decodes hooked v4 pools). That
 * finds nothing here: a Pons token launches onto its OWN bonding-curve contract
 * and has no pool at all until it graduates at 4.2 ETH raised. So the launchpad
 * where essentially every new token on this chain appears was, to merrymen,
 * completely invisible — not "hard to price", not "filtered out", simply never
 * seen. This reads the launchpad directly instead.
 *
 * WHAT IS VERIFIED, AND HOW. Pons publishes no ABI, so every constant here was
 * established against mainnet 4663 rather than read from documentation:
 *   - the factory has 24,177 bytes of code at the address below;
 *   - it emits this topic0 on launch — ~50 per 3,000 blocks, and 523 distinct
 *     tokens over 40,000 blocks, so the launchpad is genuinely busy;
 *   - the field order was fixed by probing a real launch (PIZZA): topic1
 *     answers symbol() as an ERC-20, topic2 answers token() pointing back at
 *     topic1 AND getReserves() — so it is the curve — and topic3 answers
 *     neither, so it is the creator.
 *
 * A CORRECTION WORTH KEEPING. This module first shipped watching topic0
 * 0x308c390e…, which looked right because its three indexed addresses probed as
 * (token, creator, curve). It is a DIFFERENT, secondary event: it fires ~12x
 * less often and about 205 blocks (~20s) AFTER the launch. Watching it silently
 * under-reported the launchpad by an order of magnitude. Two events on one
 * contract can both look like "the launch" when probed in isolation; the thing
 * that separated them was comparing when each fired for the same token.
 */
import type { PublicClient } from "viem";

/** PonsV2LaunchFactory on Robinhood Chain mainnet. Verified: 24,177 bytes. */
export const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;

/**
 * topic0 of the launch event, taken from the chain rather than a signature
 * guess — with no published ABI the hash IS the specification.
 *
 * Shape, established by probing: (token indexed, curve indexed, creator
 * indexed) plus THREE data words — the quote token, a word that is always
 * zero across all 11,395 launches sampled in 24h, and the curve's graduation
 * threshold in raw quote units.
 */
export const PONS_LAUNCH_TOPIC =
  "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607" as const;

/**
 * How far back a single scan may look.
 *
 * NOT arbitrary, and not really about block range. This RPC accepts 864,000-block
 * ranges happily, but caps any response at 10,000 logs — and at the measured
 * 474.8 launches/hour that cap arrives at roughly 21 hours of launchpad activity.
 * Past it the node returns an error, which the reader below turns into "nothing
 * launched" unless the caller is told. 300,000 blocks is ~8.4 hours at the
 * measured 0.101 s/block, comfortably inside the cap with room for the rate to
 * roughly double before it starts truncating.
 */
export const MAX_LOOKBACK_BLOCKS = 300_000n;

/** Result of one scan, distinguishing "nothing launched" from "could not tell". */
export interface LaunchScan {
  launches: PonsLaunch[];
  /**
   * The requested lookback exceeded MAX_LOOKBACK_BLOCKS and was shortened.
   * Launches older than the clamp were NOT seen — after a long outage this is
   * the difference between catching up and silently skipping a day.
   */
  clamped: boolean;
  /**
   * The node refused the query. `launches` is then EMPTY BUT MEANINGLESS: it
   * says nothing about whether anything launched. Callers must not treat this
   * the same as a quiet launchpad — that conflation is how a feed dies without
   * anyone noticing.
   */
  failed: boolean;
}

/** A token that launched on a Pons bonding curve. */
export interface PonsLaunch {
  /** The ERC-20 itself, lowercased. */
  token: `0x${string}`;
  /** Its bonding curve — where it trades until graduation. Lowercased. */
  curve: `0x${string}`;
  /** Whoever launched it, lowercased. Recorded, never treated as a trust signal. */
  creator: `0x${string}`;
  /**
   * What the curve is priced in, lowercased. `0x0` means NATIVE ETH.
   *
   * Load-bearing rather than trivia: quote assets vary per launch — native ETH,
   * USDG and cbBTC have all been observed — and the quote asset decides both how
   * the token is priced and whether the agent can reach it at all. A curve
   * quoted in something the wall does not cover is not tradeable, however good
   * the token looks.
   */
  quoteToken: `0x${string}`;
  /**
   * The quote raised at which this curve graduates to a Uniswap pool, raw units.
   *
   * The single most useful field on the event, and the first version of this
   * module threw it away. Pons opens every curve with a VIRTUAL reserve of 40%
   * of this number, so without it a curve's reported reserve cannot be turned
   * into how much money is actually in there — see venues/pons-price.ts.
   *
   * It also makes curves COMPARABLE without a price feed. Only 53.6% are quoted
   * in ETH; 42.8% are quoted in Robinhood stock tokens and the rest in cbBTC or
   * USDG, and the thresholds are not a constant USD value either ($7,737 to
   * $10,377 at today's prices, configured at different times and never
   * repriced). Progress along a curve's own threshold needs no feed at all.
   *
   * Cross-checked: this equals `graduationThreshold()` (0x8b0bc501) on the curve
   * for 18/18 distinct quote assets.
   */
  graduationThresholdRaw: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

/** An indexed address topic carries the address in its low 20 bytes. */
function addressFromTopic(topic: string): `0x${string}` {
  return `0x${topic.slice(-40)}`.toLowerCase() as `0x${string}`;
}

/**
 * Launches in a block range, oldest first.
 *
 * Malformed logs are SKIPPED rather than defaulted. A launch missing one of its
 * addresses is not a vaguer version of the same launch — it is something this
 * code does not understand, and inventing a zero address for it would put a
 * token nobody launched, on a curve nobody can trade, in front of the owner.
 * Note that a zero QUOTE token is the one legitimate zero here (native ETH), so
 * that field is read from data rather than being subject to the same check.
 */
export function parseLaunchLogs(
  logs: readonly {
    topics: readonly string[];
    data: string;
    blockNumber: bigint | null;
    transactionHash: string | null;
  }[],
): PonsLaunch[] {
  const out: PonsLaunch[] = [];
  for (const log of logs) {
    if (log.topics.length < 4) continue;
    if (log.topics[0]?.toLowerCase() !== PONS_LAUNCH_TOPIC) continue;
    if (log.blockNumber === null || log.transactionHash === null) continue;
    // THREE data words are required, not one. Every real log has three, and the
    // third is the graduation threshold. Accepting a shorter log would yield a
    // zero threshold, and a zero threshold silently makes every depth and
    // progress ratio computed downstream either a division by zero or an
    // infinite one — the same class of bug as defaulting an address.
    if (typeof log.data !== "string" || log.data.length < 2 + 64 * 3) continue;
    const threshold = BigInt(`0x${log.data.slice(2 + 64 * 2, 2 + 64 * 3)}`);
    // A curve that graduates at nothing is not a curve we understand.
    if (threshold <= 0n) continue;
    out.push({
      token: addressFromTopic(log.topics[1]!),
      curve: addressFromTopic(log.topics[2]!),
      creator: addressFromTopic(log.topics[3]!),
      quoteToken: `0x${log.data.slice(2 + 24, 2 + 64)}`.toLowerCase() as `0x${string}`,
      graduationThresholdRaw: threshold,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash as `0x${string}`,
    });
  }
  return out;
}

/**
 * Read recent launches straight from the factory.
 *
 * `lookbackBlocks` is bounded by the caller because this chain produces a block
 * roughly every 0.1s — a naive "last 24 hours" is nearly a million blocks and
 * every public RPC will refuse it. Returns [] rather than throwing: discovery
 * is a reporting path, and a launchpad that cannot be read must not be able to
 * take the trading loop down with it.
 */
export async function recentPonsLaunches(
  client: PublicClient,
  lookbackBlocks: bigint,
): Promise<LaunchScan> {
  const clamped = lookbackBlocks > MAX_LOOKBACK_BLOCKS;
  const span = clamped ? MAX_LOOKBACK_BLOCKS : lookbackBlocks;
  try {
    const head = await client.getBlockNumber();
    const from = head > span ? head - span : 0n;
    // Raw eth_getLogs rather than viem's typed getLogs: that one wants an ABI
    // event to filter by, and Pons publishes no ABI — the topic hash is the
    // only specification that exists. Same approach as inflight-reconcile.ts.
    // Topic-filtered at the node so the factory's other events never travel.
    const raw = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: PONS_V2_FACTORY,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${head.toString(16)}`,
          topics: [PONS_LAUNCH_TOPIC],
        },
      ],
    } as never)) as { topics: string[]; data: string; blockNumber: string; transactionHash: string }[];
    const launches = parseLaunchLogs(
      raw.map((l) => ({
        topics: l.topics,
        data: l.data,
        blockNumber: BigInt(l.blockNumber),
        transactionHash: l.transactionHash,
      })),
    );
    return { launches, clamped, failed: false };
  } catch {
    // `failed`, not an empty success. The node refuses this query when it would
    // match more than 10,000 logs, and returning a bare [] made that
    // indistinguishable from a quiet launchpad — a feed that reports "nothing
    // launched" forever while the launchpad runs at 475/hour.
    return { launches: [], clamped, failed: true };
  }
}

/** Who launched one token, as the factory recorded it, or why that is not known. */
export type LaunchCreator = { state: "known"; creator: `0x${string}` } | { state: "none" } | { state: "unreadable" };

/**
 * WHO LAUNCHED ONE TOKEN, FROM THE FACTORY'S OWN LAUNCH EVENT — never from the
 * token's word about itself.
 *
 * pons-meta.ts can read a `deployer` from the template's metadata getter, but
 * that is a value the TOKEN returns: a contract that is not the template can
 * answer the same selector with any address it likes, and a rug that names a
 * decoy as its deployer would read as "the creator did not sell" while the
 * real one sells. A log is different. Filtered by emitter at the node, and
 * checked again here, it can only have come from PONS_V2_FACTORY, and topic3
 * of its launch event is the creator (the probe recorded in this file's
 * header). docs/deployer-following-sketch.md reached the same choice.
 *
 *   known       exactly one launch of this token, naming one creator
 *   none        no launch of it by the factory inside the lookback (not a
 *               Pons launch, or launched earlier than the window), or a record
 *               that disagrees with itself — nothing is known, nothing assumed
 *   unreadable  the node could not be asked; the next attempt may answer
 *
 * The lookback is MAX_LOOKBACK_BLOCKS, the span recentPonsLaunches already
 * uses against this node. Filtered by the token's own topic the answer is one
 * log, so the 10,000-log cap that sized it cannot bite.
 */
export async function readLaunchCreator(
  client: Pick<PublicClient, "getBlockNumber" | "request">,
  token: string,
  lookbackBlocks: bigint = MAX_LOOKBACK_BLOCKS,
): Promise<LaunchCreator> {
  if (typeof token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(token)) return { state: "none" };
  const want = token.toLowerCase() as `0x${string}`;
  const span = lookbackBlocks > MAX_LOOKBACK_BLOCKS ? MAX_LOOKBACK_BLOCKS : lookbackBlocks < 1n ? 1n : lookbackBlocks;
  try {
    const head = await client.getBlockNumber();
    const from = head > span ? head - span : 0n;
    const raw = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: PONS_V2_FACTORY,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${head.toString(16)}`,
          topics: [PONS_LAUNCH_TOPIC, `0x${"0".repeat(24)}${want.slice(2)}`],
        },
      ],
    } as never)) as unknown;
    if (!Array.isArray(raw)) return { state: "unreadable" };
    const factory = PONS_V2_FACTORY.toLowerCase();
    const fromFactory = raw.filter(
      (l): l is { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string } =>
        !!l && typeof l === "object" && typeof (l as { address?: unknown }).address === "string" && (l as { address: string }).address.toLowerCase() === factory && Array.isArray((l as { topics?: unknown }).topics),
    );
    const launches = parseLaunchLogs(
      fromFactory.map((l) => ({
        topics: l.topics,
        data: l.data,
        blockNumber: typeof l.blockNumber === "string" && /^0x[0-9a-fA-F]+$/.test(l.blockNumber) ? BigInt(l.blockNumber) : null,
        transactionHash: typeof l.transactionHash === "string" ? l.transactionHash : null,
      })),
    ).filter((l) => l.token === want);
    const creators = new Set(launches.map((l) => l.creator));
    if (creators.size !== 1) return { state: "none" };
    const creator = [...creators][0]!;
    if (/^0x0{40}$/.test(creator) || creator === want) return { state: "none" };
    return { state: "known", creator };
  } catch {
    return { state: "unreadable" };
  }
}

/** getReserves() — two words on a Pons curve, NOT Uniswap V2's three. */
const SEL_GET_RESERVES = "0x0902f1ac";
/** graduationThreshold() — agrees with the launch event's third data word. */
const SEL_GRADUATION_THRESHOLD = "0x8b0bc501";

/** decimals() on an ERC-20. */
const SEL_DECIMALS = "0x313ce567";

/** Native ETH is the quote for 53.6% of launches and has no decimals() to call. */
const NATIVE = "0x0000000000000000000000000000000000000000";

function word(hex: string, i: number): bigint {
  return BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
}

/**
 * Decimals of a quote asset, cached across a pass.
 *
 * Worth caching because quote assets repeat enormously — one 24h sample had
 * 1,051 launches quoted in SPCX and 736 in NVDA — so a per-launch read would
 * make the same call hundreds of times per scan.
 */
export async function quoteDecimalsOf(
  client: PublicClient,
  quoteToken: `0x${string}`,
  cache: Map<string, number>,
): Promise<number | null> {
  const key = quoteToken.toLowerCase();
  if (key === NATIVE) return 18;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  try {
    const res = await client.call({ to: quoteToken, data: SEL_DECIMALS });
    if (!res.data || res.data.length < 2 + 64) return null;
    const d = Number(word(res.data, 0));
    if (!Number.isInteger(d) || d < 0 || d > 36) return null;
    cache.set(key, d);
    return d;
  } catch {
    // Null, not a guessed 18. A wrong decimals silently scales every figure
    // derived from this curve by a power of ten.
    return null;
  }
}

/**
 * Read a curve's live reserves into the shape the pricer wants.
 *
 * This reader did not exist anywhere in the worker: pons.ts could see that a
 * token launched and pons-price.ts could price a curve given its reserves, but
 * nothing could actually go and fetch them, so neither module had a caller.
 *
 * `graduationThresholdRaw` is taken from the LAUNCH EVENT rather than read back
 * from the contract. They agree (18/18 across quote assets), and preferring the
 * event saves a call per curve on a path that runs against hundreds of launches
 * per pass. `readCurveThreshold` exists for the case where there is no event to
 * hand.
 *
 * Returns null rather than partial reserves — every field here feeds a division,
 * and a zero standing in for an unread one produces a confident wrong answer.
 */
export async function readCurveReserves(
  client: PublicClient,
  launch: Pick<PonsLaunch, "curve" | "graduationThresholdRaw">,
  decimals: { quote: number; token: number },
): Promise<{ quoteRaw: bigint; tokenRaw: bigint; quoteDecimals: number; tokenDecimals: number; graduationThresholdRaw: bigint } | null> {
  try {
    const res = await client.call({ to: launch.curve, data: SEL_GET_RESERVES });
    // Exactly two words. A decoder assuming Uniswap V2's (uint112, uint112,
    // uint32) would read the first two correctly and then either throw or read
    // garbage for a blockTimestampLast that is not there.
    if (!res.data || res.data.length < 2 + 128) return null;
    if (launch.graduationThresholdRaw <= 0n) return null;
    return {
      quoteRaw: word(res.data, 0),
      tokenRaw: word(res.data, 1),
      quoteDecimals: decimals.quote,
      tokenDecimals: decimals.token,
      graduationThresholdRaw: launch.graduationThresholdRaw,
    };
  } catch {
    return null;
  }
}

/** The threshold read from the curve itself, for callers with no launch event. */
export async function readCurveThreshold(
  client: PublicClient,
  curve: `0x${string}`,
): Promise<bigint | null> {
  try {
    const res = await client.call({ to: curve, data: SEL_GRADUATION_THRESHOLD });
    if (!res.data || res.data.length < 2 + 64) return null;
    const t = word(res.data, 0);
    return t > 0n ? t : null;
  } catch {
    return null;
  }
}
