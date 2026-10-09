/**
 * FRESHNESS — when a cached copy may answer, when to ask upstream, and how to
 * say which one happened.
 *
 * Every read in this subsystem is a trade between three things: what the
 * caller asked for (`FreshnessMode`), how old the copy we hold is, and whether
 * a retrieval budget will pay for a new one. This module decides that trade in
 * one pure function and records the outcome in the `Freshness` block every
 * envelope carries. It performs no I/O, holds no cache and reads no clock of
 * its own: the caller passes `now`.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────
 *
 * NEVER SILENTLY SUBSTITUTE AN OLD RESULT. When someone says "refresh", "latest"
 * or "check now" and we do not reach upstream — because the budget refused,
 * because the last attempt failed a moment ago, because the fetch failed — the
 * answer is the old copy LABELLED `stale-cache` with the reason, or nothing at
 * all. It is never the old copy dressed as `live` or `cache`. An agent that
 * acts on "the latest holdings" must be able to tell that it got yesterday's.
 *
 * ── WHY THE TTL RUNS ON `retrievedAt` AND NOT ON `providerAsOf` ──────────
 *
 * Token stats and the token boards sit behind the provider's own five-minute
 * cache, and the leaderboard can come back as the provider's last captured
 * copy when its upstream does not answer. Asking again sooner returns the same
 * provider copy at full credit price. So the policy below decides when WE ask
 * again, from when WE last asked; `providerAsOf` is carried through untouched
 * so the answer can say how old the provider's copy was. The two clocks are
 * reported side by side and never merged.
 *
 * ── TWO CLOCK SANITY RULES ───────────────────────────────────────────────
 *
 * Replicas share one Postgres, so a `retrievedAt` written by another process
 * can sit a few seconds in our future. Within `CLOCK_SKEW_TOLERANCE_MS` that is
 * read as age zero. Beyond it the copy's age is UNKNOWN, and a copy of unknown
 * age is neither fresh nor fit to show: we cannot label it honestly.
 *
 * Provider timestamps are untrusted. One in our future by more than
 * `PROVIDER_CLOCK_TOLERANCE_MS` is dropped to null rather than shown as
 * "as of tomorrow".
 */

import type { Freshness, FreshnessClass, FreshnessMode } from "./types";

export interface FreshnessPolicy {
  /** A copy younger than this answers prefer-fresh without asking upstream. */
  maxAgeMs: number;
  /** The oldest copy ever shown, labelled, when upstream is not reached. Older is "nothing". */
  staleServeMaxMs: number;
}

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Per-class policy. Each pair is (how often a question is worth a credit,
 * how long an old answer is still worth showing with its age).
 *
 *   activity     trades move in seconds; an hour-old feed is a different market
 *   holdings     a snapshot, valued at current prices; it drifts with price
 *   rankings     the provider's board turns over slowly; a day-old board is still a board
 *   theses       accumulate and are rarely edited; a week-old set is still the set
 *   token-stats  provider caches five minutes, so asking sooner buys nothing
 *   profile      counts and age move slowly
 *   boards       provider caches five minutes, as token-stats
 */
export const FRESHNESS_POLICY: Readonly<Record<FreshnessClass, Readonly<FreshnessPolicy>>> = Object.freeze({
  activity: Object.freeze({ maxAgeMs: 60 * SEC, staleServeMaxMs: 30 * MIN }),
  holdings: Object.freeze({ maxAgeMs: 5 * MIN, staleServeMaxMs: 6 * HOUR }),
  rankings: Object.freeze({ maxAgeMs: 15 * MIN, staleServeMaxMs: 24 * HOUR }),
  theses: Object.freeze({ maxAgeMs: 30 * MIN, staleServeMaxMs: 7 * DAY }),
  "token-stats": Object.freeze({ maxAgeMs: 5 * MIN, staleServeMaxMs: 2 * HOUR }),
  profile: Object.freeze({ maxAgeMs: 1 * HOUR, staleServeMaxMs: 7 * DAY }),
  boards: Object.freeze({ maxAgeMs: 5 * MIN, staleServeMaxMs: 2 * HOUR }),
});

/**
 * HOW LONG A TELEGRAM GROUP MAY REUSE A COPY (decision D7, 2026-10-07). A
 * room's research is rationed per hour, and one coin's theses cost a page
 * at full price; a copy a few minutes past its class window is still the
 * set, and the room hears its age ("From a copy fetched 2h ago."). Only the
 * slow classes stretch: activity, holdings, token stats and profiles keep
 * their own windows. Never past the class's longest shown age
 * (staleServeMaxMs), and never for a room's "now" (service.ts turns that
 * into an ordinary read with no reuse, decision D8).
 */
export const GROUP_REUSE_MS: Readonly<Partial<Record<FreshnessClass, number>>> = Object.freeze({
  theses: 2 * HOUR,
  rankings: 1 * HOUR,
  boards: 15 * MIN,
});

/** A `retrievedAt` this far in our future is read as age zero (replica clock skew). */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * SEC;
/** A provider timestamp further than this in our future is not believed. */
export const PROVIDER_CLOCK_TOLERANCE_MS = 60 * SEC;
/** After a failed attempt, prefer-fresh and cached-ok reads wait this long before asking again. */
export const DEFAULT_FAILURE_BACKOFF_MS = 30 * SEC;
/**
 * Even force-refresh does not re-ask inside this window after a failure. A
 * person typing "refresh" twice is two requests; a provider that failed two
 * seconds ago is not going to have recovered, and a tool loop retrying in a
 * tight cycle would otherwise spend a credit per turn on the same 503.
 */
export const FORCE_REFRESH_MIN_RETRY_MS = 2 * SEC;

const STRICTEST: Readonly<FreshnessPolicy> = Object.freeze({ maxAgeMs: 0, staleServeMaxMs: 0 });

/** The class policy; an unknown class gets the strictest one (always ask, never serve old). */
export function policyFor(cls: FreshnessClass): Readonly<FreshnessPolicy> {
  return Object.prototype.hasOwnProperty.call(FRESHNESS_POLICY, cls) ? FRESHNESS_POLICY[cls] : STRICTEST;
}

/**
 * Tool arguments arrive from a model. Only the three documented values are
 * honoured; anything else is the default, prefer-fresh. Mapping words like
 * "latest" to force-refresh is the tool layer's job, not this parser's.
 */
export function normalizeFreshnessMode(raw: unknown): FreshnessMode {
  return raw === "cached-ok" || raw === "prefer-fresh" || raw === "force-refresh" ? raw : "prefer-fresh";
}

// ── The decision ─────────────────────────────────────────────────────────

/** What we hold about one cache key. `retrievedAt` null: attempts recorded, no copy held. */
export interface CacheEntryState {
  retrievedAt: number | null;
  providerAsOf: number | null;
  lastAttemptAt: number | null;
  lastAttemptOutcome: Freshness["lastRefreshOutcome"];
}

export type ReadAction = "serve-cache" | "fetch" | "serve-stale" | "nothing";

/**
 * Stable machine reasons:
 *   fresh            the copy is within maxAge
 *   accepted-age     cached-ok: older than maxAge but within staleServeMax
 *   no-copy          nothing usable held (none, too old, or unknown age)
 *   expired          prefer-fresh: the copy is older than maxAge
 *   force-refresh    the caller demanded upstream
 *   budget-refused   upstream was wanted; the retrieval budget said no
 *   failure-backoff  the last attempt failed too recently to try again
 *   invalid-clock    `now` was not a usable time
 */
export type ReadReason =
  | "fresh"
  | "accepted-age"
  | "no-copy"
  | "expired"
  | "force-refresh"
  | "budget-refused"
  | "failure-backoff"
  | "invalid-clock";

export interface ReadDecision {
  action: ReadAction;
  reason: ReadReason;
  /**
   * The refresh outcome for THIS request when no fetch is made
   * ("skipped-fresh", "skipped-budget", or "failed" while backing off).
   * Null when `action` is "fetch": the fetch decides it ("ok" or "failed").
   */
  lastRefreshOutcome: Freshness["lastRefreshOutcome"];
  /** How to label what is served. Null when `action` is "fetch" (live on success, `onFailure` otherwise). */
  servedFrom: Freshness["servedFrom"] | null;
  /** When `action` is "fetch" and the fetch fails: show the labelled old copy, or nothing. */
  onFailure: "serve-stale" | "nothing";
  /** Age of the held copy at `now`; null when none is held or its age is unknown. */
  cacheAgeMs: number | null;
  policy: Readonly<FreshnessPolicy>;
}

export interface DecideReadInput {
  entry: CacheEntryState | null;
  cls: FreshnessClass;
  mode: FreshnessMode;
  now: number;
  /**
   * Whether a retrieval budget will pay for an upstream call. Ask it only when
   * this function first answers "fetch" with `budgetAvailable: true`, then
   * call again with `false` if the budget refuses: the function is pure, so
   * the second call is the honest answer for a refused budget.
   */
  budgetAvailable: boolean;
  /** Back-off after a failed attempt for non-forced reads (default 30 s). */
  recentFailureBackoffMs?: number;
  /**
   * A longer window in which a held copy still counts as fresh (a Telegram
   * group's GROUP_REUSE_MS): max(class window, reuseMs), capped at the
   * class's staleServeMaxMs. Ignored under force-refresh, and when not a
   * finite, non-negative number.
   */
  reuseMs?: number;
}

function finiteOrNull(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** now − at, clamped to zero inside the skew tolerance; null when unknown or too far in the future. */
function ageAt(at: number | null, now: number): number | null {
  const t = finiteOrNull(at);
  if (t === null) return null;
  const age = now - t;
  if (age >= 0) return age;
  return -age <= CLOCK_SKEW_TOLERANCE_MS ? 0 : null;
}

export function decideRead(input: DecideReadInput): ReadDecision {
  const policy = policyFor(input.cls);
  const mode = normalizeFreshnessMode(input.mode);
  const now = finiteOrNull(input.now);
  const backoffRaw = finiteOrNull(input.recentFailureBackoffMs);
  const backoffMs = backoffRaw !== null && backoffRaw >= 0 ? backoffRaw : DEFAULT_FAILURE_BACKOFF_MS;

  if (now === null) {
    return { action: "nothing", reason: "invalid-clock", lastRefreshOutcome: null, servedFrom: "none", onFailure: "nothing", cacheAgeMs: null, policy };
  }

  const entry = input.entry;
  const cacheAgeMs = entry ? ageAt(entry.retrievedAt, now) : null;
  const reuse = finiteOrNull(input.reuseMs);
  const freshFor = mode !== "force-refresh" && reuse !== null && reuse >= 0 ? Math.min(Math.max(policy.maxAgeMs, reuse), policy.staleServeMaxMs) : policy.maxAgeMs;
  const fresh = cacheAgeMs !== null && cacheAgeMs <= freshFor;
  // Fit to show at all, labelled with its age. Beyond this it is "nothing".
  const showable = cacheAgeMs !== null && cacheAgeMs <= policy.staleServeMaxMs;
  const onFailure = showable ? "serve-stale" : "nothing";

  const failedAge = entry && entry.lastAttemptOutcome === "failed" ? ageAt(entry.lastAttemptAt, now) : null;
  const backingOff = failedAge !== null && failedAge < backoffMs;
  const forceBackingOff = failedAge !== null && failedAge < FORCE_REFRESH_MIN_RETRY_MS;

  const base = { cacheAgeMs, policy, onFailure } as const;
  const serveCache = (reason: ReadReason): ReadDecision =>
    ({ ...base, action: "serve-cache", reason, lastRefreshOutcome: "skipped-fresh", servedFrom: "cache" });
  const goUpstream = (reason: ReadReason): ReadDecision =>
    ({ ...base, action: "fetch", reason, lastRefreshOutcome: null, servedFrom: null });
  // Upstream was wanted and not reached: the old copy, labelled, or nothing.
  const fallBack = (reason: ReadReason, outcome: "skipped-budget" | "failed"): ReadDecision =>
    showable
      ? { ...base, action: "serve-stale", reason, lastRefreshOutcome: outcome, servedFrom: "stale-cache" }
      : { ...base, action: "nothing", reason, lastRefreshOutcome: outcome, servedFrom: "none" };

  if (mode === "force-refresh") {
    // Freshness of the copy is irrelevant: the caller asked for upstream.
    if (forceBackingOff) return fallBack("failure-backoff", "failed");
    if (!input.budgetAvailable) return fallBack("budget-refused", "skipped-budget");
    return goUpstream("force-refresh");
  }

  if (fresh) return serveCache("fresh");
  if (mode === "cached-ok" && showable) return serveCache("accepted-age");

  // prefer-fresh with an expired copy, or either mode with nothing showable.
  const why: ReadReason = showable ? "expired" : "no-copy";
  if (backingOff) return fallBack("failure-backoff", "failed");
  if (!input.budgetAvailable) return fallBack("budget-refused", "skipped-budget");
  return goUpstream(why);
}

// ── The record ───────────────────────────────────────────────────────────

export interface BuildFreshnessInput {
  cls: FreshnessClass;
  mode: FreshnessMode;
  now: number;
  servedFrom: Freshness["servedFrom"];
  /** When WE fetched the bytes being served. */
  retrievedAt: number | null;
  /** When the provider says its copy was captured. Never defaulted from retrievedAt. */
  providerAsOf: number | null;
  /** Times of the underlying events in what is served; the range is computed here. */
  sourceEventTimes?: Iterable<number | null | undefined>;
  /** When we last TRIED to refresh, successful or not. Never defaulted from retrievedAt. */
  lastRefreshAttemptAt: number | null;
  lastRefreshOutcome: Freshness["lastRefreshOutcome"];
}

/** Oldest and newest of the finite, positive times given; nulls when there are none. */
export function sourceEventRange(
  times: Iterable<number | null | undefined> | undefined,
  notAfter: number | null = null,
): Freshness["sourceEventAt"] {
  let oldest: number | null = null;
  let newest: number | null = null;
  if (times) {
    for (const t of times) {
      if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) continue;
      if (notAfter !== null && t > notAfter + PROVIDER_CLOCK_TOLERANCE_MS) continue;
      if (oldest === null || t < oldest) oldest = t;
      if (newest === null || t > newest) newest = t;
    }
  }
  return { oldest, newest };
}

/**
 * The `Freshness` block for an envelope. Five clocks stay five fields:
 * nothing here fills one from another, because "we fetched it a second ago"
 * does not mean "the provider captured it a second ago", and neither means
 * "the trade happened a second ago".
 *
 * `servedFrom: "none"` describes no copy, so every copy clock is null; the
 * refresh-attempt fields still say what was tried.
 */
export function buildFreshness(input: BuildFreshnessInput): Freshness {
  const now = finiteOrNull(input.now);
  const mode = normalizeFreshnessMode(input.mode);
  const servedFrom = input.servedFrom;
  const lastRefreshAttemptAt = finiteOrNull(input.lastRefreshAttemptAt);
  const lastRefreshOutcome = input.lastRefreshOutcome ?? null;
  if (servedFrom === "none") {
    return {
      policy: input.cls,
      mode,
      retrievedAt: null,
      providerAsOf: null,
      sourceEventAt: { oldest: null, newest: null },
      lastRefreshAttemptAt,
      lastRefreshOutcome,
      cacheAgeMs: null,
      servedFrom,
    };
  }
  const retrievedAt = finiteOrNull(input.retrievedAt);
  const ceiling = retrievedAt ?? now;
  let providerAsOf = finiteOrNull(input.providerAsOf);
  if (providerAsOf !== null && (providerAsOf <= 0 || (ceiling !== null && providerAsOf > ceiling + PROVIDER_CLOCK_TOLERANCE_MS))) {
    providerAsOf = null;
  }
  return {
    policy: input.cls,
    mode,
    retrievedAt,
    providerAsOf,
    sourceEventAt: sourceEventRange(input.sourceEventTimes, ceiling),
    lastRefreshAttemptAt,
    lastRefreshOutcome,
    cacheAgeMs: now === null ? null : ageAt(retrievedAt, now),
    servedFrom,
  };
}

// ── Single-flight refresh ────────────────────────────────────────────────

export interface SingleFlightRunOptions {
  /**
   * A force-refresh: join an in-flight fetch only if it started at or after
   * `requestedAt − joinWindowMs`. Otherwise wait for it and start a new one.
   */
  force?: boolean;
  /** When the request was made (default: the flight's clock now). */
  requestedAt?: number;
  /** Stops THIS caller waiting. The shared fetch carries on for everyone else. */
  signal?: AbortSignal;
}

export interface SingleFlightResult<V> {
  value: V;
  /** True when this caller joined a fetch someone else started (it should not be charged twice). */
  shared: boolean;
  /** When the fetch that produced `value` started. */
  startedAt: number;
}

interface Flight<V> {
  startedAt: number;
  promise: Promise<V>;
}

const NOOP = (): void => {};

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("aborted");
}

function untilSettledOrAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

/**
 * ONE UPSTREAM CALL PER KEY AT A TIME.
 *
 * Ten people asking about the same coin in the same second is one provider
 * call, not ten: identical refreshes share one in-flight promise keyed by the
 * cache key. Every joiner gets the leader's value or the leader's error, and
 * the slot is cleared when the fetch settles either way, so a failure is never
 * cached here (the caller's cache records it, and `decideRead` backs off).
 *
 * THE FORCE-REFRESH RULE. "Check now" must not be answered by a fetch that
 * began before the question, because that fetch may have read the provider
 * before the event the person is asking about. A force request therefore
 * joins only a fetch that started within `joinWindowMs` of the request. An
 * older in-flight fetch is WAITED FOR, not raced: two concurrent fetches for
 * one key could finish out of order and leave the older copy in the cache.
 * After it settles the force request starts its own (or joins one another
 * force request started in the meantime, which by construction is new enough).
 *
 * The check and the slot write happen with no await between them, so
 * interleaved callers in one process cannot both start a fetch. Across
 * replicas this is not a lock; the retrieval budget bounds the duplicates.
 */
export class SingleFlight<V> {
  private readonly flights = new Map<string, Flight<V>>();
  private readonly now: () => number;
  readonly joinWindowMs: number;

  constructor(opts: { now?: () => number; joinWindowMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    const w = opts.joinWindowMs;
    this.joinWindowMs = typeof w === "number" && Number.isFinite(w) && w >= 0 ? w : 2_000;
  }

  /** The in-flight fetch for `key`, if any. */
  inFlight(key: string): { startedAt: number } | null {
    const f = this.flights.get(key);
    return f ? { startedAt: f.startedAt } : null;
  }

  get size(): number {
    return this.flights.size;
  }

  async run(key: string, fn: (startedAt: number) => Promise<V>, opts: SingleFlightRunOptions = {}): Promise<V> {
    return (await this.runDetailed(key, fn, opts)).value;
  }

  async runDetailed(
    key: string,
    fn: (startedAt: number) => Promise<V>,
    opts: SingleFlightRunOptions = {},
  ): Promise<SingleFlightResult<V>> {
    const req = opts.requestedAt;
    const requestedAt = typeof req === "number" && Number.isFinite(req) ? req : this.now();
    const force = opts.force === true;
    for (;;) {
      if (opts.signal?.aborted) throw abortError(opts.signal);
      const current = this.flights.get(key);
      if (!current) {
        const mine = this.start(key, fn);
        return { value: await untilSettledOrAborted(mine.promise, opts.signal), shared: false, startedAt: mine.startedAt };
      }
      if (!force || current.startedAt >= requestedAt - this.joinWindowMs) {
        return { value: await untilSettledOrAborted(current.promise, opts.signal), shared: true, startedAt: current.startedAt };
      }
      // Too old for this request. Its outcome is not ours to report; wait it out.
      await untilSettledOrAborted(current.promise.then(NOOP, NOOP), opts.signal);
    }
  }

  private start(key: string, fn: (startedAt: number) => Promise<V>): Flight<V> {
    const startedAt = this.now();
    const flight: Flight<V> = { startedAt, promise: undefined as unknown as Promise<V> };
    // The slot is written before `fn` runs (it runs on a microtask), so a
    // re-entrant call for the same key joins instead of starting a second
    // fetch, and a synchronous throw becomes a rejection every joiner sees.
    flight.promise = Promise.resolve().then(() => fn(startedAt));
    this.flights.set(key, flight);
    // Registered first, so the slot is clear before any joiner's continuation
    // runs; it also marks the rejection handled when nobody else is waiting.
    const clear = (): void => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    };
    flight.promise.then(clear, clear);
    return flight;
  }
}
