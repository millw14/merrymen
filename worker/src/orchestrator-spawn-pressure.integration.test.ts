/** A failed OS fork must not crash the supervisor or launch two traders. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";

const fleet = mkdtempSync(path.join(os.tmpdir(), "merrymen-spawn-pressure-"));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 17).toString("base64");

const { adoptHolderForTest, childHome, reconcile, setSpawnForTest, setSpawnPacingForTest } = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const tenant = "0x0000000000000000000000000000000000000e17" as const;
const account = "0x0000000000000000000000000000000000000e18" as const;
const now = Math.floor(Date.now() / 1000);
const grant = {
  smartAccount: account,
  owner: "0x0000000000000000000000000000000000000e19",
  sessionKeyAddress: "0x0000000000000000000000000000000000000e20",
  serialized: "eyJ-a-spawn-pressure",
  chainId: 4663,
  grantedAt: now - 60,
  expiresAt: now + 7 * 86_400,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"],
  grantTokens: [],
  demoSessionPrivateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
} as unknown as StoredGrant;

class FakeProc extends EventEmitter {
  readonly stdout = null;
  readonly stderr = null;
  constructor(readonly pid: number | undefined) { super(); }
  kill(): boolean {
    setImmediate(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}

const spawned: FakeProc[] = [];
const said: string[] = [];
const realLog = console.log;
console.log = (...parts: unknown[]) => said.push(parts.map(String).join(" "));
setSpawnPacingForTest(20, 60);
setSpawnForTest(() => {
  const proc = new FakeProc(spawned.length === 0 ? undefined : 41_000);
  spawned.push(proc);
  if (proc.pid === undefined) {
    setImmediate(() => proc.emit("error", Object.assign(new Error("resource unavailable"), { code: "EAGAIN" })));
  }
  return proc as unknown as ChildProcess;
});

after(() => {
  console.log = realLog;
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it("backs off EAGAIN, tolerates error plus exit, and starts one replacement", async () => {
  await getGrantStore().put(tenant, grant);
  await reconcile();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(spawned.length, 1);
  assert.ok(said.some((line) => line.includes("process creation refused (EAGAIN)")));
  assert.equal(said.filter((line) => line.includes("rallying again")).length, 1);

  // Node normally emits no exit after a failed fork. If a test double or a
  // runtime does emit both, the first event still owns the restart.
  spawned[0]!.emit("exit", null, null);
  assert.equal(said.filter((line) => line.includes("rallying again")).length, 1);
  await reconcile();
  assert.equal(spawned.length, 1, "the pending restart owns this tenant");

  const deadline = Date.now() + 4_000;
  while (spawned.length < 2 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(spawned.length, 2, "the retry reaches a healthy process after backoff");
  assert.equal(spawned[1]!.pid, 41_000);

  await getGrantStore().remove(tenant);
  await reconcile();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

it("reserves process slots for unexpired grants and counts a held process", async () => {
  const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
  setSpawnPacingForTest(0, 0);
  spawned.length = 0;
  said.length = 0;
  setSpawnForTest(() => {
    const proc = new FakeProc(42_000 + spawned.length);
    spawned.push(proc);
    return proc as unknown as ChildProcess;
  });

  const heldTenant = address(0xf00);
  const heldProc = new FakeProc(43_000);
  const activeTenants = Array.from({ length: 48 }, (_, i) => address(0xf01 + i));
  const expiredTenants = [address(0xf80), address(0xf81)];
  for (const [i, t] of [heldTenant, ...activeTenants, ...expiredTenants].entries()) {
    await getGrantStore().put(t, {
      ...grant,
      smartAccount: address(0x1000 + i),
      expiresAt: expiredTenants.includes(t) ? now - 1 : now + 86_400,
    });
  }
  await adoptHolderForTest(heldTenant, address(0x1000), heldProc as unknown as ChildProcess);
  const marker = path.join(childHome(expiredTenants[0]!), "preserve-me");
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, "stored grant, not revoked");

  await reconcile();
  assert.equal(spawned.length, 47, "the holder plus 47 workers reach the 48-process cap");
  assert.ok(said.some((line) => line.includes("49 unexpired, 2 expired")), "expiry is reflected in the fleet roster");
  assert.ok(said.some((line) => line.includes("1 unexpired grants deferred")), "capacity loss is an explicit alert");
  assert.ok(existsSync(marker), "an expired grant is not treated as revoked or wiped");
  for (const t of expiredTenants) assert.ok(await getGrantStore().get(t), "the signed grant stays stored for re-sign and recovery");

  for (const t of [heldTenant, ...activeTenants, ...expiredTenants]) await getGrantStore().remove(t);
  await reconcile();
  await new Promise<void>((resolve) => setImmediate(resolve));
});
