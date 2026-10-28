/**
 * EXPLORATION SIZING — how much a followed coin may be given, in micro-USDG.
 *
 * A selective-follow setup never sizes itself from anything the provider
 * said. A trader's position value, a fill in USD, a market cap: all of it is
 * display and research data in float USD, and none of it appears below. The
 * ceiling is computed from the agent's OWN limits (per-trade cap, today's
 * headroom, the owner's scout budget), the agent's OWN book (what exploration
 * already holds, what it has already lost) and the agent's OWN route reading.
 *
 * WHAT THE CEILING IS, AND IS NOT. It is the most a follow nomination may ask
 * the existing Trencher entry for. It is not an order, it does not replace
 * any check, and it can only TIGHTEN: the Brain still sizes, `take()` still
 * clamps to `maxUsdg`, checkPolicy still holds the autonomous entry to 5 USDG
 * and the scout budget, and the wall still refuses anything over. A ceiling
 * that came out larger than any of those would simply be cut by them; one that
 * came out smaller is the one that binds.
 *
 * THREE RULES THAT ARE EASY TO BREAK BY ACCIDENT
 *
 *   1. UNKNOWN IS NOT PERMISSION. Every input that bounds the size is
 *      required; a null one makes the ceiling 0 and names itself
 *      (`unknown:<part>`). A missing equity reading is not infinite equity.
 *   2. ROUND DOWN, ONLY. bigint division truncates, every remainder is
 *      floored at zero, and nothing here rounds toward a limit.
 *   3. A LOSS NEVER RAISES THE NEXT CEILING. Realised exploration losses since
 *      the owner's authorisation epoch consume the allocation and stay
 *      consumed: closing a losing position moves its cost out of "held" and
 *      its loss into "realised loss", so the allowance does not come back. A
 *      profit is floored out of the loss term, so it never lifts the
 *      allowance above what the owner authorised. There is no martingale and
 *      no averaging down anywhere in this file, and the tests pin both.
 */

/** Fixed order: the first part to reach the minimum (or to be unknown) is the one named. */
export const CEILING_PARTS = [
  "per-trade",
  "daily-headroom",
  "exploration-remaining",
  "per-token-remaining",
  "exposure-headroom",
  "route-capacity",
  "autonomous-cap",
] as const;

export type CeilingPart = (typeof CEILING_PARTS)[number];

/** The autonomous (vault-custody) entry bound policy.ts enforces: 5 USDG. Pass it on that path. */
export const AUTONOMOUS_ENTRY_CAP_6 = 5_000_000n;

export interface EntryCeilingInput {
  /** The signed per-trade cap. */
  perTradeLimit6: bigint | null;
  /** What today's daily cap still allows. */
  dailyHeadroom6: bigint | null;
  /** The owner's scout settings: exploration reuses that budget, never a new one. */
  scout: { enabled: boolean; budget6: bigint | null; perToken6: bigint | null };
  /** Cost currently held in exploration positions (all tokens). */
  explorationHeldCost6: bigint | null;
  /** In-process reservations not yet filled (ExplorationReservations.pendingAgainst). */
  explorationPending6: bigint;
  /** Cumulative realised exploration LOSS since the owner's authorisation epoch. */
  realizedExplorationLoss6: bigint | null;
  /** Cost held in THIS token (adds count against the same per-token cap). */
  tokenHeldCost6: bigint | null;
  tokenPending6: bigint;
  /** The agent's own equity reading. */
  equity6: bigint | null;
  /** Largest share of equity exploration may hold, in bps (0–10 000). */
  maxExplorationShareBps: number;
  /** The most the verified route can take at our impact limit, from our own quote. */
  routeCapacity6: bigint | null;
  /**
   * The autonomous entry bound. ABSENT means the caller's path carries none
   * (owner custody); NULL means it applies and is unknown, which binds at 0.
   */
  autonomousCap6?: bigint | null;
  /** The smallest entry worth its gas. Below it the caller WATCHes instead. */
  minEconomic6: bigint;
}

export interface EntryCeiling {
  ceiling6: bigint;
  /** The part that bound: a CeilingPart, `unknown:<part>`, `invalid:<part>` or `exploration-not-authorized`. */
  binding: string;
  /** Each part's remaining room (null = unknown). Informational; ceiling6 is the answer. */
  parts: Record<string, bigint | null>;
  economic: "ok" | "below-floor";
  /** The floor the economic verdict was judged against (echoed so a probe can be judged too). */
  floor6: bigint;
  reason: string;
}

/** Exact 6dp rendering, no float: `1.250000`. */
export function formatUsdg6(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/**
 * A USDG setting (a float the owner typed, like 25 or 2.5) as micro-USDG,
 * rounded DOWN. Null for anything that is not a finite non-negative number:
 * an unreadable limit is unknown, not zero and not unlimited.
 */
export function microUsdgFloor(n: number | null | undefined): bigint | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  const micro = Math.floor(n * 1e6);
  return Number.isSafeInteger(micro) ? BigInt(micro) : null;
}

const max0 = (v: bigint) => (v > 0n ? v : 0n);

/**
 * THE CEILING: the minimum of every bound, each named.
 *
 *   per-trade              the signed cap
 *   daily-headroom         what today still allows
 *   exploration-remaining  scout budget − held − pending − realised loss
 *   per-token-remaining    per-token scout cap − this token's held − its pending
 *   exposure-headroom      equity × share − held − pending
 *   route-capacity         what our verified route takes at our impact limit
 *   autonomous-cap         the vault-custody entry bound, when that path applies
 *
 * Scout disabled answers 0 before anything else: exploration spends the scout
 * budget, and an owner who has not turned scout on has not authorised it.
 */
export function entryCeiling(i: EntryCeilingInput): EntryCeiling {
  const parts: Record<string, bigint | null> = {};
  const invalid: string[] = [];
  const nonNeg = (part: string, v: bigint | null): bigint | null => {
    if (v === null) return null;
    if (typeof v !== "bigint" || v < 0n) {
      invalid.push(part);
      return null;
    }
    return v;
  };

  const perTrade = nonNeg("per-trade", i.perTradeLimit6);
  const daily = nonNeg("daily-headroom", i.dailyHeadroom6);
  const budget = nonNeg("exploration-remaining", i.scout.budget6);
  const perToken = nonNeg("per-token-remaining", i.scout.perToken6);
  const held = nonNeg("exploration-remaining", i.explorationHeldCost6);
  const pending = nonNeg("exploration-remaining", i.explorationPending6);
  const tokenHeld = nonNeg("per-token-remaining", i.tokenHeldCost6);
  const tokenPending = nonNeg("per-token-remaining", i.tokenPending6);
  const equity = nonNeg("exposure-headroom", i.equity6);
  const route = nonNeg("route-capacity", i.routeCapacity6);
  const autonomous = i.autonomousCap6 === undefined ? undefined : nonNeg("autonomous-cap", i.autonomousCap6);
  // A realised PROFIT arrives here as a negative loss on some ledgers. Floored
  // to zero, so profit can win back at most what was lost and never lifts the
  // allowance above the budget the owner authorised.
  const loss = typeof i.realizedExplorationLoss6 === "bigint" ? max0(i.realizedExplorationLoss6) : null;
  const shareOk = Number.isInteger(i.maxExplorationShareBps) && i.maxExplorationShareBps >= 0 && i.maxExplorationShareBps <= 10_000;
  if (!shareOk) invalid.push("exposure-headroom");
  const floorOk = typeof i.minEconomic6 === "bigint" && i.minEconomic6 >= 0n;
  if (!floorOk) invalid.push("min-economic");

  parts["per-trade"] = perTrade;
  parts["daily-headroom"] = daily;
  parts["exploration-remaining"] =
    budget !== null && held !== null && pending !== null && loss !== null ? max0(budget - held - pending - loss) : null;
  parts["per-token-remaining"] =
    perToken !== null && tokenHeld !== null && tokenPending !== null ? max0(perToken - tokenHeld - tokenPending) : null;
  parts["exposure-headroom"] =
    equity !== null && held !== null && pending !== null && shareOk
      ? max0((equity * BigInt(i.maxExplorationShareBps)) / 10_000n - held - pending)
      : null;
  parts["route-capacity"] = route;
  if (autonomous !== undefined) parts["autonomous-cap"] = autonomous;

  const floor6 = floorOk ? i.minEconomic6 : 0n;
  const zero = (binding: string, reason: string): EntryCeiling => ({
    ceiling6: 0n,
    binding,
    parts,
    economic: "below-floor",
    floor6,
    reason,
  });

  if (i.scout.enabled !== true) return zero("exploration-not-authorized", "scout mode is off, so exploration has no authorised budget");
  if (invalid.length > 0) return zero(`invalid:${invalid[0]}`, `${invalid[0]} was not a valid non-negative amount`);
  for (const part of CEILING_PARTS) {
    if (part in parts && parts[part] === null) return zero(`unknown:${part}`, `${part} is unknown, and unknown is not permission`);
  }

  let ceiling6: bigint | null = null;
  let binding = "";
  for (const part of CEILING_PARTS) {
    const v = parts[part];
    if (v === undefined || v === null) continue;
    if (ceiling6 === null || v < ceiling6) {
      ceiling6 = v;
      binding = part;
    }
  }
  if (ceiling6 === null) return zero("unknown:per-trade", "no bound was supplied");
  const economic = ceiling6 > 0n && ceiling6 >= floor6 ? "ok" : "below-floor";
  const reason =
    economic === "ok"
      ? `bound by ${binding} at ${formatUsdg6(ceiling6)} USDG`
      : `bound by ${binding} at ${formatUsdg6(ceiling6)} USDG, under the ${formatUsdg6(floor6)} USDG floor for an entry worth its gas`;
  return { ceiling6, binding, parts, economic, floor6, reason };
}

/**
 * A probe: a fraction of the ceiling, never above `probeCap6` and never above
 * the ceiling itself. Rounded down. Zero for anything malformed.
 */
export function probeSize(ceiling6: bigint, fractionBps: number, probeCap6: bigint): bigint {
  if (typeof ceiling6 !== "bigint" || ceiling6 <= 0n) return 0n;
  if (!Number.isInteger(fractionBps) || fractionBps <= 0 || fractionBps > 10_000) return 0n;
  if (typeof probeCap6 !== "bigint" || probeCap6 <= 0n) return 0n;
  const frac = (ceiling6 * BigInt(fractionBps)) / 10_000n;
  const capped = frac < probeCap6 ? frac : probeCap6;
  return capped < ceiling6 ? capped : ceiling6;
}

// ─── Reservations ───────────────────────────────────────────────────────────

/**
 * The durable figures a reservation is judged against, read from the
 * agent's own ledger at `asOf`. They EXCLUDE this process's reservations:
 * those are counted by the reservation book itself.
 */
export interface ReservationSnapshot {
  /** When these figures were read (ms). A fill committed at or before this is inside the held costs. */
  asOf: number;
  enabled: boolean;
  budget6: bigint | null;
  perToken6: bigint | null;
  explorationHeldCost6: bigint | null;
  realizedExplorationLoss6: bigint | null;
  /** Durable held cost of the token being reserved. */
  tokenHeldCost6: bigint | null;
}

interface Reservation {
  id: string;
  tokenKey: string;
  amount6: bigint;
  reservedAt: number;
  /** Set when the entry filled: the ledger time from which snapshots include it. */
  committedAt: number | null;
}

export interface ReservationTotals {
  pending6: bigint;
  /** Filled, but possibly not yet visible in a snapshot. Still counted. */
  committedUnsettled6: bigint;
  total6: bigint;
  count: number;
  byToken: Record<string, bigint>;
}

/**
 * SHARED EXPLORATION HEADROOM, RESERVED ATOMICALLY.
 *
 * Two follow signals for two coins can arrive in the same second, each read
 * the same snapshot of the budget, each decide it fits, and together spend
 * twice what was left. So a reservation is taken BEFORE an entry starts,
 * against the snapshot MINUS every reservation this process still holds, and
 * `reserve` is synchronous: there is no await between the check and the
 * write, so interleaved async callers are serialised by the event loop.
 *
 * WHEN A RESERVATION STOPS COUNTING. A pending one counts until it is
 * released (no fill). A committed one counts until a snapshot taken at or
 * after its fill time is presented — that snapshot's held cost already
 * contains it. The filter is per call, never a deletion driven by one
 * snapshot, so a caller holding an OLDER snapshot still sees the fill
 * counted. Committed entries are forgotten only once they are older than any
 * snapshot `reserve` will accept (`maxSnapshotAgeMs`).
 *
 * In memory on purpose: a restart forgets every reservation, and the durable
 * held cost the next snapshot reads is what governs after it. A reservation
 * that is never released under-spends until restart; that is the safe side.
 */
export class ExplorationReservations {
  private readonly items = new Map<string, Reservation>();
  private readonly now: () => number;
  private readonly maxSnapshotAgeMs: number;

  constructor(opts: { now?: () => number; maxSnapshotAgeMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.maxSnapshotAgeMs = opts.maxSnapshotAgeMs ?? 60_000;
  }

  /**
   * Reserve `amount6` of exploration for `tokenKey`. False — and nothing is
   * written — when it would exceed the exploration or per-token remaining
   * given every outstanding reservation, when any figure is unknown, when the
   * snapshot is too old to trust, or when the id is already in use.
   */
  reserve(id: string, tokenKey: string, amount6: bigint, snapshot: ReservationSnapshot): boolean {
    if (typeof id !== "string" || !id.trim() || this.items.has(id)) return false;
    if (typeof tokenKey !== "string" || !tokenKey) return false;
    if (typeof amount6 !== "bigint" || amount6 <= 0n) return false;
    const t = this.now();
    if (!snapshot || !Number.isFinite(snapshot.asOf) || !Number.isFinite(t)) return false;
    if (t - snapshot.asOf > this.maxSnapshotAgeMs || snapshot.asOf - t > 5_000) return false;
    this.gc(t);
    if (snapshot.enabled !== true) return false;
    const { budget6, perToken6, explorationHeldCost6, realizedExplorationLoss6, tokenHeldCost6 } = snapshot;
    if (budget6 === null || perToken6 === null || explorationHeldCost6 === null || realizedExplorationLoss6 === null || tokenHeldCost6 === null) {
      return false;
    }
    if (budget6 < 0n || perToken6 < 0n || explorationHeldCost6 < 0n || tokenHeldCost6 < 0n) return false;
    const counted = this.counted(snapshot.asOf);
    const loss = max0(realizedExplorationLoss6);
    const explorationRemaining = budget6 - explorationHeldCost6 - loss - counted.total6;
    const tokenRemaining = perToken6 - tokenHeldCost6 - (counted.byToken[tokenKey] ?? 0n);
    if (amount6 > explorationRemaining || amount6 > tokenRemaining) return false;
    this.items.set(id, { id, tokenKey, amount6, reservedAt: t, committedAt: null });
    return true;
  }

  /**
   * The entry filled. Call only once the fill is in the ledger the snapshots
   * read; `at` is that moment (default now). `amount6` is what the fill
   * actually cost when it differs; a larger figure than reserved is recorded
   * as is (counting more is the safe side).
   */
  commit(id: string, opts: { at?: number; amount6?: bigint } = {}): boolean {
    const r = this.items.get(id);
    if (!r || r.committedAt !== null) return false;
    const at = opts.at ?? this.now();
    if (!Number.isFinite(at)) return false;
    if (opts.amount6 !== undefined) {
      if (typeof opts.amount6 !== "bigint" || opts.amount6 < 0n) return false;
      r.amount6 = opts.amount6;
    }
    r.committedAt = at;
    return true;
  }

  /** No fill: give the headroom back. A committed reservation is spent and cannot be released. */
  release(id: string): boolean {
    const r = this.items.get(id);
    if (!r || r.committedAt !== null) return false;
    this.items.delete(id);
    return true;
  }

  /** What `entryCeiling` should be told is pending, for a snapshot read at `asOf`. */
  pendingAgainst(asOf: number, tokenKey: string): { exploration6: bigint; token6: bigint } {
    this.gc(this.now());
    const c = this.counted(asOf);
    return { exploration6: c.total6, token6: c.byToken[tokenKey] ?? 0n };
  }

  outstanding(): ReservationTotals {
    const t = this.now();
    this.gc(t);
    // Without a snapshot to compare against, every committed reservation still held is shown.
    return this.counted(Number.NEGATIVE_INFINITY);
  }

  private counted(asOf: number): ReservationTotals {
    let pending6 = 0n;
    let committedUnsettled6 = 0n;
    let count = 0;
    const byToken: Record<string, bigint> = {};
    for (const r of this.items.values()) {
      if (r.committedAt === null) pending6 += r.amount6;
      else if (r.committedAt > asOf) committedUnsettled6 += r.amount6;
      else continue;
      count++;
      byToken[r.tokenKey] = (byToken[r.tokenKey] ?? 0n) + r.amount6;
    }
    return { pending6, committedUnsettled6, total6: pending6 + committedUnsettled6, count, byToken };
  }

  /** Committed reservations older than any snapshot `reserve` accepts are inside every acceptable snapshot. */
  private gc(t: number): void {
    for (const [id, r] of this.items) {
      if (r.committedAt !== null && r.committedAt < t - this.maxSnapshotAgeMs - 5_000) this.items.delete(id);
    }
  }
}
