/**
 * A ROBINHOOD KILL ON A POSTGRES THAT NEVER RAN SOLANA (opt-in, disposable LOCAL
 * PostgreSQL only, MERRYMEN_TEST_PG_URL; never reads a configured DATABASE_URL).
 *
 * Hosted "kill all agents" and Telegram /kill stop the tenant's Solana strategy
 * too, MERRYMEN_SOLANA on or off. With no Solana table the kill must create
 * none, take no Solana lock and answer the Robinhood kill as done; once the
 * table exists, it stops the strategy as before.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { base58Encode } from "../../../packages/core/src/ids";
import type { SolanaPaperLimits } from "../../../packages/core/src/solana";
import { makePgDb } from "../../../worker/src/db";
import { stopSolanaForKill } from "../../../worker/src/solana-kill";
import { SqlSolanaBindingStore } from "./solana-binding-store";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
const TENANT = `0x${"11".repeat(20)}` as const;
const OWNER = base58Encode(new Uint8Array(32).fill(20));
const NOW = 1_000_000;
const limits: SolanaPaperLimits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 3600000 };
const strategy = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 300 };
const ADVISORY = 1_297_691_983; // SqlSolanaBindingStore's schema lock
interface Client {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

test("Postgres: a kill without the Solana table creates nothing, waits on no Solana lock, and reports the RH kill done", { skip: !url, timeout: 60_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only a disposable local PostgreSQL is allowed");
  const pg = createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => Client };
  const schema = `mm_solana_kill_${randomBytes(8).toString("hex")}`;
  const scoped = (who: string) => {
    const u = new URL(target);
    // A short statement timeout: a kill that waited on the schema lock held below fails, by name.
    u.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=3000`);
    u.searchParams.set("application_name", `solana-kill-test-${who}`);
    return u.toString();
  };
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const holder = new pg.Client({ connectionString: scoped("holder") });
  await holder.connect();
  const saved = Object.fromEntries(["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK"].map((k) => [k, process.env[k]]));
  const home = mkdtempSync(path.join(tmpdir(), "solana-kill-pg-"));
  const table = async () => (await admin.query("SELECT to_regclass($1) IS NOT NULL AS found", [`${schema}.solana_wallet_bindings`])).rows[0]!.found;
  try {
    process.env.MERRYMEN_HOME = home;
    process.env.MERRYMEN_HOSTED = "1";
    process.env.DATABASE_URL = scoped("web");
    process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
    process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");

    await t.test("the store's kill paths, while another process holds the Solana schema lock", async () => {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY]);
      try {
        const store = new SqlSolanaBindingStore(() => makePgDb(scoped("store")), "postgres", () => NOW);
        assert.equal(await store.disableForKill(TENANT), false);
        assert.deepEqual(await store.strategyTenants(), []);
        // The production wiring: hosted, DATABASE_URL set, the default store.
        assert.equal(await stopSolanaForKill(TENANT), "none");
      } finally { await holder.query("ROLLBACK"); }
      assert.equal(await table(), false, "no Solana table was created");
    });

    await t.test("hosted 'kill all agents' answers ok, removes the RH grant, and creates no Solana table", async () => {
      const auth = await import("@/lib/auth");
      // A real grant in this test's schema, read back from the database after the kill. The
      // route's own grant-store instance cannot be mocked from here on every Node: on Node 22
      // tsx loads the route's copy of the module separately from this file's import.
      const { PgGrantStore } = await import("../../../worker/src/grant-store");
      const key = `0x${"19".repeat(32)}` as const;
      const now = Math.floor(Date.now() / 1000);
      await new PgGrantStore(scoped("seed"), "spot").put(TENANT, {
        smartAccount: `0x${"22".repeat(20)}`, owner: TENANT, chainId: 4663,
        sessionKeyAddress: privateKeyToAccount(key).address,
        serialized: Buffer.from(JSON.stringify({ privateKey: key })).toString("base64"),
        demoSessionPrivateKey: key, expiresAt: now + 86_400, grantedAt: now, grantFeatures: ["tradeable-v2"], grantTokens: [],
        caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 1, maxOpsPerDay: 50 },
      } as unknown as Parameters<InstanceType<typeof PgGrantStore>["put"]>[1]);
      const grantRows = async () => Number((await admin.query(`SELECT count(*)::int AS n FROM ${schema}.grants WHERE tenant = $1`, [TENANT])).rows[0]!.n);
      assert.equal(await grantRows(), 1, "the RH grant was stored");
      (await import("@merrymen/grant-store")).resetGrantStoreForTest();
      const { DELETE } = await import("../app/api/grants/route");
      const response = await DELETE(new Request("https://app.merrymen.dev/api/grants", {
        method: "DELETE", headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(TENANT)}`, "content-type": "application/json" },
        body: JSON.stringify({ expectedTenant: TENANT, purpose: "delete-agent" }),
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(await grantRows(), 0, "the RH grant was removed");
      assert.equal(await table(), false, "no Solana table was created");
    });

    await t.test("once Solana is used, a fresh store's kill stops the strategy", async () => {
      const owner = new SqlSolanaBindingStore(() => makePgDb(scoped("owner")), "postgres", () => NOW);
      await owner.bind(TENANT, "did:privy:alice", OWNER);
      await owner.settings(TENANT, OWNER, 0, "paper", limits);
      const on = await owner.strategy(TENANT, OWNER, 1, strategy);
      const killer = new SqlSolanaBindingStore(() => makePgDb(scoped("killer")), "postgres", () => NOW + 1);
      assert.deepEqual(await killer.strategyTenants(), [TENANT]);
      assert.equal(await killer.disableForKill(TENANT), true);
      const off = (await owner.get(TENANT))!;
      assert.equal(off.strategy!.enabled, false);
      assert.equal(off.revision, on.revision + 1);
    });

    await t.test("with the table present, a fresh store's kill waits on no open reader of it and on no schema lock", async () => {
      // Review RHS, round 1: the kill ran the schema step, whose ALTER TABLE takes an ACCESS EXCLUSIVE lock,
      // so it waited behind this read transaction until the statement timeout (3 s), and in production for
      // as long as the reader ran.
      const owner = new SqlSolanaBindingStore(() => makePgDb(scoped("owner2")), "postgres", () => NOW + 2);
      const before = (await owner.get(TENANT))!;
      await owner.strategy(TENANT, OWNER, before.revision, strategy);
      await holder.query("BEGIN");
      await holder.query("SELECT * FROM solana_wallet_bindings");
      await holder.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY]);
      try {
        const killer = new SqlSolanaBindingStore(() => makePgDb(scoped("killer2")), "postgres", () => NOW + 3);
        assert.deepEqual(await killer.strategyTenants(), [TENANT]);
        assert.equal(await killer.disableForKill(TENANT), true);
      } finally { await holder.query("ROLLBACK"); }
      assert.equal((await owner.get(TENANT))!.strategy!.enabled, false);
    });

    await t.test("with the column present, a fresh store's first use waits on no open reader of the table", async () => {
      // Review RHS, round 2: the schema step ran ADD COLUMN IF NOT EXISTS, whose ACCESS EXCLUSIVE lock waits
      // behind this read transaction even when the column exists: the statement timeout (3 s) here.
      await holder.query("BEGIN");
      await holder.query("SELECT * FROM solana_wallet_bindings");
      try {
        const fresh = new SqlSolanaBindingStore(() => makePgDb(scoped("fresh")), "postgres", () => NOW + 6);
        const started = Date.now();
        assert.equal((await fresh.get(TENANT))!.owner, OWNER);
        assert.ok(Date.now() - started < 2_500, `the first use took ${Date.now() - started} ms, as if it waited on the reader`);
      } finally { await holder.query("ROLLBACK"); }
    });

    await t.test("a kill in a process whose own schema step waits on another's schema lock neither waits nor fails with it", async () => {
      // Review RHS, round 2: killDb returned this store's schema-step promise once a Solana route had started it,
      // so this kill waited on the advisory lock held below and failed with that step's statement timeout (3 s).
      const owner = new SqlSolanaBindingStore(() => makePgDb(scoped("owner3")), "postgres", () => NOW + 4);
      const before = (await owner.get(TENANT))!;
      await owner.strategy(TENANT, OWNER, before.revision, strategy);
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY]);
      const store = new SqlSolanaBindingStore(() => makePgDb(scoped("store3")), "postgres", () => NOW + 5);
      let setup: Promise<unknown> | null = null;
      try {
        setup = store.get(TENANT); // its schema step now waits for the advisory lock
        setup.catch(() => {});
        const started = Date.now();
        assert.deepEqual(await store.strategyTenants(), [TENANT]);
        assert.equal(await store.disableForKill(TENANT), true);
        assert.ok(Date.now() - started < 2_500, `the kill took ${Date.now() - started} ms, as if it waited on the schema lock`);
      } finally { await holder.query("ROLLBACK"); }
      await setup;
      assert.equal((await owner.get(TENANT))!.strategy!.enabled, false);
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    await holder.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
