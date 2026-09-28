/**
 * A SETTLEMENT EXPLAINS ONLY ITS OWN CASH — against a real sqlite ledger.
 *
 * Two generations of the same hole. First: a stranded energy purchase (the
 * bundler's receipt wait timed out, the row left 'submitted', no recordTrade)
 * had its cash drop inferred as a withdrawal, then the stranded-op resolver
 * booked it AGAIN as capital out. The ACC1 fix held inference while the op was
 * in flight and had the resolver bump `ledgerWrites`, so the interval closed as
 * "explained" — which explained everything else in it too: a deposit made
 * during the hold was never booked (and was charged a fee on the held ticks), a
 * stranded transfer home was never booked, and a REVERTED op closed the
 * interval just the same.
 *
 * `tick` and `resolvePass` below are index.ts reconcileFlows' steady-state
 * branch (scan off) with the tick's fee ratchet, and resolveStrandedOps' loop,
 * run over the real store with the real functions: resolveSubmittedOps over a
 * fake chain, settleEnergyLanding, lookAtCash, settlementDelta, tickRatchets
 * and accrueAboveHwm. energy-buy-wiring.test.ts pins that index.ts has this
 * shape.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-flow-inference-"));
process.env.MERRYMEN_HOME = HOME;

const store = await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");
const { CASH, ENERGY_ROUTE_V1, MERRYMEN_TOKEN, VIRTUAL_TOKEN } = await import("../../packages/core/src/index");
const { TRANSFER_TOPIC } = await import("./deposit-log");
const { isEnergyRow, settleEnergyLanding, settleTransferLanding } = await import("./energy-settle");
const { attributeSettlements, lookAtCash, opsHoldInference, settlementDelta, STRANDED_RESOLVE_WINDOW_SEC, wroteSince } = await import("./flow-inference");
const { planFirstObservation } = await import("./bootstrap-state");
const { addressTopic, resolveSubmittedOps } = await import("./inflight-reconcile");
const { tickPlan, tickRatchets } = await import("./command-wake");
const { accrueAboveHwm } = await import("./fees");
type Deps = import("./energy-settle").EnergySettleDeps;
type ReceiptLog = import("./fills").ReceiptLog;
type RawLog = import("./inflight-reconcile").RawLog;
type ReconcileChain = import("./inflight-reconcile").ReconcileChain;
type Settlement = import("./flow-inference").Settlement;

const ACCOUNT = "0x00000000000000000000000000000000000e0e07";
const OWNER = "0x00000000000000000000000000000000000000ff";
const USDG = (CASH.USDG as string).toLowerCase();
const MERRY = MERRYMEN_TOKEN.address.toLowerCase();
const STOCK = "0x000000000000000000000000000000000000aa01";
const PAIR_A = "0x00000000000000000000000000000000000000b1";
const PAIR_B = "0x00000000000000000000000000000000000000b2";
const RISK_ID = "flow-inference-risk";
const U = 1_000_000n;
const FEE_BPS = 2000;
const GRANT = {
  smartAccount: ACCOUNT,
  owner: OWNER,
  sessionKeyAddress: "0x00000000000000000000000000000000000000fe",
  chainId: 4663,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 24 },
  grantedAt: 1_700_000_000,
  expiresAt: 2_000_000_000,
} as never;

const raw = () => new DatabaseSync(homePaths.db());
function exec(sql: string, ...params: (string | number | null)[]): void {
  const db = raw();
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}
function one<T>(sql: string, ...params: (string | number | null)[]): T {
  const db = raw();
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}
const flowsBy = (source: string, direction?: "in" | "out") =>
  Number(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM flows WHERE agent_id = ? AND source = ?${direction ? " AND direction = ?" : ""}`,
      ...([ACCOUNT, source, ...(direction ? [direction] : [])] as string[]),
    ).n,
  );
const inferredIn = () =>
  Number(one<{ s: number | null }>("SELECT SUM(amount_usdg) AS s FROM flows WHERE agent_id = ? AND source = 'inferred' AND direction = 'in'", ACCOUNT).s ?? 0);
const peak = async () => (await store.getAgentFinancials(ACCOUNT)).hwmUsdg;
const riskPeak = async () => store.getRiskPeriodPeak(ACCOUNT);
const equityRows = () => Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM equity WHERE agent_id = ?", ACCOUNT).n);
const nowSec = () => Math.floor(Date.now() / 1000);

// ── the chain ─────────────────────────────────────────────────────────────

const EP_ABI = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
function opLog(userOpHash: string, success: boolean, txHash: string): RawLog {
  const topics = encodeEventTopics({
    abi: EP_ABI,
    eventName: "UserOperationEvent",
    args: { userOpHash: userOpHash as Hex, sender: ACCOUNT, paymaster: "0x0000000000000000000000000000000000000000" },
  });
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
    [1n, success, 0n, 0n],
  );
  return { topics: topics as readonly Hex[], data, transactionHash: txHash as Hex, blockNumber: "0x895441" };
}
const topic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const transfer = (token: string, from: string, to: string, amount: bigint, logIndex: number): ReceiptLog => ({
  address: token,
  topics: [TRANSFER_TOPIC, topic(from), topic(to)],
  data: `0x${amount.toString(16).padStart(64, "0")}`,
  logIndex,
  blockNumber: 9_000_001n,
});
const energyLogs = (usdg6: bigint): ReceiptLog[] => [
  transfer(USDG, ACCOUNT, PAIR_A, usdg6, 17),
  transfer(VIRTUAL_TOKEN, PAIR_A, PAIR_B, 90n * 10n ** 18n, 18),
  transfer(MERRY, PAIR_B, MERRY, 200n * 10n ** 18n, 19),
  transfer(MERRY, PAIR_B, ACCOUNT, 19_800n * 10n ** 18n, 20),
];
const swapLogs = (usdg6: bigint): ReceiptLog[] => [
  transfer(USDG, ACCOUNT, PAIR_A, usdg6, 3),
  transfer(STOCK, PAIR_A, ACCOUNT, 10n ** 18n, 4),
];
const transferLogs = (usdg6: bigint, to = OWNER): ReceiptLog[] => [transfer(USDG, ACCOUNT, to, usdg6, 7)];

/**
 * What the chain knows: each op's UserOperationEvent (landed or reverted) and
 * each tx's receipt (null: the RPC would not return it). An op not in `events`
 * has not been found — pending, or dropped by the bundler.
 */
const chainState = {
  events: new Map<string, { success: boolean; txHash: string }>(),
  receipts: new Map<string, readonly ReceiptLog[] | null>(),
};
const chain: ReconcileChain = {
  async getBlockNumber() {
    return 9_000_100n;
  },
  async getLogs(a) {
    const want = String(a.topics[1] ?? "").toLowerCase();
    const e = chainState.events.get(want);
    return e ? [opLog(want, e.success, e.txHash)] : [];
  },
  async getReceiptLogs(txHash) {
    const r = chainState.receipts.get(txHash.toLowerCase());
    return r === undefined ? null : r;
  },
};
/** The op landed (or reverted) on-chain; its receipt is readable unless `receipt` is null. */
function lands(op: string, receipt: readonly ReceiptLog[] | null, success = true): string {
  const tx = `0x${(++n).toString(16).padStart(64, "e")}`;
  chainState.events.set(op, { success, txHash: tx });
  chainState.receipts.set(tx, receipt);
  return tx;
}

function deps(): Deps {
  return {
    agentId: ACCOUNT,
    account: ACCOUNT,
    chainId: 4663,
    paper: false,
    receiptLogs: async (h) => chain.getReceiptLogs(h),
    netContributionsUsdg: () => store.getNetContributionsUsdg(ACCOUNT),
    lifetimePeakUsdg: async () => (await store.getAgentFinancials(ACCOUNT)).hwmUsdg,
    breakerPeakUsdg: () => store.getRiskPeriodPeak(ACCOUNT),
    book: (f) => store.bookCapitalFlow(f),
    event: async () => {},
    flowBookedForTx: (h) => store.hasFlowForTx(ACCOUNT, h),
  };
}

// ── the process ───────────────────────────────────────────────────────────

/**
 * main()'s own state: lastCashUsdg, baselineSince, baselineUnattributed, the
 * ledger-write counters, the settlement queue — and, for a restart, when the
 * process started and (hosted) what its anchor said.
 */
const proc = {
  lastCash: 100n * U as bigint | null,
  since: 0 as number | null,
  unattributed: false,
  writes: 0,
  snapshot: 0,
  queue: [] as Settlement[],
  queued: new Set<string>(),
  doubted: false,
  fees: [] as bigint[],
  startedSec: 0,
  anchor: null as { cashUsdg: bigint; observedAt: number } | null,
};
/** The process stops and a new one starts: everything in memory is gone; the ledger stays. */
function restart(at = nowSec(), anchor: { cashUsdg: bigint; observedAt: number } | null = null): void {
  Object.assign(proc, { lastCash: null, since: null, unattributed: false, writes: 0, snapshot: 0, queue: [], queued: new Set(), doubted: false, fees: [], startedSec: at, anchor });
}
const take = () => {
  const out = proc.queue;
  proc.queue = [];
  return out;
};

/** index.ts record(): the inferred flow, then both peaks with it. */
async function record(deltaUsdg: bigint): Promise<void> {
  if (deltaUsdg === 0n) return;
  const out = deltaUsdg < 0n;
  const amount = out ? -deltaUsdg : deltaUsdg;
  assert.equal(await store.addFlow({ agentId: ACCOUNT, direction: out ? "out" : "in", amountUsdg: Number(amount) / 1e6, source: "inferred", mode: "live" }), true);
  await store.adjustAgentHwm(ACCOUNT, Number(deltaUsdg) / 1e6);
}

/**
 * The tick's live accounting with the scan off: index.ts reconcileFlows'
 * steady-state branch, then what tickRatchets lets the tick write — the fee and
 * the live mark (accrueAboveHwm against the persisted peak) and the equity row.
 * `equity` defaults to cash: a book of only USDG.
 */
async function tick(cash: bigint, equity = cash): Promise<"hold" | "explained" | "infer" | "resume-clean" | "resume-with-drift"> {
  const listedAt = nowSec();
  const opsInFlight = opsHoldInference(await store.listSubmittedOps(ACCOUNT), {
    epoch: await store.getAgentEpoch(ACCOUNT),
    nowSec: listedAt,
  });
  if (proc.lastCash === null) return firstLook(cash, equity, listedAt, opsInFlight);
  const l = lookAtCash({
    baselineUsdg: proc.lastCash,
    since: proc.since,
    unattributed: proc.unattributed,
    settled: take(),
    cashUsdg: cash,
    opsInFlight,
    writesInInterval: proc.writes !== proc.snapshot,
  });
  proc.lastCash = l.baselineUsdg;
  proc.unattributed = l.unattributed;
  if (l.unread.length > 0) proc.doubted = true;
  let held = true;
  if (l.verdict.action !== "hold") {
    if (l.verdict.action === "infer") await record(l.verdict.deltaUsdg);
    proc.lastCash = cash;
    proc.since = listedAt;
    proc.unattributed = false;
    proc.snapshot = proc.writes;
    held = opsInFlight;
  }
  await ratchet(cash, equity, held);
  return l.verdict.action;
}

/**
 * index.ts reconcileFlows' FIRST OBSERVATION with the scan off: the hold, the
 * durable reads, then the self-hosted look against the last durable reading
 * (legacy-local) or the hosted resume's drift against its anchor.
 */
async function firstLook(cash: bigint, equity: bigint, listedAt: number, opsInFlight: boolean): Promise<"hold" | "explained" | "infer" | "resume-clean" | "resume-with-drift"> {
  if (opsInFlight) {
    await ratchet(cash, equity, true);
    return "hold";
  }
  const prior = proc.anchor ? null : await store.lastKnownCashReading(ACCOUNT);
  const earlierLanded = prior === null ? [] : await store.landedOpsBetween(ACCOUNT, prior.at, proc.startedSec + 1);
  const settled = take();
  let out: "explained" | "infer" | "resume-clean" | "resume-with-drift" = "explained";
  if (proc.anchor) {
    const shift = attributeSettlements(settled, proc.anchor.observedAt);
    if (shift.unread.length > 0) proc.doubted = true;
    const plan = planFirstObservation({ licence: "resume", equityUsdg: equity, cashUsdg: cash, anchorCashUsdg: proc.anchor.cashUsdg + shift.shiftUsdg6, materialDriftUsdg: 10_000n });
    if (plan.action === "resume-with-drift") proc.doubted = true;
    out = plan.action as "resume-clean" | "resume-with-drift";
  } else if (prior !== null) {
    const l = lookAtCash({
      baselineUsdg: BigInt(Math.round(prior.cashUsdg * 1e6)),
      since: prior.at,
      unattributed: false,
      settled,
      cashUsdg: cash,
      opsInFlight: false,
      writesInInterval: proc.writes > 0 || wroteSince(earlierLanded, proc.queued),
    });
    if (l.unread.length > 0) proc.doubted = true;
    if (l.verdict.action === "infer") await record(l.verdict.deltaUsdg);
    out = l.verdict.action as "explained" | "infer";
  }
  proc.lastCash = cash;
  proc.since = listedAt;
  proc.unattributed = false;
  proc.snapshot = proc.writes;
  await ratchet(cash, equity, false);
  return out;
}

/** THE RATCHET — the live branch of tick(), after reconcileFlowsOrRetry. */
async function ratchet(cash: bigint, equity: bigint, held: boolean): Promise<void> {
  const ratchet = tickRatchets(tickPlan("regular"), { incomplete: false, curveMarked: 0, held });
  const mark = BigInt(Math.round((await peak()) * 1e6));
  const accrual = accrueAboveHwm(equity, mark, proc.doubted ? 0 : FEE_BPS);
  await ratchet.accrue(accrual, mark, async () => {
    proc.fees.push(accrual.feeUsdg);
    await store.setAgentHwm(ACCOUNT, Number(accrual.newHwmUsdg) / 1e6);
  });
  await ratchet.equityRow(() =>
    store.addEquity(ACCOUNT, { mode: "live", ethWei: 0n, cashUsdg: Number(cash) / 1e6, vaultUsdg: 0, positionsUsdg: Number(equity - cash) / 1e6, equityUsdg: Number(equity) / 1e6 }),
  );
}

/** index.ts resolveStrandedOps: every current-epoch 'submitted' op the chain can answer for. */
async function resolvePass(opts: { failRowWrite?: boolean } = {}): Promise<void> {
  const stranded = await store.listSubmittedOps(ACCOUNT);
  const epoch = await store.getAgentEpoch(ACCOUNT);
  const mine = stranded.filter((r) => r.epoch === epoch);
  const resolved = await resolveSubmittedOps({
    chain,
    smartAccount: ACCOUNT as `0x${string}`,
    usdgToken: USDG,
    hashes: mine.map((r) => r.userOpHash),
    lookbackBlocks: 1_000n,
  });
  for (const r of resolved) {
    const row = mine.find((m) => m.userOpHash === r.userOpHash)!;
    const energyRow = isEnergyRow(row);
    let capitalBooked: boolean | null = null;
    if (energyRow && r.success) {
      if (r.usdgDelta6 === null) continue;
      const settled = await settleEnergyLanding(deps(), r.txHash as `0x${string}`);
      if (!settled.proceed) continue;
      capitalBooked = settled.settled === "booked" || settled.settled === "already";
    } else if (row.kind === "transfer" && r.success) {
      if (r.usdgDelta6 === null) continue;
      const settled = await settleTransferLanding(deps(), r.txHash as `0x${string}`);
      if (!settled.proceed) continue;
      capitalBooked = settled.settled === "booked" || settled.settled === "already";
    }
    const explains = settlementDelta({ success: r.success, receiptUsdgDelta6: r.usdgDelta6, capitalBooked });
    if (explains.queue && !proc.queued.has(r.userOpHash)) {
      proc.queued.add(r.userOpHash);
      proc.queue.push({ userOpHash: r.userOpHash, createdAt: row.createdAt, usdgDelta6: explains.usdgDelta6 });
    }
    if (opts.failRowWrite) continue; // the row write threw: the op stays 'submitted'
    await store.addTrade({
      agent_id: ACCOUNT,
      kind: row.kind,
      target: row.target,
      ...(energyRow ? { sell_token: row.sellToken, buy_token: row.buyToken } : {}),
      amount_usdg: r.success && r.attributed ? Number(r.notionalUsdg6) / 1e6 : row.amountUsdg,
      user_op_hash: r.userOpHash,
      tx_hash: r.txHash,
      status: r.success ? "landed" : "reverted",
    } as never);
  }
}

let n = 0;
/** A pre-broadcast row the executor never heard back about. Energy by default. */
async function stranded(over: Record<string, unknown> = {}): Promise<string> {
  const h = `0x${(++n).toString(16).padStart(64, "0")}`;
  await store.addTrade({
    agent_id: ACCOUNT,
    kind: "energy-buy",
    target: ENERGY_ROUTE_V1.router,
    sell_token: USDG,
    buy_token: MERRY,
    amount_usdg: 10,
    user_op_hash: h,
    status: "submitted",
    ...over,
  } as never);
  return h;
}
const swapRow = { kind: "swap", target: ACCOUNT, sell_token: USDG, buy_token: STOCK };
const transferRow = { kind: "transfer", target: OWNER, sell_token: null, buy_token: null };

/** A live agent with 100 USDG contributed on record, both peaks at 100, cash 100. */
async function freshAgent(): Promise<void> {
  for (const t of ["agents", "flows", "journal", "risk_periods", "trades", "equity", "fee_accruals"]) {
    try {
      exec(`DELETE FROM ${t}`);
    } catch {
      /* table may not exist yet */
    }
  }
  await store.ensureAgent(GRANT);
  await store.adjustAgentHwm(ACCOUNT, 100);
  exec("UPDATE agents SET mode = 'live' WHERE smart_account = ?", ACCOUNT);
  exec(
    `INSERT INTO risk_periods (id, agent_id, started_at, baseline_usdg, hwm_usdg, withdrawn_usdg, reason)
     VALUES (?, ?, ?, 100, 100, 0, 'owner-authorised')`,
    RISK_ID,
    ACCOUNT,
    1_700_000_000,
  );
  assert.equal(
    await store.addFlow({ agentId: ACCOUNT, direction: "in", amountUsdg: 100, source: "chain-log", txHash: `0x${"d0".repeat(32)}`, blockNumber: 8_000_000, logIndex: 1, mode: "live", chainId: 4663 }),
    true,
  );
  chainState.events.clear();
  chainState.receipts.clear();
  // The baseline was read a minute ago, before any op below was submitted.
  Object.assign(proc, { lastCash: 100n * U, since: nowSec() - 60, unattributed: false, writes: 0, snapshot: 0, queue: [], queued: new Set(), doubted: false, fees: [], startedSec: 0, anchor: null });
}

before(async () => {
  await store.initStore();
});
beforeEach(freshAgent);
after(() => {
  store.closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a stranded op is never inferred as capital", () => {
  it("A STRANDED ENERGY BUY: held while in flight (no fee, no peak, no equity row), then ONE energy-buy booking with ONE peak move and nothing inferred", async () => {
    const op = await stranded();
    // The purchase landed; the receipt wait timed out. Next tick: cash 90.
    const tx = lands(op, energyLogs(10n * U));
    assert.equal(await tick(90n * U), "hold");
    assert.equal(flowsBy("inferred"), 0, "nothing inferred while the op is in flight");
    assert.equal(await peak(), 100, "no peak moved on a guess");
    assert.equal(proc.lastCash, 100n * U, "the baseline is kept, so the interval stays open");
    assert.equal(equityRows(), 0, "a held tick writes no equity row — its cash is the restart's baseline");
    assert.equal(await tick(90n * U), "hold");

    await resolvePass();
    assert.equal(flowsBy("energy-buy"), 1);
    assert.equal(await peak(), 90);
    assert.equal(await riskPeak(), 90);
    assert.equal(one<{ s: string }>("SELECT status AS s FROM trades WHERE user_op_hash = ?", op).s, "landed");
    assert.equal(one<{ t: string }>("SELECT tx_hash AS t FROM trades WHERE user_op_hash = ?", op).t, tx);

    // The next tick folds the purchase's own −10 into the baseline: residual 0.
    assert.equal(await tick(90n * U), "infer");
    assert.equal(flowsBy("inferred"), 0, "the settlement explained exactly its own cash");
    assert.equal(await peak(), 90, "both peaks moved exactly once");
    assert.equal(await riskPeak(), 90);
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 90);
    assert.deepEqual(proc.fees, [], "no fee at any point");
    assert.equal(equityRows(), 1, "the closing tick writes its row");
  });

  it("A STRANDED SWAP: its cash leg is never booked as a withdrawal, and the peak never moves", async () => {
    const op = await stranded(swapRow);
    lands(op, swapLogs(10n * U));
    assert.equal(await tick(90n * U, 100n * U), "hold");
    await resolvePass();
    assert.equal(await tick(90n * U, 100n * U), "infer");
    assert.equal(flowsBy("inferred"), 0);
    assert.equal(await peak(), 100, "a trade is not capital");
  });

  it("an energy op whose receipt the resolver cannot read stays 'submitted' — inference stays held, nothing is booked twice", async () => {
    const op = await stranded();
    const tx = lands(op, null);
    assert.equal(await tick(90n * U), "hold");
    await resolvePass();
    assert.equal(flowsBy("energy-buy"), 0);
    assert.equal(one<{ s: string }>("SELECT status AS s FROM trades WHERE user_op_hash = ?", op).s, "submitted");
    assert.equal(await tick(90n * U), "hold", "still in flight: still held");
    chainState.receipts.set(tx, energyLogs(10n * U));
    await resolvePass();
    assert.equal(await tick(90n * U), "infer");
    assert.equal(flowsBy("energy-buy"), 1);
    assert.equal(flowsBy("inferred"), 0);
    assert.equal(await peak(), 90);
  });

  it("A GENUINE WITHDRAWAL WITH NOTHING IN FLIGHT IS STILL INFERRED — the narrow rule is unchanged", async () => {
    assert.equal(await tick(80n * U), "infer");
    assert.equal(flowsBy("inferred", "out"), 1);
    assert.equal(await peak(), 80);
  });

  it("A ROW THE RESOLVER CAN NO LONGER SETTLE DOES NOT SWITCH INFERENCE OFF FOR GOOD — past its window, or from an earlier epoch", async () => {
    await stranded();
    exec("UPDATE trades SET created_at = ? WHERE status = 'submitted'", nowSec() - STRANDED_RESOLVE_WINDOW_SEC - 60);
    assert.equal(await tick(80n * U), "infer", "a dropped op from over a day ago holds nothing");
    exec("DELETE FROM trades");
    await stranded();
    exec("UPDATE trades SET epoch = epoch - 1 WHERE status = 'submitted'");
    assert.equal(await tick(70n * U), "infer", "an earlier epoch's row is left for verify, not waited on");
  });
});

describe("what a settlement explains is ITS OWN cash — nothing else in the held interval", () => {
  it("DEPOSIT DURING A HOLD: booked as a deposit once the op settles — and never charged a fee, not even on the held ticks", async () => {
    const op = await stranded();
    lands(op, energyLogs(10n * U));
    assert.equal(await tick(90n * U), "hold");
    // The owner deposits 500 while the purchase is still unresolved.
    assert.equal(await tick(590n * U), "hold");
    assert.deepEqual(proc.fees, [], "equity 590 over a peak of 100 — and no fee: the held tick ratchets nothing");
    assert.equal(await peak(), 100, "and no peak moved over the unbooked deposit");

    await resolvePass();
    assert.equal(await tick(590n * U), "infer");
    assert.equal(flowsBy("energy-buy"), 1, "the purchase: booked once, by the resolver");
    assert.equal(flowsBy("inferred", "in"), 1, "the deposit: booked");
    assert.equal(inferredIn(), 500, "exactly the deposit — the purchase's −10 was explained by its settlement");
    assert.equal(flowsBy("inferred", "out"), 0);
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 590);
    assert.equal(await peak(), 590);
    assert.deepEqual(proc.fees, [], "no fee on the owner's own deposit");
    // And a real gain afterwards is still charged — against the right peak.
    assert.equal(await tick(590n * U, 600n * U), "infer");
    assert.equal(flowsBy("inferred"), 1, "a steady cash balance infers nothing");
    assert.deepEqual(proc.fees, [2n * U], "20% of the 10 the book actually made");
  });

  it("REVERTED OP + DEPOSIT: a revert moved nothing, so it explains nothing — the deposit is booked", async () => {
    const op = await stranded(swapRow);
    lands(op, [], false);
    assert.equal(await tick(300n * U), "hold", "a 200 deposit arrives while the op is in flight");
    await resolvePass();
    assert.equal(one<{ s: string }>("SELECT status AS s FROM trades WHERE user_op_hash = ?", op).s, "reverted");
    assert.equal(proc.queue.length, 0, "a revert queues nothing");
    assert.equal(await tick(300n * U), "infer");
    assert.equal(inferredIn(), 200);
    assert.equal(await peak(), 300);
  });

  it("DROPPED OP PAST THE WINDOW + DEPOSIT: the hold ends with the resolver's window and the deposit is booked", async () => {
    const op = await stranded(swapRow);
    // The bundler dropped it: the chain never answers for it.
    assert.equal(await tick(600n * U), "hold", "a 500 deposit, held behind the dropped op");
    await resolvePass();
    assert.equal(one<{ s: string }>("SELECT status AS s FROM trades WHERE user_op_hash = ?", op).s, "submitted", "never guessed at");
    assert.equal(await tick(600n * U), "hold");
    // A day and more later, the row is past the resolver's lookback.
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", nowSec() - STRANDED_RESOLVE_WINDOW_SEC - 60, op);
    assert.equal(await tick(600n * U), "infer");
    assert.equal(inferredIn(), 500);
    assert.equal(await peak(), 600);
    assert.deepEqual(proc.fees, [], "and never a fee on it");
  });

  it("A STRANDED TRANSFER HOME: booked ONCE, by the resolver, as the executor would have — 'transfer-intent', both peaks with it, nothing inferred", async () => {
    const op = await stranded(transferRow);
    const tx = lands(op, transferLogs(10n * U));
    assert.equal(await tick(90n * U), "hold");
    await resolvePass();
    assert.equal(flowsBy("transfer-intent", "out"), 1, "booked by the resolver");
    assert.equal(one<{ t: string }>("SELECT tx_hash AS t FROM flows WHERE source = 'transfer-intent'").t, tx);
    assert.equal(await tick(90n * U), "infer");
    assert.equal(flowsBy("inferred"), 0, "its settlement explained its own −10, so nothing is inferred beside it");
    assert.equal(await peak(), 90, "the lifetime peak followed the withdrawal");
    assert.equal(await riskPeak(), 90, "and the breaker's did too — 90 against 90 is no drawdown");
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 90);
    // A second pass (the row write failed, say) books nothing more.
    exec("UPDATE trades SET status = 'submitted' WHERE user_op_hash = ?", op);
    await resolvePass();
    assert.equal(flowsBy("transfer-intent", "out"), 1);
    assert.equal(await peak(), 90);
  });

  it("A STRANDED TRANSFER + A DEPOSIT IN THE SAME HOLD: the transfer is booked out, the deposit in — each exactly", async () => {
    const op = await stranded(transferRow);
    lands(op, transferLogs(10n * U));
    assert.equal(await tick(290n * U), "hold", "−10 home, +200 in");
    await resolvePass();
    assert.equal(await tick(290n * U), "infer");
    assert.equal(flowsBy("transfer-intent", "out"), 1);
    assert.equal(inferredIn(), 200);
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 290);
    assert.equal(await peak(), 290);
    assert.deepEqual(proc.fees, []);
  });

  it("A MOVEMENT NOBODY COULD READ IS NOT GUESSED: contributions go unknown, the interval closes uninferred", async () => {
    const op = await stranded(swapRow);
    lands(op, null);
    assert.equal(await tick(90n * U), "hold");
    await resolvePass();
    assert.equal(one<{ s: string }>("SELECT status AS s FROM trades WHERE user_op_hash = ?", op).s, "landed", "a trade still settles, releasing its charge");
    assert.equal(await tick(90n * U), "explained");
    assert.equal(proc.doubted, true, "contributions marked unknown");
    assert.equal(flowsBy("inferred"), 0, "and nothing booked on a guess");
    assert.equal(await peak(), 100);
    // The next interval is inferred normally again.
    assert.equal(await tick(80n * U), "infer");
    assert.equal(flowsBy("inferred", "out"), 1);
  });

  it("A TRADE RECORDED DURING THE HOLD still explains the interval when it ends — the known limitation, now only for trade intervals", async () => {
    const op = await stranded();
    lands(op, energyLogs(10n * U));
    assert.equal(await tick(90n * U), "hold");
    proc.writes += 1; // recordTrade(landed) for an ordinary fill during the hold
    assert.equal(await tick(90n * U), "hold", "the hold is asked BEFORE the write rule");
    await resolvePass();
    assert.equal(await tick(90n * U), "explained");
    assert.equal(flowsBy("energy-buy"), 1);
    assert.equal(flowsBy("inferred"), 0);
    assert.equal(await peak(), 90);
  });

  it("A RETRIED SETTLEMENT NEVER SHIFTS TWICE: a row write that failed leaves the op 'submitted', and the next pass queues nothing new", async () => {
    const op = await stranded(swapRow);
    lands(op, swapLogs(10n * U));
    assert.equal(await tick(90n * U, 100n * U), "hold");
    await resolvePass({ failRowWrite: true });
    assert.equal(await tick(90n * U, 100n * U), "hold", "still 'submitted'");
    await resolvePass();
    assert.equal(proc.queue.length, 0, "already queued once");
    assert.equal(await tick(90n * U, 100n * U), "infer");
    assert.equal(flowsBy("inferred"), 0, "shifted by −10 exactly once, so nothing is inferred");
  });

  it("AN OP CREATED BEFORE THE BASELINE WAS SET IS ALREADY IN IT: its late settlement shifts nothing", async () => {
    const op = await stranded(swapRow);
    // Past the window, so the look advanced over it; the baseline (cash 90) contains its −10.
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", nowSec() - STRANDED_RESOLVE_WINDOW_SEC - 60, op);
    Object.assign(proc, { lastCash: 90n * U, since: nowSec() });
    lands(op, swapLogs(10n * U));
    await resolvePass();
    assert.equal(proc.queue.length, 1);
    assert.equal(await tick(90n * U, 100n * U), "infer");
    assert.equal(flowsBy("inferred"), 0, "no +10 phantom deposit from a double shift");
  });
});

/**
 * ACROSS A RESTART. The last process wrote its final equity row (cash 100) at
 * T0, then sent an op at T0+10 and stopped before it heard back; the new one
 * starts at T0+20. Times are set explicitly so `since` is really exercised.
 */
describe("the first look after a restart follows the same rule", () => {
  const T0 = nowSec() - 3_600;
  /** The previous process's last reading, and the op it sent after it. */
  async function lastProcessSent(over: Record<string, unknown> = {}): Promise<string> {
    exec("DELETE FROM equity");
    await store.addEquity(ACCOUNT, { mode: "live", ethWei: 0n, cashUsdg: 100, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 100 });
    exec("UPDATE equity SET at = ?", T0);
    const op = await stranded(over);
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", T0 + 10, op);
    return op;
  }

  it("SELF-HOSTED RESTART WITH AN UNRESOLVED OP: nothing is judged while it is in flight, and it is booked ONCE when it settles", async () => {
    const op = await lastProcessSent();
    const tx = lands(op, null); // it landed (cash 90); the receipt will not come back yet
    restart(T0 + 20);
    await resolvePass(); // the arm's resolver cannot settle it
    assert.equal(await tick(90n * U), "hold", "the first look holds — no 'changed while the worker was stopped'");
    assert.equal(flowsBy("inferred"), 0);
    assert.equal(proc.lastCash, null, "the baseline stays open");
    assert.equal(await tick(90n * U), "hold");
    assert.equal(equityRows(), 1, "and the held ticks wrote no reading over the last process's");

    chainState.receipts.set(tx, energyLogs(10n * U));
    await resolvePass();
    assert.equal(await tick(90n * U), "infer");
    assert.equal(flowsBy("energy-buy"), 1, "booked once, by the resolver");
    assert.equal(flowsBy("inferred"), 0, "and never as downtime movement");
    assert.equal(await peak(), 90, "one peak move");
    assert.equal(await riskPeak(), 90);
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 90);
  });

  it("ARM-SETTLED OP + DOWNTIME DEPOSIT: the op explains its own −10, and the owner's +50 is booked (it used to be dropped with the whole delta)", async () => {
    const op = await lastProcessSent();
    lands(op, energyLogs(10n * U));
    restart(T0 + 20);
    await resolvePass(); // the arm's resolver settles it
    assert.equal(flowsBy("energy-buy"), 1);
    // Cash: 100 − 10 (the purchase) + 50 (deposited while the worker was down).
    assert.equal(await tick(140n * U), "infer");
    assert.equal(inferredIn(), 50, "exactly the deposit");
    assert.equal(flowsBy("inferred", "out"), 0);
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 140);
    assert.equal(await peak(), 140);
    assert.deepEqual(proc.fees, [], "no fee on the owner's own deposit");
  });

  it("A REVERTED ARM-SETTLED OP + DOWNTIME DEPOSIT: the revert moved nothing and masks nothing — the deposit is booked", async () => {
    const op = await lastProcessSent({ ...swapRow });
    lands(op, [], false);
    restart(T0 + 20);
    await resolvePass();
    assert.equal(await tick(150n * U), "infer");
    assert.equal(inferredIn(), 50);
  });

  it("A STRANDED OP THE LAST PROCESS'S RESOLVER SETTLED BEFORE IT STOPPED is an earlier write: explained, never booked a second time", async () => {
    const op = await lastProcessSent();
    lands(op, energyLogs(10n * U));
    await resolvePass(); // the OLD process's resolver books it and settles the row…
    assert.equal(flowsBy("energy-buy"), 1);
    restart(T0 + 20); // …and it stops before its next look
    assert.equal(await tick(90n * U), "explained");
    assert.equal(flowsBy("inferred"), 0, "its −10 is not downtime movement");
    assert.equal(await peak(), 90, "one peak move");
  });

  it("A FILL THE LAST PROCESS RECORDED AFTER ITS FINAL READING is an earlier write too — its cash leg is not a withdrawal", async () => {
    const h = await lastProcessSent({ ...swapRow });
    exec("UPDATE trades SET status = 'landed' WHERE user_op_hash = ?", h); // recordTrade(landed), then the process stopped
    restart(T0 + 20);
    assert.equal(await tick(90n * U, 100n * U), "explained");
    assert.equal(flowsBy("inferred"), 0);
    assert.equal(await peak(), 100);
  });

  it("A DOWNTIME WITHDRAWAL WITH NOTHING ELSE IN THE INTERVAL is still booked — the self-hosted look is unchanged there", async () => {
    await lastProcessSent({ ...swapRow, status: "reverted" });
    restart(T0 + 20);
    assert.equal(await tick(70n * U), "infer");
    assert.equal(flowsBy("inferred", "out"), 1);
    assert.equal(await peak(), 70);
  });

  it("HOSTED RESUME: an arm-settled purchase explains its own drift (resume-clean, nothing doubted); an unresolved one holds the look", async () => {
    const op = await lastProcessSent();
    lands(op, energyLogs(10n * U));
    restart(T0 + 20, { cashUsdg: 100n * U, observedAt: T0 });
    await resolvePass();
    assert.equal(await tick(90n * U), "resume-clean", "a −10 drift the settlement explains is no drift");
    assert.equal(proc.doubted, false, "contributions stay known");
    assert.equal(flowsBy("inferred"), 0);

    // And with the op still unresolved at arm, nothing is judged at all.
    await freshAgent();
    const op2 = await lastProcessSent();
    lands(op2, null);
    restart(T0 + 20, { cashUsdg: 100n * U, observedAt: T0 });
    await resolvePass();
    assert.equal(await tick(90n * U), "hold");
    assert.equal(proc.doubted, false, "not doubted on a stranded op's movement");
  });
});
