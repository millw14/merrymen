/**
 * Discovery — telling the owner a pair exists, and nothing more than that.
 *
 * merrymen reads Uniswap v3 pools directly and can compute a v4 PoolKey when the
 * pool is vanilla. Neither of those finds a HOOKED pool: Pons/Doppler launches
 * attach a hook whose address can't be guessed, so the pool is unreachable by
 * any amount of scanning. Bitquery decodes this chain's Initialize events from
 * genesis, which is the only way those become visible at all.
 *
 * WHAT THIS IS EXPLICITLY NOT. It does not add tokens, widen a cap, or produce a
 * trade. This module only ever REPORTS and records what it found.
 *
 * The `trencher` strategy can act on those records — but only when the owner has
 * selected it, and in live mode only for a token they added and re-signed the
 * grant to cover. So the sequence stays owner → wall → agent, never feed →
 * agent. Nothing here is on the dispose side, and it must stay that way: a
 * discovery feed that could open positions BY ITSELF would be a feed that
 * decides what to buy, which is the one thing the permission model exists to
 * prevent. Recording a candidate is not deciding to hold it.
 *
 * It also runs on its OWN slow cadence, not the trading tick. The holder gateway
 * allows a handful of calls a minute across everything a wallet does, and a
 * poll that starved the brain of its allowance would trade one feature for
 * another the owner is more likely to be relying on.
 */

import type { PublicClient } from "viem";
import { parseAbi } from "viem";
import { CASH, type StockToken } from "../../packages/core/src/index";
import { poolPriceUsable, readRoutedPrice } from "./venues/pool-price";
import { readTokenStats } from "./venues/token-stats";
import { recentPools, resolveBitquery, type BitqueryCreds, type NewPair } from "./venues/bitquery";
import { readCurveReserves, recentPonsLaunches, type PonsLaunch } from "./venues/pons";
import { screenPools, type GeckoPool, type PoolFeed, type ScreenLimits } from "./venues/geckoterminal";
import type { MemecoinScout } from "./strategist/memecoin-scout";
import { curveDepthFraction, curveGraduated, curvePrice, type CurveReserves } from "./venues/pons-price";
import { scoutFieldsFor, type CoinResearch } from "./strategist/coin-research";

const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** A pair worth telling the owner about, with enough context to judge it. */
export interface Discovery {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  /** Unix seconds the pool was initialized. */
  createdAt: number;
  /** USD depth of the shallowest leg, when it could be priced at all. */
  liquidityUsdg: bigint | null;
  /** Would this clear the owner's own depth/divergence guards today? */
  priceable: boolean;
  /** When it wouldn't, the guard's own words. */
  reason?: string;
  /** Guarded price, 8dp — null when it couldn't be priced. */
  price8: bigint | null;
  /**
   * Fully diluted value, supply × price. Null when unpriceable or unreadable.
   * FDV, not market cap — see token-stats.ts for why the distinction matters
   * when the number is about to gate spending.
   */
  fdvUsd: number | null;
  /**
   * The v4 PoolKey the Initialize event carried, when all five fields parsed.
   * The only way a HOOKED pool ever becomes routable — hook addresses cannot
   * be guessed, only learned here. Absent for keyless sightings; the store
   * keeps a captured key even when later sightings are keyless.
   */
  key?: NewPair["key"];
  /**
   * Set when this came from the Pons LAUNCHPAD rather than a Uniswap pool.
   *
   * A pre-graduation token has no pool at all — it trades only on this curve —
   * so the address is not a routing convenience, it is the only way to reach
   * the token. Its presence is also what tells every consumer that the pool
   * guards did NOT run on this sighting.
   */
  curve?: {
    curve: `0x${string}`;
    /** `0x000…0` means native ETH, which is 53.6% of launches. */
    quoteToken: `0x${string}`;
    /** Raw quote units. Without it the virtual seed cannot be subtracted. */
    graduationThresholdRaw: bigint;
    /**
     * Real quote raised as a fraction of this curve's own graduation threshold.
     *
     * The comparable measure across a launchpad where only half the curves are
     * ETH-quoted and the thresholds are not a constant USD value. Excludes the
     * virtual seed — see venues/pons-price.ts.
     */
    depthFraction: number;
  };
}

/**
 * Cash-side tokens. A new pool always pairs the new token against one of these,
 * so whichever side is NOT in here is the thing that launched.
 */
const CASH_SIDE = new Set<string>([
  (CASH.USDG as string).toLowerCase(),
  (CASH.WETH as string).toLowerCase(),
  "0x0000000000000000000000000000000000000000",
]);

/** Which side of the pair is the new token? null when neither side is cash. */
export function newTokenOf(pair: NewPair): `0x${string}` | null {
  const a = pair.token.toLowerCase();
  const b = pair.quote.toLowerCase();
  const aCash = CASH_SIDE.has(a);
  const bCash = CASH_SIDE.has(b);
  // Both cash (a USDG/WETH pool) or neither (an exotic pair we can't value
  // against anything we hold) are equally not-a-launch. Say nothing.
  if (aCash === bCash) return null;
  return (aCash ? b : a) as `0x${string}`;
}

export interface DiscoveryDeps {
  client: PublicClient;
  creds: BitqueryCreds;
  guard: { minLiquidityUsdg: bigint; maxDivergenceBps: number };
  /** Addresses already reported — the caller persists these across restarts. */
  seen: ReadonlySet<string>;
  /** Tokens already configured; no point announcing what the owner has. */
  known: readonly StockToken[];
  sinceMinutes?: number;
}

/**
 * One discovery pass. Returns only genuinely new, genuinely relevant pairs.
 *
 * Every failure degrades to an empty list rather than throwing: this runs beside
 * a trading loop, and a data provider having a bad minute must never be able to
 * interrupt an agent that might need to sell.
 */
export async function discoverPools(deps: DiscoveryDeps): Promise<Discovery[]> {
  const res = await recentPools(deps.creds, { sinceMinutes: deps.sinceMinutes ?? 60, limit: 25 });
  if (!res.ok || !res.data) return [];

  const knownAddrs = new Set(deps.known.map((t) => t.address.toLowerCase()));
  const candidates: { token: `0x${string}`; poolKey?: NewPair["key"] }[] = [];
  const seenThisPass = new Set<string>();
  for (const pair of res.data) {
    const token = newTokenOf(pair);
    if (!token) continue;
    const key = token.toLowerCase();
    if (deps.seen.has(key) || knownAddrs.has(key) || seenThisPass.has(key)) continue;
    seenThisPass.add(key);
    candidates.push({ token, poolKey: pair.key });
  }
  if (!candidates.length) return [];

  const out: Discovery[] = [];
  for (const { token, poolKey } of candidates) {
    // Read identity from the CONTRACT, never from the indexer. A symbol is
    // attacker-chosen text that will be shown to a human and could be picked to
    // impersonate a real ticker; taking it from the chain at least means it's
    // the token's own claim, and the length/charset cap below bounds the damage.
    let symbol = `${token.slice(0, 10)}…`;
    let decimals = 18;
    try {
      const [s, d] = await Promise.all([
        deps.client.readContract({ address: token, abi: ERC20, functionName: "symbol" }) as Promise<string>,
        deps.client.readContract({ address: token, abi: ERC20, functionName: "decimals" }) as Promise<number>,
      ]);
      if (typeof s === "string" && s.length > 0) symbol = sanitizeSymbol(s);
      const dn = Number(d);
      if (Number.isInteger(dn) && dn >= 0 && dn <= 36) decimals = dn;
    } catch {
      // Not a readable ERC-20. Still worth reporting — it launched — but with
      // the address as its name rather than something we couldn't verify.
    }

    let liquidityUsdg: bigint | null = null;
    let priceable = false;
    let reason: string | undefined;
    let price8: bigint | null = null;
    let fdvUsd: number | null = null;
    try {
      const routed = await readRoutedPrice(deps.client, {
        token,
        tokenDecimals: decimals,
        cash: CASH.USDG as `0x${string}`,
        cashDecimals: 6,
        weth: CASH.WETH as `0x${string}`,
      });
      if (!routed) {
        reason = "no route to USDG yet";
      } else {
        liquidityUsdg = routed.liquidityUsdg;
        const verdict = poolPriceUsable(routed, deps.guard);
        priceable = verdict.ok;
        if (!verdict.ok) reason = verdict.reason;
        // FDV only from a price that PASSED the guards. Deriving it from an
        // unguarded reading would produce a valuation anyone could move — and
        // this figure gates whether money gets spent.
        if (verdict.ok) {
          price8 = routed.price8;
          const stats = await readTokenStats(deps.client, { token, price8: routed.price8, decimals });
          fdvUsd = stats?.fdvExBurnedUsd ?? null;
        }
      }
    } catch {
      reason = "couldn't read its pool";
    }

    out.push({ token, symbol, decimals, createdAt: 0, liquidityUsdg, priceable, reason, price8, fdvUsd, ...(poolKey ? { key: poolKey } : {}) });
  }
  return out;
}

/**
 * How much of its own graduation threshold a curve must really have raised
 * before the owner hears about it.
 *
 * MEASURED, and the single most consequential constant in this file. The
 * launchpad runs at ~475 launches/hour, so announcing everything is not a
 * feature, it is a denial of service against the owner's attention — and
 * against the events table, which has no pruning.
 *
 * Against 60 curves sampled live: 78% hold EXACTLY ZERO real quote, and 1.7%
 * clear 5% of their threshold — about 6–8 an hour. Independently, a replay of
 * 249 curves' full trade history puts the base graduation rate at 0.96% while
 * curves that reach a quarter of their threshold graduate 18.2% of the time, so
 * this measure is genuinely predictive rather than merely selective.
 *
 * Expressed as a FRACTION, never a dollar figure: 42.8% of launches are quoted
 * in Robinhood stock tokens and 2.3% in cbBTC, which this repo cannot price at
 * all, and the thresholds themselves range $7,737–$10,377 having been set at
 * different times and never repriced. A USD floor would silently exclude half
 * the launchpad for want of a feed.
 */
export const PONS_MIN_DEPTH_FRACTION = 0.05;

/**
 * When the next launchpad pass is due, and how far back it must look.
 *
 * PURE, AND SEPARATE, because getting it wrong is invisible. The window is
 * measured from the last SUCCESSFUL pass, never from the last attempt — so a
 * refused scan simply widens the next one instead of leaving a hole. The
 * earlier version advanced its clock before the RPC call and returned early on
 * failure, which meant the ~40 launches inside a failed window were read by no
 * pass, ever, and a single transient 429 was enough to open one.
 *
 * The overlap is deliberate and one-directional: re-reading a launch is free
 * (the seen-set drops it), while missing one is permanent.
 */
export function ponsScanWindow(opts: {
  /** Unix seconds of the last pass that actually returned data; 0 if never. */
  lastSuccessAt: number;
  nowSec: number;
  intervalSec: number;
  blocksPerSec: bigint;
  /** Seconds of deliberate overlap, to absorb block-time variance. */
  overlapSec?: number;
}): { due: boolean; elapsedSec: number; lookbackBlocks: bigint } {
  const overlap = opts.overlapSec ?? 60;
  const since = opts.lastSuccessAt === 0 ? opts.nowSec - opts.intervalSec : opts.lastSuccessAt;
  const elapsedSec = Math.max(0, opts.nowSec - since);
  return {
    due: elapsedSec >= opts.intervalSec,
    elapsedSec,
    lookbackBlocks: BigInt(elapsedSec + overlap) * opts.blocksPerSec,
  };
}

export interface PonsDiscoveryDeps {
  client: PublicClient;
  /** Bounded by the caller from elapsed wall-clock — see MAX_LOOKBACK_BLOCKS. */
  lookbackBlocks: bigint;
  seen: ReadonlySet<string>;
  known: readonly StockToken[];
  /** USD price of native ETH, 8dp. Null when the worker could not price it. */
  ethUsd8: bigint | null;
  minDepthFraction?: number;
  /** Cap on launches evaluated in one pass — see PONS_MAX_EVALUATE. */
  maxEvaluate?: number;
}

/**
 * How many launches one pass will actually read reserves for.
 *
 * The filter costs one sequential eth_call per launch. A normal pass sees ~40,
 * which is nothing — but after an outage the lookback widens until it clamps at
 * ~8.4 hours, which is roughly 4,000 launches and therefore 4,000 sequential
 * calls against a public RPC that already returns 429s under far less. Bounded
 * so a catch-up pass cannot turn into a self-inflicted rate-limit, and the
 * shortfall is REPORTED rather than absorbed.
 *
 * The most RECENT launches are kept when the cap bites, because depth on this
 * launchpad arrives at birth and decays — an older launch is the less likely
 * of the two to still be worth anything.
 */
export const PONS_MAX_EVALUATE = 400;

/**
 * WHERE THE LAUNCHES WENT, per pass.
 *
 * Written because a measurement did not add up and nothing in the worker could
 * say why. On-chain, 9.6–17.6% of Pons launches are quoted in USDG; in the
 * class producer's candidate feed, USDG reached ~0.5%. Four stages sit between
 * those two numbers and every one of them was silent — the rolled-up
 * "N of M launches worth a look" line reports a ratio and discards the shape.
 *
 * These are COUNTS OF WHAT WAS DROPPED AND WHY, tallied at the drop itself
 * rather than reconstructed afterwards, plus the quote-asset mix on both sides
 * of the filter. If the mix going in matches the chain and the mix coming out
 * does not, the bias is in this function; if both match, it is downstream and
 * this file is exonerated. Either answer is worth more than another guess.
 *
 * No extra RPC: every field is already in hand at the point it is counted.
 */
export interface QuoteMix {
  usdg: number;
  native: number;
  other: number;
}

export interface PonsScanCensus {
  /** Launches the cap actually let through to the filter loop. */
  considered: number;
  /** Dropped before any read: already discovered, already watched, or a dupe. */
  dropSeen: number;
  /** getReserves() returned nothing — not a judgement, an unanswered question. */
  dropUnreadable: number;
  /** Already graduated, so its market has moved to a pool. */
  dropGraduated: number;
  /** Real, readable, and under the depth fraction. The intended filter. */
  dropShallow: number;
  /** Quote mix of everything considered, BEFORE any depth filtering. */
  quoteIn: QuoteMix;
  /** Quote mix of the survivors actually written. */
  quoteOut: QuoteMix;
  /** Survivor depth as % of graduation, so "deep enough" has a number. */
  depthPct: number[];
}

export interface PonsScanResult {
  found: Discovery[];
  /** Launches read this pass, before filtering — the denominator for the log. */
  scanned: number;
  /** The node refused the query. `found` is then empty but MEANINGLESS. */
  failed: boolean;
  /** The lookback was clamped; launches older than the clamp were not seen. */
  clamped: boolean;
  /** Launches inside the window that the per-pass cap left unevaluated. */
  skipped: number;
  /** Diagnostic only — never read by a decision. See PonsScanCensus. */
  census: PonsScanCensus;
}

/** Which of the three buckets a quote token falls in, for the census only. */
function bumpQuote(mix: QuoteMix, quoteToken: `0x${string}`): void {
  const q = quoteToken.toLowerCase();
  if (q === (CASH.USDG as string).toLowerCase()) mix.usdg += 1;
  else if (q === "0x0000000000000000000000000000000000000000" || q === (CASH.WETH as string).toLowerCase())
    mix.native += 1;
  else mix.other += 1;
}

/**
 * One pass over the Pons launchpad.
 *
 * WHY THIS IS NOT A VARIANT OF discoverPools. That function asks Bitquery for
 * pool Initialize events and prices what it finds through the Uniswap guards.
 * A Pons launch has neither: there is no pool, and the guards structurally
 * refuse a curve (`no-twap`, before they even look at depth). Sharing the code
 * path would mean either weakening those guards or pretending they ran.
 *
 * COST SHAPE, because this runs against ~475 launches/hour. The filter needs
 * only ONE call per launch — getReserves() — because the depth fraction is a
 * ratio of raw quote units and needs no decimals and no price. Symbol, decimals
 * and any USD figure are read only for the handful that survive.
 */
export async function discoverPonsLaunches(deps: PonsDiscoveryDeps): Promise<PonsScanResult> {
  const census: PonsScanCensus = {
    considered: 0,
    dropSeen: 0,
    dropUnreadable: 0,
    dropGraduated: 0,
    dropShallow: 0,
    quoteIn: { usdg: 0, native: 0, other: 0 },
    quoteOut: { usdg: 0, native: 0, other: 0 },
    depthPct: [],
  };
  const scan = await recentPonsLaunches(deps.client, deps.lookbackBlocks);
  // An empty census on the failed path, matching `found`: nothing was measured,
  // so every count is a real zero rather than a stand-in for an unread window.
  // The caller must not print it, and does not — it returns before the line.
  if (scan.failed) return { found: [], scanned: 0, failed: true, clamped: scan.clamped, skipped: 0, census };

  const knownAddrs = new Set(deps.known.map((t) => t.address.toLowerCase()));
  const minFraction = deps.minDepthFraction ?? PONS_MIN_DEPTH_FRACTION;
  const cap = deps.maxEvaluate ?? PONS_MAX_EVALUATE;
  // Newest first when the cap bites: depth arrives at birth and decays here.
  const considered = scan.launches.length > cap ? scan.launches.slice(-cap) : scan.launches;
  const skipped = scan.launches.length - considered.length;
  const seenThisPass = new Set<string>();
  const survivors: { launch: PonsLaunch; reserves: CurveReserves; fraction: number }[] = [];

  census.considered = considered.length;

  for (const launch of considered) {
    const key = launch.token.toLowerCase();
    if (deps.seen.has(key) || knownAddrs.has(key) || seenThisPass.has(key)) {
      census.dropSeen += 1;
      continue;
    }
    seenThisPass.add(key);
    // Counted AFTER the dedupe and before any read, so `quoteIn` is the mix of
    // launches this pass genuinely evaluated — comparable against the chain.
    bumpQuote(census.quoteIn, launch.quoteToken);

    // Decimals are placeholders here and that is exact, not sloppy: the depth
    // fraction is realQuote/threshold, both in the same raw units, so it is
    // independent of what those units are. Real decimals are read below, only
    // for what survives.
    const reserves = await readCurveReserves(deps.client, launch, { quote: 18, token: 18 });
    if (!reserves) {
      census.dropUnreadable += 1;
      continue;
    }
    // A graduated curve resets — token side emptied, quote side back to the
    // virtual seed — so it reads EXACTLY like a launch nobody bought. Announcing
    // one as a new launch would be announcing a token whose market has already
    // moved to a pool the ordinary discoverer handles.
    if (curveGraduated(reserves)) {
      census.dropGraduated += 1;
      continue;
    }
    const fraction = curveDepthFraction(reserves);
    if (fraction === null || fraction < minFraction) {
      census.dropShallow += 1;
      continue;
    }
    bumpQuote(census.quoteOut, launch.quoteToken);
    census.depthPct.push(Number((fraction * 100).toFixed(1)));
    survivors.push({ launch, reserves, fraction });
  }

  const found: Discovery[] = [];
  for (const { launch, reserves, fraction } of survivors) {
    // Identity from the CONTRACT, never from the log — same reasoning as
    // discoverPools: a symbol is attacker-chosen text headed for a human.
    let symbol = `${launch.token.slice(0, 10)}…`;
    let decimals = 18;
    try {
      const [s, d] = await Promise.all([
        deps.client.readContract({ address: launch.token, abi: ERC20, functionName: "symbol" }) as Promise<string>,
        deps.client.readContract({ address: launch.token, abi: ERC20, functionName: "decimals" }) as Promise<number>,
      ]);
      if (typeof s === "string" && s.length > 0) symbol = sanitizeSymbol(s);
      const dn = Number(d);
      if (Number.isInteger(dn) && dn >= 0 && dn <= 36) decimals = dn;
    } catch {
      /* not a readable ERC-20; it still launched, so report it by address */
    }

    const quoteUsd8 = quoteUsdOf(launch.quoteToken, deps.ethUsd8);
    let liquidityUsdg: bigint | null = null;
    let reason = quoteUsd8 === null ? "no USD price for what this curve is quoted in" : undefined;
    if (quoteUsd8 !== null) {
      const priced = curvePrice({ ...reserves, quoteDecimals: quoteDecimalsOfKnown(launch.quoteToken), tokenDecimals: decimals }, quoteUsd8);
      // 8dp → 6dp. Discovery.liquidityUsdg is raw USDG like every other depth
      // figure in the worker; handing it an 8dp number reports 100x the real
      // depth and would clear a $25,000 floor with $250.
      if (priced) liquidityUsdg = priced.depthUsd8 / 100n;
    }

    found.push({
      token: launch.token,
      symbol,
      decimals,
      createdAt: 0, // the store stamps first_seen, as it does for discoverPools
      liquidityUsdg,
      // NEVER true for a curve. `priceable` means the owner's depth and
      // divergence guards passed, and they cannot even run here — claiming it
      // would report a confidence nothing established.
      priceable: false,
      reason: reason ?? `trades on a Pons curve at ${(fraction * 100).toFixed(1)}% of graduation`,
      price8: null,
      // Null, not a number. FDV gates spending, and discoverPools only sets it
      // behind a PASSED guard for exactly that reason. A curve price is
      // unguarded by construction, so deriving a spending gate from it would
      // launder an unchecked number into a check.
      fdvUsd: null,
      curve: {
        curve: launch.curve,
        quoteToken: launch.quoteToken,
        graduationThresholdRaw: launch.graduationThresholdRaw,
        depthFraction: fraction,
      },
    });
  }

  return { found, scanned: scan.launches.length, failed: false, clamped: scan.clamped, skipped, census };
}

/**
 * USD price of a curve's quote asset, 8dp — or null when there isn't one.
 *
 * Only two quote assets are priceable with what this repo has. Native ETH goes
 * through the worker's own guarded WETH/USDG reading, and USDG is $1 by the
 * same hardcoded convention the pool pricer already uses.
 *
 * Everything else is null ON PURPOSE. The stock tokens that quote 42.8% of
 * launches have Chainlink feeds that are 24/5 and stale by this repo's own rule
 * every weekend, and cbBTC has no usable pool on this chain at all — its v3
 * pools hold dust and the guard already refuses them as "too-thin: $0", while
 * still computing a plausible-looking price off the tick. That plausible number
 * is the trap; null is the honest answer.
 */
export function quoteUsdOf(quoteToken: `0x${string}`, ethUsd8: bigint | null): bigint | null {
  const q = quoteToken.toLowerCase();
  if (q === "0x0000000000000000000000000000000000000000") return ethUsd8;
  if (q === (CASH.WETH as string).toLowerCase()) return ethUsd8;
  // Cash IS USDG here, so a whole unit is $1 — the same literal as
  // venues/pool-price.ts uses, kept identical so the two cannot drift.
  if (q === (CASH.USDG as string).toLowerCase()) return 100_000_000n;
  return null;
}

/** Decimals for the only quote assets `quoteUsdOf` will price. */
function quoteDecimalsOfKnown(quoteToken: `0x${string}`): number {
  return quoteToken.toLowerCase() === (CASH.USDG as string).toLowerCase() ? 6 : 18;
}

/**
 * A token's own symbol is attacker-chosen and ends up in a Telegram message and
 * an event line. Strip anything that could pass for markup or a separator, and
 * cap the length — the same reasoning as the memory sanitizers.
 */
export function sanitizeSymbol(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 16);
  return cleaned.length > 0 ? cleaned : "?";
}

/** The owner-facing line. Says what it is, and what it would still take to trade it. */
export function describeDiscovery(d: Discovery): string {
  const depth =
    d.liquidityUsdg === null
      ? "depth unknown"
      : `$${(Number(d.liquidityUsdg) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })} deep`;
  const fdv = d.fdvUsd === null ? "" : ` · FDV ${Math.round(d.fdvUsd).toLocaleString()}`;
  const verdict = d.priceable
    ? "deep enough for me to price"
    : `I can't price it yet — ${d.reason ?? "guards refused it"}`;
  // A launchpad token is a different KIND of sighting and says so. "new pair"
  // would be wrong twice over: there is no pair, and there is no pool — the
  // token trades only on its own curve until it graduates. The progress figure
  // replaces the depth figure because it is the one that is comparable across a
  // launchpad where half the curves are quoted in things we cannot price.
  if (d.curve) {
    const pct = `${(d.curve.depthFraction * 100).toFixed(1)}% to graduation`;
    return `🚀 pons launch: ${d.symbol} (${d.token.slice(0, 10)}…) · ${pct} · ${depth}${fdv} · no pool yet, trades on its curve`;
  }
  return `🌱 new pair: ${d.symbol} (${d.token.slice(0, 10)}…) · ${depth}${fdv} · ${verdict}`;
}

export { resolveBitquery };

/** GeckoTerminal's venue slug for a Pons curve that has GRADUATED to a pool. */
export const PONS_GRADUATED_DEX = "pons-v2-dex";
/** ...and for one still on its bonding curve. */
export const PONS_CURVE_DEX = "pons-v2";

/** A trending or graduated token, with the model's opinion attached. */
export interface TrendingFind {
  pool: GeckoPool;
  /** Read from the CONTRACT, never from the index's own label. */
  symbol: string;
  decimals: number;
  /** 1..5, advisory ordering only. Never a size and never a permission. */
  conviction: number;
  reason: string;
  /** This token graduated off a Pons curve rather than launching as a pool. */
  graduated: boolean;
}

export interface TrendingResult {
  /** Distinct pools seen across every feed, before any filtering. */
  scanned: number;
  /** How many cleared the numeric screen. */
  screened: number;
  picks: TrendingFind[];
  /** Answers from the scout that referred to nothing real — see memecoin-scout. */
  ignored: string[];
}

export interface TrendingDeps {
  client: PublicClient;
  seen: ReadonlySet<string>;
  known: readonly StockToken[];
  /** Injected so the pipeline can be tested without the network. */
  fetchPools: (feed: PoolFeed) => Promise<GeckoPool[]>;
  scout: MemecoinScout;
  limits: ScreenLimits;
  nowSec: number;
  /**
   * Look the shortlist up before ranking it. Optional: a deployment with no
   * browser configured still discovers, it just decides on numbers alone.
   */
  research?: (pools: readonly GeckoPool[]) => Promise<ReadonlyMap<string, CoinResearch>>;
}

/**
 * One pass over what is actually TRADING on this chain — trending, newly
 * listed, and the coins that have graduated off the launchpad.
 *
 * COMPLEMENTS the other two discoverers rather than replacing them. discoverPools
 * watches Uniswap Initialize events and discoverPonsLaunches watches the
 * launchpad, so both only ever see a token at the MOMENT IT IS BORN. A coin that
 * launched last week and is up 40% today is invisible to both by construction.
 * This is the one that sees it.
 *
 * A GRADUATED COIN IS A DIFFERENT ANIMAL and is labelled as such. Pons graduates
 * about 8.5 tokens an hour into a hooked Uniswap v4 pool, which is a real market
 * with real depth — the sampled ones carry six figures against the ~$4,100 a
 * fresh curve reports. The index distinguishes them by venue slug, which costs
 * nothing and is the only cheap source of their USD price and volume.
 *
 * WHAT THIS IS NOT, and the whole file is written around it: it does not add a
 * token, widen a cap, or produce a trade. Every name it surfaces still has to be
 * added in /settings and covered by a re-signed grant before the agent can touch
 * it — owner, then wall, then agent. A feed that could open a position by
 * itself would be a feed that decides what to buy.
 */
export async function discoverTrending(deps: TrendingDeps): Promise<TrendingResult> {
  const byToken = new Map<string, GeckoPool>();
  for (const feed of ["trending_pools", "new_pools", "pools"] as const) {
    for (const p of await deps.fetchPools(feed)) {
      // Deduped by TOKEN, not by pool: the same coin appears in several feeds
      // and often on several venues, and the owner cares about the coin.
      // Deepest wins, since that is the one a trade would actually reach.
      const prev = byToken.get(p.tokenAddress);
      if (!prev || (p.reserveUsd ?? 0) > (prev.reserveUsd ?? 0)) byToken.set(p.tokenAddress, p);
    }
  }
  const scanned = byToken.size;

  const knownAddrs = new Set(deps.known.map((t) => t.address.toLowerCase()));
  const fresh = [...byToken.values()].filter(
    (p) => !deps.seen.has(p.tokenAddress) && !knownAddrs.has(p.tokenAddress),
  );
  const { kept } = screenPools(fresh, deps.limits);

  // LOOK BEFORE RANKING. The screen decided what is worth looking at; this is
  // the looking. Its signals go INTO the list the model ranks rather than
  // beside it, so a site that never names its own contract is something the
  // model can weigh against the coin's volume — otherwise the browser is
  // expensive theatre.
  const researched = deps.research ? await deps.research(kept).catch(() => undefined) : undefined;

  // The model NARROWS what the screen admitted. It never widens it, and it
  // never sees an address — see strategist/memecoin-scout.ts.
  const ranked = await deps.scout.rank(
    kept,
    deps.nowSec,
    researched && new Map([...researched].map(([k, r]) => [k, scoutFieldsFor(r)])),
  );

  const picks: TrendingFind[] = [];
  for (const pick of ranked.picks) {
    // Identity from the CONTRACT. GeckoTerminal's `name` is attacker-chosen
    // text that would be shown to a human and could be picked to impersonate a
    // real ticker — the same reasoning discoverPools already applies.
    let symbol = `${pick.pool.tokenAddress.slice(0, 10)}…`;
    let decimals = 18;
    try {
      const [s, d] = await Promise.all([
        deps.client.readContract({ address: pick.pool.tokenAddress, abi: ERC20, functionName: "symbol" }) as Promise<string>,
        deps.client.readContract({ address: pick.pool.tokenAddress, abi: ERC20, functionName: "decimals" }) as Promise<number>,
      ]);
      if (typeof s === "string" && s.length > 0) symbol = sanitizeSymbol(s);
      const dn = Number(d);
      if (Number.isInteger(dn) && dn >= 0 && dn <= 36) decimals = dn;
    } catch {
      /* not a readable ERC-20; it still trades, so report it by address */
    }
    picks.push({
      pool: pick.pool,
      symbol,
      decimals,
      conviction: pick.conviction,
      reason: pick.reason,
      graduated: pick.pool.dex === PONS_GRADUATED_DEX,
    });
  }

  return { scanned, screened: kept.length, picks, ignored: ranked.ignored };
}

/**
 * The owner-facing line for a trending find.
 *
 * Says which KIND of thing it is, because the three read very differently: a
 * graduated coin has a real pool behind it, a coin still on its curve mostly
 * has a virtual seed, and an ordinary pool token is neither.
 */
export function describeTrending(f: TrendingFind): string {
  const depth =
    f.pool.reserveUsd === null
      ? "depth unknown"
      : `$${Math.round(f.pool.reserveUsd).toLocaleString()} deep`;
  const move =
    f.pool.change24hPct === null ? "" : ` · ${f.pool.change24hPct > 0 ? "+" : ""}${f.pool.change24hPct.toFixed(1)}% 24h`;
  const kind = f.graduated ? "graduated" : f.pool.dex === PONS_CURVE_DEX ? "still on its curve" : "trading";
  return `📈 ${f.symbol} (${f.pool.tokenAddress.slice(0, 10)}…) · ${kind} · ${depth}${move} · ${f.reason || `conviction ${f.conviction}/5`}`;
}
