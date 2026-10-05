/**
 * ONE TENANT CANNOT CRASH THE SUPERVISOR.
 *
 * spawnChild prepares a worker through a dozen awaits, and the recovery reply
 * gates added at the end of that preparation are built to throw: the privacy
 * proof (recoveryReplyPrivacyAllowsFork) and the poll offset handoff
 * (handoffRecoveryReplyOffset) refuse by rejecting, and so does the pool
 * (makePgDb) when Postgres will not answer. Nothing between them and the main
 * loop caught it. reconcile() awaits spawnChild, the main loop awaits
 * reconcile(), runOrchestrator is started with `void`, and nothing in the
 * worker handles an unhandled rejection — so one tenant's refusal exited the
 * whole orchestrator: every other tenant's worker, hold and reply with it,
 * then again on every restart, for as long as that tenant's state stayed the
 * same.
 *
 * Each refusal must instead hold its own tenant: an [alert] naming it, no
 * worker and no hold process, its lease and home retained, and the pass
 * carried on. Driven through the real reconcile() over the file-backed grant
 * and settings stores, with the shared database a sqlite stand-in where the
 * orchestrator has a seam for it (setRetirementMemoryStoreForTest,
 * setPersonalMemoryStoreForTest) and an address nothing answers where it does
 * not. The stores are taken before DATABASE_URL is set, so they stay on files.
 *
 * MERRYMEN_HOME is per process (node --test forks per file), so this never
 * leaks into another test file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";
import type { TenantLease } from "./tenant-lease";

const FLEET = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-spawn-guard-")));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
const DEK = Buffer.alloc(32, 11);
process.env.MERRYMEN_STORE_DEK = DEK.toString("base64");
process.env.MERRYMEN_TICK_SECONDS = "60";

const {
  reconcile, childHome, isHeldForTest, hasLeaseForTest, setPaperRestoreForTest, setPersistentHomeVerifierForTest,
  setPersonalMemoryStoreForTest, setRetirementMemoryStoreForTest, setSpawnForTest, setTenantLeaseForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore } = await import("./settings-store");
const { MIRROR_STATE_DDL } = await import("./ledger-mirror");
const { RECOVERY_REPLY_SCHEMA, sealRecoveryReplyState } = await import("./recovery-reply-state");

// Taken now, while DATABASE_URL is unset, so both stay on files for the whole
// file once it is set below.
const store = getGrantStore();
const settingsStore = getSettingsStore();
// A hosted deployment from here on: every recovery gate runs. Nothing answers
// at this address (and `pg` is not installed here), so every pool the
// orchestrator opens for itself rejects, as one does when Postgres is down.
process.env.DATABASE_URL = "postgres://spawn-guard.invalid/not-a-real-connection";
// Not a Railway volume: the persistent-book gates stand aside, as self-hosted.
setPersistentHomeVerifierForTest(() => null);

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const grant = (account: `0x${string}`, n: number): StoredGrant =>
  ({
    smartAccount: account,
    owner: addr(0x5c00 + n),
    sessionKeyAddress: addr(0x5d00 + n),
    serialized: "disposable spawn-guard fixture",
    chainId: 4663,
    grantedAt: Math.floor(Date.now() / 1000) - 3600,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
    grantFeatures: ["tradeable-v2"],
    grantTokens: [],
    demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
  }) as unknown as StoredGrant;

/** A process reduced to what the orchestrator does with one. None should start here. */
class FakeProc extends EventEmitter {
  static next = 61_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  kill(): boolean {
    setImmediate(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}
const spawned: string[] = [];
setSpawnForTest((_cmd, args) => {
  spawned.push(args.some((a) => a.endsWith("telegram-hold.ts")) ? "hold" : "worker");
  return new FakeProc() as unknown as ChildProcess;
});

/** What the orchestrator said. */
const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => {
  said.push(a.map(String).join(" "));
};

/** The shared database's stand-in, fresh for each test, with the recovery reply tables. */
function ledger(): { raw: DatabaseSync; shared: Db } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(RECOVERY_REPLY_SCHEMA);
  raw.exec(MIRROR_STATE_DDL);
  return { raw, shared: wrapSqlite(raw) };
}
const opened: DatabaseSync[] = [];
function useLedger(retirement: boolean): { raw: DatabaseSync; shared: Db } {
  const l = ledger();
  opened.push(l.raw);
  // Personal memory always restores, so preparation reaches the gates below.
  setPersonalMemoryStoreForTest({ shared: l.shared, dek: DEK, dialect: "sqlite" });
  setRetirementMemoryStoreForTest(retirement ? { shared: l.shared, dek: DEK, dialect: "sqlite" } : null);
  return l;
}

let next = 0;
/** A wanted tenant, its stored settings, and the lease reconcile would have taken before its first spawn. */
async function wanted(settings: Record<string, unknown> | null) {
  const n = ++next;
  const tenant = addr(0x5a00 + n);
  const account = addr(0x5b00 + n);
  await store.put(tenant, grant(account, n));
  if (settings) await settingsStore.put(tenant, settings as never);
  const released = { n: 0 };
  const lease: TenantLease = { tenant, backend: "postgres", healthy: () => true, async release() { released.n++; } };
  setTenantLeaseForTest(tenant, lease);
  return { tenant, account, released, home: childHome(tenant) };
}
const live: `0x${string}`[] = [];
afterEach(async () => {
  for (const tenant of live.splice(0)) {
    await store.remove(tenant);
    await settingsStore.remove(tenant);
    setTenantLeaseForTest(tenant, null);
    rmSync(childHome(tenant), { recursive: true, force: true });
  }
  setPaperRestoreForTest(null);
});
after(() => {
  console.log = realLog;
  setPersistentHomeVerifierForTest(null);
  setPersonalMemoryStoreForTest(null);
  setRetirementMemoryStoreForTest(null);
  for (const raw of opened) raw.close();
  rmSync(FLEET, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** The [alert] lines for this tenant, by its prefix. */
const alerts = (tenant: string) => said.filter((l) => l.startsWith(`[orchestrator] [alert] ${tenant}: `));
const PAPER_OK = async () => ({ ok: true as const, line: null });
const BOT = { telegramEnabled: true, telegramBotToken: "8801:spawn_guard_fixture" };

describe("a refusal at the end of preparation holds its tenant, not the fleet", () => {
  it("A PRIVACY REFUSAL: a durable erasure the retained group file cannot be proved against", async () => {
    const { raw } = useLedger(true);
    setPaperRestoreForTest(PAPER_OK);
    const t = await wanted(null);
    live.push(t.tenant);
    // A group forget journaled while the tenant was stopped, and a group file
    // in its home with a second name: the proof will not vouch for a file it
    // cannot be sure is the only copy, and refuses by throwing.
    const op = { id: "00000000-0000-4000-8000-0000000000a1", atMs: 1000, kind: "group" as const, chatId: -11 };
    const row = sealRecoveryReplyState(t.tenant, { version: 1, privacy: [op], turns: [] }, DEK);
    raw.prepare("INSERT INTO tenant_recovery_reply_state VALUES(?,?,?,1000)").run(t.tenant, row.sealed, row.bytes);
    mkdirSync(t.home, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(t.home, "tg-groups.json"), JSON.stringify({ version: 1, rooms: {} }), { mode: 0o600 });
    linkSync(path.join(t.home, "tg-groups.json"), path.join(t.home, "tg-groups.second-name"));

    await assert.doesNotReject(reconcile(), "the refusal does not reject through reconcile");
    assert.equal(spawned.length, 0, "no worker starts over memory the proof could not clear");
    assert.ok(alerts(t.tenant).some((l) => /privacy/.test(l)), said.join("\n"));
    assert.equal(hasLeaseForTest(t.tenant), true, "the tenant stays held by this replica");
    assert.ok(existsSync(path.join(t.home, "tg-groups.json")), "and its retained memory stays for recovery");
    await assert.doesNotReject(reconcile(), "and the next pass holds it again");
    assert.equal(spawned.length, 0);
  });

  it("A HANDOFF REFUSAL: the bot's recovery offset names another tenant", async () => {
    const { raw } = useLedger(true);
    setPaperRestoreForTest(PAPER_OK);
    const t = await wanted(BOT);
    live.push(t.tenant);
    // The recovery listener's high-water mark for this bot belongs to someone
    // else's account. Starting the bot below it could answer old updates again.
    raw.prepare("INSERT INTO recovery_reply_offsets VALUES(?,?,?,?,?,200,101,100,1000)")
      .run("8801", addr(0x5eee), addr(0x5fff), 4663, "a".repeat(16));

    await assert.doesNotReject(reconcile(), "the refusal does not reject through reconcile");
    assert.equal(spawned.length, 0, "no worker polls a bot whose offset could not be handed over");
    assert.ok(alerts(t.tenant).some((l) => /offset/.test(l)), said.join("\n"));
    assert.equal(hasLeaseForTest(t.tenant), true, "the tenant stays held by this replica");
    assert.equal(t.released.n, 0);
    await assert.doesNotReject(reconcile(), "and the next pass holds it again");
    assert.equal(spawned.length, 0);
  });

  it("A HANDOFF REFUSAL WHILE HOLDING: no hold process answers a bot whose offset could not be handed over", async () => {
    const { raw } = useLedger(true);
    // A practice book that will not restore is held (spawnHolder), and its
    // hold process would poll the same bot, so the same handoff runs first.
    setPaperRestoreForTest(async () => ({ ok: false, reason: "paper fills are newer than the recoverable valuation" }));
    const t = await wanted({ ...BOT, paperTradingEnabled: true });
    live.push(t.tenant);
    raw.prepare("INSERT INTO recovery_reply_offsets VALUES(?,?,?,?,?,200,101,100,1000)")
      .run("8801", addr(0x5eee), addr(0x5fff), 4663, "a".repeat(16));

    await assert.doesNotReject(reconcile(), "the refusal does not reject through reconcile");
    assert.deepEqual(spawned, [], "neither a worker nor a hold process starts");
    assert.ok(alerts(t.tenant).some((l) => /offset/.test(l)), said.join("\n"));
    assert.equal(isHeldForTest(t.tenant), false, "not recorded as held, so no later refresh starts a hold process without the handoff");
    assert.equal(hasLeaseForTest(t.tenant), true, "the tenant stays held by this replica");
    await assert.doesNotReject(reconcile(), "and the next pass holds it again");
    assert.deepEqual(spawned, []);
  });

  it("A POSTGRES FAILURE: the pool the privacy proof needs will not open", async () => {
    // No stand-in for the recovery store: the orchestrator opens its own pool,
    // at an address nothing answers, as on a deploy while Postgres is down.
    useLedger(false);
    setPaperRestoreForTest(PAPER_OK);
    const t = await wanted(null);
    live.push(t.tenant);

    await assert.doesNotReject(reconcile(), "the failure does not reject through reconcile");
    assert.equal(spawned.length, 0, "no worker starts without the privacy proof");
    assert.ok(alerts(t.tenant).some((l) => /privacy/.test(l)), said.join("\n"));
    assert.ok(!alerts(t.tenant).some((l) => /spawn-guard\.invalid|not-a-real-connection|pg/.test(l)), "and no connection detail is logged");
    assert.equal(hasLeaseForTest(t.tenant), true, "the tenant stays held by this replica");
    await assert.doesNotReject(reconcile(), "and the next pass holds it again");
    assert.equal(spawned.length, 0);
  });
});
