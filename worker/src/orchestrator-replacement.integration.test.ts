/** Permission replacement stops the old worker while retaining its memory and ledger. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import type { TenantLease } from "./tenant-lease";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-replacement-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 23).toString("base64");

const {
  adoptChildForTest, childHome, hasLeaseForTest, isRetiringExpiredForTest,
  reconcile, honourPendingKills, setPaperRestoreForTest, setRetirementMirrorForTest, setSpawnForTest,
} = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore } = await import("./settings-store");
const { TgGroupsStore } = await import("./telegram/tg-groups/store");
const { writeKillRequest, KILL_CLOCK_SLACK_SEC } = await import("./kill-request");

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const now = Math.floor(Date.now() / 1000);
const owner = address(0xd91);
const account = address(0xd92);
const chat = -100424242;
const grantFor = (keyByte = "ab"): StoredGrant => ({
  smartAccount: account,
  owner,
  sessionKeyAddress: address(keyByte === "ab" ? 0xd93 : 0xd94),
  serialized: "eyJ-a-replacement-test",
  chainId: 4663,
  grantedAt: now - 60,
  expiresAt: now + 86_400,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"],
  grantTokens: [],
  demoSessionPrivateKey: `0x${keyByte.repeat(32)}`,
}) as unknown as StoredGrant;

class FakeProc extends EventEmitter {
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  constructor(readonly pid: number) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    return true;
  }
  exit(): void { this.emit("exit", 0, "SIGTERM"); }
}

const spawned: FakeProc[] = [];
setSpawnForTest(() => {
  const proc = new FakeProc(47_000 + spawned.length);
  spawned.push(proc);
  return proc as unknown as ChildProcess;
});

after(() => {
  setPaperRestoreForTest(null);
  setRetirementMirrorForTest(null);
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Real soul files, a real conversation row, and approved group memory. */
function seedMemory(tenant: `0x${string}`): () => void {
  const home = childHome(tenant);
  mkdirSync(path.join(home, "soul"), { recursive: true });
  const soul = "# What I know about my owner\n- (2026-10-03) Their project is Sherwood.\n";
  writeFileSync(path.join(home, "soul", "OWNER.md"), soul);
  const dbFile = path.join(home, "merrymen.db");
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE chat_turns (chat_id INTEGER, content TEXT); INSERT INTO chat_turns VALUES (424242, 'We discussed Sherwood.');");
  db.close();
  const groups = TgGroupsStore.open(home);
  groups.ensureRoom(chat, { title: "Sherwood", kind: "supergroup" });
  groups.setStatus(chat, "approved", 424242);
  groups.update(chat, (room) => { room.summary = "The group is discussing Sherwood."; });
  groups.close();
  const groupFile = path.join(home, "tg-groups.json");
  const groupText = readFileSync(groupFile, "utf8");
  return () => {
    assert.equal(readFileSync(path.join(home, "soul", "OWNER.md"), "utf8"), soul);
    assert.equal(readFileSync(groupFile, "utf8"), groupText, "approval and group memory are preserved");
    const resumed = new DatabaseSync(dbFile, { readOnly: true });
    try {
      assert.equal((resumed.prepare("SELECT content FROM chat_turns WHERE chat_id = 424242").get() as { content: string }).content,
        "We discussed Sherwood.");
    } finally { resumed.close(); }
  };
}

it("retains soul, DM and group history through a replacement stop, exit, failed mirror and fresh-key resume", async () => {
  const tenant = address(0xd11);
  const store = getGrantStore();
  const assertMemory = seedMemory(tenant);
  const old = new FakeProc(46_001);
  let releases = 0;
  const lease: TenantLease = { tenant, backend: "postgres", healthy: () => true, async release() { releases++; } };
  await store.put(tenant, grantFor());
  adoptChildForTest(tenant, account, old, lease);
  let mirrors = 0;
  let mirrorSucceeds = false;
  setRetirementMirrorForTest(async () => { mirrors++; return mirrorSucceeds; });
  const before = spawned.length;

  assert.equal(await store.stopForReplacement(tenant, account), "stopped");
  assert.equal(await store.get(tenant), null, "stopped key is unavailable");
  await reconcile();
  assert.equal(old.signals[0], "SIGTERM");
  assert.equal(isRetiringExpiredForTest(tenant), true);
  assert.equal(hasLeaseForTest(tenant), true);
  assert.equal(mirrors, 0, "the old writer must exit before the final mirror");
  assertMemory();

  old.exit();
  await reconcile();
  assert.equal(mirrors, 1);
  assert.equal(releases, 0);
  assert.equal(spawned.length, before, "no key is armed while replacement is pending");
  assertMemory();

  await store.put(tenant, { ...grantFor("cd"), grantedAt: now });
  await reconcile();
  assert.equal(spawned.length, before, "a fresh key cannot bypass a failed final mirror");
  assert.equal(hasLeaseForTest(tenant), true);
  assertMemory();

  mirrorSucceeds = true;
  await reconcile();
  assert.equal(releases, 1);
  assert.equal(isRetiringExpiredForTest(tenant), false);
  assert.equal(spawned.length, before + 1);
  assertMemory();
  const localGrant = JSON.parse(readFileSync(path.join(childHome(tenant), "grant.json"), "utf8")) as StoredGrant;
  assert.equal(localGrant.demoSessionPrivateKey, grantFor("cd").demoSessionPrivateKey, "only the fresh authority reaches the resumed worker");

  await store.remove(tenant);
  await reconcile();
  assert.ok(existsSync(childHome(tenant)), "explicit deletion waits for the old writer to exit");
  spawned.at(-1)!.exit();
  await reconcile();
  assert.ok(existsSync(path.join(childHome(tenant), "merrymen.db")), "the original accounting source survives explicit removal");
  assert.equal(existsSync(path.join(childHome(tenant), "soul", "OWNER.md")), false, "explicit removal still forgets personal memory");
  assert.equal(existsSync(path.join(childHome(tenant), "tg-groups.json")), false);
  assert.equal(existsSync(path.join(childHome(tenant), "grant.json")), false, "the stopped hosted signing-key cache is removed after exit");
  setRetirementMirrorForTest(null);
});

for (const unreadable of [false, true]) {
  it(`does not forget an unusable key's groups when the public roster is ${unreadable ? "unreadable" : "retained"}`, async () => {
    const tenant = address(unreadable ? 0xd21 : 0xd22);
    const store = getGrantStore();
    await store.put(tenant, grantFor());
    const assertMemory = seedMemory(tenant);
    const before = spawned.length;
    const originalGet = store.get;
    const originalList = store.listTenants;
    const originalExpiries = store.listTenantExpiries;
    store.get = async (t) => t === tenant ? null : originalGet.call(store, t);
    if (unreadable) {
      store.listTenantExpiries = async () => [{ tenant, expiresAt: now + 86_400 }];
      store.listTenants = async () => { throw new Error("grant roster temporarily unavailable"); };
    }
    try {
      await reconcile();
      assert.equal(spawned.length, before, "an unusable grant never starts a worker");
      assertMemory();
    } finally {
      store.get = originalGet;
      store.listTenants = originalList;
      store.listTenantExpiries = originalExpiries;
      await store.remove(tenant);
      await reconcile();
    }
  });
}

for (const changed of ["stopped", "changed", "unreadable"] as const) {
  it(`refuses to fork an earlier key when authority becomes ${changed} during preparation`, async () => {
    const tenant = address(changed === "stopped" ? 0xd31 : changed === "changed" ? 0xd32 : 0xd33);
    const store = getGrantStore();
    const original = grantFor();
    await store.put(tenant, original);
    const assertMemory = seedMemory(tenant);
    const before = spawned.length;
    const originalGet = store.get;
    setPaperRestoreForTest(async () => {
      if (changed === "stopped") {
        assert.equal(await store.stopForReplacement(tenant, account), "stopped");
      } else if (changed === "changed") {
        // Identical advertised metadata cannot disguise a different actual key.
        await store.put(tenant, { ...original, demoSessionPrivateKey: grantFor("cd").demoSessionPrivateKey });
      } else {
        store.get = async () => { throw new Error("grant temporarily unreadable"); };
      }
      return { ok: true, line: null };
    });
    try {
      await reconcile();
      assert.equal(spawned.length, before, "the prepared key is never handed to a worker");
      assertMemory();
    } finally {
      setPaperRestoreForTest(null);
      store.get = originalGet;
      await store.remove(tenant);
      await reconcile();
    }
  });
}

for (const authority of ["stopped", "expired", "unreadable"] as const) {
  it(`does not start a held bot when authority becomes ${authority} during practice-book preparation`, async () => {
    const tenant = address(authority === "stopped" ? 0xd41 : authority === "expired" ? 0xd42 : 0xd43);
    const store = getGrantStore(), originalGet = store.get;
    const original = grantFor();
    await store.put(tenant, original);
    await getSettingsStore().put(tenant, {
      paperTradingEnabled: true, telegramEnabled: true, telegramBotToken: "111:holder-authority", telegramAllowlist: [424242],
    } as never);
    const assertMemory = seedMemory(tenant), before = spawned.length;
    setPaperRestoreForTest(async () => {
      if (authority === "stopped") await store.stopForReplacement(tenant, account);
      else if (authority === "expired") await store.put(tenant, { ...original, expiresAt: now - 1 });
      else store.get = async () => { throw new Error("injected authority read failure"); };
      return { ok: false, reason: "paper fills are newer than the recoverable valuation" };
    });
    try {
      await reconcile();
      assert.equal(spawned.length, before, "a non-trading holder is still a memory writer and must respect the stop");
      assertMemory();
    } finally {
      store.get = originalGet;
      setPaperRestoreForTest(null);
      await store.remove(tenant);
      await reconcile();
    }
  });
}

it("an explicit kill with no running process clears local personal memory before the same wallet can regrant", async () => {
  const tenant = address(0xd51), store = getGrantStore(), original = grantFor();
  await store.put(tenant, original);
  seedMemory(tenant);
  const home = childHome(tenant), file = path.join(home, "merrymen.db");
  const book = new DatabaseSync(file);
  book.exec("CREATE TABLE finance_sentinel (amount INTEGER); INSERT INTO finance_sentinel VALUES (39)");
  book.close();
  const killedAt = Math.floor(Date.now() / 1000);
  writeKillRequest(home, original, killedAt);
  await honourPendingKills();
  assert.equal(await store.get(tenant), null);
  assert.equal(existsSync(path.join(home, "soul", "OWNER.md")), false);
  assert.equal(existsSync(path.join(home, "tg-groups.json")), false);
  const wiped = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal((wiped.prepare("SELECT COUNT(*) AS n FROM chat_turns WHERE chat_id > 0").get() as { n: number }).n, 0);
    assert.equal((wiped.prepare("SELECT amount FROM finance_sentinel").get() as { amount: number }).amount, 39, "memory cleanup never changes financial tables");
  } finally { wiped.close(); }
  const clock = Date.now;
  const afterKillMs = (killedAt + KILL_CLOCK_SLACK_SEC + 1) * 1000;
  const before = spawned.length;
  try {
    Date.now = () => afterKillMs;
    await store.put(tenant, { ...grantFor("cd"), grantedAt: Math.floor(afterKillMs / 1000) });
    await reconcile();
    assert.equal(spawned.length, before + 1);
    assert.equal(existsSync(path.join(home, "soul", "OWNER.md")), false, "no local owner memory is resurrected by regrant");
    const renewed = new DatabaseSync(file, { readOnly: true });
    try { assert.equal((renewed.prepare("SELECT COUNT(*) AS n FROM chat_turns WHERE chat_id > 0").get() as { n: number }).n, 0); }
    finally { renewed.close(); }
  } finally {
    Date.now = clock;
    await store.remove(tenant);
    await reconcile();
    spawned.at(-1)?.exit();
  }
});
