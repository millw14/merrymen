/**
 * THE CONTRIBUTION FIGURE THE ENERGY GATES AND THE BRAIN READ — durable first,
 * run against a real sqlite ledger shaped like a redeployed hosted child.
 *
 * A redeploy wipes a hosted child's sqlite and nothing seeds flows back, so
 * the local sum read null for an account whose contributions are on record in
 * Postgres: the planner refused every energy buy ("no record of the capital
 * put into it — send USDG to it first"), and the landing-time booking refused
 * a purchase that had already moved money. The Brain read the arm-time anchor
 * alone, so a purchase booked after arm looked like a loss of its own size.
 *
 * `durable` below is index.ts durableNetContributions over the real store
 * (energy-buy-wiring.test.ts pins that the three consumers read it).
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-net-contrib-"));
process.env.MERRYMEN_HOME = HOME;

const store = await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");
const { CASH, MERRYMEN_TOKEN, VIRTUAL_TOKEN } = await import("../../packages/core/src/index");
const { TRANSFER_TOPIC } = await import("./deposit-log");
const { bookEnergyPurchase } = await import("./energy-settle");
const { planEnergyBuy } = await import("./energy-buy");
const { durableNetContributionsUsdg6 } = await import("./net-contributions");
type Deps = import("./energy-settle").EnergySettleDeps;
type ReceiptLog = import("./fills").ReceiptLog;

const ACCOUNT = "0x00000000000000000000000000000000000e0e09";
const USDG = (CASH.USDG as string).toLowerCase();
const MERRY = MERRYMEN_TOKEN.address.toLowerCase();
const U = 1_000_000n;
const TOKEN = 10n ** 18n;
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

/** What the anchor said, as index.ts applyAccountingAnchor keeps it. */
const anchor: { net: bigint | null; epoch: number | null; writtenAt: number | null } = { net: null, epoch: null, writtenAt: null };

/** index.ts durableNetContributions, over the real store. */
async function durable(): Promise<bigint | null> {
  const local = await store.getNetContributionsSince(ACCOUNT, anchor.writtenAt ?? 0);
  return durableNetContributionsUsdg6({
    anchorNetUsdg6: anchor.net,
    anchorEpoch: anchor.epoch,
    epoch: local.epoch,
    localNetUsdg: local.netUsdg,
    localSinceAnchorUsdg: local.sinceUsdg,
  });
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
  transfer(USDG, ACCOUNT, "0x00000000000000000000000000000000000000b1", usdg6, 17),
  transfer(VIRTUAL_TOKEN, "0x00000000000000000000000000000000000000b1", "0x00000000000000000000000000000000000000b2", 90n * TOKEN, 18),
  transfer(MERRY, "0x00000000000000000000000000000000000000b2", ACCOUNT, 19_800n * TOKEN, 19),
];

/** energySettleDeps as index.ts wires them — the booking gate reads the durable figure. */
const deps = (): Deps => ({
  agentId: ACCOUNT,
  account: ACCOUNT,
  chainId: 4663,
  paper: false,
  receiptLogs: async () => null,
  netContributionsUsdg: async () => {
    const net = await durable();
    return net === null ? null : Number(net) / 1e6;
  },
  lifetimePeakUsdg: async () => (await store.getAgentFinancials(ACCOUNT)).hwmUsdg,
  breakerPeakUsdg: () => store.getRiskPeriodPeak(ACCOUNT),
  book: (f) => store.bookCapitalFlow(f),
  event: async () => {},
});

/** The planner, on a book whose only unknown is the contribution figure. */
const planWith = (net: bigint | null) =>
  planEnergyBuy(
    { holder: 20_000n * TOKEN, account: 0n, cashUsdg: 100n * U, inFlight: false },
    { ownerMaxRaw: 10n * U, perTradeRaw: 10n * U, dailyRaw: 50n * U, spentTodayRaw: 0n, opsRemaining: 24, maxOpsPerDay: 24 },
    { taxBps: 100, amountInFor: async (g) => (g * U) / (2_000n * TOKEN) + 1n },
    { paper: false, equityKnown: true, equityUsdg: 100n * U, netContributionsUsdg: net, lifetimePeakUsdg: 100n * U, breakerPeakUsdg: 100n * U, maxDrawdownBps: 500 },
  );

/** A hosted child rebuilt by a redeploy: the peak restored from the anchor, NO flows in its own table. */
async function rebuiltHostedChild(): Promise<void> {
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
  Object.assign(anchor, { net: 100n * U, epoch: await store.getAgentEpoch(ACCOUNT), writtenAt: Math.floor(Date.now() / 1000) - 60 });
}

before(async () => {
  await store.initStore();
});
beforeEach(rebuiltHostedChild);
after(() => {
  store.closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the hosted shape: anchor established, the child's own flows empty", () => {
  it("THE BUY IS PLANNED, NOT REFUSED — the record is the anchor's, and the child's empty table is not 'no record'", async () => {
    assert.equal(await store.getNetContributionsUsdg(ACCOUNT), null, "the local sum alone reads nothing");
    const old = await planWith(null);
    assert.equal(old.kind === "refuse" && old.rule, "no-contribution-record", "which is what refused every buy after a deploy");
    const net = await durable();
    assert.equal(net, 100n * U);
    const p = await planWith(net);
    assert.equal(p.kind, "buy");
  });

  it("THE LANDED PURCHASE IS BOOKED ON THE DURABLE FIGURE — and the figure then reflects it", async () => {
    const tx = `0x${"e7".repeat(32)}` as `0x${string}`;
    assert.equal(await bookEnergyPurchase(deps(), { txHash: tx, logs: energyLogs(10n * U), blockNumber: 9_000_001n }), "booked");
    assert.equal(await durable(), 90n * U, "the anchor's 100 less the 10 this child booked since");
    assert.equal((await store.getAgentFinancials(ACCOUNT)).hwmUsdg, 90);
  });

  it("A FLOW ALREADY IN THE ANCHOR IS NEVER COUNTED TWICE — a same-container respawn keeps the old process's rows", async () => {
    await store.addFlow({ agentId: ACCOUNT, direction: "in", amountUsdg: 100, source: "chain-log", txHash: `0x${"d1".repeat(32)}`, blockNumber: 8_000_000, logIndex: 1, mode: "live", chainId: 4663 });
    exec("UPDATE flows SET at = ?", anchor.writtenAt! - 3_600);
    assert.equal(await durable(), 100n * U, "the anchor already holds it");
    // A deposit this child books after arm is added.
    await store.addFlow({ agentId: ACCOUNT, direction: "in", amountUsdg: 25, source: "chain-log", txHash: `0x${"d2".repeat(32)}`, blockNumber: 8_000_100, logIndex: 1, mode: "live", chainId: 4663 });
    assert.equal(await durable(), 125n * U);
  });

  it("once the child's epoch moves past the anchor's, the local epoch sum answers", async () => {
    await store.addFlow({ agentId: ACCOUNT, direction: "in", amountUsdg: 40, source: "chain-log", txHash: `0x${"d3".repeat(32)}`, blockNumber: 8_000_000, logIndex: 1, mode: "live", chainId: 4663 });
    anchor.epoch = (anchor.epoch ?? 1) - 1;
    assert.equal(await durable(), 40n * U);
  });

  it("SELF-HOSTED (no anchor figure): the local sum, unchanged — and null, never zero, when nothing is on record", async () => {
    Object.assign(anchor, { net: null, epoch: null, writtenAt: null });
    assert.equal(await durable(), null);
    await store.addFlow({ agentId: ACCOUNT, direction: "in", amountUsdg: 30, source: "chain-log", txHash: `0x${"d4".repeat(32)}`, blockNumber: 8_000_000, logIndex: 1, mode: "live", chainId: 4663 });
    assert.equal(await durable(), 30n * U);
  });
});
