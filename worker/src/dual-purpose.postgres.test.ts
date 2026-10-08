/** Opt-in, disposable LOCAL Postgres only; never uses DATABASE_URL. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import type { StoredGrant } from "../../packages/core/src/grant";
import { makePgDb } from "./db";
import { PgGrantStore } from "./grant-store";
import { PgSettingsStore } from "./settings-store";
import { PgIdentityStore } from "./identity-store";
import { sealSecret } from "./store-crypto";
import { sealPerpKey, openPerpKey } from "./perps/key-seal";
import { HostedStanddownStore, HostedLiveCheckpointStore } from "./perps/hosted-standdown-store";

const url = process.env.MERRYMEN_TEST_PG_URL;
interface Client { connect(): Promise<void>; end(): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }
const pg = (url ? createRequire(import.meta.url)("pg") : null) as { Client: new (opts: { connectionString: string }) => Client } | null;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const tenant = addr(11), account = addr(22), perpsAccount = addr(33);
const dek = Buffer.alloc(32, 7);
const spot: StoredGrant = { owner: addr(44), smartAccount: account, chainId: 4663, demoSessionPrivateKey: `0x${"ab".repeat(32)}`, sessionKeyAddress: addr(55),
  serialized: "permission", grantedAt: 1, expiresAt: 9_999_999_999, caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 } };
const perp: StoredGrant = { ...spot, purpose: "perps", smartAccount: perpsAccount, serialized: "perps-permission", demoSessionPrivateKey: `0x${"cd".repeat(32)}` };

test("Postgres: dual wallet migration, isolation and atomic authority", { skip: !url, timeout: 60_000 }, async t => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only disposable local PostgreSQL is allowed");
  const schema = `mm_dual_test_${randomBytes(8).toString("hex")}`;
  const scoped = (name: string) => { const u = new URL(target); u.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=10000`); u.searchParams.set("application_name", name); return u.toString(); };
  const clients: Client[] = [];
  const stores: object[] = [];
  const connect = async (connectionString: string) => { const c = new pg!.Client({ connectionString }); await c.connect(); clients.push(c); return c; };
  const originalDek = process.env.MERRYMEN_STORE_DEK;
  process.env.MERRYMEN_STORE_DEK = dek.toString("base64");
  const admin = await connect(target.toString());
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    const raw = await connect(scoped("fixture"));
    const db = await makePgDb(scoped("ledger"));
    // The pre-upgrade tables have no Perps purpose, and existing authority is sealed.
    await raw.query(`CREATE TABLE grants (tenant TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, grant_json JSONB NOT NULL, sealed_session_key TEXT NOT NULL, updated_at BIGINT NOT NULL);
      CREATE TABLE tenant_settings (tenant TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at BIGINT NOT NULL);
      CREATE TABLE perp_standdown (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, smart_account TEXT NOT NULL, api_public_key TEXT NOT NULL, api_key_index INTEGER NOT NULL, sealed_key TEXT, reason TEXT NOT NULL, created_at_ms BIGINT NOT NULL, expires_at_ms BIGINT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, claimant TEXT, state TEXT NOT NULL DEFAULT 'pending', checkpoint TEXT, result_json TEXT, mirrored INTEGER NOT NULL DEFAULT 0);`);
    const { demoSessionPrivateKey, ...legacyGrant } = spot;
    await raw.query("INSERT INTO grants VALUES ($1, 4663, $2, $3, 123)", [tenant, JSON.stringify(legacyGrant), sealSecret(demoSessionPrivateKey, dek)]);
    await raw.query("INSERT INTO tenant_settings VALUES ($1, $2, 123)", [tenant, sealSecret(JSON.stringify({ strategy: "trencher", slippageBps: 100 }), dek)]);
    await raw.query("INSERT INTO perp_standdown (id, tenant, smart_account, api_public_key, api_key_index, reason, created_at_ms, expires_at_ms, state, mirrored) VALUES ('old', $1, $2, 'old-public', 16, 'kill', 1, 2, 'done', 1)", [addr(99), addr(98)]);
    const before = (await raw.query("SELECT * FROM grants WHERE tenant = $1", [tenant])).rows[0];
    const s = new PgGrantStore(scoped("spot")), p = new PgGrantStore(scoped("perps"), "perps"); stores.push(s, p);
    const ss = new PgSettingsStore(scoped("spot-settings"), connect), ps = new PgSettingsStore(scoped("perps-settings"), connect, "perps");
    const jobs = new HostedStanddownStore(db, dek);

    await t.test("both purposes boot concurrently over legacy schema without changing legacy rows", async () => {
      await Promise.all([s.listTenants(), p.listTenants(), ss.listTenants(), ps.listTenants()]);
      await jobs.init(); await jobs.init();
      assert.deepEqual(await s.get(tenant), spot);
      assert.equal(await p.get(tenant), null);
      assert.deepEqual((await raw.query("SELECT * FROM grants WHERE tenant = $1", [tenant])).rows[0], before);
      assert.equal((await jobs.latest(addr(99)))?.purpose, "spot");
      assert.equal(await jobs.latest(addr(99), "perps"), null);
      assert.deepEqual(await ss.get(tenant), { strategy: "trencher", slippageBps: 100 });
    });

    await t.test("independent grant and setting round trips preserve Spot bytes", async () => {
      await p.put(tenant, perp);
      await ps.put(tenant, { strategy: "perps-only", perpsMaxCollateralUsdg: 20 });
      assert.deepEqual(await p.get(tenant), perp);
      assert.equal(await p.hasStoredGrant(tenant), true);
      assert.equal(await s.tenantForAccount(perpsAccount), tenant);
      assert.equal(await p.tenantForAccount(account), tenant);
      assert.deepEqual((await raw.query("SELECT * FROM grants WHERE tenant = $1", [tenant])).rows[0], before);
      assert.equal((await ss.get(tenant))?.strategy, "trencher");
      assert.equal((await ps.get(tenant))?.perpsMaxCollateralUsdg, 20);
      const holder = addr(66);
      assert.deepEqual(await ss.claimHolder(holder, tenant), { ok: true, fresh: true });
      assert.deepEqual(await ps.claimHolder(holder, tenant), { ok: true, fresh: false });
      const row = (await raw.query("SELECT grant_json, sealed_session_key FROM perps_grants WHERE tenant = $1", [tenant])).rows[0]!;
      assert.ok(!JSON.stringify(row).includes(perp.demoSessionPrivateKey));
    });

    await t.test("concurrent first creation enforces one owner key and distinct account purposes atomically", async () => {
      const second = addr(101);
      const result = await Promise.allSettled([
        s.put(second, { ...spot, smartAccount: addr(102) }),
        p.put(second, { ...perp, owner: addr(103), smartAccount: addr(104) }),
      ]);
      assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
      assert.match(String((result.find(r => r.status === "rejected") as PromiseRejectedResult).reason), /same owner key/);
      await assert.rejects(p.put(tenant, { ...perp, smartAccount: account }), /distinct smart accounts/);
      await assert.rejects(p.put(tenant, spot), /purpose/);
      await assert.rejects(p.put(addr(107), { ...perp, smartAccount: account }), /distinct smart accounts/);
      await s.put(addr(108), { ...spot, smartAccount: addr(109), grantFeatures: ["perp-lighter-v1"], perp: undefined }).then(() => assert.fail("malformed legacy perpetual permission accepted"), () => {});
    });

    await t.test("one profile keeps both account claims and Spot primary across concurrent service writes", async () => {
      const one = new PgIdentityStore(scoped("identity-web")), two = new PgIdentityStore(scoped("identity-worker")); stores.push(one, two);
      // Initialize the established identity schema once, then use distinct connections.
      await one.get(tenant); await two.get(tenant);
      const [a, b] = await Promise.all([one.ensure(tenant, account), two.ensure(tenant, perpsAccount, { primary: false })]);
      const current = await one.get(tenant);
      assert.equal(a.slug, b.slug); assert.equal(current?.slug, a.slug);
      assert.deepEqual(current?.accounts, [account, perpsAccount]);
      await assert.rejects(two.ensure(addr(77), perpsAccount), /claimed/);
      const firstPerps = await one.ensure(addr(81), addr(83), { primary: false });
      const laterSpot = await two.ensure(addr(81), addr(82));
      assert.equal(laterSpot.slug, firstPerps.slug);
      assert.deepEqual(laterSpot.accounts, [addr(82), addr(83)]);
    });

    await t.test("Perps revocation retains shutdown custody durably and only fences that wallet", async () => {
      const privateKey = `0x${"ab".repeat(40)}`;
      const apiPublicKey = `0x${("01" + "00".repeat(7)).repeat(5)}` as `0x${string}`;
      const apiKeyIndex = 16;
      const apiKeySealed = sealPerpKey(privateKey, { tenant, smartAccount: perpsAccount, apiPublicKey, apiKeyIndex }, dek);
      await p.put(tenant, { ...perp, grantFeatures: ["perp-lighter-v1"], perp: { route: "perp-lighter-v1", apiKeyIndex, apiPublicKey, apiKeySealed } });
      const checkpoints = new HostedLiveCheckpointStore(db, dek);
      const live = await checkpoints.claim(tenant, perpsAccount, apiPublicKey, "perps-child");
      assert.equal(await checkpoints.fence(live), true);
      await p.remove(tenant);
      assert.equal(await p.get(tenant), null); assert.deepEqual(await s.get(tenant), spot);
      assert.equal(await checkpoints.fence(live), false);
      assert.equal(await jobs.latest(tenant), null);
      const job = await new HostedStanddownStore(await makePgDb(scoped("restart")), dek).latest(tenant, "perps");
      assert.equal(job?.purpose, "perps"); assert.equal(job?.smartAccount, perpsAccount);
      assert.equal(openPerpKey(job!.sealedKey!, { tenant, smartAccount: perpsAccount, apiPublicKey, apiKeyIndex }, dek), privateKey);
      assert.equal(await jobs.blocked(tenant, account), false);
      assert.equal(await jobs.blocked(tenant, perpsAccount, "perps"), true);
      await assert.rejects(p.put(tenant, perp), /shutdown/);
      assert.equal(await p.get(tenant), null, "blocked reactivation rolls back its upsert");
      await ps.remove(tenant); assert.equal((await ss.get(tenant))?.strategy, "trencher");
    });
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    // Store connections are otherwise process-lived. Close their resolved test clients.
    for (const store of stores) { const ready = (store as { ready?: Promise<Client> }).ready; if (ready) await ready.then(c => c.end()).catch(() => {}); }
    for (const c of clients) await c.end().catch(() => {});
    if (originalDek === undefined) delete process.env.MERRYMEN_STORE_DEK; else process.env.MERRYMEN_STORE_DEK = originalDek;
  }
});
