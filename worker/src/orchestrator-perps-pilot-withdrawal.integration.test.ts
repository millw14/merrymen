/** Admission withdrawal must reach an already-running paper worker during a store outage. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
  readonly entriesAtFork: unknown;
  gone = false;
  constructor(readonly env: NodeJS.ProcessEnv) {
    super();
    this.entriesAtFork = JSON.parse(readFileSync(path.join(String(env.MERRYMEN_HOME), "settings.json"), "utf8")).perpsEnabled;
  }
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

async function prepareEnabled() {
  process.env.MERRYMEN_PERPS_PAPER_TENANTS = owner;
  const secret = `0x${"42".repeat(32)}` as `0x${string}`;
  const now = Math.floor(Date.now() / 1000);
  await grants.put(owner, { owner, smartAccount: account, purpose: "perps", chainId: 4663,
    sessionKeyAddress: privateKeyToAccount(secret).address, demoSessionPrivateKey: secret, serialized: "test-pilot-withdrawal",
    grantedAt: now - 60, expiresAt: now + 3600,
    caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 4 },
    grantFeatures: ["tradeable-v2"], grantTokens: [] } as StoredGrant);
  await settings.perps.put(owner, risk);
}

async function startEnabled() {
  await prepareEnabled();
  await orch.reconcile(); await settle();
  const trader = spawned.find(p => p.env.MERRYMEN_HOME === orch.childHome(workerKey) && !p.gone);
  assert.ok(trader, "an admitted worker starts");
  assert.equal(childSettings().perpsEnabled, true);
  return { trader, before: childSettings() };
}

afterEach(async () => {
  orch.setRetirementMirrorForTest(null);
  orch.setPaperRestoreForTest(async () => ({ ok: true, line: null }));
  orch.resetDrainForTest();
  useSettingsStoreForTest(settings.spot, "spot"); useSettingsStoreForTest(settings.perps, "perps");
  await grants.remove(owner); await orch.reconcile(); await settle();
  for (const dir of ["children", "children-perps", "tenants-perps", "tenant-settings", "tenant-settings-perps"])
    rmSync(path.join(fleet, dir), { recursive: true, force: true });
  spawned.length = 0;
});

/** Only settings publication fails: grant, ledger and other preparation still work. */
function refuseSettingsRename(): () => void {
  const original = fs.renameSync;
  const file = path.join(orch.childHome(workerKey), "settings.json");
  fs.renameSync = ((from, to) => {
    if (String(to) === file) throw Object.assign(new Error("settings publication refused"), { code: "EACCES" });
    return original(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  return () => { fs.renameSync = original; syncBuiltinESMExports(); };
}
after(() => {
  orch.setLeaseAcquireForTest(null); orch.setPaperRestoreForTest(null); orch.setPerpsFeedStartForTest(null);
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("cold withdrawal refuses an unreadable risk file without a trusted parent snapshot", async () => {
  await prepareEnabled();
  delete process.env.MERRYMEN_PERPS_PAPER_TENANTS;
  const home = orch.childHome(workerKey), file = path.join(home, "settings.json");
  mkdirSync(home, { recursive: true });
  writeFileSync(file, "{broken risk settings");
  await orch.reconcile(); await settle();
  assert.equal(spawned.length, 0);
  assert.equal(readFileSync(file, "utf8"), "{broken risk settings", "unreadable protection settings are preserved for repair");
  assert.ok(await grants.get(owner));
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

test("failed off delivery stops the running worker and retains its lease until final accounting succeeds", async () => {
  const { trader, before } = await startEnabled();
  const book = path.join(orch.childHome(workerKey), "merrymen.db");
  writeFileSync(book, "original book retained for final copy");
  let mirrors = 0;
  orch.setRetirementMirrorForTest(async () => { mirrors++; return false; });
  delete process.env.MERRYMEN_PERPS_PAPER_TENANTS;
  const restore = refuseSettingsRename();
  try { await orch.reconcile(); await settle(); } finally { restore(); }
  assert.ok(trader.signals.includes("SIGTERM"), "a worker retaining enabled settings must be stopped");
  assert.equal(trader.gone, true);
  assert.deepEqual(childSettings(), before, "the failed write did not pretend to turn the file off");
  assert.equal(orch.hasLeaseForTest(workerKey), true, "the final accounting lease is retained");
  writeFileSync(path.join(orch.childHome(workerKey), "settings.json"), JSON.stringify({ ...before, perpsEnabled: false }));
  await orch.reconcile(); await settle();
  assert.ok(mirrors > 0, "the existing retired-worker accounting path is retried");
  assert.equal(spawned.length, 1, "even a repaired off file cannot bypass incomplete final accounting");
  assert.equal(orch.hasLeaseForTest(workerKey), true);
  assert.equal(readFileSync(book, "utf8"), "original book retained for final copy");
  assert.ok(await grants.get(owner), "stand-down does not revoke the owner's grant");
});

test("cold preparation cannot fork from an old enabled file when off publication fails, and retries after repair", async () => {
  await prepareEnabled();
  delete process.env.MERRYMEN_PERPS_PAPER_TENANTS;
  const home = orch.childHome(workerKey);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "settings.json"), JSON.stringify(risk));
  const restore = refuseSettingsRename();
  try {
    await orch.reconcile(); await settle();
    assert.equal(spawned.length, 0, "settings-only write failure blocks the fork");
    assert.ok(existsSync(path.join(home, "grant.json")), "the grant write succeeded; it did not mask the settings failure");
    assert.equal(childSettings().perpsEnabled, true);
  } finally { restore(); }
  await orch.reconcile(); await settle();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.entriesAtFork, false);
  assert.equal(childSettings().perpsStopLossPct, risk.perpsStopLossPct);
});

for (const publicationFails of [false, true]) {
  test(`withdrawal during spawn preparation is enforced at fork when publication ${publicationFails ? "fails" : "succeeds"}`, async () => {
    await prepareEnabled();
    let restore = () => {};
    orch.setPaperRestoreForTest(async () => {
      assert.equal(childSettings().perpsEnabled, true, "the initial settings write happened while admitted");
      delete process.env.MERRYMEN_PERPS_PAPER_TENANTS;
      if (publicationFails) restore = refuseSettingsRename();
      return { ok: true, line: null };
    });
    try {
      await orch.reconcile(); await settle();
      assert.equal(spawned.length, publicationFails ? 0 : 1);
      if (!publicationFails) assert.equal(spawned[0]!.entriesAtFork, false, "the child never observes enabled settings after withdrawal");
    } finally { restore(); }
  });
}

test("shutdown final-copies a worker stopped for failed off delivery before the next reconcile", async () => {
  await startEnabled();
  writeFileSync(path.join(orch.childHome(workerKey), "merrymen.db"), "original book awaiting final copy");
  delete process.env.MERRYMEN_PERPS_PAPER_TENANTS;
  const restore = refuseSettingsRename();
  try { await orch.reconcile(); await settle(); } finally { restore(); }
  assert.equal(spawned.filter(p => !p.gone).length, 0);
  let mirrors = 0;
  orch.setRetirementMirrorForTest(async tenant => { assert.equal(tenant, workerKey); mirrors++; return true; });
  const exits: number[] = [];
  await orch.drainFleetForTest("SIGTERM", {
    budgetMs: 5_000,
    limits: { hooksMs: 100, settleMs: 100, exitWaitMs: 100, killGraceMs: 100, pendingKillsMs: 100, finalPassMinMs: 0, reserveMs: 50, pollMs: 5 },
    exit: code => { exits.push(code); },
  });
  assert.deepEqual(exits, [0]);
  assert.equal(mirrors, 1, "the stopped home remains in the shutdown accounting set");
});
