/** Actual supervisor entry, private local files, and optional disposable LOCAL PostgreSQL. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { advisoryLockWaitersForTest, makePgDb, wrapSqlite, type Db, type Stmt } from "./db";
import { withFleetRecoveryLock } from "./fleet-recovery";
import { preparePersistentHomeForHandover, PERSISTENT_HOME_MANIFEST } from "./persistent-home";
import { PgTenantLeaseManager, type TenantLease } from "./tenant-lease";

const pgUrl = process.env.MERRYMEN_TEST_PG_URL;
const savedEnv = { ...process.env };
process.env.MERRYMEN_HOSTED = "1";
const {
  runOrchestrator, setRecoveryReportOnlyForTest, setSpawnForTest, setTenantLeaseForTest,
} = await import("./orchestrator");
setSpawnForTest(() => { throw new Error("report mode must never fork"); });
after(() => { setRecoveryReportOnlyForTest(null); process.env = savedEnv; });
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const tenant = address(101), account = address(102), owner = address(103);
const publicGrant = { smartAccount: account, owner, sessionKeyAddress: address(104), chainId: 4663, grantedAt: 1, expiresAt: 9_000_000_000,
  serialized: "never-return-this-private-payload" };
const volume = "d6481580-14af-430c-af4a-f3540dfb833d";
function files(home: string): unknown {
  return readdirSync(home).sort().map(name => {
    const file = path.join(home, name), stat = lstatSync(file);
    return [name, stat.mode, stat.ino, stat.isDirectory() ? files(file) : stat.isSymbolicLink() ? "link" : readFileSync(file).toString("base64")];
  });
}
function fixture(t: TestContext) {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-report-only-"))), home = path.join(parent, "volume");
  mkdirSync(home, { mode: 0o700 });
  const st = lstatSync(home, { bigint: true }), major = ((st.dev >> 8n) & 0xfffn) | ((st.dev >> 32n) & 0xfffff000n),
    minor = (st.dev & 0xffn) | ((st.dev >> 12n) & 0xffffff00n);
  const line = `40 20 ${major}:${minor} / ${home} rw - ext4 /dev/volume rw\n`;
  Object.assign(process.env, { MERRYMEN_HOSTED: "1", MERRYMEN_HOME: home, RAILWAY_VOLUME_MOUNT_PATH: home,
    MERRYMEN_HOME_VOLUME_ID: volume, MERRYMEN_PERSISTENT_HOME_REQUIRED: "1", MERRYMEN_FLEET_RECOVERY_REPORT_ONLY: "1",
    // A Railway-shaped deployment must name its rollout scope (fleet-rollout.ts);
    // the reporter starts nobody, so it runs beside `none`.
    MERRYMEN_FLEET_ROLLOUT: "none",
    DATABASE_URL: "postgres://fixture.invalid/not-a-real-connection" });
  for (const key of ["MERRYMEN_STORE_DEK", "MERRYMEN_INITIAL_HANDOVER", "MERRYMEN_ACCOUNTING_HOLD_TENANTS"]) delete process.env[key];
  const halt = path.join(home, "FLEET_HALT"); writeFileSync(halt, "", { mode: 0o600 });
  const child = path.join(home, "children", tenant); mkdirSync(child, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(child, "merrymen.db"), "original-book-not-opened", { mode: 0o600 });
  writeFileSync(path.join(child, "merrymen.db-wal"), "original-uncheckpointed-wal", { mode: 0o600 });
  writeFileSync(path.join(child, "grant.json"), "original-private-cache", { mode: 0o600 });
  mkdirSync(path.join(child, "soul"), { mode: 0o700 }); writeFileSync(path.join(child, "soul", "OWNER.md"), "private preserved memory");
  const raw = new DatabaseSync(":memory:");
  raw.function("report_sha256", s => createHash("sha256").update(String(s)).digest("hex"));
  raw.exec(`CREATE TABLE grants(tenant TEXT PRIMARY KEY,chain_id INTEGER,grant_json TEXT,sealed_session_key TEXT,updated_at INTEGER);
    CREATE TABLE mirror_state(tenant TEXT,table_name TEXT,last_id INTEGER,last_stamp INTEGER);
    CREATE TABLE original_financial(id INTEGER,nonce TEXT,amount TEXT,risk TEXT,fee TEXT);
    CREATE TABLE tenant_ledger_import(tenant TEXT,payload TEXT); CREATE TABLE personal_memory(tenant TEXT,payload TEXT);`);
  raw.prepare("INSERT INTO grants VALUES(?,?,?,?,?)").run(tenant, 4663, JSON.stringify(publicGrant), "undecryptable-sealed-key", 100);
  raw.exec("INSERT INTO original_financial VALUES(73,'pending-3','12.5','retained-budget','retained-HWM')");
  raw.prepare("INSERT INTO mirror_state VALUES(?,'trades',73,1073)").run(tenant);
  raw.prepare("INSERT INTO tenant_ledger_import VALUES(?,'original-receipt')").run(tenant);
  raw.prepare("INSERT INTO personal_memory VALUES(?,'sealed-private-memory')").run(tenant);
  const base = wrapSqlite(raw), queries: string[] = [], releases = { n: 0 }, health = { ok: true };
  const lease: TenantLease = { tenant, backend: "postgres", healthy: () => health.ok, async release() { releases.n++; } };
  let hook: ((sql: string, db: Db) => Promise<void>) | null = null;
  const audit = (db: Db): Db => ({
    prepare(sql) {
      queries.push(sql); assertSql(sql);
      const stmt = db.prepare(sql);
      return {
        async all(...params) { const result = await stmt.all(...params); await hook?.(sql, db); return result; },
        async get(...params) { const result = await stmt.get(...params); await hook?.(sql, db); return result; },
        async run(...params) { const result = await stmt.run(...params); await hook?.(sql, db); return result; },
      } satisfies Stmt;
    },
    async exec(sql) { queries.push(sql); assertSql(sql); await db.exec(sql); await hook?.(sql, db); },
    tx(fn) { return db.tx(tx => fn(audit(tx))); },
  });
  const shared = audit(base);
  const use = (acquire: () => Promise<TenantLease | null> = async () => lease, mount = () => line) =>
    setRecoveryReportOnlyForTest({ shared, dialect: "sqlite", readMountInfo: mount, acquireLease: acquire, onePass: true });
  use();
  const original = () => ["grants", "mirror_state", "original_financial", "tenant_ledger_import", "personal_memory"]
    .map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const holds = () => raw.prepare("SELECT * FROM fleet_recovery_health").all();
  const holdCount = () => raw.prepare("SELECT name FROM sqlite_master WHERE name='fleet_recovery_health'").get() ? holds().length : 0;
  t.after(() => { setTenantLeaseForTest(tenant, null); setRecoveryReportOnlyForTest(null); raw.close(); rmSync(parent, { recursive: true, force: true }); });
  return { home, child, halt, line, raw, base, shared, queries, releases, health, lease, original, holds, holdCount, use,
    hook(fn: typeof hook) { hook = fn; }, async manifest() {
      rmSync(halt); const prior = path.join(home, "children"); renameSync(prior, path.join(parent, "children"));
      preparePersistentHomeForHandover({ ...process.env, MERRYMEN_INITIAL_HANDOVER: "report-fixture" }, { readMountInfo: () => line });
      renameSync(path.join(parent, "children"), prior);
    } };
}
function assertSql(sql: string): void {
  assert.ok(/^SELECT\b/i.test(sql.trim()) || /^INSERT INTO fleet_recovery_health\b/i.test(sql.trim())
    || /^CREATE TABLE IF NOT EXISTS fleet_recovery_health\b/i.test(sql.trim())
    || /^SET LOCAL lock_timeout='1000ms'; SET LOCAL statement_timeout='5000ms'$/.test(sql.trim()), `disallowed report SQL: ${sql}`);
  assert.ok(!/sealed_session_key|serialized|SELECT\s+\*|(?:CREATE|ALTER|DELETE|UPDATE)\s+(?:TABLE\s+)?(?:grants|tenant_ledger_import|agents|trades)\b/i.test(sql));
}

test("actual report entry preserves populated unmanifested root, invalid sealed keys and all original tables", async t => {
  const f = fixture(t), beforeFiles = files(f.home), beforeRows = f.original();
  await runOrchestrator();
  assert.equal(f.holdCount(), 1); assert.equal((f.holds()[0] as { cause: string }).cause, "persistent-source");
  assert.deepEqual(files(f.home), beforeFiles); assert.deepEqual(f.original(), beforeRows);
  assert.equal(existsSync(path.join(f.home, PERSISTENT_HOME_MANIFEST)), false);
  assert.equal(f.releases.n, 1); assert.equal(process.env.MERRYMEN_STORE_DEK, undefined);
  assert.ok(f.queries.every(sql => !/\b(?:agents|positions|cost_basis|personal_memory|tenant_ledger_import)\b/.test(sql)));
});
test("retained stopped and ordinarily expired grants can receive failure reports without becoming authority", async t => {
  for (const expiresAt of [0, 2]) {
    const f = fixture(t), grant = { ...publicGrant, expiresAt, ...(expiresAt === 0 ? { serialized: "", replacementStop: { sessionKeyHash: "a".repeat(64), sessionKeyAddress: publicGrant.sessionKeyAddress, stoppedAt: 2 } } : {}) };
    f.raw.prepare("UPDATE grants SET grant_json=?,sealed_session_key=?").run(JSON.stringify(grant), expiresAt === 0 ? "" : "undecryptable-sealed-key");
    const before = f.original(); await runOrchestrator();
    assert.equal(f.holdCount(), 1); assert.deepEqual(f.original(), before);
  }
});
test("missing or malformed mode cannot enter reporter or initialize the incident root", async t => {
  for (const mode of [undefined, "0", "true", " 1", ""]) {
    const f = fixture(t), before = files(f.home);
    if (mode === undefined) delete process.env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY; else process.env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY = mode;
    await assert.rejects(runOrchestrator()); assert.deepEqual(files(f.home), before);
    assert.equal(f.queries.length, 0);
  }
});
test("malformed operator hold, missing halt, nonprivate root, wrong mount and unsafe halt refuse before SQL", async t => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = "bad-tenant"; },
    (f: ReturnType<typeof fixture>) => { process.env.MERRYMEN_INITIAL_HANDOVER = "bad token"; },
    (f: ReturnType<typeof fixture>) => rmSync(f.halt),
    (f: ReturnType<typeof fixture>) => chmodSync(f.home, 0o755),
    (f: ReturnType<typeof fixture>) => f.use(undefined, () => f.line.replace("ext4", "overlay")),
    (f: ReturnType<typeof fixture>) => chmodSync(f.halt, 0o644),
    (f: ReturnType<typeof fixture>) => linkSync(f.halt, `${f.halt}.linked`),
    (f: ReturnType<typeof fixture>) => writeFileSync(f.halt, Buffer.alloc(8193)),
    (f: ReturnType<typeof fixture>) => { rmSync(f.halt); execFileSync("mkfifo", [f.halt]); chmodSync(f.halt, 0o600); },
    (f: ReturnType<typeof fixture>) => { renameSync(f.halt, `${f.halt}.old`); symlinkSync(`${f.halt}.old`, f.halt); },
  ]) {
    const f = fixture(t); change(f); await assert.rejects(runOrchestrator()); assert.equal(f.queries.length, 0); assert.equal(f.holdCount(), 0);
  }
});
test("valid held manifest is not a tenant failure; present uncertain books remain unopened", async t => {
  const f = fixture(t); await f.manifest(); const before = files(f.home);
  await runOrchestrator(); assert.equal(f.holdCount(), 0); assert.deepEqual(files(f.home), before);
  assert.equal(f.queries.filter(s => /CREATE|INSERT/.test(s)).length, 0);
});
test("valid halted volume reports pinned source marker or absent book with positive cursor only", async t => {
  for (const kind of ["marker", "missing", "zero"] as const) {
    const f = fixture(t); await f.manifest();
    if (kind === "marker") writeFileSync(path.join(f.child, "ledger-source-blocked.json"), '{"version":1}', { mode: 0o600 });
    else { rmSync(path.join(f.child, "merrymen.db")); if (kind === "zero") f.raw.exec("UPDATE mirror_state SET last_id=0"); }
    const before = files(f.home); await runOrchestrator(); assert.deepEqual(files(f.home), before);
    assert.equal(f.holdCount(), kind === "zero" ? 0 : 1);
    if (kind !== "zero") assert.equal((f.holds()[0] as { cause: string }).cause, kind === "marker" ? "source-barrier" : "source-continuity");
  }
});
test("corrupt manifest, malformed public grants and duplicate accounts never publish", async t => {
  for (const kind of ["manifest", "grant", "null-expiry", "unwitnessed-zero-expiry", "duplicate"] as const) {
    const f = fixture(t);
    if (kind === "manifest") writeFileSync(path.join(f.home, PERSISTENT_HOME_MANIFEST), "{}", { mode: 0o600 });
    if (kind === "grant") f.raw.exec("UPDATE grants SET grant_json='{}'");
    if (kind === "null-expiry") f.raw.prepare("UPDATE grants SET grant_json=?").run(JSON.stringify({ ...publicGrant, expiresAt: null }));
    if (kind === "unwitnessed-zero-expiry") f.raw.prepare("UPDATE grants SET grant_json=?").run(JSON.stringify({ ...publicGrant, expiresAt: 0 }));
    if (kind === "duplicate") f.raw.prepare("INSERT INTO grants VALUES(?,?,?,?,?)").run(address(110), 4663, JSON.stringify(publicGrant), "invalid", 100);
    await assert.rejects(runOrchestrator()); assert.equal(f.holdCount(), 0);
  }
});
test("active local lease, unavailable lease and implicit backend cannot publish or adopt authority", async t => {
  const f = fixture(t); setTenantLeaseForTest(tenant, f.lease);
  await assert.rejects(runOrchestrator()); assert.equal(f.queries.length, 0); setTenantLeaseForTest(tenant, null);
  f.use(async () => null); await runOrchestrator(); assert.equal(f.holdCount(), 0);
  f.use(async () => ({ ...f.lease, backend: "none" })); await assert.rejects(runOrchestrator()); assert.equal(f.releases.n, 1);
  f.use(async () => ({ ...f.lease, tenant: address(999) })); await assert.rejects(runOrchestrator()); assert.equal(f.holdCount(), 0);
});
test("actual entry refuses existing child and holder maps before touching any cold dependency", async t => {
  const f = fixture(t), before = files(f.home);
  for (const kind of ["child", "holder"]) {
    // Separate fixture processes keep adopted writer maps isolated without
    // invoking ordinary kill/retirement cleanup to remove them afterwards.
    const source = `import assert from 'node:assert/strict';
      const m=await import(${JSON.stringify(new URL("./orchestrator.ts", import.meta.url).href)});
      const tenant=${JSON.stringify(tenant)}, account=${JSON.stringify(account)};
      const lease={tenant,backend:'postgres',healthy:()=>true,release:async()=>{throw Error('ordinary lease released')}};
      m.setTenantLeaseForTest(tenant,lease);
      ${kind === "holder" ? "await m.adoptHolderForTest(tenant,account,null);" : "m.adoptChildForTest(tenant,account,{kill(){throw Error('writer killed')}},lease);"}
      await assert.rejects(m.runOrchestrator(),/report-only prerequisites/);`;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { env: { ...process.env }, timeout: 10_000 });
  }
  assert.deepEqual(files(f.home), before); assert.equal(f.queries.length, 0);
});
test("halt replacement during lease acquisition releases the new lease and publishes nothing", async t => {
  const f = fixture(t); f.use(async () => { renameSync(f.halt, `${f.halt}.old`); writeFileSync(f.halt, "", { mode: 0o600 }); return f.lease; });
  await assert.rejects(runOrchestrator()); assert.equal(f.releases.n, 1); assert.equal(f.holdCount(), 0);
});
test("changed grant, source cursor, halt or lease while awaiting publication roll back the health row", async t => {
  for (const kind of ["grant", "cursor", "halt", "lease"] as const) {
    const f = fixture(t);
    if (kind === "cursor") { await f.manifest(); rmSync(path.join(f.child, "merrymen.db")); }
    let done = false;
    f.hook(async sql => {
      if (done) return;
      if (kind === "grant" && sql.startsWith("CREATE TABLE IF NOT EXISTS fleet_recovery_health")) {
        done = true; f.raw.exec("UPDATE grants SET updated_at=101");
      } else if (kind === "cursor" && sql.startsWith("CREATE TABLE IF NOT EXISTS fleet_recovery_health")) {
        done = true; f.raw.exec("UPDATE mirror_state SET last_id=74");
      } else if (sql.startsWith("INSERT INTO fleet_recovery_health")) {
        done = true;
        if (kind === "halt") { renameSync(f.halt, `${f.halt}.old`); writeFileSync(f.halt, "", { mode: 0o600 }); }
        if (kind === "lease") f.health.ok = false;
      }
    });
    await assert.rejects(runOrchestrator()); assert.equal(f.holdCount(), 0); assert.equal(f.releases.n, 1);
  }
});

test("disposable PostgreSQL: exact public incarnation, real leases, row-lock serialization and rollback", { skip: !pgUrl, timeout: 45_000 }, async t => {
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(pgUrl!).hostname), "LOCAL test database only");
  const pg = createRequire(import.meta.url)("pg") as {
    Client: new (c: { connectionString: string }) => { connect(): Promise<void>; query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void>; on(event: string, cb: () => void): void };
  };
  const schema = `mm_report_${randomBytes(8).toString("hex")}`, admin = new pg.Client({ connectionString: pgUrl! }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(pgUrl!); url.searchParams.set("options", `-c search_path=${schema}`);
  const localUrl = url.toString(), db = await makePgDb(localUrl);
  await db.exec(readFileSync(new URL("./testdata/shared-schema-75995697.sql", import.meta.url), "utf8"));
  await db.exec(`CREATE TABLE original_financial(id BIGINT,nonce TEXT,amount TEXT,risk TEXT,fee TEXT);
    CREATE TABLE tenant_ledger_import(tenant TEXT,payload TEXT); CREATE TABLE personal_memory(tenant TEXT,payload TEXT);`);
  await db.prepare("INSERT INTO grants VALUES(?,?,?,?,?)").run(tenant, 4663, JSON.stringify(publicGrant), "not-decryptable", 100);
  await db.exec("INSERT INTO original_financial VALUES(73,'pending-3','12.5','original-risk','original-fee')");
  await db.prepare("INSERT INTO mirror_state(tenant,table_name,last_id,last_stamp) VALUES(?,'trades',73,1073)").run(tenant);
  await db.prepare("INSERT INTO tenant_ledger_import VALUES(?,'original-receipt')").run(tenant);
  await db.prepare("INSERT INTO personal_memory VALUES(?,'sealed-private-memory')").run(tenant);
  await db.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,hwm_usdg,accrued_fee_usdg,epoch) VALUES(?,?,?,4663,'{}',1,9000000000,120,3,4)").run(account, owner, publicGrant.sessionKeyAddress);
  await db.prepare("INSERT INTO trades(id,agent_id,kind,target,amount_usdg,status,user_op_hash,epoch) VALUES(73,?,'swap','fixture',12.5,'submitted','unresolved-original-op',4)").run(account);
  await db.prepare("INSERT INTO cost_basis(agent_id,mode,symbol,qty_raw,cost_usdg) VALUES(?,'live','COIN','1000000000','21.7')").run(account);
  await db.prepare("INSERT INTO risk_periods VALUES('original-risk',?,1000,100,120,4,'original carry')").run(account);
  await db.prepare("INSERT INTO fee_accruals(agent_id,profit_usdg,fee_usdg,hwm_before_usdg,hwm_after_usdg,epoch) VALUES(?,20,3,100,120,4)").run(account);
  await db.prepare("INSERT INTO agent_commands(id,agent_id,kind,created_at) VALUES('original-intent',?,'trade',1000)").run(account);
  const originalTables = (await db.prepare("SELECT tablename FROM pg_tables WHERE schemaname=? ORDER BY tablename").all(schema)) as Array<{ tablename: string }>;
  const clientPrototype = Object.getPrototypeOf(admin) as { query: (...args: unknown[]) => Promise<unknown> }, originalQuery = clientPrototype.query;
  const audit: string[] = []; let queryHook: ((sql: string) => Promise<void>) | null = null;
  clientPrototype.query = async function(...args: unknown[]) {
    const sql = typeof args[0] === "string" ? args[0] : String((args[0] as { text: string }).text);
    if (queryHook) { audit.push(sql); if (!/^(?:BEGIN|COMMIT|ROLLBACK|SELECT pg_)/.test(sql)) assertSql(sql); }
    const result = await originalQuery.apply(this, args); await queryHook?.(sql); return result;
  };
  const leaseClients: InstanceType<typeof pg.Client>[] = [];
  const makeLeaseClient = async () => { const c = new pg.Client({ connectionString: localUrl }); leaseClients.push(c); return c; };
  const manager = new PgTenantLeaseManager(makeLeaseClient);
  t.after(async () => { clientPrototype.query = originalQuery; await Promise.allSettled(leaseClients.map(c => c.end())); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const snapshot = async () => {
    const result: unknown[] = [];
    for (const { tablename } of originalTables) result.push([tablename, await db.prepare(`SELECT * FROM ${tablename} ORDER BY ctid`).all()]);
    return result;
  };
  const options = (f: ReturnType<typeof fixture>, acquire: (tenant: `0x${string}`) => Promise<TenantLease | null> = tenant => manager.acquire(tenant)) => {
    process.env.DATABASE_URL = localUrl;
    setRecoveryReportOnlyForTest({ shared: db, dialect: "postgres", readMountInfo: () => f.line, acquireLease: acquire, onePass: true });
  };
  await t.test("actual entry has no cold financial DDL/key access or filesystem mutation", async sub => {
    const f = fixture(sub); options(f); const beforeRows = await snapshot(), beforeFiles = files(f.home);
    queryHook = async () => {}; await runOrchestrator(); queryHook = null;
    assert.deepEqual(await snapshot(), beforeRows); assert.deepEqual(files(f.home), beforeFiles);
    assert.equal((await db.prepare("SELECT held FROM fleet_recovery_health").get() as { held: number }).held, 1);
    assert.ok(audit.some(sql => /xmin::text.*sha256/.test(sql))); assert.ok(audit.some(sql => /FOR SHARE NOWAIT/.test(sql)));
    assert.equal(existsSync(path.join(f.home, PERSISTENT_HOME_MANIFEST)), false);
  });
  await t.test("real tenant lease contention produces no new report", async sub => {
    const f = fixture(sub); options(f);
    const other = new PgTenantLeaseManager(makeLeaseClient);
    const held = await other.acquire(tenant); assert.ok(held);
    const before = await db.prepare("SELECT * FROM fleet_recovery_health").all(); await runOrchestrator();
    assert.deepEqual(await db.prepare("SELECT * FROM fleet_recovery_health").all(), before); await held.release();
  });
  await t.test("documented stopped and normally expired PostgreSQL grants remain reportable but unchanged", async sub => {
    for (const expiresAt of [0, 2]) {
      const f = fixture(sub); options(f);
      const grant = { ...publicGrant, expiresAt, ...(expiresAt === 0 ? { serialized: "", replacementStop: {
        sessionKeyHash: "a".repeat(64), sessionKeyAddress: publicGrant.sessionKeyAddress, stoppedAt: 2,
      } } : {}) };
      await db.prepare("UPDATE grants SET grant_json=?,sealed_session_key=? WHERE tenant=?").run(JSON.stringify(grant), expiresAt === 0 ? "" : "not-decryptable", tenant);
      const before = await snapshot(); queryHook = async () => {}; await runOrchestrator(); queryHook = null;
      assert.deepEqual(await snapshot(), before);
    }
    await db.prepare("UPDATE grants SET grant_json=?,sealed_session_key='not-decryptable' WHERE tenant=?").run(JSON.stringify(publicGrant), tenant);
  });
  await t.test("grant replacement before the account lock wins prevents publication", async sub => {
    const f = fixture(sub); options(f);
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    const lock = withFleetRecoveryLock(db, account, async () => { entered(); await gate; }); await enteredPromise;
    const run = runOrchestrator();
    const key = createHash("sha256").update(account).digest().readInt32BE(0);
    while (!advisoryLockWaitersForTest(db, 0x4d525643, key)) await delay(5);
    await db.prepare("UPDATE grants SET updated_at=101 WHERE tenant=?").run(tenant); release(); await lock;
    await assert.rejects(run); await db.prepare("UPDATE grants SET updated_at=100 WHERE tenant=?").run(tenant);
  });
  await t.test("FOR SHARE keeps a concurrent replacement after the report commit", async sub => {
    const f = fixture(sub); options(f);
    const updater = new pg.Client({ connectionString: localUrl }); await updater.connect();
    const pid = Number((await updater.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
    let locked!: () => void, release!: () => void;
    const rowLocked = new Promise<void>(r => { locked = r; }), gate = new Promise<void>(r => { release = r; });
    queryHook = async sql => { if (/FROM grants.*FOR SHARE NOWAIT/s.test(sql)) locked(); if (/^INSERT INTO fleet_recovery_health/.test(sql)) await gate; };
    const run = runOrchestrator(); await rowLocked;
    // This writer uses an actual separate backend, rather than a mocked lock.
    const update = originalQuery.call(updater, "UPDATE grants SET updated_at=102 WHERE tenant=$1", [tenant]);
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      const state = await originalQuery.call(admin, "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]) as { rows: Array<{ wait_event_type: string }> };
      if (state.rows[0]?.wait_event_type === "Lock") { waiting = true; break; } await delay(10);
    }
    assert.equal(waiting, true); release(); await run; await update; queryHook = null;
    assert.equal((await db.prepare("SELECT updated_at FROM grants").get() as { updated_at: number }).updated_at, 102);
    await db.prepare("UPDATE grants SET updated_at=100 WHERE tenant=?").run(tenant); await updater.end();
  });
  await t.test("changed halt after actual health insert rolls back", async sub => {
    const f = fixture(sub); options(f); const before = await db.prepare("SELECT * FROM fleet_recovery_health").all();
    queryHook = async sql => { if (/^INSERT INTO fleet_recovery_health/.test(sql)) { renameSync(f.halt, `${f.halt}.old`); writeFileSync(f.halt, "", { mode: 0o600 }); } };
    await assert.rejects(runOrchestrator()); queryHook = null;
    assert.deepEqual(await db.prepare("SELECT * FROM fleet_recovery_health").all(), before);
  });
  await t.test("lost real PostgreSQL lease after insert rolls back report and retains every source row", async sub => {
    const f = fixture(sub); options(f); const before = await snapshot(), reports = await db.prepare("SELECT * FROM fleet_recovery_health").all();
    queryHook = async sql => {
      if (/^INSERT INTO fleet_recovery_health/.test(sql)) {
        // A separate owned lease backend actually ends, releasing its server lock.
        await leaseClients[0]!.end();
      }
    };
    await assert.rejects(runOrchestrator()); queryHook = null;
    assert.deepEqual(await snapshot(), before); assert.deepEqual(await db.prepare("SELECT * FROM fleet_recovery_health").all(), reports);
  });
});
