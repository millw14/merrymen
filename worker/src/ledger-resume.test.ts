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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { ensureLedgerResumeSchema, registerAttestedGapSource, type LedgerImportVolume } from "./ledger-import";
import type { TenantLease } from "./tenant-lease";
import {
  applyResumeApprovals, archiveTenantHome, chainGapCheck, homeIdentity, knownChainFacts, moveApproval, parseResumeApprovals, parseResumePreview,
  parseResumeRevokes, readOpenApproval, readResumeEvidence, recordPreviewRun, resumePreconditions, revokeResumeApprovals,
  type GapChain, type PreviewEntry,
} from "./ledger-resume";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-ledger-resume-")));
const handles: DatabaseSync[] = [];
after(() => { for (const h of handles) h.close(); rmSync(root, { recursive: true, force: true }); });
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const NOW = 1_800_000_000;
const OLD = NOW - 5 * 86_400;
const CONTROLS = { readable: true, why: null, digest: "c".repeat(64) };
let fixtures = 0;

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
    assert.deepEqual(parseResumeRevokes(addr(3)), [addr(3)]);
    assert.throws(() => parseResumeRevokes("0x12"), /entry 1/);
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
    });
  }
  it("refuses on unreadable controls alone, and on a half-applied import in the home alone", async () => {
    const f = await fixture({ live: true });
    const a = await resumePreconditions(f.shared, { tenant: f.tenant, account: f.account, grantAccount: f.account, nowSec: NOW, controls: { readable: false, why: "malformed" }, homePendingImport: false });
    assert.deepEqual(a.refusals.map((r) => /owner controls/.test(r)), [true]);
    const b = await resumePreconditions(f.shared, { tenant: f.tenant, account: f.account, grantAccount: f.account, nowSec: NOW, controls: CONTROLS, homePendingImport: true });
    assert.deepEqual(b.refusals.map((r) => /half-applied/.test(r)), [true]);
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
  it("homeIdentity reads an absent home as absent and refuses a home that is not a directory", () => {
    assert.deepEqual(homeIdentity(path.join(root, "nope")), { exists: false });
    writeFileSync(path.join(root, "a-file"), "x");
    assert.throws(() => homeIdentity(path.join(root, "a-file")), /plain directory/);
  });
});

describe("the chain read", () => {
  const ACC = addr(0xabc);
  const topic = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
  function fakeChain(o: { logs?: Array<{ address: string; topics: string[]; tx: string; index: number }>; failAt?: number; stamps?: (b: bigint) => number } = {}): GapChain & { calls: number } {
    const chain = {
      calls: 0,
      async getBlockNumber() { return 2_000_000n; },
      async getBlockTimestamp(b: bigint) { return o.stamps ? o.stamps(b) : NOW - Number(2_000_000n - b) / 10; },
      async getLogs(a: { address: string; topics: Array<string | string[] | null> }) {
        chain.calls += 1;
        if (o.failAt !== undefined && chain.calls >= o.failAt) throw Object.assign(new Error("execution reverted"), { code: -32000 });
        return (o.logs ?? []).filter((l) => l.address.toLowerCase() === a.address.toLowerCase()
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
      suggestedLevel: "trade", anchor: "established:epoch-2", riskPeriod: "none", home: "absent", lastMirrorAt: null, evidence };
    const entries = [entry, ...extra];
    return { run: await recordPreviewRun(f.shared, entries, 1), digest, entries };
  }
  it("a batch approval binds to exactly the tenants that passed in that run", async () => {
    const f = await fixture();
    const failing: PreviewEntry = { tenant: addr(0x1234), account: addr(0x1235), chainId: 4663, owner: addr(0x1236), digest: "d".repeat(64), pass: false,
      refusals: ["x"], chain: null, suggestedLevel: null, anchor: null, riskPeriod: null, home: null, lastMirrorAt: null, evidence: null };
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
    await revokeResumeApprovals(f.shared, [f.tenant], 4, () => {});
    assert.equal(await readOpenApproval(f.shared, f.tenant), null);
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest: second.digest }], 5, () => {}), 1);
    assert.equal(await applyResumeApprovals(f.shared, [{ kind: "tenant", tenant: f.tenant, digest }], 6, () => {}), 0, "a revoked approval is never reopened");
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
    await revokeResumeApprovals(f.shared, [f.tenant], 3, (l) => lines.push(l));
    assert.equal((await readOpenApproval(f.shared, f.tenant))?.state, "registered");
    assert.match(lines[0]!, /past the point a revoke undoes/);
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
  it("a lost lease before the rename moves nothing", () => {
    const h = home("t3"), archiveRoot = path.join(root, "vol", "archive", "t3"), gen = "00000000-0000-4000-8000-000000000013";
    assert.throws(() => archiveTenantHome({ home: h, archiveRoot, generation: gen, mayWrite: () => false }), /Lost the tenant lease/);
    assert.ok(existsSync(path.join(h, "grant.json")) && existsSync(path.join(h, "merrymen.db")));
    assert.equal(existsSync(path.join(archiveRoot, gen)), false);
  });
  it("with no home there is nothing to archive", () => {
    assert.deepEqual(archiveTenantHome({ home: path.join(root, "vol", "children", "none"), archiveRoot: path.join(root, "vol", "archive", "none"),
      generation: "00000000-0000-4000-8000-000000000014", mayWrite: () => true }), { archivePath: null, carried: [] });
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
      approvalId, evidenceDigest: digest, generation, archivePath: null, gapFromSec: NOW - 3600, recheck: async () => {} };
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
});

void chmodSync;
