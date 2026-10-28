import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerMigrations, ledgerMigrationSkipped } from "./ledger-migrations";

test("existing columns skip ALTER while missing columns are added and checked afresh next pass", async () => {
  const raw = new DatabaseSync(":memory:");
  const real = wrapSqlite(raw);
  const executed: string[] = [];
  const db: Db = { prepare: sql => real.prepare(sql), tx: fn => real.tx(fn), exec: async sql => {
    executed.push(sql); await real.exec(sql);
  } };
  try {
    await real.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, peak REAL NOT NULL DEFAULT 0)");
    await real.prepare("INSERT INTO agents (id, peak) VALUES (?, ?)").run("owner", 123);
    const migrations = ["ALTER TABLE agents ADD COLUMN peak REAL NOT NULL DEFAULT 0", "ALTER TABLE agents ADD COLUMN fee REAL NOT NULL DEFAULT 0"];
    await applyLedgerMigrations(db, migrations);
    assert.deepEqual(executed, [migrations[1]]);
    const row = await real.prepare("SELECT peak, fee FROM agents").get() as { peak: number; fee: number };
    assert.deepEqual([row.peak, row.fee], [123, 0]);
    executed.length = 0;
    await applyLedgerMigrations(db, migrations);
    assert.deepEqual(executed, []);
    await real.exec("ALTER TABLE agents DROP COLUMN fee");
    await applyLedgerMigrations(db, migrations);
    assert.deepEqual(executed, [migrations[1]], "no process-wide success latch can hide a missing column");
  } finally { raw.close(); }
});

test("a real missing-column failure stops migration instead of reporting partial schema as ready", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec("CREATE TABLE agents (id TEXT)");
    await db.prepare("INSERT INTO agents VALUES (?)").run("owner");
    await assert.rejects(applyLedgerMigrations(db, [
      "ALTER TABLE agents ADD COLUMN required_amount REAL NOT NULL",
      "ALTER TABLE agents ADD COLUMN later_column TEXT",
    ]), /NOT NULL/);
    const columns = await db.prepare("SELECT name FROM pragma_table_info('agents')").all() as { name: string }[];
    assert.deepEqual(columns.map(c => c.name), ["id"]);
  } finally { raw.close(); }
});

test("a SQLite concurrent column addition is accepted only after the column is confirmed", async () => {
  const raw = new DatabaseSync(":memory:");
  const real = wrapSqlite(raw);
  try {
    await real.exec("CREATE TABLE agents (id TEXT)");
    let raced = false;
    const db: Db = {
      prepare: sql => real.prepare(sql), tx: fn => real.tx(fn),
      exec: async sql => {
        if (!raced) { raced = true; await real.exec(sql); }
        await real.exec(sql);
      },
    };
    await applyLedgerMigrations(db, ["ALTER TABLE agents ADD COLUMN peak REAL NOT NULL DEFAULT 0"]);
    const columns = await real.prepare("SELECT name FROM pragma_table_info('agents')").all() as { name: string }[];
    assert.deepEqual(columns.map(c => c.name), ["id", "peak"]);
    const failure = new Error("duplicate column name: missing");
    await assert.rejects(applyLedgerMigrations({ ...db, exec: async () => { throw failure; } },
      ["ALTER TABLE agents ADD COLUMN missing TEXT"]), error => error === failure);
  } finally { raw.close(); }
});

test("catalog failure stops before DDL and is never mistaken for SQLite", async () => {
  const failure = Object.assign(new Error("permission denied for table pg_attribute"), { code: "42501" });
  let executions = 0;
  const db: Db = {
    prepare: () => ({ all: async () => { throw failure; }, get: async () => null, run: async () => ({ changes: 0, lastInsertRowid: 0 }) }),
    exec: async () => { executions++; },
    tx: async () => { throw new Error("not used"); },
  };
  await assert.rejects(applyLedgerMigrations(db, ["ALTER TABLE agents ADD COLUMN peak REAL"]), error => error === failure);
  assert.equal(executions, 0);
});

test("a non-ALTER migration that throws is skipped as before, and said by its index alone", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  const lines: string[] = [];
  try {
    await db.exec("CREATE TABLE flows (tx_hash TEXT)");
    await db.prepare("INSERT INTO flows VALUES (?)").run("0xABC-secret-row");
    await applyLedgerMigrations(db, [
      "UPDATE flows SET tx_hash = LOWER(tx_hash)",
      "UPDATE no_such_table SET tx_hash = '0xABC-secret-row'",
      "ALTER TABLE flows ADD COLUMN chain TEXT",
    ], (line) => lines.push(line));
    assert.deepEqual(lines, [ledgerMigrationSkipped(1)]);
    assert.equal(lines[0], "[warn] ledger migration #1 failed and was skipped; the ledger opened without it");
    // The migrations around it still ran.
    const row = await db.prepare("SELECT tx_hash, chain FROM flows").get() as { tx_hash: string; chain: string | null };
    assert.deepEqual([row.tx_hash, row.chain], ["0xabc-secret-row", null]);
    lines.length = 0;
    await applyLedgerMigrations(db, ["UPDATE flows SET tx_hash = LOWER(tx_hash)"], (line) => lines.push(line));
    assert.deepEqual(lines, [], "nothing to say when every statement runs");
  } finally { raw.close(); }
});
