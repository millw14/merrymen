/**
 * Opt-in real PostgreSQL coverage for the replacement-stop SQL, scoped to a
 * disposable LOCAL database/schema. Never reads DATABASE_URL.
 * MERRYMEN_TEST_PG_URL=postgres://user@127.0.0.1:port/postgres node --import tsx --test worker/src/grant-replacement.postgres.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";
import { GrantReplacementConflict, MAX_RETIRED_SESSION_KEYS, PgGrantStore } from "./grant-store";
import { openSecret, sealSecret } from "./store-crypto";

interface Client {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: "error" | "end", cb: () => void): void;
}
const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
const pg = url ? createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => Client } : null;
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

test("Postgres: durable replacement stop, fresh-key fencing and concurrent grant intake", { skip: !url, timeout: 30_000 }, async t => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only a disposable local Postgres is allowed");
  const schema = `mm_replacement_${randomBytes(8).toString("hex")}`;
  const admin = new pg!.Client({ connectionString: url! });
  await admin.connect();
  const savedDek = process.env.MERRYMEN_STORE_DEK;
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 31).toString("base64");
  const connections: Client[] = [];
  let pauseStop: (() => Promise<void>) | null = null;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(target);
  scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=3000`);
  const connect = async (connectionString: string) => {
    const client = new pg!.Client({ connectionString });
    await client.connect(); connections.push(client);
    return {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("UPDATE grants SET grant_json") && pauseStop) await pauseStop();
        return client.query(sql, params);
      },
      on: client.on.bind(client), end: client.end.bind(client),
    };
  };
  const one = new PgGrantStore(scoped.toString(), connect);
  const two = new PgGrantStore(scoped.toString(), connect);
  t.after(async () => {
    pauseStop = null;
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally {
      await Promise.allSettled(connections.map(client => client.end()));
      await admin.end();
      if (savedDek === undefined) delete process.env.MERRYMEN_STORE_DEK; else process.env.MERRYMEN_STORE_DEK = savedDek;
    }
  });

  await t.test("keeps the row and account claim while erasing both private-key copies across a new store instance", async () => {
    const tenant = address(201), account = address(301);
    const original = grant(account);
    await one.put(tenant, original);
    const before = (await admin.query(`SELECT updated_at FROM ${schema}.grants WHERE tenant=$1`, [tenant])).rows[0]!;
    assert.equal(await one.stopForReplacement(tenant, account, OLD_SESSION), "stopped");
    const row = (await admin.query(`SELECT * FROM ${schema}.grants WHERE tenant=$1`, [tenant])).rows[0]!;
    const publicGrant = row.grant_json as Record<string, unknown>;
    assert.equal(row.sealed_session_key, "");
    assert.equal(publicGrant.serialized, "");
    assert.equal(publicGrant.expiresAt, 0);
    assert.equal(row.updated_at, before.updated_at);
    assert.ok(!JSON.stringify(row).includes(OLD_KEY) && !JSON.stringify(row).includes(original.serialized));
    assert.throws(() => openSecret(String(row.sealed_session_key), Buffer.alloc(32, 31)), /malformed/, "old readers cannot decrypt signing capability");
    assert.equal(await two.get(tenant), null);
    assert.ok((await two.listTenants()).includes(tenant));
    assert.equal((await two.listTenantExpiries()).find(row => row.tenant === tenant)?.expiresAt, 0);
    assert.equal(await two.tenantForAccount(account), tenant);
    assert.equal(await two.stopForReplacement(tenant, account, OLD_SESSION), "stopped");
  });

  await t.test("conditional upsert rejects the actual stopped key, independent of public metadata or key case", async () => {
    const tenant = address(202), account = address(302);
    await one.put(tenant, grant(account));
    await one.stopForReplacement(tenant, account, OLD_SESSION);
    for (const key of [OLD_KEY, `0x${OLD_KEY.slice(2).toUpperCase()}` as `0x${string}`]) {
      await assert.rejects(two.put(tenant, { ...grant(account, key), sessionKeyAddress: FRESH_SESSION }), GrantReplacementConflict);
    }
    assert.equal(await one.get(tenant), null);
    await two.put(tenant, grant(account, FRESH_KEY));
    const current = await one.get(tenant);
    assert.equal(current?.demoSessionPrivateKey, FRESH_KEY);
    assert.equal((current as StoredGrant & { retiredSessionKeyHashes?: unknown }).retiredSessionKeyHashes, undefined);
    const row = (await admin.query(`SELECT grant_json FROM ${schema}.grants WHERE tenant=$1`, [tenant])).rows[0]!;
    assert.equal((row.grant_json as Record<string, unknown>).replacementStop, undefined);
    assert.equal(((row.grant_json as Record<string, unknown>).retiredSessionKeyHashes as unknown[]).length, 1);
    await assert.rejects(one.put(tenant, grant(account)), GrantReplacementConflict, "a later old-tab POST must not replace the fresh grant");
    assert.equal((await two.get(tenant))?.demoSessionPrivateKey, FRESH_KEY);
  });

  await t.test("a fresh grant between stop's read and update wins even in the same server second", async () => {
    const tenant = address(203), account = address(303);
    await one.put(tenant, grant(account));
    let release!: () => void, seen!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const atUpdate = new Promise<void>(resolve => { seen = resolve; });
    pauseStop = async () => { seen(); await held; };
    const stopping = one.stopForReplacement(tenant, account, OLD_SESSION);
    await atUpdate;
    await two.put(tenant, grant(account, FRESH_KEY));
    pauseStop = null; release();
    assert.equal(await stopping, "changed");
    assert.equal((await one.get(tenant))?.demoSessionPrivateKey, FRESH_KEY);
    assert.equal(await one.stopForReplacement(tenant, account, OLD_SESSION), "changed");
    assert.equal((await two.get(tenant))?.demoSessionPrivateKey, FRESH_KEY);
  });

  await t.test("a stale idempotent marker retry cannot overwrite a newly armed grant", async () => {
    const tenant = address(204), account = address(304);
    await one.put(tenant, grant(account));
    await one.stopForReplacement(tenant, account, OLD_SESSION);
    let release!: () => void, seen!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const atUpdate = new Promise<void>(resolve => { seen = resolve; });
    pauseStop = async () => { seen(); await held; };
    const retry = one.stopForReplacement(tenant, account, OLD_SESSION);
    await atUpdate;
    await two.put(tenant, grant(account, FRESH_KEY));
    pauseStop = null; release();
    assert.equal(await retry, "changed");
    assert.equal((await one.get(tenant))?.demoSessionPrivateKey, FRESH_KEY);
  });

  await t.test("checks the account and actual session, isolates tenants, and explicit deletion still works", async () => {
    const tenant = address(205), other = address(206), account = address(305);
    await one.put(tenant, { ...grant(account), sessionKeyAddress: FRESH_SESSION });
    await one.put(other, grant(address(306), FRESH_KEY));
    assert.equal(await two.stopForReplacement(tenant, address(999), OLD_SESSION), "changed");
    assert.equal(await two.stopForReplacement(tenant, account, FRESH_SESSION), "changed");
    const stamp = Number((await admin.query(`SELECT updated_at FROM ${schema}.grants WHERE tenant=$1`, [tenant])).rows[0]!.updated_at);
    assert.equal(await two.stopForReplacement(tenant, account, OLD_SESSION), "stopped");
    assert.equal((await one.get(other))?.demoSessionPrivateKey, FRESH_KEY);
    assert.equal(await one.stopForReplacement(address(999), account), "absent");
    assert.equal(await one.removeUnlessNewer(tenant, stamp), "removed");
    assert.ok(!(await two.listTenants()).includes(tenant));
    await one.put(tenant, grant(account));
    await one.stopForReplacement(tenant, account, OLD_SESSION);
    await two.remove(tenant);
    assert.ok(!(await one.listTenants()).includes(tenant));
  });

  await t.test("full history can stop its existing key but cannot arm a new key or evict history", async () => {
    const tenant = address(207), account = address(307);
    await admin.query(`CREATE TABLE IF NOT EXISTS ${schema}.tenant_personal_memory (tenant TEXT PRIMARY KEY, sealed TEXT NOT NULL)`);
    const memory = sealSecret(`personal-memory/v1 ${tenant}\nfixture memory`, Buffer.alloc(32, 31));
    await admin.query(`INSERT INTO ${schema}.tenant_personal_memory VALUES ($1, $2)`, [tenant, memory]);
    await one.put(tenant, grant(account));
    const fences = Array.from({ length: MAX_RETIRED_SESSION_KEYS }, (_, i) => i.toString(16).padStart(64, "0"));
    await admin.query(`UPDATE ${schema}.grants SET grant_json=jsonb_set(grant_json,'{retiredSessionKeyHashes}',$2::jsonb) WHERE tenant=$1`, [tenant, JSON.stringify(fences)]);
    assert.equal(await one.stopForReplacement(tenant, account, OLD_SESSION), "stopped");
    assert.equal(await two.get(tenant), null);
    const row = (await admin.query(`SELECT grant_json FROM ${schema}.grants WHERE tenant=$1`, [tenant])).rows[0]!;
    assert.deepEqual((row.grant_json as Record<string, unknown>).retiredSessionKeyHashes, fences);
    const before = (await admin.query(`SELECT * FROM ${schema}.grants WHERE tenant=$1`, [tenant])).rows[0]!;
    assert.equal(await two.stopForReplacement(tenant, account, OLD_SESSION), "stopped");
    await assert.rejects(two.put(tenant, grant(account, FRESH_KEY)), /history is full.*contact support/);
    assert.deepEqual((await admin.query(`SELECT * FROM ${schema}.grants WHERE tenant=$1`, [tenant])).rows[0]!, before);
    assert.equal(await one.get(tenant), null);
    assert.equal(await one.tenantForAccount(account), tenant);
    assert.equal((await admin.query(`SELECT sealed FROM ${schema}.tenant_personal_memory WHERE tenant=$1`, [tenant])).rows[0]!.sealed, memory);
  });

  await t.test("last accepted fresh key remains stoppable and a marker-only legacy fence consumes capacity", async () => {
    const tenant = address(208), account = address(308);
    await one.put(tenant, grant(account));
    const fences = Array.from({ length: MAX_RETIRED_SESSION_KEYS - 2 }, (_, i) => i.toString(16).padStart(64, "0"));
    await admin.query(`UPDATE ${schema}.grants SET grant_json=jsonb_set(grant_json,'{retiredSessionKeyHashes}',$2::jsonb) WHERE tenant=$1`, [tenant, JSON.stringify(fences)]);
    await one.stopForReplacement(tenant, account, OLD_SESSION);
    await two.put(tenant, grant(account, FRESH_KEY));
    assert.equal((await one.get(tenant))?.demoSessionPrivateKey, FRESH_KEY);
    assert.equal(await two.stopForReplacement(tenant, account, FRESH_SESSION), "stopped");
    const nextKey = `0x${"39".repeat(32)}` as `0x${string}`;
    const before = (await admin.query(`SELECT * FROM ${schema}.grants WHERE tenant=$1`, [tenant])).rows[0]!;
    assert.equal(((before.grant_json as Record<string, unknown>).retiredSessionKeyHashes as unknown[]).length, MAX_RETIRED_SESSION_KEYS);
    await assert.rejects(one.put(tenant, grant(account, nextKey)), GrantReplacementConflict);
    assert.deepEqual((await admin.query(`SELECT * FROM ${schema}.grants WHERE tenant=$1`, [tenant])).rows[0]!, before);
    const data = before.grant_json as { replacementStop: { sessionKeyHash: string }; retiredSessionKeyHashes: string[] };
    const oldArray = data.retiredSessionKeyHashes.filter(hash => hash !== data.replacementStop.sessionKeyHash);
    await admin.query(`UPDATE ${schema}.grants SET grant_json=jsonb_set(grant_json,'{retiredSessionKeyHashes}',$2::jsonb) WHERE tenant=$1`, [tenant, JSON.stringify(oldArray)]);
    const legacy = (await admin.query(`SELECT * FROM ${schema}.grants WHERE tenant=$1`, [tenant])).rows[0]!;
    await assert.rejects(two.put(tenant, grant(account, nextKey)), GrantReplacementConflict);
    assert.deepEqual((await admin.query(`SELECT * FROM ${schema}.grants WHERE tenant=$1`, [tenant])).rows[0]!, legacy);
    assert.equal(await two.get(tenant), null);
  });
});
