/**
 * LIGHTER PAYOUTS FOLDED INTO FLOW INFERENCE (perps/payout-look.ts,
 * flow-inference.ts lookAtCash / payoutShift; docs/perps.md rule 12 — the
 * payout-settlement-must-be-chain-derived amendment's tests a–f).
 *
 * A payout arrives in someone else's transaction, so no op of ours explains
 * it: without the fold, a look reads it as the owner depositing capital — the
 * peak and contributions raised by margin that was the account's all along.
 * Each case here runs the payout step against a REAL sqlite ledger with a
 * fake eth_getLogs, then asks the look exactly what index.ts reconcileFlows
 * asks it (the steady state, the self-hosted restart, the hosted first look),
 * and holds the answer to: no flow, no peak moved, and — where the payout
 * could not be read — no inference at all. perp-legs-wiring.test.ts pins that
 * reconcileFlows asks in this order.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { encodeAbiParameters, type Hex } from "viem";
import { LIGHTER_ROUTE_V1 } from "../../../packages/core/src/index";
import { deriveBootstrapAccounting } from "../bootstrap-source";
import { BOOTSTRAP_SCHEMA_VERSION, accountingLicence, classifyAnchor, planFirstObservation } from "../bootstrap-state";
import { wrapSqlite } from "../db";
import { lookAtCash, payoutShift, type PayoutFold } from "../flow-inference";
import type { RawLog } from "../inflight-reconcile";
import { livePerpTerm, venueMoneyOf } from "./live-term";
import type { PerpAccountRead } from "./markets";
import { runPayoutStep, type PayoutStepDeps } from "./payout-look";
import { inTransit, type CarriedPayout } from "./payouts";
import { MIRROR_STATE_DDL, mirrorPerpLedger } from "../ledger-mirror";

const PROXY = LIGHTER_ROUTE_V1.proxy;
const T0 = LIGHTER_ROUTE_V1.topics.withdrawPending;
const IDX = 22_149n;
const USDG = (n: number) => BigInt(Math.round(n * 1_000_000));
const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const hex = (n: number | bigint) => `0x${n.toString(16)}` as Hex;
const txh = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const NOW = 1_800_000_000;

function wpLog(owner: string, block: number, index: number, amount: bigint): RawLog & { address: string } {
  return {
    address: PROXY,
    topics: [T0, pad(owner)],
    data: encodeAbiParameters([{ type: "uint16" }, { type: "uint128" }], [3, amount]),
    transactionHash: txh(block * 100 + index),
    blockNumber: hex(block),
    logIndex: hex(index),
  };
}

type GetLogsArgs = Parameters<PayoutStepDeps["getLogs"]>[0];
function chainOf(logs: RawLog[], fail = false) {
  const calls: GetLogsArgs[] = [];
  const getLogs = async (a: GetLogsArgs) => {
    calls.push(a);
    if (fail) throw Object.assign(new Error("execution reverted: node unavailable"), { code: -32000 });
    return logs.filter((l) => {
      const b = BigInt(l.blockNumber as string);
      return b >= a.fromBlock && b <= a.toBlock && String(l.topics[1]).toLowerCase() === String(a.topics[1]).toLowerCase();
    });
  };
  return { calls, getLogs };
}

// ── a real ledger ───────────────────────────────────────────────────────────

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-payout-look-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("../store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));
raw.exec("PRAGMA busy_timeout = 5000");
after(() => {
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let nextAgent = 1;
async function agent(): Promise<`0x${string}`> {
  const account = `0xcd${(nextAgent++).toString(16).padStart(38, "0")}`;
  return (await store.ensureAgent({
    smartAccount: account,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: 2_000_000_000,
    chainId: 4663,
  } as never)) as `0x${string}`;
}
const flowsOf = (agentId: string) => raw.prepare("SELECT * FROM flows WHERE agent_id = ?").all(agentId);
const hwmOf = async (agentId: string) => (await store.getAgentFinancials(agentId)).hwmUsdg;

/** A withdrawal the worker requested and the venue executed — the kill's stand-down, say. */
async function requestedWithdrawal(agentId: string, amount: bigint, initiator: "agent" | "standdown" = "standdown") {
  const r = await store.upsertPerpTransfer({
    agentId,
    mode: "live",
    direction: "withdraw",
    amountMicro: amount,
    initiator,
    state: "executed",
    venueTxHash: `${agentId.slice(2, 12)}${nextAgent}`.padStart(80, "0"),
  });
  assert.equal(r.outcome, "inserted");
}

function step(agentId: `0x${string}`, over: Partial<PayoutStepDeps> & { logs?: RawLog[]; fail?: boolean; pending?: bigint | null } = {}) {
  const c = chainOf(over.logs ?? [], over.fail ?? false);
  const pendingAsked: bigint[] = [];
  const deps: PayoutStepDeps = {
    agentId,
    account: agentId,
    accountIndex: IDX,
    cursor: 1000n,
    block: 1100n,
    getLogs: c.getLogs,
    store,
    pendingAt: async (n) => {
      pendingAsked.push(n);
      return over.pending === undefined ? 0n : over.pending;
    },
    carry: [] as CarriedPayout[],
    ...over,
  };
  return runPayoutStep(deps).then((r) => ({ r, calls: c.calls, pendingAsked }));
}

/**
 * The steady-state look exactly as index.ts reconcileFlows makes it: the
 * payouts not yet folded join the baseline (payoutShift), and on anything but
 * an unread window the baseline takes them for good and the cursor moves.
 */
function steadyLook(
  mem: { baseline: bigint; cursor: bigint | null; folded: Set<string> },
  a: { cash: bigint; fold: PayoutFold; block: bigint; opsInFlight?: boolean },
) {
  const shift = payoutShift(a.fold, mem.folded);
  const l = lookAtCash({
    baselineUsdg: mem.baseline,
    since: 0,
    unattributed: false,
    settled: [],
    cashUsdg: a.cash,
    opsInFlight: a.opsInFlight ?? false,
    writesInInterval: false,
    payoutShiftUsdg6: shift === null ? null : shift.shiftUsdg6,
  });
  mem.baseline = l.baselineUsdg;
  if (shift !== null) {
    for (const k of shift.keys) mem.folded.add(k);
    mem.cursor = a.block;
  }
  if (l.verdict.action !== "hold") {
    mem.baseline = a.cash;
    mem.cursor = a.block;
  }
  return l.verdict;
}

describe("(a) SELF-HOSTED: a kill's withdrawal is paid home while the worker is stopped", () => {
  it("the restart look folds the payout into the durable reading: no flow, no peak, the withdrawal paid", async () => {
    const id = await agent();
    await store.adjustAgentHwm(id, 100);
    // The last durable reading before the kill: 100 USDG at block 1000.
    await store.addEquity(id, { ethWei: 0n, cashUsdg: 100, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 110, mode: "live", cashReadAt: NOW - 600, cashReadBlock: 1000n });
    await requestedWithdrawal(id, USDG(10));
    // The worker stops; Lighter's relayer pays the 10 home at block 1050.
    const prior = (await store.lastKnownCashReading(id))!;
    const cursor = await store.lastKnownCashReadBlock(id);
    assert.equal(cursor, 1000, "the reading and its block are one observation");
    const { r } = await step(id, { cursor: BigInt(cursor!), block: 1100n, logs: [wpLog(id, 1050, 2, USDG(10))] });
    assert.equal(r.fold.kind, "folded");
    const shift = payoutShift(r.fold, new Set());
    const look = lookAtCash({
      baselineUsdg: USDG(prior.cashUsdg),
      since: prior.at,
      unattributed: false,
      settled: [],
      cashUsdg: USDG(110),
      opsInFlight: false,
      writesInInterval: false,
      payoutShiftUsdg6: shift!.shiftUsdg6,
    });
    assert.deepEqual(look.verdict, { action: "infer", deltaUsdg: 0n }, "record(0) books nothing");
    assert.deepEqual(flowsOf(id), []);
    assert.equal(await hwmOf(id), 100);
    assert.deepEqual(await store.listOpenPerpTransfers(id, "live"), [], "the stand-down's withdrawal is paid");
    // THE BUG IT CLOSES: the same look without the fold books the margin as a deposit.
    const blind = lookAtCash({ baselineUsdg: USDG(100), since: prior.at, unattributed: false, settled: [], cashUsdg: USDG(110), opsInFlight: false, writesInInterval: false });
    assert.deepEqual(blind.verdict, { action: "infer", deltaUsdg: USDG(10) });
  });
});

describe("(b) HOSTED: the anchor predates the payout and the child's home was wiped", () => {
  it("the anchor carries the block its cash was read at; the first look folds from it and resumes clean, contributions known", async () => {
    // The shared ledger, as the orchestrator reads it.
    const SMART = "0x3e34e58e39dc6614e047dfd3bad5b7dea45dcd62" as `0x${string}`;
    const shared = wrapSqlite(new DatabaseSync(":memory:"));
    await store.applyLedgerSchema(shared);
    await shared
      .prepare(
        `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, hwm_usdg, epoch)
         VALUES (?, ?, ?, 4663, '{}', 1, 2, 100, 1)`,
      )
      .run(SMART, SMART, SMART);
    await shared
      .prepare(
        `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
         VALUES (?, 'in', 100, ?, 10, 0, 'chain-log', 1, 4663, ?)`,
      )
      .run(SMART, txh(1), NOW - 7_200);
    await shared
      .prepare(
        `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, flows_held, cash_read_at, cash_read_block, at)
         VALUES (?, '0', 100, 0, 0, 110, 1, 'live', 0, ?, 1000, ?)`,
      )
      .run(SMART, NOW - 600, NOW - 590);
    const accounting = await deriveBootstrapAccounting(shared, SMART, NOW);
    assert.equal(accounting.kind, "established");
    if (accounting.kind !== "established") return;
    assert.equal(accounting.lastObservedCashBlock, 1000);
    const verdict = classifyAnchor(JSON.stringify({ schemaVersion: BOOTSTRAP_SCHEMA_VERSION, tenantId: SMART, generatedAt: NOW, accounting }), {
      tenantId: SMART,
      nowSec: NOW,
    });
    const licence = accountingLicence(verdict, { hosted: true });
    assert.equal(licence.licence, "resume");
    assert.equal(licence.lastObservedCashBlock, 1000n);
    assert.equal(licence.contributionsKnown, true);
    // The wiped child: no rows of its own. The payout (10) landed at block 1050.
    const id = await agent();
    const { r } = await step(id, { cursor: licence.lastObservedCashBlock, block: 1100n, logs: [wpLog(id, 1050, 1, USDG(10))] });
    const shift = payoutShift(r.fold, new Set());
    const plan = planFirstObservation({
      licence: licence.licence,
      equityUsdg: USDG(110),
      cashUsdg: USDG(110),
      anchorCashUsdg: licence.lastObservedCashUsdg! + shift!.shiftUsdg6,
      materialDriftUsdg: 10_000n,
    });
    assert.deepEqual(plan, { action: "resume-clean" }, "not drift, so contributions are never doubted over it");
    // Without the fold the same resume read the margin home as drift.
    assert.equal(planFirstObservation({ licence: "resume", equityUsdg: USDG(110), cashUsdg: USDG(110), anchorCashUsdg: USDG(100), materialDriftUsdg: 10_000n }).action, "resume-with-drift");
    // The wipe lost the request row, so the payout is booked as margin the
    // owner's side sent home, and said — never capital.
    assert.equal(r.recorded?.alert, true);
    assert.deepEqual(flowsOf(id), []);
  });

  it("an anchor with no block (older than the column) parses, and carries none — the first look then cannot fold", () => {
    const SMART = "0x3e34e58e39dc6614e047dfd3bad5b7dea45dcd62";
    const a = { kind: "established", highWaterMarkUsdg: "100000000", netContributionsUsdg: "100000000", lastObservedCashUsdg: "100000000", accountingEpoch: 1, observedAt: NOW };
    const l = accountingLicence(classifyAnchor(JSON.stringify({ schemaVersion: BOOTSTRAP_SCHEMA_VERSION, tenantId: SMART, generatedAt: NOW, accounting: a }), { tenantId: SMART, nowSec: NOW }), { hosted: true });
    assert.equal(l.licence, "resume");
    assert.equal(l.lastObservedCashBlock, null);
    const bad = classifyAnchor(JSON.stringify({ schemaVersion: BOOTSTRAP_SCHEMA_VERSION, tenantId: SMART, generatedAt: NOW, accounting: { ...a, lastObservedCashBlock: -1 } }), { tenantId: SMART, nowSec: NOW });
    assert.equal(bad.kind, "malformed", "a malformed block is a malformed anchor, never a silent absence");
  });
});

describe("(c) RECOVER: a withdrawal the owner started, with no requested row", () => {
  it("is booked initiator 'owner' and alerted — margin coming home, never capital", async () => {
    const id = await agent();
    const { r } = await step(id, { logs: [wpLog(id, 1040, 0, USDG(25))] });
    assert.equal(r.recorded?.alert, true);
    assert.equal(r.recorded?.excessMicro, USDG(25));
    const rows = raw.prepare("SELECT initiator, state, direction FROM perp_transfers WHERE agent_id = ?").all(id.toLowerCase()).map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ initiator: "owner", state: "paid", direction: "withdraw" }]);
    const mem = { baseline: USDG(50), cursor: 1000n as bigint | null, folded: new Set<string>() };
    assert.deepEqual(steadyLook(mem, { cash: USDG(75), fold: r.fold, block: 1100n }), { action: "infer", deltaUsdg: 0n });
    assert.deepEqual(flowsOf(id), []);
  });
});

describe("(d) STEADY-STATE RACE: a payout lands between one balance read and the next", () => {
  it("the next look folds it: (cursor, N] reaches the block after the read, and nothing is inferred", async () => {
    const id = await agent();
    await requestedWithdrawal(id, USDG(10), "agent");
    // Tick 1 read 100 at block 1000 (the baseline). The payout lands at 1001.
    const mem = { baseline: USDG(100), cursor: 1000n as bigint | null, folded: new Set<string>() };
    const { r, calls } = await step(id, { cursor: mem.cursor, block: 1010n, logs: [wpLog(id, 1001, 0, USDG(10))] });
    assert.equal(calls[0]!.fromBlock, 1001n, "exclusive of the baseline's own block");
    assert.equal(calls[0]!.toBlock, 1010n, "inclusive of this read's");
    assert.deepEqual(steadyLook(mem, { cash: USDG(110), fold: r.fold, block: 1010n }), { action: "infer", deltaUsdg: 0n });
    assert.equal(mem.cursor, 1010n);
  });

  it("A DEPOSIT BESIDE A PAYOUT is still the owner's deposit: only the payout's own cash is explained", async () => {
    const id = await agent();
    const mem = { baseline: USDG(100), cursor: 1000n as bigint | null, folded: new Set<string>() };
    const { r } = await step(id, { block: 1010n, logs: [wpLog(id, 1005, 0, USDG(10))] });
    // 100 + 10 payout + 40 the owner sent in.
    assert.deepEqual(steadyLook(mem, { cash: USDG(150), fold: r.fold, block: 1010n }), { action: "infer", deltaUsdg: USDG(40) });
  });
});

describe("(e) A HELD LOOK FOLLOWED BY A SETTLING ONE folds the payout exactly once", () => {
  it("the held look keeps the payout in its baseline and moves the cursor; the settling look sees none of it again", async () => {
    const id = await agent();
    await requestedWithdrawal(id, USDG(10), "agent");
    const mem = { baseline: USDG(100), cursor: 1000n as bigint | null, folded: new Set<string>() };
    const payout = wpLog(id, 1005, 3, USDG(10));
    const held = await step(id, { cursor: mem.cursor, block: 1010n, logs: [payout] });
    assert.deepEqual(steadyLook(mem, { cash: USDG(110), fold: held.r.fold, block: 1010n, opsInFlight: true }), { action: "hold" });
    assert.equal(mem.baseline, USDG(110), "the held baseline took the payout");
    assert.equal(mem.cursor, 1010n);
    // The settling look: its window starts after the held one's block…
    const settle = await step(id, { cursor: mem.cursor, block: 1020n, logs: [payout] });
    assert.deepEqual(steadyLook(mem, { cash: USDG(110), fold: settle.r.fold, block: 1020n }), { action: "infer", deltaUsdg: 0n });
    // …and even a node answering an overlapping window again is folded once:
    // the in-process key set is the second guard.
    const overlap = await step(id, { cursor: 1000n, block: 1030n, logs: [payout] });
    assert.deepEqual(payoutShift(overlap.r.fold, mem.folded), { shiftUsdg6: 0n, keys: [] });
    assert.equal(overlap.r.recorded?.alreadyBooked.length, 1, "and the ledger books it once too");
  });
});

describe("(f) A FAILED getLogs: the look holds, and never infers", () => {
  it("steady state: unfoldable → hold; the baseline and the cursor stay where they were", async () => {
    const id = await agent();
    const mem = { baseline: USDG(100), cursor: 1000n as bigint | null, folded: new Set<string>() };
    const { r } = await step(id, { block: 1010n, fail: true });
    assert.equal(r.fold.kind, "unfoldable");
    assert.equal(r.transit, null, "and transit is unread: the live term is a book gap");
    assert.deepEqual(steadyLook(mem, { cash: USDG(110), fold: r.fold, block: 1010n }), { action: "hold" });
    assert.equal(mem.baseline, USDG(100));
    assert.equal(mem.cursor, 1000n, "the next look reads the same window again");
    assert.deepEqual(flowsOf(id), []);
  });

  it("every other unknown is unfoldable too: an unread index, no cursor, no pinned block, a node behind the cursor", async () => {
    const id = await agent();
    for (const over of [{ accountIndex: null }, { cursor: null }, { block: null }, { cursor: 1200n, block: 1100n }] as Partial<PayoutStepDeps>[]) {
      const { r } = await step(id, over);
      assert.equal(r.fold.kind, "unfoldable", JSON.stringify(over, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
    }
  });

  it("NO LIGHTER ACCOUNT (the chain's own 0): nothing is asked and the look is the one it was before perps", async () => {
    const id = await agent();
    const { r, calls, pendingAsked } = await step(id, { accountIndex: 0n, cursor: null, block: null });
    assert.deepEqual(r.fold, { kind: "none" });
    assert.equal(calls.length, 0);
    assert.equal(pendingAsked.length, 0);
    assert.equal(r.pendingBalanceMicro, 0n);
    const mem = { baseline: USDG(100), cursor: null as bigint | null, folded: new Set<string>() };
    assert.deepEqual(steadyLook(mem, { cash: USDG(130), fold: r.fold, block: 1n }), { action: "infer", deltaUsdg: USDG(30) }, "a real deposit is still booked");
  });
});

describe("transit at the cash's block, and the live perp term", () => {
  it("the pending balance is read AT N; above T_out it is a book gap (a withdrawal nobody recorded)", async () => {
    const id = await agent();
    await requestedWithdrawal(id, USDG(10), "agent");
    const ok = await step(id, { pending: USDG(10) });
    assert.deepEqual(ok.pendingAsked, [1100n]);
    assert.deepEqual(ok.r.transit, { tInMicro: 0n, tOutMicro: USDG(10), gap: false, why: null });
    const gap = await step(id, { pending: USDG(11) });
    assert.equal(gap.r.transit?.gap, true);
    assert.equal(gap.r.transit?.why, "pending-exceeds-transit");
    const unread = await step(id, { pending: null });
    assert.equal(unread.r.transit?.why, "pending-unread");
  });

  const acct = (o: Partial<PerpAccountRead> = {}): PerpAccountRead =>
    ({
      accountIndex: Number(IDX),
      l1Address: "0x3333333333333333333333333333333333333333",
      collateralMicro: USDG(20),
      positions: [],
      isolatedMarginMicro: USDG(5),
      unrealizedMicro: USDG(2),
      unrealizedGainMicro: USDG(3),
      venueValueMicro: USDG(27),
      totalAssetValueMicro: USDG(27),
      transactionTimeUs: 1_760_000_000_000_000,
      accountType: 0,
      status: 1,
      totalOrderCount: 0,
      pendingOrderCount: 0,
      poolShareCount: 0,
      spotHoldings: [],
      spotUsdgMicro: 0n,
      pendingUnlockCount: 0,
      ...o,
    }) as PerpAccountRead;

  it("C + ΣM + ΣU from ONE read, T_in + T_out from the payout step — and every unknown is a gap, never a zero", () => {
    const t = inTransit({ openTransfers: [{ direction: "withdraw", state: "executed", amountMicro: USDG(4) }], pendingBalanceMicro: USDG(4) });
    const term = livePerpTerm({ account: acct(), transit: t });
    assert.deepEqual(term.book, {
      collateralMicro: USDG(20),
      isolatedMarginMicro: USDG(5),
      unrealizedMicro: USDG(2),
      unrealizedGainMicro: USDG(3),
      inTransitMicro: USDG(4),
      snapshotTime: 1_760_000_000_000_000,
    });
    assert.equal(term.valueMicro, USDG(31));
    assert.equal(term.venueMoneyMicro, USDG(29), "funded at the venue: C + ΣM + T, whatever the marks say");
    assert.equal(venueMoneyOf(term.book), USDG(29));
    assert.equal(livePerpTerm({ account: null, transit: t }).book, "unread");
    assert.equal(livePerpTerm({ account: acct({ totalAssetValueMicro: USDG(40) }), transit: t }).book, "unread", "the cross-check failed");
    assert.equal(livePerpTerm({ account: acct(), transit: null }).book, "unread", "transit unknown");
    const gap = livePerpTerm({ account: acct(), transit: { ...t, gap: true, why: "pending-exceeds-transit" } });
    assert.equal(gap.book, "unread");
    assert.equal(gap.venueMoneyMicro, null);
    assert.equal(venueMoneyOf("unread"), null);
  });
});

describe("partial payout allocations survive restarts", () => {
  async function twoWithdrawals(id: string) {
    for (const n of [1, 2]) await store.upsertPerpTransfer({ agentId: id, mode: "live", id: `${id}:${n}`,
      direction: "withdraw", amountMicro: USDG(100), initiator: "agent", state: "executed" });
  }
  it("150 paid against two 100 withdrawals stays cash150 + transit50 after restart and a cursor past the payout", async () => {
    const id = await agent(); await twoWithdrawals(id);
    const first = await step(id, { logs: [wpLog(id, 1050, 1, USDG(150))], pending: USDG(50) });
    assert.equal(first.r.recorded?.carryMicro, USDG(50));
    assert.equal(first.r.transit?.tOutMicro, USDG(50));
    store.closeStoreForTest();
    try { process.chdir(isolatedCwd); await store.initStore(); } finally { process.chdir(originalCwd); }
    const restarted = await step(id, { cursor: 1100n, block: 1200n, logs: [], pending: USDG(50), carry: [] });
    assert.equal(restarted.r.fold.kind, "folded");
    assert.equal(restarted.r.recorded?.carryMicro, USDG(50));
    assert.equal(restarted.r.transit?.gap, false);
    assert.equal(USDG(150) + restarted.r.transit!.tOutMicro, USDG(200));
    const final = await step(id, { cursor: 1100n, block: 1250n, logs: [wpLog(id, 1220, 2, USDG(50))] });
    assert.equal(final.r.recorded?.carryMicro, 0n);
    assert.equal(final.r.transit?.tOutMicro, 0n);
    assert.equal((await store.listOpenPerpTransfers(id, "live")).length, 0);
    const journal = await store.readJournal(id, 1);
    await step(id, { logs: [wpLog(id, 1050, 1, USDG(150)), wpLog(id, 1220, 2, USDG(50))], block: 1250n });
    assert.deepEqual(await store.readJournal(id, 1), journal, "overlapping scans never reallocate the same payout");
  });
  it("a carry that completes no withdrawal is durable too", async () => {
    const id = await agent(); await twoWithdrawals(id);
    await step(id, { logs: [wpLog(id, 1050, 1, USDG(40))], pending: USDG(160) });
    const next = await step(id, { cursor: 1100n, block: 1200n, pending: USDG(160), carry: [] });
    assert.equal(next.r.transit?.tOutMicro, USDG(160));
    assert.equal(next.r.recorded?.carryMicro, USDG(40));
  });
  it("failure saving the allocation rolls back paid rows and their journal; retry allocates once", async () => {
    const id = await agent(); await twoWithdrawals(id);
    const before = await store.readJournal(id, 1);
    raw.exec(`CREATE TRIGGER fail_payout_allocation BEFORE INSERT ON perp_payouts WHEN NEW.agent_id = '${id}' BEGIN SELECT RAISE(ABORT, 'injected allocation disk failure'); END`);
    const failed = await step(id, { logs: [wpLog(id, 1050, 1, USDG(150))], pending: USDG(50) });
    assert.equal(failed.r.fold.kind, "unfoldable");
    assert.equal(failed.r.transit, null);
    assert.equal((await store.listOpenPerpTransfers(id, "live")).length, 2);
    assert.deepEqual(await store.readJournal(id, 1), before);
    raw.exec("DROP TRIGGER fail_payout_allocation");
    const retried = await step(id, { logs: [wpLog(id, 1050, 1, USDG(150))], pending: USDG(50) });
    assert.equal(retried.r.transit?.tOutMicro, USDG(50));
    assert.equal((await store.listOpenPerpTransfers(id, "live")).length, 1);
  });
  it("mirrors exact payout remainder and refuses stale replay from increasing it", async () => {
    const id = await agent(); await twoWithdrawals(id);
    await step(id, { logs: [wpLog(id, 1050, 1, USDG(150))], pending: USDG(50) });
    const target = new DatabaseSync(":memory:"), db = wrapSqlite(target);
    try {
      await store.applyLedgerSchema(db); await db.exec(MIRROR_STATE_DDL);
      const run = async () => {
        const failed: Record<string, string> = {};
        await mirrorPerpLedger({ child: wrapSqlite(raw), shared: db, tenant: id, nowSec: Math.floor(Date.now() / 1000), batch: 1000, copied: {}, failed });
        assert.deepEqual(failed, {});
      };
      await run();
      assert.equal(target.prepare("SELECT remaining_micro FROM perp_payouts WHERE agent_id = ?").get(id)?.remaining_micro, String(USDG(50)));
      target.prepare("UPDATE perp_payouts SET remaining_micro = '0' WHERE agent_id = ?").run(id);
      await run();
      assert.equal(target.prepare("SELECT remaining_micro FROM perp_payouts WHERE agent_id = ?").get(id)?.remaining_micro, "0");
    } finally { target.close(); }
  });
  it("legacy paid rows with no durable allocation keep transit unread after a restart", async () => {
    const id = await agent(); await twoWithdrawals(id);
    await store.upsertPerpTransfer({ agentId: id, mode: "live", id: `${id}:1`, direction: "withdraw",
      amountMicro: USDG(100), initiator: "agent", state: "paid", chainId: LIGHTER_ROUTE_V1.chainId,
      txHash: txh(105001), logIndex: 1, paidTxHash: txh(105001), paidLogIndex: 1 });
    const next = await step(id, { cursor: 1100n, block: 1200n, pending: USDG(50), carry: [] });
    assert.equal(next.r.fold.kind, "unfoldable");
    assert.equal(next.r.transit, null, "missing partial allocation must not turn cash150 + transit100 into a valued book");
  });
  it("a chain identity cannot later acquire a different payout amount", async () => {
    const id = await agent(); await twoWithdrawals(id);
    await step(id, { logs: [wpLog(id, 1050, 1, USDG(150))], pending: USDG(50) });
    const before = await store.readJournal(id, 1);
    const changed = await step(id, { logs: [wpLog(id, 1050, 1, USDG(160))], pending: USDG(40) });
    assert.equal(changed.r.fold.kind, "unfoldable");
    assert.equal(changed.r.transit, null);
    assert.deepEqual(await store.readJournal(id, 1), before);
  });
});
