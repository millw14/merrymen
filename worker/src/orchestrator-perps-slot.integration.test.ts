/**
 * A LOGIN'S PERPS WORKER, THROUGH THE REAL reconcile() (slice 4's done-when:
 * a Perps child spawns, pauses, is killed and stands down).
 *
 * Three owners: one with both wallets, one with only a Perps wallet, one with
 * only Spot. Driven over the file-backed stores and the no-op lease, the
 * worker process replaced by a fake (setSpawnForTest) and every lease request
 * recorded. MERRYMEN_PERPS is set per test: unset, off and live start nothing
 * Perps at all; only `paper` spawns a Perps worker.
 *
 * MERRYMEN_HOME and the environment are per process (node --test runs each
 * file in its own), so nothing here leaks into another file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-perps-slot-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
delete process.env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY;
delete process.env.MERRYMEN_PERSISTENT_HOME_REQUIRED;
delete process.env.MERRYMEN_FLEET_ROLLOUT;
delete process.env.MERRYMEN_PERPS;
for (const key of Object.keys(process.env)) if (key.startsWith("RAILWAY_")) delete process.env[key];
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 41).toString("base64");

const {
  childEnv, childHome, hasLeaseForTest, honourFleetHalt, honourPendingKills, mirrorLoginPausesForTest, perpsFeedMarketsForTest, reconcile,
  refreshPerpsFeedForTest, setKillConfirmForTest, setLeaseAcquireForTest, setPaperRestoreForTest, setPerpsFeedStartForTest,
  setSolanaKillForTest, setSpawnForTest, setPerpsPilotAdmissionReaderForTest, refreshPerpsPilotAdmissionForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore } = await import("./settings-store");
const { KILL_DONE_PERPS_HOME_TEXT, writeKillRequest } = await import("./kill-request");
const { acquireTenantLease } = await import("./tenant-lease");

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const key = (byte: string) => `0x${byte.repeat(32)}` as `0x${string}`;

/** BOTH: two wallets. PERPS_ONLY: a Perps grant and no Spot one. SPOT_ONLY: the control. */
const BOTH = address(0xa1), PERPS_ONLY = address(0xb1), SPOT_ONLY = address(0xc1);
const acct: Record<string, { spot: `0x${string}`; perps: `0x${string}` }> = {
  [BOTH]: { spot: address(0xa2), perps: address(0xa3) },
  [PERPS_ONLY]: { spot: address(0xb2), perps: address(0xb3) },
  [SPOT_ONLY]: { spot: address(0xc2), perps: address(0xc3) },
};
const accountOf = (owner: string, wallet: "spot" | "perps") => acct[owner]![wallet];
const perpsKey = (owner: string) => `${owner}:perps`;

let keyByte = 0x10;
const grant = (owner: `0x${string}`, account: `0x${string}`, extra: Partial<StoredGrant> = {}): StoredGrant => {
  const sessionKey = key((keyByte++).toString(16).padStart(2, "0"));
  return {
    owner, smartAccount: account, chainId: 4663, demoSessionPrivateKey: sessionKey,
    sessionKeyAddress: privateKeyToAccount(sessionKey).address, serialized: `permission-${account}-${keyByte}`,
    grantedAt: nowSec() - 60, expiresAt: nowSec() + 86_400, grantFeatures: ["tradeable-v2"], grantTokens: [],
    caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 },
    ...extra,
  } as StoredGrant;
};

class FakeProc extends EventEmitter {
  static next = 91_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  gone = false;
  constructor(readonly env: NodeJS.ProcessEnv, readonly stdio: unknown) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal ?? "SIGTERM"));
    setImmediate(() => this.die(null, String(signal ?? "SIGTERM")));
    return true;
  }
  die(code: number | null, signal: string | null = null): void {
    if (this.gone) return;
    this.gone = true;
    this.emit("exit", code, signal);
  }
}
const spawned: FakeProc[] = [];
setSpawnForTest((_command: string, _args: readonly string[], options: SpawnOptions) => {
  const proc = new FakeProc(options.env ?? {}, options.stdio);
  spawned.push(proc);
  return proc as unknown as ChildProcess;
});
const leaseAsks: string[] = [];
setLeaseAcquireForTest(async (tenant) => {
  leaseAsks.push(tenant.toLowerCase());
  return acquireTenantLease(tenant);
});
/** Each ✅, with what was true of the Perps worker at the moment it was sent. */
const confirmed: Array<{ tenant: string; perps: boolean; perpsHome: boolean; perpsWorkerSignalled: boolean; perpsGrantCopy: boolean }> = [];
setKillConfirmForTest(async (tenant, done) => {
  const running = spawnedFor(perpsKey(tenant));
  confirmed.push({
    tenant, perps: done?.perps === true, perpsHome: done?.perpsHome === true,
    perpsWorkerSignalled: running.length === 0 || running.every((p) => p.signals.length > 0),
    perpsGrantCopy: existsSync(path.join(childHome(perpsKey(tenant)), "grant.json")),
  });
});
const solanaStops: string[] = [];
setSolanaKillForTest(async (tenant) => { solanaStops.push(tenant); });
setPaperRestoreForTest(async () => ({ ok: true, line: null }));
const feedStarts: Array<{ markets: () => readonly number[]; stopped: boolean }> = [];
setPerpsFeedStartForTest((options) => {
  const entry = { markets: options.marketIds, stopped: false };
  feedStarts.push(entry);
  return { stop: () => { entry.stopped = true; } };
});

const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const spotStore = getGrantStore("spot"), perpsStore = getGrantStore("perps");
const spawnedFor = (tenant: string) => spawned.filter((p) => p.env.MERRYMEN_HOME === childHome(tenant));
const running = (tenant: string) => spawnedFor(tenant).filter((p) => !p.gone);
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

async function fleetOfThree(): Promise<void> {
  setPerpsPilotAdmissionReaderForTest(async () => ({ owners: [BOTH, PERPS_ONLY], revision: 1 }));
  await refreshPerpsPilotAdmissionForTest();
  await spotStore.put(BOTH, grant(BOTH, accountOf(BOTH, "spot")));
  await perpsStore.put(BOTH, grant(BOTH, accountOf(BOTH, "perps"), { purpose: "perps" }));
  await perpsStore.put(PERPS_ONLY, grant(PERPS_ONLY, accountOf(PERPS_ONLY, "perps"), { purpose: "perps" }));
  await spotStore.put(SPOT_ONLY, grant(SPOT_ONLY, accountOf(SPOT_ONLY, "spot")));
  // The owner's bot lives in the Spot settings; it must never reach a Perps worker.
  await getSettingsStore("spot").put(BOTH, { telegramEnabled: true, telegramBotToken: "4242:SECRET-bot-token", telegramAllowlist: [7] });
  await getSettingsStore("perps").put(BOTH, { perpsEnabled: true, perpsMarkets: ["BTC-PERP"] });
  await getSettingsStore("perps").put(PERPS_ONLY, { perpsEnabled: true, perpsMarkets: ["ETH-PERP"] });
}

after(() => {
  console.log = realLog;
  setPerpsPilotAdmissionReaderForTest(null);
  setLeaseAcquireForTest(null);
  setPaperRestoreForTest(null);
  setPerpsFeedStartForTest(null);
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(() => {
  delete process.env.MERRYMEN_PERPS;
});
afterEach(async () => {
  delete process.env.MERRYMEN_FLEET_ROLLOUT;
  rmSync(path.join(fleet, "FLEET_HALT"), { force: true });
  for (const owner of [BOTH, PERPS_ONLY, SPOT_ONLY]) {
    await spotStore.remove(owner);
    await perpsStore.remove(owner);
  }
  await reconcile();
  await settle();
  for (const dir of ["children", "children-perps", "tenants", "tenants-perps", "tenant-settings", "tenant-settings-perps"]) rmSync(path.join(fleet, dir), { recursive: true, force: true });
  setPerpsFeedStartForTest((options) => {
    const entry = { markets: options.marketIds, stopped: false };
    feedStarts.push(entry);
    return { stop: () => { entry.stopped = true; } };
  });
  spawned.length = 0;
  leaseAsks.length = 0;
  confirmed.length = 0;
  solanaStops.length = 0;
  feedStarts.length = 0;
  said.length = 0;
});

describe("with MERRYMEN_PERPS unset, off or live, nothing Perps happens", () => {
  for (const value of [undefined, "off", "live", "paper-ish"]) {
    it(`MERRYMEN_PERPS=${value ?? "(unset)"}: Spot workers only — no Perps lease, spawn, home or feed`, async () => {
      await fleetOfThree();
      if (value !== undefined) process.env.MERRYMEN_PERPS = value;
      for (let pass = 0; pass < 2; pass++) {
        await reconcile();
        await refreshPerpsFeedForTest();
        await settle();
      }
      assert.deepEqual(spawned.map((p) => p.env.MERRYMEN_HOME).sort(), [childHome(BOTH), childHome(SPOT_ONLY)].sort());
      assert.ok(spawned.every((p) => p.env.MERRYMEN_WALLET_PURPOSE === "spot"));
      assert.ok(!leaseAsks.some((t) => t.endsWith(":perps")), `no Perps lease: ${leaseAsks.join(", ")}`);
      assert.equal(existsSync(path.join(fleet, "children-perps")), false, "no Perps home is made");
      assert.equal(perpsFeedMarketsForTest(), null, "no feed is even built");
      assert.equal(feedStarts.length, 0);
      // And the grants are kept: a flag that limits trading never deletes one.
      assert.ok(await perpsStore.get(BOTH));
      assert.ok(await perpsStore.get(PERPS_ONLY));
    });
  }

  it("a Spot-only fleet at paper reads the Perps store and makes nothing of it", async () => {
    await spotStore.put(SPOT_ONLY, grant(SPOT_ONLY, accountOf(SPOT_ONLY, "spot")));
    process.env.MERRYMEN_PERPS = "paper";
    await reconcile();
    await refreshPerpsFeedForTest();
    await settle();
    for (const dir of ["children-perps", "tenants-perps", "tenant-settings-perps"]) assert.equal(existsSync(path.join(fleet, dir)), false, `${dir} is not made`);
    assert.equal(feedStarts.length, 0, "no Perps worker wants a market");
  });
});

describe("at MERRYMEN_PERPS=paper, a login's Perps worker", () => {
  it("SPAWNS in its own home, as its wallet's, after every Spot worker, with its own grant and settings and nothing of the bot", async () => {
    await fleetOfThree();
    process.env.MERRYMEN_PERPS = "paper";
    await reconcile();
    await settle();
    const homes = spawned.map((p) => p.env.MERRYMEN_HOME);
    assert.equal(homes.length, 4);
    assert.deepEqual(homes.slice(2).sort(), [childHome(perpsKey(BOTH)), childHome(perpsKey(PERPS_ONLY))].sort(), "the Perps workers go last");
    for (const owner of [BOTH, PERPS_ONLY]) {
      const home = childHome(perpsKey(owner));
      assert.equal(home, path.join(fleet, "children-perps", owner));
      const [proc] = spawnedFor(perpsKey(owner));
      assert.ok(proc, `${owner}'s Perps worker started`);
      assert.equal(proc.env.MERRYMEN_WALLET_PURPOSE, "perps");
      assert.equal(proc.env.MERRYMEN_TENANT, owner);
      assert.equal(proc.env.MERRYMEN_TG_GROUPS, "0");
      assert.equal(proc.env.MERRYMEN_GRANT_FILE, path.join(home, "grant.json"));
      assert.equal(proc.env.MERRYMEN_STORE_DEK, undefined);
      assert.deepEqual(proc.stdio, ["ignore", "pipe", "pipe"], "no IPC channel");
      const g = readJson(path.join(home, "grant.json"));
      assert.equal(g.smartAccount, accountOf(owner, "perps"), "its own wallet's grant");
      assert.equal(g.purpose, "perps");
      const s = readJson(path.join(home, "settings.json"));
      assert.equal(s.strategy, "perps-only");
      assert.equal(s.telegramEnabled, false);
      assert.equal(s.telegramBotToken, undefined, "the owner's bot never reaches a Perps worker");
      assert.equal(existsSync(path.join(home, "perp-key.json")), false, "no venue key, ever, in this build");
      assert.ok(leaseAsks.includes(perpsKey(owner)), "leased under its own key");
      assert.equal(hasLeaseForTest(perpsKey(owner) as `0x${string}`), true);
    }
    // The Spot worker beside it keeps the bot and its own grant.
    const spotSettings = readJson(path.join(childHome(BOTH), "settings.json"));
    assert.equal(spotSettings.telegramBotToken, "4242:SECRET-bot-token");
    assert.equal(readJson(path.join(childHome(BOTH), "grant.json")).smartAccount, accountOf(BOTH, "spot"));
    assert.equal(spawnedFor(perpsKey(SPOT_ONLY)).length, 0);
  });

  it("is published ONE public feed for the replica, over what its Perps workers want", async () => {
    await fleetOfThree();
    process.env.MERRYMEN_PERPS = "paper";
    await reconcile();
    await settle();
    await refreshPerpsFeedForTest();
    await refreshPerpsFeedForTest();
    assert.equal(feedStarts.length, 1, "one publisher");
    assert.deepEqual([...feedStarts[0]!.markets()], [0, 1], "ETH (the Perps-only owner) and BTC (the two-wallet owner)");
    // FLEET_HALT stands every worker down and pauses the feed.
    writeFileSync(path.join(fleet, "FLEET_HALT"), "");
    await honourFleetHalt();
    await settle();
    assert.equal(feedStarts[0]!.stopped, true);
    assert.ok(running(perpsKey(BOTH)).length === 0 && running(perpsKey(PERPS_ONLY)).length === 0, "the halt stands the Perps workers down");
  });

  it("PAUSES with its owner: the Spot home's pause is mirrored in, and /resume lifts it", async () => {
    await fleetOfThree();
    process.env.MERRYMEN_PERPS = "paper";
    await reconcile();
    await settle();
    const mine = path.join(childHome(perpsKey(BOTH)), "paused");
    writeFileSync(path.join(childHome(BOTH), "paused"), "paused");
    await mirrorLoginPausesForTest();
    assert.equal(existsSync(mine), true, "paused with the owner's Spot worker");
    assert.equal(existsSync(path.join(childHome(perpsKey(PERPS_ONLY)), "paused")), false, "another login is not");
    rmSync(path.join(childHome(BOTH), "paused"));
    await mirrorLoginPausesForTest();
    assert.equal(existsSync(mine), false, "resumed with it");
    // And the operator's rollout narrows it as its owner: the level a Perps
    // worker is started at is its owner's, and one the rollout does not name
    // is held with its owner.
    process.env.MERRYMEN_FLEET_ROLLOUT = `${BOTH}:exits-only,${SPOT_ONLY}:trade`;
    assert.equal(childEnv(perpsKey(BOTH)).MERRYMEN_ADMISSION_LEVEL, "exits-only");
    assert.equal(childEnv(BOTH).MERRYMEN_ADMISSION_LEVEL, "exits-only");
    await reconcile();
    await settle();
    assert.equal(running(perpsKey(PERPS_ONLY)).length, 0, "an owner the rollout does not name is held, Perps worker and all");
    assert.equal(running(perpsKey(BOTH)).length, 1, "a named owner's is not");
  });

  it("A KILL FROM THE OWNER'S SPOT BOT stops both wallets, and stands the Perps worker down before the ✅", async () => {
    await fleetOfThree();
    process.env.MERRYMEN_PERPS = "paper";
    await reconcile();
    await settle();
    const perps = running(perpsKey(BOTH));
    assert.equal(perps.length, 1);
    writeKillRequest(childHome(BOTH), await spotStore.get(BOTH) as StoredGrant, nowSec());
    await honourPendingKills();
    await settle();
    assert.equal(await spotStore.get(BOTH), null);
    assert.equal(await perpsStore.get(BOTH), null, "the Perps grant is revoked too");
    assert.equal((await getSettingsStore("perps").get(BOTH))?.perpsEnabled, false, "and its paper strategy turned off");
    assert.deepEqual(solanaStops, [BOTH]);
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0]!.perps, true);
    assert.equal(confirmed[0]!.perpsWorkerSignalled, true, "the Perps worker was signalled before the ✅");
    assert.equal(confirmed[0]!.perpsGrantCopy, false, "and its grant copy was gone");
    await reconcile();
    await settle();
    assert.equal(running(perpsKey(BOTH)).length, 0, "it stays down");
    assert.equal(running(perpsKey(PERPS_ONLY)).length, 1, "another login's is untouched");
  });

  it("A KILL SITTING IN THE PERPS HOME is its owner's whole kill, said as the Perps wallet's", async () => {
    await fleetOfThree();
    process.env.MERRYMEN_PERPS = "paper";
    await reconcile();
    await settle();
    writeKillRequest(childHome(perpsKey(PERPS_ONLY)), await perpsStore.get(PERPS_ONLY) as StoredGrant, nowSec());
    await honourPendingKills();
    await settle();
    assert.equal(await perpsStore.get(PERPS_ONLY), null);
    assert.equal((await getSettingsStore("perps").get(PERPS_ONLY))?.perpsEnabled, false);
    assert.deepEqual(solanaStops, [PERPS_ONLY], "Solana's half, by the owner");
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0]!.perpsHome, true);
    assert.equal(confirmed[0]!.perpsWorkerSignalled, true);
    assert.doesNotMatch(KILL_DONE_PERPS_HOME_TEXT, /funds|money|closed|flat/i, "custody-silent");
    assert.match(KILL_DONE_PERPS_HOME_TEXT, /Perps wallet/);
    // The ferry again: the same request is not confirmed twice.
    await honourPendingKills();
    await settle();
    assert.equal(confirmed.length, 1);
  });

  it("a Perps grant signed after an old kill arms: the other home's request latches only what it covers", async () => {
    await fleetOfThree();
    process.env.MERRYMEN_PERPS = "paper";
    await reconcile();
    await settle();
    writeKillRequest(childHome(BOTH), await spotStore.get(BOTH) as StoredGrant, nowSec());
    await honourPendingKills();
    await reconcile();
    await settle();
    assert.equal(running(perpsKey(BOTH)).length, 0);
    // The request stays in the Spot home (it keeps the book). Dated well before
    // the re-sign below, as a kill an hour ago would be.
    const spotHome = childHome(BOTH);
    for (const name of readdirSync(spotHome).filter((n) => n.startsWith("kill-request-") && n.endsWith(".json") && !n.includes("superseded"))) {
      const file = path.join(spotHome, name);
      const body = readJson(file);
      writeFileSync(file, JSON.stringify({ ...body, killedAt: nowSec() - 3600 }));
    }
    await perpsStore.put(BOTH, grant(BOTH, accountOf(BOTH, "perps"), { purpose: "perps" }));
    await reconcile();
    await settle();
    assert.equal(running(perpsKey(BOTH)).length, 1, "the owner's later Perps grant arms");
    assert.equal(running(BOTH).length, 0, "while the Spot home's own request still latches Spot");
  });

  it("A PERPS-ONLY STOP leaves the Spot worker exactly as it was", async () => {
    await fleetOfThree();
    process.env.MERRYMEN_PERPS = "paper";
    await reconcile();
    await settle();
    const spot = running(BOTH);
    assert.equal(spot.length, 1);
    await perpsStore.remove(BOTH);
    await reconcile();
    await settle();
    assert.equal(running(perpsKey(BOTH)).length, 0, "the Perps worker is stood down");
    assert.deepEqual(spot[0]!.signals, [], "the Spot worker was not signalled");
    assert.equal(running(BOTH).length, 1);
  });

  it("STANDS DOWN when MERRYMEN_PERPS leaves paper, keeps its grant and book, and comes back when it returns", async () => {
    await fleetOfThree();
    process.env.MERRYMEN_PERPS = "paper";
    await reconcile();
    await settle();
    assert.equal(running(perpsKey(PERPS_ONLY)).length, 1);
    process.env.MERRYMEN_PERPS = "off";
    await reconcile();
    await settle();
    await reconcile();
    await settle();
    assert.equal(running(perpsKey(PERPS_ONLY)).length, 0, "stood down");
    assert.equal(running(BOTH).length, 1, "Spot is unaffected");
    assert.ok(await perpsStore.get(PERPS_ONLY), "its grant is kept");
    assert.equal(existsSync(childHome(perpsKey(PERPS_ONLY))), true, "and its home");
    assert.equal(hasLeaseForTest(perpsKey(PERPS_ONLY) as `0x${string}`), false, "its lease is given back");
    process.env.MERRYMEN_PERPS = "paper";
    await reconcile();
    await settle();
    assert.equal(running(perpsKey(PERPS_ONLY)).length, 1, "and it comes back");
  });

  it("AN UNREADABLE PERPS STORE IS NOT AN EMPTY ONE: every Perps worker is kept as it is", async () => {
    await fleetOfThree();
    process.env.MERRYMEN_PERPS = "paper";
    await reconcile();
    await settle();
    const before = running(perpsKey(PERPS_ONLY));
    assert.equal(before.length, 1);
    const dir = path.join(fleet, "tenants-perps");
    chmodSync(dir, 0o000);
    try {
      await reconcile();
      await settle();
      assert.deepEqual(before[0]!.signals, [], "not stood down");
      assert.equal(existsSync(childHome(perpsKey(PERPS_ONLY))), true, "its home is not wiped");
      assert.equal(hasLeaseForTest(perpsKey(PERPS_ONLY) as `0x${string}`), true, "its lease is kept");
      assert.ok(said.some((l) => l.includes("the Perps grant store is unreadable")), "and it is said");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("is never a recorded tenant of its own: nothing is mkdir'd under children/ for it, and its key never reaches an owner-keyed name", async () => {
    await fleetOfThree();
    process.env.MERRYMEN_PERPS = "paper";
    await reconcile();
    await settle();
    const names = existsSync(path.join(fleet, "children")) ? readdirSync(path.join(fleet, "children")) : [];
    assert.ok(names.every((n) => !n.includes(":")), `children/ holds only owners: ${names.join(", ")}`);
    for (const dir of ["tenants", "tenants-perps", "tenant-settings", "tenant-settings-perps"]) {
      const listed = existsSync(path.join(fleet, dir)) ? readdirSync(path.join(fleet, dir)) : [];
      assert.ok(listed.every((n) => !n.includes(":perps")), `${dir} holds only owners: ${listed.join(", ")}`);
    }
  });
});

describe("the orchestrator path carries no live venue code", () => {
  it("imports no signer, live handle, venue key or stand-down module", () => {
    const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^\s*import[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);
    for (const from of imports) {
      assert.doesNotMatch(from, /perps\/(signer|live-handle|key-seal|child-key|hosted-standdown|standdown|executor-live|keygen|payouts)/, from);
    }
    const feed = readFileSync(new URL("./perps/fleet-feed.ts", import.meta.url), "utf8");
    assert.match(feed, /budgetKey: "public"/, "the feed is the public client only");
  });
});

void mkdirSync;
