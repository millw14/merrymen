/**
 * PAPER PERPS, END TO END — the real lane (perps/lane.ts), the real ledger
 * (store.ts on an isolated sqlite home), the real feed-file reader over a
 * synthetic `lighter-feed.json`, the real checkPolicy, the real paper
 * executor and the real perp-trend producer. Only index.ts's own plumbing
 * (energy claims, the decision writer, the budget halves) is modelled, each
 * with the same shape index.ts gives it.
 *
 * The story, in order, on one account:
 *   perps on (paper) → perp-trend opens BTC-PERP long WITH its stop
 *   → equity is unchanged at zero price move (margin left cash for ΣM)
 *   → the price rises: equity shows it, and no peak ratchets on it
 *   → the price falls through the stop: the protective loop's venue clock
 *     fires it — closed, realized, journaled exactly once, however often the
 *     loop looks again
 *   → the day's budget counted the open once, and the stop not at all.
 * Then, on a second account at 10x, the protective loop closes on
 * liquidation proximity with no tick and no route running at all (a paused
 * agent); and the loop runs on its own clock once armed. Last, a LIVE
 * account with perps on never reaches an executor.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { parsePerpsReport } from "../../../packages/core/src/perps";
import { tickPlan, tickRatchets } from "../command-wake";
import { composeEquityUsdg, peakBasisUsdg, type PerpBookTerm } from "../equity";
import type { ExecMode } from "../exec-mode";
import type { AgentLimits, PerpOrderIntent, TradeIntent } from "../policy";
import { provenanceOf } from "../provenance";
import { buildOpenDraft } from "./drafts";
import { readLighterFeed, specToJson, type LighterFeedFileMarket } from "./feed-reader";
import { createPaperPerpExecutor } from "./executor";
import { createPerpLane, type PerpLane, type PerpLaneConfig, type PerpLaneDeps } from "./lane";
import { parseOrderBookDetails } from "./markets";
import { H4, T_LAST, breakout } from "./testkit-perps";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-e2e-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_FLEET_HOME;
const originalCwd = process.cwd();
const store = await import("../store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
after(() => {
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const DETAILS = parseOrderBookDetails(JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "orderBookDetails.perp.json"), "utf8")))!;
const BTC = DETAILS.markets.get(1)!;
const FEED_FILE = path.join(scratch, "lighter-feed.json");
const u = (n: number) => BigInt(Math.round(n * 1e6));

// ── the clock and the venue, as the feed file carries them ──────────────────

/** One hour into the candle after the last closed one (testkit's NOW). */
let clock = T_LAST + H4 + 3_600_000;
const CANDLES = breakout("BTC-PERP", 2_000n); // 119 flat bars at 80,000.0, then a close at 80,200.0: a long breakout

function writeFeed(v: { mark: bigint; bids: [bigint, bigint][]; asks: [bigint, bigint][] }): void {
  const lastHour = Math.floor((clock / 1000 - 1800) / 3600) * 3600;
  const m: LighterFeedFileMarket = {
    observedAt: clock - 1_000,
    priceSource: "ws",
    mark: v.mark.toString(),
    index: v.mark.toString(),
    status: "active",
    spec: specToJson(BTC.spec),
    specObservedAt: clock - 60_000,
    takerFeePpm: 0,
    makerFeePpm: 0,
    bids: v.bids.map(([p, s]) => [p.toString(), s.toString()]),
    asks: v.asks.map(([p, s]) => [p.toString(), s.toString()]),
    bookObservedAt: clock - 1_000,
    bookSource: "ws",
    closed4h: CANDLES.map((c) => ({ t: c.t, o: c.o.toString(), h: c.h.toString(), l: c.l.toString(), c: c.c.toString() })),
    candlesObservedAt: T_LAST + H4 + 60_000,
    // 0.0010 %/h paid by longs: 10 ppm, inside perp-trend's 50 ppm limit.
    fundings1h: Array.from({ length: 8 }, (_, i) => ({ t: lastHour - (7 - i) * 3600, rate: "0.0010", direction: "long" as const })),
    fundingsObservedAt: clock - 60_000,
  };
  writeFileSync(FEED_FILE, JSON.stringify({ v: 1, observedAt: clock - 500, markets: { "1": m } }));
}

// ── one account's worth of index.ts plumbing ────────────────────────────────

const PAPER: ExecMode = { mode: "paper", rule: "live-not-enabled" };
const LIVE: ExecMode = { mode: "live" };

function config(over: Partial<PerpLaneConfig> = {}): PerpLaneConfig {
  return {
    perpsEnabled: true,
    perpsLiveEnabled: false,
    perpsDriver: "perp-trend",
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
    ...over,
  };
}

let nextAccount = 1;
interface Account {
  id: string;
  lane: PerpLane;
  events: { level: string; message: string }[];
  inFlight: { ops: number; spend: bigint };
  energy: { claimed: number; refunded: number };
  executorsMade: number;
  cfg: PerpLaneConfig;
  exec: ExecMode;
}

async function account(opts: { cfg?: Partial<PerpLaneConfig>; exec?: ExecMode } = {}): Promise<Account> {
  const hex = (nextAccount++).toString(16).padStart(38, "0");
  const id = await store.ensureAgent({
    smartAccount: `0xAb${hex}`,
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
    cashToken: "0x00000000000000000000000000000000000000dd",
    maxDrawdownBps: 1_000,
    expiresAt: Math.floor(clock / 1000) + 30 * 86_400,
    maxOpsPerDay: 48,
  };
  const acct = {
    id,
    events: [] as { level: string; message: string }[],
    inFlight: { ops: 0, spend: 0n },
    energy: { claimed: 0, refunded: 0 },
    executorsMade: 0,
    cfg: config(opts.cfg),
    exec: opts.exec ?? PAPER,
  } as Account;
  const deps: PerpLaneDeps = {
    store,
    armed: () => ({ agentId: id, smartAccount: `0xAb${hex}`, limits }),
    config: () => acct.cfg,
    execMode: () => acct.exec,
    readFeed: (nowMs) => readLighterFeed(FEED_FILE, nowMs),
    now: () => clock,
    // index.ts perpAgentState's shape: the settled counters (the same store
    // reads refreshBudget makes) plus what is in flight.
    agentState: async ({ equityUsdg, equityKnown }) => ({
      spentTodayUsdg: u(await store.getSpentTodayUsdg(id, "paper")) + acct.inFlight.spend,
      opsToday: (await store.getOpsToday(id, "paper")) + acct.inFlight.ops,
      highWaterMarkUsdg: u(100),
      equityUsdg,
      equityKnown,
      nowSec: Math.floor(clock / 1000),
    }),
    budget: {
      reserve: (spend) => {
        acct.inFlight.ops += 1;
        acct.inFlight.spend += spend;
      },
      release: (spend) => {
        acct.inFlight.ops -= 1;
        acct.inFlight.spend -= spend;
      },
      refresh: async () => {},
    },
    events: async (level, message) => {
      acct.events.push({ level, message });
    },
    decide: (intent, source, reason, known) => decide(id, intent, source, reason, known),
    paperExecutor: (o) => {
      acct.executorsMade += 1;
      return createPaperPerpExecutor(o);
    },
    log: () => {},
  };
  acct.lane = createPerpLane(deps);
  return acct;
}

/** index.ts ensureDecision's contract: mint an id, write the row with the provenance its Why gives. */
async function decide(agentId: string, intent: TradeIntent, source: string, reason?: string, known?: { whyCode?: string }) {
  if (intent.decisionId) return { ok: true as const };
  const id = store.newDecisionId();
  intent.decisionId = id;
  await store.addDecision({
    id,
    agent_id: agentId,
    source,
    ...(reason !== undefined ? { reason } : {}),
    provenance: provenanceOf(source, known?.whyCode),
  });
  return { ok: true as const };
}

/** The tick's read: paper cash and the perp term in one hold, composed exactly as index.ts composes equity. */
async function equityOf(a: Account): Promise<{ equity: bigint; basis: bigint; book: PerpBookTerm; cash: bigint }> {
  const { value, read } = await a.lane.readWithBook(() => store.getPaperBook(a.id, 100));
  const cash = u(value.cashUsdg);
  const perp = read.book === "unread" ? undefined : read.book;
  const equity = composeEquityUsdg({ cashUsdg: cash, vaultUsdg: 0n, positionsUsdg: 0n, quarantinedCostUsdg: 0n, perp });
  return { equity, basis: peakBasisUsdg(equity, perp), book: read.book, cash };
}

function hooks(a: Account, equityUsdg: bigint) {
  return {
    claimEntry: async () => {
      a.energy.claimed += 1;
      return { ok: true };
    },
    refundEntry: async (c: { ok: boolean } | null) => {
      if (c?.ok) a.energy.refunded += 1;
    },
    withholdEntry: async () => {},
    ensureDecision: (i: TradeIntent, s: string, r?: string, k?: { whyCode?: string }) => decide(a.id, i, s, r, k),
    // processIntentReporting → processIntentLocked's perp branch.
    processIntentReporting: (i: TradeIntent) => a.lane.execute(i as PerpOrderIntent, { equityUsdg, equityKnown: true }),
    processIntent: async (i: TradeIntent) => {
      await a.lane.execute(i as PerpOrderIntent, { equityUsdg, equityKnown: true });
    },
  };
}

const TICK = {
  equityKnown: true,
  breakerIdle: true,
  breakerLimitBps: 1_000,
  energyEntriesLeft: true,
  opsHeadroom: true,
  spendHeadroomMicro: u(500),
  strategistLive: false,
};

function pass(a: Account, n = 1) {
  return a.lane.protectPass({ lock: a.lane.lock, signal: new AbortController().signal, pass: n });
}

async function held(a: Account) {
  return (await store.getPerpPositions(a.id, "paper")).find((p) => p.marketId === 1) ?? null;
}

function journalKinds(a: Account, kind: string): Promise<number> {
  return store.readJournal(a.id, 1).then((rows) => rows.filter((r) => r.kind === kind).length);
}

// ── the story ───────────────────────────────────────────────────────────────

describe("paper perps, end to end, on one account", () => {
  let a: Account;
  let margin = 0n;
  let quote = 0n;

  before(async () => {
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    a = await account();
  });

  it("perp-trend opens a BTC-PERP long WITH its stop, through the route's claim → decision → execute", async () => {
    const start = await equityOf(a);
    assert.equal(start.equity, u(100), "a flat paper book with perps on is a known zero, not a gap");
    await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, hooks(a, start.equity));

    const p = await held(a);
    assert.ok(p, "the open landed on the paper book");
    assert.equal(p.side, "long");
    assert.ok(p.stopTrigger !== null && p.stopTrigger < 802_000n, "every open carries its own stop, below the entry");
    assert.equal(p.imfBp, 5_000, "2x isolated — set by the lane while the market was flat, never chosen by the producer");
    assert.equal(p.entryPrice, 802_000n, "filled at the ask, which is the mark");
    margin = p.allocatedMarginMicro;
    assert.ok(margin > 0n);

    assert.equal((await store.listSubmittedPerpOrders(a.id, "paper")).length, 0, "a paper order resolves on the spot — nothing is left unresolved");
    assert.equal(a.energy.claimed, 1, "the entry claimed one of today's new trades");
    assert.equal(a.energy.refunded, 0, "and it became a trade, so nothing went back");
    assert.ok(a.events.some((e) => /opened a 2x long on BTC-PERP/.test(e.message)), JSON.stringify(a.events));
  });

  it("equity is unchanged at zero price move: the margin left cash and is counted once, as ΣM", async () => {
    const e = await equityOf(a);
    assert.notEqual(e.book, "unread");
    assert.ok(e.book !== undefined && e.book !== "unread");
    assert.equal(e.book.isolatedMarginMicro, margin);
    assert.equal(e.book.unrealizedMicro, 0n, "marked at the price it filled at");
    assert.equal(e.cash, u(100) - margin, "the paper book's cash paid the margin (fees are 0 on Lighter's standard tier)");
    assert.equal(e.equity, u(100), "cash + ΣM + ΣU — the margin is not counted twice, and not lost");
  });

  it("a price move shows in equity, and no peak ratchets on the open gain", async () => {
    writeFeed({ mark: 820_000n, bids: [[819_900n, 1_000n]], asks: [[820_000n, 1_000n]] });
    const e = await equityOf(a);
    assert.ok(e.book !== undefined && e.book !== "unread");
    assert.ok(e.book.unrealizedMicro > 0n, "the gain is in the book");
    assert.equal(e.equity, u(100) + e.book.unrealizedMicro);
    assert.equal(e.basis, u(100), "the peak basis leaves each open gain out (rule 12)");
    // The paper peak, exactly as the tick ratchets it.
    const ratchet = tickRatchets(tickPlan("regular"), { incomplete: false, curveMarked: 0 });
    let written: number | null = null;
    const peak = await ratchet.paperPeak({ hwmUsdg: 100 }, Number(e.basis) / 1e6, async (b) => {
      written = b.hwmUsdg;
    });
    assert.equal(peak, 100, "no ratchet on a gain nobody has taken");
    assert.equal(written, null);
  });

  it("the stop fires on the protective loop's venue clock: closed, realized, journaled exactly once", async () => {
    const before = await held(a);
    assert.ok(before?.stopTrigger);
    const trigger = before.stopTrigger;
    const stopPrice = before.stopPrice!;
    clock += 120_000;
    // The mark falls through the trigger; the book still bids above the stop's bound.
    writeFeed({ mark: trigger - 100n, bids: [[stopPrice + 50n, 1_000n]], asks: [[trigger, 1_000n]] });
    await pass(a, 1);

    assert.equal(await held(a), null, "the stop closed the position");
    const fills = await store.readJournal(a.id, 1);
    assert.equal(fills.filter((r) => r.kind === "perp-fill").length, 2, "the open's fill and the stop's fill");
    const stopFill = fills.filter((r) => r.kind === "perp-fill").map((r) => JSON.parse(r.payload_json) as Record<string, unknown>)[1]!;
    assert.equal(stopFill.attribution, "venue-stop");
    assert.ok(BigInt(String(stopFill.realizedMicro)) < 0n, "a stop below the entry realizes a loss");
    const realized = BigInt(String(stopFill.realizedMicro));

    // The loop looks again, and again: nothing is booked twice.
    clock += 15_000;
    writeFeed({ mark: trigger - 100n, bids: [[stopPrice + 50n, 1_000n]], asks: [[trigger, 1_000n]] });
    await pass(a, 2);
    await pass(a, 3);
    assert.equal(await journalKinds(a, "perp-fill"), 2, "journaled exactly once");

    const e = await equityOf(a);
    assert.equal(e.equity, u(100) + realized, "the margin came home with the loss taken out of it");
    assert.ok(a.events.some((x) => /BTC-PERP stop fired/.test(x.message)), JSON.stringify(a.events));
    const facts = await store.perpLaneLedgerFacts(a.id, "paper", Math.floor(clock / 1000) - 86_400);
    assert.equal(facts.lastExits.get(1)?.cause, "stop", "perp-trend's cooldown clock reads it as a stop");
  });

  it("the day's budget counted the open once — and the stop not at all", async () => {
    const orders = await store.perpOpenNotionalSince(a.id, "paper", Math.floor(Date.now() / 1000) - 86_400);
    quote = orders;
    assert.ok(quote > 0n && quote <= u(25), "the open's filled notional, inside the 25 USDG perp cap");
    assert.equal(u(await store.getSpentTodayUsdg(a.id, "paper")), quote, "spend is the open's notional, once");
    assert.equal(await store.getOpsToday(a.id, "paper"), 1, "one op: the open (a venue stop firing is not an order)");
    assert.deepEqual(a.inFlight, { ops: 0, spend: 0n }, "no reservation was left behind");
  });

  it("agents.perps — the report the web and the apps read — says the book is flat, in a shape core's parser accepts", async () => {
    await a.lane.report();
    const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME!, "merrymen.db"));
    try {
      const row = raw.prepare("SELECT perps FROM agents WHERE smart_account = ?").get(a.id) as { perps: string | null } | undefined;
      assert.ok(row?.perps, "the lane wrote the column");
      const r = parsePerpsReport(JSON.parse(row.perps));
      assert.ok(r, "parsePerpsReport is the one reader, and it accepts what the lane wrote");
      assert.equal(r.mode, "paper");
      assert.deepEqual(r.positions, []);
      assert.equal(r.collateralMicro, "0", "a read zero — never null, which would read as 'Lighter could not be read'");
    } finally {
      raw.close();
    }
  });
});

describe("the protective loop, with no tick and no route running (a paused agent)", () => {
  it("closes a 10x long on liquidation proximity when its stop was gapped through", async () => {
    clock += 3_600_000;
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    const a = await account({ cfg: { perpsMaxLeverage: 10, perpsDriver: "manual" } });
    // The OWNER's open (manual driver): drafted from the lane's own view, as
    // the dashboard's order would be, and sent through the same lane.
    const view = (await a.lane.refresh()).view;
    assert.ok(view);
    const m = view.markets.get("BTC-PERP")!;
    assert.equal(m.imfBp, 1_000, "10x on BTC");
    const built = buildOpenDraft({ market: m, side: "long", notionalCapMicro: u(20), stopBps: 500, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok, JSON.stringify(built, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const intent = { ...built.draft } as PerpOrderIntent;
    await decide(a.id, intent, "perp-route");
    const out = await a.lane.execute(intent, { equityUsdg: u(100), equityKnown: true });
    assert.equal(out.status, "paper", JSON.stringify(a.events));
    const opened = await held(a);
    assert.ok(opened);
    const liq = (await a.lane.refresh()).view?.positions.get("BTC-PERP")?.liqPrice;
    assert.ok(typeof liq === "bigint" && liq > 0n);

    // Past the open's grace; the mark sits 0.5% above liquidation (inside
    // half the 2% buffer), below the stop's trigger — and the book is BELOW
    // the stop's bound, so the resting stop gaps and cannot save it.
    clock += 120_000;
    const mark = liq + (liq * 50n) / 10_000n;
    const bid = mark - (mark * 50n) / 10_000n;
    assert.ok(bid < opened.stopPrice!, "the book is under the stop's bound: the venue stop gaps");
    writeFeed({ mark, bids: [[bid, 1_000n]], asks: [[mark, 1_000n]] });
    await pass(a, 1);

    assert.equal(await held(a), null, "closed by the backstop, not liquidated");
    const fills = (await store.readJournal(a.id, 1)).filter((r) => r.kind === "perp-fill").map((r) => JSON.parse(r.payload_json) as Record<string, unknown>);
    assert.equal(fills.length, 2, "the open and the protective close — no liquidation fill");
    assert.equal(fills[1]!.attribution, "intent", "an order of ours, not the venue's");
    const facts = await store.perpLaneLedgerFacts(a.id, "paper", Math.floor(clock / 1000) - 86_400);
    assert.equal(facts.lastExits.get(1)?.cause, "risk", "its decision is a hard risk exit (perp-risk-exit → provenance)");
    const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME!, "merrymen.db"));
    try {
      const rows = raw.prepare("SELECT source, provenance, reason FROM decisions WHERE agent_id = ? ORDER BY at, rowid").all(a.id) as {
        source: string;
        provenance: string;
        reason: string | null;
      }[];
      const close = rows.find((d) => d.provenance === "hard-risk-exit");
      assert.ok(close, JSON.stringify(rows));
      assert.equal(close.source, "perp-route", "filed under the withheld perp source (rule 17)");
      assert.match(close.reason ?? "", /liquidation price/, "P1 — liquidation proximity — is the rule that closed it");
    } finally {
      raw.close();
    }
    assert.ok(a.events.some((e) => /stop was gapped through/.test(e.message)), JSON.stringify(a.events));
    assert.ok(a.events.some((e) => /closed the long on BTC-PERP/.test(e.message)), JSON.stringify(a.events));
  });

  it("runs on its own clock once armed — started by the arm, never by a tick", async () => {
    clock += 60_000;
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    const a = await account();
    assert.equal(a.lane.protecting, false);
    await a.lane.armed();
    assert.equal(a.lane.protecting, true, "perps on: the loop starts with the arm");
    const t0 = Date.now();
    while (a.lane.last()?.report.protectAt === null || a.lane.last()?.report.protectAt === undefined) {
      if (Date.now() - t0 > 5_000) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(a.lane.last()?.report.protectAt, "a pass ran on the loop's own timer");
    await a.lane.stopProtect();
    assert.equal(a.lane.protecting, false);

    const off = await account({ cfg: { perpsEnabled: false } });
    await off.lane.armed();
    assert.equal(off.lane.protecting, false, "perps off and nothing held: no loop, and Lighter is never read");
    assert.equal(off.lane.last()?.book, undefined, "the known zero of an agent with no perps");
  });
});

describe("a LIVE account with perps on", () => {
  it("never reaches an executor: refuse('perp-live-not-yet'), said once per arm", async () => {
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    const a = await account({ exec: LIVE, cfg: { perpsLiveEnabled: true } });
    const r = await a.lane.refresh();
    assert.deepEqual(r.rail, { mode: "refuse", rule: "perp-live-not-yet" });
    assert.equal(r.book, undefined, "no live perps exist in this build: the known zero, Lighter never read");
    assert.equal(r.view, undefined);
    assert.equal(r.report.mode, "refuse");

    const open: PerpOrderIntent = {
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
      stopTrigger: 762_000n,
      stopPrice: 746_760n,
    };
    const out = await a.lane.execute(open, { equityUsdg: u(100), equityKnown: true });
    assert.deepEqual(out, { status: "rejected", rejectRule: "perp-live-not-yet" });
    const close: PerpOrderIntent = { kind: "perp-order", venue: "lighter", market: "BTC-PERP", marketId: 1, effect: "close", side: "long", reduceOnly: true, baseAmount: 20n, worstPrice: 790_000n, markPrice: 802_000n, notionalUsdg: 0n };
    const outClose = await a.lane.execute(close, { equityUsdg: u(100), equityKnown: true });
    assert.equal(outClose.status, "rejected");
    await a.lane.runRoute({ ...TICK, equityUsdg: u(100) }, hooks(a, u(100)));
    await pass(a, 1);
    assert.equal(a.executorsMade, 0, "no executor was ever built for a live account");
    assert.equal((await store.getPerpPositions(a.id, "live", { includeFlat: true })).length, 0);
    assert.equal((await store.getPerpPositions(a.id, "paper", { includeFlat: true })).length, 0, "and never a practice book beside it");

    const said = a.events.filter((e) => /real-money perpetuals are not available in this version yet/.test(e.message));
    assert.equal(said.filter((e) => /^perpetuals are switched on/.test(e.message)).length, 1, "the rail is said once");
    assert.ok(a.events.some((e) => /refused — perp-live-not-yet/.test(e.message)), "the refusal is the owner's to see");
    await a.lane.armed();
    assert.equal(
      a.events.filter((e) => /^perpetuals are switched on, but this account trades for real/.test(e.message)).length,
      2,
      "and said again after a new arm",
    );
    await a.lane.stopProtect();
  });
});

describe("the refusal the owner sees", () => {
  it("a paper open over the collateral cap is refused by name, visible, and books nothing", async () => {
    clock += 60_000;
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    const a = await account({ cfg: { perpsMaxCollateralUsdg: 5, perpsDriver: "manual" } });
    const view = (await a.lane.refresh()).view!;
    const built = buildOpenDraft({ market: view.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    const out = await a.lane.execute({ ...built.draft } as PerpOrderIntent, { equityUsdg: u(100), equityKnown: true });
    assert.deepEqual(out, { status: "rejected", rejectRule: "perp-collateral-cap" });
    assert.equal(await held(a), null);
    assert.deepEqual(a.inFlight, { ops: 0, spend: 0n });
    assert.ok(a.events.some((e) => e.level === "warn" && /open long BTC-PERP refused — perp-collateral-cap/.test(e.message)));
  });
});
