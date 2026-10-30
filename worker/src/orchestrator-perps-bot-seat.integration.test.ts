/** Real supervisor lifecycle with file stores, isolated homes, and fake child processes. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "perps-bot-seat-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 31).toString("base64");
for (const key of ["DATABASE_URL", "MERRYMEN_ACCOUNTING_HOLD_TENANTS", "MERRYMEN_FLEET_RECOVERY_REPORT_ONLY",
  "MERRYMEN_PERSISTENT_HOME_REQUIRED", "MERRYMEN_FLEET_ROLLOUT", "MERRYMEN_ROLLOUT_NEW_TENANTS", "MERRYMEN_PERPS_PAPER_TENANTS"]) delete process.env[key];
for (const key of Object.keys(process.env)) if (key.startsWith("RAILWAY_")) delete process.env[key];

const orch = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore } = await import("./settings-store");
const { acquireTenantLease } = await import("./tenant-lease");
const { writeKillRequest } = await import("./kill-request");
const spot = getGrantStore("spot"), perps = getGrantStore("perps");
const settings = getSettingsStore("spot");
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
let nextOwner = 0x6200;
const owners: `0x${string}`[] = [];
const refused = new Set<string>();
const leaseAsks: string[] = [];
const confirmations: Array<{ tenant: string; perps: boolean; grantGone: boolean; workerStopped: boolean }> = [];

class FakeProc extends EventEmitter {
  static next = 99_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  gone = false;
  autoExit = true;
  constructor(readonly args: readonly string[], readonly env: NodeJS.ProcessEnv) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal ?? "SIGTERM"));
    if (this.autoExit) setImmediate(() => this.die());
    return true;
  }
  die() { if (!this.gone) { this.gone = true; this.emit("exit", null, "SIGTERM"); } }
}
const spawned: FakeProc[] = [];
const key = (owner: string) => `${owner}:perps`;
const running = (owner: string) => spawned.filter(p => !p.gone && p.env.MERRYMEN_HOME === orch.childHome(owner));
const seats = (owner: string) => running(owner).filter(p => p.env.MERRYMEN_PERPS_BOT_SEAT === "1");
const settle = async () => { for (let i = 0; i < 35; i++) await new Promise(resolve => setImmediate(resolve)); };
orch.setSpawnForTest((_c: string, args: readonly string[], options: SpawnOptions) => {
  const proc = new FakeProc(args, options.env ?? {}); spawned.push(proc); return proc as unknown as ChildProcess;
});
orch.setSpawnPacingForTest(0, 0);
orch.setLeaseAcquireForTest(async tenant => {
  leaseAsks.push(tenant);
  return refused.has(tenant) ? null : acquireTenantLease(tenant);
});
orch.setPaperRestoreForTest(async () => ({ ok: true, line: null }));
orch.setPerpsFeedStartForTest(() => ({ stop() {} }));
orch.setBotConfirmForTest(async token => token.split(":")[0]!);
orch.setSolanaKillForTest(async () => {});
orch.setKillConfirmForTest(async (tenant, done) => {
  confirmations.push({ tenant, perps: done?.perps === true,
    grantGone: await perps.get(tenant) === null,
    workerStopped: running(key(tenant)).every(p => p.signals.length > 0) });
});

function grant(owner: `0x${string}`, account: `0x${string}`, purpose: "spot" | "perps", expiresAt = nowSec() + 3600): StoredGrant {
  const secret = `0x${"41".repeat(32)}` as `0x${string}`;
  return { owner, smartAccount: account, purpose, chainId: 4663,
    sessionKeyAddress: privateKeyToAccount(secret).address, demoSessionPrivateKey: secret, serialized: `test-${account}`,
    grantedAt: nowSec() - 60, expiresAt,
    caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 4 },
    grantFeatures: ["tradeable-v2"], grantTokens: [] };
}
async function owner(expiresAt?: number) {
  const tenant = address(nextOwner++), account = address(nextOwner++), spotAccount = address(nextOwner++);
  owners.push(tenant);
  await perps.put(tenant, grant(tenant, account, "perps", expiresAt));
  await settings.put(tenant, { telegramEnabled: true, telegramBotToken: `${nextOwner}:seat-test-token`, telegramAllowlist: [7] });
  return { tenant, account, spotAccount };
}

beforeEach(() => { process.env.MERRYMEN_PERPS = "paper"; });
afterEach(async () => {
  refused.clear(); orch.setPhantomProcessesForTest(0);
  for (const proc of spawned) { proc.autoExit = true; if (proc.signals.length) proc.die(); }
  for (const tenant of owners.splice(0)) { await spot.remove(tenant); await perps.remove(tenant); }
  await orch.reconcile(); await settle();
  for (const proc of spawned) proc.die();
  for (const dir of ["children", "children-perps", "tenants", "tenants-perps", "tenant-settings", "tenant-settings-perps"])
    rmSync(path.join(fleet, dir), { recursive: true, force: true });
  spawned.length = 0; leaseAsks.length = 0; confirmations.length = 0;
});
after(() => {
  orch.setLeaseAcquireForTest(null); orch.setBotConfirmForTest(null);
  orch.setPaperRestoreForTest(null); orch.setPerpsFeedStartForTest(null);
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("Perps-only bot has the owner's lease and no signing grant, ledger, or database credentials", async () => {
  const o = await owner();
  await orch.reconcile(); await settle();
  assert.equal(seats(o.tenant).length, 1);
  assert.equal(running(key(o.tenant)).length, 1);
  assert.ok(leaseAsks.includes(o.tenant));
  const seat = seats(o.tenant)[0]!;
  assert.ok(seat.args.some(arg => arg.endsWith("telegram-hold.ts")));
  assert.equal(seat.env.DATABASE_URL, undefined);
  assert.equal(seat.env.MERRYMEN_STORE_DEK, undefined);
  assert.equal(seat.env.MERRYMEN_TG_GROUPS, "0");
  for (const name of ["grant.json", "merrymen.db"]) assert.equal(existsSync(path.join(orch.childHome(o.tenant), name)), false);
  assert.doesNotMatch(readFileSync(path.join(orch.childHome(o.tenant), "perps-bot-view.json"), "utf8"), /demoSessionPrivateKey|serialized|seat-test-token/);
  const tradingSettings = JSON.parse(readFileSync(path.join(orch.childHome(key(o.tenant)), "settings.json"), "utf8"));
  assert.equal(tradingSettings.telegramEnabled, false);
  assert.equal(tradingSettings.telegramBotToken, undefined);
});

test("no owner lease means no Perps bot or trading process", async () => {
  const o = await owner(); refused.add(o.tenant);
  await orch.reconcile(); await settle();
  assert.equal(seats(o.tenant).length, 0);
  assert.equal(running(key(o.tenant)).length, 0);
  assert.equal(orch.hasLeaseForTest(o.tenant), false);
});

test("the process cap includes the bot seat, which gets the last slot before its trading worker", async () => {
  const o = await owner(); orch.setPhantomProcessesForTest(48);
  await orch.reconcile(); await settle();
  assert.equal(spawned.length, 0);
  orch.setPhantomProcessesForTest(47);
  await orch.reconcile(); await settle();
  assert.equal(seats(o.tenant).length, 1);
  assert.equal(running(key(o.tenant)).length, 0);
  orch.setPhantomProcessesForTest(46);
  await orch.reconcile(); await settle();
  assert.equal(running(key(o.tenant)).length, 1);
});

test("a cold Perps-only owner retains bot access while paper trading is off", async () => {
  const o = await owner(); process.env.MERRYMEN_PERPS = "off";
  await orch.reconcile(); await settle();
  assert.equal(seats(o.tenant).length, 1, "read and stop controls remain available when trading is disabled");
  assert.equal(running(key(o.tenant)).length, 0);
});

test("expired Perps permission retains the bot but cannot start a trading worker", async () => {
  const o = await owner(nowSec() - 1);
  await orch.reconcile(); await settle();
  assert.equal(seats(o.tenant).length, 1);
  assert.equal(running(key(o.tenant)).length, 0);
  assert.equal(existsSync(path.join(orch.childHome(o.tenant), "grant.json")), false);
});

test("switching paper trading off keeps an existing bot seat and its owner's control home", async () => {
  const o = await owner(); await orch.reconcile(); await settle();
  const seat = seats(o.tenant)[0]!;
  process.env.MERRYMEN_PERPS = "off";
  await orch.reconcile(); await settle();
  assert.deepEqual(seats(o.tenant), [seat]);
  assert.equal(running(key(o.tenant)).length, 0);
  assert.ok(existsSync(path.join(orch.childHome(o.tenant), "settings.json")));
});

test("Spot handoff waits for the Perps-only bot to exit before starting the next poller", async () => {
  const o = await owner(); await orch.reconcile(); await settle();
  const seat = seats(o.tenant)[0]!; seat.autoExit = false;
  await spot.put(o.tenant, grant(o.tenant, o.spotAccount, "spot"));
  await orch.reconcile(); await settle();
  assert.ok(seat.signals.length > 0);
  assert.deepEqual(running(o.tenant), [seat], "an unexited holder prevents a second poller");
  seat.die(); await settle();
  await orch.reconcile(); await settle();
  assert.equal(seats(o.tenant).length, 0);
  assert.equal(running(o.tenant).length, 1);
  assert.ok(running(o.tenant)[0]!.args.some(arg => arg.endsWith("index.ts")));
});

test("owner lease loss stands down both the bot and its Perps trading worker", async () => {
  const o = await owner(); await orch.reconcile(); await settle();
  const seat = seats(o.tenant)[0]!, trader = running(key(o.tenant))[0]!;
  orch.loseLeaseForTest(o.tenant);
  orch.standDownLostLeasesForTest(); await settle();
  assert.ok(seat.signals.length > 0);
  assert.ok(trader.signals.length > 0);
  assert.equal(running(o.tenant).length, 0);
  assert.equal(running(key(o.tenant)).length, 0);
});

test("Perps-only kill reaches the grant and strategy before its final confirmation", async () => {
  const o = await owner();
  await getSettingsStore("perps").put(o.tenant, { perpsEnabled: true });
  await orch.reconcile(); await settle();
  writeKillRequest(orch.childHome(o.tenant), { smartAccount: o.account, serialized: "recorded-bot-kill" }, nowSec());
  await orch.honourPendingKills(); await settle();
  assert.equal(await perps.get(o.tenant), null);
  assert.equal((await getSettingsStore("perps").get(o.tenant))?.perpsEnabled, false);
  assert.deepEqual(confirmations, [{ tenant: o.tenant, perps: true, grantGone: true, workerStopped: true }]);
  await orch.honourPendingKills();
  assert.equal(confirmations.length, 1);
});
