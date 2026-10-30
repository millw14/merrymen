/** Opt-in disposable LOCAL PostgreSQL; never connects to the ambient DATABASE_URL. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { translateQuery, translateSchema, wrapSqlite, type Db } from "./db";
import { attestTradedReceipt } from "./receipt-attestation-traded";
import { assertNoPendingReceiptAttestation, readReceiptAttestation } from "./receipt-attestation-state";
import { BLOCK, LOCAL_FLOW, SHARED_FLOW, TEST_ACCOUNT, TEST_TENANT, TOP_UP, TX, tradedFixture } from "./receipt-attestation-traded-fixture";
import { acquireTenantLease, PgTenantLeaseManager } from "./tenant-lease";
import { journalHash } from "./store";
import { registerLedgerSource, restoreLedgerImport } from "./ledger-import";

interface Client {
  connect(): Promise<void>; end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  on(event: "error" | "end", listener: () => void): void;
}
const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
const pg = url ? createRequire(import.meta.url)("pg") as {
  Client: new (options: { connectionString: string }) => Client;
  types: { setTypeParser(id: number, parse: (value: string) => unknown): void };
} : null;
const OTHER = `0x${"9f".repeat(20)}`;

test("Postgres: one inferred deposit of a traded book, durable interruptions and actual tenant authority", { skip: !url, timeout: 120_000 }, async t => {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only disposable LOCAL PostgreSQL is allowed");
  pg!.types.setTypeParser(20, Number);
  const savedUrl = process.env.DATABASE_URL, savedHolds = process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
  const admin = new pg!.Client({ connectionString: target.toString() }); await admin.connect();
  t.after(async () => {
    await admin.end();
    if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
    if (savedHolds === undefined) delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS; else process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = savedHolds;
  });
  async function fixture() {
    const schema = `mm_traded_${randomBytes(8).toString("hex")}`, application = `${schema}_lease`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(target);
    scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=1000`);
    const clients = new Set<Client>();
    const freshClient = () => { const client = new pg!.Client({ connectionString: scoped.toString() }); clients.add(client); return client; };
    const connect = async () => { const client = freshClient(); await client.connect(); return client; };
    const wrap = (client: Client, transaction = false): Db => ({
      prepare(sql) { return {
        async get(...params) { return (await client.query(translateQuery(sql), params)).rows[0]; },
        async all(...params) { return (await client.query(translateQuery(sql), params)).rows; },
        async run(...params) { const result = await client.query(translateQuery(sql), params); return { changes: result.rowCount ?? 0, lastInsertRowid: 0 }; },
      }; },
      async exec(sql) { await client.query(translateSchema(sql)); },
      async tx(fn) {
        assert.equal(transaction, false, "no nested transaction");
        const connection = await connect(); await connection.query("BEGIN");
        try { const result = await fn(wrap(connection, true)); await connection.query("COMMIT"); return result; }
        catch (error) { await connection.query("ROLLBACK"); throw error; }
        finally { await connection.end(); clients.delete(connection); }
      },
    });
    const main = await connect(), shared = wrap(main);
    await shared.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY, grant_json JSONB NOT NULL, updated_at BIGINT NOT NULL, row_version BIGINT NOT NULL)");
    const leaseUrl = new URL(scoped); leaseUrl.searchParams.set("application_name", application);
    process.env.DATABASE_URL = leaseUrl.toString();
    process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = TEST_TENANT;
    const lease = await acquireTenantLease(TEST_TENANT);
    assert.ok(lease); assert.equal(lease.backend, "postgres"); assert.equal(lease.healthy(), true);
    const f = await tradedFixture(shared, lease);
    const competitor = new PgTenantLeaseManager(async () => freshClient());
    // Another tenant's book in the same shared tables, with an inferred row of the same amount.
    await shared.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,mode,hwm_usdg) VALUES(?,?,?,4663,'{}',1,9999999999,'live',77)").run(OTHER, OTHER, OTHER);
    await shared.prepare("INSERT INTO flows(agent_id,direction,amount_usdg,source,epoch) VALUES(?,'in',?,'inferred',1)").run(OTHER, TOP_UP);
    await shared.prepare("INSERT INTO trades(agent_id,kind,target,amount_usdg,tx_hash,status) VALUES(?,'swap','pool',2.5,?,'landed')").run(OTHER, TX.trade);
    return { ...f, connect, wrap, main, competitor, lease, application,
      async close() {
        await lease.release();
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()", [application]);
        await Promise.allSettled([...clients].map(client => client.end()));
        f.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      },
    };
  }
  type F = Awaited<ReturnType<typeof fixture>>;
  const flow = async (db: Db, id: number) => ({ ...await db.prepare("SELECT * FROM flows WHERE id=?").get(id) as Record<string, unknown> });
  const other = async (db: Db) => ({ agent: await db.prepare("SELECT * FROM agents WHERE smart_account=?").get(OTHER), flows: await db.prepare("SELECT * FROM flows WHERE agent_id=?").all(OTHER),
    trades: await db.prepare("SELECT * FROM trades WHERE agent_id=?").all(OTHER) });
  const books = async (f: F, db: Db) => ({
    agents: await db.prepare("SELECT * FROM agents ORDER BY smart_account").all(), localAgents: await f.local.prepare("SELECT * FROM agents").all(),
    trades: await db.prepare("SELECT * FROM trades ORDER BY id").all(), equity: await db.prepare("SELECT * FROM equity ORDER BY id").all(),
    fees: await db.prepare("SELECT * FROM fee_accruals ORDER BY id").all(), marks: await db.prepare("SELECT * FROM mirror_state ORDER BY table_name").all(),
    source: await db.prepare("SELECT * FROM tenant_ledger_import").all(), grants: await db.prepare("SELECT * FROM grants").all(),
    otherFlows: await db.prepare("SELECT * FROM flows WHERE id<>? ORDER BY id").all(SHARED_FLOW), other: await other(db) });

  for (const boundary of ["audit", "marker", "local", "shared", "cleared"] as const) await t.test(`crash after ${boundary}: fresh connections resume once, changing provenance only`, async () => {
    const f = await fixture();
    try {
      assert.equal(await f.competitor.acquire(TEST_TENANT), null, "another supervisor cannot hold the same tenant");
      const original = await books(f, f.shared), journal = await f.local.prepare("SELECT * FROM journal ORDER BY seq").all() as Record<string, unknown>[];
      const flows = { local: await flow(f.local, LOCAL_FLOW), shared: await flow(f.shared, SHARED_FLOW) };
      const before = readFileSync(f.file), preview = await attestTradedReceipt(f.options);
      assert.equal(preview.state, "preview"); assert.deepEqual(readFileSync(f.file), before);
      assert.equal(await readReceiptAttestation(f.shared, TEST_TENANT), undefined, "preview did not create an audit");
      await assert.rejects(attestTradedReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
        checkpoint(at) { if (at === boundary) throw new Error("injected crash"); } }), /injected crash/);
      const fresh = f.wrap(await f.connect()), reopened = new DatabaseSync(f.file, { readOnly: true });
      try {
        assert.equal((await flow(wrapSqlite(reopened), LOCAL_FLOW)).source, ["local", "shared", "cleared"].includes(boundary) ? "chain-log" : "inferred");
        assert.equal((await flow(fresh, SHARED_FLOW)).source, ["shared", "cleared"].includes(boundary) ? "chain-log" : "inferred");
        assert.equal((await readReceiptAttestation(fresh, TEST_TENANT))!.state, ["shared", "cleared"].includes(boundary) ? "applied" : "pending");
        if (["audit", "marker", "local"].includes(boundary)) await assert.rejects(assertNoPendingReceiptAttestation(fresh, TEST_TENANT), /unfinished/);
      } finally { reopened.close(); }
      const permanentPlan = (await readReceiptAttestation(fresh, TEST_TENANT))!.plan_json;
      const options = { ...f.options, shared: fresh, mode: "commit" as const, approvedDigest: preview.approvalDigest };
      assert.equal((await attestTradedReceipt(options)).state, "applied");
      assert.equal((await attestTradedReceipt(options)).state, "applied", "exact replay is idempotent");
      for (const [db, id, row] of [[f.local, LOCAL_FLOW, flows.local], [fresh, SHARED_FLOW, flows.shared]] as const) {
        assert.deepEqual(await flow(db, id), { ...row, source: "chain-log", tx_hash: TX.deposit, block_number: BLOCK.deposit, log_index: 2, chain_id: 4663 });
      }
      assert.deepEqual(await books(f, fresh), original, "no money, peak, cursor, grant, source or other tenant changed");
      assert.equal((await readReceiptAttestation(fresh, TEST_TENANT))!.plan_json, permanentPlan, "retries retain the original approval and evidence");
      const now = await f.local.prepare("SELECT * FROM journal ORDER BY seq").all() as Record<string, unknown>[];
      assert.deepEqual(now.slice(0, -1), journal); assert.equal(now.length, journal.length + 1);
      assert.equal(now.at(-1)!.prev_hash, journal.at(-1)!.hash);
      assert.equal(now.at(-1)!.hash, journalHash(String(journal.at(-1)!.hash), String(now.at(-1)!.payload_json)));
      assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), false);
    } finally { await f.close(); }
  });

  await t.test("real shared transaction failure preserves the pending audit and the original amendment for retry", async () => {
    const f = await fixture();
    try {
      const preview = await attestTradedReceipt(f.options);
      await f.main.query("CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected shared rollback'; END $$");
      await f.main.query("CREATE TRIGGER reject_receipt BEFORE UPDATE ON flows FOR EACH ROW EXECUTE FUNCTION reject_receipt()");
      const options = { ...f.options, mode: "commit" as const, approvedDigest: preview.approvalDigest };
      await assert.rejects(attestTradedReceipt(options), /injected shared rollback/);
      assert.equal((await flow(f.local, LOCAL_FLOW)).source, "chain-log"); assert.equal((await flow(f.shared, SHARED_FLOW)).source, "inferred");
      assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "pending");
      assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), true);
      await f.main.query("DROP TRIGGER reject_receipt ON flows");
      assert.equal((await attestTradedReceipt(options)).state, "applied");
    } finally { await f.close(); }
  });

  await t.test("a durable pending audit blocks source replacement even before a marker exists", async () => {
    const f = await fixture();
    try {
      const preview = await attestTradedReceipt(f.options);
      await assert.rejects(attestTradedReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
        checkpoint(at) { if (at === "audit") throw new Error("interrupted before marker"); } }), /interrupted/);
      assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), false);
      const preserved = `${f.file}.preserved`, before = readFileSync(f.file);
      renameSync(f.file, preserved);
      try {
        const restore = { tenant: TEST_TENANT, smartAccount: TEST_ACCOUNT.toLowerCase(), chainId: 4663, home: f.options.home,
          volume: f.options.volume, shared: f.shared, lease: f.lease, dek: Buffer.alloc(32, 8) };
        await assert.rejects(restoreLedgerImport(restore), /attestation is unfinished/);
        await assert.rejects(registerLedgerSource(restore), /attestation is unfinished/);
        assert.equal(existsSync(f.file), false, "neither source gate creates a replacement ledger");
        assert.deepEqual(readFileSync(preserved), before);
      } finally { renameSync(preserved, f.file); }
    } finally { await f.close(); }
  });

  await t.test("a terminated advisory lease refuses mutation; a new owner resumes the pending audit", async () => {
    const f = await fixture();
    try {
      const preview = await attestTradedReceipt(f.options);
      await assert.rejects(attestTradedReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
        async checkpoint(at) {
          if (at !== "audit") return;
          await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1", [f.application]);
          for (let tries = 0; f.lease.healthy() && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
          assert.equal(f.lease.healthy(), false);
        } }), /lease/);
      assert.equal((await flow(f.local, LOCAL_FLOW)).source, "inferred");
      await assert.rejects(assertNoPendingReceiptAttestation(f.shared, TEST_TENANT), /unfinished/);
      const replacement = await f.competitor.acquire(TEST_TENANT); assert.ok(replacement);
      try { assert.equal((await attestTradedReceipt({ ...f.options, lease: replacement, mode: "commit", approvedDigest: preview.approvalDigest })).state, "applied"); }
      finally { await replacement.release(); }
    } finally { await f.close(); }
  });

  await t.test("a re-sign waits while the original amendment and the shared finalization hold the grant row lock", async () => {
    const f = await fixture();
    try {
      const preview = await attestTradedReceipt(f.options), competing = await f.connect();
      await competing.query("SET lock_timeout='250ms'");
      let checked = false;
      const completed = await attestTradedReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
        async checkpoint(at) {
          if (at !== "local") return;
          checked = true;
          await assert.rejects(competing.query("UPDATE grants SET updated_at=updated_at+1 WHERE tenant=$1", [TEST_TENANT]),
            (error: unknown) => (error as { code?: unknown }).code === "55P03", "the live grant row stays locked across the source write");
        } });
      assert.equal(checked, true); assert.equal(completed.state, "applied");
      assert.equal((await competing.query("UPDATE grants SET updated_at=updated_at+1 WHERE tenant=$1", [TEST_TENANT])).rowCount, 1,
        "an ordinary re-sign proceeds once the attestation commits");
    } finally { await f.close(); }
  });

  for (const [name, sql] of [
    ["grant incarnation (a re-sign)", "UPDATE grants SET updated_at=updated_at+1"],
    ["inferred flow preimage", `UPDATE flows SET amount_usdg=59.95445 WHERE id=${SHARED_FLOW}`],
    ["traded history", "UPDATE trades SET fill_cash_usdg=2.4 WHERE id=900"],
    ["source generation", "UPDATE tenant_ledger_import SET source_identity='changed'"],
    ["mirror cursor", "UPDATE mirror_state SET last_stamp=1 WHERE table_name='flows'"],
    ["permanent audit", "UPDATE ledger_receipt_attestations SET plan_json='{}'"],
  ] as const) await t.test(`${name} change after approval refuses retry and retains both barriers`, async () => {
    const f = await fixture();
    try {
      const preview = await attestTradedReceipt(f.options);
      const options = { ...f.options, mode: "commit" as const, approvedDigest: preview.approvalDigest };
      await assert.rejects(attestTradedReceipt({ ...options, checkpoint(at) { if (at === "marker") throw new Error("pause"); } }), /pause/);
      await f.main.query(sql); const before = readFileSync(f.file), otherBefore = await other(f.shared);
      await assert.rejects(attestTradedReceipt(options));
      assert.deepEqual(readFileSync(f.file), before); assert.deepEqual(await other(f.shared), otherBefore);
      assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "pending");
      assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), true);
    } finally { await f.close(); }
  });
});
