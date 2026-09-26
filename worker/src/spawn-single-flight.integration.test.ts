/**
 * ONE CHILD PER TENANT, HOWEVER THE RESTARTS AND THE RECONCILE PASSES FALL.
 *
 * What it used to do: two paths spawn a crashed tenant's child, the exit
 * handler's restart timer and reconcile()'s spawn loop. Each checked
 * `children` and then called spawnChild, which awaits the grant store, the
 * settings store and the anchor before it records the child. A second call
 * in that window passed the same check and started a second worker. The
 * later `children.set` replaced the first, which kept trading with no
 * watchdog and no mirror. reconcile() also respawned a tenant still waiting
 * on its restart, at restart #0, so the ladder rarely climbed. And a watchdog
 * kill left two restarts behind: its own, and the killed child's exit
 * handler's, at #0 and one second, which fired first.
 *
 * Spawned through the real reconcile() and spawnChild over a real
 * file-backed grant store, with only the worker process swapped for a fake
 * (setSpawnForTest). A crash runs the real exit handler and schedules the
 * real restart. setTimeout is mocked, so each test decides when a restart
 * comes due, including in the middle of a spawn.
 *
 * MERRYMEN_HOME is per process (node --test forks per file), so it never
 * leaks into another test file.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
import type { StoredGrant } from "../../packages/core/src/index";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-spawn-single-flight-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
// The file store and the no-op lease: no Postgres in this test.
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_TICK_SECONDS;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 9).toString("base64");

const { reconcile, setSpawnForTest, watchdog } = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");

after(() => {
  rmSync(FLEET, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const TENANT = "0x00000000000000000000000000000000000000a1" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000c3" as const;
const store = getGrantStore();
// Captured before any test mocks setTimeout.
const realSetTimeout = setTimeout;

const grant = (): StoredGrant => {
  const grantedAt = Math.floor(Date.now() / 1000) - 3600;
  return {
    smartAccount: ACCOUNT,
    owner: "0x00000000000000000000000000000000000000b2",
    sessionKeyAddress: "0x00000000000000000000000000000000000000d4",
    serialized: `eyJ-a-zerodev-blob-${grantedAt}`,
    chainId: 4663,
    grantedAt,
    expiresAt: grantedAt + 7 * 86_400,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
    grantFeatures: ["tradeable-v2"],
    grantTokens: [],
    demoSessionPrivateKey: ("0x" + "cd".repeat(32)) as `0x${string}`,
  } as unknown as StoredGrant;
};

/** A worker process as spawnChild sees one. `crash` exits it on its own, as a failing worker does. */
function fakeWorker() {
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: null,
    stderr: null,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    /** The exit event has been emitted, so the exit handler has run. */
    exited: false,
    kill(signal?: NodeJS.Signals | number) {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.signalCode = typeof signal === "string" ? signal : "SIGTERM";
        setImmediate(() => {
          proc.exited = true;
          proc.emit("exit", null, proc.signalCode);
        });
      }
      return true;
    },
    crash(code = 1) {
      proc.exitCode = code;
      proc.exited = true;
      proc.emit("exit", code, null);
    },
  });
  return proc;
}

/** Every worker spawnChild started, oldest first. */
const spawned: ReturnType<typeof fakeWorker>[] = [];
setSpawnForTest(() => {
  const w = fakeWorker();
  spawned.push(w);
  return w as unknown as ChildProcess;
});
const latest = () => spawned[spawned.length - 1]!;

/**
 * Resolves once `done()` holds, or after about half a second of real time.
 * Counts turns rather than reading the clock, which a test may have mocked.
 */
async function eventually(done: () => boolean, turns = 100): Promise<void> {
  for (let i = 0; i < turns && !done(); i++) await new Promise((r) => realSetTimeout(r, 5));
}

/** Run `during` inside the next grant-store read, the first await of every spawn. */
function duringNextGrantRead(during: () => void | Promise<void>): { fired: () => boolean } {
  const read = store.get.bind(store);
  let fired = false;
  store.get = async (tenant) => {
    if (!fired) {
      fired = true;
      store.get = read;
      await during();
    }
    return read(tenant);
  };
  return { fired: () => fired };
}

/** A stored grant, and the child reconcile spawns for it. */
async function armed(): Promise<void> {
  await store.put(TENANT, grant());
  await reconcile();
  assert.equal(spawned.length, 1, "armed");
}

afterEach(async () => {
  // Real timers first: the clean-up stand-down waits on them.
  mock.timers.reset();
  await store.remove(TENANT);
  await reconcile();
  spawned.length = 0;
});

describe("one child per tenant", () => {
  it("THE BUG: a restart that comes due while reconcile is spawning starts no second worker", async () => {
    await armed();
    mock.timers.enable({ apis: ["setTimeout"] });
    latest().crash(1); // the real exit handler: restart #1, due in 2 s

    // The restart comes due at the worst moment: inside the first await of
    // any spawn this pass starts.
    duringNextGrantRead(() => mock.timers.tick(5_000));
    await reconcile();
    mock.timers.tick(5_000); // and if no spawn ran into it, it comes due now
    await eventually(() => spawned.length > 2);

    assert.equal(spawned.length, 2, "one restart, one worker");
  });

  it("reconcile coming round while a restart is still spawning starts no second worker", async () => {
    await armed();
    mock.timers.enable({ apis: ["setTimeout"] });
    latest().crash(1);

    // The restart fires and its spawn reads the grant store. A whole
    // reconcile pass runs in that await. The tenant is not in `children` yet
    // and its restart is no longer pending, so only the in-flight spawn
    // stands between that pass and a second worker.
    const read = duringNextGrantRead(() => reconcile());
    mock.timers.tick(5_000);
    await eventually(() => read.fired() && spawned.length > 1);
    await eventually(() => spawned.length > 2);

    assert.ok(read.fired(), "the restart's spawn read the grant store");
    assert.equal(spawned.length, 2, "one restart, one worker");
  });

  it("reconcile leaves a crashed child to its restart, so the ladder climbs to the ceiling", async () => {
    await armed();
    mock.timers.enable({ apis: ["setTimeout"] });
    // MAX_RESTARTS (8) restarts that each die at once, a reconcile pass in
    // every backoff. The pass used to respawn it at restart #0.
    for (let n = 1; n <= 8; n++) {
      latest().crash(1);
      await reconcile();
      assert.equal(spawned.length, n, `pass ${n} left the crashed child to its restart`);
      mock.timers.tick(30_000);
      await eventually(() => spawned.length === n + 1);
      assert.equal(spawned.length, n + 1, `restart ${n}`);
    }
    latest().crash(1); // the ninth quick death: the policy gives up
    await reconcile();
    mock.timers.tick(60_000);
    await eventually(() => spawned.length > 9);
    assert.equal(spawned.length, 9, "given up: neither the timer nor reconcile respawns it for the cool-off");
  });

  it("a watchdog kill leaves one restart behind: the watchdog's, on its ladder", async () => {
    await armed();
    // The watchdog judges a child by its age, so the clock is mocked too.
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    // Past the first-beat grace (90 s + the 60 s tick) with no heartbeat on disk.
    mock.timers.tick(10 * 60_000);
    const wedged = latest();
    watchdog();
    assert.equal(wedged.signalCode, "SIGKILL", "the watchdog killed it");
    await eventually(() => wedged.exited);
    assert.ok(wedged.exited, "and its exit handler has run");

    // The watchdog's restart is #1, due in 2 s. The killed child's exit
    // handler used to add #0, due in 1 s, which fired first.
    mock.timers.tick(1_500);
    await eventually(() => spawned.length > 1);
    assert.equal(spawned.length, 1, "nothing restarts it before the watchdog's backoff");

    mock.timers.tick(1_000);
    await eventually(() => spawned.length > 1);
    assert.equal(spawned.length, 2, "the watchdog's restart");
  });
});
