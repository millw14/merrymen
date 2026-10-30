/**
 * ONE LOGIN, TWO WALLETS, ON REAL POSTGRES: the hosted stores as production
 * runs them. Opt-in and disposable: a LOCAL database only, each run in a
 * schema of its own, never DATABASE_URL.
 *
 * MERRYMEN_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres \
 *   node --import tsx --test --test-force-exit worker/src/dual-wallet.postgres.test.ts
 *
 * What it holds the stores to:
 *  - a fleet that never had a Perps wallet gains no table from any of this,
 *    reads and kills included, and its Spot rows never change;
 *  - each wallet's grant and settings round-trip on their own;
 *  - the cross-wallet rules and every account claim are decided inside the
 *    write's own transaction, so two writers racing cannot both pass;
 *  - one profile keeps both accounts, Spot first, across two services;
 *  - a Perps wallet can be renewed (stop, fresh key, old key fenced) and
 *    revoked, and a kill's lookup waits on no lock;
 *  - a Perps removal leaves a staged Spot ledger import alone;
 *  - through getGrantStore, the Perps store opens no connection of its own.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";
import { getGrantStore, GrantReplacementConflict, GrantWalletConflict, PgGrantStore, resetGrantStoreForTest } from "./grant-store";
import { PgIdentityStore } from "./identity-store";
import { PgSettingsStore } from "./settings-store";
import { sealSecret } from "./store-crypto";

interface Client {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: "error" | "end", cb: () => void): void;
}
const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
const pg = url ? (createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => Client }) : null;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const key = (byte: string) => `0x${byte.repeat(32)}` as `0x${string}`;
const DEK = Buffer.alloc(32, 7);
const grant = (tenant: `0x${string}`, account: `0x${string}`, sessionKey: `0x${string}`, extra: Partial<StoredGrant> = {}): StoredGrant => ({
  owner: tenant, smartAccount: account, chainId: 4663, demoSessionPrivateKey: sessionKey,
  sessionKeyAddress: privateKeyToAccount(sessionKey).address, serialized: `permission-${account}-${sessionKey.slice(2, 6)}`,
  grantedAt: 1, expiresAt: 9_999_999_999, caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 },
  ...extra,
});

test("Postgres: two wallets per login, beside an untouched Spot fleet", { skip: !url, timeout: 120_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only a disposable local Postgres is allowed");
  const schema = `mm_dual_wallet_${randomBytes(8).toString("hex")}`;
  const scoped = (name: string) => {
    const u = new URL(target);
    u.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=10000`);
    u.searchParams.set("application_name", name);
    return u.toString();
  };
  const clients: Client[] = [];
  const connect = async (connectionString: string) => {
    const c = new pg!.Client({ connectionString });
    await c.connect();
    clients.push(c);
    return c;
  };
  const savedDek = process.env.MERRYMEN_STORE_DEK;
  process.env.MERRYMEN_STORE_DEK = DEK.toString("base64");
  const admin = await connect(target.toString());
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally {
      await Promise.allSettled(clients.map((c) => c.end()));
      if (savedDek === undefined) delete process.env.MERRYMEN_STORE_DEK; else process.env.MERRYMEN_STORE_DEK = savedDek;
    }
  });
  const perpsTable = async () => (await admin.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`${schema}.perps_grants`])).rows[0]!.found === true;
  const row = async (table: string, tenant: string) => (await admin.query(`SELECT * FROM ${schema}.${table} WHERE tenant = $1`, [tenant])).rows[0];

  // THE FLEET AS IT IS: Spot tables, a sealed Spot grant and settings, no Perps anywhere.
  const T = addr(0x11), SPOT = addr(0x22), PERPS = addr(0x33);
  const spotGrant = grant(T, SPOT, key("ab"));
  {
    const raw = await connect(scoped("fixture"));
    await raw.query(`CREATE TABLE grants (tenant TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, grant_json JSONB NOT NULL, sealed_session_key TEXT NOT NULL, updated_at BIGINT NOT NULL);
      CREATE TABLE tenant_settings (tenant TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at BIGINT NOT NULL);`);
    const { demoSessionPrivateKey, ...stored } = spotGrant;
    await raw.query(`INSERT INTO grants VALUES ($1, 4663, $2, $3, 123)`, [T, JSON.stringify(stored), sealSecret(demoSessionPrivateKey, DEK)]);
    await raw.query(`INSERT INTO tenant_settings VALUES ($1, $2, 123)`, [T, sealSecret(JSON.stringify({ strategy: "trencher", slippageBps: 100 }), DEK)]);
  }
  const spotBefore = await row("grants", T);
  const spot = new PgGrantStore(scoped("spot"), "spot", connect);
  const perps = new PgGrantStore(scoped("perps"), "perps", connect);
  const spotSettings = new PgSettingsStore(scoped("spot-settings"), "spot", connect);
  const perpsSettings = new PgSettingsStore(scoped("perps-settings"), "perps", connect);

  await t.test("a Spot-only fleet: every Perps read and kill answers empty, and no Perps table is made", async () => {
    await Promise.all([spot.listTenants(), perps.listTenants(), spotSettings.listTenants()]);
    assert.deepEqual(await spot.get(T), spotGrant);
    assert.equal(await perps.get(T), null);
    assert.equal(await perps.hasStoredGrant(T), false);
    assert.deepEqual(await perps.listTenantExpiries(), []);
    assert.equal(await perps.stopForReplacement(T, PERPS), "absent");
    assert.equal(await perps.revokeForKill(T), "absent");
    assert.equal(await perps.revokeForKill(T, 1_000), "absent");
    assert.equal(await spot.tenantForAccount(SPOT), T);
    assert.equal(await perps.tenantForAccount(SPOT), T, "the Perps store answers for Spot's accounts too");
    assert.equal(await perpsTable(), false, "nothing made perps_grants");
    assert.deepEqual(await row("grants", T), spotBefore, "the Spot row is byte for byte as it was");
    assert.deepEqual((await spot.listTenantExpiries()).map((r) => [r.tenant, r.purpose]), [[T, "spot"]]);
  });

  await t.test("a Perps wallet: its own row and settings, sealed, and the Spot row never moves", async () => {
    await perps.put(T, grant(T, PERPS, key("cd"), { purpose: "perps" }));
    assert.equal(await perpsTable(), true, "the first Perps put makes its table");
    assert.deepEqual(await perps.get(T), grant(T, PERPS, key("cd"), { purpose: "perps" }));
    assert.equal(await perps.hasStoredGrant(T), true);
    assert.equal(await spot.tenantForAccount(PERPS), T);
    assert.equal(await perps.tenantForAccount(SPOT), T);
    assert.deepEqual((await perps.listTenantExpiries()).map((r) => [r.tenant, r.purpose]), [[T, "perps"]]);
    const perpsRow = await row("perps_grants", T);
    assert.ok(!JSON.stringify(perpsRow).includes(key("cd").slice(2)), "the Perps session key is sealed at rest");
    assert.deepEqual(await row("grants", T), spotBefore);

    await perpsSettings.put(T, { strategy: "momentum", slippageBps: 30 });
    assert.equal((await perpsSettings.get(T))?.slippageBps, 30);
    assert.deepEqual(await spotSettings.get(T), { strategy: "trencher", slippageBps: 100 });
    const holder = addr(0x66);
    assert.deepEqual(await spotSettings.claimHolder(holder, T), { ok: true, fresh: true });
    assert.deepEqual(await perpsSettings.claimHolder(holder, T), { ok: true, fresh: false }, "one holder claim per login");
    await perpsSettings.remove(T);
    assert.deepEqual(await spotSettings.get(T), { strategy: "trencher", slippageBps: 100 });
  });

  await t.test("the cross-wallet rules and account claims hold under concurrent writers", async () => {
    // Two first setups with different owner keys: exactly one lands.
    const U = addr(0x101);
    const race = await Promise.allSettled([
      spot.put(U, grant(U, addr(0x102), key("11"), { owner: addr(0x1ff) })),
      perps.put(U, grant(U, addr(0x103), key("12"), { purpose: "perps" })),
    ]);
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(race));
    assert.match(String((race.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /same owner key/);

    // Two logins racing for one account, one into each wallet: exactly one claim.
    const V = addr(0x111), W = addr(0x112), contested = addr(0x113);
    const claim = await Promise.allSettled([
      spot.put(V, grant(V, contested, key("13"))),
      perps.put(W, grant(W, contested, key("14"), { purpose: "perps" })),
    ]);
    assert.equal(claim.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(claim));
    const loser = (claim.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
    assert.ok(loser instanceof GrantWalletConflict && loser.code === "account-claimed", String(loser));

    await assert.rejects(perps.put(T, grant(T, SPOT, key("15"), { purpose: "perps" })), /different accounts/);
    await assert.rejects(perps.put(T, spotGrant), /for the spot wallet, not the perps wallet/);
    await assert.rejects(spot.put(T, grant(T, SPOT, key("16"), { grantFeatures: ["perp-lighter-v1"] })), /still carries a perpetuals permission/);
    await assert.rejects(perps.put(addr(0x120), grant(addr(0x120), addr(0x121), key("17"), { purpose: "perps", owner: addr(0x122) })), /owned by the wallet you sign in with/);
    assert.deepEqual(await row("grants", T), spotBefore, "none of the refusals touched Spot");
  });

  await t.test("one profile keeps both accounts, Spot first, across two services writing at once", async () => {
    const web = new PgIdentityStore(scoped("identity-web"), connect), worker = new PgIdentityStore(scoped("identity-worker"), connect);
    await web.get(T); await worker.get(T);
    const [a, b] = await Promise.all([web.ensure(T, SPOT), worker.ensure(T, PERPS, { primary: false })]);
    assert.equal(a.slug, b.slug);
    assert.deepEqual((await web.get(T))?.accounts, [SPOT, PERPS]);
    await assert.rejects(worker.ensure(addr(0x130), PERPS), /claimed/);
    const firstPerps = await web.ensure(addr(0x131), addr(0x133), { primary: false });
    const laterSpot = await worker.ensure(addr(0x131), addr(0x132));
    assert.equal(laterSpot.slug, firstPerps.slug);
    assert.deepEqual(laterSpot.accounts, [addr(0x132), addr(0x133)]);
  });

  await t.test("a Perps wallet is renewed and revoked; a kill's lookup waits on no lock", async () => {
    // RENEWAL: the old key is stopped, fenced, and a fresh one arms.
    assert.equal(await perps.stopForReplacement(T, PERPS, privateKeyToAccount(key("cd")).address), "stopped");
    assert.equal(await perps.get(T), null);
    await assert.rejects(perps.put(T, grant(T, PERPS, key("cd"), { purpose: "perps" })), GrantReplacementConflict);
    await perps.put(T, grant(T, PERPS, key("ef"), { purpose: "perps" }));
    assert.equal((await perps.get(T))?.demoSessionPrivateKey, key("ef"));
    assert.deepEqual(await row("grants", T), spotBefore);

    // A Telegram kill's cutoff: a Perps grant signed after it stays.
    const stamp = Number((await row("perps_grants", T))!.updated_at);
    assert.equal(await perps.revokeForKill(T, stamp - 10), "newer");
    assert.ok(await perps.get(T));

    // REVOCATION, while another session holds the tenant's write lock: the kill does not wait for it.
    const holder = await connect(scoped("lock-holder"));
    await holder.query("BEGIN");
    await holder.query(`SELECT pg_advisory_xact_lock($1::int, hashtext($2))`, [0x4d4d474f, T]);
    try {
      assert.equal(await perps.revokeForKill(T), "removed");
    } finally {
      await holder.query("ROLLBACK");
    }
    assert.equal(await perps.get(T), null);
    assert.equal(await perps.revokeForKill(T), "absent", "a retry finds nothing left");
    assert.deepEqual(await row("grants", T), spotBefore, "and Spot is as it was");
  });

  await t.test("through getGrantStore, the Perps store reads on the Spot store's connection and opens none of its own", async () => {
    const savedUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scoped("shared-reads");
    resetGrantStoreForTest();
    try {
      const viaSpot = getGrantStore("spot"), viaPerps = getGrantStore("perps");
      await viaSpot.get(T);
      assert.equal((await viaPerps.get(T))?.smartAccount, undefined, "revoked above");
      assert.equal(await viaPerps.revokeForKill(addr(0x150)), "absent");
      assert.deepEqual(await viaPerps.listTenants(), (await perps.listTenants()));
      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'shared-reads'`);
      assert.equal(rows[0]!.n, 1, "one connection for both wallets' statements");
      await (await (viaSpot as PgGrantStore).sharedConnection()).end?.();
    } finally {
      resetGrantStoreForTest();
      if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
    }
  });

  await t.test("a Perps removal leaves a staged Spot ledger import alone; a Spot removal fences it", async () => {
    const U = addr(0x141);
    await spot.put(U, grant(U, addr(0x142), key("21")));
    await perps.put(U, grant(U, addr(0x143), key("22"), { purpose: "perps" }));
    await admin.query(`INSERT INTO ${schema}.tenant_ledger_import (tenant, generation, target_volume_id, state, sealed, bytes, sha256, source_digest,
      bindings_json, created_at_ms, grant_updated_at, grant_row_version) VALUES ($1, 'gen-1', 'vol', 'available', 'blob', 4, 'sha', 'digest', '{}', 1, '1', 'v')`, [U]);
    await perps.remove(U);
    assert.equal((await row("tenant_ledger_import", U))!.state, "available");
    await spot.remove(U);
    assert.equal((await row("tenant_ledger_import", U))!.state, "deleted");
  });

  await t.test("A WALLET STOPPED FOR A RENEWAL STILL HOLDS THE OTHER TO ITS OWNER KEY, both ways (the hosted GET calls it `stored`; the Wallet screen's restore and renewal ask it first)", async () => {
    const ownerDiffers = (e: unknown) => e instanceof GrantWalletConflict && e.code === "owner-differs";
    // A Perps record stopped for its renewal: the store will not show it, but holds it, and a Spot grant under
    // another owner key is refused against it.
    const V = addr(0x161), VSPOT = addr(0x162), VPERPS = addr(0x163);
    await spot.put(V, grant(V, VSPOT, key("31")));
    await perps.put(V, grant(V, VPERPS, key("32"), { purpose: "perps" }));
    assert.equal(await perps.stopForReplacement(V, VPERPS, privateKeyToAccount(key("32")).address), "stopped");
    assert.equal(await perps.get(V), null);
    assert.equal(await perps.hasStoredGrant(V), true);
    const spotRow = await row("grants", V);
    await assert.rejects(spot.put(V, grant(V, VSPOT, key("33"), { owner: addr(0x164) })), ownerDiffers);
    assert.deepEqual(await row("grants", V), spotRow, "nothing of Spot's was written");
    // What the hosted GET answers `stored` from: the hidden record's owner, as the Spot put reads it.
    assert.equal(await perps.storedGrantOwner(V), V);
    assert.equal(await perps.storedGrantOwner(addr(0x199)), null, "no record is none");
    // A record that put would refuse on (one that names the other wallet) throws, never answers an owner.
    const stopped = (await row("perps_grants", V))!.grant_json as Record<string, unknown>;
    await admin.query(`UPDATE ${schema}.perps_grants SET grant_json = $1 WHERE tenant = $2`, [JSON.stringify({ ...stopped, purpose: undefined }), V]);
    await assert.rejects(perps.storedGrantOwner(V), /could not be verified/);
    await assert.rejects(spot.put(V, grant(V, VSPOT, key("37"))), /could not be verified/, "as the Spot put refuses on it");
    await admin.query(`UPDATE ${schema}.perps_grants SET grant_json = $1 WHERE tenant = $2`, [JSON.stringify(stopped), V]);
    await perps.put(V, grant(V, VPERPS, key("34"), { purpose: "perps" }));
    assert.equal((await perps.get(V))?.demoSessionPrivateKey, key("34"), "the renewal itself lands, under its own key");

    // The other way: a Spot wallet under a legacy owner key, stopped for its renewal, still holds a Perps grant
    // (whose owner is always the login) out.
    const W = addr(0x171), WSPOT = addr(0x172);
    await spot.put(W, grant(W, WSPOT, key("35"), { owner: addr(0x174) }));
    assert.equal(await spot.stopForReplacement(W, WSPOT, privateKeyToAccount(key("35")).address), "stopped");
    assert.equal(await spot.get(W), null);
    assert.equal(await spot.hasStoredGrant(W), true);
    await assert.rejects(perps.put(W, grant(W, addr(0x173), key("36"), { purpose: "perps" })), ownerDiffers);
    assert.equal(await perps.hasStoredGrant(W), false, "nothing of Perps' was written");
  });
});
