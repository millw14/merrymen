/** Opt-in loopback-only real Pg preseed gate. Never reads DATABASE_URL. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { translateQuery, translateSchema, type Db } from "./db";
import { captureFleetMemory, seedMemoryBackup, verifyMemoryBackup, type MemorySource } from "./memory-safeguard";

const url = process.env.MERRYMEN_TEST_PG_URL;
interface Client {
  connect(): Promise<void>; end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
const pg = url ? createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => Client } : null;
const TENANT = `0x${"ab".repeat(20)}`, ACCOUNT = `0x${"bc".repeat(20)}`, DEK = Buffer.alloc(32, 77);
const source: MemorySource = { deploymentId: "local-test", gitCommit: "c".repeat(40), orchestratorPid: 71,
  orchestratorStart: "987", quiescent: true, singleReplicaConfirmed: true };
function dbFor(client: Client): Db {
  const db: Db = {
    prepare: sql => {
      const q = (params: unknown[]) => client.query(translateQuery(sql), params);
      return { get: async (...params) => (await q(params)).rows[0], all: async (...params) => (await q(params)).rows,
        run: async (...params) => ({ changes: (await q(params)).rowCount ?? 0, lastInsertRowid: 0 }) };
    },
    exec: async sql => { await client.query(translateSchema(sql)); },
    tx: async fn => { await client.query("BEGIN"); try { const value = await fn(db); await client.query("COMMIT"); return value; }
      catch (e) { await client.query("ROLLBACK"); throw e; } },
  };
  return db;
}

test("Postgres preseed: exact ciphertext, idempotence, real xmin incarnation and deletion row-lock race", { skip: !url, timeout: 20_000 }, async t => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "disposable local Postgres only");
  const schema = `mm_memory_${randomBytes(8).toString("hex")}`;
  const one = new pg!.Client({ connectionString: url! }), two = new pg!.Client({ connectionString: url! });
  await one.connect(); await two.connect();
  await one.query(`CREATE SCHEMA ${schema}`);
  await one.query(`SET search_path TO ${schema}`); await two.query(`SET search_path TO ${schema}`);
  await one.query("SET statement_timeout TO 5000"); await two.query("SET statement_timeout TO 5000");
  const root = mkdtempSync(path.join(os.tmpdir(), "mm-memory-pg-test-")), childrenDir = path.join(root, "children");
  mkdirSync(path.join(childrenDir, TENANT, "soul"), { recursive: true });
  writeFileSync(path.join(childrenDir, TENANT, "soul", "OWNER.md"), "known local fixture memory");
  const shared = dbFor(one), opts = { childrenDir, shared, dek: DEK, source, assertSource: () => {} };
  t.after(async () => {
    try { await one.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await Promise.allSettled([one.end(), two.end()]); rmSync(root, { recursive: true, force: true }); }
  });
  await one.query("CREATE TABLE grants(tenant TEXT PRIMARY KEY, grant_json JSONB, updated_at BIGINT)");
  await one.query("CREATE TABLE tenant_tg_groups(tenant TEXT PRIMARY KEY, sealed TEXT, bytes BIGINT, updated_at_ms BIGINT)");
  const insert = () => one.query("INSERT INTO grants VALUES($1, $2::jsonb, 1)", [TENANT, JSON.stringify({ smartAccount: ACCOUNT })]);
  await insert();
  const first = await captureFleetMemory(opts);
  await verifyMemoryBackup(first, DEK);
  assert.deepEqual(await seedMemoryBackup({ ...opts, backup: first }), { inserted: 1, alreadySeeded: 0 });
  assert.deepEqual(await seedMemoryBackup({ ...opts, backup: first }), { inserted: 0, alreadySeeded: 1 });
  assert.equal((await one.query("SELECT sealed FROM tenant_personal_memory WHERE tenant=$1", [TENANT])).rows[0]!.sealed, first.entries[0]!.personal!.sealed);
  await one.query("DELETE FROM grants WHERE tenant=$1", [TENANT]); await insert();
  const changed = await captureFleetMemory(opts);
  assert.equal(changed.entries[0]!.updatedAt, first.entries[0]!.updatedAt);
  assert.notEqual(changed.entries[0]!.rowVersion, first.entries[0]!.rowVersion);
  await assert.rejects(seedMemoryBackup({ ...opts, backup: first }), /refused/, "same-second delete/regrant cannot resurrect old memory");
  await assert.rejects(seedMemoryBackup({ ...opts, backup: changed }), /refused/, "different existing ciphertext is never overwritten");
  await one.query("DELETE FROM tenant_personal_memory");
  // Pause once seed has the grant's FOR SHARE lock, then issue deletion on
  // another actual Pg session. It must wait until the safe seed transaction ends.
  let blockedDelete: Promise<unknown> | undefined, observedBlocked = false;
  const guarded: Db = { ...shared, tx: fn => shared.tx(tx => fn({ ...tx, prepare: sql => {
    const statement = tx.prepare(sql);
    if (!sql.endsWith("FOR SHARE")) return statement;
    return { ...statement, get: async (...params) => {
      const row = await statement.get(...params);
      let finished = false;
      blockedDelete = two.query("DELETE FROM grants WHERE tenant=$1", [TENANT]).then(r => { finished = true; return r; });
      await new Promise(resolve => setTimeout(resolve, 50)); observedBlocked = !finished;
      return row;
    } };
  } })) };
  const latest = await captureFleetMemory(opts);
  assert.deepEqual(await seedMemoryBackup({ ...opts, shared: guarded, backup: latest }), { inserted: 1, alreadySeeded: 0 });
  assert.ok(observedBlocked, "grant deletion was serialized behind seed row lock");
  await blockedDelete;
  assert.equal((await one.query("SELECT count(*) AS n FROM grants")).rows[0]!.n, "0");
});
