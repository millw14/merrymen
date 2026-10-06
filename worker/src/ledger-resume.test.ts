/**
 * ATTESTED-GAP ADMISSION, PIECE BY PIECE: the operator variables, the
 * evidence, every precondition on its own, the chain read, the approvals, the
 * home archive and the one-transaction registration.
 *
 * Real sqlite books and a real sqlite shared database with the ledger schema;
 * the chain is a fake that answers getLogs from a list. The end-to-end path
 * through reconcile() is orchestrator-ledger-resume.integration.test.ts.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { ensureLedgerResumeSchema, registerAttestedGapSource, registerLedgerSource, restoreLedgerImport, type LedgerImportVolume } from "./ledger-import";
import type { TenantLease } from "./tenant-lease";
import { handoffRecoveryReplyOffset } from "./recovery-reply-handoff";
import { RECOVERY_REPLY_SCHEMA } from "./recovery-reply-state";
import {
  applyResumeApprovals, archiveTenantHome, chainGapCheck, completeAttestedSeed, homeIdentity, knownChainFacts, moveApproval, normaliseCarriedFile, parseResumeApprovals,
  parseResumePreview, parseResumeRevokes, planAttestedSeed, readOpenApproval, readResumeEvidence, recordPreviewRun, resumePreconditions, revokeResumeApprovals,
  AUTO_PAPER_HEADROOM, autoPaperRoom, autoPaperVerdict, countOpenApprovals, evidenceHasHistory, grantRowKey, observeGrantChanges, parseResumeAutoPaper,
  noteGrantAttempt, recordResumeApproval, resumeAutoPaperOn, settleGrantChange, AUTO_PAPER_RECORD_ALERT_AFTER, AUTO_PAPER_RECORD_MAX_WAIT, autoPaperRecordWait,
  type GapChain, type PreviewEntry,
} from "./ledger-resume";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-ledger-resume-")));
const handles: DatabaseSync[] = [];
after(() => { for (const h of handles) h.close(); rmSync(root, { recursive: true, force: true }); });
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const NOW = 1_800_000_000;
const OLD = NOW - 5 * 86_400;
const CONTROLS = { readable: true, why: null, digest: "c".repeat(64) };
/** The deployment's live-trading consent in force, as everywhere but a migration (settings.ts enforceLiveIntent). */
const ENFORCED = { consentEnforced: true };
let fixtures = 0;

/** `db`, except that every statement matching `pattern` fails with `error`: an outage, or schema drift, in one read. */
function failing(db: Db, pattern: RegExp, error: () => Error = () => Object.assign(new Error("connection reset"), { code: "08006" })): Db {
  const fail = async (): Promise<never> => { throw error(); };
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") return (sql: string) => (pattern.test(sql) ? { run: fail, get: fail, all: fail } : target.prepare(sql));
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A shared database with one tenant's pre-incident history: a paper or live book, its cursors, its snapshots. */
async function fixture(o: { live?: boolean } = {}) {
  const id = ++fixtures, tenant = addr(0x7000 + id), account = addr(0xacc000 + id), owner = addr(0x9000 + id);
  const raw = new DatabaseSync(":memory:"); handles.push(raw);
  const shared = wrapSqlite(raw);
  await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL); await shared.exec(PAPER_CHECKPOINT_SCHEMA);
  raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY,grant_json TEXT NOT NULL,updated_at INTEGER NOT NULL,row_version INTEGER NOT NULL)");
  raw.prepare("INSERT INTO grants VALUES(?,?,1000,10)").run(tenant, JSON.stringify({ smartAccount: account, owner, chainId: 4663 }));
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 2, 120, ?)`).run(account, owner, addr(1), o.live ? "live" : "paper");
  if (o.live) {
    raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, user_op_hash, tx_hash, epoch)
      VALUES (?, 'swap', 'x', 5, 'landed', ?, '0xop1', '0xtx1', 2)`).run(account, OLD);
    raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, at, epoch, chain_id)
      VALUES (?, 'in', 100, '0xdep1', 10, 3, 'deposit', ?, 2, 4663)`).run(account, OLD);
  } else {
    raw.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, epoch) VALUES (?, 'swap', 'x', 5, 'paper', ?, 2)").run(account, OLD);
  }
  raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 90, 0, 10, 100, ?, 2, ?)")
    .run(account, OLD, o.live ? "live" : "paper");
  raw.prepare("INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, value_usdg, updated_at) VALUES (?, 'COIN', ?, '10', '1', 1, 10, ?)").run(account, addr(5), OLD);
  raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'COIN', '10', '20', ?)").run(account, OLD);
  raw.prepare("INSERT INTO position_floors VALUES (?, 'live', 'COIN', 1500, 'r1', 'entry', ?)").run(account, OLD);
  raw.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, 'trades', 40, ?, ?)").run(tenant, OLD, NOW - 40 * 3600);
  raw.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, 'events', 90, ?, ?)").run(tenant, OLD, NOW - 40 * 3600);
  const pre = (account: string) => resumePreconditions(shared, { tenant, account, grantAccount: account, nowSec: NOW, controls: CONTROLS, homePendingImport: false });
  return { id, tenant, account, owner, raw, shared, pre: () => pre(account) };
}

describe("the operator variables", () => {
  it("parse, and refuse anything malformed rather than guess", () => {
    assert.equal(parseResumePreview(undefined), null);
    assert.deepEqual(parseResumePreview("all"), { scope: "all" });
    assert.deepEqual([...((parseResumePreview(`${addr(1).toUpperCase().replace("0X", "0x")},${addr(2)}`) as { tenants: ReadonlySet<string> }).tenants)], [addr(1), addr(2)]);
    assert.throws(() => parseResumePreview("everyone"), /entry 1/);
    assert.throws(() => parseResumePreview(`${addr(1)},`), /entry 2/);
    const d = "a".repeat(64);
    assert.deepEqual(parseResumeApprovals(`${addr(1)}:${d},run:${"b".repeat(64)}`), [{ kind: "tenant", tenant: addr(1), digest: d }, { kind: "run", run: "b".repeat(64) }]);
    assert.throws(() => parseResumeApprovals(`${addr(1)}:${d},${addr(1)}:${"c".repeat(64)}`), /repeats/);
    assert.throws(() => parseResumeApprovals(`${addr(1)}`), /entry 1/);
    assert.throws(() => parseResumeApprovals("run:abc"), /entry 1/);
    assert.deepEqual(parseResumeRevokes(`${addr(3)}:${d},run:${"b".repeat(64)}`), [{ kind: "tenant", tenant: addr(3), digest: d }, { kind: "run", run: "b".repeat(64) }]);
    assert.throws(() => parseResumeRevokes("0x12"), /entry 1/);
    // A bare tenant is refused: left set across boots it withdrew the re-approval too.
    assert.throws(() => parseResumeRevokes(addr(3)), /entry 1 is not 0x<tenant>:<evidence digest>/);
    assert.throws(() => parseResumeRevokes(`${addr(3)}:${d},${addr(3)}:${d}`), /repeats/);
  });
});

describe("the preconditions", () => {
  it("a clean pre-incident tenant passes, and says whether its account needs a chain read", async () => {
    const paper = await fixture();
    const p = await paper.pre();
    assert.deepEqual(p.refusals, []);
    assert.deepEqual({ paper: p.paper, chain: p.chainRequired, level: p.suggestedLevel, anchor: p.anchor, risk: p.riskPeriod },
      { paper: true, chain: false, level: "trade", anchor: "established:epoch-2", risk: "none" });
    const live = await fixture({ live: true });
    const l = await live.pre();
    assert.deepEqual(l.refusals, []);
    assert.deepEqual({ paper: l.paper, chain: l.chainRequired, level: l.suggestedLevel, held: l.holdsPositions }, { paper: false, chain: true, level: "exits-only", held: true });
    assert.equal(l.gapFromSec, NOW - 40 * 3600 - 600, "read from the last mirror pass, since it is older than 26h");
  });

  // Each defect alone, on an otherwise clean tenant: exactly one refusal, and the right one.
  const alone: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => void | Promise<void>, RegExp]> = [
    ["an unresolved trade", (f) => { f.raw.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, user_op_hash) VALUES (?, 'swap', 'x', 1, 'submitted', ?, '0xstuck')").run(f.account, OLD); }, /submitted\/sent\/pending/],
    ["a settlement within 26h", (f) => { f.raw.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, user_op_hash) VALUES (?, 'swap', 'x', 1, 'landed', ?, '0xrecent')").run(f.account, NOW - 3600); }, /settled within the last 26h/],
    ["duplicate flows", (f) => {
      for (let i = 0; i < 2; i++) f.raw.prepare("INSERT INTO flows (agent_id, direction, amount_usdg, source, at, epoch) VALUES (?, 'in', 50, 'epoch-carry', ?, 2)").run(f.account, OLD + i);
    }, /duplicate or conflicting/],
    ["a second agent_id spelling", (f) => { f.raw.prepare("INSERT INTO cost_basis VALUES (?, 'paper', 'OTHER', '1', '1', ?)").run(f.account.toUpperCase().replace("0X", "0x"), OLD); }, /spelled 2 ways/],
    ["an invalid risk period", (f) => { f.raw.prepare("INSERT INTO risk_periods VALUES ('r1', ?, ?, 0, 0, 0, 'x')").run(f.account, OLD); }, /risk period on record is invalid/],
    ["a staged original import", (f) => {
      f.raw.exec(`CREATE TABLE IF NOT EXISTS tenant_ledger_import (tenant TEXT PRIMARY KEY, generation TEXT, state TEXT)`);
      f.raw.prepare("INSERT INTO tenant_ledger_import VALUES (?, 'g', 'available')").run(f.tenant);
    }, /import is staged/],
  ];
  for (const [name, defect, why] of alone) {
    it(`refuses on ${name} alone`, async () => {
      const f = await fixture({ live: true });
      await defect(f);
      const p = await f.pre();
      assert.equal(p.refusals.length, 1, p.refusals.join(" | "));
      assert.match(p.refusals[0]!, why);
      assert.deepEqual(p.unreadable, [], "a fact about the tenant, not an outage: refused, never held on");
    });
  }
  it("refuses on unreadable controls alone, and on a half-applied import in the home alone", async () => {
    const f = await fixture({ live: true });
    const a = await resumePreconditions(f.shared, { tenant: f.tenant, account: f.account, grantAccount: f.account, nowSec: NOW, controls: { readable: false, why: "malformed" }, homePendingImport: false });
    assert.deepEqual(a.refusals.map((r) => /owner controls/.test(r)), [true]);
    assert.deepEqual(a.unreadable, [], "a malformed journal is a fact");
    const b = await resumePreconditions(f.shared, { tenant: f.tenant, account: f.account, grantAccount: f.account, nowSec: NOW, controls: CONTROLS, homePendingImport: true });
    assert.deepEqual(b.refusals.map((r) => /half-applied/.test(r)), [true]);
  });
  it("lists apart the refusals an outage caused — a controls read that failed, an anchor or a risk period that could not be read — so an admission holds on them", async () => {
    const f = await fixture({ live: true });
    const check = (db: Db, controls: { readable: boolean; why: string | null; failed?: boolean } = CONTROLS) =>
      resumePreconditions(db, { tenant: f.tenant, account: f.account, grantAccount: f.account, nowSec: NOW, controls, homePendingImport: false });
    // The controls read did not complete (recovery-reply-arm.ts readControlsEvidence `failed`).
    const controls = await check(f.shared, { readable: false, why: "controls unreadable (Error)", failed: true });
    assert.deepEqual([controls.refusals, controls.unreadable], [["owner controls cannot be read (controls unreadable (Error))"], ["owner controls cannot be read (controls unreadable (Error))"]]);
    // The anchor's own read fails: deriveBootstrapAccounting answers `unknown`, which it gives for nothing else.
    const anchor = await check(failing(f.shared, /SELECT hwm_usdg, hwm_withdrawn_usdg, epoch FROM agents/));
    assert.equal(anchor.anchor, "unknown");
    assert.deepEqual([anchor.refusals, anchor.unreadable], [["the accounting anchor cannot be derived"], ["the accounting anchor cannot be derived"]]);
    // A valid risk period reads as valid; the same with its carried read failing is an outage, not "invalid".
    f.raw.prepare("INSERT INTO risk_periods VALUES ('r-valid', ?, ?, 100, 120, 0, 'practice reset')").run(f.account, OLD);
    const clean = await check(f.shared);
    assert.deepEqual([clean.refusals, clean.riskPeriod], [[], "valid:r-valid"]);
    const risk = await check(failing(f.shared, /FROM risk_periods WHERE agent_id = \?/));
    assert.equal(risk.riskPeriod, "invalid");
    assert.equal(risk.unreadable.length, 1);
    assert.match(risk.unreadable[0]!, /risk period on record is invalid/);
    assert.deepEqual(risk.refusals, risk.unreadable);
  });
  it("refuses a book with rows but no accounting anchor, and admits a genuinely empty one", async () => {
    const raw = new DatabaseSync(":memory:"); handles.push(raw);
    const shared = wrapSqlite(raw); await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL); await shared.exec(PAPER_CHECKPOINT_SCHEMA);
    const account = addr(0x8fff), tenant = addr(0x7fff);
    const check = () => resumePreconditions(shared, { tenant, account, grantAccount: account, nowSec: NOW, controls: CONTROLS, homePendingImport: false });
    const empty = await check();
    assert.deepEqual(empty.refusals, []);
    assert.equal(empty.anchor, "no-prior-accounting");
    raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'COIN', '10', '20', ?)").run(account, OLD);
    assert.deepEqual((await check()).refusals.map((r) => /no accounting anchor, yet 1/.test(r)), [true]);
  });
  it("a paper book with a flow on record, or whose owner asked for live trading, is read on chain and starts exits-only", async () => {
    const funded = await fixture();
    funded.raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, at, epoch, chain_id)
      VALUES (?, 'in', 25, '0xdep9', 10, 1, 'deposit', ?, 2, 4663)`).run(funded.account, OLD);
    const f = await funded.pre();
    assert.deepEqual({ paper: f.paper, chain: f.chainRequired, level: f.suggestedLevel }, { paper: false, chain: true, level: "exits-only" });
    const intent = await fixture();
    const i = await resumePreconditions(intent.shared, { tenant: intent.tenant, account: intent.account, grantAccount: intent.account, nowSec: NOW, controls: CONTROLS,
      homePendingImport: false, liveIntent: true });
    assert.deepEqual({ paper: i.paper, chain: i.chainRequired, level: i.suggestedLevel }, { paper: false, chain: true, level: "exits-only" });
    assert.equal((await intent.pre()).chainRequired, false, "without the intent it is the paper book it was");
  });
  it("reads the chain from the OLDEST financial cursor, so an operation after a stalled trades cursor is never skipped", async () => {
    const f = await fixture({ live: true });
    f.raw.prepare("UPDATE mirror_state SET updated_at = ? WHERE tenant = ? AND table_name = 'trades'").run(NOW - 100 * 3600, f.tenant);
    f.raw.prepare("UPDATE mirror_state SET updated_at = ? WHERE tenant = ? AND table_name = 'events'").run(NOW - 30 * 3600, f.tenant);
    const p = await f.pre();
    assert.equal(p.lastMirrorAt, NOW - 30 * 3600, "the gap began at the last pass that copied anything");
    assert.equal(p.gapFromSec, NOW - 100 * 3600 - 600, "but the read starts where the trades cursor stopped");
    f.raw.prepare("UPDATE mirror_state SET updated_at = ? WHERE tenant = ?").run(NOW - 3600, f.tenant);
    assert.equal((await f.pre()).gapFromSec, NOW - 26 * 3600 - 600, "and always at least 26 hours back");
  });
  it("refuses a tenant already admitted only while its attested book is on the volume, present and unblocked", async () => {
    const f = await fixture();
    await ensureLedgerResumeSchema(f.shared);
    const generation = "00000000-0000-4000-8000-0000000000c1";
    f.raw.prepare(`INSERT INTO tenant_ledger_import (tenant, generation, target_volume_id, state, bytes, sha256, source_digest, bindings_json, created_at_ms,
      grant_updated_at, grant_row_version) VALUES (?, ?, 'v', 'consumed', 0, '', '', '{}', 1, '1', '1')`).run(f.tenant, generation);
    f.raw.prepare(`INSERT INTO ledger_resume_attestations (generation, approval_id, tenant, smart_account, chain_id, owner, evidence_digest, receipt_digest,
      mirror_state_digest, snapshot_digest, created_at_ms) VALUES (?, 'a1', ?, ?, 4663, ?, 'e', 'r', 'm', 's', 1)`).run(generation, f.tenant, f.account, f.owner);
    const check = (homeBook: "absent" | "blocked" | "present", account = f.account) =>
      resumePreconditions(f.shared, { tenant: f.tenant, account, grantAccount: account, nowSec: NOW, controls: CONTROLS, homePendingImport: false, homeBook });
    assert.deepEqual((await check("present")).refusals.map((r) => /already admitted/.test(r)), [true]);
    assert.deepEqual((await check("blocked")).refusals, [], "its book was lost or blocked again: this path is what it needs");
    assert.deepEqual((await check("absent")).refusals, []);
    assert.ok(!(await check("present", addr(0xacc999))).refusals.some((r) => /already admitted/.test(r)), "a new account is not the admitted one");
  });
  it("carries a valid risk period only under the grant's own spelling", async () => {
    const f = await fixture({ live: true });
    f.raw.prepare("INSERT INTO risk_periods VALUES ('r1', ?, ?, 100, 110, 0, 'owner reviewed')").run(f.account, OLD);
    assert.equal((await f.pre()).riskPeriod, "valid:r1");
    const checksummed = f.account.toUpperCase().replace("0X", "0x");
    const other = await resumePreconditions(f.shared, { tenant: f.tenant, account: f.account, grantAccount: checksummed, nowSec: NOW, controls: CONTROLS, homePendingImport: false });
    assert.equal(other.riskPeriod, "invalid", "a grant spelled otherwise would arm without the period: refused");
  });
});

describe("the evidence", () => {
  it("binds the books, the cursors and the home, and not the grant's incarnation, WAL, shm or mtimes", async () => {
    const f = await fixture();
    const home = path.join(root, `home-${f.id}`); mkdirSync(home, { recursive: true });
    const book = new DatabaseSync(path.join(home, "merrymen.db")); book.exec("CREATE TABLE t (x)"); book.close();
    writeFileSync(path.join(home, "ledger-source-blocked.json"), "{}");
    const read = () => readResumeEvidence(f.shared, { tenant: f.tenant, grant: { smartAccount: f.account, chainId: 4663, owner: f.owner }, home, nowSec: NOW, controls: CONTROLS });
    const first = await read();
    writeFileSync(path.join(home, "merrymen.db-wal"), "wal"); writeFileSync(path.join(home, "merrymen.db-shm"), "shm");
    utimesSync(path.join(home, "merrymen.db"), new Date(), new Date(Date.now() - 86_400_000));
    f.raw.prepare("UPDATE grants SET updated_at = 2000, row_version = 99 WHERE tenant = ?").run(f.tenant);
    assert.equal((await read()).digest, first.digest);
    writeFileSync(path.join(home, "paused"), "paused");
    assert.notEqual((await read()).digest, first.digest, "a new marker changes it");
    rmSync(path.join(home, "paused"));
    assert.equal((await read()).digest, first.digest);
    f.raw.prepare("UPDATE trades SET status = 'reverted' WHERE agent_id = ?").run(f.account);
    assert.notEqual((await read()).digest, first.digest, "a status settled in place changes it");
  });
  it("never binds a device number, which a volume reattached on another host changes", () => {
    const home = path.join(root, "dev-free"); mkdirSync(home, { recursive: true });
    const book = new DatabaseSync(path.join(home, "merrymen.db")); book.exec("CREATE TABLE t (x)"); book.close();
    const id = homeIdentity(home);
    assert.equal("dev" in id, false);
    assert.equal("dev" in (id.db ?? {}), false);
    assert.equal(id.ino, String(lstatSync(home, { bigint: true }).ino));
    assert.deepEqual(Object.keys(id.db!).sort(), ["ino", "size"]);
  });
  it("homeIdentity reads an absent home as absent and refuses a home that is not a directory", () => {
    assert.deepEqual(homeIdentity(path.join(root, "nope")), { exists: false });
    writeFileSync(path.join(root, "a-file"), "x");
    assert.throws(() => homeIdentity(path.join(root, "a-file")), /plain directory/);
  });
});

describe("the chain read", () => {
  const ACC = addr(0xabc);
  const topic = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
  function fakeChain(o: { logs?: Array<{ address: string; topics: string[]; tx: string; index: number; block?: bigint }>; failAt?: number; stamps?: (b: bigint) => number; head?: bigint } = {}):
    GapChain & { calls: number; stampCalls: number; ranges: Array<[bigint, bigint]> } {
    const chain = {
      calls: 0, stampCalls: 0, ranges: [] as Array<[bigint, bigint]>,
      async getBlockNumber() { return o.head ?? 2_000_000n; },
      async getBlockTimestamp(b: bigint) { chain.stampCalls += 1; return o.stamps ? o.stamps(b) : NOW - Number((o.head ?? 2_000_000n) - b) / 10; },
      async getLogs(a: { address: string; topics: Array<string | string[] | null>; fromBlock: bigint; toBlock: bigint }) {
        chain.calls += 1;
        chain.ranges.push([a.fromBlock, a.toBlock]);
        if (o.failAt !== undefined && chain.calls >= o.failAt) throw Object.assign(new Error("execution reverted"), { code: -32000 });
        return (o.logs ?? []).filter((l) => l.block === undefined || (l.block >= a.fromBlock && l.block <= a.toBlock)).filter((l) => l.address.toLowerCase() === a.address.toLowerCase()
          && a.topics.every((t, i) => t === null || String(t).toLowerCase() === String(l.topics[i] ?? "").toLowerCase()))
          .map((l) => ({ topics: l.topics as `0x${string}`[], data: "0x" as `0x${string}`, transactionHash: l.tx as `0x${string}`, logIndex: `0x${l.index.toString(16)}` as `0x${string}` }));
      },
    };
    return chain;
  }
  const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
  const OP = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f", TR = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const known = { ops: new Set(["0x" + "11".repeat(32)]), txs: new Set(["0xaa"]), flows: new Set(["0xbb:2"]) };
  it("clean when every operation and transfer since the last mirror is in Postgres", async () => {
    const chain = fakeChain({ logs: [
      { address: EP, topics: [OP, "0x" + "11".repeat(32), topic(ACC)], tx: "0xaa", index: 1 },
      { address: USDG, topics: [TR, topic(ACC), topic(addr(9))], tx: "0xaa", index: 2 },
      { address: USDG, topics: [TR, topic(addr(9)), topic(ACC)], tx: "0xbb", index: 2 },
    ] });
    const r = await chainGapCheck({ chain, account: ACC, usdg: USDG, sinceSec: NOW - 30 * 3600, known, maxSpan: 2_000_000n });
    assert.equal(r.status, "clean");
  });
  it("a USDG leg inside an operation Postgres holds is that operation's, even where its row kept no tx hash", async () => {
    const r = await chainGapCheck({ chain: fakeChain({ logs: [
      { address: EP, topics: [OP, "0x" + "11".repeat(32), topic(ACC)], tx: "0xee", index: 1 },
      { address: USDG, topics: [TR, topic(ACC), topic(addr(9))], tx: "0xee", index: 2 },
    ] }), account: ACC, usdg: USDG, sinceSec: NOW - 30 * 3600, known, maxSpan: 2_000_000n });
    assert.equal(r.status, "clean");
  });
  it("refuses an operation, or a deposit, Postgres lacks", async () => {
    const op = await chainGapCheck({ chain: fakeChain({ logs: [{ address: EP, topics: [OP, "0x" + "22".repeat(32), topic(ACC)], tx: "0xcc", index: 1 }] }),
      account: ACC, usdg: USDG, sinceSec: NOW - 30 * 3600, known, maxSpan: 2_000_000n });
    assert.deepEqual(op, { status: "missing", ops: 1, transfers: 0 });
    const dep = await chainGapCheck({ chain: fakeChain({ logs: [{ address: USDG, topics: [TR, topic(addr(9)), topic(ACC)], tx: "0xdd", index: 0 }] }),
      account: ACC, usdg: USDG, sinceSec: NOW - 30 * 3600, known, maxSpan: 2_000_000n });
    assert.deepEqual(dep, { status: "missing", ops: 0, transfers: 1 });
  });
  it("an RPC that fails is unavailable, never clean", async () => {
    const r = await chainGapCheck({ chain: fakeChain({ failAt: 2 }), account: ACC, usdg: USDG, sinceSec: NOW - 30 * 3600, known, maxSpan: 2_000_000n });
    assert.equal(r.status, "unavailable");
  });
  it("finds its starting block from the chain's own timestamps", async () => {
    // A chain twice as fast as the estimate: the first guess is too recent and is stepped back.
    const chain = fakeChain({ stamps: (b) => NOW - Number(2_000_000n - b) / 25 });
    const r = await chainGapCheck({ chain, account: ACC, usdg: USDG, sinceSec: NOW - 20 * 3600, known, maxSpan: 4_000_000n });
    assert.equal(r.status, "clean");
    assert.ok(Number((r as { fromBlock: string }).fromBlock) <= 2_000_000 - 20 * 3600 * 25);
  });
  it("the re-read before registration starts at the block already reached and runs to the head now: what landed after it refuses", async () => {
    const landed = { address: USDG, topics: [TR, topic(addr(9)), topic(ACC)], tx: "0xlate", index: 0, block: 2_000_400n };
    const earlier = { address: EP, topics: [OP, "0x" + "33".repeat(32), topic(ACC)], tx: "0xold", index: 1, block: 1_999_000n };
    // Only the window from the earlier head on is read, with no timestamp lookup: the earlier read already placed it.
    const quiet = fakeChain({ head: 2_000_500n, logs: [earlier] });
    const clean = await chainGapCheck({ chain: quiet, account: ACC, usdg: USDG, fromBlock: 2_000_000n, known, maxSpan: 50_000n });
    assert.deepEqual(clean, { status: "clean", fromBlock: "2000000", head: "2000500", ops: 0, transfers: 0 });
    assert.equal(quiet.stampCalls, 0);
    assert.ok(quiet.ranges.every(([from, to]) => from === 2_000_000n && to === 2_000_500n), "exactly the earlier head to the head now");
    const late = await chainGapCheck({ chain: fakeChain({ head: 2_000_500n, logs: [earlier, landed] }), account: ACC, usdg: USDG, fromBlock: 2_000_000n, known, maxSpan: 50_000n });
    assert.deepEqual(late, { status: "missing", ops: 0, transfers: 1 });
    // The head has not moved: the one block already read is read again, and nothing is skipped.
    assert.equal((await chainGapCheck({ chain: fakeChain({ head: 2_000_000n }), account: ACC, usdg: USDG, fromBlock: 2_000_000n, known })).status, "clean");
  });
  it("a head behind the block already read is unavailable, never clean", async () => {
    const r = await chainGapCheck({ chain: fakeChain({ head: 1_999_999n }), account: ACC, usdg: USDG, fromBlock: 2_000_000n, known });
    assert.deepEqual(r, { status: "unavailable", why: "the chain's head is behind the block already read" });
  });
  it("knows what Postgres holds for the account", async () => {
    const f = await fixture({ live: true });
    const k = await knownChainFacts(f.shared, f.account);
    assert.deepEqual({ ops: [...k.ops], txs: [...k.txs], flows: [...k.flows] }, { ops: ["0xop1"], txs: ["0xtx1"], flows: ["0xdep1:3"] });
  });
});

describe("approvals", () => {
  async function runOf(f: Awaited<ReturnType<typeof fixture>>, extra: PreviewEntry[] = []) {
    await ensureLedgerResumeSchema(f.shared);
    const home = path.join(root, `approve-${f.id}`);
    const { evidence, digest } = await readResumeEvidence(f.shared, { tenant: f.tenant, grant: { smartAccount: f.account, chainId: 4663, owner: f.owner }, home, nowSec: NOW, controls: CONTROLS });
    const entry: PreviewEntry = { tenant: f.tenant, account: f.account, chainId: 4663, owner: f.owner, digest, pass: true, refusals: [], chain: "not-required",
      suggestedLevel: "trade", anchor: "established:epoch-2", riskPeriod: "none", home: "absent", lastMirrorAt: null,
      holdsPositions: false, startsPaused: false, grantExpiresAt: NOW + 86_400, book: "absent", evidence };
    const entries = [entry, ...extra];
    return { run: await recordPreviewRun(f.shared, entries, 1), digest, entries };
  }
  it("a batch approval binds to exactly the tenants that passed in that run", async () => {
    const f = await fixture();
    const failing: PreviewEntry = { tenant: addr(0x1234), account: addr(0x1235), chainId: 4663, owner: addr(0x1236), digest: "d".repeat(64), pass: false,
      refusals: ["x"], chain: null, suggestedLevel: null, anchor: null, riskPeriod: null, home: null, lastMirrorAt: null,
      holdsPositions: null, startsPaused: null, grantExpiresAt: null, book: null, evidence: null };
    const { run, digest } = await runOf(f, [failing]);
    const lines: string[] = [];
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "run", run }], 2, (l) => lines.push(l)), 1);
    const rows = f.raw.prepare("SELECT tenant, evidence_digest, state, preview_run FROM ledger_resume_approvals").all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ tenant: f.tenant, evidence_digest: digest, state: "approved", preview_run: run }]);
    // Left set across boots, it approves nothing twice.
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "run", run }], 3, () => {}), 0);
    // An unknown run approves nothing.
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "run", run: "e".repeat(64) }], 4, (l) => lines.push(l)), 0);
    assert.match(lines.at(-1)!, /no recorded preview run/);
  });
  it("a per-tenant approval must name a digest a run showed passing; a different open approval must be revoked first", async () => {
    const f = await fixture();
    const { digest } = await runOf(f);
    const lines: string[] = [];
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest: "f".repeat(64) }], 2, (l) => lines.push(l)), 0);
    assert.match(lines[0]!, /no recorded preview run shows that digest passing/);
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest }], 2, () => {}), 1);
    // The same tenant, other evidence: refused while the first is open.
    f.raw.prepare("UPDATE trades SET amount_usdg = 6 WHERE agent_id = ?").run(f.account);
    f.raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 1, 0, 0, 1, ?, 2, 'paper')").run(f.account, OLD + 1);
    const second = await runOf(f);
    assert.notEqual(second.digest, digest);
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest: second.digest }], 3, (l) => lines.push(l)), 0);
    assert.match(lines.at(-1)!, /already has an open approval/);
    await revokeResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest }], 4, () => {});
    assert.equal(await readOpenApproval(f.shared, f.tenant), null);
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest: second.digest }], 5, () => {}), 1);
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest }], 6, () => {}), 0, "a revoked approval is never reopened");
  });
  it("a revoke left set across a restart never withdraws the re-approval that replaced it", async () => {
    const f = await fixture();
    const first = await runOf(f);
    await applyResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest: first.digest }], 2, () => {});
    f.raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 1, 0, 0, 1, ?, 2, 'paper')").run(f.account, OLD + 2);
    const second = await runOf(f);
    // One deploy: revoke the old evidence, approve the new (the runbook's order, as boot runs them).
    const boot = async (at: number) => {
      await revokeResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest: first.digest }], at, () => {});
      await applyResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest: second.digest }], at, () => {});
    };
    await boot(3);
    const open = (await readOpenApproval(f.shared, f.tenant))!;
    assert.equal(open.evidenceDigest, second.digest);
    // Its Phase A moves it on; then the container restarts with the same variables.
    assert.ok(await moveApproval(f.shared, open.approvalId, "approved", "archiving", { generation: "00000000-0000-4000-8000-0000000000d1" }));
    assert.ok(await moveApproval(f.shared, open.approvalId, "archiving", "archived"));
    await boot(4);
    assert.equal((await readOpenApproval(f.shared, f.tenant))?.state, "archived", "the re-approval stands");
    // A run revoke withdraws what that run approved, and only that.
    const g = await fixture();
    const r = await runOf(g);
    await applyResumeApprovals(g.shared, [{ kind: "run", run: r.run }], 2, () => {});
    await revokeResumeApprovals(g.shared, [{ kind: "run", run: "9".repeat(64) }], 3, () => {});
    assert.equal((await readOpenApproval(g.shared, g.tenant))?.state, "approved");
    await revokeResumeApprovals(g.shared, [{ kind: "run", run: r.run }], 4, () => {});
    assert.equal(await readOpenApproval(g.shared, g.tenant), null);
  });
  it("a preview taken before the tenant was admitted approves nothing for it afterwards", async () => {
    const f = await fixture();
    const old = await runOf(f);
    await applyResumeApprovals(f.shared, [{ kind: "run", run: old.run }], 2, () => {});
    const a = (await readOpenApproval(f.shared, f.tenant))!;
    for (const [from, to] of [["approved", "archiving"], ["archiving", "archived"], ["archived", "registered"], ["registered", "applied"]] as const) {
      assert.ok(await moveApproval(f.shared, a.approvalId, from, to, to === "archiving" ? { generation: "00000000-0000-4000-8000-0000000000d2" } : {}, 10));
    }
    // An older run in which the tenant passed with other evidence (recorded before the admission).
    f.raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 1, 0, 0, 1, ?, 2, 'paper')").run(f.account, OLD + 3);
    const stale = await runOf(f);
    const lines: string[] = [];
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "run", run: stale.run }], 11, (l) => lines.push(l)), 0);
    assert.match(lines.join("\n"), /admitted after preview run/);
  });
  it("a registered approval is past what a revoke undoes", async () => {
    const f = await fixture();
    const { digest } = await runOf(f);
    await applyResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest }], 2, () => {});
    const open = (await readOpenApproval(f.shared, f.tenant))!;
    assert.ok(await moveApproval(f.shared, open.approvalId, "approved", "archiving", { generation: "00000000-0000-4000-8000-000000000001" }));
    assert.ok(await moveApproval(f.shared, open.approvalId, "archiving", "archived"));
    assert.ok(await moveApproval(f.shared, open.approvalId, "archived", "registered"));
    const lines: string[] = [];
    await revokeResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest }], 3, (l) => lines.push(l));
    assert.equal((await readOpenApproval(f.shared, f.tenant))?.state, "registered");
    assert.match(lines[0]!, /past the point a revoke undoes/);
  });
});

describe("automatic admission of re-signed paper tenants (MERRYMEN_RESUME_AUTO_PAPER)", () => {
  /** A pre-incident paper tenant that holds nothing: the fixture less its position, live basis and floor. */
  async function paperHoldingNothing() {
    const f = await fixture();
    for (const table of ["positions", "cost_basis", "position_floors"]) f.raw.prepare(`DELETE FROM ${table} WHERE agent_id = ?`).run(f.account);
    return f;
  }
  /** Its preview line, as the orchestrator's previewEntryFor builds it, for a home in the given state. */
  async function entryOf(f: Awaited<ReturnType<typeof fixture>>, o: { book: "absent" | "blocked" | "present"; pass?: boolean; refusals?: string[] }) {
    await ensureLedgerResumeSchema(f.shared);
    const { evidence, digest, check } = await readResumeEvidence(f.shared, { tenant: f.tenant, grant: { smartAccount: f.account, chainId: 4663, owner: f.owner },
      home: path.join(root, `auto-${f.id}`), nowSec: NOW, controls: CONTROLS });
    const refusals = o.refusals ?? check.refusals;
    const entry: PreviewEntry = { tenant: f.tenant, account: f.account, chainId: 4663, owner: f.owner, digest, pass: o.pass ?? refusals.length === 0, refusals,
      chain: check.chainRequired ? "required" : "not-required", suggestedLevel: check.suggestedLevel, anchor: check.anchor, riskPeriod: check.riskPeriod,
      home: o.book === "absent" ? "absent" : "present", lastMirrorAt: check.lastMirrorAt, holdsPositions: check.holdsPositions, startsPaused: false,
      grantExpiresAt: NOW + 86_400, book: o.book, evidence };
    return entry;
  }

  it("the variable is 1 or unset; anything else refuses boot, and at runtime approves nobody", () => {
    assert.equal(parseResumeAutoPaper(undefined), false);
    assert.equal(parseResumeAutoPaper("1"), true);
    for (const bad of ["0", "", "true", " 1", "1 ", "yes"]) assert.throws(() => parseResumeAutoPaper(bad), /MERRYMEN_RESUME_AUTO_PAPER is not 1/);
    assert.equal(resumeAutoPaperOn({ MERRYMEN_RESUME_AUTO_PAPER: "1" }), true);
    assert.equal(resumeAutoPaperOn({}), false);
    assert.equal(resumeAutoPaperOn({ MERRYMEN_RESUME_AUTO_PAPER: "true" }), false, "fails closed");
  });

  it("room under the process cap: the runbook's 40 of 48, counting open approvals as taken", () => {
    assert.equal(AUTO_PAPER_HEADROOM, 8);
    assert.equal(autoPaperRoom({ running: 0, open: 0, cap: 48 }), 40);
    assert.equal(autoPaperRoom({ running: 39, open: 0, cap: 48 }), 1);
    assert.equal(autoPaperRoom({ running: 40, open: 0, cap: 48 }), 0);
    assert.equal(autoPaperRoom({ running: 30, open: 10, cap: 48 }), 0);
    assert.equal(autoPaperRoom({ running: 48, open: 3, cap: 48 }), 0, "never negative");
  });

  it("a grant row's key moves with a re-sign (its expiry and its server stamp), not with the tenant's spelling", () => {
    const t = addr(0xa1);
    const k = grantRowKey({ tenant: t, expiresAt: 100, updatedAt: 50 });
    assert.equal(grantRowKey({ tenant: t.toUpperCase().replace("0X", "0x"), expiresAt: 100, updatedAt: 50 }), k);
    assert.notEqual(grantRowKey({ tenant: t, expiresAt: 200, updatedAt: 50 }), k);
    assert.notEqual(grantRowKey({ tenant: t, expiresAt: 100, updatedAt: 51 }), k);
    assert.notEqual(grantRowKey({ tenant: t, expiresAt: 100 }), k, "a store that cannot say when it wrote is a different reading, never a match");
  });

  it("the watch baselines the roster once, then owes a preview for each changed or new grant row until that exact key is settled", async () => {
    const f = await fixture();
    await ensureLedgerResumeSchema(f.shared);
    const [a, b, c] = [addr(0xb1), addr(0xb2), addr(0xb3)];
    const key = (tenant: string, expiresAt: number) => ({ tenant, key: grantRowKey({ tenant, expiresAt, updatedAt: expiresAt - 7 * 86_400 }) });
    // First sight: everything as it stands is nobody's re-sign.
    assert.deepEqual(await observeGrantChanges(f.shared, [key(a, 10), key(b, 20)], 1), { baselined: 2, owed: [] });
    assert.deepEqual(await observeGrantChanges(f.shared, [key(a, 10), key(b, 20)], 2), { baselined: null, owed: [] }, "nothing changed");
    // b re-signs; c is a new grant row.
    const changed = await observeGrantChanges(f.shared, [key(a, 10), key(b, 99), key(c, 30)], 3);
    assert.deepEqual(changed.owed.map((o) => o.tenant), [b, c]);
    // Owed across passes (and restarts: it is in the table) until settled.
    assert.deepEqual((await observeGrantChanges(f.shared, [key(a, 10), key(b, 99), key(c, 30)], 4)).owed.map((o) => o.tenant), [b, c]);
    assert.equal(await settleGrantChange(f.shared, changed.owed[0]!, { outcome: "auto-approved", run: "r".repeat(64) }, 5), true);
    assert.deepEqual((await observeGrantChanges(f.shared, [key(a, 10), key(b, 99), key(c, 30)], 6)).owed.map((o) => o.tenant), [c]);
    // A second re-sign while the first is owed: the newer key is what is owed, and settling the old one does nothing.
    const stale = changed.owed[1]!;
    const again = await observeGrantChanges(f.shared, [key(a, 10), key(b, 99), key(c, 31)], 7);
    assert.equal(again.owed[0]!.key, key(c, 31).key);
    assert.equal(await settleGrantChange(f.shared, stale, { outcome: "previewed: x", run: null }, 8), false);
    // A removed tenant keeps its row; signed again later, it is a change.
    assert.deepEqual((await observeGrantChanges(f.shared, [key(b, 99)], 9)).owed.map((o) => o.tenant), [], "c left the roster: nothing owed for it now");
    assert.deepEqual((await observeGrantChanges(f.shared, [key(a, 10), key(b, 99), key(c, 31)], 10)).owed.map((o) => o.tenant), [c], "still owed on return");
    const rows = f.raw.prepare("SELECT tenant, owed, outcome FROM ledger_resume_grant_watch ORDER BY tenant").all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ tenant: "*", owed: 0, outcome: "baseline" }, { tenant: a, owed: 0, outcome: "baseline" }, { tenant: b, owed: 0, outcome: "auto-approved" },
      { tenant: c, owed: 1, outcome: null }]);
  });

  it("the safe case: a paper tenant that passes, could not arm live, holds nothing, and whose book the gate holds", async () => {
    const f = await paperHoldingNothing();
    assert.deepEqual(await autoPaperVerdict(f.shared, await entryOf(f, { book: "blocked" }), ENFORCED), { kind: "auto" });
    assert.deepEqual(await autoPaperVerdict(f.shared, await entryOf(f, { book: "absent" }), ENFORCED), { kind: "auto" }, "absent, with history on record");
  });

  it("not the gate's: a book on the volume, or no history at all, is the ordinary path's", async () => {
    const f = await paperHoldingNothing();
    assert.equal((await autoPaperVerdict(f.shared, await entryOf(f, { book: "present" }), ENFORCED)).kind, "not-held");
    // A brand-new account: nothing on record anywhere.
    const g = await fixture();
    for (const table of ["agents", "trades", "flows", "equity", "positions", "cost_basis", "position_floors", "mirror_state"]) {
      g.raw.prepare(`DELETE FROM ${table} WHERE ${table === "agents" ? "smart_account" : table === "mirror_state" ? "tenant" : "agent_id"} = ?`)
        .run(table === "mirror_state" ? g.tenant : g.account);
    }
    const fresh = await entryOf(g, { book: "absent" });
    assert.equal(evidenceHasHistory(fresh.evidence!), false);
    assert.equal((await autoPaperVerdict(g.shared, fresh, ENFORCED)).kind, "not-held");
    assert.equal(evidenceHasHistory((await entryOf(f, { book: "absent" })).evidence!), true);
  });

  it("each departure from the safe case alone leaves it to the operator, and says why", async () => {
    const manual = async (entry: PreviewEntry, db: Db, why: RegExp) => {
      const v = await autoPaperVerdict(db, entry, ENFORCED);
      assert.equal(v.kind, "manual");
      assert.match((v as { why: string[] }).why.join(" | "), why);
    };
    const live = await fixture({ live: true });
    await manual(await entryOf(live, { book: "blocked" }), live.shared, /could arm live \(chain:required\)/);
    const holding = await fixture(); // the paper fixture holds a token balance
    await manual(await entryOf(holding, { book: "blocked" }), holding.shared, /holding positions/);
    const basis = await paperHoldingNothing();
    basis.raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'OLD', '5', '1', ?)").run(basis.account, OLD);
    await manual(await entryOf(basis, { book: "blocked" }), basis.shared, /1 live book row/);
    const queued = await paperHoldingNothing();
    queued.raw.prepare("INSERT INTO agent_commands (id, agent_id, kind, created_at) VALUES ('c1', ?, 'trade', ?)").run(queued.account, OLD * 1000);
    await manual(await entryOf(queued, { book: "blocked" }), queued.shared, /1 owner command\(s\) .* still open/);
    queued.raw.prepare("UPDATE agent_commands SET done_at = ?, result = 'never ran' WHERE id = 'c1'").run(OLD * 1000 + 1);
    assert.deepEqual(await autoPaperVerdict(queued.shared, await entryOf(queued, { book: "blocked" }), ENFORCED), { kind: "auto" }, "an answered command is not open");
    const failing = await paperHoldingNothing();
    await manual(await entryOf(failing, { book: "blocked", pass: false, refusals: ["the signed grant has expired: the owner must re-sign"] }), failing.shared, /did not pass: the signed grant has expired/);
    const intent = await paperHoldingNothing();
    const turnedLive = await readResumeEvidence(intent.shared, { tenant: intent.tenant, grant: { smartAccount: intent.account, chainId: 4663, owner: intent.owner },
      home: path.join(root, "auto-intent"), nowSec: NOW, controls: CONTROLS, liveIntent: true });
    const intentEntry = { ...(await entryOf(intent, { book: "blocked" })), evidence: turnedLive.evidence, digest: turnedLive.digest };
    await manual(intentEntry, intent.shared, /could arm live/);
    // An operator's revoke is never overridden by a re-sign.
    const revoked = await paperHoldingNothing();
    const entry = await entryOf(revoked, { book: "blocked" });
    const run = await recordPreviewRun(revoked.shared, [entry], 1);
    await applyResumeApprovals(revoked.shared, [{ kind: "run", run }], 2, () => {});
    await manual(entry, revoked.shared, /approval is already open/);
    await revokeResumeApprovals(revoked.shared, [{ kind: "run", run }], 3, () => {});
    await manual(entry, revoked.shared, /an operator revoked an earlier approval/);
  });

  it("an automatic approval goes through the operator's insert, and says who gave it", async () => {
    const f = await paperHoldingNothing();
    const entry = await entryOf(f, { book: "blocked" });
    const run = await recordPreviewRun(f.shared, [entry], 1);
    const lines: string[] = [];
    assert.deepEqual(await recordResumeApproval(f.shared, { entry, run, at: 1, nowMs: 2, source: "auto-paper" }, (l) => lines.push(l)), { recorded: true });
    assert.match(lines[0]!, /approved automatically \(auto-paper/);
    const open = (await readOpenApproval(f.shared, f.tenant))!;
    assert.deepEqual({ state: open.state, source: open.source, digest: open.evidenceDigest, run: open.previewRun }, { state: "approved", source: "auto-paper", digest: entry.digest, run });
    // Never twice for the same evidence, whoever asks; an operator's run approval of the same evidence adds nothing.
    assert.equal((await recordResumeApproval(f.shared, { entry, run, at: 1, nowMs: 3, source: "auto-paper" }, () => {})).recorded, false);
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "run", run }], 4, () => {}), 0);
    assert.equal(await countOpenApprovals(f.shared), 1);
    // The operator's own, and a row from before the column, read as the operator's.
    const g = await paperHoldingNothing();
    const ge = await entryOf(g, { book: "blocked" });
    await applyResumeApprovals(g.shared, [{ kind: "run", run: await recordPreviewRun(g.shared, [ge], 1) }], 2, () => {});
    assert.equal((await readOpenApproval(g.shared, g.tenant))!.source, "operator");
    g.raw.prepare("UPDATE ledger_resume_approvals SET source = NULL").run();
    assert.equal((await readOpenApproval(g.shared, g.tenant))!.source, "operator");
  });

  it("an insert the store could not take for an outage is transient and records nothing; the store's own answer is final, as before", async () => {
    const f = await paperHoldingNothing();
    const entry = await entryOf(f, { book: "blocked" });
    const run = await recordPreviewRun(f.shared, [entry], 1);
    const insert = /INSERT INTO ledger_resume_approvals/;
    // What the error says can carry a connection string: never in a line or a reason.
    const coded = (code: string) => () => Object.assign(new Error("postgres://merrymen:hunter2@db.internal/x: canceling statement"), { code });
    const auto = (db: Db, lines: string[]) => recordResumeApproval(db, { entry, run, at: 1, nowMs: 2, source: "auto-paper" }, (l) => lines.push(l));
    for (const code of ["57014", "40001", "40P01", "08006", "08001", "57P01", "53300", "55P03", "ECONNRESET", "ETIMEDOUT"]) {
      const lines: string[] = [];
      assert.deepEqual(await auto(failing(f.shared, insert, coded(code)), lines), { recorded: false, why: `the store could not be reached or gave up (${code})`, transient: true }, code);
      assert.deepEqual(lines, [], `${code}: the automatic lane says its own line, with its back-off`);
    }
    // The client's own words for a connection that ended, with no code: by its class.
    assert.deepEqual(await auto(failing(f.shared, insert, () => new Error("Connection terminated unexpectedly")), []),
      { recorded: false, why: "the store could not be reached or gave up (Error)", transient: true });
    // An operator's boot is told, and told the variable records it on the next.
    const said: string[] = [];
    assert.equal((await recordResumeApproval(failing(f.shared, insert, coded("57014")), { entry, run, at: 1, nowMs: 2, source: "operator" }, (l) => said.push(l)) as { transient?: true }).transient, true);
    assert.deepEqual(said, [`[alert] resume approval: ${f.tenant} could not be recorded — the store could not be reached or gave up (57014): an outage, not a refusal — ` +
      "not approved by this boot; left set, the variable records it on the next"]);
    assert.equal(await countOpenApprovals(f.shared), 0, "nothing recorded by any of them");
    // The store's answer — its uniqueness, a check, schema drift, an error it has no code for — is final, exactly as before.
    for (const error of [coded("23505"), coded("23514"), coded("42703"), () => new Error("UNIQUE constraint failed: ledger_resume_approvals.tenant")]) {
      const lines: string[] = [];
      assert.deepEqual(await auto(failing(f.shared, insert, error), lines), { recorded: false, why: "the store refused the approval" }, error().message);
      assert.deepEqual(lines, [`[alert] resume approval: ${f.tenant} could not be recorded (another approval is open, or the store refused) — not approved`]);
    }
    // A real one: another replica's approval of the same evidence lands between the checks and the insert.
    const racing = new Proxy(f.shared, {
      get(target, prop, receiver) {
        if (prop !== "prepare") { const v = Reflect.get(target, prop, receiver) as unknown; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v; }
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!insert.test(sql)) return stmt;
          return { get: stmt.get.bind(stmt), all: stmt.all.bind(stmt), run: async (...args: unknown[]) => { await stmt.run("another-replica", ...args.slice(1)); return stmt.run(...args); } };
        };
      },
    });
    assert.deepEqual(await auto(racing, []), { recorded: false, why: "the store refused the approval" }, "the table's own uniqueness: settled, never asked again");
    assert.equal((await readOpenApproval(f.shared, f.tenant))!.approvalId, "another-replica", "the approval on record is the one that won");
    assert.deepEqual(await auto(f.shared, []), { recorded: false, why: "an approval of this evidence is already on record (approved)" });
  });

  it("an approval the store could not take sits out a growing number of turns — the next pass, then 1, 3, 7 … up to 40 — and is an [alert] from the third in a row", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 30].map(autoPaperRecordWait), [0, 1, 3, 7, 15, 31, 40, 40, 40]);
    assert.equal(AUTO_PAPER_RECORD_MAX_WAIT, 40, "about ten minutes of fifteen-second passes");
    assert.equal(AUTO_PAPER_RECORD_ALERT_AFTER, 3);
    for (const odd of [0, -3, NaN, Infinity]) assert.equal(autoPaperRecordWait(odd), 0, String(odd));
  });

  it("nobody is approved while live-trading consent is stood down: a funded account would arm live whatever its settings say", async () => {
    const f = await paperHoldingNothing();
    const entry = await entryOf(f, { book: "blocked" });
    assert.deepEqual(await autoPaperVerdict(f.shared, entry, ENFORCED), { kind: "auto" }, "the safe case, with consent in force");
    const v = await autoPaperVerdict(f.shared, entry, { consentEnforced: false });
    assert.equal(v.kind, "manual");
    assert.match((v as { why: string[] }).why.join(" | "), /live-trading consent is stood down on this deployment \(MERRYMEN_LIVE_INTENT_STAND_DOWN=1\)/);
  });

  it("a missing column is schema drift, not an absent table: the verdict throws rather than read it as nothing open", async () => {
    const f = await paperHoldingNothing();
    const entry = await entryOf(f, { book: "blocked" });
    // Postgres's words for a missing column also say "does not exist"; its code is 42703, not 42P01.
    const pgDrift = failing(f.shared, /FROM agent_commands/, () => Object.assign(new Error('column "done_at" does not exist'), { code: "42703" }));
    await assert.rejects(autoPaperVerdict(pgDrift, entry, ENFORCED), /column "done_at" does not exist/);
    const sqliteDrift = failing(f.shared, /FROM cost_basis/, () => new Error("no such column: qty_raw"));
    await assert.rejects(autoPaperVerdict(sqliteDrift, entry, ENFORCED), /no such column/);
    const classDrift = failing(f.shared, /FROM class_positions/, () => Object.assign(new Error('column "state" does not exist'), { code: "42703" }));
    await assert.rejects(resumePreconditions(classDrift, { tenant: f.tenant, account: f.account, grantAccount: f.account, nowSec: NOW, controls: CONTROLS, homePendingImport: false }),
      /column "state" does not exist/, "the preview's position count too");
    // A table not there yet still holds nothing, in either dialect.
    const pgAbsent = failing(f.shared, /FROM agent_commands/, () => Object.assign(new Error('relation "agent_commands" does not exist'), { code: "42P01" }));
    assert.deepEqual(await autoPaperVerdict(pgAbsent, entry, ENFORCED), { kind: "auto" });
    const sqliteAbsent = failing(f.shared, /FROM trench_positions/, () => new Error("no such table: trench_positions"));
    assert.deepEqual(await autoPaperVerdict(sqliteAbsent, entry, ENFORCED), { kind: "auto" });
  });

  it("owed changes come in turn order: never tried first, then the least recently tried, then the longest owed", async () => {
    const f = await fixture();
    await ensureLedgerResumeSchema(f.shared);
    const [a, b, c, d] = [addr(0xd1), addr(0xd2), addr(0xd3), addr(0xd4)];
    const k = (tenant: string, v: number) => ({ tenant, key: grantRowKey({ tenant, expiresAt: v, updatedAt: v }) });
    assert.deepEqual(await observeGrantChanges(f.shared, [], 1), { baselined: 0, owed: [] });
    await observeGrantChanges(f.shared, [k(c, 1), k(d, 1)], 10);
    const order = async (roster: Array<{ tenant: string; key: string }>, at: number) => (await observeGrantChanges(f.shared, roster, at)).owed;
    // Whatever the roster's order, the longest owed come first.
    let owed = await order([k(a, 1), k(b, 1), k(c, 1), k(d, 1)], 20);
    assert.deepEqual(owed.map((o) => o.tenant), [c, d, a, b]);
    // c and d are tried and cannot be read: behind a and b, c (tried first) before d. a and b,
    // owed since the same pass and never tried, are in roster order between themselves.
    await noteGrantAttempt(f.shared, owed[0]!, 30);
    await noteGrantAttempt(f.shared, owed[1]!, 31);
    owed = await order([k(d, 1), k(c, 1), k(b, 1), k(a, 1)], 40);
    assert.deepEqual(owed.map((o) => o.tenant), [b, a, c, d]);
    // b is tried too, later still; c's owner signs again — a new change, never tried, owed from now.
    await noteGrantAttempt(f.shared, owed[0]!, 50);
    owed = await order([k(a, 1), k(b, 1), k(c, 2), k(d, 1)], 60);
    assert.deepEqual(owed.map((o) => o.tenant), [a, c, d, b]);
    assert.deepEqual({ ...f.raw.prepare("SELECT attempted_at_ms AS at FROM ledger_resume_grant_watch WHERE tenant = ?").get(c) }, { at: null }, "a new change is untried");
    // A note for a key no longer owed changes nothing, and a settled change is no one's turn.
    await noteGrantAttempt(f.shared, k(c, 1), 70);
    assert.deepEqual({ ...f.raw.prepare("SELECT attempted_at_ms AS at FROM ledger_resume_grant_watch WHERE tenant = ?").get(c) }, { at: null });
    assert.equal(await settleGrantChange(f.shared, owed[0]!, { outcome: "auto-approved", run: null }, 80), true);
    assert.deepEqual((await order([k(a, 1), k(b, 1), k(c, 2), k(d, 1)], 90)).map((o) => o.tenant), [c, d, b]);
  });

  it("an approval finds its preview run beyond the newest 200, by the run's digest or by the evidence digest", async () => {
    const old = await paperHoldingNothing();
    const oldEntry = await entryOf(old, { book: "blocked" });
    const oldRun = await recordPreviewRun(old.shared, [oldEntry], 1);
    const other = await paperHoldingNothing();
    const otherEntry = await entryOf(other, { book: "blocked" });
    const otherRun = await recordPreviewRun(other.shared, [otherEntry], 1);
    // Two hundred newer runs in each, none of them these tenants' (the automatic lane records one per held re-signer).
    for (const f of [old, other]) {
      for (let i = 0; i < 200; i++) {
        await recordPreviewRun(f.shared, [{ ...oldEntry, tenant: addr(0xe000 + i), digest: i.toString(16).padStart(64, "0") }], 2 + i);
      }
    }
    const lines: string[] = [];
    assert.equal(await applyResumeApprovals(old.shared, [{ kind: "tenant", tenant: old.tenant, digest: oldEntry.digest! }], 1_000, (l) => lines.push(l)), 1, lines.join("\n"));
    assert.equal((await readOpenApproval(old.shared, old.tenant))!.previewRun, oldRun);
    assert.equal(await applyResumeApprovals(other.shared, [{ kind: "run", run: otherRun }], 1_000, (l) => lines.push(l)), 1, lines.join("\n"));
    assert.equal((await readOpenApproval(other.shared, other.tenant))!.previewRun, otherRun);
    // What no run ever showed passing is still refused.
    assert.equal(await applyResumeApprovals(old.shared, [{ kind: "tenant", tenant: old.tenant, digest: "f".repeat(64) }], 1_001, (l) => lines.push(l)), 0);
    assert.match(lines.at(-1)!, /no recorded preview run shows that digest passing/);
  });

  it("an operator approving evidence an automatic approval already ended on is told why, never skipped in silence", async () => {
    const f = await paperHoldingNothing();
    const entry = await entryOf(f, { book: "blocked" });
    const run = await recordPreviewRun(f.shared, [entry], 1);
    await recordResumeApproval(f.shared, { entry, run, at: 1, nowMs: 2, source: "auto-paper" }, () => {});
    await moveApproval(f.shared, (await readOpenApproval(f.shared, f.tenant))!.approvalId, "approved", "refused", { reason: "owner controls cannot be read (x)" });
    const lines: string[] = [];
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest: entry.digest! }], 3, (l) => lines.push(l)), 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^\[alert\] resume approval: .* an automatic \(auto-paper\) approval of this exact evidence refused \(owner controls cannot be read \(x\)\), and one evidence is never approved twice/);
    // The operator's own approval of the same evidence, left set across boots, stays silent as before.
    const g = await paperHoldingNothing();
    const ge = await entryOf(g, { book: "blocked" });
    const gRun = await recordPreviewRun(g.shared, [ge], 1);
    await applyResumeApprovals(g.shared, [{ kind: "run", run: gRun }], 2, () => {});
    await moveApproval(g.shared, (await readOpenApproval(g.shared, g.tenant))!.approvalId, "approved", "refused", { reason: "x" });
    const quiet: string[] = [];
    assert.equal(await applyResumeApprovals(g.shared, [{ kind: "run", run: gRun }], 3, (l) => quiet.push(l)), 0);
    assert.deepEqual(quiet, []);
  });
});

describe("the home archive", () => {
  function home(id: string) {
    const h = path.join(root, "vol", "children", id); mkdirSync(h, { recursive: true });
    for (const [name, body] of [["grant.json", "SESSION KEY"], ["settings.json", '{"telegramBotToken":"secret"}'], ["telegram.json", '{"offset":77}'],
      ["telegram-promoted.json", "{}"], ["paused", "paused"], ["kill-request-a.superseded.json", '{"grant":"x"}'], ["merrymen.db", "book"],
      ["ledger-source-blocked.json", "{}"]] as const) writeFileSync(path.join(h, name), body);
    mkdirSync(path.join(h, "grants")); writeFileSync(path.join(h, "grants", "old.json"), "OLD KEY");
    return h;
  }
  it("scrubs every key, carries the owner's controls and Telegram progress, and writes a private manifest", () => {
    const h = home("t1"), archiveRoot = path.join(root, "vol", "archive", "t1"), gen = "00000000-0000-4000-8000-000000000011";
    const r = archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => true });
    const dest = path.join(archiveRoot, gen);
    assert.equal(r.archivePath, dest);
    assert.deepEqual(r.carried, ["controls-armed.json", "kill-request-a.superseded.json", "paused", "telegram-promoted.json", "telegram.json"].filter((n) => existsSync(path.join(h, n))));
    assert.deepEqual(readdirSync(h).sort(), ["kill-request-a.superseded.json", "paused", "telegram-promoted.json", "telegram.json"]);
    assert.equal(readFileSync(path.join(h, "telegram.json"), "utf8"), '{"offset":77}');
    const archived = readdirSync(dest).sort();
    assert.deepEqual(archived, [".archive-manifest.json", "kill-request-a.superseded.json", "ledger-source-blocked.json", "merrymen.db", "paused"]);
    assert.equal(lstatSync(dest).mode & 0o777, 0o700);
    assert.equal(lstatSync(path.join(dest, ".archive-manifest.json")).mode & 0o777, 0o600);
    const manifest = JSON.parse(readFileSync(path.join(dest, ".archive-manifest.json"), "utf8")) as { files: Array<{ path: string }> };
    assert.deepEqual(manifest.files.map((f) => f.path).sort(), ["kill-request-a.superseded.json", "ledger-source-blocked.json", "merrymen.db", "paused"]);
    for (const secret of ["SESSION KEY", "OLD KEY", "secret"]) {
      for (const name of archived) if (lstatSync(path.join(dest, name)).isFile()) assert.ok(!readFileSync(path.join(dest, name), "utf8").includes(secret), `${secret} in ${name}`);
    }
  });
  it("converges after a crash between the rename and the carry", () => {
    const h = home("t2"), archiveRoot = path.join(root, "vol", "archive", "t2"), gen = "00000000-0000-4000-8000-000000000012";
    let calls = 0;
    // Lose the lease right after the rename: the carry is left staged.
    assert.throws(() => archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => ++calls < 4 }), /Lost the tenant lease/);
    assert.equal(existsSync(path.join(archiveRoot, gen, "merrymen.db")), true);
    assert.equal(existsSync(h), false);
    const r = archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => true });
    assert.equal(r.archivePath, path.join(archiveRoot, gen));
    assert.deepEqual(readdirSync(h).sort(), ["kill-request-a.superseded.json", "paused", "telegram-promoted.json", "telegram.json"]);
    assert.equal(existsSync(path.join(archiveRoot, `.carry-${gen}`)), false);
  });
  it("converges after a crash between the scrub and the rename: the moved Telegram files reach the new home, never the archive", () => {
    const h = home("t2b"), archiveRoot = path.join(root, "vol", "archive", "t2b"), gen = "00000000-0000-4000-8000-000000000015";
    let calls = 0;
    // The third check is the one just before the rename: the stage is built
    // and the keys are scrubbed, and the home has not moved yet.
    assert.throws(() => archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => ++calls < 3 }), /Lost the tenant lease/);
    assert.equal(existsSync(path.join(archiveRoot, gen)), false, "nothing renamed");
    assert.equal(existsSync(path.join(h, "grant.json")), false, "the keys are already gone from the home");
    assert.equal(readFileSync(path.join(h, "telegram.json"), "utf8"), '{"offset":77}', "the carried files are still in the home");
    // The next pass (this replica or another) rebuilds the stage from the home.
    const r = archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => true });
    assert.deepEqual(readdirSync(h).sort(), ["kill-request-a.superseded.json", "paused", "telegram-promoted.json", "telegram.json"]);
    assert.equal(readFileSync(path.join(h, "telegram.json"), "utf8"), '{"offset":77}');
    const archived = readdirSync(r.archivePath!).sort();
    for (const moved of ["telegram.json", "telegram-promoted.json", "grant.json", "settings.json", "grants"]) assert.ok(!archived.includes(moved), `${moved} is not in the archive`);
    assert.equal(existsSync(path.join(archiveRoot, `.carry-${gen}`)), false);
  });
  it("converges after a crash right after the rename, before the moved files leave the archive", () => {
    const h = home("t2c"), archiveRoot = path.join(root, "vol", "archive", "t2c"), gen = "00000000-0000-4000-8000-000000000016";
    let calls = 0;
    assert.throws(() => archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => ++calls < 4 }), /Lost the tenant lease/);
    // Simulate the crash landing between the rename and the archive's own
    // cleanup: put the moved files back in the archive as the rename left them.
    writeFileSync(path.join(archiveRoot, gen, "telegram.json"), '{"offset":77}');
    const r = archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => true });
    assert.equal(readFileSync(path.join(h, "telegram.json"), "utf8"), '{"offset":77}');
    assert.ok(!readdirSync(r.archivePath!).includes("telegram.json"));
  });
  it("a lost lease before the rename moves nothing", () => {
    const h = home("t3"), archiveRoot = path.join(root, "vol", "archive", "t3"), gen = "00000000-0000-4000-8000-000000000013";
    assert.throws(() => archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => false }), /Lost the tenant lease/);
    assert.ok(existsSync(path.join(h, "grant.json")) && existsSync(path.join(h, "merrymen.db")));
    assert.equal(existsSync(path.join(archiveRoot, gen)), false);
  });
  it("with no home there is nothing to archive", () => {
    assert.deepEqual(archiveTenantHome({ home: path.join(root, "vol", "children", "none"), archiveRoot: path.join(root, "vol", "archive", "none"),
      generation: "00000000-0000-4000-8000-000000000014", mayWrite: () => true }), { archivePath: null, carried: [], normalised: [], left: [] });
  });

  // ── what the carry leaves for the offset handoff ──────────────────────────
  const tenant = addr(0x7e1), account = addr(0xacce1);
  /** The recovery listener's high-water mark for bot 801, as the handoff reads it. */
  function listener() {
    const raw = new DatabaseSync(":memory:"); handles.push(raw); raw.exec(RECOVERY_REPLY_SCHEMA);
    raw.prepare("INSERT INTO recovery_reply_offsets VALUES(?,?,?,?,?,200,101,100,1000)").run("801", tenant, account, 4663, "a".repeat(16));
    return wrapSqlite(raw);
  }
  const handoff = async (h: string, shared: Db) => {
    try { await handoffRecoveryReplyOffset({ tenant, smartAccount: account, chainId: 4663, token: "801:carry_fixture", home: h, shared, mayWrite: () => true }); return "accepted"; }
    catch (e) { return String((e as { code?: unknown }).code); }
  };
  /** A home whose telegram.json is `body` at `mode`, archived and carried. */
  function carry(id: string, body: string, mode: number, extra: Record<string, [string, number]> = {}) {
    const h = path.join(root, "vol", "children", id); mkdirSync(h, { recursive: true });
    for (const [name, [b, m]] of Object.entries({ "telegram.json": [body, mode] as [string, number], "merrymen.db": ["book", 0o600] as [string, number], ...extra })) {
      writeFileSync(path.join(h, name), b); chmodSync(path.join(h, name), m);
    }
    const r = archiveTenantHome({ home: h, archiveRoot: path.join(root, "vol", "archive", id), generation: `00000000-0000-4000-8000-0000000001${id.slice(-2)}`, mayWrite: () => true });
    return { h, r, file: path.join(h, "telegram.json") };
  }

  it("carries a telegram.json the handoff reads: the orchestrator's restored link gains offset 0, a file our writers left at the umask becomes 0600", async () => {
    // The shape writeTelegramForChild writes (restoredTelegramFile): no offset at all.
    const restored = { linkCode: "K7M2QX", ownerId: 555, linkedAt: 7, firedAlerts: { "drawdown:20": 1000 } };
    const a = carry("c01", JSON.stringify(restored, null, 2), 0o600, { "telegram-promoted.json": ["{}", 0o644], paused: ["paused", 0o644] });
    assert.deepEqual(JSON.parse(readFileSync(a.file, "utf8")), { offset: 0, ...restored }, "only the offset is added; the link, owner and stamps are as they were");
    for (const name of ["telegram.json", "telegram-promoted.json", "paused"]) assert.equal(lstatSync(path.join(a.h, name)).mode & 0o777, 0o600, name);
    assert.deepEqual(a.r.normalised, ["paused: mode", "telegram-promoted.json: mode", "telegram.json: offset"]);
    assert.deepEqual(a.r.left, []);
    assert.equal(await handoff(a.h, listener()), "accepted");
    assert.deepEqual(JSON.parse(readFileSync(a.file, "utf8")), { offset: 101, ...restored }, "and the listener's high-water mark is handed over");
    // A worker's own file from before #198, written at the umask.
    const b = carry("c02", JSON.stringify({ offset: 40, botId: "801", priorBots: [], ownerId: 555 }), 0o644);
    assert.deepEqual(b.r.normalised, ["telegram.json: mode"]);
    assert.equal(readFileSync(b.file, "utf8"), JSON.stringify({ offset: 40, botId: "801", priorBots: [], ownerId: 555 }), "a mode alone is fixed without rewriting the bytes");
    assert.equal(await handoff(b.h, listener()), "accepted");
    assert.equal(JSON.parse(readFileSync(b.file, "utf8")).offset, 101);
    // The restored link as writeTelegramForChild wrote it before #202 and #198: at the umask, an empty code and a zero link time.
    const legacy = { linkCode: "", ownerId: 555, linkedAt: 0 };
    const c = carry("c03", JSON.stringify(legacy, null, 2), 0o644);
    assert.deepEqual(c.r.normalised, ["telegram.json: offset", "telegram.json: mode"]);
    assert.deepEqual(JSON.parse(readFileSync(c.file, "utf8")), { offset: 0, ...legacy });
    assert.equal(lstatSync(c.file).mode & 0o777, 0o600);
    assert.equal(await handoff(c.h, listener()), "accepted");
    // Already what the handoff reads: nothing is touched.
    const d = carry("c04", JSON.stringify({ offset: 77 }), 0o600);
    assert.deepEqual(d.r.normalised, []);
    assert.equal(readFileSync(d.file, "utf8"), JSON.stringify({ offset: 77 }));
    // A higher local offset is never lowered by the handoff.
    const e = carry("c05", JSON.stringify({ offset: 500, botId: "801" }), 0o600);
    assert.equal(await handoff(e.h, listener()), "accepted");
    assert.equal(JSON.parse(readFileSync(e.file, "utf8")).offset, 500);
  });

  it("leaves anything but the restored link, and anything our writers did not leave, exactly as it is, and the handoff still refuses it by name", async () => {
    const link = { linkCode: "K7M2QX", ownerId: 555 };
    for (const [id, body, mode, code] of [
      ["c11", JSON.stringify({ offset: 10, botId: 801 }), 0o600, "HANDOFF_BOT"], // no build ever wrote a numeric bot id
      ["c12", JSON.stringify({ offset: null, linkCode: "K7M2QX" }), 0o600, "HANDOFF_OFFSET"], // an offset that is there and wrong is not a missing one
      ["c13", JSON.stringify({ offset: -3 }), 0o600, "HANDOFF_OFFSET"],
      ["c14", JSON.stringify({ offset: 1, botId: "802", priorBots: "x" }), 0o600, "HANDOFF_PRIOR_BOTS"],
      ["c15", "{ not json", 0o600, "HANDOFF_PARSE"],
      ["c16", JSON.stringify([{ offset: 1 }]), 0o600, "HANDOFF_SHAPE"],
      ["c17", JSON.stringify({ linkCode: "K7M2QX", pad: "x".repeat(256 * 1024) }), 0o600, "HANDOFF_SIZE"], // larger than any the child writes
      // No offset, but not the restored link: a key no writer of ours wrote without one, or one of another type.
      ["c18", JSON.stringify({ linkCode: "K7M2QX", botId: 9101 }), 0o600, "HANDOFF_OFFSET"],
      ["c19", JSON.stringify({ linkCode: "K7M2QX", botId: "801", priorBots: "x" }), 0o600, "HANDOFF_OFFSET"],
      ["c20", JSON.stringify({ ...link, linkedChats: [555] }), 0o600, "HANDOFF_OFFSET"],
      ["c21", JSON.stringify({ linkCode: 7 }), 0o600, "HANDOFF_OFFSET"],
      ["c22", JSON.stringify({ ownerId: "555" }), 0o600, "HANDOFF_OFFSET"],
      ["c23", JSON.stringify({ ...link, firedAlerts: { "drawdown:20": "soon" } }), 0o600, "HANDOFF_OFFSET"],
      ["c24", JSON.stringify({}), 0o600, "HANDOFF_OFFSET"],
      // A byte-order mark: no writer of ours ever wrote one.
      ["c25", String.fromCharCode(0xfeff) + JSON.stringify(link), 0o600, "HANDOFF_PARSE"],
      // Writable by someone else: never ours, whatever it holds, and its mode is kept for the handoff to refuse.
      ["c26", JSON.stringify(link), 0o666, "HANDOFF_MODE"],
      ["c27", JSON.stringify(link), 0o664, "HANDOFF_MODE"],
      ["c28", JSON.stringify({ offset: 3 }), 0o646, "HANDOFF_MODE"],
    ] as const) {
      const x = carry(id, body, mode);
      assert.equal(readFileSync(x.file, "utf8"), body, id);
      assert.deepEqual(x.r.normalised, [], id);
      assert.equal(lstatSync(x.file).mode & 0o777, mode, `${id}: carried with its own mode`);
      assert.equal(await handoff(x.h, listener()), code, id);
      assert.equal(readFileSync(x.file, "utf8"), body, `${id}: the refused file is left as it was`);
    }
  });

  it("carries the Telegram files only as the home's own: one with a second name stays in the archive, and the next spawn restores the link", async () => {
    const h = path.join(root, "vol", "children", "c31"), archiveRoot = path.join(root, "vol", "archive", "c31"), gen = "00000000-0000-4000-8000-000000000131";
    mkdirSync(h, { recursive: true });
    const elsewhere = path.join(root, "vol", "c31-elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ linkCode: "FOREIGN", ownerId: 31337 })); chmodSync(elsewhere, 0o644);
    linkSync(elsewhere, path.join(h, "telegram.json"));
    writeFileSync(path.join(h, "telegram-promoted.json"), "{}"); chmodSync(path.join(h, "telegram-promoted.json"), 0o644);
    // The owner's stop, with a second name too: copied whatever it is, and not vouched for.
    writeFileSync(path.join(root, "vol", "c31-paused"), "paused"); chmodSync(path.join(root, "vol", "c31-paused"), 0o644);
    linkSync(path.join(root, "vol", "c31-paused"), path.join(h, "paused"));
    const r = archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => true });
    assert.deepEqual(r.carried, ["paused", "telegram-promoted.json"]);
    assert.deepEqual(r.left, ["telegram.json"]);
    assert.deepEqual(r.normalised, ["telegram-promoted.json: mode"]);
    assert.equal(existsSync(path.join(h, "telegram.json")), false, "the foreign link never reaches the new home");
    assert.equal(readFileSync(path.join(archiveRoot, gen, "telegram.json"), "utf8"), JSON.stringify({ linkCode: "FOREIGN", ownerId: 31337 }), "it stays in the archive");
    assert.equal(lstatSync(path.join(h, "paused")).mode & 0o777, 0o644, "the stop is carried as it was");
    assert.equal(readFileSync(path.join(h, "paused"), "utf8"), "paused");
    // With no telegram.json the handoff writes the listener's mark into a fresh one.
    assert.equal(await handoff(h, listener()), "accepted");
    assert.equal(JSON.parse(readFileSync(path.join(h, "telegram.json"), "utf8")).offset, 101);
    // Re-entry leaves it in the archive too.
    const again = archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => true });
    assert.deepEqual(again.left, ["telegram.json"]);
    assert.ok(existsSync(path.join(archiveRoot, gen, "telegram.json")));
  });

  // ── the Telegram state and its link record are a pair ─────────────────────
  /** A child's telegram.json as tryLink leaves it: two linked chats, with their link times. */
  const LINKED = JSON.stringify({ offset: 40, botId: "801", linkCode: "K7M2QX", ownerId: 111, linkedChats: [111, 222], linkedChatAt: { "111": 1000, "222": 1005 } });
  const RECORD = JSON.stringify({ "111": 1000, "222": 1005 });
  /** A home holding that telegram.json, the home's own, and its link record made by `record`. */
  function linkedHome(id: string, record: ((file: string) => void) | null) {
    const h = path.join(root, "vol", "children", id), archiveRoot = path.join(root, "vol", "archive", id), gen = `00000000-0000-4000-8000-0000000002${id.slice(-2)}`;
    mkdirSync(h, { recursive: true });
    writeFileSync(path.join(h, "telegram.json"), LINKED, { mode: 0o600 });
    writeFileSync(path.join(h, "merrymen.db"), "book", { mode: 0o600 });
    record?.(path.join(h, "telegram-promoted.json"));
    return { h, archiveRoot, gen, dest: path.join(archiveRoot, gen) };
  }

  it("A LINK RECORD THE CARRY WILL NOT TAKE KEEPS telegram.json IN THE ARCHIVE WITH IT, so no chat the record names is new in the next home", async () => {
    // A second name, a link to a record elsewhere, and something that is not a file at all.
    for (const [id, record] of [
      ["p01", (file: string) => { writeFileSync(file, RECORD, { mode: 0o600 }); linkSync(file, path.join(root, "vol", "p01-second-name")); }],
      ["p02", (file: string) => { writeFileSync(path.join(root, "vol", "p02-elsewhere.json"), RECORD, { mode: 0o600 }); symlinkSync(path.join(root, "vol", "p02-elsewhere.json"), file); }],
      ["p03", (file: string) => { mkdirSync(file); }],
    ] as const) {
      const x = linkedHome(id, record);
      const r = archiveTenantHome({ home: x.h, archiveRoot: x.archiveRoot, generation: x.gen, mayWrite: () => true });
      assert.deepEqual(r.carried, [], id);
      assert.deepEqual(r.left, ["telegram.json", "telegram-promoted.json"], id);
      assert.deepEqual(r.normalised, [], id);
      assert.deepEqual(readdirSync(x.h), [], `${id}: neither reaches the new home`);
      assert.equal(readFileSync(path.join(x.dest, "telegram.json"), "utf8"), LINKED, `${id}: the link stays in the archive as it was`);
      assert.ok(lstatSync(path.join(x.dest, "telegram-promoted.json")), `${id}: and its record beside it`);
      // The new home's file is the handoff's own, with no linked chat to promote.
      assert.equal(await handoff(x.h, listener()), "accepted", id);
      assert.deepEqual(JSON.parse(readFileSync(path.join(x.h, "telegram.json"), "utf8")), { offset: 101, botId: null, priorBots: [] }, id);
      // Re-entry keeps both where they are.
      assert.deepEqual(archiveTenantHome({ home: x.h, archiveRoot: x.archiveRoot, generation: x.gen, mayWrite: () => true }).left, ["telegram.json", "telegram-promoted.json"], id);
    }
    assert.equal(readFileSync(path.join(root, "vol", "p02-elsewhere.json"), "utf8"), RECORD, "a linked record is never followed");
  });

  it("the pair holds when the stage is rebuilt after a crash before the rename", () => {
    const x = linkedHome("p11", (file) => { writeFileSync(file, RECORD, { mode: 0o600 }); linkSync(file, path.join(root, "vol", "p11-second-name")); });
    let calls = 0;
    assert.throws(() => archiveTenantHome({ home: x.h, archiveRoot: x.archiveRoot, generation: x.gen, mayWrite: () => ++calls < 3 }), /Lost the tenant lease/);
    assert.deepEqual(readdirSync(path.join(x.archiveRoot, `.carry-${x.gen}`)), [], "nothing Telegram was staged");
    const r = archiveTenantHome({ home: x.h, archiveRoot: x.archiveRoot, generation: x.gen, mayWrite: () => true });
    assert.deepEqual(r.left, ["telegram.json", "telegram-promoted.json"]);
    assert.equal(existsSync(path.join(x.h, "telegram.json")), false);
    assert.equal(readFileSync(path.join(x.dest, "telegram.json"), "utf8"), LINKED);
  });

  it("with no link record in the home, telegram.json is carried as it always was; with both the home's own, they are carried together", () => {
    const none = linkedHome("p21", null);
    const a = archiveTenantHome({ home: none.h, archiveRoot: none.archiveRoot, generation: none.gen, mayWrite: () => true });
    assert.deepEqual(a.carried, ["telegram.json"]);
    assert.deepEqual(a.left, []);
    assert.equal(readFileSync(path.join(none.h, "telegram.json"), "utf8"), LINKED, "byte for byte");
    const both = linkedHome("p22", (file) => writeFileSync(file, RECORD, { mode: 0o600 }));
    const b = archiveTenantHome({ home: both.h, archiveRoot: both.archiveRoot, generation: both.gen, mayWrite: () => true });
    assert.deepEqual(b.carried, ["telegram-promoted.json", "telegram.json"]);
    assert.deepEqual(b.left, []);
    assert.equal(readFileSync(path.join(both.h, "telegram-promoted.json"), "utf8"), RECORD);
    assert.equal(readFileSync(path.join(both.h, "telegram.json"), "utf8"), LINKED);
  });

  it("a telegram.json an earlier build staged without the record the archive kept goes back to the archive, never to the new home alone", () => {
    for (const [id, archiveHasLink] of [["p31", false], ["p32", true]] as const) {
      // As an earlier build left it: the home renamed, its record kept in the
      // archive, telegram.json staged alone — and, after a crash past step 4,
      // removed from the archive, so the stage holds the only copy.
      const archiveRoot = path.join(root, "vol", "archive", id), gen = `00000000-0000-4000-8000-0000000003${id.slice(-2)}`, dest = path.join(archiveRoot, gen);
      const stage = path.join(archiveRoot, `.carry-${gen}`), h = path.join(root, "vol", "children", id);
      mkdirSync(dest, { recursive: true }); mkdirSync(stage, { recursive: true });
      writeFileSync(path.join(dest, "telegram-promoted.json"), RECORD, { mode: 0o600 });
      linkSync(path.join(dest, "telegram-promoted.json"), path.join(root, "vol", `${id}-second-name`));
      if (archiveHasLink) writeFileSync(path.join(dest, "telegram.json"), LINKED, { mode: 0o600 });
      writeFileSync(path.join(stage, "telegram.json"), archiveHasLink ? JSON.stringify({ offset: 0 }) : LINKED, { mode: 0o600 });
      writeFileSync(path.join(stage, "paused"), "paused", { mode: 0o600 });
      const r = archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => true });
      assert.deepEqual(r.carried, ["paused"], id);
      assert.deepEqual(r.left, ["telegram.json", "telegram-promoted.json"], id);
      assert.equal(existsSync(path.join(h, "telegram.json")), false, `${id}: never the new home's`);
      assert.equal(readFileSync(path.join(dest, "telegram.json"), "utf8"), LINKED, `${id}: the archive keeps the original, or the only copy`);
      assert.equal(existsSync(stage), false, id);
    }
  });

  it("a crash after the stage keeps what was made of it; a carry an earlier build staged moves as it was, for the registered home's pass", () => {
    // This build: normalised as staged, so a crash before the move changes nothing.
    const h = path.join(root, "vol", "children", "c41"), archiveRoot = path.join(root, "vol", "archive", "c41"), gen = "00000000-0000-4000-8000-000000000141";
    mkdirSync(h, { recursive: true });
    writeFileSync(path.join(h, "telegram.json"), JSON.stringify({ linkCode: "K7M2QX" })); chmodSync(path.join(h, "telegram.json"), 0o644);
    let calls = 0;
    assert.throws(() => archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => ++calls < 4 }), /Lost the tenant lease/);
    const staged = path.join(archiveRoot, `.carry-${gen}`, "telegram.json");
    assert.deepEqual(JSON.parse(readFileSync(staged, "utf8")), { offset: 0, linkCode: "K7M2QX" });
    assert.equal(lstatSync(staged).mode & 0o777, 0o600);
    archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => true });
    assert.deepEqual(JSON.parse(readFileSync(path.join(h, "telegram.json"), "utf8")), { offset: 0, linkCode: "K7M2QX" });
    // An earlier build: the stage holds the raw copy, and the home is archived.
    const h2 = path.join(root, "vol", "children", "c42"), root2 = path.join(root, "vol", "archive", "c42"), gen2 = "00000000-0000-4000-8000-000000000142";
    mkdirSync(path.join(root2, gen2), { recursive: true }); mkdirSync(path.join(root2, `.carry-${gen2}`), { recursive: true });
    const raw = path.join(root2, `.carry-${gen2}`, "telegram.json");
    writeFileSync(raw, JSON.stringify({ linkCode: "K7M2QX" })); chmodSync(raw, 0o644);
    const r = archiveTenantHome({ home: h2, archiveRoot: root2, generation: gen2, mayWrite: () => true });
    assert.deepEqual(r.normalised, []);
    assert.deepEqual(r.carried, ["telegram.json"]);
    assert.equal(lstatSync(path.join(h2, "telegram.json")).mode & 0o777, 0o644, "moved as it was");
    assert.deepEqual(normaliseCarriedFile(path.join(h2, "telegram.json"), () => true), ["telegram.json: offset", "telegram.json: mode"]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(h2, "telegram.json"), "utf8")), { offset: 0, linkCode: "K7M2QX" });
  });

  it("normaliseCarriedFile never follows a link, never touches a file with a second name or one others can write, writes nothing without the writer, and never throws", () => {
    const dir = path.join(root, "vol", "norm"); mkdirSync(dir, { recursive: true });
    const target = path.join(root, "vol", "norm-target.json");
    writeFileSync(target, JSON.stringify({ linkCode: "X" })); chmodSync(target, 0o644);
    symlinkSync(target, path.join(dir, "telegram.json"));
    assert.deepEqual(normaliseCarriedFile(path.join(dir, "telegram.json"), () => true), []);
    assert.equal(readFileSync(target, "utf8"), JSON.stringify({ linkCode: "X" }));
    assert.equal(lstatSync(target).mode & 0o777, 0o644);
    writeFileSync(path.join(dir, "telegram-promoted.json"), "{}"); chmodSync(path.join(dir, "telegram-promoted.json"), 0o644);
    linkSync(path.join(dir, "telegram-promoted.json"), path.join(dir, "second-name"));
    assert.deepEqual(normaliseCarriedFile(path.join(dir, "telegram-promoted.json"), () => true), []);
    assert.equal(lstatSync(path.join(dir, "telegram-promoted.json")).mode & 0o777, 0o644);
    for (const mode of [0o666, 0o664, 0o660, 0o606, 0o744, 0o4644]) {
      const file = path.join(dir, "paused"); rmSync(file, { force: true });
      writeFileSync(file, "paused"); chmodSync(file, mode);
      assert.deepEqual(normaliseCarriedFile(file, () => true), [], mode.toString(8));
      assert.equal(lstatSync(file).mode & 0o7777, mode, mode.toString(8));
    }
    const other = path.join(root, "vol", "norm-writer"); mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, "telegram.json"), JSON.stringify({ linkCode: "X" })); chmodSync(path.join(other, "telegram.json"), 0o644);
    assert.deepEqual(normaliseCarriedFile(path.join(other, "telegram.json"), () => false), [], "not the writer: nothing written");
    assert.equal(readFileSync(path.join(other, "telegram.json"), "utf8"), JSON.stringify({ linkCode: "X" }));
    assert.equal(lstatSync(path.join(other, "telegram.json")).mode & 0o777, 0o644);
    assert.deepEqual(normaliseCarriedFile(path.join(other, "missing.json"), () => true), [], "no file, nothing to say");
  });
});

describe("the attested seed", () => {
  async function book() {
    const raw = new DatabaseSync(":memory:"); handles.push(raw);
    const db = wrapSqlite(raw); await applyLedgerSchema(db);
    return { raw, db };
  }
  it("plans exactly what the ordinary seeds restore into an empty book: held live basis, and the floor beside it", async () => {
    const f = await fixture({ live: true });
    f.raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'SOLD', '5', '9', ?)").run(f.account, OLD); // no position: never restored
    f.raw.prepare("INSERT INTO cost_basis VALUES (?, 'paper', 'COIN', '10', '20', ?)").run(f.account, OLD); // paper: never restored
    f.raw.prepare("INSERT INTO position_floors VALUES (?, 'live', 'SOLD', 900, 'r1', 'entry', ?)").run(f.account, OLD);
    const plan = await planAttestedSeed(f.shared, f.account);
    assert.deepEqual(plan.basis, [{ mode: "live", symbol: "COIN", qtyRaw: "10", costUsdg: "20" }]);
    assert.deepEqual(plan.floors.map((x) => [x.symbol, x.stopBps]), [["COIN", 1500]]);
  });
  it("completes a seed that failed, and proves it, in one transaction on the book", async () => {
    const f = await fixture({ live: true });
    const plan = await planAttestedSeed(f.shared, f.account);
    const b = await book();
    const done = await completeAttestedSeed({ book: b.db, account: f.account, plan, mayWrite: () => null });
    assert.deepEqual(done, { ok: true, basis: 1, floors: 1 });
    assert.deepEqual(b.raw.prepare("SELECT agent_id, mode, symbol, qty_raw, cost_usdg FROM cost_basis").all().map((r) => ({ ...r })),
      [{ agent_id: f.account, mode: "live", symbol: "COIN", qty_raw: "10", cost_usdg: "20" }]);
    assert.deepEqual(b.raw.prepare("SELECT symbol, stop_bps, rung FROM position_floors").all().map((r) => ({ ...r })), [{ symbol: "COIN", stop_bps: 1500, rung: "r1" }]);
    // Again: the rows the ordinary seed (or the last call) wrote are kept and proved.
    assert.deepEqual(await completeAttestedSeed({ book: b.db, account: f.account, plan, mayWrite: () => null }), { ok: true, basis: 1, floors: 1 });
    assert.equal((b.raw.prepare("SELECT count(*) AS n FROM cost_basis").get() as { n: number }).n, 1);
  });
  it("refuses a book whose row disagrees, and a lost writer before or at the commit, writing nothing", async () => {
    const f = await fixture({ live: true });
    const plan = await planAttestedSeed(f.shared, f.account);
    const wrong = await book();
    wrong.raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'COIN', '10', '99', 1)").run(f.account);
    const r = await completeAttestedSeed({ book: wrong.db, account: f.account, plan, mayWrite: () => null });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.why : "", /disagrees/);
    assert.equal((wrong.raw.prepare("SELECT count(*) AS n FROM position_floors").get() as { n: number }).n, 0, "rolled back");
    const early = await book();
    assert.deepEqual(await completeAttestedSeed({ book: early.db, account: f.account, plan, mayWrite: () => "it holds no lease" }),
      { ok: false, why: "nothing written — it holds no lease" });
    const late = await book();
    let asked = 0;
    const l = await completeAttestedSeed({ book: late.db, account: f.account, plan, mayWrite: () => (++asked > 1 ? "lease lost" : null) });
    assert.equal(l.ok, false);
    assert.equal((late.raw.prepare("SELECT count(*) AS n FROM cost_basis").get() as { n: number }).n, 0, "the late refusal takes the rows back");
  });
});

describe("registerAttestedGapSource", () => {
  async function prepared(o: { approvalState?: string } = {}) {
    const f = await fixture({ live: true });
    await ensureLedgerResumeSchema(f.shared);
    const mount = path.join(root, `mount-${f.id}`), homeRoot = path.join(mount, "fleet");
    mkdirSync(homeRoot, { recursive: true });
    const st = lstatSync(mount, { bigint: true });
    const volume: LedgerImportVolume = { id: `vol_resume_${f.id}`, mountPath: mount, homeRoot, device: String(st.dev), inode: String(st.ino) };
    const home = path.join(homeRoot, "children", f.tenant);
    let healthy = true;
    const lease: TenantLease = { tenant: f.tenant as `0x${string}`, backend: "postgres", healthy: () => healthy, async release() {} };
    const approvalId = "00000000-0000-4000-8000-0000000000a" + (f.id % 10), generation = "00000000-0000-4000-8000-0000000000b" + (f.id % 10);
    const digest = "e".repeat(64);
    f.raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, generation,
      created_at_ms, updated_at_ms) VALUES (?, ?, ?, 4663, ?, ?, '{}', 'r', ?, ?, 1, 1)`).run(approvalId, f.tenant, f.account, f.owner, digest, o.approvalState ?? "archived", generation);
    const before = {
      marks: f.raw.prepare("SELECT table_name, last_id, last_stamp, updated_at FROM mirror_state WHERE tenant = ? ORDER BY table_name").all(f.tenant).map((r) => ({ ...r })),
      basis: f.raw.prepare("SELECT * FROM cost_basis").all().map((r) => ({ ...r })),
      trades: f.raw.prepare("SELECT * FROM trades ORDER BY id").all().map((r) => ({ ...r })),
    };
    const args = { tenant: f.tenant, smartAccount: f.account, chainId: 4663, owner: f.owner, home, volume, shared: f.shared, lease, dialect: "sqlite" as const,
      approvalId, evidenceDigest: digest, generation, archivePath: null, gapFromSec: NOW - 3600,
      chainRead: { fromBlock: "1700000", head: "2000250" } as { fromBlock: string; head: string } | null, recheck: async () => {} };
    return { f, home, volume, lease, args, before, setHealthy: (v: boolean) => { healthy = v; } };
  }
  it("archives the cursors and snapshots, creates the empty book, binds the receipt and moves the approval, all at once", async () => {
    const p = await prepared();
    const r = await registerAttestedGapSource(p.args);
    const { f } = p;
    assert.deepEqual(f.raw.prepare("SELECT * FROM mirror_state WHERE tenant = ?").all(f.tenant), [], "no cursor of the lost book remains");
    const archived = f.raw.prepare("SELECT table_name, last_id, last_stamp, updated_at FROM mirror_state_archive WHERE generation = ? ORDER BY table_name").all(r.generation).map((x) => ({ ...x }));
    assert.deepEqual(archived, p.before.marks, "the archive equals the pre-image");
    const snaps = f.raw.prepare("SELECT table_name, row_json FROM ledger_snapshot_archive WHERE generation = ? ORDER BY table_name, seq").all(r.generation) as Array<{ table_name: string; row_json: string }>;
    assert.deepEqual(snaps.map((s) => s.table_name), ["cost_basis", "position_floors", "positions"]);
    assert.deepEqual(JSON.parse(snaps[0]!.row_json), p.before.basis[0]);
    assert.deepEqual(f.raw.prepare("SELECT * FROM cost_basis").all().map((x) => ({ ...x })), p.before.basis, "the snapshot rows themselves are not changed here");
    assert.deepEqual(f.raw.prepare("SELECT * FROM trades ORDER BY id").all().map((x) => ({ ...x })), p.before.trades, "no financial row is rewritten");
    const receipt = f.raw.prepare("SELECT state, generation, source_identity, source_inode FROM tenant_ledger_import WHERE tenant = ?").get(f.tenant) as Record<string, unknown>;
    assert.deepEqual({ state: receipt.state, generation: receipt.generation, identity: receipt.source_identity },
      { state: "consumed", generation: r.generation, identity: r.generation });
    assert.equal(receipt.source_inode, String(lstatSync(path.join(p.home, "merrymen.db"), { bigint: true }).ino));
    assert.equal((f.raw.prepare("SELECT state FROM ledger_resume_approvals").get() as { state: string }).state, "registered");
    assert.equal((f.raw.prepare("SELECT count(*) AS n FROM ledger_resume_attestations").get() as { n: number }).n, 1);
    assert.deepEqual({ ...(f.raw.prepare("SELECT chain_from_block, chain_head FROM ledger_resume_attestations").get() as object) },
      { chain_from_block: "1700000", chain_head: "2000250" }, "the attestation records the chain window read for it, to the head read last");
    const book = new DatabaseSync(path.join(p.home, "merrymen.db"), { readOnly: true });
    try { assert.equal((book.prepare("SELECT count(*) AS n FROM trades").get() as { n: number }).n, 0); } finally { book.close(); }
    assert.equal(lstatSync(path.join(p.home, "merrymen.db")).mode & 0o777, 0o600);
  });
  it("the approval and the receipt change together: a refusal inside rolls every row back", async () => {
    const p = await prepared();
    await assert.rejects(registerAttestedGapSource({ ...p.args, recheck: async () => { throw new Error("The gap changed during registration."); } }), /gap changed/);
    const { f } = p;
    assert.deepEqual(f.raw.prepare("SELECT table_name, last_id, last_stamp, updated_at FROM mirror_state WHERE tenant = ? ORDER BY table_name").all(f.tenant).map((x) => ({ ...x })), p.before.marks);
    assert.equal(f.raw.prepare("SELECT * FROM tenant_ledger_import WHERE tenant = ?").get(f.tenant), undefined);
    assert.equal((f.raw.prepare("SELECT state FROM ledger_resume_approvals").get() as { state: string }).state, "archived");
    assert.equal((f.raw.prepare("SELECT count(*) AS n FROM mirror_state_archive").get() as { n: number }).n, 0);
  });
  it("a crash after the book was created and before the commit converges on the same generation", async () => {
    const p = await prepared();
    // The empty book is created inside the transaction, before its commit.
    // Fail the commit's last statement, as a lost COMMIT would.
    let failMove = true;
    const flaky: Db = { exec: (s) => p.f.shared.exec(s), prepare: (s) => p.f.shared.prepare(s), tx: (fn) => p.f.shared.tx(async (db) => {
      const wrapped: Db = { ...db, prepare(sql) {
        const st = db.prepare(sql);
        if (failMove && /UPDATE ledger_resume_approvals SET state = 'registered'/.test(sql)) return { ...st, run: async () => { failMove = false; throw new Error("connection lost"); } };
        return st;
      } } as Db;
      return fn(wrapped);
    }) };
    await assert.rejects(registerAttestedGapSource({ ...p.args, shared: flaky }), /connection lost/);
    assert.equal(existsSync(path.join(p.home, "merrymen.db")), true, "the book outlived the rolled-back transaction");
    const r = await registerAttestedGapSource(p.args);
    assert.equal((p.f.raw.prepare("SELECT source_identity FROM tenant_ledger_import WHERE tenant = ?").get(p.f.tenant) as { source_identity: string }).source_identity, r.generation);
    assert.equal((p.f.raw.prepare("SELECT state FROM ledger_resume_approvals").get() as { state: string }).state, "registered");
  });
  it("a crash between the book's O_EXCL create and its identity converges: a 0-byte book, and a schema-only book, are finished on the same generation", async () => {
    for (const leftover of ["empty", "schema-only"] as const) {
      const p = await prepared();
      mkdirSync(p.home, { recursive: true, mode: 0o700 });
      const file = path.join(p.home, "merrymen.db");
      writeFileSync(file, "", { mode: 0o600 });
      if (leftover === "schema-only") {
        const half = new DatabaseSync(file);
        try { await applyLedgerSchema(wrapSqlite(half)); } finally { half.close(); }
      }
      const r = await registerAttestedGapSource(p.args);
      assert.equal(r.generation, p.args.generation, leftover);
      assert.equal((p.f.raw.prepare("SELECT state FROM ledger_resume_approvals").get() as { state: string }).state, "registered", leftover);
      assert.equal((p.f.raw.prepare("SELECT source_identity FROM tenant_ledger_import WHERE tenant = ?").get(p.f.tenant) as { source_identity: string }).source_identity,
        p.args.generation, leftover);
      const book = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal((book.prepare("SELECT book_id FROM ledger_source_identity").get() as { book_id: string }).book_id, p.args.generation);
        assert.equal((book.prepare("SELECT count(*) AS n FROM trades").get() as { n: number }).n, 0);
      } finally { book.close(); }
    }
  });
  it("a book at the path that holds a row, or another generation's identity, refuses and moves nothing", async () => {
    for (const foreign of ["a-row", "other-identity"] as const) {
      const p = await prepared();
      mkdirSync(p.home, { recursive: true, mode: 0o700 });
      const file = path.join(p.home, "merrymen.db");
      const other = new DatabaseSync(file);
      try {
        await applyLedgerSchema(wrapSqlite(other));
        if (foreign === "a-row") other.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'info', 'x', 1)").run(p.f.account);
        else {
          other.exec("CREATE TABLE ledger_source_identity (id INTEGER PRIMARY KEY CHECK (id = 1), book_id TEXT NOT NULL, tenant TEXT NOT NULL, smart_account TEXT NOT NULL, chain_id INTEGER NOT NULL)");
          other.prepare("INSERT INTO ledger_source_identity VALUES (1, '00000000-0000-4000-8000-0000000000ff', ?, ?, 4663)").run(p.f.tenant, p.f.account);
        }
      } finally { other.close(); }
      chmodSync(file, 0o600);
      await assert.rejects(registerAttestedGapSource(p.args), /refused/, foreign);
      assert.deepEqual(p.f.raw.prepare("SELECT table_name, last_id, last_stamp, updated_at FROM mirror_state WHERE tenant = ? ORDER BY table_name").all(p.f.tenant).map((x) => ({ ...x })),
        p.before.marks, foreign);
      assert.equal((p.f.raw.prepare("SELECT state FROM ledger_resume_approvals").get() as { state: string }).state, "archived", foreign);
    }
  });
  it("refuses a staged original import, an approval in another state, a different owner, and a lost lease — each moving nothing", async () => {
    for (const make of [
      async () => { const p = await prepared(); p.f.raw.prepare(`INSERT INTO tenant_ledger_import (tenant, generation, target_volume_id, state, bytes, sha256, source_digest, bindings_json,
          created_at_ms, grant_updated_at, grant_row_version) VALUES (?, 'g-staged', 'v', 'available', 0, '', '', '{}', 1, '1', '1')`).run(p.f.tenant); return p; },
      async () => prepared({ approvalState: "approved" }),
      async () => { const p = await prepared(); p.f.raw.prepare("UPDATE grants SET grant_json = ? WHERE tenant = ?").run(JSON.stringify({ smartAccount: p.f.account, owner: addr(0xdead), chainId: 4663 }), p.f.tenant); return p; },
      async () => { const p = await prepared(); p.setHealthy(false); return p; },
    ]) {
      const p = await make();
      await assert.rejects(registerAttestedGapSource(p.args), /refused/);
      assert.deepEqual(p.f.raw.prepare("SELECT table_name, last_id, last_stamp, updated_at FROM mirror_state WHERE tenant = ? ORDER BY table_name").all(p.f.tenant).map((x) => ({ ...x })), p.before.marks);
      assert.equal(existsSync(path.join(p.home, "merrymen.db")), false);
    }
  });
  it("refuses a chain window that is not one, moving nothing; a tenant that needed no chain read attests none", async () => {
    for (const chainRead of [{ fromBlock: "20", head: "19" }, { fromBlock: "0x10", head: "20" }, { fromBlock: "1", head: "-2" }]) {
      const p = await prepared();
      await assert.rejects(registerAttestedGapSource({ ...p.args, chainRead }), /refused/, JSON.stringify(chainRead));
      assert.deepEqual(p.f.raw.prepare("SELECT table_name, last_id, last_stamp, updated_at FROM mirror_state WHERE tenant = ? ORDER BY table_name").all(p.f.tenant).map((x) => ({ ...x })), p.before.marks);
      assert.equal((p.f.raw.prepare("SELECT state FROM ledger_resume_approvals").get() as { state: string }).state, "archived");
    }
    const p = await prepared();
    await registerAttestedGapSource({ ...p.args, chainRead: null });
    assert.deepEqual({ ...(p.f.raw.prepare("SELECT chain_from_block, chain_head FROM ledger_resume_attestations").get() as object) }, { chain_from_block: null, chain_head: null });
  });
  describe("the ordinary gates on the next pass, after the seeds and before the first worker arms", () => {
    const dek = Buffer.alloc(32, 9);
    /** What the spawn path writes before its later gates: the restored practice book, its paper basis, the live seed, a floor, the day's energy. */
    function seed(home: string, account: string, extra?: (raw: DatabaseSync) => void) {
      const book = new DatabaseSync(path.join(home, "merrymen.db"));
      try {
        book.prepare("INSERT INTO paper_book (agent_id, cash_usdg, vault_usdg, hwm_usdg, shares, updated_at) VALUES (?, 90, 0, 100, '{}', 1)").run(account);
        book.prepare("INSERT INTO cost_basis VALUES (?, 'paper', 'COIN', '10', '20', 1)").run(account);
        book.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'COIN', '10', '20', 1)").run(account);
        book.prepare("INSERT INTO position_floors VALUES (?, 'live', 'COIN', 1500, 'r1', 'entry', 1)").run(account);
        // seedEnergyForChild, which runs before the privacy proof and the handoff.
        book.prepare("INSERT INTO energy_days (agent_id, day, reviews, entries) VALUES (?, '2026-10-05', 3, 1)").run(account);
        extra?.(book);
      } finally { book.close(); }
    }
    const gates = async (p: Awaited<ReturnType<typeof prepared>>) => {
      const o = { tenant: p.f.tenant, smartAccount: p.f.account, chainId: 4663, home: p.home, volume: p.volume, shared: p.f.shared, lease: p.lease, dialect: "sqlite" as const };
      const restored = await restoreLedgerImport({ ...o, dek });
      await registerLedgerSource(o);
      return restored;
    };
    const approvalState = (p: Awaited<ReturnType<typeof prepared>>, state: string) => p.f.raw.prepare("UPDATE ledger_resume_approvals SET state = ?").run(state);

    it("an attested book whose approval registered it is accepted with only its seeds in it, registered or applied", async () => {
      const p = await prepared();
      await registerAttestedGapSource(p.args);
      seed(p.home, p.f.account);
      assert.equal(await gates(p), "present", "registered: the first worker has not started");
      approvalState(p, "applied");
      assert.equal(await gates(p), "present", "applied: started, and perhaps died before it armed");
    });

    it("refuses as before: a row the spawn path never seeds, a withdrawn approval, another registration's digest, a tampered receipt, and an ordinary new book", async () => {
      const refusedWith = async (label: string, make: (p: Awaited<ReturnType<typeof prepared>>) => void | Promise<void>) => {
        const p = await prepared();
        await registerAttestedGapSource(p.args);
        seed(p.home, p.f.account);
        await make(p);
        const o = { tenant: p.f.tenant, smartAccount: p.f.account, chainId: 4663, home: p.home, volume: p.volume, shared: p.f.shared, lease: p.lease, dialect: "sqlite" as const };
        await assert.rejects(restoreLedgerImport({ ...o, dek }), /refused/, `${label}: restoreLedgerImport`);
        await assert.rejects(registerLedgerSource(o), /refused/, `${label}: registerLedgerSource`);
      };
      await refusedWith("a trade with no agent", (p) => {
        const book = new DatabaseSync(path.join(p.home, "merrymen.db"));
        try { book.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at) VALUES (?, 'swap', 'x', 1, 'paper', 1)").run(p.f.account); }
        finally { book.close(); }
      });
      await refusedWith("an event with no agent", (p) => {
        const book = new DatabaseSync(path.join(p.home, "merrymen.db"));
        try { book.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'info', 'x', 1)").run(p.f.account); }
        finally { book.close(); }
      });
      for (const state of ["refused", "revoked"]) await refusedWith(`an approval ${state}`, (p) => { approvalState(p, state); });
      await refusedWith("an attestation recording another digest", (p) => { p.f.raw.prepare("UPDATE ledger_resume_attestations SET receipt_digest = ?").run("0".repeat(64)); });
      await refusedWith("an attestation for another account", (p) => { p.f.raw.prepare("UPDATE ledger_resume_attestations SET smart_account = ?").run(addr(0xbad)); });
      await refusedWith("an approval of other evidence", (p) => { p.f.raw.prepare("UPDATE ledger_resume_approvals SET evidence_digest = ?").run("f".repeat(64)); });
      await refusedWith("a receipt bound to another digest", (p) => {
        const row = p.f.raw.prepare("SELECT bindings_json FROM tenant_ledger_import WHERE tenant = ?").get(p.f.tenant) as { bindings_json: string };
        const bound = JSON.parse(row.bindings_json) as Record<string, unknown>;
        p.f.raw.prepare("UPDATE tenant_ledger_import SET bindings_json = ? WHERE tenant = ?").run(JSON.stringify({ ...bound, mutableDigest: "1".repeat(64) }), p.f.tenant);
      });
      // A genuinely new book (no history, no attestation) with the same rows in it.
      const n = await fixture();
      n.raw.exec("DELETE FROM agents; DELETE FROM trades; DELETE FROM equity; DELETE FROM positions; DELETE FROM cost_basis; DELETE FROM position_floors; DELETE FROM mirror_state");
      const mount = path.join(root, `mount-new-${n.id}`), homeRoot = path.join(mount, "fleet");
      mkdirSync(homeRoot, { recursive: true });
      const st = lstatSync(mount, { bigint: true });
      const volume: LedgerImportVolume = { id: `vol_new_${n.id}`, mountPath: mount, homeRoot, device: String(st.dev), inode: String(st.ino) };
      const home = path.join(homeRoot, "children", n.tenant);
      const lease: TenantLease = { tenant: n.tenant as `0x${string}`, backend: "postgres", healthy: () => true, async release() {} };
      const o = { tenant: n.tenant, smartAccount: n.account, chainId: 4663, home, volume, shared: n.shared, lease, dialect: "sqlite" as const };
      await registerLedgerSource(o);
      seed(home, n.account);
      await assert.rejects(registerLedgerSource(o), /refused/, "an ordinary new book's receipt vouches for no seeds");
      await assert.rejects(restoreLedgerImport({ ...o, dek }), /refused/);
    });
  });

  it("an attestations table from an earlier build gains the chain window's columns", async () => {
    const f = await fixture();
    f.raw.exec(`CREATE TABLE ledger_resume_attestations (generation TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE, tenant TEXT NOT NULL, smart_account TEXT NOT NULL,
      chain_id BIGINT NOT NULL, owner TEXT NOT NULL, evidence_digest TEXT NOT NULL, receipt_digest TEXT NOT NULL, mirror_state_digest TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL, archive_path TEXT, gap_from_sec BIGINT, created_at_ms BIGINT NOT NULL)`);
    await ensureLedgerResumeSchema(f.shared);
    await ensureLedgerResumeSchema(f.shared); // and again: a column already there is not an error
    const columns = (f.raw.prepare("PRAGMA table_info(ledger_resume_attestations)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(columns.includes("chain_from_block") && columns.includes("chain_head"), columns.join(","));
  });
});

