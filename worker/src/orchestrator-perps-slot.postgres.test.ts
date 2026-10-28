/**
 * WHAT THE ORCHESTRATOR'S PERPS SLOT ASKS OF THE SHARED POSTGRES (slice 4).
 *
 * Opt-in, disposable LOCAL PostgreSQL only (MERRYMEN_TEST_PG_URL). Never reads
 * DATABASE_URL from the environment it was given. Pins three facts reconcile
 * rests on:
 *  - reading the Perps roster every pass, whatever MERRYMEN_PERPS says, is a
 *    catalog look while no Perps grant exists, and makes no table;
 *  - once one does, the roster names its owner, its wallet and when it was
 *    stored — the cutoff a kill latches the other wallet's worker by;
 *  - a login's two workers hold two different advisory leases, so either can
 *    run on a replica the other does not, and neither ever blocks the other.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
interface Client {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const OWNER = "0x00000000000000000000000000000000000000d1" as const;
const PERPS_ACCOUNT = "0x00000000000000000000000000000000000000d3" as const;
const sessionKey = `0x${"5e".repeat(32)}` as `0x${string}`;
const perpsGrant = (): StoredGrant => ({
  owner: OWNER, smartAccount: PERPS_ACCOUNT, chainId: 4663, purpose: "perps", demoSessionPrivateKey: sessionKey,
  sessionKeyAddress: privateKeyToAccount(sessionKey).address, serialized: `permission-${PERPS_ACCOUNT}`,
  grantedAt: Math.floor(Date.now() / 1000) - 60, expiresAt: Math.floor(Date.now() / 1000) + 86_400, grantFeatures: ["tradeable-v2"],
  caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 },
} as StoredGrant);

test("Postgres: the orchestrator's Perps roster and leases", { skip: !url, timeout: 60_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only a disposable local PostgreSQL is allowed");
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 9).toString("base64");
  const pg = createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => Client };
  const schema = `mm_perps_slot_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(target);
  scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=5000`);
  scoped.searchParams.set("application_name", "perps-slot-test");
  const scopedUrl = scoped.toString();
  const { PgGrantStore } = await import("./grant-store");
  const tables = async () =>
    (await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [schema])).rows.map((r) => String(r.table_name));
  const spot = new PgGrantStore(scopedUrl, "spot");
  const perps = new PgGrantStore(scopedUrl, "perps", undefined, () => spot.sharedConnection());
  try {
    await t.test("no Perps grant yet: the roster is empty and no perps table is made, pass after pass", async () => {
      for (let pass = 0; pass < 3; pass++) assert.deepEqual(await perps.listTenantExpiries(), []);
      assert.ok(!(await tables()).includes("perps_grants"), `no perps_grants: ${(await tables()).join(", ")}`);
    });

    await t.test("a Perps grant: listed by owner, as the Perps wallet's, with the second it was stored", async () => {
      const before = Math.floor(Date.now() / 1000);
      await perps.put(OWNER, perpsGrant());
      const roster = await perps.listTenantExpiries();
      assert.equal(roster.length, 1);
      assert.equal(roster[0]!.tenant, OWNER);
      assert.equal(roster[0]!.purpose, "perps");
      assert.ok(typeof roster[0]!.updatedAt === "number" && roster[0]!.updatedAt >= before - 1, "a storing time the kill's cutoff can be judged against");
      assert.deepEqual(await spot.listTenantExpiries(), [], "and never in the Spot roster");
    });

    await t.test("a login's two workers hold two leases, each its own", async () => {
      const saved = process.env.DATABASE_URL;
      process.env.DATABASE_URL = scopedUrl;
      const { acquireTenantLease } = await import("./tenant-lease");
      try {
        const spotLease = await acquireTenantLease(OWNER);
        const perpsLease = await acquireTenantLease(`${OWNER}:perps` as `0x${string}`);
        assert.ok(spotLease && perpsLease, "both granted");
        assert.equal(spotLease.backend, "postgres");
        assert.ok(spotLease.healthy() && perpsLease.healthy());
        await perpsLease.release();
        assert.ok(spotLease.healthy(), "releasing one leaves the other held");
        await spotLease.release();
      } finally {
        if (saved === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = saved;
      }
    });
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
