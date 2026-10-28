/** Opt-in, disposable LOCAL PostgreSQL only. Never reads DATABASE_URL. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { makePgDb, type Db } from "./db";
import { PERP_EQUITY_ALTERS, PERP_LEDGER_ALTERS, applyLedgerSchema } from "./store";
import { applyLedgerMigrations } from "./ledger-migrations";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
interface Client {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

test("Postgres: repeated ledger setup does not queue exclusive locks behind public reads", { skip: !url, timeout: 60_000 }, async t => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only a disposable local PostgreSQL is allowed");
  const pg = createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => Client };
  const schema = `mm_migration_lock_${randomBytes(8).toString("hex")}`;
  const shadow = `${schema}_shadow`;
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  const scoped = (who: string, searchPath = schema) => {
    const u = new URL(target);
    u.searchParams.set("options", `-c search_path=${searchPath} -c statement_timeout=5000 -c lock_timeout=500`);
    u.searchParams.set("application_name", `ledger-migration-test-${who}`);
    return u.toString();
  };
  const reader = new pg.Client({ connectionString: scoped("reader") });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE SCHEMA ${shadow}`);
  try {
    await reader.connect();
    const db = await makePgDb(scoped("migrator"));
    await applyLedgerSchema(db);

    await t.test("a held AccessShareLock permits the entire no-op schema pass, with no ADD COLUMN issued", async () => {
      await reader.query("BEGIN");
      await reader.query("SELECT smart_account FROM agents LIMIT 1");
      const alters: string[] = [];
      const observed: Db = {
        prepare: sql => db.prepare(sql), tx: fn => db.tx(fn),
        exec: async sql => { if (/^ALTER TABLE/i.test(sql)) alters.push(sql); await db.exec(sql); },
      };
      try {
        // Before the catalog guard the first existing agents column waited
        // for this reader's transaction, then hit lock_timeout. Every pass did it.
        await applyLedgerSchema(observed);
        assert.deepEqual(alters, []);
        assert.equal((await reader.query("SELECT COUNT(*) AS n FROM agents")).rows.length, 1);
      } finally { await reader.query("ROLLBACK"); }
    });

    await t.test("missing required columns still migrate, and a lock failure cannot be swallowed", async () => {
      await db.exec("ALTER TABLE agents DROP COLUMN hwm_withdrawn_usdg");
      await reader.query("BEGIN");
      await reader.query("SELECT smart_account FROM agents LIMIT 1");
      try {
        await assert.rejects(applyLedgerSchema(db), error => (error as { code?: string }).code === "55P03");
      } finally { await reader.query("ROLLBACK"); }
      await applyLedgerSchema(db);
      const column = await db.prepare(`SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'hwm_withdrawn_usdg'`).get() as Record<string, unknown>;
      assert.equal(column.is_nullable, "NO");
      assert.match(String(column.column_default), /0/);
    });

    await t.test("a missing column's ADD waits a bounded time for its lock, so readers never queue behind it for long", async () => {
      // The perp ledger's equity columns are the first ADD COLUMN on `equity`
      // since the catalog guard, and `equity` is the shared ledger's hottest
      // table. A held reader makes the ADD give up after waitMs, pause, and try
      // again; a second reader arriving meanwhile is not queued behind it.
      await db.exec("CREATE TABLE lock_probe (id TEXT)");
      // A migrator with NO lock_timeout of its own (unlike `scoped`), as the
      // production pool has none: only the runner's SET LOCAL can bound it.
      const unbounded = new URL(target);
      unbounded.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=5000`);
      const migrator = await makePgDb(unbounded.toString());
      await reader.query("BEGIN");
      await reader.query("SELECT id FROM lock_probe LIMIT 1");
      const late = new pg.Client({ connectionString: scoped("late") });
      await late.connect();
      const lock = { waitMs: 150, tries: 3, pauseMs: 50 };
      try {
        const t0 = Date.now();
        const pending = applyLedgerMigrations(migrator, ["ALTER TABLE lock_probe ADD COLUMN probe TEXT"], undefined, lock);
        await new Promise((r) => setTimeout(r, 60));
        // While the ADD is between tries or waiting, a new reader gets through promptly.
        const r0 = Date.now();
        await late.query("SELECT COUNT(*) FROM lock_probe");
        assert.ok(Date.now() - r0 < 400, `a reader waited ${Date.now() - r0} ms behind the ADD`);
        await assert.rejects(pending, (error) => (error as { code?: string }).code === "55P03");
        assert.ok(Date.now() - t0 < 2_000, "it gave up after its tries, not after the reader");
        // The timeout ended with the ALTER: the pool's connections carry none.
        assert.deepEqual(await migrator.prepare("SHOW lock_timeout").get(), { lock_timeout: "0" });
      } finally {
        await reader.query("ROLLBACK");
        await late.end();
      }
      // The table free again, the same migration lands.
      await applyLedgerMigrations(db, ["ALTER TABLE lock_probe ADD COLUMN probe TEXT"], undefined, lock);
      const cols = await db.prepare(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'lock_probe'`).all() as { column_name: string }[];
      assert.ok(cols.some((c) => c.column_name === "probe"));
    });

    await t.test("a Db that cannot open a transaction of its own still migrates (a caller's or a test's wrapper)", async () => {
      await db.exec("CREATE TABLE notx_probe (id TEXT)");
      const noTx: Db = { prepare: (sql) => db.prepare(sql), exec: (sql) => db.exec(sql), tx: async () => { throw new Error("not here"); } };
      await applyLedgerMigrations(noTx, ["ALTER TABLE notx_probe ADD COLUMN probe TEXT"]);
      const cols = await db.prepare(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'notx_probe'`).all() as { column_name: string }[];
      assert.ok(cols.some((c) => c.column_name === "probe"));
    });

    await t.test("the perp ledger lands over the shared schema: its tables, and equity's venue columns NULL on old rows", async () => {
      // Built as the shared ledger stands before this change: the real schema,
      // stripped of what the perp ledger adds.
      for (const tbl of ["perp_orders", "perp_order_legs", "perp_fills", "perp_funding", "perp_transfers", "perp_positions", "perp_accounts", "perp_carries"]) {
        await db.exec(`DROP TABLE IF EXISTS ${tbl}`);
      }
      for (const ddl of PERP_EQUITY_ALTERS) await db.exec(`ALTER TABLE equity DROP COLUMN IF EXISTS ${/ADD COLUMN (\w+)/.exec(ddl)![1]}`);
      await db.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, mode, at) VALUES ('0xa', '0', 10, 0, 0, 10, 'live', 1)").run();
      // Two processes booting at once, as a deploy does.
      const other = await makePgDb(scoped("perp-other"));
      await Promise.all([applyLedgerSchema(db), applyLedgerSchema(other)]);
      const tables = await db.prepare(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'perp_%'`).all() as { table_name: string }[];
      assert.equal(tables.length, 8, JSON.stringify(tables));
      const row = await db.prepare("SELECT perp_collateral_micro, cash_read_block FROM equity WHERE agent_id = '0xa'").get() as Record<string, unknown>;
      assert.deepEqual({ ...row }, { perp_collateral_micro: null, cash_read_block: null }, "an old row predates the question: NULL, never 0");
      // A perp_positions an earlier build made, without the recorded-stop columns: they are added.
      for (const ddl of PERP_LEDGER_ALTERS) await db.exec(`ALTER TABLE perp_positions DROP COLUMN ${/ADD COLUMN (\w+)/.exec(ddl)![1]}`);
      await Promise.all([applyLedgerSchema(db), applyLedgerSchema(other)]);
      const cols = await db.prepare(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'perp_positions' AND column_name LIKE 'recorded_stop_%' ORDER BY column_name`).all() as { column_name: string }[];
      assert.deepEqual(cols.map((c) => c.column_name), ["recorded_stop_price", "recorded_stop_trigger"]);
      await db.prepare("DELETE FROM equity WHERE agent_id = '0xa'").run();
    });

    await t.test("catalog lookup honors search-path shadowing rather than a namesake in another schema", async () => {
      await admin.query(`CREATE TABLE ${shadow}.agents (id TEXT, peak DOUBLE PRECISION NOT NULL DEFAULT 0)`);
      await db.exec("CREATE TABLE catalog_probe (id TEXT)");
      await admin.query(`CREATE TABLE ${shadow}.catalog_probe (id TEXT, peak DOUBLE PRECISION NOT NULL DEFAULT 0)`);
      const visible = await makePgDb(scoped("shadow", `${schema},${shadow}`));
      await applyLedgerMigrations(visible, ["ALTER TABLE catalog_probe ADD COLUMN peak REAL NOT NULL DEFAULT 0"]);
      const columns = await visible.prepare(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'catalog_probe'`).all() as { column_name: string }[];
      assert.ok(columns.some(c => c.column_name === "peak"));
    });

    await t.test("two initializers that both see a missing column complete safely", async () => {
      await db.exec("CREATE TABLE concurrent_probe (id TEXT)");
      const other = await makePgDb(scoped("other"));
      let catalogs = 0;
      let release!: () => void;
      const bothRead = new Promise<void>(resolve => { release = resolve; });
      const synchronizedCatalog = (base: Db): Db => ({
        exec: sql => base.exec(sql), tx: fn => base.tx(fn),
        prepare(sql) {
          const stmt = base.prepare(sql);
          if (!sql.includes("pg_catalog.pg_attribute")) return stmt;
          return { ...stmt, all: async (...params) => {
            const rows = await stmt.all(...params);
            if (++catalogs === 2) release();
            await bothRead;
            return rows;
          } };
        },
      });
      const migration = ["ALTER TABLE concurrent_probe ADD COLUMN peak REAL NOT NULL DEFAULT 7"];
      await Promise.all([applyLedgerMigrations(synchronizedCatalog(db), migration), applyLedgerMigrations(synchronizedCatalog(other), migration)]);
      await db.prepare("INSERT INTO concurrent_probe (id) VALUES (?)").run("row");
      assert.deepEqual(await db.prepare("SELECT peak FROM concurrent_probe").get(), { peak: 7 });
    });
  } finally {
    await reader.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP SCHEMA ${shadow} CASCADE`);
    await admin.end();
  }
});

/**
 * THE EVM-ONLY TX-HASH FOLD, ON POSTGRES (Solana P0; audit merge-history 2b(1)).
 *
 * Every open runs `UPDATE flows SET tx_hash = LOWER(tx_hash) WHERE ... AND <0x + 64 hex>`
 * through applyLedgerMigrations, which swallows a non-ALTER statement's error. So if
 * that test (LENGTH/SUBSTR/LTRIM, written to read the same on both engines) failed on
 * Postgres, upper-case EVM hashes would silently stop folding (and a deposit could be
 * counted twice beside its lower-case twin), and nothing would say so. ledger-hash-case
 * .test.ts proves it on SQLite; this proves it here, over two opens.
 */
test("Postgres: the open-time fold lowercases EVM hashes and leaves a Solana signature as written", { skip: !url, timeout: 60_000 }, async () => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only a disposable local PostgreSQL is allowed");
  const pg = createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => Client };
  const schema = `mm_hash_fold_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Client({ connectionString: target.toString() });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    const scoped = new URL(target);
    scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=5000`);
    scoped.searchParams.set("application_name", "ledger-hash-fold-test");
    const db = await makePgDb(scoped.toString());
    await applyLedgerSchema(db);
    // A book from before the identity index, as ledger-hash-case.test.ts builds one.
    await db.exec("DROP INDEX IF EXISTS flows_chain_identity");
    await db.exec("DELETE FROM flows");
    const ACCOUNT = "0x00000000000000000000000000000000000000c1", CHAIN = 4663;
    await db.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode)
      VALUES (?, ?, ?, ?, '{}', 0, 0, 'live')`).run(ACCOUNT, ACCOUNT, ACCOUNT, CHAIN);
    const LOWER = `0x${"0123456789abcdef".repeat(4)}`;
    const UPPER = `0x${"0123456789ABCDEF".repeat(4)}`;
    const MIXED = `0x${"aBcDeF01".repeat(8)}`;
    const CAPITAL_X = `0X${"FEDCBA98".repeat(8)}`;
    // Base58, 64 bytes, upper case in it to lose: a Solana signature's shape.
    const SIGNATURE = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    // 66 characters with a 0x, but not hex throughout: not an EVM hash, kept as written.
    const NOT_HEX = `0x${"ABCDEFGH".repeat(8)}`;
    const rows: Array<[string | null, number | null, string, number | null]> = [
      [LOWER, 0, "chain-log", CHAIN], [UPPER, 1, "chain-log", null], [MIXED, null, "transfer-intent", CHAIN],
      [CAPITAL_X, 2, "chain-log", CHAIN], [SIGNATURE, 3, "chain-log", CHAIN], [NOT_HEX, 4, "chain-log", CHAIN], [null, null, "inferred", null],
    ];
    for (const [tx, log, source, chain] of rows) {
      await db.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
        VALUES (?, 'in', 10, ?, ?, ?, ?, 1, ?, ?)`).run(ACCOUNT, tx, tx === null ? null : 100, log, source, chain, 1_790_000_000);
    }
    const expected = [LOWER, UPPER.toLowerCase(), MIXED.toLowerCase(), CAPITAL_X.toLowerCase(), SIGNATURE, NOT_HEX, null];
    for (const open of [1, 2]) {
      await applyLedgerSchema(db);
      const got = await db.prepare("SELECT tx_hash, chain_id FROM flows ORDER BY id").all() as Array<{ tx_hash: string | null; chain_id: number | null }>;
      assert.deepEqual(got.map((r) => r.tx_hash), expected, `open ${open}: every EVM hash folded, the signature byte for byte`);
      assert.equal(Number(got[1]!.chain_id), CHAIN, `open ${open}: the legacy row gets its chain from the grant`);
    }
    // The identity index came back over the folded rows.
    const index = await db.prepare("SELECT to_regclass('flows_chain_identity') IS NOT NULL AS present").get() as { present: boolean };
    assert.equal(index.present, true);
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
