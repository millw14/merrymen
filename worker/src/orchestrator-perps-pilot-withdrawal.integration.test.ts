/** Admission withdrawal must reach an already-running paper worker during a store outage. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
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

let pilotOwners: readonly `0x${string}`[] = [];
let pilotRevision = 0;
let pilotFailure = false;
let pilotPending: Promise<{ owners: readonly `0x${string}`[]; revision: number }> | null = null;
const readPilot = async () => {
  if (pilotPending) return pilotPending;
  if (pilotFailure) throw new Error("admission store unavailable");
  return { owners: pilotOwners, revision: pilotRevision };
};
beforeEach(() => {
  pilotFailure = false;
  pilotPending = null;
  pilotOwners = [];
  pilotRevision = 0;
  orch.setPerpsPilotAdmissionReaderForTest(readPilot);
});
async function setAdmission(allowed: boolean) {
  pilotOwners = allowed ? [owner] : [];
  pilotRevision++;
  assert.equal(await orch.refreshPerpsPilotAdmissionForTest(), true);
}

async function prepareEnabled() {
  await setAdmission(true);
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
  orch.setPerpsPilotAdmissionReaderForTest(null);
  orch.setLeaseAcquireForTest(null); orch.setPaperRestoreForTest(null); orch.setPerpsFeedStartForTest(null);
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("cold withdrawal refuses an unreadable risk file without a trusted parent snapshot", async () => {
  await prepareEnabled();
  await setAdmission(false);
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
    await setAdmission(false);
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
    await setAdmission(false);
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
  const restore = refuseSettingsRename();
  try { await setAdmission(false); await orch.reconcile(); await settle(); } finally { restore(); }
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
  await setAdmission(false);
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
      if (publicationFails) restore = refuseSettingsRename();
      await setAdmission(false);
      return { ok: true, line: null };
    });
    try {
      await orch.reconcile(); await settle();
      assert.equal(spawned.length, publicationFails ? 0 : 1);
      if (!publicationFails) assert.equal(spawned[0]!.entriesAtFork, false, "the child never observes enabled settings after withdrawal");
    } finally { restore(); }
  });
}


test("an admission-store outage forces entries off while keeping the worker, risk limits, and grant", async () => {
  const { trader, before } = await startEnabled();
  // An old bootstrap variable must never rescue a failed shared-store read.
  process.env.MERRYMEN_PERPS_PAPER_TENANTS = owner;
  pilotFailure = true;
  try {
    assert.equal(await orch.refreshPerpsPilotAdmissionForTest(), false);
    assert.deepEqual(childSettings(), { ...before, perpsEnabled: false });
    assert.deepEqual(trader.signals, []);
    assert.ok(await grants.get(owner));
  } finally { delete process.env.MERRYMEN_PERPS_PAPER_TENANTS; }
});

test("an unavailable admission store permits a cold exits-only worker from trustworthy settings", async () => {
  await prepareEnabled();
  pilotFailure = true;
  assert.equal(await orch.refreshPerpsPilotAdmissionForTest(), false);
  await orch.reconcile(); await settle();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.entriesAtFork, false);
  assert.equal(childSettings().perpsStopLossPct, risk.perpsStopLossPct);
  assert.deepEqual(childSettings().perpsMarkets, risk.perpsMarkets);
});

test("a hung admission read turns entries off independently of a hung Spot roster", async () => {
  orch.setPerpsPilotAdmissionReaderForTest(readPilot, { refreshMs: 5, maxAgeMs: 40, timeoutMs: 20 });
  const { trader, before } = await startEnabled();
  let releasePilot!: (snapshot: { owners: readonly `0x${string}`[]; revision: number }) => void;
  pilotPending = new Promise(resolve => { releasePilot = resolve; });
  const spotGrants = getGrantStore("spot"), original = spotGrants.listTenantExpiries!;
  let releaseRoster!: () => void;
  const rosterBlocked = new Promise<void>(resolve => { releaseRoster = resolve; });
  let entered = false;
  spotGrants.listTenantExpiries = async () => { entered = true; await rosterBlocked; return []; };
  const blockedReconcile = orch.reconcile();
  try {
    const deadline = Date.now() + 1_000;
    while (childSettings().perpsEnabled !== false && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(entered, true, "the main loop is waiting inside the Spot roster");
    assert.deepEqual(childSettings(), { ...before, perpsEnabled: false });
    assert.deepEqual(trader.signals, [], "protective exits retain their running worker");
    releasePilot({ owners: [owner], revision: pilotRevision });
    await settle();
    assert.equal(childSettings().perpsEnabled, false, "the timed-out response cannot restore entry permission");
  } finally {
    spotGrants.listTenantExpiries = original;
    releaseRoster();
    releasePilot({ owners: [owner], revision: pilotRevision });
    await blockedReconcile;
    pilotPending = null;
  }
});

test("permission expiring during preparation is rechecked synchronously at fork", async () => {
  let now = 0;
  orch.setPerpsPilotAdmissionReaderForTest(readPilot, { now: () => now, maxAgeMs: 100 });
  await prepareEnabled();
  orch.setPaperRestoreForTest(async () => {
    assert.equal(childSettings().perpsEnabled, true);
    now = 100; // No timer needs to run between this await and the final fork.
    return { ok: true, line: null };
  });
  await orch.reconcile(); await settle();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.entriesAtFork, false);
  assert.equal(childSettings().perpsMaxLeverage, risk.perpsMaxLeverage);
});

test("a newly positive snapshot alone does not turn worker entries on", async () => {
  await startEnabled();
  await setAdmission(false);
  assert.equal(childSettings().perpsEnabled, false);
  await setAdmission(true);
  assert.equal(childSettings().perpsEnabled, false, "only the normal settings path can enable entries");
});

test("a settings read started before revoke and re-admission cannot restore its stale enabled switch", async () => {
  const { trader, before } = await startEnabled();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  useSettingsStoreForTest({ get: async () => {
    const stale = await settings.perps.get(owner);
    entered();
    await blocked;
    return stale;
  } } as never, "perps");
  const reconciliation = orch.reconcile();
  try {
    await reading;
    // The admin's beforeAdmit hook writes the new off settings. Both cohort
    // changes land between polls, so the owner set itself is unchanged.
    await settings.perps.put(owner, { ...risk, perpsEnabled: false, perpsControlNonce: "fresh-admission" });
    pilotRevision += 2;
    await orch.refreshPerpsPilotAdmissionForTest();
    assert.deepEqual(childSettings(), { ...before, perpsEnabled: false }, "revision withdrawal reaches the running worker before any settings await completes");
    release();
    await reconciliation;
    assert.equal(childSettings().perpsEnabled, false, "the older true result is not valid under the new admission revision");
    assert.deepEqual(trader.signals, []);
  } finally { release(); await reconciliation; }
});

test("revoke and re-admit between polls cannot fork from the earlier enabled file", async () => {
  await prepareEnabled();
  orch.setPaperRestoreForTest(async () => {
    assert.equal(childSettings().perpsEnabled, true);
    await settings.perps.put(owner, { ...risk, perpsEnabled: false, perpsControlNonce: "fresh-admission" });
    pilotRevision += 2;
    await orch.refreshPerpsPilotAdmissionForTest();
    return { ok: true, line: null };
  });
  await orch.reconcile(); await settle();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.entriesAtFork, false, "unchanged membership never reuses a previous revision's enabled file");
  assert.equal(childSettings().perpsMaxLeverage, risk.perpsMaxLeverage);
});

test("children receive neither pilot role configuration nor the admission database", () => {
  const names = ["MERRYMEN_PERPS_PAPER_TENANTS", "MERRYMEN_PERPS_PILOT_ADMINS", "DATABASE_URL"] as const;
  const saved = names.map(name => process.env[name]);
  try {
    for (const name of names) process.env[name] = "parent-only";
    for (const key of [owner, workerKey]) {
      const env = orch.childEnv(key);
      for (const name of names) assert.equal(env[name], undefined, `${key}: ${name} is parent-only`);
    }
  } finally {
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
});

test("shutdown final-copies a worker stopped for failed off delivery before the next reconcile", async () => {
  await startEnabled();
  writeFileSync(path.join(orch.childHome(workerKey), "merrymen.db"), "original book awaiting final copy");
  const restore = refuseSettingsRename();
  try { await setAdmission(false); await orch.reconcile(); await settle(); } finally { restore(); }
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
