/**
 * THE KILL'S PAPER STAND-DOWN ON THE SHARED POSTGRES (perps-kill.ts,
 * settings-store.ts PgSettingsStore.disablePerpsForKill).
 *
 * Opt-in, disposable LOCAL PostgreSQL only (MERRYMEN_TEST_PG_URL). Never reads
 * DATABASE_URL. Pins the three things a hosted kill needs of the Perps
 * settings: read-only probes create no table; a completed public kill records
 * a fresh off revision even for an absent wallet; other settings stay sealed
 * under the DEK; and an owner's save racing the kill is never lost, nor is the kill.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { MerrymenSettings } from "../../packages/core/src/index";

function withoutNonce(value: MerrymenSettings | null): MerrymenSettings {
  assert.ok(value);const {perpsControlNonce,...rest}=value;assert.match(perpsControlNonce!,/^[a-f0-9-]{36}$/);return rest;
}

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
interface Client {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

test("Postgres: a kill turns the Perps wallet's paper strategy off, and nothing else", { skip: !url, timeout: 60_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only a disposable local PostgreSQL is allowed");
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
  const pg = createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => Client };
  const schema = `mm_perps_kill_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(target);
  scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=5000`);
  scoped.searchParams.set("application_name", "perps-kill-settings-test");
  const scopedUrl = scoped.toString();
  const { PgSettingsStore, disablePaperPerpsForKill } = await import("./settings-store");
  const T = "0x00000000000000000000000000000000000000a1" as const;
  const OWNER: MerrymenSettings = { perpsEnabled: true, perpsMarkets: ["BTC-PERP"], perpsMaxLeverage: 2, agentName: "Little John" };
  const tables = async () =>
    (await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [schema])).rows.map((r) => String(r.table_name));
  try {
    await t.test("an owner with no Perps wallet: one catalog look, no table made", async () => {
      const store = new PgSettingsStore(scopedUrl, "perps");
      assert.equal(await disablePaperPerpsForKill(T, store), "none");
      assert.deepEqual(await tables(), [], "the kill wrote no perps schema");
    });

    await t.test("a Perps settings READ before any Perps write makes no table either: get, getVersioned, listTenants and remove answer empty by a catalog look", async () => {
      // GET /api/settings?wallet=perps is answered whatever MERRYMEN_PERPS says
      // (D1), and every Perps save reads first. These went through client(),
      // which makes every table it names, so a signed-in login's read made
      // perps_tenant_settings (and the holder tables) on a fleet that had
      // never had a Perps wallet.
      const store = new PgSettingsStore(scopedUrl, "perps");
      assert.equal(await store.get(T), null);
      assert.deepEqual(await store.getVersioned(T), { settings: null, version: null });
      assert.deepEqual(await store.listTenants(), []);
      await store.remove(T);
      assert.deepEqual(await tables(), [], "no read wrote any schema");
      // NO ANSWER OF "ABSENT" IS FINAL: another service's first write (the
      // web's save, read by the orchestrator) makes the table, and this same
      // store's next read finds the row.
      const otherService = new PgSettingsStore(scopedUrl, "perps");
      await otherService.put(T, { perpsMaxLeverage: 2 });
      assert.ok((await tables()).includes("perps_tenant_settings"), "made by the write");
      assert.deepEqual(await store.get(T), { perpsMaxLeverage: 2 });
      assert.deepEqual(await store.listTenants(), [T]);
      const read = await store.getVersioned(T);
      assert.equal(await store.putIfUnchanged(T, { perpsMaxLeverage: 3 }, read.version), true);
      await store.remove(T);
      assert.equal(await otherService.get(T), null);
    });

    await t.test("perps on: switched off, every other setting kept, still sealed", async () => {
      const store = new PgSettingsStore(scopedUrl, "perps");
      await store.put(T, OWNER);
      const sealedBefore = String((await admin.query(`SELECT sealed FROM ${schema}.perps_tenant_settings WHERE tenant = $1`, [T])).rows[0]?.sealed);
      assert.doesNotMatch(sealedBefore, /perpsEnabled/, "sealed under the DEK");
      assert.equal(await disablePaperPerpsForKill(T, store), "disabled");
      assert.deepEqual(withoutNonce(await store.get(T)), { ...OWNER, perpsEnabled: false });
      const sealedAfter = String((await admin.query(`SELECT sealed FROM ${schema}.perps_tenant_settings WHERE tenant = $1`, [T])).rows[0]?.sealed);
      assert.doesNotMatch(sealedAfter, /perpsEnabled|Little John/, "written back sealed");
      // A retry finds them off, but must still invalidate pre-retry enables.
      const nonce = (await store.get(T))!.perpsControlNonce;
      assert.equal(await disablePaperPerpsForKill(T, store), "none");
      assert.notEqual((await store.get(T))!.perpsControlNonce, nonce);
    });

    await t.test("an owner's save racing the kill: neither is lost", async () => {
      const store = new PgSettingsStore(scopedUrl, "perps");
      await store.put(T, OWNER);
      // The kill reads, then the owner saves a new market list before the
      // kill writes: the compare-and-swap misses, reads again, and turns
      // perps off on the owner's NEW settings.
      const racing = new PgSettingsStore(scopedUrl, "perps", async (u) => {
        const c = new pg.Client({ connectionString: u });
        await c.connect();
        let raced = false;
        return {
          async query(sql: string, params?: unknown[]) {
            if (!raced && /^UPDATE/.test(sql)) {
              raced = true;
              await store.put(T, { ...OWNER, perpsMarkets: ["ETH-PERP"] });
            }
            return c.query(sql, params);
          },
          end: () => c.end(),
        } as unknown as Client;
      });
      assert.equal(await disablePaperPerpsForKill(T, racing), "disabled");
      assert.deepEqual(withoutNonce(await store.get(T)), { ...OWNER, perpsMarkets: ["ETH-PERP"], perpsEnabled: false });
    });

    await t.test("the other order, a save that read before the kill: its compare and swap misses, and the kill's off stands", async () => {
      const { readSettingsVersioned, putSettingsIfUnchanged } = await import("./settings-store");
      const store = new PgSettingsStore(scopedUrl, "perps");
      await store.put(T, OWNER);
      // The owner's save reads, the kill lands, then the save writes the blob it read.
      const read = await readSettingsVersioned(store, T);
      assert.deepEqual(read.settings, OWNER);
      assert.equal(await disablePaperPerpsForKill(T, store), "disabled");
      assert.equal(await putSettingsIfUnchanged(store, T, { ...OWNER, perpsMaxLeverage: 3 }, read.version), false, "missed: the kill wrote in between");
      assert.deepEqual(withoutNonce(await store.get(T)), { ...OWNER, perpsEnabled: false }, "nothing from the stale save was written");
      // Read again, it lands, and only over that read.
      const again = await readSettingsVersioned(store, T);
      assert.equal(await putSettingsIfUnchanged(store, T, { ...again.settings, perpsMaxLeverage: 3 }, again.version), true);
      assert.deepEqual(withoutNonce(await store.get(T)), { ...OWNER, perpsEnabled: false, perpsMaxLeverage: 3 });
      assert.equal(await putSettingsIfUnchanged(store, T, { ...OWNER }, again.version), false, "a version is good for one write");
    });

    await t.test("nothing stored: the first save makes the row, and a second save that also read nothing misses", async () => {
      const { readSettingsVersioned, putSettingsIfUnchanged } = await import("./settings-store");
      const store = new PgSettingsStore(scopedUrl, "perps");
      const U = "0x00000000000000000000000000000000000000b2" as const;
      const first = await readSettingsVersioned(store, U);
      const second = await readSettingsVersioned(store, U);
      assert.deepEqual([first.settings, first.version, second.version], [null, null, null]);
      assert.equal(await putSettingsIfUnchanged(store, U, { perpsMaxLeverage: 2 }, first.version), true);
      assert.equal(await putSettingsIfUnchanged(store, U, { perpsMaxLeverage: 5 }, second.version), false);
      assert.deepEqual(await store.get(U), { perpsMaxLeverage: 2 });
    });

    await t.test("an explicit kill revision is created even without prior grant settings", async()=>{
      const store=new PgSettingsStore(scopedUrl,"perps");
      const U="0x00000000000000000000000000000000000000c2" as const;
      assert.equal((await store.getVersioned(U)).version,null);
      assert.equal(await disablePaperPerpsForKill(U,store,true),"none");
      assert.deepEqual(withoutNonce(await store.get(U)),{perpsEnabled:false});
      assert.equal(await store.putIfUnchanged(U,{perpsEnabled:true},null),false);
    });

    await t.test("the Spot wallet's store refuses: perps live only in the Perps wallet's settings", async () => {
      await assert.rejects(disablePaperPerpsForKill(T, new PgSettingsStore(scopedUrl, "spot")), /Only the Perps wallet's settings hold perps/);
    });
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
