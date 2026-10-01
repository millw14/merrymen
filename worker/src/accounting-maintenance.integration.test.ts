import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import type { Db } from "./db";
import { planReconstruction } from "./accounting-reconstruction";
import { accountingHoldTenants, runAccountingReconstructionAtStartup } from "./accounting-maintenance";

const fleet = mkdtempSync(path.join(os.tmpdir(), "merrymen-accounting-maintenance-"));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 19).toString("base64");
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
const { reconcile, childHome, setSpawnForTest, setSpawnPacingForTest, setPaperRestoreForTest, runAccountingRepairForTest } = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore } = await import("./settings-store");
const TENANT = "0x00000000000000000000000000000000000000a8" as const;
const OTHER = "0x00000000000000000000000000000000000000a9" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000c8" as const;
const grant = (account: `0x${string}` = ACCOUNT): StoredGrant => ({
  smartAccount: account, owner: TENANT, sessionKeyAddress: "0x00000000000000000000000000000000000000d8",
  serialized: "maintenance-test-serialized-permission", chainId: 4663,
  grantedAt: Math.floor(Date.now() / 1000) - 3600, expiresAt: Math.floor(Date.now() / 1000) + 86_400,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 5, expiryDays: 1 }, grantFeatures: ["tradeable-v2"], grantTokens: [],
  demoSessionPrivateKey: ("0x" + "cd".repeat(32)) as `0x${string}`,
}) as unknown as StoredGrant;
class FakeProc extends EventEmitter {
  readonly pid = 70001;
  readonly stdout = null;
  readonly stderr = null;
  gone = false;
  constructor(readonly home: string, readonly hold: boolean) { super(); }
  die() { if (!this.gone) { this.gone = true; this.emit("exit", 1, null); } }
  kill() { setImmediate(() => this.die()); return true; }
}
const spawned: FakeProc[] = [];
setSpawnForTest((_command, args, options) => {
  const process = new FakeProc(String(options.env?.MERRYMEN_HOME), args.some((arg) => arg.endsWith("telegram-hold.ts")));
  spawned.push(process);
  return process as unknown as ChildProcess;
});
setSpawnPacingForTest(0, 0);
setPaperRestoreForTest(async () => ({ ok: true, line: "isolated test restore" }));
const store = getGrantStore();
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const output: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
afterEach(async () => {
  delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
  delete process.env.MERRYMEN_REPAIR;
  delete process.env.MERRYMEN_REPAIR_ACCOUNT;
  await store.remove(TENANT);
  await store.remove(OTHER);
  await reconcile();
  await settle();
  rmSync(childHome(TENANT), { recursive: true, force: true });
  rmSync(childHome(OTHER), { recursive: true, force: true });
  spawned.length = 0;
  output.length = 0;
  setPaperRestoreForTest(async () => ({ ok: true, line: "isolated test restore" }));
});
after(() => { console.log = originalLog; rmSync(fleet, { recursive: true, force: true }); });

it("mixed roster: only the named tenant stays absent, including a second reconcile", async () => {
  await store.put(TENANT, grant());
  await store.put(OTHER, grant(OTHER));
  await getSettingsStore().put(TENANT, { paperTradingEnabled: true, telegramEnabled: false } as never);
  const before = await store.get(TENANT);
  process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TENANT;
  await reconcile();
  await reconcile();
  assert.deepEqual(spawned.map((child) => child.home), [childHome(OTHER)]);
  assert.equal(existsSync(childHome(TENANT)), false, "no settings, bootstrap, ledger or holder files created");
  assert.deepEqual(await store.get(TENANT), before, "grant and signed caps untouched");
});

it("an unrelated tenant starts while held-account reconstruction is still pending", async () => {
  await store.put(TENANT, grant());
  await store.put(OTHER, grant(OTHER));
  process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TENANT;
  let finish!: () => void;
  let scanning = false;
  let finished = false;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  try {
    await runAccountingReconstructionAtStartup({
      heldTenants: accountingHoldTenants(process.env),
      reconstruct: async () => { scanning = true; await pending; finished = true; },
      onError: (error) => assert.fail(String(error)),
    });
    await reconcile();
    assert.equal(scanning, true);
    assert.equal(finished, false, "the expensive scan is still in progress");
    assert.deepEqual(spawned.map((child) => child.home), [childHome(OTHER)]);
    assert.equal(existsSync(childHome(TENANT)), false);
  } finally { finish(); await settle(); }
});

it("held tenant's existing ledger and grant are preserved instead of treated as revoked", async () => {
  await store.put(TENANT, grant());
  const before = await store.get(TENANT);
  mkdirSync(childHome(TENANT), { recursive: true });
  const file = path.join(childHome(TENANT), "merrymen.db");
  const original = Buffer.from("existing-accounting-ledger-must-not-be-opened-or-rewritten");
  writeFileSync(file, original);
  process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TENANT;
  await reconcile();
  assert.equal(spawned.length, 0);
  assert.deepEqual(readFileSync(file), original);
  assert.deepEqual(await store.get(TENANT), before);
});

it("a restart scheduled before maintenance cannot start the target afterward", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await store.put(TENANT, grant());
  await reconcile();
  assert.equal(spawned.length, 1);
  spawned[0]!.die();
  process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TENANT;
  context.mock.timers.tick(1001);
  await settle();
  assert.equal(spawned.length, 1, "direct restart callback reaches the early maintenance gate");
  await reconcile();
  assert.equal(spawned.length, 1);
});

it("maintenance introduced during spawn preparation blocks the holder path", async () => {
  await store.put(TENANT, grant());
  await getSettingsStore().put(TENANT, { paperTradingEnabled: true, telegramEnabled: false } as never);
  setPaperRestoreForTest(async () => {
    process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TENANT;
    return { ok: false, reason: "paper fills are newer than the recoverable valuation" };
  });
  await reconcile();
  assert.equal(spawned.length, 0, "failed restore cannot start a holder beside maintenance");
});

it("a successful restore still cannot start a worker after maintenance began during preparation", async () => {
  await store.put(TENANT, grant());
  setPaperRestoreForTest(async () => {
    process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TENANT;
    return { ok: true, line: "restore completed after the hold was set" };
  });
  await reconcile();
  assert.equal(spawned.length, 0, "last check before process creation sees the maintenance hold");
});

it("introducing maintenance stands down only its existing child and keeps both grants", async () => {
  await store.put(TENANT, grant());
  await store.put(OTHER, grant(OTHER));
  await reconcile();
  assert.equal(spawned.length, 2);
  process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TENANT;
  await reconcile();
  await settle();
  assert.equal(spawned.find((child) => child.home === childHome(TENANT))!.gone, true);
  assert.equal(spawned.find((child) => child.home === childHome(OTHER))!.gone, false);
  assert.ok(await store.get(TENANT));
  assert.ok(await store.get(OTHER));
});

it("malformed maintenance configuration rejects reconcile before any process or home is created", async () => {
  await store.put(TENANT, grant());
  await store.put(OTHER, grant(OTHER));
  process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = `${TENANT},invalid`;
  await assert.rejects(() => reconcile(), /refusing a partial hold/);
  assert.equal(spawned.length, 0);
  assert.equal(existsSync(childHome(TENANT)), false);
  assert.equal(existsSync(childHome(OTHER)), false);
  assert.ok(await store.get(TENANT));
  assert.ok(await store.get(OTHER));
});

it("the actual commit entry point refuses missing hold and retained local state before touching the database", async () => {
  const plans = planReconstruction({ agents: [{ smart_account: ACCOUNT, epoch: 1, mode: "live" }], flows: [],
    equityByAccountEpoch: new Map(), chain: new Map(), onchainCash: new Map(), tenantByAccount: new Map([[ACCOUNT, TENANT]]) });
  let accesses = 0;
  const forbidden = () => { accesses++; throw new Error("commit must not touch this database"); };
  const db = { prepare: forbidden, exec: forbidden, tx: forbidden } as unknown as Db;
  process.env.MERRYMEN_REPAIR = "commit";
  process.env.MERRYMEN_REPAIR_ACCOUNT = ACCOUNT;
  await runAccountingRepairForTest(db, plans);
  assert.match(output.join("\n"), /must be explicitly held/);
  assert.equal(accesses, 0);
  output.length = 0;
  process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TENANT;
  mkdirSync(childHome(TENANT), { recursive: true });
  await runAccountingRepairForTest(db, plans);
  assert.match(output.join("\n"), /fresh container/);
  assert.equal(accesses, 0);
});
