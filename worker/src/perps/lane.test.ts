/**
 * THE PERP LANE'S OWN RULES — the parts paper-e2e.integration.test.ts does not
 * pin by telling a story:
 *
 *   the live rail      a live account with perps on rides perpsModeOf: with
 *                      no live edges in the process (or not granted, or the
 *                      venue not proven ready) it is refused by name and never
 *                      reaches an executor; paper rides perpsModeOf unchanged.
 *   the reservation    reserved after BOTH policy passes, released on every
 *                      exit — a throw from the executor included; a counter
 *                      re-read that fails AFTER a booking converts it
 *                      (budget.keep), never reports the booking refused.
 *   the owner's line   a refusal is said once per change, never once a tick.
 *   one writer         a `strategist` driver with no real model is nobody; the
 *                      strategist's handoff is consumed by one route and gone.
 *   the reset          a paper reset clears the book and every memory of it.
 *   the feed host      one feed per self-hosted process, none in a hosted child.
 *   the wiring         index.ts calls the protective loop from the arm, never
 *                      from tick(); lane.ts and protect.ts read nothing from
 *                      the chain's market read; every paper_book
 *                      read-modify-write in index.ts runs under the lane lock.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { ExecMode } from "../exec-mode";
import type { AgentLimits, PerpOrderIntent, TradeIntent } from "../policy";
import { buildOpenDraft } from "./drafts";
import { createPaperPerpExecutor, PerpRefused, type PerpExecutor } from "./executor";
import { readLighterFeed, specToJson, type LighterFeedFileMarket } from "./feed-reader";
import {
  createPerpFeedHost,
  createPerpLane,
  entryCandleOf,
  isHostedChildProcess,
  usdgText,
  type PerpLane,
  type PerpLaneConfig,
} from "./lane";
import { parseOrderBookDetails } from "./markets";
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
after(() => {
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
  budget: { reserved: bigint[]; released: bigint[]; kept: bigint[] };
  cfg: PerpLaneConfig;
}
async function rig(
  opts: {
    cfg?: Partial<PerpLaneConfig>;
    wrap?: (ex: PerpExecutor) => PerpExecutor;
    store?: Partial<typeof store>;
    exec?: ExecMode;
    refresh?: () => Promise<void>;
    keep?: (s: bigint) => void;
    counters?: () => { spentTodayUsdg: bigint; opsToday: number };
    perp?: AgentLimits["perp"];
    /** Whether the agent is armed right now (index.ts `active`); default always. */
    armed?: () => boolean;
    execMode?: () => ExecMode;
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
    ...(opts.perp !== undefined ? { perp: opts.perp } : {}),
  };
  const r = { id, events: [] as string[], budget: { reserved: [] as bigint[], released: [] as bigint[], kept: [] as bigint[] }, cfg: { ...CFG, ...(opts.cfg ?? {}) } } as Rig;
  r.lane = createPerpLane({
    store: { ...store, ...(opts.store ?? {}) },
    armed: () => (opts.armed === undefined || opts.armed() ? { agentId: id, smartAccount: `0x${hex}`, limits } : null),
    config: () => r.cfg,
    execMode: () => (opts.execMode ? opts.execMode() : (opts.exec ?? PAPER)),
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
      refresh: opts.refresh ?? (async () => {}),
      ...(opts.keep !== undefined ? { keep: opts.keep } : { keep: (s: bigint) => void r.budget.kept.push(s) }),
    },
    ...(opts.counters !== undefined ? { counters: opts.counters } : {}),
    events: async (_level, message) => void r.events.push(message),
    decide: async () => ({ ok: true }),
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

// ── the live rail ───────────────────────────────────────────────────────────

describe("a live account's rail — perpsModeOf, with the venue's readiness proven, never assumed", () => {
  const LIVE: ExecMode = { mode: "live" };
  const PERP = { proxy: "0x94bab9693ba2f6358507effcbd372b0660afff9d" as const, apiKeyIndex: 16, apiPublicKey: `0x${"01".repeat(40)}` as `0x${string}` };
  const liveOn = { perpsEnabled: true, liveTradingEnabled: true, perpsLiveEnabled: true };

  it("no live edges in this process: the venue is never ready — refused perp-venue-unready by name, and no executor is reached", async () => {
    writeFeed();
    let made = 0;
    const r = await rig({ exec: LIVE, cfg: liveOn, perp: PERP, wrap: (ex) => (made++, ex) });
    const read = await r.lane.refresh();
    assert.deepEqual(read.rail, { mode: "refuse", rule: "perp-venue-unready" });
    assert.equal(read.book, undefined, "nothing at the venue is read: the known zero");
    const out = await r.lane.execute(await openDraftFrom(), { equityUsdg: u(100), equityKnown: true });
    assert.equal(out.status, "rejected");
    assert.equal(made, 0, "never a paper executor on a live account (rule 14)");
    assert.equal(r.budget.reserved.length, 0);
  });

  it("the owner's own switches still come first: live perps not consented, or not granted, are refused by THOSE names", async () => {
    writeFeed();
    const off = await rig({ exec: LIVE, cfg: { ...liveOn, perpsLiveEnabled: false }, perp: PERP });
    assert.deepEqual((await off.lane.refresh()).rail, { mode: "refuse", rule: "perp-live-not-enabled" });
    const ungranted = await rig({ exec: LIVE, cfg: liveOn });
    assert.deepEqual((await ungranted.lane.refresh()).rail, { mode: "refuse", rule: "perp-not-granted" });
    const perpsOff = await rig({ exec: LIVE, cfg: { perpsEnabled: false }, perp: PERP });
    assert.deepEqual((await perpsOff.lane.refresh()).rail, { mode: "off" }, "off stays a choice, not a refusal");
  });

  it("a paper account rides paper perps exactly as perpsModeOf says", async () => {
    writeFeed();
    const r = await rig({ perp: PERP });
    assert.deepEqual((await r.lane.refresh()).rail, { mode: "paper" });
  });
});

/** A BTC open drafted from a fresh paper view (the live tests need an intent, not a paper position). */
async function openDraftFrom(): Promise<PerpOrderIntent> {
  const r = await rig();
  return openDraft(r);
}

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

  it("A COUNTER RE-READ THAT FAILS AFTER THE BOOKING is not a refusal: the position stands, the reservation is CONVERTED (keep) then released (S3-LANE-REFRESH-FAIL)", async () => {
    writeFeed();
    const kept: bigint[] = [];
    const r = await rig({
      refresh: async () => {
        throw new Error("the ledger read timed out");
      },
      keep: (s) => void kept.push(s),
    });
    const out = await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.equal(out.status, "paper", "the booking is fact: it is reported as what it was");
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
    assert.equal(kept.length, 1, "recordTrade's fail-closed conversion: the reservation's spend is booked into the settled halves");
    assert.deepEqual(kept, r.budget.reserved);
    assert.deepEqual(r.budget.released, r.budget.reserved, "then the (now double-counted) reservation is released");
    assert.ok(r.events.some((e) => /counters could not be re-read/.test(e)), "and the owner is told");
  });

  it("with no keep() to convert into, the reservation is HELD rather than released unaccounted", async () => {
    writeFeed();
    // rig() makes the agent and its paper book; this lane is its twin with no keep().
    const r = await rig();
    const lane = createPerpLane({
      store,
      armed: () => ({ agentId: r.id, smartAccount: "0x" + "ab".repeat(20), limits: { perTradeUsdg: u(50), dailyUsdg: u(500), allowedTargets: [], allowedAssets: [], maxDrawdownBps: 1_000, expiresAt: Math.floor(clock / 1000) + 30 * 86_400, maxOpsPerDay: 48 } }),
      config: () => CFG,
      execMode: () => PAPER,
      readFeed: (now) => readLighterFeed(FEED, now),
      now: () => clock,
      agentState: async ({ equityUsdg, equityKnown }) => ({ spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: u(100), equityUsdg, equityKnown, nowSec: Math.floor(clock / 1000) }),
      budget: {
        reserve: (s) => void r.budget.reserved.push(s),
        release: (s) => void r.budget.released.push(s),
        refresh: async () => {
          throw new Error("down");
        },
      },
      events: async () => {},
      decide: async () => ({ ok: true }),
      log: () => {},
    });
    const view = (await lane.refresh()).view!;
    const built = buildOpenDraft({ market: view.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    const before = r.budget.released.length;
    const out = await lane.execute({ ...built.draft } as PerpOrderIntent, { equityUsdg: u(100), equityKnown: true });
    assert.equal(out.status, "paper");
    assert.equal(r.budget.released.length, before, "held for the arm: the safe direction");
  });

  it("the day's counters are RE-READ UNDER THE LOCK: a base composed before it never hides an op booked since (R3-OPS-CAP-STALE-BASE)", async () => {
    writeFeed();
    let ops = 0;
    const r = await rig({ counters: () => ({ spentTodayUsdg: 0n, opsToday: ops }) });
    const intent = await openDraft(r);
    // The caller's base says 0 ops; by the time the lock is taken the day is spent.
    ops = 48;
    const base = { spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: u(100), equityUsdg: u(100), equityKnown: true, nowSec: Math.floor(clock / 1000) };
    const out = await r.lane.execute(intent, { equityUsdg: u(100), equityKnown: true }, base);
    assert.equal(out.status, "rejected");
    assert.match(String(out.rejectRule), /ops/);
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
    await r.lane.resetPaper(() => store.resetPaperLedger(r.id, 100));
    const after = await r.lane.refresh();
    assert.equal(after.held, false);
    assert.equal(after.view?.positions.size, 0);
    assert.equal((await store.getPaperBook(r.id, 100)).cashUsdg, 100);
  });
});

// ── the Stage-3 leftovers ───────────────────────────────────────────────────

describe("the owner's rail line (S3-05)", () => {
  it("an owner who never turned perps on and holds nothing hears NOTHING, however the account's rail moves between paper and live", async () => {
    writeFeed();
    let exec: ExecMode = PAPER;
    const r = await rig({ cfg: { perpsEnabled: false }, execMode: () => exec });
    await r.lane.refresh();
    exec = { mode: "live" };
    await r.lane.refresh();
    exec = PAPER;
    await r.lane.refresh();
    exec = { mode: "live" };
    await r.lane.refresh();
    assert.deepEqual(r.events.filter((e) => /perpetuals/.test(e)), [], JSON.stringify(r.events));
  });

  it("turning perps OFF after they were on is said, once", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.refresh();
    r.cfg = { ...r.cfg, perpsEnabled: false };
    await r.lane.refresh();
    await r.lane.refresh();
    assert.equal(r.events.filter((e) => /^perpetuals are off/.test(e)).length, 1, JSON.stringify(r.events));
  });
});

describe("the take-profit's outcome, said truthfully (R3-TP-GAPPED-SAYS-FILLED)", () => {
  const tp = (outcome: "closed" | "reduced" | "gapped") => ({
    kind: "tp" as const,
    marketId: 1,
    id: `tp-${outcome}`,
    outcome,
    booked: "booked" as const,
    realizedMicro: outcome === "gapped" ? 0n : u(1.5),
    feeMicro: 0n,
    paymentMicro: 0n,
    cashDeltaMicro: 0n,
  });
  for (const outcome of ["gapped", "reduced", "closed"] as const) {
    it(`a take-profit that ${outcome} is announced as exactly that`, async () => {
      writeFeed();
      const r = await rig({ wrap: (ex) => ({ ...ex, mode: ex.mode, review: ex.review.bind(ex), place: ex.place.bind(ex), tick: async () => ({ events: [tp(outcome)], unread: [], failed: null }) }) });
      await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
      await r.lane.protectPass({ lock: r.lane.lock, signal: new AbortController().signal, pass: 1 });
      const said = r.events.filter((e) => /take-profit/.test(e));
      assert.equal(said.length, 1, JSON.stringify(r.events));
      if (outcome === "gapped") {
        assert.match(said[0]!, /nothing filled/);
        assert.match(said[0]!, /still open/);
        assert.doesNotMatch(said[0]!, /take-profit filled/);
      } else if (outcome === "reduced") {
        assert.match(said[0]!, /part-filled/);
      } else {
        assert.match(said[0]!, /take-profit filled — the position closed, realized \+1\.50 USDG/);
      }
    });
  }
});

describe("a restore's folded paper collateral (R3-FOLDED-PAPER-COLLATERAL)", () => {
  it("goes back to paper cash once the paper book is flat — equity unchanged, and never counted as committed at a venue", async () => {
    writeFeed();
    const r = await rig();
    await store.patchPerpAccount(r.id, "paper", { paperCollateralMicro: u(7) });
    const read = await r.lane.refresh();
    assert.equal((await store.getPaperBook(r.id, 100)).cashUsdg, 107, "the folded 7 USDG is paper cash again");
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.paperCollateralMicro, 0n);
    assert.equal(read.view?.facts.committedCollateralMicro, 0n, "nothing is committed: the cap is not spent on money that is not there");
  });

  it("is left alone while a paper position is open (the engine never used it; it is returned at the next flat read)", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const cashAfterOpen = (await store.getPaperBook(r.id, 100)).cashUsdg;
    await store.patchPerpAccount(r.id, "paper", { paperCollateralMicro: u(3) });
    await r.lane.refresh();
    assert.equal((await store.getPaperBook(r.id, 100)).cashUsdg, cashAfterOpen);
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.paperCollateralMicro, u(3));
  });
});

describe("the paper book's clock after a kill or an expiry (S3-06, S3-PAPER-PROTECT-DISARM)", () => {
  it("keeps running: practice positions keep their stops, take-profits and liquidation with nothing armed", async () => {
    writeFeed();
    let armed = true;
    let ticks = 0;
    const r = await rig({
      armed: () => armed,
      wrap: (ex) => ({
        ...ex,
        mode: ex.mode,
        review: ex.review.bind(ex),
        place: ex.place.bind(ex),
        setLeverage: ex.setLeverage?.bind(ex),
        tick: async (now?: number) => {
          ticks++;
          return ex.tick!(now);
        },
      }),
    });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    await r.lane.refresh();
    armed = false; // index.ts: retireGrant / the kill branch set `active = null`
    const before = ticks;
    await r.lane.protectPass({ lock: r.lane.lock, signal: new AbortController().signal, pass: 1 });
    assert.equal(ticks, before + 1, "the paper venue's clock ran with nothing armed");
    // …and the P7 alert a paper owner could get never names recover.
    assert.ok(!r.events.some((e) => /merrymen recover/.test(e)));
  });
});

describe("the owner's /flatten on a paper book", () => {
  it("closes every practice position and halts new entries until the dashboard clears it", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
    const out = await r.lane.flatten();
    assert.equal(out.ok, true, out.sentence);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0);
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, true);
    const read = await r.lane.refresh();
    assert.equal(read.view?.opensBlocked, "perps-entries-halted");
    assert.equal((await r.lane.resumeEntries("paper")).ok, true);
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, false);
  });

  it("owner close remains available with entries disabled and refuses an expired request", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    r.cfg.perpsEnabled = false;
    r.cfg.perpsEntriesHalted = true;
    assert.equal((await r.lane.close("BTC-PERP", { notAfterMs: clock - 1 })).ok, false);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
    const out = await r.lane.close("BTC-PERP");
    assert.equal(out.ok, true, out.sentence);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0);
  });

  it("partial practice closes and flatten attempts report the position still open", async () => {
    for (const action of ["close", "flatten"] as const) {
      writeFeed();
      const r = await rig();
      await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
      const before = (await store.getPerpPositions(r.id, "paper"))[0]!.base;
      assert.ok(before > 1n);
      writeFeed(802_000n, "1");
      const out = action === "close" ? await r.lane.close("BTC-PERP") : await r.lane.flatten();
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
    const out = await r.lane.flatten();
    assert.equal(out.ok, false);
    assert.match(out.sentence, /pause could not be saved/);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0, "exit still attempted");
    assert.equal((await r.lane.refresh()).view?.opensBlocked, "perps-entries-halted");
    await r.lane.armed();
    await r.lane.stopProtect();
    assert.equal((await r.lane.refresh()).view?.opensBlocked, "perps-entries-halted", "re-arm never clears an unsaved owner halt");
  });

  it("resume never clears an incident or an expired request", async () => {
    writeFeed();
    const r = await rig();
    await store.patchPerpAccount(r.id, "paper", { entriesHalted: true, incident: { kind: "pubkey-mismatch", at: Math.floor(clock / 1000) } });
    assert.equal((await r.lane.resumeEntries("paper")).ok, false);
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, true);
    await store.patchPerpAccount(r.id, "paper", { incident: null });
    assert.equal((await r.lane.resumeEntries("paper", { notAfterMs: clock - 1 })).ok, false);
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, true);
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

  it("processIntentLocked hands every L2 perp intent to the lane, after `state` and before the EVM checkPolicy", () => {
    // Every perp intent but the three ON-CHAIN legs (deposit, claim, key
    // registration), which ride the UserOp rail below it (rule 9's last
    // sentence; perps/legs.ts — perp-legs-wiring.test.ts pins that half).
    const locked = fn("processIntentLocked");
    const state = locked.indexOf("const state: AgentState = {");
    assert.match(locked, /const perpLeg = perpLegKind\(intent\);\s*if \(intent\.kind === "perp-order" \|\| \(intent\.kind === "perp-margin" && perpLeg === null\)\) \{/);
    const branch = locked.indexOf('if (intent.kind === "perp-order" || (intent.kind === "perp-margin" && perpLeg === null)) {');
    const verdict = locked.indexOf("const verdict = checkPolicy(intent, limits, state");
    assert.ok(state > 0 && branch > state && verdict > branch, `${state} < ${branch} < ${verdict}`);
    assert.match(locked.slice(branch, branch + 300), /lastTradeOutcome = await perpLane\.execute\(intent, \{ equityUsdg, equityKnown \}, state\);\s*return;/);
    assert.doesNotMatch(locked.slice(0, branch), /executor\.|sendUserOperation|recordTrade\(\{/, "nothing EVM-shaped runs for a perp intent before the branch");
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

  it("the live lane's call sites: the stand-down requests on the 2 s watcher, the kill and the expiry hand the key's stand-down to the lane, the tick applies the live term through its one hook", () => {
    assert.match(CODE, /tickClock\.poll\(\);[\s\S]{0,200}void perpLane\.pollStanddownRequests\(\)/);
    const sync = fn("syncGrant");
    const kill = sync.indexOf('"KILL SWITCH — grant discarded, session key destroyed; trading halted"');
    assert.ok(kill > 0 && sync.indexOf('void perpLane.grantEnded("kill")', kill) > kill, "the kill hands over after active is cleared");
    assert.match(fn("retireGrant"), /void perpLane\.grantEnded\("expiry"\)/);
    const tick = fn("tick");
    const refresh = tick.indexOf("const liveRead = await perpLane.refresh();");
    assert.ok(refresh > 0 && tick.indexOf("noteLivePerpTerm(liveRead.liveTerm)", refresh) > refresh);
    assert.match(fn("processIntentLocked"), /perp: perpLane\.policyStateFor\(intent\),/);
  });

  it("the route runs after the class route, inside tick(), and nothing perp is in the strategy loop", () => {
    const tick = fn("tick");
    const classEntries = tick.indexOf("await classGate.entries(");
    const route = tick.indexOf("await perpLane.runRoute(");
    assert.ok(classEntries > 0 && route > classEntries);
  });

  it("the lane's reservation is released in a finally — unless it had to be HELD (no keep() to convert a failed re-read into)", () => {
    const lane = codeOnly(readFileSync(path.join(HERE, "lane.ts"), "utf8"));
    assert.match(lane, /deps\.budget\.reserve\(spend\);\s*let placed[^;]*;\s*let held = false;\s*try \{[\s\S]{0,400}\} finally \{\s*if \(!held\) deps\.budget\.release\(spend\);/);
    // `held` is true only on the one path with nothing to convert into.
    assert.match(lane, /if \(deps\.budget\.keep\) \{\s*deps\.budget\.keep\(spend\);\s*return false;\s*\}\s*return true;/);
  });
});
