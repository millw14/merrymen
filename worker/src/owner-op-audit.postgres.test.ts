/**
 * Opt-in real, disposable LOCAL PostgreSQL: owner operations in the production
 * dialect, and the read-only audit through its own shell. Never reads
 * DATABASE_URL.
 *
 * What only Postgres can show: the translated DDL with its CHECKs and its
 * unique identity, to_regclass answering for a table before and after it
 * exists, the mirror's ON CONFLICT (chain_id, user_op_hash) on a real unique
 * index, the server itself holding the audit's connection read-only, the
 * application_name it goes by, grant_json as JSONB read field by field, and
 * every table's row count unchanged by an audit.
 *
 * Each run creates its own database and drops it. Run with
 * MERRYMEN_TEST_PG_URL=postgres://…@127.0.0.1:<port>/<db> and the `pg`
 * driver resolvable (NODE_PATH works: it is loaded with require here).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { translateQuery, translateSchema, wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL, mirrorOwnerOperations } from "./ledger-mirror";
import { knownChainFacts, ownerOperationsPresent } from "./ledger-resume";
import { OWNER_OPERATION_COLUMNS, ownerOperationOf, ownerOperationRow } from "./owner-operations";
import { connectBooking, type PgClient } from "./chain-gap-booking-cli";
import { AUDIT_APPLICATION_NAME, main } from "./owner-op-audit-cli";
import type { RpcCall } from "./chain-capital";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
const loadPg = async () => createRequire(import.meta.url)("pg") as unknown;

type FixtureLog = [string, string[], string, string];
interface Fixture { tx: string; block: string; blockHash: string; timestamp: number; logs: FixtureLog[] }
const FX = JSON.parse(readFileSync(new URL("./testdata/owner-operations-receipts.json", import.meta.url), "utf8")) as Record<string, Fixture>;
const TENANT = "0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5";
const ACCOUNT = "0xa96bf429888e1aab4255762d17d29c53f6a0370d";
const VAULT = "0xc8776faff15212c359b23bae531ff3ac7d760e0f";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const RECOVER = "0x04f8241f6d02241469b9c2bc2d2f8cc4cca719eb5c6d54f3a77077c7e41ab3a7";
const INVALIDATE = "0x496e7211db25d250d9142105ab5024debcf05519c734d83191145af8eac09ffa";
const SESSION = "0x75ab968e2c2dad36467d00f665ab8a2667539517a86d64fdd05d0aadb2c5e905";
const NOW = FX.recoverFunds!.timestamp + 3600;
const fixtures = () => Object.values(FX).filter((f): f is Fixture => typeof f === "object" && f !== null && "tx" in f);
const rpc: RpcCall = async (method, params) => {
  if (method === "eth_chainId") return "0x1237";
  if (method === "eth_blockNumber") return "0x4c4b400";
  if (method === "eth_getTransactionReceipt") {
    const f = fixtures().find((x) => x.tx === params[0]);
    return f ? { status: "0x1", blockNumber: f.block, blockHash: f.blockHash, logs: f.logs.map(([address, topics, data, logIndex]) => ({ address, topics, data, logIndex })) } : null;
  }
  if (method === "eth_getBlockByNumber") {
    const f = fixtures().find((x) => BigInt(x.block) === BigInt(String(params[0])));
    return f ? { number: f.block, hash: f.blockHash, timestamp: `0x${f.timestamp.toString(16)}` } : null;
  }
  throw new Error(method);
};

test("Postgres: owner_operations' DDL, its identity, the mirror and admission's read — and the audit, read only, through its shell", { skip: !url, timeout: 60_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "only a disposable LOCAL PostgreSQL is allowed");
  const pg = (await loadPg()) as { Client: new (c: { connectionString: string }) => PgClient & { connect(): Promise<void> } };
  const name = `mm_ownerops_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: target.toString() }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const scoped = new URL(target); scoped.pathname = `/${name}`;
  const clients: PgClient[] = [];
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mm-ownerops-pg-")));
  t.after(async () => {
    await Promise.allSettled(clients.map((c) => c.end()));
    try { await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await admin.end(); rmSync(tmp, { recursive: true, force: true }); }
  });
  const setup = new pg.Client({ connectionString: scoped.toString() }); await setup.connect(); clients.push(setup);
  const db: Db = {
    prepare(sql) { return {
      async run(...a) { const r = await setup.query(translateQuery(sql), a); return { changes: r.rowCount ?? 0, lastInsertRowid: 0 }; },
      async get(...a) { return (await setup.query(translateQuery(sql), a)).rows[0]; },
      async all(...a) { return (await setup.query(translateQuery(sql), a)).rows; },
    }; },
    async exec(sql) { await setup.query(translateSchema(sql)); },
    async tx(fn) {
      await setup.query("BEGIN");
      try { const out = await fn(db); await setup.query("COMMIT"); return out; } catch (e) { await setup.query("ROLLBACK"); throw e; }
    },
  };

  // to_regclass answers for an absent table, and nothing aborts.
  assert.equal(await ownerOperationsPresent(db), false);
  assert.equal((await knownChainFacts({ ...db, prepare: (sql) => (/FROM (trades|flows)\b/.test(sql) ? { run: async () => ({ changes: 0, lastInsertRowid: 0 }), get: async () => undefined, all: async () => [] } : db.prepare(sql)) },
    ACCOUNT, { tenant: TENANT, chainId: 4663 })).ownerRecords.size, 0);
  await applyLedgerSchema(db); await db.exec(MIRROR_STATE_DDL);
  assert.equal(await ownerOperationsPresent(db), true);
  // Applied twice, as every deploy does: idempotent.
  await applyLedgerSchema(db);

  // THE CHECKS AND THE IDENTITY, held by the server.
  const cols = OWNER_OPERATION_COLUMNS;
  const insert = (row: object) => setup.query(`INSERT INTO owner_operations (tenant, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`,
    [TENANT, ...cols.map((c) => (row as Record<string, unknown>)[c] ?? null)]);
  const recover = ownerOperationRow(ownerOperationOf({ receiptLogs: FX.recoverFunds!.logs.map(([address, topics, data, logIndex]) => ({ address, topics, data, logIndex })),
    userOpHash: RECOVER, txHash: FX.recoverFunds!.tx, account: ACCOUNT, custody: [VAULT], usdg: USDG, chainId: 4663 })!,
  { agentId: ACCOUNT, chainId: 4663, blockNumber: BigInt(FX.recoverFunds!.block), blockTime: FX.recoverFunds!.timestamp, recordedEpoch: 1 });
  await assert.rejects(insert({ ...recover, validator: "permission" }), /check constraint/i);
  await assert.rejects(insert({ ...recover, disposition: "acknowledged" }), /check constraint/i, "an acknowledged row carrying a review reason");
  await insert(recover);
  await assert.rejects(insert(recover), /duplicate key/, "one record per (chain, operation)");

  // THE MIRROR'S INSERT, on the real unique index: a child re-recording the same operation adds nothing.
  const childRaw = new DatabaseSync(":memory:");
  t.after(() => childRaw.close());
  await applyLedgerSchema(wrapSqlite(childRaw));
  const invalidate = ownerOperationRow(ownerOperationOf({ receiptLogs: FX.invalidateNonce!.logs.map(([address, topics, data, logIndex]) => ({ address, topics, data, logIndex })),
    userOpHash: INVALIDATE, txHash: FX.invalidateNonce!.tx, account: ACCOUNT, custody: [VAULT], usdg: USDG, chainId: 4663 })!,
  { agentId: ACCOUNT, chainId: 4663, blockNumber: BigInt(FX.invalidateNonce!.block), blockTime: FX.invalidateNonce!.timestamp, recordedEpoch: 1 });
  for (const [row, at] of [[recover, 5000], [invalidate, 5001]] as const) {
    childRaw.prepare(`INSERT INTO owner_operations (${cols.join(", ")}, created_at) VALUES (${cols.map(() => "?").join(", ")}, ?)`).run(...cols.map((c) => row[c]), at);
  }
  const copied = await mirrorOwnerOperations({ tenant: TENANT, child: wrapSqlite(childRaw), shared: db, batch: 500, nowSec: 6000, account: ACCOUNT });
  assert.deepEqual(copied.copied, { owner_operations: 1, owner_operations_already_mirrored: 1 });
  assert.equal(Number((await setup.query("SELECT COUNT(*) AS n FROM owner_operations")).rows[0]!.n), 2);
  assert.deepEqual((await setup.query("SELECT tenant FROM owner_operations WHERE user_op_hash = $1", [INVALIDATE])).rows.map((r) => r.tenant), [TENANT]);

  // ADMISSION'S READ: only the acknowledged root record of this tenant, account and chain.
  const k = await knownChainFacts(db, ACCOUNT, { tenant: TENANT, chainId: 4663 });
  assert.deepEqual([...k.ownerRecords], [[INVALIDATE, FX.invalidateNonce!.tx]]);

  // THE AUDIT, through its shell, against this Postgres: grants as the grant store keeps them, and what the old reconciler wrote.
  await setup.query(`CREATE TABLE grants (tenant TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, grant_json JSONB NOT NULL, sealed_session_key TEXT, updated_at BIGINT NOT NULL)`);
  await setup.query("INSERT INTO grants VALUES ($1, 4663, $2, 'SEALED-NEVER-READ', 1)", [TENANT,
    JSON.stringify({ smartAccount: ACCOUNT, owner: TENANT, chainId: 4663, grantFeatures: ["tradeable-v2", "pons-class"], ponsClassVaultAddress: VAULT, serialized: "never-read" })]);
  await setup.query(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES ($1, $2, $3, 4663, '{}', 1, 9999999999, 'armed', 1, 349, 'idle')`, [ACCOUNT, TENANT, `0x${"01".repeat(20)}`]);
  for (const [hash, f, amount] of [[INVALIDATE, FX.invalidateNonce!, 0], [RECOVER, FX.recoverFunds!, 348.368488]] as const) {
    await setup.query(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, basis_source, created_at, epoch)
      VALUES ($1, 'swap', $1, $2, $3, $4, 'landed', 'receipt', $5, 1)`, [ACCOUNT, amount, hash, f.tx, f.timestamp + 60]);
  }
  await setup.query(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, decision_id, fill_side, created_at, epoch)
    VALUES ($1, 'swap', $2, 5.370997, $3, $4, 'landed', 'd-1', 'sell', $5, 1)`, [ACCOUNT, `0x${"d4".repeat(20)}`, SESSION, FX.sessionEnable!.tx, FX.sessionEnable!.timestamp]);
  // Numbers, however the driver hands BIGINT back (connectBooking sets the parser for the whole driver).
  const counts = async () => Object.fromEntries(Object.entries((await setup.query(`SELECT (SELECT COUNT(*) FROM trades) AS trades, (SELECT COUNT(*) FROM flows) AS flows,
      (SELECT COUNT(*) FROM owner_operations) AS owner, (SELECT COUNT(*) FROM grants) AS grants, (SELECT COUNT(*) FROM agents) AS agents`)).rows[0]!).map(([k, v]) => [k, Number(v)]));
  const before = await counts();

  // THE SERVER HOLDS THE AUDIT'S CONNECTION READ ONLY, under its own name.
  const names: string[] = [];
  const connect = async (u: string) => {
    const c = await connectBooking(u, true, loadPg, AUDIT_APPLICATION_NAME); clients.push(c);
    names.push(String((await c.query("SELECT current_setting('application_name') AS a")).rows[0]!.a));
    await assert.rejects(c.query("INSERT INTO events (agent_id, message) VALUES ('x', 'y')"), /read-only transaction/);
    return c;
  };
  const printed: string[] = [];
  const output = path.join(tmp, "audit.json");
  const code = await main(["--output", output], { DATABASE_URL: scoped.toString() }, { connect, rpc, nowMs: () => NOW * 1000, out: (l) => printed.push(l), source: { test: "pg" },
    sleep: async () => {} });
  assert.equal(code, 2, printed.join("\n"));
  assert.deepEqual(names, ["merrymen-owner-op-audit-readonly"]);
  const report = JSON.parse(readFileSync(output, "utf8")) as { rootRows: Array<{ userOpHash: string; counted: { ownerRecord: string | null; budgetSeedTrailingDay: boolean } }>;
    totals: { byValidator: Record<string, number>; capitalLegsWithoutFlow: { out: { count: number; amountRaw: string } } } };
  assert.deepEqual(report.rootRows.map((r) => r.userOpHash).sort(), [INVALIDATE, RECOVER].sort());
  assert.equal(report.totals.byValidator.permission, 1);
  assert.equal(report.rootRows.find((r) => r.userOpHash === RECOVER)!.counted.ownerRecord, "review");
  assert.equal(report.rootRows.find((r) => r.userOpHash === RECOVER)!.counted.budgetSeedTrailingDay, true);
  assert.deepEqual(report.totals.capitalLegsWithoutFlow.out, { count: 1, amountRaw: "348368488" });
  assert.deepEqual(await counts(), before, "the audit changed nothing");
  const said = `${printed.join("\n")}\n${readFileSync(output, "utf8")}`;
  assert.ok(!said.includes(scoped.toString()) && !said.includes(name), "neither the database URL nor its name is printed or saved");
  assert.ok(!said.includes("SEALED-NEVER-READ"));
});
