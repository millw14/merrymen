/**
 * A STRANDED OP IS BOOKED ONCE — never inferred as capital while it is in
 * flight — against a real sqlite ledger.
 *
 * The defect: an energy purchase lands, the bundler's receipt wait times out,
 * and its row stays 'submitted' with no recordTrade. The next tick sees cash
 * drop with "nothing written" and books an inferred withdrawal (both peaks
 * down); minutes later the stranded-op resolver settles the op and books it
 * AGAIN as an energy-buy flow. Peak and contributions end 10 USDG too low, and
 * the next tick charges a performance fee on principal. A stranded swap's
 * cash leg was mis-booked as a withdrawal by the same path.
 *
 * `tick` and `resolve` below are index.ts reconcileFlows' steady-state branch
 * and resolveStrandedOps' loop body, run over the real store with the real
 * decision functions (flow-inference.ts, energy-settle.ts);
 * energy-buy-wiring.test.ts pins that index.ts has exactly this shape.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-flow-inference-"));
process.env.MERRYMEN_HOME = HOME;

const store = await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");
const { CASH, ENERGY_ROUTE_V1, MERRYMEN_TOKEN, VIRTUAL_TOKEN } = await import("../../packages/core/src/index");
const { TRANSFER_TOPIC } = await import("./deposit-log");
const { isEnergyRow, settleEnergyLanding } = await import("./energy-settle");
const { opsHoldInference, steadyStateInference, STRANDED_RESOLVE_WINDOW_SEC } = await import("./flow-inference");
type Deps = import("./energy-settle").EnergySettleDeps;
type ReceiptLog = import("./fills").ReceiptLog;

const ACCOUNT = "0x00000000000000000000000000000000000e0e07";
const USDG = (CASH.USDG as string).toLowerCase();
const MERRY = MERRYMEN_TOKEN.address.toLowerCase();
const PAIR_A = "0x00000000000000000000000000000000000000b1";
const PAIR_B = "0x00000000000000000000000000000000000000b2";
const RISK_ID = "flow-inference-risk";
const U = 1_000_000n;
const GRANT = {
  smartAccount: ACCOUNT,
  owner: "0x00000000000000000000000000000000000000ff",
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
const flowsBy = (source: string) =>
  Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM flows WHERE agent_id = ? AND source = ?", ACCOUNT, source).n);
const peak = async () => (await store.getAgentFinancials(ACCOUNT)).hwmUsdg;
const riskPeak = async () => store.getRiskPeriodPeak(ACCOUNT);

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

function deps(receipts: Map<string, readonly ReceiptLog[] | null>): Deps {
  return {
    agentId: ACCOUNT,
    account: ACCOUNT,
    chainId: 4663,
    paper: false,
    receiptLogs: async (h) => (receipts.has(h) ? receipts.get(h)! : null),
    netContributionsUsdg: () => store.getNetContributionsUsdg(ACCOUNT),
    lifetimePeakUsdg: async () => (await store.getAgentFinancials(ACCOUNT)).hwmUsdg,
    breakerPeakUsdg: () => store.getRiskPeriodPeak(ACCOUNT),
    book: (f) => store.bookCapitalFlow(f),
    event: async () => {},
  };
}

/** The process's baseline — index.ts lastCashUsdg, ledgerWrites, ledgerWritesAtSnapshot. */
const state = { lastCash: 100n * U, writes: 0, snapshot: 0 };

/** index.ts reconcileFlows, the steady-state branch with the scan off (covered = false). */
async function tick(cash: bigint): Promise<"infer" | "hold" | "explained"> {
  const opsInFlight =
    state.writes === state.snapshot &&
    opsHoldInference(await store.listSubmittedOps(ACCOUNT), {
      epoch: await store.getAgentEpoch(ACCOUNT),
      nowSec: Math.floor(Date.now() / 1000),
    });
  const v = steadyStateInference({ lastCashUsdg: state.lastCash, cashUsdg: cash, ledgerWrites: state.writes, ledgerWritesAtSnapshot: state.snapshot, opsInFlight });
  if (v.action === "hold") return "hold";
  if (v.action === "infer" && v.deltaUsdg !== 0n) {
    // record(): the inferred flow, then both peaks with it.
    const out = v.deltaUsdg < 0n;
    const amount = out ? -v.deltaUsdg : v.deltaUsdg;
    assert.equal(await store.addFlow({ agentId: ACCOUNT, direction: out ? "out" : "in", amountUsdg: Number(amount) / 1e6, source: "inferred", mode: "live" }), true);
    await store.adjustAgentHwm(ACCOUNT, Number(v.deltaUsdg) / 1e6);
  }
  state.lastCash = cash;
  state.snapshot = state.writes;
  return v.action;
}

/** index.ts resolveStrandedOps' loop body for one op the chain resolved. */
async function resolve(d: Deps, op: { userOpHash: string; txHash: `0x${string}`; success: boolean }): Promise<"settled" | "left"> {
  const row = (await store.listSubmittedOps(ACCOUNT)).find((r) => r.userOpHash === op.userOpHash);
  assert.ok(row, "the op is still 'submitted'");
  const energy = isEnergyRow(row);
  if (energy && op.success) {
    const s = await settleEnergyLanding(d, op.txHash);
    if (!s.proceed) return "left";
  }
  state.writes += 1; // the settlement explains the cash it moved
  await store.addTrade({
    agent_id: ACCOUNT,
    kind: row.kind,
    target: row.target,
    ...(energy ? { sell_token: row.sellToken, buy_token: row.buyToken } : {}),
    amount_usdg: row.amountUsdg,
    user_op_hash: row.userOpHash,
    tx_hash: op.txHash,
    status: op.success ? "landed" : "reverted",
  } as never);
  return "settled";
}

let n = 0;
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
const tx = () => `0x${(++n).toString(16).padStart(64, "e")}` as `0x${string}`;

/** A live agent with 100 USDG contributed on record, both peaks at 100, cash 100. */
async function freshAgent(): Promise<void> {
  for (const t of ["agents", "flows", "journal", "risk_periods", "trades"]) {
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
  Object.assign(state, { lastCash: 100n * U, writes: 0, snapshot: 0 });
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
  it("SCAN OFF, AN ENERGY BUY LEFT 'submitted', CASH DROPS: no inferred flow — then the resolver books ONE energy-buy with ONE peak move", async () => {
    const op = await stranded();
    const hash = tx();
    // The purchase landed; the receipt wait timed out. Next tick: cash 90.
    assert.equal(await tick(90n * U), "hold");
    assert.equal(flowsBy("inferred"), 0, "nothing inferred while the op is in flight");
    assert.equal(await peak(), 100, "no peak moved on a guess");
    assert.equal(state.lastCash, 100n * U, "the baseline is kept, so the interval stays open");
    // A second tick before the resolver runs holds the same way.
    assert.equal(await tick(90n * U), "hold");

    // The resolver settles it: booked once, from the receipt.
    assert.equal(await resolve(deps(new Map([[hash, energyLogs(10n * U)]])), { userOpHash: op, txHash: hash, success: true }), "settled");
    assert.equal(flowsBy("energy-buy"), 1);
    assert.equal(await peak(), 90);
    assert.equal(await riskPeak(), 90);

    // The next tick sees the drop explained by the settlement's write.
    assert.equal(await tick(90n * U), "explained");
    assert.equal(flowsBy("inferred"), 0);
    assert.equal(await peak(), 90, "both peaks moved exactly once");
    assert.equal(await riskPeak(), 90);
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), 90);
    // And an ordinary tick after it infers nothing from a steady balance.
    assert.equal(await tick(90n * U), "infer");
    assert.equal(flowsBy("inferred"), 0, "a zero delta books nothing");
  });

  it("THE SAME FOR A STRANDED SWAP: its cash leg is never booked as a withdrawal (the pre-existing mis-booking)", async () => {
    const op = await stranded({ kind: "swap", target: ACCOUNT, buy_token: "0x000000000000000000000000000000000000aa01" });
    assert.equal(await tick(90n * U), "hold");
    assert.equal(await resolve(deps(new Map()), { userOpHash: op, txHash: tx(), success: true }), "settled");
    assert.equal(await tick(90n * U), "explained");
    assert.equal(flowsBy("inferred"), 0);
    assert.equal(await peak(), 100, "a trade is not capital: the peak never moved");
  });

  it("an energy op whose receipt the resolver cannot read stays 'submitted' — inference stays held, nothing is booked twice", async () => {
    const op = await stranded();
    const hash = tx();
    const receipts = new Map<string, readonly ReceiptLog[] | null>([[hash, null]]);
    assert.equal(await tick(90n * U), "hold");
    assert.equal(await resolve(deps(receipts), { userOpHash: op, txHash: hash, success: true }), "left");
    assert.equal(await tick(90n * U), "hold", "still in flight: still held");
    receipts.set(hash, energyLogs(10n * U));
    assert.equal(await resolve(deps(receipts), { userOpHash: op, txHash: hash, success: true }), "settled");
    assert.equal(await tick(90n * U), "explained");
    assert.equal(flowsBy("energy-buy"), 1);
    assert.equal(flowsBy("inferred"), 0);
    assert.equal(await peak(), 90);
  });

  it("A GENUINE WITHDRAWAL WITH NOTHING IN FLIGHT IS STILL INFERRED — the narrow rule is unchanged", async () => {
    assert.equal(await tick(80n * U), "infer");
    assert.equal(flowsBy("inferred"), 1);
    assert.equal(await peak(), 80);
  });

  it("A ROW THE RESOLVER CAN NO LONGER SETTLE DOES NOT SWITCH INFERENCE OFF FOR GOOD — past its window, or from an earlier epoch", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    await stranded();
    exec("UPDATE trades SET created_at = ? WHERE status = 'submitted'", nowSec - STRANDED_RESOLVE_WINDOW_SEC - 60);
    assert.equal(await tick(80n * U), "infer", "a dropped op from over a day ago holds nothing");
    exec("DELETE FROM trades");
    await stranded();
    exec("UPDATE trades SET epoch = epoch - 1 WHERE status = 'submitted'");
    assert.equal(await tick(70n * U), "infer", "an earlier epoch's row is left for verify, not waited on");
    // And the predicate itself, at the edges.
    const at = { epoch: 3, nowSec };
    assert.equal(opsHoldInference([], at), false);
    assert.equal(opsHoldInference([{ epoch: 3, createdAt: nowSec - STRANDED_RESOLVE_WINDOW_SEC }], at), true);
    assert.equal(opsHoldInference([{ epoch: 3, createdAt: nowSec - STRANDED_RESOLVE_WINDOW_SEC - 1 }], at), false);
    assert.equal(opsHoldInference([{ epoch: 2, createdAt: nowSec }], at), false);
  });

  it("a ledger write in the interval explains it before anything else is asked", () => {
    assert.deepEqual(
      steadyStateInference({ lastCashUsdg: 100n, cashUsdg: 50n, ledgerWrites: 2, ledgerWritesAtSnapshot: 1, opsInFlight: true }),
      { action: "explained" },
    );
  });
});
