import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CASH } from "../../packages/core/src/index";
import { TRANSFER_TOPIC, type RpcCall } from "./chain-capital";
import { readInitialCapital } from "./initial-capital";
import { BOOKING_CONFIRMATIONS } from "./chain-confirmations";
import { initialCapitalHistoryEmpty } from "./initial-capital-history";
import { deriveBootstrapAccounting } from "./bootstrap-source";
import { accountingLicence, BOOTSTRAP_SCHEMA_VERSION, classifyAnchor } from "./bootstrap-state";
import { wrapSqlite, type Db } from "./db";
import { reconstruct, verifyChain } from "./audit";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-initial-capital-"));
process.env.MERRYMEN_HOME = HOME;
delete process.env.DATABASE_URL;
const store = await import("./store");
const cwd = process.cwd();
mkdirSync(path.join(HOME, "empty"));
try { process.chdir(path.join(HOME, "empty")); await store.initStore(); } finally { process.chdir(cwd); }
let raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
const ACCOUNT = `0x${"a1".repeat(20)}`;
const OWNER = `0x${"b2".repeat(20)}`;
const HASH = `0x${"c3".repeat(32)}`;
const HEAD = `0x${"d4".repeat(32)}`;
const TX = `0x${"e5".repeat(32)}`;
const topic = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const data = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const transfer = (n: bigint, index: number, incoming = true) => ({
  address: CASH.USDG, transactionHash: TX, blockNumber: "0x64", blockHash: HASH,
  logIndex: `0x${index.toString(16)}`, data: data(n),
  topics: [TRANSFER_TOPIC, topic(incoming ? OWNER : ACCOUNT), topic(incoming ? ACCOUNT : OWNER)],
});
const DEPOSIT = transfer(200_000_000n, 1);
type RpcState = { calls: [string, unknown[]][]; rpc: RpcCall };
function rpcFixture(o: {
  logs?: ReturnType<typeof transfer>[]; balance?: bigint; head?: bigint;
  replace?: (method: string, params: unknown[], value: unknown) => unknown;
} = {}): RpcState {
  const calls: [string, unknown[]][] = [];
  const logs = o.logs ?? [DEPOSIT];
  const rpc: RpcCall = async (method, params) => {
    calls.push([method, params]);
    let value: unknown;
    if (method === "eth_chainId") value = "0x1237";
    else if (method === "eth_blockNumber") value = `0x${(o.head ?? (101n + BOOKING_CONFIRMATIONS)).toString(16)}`;
    else if (method === "eth_getBlockByNumber") value = { number: params[0], hash: params[0] === "0x64" ? HASH : HEAD, timestamp: "0x6553f100" };
    else if (method === "eth_getLogs") {
      const { topics, fromBlock, toBlock } = params[0] as { topics: (null | string | string[])[]; fromBlock: string; toBlock: string };
      value = logs.filter(l => BigInt(l.blockNumber) >= BigInt(fromBlock) && BigInt(l.blockNumber) <= BigInt(toBlock)
        && topics.every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i]!) : t === l.topics[i])));
    } else if (method === "eth_getTransactionReceipt") value = { transactionHash: TX, status: "0x1", blockNumber: "0x64", blockHash: HASH, logs };
    else if (method === "eth_call") value = data(o.balance ?? 200_000_000n);
    else throw new Error(`Unexpected RPC ${method}`);
    return o.replace ? o.replace(method, params, value) : value;
  };
  return { rpc, calls };
}
const read = (rpc: RpcCall, licence = "new-account") => readInitialCapital(rpc, { account: ACCOUNT, chainId: 4663, licence });
const count = (table: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const peak = async () => (await store.getAgentFinancials(ACCOUNT)).hwmUsdg;
const grant = { smartAccount: ACCOUNT, owner: OWNER, sessionKeyAddress: OWNER, chainId: 4663,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 24 }, grantedAt: 1_700_000_000, expiresAt: 2_000_000_000 };
function mark(cash = 0, mode: string | null = "live", held = 0) {
  raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, mode, flows_held) VALUES (?, '0', ?, 0, ?, ?, ?)")
    .run(ACCOUNT, cash, cash, mode, held);
}
const anchor = () => deriveBootstrapAccounting(wrapSqlite(raw), ACCOUNT, 1_800_000_000);

beforeEach(async () => {
  raw.exec("DROP TRIGGER IF EXISTS fail_initial_capital");
  for (const table of ["agents", "flows", "journal", "equity", "fee_accruals", "trades", "positions", "cost_basis", "class_positions", "trench_positions", "risk_periods", "owner_operations", "paper_book"]) raw.exec(`DELETE FROM ${table}`);
  await store.ensureAgent(grant as never);
  await store.setAgentMode(ACCOUNT, "live", 1_800_000_000, true);
});
after(() => { raw.close(); store.closeStoreForTest(); rmSync(HOME, { recursive: true, force: true }); });

describe("initial funding receipt evidence", () => {
  it("pins history and balance to head minus 64, and proves the unconfirmed tail is empty", async () => {
    const f = rpcFixture();
    const evidence = await read(f.rpc);
    assert.equal(evidence.cashUsdg6, 200_000_000n);
    assert.equal(evidence.deposits[0]?.at, 1_700_000_000);
    assert.equal(evidence.blockNumber, 101n);
    assert.equal(evidence.blockHash, HEAD);
    const logCalls = f.calls.filter(([m]) => m === "eth_getLogs");
    assert.equal(logCalls.length, 4);
    for (const [, params] of logCalls.slice(0, 2)) assert.deepEqual(
      [(params[0] as { fromBlock: string }).fromBlock, (params[0] as { toBlock: string }).toBlock], ["0x66", "0xa5"]);
    for (const [, params] of logCalls.slice(2)) assert.deepEqual(
      [(params[0] as { fromBlock: string }).fromBlock, (params[0] as { toBlock: string }).toBlock], ["0x0", "0x65"]);
    assert.equal(f.calls.find(([m]) => m === "eth_call")?.[1][1], "0x65");
    for (const tag of ["0x65", "0xa5"]) assert.equal(f.calls.filter(([m, p]) => m === "eth_getBlockByNumber" && p[0] === tag).length, 2);
  });
  it("refuses heads below the confirmation depth before requesting a range or balance", async () => {
    for (const head of [0n, BOOKING_CONFIRMATIONS - 1n]) {
      const f = rpcFixture({ head });
      await assert.rejects(read(f.rpc));
      assert.deepEqual(f.calls.map(([method]) => method), ["eth_chainId", "eth_blockNumber"]);
    }
    assert.equal(count("flows"), 0); assert.equal(await peak(), 0);
  });
  it("holds at 63 confirmations and books once at exactly 64 after a funded held tick", async () => {
    const immature = rpcFixture({ head: 100n + BOOKING_CONFIRMATIONS - 1n });
    await assert.rejects(read(immature.rpc));
    assert.equal(immature.calls.some(([m]) => m === "eth_call" || m === "eth_getTransactionReceipt"), false);
    assert.equal(count("flows"), 0); assert.equal(await peak(), 0);
    mark(200, "live", 1);
    const mature = await read(rpcFixture({ head: 100n + BOOKING_CONFIRMATIONS }).rpc);
    assert.equal(mature.blockNumber, 100n); assert.equal(mature.blockHash, HASH);
    assert.equal((await store.bookInitialCapital(ACCOUNT, mature)).kind, "booked");
    assert.equal((await store.bookInitialCapital(ACCOUNT, mature)).kind, "already");
    assert.equal(count("flows"), 1); assert.equal(await peak(), 200);
  });
  for (const [name, recent] of [
    ["incoming deposit", [transfer(1_000_000n, 2)]],
    ["withdrawal", [transfer(1_000_000n, 2, false)]],
    ["out-and-back with unchanged cash", [transfer(1_000_000n, 2, false), transfer(1_000_000n, 3)]],
  ] as const) it(`holds unconfirmed ${name} even when confirmed cash still matches`, async () => {
    const logs = [DEPOSIT, ...recent.map(log => ({ ...log, blockNumber: "0x66" }))];
    await assert.rejects(read(rpcFixture({ logs, balance: 200_000_000n }).rpc));
    assert.equal(count("flows"), 0); assert.equal(await peak(), 0);
  });
  it("holds unreadable or malformed tail evidence without booking confirmed funds", async () => {
    for (const response of [null, { logs: [] }, "unavailable"]) {
      await assert.rejects(read(rpcFixture({ replace: (m, p, value) => m === "eth_getLogs"
        && (p[0] as { fromBlock: string }).fromBlock === "0x66" ? response : value }).rpc));
    }
    await assert.rejects(read(rpcFixture({ replace: (m, p, value) => {
      if (m === "eth_getLogs" && (p[0] as { fromBlock: string }).fromBlock === "0x66") throw new Error("tail RPC unavailable");
      return value;
    } }).rpc));
    assert.equal(count("flows"), 0); assert.equal(await peak(), 0);
  });
  it("refuses an established/unknown licence without asking the chain", async () => {
    const f = rpcFixture();
    await assert.rejects(read(f.rpc, "resume"));
    assert.equal(f.calls.length, 0);
  });
  for (const [name, replace] of [
    ["wrong chain", (m: string, _p: unknown[], v: unknown) => m === "eth_chainId" ? "0x1" : v],
    ["reverted receipt", (m: string, _p: unknown[], v: unknown) => m === "eth_getTransactionReceipt" ? { ...(v as object), status: "0x0" } : v],
    ["missing receipt log", (m: string, _p: unknown[], v: unknown) => m === "eth_getTransactionReceipt" ? { ...(v as object), logs: [] } : v],
    ["receipt on another fork", (m: string, _p: unknown[], v: unknown) => m === "eth_getTransactionReceipt" ? { ...(v as object), blockHash: HEAD } : v],
    ["noncanonical deposit block", (m: string, p: unknown[], v: unknown) => m === "eth_getBlockByNumber" && p[0] === "0x64" ? { ...(v as object), hash: HEAD } : v],
    ["missing block timestamp", (m: string, p: unknown[], v: unknown) => m === "eth_getBlockByNumber" && p[0] === "0x64" ? { ...(v as object), timestamp: null } : v],
  ] as const) it(`holds ${name}`, async () => { await assert.rejects(read(rpcFixture({ replace }).rpc)); });
  for (const tag of ["0x65", "0xa5"]) it(`holds a reorg of pinned block ${tag} during the scan`, async () => {
    let reads = 0;
    await assert.rejects(read(rpcFixture({ replace: (m, p, v) => m === "eth_getBlockByNumber" && p[0] === tag && ++reads > 1
      ? { ...(v as object), hash: HASH } : v }).rpc));
    assert.equal(count("flows"), 0); assert.equal(await peak(), 0);
  });
  it("holds withdrawals and trade proceeds, even when the net reconciles", async () => {
    await assert.rejects(read(rpcFixture({ logs: [DEPOSIT, transfer(10_000_000n, 2, false)], balance: 190_000_000n }).rpc));
    const sale = { ...transfer(1n, 2, false), address: OWNER };
    await assert.rejects(read(rpcFixture({ replace: (m, _p, v) => m === "eth_getTransactionReceipt" ? { ...(v as object), logs: [DEPOSIT, sale] } : v }).rpc));
  });
  it("holds a balance mismatch or unavailable receipt and books no inference", async () => {
    await assert.rejects(read(rpcFixture({ balance: 201_000_000n }).rpc));
    await assert.rejects(read(rpcFixture({ replace: (m, _p, v) => { if (m === "eth_getTransactionReceipt") throw new Error("RPC unavailable"); return v; } }).rpc));
    assert.equal(count("flows"), 0);
    assert.equal(await peak(), 0);
  });
});

describe("atomic initial capital and restart", () => {
  it("requires an explicitly live account mode", async () => {
    const e = await read(rpcFixture().rpc);
    for (const mode of [null, "idle", "paper", "unknown"]) {
      raw.prepare("UPDATE agents SET mode = ?").run(mode);
      assert.equal((await store.bookInitialCapital(ACCOUNT, e)).kind, "refused");
      assert.equal(count("flows"), 0); assert.equal(await peak(), 0);
    }
    await store.setAgentMode(ACCOUNT, "live", 1_800_000_001, true);
    assert.equal((await store.bookInitialCapital(ACCOUNT, e)).kind, "booked");
  });
  it("books complete receipts once, survives reopen and produces a known durable anchor", async () => {
    const evidence = await read(rpcFixture().rpc);
    assert.equal((await store.bookInitialCapital(ACCOUNT, evidence)).kind, "booked");
    assert.equal((await store.bookInitialCapital(ACCOUNT, evidence)).kind, "already");
    raw.close(); store.closeStoreForTest(); await store.initStore(); raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
    assert.equal((await store.bookInitialCapital(ACCOUNT, evidence)).kind, "already");
    assert.equal(count("flows"), 1);
    assert.equal(await peak(), 200);
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 200);
    const journal = await store.readJournal(ACCOUNT, 1);
    assert.equal(journal.length, 2);
    assert.deepEqual(verifyChain(journal), []);
    assert.equal(reconstruct(journal).netContributionsUsdg, 200);
    const accounting = await anchor();
    const verdict = classifyAnchor(JSON.stringify({ schemaVersion: BOOTSTRAP_SCHEMA_VERSION, tenantId: ACCOUNT,
      generatedAt: 1_800_000_000, accounting }), { tenantId: ACCOUNT, nowSec: 1_800_000_000 });
    const licence = accountingLicence(verdict, { hosted: true });
    assert.equal(licence.licence, "resume");
    assert.equal(licence.contributionsKnown, true);
    assert.equal(licence.highWaterMarkUsdg, 200_000_000n);
  });
  it("rolls the whole batch back if its second receipt or peak fails", async () => {
    const evidence = await read(rpcFixture({ logs: [DEPOSIT, transfer(50_000_000n, 2)], balance: 250_000_000n }).rpc);
    for (const trigger of [
      "BEFORE INSERT ON flows WHEN NEW.log_index = 2",
      "BEFORE UPDATE OF hwm_usdg ON agents WHEN NEW.hwm_usdg > OLD.hwm_usdg",
      "BEFORE INSERT ON journal WHEN NEW.kind = 'mark'",
    ]) {
      raw.exec(`CREATE TRIGGER fail_initial_capital ${trigger} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
      await assert.rejects(store.bookInitialCapital(ACCOUNT, evidence), /injected failure/);
      assert.equal(count("flows"), 0); assert.equal(count("journal"), 0); assert.equal(await peak(), 0);
      raw.exec("DROP TRIGGER fail_initial_capital");
    }
    assert.equal((await store.bookInitialCapital(ACCOUNT, evidence)).kind, "booked");
    assert.equal(count("flows"), 2); assert.equal(await peak(), 250);
  });
  it("retries after a held funded valuation without changing that valuation", async () => {
    mark(200, "live", 1);
    const before = raw.prepare("SELECT * FROM equity").all();
    assert.equal((await store.bookInitialCapital(ACCOUNT, await read(rpcFixture().rpc))).kind, "booked");
    assert.deepEqual(raw.prepare("SELECT * FROM equity").all(), before);
  });
  it("retries a complete locally settled batch when the supervisor anchor has not caught up", async () => {
    const e = await read(rpcFixture().rpc);
    await store.bookInitialCapital(ACCOUNT, e);
    mark(200);
    const before = { flows: raw.prepare("SELECT * FROM flows").all(), journal: raw.prepare("SELECT * FROM journal").all(), equity: raw.prepare("SELECT * FROM equity").all() };
    raw.close(); store.closeStoreForTest(); await store.initStore(); raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
    assert.equal((await store.bookInitialCapital(ACCOUNT, e)).kind, "already");
    assert.deepEqual({ flows: raw.prepare("SELECT * FROM flows").all(), journal: raw.prepare("SELECT * FROM journal").all(), equity: raw.prepare("SELECT * FROM equity").all() }, before);
    assert.equal(await peak(), 200);
    mark(201);
    assert.equal((await store.bookInitialCapital(ACCOUNT, e)).kind, "refused", "a changed book needs its current anchor");
  });
  it("refuses another account, prior inferred capital and a changed retry payload", async () => {
    const e = await read(rpcFixture().rpc);
    assert.equal((await store.bookInitialCapital(OWNER, e)).kind, "refused");
    await store.addFlow({ agentId: ACCOUNT, direction: "in", amountUsdg: 200, source: "inferred", mode: "live" });
    assert.equal((await store.bookInitialCapital(ACCOUNT, e)).kind, "refused");
    assert.equal(await peak(), 0);
    raw.exec("DELETE FROM flows; DELETE FROM journal");
    await store.bookInitialCapital(ACCOUNT, e);
    const changed = { ...e, cashUsdg6: 201_000_000n, deposits: [{ ...e.deposits[0]!, amountUsdg6: 201_000_000n }] };
    assert.equal((await store.bookInitialCapital(ACCOUNT, changed)).kind, "refused");
    assert.equal(await peak(), 200);
  });
});

describe("pre-funding restart receipt eligibility", () => {
  it("Practise then Enable live keeps the simulated book and books only the real first deposit", async () => {
    await store.setAgentMode(ACCOUNT, "paper", 1_800_000_000, true);
    const paper = await store.getPaperBook(ACCOUNT, 1000);
    await store.setPaperBook(ACCOUNT, { ...paper, cashUsdg: 900, hwmUsdg: 1200, shares: { X: { token: OWNER as `0x${string}`, shares: 1 } } });
    assert.equal(await store.addTrade({ agent_id: ACCOUNT, kind: "swap", target: OWNER, status: "paper", amount_usdg: 100,
      sell_token: CASH.USDG, buy_token: OWNER, fill_side: "buy", fill_symbol: "X", fill_qty_raw: "1000000000000000000",
      fill_cash_usdg: 100, fill_price_usd: 100, basis_source: "paper" }), true);
    await store.setBasis(ACCOUNT, "paper", "X", { qtyRaw: 1_000_000_000_000_000_000n, costUsdg: 100_000_000n });
    await store.setTrenchEntry(ACCOUNT, "paper", "X", 10000);
    await store.addEquity(ACCOUNT, { mode: "paper", ethWei: 0n, cashUsdg: 900, vaultUsdg: 0, positionsUsdg: 300,
      equityUsdg: 1200, quarantinedCostUsdg: 0, marks: [] });
    await store.setPositions(ACCOUNT, [{ symbol: "X", token: OWNER, rawBalance: 1_000_000_000_000_000_000n,
      uiMultiplier: 1n, priceUsd: 300, priceStale: false, priceSource: "pool", valueUsdg: 300 }]);
    const preserved = () => ["paper_book", "trades", "cost_basis", "trench_positions", "equity", "positions"]
      .map(table => raw.prepare(`SELECT * FROM ${table}`).all());
    const before = preserved();
    assert.equal(await peak(), 0, "simulated HWM never touched the live peak");
    assert.equal((await store.getAgentFinancials(ACCOUNT)).accruedFeeUsdg, 0);
    const paperAnchor = await anchor();
    assert.equal(paperAnchor.kind === "established" && paperAnchor.initialCapitalEligible, true);
    assert.equal(paperAnchor.kind === "established" && paperAnchor.lastObservedCashUsdg, null);
    assert.equal((await store.bookInitialCapital(ACCOUNT, await read(rpcFixture().rpc))).kind, "refused", "paper rail cannot book through the live-only startup path");
    await store.setAgentMode(ACCOUNT, "live", 1_800_000_001, true);
    raw.close(); store.closeStoreForTest(); await store.initStore(); raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
    assert.equal(await store.getAgentEpoch(ACCOUNT), 1);
    assert.equal((await store.bookInitialCapital(ACCOUNT, await read(rpcFixture().rpc, "untouched-book"))).kind, "booked");
    assert.deepEqual(preserved(), before, "paper capital, fills, basis, peak and snapshots are retained exactly");
    assert.equal(await peak(), 200);
    assert.equal((await store.getAgentFinancials(ACCOUNT)).accruedFeeUsdg, 0);
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 200);
    assert.deepEqual(verifyChain(await store.readJournal(ACCOUNT, 1)), []);
    const liveAnchor = await anchor();
    assert.equal(liveAnchor.kind === "established" && liveAnchor.anchoredContributionsUsdg, "200000000");
  });
  it("keeps zero-only history established and adds a receipt-only eligibility fact", async () => {
    mark();
    const a = await anchor();
    assert.equal(a.kind, "established");
    assert.equal(a.kind === "established" && a.initialCapitalEligible, true);
    const v = classifyAnchor(JSON.stringify({ schemaVersion: BOOTSTRAP_SCHEMA_VERSION, tenantId: ACCOUNT,
      generatedAt: 1_800_000_000, accounting: a }), { tenantId: ACCOUNT, nowSec: 1_800_000_000 });
    assert.equal(accountingLicence(v, { hosted: true }).licence, "resume");
    assert.equal((await store.bookInitialCapital(ACCOUNT, await read(rpcFixture().rpc, "untouched-book"))).kind, "booked");
  });
  it("retries funded held-only history across a process restart without inventing a cash baseline", async () => {
    mark(200, "live", 1);
    const a = await anchor();
    assert.equal(a.kind, "established");
    assert.equal(a.kind === "established" && a.initialCapitalEligible, true);
    assert.equal(a.kind === "established" && a.lastObservedCashUsdg, null);
    const v = classifyAnchor(JSON.stringify({ schemaVersion: BOOTSTRAP_SCHEMA_VERSION, tenantId: ACCOUNT,
      generatedAt: 1_800_000_000, accounting: a }), { tenantId: ACCOUNT, nowSec: 1_800_000_000 });
    assert.equal(v.kind, "valid");
    raw.close(); store.closeStoreForTest(); await store.initStore(); raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
    assert.equal((await store.bookInitialCapital(ACCOUNT, await read(rpcFixture().rpc, "untouched-book"))).kind, "booked");
    assert.equal(await peak(), 200);
    assert.equal((await anchor()).kind, "established");
  });
  it("rejects a malformed or inconsistent additive eligibility fact, while old anchors remain readable", async () => {
    mark();
    const a = await anchor();
    const verdict = (accounting: unknown) => classifyAnchor(JSON.stringify({ schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
      tenantId: ACCOUNT, generatedAt: 1_800_000_000, accounting }), { tenantId: ACCOUNT, nowSec: 1_800_000_000 });
    assert.notEqual(verdict({ ...a, initialCapitalEligible: "true" }).kind, "valid");
    assert.notEqual(verdict({ ...a, highWaterMarkUsdg: "1" }).kind, "valid");
    assert.notEqual(verdict({ ...a, accountingEpoch: 2 }).kind, "valid");
    assert.equal(verdict({ ...a, initialCapitalEligible: undefined }).kind, "valid");
  });
  for (const [name, setup] of [
    ["historical nonzero then zero", () => { mark(10); mark(); }],
    ["unclassified zero", () => mark(0, null)],
    ["nonzero live HWM alongside practice", () => { mark(1000, "paper"); raw.exec("UPDATE agents SET hwm_usdg = 1"); }],
    ["prior epoch", () => raw.exec("UPDATE agents SET epoch = 2")],
    ["withdrawals", () => raw.exec("UPDATE agents SET hwm_withdrawn_usdg = 1")],
    ["old flow", () => raw.prepare("INSERT INTO flows(agent_id,direction,amount_usdg,source,epoch) VALUES (?, 'in', 1, 'inferred', 2)").run(ACCOUNT)],
    ["fee history", () => raw.prepare("INSERT INTO fee_accruals(agent_id,profit_usdg,fee_usdg,hwm_before_usdg,hwm_after_usdg) VALUES (?, 0, 0, 0, 0)").run(ACCOUNT)],
    ["submitted trade", () => raw.prepare("INSERT INTO trades(agent_id,kind,target,amount_usdg,status) VALUES (?, 'swap', ?, 1, 'submitted')").run(ACCOUNT, OWNER)],
    ["rejected broadcast trade", () => raw.prepare("INSERT INTO trades(agent_id,kind,target,amount_usdg,status,user_op_hash) VALUES (?, 'swap', ?, 1, 'rejected', ?)").run(ACCOUNT, OWNER, TX)],
    ["paper fill", () => raw.prepare("INSERT INTO trades(agent_id,kind,target,amount_usdg,status) VALUES (?, 'swap', ?, 1, 'paper')").run(ACCOUNT, OWNER)],
    ["paper label on broadcast fill", () => raw.prepare("INSERT INTO trades(agent_id,kind,target,amount_usdg,status,basis_source,tx_hash) VALUES (?, 'swap', ?, 1, 'paper', 'paper', ?)").run(ACCOUNT, OWNER, TX)],
    ["basis history", () => raw.prepare("INSERT INTO cost_basis(agent_id,mode,symbol,qty_raw,cost_usdg) VALUES (?, 'live', 'X', '0', '0')").run(ACCOUNT)],
  ] as const) it(`does not grant or use eligibility with ${name}`, async () => {
    mark(); setup();
    const a = await anchor();
    assert.notEqual(a.kind === "established" && a.initialCapitalEligible, true);
    assert.equal((await store.bookInitialCapital(ACCOUNT, await read(rpcFixture().rpc))).kind, "refused");
  });
  it("fails closed when a new projection is missing or unreadable", async () => {
    const unavailable = { prepare: () => ({ get: async () => undefined }) } as unknown as Db;
    assert.equal(await initialCapitalHistoryEmpty(unavailable, ACCOUNT), false);
    const broken = { prepare: () => { throw new Error("missing table"); } } as unknown as Db;
    assert.equal(await initialCapitalHistoryEmpty(broken, ACCOUNT), false);
  });
  it("wires the first-funding path independently of the optional scanner and refuses inference", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(source, /cfg\.depositScanEnabled \|\| \(initialCapitalLicence !== null && !initialCapitalComplete\)/);
    assert.match(source, /if \(plan\.amountUsdg > 0n\) throw new Error\("Hosted initial funding requires verified receipts"\)/);
    assert.match(source, /if \(initialCapitalLicence !== null && !initialCapitalComplete\) return null/);
    const branch = source.slice(source.indexOf("let covered = false;"), source.indexOf("// THE LEDGER, READ ONCE"));
    assert.ok(branch.indexOf("await bookInitialCapital") < branch.indexOf("initialCapitalComplete = true"));
    assert.doesNotMatch(branch, /addFlow|adjustAgentHwm/);
    assert.match(branch, /else if \(initialCapitalLicence !== null && !initialCapitalComplete\) \{[\s\S]*return "held"/,
      "unfunded first looks keep the baseline open so rail cash can detect funding");
  });
});
