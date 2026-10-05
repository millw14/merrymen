/**
 * ATTESTED-GAP ADMISSION THROUGH THE REAL SPAWN PATH.
 *
 * A tenant from before 2026-10-04 03:18: Postgres holds its history and its
 * lost book's cursors, and its home on the persistent volume holds a blocked,
 * non-continuous book. Without an approval the ordinary gates refuse it, as
 * they must. With a preview, a batch approval and a clean chain read, the
 * same reconcile() archives the home, registers the attested empty book and
 * forks a worker through the unchanged ordinary path — while no financial row
 * changes, the lost cursors and snapshots sit in their archives exactly as
 * they were, and the first mirror pass leaves Postgres holding the seeded set.
 *
 * The volume proof, the lease and the chain are test seams; the grant store
 * is the real file store, the shared database real sqlite with the ledger
 * schema and a `grants` table that mirrors the store (the registration reads
 * the grant's binding there, as it does in Postgres).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { readBudgetSeed } from "./budget-seed";
import type { TenantLease } from "./tenant-lease";
import type { GapChain } from "./ledger-resume";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-ledger-resume-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 21).toString("base64");

const orch = await import("./orchestrator");
const { childHome, reconcile, setSpawnForTest, setRetirementMemoryStoreForTest, setPaperRestoreForTest, setPersistentHomeVerifierForTest,
  setLeaseAcquireForTest, setResumeChainForTest, resumeChecksSettledForTest, runResumeAdmissionControlsForTest, setKillConfirmForTest,
  setBasisSeedSharedForTest } = orch;
const { getGrantStore } = await import("./grant-store");
const { CASH } = await import("../../packages/core/src/index");

const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw), dek = Buffer.alloc(32, 21);
await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL); await shared.exec(PAPER_CHECKPOINT_SCHEMA);
raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY,grant_json TEXT NOT NULL,updated_at INTEGER NOT NULL,row_version INTEGER NOT NULL)");
const volumeStat = lstatSync(fleet, { bigint: true });
setPersistentHomeVerifierForTest(() => ({ id: "vol_resume_integration", mountPath: fleet, homeRoot: fleet, device: String(volumeStat.dev), inode: String(volumeStat.ino) }));
setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
// The REAL basis and floor seeds (orchestrator.ts seedBasisForChild), read
// from the same stand-in for Postgres, as production reads Postgres.
setBasisSeedSharedForTest(shared);
setPaperRestoreForTest(async () => ({ ok: true, line: null }));
setKillConfirmForTest(async () => {});
const unhealthy = new Set<string>();
setLeaseAcquireForTest(async (tenant) => ({ tenant, backend: "postgres", healthy: () => !unhealthy.has(tenant), async release() {} }) as TenantLease);

class FakeProc extends EventEmitter {
  readonly stdout = null; readonly stderr = null;
  constructor(readonly pid: number) { super(); }
  kill() { return true; }
}
const forks: Array<{ home: string; grant: boolean; paused: boolean; generation: boolean; files: string[] }> = [];
setSpawnForTest((_c, _a, options) => {
  const home = String(options.env?.MERRYMEN_HOME);
  forks.push({ home, grant: existsSync(path.join(home, "grant.json")), paused: existsSync(path.join(home, "paused")),
    generation: existsSync(path.join(home, "recovery-generation.json")), files: readdirSync(home).sort() });
  return new FakeProc(90_000 + forks.length) as unknown as ChildProcess;
});

/** The chain the gap check reads: the logs it holds, and whether it answers at all. */
let chainLogs: Array<{ address: string; topics: string[]; tx: string; index: number }> = [];
let chainDown = false;
const HEAD = 3_000_000n;
const chain: GapChain = {
  async getBlockNumber() { if (chainDown) throw new Error("rpc down"); return HEAD; },
  async getBlockTimestamp(b) { return Math.floor(Date.now() / 1000) - Number(HEAD - b) / 10; },
  async getLogs(a) {
    if (chainDown) throw Object.assign(new Error("rpc down"), { code: -32000 });
    // Every fixture log sits at HEAD - 100, so it is read once, by the span that covers it.
    if (a.fromBlock > HEAD - 100n || a.toBlock < HEAD - 100n) return [];
    return chainLogs.filter((l) => l.address.toLowerCase() === a.address.toLowerCase()
      && a.topics.every((t, i) => t === null || String(t).toLowerCase() === String(l.topics[i] ?? "").toLowerCase()))
      .map((l) => ({ topics: l.topics as `0x${string}`[], data: "0x" as `0x${string}`, transactionHash: l.tx as `0x${string}`, logIndex: `0x${l.index.toString(16)}` as `0x${string}` }));
  },
};
setResumeChainForTest(() => chain);

after(() => {
  setRetirementMemoryStoreForTest(null); setPaperRestoreForTest(null); setPersistentHomeVerifierForTest(null); setLeaseAcquireForTest(null); setResumeChainForTest(null);
  setBasisSeedSharedForTest(null);
  raw.close(); rmSync(fleet, { recursive: true, force: true });
});

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const OLD = nowSec() - 5 * 86_400;
const grant = (account: `0x${string}`, owner: `0x${string}`, n = 1): StoredGrant => ({
  smartAccount: account, owner, sessionKeyAddress: addr(0x5e5), serialized: `fixture-resume-${account}-${n}`,
  chainId: 4663, grantedAt: nowSec() - 60, expiresAt: nowSec() + 86_400,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
}) as unknown as StoredGrant;

let seq = 0;
/** One pre-incident tenant: its Postgres history, its cursors, its blocked home on the volume and its grant. */
async function preIncident(o: { live: boolean; owner?: `0x${string}` }) {
  seq += 1;
  const tenant = addr(0xa00000 + seq), account = addr(0xacc000 + seq), owner = o.owner ?? addr(0xb00000 + seq);
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 2, 120, ?)`).run(account, owner, addr(1), o.live ? "live" : "paper");
  raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, user_op_hash, tx_hash, epoch)
    VALUES (?, 'swap', 'x', 5, ?, ?, ?, ?, 2)`).run(account, o.live ? "landed" : "paper", OLD, o.live ? `0x${"0".repeat(60)}${seq.toString(16).padStart(4, "0")}` : null, o.live ? `0xt${seq}` : null);
  if (o.live) raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, at, epoch, chain_id)
    VALUES (?, 'in', 100, ?, 10, 3, 'deposit', ?, 2, 4663)`).run(account, `0xd${seq}`, OLD);
  raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 90, 0, 10, 100, ?, 2, ?)")
    .run(account, OLD, o.live ? "live" : "paper");
  raw.prepare("INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at) VALUES (?, 'COIN', ?, '10', '1', 1, 0, 'pool', 10, ?)").run(account, addr(5), OLD);
  raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'COIN', '10', '20', ?)").run(account, OLD);
  raw.prepare("INSERT INTO position_floors VALUES (?, 'live', 'COIN', 1500, 'r1', 'entry', ?)").run(account, OLD);
  for (const [table, id] of [["trades", 40], ["events", 90], ["equity", 12]] as const) {
    raw.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, ?, ?, ?, ?)").run(tenant, table, id, OLD, nowSec() - 40 * 3600);
  }
  const home = childHome(tenant); mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const [name, body] of [["ledger-source-blocked.json", '{"version":1,"state":"missing-live-source"}'], ["paused", "paused"], ["telegram.json", '{"offset":321}'],
    ["grant.json", "OLD SESSION KEY"], ["settings.json", '{"telegramBotToken":"OLD BOT TOKEN"}']] as const) writeFileSync(path.join(home, name), body, { mode: 0o600 });
  const stale = new DatabaseSync(path.join(home, "merrymen.db")); stale.exec("CREATE TABLE junk (x); INSERT INTO junk VALUES (1)"); stale.close();
  await putGrant(tenant, grant(account, owner));
  return { tenant, account, owner, home };
}
async function putGrant(tenant: `0x${string}`, g: StoredGrant) {
  await getGrantStore().put(tenant, g);
  raw.prepare("INSERT INTO grants VALUES (?, ?, ?, 1) ON CONFLICT (tenant) DO UPDATE SET grant_json = excluded.grant_json, updated_at = excluded.updated_at, row_version = grants.row_version + 1")
    .run(tenant, JSON.stringify({ smartAccount: g.smartAccount, owner: g.owner, chainId: g.chainId }), nowSec());
}
const rows = (sql: string, ...args: unknown[]) => (raw.prepare(sql).all(...(args as never[])) as Array<Record<string, unknown>>).map((r) => ({ ...r }));
const financial = (account: string) => ({
  trades: rows("SELECT * FROM trades WHERE agent_id = ? ORDER BY id", account), flows: rows("SELECT * FROM flows WHERE agent_id = ? ORDER BY id", account),
  equity: rows("SELECT * FROM equity WHERE agent_id = ? ORDER BY id", account), agents: rows("SELECT epoch, hwm_usdg, hwm_withdrawn_usdg, accrued_fee_usdg FROM agents WHERE smart_account = ?", account),
});
const POSITION_COLUMNS = "agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at";
const snapshots = (account: string) => ({
  positions: rows(`SELECT ${POSITION_COLUMNS} FROM positions WHERE agent_id = ?`, account), cost_basis: rows("SELECT * FROM cost_basis WHERE agent_id = ?", account),
  position_floors: rows("SELECT * FROM position_floors WHERE agent_id = ?", account),
});
async function preview(...tenants: string[]) {
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_PREVIEW: tenants.join(",") });
  const run = raw.prepare("SELECT run, entries_json FROM ledger_resume_preview_runs ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get() as { run: string; entries_json: string };
  return { run: run.run, entries: JSON.parse(run.entries_json) as Array<{ tenant: string; account: string | null; digest: string; pass: boolean; refusals: string[]; chain: string; suggestedLevel: string }> };
}
const approval = (tenant: string) => raw.prepare("SELECT state, reason, generation, archive_path FROM ledger_resume_approvals WHERE tenant = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get(tenant) as
  { state: string; reason: string | null; generation: string | null; archive_path: string | null } | undefined;
const forksOf = (tenant: string) => forks.filter((f) => f.home === childHome(tenant));
async function settle() { await resumeChecksSettledForTest(); await reconcile(); await new Promise((r) => setTimeout(r, 20)); }

it("a pre-incident live tenant: refused without approval; previewed, batch-approved, chain-read, archived, registered and spawned through the ordinary path", async () => {
  const t = await preIncident({ live: true });
  const before = financial(t.account), preImage = snapshots(t.account);
  const cursors = rows("SELECT table_name, last_id, last_stamp, updated_at FROM mirror_state WHERE tenant = ? ORDER BY table_name", t.tenant);

  await reconcile();
  assert.equal(forksOf(t.tenant).length, 0, "the continuity gate refuses it, as it must, without an approval");

  const p = await preview(t.tenant);
  assert.deepEqual(p.entries.map((e) => ({ pass: e.pass, chain: e.chain, level: e.suggestedLevel })), [{ pass: true, chain: "required", level: "exits-only" }]);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${p.run}` });
  assert.equal(approval(t.tenant)?.state, "approved");

  await reconcile(); // starts the chain read; held meanwhile
  assert.equal(forksOf(t.tenant).length, 0);
  assert.equal(existsSync(path.join(t.home, "grant.json")), true, "nothing moved while the chain was being read");
  await settle();

  assert.equal(forksOf(t.tenant).length, 1, "one worker");
  const fork = forksOf(t.tenant)[0]!;
  assert.deepEqual({ grant: fork.grant, paused: fork.paused, generation: fork.generation }, { grant: true, paused: true, generation: true });
  const a = approval(t.tenant)!;
  assert.equal(a.state, "applied");
  // The archive: the whole old home, keys scrubbed, the blocked book's marker kept as evidence.
  const archived = readdirSync(a.archive_path!).sort();
  assert.ok(archived.includes("ledger-source-blocked.json") && archived.includes("merrymen.db") && archived.includes(".archive-manifest.json"));
  for (const gone of ["grant.json", "settings.json", "telegram.json"]) assert.ok(!archived.includes(gone), `${gone} is not in the archive`);
  assert.equal(readFileSync(path.join(t.home, "telegram.json"), "utf8"), '{"offset":321}', "Telegram progress carried");
  // Postgres: no financial row changed; the cursors and snapshots archived exactly.
  assert.deepEqual(financial(t.account), before);
  assert.deepEqual(rows("SELECT * FROM mirror_state WHERE tenant = ?", t.tenant), []);
  assert.deepEqual(rows("SELECT table_name, last_id, last_stamp, updated_at FROM mirror_state_archive WHERE generation = ? ORDER BY table_name", a.generation), cursors);
  const archivedSnaps = rows("SELECT table_name, row_json FROM ledger_snapshot_archive WHERE generation = ? ORDER BY table_name, seq", a.generation);
  assert.deepEqual(archivedSnaps.filter((r) => r.table_name === "cost_basis").map((r) => JSON.parse(String(r.row_json))), preImage.cost_basis);
  assert.deepEqual(archivedSnaps.filter((r) => r.table_name === "position_floors").map((r) => JSON.parse(String(r.row_json))), preImage.position_floors);
  assert.deepEqual(archivedSnaps.filter((r) => r.table_name === "positions").map((r) => { const { custody: _c, ...rest } = JSON.parse(String(r.row_json)) as Record<string, unknown>; return rest; }),
    preImage.positions);
  assert.equal(rows("SELECT * FROM ledger_resume_attestations WHERE generation = ?", a.generation).length, 1);

  // THE SEEDS RAN BEFORE THE FORK: the real basis and floor seeds (B4), then
  // the attested seed's proof, recorded in the home before the worker started.
  assert.ok(fork.files.includes("attested-seed.json"), "the seed was proved before the first worker");
  // THE CHILD ARMS and its first tick reads the position. Then the first mirror pass.
  const book = new DatabaseSync(path.join(t.home, "merrymen.db"));
  try {
    const seeded = { basis: book.prepare("SELECT * FROM cost_basis").all().map((r) => ({ ...r })), floors: book.prepare("SELECT * FROM position_floors").all().map((r) => ({ ...r })) };
    assert.deepEqual(seeded.basis.map((r) => [r.agent_id, r.mode, r.symbol, r.qty_raw, r.cost_usdg]), [[t.account, "live", "COIN", "10", "20"]], "the held position's cost is in the book");
    assert.deepEqual(seeded.floors.map((r) => [r.symbol, r.stop_bps, r.rung]), [["COIN", 1500, "r1"]], "and its graded floor beside it");
    book.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
      VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 2, 120, 'live')`).run(t.account, t.owner, addr(1));
    book.prepare("INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at) VALUES (?, 'COIN', ?, '10', '1', 1.5, 0, 'pool', 15, ?)").run(t.account, addr(5), nowSec());
    const r = await mirrorTenant({ tenant: t.tenant, child: wrapSqlite(book), shared });
    assert.equal(r.restarted, undefined, "no cursor rewound: there is none of the lost book's to rewind");
    assert.deepEqual(snapshots(t.account).cost_basis, seeded.basis, "Postgres basis equals the seeded set");
    assert.deepEqual(snapshots(t.account).position_floors, seeded.floors, "Postgres floors equal the seeded set");
    assert.deepEqual(snapshots(t.account).positions, book.prepare(`SELECT ${POSITION_COLUMNS} FROM positions`).all().map((x) => ({ ...x })), "positions equal the child's own reading");
    assert.deepEqual(financial(t.account).trades, before.trades, "and still no trade copied twice or rewritten");
  } finally { book.close(); }
  // The rolling caps read the trailing day from Postgres: nothing in it.
  assert.deepEqual(await readBudgetSeed(shared, t.account, String(CASH.USDG), nowSec()), []);
  await getGrantStore().remove(t.tenant); await reconcile();
});

it("an RPC failure keeps the tenant held and retries; chain activity Postgres lacks refuses", async () => {
  const t = await preIncident({ live: true });
  const p = await preview(t.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${p.entries[0]!.digest}` });
  chainDown = true;
  try {
    await reconcile(); await settle();
    assert.equal(forksOf(t.tenant).length, 0);
    assert.equal(approval(t.tenant)?.state, "approved", "an unavailable chain read refuses nothing and moves nothing");
    assert.equal(existsSync(path.join(t.home, "grant.json")), true);
  } finally { chainDown = false; }
  // The retry waits out its backoff (a minute in production; cleared here),
  // then a pass reads the chain again and admits.
  setResumeChainForTest(() => chain);
  await reconcile(); await settle();
  assert.equal(approval(t.tenant)?.state, "applied", "admitted once the chain answered");
  assert.equal(forksOf(t.tenant).length, 1);
  const u = await preIncident({ live: true });
  const q = await preview(u.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${u.tenant}:${q.entries[0]!.digest}` });
  const topic = (x: string) => `0x${x.slice(2).padStart(64, "0")}`;
  chainLogs = [{ address: String(CASH.USDG), topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(addr(0xfeed)), topic(u.account)], tx: "0xunbooked", index: 1 }];
  try {
    await reconcile(); await settle();
    assert.equal(approval(u.tenant)?.state, "refused");
    assert.match(String(approval(u.tenant)?.reason), /Postgres lacks/);
    assert.equal(forksOf(u.tenant).length, 0);
    assert.equal(existsSync(path.join(u.home, "grant.json")), true, "refused before anything moved");
  } finally { chainLogs = []; }
  await getGrantStore().remove(t.tenant); await getGrantStore().remove(u.tenant); await reconcile();
});

it("a paper tenant needs no chain read; evidence that changed after the preview refuses with nothing moved", async () => {
  const t = await preIncident({ live: false });
  const p = await preview(t.tenant);
  assert.equal(p.entries[0]!.chain, "not-required");
  assert.equal(p.entries[0]!.suggestedLevel, "trade");
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${p.run}` });
  // Something lands in the books after the operator looked.
  raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 1, 0, 0, 1, ?, 2, 'paper')").run(t.account, OLD + 5);
  await reconcile();
  assert.equal(approval(t.tenant)?.state, "refused");
  assert.match(String(approval(t.tenant)?.reason), /evidence changed/);
  assert.equal(existsSync(path.join(t.home, "grant.json")), true);
  assert.equal(rows("SELECT * FROM mirror_state WHERE tenant = ?", t.tenant).length, 3);
  // Previewed again and approved again, it is admitted with no chain read at all.
  const again = await preview(t.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${again.run}` });
  setResumeChainForTest(() => { throw new Error("a paper tenant must not read the chain"); });
  try { await reconcile(); await new Promise((r) => setTimeout(r, 20)); }
  finally { setResumeChainForTest(() => chain); }
  assert.equal(forksOf(t.tenant).length, 1);
  assert.equal(approval(t.tenant)?.state, "applied");
  await getGrantStore().remove(t.tenant); await reconcile();
});

it("a re-sign by the same owner still admits; a new account refuses; an expired grant is not admitted", async () => {
  const same = await preIncident({ live: false });
  const p = await preview(same.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${p.run}` });
  await putGrant(same.tenant, grant(same.account, same.owner, 2)); // a new signature, same owner and account
  await reconcile(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(approval(same.tenant)?.state, "applied");

  const moved = await preIncident({ live: false });
  const q = await preview(moved.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${q.run}` });
  await putGrant(moved.tenant, grant(addr(0xbad0001), moved.owner, 2)); // the owner signed a NEW account
  await reconcile();
  assert.equal(approval(moved.tenant)?.state, "refused");
  assert.match(String(approval(moved.tenant)?.reason), /different account/);
  assert.equal(forksOf(moved.tenant).length, 0);

  const expired = await preIncident({ live: false });
  const r = await preview(expired.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${r.run}` });
  await putGrant(expired.tenant, { ...grant(expired.account, expired.owner, 2), expiresAt: nowSec() - 60 } as StoredGrant);
  await reconcile();
  assert.equal(approval(expired.tenant)?.state, "approved", "an expired grant is never taken into Phase A");
  assert.equal(existsSync(path.join(expired.home, "merrymen.db")), true);
  assert.equal(forksOf(expired.tenant).length, 0);
  for (const x of [same, moved, expired]) await getGrantStore().remove(x.tenant);
  await reconcile();
});

it("a lost lease moves nothing; a crash between the archive and the registration converges on the same generation", async () => {
  const t = await preIncident({ live: false });
  const p = await preview(t.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${p.run}` });
  unhealthy.add(t.tenant);
  try {
    await reconcile();
    assert.equal(approval(t.tenant)?.state, "approved");
    assert.equal(existsSync(path.join(t.home, "grant.json")), true, "no lease, nothing archived");
  } finally { unhealthy.delete(t.tenant); }
  // Crash right after the home was archived: the approval is left `archiving`
  // or `archived`, the registration not yet run. Simulate by archiving through
  // a pass whose registration is refused by a lost lease at its first check.
  const shared2 = shared;
  void shared2;
  const realTx = shared.tx.bind(shared);
  let failRegistration = true;
  (shared as { tx: typeof shared.tx }).tx = async (fn) => {
    if (failRegistration && approval(t.tenant)?.state === "archived") { failRegistration = false; throw new Error("process killed mid-registration"); }
    return realTx(fn);
  };
  try {
    await reconcile();
  } finally { (shared as { tx: typeof shared.tx }).tx = realTx; }
  const mid = approval(t.tenant)!;
  assert.equal(mid.state, "archived");
  assert.equal(existsSync(path.join(t.home, "grant.json")), false, "the home is in its archive");
  assert.equal(rows("SELECT * FROM mirror_state WHERE tenant = ?", t.tenant).length, 3, "no cursor moved");
  await reconcile(); await new Promise((r) => setTimeout(r, 20));
  const done = approval(t.tenant)!;
  assert.equal(done.state, "applied");
  assert.equal(done.generation, mid.generation, "the same generation, not a second archive");
  assert.equal(readdirSync(path.join(fleet, "archive", t.tenant)).length, 1);
  assert.equal(forksOf(t.tenant).length, 1);
  await getGrantStore().remove(t.tenant); await reconcile();
});

it("a batch approval admits exactly the previewed tenants that passed", async () => {
  const good = await preIncident({ live: false });
  const bad = await preIncident({ live: false });
  raw.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, user_op_hash) VALUES (?, 'swap', 'x', 1, 'submitted', ?, '0xstuck')").run(bad.account, OLD);
  const p = await preview(good.tenant, bad.tenant);
  assert.deepEqual(p.entries.map((e) => [e.tenant, e.pass]).sort(), [[good.tenant, true], [bad.tenant, false]].sort());
  const late = await preIncident({ live: false }); // not in the run
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${p.run}` });
  assert.equal(approval(good.tenant)?.state, "approved");
  assert.equal(approval(bad.tenant), undefined);
  assert.equal(approval(late.tenant), undefined);
  await reconcile(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(forksOf(good.tenant).length, 1);
  assert.equal(forksOf(bad.tenant).length, 0);
  assert.equal(forksOf(late.tenant).length, 0);
  for (const x of [good, bad, late]) await getGrantStore().remove(x.tenant);
  await reconcile();
});

/** Make the attested seed's own Postgres read (planAttestedSeed's basis SELECT) fail `times` times, or for as long as `until()` says. */
const PLAN_SQL = /^SELECT mode, symbol, qty_raw, cost_usdg FROM cost_basis WHERE lower\(agent_id\) = lower\(\?\) AND mode = 'live'$/;
function failSeedReads(o: { times?: number; until?: () => boolean }): () => void {
  const real = shared.prepare.bind(shared);
  let left = o.times ?? Number.POSITIVE_INFINITY;
  (shared as { prepare: typeof shared.prepare }).prepare = (sql: string) => {
    if (PLAN_SQL.test(sql.trim()) && left > 0 && (o.until ? o.until() : true)) { left -= 1; throw Object.assign(new Error("pool blip"), { name: "PoolError" }); }
    return real(sql);
  };
  return () => { (shared as { prepare: typeof shared.prepare }).prepare = real; };
}
/** A shared ledger whose every read fails: the ordinary seeds' pool, mid-blip. */
const failingSeedDb = { prepare: () => { throw new Error("pool blip"); }, exec: async () => {}, tx: async () => { throw new Error("pool blip"); } } as unknown as Parameters<typeof setBasisSeedSharedForTest>[0];

it("a failed seed is completed before the first worker, or the spawn is held; Postgres basis and floors survive and the first pass publishes the seeded set", async () => {
  const t = await preIncident({ live: false });
  const preImage = snapshots(t.account);
  const p = await preview(t.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${p.run}` });
  // The ordinary seeds fail outright (their pool is down), and the attested
  // seed's own read fails once too.
  setBasisSeedSharedForTest(failingSeedDb);
  const restore = failSeedReads({ times: 1 });
  try {
    await reconcile(); await new Promise((r) => setTimeout(r, 20));
    assert.equal(forksOf(t.tenant).length, 0, "held: no worker arms on an unproved seed");
    assert.equal(approval(t.tenant)?.state, "registered");
    assert.equal(existsSync(path.join(t.home, "attested-seed.json")), false);
    assert.deepEqual(snapshots(t.account), preImage, "nothing in Postgres moved: no worker, no mirror pass");
    // The next pass: the ordinary seeds still fail, the attested seed writes
    // and proves what they should have, and only then does the worker start.
    await reconcile(); await new Promise((r) => setTimeout(r, 20));
  } finally { restore(); setBasisSeedSharedForTest(shared); }
  assert.equal(forksOf(t.tenant).length, 1);
  assert.equal(approval(t.tenant)?.state, "applied");
  const book = new DatabaseSync(path.join(t.home, "merrymen.db"));
  try {
    assert.deepEqual(book.prepare("SELECT mode, symbol, qty_raw, cost_usdg FROM cost_basis").all().map((r) => ({ ...r })),
      [{ mode: "live", symbol: "COIN", qty_raw: "10", cost_usdg: "20" }], "the cost the failed seed missed is in the book");
    assert.deepEqual(book.prepare("SELECT symbol, stop_bps FROM position_floors").all().map((r) => ({ ...r })), [{ symbol: "COIN", stop_bps: 1500 }]);
    book.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
      VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 2, 120, 'paper')`).run(t.account, t.owner, addr(1));
    await mirrorTenant({ tenant: t.tenant, child: wrapSqlite(book), shared });
  } finally { book.close(); }
  // The seed stamps its own updated_at, as the ordinary seed always has; the
  // cost itself is the pre-image's.
  const cost = (r: Record<string, unknown>) => [r.agent_id, r.mode, r.symbol, r.qty_raw, r.cost_usdg];
  assert.deepEqual(snapshots(t.account).cost_basis.map(cost), preImage.cost_basis.map(cost), "the first mirror pass left Postgres's basis as it was: the seeded set");
  assert.deepEqual(snapshots(t.account).position_floors, preImage.position_floors);
  await getGrantStore().remove(t.tenant); await reconcile();
});

it("a paper book whose owner turned live trading on during the hold previews as chain-read and exits-only", async () => {
  const t = await preIncident({ live: false });
  const before = await preview(t.tenant);
  assert.deepEqual([before.entries[0]!.chain, before.entries[0]!.suggestedLevel], ["not-required", "trade"]);
  const { getSettingsStore } = await import("./settings-store");
  await getSettingsStore().put(t.tenant, { liveTradingEnabled: true } as never);
  const after = await preview(t.tenant);
  assert.deepEqual([after.entries[0]!.chain, after.entries[0]!.suggestedLevel], ["required", "exits-only"]);
  assert.notEqual(after.entries[0]!.digest, before.entries[0]!.digest, "an approval of the paper verdict no longer matches");
  await getGrantStore().remove(t.tenant); await reconcile();
});

it("an admitted tenant previews as already admitted, and a run approval of that preview archives nothing", async () => {
  const t = await preIncident({ live: false });
  const p = await preview(t.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${p.run}` });
  await reconcile(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(approval(t.tenant)?.state, "applied");
  const again = await preview(t.tenant);
  assert.equal(again.entries[0]!.pass, false);
  assert.match(again.entries[0]!.refusals.join(" "), /already admitted/);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${again.run}` });
  assert.equal(rows("SELECT * FROM ledger_resume_approvals WHERE tenant = ?", t.tenant).length, 1, "no second approval");
  await reconcile(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(readdirSync(path.join(fleet, "archive", t.tenant)).length, 1, "its running book was not archived again");
  assert.equal(rows("SELECT * FROM ledger_resume_attestations WHERE tenant = ?", t.tenant).length, 1);
  await getGrantStore().remove(t.tenant); await reconcile();
});

it("a registered approval whose grant moved to a new account before its first worker ends refused, and the tenant can be approved again", async () => {
  const t = await preIncident({ live: false });
  const p = await preview(t.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${p.run}` });
  let blip = true;
  const restore = failSeedReads({ until: () => blip });
  try {
    await reconcile(); await new Promise((r) => setTimeout(r, 20));
    assert.equal(approval(t.tenant)?.state, "registered", "registered, its first worker held");
    // The owner's grant moves to a NEW account (a recorded /kill removed the
    // old one and they signed again).
    await putGrant(t.tenant, grant(addr(0xbad0777), t.owner, 3));
    await reconcile(); await new Promise((r) => setTimeout(r, 20));
  } finally { blip = false; restore(); }
  assert.equal(approval(t.tenant)?.state, "refused");
  assert.match(String(approval(t.tenant)?.reason), /different account/);
  assert.equal(forksOf(t.tenant).length, 0, "the new account is refused by the continuity gate, as before");
  // No longer stuck: a preview of what is true now can be approved.
  const fresh = await preview(t.tenant);
  assert.equal(fresh.entries[0]!.account, addr(0xbad0777));
  assert.ok(!fresh.entries[0]!.refusals.some((r) => /already admitted/.test(r)), "the registered book was the old account's");
  assert.equal(fresh.entries[0]!.pass, true, fresh.entries[0]!.refusals.join(" | "));
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${fresh.entries[0]!.digest}` });
  assert.equal(approval(t.tenant)?.state, "approved");
  await getGrantStore().remove(t.tenant); await reconcile();
});
