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
 *                              AND the source of every curve's threshold,
 *                              quote asset and launch block (pons.ts)
 *   3. the tape                every curve trade for the last hour in 3,000-
 *                              block chunks, holes reported not hidden
 *                              (pons-tape.ts)
 *   4. the trending universe   curves in the launch set ranked by a profile-
 *                              independent "waking up" score — EVERY quote
 *                              asset, since the owner's ruling of 2026-09-16
 *   5. one Multicall3 batch    symbol, decimals and getReserves for the whole
 *                              shortlist, plus decimals() for each distinct
 *                              quote asset, in a single round trip
 *   6. one price batch         USD for each distinct quote asset — a constant
 *                              for USDG, a Chainlink feed for ETH and every
 *                              registry stock/ETF, nothing for the rest
 *
 * RESEARCH IS WIDER THAN EXECUTION, ON PURPOSE. The live class route enters one
 * hop from USDG only, and on the live tape that is under 1% of curve trading.
 * Every candidate here carries `quote.executable` and a stated reason when it
 * is false; the deterministic layer downstream refuses to build an intent for
 * an unexecutable quote and the report says which opportunity was missed and
 * why. Widening `executable` is a route design with a canary, never a flag.
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
import { USDG_DECIMALS } from "../../packages/core/src/index";
import {
  UI_ONE,
  classifyQuote,
  depthUsd6,
  readQuotePrices,
  type QuoteAsset,
  type QuotePrice,
  type QuotePriceOutcome,
} from "./venues/quote-assets";

/** The windows the brief asks for, in seconds, shortest first. */
export const TRENDING_WINDOWS_SEC: readonly number[] = [300, 900, 3600];
/** How far back the launch set reaches — the class route's own 6h window. */
export const TRENDING_LAUNCH_WINDOW_SEC = 6 * 3600;
/** Fallback cadence when the clock cannot be read; ~0.1 s/block on this chain. */
export const FALLBACK_SEC_PER_BLOCK = 0.1;
/** How many trending curves get a reserves read. One Multicall3 batch either way. */
export const TRENDING_TOP_N = 32;
/**
 * Executable slots RESERVED in the shortlist, whatever the trending score says.
 *
 * The trending score is quote-blind, and on the live tape ETH-quoted curves
 * carry most of the trading, so a top-N cut by score can hold zero USDG
 * curves — the first live run of the widened universe read 24 candidates and
 * not one was executable. The deterministic path the shadow exists to compare
 * against then never ran, and "agrees with deterministic" was a comparison of
 * nothing with nothing. Eight is the tick's own `CLASS_MAX_READS`: the
 * executable universe it would have read is always in the list, tagged as
 * such, beside whatever the score put there.
 */
export const TRENDING_EXECUTABLE_RESERVE = 8;

/** Why a curve is on the shortlist. */
export type ShortlistedBy = "trending" | "executable-reserve";

/**
 * The top-N by score UNION the top-K executable by score, PURE. Order is the
 * score order; a curve in both sets is listed once, tagged "trending".
 * Returns how many executable curves were left OUT too, so the report can
 * say what the tick would have seen that this pass did not read.
 */
export function pickShortlist<T extends { score: number; executable: boolean }>(
  ranked: readonly T[],
  topN: number,
  reserve: number,
): { picked: { item: T; by: ShortlistedBy }[]; executableOutside: number } {
  const picked: { item: T; by: ShortlistedBy }[] = [];
  const chosen = new Set<T>();
  for (const item of ranked.slice(0, topN)) {
    picked.push({ item, by: "trending" });
    chosen.add(item);
  }
  let reserved = 0;
  let executableOutside = 0;
  for (const item of ranked) {
    if (!item.executable) continue;
    if (chosen.has(item)) {
      reserved++;
      continue;
    }
    if (reserved < reserve) {
      picked.push({ item, by: "executable-reserve" });
      chosen.add(item);
      reserved++;
    } else {
      executableOutside++;
    }
  }
  return { picked, executableOutside };
}

const SEL_SYMBOL = "0x95d89b41" as const;
const SEL_DECIMALS = "0x313ce567" as const;
const SEL_GET_RESERVES = "0x0902f1ac" as const;

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
  /** What the curve is priced in, classified, with executability and its reason. */
  quote: QuoteAsset;
  quoteIsUsdg: boolean;
  /** Why this curve is on the list — the score, or the reserved executable slots. */
  shortlistedBy: ShortlistedBy;
  /**
   * The quote's decimals. Guessed 18 ONLY when `quoteDecimalsKnown` is false,
   * and in that case `reserves` is null too — no figure is derived from a
   * guessed scale. USDG and native ETH are known without a read.
   */
  quoteDecimals: number;
  quoteDecimalsKnown: boolean;
  /** USD per whole quote UI unit, 8dp. Null when the quote has no price. */
  quoteUsd8: bigint | null;
  /** Why the quote is or is not priced this run — see quote-assets.ts. */
  quotePriceWhy: QuotePriceOutcome;
  /** ERC-8056 multiplier for a stock quote, 1e18 otherwise. See quote-assets.ts. */
  quoteUiMultiplier: bigint;
  quotePriceStale: boolean;
  graduationThresholdRaw: bigint;
  launchBlock: bigint;
  /** Seconds since launch, from the measured clock. Null when unclocked. */
  ageSec: number | null;
  /** Null when the batch could not read this curve. */
  reserves: CurveReserves | null;
  /** Real depth in whole units of the QUOTE asset. Null when unreadable. */
  depthQuote: number | null;
  /** Real depth in whole USD. Null when unreadable or the quote is unpriced. */
  depthUsd: number | null;
  /** 0..10000 along the curve. Null when unreadable. */
  graduationBps: number | null;
  /** USD per token as a decimal string. Null when unpriced. */
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
  /** How many of the candidates the live route cannot execute today. */
  unexecutable: number;
  /**
   * Executable (USDG-quoted) curves that traded this hour but did not make
   * the shortlist even with the reserved slots. Non-zero means the tick's own
   * universe was wider than what this pass read.
   */
  executableOutsideShortlist: number;
  /** Every priced quote failed to price this run — a dead RPC round, not a quiet hour. */
  allFeedsFailed: boolean;
  /**
   * Where the hour's trading actually was, by quote asset — every traded
   * curve, not only the shortlist. The line that says how small the
   * executable universe is.
   */
  quoteBreakdown: { quote: string; curves: number; trades: number; executable: boolean }[];
  /** Every distinct quote asset among the candidates, with its price if any and why. */
  quotes: { asset: QuoteAsset; price: QuotePrice | null; why: QuotePriceOutcome; decimals: number | null }[];
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
  /** The account's cash token. Kept for the id and the breakdown label. */
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
  const asOf = clock?.latestTimeSec ?? now();
  const blocksFor = (sec: number) => BigInt(Math.max(1, Math.round(sec / secPerBlock)));

  // 2. the launch set — the allow-list
  const wantLookback = blocksFor(deps.launchWindowSec ?? TRENDING_LAUNCH_WINDOW_SEC);
  // ONE RETRY, same window. Half of a six-run live loop lost its snapshot to
  // a refused launch scan on the public RPC — a transient, not a cap (the 6h
  // window holds ~2,200 launches against the node's 10,000-log ceiling). A
  // narrower window would silently shrink the allow-list, so the retry asks
  // for exactly the same thing and the failure, if it repeats, is still a
  // failure and not a smaller universe.
  let scan = await recentPonsLaunches(deps.client, wantLookback);
  if (scan.failed) {
    await new Promise((r) => setTimeout(r, 2_000));
    scan = await recentPonsLaunches(deps.client, wantLookback);
  }
  if (scan.failed) throw new Error("the factory launch scan failed twice; no allow-list, no snapshot");
  const launchByCurve = new Map<string, PonsLaunch>();
  for (const l of scan.launches) launchByCurve.set(l.curve.toLowerCase(), l);

  // 3. the tape, one hour deep
  const longest = windowsSec[windowsSec.length - 1]!;
  const tapeFrom = head > blocksFor(longest) ? head - blocksFor(longest) + 1n : 0n;
  const tape = await readCurveTrades(deps.client, { from: tapeFrom, to: head });

  // 4. the universe — every quote asset
  const trends = windowFeatures(tape, {
    head,
    secPerBlock,
    windowsSec,
    allow: new Set(launchByCurve.keys()),
  });
  const ranked = [...trends.values()]
    .map((t) => ({ t, score: trendingScore(t) }))
    .sort((a, b) => b.score - a.score || (a.t.curve < b.t.curve ? -1 : 1));

  const byQuote = new Map<string, { asset: QuoteAsset; curves: number; trades: number }>();
  const universe = ranked.map(({ t, score }) => {
    const launch = launchByCurve.get(t.curve)!;
    const quote = classifyQuote(launch.quoteToken);
    const agg = byQuote.get(quote.address) ?? { asset: quote, curves: 0, trades: 0 };
    agg.curves++;
    agg.trades += t.windows[t.windows.length - 1]!.trades;
    byQuote.set(quote.address, agg);
    return { launch, trend: t, score, quote, executable: quote.executable };
  });
  const { picked, executableOutside } = pickShortlist(universe, topN, TRENDING_EXECUTABLE_RESERVE);
  const shortlist = picked.map(({ item, by }) => ({ ...item, by }));

  // 5. one batch: symbol, decimals, reserves — plus decimals() per distinct quote
  const distinctQuotes = [...new Map(shortlist.map((s) => [s.quote.address, s.quote])).values()];
  // USDG and native ETH need no read: 6 and 18 by registry fact, the same way
  // the tick hard-codes `{ quote: 6 }` for the one quote it trades. The
  // executable universe must never depend on a batch leg that can fail.
  const quoteDecCalls = distinctQuotes
    .filter((q) => q.kind !== "native-eth" && q.kind !== "usdg")
    .map((q) => ({ target: q.address, callData: SEL_DECIMALS as `0x${string}` }));
  const calls = [
    ...shortlist.flatMap(({ launch }) => [
      { target: launch.token, callData: SEL_SYMBOL as `0x${string}` },
      { target: launch.token, callData: SEL_DECIMALS as `0x${string}` },
      { target: launch.curve, callData: SEL_GET_RESERVES as `0x${string}` },
    ]),
    ...quoteDecCalls,
  ];
  const res = await aggregate3(deps.client, calls);
  const batchOk = res.length === calls.length;

  const quoteDecimals = new Map<string, number>();
  for (const q of distinctQuotes) {
    if (q.kind === "native-eth") quoteDecimals.set(q.address, 18);
    if (q.kind === "usdg") quoteDecimals.set(q.address, USDG_DECIMALS);
  }
  if (batchOk) {
    const base = shortlist.length * 3;
    quoteDecCalls.forEach((c, i) => {
      const r = res[base + i];
      const d = r?.success ? word(r.returnData, 0) : null;
      if (d !== null && d >= 0n && d <= 36n) quoteDecimals.set(c.target, Number(d));
    });
  }

  // 6. one price batch for the distinct quotes
  const { prices, outcomes } = await readQuotePrices(deps.client, distinctQuotes, asOf);
  const feedQuotes = distinctQuotes.filter((q) => q.feed !== null);
  const allFeedsFailed = feedQuotes.length > 0 && feedQuotes.every((q) => outcomes.get(q.address) === "feed-failed");

  const candidates: TrendingCandidate[] = shortlist.map(({ launch, trend, score, quote, by }, i) => {
    const id = `c${String(i + 1).padStart(2, "0")}`;
    const sym = batchOk ? res[i * 3] : undefined;
    const dec = batchOk ? res[i * 3 + 1] : undefined;
    const rv = batchOk ? res[i * 3 + 2] : undefined;
    const symbol = safeSymbol(sym?.success ? decodeErc20String(sym.returnData) : "", `T${id.toUpperCase()}`);
    const decWord = dec?.success ? word(dec.returnData, 0) : null;
    const decimals = decWord !== null && decWord >= 0n && decWord <= 36n ? Number(decWord) : 18;
    const qDec = quoteDecimals.get(quote.address);
    const price = prices.get(quote.address) ?? null;
    let reserves: CurveReserves | null = null;
    // Without the quote's decimals no figure derived from this curve is real;
    // a guessed 18 would silently scale a USDG-quoted depth by 10^12.
    if (rv?.success && qDec !== undefined) {
      const q = word(rv.returnData, 0);
      const t = word(rv.returnData, 1);
      if (q !== null && t !== null) {
        reserves = { quoteRaw: q, tokenRaw: t, quoteDecimals: qDec, tokenDecimals: decimals, graduationThresholdRaw: launch.graduationThresholdRaw };
      }
    }
    const progress = reserves ? curveDepthFraction(reserves) : null;
    const real = reserves ? realQuoteRaw(reserves) : null;
    const mult = price?.uiMultiplier ?? UI_ONE;
    const usd6 = real !== null && qDec !== undefined ? depthUsd6(real, qDec, price?.usd8 ?? null, mult) : null;
    // The curve pricer wants USD per RAW quote unit; the feed gives USD per UI
    // unit, so fold the multiplier into the price it is handed.
    const rawUsd8 = price ? (price.usd8 * price.uiMultiplier) / UI_ONE : null;
    const tokenPrice = reserves && rawUsd8 && rawUsd8 > 0n ? curvePrice(reserves, rawUsd8) : null;
    return {
      id,
      token: launch.token,
      symbol,
      decimals,
      curve: launch.curve,
      quoteToken: launch.quoteToken,
      quote,
      quoteIsUsdg: quote.kind === "usdg",
      shortlistedBy: by,
      quoteDecimals: qDec ?? 18,
      quoteDecimalsKnown: qDec !== undefined,
      quoteUsd8: price?.usd8 ?? null,
      quotePriceWhy: outcomes.get(quote.address) ?? "no-feed",
      quoteUiMultiplier: mult,
      quotePriceStale: price?.stale ?? false,
      graduationThresholdRaw: launch.graduationThresholdRaw,
      launchBlock: launch.blockNumber,
      ageSec: ageSecOf(clock, launch.blockNumber),
      reserves,
      depthQuote: real !== null && qDec !== undefined ? (Number(real) / 10 ** qDec) * (Number(mult) / 1e18) : null,
      depthUsd: usd6 === null ? null : Number(usd6) / 1e6,
      graduationBps: progress === null ? null : Math.round(progress * 10_000),
      priceUsd: tokenPrice ? (Number(tokenPrice.price8) / 1e8).toPrecision(6) : null,
      trend,
      trendingScore: score,
    };
  });

  const id = `trend_${head}_${fnv([String(head), ...candidates.map((c) => `${c.curve}:${c.trendingScore}`)])}`;
  return {
    id,
    head,
    asOf,
    secPerBlock,
    clockMeasured: clock !== null,
    windowsSec,
    launchLookbackBlocks: wantLookback > MAX_LOOKBACK_BLOCKS ? MAX_LOOKBACK_BLOCKS : wantLookback,
    launches: scan.launches.length,
    launchScanClamped: scan.clamped,
    tape: { trades: tape.trades.length, from: tape.from, to: tape.to, holes: tape.holes },
    tradedCurves: trends.size,
    unexecutable: candidates.filter((c) => !c.quote.executable).length,
    executableOutsideShortlist: executableOutside,
    allFeedsFailed,
    quoteBreakdown: [...byQuote.values()]
      .map((v) => ({ quote: v.asset.symbol, curves: v.curves, trades: v.trades, executable: v.asset.executable }))
      .sort((a, b) => b.trades - a.trades)
      .slice(0, 10),
    quotes: distinctQuotes.map((asset) => ({
      asset,
      price: prices.get(asset.address) ?? null,
      why: outcomes.get(asset.address) ?? "no-feed",
      decimals: quoteDecimals.get(asset.address) ?? null,
    })),
    candidates,
  };
}
