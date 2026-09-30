/**
 * The connection-resource migration (mcp_connections.resource, 2026-09): an
 * existing database gains the column and the one-active index is rebuilt per
 * (tenant, client_id, resource), rows written before it keep meaning the
 * canonical resource, and a boot with nothing to do still runs no DDL. When
 * the migration is all there is to do, it runs on mcp_connections alone (no
 * whole-schema DDL locking every MCP table); a fresh database is unchanged.
 *
 * SQLite runs for real. Postgres is checked by the statements ensureMcpSchema
 * sends, in order, and their translation (the repo has no Postgres server; the
 * same DDL was also run against PGlite by hand when this landed, and the
 * migration-only path again when it moved off MCP_SCHEMA: PGlite 0.5.8 /
 * Postgres 18.3, where pg_locks at COMMIT showed locks on mcp_connections
 * alone, against 14 MCP tables for the full path).
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { translateQuery, translateSchema, wrapSqlite, type Db, type Stmt } from "../db";
import { CONNECTION_RESOURCE_DDL, MCP_SCHEMA, MCP_SCHEMA_OBJECTS, ONE_ACTIVE_INDEX, ONE_ACTIVE_INDEX_DDL, ensureMcpSchema } from "./schema";

/** MCP_SCHEMA as it was before the column: no `resource`, and the (tenant, client_id) one-active index. */
function legacySchema(): string {
  const old = MCP_SCHEMA
    .replace("revoked_why TEXT,\n  resource TEXT\n);", "revoked_why TEXT\n);")
    .replace("(tenant, client_id, COALESCE(resource, ''))", "(tenant, client_id)");
  assert.notEqual(old, MCP_SCHEMA);
  assert.ok(!old.includes("COALESCE") && !old.includes("resource TEXT\n);"), "both parts of the old DDL were rebuilt");
  return old;
}

function counted(raw: DatabaseSync): { db: Db; execs: string[] } {
  const inner = wrapSqlite(raw);
  const execs: string[] = [];
  const wrap = (d: Db): Db => ({
    prepare: (s) => d.prepare(s),
    exec: (s) => { execs.push(s === MCP_SCHEMA ? "<MCP_SCHEMA>" : s); return d.exec(s); },
    tx: (fn) => d.tx((t) => fn(wrap(t))),
  });
  return { db: wrap(inner), execs };
}

const insertConnection = (raw: DatabaseSync, id: string, clientId: string, status = "active") =>
  raw.prepare(`INSERT INTO mcp_connections (id, tenant, client_id, client_name, client_host, kind, scopes, agent_slugs, status, created_at, updated_at)
    VALUES (?, '0xaa', ?, 'Claude', 'claude.ai', 'oauth', 'market:read trade:propose', '[]', ?, 1, 1)`).run(id, clientId, status);

const indexSql = (raw: DatabaseSync) => (raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(ONE_ACTIVE_INDEX) as { sql: string } | undefined)?.sql ?? "";

test("SQLite: an existing database gains the column and the per-resource index; old rows keep their data and mean the canonical resource", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(legacySchema());
  insertConnection(raw, "mcpcon_1", "https://claude.ai/oauth/mcp-oauth-client-metadata");
  insertConnection(raw, "mcpcon_2", "mcpc_other");
  insertConnection(raw, "mcpcon_3", "https://claude.ai/oauth/mcp-oauth-client-metadata", "revoked");
  assert.doesNotMatch(indexSql(raw), /resource/);
  const { db, execs } = counted(raw);
  await ensureMcpSchema(db, "sqlite");
  assert.deepEqual(execs, [CONNECTION_RESOURCE_DDL, `DROP INDEX IF EXISTS ${ONE_ACTIVE_INDEX}`, ONE_ACTIVE_INDEX_DDL], "column first, old index dropped, then only that index recreated (not the whole schema)");
  assert.match(indexSql(raw), /\(tenant, client_id, COALESCE\(resource, ''\)\) WHERE status = 'active' AND kind = 'oauth'/);
  const rows = raw.prepare("SELECT id, scopes, status, resource FROM mcp_connections ORDER BY id").all() as Array<{ id: string; scopes: string; status: string; resource: string | null }>;
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.resource]), [["mcpcon_1", "active", null], ["mcpcon_2", "active", null], ["mcpcon_3", "revoked", null]]);
  assert.ok(rows.every((r) => r.scopes === "market:read trade:propose"), "nothing else changed");

  // The rule the index now enforces: one active oauth connection per (tenant, client, resource), NULL counted as one value.
  const add = (id: string, clientId: string, resource: string | null) => raw.prepare(`INSERT INTO mcp_connections (id, tenant, client_id, kind, scopes, agent_slugs, status, created_at, updated_at, resource)
    VALUES (?, '0xaa', ?, 'oauth', 'market:read', '[]', 'active', 2, 2, ?)`).run(id, clientId, resource);
  const claude = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  assert.throws(() => add("dup", claude, null), /UNIQUE/, "a second canonical connection for the same app still collides");
  add("dir", claude, "https://mcp.test/mcp/directory");
  assert.throws(() => add("dir2", claude, "https://mcp.test/mcp/directory"), /UNIQUE/, "and so does a second directory one");
  add("other", claude, "https://mcp.test/mcp/listing");

  // The next boot has nothing to do.
  await ensureMcpSchema(db, "sqlite");
  assert.equal(execs.length, 3, "no DDL once migrated");
});

test("SQLite: a fresh database is created in one pass, with nothing to migrate", async () => {
  const raw = new DatabaseSync(":memory:");
  const { db, execs } = counted(raw);
  await ensureMcpSchema(db, "sqlite");
  assert.deepEqual(execs, ["<MCP_SCHEMA>"]);
  assert.ok((raw.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('mcp_connections') WHERE name = 'resource'").get() as { n: number }).n === 1);
  assert.match(indexSql(raw), /COALESCE\(resource, ''\)/);
  await ensureMcpSchema(db, "sqlite");
  assert.equal(execs.length, 1);
});

test("SQLite: an old-style index put back after the migration (code from before it, rolled back to) is rebuilt on the next boot, without touching the column", async () => {
  const raw = new DatabaseSync(":memory:");
  const { db, execs } = counted(raw);
  await ensureMcpSchema(db, "sqlite");
  raw.exec(`DROP INDEX ${ONE_ACTIVE_INDEX}`);
  raw.exec(`CREATE UNIQUE INDEX ${ONE_ACTIVE_INDEX} ON mcp_connections (tenant, client_id) WHERE status = 'active' AND kind = 'oauth'`);
  await ensureMcpSchema(db, "sqlite");
  assert.deepEqual(execs.slice(1), [`DROP INDEX IF EXISTS ${ONE_ACTIVE_INDEX}`, ONE_ACTIVE_INDEX_DDL]);
  assert.match(indexSql(raw), /COALESCE\(resource, ''\)/);
});

test("SQLite: the migration-only path creates the index exactly as a fresh database has it, and is safe to run again", async () => {
  const fresh = new DatabaseSync(":memory:");
  await ensureMcpSchema(wrapSqlite(fresh), "sqlite");
  const migrated = new DatabaseSync(":memory:");
  migrated.exec(legacySchema());
  await ensureMcpSchema(wrapSqlite(migrated), "sqlite");
  assert.equal(indexSql(migrated), indexSql(fresh));
  // Every step again, by hand, on the migrated database: each is a no-op or idempotent where SQLite allows it.
  migrated.exec(`DROP INDEX IF EXISTS ${ONE_ACTIVE_INDEX}`);
  migrated.exec(ONE_ACTIVE_INDEX_DDL);
  migrated.exec(ONE_ACTIVE_INDEX_DDL);
  assert.equal(indexSql(migrated), indexSql(fresh));
});

test("SQLite: an old database that is also missing a table takes the full path (migration steps, then the whole schema)", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(legacySchema());
  raw.exec("DROP TABLE mcp_exports");
  const { db, execs } = counted(raw);
  await ensureMcpSchema(db, "sqlite");
  assert.deepEqual(execs, [CONNECTION_RESOURCE_DDL, `DROP INDEX IF EXISTS ${ONE_ACTIVE_INDEX}`, "<MCP_SCHEMA>"]);
  assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'mcp_exports'").get());
  assert.match(indexSql(raw), /COALESCE\(resource, ''\)/);
});

// ── Postgres: what is sent ──────────────────────────────────────────────────

const LEGACY_PG_INDEX = "CREATE UNIQUE INDEX mcp_connections_one_active ON public.mcp_connections USING btree (tenant, client_id) WHERE ((status = 'active'::text) AND (kind = 'oauth'::text))";
const CURRENT_PG_INDEX = "CREATE UNIQUE INDEX mcp_connections_one_active ON public.mcp_connections USING btree (tenant, client_id, COALESCE(resource, ''::text)) WHERE ((status = 'active'::text) AND (kind = 'oauth'::text))";

function pgRecorder(state: Record<string, unknown>): { db: Db; seen: string[]; params: unknown[][] } {
  const seen: string[] = [];
  const params: unknown[][] = [];
  const stmt = (sql: string): Stmt => ({
    run: async (...p) => { seen.push(sql); params.push(p); return { changes: 0, lastInsertRowid: 0 }; },
    get: async (...p) => { seen.push(sql); params.push(p); return /to_regclass/.test(sql) ? state : undefined; },
    all: async (...p) => { seen.push(sql); params.push(p); return []; },
  });
  const db: Db = {
    prepare: stmt,
    exec: async (sql) => { seen.push(sql === MCP_SCHEMA ? "<MCP_SCHEMA>" : sql); },
    tx: async (fn) => { seen.push("BEGIN"); const out = await fn(db); seen.push("COMMIT"); return out; },
  };
  return { db, seen, params };
}

/** Every MCP table, and the ones a statement names (a whole word: an index name such as mcp_connections_one_active is not its table). */
const MCP_TABLES = [...MCP_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);
const tablesNamed = (sql: string) => MCP_TABLES.filter((t) => new RegExp(`\\b${t}\\b`).test(sql));

test("Postgres: an old table and index with everything else in place is migrated on mcp_connections alone: one table lock taken first, then column, index drop, index create; never the whole schema", async () => {
  const { db, seen } = pgRecorder({ n: "0", has_table: true, has_column: false, index_def: LEGACY_PG_INDEX });
  await ensureMcpSchema(db, "postgres");
  const at = (p: RegExp | string) => seen.findIndex((s) => (typeof p === "string" ? s === p : p.test(s)));
  const order = [at("BEGIN"), at(/^SET LOCAL lock_timeout/), at(/pg_advisory_xact_lock/), at("LOCK TABLE mcp_connections IN ACCESS EXCLUSIVE MODE"), at(CONNECTION_RESOURCE_DDL), at(`DROP INDEX IF EXISTS ${ONE_ACTIVE_INDEX}`), at(ONE_ACTIVE_INDEX_DDL), at("COMMIT")];
  assert.ok(order.every((i) => i >= 0), seen.join("\n"));
  assert.deepEqual([...order].sort((a, b) => a - b), order, seen.join("\n"));
  assert.ok(!seen.includes("<MCP_SCHEMA>"), "the whole-schema DDL (a lock on every MCP table) is not run");
  // After the advisory lock, the only statements are the catalog re-read (to_regclass/pg_attribute: no table lock)
  // and statements that name no MCP table but mcp_connections (the DROP names only its index, whose table that is).
  const after = seen.slice(at(/pg_advisory_xact_lock/) + 1, at("COMMIT"));
  assert.ok(MCP_TABLES.length > 10 && MCP_TABLES.includes("mcp_codes"));
  for (const s of after) {
    if (/to_regclass/.test(s)) continue;
    assert.ok(tablesNamed(s).every((t) => t === "mcp_connections"), s);
  }
  // The table lock comes before any other statement that locks anything.
  assert.equal(after.filter((s) => !/to_regclass/.test(s))[0], "LOCK TABLE mcp_connections IN ACCESS EXCLUSIVE MODE");
  // What Postgres receives is idempotent, and the index is the one a fresh database gets.
  assert.equal(translateSchema(CONNECTION_RESOURCE_DDL), "ALTER TABLE mcp_connections ADD COLUMN IF NOT EXISTS resource TEXT");
  assert.equal(translateSchema("LOCK TABLE mcp_connections IN ACCESS EXCLUSIVE MODE"), "LOCK TABLE mcp_connections IN ACCESS EXCLUSIVE MODE");
  assert.equal(translateSchema(ONE_ACTIVE_INDEX_DDL), ONE_ACTIVE_INDEX_DDL);
  assert.match(ONE_ACTIVE_INDEX_DDL, /^CREATE UNIQUE INDEX IF NOT EXISTS mcp_connections_one_active\s+ON mcp_connections \(tenant, client_id, COALESCE\(resource, ''\)\) WHERE status = 'active' AND kind = 'oauth'$/);
  assert.ok(MCP_SCHEMA.includes(`${ONE_ACTIVE_INDEX_DDL};`), "a fresh database gets the very same statement");
});

test("Postgres: an old database that is also missing an object takes the full path, unchanged (migration steps, then the schema)", async () => {
  const { db, seen } = pgRecorder({ n: "1", has_table: true, has_column: false, index_def: LEGACY_PG_INDEX });
  await ensureMcpSchema(db, "postgres");
  const at = (p: RegExp | string) => seen.findIndex((s) => (typeof p === "string" ? s === p : p.test(s)));
  const order = [at(/pg_advisory_xact_lock/), at(CONNECTION_RESOURCE_DDL), at(`DROP INDEX IF EXISTS ${ONE_ACTIVE_INDEX}`), at("<MCP_SCHEMA>"), at("COMMIT")];
  assert.ok(order.every((i) => i >= 0), seen.join("\n"));
  assert.deepEqual([...order].sort((a, b) => a - b), order, seen.join("\n"));
  assert.ok(!seen.some((s) => s.startsWith("LOCK TABLE")) && !seen.includes(ONE_ACTIVE_INDEX_DDL));
});

test("Postgres: only the pieces still missing run (column present with the old index: rebuild only; column missing and no index: ALTER only)", async () => {
  const onlyIndex = pgRecorder({ n: "0", has_table: true, has_column: true, index_def: LEGACY_PG_INDEX });
  await ensureMcpSchema(onlyIndex.db, "postgres");
  assert.ok(!onlyIndex.seen.includes(CONNECTION_RESOURCE_DDL));
  assert.ok(onlyIndex.seen.includes(`DROP INDEX IF EXISTS ${ONE_ACTIVE_INDEX}`));
  assert.ok(onlyIndex.seen.includes(ONE_ACTIVE_INDEX_DDL) && !onlyIndex.seen.includes("<MCP_SCHEMA>"));
  assert.ok(onlyIndex.seen.indexOf("LOCK TABLE mcp_connections IN ACCESS EXCLUSIVE MODE") < onlyIndex.seen.indexOf(`DROP INDEX IF EXISTS ${ONE_ACTIVE_INDEX}`), "the table is locked before the DROP locks its index");
  const onlyColumn = pgRecorder({ n: "0", has_table: true, has_column: false, index_def: null });
  await ensureMcpSchema(onlyColumn.db, "postgres");
  assert.ok(onlyColumn.seen.includes(CONNECTION_RESOURCE_DDL));
  assert.ok(!onlyColumn.seen.some((s) => s.startsWith("DROP INDEX")));
  assert.ok(!onlyColumn.seen.includes("<MCP_SCHEMA>"));
  // A fresh database (no table yet): no ALTER, no DROP, just the schema.
  const fresh = pgRecorder({ n: String(MCP_SCHEMA_OBJECTS.length), has_table: false, has_column: false, index_def: null });
  await ensureMcpSchema(fresh.db, "postgres");
  assert.ok(fresh.seen.includes("<MCP_SCHEMA>"));
  assert.ok(!fresh.seen.includes(CONNECTION_RESOURCE_DDL) && !fresh.seen.some((s) => s.startsWith("DROP INDEX")));
});

test("Postgres: once migrated, a boot is one catalog query and nothing else", async () => {
  const { db, seen, params } = pgRecorder({ n: "0", has_table: true, has_column: true, index_def: CURRENT_PG_INDEX });
  await ensureMcpSchema(db, "postgres");
  assert.equal(seen.length, 1, seen.join("\n"));
  // The query translates cleanly: one $n per object name, no stray placeholder, the literals intact.
  const pg = translateQuery(seen[0]!);
  assert.equal((pg.match(/\$\d+/g) ?? []).length, MCP_SCHEMA_OBJECTS.length);
  assert.equal(params[0]!.length, MCP_SCHEMA_OBJECTS.length);
  assert.ok(!pg.includes("?"));
  assert.match(pg, /to_regclass\('mcp_connections'\)/);
  assert.match(pg, /pg_get_indexdef\(to_regclass\('mcp_connections_one_active'\)\)/);
  assert.match(pg, /attname = 'resource' AND NOT attisdropped/);
});
