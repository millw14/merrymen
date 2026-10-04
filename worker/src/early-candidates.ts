/**
 * EARLY CANDIDATES — the smaller-coin path into Trencher discovery and review.
 *
 * WHY THIS EXISTS. Every coin the desk could ever look at had to clear the
 * tape screen first: $100,000 of 24h volume and 20 distinct buyers
 * (trencher-brain.ts TRENCH_VOLUME_MIN), then the busiest DISCOVERY_SLICE = 20
 * (trencher-discovery.ts). Telegram nominations skip only the slice, never the
 * screen. So a smaller coin somebody had good reason to look at was deleted
 * BEFORE research, before the Brain, before any rule that is actually about
 * whether a trade is safe. That conflated three different questions:
 *
 *   1. Is this worth investigating?            ← this file (the early screen)
 *   2. Does the setup justify the risk?        ← the Brain review, unchanged
 *   3. Is this exact trade permitted and
 *      executable?                             ← shouldEnter, pool price
 *                                                guards, policy, vault —
 *                                                ALL UNCHANGED
 *
 * This file answers only the first, for coins a trusted source in this
 * process OFFERS (a Fomo selective-follow assessment today; any source later).
 * It never answers 2 or 3, and nothing here can make an entry happen: an
 * offer buys a tape page, an on-chain verification attempt and a share of
 * review capacity — never capital. The per-coin size ceiling it carries can
 * only LOWER what take() would otherwise allow (index.ts takes the min).
 *
 * PURE, ON PURPOSE, like NominationBook (trencher-nominate.ts): no I/O, an
 * injected clock, no trading imports. index.ts owns the one book of this
 * process and feeds it what the trading side saw. Keeping it in memory is
 * deliberate: a restart forgets every offer, so nothing is ever REPLAYED into
 * a second look or a second buy — the source simply offers again if the
 * setup still holds.
 *
 * TENANT. A child process trades for exactly one agent, so the book has no
 * tenant field and accepts none: whoever holds `earlyCandidateBook()` in this
 * process is offering for this process's agent. A tenant is never read from
 * an offer, a message or a model argument.
 */
import { CASH, instrumentClassOf, isEnergyReserveToken } from "../../packages/core/src/index";
import type { Classified } from "./decision-funnel";
import type { GeckoPool } from "./venues/geckoterminal";

/**
 * The caps. All are EXTRA bounds on what the early path may ask for; none can
 * raise anything the screen, the vault, the wall, energy or the breaker allow.
 * Judgment calls, not measurements — named so an owner can see them.
 */
export const EARLY = {
  /** Offers held at once, waiting or awaiting their entry. A full book refuses newcomers. */
  activeMax: 8,
  /** New offers accepted per UTC day (updates of a held offer are free). In memory: see the file header. */
  perDay: 24,
  /** The same coin is not offered again this soon after a review answered it. */
  cooldownMs: 60 * 60_000,
  /** An offer's own expiry is clamped to this far ahead, so no offer holds a slot indefinitely. */
  ttlMaxMs: 30 * 60_000,
  /**
   * How long a coin the Brain answered BUY stays in the book (and so on the
   * tape, in discovery and in the candidate list) for the strategy tick to
   * take its order. A ready order lives 60s (trencher-brain.ts take); the
   * slack covers a 60s tick plus a slow one.
   */
  decidedHoldMs: 3 * 60_000,
  /**
   * How long a coin's size ceiling outlives its entry. A review can be in
   * flight when an offer expires; the BUY it produces must still be bounded
   * by the ceiling it was offered under, never by the wider default.
   */
  capMemoryMs: 15 * 60_000,
  /** RESERVED REVIEW CAPACITY: one slot in every this many goes to an eligible early candidate. */
  reserveEvery: 4,
  /** The smallest ceiling worth a review: one cent. take() floors to cents. */
  minUsdg6: 10_000n,
} as const;

/** Tape pages kept for early candidates, at most — the book's own bound. */
export const EARLY_PAGES_MAX = EARLY.activeMax;

export type EarlyRefusal =
  | "invalid-address" | "zero-address" | "quote-asset" | "not-memecoin" | "energy-reserve"
  | "invalid-source" | "invalid-priority" | "invalid-size" | "invalid-probe" | "invalid-expiry" | "invalid-ref"
  | "expired" | "cooldown" | "awaiting-entry" | "full" | "daily";

export type EarlyOfferResult = "added" | "updated" | `refused:${EarlyRefusal}`;

export interface EarlyOffer {
  /** Code-chosen source label, e.g. "fomo-follow". Never user text. */
  source: string;
  /** Higher is looked at first among early candidates. Ordering only — never admission. */
  priority: number;
  /** The most this coin's entry may use, micro-USDG. A CEILING ONLY: take() uses the min with every existing bound. */
  maxUsdg6: bigint;
  /** An exploratory-size setup (Fomo PROBE_CANDIDATE). Carried as data; changes no limit. */
  probe: boolean;
  /** Epoch ms after which the offer is gone. Clamped to EARLY.ttlMaxMs ahead. */
  expiresAt: number;
  /** The source's own id for correlation (e.g. an assessment id). */
  ref?: string;
}

export interface EarlyEntry {
  address: string;
  source: string;
  priority: number;
  maxUsdg6: bigint;
  probe: boolean;
  expiresAt: number;
  ref: string | null;
  offeredAt: number;
  /** "waiting" for a review, or "decided": the Brain answered BUY and the entry tick may take it. */
  state: "waiting" | "decided";
  decidedAt: number | null;
  decisionId: string | null;
}

/** What `onReviewed` resolved, for a source that wants to correlate its offer. */
export interface EarlyReviewed {
  address: string;
  source: string;
  ref: string | null;
  action: string;
  decisionId: string | null;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = "0x" + "0".repeat(40);
const SOURCE = /^[a-z][a-z0-9-]{0,31}$/;
const REF = /^[A-Za-z0-9._:-]{1,96}$/;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const lower = (a: unknown) => (typeof a === "string" ? a.trim().toLowerCase() : "");
const validId = (id: unknown): id is string => typeof id === "string" && id.trim().length > 0;

/**
 * THE EARLY CANDIDATES THIS AGENT IS HOLDING, and every cap on them.
 *
 * One entry per coin. A coin moves waiting → (reviewed) → gone, or
 * waiting → decided (Brain BUY) → gone after `decidedHoldMs`; expiry ends
 * either. A coin a review answered cannot be offered again for
 * `cooldownMs`, so the early lane cannot keep re-asking about the same coin.
 */
export class EarlyCandidateBook {
  private entries = new Map<string, EarlyEntry>();
  /** Address → when a review last answered it (the cooldown). */
  private reviewedAt = new Map<string, number>();
  /** Address → the ceiling it was offered under, kept `capMemoryMs` past its entry. */
  private caps = new Map<string, { maxUsdg6: bigint; until: number }>();
  private day = "";
  private offersToday = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * THE ORDER OF THE REFUSALS IS THE ORDER OF THEIR COST, as in
   * NominationBook: everything decidable from the offer itself first, then
   * from what the book holds, and the day's counter last, so a refusal never
   * spends a day's offer. An update of a coin already waiting is free.
   *
   * A full book refuses the newcomer rather than dropping the oldest: a burst
   * of offers cannot flush a coin offered first.
   */
  offer(address: string, o: EarlyOffer): EarlyOfferResult {
    const a = lower(address);
    if (!ADDRESS.test(a)) return "refused:invalid-address";
    if (a === ZERO_ADDRESS) return "refused:zero-address";
    // Quote assets are cash, never a speculative entry; a known stock or ETF
    // token is not a memecoin and has its own rails.
    if ([CASH.USDG, CASH.WETH].some(c => c.toLowerCase() === a)) return "refused:quote-asset";
    if (instrumentClassOf(a) !== "memecoin") return "refused:not-memecoin";
    if (isEnergyReserveToken(a)) return "refused:energy-reserve";
    if (!o || typeof o !== "object") return "refused:invalid-source";
    if (typeof o.source !== "string" || !SOURCE.test(o.source)) return "refused:invalid-source";
    if (typeof o.priority !== "number" || !Number.isFinite(o.priority)) return "refused:invalid-priority";
    if (typeof o.maxUsdg6 !== "bigint" || o.maxUsdg6 < EARLY.minUsdg6) return "refused:invalid-size";
    if (typeof o.probe !== "boolean") return "refused:invalid-probe";
    if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt)) return "refused:invalid-expiry";
    if (o.ref !== undefined && (typeof o.ref !== "string" || !REF.test(o.ref))) return "refused:invalid-ref";
    const t = this.now();
    if (!Number.isFinite(t)) return "refused:invalid-expiry";
    if (o.expiresAt <= t) return "refused:expired";
    this.sweep(t);
    const expiresAt = Math.min(o.expiresAt, t + EARLY.ttlMaxMs);
    const existing = this.entries.get(a);
    if (existing) {
      // A decided coin's ceiling is the one its BUY was reviewed under; it
      // must not move between the review and the take.
      if (existing.state === "decided") return "refused:awaiting-entry";
      existing.source = o.source;
      existing.priority = o.priority;
      existing.maxUsdg6 = o.maxUsdg6;
      existing.probe = o.probe;
      existing.expiresAt = expiresAt;
      existing.ref = o.ref ?? null;
      this.rememberCap(existing, t);
      return "updated";
    }
    const reviewed = this.reviewedAt.get(a);
    if (reviewed !== undefined && t - reviewed < EARLY.cooldownMs) return "refused:cooldown";
    if (this.entries.size >= EARLY.activeMax) return "refused:full";
    const day = utcDay(t);
    if (day !== this.day) { this.day = day; this.offersToday = 0; }
    if (this.offersToday >= EARLY.perDay) return "refused:daily";
    this.offersToday++;
    const entry: EarlyEntry = {
      address: a, source: o.source, priority: o.priority, maxUsdg6: o.maxUsdg6, probe: o.probe,
      expiresAt, ref: o.ref ?? null, offeredAt: t, state: "waiting", decidedAt: null, decisionId: null,
    };
    this.entries.set(a, entry);
    this.rememberCap(entry, t);
    return "added";
  }

  /**
   * Every entry, in the order discovery verifies them: decided coins first —
   * their BUY is waiting to be taken and must not lose its verified pool to a
   * newer offer — then waiting ones by priority (highest first), oldest
   * offer first on a tie. Copies: a caller cannot edit the book through them.
   */
  active(): readonly Readonly<EarlyEntry>[] {
    this.sweep(this.now());
    return this.ordered().map(e => ({ ...e }));
  }

  /** Lowercased addresses of every entry, in `active()` order (a Set keeps insertion order). */
  addresses(): ReadonlySet<string> {
    this.sweep(this.now());
    return new Set(this.ordered().map(e => e.address));
  }

  /**
   * The coins still WAITING for a review, highest priority first — the order
   * the reserved review slot takes them in (trencher-brain.ts candidate). A
   * decided coin is not here: it has had its review.
   */
  priority(): ReadonlySet<string> {
    this.sweep(this.now());
    return new Set(this.ordered().filter(e => e.state === "waiting").map(e => e.address));
  }

  /** Whether the book holds this coin now (waiting or decided). */
  has(address: string): boolean {
    this.sweep(this.now());
    return this.entries.has(lower(address));
  }

  /**
   * THE PER-COIN CEILING FOR take(), USDG, floored to the cent — or null when
   * this coin was never offered (or its memory has passed). index.ts takes
   * `Math.min(existing bound, this)`, so it can only lower a size.
   *
   * Answered from the entry while it is held, and from the cap memory for
   * `capMemoryMs` after it leaves: a review launched while the coin was early
   * may finish after its offer expired, and that BUY is still an early
   * coin's BUY.
   */
  maxUsdgFor(address: string): number | null {
    const t = this.now();
    this.sweep(t);
    const a = lower(address);
    const e = this.entries.get(a);
    const max6 = e ? e.maxUsdg6 : this.caps.get(a)?.maxUsdg6;
    if (max6 === undefined) return null;
    return Number(max6 / 10_000n) / 100;
  }

  /**
   * A BRAIN REVIEW of this coin completed with a decision.
   *
   * BUY (with a decision id) → `decided`: the coin stays in the book for
   * `decidedHoldMs` so the strategy tick can still find it and take the
   * order, and leaves the priority list. Anything else → resolved now. Either
   * starts the cooldown. A coin the book does not hold is ignored, so the
   * caller may report every review.
   */
  onReviewed(address: string, r: { action: string; decisionId?: string | null }): EarlyReviewed | null {
    const t = this.now();
    this.sweep(t);
    const a = lower(address);
    const e = this.entries.get(a);
    if (!e || !r || typeof r.action !== "string") return null;
    if (e.state === "decided") return null;
    const action = r.action.toLowerCase();
    const decisionId = validId(r.decisionId) ? r.decisionId : null;
    this.reviewedAt.set(a, t);
    if (action === "buy" && decisionId) {
      e.state = "decided";
      e.decidedAt = t;
      e.decisionId = decisionId;
    } else {
      this.retire(e, t);
    }
    return { address: a, source: e.source, ref: e.ref, action, decisionId };
  }

  /** Drop every entry past its expiry. Returns the addresses that left, for the caller to log. */
  expire(): string[] {
    return this.sweep(this.now());
  }

  /**
   * A CONTEXT CHANGE (paper/live flip, new grant, new Brain) or a restart:
   * every entry is forgotten — never replayed. The caps are NOT reset: the
   * day's offer count, the review cooldowns and the remembered ceilings all
   * survive, so flipping a setting never hands out fresh allowance.
   */
  reset(): string[] {
    const t = this.now();
    this.sweep(t);
    const gone = [...this.entries.keys()];
    for (const e of [...this.entries.values()]) this.retire(e, t);
    return gone;
  }

  /**
   * RESERVED REVIEW CAPACITY. True when the NEXT review slot belongs to an
   * early candidate: at least one waits, and none of the last
   * `reserveEvery - 1` reviews (`lastReviews`, oldest first, as
   * TrenchBrainReview.recentLaunches gives them) was about an early coin. So
   * in any `reserveEvery` consecutive slots the early lane gets one — if an
   * ELIGIBLE one exists; the caller checks that — and the reviewer gives it no
   * more unless nothing else is eligible.
   */
  reservedSlot(lastReviews: readonly string[]): boolean {
    const t = this.now();
    this.sweep(t);
    if (![...this.entries.values()].some(e => e.state === "waiting")) return false;
    const window = (Array.isArray(lastReviews) ? lastReviews : []).slice(-(EARLY.reserveEvery - 1));
    return !window.some(r => this.wasEarly(lower(r), t));
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /** A review of this coin counted as an early slot: it is held, or a review answered it as one. */
  private wasEarly(a: string, t: number): boolean {
    if (this.entries.has(a)) return true;
    const at = this.reviewedAt.get(a);
    return at !== undefined && t - at < EARLY.cooldownMs;
  }

  private ordered(): EarlyEntry[] {
    return [...this.entries.values()].sort((x, y) =>
      (x.state === y.state ? 0 : x.state === "decided" ? -1 : 1) ||
      y.priority - x.priority ||
      x.offeredAt - y.offeredAt);
  }

  private rememberCap(e: EarlyEntry, t: number): void {
    this.caps.delete(e.address); // re-insert at the back: Map order is age
    this.caps.set(e.address, { maxUsdg6: e.maxUsdg6, until: Math.max(e.expiresAt, t) + EARLY.capMemoryMs });
  }

  private retire(e: EarlyEntry, t: number): void {
    this.entries.delete(e.address);
    this.caps.set(e.address, { maxUsdg6: e.maxUsdg6, until: t + EARLY.capMemoryMs });
  }

  /** Called at the top of every public method with that call's one reading of the clock. */
  private sweep(t: number): string[] {
    const gone: string[] = [];
    for (const e of [...this.entries.values()]) {
      const decidedOut = e.state === "decided" && e.decidedAt !== null && t - e.decidedAt >= EARLY.decidedHoldMs;
      if (t >= e.expiresAt || decidedOut) {
        this.retire(e, t);
        gone.push(e.address);
      }
    }
    for (const [a, at] of this.reviewedAt) if (t - at >= EARLY.cooldownMs) this.reviewedAt.delete(a);
    for (const [a, c] of this.caps) if (t >= c.until && !this.entries.has(a)) this.caps.delete(a);
    return gone;
  }
}

/**
 * THE ENTRY BOUND take() IS GIVEN (index.ts brainOrder): the existing bound,
 * lowered to the early ceiling when this coin has one. Never raised, and
 * never applied to a HELD coin — that call is a SELL review, and an entry
 * ceiling must not shrink an exit.
 */
export function earlyEntryBound(baseUsdg: number, earlyMaxUsdg: number | null, held: boolean): number {
  if (held || earlyMaxUsdg === null) return baseUsdg;
  return Math.min(baseUsdg, earlyMaxUsdg);
}

// ─── The early screen ───────────────────────────────────────────────────────

/** The only venue the TrencherVault route supports (TrencherVault.sol, trencher-discovery.ts). */
export const EARLY_VENUE = "uniswap-v3-robinhood";

/** The first rule of the early screen a pool failed. See `earlyScreenReason`. */
export type EarlyScreen =
  | "quote-asset" | "not-memecoin" | "energy-reserve" | "venue-not-supported" | "pool-address-unknown"
  | "buys-unknown" | "no-buys-24h" | "sells-unknown" | "no-sells-24h"
  | "activity-unknown" | "no-recent-volume" | "reserve-unknown" | "no-reserve";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * THE ROUTE-SPECIFIC EARLY SCREEN — used INSTEAD of the volume screen, for
 * early candidates only. The regular tape keeps `highVolumePools`, unchanged.
 *
 * What it asks is "could this coin's trade even be looked at sensibly on the
 * one route the vault supports?", not "is it big":
 *  - the pool is on `uniswap-v3-robinhood` and has a contract address — the
 *    only route TrencherVault can buy through, and the only kind discovery
 *    can verify against the canonical factory;
 *  - buys AND sells in 24h — two-sided: somebody has already got OUT, so an
 *    exit has been observed, not assumed;
 *  - fresh activity: 5-minute or 1-hour volume above zero;
 *  - a known, positive reserve.
 *
 * NULL IS UNKNOWN, never zero: a missing count is named as unknown and fails,
 * because "we could not see sells" is not "an exit was observed".
 *
 * WHAT IT DELIBERATELY DOES NOT ASK:
 *  - market cap / FDV. Missing FDV is UNKNOWN, not a reason to stop research.
 *    shouldEnter (strategies/trencher.ts) still requires it for an ENTRY,
 *    and the candidate builder still skips a coin without it (missing-fdv).
 *  - pool age. A new pool for an old token is not a new launch, so the pool's
 *    `createdAt` says nothing about the token here. shouldEnter's age floor
 *    (on the pool) is an execution guard and stays where it is.
 *  - 24h volume or distinct buyers. Those are the old screen's questions;
 *    depth, FDV and price quality are asked later by the execution guards.
 */
export function earlyScreenReason(p: GeckoPool): EarlyScreen | null {
  const token = lower(p?.tokenAddress);
  if ([CASH.USDG, CASH.WETH].some(a => a.toLowerCase() === token)) return "quote-asset";
  if (instrumentClassOf(token) !== "memecoin") return "not-memecoin";
  // Held as energy, never traded as a coin (discovery excludes it too).
  if (isEnergyReserveToken(token)) return "energy-reserve";
  if (p.dex !== EARLY_VENUE) return "venue-not-supported";
  if (!p.poolAddress || !ADDRESS.test(lower(p.poolAddress))) return "pool-address-unknown";
  if (!finite(p.buys24h)) return "buys-unknown";
  if (p.buys24h <= 0) return "no-buys-24h";
  if (!finite(p.sells24h)) return "sells-unknown";
  if (p.sells24h <= 0) return "no-sells-24h";
  const m5 = p.buckets?.m5?.volumeUsd;
  const h1 = p.buckets?.h1?.volumeUsd;
  if (!finite(m5) && !finite(h1)) return "activity-unknown";
  if (!((finite(m5) && m5 > 0) || (finite(h1) && h1 > 0))) return "no-recent-volume";
  if (!finite(p.reserveUsd)) return "reserve-unknown";
  if (p.reserveUsd <= 0) return "no-reserve";
  return null;
}

/** Busiest first; an unknown volume sorts last, never first. Deeper reserve breaks ties. */
function earlyRank(a: GeckoPool, b: GeckoPool): number {
  const v = (p: GeckoPool) => (finite(p.volume24hUsd) ? p.volume24hUsd : -1);
  const r = (p: GeckoPool) => (finite(p.reserveUsd) ? p.reserveUsd : -1);
  return v(b) - v(a) || r(b) - r(a);
}

/**
 * The pool discovery verifies for each early coin: its busiest pool that
 * passes the early screen, one per token, in the order `early` lists the
 * tokens (the book's: decided first, then priority). Tokens in `skip` are
 * left out — discovery already reads them through the regular slice.
 */
export function earlyVerifyPools(pools: readonly GeckoPool[], early: Iterable<string>, skip: ReadonlySet<string> = new Set()): GeckoPool[] {
  const best = new Map<string, GeckoPool>();
  for (const p of pools) {
    const token = lower(p?.tokenAddress);
    if (!token || earlyScreenReason(p) !== null) continue;
    const prior = best.get(token);
    if (!prior || earlyRank(p, prior) < 0) best.set(token, p);
  }
  const out: GeckoPool[] = [];
  const seen = new Set<string>();
  for (const raw of early) {
    const a = lower(raw);
    if (!ADDRESS.test(a) || seen.has(a) || skip.has(a)) continue;
    seen.add(a);
    const p = best.get(a);
    if (p) out.push(p);
  }
  return out;
}

/**
 * THE EARLY COINS THE CANDIDATE BUILDER ADDS (index.ts trenchCandidates),
 * beside the regular `highVolumePools` list and never instead of it.
 *
 * One pool per early token that is not already a regular candidate, passing
 * the early screen. When `qualified` is given (the autonomous path), only a
 * pool discovery VERIFIED on chain counts — the same match the regular list
 * makes — so an unverified pool can never become a candidate. Everything
 * after this (watchTokens, the allowlist, the vault budget, createdAt and FDV
 * present, shouldEnter, pricing, policy, the vault) is applied by the caller
 * exactly as for a regular coin.
 */
export function earlyEntryPools(
  tape: readonly GeckoPool[],
  early: ReadonlySet<string>,
  opts: { regular: ReadonlySet<string>; qualified?: readonly Pick<GeckoPool, "poolAddress" | "tokenAddress">[] | null },
): GeckoPool[] {
  if (!early.size) return [];
  const wanted = new Set([...early].map(lower));
  const regular = new Set([...opts.regular].map(lower));
  const qualified = opts.qualified ?? null;
  const best = new Map<string, GeckoPool>();
  for (const p of tape) {
    const token = lower(p?.tokenAddress);
    if (!wanted.has(token) || regular.has(token) || earlyScreenReason(p) !== null) continue;
    if (qualified && !qualified.some(q => q.poolAddress === p.poolAddress && lower(q.tokenAddress) === token)) continue;
    const prior = best.get(token);
    if (!prior || earlyRank(p, prior) < 0) best.set(token, p);
  }
  return [...best.values()].sort(earlyRank);
}

// ─── The funnel's words for the early path ──────────────────────────────────

export type EarlyFunnelEvent =
  | { kind: "screen"; reason: EarlyScreen }
  | { kind: "verified" }
  | { kind: "not-verified" }
  | { kind: "verify-deferred" };

/**
 * Where an early coin stopped, in the decision funnel's vocabulary
 * (decision-funnel.ts FunnelRecorder.note). Filed through the same recorder as
 * every other coin; it reads verdicts and never makes one.
 *
 *  - `early-screen:<reason>`  the early screen dropped it (an unsupported
 *                             venue is UNSUPPORTED_ROUTE, like discovery's);
 *  - `early-not-verified`     its pool did not verify on chain;
 *  - `early-verify-deferred`  more early coins than EARLY_VERIFY_MAX this
 *                             pass; it is read on a later one;
 *  - `early-verified`         verified and waiting for review: research is
 *                             not done yet, so RESEARCH_INCOMPLETE until a
 *                             later stage (entry screen, Brain) is filed.
 */
export function earlyFunnelOf(e: EarlyFunnelEvent): Classified {
  switch (e.kind) {
    case "screen":
      return { stage: e.reason === "venue-not-supported" ? "UNSUPPORTED_ROUTE" : "DISCOVERY_SCREENED_OUT", detail: `early-screen:${e.reason}` };
    case "not-verified":
      return { stage: "DISCOVERY_SCREENED_OUT", detail: "early-not-verified" };
    case "verify-deferred":
      return { stage: "RESEARCH_INCOMPLETE", detail: "early-verify-deferred" };
    case "verified":
      return { stage: "RESEARCH_INCOMPLETE", detail: "early-verified" };
  }
}

// ─── The process-wide accessor ──────────────────────────────────────────────

let installed: EarlyCandidateBook | null = null;

/**
 * index.ts main() installs the one book of this process here. A source that
 * runs in the same process (the Fomo child-file reader) offers through
 * `earlyCandidateBook()?.offer(address, {...})` — null before main() wired it,
 * which a caller must read as "not ready", never as permission.
 */
export function installEarlyCandidateBook(book: EarlyCandidateBook | null): void {
  installed = book;
}

export function earlyCandidateBook(): EarlyCandidateBook | null {
  return installed;
}
