/** A permission stop cannot release its lease before the last sealed memory save. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import type { TenantLease } from "./tenant-lease";
import { ensureTgGroupsSchema, publishTgGroups, restoreTgGroups } from "./tg-groups-ferry";
import { appendForget } from "./telegram/tg-groups/forget-file";
import {
  ensurePersonalMemorySchema, publishPersonalMemory, recordPersonalMemoryForget, restorePersonalMemory,
} from "./personal-memory-ferry";

const fleet = mkdtempSync(path.join(os.tmpdir(), "merrymen-memory-retire-"));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
const dek = Buffer.alloc(32, 71);
process.env.MERRYMEN_STORE_DEK = dek.toString("base64");
const {
  adoptChildForTest, adoptHolderForTest, childHome, hasLeaseForTest,
  finalMirrorBeforeAnchor, isRetiringExpiredForTest, reconcile, setRetirementMemoryStoreForTest, setSpawnForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const raw = new DatabaseSync(":memory:");
const db = wrapSqlite(raw);
await ensureTgGroupsSchema(db, "sqlite");
await ensurePersonalMemorySchema(db, "sqlite");
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const now = Math.floor(Date.now() / 1000);
function grant(account: `0x${string}`, key = "ab"): StoredGrant {
  return {
    smartAccount: account, owner: address(0xb91), sessionKeyAddress: address(0xb92),
    serialized: "eyJ-memory-retire", chainId: 4663, grantedAt: now - 60, expiresAt: now + 86_400,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
    grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${key.repeat(32)}`,
  } as unknown as StoredGrant;
}
class FakeProc extends EventEmitter {
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  constructor(readonly pid: number) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean { this.signals.push(String(signal)); return true; }
  exit(): void { this.emit("exit", 0, "SIGTERM"); }
}
const spawned: FakeProc[] = [];
setSpawnForTest(() => {
  const proc = new FakeProc(65_000 + spawned.length);
  spawned.push(proc);
  return proc as unknown as ChildProcess;
});
after(() => {
  setRetirementMemoryStoreForTest(null);
  raw.close();
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
function memory(summary: string): string {
  return JSON.stringify({
    version: 1, rooms: { "-10071": {
      chatId: -10071, title: "owner's room", status: "approved", summary,
      lines: [{ messageId: 1, fromId: 42, name: "Alice", text: "alice-private-line", atMs: Date.now() }],
    } }, llm: { day: "2026-10-04", used: 7 }, nominations: { day: "2026-10-04", n: 2, entries: 1 },
  });
}
function lease(tenant: `0x${string}`, released: { n: number }): TenantLease {
  return { tenant, backend: "postgres", healthy: () => true, async release() { released.n++; } };
}
async function restoredText(tenant: string): Promise<string> {
  const home = mkdtempSync(path.join(fleet, "restored-"));
  assert.equal(await restoreTgGroups({ tenant, home, shared: db, dek, log: () => {} }), "restored");
  return readFileSync(path.join(home, "tg-groups.json"), "utf8");
}

it("keeps the old process and failed final group save as barriers, then saves its latest approval and summary before rearming", async () => {
  const tenant = address(0xb11), account = address(0xb12);
  const old = new FakeProc(64_001), releases = { n: 0 };
  const home = childHome(tenant);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "tg-groups.json"), memory("previous summary"));
  await publishTgGroups({ tenant, home, shared: db, dek, seen: new Map(), log: () => {} });
  mkdirSync(path.join(home, "soul"));
  writeFileSync(path.join(home, "soul", "OWNER.md"), "previous owner memory");
  await publishPersonalMemory({ tenant, home, shared: db, dek, seen: new Map(), log: () => {} });
  // This change came after the regular mirror's last pass.
  writeFileSync(path.join(home, "tg-groups.json"), memory("final memory from the stopped worker"));
  writeFileSync(path.join(home, "soul", "OWNER.md"), "final owner memory from the stopped worker");
  let failed = true;
  const unavailable: Db = {
    exec: (sql) => db.exec(sql), tx: (fn) => db.tx(fn),
    prepare(sql) {
      const statement = db.prepare(sql);
      return { ...statement, async run(...args) {
        if (failed && /INSERT INTO tenant_(?:tg_groups|personal_memory)/.test(sql)) throw new Error("injected final-memory write failure");
        return statement.run(...args);
      } };
    },
  };
  setRetirementMemoryStoreForTest({ shared: unavailable, dek, dialect: "sqlite" });
  await getGrantStore().put(tenant, grant(account));
  adoptChildForTest(tenant, account, old, lease(tenant, releases));
  await getGrantStore().stopForReplacement(tenant, account);
  await reconcile();
  assert.equal(old.signals[0], "SIGTERM");
  assert.equal(isRetiringExpiredForTest(tenant), true);
  assert.equal(await restoredText(tenant).then((text) => text.includes("previous summary")), true, "no final read before the writer exits");
  old.exit();
  await reconcile();
  assert.equal(hasLeaseForTest(tenant), true);
  assert.equal(releases.n, 0, "failed final save retains its lease");
  const before = spawned.length;
  await getGrantStore().put(tenant, grant(account, "cd"));
  await reconcile();
  assert.equal(spawned.length, before, "fresh authority cannot bypass an unsaved memory barrier");
  failed = false;
  await reconcile();
  assert.equal(releases.n, 1);
  assert.equal(isRetiringExpiredForTest(tenant), false);
  assert.equal(spawned.length, before + 1);
  const final = JSON.parse(await restoredText(tenant));
  assert.equal(final.rooms["-10071"].status, "approved");
  assert.equal(final.rooms["-10071"].summary, "final memory from the stopped worker");
  assert.equal(final.llm.used, 7, "daily allowances are retained");
  const personalHome = mkdtempSync(path.join(fleet, "restored-personal-"));
  assert.equal(await restorePersonalMemory({ tenant, home: personalHome, shared: db, dek, log: () => {} }), "restored");
  assert.equal(readFileSync(path.join(personalHome, "soul", "OWNER.md"), "utf8"), "final owner memory from the stopped worker");
  await getGrantStore().remove(tenant);
  await reconcile();
  spawned.at(-1)!.exit();
  setRetirementMemoryStoreForTest(null);
});

it("held retirement patches forget requests without publishing its stale local group file", async () => {
  const tenant = address(0xb21), account = address(0xb22);
  const old = new FakeProc(64_002), home = childHome(tenant);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "tg-groups.json"), memory("durable group summary"));
  await publishTgGroups({ tenant, home, shared: db, dek, seen: new Map(), log: () => {} });
  mkdirSync(path.join(home, "soul"));
  writeFileSync(path.join(home, "soul", "OWNER.md"), "private owner fact to forget");
  await publishPersonalMemory({ tenant, home, shared: db, dek, seen: new Map(), log: () => {} });
  writeFileSync(path.join(home, "tg-groups.json"), memory("stale held memory must not win"));
  writeFileSync(path.join(home, "soul", "OWNER.md"), "stale held owner memory must not win");
  appendForget(home, { chatId: -10071, userId: 42, atMs: Date.now() });
  recordPersonalMemoryForget({ kind: "owner" }, home);
  setRetirementMemoryStoreForTest({ shared: db, dek, dialect: "sqlite" });
  await getGrantStore().put(tenant, grant(account));
  await adoptHolderForTest(tenant, account, old as unknown as ChildProcess);
  await getGrantStore().stopForReplacement(tenant, account);
  await reconcile();
  old.exit();
  await reconcile();
  assert.equal(isRetiringExpiredForTest(tenant), false);
  const final = await restoredText(tenant);
  assert.ok(!final.includes("stale held memory must not win"));
  assert.ok(!final.includes("alice-private-line"), "the final held pass honours its forget journal");
  const personalHome = mkdtempSync(path.join(fleet, "restored-personal-"));
  assert.equal(await restorePersonalMemory({ tenant, home: personalHome, shared: db, dek, log: () => {} }), "restored");
  assert.equal(readFileSync(path.join(personalHome, "soul", "OWNER.md"), "utf8"), "", "the final held pass patches the personal forget journal without publishing stale notes");
  await getGrantStore().remove(tenant);
  await reconcile();
  setRetirementMemoryStoreForTest(null);
});

it("a missing DEK keeps the final-memory barrier until a sealed save can succeed", async () => {
  const tenant = address(0xb31), account = address(0xb32);
  const old = new FakeProc(64_003), releases = { n: 0 }, home = childHome(tenant);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "tg-groups.json"), memory("memory requiring encryption"));
  setRetirementMemoryStoreForTest({ shared: db, dek: null, dialect: "sqlite" });
  await getGrantStore().put(tenant, grant(account));
  adoptChildForTest(tenant, account, old, lease(tenant, releases));
  await getGrantStore().stopForReplacement(tenant, account);
  await reconcile();
  old.exit();
  await reconcile();
  assert.equal(releases.n, 0);
  assert.equal(isRetiringExpiredForTest(tenant), true);
  setRetirementMemoryStoreForTest({ shared: db, dek, dialect: "sqlite" });
  await reconcile();
  assert.equal(releases.n, 1);
  assert.ok((await restoredText(tenant)).includes("memory requiring encryption"));
  await getGrantStore().remove(tenant);
  await reconcile();
  setRetirementMemoryStoreForTest(null);
});

it("an unreadable held group row retains both its ciphertext and retirement barrier until its forget can be applied", async () => {
  const tenant = address(0xb41), account = address(0xb42), old = new FakeProc(64_004);
  const home = childHome(tenant);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "tg-groups.json"), memory("recoverable group memory"));
  await publishTgGroups({ tenant, home, shared: db, dek, seen: new Map(), log: () => {} });
  const original = await db.prepare("SELECT sealed FROM tenant_tg_groups WHERE tenant = ?").get(tenant) as { sealed: string };
  appendForget(home, { chatId: -10071, userId: 42, atMs: Date.now() });
  setRetirementMemoryStoreForTest({ shared: db, dek: Buffer.alloc(32, 72), dialect: "sqlite" });
  await getGrantStore().put(tenant, grant(account));
  await adoptHolderForTest(tenant, account, old as unknown as ChildProcess);
  await getGrantStore().stopForReplacement(tenant, account);
  await reconcile();
  old.exit();
  await reconcile();
  assert.equal(isRetiringExpiredForTest(tenant), true);
  assert.equal(hasLeaseForTest(tenant), true);
  assert.equal((await db.prepare("SELECT sealed FROM tenant_tg_groups WHERE tenant = ?").get(tenant) as { sealed: string }).sealed, original.sealed);
  setRetirementMemoryStoreForTest({ shared: db, dek, dialect: "sqlite" });
  await reconcile();
  assert.equal(isRetiringExpiredForTest(tenant), false);
  assert.ok(!(await restoredText(tenant)).includes("alice-private-line"));
  await getGrantStore().remove(tenant);
  await reconcile();
  setRetirementMemoryStoreForTest(null);
});

async function rebuiltBook(tenant: `0x${string}`, account: `0x${string}`, sourceId = 1) {
  const home = childHome(tenant);
  mkdirSync(home, { recursive: true });
  const sourceRaw = new DatabaseSync(path.join(home, "merrymen.db")), source = wrapSqlite(sourceRaw);
  await applyLedgerSchema(source);
  await applyLedgerSchema(db);
  await db.exec(MIRROR_STATE_DDL);
  for (const ledger of [source, db]) {
    await ledger.prepare(`INSERT INTO agents
      (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, hwm_usdg, mode)
      VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 120, 'live')`).run(account, tenant, address(0xb92));
  }
  await db.prepare(`INSERT INTO positions
    (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, value_usdg, updated_at)
    VALUES (?, 'COIN', ?, '10', '1', 1, 10, 100)`).run(account, tenant);
  await db.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, 'trades', 100, 100, 100)").run(tenant);
  sourceRaw.prepare(`INSERT INTO trades (id, agent_id, kind, target, amount_usdg, status, created_at)
    VALUES (?, ?, 'swap', 'fixture', 1, 'rejected', ?)`).run(sourceId, account, sourceId === 100 ? 100 : 200);
  return { home, sourceRaw };
}
async function savedPositionCount(account: string) {
  return Number((await db.prepare("SELECT count(*) AS n FROM positions WHERE agent_id = ?").get(account) as { n: number }).n);
}
async function savedTradeCursor(tenant: string) {
  return Number((await db.prepare("SELECT last_id FROM mirror_state WHERE tenant = ? AND table_name = 'trades'").get(tenant) as { last_id: number }).last_id);
}

it("a rebuilt retirement source never advances its stale cursor or erases the shared position on repeat or renewed authority", async () => {
  const tenant = address(0xb51), account = address(0xb52), old = new FakeProc(64_005), releases = { n: 0 };
  const { sourceRaw } = await rebuiltBook(tenant, account);
  try {
    setRetirementMemoryStoreForTest({ shared: db, dek, dialect: "sqlite" });
    await getGrantStore().put(tenant, grant(account));
    adoptChildForTest(tenant, account, old, lease(tenant, releases));
    await getGrantStore().stopForReplacement(tenant, account);
    await reconcile(); old.exit(); await reconcile();
    assert.equal(await savedTradeCursor(tenant), 100, "preflight preserves the original witness before mirror mutation");
    assert.equal(await savedPositionCount(account), 1);
    await getGrantStore().put(tenant, grant(account, "cd"));
    const before = spawned.length;
    await reconcile(); await reconcile();
    assert.equal(await savedTradeCursor(tenant), 100);
    assert.equal(await savedPositionCount(account), 1, "the second pass cannot mistake a forgotten position for a closed one");
    assert.equal(spawned.length, before, "a fresh permission cannot bypass accounting continuity");
    assert.equal(isRetiringExpiredForTest(tenant), true);
    assert.equal(hasLeaseForTest(tenant), true);
    assert.equal(releases.n, 0);
  } finally { sourceRaw.close(); setRetirementMemoryStoreForTest(null); }
});

it("an unexpected source rewind leaves a durable guard which refuses a second copy and a new worker", async () => {
  const tenant = address(0xb61), account = address(0xb62);
  const { home, sourceRaw } = await rebuiltBook(tenant, account, 100);
  let changed = false;
  const changesAfterPreflight: Db = {
    exec: (sql) => db.exec(sql), tx: (fn) => db.tx(fn),
    prepare(sql) {
      const statement = db.prepare(sql);
      return { ...statement, async get(...args) {
        const result = await statement.get(...args);
        if (!changed && /SELECT last_id, last_stamp FROM mirror_state/.test(sql) && args[1] === "fee_accruals") {
          changed = true;
          sourceRaw.prepare("DELETE FROM trades WHERE agent_id = ?").run(account);
          sourceRaw.prepare(`INSERT INTO trades (id, agent_id, kind, target, amount_usdg, status, created_at)
            VALUES (1, ?, 'swap', 'fixture', 1, 'rejected', 200)`).run(account);
        }
        return result;
      } };
    },
  };
  try {
    assert.equal(await finalMirrorBeforeAnchor(tenant, changesAfterPreflight), false);
    assert.equal(changed, true);
    assert.equal(await savedTradeCursor(tenant), 1, "the first real mirror reports the unexpected rewind after moving its cursor");
    assert.equal(await savedPositionCount(account), 1);
    const marker = path.join(home, "ledger-source-blocked.json");
    assert.equal(existsSync(marker), true, "the recovery barrier survives outside supervisor process memory");
    assert.equal(await finalMirrorBeforeAnchor(tenant, db), false);
    assert.equal(await savedPositionCount(account), 1, "a second pass is refused before it can clear the protected snapshot");
    setRetirementMemoryStoreForTest({ shared: db, dek, dialect: "sqlite" });
    await getGrantStore().put(tenant, grant(account));
    const before = spawned.length;
    await reconcile();
    assert.equal(spawned.length, before, "startup observes the durable marker even without a retirement entry");
    assert.equal(existsSync(marker), true);
  } finally { sourceRaw.close(); setRetirementMemoryStoreForTest(null); }
});
