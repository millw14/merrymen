/**
 * AN ORDER THAT LANDS BETWEEN TICKS WAKES ONE TICK — ONCE — AND NEVER TWO.
 *
 * Pickup was the tick: the orchestrator ferried on its reconcile pass and the
 * child drained at most one command per tick, on a hosted 240-second cadence.
 * An owner who pressed Buy waited up to four and a half minutes to hear
 * anything. The watcher closes that gap, and these tests hold the three ways a
 * watcher goes wrong on a money path:
 *
 *   - it wakes while something is already running (two ticks, two orders);
 *   - it wakes for the same file forever (a queued order the tick cannot drain
 *     — an unarmed worker — would become a tick every two seconds);
 *   - it spends its one wake while it could not act, and then never wakes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  ORDER_IN_FLIGHT_MS,
  queuedCommandIds,
  runTickCommand,
  writeCommand,
  type CommandOutcome,
  type FileCommand,
} from "./command-files";
import {
  ALIVE_BEAT_EVERY_MS,
  COMMAND_WAKE_EVERY_MS,
  COMMAND_WAKE_MIN_LEAD_MS,
  commandTickReady,
  createCommandClock,
  createCommandWake,
  createLiveTrades,
  createOrderInFlight,
  createTickClock,
  drainOnTick,
  drainOnUnreadTick,
  tickPlan,
  tickRatchets,
  writeHeartbeat,
  type TickKind,
} from "./command-wake";
import { heartbeatAtIn, staleThresholdSec } from "./orchestrator";

/** A watcher over a queue the test controls, recording every wake. */
function harness(ready = true) {
  const state = { queue: [] as string[], ready, wakes: 0, wakeTakes: true };
  const w = createCommandWake({
    pending: () => state.queue,
    ready: () => state.ready,
    wake: () => {
      if (!state.wakeTakes) return false;
      state.wakes += 1;
      return true;
    },
  });
  return { state, poll: () => w.poll() };
}

const homes: string[] = [];
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const newHome = () => {
  const h = mkdtempSync(path.join(tmpdir(), "merry-wake-"));
  homes.push(h);
  return h;
};
/** Let every pending promise chain run, as the event loop would between two timers. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

describe("the watcher wakes once per order", () => {
  it("A NEW ORDER WAKES A TICK", () => {
    const h = harness();
    h.state.queue = ["o1"];
    assert.equal(h.poll(), true);
    assert.equal(h.state.wakes, 1);
  });

  it("AND AN ORDER STILL SITTING THERE DOES NOT WAKE ANOTHER — a tick that could not drain it is not retried every two seconds", () => {
    // The unarmed worker, the tick that returned before its drain: the file
    // stays, and without this the watcher would hammer the chain for as long as
    // the order's window stays open. It waits for the regular tick instead.
    const h = harness();
    h.state.queue = ["o1"];
    h.poll();
    for (let i = 0; i < 50; i += 1) h.poll();
    assert.equal(h.state.wakes, 1);
  });

  it("a SECOND order wakes again, even while the first is still listed", () => {
    const h = harness();
    h.state.queue = ["o1"];
    h.poll();
    h.state.queue = ["o1", "o2"];
    assert.equal(h.poll(), true);
    assert.equal(h.state.wakes, 2);
  });

  it("an empty queue never wakes anything", () => {
    const h = harness();
    for (let i = 0; i < 10; i += 1) assert.equal(h.poll(), false);
    assert.equal(h.state.wakes, 0);
  });

  it("an id that left the queue is forgotten, so memory does not grow for the life of the process", () => {
    // And an id written again later — a retried file under the same name — is
    // a new arrival, which is what it is.
    const h = harness();
    h.state.queue = ["o1"];
    h.poll();
    h.state.queue = [];
    h.poll();
    h.state.queue = ["o1"];
    assert.equal(h.poll(), true);
    assert.equal(h.state.wakes, 2);
  });
});

describe("the watcher waits rather than spending its wake", () => {
  it("NOT READY IS NOT A WAKE, and the order keeps its claim on the next one", () => {
    // If a busy tick consumed the order's one wake, a tick that then finished
    // without reaching the drain would leave it to the regular cadence — the
    // four-minute wait this exists to remove.
    const h = harness(false);
    h.state.queue = ["o1"];
    for (let i = 0; i < 5; i += 1) assert.equal(h.poll(), false);
    assert.equal(h.state.wakes, 0);
    h.state.ready = true;
    assert.equal(h.poll(), true);
    assert.equal(h.state.wakes, 1);
  });

  it("A WAKE THE CLOCK TURNED DOWN IS NOT SPENT — the order still has its wake coming", () => {
    // ready() and the clock are asked in the same poll and agree today; if
    // they ever disagree, the order must not lose its one wake to the gap.
    const h = harness();
    h.state.queue = ["o1"];
    h.state.wakeTakes = false;
    assert.equal(h.poll(), false);
    h.state.wakeTakes = true;
    assert.equal(h.poll(), true);
    assert.equal(h.state.wakes, 1);
  });
});

/**
 * TWO ORDERS IN ONE LOOK ARE TWO WAKES.
 *
 * A command tick drains ONE live command. The watcher used to mark every new
 * id as woken and wake once, so when two arrived in the same two-second look
 * — a probe beside an order, or two rows the ferry delivered in one pass —
 * the second was spent on a tick that could never reach it, and waited out
 * the regular cadence (four minutes hosted) with the worker idle.
 */
describe("every order is owed its own wake", () => {
  it("TWO IDS IN ONE POLL WAKE TWICE — one at a time, never together", () => {
    const h = harness();
    h.state.queue = ["o1", "o2"];
    assert.equal(h.poll(), true);
    assert.equal(h.state.wakes, 1, "one command tick at a time");
    assert.equal(h.poll(), true, "and the second order gets its own");
    assert.equal(h.state.wakes, 2);
    for (let i = 0; i < 20; i += 1) h.poll();
    assert.equal(h.state.wakes, 2, "and still once per order, never a retry loop");
  });

  it("an order a regular tick drained while the watcher waited is not woken for", () => {
    // Owed wakes are bounded by what is still listed: a tick that already
    // took an order leaves nothing for a command tick to do.
    const h = harness(false);
    h.state.queue = ["o1", "o2"];
    h.poll();
    h.state.queue = ["o2"]; // the running regular tick drained o1
    h.state.ready = true;
    assert.equal(h.poll(), true);
    assert.equal(h.poll(), false);
    assert.equal(h.state.wakes, 1);
  });

  it("THE SECOND ORDER IS DRAINED BY A SECOND COMMAND TICK once the first one ends — real files, real drain", async () => {
    // The reviewer's probe: a probe and an order written before one look.
    const home = newHome();
    let now = 1_000_000;
    const inFlight = createOrderInFlight();
    const ran: string[] = [];
    let running = false;
    let wakes = 0;
    const drain = () =>
      inFlight.run(() =>
        runTickCommand(home, {
          now: () => now,
          run: async (cmd) => (ran.push(cmd.id), { ok: true, line: "ok" }),
          told: async () => {},
        }),
      );
    const w = createCommandWake({
      pending: () => queuedCommandIds(home),
      ready: () =>
        commandTickReady({ ticked: true, tickRunning: running, commandInFlight: inFlight.busy(), regularDueInMs: 120_000 }),
      wake: () => {
        wakes += 1;
        running = true;
        void drainOnTick(tickPlan("command"), drain).then(() => {
          running = false;
        });
        return true;
      },
    });
    writeCommand(home, { id: "probe1", kind: "selftest", at: now });
    writeCommand(home, { id: "order1", kind: "trade", at: now + 1, args: { side: "buy", symbol: "TSLA", usdgAmount: 5 }, expiresAt: now + 495_000 });
    w.poll();
    await settle();
    for (let i = 0; i < 5; i += 1) {
      now += 2_000;
      w.poll();
      await settle();
    }
    assert.deepEqual(ran, ["probe1", "order1"], "the order is picked up in seconds, not at the next regular tick");
    assert.equal(wakes, 2);
    assert.deepEqual(queuedCommandIds(home), []);
  });
});

describe("when a command tick may start", () => {
  const base = { ticked: true, tickRunning: false, commandInFlight: false, regularDueInMs: 120_000 };

  it("BETWEEN TICKS, with nothing in flight and the next tick well away, it may", () => {
    assert.equal(commandTickReady(base), true);
  });

  it("NEVER BESIDE A RUNNING TICK — two ticks at once is two drains", () => {
    assert.equal(commandTickReady({ ...base, tickRunning: true }), false);
  });

  it("NEVER BESIDE AN ORDER IN FLIGHT — the one-at-a-time rule, before it is even asked", () => {
    assert.equal(commandTickReady({ ...base, commandInFlight: true }), false);
  });

  it("never before the first tick — the staggered boot is the fleet's, and nothing is armed yet", () => {
    assert.equal(commandTickReady({ ...base, ticked: false }), false);
  });

  it("not when the regular tick is about to run anyway — it drains the order itself", () => {
    assert.equal(commandTickReady({ ...base, regularDueInMs: COMMAND_WAKE_MIN_LEAD_MS }), false);
    assert.equal(commandTickReady({ ...base, regularDueInMs: COMMAND_WAKE_MIN_LEAD_MS + 1 }), true);
  });

  it("and not when no regular tick is on the clock at all — there is nothing to hand the cadence back to", () => {
    assert.equal(commandTickReady({ ...base, regularDueInMs: null }), false);
  });
});

/**
 * THE CADENCE A COMMAND TICK MUST NOT MOVE.
 *
 * The regular tick is what the strategy's per-tick buy, the Trencher's exits
 * and every review deadline are timed off. A command tick runs BETWEEN two of
 * them: it takes the next regular tick off the clock while it runs and puts it
 * back for the moment it was already due — never sooner, which would be an
 * extra basket buy for every order, and never dropped, which would stop the
 * worker ticking at all.
 */
describe("the tick clock", () => {
  /** Timers the test fires by hand, and a clock it moves. */
  function fake() {
    let now = 1_000_000;
    let seq = 0;
    const timers = new Map<number, { fn: () => void; at: number }>();
    return {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => {
        seq += 1;
        timers.set(seq, { fn, at: now + ms });
        return seq;
      },
      clearTimer: (h: unknown) => {
        timers.delete(h as number);
      },
      advance: (ms: number) => {
        now += ms;
      },
      /** The one pending timer, as its due time. */
      pending: () => [...timers.values()].map((t) => t.at),
      /** Fire the due timer, as the event loop would. */
      fire: () => {
        const [id, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
        timers.delete(id);
        if (now < t.at) now = t.at;
        t.fn();
      },
    };
  }
  /** A clock whose ticks the test finishes by hand. */
  function clock(over: { regularDelay?: number } = {}) {
    const f = fake();
    const log: string[] = [];
    const orders = createOrderInFlight(f.now);
    let finishRegular: (() => void) | null = null;
    let failRegular: (() => void) | null = null;
    let finishCommand: (() => void) | null = null;
    let failCommand: (() => void) | null = null;
    let finishNomination: (() => void) | null = null;
    const c = createTickClock({
      now: f.now,
      setTimer: f.setTimer,
      clearTimer: f.clearTimer,
      fallbackMs: 240_000,
      inFlight: () => orders.settled(),
      onHold: () => void log.push("hold"),
      regular: () =>
        new Promise<number>((resolve, reject) => {
          log.push("regular");
          finishRegular = () => resolve(over.regularDelay ?? 240_000);
          failRegular = () => reject(new Error("boom"));
        }),
      command: () =>
        new Promise<void>((resolve, reject) => {
          log.push("command");
          finishCommand = resolve;
          failCommand = () => reject(new Error("boom"));
        }),
      nomination: () => new Promise<void>(resolve => {
        log.push("nomination");
        finishNomination = resolve;
      }),
    });
    /** An owner order in flight, as runQueuedCommand holds one; the returned function lands it. */
    const startOrder = () => {
      let land!: () => void;
      void orders.run(() => new Promise<void>((r) => (land = r)));
      return async () => (land(), await settle());
    };
    return {
      f,
      c,
      log,
      orders,
      startOrder,
      finishRegular: async () => (finishRegular!(), await settle()),
      failRegular: async () => (failRegular!(), await settle()),
      finishCommand: async () => (finishCommand!(), await settle()),
      failCommand: async () => (failCommand!(), await settle()),
      finishNomination: async () => (finishNomination!(), await settle()),
    };
  }

  it("A REGULAR TICK RUNS ON ITS TIMER AND PUTS THE NEXT ONE ON THE CLOCK", async () => {
    const k = clock();
    k.c.start(30_000);
    assert.deepEqual(k.f.pending(), [1_030_000]);
    assert.equal(k.c.state().ticked, false, "nothing has ticked before the staggered first tick");
    k.f.fire();
    assert.deepEqual(k.log, ["regular"]);
    assert.equal(k.c.state().tickRunning, true);
    await k.finishRegular();
    assert.deepEqual(k.f.pending(), [1_030_000 + 240_000]);
    assert.deepEqual(k.c.state(), { ticked: true, tickRunning: false, regularDueInMs: 240_000 });
  });

  it("A COMMAND TICK HANDS THE REGULAR TICK BACK FOR THE MOMENT IT WAS ALREADY DUE", async () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.finishRegular(); // next regular due at +240s
    const due = k.f.pending()[0]!;
    k.f.advance(60_000); // an order lands a minute in
    assert.equal(k.c.wakeCommand(), true);
    assert.deepEqual(k.f.pending(), [], "the regular tick is off the clock while the command tick runs");
    assert.equal(k.c.state().regularDueInMs, null);
    k.f.advance(20_000); // the command tick's reads take twenty seconds
    await k.finishCommand();
    assert.deepEqual(k.f.pending(), [due], "not shortened, not pushed back — the same moment");
    assert.deepEqual(k.log, ["regular", "command"], "and no extra regular tick ran");
  });

  it("A COMMAND TICK THAT OUTLASTS THE DUE TIME HANDS BACK AT ONCE, never with a negative wait", async () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.finishRegular();
    k.f.advance(230_000);
    k.c.wakeCommand();
    k.f.advance(30_000);
    await k.finishCommand();
    assert.deepEqual(k.f.pending(), [k.f.now()]);
  });

  it("NEVER A COMMAND TICK BESIDE A RUNNING TICK — regular or command", async () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    assert.equal(k.c.wakeCommand(), false, "a regular tick is running");
    await k.finishRegular();
    assert.equal(k.c.wakeCommand(), true);
    assert.equal(k.c.wakeCommand(), false, "a command tick is running");
    assert.deepEqual(k.log, ["regular", "command"]);
  });

  it("a command tick before the first timer is armed does nothing", () => {
    const k = clock();
    assert.equal(k.c.wakeCommand(), false);
    assert.deepEqual(k.log, []);
  });

  it("verified nominated evidence gets a research tick while the regular cadence stays at its original moment", async () => {
    const k = clock();
    assert.equal(k.c.wakeNomination(), false, "nothing is armed before startup");
    k.c.start(0);
    k.f.fire();
    await k.finishRegular();
    const due = k.f.pending()[0]!;
    k.f.advance(10_000);
    assert.equal(k.c.wakeNomination(), true);
    assert.deepEqual(k.log, ["regular", "nomination"]);
    assert.deepEqual(k.f.pending(), []);
    k.f.advance(5_000);
    await k.finishNomination();
    assert.deepEqual(k.f.pending(), [due], "research neither observes an extra peak nor postpones the normal one");
  });

  it("a group nomination cannot bypass the first regular tick's stagger or arming", async () => {
    const k = clock();
    k.c.start(30_000);
    assert.equal(k.c.wakeNomination(), false);
    assert.deepEqual(k.log, []);
    assert.deepEqual(k.f.pending(), [1_030_000]);
    k.f.fire();
    assert.equal(k.c.wakeNomination(), false, "initial book and grant reads are still running");
    assert.deepEqual(k.log, ["regular"]);
    await k.finishRegular();
    assert.equal(k.c.wakeNomination(), true, "research can run once the first coherent book exists");
    await k.finishNomination();
  });

  it("evidence arriving during an active regular tick coalesces into one later research tick", async () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.finishRegular();
    k.f.fire();
    for (let i = 0; i < 5; i++) k.c.wakeNomination();
    assert.deepEqual(k.log, ["regular", "regular"], "no research tick reads a changing book");
    assert.deepEqual(k.f.pending(), []);
    await k.finishRegular();
    assert.deepEqual(k.log, ["regular", "regular", "nomination"]);
    await k.finishNomination();
    assert.deepEqual(k.f.pending(), [k.f.now() + 240_000], "ordinary cadence resumes");
  });

  it("a nomination wake still waits for a live trade and consumes pending wakes in that one fresh read", async () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.finishRegular();
    const due = k.f.pending()[0]!;
    const land = k.startOrder();
    k.c.wakeNomination();
    await settle();
    k.c.wakeNomination();
    assert.deepEqual(k.log, ["regular", "hold"], "no portfolio read before the trade settles");
    assert.equal(k.c.wakeCommand(), false);
    await land();
    assert.deepEqual(k.log, ["regular", "hold", "nomination"]);
    await k.finishNomination();
    assert.deepEqual(k.f.pending(), [due], "the held read consumes the new nominations without moving the regular clock");
  });

  it("a nomination wake during a command tick waits for it and runs one research tick afterward", async () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.finishRegular();
    const due = k.f.pending()[0]!;
    k.c.wakeCommand();
    k.c.wakeNomination();
    k.c.wakeNomination();
    assert.deepEqual(k.log, ["regular", "command"]);
    assert.deepEqual(k.f.pending(), []);
    await k.finishCommand();
    assert.deepEqual(k.log, ["regular", "command", "nomination"]);
    await k.finishNomination();
    assert.deepEqual(k.f.pending(), [due]);
  });

  it("a nomination read that outlasts the regular due time hands the overdue regular tick back immediately", async () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.finishRegular();
    k.f.advance(230_000);
    k.c.wakeNomination();
    k.c.wakeNomination();
    k.f.advance(20_000);
    await k.finishNomination();
    assert.deepEqual(k.f.pending(), [k.f.now()], "regular sampling has priority over another research tick");
    k.f.fire();
    await k.finishRegular();
    assert.deepEqual(k.log, ["regular", "nomination", "regular"]);
  });

  it("A TICK THAT FAILS STILL PUTS THE NEXT ONE ON THE CLOCK — a worker that stops ticking is the worst failure there is", async () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.failRegular();
    assert.deepEqual(k.f.pending(), [k.f.now() + 240_000], "the fallback cadence");
    const due = k.f.pending()[0]!;
    k.f.advance(10_000);
    k.c.wakeCommand();
    await k.failCommand();
    assert.deepEqual(k.f.pending(), [due], "and a failed command tick still hands the regular one back");
    assert.equal(k.c.state().tickRunning, false);
  });

  it("A REGULAR TICK DUE WHILE AN ORDER IS IN FLIGHT WAITS FOR IT TO LAND — it never reads the book under a live trade", async () => {
    // The order's own cash move happens between inclusion and its row. A book
    // read in that gap books it as money that left with "no trade explains
    // this", moves the high-water mark with it, and can charge a fee on it.
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.finishRegular();
    const land = k.startOrder(); // drained by that tick, still waiting on its receipt
    k.f.fire(); // the next regular tick comes due
    await settle();
    assert.deepEqual(k.log, ["regular", "hold"], "not started while the order is mid-trade");
    assert.equal(k.c.state().tickRunning, true, "and it holds the clock, so no command tick starts either");
    assert.equal(k.c.wakeCommand(), false);
    await land();
    assert.deepEqual(k.log, ["regular", "hold", "regular"], "it runs the moment the order lands");
    await k.finishRegular();
    assert.equal(k.c.state().tickRunning, false);
    assert.equal(k.f.pending().length, 1, "and the cadence carries on");
  });

  it("with nothing in flight a regular tick starts on its timer, at once — and says nothing about holding", () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    assert.deepEqual(k.log, ["regular"]);
  });

  it("A HELD REGULAR TICK SAYS SO ONCE PER DEFERRAL — the process is alive and waiting on purpose", async () => {
    // tick() writes the heartbeat as its first statement, so a regular tick
    // held behind an order has not beaten; the hook is where it says it is
    // alive. Once per deferral, not once per poll: a second order in flight
    // when the first lands is a second deferral.
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.finishRegular();
    const landFirst = k.startOrder();
    // A second order takes the slot the moment the first frees it, before the
    // held tick can start: that is a second deferral, and it says so again.
    let landSecond: (() => Promise<void>) | null = null;
    void k.orders.settled()!.then(() => {
      landSecond = k.startOrder();
    });
    k.f.fire();
    await settle();
    assert.deepEqual(k.log, ["regular", "hold"]);
    for (let i = 0; i < 10; i += 1) await settle();
    assert.equal(k.log.filter((l) => l === "hold").length, 1, "one deferral, one hold — not one per turn of the loop");
    await landFirst();
    assert.deepEqual(k.log, ["regular", "hold", "hold"]);
    await landSecond!();
    assert.deepEqual(k.log, ["regular", "hold", "hold", "regular"]);
  });
});

/**
 * WHAT A COMMAND TICK IS, as one value tick() reads instead of a flag it
 * tests in four places.
 */
describe("the tick plan", () => {
  it("A COMMAND TICK READS AND DRAINS, AND DOES NOTHING ELSE", () => {
    const p = tickPlan("command");
    assert.equal(p.producers, false, "no strategy, class route or discovery — an order must not also buy the basket");
    assert.equal(p.brain, false, "an order arriving is not a reason to ask the Brain anything");
    assert.equal(p.awaitDrain, true, "and it does not end while its order is still mid-trade");
  });

  it("A COMMAND TICK MOVES NO RATCHET AND WRITES NO EQUITY ROW", () => {
    // Fee above the high-water mark follows the running maximum of sampled
    // equity, and that maximum only rises as samples are added — so an owner
    // order that added one could charge a fee on a transient peak the regular
    // cadence would never have seen, and move the breaker's reference point.
    assert.equal(tickPlan("command").ratchets, false);
  });

  it("a nomination tick admits research but no accounting sample or strategy execution", () => {
    assert.deepEqual(tickPlan("nomination"), { kind: "nomination", ratchets: false, brain: true, awaitDrain: false, producers: false });
  });

  it("a regular tick is the whole tick, and leaves its drain running beside the strategy", () => {
    assert.deepEqual(tickPlan("regular"), { kind: "regular", ratchets: true, brain: true, awaitDrain: false, producers: true });
  });
});

describe("the drain, as the plan runs it", () => {
  it("a nomination read never drains an owner order or starts execution producers", async () => {
    let drained = false;
    assert.equal(await drainOnTick(tickPlan("nomination"), async () => { drained = true; }), false);
    assert.equal(drained, false);
  });

  it("all actual early read-failure branches leave self-tests, resets and trades queued on nomination ticks", async () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const tick = source.slice(source.indexOf("  async function tick()"), source.indexOf("    if (!(await drainOnTick(plan"));
    const sites = [...tick.matchAll(/await drainOnUnreadTick\(plan, \(\) => [^\n]+\);/g)].map(match => match[0]);
    assert.equal(sites.length, 3, "market unread, book unread, and missing held price each use the guarded early drain");
    assert.equal(tick.split("\n").filter(line => line.includes("runQueuedCommand(")).length, sites.length, "no early command drain escapes the helper");
    for (const kind of ["nomination", "regular", "command"] as const) {
      const home = newHome();
      const now = 1_000_000;
      const executed: string[] = [];
      for (const [i, commandKind] of ["selftest", "paper-reset", "trade"].entries()) {
        writeCommand(home, { id: `early-${i}`, kind: commandKind, at: now + i, expiresAt: now + 60_000 });
      }
      const runQueuedCommand = async () => runTickCommand(home, {
        now: () => now,
        run: async cmd => { executed.push(cmd.kind); return { ok: true, line: "handled" }; },
        told: async () => {},
      });
      for (const site of sites) {
        // Execute the production drain site, with a real command-file queue;
        // the dispatcher is fake so no gas or account data can be changed.
        await new Function("drainOnUnreadTick", "plan", "active", "agentId", "marketUnread", "bookUnread", "runQueuedCommand", `return (async () => { ${site} })();`)(
          drainOnUnreadTick, tickPlan(kind), { agentId: "agent" }, "agent", {}, {}, runQueuedCommand,
        );
      }
      assert.deepEqual(executed, kind === "nomination" ? [] : ["selftest", "paper-reset", "trade"]);
      assert.equal(queuedCommandIds(home).length, kind === "nomination" ? 3 : 0);
    }
  });
  it("A COMMAND TICK WAITS FOR ITS ORDER, then stops", async () => {
    let landed = false;
    let land!: () => void;
    const drain = () => new Promise<void>((r) => (land = r)).then(() => void (landed = true));
    let returned: boolean | null = null;
    void drainOnTick(tickPlan("command"), drain).then((v) => (returned = v));
    await settle();
    assert.equal(returned, null, "still waiting on the order");
    land();
    await settle();
    assert.equal(landed, true);
    assert.equal(returned, false, "and the tick ends there — no producer runs");
  });

  it("a regular tick starts the drain and goes on to its producers without waiting", async () => {
    let started = false;
    const goOn = await drainOnTick(tickPlan("regular"), () => ((started = true), new Promise<void>(() => {})));
    assert.equal(started, true);
    assert.equal(goOn, true);
  });

  it("a drain that fails never takes the tick down, on either kind", async () => {
    assert.equal(await drainOnTick(tickPlan("command"), () => Promise.reject(new Error("boom"))), false);
    assert.equal(await drainOnTick(tickPlan("regular"), () => Promise.reject(new Error("boom"))), true);
    assert.equal(await drainOnTick(tickPlan("command"), () => { throw new Error("sync boom"); }), false);
  });
});

describe("one owner order in flight", () => {
  it("A SECOND ONE IS NOT STARTED BESIDE THE FIRST", async () => {
    const o = createOrderInFlight();
    let land!: () => void;
    let ran = 0;
    const first = o.run(() => ((ran += 1), new Promise<void>((r) => (land = r))));
    assert.equal(o.busy(), true);
    assert.equal(await o.run(async () => void (ran += 1)), false, "refused, not queued");
    assert.equal(ran, 1);
    land();
    assert.equal(await first, true);
    assert.equal(o.busy(), false);
    assert.equal(o.settled(), null, "nothing to wait for once it has landed");
  });

  it("settled() resolves when the order lands, and a failed order still frees the slot", async () => {
    const o = createOrderInFlight();
    let fail!: (e: Error) => void;
    const run = o.run(() => new Promise<void>((_, rej) => (fail = rej)));
    const waiting = o.settled();
    assert.ok(waiting);
    let settledAt = false;
    void waiting.then(() => (settledAt = true));
    fail(new Error("reverted"));
    await assert.rejects(run);
    await settle();
    assert.equal(settledAt, true);
    assert.equal(o.busy(), false);
  });
});

/**
 * THE WHOLE WIRING, as main() puts it together: the real clock, watcher,
 * readiness rule, plan, drain and command files, with the order's trade held
 * open by the test. The reviewer's probe, made a test.
 */
/**
 * A worker as main() wires it: the real clock, watcher, slot, live-trade count,
 * plan, drain and command files. The order's trade joins the intent chain the
 * way processIntentReporting does (`trades.run`), and every beat — the one
 * tick() writes first, and the ones the clock writes for it — goes to a real
 * heartbeat file in the worker's home through the real writer. `beats` is
 * every time that file's `at` moved, read the way the orchestrator's watchdog
 * reads it (heartbeatAtIn).
 */
function worker(opts: { tickMs?: number; strategyHolds?: number } = {}) {
  const tickMs = opts.tickMs ?? 240_000;
  /** How many regular ticks still send a strategy intent of their own and wait for it. */
  let strategyHolds = opts.strategyHolds ?? 0;
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const home = newHome();
  const orders = createOrderInFlight(() => now);
  const trades = createLiveTrades(() => now);
  const log: string[] = [];
  const beats: number[] = [];
  const heartbeatFile = path.join(home, "heartbeat.json");
  /** What the watchdog would read now; recorded whenever it moved. */
  const seen = () => {
    const at = heartbeatAtIn(home);
    if (at !== null && beats[beats.length - 1] !== at * 1000) beats.push(at * 1000);
  };
  /** Trades still out, each landed by the test: `label` is how land() finds one. */
  const landing: { label: string; fn: () => void }[] = [];
  /** A trade on the intent chain that stays out until the test lands it. */
  const held = (label: string) =>
    trades.run(
      () =>
        new Promise<void>((resolve) => {
          log.push(`${label} sent`);
          landing.push({
            label,
            fn: () => {
              log.push(`${label} recorded`);
              resolve();
            },
          });
        }),
    );
  const drain = () =>
    orders.run(() =>
      runTickCommand(home, {
        now: () => now,
        run: (cmd: FileCommand) =>
          trades.run(
            () =>
              new Promise<CommandOutcome>((resolve) => {
                log.push(`order ${cmd.id} sent`);
                landing.push({
                  label: `order ${cmd.id}`,
                  fn: () => {
                    log.push(`order ${cmd.id} recorded`);
                    resolve({ ok: true, line: "filled" });
                  },
                });
              }),
          ),
        told: async () => {},
      }),
    );
  const live = () => orders.busy() || trades.busy();
  const tick = async (kind: TickKind) => {
    // BEAT FIRST — tick()'s first statement, through the same writer (index.ts beatFile).
    writeHeartbeat(heartbeatFile, { mode: "live", sponsorGas: false }, now);
    const plan = tickPlan(kind);
    log.push(`${kind} reads the book${live() ? " WITH A TRADE IN FLIGHT" : ""}`);
    if (!(await drainOnTick(plan, drain))) return;
    log.push(`${kind} runs its producers`);
    // Its own strategy intent, awaited as tick() awaits every intent it sends.
    if (kind === "regular" && strategyHolds > 0) {
      strategyHolds -= 1;
      await held("strategy intent");
    }
  };
  // THE SAME FACTORY main() BUILDS ITS CLOCK WITH, so this runs its wiring.
  const clock = createCommandClock({
    now: () => now,
    setTimer: (fn, ms) => (timers.set(++seq, { fn, at: now + ms }), seq),
    clearTimer: (h) => void timers.delete(h as number),
    fallbackMs: tickMs,
    orders,
    trades,
    pending: () => queuedCommandIds(home),
    regular: async () => (await tick("regular"), tickMs),
    command: () => tick("command"),
    nomination: () => tick("nomination"),
    heartbeat: { file: heartbeatFile, mode: () => "live", sponsorGas: () => false },
  });
  const fireDue = async () => {
    const [id, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
    timers.delete(id);
    if (now < t.at) now = t.at;
    t.fn();
    await settle();
    seen();
  };
  return {
    home,
    log,
    beats,
    clock,
    watcher: clock,
    orders,
    trades,
    advance: (ms: number) => void (now += ms),
    now: () => now,
    pending: () => [...timers.values()].map((t) => t.at),
    fire: fireDue,
    /**
     * `ms` of the process's life as main() runs it: the watcher's poll every
     * COMMAND_WAKE_EVERY_MS, and any timer that comes due in between.
     */
    run: async (ms: number) => {
      const until = now + ms;
      while (now < until) {
        now = Math.min(until, now + COMMAND_WAKE_EVERY_MS);
        while ([...timers.values()].some((t) => t.at <= now)) await fireDue();
        clock.poll();
        await settle();
        seen();
      }
    },
    /** Land the oldest trade still out, or the oldest whose label starts with `label`. */
    land: async (label?: string) => {
      const i = label === undefined ? 0 : landing.findIndex((l) => l.label.startsWith(label));
      assert.ok(i >= 0 && landing[i], `nothing out labelled ${label}`);
      landing.splice(i, 1)[0]!.fn();
      await settle();
    },
    order: (id: string) =>
      writeCommand(home, { id, kind: "trade", at: now, args: { side: "buy", symbol: "TSLA", usdgAmount: 5 }, expiresAt: now + 495_000 }),
    /** A trade typed in Telegram: straight onto the intent chain, no command, no slot. */
    chat: (id: string) => void held(`chat ${id}`),
  };
}

/**
 * The longest the watchdog would have seen the file unchanged, over [from, to]:
 * measured from the last beat at or before `from`, so a silence that began
 * earlier is counted whole.
 */
function longestSilence(beats: readonly number[], from: number, to: number): number {
  const before = beats.filter((b) => b <= from);
  const start = before.length ? before[before.length - 1]! : from;
  const at = [start, ...beats.filter((b) => b > from && b <= to), to];
  let worst = 0;
  for (let i = 1; i < at.length; i += 1) worst = Math.max(worst, at[i]! - at[i - 1]!);
  return worst;
}

describe("a command tick's order and the regular tick never overlap", () => {

  it("a nomination research wake cannot read mid-trade or drain a queued owner order", async () => {
    const w = worker();
    w.clock.start(0);
    await w.fire();
    const due = w.pending()[0]!;
    w.advance(10_000);
    w.order("queued-owner-order");
    w.chat("in-flight");
    w.clock.wakeNomination();
    await settle();
    assert.equal(w.log.includes("nomination reads the book"), false);
    assert.equal(w.log.some(line => line.includes("WITH A TRADE IN FLIGHT")), false);
    await w.land("chat");
    assert.ok(w.log.includes("nomination reads the book"));
    assert.equal(w.log.includes("nomination runs its producers"), false);
    assert.equal(w.log.includes("order queued-owner-order sent"), false);
    assert.deepEqual(queuedCommandIds(w.home), ["queued-owner-order"], "the nomination cannot pick up or replay an order");
    assert.deepEqual(w.pending(), [due], "the usual accounting observation remains scheduled");
  });

  it("A COMMAND TICK DOES NOT END WHILE ITS ORDER IS MID-TRADE, and the regular tick waits behind it", async () => {
    const w = worker();
    w.clock.start(0);
    await w.fire(); // the first regular tick; the next is due in 240 s
    const due = w.pending()[0]!;
    w.advance(60_000);
    w.order("order1");
    w.watcher.poll();
    await settle();
    assert.ok(w.log.includes("order order1 sent"));
    assert.equal(w.clock.state().tickRunning, true, "the command tick is still running while its order is in flight");
    w.advance(200_000); // the receipt is slow; the regular tick's moment passes
    assert.deepEqual(w.pending(), [], "no regular tick is on the clock while the order is mid-trade");
    await w.land();
    assert.deepEqual(w.pending(), [w.now()], "handed back the moment the order lands — it was already due");
    assert.ok(w.now() > due);
    await w.fire();
    assert.deepEqual(w.log, [
      "regular reads the book",
      "regular runs its producers",
      "command reads the book",
      "order order1 sent",
      "order order1 recorded",
      "regular reads the book",
      "regular runs its producers",
    ]);
  });

  it("TWO ORDERS IN ONE LOOK: the second never starts beside the first, and gets its own command tick once the first lands", async () => {
    const w = worker();
    w.clock.start(0);
    await w.fire();
    w.advance(10_000);
    w.order("order1");
    w.order("order2");
    w.clock.poll();
    await settle();
    assert.ok(w.log.includes("order order1 sent"));
    for (let i = 0; i < 3; i += 1) {
      w.advance(2_000);
      w.clock.poll();
      await settle();
    }
    assert.ok(!w.log.includes("order order2 sent"), "never two in flight");
    await w.land();
    w.advance(2_000);
    w.clock.poll();
    await settle();
    assert.ok(w.log.includes("order order2 sent"), "picked up in seconds, not at the next regular tick");
    await w.land();
    assert.deepEqual(queuedCommandIds(w.home), []);
    assert.equal(w.log.filter((l) => l === "command reads the book").length, 2);
    assert.ok(!w.log.some((l) => l.includes("IN FLIGHT")), w.log.join("\n"));
  });

  it("NO COMMAND TICK WHILE AN ORDER A REGULAR TICK DRAINED IS STILL IN FLIGHT — it would read the book mid-trade too", async () => {
    // The clock is idle and armed, so only the slot knows an order is out.
    const w = worker();
    w.order("order1");
    w.clock.start(0);
    await w.fire(); // drains order1 beside the strategy, ends, and arms the next tick
    w.advance(10_000);
    w.order("order2");
    for (let i = 0; i < 3; i += 1) {
      w.advance(2_000);
      w.clock.poll();
      await settle();
    }
    assert.ok(!w.log.includes("command reads the book"), w.log.join("\n"));
    await w.land(); // order1 lands
    w.clock.poll();
    await settle();
    assert.ok(w.log.includes("order order2 sent"), "and the waiting order gets its tick the moment the first lands");
    assert.ok(!w.log.some((l) => l.includes("IN FLIGHT")), w.log.join("\n"));
  });

  it("AN ORDER THAT LANDS WITHIN FIVE SECONDS OF THE REGULAR TICK IS LEFT TO IT — one read of the chain, not two", async () => {
    const w = worker();
    w.clock.start(0);
    await w.fire();
    w.advance(240_000 - COMMAND_WAKE_MIN_LEAD_MS);
    w.order("order1");
    w.clock.poll();
    await settle();
    assert.ok(!w.log.includes("command reads the book"));
    await w.fire();
    assert.deepEqual(w.log.slice(-3), ["regular reads the book", "order order1 sent", "regular runs its producers"]);
  });

  it("AN ORDER A REGULAR TICK DRAINED IS STILL IN FLIGHT WHEN THE NEXT ONE COMES DUE — that one waits too", async () => {
    const w = worker();
    w.order("order1");
    w.clock.start(0);
    await w.fire(); // reads, drains order1 beside the strategy, and ends
    assert.ok(w.log.includes("order order1 sent"));
    await w.fire(); // the next regular tick, 240 s on, with the receipt still outstanding
    assert.ok(!w.log.some((l) => l.includes("IN FLIGHT")), w.log.join("\n"));
    await w.land();
    assert.deepEqual(w.log.slice(-3), ["order order1 recorded", "regular reads the book", "regular runs its producers"]);
    assert.ok(!w.log.some((l) => l.includes("IN FLIGHT")), w.log.join("\n"));
  });
});

/**
 * THE WATCHDOG MUST NEVER KILL A CHILD MID-TRADE.
 *
 * tick() writes the heartbeat as its first statement and nothing else writes
 * it, while the orchestrator SIGKILLs a child whose beat is older than
 * staleThresholdSec(tick) — 180 s on the 15-second Trencher preset. A command
 * tick now holds the clock until its order lands, and a regular tick due while
 * one is out waits for it, so an order whose receipt takes its three reads of
 * two minutes each left the file untouched for longer than that: the child was
 * killed between the send and the row, and the owner was told "I never heard
 * back… it may have filled". The process is alive and waiting on purpose, so
 * the clock says so — for a bounded time, so a wedged one is still reaped.
 */
describe("a child is alive while a trade it sent is out", () => {
  it("THE CLOCK WRITES THE FILE THE WATCHDOG READS ITSELF — the mode, who pays gas, and no block", async () => {
    // It used to call whatever `beat` main() handed it, and `beat: () => {}`
    // passed everything. Now main() hands it a path.
    const home = newHome();
    const file = path.join(home, "nested", "heartbeat.json");
    let now = 1_000_000;
    const trades = createLiveTrades(() => now);
    const clock = createCommandClock({
      now: () => now,
      setTimer: () => 0,
      clearTimer: () => {},
      fallbackMs: 15_000,
      orders: createOrderInFlight(() => now),
      trades,
      pending: () => [],
      regular: async () => 15_000,
      command: async () => {},
      heartbeat: { file, mode: () => "refuse", sponsorGas: () => true },
    });
    clock.poll();
    assert.equal(heartbeatAtIn(path.dirname(file)), null, "an idle worker is not beaten for off the clock");
    let land!: () => void;
    const out = trades.run(() => new Promise<void>((r) => (land = r)));
    now += 2_000;
    clock.poll();
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { at: 1_002, mode: "refuse", sponsorGas: true });
    assert.equal(heartbeatAtIn(path.dirname(file)), 1_002, "and the watchdog reads its time");
    land();
    await out;
  });

  it("writeHeartbeat is the one shape: `at` in seconds, and a block only when one was read", () => {
    const writes: [string, string][] = [];
    writeHeartbeat("hb.json", { mode: "live", sponsorGas: false }, 1_234_999, (f, b) => void writes.push([f, b]));
    writeHeartbeat("hb.json", { mode: "paper", sponsorGas: true, block: 63_155_033n }, 2_000_000, (f, b) => void writes.push([f, b]));
    assert.deepEqual(writes.map(([, b]) => JSON.parse(b)), [
      { at: 1_234, mode: "live", sponsorGas: false },
      { at: 2_000, block: "63155033", mode: "paper", sponsorGas: true },
    ]);
  });

  it("A COMMAND TICK'S ORDER HELD LONGER THAN THE 15-SECOND PRESET'S WATCHDOG KEEPS BEATING", async () => {
    const w = worker({ tickMs: 15_000 });
    const watchdogMs = staleThresholdSec(15) * 1000;
    w.clock.start(0);
    await w.fire(); // the first regular tick; the next is due in 15 s
    w.order("order1");
    await w.run(COMMAND_WAKE_EVERY_MS);
    assert.ok(w.log.includes("command reads the book"), w.log.join("\n"));
    assert.ok(w.log.includes("order order1 sent"), w.log.join("\n"));
    const sentAt = w.now();
    // Three receipt reads of two minutes each, and then some.
    await w.run(400_000);
    assert.ok(!w.log.includes("order order1 recorded"), "still out");
    const silence = longestSilence(w.beats, sentAt, w.now());
    assert.ok(silence < watchdogMs, `the file went ${silence / 1000}s unwritten against a ${watchdogMs / 1000}s watchdog`);
    assert.ok(silence <= ALIVE_BEAT_EVERY_MS + COMMAND_WAKE_EVERY_MS, `a beat every ${ALIVE_BEAT_EVERY_MS / 1000}s, not ${silence / 1000}s`);
    // And not a write every two-second poll: a dozen small writes, not two hundred.
    const written = w.beats.filter((b) => b > sentAt).length;
    assert.ok(written <= Math.ceil(400_000 / ALIVE_BEAT_EVERY_MS) + 1, `${written} beats in 400 s`);
    await w.land("order");
    await w.run(60_000);
    assert.ok(w.log.includes("order order1 recorded"), w.log.join("\n"));
    assert.ok(!w.log.some((l) => l.includes("IN FLIGHT")), w.log.join("\n"));
  });

  it("A REGULAR TICK HELD BEHIND AN ORDER BEATS AS IT DEFERS, and keeps beating while it waits — the reviewer's 730 s gap", async () => {
    // The reviewer's case: a regular tick whose own strategy intent sits ahead
    // of the order it drained, both receipts taking their 3 × 120 s. The tick
    // waits for its intent (370 s) and ends; the next is due 240 s later, while
    // the order is still out, and waits for it until it lands at 730 s.
    // staleThresholdSec(240) is 570 s: silent from 0 to 730 is a kill.
    const w = worker({ tickMs: 240_000, strategyHolds: 1 });
    const watchdogMs = staleThresholdSec(240) * 1000;
    w.order("order1");
    w.clock.start(0);
    await w.fire();
    const t0 = w.now();
    assert.ok(w.log.includes("order order1 sent") && w.log.includes("strategy intent sent"), w.log.join("\n"));
    await w.run(370_000);
    await w.land("strategy intent"); // the tick's own intent lands and the tick ends
    const dueAt = w.pending()[0]!;
    assert.equal(dueAt, t0 + 370_000 + 240_000, "the next regular tick is on the clock");
    await w.run(dueAt - w.now()); // it comes due, with the order still out
    assert.equal(w.log.filter((l) => l === "regular reads the book").length, 1, "held, not run");
    assert.ok(w.beats.includes(dueAt), `the held tick said it was alive the moment it deferred: ${w.beats.map((b) => b - t0)}`);
    await w.run(t0 + 730_000 - w.now());
    const silence = longestSilence(w.beats, t0, w.now());
    assert.ok(silence < watchdogMs, `the file went ${silence / 1000}s unwritten against a ${watchdogMs / 1000}s watchdog`);
    assert.ok(silence <= ALIVE_BEAT_EVERY_MS + COMMAND_WAKE_EVERY_MS, `a beat every ${ALIVE_BEAT_EVERY_MS / 1000}s, not ${silence / 1000}s`);
    await w.land("order");
    assert.equal(w.log.filter((l) => l === "regular reads the book").length, 2, "and it runs the moment the order lands");
    assert.ok(!w.log.some((l) => l.includes("IN FLIGHT")), w.log.join("\n"));
  });

  it("BUT A TRADE THAT NEVER COMES BACK STOPS THE BEAT once it has outlived any real order — a wedged child is still reaped", async () => {
    // ORDER_IN_FLIGHT_MS is the bound on an order's own run once the queue has
    // reached it (command-files.ts). Past it nothing legitimate is still going.
    const w = worker({ tickMs: 15_000 });
    w.clock.start(0);
    await w.fire();
    w.order("stuck");
    await w.run(COMMAND_WAKE_EVERY_MS);
    const sentAt = w.now();
    await w.run(ORDER_IN_FLIGHT_MS + 10 * 60_000);
    const last = w.beats[w.beats.length - 1]!;
    assert.ok(last < sentAt + ORDER_IN_FLIGHT_MS, "no beat once the trade has sat past the bound");
    assert.ok(last >= sentAt + ORDER_IN_FLIGHT_MS - ALIVE_BEAT_EVERY_MS - COMMAND_WAKE_EVERY_MS, "and beats right up to it");
    assert.ok(w.now() - last > staleThresholdSec(15) * 1000, "so the watchdog gets to judge it");
  });

  it("an idle worker between ticks does not beat off the clock — that is tick()'s job, and a stall must still show", async () => {
    const w = worker({ tickMs: 240_000 });
    w.clock.start(0);
    await w.fire();
    const before = w.beats.length;
    await w.run(200_000);
    assert.equal(w.beats.length, before, `${w.beats.length - before} beat(s) off the clock with nothing in flight`);
  });
});

/**
 * NOT ONLY THE COMMAND SLOT: EVERY TRADE ON THE INTENT CHAIN.
 *
 * A trade typed in Telegram goes straight to submitChatTrade and onto the
 * intent chain; it never touches the command slot. So a regular tick due while
 * one was between inclusion and its row read the book under it, and a command
 * tick could start beside it and read it again.
 */
describe("a trade typed in Telegram holds the clock the same way", () => {
  it("A REGULAR TICK DUE WHILE A CHAT TRADE IS OUT WAITS FOR IT", async () => {
    const w = worker();
    w.clock.start(0);
    await w.fire();
    w.chat("tg1");
    await w.run(240_000);
    assert.equal(w.log.filter((l) => l === "regular reads the book").length, 1, "held while the chat trade is out");
    await w.land("chat");
    assert.equal(w.log.filter((l) => l === "regular reads the book").length, 2, "and run the moment it lands");
    assert.ok(!w.log.some((l) => l.includes("IN FLIGHT")), w.log.join("\n"));
  });

  it("NO COMMAND TICK STARTS BESIDE A CHAT TRADE — the order waits for it, and is not spent while it waits", async () => {
    const w = worker();
    w.clock.start(0);
    await w.fire();
    w.chat("tg1");
    w.order("order1");
    await w.run(20_000);
    assert.ok(!w.log.includes("command reads the book"), w.log.join("\n"));
    await w.land("chat"); // the chat trade lands
    await w.run(COMMAND_WAKE_EVERY_MS);
    assert.ok(w.log.includes("order order1 sent"), "picked up the moment the chat trade is recorded");
    assert.ok(!w.log.some((l) => l.includes("IN FLIGHT")), w.log.join("\n"));
  });

  it("and a chat trade held past the preset's watchdog keeps the child beating too", async () => {
    const w = worker({ tickMs: 15_000 });
    w.clock.start(0);
    await w.fire();
    w.chat("tg1");
    const sentAt = w.now();
    await w.run(400_000);
    const silence = longestSilence(w.beats, sentAt, w.now());
    assert.ok(silence < staleThresholdSec(15) * 1000, `the file went ${silence / 1000}s unwritten`);
  });
});

describe("the live-trade count", () => {
  it("BUSY FROM THE MOMENT A TRADE JOINS THE CHAIN UNTIL IT SETTLES, however it settles", async () => {
    const t = createLiveTrades(() => 0);
    assert.equal(t.busy(), false);
    assert.equal(t.settled(), null);
    let land!: () => void;
    let fail!: (e: Error) => void;
    const a = t.run(() => new Promise<string>((r) => (land = () => r("a"))));
    const b = t.run(() => new Promise<string>((_, rej) => (fail = rej)));
    assert.equal(t.busy(), true);
    const waiting = t.settled();
    assert.ok(waiting, "a settle to wait on");
    let freed = false;
    void waiting.then(() => (freed = true));
    land();
    assert.equal(await a, "a", "the step's own value comes back untouched");
    await settle();
    assert.equal(freed, false, "one still out");
    assert.equal(t.busy(), true);
    fail(new Error("reverted"));
    await assert.rejects(b, /reverted/, "and so does its failure");
    await settle();
    assert.equal(freed, true);
    assert.equal(t.busy(), false);
    assert.equal(t.settled(), null);
  });

  it("a step that throws before it returns a promise still frees the count", async () => {
    const t = createLiveTrades(() => 0);
    await assert.rejects(
      t.run(() => {
        throw new Error("sync");
      }),
      /sync/,
    );
    assert.equal(t.busy(), false);
  });

  it("IT MOVED WHEN WORK STARTED FROM IDLE OR SETTLED — a trade queued behind a stuck one does not reset the bound", async () => {
    let now = 100;
    const t = createLiveTrades(() => now);
    assert.equal(t.movedAt(), null);
    let landA!: () => void;
    const a = t.run(() => new Promise<void>((r) => (landA = r)));
    assert.equal(t.movedAt(), 100);
    now = 200;
    let landB!: () => void;
    const b = t.run(() => new Promise<void>((r) => (landB = r)));
    assert.equal(t.movedAt(), 100, "joining the queue is not progress");
    now = 300;
    landA();
    await a;
    assert.equal(t.movedAt(), 300, "a trade settling is");
    now = 400;
    landB();
    await b;
    assert.equal(t.movedAt(), null, "and idle has nothing to time");
  });

  it("the command slot knows when its order started, and forgets when it frees", async () => {
    let now = 5;
    const o = createOrderInFlight(() => now);
    assert.equal(o.since(), null);
    let land!: () => void;
    const run = o.run(() => new Promise<void>((r) => (land = r)));
    now = 9;
    assert.equal(o.since(), 5);
    land();
    await run;
    assert.equal(o.since(), null);
  });
});

/**
 * THE RATCHETS, RUN RATHER THAN TRUSTED.
 *
 * A command tick skipped the paper peak, the risk-period observation, the fee
 * and the live mark, the in-memory mark and the equity row only because of five
 * `plan.ratchets &&` guards inside tick(). Removing all five passed every test:
 * the only test read a constant. The guards live in tickRatchets now, tick()
 * hands it each writer, and these tests run it with writers that record.
 */
describe("what a tick may write down", () => {
  const BOOK = { incomplete: false, curveMarked: 0 };
  /** Every writer, recording what reached it. */
  function writers() {
    const calls: string[] = [];
    return {
      calls,
      paper: async (b: { hwmUsdg: number }) => void calls.push(`paper peak ${b.hwmUsdg}`),
      risk: async (observe: number | null) => (calls.push(`risk peak observe=${observe}`), 150),
      fee: async () => void calls.push("fee + live mark"),
      equity: async (row: { flowsHeld: boolean }) => void calls.push(row.flowsHeld ? "equity row (flows held)" : "equity row"),
    };
  }
  const ACCRUAL = { profitUsdg: 20_000_000n, newHwmUsdg: 120_000_000n };
  const PEAK = 100_000_000n;

  it("A COMMAND TICK WRITES NOTHING DOWN — no paper peak, no fee, no mark, no equity row — and observes no peak", async () => {
    const r = tickRatchets(tickPlan("command"), BOOK);
    const w = writers();
    const paperBook = { hwmUsdg: 100 };
    assert.equal(await r.paperPeak(paperBook, 120, w.paper), 100, "the paper peak it reads is the one on record");
    assert.equal(paperBook.hwmUsdg, 100, "and the row is not raised in memory either");
    assert.equal(await r.riskPeak(120, w.risk), 150, "the peak the order is judged against is still read");
    assert.equal(await r.accrue(ACCRUAL, PEAK, w.fee), PEAK, "the in-memory mark the breaker divides by does not move");
    await r.equityRow(w.equity);
    assert.deepEqual(w.calls, ["risk peak observe=null"], "asked without observing — risk-period.ts reads the peak on null");
  });

  it("a group nomination cannot ratchet a transient profit into fees, peaks or the breaker's reference", async () => {
    const r = tickRatchets(tickPlan("nomination"), { ...BOOK, held: true, breakerObservationUsdg: 150_000_000n });
    const w = writers();
    const paperBook = { hwmUsdg: 100 };
    assert.equal(await r.paperPeak(paperBook, 150, w.paper), 100);
    await r.riskPeak(150, w.risk);
    assert.equal(await r.accrue(ACCRUAL, PEAK, w.fee), PEAK);
    assert.equal(r.breakerLift(10_000_000n, PEAK, PEAK), 10_000_000n);
    await r.equityRow(w.equity);
    assert.deepEqual(w.calls, ["risk peak observe=null"]);
    assert.equal(paperBook.hwmUsdg, 100);
  });

  it("A REGULAR TICK WRITES EACH ONE DOWN", async () => {
    const r = tickRatchets(tickPlan("regular"), BOOK);
    const w = writers();
    const paperBook = { hwmUsdg: 100 };
    assert.equal(await r.paperPeak(paperBook, 120, w.paper), 120);
    assert.equal(await r.riskPeak(120, w.risk), 150);
    assert.equal(await r.accrue(ACCRUAL, PEAK, w.fee), ACCRUAL.newHwmUsdg);
    await r.equityRow(w.equity);
    assert.deepEqual(w.calls, ["paper peak 120", "risk peak observe=120", "fee + live mark", "equity row"]);
  });

  it("a regular tick raises a peak only past it, and writes a fee only on a profit", async () => {
    const r = tickRatchets(tickPlan("regular"), BOOK);
    const w = writers();
    assert.equal(await r.paperPeak({ hwmUsdg: 100 }, 90, w.paper), 100);
    assert.equal(await r.paperPeak({ hwmUsdg: 100 }, 100, w.paper), 100);
    assert.equal(await r.accrue({ profitUsdg: 0n, newHwmUsdg: PEAK }, PEAK, w.fee), PEAK);
    assert.deepEqual(w.calls, []);
  });

  it("A CURVE-MARKED HOLDING RATCHETS NOTHING, on any tick — but the regular tick's equity row is still written", async () => {
    const r = tickRatchets(tickPlan("regular"), { incomplete: false, curveMarked: 1 });
    const w = writers();
    assert.equal(await r.paperPeak({ hwmUsdg: 100 }, 120, w.paper), 100);
    await r.riskPeak(120, w.risk);
    assert.equal(await r.accrue(ACCRUAL, PEAK, w.fee), PEAK);
    await r.equityRow(w.equity);
    assert.deepEqual(w.calls, ["risk peak observe=null", "equity row"]);
  });

  it("A HELD FLOW LOOK accrues no fee and moves no paper or lifetime peak — its equity row is written FLAGGED (flow-inference.ts)", async () => {
    // An op the resolver may still settle is in flight, so the cash in this
    // equity is not split into capital and performance yet: a deposit made in
    // the hold would be charged a fee, and counted into the lifetime peak
    // before it is booked — then again when it is.
    const r = tickRatchets(tickPlan("regular"), { ...BOOK, held: true });
    const w = writers();
    assert.equal(await r.paperPeak({ hwmUsdg: 100 }, 120, w.paper), 100);
    await r.riskPeak(120, w.risk);
    assert.equal(await r.accrue(ACCRUAL, PEAK, w.fee), PEAK, "the lifetime mark does not move");
    assert.equal(r.breakerLift(0n, PEAK, PEAK), 0n, "with no held observation, the breaker's lift does not move either");
    await r.equityRow(w.equity);
    assert.deepEqual(
      w.calls,
      ["risk peak observe=null", "equity row (flows held)"],
      "the peak is still READ — without observing, since no held observation was given — and the valuation is written, flagged",
    );
    // And `held: false` is the ordinary regular tick.
    const plain = tickRatchets(tickPlan("regular"), { ...BOOK, held: false });
    const w2 = writers();
    await plain.riskPeak(120, w2.risk);
    await plain.accrue(ACCRUAL, PEAK, w2.fee);
    await plain.equityRow(w2.equity);
    assert.deepEqual(w2.calls, ["risk peak observe=120", "fee + live mark", "equity row"]);
  });

  it("A HELD FLOW LOOK STILL FEEDS THE BREAKER: its peaks observe the held figure — never the raw equity — and the fee's mark stays", async () => {
    // A dropped userOp holds every look for 26 hours. Freezing the breaker's
    // peak with the fee's let 100 → 150 → 110 read as no drawdown for a day.
    const r = tickRatchets(tickPlan("regular"), { ...BOOK, held: true, breakerObservationUsdg: 110_000_000n });
    const w = writers();
    await r.riskPeak(150, w.risk);
    assert.equal(await r.accrue(ACCRUAL, PEAK, w.fee), PEAK, "no fee, and the lifetime mark stays");
    assert.equal(r.breakerLift(0n, PEAK, PEAK), 10_000_000n, "the breaker's peak is the mark plus what the hold saw above it");
    assert.equal(r.breakerLift(30_000_000n, PEAK, PEAK), 30_000_000n, "a lift only ever grows from observations");
    await r.equityRow(w.equity);
    assert.deepEqual(w.calls, ["risk peak observe=110", "equity row (flows held)"]);
  });

  it("the held observation obeys every other guard: a command tick or a curve mark observes nothing", async () => {
    for (const [plan, book] of [
      [tickPlan("command"), BOOK],
      [tickPlan("regular"), { incomplete: false, curveMarked: 1 }],
      [tickPlan("regular"), { incomplete: true, curveMarked: 0 }],
    ] as const) {
      const r = tickRatchets(plan, { ...book, held: true, breakerObservationUsdg: 110_000_000n });
      const w = writers();
      await r.riskPeak(150, w.risk);
      assert.equal(r.breakerLift(5n, PEAK, PEAK), 5n);
      assert.equal(w.calls[0], "risk peak observe=null");
    }
  });

  it("THE BREAKER'S LIFT IS ABSORBED as the lifetime mark rises past it — the breaker's peak is the higher of the two", () => {
    const r = tickRatchets(tickPlan("regular"), BOOK);
    assert.equal(r.breakerLift(50_000_000n, PEAK, 120_000_000n), 30_000_000n, "150 stands: 120 + 30");
    assert.equal(r.breakerLift(50_000_000n, PEAK, 160_000_000n), 0n, "the mark is past it: nothing left to carry");
  });

  it("A BOOK THAT COULD NOT BE TOTALLED WRITES NO EQUITY ROW — a gap is honest, a partial total is not", async () => {
    const r = tickRatchets(tickPlan("regular"), { incomplete: true, curveMarked: 0 });
    const w = writers();
    await r.equityRow(w.equity);
    assert.equal(await r.accrue(ACCRUAL, PEAK, w.fee), PEAK);
    await r.riskPeak(120, w.risk);
    assert.deepEqual(w.calls, ["risk peak observe=null"]);
  });
});
