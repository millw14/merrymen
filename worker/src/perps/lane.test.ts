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
 *                      The claim is all that keeps it so: a close run twice
 *                      closes whatever is held then, a position opened since
 *                      included.
 *   the wiring         index.ts calls the protective loop from the arm, never
 *                      from tick(); lane.ts and protect.ts read nothing from
 *                      the chain's market read; every paper_book
 *                      read-modify-write in index.ts runs under the lane lock;
 *                      an owner's exit reaches the lane after the wallet check
 *                      and the tenant's admission level.
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
  resetHaltSentence,
  usdgText,
  type DecideFn,
  type PerpLane,
  type PerpLaneConfig,
} from "./lane";
import { parseOrderBookDetails } from "./markets";
import { orderExpiryHooks } from "../order-receipt";
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
const DETAILS = parseOrderBookDetails(JSON.parse(readFileSync(path.join(HERE, "fixtures", "orderBookDetails.perp.json"), "utf8")))!;
const BTC = DETAILS.markets.get(1)!;
/** ETH-PERP (market 0), for the owner's exits over more than one held market. */
const ETH = DETAILS.markets.get(0)!;
const FEED = path.join(scratch, "lighter-feed.json");
let clock = 1_790_712_000_000;

function feedMarket(spec: typeof BTC.spec, mark: bigint, bidDepth: string, at: number): LighterFeedFileMarket {
  return {
    observedAt: at - 1_000,
    priceSource: "ws",
    mark: mark.toString(),
    index: mark.toString(),
    status: "active",
    spec: specToJson(spec),
    specObservedAt: at - 60_000,
    takerFeePpm: 0,
    makerFeePpm: 0,
    bids: [[(mark - 100n).toString(), bidDepth]],
    asks: [[mark.toString(), "1000"]],
    bookObservedAt: at - 1_000,
    bookSource: "ws",
  };
}

/**
 * The fleet's feed file: BTC-PERP at `mark`, and ETH-PERP too at `eth` when
 * given. `ageMs` writes it as a writer that stopped that long ago left it —
 * the file is there, and every price in it is stale.
 */
function writeFeed(mark = 802_000n, bidDepth = "1000", opts: { eth?: bigint; ageMs?: number } = {}): void {
  const at = clock - (opts.ageMs ?? 0);
  const markets: Record<string, LighterFeedFileMarket> = { "1": feedMarket(BTC.spec, mark, bidDepth, at) };
  if (opts.eth !== undefined) markets["0"] = feedMarket(ETH.spec, opts.eth, "1000", at);
  writeFileSync(FEED, JSON.stringify({ v: 1, observedAt: at - 500, markets }));
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
  smartAccount: `0x${string}`;
  lane: PerpLane;
  events: string[];
  /** What the lane asked of the budget, in order: reserve, count (refresh), keep, release. */
  budget: { reserved: bigint[]; released: bigint[]; kept: bigint[]; steps: string[] };
  cfg: PerpLaneConfig;
}
async function rig(
  opts: {
    cfg?: Partial<PerpLaneConfig>;
    wrap?: (ex: PerpExecutor) => PerpExecutor;
    store?: Partial<typeof store>;
    execMode?: () => ExecMode;
    decide?: DecideFn;
    /** The budget's re-read of the day's counters (index.ts refreshBudget); a no-op by default. */
    refresh?: () => Promise<void>;
    /** Called beside the rig's own record when the lane keeps a booked op counted (index.ts keep). */
    keep?: (spendMicro: bigint) => void;
    /** The day's counters as the lane reads them under its lock (index.ts spentToday / opsTodayCount); none by default. */
    counters?: () => Promise<{ spentTodayUsdg: bigint; opsToday: number }>;
    /** Another lane over THAT rig's agent and ledger, with none of its memory: the worker restarted. */
    reuse?: Rig;
    /** A lane no agent arms, as every Spot worker's is (index.ts arms it only for a Perps wallet's worker). */
    unarmed?: boolean;
  } = {},
): Promise<Rig> {
  const hex = opts.reuse ? opts.reuse.smartAccount.slice(2) : (n++).toString(16).padStart(40, "0");
  const id = opts.reuse ? opts.reuse.id : await store.ensureAgent({
    smartAccount: `0x${hex}`,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: 2_000_000_000,
    chainId: 4663,
  } as never);
  if (!opts.reuse) await store.getPaperBook(id, 100);
  const limits: AgentLimits = {
    perTradeUsdg: u(50),
    dailyUsdg: u(500),
    allowedTargets: [],
    allowedAssets: [],
    maxDrawdownBps: 1_000,
    expiresAt: Math.floor(clock / 1000) + 30 * 86_400,
    maxOpsPerDay: 48,
  };
  const r = {
    id,
    smartAccount: `0x${hex}`,
    events: [] as string[],
    budget: { reserved: [] as bigint[], released: [] as bigint[], kept: [] as bigint[], steps: [] as string[] },
    cfg: { ...CFG, ...(opts.cfg ?? {}) },
  } as Rig;
  r.lane = createPerpLane({
    store: { ...store, ...(opts.store ?? {}) },
    armed: opts.unarmed ? () => null : () => ({ agentId: id, smartAccount: `0x${hex}`, limits }),
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
      reserve: (s) => void (r.budget.reserved.push(s), r.budget.steps.push("reserve")),
      release: (s) => void (r.budget.released.push(s), r.budget.steps.push("release")),
      refresh: async () => {
        r.budget.steps.push("count");
        await opts.refresh?.();
      },
      keep: (s) => {
        r.budget.kept.push(s);
        r.budget.steps.push("keep");
        opts.keep?.(s);
      },
      counters: opts.counters ?? (async () => ({ spentTodayUsdg: 0n, opsToday: 0 })),
    },
    events: async (_level, message) => void r.events.push(message),
    decide: opts.decide ?? (async () => ({ ok: true })),
    paperExecutor: (o) => (opts.wrap ?? ((x) => x))(createPaperPerpExecutor(o)),
    log: () => {},
  });
  return r;
}

async function openDraft(r: Rig, market: "BTC-PERP" | "ETH-PERP" = "BTC-PERP"): Promise<PerpOrderIntent> {
  const view = (await r.lane.refresh()).view!;
  assert.ok(view.markets.get(market), `set-up: ${market} is read fresh`);
  const built = buildOpenDraft({ market: view.markets.get(market)!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
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
  it("resetHaltSentence: a pause the reset left is said, and one the ledger could not answer for is said as that, never as none", () => {
    assert.equal(resetHaltSentence(false), "");
    assert.equal(resetHaltSentence(true), " New practice positions stay paused by your earlier Close all; reset again to lift that.");
    assert.equal(
      resetHaltSentence("unread"),
      " Whether new practice positions are paused by a Close all could not be read just now; if you pressed Close all before asking for this reset, reset again to lift that pause.",
    );
    // "unread" comes as readily to an owner who never pressed Close all.
    assert.doesNotMatch(resetHaltSentence("unread"), /earlier|your Close all|still/);
    // Its condition is the owner's own Close all, never what the report shows:
    // the operator's entry halt shows the same pause, and no reset lifts it.
    assert.doesNotMatch(resetHaltSentence("unread"), /show as paused|shows? paused/);
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

  /** The executor with place() swapped for `place`, everything else bound as it was. */
  const placing = (ex: PerpExecutor, place: PerpExecutor["place"]): PerpExecutor => ({
    mode: ex.mode,
    review: ex.review.bind(ex),
    setLeverage: ex.setLeverage?.bind(ex),
    tick: ex.tick?.bind(ex),
    setStop: ex.setStop?.bind(ex),
    place,
  });

  it("RESERVE → PLACE → COUNT → RELEASE, for a strategy open and an owner's Close alike: the booked order is counted before its reservation goes", async () => {
    writeFeed();
    let r!: Rig;
    r = await rig({ wrap: (ex) => placing(ex, (i, v, c) => (r.budget.steps.push("place"), ex.place(i, v, c))) });
    assert.equal((await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true })).status, "paper");
    assert.deepEqual(r.budget.steps, ["reserve", "place", "count", "release"], "the open");
    r.budget.steps.length = 0;
    assert.equal((await r.lane.close("BTC-PERP", { book: "paper" })).ok, true);
    assert.deepEqual(r.budget.steps, ["reserve", "place", "count", "release"], "the owner's Close");
    assert.deepEqual(r.budget.kept, [], "a count that answered keeps nothing");
  });

  it("A THROW FROM place() IS COUNTED BEFORE ITS REFUSAL IS ANSWERED (it may have come after the commit), unless it is the executor's own refusal, which comes before anything is booked", async () => {
    const cases = [
      { thrown: new Error("the ledger went away"), busy: false, steps: ["reserve", "place", "count", "release"], kept: 0 },
      { thrown: new Error("the ledger went away"), busy: true, steps: ["reserve", "place", "count", "keep", "release"], kept: 1 },
      { thrown: new PerpRefused("perp-market-inactive", "BTC-PERP is paused at the venue"), busy: true, steps: ["reserve", "place", "release"], kept: 0 },
    ];
    for (const c of cases) {
      writeFeed();
      let r!: Rig;
      r = await rig({
        wrap: (ex) =>
          placing(ex, async () => {
            r.budget.steps.push("place");
            throw c.thrown;
          }),
        refresh: async () => {
          if (c.busy) throw new Error("SQLITE_BUSY: database is locked");
        },
      });
      const label = `${c.thrown.constructor.name}${c.busy ? ", its count failing" : ""}`;
      assert.equal((await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true })).status, "rejected", label);
      assert.deepEqual(r.budget.steps, c.steps, label);
      assert.deepEqual(r.budget.kept, r.budget.reserved.slice(0, c.kept), `${label}: kept counted only when the count could not answer`);
      assert.deepEqual(r.budget.released, r.budget.reserved, `${label}: released`);
    }
  });

  /**
   * index.ts's day counters over this rig's ledger, as refreshBudget keeps
   * them: the settled half is the ledger's op count at the last count that
   * answered (plus `earlier`, the day's ops before the test), keep adds to it,
   * and the in-flight half is what the rig reserved and has not released.
   */
  const dayCounters = (day: { busy: boolean; earlier: number; settled: number }, rigOf: () => Rig) => ({
    refresh: async () => {
      if (day.busy) throw new Error("SQLITE_BUSY: database is locked");
      day.settled = day.earlier + ordersOf(rigOf().id);
    },
    keep: () => void (day.settled += 1),
    counters: async () => ({ spentTodayUsdg: 0n, opsToday: day.settled + rigOf().budget.reserved.length - rigOf().budget.released.length }),
  });

  it("AN OPEN JUDGED UNDER THE LANE'S LOCK MEETS EVERY OP BOOKED WHILE IT WAITED: an owner's Close that books first takes the day to the grant's ops cap, and the open is refused ops-cap", async () => {
    writeFeed(802_000n, "1000", { eth: 268_100n });
    const day = { busy: false, earlier: 0, settled: 0 };
    let r!: Rig;
    r = await rig({ cfg: { perpsMarkets: ["BTC-PERP", "ETH-PERP"] }, ...dayCounters(day, () => r) });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    // The day so far: one op short of the grant's 48.
    day.earlier = 47 - ordersOf(r.id);
    day.settled = 47;
    const eth = await openDraft(r, "ETH-PERP");
    // processIntentLocked's state, read BEFORE the open queued for the lane's lock.
    const base = { spentTodayUsdg: 0n, opsToday: 47, highWaterMarkUsdg: u(100), equityUsdg: u(100), equityKnown: true, nowSec: Math.floor(clock / 1000) };
    const closing = r.lane.close("BTC-PERP", { book: "paper" });
    const opening = r.lane.execute(eth, { equityUsdg: u(100), equityKnown: true }, base);
    assert.equal((await closing).ok, true, "the owner's Close held the lock first and booked");
    assert.equal(day.settled, 48, "set-up: that took the day to the grant's cap");
    assert.deepEqual(await opening, { status: "rejected", rejectRule: "ops-cap" });
    assert.deepEqual(await heldMarketsOf(r.id), [], "nothing opened over the cap");
  });

  it("A BOOKED CLOSE WHOSE COUNT FAILED STAYS COUNTED (Spot's heldReservation rule), so the next open in the same tick meets it at the grant's ops cap", async () => {
    writeFeed(802_000n, "1000", { eth: 268_100n });
    const day = { busy: false, earlier: 0, settled: 0 };
    let r!: Rig;
    r = await rig({ cfg: { perpsMarkets: ["BTC-PERP", "ETH-PERP"] }, ...dayCounters(day, () => r) });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    day.earlier = 47 - ordersOf(r.id);
    day.settled = 47;
    const eth = await openDraft(r, "ETH-PERP");
    day.busy = true;
    assert.equal((await r.lane.close("BTC-PERP", { book: "paper" })).ok, true);
    day.busy = false;
    assert.deepEqual(r.budget.kept, [0n], "the close's op was kept counted when its count failed");
    assert.equal(day.settled, 48);
    assert.deepEqual(await r.lane.execute(eth, { equityUsdg: u(100), equityKnown: true }), { status: "rejected", rejectRule: "ops-cap" });
    assert.deepEqual(await heldMarketsOf(r.id), [], "nothing opened over the cap");
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
  for (const failure of ["before-booking", "after-booking", "after-booking-unread"] as const) {
    it(`an uncertain strategy open keeps its energy until the ledger proves no entry: ${failure}`, async () => {
      writeFeed();
      let unread = false;
      const r = await rig({
        cfg: { perpsDriver: "strategist" },
        store: {
          getPerpPositions: async (...args: Parameters<typeof store.getPerpPositions>) => {
            if (unread) throw new Error("entry outcome ledger unavailable");
            return store.getPerpPositions(...args);
          },
        },
        wrap: (ex) => ({
          ...ex,
          place: async (intent, review, ctx) => {
            if (failure !== "before-booking") await ex.place(intent, review, ctx);
            unread = failure === "after-booking-unread";
            throw new Error("entry outcome unavailable");
          },
        }),
      });
      const intent = await openDraft(r);
      await r.lane.readWithBook(() => store.getPaperBook(r.id, 100));
      r.lane.deliverStrategist([intent as PerpRouteIntent]);
      let refunds = 0;
      let status: string | undefined;
      const running = r.lane.runRoute({
        equityUsdg: u(100), equityKnown: true, breakerIdle: true, energyEntriesLeft: true,
        opsHeadroom: true, spendHeadroomMicro: u(500), strategistLive: true,
      }, {
        claimEntry: async () => ({ ok: true }),
        refundEntry: async () => { refunds++; },
        withholdEntry: async () => {},
        ensureDecision: async () => ({ ok: true }),
        processIntentReporting: async (i) => {
          const outcome = await r.lane.execute(i as PerpOrderIntent, { equityUsdg: u(100), equityKnown: true });
          status = outcome.status;
          if (failure === "after-booking") assert.equal(outcome.amountUsdg, undefined, "an unavailable fill receipt supplies no invented amount");
          return outcome;
        },
        processIntent: async () => { assert.fail("this is an entry"); },
      });
      if (failure === "after-booking-unread") {
        await assert.rejects(running, /entry outcome unavailable/);
        assert.equal(status, undefined, "the lane cannot assert a ledger verdict");
      } else {
        await running;
        assert.equal(status, failure === "after-booking" ? "paper" : "rejected");
      }
      assert.equal(refunds, failure === "before-booking" ? 1 : 0);
      assert.equal(fillsOf(r.id), failure === "before-booking" ? 0 : 1);
      assert.deepEqual(r.budget.released, r.budget.reserved);
      if (failure === "after-booking") {
        assert.equal(r.lane.last()?.view?.positions.has("BTC-PERP"), true);
        assert.deepEqual(r.events.filter((e) => /refused/.test(e)), [], "a committed entry is never described as refused");
      }
    });
  }

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
    const reset = await r.lane.resetPaper(() => store.resetPaperLedger(r.id, 100));
    assert.equal(reset.haltKept, false, "no Close all, so no pause to tell of, though this reset could lift none");
    const after = await r.lane.refresh();
    assert.equal(after.held, false);
    assert.equal(after.view?.positions.size, 0);
    assert.equal((await store.getPaperBook(r.id, 100)).cashUsdg, 100);
    const early = await r.lane.resetPaper(() => store.resetPaperLedger(r.id, 100), { askedAt: clock - 60_000 });
    assert.equal(early.haltKept, false, "nor does one asked for before this lane began");
  });

  it("A BOOK WITH NO perp_accounts ROW (no trade, no Close all) IS NO PAUSE: from the lane's own read, which finds no row and is not asked again, and from the ledger asked again when that read stopped short of the account", async () => {
    writeFeed();
    let positionsDown = false;
    // After a reset the ledger answers once — the lane's own read — and is busy for every read after it.
    let reads: number | null = null;
    const r = await rig({
      store: {
        getPerpPositions: async (...args: Parameters<typeof store.getPerpPositions>) => {
          if (positionsDown) throw new Error("SQLITE_BUSY: database is locked");
          return store.getPerpPositions(...args);
        },
        getPerpAccount: async (...args: Parameters<typeof store.getPerpAccount>) => {
          if (reads !== null && ++reads > 1) throw new Error("SQLITE_BUSY: database is locked");
          return store.getPerpAccount(...args);
        },
      },
    });
    await store.setAgentMode(r.id, "paper", 1, false);
    assert.equal(await store.getPerpAccount(r.id, "paper"), null, "set-up: nothing was ever placed, so there is no account row");
    for (const askedAt of [clock - 60_000, undefined]) {
      const reset = await r.lane.resetPaper(
        async () => {
          const epoch = await store.resetPaperLedger(r.id, 100);
          reads = 0;
          return epoch;
        },
        askedAt === undefined ? {} : { askedAt },
      );
      assert.equal(reads, 1, `asked at ${askedAt}: the lane's own read found no row, and that is the answer; the ledger is not asked again`);
      reads = null;
      assert.equal(reset.haltKept, false, `the lane's own read, asked at ${askedAt}`);
    }
    // The lane's read fails before it reaches the account row, so the reset asks the ledger itself.
    const asked = await r.lane.resetPaper(
      async () => {
        const epoch = await store.resetPaperLedger(r.id, 100);
        positionsDown = true;
        return epoch;
      },
      { askedAt: clock - 60_000 },
    );
    positionsDown = false;
    assert.equal(asked.haltKept, false, "the ledger asked again: still no row, still no pause");
    assert.equal(await store.getPerpAccount(r.id, "paper"), null, "set-up: no reset made a row either");
  });

  it("A RESET ASKED FOR BEFORE THIS LANE BEGAN ANSWERS FROM THE LANE'S OWN READ, so a ledger busy only after it never makes it \"could not be read\": no Close all is no pause, and a stored one is said to stand", async () => {
    writeFeed();
    for (const closedAll of [false, true]) {
      const first = await rig();
      await first.lane.execute(await openDraft(first), { equityUsdg: u(100), equityKnown: true });
      if (closedAll) assert.equal((await first.lane.flatten({ askedAt: clock - 10_000 })).ok, true);
      await first.lane.stopProtect();
      await store.setAgentMode(first.id, "paper", 1, false);
      // After the reset the ledger answers once — the lane's own read — and is busy for every read after it.
      let reads: number | null = null;
      const restarted = await rig({
        reuse: first,
        store: {
          getPerpAccount: async (...args: Parameters<typeof store.getPerpAccount>) => {
            if (reads !== null && ++reads > 1) throw new Error("SQLITE_BUSY: database is locked");
            return store.getPerpAccount(...args);
          },
        },
      });
      const out = await restarted.lane.resetPaper(
        async ({ clearEntriesHalt }) => {
          assert.equal(clearEntriesHalt, false, "set-up: asked for before this worker began, so it lifts nothing");
          const epoch = await store.resetPaperLedger(restarted.id, 100, { clearEntriesHalt });
          reads = 0;
          return epoch;
        },
        { askedAt: clock - 20_000 },
      );
      assert.equal(reads, 1, `closedAll ${closedAll}: the lane's own read, and no second`);
      reads = null;
      assert.equal(out.haltKept, closedAll, `closedAll ${closedAll}`);
      assert.equal(
        resetHaltSentence(out.haltKept),
        closedAll ? " New practice positions stay paused by your earlier Close all; reset again to lift that." : "",
      );
      assert.equal((await store.getPerpAccount(restarted.id, "paper"))?.entriesHalted, closedAll, "set-up: the ledger says the same");
    }
  });

  it("A CLOSE ALL ON A BOOK THAT NEVER TRADED CREATES THE ROW IT HALTS, so a restarted lane's early reset says the pause stands, from its own read", async () => {
    writeFeed();
    const first = await rig();
    assert.equal(await store.getPerpAccount(first.id, "paper"), null, "set-up: nothing was ever placed, so there is no account row");
    assert.equal((await first.lane.flatten({ askedAt: clock - 10_000 })).ok, true);
    assert.equal((await store.getPerpAccount(first.id, "paper"))?.entriesHalted, true, "the Close all wrote the row it halts");
    assert.equal(fillsOf(first.id), 0, "set-up: and still nothing traded");
    assert.equal(ordersOf(first.id), 0);
    await first.lane.stopProtect();
    await store.setAgentMode(first.id, "paper", 1, false);
    let reads: number | null = null;
    const restarted = await rig({
      reuse: first,
      store: {
        getPerpAccount: async (...args: Parameters<typeof store.getPerpAccount>) => {
          if (reads !== null && ++reads > 1) throw new Error("SQLITE_BUSY: database is locked");
          return store.getPerpAccount(...args);
        },
      },
    });
    const out = await restarted.lane.resetPaper(
      async ({ clearEntriesHalt }) => {
        assert.equal(clearEntriesHalt, false, "set-up: asked for before this worker began, so it lifts nothing");
        const epoch = await store.resetPaperLedger(restarted.id, 100, { clearEntriesHalt });
        reads = 0;
        return epoch;
      },
      { askedAt: clock - 20_000 },
    );
    assert.equal(reads, 1, "the lane's own read, and no second");
    assert.equal(out.haltKept, true);
    assert.equal(resetHaltSentence(out.haltKept), " New practice positions stay paused by your earlier Close all; reset again to lift that.");
  });

  it("WHEN THE LANE'S OWN READ STOPS SHORT OF THE ACCOUNT ROW, THE LEDGER ASKED AGAIN SAYS A STORED CLOSE ALL STANDS: never a fresh book while every practice entry is refused", async () => {
    writeFeed();
    const first = await rig();
    await first.lane.execute(await openDraft(first), { equityUsdg: u(100), equityKnown: true });
    assert.equal((await first.lane.flatten({ askedAt: clock - 10_000 })).ok, true);
    await first.lane.stopProtect();
    await store.setAgentMode(first.id, "paper", 1, false);
    // After the reset the lane's read fails at the positions, before the account row.
    let positionsDown = false;
    let reads: number | null = null;
    const restarted = await rig({
      reuse: first,
      store: {
        getPerpPositions: async (...args: Parameters<typeof store.getPerpPositions>) => {
          if (positionsDown) throw new Error("SQLITE_BUSY: database is locked");
          return store.getPerpPositions(...args);
        },
        getPerpAccount: async (...args: Parameters<typeof store.getPerpAccount>) => {
          if (reads !== null) reads++;
          return store.getPerpAccount(...args);
        },
      },
    });
    const out = await restarted.lane.resetPaper(
      async ({ clearEntriesHalt }) => {
        assert.equal(clearEntriesHalt, false, "set-up: asked for before this worker began, so it lifts nothing");
        const epoch = await store.resetPaperLedger(restarted.id, 100, { clearEntriesHalt });
        positionsDown = true;
        reads = 0;
        return epoch;
      },
      { askedAt: clock - 20_000 },
    );
    positionsDown = false;
    assert.equal(reads, 1, "the lane's read never reached the account row, so the ledger was asked once more");
    assert.equal(out.haltKept, true, "the ledger asked again found the stored halt");
    assert.equal(resetHaltSentence(out.haltKept), " New practice positions stay paused by your earlier Close all; reset again to lift that.");
    assert.equal((await store.getPerpAccount(restarted.id, "paper"))?.entriesHalted, true, "set-up: the ledger says the same");
  });

  it("A LANE SWITCHED OFF ANSWERS FROM ITS OWN READ TOO: the account row is read before the lane finds itself inactive, so a reset asked for before it began asks the ledger once", async () => {
    writeFeed();
    for (const closedAll of [false, true]) {
      const first = await rig();
      if (closedAll) assert.equal((await first.lane.flatten({ askedAt: clock - 10_000 })).ok, true);
      await first.lane.stopProtect();
      await store.setAgentMode(first.id, "paper", 1, false);
      let reads: number | null = null;
      const restarted = await rig({
        reuse: first,
        cfg: { perpsEnabled: false },
        store: {
          getPerpAccount: async (...args: Parameters<typeof store.getPerpAccount>) => {
            if (reads !== null && ++reads > 1) throw new Error("SQLITE_BUSY: database is locked");
            return store.getPerpAccount(...args);
          },
        },
      });
      assert.equal((await restarted.lane.refresh()).active, false, `closedAll ${closedAll} set-up: switched off and holding nothing, the lane is inactive`);
      const out = await restarted.lane.resetPaper(
        async ({ clearEntriesHalt }) => {
          assert.equal(clearEntriesHalt, false, "set-up: asked for before this worker began, so it lifts nothing");
          const epoch = await store.resetPaperLedger(restarted.id, 100, { clearEntriesHalt });
          reads = 0;
          return epoch;
        },
        { askedAt: clock - 20_000 },
      );
      assert.equal(reads, 1, `closedAll ${closedAll}: the lane's own read, and no second`);
      assert.equal(out.haltKept, closedAll, `closedAll ${closedAll}`);
    }
  });

  it("AN ACTIVE LANE WHOSE READ FAILS AFTER THE ACCOUNT ROW ANSWERS FROM THAT ROW: the day's facts busy after the reset never make it \"could not be read\"", async () => {
    writeFeed();
    for (const closedAll of [false, true]) {
      const first = await rig();
      await first.lane.execute(await openDraft(first), { equityUsdg: u(100), equityKnown: true });
      if (closedAll) assert.equal((await first.lane.flatten({ askedAt: clock - 10_000 })).ok, true);
      await first.lane.stopProtect();
      await store.setAgentMode(first.id, "paper", 1, false);
      // After the reset the lane's read gets past the account row and fails at the day's facts; the ledger answers once.
      let factsDown = false;
      let reads: number | null = null;
      const restarted = await rig({
        reuse: first,
        store: {
          perpLaneLedgerFacts: async (...args: Parameters<typeof store.perpLaneLedgerFacts>) => {
            if (factsDown) throw new Error("SQLITE_BUSY: database is locked");
            return store.perpLaneLedgerFacts(...args);
          },
          getPerpAccount: async (...args: Parameters<typeof store.getPerpAccount>) => {
            if (reads !== null && ++reads > 1) throw new Error("SQLITE_BUSY: database is locked");
            return store.getPerpAccount(...args);
          },
        },
      });
      const out = await restarted.lane.resetPaper(
        async ({ clearEntriesHalt }) => {
          assert.equal(clearEntriesHalt, false, "set-up: asked for before this worker began, so it lifts nothing");
          const epoch = await store.resetPaperLedger(restarted.id, 100, { clearEntriesHalt });
          factsDown = true;
          reads = 0;
          return epoch;
        },
        { askedAt: clock - 20_000 },
      );
      factsDown = false;
      assert.equal(reads, 1, `closedAll ${closedAll}: the lane's own read reached the row, and no second was asked`);
      assert.equal(out.haltKept, closedAll, `closedAll ${closedAll}`);
    }
  });

  it("AN UNARMED LANE — EVERY SPOT WORKER'S — KEEPS NO PAUSE AND ASKS NO PERP LEDGER: its reset is told to lift nothing and answers none, so the Spot owner's line is unchanged", async () => {
    let asked = 0;
    const r = await rig({
      unarmed: true,
      store: {
        getPerpAccount: async () => {
          asked++;
          throw new Error("SQLITE_BUSY: database is locked");
        },
      },
    });
    for (const askedAt of [clock, clock - 60_000, undefined]) {
      let told: boolean | undefined;
      const out = await r.lane.resetPaper(
        async ({ clearEntriesHalt }) => {
          told = clearEntriesHalt;
          return 7;
        },
        askedAt === undefined ? {} : { askedAt },
      );
      assert.equal(out.out, 7);
      assert.equal(told, false, `asked at ${askedAt}: no agent, so no halt to lift`);
      assert.equal(out.haltKept, false, `asked at ${askedAt}: none kept, and none unread`);
      assert.equal(resetHaltSentence(out.haltKept), "");
    }
    assert.equal(asked, 0, "a Spot worker's reset reads no perp account");
  });
});

// ── the owner's exits ───────────────────────────────────────────────────────

const fillsOf = (id: string): number =>
  Number((raw.prepare("SELECT COUNT(*) AS n FROM perp_fills WHERE agent_id = ? AND mode = 'paper'").get(id.toLowerCase()) as { n: number }).n);
/** The market ids the practice ledger holds a position in, sorted. */
const heldMarketsOf = async (id: string): Promise<number[]> =>
  (await store.getPerpPositions(id, "paper")).filter((p) => p.base > 0n).map((p) => p.marketId).sort((x, y) => x - y);
/** Every order row the practice ledger holds (store.ts perpOpsSince counts these as the day's ops). */
const ordersOf = (id: string): number =>
  Number((raw.prepare("SELECT COUNT(*) AS n FROM perp_orders WHERE agent_id = ? AND mode = 'paper'").get(id.toLowerCase()) as { n: number }).n);
/** The first position's size as `agents.perps` shows it, in the market's own decimals. */
const reportedBaseOf = (id: string): string | undefined =>
  (JSON.parse(String((raw.prepare("SELECT perps FROM agents WHERE smart_account = ?").get(id) as { perps: string }).perps)) as { positions: { baseAmount: string }[] }).positions[0]?.baseAmount;
/** How many positions `agents.perps` — what the desk reads — shows. */
const reportedOf = (id: string): number =>
  (JSON.parse(String((raw.prepare("SELECT perps FROM agents WHERE smart_account = ?").get(id) as { perps: string }).perps)) as { positions: unknown[] }).positions.length;

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

  /**
   * THE DAY'S COUNTERS FAILING TO RE-READ AFTER A BOOKING. executeLocked
   * re-reads them (index.ts refreshBudget, store reads) after place() has
   * booked the order. That read used to share place()'s try, whose catch makes
   * any throw a refusal: a Close that had run came back "refused … so the
   * position and its stop stay as they were", the owner's feed said "refused"
   * with the driver's raw words and never announced the fill, and a strategy
   * open's energy was refunded for an order that was placed. A booking is a
   * booking: the answer, the feed and the lane's read all say what happened.
   */
  it("A CLOSE OR CLOSE ALL WHOSE DAY'S COUNTERS FAILED TO RE-READ AFTER IT BOOKED IS A CLOSE: the answer, the owner's feed and the lane's read all say so", async () => {
    for (const action of ["close", "flatten"] as const) {
      writeFeed();
      let busy = false;
      let threw = 0;
      const r = await rig({
        refresh: async () => {
          if (!busy) return;
          threw++;
          throw new Error("SQLITE_BUSY: database is locked");
        },
      });
      await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
      const fills = fillsOf(r.id);
      busy = true;
      const out = action === "close" ? await r.lane.close("BTC-PERP", { book: "paper" }) : await r.lane.flatten({ book: "paper" });
      busy = false;
      assert.equal(fillsOf(r.id), fills + 1, `${action} set-up: the close was booked, and only the counters' re-read after it failed`);
      assert.deepEqual(
        out,
        action === "close"
          ? { ok: true, sentence: "BTC-PERP: the practice position was closed." }
          : { ok: true, sentence: "Every practice perpetual position was closed. New practice positions are paused until you reset the practice book." },
      );
      assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0);
      assert.equal(r.lane.last()?.view?.positions.has("BTC-PERP"), false, `${action}: the lane's read — the report the desk shows — was taken after it`);
      assert.deepEqual(r.events.filter((e) => /refused/.test(e)), [], `${action}: the owner's feed never calls the close refused`);
      assert.equal(r.events.filter((e) => /^📜 perps \(paper\): closed the long on BTC-PERP — .* realized .* USDG — nothing signed\.$/.test(e)).length, 1, `${action}: and announces its fill`);
      assert.equal(threw, 1, `${action}: the count after the booking ran, and failed`);
      assert.deepEqual(r.budget.kept, [0n], `${action}: so the close's op stays counted`);
      assert.deepEqual(r.budget.released, r.budget.reserved, `${action}: every reservation released`);
    }
  });

  it("A STRATEGY OPEN WHOSE DAY'S COUNTERS FAILED TO RE-READ AFTER IT BOOKED IS PLACED, never refused (an energy claim is refunded only when nothing was placed)", async () => {
    writeFeed();
    let threw = 0;
    const r = await rig({
      refresh: async () => {
        threw++;
        throw new Error("SQLITE_BUSY: database is locked");
      },
    });
    const out = await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.equal(out.status, "paper");
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
    assert.deepEqual(r.events.filter((e) => /refused/.test(e)), []);
    assert.equal(r.events.filter((e) => /^📜 perps \(paper\): opened a /.test(e)).length, 1);
    assert.equal(r.lane.last()?.view?.positions.has("BTC-PERP"), true, "the read after the booking was taken");
    assert.equal(threw, 1, "the count after the booking ran, and failed");
    assert.deepEqual(r.budget.kept, r.budget.reserved, "so the open's op and notional stay counted");
    assert.deepEqual(r.budget.released, r.budget.reserved, "the reservation is released as it always was");
  });

  /**
   * A REFUSAL THAT CAN STILL COME AFTER THE BOOKING: the paper engine commits
   * the fill inside place(), and anything that throws after that commit and
   * before place() returns comes back as a refusal. What became of the
   * position is read back from the ledger, never taken from the outcome.
   */
  const bookThenThrow =
    (armed: () => boolean, after?: () => void) =>
    (ex: PerpExecutor): PerpExecutor => ({
      mode: ex.mode,
      review: ex.review.bind(ex),
      setLeverage: ex.setLeverage?.bind(ex),
      tick: ex.tick?.bind(ex),
      setStop: ex.setStop?.bind(ex),
      place: async (intent, review, ctx) => {
        const placed = await ex.place(intent, review, ctx);
        if (intent.effect !== "close" || !armed()) return placed;
        after?.();
        throw new Error("the paper engine booked it, then failed to answer");
      },
    });

  it("A CLOSE BOOKED BEFORE ITS OUTCOME CAME BACK REFUSED IS SAID TO BE CLOSED: the ledger, not the outcome, says what became of it", async () => {
    writeFeed();
    let armed = false;
    const r = await rig({ wrap: bookThenThrow(() => armed) });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const fills = fillsOf(r.id);
    armed = true;
    const out = await r.lane.close("BTC-PERP", { book: "paper" });
    assert.equal(fillsOf(r.id), fills + 1, "set-up: the close was booked before the throw");
    assert.deepEqual(out, { ok: true, sentence: "BTC-PERP: the practice position was closed." });
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0);
    assert.equal(r.lane.last()?.view?.positions.has("BTC-PERP"), false, "and the lane's read — the report the desk shows — was taken after it");
    assert.equal(reportedOf(r.id), 0, "agents.perps says so at once");
  });

  it("…and part of one, booked before the refusal, is said to be part-closed — never \"stay as they were\"", async () => {
    writeFeed();
    let armed = false;
    const r = await rig({ wrap: bookThenThrow(() => armed) });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const before = (await store.getPerpPositions(r.id, "paper"))[0]!.base;
    await r.lane.report();
    const reported = reportedBaseOf(r.id);
    writeFeed(802_000n, "1");
    armed = true;
    const out = await r.lane.close("BTC-PERP", { book: "paper" });
    const after = (await store.getPerpPositions(r.id, "paper"))[0]!.base;
    assert.ok(after > 0n && after < before, "set-up: the IOC filled only available liquidity");
    assert.deepEqual(out, { ok: false, sentence: "BTC-PERP: the practice close filled only part of the position; the rest remains open with its stop." });
    assert.equal(r.lane.last()?.view?.positions.get("BTC-PERP")?.baseAmount, after, "the lane read again: it holds what is left");
    assert.notEqual(reportedBaseOf(r.id), reported, "and agents.perps shows that, not the size before the close");
  });

  it("…and a Close all whose close filled part of a position before the refusal re-reads it too: the lane and agents.perps show the part left", async () => {
    writeFeed();
    let armed = false;
    const r = await rig({ wrap: bookThenThrow(() => armed) });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const before = (await store.getPerpPositions(r.id, "paper"))[0]!.base;
    await r.lane.report();
    const reported = reportedBaseOf(r.id);
    writeFeed(802_000n, "1");
    armed = true;
    const out = await r.lane.flatten({ book: "paper" });
    const after = (await store.getPerpPositions(r.id, "paper"))[0]!.base;
    assert.ok(after > 0n && after < before, "set-up: the IOC filled only available liquidity");
    assert.deepEqual(out, { ok: false, sentence: "1 practice position remains open after the close attempts, with its stop. New practice positions are paused until you reset the practice book." });
    assert.equal(r.lane.last()?.view?.positions.get("BTC-PERP")?.baseAmount, after, "the lane read again: it holds what is left");
    assert.notEqual(reportedBaseOf(r.id), reported, "and agents.perps shows that, not the size before the close");
  });

  it("…and one whose ledger then could not be read says so: never \"stay as they were\", a claim nobody read", async () => {
    writeFeed();
    let armed = false;
    let unread = false;
    const r = await rig({
      wrap: bookThenThrow(() => armed, () => (unread = true)),
      store: {
        getPerpPositions: async (...args: Parameters<typeof store.getPerpPositions>) => {
          if (unread) throw new Error("SQLITE_BUSY: database is locked");
          return store.getPerpPositions(...args);
        },
      },
    });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    armed = true;
    const out = await r.lane.close("BTC-PERP", { book: "paper" });
    unread = false;
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0, "set-up: the close was booked");
    assert.deepEqual(out, {
      ok: false,
      sentence: "BTC-PERP: the practice close was refused (the practice engine could not price or book it), and what remains could not be read; check the position before asking again.",
    });
    assert.equal(r.lane.last()?.viewUnread, "ledger", "the lane read again after the refusal, and holds the gap");
    assert.equal(reportedOf(r.id), 0, "so agents.perps shows that gap, never the position the close took");
  });

  it("A CLOSE ALL WHOSE CLOSE CAME BACK REFUSED AFTER IT BOOKED re-reads the book, so agents.perps never shows the position it just closed", async () => {
    writeFeed();
    let armed = false;
    const r = await rig({ wrap: bookThenThrow(() => armed) });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    await r.lane.report();
    assert.equal(reportedOf(r.id), 1, "set-up: one position reported");
    armed = true;
    const out = await r.lane.flatten({ book: "paper" });
    assert.deepEqual(out, { ok: true, sentence: "Every practice perpetual position was closed. New practice positions are paused until you reset the practice book." });
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0);
    assert.equal(r.lane.last()?.view?.positions.size, 0, "the lane's read was taken after the close");
    assert.equal(reportedOf(r.id), 0, "and agents.perps says so at once, not at the next pass");
  });

  it("A CLOSE REFUSED BEFORE ANYTHING WAS BOOKED keeps its position and says so, in practice-book words", async () => {
    writeFeed();
    const r = await rig({
      wrap: (ex) => ({
        mode: ex.mode,
        review: ex.review.bind(ex),
        setLeverage: ex.setLeverage?.bind(ex),
        tick: ex.tick?.bind(ex),
        setStop: ex.setStop?.bind(ex),
        place: async (intent, review, ctx) => {
          if (intent.effect !== "close") return ex.place(intent, review, ctx);
          throw new Error("the paper engine could not book it");
        },
      }),
    });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const fills = fillsOf(r.id);
    const out = await r.lane.close("BTC-PERP", { book: "paper" });
    assert.equal(fillsOf(r.id), fills);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
    assert.deepEqual(out, {
      ok: false,
      sentence: "BTC-PERP: the practice close was refused (the practice engine could not price or book it), so the position and its stop stay as they were.",
    });
    assert.doesNotMatch(out.sentence, /Lighter|money was at the venue/, "a practice book has no venue behind it");
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
    const lifted = await r.lane.resetPaper(
      ({ clearEntriesHalt }) => (told.push(clearEntriesHalt), store.resetPaperLedger(r.id, 100, { clearEntriesHalt })),
      { askedAt: clock - 1_000 },
    );
    assert.deepEqual(told, [true]);
    assert.equal(lifted.haltKept, false, "the owner is not told to reset again");
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
      const kept = await r.lane.resetPaper(({ clearEntriesHalt }) => (told.push(clearEntriesHalt), store.resetPaperLedger(r.id, 100, { clearEntriesHalt })), opts);
      assert.deepEqual(told, [false], JSON.stringify(opts));
      assert.equal(kept.haltKept, true, `the owner is told the pause stands: ${JSON.stringify(opts)}`);
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

  /**
   * THE LANE'S MEMORY OF WHEN A CLOSE ALL WAS ASKED FOR DOES NOT SURVIVE A
   * RESTART, and the ledger keeps the halt alone. Hosted, a reset asked for
   * before a Close all can reach the worker after it (the reconcile pass, behind
   * the ferry's short loop) — and after a restart in between, the reset used to
   * lift the halt: no memory, so no order, so lifted. Now what this worker holds
   * no time for, it orders by when it began.
   */
  it("A RESTARTED WORKER NEVER LETS A RESET ASKED FOR BEFORE THE CLOSE ALL LIFT ITS HALT: a halt it holds no time for, it orders by when it began", async () => {
    writeFeed();
    const first = await rig();
    await first.lane.execute(await openDraft(first), { equityUsdg: u(100), equityKnown: true });
    assert.equal((await first.lane.flatten({ askedAt: clock - 10_000 })).ok, true, "the Close all, run by the worker before the restart");
    await first.lane.stopProtect();
    await store.setAgentMode(first.id, "paper", 1, false);
    // The restart: the same agent and ledger, a lane that remembers nothing.
    const restarted = await rig({ reuse: first });
    assert.equal((await restarted.lane.refresh()).view?.opensBlocked, "perps-entries-halted", "the ledger kept the halt");
    const told: boolean[] = [];
    const reset = (askedAt: number) =>
      restarted.lane.resetPaper(({ clearEntriesHalt }) => (told.push(clearEntriesHalt), store.resetPaperLedger(restarted.id, 100, { clearEntriesHalt })), { askedAt });
    // Asked for BEFORE the Close all, delivered only now.
    assert.equal((await reset(clock - 20_000)).haltKept, true, "only the ledger holds it here, and the owner is told it stands");
    assert.deepEqual(told, [false], "nothing orders it after the Close all, so the ledger is not told to lift it");
    assert.equal((await store.getPerpAccount(restarted.id, "paper"))?.entriesHalted, true, "the owner's Close all stands");
    assert.equal((await restarted.lane.refresh()).view?.opensBlocked, "perps-entries-halted");
    assert.deepEqual(await restarted.lane.execute(await openDraft(restarted), { equityUsdg: u(100), equityKnown: true }), { status: "rejected", rejectRule: "perp-entries-halted" });
    // Asked for after the Close all but before the restart: nothing orders that one either, so it lifts nothing — the owner resets again.
    await reset(clock - 5_000);
    assert.deepEqual(told, [false, false]);
    assert.equal((await store.getPerpAccount(restarted.id, "paper"))?.entriesHalted, true);
    // Asked for once this worker began: after the Close all, whenever that ran. It lifts it.
    assert.equal((await reset(clock)).haltKept, false);
    assert.deepEqual(told, [false, false, true]);
    assert.equal((await store.getPerpAccount(restarted.id, "paper"))?.entriesHalted, false);
    assert.equal((await restarted.lane.execute(await openDraft(restarted), { equityUsdg: u(100), equityKnown: true })).status, "paper", "a practice entry opens on the new book");
  });

  it("an older Close all delivered after restart cannot replace the ordering of a newer durable halt", async () => {
    for (const unreadPrior of [false, true]) {
      writeFeed();
      const first = await rig();
      assert.equal((await first.lane.flatten({ askedAt: clock - 10_000 })).ok, true);
      await store.setAgentMode(first.id, "paper", 1, false);
      let reads = 0;
      const restarted = await rig({
        reuse: first,
        store: {
          getPerpAccount: async (...args: Parameters<typeof store.getPerpAccount>) => {
            if (unreadPrior && reads++ === 0) throw new Error("prior halt cannot be read");
            return store.getPerpAccount(...args);
          },
        },
      });
      // This older command was delayed by delivery, and arrives after the
      // newer halt survived a restart. It must not give that halt an older age.
      assert.equal((await restarted.lane.flatten({ askedAt: clock - 30_000 })).ok, true);
      const reset = (askedAt: number) => restarted.lane.resetPaper(
        ({ clearEntriesHalt }) => store.resetPaperLedger(restarted.id, 100, { clearEntriesHalt }),
        { askedAt },
      );
      assert.equal((await reset(clock - 20_000)).haltKept, true, `prior halt unread: ${unreadPrior}`);
      assert.equal((await store.getPerpAccount(first.id, "paper"))?.entriesHalted, true);
      assert.deepEqual(await restarted.lane.execute(await openDraft(restarted), { equityUsdg: u(100), equityKnown: true }), {
        status: "rejected", rejectRule: "perp-entries-halted",
      });
      assert.equal((await reset(clock)).haltKept, false, "a reset requested after this worker began may lift the inherited halt");
    }
  });

  it("A RESET THAT LIFTED NOTHING AND THEN COULD NOT READ THE LEDGER SAYS SO: never that no pause stands, while a halt an earlier worker stored refuses every entry", async () => {
    writeFeed();
    const first = await rig();
    await first.lane.execute(await openDraft(first), { equityUsdg: u(100), equityKnown: true });
    assert.equal((await first.lane.flatten({ askedAt: clock - 10_000 })).ok, true);
    await first.lane.stopProtect();
    await store.setAgentMode(first.id, "paper", 1, false);
    let busy = false;
    const restarted = await rig({
      reuse: first,
      store: {
        getPerpAccount: async (...args: Parameters<typeof store.getPerpAccount>) => {
          if (busy) throw new Error("SQLITE_BUSY: database is locked");
          return store.getPerpAccount(...args);
        },
      },
    });
    // Asked for before this worker began, so it lifts nothing; every read after it fails.
    const kept = await restarted.lane.resetPaper(
      async ({ clearEntriesHalt }) => {
        const epoch = await store.resetPaperLedger(restarted.id, 100, { clearEntriesHalt });
        busy = true;
        return epoch;
      },
      { askedAt: clock - 20_000 },
    );
    busy = false;
    assert.equal(kept.haltKept, "unread", "the reset is done, and the owner is told the ledger could not say");
    assert.equal((await store.getPerpAccount(restarted.id, "paper"))?.entriesHalted, true, "set-up: the pause does stand");
    assert.equal((await restarted.lane.refresh()).view?.opensBlocked, "perps-entries-halted");
  });

  it("A HALT THIS WORKER HOLDS, AND ONE THE RESET LIFTED, NEED NO READ: neither answer waits on a ledger that cannot answer", async () => {
    writeFeed();
    let busy = false;
    const r = await rig({
      store: {
        patchPerpAccount: async () => {
          throw new Error("ledger write unavailable");
        },
        getPerpAccount: async (...args: Parameters<typeof store.getPerpAccount>) => {
          if (busy) throw new Error("SQLITE_BUSY: database is locked");
          return store.getPerpAccount(...args);
        },
      },
    });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.match((await r.lane.flatten({ askedAt: clock - 1_000 })).sentence, /pause could not be saved/);
    await store.setAgentMode(r.id, "paper", 1, false);
    const reset = (askedAt: number) =>
      r.lane.resetPaper(
        async ({ clearEntriesHalt }) => {
          const epoch = await store.resetPaperLedger(r.id, 100, { clearEntriesHalt });
          busy = true;
          return epoch;
        },
        { askedAt },
      );
    assert.equal((await reset(clock - 5_000)).haltKept, true, "asked for before the Close all: the halt only this worker holds stands");
    busy = false;
    assert.equal((await reset(clock)).haltKept, false, "asked for after it: lifted, and nothing left to read");
    busy = false;
    assert.notEqual((await r.lane.refresh()).view?.opensBlocked, "perps-entries-halted");
  });

  // THE TWO GUARDS ON THE LANE'S MEMORY OF A HALT, each pinned where nothing
  // else can stand in for it. The reset-before case above runs on a ledger
  // that stored the halt, so the ledger refuses the open whatever the lane
  // remembers; and every other Close all here is one. Without these, a reset
  // that forgot the memory every time (`ownerEntryHalts.delete` unguarded), or
  // a Close all that overwrote the remembered time instead of keeping the
  // newest (no Math.max), passed every test while losing a halt the owner
  // had been told about.
  it("A RESET ASKED FOR BEFORE A CLOSE ALL WHOSE HALT ONLY THIS WORKER HOLDS (its write failed) NEVER LIFTS IT: the memory is the only copy of the pause the owner was told about", async () => {
    writeFeed();
    const r = await rig({ store: { patchPerpAccount: async () => { throw new Error("ledger write unavailable"); } } });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const out = await r.lane.flatten({ askedAt: clock - 1_000 });
    assert.match(out.sentence, /New practice positions are paused in this worker, but the pause could not be saved/);
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted ?? false, false, "the ledger never heard of it: only the lane holds it");
    await store.setAgentMode(r.id, "paper", 1, false);
    // Hosted, a reset rides the reconcile pass and a Close all the ferry's
    // short loop, so a reset asked for first can reach the worker second.
    const told: boolean[] = [];
    const kept = await r.lane.resetPaper(
      ({ clearEntriesHalt }) => (told.push(clearEntriesHalt), store.resetPaperLedger(r.id, 100, { clearEntriesHalt })),
      { askedAt: clock - 5_000 },
    );
    assert.deepEqual(told, [false], "the ledger is not told to lift it");
    assert.equal((await r.lane.refresh()).view?.opensBlocked, "perps-entries-halted", "and the lane still holds it");
    // The ledger never heard of this halt, so a re-read of it after the reset
    // (what the worker's answer used to be built from) told the owner nothing.
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted ?? false, false);
    assert.equal(kept.haltKept, true, "the owner is told the pause stands, though only this worker holds it");
    assert.deepEqual(await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true }), { status: "rejected", rejectRule: "perp-entries-halted" });
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0, "nothing opened after the owner's Close all");
    // The reset the owner asks for after it is the one that lifts it.
    const lifted = await r.lane.resetPaper(({ clearEntriesHalt }) => store.resetPaperLedger(r.id, 100, { clearEntriesHalt }), { askedAt: clock });
    assert.equal(lifted.haltKept, false);
    assert.notEqual((await r.lane.refresh()).view?.opensBlocked, "perps-entries-halted");
  });

  it("TWO CLOSE-ALLS THAT REACH THE WORKER OUT OF ORDER: the halt keeps the newer one's time, so a reset asked for between them lifts nothing, in the ledger or the lane", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.equal((await r.lane.flatten({ askedAt: clock - 1_000 })).ok, true);
    // The older one second: an overwrite would lower the remembered time below the reset's.
    assert.equal((await r.lane.flatten({ askedAt: clock - 9_000 })).ok, true);
    await store.setAgentMode(r.id, "paper", 1, false);
    const told: boolean[] = [];
    await r.lane.resetPaper(
      ({ clearEntriesHalt }) => (told.push(clearEntriesHalt), store.resetPaperLedger(r.id, 100, { clearEntriesHalt })),
      { askedAt: clock - 5_000 },
    );
    assert.deepEqual(told, [false], "the newest Close all was asked for after this reset");
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, true, "the ledger's halt stands");
    assert.equal((await r.lane.refresh()).view?.opensBlocked, "perps-entries-halted");
    assert.deepEqual(await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true }), { status: "rejected", rejectRule: "perp-entries-halted" });
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
    // The halt is still the owner's to have, and it is STORED: Close all writes
    // it before it reads the book, so a frozen book returns with it saved. Both
    // the saved and the could-not-be-saved sentences say "paused", so the
    // sentence is matched in full and the ledger read.
    assert.match(all.sentence, / New practice positions are paused until you reset the practice book\.$/);
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, true, "the halt is in the ledger though nothing was closed");
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
    assert.equal(fillsOf(r.id), fills);
  });

  it("A PRACTICE BOOK THAT COULD NOT BE READ: Close and Close all close nothing and say the book could not be read, and Close all's halt is stored all the same", async () => {
    writeFeed();
    let unreadable = false;
    const r = await rig({
      store: {
        perpLaneLedgerFacts: async (...args: Parameters<typeof store.perpLaneLedgerFacts>) => {
          if (unreadable) throw new Error("perp_orders x: an amount is unreadable");
          return store.perpLaneLedgerFacts(...args);
        },
      },
    });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const fills = fillsOf(r.id);
    unreadable = true;
    // Prices are fresh: it is the ledger that is not read.
    const read = await r.lane.refresh();
    assert.equal(read.view, null);
    assert.equal(read.viewUnread, "ledger");
    assert.deepEqual(await r.lane.close("BTC-PERP", { book: "paper" }), {
      ok: false,
      sentence: "BTC-PERP: the practice book could not be read, so nothing was sent. Its stop stays in place.",
    });
    const out = await r.lane.flatten({});
    assert.equal(out.ok, false);
    assert.match(out.sentence, /^The practice book could not be read, so no position was closed; they may still be open\. New practice positions are paused until you reset the practice book\.$/);
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, true);
    assert.equal(fillsOf(r.id), fills);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
  });

  /**
   * PRICES THAT COULD NOT BE READ ARE NOT A PRACTICE BOOK THAT COULD NOT BE.
   * The feed file stops being refreshed (the fleet's feed writer down or
   * slow) while the ledger reads fine: the view is null all the same, and the
   * owner used to be told "the practice book could not be read" — and by
   * Close all that their positions "may still be open" — with the ledger
   * showing exactly one open long. Now the sentence says what is true: prices
   * are stale, nothing was sent, the position is still open (Close all: how
   * many), its stop cannot trigger until prices read, ask again.
   */
  it("PRICES THAT COULD NOT BE READ, WITH THE LEDGER READ: Close and Close all send nothing and say the position is still open — and how many — never that the book could not be read", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const fills = fillsOf(r.id);
    const stalePrices = "Lighter's prices could not be read just now";
    for (const gap of ["a feed file ten minutes old", "no feed file at all"] as const) {
      if (gap === "no feed file at all") rmSync(FEED);
      else writeFeed(802_000n, "1000", { ageMs: 10 * 60_000 });
      const read = await r.lane.refresh();
      assert.equal(read.view, null, `${gap}: set-up — no view on these prices`);
      assert.equal(read.viewUnread, "prices", gap);
      assert.deepEqual(await r.lane.close("BTC-PERP", { book: "paper" }), {
        ok: false,
        sentence: `BTC-PERP: ${stalePrices}, so nothing was sent. The practice position is still open, and its stop can only trigger once prices read again. Ask again in a minute.`,
      }, gap);
      // A market with nothing held is still "nothing to close", read from the ledger.
      assert.deepEqual(await r.lane.close("ETH-PERP", { book: "paper" }), { ok: false, sentence: "ETH-PERP: there is no practice position to close. Nothing was sent." }, gap);
      assert.deepEqual(await r.lane.flatten({}), {
        ok: false,
        sentence:
          `${stalePrices}, so no practice position was closed: 1 remains open, with its stop, which can only trigger once prices read again. ` +
          "Ask again in a minute. New practice positions are paused until you reset the practice book.",
      }, gap);
      assert.equal(fillsOf(r.id), fills, `${gap}: nothing was sent on prices nobody read`);
      assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1, gap);
    }
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, true, "Close all's halt is stored before it reads the book (D11)");
    // Prices read again: the same Close closes it.
    writeFeed();
    assert.deepEqual(await r.lane.close("BTC-PERP", { book: "paper" }), { ok: true, sentence: "BTC-PERP: the practice position was closed." });
  });

  it("…and with prices unread and nothing held, Close all says there was nothing open — the ledger read", async () => {
    writeFeed(802_000n, "1000", { ageMs: 10 * 60_000 });
    const r = await rig();
    const out = await r.lane.flatten({});
    assert.deepEqual(out, { ok: true, sentence: "There were no practice perpetual positions open. New practice positions are paused until you reset the practice book." });
  });

  it("A LEDGER ROW NO VIEW CAN BE BUILT FROM is the book's gap, not the prices': with fresh prices, Close and Close all never tell the owner to wait a minute for them", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const fills = fillsOf(r.id);
    // The ledger reads, but its one row has lost its margin fraction (view.ts buildPerpsViewStrict throws on it).
    raw.prepare("UPDATE perp_positions SET imf_bp = NULL WHERE agent_id = ? AND mode = 'paper'").run(r.id.toLowerCase());
    writeFeed();
    const read = await r.lane.refresh();
    assert.equal(read.view, null);
    assert.equal(read.feedFresh, true, "set-up: prices are fresh");
    assert.equal(read.viewUnread, "ledger");
    assert.deepEqual(await r.lane.close("BTC-PERP", { book: "paper" }), {
      ok: false,
      sentence: "BTC-PERP: the practice book could not be read, so nothing was sent. Its stop stays in place.",
    });
    const out = await r.lane.flatten({});
    assert.equal(out.ok, false);
    assert.match(out.sentence, /^The practice book could not be read, so no position was closed; they may still be open\. /);
    assert.equal(fillsOf(r.id), fills);
  });

  /**
   * TWO PRACTICE POSITIONS. Every other owner-exit case holds one, on
   * BTC-PERP, so these went unpinned: Close counts what is left IN THE MARKET
   * IT CLOSED (practiceBaseLeft's market filter) — counted across markets, a
   * BTC close that worked was told "filled only part of the position" and
   * answered not ok, because ETH was still held; Close writes agents.perps at
   * once (reportAfterOwnerExit), not at the next pass; and Close all closes
   * every held market on the one read, one close never moving another's
   * position.
   */
  it("TWO PRACTICE POSITIONS: Close takes the market named and says it closed, the other untouched, and agents.perps shows it at once; Close all closes both", async () => {
    writeFeed(802_000n, "1000", { eth: 268_100n });
    const r = await rig({ cfg: { perpsMarkets: ["BTC-PERP", "ETH-PERP"] } });
    for (const market of ["BTC-PERP", "ETH-PERP"] as const) {
      assert.equal((await r.lane.execute(await openDraft(r, market), { equityUsdg: u(100), equityKnown: true })).status, "paper", market);
    }
    assert.deepEqual(await heldMarketsOf(r.id), [0, 1], "set-up: ETH-PERP (0) and BTC-PERP (1) both held");
    const ethBefore = (await store.getPerpPositions(r.id, "paper")).find((p) => p.marketId === 0)!.base;
    await r.lane.report();
    assert.equal(reportedOf(r.id), 2);

    assert.deepEqual(await r.lane.close("BTC-PERP", { book: "paper" }), { ok: true, sentence: "BTC-PERP: the practice position was closed." });
    assert.deepEqual(await heldMarketsOf(r.id), [0], "BTC-PERP closed, ETH-PERP still held");
    assert.equal((await store.getPerpPositions(r.id, "paper")).find((p) => p.marketId === 0)!.base, ethBefore, "ETH-PERP's size is untouched");
    assert.equal(reportedOf(r.id), 1, "agents.perps says so at once, not at the next pass");

    assert.equal((await r.lane.execute(await openDraft(r, "BTC-PERP"), { equityUsdg: u(100), equityKnown: true })).status, "paper");
    assert.deepEqual(await heldMarketsOf(r.id), [0, 1]);
    const all = await r.lane.flatten({ book: "paper" });
    assert.deepEqual(all, { ok: true, sentence: "Every practice perpetual position was closed. New practice positions are paused until you reset the practice book." });
    assert.deepEqual(await heldMarketsOf(r.id), [], "both closed");
    assert.equal(reportedOf(r.id), 0);
  });

  // CLOSE ALL STORES ITS HALT BEFORE IT CLOSES ANYTHING (lane.ts flatten; docs
  // "Close all writes perp_accounts.entries_halted before it closes anything").
  // The test above it only reads the ledger after a Close all that worked, which
  // a halt written after the closes satisfies as well; here the ledger is read
  // AT the first close, and that close fails.
  it("THE HALT IS IN THE LEDGER WHEN THE FIRST CLOSE IS PLACED, and a close that throws leaves it there", async () => {
    writeFeed();
    const atClose: Array<boolean | undefined> = [];
    let id = "";
    const r = await rig({
      wrap: (ex) => ({
        mode: ex.mode,
        review: ex.review.bind(ex),
        setLeverage: ex.setLeverage?.bind(ex),
        tick: ex.tick?.bind(ex),
        setStop: ex.setStop?.bind(ex),
        place: async (intent, review, ctx) => {
          if (intent.effect !== "close") return ex.place(intent, review, ctx);
          atClose.push((await store.getPerpAccount(id, "paper"))?.entriesHalted);
          throw new Error("the venue went away mid-close");
        },
      }),
    });
    id = r.id;
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted ?? false, false, "set-up: no halt before the Close all");
    const out = await r.lane.flatten({});
    assert.deepEqual(atClose, [true], "the first close was placed with entries_halted already stored");
    assert.equal(out.ok, false);
    assert.match(out.sentence, /^1 practice position remains open after the close attempts, with its stop\. New practice positions are paused until you reset the practice book\.$/);
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1, "the close never landed");
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, true);
  });

  it("…and a Close all that dies at its first close's decision (it throws) has already stored the halt", async () => {
    writeFeed();
    const atDecision: Array<boolean | undefined> = [];
    let id = "";
    const r = await rig({
      decide: async (_intent, source) => {
        if (source !== "chat") return { ok: true };
        atDecision.push((await store.getPerpAccount(id, "paper"))?.entriesHalted);
        throw new Error("the decisions table went away");
      },
    });
    id = r.id;
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    await assert.rejects(r.lane.flatten({}), /the decisions table went away/);
    assert.deepEqual(atDecision, [true], "stored before the owner's close was filed");
    assert.equal((await store.getPerpAccount(r.id, "paper"))?.entriesHalted, true, "a crash here leaves the halt durable");
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1);
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

  // WHAT A SECOND RUN WOULD DO, both ways, so nothing reads the close's shape
  // as a second line behind the claim. A close is built from what is held
  // when it runs: run again with nothing opened since, it finds nothing; run
  // again after the strategy opened that market since, it closes the new
  // position and says so. Only the claim keeps an exit to one run.
  it("were one ever run twice with nothing opened since, the second finds nothing held and books nothing", async () => {
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

  it("…but WERE ONE RUN TWICE AFTER THE STRATEGY OPENED THAT MARKET AGAIN, the second would close the new position, which nobody asked to close — a replay is not harmless, the claim is all that prevents one", async () => {
    writeFeed();
    const r = await rig();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    const cmd = closeCommand("exit-replayed");
    assert.deepEqual(await dispatch(r.lane)(cmd), { ok: true, line: "BTC-PERP: the practice position was closed." });
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 1, "the strategy opened BTC again");
    const fills = fillsOf(r.id);
    // The same command, run a second time (what the claim exists to stop):
    assert.deepEqual(await dispatch(r.lane)(cmd), { ok: true, line: "BTC-PERP: the practice position was closed." });
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0, "the position opened since is gone");
    assert.equal(fillsOf(r.id), fills + 1, "and its close was booked");
    // Through the drain this never happens: the crash case above shows the
    // claimed command is gone, and the position opened since stays.
  });

  it("A STOOD-DOWN PERPS WORKER (D19) claims nothing: the queued exit waits, unclaimed, and the drain leaves the position exactly as it was", async () => {
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

  /**
   * WHAT THE WEB TELLS A SELF-HOSTED OWNER (web perps-enabled.ts
   * perpsStoodDownBook), held to what the worker does. D19 stands a Perps
   * worker down from the owner's commands; it does not switch off a running
   * book's stops (the review's S3-02: the loop starts with every arm, and a
   * held position keeps the lane active whatever the switch says). So the
   * refusal says the positions are still managed by their own rules, never
   * that they stay exactly as they are: a worker started by hand under
   * MERRYMEN_PERPS unset closed this one on its stop while the owner's Close
   * waited, refused. Hosted no Perps child runs, which is the frozen case.
   */
  it("A STOOD-DOWN WORKER THAT RUNS ANYWAY STILL KEEPS WHAT IT HOLDS ON ITS STOPS: commands are stood down, the book's own protection is not", async () => {
    writeFeed();
    const r = await rig({ cfg: { perpsOperatorCeiling: "paper" } });
    const home = newHome();
    assert.equal((await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true })).status, "paper");
    const [held] = await store.getPerpPositions(r.id, "paper");
    assert.ok(held?.stopTrigger, "the practice position carries its stop");
    // Started by hand with MERRYMEN_WALLET_PURPOSE=perps, MERRYMEN_PERPS unset.
    const handStarted = mergeSettings({ perpsEnabled: true }, { MERRYMEN_WALLET_PURPOSE: "perps" });
    assert.equal(perpsWorkerStoodDown(handStarted), true);
    r.cfg = { ...r.cfg, perpsOperatorCeiling: handStarted.perpsOperatorCeiling };
    writeCommand(home, closeCommand("exit-refused"));
    let ran = 0;
    await runTickCommand(home, { now: () => clock, mayRun: () => !perpsWorkerStoodDown(handStarted), run: async () => (ran++, { ok: true, line: "ran" }), told: async () => {} });
    assert.equal(ran, 0, "the owner's Close is not taken");
    await r.lane.armed();
    assert.equal(r.lane.protecting, true, "the protective loop starts with the arm, under any ceiling");
    await r.lane.stopProtect(); // the pass below is driven by hand
    // The mark falls through the trigger; the book still bids above the stop's bound.
    writeFeed(held.stopTrigger - 100n);
    await r.lane.protectPass({ lock: r.lane.lock, signal: new AbortController().signal, pass: 1 });
    assert.equal((await store.getPerpPositions(r.id, "paper")).length, 0, "its own stop closed it");
    assert.ok(r.events.some((e) => /BTC-PERP stop fired/.test(e)), JSON.stringify(r.events));
    assert.deepEqual(queuedCommandIds(home), ["exit-refused"], "and the owner's Close still waits, unclaimed");
  });

  it("…and one that waited past its window is answered expired when perps come back, with nothing sent", async () => {
    writeFeed();
    const r = await rig();
    const home = newHome();
    await r.lane.execute(await openDraft(r), { equityUsdg: u(100), equityKnown: true });
    writeCommand(home, closeCommand("exit-stale", clock - 1));
    let ran = 0;
    const paper = mergeSettings({}, { MERRYMEN_WALLET_PURPOSE: "perps", MERRYMEN_PERPS: "paper" });
    // The worker's own drain hooks (index.ts runQueuedCommand spreads them),
    // so this pins the sentence an owner is told, not the drain's Spot one.
    await runTickCommand(home, {
      now: () => clock,
      mayRun: () => !perpsWorkerStoodDown(paper),
      run: async () => (ran++, { ok: true, line: "ran" }),
      told: async () => {},
      ...orderExpiryHooks,
    });
    assert.equal(ran, 0);
    const state = readCommandState(home, "exit-stale");
    assert.equal(state?.state, "done");
    assert.equal(state?.result?.ok, false);
    assert.match(
      state?.result?.line ?? "",
      /^expired — I picked up this close of BTC-PERP .* after its window closed, so it did not run: nothing was sent and no practice position was closed\. Ask again if you still want it\.$/,
    );
    assert.doesNotMatch(state?.result?.line ?? "", /fill|different market/, "never the drain's Spot order sentence");
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
    // A halt the reset left (one it could not order) is told to the owner, as
    // the lane reports it: never re-read from the ledger alone, which misses a
    // halt only the lane holds (its write failed). The lane tests above pin
    // haltKept itself, each way and for that case.
    const reset = fn("runPaperReset");
    assert.match(reset, /const \{ out: opened, haltKept \} = await perpLane\.resetPaper\(/);
    assert.doesNotMatch(reset, /getPerpAccount/);
    assert.match(reset, /`paper book restarted at \$\{fmt\(usdg\(cfg\.paperStartUsdg\)\)\} USDG with no positions\.` \+ resetHaltSentence\(haltKept\)/);
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
    // The admission level before the lane (worker-admission.ts ownerPerpExitRefusal;
    // admission-invariant.test.ts pins the refusal's branch).
    const admitted = branch.indexOf("const notAdmitted = ownerPerpExitRefusal({ level: admission.level, draining });");
    assert.ok(admitted > 0 && admitted < branch.indexOf("perpLane.close("), "the tenant's admission level is asked before the lane");
    assert.match(branch, /await perpLane\.close\(exit\.order\.symbol, \{ book: exit\.order\.book, notAfterMs \}\)/);
    assert.match(branch, /await perpLane\.flatten\(\{ \.\.\.\(exit\.order\.book \? \{ book: exit\.order\.book \} : \{\}\), notAfterMs, askedAt: cmd\.at \}\)/);
    assert.match(branch, /return \{ ok: result\.ok, line: result\.sentence \};/);
    const at = CODE.indexOf("  function orderOutcome(");
    const outcome = CODE.slice(at, CODE.indexOf("\n  }\n", at));
    assert.match(outcome, /if \(isPerpExitRoute\(orderRoute\(cmd\.args\)\)\) return \{ ok: reply\.ok, line: reply\.line \};\s*const receipt =/);
  });

  /**
   * PAUSE NEVER STANDS BETWEEN AN OWNER AND A CLOSE (docs/perps.md rule 8a).
   * placeOrder sends a parsed exit on before its pause gate, and
   * order-gate.test.ts ("IS NEVER STRANDED") pins that, but it drives
   * placeOrder alone: a pause check added in runOrderCommand ahead of it, "for
   * every order", would strand Close and Close all on a paused agent and still
   * pass there. So here the pause is read once in runOrderCommand, only into
   * the reads placeOrder judges. And its header must say an exit is exempt,
   * because it used to say the opposite ("An ORDER is the opposite ... So the
   * gate is per kind") after PR 1 routed the exits through it: the very
   * instruction that change, or an incident reader, would have followed.
   */
  it("PAUSE NEVER STANDS BETWEEN AN OWNER AND A CLOSE: runOrderCommand reads the pause only into placeOrder's reads, and its header says an exit is exempt", () => {
    const run = fn("runOrderCommand");
    assert.deepEqual(run.match(/\bisPaused\(\)|\bpaused\b/g), ["paused", "isPaused()"], "the pause is read once, and named only as placeOrder's read");
    assert.match(run, /return placeOrder\(\s*cmd\.args,\s*orderReadsOf\(reads, \{ paused: isPaused\(\), ceilingUsdg: cfg\.telegramMaxActionUsdg \}\),/);
    const at = SRC.indexOf("  async function runOrderCommand(");
    const header = SRC.slice(SRC.lastIndexOf("/**", at), at);
    assert.ok(header.length > 200, "found runOrderCommand's header");
    assert.doesNotMatch(header, /An ORDER is the opposite/, "the header no longer says the pause gates every order");
    assert.match(header, /PERPETUAL EXIT RUNS THROUGH THE PAUSE/);
    assert.match(header, /rule 8a/);
    assert.match(header, /placeOrder \(order-gate\.ts\) sends a parsed exit to the submitter\s+\*\s+BEFORE its unread, pause and ceiling gates/);
    assert.match(header, /DO NOT add a pause check here/);
  });

  it("A STOOD-DOWN PERPS WORKER'S DRAIN CLAIMS NOTHING (D19)", () => {
    assert.match(fn("runQueuedCommand"), /mayRun: cmd => !!active && !perpsWorkerStoodDown\(cfg\) && !recoveryCommandRefused\(/);
  });

  it("THE DRAIN KNOWS WHICH ACCOUNT IS ARMED, so a command bound to another is answered and never run (command-files.ts notForThisAccount)", () => {
    assert.match(fn("runQueuedCommand"), /account: \(\) => active\?\.grant\.smartAccount \?\? null,/);
  });

  it("AN OWNER'S PERPETUAL EXIT THAT EXPIRED IS ANSWERED WITHOUT A RECEIPT, on the drain's hook and in runCommand alike (order-receipt.ts expiredOrderReceipt)", () => {
    // The drain's hooks are order-receipt.ts orderExpiryHooks, passed whole,
    // and its receipt hook gives a Spot order its receipt and an exit none.
    // LAST, so no key after the spread can override a hook and bring the
    // drain's Spot sentence back for an expired exit.
    assert.match(fn("runQueuedCommand"), /runTickCommand\([\s\S]*\.\.\.orderExpiryHooks,\s*\}\);/);
    const at = { id: "x", at: 1, expiresAt: 2 };
    assert.equal(orderExpiryHooks.expiredReceipt({ ...at, kind: "trade", args: { side: "sell", symbol: "BTC-PERP", usdgAmount: 0, purpose: "close-perp", book: "paper" } }), undefined);
    assert.equal(orderExpiryHooks.expiredReceipt({ ...at, kind: "trade", args: { side: "sell", symbol: "ALL-PERPS", usdgAmount: 0, purpose: "flatten-perps" } }), undefined);
    assert.equal(orderExpiryHooks.expiredReceipt({ ...at, kind: "trade", args: { side: "buy", symbol: "TSLA", usdgAmount: 5 } })?.status, "expired");
    assert.equal(orderExpiryHooks.expiredReceipt({ ...at, kind: "selftest" }), undefined);
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
    const execute = lane.slice(lane.indexOf("async function executeLocked("), lane.indexOf("async function announceTick("));
    assert.match(execute, /deps\.budget\.reserve\(spend\);\s*let placed[^;]*;\s*try \{[\s\S]*?\} finally \{\s*deps\.budget\.release\(spend\);/);
  });

  it("THE LANE'S BUDGET IS THE WORKER'S OWN TWO HALVES: counters read both as they stand, and keep books a booked op into the settled half (heldReservation's branch)", () => {
    assert.match(CODE, /counters: async \(\) => \(\{ spentTodayUsdg: spentToday\(\), opsToday: opsTodayCount\(\) \}\),/);
    assert.match(CODE, /keep: \(spend\) => \{\s*settledOps \+= 1;\s*settledSpentUsdg \+= spend;\s*\},/);
  });
});
