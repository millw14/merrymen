/**
 * FILING A CLOSED EPOCH'S CAPITAL, against 0x0e1ca0…'s exact shape.
 *
 * The chain is the account's own: every transaction that moved its USDG or
 * carried one of its operations, from block 0, read from the public node
 * (testdata/closed-epoch-0e1ca0.json): the deposit c8ab…#0 from 0x472e130c,
 * seventeen session-key trades, and the owner's root-key sweep ffd1…#7 back
 * to 0x472e130c (with MU, USAR and steakUSDG). The class vault has none. A
 * fake JSON-RPC answers from that one model — logs, receipts, blocks and
 * balances — and refuses a log read wider than the public node does, in its
 * words.
 *
 * Postgres is a real sqlite with the ledger schema, filled as the booking
 * tool's real preview of this tenant read it on 2026-10-07 (agents epoch 2,
 * paper, hwm 145.579752, withdrawn 0, no flows, the 18 operations answered by
 * trades rows, live MU and USAR basis over positions that still show them
 * held), plus what that preview did not read: epoch-1 marks, epoch 2's paper
 * opening, runPaperReset's line, live floors. The 0x4b6dcd receipts
 * (testdata/closed-epoch-4b6dcd.json) are the owner-operation fixture.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { ensureLedgerResumeSchema, LEDGER_IMPORT_SCHEMA } from "./ledger-import";
import { CHAIN_REFUSAL, chainGapCheck, knownChainFacts, planAttestedSeed, readPgEvidence, resumePreconditions } from "./ledger-resume";
import { flowDuplicateReport } from "./distinct-flows";
import { CASH, GRANT_PONS_CLASS, GRANT_TRENCHER, MERRYMEN_TOKEN } from "../../packages/core/src/index";
import type { RpcCall } from "./chain-capital";
import { BookingRefused, BOOKINGS_TABLE, canonical, gapChainOf } from "./chain-gap-booking";
import {
  applyClosedEpoch, CLOSED_EPOCH_APPLY_FORMAT, classifyEvent, closedEpochLines, homeOfEvidence, parseRepairReport, planClosedEpoch, readClosedEpochChain, readClosedEpochSnapshot,
  readRepairReceipts, REPAIRS_TABLE, retainedHomeVerdict, revertClosedEpoch, staleBasisPlan, type ClosedEpochPlan, type RepairApplyReport,
} from "./closed-epoch-capital";
import { heldResetEvent } from "./held-reset";
import { assertLedgerSourceContinuity } from "./ledger-safeguard";

// ── the public chain, as read ────────────────────────────────────────────────

type FixtureLog = [address: string, topics: string[], data: string, logIndex: string];
interface FixtureTx { tx: string; block: string; blockHash: string; timestamp: number; from: string; to: string | null; status: string; logs: FixtureLog[]; name?: string }
const FX = JSON.parse(readFileSync(new URL("./testdata/closed-epoch-0e1ca0.json", import.meta.url), "utf8")) as { head: number; pinned: number; txs: FixtureTx[] };
const OWNER_FX = JSON.parse(readFileSync(new URL("./testdata/closed-epoch-4b6dcd.json", import.meta.url), "utf8")) as { txs: FixtureTx[] };

const TENANT = "0x0e1ca00202df6e686ac2317e10ed8ee8ae5e320d";
const ACCOUNT = "0x88e47214b5a0ca488cdabb4c9c28c3b71441ba78";
/** How the grant and the agents row spell it (the booking preview's agentId). */
const SPELLED = "0x88e47214B5a0cA488cDABB4c9C28c3B71441BA78";
const SPELLED_GRANT = SPELLED;
const CLASS_VAULT = "0xc730419217884328b7944b2504423e1a3a078c17";
const FUNDER = "0x472e130cafb21f110dac968f23ba0d621c325849";
const MU = "0xff080c8ce2e5feadaca0da81314ae59d232d4afd", USAR = "0xd917b029c761d264c6a312bbbcda868658ef86a6", STEAK = "0xbeeff033f34c046626b8d0a041844c5d1a5409dd";
const DEPOSIT_TX = "0xc8ab6c45c87afb3d563b098bbee02d46bfb44f459976c7e142f9a32be8ade6c5";
const SWEEP_TX = "0xffd1143ee9ed3bce4cc9be603391433d28b5c15e5fa181305ab94f1f4369dfb1";
const SWEEP_OP = "0x0a223e56ed7a7f42c5fed39a376ea6f14eaa975abcf8bce14e6b652cdf3d9e85";
const DEPOSIT_AT = 1789515138, SWEEP_AT = 1789592963;
/** Epoch 2's first row: the paper opening at 2026-09-16T21:21:51Z (the booking preview's epochOpenedAt). */
const EPOCH2_AT = 1789593711;
const USDG = String(CASH.USDG).toLowerCase();
const EP = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const UOE = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const BEFORE = "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972";
const TR = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SPAN_LIMIT = 10_000_000n;
const topic = (a: string) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const h32 = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}`;
const SOURCE = { files: { "closed-epoch-capital.ts": "test" } }, TARGET = "test-database";

interface ModelTx { tx: string; block: bigint; blockHash: string; timestamp: number; from: string; to: string | null; status: string; logs: FixtureLog[] }
const fromFixture = (f: FixtureTx): ModelTx => ({ ...f, block: BigInt(f.block), logs: f.logs.map((l) => [...l] as FixtureLog) });
const REAL = FX.txs.map(fromFixture);
/** The account's operations as the chain recorded them: userOpHash, transaction, block time, and whether the root key signed. */
const OPS = REAL.flatMap((t) => t.logs.filter((l) => l[0] === EP && l[1][0] === UOE && l[1][2] === topic(ACCOUNT))
  .map((l) => ({ op: l[1][1]!, tx: t.tx, at: t.timestamp, root: BigInt(`0x${l[2].slice(2, 66)}`) >> 240n === 0n })));

/** Blocks between the real ones are dated as the chain ran: ~9.94 blocks a second, through every real block's own time. */
const RATE = 9.936;
const POINTS = [...new Map(REAL.map((t) => [t.block, t.timestamp])).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
function timeOf(b: bigint): number {
  const first = POINTS[0]!, last = POINTS[POINTS.length - 1]!;
  if (b <= first[0]) return first[1] - Math.ceil(Number(first[0] - b) / RATE);
  if (b >= last[0]) return last[1] + Math.floor(Number(b - last[0]) / RATE);
  for (let i = 1; i < POINTS.length; i++) {
    const [b1, t1] = POINTS[i]!, [b0, t0] = POINTS[i - 1]!;
    if (b <= b1) return t0 + Math.floor((t1 - t0) * Number(b - b0) / Number(b1 - b0));
  }
  return last[1];
}
const HEAD = BigInt(FX.head);
/** Ten minutes after the head the fixture was read at: long after admission refused the tenant (2026-10-06). */
const NOW = timeOf(HEAD) + 600;

/**
 * A JSON-RPC answering from one model: getLogs filtered by address, topics
 * and range (and refused over 10M blocks, as the public node refuses it),
 * receipts and blocks, and balanceOf at the pinned block only.
 */
function fakeRpc(o: {
  txs?: ModelTx[]; head?: bigint; chainId?: number;
  balances?: Record<string, Record<string, bigint>>; failBalances?: string[]; pruned?: boolean;
  failReceipts?: string[]; orphaned?: string[]; refuseEveryRange?: boolean; spanLimit?: bigint;
  /** getLogs filters naming this address in any topic are refused (a node that cannot read that range). */
  refuseLogsFor?: string;
  /** getLogs over any block past the pinned one is refused: admission's own window, never the history. */
  refuseBeyondPinned?: boolean;
  /** One extra log the node returns for the account's USDG-in filter from block 0, as given. */
  extraLog?: { address: string; topics: string[]; data: string; logIndex: string; blockNumber: string; transactionHash: string };
  failHead?: boolean;
} = {}) {
  const txs = o.txs ?? REAL;
  const head = o.head ?? HEAD;
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const blockOf = (b: bigint) => {
    const real = txs.find((t) => t.block === b);
    return { number: `0x${b.toString(16)}`, hash: real?.blockHash ?? h32(`block ${b}`), timestamp: `0x${(real?.timestamp ?? timeOf(b)).toString(16)}` };
  };
  const logsOf = (t: ModelTx) => t.logs.map(([address, topics, data, logIndex]) => ({ address, topics, data, logIndex, blockNumber: `0x${t.block.toString(16)}`, transactionHash: t.tx }));
  const rpc: RpcCall = async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_chainId") return `0x${(o.chainId ?? 4663).toString(16)}`;
    if (method === "eth_blockNumber") { if (o.failHead) throw new Error("rpc-read-failed"); return `0x${head.toString(16)}`; }
    if (method === "eth_getBlockByNumber") return blockOf(BigInt(params[0] as string));
    if (method === "eth_getLogs") {
      const f = params[0] as { address: string; fromBlock: string; toBlock: string; topics: Array<string | string[] | null> };
      const from = BigInt(f.fromBlock), to = BigInt(f.toBlock);
      if ((o.refuseLogsFor && f.topics.some((t) => t === topic(o.refuseLogsFor!))) || (o.refuseBeyondPinned && to > head - 64n)) throw new Error("rpc-read-failed");
      if (o.refuseEveryRange || to - from + 1n > (o.spanLimit ?? SPAN_LIMIT)) {
        throw Object.assign(new Error(`query spans ${to - from + 1n} blocks (${from} to ${to}), but only ${o.spanLimit ?? SPAN_LIMIT} are allowed for this request; narrow the block range`), { code: -32602 });
      }
      const extra = o.extraLog && f.address.toLowerCase() === USDG && f.topics[2] === topic(ACCOUNT) && from === 0n ? [o.extraLog] : [];
      return [...extra, ...txs.filter((t) => t.block >= from && t.block <= to).flatMap(logsOf)]
        .filter((l) => l.address.toLowerCase() === f.address.toLowerCase()
          && f.topics.every((want, i) => want === null || (Array.isArray(want) ? want.map((x) => x.toLowerCase()) : [want.toLowerCase()]).includes(String(l.topics[i] ?? "").toLowerCase())));
    }
    if (method === "eth_getTransactionReceipt") {
      if (o.failReceipts?.includes(params[0] as string)) throw new Error("rpc-read-failed");
      const t = txs.find((x) => x.tx === params[0]);
      return t ? { status: t.status, blockNumber: `0x${t.block.toString(16)}`, blockHash: o.orphaned?.includes(t.tx) ? h32(`orphan of ${t.block}`) : blockOf(t.block).hash,
        from: t.from, to: t.to, transactionHash: t.tx, logs: logsOf(t) } : null;
    }
    if (method === "eth_call") {
      const [call, tag] = params as [{ to: string; data: string }, string];
      assert.match(call.data, /^0x70a08231[0]{24}[0-9a-f]{40}$/, "only balanceOf is ever called");
      assert.equal(tag, `0x${(head - 64n).toString(16)}`, "pinned: the head less 64, never a tag");
      if (o.failBalances?.includes(call.to.toLowerCase())) throw new Error(o.pruned ? "missing trie node 0xabc (path )" : "rpc-read-failed");
      return `0x${word(o.balances?.[call.to.toLowerCase()]?.[`0x${call.data.slice(-40)}`] ?? 0n)}`;
    }
    throw new Error(`method ${method} is outside the fake`);
  };
  return { rpc, calls };
}

// ── the shared database ──────────────────────────────────────────────────────

const handles: DatabaseSync[] = [];
after(() => { for (const h of handles) h.close(); });
const REFUSED_CREATED_MS = 1791248849249, REFUSED_AT_MS = 1791250434038;
const BEAT_AT = 1789829679, MIRRORED_AT = 1789829702;
const PAPER_RESET_LINE = "paper book restarted — cash back to 1,000.00 USDG, positions cleared, and earlier paper trades closed into epoch 1 (kept, but no longer counted)";

/**
 * WHAT ADMISSION'S EVIDENCE BOUND OF THE HOME at the anchor, as recordApproval
 * stores an evidence: its canonical text, and the sha256 of exactly that text
 * as the digest. Only the tenant, the account and `home` are read by the tool;
 * the rest stands in for a real evidence. `absent`: the home holds no
 * merrymen.db (the lost book of a pre-incident tenant); `present`: an old book,
 * unblocked; `blocked`: behind a source barrier; `no-home`: an evidence
 * recorded before admission bound the home.
 */
type HomeBound = "absent" | "present" | "blocked" | "no-home";
function anchorEvidence(home: HomeBound, o: { tenant?: string } = {}): { json: string; digest: string } {
  const bound = home === "no-home" ? {} : { home: home === "absent" ? { exists: true, ino: "7001", db: null, markers: [] }
    : { exists: true, ino: "7001", db: { ino: "7002", size: "4096" }, markers: home === "blocked" ? ["ledger-source-blocked.json"] : [] } };
  const json = canonical({ version: 1, tenant: o.tenant ?? TENANT, account: ACCOUNT, chainId: 4663, owner: TENANT, pg: { agent: { epoch: "2", mode: "paper" } },
    checks: { anchor: "established:epoch-2", riskPeriod: "none", controls: "c".repeat(64), unresolved: 0, chain: "required" }, ...bound });
  return { json, digest: createHash("sha256").update(json).digest("hex") };
}

interface Books { raw: DatabaseSync; db: Db }
/**
 * 0x0e1ca0's Postgres as the incident left it. `marks` are epoch 1's
 * valuations (the last at 21:15:00, after the sweep: witness W1); `reset`
 * writes runPaperReset's line beside the paper opening (W3). `home` is what
 * admission's evidence for the chain refusal bound of the tenant's home
 * (absent unless said); `archived`, that the refusal came after admission
 * archived it; `unverified`, an evidence that does not hash to its digest.
 */
async function books(o: { marks?: number[]; reset?: number | null; mode?: string; floors?: boolean; rows?: string; home?: HomeBound | "archived" | "unverified" } = {}): Promise<Books> {
  /** How every row spells the account; the grant always spells it SPELLED (EIP-55), as the real one does. */
  const SPELLED = o.rows ?? SPELLED_GRANT;
  const raw = new DatabaseSync(":memory:"); handles.push(raw);
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db); await db.exec(MIRROR_STATE_DDL); await db.exec(PAPER_CHECKPOINT_SCHEMA);
  raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL, row_version INTEGER NOT NULL)");
  raw.prepare("INSERT INTO grants VALUES (?, ?, 1000, 1)").run(TENANT, JSON.stringify({
    smartAccount: SPELLED_GRANT, owner: TENANT, chainId: 4663, serialized: "never-read", grantFeatures: ["tradeable-v2", GRANT_PONS_CLASS], ponsClassVaultAddress: CLASS_VAULT,
  }));
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, hwm_withdrawn_usdg, mode, beat_at)
    VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 2, 145.579752, 0, ?, ?)`).run(SPELLED, TENANT, addr(1), o.mode ?? "paper", BEAT_AT);
  // Another hosted account: the classifier's known set (agents.smart_account) is the whole fleet's.
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 1, 0, 'live')`).run(addr(0x0ca1), addr(0x0ca2), addr(1));
  // The 17 session trades and the sweep: every operation answered by its trades row, as the booking preview found (18 ops, 18 txs).
  for (const op of OPS) {
    const sweep = op.op === SWEEP_OP;
    raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch) VALUES (?, 'swap', ?, ?, ?, ?, 'landed', ?, 1)`)
      // The sweep's row: the in-flight reconciler's, at the arm that found it, with the USDG leg as its notional.
      .run(SPELLED, SPELLED, sweep ? 144.81853 : 5, op.op, op.tx, sweep ? SWEEP_AT + 630 : op.at);
  }
  for (const at of [EPOCH2_AT + 120, EPOCH2_AT + 900]) {
    raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, epoch) VALUES (?, 'swap', 'paper', 5, 'paper', ?, 2)`).run(SPELLED, at);
  }
  for (const at of o.marks ?? [DEPOSIT_AT + 62, 1789556100, 1789590700, 1789593300]) {
    raw.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, flows_held, cash_read_at, at)
      VALUES (?, '1000', 0.68, 0, 0, 0.68, 1, 'live', 0, ?, ?)`).run(SPELLED, at, at);
  }
  // writePaperOpening's row, in resetPaperLedger's transaction; then a paper mark.
  raw.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, flows_held, cash_read_at, at)
    VALUES (?, '0', 1000, 0, 0, 1000, 2, 'paper', 0, ?, ?)`).run(SPELLED, EPOCH2_AT, EPOCH2_AT);
  raw.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, flows_held, cash_read_at, at)
    VALUES (?, '0', 990, 0, 10, 1000, 2, 'paper', 0, ?, ?)`).run(SPELLED, EPOCH2_AT + 1200, EPOCH2_AT + 1200);
  if (o.reset !== null) raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'ok', ?, ?)").run(SPELLED, PAPER_RESET_LINE, o.reset ?? EPOCH2_AT);
  // The live book's last snapshot (21:05:49, before the sweep), as the booking preview read it.
  raw.prepare(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg, updated_at) VALUES (?, 'MU', ?, '5365685809818', '1', 1, 0, 1, 1789592749)`)
    .run(SPELLED, MU);
  raw.prepare(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg, updated_at) VALUES (?, 'USAR', ?, '105986355046803', '1', 1, 0, 1, 1789592749)`)
    .run(SPELLED, USAR);
  raw.prepare("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES (?, 'live', 'MU', '5365685809818', '5026', 1789590627)").run(SPELLED);
  raw.prepare("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES (?, 'live', 'USAR', '105986355046803', '1654', 1789590653)").run(SPELLED);
  if (o.floors !== false) {
    raw.prepare("INSERT INTO position_floors (agent_id, mode, symbol, stop_bps, rung, why, at) VALUES (?, 'live', 'MU', 1500, 'standard', 'graded at entry', 1789556100)").run(SPELLED);
    raw.prepare("INSERT INTO position_floors (agent_id, mode, symbol, stop_bps, rung, why, at) VALUES (?, 'live', 'USAR', 1800, 'wide', 'graded at entry', 1789556120)").run(SPELLED);
  }
  for (const table of ["trades", "flows", "equity", "events"]) {
    raw.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, ?, 9, ?, ?)").run(TENANT, table, EPOCH2_AT, MIRRORED_AT);
  }
  await ensureLedgerResumeSchema(db);
  const home = o.home ?? "absent";
  const evidence = home === "unverified" ? { json: "{}", digest: "e".repeat(64) } : anchorEvidence(home === "archived" ? "present" : home);
  raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, reason,
      created_at_ms, updated_at_ms, chain_read_from_sec, generation, archive_path) VALUES ('8d1c4c6b', ?, ?, 4663, ?, ?, ?, 'r', 'refused', ?, ?, ?, ?, ?, ?)`)
    .run(TENANT, ACCOUNT, TENANT, evidence.digest, evidence.json, `${CHAIN_REFUSAL}: USDG in 145.499004 in tx ${DEPOSIT_TX} log 0 at block 64045884`,
      REFUSED_CREATED_MS, REFUSED_AT_MS, 1789238789, home === "archived" ? "g-8d1c4c6b" : null, home === "archived" ? `/data/archive/${TENANT}/g-8d1c4c6b` : null);
  return { raw, db };
}

async function preview(b: Books, rpc: RpcCall, o: { epoch?: number; nowSec?: number; maxSpan?: bigint } = {}): Promise<ClosedEpochPlan> {
  const nowSec = o.nowSec ?? NOW;
  const snap = await readClosedEpochSnapshot(b.db, { tenant: TENANT, dialect: "sqlite", nowSec, epoch: o.epoch ?? 1 });
  const chain = await readClosedEpochChain(rpc, snap, { sleep: async () => {}, ...(o.maxSpan ? { maxSpan: o.maxSpan } : {}) });
  return planClosedEpoch(snap, chain, { nowSec, source: SOURCE, target: TARGET });
}
const apply = (b: Books, p: ClosedEpochPlan, extra: Partial<{ confirm: string; backupRef: string; nowMs: number; repairId: string }> = {}) =>
  applyClosedEpoch(b.db, p, { confirm: p.previewDigest, backupRef: "railway-backup-2026-10-07T09:00Z", dialect: "sqlite", nowMs: NOW * 1000, ...extra });
const rows = (raw: DatabaseSync, sql: string, ...args: unknown[]) => (raw.prepare(sql).all(...(args as never[])) as Array<Record<string, unknown>>).map((r) => ({ ...r }));
const codes = (p: ClosedEpochPlan) => p.refusals.map((r) => r.code);
/** What admission's own chain check says about the account now, from the same model. */
async function admissionSays(b: Books, rpc: RpcCall) {
  const snap = await readClosedEpochSnapshot(b.db, { tenant: TENANT, dialect: "sqlite", nowSec: NOW, epoch: 1 });
  return chainGapCheck({ chain: gapChainOf(rpc, async () => {}), account: ACCOUNT, usdg: USDG, sinceSec: snap.booking.gapFromSec, known: await knownChainFacts(b.db, ACCOUNT), maxSpan: SPAN_LIMIT });
}
/** Every flows row of the account, every column, by id: what "byte for byte" is checked against. */
const allFlows = (raw: DatabaseSync) => rows(raw, "SELECT * FROM flows WHERE LOWER(agent_id) = ? ORDER BY id", ACCOUNT);
const snapshotTables = (raw: DatabaseSync) => ({
  agents: rows(raw, "SELECT * FROM agents ORDER BY smart_account"), basis: rows(raw, "SELECT * FROM cost_basis ORDER BY symbol, mode"),
  floors: rows(raw, "SELECT * FROM position_floors ORDER BY symbol, mode"), positions: rows(raw, "SELECT * FROM positions ORDER BY symbol"),
  trades: rows(raw, "SELECT * FROM trades ORDER BY id"), equity: rows(raw, "SELECT * FROM equity ORDER BY id"), events: rows(raw, "SELECT * FROM events ORDER BY id"),
  fees: rows(raw, "SELECT * FROM fee_accruals ORDER BY id"), risk: rows(raw, "SELECT * FROM risk_periods ORDER BY id"), paper: rows(raw, "SELECT * FROM paper_book"),
});
const CONTROLS = { readable: true, why: null };

describe("0x0e1ca0's exact shape: an owner's deposit and sweep, both inside closed epoch 1", () => {
  it("the chain from block 0, read in the public node's 10M-block spans, is exactly 19 USDG movements and 18 operations, and nets to the balance", async () => {
    const b = await books();
    const { rpc, calls } = fakeRpc();
    const p = await preview(b, rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    assert.deepEqual([p.coverage.movements, p.ops.length, p.coverage.matches, p.coverage.neverNegative, p.coverage.netRaw, p.coverage.balanceRaw],
      [19, 18, true, true, "0", "0"]);
    assert.deepEqual([p.coverage.inRaw, p.coverage.outRaw], ["244818530", "244818530"]);
    // Nine spans of at most 10M blocks to the pinned block, for each of the five filters (the account's USDG out and in, its operations, the class vault's out and in).
    const spans = calls.filter((c) => c.method === "eth_getLogs" && BigInt((c.params[0] as { fromBlock: string }).fromBlock) === 0n);
    assert.equal(spans.length, 5, "five filters start at block 0");
    const fromZero = calls.filter((c) => c.method === "eth_getLogs").map((c) => c.params[0] as { fromBlock: string; toBlock: string });
    assert.ok(fromZero.every((f) => BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n <= SPAN_LIMIT), "never a span the node refuses twice");
    const kinds = p.movements.map((m) => m.classification!.kind);
    assert.deepEqual([kinds.filter((k) => k === "capital-in").length, kinds.filter((k) => k === "capital-out").length, kinds.filter((k) => k === "trade-in").length,
      kinds.filter((k) => k === "trade-out").length], [1, 1, 4, 13]);
    const deposit = p.movements.find((m) => m.key === `log:${DEPOSIT_TX}#0`)!;
    assert.deepEqual([deposit.direction, deposit.amountRaw, deposit.counterparty, deposit.classification!.rule, deposit.counterpartyKnownAccount, deposit.at, deposit.epochByTime],
      ["in", "145499004", FUNDER, "no-pair-external", false, DEPOSIT_AT, 1]);
    const sweep = p.movements.find((m) => m.key === `log:${SWEEP_TX}#7`)!;
    assert.deepEqual([sweep.direction, sweep.amountRaw, sweep.counterparty, sweep.classification!.kind, sweep.classification!.rule, sweep.at, sweep.answeredBy.trades.length],
      ["out", "144818530", FUNDER, "capital-out", "no-pair-external", SWEEP_AT, 1]);
    assert.deepEqual(p.custody, [{ address: CLASS_VAULT, complete: true, movements: 0, netRaw: "0", balanceRaw: "0", outside: [] }]);
  });

  it("proposes the capital PAIR into epoch 1 at block time, clears the seeded MU and USAR basis and floors, and moves no peak", async () => {
    const b = await books();
    const p = await preview(b, fakeRpc().rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    assert.deepEqual(p.proposals.inserts.map((i) => i.row), [
      { agent_id: SPELLED, direction: "in", amount_usdg: 145.499004, tx_hash: DEPOSIT_TX, block_number: 64045884, log_index: 0, source: "chain-log", epoch: 1, chain_id: 4663, at: DEPOSIT_AT },
      { agent_id: SPELLED, direction: "out", amount_usdg: 144.81853, tx_hash: SWEEP_TX, block_number: 64819173, log_index: 7, source: "chain-log", epoch: 1, chain_id: 4663, at: SWEEP_AT },
    ]);
    assert.deepEqual(p.proposals.quarantines, [], "Postgres holds no flows for this account at all");
    assert.deepEqual(p.proposals.clears.map((c) => [c.kind, c.symbol, c.token]),
      [["clear-live-basis", "MU", MU], ["clear-live-floor", "MU", MU], ["clear-live-basis", "USAR", USAR], ["clear-live-floor", "USAR", USAR]]);
    assert.deepEqual([p.predicted.epochNetBefore, p.predicted.epochNetAfter], ["0", "680474"], "epoch 1 net 0 → 0.680474: the trading loss");
    // THE BOUNDARY: epoch 2's first row at 21:21:51, and an epoch-1 valuation at 21:15:00, after the sweep (W1).
    assert.deepEqual([p.boundary.upperSec, p.boundary.maxFact, p.boundary.witness?.kind, p.boundary.witness?.at, p.boundary.lastMark], [EPOCH2_AT, SWEEP_AT, "W1", 1789593300, 1789593300]);
    assert.ok(EPOCH2_AT - SWEEP_AT >= 60, "748s of margin to epoch 2's first row");
    // ADMISSION: today it names the deposit; with the two rows it would name nothing.
    assert.deepEqual(p.admission.found.map((d) => d.said), [`USDG in 145.499004 in tx ${DEPOSIT_TX} log 0 at block 64045884`]);
    assert.deepEqual([p.admission.remaining.length, p.admission.afterBoundary.length], [0, 0]);
    // THE SWEEP'S OPERATION: the owner's root key, answered by the reconciler's 'swap' row — reported, flagged, left alone.
    const op = p.ops.find((x) => x.userOpHash === SWEEP_OP)!;
    assert.deepEqual([op.validator, op.success, op.epochByTime, op.ownerOperationRecordedAsTrade, op.answeredBy.map((t) => [t.kind, t.amountUsdg, t.epoch])],
      ["root", true, 1, true, [["swap", 144.81853, 1]]]);
    assert.deepEqual(op.inKind.map((k) => [k.token, k.direction, k.counterparty]).filter(([t]) => [MU, USAR, STEAK].includes(t!)),
      [[MU, "out", FUNDER], [USAR, "out", FUNDER], [STEAK, "out", FUNDER]], "the leftovers it swept, for review only");
    assert.equal(p.ops.filter((x) => x.validator === "permission").length, 17);
    assert.ok(p.warnings.some((w) => /owner operation recorded as an agent trade/.test(w)));
    assert.ok(p.warnings.some((w) => /no peak moves: hwm_usdg 145\.579752 less hwm_withdrawn_usdg 0/.test(w)));
    // WHAT ADMISSION WOULD SEED: MU and USAR now (positions still say held), nothing after.
    assert.deepEqual(p.holdings.seedBefore.basis.map((x) => x.symbol), ["MU", "USAR"]);
    assert.deepEqual(p.holdings.seedBefore.floors.map((x) => x.symbol), ["MU", "USAR"]);
    assert.deepEqual(p.holdings.seedAfter, { basis: [], floors: [] });
    assert.deepEqual(p.holdings.verdicts.map((v) => [v.symbol, v.verdict, v.total]), [["MU", "clear", "0"], ["USAR", "clear", "0"]]);
    // Same books and chain, same digest; the time of the preview is not in it.
    assert.equal((await preview(b, fakeRpc().rpc, { nowSec: NOW + 600 })).previewDigest, p.previewDigest);
    assert.ok(closedEpochLines(p).some((l) => l.includes(`file in epoch 1: USDG in 145.499004 from ${FUNDER}`)));
  });

  it("apply files, verifies and clears in one transaction: admission's check is then clean, nothing outside epoch 1 moves, and nothing is seeded for a flat token", async () => {
    const b = await books();
    const { rpc } = fakeRpc();
    const p = await preview(b, rpc);
    const before = snapshotTables(b.raw);
    const pre = await resumePreconditions(b.db, { tenant: TENANT, account: ACCOUNT, grantAccount: SPELLED, nowSec: NOW, controls: CONTROLS, homePendingImport: false });
    let persisted: RepairApplyReport | null = null;
    const report = await applyClosedEpoch(b.db, p, { confirm: p.previewDigest, backupRef: "railway-backup-2026-10-07T09:00Z", dialect: "sqlite", nowMs: NOW * 1000,
      persist: (r) => { persisted = r; assert.equal(rows(b.raw, `SELECT COUNT(*) AS n FROM ${REPAIRS_TABLE}`)[0]!.n, 4 + 2, "persisted inside the transaction, receipts and all"); } });
    assert.deepEqual(persisted, report, "the report is handed over before the commit");
    assert.equal(report.format, CLOSED_EPOCH_APPLY_FORMAT);
    assert.deepEqual(report.actions.map((a) => [a.action, a.evidenceKey.replace(/:[0-9a-f]{16}$/, "")]), [
      ["insert-flow", `log:${DEPOSIT_TX}#0`], ["insert-flow", `log:${SWEEP_TX}#7`],
      ["clear-live-basis", "basis:live:MU"], ["clear-live-floor", "floor:live:MU"], ["clear-live-basis", "basis:live:USAR"], ["clear-live-floor", "floor:live:USAR"],
    ]);
    const flows = allFlows(b.raw);
    assert.deepEqual(flows.map((f) => [f.agent_id, f.direction, f.amount_usdg, f.tx_hash, f.block_number, f.log_index, f.source, f.epoch, f.chain_id, f.at]), [
      [SPELLED, "in", 145.499004, DEPOSIT_TX, 64045884, 0, "chain-log", 1, 4663, DEPOSIT_AT],
      [SPELLED, "out", 144.81853, SWEEP_TX, 64819173, 7, "chain-log", 1, 4663, SWEEP_AT],
    ]);
    const now = snapshotTables(b.raw);
    for (const t of ["agents", "positions", "trades", "equity", "events", "fees", "risk", "paper"] as const) assert.deepEqual(now[t], before[t], `${t} untouched`);
    assert.deepEqual(now.basis, [], "both live basis rows gone");
    assert.deepEqual(now.floors, [], "both live floors gone");
    // ADMISSION'S OWN RULES, NOW.
    assert.equal((await admissionSays(b, rpc)).status, "clean");
    for (const run of [1, 2]) assert.equal((await flowDuplicateReport(b.db, ACCOUNT, run)).clean, true);
    const post = await resumePreconditions(b.db, { tenant: TENANT, account: ACCOUNT, grantAccount: SPELLED, nowSec: NOW, controls: CONTROLS, homePendingImport: false });
    assert.deepEqual(post.refusals, pre.refusals, "no precondition moves (no flows-duplicate refusal)");
    assert.deepEqual(await planAttestedSeed(b.db, SPELLED), { basis: [], floors: [] });
    const receipts = rows(b.raw, `SELECT action, evidence_key, state, epoch, account, backup_ref, preview_digest FROM ${REPAIRS_TABLE} ORDER BY evidence_key`);
    assert.ok(receipts.every((r) => r.state === "applied" && r.epoch === 1 && r.account === ACCOUNT && r.backup_ref === "railway-backup-2026-10-07T09:00Z" && r.preview_digest === p.previewDigest));
    // AGAIN: nothing to do, and the database unchanged.
    const again = await preview(b, rpc);
    assert.equal(again.verdict, "nothing-to-do", closedEpochLines(again).join("\n"));
    const flowsNow = allFlows(b.raw);
    await assert.rejects(apply(b, again), (e: unknown) => e instanceof BookingRefused && e.code === "nothing-to-do");
    await assert.rejects(apply(b, p), (e: unknown) => e instanceof BookingRefused && e.code === "cas", "the old preview's facts moved");
    assert.deepEqual(allFlows(b.raw), flowsNow);
    // ONE LOG, FILED ONCE, ACROSS EVERY EPOCH: a second applied receipt of the same evidence in another epoch is refused by the index.
    assert.throws(() => b.raw.prepare(`INSERT INTO ${REPAIRS_TABLE} (repair_id, tenant, account, epoch, chain_id, action, evidence_key, table_name, row_key, row_json, row_digest,
      preview_digest, backup_ref, admission_json, fingerprints_json, state, applied_at_ms) VALUES ('other', ?, ?, 2, 4663, 'insert-flow', ?, 'flows', '{}', '{}', 'd', 'p', 'b', '{}', '{}', 'applied', 1)`)
      .run(TENANT, ACCOUNT, `log:${DEPOSIT_TX}#0`), /UNIQUE/);
  });

  it("revert restores everything exactly, the gap check names the deposit again, and a second revert changes nothing", async () => {
    const b = await books();
    const { rpc } = fakeRpc();
    const p = await preview(b, rpc);
    const before = { flows: allFlows(b.raw), tables: snapshotTables(b.raw) };
    const report = await apply(b, p);
    const reparsed = parseRepairReport(JSON.stringify(report));
    const r = await revertClosedEpoch(b.db, { repairId: report.repairId, report: reparsed, nowMs: (NOW + 60) * 1000, dialect: "sqlite" });
    assert.equal(r.outcome, "reverted");
    assert.deepEqual(allFlows(b.raw), before.flows);
    assert.deepEqual(snapshotTables(b.raw), before.tables, "basis and floors back, byte for byte");
    assert.deepEqual(rows(b.raw, `SELECT DISTINCT state, reverted_at_ms FROM ${REPAIRS_TABLE}`), [{ state: "reverted", reverted_at_ms: (NOW + 60) * 1000 }]);
    const gap = await admissionSays(b, rpc);
    assert.equal(gap.status, "missing");
    assert.equal((await revertClosedEpoch(b.db, { repairId: report.repairId, nowMs: NOW * 1000, dialect: "sqlite" })).outcome, "already-reverted");
  });
});

describe("the boundary: dated from below, or refused", () => {
  it("W3: no epoch-1 valuation after the sweep, but epoch 2 opens with resetPaperLedger's row and runPaperReset's line follows it", async () => {
    const p = await preview(await books({ marks: [DEPOSIT_AT + 62, 1789590700] }), fakeRpc().rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    assert.deepEqual([p.boundary.witness?.kind, p.boundary.witness?.at, p.boundary.witness?.marginSec], ["W3", EPOCH2_AT, EPOCH2_AT - SWEEP_AT]);
  });

  it("W2: the held reset's own event, written inside its transaction", async () => {
    const b = await books({ marks: [DEPOSIT_AT + 62], reset: null });
    b.raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'ok', ?, ?)").run(SPELLED, heldResetEvent(1), EPOCH2_AT - 30);
    const p = await preview(b, fakeRpc().rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    assert.deepEqual([p.boundary.witness?.kind, p.boundary.upperSec], ["W2", EPOCH2_AT - 30], "the event closes epoch 1 earlier than any row, and dates it");
  });

  it("refuses boundary-undated: a paper-opening row alone (getPaperBook writes the same with no bump), or runPaperReset's line too late to pair with it", async () => {
    const alone = await preview(await books({ marks: [DEPOSIT_AT + 62], reset: null }), fakeRpc().rpc);
    assert.equal(alone.verdict, "blocked");
    assert.deepEqual(codes(alone), ["boundary-undated"]);
    assert.equal(alone.boundary.witness, null);
    const late = await preview(await books({ marks: [DEPOSIT_AT + 62], reset: EPOCH2_AT + 61 }), fakeRpc().rpc);
    assert.deepEqual(codes(late), ["boundary-undated"]);
  });

  it("refuses epochs-overlap, epoch-rows-ahead, next-epoch-empty, epoch-not-closed and epoch-unsupported", async () => {
    const overlap = await books();
    overlap.raw.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at) VALUES (?, '0', 1, 0, 0, 1, 1, 'live', ?)`)
      .run(SPELLED, EPOCH2_AT + 5);
    assert.ok(codes(await preview(overlap, fakeRpc().rpc)).includes("epochs-overlap"));
    const ahead = await books();
    ahead.raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, epoch) VALUES (?, 'swap', 'paper', 1, 'paper', ?, 3)`).run(SPELLED, EPOCH2_AT + 5000);
    assert.ok(codes(await preview(ahead, fakeRpc().rpc)).includes("epoch-rows-ahead"));
    const empty = await books({ reset: null });
    empty.raw.exec("DELETE FROM equity WHERE epoch = 2; DELETE FROM trades WHERE epoch = 2");
    const e = await preview(empty, fakeRpc().rpc);
    assert.ok(codes(e).includes("next-epoch-empty"), codes(e).join(","));
    assert.deepEqual(e.proposals.inserts, []);
    const open = await books();
    open.raw.prepare("UPDATE agents SET epoch = 1 WHERE smart_account = ?").run(SPELLED);
    open.raw.exec("UPDATE equity SET epoch = 1; UPDATE trades SET epoch = 1; DELETE FROM events");
    assert.ok(codes(await preview(open, fakeRpc().rpc)).includes("epoch-not-closed"));
    const two = await preview(await books(), fakeRpc().rpc, { epoch: 2 });
    assert.ok(codes(two).includes("epoch-unsupported"));
    assert.equal(two.verdict, "blocked");
  });

  it("refuses boundary-upper (epoch 2's first row 30s after the sweep) and boundary-contradicted (a closing line before the epoch's own last valuation)", async () => {
    const tight = await books({ marks: [DEPOSIT_AT + 62], reset: null });
    tight.raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, epoch) VALUES (?, 'swap', 'paper', 1, 'paper', ?, 2)`).run(SPELLED, SWEEP_AT + 30);
    const p = await preview(tight, fakeRpc().rpc);
    assert.ok(codes(p).includes("boundary-upper"), codes(p).join(","));
    const contradicted = await books();
    contradicted.raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'ok', ?, ?)").run(SPELLED, PAPER_RESET_LINE, SWEEP_AT - 100);
    const q = await preview(contradicted, fakeRpc().rpc);
    assert.deepEqual(codes(q), ["boundary-contradicted"], "and the sweep is then no longer epoch 1's to file");
    assert.equal(q.movements.find((m) => m.key === `log:${SWEEP_TX}#7`)!.epochByTime, "later");
  });

  it("classifies the boundary lines by their writers' own templates, and keeps no text", () => {
    assert.deepEqual(classifyEvent(PAPER_RESET_LINE), { class: "paper-reset", epoch: 1 });
    assert.deepEqual(classifyEvent(heldResetEvent(4)), { class: "held-reset", epoch: 4 });
    assert.deepEqual(classifyEvent("opened epoch 2 — earlier rows are kept for forensics but excluded from performance reporting (…)"), { class: "opened", epoch: 2 });
    assert.deepEqual(classifyEvent("📥 funded 145.50 USDG (Transfer from 0x…) — capital, not performance: the high-water mark moved with it"), { class: "funded", epoch: null });
    assert.equal(classifyEvent("paper book restarted at 1,000.00 USDG with no positions."), null);
  });
});

describe("the epoch's own rows", () => {
  const inferred = (b: Books, o: { epoch?: number; amount?: number; source?: string; tx?: string | null; log?: number | null; direction?: string; chain?: number | null } = {}) =>
    Number(b.raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?) RETURNING id`)
      // Written when its writer ran: in epoch 1 the day of the deposit, in epoch 2 after it opened (the scanner stamps at the write).
      .get(SPELLED, o.direction ?? "in", o.amount ?? 145.499004, o.tx ?? null, o.log ?? null, o.source ?? "inferred", o.epoch ?? 1, o.chain === undefined ? 4663 : o.chain,
        (o.epoch ?? 1) === 1 ? DEPOSIT_AT + 200 : EPOCH2_AT + 2000)!.id);

  it("an inferred stand-in in epoch 1 is quarantined in the same transaction, after the pair is verified, and a revert brings it back under its own id with its chain", async () => {
    const b = await books();
    const id = inferred(b);
    const before = allFlows(b.raw);
    const p = await preview(b, fakeRpc().rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    assert.deepEqual(p.proposals.quarantines.map((q) => [q.id, q.row.source]), [[id, "inferred"]]);
    assert.deepEqual([p.predicted.epochNetBefore, p.predicted.epochNetAfter], ["145499004", "680474"]);
    const report = await apply(b, p);
    assert.deepEqual(rows(b.raw, "SELECT original_id, run_id, source, epoch, replaced_by FROM flows_quarantine"),
      [{ original_id: id, run_id: report.repairId, source: "inferred", epoch: 1, replaced_by: `${DEPOSIT_TX}#0,${SWEEP_TX}#7` }]);
    assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM flows WHERE id = ?", id)[0]!.n, 0);
    assert.ok(report.actions.some((a) => a.action === "quarantine-flow" && a.evidenceKey === `flow:${id}` && (a.row as { chain_id: number }).chain_id === 4663));
    await revertClosedEpoch(b.db, { repairId: report.repairId, nowMs: (NOW + 60) * 1000, dialect: "sqlite" });
    assert.deepEqual(allFlows(b.raw), before, "the stand-in is back under id ${id}, chain_id and all");
    assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM flows_quarantine")[0]!.n, 1, "the quarantine row stays as history: flows_quarantine is append-only");
  });

  it("an inferred stand-in added after the preview makes the apply refuse on its facts, writing nothing", async () => {
    const b = await books();
    const p = await preview(b, fakeRpc().rpc);
    inferred(b);
    const flows = allFlows(b.raw), basis = rows(b.raw, "SELECT * FROM cost_basis");
    await assert.rejects(apply(b, p), (e: unknown) => e instanceof BookingRefused && e.code === "cas");
    assert.deepEqual([allFlows(b.raw), rows(b.raw, "SELECT * FROM cost_basis"), rows(b.raw, `SELECT name FROM sqlite_master WHERE name = '${REPAIRS_TABLE}'`).length], [flows, basis, 1]);
    assert.equal(rows(b.raw, `SELECT COUNT(*) AS n FROM ${REPAIRS_TABLE}`)[0]!.n, 0);
  });

  it("a transfer-intent twin of the sweep in epoch 1 is quarantined; one that twins nothing is unexplained-row", async () => {
    const twin = await books();
    const id = inferred(twin, { source: "transfer-intent", tx: SWEEP_TX, direction: "out", amount: 144.81853 });
    const p = await preview(twin, fakeRpc().rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    assert.deepEqual(p.proposals.quarantines.map((q) => q.id), [id]);
    await apply(twin, p);
    assert.equal((await flowDuplicateReport(twin.db, ACCOUNT, 1)).clean, true);
    const stray = await books();
    inferred(stray, { source: "transfer-intent", tx: h32("an unrelated transfer"), direction: "out", amount: 3 });
    assert.deepEqual(codes(await preview(stray, fakeRpc().rpc)), ["unexplained-row"]);
  });

  it("refuses a fact in the wrong epoch, a receipt without its row, a conflicting row, a NULL-chain twin and a twin in another epoch — and moves nothing", async () => {
    const wrong = await books();
    inferred(wrong, { source: "chain-log", tx: DEPOSIT_TX, log: 0, epoch: 2 });
    const w = await preview(wrong, fakeRpc().rpc);
    assert.ok(codes(w).includes("fact-in-wrong-epoch"), codes(w).join(","));
    assert.ok(!w.proposals.inserts.some((i) => i.key === `log:${DEPOSIT_TX}#0`));
    const orphan = await books();
    orphan.raw.exec(`CREATE TABLE ${BOOKINGS_TABLE} (booking_id TEXT, tenant TEXT, account TEXT, epoch INTEGER, chain_id INTEGER, evidence_key TEXT, table_name TEXT, row_id INTEGER,
      row_json TEXT, row_digest TEXT, preview_digest TEXT, backup_ref TEXT, admission_json TEXT, state TEXT, applied_at_ms INTEGER, reverted_at_ms INTEGER)`);
    orphan.raw.prepare(`INSERT INTO ${BOOKINGS_TABLE} VALUES ('b1', ?, ?, 2, 4663, ?, 'flows', 99, '{}', 'd', 'p', 'r', '{}', 'applied', 1, NULL)`).run(TENANT, ACCOUNT, `log:${DEPOSIT_TX}#0`);
    assert.ok(codes(await preview(orphan, fakeRpc().rpc)).includes("receipt-without-row"));
    const conflict = await books();
    inferred(conflict, { source: "chain-log", tx: DEPOSIT_TX, log: 0, amount: 145 });
    assert.ok(codes(await preview(conflict, fakeRpc().rpc)).includes("identity-conflict"));
    const nullChain = await books();
    inferred(nullChain, { source: "chain-log", tx: DEPOSIT_TX, log: 0, chain: null });
    assert.ok(codes(await preview(nullChain, fakeRpc().rpc)).includes("identity-conflict"));
    const other = await books();
    inferred(other, { source: "transfer-intent", tx: SWEEP_TX, direction: "out", amount: 144.81853, epoch: 2 });
    const o = await preview(other, fakeRpc().rpc);
    assert.ok(codes(o).includes("twin-in-other-epoch"), codes(o).join(","));
  });

  it("refuses outbound-only: the funding came from another hosted account (internal), and only the withdrawal is capital", async () => {
    const b = await books();
    const elsewhere = addr(0xe0a);
    b.raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
      VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 1, 0, 'live')`).run(FUNDER, addr(0xf1), addr(1));
    // The sweep sent elsewhere: an outside address, so it stays capital-out while the deposit from a hosted account is internal.
    const txs = REAL.map((t) => (t.tx !== SWEEP_TX ? t : { ...t, logs: t.logs.map((l) => (l[3] === "0x7" ? [l[0], [l[1][0]!, l[1][1]!, topic(elsewhere)], l[2], l[3]] as FixtureLog : l)) }));
    const p = await preview(b, fakeRpc({ txs }).rpc);
    assert.equal(p.movements.find((m) => m.key === `log:${DEPOSIT_TX}#0`)!.classification!.kind, "internal");
    assert.ok(codes(p).includes("outbound-only"), codes(p).join(","));
  });
});

describe("operations, and what admission would still find", () => {
  it("removing the sweep op's trades row leaves the owner's root-key operation unanswered before epoch 1 closed: refused, never booked", async () => {
    const b = await books();
    b.raw.prepare("DELETE FROM trades WHERE user_op_hash = ?").run(SWEEP_OP);
    const p = await preview(b, fakeRpc().rpc);
    assert.equal(p.verdict, "blocked");
    const r = p.refusals.find((x) => x.code === "operation-unanswered")!;
    assert.match(r.why, new RegExp(`operation ${SWEEP_OP}.*the owner's own key \\(the root validator\\): an owner-operation`));
    assert.ok(p.proposals.inserts.some((i) => i.key === `log:${SWEEP_TX}#7`), "its USDG leg is still a capital movement to file");
  });

  it("a session operation after epoch 1 closed is listed for chain-gap-booking and does not block", async () => {
    const b = await books();
    const block = 64900000n, op = h32("a later session op");
    const nonce = (0x0002d5cb71d8n << 208n) | 99n;
    const later: ModelTx = { tx: h32("later op tx"), block, blockHash: h32("later block"), timestamp: timeOf(block), from: addr(0x4337), to: EP, status: "0x1",
      logs: [[EP, [BEFORE], "0x", "0x1"], [EP, [UOE, op, topic(ACCOUNT), topic(addr(0x7777))], `0x${word(nonce)}${word(1n)}${word(1000n)}${word(900n)}`, "0x2"]] };
    const p = await preview(b, fakeRpc({ txs: [...REAL, later] }).rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    assert.deepEqual(p.admission.afterBoundary.map((d) => [d.fact.kind, d.validator]), [["operation", "permission"]]);
    assert.ok(p.warnings.some((w) => /book them with chain-gap-booking after this repair/.test(w)));
  });

  it("the 0x4b6dcd receipts: every op the owner's root key, the withdrawal capital-out, the vault sweep internal, NVDA on the review list — and epoch 1 is not closed there", async () => {
    const raw = new DatabaseSync(":memory:"); handles.push(raw);
    const db = wrapSqlite(raw);
    await applyLedgerSchema(db); await db.exec(MIRROR_STATE_DDL); await db.exec(PAPER_CHECKPOINT_SCHEMA);
    const tenant = "0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5", account = "0xa96bf429888e1aab4255762d17d29c53f6a0370d";
    const classVault = "0xc8776faff15212c359b23bae531ff3ac7d760e0f", trencher = "0xdcd313740dc7e7f4e0a80991ce131a0dccff12d7";
    raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL, row_version INTEGER NOT NULL)");
    raw.prepare("INSERT INTO grants VALUES (?, ?, 1000, 1)").run(tenant, JSON.stringify({ smartAccount: account, owner: tenant, chainId: 4663,
      grantFeatures: ["tradeable-v2", GRANT_PONS_CLASS, GRANT_TRENCHER], ponsClassVaultAddress: classVault, trencherVaultAddress: trencher, trencherFactoryAddress: addr(0xfac7) }));
    raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
      VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 1, 349.365984, 'idle')`).run(account, tenant, addr(1));
    await ensureLedgerResumeSchema(db);
    const txs = OWNER_FX.txs.map(fromFixture);
    const nowSec = Math.max(...txs.map((t) => t.timestamp)) + 86_400;
    const head = txs.reduce((m, t) => (t.block > m ? t.block : m), 0n) + 100_000n;
    const snap = await readClosedEpochSnapshot(db, { tenant, dialect: "sqlite", nowSec, epoch: 1 });
    const chain = await readClosedEpochChain(fakeRpc({ txs, head }).rpc, snap, { sleep: async () => {} });
    const p = planClosedEpoch(snap, chain, { nowSec, source: SOURCE, target: TARGET });
    assert.equal(p.verdict, "blocked");
    assert.ok(codes(p).includes("epoch-not-closed"), codes(p).join(","));
    assert.deepEqual(p.ops.map((o) => o.validator), ["root", "root", "root"]);
    const recover = OWNER_FX.txs.find((t) => t.name === "recover")!.tx, sweep = OWNER_FX.txs.find((t) => t.name === "vault_sweep")!.tx;
    const out = p.movements.find((m) => m.txHash === recover)!;
    assert.deepEqual([out.direction, out.amountRaw, out.classification!.kind, out.classification!.rule], ["out", "348368488", "capital-out", "no-pair-external"]);
    const inward = p.movements.find((m) => m.txHash === sweep)!;
    assert.deepEqual([inward.direction, inward.classification!.kind, inward.classification!.rule, inward.counterparty], ["in", "internal", "custody-transfer", classVault]);
    const recoverOp = p.ops.find((o) => o.txHash === recover)!;
    assert.deepEqual(recoverOp.inKind.map((k) => [k.token, k.direction, k.amountRaw]), [["0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", "out", "12397031985369"]]);
    assert.deepEqual(p.proposals, { inserts: [], quarantines: [], clears: [] });
  });
});

describe("what the chain read refuses", () => {
  it("an ambiguous movement, an unread receipt, a non-canonical block and a balance the logs do not reach", async () => {
    const block = 64500000n;
    const self: ModelTx = { tx: h32("self transfer"), block, blockHash: h32("self block"), timestamp: timeOf(block), from: ACCOUNT, to: USDG, status: "0x1",
      logs: [[USDG, [TR, topic(ACCOUNT), topic(ACCOUNT)], `0x${word(1n)}`, "0x3"]] };
    const a = await preview(await books(), fakeRpc({ txs: [...REAL, self] }).rpc);
    assert.ok(codes(a).includes("ambiguous-movement"), codes(a).join(","));
    const unread = await preview(await books(), fakeRpc({ failReceipts: [DEPOSIT_TX] }).rpc);
    assert.ok(codes(unread).includes("movement-unread"));
    const orphan = await preview(await books(), fakeRpc({ orphaned: [SWEEP_TX] }).rpc);
    assert.ok(orphan.refusals.some((r) => r.code === "movement-unread" && /is not the canonical block/.test(r.why)));
    const off = await preview(await books(), fakeRpc({ balances: { [USDG]: { [ACCOUNT]: 1n } } }).rpc);
    assert.ok(codes(off).includes("coverage-mismatch"));
  });

  it("a pruned balance read is unread, named, and blocks; a fact after admission's refusal is never filed", async () => {
    const pruned = await preview(await books(), fakeRpc({ failBalances: [USDG], pruned: true }).rpc);
    assert.ok(pruned.refusals.some((r) => r.code === "balance-unread" && /no longer has that block's state/.test(r.why)));
    assert.deepEqual(pruned.unread[`${USDG}:${ACCOUNT}`], "pruned");
    const b = await books();
    b.raw.prepare("UPDATE ledger_resume_approvals SET updated_at_ms = ?, created_at_ms = ?").run((SWEEP_AT + 30) * 1000, (SWEEP_AT + 20) * 1000);
    b.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run(SWEEP_AT - 600, SPELLED);
    b.raw.prepare("UPDATE mirror_state SET updated_at = ?").run(SWEEP_AT - 600);
    const p = await preview(b, fakeRpc().rpc);
    assert.ok(codes(p).includes("after-refusal"), codes(p).join(","));
  });

  it("a node that refuses every span leaves the read incomplete, and a node that refuses wide spans is read in halves", async () => {
    const none = await preview(await books(), fakeRpc({ refuseEveryRange: true }).rpc);
    assert.ok(codes(none).includes("coverage-incomplete"));
    assert.equal(none.verdict, "blocked");
    const narrow = fakeRpc({ spanLimit: 6_000_000n });
    const p = await preview(await books(), narrow.rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    assert.ok(narrow.calls.filter((c) => c.method === "eth_getLogs").length < 200, "bounded: halved once, then 5M spans");
  });

  it("refuses a tenant that is not held: no chain refusal, or a heartbeat after it", async () => {
    const b = await books();
    b.raw.exec("DELETE FROM ledger_resume_approvals");
    assert.ok(codes(await preview(b, fakeRpc().rpc)).includes("not-held"));
    const c = await books();
    c.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run(Math.floor(REFUSED_AT_MS / 1000) + 10, SPELLED);
    assert.ok((await preview(c, fakeRpc().rpc)).refusals.some((r) => r.code === "not-held" && /beat at/.test(r.why)));
  });
});

describe("the stale live basis admission would seed", () => {
  it("a token still held is kept, with a note; the flat one is still cleared", async () => {
    const p = await preview(await books(), fakeRpc({ balances: { [MU]: { [ACCOUNT]: 7n } } }).rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    assert.deepEqual(p.holdings.verdicts.map((v) => [v.symbol, v.verdict]), [["MU", "keep"], ["USAR", "clear"]]);
    assert.deepEqual(p.proposals.clears.map((c) => [c.kind, c.symbol]), [["clear-live-basis", "USAR"], ["clear-live-floor", "USAR"]]);
    assert.ok(p.warnings.some((w) => /MU: the live basis covers 5365685809818 base units and the book held 7/.test(w)));
    assert.deepEqual(p.holdings.seedAfter.basis.map((x) => x.symbol), ["MU"]);
  });

  it("refuses an unread balance, a class vault holding the token, and a live-rail position the chain contradicts", async () => {
    const unread = await preview(await books(), fakeRpc({ failBalances: [MU] }).rpc);
    assert.ok(unread.refusals.some((r) => r.code === "balance-unread" && /MU/.test(r.why)));
    const vault = await preview(await books(), fakeRpc({ balances: { [USAR]: { [CLASS_VAULT]: 3n } } }).rpc);
    assert.ok(codes(vault).includes("class-vault-held"));
    const live = await preview(await books({ mode: "live" }), fakeRpc().rpc);
    assert.ok(codes(live).includes("live-position-disagrees"));
  });

  it("a live basis outside what admission would seed is inert: named, untouched", async () => {
    const b = await books();
    b.raw.prepare("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES (?, 'live', 'TSLA', '9', '9', 1789500000)").run(SPELLED);
    const p = await preview(b, fakeRpc().rpc);
    assert.deepEqual(p.holdings.inertBasis.map((x) => x.symbol), ["TSLA"]);
    assert.ok(!p.proposals.clears.some((c) => c.symbol === "TSLA"));
    await apply(b, p);
    assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM cost_basis WHERE symbol = 'TSLA'")[0]!.n, 1);
  });

  it("staleBasisPlan: two held positions rows for one symbol is not one token", () => {
    const r = staleBasisPlan({
      seedBefore: { basis: [{ mode: "live", symbol: "MU", qtyRaw: "1", costUsdg: "1" }], floors: [] },
      positions: [{ symbol: "MU", token: MU, rawBalance: "1", updatedAt: 1 }, { symbol: "MU", token: USAR, rawBalance: "1", updatedAt: 1 }],
      liveBasis: [], liveFloors: [], rawGrantAccount: SPELLED, balances: {}, classVault: null, mode: "paper",
    });
    assert.deepEqual(r.refusals.map((x) => x.code), ["positions-ambiguous"]);
  });
});

describe("admission's drain of the tenant's home: a clear only where it holds (retainedHomeVerdict)", () => {
  /**
   * The old book in the tenant's home, CONTINUOUS with Postgres: the rows
   * the shared cursors point at (last_id 9, stamped EPOCH2_AT) are still at
   * their ids, and it still holds the live MU and USAR basis and floors the
   * mirror copied up (resetPaperLedger deletes only the paper basis).
   */
  async function oldBook(): Promise<Books> {
    const raw = new DatabaseSync(":memory:"); handles.push(raw);
    const db = wrapSqlite(raw);
    await applyLedgerSchema(db);
    raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, hwm_withdrawn_usdg, mode)
      VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 2, 145.579752, 0, 'paper')`).run(SPELLED, TENANT, addr(1));
    raw.prepare("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES (?, 'live', 'MU', '5365685809818', '5026', 1789590627)").run(SPELLED);
    raw.prepare("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES (?, 'live', 'USAR', '105986355046803', '1654', 1789590653)").run(SPELLED);
    raw.prepare("INSERT INTO position_floors (agent_id, mode, symbol, stop_bps, rung, why, at) VALUES (?, 'live', 'MU', 1500, 'standard', 'graded at entry', 1789556100)").run(SPELLED);
    raw.prepare("INSERT INTO position_floors (agent_id, mode, symbol, stop_bps, rung, why, at) VALUES (?, 'live', 'USAR', 1800, 'wide', 'graded at entry', 1789556120)").run(SPELLED);
    raw.prepare(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg, updated_at) VALUES (?, 'MU', ?, '5365685809818', '1', 1, 0, 1, 1789592749)`)
      .run(SPELLED, MU);
    raw.prepare(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg, updated_at) VALUES (?, 'USAR', ?, '105986355046803', '1', 1, 0, 1, 1789592749)`)
      .run(SPELLED, USAR);
    raw.prepare("INSERT INTO trades (id, agent_id, kind, target, amount_usdg, status, created_at, epoch) VALUES (9, ?, 'swap', 'paper', 5, 'paper', ?, 2)").run(SPELLED, EPOCH2_AT);
    raw.prepare(`INSERT INTO equity (id, agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, flows_held, cash_read_at, at)
      VALUES (9, ?, '0', 1000, 0, 0, 1000, 2, 'paper', 0, ?, ?)`).run(SPELLED, EPOCH2_AT, EPOCH2_AT);
    raw.prepare("INSERT INTO events (id, agent_id, level, message, created_at) VALUES (9, ?, 'ok', 'paper mark', ?)").run(SPELLED, EPOCH2_AT);
    raw.prepare("INSERT INTO flows (id, agent_id, direction, amount_usdg, tx_hash, source, epoch, at) VALUES (9, ?, 'in', 0.000001, NULL, 'inferred', 2, ?)").run(SPELLED, EPOCH2_AT);
    return { raw, db };
  }

  it("home-book-present: the drain, reproduced, puts a cleared basis and floors back and moves admission's evidence — so the repair refuses and writes nothing", async () => {
    // THE HAZARD. The live basis and floors cleared as the apply clears them, then what drainContinuousBook does first in Phase A for
    // a home whose book is present and continuous: the continuity proof, then the guarded mirror (mirrorTenant).
    const hazard = await books({ home: "present" });
    const old = await oldBook();
    hazard.raw.exec("DELETE FROM cost_basis WHERE mode = 'live'");
    hazard.raw.exec("DELETE FROM position_floors WHERE mode = 'live'");
    assert.deepEqual(await planAttestedSeed(hazard.db, SPELLED), { basis: [], floors: [] }, "cleared: admission would seed nothing");
    const cleared = await readPgEvidence(hazard.db, { tenant: TENANT, account: ACCOUNT, nowSec: NOW });
    await assertLedgerSourceContinuity(old.db, hazard.db, TENANT);
    const drained = await mirrorTenant({ tenant: TENANT, child: old.db, shared: hazard.db, nowSec: NOW + 60 });
    assert.deepEqual([drained.restarted ?? {}, drained.failed ?? {}, drained.copied.cost_basis, drained.copied.position_floors], [{}, {}, 2, 2],
      "a continuous book, not a rebuilt one: the mirror replaces the snapshot rows with its own");
    const seeded = await planAttestedSeed(hazard.db, SPELLED);
    assert.deepEqual([seeded.basis.map((x) => x.symbol), seeded.floors.map((x) => x.symbol)], [["MU", "USAR"], ["MU", "USAR"]], "the stale basis and floors are back, and seeded");
    assert.notEqual(canonical(await readPgEvidence(hazard.db, { tenant: TENANT, account: ACCOUNT, nowSec: NOW })), canonical(cleared),
      "admission's evidence moved: an approval of the cleared books is refused as changed, and the tenant's newest decision is no longer a chain refusal");

    // THE GUARD: the same books, the anchor's evidence saying the old book is in the home.
    const b = await books({ home: "present" });
    const before = { flows: allFlows(b.raw), tables: snapshotTables(b.raw) };
    const p = await preview(b, fakeRpc().rpc);
    assert.equal(p.verdict, "blocked");
    assert.deepEqual(codes(p), ["home-book-present"], closedEpochLines(p).join("\n"));
    assert.match(p.refusals[0]!.why, /approval 8d1c4c6b…\) found the old book in the tenant's home .* drainContinuousBook/);
    assert.deepEqual([p.holdings.home.durable, p.holdings.home.atAnchor?.book, p.holdings.home.atAnchor?.archived], [false, "present", false]);
    assert.equal(p.proposals.clears.length, 4, "what would be cleared is still shown for review");
    await assert.rejects(apply(b, p), (e: unknown) => e instanceof BookingRefused && e.code === "not-ready");
    assert.deepEqual({ flows: allFlows(b.raw), tables: snapshotTables(b.raw) }, before, "nothing written");
  });

  it("the clear holds where admission archived the home before its chain refusal, found no book there, or found it behind a source barrier", async () => {
    for (const home of ["archived", "absent", "blocked"] as const) {
      const p = await preview(await books({ home }), fakeRpc().rpc);
      assert.equal(p.verdict, "ready", `${home}: ${closedEpochLines(p).join("\n")}`);
      assert.equal(p.proposals.clears.length, 4, home);
      assert.deepEqual([p.holdings.home.durable, p.holdings.home.atAnchor?.archived, p.holdings.home.atAnchor?.book],
        [true, home === "archived", home === "archived" ? "present" : home], home);
      assert.ok(closedEpochLines(p).some((l) => l.startsWith("  the clear holds: ")), home);
    }
  });

  it("home-unproved: an evidence that does not hash to its digest, or binds no home; and read directly, one for another tenant, a malformed home, no decision", async () => {
    for (const home of ["unverified", "no-home"] as const) {
      const p = await preview(await books({ home }), fakeRpc().rpc);
      assert.deepEqual(codes(p), ["home-unproved"], `${home}: ${closedEpochLines(p).join("\n")}`);
    }
    const at = { tenant: TENANT, account: ACCOUNT };
    const good = anchorEvidence("absent");
    assert.deepEqual(homeOfEvidence(good.json, good.digest, at), { book: "absent", unproved: null });
    assert.deepEqual(homeOfEvidence(good.json, good.digest, { tenant: TENANT, account: null }).book, null, "no grant: no account to match");
    const other = anchorEvidence("absent", { tenant: FUNDER });
    assert.deepEqual(homeOfEvidence(other.json, other.digest, at), { book: null, unproved: "the approval's evidence names another tenant or account" });
    assert.match(String(homeOfEvidence(good.json, "0".repeat(64), at).unproved), /does not hash to its own digest/);
    assert.match(String(homeOfEvidence(null, null, at).unproved), /no evidence on record/);
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    for (const [home, why] of [
      [{ exists: true, markers: [] }, /not as admission's homeIdentity writes one/],
      [{ exists: true, db: { ino: "1" }, markers: [] }, /not as admission's homeIdentity writes one/],
      [{ exists: true, db: null }, /not as admission's homeIdentity writes one/],
      [{ exists: "yes" }, /binds no home/],
    ] as const) {
      const text = canonical({ tenant: TENANT, account: ACCOUNT, home });
      assert.match(String(homeOfEvidence(text, sha(text), at).unproved), why, JSON.stringify(home));
    }
    assert.match(String(homeOfEvidence("not json", sha("not json"), at).unproved), /not JSON/);
    assert.deepEqual(homeOfEvidence(canonical({ tenant: TENANT, account: ACCOUNT, home: { exists: false } }), sha(canonical({ tenant: TENANT, account: ACCOUNT, home: { exists: false } })), at),
      { book: "absent", unproved: null }, "no home at all: nothing to drain");
    assert.deepEqual([retainedHomeVerdict(null).durable, retainedHomeVerdict(null).code], [false, "home-unproved"]);
  });

  it("with nothing to clear, a present home refuses nothing: the drain copies back what the books already hold", async () => {
    const p = await preview(await books({ home: "present" }), fakeRpc({ balances: { [MU]: { [ACCOUNT]: 7n }, [USAR]: { [ACCOUNT]: 9n } } }).rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    assert.deepEqual([p.proposals.clears, p.holdings.home.durable, p.proposals.inserts.length], [[], false, 2]);
  });

  it("an anchor whose evidence is rewritten between the preview and the apply refuses the apply, writing nothing", async () => {
    const b = await books();
    const p = await preview(b, fakeRpc().rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    const present = anchorEvidence("present");
    b.raw.prepare("UPDATE ledger_resume_approvals SET evidence_json = ?, evidence_digest = ? WHERE approval_id = '8d1c4c6b'").run(present.json, present.digest);
    const before = { flows: allFlows(b.raw), tables: snapshotTables(b.raw) };
    await assert.rejects(apply(b, p), (e: unknown) => e instanceof BookingRefused && e.code === "cas" && /\(homeAtAnchor\)/.test(e.message));
    assert.deepEqual({ flows: allFlows(b.raw), tables: snapshotTables(b.raw) }, before);
  });

  it("the anchor is the newest approval NOT revoked: a revoked one after the chain refusal, binding no book, does not vouch for the home the refusal found", async () => {
    // The chain refusal's evidence found the old book (present, unblocked); an approval approved after it, on evidence binding no book, then
    // revoked: it decided nothing (holdOf skips it too), so what it bound is not what admission's drain met.
    const b = await books({ home: "present" });
    const absent = anchorEvidence("absent");
    b.raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, reason,
        created_at_ms, updated_at_ms) VALUES ('f00dfeed', ?, ?, 4663, ?, ?, ?, 'r2', 'revoked', 'revoked by the operator', ?, ?)`)
      .run(TENANT, ACCOUNT, TENANT, absent.digest, absent.json, REFUSED_AT_MS + 60_000, REFUSED_AT_MS + 120_000);
    const snap = await readClosedEpochSnapshot(b.db, { tenant: TENANT, dialect: "sqlite", nowSec: NOW, epoch: 1 });
    assert.deepEqual(snap.booking.admission.approvals.map((a) => [a.approvalId, a.state]), [["f00dfeed", "revoked"], ["8d1c4c6b", "refused"]],
      "the revoked approval is the tenant's newest row");
    const p = await preview(b, fakeRpc().rpc);
    assert.equal(p.verdict, "blocked");
    assert.deepEqual(codes(p), ["home-book-present"], closedEpochLines(p).join("\n"));
    assert.match(p.refusals[0]!.why, /approval 8d1c4c6b…\) found the old book in the tenant's home/);
    assert.deepEqual([p.holdings.home.atAnchor?.approvalId, p.holdings.home.atAnchor?.state, p.holdings.home.atAnchor?.chainRefusal, p.holdings.home.atAnchor?.book,
      p.holdings.home.durable], ["8d1c4c6b", "refused", true, "present", false]);
  });

  it("the anchor's evidence is read by its id AND the tenant: another tenant's row under the same id is never read, whatever its text names", async () => {
    // approval_id is the table's primary key, so on the schema as created one id is one row; the tenant in the read is what keeps it so on
    // a table that lost its key (a restore without constraints). Here the key is dropped and another tenant's row under the anchor's id is
    // put FIRST, where a read by the id alone meets it: its own evidence, or one naming this tenant and account, binding no book.
    for (const text of ["its own", "this tenant's"] as const) {
      const b = await books({ home: "present" });
      b.raw.exec("ALTER TABLE ledger_resume_approvals RENAME TO approvals_keyed");
      b.raw.exec("CREATE TABLE ledger_resume_approvals AS SELECT * FROM approvals_keyed WHERE 0");
      const other = anchorEvidence("absent", text === "its own" ? { tenant: FUNDER } : {});
      b.raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, reason,
          created_at_ms, updated_at_ms) VALUES ('8d1c4c6b', ?, ?, 4663, ?, ?, ?, 'r', 'refused', ?, ?, ?)`)
        .run(FUNDER, ACCOUNT, FUNDER, other.digest, other.json, `${CHAIN_REFUSAL}: another tenant`, REFUSED_CREATED_MS, REFUSED_AT_MS);
      b.raw.exec("INSERT INTO ledger_resume_approvals SELECT * FROM approvals_keyed");
      b.raw.exec("DROP TABLE approvals_keyed");
      assert.deepEqual(rows(b.raw, "SELECT tenant FROM ledger_resume_approvals WHERE approval_id = '8d1c4c6b'").map((r) => r.tenant), [FUNDER, TENANT],
        `${text}: two rows under the anchor's id, the other tenant's first`);
      const p = await preview(b, fakeRpc().rpc);
      assert.equal(p.verdict, "blocked", text);
      assert.deepEqual(codes(p), ["home-book-present"], `${text}: ${closedEpochLines(p).join("\n")}`);
      assert.deepEqual([p.holdings.home.atAnchor?.approvalId, p.holdings.home.atAnchor?.book, p.holdings.home.atAnchor?.unproved, p.holdings.home.durable],
        ["8d1c4c6b", "present", null, false], text);
    }
  });
});

describe("every hosted account, compared again at the apply", () => {
  it("the deposit's sender registered as a hosted account after the preview (during its chain read) refuses the apply, writing nothing; read again, the deposit is internal", async () => {
    const b = await books();
    const { rpc } = fakeRpc();
    const p = await preview(b, rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    b.raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
      VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 1, 0, 'paper')`).run(FUNDER, addr(0xf1), addr(1));
    const before = { flows: allFlows(b.raw), tables: snapshotTables(b.raw) };
    // Nothing of this tenant's rows moved: only the fleet's accounts, by digest, inside the booking tool's compare-and-set.
    await assert.rejects(apply(b, p), (e: unknown) => e instanceof BookingRefused && e.code === "cas" && /\(booking\)/.test(e.message));
    assert.deepEqual({ flows: allFlows(b.raw), tables: snapshotTables(b.raw) }, before);
    assert.equal(rows(b.raw, `SELECT COUNT(*) AS n FROM ${REPAIRS_TABLE}`)[0]!.n, 0);
    const again = await preview(b, rpc);
    const deposit = again.movements.find((m) => m.key === `log:${DEPOSIT_TX}#0`)!;
    assert.deepEqual([deposit.counterpartyKnownAccount, deposit.classification!.kind], [true, "internal"]);
    assert.ok(!again.proposals.inserts.some((i) => i.key === `log:${DEPOSIT_TX}#0`), "never filed as an owner's deposit");
    assert.equal(p.cas.booking.knownAccounts.length, 64, "a digest: the plan never lists the fleet's other accounts");
  });
});

describe("admission's duplicate check, asked at the preview", () => {
  it("a current run holding two copies of one movement refuses at the preview, where the apply's postcondition used to be the first to say", async () => {
    const b = await books();
    for (let i = 0; i < 2; i++) {
      b.raw.prepare("INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, source, epoch, at) VALUES (?, 'in', 3, NULL, 'inferred', 2, ?)").run(SPELLED, EPOCH2_AT + 600);
    }
    const p = await preview(b, fakeRpc().rpc);
    assert.deepEqual(codes(p), ["flows-duplicate"], closedEpochLines(p).join("\n"));
    assert.match(p.refusals[0]!.why, /the current run \(epoch 2\) holds 1 copy\(ies\) and 0 conflict\(s\)/);
    assert.deepEqual(p.duplicates.currentRun, { epoch: 2, clean: false, verdict: "ok", copies: 1, conflicts: 0 });
    assert.equal(p.duplicates.epochAfter.clean, true);
  });

  it("epoch 1 as the repair would leave it is asked too: two copies of one log, one with no chain stamp, refuse as a duplicate beside the conflict", async () => {
    const b = await books();
    for (const chain of [4663, null]) {
      b.raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
        VALUES (?, 'in', 145.499004, ?, 64045884, 0, 'chain-log', 1, ?, ?)`).run(SPELLED, DEPOSIT_TX, chain, DEPOSIT_AT);
    }
    const p = await preview(b, fakeRpc().rpc);
    assert.ok(codes(p).includes("identity-conflict"));
    assert.ok(p.refusals.some((r) => r.code === "flows-duplicate" && /after the repair epoch 1's flows would hold 1 copy\(ies\)/.test(r.why)), closedEpochLines(p).join("\n"));
    assert.deepEqual(p.duplicates.epochAfter, { epoch: 1, clean: false, verdict: "ok", copies: 1, conflicts: 0 });
  });

  it("a row that does not read as a flow is unread, never clean: in the current run, or left in epoch 1", async () => {
    const current = await books();
    current.raw.prepare("INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, source, epoch, at) VALUES (?, 'sideways', 3, NULL, 'inferred', 2, ?)").run(SPELLED, EPOCH2_AT + 600);
    const p = await preview(current, fakeRpc().rpc);
    assert.deepEqual([codes(p), p.duplicates.currentRun], [["flows-duplicate"], { epoch: null, clean: false, verdict: "unread", copies: 0, conflicts: 0 }]);
    const left = await books();
    left.raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
      VALUES (?, 'sideways', 1, ?, 64045884, 9, 'chain-log', 1, 4663, ?)`).run(SPELLED, DEPOSIT_TX, DEPOSIT_AT);
    const q = await preview(left, fakeRpc().rpc);
    assert.ok(q.refusals.some((r) => r.code === "flows-duplicate" && /verdict unread/.test(r.why)), closedEpochLines(q).join("\n"));
    assert.deepEqual(q.duplicates.epochAfter, { epoch: 1, clean: false, verdict: "unread", copies: 0, conflicts: 0 });
  });

  it("a stand-in the repair quarantines is no duplicate after it: two identical inferred rows in epoch 1 go, and the preview is ready", async () => {
    const b = await books();
    for (let i = 0; i < 2; i++) {
      b.raw.prepare("INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, source, epoch, at) VALUES (?, 'in', 145.499004, NULL, 'inferred', 1, ?)").run(SPELLED, DEPOSIT_AT + 5);
    }
    assert.equal((await flowDuplicateReport(b.db, ACCOUNT, 1)).clean, false, "before the repair, epoch 1 holds a copy");
    const p = await preview(b, fakeRpc().rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    assert.equal(p.proposals.quarantines.length, 2);
    assert.deepEqual(p.duplicates.epochAfter, { epoch: 1, clean: true, verdict: "ok", copies: 0, conflicts: 0 });
    await apply(b, p);
    assert.equal((await flowDuplicateReport(b.db, ACCOUNT, 1)).clean, true);
  });
});

describe("revert, decided by what the database recorded", () => {
  async function applied() {
    const b = await books();
    const p = await preview(b, fakeRpc().rpc);
    const report = await apply(b, p);
    return { b, p, report };
  }
  const revert = (b: Books, report: RepairApplyReport, withReport = true) =>
    revertClosedEpoch(b.db, { repairId: report.repairId, ...(withReport ? { report: parseRepairReport(JSON.stringify(report)) } : {}), nowMs: (NOW + 900) * 1000, dialect: "sqlite" });
  const refusedWith = (code: string, re?: RegExp) => (e: unknown) => e instanceof BookingRefused && e.code === code && (!re || re.test(e.message));

  it("refuses an approval made since, a heartbeat or a mirrored row since, and an attestation since", async () => {
    const a = await applied();
    a.b.raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, created_at_ms, updated_at_ms)
      VALUES ('new', ?, ?, 4663, ?, ?, '{}', 'r', 'approved', ?, ?)`).run(TENANT, ACCOUNT, TENANT, "f".repeat(64), (NOW + 10) * 1000, (NOW + 10) * 1000);
    await assert.rejects(revert(a.b, a.report), refusedWith("open-approval"));
    const h = await applied();
    h.b.raw.prepare("UPDATE agents SET beat_at = ? WHERE smart_account = ?").run(NOW + 5, SPELLED);
    await assert.rejects(revert(h.b, h.report), refusedWith("moved"));
    const m = await applied();
    m.b.raw.prepare("UPDATE mirror_state SET updated_at = ? WHERE table_name = 'events'").run(NOW + 5);
    await assert.rejects(revert(m.b, m.report), refusedWith("moved"));
    const t = await applied();
    t.b.raw.prepare(`INSERT INTO ledger_resume_attestations (generation, approval_id, tenant, smart_account, chain_id, owner, evidence_digest, receipt_digest, mirror_state_digest,
      snapshot_digest, created_at_ms) VALUES ('gen', 'x', ?, ?, 4663, ?, 'e', 'r', 'm', 's', 1)`).run(TENANT, ACCOUNT, TENANT);
    await assert.rejects(revert(t.b, t.report), refusedWith("admitted"));
  });

  it("refuses when anything it wrote or removed moved since — an edited flow, a basis back at its key, a new flow in epoch 2 — before writing", async () => {
    const e = await applied();
    e.b.raw.prepare("UPDATE flows SET amount_usdg = 145.5 WHERE tx_hash = ?").run(DEPOSIT_TX);
    await assert.rejects(revert(e.b, e.report), refusedWith("moved", /flowsAll/));
    const k = await applied();
    k.b.raw.prepare("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES (?, 'live', 'MU', '1', '1', 1)").run(SPELLED);
    await assert.rejects(revert(k.b, k.report), refusedWith("moved", /liveBasis/));
    const n = await applied();
    const flows = allFlows(n.b.raw);
    n.b.raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at) VALUES (?, 'in', 1, ?, 1, 1, 'chain-log', 2, 4663, ?)`)
      .run(SPELLED, h32("a later deposit"), NOW);
    await assert.rejects(revert(n.b, n.report), refusedWith("moved"));
    assert.equal(allFlows(n.b.raw).length, flows.length + 1, "nothing changed");
  });

  it("a report that does not verify reverts nothing; the receipts alone (a lost report) revert exactly", async () => {
    const { b, report } = await applied();
    const tampered = { ...report, backupRef: "something-else" };
    assert.throws(() => parseRepairReport(JSON.stringify(tampered)), refusedWith("report"));
    const other = { ...report, appliedAtMs: report.appliedAtMs + 1 };
    const { reportDigest: _d, ...body } = other;
    void _d;
    const resigned = { ...other, reportDigest: createHash("sha256").update(JSON.stringify(JSON.parse(JSON.stringify(body)))).digest("hex") };
    await assert.rejects(revertClosedEpoch(b.db, { repairId: report.repairId, report: resigned as RepairApplyReport, nowMs: NOW * 1000, dialect: "sqlite" }),
      refusedWith("receipts"));
    const receipts = await readRepairReceipts(b.db, "sqlite", report.repairId);
    assert.deepEqual(receipts.map((r) => r.state), report.actions.map(() => "applied"));
    assert.equal((await revert(b, report, false)).outcome, "reverted");
    assert.deepEqual(rows(b.raw, "SELECT COUNT(*) AS n FROM flows")[0]!.n, 0);
    await assert.rejects(revertClosedEpoch(b.db, { repairId: "00000000-0000-4000-8000-000000000000", nowMs: NOW * 1000, dialect: "sqlite" }), refusedWith("receipts", /no receipts/));
  });
});

describe("every other refusal, by name", () => {
  const flow = (b: Books, o: { source: string; epoch?: number; tx?: string | null; log?: number | null; direction?: string; amount?: number }) =>
    b.raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 4663, ?)`)
      .run(SPELLED, o.direction ?? "in", o.amount ?? 1, o.tx ?? null, o.log ?? null, o.source, o.epoch ?? 1, DEPOSIT_AT + 300);

  it("custody-capital: the class vault moved USDG with an address outside the book", async () => {
    const block = 64100000n;
    const outside: ModelTx = { tx: h32("into the vault"), block, blockHash: h32("vault block"), timestamp: timeOf(block), from: FUNDER, to: USDG, status: "0x1",
      logs: [[USDG, [TR, topic(FUNDER), topic(CLASS_VAULT)], `0x${word(5n)}`, "0x0"]] };
    const p = await preview(await books(), fakeRpc({ txs: [...REAL, outside], balances: { [USDG]: { [CLASS_VAULT]: 5n } } }).rpc);
    assert.deepEqual(codes(p), ["custody-capital"]);
    assert.deepEqual(p.custody.map((c) => [c.address, c.movements, c.outside]), [[CLASS_VAULT, 1, [`${outside.tx}#0`]]]);
    const unbalanced = await preview(await books(), fakeRpc({ balances: { [USDG]: { [CLASS_VAULT]: 5n } } }).rpc);
    assert.deepEqual(codes(unbalanced), ["custody-coverage"]);
  });

  it("identity-quarantined-before: a log a repair once quarantined is a reviewed decision, not a re-filing", async () => {
    const b = await books();
    b.raw.prepare(`INSERT INTO flows_quarantine (original_id, agent_id, epoch, direction, amount_usdg, tx_hash, block_number, log_index, source, at, run_id, quarantined_at, reason)
      VALUES (77, ?, 1, 'in', 145.499004, ?, 64045884, 0, 'chain-log', 1, 'old-run', 1, 'test')`).run(SPELLED, DEPOSIT_TX);
    assert.ok(codes(await preview(b, fakeRpc().rpc)).includes("identity-quarantined-before"));
  });

  it("out-of-scope-reserve: an energy purchase with no worker-written energy-buy row is not filed into a closed epoch", async () => {
    const reserve = MERRYMEN_TOKEN.address.toLowerCase(), seller = addr(0x9001);
    const top: ModelTx = { tx: h32("a second deposit"), block: 64100000n, blockHash: h32("b1"), timestamp: timeOf(64100000n), from: FUNDER, to: USDG, status: "0x1",
      logs: [[USDG, [TR, topic(FUNDER), topic(ACCOUNT)], `0x${word(1_000_000n)}`, "0x0"]] };
    const energy: ModelTx = { tx: h32("an energy buy"), block: 64100100n, blockHash: h32("b2"), timestamp: timeOf(64100100n), from: addr(0x4337), to: EP, status: "0x1",
      logs: [[USDG, [TR, topic(ACCOUNT), topic(seller)], `0x${word(1_000_000n)}`, "0x0"], [reserve, [TR, topic(seller), topic(ACCOUNT)], `0x${word(77n)}`, "0x1"]] };
    const p = await preview(await books(), fakeRpc({ txs: [...REAL, top, energy] }).rpc);
    assert.equal(p.movements.find((m) => m.txHash === energy.tx)!.classification!.kind, "reserve-out");
    assert.ok(codes(p).includes("out-of-scope-reserve"), codes(p).join(","));
  });

  it("unexplained-receipt and carry-in-epoch-1: epoch 1 rows the chain's capital set does not hold", async () => {
    const trade = OPS.find((o) => !o.root)!;
    const r = await books();
    flow(r, { source: "chain-log", tx: trade.tx, log: 999 });
    assert.ok(codes(await preview(r, fakeRpc().rpc)).includes("unexplained-receipt"));
    const c = await books();
    flow(c, { source: "epoch-carry" });
    assert.ok(codes(await preview(c, fakeRpc().rpc)).includes("carry-in-epoch-1"));
  });

  it("operation-unanswered and transfer-unanswered: a session trade with no trades row is the booking tool's, and blocks here", async () => {
    const b = await books();
    const trade = REAL.find((t) => t.tx.startsWith("0xaf532ad9"))!;
    b.raw.prepare("DELETE FROM trades WHERE tx_hash = ?").run(trade.tx);
    const p = await preview(b, fakeRpc().rpc);
    assert.ok(codes(p).includes("operation-unanswered") && codes(p).includes("transfer-unanswered"), codes(p).join(","));
    assert.match(p.refusals.find((r) => r.code === "operation-unanswered")!.why, /a permission validator/);
  });

  it("fact-undated: a fact admission names whose receipt cannot be read", async () => {
    const p = await preview(await books(), fakeRpc({ failReceipts: [DEPOSIT_TX] }).rpc);
    assert.ok(codes(p).includes("movement-unread") && codes(p).includes("fact-undated"), codes(p).join(","));
  });

  it("identity-index, open-approval and an RPC on another chain refuse outright", async () => {
    const i = await books();
    i.raw.exec("DROP INDEX flows_chain_identity");
    assert.ok(codes(await preview(i, fakeRpc().rpc)).includes("identity-index"));
    const a = await books();
    a.raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, created_at_ms, updated_at_ms)
      VALUES ('open', ?, ?, 4663, ?, ?, '{}', 'r', 'approved', ?, ?)`).run(TENANT, ACCOUNT, TENANT, "f".repeat(64), REFUSED_AT_MS - 10, REFUSED_AT_MS - 10);
    const q = await preview(a, fakeRpc().rpc);
    assert.ok(q.refusals.some((r) => r.code === "open-approval" && r.why.includes(`MERRYMEN_RESUME_REVOKE=${TENANT}:${"f".repeat(64)}`)));
    assert.ok(codes(await preview(await books(), fakeRpc({ chainId: 46630 }).rpc)).includes("rpc-chain"));
  });

  it("the grant's own spelling decides what admission seeds: rows spelled lowercase, the grant EIP-55 — floors are not seeded, and are cleared all the same", async () => {
    const b = await books({ rows: ACCOUNT });
    const p = await preview(b, fakeRpc().rpc);
    assert.equal(p.verdict, "ready", closedEpochLines(p).join("\n"));
    assert.deepEqual([p.holdings.seedBefore.basis.map((x) => x.symbol), p.holdings.seedBefore.floors], [["MU", "USAR"], []], "planAttestedSeed reads floors by the grant's exact spelling");
    assert.deepEqual(p.proposals.inserts.map((i) => i.row.agent_id), [ACCOUNT, ACCOUNT], "filed under the rows' one spelling");
    assert.deepEqual(p.proposals.clears.map((c) => c.kind), ["clear-live-basis", "clear-live-floor", "clear-live-basis", "clear-live-floor"]);
    await apply(b, p);
    assert.deepEqual(await planAttestedSeed(b.db, SPELLED), { basis: [], floors: [] });
    assert.equal(rows(b.raw, "SELECT COUNT(*) AS n FROM position_floors")[0]!.n, 0);
  });
});

describe("the tenant and the chain, refused outright", () => {
  it("no grant, no registration, two registrations, two spellings, the grant and registration on different chains", async () => {
    const g = await books();
    g.raw.exec("DELETE FROM grants");
    assert.ok(codes(await preview(g, fakeRpc().rpc)).includes("no-grant"));
    const r = await books();
    r.raw.prepare("DELETE FROM agents WHERE smart_account = ?").run(SPELLED);
    assert.ok(codes(await preview(r, fakeRpc().rpc)).includes("no-registration"));
    const two = await books();
    two.raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
      VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 2, 0, 'paper')`).run(ACCOUNT, TENANT, addr(1));
    assert.ok(codes(await preview(two, fakeRpc().rpc)).includes("registrations"));
    const s = await books();
    s.raw.prepare("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES (?, 'paper', 'X', '1', '1', 1)").run(ACCOUNT);
    assert.ok(codes(await preview(s, fakeRpc().rpc)).includes("spellings"));
    const c = await books();
    c.raw.prepare("UPDATE agents SET chain_id = 46630 WHERE smart_account = ?").run(SPELLED);
    assert.ok(codes(await preview(c, fakeRpc().rpc)).includes("chain"));
  });

  it("an attested book in use: its running book owns its rows", async () => {
    const b = await books();
    await b.db.exec(LEDGER_IMPORT_SCHEMA);
    b.raw.prepare(`INSERT INTO ledger_resume_attestations (generation, approval_id, tenant, smart_account, chain_id, owner, evidence_digest, receipt_digest, mirror_state_digest,
      snapshot_digest, created_at_ms) VALUES ('gen-1', 'x', ?, ?, 4663, ?, 'e', 'r', 'm', 's', 1)`).run(TENANT, ACCOUNT, TENANT);
    b.raw.prepare(`INSERT INTO tenant_ledger_import (tenant, generation, target_volume_id, state, bytes, sha256, source_digest, bindings_json, created_at_ms,
      grant_updated_at, grant_row_version) VALUES (?, 'gen-1', 'v', 'consumed', 1, 's', 'd', '{}', 1, '1', '1')`).run(TENANT);
    assert.ok(codes(await preview(b, fakeRpc().rpc)).includes("admitted"));
  });

  it("an unreadable head, a vault whose logs cannot be read, a log the filter did not ask for, and admission's own window unread", async () => {
    const head = await preview(await books(), fakeRpc({ failHead: true }).rpc);
    assert.deepEqual([head.verdict, codes(head).includes("chain-unavailable")], ["blocked", true]);
    assert.ok(codes(await preview(await books(), fakeRpc({ refuseLogsFor: CLASS_VAULT }).rpc)).includes("custody-unread"));
    const stray = { address: USDG, topics: [TR, topic(FUNDER), topic(ACCOUNT), topic(FUNDER)], data: `0x${word(1n)}`, logIndex: "0x0", blockNumber: "0x1", transactionHash: h32("stray") };
    assert.ok(codes(await preview(await books(), fakeRpc({ extraLog: stray }).rpc)).includes("log-unreadable"));
    const window = await preview(await books(), fakeRpc({ refuseBeyondPinned: true }).rpc);
    assert.deepEqual(codes(window), ["admission-unread"], "the history from block 0 to the pinned block read whole; admission's window to the head did not");
  });
});

describe("W3 is resetPaperLedger's own pair, never a lookalike", () => {
  it("not when the first later row is something else, nor when the opening is not a paper opening", async () => {
    const first = await books({ marks: [DEPOSIT_AT + 62], reset: EPOCH2_AT });
    first.raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, epoch) VALUES (?, 'swap', 'paper', 1, 'paper', ?, 2)`).run(SPELLED, EPOCH2_AT - 5);
    assert.deepEqual(codes(await preview(first, fakeRpc().rpc)), ["boundary-undated"]);
    const shape = await books({ marks: [DEPOSIT_AT + 62], reset: EPOCH2_AT });
    shape.raw.prepare("UPDATE equity SET positions_usdg = 10, cash_usdg = 990 WHERE epoch = 2 AND at = ?").run(EPOCH2_AT);
    assert.deepEqual(codes(await preview(shape, fakeRpc().rpc)), ["boundary-undated"]);
  });
});

describe("apply's own guards, behind the compare-and-set", () => {
  /** A plan the apply is handed directly, its facts the database's own: only the field named is not what the preview computed. */
  async function ready() {
    const b = await books();
    const p = await preview(b, fakeRpc().rpc);
    assert.equal(p.verdict, "ready");
    return { b, p };
  }
  const refused = (code: string, re?: RegExp) => (e: unknown) => e instanceof BookingRefused && e.code === code && (!re || re.test(e.message));
  const untouched = (b: Books) => assert.deepEqual([rows(b.raw, "SELECT COUNT(*) AS n FROM flows")[0]!.n, rows(b.raw, "SELECT COUNT(*) AS n FROM cost_basis")[0]!.n], [0, 2]);

  it("refuses a blocked plan and a backup named as a URL", async () => {
    const b = await books({ marks: [DEPOSIT_AT + 62], reset: null });
    const blocked = await preview(b, fakeRpc().rpc);
    assert.equal(blocked.verdict, "blocked");
    await assert.rejects(apply(b, blocked), refused("not-ready"));
    const { b: c, p } = await ready();
    await assert.rejects(apply(c, p, { backupRef: "https://backups.example/x" }), refused("backup-ref"));
    untouched(c);
  });

  it("refuses when the epoch's receipts would not be the chain's set, when the net would differ, or a stand-in would stay — nothing written", async () => {
    const { b, p } = await ready();
    await assert.rejects(apply(b, { ...p, predicted: { ...p.predicted, epochReceiptsAfter: p.predicted.epochReceiptsAfter.slice(1) } }), refused("verify", /not exactly the chain's capital set/));
    await assert.rejects(apply(b, { ...p, predicted: { ...p.predicted, epochNetAfter: "1" } }), refused("postcondition", /not the 0\.000001 the preview predicted/));
    untouched(b);
    const q = await books();
    q.raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, source, epoch, chain_id, at) VALUES (?, 'in', 145.499004, 'inferred', 1, 4663, ?)`).run(SPELLED, DEPOSIT_AT + 200);
    const withStandIn = await preview(q, fakeRpc().rpc);
    await assert.rejects(apply(q, { ...withStandIn, proposals: { ...withStandIn.proposals, quarantines: [] }, predicted: { ...withStandIn.predicted, epochNetAfter: "146179478" } }),
      refused("postcondition", /would still hold an unevidenced stand-in/));
  });

  it("refuses when a flat token would still be seeded, when admission would still find a fact, or when the log is already a row", async () => {
    const { b, p } = await ready();
    await assert.rejects(apply(b, { ...p, proposals: { ...p.proposals, clears: [] } }), refused("postcondition", /would still seed a basis or floor/));
    const ghost = { fact: { kind: "operation" as const, userOpHash: h32("ghost"), txHash: h32("ghost tx"), block: "64000000", logIndex: 1, success: true }, said: "ghost", at: DEPOSIT_AT, validator: "root" };
    await assert.rejects(apply(b, { ...p, admission: { ...p.admission, found: [...p.admission.found, ghost] } }), refused("postcondition", /would still find 1 fact/));
    untouched(b);
    const k = await books();
    k.raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at) VALUES (?, 'in', 145.499004, ?, 64045884, 0, 'chain-log', 1, 4663, ?)`)
      .run(SPELLED, DEPOSIT_TX, DEPOSIT_AT);
    const kept = await preview(k, fakeRpc().rpc);
    assert.deepEqual(kept.proposals.inserts.map((i) => i.key), [`log:${SWEEP_TX}#7`], "the deposit is present, only the sweep is filed");
    const deposit = { key: `log:${DEPOSIT_TX}#0`, amountRaw: "145499004", movement: "again", row: { ...kept.proposals.inserts[0]!.row, direction: "in" as const, amount_usdg: 145.499004,
      tx_hash: DEPOSIT_TX, block_number: 64045884, log_index: 0, at: DEPOSIT_AT } };
    await assert.rejects(apply(k, { ...kept, proposals: { ...kept.proposals, inserts: [deposit, ...kept.proposals.inserts] } }), refused("identity", /already names this movement/));
  });
});
