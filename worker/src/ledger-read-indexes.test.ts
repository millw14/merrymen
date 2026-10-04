import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { translateSchema, wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";

const ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CASED = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const indexes = [
  { name: "equity_agent_run_normalized", table: "equity", time: "at", descending: true },
  { name: "flows_agent_run_normalized", table: "flows", time: "at", descending: false },
  { name: "trades_agent_run_normalized", table: "trades", time: "created_at", descending: false },
] as const;

function indexDefinitions(raw: DatabaseSync) {
  return raw.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND name IN (?, ?, ?) ORDER BY name")
    .all(...indexes.map(index => index.name)) as { name: string; sql: string }[];
}

function assertIndexes(raw: DatabaseSync) {
  const definitions = indexDefinitions(raw);
  assert.equal(definitions.length, indexes.length);
  for (const index of indexes) {
    const definition = definitions.find(row => row.name === index.name)!;
    const desc = index.descending ? "\\s+DESC" : "";
    assert.match(definition.sql, new RegExp(`ON\\s+${index.table}\\s*\\(\\s*LOWER\\(agent_id\\),\\s*epoch,\\s*${index.time}${desc},\\s*id${desc}\\s*\\)`, "i"));
    const metadata = raw.prepare(`PRAGMA index_list('${index.table}')`).all() as { name: string; unique: number; partial: number }[];
    const installed = metadata.find(row => row.name === index.name)!;
    assert.equal(installed.unique, 0, "read indexes must not become accounting uniqueness constraints");
    assert.equal(installed.partial, 0);
    const keys = (raw.prepare(`PRAGMA index_xinfo('${index.name}')`).all() as { cid: number; name: string | null; desc: number; key: number }[])
      .filter(row => row.key === 1);
    assert.equal(keys[0]!.cid, -2, "the leading key must be the normalized account expression");
    assert.deepEqual(keys.map(row => row.name), [null, "epoch", index.time, "id"]);
    assert.deepEqual(keys.map(row => row.desc), [0, 0, Number(index.descending), Number(index.descending)]);
  }
}

async function seedLegacyRows(db: Db) {
  // Equivalent address spellings and same-time rows remain separate history.
  // A read index must neither deduplicate those rows nor reject their inserts.
  for (const account of [ACCOUNT, CASED]) {
    await db.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at, epoch)
      VALUES (?, '0', 10, 0, 10, 5, 1)`).run(account);
    await db.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, source, at, epoch)
      VALUES (?, 'in', 10, 'inferred', 5, 1)`).run(account);
    await db.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, epoch)
      VALUES (?, 'swap', 'fixture', 1, 'landed', 5, 1)`).run(account);
  }
}

test("production SQLite schema installs nonunique normalized account/run indexes and uses them for bounded reads", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await applyLedgerSchema(db);
    await seedLegacyRows(db);
    assertIndexes(raw);
    const searches = [
      { name: indexes[0].name, table: "equity", sql: "SELECT id, equity_usdg FROM equity WHERE LOWER(agent_id) = ? AND epoch = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1" },
      { name: indexes[1].name, table: "flows", sql: "SELECT SUM(amount_usdg) FROM flows WHERE LOWER(agent_id) = ? AND epoch = ? AND at <= ?" },
      { name: indexes[2].name, table: "trades", sql: "SELECT id, gas_usdg FROM trades WHERE LOWER(agent_id) = ? AND epoch = ? AND created_at <= ? ORDER BY created_at, id" },
    ];
    for (const search of searches) {
      const details = (raw.prepare(`EXPLAIN QUERY PLAN ${search.sql}`).all(ACCOUNT, 1, 5) as { detail: string }[])
        .map(row => row.detail).join("\n");
      assert.match(details, new RegExp(`SEARCH ${search.table} USING (?:COVERING )?INDEX ${search.name}`));
      assert.match(details, /<expr>=\? AND epoch=\?/);
      assert.doesNotMatch(details, new RegExp(`\\bSCAN ${search.table}\\b`));
      assert.doesNotMatch(details, /USE TEMP B-TREE FOR ORDER BY/);
    }
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM flows WHERE LOWER(agent_id) = ? AND epoch = 1").get(ACCOUNT) as { n: number }).n, 2);
  } finally { raw.close(); }
});

test("an existing pre-epoch ledger installs indexes after column upgrades and repeated boots preserve all rows", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    // Derive the older state from the production schema, so unrelated columns
    // and constraints cannot drift from a hand-copied migration fixture.
    await applyLedgerSchema(db);
    await seedLegacyRows(db);
    for (const index of indexes) {
      raw.exec(`DROP INDEX ${index.name}`);
      raw.exec(`ALTER TABLE ${index.table} DROP COLUMN epoch`);
      const columns = raw.prepare(`PRAGMA table_info('${index.table}')`).all() as { name: string }[];
      assert.ok(!columns.some(row => row.name === "epoch"));
    }
    for (let boot = 0; boot < 3; boot++) {
      await applyLedgerSchema(db);
      assertIndexes(raw);
      for (const index of indexes) {
        const rows = raw.prepare(`SELECT agent_id, epoch FROM ${index.table} ORDER BY id`).all() as { agent_id: string; epoch: number }[];
        assert.deepEqual(rows.map(row => ({ ...row })), [{ agent_id: ACCOUNT, epoch: 1 }, { agent_id: CASED, epoch: 1 }]);
      }
    }
  } finally { raw.close(); }
});

test("self-hosted SQLite initialization installs the same indexes in a disposable home", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-read-indexes-"));
  try {
    const storeUrl = new URL("./store.ts", import.meta.url).href;
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import path from 'node:path';
      const { initStore, closeStoreForTest } = await import(${JSON.stringify(storeUrl)});
      await initStore();
      closeStoreForTest();
      const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, 'merrymen.db'));
      process.stdout.write(JSON.stringify(raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE '%_agent_run_normalized' ORDER BY name").all()));
      raw.close();
    `;
    // An empty cwd avoids legacy .data migration; DATABASE_URL is disabled so
    // this test never consults a configured external database.
    const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
      cwd: home, env: { ...process.env, DATABASE_URL: "", MERRYMEN_HOME: home }, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), indexes.map(index => ({ name: index.name })).sort((a, b) => a.name.localeCompare(b.name)));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/** Schema-only PostgreSQL stand-in: real translation, no network connection. */
function translatedPostgres(code: string, failures: number) {
  const statements: string[] = [];
  const failure = Object.assign(new Error("index installation failed"), { code });
  let attempts = 0;
  const db: Db = {
    prepare() { throw new Error("unexpected query in schema installation"); },
    tx: fn => fn(db),
    async exec(ddl) {
      const sql = translateSchema(ddl);
      statements.push(sql);
      if (new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${indexes[0].name}\\b`, "i").test(sql)) {
        attempts += 1;
        if (attempts <= failures) throw failure;
      }
    },
  };
  return { db, statements, failure, attempts: () => attempts };
}

test("translated PostgreSQL index creation retries catalog races after the required column ALTERs", async () => {
  for (const code of ["23505", "42P07", "42710"]) {
    const mock = translatedPostgres(code, 2);
    await applyLedgerSchema(mock.db);
    assert.equal(mock.attempts(), 3, `${code}: the third index attempt succeeds`);
    for (const index of indexes) {
      const alter = mock.statements.findIndex(sql => new RegExp(`ALTER TABLE ${index.table} ADD COLUMN IF NOT EXISTS epoch BIGINT`, "i").test(sql));
      const create = mock.statements.findIndex(sql => new RegExp(`CREATE INDEX IF NOT EXISTS ${index.name}\\b`, "i").test(sql));
      assert.ok(alter >= 0 && create > alter, `${index.name} must follow its epoch migration`);
      assert.match(mock.statements[create]!, /LOWER\(agent_id\)/);
      assert.doesNotMatch(mock.statements[create]!, /CREATE UNIQUE INDEX/i);
    }
  }
});

test("persistent index catalog races stop after three attempts and unrelated failures are not swallowed", async () => {
  for (const [code, attempts] of [["23505", 3], ["42501", 1], ["42601", 1]] as const) {
    const mock = translatedPostgres(code, 10);
    await assert.rejects(applyLedgerSchema(mock.db), error => error === mock.failure);
    assert.equal(mock.attempts(), attempts, code);
  }
});
