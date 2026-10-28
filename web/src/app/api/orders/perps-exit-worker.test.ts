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
import { orderExpiryHooks } from "../../../../../worker/src/order-receipt";
import type { AgentLimits, PerpOrderIntent } from "../../../../../worker/src/policy";
import { buildOpenDraft } from "../../../../../worker/src/perps/drafts";
import { createPaperPerpExecutor } from "../../../../../worker/src/perps/executor";
import { readLighterFeed, specToJson, type LighterFeedFileMarket } from "../../../../../worker/src/perps/feed-reader";
import { createPerpLane, type PerpLane, type PerpLaneConfig } from "../../../../../worker/src/perps/lane";
import { parseOrderBookDetails } from "../../../../../worker/src/perps/markets";
import { perpExitNotAdmittedLine, readPerpExitOrder } from "../../../../../worker/src/perps/owner-order";
import { mergeSettings, perpsWorkerStoodDown } from "../../../../../worker/src/settings";
import { ownerRejectRuleLabel } from "../../../../../worker/src/thesis-policy";
import { ownerPerpExitRefusal, type AdmissionLevel } from "../../../../../worker/src/worker-admission";

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
 * exit is re-read from its own args, asked the tenant's admission level
 * (ownerPerpExitRefusal; a self-hosted worker with nothing set trades), and
 * goes to the lane with the command's deadline. A Spot submitter is never
 * reached.
 */
function perpsWorkerRun(
  reads = { marketUnreadable: false, bookUnreadable: false, equityKnown: true },
  admission: { level: AdmissionLevel; draining: boolean } = { level: "trade", draining: false },
) {
  const no = (line: string) => ({ ok: false as const, line });
  return async (cmd: FileCommand): Promise<CommandOutcome> => {
    const wrongWallet = walletOrderRefusal("perps", orderRoute(cmd.args));
    if (wrongWallet) return no(wrongWallet);
    const reply = await placeOrder(cmd.args, orderReadsOf(reads, { paused: true, ceilingUsdg: 1 }), async (_side, _symbol, _size, route) => {
      if (!isPerpExitRoute(route)) throw new Error("a Spot submitter was reached");
      const exit = readPerpExitOrder(cmd.args ?? {});
      if (exit === null || "error" in exit) return no(exit?.error ?? "unreadable");
      const notAdmitted = ownerPerpExitRefusal(admission);
      if (notAdmitted) return no(perpExitNotAdmittedLine(exit.order, ownerRejectRuleLabel(notAdmitted) ?? notAdmitted));
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
 * on the Perps grant's account (index.ts runQueuedCommand's `account`), with
 * the drain's own expiry hooks as runQueuedCommand passes them, so a late exit
 * is answered here in the words the worker answers it in.
 */
const drainPerps = (armed: string = PERPS, level: AdmissionLevel = "trade", at: { lever?: string; now?: () => number } = {}) => {
  const cfg = mergeSettings({}, { MERRYMEN_WALLET_PURPOSE: "perps", MERRYMEN_PERPS: at.lever ?? "paper" });
  return runTickCommand(purposeHome("perps"), {
    now: at.now ?? Date.now,
    mayRun: () => !perpsWorkerStoodDown(cfg),
    run: perpsWorkerRun(undefined, { level, draining: false }),
    told: async () => {},
    account: () => armed,
    ...orderExpiryHooks,
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

  /**
   * A TENANT HELD BY THE ROLLOUT CLOSES NOTHING ON ITS OWNER'S ORDER. Its
   * owner's Spot sell is refused `rollout-hold` at processIntentLocked; an exit
   * never passes there (the lane books it), so it is asked the same level
   * before the lane. At `observe` the claimed command is answered and never
   * run — the position stays, and a Close all pauses nothing — and at
   * `exits-only` the same Close closes it.
   */
  it("AT OBSERVE (a tenant the rollout holds) the exit is answered, not run: the position stays and Close all pauses nothing; at exits-only it closes", async () => {
    await openPractice();
    const before = await held();
    assert.equal(before, 1);
    const close = await post({ purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper", expectedAccount: PERPS });
    assert.equal(close.status, 200);
    const { id } = (await close.json()) as { id: string };
    await drainPerps(PERPS, "observe");
    const state = readCommandState(purposeHome("perps"), id);
    assert.equal(state?.state, "done", "claimed and answered, so it is never run later");
    assert.deepEqual({ ok: state?.result?.ok, line: state?.result?.line }, {
      ok: false,
      line: "BTC-PERP: not closed — trading is on hold for this agent while the service brings agents back — so nothing was sent and its stop stays in place. Ask again once it is back.",
    });
    assert.equal(await held(), before, "the practice position is untouched");
    const all = await post({ purpose: "flatten-perps", side: "sell", symbol: "ALL-PERPS", usdgAmount: 0, expectedAccount: PERPS });
    assert.equal(all.status, 200);
    const { id: allId } = (await all.json()) as { id: string };
    await drainPerps(PERPS, "observe");
    assert.match(readCommandState(purposeHome("perps"), allId)?.result?.line ?? "", /^Close all did not run — trading is on hold .* nothing was paused\./);
    assert.equal(await held(), before);
    assert.equal((await store.getPerpAccount(agentId, "paper"))?.entriesHalted ?? false, false, "no halt was written for a Close all that did not run");
    // Drained again at observe, nothing runs: the claim was the unlink.
    await drainPerps(PERPS, "observe");
    assert.equal(await held(), before);
    // exits-only admits an exit: the owner's next Close closes it (and leaves the book empty for the next case).
    const again = await post({ purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper", expectedAccount: PERPS });
    assert.equal(again.status, 200);
    const { id: againId } = (await again.json()) as { id: string };
    await drainPerps(PERPS, "exits-only");
    assert.equal(readCommandState(purposeHome("perps"), againId)?.result?.line, "BTC-PERP: the practice position was closed.");
    assert.equal(await held(), 0);
  });

  /**
   * WHY AN EXIT IS REFUSED WHERE NO PERPS WORKER RUNS (D1) — and it is not
   * that a queued exit "would run whenever perps came back". Every exit
   * carries its order window (the route's expiresAt). One queued at paper and
   * still waiting when the operator stands perps down is claimed by nothing
   * (D19), and a worker back under paper after the window answers it expired
   * and sends nothing. The route's header, perps-enabled.ts and docs/perps.md
   * gave the late run as the reason — contradicting the docs' own account of
   * the deadline — and say this now; pinned beside the behaviour.
   */
  it("AN EXIT THAT WAITED OUT A STAND-DOWN PAST ITS WINDOW IS ANSWERED EXPIRED, NEVER RUN LATE — and the reasons given for D1's refusal say so", async () => {
    // No practice position is opened for it (the day's opens are the other
    // cases'): an exit that ran would be answered in the lane's words, "there
    // is no practice position to close", and one never run is answered
    // "expired" by the drain. lane.test.ts holds the same with a position held.
    assert.equal(await held(), 0);
    const res = await post({ purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper", expectedAccount: PERPS });
    assert.equal(res.status, 200);
    const { id } = (await res.json()) as { id: string };
    const [cmd] = openCommands(purposeHome("perps"));
    assert.equal(cmd?.id, id);
    assert.equal(typeof cmd?.expiresAt, "number", "every exit carries its window");
    // Perps stood down (MERRYMEN_PERPS off): the worker's drain claims nothing.
    await drainPerps(PERPS, "trade", { lever: "off" });
    assert.equal(readCommandState(purposeHome("perps"), id)?.state, "queued");
    // Back under paper a day later: answered expired, and nothing is closed.
    await drainPerps(PERPS, "trade", { now: () => cmd!.expiresAt! + 86_400_000 });
    const state = readCommandState(purposeHome("perps"), id);
    assert.equal(state?.state, "done", "answered, so it can never run later either");
    assert.equal(state?.result?.ok, false);
    assert.match(
      state?.result?.line ?? "",
      /^expired — I picked up this close of BTC-PERP .* after its window closed, so it did not run: nothing was sent and no practice position was closed\. Ask again if you still want it\.$/,
      "the exit's own expiry sentence",
    );
    assert.doesNotMatch(state?.result?.line ?? "", /there is no practice position to close|position was closed\.$|fill|different market/, "never the lane's answer, nor the drain's Spot order sentence");

    // Comment leaders and line breaks out, so a sentence reads as one line.
    const prose = (text: string) => text.replace(/\n[ \t]*\*[ \t]?/g, " ").replace(/\s+/g, " ");
    const said = {
      "orders/route.ts": prose(readFileSync(path.join(import.meta.dirname, "route.ts"), "utf8")),
      "lib/perps-enabled.ts": prose(readFileSync(path.join(process.cwd(), "web", "src", "lib", "perps-enabled.ts"), "utf8")),
      "docs/perps.md": prose(readFileSync(path.join(process.cwd(), "docs", "perps.md"), "utf8")),
    };
    for (const [where, text] of Object.entries(said)) {
      // assert.ok, not doesNotMatch: a failure names the file, not the whole of it.
      assert.ok(!/(?:would|to) run whenever perps came back/.test(text), `${where} must not give a late run as the reason`);
    }
    assert.ok(/an exit queued then could only wait, unclaimed, inside the order window every exit carries \(`expiresAt`/.test(said["orders/route.ts"]), "orders/route.ts names the window");
    assert.ok(/a command queued for the book would only wait, unclaimed, inside the window every Perps exit and reset carries \(`expiresAt`\)/.test(said["lib/perps-enabled.ts"]), "lib/perps-enabled.ts names the window");
    assert.ok(/an exit queued then could only wait, unclaimed, inside its window \(`expiresAt`/.test(said["docs/perps.md"]), "docs/perps.md names the window");
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
    // AND THE NEXT OPEN IS REFUSED, as the name says: the flag in the ledger
    // is only half of it. The lane that drained this command must read the
    // halt back for the account the route queued it for, or the strategy
    // reopens the moment the owner is told everything was closed.
    writeFeed();
    const read = await lane.refresh();
    assert.equal(read.view?.opensBlocked, "perps-entries-halted");
    const built = buildOpenDraft({ market: read.view!.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    assert.deepEqual(await lane.execute({ ...built.draft } as PerpOrderIntent, { equityUsdg: u(100), equityKnown: true }), {
      status: "rejected",
      rejectRule: "perp-entries-halted",
    });
    assert.equal(await held(), 0, "nothing opened after the owner's Close all");
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
