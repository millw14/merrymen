/**
 * A ROBINHOOD KILL NEVER WRITES SOLANA SCHEMA.
 *
 * "Kill all agents" and Telegram /kill stop the tenant's Solana strategy too,
 * whatever MERRYMEN_SOLANA says. On a database that never ran Solana they must
 * find nothing to stop, read-only: no table created, no advisory lock taken,
 * and no failure that would report the Robinhood kill incomplete. Once the
 * table exists, the kill stops the strategy and fails closed as before.
 * (The PostgreSQL side: solana-binding-store-kill.postgres.test.ts.)
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { base58Encode } from "../../../packages/core/src/ids";
import type { SolanaPaperLimits } from "../../../packages/core/src/solana";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { stopLocalSolanaForKill, stopSolanaForKill } from "../../../worker/src/solana-kill";
import { SqlSolanaBindingStore } from "./solana-binding-store";

const TENANT = `0x${"11".repeat(20)}` as const;
const OWNER = base58Encode(new Uint8Array(32).fill(20));
const NOW = 1_000_000;
const limits: SolanaPaperLimits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 3600000 };
const strategy = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 300 };

/** Every statement a store sends, over a real SQLite database. */
function recorded(raw: DatabaseSync): { db: Db; sql: string[] } {
  const base = wrapSqlite(raw), sql: string[] = [];
  const wrap = (inner: Db): Db => ({
    prepare: (text) => { sql.push(text); return inner.prepare(text); },
    exec: async (text) => { sql.push(text); await inner.exec(text); },
    tx: (fn) => inner.tx((tx) => fn(wrap(tx))),
  });
  return { db: wrap(base), sql };
}
const tables = (raw: DatabaseSync) => (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
const writes = (sql: string[]) => sql.filter((s) => /\b(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b|advisory/i.test(s));

function homeFixture(t: TestContext): string {
  const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, db: process.env.DATABASE_URL };
  const home = mkdtempSync(path.join(tmpdir(), "solana-kill-ro-"));
  t.after(() => {
    for (const [key, value] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted], ["DATABASE_URL", saved.db]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  process.env.MERRYMEN_HOME = home; delete process.env.DATABASE_URL; delete process.env.MERRYMEN_HOSTED;
  return home;
}

test("a kill on a database without the Solana table creates nothing and finds nothing to stop", async (t) => {
  const home = homeFixture(t);
  // An accounts file that exists (so the kill opens it) but never got the bindings table.
  const file = path.join(home, "solana-accounts.sqlite");
  const raw = new DatabaseSync(file); t.after(() => raw.close());
  raw.exec("CREATE TABLE unrelated (id TEXT)");
  const { db, sql } = recorded(raw);
  const store = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
  assert.equal(await store.disableForKill(TENANT), false);
  assert.deepEqual(await store.strategyTenants(), []);
  assert.equal(await stopSolanaForKill(TENANT, store), "none", "self-hosted, with an accounts file");
  assert.equal(await stopLocalSolanaForKill(store), "none");
  assert.deepEqual(tables(raw), ["unrelated"], "no Solana table was created");
  assert.deepEqual(writes(sql), [], "read-only: no DDL and no write");
  assert.ok(sql.every((s) => /sqlite_master/.test(s)), sql.join("\n"));
  assert.ok(existsSync(file));
});

test("a PostgreSQL kill looks the table and its column up in the catalog, and never runs the schema step", async () => {
  const sql: string[] = [];
  let table = false, column = false;
  const db: Db = {
    prepare: (text) => {
      sql.push(text);
      return { run: async () => ({ changes: 0, lastInsertRowid: 0 }), get: async () => (/to_regclass/.test(text) ? { found: table, strategy: column } : undefined), all: async () => [] };
    },
    exec: async (text) => { sql.push(text); }, tx: async (fn) => fn(db),
  };
  const store = new SqlSolanaBindingStore(async () => db, "postgres", () => NOW);
  assert.equal(await store.disableForKill(TENANT), false);
  assert.deepEqual(await store.strategyTenants(), []);
  assert.equal(sql.length, 2);
  assert.ok(sql.every((s) => /to_regclass\('solana_wallet_bindings'\)/.test(s) && /pg_attribute/.test(s) && /'strategy_json'/.test(s)), sql.join("\n"));
  // A table from before strategies (no strategy_json): no strategy can exist, and no ALTER adds one.
  table = true;
  assert.equal(await store.disableForKill(TENANT), false);
  assert.deepEqual(await store.strategyTenants(), []);
  // Both present: the kill's own row lock runs on the connection as it is. No advisory lock, no CREATE, no
  // ALTER: that ALTER waited behind every open reader of the table (review RHS, round 1).
  column = true;
  assert.equal(await store.disableForKill(TENANT), false, "no binding row");
  assert.deepEqual(await store.strategyTenants(), []);
  assert.deepEqual(writes(sql), ["UPDATE solana_wallet_bindings SET revision = revision WHERE tenant = ?"]);
  assert.ok(sql.some((s) => /^SELECT tenant FROM solana_wallet_bindings WHERE strategy_json IS NOT NULL/.test(s)));
  // Set up by this process (a Solana route ran first): the kill still looks the table up, and never reruns the
  // schema step (review RHS, round 2: a kill no longer reuses that step's promise).
  await store.get(TENANT);
  const before = sql.length;
  assert.equal(await store.disableForKill(TENANT), false);
  assert.ok(/to_regclass/.test(sql[before]!), sql.slice(before).join("\n"));
  assert.ok(sql.slice(before).every((s) => !/pg_advisory|CREATE|ALTER/.test(s)), sql.slice(before).join("\n"));
});

test("the PostgreSQL schema step adds strategy_json only when the catalog shows it missing", async () => {
  // ADD COLUMN IF NOT EXISTS takes an ACCESS EXCLUSIVE lock even for a column that exists (review RHS, round 2).
  for (const present of [true, false]) {
    const sql: string[] = [];
    const db: Db = {
      prepare: (text) => {
        sql.push(text);
        return { run: async () => ({ changes: 0, lastInsertRowid: 0 }), get: async () => (/AS present/.test(text) ? { present } : undefined), all: async () => [] };
      },
      exec: async (text) => { sql.push(text); }, tx: async (fn) => fn(db),
    };
    await new SqlSolanaBindingStore(async () => db, "postgres", () => NOW).get(TENANT);
    const check = sql.findIndex((s) => /AS present/.test(s));
    assert.ok(check > sql.findIndex((s) => /pg_advisory_xact_lock/.test(s)), "under the schema lock");
    assert.match(sql[check]!, /to_regclass\('solana_wallet_bindings'\)/); assert.match(sql[check]!, /attname = 'strategy_json' AND NOT attisdropped/);
    assert.equal(sql.some((s) => /^ALTER TABLE solana_wallet_bindings ADD COLUMN strategy_json/.test(s)), !present, `present: ${present}`);
  }
});

test("a kill never waits on, or fails with, this process's own schema step still in flight", async () => {
  // Review RHS, round 2: killDb returned database()'s promise whenever it was set, so a kill that landed while a
  // Solana route in this process was still setting up waited for that step (its advisory lock, then an ALTER
  // TABLE queued behind every open reader of the table), and failed when the step failed.
  const sql: string[] = [];
  let fail!: (error: Error) => void;
  const altering = new Promise<void>((_, reject) => { fail = reject; });
  altering.catch(() => {});
  const db: Db = {
    prepare: (text) => {
      sql.push(text);
      return { run: async () => ({ changes: 0, lastInsertRowid: 0 }), get: async () => (/to_regclass/.test(text) ? { found: true, strategy: true } : undefined), all: async () => [] };
    },
    // The schema step's ALTER waits for its ACCESS EXCLUSIVE lock until the test ends it.
    exec: async (text) => { sql.push(text); if (/^ALTER/.test(text)) await altering; },
    tx: async (fn) => fn(db),
  };
  const store = new SqlSolanaBindingStore(async () => db, "postgres", () => NOW);
  const setup = store.get(TENANT);
  setup.catch(() => {});
  const turns = async (until: () => boolean) => { for (let i = 0; i < 50 && !until(); i++) await new Promise((resolve) => setImmediate(resolve)); };
  await turns(() => sql.some((s) => /^ALTER/.test(s)));
  assert.ok(sql.some((s) => /^ALTER/.test(s)), "the schema step is waiting on its ALTER");
  let answered: boolean | null = null;
  const kill = store.disableForKill(TENANT).then((stopped) => { answered = stopped; return stopped; });
  const tenants = store.strategyTenants();
  await turns(() => answered !== null);
  assert.equal(answered, false, "the kill answered while the schema step still waited for its lock");
  assert.deepEqual(await tenants, []);
  fail(new Error("canceling statement due to statement timeout"));
  await assert.rejects(setup, /statement timeout/);
  assert.equal(await kill, false, "and the schema step's failure is not the kill's");
  assert.equal(await store.disableForKill(TENANT), false, "nor does a later kill wait on, or fail with, it");
});

test("on SQLite too, a table without strategy_json has nothing to stop, and a kill never adds the column", async (t) => {
  homeFixture(t);
  const raw = new DatabaseSync(":memory:"); t.after(() => raw.close());
  raw.exec(`CREATE TABLE solana_wallet_bindings (tenant TEXT PRIMARY KEY, did TEXT NOT NULL, chain TEXT NOT NULL, owner TEXT NOT NULL UNIQUE,
    requested_mode TEXT NOT NULL, limits_json TEXT, revision BIGINT NOT NULL, created_at_ms BIGINT NOT NULL, updated_at_ms BIGINT NOT NULL)`);
  const { db, sql } = recorded(raw);
  const store = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
  assert.equal(await store.disableForKill(TENANT), false);
  assert.deepEqual(await store.strategyTenants(), []);
  assert.deepEqual(writes(sql), []);
  const columns = (raw.prepare("PRAGMA table_info(solana_wallet_bindings)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.equal(columns.includes("strategy_json"), false);
});

test("once another process made the table, a fresh store's kill stops the strategy", async (t) => {
  const home = homeFixture(t);
  const file = path.join(home, "solana-accounts.sqlite");
  const writer = new DatabaseSync(file); t.after(() => writer.close());
  const owner = new SqlSolanaBindingStore(async () => wrapSqlite(writer), "sqlite", () => NOW);
  await owner.bind(TENANT, "did:privy:alice", OWNER);
  await owner.settings(TENANT, OWNER, 0, "paper", limits);
  const on = await owner.strategy(TENANT, OWNER, 1, strategy);
  const reader = new DatabaseSync(file); t.after(() => reader.close());
  const { db, sql } = recorded(reader);
  const killer = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW + 1);
  assert.deepEqual(await killer.strategyTenants(), [TENANT]);
  assert.equal(await stopSolanaForKill(TENANT, killer), "stopped");
  assert.ok(writes(sql).every((s) => /^UPDATE solana_wallet_bindings SET /.test(s)), `only the kill's own writes, no schema step:\n${writes(sql).join("\n")}`);
  const off = (await owner.get(TENANT))!;
  assert.equal(off.strategy!.enabled, false);
  assert.equal(off.revision, on.revision + 1, "the bump fences admission already in flight");
});

test("with the table present a kill still fails closed, and a failed lookup is never read as 'none'", async (t) => {
  homeFixture(t);
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/never-connected"; // the kill helper reaches the store
  const raw = new DatabaseSync(":memory:"); t.after(() => raw.close());
  const owner = new SqlSolanaBindingStore(async () => wrapSqlite(raw), "sqlite", () => NOW);
  await owner.bind(TENANT, "did:privy:alice", OWNER);
  await owner.settings(TENANT, OWNER, 0, "paper", limits);
  await owner.strategy(TENANT, OWNER, 1, strategy);
  const base = wrapSqlite(raw);
  const failing: Db = { prepare: (s) => base.prepare(s), exec: (s) => base.exec(s),
    tx: () => Promise.reject(new Error("database unavailable")) };
  const broken = new SqlSolanaBindingStore(async () => failing, "sqlite", () => NOW);
  await assert.rejects(broken.disableForKill(TENANT), /database unavailable/);
  await assert.rejects(stopSolanaForKill(TENANT, broken), /database unavailable/);
  const unreachable = new SqlSolanaBindingStore(async () => { throw new Error("connect refused"); }, "postgres", () => NOW);
  await assert.rejects(unreachable.disableForKill(TENANT), /connect refused/);
  await assert.rejects(unreachable.strategyTenants(), /connect refused/);
  const lookupFails: Db = { prepare: () => ({ run: async () => ({ changes: 0, lastInsertRowid: 0 }), get: async () => { throw new Error("catalog read failed"); }, all: async () => [] }),
    exec: async () => {}, tx: async (fn) => fn(lookupFails) };
  await assert.rejects(new SqlSolanaBindingStore(async () => lookupFails, "postgres", () => NOW).disableForKill(TENANT), /catalog read failed/);
});
