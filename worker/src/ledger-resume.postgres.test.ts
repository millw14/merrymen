/**
 * Opt-in real, disposable LOCAL PostgreSQL: attested-gap admission and the
 * owner-control arm against the production dialect. Never reads DATABASE_URL.
 *
 * What only Postgres can show: the row locks (FOR UPDATE / FOR SHARE) and the
 * one transaction of registerAttestedGapSource, the partial unique index that
 * keeps one open approval per tenant, BIGINT columns coming back as strings,
 * a missing #259 journal arriving as SQLSTATE 42P01, and the ALTER that adds
 * tenant_telegram.paused_at. Then the ordinary path's own gates —
 * restoreLedgerImport, registerLedgerSource, the continuity proof and a real
 * mirror pass — accept the attested book exactly as they would any other.
 *
 * Run with MERRYMEN_TEST_PG_URL=postgres://…@127.0.0.1:<port>/<db>.
 */
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
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { PgGrantStore } from "./grant-store";
import { leaseKey, type TenantLease } from "./tenant-lease";
import { assertLedgerSourceContinuity } from "./ledger-safeguard";
import { ensureLedgerResumeSchema, registerAttestedGapSource, registerLedgerSource, restoreLedgerImport, type LedgerImportVolume } from "./ledger-import";
import { applyResumeApprovals, attestedSourceInUse, moveApproval, planAttestedSeed, readOpenApproval, readResumeEvidence, recordPreviewRun, type PreviewEntry } from "./ledger-resume";
import { autoPaperVerdict, countOpenApprovals, grantRowKey, noteGrantAttempt, observeGrantChanges, recordResumeApproval, settleGrantChange } from "./ledger-resume";
import { armOwnerControls, readControlsEvidence, readRecoveryControls } from "./recovery-reply-arm";
import { readDurablePause } from "./telegram-store";

interface Client {
  connect(): Promise<void>; end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  on(event: "error" | "end", fn: () => void): void;
}
const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
const pg = url ? createRequire(import.meta.url)("pg") as { Client: new (config: { connectionString: string }) => Client } : null;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const dek = Buffer.alloc(32, 77), key = `0x${"46".repeat(32)}` as `0x${string}`;
const NOW = Math.floor(Date.now() / 1000), OLD = NOW - 5 * 86_400;

test("Postgres: attested-gap registration, its approvals, and the owner-control arm", { skip: !url, timeout: 60_000 }, async (t) => {
  const target = new URL(url!); assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "only a disposable LOCAL PostgreSQL is allowed");
  const schema = `mm_resume_${randomBytes(8).toString("hex")}`;
  const admin = new pg!.Client({ connectionString: target.toString() }); await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(target); scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=8000`);
  const clients: Client[] = [], tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mm-resume-pg-")));
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
  const shared = wrap(main); await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL); await shared.exec(PAPER_CHECKPOINT_SCHEMA);
  const grants = new PgGrantStore(scoped.toString(), async () => connect());
  const raws: DatabaseSync[] = [];
  t.after(async () => {
    for (const raw of raws) raw.close();
    await Promise.allSettled(clients.map(c => c.end()));
    try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); rmSync(tmp, { recursive: true, force: true }); }
    if (savedDek === undefined) delete process.env.MERRYMEN_STORE_DEK; else process.env.MERRYMEN_STORE_DEK = savedDek;
  });

  // A pre-incident tenant: an original book mirrored into Postgres, then lost.
  const tenant = address(0xabc01), account = address(0xdef01), owner = address(0xfed01);
  await grants.put(tenant, { smartAccount: account, owner, chainId: 4663, sessionKeyAddress: privateKeyToAccount(key).address,
    serialized: Buffer.from(JSON.stringify({ privateKey: key })).toString("base64"), demoSessionPrivateKey: key, grantedAt: 1, expiresAt: NOW + 86400,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 1 }, grantFeatures: ["tradeable-v2"], grantTokens: [] } as unknown as StoredGrant);
  const original = path.join(tmp, "original"); mkdirSync(original, { recursive: true });
  const lost = new DatabaseSync(path.join(original, "merrymen.db")); raws.push(lost); await applyLedgerSchema(wrapSqlite(lost));
  lost.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,mode,hwm_usdg,epoch) VALUES(?,?,?,4663,'{}',1,9999999999,'paper',100,2)").run(account, owner, privateKeyToAccount(key).address);
  lost.prepare("INSERT INTO events(id,agent_id,message,created_at) VALUES(40,?,'original evidence',?)").run(account, OLD);
  lost.prepare("INSERT INTO trades(id,agent_id,kind,target,amount_usdg,status,created_at,epoch) VALUES(37,?,'swap','fixture',5,'paper',?,2)").run(account, OLD);
  lost.prepare("INSERT INTO equity(id,agent_id,eth_wei,cash_usdg,vault_usdg,positions_usdg,equity_usdg,at,epoch,mode) VALUES(5,?,'0',90,0,10,100,?,2,'paper')").run(account, OLD);
  lost.prepare("INSERT INTO positions(agent_id,symbol,token,raw_balance,ui_multiplier,price_usd,value_usdg,updated_at) VALUES(?,'COIN',?,'10','1',1,10,?)").run(account, address(9), OLD);
  lost.prepare("INSERT INTO cost_basis(agent_id,mode,symbol,qty_raw,cost_usdg,updated_at) VALUES(?,'paper','COIN','10','20',?)").run(account, OLD);
  lost.prepare("INSERT INTO position_floors VALUES(?,'paper','COIN',1500,'r1','entry',?)").run(account, OLD);
  const mirrored = await mirrorTenant({ tenant, child: wrapSqlite(lost), shared }); assert.equal(mirrored.failed, undefined);
  const cursors = (await main.query("SELECT table_name,last_id,last_stamp,updated_at FROM mirror_state WHERE tenant=$1 ORDER BY table_name", [tenant])).rows;
  assert.ok(cursors.some(c => String(c.last_id) !== "0"), "the lost book left cursors behind");
  const mountPath = path.join(tmp, "volume"), homeRoot = path.join(mountPath, "fleet"); mkdirSync(homeRoot, { recursive: true });
  const st = lstatSync(mountPath, { bigint: true }), volume: LedgerImportVolume = { id: "vol_resume_pg", mountPath, homeRoot, device: String(st.dev), inode: String(st.ino) };
  const home = path.join(homeRoot, "children", tenant);
  const lock = await connect(); await lock.query("SELECT pg_advisory_lock($1::bigint)", [leaseKey(tenant).toString()]);
  const lease: TenantLease = { tenant, backend: "postgres", healthy: () => true, async release() {} };
  const options = { tenant, smartAccount: account, chainId: 4663, home, volume, shared, dek, lease };
  // The ordinary path refuses it, as it must.
  await assert.rejects(registerLedgerSource(options), /refused/);

  await t.test("a missing #259 journal arrives as 42P01 and reads as no controls; the arm applies a journal pause once", async () => {
    const scope = { tenant, smartAccount: account, chainId: 4663 };
    assert.deepEqual(await readRecoveryControls(shared, scope), { absent: true });
    await main.query(`CREATE TABLE recovery_reply_controls (bot_id TEXT NOT NULL, update_id BIGINT NOT NULL, tenant TEXT NOT NULL, smart_account TEXT NOT NULL,
      chain_id BIGINT NOT NULL, token_tag TEXT NOT NULL, claim_stamp BIGINT NOT NULL, grant_tag TEXT NOT NULL, owner_id BIGINT NOT NULL, chat_id BIGINT NOT NULL,
      kind TEXT NOT NULL, request_update_id BIGINT, message_at_sec BIGINT NOT NULL, recorded_at_ms BIGINT NOT NULL, expires_at_ms BIGINT, PRIMARY KEY(bot_id,update_id))`);
    await main.query(`INSERT INTO recovery_reply_controls VALUES ('777', 12, $1, $2, 4663, 't', 1, 'g', 5, 5, 'pause', NULL, $3, $4, NULL)`, [tenant, account, NOW - 60, (NOW - 60) * 1000]);
    const armHome = path.join(tmp, "arm-home");
    const first = await armOwnerControls({ scope, home: armHome, shared, mayWrite: () => true, forwardKill: async () => "none" });
    assert.deepEqual(first, { ok: true, paused: true, applied: ["pause 777:12"] });
    assert.ok(existsSync(path.join(armHome, "paused")));
    assert.ok((await readDurablePause(shared, tenant))! > 0, "paused_at, added by its ALTER, holds the stamp");
    const again = await armOwnerControls({ scope, home: armHome, shared, mayWrite: () => true, forwardKill: async () => "none" });
    assert.deepEqual(again.ok && again.applied, []);
    assert.equal(Number((await main.query("SELECT count(*) AS n FROM recovery_reply_control_receipts")).rows[0]!.n), 1);
    // The owner's /resume, mirrored (events' BIGINT id and created_at come back
    // as strings here), then the home lost with no arm in between: the rebuilt
    // home is not paused again, and the stamp is lifted.
    const stamp = (await readDurablePause(shared, tenant))!;
    rmSync(path.join(armHome, "paused"));
    await main.query("INSERT INTO events (agent_id, level, message, created_at) VALUES ($1, 'warn', 'Telegram: resumed by chat 5', $2)", [account, stamp + 1]);
    rmSync(armHome, { recursive: true, force: true });
    const rebuilt = await armOwnerControls({ scope, home: armHome, shared, mayWrite: () => true, forwardKill: async () => "none" });
    assert.deepEqual(rebuilt, { ok: true, paused: false, applied: [] });
    assert.equal(await readDurablePause(shared, tenant), null);
  });

  await t.test("approvals: one open per tenant, enforced by the index as well as the code", async () => {
    await ensureLedgerResumeSchema(shared);
    const controls = await readControlsEvidence(shared, { tenant, smartAccount: account, chainId: 4663 }, Date.now());
    const { evidence, digest, check } = await readResumeEvidence(shared, { tenant, grant: { smartAccount: account, chainId: 4663, owner }, home, nowSec: NOW, controls });
    assert.deepEqual(check.refusals, []);
    const entry: PreviewEntry = { tenant, account, chainId: 4663, owner, digest, pass: true, refusals: [], chain: "not-required", suggestedLevel: "trade",
      anchor: check.anchor, riskPeriod: check.riskPeriod, home: "absent", lastMirrorAt: check.lastMirrorAt,
      holdsPositions: check.holdsPositions, startsPaused: false, grantExpiresAt: NOW + 86400, book: "absent", evidence };
    const run = await recordPreviewRun(shared, [entry], Date.now());
    assert.equal(await applyResumeApprovals(shared, [{ kind: "run", run }], Date.now(), () => {}), 1);
    await assert.rejects(main.query(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run,
      state, created_at_ms, updated_at_ms) VALUES ('x', $1, $2, 4663, $3, $4, '{}', 'r', 'approved', 1, 1)`, [tenant, account, owner, "f".repeat(64)]), /duplicate key|unique/);
  });

  await t.test("registration in one transaction; then the ordinary gates and a real mirror pass accept the attested book", async () => {
    const approval = (await readOpenApproval(shared, tenant))!;
    const generation = "00000000-0000-4000-8000-00000000c0de";
    assert.ok(await moveApproval(shared, approval.approvalId, "approved", "archiving", { generation }));
    assert.ok(await moveApproval(shared, approval.approvalId, "archiving", "archived", { archivePath: null }));
    const before = (await main.query("SELECT * FROM cost_basis WHERE lower(agent_id)=$1", [account])).rows;
    const r = await registerAttestedGapSource({ ...options, owner, approvalId: approval.approvalId, evidenceDigest: approval.evidenceDigest, generation,
      archivePath: null, gapFromSec: OLD, dialect: "postgres", chainRead: { fromBlock: "100", head: "250" }, recheck: async () => {} });
    assert.equal(r.generation, generation);
    // The chain window, as text, through the additive ALTER Postgres runs as ADD COLUMN IF NOT EXISTS on every ensure.
    assert.deepEqual((await main.query("SELECT chain_from_block, chain_head FROM ledger_resume_attestations WHERE generation=$1", [generation])).rows[0],
      { chain_from_block: "100", chain_head: "250" });
    assert.equal((await main.query("SELECT count(*) AS n FROM mirror_state WHERE tenant=$1", [tenant])).rows[0]!.n, "0");
    const archived = (await main.query("SELECT table_name,last_id,last_stamp,updated_at FROM mirror_state_archive WHERE generation=$1 ORDER BY table_name", [generation])).rows;
    assert.deepEqual(archived.map(a => [a.table_name, String(a.last_id)]), cursors.map(c => [c.table_name, String(c.last_id)]));
    assert.equal((await main.query("SELECT state FROM ledger_resume_approvals WHERE approval_id=$1", [approval.approvalId])).rows[0]!.state, "registered");
    // The already-admitted join, in the production dialect: this account's attested source, and no other account's.
    assert.equal(await attestedSourceInUse(shared, tenant, account), generation);
    assert.equal(await attestedSourceInUse(shared, tenant, address(0x99999)), null);
    // The attested seed's plan reads Postgres as the seeds do: this book's basis is paper, so nothing live to prove.
    assert.deepEqual(await planAttestedSeed(shared, account), { basis: [], floors: [] });
    // The ordinary path, unchanged, takes it from here.
    assert.equal(await restoreLedgerImport(options), "present");
    await registerLedgerSource(options);
    // A first spawn refused after its seeds leaves the restored practice book
    // and no agent row. The next pass's gates accept it for this registration
    // only (to_regclass and FOR SHARE in the production dialect), and refuse it
    // once its approval is withdrawn.
    const seeded = new DatabaseSync(path.join(home, "merrymen.db"));
    try { seeded.prepare("INSERT INTO paper_book(agent_id,cash_usdg,vault_usdg,hwm_usdg,shares,updated_at) VALUES(?,90,0,100,'{}',1)").run(account); }
    finally { seeded.close(); }
    assert.equal(await restoreLedgerImport(options), "present");
    await registerLedgerSource(options);
    await main.query("UPDATE ledger_resume_approvals SET state='revoked' WHERE approval_id=$1", [approval.approvalId]);
    await assert.rejects(restoreLedgerImport(options), /refused/);
    await assert.rejects(registerLedgerSource(options), /refused/);
    await main.query("UPDATE ledger_resume_approvals SET state='registered' WHERE approval_id=$1", [approval.approvalId]);
    const unseed = new DatabaseSync(path.join(home, "merrymen.db"));
    try { unseed.prepare("DELETE FROM paper_book").run(); } finally { unseed.close(); }
    const book = new DatabaseSync(path.join(home, "merrymen.db")); raws.push(book);
    await assertLedgerSourceContinuity(wrapSqlite(book), shared, tenant);
    // The child arms, seeded; its first mirror pass.
    book.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,mode,hwm_usdg,epoch) VALUES(?,?,?,4663,'{}',1,9999999999,'paper',0,1)").run(account, owner, privateKeyToAccount(key).address);
    book.prepare("INSERT INTO cost_basis(agent_id,mode,symbol,qty_raw,cost_usdg,updated_at) VALUES(?,'paper','COIN','10','20',?)").run(account, OLD);
    const pass = await mirrorTenant({ tenant, child: wrapSqlite(book), shared });
    assert.equal(pass.restarted, undefined); assert.equal(pass.failed, undefined);
    const after = (await main.query("SELECT * FROM cost_basis WHERE lower(agent_id)=$1", [account])).rows;
    assert.deepEqual(after, before, "the seeded basis is what Postgres holds after the first pass");
    const agent = (await main.query("SELECT epoch, hwm_usdg FROM agents WHERE lower(smart_account)=$1", [account])).rows[0]!;
    assert.deepEqual([String(agent.epoch), Number(agent.hwm_usdg)], ["2", 100], "the ratchets hold: same epoch, same peak");
    assert.equal(Number((await main.query("SELECT count(*) AS n FROM trades WHERE lower(agent_id)=$1", [account])).rows[0]!.n), 1, "no trade copied twice");
  });

  await t.test("MERRYMEN_RESUME_AUTO_PAPER in the production dialect: the source column's ALTER, the roster's write stamp, the watch, the verdict's reads", async () => {
    // Production's approvals table predates `source`: the ALTER adds it, and a row from before reads as the operator's.
    await main.query("ALTER TABLE ledger_resume_approvals DROP COLUMN source");
    await ensureLedgerResumeSchema(shared);
    await ensureLedgerResumeSchema(shared);
    assert.equal((await readOpenApproval(shared, tenant))!.source, "operator");
    // The roster carries each record's server stamp, which a re-sign moves.
    const listed = (await grants.listTenantExpiries()).find((r) => r.tenant === tenant)!;
    assert.equal(typeof listed.updatedAt, "number");
    // The watch: a baseline in one transaction, then owed (BIGINT `owed` comes back as a string here) until settled for that key.
    const roster = [{ tenant, key: grantRowKey(listed) }];
    assert.deepEqual(await observeGrantChanges(shared, roster, 1), { baselined: 1, owed: [] });
    assert.deepEqual(await observeGrantChanges(shared, roster, 2), { baselined: null, owed: [] });
    const moved = [{ tenant, key: grantRowKey({ ...listed, expiresAt: (listed.expiresAt ?? 0) + 1 }) }];
    const { owed } = await observeGrantChanges(shared, moved, 3);
    assert.deepEqual(owed, moved);
    assert.deepEqual((await observeGrantChanges(shared, moved, 4)).owed, moved, "still owed");
    assert.equal(await settleGrantChange(shared, owed[0]!, { outcome: "previewed: x", run: null }, 5), true);
    assert.equal(await settleGrantChange(shared, owed[0]!, { outcome: "previewed: x", run: null }, 6), false, "settled once");
    // The verdict's reads (agent_commands, the live book rows, the approvals by state) run here: this tenant has its approval open.
    const controls = await readControlsEvidence(shared, { tenant, smartAccount: account, chainId: 4663 }, Date.now());
    const { evidence, digest } = await readResumeEvidence(shared, { tenant, grant: { smartAccount: account, chainId: 4663, owner }, home, nowSec: NOW, controls });
    const entry: PreviewEntry = { tenant, account, chainId: 4663, owner, digest, pass: true, refusals: [], chain: "not-required", suggestedLevel: "trade",
      anchor: null, riskPeriod: null, home: "present", lastMirrorAt: null, holdsPositions: false, startsPaused: false, grantExpiresAt: NOW + 86400, book: "blocked", evidence };
    const verdict = await autoPaperVerdict(shared, entry, { consentEnforced: true });
    assert.equal(verdict.kind, "manual");
    assert.match((verdict as { why: string[] }).why.join(" "), /approval is already open/);
    // An automatic approval of another tenant, through the operator's insert, says so in its row.
    const other = address(0xabc02);
    const recorded = await recordResumeApproval(shared, { entry: { ...entry, tenant: other, digest: "a".repeat(64) }, run: "b".repeat(64), at: Date.now(), nowMs: Date.now(), source: "auto-paper" }, () => {});
    assert.deepEqual(recorded, { recorded: true });
    assert.equal((await main.query("SELECT source FROM ledger_resume_approvals WHERE tenant=$1", [other])).rows[0]!.source, "auto-paper");
    assert.equal(await countOpenApprovals(shared), 2, "this tenant's registered approval and the new one");
  });

  await t.test("the review fixes in the production dialect: turn order from BIGINT stamps, drift that throws, a failed controls read told apart", async () => {
    // Turn order: never tried, then the least recently tried, then the longest owed — with the stamps as strings.
    const [a, b, c] = [address(0xabd01), address(0xabd02), address(0xabd03)];
    const k = (who: string) => ({ tenant: who, key: grantRowKey({ tenant: who, expiresAt: NOW + 10, updatedAt: NOW }) });
    await observeGrantChanges(shared, [k(a), k(b)], 10);
    let owed = (await observeGrantChanges(shared, [k(c), k(b), k(a)], 20)).owed;
    assert.deepEqual(owed.map((o) => o.tenant), [b, a, c], "a and b owed since the first pass, in roster order between them; c since now");
    await noteGrantAttempt(shared, owed[0]!, 30);
    await noteGrantAttempt(shared, owed[1]!, 31);
    assert.equal(typeof (await main.query("SELECT attempted_at_ms FROM ledger_resume_grant_watch WHERE tenant=$1", [b])).rows[0]!.attempted_at_ms, "string", "BIGINT, as Postgres returns it");
    owed = (await observeGrantChanges(shared, [k(a), k(b), k(c)], 40)).owed;
    assert.deepEqual(owed.map((o) => o.tenant), [c, b, a]);
    // A missing column is 42703, whose message also says "does not exist": drift throws, never reads as no open command.
    const controls = await readControlsEvidence(shared, { tenant, smartAccount: account, chainId: 4663 }, Date.now());
    assert.equal(controls.failed, false);
    const { evidence, digest } = await readResumeEvidence(shared, { tenant, grant: { smartAccount: account, chainId: 4663, owner }, home, nowSec: NOW, controls });
    const entry: PreviewEntry = { tenant, account, chainId: 4663, owner, digest, pass: true, refusals: [], chain: "not-required", suggestedLevel: "trade",
      anchor: null, riskPeriod: null, home: "present", lastMirrorAt: null, holdsPositions: false, startsPaused: false, grantExpiresAt: NOW + 86400, book: "blocked", evidence };
    await main.query("ALTER TABLE agent_commands DROP COLUMN done_at");
    try {
      await assert.rejects(autoPaperVerdict(shared, entry, { consentEnforced: true }), (e: { code?: unknown }) => e.code === "42703");
    } finally { await main.query("ALTER TABLE agent_commands ADD COLUMN done_at BIGINT"); }
    assert.equal((await autoPaperVerdict(shared, entry, { consentEnforced: true })).kind, "manual", "restored, it reads again");
    // A controls read that fails (the store refuses) is `failed`, an outage the admission holds on.
    const refusing: Db = { ...shared, prepare: (sql: string) => /recovery_reply_controls/.test(sql)
      ? { run: async () => { throw new Error("x"); }, get: async () => { throw new Error("x"); }, all: async () => { throw Object.assign(new Error("terminating connection"), { code: "57P01" }); } }
      : shared.prepare(sql) };
    const failed = await readControlsEvidence(refusing, { tenant, smartAccount: account, chainId: 4663 }, Date.now());
    assert.deepEqual([failed.readable, failed.failed, failed.digest], [false, true, "unreadable"]);
  });

  await t.test("an approval insert the production store gives up on is transient; the table's own uniqueness is final", async () => {
    const controls = await readControlsEvidence(shared, { tenant, smartAccount: account, chainId: 4663 }, Date.now());
    const { evidence } = await readResumeEvidence(shared, { tenant, grant: { smartAccount: account, chainId: 4663, owner }, home, nowSec: NOW, controls });
    const entryFor = (who: `0x${string}`, digest: string): PreviewEntry => ({ tenant: who, account, chainId: 4663, owner, digest, pass: true, refusals: [], chain: "not-required",
      suggestedLevel: "trade", anchor: null, riskPeriod: null, home: "present", lastMirrorAt: null, holdsPositions: false, startsPaused: false, grantExpiresAt: NOW + 86400,
      book: "blocked", evidence });
    const record = (db: Db, entry: PreviewEntry) => recordResumeApproval(db, { entry, run: "e".repeat(64), at: Date.now(), nowMs: Date.now(), source: "auto-paper" }, () => {});
    // A real statement timeout: another session holds the table in SHARE mode, which lets the checks read and makes the insert wait.
    const slow = address(0xabf01), blocker = await connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE ledger_resume_approvals IN SHARE MODE");
    await main.query("SET statement_timeout = 300");
    try {
      assert.deepEqual(await record(shared, entryFor(slow, "1".repeat(64))), { recorded: false, why: "the store could not be reached or gave up (57014)", transient: true });
    } finally { await main.query("SET statement_timeout = 10000"); await blocker.query("ROLLBACK"); }
    assert.equal((await main.query("SELECT 1 FROM ledger_resume_approvals WHERE tenant=$1", [slow])).rowCount, 0, "nothing recorded");
    assert.deepEqual(await record(shared, entryFor(slow, "1".repeat(64))), { recorded: true }, "asked again once the store answers, it is recorded");
    // A real unique violation (23505): another replica's approval of the same evidence lands between the checks and the insert.
    const raced = address(0xabf02), won = "00000000-0000-4000-8000-0000000000a2";
    const racing: Db = { ...shared, prepare: (sql: string) => {
      const stmt = shared.prepare(sql);
      return /INSERT INTO ledger_resume_approvals/.test(sql) ? { ...stmt, run: async (...args: unknown[]) => { await stmt.run(won, ...args.slice(1)); return stmt.run(...args); } } : stmt;
    } };
    assert.deepEqual(await record(racing, entryFor(raced, "2".repeat(64))), { recorded: false, why: "the store refused the approval" }, "final: never asked again");
    assert.equal((await readOpenApproval(shared, raced))!.approvalId, won);
  });
});
