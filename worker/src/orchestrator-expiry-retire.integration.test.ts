/** Expiry retires an existing process without losing its local ledger or re-sign authority. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import type { TenantLease } from "./tenant-lease";

const fleet = mkdtempSync(path.join(os.tmpdir(), "merrymen-expiry-retire-"));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 19).toString("base64");

const {
  adoptChildForTest, adoptHolderForTest, childHome, hasLeaseForTest, isHeldForTest,
  isRetiringExpiredForTest, localChildProcessCountForTest, reconcile,
  setRetirementMirrorForTest, setSpawnForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const now = Math.floor(Date.now() / 1000);
const grantFor = (account: `0x${string}`, expiresAt: number) => ({
  smartAccount: account,
  owner: address(0xe91),
  sessionKeyAddress: address(0xe92),
  serialized: "eyJ-a-expiry-retire",
  chainId: 4663,
  grantedAt: now - 60,
  expiresAt,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"],
  grantTokens: [],
  demoSessionPrivateKey: (`0x${"ab".repeat(32)}`) as `0x${string}`,
}) as unknown as StoredGrant;

class FakeProc extends EventEmitter {
  readonly pid: number;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  constructor(pid: number) { super(); this.pid = pid; }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    return true;
  }
  exit(): void { this.emit("exit", 0, "SIGTERM"); }
}

const spawned: FakeProc[] = [];
setSpawnForTest(() => {
  const proc = new FakeProc(45_000 + spawned.length);
  spawned.push(proc);
  return proc as unknown as ChildProcess;
});

after(() => {
  setRetirementMirrorForTest(null);
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function leaseFor(tenant: `0x${string}`, releases: { n: number }): TenantLease {
  return { tenant, backend: "postgres", healthy: () => true, async release() { releases.n++; } };
}

it("waits for an expired worker's exit and final mirror before re-sign can use its home", async () => {
  const tenant = address(0xe11);
  const account = address(0xe12);
  const releases = { n: 0 };
  const old = new FakeProc(44_001);
  const marker = path.join(childHome(tenant), "keep-me");
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, "local history");
  await getGrantStore().put(tenant, grantFor(account, now - 1));
  adoptChildForTest(tenant, account, old, leaseFor(tenant, releases));
  let mirrors = 0;
  setRetirementMirrorForTest(async () => { mirrors++; return true; });

  const countBefore = localChildProcessCountForTest();
  await reconcile();
  assert.equal(old.signals[0], "SIGTERM");
  assert.equal(isRetiringExpiredForTest(tenant), true);
  assert.equal(hasLeaseForTest(tenant), true);
  assert.equal(localChildProcessCountForTest(), countBefore, "exiting process still occupies its cap slot");
  assert.equal(mirrors, 0, "sqlite cannot be read as final while its writer may still run");
  assert.ok(existsSync(marker));
  assert.ok(await getGrantStore().get(tenant), "expiry keeps the stored grant");

  await getGrantStore().put(tenant, grantFor(account, now + 86_400));
  await reconcile();
  assert.equal(spawned.length, 0, "a fresh signature cannot arm beside the old writer");
  assert.equal(releases.n, 0);

  old.exit();
  assert.equal(localChildProcessCountForTest(), countBefore - 1, "exit recovers the OS process slot");
  await reconcile();
  assert.equal(mirrors, 1);
  assert.equal(releases.n, 1, "lease leaves only after the final mirror");
  assert.equal(isRetiringExpiredForTest(tenant), false);
  assert.equal(spawned.length, 1, "re-signed grant starts after the barrier clears");
  assert.ok(existsSync(marker), "re-sign reuses the preserved home");

  await getGrantStore().remove(tenant);
  await reconcile();
  spawned[0]!.exit();
  setRetirementMirrorForTest(null);
});

it("keeps the lease and local barrier on mirror failure, then retries without losing the grant", async () => {
  const tenant = address(0xe21);
  const account = address(0xe22);
  const releases = { n: 0 };
  const old = new FakeProc(44_002);
  const marker = path.join(childHome(tenant), "keep-me");
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, "unmirrored rows");
  await getGrantStore().put(tenant, grantFor(account, now - 1));
  adoptChildForTest(tenant, account, old, leaseFor(tenant, releases));
  let succeeds = false;
  let mirrors = 0;
  setRetirementMirrorForTest(async () => { mirrors++; return succeeds; });

  await reconcile();
  old.exit();
  await reconcile();
  assert.equal(mirrors, 1);
  assert.equal(hasLeaseForTest(tenant), true);
  assert.equal(isRetiringExpiredForTest(tenant), true);
  assert.equal(releases.n, 0);
  assert.ok(existsSync(marker));

  await getGrantStore().put(tenant, grantFor(account, now + 86_400));
  await reconcile();
  assert.equal(spawned.length, 1, "re-sign remains blocked while mirror fails");
  assert.equal(hasLeaseForTest(tenant), true);
  succeeds = true;
  await reconcile();
  assert.equal(releases.n, 1);
  assert.equal(isRetiringExpiredForTest(tenant), false);
  assert.equal(spawned.length, 2, "retry succeeds and the re-signed worker arms");

  await getGrantStore().remove(tenant);
  await reconcile();
  spawned[1]!.exit();
  setRetirementMirrorForTest(null);
});

it("retires an expired hold only after its bot exits, without mirroring an unrestored practice book", async () => {
  const tenant = address(0xe31);
  const account = address(0xe32);
  const old = new FakeProc(44_003);
  const marker = path.join(childHome(tenant), "keep-me");
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, "held history");
  await getGrantStore().put(tenant, grantFor(account, now - 1));
  await adoptHolderForTest(tenant, account, old as unknown as ChildProcess);
  let mirrors = 0;
  setRetirementMirrorForTest(async () => { mirrors++; return true; });

  await reconcile();
  assert.equal(old.signals[0], "SIGTERM");
  assert.equal(isHeldForTest(tenant), true);
  assert.equal(hasLeaseForTest(tenant), true);
  await getGrantStore().put(tenant, grantFor(account, now + 86_400));
  await reconcile();
  assert.equal(spawned.length, 2, "new worker waits for the old bot's exit");
  old.exit();
  assert.equal(hasLeaseForTest(tenant), true, "expiry retirement owns the lease until its own settlement");
  await reconcile();
  assert.equal(isHeldForTest(tenant), false);
  assert.equal(isRetiringExpiredForTest(tenant), false);
  assert.equal(mirrors, 0, "an unrestored held practice book is never copied as a live snapshot");
  assert.equal(spawned.length, 3);
  assert.ok(existsSync(marker));

  await getGrantStore().remove(tenant);
  await reconcile();
  spawned[2]!.exit();
  setRetirementMirrorForTest(null);
});

it("recovers a process slot at the hard cap when an expired worker exits", async () => {
  const holders: { tenant: `0x${string}`; proc: FakeProc }[] = [];
  const account = address(0xe42);
  for (let i = 0; i < 47; i++) {
    const tenant = address(0xe50 + i);
    const proc = new FakeProc(46_000 + i);
    await getGrantStore().put(tenant, grantFor(address(0xf50 + i), now + 86_400));
    await adoptHolderForTest(tenant, address(0xf50 + i), proc as unknown as ChildProcess);
    holders.push({ tenant, proc });
  }
  const expired = address(0xe41);
  const queued = address(0xe43);
  const old = new FakeProc(44_004);
  await getGrantStore().put(expired, grantFor(account, now - 1));
  adoptChildForTest(expired, account, old, leaseFor(expired, { n: 0 }));
  await getGrantStore().put(queued, grantFor(address(0xe44), now + 86_400));
  setRetirementMirrorForTest(async () => true);
  assert.equal(localChildProcessCountForTest(), 48);
  const before = spawned.length;

  await reconcile();
  assert.equal(spawned.length, before, "an exiting expired worker still occupies the 48th slot");
  assert.equal(localChildProcessCountForTest(), 48);
  old.exit();
  await reconcile();
  assert.equal(spawned.length, before + 1, "the queued signed grant receives the freed slot");
  assert.equal(localChildProcessCountForTest(), 48);

  for (const { tenant } of holders) await getGrantStore().remove(tenant);
  await getGrantStore().remove(expired);
  await getGrantStore().remove(queued);
  await reconcile();
  for (const { proc } of holders) proc.exit();
  spawned.at(-1)!.exit();
  setRetirementMirrorForTest(null);
});
