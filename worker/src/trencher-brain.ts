import type { BrainDecision, BrainResult } from "./brain-client";
import { orderFromDecision } from "./brain-live";
import type { ShadowInputs, ShadowOutcome } from "./brain-shadow";
import type { GeckoFetch, GeckoPool } from "./venues/geckoterminal";
import { fetchGeckoPoolsResult, readTokenPoolsResult } from "./venues/geckoterminal";
import { NOMINATE } from "./trencher-nominate";
import { EARLY_PAGES_MAX, EARLY_VENUE, earlyScreenReason, type EarlyScreen } from "./early-candidates";
import { CASH, instrumentClassOf } from "../../packages/core/src/index";

export const TRENCH_VOLUME_MIN = 100_000;
export const TRENCH_TAPE_MAX_AGE_MS = 120_000;
/** Tape pages kept for nominated coins, at most — the nomination book's own queue bound. */
export const NOMINATED_PAGES_MAX = NOMINATE.queueMax;
const NOMINATED_PREFIX = "nominated:";
const EARLY_PREFIX = "early:";

/** Safe diagnostic codes only; never provider bodies or credential-bearing URLs. */
const pageFailure = (failure: string | undefined) =>
  /^(http-\d{3}|timeout|network|invalid-body|invalid-shape|cache-unavailable|provider-cooldown|request-budget)$/.test(failure ?? "") ? failure! : "unavailable";
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

/** Keep each page on its own clock: partial outages must not erase fresh pages
 * or renew the age of old observations. Healthy empty pages replace old data. */
export class TrenchTapeReader {
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
        const key = `${p.tokenAddress}:${p.dex}:${p.poolAddress ?? p.poolId}`.toLowerCase();
        if (!unique.has(key)) unique.set(key, p);
      }
    }
    return { pools: [...unique.values()], pages };
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
    await Promise.all([
      ...[1, 2, 3].flatMap(page =>
        (["trending_pools", "pools"] as const).map(async feed => {
          const key = `${feed}:${page}`;
          try {
            const r = await this.fetchPage(feed, { page });
            if (r.failed) failures.push(`${key}=${pageFailure(r.failure)}`);
            else this.pages.set(key, { pools: r.pools, at: r.observedAt ?? this.now() });
          } catch { failures.push(`${key}=unavailable`); }
        })),
      // Refreshed WITH the tape, on the tape's clock: a nominated page is
      // never older than the feed pages it is read beside.
      ...[...this.nominated].map(address => this.readNominated(address, failures)),
      // Early pages ride the same clock, for the same reason.
      ...this.earlyToRead().map(address => this.readEarly(address, failures)),
    ]);
    return { ...this.snapshot(), failures };
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
      maxEntryUsd: 5, maxEntryAsPercentOfRouteDepth: depth !== null && depth > 0 ? 500 / depth : null,
      interpretation: "Reserve and route depth are USD, not token quantities. Entry/depth is a scale comparison, not a slippage quote. Null means unknown, not zero. FDV is valuation, not available liquidity." }),
  };
}

/** Six bounded requests per refresh; a failed page cannot erase healthy pages. */
export async function fetchTrenchTape(fetchPage = fetchGeckoPoolsResult): Promise<GeckoPool[]> {
  const results = await Promise.allSettled([1, 2, 3].flatMap(page =>
    (["trending_pools", "pools"] as const).map(feed => fetchPage(feed, { page }))));
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
  if ((p.volume24hUsd ?? 0) < TRENCH_VOLUME_MIN) return "volume-below-min";
  if ((p.buyers24h ?? 0) < 20) return "buyers-below-min";
  if ((p.buys24h ?? 0) <= 0) return "no-buys-24h";
  if ((p.sells24h ?? 0) <= 0) return "no-sells-24h";
  if ((p.buckets.m5?.volumeUsd ?? 0) <= 0) return "no-m5-volume";
  return null;
}

/** Volume ranks opportunities; on-chain depth and wallet policy still gate trades. */
export function highVolumePools(pools: readonly GeckoPool[], perPool = false): GeckoPool[] {
  const byToken = new Map<string, GeckoPool>();
  for (const p of pools) {
    if (trenchScreenReason(p) !== null) continue;
    const key = perPool
      ? `${p.tokenAddress.toLowerCase()}:${p.dex}:${p.poolAddress?.toLowerCase() ?? p.poolId}`
      : p.tokenAddress.toLowerCase();
    if ((byToken.get(key)?.volume24hUsd ?? -1) < p.volume24hUsd!) byToken.set(key, p);
  }
  return [...byToken.values()].sort((a, b) => b.volume24hUsd! - a.volume24hUsd!);
}

export type TrenchBrainOrder = { side: "buy" | "sell"; usdgAmount: number; decisionId: string };

export function trenchBrainPersona(symbol: string, held: boolean): string {
  return "Trencher: short-horizon memecoin trading. Evaluate real volume, two-sided flow, liquidity, costs and reversal risk. Maximum new entry is 5 USDG, also bounded by the owner's limits. " +
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
  constructor(private now = Date.now) {}

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
   */
  candidate<T extends { token: string; volume24hUsd?: number }>(eligible: readonly T[], priority?: ReadonlySet<string>): T | undefined {
    const current = new Set(eligible.map(c => c.token.toLowerCase()));
    for (const key of this.reviewed.keys()) if (!current.has(key)) this.reviewed.delete(key);
    const wanted = new Set([...(priority ?? [])].map(a => a.toLowerCase()));
    this.priorityKeys = wanted;
    if (eligible.length === 0) return undefined;
    const lane = this.laneNow();
    if (lane) {
      const early = eligible.filter(c => lane.held.has(c.token.toLowerCase()));
      if (early.length > 0) {
        const regular = eligible.filter(c => !lane.held.has(c.token.toLowerCase()));
        if (lane.reserved || regular.length === 0) {
          const pick = this.earlyPick(early, lane.waiting);
          if (pick) return pick;
        }
        if (regular.length === 0) return undefined;
        eligible = regular;
      }
    }
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
    const busy = (c: T) => (typeof c.volume24hUsd === "number" && Number.isFinite(c.volume24hUsd) ? c.volume24hUsd : -1);
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
      if (busy(c) !== busy(best)) return busy(c) > busy(best) ? c : best;
      // Same tape, or both unknown: the older one goes first, so the tiebreak
      // cannot depend on the order discovery happened to return.
      return seq(c) < seq(best) ? c : best;
    }, undefined);
  }

  /** The lane for this call, or null. An observer that throws is no lane, not a broken rotation. */
  private laneNow(): EarlyLane | null {
    if (!this.earlyLane) return null;
    try {
      const lane = this.earlyLane(this.recentLaunches());
      return lane && typeof lane.held?.has === "function" && lane.held.size > 0 ? lane : null;
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

  launch(context: string, input: ShadowInputs, token: string, run: () => Promise<ShadowOutcome>, note: (s: string) => void) {
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
    void run().then(outcome => {
      if (this.context !== context || this.generation !== generation) return;
      const held = Boolean(input.positions?.some(p => p.symbol === input.market.symbol && Number(p.qtyRaw) > 0));
      try {
        this.onReviewed?.({ token, symbol: input.market.symbol, held, priceStale: input.market.priceStale === true, outcome });
      } catch { /* An observer cannot break the review it observes. */ }
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
      } else note(outcome.ran ? brainNoDecisionNote(input.market.symbol, outcome.result) : outcome.why);
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
