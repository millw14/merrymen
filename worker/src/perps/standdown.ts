/**
 * THE STAND-DOWN — how the perps end when the agent's authority does
 * (docs/perps.md rules 8a, 13 and 16; review amendments
 * kill-standdown-not-reachable-hosted, hosted-kill-cannot-stand-down,
 * lifecycle-grant-expiry-fleet-halt, standdown-cancels-stops-first,
 * auth-reads-lost-after-kill-or-recover).
 *
 * Used by kill, grant expiry, a venue incident and the owner's /flatten. It
 * stands ONE Lighter account down with the Lighter API key alone — never the
 * session key, never an on-chain leg — on a clock that always ends. An
 * incident runs it once per account under our L1 address (rule 16); that loop
 * is the caller's.
 *
 * THE ORDER IS THE SAFETY. A resting venue stop is the only protection a
 * position keeps once the worker lets go, so nothing here ever removes one
 * from a position that is still open (standdown-cancels-stops-first: the
 * contract's first draft cancelled everything first, and a close that then
 * failed on slippage left a leveraged position with no stop and nobody
 * watching):
 *
 *   (a) RESOLVE what is already in flight (rule 9). A submitted open that
 *       lands after we read the market flat would be a position whose stop
 *       child we then cancel; a submitted close we cannot see would be sized
 *       over. Failure here is noted, never a reason to stop: an exit is always
 *       attemptable, and rule 9 lets a reduce-only close be signed anew.
 *   (b) CLOSE every position: a reduce-only IOC for the FULL venue-read size,
 *       worst price within max(perpsMaxSlippageBps, 150) bps of mark, capped
 *       at 450 — protect.ts's own cap, inside the venue's 5% band, so the
 *       two exits of one position are never priced by two different bounds. Up to three attempts per market, each
 *       re-priced at a fresh mark and signed only after the previous one
 *       RESOLVED — the next attempt is sized from a read that includes the
 *       last one's fills, and an ambiguous one is never stacked behind. The
 *       bound is never widened: a stand-down that gives up leaves the position
 *       with its stop, which is the contract's promise; one that widens until
 *       it fills sells into a gap the owner never agreed to.
 *   (c) CANCEL a market's remaining orders only once the venue reads THAT
 *       market flat — market-scoped, never account-wide, except for an
 *       incident on an account with no position left anywhere (foreign orders
 *       can sit where no position row names them). Position-tied stops cancel
 *       themselves at zero on the venue; this sweeps what is left.
 *   (d) WITHDRAW the free CROSS collateral, and only it: margin allocated to a
 *       residual isolated position stays with that position (taking it would
 *       move the position toward liquidation), and cross collateral backing an
 *       open cross position is not free at all. Not on /flatten: the route
 *       sends free collateral home after 24 h flat (docs/perps.md, "The perps
 *       route"), and a flatten is not the end of perps.
 *   (e) READ the account once more for the result, then run ONE reconcile, so
 *       the stand-down's own fills and funding are booked while the key is
 *       still held (auth-reads-lost-after-kill-or-recover: history reads need
 *       the key, and after a kill or a recover there is none).
 *
 * BOUNDED. Nothing is sent after `deadlineMs − reserve` (the reserve keeps
 * time for (e)), a send already running is abandoned half-way into the
 * reserve, nothing runs past `deadlineMs`, and every executor and
 * reconcile call is raced against it and handed an AbortSignal that fires
 * when it passes — so an abandoned call's lock wait (protect.ts
 * createPerpLaneLock) refuses to start a send. The executor and api.ts keep
 * their own 5 s HTTP timeouts; this clock is the one above them.
 *
 * THE RESULT IS WHAT THE VENUE SHOWS AT THE END, never what we asked for.
 * `residual`, `ordersLeft` and the money come from the last account read; a
 * stand-down whose final read failed is `unreachable`, and its exposure
 * (standdownExposure) is `unread` — custodySentence then says Lighter could
 * not be read, never that the funds are home.
 *
 * WHAT THIS MODULE DOES NOT DO: sign, persist, read the network or take a
 * lock. Those belong to the executor behind StanddownExecutor (the live one
 * persists every send before it goes, rule 9, under the lane lock). Nor does
 * it latch the lane and the protective loop off, or keep two stand-downs of
 * one account from running at once — the caller holds that latch.
 */

import {
  notionalMicro,
  perpMarketById,
  worstPriceForTaker,
  type PerpExposure,
  type PerpKey,
  type PerpSide,
} from "../../../packages/core/src/perps";
import type { PerpExitIntent } from "../policy";
import type { PerpPlaceResult } from "./executor";
import type { LighterFeedRead } from "./feed-reader";
import type { PerpAccountPosition, PerpAccountRead, PerpDecimals } from "./markets";
import { renderScaled } from "./view";

// ── reasons and limits ──────────────────────────────────────────────────────

export const STANDDOWN_REASONS = Object.freeze(["kill", "expiry", "incident", "flatten"] as const);
export type StanddownReason = (typeof STANDDOWN_REASONS)[number];

export function isStanddownReason(x: unknown): x is StanddownReason {
  return typeof x === "string" && (STANDDOWN_REASONS as readonly string[]).includes(x);
}

/**
 * Whether the reason sends free collateral home. Kill and expiry end the
 * agent's authority; an incident means the key may be someone else's
 * (rule 16: "withdrawals repeated as margin frees"). /flatten only closes: the
 * owner may trade again, and the route's 24 h-flat rule brings idle
 * collateral home without a deposit round trip counted against the day's cap.
 */
export const STANDDOWN_WITHDRAWS: Readonly<Record<StanddownReason, boolean>> = Object.freeze({
  kill: true,
  expiry: true,
  incident: true,
  flatten: false,
});

/** Every number the stand-down acts on, frozen so a test pins each one. */
export const STANDDOWN_LIMITS = Object.freeze({
  /** Close attempts per market (rule 13). */
  maxCloseAttempts: 3,
  /** A close's slippage is never under this (docs/perps.md Settings: "stand-down uses max(this, 150)")… */
  slipFloorBps: 150,
  /**
   * …and never past 4.5%: protect.ts's closeSlipCapBps, inside the venue's 5%
   * band. The two exits of one position share one bound — a stand-down that
   * could accept a worse fill than the protective loop would have is a
   * stand-down that sells deeper into a gap than any other exit the owner
   * agreed to, and 500 sat ON the band's edge, where a mark that moved
   * between the read and the fill puts the order outside it.
   */
  slipCapBps: 450,
  /**
   * Kept back from sending for step (e): one account read and one reconcile.
   * Never more than a quarter of the budget, so a short deadline still sends.
   */
  finalReserveMs: 10_000,
  /** Step (a) may use at most this (and at most a quarter of the budget): the closes must not starve behind it. */
  resolveSubmittedMaxMs: 10_000,
  /** How often an unresolved close is asked about. */
  pollMs: 1_000,
  /** Between close rounds: a book an IOC found empty gets a moment to refill. */
  retryPauseMs: 2_000,
  /** Account reads: tries per read, and the first pause between them. */
  readTries: 3,
  readRetryMs: 1_000,
  /** The first read keeps trying until the send cutoff, backing off to 8 s — but never more than this many times, whatever the clock says. */
  startReadMaxTries: 64,
  /**
   * The longest a stand-down may hold the key: the hosted `perp_standdown`
   * row's 15-minute TTL (rule 13). A later deadline is a caller's bug, and is
   * cut to this rather than trusted.
   */
  maxBudgetMs: 15 * 60_000,
});

/** A close's slippage: the owner's, floored at 150 and capped at 450 bps. Unreadable is the floor, never "no bound". */
export function standdownSlipBps(maxSlippageBps: number | null | undefined): number {
  const l = STANDDOWN_LIMITS;
  const s = typeof maxSlippageBps === "number" && Number.isSafeInteger(maxSlippageBps) && maxSlippageBps > 0 ? maxSlippageBps : l.slipFloorBps;
  return Math.min(l.slipCapBps, Math.max(l.slipFloorBps, s));
}

// ── what the stand-down reads and drives ────────────────────────────────────

/**
 * One position row as the stand-down needs it — a structural slice of
 * markets.ts PerpAccountPosition, so a parsed venue read passes as it is and
 * a paper adapter or a test builds only these fields.
 *
 * `stopResting`, when the adapter read the venue's orders (view.ts restingOf),
 * says whether a STOP rests for the held side; absent, the stand-down falls
 * back to `positionTiedOrderCount > 0` — every position-tied order we place
 * is a stop or a take-profit, and rule 7 puts a stop under every open.
 */
export type StanddownPosition = Pick<
  PerpAccountPosition,
  | "marketId"
  | "symbol"
  | "key"
  | "side"
  | "baseAmount"
  | "marginMode"
  | "allocatedMarginMicro"
  | "positionValueMicro"
  | "openOrderCount"
  | "pendingOrderCount"
  | "positionTiedOrderCount"
> & { stopResting?: boolean | null };

/** One /api/v1/account read (or the paper book shaped like one). A PerpAccountRead plus its decimals fits as it is. */
export interface StanddownAccount
  extends Pick<PerpAccountRead, "collateralMicro" | "totalOrderCount" | "pendingOrderCount" | "poolShareCount" | "pendingUnlockCount"> {
  positions: readonly StanddownPosition[];
  /** Only counted: money outside the perps route is exposure the stand-down cannot unwind (rule 16). */
  spotHoldings: readonly unknown[];
  /** Size and price decimals per market (orderBookDetails), for a mark derived from position_value when the feed is stale. */
  decimals?: ReadonlyMap<number, PerpDecimals>;
}

export interface StanddownCallContext {
  /** Fires at the deadline (and when the stand-down ends): an abandoned call must not go on to send. */
  signal: AbortSignal;
  /** Absolute send cutoff, also checked synchronously when timers are delayed. */
  deadlineMs?: number;
  reason: StanddownReason;
}

export interface StanddownPlaceContext extends StanddownCallContext {
  /** 1-based, per market. */
  attempt: number;
}

/** What a close returned. A live send is `submitted` until resolve() says otherwise; paper is final on return. */
export type StanddownPlaceResult = Pick<PerpPlaceResult, "status" | "orderRowId" | "filledBase"> &
  Partial<Pick<PerpPlaceResult, "realizedMicro" | "detail">>;

/**
 * A close's resolution (rule 9: resolved by tx hash). `submitted` is still in
 * flight; `unknown` could not be read this time. Both are asked again.
 */
export type StanddownResolution =
  | { status: "filled" | "partial" | "cancelled" | "rejected" | "expired"; filledBase?: bigint; realizedMicro?: bigint; detail?: string }
  | { status: "submitted" | "unknown"; detail?: string };

export type StanddownFinalResolution = Exclude<StanddownResolution, { status: "submitted" | "unknown" }>;

const FINAL_RESOLUTIONS: ReadonlySet<string> = new Set(["filled", "partial", "cancelled", "rejected", "expired"]);

/** A resolution that ends the attempt. Anything else — including a status this build does not know — is asked again. */
export function isFinalResolution(r: StanddownResolution): r is StanddownFinalResolution {
  return typeof r === "object" && r !== null && FINAL_RESOLUTIONS.has(r.status);
}

/** A cancel or a withdrawal request, as sent. `rejected` is the venue (or the executor) refusing it: nothing happened. */
export interface StanddownSend {
  status: "submitted" | "executed" | "rejected";
  detail?: string;
}

/**
 * The venue side, as the stand-down drives it. An adapter over a PerpExecutor
 * runs review() then place() for `place` (an exit is never refused by policy,
 * rule 8, so none is consulted), mints the decision the close is filed under,
 * and sends under the lane lock with `ctx.signal`.
 */
export interface StanddownExecutor {
  /** One account read; null (or a throw) is unread. */
  account(ctx: StanddownCallContext): Promise<StanddownAccount | null>;
  /** A reduce-only IOC close, exactly as built here (full venue-read size, bounded worst price). */
  place(intent: PerpExitIntent, ctx: StanddownPlaceContext): Promise<StanddownPlaceResult>;
  /** Resolve a `submitted` close by its order row. Absent: a submitted close can never be shown resolved, so no attempt follows it. */
  resolve?(orderRowId: string, ctx: StanddownCallContext): Promise<StanddownResolution>;
  /** Cancel every order in ONE market (an immediate CancelAllOrders scoped to it). */
  cancelMarket(marketId: number, ctx: StanddownCallContext): Promise<StanddownSend>;
  /** Cancel every order of the account — immediate, never the scheduled kind. Used only for an incident on a flat account. */
  cancelAll?(ctx: StanddownCallContext): Promise<StanddownSend>;
  /** A secure L2 withdrawal of `amountMicro`, judged against the `freeMicro` cross collateral it was computed from. */
  requestWithdraw(amountMicro: bigint, freeMicro: bigint, ctx: StanddownCallContext): Promise<StanddownSend>;
}

/** A reconcile pass's own verdict. void counts as done; a throw or ok:false is not. */
export type StanddownIngest = { ok: boolean; detail?: string } | void;

export interface StanddownReconcile {
  /** Step (a) when the reconcile has a fast path that only resolves submitted rows; reconcileOnce otherwise. */
  resolveSubmitted?(ctx: StanddownCallContext): Promise<StanddownIngest>;
  /** One full authenticated reconcile: resolve, ingest fills, funding and transfers, adopt orphans (reconcile.ts). */
  reconcileOnce(ctx: StanddownCallContext): Promise<StanddownIngest>;
}

// ── what it reports ─────────────────────────────────────────────────────────

export type StanddownStepKind =
  | "begin"
  | "resolve-submitted"
  | "read"
  | "close"
  | "close-resolved"
  | "cancel"
  | "withdraw"
  | "ingest"
  | "deadline"
  | "end";

/** One thing the stand-down did or found — journaled by the caller and shown as progress. Never carries key material. */
export interface StanddownStep {
  kind: StanddownStepKind;
  /** ms, on the stand-down's clock. */
  at: number;
  ok: boolean;
  /** A PerpKey, or the venue symbol of a market outside LIGHTER_MARKETS_V1. */
  market?: string;
  marketId?: number;
  attempt?: number;
  detail: string;
}

export interface StanddownClosed {
  market: PerpKey;
  marketId: number;
  side: PerpSide;
  /** The size held when the stand-down first read the market (venue base units). */
  baseAmount: bigint;
  /** What the stand-down's own closes filled; null when a fill could not be read. The rest, if any, was the venue's stop. */
  filledBase: bigint | null;
  /** The close's P&L — only when the stand-down's own fills closed the whole position and each reported it. Unknown is absent, never 0. */
  realizedMicro?: bigint;
  attempts: number;
  sizeDecimals: number | null;
}

export interface StanddownResidual {
  /** A PerpKey, or the venue symbol of a market outside the table (never ours to trade, still exposure). */
  market: string;
  marketId: number;
  side: PerpSide;
  baseAmount: bigint;
  /** A stop rests under it at the venue, as the last read showed. */
  stopResting: boolean;
  attempts: number;
  sizeDecimals: number | null;
}

/** The money and exposure terms of the last account read. */
export interface StanddownVenue {
  /** ms, on the stand-down's clock. */
  readAt: number;
  /** Taken after the stand-down's last send — the state it left, not one it passed through. */
  final: boolean;
  /** C: cross collateral. */
  collateralMicro: bigint;
  /** ΣM: every position row's allocated isolated margin. */
  isolatedMarginMicro: bigint;
  poolShareCount: number;
  /** Spot-route balances plus pending unlocks. */
  spotBalanceCount: number;
}

export type StanddownOutcome = "done" | "residual" | "unreachable";

export interface StanddownResult {
  reason: StanddownReason;
  /** ms */
  startedAt: number;
  finishedAt: number;
  /** The deadline the run honoured (cut to STANDDOWN_LIMITS.maxBudgetMs). */
  deadlineMs: number;
  /**
   * `done`: the final read shows no position, no order and nothing outside
   * the perps route, and the free collateral is on its way home (or, on
   * /flatten, deliberately kept). `residual`: the final read shows something
   * left. `unreachable`: the final read failed — what is left is unknown.
   */
  outcome: StanddownOutcome;
  closed: StanddownClosed[];
  residual: StanddownResidual[];
  /**
   * Orders still resting at the last read. Counted from both the account's and
   * the rows' counters and the LARGER kept: the venue's two counts may
   * overlap, and a count that overstates is honest where one that understates
   * is not. null: never read.
   */
  ordersLeft: number | null;
  /** The secure withdrawal requested (venue-accepted or in flight); null when none was. */
  withdrawRequestedMicro: bigint | null;
  /** Every step that did not complete, in plain words for the owner. */
  failedSteps: string[];
  /** Step (e) completed: the stand-down's own fills and funding are booked. False leaves the perp book unknown (rule 11). */
  ingested: boolean;
  /** The last successful account read; null when none succeeded. */
  venue: StanddownVenue | null;
}

export interface StanddownOptions {
  reason: StanddownReason;
  /** Absolute ms on `now`'s clock. */
  deadlineMs: number;
  now: () => number;
  executor: StanddownExecutor;
  reconcile: StanddownReconcile;
  /** `maxSlippageBps` is the owner's perpsMaxSlippageBps; null (unread) is the 150 bps floor. */
  settings: { maxSlippageBps: number | null };
  /** The fleet feed, read at each close for a fresh mark; null or absent: marks come from the account read alone. */
  feed?: (() => LighterFeedRead | null) | null;
  /** Each step as it happens. A throwing callback is ignored — progress must not stop a stand-down. */
  onStep?: (step: StanddownStep) => void;
  /** Test seam: how the stand-down waits. Default: a real timer that ends early when the run is aborted. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: shorter waits. Tightening only in effect — they never extend the deadline. */
  limits?: { pollMs?: number; retryPauseMs?: number; readRetryMs?: number };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** setTimeout's ceiling; the budget cap keeps every timer far under it. */
const MAX_TIMER_MS = 2_147_483_647;

class StanddownDeadline extends Error {
  override name = "StanddownDeadline";
}

function errText(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}

function isOpen(p: StanddownPosition): p is StanddownPosition & { side: PerpSide } {
  return p.baseAmount > 0n && (p.side === "long" || p.side === "short");
}

function rowOrders(p: StanddownPosition): number {
  return p.openOrderCount + p.pendingOrderCount + p.positionTiedOrderCount;
}

function ordersOf(a: StanddownAccount): number {
  let rows = 0;
  for (const p of a.positions) rows += rowOrders(p);
  return Math.max(rows, a.totalOrderCount + a.pendingOrderCount);
}

function isolatedOf(a: StanddownAccount): bigint {
  let m = 0n;
  for (const p of a.positions) m += p.allocatedMarginMicro;
  return m;
}

function countOk(n: unknown): boolean {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/**
 * The read's own shape, checked where an adapter could have built it wrong. A
 * read we cannot trust is unread (rule 11): nothing is closed, cancelled or
 * withdrawn on it.
 */
function accountProblem(a: StanddownAccount): string | null {
  if (typeof a !== "object" || a === null) return "not an account";
  if (typeof a.collateralMicro !== "bigint") return "collateral unread";
  if (!Array.isArray(a.positions) || !Array.isArray(a.spotHoldings)) return "positions unread";
  if (![a.totalOrderCount, a.pendingOrderCount, a.poolShareCount, a.pendingUnlockCount].every(countOk)) return "order or share counts unread";
  const seen = new Set<number>();
  for (const p of a.positions) {
    if (typeof p !== "object" || p === null || !Number.isSafeInteger(p.marketId) || seen.has(p.marketId)) return "a position row is unreadable";
    seen.add(p.marketId);
    if (typeof p.baseAmount !== "bigint" || p.baseAmount < 0n) return `market ${p.marketId}'s size is unreadable`;
    if (p.baseAmount > 0n && p.side !== "long" && p.side !== "short") return `market ${p.marketId} is held with no side`;
    if (typeof p.allocatedMarginMicro !== "bigint" || p.allocatedMarginMicro < 0n || typeof p.positionValueMicro !== "bigint") {
      return `market ${p.marketId}'s margin is unreadable`;
    }
    if (p.marginMode !== "cross" && p.marginMode !== "isolated") return `market ${p.marketId}'s margin mode is unreadable`;
    if (![p.openOrderCount, p.pendingOrderCount, p.positionTiedOrderCount].every(countOk)) return `market ${p.marketId}'s order counts are unreadable`;
  }
  return null;
}

/**
 * The venue's mark at the account snapshot, from a position's exact
 * position_value (|s| × mark, 6 dp) — view.ts's derivation, rounded the other
 * way: TOWARD THE CLOSE'S FAVOURABLE SIDE (up for a long, which sells; down
 * for a short, which buys), so the worst price built from it never allows
 * more slippage than the bound. view.ts rounds toward liquidation because it
 * measures distances; this sets a limit.
 */
function markFromPositionValue(valueMicro: bigint, base: bigint, d: PerpDecimals, side: PerpSide): bigint | null {
  const v = valueMicro < 0n ? -valueMicro : valueMicro;
  if (base <= 0n || v <= 0n) return null;
  const num = v * 10n ** BigInt(d.sizeDecimals + d.priceDecimals);
  const den = base * 1_000_000n;
  const q = num / den;
  const m = side === "long" && num % den !== 0n ? q + 1n : q;
  return m > 0n ? m : null;
}

function marketName(p: Pick<StanddownPosition, "key" | "symbol" | "marketId">): string {
  return p.key ?? (p.symbol || `market ${p.marketId}`);
}

// ── the run ─────────────────────────────────────────────────────────────────

interface MarketRun {
  marketId: number;
  key: PerpKey | null;
  name: string;
  side: PerpSide;
  /** The size at the first read that saw it open. */
  startBase: bigint;
  attempts: number;
  /** Σ our fills; null once any fill could not be read. */
  filled: bigint | null;
  /** Σ realized P&L of our fills; null once any fill's P&L was not reported. */
  realized: bigint | null;
  /** Why no further attempt is signed for this market, once one is not. */
  blocked: string | null;
  /**
   * The latest thing that kept this market from closing. Reported only if the
   * market is still open at the end: an attempt that failed before a later
   * one closed the position is not a step the owner needs to hear about.
   */
  issue: string | null;
  sizeDecimals: number | null;
}

interface InFlight {
  run: MarketRun;
  rowId: string;
  attempt: number;
  done: boolean;
}

/**
 * Stand one Lighter account down. Never throws for anything the venue, the
 * executor or the reconcile does — every failure is a line in `failedSteps` —
 * only for arguments built wrong (a reason, clock or deadline that is not one).
 */
export async function runStanddown(o: StanddownOptions): Promise<StanddownResult> {
  if (!isStanddownReason(o.reason)) throw new TypeError(`runStanddown: unknown reason ${String(o.reason)}`);
  if (typeof o.now !== "function") throw new TypeError("runStanddown: now must be a clock");
  if (typeof o.deadlineMs !== "number" || !Number.isFinite(o.deadlineMs)) throw new TypeError("runStanddown: deadlineMs must be a finite ms timestamp");
  if (!o.executor || !o.reconcile) throw new TypeError("runStanddown: an executor and a reconcile are required");

  const { reason, executor, reconcile } = o;
  const L = STANDDOWN_LIMITS;
  const waits = {
    pollMs: positiveOr(o.limits?.pollMs, L.pollMs),
    retryPauseMs: positiveOr(o.limits?.retryPauseMs, L.retryPauseMs),
    readRetryMs: positiveOr(o.limits?.readRetryMs, L.readRetryMs),
  };
  const startedAt = o.now();
  const deadline = Math.min(o.deadlineMs, startedAt + L.maxBudgetMs);
  const budget = Math.max(0, deadline - startedAt);
  const reserve = Math.min(L.finalReserveMs, Math.floor(budget / 4));
  const sendCutoff = deadline - reserve;
  // A send that STARTED before the cutoff may run into the reserve — a lane
  // lock wait or a slow sendTx — but only half of it: the final read and the
  // ingest keep the rest. An aborted send is safe (rule 9: the row is
  // persisted before it goes, and reconcile resolves it either way).
  const sendBound = sendCutoff + Math.floor(reserve / 2);
  const slipBps = standdownSlipBps(o.settings?.maxSlippageBps);

  const failed: string[] = [];
  const fail = (s: string) => {
    if (!failed.includes(s)) failed.push(s);
  };
  const emit = (s: Omit<StanddownStep, "at">) => {
    try {
      o.onStep?.({ ...s, at: o.now() });
    } catch {
      // progress is a courtesy; the stand-down is not
    }
  };

  // THE HARD STOP. Every call's own signal is chained to this one, so at the
  // deadline every call still running is told to stop — and one that was
  // queued for the lane lock never gets to send.
  const overall = new AbortController();
  const hardTimer = setTimeout(
    () => overall.abort(new StanddownDeadline("the stand-down's deadline passed")),
    Math.min(MAX_TIMER_MS, Math.max(0, deadline - startedAt)),
  );
  const sleep =
    o.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        if (overall.signal.aborted) return resolve();
        const t = setTimeout(done, ms);
        function done() {
          clearTimeout(t);
          overall.signal.removeEventListener("abort", done);
          resolve();
        }
        overall.signal.addEventListener("abort", done, { once: true });
      }));

  const ctxOf = (signal: AbortSignal): StanddownCallContext => ({ signal, reason, deadlineMs: sendCutoff });

  /** Run one call against the clock: refused when no time is left, abandoned (and aborted) when it outlives `until`. */
  async function bounded<T>(label: string, until: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const left = Math.min(until, deadline) - o.now();
    if (!(left > 0) || overall.signal.aborted) throw new StanddownDeadline(`${label}: no time was left before the deadline`);
    const ac = new AbortController();
    const relay = () => ac.abort(overall.signal.reason);
    overall.signal.addEventListener("abort", relay, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(() => fn(ac.signal));
    // A call abandoned at the deadline may still settle later; its rejection
    // is nobody's to handle, and must not take the process down with it.
    work.catch(() => {});
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const e = new StanddownDeadline(`${label}: still running at the deadline`);
            ac.abort(e);
            reject(e);
          }, Math.min(MAX_TIMER_MS, left));
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      overall.signal.removeEventListener("abort", relay);
    }
  }

  async function pause(ms: number, until: number): Promise<void> {
    const d = Math.min(ms, until - o.now());
    if (!(d > 0) || overall.signal.aborted) return;
    try {
      await sleep(d);
    } catch {
      // a wait that fails is a wait that ended
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  /** The most recent successful read, whenever it was taken. */
  const reads: { last: { acct: StanddownAccount; at: number } | null } = { last: null };

  /**
   * One account read, retried. `persistent` (the first read only) keeps trying
   * until `until`, backing off to 8 s: a 429 or 405 puts the whole address in
   * a 60 s cooldown (api.ts), and a stand-down that gave up after three quick
   * refusals would leave every position for the next one.
   */
  async function readAccount(label: string, until: number, persistent = false): Promise<StanddownAccount | null> {
    let wait = waits.readRetryMs;
    const tries = persistent ? L.startReadMaxTries : L.readTries;
    for (let i = 1; i <= tries; i++) {
      if (o.now() >= until || overall.signal.aborted) break;
      try {
        const a = await bounded(`account read (${label})`, until, (signal) => executor.account(ctxOf(signal)));
        const why = a === null || a === undefined ? "Lighter returned no account" : accountProblem(a);
        if (why === null && a) {
          const open = a.positions.filter(isOpen).length;
          reads.last = { acct: a, at: o.now() };
          emit({ kind: "read", ok: true, detail: `${label}: ${open} open position(s), ${ordersOf(a)} order(s), cross collateral ${renderScaled(a.collateralMicro, 6)} USDG` });
          return a;
        }
        emit({ kind: "read", ok: false, detail: `${label}: ${why}` });
      } catch (e) {
        emit({ kind: "read", ok: false, detail: `${label}: ${errText(e)}` });
        if (e instanceof StanddownDeadline) break;
      }
      if (i < tries) await pause(wait, until);
      if (persistent) wait = Math.min(8_000, wait * 2);
    }
    return null;
  }

  async function ingest(kind: "resolve-submitted" | "ingest", until: number, fn: (ctx: StanddownCallContext) => Promise<StanddownIngest>): Promise<string | null> {
    try {
      const r = await bounded(kind, until, (signal) => fn(ctxOf(signal)));
      if (r === undefined || r === null || r.ok === true) {
        emit({ kind, ok: true, detail: r?.detail ?? "done" });
        return null;
      }
      const why = r.detail ?? "it reported a failure";
      emit({ kind, ok: false, detail: why });
      return why;
    } catch (e) {
      emit({ kind, ok: false, detail: errText(e) });
      return errText(e);
    }
  }

  const runs = new Map<number, MarketRun>();
  const sizeDecimalsOf = (marketId: number, a: StanddownAccount): number | null => {
    const fm = safeFeed()?.markets.get(marketId);
    return fm?.spec.sizeDecimals ?? a.decimals?.get(marketId)?.sizeDecimals ?? null;
  };
  function safeFeed(): LighterFeedRead | null {
    try {
      return o.feed?.() ?? null;
    } catch {
      return null;
    }
  }
  function track(a: StanddownAccount): void {
    for (const p of a.positions) {
      if (!isOpen(p)) continue;
      const r = runs.get(p.marketId);
      if (r === undefined) {
        const listed = perpMarketById(p.marketId);
        // A row whose key disagrees with the frozen table is a market we
        // cannot name to the executor — and no intent is built for it.
        const key = p.key !== null && listed !== null && listed.key === p.key ? p.key : null;
        const why = key === null ? "it is not a market this agent trades, so no close can be built for it" : null;
        runs.set(p.marketId, {
          marketId: p.marketId,
          key,
          name: marketName(p),
          side: p.side,
          startBase: p.baseAmount,
          attempts: 0,
          filled: 0n,
          realized: 0n,
          blocked: why,
          issue: why,
          sizeDecimals: sizeDecimalsOf(p.marketId, a),
        });
      } else {
        r.side = p.side;
        r.sizeDecimals ??= sizeDecimalsOf(p.marketId, a);
      }
    }
  }
  function settle(run: MarketRun, filledBase: bigint | undefined, realizedMicro: bigint | undefined): void {
    if (filledBase === undefined) {
      run.filled = null;
      run.realized = null;
      return;
    }
    if (run.filled !== null) run.filled += filledBase;
    if (filledBase > 0n) {
      if (realizedMicro === undefined) run.realized = null;
      else if (run.realized !== null) run.realized += realizedMicro;
    }
  }
  /** A market that cannot take another attempt: blocked, or out of attempts. */
  const spent = (r: MarketRun) => r.blocked !== null || r.attempts >= L.maxCloseAttempts;
  /** Set when anything was left undone because the send cutoff came. */
  let cutoffHit = false;

  try {
    emit({
      kind: "begin",
      ok: true,
      detail: `${reason}: closes at ${slipBps} bps from mark, sends until +${Math.max(0, sendCutoff - startedAt)} ms, done by +${budget} ms`,
    });

    // ── (a) what is already in flight ─────────────────────────────────────────
    {
      const until = Math.min(sendCutoff, startedAt + Math.min(L.resolveSubmittedMaxMs, Math.floor(budget / 4)));
      const why = await ingest("resolve-submitted", until, (ctx) =>
        reconcile.resolveSubmitted ? reconcile.resolveSubmitted(ctx) : reconcile.reconcileOnce(ctx),
      );
      if (why !== null) fail(`Orders already sent could not all be resolved first (${why}); the closes went ahead, as an exit always may.`);
    }

    // ── (b) close every position ──────────────────────────────────────────────
    // `acct` is the latest read taken AFTER every send so far, or null (unread
    // since). Every decision below — what to close, which market is flat enough
    // to cancel, what collateral is free — is made on such a read.
    let acct = await readAccount("start", sendCutoff, true);
    if (acct === null) fail("Lighter could not be read, so nothing was closed, cancelled or withdrawn.");
    let sent = false;

    for (let round = 1; acct !== null && round <= L.maxCloseAttempts; round++) {
      track(acct);
      const open = acct.positions.filter(isOpen).sort((x, y) => x.marketId - y.marketId);
      if (open.length === 0) break;
      const feedRead = safeFeed();
      const inFlight: InFlight[] = [];
      let signed = 0;
      let unpriced = 0;
      for (const p of open) {
        const run = runs.get(p.marketId);
        if (run === undefined || spent(run)) continue;
        if (o.now() >= sendCutoff) {
          cutoffHit = true;
          break;
        }
        const priced = markFor(p, acct, feedRead);
        if (priced === null) {
          // NEVER A CLOSE PRICED FROM NOTHING (protect.ts P7): the stop still
          // rests, and the next round's read may carry a mark.
          run.issue = "no fresh mark could be read, so no close could be priced";
          unpriced += 1;
          emit({ kind: "close", ok: false, market: run.name, marketId: p.marketId, detail: "no fresh mark" });
          continue;
        }
        let intent: PerpExitIntent;
        try {
          intent = {
            kind: "perp-order",
            venue: "lighter",
            market: run.key as PerpKey,
            marketId: p.marketId,
            effect: "close",
            side: p.side,
            reduceOnly: true,
            // THE FULL VENUE-READ SIZE (rule 8): reduce-only at the venue means
            // an over-sized close can never flip the position, and an
            // under-sized one leaves a stub nobody may be around to close.
            baseAmount: p.baseAmount,
            worstPrice: worstPriceForTaker({ isAsk: p.side === "long", mark: priced.mark, maxSlippageBps: slipBps }),
            markPrice: priced.mark,
            // Informational on an exit; at the mark, as drafts.ts states it.
            notionalUsdg: notionalMicro(p.baseAmount, priced.mark, priced.d, "ceil"),
          };
        } catch (e) {
          run.blocked = run.issue = `no close price could be built from its mark (${errText(e)})`;
          continue;
        }
        run.attempts += 1;
        const attempt = run.attempts;
        signed += 1;
        sent = true;
        try {
          const r = await bounded(`close ${run.name}`, sendBound, (signal) => executor.place(intent, { ...ctxOf(signal), deadlineMs: sendBound, attempt }));
          emit({
            kind: "close",
            ok: r.status !== "rejected",
            market: run.name,
            marketId: p.marketId,
            attempt,
            detail: `${r.status}: ${p.side} ${p.baseAmount} at worst ${intent.worstPrice} (mark ${priced.mark}, ${priced.source})${r.detail ? ` — ${r.detail}` : ""}`,
          });
          if (r.status === "submitted") {
            inFlight.push({ run, rowId: r.orderRowId, attempt, done: false });
          } else {
            settle(run, typeof r.filledBase === "bigint" ? r.filledBase : undefined, r.realizedMicro);
            if (r.status !== "filled") run.issue = `close attempt ${attempt} ended ${r.status}${r.detail ? ` (${r.detail})` : ""}`;
          }
        } catch (e) {
          // Nothing to resolve by: the executor either never sent (rule 9: a
          // failed persist sends nothing) or sent, and reconcile will find the
          // persisted row. Either way a reduce-only close may be signed anew —
          // it cannot flip, and once a later nonce executes the earlier is dead.
          emit({ kind: "close", ok: false, market: run.name, marketId: p.marketId, attempt, detail: errText(e) });
          run.issue = `close attempt ${attempt} failed (${errText(e)})`;
          run.filled = null;
          run.realized = null;
          if (e instanceof StanddownDeadline) {
            cutoffHit = true;
            break;
          }
        }
      }

      // Each attempt RESOLVES before the next is signed for its market.
      if (inFlight.length > 0) await awaitResolutions(inFlight);
      // Nothing signed and nothing waiting on a mark: no read would change a thing.
      if (signed === 0 && unpriced === 0) break;
      if (o.now() >= sendCutoff) {
        // Past the cutoff nothing more is sent, so no decision needs a read;
        // the final read (step e) says what was left.
        cutoffHit = true;
        acct = null;
        break;
      }
      acct = await readAccount(`after close round ${round}`, sendCutoff);
      if (acct === null) {
        fail("Lighter could not be read after the closes, so no order was cancelled and no withdrawal requested.");
        break;
      }
      track(acct);
      const again = acct.positions.some((p) => {
        const r = runs.get(p.marketId);
        return isOpen(p) && r !== undefined && !spent(r);
      });
      if (!again) break;
      await pause(waits.retryPauseMs, sendCutoff);
    }

    function markFor(
      p: StanddownPosition & { side: PerpSide },
      a: StanddownAccount,
      feedRead: LighterFeedRead | null,
    ): { mark: bigint; d: PerpDecimals; source: "feed" | "account" } | null {
      // One mark convention with the view (and so protect.ts): the fleet feed's
      // when fresh, else the venue's own at this read's snapshot.
      const fm = feedRead?.markets.get(p.marketId);
      if (fm !== undefined && feedRead !== null && fm.fresh && !feedRead.stale.has(p.marketId) && fm.mark > 0n) {
        return { mark: fm.mark, d: fm.spec, source: "feed" };
      }
      const d = fm?.spec ?? a.decimals?.get(p.marketId);
      if (d === undefined) return null;
      const m = markFromPositionValue(p.positionValueMicro, p.baseAmount, d, p.side);
      return m === null ? null : { mark: m, d, source: "account" };
    }

    async function awaitResolutions(inFlight: InFlight[]): Promise<void> {
      const resolve = executor.resolve?.bind(executor);
      if (resolve === undefined) {
        for (const f of inFlight) {
          f.run.blocked = f.run.issue = `close attempt ${f.attempt} was sent and cannot be shown resolved, so none was signed behind it`;
          f.run.filled = null;
          f.run.realized = null;
        }
        return;
      }
      let first = true;
      while (inFlight.some((f) => !f.done) && o.now() < sendCutoff && !overall.signal.aborted) {
        if (!first) await pause(waits.pollMs, sendCutoff);
        first = false;
        for (const f of inFlight) {
          if (f.done) continue;
          let got: StanddownResolution;
          try {
            got = await bounded(`resolve ${f.run.name}`, sendCutoff, (signal) => resolve(f.rowId, ctxOf(signal)));
          } catch (e) {
            if (e instanceof StanddownDeadline) break;
            continue; // unread this time; asked again
          }
          if (!isFinalResolution(got)) continue;
          const r = got;
          f.done = true;
          emit({
            kind: "close-resolved",
            ok: r.status !== "rejected" && r.status !== "expired",
            market: f.run.name,
            marketId: f.run.marketId,
            attempt: f.attempt,
            detail: `${r.status}${r.filledBase !== undefined ? `: filled ${r.filledBase}` : ""}${r.detail ? ` — ${r.detail}` : ""}`,
          });
          settle(f.run, r.filledBase, r.realizedMicro);
          if (r.status !== "filled") f.run.issue = `close attempt ${f.attempt} ended ${r.status}${r.detail ? ` (${r.detail})` : ""}`;
        }
      }
      for (const f of inFlight) {
        if (f.done) continue;
        // AMBIGUOUS, SO NOTHING IS STACKED BEHIND IT. Whether it filled is the
        // final read's to say, and reconcile's to book.
        f.run.blocked = f.run.issue = `close attempt ${f.attempt} was sent and not resolved in time, so none was signed behind it`;
        f.run.filled = null;
        f.run.realized = null;
      }
    }

    // ── (c) cancel what is left, market by market, on flat markets only ──────
    let cancelled = false;
    if (acct !== null) {
      const a = acct;
      const anyOpen = a.positions.some(isOpen);
      const orders = ordersOf(a);
      if (reason === "incident" && !anyOpen && orders > 0 && typeof executor.cancelAll === "function") {
        // An incident on a FLAT account: foreign orders can rest where no
        // position row names them (a spot book, a market we never touched), and
        // with no position anywhere there is no stop left to lose.
        if (o.now() < sendCutoff) {
          cancelled = (await sendCancel("account", null, (signal) => executor.cancelAll!(ctxOf(signal)))) || cancelled;
        } else {
          cutoffHit = true;
        }
      } else {
        for (const p of [...a.positions].sort((x, y) => x.marketId - y.marketId)) {
          // THE RULE THIS WHOLE MODULE EXISTS FOR: a market whose position is
          // still open keeps every order it has — its stop above all.
          if (p.baseAmount !== 0n || rowOrders(p) === 0) continue;
          if (o.now() >= sendCutoff) {
            cutoffHit = true;
            fail(`${marketName(p)}: ${rowOrders(p)} order(s) left resting — the deadline came before they could be cancelled.`);
            continue;
          }
          cancelled = (await sendCancel("market", p, (signal) => executor.cancelMarket(p.marketId, ctxOf(signal)))) || cancelled;
        }
      }
    }

    async function sendCancel(scope: "market" | "account", p: StanddownPosition | null, fn: (signal: AbortSignal) => Promise<StanddownSend>): Promise<boolean> {
      const name = p === null ? "the account" : marketName(p);
      sent = true;
      try {
        const r = await bounded(`cancel ${name}`, sendBound, fn);
        const ok = r.status !== "rejected";
        emit({ kind: "cancel", ok, ...(p ? { market: name, marketId: p.marketId } : {}), detail: `${scope}: ${r.status}${r.detail ? ` — ${r.detail}` : ""}` });
        if (!ok) fail(`Cancelling the orders on ${name} was refused${r.detail ? ` (${r.detail})` : ""}.`);
        return ok;
      } catch (e) {
        emit({ kind: "cancel", ok: false, ...(p ? { market: name, marketId: p.marketId } : {}), detail: `${scope}: ${errText(e)}` });
        fail(`Cancelling the orders on ${name} failed (${errText(e)}).`);
        return false;
      }
    }

    // ── (d) free cross collateral home ────────────────────────────────────────
    let withdrawRequestedMicro: bigint | null = null;
    if (!STANDDOWN_WITHDRAWS[reason]) {
      emit({ kind: "withdraw", ok: true, detail: `${reason} keeps collateral at Lighter` });
    } else if (acct !== null) {
      // A cancel may free margin an order reserved: read what is free NOW.
      const a = cancelled && o.now() < sendCutoff ? await readAccount("before the withdrawal", sendCutoff) : acct;
      if (a === null) {
        fail("Free collateral could not be read after the cancels, so no withdrawal was requested.");
      } else {
        const crossOpen = a.positions.filter((p) => isOpen(p) && p.marginMode === "cross");
        const free = a.collateralMicro;
        if (crossOpen.length > 0) {
          // Cross collateral backing an open cross position is not free: taking
          // it would pull that position toward liquidation.
          fail(`No withdrawal: the cross collateral backs ${crossOpen.map(marketName).join(", ")}, still open in cross margin.`);
        } else if (free <= 0n) {
          emit({ kind: "withdraw", ok: true, detail: "no free cross collateral to withdraw" });
        } else if (o.now() >= sendCutoff) {
          cutoffHit = true;
          fail(`No withdrawal: the deadline came before ${renderScaled(free, 6)} USDG of free collateral could be requested home.`);
        } else {
          sent = true;
          try {
            const r = await bounded("withdraw", sendBound, (signal) => executor.requestWithdraw(free, free, ctxOf(signal)));
            const ok = r.status !== "rejected";
            emit({ kind: "withdraw", ok, detail: `${renderScaled(free, 6)} USDG: ${r.status}${r.detail ? ` — ${r.detail}` : ""}` });
            if (ok) withdrawRequestedMicro = free;
            else fail(`The withdrawal of ${renderScaled(free, 6)} USDG was refused${r.detail ? ` (${r.detail})` : ""}.`);
          } catch (e) {
            emit({ kind: "withdraw", ok: false, detail: errText(e) });
            // It may or may not have gone: reconcile resolves the row (rule 9);
            // the owner is told it is uncertain, not that it happened.
            fail(`The withdrawal of ${renderScaled(free, 6)} USDG may not have been sent (${errText(e)}).`);
          }
        }
      }
    }

    // ── (e) the state left, then the ledger closed ────────────────────────────
    // The read first: it is one call, and it is what the owner is told. The
    // reconcile after it may use the rest of the time.
    const finalAcct = sent || acct === null ? await readAccount("final", deadline) : acct;
    const ingestWhy = await ingest("ingest", deadline, (ctx) => reconcile.reconcileOnce(ctx));
    const ingested = ingestWhy === null;
    if (!ingested) {
      fail(`The stand-down's own fills and funding were not booked (${ingestWhy}); the perps ledger stays unknown until they are.`);
    }

    // ── the result ────────────────────────────────────────────────────────────
    // THE FINAL READ, or — when it failed — the last one that succeeded, which
    // is reported as last known (outcome `unreachable`, exposure `unread`).
    const basis = finalAcct ?? reads.last?.acct ?? null;
    const basisAt = reads.last?.at ?? o.now();
    if (basis !== null) track(basis);
    const closed: StanddownClosed[] = [];
    const residual: StanddownResidual[] = [];
    if (basis !== null) {
      const openNow = new Map<number, StanddownPosition & { side: PerpSide }>();
      for (const p of basis.positions) if (isOpen(p)) openNow.set(p.marketId, p);
      for (const run of [...runs.values()].sort((x, y) => x.marketId - y.marketId)) {
        if (openNow.has(run.marketId) || run.key === null) continue;
        const entry: StanddownClosed = {
          market: run.key,
          marketId: run.marketId,
          side: run.side,
          baseAmount: run.startBase,
          filledBase: run.filled,
          attempts: run.attempts,
          sizeDecimals: run.sizeDecimals,
        };
        if (run.filled !== null && run.filled >= run.startBase && run.realized !== null && run.filled > 0n) entry.realizedMicro = run.realized;
        closed.push(entry);
      }
      for (const p of [...openNow.values()].sort((x, y) => x.marketId - y.marketId)) {
        const run = runs.get(p.marketId);
        residual.push({
          market: marketName(p),
          marketId: p.marketId,
          side: p.side,
          baseAmount: p.baseAmount,
          stopResting: typeof p.stopResting === "boolean" ? p.stopResting : p.positionTiedOrderCount > 0,
          attempts: run?.attempts ?? 0,
          sizeDecimals: run?.sizeDecimals ?? sizeDecimalsOf(p.marketId, basis),
        });
      }
    }
    // Why each market still open is still open — said once per market, and only
    // for those: an attempt that failed before a later one closed the position
    // is not a step that did not complete.
    for (const r of residual) {
      const run = runs.get(r.marketId);
      const stop = r.stopResting ? "its stop stays resting" : "no stop was seen resting under it";
      let why: string;
      if (run === undefined) why = "it was first seen open after the last close could be sent";
      else if (run.blocked !== null) why = run.blocked;
      else if (run.attempts >= L.maxCloseAttempts) {
        why = `still open after ${run.attempts} close attempts within ${slipBps} bps of mark${run.issue ? ` (the last: ${run.issue})` : ""}`;
      } else if (cutoffHit) why = `the deadline came before it could be closed${run.issue ? ` (${run.issue})` : ""}`;
      else why = run.issue ?? "it was not closed";
      fail(`${r.market}: ${why}; ${stop}.`);
    }
    if (cutoffHit) {
      emit({ kind: "deadline", ok: false, detail: "sending stopped at the deadline" });
      fail("The deadline came before the stand-down finished; what was left is listed above, and every stop still resting stays in place.");
    }
    const ordersLeft = basis === null ? null : ordersOf(basis);
    const venue: StanddownVenue | null =
      basis === null
        ? null
        : {
            readAt: basisAt,
            final: finalAcct !== null,
            collateralMicro: basis.collateralMicro,
            isolatedMarginMicro: isolatedOf(basis),
            poolShareCount: basis.poolShareCount,
            spotBalanceCount: basis.spotHoldings.length + basis.pendingUnlockCount,
          };

    let outcome: StanddownOutcome;
    if (finalAcct === null) {
      outcome = "unreachable";
    } else {
      const collateralLeft = STANDDOWN_WITHDRAWS[reason] && finalAcct.collateralMicro > 0n && withdrawRequestedMicro === null;
      const left =
        residual.length > 0 ||
        (ordersLeft ?? 0) > 0 ||
        isolatedOf(finalAcct) > 0n ||
        finalAcct.poolShareCount > 0 ||
        finalAcct.spotHoldings.length + finalAcct.pendingUnlockCount > 0 ||
        collateralLeft;
      outcome = left ? "residual" : "done";
      if (finalAcct.poolShareCount > 0 || finalAcct.spotHoldings.length + finalAcct.pendingUnlockCount > 0) {
        fail("Lighter shows public-pool shares or spot balances on this account, which a stand-down cannot unwind; `merrymen recover` can.");
      }
    }

    const finishedAt = o.now();
    emit({ kind: "end", ok: outcome === "done", detail: `${outcome}: ${closed.length} closed, ${residual.length} left open, ${ordersLeft ?? "unknown"} order(s) left` });
    return {
      reason,
      startedAt,
      finishedAt,
      deadlineMs: deadline,
      outcome,
      closed,
      residual,
      ordersLeft,
      withdrawRequestedMicro,
      failedSteps: failed,
      ingested,
      venue,
    };
  } finally {
    clearTimeout(hardTimer);
    // Anything still running (a call abandoned at its bound) is told the run is over.
    overall.abort(new StanddownDeadline("the stand-down has ended"));
  }
}

function positiveOr(v: number | undefined, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
}

// ── what the owner is told ──────────────────────────────────────────────────

function signedUsdg(micro: bigint): string {
  const neg = micro < 0n;
  const a = neg ? -micro : micro;
  const cents = (a + 5_000n) / 10_000n;
  return `${neg ? "-" : "+"}${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")} USDG`;
}

function sizeText(base: bigint, d: number | null): string {
  return d === null ? "" : ` ${renderScaled(base, d)}`;
}

/** The result's closed and residual markets as custodySentence's `standdown` lines. */
export function standdownLines(result: Pick<StanddownResult, "closed" | "residual">): { closed: string[]; residual: string[] } {
  return {
    closed: result.closed.map(
      (c) => `${c.market} ${c.side}${sizeText(c.baseAmount, c.sizeDecimals)}${c.realizedMicro !== undefined ? ` (realized ${signedUsdg(c.realizedMicro)})` : ""}`,
    ),
    residual: result.residual.map(
      (r) => `${r.market} ${r.side}${sizeText(r.baseAmount, r.sizeDecimals)} (${r.stopResting ? "its stop is still resting" : "no stop was seen resting"})`,
    ),
  };
}

/**
 * The PerpExposure a kill, expiry or flatten message is built from
 * (custodySentence). What the stand-down cannot know comes from the caller,
 * and is required so that nobody defaults it to zero: money already in
 * transit from EARLIER withdrawals and deposits (the ledger's perp_transfers),
 * the other accounts under our L1 address (flatness.ts; null = not read,
 * which custodySentence says out loud) and the venue's withdrawal delay.
 *
 * Never `none`: that word is for an account that never had a venue leg, and
 * this one ran a stand-down. An unreachable result is `unread`.
 */
export function standdownExposure(
  result: StanddownResult,
  extra: {
    pendingWithdrawalsMicro: bigint | null;
    depositsInTransitMicro: bigint | null;
    otherAccounts: { count: number; valueMicro: bigint | null } | null;
    withdrawalDelaySec: number | null;
  },
): PerpExposure {
  const v = result.venue;
  if (result.outcome === "unreachable" || v === null || !v.final || result.ordersLeft === null ||
      extra.pendingWithdrawalsMicro === null || extra.depositsInTransitMicro === null) return { kind: "unread" };
  const lines = standdownLines(result);
  return {
    kind: "known",
    // Money still at the venue: the cross collateral AND every isolated
    // margin (a residual position's is still on Lighter). While the requested
    // withdrawal has not executed it is counted here too — it IS still there.
    collateralMicro: v.collateralMicro + v.isolatedMarginMicro,
    openPositions: result.residual.length,
    openOrders: result.ordersLeft,
    pendingWithdrawalsMicro: extra.pendingWithdrawalsMicro,
    depositsInTransitMicro: extra.depositsInTransitMicro,
    poolShareCount: v.poolShareCount,
    spotBalanceCount: v.spotBalanceCount,
    otherAccounts: extra.otherAccounts,
    withdrawalDelaySec: extra.withdrawalDelaySec,
    standdown: {
      closed: lines.closed,
      residual: lines.residual,
      withdrawRequestedMicro: result.withdrawRequestedMicro,
      failedSteps: [...result.failedSteps],
    },
  };
}

/** One step as a progress line (the CLI's and the progress file's). */
export function standdownStepLine(step: StanddownStep): string {
  const where = step.market ? ` ${step.market}` : "";
  const n = step.attempt !== undefined ? ` #${step.attempt}` : "";
  return `${step.ok ? "ok" : "!!"} ${step.kind}${where}${n}: ${step.detail}`;
}
