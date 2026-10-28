import type { BrainDecision, BrainResult } from "./brain-client";
import { orderFromDecision } from "./brain-live";
import type { ShadowInputs, ShadowOutcome } from "./brain-shadow";
import { DEFAULT_TRIGGERS, pctMove } from "./brain-trigger";
import type { GeckoFetch, GeckoPool } from "./venues/geckoterminal";
import { fetchGeckoPoolsResult, readTokenPoolsResult } from "./venues/geckoterminal";
import { NOMINATE, safeNotes } from "./trencher-nominate";
import { newProjectAge, type DiscoveryFocus } from "./discovery-focus";
import { EARLY_PAGES_MAX, EARLY_VENUE, earlyScreenReason, type EarlyScreen } from "./early-candidates";
import { CASH, instrumentClassOf } from "../../packages/core/src/index";
import { TRENCHER_FAST } from "./strategies/trencher";

/** The fast Trencher's entry, in whole USD, as the Brain is told it. */
const ENTRY_USD = Number(TRENCHER_FAST.perEntryUsdg) / 1e6;

export const TRENCH_VOLUME_MIN = 100_000;
/**
 * A coin may clear the volume screen on its LAST HOUR instead — $25k an hour is
 * a $600k day's pace. A coin a few hours old has not had a day to reach the 24h
 * floor, and that is exactly the coin a trencher is for. Only the volume rule
 * reads this; the buyer, two-sided-flow and live-tape rules are unchanged, and
 * the depth floor and entry checks still run after the screen.
 */
export const TRENCH_H1_VOLUME_MIN = 25_000;
export const TRENCH_TAPE_MAX_AGE_MS = 120_000;
/** Tape pages kept for nominated coins, at most — the nomination book's own queue bound. */
export const NOMINATED_PAGES_MAX = NOMINATE.queueMax;
const NOMINATED_PREFIX = "nominated:";
const EARLY_PREFIX = "early:";

/** Safe diagnostic codes only; never provider bodies or credential-bearing URLs. */
const pageFailure = (failure: string | undefined) =>
  /^(http-\d{3}|timeout|network|invalid-body|invalid-shape|cache-unavailable|provider-cooldown|request-budget|plan-restricted)$/.test(failure ?? "") ? failure! : "unavailable";
/**
 * A HELD POSITION MAY NOT GO LONGER THAN THIS WITHOUT A REVIEW.
 *
 * The floor that lets an entry candidate share the review slots at all. Exits
 * do not depend on it — they run mechanically off the trading tick — so this
 * governs how stale the Brain's OPINION of a holding may get, not how long a
 * losing position can sit.
 */
export const HELD_REVIEW_MAX_GAP_MS = 5 * 60_000;

export const TRENCH_REVIEW_INTERVAL_MS = 30_000;
/**
 * A priority (nominated) coin is preferred only this long after the last
 * review launched for ANY nominated coin, and after its own last review: two
 * review intervals, so nominations together hold at most every other slot and
 * the rotation keeps the rest. See `TrenchBrainReview.candidate`.
 */
export const PRIORITY_RETRY_MS = 2 * TRENCH_REVIEW_INTERVAL_MS;

/** One pool's identity on the tape: token, venue and pool. */
const tapeKey = (p: Pick<GeckoPool, "tokenAddress" | "dex" | "poolAddress" | "poolId">) =>
  `${p.tokenAddress}:${p.dex}:${p.poolAddress ?? p.poolId}`.toLowerCase();

/**
 * A tape row older than this is STALE for an entry review: past one tape
 * refresh (index.ts refreshTrenchTape asks every 60s), so the latest refresh
 * brought nothing newer for this pool. Inside TRENCH_TAPE_MAX_AGE_MS on
 * purpose — it never removes a pool from the tape; it only decides whether
 * a review with no candles and no trades is worth paying for.
 */
export const TRENCH_EVIDENCE_STALE_MS = 60_000;

/**
 * NOTHING CURRENT TO JUDGE AN ENTRY ON: both evidence legs failed (or the read
 * never settled) AND the coin's tape row is stale or gone. A paid entry review
 * in that state is the Brain reading a minute-old summary with no flow behind
 * it, which can only come back HOLD. Either leg landing, or a current tape
 * row, and the review runs as before. Held positions never ask this.
 */
export function entryEvidenceBlind(
  evidence: { candles: { failed: boolean }; trades: { failed: boolean } } | null,
  tapeObservedAt: number | null,
  now: number,
): boolean {
  const legsFailed = !evidence || (evidence.candles.failed && evidence.trades.failed);
  const stale = tapeObservedAt === null || !Number.isFinite(tapeObservedAt) || now - tapeObservedAt > TRENCH_EVIDENCE_STALE_MS;
  return legsFailed && stale;
}

/**
 * CAN THIS ENTRY REVIEW STILL BE SKIPPED AS BLIND within `withinMs` of `now`?
 * Not when its tape row will still be current then (TRENCH_EVIDENCE_STALE_MS):
 * entryEvidenceBlind needs a stale row, whatever the legs do. A paid extra
 * read (the indexer's flow) is started beside the legs only when this says
 * no; otherwise it waits for the blind check, so nothing is spent on a
 * review that is then not paid for.
 */
export function entryMayGoBlind(tapeObservedAt: number | null, now: number, withinMs: number): boolean {
  if (tapeObservedAt === null || !Number.isFinite(tapeObservedAt)) return true;
  return now + Math.max(0, withinMs) - tapeObservedAt > TRENCH_EVIDENCE_STALE_MS;
}

/** Keep each page on its own clock: partial outages must not erase fresh pages
 * or renew the age of old observations. Healthy empty pages replace old data. */
export class TrenchTapeReader {
  private discoveryFocus: DiscoveryFocus = "balanced";
  setDiscoveryFocus(focus: DiscoveryFocus): void {
    this.discoveryFocus = focus;
    if (focus !== "new-projects") this.pages.delete("new_pools:2");
  }
  private pages = new Map<string, { pools: GeckoPool[]; at: number }>();
  /** Lowercased addresses whose own token page rides on the tape. See setNominated. */
  private nominated = new Set<string>();
  /** Lowercased early-candidate addresses (early-candidates.ts). See setEarly. */
  private early = new Set<string>();
  constructor(
    private fetchPage = fetchGeckoPoolsResult,
    private now = Date.now,
    private fetchToken: (address: string) => Promise<GeckoFetch> = readTokenPoolsResult,
  ) {}

  /**
   * THE COINS SOMEBODY NOMINATED GET A PAGE OF THEIR OWN — and nothing more.
   *
   * A coin posted in a Telegram group (docs/tg-groups.md) is usually not on
   * the trending or top-pools lists, so without its own page it could never
   * reach the tape and the nomination would have nothing to wait for. The
   * page is its GeckoTerminal token-pools read, stored under
   * `nominated:<address>` beside the feed pages and treated exactly like them:
   * the same 120s freshness, the same newest-observation dedupe, and the same
   * `highVolumePools` screen in `snapshot()`. So a nomination decides which
   * page is READ, never what passes — a quiet coin on its own page is dropped
   * by the same screen that drops a quiet coin on the trending list.
   *
   * REPLACES THE SET, so a nomination that resolved loses its page now rather
   * than lingering for its freshness window, and a reader of the tape never
   * sees a coin kept alive by a chat that has moved on. Bounded by the book's
   * own queue: an address beyond it is not read at all.
   */
  setNominated(addresses: Iterable<string>): void {
    const next = new Set<string>();
    for (const a of addresses) {
      const key = typeof a === "string" ? a.toLowerCase() : "";
      if (!/^0x[0-9a-f]{40}$/.test(key) || next.has(key)) continue;
      if (next.size >= NOMINATED_PAGES_MAX) break;
      next.add(key);
    }
    for (const key of [...this.pages.keys()]) {
      if (key.startsWith(NOMINATED_PREFIX) && !next.has(key.slice(NOMINATED_PREFIX.length))) this.pages.delete(key);
    }
    this.nominated = next;
  }

  /**
   * Read only the nominated pages — what a fresh nomination asks for, so its
   * coin does not wait for the next full tape refresh (up to a minute). Costs
   * one request per nominated coin and none for the six feed pages.
   */
  async refreshNominated(): Promise<string[]> {
    const failures: string[] = [];
    await Promise.all([...this.nominated].map(address => this.readNominated(address, failures)));
    return failures;
  }

  private async readNominated(address: string, failures: string[]): Promise<void> {
    const key = `${NOMINATED_PREFIX}${address}`;
    // The failure names the KIND of page, never the address: these lines are
    // logged, and a coin somebody posted in a group is not log material.
    try {
      const r = await this.fetchToken(address);
      if (r.failed) { failures.push(`nominated=${pageFailure(r.failure)}`); return; }
      // Resolved while the read was in flight: the page must not come back.
      if (!this.nominated.has(address)) return;
      // Only the nominated coin's own pools, whatever the page carried.
      this.pages.set(key, { pools: r.pools.filter(p => p.tokenAddress.toLowerCase() === address), at: r.observedAt ?? this.now() });
    } catch { failures.push("nominated=unavailable"); }
  }

  /**
   * EARLY CANDIDATES GET A PAGE OF THEIR OWN TOO — separate from nominations,
   * bounded by the early book's own size (EARLY_PAGES_MAX), and screened
   * DIFFERENTLY: `snapshot()` adds an early coin's pools that pass
   * `earlyScreenReason` (early-candidates.ts) even when `highVolumePools` would
   * drop them. That screen is for these coins only. The regular tape, every
   * non-early coin on it, and `highVolumePools` itself are unchanged.
   *
   * Same page discipline as setNominated: REPLACES THE SET, a coin that left
   * the book loses its page now, and an address beyond the bound is not read.
   * A coin that is also nominated is not read twice: its nominated page
   * carries the same pools.
   */
  setEarly(addresses: Iterable<string>): void {
    const next = new Set<string>();
    for (const a of addresses) {
      const key = typeof a === "string" ? a.toLowerCase() : "";
      if (!/^0x[0-9a-f]{40}$/.test(key) || next.has(key)) continue;
      if (next.size >= EARLY_PAGES_MAX) break;
      next.add(key);
    }
    for (const key of [...this.pages.keys()]) {
      if (key.startsWith(EARLY_PREFIX) && !next.has(key.slice(EARLY_PREFIX.length))) this.pages.delete(key);
    }
    this.early = next;
  }

  /**
   * The coins whose own early page is ON THE TAPE NOW: what setEarly last
   * kept, whatever the book or the verification asks say this instant. A
   * caller that keeps those pages off the regular list asks this, so a coin
   * that left the asks a moment ago cannot slip on while its page remains.
   */
  earlyPageAddresses(): Set<string> {
    return new Set([...this.pages.keys()].filter((k) => k.startsWith(EARLY_PREFIX)).map((k) => k.slice(EARLY_PREFIX.length)));
  }

  /** Read only the early pages — what a fresh offer asks for. One request per coin, none for the feeds. */
  async refreshEarly(): Promise<string[]> {
    const failures: string[] = [];
    await Promise.all(this.earlyToRead().map(address => this.readEarly(address, failures)));
    return failures;
  }

  private earlyToRead(): string[] {
    return [...this.early].filter(a => !this.nominated.has(a));
  }

  private async readEarly(address: string, failures: string[]): Promise<void> {
    const key = `${EARLY_PREFIX}${address}`;
    // The kind of page, never the address: these lines are logged.
    try {
      const r = await this.fetchToken(address);
      if (r.failed) { failures.push(`early=${pageFailure(r.failure)}`); return; }
      // Left the book while the read was in flight: the page must not come back.
      if (!this.early.has(address)) return;
      this.pages.set(key, { pools: r.pools.filter(p => p.tokenAddress.toLowerCase() === address), at: r.observedAt ?? this.now() });
    } catch { failures.push("early=unavailable"); }
  }

  private fresh() {
    const pages = [...this.pages.values()].filter(p => this.now() - p.at <= TRENCH_TAPE_MAX_AGE_MS);
    // Prefer the newest observation of a pool across overlapping feeds.
    const unique = new Map<string, GeckoPool>();
    for (const page of pages.sort((a, b) => b.at - a.at)) {
      for (const p of page.pools) {
        const key = tapeKey(p);
        if (!unique.has(key)) unique.set(key, p);
      }
    }
    return { pools: [...unique.values()], pages };
  }

  /**
   * WHEN THIS POOL WAS LAST OBSERVED, ms: the newest fresh page carrying it —
   * the same observation `snapshot()` keeps — or null when none does. Per
   * pool, unlike the snapshot's `observedAt`, which is its oldest page's.
   */
  observedAtOf(pool: Pick<GeckoPool, "tokenAddress" | "dex" | "poolAddress" | "poolId">): number | null {
    const key = tapeKey(pool);
    for (const page of this.fresh().pages) if (page.pools.some(p => tapeKey(p) === key)) return page.at;
    return null;
  }

  /**
   * `pools` is `highVolumePools(fresh, true)` — exactly what it always was —
   * followed by `early`: an early candidate's pools that pass the early
   * screen and are not already in that list. With no early candidates the two
   * are identical to the old snapshot.
   */
  snapshot() {
    const { pools, pages } = this.fresh();
    const regular = highVolumePools(pools, true);
    const early = this.earlyPasses(pools, regular);
    return { pools: early.length ? [...regular, ...early] : regular, early,
      observedAt: pages.length ? Math.min(...pages.map(p => p.at)) : 0 };
  }

  private earlyPasses(pools: readonly GeckoPool[], regular: readonly GeckoPool[]): GeckoPool[] {
    if (this.early.size === 0) return [];
    const key = (p: GeckoPool) => `${p.tokenAddress.toLowerCase()}:${p.dex}:${p.poolAddress?.toLowerCase() ?? p.poolId}`;
    const have = new Set(regular.map(key));
    const volume = (p: GeckoPool) => (typeof p.volume24hUsd === "number" && Number.isFinite(p.volume24hUsd) ? p.volume24hUsd : -1);
    return pools
      .filter(p => this.early.has(p.tokenAddress.toLowerCase()) && !have.has(key(p)) && earlyScreenReason(p) === null)
      .sort((a, b) => volume(b) - volume(a));
  }

  /**
   * THE COINS THE SCREEN DROPPED, and the first rule each failed — read only
   * by the decision funnel (decision-funnel.ts), so "why was that coin never
   * looked at?" has an answer that is not "it was not in the log".
   *
   * Per TOKEN, not per pool: a coin with one passing pool was not screened
   * out, whatever its other pools look like. The reason given is the busiest
   * failing pool's. Same fresh pages and same rules as `snapshot()`, so this
   * can never disagree with what was actually offered.
   */
  screenedOut(): { tokenAddress: string; reason: TrenchScreen }[] {
    const passed = new Set<string>();
    const failed = new Map<string, { reason: TrenchScreen; volume: number }>();
    for (const p of this.fresh().pools) {
      const token = p.tokenAddress.toLowerCase();
      // An early candidate is answered by its own screen: earlyScreenedOut.
      if (this.early.has(token)) continue;
      const reason = trenchScreenReason(p);
      if (reason === null) { passed.add(token); continue; }
      const volume = typeof p.volume24hUsd === "number" && Number.isFinite(p.volume24hUsd) ? p.volume24hUsd : -1;
      const prior = failed.get(token);
      if (!prior || volume > prior.volume) failed.set(token, { reason, volume });
    }
    return [...failed].filter(([token]) => !passed.has(token)).map(([tokenAddress, f]) => ({ tokenAddress, reason: f.reason }));
  }

  /**
   * THE EARLY CANDIDATES THE EARLY SCREEN DROPPED, and the first rule each
   * failed — for the decision funnel's `early-screen:<reason>`. A coin with
   * ANY pool passing either screen is not listed (it is on the snapshot). The
   * reason is the busiest failing pool's on the supported venue, or, with no
   * pool there at all, `venue-not-supported`. A coin with no pools on the
   * fresh tape is not listed: nothing was observed to screen.
   */
  earlyScreenedOut(): { tokenAddress: string; reason: EarlyScreen }[] {
    if (this.early.size === 0) return [];
    const passed = new Set<string>();
    const failed = new Map<string, { reason: EarlyScreen; onVenue: boolean; volume: number }>();
    for (const p of this.fresh().pools) {
      const token = p.tokenAddress.toLowerCase();
      if (!this.early.has(token)) continue;
      const reason = earlyScreenReason(p);
      if (reason === null || trenchScreenReason(p) === null) { passed.add(token); continue; }
      const onVenue = p.dex === EARLY_VENUE;
      const volume = typeof p.volume24hUsd === "number" && Number.isFinite(p.volume24hUsd) ? p.volume24hUsd : -1;
      const prior = failed.get(token);
      if (!prior || (onVenue && !prior.onVenue) || (onVenue === prior.onVenue && volume > prior.volume)) failed.set(token, { reason, onVenue, volume });
    }
    return [...failed].filter(([token]) => !passed.has(token)).map(([tokenAddress, f]) => ({ tokenAddress, reason: f.reason }));
  }

  async refresh() {
    const failures: string[] = [];
    const providers = new Set<"coingecko-pro" | "geckoterminal-public">();
    const primaryFailures = new Set<string>();
    await Promise.all([
      ...[1, 2, 3].flatMap(page =>
        // NEW POOLS TOO: the list a coin is on before it trends. Page one only,
        // shared fleet-wide by the feed cache like every other page.
        ([...(["trending_pools", "pools"] as const), ...(page === 1 || (page === 2 && this.discoveryFocus === "new-projects") ? (["new_pools"] as const) : [])]).map(async feed => {
          const key = `${feed}:${page}`;
          try {
            const r = await this.fetchPage(feed, { page });
            if (!r.failed && (r.provider === "coingecko-pro" || r.provider === "geckoterminal-public")) providers.add(r.provider);
            if (r.primaryFailure) primaryFailures.add(pageFailure(r.primaryFailure));
            if (r.failed) failures.push(`${key}=${pageFailure(r.failure)}`);
            else if (key !== "new_pools:2" || this.discoveryFocus === "new-projects") this.pages.set(key, { pools: r.pools, at: r.observedAt ?? this.now() });
          } catch { failures.push(`${key}=unavailable`); }
        })),
      // Refreshed WITH the tape, on the tape's clock: a nominated page is
      // never older than the feed pages it is read beside.
      ...[...this.nominated].map(address => this.readNominated(address, failures)),
      // Early pages ride the same clock, for the same reason.
      ...this.earlyToRead().map(address => this.readEarly(address, failures)),
    ]);
    return { ...this.snapshot(), failures, providers: [...providers].sort(), primaryFailures: [...primaryFailures].sort() };
  }
}

/** Measured tape, with explicit units and windows; never substitute missing data with zero. */
export function trenchBrainSignals(p: GeckoPool, observedAtMs: number, depthUsd: number | null) {
  const common = { source: "GeckoTerminal indexed pool tape", observedAt: Math.floor(observedAtMs / 1000), poolAddress: p.poolAddress, units: "USD amounts; percent price changes; transaction/address counts" };
  const windows = Object.fromEntries((["m5", "h1", "h6", "h24"] as const).map(w => [w, p.buckets[w]]));
  const depth = depthUsd !== null && Number.isFinite(depthUsd) && depthUsd >= 0 ? depthUsd : null;
  return {
    technical: JSON.stringify({ ...common, windows, volume24hUsd: p.volume24hUsd, change1hPct: p.change1hPct, change24hPct: p.change24hPct }),
    social: JSON.stringify({ ...common, evidenceType: "Observed trading activity, not social-media sentiment or independent opinions", windows, distinctBuyers24h: p.buyers24h, buys24h: p.buys24h, sells24h: p.sells24h }),
    liquidity: JSON.stringify({ ...common, indexedReserveUsd: p.reserveUsd, onchainRouteDepthUsd: depth, fdvUsd: p.fdvUsd,
      maxEntryUsd: ENTRY_USD, maxEntryAsPercentOfRouteDepth: depth !== null && depth > 0 ? ENTRY_USD * 100 / depth : null,
      interpretation: "Reserve and route depth are USD, not token quantities. Entry/depth is a scale comparison, not a slippage quote. Null means unknown, not zero. FDV is valuation, not available liquidity." }),
  };
}

/** Seven bounded requests per refresh; a failed page cannot erase healthy pages. */
export async function fetchTrenchTape(fetchPage = fetchGeckoPoolsResult): Promise<GeckoPool[]> {
  const results = await Promise.allSettled([
    ...[1, 2, 3].flatMap(page => (["trending_pools", "pools"] as const).map(feed => fetchPage(feed, { page }))),
    fetchPage("new_pools", { page: 1 }),
  ]);
  const healthy = results.flatMap(r => r.status === "fulfilled" && !r.value.failed ? [r.value] : []);
  if (!healthy.length) throw new Error("All Trencher discovery pages failed");
  return highVolumePools(healthy.flatMap(r => r.pools), true);
}

/** The first rule of the tape screen a pool failed. See `trenchScreenReason`. */
export type TrenchScreen =
  | "quote-asset" | "not-memecoin" | "volume-unknown" | "volume-below-min"
  | "buyers-below-min" | "no-buys-24h" | "no-sells-24h" | "no-m5-volume";

/**
 * THE TAPE SCREEN, NAMED. `highVolumePools` asks this and nothing else, so the
 * reason the decision funnel reports is the rule that actually applied rather
 * than a second reading of it that could drift. Same order, same comparisons:
 * a missing count still fails as it always did (`?? 0`), and is only NAMED
 * here — it is not a new rule and it does not move a threshold.
 */
export function trenchScreenReason(p: GeckoPool): TrenchScreen | null {
  // Quote assets are portfolio cash/bridge assets, never speculative entries.
  // instrumentClassOf deliberately classifies unknown addresses as memecoins.
  if ([CASH.USDG, CASH.WETH].some(a => a.toLowerCase() === p.tokenAddress.toLowerCase())) return "quote-asset";
  if (instrumentClassOf(p.tokenAddress) !== "memecoin") return "not-memecoin";
  if (!Number.isFinite(p.volume24hUsd)) return "volume-unknown";
  if ((p.volume24hUsd ?? 0) < TRENCH_VOLUME_MIN && (p.buckets.h1?.volumeUsd ?? 0) < TRENCH_H1_VOLUME_MIN) return "volume-below-min";
  if ((p.buyers24h ?? 0) < 20) return "buyers-below-min";
  if ((p.buys24h ?? 0) <= 0) return "no-buys-24h";
  if ((p.sells24h ?? 0) <= 0) return "no-sells-24h";
  if ((p.buckets.m5?.volumeUsd ?? 0) <= 0) return "no-m5-volume";
  return null;
}

/**
 * HOW HOT A POOL IS RIGHT NOW: its last hour's volume, weighted up to double by
 * how far its price moved in that hour, either way.
 *
 * This replaced 24h volume as the ranking, because 24h volume ranks a coin by
 * yesterday. The fast Trencher holds for minutes, and the busiest-by-day list
 * put the same established coins at the top of every pass, so it reviewed —
 * and bought — the same four all day. A coin that is busy and moving now ranks
 * first. Direction is the Brain's call, so a fall heats a coin as much as a
 * rise. Ranking only: nothing here admits a coin the screen refused.
 *
 * A pool that reports no hourly figure is ranked off its daily one spread
 * evenly, never off zero: unknown is not quiet.
 */
export function trenchHeat(p: GeckoPool): number {
  const h1 = p.buckets.h1;
  const volume = typeof h1?.volumeUsd === "number" && Number.isFinite(h1.volumeUsd) ? h1.volumeUsd
    : typeof p.volume24hUsd === "number" && Number.isFinite(p.volume24hUsd) ? p.volume24hUsd / 24 : 0;
  const move = h1?.changePct ?? p.change1hPct;
  const moved = typeof move === "number" && Number.isFinite(move) ? Math.min(Math.abs(move), 100) / 100 : 0;
  return volume * (1 + moved);
}

/**
 * The screened tape, hottest first (trenchHeat). Within one token the pool kept
 * is still its busiest by day — the main market, not the jumpiest. On-chain
 * depth and wallet policy still gate trades.
 */
export function highVolumePools(pools: readonly GeckoPool[], perPool = false): GeckoPool[] {
  const byToken = new Map<string, GeckoPool>();
  for (const p of pools) {
    if (trenchScreenReason(p) !== null) continue;
    const key = perPool
      ? `${p.tokenAddress.toLowerCase()}:${p.dex}:${p.poolAddress?.toLowerCase() ?? p.poolId}`
      : p.tokenAddress.toLowerCase();
    if ((byToken.get(key)?.volume24hUsd ?? -1) < p.volume24hUsd!) byToken.set(key, p);
  }
  return [...byToken.values()].sort((a, b) => trenchHeat(b) - trenchHeat(a) || b.volume24hUsd! - a.volume24hUsd!);
}

export type TrenchBrainOrder = { side: "buy" | "sell"; usdgAmount: number; decisionId: string };

export function trenchBrainPersona(symbol: string, held: boolean): string {
  return `Trencher: short-horizon memecoin trading. Evaluate real volume, two-sided flow, liquidity, costs and reversal risk. Maximum new entry is ${ENTRY_USD} USDG, also bounded by the owner's limits. ` +
    "The entry cap is a sizing ceiling, not evidence of poor liquidity or absent edge. Assess expected percentage return and dollar costs separately: a small entry can still have positive or negative net edge. Do not reject solely because the cap is small; do not invent an expected return to justify entry. " +
    "Judge the current short-window setup using the measured 5-minute and 1-hour price and flow data, with 6-hour and 24-hour data as context. A negative daily return alone is neither a veto nor a buy signal. An external news catalyst or technical crossover is not mandatory, especially when no such data was supplied. Explain which observed evidence supports the decision and what remains unknown. " +
    "Hold if evidence or net edge is insufficient. Never invent activity or prices. " +
    // ── BOTH BRANCHES NAME THE ACTION THEY CANNOT TAKE ──────────────────
    //
    // The entry branch has always closed its door: a bearish view cannot
    // become a short, so it says so. The position branch named holding and
    // selling and left BUY unmentioned, and the model reasonably took it —
    // Shogun answered BUY twice for a coin it already held (2026-09-21),
    // and trencher.ts:461 drops a held symbol from the entry loop, so both
    // were published as buys that no trade came of. An action the venue
    // path cannot execute must be refused in the prompt, by name and with
    // its reason, or it gets decided and counted as a failure to execute.
    (held ? `You hold ${symbol}. This is a position review: choose HOLD or SELL. Adding to an existing position is not supported, so a bullish view means HOLD, not BUY.`
      : `You hold zero ${symbol}. This is an entry review: choose BUY or HOLD. A bearish view means HOLD, not SELL; short selling is not supported.`);
}
type Ready = { decision: BrainDecision; input: ShadowInputs; token: string; context: string; started: number };

/**
 * WHAT A HOLD IS MEASURED AGAINST: the coin's quote and its tape when the
 * Brain looked, and again now. Null is unknown, never zero — and an unknown
 * on either side can never be what releases a backoff or prints a change.
 */
export interface TrenchMaterial {
  /** The tick's own quote for the coin, USD — the price the Brain was handed. */
  priceUsd: number | null;
  /** The pool's last-hour volume, USD (the tape's h1 bucket). */
  h1VolumeUsd: number | null;
  /** Distinct buyers in the pool's last five minutes (the tape's m5 bucket). */
  m5Buyers: number | null;
}

const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A coin's material from its tape row and its quote. Either may be missing; neither is defaulted. */
export function trenchMaterial(p: GeckoPool | null | undefined, priceUsd: number | null): TrenchMaterial {
  const price = finiteOrNull(priceUsd);
  return {
    priceUsd: price !== null && price > 0 ? price : null,
    h1VolumeUsd: finiteOrNull(p?.buckets?.h1?.volumeUsd),
    m5Buyers: finiteOrNull(p?.buckets?.m5?.buyers),
  };
}

/**
 * HOW LONG A COIN THE BRAIN JUST HELD WAITS BEFORE IT IS ASKED AGAIN.
 *
 * The rotation had no per-coin memory: the same five eligible coins were
 * re-reviewed every few minutes with near-identical tape, and produced
 * near-identical holds, each one paid for. A hold now backs its coin off
 * for `baseMs`, doubling with every consecutive hold up to `maxMs`, unless
 * something MATERIAL moved since the review — the thresholds below. Judgment
 * calls, named so they can be argued with. Review ORDER only: nothing here
 * admits a coin, sizes a trade or touches a held position.
 */
export const HOLD_BACKOFF = {
  /** The first hold's backoff. Each consecutive hold doubles it: 5, 10, 20, 40, then 60 minutes. */
  baseMs: 5 * 60_000,
  maxMs: 60 * 60_000,
  /** A move this large either way since the review releases it — the Brain trigger's own threshold (brain-trigger.ts). */
  priceMove: DEFAULT_TRIGGERS.priceMovePct,
  /** Last-hour volume up by at least this fraction of what the review saw. */
  h1VolumeRise: 0.5,
  /** Five-minute distinct buyers up by at least this many AND at least this multiple. Both, so 1→2 is not a jump. */
  m5BuyersRise: 3,
  m5BuyersRatio: 1.5,
  /** A hold older than this is forgotten: its run of consecutive holds and its memory line. */
  memoryMs: 3 * 60 * 60_000,
  /** Coins remembered at once; the oldest is forgotten first. */
  maxCoins: 256,
} as const;

/**
 * Why a backoff should end early, or null when nothing material changed.
 * PURE. Unknown on either side of a comparison is no change.
 */
export function materialChange(seen: TrenchMaterial | null, now: TrenchMaterial | null): "price" | "volume" | "buyers" | null {
  if (!seen || !now) return null;
  // A hair of slack so an exact 3.0% is not lost to floating point.
  if (seen.priceUsd !== null && now.priceUsd !== null && pctMove(now.priceUsd, seen.priceUsd) >= HOLD_BACKOFF.priceMove - 1e-9) return "price";
  if (seen.h1VolumeUsd !== null && now.h1VolumeUsd !== null && seen.h1VolumeUsd > 0 &&
      now.h1VolumeUsd >= seen.h1VolumeUsd * (1 + HOLD_BACKOFF.h1VolumeRise)) return "volume";
  if (seen.m5Buyers !== null && now.m5Buyers !== null &&
      now.m5Buyers - seen.m5Buyers >= HOLD_BACKOFF.m5BuyersRise && now.m5Buyers >= seen.m5Buyers * HOLD_BACKOFF.m5BuyersRatio) return "buyers";
  return null;
}

/**
 * A HOLD THE MODEL CHOSE about this coin — exactly what the decision funnel
 * files as MODEL_HOLD (decision-funnel.ts classifyReview, pinned against it
 * in a test). A gate-forced hold is about the book, not the coin, and a hold
 * on a stale mark is about a missing price; neither says the coin was looked
 * at and passed on, so neither backs it off.
 */
export function isModelHold(d: Pick<BrainDecision, "action" | "hold_kind" | "gate_verdict">, priceStale: boolean): boolean {
  if (String(d.action ?? "").toLowerCase() !== "hold") return false;
  if (priceStale && d.hold_kind !== "GATE_FORCED_HOLD") return false;
  if (d.hold_kind === "MODEL_HOLD") return true;
  return (d.hold_kind === undefined || d.hold_kind === null) && d.gate_verdict === "proceed";
}

/** Characters of a hold's reason the memory line repeats. */
const HOLD_REASON_MAX = 120;

/**
 * THE SHORT REASON A HOLD GAVE, through the same filter a Telegram group's
 * "passed" note goes through (trencher-nominate.ts safeNotes): bear case and
 * risks first, the thesis only when they left nothing, and any clause with a
 * figure, an address or a link dropped whole. Null when nothing survives.
 */
export function holdReason(d: Pick<BrainDecision, "bear_case" | "risks" | "thesis">): string | null {
  let notes = safeNotes([d.bear_case, ...(Array.isArray(d.risks) ? d.risks : [])], HOLD_REASON_MAX);
  if (notes.length === 0) notes = safeNotes([d.thesis], HOLD_REASON_MAX);
  return notes.length ? notes.join("; ") : null;
}

interface HoldRecord {
  /** When the last held review launched (or the record began, for a skip), ms. */
  at: number;
  /** Consecutive model holds. 0 for a record an evidence skip made on its own. */
  holds: number;
  /** The backoff ends here, ms; 0 once released. */
  until: number;
  /** What the held review saw — the memory line's "since then". */
  seen: TrenchMaterial | null;
  /** What a release is measured against: the review's view, or what a later skip saw. */
  baseline: TrenchMaterial | null;
  reason: string | null;
  /** An evidence skip of this coin has been said up to here, ms. */
  skipSaidUntil: number;
  /** What set the backoff now running: a model hold, or an evidence window that outlasts it. */
  cause: BackoffCause;
}

/**
 * Why a coin is backed off. `hold`: the Brain held it. `blind`: its candle
 * and trade reads failed (a skipped review, or a paid HOLD that ran without
 * them). `no-tape`: its pool had no fresh tape row, so nothing was read at
 * all — not a feed outage, and never worded as one.
 */
export type BackoffCause = "hold" | "blind" | "no-tape";
/** The evidence causes: a window of one base length, never a hold. */
export type EvidenceCause = Exclude<BackoffCause, "hold">;

const signedPct = (fraction: number) => `${fraction >= 0 ? "+" : "-"}${Math.abs(fraction * 100).toFixed(1)}%`;

/**
 * THE PER-COIN MEMORY THE ROTATION LACKED (see HOLD_BACKOFF).
 *
 * Fleet-wide and in memory, like the rest of TrenchBrainReview: a restart
 * forgets it, which can only cost a review, never cause a trade. Kept across
 * a coin's flicker in and out of eligibility — the tape turns over every
 * minute and a coin that drops off for one refresh has not changed — and
 * forgotten only by age, by a BUY, or by a context change.
 *
 * `material` reads what a coin looks like NOW (index.ts: the tick's quote and
 * the fresh tape). An accessor that throws is no reading, and no reading
 * never releases anything.
 */
export class HoldBackoff {
  private records = new Map<string, HoldRecord>();
  constructor(private readonly material: (token: string) => TrenchMaterial | null, private readonly now: () => number = Date.now) {}

  /** What the coin looks like now. `priceUsd`, when given, replaces the quote (a review's own mark). */
  observe(token: string, priceUsd?: number | null): TrenchMaterial | null {
    let m: TrenchMaterial | null;
    try { m = this.material(token.toLowerCase()); } catch { m = null; }
    if (priceUsd === undefined) return m;
    const price = finiteOrNull(priceUsd);
    return { ...(m ?? { h1VolumeUsd: null, m5Buyers: null }), priceUsd: price !== null && price > 0 ? price : null };
  }

  /** A model hold on a coin not held: back it off, longer for each hold in a row. */
  held(token: string, at: number, seen: TrenchMaterial | null, reason: string | null): void {
    const key = token.toLowerCase();
    const prior = this.records.get(key);
    const holds = (prior && at - prior.at <= HOLD_BACKOFF.memoryMs ? prior.holds : 0) + 1;
    const ms = Math.min(HOLD_BACKOFF.maxMs, HOLD_BACKOFF.baseMs * 2 ** (holds - 1));
    this.records.delete(key);
    this.records.set(key, { at, holds, until: at + ms, seen, baseline: seen, reason, skipSaidUntil: prior?.skipSaidUntil ?? 0, cause: "hold" });
    this.sweep(at);
  }

  /** The Brain said BUY: the run of holds is over, and so is the memory of them. */
  forget(token: string): void {
    this.records.delete(token.toLowerCase());
  }

  /**
   * NEW EVIDENCE OF ANOTHER KIND: a nomination or an early offer still waiting
   * for its review. A HOLD's backoff ends; the memory of the hold stays, so
   * the review it gets can still say what changed. An EVIDENCE window does
   * not end: a nomination does not bring the feed back, and releasing it on
   * every call re-asked a blind coin every retry gap for its whole TTL.
   */
  release(token: string): void {
    const r = this.records.get(token.toLowerCase());
    if (r && r.cause === "hold") r.until = 0;
  }

  /**
   * True while the coin is backed off and nothing material changed since its
   * review. A material change releases it here, for good: the next review
   * is the one that decides whether it backs off again.
   */
  blocks(token: string): boolean {
    return this.blockedBy(token) !== null;
  }

  /** `blocks`, saying which backoff is running: a model hold's, or an evidence window's. */
  blockedBy(token: string): BackoffCause | null {
    const key = token.toLowerCase();
    const r = this.records.get(key);
    if (!r || r.until <= this.now()) return null;
    if (materialChange(r.baseline, this.observe(key)) !== null) {
      r.until = 0;
      return null;
    }
    return r.cause;
  }

  /**
   * AN ENTRY REVIEW SKIPPED FOR WANT OF EVIDENCE (index.ts). The coin backs
   * off one base window, measured from what it looks like now, so the same
   * gap is not re-asked every slot; it is not a hold and starts no run.
   * True when the skip should be said: once per coin per window.
   */
  evidenceSkipped(token: string, at: number, seen: TrenchMaterial | null, why: EvidenceCause): boolean {
    const r = this.evidenceBackoff(token, at, seen, why);
    if (r.skipSaidUntil > at) return false;
    r.skipSaidUntil = r.until;
    return true;
  }

  /**
   * ONE BASE WINDOW FOR A COIN WHOSE FLOW COULD NOT BE READ — a skipped entry
   * review (evidenceSkipped), or a PAID one that went ahead without candles or
   * trades and came back HOLD (TrenchBrainReview.launch). Not a hold: it
   * starts no run of holds and writes no hold memory, because no flow was
   * judged. But the coin still waits, or an outage would pay for the same
   * blind review on every pass of the rotation.
   */
  evidenceBackoff(token: string, at: number, seen: TrenchMaterial | null, why: EvidenceCause): HoldRecord {
    const key = token.toLowerCase();
    const until = at + HOLD_BACKOFF.baseMs;
    let r = this.records.get(key);
    if (r) {
      // The skip names the backoff only when it is what now runs longest.
      if (until > r.until) r.cause = why;
      r.until = Math.max(r.until, until);
      r.baseline = seen;
    } else {
      r = { at, holds: 0, until, seen, baseline: seen, reason: null, skipSaidUntil: 0, cause: why };
      this.records.set(key, r);
      this.sweep(at);
    }
    return r;
  }

  /**
   * ONE LINE OF MEMORY FOR THE NEXT REVIEW OF A COIN IT HELD: when, why in
   * a few safe words, and what moved since. Holds are otherwise kept out of
   * the Brain's memory (brain-material.ts memoryLines) because "I held"
   * twenty times teaches nothing; "I held this twelve minutes ago, and since
   * then buyers tripled" is a comparison it can actually make. Null when the
   * coin has no hold within HOLD_BACKOFF.memoryMs.
   */
  memoryLine(token: string, symbol: string): string | null {
    const r = this.records.get(token.toLowerCase());
    const now = this.now();
    if (!r || r.holds < 1 || now - r.at > HOLD_BACKOFF.memoryMs) return null;
    const was = r.seen;
    const cur = this.observe(token);
    const price = was?.priceUsd != null && cur?.priceUsd != null ? signedPct(cur.priceUsd / was.priceUsd - 1) : "unknown";
    const volume = was?.h1VolumeUsd != null && was.h1VolumeUsd > 0 && cur?.h1VolumeUsd != null
      ? signedPct(cur.h1VolumeUsd / was.h1VolumeUsd - 1) : "unknown";
    const buyers = was?.m5Buyers != null && cur?.m5Buyers != null ? `${was.m5Buyers}→${cur.m5Buyers}` : "unknown";
    const mins = Math.max(0, Math.round((now - r.at) / 60_000));
    const run = r.holds > 1 ? ` (${r.holds} holds in a row)` : "";
    return `You reviewed ${symbol} ${mins} min ago and held${run} because ${r.reason ?? "no short reason survived the filter"}. ` +
      `Since then: price ${price}, last-hour volume ${volume}, 5-minute distinct buyers ${buyers}. Judge the setup as it is now, not the earlier answer.`;
  }

  clear(): void {
    this.records.clear();
  }

  /** Forget what is past its memory and out of backoff; then the oldest, past the bound. */
  private sweep(now: number): void {
    for (const [key, r] of this.records) {
      if (now - r.at > HOLD_BACKOFF.memoryMs && r.until <= now) this.records.delete(key);
    }
    while (this.records.size > HOLD_BACKOFF.maxCoins) this.records.delete(this.records.keys().next().value!);
  }
}

/**
 * THE EARLY LANE the review rotation is told about (early-candidates.ts).
 * index.ts builds it from the early book on every `candidate` call.
 */
export interface EarlyLane {
  /** Every coin the early book holds now (waiting or decided), lowercased. None of them takes a regular rotation slot. */
  held: ReadonlySet<string>;
  /** The ones still waiting for their review, in the order the reserved slot takes them. */
  waiting: Iterable<string>;
  /** This slot is reserved for an early candidate: EarlyCandidateBook.reservedSlot(recentLaunches()). */
  reserved: boolean;
}

/** Reviews remembered for `recentLaunches`; more than the reserved-capacity window ever reads. */
const LAUNCH_MEMORY = 16;
/**
 * A coin off the eligible list keeps its place in the pass until this many
 * reviews have launched since its own — about half an hour at one review a
 * slot. Only a bound on growth: within it, a flicker changes nothing.
 */
const REVIEWED_KEEP = 64;

/** What a dropped order was about, for a caller that files it by coin (the decision funnel). */
export type TrenchDropInfo = { symbol: string; token: string; action: string; reason: string; decisionId?: string };

/**
 * WHY A REVIEW PRODUCED NO DECISION, in words that are true.
 *
 * Every non-decision used to print as "Brain unavailable: <kind>" — including
 * the commonest one, a refusal by the portfolio gate on book quality, where
 * the Brain was up, answered within milliseconds, and refused on purpose
 * before any model call. An owner reading "unavailable" goes looking for an
 * outage; the remedy is in the accounting (graph.py `assess`, refusing before
 * it bills). The refusal reason is service text, so only a short code-shaped
 * one is repeated.
 */
export function brainNoDecisionNote(symbol: string, result: BrainResult): string {
  if (result.ok) return `Brain reviewed ${symbol}: ${result.decision.action}`;
  if (result.kind === "unreachable") return "Brain unavailable: unreachable; no order approved";
  if (result.kind === "malformed") return `Brain answered ${symbol} with an unusable decision (malformed); no order approved`;
  const reason = /^[a-z0-9-]{1,48}$/.test(result.reason) ? result.reason : "unrecognised-reason";
  if (reason === "portfolio-quality-insufficient") {
    return `Brain did not review ${symbol}: the portfolio gate refused on book quality (${reason}); no new entry approved`;
  }
  if (reason === "budget-exhausted") return `Brain stopped reviewing ${symbol}: the run's model budget ran out (${reason}); no order approved`;
  return `Brain refused to decide on ${symbol} (${reason}); no order approved`;
}

/**
 * What a review's run may tell `launch` about itself. `withoutEvidence`: the
 * review went ahead with no candle and no trade reading (index.ts), so a HOLD
 * it returns is not a verdict on the coin: one evidence window
 * (HoldBackoff.evidenceBackoff), no run of holds, no hold memory.
 */
export interface TrenchReviewRun {
  withoutEvidence(): void;
}

/** Eligible coins left out of one `candidate` call, by what backed each off (BackoffCause). */
export type BackoffBreakdown = { holds: number; blind: number; noTape: number };

/** A desk notice said again within this long of its last saying is not a new event. */
export const TRENCH_NOTICE_REPEAT_MS = 30 * 60_000;

/** The desk notice while candle and trade reads fail for any candidate. True of some coins or all. */
export const TRENCH_FEED_OUTAGE_NOTICE = "Candle and trade reads are failing for some candidates, so their entry reviews are paused until the market feed recovers. Automatic exits remain active.";
/** The desk notice when nothing reaches the review at all, for no reason the backoff explains. */
export const TRENCH_NOTHING_PASSES_NOTICE = "No permitted, freshly priced high-volume pool passes the entry checks. Discovery will retry; automatic exits remain active.";

/**
 * THE TRENCHER'S DESK NOTICE FOR A REVIEW TICK (index.ts). A feed outage —
 * any coin waiting out failed candle and trade reads — is said whatever the
 * slot picked, so a review of an early coin, or of the coins outside the
 * outage, never clears it. Otherwise "nothing passes the entry checks" is
 * said only when it is true: no coin picked, entries not braked (the
 * strategy says why then), and no coin held back by a hold or a missing tape
 * row. Pure; TrenchNoticeGate decides whether it is written.
 */
export function trenchDeskNotice(t: { picked: boolean; braked: boolean; backoff: BackoffBreakdown }): string {
  if (t.backoff.blind > 0) return TRENCH_FEED_OUTAGE_NOTICE;
  const held = t.backoff.holds + t.backoff.noTape;
  return t.picked || t.braked || held > 0 ? "" : TRENCH_NOTHING_PASSES_NOTICE;
}

/**
 * ONE WARNING PER CHANGE, NOT PER FLICKER.
 *
 * The desk notice is set on every review tick, and during an outage it
 * alternates between the outage text and nothing as coins come out of their
 * evidence windows and are skipped again. Said on every change back, the same
 * warn was written as a new event roughly once per coin per window — 214 in
 * six hours in a simulated outage. This says a message only when it differs
 * from the current one AND has not itself been said within
 * TRENCH_NOTICE_REPEAT_MS; clearing to "" is never said and resets nothing.
 */
export class TrenchNoticeGate {
  private current = "";
  private said = new Map<string, number>();
  constructor(private readonly repeatMs = TRENCH_NOTICE_REPEAT_MS, private readonly now: () => number = Date.now) {}

  /** True when `message` should be written now. */
  say(message: string): boolean {
    if (message === this.current) return false;
    this.current = message;
    if (!message) return false;
    const t = this.now();
    const last = this.said.get(message);
    if (last !== undefined && t - last < this.repeatMs) return false;
    this.said.delete(message);
    this.said.set(message, t);
    while (this.said.size > 32) this.said.delete(this.said.keys().next().value!);
    return true;
  }
}

/** Model calls cannot hold up a stop-loss tick. Results are one-use, short-lived data. */
export class TrenchBrainReview {
  private pending = false;
  private nextAt = 0;
  private ready: Ready | null = null;
  private context = "";
  private generation = 0;
  private reviewed = new Map<string, number>();
  /**
   * When each SYMBOL was last actually reviewed, ms epoch.
   *
   * Separate from `reviewed` on purpose. That one is a rotation sequence over
   * ENTRY candidates and is pruned to the eligible set every pass; a held
   * position is excluded from that set by the caller, so its stamp would be
   * deleted the moment it was bought — which is the one case this map exists
   * to answer.
   */
  private reviewedAtMs = new Map<string, number>();
  /**
   * When each TOKEN (lowercased) last had a review launched, ms epoch — read
   * only to space out a priority coin's retries (see `candidate`).
   */
  private launchedAtMs = new Map<string, number>();
  /** The priority hint the last `candidate` call was given (lowercased), for `launch`. */
  private priorityKeys: ReadonlySet<string> = new Set();
  /**
   * When a review last launched for a token in that hint, ms epoch — the
   * spacing that keeps nominations TOGETHER to every other slot. Its own
   * stamp, not read off `launchedAtMs`: a nomination that resolved on its
   * review leaves the hint, and its slot must still count.
   */
  private priorityLaunchedAtMs: number | undefined;
  private reviewSequence = 0;
  /** Tokens (lowercased) of the reviews actually launched, oldest first, bounded. */
  private launches: string[] = [];
  /** Eligible coins the last `candidate` call left out, by what backed each off. */
  private backedOff: BackoffBreakdown = { holds: 0, blind: 0, noTape: 0 };
  constructor(private now = Date.now) {}

  /**
   * THE PER-COIN HOLD BACKOFF (HoldBackoff), set once by index.ts. Absent,
   * the rotation is exactly what it was before it existed. It narrows the
   * ENTRY rotation only: `candidate` is never handed a held position, and
   * `launch` records nothing from a review of one.
   */
  holdBackoff?: HoldBackoff;

  /** Eligible coins the last `candidate` call skipped for their backoff. All of them, and it returned nothing. */
  backedOffCount(): number {
    return this.backedOff.holds + this.backedOff.blind + this.backedOff.noTape;
  }

  /**
   * The same, by cause: held by the model with nothing material moved since;
   * waiting out failed candle and trade reads (a feed outage, not a verdict
   * on the coin); or waiting out a missing tape row. Counted on every call
   * that had eligible coins, whatever it picked — so an early coin taking the
   * slot cannot hide an outage among the rest. index.ts words its idle line
   * and the desk notice from this.
   */
  backedOffBreakdown(): BackoffBreakdown {
    return { ...this.backedOff };
  }

  /** The hold-memory line for an entry review of this coin (HoldBackoff.memoryLine), or null. */
  holdMemory(token: string, symbol: string): string | null {
    try {
      return this.holdBackoff?.memoryLine(token, symbol) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * An entry review index.ts skipped for want of evidence: the coin backs off
   * one base window (HoldBackoff.evidenceSkipped), under the cause given.
   * True when the skip should be said — once per coin per window, and always
   * without a backoff.
   */
  evidenceSkipped(token: string, why: EvidenceCause): boolean {
    try {
      const b = this.holdBackoff;
      return b ? b.evidenceSkipped(token, this.now(), b.observe(token), why) : true;
    } catch {
      return true;
    }
  }

  /**
   * Where the early lane comes from (index.ts sets it once). Asked on every
   * `candidate` call with the recent launches. Absent, or answering null, the
   * rotation is exactly what it was before the early path existed.
   */
  earlyLane?: (recentLaunches: readonly string[]) => EarlyLane | null;

  /** The tokens of the last reviews launched, oldest first — what EarlyCandidateBook.reservedSlot reads. */
  recentLaunches(): string[] {
    return [...this.launches];
  }

  /**
   * True when the context actually changed — the moment every review in
   * flight and every ready order stopped counting, which a caller holding
   * state keyed to those reviews (the nomination book) must hear about.
   */
  reset(context = ""): boolean {
    if (this.context === context) return false;
    this.context = context;
    this.generation++;
    this.ready = null;
    this.nextAt = 0;
    this.reviewed.clear();
    this.reviewedAtMs.clear();
    this.launchedAtMs.clear();
    this.priorityKeys = new Set();
    this.priorityLaunchedAtMs = undefined;
    this.reviewSequence = 0;
    this.launches = [];
    // Another agent, rail or grant: its holds were not this context's.
    this.holdBackoff?.clear();
    this.backedOff = { holds: 0, blind: 0, noTape: 0 };
    return true;
  }

  /**
   * WHICH COIN GETS THE NEXT REVIEW: busiest first, but nobody is skipped.
   *
   * This was strict least-recently-reviewed, and the cost of that was all in
   * the waiting. A review runs at most every 30s, so with ten eligible coins a
   * given one waited about five minutes for its turn NO MATTER HOW IT LOOKED —
   * the loudest tape on the chain sat behind nine quiet ones because they
   * happened to be older in the queue. Measured 2026-09-20: entries arrived
   * 2m50s to 5m43s after the previous trade, essentially one rotation.
   *
   * ── WHY NOT SIMPLY RANK BY VOLUME ────────────────────────────────────
   *
   * Because that starves. One coin with a permanently fat tape would take
   * every slot forever and the rest would never be looked at again — and a
   * position already held is reviewed through this same path, so a quiet coin
   * the desk OWNS could stop being watched. The fairness is not decoration.
   *
   * So the round-robin PASS is kept and the order INSIDE it is changed. A coin
   * is due when it has not been reviewed in the last `eligible.length` reviews;
   * among those the busiest goes first. Every coin is still reviewed once per
   * pass, and a hot one now waits at most one pass instead of a full rotation
   * behind whoever happened to be older.
   *
   * Volume is a RANKING input only. It decides what is looked at sooner, never
   * what is bought: `shouldEnter` has already run, and the Brain still has to
   * say buy. Absent volume sorts last rather than first — an unknown tape is
   * not a busy one.
   *
   * ── A NOMINATED COIN GOES FIRST, AND ONLY FIRST ──────────────────────
   *
   * `priority` is the nomination book's hint (trencher-nominate.ts
   * `priority()`: the coins Telegram groups posted that still wait for a
   * review, in queue order). The FIRST of them that is ELIGIBLE is picked
   * ahead of the rotation — eligible meaning it already passed everything the
   * caller filters on (tape, verification, `shouldEnter`), so the hint moves a
   * coin up the queue and never onto it. First eligible, not first: the head
   * of the queue may never pass the tick's filters, and it must not hold the
   * preference away from a coin behind it that does. Held positions are
   * untouched: this only picks the entry candidate, and `chooseFocus`'s
   * overdue rule still decides between it and a holding.
   *
   * SPACED, SO NOMINATIONS CANNOT TAKE EVERY SLOT. A review that produced no
   * decision (the Brain down, a refusal) leaves a nomination unresolved, and
   * an unspaced preference would re-ask every 30s until the TTL, starving the
   * tape; several nominations taking turns would do the same. So nothing is
   * preferred until `PRIORITY_RETRY_MS` has passed since a review last
   * launched for any coin in the hint, and a coin is not preferred again
   * until that long after its own last launch — together, at most every other
   * review slot — and in between the rotation runs exactly as before.
   *
   * ── EARLY CANDIDATES HAVE A LANE OF THEIR OWN ────────────────────────
   *
   * RESERVED CAPACITY, NEVER CAPITAL. A coin the early book holds
   * (early-candidates.ts) is usually far too quiet to win a busiest-first
   * rotation, so without a reservation it would be verified and then never
   * looked at. With `earlyLane`, such a coin is reviewed ONLY in a slot the
   * book reserves — one in every EARLY.reserveEvery — taking the waiting
   * coins in the book's priority order, each spaced by PRIORITY_RETRY_MS so
   * a review that produced no decision does not re-ask every 30s. It never
   * takes a regular slot unless nothing else is eligible at all. Like the
   * nomination hint, the lane chooses among ELIGIBLE coins only — everything
   * the caller filters on (verification, shouldEnter, paused, held) has
   * already run — and a decided coin (Brain said BUY, entry pending) is not
   * picked again: a second review would supersede the order it is waiting
   * on. What a review then decides, and what may be bought, is unchanged.
   *
   * ── A COIN THE BRAIN JUST HELD WAITS ITS TURN OUT ────────────────────
   *
   * With `holdBackoff`, a coin the model held is left out of the ROTATION
   * until its backoff passes or something material moves (HOLD_BACKOFF). A
   * nomination or early offer still waiting for its review is new evidence
   * and releases a HOLD's backoff — not an evidence window, which applies to
   * nominated and early coins too. When every regular coin is backed off, a waiting early
   * coin may take the slot (for the lane, nothing else is reviewable); with
   * none, nothing is picked and no entry review launches this slot — a
   * narrower spend, never a wider one. A coin's memory survives it flickering out of eligibility,
   * and so does its place in the pass: the tape turns over every minute, and
   * a coin that missed one refresh was not thereby un-reviewed.
   */
  candidate<T extends { token: string; volume24hUsd?: number; heat?: number; ageSec?: number }>(eligible: readonly T[], priority?: ReadonlySet<string>, focus: DiscoveryFocus = "balanced"): T | undefined {
    const current = new Set(eligible.map(c => c.token.toLowerCase()));
    // Bounded by age in reviews, not by this pass's eligibility (see above).
    for (const [key, seq] of this.reviewed) if (!current.has(key) && this.reviewSequence - seq > REVIEWED_KEEP) this.reviewed.delete(key);
    const wanted = new Set([...(priority ?? [])].map(a => a.toLowerCase()));
    this.priorityKeys = wanted;
    this.backedOff = { holds: 0, blind: 0, noTape: 0 };
    if (eligible.length === 0) return undefined;
    const lane = this.laneNow();
    if (this.holdBackoff) {
      for (const key of wanted) this.holdBackoff.release(key);
      for (const key of lane?.waiting ?? []) this.holdBackoff.release(key);
    }
    const inLane = (c: T) => lane?.held.has(c.token.toLowerCase()) === true;
    const early = eligible.filter(inLane);
    const regular = early.length > 0 ? eligible.filter(c => !inLane(c)) : eligible;
    // THE BACKOFF IS ASKED BEFORE THE LANE, once per coin. "Nothing else is
    // eligible" means nothing the rotation could actually review: a regular
    // list that is entirely backed off must not freeze a waiting early coin
    // out of every unreserved slot until its offer expires.
    // Early coins too: a waiting early coin whose reads failed waits out its
    // evidence window like any other (release() leaves those alone).
    const unblocked = (cs: readonly T[]) => this.holdBackoff ? cs.filter(c => {
      const why = this.blockedBy(c.token);
      if (why) this.backedOff[why === "hold" ? "holds" : why === "blind" ? "blind" : "noTape"]++;
      return why === null;
    }) : cs;
    const open = unblocked(regular);
    const earlyOpen = early.length > 0 ? unblocked(early) : early;
    if (lane && earlyOpen.length > 0 && (lane.reserved || open.length === 0)) {
      const pick = this.earlyPick(earlyOpen, lane.waiting);
      if (pick) return pick;
    }
    if (open.length === 0) return undefined;
    eligible = open;
    if (wanted.size > 0) {
      const now = this.now();
      const spaced = (last: number | undefined) => last === undefined || now - last >= PRIORITY_RETRY_MS;
      if (spaced(this.priorityLaunchedAtMs)) {
        const byToken = new Map<string, T>();
        for (const c of eligible) {
          const key = c.token.toLowerCase();
          if (!byToken.has(key)) byToken.set(key, c);
        }
        // Queue order: the hint's order, never the order discovery returned.
        for (const key of wanted) {
          const c = byToken.get(key);
          if (c && spaced(this.launchedAtMs.get(key))) return c;
        }
      }
    }
    const seq = (c: T) => this.reviewed.get(c.token.toLowerCase()) ?? 0;
    // Hottest now first (trenchHeat), where the candidate carries it; else its day.
    const busy = (c: T) => (typeof c.heat === "number" && Number.isFinite(c.heat) ? c.heat
      : typeof c.volume24hUsd === "number" && Number.isFinite(c.volume24hUsd) ? c.volume24hUsd : -1);
    // Reviewed longer ago than one full pass — or never.
    const floor = this.reviewSequence - eligible.length;
    // Never reviewed counts as due whatever the floor says: on a fresh pass
    // every sequence is 0 and a floor computed from it would exclude the whole
    // pool, dropping the ranking back to whatever order discovery returned.
    const due = eligible.filter(c => seq(c) === 0 || seq(c) <= floor);
    // Everyone has been seen this pass: start the next one with the oldest,
    // which is exactly the old behaviour and keeps the pass boundary honest.
    if (due.length === 0) {
      return eligible.reduce<T | undefined>((best, c) => !best || seq(c) < seq(best) ? c : best, undefined);
    }
    return due.reduce<T | undefined>((best, c) => {
      if (!best) return c;
      if (focus === "new-projects") {
        const a = newProjectAge(c.ageSec), b = newProjectAge(best.ageSec);
        if (a !== b) return a < b ? c : best;
      }
      if (busy(c) !== busy(best)) return busy(c) > busy(best) ? c : best;
      // Same tape, or both unknown: the older one goes first, so the tiebreak
      // cannot depend on the order discovery happened to return.
      return seq(c) < seq(best) ? c : best;
    }, undefined);
  }

  /**
   * The lane for this call, or null. An observer that throws is no lane, not a
   * broken rotation. `waiting` is read once, here: the backoff release and the
   * reserved pick both walk it, and an iterator can be walked only once.
   */
  private laneNow(): (EarlyLane & { waiting: string[] }) | null {
    if (!this.earlyLane) return null;
    try {
      const lane = this.earlyLane(this.recentLaunches());
      if (!lane || typeof lane.held?.has !== "function" || lane.held.size === 0) return null;
      return { ...lane, waiting: [...(lane.waiting ?? [])].filter((a): a is string => typeof a === "string") };
    } catch {
      return null;
    }
  }

  /** The backoff's verdict on one coin, by cause. A backoff that throws blocks nothing. */
  private blockedBy(token: string): BackoffCause | null {
    try {
      return this.holdBackoff?.blockedBy(token) ?? null;
    } catch {
      return null;
    }
  }

  /** The first WAITING early coin, in the book's order, not launched within PRIORITY_RETRY_MS. */
  private earlyPick<T extends { token: string }>(early: readonly T[], waiting: Iterable<string>): T | undefined {
    const now = this.now();
    const byToken = new Map<string, T>();
    for (const c of early) {
      const key = c.token.toLowerCase();
      if (!byToken.has(key)) byToken.set(key, c);
    }
    for (const raw of waiting) {
      const key = typeof raw === "string" ? raw.toLowerCase() : "";
      const c = byToken.get(key);
      const last = this.launchedAtMs.get(key);
      if (c && (last === undefined || now - last >= PRIORITY_RETRY_MS)) return c;
    }
    return undefined;
  }

  launch(context: string, input: ShadowInputs, token: string, run: (review: TrenchReviewRun) => Promise<ShadowOutcome>, note: (s: string) => void) {
    this.reset(context);
    if (this.pending || this.now() < this.nextAt) return;
    this.pending = true;
    this.reviewed.set(token.toLowerCase(), ++this.reviewSequence);
    this.launches.push(token.toLowerCase());
    if (this.launches.length > LAUNCH_MEMORY) this.launches.shift();
    const started = this.now();
    // STAMPED WHERE THE REVIEW ACTUALLY HAPPENS, past the pending/interval
    // guard above — a stamp written from the caller would claim a review on
    // every tick that merely ASKED for one, and the holding it was meant to
    // protect would look permanently current.
    this.reviewedAtMs.set(input.market.symbol, started);
    this.launchedAtMs.set(token.toLowerCase(), started);
    // Any review of a nominated coin takes a nomination slot, picked through
    // the hint or reached by the rotation on its own.
    if (this.priorityKeys.has(token.toLowerCase())) this.priorityLaunchedAtMs = started;
    // The map is read only for currently-held symbols; anything older than an
    // hour is past every gap that could be asked about and is just growth.
    for (const [sym, at] of this.reviewedAtMs) if (started - at > 3_600_000) this.reviewedAtMs.delete(sym);
    for (const [key, at] of this.launchedAtMs) if (started - at > 3_600_000) this.launchedAtMs.delete(key);
    const generation = this.generation;
    this.nextAt = started + TRENCH_REVIEW_INTERVAL_MS;
    // WHAT THIS REVIEW SAW, read now rather than when it lands: a hold is
    // measured against the tape and the mark the Brain was actually handed.
    const stale = input.market.priceStale === true;
    let seen: TrenchMaterial | null = null;
    try {
      seen = this.holdBackoff?.observe(token, stale ? null : Number(input.market.priceUsd)) ?? null;
    } catch { seen = null; }
    // Set by the run when the review went ahead with no candles and no trades.
    let blind = false;
    void run({ withoutEvidence: () => { blind = true; } }).then(outcome => {
      if (this.context !== context || this.generation !== generation) return;
      const held = Boolean(input.positions?.some(p => p.symbol === input.market.symbol && Number(p.qtyRaw) > 0));
      try {
        this.onReviewed?.({ token, symbol: input.market.symbol, held, priceStale: input.market.priceStale === true, outcome });
      } catch { /* An observer cannot break the review it observes. */ }
      // ENTRY REVIEWS ONLY. A held position's review is about its exit, and
      // nothing here may slow that down. A model hold backs the coin off; a
      // BUY ends the run of holds. Anything else (no decision, a gate-forced
      // or stale-mark hold) leaves the backoff exactly as it was. A hold from
      // a review that had no flow to read (`blind`) says the evidence was
      // missing, not that the coin was judged: no run of holds and no hold
      // memory — but one EVIDENCE window, or an outage would pay for the same
      // blind review of this coin on every pass of the rotation.
      if (!held && this.holdBackoff && outcome.ran && outcome.result.ok) {
        const d = outcome.result.decision;
        try {
          if (isModelHold(d, stale)) {
            if (blind) this.holdBackoff.evidenceBackoff(token, started, seen, "blind");
            else this.holdBackoff.held(token, started, seen, holdReason(d));
          }
          else if (String(d.action ?? "").toLowerCase() === "buy") this.holdBackoff.forget(token);
        } catch { /* The backoff is a spend saver; it cannot break the review. */ }
      }
      if (outcome.ran && outcome.result.ok) {
        // A NEWER DECISION REPLACES AN UNUSED ORDER, AND THAT IS SAID TOO.
        // Every branch here overwrites `ready`; an untaken BUY or SELL sitting
        // there used to vanish without a word whenever its coin left the
        // strategy's candidate list before the next review landed. Only this
        // branch: a review that produced no decision leaves `ready` alone, as
        // it always has.
        this.supersede();
        if (outcome.result.decision.action === "sell" &&
            !input.positions?.some(p => p.symbol === input.market.symbol && Number(p.qtyRaw) > 0)) {
          this.ready = null;
          note(`Brain SELL ignored for ${input.market.symbol}: no position is held; no order approved`);
          return;
        }
        // THE MIRROR OF THE GUARD ABOVE, AND IT WAS MISSING.
        //
        // Trencher v1 opens a position and closes it; trencher.ts:461 drops
        // a held symbol from the entry loop, so it cannot add to one. A BUY
        // for something already held therefore became a `ready` order, was
        // taken, and was then discarded by that loop WITHOUT A WORD — which
        // is how Shogun published two buys on 2026-09-21 that no trade came
        // of, while cash never moved. The decision stays on the record
        // exactly as the model made it; what is refused is the ORDER, and
        // now the refusal is countable like every other one.
        if (outcome.result.decision.action === "buy" &&
            input.positions?.some(p => p.symbol === input.market.symbol && Number(p.qtyRaw) > 0)) {
          this.ready = null;
          note(`Brain BUY ignored for ${input.market.symbol}: the position is already open and Trencher does not add to one; no order approved`);
          return;
        }
        this.ready = { decision: outcome.result.decision, input, token, context, started };
        note(`Brain reviewed ${input.market.symbol}: ${outcome.result.decision.action}`);
        // An outcome with no `why` was already said by the run that made it
        // (index.ts: an evidence skip, said once per coin per backoff window).
      } else if (outcome.ran || outcome.why) note(outcome.ran ? brainNoDecisionNote(input.market.symbol, outcome.result) : outcome.why);
    }).catch(() => note("Brain review failed; no new entry approved")).finally(() => { this.pending = false; });
  }

  /**
   * Told about every review that completed in the current context, before
   * any of the guards in `launch` decide what becomes of it — the decision
   * funnel's view of what the Brain said (index.ts). Read-only: it cannot
   * change the outcome, and a throw from it is swallowed.
   */
  onReviewed?: (r: { token: string; symbol: string; held: boolean; priceStale: boolean; outcome: ShadowOutcome }) => void;

  private supersede(): void {
    const r = this.ready;
    this.ready = null;
    if (!r || r.decision.action.toLowerCase() === "hold") return;
    const id = typeof r.decision.decision_id === "string" && r.decision.decision_id.trim() ? r.decision.decision_id : undefined;
    const reason = "superseded by a newer review before it was taken";
    // The decision id rides only in `info`, not in the second argument the
    // nomination book answers from: the review that replaced this one may be
    // answering that same nomination right now, and telling the group
    // `skipped` underneath it would race the answer that is still coming.
    this.onDrop?.(`Brain ${r.decision.action.toUpperCase()} ${r.input.market.symbol} not used: ${reason}`, undefined,
      { symbol: r.input.market.symbol, token: r.token, action: r.decision.action, reason, decisionId: id });
  }

  /** When this symbol was last actually reviewed, ms epoch. Absent = never. */
  reviewedAt(symbol: string): number | undefined {
    return this.reviewedAtMs.get(symbol);
  }

  /**
   * Told why a ready order was not used, so drops are countable — and which
   * Brain decision it was, so a caller waiting on that decision's fill (a
   * nominated coin) hears that none is coming instead of waiting out a TTL.
   */
  onDrop?: (why: string, decisionId?: string, info?: TrenchDropInfo) => void;

  take(symbol: string, token: string, price8: bigint, maxUsdg: number, held = false): TrenchBrainOrder | null {
    const r = this.ready;
    if (!r || r.input.market.symbol !== symbol) return null;
    this.ready = null;
    // A DROPPED ORDER IS SAID, NOT SWALLOWED — on EVERY path past the line
    // above. `ready` is already cleared there, so a Brain decision refused
    // after it silently never happened: nothing counted it, and a coin
    // nominated from a Telegram group waited out its whole TTL for an answer
    // that could no longer come (the onDrop handler turns the decision id into
    // that group's `skipped`). Only the symbol mismatch above keeps `ready`.
    const act = r.decision.action.toUpperCase();
    const id = typeof r.decision.decision_id === "string" && r.decision.decision_id.trim() ? r.decision.decision_id : undefined;
    const drop = (reason: string): null => {
      this.onDrop?.(`Brain ${act} ${symbol} not used: ${reason}`, id, { symbol, token: r.token, action: r.decision.action, reason, decisionId: id });
      return null;
    };
    if (Boolean(r.input.positions?.some(p => p.symbol === symbol && Number(p.qtyRaw) > 0)) !== held) return drop("whether it is held changed since the review");
    if (r.context !== this.context) return drop("the agent's context changed since the review");
    const age = this.now() - r.started;
    if (age > 60_000) return drop(`${Math.round(age / 1000)}s old, past the 60s a review stays valid`);
    if (price8 <= 0n) return drop("no usable mark to price it at");
    if (r.token.toLowerCase() !== token.toLowerCase() ||
        r.decision.instrument_id !== r.input.market.instrumentId || r.decision.symbol !== symbol ||
        typeof r.decision.agent_id !== "string" || typeof r.decision.decision_id !== "string" || !r.decision.decision_id.trim() ||
        r.decision.agent_id.toLowerCase() !== r.input.agentId.toLowerCase()) return drop("the decision does not match the coin or agent it was asked about");
    const before = Number(r.input.market.priceUsd);
    const price = Number(price8) / 1e8;
    if (!Number.isFinite(before) || before <= 0) return drop("the review had no usable price to compare against");
    if (Math.abs(price / before - 1) > .02) return drop(`price moved ${((price / before - 1) * 100).toFixed(1)}% since the review (limit 2%)`);
    const verdict = orderFromDecision(r.decision, { maxUsdg });
    // A HOLD was never going to be an order; only a refused BUY or SELL is a drop.
    if (!verdict.ok) return r.decision.action.toLowerCase() === "hold" ? null : drop(verdict.why);
    if (verdict.order.side === "sell" && !held) return drop("a sell of a coin that is not held");
    return { side: verdict.order.side, usdgAmount: verdict.order.usdgAmount, decisionId: r.decision.decision_id };
  }
}
