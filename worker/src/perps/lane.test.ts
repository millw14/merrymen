/**
 * THE PERP LANE'S OWN RULES — the parts paper-e2e.integration.test.ts does not
 * pin by telling a story:
 *
 *   the stage's rail   a live account with perps on is refused
 *                      `perp-live-not-yet`, whatever else is true; paper rides
 *                      perpsModeOf unchanged.
 *   the reservation    reserved after BOTH policy passes, released on every
 *                      exit — a throw from the executor included.
 *   the owner's line   a refusal is said once per change, never once a tick.
 *   one writer         a `strategist` driver with no real model is nobody; the
 *                      strategist's handoff is consumed by one route and gone.
 *   the reset          a paper reset clears the book and every memory of it.
 *   the feed host      one feed per self-hosted process, none in a hosted child.
 *   the owner's exits  Close and Close all close what is held, reduce-only,
 *                      filed as the owner's; Close all halts entries first;
 *                      a practice book that is not the account's is frozen.
 *   at most once       a crash between closing and answering never closes
 *                      again, and a stood-down Perps worker claims nothing.
 *   the wiring         index.ts calls the protective loop from the arm, never
 *                      from tick(); lane.ts and protect.ts read nothing from
 *                      the chain's market read; every paper_book
 *                      read-modify-write in index.ts runs under the lane lock;
 *                      an owner's exit reaches the lane after the wallet check.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { queuedCommandIds, readCommandState, runTickCommand, writeCommand, type FileCommand } from "../command-files";
import type { ExecMode } from "../exec-mode";
import type { AgentLimits, PerpOrderIntent, TradeIntent } from "../policy";
import { perpsWalletRefusal } from "../policy";
import { mergeSettings, perpsWorkerStoodDown } from "../settings";
import { rejectRuleLabel, ownerRejectRuleLabel, rejectRuleRemedy } from "../thesis-policy";
import { buildOpenDraft } from "./drafts";
import { createPaperPerpExecutor, PerpRefused, type PerpExecutor } from "./executor";
import { readLighterFeed, specToJson, type LighterFeedFileMarket } from "./feed-reader";
import {
  PERP_LIVE_NOT_YET,
  createPerpFeedHost,
  createPerpLane,
  entryCandleOf,
  isHostedChildProcess,
  perpsRailOf,
  usdgText,
  type DecideFn,
  type PerpLane,
  type PerpLaneConfig,
} from "./lane";
import { parseOrderBookDetails } from "./markets";
import { readPerpExitOrder } from "./owner-order";
import type { PerpRouteIntent } from "./route";

const HERE = import.meta.dirname;
const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-lane-"));
mkdirSync(path.join(scratch, "cwd"));
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("../store");
try {
  process.chdir(path.join(scratch, "cwd"));
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
/** A second connection to the same file, to count what the paper engine booked. */
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));
after(() => {
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const u = (n: number) => BigInt(Math.round(n * 1e6));
const BTC = parseOrderBookDetails(JSON.parse(readFileSync(path.join(HERE, "fixtures", "orderBookDetails.perp.json"), "utf8")))!.markets.get(1)!;
const FEED = path.join(scratch, "lighter-feed.json");
let clock = 1_790_712_000_000;

function writeFeed(mark = 802_000n, bidDepth = "1000"): void {
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
    bids: [[(mark - 100n).toString(), bidDepth]],
    asks: [[mark.toString(), "1000"]],
    bookObservedAt: clock - 1_000,
    bookSource: "ws",
  };
  writeFileSync(FEED, JSON.stringify({ v: 1, observedAt: clock - 500, markets: { "1": m } }));
}

const PAPER: ExecMode = { mode: "paper", rule: "live-not-enabled" };
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
  perpsOperatorCeiling: "live",
  perpsLiveTenants: null,
  perpsEntriesHalted: false,
  paperStartUsdg: 100,
};

let n = 1;
interface Rig {
  id: string;
  lane: PerpLane;
  events: string[];
  budget: { reserved: bigint[]; released: bigint[] };
  cfg: PerpLaneConfig;
}
async function rig(
  opts: {
    cfg?: Partial<PerpLaneConfig>;
    wrap?: (ex: PerpExecutor) => PerpExecutor;
    store?: Partial<typeof store>;
    execMode?: () => ExecMode;
    decide?: DecideFn;
  } = {},
): Promise<Rig> {
  const hex = (n++).toString(16).padStart(40, "0");
  const id = await store.ensureAgent({
    smartAccount: `0x${hex}`,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: 2_000_000_000,
    chainId: 4663,
  } as never);
  await store.getPaperBook(id, 100);
  const limits: AgentLimits = {
    perTradeUsdg: u(50),
    dailyUsdg: u(500),
    allowedTargets: [],
    allowedAssets: [],
    maxDrawdownBps: 1_000,
    expiresAt: Math.floor(clock / 1000) + 30 * 86_400,
    maxOpsPerDay: 48,
  };
  const r = { id, events: [] as string[], budget: { reserved: [] as bigint[], released: [] as bigint[] }, cfg: { ...CFG, ...(opts.cfg ?? {}) } } as Rig;
  r.lane = createPerpLane({
    store: { ...store, ...(opts.store ?? {}) },
    armed: () => ({ agentId: id, smartAccount: `0x${hex}`, limits }),
    config: () => r.cfg,
    execMode: opts.execMode ?? (() => PAPER),
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
    budget: {
      reserve: (s) => void r.budget.reserved.push(s),
      release: (s) => void r.budget.released.push(s),
      refresh: async () => {},
    },
    events: async (_level, message) => void r.events.push(message),
    decide: opts.decide ?? (async () => ({ ok: true })),
    paperExecutor: (o) => (opts.wrap ?? ((x) => x))(createPaperPerpExecutor(o)),
    log: () => {},
  });
  return r;
}

async function openDraft(r: Rig): Promise<PerpOrderIntent> {
  const view = (await r.lane.refresh()).view!;
  const built = buildOpenDraft({ market: view.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
  assert.ok(built.ok);
  return { ...built.draft } as PerpOrderIntent;
}

// ── the stage's rail ────────────────────────────────────────────────────────

describe("perpsRailOf — perpsModeOf, as far as this build can honour it", () => {
  const on = { perpsEnabled: true, liveTradingEnabled: true, perpsLiveEnabled: true, ceiling: "live" as const, granted: true, venueReady: true, entriesHalted: false };
  it("a paper account rides paper perps exactly as perpsModeOf says", () => {
    assert.deepEqual(perpsRailOf(PAPER, on), { mode: "paper" });
    assert.deepEqual(perpsRailOf(PAPER, { ...on, ceiling: "off" }), { mode: "refuse", rule: "perp-operator-off" });
    assert.deepEqual(perpsRailOf(PAPER, { ...on, perpsEnabled: false }), { mode: "off" });
  });
  it("a live account with perps on is refused perp-live-not-yet whatever else is true — never practice perps beside a real book", () => {
    for (const p of [on, { ...on, perpsLiveEnabled: false }, { ...on, liveTradingEnabled: false }, { ...on, granted: false }, { ...on, venueReady: false }, { ...on, ceiling: "paper" as const }]) {
      assert.deepEqual(perpsRailOf({ mode: "live" }, p), { mode: "refuse", rule: PERP_LIVE_NOT_YET }, JSON.stringify(p));
    }
    assert.deepEqual(perpsRailOf({ mode: "live" }, { ...on, perpsEnabled: false }), { mode: "off" }, "off stays a choice, not a refusal");
  });
  it("an account that is not trading at all keeps its own reason", () => {
    assert.deepEqual(perpsRailOf({ mode: "refuse", rule: "not-armed" }, on), { mode: "refuse", rule: "not-armed" });
  });
});

describe("small pieces", () => {
  it("entryCandleOf: the 4 h bar that closed before the entry", () => {
    const H4 = 14_400_000;
    const barOpen = 1_790_697_600_000; // a 4 h boundary
    assert.equal(entryCandleOf((barOpen + H4 + 60_000) / 1000), barOpen, "an entry a minute into the next bar was taken on this one");
    assert.equal(entryCandleOf((barOpen + 2 * H4 - 1_000) / 1000), barOpen);
  });
  it("usdgText rounds toward zero and signs only when asked", () => {
    assert.equal(usdgText(12_345_678n), "12.34");
    assert.equal(usdgText(-500_001n, true), "−0.50");
    assert.equal(usdgText(1_000_000n, true), "+1.00");
    assert.equal(usdgText(0n), "0.00");
  });
  it("isHostedChildProcess: hosted mode, or any process an orchestrator gave a fleet home", () => {
    const saved = process.env.MERRYMEN_HOSTED;
    delete process.env.MERRYMEN_HOSTED;
    try {
      assert.equal(isHostedChildProcess({}), false);
      assert.equal(isHostedChildProcess({ MERRYMEN_FLEET_HOME: "/fleet" }), true);
      assert.equal(isHostedChildProcess({ MERRYMEN_FLEET_HOME: "   " }), false);
      process.env.MERRYMEN_HOSTED = "1";
      assert.equal(isHostedChildProcess({}), true);
    } finally {
      if (saved === undefined) delete process.env.MERRYMEN_HOSTED;
      else process.env.MERRYMEN_HOSTED = saved;
    }
  });
});

describe("the feed host — one per self-hosted process, none in a hosted child", () => {
  it("a hosted child never starts one, however much it is wanted", () => {
    let starts = 0;
    const h = createPerpFeedHost({ hostedChild: () => true, wanted: () => true, start: () => (starts++, { stop() {} }) });
    h.ensure();
    h.ensure();
    assert.equal(starts, 0);
    assert.equal(h.running, false);
  });
  it("self-hosted: started once when wanted, never when not, and a failed start is retried", () => {
    let starts = 0;
    let wanted = false;
    let fail = true;
    const logs: string[] = [];
    const h = createPerpFeedHost({
      hostedChild: () => false,
      wanted: () => wanted,
      start: () => {
        starts++;
        if (fail) throw new Error("no socket");
        return { stop() {} };
      },
      log: (l) => logs.push(l),
    });
    h.ensure();
    assert.equal(starts, 0, "not wanted: nothing starts");
    wanted = true;
    h.ensure();
    h.ensure();
    assert.equal(starts, 2, "a start that threw is tried again");
    assert.equal(logs.filter((l) => /could not start/.test(l)).length, 1, "and said once, not every tick");
    fail = false;
    h.ensure();
    h.ensure();
    assert.equal(starts, 3, "one feed, started once");
    assert.equal(h.running, true);
    h.stop();
    assert.equal(h.running, false);
  });
});

// ── the reservation and the owner's line ────────────────────────────────────

describe("one intent's reservation", () => {
  it("is taken only after both policy passes and the review, and released when the executor THROWS", async () => {
    writeFeed();
    const r = await rig({
      wrap: (ex) => ({
        ...ex,
        mode: ex.mode,
        review: ex.review.bind(ex),
        setLeverage: ex.setLeverage?.bind(ex),
        place: async () => {
          throw new Error("the ledger went away");
        },
      }),
    });
    const out = await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.deepEqual(out, { status: "rejected", rejectRule: "perp-unpriced" }, "an unknown is a refusal, never a fill");
    assert.equal(r.budget.reserved.length, 1);
    assert.deepEqual(r.budget.released, r.budget.reserved, "the finally released exactly what was reserved");
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0);
  });

  it("is never taken when the review refuses", async () => {
    writeFeed();
    const r = await rig({
      wrap: (ex) => ({
        ...ex,
        mode: ex.mode,
        setLeverage: ex.setLeverage?.bind(ex),
        place: ex.place.bind(ex),
        review: async () => {
          throw new PerpRefused("perp-unpriced", "the book is older than 10 s");
        },
      }),
    });
    const out = await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.deepEqual(out, { status: "rejected", rejectRule: "perp-unpriced" });
    assert.equal(r.budget.reserved.length, 0);
  });

  it("the owner hears a refusal once per change, not once a tick", async () => {
    writeFeed();
    const r = await rig({ cfg: { perpsMaxCollateralUsdg: 5 } });
    const intent = await openDraft(r);
    for (let i = 0; i < 3; i++) await r.lane.execute({ ...intent }, { equityUsdg: u(100), equityKnown: true });
    assert.equal(r.events.filter((e) => /refused — perp-collateral-cap/.test(e)).length, 1);
  });

  it("an exit with nothing held is refused by name — perp-no-position — and books nothing", async () => {
    writeFeed();
    const r = await rig();
    const out = await r.lane.execute(
      { kind: "perp-order", venue: "lighter", market: "BTC-PERP", marketId: 1, effect: "close", side: "long", reduceOnly: true, baseAmount: 20n, worstPrice: 790_000n, markPrice: 802_000n, notionalUsdg: 0n },
      { equityUsdg: u(100), equityKnown: true },
    );
    assert.deepEqual(out, { status: "rejected", rejectRule: "perp-no-position" });
  });

  it("a margin move on a paper book is refused: paper margin moves with each fill", async () => {
    writeFeed();
    const r = await rig();
    const out = await r.lane.execute({ kind: "perp-margin", direction: "withdraw", amountUsdg: u(5) }, { equityUsdg: u(100), equityKnown: true });
    assert.equal(out.status, "rejected");
    assert.equal(r.budget.reserved.length, 0);
  });
});

// ── one writer per book ─────────────────────────────────────────────────────

describe("the route's producer", () => {
  it("a strategist driver with no real model behind it is nobody, and the handoff is gone after one tick", async () => {
    writeFeed();
    const r = await rig({ cfg: { perpsDriver: "strategist" } });
    const intent = await openDraft(r);
    await r.lane.readWithBook(() => store.getPaperBook(r.id, 100));
    let executed = 0;
    const hooks = {
      claimEntry: async () => ({ ok: true }),
      refundEntry: async () => {},
      withholdEntry: async () => {},
      ensureDecision: async () => ({ ok: true as const }),
      processIntentReporting: async (i: TradeIntent) => {
        executed++;
        return r.lane.execute(i as PerpOrderIntent, { equityUsdg: u(100), equityKnown: true });
      },
      processIntent: async () => {
        executed++;
      },
    };
    const tick = { equityUsdg: u(100), equityKnown: true, breakerIdle: true, energyEntriesLeft: true, opsHeadroom: true, spendHeadroomMicro: u(500) };
    r.lane.deliverStrategist([intent as PerpRouteIntent]);
    await r.lane.runRoute({ ...tick, strategistLive: false }, hooks);
    assert.equal(executed, 0, "manual: the strategist's intents are not read");
    await r.lane.runRoute({ ...tick, strategistLive: true }, hooks);
    assert.equal(executed, 0, "and the handoff did not survive to the next tick");
    r.lane.deliverStrategist([intent as PerpRouteIntent]);
    await r.lane.runRoute({ ...tick, strategistLive: true }, hooks);
    assert.equal(executed, 1, "with a real model, the strategist's one entry goes through the lane");
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
  });
});

describe("an unreadable paper ledger", () => {
  it("is a gap — the tick's read does not throw, the book is unread, and an open is refused", async () => {
    writeFeed();
    const r = await rig({
      store: {
        perpLaneLedgerFacts: async () => {
          throw new Error("perp_orders x: an amount is unreadable");
        },
      },
    });
    const { read } = await r.lane.readWithBook(() => store.getPaperBook(r.id, 100));
    assert.equal(read.book, "unread", "unknown is never zero (rule 11)");
    assert.equal(read.view, null);
    assert.equal(read.report.collateralMicro, null, "the report says it could not be read, never 'no positions'");
    const out = await r.lane.execute(
      {
        kind: "perp-order",
        venue: "lighter",
        market: "BTC-PERP",
        marketId: 1,
        effect: "open",
        side: "long",
        reduceOnly: false,
        baseAmount: 20n,
        worstPrice: 806_010n,
        markPrice: 802_000n,
        notionalUsdg: 16_121_000n,
        imfBp: 5_000,
        stopTrigger: 778_000n,
        stopPrice: 762_440n,
      },
      { equityUsdg: u(100), equityKnown: true },
    );
    assert.equal(out.status, "rejected");
    assert.equal(r.budget.reserved.length, 0);
  });
});

describe("a paper reset", () => {
  it("runs under the lane lock and leaves no memory of the old book", async () => {
    writeFeed();
    const r = await rig();
    const out = await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.equal(out.status, "paper");
    assert.equal((await r.lane.refresh()).held, true);
    // Main's reset refuses an agent not on the paper rail.
    await store.setAgentMode(r.id, "paper", 1, false);
    await r.lane.resetPaper(() => store.resetPaperLedger(r.id, 100));
    const after = await r.lane.refresh();
    assert.equal(after.held, false);
    assert.equal(after.view?.positions.size, 0);
    assert.equal((await store.getPaperBook(r.id, 100)).cashUsdg, 100);
  });
});

// ── the owner's exits ───────────────────────────────────────────────────────

const fillsOf = (id: string): number =>
  Number((raw.prepare("SELECT COUNT(*) AS n FROM perp_fills WHERE agent_id = ? AND mode = 'paper'").get(id.toLowerCase()) as { n: number }).n);

describe("the owner's exits on a paper book (owner-order.ts close-perp, flatten-perps)", () => {
  it("Close all closes every practice position and halts new entries first — the next open is refused perp-entries-halted", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
    await r.lane.report();
    const reported = () => (JSON.parse(String((raw.prepare("SELECT perps FROM agents WHERE smart_account = ?").get(r.id) as { perps: string }).perps)) as { positions: unknown[] }).positions.length;
    assert.equal(reported(), 1);
    // No book: the desk could not read which book it saw, so every book (D11) — here, the practice one.
    const out = await r.lane.flatten({});
    assert.equal(reported(), 0, "agents.perps says so at once, not at the next pass");
    assert.equal(out.ok, true, out.sentence);
    assert.match(out.sentence, /Every practice perpetual position was closed/);
    assert.match(out.sentence, /New practice positions are paused until you reset the practice book/);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0);
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, true, "the halt is in the ledger, not only in this process");
    const read = await r.lane.refresh();
    assert.equal(read.view?.opensBlocked, "perps-entries-halted");
    assert.deepEqual(await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true }), { status: "rejected", rejectRule: "perp-entries-halted" });
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0, "nothing opened after the owner's Close all");
  });

  it("a close is filed as the owner's — source chat, reduce-only, the full size held — before anything is placed", async () => {
    writeFeed();
    const asked: { source: string; reason?: string; intent: TradeIntent }[] = [];
    const r = await rig({ decide: async (intent, source, reason) => (asked.push({ source, reason, intent: { ...intent } }), { ok: true }) });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const held = (await store.getPerpPositions(r.id, "paper"))[0]!;
    const out = await r.lane.close("BTC-PERP", { book: "paper" });
    assert.equal(out.ok, true, out.sentence);
    assert.equal(out.sentence, "BTC-PERP: the practice position was closed.");
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.source, "chat", "provenance.ts reads `chat` as owner-command");
    assert.match(asked[0]!.reason ?? "", /the owner asked to close BTC-PERP reduce-only/);
    const intent = asked[0]!.intent as PerpOrderIntent;
    assert.equal(intent.effect, "close");
    assert.equal(intent.reduceOnly, true);
    assert.equal(intent.side, held.side);
    assert.equal(intent.baseAmount, held.base);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0);
  });

  it("a close whose decision cannot be written sends nothing — a fill nobody can attribute is not the owner's", async () => {
    writeFeed();
    let refuse = false;
    const r = await rig({ decide: async () => (refuse ? { ok: false, why: "the decisions table did not answer" } : { ok: true }) });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const fills = fillsOf(r.id);
    refuse = true;
    const out = await r.lane.close("BTC-PERP", { book: "paper" });
    assert.equal(out.ok, false);
    assert.match(out.sentence, /could not be recorded, so nothing was sent/);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
    assert.equal(fillsOf(r.id), fills);
  });

  it("owner close remains available with entries disabled and refuses an expired request", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    r.cfg.perpsEnabled = false;
    r.cfg.perpsEntriesHalted = true;
    assert.equal((await r.lane.close("BTC-PERP", { book: "paper", notAfterMs: clock - 1 })).ok, false);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
    // At the deadline itself it still runs (command-files.ts isExpired's edge).
    const out = await r.lane.close("BTC-PERP", { book: "paper", notAfterMs: clock });
    assert.equal(out.ok, true, out.sentence);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0);
    const late = await r.lane.flatten({ notAfterMs: clock - 1 });
    assert.equal(late.ok, false);
    assert.match(late.sentence, /expired before it could run\. Nothing was sent and nothing was paused/);
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted ?? false, false, "an expired Close all pauses nothing either");
  });

  it("partial practice closes and flatten attempts report the position still open", async () => {
    for (const action of ["close", "flatten"] as const) {
      writeFeed();
      const r = await rig();
      await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
      const before = (await store.getPerpPositions(r.id, "paper"))[0]!.base;
      assert.ok(before > 1n);
      writeFeed(802_000n, "1");
      const out = action === "close" ? await r.lane.close("BTC-PERP", { book: "paper" }) : await r.lane.flatten({ book: "paper" });
      const after = (await store.getPerpPositions(r.id, "paper"))[0]!.base;
      assert.ok(after > 0n && after < before, "the IOC filled only available liquidity");
      assert.equal(out.ok, false);
      assert.match(out.sentence, /remains? open/);
      assert.doesNotMatch(out.sentence, /position was closed|Every practice perpetual position was closed/);
    }
  });

  it("a failed halt write still closes and keeps this worker from reopening, without claiming a durable pause", async () => {
    writeFeed();
    const r = await rig({ store: { patchPerpAccount: async () => { throw new Error("ledger write unavailable"); } } });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const out = await r.lane.flatten({});
    assert.equal(out.ok, false);
    assert.match(out.sentence, /pause could not be saved/);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0, "exit still attempted");
    assert.equal((await r.lane.refresh()).view?.opensBlocked, "perps-entries-halted");
    await r.lane.armed();
    await r.lane.stopProtect();
    assert.equal((await r.lane.refresh()).view?.opensBlocked, "perps-entries-halted", "re-arm never clears an unsaved owner halt");
  });

  it("A PRACTICE RESET ASKED FOR AFTER CLOSE ALL LIFTS ITS HALT, in the reset's own transaction, and practice entries open again", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.equal((await r.lane.flatten({ askedAt: clock - 5_000 })).ok, true);
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, true);
    await store.setAgentMode(r.id, "paper", 1, false);
    const told: boolean[] = [];
    await r.lane.resetPaper(
      ({ clearEntriesHalt }) => (told.push(clearEntriesHalt), store.resetPaperLedger(r.id, 100, { clearEntriesHalt })),
      { askedAt: clock - 1_000 },
    );
    assert.deepEqual(told, [true]);
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, false, "the ledger's halt went with the old book");
    assert.notEqual((await r.lane.refresh()).view?.opensBlocked, "perps-entries-halted");
    assert.equal((await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true })).status, "paper", "a practice entry opens on the new book");
  });

  it("A RESET ASKED FOR BEFORE THE CLOSE ALL NEVER LIFTS IT (hosted, the reset can reach the worker second), and one that cannot say when lifts nothing", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.equal((await r.lane.flatten({ askedAt: clock - 1_000 })).ok, true);
    await store.setAgentMode(r.id, "paper", 1, false);
    for (const opts of [{ askedAt: clock - 5_000 }, {}]) {
      const told: boolean[] = [];
      await r.lane.resetPaper(({ clearEntriesHalt }) => (told.push(clearEntriesHalt), store.resetPaperLedger(r.id, 100, { clearEntriesHalt })), opts);
      assert.deepEqual(told, [false], JSON.stringify(opts));
      assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, true, JSON.stringify(opts));
      assert.equal((await r.lane.refresh()).view?.opensBlocked, "perps-entries-halted", JSON.stringify(opts));
    }
    assert.deepEqual(await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true }), { status: "rejected", rejectRule: "perp-entries-halted" });
  });

  it("a later reset lifts a halt this worker only held in memory (its write failed), and one an earlier worker stored", async () => {
    writeFeed();
    const failing = await rig({ store: { patchPerpAccount: async () => { throw new Error("ledger write unavailable"); } } });
    assert.match((await failing.lane.flatten({ askedAt: clock - 5_000 })).sentence, /pause could not be saved/);
    assert.equal((await failing.lane.refresh()).view?.opensBlocked, "perps-entries-halted");
    await store.setAgentMode(failing.id, "paper", 1, false);
    await failing.lane.resetPaper(({ clearEntriesHalt }) => store.resetPaperLedger(failing.id, 100, { clearEntriesHalt }), { askedAt: clock - 1_000 });
    assert.notEqual((await failing.lane.refresh()).view?.opensBlocked, "perps-entries-halted");
    // Stored by a worker before this one: no memory here, so only the ledger knows, and the reset lifts it.
    const earlier = await rig();
    await store.patchPerpAccount(earlier.id, "paper", { entriesHalted: true });
    assert.equal((await earlier.lane.refresh()).view?.opensBlocked, "perps-entries-halted");
    await store.setAgentMode(earlier.id, "paper", 1, false);
    await earlier.lane.resetPaper(({ clearEntriesHalt }) => store.resetPaperLedger(earlier.id, 100, { clearEntriesHalt }), { askedAt: clock });
    assert.equal((await store.getPerpAccount(earlier.id, "paper"))?.entriesHalted, false);
    // And a reset that is not told to (every caller before this one) leaves the halt alone.
    await store.patchPerpAccount(earlier.id, "paper", { entriesHalted: true });
    await store.resetPaperLedger(earlier.id, 100);
    assert.equal((await store.getPerpAccount(earlier.id, "paper"))?.entriesHalted, true);
  });

  it("a practice book that is not the account's book is frozen (rule 14): Close and Close all send nothing", async () => {
    writeFeed();
    let mode: ExecMode = PAPER;
    const r = await rig({ execMode: () => mode });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const fills = fillsOf(r.id);
    mode = { mode: "live" };
    const close = await r.lane.close("BTC-PERP", { book: "paper" });
    assert.equal(close.ok, false);
    assert.match(close.sentence, /not on paper right now, so its practice perpetual positions stay exactly as they are/);
    const all = await r.lane.flatten({});
    assert.equal(all.ok, false);
    assert.match(all.sentence, /New practice positions are paused/, "the halt is still the owner's to have");
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
    assert.equal(fillsOf(r.id), fills);
  });

  it("a market this version does not trade, or one with nothing held, sends nothing", async () => {
    writeFeed();
    const r = await rig();
    assert.match((await r.lane.close("NOPE-PERP" as never, { book: "paper" })).sentence, /not a perpetual market this version trades\. Nothing was sent/);
    const none = await r.lane.close("BTC-PERP", { book: "paper" });
    assert.equal(none.ok, false);
    assert.equal(none.sentence, "BTC-PERP: there is no practice position to close. Nothing was sent.");
    assert.equal(fillsOf(r.id), 0);
  });
});

describe("an owner's exit, at most once (command-files.ts: the claim is the unlink)", () => {
  const homes: string[] = [];
  after(() => {
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  });
  const newHome = () => {
    const h = mkdtempSync(path.join(scratch, "cmd-home-"));
    homes.push(h);
    return h;
  };
  const closeCommand = (id: string, expiresAt = clock + 60_000): FileCommand => ({
    id,
    kind: "trade",
    at: clock - 1_000,
    args: { side: "sell", symbol: "BTC-PERP", usdgAmount: 0, purpose: "close-perp", book: "paper" },
    expiresAt,
  });
  /** index.ts runOrderCommand's exit dispatch, as a drain's `run`. */
  const dispatch = (lane: PerpLane) => async (cmd: FileCommand) => {
    const exit = readPerpExitOrder(cmd.args ?? {});
    assert.ok(exit && "order" in exit && exit.order.purpose === "close-perp");
    const r = await lane.close(exit.order.symbol, { book: exit.order.book, notAfterMs: cmd.expiresAt });
    return { ok: r.ok, line: r.sentence };
  };

  it("a worker that crashes after closing and before answering never closes again — not even a position opened since", async () => {
    writeFeed();
    const r = await rig();
    const home = newHome();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    writeCommand(home, closeCommand("exit-crash"));
    // The close books, then the process dies before the result file is written.
    await assert.rejects(
      runTickCommand(home, {
        now: () => clock,
        run: async (cmd) => {
          await dispatch(r.lane)(cmd);
          throw new Error("SIGKILL between the close and its answer");
        },
        told: async () => {},
      }),
      /SIGKILL/,
    );
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0, "the close itself landed");
    const fills = fillsOf(r.id);
    // The strategy opens BTC again before the worker comes back. A replayed
    // close would now close a position the owner never asked to close.
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
    const fillsBefore = fillsOf(r.id);
    assert.ok(fillsBefore > fills);
    // The restart's drain: the file was unlinked at the claim, so nothing is left to run.
    let ran = 0;
    await runTickCommand(home, { now: () => clock, run: async () => (ran++, { ok: true, line: "ran" }), told: async () => {} });
    assert.equal(ran, 0, "a claimed command is never run twice");
    assert.deepEqual(queuedCommandIds(home), []);
    assert.equal(readCommandState(home, "exit-crash")?.state, "running", "claimed and unanswered — the orchestrator's sweep says it may have run");
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1, "the new position is untouched");
    assert.equal(fillsOf(r.id), fillsBefore);
  });

  it("and were one ever run twice, the second finds nothing held and books nothing — a close is built from what is held", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.equal((await r.lane.close("BTC-PERP", { book: "paper" })).ok, true);
    const fills = fillsOf(r.id);
    const cash = (await store.getPaperBook(r.id, 100)).cashUsdg;
    assert.equal((await r.lane.close("BTC-PERP", { book: "paper" })).ok, false);
    const again = await r.lane.flatten({});
    assert.equal(again.ok, true, again.sentence);
    assert.match(again.sentence, /There were no practice perpetual positions open/);
    assert.equal((await r.lane.flatten({})).ok, true, "a second Close all is the same halt and the same nothing");
    assert.equal(fillsOf(r.id), fills);
    assert.equal((await store.getPaperBook(r.id, 100)).cashUsdg, cash);
  });

  it("A STOOD-DOWN PERPS WORKER (D19) claims nothing: the queued exit waits, unclaimed, and the position stays exactly as it was", async () => {
    const off = mergeSettings({}, { MERRYMEN_WALLET_PURPOSE: "perps" });
    const paper = mergeSettings({}, { MERRYMEN_WALLET_PURPOSE: "perps", MERRYMEN_PERPS: "paper" });
    assert.equal(perpsWorkerStoodDown(off), true, "unset MERRYMEN_PERPS is off");
    assert.equal(perpsWorkerStoodDown(mergeSettings({}, { MERRYMEN_WALLET_PURPOSE: "perps", MERRYMEN_PERPS: "live" })), true, "live is off in this build");
    assert.equal(perpsWorkerStoodDown(paper), false);
    assert.equal(perpsWorkerStoodDown(mergeSettings({}, {})), false, "a Spot worker is never stood down here");
    writeFeed();
    const r = await rig();
    const home = newHome();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const fills = fillsOf(r.id);
    writeCommand(home, closeCommand("exit-off"));
    let ran = 0;
    const run = dispatch(r.lane);
    await runTickCommand(home, { now: () => clock, mayRun: () => !perpsWorkerStoodDown(off), run: async (c) => (ran++, run(c)), told: async () => {} });
    assert.equal(ran, 0);
    assert.deepEqual(queuedCommandIds(home), ["exit-off"], "left in the queue, not claimed");
    assert.equal(readCommandState(home, "exit-off")?.state, "queued");
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
    assert.equal(fillsOf(r.id), fills);
    // Perps back on paper, inside the window: the worker runs it, once.
    await runTickCommand(home, { now: () => clock, mayRun: () => !perpsWorkerStoodDown(paper), run: async (c) => (ran++, run(c)), told: async () => {} });
    assert.equal(ran, 1);
    assert.equal(readCommandState(home, "exit-off")?.state, "done");
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0);
  });

  it("…and one that waited past its window is answered expired when perps come back, with nothing sent", async () => {
    writeFeed();
    const r = await rig();
    const home = newHome();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    writeCommand(home, closeCommand("exit-stale", clock - 1));
    let ran = 0;
    const paper = mergeSettings({}, { MERRYMEN_WALLET_PURPOSE: "perps", MERRYMEN_PERPS: "paper" });
    await runTickCommand(home, { now: () => clock, mayRun: () => !perpsWorkerStoodDown(paper), run: async () => (ran++, { ok: true, line: "ran" }), told: async () => {} });
    assert.equal(ran, 0);
    const state = readCommandState(home, "exit-stale");
    assert.equal(state?.state, "done");
    assert.equal(state?.result?.ok, false);
    assert.match(state?.result?.line ?? "", /^expired — .*Nothing was sent/);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
  });
});

// ── the wiring, read from source ────────────────────────────────────────────

/** Code only: comments out, so a sentence ABOUT the loop is not a call TO it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("the wiring in index.ts", () => {
  const SRC = readFileSync(path.join(HERE, "..", "index.ts"), "utf8");
  const CODE = codeOnly(SRC);
  const fn = (name: string): string => {
    const at = CODE.indexOf(`  async function ${name}(`);
    assert.ok(at > 0, `${name} must exist`);
    const end = CODE.indexOf("\n  }\n", at);
    return CODE.slice(at, end);
  };
  const PROTECT = /\b(protectPass|startProtect|stopProtect|evaluateProtection|startProtectLoop|protectCadenceMs|createPerpLaneLock)\b/;

  it("the protective loop is NEVER reached from tick() — pause and a tick's early returns cannot stop it", () => {
    const tick = fn("tick");
    assert.ok(tick.length > 10_000, "found the whole tick");
    assert.doesNotMatch(tick, PROTECT);
    assert.doesNotMatch(tick, /perpLane\.armed\(/, "the loop's start is the arm's, not the tick's");
  });

  it("it is started from the arm (syncGrant), and a settings change can start it too", () => {
    assert.match(fn("syncGrant"), /await perpLane\.armed\(\)/);
    assert.match(fn("refreshConfig"), /perpLane\.configChanged\(\)/);
  });

  it("the arm starts it BEFORE the rest of the arm tail can throw — `active` set, then the lane, then everything else (S3-02)", () => {
    // A throw after `active` is set leaves syncGrant's `unchanged`
    // short-circuit true for good: the tail never runs again, so anything
    // after the throw never happens for this arm. The loop must not be.
    const sync = fn("syncGrant");
    const activeSet = sync.indexOf("active = {");
    const armed = sync.indexOf("await perpLane.armed()");
    const firstAwaitAfter = sync.indexOf("await ", sync.indexOf("suppressedIntents.clear();"));
    assert.ok(activeSet > 0 && armed > activeSet, `${activeSet} < ${armed}`);
    assert.equal(armed, firstAwaitAfter, "armed() is the first await after `active` is set");
    assert.equal(sync.indexOf("await perpLane.armed()", armed + 1), -1, "and it is called once per arm");
    for (const later of ["refreshBudget(agentId)", "setAgentStatus(agentId, \"armed\")", "noteTokenCoverage(agentId)"]) {
      const at = sync.indexOf(later, activeSet);
      assert.ok(at > armed, `${later} runs after the lane is armed`);
    }
  });

  it("the protective loop and the lane read nothing from the chain's market read (snapshot.ts)", () => {
    for (const f of ["lane.ts", "protect.ts"]) {
      const src = readFileSync(path.join(HERE, f), "utf8");
      const imports = [...src.matchAll(/^\s*import[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);
      for (const from of imports) {
        assert.doesNotMatch(from, /snapshot|market-safety/, `${f} imports ${from}`);
      }
      assert.doesNotMatch(codeOnly(src), /readMarketSafety|isPaused/, `${f} consults the market read or pause`);
    }
  });

  it("processIntentLocked hands every perp intent to the lane, after `state` and before the EVM checkPolicy", () => {
    const locked = fn("processIntentLocked");
    const state = locked.indexOf("const state: AgentState = {");
    const branch = locked.indexOf('if (intent.kind === "perp-order" || intent.kind === "perp-margin") {');
    const verdict = locked.indexOf("const verdict = checkPolicy(intent, limits, state");
    assert.ok(state > 0 && branch > state && verdict > branch, `${state} < ${branch} < ${verdict}`);
    assert.match(locked.slice(branch, branch + 300), /lastTradeOutcome = await perpLane\.execute\(intent, \{ equityUsdg, equityKnown \}, state\);\s*return;/);
    // Main's admission gate sits before the branch and writes a `trades` row for
    // a refusal; a perp intent leaves it first, with no row (the trades boundary).
    const admission = locked.indexOf("if (admissionRule) {");
    assert.ok(admission > 0 && admission < branch);
    const guard = /if \(perpIntent\) \{\s*lastTradeOutcome = \{ status: "rejected", rejectRule: admissionRule \};\s*return;\s*\}\s*await recordTrade\(\{/;
    assert.match(locked.slice(admission, branch), guard, "a perp admission refusal returns before its trades row");
    const before = locked.slice(0, branch).replace(guard, "");
    assert.doesNotMatch(before, /executor\.|sendUserOperation|recordTrade\(\{/, "nothing EVM-shaped runs for a perp intent before the branch");
  });

  it("ONLY A PERPS WALLET'S WORKER ARMS THE LANE, and a grant for the other wallet never arms", () => {
    // The lane's agent is the armed one only on a Perps worker (settings.ts workerWalletOf).
    assert.match(CODE, /armed: \(\) =>\s*active && cfg\.workerWallet === "perps"\s*\?/);
    // syncGrant judges the grant's own signed purpose against the worker's, before the unchanged short-circuit.
    const sync = fn("syncGrant");
    const judged = sync.indexOf("if (grantWallet !== cfg.workerWallet) {");
    assert.ok(judged > 0 && judged < sync.indexOf("const unchanged ="), "the wallet is judged before anything is built from the grant");
    assert.match(sync.slice(judged, judged + 900), /active = null;\s*return false;/);
    // A Spot worker never starts the lane's loop, and its strategist is never shown perps.
    assert.match(CODE, /if \(cfg\.workerWallet === "perps"\) await perpLane\.armed\(\)/);
    assert.match(CODE, /\.\.\.\(c\.workerWallet === "perps"\s*\?\s*\{\s*perps: \{/);
  });

  it("A PERPS WALLET'S WORKER REFUSES EVERY NON-PERP INTENT, first, with no trades row", () => {
    // An owner's /buy, /transfer, app trade, self-test or energy buy is not a
    // producer the settings can turn off; it would spend the perp collateral.
    const locked = fn("processIntentLocked");
    const refusal = locked.indexOf("const walletRefusal = perpsWalletRefusal(cfg.workerWallet, intent);");
    const admission = locked.indexOf("const admissionRule = admissionRefusal(");
    assert.ok(refusal > 0 && refusal < admission, "before admission, so nothing is reserved or read");
    const body = locked.slice(refusal, locked.indexOf("\n    }\n", refusal));
    assert.match(body, /lastTradeOutcome = \{ status: "rejected", rejectRule: walletRefusal\.rule \};\s*return;/);
    // The rule itself: every non-perp kind on a Perps wallet, nothing on Spot.
    for (const kind of ["swap", "curve-trade", "transfer", "energy-buy", "equity-order"] as const) {
      assert.deepEqual(perpsWalletRefusal("perps", { kind }), { rule: "perps-wallet-spot" });
      assert.equal(perpsWalletRefusal("spot", { kind }), null);
    }
    assert.equal(perpsWalletRefusal("perps", { kind: "perp-order" }), null);
    assert.equal(perpsWalletRefusal("perps", { kind: "perp-margin" }), null);
    assert.doesNotMatch(body, /recordTrade|addTrade|reserveBudget/, "never the public tape, never the budget");
    // Told to the owner in words, and never on a public lane (rule 17).
    assert.equal(rejectRuleLabel("perps-wallet-spot"), null, "not in the public register");
    assert.ok(ownerRejectRuleLabel("perps-wallet-spot"), "the owner is told in words");
    assert.ok(rejectRuleRemedy("perps-wallet-spot"));
  });

  it("A PERPS WALLET'S WORKER PUBLISHES NO MARKET REVIEW — its source is a public one (rule 17)", () => {
    const at = CODE.indexOf("quietReview = async () => {");
    assert.ok(at > 0, "found the market review");
    const head = CODE.slice(at, CODE.indexOf("const clock = reviewClock(agentId);", at));
    assert.match(head, /if \(cfg\.workerWallet === "perps"\) return;/);
  });

  it("A PERPS WALLET'S WORKER NEVER RUNS THE BRAIN, whatever MERRYMEN_BRAIN_LIVE or _SHADOW say", () => {
    // The Brain reviews tokens and its live mode submits Spot buys.
    const tick = fn("tick");
    const gate = tick.indexOf("shadowBrainEnabledFor(agentId) || brainLiveEnabledFor(agentId)");
    assert.ok(gate > 0, "found the Brain block's gate");
    const line = tick.slice(tick.lastIndexOf("\n", gate), tick.indexOf("\n", gate));
    assert.match(line, /^\s*if \(cfg\.workerWallet !== "perps" && \(fastTrencher \|\| shadowBrainEnabledFor\(agentId\) \|\| brainLiveEnabledFor\(agentId\)\)/);
  });

  it("SIGTERM stops the protective loop and waits for it, within the drain budget, before the ledger closes", () => {
    const at = CODE.indexOf('process.on("SIGTERM", () => {');
    const handler = CODE.slice(at, CODE.indexOf("\n  });\n", at));
    const stop = handler.indexOf("const protectStopped = perpLane.stopProtect()");
    const drain = handler.indexOf("drainIntentChain({");
    const waited = handler.indexOf("protectStopped.then(() => true)");
    const close = handler.indexOf("closeStore();");
    assert.ok(stop > 0 && stop < drain && drain < waited && waited < close, `${stop} < ${drain} < ${waited} < ${close}`);
    assert.match(handler.slice(drain, waited), /drainStartedAt \+ DRAIN_INTENT_CHAIN_MS - Date\.now\(\)/, "bounded by what is left of the same budget");
  });

  it("every paper_book read-modify-write runs under the lane's lock, and the tick reads cash with the perp term", () => {
    const writes = [...CODE.matchAll(/setPaperBook\(/g)].map((m) => m.index ?? 0);
    assert.ok(writes.length >= 2);
    for (const at of writes) {
      const before = CODE.slice(Math.max(0, at - 1_600), at);
      assert.match(before, /perpLane\.serial\(async \(\) => \{/, `a setPaperBook at ${at} is outside perpLane.serial`);
    }
    assert.match(fn("tick"), /await perpLane\.readWithBook\(\(\) => getPaperBook\(agentId, cfg\.paperStartUsdg\)\)/);
    assert.match(fn("runPaperReset"), /await perpLane\.resetPaper\(/);
  });

  it("A PRACTICE RESET LIFTS A CLOSE-ALL HALT ONLY AS THE LANE DECIDES, from when the reset was asked for", () => {
    assert.match(fn("runPaperReset"), /async \(\{ clearEntriesHalt \}\) => \{\s*const epoch = await resetPaperLedger\(id, cfg\.paperStartUsdg, \{ clearEntriesHalt \}\);/);
    assert.match(fn("runPaperReset"), /\{ askedAt \},\s*\);/);
    assert.match(fn("runCommand"), /if \(cmd\.kind === "paper-reset"\) return runPaperReset\(cmd\.at\);/);
  });

  it("the route runs after the class route, inside tick(), and nothing perp is in the strategy loop", () => {
    const tick = fn("tick");
    const classEntries = tick.indexOf("await classGate.entries(");
    const route = tick.indexOf("await perpLane.runRoute(");
    assert.ok(classEntries > 0 && route > classEntries);
  });

  it("AN OWNER'S PERPETUAL EXIT reaches the lane only after the wallet check, read again from its own args, and is answered without a receipt", () => {
    const run = fn("runOrderCommand");
    const wallet = run.indexOf("const wrongWallet = walletOrderRefusal(cfg.workerWallet, orderRoute(cmd.args));");
    const gate = run.indexOf("return placeOrder(");
    assert.ok(wallet > 0 && gate > wallet, "the wallet is judged before every other gate");
    assert.match(run.slice(wallet, gate), /if \(wrongWallet\) return no\(wrongWallet\);/);
    const exit = run.indexOf("if (isPerpExitRoute(route)) {");
    const submitters = [run.indexOf("submitEnergyBuy("), run.indexOf("submitChatTrade(")];
    assert.ok(exit > gate && submitters.every((at) => at > exit), "an exit returns before any Spot submitter");
    const branch = run.slice(exit, submitters[0]);
    assert.match(branch, /const exit = readPerpExitOrder\(cmd\.args \?\? \{\}\);/);
    assert.match(branch, /await perpLane\.close\(exit\.order\.symbol, \{ book: exit\.order\.book, notAfterMs \}\)/);
    assert.match(branch, /await perpLane\.flatten\(\{ \.\.\.\(exit\.order\.book \? \{ book: exit\.order\.book \} : \{\}\), notAfterMs, askedAt: cmd\.at \}\)/);
    assert.match(branch, /return \{ ok: result\.ok, line: result\.sentence \};/);
    const at = CODE.indexOf("  function orderOutcome(");
    const outcome = CODE.slice(at, CODE.indexOf("\n  }\n", at));
    assert.match(outcome, /if \(isPerpExitRoute\(orderRoute\(cmd\.args\)\)\) return \{ ok: reply\.ok, line: reply\.line \};\s*const receipt =/);
  });

  it("A STOOD-DOWN PERPS WORKER'S DRAIN CLAIMS NOTHING (D19)", () => {
    assert.match(fn("runQueuedCommand"), /mayRun: cmd => !!active && !perpsWorkerStoodDown\(cfg\) && !recoveryCommandRefused\(/);
  });

  it("THE DRAIN KNOWS WHICH ACCOUNT IS ARMED, so a command bound to another is answered and never run (command-files.ts notForThisAccount)", () => {
    assert.match(fn("runQueuedCommand"), /account: \(\) => active\?\.grant\.smartAccount \?\? null,/);
  });

  it("AN OWNER'S PERPETUAL EXIT THAT EXPIRED IS ANSWERED WITHOUT A RECEIPT, on the drain's hook and in runCommand alike (order-receipt.ts expiredOrderReceipt)", () => {
    assert.match(fn("runQueuedCommand"), /expiredReceipt: \(cmd\) => \(cmd\.kind === "trade" \? expiredOrderReceipt\(cmd\.args\) : undefined\)/);
    const run = fn("runCommand");
    assert.match(run, /const receipt = cmd\.kind === "trade" \? expiredOrderReceipt\(cmd\.args\) : undefined;/);
    assert.match(run, /\.\.\.\(receipt \? \{ receipt \} : \{\}\),/);
  });

  it("PAUSE STOPS NEW PERP ENTRIES: the tick's pause return comes before the perps route, and after the order drain", () => {
    const tick = fn("tick");
    const drain = tick.indexOf("if (!(await drainOnTick(plan, () => (active ? runQueuedCommand(active.agentId, drainReads) : Promise.resolve())))) return;");
    const paused = tick.indexOf("if (isPaused()) return;", drain);
    const route = tick.indexOf("await perpLane.runRoute(");
    assert.ok(drain > 0 && paused > drain && route > paused, `${drain} < ${paused} < ${route}`);
  });

  it("A PERPS WALLET'S ENERGY REPORT NAMES ITS WALLET, so a buy is never reported ready there (energy.ts energyBuyOf)", () => {
    assert.match(CODE, /buy: energyBuyOf\(\{\s*chainId: grant\.chainId,\s*live: execMode\(\)\.mode === "live",\s*hasRoute: grantEnergyRoute\(grant\) !== null,\s*wallet: cfg\.workerWallet,\s*\}\)/);
  });

  it("the lane's reservation is released in a finally", () => {
    const lane = codeOnly(readFileSync(path.join(HERE, "lane.ts"), "utf8"));
    assert.match(lane, /deps\.budget\.reserve\(spend\);\s*let placed[^;]*;\s*try \{[\s\S]{0,400}\} finally \{\s*deps\.budget\.release\(spend\);/);
  });
});
