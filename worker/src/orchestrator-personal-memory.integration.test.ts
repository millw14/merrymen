/** Real sealed notes/DM restore is a startup gate for workers and practice holders. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";
import { ensurePersonalMemorySchema, publishPersonalMemory } from "./personal-memory-ferry";

const fleet = mkdtempSync(path.join(os.tmpdir(), "merrymen-personal-startup-"));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
const dek = Buffer.alloc(32, 73);
process.env.MERRYMEN_STORE_DEK = dek.toString("base64");
const {
  childHome, hasLeaseForTest, isHeldForTest, reconcile,
  setPaperRestoreForTest, setPersonalMemoryStoreForTest, setSpawnForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const sharedRaw = new DatabaseSync(":memory:"), shared = wrapSqlite(sharedRaw);
await ensurePersonalMemorySchema(shared, "sqlite");
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const now = Math.floor(Date.now() / 1000);
const grant = (account: `0x${string}`) => ({
  smartAccount: account, owner: address(0xa91), sessionKeyAddress: address(0xa92),
  serialized: "eyJ-personal-memory", chainId: 4663, grantedAt: now - 60, expiresAt: now + 86_400,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
}) as unknown as StoredGrant;
class FakeProc extends EventEmitter {
  readonly stdout = null;
  readonly stderr = null;
  constructor(readonly pid: number) { super(); }
  kill(): boolean { return true; }
  exit(): void { this.emit("exit", 0, "SIGTERM"); }
}
const spawned: FakeProc[] = [];
setSpawnForTest(() => {
  const proc = new FakeProc(75_000 + spawned.length);
  spawned.push(proc);
  return proc as unknown as ChildProcess;
});
after(() => {
  setPersonalMemoryStoreForTest(null);
  setPaperRestoreForTest(null);
  sharedRaw.close();
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
async function seed(tenant: string): Promise<void> {
  const home = mkdtempSync(path.join(fleet, "source-"));
  mkdirSync(path.join(home, "soul"));
  writeFileSync(path.join(home, "soul", "OWNER.md"), "owner remembers the green kite");
  writeFileSync(path.join(home, "soul", "NOTES.md"), "keep the same cautious personality");
  const raw = new DatabaseSync(path.join(home, "merrymen.db"));
  raw.exec("CREATE TABLE chat_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, memory_ids TEXT, at INTEGER NOT NULL)");
  raw.prepare("INSERT INTO chat_turns (chat_id,role,content,at) VALUES (?,?,?,?)").run(42, "user", "remember our last conversation", now);
  raw.close();
  assert.equal(await publishPersonalMemory({ tenant, home, shared, dek, seen: new Map(), log: () => {} }), "published");
}
async function cleanup(tenant: `0x${string}`): Promise<void> {
  await getGrantStore().remove(tenant);
  await reconcile();
  spawned.at(-1)?.exit();
  setPersonalMemoryStoreForTest(null);
  setPaperRestoreForTest(null);
}

it("a failed read starts no worker or holder, then restores the same notes and DM history before the retry forks", async () => {
  const tenant = address(0xa11), account = address(0xa12);
  await seed(tenant);
  let unavailable = true, bookAttempts = 0;
  const failing: Db = {
    exec: (sql) => shared.exec(sql), tx: (fn) => shared.tx(fn),
    prepare(sql) {
      const statement = shared.prepare(sql);
      return { ...statement, async get(...args) {
        if (unavailable && /FROM tenant_personal_memory/.test(sql)) throw new Error("injected restore read failure");
        return statement.get(...args);
      } };
    },
  };
  setPersonalMemoryStoreForTest({ shared: failing, dek, dialect: "sqlite" });
  setPaperRestoreForTest(async () => { bookAttempts++; return { ok: true, line: null }; });
  await getGrantStore().put(tenant, grant(account));
  const before = spawned.length;
  await reconcile();
  assert.equal(spawned.length, before);
  assert.equal(isHeldForTest(tenant), false, "the book/holder lane never bypasses unreadable personal memory");
  assert.equal(bookAttempts, 0);
  assert.equal(hasLeaseForTest(tenant), true);
  unavailable = false;
  await reconcile();
  assert.equal(spawned.length, before + 1);
  const home = childHome(tenant);
  assert.equal(readFileSync(path.join(home, "soul", "OWNER.md"), "utf8"), "owner remembers the green kite");
  assert.equal(readFileSync(path.join(home, "soul", "NOTES.md"), "utf8"), "keep the same cautious personality");
  const raw = new DatabaseSync(path.join(home, "merrymen.db"), { readOnly: true });
  try {
    assert.equal((raw.prepare("SELECT content FROM chat_turns WHERE chat_id = 42").get() as { content: string }).content, "remember our last conversation");
  } finally { raw.close(); }
  await cleanup(tenant);
});

it("tenant-bound unreadable ciphertext preserves surviving local notes and starts no memory writer", async () => {
  const tenant = address(0xa21), account = address(0xa22), other = address(0xa23);
  await seed(tenant);
  await seed(other);
  const original = await shared.prepare("SELECT sealed FROM tenant_personal_memory WHERE tenant = ?").get(tenant) as { sealed: string };
  const foreign = await shared.prepare("SELECT sealed FROM tenant_personal_memory WHERE tenant = ?").get(other) as { sealed: string };
  await shared.prepare("UPDATE tenant_personal_memory SET sealed = ? WHERE tenant = ?").run(foreign.sealed, tenant);
  const home = childHome(tenant);
  mkdirSync(path.join(home, "soul"), { recursive: true });
  writeFileSync(path.join(home, "soul", "OWNER.md"), "surviving local owner memory");
  setPersonalMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
  await getGrantStore().put(tenant, grant(account));
  const before = spawned.length;
  await reconcile();
  assert.equal(spawned.length, before);
  assert.equal(readFileSync(path.join(home, "soul", "OWNER.md"), "utf8"), "surviving local owner memory");
  assert.equal((await shared.prepare("SELECT sealed FROM tenant_personal_memory WHERE tenant = ?").get(tenant) as { sealed: string }).sealed, foreign.sealed, "no fresh writer replaces ciphertext it cannot read");
  await shared.prepare("UPDATE tenant_personal_memory SET sealed = ? WHERE tenant = ?").run(original.sealed, tenant);
  await reconcile();
  assert.equal(spawned.length, before + 1);
  assert.equal(readFileSync(path.join(home, "soul", "OWNER.md"), "utf8"), "surviving local owner memory", "restore does not overwrite the newer surviving file");
  await cleanup(tenant);
});

it("missing DEK defers startup until an encrypted restore is available", async () => {
  const tenant = address(0xa31), account = address(0xa32);
  await seed(tenant);
  setPersonalMemoryStoreForTest({ shared, dek: null, dialect: "sqlite" });
  await getGrantStore().put(tenant, grant(account));
  const before = spawned.length;
  await reconcile();
  assert.equal(spawned.length, before);
  setPersonalMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
  await reconcile();
  assert.equal(spawned.length, before + 1);
  await cleanup(tenant);
});
