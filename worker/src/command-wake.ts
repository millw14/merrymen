/**
 * AN ORDER THAT LANDS BETWEEN TICKS WAKES ONE TICK.
 *
 * Pickup used to be the tick itself. The orchestrator ferried commands on its
 * reconcile pass and the child drained at most one per tick, so on the hosted
 * 240-second cadence an owner who pressed Buy waited up to four and a half
 * minutes to hear anything — long enough to press it again, be told an order
 * was already waiting, and then watch the first one fill.
 *
 * WHY A TICK AND NOT A SIDE DOOR. The obvious fix is to drain the file the
 * moment it appears. But an order must not be placed on old numbers: the
 * drawdown breaker judges it against this account's equity, and a figure from
 * four minutes ago is a breaker switched off. Re-reading equity means the
 * tick's own book read — balances, positions, the class vault, quarantine,
 * every fail-closed return in it — and a second copy of that is the copy that
 * drifts. So the watcher does not drain anything. It wakes a COMMAND TICK: the
 * tick with its producers left out, which re-reads the market and the book and
 * then drains under the same `commandInFlight` guard, the same unlink claim and
 * the same deadline checks as every other tick. See tickPlan below.
 *
 * ONCE PER ORDER. A tick can finish without draining — an unarmed worker
 * returns before it gets there — and the file then sits in the queue until its
 * window closes. Waking for it again would be a tick every two seconds against
 * a rate-limited chain for as long as that lasts. So each id is owed one wake,
 * taken one at a time; after that it waits for the regular cadence, exactly as
 * every order used to. And an id is only spent on a wake that actually
 * happened: a watcher that "used up" an order while it could not act would
 * leave that order to the four-minute wait this exists to remove.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ORDER_IN_FLIGHT_MS } from "./command-files";

/** How close the regular tick may be before the watcher leaves the order to it. */
export const COMMAND_WAKE_MIN_LEAD_MS = 5_000;

/** How often the child looks at its own queue. A directory listing, nothing more. */
export const COMMAND_WAKE_EVERY_MS = 2_000;

/**
 * How often the clock writes the heartbeat for a process that is waiting on a
 * trade it sent. Far inside the watchdog's floor (orchestrator.ts
 * staleThresholdSec, 180 s at the fastest tick) and far above the poll, so a
 * trade out for six minutes is a dozen writes of one small file.
 */
export const ALIVE_BEAT_EVERY_MS = 30_000;

/** What one heartbeat says. */
export interface Beat {
  /** The published mode (exec-mode.ts publishedMode). */
  mode: string;
  /** Who pays gas, as this process resolved it. */
  sponsorGas: boolean;
  /** The chain height, when it was read. Omitted rather than zeroed: a zero is a claim about the chain. */
  block?: bigint;
}

/**
 * THE HEARTBEAT FILE, and the only writer of it: `{at, block?, mode, sponsorGas}`,
 * `at` in unix seconds — what the orchestrator's watchdog (orchestrator.ts
 * heartbeatAt) reads to decide a child is alive. Throws when it cannot write;
 * every caller treats a beat as best-effort.
 */
export function writeHeartbeat(
  file: string,
  beat: Beat,
  nowMs: number,
  write: (file: string, body: string) => void = writeBeatFile,
): void {
  const at = Math.floor(nowMs / 1000);
  write(
    file,
    JSON.stringify({ at, ...(beat.block === undefined ? {} : { block: beat.block.toString() }), mode: beat.mode, sponsorGas: beat.sponsorGas }),
  );
}

function writeBeatFile(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
}

/**
 * May a command tick start now?
 *
 *   ticked            — at least one regular tick has completed. Before that
 *                       nothing is armed, and the first tick is staggered
 *                       across the fleet on purpose; a wake must not undo that.
 *   tickRunning       — never beside a running tick: two ticks at once are two
 *                       drains, and the tick's own reads race each other.
 *   commandInFlight   — never beside an order still in flight, nor beside any
 *                       trade still on the intent chain (a Telegram order has
 *                       no command slot, and a command tick's reads under it
 *                       are the same reads under a live trade). The guard in
 *                       runQueuedCommand would refuse a second command anyway;
 *                       asking here keeps the order's one wake for a moment it
 *                       can use.
 *   regularDueInMs    — null when no regular tick is on the clock (one is
 *                       running, or none is armed): there is nothing to hand
 *                       the cadence back to. Within the lead, the regular tick
 *                       is about to drain the order itself.
 */
export function commandTickReady(s: {
  ticked: boolean;
  tickRunning: boolean;
  commandInFlight: boolean;
  regularDueInMs: number | null;
}): boolean {
  if (!s.ticked || s.tickRunning || s.commandInFlight) return false;
  if (s.regularDueInMs === null || !Number.isFinite(s.regularDueInMs)) return false;
  return s.regularDueInMs > COMMAND_WAKE_MIN_LEAD_MS;
}

/**
 * The watcher. `poll` is called on a short interval and returns whether it
 * woke a tick this time.
 *
 * ONE WAKE OWED PER ORDER, NOT PER LOOK. A command tick drains one live
 * command, so two ids that arrive in the same look — a probe beside an order,
 * or two rows one ferry pass delivered — are two wakes, taken one at a time as
 * `ready` allows. It used to mark every new id woken and wake once, which
 * spent the second on a tick that could never reach it and left it to the
 * regular cadence with the worker idle.
 *
 * Owed wakes never outnumber the files still listed: an order some other tick
 * already drained leaves nothing for a command tick to do, and a wake for it
 * would be a full read of the chain for nothing.
 */
export function createCommandWake(deps: {
  /** What is queued right now — a listing (command-files.ts `queuedCommandIds`). */
  pending: () => readonly string[];
  /** Whether a command tick may start now. See commandTickReady. */
  ready: () => boolean;
  /** Start the command tick. False when the clock turned it down, which spends nothing. */
  wake: () => boolean;
}): { poll(): boolean } {
  // Every id already counted, so a file still sitting there is never owed a
  // second wake (the unarmed worker — see the header).
  const counted = new Set<string>();
  let owed = 0;
  return {
    poll() {
      const ids = deps.pending();
      // An id that left the queue was claimed or dropped; forgetting it keeps
      // this set as small as the queue, for the life of the process.
      const listed = new Set(ids);
      for (const id of counted) if (!listed.has(id)) counted.delete(id);
      for (const id of ids) {
        if (counted.has(id)) continue;
        counted.add(id);
        owed += 1;
      }
      owed = Math.min(owed, listed.size);
      if (owed === 0) return false;
      if (!deps.ready()) return false;
      if (!deps.wake()) return false;
      owed -= 1;
      return true;
    },
  };
}

/** Regular execution, owner-command execution, and group-nomination research ticks. */
export type TickKind = "regular" | "command" | "nomination";

/**
 * WHAT A TICK DOES, decided once at its top and read wherever it forks.
 *
 * It used to be a boolean tested inline in three places inside main(), where
 * no test can reach; dropping any one of them typechecked and passed. Every
 * decision an extra command or nomination tick makes differently lives here.
 *
 *   ratchets   — observe this tick's equity into what only ever goes up, and
 *                record it: the fee and high-water-mark accrual, the
 *                risk-period peak, the paper peak, the equity row. Off on a
 *                command or nomination tick. The fee above the mark follows the running
 *                maximum of SAMPLED equity, and that maximum only rises as
 *                samples are added — so an owner's order that added a sample
 *                could charge a fee on a transient peak the regular cadence
 *                would have missed, and move the breaker's reference point at
 *                the moment it judges that very order. The command tick still
 *                composes equity and the drawdown the order is judged against;
 *                it just does not write them down.
 *   brain      — ask the Brain anything. An owner's order arriving is not a
 *                reason to, and the Brain keeps its own clock.
 *   awaitDrain — wait for the command it drains before the tick ends. A command
 *                tick exists for its order, and ending before the order lands
 *                hands the clock back to a regular tick that would read the
 *                book mid-trade (see createTickClock's `inFlight`). A regular
 *                tick drains beside the strategy, as it always has: its own
 *                intents queue behind the order on the intent chain.
 *   producers  — everything after the drain: stranded resolve, discovery, the
 *                strategy, the class route. Never on command or nomination
 *                ticks: arriving chat work cannot add an execution pass.
 */
export interface TickPlan {
  kind: TickKind;
  ratchets: boolean;
  brain: boolean;
  awaitDrain: boolean;
  producers: boolean;
}

export function tickPlan(kind: TickKind): TickPlan {
  if (kind === "command") return { kind, ratchets: false, brain: false, awaitDrain: true, producers: false };
  // A group may cause a fresh research read, never an extra equity peak,
  // performance fee, queued owner order, or strategy/class execution pass.
  if (kind === "nomination") return { kind, ratchets: false, brain: true, awaitDrain: false, producers: false };
  return { kind, ratchets: true, brain: true, awaitDrain: false, producers: true };
}

/**
 * WHAT A TICK MAY WRITE DOWN, with each write handed in by the tick.
 *
 * `plan.ratchets` was read by five guards inside tick() — the paper peak, the
 * risk-period observation, the fee and the persisted mark, the in-memory mark
 * the breaker divides by, and the equity row — and removing all five passed
 * every test, because the only test read the constant. So the guards live here,
 * and tick() passes the writer to the one call that decides whether it runs.
 *
 * Two more rules than the plan ride along, because they gate the same writes:
 *
 *   curveMarked — a holding valued off a bonding curve has no oracle behind it
 *                 and arrives discontinuously, so no peak may move while one is
 *                 held (index.ts, at curveMarkedSymbols). The equity row is not
 *                 a peak, and is still written.
 *   incomplete  — a book that could not be totalled has no equity to write: a
 *                 gap is honest, a partial total is not. tick() skips the peaks
 *                 for it before it gets here; this holds that too.
 *   held        — flow inference HELD this tick (flow-inference.ts): an op the
 *                 resolver may still settle is in flight, so the cash in this
 *                 equity is not yet split into capital and performance. A
 *                 deposit made during the hold is in the equity and not yet in
 *                 the peak, so a fee accrued now is a fee on principal, and a
 *                 lifetime peak raised now counts the deposit twice once it is
 *                 booked. So no fee, and no paper or lifetime peak.
 *
 *                 THE BREAKER STILL OBSERVES. It used to freeze with the rest,
 *                 and a dropped userOp holds for the resolver's whole 26-hour
 *                 window: a book that ran 100 → 150 → 110 in the hold was
 *                 judged at 110 against 100, no drawdown, while every non-exit
 *                 buy went out. `breakerObservationUsdg` is this tick's equity
 *                 with any cash above the expected baseline taken out
 *                 (flow-inference.ts heldBreakerObservationUsdg), so it cannot
 *                 hold an unbooked deposit; the breaker's peaks — the risk
 *                 period's in the ledger, and the in-memory lift above the
 *                 lifetime mark (`breakerLift`) — take it. Absent, a held tick
 *                 observes nothing, as before.
 *
 *                 AND THE ROW IS WRITTEN, FLAGGED. A 26-hour gap in the curve
 *                 left the hosted anchor (bootstrap-source.ts) and the restart
 *                 baseline a day stale. The row is a true valuation; what it may
 *                 not be is a CASH BASELINE, because a held reading can carry a
 *                 stranded op's movement. So it is written with `flowsHeld`, and
 *                 the two readers that take a baseline from the newest row
 *                 (store.ts lastKnownCashReading, the anchor) skip it.
 *
 * The reads stay unconditional. A command tick still needs the peak its order
 * is judged against — it is asked with `null`, which reads without observing
 * (risk-period.ts) — and the paper and live marks it already has.
 */
export interface TickRatchets {
  /** The paper book's peak after this tick: raised on `book` and written only when this tick may, and past it. */
  paperPeak<B extends { hwmUsdg: number }>(book: B, equityUsdg: number, write: (book: B) => Promise<unknown>): Promise<number>;
  /**
   * The risk-period peak, read with this tick's equity as an observation only
   * when this tick may — or, on a held tick, with the held observation.
   */
  riskPeak<P>(equityUsdg: number, read: (observe: number | null) => Promise<P>): Promise<P>;
  /** The live mark after the accrual: the fee and the mark persisted, on a profit, only when this tick may. */
  accrue(accrual: { profitUsdg: bigint; newHwmUsdg: bigint }, peakUsdg: bigint, persist: () => Promise<unknown>): Promise<bigint>;
  /**
   * THE BREAKER'S LIFT ABOVE THE LIFETIME MARK, after this tick (USDG 6dp).
   *
   * With no risk period standing, the breaker judges against the in-memory
   * lifetime mark — the same figure the fee ratchets — and a held tick may not
   * raise that one. The lift is what held observations saw above it: the
   * breaker's peak is `mark + lift`. Kept RELATIVE to the mark so a capital
   * flow, which moves the mark (and is re-read into it), moves the breaker's
   * peak with it exactly as adjustRiskCapital moves a risk period's. When the
   * mark rises past the old breaker peak the lift is absorbed into it.
   * `peakBefore`/`peakAfter` are the mark on either side of this tick's accrue.
   */
  breakerLift(liftUsdg: bigint, peakBeforeUsdg: bigint, peakAfterUsdg: bigint): bigint;
  /** The equity row: written on a regular tick whose book could be totalled, and flagged when the flows were held. */
  equityRow(write: (row: { flowsHeld: boolean }) => Promise<unknown>): Promise<void>;
}

export function tickRatchets(
  plan: TickPlan,
  book: { incomplete: boolean; curveMarked: number; held?: boolean; breakerObservationUsdg?: bigint },
): TickRatchets {
  const held = book.held === true;
  const may = plan.ratchets && !book.incomplete && book.curveMarked === 0;
  const peaks = may && !held;
  // A held tick's breaker observation, when it may make one: the same guards as
  // every other peak (a command tick or a curve mark observes nothing), and
  // only with the figure the caller computed — never the raw equity.
  const observation = may && held && book.breakerObservationUsdg !== undefined ? book.breakerObservationUsdg : null;
  return {
    async paperPeak(b, equityUsdg, write) {
      if (peaks && equityUsdg > b.hwmUsdg) {
        b.hwmUsdg = equityUsdg;
        await write(b);
      }
      return b.hwmUsdg;
    },
    riskPeak: (equityUsdg, read) => read(peaks ? equityUsdg : observation !== null ? Number(observation) / 1e6 : null),
    async accrue(accrual, peakUsdg, persist) {
      if (!peaks) return peakUsdg;
      if (accrual.profitUsdg > 0n) await persist();
      return accrual.newHwmUsdg;
    },
    breakerLift(liftUsdg, peakBeforeUsdg, peakAfterUsdg) {
      const stood = peakBeforeUsdg + liftUsdg - peakAfterUsdg;
      let lift = stood > 0n ? stood : 0n;
      if (observation !== null && observation - peakAfterUsdg > lift) lift = observation - peakAfterUsdg;
      return lift;
    },
    async equityRow(write) {
      if (plan.ratchets && !book.incomplete) await write({ flowsHeld: held });
    },
  };
}

/**
 * WHOSE PEAK THE IN-MEMORY MARK IS. tick() keeps one `highWaterMarkUsdg`, and a
 * paper tick puts the PAPER book's peak in it — the figure the paper breaker
 * judges against. On a live tick the same variable is the lifetime mark the
 * performance fee ratchets, and the breaker's peak when no risk period stands.
 */
export type MarkBook = "live" | "paper";

/**
 * WHETHER A TICK RE-READS THE PERSISTED LIVE PEAKS, before it reads a balance.
 *
 *   capitalPeakDirty — an energy purchase lowered them in the ledger and the
 *                      in-memory marks have not caught up, on purpose (index.ts,
 *                      at the flag).
 *   a paper mark     — the last tick to set the mark was a paper tick. Arm, a
 *                      booked flow, a landed transfer and an energy purchase
 *                      re-read the live mark; going live again is none of those.
 *                      So the first live tick after one accrued a performance
 *                      fee on live equity above the PAPER peak — the owner's
 *                      principal, whenever the account sat below its real mark —
 *                      and with no risk period standing the breaker judged live
 *                      drawdown against the paper book. An owner turning Live off
 *                      and on did it, and so did a live rail that broke and
 *                      recovered: paper is the fallback while it is down.
 *
 * Never on a paper tick: the paper branch sets the mark that tick judges by.
 */
export function livePeaksStale(paper: boolean, markBook: MarkBook, capitalPeakDirty: boolean): boolean {
  return !paper && (capitalPeakDirty || markBook === "paper");
}

/**
 * The tick's drain, run the way its plan says. Resolves to whether the tick
 * goes on to its producers.
 *
 * NEVER THROWS, on either kind: a drain that failed has written its own
 * receipt or left the file for the next tick, and it is no reason for the
 * tick to stop reading.
 */
export async function drainOnTick(plan: TickPlan, drain: () => Promise<unknown>): Promise<boolean> {
  if (plan.kind === "nomination") return false;
  let run: Promise<unknown>;
  try {
    run = drain();
  } catch (e) {
    run = Promise.reject(e);
  }
  const landed = run.then(
    () => {},
    () => {},
  );
  if (plan.awaitDrain) await landed;
  return plan.producers;
}

/** A read failure still answers queued owner commands on execution ticks.
 * Research ticks leave every command untouched, including self-tests and
 * resets that can mutate money or accounting without a complete market read. */
export async function drainOnUnreadTick(plan: TickPlan, drain: () => Promise<unknown>): Promise<void> {
  if (plan.kind === "nomination") return;
  try { await drain(); } catch { /* The drain owns its result or retry. */ }
}

/**
 * ONE OWNER COMMAND IN FLIGHT, and a way to wait for it.
 *
 * This was a bare `commandInFlight` boolean in main(): the one-at-a-time rule
 * for dashboard commands, readable by nothing that could wait on it. The clock
 * now has to wait on it — a regular tick must not read the book while an order
 * is between inclusion and its row — so the flag became a slot that also says
 * when it frees.
 *
 *   run(body)  — runs `body` as THE command in flight and resolves true, or
 *                resolves false WITHOUT calling it when one already is.
 *                Refused, not queued: a queued second drain is the two
 *                in-flight commands the rule exists to forbid. The check and
 *                the claim are synchronous, so two callers in one turn of the
 *                event loop cannot both get in.
 *   busy()     — whether one is in flight.
 *   settled()  — resolves when the one in flight has finished, however it
 *                finished; null when none is. Null again the moment it frees,
 *                so a waiter that re-asks never spins on a resolved promise.
 *   since()    — when the one in flight started; null when none is. What the
 *                clock times a wait against (createCommandClock's beat).
 */
export interface OrderInFlight {
  run(body: () => Promise<void>): Promise<boolean>;
  busy(): boolean;
  settled(): Promise<void> | null;
  since(): number | null;
}

export function createOrderInFlight(now: () => number = Date.now): OrderInFlight {
  let current: Promise<void> | null = null;
  let startedAt: number | null = null;
  return {
    async run(body) {
      if (current) return false;
      let free!: () => void;
      current = new Promise<void>((r) => (free = r));
      startedAt = now();
      try {
        await body();
      } finally {
        current = null;
        startedAt = null;
        free();
      }
      return true;
    },
    busy: () => current !== null,
    settled: () => current,
    since: () => startedAt,
  };
}

/**
 * EVERY TRADE ON THE INTENT CHAIN, counted from the moment it joins the chain
 * until it settles — however it settles.
 *
 * The command slot above only knows about commands. A trade typed in Telegram
 * goes straight to submitChatTrade and onto the chain, a regular tick's drain
 * runs beside its strategy, and a strategy's own intent waits on the same
 * receipts: each of them is a trade between its send and its row, and the
 * clock has to see all of them — to hold a regular tick off a book they are
 * still changing, and to say the process is alive while it waits on them.
 *
 * Counted from JOINING the chain, not from starting on it: a trade queued
 * behind another is already owed, and a regular tick that started in the gap
 * between the two would read the book as the second one went out.
 *
 *   run(step)  — `step` is the call that puts the trade on the chain; it is
 *                called at once, and its promise comes back untouched, value
 *                and failure alike. Busy until it settles.
 *   busy()     — whether any trade is on the chain.
 *   settled()  — resolves when the last one settles; null when none is.
 *   movedAt()  — when the chain last made progress: work starting from idle,
 *                or a trade settling. Null when idle. Joining the queue is not
 *                progress, so a trade typed behind a stuck one cannot keep a
 *                wedged process looking alive (createCommandClock).
 */
export interface LiveTrades {
  run<T>(step: () => Promise<T>): Promise<T>;
  busy(): boolean;
  settled(): Promise<void> | null;
  movedAt(): number | null;
}

export function createLiveTrades(now: () => number = Date.now): LiveTrades {
  let live = 0;
  let moved: number | null = null;
  let current: Promise<void> | null = null;
  let free: (() => void) | null = null;
  const done = () => {
    live -= 1;
    if (live > 0) {
      moved = now();
      return;
    }
    const f = free;
    live = 0;
    moved = null;
    current = null;
    free = null;
    f?.();
  };
  return {
    run<T>(step: () => Promise<T>): Promise<T> {
      if (live === 0) {
        current = new Promise<void>((r) => (free = r));
        moved = now();
      }
      live += 1;
      let p: Promise<T>;
      try {
        p = step();
      } catch (e) {
        p = Promise.reject(e);
      }
      return p.then(
        (v) => (done(), v),
        (e: unknown) => {
          done();
          throw e;
        },
      );
    },
    busy: () => live > 0,
    settled: () => current,
    movedAt: () => moved,
  };
}

/**
 * THE WORKER'S TICK CLOCK: regular ticks on their cadence, and a command tick
 * between two of them that moves neither.
 *
 * Lifted out of index.ts's run loop so the one property that matters can be
 * run by a test rather than trusted: a command tick takes the next regular
 * tick off the clock while it runs and puts it back for the moment it was
 * ALREADY due. Sooner would be an extra strategy tick — an extra basket buy —
 * for every order an owner places; later, or dropped, and the worker's own
 * cadence (the Trencher's exits run off it) slides every time somebody trades.
 *
 * A TICK THAT FAILS STILL ARMS THE NEXT ONE. The worst failure a loop like this
 * has is to stop: a rejected regular tick goes back on the clock after
 * `fallbackMs`, and a rejected command tick still hands the regular tick back.
 * index.ts catches its own failures first; this is the floor under that.
 *
 * A REGULAR TICK NEVER STARTS UNDER A LIVE ORDER. An owner's order debits the
 * account on chain some seconds before its trade row is written, and the flow
 * reconciler reads any cash change no row explains as money the owner moved:
 * "withdrawn X USDG (no trade explains this)", the high-water mark moved with
 * it, and a performance fee possible on the owner's own principal in the same
 * tick — never reversed. So a regular tick that comes due while a command is
 * still in flight (`inFlight` returns its settle) holds the clock and waits
 * for it, then reads a book the order has finished changing. It holds the
 * clock while it waits, so no command tick starts in the gap either. This is
 * not only the command tick's order: a regular tick drains beside its
 * strategy, and that order can still be waiting on a receipt when the next
 * regular tick comes due.
 *
 * AND A HELD TICK SAYS IT IS ALIVE (`onHold`). tick() writes the heartbeat as
 * its first statement, so a regular tick waiting here has not beaten, and the
 * orchestrator's watchdog kills a child whose beat has gone stale — 180 s at
 * the fastest tick, while one order can wait three receipt reads of two
 * minutes each. The process is waiting on purpose, so the hook runs once each
 * time the tick defers. createCommandClock wires it to the heartbeat and keeps
 * beating for as long as the wait is a real one.
 */
export interface TickClock {
  /** Put the first regular tick on the clock, `delayMs` from now. */
  start(delayMs: number): void;
  /** What commandTickReady needs from the clock. */
  state(): { ticked: boolean; tickRunning: boolean; regularDueInMs: number | null };
  /** Run one command tick between regular ones. False — and nothing run — if a tick is running or none is armed. */
  wakeCommand(): boolean;
  /** Run one research-only nomination tick, preserving the regular cadence and trade serialization. */
  wakeNomination(): boolean;
}

export function createTickClock(deps: {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** The wait after a regular tick that rejected instead of saying how long. */
  fallbackMs: number;
  /** The settle of a command or trade still in flight, or null when none is (OrderInFlight.settled). */
  inFlight: () => Promise<unknown> | null;
  /** A regular tick came due and is waiting on something in flight. Once per deferral. */
  onHold: () => void;
  /** One regular tick, and everything after it; resolves to the wait before the next one. */
  regular: () => Promise<number>;
  /** One command tick. */
  command: () => Promise<void>;
  /** Fresh book/policy reads and Brain review only: no financial ratchets or execution producers. */
  nomination?: () => Promise<void>;
}): TickClock {
  let running = false;
  let ticked = false;
  let timer: unknown = null;
  let dueAt = 0;
  let nominationWanted = false;

  const arm = (ms: number) => {
    const wait = Number.isFinite(ms) ? Math.max(0, ms) : deps.fallbackMs;
    dueAt = deps.now() + wait;
    timer = deps.setTimer(runRegular, wait);
  };

  // Started at once when nothing is in flight — the common case stays
  // synchronous — and otherwise once the command lands, asking again then.
  const startRegular = (): Promise<number> => {
    let waiting: Promise<unknown> | null;
    try {
      waiting = deps.inFlight();
    } catch {
      waiting = null;
    }
    if (waiting) {
      try {
        deps.onHold();
      } catch {
        // Saying it is alive must never be the reason the clock stops.
      }
      return waiting.then(startRegular, startRegular);
    }
    try {
      // Evidence received while this tick waited for a trade is read by this
      // very tick; it does not also owe a second one after that read.
      nominationWanted = false;
      return deps.regular();
    } catch {
      return Promise.resolve(deps.fallbackMs);
    }
  };

  const runRegular = () => {
    timer = null;
    running = true;
    void startRegular()
      .catch(() => deps.fallbackMs)
      .then((next) => {
        running = false;
        ticked = true;
        arm(next);
        if (nominationWanted) wakeNomination();
      });
  };

  const startNomination = (): Promise<void> => {
    let waiting: Promise<unknown> | null;
    try { waiting = deps.inFlight(); } catch { waiting = null; }
    if (waiting) {
      try { deps.onHold(); } catch { /* The heartbeat cannot stop the clock. */ }
      return waiting.then(startNomination, startNomination);
    }
    nominationWanted = false;
    try { return deps.nomination!(); } catch { return Promise.resolve(); }
  };

  const wakeNomination = (): boolean => {
    // The first regular tick owns boot staggering, initial arming and the
    // first coherent book. A group cannot bring that initialization forward.
    if (!deps.nomination || !ticked) return false;
    if (running) { nominationWanted = true; return true; }
    if (timer === null) return false;
    // A regular tick already due makes the same fresh reads. Prefer it to
    // an additional research tick and keep its accounting cadence intact.
    if (dueAt <= deps.now()) return true;
    const due = dueAt;
    deps.clearTimer(timer);
    timer = null;
    running = true;
    void startNomination().catch(() => {}).then(() => {
      running = false;
      arm(due - deps.now());
      if (nominationWanted) wakeNomination();
    });
    return true;
  };

  return {
    start(delayMs) {
      if (timer !== null || running) return;
      arm(delayMs);
    },
    state() {
      return { ticked, tickRunning: running, regularDueInMs: timer === null ? null : dueAt - deps.now() };
    },
    wakeNomination,
    wakeCommand() {
      if (timer === null || running) return false;
      deps.clearTimer(timer);
      timer = null;
      const due = dueAt;
      running = true;
      let run: Promise<void>;
      try {
        run = deps.command();
      } catch {
        run = Promise.resolve();
      }
      void run
        .catch(() => {})
        .then(() => {
          running = false;
          arm(due - deps.now());
          if (nominationWanted) wakeNomination();
        });
      return true;
    },
  };
}

/**
 * THE CLOCK, THE WATCHER AND THE ONE-AT-A-TIME SLOT, WIRED TOGETHER ONCE.
 *
 * The three only keep their promises together: the clock holds a regular tick
 * while the slot has a command in flight, and the watcher wakes a command tick
 * only when the clock is idle, the slot is free and the regular tick is not
 * about to run anyway. That wiring used to be three lambdas in main(), where
 * passing the clock something other than the slot's own settle — or nothing —
 * typechecked, passed every test, and let a regular tick read the book while
 * an order was between inclusion and its row. It lives here now, where the
 * tests that hold those promises run exactly this.
 *
 * `orders` is the slot runQueuedCommand drains under, and `trades` counts
 * every trade on the intent chain; both are passed in rather than made here
 * because main() declares the drain and the chain long before it builds the
 * clock. Both hold the clock: a trade typed in Telegram is as live as an order.
 *
 * WHILE SOMETHING IS IN FLIGHT, THE CLOCK KEEPS THE HEARTBEAT. The watcher's
 * poll runs every two seconds whatever the ticks are doing, so it is where the
 * process says it is alive while it waits on a trade it sent: at most every
 * ALIVE_BEAT_EVERY_MS, and once each time a regular tick defers. Nothing else
 * writes the file between ticks, and a command tick that holds the clock for
 * its order's three receipt reads — or a regular tick waiting behind it — used
 * to leave it stale past the watchdog, which SIGKILLed the child between the
 * send and the row.
 *
 * BOUNDED, so a wedged process is still reaped. It beats only while the work in
 * flight has moved within ORDER_IN_FLIGHT_MS — an order started, or a trade
 * settled. That figure bounds an order's own run once the queue reaches it, so
 * past it nothing legitimate is still going, the beat stops, and the watchdog
 * judges the child as it always did. An idle worker gets no beat from here:
 * between ticks that is tick()'s job, and a stall there must still show.
 *
 * THE CLOCK WRITES THE FILE ITSELF. It used to call whatever `beat` main()
 * handed it, so `beat: () => {}` in main() typechecked, passed every test, and
 * put the hosted child back to being SIGKILLed mid-order on the 15-second
 * preset. main() now hands it the file's path (`heartbeat`, required) and the
 * two facts a beat states, and writeHeartbeat below is the one writer — tick()'s
 * own beat goes through it too, so the two cannot drift into different shapes.
 */
export interface CommandClock {
  /** Put the first regular tick on the clock, `delayMs` from now. */
  start(delayMs: number): void;
  /** One look at the queue; true when it woke a command tick. */
  poll(): boolean;
  /** New verified group evidence may request a serialized research-only tick. */
  wakeNomination(): boolean;
  /** The clock's own state, for logs and tests. */
  state(): { ticked: boolean; tickRunning: boolean; regularDueInMs: number | null };
}

export function createCommandClock(deps: {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  fallbackMs: number;
  /** The one-at-a-time slot every drain runs under. */
  orders: OrderInFlight;
  /** Every trade on the intent chain (processIntent, processIntentReporting). */
  trades: LiveTrades;
  /** What is queued right now — a listing (command-files.ts `queuedCommandIds`). */
  pending: () => readonly string[];
  regular: () => Promise<number>;
  command: () => Promise<void>;
  nomination?: () => Promise<void>;
  /**
   * The heartbeat file the orchestrator's watchdog reads, and what a beat from
   * the clock says in it: the mode heartbeat() would publish and who pays gas.
   * No block — this is a claim about the process being alive, not about the
   * chain. Always the real writer: a test reads the file it wrote.
   */
  heartbeat: { file: string; mode: () => string; sponsorGas: () => boolean };
}): CommandClock {
  const live = () => deps.orders.busy() || deps.trades.busy();
  let beatAt = -Infinity;
  const beat = () => {
    beatAt = deps.now();
    try {
      const hb = deps.heartbeat;
      writeHeartbeat(hb.file, { mode: hb.mode(), sponsorGas: hb.sponsorGas() }, beatAt);
    } catch {
      // A beat that failed to write is the watchdog's to judge, not a reason to stop the clock.
    }
  };
  const clock = createTickClock({
    now: deps.now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    fallbackMs: deps.fallbackMs,
    inFlight: () => deps.orders.settled() ?? deps.trades.settled(),
    onHold: beat,
    regular: deps.regular,
    command: deps.command,
    nomination: deps.nomination,
  });
  const watcher = createCommandWake({
    pending: deps.pending,
    ready: () => commandTickReady({ ...clock.state(), commandInFlight: live() }),
    wake: () => clock.wakeCommand(),
  });
  const alive = () => {
    const now = deps.now();
    // Null on both when nothing is in flight, so an idle worker never gets here.
    const moved = Math.max(deps.orders.since() ?? -Infinity, deps.trades.movedAt() ?? -Infinity);
    if (now - moved >= ORDER_IN_FLIGHT_MS) return;
    if (now - beatAt < ALIVE_BEAT_EVERY_MS) return;
    beat();
  };
  return {
    start: (delayMs) => clock.start(delayMs),
    poll: () => {
      alive();
      return watcher.poll();
    },
    state: () => clock.state(),
    wakeNomination: () => clock.wakeNomination(),
  };
}
