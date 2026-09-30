/**
 * ONE TENANT, ONE CHILD — EVEN WHEN TWO PATHS REACH spawnChild AT ONCE.
 *
 * `spawnChild` awaits a dozen times between "no child is running" and
 * `spawn()`: the grant, the settings, the anchor, the paper restore, the seeds.
 * Its callers each checked `children.has` before calling, and nothing marked a
 * spawn that was still preparing — so a reconcile pass and a restart timer, or
 * two restart timers, could both find the tenant missing and both start a
 * worker. Two processes on one home and one sqlite file, both trading, and
 * only the second visible to the watchdog. Measured before the exit handler's
 * identity check: 105 spawns against 61 exits in one window.
 *
 * And the exit handler added a restart of its own for a child somebody else
 * had already stood down. The watchdog deletes, SIGKILLs and schedules a
 * restart through the policy; the corpse's exit then scheduled a SECOND one,
 * usually at one second with the ladder back at zero, so the watchdog's
 * backoff and the MAX_RESTARTS brake never applied. The same happened after a
 * kill-switch, a lost lease and FLEET_HALT, where the only thing that stopped
 * the extra restart was the lease having gone.
 *
 * Driven through the real reconcile() over a real file-backed grant store,
 * with the worker process replaced by a fake (setSpawnForTest) and the
 * settings read gated — an await inside spawnChild's preparation that a test
 * can hold open through an existing seam — so a second path can be made to
 * arrive while the first is mid-spawn.
 *
 * The restart ladder is driven the same way with the clock and the timers in
 * the test's hands (node:test mock timers): a child that keeps going down is
 * stood down at MAX_RESTARTS, on the exit path and the watchdog's, even with a
 * reconcile pass landing before every restart timer; and a stall after a
 * healthy run starts the ladder again rather than climbing it.
 *
 * MERRYMEN_HOME is per process (node --test forks per file), so this never
 * leaks into another test file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-double-spawn-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
// The file stores and the no-op lease: no Postgres in this test.
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
// The tick every child here runs, so the watchdog's patience is known:
// firstBeatGraceSec(60) = 150s for a first beat, staleThresholdSec(60) = 210s
// between beats.
process.env.MERRYMEN_TICK_SECONDS = "60";
const FIRST_BEAT_SEC = 150;
const STALE_SEC = 210;

const { reconcile, watchdog, childHome, fleetHaltFile, setSpawnForTest } = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore, useSettingsStoreForTest } = await import("./settings-store");
const { writeKillRequest } = await import("./kill-request");

const TENANT = "0x00000000000000000000000000000000000000a7" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000c7" as const;

const grant = (): StoredGrant =>
  ({
    smartAccount: ACCOUNT,
    owner: "0x00000000000000000000000000000000000000b7",
    sessionKeyAddress: "0x00000000000000000000000000000000000000d7",
    serialized: "eyJ-a-zerodev-blob-double-spawn",
    chainId: 4663,
    grantedAt: Math.floor(Date.now() / 1000) - 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
    grantFeatures: ["tradeable-v2"],
    grantTokens: [],
    demoSessionPrivateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
  }) as unknown as StoredGrant;

/** A worker process reduced to what the orchestrator does with one. */
class FakeProc extends EventEmitter {
  static next = 40_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  private gone = false;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    // Asynchronously, as a real process exits: the handler never runs inside
    // the kill() that caused it. Killed by a signal, it has no exit code.
    if (!this.gone) setImmediate(() => this.die(null, String(signal ?? "SIGTERM")));
    return true;
  }
  /** The process ending, for any reason. Once only, as a real one does. */
  die(code: number | null, signal: string | null = null): void {
    if (this.gone) return;
    this.gone = true;
    this.emit("exit", code, signal);
  }
}

const spawned: FakeProc[] = [];
setSpawnForTest(() => {
  const p = new FakeProc();
  spawned.push(p);
  return p as unknown as ChildProcess;
});

/** The real clock's setTimeout, whatever a test has mocked since. */
const realSetTimeout = globalThis.setTimeout;

/**
 * Hold spawnChild at its settings read. While the gate is closed, every
 * `get` waits; `reached` resolves when the first one arrives — or rejects
 * after five real seconds, so a regression that stops the spawn fails the
 * test rather than hanging the file.
 */
let gate: { reached: Promise<void>; wait: () => Promise<void>; open: () => void } | null = null;
function closeGate() {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve, reject) => {
    const late = realSetTimeout(() => reject(new Error(`spawnChild never reached the gate:\n${said.join("\n")}`)), 5_000);
    late.unref();
    arrive = () => {
      clearTimeout(late);
      resolve();
    };
  });
  const opened = new Promise<void>((r) => (release = r));
  const g = {
    reached,
    wait: async () => {
      arrive();
      await opened;
    },
    open: () => {
      if (gate === g) gate = null;
      release();
    },
  };
  gate = g;
  return g;
}
const realSettings = getSettingsStore();
const gated = Object.create(realSettings) as typeof realSettings;
gated.get = async (t) => {
  const g = gate;
  if (g) await g.wait();
  return realSettings.get(t);
};
useSettingsStoreForTest(gated);

/** What the orchestrator said, so a test can tell a scheduled restart from none. */
const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => {
  said.push(a.map(String).join(" "));
};
after(() => {
  console.log = realLog;
  rmSync(FLEET, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const store = getGrantStore();
/** Let pending callbacks run — an exit emitted on setImmediate, a reconcile that has nothing to wait for. */
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/**
 * Run `fn` with Date and setTimeout in the test's hands; real I/O still runs.
 *
 * Whatever timers are still pending when it ends are fired before the clock
 * is handed back. A passing test leaves none; a failing one can leave a
 * restart timer, and a mocked timer that never fires leaves its tenant marked
 * as waiting on a restart for the rest of the file — every later test would
 * then wait for a spawn that reconcile will never start, and hang rather
 * than fail.
 */
async function withClock(fn: () => Promise<void>, apis: ("setTimeout" | "Date")[] = ["setTimeout", "Date"]) {
  mock.timers.enable({ apis, now: Date.now() });
  try {
    await fn();
  } finally {
    if (apis.includes("setTimeout")) mock.timers.runAll();
    await settle(50);
    mock.timers.reset();
  }
}
/** Wait, in real time, for spawnChild's own I/O to get somewhere. */
async function until(cond: () => boolean, what: string) {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > 5_000) assert.fail(`timed out waiting for ${what}:\n${said.join("\n")}`);
    await new Promise((r) => setImmediate(r));
  }
}
/** The restarts the orchestrator has announced, in order. */
const rallies = () => said.filter((l) => /rallying again/.test(l));
/** Let the last announced restart timer fire, and wait for the worker it starts. */
async function fireRestart(): Promise<void> {
  const last = rallies().at(-1);
  const secs = Number(/rallying again in (\d+)s/.exec(last ?? "")?.[1]);
  assert.ok(secs > 0, `a restart was scheduled:\n${said.join("\n")}`);
  const before = spawned.length;
  mock.timers.tick(secs * 1000);
  await until(() => spawned.length === before + 1, "the restart's worker");
}
/** The child's own heartbeat, written now by the test's clock. */
const beat = () => writeFileSync(path.join(childHome(TENANT), "heartbeat.json"), JSON.stringify({ at: Math.floor(Date.now() / 1000) }));
const keepsDying = () => said.some((l) => /keeps dying right after start/.test(l));

beforeEach(async () => {
  gate?.open();
  rmSync(fleetHaltFile(), { force: true });
  // With no stored grant, a reconcile stands down any child an earlier test
  // left running and releases its lease. Each test starts from an empty fleet.
  await store.remove(TENANT);
  await reconcile();
  await settle();
  rmSync(childHome(TENANT), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  spawned.length = 0;
  said.length = 0;
});

describe("two paths reaching spawnChild at once", () => {
  it("TWO RECONCILE PASSES OVER ONE TENANT START ONE CHILD", async () => {
    await store.put(TENANT, grant());
    const g = closeGate();
    const first = reconcile();
    await g.reached; // the first pass is inside spawnChild, preparing
    // The second pass is not awaited while the gate is shut: without the
    // guard it would be waiting at the same gate, not skipping.
    const second = reconcile();
    await settle();
    g.open();
    await Promise.all([first, second]);
    await settle();
    assert.equal(spawned.length, 1, "one tenant, one worker");
  });

  it("A RESTART TIMER MID-SPAWN AND A RECONCILE PASS START ONE REPLACEMENT", async () => {
    await store.put(TENANT, grant());
    await reconcile();
    assert.equal(spawned.length, 1);
    // The child dies on its own: its entry is still its own, so the exit
    // handler still owns the restart, through the one policy.
    const g = closeGate();
    spawned[0]!.die(1);
    assert.ok(said.some((l) => /rallying again in 2s \(restart #1, exit 1\)/.test(l)), said.join("\n"));
    await g.reached; // the timer fired and its spawnChild is preparing
    const pass = reconcile();
    await settle();
    g.open();
    await pass;
    // The pass stepped round the tenant and did not wait for the timer's
    // spawn, which does real I/O once released: wait for its worker, not for
    // a count of turns (under a loaded full run twenty were not enough).
    await until(() => spawned.length >= 2, "the timer's replacement");
    await settle();
    assert.equal(spawned.length, 2, "the timer's replacement and nothing else");
  });
});

describe("the exit handler only restarts its own child", () => {
  it("A CHILD STOOD DOWN BY THE KILL SWITCH IS NOT RESTARTED BY ITS OWN EXIT", async () => {
    await store.put(TENANT, grant());
    await reconcile();
    assert.equal(spawned.length, 1);
    said.length = 0;
    await store.remove(TENANT);
    await reconcile(); // the kill-switch branch: killChild, then the lease goes
    await settle();
    assert.deepEqual(spawned[0]!.signals.slice(0, 1), ["SIGTERM"], "it was stood down");
    assert.ok(!said.some((l) => /rallying again/.test(l)), `no restart was scheduled:\n${said.join("\n")}`);
    assert.ok(!said.some((l) => /exited \(/.test(l)), "the stand-down, not the exit, owns what happens next");
    // But the exit is still on the record, in words of its own: a child that
    // ignored SIGTERM would show as a stand-down with no such line after it.
    assert.ok(
      said.some((l) => new RegExp(`${TENANT} stood-down child \\(pid ${spawned[0]!.pid}\\) exited with SIGTERM`).test(l)),
      said.join("\n"),
    );
  });

  it("THE WATCHDOG'S KILL IS THE ONLY RESTART: THE CORPSE'S EXIT SCHEDULES NOTHING", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      assert.equal(spawned.length, 1);
      said.length = 0;
      // It never beats.
      mock.timers.tick((FIRST_BEAT_SEC + 1) * 1000);
      watchdog();
      await settle(); // the SIGKILL's exit arrives
      assert.deepEqual(spawned[0]!.signals, ["SIGKILL"]);
      assert.equal(rallies().length, 1, `one restart, the watchdog's:\n${said.join("\n")}`);
      assert.match(rallies()[0]!, /rallying again in 2s \(restart #1, heartbeat stale\)/);
      assert.ok(said.some((l) => /stood-down child \(pid \d+\) exited with SIGKILL/.test(l)), said.join("\n"));
      assert.ok(!said.some((l) => l.includes(`${TENANT} exited (`)), "the corpse's exit is not the one that restarts");
      // A pass before the timer fires leaves the restart to it.
      await reconcile();
      assert.equal(spawned.length, 1, "reconcile does not restart it at rung 0 under the timer");
      await fireRestart();
      mock.timers.tick(60_000);
      await settle();
      assert.equal(spawned.length, 2, "one replacement, and nothing else");
      assert.equal(rallies().length, 1);
    });
  });
});

describe("the restart ladder climbs, and stops", () => {
  it("A CHILD THAT KEEPS EXITING RIGHT AFTER START IS STOOD DOWN, EVEN WITH A PASS BEFORE EVERY TIMER", async () => {
    // What used to happen: every pass found the tenant not running and
    // spawned it at rung 0, so every exit was "restart #1" and the tenant was
    // cold-armed for ever.
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      let rung = 0;
      for (;;) {
        spawned.at(-1)!.die(1);
        if (keepsDying()) break;
        rung += 1;
        assert.ok(rung <= 20, "the ladder has a top");
        assert.match(rallies().at(-1)!, new RegExp(`\\(restart #${rung}, exit 1\\)`));
        await reconcile();
        assert.equal(spawned.length, rung, `pass ${rung} left the restart to its timer`);
        await fireRestart();
      }
      assert.equal(rung, 8, "MAX_RESTARTS rungs, then the stand-down");
      await reconcile();
      mock.timers.tick(4 * 60_000);
      await reconcile();
      assert.equal(spawned.length, 9, "stood down: no pass picks it straight back up");
      // Five minutes, not for ever — and it comes back with the count it had.
      mock.timers.tick(60_000 + 1);
      await reconcile();
      assert.ok(said.some((l) => /stand-down over — trying once more/.test(l)), said.join("\n"));
      assert.equal(spawned.length, 10);
    });
  });

  it("A CHILD THE WATCHDOG KEEPS KILLING IS STOOD DOWN TOO, NOT COLD-ARMED FOR EVER", async () => {
    // The rate-limited path: a tick stuck retrying never beats, the watchdog
    // SIGKILLs it, and every restart is another cold arm against the endpoint
    // that caused it.
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      let rung = 0;
      for (;;) {
        mock.timers.tick((FIRST_BEAT_SEC + 1) * 1000);
        watchdog();
        await settle();
        if (keepsDying()) break;
        rung += 1;
        assert.ok(rung <= 20, "the ladder has a top");
        assert.match(rallies().at(-1)!, new RegExp(`\\(restart #${rung}, heartbeat stale\\)`));
        await reconcile();
        assert.equal(spawned.length, rung, `pass ${rung} left the restart to its timer`);
        await fireRestart();
      }
      assert.equal(rung, 8, "MAX_RESTARTS rungs, then the stand-down");
      assert.ok(!said.some((l) => l.includes(`${TENANT} exited (`)), "every restart was the watchdog's");
      await reconcile();
      assert.equal(spawned.length, 9, "stood down: no pass picks it straight back up");
      mock.timers.tick(5 * 60_000 + 1);
      await reconcile();
      assert.equal(spawned.length, 10, "and tried again once the stand-down is over");
    });
  });

  it("A STALL AFTER A HEALTHY RUN STARTS THE LADDER AGAIN; ONE RIGHT AFTER ARMING CLIMBS IT", async () => {
    // With the corpse's own restart gone, the watchdog picks the rung alone.
    // `restarts + 1` every time would carry a rung from one incident into the
    // next: a child that wedged once a week restarting a little slower each
    // time, and stood down in the ninth week as "keeps dying right after start".
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      // Never beats: the first rung of an incident.
      mock.timers.tick((FIRST_BEAT_SEC + 1) * 1000);
      watchdog();
      await settle();
      assert.match(rallies().at(-1)!, /\(restart #1, heartbeat stale\)/);
      await fireRestart();
      // Its replacement never beats either: the same incident, one rung up.
      mock.timers.tick((FIRST_BEAT_SEC + 1) * 1000);
      watchdog();
      await settle();
      assert.match(rallies().at(-1)!, /in 4s \(restart #2, heartbeat stale\)/);
      await fireRestart();
      // This one gets going — beating two minutes in — and wedges after.
      mock.timers.tick(120_000);
      beat();
      mock.timers.tick((STALE_SEC + 1) * 1000);
      watchdog();
      await settle();
      assert.match(rallies().at(-1)!, /in 1s \(restart #0, heartbeat stale\)/, "a fresh incident, back at the bottom");
      await fireRestart();
      // A beat from before this child started is its predecessor's, not its own.
      mock.timers.tick((STALE_SEC + 1) * 1000);
      watchdog();
      await settle();
      assert.match(rallies().at(-1)!, /\(restart #1, heartbeat stale\)/, "the file it inherited does not make it healthy");
      await fireRestart();
      assert.equal(spawned.length, 5);
    });
  });
});

describe("the world can change while a child is being prepared", () => {
  it("A FLEET_HALT THAT LANDS MID-SPAWN STOPS THE SPAWN", async () => {
    await store.put(TENANT, grant());
    const g = closeGate();
    const pass = reconcile();
    await g.reached;
    writeFileSync(fleetHaltFile(), "halt");
    g.open();
    await pass;
    assert.equal(spawned.length, 0, "no worker starts under a halt");
    assert.ok(said.some((l) => /FLEET_HALT/.test(l) && /not spawning/.test(l)), said.join("\n"));
  });

  it("A TELEGRAM KILL THAT LANDS MID-SPAWN STOPS THE SPAWN", async () => {
    await store.put(TENANT, grant());
    const g = closeGate();
    const pass = reconcile();
    await g.reached;
    // The grant.json is already written; the kill is what must win.
    writeKillRequest(childHome(TENANT), grant(), Math.floor(Date.now() / 1000));
    g.open();
    await pass;
    assert.equal(spawned.length, 0, "no worker starts over a pending kill");
    assert.ok(said.some((l) => /kill/.test(l) && /not spawning/.test(l)), said.join("\n"));
  });

  it("AND THE PASS THAT CARRIES THE KILL OUT WIPES THE HOME IT WAS PREPARED IN", async () => {
    // The refused spawn never reached `children`, and the kill-switch branch
    // walked only `children`: the revoked grant.json, the settings with the
    // bot token and the pending request stayed until the container went, and
    // a grant signed later armed on top of them.
    await store.put(TENANT, grant());
    const g = closeGate();
    const pass = reconcile();
    await g.reached;
    writeKillRequest(childHome(TENANT), grant(), Math.floor(Date.now() / 1000));
    g.open();
    await pass;
    assert.ok(existsSync(path.join(childHome(TENANT), "settings.json")), "the refused spawn left its preparation behind");
    await reconcile();
    assert.equal(await store.get(TENANT), null, "the kill took the grant out of the store");
    assert.equal(existsSync(childHome(TENANT)), false, "and the home went with it");
    assert.equal(spawned.length, 0);
  });

  it("A LEASE RELEASED MID-SPAWN STOPS THE SPAWN", async () => {
    await store.put(TENANT, grant());
    const g = closeGate();
    const first = reconcile();
    await g.reached;
    // The grant is deleted meanwhile, so the next pass no longer wants the
    // tenant and releases its lease. The spawn that checked the lease at the
    // top must not start a worker this replica no longer holds a lock for.
    await store.remove(TENANT);
    await reconcile();
    g.open();
    await first;
    assert.equal(spawned.length, 0, "no worker starts without the lease it was prepared under");
    assert.ok(said.some((l) => /lease/.test(l) && /not spawning/.test(l)), said.join("\n"));
    // The pass that released the lease left the home alone, because a spawn
    // was still preparing in it; the next one wipes it.
    assert.ok(existsSync(path.join(childHome(TENANT), "grant.json")), "the revoked grant was written before the refusal");
    await reconcile();
    assert.equal(existsSync(childHome(TENANT)), false, "the next pass wipes what the refused spawn wrote");
  });

  it("A CRASHED CHILD WAITING ON ITS RESTART LOSES ITS HOME, AND ITS RESTART, WHEN ITS GRANT GOES", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      await reconcile();
      spawned[0]!.die(1);
      assert.match(rallies().at(-1)!, /restart #1, exit 1/);
      await store.remove(TENANT);
      await reconcile();
      assert.equal(existsSync(childHome(TENANT)), false, "no child in it, and no grant for it: the home goes");
      mock.timers.tick(60_000);
      await settle();
      assert.equal(spawned.length, 1, "the restart was cancelled with it");
      assert.ok(!said.some((l) => /not spawning/.test(l)), "not even tried");
    });
  });

  it("A SPAWN THAT NEVER SETTLES IS REPORTED ONCE, AND STILL STARTS ONE WORKER IF IT DOES", async () => {
    await store.put(TENANT, grant());
    await withClock(async () => {
      const g = closeGate();
      const first = reconcile();
      await g.reached;
      await reconcile();
      assert.ok(!said.some((l) => /\[alert\] spawn for/.test(l)), "a young claim is stepped round in silence");
      mock.timers.tick(5 * 60_000 + 1);
      await reconcile();
      await reconcile();
      const alerts = said.filter((l) => new RegExp(`\\[alert\\] spawn for ${TENANT} still preparing since`).test(l));
      assert.equal(alerts.length, 1, `said once, not every pass:\n${said.join("\n")}`);
      assert.equal(spawned.length, 0, "and the claim was not taken back to start another");
      g.open();
      await first;
      assert.equal(spawned.length, 1);
    }, ["Date"]);
  });
});
