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
const { CHAIN_REFUSAL, chainRefusal } = await import("./ledger-resume");

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

/** The chain the gap check reads: the logs it holds, its head, and whether it answers at all. */
let chainLogs: Array<{ address: string; topics: string[]; tx: string; index: number; block?: bigint; data?: string }> = [];
let chainDown = false;
const HEAD = 3_000_000n;
let head = HEAD;
/** Timestamp lookups: only a whole read, which finds its starting block by them, asks for one; the re-read before registration does not. */
let stampReads = 0;
const chain: GapChain = {
  async getBlockNumber() { if (chainDown) throw new Error("rpc down"); return head; },
  async getBlockTimestamp(b) { stampReads += 1; return Math.floor(Date.now() / 1000) - Number(head - b) / 10; },
  async getLogs(a) {
    if (chainDown) throw Object.assign(new Error("rpc down"), { code: -32000 });
    // A fixture log sits at its block (HEAD - 100 unless it says), so it is read once, by the span that covers it.
    return chainLogs.filter((l) => (l.block ?? HEAD - 100n) >= a.fromBlock && (l.block ?? HEAD - 100n) <= a.toBlock && l.address.toLowerCase() === a.address.toLowerCase()
      && a.topics.every((t, i) => t === null || String(t).toLowerCase() === String(l.topics[i] ?? "").toLowerCase()))
      .map((l) => ({ topics: l.topics as `0x${string}`[], data: (l.data ?? "0x") as `0x${string}`, transactionHash: l.tx as `0x${string}`,
        logIndex: `0x${l.index.toString(16)}` as `0x${string}`, blockNumber: `0x${(l.block ?? HEAD - 100n).toString(16)}` as `0x${string}` }));
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
/**
 * One preview, and the run it recorded: the run its own summary line names. Not the newest row by its time — a
 * run repeated keeps the time it was first taken, and one taken while a test moved the clock on is dated ahead.
 */
async function preview(...tenants: string[]) {
  const said: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); realLog(...a); };
  try { await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_PREVIEW: tenants.join(",") }); } finally { console.log = realLog; }
  const digest = said.map((l) => /\[resume-preview\] run ([0-9a-f]{64}):/.exec(l)?.[1]).find(Boolean);
  assert.ok(digest, "the preview names its run");
  const run = raw.prepare("SELECT run, entries_json FROM ledger_resume_preview_runs WHERE run = ?").get(digest) as { run: string; entries_json: string };
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
  const attested = rows("SELECT chain_from_block, chain_head FROM ledger_resume_attestations WHERE generation = ?", a.generation);
  assert.equal(attested.length, 1);
  assert.equal(attested[0]!.chain_head, String(HEAD), "the attestation records the head read immediately before it");
  assert.ok(BigInt(String(attested[0]!.chain_from_block)) < HEAD - 26n * 3600n * 10n, "from a block at least 26 hours back");

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
  chainLogs = [{ address: String(CASH.USDG), topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(addr(0xfeed)), topic(u.account)], tx: "0xunbooked", index: 1,
    data: `0x${(7_250_000n).toString(16).padStart(64, "0")}` }];
  const said: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); realLog(...a); };
  try {
    await reconcile(); await settle();
    assert.equal(approval(u.tenant)?.state, "refused");
    // THE REFUSAL NAMES WHAT IT FOUND: the transaction, log, block, direction
    // and amount, in the stored reason, its [alert] line and the chain check's line.
    const named = `USDG in 7.250000 in tx 0xunbooked log 1 at block ${HEAD - 100n}`;
    assert.equal(String(approval(u.tenant)?.reason), `the chain holds operations or USDG transfers for the account that Postgres lacks: ${named}`);
    assert.ok(said.some((l) => l.includes(`${u.tenant}: resume chain check missing — 0 operation(s) and 1 transfer(s) on chain that Postgres lacks, blocks `) && l.endsWith(named)),
      "the chain check's own line names it");
    assert.ok(said.some((l) => l.includes(`[alert] ${u.tenant}: resume approval REFUSED — `) && l.includes(named)), "and the [alert] says it");
    assert.equal(forksOf(u.tenant).length, 0);
    assert.equal(existsSync(path.join(u.home, "grant.json")), true, "refused before anything moved");
    // AND THE NEXT PREVIEW CARRIES IT beside the verdict, which it does not
    // change: the chain check is no Postgres precondition. The line says it,
    // and so does the run row, the record a log that drops lines cannot lose.
    said.length = 0;
    const r = await preview(u.tenant);
    const line = said.find((l) => l.includes("[resume-preview] {") && l.includes(u.tenant));
    assert.ok(line?.includes(`"lastRefusal":{"evidence":"${q.entries[0]!.digest.slice(0, 12)}…"`), line);
    assert.ok(line?.includes(named), "the preview line names the transfer");
    assert.ok(line?.includes(`"pass":true`), "information only: the verdict is the preconditions'");
    assert.ok((r.entries[0] as { lastRefusal?: { reason: string } }).lastRefusal?.reason.endsWith(named), "the run row names it too");
  } finally { chainLogs = []; console.log = realLog; }
  await getGrantStore().remove(t.tenant); await getGrantStore().remove(u.tenant); await reconcile();
});

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicOf = (x: string) => `0x${x.slice(2).padStart(64, "0")}`;
/** A USDG deposit into `account` that Postgres does not hold, landed at `block`. */
const unbookedDeposit = (account: string, block: bigint, tx: string) =>
  ({ address: String(CASH.USDG), topics: [TRANSFER_TOPIC, topicOf(addr(0xfeed)), topicOf(account)], tx, index: 0, block });
const cursorsOf = (tenant: string) => rows("SELECT table_name, last_id, last_stamp, updated_at FROM mirror_state WHERE tenant = ? ORDER BY table_name", tenant);

it("activity landing after the chain read and before the registration refuses: the chain is read again, from that read's head to the head now", async () => {
  const t = await preIncident({ live: true });
  const p = await preview(t.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${p.entries[0]!.digest}` });
  await reconcile(); // Phase A starts the whole read; held meanwhile
  await resumeChecksSettledForTest(); // clean, through HEAD
  const cursors = cursorsOf(t.tenant);
  // Before the pass that archives and registers, the chain moves on and a
  // deposit Postgres lacks lands past the head that read reached.
  head = HEAD + 600n;
  chainLogs = [unbookedDeposit(t.account, HEAD + 300n, "0xlanded-late")];
  try {
    await reconcile(); await new Promise((r) => setTimeout(r, 20));
    const a = approval(t.tenant)!;
    assert.ok(a.archive_path, "Phase A archived the home on the clean read");
    assert.equal(a.state, "refused", "and Phase B's re-read refused what landed since");
    assert.match(String(a.reason), /Postgres lacks, landed after the admission's first chain read/);
    assert.ok(String(a.reason).endsWith(`: USDG in amount unread in tx 0xlanded-late log 0 at block ${HEAD + 300n}`), "and names what landed");
    assert.equal(forksOf(t.tenant).length, 0);
    assert.equal(rows("SELECT * FROM ledger_resume_attestations WHERE tenant = ?", t.tenant).length, 0, "nothing attested");
    assert.deepEqual(cursorsOf(t.tenant), cursors, "no cursor moved");
    assert.equal(rows("SELECT * FROM tenant_ledger_import WHERE tenant = ?", t.tenant).length, 0, "no new book registered");
  } finally { head = HEAD; chainLogs = []; }
  await getGrantStore().remove(t.tenant); await reconcile();
});

it("a clean chain read is not reused after a failed registration: the retry reads the whole window again first, and refuses what landed since", async () => {
  const t = await preIncident({ live: true });
  const p = await preview(t.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${p.entries[0]!.digest}` });
  await reconcile(); await resumeChecksSettledForTest(); // a clean whole read, through HEAD
  // The pass archives the home, re-reads clean, and its registration fails.
  const realTx = shared.tx.bind(shared);
  let failRegistration = true;
  (shared as { tx: typeof shared.tx }).tx = async (fn) => {
    if (failRegistration && approval(t.tenant)?.state === "archived") { failRegistration = false; throw new Error("process killed mid-registration"); }
    return realTx(fn);
  };
  try { await reconcile(); } finally { (shared as { tx: typeof shared.tx }).tx = realTx; }
  assert.equal(failRegistration, false, "the registration was attempted, and failed");
  assert.equal(approval(t.tenant)?.state, "archived");
  // A deposit Postgres lacks lands after that attempt; the earlier read is
  // still inside its freshness window.
  head = HEAD + 900n;
  chainLogs = [unbookedDeposit(t.account, HEAD + 700n, "0xlanded-after-failure")];
  const stamps = stampReads;
  try {
    await reconcile();
    assert.equal(approval(t.tenant)?.state, "archived", "the earlier clean read is not stood on: the retry is held for a whole read");
    assert.equal(rows("SELECT * FROM ledger_resume_attestations WHERE tenant = ?", t.tenant).length, 0);
    await resumeChecksSettledForTest();
    assert.ok(stampReads > stamps, "the whole window was read again, from its start");
    await reconcile(); await new Promise((r) => setTimeout(r, 20));
    assert.equal(approval(t.tenant)?.state, "refused");
    assert.match(String(approval(t.tenant)?.reason), /Postgres lacks/);
    assert.equal(forksOf(t.tenant).length, 0);
    assert.equal(rows("SELECT * FROM ledger_resume_attestations WHERE tenant = ?", t.tenant).length, 0);
  } finally { head = HEAD; chainLogs = []; }
  await getGrantStore().remove(t.tenant); await reconcile();
});

/**
 * The same chain, as the booking tool's JSON-RPC reads it: blocks dated as
 * the gap check dates them, each fixture log in a receipt of its transaction.
 */
const bookingRpc = async (method: string, params: unknown[]): Promise<unknown> => {
  const blockOf = (b: bigint) => ({ number: `0x${b.toString(16)}`, hash: `0x${b.toString(16).padStart(64, "b")}`,
    timestamp: `0x${(Math.floor(Date.now() / 1000) - Math.ceil(Number(head - b) / 10)).toString(16)}` });
  const logOf = (l: (typeof chainLogs)[number]) => ({ address: l.address, topics: l.topics, data: l.data ?? "0x", logIndex: `0x${l.index.toString(16)}`,
    blockNumber: `0x${(l.block ?? HEAD - 100n).toString(16)}`, transactionHash: l.tx });
  if (method === "eth_chainId") return "0x1237";
  if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
  if (method === "eth_getBlockByNumber") return blockOf(BigInt(params[0] as string));
  if (method === "eth_getLogs") {
    const f = params[0] as { address: `0x${string}`; fromBlock: string; toBlock: string; topics: (`0x${string}` | null)[] };
    return chain.getLogs({ address: f.address, fromBlock: BigInt(f.fromBlock), toBlock: BigInt(f.toBlock), topics: f.topics });
  }
  if (method === "eth_getTransactionReceipt") {
    const logs = chainLogs.filter((l) => l.tx === params[0]);
    if (!logs.length) return null;
    const block = logs[0]!.block ?? HEAD - 100n;
    return { status: "0x1", blockNumber: `0x${block.toString(16)}`, blockHash: blockOf(block).hash, from: addr(0xfeed), to: String(CASH.USDG), logs: logs.map(logOf) };
  }
  throw new Error(`unexpected ${method}`);
};

it("a tenant refused for a deposit Postgres lacks is booked by the chain-gap tool, previews again with new evidence, and is admitted", async () => {
  const { applyBooking, planBooking, readBookingSnapshot, readChainEvidence } = await import("./chain-gap-booking");
  const t = await preIncident({ live: true });
  const p = await preview(t.tenant);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${p.entries[0]!.digest}` });
  const depositTx = `0x${"de".repeat(32)}`;
  chainLogs = [{ address: String(CASH.USDG), topics: [TRANSFER_TOPIC, topicOf(addr(0xfeed)), topicOf(t.account)], tx: depositTx, index: 3, block: HEAD - 1_000n,
    data: `0x${(6_000_000n).toString(16).padStart(64, "0")}` }];
  try {
    await reconcile(); await settle();
    assert.equal(approval(t.tenant)?.state, "refused");
    assert.match(String(approval(t.tenant)?.reason), new RegExp(`: USDG in 6\\.000000 in tx ${depositTx} log 3 at block ${HEAD - 1_000n}$`));
    const before = financial(t.account);

    // THE BOOKING, as the operator runs it: the preview against the same
    // books and chain, then the apply of exactly the digest reviewed.
    const snap = await readBookingSnapshot(shared, { tenant: t.tenant, dialect: "sqlite", nowSec: nowSec() });
    const plan = planBooking(snap, await readChainEvidence(bookingRpc, snap, { sleep: async () => {} }), { nowSec: nowSec(), source: { test: 1 }, target: "integration" });
    assert.equal(plan.verdict, "ready");
    assert.deepEqual(plan.items.map((i) => i.class), ["deposit"]);
    await applyBooking(shared, plan, { confirm: plan.previewDigest, backupRef: "integration-backup-1", dialect: "sqlite", nowMs: Date.now() });
    const after = financial(t.account);
    assert.deepEqual(after.trades, before.trades, "no trade row touched");
    assert.deepEqual(after.agents, before.agents, "no peak, epoch or fee moved");
    assert.deepEqual(after.flows.slice(0, -1), before.flows);
    assert.deepEqual((({ id: _id, ...rest }) => rest)(after.flows.at(-1)!), { agent_id: t.account, direction: "in", amount_usdg: 6, tx_hash: depositTx,
      block_number: Number(HEAD - 1_000n), log_index: 3, source: "chain-log", epoch: 2, chain_id: 4663, at: plan.items[0]!.evidence.blockTime });

    // THE RE-PREVIEW PASSES, on new evidence, and the approval of that
    // evidence admits the tenant: its chain check now finds nothing missing.
    const q = await preview(t.tenant);
    assert.deepEqual({ pass: q.entries[0]!.pass, refusals: q.entries[0]!.refusals }, { pass: true, refusals: [] });
    assert.notEqual(q.entries[0]!.digest, p.entries[0]!.digest, "the booked flow is in the evidence");
    await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${q.entries[0]!.digest}` });
    await reconcile(); await settle();
    assert.equal(approval(t.tenant)?.state, "applied");
    assert.equal(forksOf(t.tenant).length, 1, "admitted through the ordinary path");
  } finally { chainLogs = []; }
  await getGrantStore().remove(t.tenant); await reconcile();
});

/** What the orchestrator says while `fn` runs. MERRYMEN_TEST_VERBOSE=1 prints it as well. */
async function sayings<T>(fn: (said: string[]) => Promise<T>): Promise<T> {
  const said: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ").replace(/^\[orchestrator\] /, "")); if (process.env.MERRYMEN_TEST_VERBOSE === "1") realLog(...a); };
  try { return await fn(said); } finally { console.log = realLog; }
}
const approvalsOf = (tenant: string) => rows("SELECT state, reason, updated_at_ms FROM ledger_resume_approvals WHERE tenant = ? ORDER BY created_at_ms, rowid", tenant);

it("a paper tenant held on a chain refusal no admission has answered: the lane leaves it, a hand approval reads the chain and is refused afresh, the booking tool books on that, and the fresh digest admits it", async () => {
  const { applyBooking, holdOf, planBooking, readBookingSnapshot, readChainEvidence } = await import("./chain-gap-booking");
  const { getSettingsStore } = await import("./settings-store");
  const t = await preIncident({ live: false });
  // A paper book that holds nothing: the automatic lane's safe case, but for what the chain shows.
  for (const table of ["positions", "cost_basis", "position_floors"]) raw.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(t.account);
  const depositTx = `0x${"d7".repeat(32)}`;
  chainLogs = [{ address: String(CASH.USDG), topics: [TRANSFER_TOPIC, topicOf(addr(0xfeed)), topicOf(t.account)], tx: depositTx, index: 2, block: HEAD - 1_000n,
    data: `0x${(9_000_000n).toString(16).padStart(64, "0")}` }];
  const named = `USDG in 9.000000 in tx ${depositTx} log 2 at block ${HEAD - 1_000n}`;
  let chainOpens = 0;
  setResumeChainForTest(() => { chainOpens += 1; return chain; });
  try {
    await sayings(async (said) => {
      // 1. Its owner's settings asked for the live rail: read on chain, and refused for the deposit Postgres lacks.
      await getSettingsStore().put(t.tenant, { liveTradingEnabled: true } as never);
      const p1 = await preview(t.tenant);
      assert.deepEqual([p1.entries[0]!.pass, p1.entries[0]!.chain], [true, "required"]);
      await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${p1.entries[0]!.digest}` });
      await reconcile(); await settle();
      assert.equal(approval(t.tenant)?.reason, `${CHAIN_REFUSAL}: ${named}`);

      // 2. A later refusal for another reason supersedes it: approved again, and its evidence changes before admission runs.
      raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 1, 0, 0, 1, ?, 2, 'paper')").run(t.account, OLD + 7);
      const p2 = await preview(t.tenant);
      await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${p2.entries[0]!.digest}` });
      raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 1, 0, 0, 1, ?, 2, 'paper')").run(t.account, OLD + 8);
      await reconcile();
      assert.deepEqual(approvalsOf(t.tenant).map((a) => a.state), ["refused", "refused"]);
      assert.match(String(approval(t.tenant)?.reason), /evidence changed/);
      // The booking tool has nothing to book on — its newest decision is not a chain refusal — and says what to do.
      const superseded = holdOf(await readBookingSnapshot(shared, { tenant: t.tenant, dialect: "sqlite", nowSec: nowSec() }), nowSec());
      assert.equal(superseded.anchorSec, null);
      assert.match(superseded.refusals.join(" "), /refused for another reason\) is not a chain refusal: .*An earlier approval was refused on the chain: preview the tenant in admission's preview and approve the digest it prints once, .*fresh chain refusal; then take it out of the rollout and preview here again$/);

      // 3. Its owner turns live trading off and signs again: it reads as paper, holding nothing. The automatic lane previews it and leaves it,
      //    never offering the approval of its digest as a way to trade, and reads no chain.
      process.env.MERRYMEN_RESUME_AUTO_PAPER = "1";
      try {
        await reconcile(); // the lane's first pass: the roster as it stands, nobody's re-sign
        await getSettingsStore().put(t.tenant, { liveTradingEnabled: false } as never);
        const opens = chainOpens, from = said.length;
        await putGrant(t.tenant, { ...grant(t.account, t.owner, 2), expiresAt: nowSec() + 86_400 + 77 } as StoredGrant);
        await reconcile(); await reconcile();
        const w = rows("SELECT owed, outcome, run FROM ledger_resume_grant_watch WHERE tenant = ?", t.tenant)[0]!;
        assert.equal(w.owed, 0, "answered");
        assert.match(String(w.outcome), /^previewed: .*admission refused it on the chain/);
        assert.deepEqual(approvalsOf(t.tenant).map((a) => a.state), ["refused", "refused"], "never approved by the lane");
        assert.equal(chainOpens, opens, "the lane reads no chain");
        const lane = said.slice(from);
        assert.ok(!lane.some((l) => l.includes(`MERRYMEN_RESUME_APPROVE=${t.tenant}:`)), lane.join("\n"));
        assert.ok(lane.some((l) => l.startsWith(`resume auto-paper: ${t.tenant} re-signed and previewed`) && l.includes("Held on a chain refusal: an approval does not make it trade")));
        const [entry] = JSON.parse(String(rows("SELECT entries_json FROM ledger_resume_preview_runs WHERE run = ?", w.run)[0]!.entries_json)) as
          Array<{ pass: boolean; chain: string; chainHeld?: boolean; digest: string }>;
        assert.deepEqual([entry!.pass, entry!.chain, entry!.chainHeld], [true, "required", true]);

        // 4. The operator approves that digest by hand while Postgres still lacks the deposit: admission reads the chain, and refuses
        //    the tenant afresh on it, with its home untouched.
        delete process.env.MERRYMEN_RESUME_AUTO_PAPER;
        const home = readdirSync(t.home).sort();
        await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${entry!.digest}` });
        assert.equal(approval(t.tenant)?.state, "approved");
        await reconcile(); await settle();
        assert.ok(chainOpens > opens, "the chain was read, though it reads as paper");
        const fresh = approvalsOf(t.tenant).at(-1)!;
        assert.deepEqual([fresh.state, fresh.reason], ["refused", `${CHAIN_REFUSAL}: ${named}`], "a fresh chain refusal, naming what is still missing");
        assert.ok(said.slice(from).some((l) => l === `[alert] ${t.tenant}: resume approval REFUSED — ${CHAIN_REFUSAL}: ${named}. The tenant stays held; ` +
          "take it out of MERRYMEN_FLEET_ROLLOUT and book what the chain shows (docs/chain-gap-booking.md), then preview again and approve the digest that preview prints"),
          "its alert says to book it, not to approve again");
        assert.equal(forksOf(t.tenant).length, 0, "never admitted on the book the chain showed incomplete");
        assert.deepEqual(readdirSync(t.home).sort(), home, "its home untouched");
        assert.equal(readFileSync(path.join(t.home, "grant.json"), "utf8"), "OLD SESSION KEY");
        assert.equal(rows("SELECT * FROM ledger_resume_attestations WHERE tenant = ?", t.tenant).length, 0);

        // 5. The booking tool anchors on that refusal now, and books the deposit.
        const snap = await readBookingSnapshot(shared, { tenant: t.tenant, dialect: "sqlite", nowSec: nowSec() });
        assert.deepEqual(holdOf(snap, nowSec()), { anchorSec: Math.floor(Number(fresh.updated_at_ms) / 1000), refusals: [] });
        const plan = planBooking(snap, await readChainEvidence(bookingRpc, snap, { sleep: async () => {} }), { nowSec: nowSec(), source: { test: 2 }, target: "integration" });
        assert.equal(plan.verdict, "ready");
        assert.deepEqual(plan.items.map((i) => i.class), ["deposit"]);
        await applyBooking(shared, plan, { confirm: plan.previewDigest, backupRef: "integration-backup-2", dialect: "sqlite", nowMs: Date.now() });

        // 6. Previewed again: new evidence, still read on chain until an admission answers the refusal, and never offered to the batch as a
        //    way to trade. Approved, its chain read is clean and it is admitted, on a chain window.
        const at = said.length;
        const q = await preview(t.tenant);
        const qe = q.entries[0]! as (typeof q.entries)[number] & { chainHeld?: boolean };
        assert.deepEqual([qe.pass, qe.chain, qe.chainHeld], [true, "required", true]);
        assert.notEqual(qe.digest, entry!.digest, "the booked flow is in the evidence");
        const summary = said.slice(at).filter((l) => l.startsWith("[resume-preview] ") && !l.startsWith("[resume-preview] {"));
        assert.ok(summary.some((l) => l === `[resume-preview] approve every passing tenant of this run with MERRYMEN_RESUME_APPROVE=run:${q.run} — for the 1 held on ` +
          "a chain refusal (chainHeld, below) that is a chain read, not a way to trade"), summary.join("\n"));
        assert.ok(summary.some((l) => l.startsWith(`[resume-preview] 1 passing tenant(s) held on a chain refusal no admission has answered: ${t.tenant} — for each, ` +
          "an approval does not make it trade until what the chain showed is booked, because admission reads the chain again from where the refused read began. " +
          "Take it out of MERRYMEN_FLEET_ROLLOUT and book it first (docs/chain-gap-booking.md)")), summary.join("\n"));
        await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${qe.digest}` });
        await reconcile(); await settle();
        assert.equal(approval(t.tenant)?.state, "applied");
        assert.equal(forksOf(t.tenant).length, 1, "admitted through the ordinary path");
        assert.equal(rows("SELECT chain_head FROM ledger_resume_attestations WHERE tenant = ?", t.tenant)[0]?.chain_head, String(HEAD), "on a chain read");
        // That admission answers the refusal.
        const done = await preview(t.tenant);
        assert.equal((done.entries[0] as { chainHeld?: boolean }).chainHeld, false);
      } finally { delete process.env.MERRYMEN_RESUME_AUTO_PAPER; }
    });
  } finally { chainLogs = []; setResumeChainForTest(() => chain); }
  await getGrantStore().remove(t.tenant); await reconcile();
});

it("a tenant held on a chain refusal is admitted only on a chain read that answers: an unreadable chain, no RPC, or an unreadable refusal lookup holds it", async () => {
  const t = await preIncident({ live: false });
  for (const table of ["positions", "cost_basis", "position_floors"]) raw.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(t.account);
  // Refused on the chain at an earlier admission, as admission records it; the owner's settings ask for nothing live.
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_PREVIEW: t.tenant }); // the resume tables
  raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state,
      created_at_ms, updated_at_ms, reason, source, chain_read_from_sec) VALUES ('held-e', ?, ?, 4663, ?, ?, '{}', ?, 'refused', ?, ?, ?, 'operator', ?)`)
    .run(t.tenant, t.account, t.owner, "f".repeat(64), "e".repeat(64), Date.now() - 60_000, Date.now() - 60_000,
      chainRefusal([{ kind: "transfer", txHash: `0x${"de".repeat(32)}`, block: "7", logIndex: 1, direction: "in", amountRaw: "5000000", counterparty: addr(0xfeed) }]),
      nowSec() - 41 * 3600);
  const p = await preview(t.tenant);
  assert.deepEqual([p.entries[0]!.pass, p.entries[0]!.chain, (p.entries[0] as { chainHeld?: boolean }).chainHeld], [true, "required", true]);
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${p.entries[0]!.digest}` });
  const home = readdirSync(t.home).sort();
  const unmoved = (why: string) => {
    assert.equal(approval(t.tenant)?.state, "approved", why);
    assert.equal(forksOf(t.tenant).length, 0, why);
    assert.deepEqual(readdirSync(t.home).sort(), home, why);
    assert.equal(rows("SELECT * FROM ledger_resume_attestations WHERE tenant = ?", t.tenant).length, 0, why);
  };
  // The chain cannot be read: held, and asked again — never admitted on the paper reading meanwhile.
  chainDown = true;
  try { await reconcile(); await settle(); await settle(); } finally { chainDown = false; }
  unmoved("an unreadable chain");
  // No RPC for the chain at all: held, and said.
  await sayings(async (said) => {
    setResumeChainForTest(() => null);
    try { await reconcile(); } finally { setResumeChainForTest(() => chain); }
    assert.ok(said.some((l) => l.includes(`${t.tenant}: resume admission needs a chain read and this orchestrator has no RPC for chain 4663 — held`)), said.join("\n"));
  });
  unmoved("no RPC");
  // The refusal lookup itself fails: admission defers, and a preview does not pass.
  const realPrepare = shared.prepare.bind(shared);
  (shared as { prepare: typeof shared.prepare }).prepare = (sql: string) => {
    if (/^SELECT approval_id, state, reason, created_at_ms, updated_at_ms, evidence_json/.test(sql)) throw Object.assign(new Error("connection reset"), { code: "08006" });
    return realPrepare(sql);
  };
  try {
    await sayings(async (said) => {
      await reconcile();
      assert.ok(said.some((l) => l.startsWith(`[alert] ${t.tenant}: resume admission deferred`)), said.join("\n"));
    });
    unmoved("an unreadable refusal lookup");
    const r = await preview(t.tenant);
    assert.deepEqual([r.entries[0]!.pass, r.entries[0]!.digest], [false, null]);
    assert.match(r.entries[0]!.refusals.join(" "), /could not be read/);
  } finally { (shared as { prepare: typeof shared.prepare }).prepare = realPrepare; }
  // Read cleanly, the chain now shows nothing Postgres lacks: that read is what admits it.
  await reconcile(); await settle();
  assert.equal(approval(t.tenant)?.state, "applied");
  assert.equal(forksOf(t.tenant).length, 1);
  assert.equal(rows("SELECT chain_head FROM ledger_resume_attestations WHERE tenant = ?", t.tenant)[0]?.chain_head, String(HEAD));
  await getGrantStore().remove(t.tenant); await reconcile();
});

/**
 * A day passes, by this process's clock and by the chain's: every reader here
 * (the orchestrator, the fake chain, the booking tool) takes the time from
 * Date.now(), and the head moves at the chain's ten blocks a second.
 */
async function aDayOn<T>(hours: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + hours * 3_600_000;
  head = HEAD + BigInt(hours) * 3600n * 10n;
  try { return await fn(); } finally { Date.now = realNow; head = HEAD; }
}
const refusalsOf = (tenant: string) =>
  rows("SELECT approval_id, state, reason, updated_at_ms, chain_read_from_sec FROM ledger_resume_approvals WHERE tenant = ? ORDER BY created_at_ms, rowid", tenant);

for (const recorded of ["as this build records it", "as an earlier build left it, with no start recorded"] as const) {
  it(`a chain-held tenant is read from where its refused read began however late (the refusal ${recorded}): a deposit older than every cursor stays in the window a day on — booked, refused again, then admitted`, async () => {
    const { applyBooking, holdOf, planBooking, readBookingSnapshot, readChainEvidence } = await import("./chain-gap-booking");
    const { getSettingsStore } = await import("./settings-store");
    const t = await preIncident({ live: false });
    for (const table of ["positions", "cost_basis", "position_floors"]) raw.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(t.account);
    // EVERY FINANCIAL CURSOR RECENT: the last mirror copied rows two hours ago, so the read starts 26 hours back, not at a cursor.
    raw.prepare("UPDATE mirror_state SET updated_at = ?, last_stamp = ? WHERE tenant = ?").run(nowSec() - 2 * 3600, nowSec() - 3 * 3600, t.tenant);
    // A 9 USDG deposit twenty hours ago, older than every cursor, that Postgres lacks.
    const depositBlock = HEAD - 20n * 3600n * 10n, depositTx = `0x${"5e".repeat(32)}`;
    chainLogs = [{ address: String(CASH.USDG), topics: [TRANSFER_TOPIC, topicOf(addr(0xfeed)), topicOf(t.account)], tx: depositTx, index: 4, block: depositBlock,
      data: `0x${(9_000_000n).toString(16).padStart(64, "0")}` }];
    const named = `USDG in 9.000000 in tx ${depositTx} log 4 at block ${depositBlock}`;
    const depositAt = nowSec() - 20 * 3600;
    try {
      // 1. Its owner's settings asked for live trading: read on chain, and refused for the deposit, with where that read began.
      await getSettingsStore().put(t.tenant, { liveTradingEnabled: true } as never);
      const p1 = await preview(t.tenant);
      await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${p1.entries[0]!.digest}` });
      await reconcile(); await settle();
      const r1 = refusalsOf(t.tenant).at(-1)!;
      assert.deepEqual([r1.state, r1.reason], ["refused", `${CHAIN_REFUSAL}: ${named}`]);
      assert.ok(Number(r1.chain_read_from_sec) <= nowSec() - 26 * 3600 - 600, "the refusal records where its read began: 26 hours back, before the deposit");
      if (recorded !== "as this build records it") raw.prepare("UPDATE ledger_resume_approvals SET chain_read_from_sec = NULL WHERE approval_id = ?").run(String(r1.approval_id));

      // 2. Its owner turns live trading off. A day on: twenty hours by the clock and the chain, and a row lands that changes its evidence.
      await getSettingsStore().put(t.tenant, { liveTradingEnabled: false } as never);
      await aDayOn(20, async () => {
        raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 1, 0, 0, 1, ?, 2, 'paper')").run(t.account, OLD + 11);
        assert.ok(nowSec() - 26 * 3600 > depositAt, "26 hours back from now is past the deposit: the window used to start after it");

        // 3. The booking tool anchors on that refusal and still lists the deposit (it used to say nothing is missing).
        const snap = await readBookingSnapshot(shared, { tenant: t.tenant, dialect: "sqlite", nowSec: nowSec() });
        assert.equal(holdOf(snap, nowSec()).anchorSec, Math.floor(Number(r1.updated_at_ms) / 1000));
        assert.ok(snap.gapFromSec < depositAt, `the booking tool reads from ${snap.gapFromSec}, before the deposit at ${depositAt}`);
        const plan = planBooking(snap, await readChainEvidence(bookingRpc, snap, { sleep: async () => {} }), { nowSec: nowSec(), source: { test: 3 }, target: "integration" });
        assert.deepEqual([plan.verdict, plan.items.map((i) => i.class)], ["ready", ["deposit"]]);

        // 4. Previewed, it is still held; approved by hand before anything is booked, admission reads from where the refused read began and refuses again.
        const p2 = await preview(t.tenant);
        const e2 = p2.entries[0]! as (typeof p2.entries)[number] & { chainHeld?: boolean };
        assert.deepEqual([e2.pass, e2.chain, e2.chainHeld], [true, "required", true]);
        const home = readdirSync(t.home).sort();
        await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${e2.digest}` });
        assert.equal(approval(t.tenant)?.state, "approved");
        await reconcile(); await settle();
        const r2 = refusalsOf(t.tenant).at(-1)!;
        assert.deepEqual([r2.state, r2.reason], ["refused", `${CHAIN_REFUSAL}: ${named}`], "refused afresh for the same deposit — never admitted without it");
        assert.ok(Number(r2.chain_read_from_sec) < depositAt, "from before the deposit");
        assert.equal(forksOf(t.tenant).length, 0);
        assert.deepEqual(readdirSync(t.home).sort(), home, "its home untouched");
        assert.equal(rows("SELECT * FROM ledger_resume_attestations WHERE tenant = ?", t.tenant).length, 0);
        assert.equal(rows("SELECT * FROM flows WHERE agent_id = ? AND tx_hash = ?", t.account, depositTx).length, 0);

        // 5. Booked on that fresh refusal, previewed and approved: admitted on a chain read whose window covers the deposit.
        const snap2 = await readBookingSnapshot(shared, { tenant: t.tenant, dialect: "sqlite", nowSec: nowSec() });
        assert.equal(holdOf(snap2, nowSec()).anchorSec, Math.floor(Number(r2.updated_at_ms) / 1000));
        const plan2 = planBooking(snap2, await readChainEvidence(bookingRpc, snap2, { sleep: async () => {} }), { nowSec: nowSec(), source: { test: 4 }, target: "integration" });
        assert.deepEqual([plan2.verdict, plan2.items.map((i) => i.class)], ["ready", ["deposit"]]);
        await applyBooking(shared, plan2, { confirm: plan2.previewDigest, backupRef: "integration-backup-3", dialect: "sqlite", nowMs: Date.now() });
        const p3 = await preview(t.tenant);
        assert.notEqual(p3.entries[0]!.digest, e2.digest);
        await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${p3.entries[0]!.digest}` });
        await reconcile(); await settle();
        assert.equal(approval(t.tenant)?.state, "applied");
        assert.equal(forksOf(t.tenant).length, 1, "admitted through the ordinary path");
        const attested = rows("SELECT chain_from_block, chain_head FROM ledger_resume_attestations WHERE tenant = ?", t.tenant)[0]!;
        assert.ok(BigInt(String(attested.chain_from_block)) < depositBlock, "on a chain window that covers the deposit");
        assert.equal(rows("SELECT * FROM flows WHERE agent_id = ? AND tx_hash = ?", t.account, depositTx).length, 1, "booked");
      });
    } finally { chainLogs = []; }
    await getGrantStore().remove(t.tenant); await reconcile();
  });
}

it("every decision of a held tenant changes its digest: refused on the chain while live, then for stale evidence, then turned paper — the preview's digest is approvable, reads the chain, and refuses afresh", async () => {
  const { holdOf, readBookingSnapshot } = await import("./chain-gap-booking");
  const { getSettingsStore } = await import("./settings-store");
  const t = await preIncident({ live: false });
  for (const table of ["positions", "cost_basis", "position_floors"]) raw.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(t.account);
  const depositTx = `0x${"c4".repeat(32)}`;
  chainLogs = [{ address: String(CASH.USDG), topics: [TRANSFER_TOPIC, topicOf(addr(0xfeed)), topicOf(t.account)], tx: depositTx, index: 1, block: HEAD - 2_000n,
    data: `0x${(3_000_000n).toString(16).padStart(64, "0")}` }];
  let chainOpens = 0;
  setResumeChainForTest(() => { chainOpens += 1; return chain; });
  try {
    await sayings(async (said) => {
      // R1: live trading on, so the evidence reads chain:required already; approved, and refused on the chain.
      await getSettingsStore().put(t.tenant, { liveTradingEnabled: true } as never);
      const d0 = (await preview(t.tenant)).entries[0]!.digest;
      raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 1, 0, 0, 1, ?, 2, 'paper')").run(t.account, OLD + 21);
      const d1 = (await preview(t.tenant)).entries[0]!.digest;
      await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${d1}` });
      await reconcile(); await settle();
      assert.match(String(approval(t.tenant)?.reason), new RegExp(`^${CHAIN_REFUSAL}: `));
      // R2: the stale d0 approved, and refused for evidence that changed.
      await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${d0}` });
      await reconcile();
      assert.deepEqual(refusalsOf(t.tenant).map((r) => r.state), ["refused", "refused"]);
      assert.match(String(approval(t.tenant)?.reason), /evidence changed/);
      // Its owner turns live trading off: it reads chain:required for the hold now, not the intent — and its digest is not d1's.
      await getSettingsStore().put(t.tenant, { liveTradingEnabled: false } as never);
      const p3 = await preview(t.tenant);
      const e3 = p3.entries[0]! as (typeof p3.entries)[number] & { chainHeld?: boolean };
      assert.deepEqual([e3.pass, e3.chain, e3.chainHeld], [true, "required", true]);
      assert.notEqual(e3.digest, d1, "the refused digest is never printed again");
      // The refused d1, approved again from an old line: nothing is recorded, and it is said.
      const from = said.length;
      await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${d1}` });
      assert.deepEqual(refusalsOf(t.tenant).map((r) => r.state), ["refused", "refused"]);
      assert.ok(said.slice(from).some((l) => l.startsWith(`[alert] resume approval: ${t.tenant} is held on a chain refusal no admission has answered, and an approval of this exact evidence refused`)),
        said.slice(from).join("\n"));
      // The digest the preview printed is approved, reads the chain, and records a fresh chain refusal the booking tool anchors on.
      const opens = chainOpens;
      await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `${t.tenant}:${e3.digest}` });
      assert.equal(approval(t.tenant)?.state, "approved", "recorded");
      await reconcile(); await settle();
      assert.ok(chainOpens > opens, "the chain was read, though it reads as paper");
      const r3 = refusalsOf(t.tenant).at(-1)!;
      assert.match(String(r3.reason), new RegExp(`^${CHAIN_REFUSAL}: `));
      assert.equal(forksOf(t.tenant).length, 0);
      const snap = await readBookingSnapshot(shared, { tenant: t.tenant, dialect: "sqlite", nowSec: nowSec() });
      assert.equal(holdOf(snap, nowSec()).anchorSec, Math.floor(Number(r3.updated_at_ms) / 1000));
    });
  } finally { chainLogs = []; setResumeChainForTest(() => chain); }
  await getGrantStore().remove(t.tenant); await reconcile();
});

it("a paper tenant needs no chain read; evidence that changed after the preview refuses with nothing moved", async () => {
  const t = await preIncident({ live: false });
  const p = await preview(t.tenant);
  assert.equal(p.entries[0]!.chain, "not-required");
  assert.equal(p.entries[0]!.suggestedLevel, "trade");
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${p.run}` });
  // Something lands in the books after the operator looked — and a preview taken then shows it, before admission has run.
  raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 1, 0, 0, 1, ?, 2, 'paper')").run(t.account, OLD + 5);
  const seen = await preview(t.tenant);
  await reconcile();
  assert.equal(approval(t.tenant)?.state, "refused");
  assert.match(String(approval(t.tenant)?.reason), /evidence changed/);
  assert.equal(existsSync(path.join(t.home, "grant.json")), true);
  assert.equal(rows("SELECT * FROM mirror_state WHERE tenant = ?", t.tenant).length, 3);
  // Previewed again and approved again, it is admitted with no chain read at all: a refusal for anything but the chain holds nothing on it.
  const again = await preview(t.tenant);
  assert.deepEqual([again.entries[0]!.chain, (again.entries[0] as { chainHeld?: boolean }).chainHeld, again.entries[0]!.suggestedLevel], ["not-required", false, "trade"]);
  // The same evidence as the preview taken before the refusal, so the same run: its recorded row now says that refusal, not the reading before it.
  assert.equal(again.run, seen.run);
  const stored = JSON.parse(String(rows("SELECT entries_json FROM ledger_resume_preview_runs WHERE run = ?", again.run)[0]!.entries_json)) as
    Array<{ lastRefusal?: { reason: string } | null }>;
  assert.match(String(stored[0]!.lastRefusal?.reason), /evidence changed/);
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

it("the preview says a durable pause starts the worker paused, unless the owner's mirrored /resume is newer than it", async () => {
  const t = await preIncident({ live: false });
  rmSync(path.join(t.home, "paused")); // a home never armed, with no pause file of its own
  const startsPaused = async () => {
    // A run is recorded once per digest, and the digest binds the evidence,
    // not the pause: drop this tenant's earlier runs so each preview is read.
    raw.prepare("DELETE FROM ledger_resume_preview_runs WHERE entries_json LIKE ?").run(`%${t.tenant}%`);
    const p = await preview(t.tenant);
    return (p.entries[0] as unknown as { startsPaused: boolean | null }).startsPaused;
  };
  assert.equal(await startsPaused(), false, "nothing on record");
  const stamp = nowSec() - 600;
  raw.prepare("INSERT INTO tenant_telegram (tenant, updated_at, paused_at) VALUES (?, ?, ?)").run(t.tenant, stamp, stamp);
  raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', 'Telegram: paused by chat 7 — sent while trading was held (recorded during upgrade)', ?)").run(t.account, stamp);
  assert.equal(await startsPaused(), true, "a durable pause over a home never armed");
  raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', 'Telegram: resumed by chat 7', ?)").run(t.account, stamp + 60);
  assert.equal(await startsPaused(), false, "the owner's /resume, mirrored after it, lifts it");
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
