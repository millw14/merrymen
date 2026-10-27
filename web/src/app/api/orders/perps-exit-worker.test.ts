/**
 * AN EXIT QUEUED HERE IS THE EXACT SHAPE THE PERPS WORKER CARRIES OUT —
 * end to end, from the route to a practice position closed.
 *
 * A route that queues a shape the worker does not execute is the failure this
 * slice exists to close: the owner is told the exit was queued while the
 * position stays open. So nothing between the two is stood in for:
 *   1. the real POST /api/orders?wallet=perps writes the command file into
 *      the Perps home (self-hosted; hosted, the ferry writes the same file into
 *      the Perps child's home: worker/src/perps-order-ferry.test.ts);
 *   2. the real drain (command-files.ts runTickCommand) claims it, as a Perps
 *      worker at MERRYMEN_PERPS=paper does (settings.ts perpsWorkerStoodDown);
 *   3. the worker's dispatch, built from the same exported gates in the same
 *      order as index.ts runOrderCommand (the wallet first, then placeOrder,
 *      then the exit re-read from its own args to the lane; lane.test.ts pins
 *      that wiring in index.ts), runs the real paper PerpLane against a real
 *      store and a practice position it opened;
 *   4. the answer is read back through the real GET.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { openCommands, readCommandState, runTickCommand, type CommandOutcome, type FileCommand } from "../../../../../worker/src/command-files";
import type { ExecMode } from "../../../../../worker/src/exec-mode";
import { purposeHome } from "../../../../../worker/src/home";
import { isPerpExitRoute, orderReadsOf, orderRoute, placeOrder, walletOrderRefusal } from "../../../../../worker/src/order-gate";
import type { AgentLimits, PerpOrderIntent } from "../../../../../worker/src/policy";
import { buildOpenDraft } from "../../../../../worker/src/perps/drafts";
import { createPaperPerpExecutor } from "../../../../../worker/src/perps/executor";
import { readLighterFeed, specToJson, type LighterFeedFileMarket } from "../../../../../worker/src/perps/feed-reader";
import { createPerpLane, type PerpLane, type PerpLaneConfig } from "../../../../../worker/src/perps/lane";
import { parseOrderBookDetails } from "../../../../../worker/src/perps/markets";
import { readPerpExitOrder } from "../../../../../worker/src/perps/owner-order";
import { mergeSettings, perpsWorkerStoodDown } from "../../../../../worker/src/settings";

const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SETTINGS_FILE", "DATABASE_URL", "MERRYMEN_PERPS", "MERRYMEN_TICK_SECONDS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const SPOT = `0x${"11".repeat(20)}` as const;
const PERPS = `0x${"22".repeat(20)}` as const;
const FIXTURES = path.join(process.cwd(), "worker", "src", "perps", "fixtures");
const BTC = parseOrderBookDetails(JSON.parse(readFileSync(path.join(FIXTURES, "orderBookDetails.perp.json"), "utf8")))!.markets.get(1)!;
const u = (n: number) => BigInt(Math.round(n * 1e6));
const PAPER: ExecMode = { mode: "paper", rule: "live-not-enabled" };

const scratch = mkdtempSync(path.join(os.tmpdir(), "mm-perps-exit-worker-"));
const FEED = path.join(scratch, "lighter-feed.json");
let store: typeof import("../../../../../worker/src/store");
let POST: (req: Request) => Promise<Response>;
let GET: (req: Request) => Promise<Response>;
let lane: PerpLane;
let agentId: string;
const clock = Date.now();

/** A fresh Lighter feed file for BTC-PERP, as the fleet feed writes it. */
function writeFeed(mark = 802_000n): void {
  const m: LighterFeedFileMarket = {
    observedAt: clock - 1_000,
    priceSource: "ws",
    mark: mark.toString(),
    index: mark.toString(),
    status: "active",
    spec: specToJson(BTC.spec),
    specObservedAt: clock - 60_000,
    takerFeePpm: 0,
    makerFeePpm: 0,
    bids: [[(mark - 100n).toString(), "1000"]],
    asks: [[mark.toString(), "1000"]],
    bookObservedAt: clock - 1_000,
    bookSource: "ws",
  };
  writeFileSync(FEED, JSON.stringify({ v: 1, observedAt: clock - 500, markets: { "1": m } }));
}

const CFG: PerpLaneConfig = {
  perpsEnabled: true,
  liveTradingEnabled: false,
  perpsLiveEnabled: false,
  perpsDriver: "manual",
  perpsMarkets: ["BTC-PERP"],
  perpsMaxLeverage: 2,
  perpsPerTradeUsdg: 25,
  perpsMaxOpenNotionalUsdg: 50,
  perpsMaxCollateralUsdg: 30,
  perpsMaxOpensPerDay: 4,
  perpsStopLossPct: 5,
  perpsStopSlipBps: 200,
  perpsTakeProfitPct: 0,
  perpsLiqBufferPct: 2,
  perpsMaxSlippageBps: 50,
  perpsOperatorCeiling: "paper",
  perpsLiveTenants: null,
  perpsEntriesHalted: false,
  paperStartUsdg: 100,
};

before(async () => {
  process.env.MERRYMEN_HOME = path.join(scratch, "home");
  process.env.MERRYMEN_PERPS = "paper";
  process.env.MERRYMEN_SETTINGS_FILE = path.join(scratch, "no-such-settings.json");
  for (const k of ["MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_TICK_SECONDS"] as const) delete process.env[k];
  mkdirSync(purposeHome("perps"), { recursive: true });
  writeFileSync(path.join(process.env.MERRYMEN_HOME, "grant.json"), JSON.stringify({ smartAccount: SPOT, demoOwnerPrivateKey: `0x${"33".repeat(32)}` }));
  writeFileSync(path.join(purposeHome("perps"), "grant.json"), JSON.stringify({ smartAccount: PERPS, purpose: "perps" }));
  // The worker's store, opened as lane.test.ts opens it (from a scratch cwd).
  mkdirSync(path.join(scratch, "cwd"));
  store = await import("../../../../../worker/src/store");
  const cwd = process.cwd();
  try {
    process.chdir(path.join(scratch, "cwd"));
    await store.initStore();
  } finally {
    process.chdir(cwd);
  }
  ({ POST, GET } = await import("./route"));
  agentId = await store.ensureAgent({
    smartAccount: PERPS,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: 2_000_000_000,
    chainId: 4663,
    purpose: "perps",
  } as never);
  await store.getPaperBook(agentId, 100);
  const limits: AgentLimits = {
    perTradeUsdg: u(50),
    dailyUsdg: u(500),
    allowedTargets: [],
    allowedAssets: [],
    maxDrawdownBps: 1_000,
    expiresAt: Math.floor(clock / 1000) + 30 * 86_400,
    maxOpsPerDay: 48,
  };
  lane = createPerpLane({
    store,
    armed: () => ({ agentId, smartAccount: PERPS, limits }),
    config: () => CFG,
    execMode: () => PAPER,
    readFeed: (now) => readLighterFeed(FEED, now),
    now: () => clock,
    agentState: async ({ equityUsdg, equityKnown }) => ({
      spentTodayUsdg: 0n,
      opsToday: 0,
      highWaterMarkUsdg: u(100),
      equityUsdg,
      equityKnown,
      nowSec: Math.floor(clock / 1000),
    }),
    budget: { reserve: () => {}, release: () => {}, refresh: async () => {} },
    events: async () => {},
    decide: async () => ({ ok: true }),
    paperExecutor: (o) => createPaperPerpExecutor(o),
    log: () => {},
  });
});
after(() => {
  store?.closeStoreForTest();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Open one practice BTC position, as the lane's own route would. */
async function openPractice(): Promise<void> {
  writeFeed();
  const view = (await lane.refresh()).view!;
  const built = buildOpenDraft({ market: view.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
  assert.ok(built.ok);
  const opened = await lane.execute({ ...built.draft } as PerpOrderIntent, { equityUsdg: u(100), equityKnown: true });
  assert.equal(opened.status, "paper", JSON.stringify(opened));
}
const held = async () => (await store.getPerpPositions(agentId, "paper")).length;

/**
 * A Perps worker's dispatch of one claimed order: index.ts runOrderCommand, in
 * its order — the wallet first (walletOrderRefusal), then placeOrder, whose
 * exit goes to the lane with the order re-read from its own args and the
 * command's deadline. A Spot submitter is never reached.
 */
function perpsWorkerRun(reads = { marketUnreadable: false, bookUnreadable: false, equityKnown: true }) {
  const no = (line: string) => ({ ok: false as const, line });
  return async (cmd: FileCommand): Promise<CommandOutcome> => {
    const wrongWallet = walletOrderRefusal("perps", orderRoute(cmd.args));
    if (wrongWallet) return no(wrongWallet);
    const reply = await placeOrder(cmd.args, orderReadsOf(reads, { paused: true, ceilingUsdg: 1 }), async (_side, _symbol, _size, route) => {
      if (!isPerpExitRoute(route)) throw new Error("a Spot submitter was reached");
      const exit = readPerpExitOrder(cmd.args ?? {});
      if (exit === null || "error" in exit) return no(exit?.error ?? "unreadable");
      const notAfterMs = typeof cmd.expiresAt === "number" ? cmd.expiresAt : undefined;
      const result =
        exit.order.purpose === "close-perp"
          ? await lane.close(exit.order.symbol, { book: exit.order.book, notAfterMs })
          : await lane.flatten({ ...(exit.order.book ? { book: exit.order.book } : {}), notAfterMs, askedAt: cmd.at });
      return { ok: result.ok, line: result.sentence };
    });
    return { ok: reply.ok, line: reply.line };
  };
}
/**
 * The Perps worker's drain at MERRYMEN_PERPS=paper, over the Perps home, armed
 * on the Perps grant's account (index.ts runQueuedCommand's `account`).
 */
const drainPerps = (armed: string = PERPS) => {
  const cfg = mergeSettings({}, { MERRYMEN_WALLET_PURPOSE: "perps", MERRYMEN_PERPS: "paper" });
  return runTickCommand(purposeHome("perps"), {
    now: Date.now,
    mayRun: () => !perpsWorkerStoodDown(cfg),
    run: perpsWorkerRun(),
    told: async () => {},
    account: () => armed,
  });
};
const post = (body: object) =>
  POST(new Request("https://app.example.test/api/orders?wallet=perps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("from POST /api/orders?wallet=perps to a practice position closed", () => {
  it("CLOSE: the route's command is drained by the Perps worker, closes the practice BTC position, and GET reads the answer", async () => {
    await openPractice();
    assert.equal(await held(), 1);
    const res = await post({ purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper", expectedAccount: PERPS });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const { id } = (await res.json()) as { id: string };
    assert.equal(openCommands(process.env.MERRYMEN_HOME!).length, 0, "nothing for the Spot worker");
    assert.equal(openCommands(purposeHome("perps")).length, 1, "it waits in the Perps home, which only the Perps worker drains");
    await drainPerps();
    const state = readCommandState(purposeHome("perps"), id);
    assert.equal(state?.state, "done");
    assert.deepEqual({ ok: state?.result?.ok, line: state?.result?.line }, { ok: true, line: "BTC-PERP: the practice position was closed." });
    assert.equal(await held(), 0, "the position the owner asked to close is closed");
    const read = (await (await GET(new Request(`https://app.example.test/api/orders?wallet=perps&id=${id}`))).json()) as { state: string; result: string; ok: boolean };
    assert.deepEqual({ state: read.state, result: read.result, ok: read.ok }, { state: "done", result: "BTC-PERP: the practice position was closed.", ok: true });
    // And drained again, nothing runs twice: the claim was the unlink.
    await drainPerps();
    assert.equal(readCommandState(purposeHome("perps"), id)?.result?.line, "BTC-PERP: the practice position was closed.");
  });

  it("A CLOSE ASKED FOR ON ONE ACCOUNT IS NEVER CARRIED OUT ON ANOTHER made since in the same Perps home: answered, and the position stays", async () => {
    await openPractice();
    const before = await held();
    const res = await post({ purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper", expectedAccount: PERPS });
    assert.equal(res.status, 200);
    const { id } = (await res.json()) as { id: string };
    // The Perps wallet made again under another owner key: another account, the same home.
    await drainPerps(`0x${"44".repeat(20)}`);
    const state = readCommandState(purposeHome("perps"), id);
    assert.equal(state?.state, "done");
    assert.equal(state?.result?.ok, false);
    assert.match(state?.result?.line ?? "", /^not run — this was asked for the account 0x2222…2222/);
    assert.equal(await held(), before, "nothing was closed");
    // Back on the account it was asked for, a Close closes it (and leaves the book empty for the next case).
    const again = await post({ purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper", expectedAccount: PERPS });
    assert.equal(again.status, 200);
    await drainPerps();
    assert.equal(await held(), 0);
  });

  it("CLOSE ALL WITH NO BOOK (D11): every practice position closed, entries halted, and the next open refused", async () => {
    await openPractice();
    const res = await post({ purpose: "flatten-perps", side: "sell", symbol: "ALL-PERPS", usdgAmount: 0, expectedAccount: PERPS });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const { id } = (await res.json()) as { id: string };
    await drainPerps();
    const state = readCommandState(purposeHome("perps"), id);
    assert.equal(state?.result?.ok, true, state?.result?.line);
    assert.match(state?.result?.line ?? "", /Every practice perpetual position was closed/);
    assert.equal(await held(), 0);
    assert.equal((await store.getPerpAccount(agentId, "paper"))?.entriesHalted, true);
  });

  it("the same command on the Spot wallet's worker is refused before anything is built", () => {
    for (const args of [
      { purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper" },
      { purpose: "flatten-perps", side: "sell", symbol: "ALL-PERPS", usdgAmount: 0 },
    ]) {
      assert.match(walletOrderRefusal("spot", orderRoute(args)) ?? "", /Spot wallet holds no perpetual positions/);
    }
  });
});
