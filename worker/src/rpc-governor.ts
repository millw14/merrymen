/**
 * THE LIMITER rpc-meter.ts PROMISED, AND THE RETRY POLICY IT HAS TO TAKE OVER.
 *
 * rpc-meter.ts ends with: "It is also the seam. When the limiter arrives it goes
 * here, and no call site changes." This is the limiter. It arrives with a
 * diagnosis rather than a guess, because the fleet's problem turned out not to
 * be volume at all.
 *
 * WHAT WAS MEASURED, 2026-09-09.
 *
 *   The endpoint, from an unrelated IP, over Node's own fetch with keep-alive —
 *   the same client stack the fleet uses:
 *       5/s   0 refused
 *      20/s   0 refused
 *      50/s   0 refused
 *     100/s   132 of 600 refused
 *   and a 20-call JSON-RPC batch is ONE http request answered in the same 940ms
 *   as a single call, with `x-envoy-upstream-service-time: 1`.
 *
 *   The fleet, at the same time: 11.2 logical calls a second across 15 children
 *   — a median of 0.68/s each. Against a ceiling somewhere between 50 and 100.
 *
 * SO THE FLEET IS NOWHERE NEAR CAPACITY, and yet 141 of 251 sampled meter
 * windows reported rate limiting, the worst of them 85 calls and 85 refusals.
 * A system an order of magnitude under its limit that collapses anyway is not
 * overloaded. It is METASTABLE: something multiplies a small perturbation into
 * an overload, and the overload feeds itself.
 *
 * THE MULTIPLIER, found in viem's own source. `buildRequest`'s `shouldRetry`
 * returns TRUE for status 429 (utils/buildRequest.js:141), and `chainRead` never
 * set `retryCount`, so viem's default of 3 applied. Every refusal became four
 * requests — issued 150ms, 300ms and 600ms after the endpoint said stop, into
 * the very limiter that had just said it. The arithmetic is visible in the
 * production logs: refused calls average 1624ms where successful ones average
 * 210ms, and 210 + 150 + 300 + 600 is 1260ms of waiting plus four requests.
 *
 * At 11 logical calls a second that multiplier alone reaches ~44 requests a
 * second, and `getLogsAdaptive` retries a rate limit again on top of it. Once
 * the first refusal lands, the retries generate the load that causes the next
 * one. That is the whole failure: the fleet DDoSes itself out of a 5% overshoot,
 * then recovers when the retries drain — which is exactly the bursty,
 * self-healing pattern in the samples.
 *
 * WHAT THIS MODULE DOES ABOUT IT.
 *
 *   1. NEVER RETRY A REFUSAL INTO THE THING THAT REFUSED. viem's http transport
 *      exposes `retryCount` and `retryDelay` and NOT `shouldRetry`, so there is
 *      no way to keep its retry for a network blip and drop it for a 429. The
 *      only correct setting is `retryCount: 0`, and the policy moves here where
 *      it can tell the two apart.
 *
 *   2. BACK OFF WITH FULL JITTER, NOT A FIXED DELAY. Fifteen children that all
 *      retry 132ms after a refusal retry TOGETHER, which reassembles the burst
 *      that caused it. Full jitter — a uniform draw over the whole window rather
 *      than a fixed delay — is the standard fix and the one thing that turns a
 *      synchronised fleet back into a spread one.
 *
 *   3. SHARE THE REFUSAL ACROSS PROCESSES. The children are separate OS
 *      processes in one container behind one egress IP, so a per-process
 *      breaker is fifteen breakers that each have to learn the same fact by
 *      being refused. `coolUntil` is a single number in the shared home — the
 *      pattern FLEET_HALT and the beat files already use — so the first child
 *      refused tells the other fourteen to stop asking.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 *   NOT THE SEND PATH. `eth_sendUserOperation` lives under the send-edge rules
 *   — persist the hash, send once, never re-send — and a queue that delays or a
 *   breaker that refuses is the wrong shape for an operation that must not be
 *   silently retried. This governs reads.
 *
 *   NO CACHING, NO DEDUPE, NO REORDERING. The meter's own rule is that a
 *   transport which changed an outcome would be measuring itself. This changes
 *   WHEN a request is made and whether a refusal is repeated; it never changes
 *   which call is made or what it returns.
 *
 * PURE. Every function here is a decision over numbers. The clock, the
 * filesystem and the transport are the caller's.
 */

/** What a governor decides to do with one request, right now. */
export type Decision =
  | { act: "send" }
  /** Hold this long first, then send. */
  | { act: "wait"; ms: number }
  /** The breaker is open; do not send at all. */
  | { act: "refuse"; ms: number };

export interface GovernorLimits {
  /**
   * Sustained HTTP REQUESTS a second this process may issue.
   *
   * REQUESTS, NOT LOGICAL CALLS — the governor runs under viem's batcher, so
   * one token buys one round trip however many calls ride in it. Measured
   * against the live transport: thirteen logical calls left as a single
   * request. That is the unit the endpoint counts, and it is why the numbers
   * here look small next to the fleet's 11.2 logical calls a second.
   *
   * DEFAULT SIZED TO THE FLEET, NOT TO ONE CHILD. The measured clean rate is
   * 50/s for the whole egress IP. Fifteen children at 2/s is 30/s worst case
   * with room left for the web service, and a healthy child — whose tick is
   * three requests every four minutes — never comes near it. This bounds a
   * runaway; it does not pace normal work.
   */
  ratePerSec: number;
  /**
   * How much of that rate may be spent at once.
   *
   * Sized to the most expensive thing a child legitimately does in one go: a
   * cold arm is ~28 strictly sequential requests, and the depth reader ~20. A
   * burst of twelve lets the front of either through untouched and paces the
   * tail, which costs an arm about eight seconds and a tick about four —
   * against a 240-second tick.
   */
  burst: number;
  /** Requests in flight at once, per process. */
  maxInFlight: number;
  /** Shortest backoff after a refusal, before jitter. */
  baseBackoffMs: number;
  /** Longest backoff, however many refusals in a row. */
  maxBackoffMs: number;
}

export const DEFAULT_LIMITS: GovernorLimits = Object.freeze({
  ratePerSec: 2,
  burst: 12,
  maxInFlight: 6,
  baseBackoffMs: 1_000,
  maxBackoffMs: 30_000,
});

export interface GovernorState {
  /** Tokens available now. Fractional: it refills continuously. */
  tokens: number;
  /** When `tokens` was last brought up to date. */
  refilledAt: number;
  /** Requests currently out. */
  inFlight: number;
  /** Consecutive refusals, for the backoff ladder. Reset by a success. */
  strikes: number;
  /** Epoch ms before which nothing may be sent. Shared across the container. */
  coolUntil: number;
}

export const freshState = (now: number): GovernorState => ({
  tokens: DEFAULT_LIMITS.burst,
  refilledAt: now,
  inFlight: 0,
  strikes: 0,
  coolUntil: 0,
});

/**
 * Bring the bucket up to date. Separated so every decision below reads a bucket
 * that is current without any of them owning the clock.
 */
export function refill(s: GovernorState, now: number, lim: GovernorLimits): GovernorState {
  const elapsed = Math.max(0, now - s.refilledAt);
  if (elapsed === 0) return s;
  const gained = (elapsed / 1000) * lim.ratePerSec;
  return { ...s, tokens: Math.min(lim.burst, s.tokens + gained), refilledAt: now };
}

/**
 * May this request go now, and if not, how long is the wait?
 *
 * ORDERED SO THE MOST DECISIVE ANSWER WINS. A cooldown is the endpoint's own
 * verdict and outranks anything we think about our own rate; concurrency is a
 * property of this instant; the bucket is the long-run rate.
 */
export function decide(s: GovernorState, now: number, lim: GovernorLimits): Decision {
  if (s.coolUntil > now) return { act: "refuse", ms: s.coolUntil - now };
  if (s.inFlight >= lim.maxInFlight) return { act: "wait", ms: 25 };
  const r = refill(s, now, lim);
  if (r.tokens >= 1) return { act: "send" };
  // How long until one token exists. Never zero, or a caller spins.
  const need = 1 - r.tokens;
  return { act: "wait", ms: Math.max(10, Math.ceil((need / lim.ratePerSec) * 1000)) };
}

/** Spend a token and count the request out. Call only after `decide` said send. */
export function begin(s: GovernorState, now: number, lim: GovernorLimits): GovernorState {
  const r = refill(s, now, lim);
  return { ...r, tokens: Math.max(0, r.tokens - 1), inFlight: r.inFlight + 1 };
}

/**
 * A request came back. `refused` means the endpoint said no — a 429, or
 * anything `classifyRpcError` files as rate-limited.
 *
 * A SUCCESS CLEARS THE LADDER COMPLETELY. Decaying the strike count instead
 * would leave a fleet that had one bad minute backing off into a healthy one,
 * which is how a limiter becomes the outage it was added to prevent.
 */
export function end(
  s: GovernorState,
  now: number,
  lim: GovernorLimits,
  outcome: { refused: boolean; retryAfterMs?: number | null },
  /**
   * A uniform draw in [0,1). Passed in rather than taken, so the backoff is
   * testable and the module stays pure — this file must not reach for
   * Math.random any more than it reaches for Date.now.
   */
  rand: number,
): GovernorState {
  const inFlight = Math.max(0, s.inFlight - 1);
  if (!outcome.refused) return { ...s, inFlight, strikes: 0 };
  const strikes = Math.min(s.strikes + 1, 16);
  const ms = backoffMs(strikes, lim, rand, outcome.retryAfterMs ?? null);
  // NEVER SHORTEN A COOLDOWN somebody else set. Fifteen children share this
  // number; the longest opinion is the safe one, and a child whose own strike
  // count is low must not pull the fleet back in early.
  return { ...s, inFlight, strikes, coolUntil: Math.max(s.coolUntil, now + ms) };
}

/**
 * FULL JITTER, which is the whole point of the ladder.
 *
 * The window doubles per strike, and the wait is a UNIFORM DRAW over it rather
 * than the window itself. Fifteen children backing off by the same computed
 * delay come back in the same millisecond and rebuild the burst; drawing over
 * the window spreads them. This is the standard result and it is the one
 * property `getLogsAdaptive`'s fixed 132ms did not have.
 *
 * A server-supplied Retry-After is a FLOOR, never a replacement: it says when
 * the endpoint will talk again, not that the whole fleet should resume at once,
 * so the jittered window is added on top.
 */
export function backoffMs(
  strikes: number,
  lim: GovernorLimits,
  rand: number,
  retryAfterMs: number | null,
): number {
  const window = Math.min(lim.maxBackoffMs, lim.baseBackoffMs * 2 ** Math.max(0, strikes - 1));
  const jittered = Math.floor(Math.max(0, Math.min(1, rand)) * window);
  const floor = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 0;
  return Math.min(lim.maxBackoffMs + floor, floor + jittered);
}

/**
 * Fold a cooldown read from the shared file into this process's state.
 *
 * ONLY EVER EXTENDS. A stale or malformed file must not be able to release a
 * cooldown this process set for itself — the file is a way for children to warn
 * each other, never a way for one to overrule another.
 *
 * AND IT IS CAPPED AT ONE MAXIMUM BACKOFF FROM NOW, which is the guard that
 * keeps this from becoming a worse outage than the one it damps. The file
 * outlives the process that wrote it: a child that restarts reads whatever is
 * on disk and believes it. Without a ceiling, one bad number — a clock skew, a
 * botched write, a value from a container that ran yesterday — would refuse
 * every read for every child for as long as it said, and nothing in the fleet
 * would ever ask the endpoint again to find out it had recovered.
 *
 * The cap costs nothing real: no honest cooldown this module produces exceeds
 * `maxBackoffMs`, so clamping to it can only discard a number this module did
 * not write.
 */
export function adoptShared(
  s: GovernorState,
  sharedUntil: number | null,
  now: number,
  lim: GovernorLimits,
): GovernorState {
  if (!sharedUntil || !Number.isFinite(sharedUntil)) return s;
  const capped = Math.min(sharedUntil, now + lim.maxBackoffMs);
  if (capped <= s.coolUntil) return s;
  return { ...s, coolUntil: capped };
}

/**
 * Is a cooldown worth telling the other children about?
 *
 * Writing on every refusal would have fifteen processes writing one small file
 * in a tight loop during exactly the incident it exists to damp. A write is
 * worth it only when it would actually extend what is already there.
 */
export function shouldPublish(s: GovernorState, sharedUntil: number | null): boolean {
  return s.coolUntil > (sharedUntil ?? 0) + 250;
}
