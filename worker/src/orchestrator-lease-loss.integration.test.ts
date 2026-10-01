/** A lost lease socket signals the child now and bars a local re-arm until exit. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it, mock } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import type { TenantLease } from "./tenant-lease";

const fleet = mkdtempSync(path.join(os.tmpdir(), "merrymen-lease-loss-"));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 11).toString("base64");

const {
  adoptChildForTest,
  hasLeaseForTest,
  reconcile,
  setSpawnForTest,
  standDownLostLeasesForTest,
  watchdog,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");

after(() => rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const TENANT = "0x0000000000000000000000000000000000000a17" as const;
const WATCHDOG_TENANT = "0x0000000000000000000000000000000000000a18" as const;
const FAIL_TENANT = "0x0000000000000000000000000000000000000a19" as const;
const OTHER_TENANT = "0x0000000000000000000000000000000000000a1a" as const;
const ACCOUNT = "0x0000000000000000000000000000000000000b17" as const;
const WATCHDOG_ACCOUNT = "0x0000000000000000000000000000000000000b18" as const;
const now = Math.floor(Date.now() / 1000);
const grant = {
  smartAccount: ACCOUNT,
  owner: "0x0000000000000000000000000000000000000c17",
  sessionKeyAddress: "0x0000000000000000000000000000000000000d17",
  serialized: "eyJ-a-zerodev-lease-loss",
  chainId: 4663,
  grantedAt: now - 3600,
  expiresAt: now + 7 * 86_400,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"],
  grantTokens: [],
  demoSessionPrivateKey: ("0x" + "cd".repeat(32)) as `0x${string}`,
} as unknown as StoredGrant;

class FakeProc extends EventEmitter {
  readonly pid = 60617;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  failTerm = false;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    if (this.failTerm && signal === "SIGTERM") throw new Error("simulated SIGTERM failure");
    return true;
  }
}

it("signals immediately and does not reacquire before the old child exits", async () => {
  await getGrantStore().put(TENANT, grant);
  let healthy = true;
  let releases = 0;
  const lease: TenantLease = {
    tenant: TENANT,
    backend: "postgres",
    healthy: () => healthy,
    async release() { releases++; },
  };
  const old = new FakeProc();
  const spawned: FakeProc[] = [];
  setSpawnForTest(() => {
    const proc = new FakeProc();
    spawned.push(proc);
    return proc as unknown as ChildProcess;
  });
  adoptChildForTest(TENANT, ACCOUNT, old, lease);
  assert.equal(hasLeaseForTest(TENANT), true);

  healthy = false;
  standDownLostLeasesForTest();
  assert.deepEqual(old.signals, ["SIGTERM"], "the socket callback signals in the same turn");
  assert.equal(hasLeaseForTest(TENANT), false, "the lost lock cannot claim protection");
  assert.equal(releases, 1);

  await reconcile();
  assert.equal(spawned.length, 0, "a new lock and child cannot start beside the exiting child");
  assert.equal(hasLeaseForTest(TENANT), false, "the spawn barrier precedes reacquisition");

  old.emit("exit", 0, "SIGTERM");
  await reconcile();
  assert.equal(spawned.length, 1, "this replica may re-arm only after the old child exits");
  assert.equal(hasLeaseForTest(TENANT), true);

  await getGrantStore().remove(TENANT);
  await reconcile();
  spawned[0]!.emit("exit", 0, "SIGTERM");
});

it("also waits for a watchdog-killed child already removed from the active map", async () => {
  await getGrantStore().put(WATCHDOG_TENANT, { ...grant, smartAccount: WATCHDOG_ACCOUNT });
  let healthy = true;
  const lease: TenantLease = {
    tenant: WATCHDOG_TENANT,
    backend: "postgres",
    healthy: () => healthy,
    async release() {},
  };
  const old = new FakeProc();
  const spawned: FakeProc[] = [];
  setSpawnForTest(() => {
    const proc = new FakeProc();
    spawned.push(proc);
    return proc as unknown as ChildProcess;
  });
  adoptChildForTest(WATCHDOG_TENANT, WATCHDOG_ACCOUNT, old, lease);
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 1_000_000 });
  try {
    watchdog();
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(old.signals, ["SIGKILL"]);

  healthy = false;
  standDownLostLeasesForTest();
  await reconcile();
  assert.equal(spawned.length, 0, "the old process still blocks a local re-arm");
  assert.equal(hasLeaseForTest(WATCHDOG_TENANT), false);

  old.emit("exit", 0, "SIGKILL");
  await reconcile();
  assert.equal(spawned.length, 1, "re-arm follows the old process exit");
  await getGrantStore().remove(WATCHDOG_TENANT);
  await reconcile();
  spawned[0]!.emit("exit", 0, "SIGTERM");
});

it("continues standing down the shard when one child refuses SIGTERM", () => {
  const first = new FakeProc();
  first.failTerm = true;
  const second = new FakeProc();
  const lost = (tenant: `0x${string}`): TenantLease => ({
    tenant,
    backend: "postgres",
    healthy: () => false,
    async release() {},
  });
  adoptChildForTest(FAIL_TENANT, ACCOUNT, first, lost(FAIL_TENANT));
  adoptChildForTest(OTHER_TENANT, ACCOUNT, second, lost(OTHER_TENANT));
  standDownLostLeasesForTest();
  assert.deepEqual(first.signals.slice(0, 2), ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(second.signals, ["SIGTERM"], "the other tenant is signaled in the same callback");
  assert.equal(hasLeaseForTest(FAIL_TENANT), false);
  assert.equal(hasLeaseForTest(OTHER_TENANT), false);
  first.emit("exit", 0, "SIGKILL");
  second.emit("exit", 0, "SIGTERM");
});

it("retries lease-loss shutdown before an unavailable grant-store read", async () => {
  const tenant = "0x0000000000000000000000000000000000000a1b" as const;
  const old = new FakeProc();
  adoptChildForTest(tenant, ACCOUNT, old, {
    tenant,
    backend: "postgres",
    healthy: () => false,
    async release() {},
  });
  const store = getGrantStore();
  const fail = async () => {
    assert.deepEqual(old.signals, ["SIGTERM"], "shutdown happened before entering the database await");
    throw new Error("simulated grant-store outage");
  };
  const previousExpiries = store.listTenantExpiries;
  const previousTenants = store.listTenants;
  if (previousExpiries) store.listTenantExpiries = fail;
  else store.listTenants = fail;
  try {
    await reconcile();
    assert.equal(hasLeaseForTest(tenant), false);
    assert.deepEqual(old.signals, ["SIGTERM"]);
  } finally {
    store.listTenantExpiries = previousExpiries;
    store.listTenants = previousTenants;
    old.emit("exit", 0, "SIGTERM");
  }
});
