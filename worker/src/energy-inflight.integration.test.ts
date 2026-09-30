/**
 * ONE ENERGY BUY AT A TIME, AS THE LEDGER SEES IT — against a real sqlite file.
 *
 * The planner sizes a buy from the chain, so the one way to buy twice is to
 * size a second one before the first has settled. energyBuysInFlight is the
 * question asked first: is there a 'submitted' energy purchase on the ledger?
 * It must find one by KIND or by LEGS (a row whose kind was rewritten is still
 * a purchase in flight), must not find settled or stale ones, and must answer
 * NULL — never false — when the ledger will not answer.
 *
 * MERRYMEN_HOME is set before any store import; node's --test runs each file in
 * its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-energy-inflight-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, ensureAgent, addTrade, energyBuysInFlight, listSubmittedOps } = await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");
const { CASH, ENERGY_ROUTE_V1, MERRYMEN_TOKEN } = await import("../../packages/core/src/index");

const ACCOUNT = "0x00000000000000000000000000000000000e0e02";
const USDG = CASH.USDG as string;
const MERRY = MERRYMEN_TOKEN.address as string;
const AAPL = "0x000000000000000000000000000000000000aa01";
const GRANT = {
  smartAccount: ACCOUNT,
  owner: "0x00000000000000000000000000000000000000ff",
  sessionKeyAddress: "0x00000000000000000000000000000000000000fe",
  chainId: 4663,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 24 },
  grantedAt: 1_700_000_000,
  expiresAt: 2_000_000_000,
} as never;

const WINDOW = 6 * 3600;
const since = () => Math.floor(Date.now() / 1000) - WINDOW;
let n = 0;
const hash = () => `0x${(++n).toString(16).padStart(64, "0")}`;

function exec(sql: string, ...params: (string | number | null)[]): void {
  const db = new DatabaseSync(homePaths.db());
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

async function row(over: Record<string, unknown>): Promise<string> {
  const h = hash();
  await addTrade({
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
  await initStore();
  await ensureAgent(GRANT);
});
beforeEach(() => exec("DELETE FROM trades"));
after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("energyBuysInFlight", () => {
  it("an empty ledger has nothing in flight (false, not null)", async () => {
    assert.equal(await energyBuysInFlight(ACCOUNT, since()), false);
  });

  it("finds a submitted row BY KIND", async () => {
    await row({ sell_token: undefined, buy_token: undefined });
    assert.equal(await energyBuysInFlight(ACCOUNT, since()), true);
  });

  it("finds a submitted row BY LEGS, whatever its kind says (any case)", async () => {
    await row({ kind: "swap", target: ACCOUNT, sell_token: USDG.toUpperCase().replace("0X", "0x"), buy_token: MERRY.toUpperCase().replace("0X", "0x") });
    assert.equal(await energyBuysInFlight(ACCOUNT, since()), true);
  });

  it("does NOT count an ordinary buy in flight, or a sell OF the reserve", async () => {
    await row({ kind: "swap", buy_token: AAPL });
    await row({ kind: "swap", sell_token: MERRY, buy_token: USDG });
    assert.equal(await energyBuysInFlight(ACCOUNT, since()), false);
  });

  it("does NOT count settled rows — landed, reverted, rejected", async () => {
    for (const status of ["landed", "reverted", "rejected"]) await row({ status });
    assert.equal(await energyBuysInFlight(ACCOUNT, since()), false);
  });

  it("does NOT count a row older than the window — past any router deadline", async () => {
    const h = await row({});
    exec("UPDATE trades SET created_at = ? WHERE user_op_hash = ?", Math.floor(Date.now() / 1000) - WINDOW - 60, h);
    assert.equal(await energyBuysInFlight(ACCOUNT, since()), false);
  });

  it("is scoped to its own agent", async () => {
    await row({ agent_id: "0x00000000000000000000000000000000000e0e99" });
    assert.equal(await energyBuysInFlight(ACCOUNT, since()), false);
  });

  it("answers NULL — never false — when the ledger will not answer", async () => {
    await row({});
    exec("ALTER TABLE trades RENAME TO trades_away");
    try {
      assert.equal(await energyBuysInFlight(ACCOUNT, since()), null);
    } finally {
      exec("ALTER TABLE trades_away RENAME TO trades");
    }
    assert.equal(await energyBuysInFlight(ACCOUNT, since()), true);
  });
});

describe("listSubmittedOps carries the legs the resolver keys on", () => {
  it("returns sellToken/buyToken for a row that had them, and omits them for one that did not", async () => {
    const withLegs = await row({ kind: "swap" });
    const without = await row({ kind: "vault-deposit", sell_token: undefined, buy_token: undefined });
    const ops = await listSubmittedOps(ACCOUNT);
    const a = ops.find((o) => o.userOpHash === withLegs)!;
    const b = ops.find((o) => o.userOpHash === without)!;
    assert.equal(a.sellToken?.toLowerCase(), USDG.toLowerCase());
    assert.equal(a.buyToken?.toLowerCase(), MERRY.toLowerCase());
    assert.equal(b.sellToken, undefined);
    assert.equal(b.buyToken, undefined);
  });
});
