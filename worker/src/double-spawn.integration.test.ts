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
 * MERRYMEN_HOME is per process (node --test forks per file), so this never
 * leaks into another test file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-double-spawn-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
// The file stores and the no-op lease: no Postgres in this test.
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");

const { reconcile, childHome, fleetHaltFile, setSpawnForTest } = await import("./orchestrator");
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
    // the kill() that caused it.
    if (!this.gone) setImmediate(() => this.die(null));
    return true;
  }
  /** The process ending, for any reason. Once only, as a real one does. */
  die(code: number | null): void {
    if (this.gone) return;
    this.gone = true;
    this.emit("exit", code, null);
  }
}

const spawned: FakeProc[] = [];
setSpawnForTest(() => {
  const p = new FakeProc();
  spawned.push(p);
  return p as unknown as ChildProcess;
});

/**
 * Hold spawnChild at its settings read. While the gate is closed, every
 * `get` waits; `reached` resolves when the first one arrives.
 */
let gate: { reached: Promise<void>; wait: () => Promise<void>; open: () => void } | null = null;
function closeGate() {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (arrive = r));
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
  });
});
