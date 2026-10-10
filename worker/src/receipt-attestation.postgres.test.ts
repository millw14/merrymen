/** Opt-in disposable LOCAL PostgreSQL; never connects to the ambient DATABASE_URL. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { translateQuery, translateSchema, wrapSqlite, type Db } from "./db";
import { attestOriginalReceipt } from "./receipt-attestation";
import { assertNoPendingReceiptAttestation, readReceiptAttestation } from "./receipt-attestation-state";
import { receiptFixture, TEST_ACCOUNT, TEST_TENANT } from "./receipt-attestation-fixture";
import { seedOwnerRevocations } from "./receipt-attestation-owner-fixture";
import { acquireTenantLease, PgTenantLeaseManager } from "./tenant-lease";
import { JOURNAL_GENESIS, journalHash } from "./store";
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

test("Postgres: original receipt attestation, durable interruptions and actual tenant authority", { skip: !url, timeout: 90_000 }, async t => {
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
    const schema = `mm_receipt_${randomBytes(8).toString("hex")}`, application = `${schema}_lease`;
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
    const f = await receiptFixture(shared, lease);
    const competitor = new PgTenantLeaseManager(async () => freshClient());
    await shared.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,mode,hwm_usdg) VALUES(?,?,?,4663,'{}',1,9999999999,'live',77)").run(OTHER, OTHER, OTHER);
    await shared.prepare("INSERT INTO flows(agent_id,direction,amount_usdg,source) VALUES(?,'in',77,'inferred')").run(OTHER);
    return { ...f, connect, wrap, main, competitor, lease, application,
      async close() {
        await lease.release();
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()", [application]);
        await Promise.allSettled([...clients].map(client => client.end()));
        f.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      },
    };
  }
  const source = async (db: Db) => db.prepare("SELECT * FROM flows WHERE LOWER(agent_id)=?").get(TEST_ACCOUNT.toLowerCase()) as Promise<Record<string, unknown>>;
  const owners = async (db: Db) => (await db.prepare("SELECT * FROM owner_operations WHERE LOWER(agent_id)=? ORDER BY id").all(TEST_ACCOUNT.toLowerCase()) as Record<string, unknown>[]).map(row => ({ ...row }));
  const other = async (db: Db) => ({ agent: await db.prepare("SELECT * FROM agents WHERE smart_account=?").get(OTHER), flow: await db.prepare("SELECT * FROM flows WHERE agent_id=?").get(OTHER) });

  for (const boundary of ["audit", "marker", "local", "shared", "cleared"] as const) await t.test(`crash after ${boundary}: fresh connections preserve proved owner records and resume once without changing money or other tenants`, async () => {
    const f = await fixture();
    try {
      const ownerEvidence = await seedOwnerRevocations(f, boundary === "audit" ? 23 : 2);
      assert.equal(await f.competitor.acquire(TEST_TENANT), null, "another supervisor cannot hold the same tenant");
      const original = { agents: await f.shared.prepare("SELECT * FROM agents ORDER BY smart_account").all(),
        localAgent: await f.local.prepare("SELECT * FROM agents").all(), marks: await f.shared.prepare("SELECT * FROM mirror_state").all(),
        source: await f.shared.prepare("SELECT * FROM tenant_ledger_import").all(), journal: await f.local.prepare("SELECT * FROM journal ORDER BY seq").all(), other: await other(f.shared),
        localOwners: await owners(f.local), sharedOwners: await owners(f.shared) };
      const before = readFileSync(f.file), preview = await attestOriginalReceipt(f.options);
      assert.equal(preview.state, "preview"); assert.deepEqual(readFileSync(f.file), before);
      assert.equal(await readReceiptAttestation(f.shared, TEST_TENANT), undefined, "preview did not create an audit");
      await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
        checkpoint(at) { if (at === boundary) throw new Error("injected crash"); } }), /injected crash/);
      const fresh = f.wrap(await f.connect()), reopened = new DatabaseSync(f.file, { readOnly: true });
      try {
        assert.equal((await source(wrapSqlite(reopened))).source, ["local", "shared", "cleared"].includes(boundary) ? "chain-log" : "inferred");
        assert.equal((await source(fresh)).source, ["shared", "cleared"].includes(boundary) ? "chain-log" : "inferred");
        const audit = (await readReceiptAttestation(fresh, TEST_TENANT))!;
        assert.equal(audit.state, ["shared", "cleared"].includes(boundary) ? "applied" : "pending");
        const plan = JSON.parse(String(audit.plan_json));
        assert.deepEqual(plan.local.ownerOperations, original.localOwners);
        assert.deepEqual(plan.shared.ownerOperations, original.sharedOwners);
        assert.equal(plan.ownerProof.operations.length, ownerEvidence.receipts.size);
        assert.ok(plan.ownerProof.operations.every((proof: { callKind: string }) => proof.callKind === "invalidate-nonce"));
        assert.deepEqual(await owners(wrapSqlite(reopened)), original.localOwners);
        assert.deepEqual(await owners(fresh), original.sharedOwners);
        if (["audit", "marker", "local"].includes(boundary)) await assert.rejects(assertNoPendingReceiptAttestation(fresh, TEST_TENANT), /unfinished/);
      } finally { reopened.close(); }
      const permanentPlan = (await readReceiptAttestation(fresh, TEST_TENANT))!.plan_json;
      const options = { ...f.options, shared: fresh, mode: "commit" as const, approvedDigest: preview.approvalDigest };
      assert.equal((await attestOriginalReceipt(options)).state, "applied");
      assert.equal((await attestOriginalReceipt(options)).state, "applied", "exact replay is idempotent");
      for (const db of [f.local, fresh]) {
        const row = await source(db);
        assert.equal(row.source, "chain-log"); assert.equal(row.amount_usdg, 200); assert.equal(row.at, 1791595716); assert.equal(row.log_index, 17);
        assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM flows WHERE LOWER(agent_id)=?").get(TEST_ACCOUNT.toLowerCase()) as { n: number }).n, 1);
      }
      assert.deepEqual(await fresh.prepare("SELECT * FROM agents ORDER BY smart_account").all(), original.agents);
      assert.deepEqual(await f.local.prepare("SELECT * FROM agents").all(), original.localAgent);
      assert.deepEqual(await fresh.prepare("SELECT * FROM mirror_state").all(), original.marks);
      assert.deepEqual(await fresh.prepare("SELECT * FROM tenant_ledger_import").all(), original.source);
      assert.deepEqual(await other(fresh), original.other);
      assert.deepEqual(await owners(f.local), original.localOwners);
      assert.deepEqual(await owners(fresh), original.sharedOwners);
      assert.equal((await readReceiptAttestation(fresh, TEST_TENANT))!.plan_json, permanentPlan, "retries retain the original approval and owner receipt evidence");
      const journal = await f.local.prepare("SELECT * FROM journal ORDER BY seq").all() as Record<string, unknown>[];
      assert.equal(journal.length, 2); assert.deepEqual(journal.slice(0, 1), original.journal);
      let head = JOURNAL_GENESIS;
      for (const row of journal) { assert.equal(row.prev_hash, head); assert.equal(row.hash, journalHash(head, String(row.payload_json))); head = String(row.hash); }
      assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), false);
    } finally { await f.close(); }
  });

  for (const boundary of ["audit", "local", "shared"] as const) await t.test(`owner receipt loss after ${boundary} refuses fresh retry until the same canonical evidence returns`, async () => {
    const f = await fixture();
    try {
      const evidence = await seedOwnerRevocations(f);
      const preview = await attestOriginalReceipt(f.options);
      const options = { ...f.options, mode: "commit" as const, approvedDigest: preview.approvalDigest };
      await assert.rejects(attestOriginalReceipt({ ...options, checkpoint(at) { if (at === boundary) throw new Error("owner proof interruption"); } }), /owner proof interruption/);
      const fresh = f.wrap(await f.connect());
      const before = { file: readFileSync(f.file), source: await source(fresh), owners: await owners(fresh),
        audit: await readReceiptAttestation(fresh, TEST_TENANT), marks: await fresh.prepare("SELECT * FROM mirror_state").all(), other: await other(fresh) };
      const missingTx = evidence.receipts.keys().next().value!;
      await assert.rejects(attestOriginalReceipt({ ...options, shared: fresh,
        rpc: async (method, params) => method === "eth_getTransactionReceipt" && params[0] === missingTx ? null : evidence.rpc(method, params) }), /owner operations lack/);
      assert.deepEqual(readFileSync(f.file), before.file);
      assert.deepEqual(await source(fresh), before.source); assert.deepEqual(await owners(fresh), before.owners);
      assert.deepEqual(await readReceiptAttestation(fresh, TEST_TENANT), before.audit);
      assert.deepEqual(await fresh.prepare("SELECT * FROM mirror_state").all(), before.marks);
      assert.deepEqual(await other(fresh), before.other);
      assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), boundary !== "audit");
      if (boundary !== "shared") await assert.rejects(assertNoPendingReceiptAttestation(fresh, TEST_TENANT), /unfinished/);
      assert.equal((await attestOriginalReceipt({ ...options, shared: fresh })).state, "applied");
      assert.equal((await attestOriginalReceipt({ ...options, shared: fresh })).state, "applied");
      assert.equal((await source(fresh)).amount_usdg, 200);
      assert.equal((await fresh.prepare("SELECT COUNT(*) AS n FROM flows WHERE LOWER(agent_id)=?").get(TEST_ACCOUNT.toLowerCase()) as { n: number }).n, 1);
      assert.deepEqual(await owners(fresh), before.owners);
    } finally { await f.close(); }
  });

  for (const side of ["local", "shared"] as const) await t.test(`${side} owner raw-row mutation after approval refuses despite unchanged receipt meaning`, async () => {
    const f = await fixture();
    try {
      await seedOwnerRevocations(f);
      const preview = await attestOriginalReceipt(f.options);
      const options = { ...f.options, mode: "commit" as const, approvedDigest: preview.approvalDigest };
      await assert.rejects(attestOriginalReceipt({ ...options, checkpoint(at) { if (at === "marker") throw new Error("owner row interruption"); } }), /owner row interruption/);
      const db = side === "local" ? f.local : f.shared;
      await db.prepare("UPDATE owner_operations SET created_at=created_at+1 WHERE LOWER(agent_id)=?").run(TEST_ACCOUNT.toLowerCase());
      const before = { file: readFileSync(f.file), owners: await owners(f.shared), audit: await readReceiptAttestation(f.shared, TEST_TENANT) };
      await assert.rejects(attestOriginalReceipt(options), /accounting preimages changed/);
      assert.deepEqual(readFileSync(f.file), before.file); assert.deepEqual(await owners(f.shared), before.owners);
      assert.deepEqual(await readReceiptAttestation(f.shared, TEST_TENANT), before.audit);
      assert.equal((await source(f.local)).source, "inferred"); assert.equal((await source(f.shared)).source, "inferred");
      assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), true);
      await assert.rejects(assertNoPendingReceiptAttestation(f.shared, TEST_TENANT), /unfinished/);
    } finally { await f.close(); }
  });

  await t.test("real shared transaction failure preserves pending audit and local amendment for retry", async () => {
    const f = await fixture();
    try {
      const preview = await attestOriginalReceipt(f.options);
      await f.main.query("CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected shared rollback'; END $$");
      await f.main.query("CREATE TRIGGER reject_receipt BEFORE UPDATE ON flows FOR EACH ROW EXECUTE FUNCTION reject_receipt()");
      const options = { ...f.options, mode: "commit" as const, approvedDigest: preview.approvalDigest };
      await assert.rejects(attestOriginalReceipt(options), /injected shared rollback/);
      assert.equal((await source(f.local)).source, "chain-log"); assert.equal((await source(f.shared)).source, "inferred");
      assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "pending");
      assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), true);
      await f.main.query("DROP TRIGGER reject_receipt ON flows");
      assert.equal((await attestOriginalReceipt(options)).state, "applied");
    } finally { await f.close(); }
  });

  await t.test("durable pending audit blocks source replacement even before a marker exists and when the local path is absent", async () => {
    const f = await fixture();
    try {
      const preview = await attestOriginalReceipt(f.options);
      await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
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

  await t.test("terminated actual advisory lease refuses mutation; a new owner can resume the pending audit", async () => {
    const f = await fixture();
    try {
      const preview = await attestOriginalReceipt(f.options);
      await assert.rejects(attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
        async checkpoint(at) {
          if (at !== "audit") return;
          await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1", [f.application]);
          for (let tries = 0; f.lease.healthy() && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
          assert.equal(f.lease.healthy(), false);
        } }), /lease/);
      assert.equal((await source(f.local)).source, "inferred");
      await assert.rejects(assertNoPendingReceiptAttestation(f.shared, TEST_TENANT), /unfinished/);
      const replacement = await f.competitor.acquire(TEST_TENANT); assert.ok(replacement);
      try { assert.equal((await attestOriginalReceipt({ ...f.options, lease: replacement, mode: "commit", approvedDigest: preview.approvalDigest })).state, "applied"); }
      finally { await replacement.release(); }
    } finally { await f.close(); }
  });

  await t.test("grant replacement waits while original-source amendment and shared finalization hold its row lock", async () => {
    const f = await fixture();
    try {
      const preview = await attestOriginalReceipt(f.options), competing = await f.connect();
      await competing.query("SET lock_timeout='250ms'");
      let checked = false;
      const completed = await attestOriginalReceipt({ ...f.options, mode: "commit", approvedDigest: preview.approvalDigest,
        async checkpoint(at) {
          if (at !== "local") return;
          checked = true;
          await assert.rejects(competing.query("UPDATE grants SET updated_at=updated_at+1 WHERE tenant=$1", [TEST_TENANT]),
            (error: unknown) => (error as { code?: unknown }).code === "55P03", "the live grant row must remain locked across the source write");
        } });
      assert.equal(checked, true); assert.equal(completed.state, "applied");
      assert.equal((await f.main.query("SELECT updated_at FROM grants WHERE tenant=$1", [TEST_TENANT])).rows[0]!.updated_at, 1234);
      assert.equal((await competing.query("UPDATE grants SET updated_at=updated_at+1 WHERE tenant=$1", [TEST_TENANT])).rowCount, 1,
        "ordinary grant replacement proceeds after the attestation transaction commits");
    } finally { await f.close(); }
  });

  for (const [name, sql] of [
    ["grant incarnation", "UPDATE grants SET updated_at=updated_at+1"],
    ["flow preimage", "UPDATE flows SET amount_usdg=201 WHERE id=428"],
    ["source generation", "UPDATE tenant_ledger_import SET source_identity='changed'"],
    ["mirror cursor", "UPDATE mirror_state SET last_stamp=1"],
    ["permanent audit", "UPDATE ledger_receipt_attestations SET plan_json='{}'"],
  ] as const) await t.test(`${name} change after approval refuses retry and retains both records`, async () => {
    const f = await fixture();
    try {
      const preview = await attestOriginalReceipt(f.options);
      const options = { ...f.options, mode: "commit" as const, approvedDigest: preview.approvalDigest };
      await assert.rejects(attestOriginalReceipt({ ...options, checkpoint(at) { if (at === "marker") throw new Error("pause"); } }), /pause/);
      await f.main.query(sql); const before = readFileSync(f.file), otherBefore = await other(f.shared);
      await assert.rejects(attestOriginalReceipt(options));
      assert.deepEqual(readFileSync(f.file), before); assert.deepEqual(await other(f.shared), otherBefore);
      assert.equal((await readReceiptAttestation(f.shared, TEST_TENANT))!.state, "pending");
      assert.equal(existsSync(path.join(f.options.home, "ledger-source-blocked.json")), true);
    } finally { await f.close(); }
  });
});
