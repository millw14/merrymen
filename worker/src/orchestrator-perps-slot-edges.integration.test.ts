/**
 * A LOGIN'S PERPS WORKER AT THE EDGES (slice 4): what a review of the first
 * cut found, each pinned through the real reconcile() and order ferry.
 *
 *  - a kill whose Perps half fails still stands the Perps worker down;
 *  - a Perps grant signed after a kill survives the pass that finishes it;
 *  - a non-0x roster id's kill completes as it always did;
 *  - a standing pause on a rebuilt Spot home reaches the Perps worker even
 *    when the Spot worker does not arm (it starts paused, never unpaused);
 *  - a Spot worker waiting for a process slot gets one back from a Perps
 *    worker, and no Perps worker starts into a slot Spot needs;
 *  - a Perps worker runs on the replica holding its owner's Spot lease.
 *
 * File stores, the no-op lease, a sqlite stand-in for the shared database
 * where one is needed, and a fake worker process. Per process environment.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, describe, it } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-perps-edges-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
delete process.env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY;
delete process.env.MERRYMEN_PERSISTENT_HOME_REQUIRED;
delete process.env.MERRYMEN_FLEET_ROLLOUT;
for (const key of Object.keys(process.env)) if (key.startsWith("RAILWAY_")) delete process.env[key];
const dek = Buffer.alloc(32, 43);
process.env.MERRYMEN_STORE_DEK = dek.toString("base64");
process.env.MERRYMEN_PERPS = "paper";

const orch = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const settingsStores = await import("./settings-store");
const { writeKillRequest } = await import("./kill-request");
const { acquireTenantLease } = await import("./tenant-lease");
const { wrapSqlite } = await import("./db");
const { applyLedgerSchema } = await import("./store");
const { MIRROR_STATE_DDL } = await import("./ledger-mirror");
const { ensureTelegramSchema, recordDurablePause } = await import("./telegram-store");

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
let keyByte = 0x20;
const grant = (owner: `0x${string}`, account: `0x${string}`, extra: Partial<StoredGrant> = {}): StoredGrant => {
  const sk = `0x${(keyByte++).toString(16).padStart(2, "0").repeat(32)}` as `0x${string}`;
  return {
    owner, smartAccount: account, chainId: 4663, demoSessionPrivateKey: sk,
    sessionKeyAddress: privateKeyToAccount(sk).address, serialized: `permission-${account}-${keyByte}`,
    grantedAt: nowSec() - 60, expiresAt: nowSec() + 86_400, grantFeatures: ["tradeable-v2"], grantTokens: [],
    caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 },
    ...extra,
  } as StoredGrant;
};

class FakeProc extends EventEmitter {
  static next = 93_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  readonly pausedAtStart: boolean;
  gone = false;
  constructor(readonly env: NodeJS.ProcessEnv) {
    super();
    this.pausedAtStart = existsSync(path.join(String(env.MERRYMEN_HOME), "paused"));
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal ?? "SIGTERM"));
    setImmediate(() => this.die());
    return true;
  }
  die(): void {
    if (this.gone) return;
    this.gone = true;
    this.emit("exit", null, "SIGTERM");
  }
}
const spawned: FakeProc[] = [];
orch.setSpawnForTest((_c: string, _a: readonly string[], o: SpawnOptions) => {
  const p = new FakeProc(o.env ?? {});
  spawned.push(p);
  return p as unknown as ChildProcess;
});
let leaseRefused: ReadonlySet<string> = new Set();
orch.setLeaseAcquireForTest(async (t) => (leaseRefused.has(t.toLowerCase()) ? null : acquireTenantLease(t)));
const confirmed: Array<{ tenant: string; perps: boolean }> = [];
orch.setKillConfirmForTest(async (tenant, done) => { confirmed.push({ tenant, perps: done?.perps === true }); });
let solanaDown = false;
orch.setSolanaKillForTest(async () => { if (solanaDown) throw new Error("solana bindings unavailable"); });
orch.setPaperRestoreForTest(async () => ({ ok: true, line: null }));
orch.setPerpsFeedStartForTest(() => ({ stop: () => {} }));
const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const spot = getGrantStore("spot"), perps = getGrantStore("perps");
const perpsKey = (owner: string) => `${owner}:perps`;
const live = (tenant: string) => spawned.filter((p) => p.env.MERRYMEN_HOME === orch.childHome(tenant) && !p.gone);
const all = (tenant: string) => spawned.filter((p) => p.env.MERRYMEN_HOME === orch.childHome(tenant));
const used: `0x${string}`[] = [];
const ownerAt = (n: number) => { const o = address(n); used.push(o); process.env.MERRYMEN_PERPS_PAPER_TENANTS = [...new Set(used)].join(","); return o; };

after(() => {
  console.log = realLog;
  orch.setLeaseAcquireForTest(null);
  orch.setPaperRestoreForTest(null);
  orch.setPerpsFeedStartForTest(null);
  orch.setRetirementMemoryStoreForTest(null);
  orch.setPhantomProcessesForTest(0);
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
afterEach(async () => {
  solanaDown = false;
  leaseRefused = new Set();
  orch.setPhantomProcessesForTest(0);
  orch.setRetirementMemoryStoreForTest(null);
  for (const o of used.splice(0)) {
    await spot.remove(o);
    await perps.remove(o);
  }
  await orch.reconcile();
  await settle();
  for (const dir of ["children", "children-perps", "tenants", "tenants-perps", "tenant-settings", "tenant-settings-perps"]) rmSync(path.join(fleet, dir), { recursive: true, force: true });
  spawned.length = 0;
  confirmed.length = 0;
  said.length = 0;
});

describe("a kill whose Perps half does not finish", () => {
  it("still stands the Perps worker down at once, keeps the kill pending, and owes one ✅ naming the Perps grant", async () => {
    const o = ownerAt(0xd1);
    await spot.put(o, grant(o, address(0xd2)));
    await perps.put(o, grant(o, address(0xd3), { purpose: "perps" }));
    await orch.reconcile();
    await settle();
    assert.equal(live(perpsKey(o)).length, 1);
    const real = settingsStores.getSettingsStore("perps");
    settingsStores.useSettingsStoreForTest({
      get: async () => { throw new Error("settings store down"); },
      put: async () => { throw new Error("settings store down"); },
    } as never, "perps");
    try {
      writeKillRequest(orch.childHome(o), (await spot.get(o))!, nowSec());
      await orch.honourPendingKills();
      await settle();
      assert.equal(await perps.get(o), null, "the Perps grant is revoked");
      assert.equal(live(perpsKey(o)).length, 0, "and its worker is stood down although the paper switch-off failed");
      assert.equal(existsSync(path.join(orch.childHome(perpsKey(o)), "grant.json")), false);
      assert.equal(confirmed.length, 0, "no ✅ while a half is unfinished");
    } finally {
      settingsStores.useSettingsStoreForTest(real, "perps");
    }
    await orch.honourPendingKills();
    await settle();
    assert.deepEqual(confirmed, [{ tenant: o, perps: true }], "the pass that finishes it says the Perps grant went too, once");
  });

  it("a Perps grant signed after the kill survives the pass that finishes it", async () => {
    const o = ownerAt(0xe1);
    await perps.put(o, grant(o, address(0xe3), { purpose: "perps" }));
    await orch.reconcile();
    await settle();
    assert.equal(live(perpsKey(o)).length, 1);
    // A Perps-only owner's kill (in the Spot home, as a recorded one lands)
    // whose Solana half fails: the Perps grant goes, a ✅ naming it is owed.
    solanaDown = true;
    mkdirSync(orch.childHome(o), { recursive: true });
    writeKillRequest(orch.childHome(o), { serialized: "recorded-kill" } as never, nowSec());
    await orch.honourPendingKills();
    await settle();
    assert.equal(await perps.get(o), null);
    // Dated an hour back, so the re-sign below is after its cutoff.
    for (const name of readdirSync(orch.childHome(o)).filter((n) => n.startsWith("kill-request-") && !n.includes("superseded"))) {
      const file = path.join(orch.childHome(o), name);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), killedAt: nowSec() - 3600 }));
    }
    await perps.put(o, grant(o, address(0xe3), { purpose: "perps" }));
    await orch.reconcile();
    await settle();
    const resigned = live(perpsKey(o));
    assert.equal(resigned.length, 1, "the re-signed Perps grant arms");
    solanaDown = false;
    await orch.reconcile();
    await settle();
    assert.ok(await perps.get(o), "the newer grant is kept");
    assert.deepEqual(resigned[0]!.signals, [], "and its worker is not stood down by the finishing pass");
    assert.equal(confirmed.length, 1, "the owed ✅ still goes, once");
  });

  it("a non-0x roster id's kill completes as it always did (no Perps worker to stand down)", async () => {
    const id = "sol:abc" as `0x${string}`;
    await spot.put(id, grant(address(0xf1), address(0xf2)));
    try {
      mkdirSync(orch.childHome(id), { recursive: true });
      writeKillRequest(orch.childHome(id), (await spot.get(id))!, nowSec());
      await orch.reconcile();
      await settle();
      assert.equal(await spot.get(id), null);
      assert.ok(!said.some((l) => l.includes("Perps wallet could not be stopped")), said.filter((l) => l.includes("sol:abc")).join("\n"));
    } finally {
      await spot.remove(id);
    }
  });
});

// Exercise the interval before the owner control process finishes preparing.
// The Perps-only seat normally receipts the pause first now; the mirror must
// still fence an old marker while that separate owner arm is outstanding.
async function unarmedOwner(owner: `0x${string}`): Promise<void> {
  await spot.remove(owner);
  orch.setTenantLeaseForTest(owner, await acquireTenantLease(owner));
  orch.setSpawningForTest(owner, 1);
}
describe("a standing pause on a rebuilt Spot home", () => {
  for (const duringRead of ["unchanged", "new arm", "lost lease", "new pause"] as const) {
    it(`checks a normal Spot resume without blocking the mirror, with ${duringRead} while evidence is read`, async () => {
      const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw);
      await applyLedgerSchema(shared);
      await shared.exec(MIRROR_STATE_DDL);
      await ensureTelegramSchema(shared);
      orch.setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
      let releaseRead: () => void = () => {};
      let leaseHealthy = true;
      try {
        const o = ownerAt(0x2a7), s = address(0x2a8), p = address(0x2a9);
        if (duringRead === "lost lease") {
          orch.setLeaseAcquireForTest(async (tenant) => {
            const lease = await acquireTenantLease(tenant);
            return lease && tenant === perpsKey(o) ? { ...lease, healthy: () => leaseHealthy } : lease;
          });
        }
        await spot.put(o, grant(o, s, { expiresAt: nowSec() - 60 }));
        raw.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, ?, ?, 4663, '{}', 1, 2)").run(s, o, address(0xeee));
        await perps.put(o, grant(o, p, { purpose: "perps" }));
        const spotHome = orch.childHome(o), marker = path.join(spotHome, "controls-armed.json");
        mkdirSync(spotHome, { recursive: true });
        const oldArm = JSON.stringify({ version: 1, armedAtMs: (nowSec() - 3600) * 1000 });
        writeFileSync(marker, oldArm);
        writeFileSync(path.join(spotHome, "paused"), "paused");
        await recordDurablePause(shared, o, nowSec() - 30);
        await unarmedOwner(o);
        await orch.reconcile();
        orch.setSpawningForTest(o, null);
        await settle();
        assert.equal(live(perpsKey(o))[0]?.pausedAtStart, true);
        const perpsPaused = path.join(orch.childHome(perpsKey(o)), "paused");
        // Normal /resume changes the pause file and events, not the arm marker.
        rmSync(path.join(spotHome, "paused"));
        raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'info', 'Telegram: resumed by chat 7', ?)").run(s, nowSec());
        let announceRead: () => void = () => {};
        const started = new Promise<void>((resolve) => { announceRead = resolve; });
        const blocked = new Promise<void>((resolve) => { releaseRead = resolve; });
        let reads = 0;
        const delayed = {
          exec: shared.exec.bind(shared), tx: shared.tx.bind(shared),
          prepare(sql: string) {
            const stmt = shared.prepare(sql);
            if (!sql.includes("FROM recovery_reply_controls")) return stmt;
            return { ...stmt, all: async (...args: unknown[]) => { reads++; announceRead(); await blocked; return stmt.all(...args); } };
          },
        };
        orch.setRetirementMemoryStoreForTest({ shared: delayed, dek, dialect: "sqlite" });
        await orch.mirrorLoginPausesForTest(false);
        await started;
        await orch.mirrorLoginPausesForTest(false);
        assert.equal(reads, 1, "the next mirror returns while a single evidence read is still blocked");
        assert.equal(existsSync(perpsPaused), true, "no resume without the read's evidence");
        if (duringRead === "new arm") writeFileSync(marker, JSON.stringify({ version: 1, armedAtMs: Date.now() }));
        if (duringRead === "lost lease") leaseHealthy = false;
        if (duringRead === "new pause") writeFileSync(path.join(spotHome, "paused"), "paused");
        releaseRead();
        await orch.mirrorLoginPausesForTest();
        if (duringRead === "unchanged") {
          assert.equal(readFileSync(marker, "utf8"), oldArm);
          assert.equal(existsSync(perpsPaused), false, "the newer owner resume is honoured with the same arm marker");
        } else {
          assert.equal(existsSync(perpsPaused), true, "an answer that outlived its authority cannot lift the pause");
          leaseHealthy = true;
          if (duringRead === "new pause") rmSync(path.join(spotHome, "paused"));
          await orch.mirrorLoginPausesForTest(false);
          assert.equal(existsSync(perpsPaused), true, "a recovered lease or removed local pause still requires fresh evidence");
          await orch.mirrorLoginPausesForTest();
          assert.equal(existsSync(perpsPaused), false, "a fresh read under the current arm and healthy lease permits the resume");
        }
      } finally {
        releaseRead();
        leaseHealthy = true;
        orch.setLeaseAcquireForTest(async (tenant) => leaseRefused.has(tenant.toLowerCase()) ? null : acquireTenantLease(tenant));
        orch.setRetirementMemoryStoreForTest(null);
        raw.close();
      }
    });
  }

  for (const pause of ["journal", "durable"] as const) {
    for (const marker of ["old", "invalid"] as const) {
      it(`keeps a ${pause} pause beside an ${marker} Spot arm marker until the Spot arm applies it`, async () => {
        const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw);
        await applyLedgerSchema(shared);
        await shared.exec(MIRROR_STATE_DDL);
        await ensureTelegramSchema(shared);
        orch.setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
        try {
          const o = ownerAt(0x1a7), s = address(0x1a8), p = address(0x1a9);
          await spot.put(o, grant(o, s, { expiresAt: nowSec() - 60 }));
          await perps.put(o, grant(o, p, { purpose: "perps" }));
          const spotHome = orch.childHome(o);
          mkdirSync(spotHome, { recursive: true });
          writeFileSync(path.join(spotHome, "controls-armed.json"), marker === "old"
            ? JSON.stringify({ version: 1, armedAtMs: (nowSec() - 3600) * 1000 }) : "{unreadable");
          if (pause === "journal") {
            raw.exec(`CREATE TABLE recovery_reply_controls (
              bot_id TEXT, update_id INTEGER, tenant TEXT, kind TEXT,
              request_update_id INTEGER, message_at_sec INTEGER, expires_at_ms INTEGER, chat_id INTEGER)`);
            raw.prepare("INSERT INTO recovery_reply_controls VALUES ('111', 9, ?, 'pause', NULL, ?, NULL, 7)").run(o, nowSec() - 30);
          } else await recordDurablePause(shared, o, nowSec() - 30);
          await unarmedOwner(o);
          await orch.reconcile();
          orch.setSpawningForTest(o, null);
          await settle();
          const [worker] = live(perpsKey(o));
          assert.ok(worker, "the Perps worker may manage protective closes");
          assert.equal(worker.pausedAtStart, true, "an old or unreadable marker cannot prove that the newer pause was applied");
          await orch.mirrorLoginPausesForTest();
          const perpsPaused = path.join(orch.childHome(perpsKey(o)), "paused");
          assert.equal(existsSync(perpsPaused), true, "the short loop must preserve the pause too");
          if (pause === "journal") {
            // Even a newer marker alone does not receipt this journal entry.
            writeFileSync(path.join(spotHome, "controls-armed.json"), JSON.stringify({ version: 1, armedAtMs: Date.now() }));
            await orch.mirrorLoginPausesForTest();
            assert.equal(existsSync(perpsPaused), true, "the journal's receipt is required before the Spot file can speak for this pause");
          }
          // The real Spot arm writes the pause, its receipt/durable stamp, and
          // the arm marker. The owner can then resume by removing its pause.
          const { armOwnerControls } = await import("./recovery-reply-arm");
          const armed = await armOwnerControls({ shared, home: spotHome, scope: { tenant: o, smartAccount: s, chainId: 4663 }, mayWrite: () => true, forwardKill: async () => "revoked" });
          assert.equal(armed.ok, true);
          await orch.mirrorLoginPausesForTest();
          assert.equal(existsSync(perpsPaused), true);
          rmSync(path.join(spotHome, "paused"));
          await orch.mirrorLoginPausesForTest();
          assert.equal(existsSync(perpsPaused), false, "the applied pause follows the owner's later resume");
        } finally {
          orch.setRetirementMemoryStoreForTest(null);
          raw.close();
        }
      });
    }
  }

  it("reaches the Perps worker even when the Spot worker does not arm: it starts paused and stays paused", async () => {
    const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw);
    await applyLedgerSchema(shared);
    await shared.exec(MIRROR_STATE_DDL);
    await ensureTelegramSchema(shared);
    orch.setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
    try {
      const o = ownerAt(0xa7);
      // The Spot grant has expired, so its worker never arms here.
      await spot.put(o, grant(o, address(0xa8), { expiresAt: nowSec() - 60 }));
      await perps.put(o, grant(o, address(0xa9), { purpose: "perps" }));
      await recordDurablePause(shared, o, nowSec() - 3600);
      await orch.reconcile();
      await settle();
      assert.equal(all(o).length, 0, "no Spot worker");
      const [worker] = live(perpsKey(o));
      assert.ok(worker, "the Perps worker runs — paused, not held, so its stops still close");
      assert.equal(worker.pausedAtStart, true, "and it started paused");
      await orch.mirrorLoginPausesForTest();
      assert.equal(existsSync(path.join(orch.childHome(perpsKey(o)), "paused")), true, "the mirror keeps the recorded pause while the Spot home is unarmed");
    } finally {
      orch.setRetirementMemoryStoreForTest(null);
      raw.close();
    }
  });
});

describe("process slots: Spot first", () => {
  it("a Spot worker waiting for a slot gets one back from a Perps worker, and no Perps worker starts into it", async () => {
    orch.setPhantomProcessesForTest(46);
    const a = ownerAt(0xb7), b = ownerAt(0xc7), c = ownerAt(0xd7);
    await spot.put(a, grant(a, address(0xb8)));
    await perps.put(b, grant(b, address(0xc9), { purpose: "perps" }));
    await orch.reconcile();
    await settle();
    assert.equal(live(a).length, 1);
    assert.equal(live(perpsKey(b)).length, 1, "the last slot went to a Perps worker");
    await spot.put(c, grant(c, address(0xd8)));
    await orch.reconcile();
    await settle();
    assert.equal(live(perpsKey(b)).length, 0, "the Perps worker gives its slot back");
    await orch.reconcile();
    await settle();
    assert.equal(live(c).length, 1, "and the Spot worker that waited has it");
    await orch.reconcile();
    await settle();
    assert.equal(live(perpsKey(b)).length, 0, "the Perps worker does not take a slot back while none is free");
    assert.ok(await perps.get(b), "its grant is kept");
  });

  it("on a pass whose Perps roster did not read, no Perps worker yields its slot or its lease", async () => {
    orch.setPhantomProcessesForTest(46);
    const a = ownerAt(0xb3), b = ownerAt(0xc3), c = ownerAt(0xd3);
    await spot.put(a, grant(a, address(0xb4)));
    await perps.put(b, grant(b, address(0xc4), { purpose: "perps" }));
    await orch.reconcile();
    await settle();
    const running = live(perpsKey(b));
    assert.equal(running.length, 1);
    await spot.put(c, grant(c, address(0xd4)));
    const dir = path.join(fleet, "tenants-perps");
    chmodSync(dir, 0o000);
    try {
      await orch.reconcile();
      await settle();
      await orch.reconcile();
      await settle();
      assert.deepEqual(running[0]!.signals, [], "an unreadable roster changes nothing for any Perps worker");
      assert.equal(orch.hasLeaseForTest(perpsKey(b) as `0x${string}`), true, "its lease is kept");
    } finally {
      chmodSync(dir, 0o700);
    }
    await orch.reconcile();
    await settle();
    assert.equal(live(perpsKey(b)).length, 0, "read again, Spot first applies as before");
  });
});

describe("one replica per login", () => {
  it("a Perps worker whose owner's Spot lease is held elsewhere does not start here", async () => {
    const o = ownerAt(0xab);
    await spot.put(o, grant(o, address(0xac)));
    await perps.put(o, grant(o, address(0xad), { purpose: "perps" }));
    leaseRefused = new Set([o]);
    await orch.reconcile();
    await settle();
    assert.equal(live(o).length, 0, "the Spot worker runs on the replica that holds its lease");
    assert.equal(live(perpsKey(o)).length, 0, "and so does the Perps worker");
    leaseRefused = new Set();
    await orch.reconcile();
    await settle();
    assert.equal(live(o).length, 1);
    assert.equal(live(perpsKey(o)).length, 1, "both start once this replica holds the Spot lease");
  });

  it("a running Perps worker is stood down the moment its owner's Spot lease drops, then final-passed and released", async () => {
    const o = ownerAt(0xae);
    await spot.put(o, grant(o, address(0xaf)));
    await perps.put(o, grant(o, address(0xb0), { purpose: "perps" }));
    await orch.reconcile();
    await settle();
    const running = live(perpsKey(o));
    assert.equal(running.length, 1);
    // The Spot lease's connection drops, and another replica takes the login.
    leaseRefused = new Set([o]);
    orch.loseLeaseForTest(o);
    orch.standDownLostLeasesForTest();
    await settle();
    assert.ok(running[0]!.signals.length > 0, "stood down with the Spot worker, not left running beside another replica's");
    await orch.reconcile();
    await settle();
    await orch.reconcile();
    await settle();
    assert.equal(live(perpsKey(o)).length, 0, "and not started again while the Spot lease is elsewhere");
    assert.equal(orch.hasLeaseForTest(perpsKey(o) as `0x${string}`), false, "its lease goes to the replica that has the login");
    leaseRefused = new Set();
    await orch.reconcile();
    await settle();
    assert.equal(live(o).length, 1);
    assert.equal(live(perpsKey(o)).length, 1, "both come back together once the Spot lease is here");
  });

  it("a Perps-only login's worker is stood down when a Spot grant arrives and another replica leases it", async () => {
    const o = ownerAt(0xa7);
    await perps.put(o, grant(o, address(0xa8), { purpose: "perps" }));
    await orch.reconcile();
    await settle();
    const running = live(perpsKey(o));
    assert.equal(running.length, 1, "a Perps-only login holds its owner control lease");
    orch.loseLeaseForTest(o);
    leaseRefused = new Set([o]);
    await spot.put(o, grant(o, address(0xa9)));
    await orch.reconcile();
    await settle();
    assert.ok(running[0]!.signals.length > 0, "the login is now the Spot lease's, which is elsewhere");
    await orch.reconcile();
    await settle();
    assert.equal(live(perpsKey(o)).length, 0);
    assert.equal(orch.hasLeaseForTest(perpsKey(o) as `0x${string}`), false);
  });
});

describe("the fleet feed's held markets", () => {
  it("an unreadable book keeps the markets it last read: its positions still need prices to close at their stops", async () => {
    const a = ownerAt(0x7a), b = ownerAt(0x7b);
    for (const [o, acct] of [[a, address(0x7c)], [b, address(0x7d)]] as const) {
      await perps.put(o, grant(o, acct, { purpose: "perps" }));
      await settingsStores.getSettingsStore("perps").put(o, { perpsEnabled: true, perpsMarkets: ["BTC-PERP"] });
    }
    await orch.reconcile();
    await settle();
    // Each book holds a paper position outside the markets its settings want.
    for (const [o, market] of [[a, 16], [b, 3]] as const) {
      const raw = new DatabaseSync(path.join(orch.childHome(perpsKey(o)), "merrymen.db"));
      await applyLedgerSchema(wrapSqlite(raw));
      raw.prepare(`INSERT INTO perp_positions (agent_id, mode, market_id, side, base, allocated_margin_micro, source) VALUES (?, 'paper', ?, 'long', '1', '1000000', 'paper')`)
        .run(o, market);
      raw.close();
    }
    await orch.refreshPerpsFeedForTest();
    assert.deepEqual([...orch.perpsFeedMarketsForTest()!.markets], [1, 3, 16], "BTC wanted, SOL and TSLA held");
    const book = path.join(orch.childHome(perpsKey(b)), "merrymen.db");
    chmodSync(book, 0o000);
    try {
      await orch.refreshPerpsFeedForTest();
      assert.deepEqual([...orch.perpsFeedMarketsForTest()!.markets], [1, 3, 16], "SOL stays while b's book will not read");
    } finally {
      chmodSync(book, 0o600);
    }
  });
});

describe("the public reads' exclusion record (perps-wallets.ts)", () => {
  it("names a Perps wallet before its worker first starts, and a record that cannot be written starts none", async () => {
    const { readPerpsWallets } = await import("./perps-wallets");
    const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw);
    await applyLedgerSchema(shared);
    await shared.exec(MIRROR_STATE_DDL);
    orch.setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
    try {
      const o = ownerAt(0x5a), p = ownerAt(0x6a);
      await spot.put(o, grant(o, address(0x5b)));
      await perps.put(o, grant(o, address(0x5c), { purpose: "perps" }));
      await orch.reconcile();
      await settle();
      assert.equal(live(perpsKey(o)).length, 1);
      assert.deepEqual([...await readPerpsWallets(shared)], [address(0x5c)], "the Perps account, and never the Spot one");
      // A shared database that refuses the record: no Perps worker starts.
      raw.exec("CREATE TRIGGER refuse_perps_wallets BEFORE INSERT ON perps_wallets BEGIN SELECT RAISE(ABORT, 'refused'); END");
      await perps.put(p, grant(p, address(0x6c), { purpose: "perps" }));
      await orch.reconcile();
      await settle();
      assert.equal(all(perpsKey(p)).length, 0, "no record, no worker");
      assert.ok(said.some((l) => l.includes("could not be put on the public reads' exclusion record")));
    } finally {
      orch.setRetirementMemoryStoreForTest(null);
      raw.close();
    }
  });
});
