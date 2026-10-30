/** Admission withdrawal must reach an already-running paper worker during a store outage. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import type { MerrymenSettings, StoredGrant } from "../../packages/core/src/index";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "perps-pilot-withdrawal-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_PERPS = "paper";
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 42).toString("base64");
for (const key of ["DATABASE_URL", "MERRYMEN_ACCOUNTING_HOLD_TENANTS", "MERRYMEN_FLEET_RECOVERY_REPORT_ONLY",
  "MERRYMEN_PERSISTENT_HOME_REQUIRED", "MERRYMEN_FLEET_ROLLOUT", "MERRYMEN_ROLLOUT_NEW_TENANTS"]) delete process.env[key];
for (const key of Object.keys(process.env)) if (key.startsWith("RAILWAY_")) delete process.env[key];

const orch = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore, useSettingsStoreForTest } = await import("./settings-store");
const { acquireTenantLease } = await import("./tenant-lease");
const grants = getGrantStore("perps");
const settings = { spot: getSettingsStore("spot"), perps: getSettingsStore("perps") };
const owner = "0x2222222222222222222222222222222222222222";
const account = "0x3333333333333333333333333333333333333333";
const workerKey = `${owner}:perps`;
const childSettings = () => JSON.parse(readFileSync(path.join(orch.childHome(workerKey), "settings.json"), "utf8")) as MerrymenSettings;
const risk: MerrymenSettings = { perpsEnabled: true, perpsMarkets: ["SOL-PERP"], perpsMaxLeverage: 1,
  perpsStopLossPct: 2, perpsTakeProfitPct: 9, perpsLiqBufferPct: 4, perpsMaxOpenNotionalUsdg: 30, perpsDriver: "manual" };
const spawned: FakeProc[] = [];
class FakeProc extends EventEmitter {
  static next = 97_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  gone = false;
  constructor(readonly env: NodeJS.ProcessEnv) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal ?? "SIGTERM"));
    setImmediate(() => { if (!this.gone) { this.gone = true; this.emit("exit", null, "SIGTERM"); } });
    return true;
  }
}
const settle = async () => { for (let i = 0; i < 35; i++) await new Promise(resolve => setImmediate(resolve)); };
orch.setSpawnForTest((_command: string, _args: readonly string[], options: SpawnOptions) => {
  const proc = new FakeProc(options.env ?? {}); spawned.push(proc); return proc as unknown as ChildProcess;
});
orch.setSpawnPacingForTest(0, 0);
orch.setLeaseAcquireForTest(acquireTenantLease);
orch.setPaperRestoreForTest(async () => ({ ok: true, line: null }));
orch.setPerpsFeedStartForTest(() => ({ stop() {} }));

async function startEnabled() {
  process.env.MERRYMEN_PERPS_PAPER_TENANTS = owner;
  const secret = `0x${"42".repeat(32)}` as `0x${string}`;
  const now = Math.floor(Date.now() / 1000);
  await grants.put(owner, { owner, smartAccount: account, purpose: "perps", chainId: 4663,
    sessionKeyAddress: privateKeyToAccount(secret).address, demoSessionPrivateKey: secret, serialized: "test-pilot-withdrawal",
    grantedAt: now - 60, expiresAt: now + 3600,
    caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 4 },
    grantFeatures: ["tradeable-v2"], grantTokens: [] } as StoredGrant);
  await settings.perps.put(owner, risk);
  await orch.reconcile(); await settle();
  const trader = spawned.find(p => p.env.MERRYMEN_HOME === orch.childHome(workerKey) && !p.gone);
  assert.ok(trader, "an admitted worker starts");
  assert.equal(childSettings().perpsEnabled, true);
  return { trader, before: childSettings() };
}

afterEach(async () => {
  useSettingsStoreForTest(settings.spot, "spot"); useSettingsStoreForTest(settings.perps, "perps");
  await grants.remove(owner); await orch.reconcile(); await settle();
  for (const dir of ["children", "children-perps", "tenants-perps", "tenant-settings", "tenant-settings-perps"])
    rmSync(path.join(fleet, dir), { recursive: true, force: true });
  spawned.length = 0;
});
after(() => {
  orch.setLeaseAcquireForTest(null); orch.setPaperRestoreForTest(null); orch.setPerpsFeedStartForTest(null);
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

for (const unavailable of ["perps", "spot"] as const) {
  test(`withdrawing pilot admission turns entries off despite an unread ${unavailable} settings store`, async () => {
    const { trader, before } = await startEnabled();
    delete process.env.MERRYMEN_PERPS_PAPER_TENANTS;
    const entrySwitchAtReads: unknown[] = [];
    useSettingsStoreForTest({ get: async () => {
      entrySwitchAtReads.push(childSettings().perpsEnabled);
      throw new Error("settings unavailable");
    } } as never, unavailable);
    await orch.reconcile(); await settle();
    assert.deepEqual(childSettings(), { ...before, perpsEnabled: false }, "only new-entry permission changes; markets and protective risk settings survive");
    assert.deepEqual(trader.signals, [], "the same worker continues serving exits and stops");
    assert.equal((await settings.perps.get(owner))?.perpsEnabled, true, "admission does not rewrite the owner's stored switch");
    if (unavailable === "perps") {
      assert.ok(entrySwitchAtReads.length > 0);
      assert.ok(entrySwitchAtReads.every(value => value === false), "entry permission is removed before awaiting Perps settings");
    }
  });
}

test("withdrawal during a failed settings read still disables the existing child", async () => {
  const { before } = await startEnabled();
  useSettingsStoreForTest({ get: async () => {
    delete process.env.MERRYMEN_PERPS_PAPER_TENANTS;
    throw new Error("settings unavailable after withdrawal");
  } } as never, "perps");
  await orch.reconcile(); await settle();
  assert.deepEqual(childSettings(), { ...before, perpsEnabled: false });
});
