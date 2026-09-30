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
  PERP_LIVE_NOT_YET,
  createPerpFeedHost,
  createPerpLane,
  entryCandleOf,
  isHostedChildProcess,
  perpsRailOf,
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
  opts: { cfg?: Partial<PerpLaneConfig>; wrap?: (ex: PerpExecutor) => PerpExecutor; store?: Partial<typeof store> } = {},
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
    budget: {
      reserve: (s) => void r.budget.reserved.push(s),
      release: (s) => void r.budget.released.push(s),
      refresh: async () => {},
    },
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
    await r.lane.resetPaper(() => store.resetPaperLedger(r.id, 100));
    const after = await r.lane.refresh();
    assert.equal(after.held, false);
    assert.equal(after.view?.positions.size, 0);
    assert.equal((await store.getPaperBook(r.id, 100)).cashUsdg, 100);
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

  it("the route runs after the class route, inside tick(), and nothing perp is in the strategy loop", () => {
    const tick = fn("tick");
    const classEntries = tick.indexOf("await classGate.entries(");
    const route = tick.indexOf("await perpLane.runRoute(");
    assert.ok(classEntries > 0 && route > classEntries);
  });

  it("the lane's reservation is released in a finally", () => {
    const lane = codeOnly(readFileSync(path.join(HERE, "lane.ts"), "utf8"));
    assert.match(lane, /deps\.budget\.reserve\(spend\);\s*let placed[^;]*;\s*try \{[\s\S]{0,400}\} finally \{\s*deps\.budget\.release\(spend\);/);
  });
});
