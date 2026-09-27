/**
 * A LANDED ENERGY PURCHASE IS BOOKED ONCE — through both roads that reach it,
 * against a real sqlite ledger.
 *
 * The two roads are the executor's landing (bookEnergyPurchase with the op's
 * own receipt, before the landed row) and the stranded-op resolver (the op was
 * left 'submitted' by a crash or an unreadable receipt; settleEnergyLanding
 * books it before the row is settled). Each case below is one claim the money
 * path depends on:
 *
 *   - one flow, one peak move, and again is nothing;
 *   - a row whose KIND was rewritten is still found by its legs and booked;
 *   - reverted/rejected/paper rows book nothing, and an ordinary buy is not energy;
 *   - an unreadable receipt leaves the op 'submitted' and books on the next pass;
 *   - a ledger that throws moves no peak and leaves the op 'submitted';
 *   - two concurrent settles book one flow and move the peak once;
 *   - no contribution record: refused with the owner told, nothing moved.
 *
 * MERRYMEN_HOME is set before any store import; node's --test runs each file in
 * its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-energy-settle-"));
process.env.MERRYMEN_HOME = HOME;

const store = await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");
const { CASH, ENERGY_ROUTE_V1, MERRYMEN_TOKEN, VIRTUAL_TOKEN } = await import("../../packages/core/src/index");
const { TRANSFER_TOPIC } = await import("./deposit-log");
const { bookEnergyPurchase, isEnergyRow, settleEnergyLanding } = await import("./energy-settle");
type Deps = import("./energy-settle").EnergySettleDeps;
type ReceiptLog = import("./fills").ReceiptLog;

const ACCOUNT = "0x00000000000000000000000000000000000e0e03";
const USDG = (CASH.USDG as string).toLowerCase();
const MERRY = MERRYMEN_TOKEN.address.toLowerCase();
const PAIR_A = "0x00000000000000000000000000000000000000b1";
const PAIR_B = "0x00000000000000000000000000000000000000b2";
const RISK_ID = "energy-settle-risk";
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

const topic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const transfer = (token: string, from: string, to: string, amount: bigint, logIndex: number): ReceiptLog => ({
  address: token,
  topics: [TRANSFER_TOPIC, topic(from), topic(to)],
  data: `0x${amount.toString(16).padStart(64, "0")}`,
  logIndex,
  blockNumber: 9_000_001n,
});
/** The real route's four legs: USDG out, VIRTUAL between pairs, the tax, and the reserve in. */
const energyLogs = (usdg6: bigint): ReceiptLog[] => [
  transfer(USDG, ACCOUNT, PAIR_A, usdg6, 17),
  transfer(VIRTUAL_TOKEN, PAIR_A, PAIR_B, 90n * 10n ** 18n, 18),
  transfer(MERRY, PAIR_B, MERRY, 200n * 10n ** 18n, 19),
  transfer(MERRY, PAIR_B, ACCOUNT, 19_800n * 10n ** 18n, 20),
];
let n = 0;
const txHash = () => `0x${(++n).toString(16).padStart(64, "e")}` as `0x${string}`;

const events: { level: string; line: string }[] = [];
function deps(over: Partial<Deps> = {}, receipts: Map<string, readonly ReceiptLog[] | null> = new Map()): Deps {
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
    event: async (level, line) => {
      events.push({ level, line });
    },
    ...over,
  };
}

const energyFlows = () =>
  Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM flows WHERE agent_id = ? AND source = 'energy-buy'", ACCOUNT).n);
const peak = async () => (await store.getAgentFinancials(ACCOUNT)).hwmUsdg;
const riskWithdrawn = () => Number(one<{ w: number }>("SELECT withdrawn_usdg AS w FROM risk_periods WHERE id = ?", RISK_ID).w);

/** A live agent with 100 USDG contributed, a 100 USDG lifetime peak and a 100 USDG risk period. */
async function freshAgent(): Promise<void> {
  for (const t of ["agents", "flows", "journal", "risk_periods", "trades"]) {
    try {
      exec(`DELETE FROM ${t}`);
    } catch {
      /* table may not exist yet */
    }
  }
  events.length = 0;
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
    await store.addFlow({
      agentId: ACCOUNT,
      direction: "in",
      amountUsdg: 100,
      source: "chain-log",
      txHash: `0x${"d0".repeat(32)}`,
      blockNumber: 8_000_000,
      logIndex: 1,
      mode: "live",
      chainId: 4663,
    }),
    true,
  );
}

/**
 * THE RESOLVER'S LOOP BODY, as index.ts resolveStrandedOps runs it for one
 * resolved op: energy (by kind OR legs) and landed → book first, and a booking
 * that could not be read or written leaves the row 'submitted' (continue).
 * energy-buy-wiring.test.ts pins that index.ts has exactly this shape.
 */
async function resolveOne(d: Deps, op: { userOpHash: string; txHash: `0x${string}`; success: boolean }): Promise<"settled" | "left"> {
  const row = (await store.listSubmittedOps(ACCOUNT)).find((r) => r.userOpHash === op.userOpHash);
  assert.ok(row, "the op is still 'submitted'");
  const energy = isEnergyRow(row);
  if (energy && op.success) {
    const s = await settleEnergyLanding(d, op.txHash);
    if (!s.proceed) return "left";
  }
  await store.addTrade({
    agent_id: ACCOUNT,
    kind: row.kind,
    target: row.target,
    ...(energy ? { sell_token: row.sellToken, buy_token: row.buyToken } : {}),
    amount_usdg: row.amountUsdg,
    user_op_hash: row.userOpHash,
    tx_hash: op.txHash,
    status: op.success ? "landed" : "reverted",
  });
  return "settled";
}

async function submitted(over: Record<string, unknown> = {}): Promise<string> {
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

before(async () => {
  await store.initStore();
});
beforeEach(freshAgent);
after(() => {
  store.closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the executor's landing: bookEnergyPurchase", () => {
  it("one flow, both peaks moved by exactly the spend — and running it again moves NOTHING", async () => {
    const tx = txHash();
    const d = deps();
    assert.equal(await bookEnergyPurchase(d, { txHash: tx, logs: energyLogs(10_000_000n), blockNumber: 9_000_001n }), "booked");
    assert.equal(energyFlows(), 1);
    assert.equal(await peak(), 90);
    assert.equal(riskWithdrawn(), 10);
    assert.match(events.at(-1)!.line, /set aside 10 USDG as energy — capital leaving the trading book, not a loss/);

    assert.equal(await bookEnergyPurchase(d, { txHash: tx, logs: energyLogs(10_000_000n), blockNumber: 9_000_001n }), "already");
    assert.equal(energyFlows(), 1);
    assert.equal(await peak(), 90, "idempotent: the peak moved once");
    assert.equal(riskWithdrawn(), 10);
  });

  it("the amount is the RECEIPT's, not the plan's", async () => {
    await bookEnergyPurchase(deps(), { txHash: txHash(), logs: energyLogs(9_870_000n) });
    assert.equal(Number(one<{ a: number }>("SELECT amount_usdg AS a FROM flows WHERE source = 'energy-buy'").a), 9.87);
  });

  it("logs the executor could not hand over are re-read by hash; a receipt nobody can read THROWS", async () => {
    const tx = txHash();
    await assert.rejects(bookEnergyPurchase(deps(), { txHash: tx, logs: [] }), /could not be read — left to the resolver/);
    assert.equal(energyFlows(), 0);
    assert.equal(await peak(), 100);
    const ok = deps({}, new Map([[tx, energyLogs(10_000_000n)]]));
    assert.equal(await bookEnergyPurchase(ok, { txHash: tx, logs: [] }), "booked");
  });

  it("a receipt that reads as something else is never booked as energy — the owner's feed says so", async () => {
    const logs = [transfer(USDG, ACCOUNT, PAIR_A, 10_000_000n, 3), transfer("0x000000000000000000000000000000000000aa01", PAIR_A, ACCOUNT, 5n, 4)];
    assert.equal(await bookEnergyPurchase(deps(), { txHash: txHash(), logs }), "not-a-purchase");
    assert.equal(energyFlows(), 0);
    assert.equal(await peak(), 100);
    assert.equal(events.at(-1)!.level, "err");
  });

  it("no contribution record: refused, nothing moved, and the owner is told", async () => {
    exec("DELETE FROM flows");
    assert.equal(await bookEnergyPurchase(deps(), { txHash: txHash(), logs: energyLogs(10_000_000n) }), "refused");
    assert.equal(energyFlows(), 0);
    assert.equal(await peak(), 100);
    assert.match(events.at(-1)!.line, /not booked/);
  });

  it("a ledger that throws moves NO peak — the store's transaction rolls back and the caller sees the throw", async () => {
    exec(
      `CREATE TRIGGER settle_boom BEFORE UPDATE OF hwm_withdrawn_usdg ON agents
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    try {
      const tx = txHash();
      await assert.rejects(bookEnergyPurchase(deps(), { txHash: tx, logs: energyLogs(10_000_000n) }));
      assert.equal(energyFlows(), 0, "the flow row rolled back with the peak");
      assert.equal(await peak(), 100);
    } finally {
      exec("DROP TRIGGER IF EXISTS settle_boom");
    }
  });

  it("TWO CONCURRENT settles of one purchase: one flow, one peak move", async () => {
    const tx = txHash();
    const d = deps();
    const results = await Promise.all([
      bookEnergyPurchase(d, { txHash: tx, logs: energyLogs(10_000_000n) }),
      bookEnergyPurchase(d, { txHash: tx, logs: energyLogs(10_000_000n) }),
    ]);
    assert.deepEqual([...results].sort(), ["already", "booked"]);
    assert.equal(energyFlows(), 1);
    assert.equal(await peak(), 90);
  });
});

describe("the stranded-op resolver: settleEnergyLanding before the row is settled", () => {
  it("a stranded energy buy that landed is booked, then settled landed WITH its legs", async () => {
    const h = await submitted();
    const tx = txHash();
    const d = deps({}, new Map([[tx, energyLogs(10_000_000n)]]));
    assert.equal(await resolveOne(d, { userOpHash: h, txHash: tx, success: true }), "settled");
    assert.equal(energyFlows(), 1);
    assert.equal(await peak(), 90);
    const row = one<{ status: string; sell_token: string; buy_token: string }>(
      "SELECT status, sell_token, buy_token FROM trades WHERE user_op_hash = ?",
      h,
    );
    assert.equal(row.status, "landed");
    assert.equal(row.buy_token.toLowerCase(), MERRY);
    // Settled means off the resolver's list; booking it again is nothing.
    assert.equal((await store.listSubmittedOps(ACCOUNT)).length, 0);
    assert.equal(await bookEnergyPurchase(d, { txHash: tx }), "already");
    assert.equal(await peak(), 90);
  });

  it("A ROW WHOSE KIND WAS REWRITTEN (swap, target the account, no decision) is still found by its legs and booked", async () => {
    const h = await submitted({ kind: "swap", target: ACCOUNT, decision_id: null });
    const tx = txHash();
    assert.equal(isEnergyRow((await store.listSubmittedOps(ACCOUNT))[0]!), true);
    assert.equal(await resolveOne(deps({}, new Map([[tx, energyLogs(10_000_000n)]])), { userOpHash: h, txHash: tx, success: true }), "settled");
    assert.equal(energyFlows(), 1);
    assert.equal(await peak(), 90);
  });

  it("a receipt the chain will not return leaves the op 'submitted' — and the next pass books it, once", async () => {
    const h = await submitted();
    const tx = txHash();
    const receipts = new Map<string, readonly ReceiptLog[] | null>([[tx, null]]);
    assert.equal(await resolveOne(deps({}, receipts), { userOpHash: h, txHash: tx, success: true }), "left");
    assert.equal((await store.listSubmittedOps(ACCOUNT)).length, 1, "still submitted: still counted, still resolvable");
    assert.equal(energyFlows(), 0);
    receipts.set(tx, energyLogs(10_000_000n));
    assert.equal(await resolveOne(deps({}, receipts), { userOpHash: h, txHash: tx, success: true }), "settled");
    assert.equal(energyFlows(), 1);
    assert.equal(await peak(), 90);
  });

  it("a ledger that throws while booking leaves the op 'submitted' and the peak where it was", async () => {
    const h = await submitted();
    const tx = txHash();
    const failing = deps({ book: async () => Promise.reject(new Error("db down")) }, new Map([[tx, energyLogs(10_000_000n)]]));
    assert.equal(await resolveOne(failing, { userOpHash: h, txHash: tx, success: true }), "left");
    assert.equal((await store.listSubmittedOps(ACCOUNT)).length, 1);
    assert.equal(await peak(), 100);
  });

  it("a REVERTED energy op books nothing; an ordinary stranded buy is not energy at all", async () => {
    const h = await submitted();
    const tx = txHash();
    assert.equal(await resolveOne(deps({}, new Map([[tx, energyLogs(10_000_000n)]])), { userOpHash: h, txHash: tx, success: false }), "settled");
    assert.equal(energyFlows(), 0);
    assert.equal(await peak(), 100);
    assert.equal(isEnergyRow({ kind: "swap", sellToken: USDG, buyToken: "0x000000000000000000000000000000000000aa01" }), false);
    assert.equal(isEnergyRow({ kind: "swap", sellToken: MERRY, buyToken: USDG }), false, "a sale of the reserve is not a purchase");
    assert.equal(isEnergyRow({ kind: "energy-buy" }), true);
  });

  it("rows that are not 'submitted' — landed, rejected, paper — are never on the resolver's list at all", async () => {
    for (const status of ["landed", "rejected", "paper", "reverted"]) await submitted({ status });
    assert.equal((await store.listSubmittedOps(ACCOUNT)).length, 0);
  });
});
