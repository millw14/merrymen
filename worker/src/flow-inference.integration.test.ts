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
 * AND THE BREAKER, which a held look must not switch off: `ratchet` observes
 * the breaker's peaks — the risk period's in the ledger, and the in-memory
 * lift above the lifetime mark (`proc.lift`) — with the held observation
 * (flow-inference.ts heldBreakerObservationUsdg), and `buyVerdict` asks the
 * real checkPolicy what index.ts's executor would, against the same peak.
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
const { attributeSettlements, expectedCashUsdg, heldBreakerObservationUsdg, lookAtCash, opsHoldInference, settlementDelta, STRANDED_RESOLVE_WINDOW_SEC, wroteSince } = await import("./flow-inference");
const { planFirstObservation } = await import("./bootstrap-state");
const { addressTopic, findDroppedOps, resolveSubmittedOps } = await import("./inflight-reconcile");
const { tickPlan, tickRatchets } = await import("./command-wake");
const { accrueAboveHwm } = await import("./fees");
const { checkPolicy } = await import("./policy");
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
/** Rows a cash baseline may be taken from: every mark not flagged as taken while the flows were held. */
const readings = () => Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM equity WHERE agent_id = ? AND COALESCE(flows_held, 0) = 0", ACCOUNT).n);
const nowSec = () => Math.floor(Date.now() / 1000);

// ── the chain ─────────────────────────────────────────────────────────────

const EP_ABI = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
function opLog(userOpHash: string, success: boolean, txHash: string, nonce = 1n): RawLog {
  const topics = encodeEventTopics({
    abi: EP_ABI,
    eventName: "UserOperationEvent",
    args: { userOpHash: userOpHash as Hex, sender: ACCOUNT, paymaster: "0x0000000000000000000000000000000000000000" },
  });
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
    [nonce, success, 0n, 0n],
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
  /** `nonce`: the one the op spent — its recorded `user_op_nonce` when the harness knows it. */
  events: new Map<string, { success: boolean; txHash: string; nonce: bigint }>(),
  receipts: new Map<string, readonly ReceiptLog[] | null>(),
};
const chain: ReconcileChain = {
  async getBlockNumber() {
    return 9_000_100n;
  },
  async getLogs(a) {
    const want = String(a.topics[1] ?? "").toLowerCase();
    const e = chainState.events.get(want);
    return e ? [opLog(want, e.success, e.txHash, e.nonce)] : [];
  },
  async getReceiptLogs(txHash) {
    const r = chainState.receipts.get(txHash.toLowerCase());
    return r === undefined ? null : r;
  },
};
/** The op landed (or reverted) on-chain; its receipt is readable unless `receipt` is null. */
function lands(op: string, receipt: readonly ReceiptLog[] | null, success = true): string {
  const tx = `0x${(++n).toString(16).padStart(64, "e")}`;
  const recorded = one<{ v: string | null } | undefined>("SELECT user_op_nonce AS v FROM trades WHERE user_op_hash = ?", op)?.v;
  chainState.events.set(op, { success, txHash: tx, nonce: recorded ? BigInt(recorded) : 1n });
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
  /** index.ts heldBreakerLiftUsdg: what held looks saw above the lifetime mark. */
  lift: 0n,
};
/** The process stops and a new one starts: everything in memory is gone; the ledger stays. */
function restart(at = nowSec(), anchor: { cashUsdg: bigint; observedAt: number } | null = null): void {
  Object.assign(proc, { lastCash: null, since: null, unattributed: false, writes: 0, snapshot: 0, queue: [], queued: new Set(), doubted: false, fees: [], startedSec: at, anchor, lift: 0n });
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
  const readAt = nowSec(); // index.ts cashReadAtSec: the balance read, before the ledger's
  const listedAt = nowSec();
  const opsInFlight = opsHoldInference(await store.listSubmittedOps(ACCOUNT), {
    epoch: await store.getAgentEpoch(ACCOUNT),
    nowSec: listedAt,
  });
  if (proc.lastCash === null) return firstLook(cash, equity, readAt, listedAt, opsInFlight);
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
  await ratchet(cash, equity, held, readAt);
  return l.verdict.action;
}

/**
 * index.ts reconcileFlows' FIRST OBSERVATION with the scan off: the hold, the
 * durable reads, then the self-hosted look against the last durable reading
 * (legacy-local) or the hosted resume's drift against its anchor.
 */
async function firstLook(cash: bigint, equity: bigint, readAt: number, listedAt: number, opsInFlight: boolean): Promise<"hold" | "explained" | "infer" | "resume-clean" | "resume-with-drift"> {
  if (opsInFlight) {
    await ratchet(cash, equity, true, readAt);
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
  await ratchet(cash, equity, false, readAt);
  return out;
}

/**
 * index.ts heldCashBaseline: the cash a held tick expects — the kept baseline
 * with the queue folded in, or, for a first look still holding, the reading
 * that look will judge against (the anchor hosted, the last durable reading
 * self-hosted).
 */
async function heldCashBaseline(): Promise<bigint | null> {
  if (proc.lastCash !== null) return expectedCashUsdg({ cashUsdg: proc.lastCash, since: proc.since }, proc.queue);
  if (proc.anchor) return expectedCashUsdg({ cashUsdg: proc.anchor.cashUsdg, since: proc.anchor.observedAt }, proc.queue);
  const prior = await store.lastKnownCashReading(ACCOUNT);
  return expectedCashUsdg(prior === null ? null : { cashUsdg: BigInt(Math.round(prior.cashUsdg * 1e6)), since: prior.at }, proc.queue);
}

/**
 * THE RATCHET — the live branch of tick(), after reconcileFlowsOrRetry: the
 * held observation, the risk period's observation, the fee and the mark, the
 * breaker's lift, and the (flagged, when held) equity row.
 */
async function ratchet(cash: bigint, equity: bigint, held: boolean, readAt: number): Promise<void> {
  const ratchet = tickRatchets(tickPlan("regular"), {
    incomplete: false,
    curveMarked: 0,
    held,
    ...(held
      ? { breakerObservationUsdg: heldBreakerObservationUsdg({ equityUsdg: equity, cashUsdg: cash, expectedCashUsdg: await heldCashBaseline() }) }
      : {}),
  });
  await ratchet.riskPeak(Number(equity) / 1e6, (observe) => store.getRiskPeriodPeak(ACCOUNT, observe));
  const mark = BigInt(Math.round((await peak()) * 1e6));
  const accrual = accrueAboveHwm(equity, mark, proc.doubted ? 0 : FEE_BPS);
  const after = await ratchet.accrue(accrual, mark, async () => {
    proc.fees.push(accrual.feeUsdg);
    await store.setAgentHwm(ACCOUNT, Number(accrual.newHwmUsdg) / 1e6);
  });
  proc.lift = ratchet.breakerLift(proc.lift, mark, after);
  await ratchet.equityRow(({ flowsHeld }) =>
    store.addEquity(ACCOUNT, { mode: "live", ethWei: 0n, cashUsdg: Number(cash) / 1e6, vaultUsdg: 0, positionsUsdg: Number(equity - cash) / 1e6, equityUsdg: Number(equity) / 1e6, flowsHeld, cashReadAt: readAt }),
  );
}

/**
 * THE PEAK checkPolicy's drawdown breaker judges a live intent against —
 * index.ts's executor state: the risk period's, or with none standing, the
 * lifetime mark plus the held lift.
 */
async function breakerPeak(): Promise<number> {
  return (await riskPeak()) ?? (await peak()) + Number(proc.lift) / 1e6;
}
const LIMITS = {
  perTradeUsdg: 1_000n * U,
  dailyUsdg: 10_000n * U,
  allowedTargets: [PAIR_A],
  allowedAssets: [USDG, STOCK],
  maxDrawdownBps: 500,
  expiresAt: 2_000_000_000,
  maxOpsPerDay: 1_000,
} as never;
/** A NON-EXIT BUY (USDG into stock), judged by the real checkPolicy at `equity`. */
async function buyVerdict(equity: bigint): Promise<{ ok: boolean; rule?: string }> {
  const intent = { kind: "swap", target: PAIR_A, sellToken: USDG, buyToken: STOCK, sellAmountRaw: 1n * U, notionalUsdg: 1n * U } as never;
  return checkPolicy(intent, LIMITS, {
    highWaterMarkUsdg: BigInt(Math.round((await breakerPeak()) * 1e6)),
    equityUsdg: equity,
    nowSec: nowSec(),
    spentTodayUsdg: 0n,
    opsToday: 0,
  }) as { ok: boolean; rule?: string };
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
  // The write-off: an unsettled op whose recorded nonce another op of ours
  // spent on-chain can never land — 'dropped', nothing queued, nothing booked.
  const suspects: { userOpHash: string; nonce: bigint; rivals: string[] }[] = [];
  for (const m of mine.filter((m) => m.nonce !== undefined && !resolved.some((r) => r.userOpHash === m.userOpHash))) {
    const rivals = await store.opsSignedWithNonce(ACCOUNT, m.nonce!, m.userOpHash);
    if (rivals.length > 0) suspects.push({ userOpHash: m.userOpHash, nonce: m.nonce!, rivals });
  }
  for (const d of await findDroppedOps({ chain, smartAccount: ACCOUNT as `0x${string}`, stranded: suspects, lookbackBlocks: 1_000n })) {
    const row = mine.find((m) => m.userOpHash === d.userOpHash)!;
    await store.addTrade({
      agent_id: ACCOUNT,
      kind: row.kind,
      target: row.target,
      ...(row.sellToken ? { sell_token: row.sellToken } : {}),
      ...(row.buyToken ? { buy_token: row.buyToken } : {}),
      amount_usdg: row.amountUsdg,
      user_op_hash: d.userOpHash,
      status: "dropped",
      reject_rule: "dropped: a later op used its nonce (resolved)",
    } as never);
  }
}

let n = 0;
/** A Kernel-shaped nonce: a 24-byte key over an 8-byte sequence, as the executor records it. */
const nonceAt = (seq: number) => ((0x0102n << 240n) | BigInt(seq)).toString();
/**
 * A pre-broadcast row the executor never heard back about. Energy by default,
 * signed with a nonce of its own — so no two rows here share one unless a test
 * says so (`user_op_nonce`).
 */
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
    user_op_nonce: nonceAt(1_000 + n),
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
  Object.assign(proc, { lastCash: 100n * U, since: nowSec() - 60, unattributed: false, writes: 0, snapshot: 0, queue: [], queued: new Set(), doubted: false, fees: [], startedSec: 0, anchor: null, lift: 0n });
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
  it("A STRANDED ENERGY BUY: held while in flight (no fee, no lifetime peak, a FLAGGED equity row), then ONE energy-buy booking with ONE peak move and nothing inferred", async () => {
    const op = await stranded();
    // The purchase landed; the receipt wait timed out. Next tick: cash 90.
    const tx = lands(op, energyLogs(10n * U));
    assert.equal(await tick(90n * U), "hold");
    assert.equal(flowsBy("inferred"), 0, "nothing inferred while the op is in flight");
    assert.equal(await peak(), 100, "no peak moved on a guess");
    assert.equal(proc.lastCash, 100n * U, "the baseline is kept, so the interval stays open");
    assert.equal(equityRows(), 1, "a held tick writes its valuation…");
    assert.equal(readings(), 0, "…flagged, so its cash is never a restart's baseline");
    assert.equal(await store.lastKnownCashReading(ACCOUNT), null, "the restart baseline skips it");
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
    assert.equal(readings(), 1, "the closing tick writes the first row a baseline may be taken from");
    assert.equal(equityRows(), 3);
    assert.deepEqual(await store.lastKnownCashReading(ACCOUNT).then((r) => r?.cashUsdg), 90);
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
    assert.deepEqual(proc.fees, [], "equity 590 over a peak of 100 — and no fee: the held tick accrues none");
    assert.equal(await peak(), 100, "and no peak moved over the unbooked deposit");
    assert.equal(await riskPeak(), 100, "not even the breaker's, which observes a held tick: the deposit's cash is taken out");

    await resolvePass();
    assert.equal(await tick(590n * U), "infer");
    assert.equal(flowsBy("energy-buy"), 1, "the purchase: booked once, by the resolver");
    assert.equal(flowsBy("inferred", "in"), 1, "the deposit: booked");
    assert.equal(inferredIn(), 500, "exactly the deposit — the purchase's −10 was explained by its settlement");
    assert.equal(flowsBy("inferred", "out"), 0);
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 590);
    assert.equal(await peak(), 590);
    assert.equal(await riskPeak(), 590, "the deposit reached the breaker's peak once, by its booking");
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
 * A DROPPED userOp HOLDS ONLY UNTIL IT PROVABLY CANNOT LAND. The bundler
 * dropped it — evicted it, or refused it at the send edge, which the executor
 * must report as unresolved — so the chain never answers for it, and it used
 * to hold every look for the resolver's whole window: 26 hours in which a
 * deposit was not booked. A nonce is spent once, and the next op the agent
 * signs after a drop is signed with the same one; when THAT op executes, the
 * dropped one can never be included (inflight-reconcile.ts findDroppedOps),
 * and the next resolver pass writes it off.
 */
describe("a dropped userOp holds inference only until it provably cannot land", () => {
  const SHARED = nonceAt(7);
  /** Our op B, signed with `nonce`, landed and RECORDED by the executor `ago` seconds back. */
  async function recordedRival(nonce: string, ago: number, amount = 10): Promise<string> {
    const h = `0x${(++n).toString(16).padStart(64, "0")}`;
    const tx = `0x${(++n).toString(16).padStart(64, "f")}`;
    await store.addTrade({ agent_id: ACCOUNT, ...swapRow, amount_usdg: amount, user_op_hash: h, user_op_nonce: nonce, tx_hash: tx, status: "landed" } as never);
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", nowSec() - ago, h);
    chainState.events.set(h, { success: true, txHash: tx, nonce: BigInt(nonce) });
    return h;
  }
  const statusOf = (op: string) => one<{ s: string }>("SELECT status AS s FROM trades WHERE user_op_hash = ?", op).s;

  it("REFUSED AT THE SEND EDGE ON A STALE NONCE: the next pass writes it off, the hold ends, and the deposit made behind it is booked — a fee on none of it", async () => {
    // B landed and was recorded before the baseline; A was then signed on a
    // lagging node's nonce — B's — and the bundler refused it (AA25), which the
    // send edge can only call unresolved.
    await recordedRival(SHARED, 120);
    const op = await stranded({ ...swapRow, amount_usdg: 25, user_op_nonce: SHARED });
    assert.equal(await store.getSpentTodayUsdg(ACCOUNT, "live"), 35, "while it is 'submitted' it charges the live rail");
    assert.equal(await store.getOpsToday(ACCOUNT, "live"), 2);
    assert.equal(await tick(600n * U), "hold", "the owner deposits 500 behind it");

    await resolvePass();
    assert.equal(statusOf(op), "dropped", "written off on the chain's proof, one pass later — not 26 hours");
    assert.deepEqual(await store.listSubmittedOps(ACCOUNT), [], "no longer in flight, so nothing holds on it");
    assert.equal(proc.queue.length, 0, "it moved nothing, so it explains nothing");
    assert.equal(await store.getSpentTodayUsdg(ACCOUNT, "live"), 10, "its spend is released — only B's stands");
    assert.equal(await store.getOpsToday(ACCOUNT, "live"), 1);

    assert.equal(await tick(600n * U), "infer");
    assert.equal(inferredIn(), 500, "the deposit is booked");
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 600);
    assert.equal(await peak(), 600);
    assert.equal(await riskPeak(), 600);
    assert.deepEqual(proc.fees, [], "and no fee on the owner's own money, held or after");
  });

  it("A RIVAL THAT WAS STRANDED TOO: one pass settles it (its own −10) and writes the dropped one off — only the deposit is inferred", async () => {
    // A was accepted and evicted; B, signed with the same nonce, replaced it
    // and landed — and B's receipt wait timed out as well.
    const op = await stranded({ ...swapRow, user_op_nonce: SHARED });
    const rival = await stranded({ ...swapRow, user_op_nonce: SHARED });
    lands(rival, swapLogs(10n * U));
    assert.equal(await tick(590n * U, 600n * U), "hold", "B's −10 and a 500 deposit, both behind the in-flight ops");
    await resolvePass();
    assert.equal(statusOf(rival), "landed");
    assert.equal(statusOf(op), "dropped");
    assert.equal(await tick(590n * U, 600n * U), "infer");
    assert.equal(inferredIn(), 500, "B's settlement explained its own −10; the rest is the deposit");
    assert.equal(flowsBy("inferred", "out"), 0);
    assert.equal(await peak(), 600);
    assert.deepEqual(proc.fees, []);
  });

  it("AN OP THAT COULD STILL LAND KEEPS HOLDING: no op of ours has spent its nonce — none recorded, one still pending, or one that spent another", async () => {
    const op = await stranded({ ...swapRow, user_op_nonce: SHARED });
    assert.equal(await tick(600n * U), "hold");
    await resolvePass();
    assert.equal(statusOf(op), "submitted", "nothing has spent its nonce: it may still be included");
    assert.equal(await tick(600n * U), "hold");
    // A replacement signed with the same nonce, not executed (yet).
    const pending = await stranded({ ...swapRow, user_op_nonce: SHARED });
    await resolvePass();
    assert.equal(statusOf(op), "submitted", "a rival the chain has not executed proves nothing");
    assert.equal(statusOf(pending), "submitted");
    assert.equal(await tick(600n * U), "hold");
    // A recorded rival whose event spent a DIFFERENT nonce: the chain's figure decides.
    const h = await recordedRival(SHARED, 30);
    chainState.events.set(h, { ...chainState.events.get(h)!, nonce: BigInt(nonceAt(8)) });
    await resolvePass();
    assert.equal(statusOf(op), "submitted");
    assert.equal(await tick(600n * U), "hold");
    assert.equal(inferredIn(), 0, "and nothing is inferred while it holds");
  });

  it("A ROW WITH NO RECORDED NONCE (written before the column) is never judged — it ages out of the window as before", async () => {
    const op = await stranded({ ...swapRow, user_op_nonce: null });
    await recordedRival(SHARED, 30);
    await resolvePass();
    assert.equal(statusOf(op), "submitted");
    assert.equal(await tick(600n * U), "hold");
  });

  it("THE RIVAL THE EXECUTOR RECORDED DURING THE HOLD ends it one pass later — and its write then explains the interval (the known trade-interval limitation, R2-ACC rule 3), no longer 26 hours on", async () => {
    const op = await stranded({ ...swapRow, user_op_nonce: SHARED });
    assert.equal(await tick(100n * U), "hold");
    await recordedRival(SHARED, 0);
    proc.writes += 1; // recordTrade(landed) for B, during the hold
    assert.equal(await tick(90n * U, 100n * U), "hold");
    await resolvePass();
    assert.equal(statusOf(op), "dropped");
    assert.equal(await tick(90n * U, 100n * U), "explained", "the hold is over; B's fill explains its own interval");
    assert.equal(flowsBy("inferred"), 0, "B's cash leg is never booked as a withdrawal");
    assert.equal(await peak(), 100);
  });

  it("A SELF-HOSTED RESTART: the arm's resolver writes the dropped op off, and the first look judges the downtime", async () => {
    const T0 = nowSec() - 3_600;
    exec("DELETE FROM equity");
    await store.addEquity(ACCOUNT, { mode: "live", ethWei: 0n, cashUsdg: 100, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 100 });
    exec("UPDATE equity SET at = ?", T0);
    await recordedRival(SHARED, 3_700); // landed before the reading
    const op = await stranded({ ...swapRow, user_op_nonce: SHARED });
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", T0 + 10, op);
    restart(T0 + 20);
    await resolvePass(); // reconcileInFlightAtArm's resolveStrandedOps
    assert.equal(statusOf(op), "dropped");
    assert.equal(await tick(150n * U), "infer", "no hold on the first look");
    assert.equal(inferredIn(), 50, "the downtime deposit is booked");
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
    assert.equal(equityRows(), 3, "the held ticks wrote their valuations…");
    assert.equal(readings(), 1, "…flagged, over the last process's reading");
    assert.deepEqual(await store.lastKnownCashReading(ACCOUNT), { cashUsdg: 100, at: T0 }, "which is still the restart's baseline");

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

/**
 * THE RESTART'S `since` IS WHEN THE READING'S CASH WAS READ, not when its row
 * was inserted. The last process's final tick read the balance (cash 100) and
 * listed the ledger at T0−1 with nothing in flight, so the look settled. A
 * Telegram transfer home of 10 then joined the intent chain mid-tick (chat
 * trades can), its pre-broadcast row stamped T0−1; the tick wrote its equity
 * row — the cash it read BEFORE the transfer — and the INSERT landed at T0.
 * Stamped by the insert, the transfer read as "already in the reading": its
 * settlement was skipped, it was no write either, and its −10 was inferred a
 * second time — contributions 80 for a book holding 90 of the owner's money,
 * and 2 USDG of fee charged on the owner's own 10.
 */
describe("a restart's reading is dated by when its cash was read", () => {
  const T0 = nowSec() - 3_600;
  /** The last process's final row: cash 100 read at T0−1, inserted at T0; the transfer created in between. */
  async function midTickTransfer(): Promise<string> {
    exec("DELETE FROM equity");
    const op = await stranded(transferRow);
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", T0 - 1, op);
    await store.addEquity(ACCOUNT, { mode: "live", ethWei: 0n, cashUsdg: 100, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 100, cashReadAt: T0 - 1 });
    exec("UPDATE equity SET at = ?", T0);
    return op;
  }

  it("A STRANDED TRANSFER SENT MID-TICK (created at the row's `at` − 1) is booked ONCE after a self-hosted restart — by the resolver, never again as downtime movement", async () => {
    const op = await midTickTransfer();
    lands(op, transferLogs(10n * U)); // it landed; the process stopped before the receipt came back
    restart(T0 + 20);
    await resolvePass(); // the arm's resolver books it as transfer-intent and queues its −10
    assert.equal(flowsBy("transfer-intent", "out"), 1);
    assert.equal(await peak(), 90);
    assert.equal(await tick(90n * U), "infer", "the settlement is folded into the reading, so the residual is 0");
    assert.equal(flowsBy("inferred"), 0, "its −10 is not inferred a second time");
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 90);
    assert.equal(await peak(), 90);
    assert.deepEqual(proc.fees, [], "and no fee on the owner's own 10");
    // Because the reading is dated by its read (T0−1), not its insert (T0).
    exec("DELETE FROM equity WHERE at <> ?", T0);
    assert.deepEqual(await store.lastKnownCashReading(ACCOUNT), { cashUsdg: 100, at: T0 - 1 });
  });

  it("THE SAME WINDOW, EXECUTOR'S PATH: a transfer it booked mid-tick is a write after the reading, so the downtime is explained, not inferred", async () => {
    const op = await midTickTransfer();
    const tx = `0x${"ab".repeat(32)}`;
    // recordTrade(landed) + addFlow('transfer-intent') + adjustAgentHwm(−10), as index.ts's transfer arm does.
    exec("UPDATE trades SET status = 'landed', tx_hash = ? WHERE user_op_hash = ?", tx, op);
    assert.equal(await store.addFlow({ agentId: ACCOUNT, direction: "out", amountUsdg: 10, source: "transfer-intent", txHash: tx, mode: "live" }), true);
    await store.adjustAgentHwm(ACCOUNT, -10);
    restart(T0 + 20); // stopped before the next tick's row
    assert.equal(await tick(90n * U), "explained", "landedOpsBetween from the read finds the row");
    assert.equal(flowsBy("transfer-intent", "out"), 1);
    assert.equal(flowsBy("inferred"), 0);
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 90);
  });

  it("control: a row written before `cash_read_at` existed is dated by its insert, as before — an op in its own second still shifts once", async () => {
    exec("DELETE FROM equity");
    const op = await stranded(transferRow);
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", T0, op);
    await store.addEquity(ACCOUNT, { mode: "live", ethWei: 0n, cashUsdg: 100, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 100 });
    exec("UPDATE equity SET at = ?", T0);
    assert.deepEqual(await store.lastKnownCashReading(ACCOUNT), { cashUsdg: 100, at: T0 });
    lands(op, transferLogs(10n * U));
    restart(T0 + 20);
    await resolvePass();
    assert.equal(await tick(90n * U), "infer");
    assert.equal(flowsBy("inferred"), 0);
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 90);
  });

  it("the tick stamps its row with the read: a later restart's `since` is that, not the insert", async () => {
    exec("DELETE FROM equity");
    const before = nowSec();
    await tick(100n * U);
    const r = await store.lastKnownCashReading(ACCOUNT);
    assert.ok(r !== null && r.at >= before && r.at <= nowSec());
    const row = one<{ cash_read_at: number | null }>("SELECT cash_read_at FROM equity WHERE agent_id = ?", ACCOUNT);
    assert.equal(row.cash_read_at, r!.at);
  });
});

/**
 * A HELD LOOK MUST NOT SWITCH THE DRAWDOWN BREAKER OFF. A userOp the bundler
 * dropped is never found, so its row holds every look for the resolver's whole
 * window (26 h) while the agent keeps trading. The held tick used to freeze the
 * breaker's peak with the fee's: a book that ran 100 → 150 → 110 was judged at
 * 110 against 100 — no drawdown — and every non-exit buy went out for a day.
 */
describe("the local restart baseline stays in the real accounting book", () => {
  it("ignores later paper and unknown-mode marks without losing the real cash read", async () => {
    exec("DELETE FROM equity");
    const baselineAt = nowSec() - 10;
    for (const [mode, cash, at] of [["live", 100, baselineAt], ["paper", 1_000, baselineAt + 1], [null, 200, baselineAt + 2]] as const) {
      await store.addEquity(ACCOUNT, { mode: mode ?? "live", ethWei: 0n, cashUsdg: cash, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: cash });
      exec("UPDATE equity SET at = ?, mode = ? WHERE id = (SELECT MAX(id) FROM equity)", at, mode);
    }
    assert.deepEqual(await store.lastKnownCashReading(ACCOUNT), { cashUsdg: 100, at: baselineAt });
  });

  it("paper-only marks are not a known zero balance", async () => {
    exec("DELETE FROM equity");
    await store.addEquity(ACCOUNT, { mode: "paper", ethWei: 0n, cashUsdg: 1_000, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 1_000 });
    assert.equal(await store.lastKnownCashReading(ACCOUNT), null);
  });
});

describe("a held look does not switch the drawdown breaker off", () => {
  /** A dropped swap, 25 h old (inside the window); the agent buys 50 of stock and it runs 100 → 150 → 110. */
  async function droppedOpRun(): Promise<string[]> {
    const op = await stranded(swapRow);
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", nowSec() - 25 * 3600, op);
    proc.writes += 1; // recordTrade(landed) for the buy — a hold stops no trade
    const verdicts = [await tick(50n * U, 100n * U), await tick(50n * U, 150n * U)];
    await resolvePass(); // the chain never answers for a dropped op
    verdicts.push(await tick(50n * U, 110n * U));
    return verdicts;
  }

  it("WITH A RISK PERIOD: the breaker's peak observes the held 150, so 150 → 110 trips the 5% limit — and still no fee, no lifetime peak", async () => {
    assert.deepEqual(await droppedOpRun(), ["hold", "hold", "hold"]);
    assert.equal(await riskPeak(), 150, "the risk period's peak followed the held ticks");
    const v = await buyVerdict(110n * U);
    assert.equal(v.ok, false, "a 26.7% drawdown refuses a non-exit buy");
    assert.equal(v.rule, "drawdown-breaker");
    assert.deepEqual(proc.fees, [], "no fee accrued on any held tick");
    assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM fee_accruals").n), 0);
    assert.equal(await peak(), 100, "the lifetime mark — the fee's — did not move");
    assert.equal(equityRows(), 3, "every held tick wrote its valuation (no 26-hour gap)…");
    assert.equal(readings(), 0, "…flagged, so none of them is a cash baseline");
  });

  it("WITH NO RISK PERIOD: the lifetime mark stays at 100 and the breaker's in-memory lift carries its peak to 150", async () => {
    exec("DELETE FROM risk_periods");
    assert.deepEqual(await droppedOpRun(), ["hold", "hold", "hold"]);
    assert.equal(await riskPeak(), null);
    assert.equal(await peak(), 100, "the fee's mark is frozen");
    assert.equal(proc.lift, 50n * U, "the breaker's peak is 100 + 50");
    assert.equal((await buyVerdict(110n * U)).rule, "drawdown-breaker");
    assert.deepEqual(proc.fees, []);
  });

  it("control: the same run with nothing in flight — the same breaker, and the fee charged at the 150 peak", async () => {
    proc.writes += 1;
    await tick(50n * U, 100n * U);
    await tick(50n * U, 150n * U);
    await tick(50n * U, 110n * U);
    assert.equal(await riskPeak(), 150);
    assert.equal((await buyVerdict(110n * U)).rule, "drawdown-breaker");
    assert.deepEqual(proc.fees, [10n * U]);
  });

  it("THE OBSERVATION CANNOT HOLD AN UNBOOKED DEPOSIT: a 500 deposit in the hold moves no breaker peak, and once booked is counted once", async () => {
    const op = await stranded(swapRow);
    assert.equal(await tick(600n * U), "hold", "500 deposited behind the dropped op");
    assert.equal(await riskPeak(), 100, "cash above the expected 100 is taken back out of the observation");
    assert.equal(proc.lift, 0n);
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", nowSec() - STRANDED_RESOLVE_WINDOW_SEC - 60, op);
    assert.equal(await tick(600n * U), "infer");
    assert.equal(inferredIn(), 500);
    assert.equal(await riskPeak(), 600, "100 + the booked 500 — not 600 observed and 500 added on top");
    assert.equal(await peak(), 600);
    assert.equal((await buyVerdict(600n * U)).ok, true, "so no phantom drawdown halts the book");
    assert.deepEqual(proc.fees, []);
  });

  it("A SELL IN THE HOLD only lowers the observation: its cash is above the baseline, so the peak errs low, never high", async () => {
    const op = await stranded(swapRow);
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", nowSec() - 3600, op);
    proc.writes += 1;
    assert.equal(await tick(20n * U, 130n * U), "hold", "bought 80 of stock, now worth 110");
    assert.equal(await riskPeak(), 130);
    proc.writes += 1;
    assert.equal(await tick(140n * U, 140n * U), "hold", "sold it all for 120");
    assert.equal(await riskPeak(), 130, "140 less the 40 above the 100 baseline: 100 — the peak stays");
  });

  it("WHEN THE HOLD ENDS the lift is absorbed as the mark rises past it, and the gain is charged once, whole", async () => {
    exec("DELETE FROM risk_periods");
    const op = await stranded(swapRow);
    proc.writes += 1;
    await tick(50n * U, 150n * U);
    assert.equal(proc.lift, 50n * U);
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", nowSec() - STRANDED_RESOLVE_WINDOW_SEC - 60, op);
    assert.equal(await tick(50n * U, 160n * U), "explained");
    assert.deepEqual(proc.fees, [12n * U], "20% of 160 − 100: the held 50 is charged once the look closes, not lost");
    assert.equal(await peak(), 160);
    assert.equal(proc.lift, 0n, "the mark now stands above the held peak");
  });

  it("A FIRST LOOK STILL HOLDING AFTER A RESTART observes against the last durable reading — so the breaker trips there too", async () => {
    const T0 = nowSec() - 3_600;
    exec("DELETE FROM equity");
    await store.addEquity(ACCOUNT, { mode: "live", ethWei: 0n, cashUsdg: 100, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 100 });
    exec("UPDATE equity SET at = ?", T0);
    const op = await stranded(swapRow);
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", T0 + 10, op);
    restart(T0 + 20);
    await resolvePass();
    assert.equal(await tick(50n * U, 150n * U), "hold");
    assert.equal(await riskPeak(), 150, "cash 50 is below the durable 100, so the whole equity is observed");
    assert.equal(await tick(50n * U, 110n * U), "hold");
    assert.equal((await buyVerdict(110n * U)).rule, "drawdown-breaker");
    assert.deepEqual(await store.lastKnownCashReading(ACCOUNT), { cashUsdg: 100, at: T0 }, "and the held rows never replaced that reading");
  });
});
