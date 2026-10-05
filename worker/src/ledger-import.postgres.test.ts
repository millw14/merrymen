/** Opt-in real, disposable LOCAL PostgreSQL transactions. Never reads DATABASE_URL. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite, translateQuery, translateSchema, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";
import { PgGrantStore } from "./grant-store";
import { leaseKey, type TenantLease } from "./tenant-lease";
import {
  captureLedgerImport, stageLedgerImport, restoreLedgerImport, verifyLedgerImport, verifyRestoredLedgerImport,
  registerLedgerSource, LEDGER_IMPORT_PENDING_FILE, type LedgerImportVolume,
} from "./ledger-import";

interface Client {
  connect(): Promise<void>; end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  on(event: "error" | "end", fn: () => void): void;
}
const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
const pg = url ? createRequire(import.meta.url)("pg") as {
  Client: new (config: { connectionString: string }) => Client;
  types: { setTypeParser(id: number, fn: (s: string) => unknown): void };
} : null;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const dek = Buffer.alloc(32, 74), key = `0x${"35".repeat(32)}` as `0x${string}`;

test("Postgres: original source import, actual grant deletion locks and durable generation receipts", { skip: !url, timeout: 40_000 }, async t => {
  const target = new URL(url!); assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "only a disposable LOCAL PostgreSQL is allowed");
  pg!.types.setTypeParser(20, Number);
  const schema = `mm_ledger_import_${randomBytes(8).toString("hex")}`;
  const admin = new pg!.Client({ connectionString: target.toString() }); await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(target); scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=8000`);
  const clients: Client[] = [], raws: DatabaseSync[] = [], tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mm-ledger-pg-")));
  const savedDek = process.env.MERRYMEN_STORE_DEK; process.env.MERRYMEN_STORE_DEK = dek.toString("base64");
  const connect = async () => { const c = new pg!.Client({ connectionString: scoped.toString() }); await c.connect(); clients.push(c); return c; };
  const main = await connect();
  const wrap = (client: Client, scopedTransaction = false): Db => ({
    prepare(sql) { return {
      async run(...args) { const r = await client.query(translateQuery(sql), args.map(a => typeof a === "bigint" ? String(a) : a)); return { changes: r.rowCount ?? 0, lastInsertRowid: 0 }; },
      async get(...args) { return (await client.query(translateQuery(sql), args)).rows[0]; },
      async all(...args) { return (await client.query(translateQuery(sql), args)).rows; },
    }; },
    async exec(sql) { await client.query(translateSchema(sql)); },
    async tx(fn) {
      if (scopedTransaction) throw new Error("nested transaction");
      const c = await connect(); await c.query("BEGIN");
      try { const result = await fn(wrap(c, true)); await c.query("COMMIT"); return result; }
      catch (e) { await c.query("ROLLBACK"); throw e; }
    },
  });
  const shared = wrap(main); await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL);
  const grants = new PgGrantStore(scoped.toString(), async () => connect());
  t.after(async () => {
    for (const raw of raws) raw.close();
    await Promise.allSettled(clients.map(c => c.end()));
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); rmSync(tmp, { recursive: true, force: true }); }
    if (savedDek === undefined) delete process.env.MERRYMEN_STORE_DEK; else process.env.MERRYMEN_STORE_DEK = savedDek;
  });
  let number = 0;
  async function fixture(empty = false) {
    const id = ++number, tenant = address(0xabc00 + id), account = address(0xdef00 + id), owner = address(0xfed00 + id);
    const homeBase = path.join(tmp, String(id)), original = path.join(homeBase, "original"), mountPath = path.join(homeBase, "volume"), homeRoot = path.join(mountPath, "fleet");
    mkdirSync(original, { recursive: true }); mkdirSync(homeRoot, { recursive: true });
    const raw = new DatabaseSync(path.join(original, "merrymen.db")); raws.push(raw); const local = wrapSqlite(raw); await applyLedgerSchema(local);
    await grants.put(tenant, { smartAccount: account, owner, chainId: 4663, sessionKeyAddress: privateKeyToAccount(key).address, serialized: Buffer.from(JSON.stringify({ privateKey: key })).toString("base64"), demoSessionPrivateKey: key,
      grantedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 86400, caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 1 }, grantFeatures: ["tradeable-v2"], grantTokens: [] } as unknown as StoredGrant);
    if (!empty) {
      raw.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,mode,hwm_usdg) VALUES(?,?,?,4663,'{}',1,9999999999,'live',100)").run(account, owner, privateKeyToAccount(key).address);
      raw.prepare("INSERT INTO events(id,agent_id,message,created_at) VALUES(40,?,'original evidence',1040)").run(account);
      raw.prepare("INSERT INTO trades(id,agent_id,kind,target,amount_usdg,status,created_at,budget_settled_at,user_op_nonce) VALUES(37,?,'swap','fixture',5,'landed',1037,1040,?)").run(account, (2n ** 256n - 1n).toString());
      raw.prepare("INSERT INTO positions(agent_id,symbol,token,raw_balance,ui_multiplier,price_usd,value_usdg) VALUES(?,'COIN',?,'10','1',1,10)").run(account, address(9));
      raw.prepare("INSERT INTO cost_basis(agent_id,mode,symbol,qty_raw,cost_usdg) VALUES(?,'live','COIN','10','20')").run(account);
    }
    const report = await mirrorTenant({ tenant, child: local, shared }); assert.equal(report.failed, undefined);
    const lock = await connect(); await lock.query("SELECT pg_advisory_lock($1::bigint)", [leaseKey(tenant).toString()]);
    let healthy = true; lock.on("error", () => { healthy = false; }); lock.on("end", () => { healthy = false; });
    const lease: TenantLease = { tenant, backend: "postgres", healthy: () => healthy, async release() { healthy = false; await lock.query("SELECT pg_advisory_unlock($1::bigint)", [leaseKey(tenant).toString()]); } };
    const st = lstatSync(mountPath, { bigint: true }), volume: LedgerImportVolume = { id: `vol_pg_fixture_${id}`, mountPath, homeRoot, device: String(st.dev), inode: String(st.ino) };
    const home = path.join(homeRoot, "children", tenant), options = { tenant, smartAccount: account, chainId: 4663, home, volume, shared, dek, lease };
    const artifact = empty ? null : await captureLedgerImport({ ...options, home: original, source: { deploymentId: "quiescent-source", gitCommit: "a".repeat(40), orchestratorPid: 999, orchestratorStart: "source-start", quiescent: true, singleReplicaConfirmed: true }, assertSource() {} });
    if (artifact) await stageLedgerImport({ artifact, targetVolumeId: volume.id, shared, dek, lease, assertSource() {} });
    return { ...options, options, artifact, original, raw };
  }
  await t.test("row-locked available -> consumed roundtrip proves current xmin, exact book, ciphertext erase and actual mirror continuation", async () => {
    const f = await fixture(), artifact = f.artifact!;
    const verified = await verifyLedgerImport({ artifact, home: f.original, shared, dek, lease: f.lease, assertSource() {} });
    assert.equal(await restoreLedgerImport(f.options), "restored");
    assert.deepEqual(await verifyRestoredLedgerImport({ ...f.options, artifact, assertSource() {} }), verified);
    const raw = new DatabaseSync(path.join(f.home, "merrymen.db")); raws.push(raw);
    const report = await mirrorTenant({ tenant: f.tenant, child: wrapSqlite(raw), shared }); assert.equal(report.restarted, undefined); assert.equal(report.failed, undefined);
    const row = await shared.prepare("SELECT state,sealed,source_inode FROM tenant_ledger_import WHERE tenant=?").get(f.tenant) as Record<string, unknown>;
    assert.equal(row.state, "consumed"); assert.equal(row.sealed, null); assert.equal(row.source_inode, String(lstatSync(path.join(f.home, "merrymen.db"), { bigint: true }).ino));
  });
  await t.test("real grant DELETE waits for import grant-first lock, then invalidates both consumed payload and generation atomically", async () => {
    const f = await fixture(); let entered!: () => void, unblock!: () => void; let first = true;
    const reached = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { unblock = r; });
    const delayed = (db: Db): Db => ({ exec: sql => db.exec(sql), tx: fn => db.tx(tx => fn(delayed(tx))), prepare(sql) { const stmt = db.prepare(sql); return { ...stmt, async get(...args) { const row = await stmt.get(...args); if (first && sql.includes("FROM grants")) { first = false; entered(); await gate; } return row; } }; } });
    const imported = restoreLedgerImport({ ...f.options, shared: delayed(shared) }).then(result => ({ result }), error => ({ error })); await reached;
    let removed = false; const deletion = grants.remove(f.tenant).then(() => { removed = true; });
    // Make a real second transaction observe that the grant still exists while deletion is blocked.
    assert.equal((await main.query("SELECT tenant FROM grants WHERE tenant=$1", [f.tenant])).rows.length, 1); assert.equal(removed, false);
    unblock(); const outcome = await imported; await deletion;
    // Deletion may acquire its lock between the consume COMMIT and the import's
    // final pending-marker cleanup. Lost authority must then refuse completion.
    if ("result" in outcome) assert.equal(outcome.result, "restored");
    else assert.match(String(outcome.error), /Original ledger import refused/);
    assert.equal((await main.query("SELECT tenant FROM grants WHERE tenant=$1", [f.tenant])).rows.length, 0);
    const row = (await main.query("SELECT state,sealed FROM tenant_ledger_import WHERE tenant=$1", [f.tenant])).rows[0]!; assert.equal(row.state, "deleted"); assert.equal(row.sealed, null);
    assert.equal((await main.query("SELECT state FROM tenant_ledger_import_generations WHERE generation=$1", [f.artifact!.generation])).rows[0]!.state, "deleted");
    assert.ok(existsSync(path.join(f.home, "merrymen.db")), "explicit removal retains original accounting evidence");
    assert.equal(existsSync(path.join(f.home, LEDGER_IMPORT_PENDING_FILE)), "error" in outcome);
    await assert.rejects(restoreLedgerImport(f.options), /Original ledger import refused/);
  });
  await t.test("new zero-cursor original receives consumed receipt and a missing book is never recreated", async () => {
    const f = await fixture(true); await registerLedgerSource(f.options); assert.equal(await restoreLedgerImport(f.options), "present");
    rmSync(path.join(f.home, "merrymen.db")); await assert.rejects(restoreLedgerImport(f.options)); await assert.rejects(registerLedgerSource(f.options));
  });
});
