/**
 * ONE TRENDING SNAPSHOT, SHARED BY EVERY AGENT THAT LOOKS AT IT.
 *
 * The milestone's first test is "run Shogun and SirSendIt against the SAME
 * trending snapshot". That only means something if the snapshot is built once,
 * carries an id derived from its contents and not from who asked, and is then
 * handed — unchanged — to each agent's research step. This module builds it;
 * brain-trending.ts consumes it; nothing in here knows an agent exists.
 *
 * WHAT IT READS, and why in this order:
 *
 *   1. the block clock         two getBlock calls; seconds per block MEASURED,
 *                              so the 5m/15m/1h windows are real minutes and
 *                              a launch's age is real seconds (pons-card.ts)
 *   2. the launch set          one factory-filtered eth_getLogs over the class
 *                              window — the allow-list of legitimate emitters
 *                              AND the source of every curve's threshold and
 *                              launch block (pons.ts)
 *   3. the tape                every curve trade for the last hour in 3,000-
 *                              block chunks, holes reported not hidden
 *                              (pons-tape.ts)
 *   4. the trending universe   curves in the launch set ranked by a profile-
 *                              independent "waking up" score; the top N
 *                              USDG-quoted ones go on to
 *   5. one Multicall3 batch    symbol, decimals and getReserves for the whole
 *                              shortlist in a single round trip (pons-meta.ts)
 *
 * The class producer in index.ts sees the 40 newest candidate rows within 6h
 * and reads reserves for the 8 newest USDG ones. This universe is different by
 * design: it is driven by what is TRADING, not by what was recently launched,
 * and it inherits neither the 5% discovery depth floor nor the eight-read cap.
 * Whether a trending curve is also ELIGIBLE is not decided here — that is the
 * deterministic prefilter, with the owner's own thresholds, in the next step.
 *
 * NOTHING HERE IS A BUY SIGNAL. Every field is a measurement; the snapshot is
 * data for two layers that come after it, and both of them can say no.
 */
import type { PublicClient } from "viem";
import { ageSecOf, decodeErc20String, readBlockClock, type BlockClock } from "./venues/pons-card";
import { aggregate3, sanitizeMeta } from "./venues/pons-meta";
import { MAX_LOOKBACK_BLOCKS, recentPonsLaunches, type PonsLaunch } from "./venues/pons";
import { curveDepthFraction, curvePrice, realQuoteRaw, type CurveReserves } from "./venues/pons-price";
import {
  readCurveTrades,
  trendingScore,
  windowFeatures,
  type CurveTrend,
  type TapeHole,
} from "./venues/pons-tape";

/** The windows the brief asks for, in seconds, shortest first. */
export const TRENDING_WINDOWS_SEC: readonly number[] = [300, 900, 3600];
/** How far back the launch set reaches — the class route's own 6h window. */
export const TRENDING_LAUNCH_WINDOW_SEC = 6 * 3600;
/** Fallback cadence when the clock cannot be read; ~0.1 s/block on this chain. */
export const FALLBACK_SEC_PER_BLOCK = 0.1;
/** How many trending curves get a reserves read. One Multicall3 batch either way. */
export const TRENDING_TOP_N = 24;

const SEL_SYMBOL = "0x95d89b41" as const;
const SEL_DECIMALS = "0x313ce567" as const;
const SEL_GET_RESERVES = "0x0902f1ac" as const;
const ZERO = /^0x0{40}$/i;

export interface TrendingCandidate {
  /**
   * The handle the Brain is given INSTEAD of an address — `c01`, `c02`, …
   * Trusted code maps it back to the curve. The Brain's own validators refuse
   * anything address-shaped, so this is the only name it can ever use.
   */
  id: string;
  token: `0x${string}`;
  /** ERC-20 symbol, sanitised to a short safe token; `T<id>` when unreadable. */
  symbol: string;
  decimals: number;
  curve: `0x${string}`;
  quoteToken: `0x${string}`;
  quoteIsUsdg: boolean;
  graduationThresholdRaw: bigint;
  launchBlock: bigint;
  /** Seconds since launch, from the measured clock. Null when unclocked. */
  ageSec: number | null;
  /** Null when the batch could not read this curve. */
  reserves: CurveReserves | null;
  /** Real depth in whole USDG (6dp scaled). Null when unreadable or not USDG. */
  depthUsdg: number | null;
  /** 0..10000 along the curve. Null when unreadable. */
  graduationBps: number | null;
  /** USD per token as a decimal string, for a USDG-quoted curve. */
  priceUsd: string | null;
  trend: CurveTrend;
  trendingScore: number;
}

export interface TrendingSnapshot {
  /** Content-addressed: head + the ranked curve list. No agent in it. */
  id: string;
  head: bigint;
  asOf: number;
  secPerBlock: number;
  clockMeasured: boolean;
  windowsSec: number[];
  launchLookbackBlocks: bigint;
  launches: number;
  launchScanClamped: boolean;
  tape: { trades: number; from: bigint; to: bigint; holes: TapeHole[] };
  /** Curves in the launch set that traded in the tape window. */
  tradedCurves: number;
  /** How many of the ranked universe were skipped for not being USDG-quoted. */
  droppedNonUsdg: number;
  /**
   * Where the hour's trading actually was, by quote asset. The class route can
   * only reach USDG-quoted curves (one hop from cash), and on the live tape
   * those are a small minority — this is the line that says how small.
   */
  quoteBreakdown: { quote: string; curves: number; trades: number }[];
  candidates: TrendingCandidate[];
}

function fnv(parts: string[]): string {
  let h = 0x811c9dc5;
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** A symbol the Brain may read: short, printable, never hex-shaped. */
export function safeSymbol(raw: string, fallback: string): string {
  const cleaned = sanitizeMeta(raw, 12).replace(/[^A-Za-z0-9_$.\-]/g, "");
  if (!cleaned) return fallback;
  if (/^0x/i.test(cleaned) || /^[0-9a-fA-F]{16,}$/.test(cleaned)) return fallback;
  return cleaned;
}

function word(hex: string, i: number): bigint | null {
  const start = 2 + i * 64;
  if (hex.length < start + 64) return null;
  return BigInt(`0x${hex.slice(start, start + 64)}`);
}

export interface SnapshotDeps {
  client: PublicClient;
  /** The account's cash token; only curves quoted in it get a reserves read. */
  usdg: `0x${string}`;
  windowsSec?: readonly number[];
  topN?: number;
  launchWindowSec?: number;
  now?: () => number;
}

/**
 * Build the snapshot. Throws only when the launch set could not be read at
 * all — without the allow-list nothing downstream can be trusted, and a
 * snapshot with zero legitimate curves would read as a quiet chain.
 */
export async function buildTrendingSnapshot(deps: SnapshotDeps): Promise<TrendingSnapshot> {
  const windowsSec = [...(deps.windowsSec ?? TRENDING_WINDOWS_SEC)].sort((a, b) => a - b);
  const topN = deps.topN ?? TRENDING_TOP_N;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  // 1. the clock
  const clock: BlockClock | null = await readBlockClock(deps.client);
  const secPerBlock = clock?.secPerBlock ?? FALLBACK_SEC_PER_BLOCK;
  const head = clock?.latest ?? (await deps.client.getBlockNumber());
  const blocksFor = (sec: number) => BigInt(Math.max(1, Math.round(sec / secPerBlock)));

  // 2. the launch set — the allow-list
  const wantLookback = blocksFor(deps.launchWindowSec ?? TRENDING_LAUNCH_WINDOW_SEC);
  const scan = await recentPonsLaunches(deps.client, wantLookback);
  if (scan.failed) throw new Error("the factory launch scan failed; no allow-list, no snapshot");
  const launchByCurve = new Map<string, PonsLaunch>();
  for (const l of scan.launches) launchByCurve.set(l.curve.toLowerCase(), l);

  // 3. the tape, one hour deep
  const longest = windowsSec[windowsSec.length - 1]!;
  const tapeFrom = head > blocksFor(longest) ? head - blocksFor(longest) + 1n : 0n;
  const tape = await readCurveTrades(deps.client, { from: tapeFrom, to: head });

  // 4. the universe
  const trends = windowFeatures(tape, {
    head,
    secPerBlock,
    windowsSec,
    allow: new Set(launchByCurve.keys()),
  });
  const ranked = [...trends.values()]
    .map((t) => ({ t, score: trendingScore(t) }))
    .sort((a, b) => b.score - a.score || (a.t.curve < b.t.curve ? -1 : 1));

  const usdg = deps.usdg.toLowerCase();
  const shortlist: { launch: PonsLaunch; trend: CurveTrend; score: number }[] = [];
  let droppedNonUsdg = 0;
  const byQuote = new Map<string, { curves: number; trades: number }>();
  for (const { t, score } of ranked) {
    const launch = launchByCurve.get(t.curve)!;
    const q = ZERO.test(launch.quoteToken) ? "ETH (native)" : launch.quoteToken.toLowerCase() === usdg ? "USDG" : launch.quoteToken.toLowerCase();
    const agg = byQuote.get(q) ?? { curves: 0, trades: 0 };
    agg.curves++;
    agg.trades += t.windows[t.windows.length - 1]!.trades;
    byQuote.set(q, agg);
    if (ZERO.test(launch.quoteToken) || launch.quoteToken.toLowerCase() !== usdg) {
      droppedNonUsdg++;
      continue;
    }
    shortlist.push({ launch, trend: t, score });
    if (shortlist.length >= topN) break;
  }

  // 5. one batch: symbol, decimals, reserves
  const calls = shortlist.flatMap(({ launch }) => [
    { target: launch.token, callData: SEL_SYMBOL as `0x${string}` },
    { target: launch.token, callData: SEL_DECIMALS as `0x${string}` },
    { target: launch.curve, callData: SEL_GET_RESERVES as `0x${string}` },
  ]);
  const res = await aggregate3(deps.client, calls);
  const batchOk = res.length === calls.length;

  const candidates: TrendingCandidate[] = shortlist.map(({ launch, trend, score }, i) => {
    const id = `c${String(i + 1).padStart(2, "0")}`;
    const sym = batchOk ? res[i * 3] : undefined;
    const dec = batchOk ? res[i * 3 + 1] : undefined;
    const rv = batchOk ? res[i * 3 + 2] : undefined;
    const symbol = safeSymbol(sym?.success ? decodeErc20String(sym.returnData) : "", `T${id.toUpperCase()}`);
    const decWord = dec?.success ? word(dec.returnData, 0) : null;
    const decimals = decWord !== null && decWord >= 0n && decWord <= 36n ? Number(decWord) : 18;
    let reserves: CurveReserves | null = null;
    if (rv?.success) {
      const q = word(rv.returnData, 0);
      const t = word(rv.returnData, 1);
      if (q !== null && t !== null) {
        reserves = {
          quoteRaw: q,
          tokenRaw: t,
          quoteDecimals: 6, // USDG by the filter above — verified, not assumed
          tokenDecimals: decimals,
          graduationThresholdRaw: launch.graduationThresholdRaw,
        };
      }
    }
    const progress = reserves ? curveDepthFraction(reserves) : null;
    const price = reserves ? curvePrice(reserves, 100_000_000n) : null;
    return {
      id,
      token: launch.token,
      symbol,
      decimals,
      curve: launch.curve,
      quoteToken: launch.quoteToken,
      quoteIsUsdg: true,
      graduationThresholdRaw: launch.graduationThresholdRaw,
      launchBlock: launch.blockNumber,
      ageSec: ageSecOf(clock, launch.blockNumber),
      reserves,
      depthUsdg: reserves ? Number(realQuoteRaw(reserves)) / 1e6 : null,
      graduationBps: progress === null ? null : Math.round(progress * 10_000),
      priceUsd: price ? (Number(price.price8) / 1e8).toPrecision(6) : null,
      trend,
      trendingScore: score,
    };
  });

  const id = `trend_${head}_${fnv([String(head), ...candidates.map((c) => `${c.curve}:${c.trendingScore}`)])}`;
  return {
    id,
    head,
    asOf: clock?.latestTimeSec ?? now(),
    secPerBlock,
    clockMeasured: clock !== null,
    windowsSec,
    launchLookbackBlocks: wantLookback > MAX_LOOKBACK_BLOCKS ? MAX_LOOKBACK_BLOCKS : wantLookback,
    launches: scan.launches.length,
    launchScanClamped: scan.clamped,
    tape: { trades: tape.trades.length, from: tape.from, to: tape.to, holes: tape.holes },
    tradedCurves: trends.size,
    droppedNonUsdg,
    quoteBreakdown: [...byQuote.entries()]
      .map(([quote, v]) => ({ quote, ...v }))
      .sort((a, b) => b.trades - a.trades)
      .slice(0, 8),
    candidates,
  };
}
