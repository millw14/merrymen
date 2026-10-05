import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";
import { FileGrantStore, GRANT_STORE_LOCK_FILE, GrantReplacementConflict, MAX_RETIRED_SESSION_KEYS } from "./grant-store";

const home = mkdtempSync(path.join(os.tmpdir(), "mm-replacement-store-"));
const oldEnv = { home: process.env.MERRYMEN_HOME, dek: process.env.MERRYMEN_STORE_DEK };
process.env.MERRYMEN_HOME = home;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 31).toString("base64");
after(() => {
  for (const [key, value] of [["MERRYMEN_HOME", oldEnv.home], ["MERRYMEN_STORE_DEK", oldEnv.dek]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const OLD_KEY = `0x${"19".repeat(32)}` as `0x${string}`;
const FRESH_KEY = `0x${"27".repeat(32)}` as `0x${string}`;
const OLD_SESSION = privateKeyToAccount(OLD_KEY).address;
const FRESH_SESSION = privateKeyToAccount(FRESH_KEY).address;
const grant = (account: `0x${string}`, key = OLD_KEY) => ({
  smartAccount: account, owner: address(1), chainId: 4663,
  sessionKeyAddress: privateKeyToAccount(key).address,
  serialized: Buffer.from(JSON.stringify({ privateKey: key })).toString("base64"),
  demoSessionPrivateKey: key, expiresAt: Math.floor(Date.now() / 1000) + 86_400,
  grantedAt: Math.floor(Date.now() / 1000), grantFeatures: ["tradeable-v2"], grantTokens: [],
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 1, maxOpsPerDay: 50 },
}) as unknown as StoredGrant;

describe("FileGrantStore durable permission replacement stop", () => {
  const store = new FileGrantStore();
  const file = (tenant: string) => path.join(home, "tenants", `${tenant}.json`);

  it("retains roster/account ownership, erases both key copies and returns no usable grant across restart", async () => {
    const tenant = address(11), account = address(101);
    const original = grant(account);
    await store.put(tenant, original);
    const stamp = (JSON.parse(readFileSync(file(tenant), "utf8")) as { updatedAt: number }).updatedAt;
    assert.equal(await store.stopForReplacement(tenant, account, OLD_SESSION), "stopped");
    const raw = readFileSync(file(tenant), "utf8");
    const record = JSON.parse(raw);
    assert.equal(record.sealedSessionKey, "");
    assert.equal(record.grant.serialized, "");
    assert.equal(record.grant.expiresAt, 0);
    assert.equal(record.updatedAt, stamp, "a stop does not supersede a pending explicit /kill");
    assert.ok(!raw.includes(OLD_KEY) && !raw.includes(original.serialized));
    const restarted = new FileGrantStore();
    assert.equal(await restarted.get(tenant), null);
    assert.ok((await restarted.listTenants()).includes(tenant));
    assert.equal((await restarted.listTenantExpiries()).find(row => row.tenant === tenant)?.expiresAt, 0);
    assert.equal(await restarted.tenantForAccount(account), tenant);
    assert.equal(await restarted.stopForReplacement(tenant, account, OLD_SESSION), "stopped", "retry is safe without decrypting an empty key");
  });

  it("refuses the stopped actual key despite forged public metadata or hexadecimal case", async () => {
    const tenant = address(12), account = address(102);
    await store.put(tenant, grant(account));
    await store.stopForReplacement(tenant, account, OLD_SESSION);
    for (const key of [OLD_KEY, `0x${OLD_KEY.slice(2).toUpperCase()}` as `0x${string}`]) {
      await assert.rejects(store.put(tenant, { ...grant(account, key), sessionKeyAddress: FRESH_SESSION }), GrantReplacementConflict);
    }
    assert.equal(await store.get(tenant), null);
    await store.put(tenant, grant(account, FRESH_KEY));
    const current = await store.get(tenant);
    assert.equal(current?.demoSessionPrivateKey, FRESH_KEY);
    assert.equal((current as StoredGrant & { retiredSessionKeyHashes?: unknown }).retiredSessionKeyHashes, undefined, "internal fences are not returned as grant fields");
    const record = JSON.parse(readFileSync(file(tenant), "utf8"));
    assert.equal(record.grant.replacementStop, undefined);
    assert.equal(record.grant.retiredSessionKeyHashes.length, 1);
    await assert.rejects(store.put(tenant, grant(account)), GrantReplacementConflict, "an old tab cannot overwrite the newly armed grant");
    assert.equal((await store.get(tenant))?.demoSessionPrivateKey, FRESH_KEY);
  });

  it("checks the real current session and account before stopping; another tenant is untouched", async () => {
    const tenant = address(13), other = address(14), account = address(103);
    await store.put(tenant, { ...grant(account), sessionKeyAddress: FRESH_SESSION });
    await store.put(other, grant(address(104), FRESH_KEY));
    assert.equal(await store.stopForReplacement(tenant, address(999), OLD_SESSION), "changed");
    assert.equal(await store.stopForReplacement(tenant, account, FRESH_SESSION), "changed", "unverified public metadata cannot identify the actual key");
    assert.equal((await store.get(tenant))?.demoSessionPrivateKey, OLD_KEY);
    assert.equal(await store.stopForReplacement(tenant, account, OLD_SESSION), "stopped");
    assert.equal((await store.get(other))?.demoSessionPrivateKey, FRESH_KEY);
    assert.equal(await store.stopForReplacement(address(998), account), "absent");
  });

  it("a stale replacement stop racing a fresh grant cannot stop the fresh actual key", async () => {
    const tenant = address(15), account = address(105);
    await store.put(tenant, grant(account));
    const lock = new DatabaseSync(path.join(home, "tenants", GRANT_STORE_LOCK_FILE));
    lock.exec("BEGIN IMMEDIATE");
    const stopping = store.stopForReplacement(tenant, account, OLD_SESSION);
    const signing = store.put(tenant, grant(account, FRESH_KEY));
    await new Promise(resolve => setTimeout(resolve, 50));
    lock.exec("COMMIT"); lock.close();
    const state = await stopping;
    await signing;
    assert.ok(state === "stopped" || state === "changed");
    assert.equal((await store.get(tenant))?.demoSessionPrivateKey, FRESH_KEY);
    assert.equal(await store.stopForReplacement(tenant, account, OLD_SESSION), "changed");
    assert.equal((await store.get(tenant))?.demoSessionPrivateKey, FRESH_KEY);
  });

  it("explicit discard and pending kill still remove a replacement-stopped row", async () => {
    const tenant = address(16), account = address(106);
    await store.put(tenant, grant(account));
    const stamp = JSON.parse(readFileSync(file(tenant), "utf8")).updatedAt as number;
    await store.stopForReplacement(tenant, account, OLD_SESSION);
    assert.equal(await store.removeUnlessNewer(tenant, stamp), "removed");
    assert.ok(!(await store.listTenants()).includes(tenant));
    await store.put(tenant, grant(account));
    await store.stopForReplacement(tenant, account, OLD_SESSION);
    await store.remove(tenant);
    assert.ok(!(await store.listTenants()).includes(tenant));
  });

  it("does not treat an unreadable tenant directory as proof that all grants were removed", async () => {
    const dir = path.join(home, "tenants"), preserved = path.join(home, "tenants-kept");
    renameSync(dir, preserved); writeFileSync(dir, "not a directory");
    try { await assert.rejects(store.listTenants(), /ENOTDIR/); }
    finally { rmSync(dir); renameSync(preserved, dir); }
  });

  it("refuses a submitted server-only marker rather than trusting its state", async () => {
    await assert.rejects(store.put(address(17), { ...grant(address(107)), replacementStop: { sessionKeyHash: "forged" } } as StoredGrant), /managed by the service/);
    await assert.rejects(store.put(address(17), { ...grant(address(107)), retiredSessionKeyHashes: [] } as StoredGrant), /managed by the service/);
  });

  it("a full history can stop the existing key but cannot arm another or evict a previous fence", async () => {
    const tenant = address(18), account = address(108);
    const soul = path.join(home, "children", tenant, "soul");
    mkdirSync(soul, { recursive: true });
    writeFileSync(path.join(soul, "OWNER.md"), "retained owner-memory fixture");
    await store.put(tenant, grant(account));
    const record = JSON.parse(readFileSync(file(tenant), "utf8"));
    const fences = Array.from({ length: MAX_RETIRED_SESSION_KEYS }, (_, i) => i.toString(16).padStart(64, "0"));
    record.grant.retiredSessionKeyHashes = fences;
    writeFileSync(file(tenant), JSON.stringify(record));
    assert.equal(await store.stopForReplacement(tenant, account, OLD_SESSION), "stopped", "an already active key stays stoppable at full capacity");
    assert.equal(await store.get(tenant), null);
    assert.deepEqual(JSON.parse(readFileSync(file(tenant), "utf8")).grant.retiredSessionKeyHashes, fences);
    const stopped = readFileSync(file(tenant), "utf8");
    assert.equal(await store.stopForReplacement(tenant, account, OLD_SESSION), "stopped", "last-key stop retry remains idempotent");
    await assert.rejects(store.put(tenant, grant(account, FRESH_KEY)), /history is full.*contact support/);
    assert.equal(readFileSync(file(tenant), "utf8"), stopped, "capacity rejection preserves inactive grant and every fence");
    assert.equal(await store.get(tenant), null);
    assert.equal(await store.tenantForAccount(account), tenant);
    assert.equal(readFileSync(path.join(soul, "OWNER.md"), "utf8"), "retained owner-memory fixture");
  });

  it("the last accepted fresh grant reserves its own stop and a legacy marker counts toward capacity", async () => {
    const tenant = address(19), account = address(109);
    await store.put(tenant, grant(account));
    const record = JSON.parse(readFileSync(file(tenant), "utf8"));
    record.grant.retiredSessionKeyHashes = Array.from({ length: MAX_RETIRED_SESSION_KEYS - 2 }, (_, i) => i.toString(16).padStart(64, "0"));
    writeFileSync(file(tenant), JSON.stringify(record));
    await store.stopForReplacement(tenant, account, OLD_SESSION);
    await store.put(tenant, grant(account, FRESH_KEY));
    assert.equal((await store.get(tenant))?.demoSessionPrivateKey, FRESH_KEY);
    await store.stopForReplacement(tenant, account, FRESH_SESSION);
    const stopped = readFileSync(file(tenant), "utf8"), row = JSON.parse(stopped);
    assert.equal(row.grant.retiredSessionKeyHashes.length, MAX_RETIRED_SESSION_KEYS);
    const nextKey = `0x${"39".repeat(32)}` as `0x${string}`;
    await assert.rejects(store.put(tenant, grant(account, nextKey)), GrantReplacementConflict);
    assert.equal(readFileSync(file(tenant), "utf8"), stopped);
    // Older marker-only records have 255 array hashes plus one stopped hash.
    row.grant.retiredSessionKeyHashes = row.grant.retiredSessionKeyHashes.filter((hash: string) => hash !== row.grant.replacementStop.sessionKeyHash);
    writeFileSync(file(tenant), JSON.stringify(row));
    const legacy = readFileSync(file(tenant), "utf8");
    await assert.rejects(store.put(tenant, grant(account, nextKey)), GrantReplacementConflict);
    assert.equal(readFileSync(file(tenant), "utf8"), legacy);
    assert.equal(await store.get(tenant), null);
  });
});
