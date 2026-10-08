/**
 * RETRIEVAL BUDGETS — who may spend the provider's credits, and how many.
 *
 * The provider bills each REST call in credits against a monthly bucket and
 * answers 402 once it is empty. Nothing here can refill it: there is no call in
 * this subsystem that upgrades a plan, buys a top-up or moves to another
 * provider, and none may be added. A spent bucket is a research outage until
 * the owner acts. So the bucket is rationed BEFORE the provider is asked, from
 * a durable counter every replica shares (the `AllowancePort`, backed by a
 * `fomo_meta` table the way `xpost_meta` backs X's daily allowance).
 *
 * ── WHO GETS SHED, AND WHY BY RESERVATION RATHER THAN BY ORDER ───────────
 *
 * Three kinds of question compete for one daily pool (`RetrievalPriority`):
 *
 *   position-protection  monitoring coins the agent already holds
 *   interactive          an owner or a group asking right now
 *   discovery            optional background search for new candidates
 *
 * A first-come pool would let a discovery sweep at 03:00 spend the credits a
 * stop-condition check needs at 09:00. So each class has a RESERVED share and
 * the rules are enforced with nested counters, each an independent atomic
 * conditional add:
 *
 *   pool:all            every class            limit = daily pool
 *   pool:non-protection interactive+discovery  limit = (interactive + discovery) share
 *   pool:discovery      discovery only         limit = discovery share
 *
 * Discovery takes all three, so it never exceeds its own share and never
 * touches the others' reserves. Interactive takes the outer two, so it can
 * borrow discovery's unused share but never protection's. Protection takes
 * only the outermost, so it may borrow anything left. Discovery also takes
 * pool:all against a lower ceiling (`discoveryShedAt`), so as the whole pool
 * runs low discovery is refused first even inside its own share.
 *
 * The same idea, one level down, keeps a tenant's own chat from spending the
 * credits that protect that tenant's positions: a tenant's hourly and daily
 * counters each have a non-protection sub-counter capped below the tenant's
 * limit by `tenantProtectionReserve`.
 *
 * ── WHY SEVERAL COUNTERS ARE SAFE WITHOUT ONE TRANSACTION ────────────────
 *
 * Takes happen in sequence and a refusal gives back what this charge took.
 * Between the two a concurrent charge can see a counter briefly high and be
 * refused when it would have fitted; a crash between them leaves a counter
 * high until its window rolls over. Both errors spend LESS than allowed. No
 * interleaving spends more, because every take is itself a conditional add.
 * Likewise a charge whose request outcome is unknown keeps its estimate:
 * credits we may have been billed for are counted.
 *
 * Credits are research-operations accounting only. They never touch equity,
 * P&L, grants or caps, and nothing here can place, size or authorise a trade.
 */

import type { FomoSurface, RetrievalPriority } from "./types";

// ── Costs ────────────────────────────────────────────────────────────────

/**
 * Credit cost per upstream call, from the provider's published pricing and API
 * index (fetched 2026-10-04). The provider's `x-credits-cost` header on the
 * response is the truth; these are the estimates a charge is taken at before
 * the call, then reconciled by `settle`.
 *
 *   wallet-resolution       /v2/users/{handle} and /v2/users/id/{userId} on a hit
 *   unresolved-handle-miss  the same routes when the handle does not resolve
 *   thesis-page             every /v2/thesis* route, per page walked
 *   alerts-page             /v2/alerts, per page
 *   following-page          /v2/users/{h}/following, per page walked
 *   normal-read             search, positions, swaps, balances, holders, stats,
 *                           devs, followers, spotlight, comments, trade detail;
 *                           /trades?deep=N is N calls
 *   leaderboard             trader leaderboards and the three token boards
 *   me, health              free
 *
 * A wallet resolution is always estimated at the HIT price: the caller cannot
 * know in advance that it will miss, and under-reserving is the unsafe side.
 */
export const ROUTE_COST = Object.freeze({
  leaderboard: 250,
  "normal-read": 250,
  "alerts-page": 125,
  "thesis-page": 1_250,
  "following-page": 250,
  "wallet-resolution": 2_500,
  "unresolved-handle-miss": 250,
  me: 0,
  health: 0,
} as const);

export type CostClass = keyof typeof ROUTE_COST;

/** A per-route cost spec, as the provider client's own route table carries one. */
export interface RouteCostSpec {
  credits: number;
  /** False: billed once whatever `pages` says. */
  perPage?: boolean;
}

/**
 * Credits for `pages` upstream calls, by cost class or by a route's own cost
 * spec. Pages below 1 or non-integer round up to at least one.
 */
export function estimateCredits(route: CostClass | RouteCostSpec, pages = 1): number {
  let unit: number;
  let paged = true;
  if (typeof route === "string") {
    if (!Object.prototype.hasOwnProperty.call(ROUTE_COST, route)) throw new RangeError(`unknown cost class: ${route}`);
    unit = ROUTE_COST[route];
  } else {
    const c = route?.credits;
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0) throw new RangeError("route cost must be a finite, non-negative number");
    unit = Math.ceil(c);
    paged = route.perPage !== false;
  }
  const p = paged && typeof pages === "number" && Number.isFinite(pages) ? Math.max(1, Math.ceil(pages)) : 1;
  return unit * p;
}

/**
 * The daily pool a monthly plan supports: the plan's credits, less a held-back
 * `safetyFraction` (0 ≤ f < 1), spread over `daysInMonth`. Pass 31 when the
 * billing period is not known — the provider refills per billing period, not
 * per calendar month, and assuming the longest month never overspends.
 * Null when any input is unusable: an unknown plan is not a zero plan, and the
 * caller decides what to do without one.
 */
export function deriveDailyCredits(planCreditsPerMonth: number, daysInMonth: number, safetyFraction: number): number | null {
  if (typeof planCreditsPerMonth !== "number" || !Number.isFinite(planCreditsPerMonth) || planCreditsPerMonth < 0) return null;
  if (typeof daysInMonth !== "number" || !Number.isInteger(daysInMonth) || daysInMonth < 28 || daysInMonth > 31) return null;
  if (typeof safetyFraction !== "number" || !Number.isFinite(safetyFraction) || safetyFraction < 0 || safetyFraction >= 1) return null;
  return Math.floor((planCreditsPerMonth * (1 - safetyFraction)) / daysInMonth);
}

// ── The durable counter ──────────────────────────────────────────────────

/**
 * One atomic counter per key, shared by every replica (later a `fomo_meta`
 * table, as `takeAllowance` in xpost/store.ts).
 *
 *   take  adds `amount` to the counter under `key` IF the result stays
 *         ≤ `limit`, atomically, and says whether it did. A missing key is a
 *         zero counter. The budget only calls it with 0 < amount ≤ limit, so
 *         an INSERT path needs no limit check of its own.
 *   give  subtracts `amount`, never below zero.
 *
 * Keys carry their own window (hour index or UTC day), so a new window is a
 * new counter and nothing needs resetting.
 */
export interface AllowancePort {
  take(key: string, amount: number, limit: number, nowMs: number): Promise<boolean>;
  give(key: string, amount: number): Promise<void>;
}

/**
 * In-process AllowancePort for tests and a single-process fallback. Counters
 * untouched for two days are dropped (their windows are over).
 */
export class MemoryAllowance implements AllowancePort {
  private readonly counts = new Map<string, { n: number; at: number }>();

  async take(key: string, amount: number, limit: number, nowMs: number): Promise<boolean> {
    if (!(amount > 0) || !(limit >= 0)) return false;
    this.gc(nowMs);
    const cur = this.counts.get(key);
    const n = cur?.n ?? 0;
    if (n + amount > limit) return false;
    this.counts.set(key, { n: n + amount, at: nowMs });
    return true;
  }

  async give(key: string, amount: number): Promise<void> {
    const cur = this.counts.get(key);
    if (!cur || !(amount > 0)) return;
    cur.n = Math.max(0, cur.n - amount);
  }

  /** Current counter value (0 when absent). */
  used(key: string): number {
    return this.counts.get(key)?.n ?? 0;
  }

  keys(): string[] {
    return [...this.counts.keys()];
  }

  private gc(nowMs: number): void {
    if (!Number.isFinite(nowMs)) return;
    for (const [k, v] of this.counts) if (v.at < nowMs - 2 * 86_400_000) this.counts.delete(k);
  }
}

// ── Shared charge mechanics ──────────────────────────────────────────────

interface Step<R extends string> {
  key: string;
  limit: number;
  reason: R;
  /** The reason when the limit is below the amount itself (it can never fit, in any window); `reason` otherwise. */
  tooBig?: R;
}

interface Taken {
  key: string;
  amount: number;
}

/** Recording an overrun the provider already billed must not be refused. */
const RECORD_ANYWAY = Number.MAX_SAFE_INTEGER;

export type BudgetErrorHook = (op: "rollback" | "settle" | "refund", err: unknown) => void;

/**
 * Take `amount` from each step in order. On the first refusal give back what
 * was taken and report that step's reason. A port failure gives back what was
 * taken and rethrows: the caller must treat it as a refusal (no upstream call).
 */
type TakeResult<R extends string> = { ok: true; taken: Taken[] } | { ok: false; reason: R };

async function takeAll<R extends string>(
  port: AllowancePort,
  steps: readonly Step<R>[],
  amount: number,
  nowMs: number,
  onError: BudgetErrorHook,
): Promise<TakeResult<R>> {
  const taken: Taken[] = [];
  const rollback = async (): Promise<void> => {
    for (const t of taken.reverse()) {
      try {
        await port.give(t.key, t.amount);
      } catch (err) {
        // A counter left high under-spends until its window ends: the safe side.
        onError("rollback", err);
      }
    }
  };
  for (const s of steps) {
    // Checked here so the port never sees amount > limit (see AllowancePort).
    let ok = false;
    const fits = s.limit > 0 && amount <= s.limit;
    if (fits) {
      try {
        ok = await port.take(s.key, amount, s.limit, nowMs);
      } catch (err) {
        await rollback();
        throw err;
      }
    }
    if (!ok) {
      await rollback();
      return { ok: false, reason: !fits && s.tooBig !== undefined ? s.tooBig : s.reason };
    }
    taken.push({ key: s.key, amount });
  }
  return { ok: true, taken };
}

/** A granted charge. Exactly one of `settle` / `refund` takes effect; later calls do nothing. */
export interface Grant {
  ok: true;
  /** What was taken from every counter, the estimate. */
  charged: number;
  /**
   * Reconcile with what the provider billed (`x-credits-cost`). Null — the
   * header was absent or the outcome is unknown, e.g. a timeout after the
   * request was sent — keeps the estimate. Less gives the difference back;
   * more records the overrun even past the limit, because it was spent.
   */
  settle(actual: number | null): Promise<void>;
  /**
   * Give everything back. Only when the call CERTAINLY was not billed: never
   * sent, a 401/402, a 503 the provider documents as unbilled, or this caller
   * joined someone else's in-flight refresh — `SingleFlightResult.shared`.
   */
  refund(): Promise<void>;
}

function makeGrant(
  port: AllowancePort,
  taken: readonly Taken[],
  charged: number,
  clock: () => number,
  onError: BudgetErrorHook,
): Grant {
  let done = false;
  const giveAll = async (amount: number, op: "settle" | "refund"): Promise<void> => {
    for (const t of taken) {
      try {
        await port.give(t.key, Math.min(amount, t.amount));
      } catch (err) {
        onError(op, err);
      }
    }
  };
  return {
    ok: true,
    charged,
    async settle(actual: number | null): Promise<void> {
      if (done) return;
      done = true;
      if (actual === null || typeof actual !== "number" || !Number.isFinite(actual) || actual < 0) return;
      const real = Math.ceil(actual);
      if (real < charged) {
        await giveAll(charged - real, "settle");
      } else if (real > charged) {
        const extra = real - charged;
        const at = clock();
        for (const t of taken) {
          try {
            await port.take(t.key, extra, RECORD_ANYWAY, at);
          } catch (err) {
            onError("settle", err);
          }
        }
      }
    },
    async refund(): Promise<void> {
      if (done) return;
      done = true;
      await giveAll(charged, "refund");
    },
  };
}

function noopGrant(): Grant {
  return { ok: true, charged: 0, settle: async () => {}, refund: async () => {} };
}

const HOUR_MS = 3_600_000;

function hourIndex(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS);
}

/** UTC calendar day, e.g. "2026-10-04". */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * WHEN A REFUSED CHARGE CAN BE ASKED AGAIN: the start of the next clock hour
 * for an hourly counter, 00:00 UTC for a daily one (the counters' keys carry
 * their window, so that is when a fresh one starts). Takes a ChargeRefusal
 * or a read's reason ("budget-group-hourly"). Null when nothing resets on a
 * clock: a job's own allowance, a budget that could not be checked.
 */
export function refusalResetAt(reason: string | null | undefined, nowMs: number): number | null {
  if (typeof reason !== "string" || typeof nowMs !== "number" || !Number.isFinite(nowMs)) return null;
  const r = reason.startsWith("budget-") ? reason.slice("budget-".length) : reason;
  if (r === "group-hourly" || r === "tenant-hourly") return (hourIndex(nowMs) + 1) * HOUR_MS;
  if (r === "tenant-daily" || r === "shared-daily" || r === "class-reserve") return Date.parse(`${utcDay(nowMs)}T00:00:00.000Z`) + 24 * HOUR_MS;
  // below-one-read and no-group never reset on a clock, like a job's own allowance.
  return null;
}

/** "15:00": a reset time as people read it, in UTC. */
export function utcClockText(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/** Tenant and group ids go into keys percent-encoded, so no id can forge another's key. */
function seg(id: string): string {
  return encodeURIComponent(id);
}

function fraction(name: string, v: unknown, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new RangeError(`${name} must be a fraction in [0, 1]`);
  return v;
}

function credits(name: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new RangeError(`${name} must be a finite, non-negative number`);
  return Math.floor(v);
}

// ── Provider credits ─────────────────────────────────────────────────────

export interface PriorityShares {
  "position-protection": number;
  interactive: number;
  discovery: number;
}

export const DEFAULT_PRIORITY_SHARES: Readonly<PriorityShares> = Object.freeze({
  "position-protection": 0.25,
  interactive: 0.45,
  discovery: 0.3,
});

export interface FomoBudgetConfig {
  /** The shared daily pool for the whole fleet (see deriveDailyCredits). */
  sharedDailyCredits: number;
  tenantHourlyCredits: number;
  tenantDailyCredits: number;
  /** Per Telegram group (or other shared audience), per hour. */
  groupHourlyCredits: number;
  /** Reserved fractions of the shared pool, summing to at most 1. */
  shares?: PriorityShares;
  /** Discovery is refused once the shared pool is this full, even inside its own share (default 0.9). */
  discoveryShedAt?: number;
  /** Fraction of each tenant limit that only position protection may use (default: the protection share). */
  tenantProtectionReserve?: number;
}

/**
 * Why a charge was refused. Each clock-bound one resets at the next hour or
 * at 00:00 UTC (refusalResetAt). Two never reset on a clock: `below-one-read`
 * (a configured cap is below this one read's cost, the documented 0 for a
 * group included, so no window will ever fit it) and `no-group` (a group
 * request that cannot name its group cannot be capped).
 */
export type ChargeRefusal = "tenant-hourly" | "tenant-daily" | "group-hourly" | "shared-daily" | "class-reserve" | "below-one-read" | "no-group";

export interface ChargeRequest {
  priority: RetrievalPriority;
  tenant: string;
  surface: FomoSurface;
  /** Required on the telegram-group surface; a group request without one is refused. */
  groupId?: string | null;
  credits: number;
  now: number;
}

export type ChargeResult = Grant | { ok: false; reason: ChargeRefusal };

const PRIORITIES: readonly RetrievalPriority[] = ["position-protection", "interactive", "discovery"];

/** An unrecognised priority is treated as the lowest. Mislabelled work is shed, never promoted. */
function priorityOf(p: unknown): RetrievalPriority {
  return PRIORITIES.includes(p as RetrievalPriority) ? (p as RetrievalPriority) : "discovery";
}

/**
 * The provider-credit budget. `tryCharge` before every upstream call; then
 * `settle` with the `x-credits-cost` header, or `refund` when the call
 * certainly was not billed.
 *
 * With single-flight refreshes, charge BEFORE joining, so each caller's own
 * priority and tenant limits decide whether it may ask at all; then make sure
 * only the caller whose function actually ran pays. Settle INSIDE the function
 * handed to `SingleFlight.run` (it runs only for the caller that reaches
 * upstream) and refund afterwards if it never ran:
 *
 *   let ran = false;
 *   try {
 *     await flight.run(key, async () => { ran = true; … grant.settle(billedCreditsFor(meta, estimate)) … }, opts);
 *   } finally {
 *     if (!ran) await grant.refund();
 *   }
 *
 * `shared` on the result says the same thing on success, but a joiner of a
 * fetch that FAILED only sees the error, so the flag is the reliable signal.
 */
export class FomoBudget {
  readonly config: Readonly<Required<FomoBudgetConfig>>;
  private readonly port: AllowancePort;
  private readonly clock: () => number;
  private readonly onError: BudgetErrorHook;
  private readonly prefix: string;

  constructor(opts: {
    port: AllowancePort;
    config: FomoBudgetConfig;
    now?: () => number;
    onError?: BudgetErrorHook;
    keyPrefix?: string;
  }) {
    const c = opts.config;
    const shares = c.shares ?? DEFAULT_PRIORITY_SHARES;
    const p = fraction("shares.position-protection", shares["position-protection"], 0);
    const i = fraction("shares.interactive", shares.interactive, 0);
    const d = fraction("shares.discovery", shares.discovery, 0);
    if (p + i + d > 1 + 1e-9) throw new RangeError("priority shares must sum to at most 1");
    this.config = Object.freeze({
      sharedDailyCredits: credits("sharedDailyCredits", c.sharedDailyCredits),
      tenantHourlyCredits: credits("tenantHourlyCredits", c.tenantHourlyCredits),
      tenantDailyCredits: credits("tenantDailyCredits", c.tenantDailyCredits),
      groupHourlyCredits: credits("groupHourlyCredits", c.groupHourlyCredits),
      shares: Object.freeze({ "position-protection": p, interactive: i, discovery: d }),
      discoveryShedAt: fraction("discoveryShedAt", c.discoveryShedAt, 0.9),
      tenantProtectionReserve: fraction("tenantProtectionReserve", c.tenantProtectionReserve, p),
    });
    this.port = opts.port;
    this.clock = opts.now ?? Date.now;
    this.onError = opts.onError ?? (() => {});
    this.prefix = opts.keyPrefix ?? "fomo";
  }

  /** The counter limits a charge of this priority is checked against (for health and tests). */
  limitsFor(priority: RetrievalPriority): {
    poolAll: number;
    poolNonProtection: number | null;
    poolDiscovery: number | null;
    tenantHourly: number;
    tenantDaily: number;
    groupHourly: number;
  } {
    const c = this.config;
    const pr = priorityOf(priority);
    const D = c.sharedDailyCredits;
    const keep = 1 - c.tenantProtectionReserve;
    const protect = pr === "position-protection";
    return {
      poolAll: pr === "discovery" ? Math.floor(D * c.discoveryShedAt) : D,
      poolNonProtection: protect ? null : Math.floor(D * (c.shares.interactive + c.shares.discovery)),
      poolDiscovery: pr === "discovery" ? Math.floor(D * c.shares.discovery) : null,
      tenantHourly: protect ? c.tenantHourlyCredits : Math.floor(c.tenantHourlyCredits * keep),
      tenantDaily: protect ? c.tenantDailyCredits : Math.floor(c.tenantDailyCredits * keep),
      groupHourly: c.groupHourlyCredits,
    };
  }

  async tryCharge(req: ChargeRequest): Promise<ChargeResult> {
    if (typeof req.tenant !== "string" || !req.tenant.trim()) throw new TypeError("tenant is required");
    if (typeof req.now !== "number" || !Number.isFinite(req.now)) throw new RangeError("now must be a finite time");
    if (typeof req.credits !== "number" || !Number.isFinite(req.credits) || req.credits < 0) {
      throw new RangeError("credits must be a finite, non-negative number");
    }
    const amount = Math.ceil(req.credits);
    const groupId = typeof req.groupId === "string" && req.groupId.trim() ? req.groupId : null;
    // A group question that cannot name its group cannot be capped: refuse it.
    if (req.surface === "telegram-group" && groupId === null) return { ok: false, reason: "no-group" };
    if (amount === 0) return noopGrant();

    const pr = priorityOf(req.priority);
    const protect = pr === "position-protection";
    const c = this.config;
    const L = this.limitsFor(pr);
    const h = hourIndex(req.now);
    const day = utcDay(req.now);
    const t = seg(req.tenant);
    const k = (...parts: string[]): string => [this.prefix, "credits", ...parts].join(":");

    // THE DAILY STEPS FIRST, then the hourly ones. Every step must still pass, so what is
    // granted does not change; only the reason reported does. A refusal reports the FIRST
    // step that failed, and its reset time is promised to the room and the owner: midnight
    // UTC is never earlier than the next hour (and every hourly counter starts fresh then
    // too), so a spent daily cap or pool must win over a spent hourly one, or "try again
    // after 15:00" is refused again at 15:00 until midnight.
    //
    // A tenant or group cap below this one read's cost can never fit, in any window (the
    // documented 0 for a group included): `below-one-read`, no clock time promised. The
    // pools keep their own reasons: an empty pool is the fleet's, said as such.
    const cap = "below-one-read" as const;
    const steps: Step<ChargeRefusal>[] = [];
    if (!protect) steps.push({ key: k("tenant", t, "np", "d", day), limit: L.tenantDaily, reason: "tenant-daily", tooBig: cap });
    steps.push({ key: k("tenant", t, "all", "d", day), limit: c.tenantDailyCredits, reason: "tenant-daily", tooBig: cap });
    if (L.poolDiscovery !== null) steps.push({ key: k("pool", "discovery", "d", day), limit: L.poolDiscovery, reason: "class-reserve" });
    if (L.poolNonProtection !== null) steps.push({ key: k("pool", "np", "d", day), limit: L.poolNonProtection, reason: "class-reserve" });
    steps.push({ key: k("pool", "all", "d", day), limit: L.poolAll, reason: "shared-daily" });
    if (groupId !== null) steps.push({ key: k("group", seg(groupId), "h", String(h)), limit: L.groupHourly, reason: "group-hourly", tooBig: cap });
    if (!protect) steps.push({ key: k("tenant", t, "np", "h", String(h)), limit: L.tenantHourly, reason: "tenant-hourly", tooBig: cap });
    steps.push({ key: k("tenant", t, "all", "h", String(h)), limit: c.tenantHourlyCredits, reason: "tenant-hourly", tooBig: cap });

    const r = await takeAll(this.port, steps, amount, req.now, this.onError);
    if (!r.ok) return r;
    return makeGrant(this.port, r.taken, amount, this.clock, this.onError);
  }
}

// ── The caps a hosting process configures ────────────────────────────────

/** The Free plan's monthly credits, the default when the plan is not known. */
export const FREE_PLAN_CREDITS_PER_MONTH = 250_000;
/** Held back from the monthly allowance: the budget never plans to spend the last fifth. */
export const PLAN_SAFETY_FRACTION = 0.2;

/**
 * Conservative per-tenant and per-group caps. One standard coin research costs
 * about 1,500–2,000 credits (one thesis page, one feed page, token stats, maybe
 * a search); a tenant can ask a handful of those an hour and a few dozen a day,
 * and a group less. The shared pool still bounds the whole fleet.
 */
export const DEFAULT_TENANT_HOURLY_CREDITS = 6_000;
export const DEFAULT_TENANT_DAILY_CREDITS = 20_000;
export const DEFAULT_GROUP_HOURLY_CREDITS = 2_500;

/** The budget configuration a plan supports, with any construction-time overrides applied and clamped. */
export function budgetConfigFor(planCreditsPerMonth: number, over: Partial<FomoBudgetConfig> = {}): FomoBudgetConfig {
  const derived = deriveDailyCredits(planCreditsPerMonth, 31, PLAN_SAFETY_FRACTION);
  // An unusable plan figure is not a big plan: spend nothing rather than guess.
  const shared = over.sharedDailyCredits ?? derived ?? 0;
  const cap = (v: number | undefined, fallback: number): number => Math.min(shared, Math.max(0, v ?? fallback));
  return {
    ...over,
    sharedDailyCredits: shared,
    tenantHourlyCredits: cap(over.tenantHourlyCredits, DEFAULT_TENANT_HOURLY_CREDITS),
    tenantDailyCredits: cap(over.tenantDailyCredits, DEFAULT_TENANT_DAILY_CREDITS),
    groupHourlyCredits: cap(over.groupHourlyCredits, DEFAULT_GROUP_HOURLY_CREDITS),
  };
}

type Env = Record<string, string | undefined>;

/**
 * THE CAPS AN OPERATOR MAY SET, by environment variable. The orchestrator
 * (fomoSetup), the web process (web/src/lib/fomo-runtime.ts) and a
 * self-hosted worker (index.ts) all read them through fomoBudgetFrom, so the
 * processes that share the fomo_meta counters agree on every limit (set
 * them on web AND orchestrator, then redeploy both). Unset, the defaults
 * above apply, unchanged. These are research-credit caps, never trading
 * limits, and budgetConfigFor still holds each one under the shared pool.
 */
export const FOMO_CAP_ENV = Object.freeze({
  groupHourlyCredits: "MERRYMEN_FOMO_GROUP_HOURLY_CREDITS",
  tenantHourlyCredits: "MERRYMEN_FOMO_TENANT_HOURLY_CREDITS",
  tenantDailyCredits: "MERRYMEN_FOMO_TENANT_DAILY_CREDITS",
} as const);

/** The provider plan's monthly credits (MERRYMEN_FOMO_PLAN_CREDITS): a positive number, else undefined and the default applies. */
export function fomoPlanFrom(env: Env): number | undefined {
  const plan = Number(env?.MERRYMEN_FOMO_PLAN_CREDITS);
  return Number.isFinite(plan) && plan > 0 ? plan : undefined;
}

/**
 * The cap overrides an environment sets: whole numbers of credits only
 * (digits, nothing else: no sign, comma, decimal or unit). A blank or unset
 * variable is no override. Each bad value is one problem line, which names
 * the variable and never echoes the value (a key pasted into the wrong
 * variable must not reach a log), and leaves that cap at its default.
 */
export function fomoBudgetFrom(env: Env): { budget: Partial<FomoBudgetConfig>; problems: string[] } {
  const budget: Partial<FomoBudgetConfig> = {};
  const problems: string[] = [];
  for (const [field, name] of Object.entries(FOMO_CAP_ENV) as Array<[keyof typeof FOMO_CAP_ENV, string]>) {
    const raw = env?.[name];
    if (raw === undefined || raw.trim() === "") continue;
    const v = raw.trim();
    const n = /^\d{1,12}$/.test(v) ? Number(v) : Number.NaN;
    if (!Number.isSafeInteger(n)) {
      problems.push(`fomo: ${name} is not a whole number of credits; its default applies`);
      continue;
    }
    budget[field] = n;
  }
  // A nonzero cap below the dearest read a room or owner surface makes can never answer it, in
  // any hour: said once at boot, as the limit in force (0 is the documented "off", said by docs).
  const dearest = ROUTE_COST["wallet-resolution"];
  const keep = 1 - DEFAULT_PRIORITY_SHARES["position-protection"];
  const low = (v: number | undefined, share: number): boolean => typeof v === "number" && v > 0 && Math.floor(v * share) < dearest;
  if (low(budget.groupHourlyCredits, 1)) problems.push(`fomo: ${FOMO_CAP_ENV.groupHourlyCredits} is below what one named-trader read costs (${dearest} credits), so a room can never get one`);
  if (low(budget.tenantHourlyCredits, keep)) problems.push(`fomo: ${FOMO_CAP_ENV.tenantHourlyCredits} leaves an owner's own research less than one named-trader read (${dearest} credits) an hour`);
  if (low(budget.tenantDailyCredits, keep)) problems.push(`fomo: ${FOMO_CAP_ENV.tenantDailyCredits} leaves an owner's own research less than one named-trader read (${dearest} credits) a day`);
  return { budget, problems };
}

/** One boot line: the limits in force, as budgetConfigFor clamped them. */
export function describeBudget(c: FomoBudgetConfig): string {
  return `fomo: research budget ${c.sharedDailyCredits} credits/day shared; per owner ${c.tenantHourlyCredits}/h and ${c.tenantDailyCredits}/day; per group ${c.groupHourlyCredits}/h`;
}

// ── Analysis-model budget ────────────────────────────────────────────────

export interface ModelBudgetConfig {
  /** Deeper-research model calls per tenant per UTC day. */
  callsPerDay: number;
  /** Tokens (prompt + completion) per tenant per UTC day. */
  tokensPerDay: number;
}

export type ModelRefusal = "model-calls-daily" | "model-tokens-daily";

export type ModelChargeResult = Grant | { ok: false; reason: ModelRefusal };

/**
 * Per-tenant daily caps on the analysis model used for deeper research
 * (dossiers, thesis summaries). Same mechanics as the credit budget: take the
 * estimate before the call, `settle` with the tokens the model reported, or
 * `refund` when the call certainly never ran. `settle` reconciles TOKENS only;
 * the call itself happened and stays counted.
 */
export class ModelBudget {
  readonly config: Readonly<ModelBudgetConfig>;
  private readonly port: AllowancePort;
  private readonly clock: () => number;
  private readonly onError: BudgetErrorHook;
  private readonly prefix: string;

  constructor(opts: { port: AllowancePort; config: ModelBudgetConfig; now?: () => number; onError?: BudgetErrorHook; keyPrefix?: string }) {
    this.config = Object.freeze({
      callsPerDay: credits("callsPerDay", opts.config.callsPerDay),
      tokensPerDay: credits("tokensPerDay", opts.config.tokensPerDay),
    });
    this.port = opts.port;
    this.clock = opts.now ?? Date.now;
    this.onError = opts.onError ?? (() => {});
    this.prefix = opts.keyPrefix ?? "fomo";
  }

  async tryStart(req: { tenant: string; estimatedTokens: number; now: number }): Promise<ModelChargeResult> {
    if (typeof req.tenant !== "string" || !req.tenant.trim()) throw new TypeError("tenant is required");
    if (typeof req.now !== "number" || !Number.isFinite(req.now)) throw new RangeError("now must be a finite time");
    if (typeof req.estimatedTokens !== "number" || !Number.isFinite(req.estimatedTokens) || req.estimatedTokens < 1) {
      throw new RangeError("estimatedTokens must be a finite number ≥ 1");
    }
    const tokens = Math.ceil(req.estimatedTokens);
    const day = utcDay(req.now);
    const base = [this.prefix, "model", seg(req.tenant), day].join(":");
    const calls = await takeAll(this.port, [{ key: `${base}:calls`, limit: this.config.callsPerDay, reason: "model-calls-daily" as const }], 1, req.now, this.onError);
    if (!calls.ok) return calls;
    let tok: TakeResult<ModelRefusal>;
    try {
      tok = await takeAll(this.port, [{ key: `${base}:tokens`, limit: this.config.tokensPerDay, reason: "model-tokens-daily" as const }], tokens, req.now, this.onError);
    } catch (err) {
      await this.giveBack(calls.taken, "rollback");
      throw err;
    }
    if (!tok.ok) {
      await this.giveBack(calls.taken, "rollback");
      return tok;
    }
    const tokenGrant = makeGrant(this.port, tok.taken, tokens, this.clock, this.onError);
    let done = false;
    return {
      ok: true,
      charged: tokens,
      settle: async (actual: number | null) => {
        if (done) return;
        done = true;
        await tokenGrant.settle(actual);
      },
      refund: async () => {
        if (done) return;
        done = true;
        await tokenGrant.refund();
        await this.giveBack(calls.taken, "refund");
      },
    };
  }

  private async giveBack(taken: readonly Taken[], op: "rollback" | "refund"): Promise<void> {
    for (const t of taken) {
      try {
        await this.port.give(t.key, t.amount);
      } catch (err) {
        this.onError(op, err);
      }
    }
  }
}

// ── Usage metering ───────────────────────────────────────────────────────

export interface UsageTotals {
  /** Upstream calls made. */
  calls: number;
  /** Sum of credits over calls whose cost was KNOWN (header present). */
  creditsKnown: number;
  /** Calls whose credit cost was unknown. Never folded into creditsKnown as zero. */
  callsCreditsUnknown: number;
  cacheHits: number;
  /** Upstream wanted, budget refused. */
  refusals: number;
}

export interface UsageDay {
  day: string;
  totals: UsageTotals;
  buckets: Record<string, UsageTotals>;
}

export interface UsageSnapshot {
  days: UsageDay[];
  /** Latest `x-credits-remaining` seen, with when. Null until one is seen. */
  lastCreditsRemaining: { value: number; at: number } | null;
}

const OTHER_BUCKET = "_other";

function emptyTotals(): UsageTotals {
  return { calls: 0, creditsKnown: 0, callsCreditsUnknown: 0, cacheHits: 0, refusals: 0 };
}

/** Bucket names are internal labels (route class, surface). Kept short and plain regardless. */
function bucketName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[^a-z0-9:_./-]/g, "_").slice(0, 64) : "";
  return s || "unknown";
}

/**
 * Per-UTC-day, per-bucket aggregation of upstream calls, credits, cache hits
 * and budget refusals — the inputs to the cost model ("what does one
 * interactive question cost, and how much does the cache save?"). In memory,
 * bounded by `retainDays` and `maxBucketsPerDay`; a restart starts it again.
 * The durable truth for spend is the allowance counters, not this.
 */
export class UsageMeter {
  private readonly days = new Map<string, Map<string, UsageTotals>>();
  private readonly retainDays: number;
  private readonly maxBuckets: number;
  private remaining: { value: number; at: number } | null = null;

  constructor(opts: { retainDays?: number; maxBucketsPerDay?: number } = {}) {
    const r = opts.retainDays;
    const m = opts.maxBucketsPerDay;
    this.retainDays = typeof r === "number" && Number.isInteger(r) && r >= 1 ? r : 8;
    this.maxBuckets = typeof m === "number" && Number.isInteger(m) && m >= 1 ? m : 200;
  }

  recordCall(e: { now: number; bucket: string; credits: number | null }): void {
    const b = this.bucket(e.now, e.bucket);
    if (!b) return;
    b.calls++;
    if (typeof e.credits === "number" && Number.isFinite(e.credits) && e.credits >= 0) b.creditsKnown += e.credits;
    else b.callsCreditsUnknown++;
  }

  recordCacheHit(e: { now: number; bucket: string }): void {
    const b = this.bucket(e.now, e.bucket);
    if (b) b.cacheHits++;
  }

  recordRefusal(e: { now: number; bucket: string }): void {
    const b = this.bucket(e.now, e.bucket);
    if (b) b.refusals++;
  }

  /** The provider's `x-credits-remaining`. An older reading never replaces a newer one. */
  recordRemaining(e: { now: number; remaining: number | null }): void {
    if (typeof e.remaining !== "number" || !Number.isFinite(e.remaining) || e.remaining < 0) return;
    if (typeof e.now !== "number" || !Number.isFinite(e.now)) return;
    if (this.remaining && this.remaining.at > e.now) return;
    this.remaining = { value: e.remaining, at: e.now };
  }

  snapshot(): UsageSnapshot {
    const days: UsageDay[] = [];
    for (const day of [...this.days.keys()].sort()) {
      const buckets: Record<string, UsageTotals> = {};
      const totals = emptyTotals();
      const m = this.days.get(day);
      if (!m) continue;
      for (const name of [...m.keys()].sort()) {
        const v = m.get(name);
        if (!v) continue;
        buckets[name] = { ...v };
        totals.calls += v.calls;
        totals.creditsKnown += v.creditsKnown;
        totals.callsCreditsUnknown += v.callsCreditsUnknown;
        totals.cacheHits += v.cacheHits;
        totals.refusals += v.refusals;
      }
      days.push({ day, totals, buckets });
    }
    return { days, lastCreditsRemaining: this.remaining ? { ...this.remaining } : null };
  }

  private bucket(now: number, raw: string): UsageTotals | null {
    if (typeof now !== "number" || !Number.isFinite(now)) return null;
    const day = utcDay(now);
    let m = this.days.get(day);
    if (!m) {
      m = new Map();
      this.days.set(day, m);
      const all = [...this.days.keys()].sort();
      while (all.length > this.retainDays) {
        const oldest = all.shift();
        if (oldest !== undefined) this.days.delete(oldest);
      }
      if (!this.days.has(day)) return null; // a record for a day older than everything retained
    }
    let name = bucketName(raw);
    if (!m.has(name) && m.size >= this.maxBuckets) name = OTHER_BUCKET;
    let b = m.get(name);
    if (!b) {
      b = emptyTotals();
      m.set(name, b);
    }
    return b;
  }
}
