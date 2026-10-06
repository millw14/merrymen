/**
 * AUTOMATIC ADMISSION OF RE-SIGNED PAPER TENANTS (MERRYMEN_RESUME_AUTO_PAPER)
 * THROUGH THE REAL SPAWN PATH.
 *
 * The situation it is for: a pre-incident tenant whose grant expired during
 * the hold. Postgres holds its history and its lost book's cursors, and its
 * home on the persistent volume holds a blocked, non-continuous book, so the
 * continuity gate holds it — after its owner re-signs too — until it is
 * previewed and approved. With the variable on, the re-sign itself is
 * previewed by the orchestrator, and a paper tenant that could not arm live
 * and holds nothing is approved by it and admitted through the unchanged
 * attested-gap path in the same pass. Everything else is as before.
 *
 * The harness is orchestrator-ledger-resume.integration.test.ts's: the volume
 * proof, the lease and the chain are test seams; the grant store is the real
 * file store; the shared database is real sqlite with the ledger schema.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import type { TenantLease } from "./tenant-lease";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-resume-auto-paper-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_RESUME_AUTO_PAPER;
delete process.env.MERRYMEN_FLEET_ROLLOUT;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 29).toString("base64");

const orch = await import("./orchestrator");
const { childHome, reconcile, setSpawnForTest, setRetirementMemoryStoreForTest, setPaperRestoreForTest, setPersistentHomeVerifierForTest,
  setLeaseAcquireForTest, setResumeChainForTest, setKillConfirmForTest, setBasisSeedSharedForTest, setPhantomProcessesForTest, runResumeAdmissionControlsForTest } = orch;
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore } = await import("./settings-store");
const { recordResumeApproval } = await import("./ledger-resume");

const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw), dek = Buffer.alloc(32, 29);
await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL); await shared.exec(PAPER_CHECKPOINT_SCHEMA);
raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY,grant_json TEXT NOT NULL,updated_at INTEGER NOT NULL,row_version INTEGER NOT NULL)");
const volumeStat = lstatSync(fleet, { bigint: true });
setPersistentHomeVerifierForTest(() => ({ id: "vol_resume_auto_paper", mountPath: fleet, homeRoot: fleet, device: String(volumeStat.dev), inode: String(volumeStat.ino) }));
setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
setBasisSeedSharedForTest(shared);
setPaperRestoreForTest(async () => ({ ok: true, line: null }));
setKillConfirmForTest(async () => {});
// The automatic lane never reads the chain: any attempt fails the test that makes it.
let chainReads = 0;
setResumeChainForTest(() => { chainReads += 1; throw new Error("an automatic approval must never need a chain read"); });
const unhealthy = new Set<string>();
/** Run whenever the tenant's lease is asked whether it still holds: the archive asks before every write, so a test can act in the middle of one. */
const onLeaseCheck = new Map<string, () => void>();
setLeaseAcquireForTest(async (tenant) => ({ tenant, backend: "postgres", healthy: () => { onLeaseCheck.get(tenant)?.(); return !unhealthy.has(tenant); }, async release() {} }) as TenantLease);
// A read of the owner-control journal that fails while set: an outage of one read, never a fact about the tenant.
let controlsReadFails = false;
/**
 * The approval's insert, while set: `outage` fails it with that SQLSTATE (the
 * store gave the statement up), and `raced` first records another replica's
 * approval of the same evidence, so the insert meets the table's own
 * uniqueness — once.
 */
let approvalInsert: { outage: string } | "raced" | null = null;
const anotherReplica = randomUUID();
const realPrepare = shared.prepare.bind(shared);
(shared as { prepare: typeof shared.prepare }).prepare = (sql: string) => {
  if (controlsReadFails && /FROM recovery_reply_controls/.test(sql)) throw Object.assign(new Error("connection reset"), { code: "08006" });
  if (approvalInsert && /INSERT INTO ledger_resume_approvals/.test(sql)) {
    if (approvalInsert !== "raced") throw Object.assign(new Error("canceling statement due to statement timeout"), { code: approvalInsert.outage });
    approvalInsert = null;
    const stmt = realPrepare(sql);
    return { get: stmt.get.bind(stmt), all: stmt.all.bind(stmt), run: async (...args: unknown[]) => { await stmt.run(anotherReplica, ...args.slice(1)); return stmt.run(...args); } };
  }
  return realPrepare(sql);
};
// What the orchestrator says, without its prefix. MERRYMEN_TEST_VERBOSE=1 prints it as well.
const lines: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => {
  const line = a.map(String).join(" ");
  lines.push(line.replace(/^\[orchestrator\] /, ""));
  if (process.env.MERRYMEN_TEST_VERBOSE === "1") realLog(line);
};

class FakeProc extends EventEmitter {
  readonly stdout = null; readonly stderr = null;
  constructor(readonly pid: number) { super(); }
  kill() { setImmediate(() => this.emit("exit", 0, "SIGTERM")); return true; }
}
const forks: Array<{ home: string; level: string | undefined; grant: boolean }> = [];
setSpawnForTest((_c, _a, options) => {
  const home = String(options.env?.MERRYMEN_HOME);
  forks.push({ home, level: options.env?.MERRYMEN_ADMISSION_LEVEL, grant: existsSync(path.join(home, "grant.json")) });
  return new FakeProc(70_000 + forks.length) as unknown as ChildProcess;
});

after(() => {
  setRetirementMemoryStoreForTest(null); setPaperRestoreForTest(null); setPersistentHomeVerifierForTest(null); setLeaseAcquireForTest(null); setResumeChainForTest(null);
  setBasisSeedSharedForTest(null); setPhantomProcessesForTest(0); console.log = realLog;
  delete process.env.MERRYMEN_RESUME_AUTO_PAPER; delete process.env.MERRYMEN_FLEET_ROLLOUT;
  raw.close(); rmSync(fleet, { recursive: true, force: true });
});

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const OLD = nowSec() - 5 * 86_400;
let signatures = 0;
/** A signature: each its own expiry, as every real one is (grantedAt plus its days). */
const grant = (account: `0x${string}`, owner: `0x${string}`, o: { expired?: boolean } = {}): StoredGrant => {
  signatures += 1;
  return {
    smartAccount: account, owner, sessionKeyAddress: addr(0x5e5), serialized: `fixture-auto-${account}-${signatures}`,
    chainId: 4663, grantedAt: nowSec() - 60, expiresAt: o.expired ? nowSec() - 3_600 - signatures : nowSec() + 86_400 + signatures,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
    grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${"cd".repeat(32)}`,
  } as unknown as StoredGrant;
};
async function putGrant(tenant: `0x${string}`, g: StoredGrant) {
  await getGrantStore().put(tenant, g);
  raw.prepare("INSERT INTO grants VALUES (?, ?, ?, 1) ON CONFLICT (tenant) DO UPDATE SET grant_json = excluded.grant_json, updated_at = excluded.updated_at, row_version = grants.row_version + 1")
    .run(tenant, JSON.stringify({ smartAccount: g.smartAccount, owner: g.owner, chainId: g.chainId }), nowSec());
}

let seq = 0;
/**
 * One pre-incident tenant, held by the continuity gate: its Postgres history
 * and cursors, its blocked home on the volume, and its grant (expired unless
 * said). Paper and holding nothing unless `live`: then a landed operation, a
 * deposit, a token balance and its live basis and floor.
 */
async function preIncident(o: { live?: boolean; expired?: boolean } = {}) {
  seq += 1;
  const tenant = addr(0xc00000 + seq), account = addr(0xcac000 + seq), owner = addr(0xd00000 + seq);
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 2, 120, ?)`).run(account, owner, addr(1), o.live ? "live" : "paper");
  raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, user_op_hash, tx_hash, epoch)
    VALUES (?, 'swap', 'x', 5, ?, ?, ?, ?, 2)`).run(account, o.live ? "landed" : "paper", OLD, o.live ? `0x${"0".repeat(60)}${seq.toString(16).padStart(4, "0")}` : null, o.live ? `0xt${seq}` : null);
  raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 100, 0, 0, 100, ?, 2, ?)")
    .run(account, OLD, o.live ? "live" : "paper");
  if (o.live) {
    raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, at, epoch, chain_id)
      VALUES (?, 'in', 100, ?, 10, 3, 'deposit', ?, 2, 4663)`).run(account, `0xd${seq}`, OLD);
    raw.prepare("INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at) VALUES (?, 'COIN', ?, '10', '1', 1, 0, 'pool', 10, ?)").run(account, addr(5), OLD);
    raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'COIN', '10', '20', ?)").run(account, OLD);
    raw.prepare("INSERT INTO position_floors VALUES (?, 'live', 'COIN', 1500, 'r1', 'entry', ?)").run(account, OLD);
  }
  for (const [table, id] of [["trades", 40], ["events", 90], ["equity", 12]] as const) {
    raw.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, ?, ?, ?, ?)").run(tenant, table, id, OLD, nowSec() - 40 * 3600);
  }
  const home = childHome(tenant); mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const [name, body] of [["ledger-source-blocked.json", '{"version":1,"state":"missing-live-source"}'], ["telegram.json", '{"offset":5}']] as const) {
    writeFileSync(path.join(home, name), body, { mode: 0o600 });
  }
  const stale = new DatabaseSync(path.join(home, "merrymen.db")); stale.exec("CREATE TABLE junk (x); INSERT INTO junk VALUES (1)"); stale.close();
  await putGrant(tenant, grant(account, owner, { expired: o.expired ?? true }));
  /** The owner signs again: a new expiry, a new server stamp, the same account. */
  const resign = () => putGrant(tenant, grant(account, owner));
  return { tenant, account, owner, home, resign };
}
const rows = (sql: string, ...args: unknown[]) => (raw.prepare(sql).all(...(args as never[])) as Array<Record<string, unknown>>).map((r) => ({ ...r }));
const approvals = (tenant: string) => rows("SELECT state, source, reason, preview_run FROM ledger_resume_approvals WHERE tenant = ? ORDER BY created_at_ms, rowid", tenant);
const watch = (tenant: string) => rows("SELECT owed, outcome, run FROM ledger_resume_grant_watch WHERE tenant = ?", tenant)[0];
const forksOf = (tenant: string) => forks.filter((f) => f.home === childHome(tenant));
const table = (name: string) => rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;
const settingsFile = (tenant: string) => path.join(fleet, "tenant-settings", `${tenant}.json`);
/** The owner's settings with live trading switched on, sealed as the store writes them — but not stored yet: written by the test when it chooses. */
async function liveSettingsFor(tenant: `0x${string}`): Promise<Buffer> {
  await getSettingsStore().put(tenant, { liveTradingEnabled: true } as never);
  const sealed = readFileSync(settingsFile(tenant));
  rmSync(settingsFile(tenant));
  return sealed;
}
async function pass() { await reconcile(); await new Promise((r) => setTimeout(r, 20)); }
async function cleanUp(...tenants: string[]) {
  for (const t of tenants) await getGrantStore().remove(t as `0x${string}`);
  await pass();
}

it("off (unset): a re-signed pre-incident paper tenant is held exactly as before — nothing previewed, approved, watched or admitted", async () => {
  const t = await preIncident();
  await pass();
  await t.resign();
  await pass(); await pass();
  assert.equal(forksOf(t.tenant).length, 0, "the continuity gate holds it, as it always has");
  assert.equal(table("ledger_resume_grant_watch"), false, "nothing watched: not even the table");
  assert.equal(table("ledger_resume_approvals"), false, "nothing approved");
  assert.equal(table("ledger_resume_preview_runs"), false, "nothing previewed");
  assert.ok(existsSync(path.join(t.home, "ledger-source-blocked.json")), "its home untouched");
  await cleanUp(t.tenant);
});

it("on: the roster as it stands is nobody's re-sign; a re-signed paper tenant is previewed, self-approved and admitted in one pass", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    // Signed and held before the variable was on: baselined, not admitted.
    const standing = await preIncident({ expired: false });
    const t = await preIncident();
    await pass();
    assert.match(lines.join("\n"), /resume auto-paper: on — \d+ grant row\(s\) recorded as they stand/);
    assert.deepEqual(watch(standing.tenant), { owed: 0, outcome: "baseline", run: null });
    await pass();
    assert.equal(forksOf(standing.tenant).length, 0, "turning the variable on admits nobody by itself");
    assert.equal(forksOf(t.tenant).length, 0);

    await t.resign();
    await pass();
    const [a] = approvals(t.tenant);
    assert.deepEqual({ state: a?.state, source: a?.source }, { state: "applied", source: "auto-paper" }, "approved by the orchestrator, and applied");
    const fork = forksOf(t.tenant);
    assert.equal(fork.length, 1, "one worker");
    assert.deepEqual({ level: fork[0]!.level, grant: fork[0]!.grant }, { level: "trade", grant: true }, "at the rollout's level: unset off Railway is all, so trade");
    // The same receipts and attestation as an operator's approval.
    const attested = rows("SELECT approval_id, chain_from_block, chain_head FROM ledger_resume_attestations WHERE tenant = ?", t.tenant);
    assert.equal(attested.length, 1);
    assert.deepEqual([attested[0]!.chain_from_block, attested[0]!.chain_head], [null, null], "a paper tenant: no chain window, none needed");
    assert.equal(rows("SELECT * FROM tenant_ledger_import WHERE tenant = ? AND state = 'consumed'", t.tenant).length, 1, "its book registered");
    assert.equal(readdirSync(path.join(fleet, "archive", t.tenant)).length, 1, "its old home archived");
    // The preview it approved from is on record, as any run is, and the watch says what it came to.
    const run = rows("SELECT run, entries_json FROM ledger_resume_preview_runs WHERE run = ?", a!.preview_run)[0]!;
    const entries = JSON.parse(String(run.entries_json)) as Array<{ tenant: string; pass: boolean; chain: string }>;
    assert.deepEqual(entries.map((e) => [e.tenant, e.pass, e.chain]), [[t.tenant, true, "not-required"]]);
    assert.deepEqual(watch(t.tenant), { owed: 0, outcome: "auto-approved", run: a!.preview_run });
    assert.match(lines.join("\n"), new RegExp(`resume auto-paper: ${t.tenant} self-approved .* its admission starts this pass, at trade`));
    assert.equal(chainReads, 0);
    // The one baselined is still held: its grant row never changed.
    assert.equal(forksOf(standing.tenant).length, 0);
    assert.equal(approvals(standing.tenant).length, 0);
    await cleanUp(t.tenant, standing.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; }
});

it("on: a re-signed live tenant is previewed and left to the operator — never approved, never read on chain by this lane", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    const t = await preIncident({ live: true });
    await pass();
    await t.resign();
    await pass(); await pass();
    assert.deepEqual(approvals(t.tenant), [], "no approval");
    assert.equal(forksOf(t.tenant).length, 0);
    assert.equal(chainReads, 0, "nothing read on chain");
    const w = watch(t.tenant)!;
    assert.equal(w.owed, 0, "answered once: not previewed every pass");
    assert.match(String(w.outcome), /^previewed: .*could arm live \(chain:required\)/);
    const run = rows("SELECT entries_json FROM ledger_resume_preview_runs WHERE run = ?", w.run)[0]!;
    const [entry] = JSON.parse(String(run.entries_json)) as Array<{ pass: boolean; chain: string; digest: string }>;
    assert.deepEqual([entry!.pass, entry!.chain], [true, "required"]);
    assert.ok(lines.some((l) => l.includes(`approve it by hand: MERRYMEN_RESUME_APPROVE=${t.tenant}:${entry!.digest}`)), "the operator is told the exact approval");
    assert.ok(existsSync(path.join(t.home, "ledger-source-blocked.json")), "its home untouched");
    await cleanUp(t.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; }
});

it("on: evidence that changes between the automatic approval and the archive refuses it, and nothing re-approves it until the owner signs again", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    const t = await preIncident();
    await pass();
    // Its lease cannot be held this pass: the approval is recorded, and Phase A waits.
    unhealthy.add(t.tenant);
    await t.resign();
    try { await pass(); } finally { unhealthy.delete(t.tenant); }
    assert.deepEqual(approvals(t.tenant).map((a) => [a.state, a.source]), [["approved", "auto-paper"]]);
    // Something lands in its books after the preview the approval binds.
    raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 1, 0, 0, 1, ?, 2, 'paper')").run(t.account, OLD + 9);
    await pass();
    const [refused] = approvals(t.tenant);
    assert.equal(refused!.state, "refused");
    assert.match(String(refused!.reason), /evidence changed/);
    assert.equal(forksOf(t.tenant).length, 0);
    assert.ok(existsSync(path.join(t.home, "ledger-source-blocked.json")), "refused before anything moved");
    await pass(); await pass();
    assert.equal(approvals(t.tenant).length, 1, "not approved again on its own: the change it was owed is answered");
    // The owner signs again: a fresh preview, of the evidence as it is now, admits it.
    await t.resign();
    await pass();
    assert.deepEqual(approvals(t.tenant).map((a) => [a.state, a.source]), [["refused", "auto-paper"], ["applied", "auto-paper"]]);
    assert.equal(forksOf(t.tenant).length, 1);
    await cleanUp(t.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; }
});

it("on: under an explicit rollout a re-signed tenant waits, owed, until it is named, and is admitted at the level it is named at", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  const other = addr(0xfff001);
  process.env.MERRYMEN_FLEET_ROLLOUT = `${other}:trade`;
  try {
    const t = await preIncident();
    await pass();
    await t.resign();
    await pass(); await pass();
    assert.equal(table("ledger_resume_approvals") ? approvals(t.tenant).length : 0, 0, "not named: nothing approved");
    assert.equal(watch(t.tenant)!.owed, 1, "still owed its preview");
    assert.equal(forksOf(t.tenant).length, 0);
    process.env.MERRYMEN_FLEET_ROLLOUT = `${other}:trade,${t.tenant}:exits-only`;
    await pass();
    assert.deepEqual(approvals(t.tenant).map((a) => [a.state, a.source]), [["applied", "auto-paper"]]);
    assert.deepEqual(forksOf(t.tenant).map((f) => f.level), ["exits-only"], "the level the rollout names, not trade");
    await cleanUp(t.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; delete process.env.MERRYMEN_FLEET_ROLLOUT; }
});

it("on: no automatic admission past the process cap less its headroom, and at most two a pass", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    const ts = [await preIncident(), await preIncident(), await preIncident()];
    await pass();
    for (const t of ts) await t.resign();
    // The fleet stands at the cap less its headroom: nothing is previewed or approved, and each stays owed.
    setPhantomProcessesForTest(40);
    try {
      const before = lines.length;
      await pass(); await pass();
      for (const t of ts) {
        assert.equal(approvals(t.tenant).length, 0);
        assert.equal(watch(t.tenant)!.owed, 1);
        assert.equal(forksOf(t.tenant).length, 0);
      }
      const said = lines.slice(before).filter((l) => /re-signed tenant\(s\) wait for a process slot/.test(l));
      assert.equal(said.length, 1, "said once, not every pass");
      assert.match(said[0]!, /^\[alert\] resume auto-paper: 3 re-signed tenant\(s\) wait/);
    } finally { setPhantomProcessesForTest(0); }
    // A slot frees: two a pass, the third on the next.
    await pass();
    const admitted = ts.filter((t) => forksOf(t.tenant).length === 1);
    assert.equal(admitted.length, 2, "two this pass");
    assert.deepEqual(ts.map((t) => watch(t.tenant)!.owed).sort(), [0, 0, 1]);
    await pass();
    assert.deepEqual(ts.map((t) => forksOf(t.tenant).length), [1, 1, 1], "and the third on the next");
    assert.ok(ts.every((t) => approvals(t.tenant)[0]?.source === "auto-paper"));
    await cleanUp(...ts.map((t) => t.tenant));
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; setPhantomProcessesForTest(0); }
});

it("on: a re-sign whose preview cannot be read stays owed, and is answered once it can be", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    const t = await preIncident();
    await pass();
    // The owner's settings cannot be read: whether it could arm live is unknown.
    mkdirSync(path.dirname(settingsFile(t.tenant)), { recursive: true });
    writeFileSync(settingsFile(t.tenant), "{ not json", { mode: 0o600 });
    await t.resign();
    await pass(); await pass();
    assert.equal(approvals(t.tenant).length, 0);
    assert.equal(watch(t.tenant)!.owed, 1, "an outage is not an answer: still owed");
    assert.ok(lines.some((l) => l.includes(`${t.tenant}: resume auto-paper could not read it`)));
    rmSync(settingsFile(t.tenant));
    await pass();
    assert.deepEqual(approvals(t.tenant).map((a) => [a.state, a.source]), [["applied", "auto-paper"]]);
    assert.equal(forksOf(t.tenant).length, 1);
    await cleanUp(t.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; }
});

it("on: a re-sign the gate does not hold — a running worker, or a new account with no history — is settled with nothing approved", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    // An admitted paper tenant renews while its worker runs.
    const t = await preIncident();
    await pass();
    await t.resign();
    await pass();
    assert.equal(forksOf(t.tenant).length, 1);
    await t.resign();
    await pass();
    assert.match(String(watch(t.tenant)!.outcome), /^not-held: a worker/);
    assert.equal(approvals(t.tenant).length, 1, "no second approval for a running tenant");
    // A brand-new tenant: a new grant row, nothing on record anywhere.
    seq += 1;
    const fresh = addr(0xc00000 + seq);
    await putGrant(fresh, grant(addr(0xcac000 + seq), addr(0xd00000 + seq)));
    await pass();
    assert.match(String(watch(fresh)?.outcome), /^not-held: no history on record/);
    assert.equal(approvals(fresh).length, 0, "the ordinary path's, which needs no approval");
    // And no preview run for it: runs are the held tenants', never every signup's, so an
    // operator's own preview is not crowded out of the runs an approval is looked up in.
    assert.equal(watch(fresh)!.run, null);
    assert.equal(rows("SELECT run FROM ledger_resume_preview_runs WHERE entries_json LIKE ?", `%${fresh}%`).length, 0);
    await cleanUp(t.tenant, fresh);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; }
});

it("on, with live-trading consent stood down: a re-signed paper tenant reads as able to arm live, and is previewed and left to the operator — never approved, never read on chain", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  process.env.MERRYMEN_LIVE_INTENT_STAND_DOWN = "1";
  try {
    const t = await preIncident();
    await pass();
    await t.resign();
    await pass(); await pass();
    assert.deepEqual(approvals(t.tenant), [], "no approval: a funded account would arm live whatever its owner's settings say");
    assert.equal(forksOf(t.tenant).length, 0);
    assert.equal(chainReads, 0);
    const w = watch(t.tenant)!;
    assert.equal(w.owed, 0, "answered once");
    assert.match(String(w.outcome), /live-trading consent is stood down on this deployment/);
    assert.match(String(w.outcome), /could arm live \(chain:required\)/);
    const [entry] = JSON.parse(String(rows("SELECT entries_json FROM ledger_resume_preview_runs WHERE run = ?", w.run)[0]!.entries_json)) as Array<{ pass: boolean; chain: string; suggestedLevel: string }>;
    assert.deepEqual([entry!.pass, entry!.chain, entry!.suggestedLevel], [true, "required", "exits-only"], "the preview an operator reads says so too");
    assert.ok(existsSync(path.join(t.home, "ledger-source-blocked.json")), "its home untouched");
    await cleanUp(t.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; delete process.env.MERRYMEN_LIVE_INTENT_STAND_DOWN; }
});

it("on: an owner who turns live trading on while the home is being archived ends the automatic approval at Phase B — nothing registered, nothing forked, no chain read", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    const t = await preIncident();
    const live = await liveSettingsFor(t.tenant);
    await pass();
    // Phase A, the archive and Phase B run in one call; the switch lands in the middle of the archive.
    let switched = false;
    onLeaseCheck.set(t.tenant, () => {
      if (!switched && approvals(t.tenant)[0]?.state === "archiving") { writeFileSync(settingsFile(t.tenant), live, { mode: 0o600 }); switched = true; }
    });
    await t.resign();
    try { await pass(); } finally { onLeaseCheck.delete(t.tenant); }
    assert.equal(switched, true, "the owner's settings changed during the archive");
    const [a] = approvals(t.tenant);
    assert.deepEqual([a!.state, a!.source], ["refused", "auto-paper"]);
    assert.match(String(a!.reason), /an automatic \(auto-paper\) approval admits only a paper tenant that could not arm live/);
    assert.equal(forksOf(t.tenant).length, 0, "no worker at trade for an owner who now wants the live rail");
    assert.equal(rows("SELECT * FROM ledger_resume_attestations WHERE tenant = ?", t.tenant).length, 0, "nothing registered");
    assert.equal(chainReads, 0);
    rmSync(settingsFile(t.tenant), { force: true });
    await cleanUp(t.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; onLeaseCheck.clear(); }
});

it("on: an automatic approval left archived by a failed registration is refused at Phase B on a later pass once the owner wants the live rail — nothing forked, no chain read", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  const realTx = shared.tx.bind(shared);
  try {
    const t = await preIncident();
    const live = await liveSettingsFor(t.tenant);
    await pass();
    // The registration fails once its approval is archived: the process dies there.
    let failRegistration = true;
    (shared as { tx: typeof shared.tx }).tx = async (fn) => {
      if (failRegistration && approvals(t.tenant)[0]?.state === "archived") { failRegistration = false; throw new Error("process killed mid-registration"); }
      return realTx(fn);
    };
    await t.resign();
    try { await pass(); } finally { (shared as { tx: typeof shared.tx }).tx = realTx; }
    assert.equal(failRegistration, false, "the registration was attempted, and failed");
    assert.deepEqual(approvals(t.tenant).map((a) => [a.state, a.source]), [["archived", "auto-paper"]]);
    // Before the next pass the owner turns live trading on.
    writeFileSync(settingsFile(t.tenant), live, { mode: 0o600 });
    await pass();
    const [a] = approvals(t.tenant);
    assert.equal(a!.state, "refused");
    assert.match(String(a!.reason), /an automatic \(auto-paper\) approval admits only a paper tenant/);
    assert.equal(forksOf(t.tenant).length, 0);
    assert.equal(rows("SELECT * FROM ledger_resume_attestations WHERE tenant = ?", t.tenant).length, 0);
    assert.equal(chainReads, 0, "where an operator's approval would read the chain, an automatic one ends");
    rmSync(settingsFile(t.tenant), { force: true });
    await cleanUp(t.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; (shared as { tx: typeof shared.tx }).tx = realTx; }
});

it("an auto-paper approval of a tenant that could arm live — a row the lane itself never writes — is refused at Phase A without reading the chain", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    const t = await preIncident({ live: true });
    await pass();
    await t.resign();
    await pass();
    // The lane previewed it and left it to the operator; its run shows it passing, chain:required.
    const w = watch(t.tenant)!;
    const [entry] = JSON.parse(String(rows("SELECT entries_json FROM ledger_resume_preview_runs WHERE run = ?", w.run)[0]!.entries_json));
    assert.deepEqual([entry.pass, entry.chain], [true, "required"]);
    // Stand in for any path that could write such a row: the insert itself, marked auto-paper.
    assert.deepEqual(await recordResumeApproval(shared, { entry, run: String(w.run), at: Date.now(), nowMs: Date.now(), source: "auto-paper" }, () => {}), { recorded: true });
    await pass();
    const [a] = approvals(t.tenant);
    assert.equal(a!.state, "refused");
    assert.match(String(a!.reason), /an automatic \(auto-paper\) approval admits only a paper tenant/);
    assert.equal(chainReads, 0, "refused where an operator's approval would start its chain read");
    assert.equal(forksOf(t.tenant).length, 0);
    assert.ok(existsSync(path.join(t.home, "ledger-source-blocked.json")), "refused before anything moved");
    await cleanUp(t.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; }
});

it("on: re-signers whose previews never read cannot starve the ones behind them — a readable one is admitted in the same pass, and they go to the back", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    const stuck = [await preIncident(), await preIncident()];
    const healthy = await preIncident();
    await pass();
    for (const s of stuck) {
      mkdirSync(path.dirname(settingsFile(s.tenant)), { recursive: true });
      writeFileSync(settingsFile(s.tenant), "{ not json", { mode: 0o600 });
    }
    // The stuck ones re-sign first, while the fleet is at the cap: owed, untried, and so first in line.
    setPhantomProcessesForTest(40);
    try {
      for (const s of stuck) await s.resign();
      await pass();
    } finally { setPhantomProcessesForTest(0); }
    for (const s of stuck) assert.deepEqual({ ...watch(s.tenant)! }, { owed: 1, outcome: null, run: null });
    assert.deepEqual(stuck.map((s) => rows("SELECT attempted_at_ms AS at FROM ledger_resume_grant_watch WHERE tenant = ?", s.tenant)[0]!.at), [null, null], "not tried yet");
    // The readable one re-signs after them; in the next pass both of theirs are tried and fail first.
    await healthy.resign();
    await pass();
    assert.deepEqual(approvals(healthy.tenant).map((a) => [a.state, a.source]), [["applied", "auto-paper"]], "answered in the pass it was owed, behind two that could not be read");
    assert.equal(forksOf(healthy.tenant).length, 1);
    for (const s of stuck) {
      assert.equal(watch(s.tenant)!.owed, 1, "still owed: an outage is not an answer");
      assert.equal(approvals(s.tenant).length, 0);
      assert.equal(typeof rows("SELECT attempted_at_ms AS at FROM ledger_resume_grant_watch WHERE tenant = ?", s.tenant)[0]!.at, "number", "and behind every change not tried since");
    }
    for (const s of stuck) rmSync(settingsFile(s.tenant));
    await pass();
    for (const s of stuck) assert.equal(forksOf(s.tenant).length, 1, "answered once they read");
    await cleanUp(healthy.tenant, ...stuck.map((s) => s.tenant));
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; }
});

it("on: a controls read that fails is an outage, not an answer — the re-sign stays owed, an approval's Phase A holds rather than refuses, and both go on once it reads", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    // The automatic preview: one controls read fails, and the re-sign is still owed.
    const t = await preIncident();
    await pass();
    await t.resign();
    controlsReadFails = true;
    try { await pass(); } finally { controlsReadFails = false; }
    assert.deepEqual({ ...watch(t.tenant)! }, { owed: 1, outcome: null, run: null }, "not settled as 'did not pass'");
    assert.equal(table("ledger_resume_approvals") ? approvals(t.tenant).length : 0, 0);
    assert.ok(lines.some((l) => l.includes(`${t.tenant}: resume auto-paper could not read it (owner controls cannot be read (controls unreadable (Error)))`)));
    await pass();
    assert.deepEqual(approvals(t.tenant).map((a) => [a.state, a.source]), [["applied", "auto-paper"]], "previewed again, read, and admitted");
    assert.equal(forksOf(t.tenant).length, 1);

    // Phase A: approved while its lease could not be held; then the controls read fails during the admission.
    const u = await preIncident();
    await pass();
    unhealthy.add(u.tenant);
    await u.resign();
    try { await pass(); } finally { unhealthy.delete(u.tenant); }
    assert.deepEqual(approvals(u.tenant).map((a) => [a.state, a.source]), [["approved", "auto-paper"]]);
    controlsReadFails = true;
    try { await pass(); } finally { controlsReadFails = false; }
    assert.deepEqual(approvals(u.tenant).map((a) => a.state), ["approved"], "held, not refused for 'evidence changed': the same evidence could never have been approved again");
    assert.ok(existsSync(path.join(u.home, "ledger-source-blocked.json")), "nothing moved");
    assert.ok(lines.some((l) => l.includes(`${u.tenant}: resume admission — owner controls cannot be read (controls unreadable (Error)) — a read that failed, not a change`)));
    await pass();
    assert.deepEqual(approvals(u.tenant).map((a) => a.state), ["applied"]);
    assert.equal(forksOf(u.tenant).length, 1);
    await cleanUp(t.tenant, u.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; controlsReadFails = false; }
});

it("on: a re-signed tenant whose unblocked book the continuity gate refuses is left to the ordinary path, and the operator is told how to approve it — which works", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    // Its book is on the volume with no barrier, and proves nothing: the gate refuses it.
    const t = await preIncident();
    rmSync(path.join(t.home, "ledger-source-blocked.json"));
    await pass();
    await t.resign();
    await pass();
    assert.equal(forksOf(t.tenant).length, 0, "the continuity gate holds it");
    const w = watch(t.tenant)!;
    assert.deepEqual([w.owed, w.run], [0, null], "answered, with no run of its own");
    assert.match(String(w.outcome), /^not-held: its book is on the volume and not behind a barrier: the ordinary path decides/);
    assert.equal(table("ledger_resume_approvals") ? approvals(t.tenant).length : 0, 0, "never approved automatically");
    // Not "the gate does not hold it" and nothing more: the line says what to do if the gate refuses it.
    // Not this preview's digest either — the ordinary path's attempt this pass armed the owner's
    // controls into the home, which that digest binds — but a preview taken after the gate answered.
    assert.ok(lines.some((l) => l.includes(`${t.tenant} re-signed; the continuity gate does not hold it`) &&
      l.includes(`If the gate refuses its book instead`) && l.includes(`preview it again (MERRYMEN_RESUME_PREVIEW=${t.tenant})`)), "the operator is told what to do");
    // What the line says works: preview, approve the digest it prints, and the same phases admit it.
    await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_PREVIEW: t.tenant });
    const latest = rows("SELECT run, entries_json FROM ledger_resume_preview_runs ORDER BY created_at_ms DESC LIMIT 1")[0]!;
    const [entry] = JSON.parse(String(latest.entries_json)) as Array<{ tenant: string; pass: boolean; digest: string; book: string }>;
    assert.deepEqual([entry!.tenant, entry!.pass, entry!.book], [t.tenant, true, "present"]);
    await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${entry!.digest}` });
    assert.deepEqual(approvals(t.tenant).map((a) => [a.state, a.source]), [["approved", "operator"]]);
    await pass();
    assert.deepEqual(approvals(t.tenant).map((a) => a.state), ["applied"]);
    assert.equal(forksOf(t.tenant).length, 1);
    await cleanUp(t.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; }
});

/** The automatic previews taken of a tenant, as the log prints them (a run is content-addressed: the same evidence previewed again is the same row). */
const runsFor = (tenant: string) => lines.filter((l) => l.startsWith("[resume-preview] run ") && l.includes(`: automatic, for ${tenant},`)).length;

it("on: an approval the store gives up on is an outage, not an answer — the re-sign stays owed, is tried again with back-off, is an [alert] from the third in a row, and is admitted once the store takes it", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    const t = await preIncident();
    await pass();
    const before = lines.length;
    const said = () => lines.slice(before);
    approvalInsert = { outage: "57014" };
    try {
      await t.resign();
      // 1st: previewed, the insert times out — still owed, and asked again on the very next pass.
      await pass();
      assert.deepEqual({ ...watch(t.tenant)! }, { owed: 1, outcome: null, run: null }, "not settled as 'not-recorded': no approval exists, and nothing else would ask again");
      assert.equal(approvals(t.tenant).length, 0);
      assert.equal(runsFor(t.tenant), 1);
      assert.equal(typeof rows("SELECT attempted_at_ms AS at FROM ledger_resume_grant_watch WHERE tenant = ?", t.tenant)[0]!.at, "number", "behind every change not tried since");
      assert.ok(said().includes(`resume auto-paper: ${t.tenant} could not record its approval — the store could not be reached or gave up (57014): an outage, not a refusal — ` +
        "its re-sign is still owed, previewed and tried again on the next pass"), said().join("\n"));
      // 2nd: on the next pass; then it sits a turn out.
      await pass();
      assert.equal(runsFor(t.tenant), 2, "tried again on the next pass");
      assert.ok(said().some((l) => l.endsWith("its re-sign is still owed, previewed and tried again after it sits out 1 more of its turn(s)")));
      await pass();
      assert.equal(runsFor(t.tenant), 2, "then it sits a turn out: no preview, no insert");
      // 3rd in a row: an [alert], and three turns out.
      await pass();
      assert.equal(runsFor(t.tenant), 3);
      assert.deepEqual(said().filter((l) => l.startsWith("[alert]")), [`[alert] ${t.tenant}: resume auto-paper could not record its approval 3 or more times in a row — ` +
        "the store could not be reached or gave up (57014): an outage, not a refusal — its re-sign is still owed, tried again with back-off"],
        "one [alert], from the third — none from the insert itself");
      assert.ok(!said().some((l) => l.includes("not approved automatically")), "never settled as a refusal");
      assert.equal(watch(t.tenant)!.owed, 1);
    } finally { approvalInsert = null; }
    // The store takes inserts again: the three turns are sat out, then a fresh preview is approved and admitted.
    await pass(); await pass(); await pass();
    assert.equal(runsFor(t.tenant), 3, "three turns out");
    assert.equal(forksOf(t.tenant).length, 0);
    await pass();
    assert.equal(runsFor(t.tenant), 4);
    const [a] = approvals(t.tenant);
    assert.deepEqual([a?.state, a?.source], ["applied", "auto-paper"]);
    assert.deepEqual(watch(t.tenant), { owed: 0, outcome: "auto-approved", run: a!.preview_run });
    assert.equal(forksOf(t.tenant).length, 1);
    assert.equal(chainReads, 0);
    await cleanUp(t.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; approvalInsert = null; }
});

it("on: an approval the store refuses — another replica's approval of the same evidence, recorded between the checks and the insert — settles the re-sign as before, and that approval admits it", async () => {
  process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
  try {
    const t = await preIncident();
    await pass();
    approvalInsert = "raced";
    try {
      await t.resign();
      await pass();
    } finally { approvalInsert = null; }
    const w = watch(t.tenant)!;
    assert.deepEqual([w.owed, w.outcome], [0, "not-recorded: the store refused the approval"], "the store's own answer is final: settled, as before");
    assert.ok(lines.includes(`[alert] resume approval: ${t.tenant} could not be recorded (another approval is open, or the store refused) — not approved`));
    // The approval on record is the one that won the race, and the same pass admits it.
    assert.deepEqual(rows("SELECT approval_id, state, source FROM ledger_resume_approvals WHERE tenant = ?", t.tenant),
      [{ approval_id: anotherReplica, state: "applied", source: "auto-paper" }]);
    assert.equal(forksOf(t.tenant).length, 1);
    const runs = runsFor(t.tenant);
    await pass(); await pass();
    assert.equal(runsFor(t.tenant), runs, "never previewed again");
    await cleanUp(t.tenant);
  } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; approvalInsert = null; }
});
