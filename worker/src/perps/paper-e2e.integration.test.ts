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
 * account with perps on in a process with no live venue edges never reaches
 * an executor (the live lane itself: live-e2e.integration.test.ts).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { PERPS_STYLE_CATALOG } from "../../../packages/core/src/perps-styles";
import { parsePerpsReport } from "../../../packages/core/src/perps";
import { tickPlan, tickRatchets } from "../command-wake";
import { composeEquityUsdg, peakBasisUsdg, type PerpBookTerm } from "../equity";
import type { ExecMode } from "../exec-mode";
import type { AgentLimits, PerpOrderIntent, TradeIntent } from "../policy";
import { provenanceOf } from "../provenance";
import { buildOpenDraft } from "./drafts";
import { PERPS_BRAIN_TTL_MS, perpsBrainEstimatedCostBps, type PerpsBrainRequest, type PerpsBrainResponse } from "./brain";
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

function writeFeed(v: { mark: bigint; bids: [bigint, bigint][]; asks: [bigint, bigint][]; candles?: typeof CANDLES; shortCandles?: typeof CANDLES; timeframe?: "5m" | "15m" | "1h" | "4h" }): void {
  const lastHour = Math.floor((clock / 1000 - 1800) / 3600) * 3600;
  const m: LighterFeedFileMarket = {
    observedAt: clock - 1_000,
    priceSource: "ws",
    fundingRatePctPerHour: "0.0010",
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
    closed4h: (v.candles ?? CANDLES).map((c) => ({ t: c.t, o: c.o.toString(), h: c.h.toString(), l: c.l.toString(), c: c.c.toString() })),
    candlesObservedAt: T_LAST + H4 + 60_000,
    ...(v.shortCandles ? { closedByTimeframe: { [v.timeframe ?? "5m"]: { observedAt: clock - 500, rows: v.shortCandles.map(c => ({ t: c.t, o: String(c.o), h: String(c.h), l: String(c.l), c: String(c.c) })) } } } : {}),
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
    liveTradingEnabled: false,
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
  restart: () => Promise<void>;
  events: { level: string; message: string }[];
  inFlight: { ops: number; spend: bigint };
  energy: { claimed: number; refunded: number };
  executorsMade: number;
  /** How often the lane read the Lighter feed file — an inactive lane never does. */
  feedReads: number;
  cfg: PerpLaneConfig;
  exec: ExecMode;
}

async function account(opts: { cfg?: Partial<PerpLaneConfig>; exec?: ExecMode; brain?: PerpLaneDeps["brain"]; onPaperReview?: () => void } = {}): Promise<Account> {
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
    feedReads: 0,
    cfg: config(opts.cfg),
    exec: opts.exec ?? PAPER,
  } as Account;
  const deps: PerpLaneDeps = {
    store,
    brain: opts.brain ? { ...opts.brain,
      news: opts.brain.news ?? ((_market, asOfMs) => ({ status: "no-articles", checked_at_ms: asOfMs, items: [] })) } : undefined,
    armed: () => ({ agentId: id, smartAccount: `0xAb${hex}`, limits }),
    config: () => acct.cfg,
    execMode: () => acct.exec,
    readFeed: (nowMs) => {
      acct.feedReads += 1;
      return readLighterFeed(FEED_FILE, nowMs);
    },
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
      const executor = createPaperPerpExecutor(o);
      return opts.onPaperReview ? { ...executor, review: async intent => {
        const result = await executor.review(intent);
        opts.onPaperReview?.();
        return result;
      } } : executor;
    },
    log: () => {},
  };
  acct.restart = async () => { await acct.lane.stopProtect(); acct.lane = createPerpLane(deps); };
  acct.lane = createPerpLane(deps);
  return acct;
}

/** index.ts ensureDecision's contract: mint an id, write the row with the provenance its Why gives. */
async function decide(agentId: string, intent: TradeIntent, source: string, reason?: string, known?: { whyCode?: string; provenance?: "brain"; evidence?: string }) {
  if (intent.decisionId) return { ok: true as const };
  const id = store.newDecisionId();
  intent.decisionId = id;
  await store.addDecision({
    id,
    agent_id: agentId,
    source,
    ...(reason !== undefined ? { reason } : {}),
    provenance: known?.provenance ?? provenanceOf(source, known?.whyCode),
    evidence_json: known?.evidence,
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
    ensureDecision: (i: TradeIntent, s: string, r?: string, k?: { whyCode?: string; provenance?: "brain"; evidence?: string }) => decide(a.id, i, s, r, k),
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

    // PERPS OFF AND NOTHING HELD: the loop runs anyway — the lane can turn on
    // later with no arm to notice it (S3-02) — and an idle pass is a ledger
    // read: Lighter is never read.
    const off = await account({ cfg: { perpsEnabled: false } });
    await off.lane.armed();
    assert.equal(off.lane.protecting, true, "the loop starts with every arm, whatever the lane holds");
    // Nothing else reads this lane, so a new read is the loop's own pass.
    const armRead = off.lane.last();
    const t1 = Date.now();
    while (off.lane.last() === armRead) {
      if (Date.now() - t1 > 5_000) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.notEqual(off.lane.last(), armRead, "an idle pass ran on the loop's own timer");
    assert.equal(off.feedReads, 0, "and never read Lighter: an inactive lane reads the ledger alone");
    assert.equal(off.lane.last()?.book, undefined, "the known zero of an agent with no perps");
    await off.lane.stopProtect();
  });

  it("arms protection even when the lane is OFF at the arm — a live account holding a practice book, perps off — and fires its stop once execMode moves back to paper (S3-02)", async () => {
    clock += 60_000;
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    const a = await account({ cfg: { perpsDriver: "manual" } });
    const view = (await a.lane.refresh()).view!;
    const built = buildOpenDraft({ market: view.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    const intent = { ...built.draft } as PerpOrderIntent;
    await decide(a.id, intent, "perp-route");
    assert.equal((await a.lane.execute(intent, { equityUsdg: u(100), equityKnown: true })).status, "paper");
    const opened = await held(a);
    assert.ok(opened?.stopTrigger && opened.stopPrice);

    // The account goes live (its owner switched the live rail on, say) and
    // perps are switched off: the practice book is frozen, not traded — and
    // THE ARM HAPPENS NOW, with the lane off.
    a.cfg = { ...a.cfg, perpsEnabled: false };
    a.exec = LIVE;
    await a.lane.armed();
    assert.equal(a.lane.last()?.active, false, "a live account never runs the practice book beside it");
    assert.equal(a.lane.protecting, true, "the loop runs anyway: an arm with the lane off is still an arm");

    // Back to paper (a cash read of 0, the live rail switched off — neither
    // re-arms): the practice book is the book again, and its mark falls
    // through the stop with the book still bidding above the stop's bound.
    clock += 120_000;
    writeFeed({ mark: opened.stopTrigger - 100n, bids: [[opened.stopPrice + 50n, 1_000n]], asks: [[opened.stopTrigger, 1_000n]] });
    a.exec = PAPER;
    const r = await a.lane.refresh(); // the tick's read notices the lane is on again
    assert.equal(r.active, true);
    const t0 = Date.now();
    while ((await held(a)) !== null) {
      if (Date.now() - t0 > 5_000) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.equal(await held(a), null, "the resting paper stop fired on the loop's own clock — no pass was called by hand");
    assert.ok(a.events.some((e) => /BTC-PERP stop fired/.test(e.message)), JSON.stringify(a.events));
    await a.lane.stopProtect();
  });
});

describe("a position held in a market the owner un-ticked, with perps off (S3-01, S3-03, S3-VIEW-HELD-MARKETS)", () => {
  /** Open a 2x BTC long through the lane (the owner's order), then un-tick BTC and switch perps off. */
  async function heldUnticked(cfg: Partial<PerpLaneConfig> = {}) {
    clock += 60_000;
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    const a = await account({ cfg: { perpsDriver: "manual", ...cfg } });
    const view = (await a.lane.refresh()).view!;
    const built = buildOpenDraft({ market: view.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 500, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    const intent = { ...built.draft } as PerpOrderIntent;
    await decide(a.id, intent, "perp-route");
    assert.equal((await a.lane.execute(intent, { equityUsdg: u(100), equityKnown: true })).status, "paper");
    // ETH only, and perps off: the feed the lane asks for now carries BTC
    // (held) and nothing else — ETH is not in it (lane.feedMarketIds).
    a.cfg = { ...a.cfg, perpsMarkets: ["ETH-PERP"], perpsEnabled: false, perpsDriver: "perp-trend" };
    assert.deepEqual(a.lane.feedMarketIds(), [1], "perps off: only what is held is carried");
    return a;
  }

  it("the book stays READ — equity, the breaker and spot buys are not held hostage to a market nothing is held in", async () => {
    const a = await heldUnticked();
    const r = await a.lane.refresh();
    assert.ok(r.view, "every held mark was read: this is not 'Lighter unread'");
    assert.notEqual(r.book, "unread", "so spot buys are not refused perp-unpriced and equity rows keep being written");
    assert.ok(r.view.markets.has("BTC-PERP"), "the held market is carried for its exits");
    assert.equal(r.policy?.markets.has(1), true);
  });

  it("perp-trend's 168 h exit closes it, perps off and all", async () => {
    const a = await heldUnticked();
    clock += 169 * 3_600_000;
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    const e = await equityOf(a);
    assert.notEqual(e.book, "unread");
    await a.lane.runRoute({ ...TICK, equityUsdg: e.equity }, hooks(a, e.equity));
    assert.equal(await held(a), null, "the aged exit went out and filled");
    const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME!, "merrymen.db"));
    try {
      const rows = raw.prepare("SELECT reason FROM decisions WHERE agent_id = ? ORDER BY at, rowid").all(a.id) as { reason: string | null }[];
      assert.ok(rows.some((d) => /168|held/i.test(d.reason ?? "")), JSON.stringify(rows));
    } finally {
      raw.close();
    }
  });

  it("the protective loop still judges it: P1 closes on liquidation proximity when the stop gaps", async () => {
    const a = await heldUnticked({ perpsMaxLeverage: 10 });
    const opened = await held(a);
    assert.ok(opened?.stopPrice);
    const liq = (await a.lane.refresh()).view?.positions.get("BTC-PERP")?.liqPrice;
    assert.ok(typeof liq === "bigint" && liq > 0n);
    clock += 120_000;
    const mark = liq + (liq * 50n) / 10_000n;
    const bid = mark - (mark * 50n) / 10_000n;
    assert.ok(bid < opened.stopPrice, "the venue stop gaps");
    writeFeed({ mark, bids: [[bid, 1_000n]], asks: [[mark, 1_000n]] });
    await pass(a, 1);
    assert.equal(await held(a), null, "closed by the backstop");
    const facts = await store.perpLaneLedgerFacts(a.id, "paper", Math.floor(clock / 1000) - 86_400);
    assert.equal(facts.lastExits.get(1)?.cause, "risk", "a protective (hard risk) exit — P1, not a liquidation");
  });
});

describe("what the paper venue's clock could not run is said, not swallowed (R3-PAPER-FUNDING-GAP)", () => {
  it("an owed funding hour the feed does not carry: the owner is told once, and the report shows that position's funding as unread", async () => {
    clock += 60_000;
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    const a = await account({ cfg: { perpsDriver: "manual" } });
    const view = (await a.lane.refresh()).view!;
    const built = buildOpenDraft({ market: view.markets.get("BTC-PERP")!, side: "long", notionalCapMicro: u(20), stopBps: 500, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
    assert.ok(built.ok);
    const intent = { ...built.draft } as PerpOrderIntent;
    await decide(a.id, intent, "perp-route");
    assert.equal((await a.lane.execute(intent, { equityUsdg: u(100), equityKnown: true })).status, "paper");

    // The worker was away for 30 hours; the feed's hourly history reaches
    // back 8. The first hour the position owes is not in it.
    clock += 30 * 3_600_000;
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    await pass(a, 1);
    const said = () => a.events.filter((e) => /BTC-PERP's funding from .* could not be charged/.test(e.message));
    assert.equal(said().length, 1, JSON.stringify(a.events));
    assert.equal(said()[0]!.level, "warn");
    await a.lane.report();
    const row = new DatabaseSync(path.join(process.env.MERRYMEN_HOME!, "merrymen.db"));
    try {
      const r = parsePerpsReport(JSON.parse((row.prepare("SELECT perps FROM agents WHERE smart_account = ?").get(a.id) as { perps: string }).perps));
      assert.ok(r);
      assert.equal(r.positions[0]?.market, "BTC-PERP");
      assert.equal(r.positions[0]?.fundingMicro, null, "a partial funding total is not a total: unread, never zero");
    } finally {
      row.close();
    }
    const funding = await store.readJournal(a.id, 1).then((rows) => rows.filter((x) => x.kind === "funding").length);
    assert.equal(funding, 0, "and nothing was booked past the hour it could not charge");

    // Once per episode, not once a pass.
    clock += 15_000;
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    await pass(a, 2);
    assert.equal(said().length, 1);
  });
});

describe("a LIVE account with perps on, in a process with no live venue edges", () => {
  it("never reaches an executor: refused by its own reason (not granted), said once per arm — never practice perps beside it", async () => {
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1_000n]], asks: [[802_000n, 1_000n]] });
    // Real perps consented on a live account whose grant carries no perp
    // block: perpsModeOf says perp-not-granted, and with no live edges
    // (lane.ts PerpLiveDeps absent) nothing at Lighter is read or signed.
    const a = await account({ exec: LIVE, cfg: { liveTradingEnabled: true, perpsLiveEnabled: true } });
    const r = await a.lane.refresh();
    assert.deepEqual(r.rail, { mode: "refuse", rule: "perp-not-granted" });
    assert.equal(r.book, undefined, "no venue account is read: the known zero");
    assert.equal(r.view, undefined);
    assert.equal(r.report.mode, "refuse");
    assert.equal(r.report.blocker, "perps-not-granted");

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
    assert.deepEqual(out, { status: "rejected", rejectRule: "perp-not-granted" });
    const close: PerpOrderIntent = { kind: "perp-order", venue: "lighter", market: "BTC-PERP", marketId: 1, effect: "close", side: "long", reduceOnly: true, baseAmount: 20n, worstPrice: 790_000n, markPrice: 802_000n, notionalUsdg: 0n };
    const outClose = await a.lane.execute(close, { equityUsdg: u(100), equityKnown: true });
    assert.equal(outClose.status, "rejected");
    await a.lane.runRoute({ ...TICK, equityUsdg: u(100) }, hooks(a, u(100)));
    await pass(a, 1);
    assert.equal(a.executorsMade, 0, "no paper executor is ever built for a live account (rule 14)");
    assert.equal((await store.getPerpPositions(a.id, "live", { includeFlat: true })).length, 0);
    assert.equal((await store.getPerpPositions(a.id, "paper", { includeFlat: true })).length, 0, "and never a practice book beside it");

    const said = () => a.events.filter((e) => /^perpetuals are switched on, but nothing new is opened: the permission you signed does not include perpetuals/.test(e.message));
    assert.equal(said().length, 1, "the rail is said once");
    assert.ok(a.events.some((e) => /refused — perp-not-granted/.test(e.message)), "the refusal is the owner's to see");
    await a.lane.armed();
    assert.equal(said().length, 2, "and said again after a new arm");
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


function approvedBrain(r: PerpsBrainRequest): PerpsBrainResponse {
  return { schema_version: r.schema_version, run_id: r.run_id, agent_id: r.agent_id, snapshot_id: r.snapshot_id,
    market: r.market, as_of_ms: r.as_of_ms, expires_at_ms: r.expires_at_ms, strategy_version: "merrymenbrain-perps-analogs-v1",
    candidate_bar_t: r.candidate.bar_t, candidate_side: r.candidate.side, action: r.candidate.side, reason_codes: ["evidence-qualified"], features: {},
    forecast: { method: "causal-regime-analogs-v1", horizon_bars: 3, target: "signed-mark-return-after-estimated-costs", samples: 40,
      win_probability: .7, lower_95: 0.5456998118185507, upper_95: 0.8192515477025347, mean_net_bps: 60, mean_lower_95_bps: 10, cost_bps: perpsBrainEstimatedCostBps(r), calibrated: false },
    committee: ["bull", "bear", "risk"].map(lens => ({ lens, verdict: "accept", reason: "fixture evidence only" })) };
}
const flushBrain = () => new Promise<void>(resolve => setImmediate(resolve));

describe("MerrymenBrain route through the real paper lane and ledger", () => {
  it("waits without a model call or new trade when the paid news desk is stale or failed", async () => {
    for (const status of ["not-fetched", "fetch-failed", "stale"] as const) {
      clock = T_LAST + H4 + 3_600_000;
      writeFeed({ mark: 802_000n, bids: [[802_000n, 1000n]], asks: [[802_010n, 1000n]], candles: breakout("BTC-PERP", 2_000n, 200n, 220) });
      let reviews = 0;
      const a = await account({ cfg: { perpsDriver: "brain" }, brain: { configured: () => true,
        configKey: () => "test", admit: async () => true,
        news: () => ({ status, checked_at_ms: 0, items: [] }),
        review: async request => { reviews++; return approvedBrain(request); } } });
      const start = await equityOf(a);
      await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, hooks(a, start.equity));
      await flushBrain();
      assert.equal(reviews, 0, status);
      assert.equal(await held(a), null, status);
      assert.equal(a.energy.claimed, 0, status);
      await a.lane.stopProtect();
    }
  });
  it("protects while research is pending, then journals and executes one unchanged capped candidate", async () => {
    clock = T_LAST + H4 + 3_600_000;
    writeFeed({ mark: 802_000n, bids: [[802_000n, 1000n]], asks: [[802_010n, 1000n]], candles: breakout("BTC-PERP", 2_000n, 200n, 220) });
    let finish!: () => void; let reviews = 0;
    const a = await account({ cfg: { perpsDriver: "brain" }, brain: { configured: () => true, configKey: () => "test", admit: async () => true,
      review: request => { reviews++; return new Promise(resolve => { finish = () => resolve(approvedBrain(request)); }); },
      record: async recording => {
        await store.addDecision({ id: recording.request.run_id, agent_id: recording.request.agent_id, source: "perp:brain", provenance: "brain",
          action: "open-long", evidence_json: JSON.stringify(recording) });
      } } });
    const start = await equityOf(a);
    await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, hooks(a, start.equity));
    await flushBrain(); assert.equal(reviews, 1); assert.equal(await held(a), null);
    await pass(a); // This must resolve while the model promise is still unsettled.
    finish(); await flushBrain();
    await equityOf(a);
    await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, hooks(a, start.equity));
    assert.ok(await held(a));
    const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME!, "merrymen.db"));
    try {
      const decision = raw.prepare("SELECT source, provenance, evidence_json FROM decisions WHERE agent_id = ? AND source = 'perp:brain'").get(a.id) as { source: string; provenance: string; evidence_json: string };
      assert.equal(decision.source, "perp:brain"); assert.equal(decision.provenance, "brain");
      const evidence = JSON.parse(decision.evidence_json);
      assert.equal(evidence.request.snapshot_id, evidence.response.snapshot_id);
      assert.equal(evidence.sourceFrame.atMs, evidence.request.as_of_ms);
      assert.equal(evidence.sourceFrame.feed.markets["1"].mark, "802000");
      const count = raw.prepare("SELECT COUNT(*) AS n FROM decisions WHERE agent_id = ?").get(a.id) as { n: number };
      assert.equal(count.n, 1, "execution reuses the durable review identity");
    } finally { raw.close(); }
    assert.equal(a.energy.claimed, 1);
    await equityOf(a);
    await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, hooks(a, start.equity));
    assert.equal(a.energy.claimed, 1, "one-use approval cannot generate another entry");
  });
  it("expires after a queued process call and never reaches the paper settlement", async () => {
    clock = T_LAST + H4 + 3_600_000;
    writeFeed({ mark: 802_000n, bids: [[802_000n, 1000n]], asks: [[802_010n, 1000n]], candles: breakout("BTC-PERP", 2_000n, 200n, 220) });
    const a = await account({ cfg: { perpsDriver: "brain" }, brain: { configured: () => true, configKey: () => "test", admit: async () => true,
      review: async request => approvedBrain(request) } });
    const start = await equityOf(a), h = hooks(a, start.equity);
    await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, h); await flushBrain(); await equityOf(a);
    let refusal: string | undefined;
    await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, { ...h, processIntentReporting: async i => {
      clock += PERPS_BRAIN_TTL_MS;
      const result = await h.processIntentReporting(i); refusal = result.rejectRule; return result;
    } });
    assert.equal(refusal, "perp-brain-expired"); assert.equal(await held(a), null); assert.equal(a.energy.refunded, 1);
  });
  it("refuses a Brain open when news changes after venue review but before paper booking", async () => {
    clock = T_LAST + H4 + 3_600_000;
    writeFeed({ mark: 802_000n, bids: [[802_000n, 1000n]], asks: [[802_010n, 1000n]], candles: breakout("BTC-PERP", 2_000n, 200n, 220) });
    let changed = false;
    const a = await account({ cfg: { perpsDriver: "brain" }, onPaperReview: () => { changed = true; }, brain: {
      configured: () => true, configKey: () => "test", admit: async () => true,
      news: (_market, asOfMs) => changed
        ? { status: "ok", checked_at_ms: asOfMs, items: [{ id: "late-btc", source: "wire", published_at_ms: asOfMs - 60_000,
          headline: "Material BTC story after review", summary: null, relevance: 1, sentiment: -0.8 }] }
        : { status: "no-articles", checked_at_ms: asOfMs, items: [] },
      review: async request => approvedBrain(request),
    } });
    const start = await equityOf(a), h = hooks(a, start.equity);
    await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, h);
    await flushBrain();
    assert.equal(changed, false, "research remained the same through Brain approval");
    await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, h);
    assert.equal(changed, true, "the paper venue changed news after its review");
    assert.equal(await held(a), null, "the final news guard prevents booking");
    assert.equal(a.energy.refunded, 1);
    assert.deepEqual(a.inFlight, { ops: 0, spend: 0n });
  });
  it("a saved settings change discards an outstanding approval", async () => {
    clock = T_LAST + H4 + 3_600_000;
    writeFeed({ mark: 802_000n, bids: [[802_000n, 1000n]], asks: [[802_010n, 1000n]], candles: breakout("BTC-PERP", 2_000n, 200n, 220) });
    const a = await account({ cfg: { perpsDriver: "brain" }, brain: { configured: () => true, configKey: () => "test", admit: async () => true,
      review: async request => approvedBrain(request) } });
    const start = await equityOf(a), h = hooks(a, start.equity);
    await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, h); await flushBrain();
    a.cfg.perpsPerTradeUsdg = 20; await a.lane.configChanged(); await equityOf(a);
    await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, h);
    assert.equal(await held(a), null); assert.equal(a.energy.claimed, 0);
    await a.lane.stopProtect();
  });
});


it("scalp entry profile survives process-memory reset and manual switch; protective time exit settles once", async () => {
  const last = Math.floor((clock - 1000) / 300_000) * 300_000 - 300_000;
  const shortCandles = CANDLES.map((c, i) => ({ ...c, t: last - (CANDLES.length - 1 - i) * 300_000 }));
  writeFeed({ mark: 802_000n, bids: [[801_900n, 1000n]], asks: [[802_000n, 1000n]], shortCandles });
  const a = await account({ cfg: { perpsStyle: "scalp-breakout" } });
  const start = await equityOf(a);
  await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, hooks(a, start.equity));
  assert.ok(await held(a));
  const facts = await store.perpLaneLedgerFacts(a.id, "paper", Math.floor(clock / 1000) - 86400);
  assert.equal(facts.lastEntrySignals.get(1)?.candleT, last, "exact signal candle survives feed publication lag and restart");
  assert.equal(facts.positionStyles.get(1), "scalp-breakout", "profile recovered from durable opening fill, order and decision");
  assert.equal((await store.perpLaneLedgerFacts(a.id, "live", 0)).positionStyles.size, 0, "paper profile cannot leak into live book");
  const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME!, "merrymen.db"));
  try {
    raw.prepare("UPDATE decisions SET source = 'owner-command' WHERE agent_id = ?").run(a.id);
    assert.equal((await store.perpLaneLedgerFacts(a.id, "paper", 0)).positionStyles.size, 0, "manual evidence cannot impersonate a trend entry profile");
    raw.prepare("UPDATE decisions SET source = 'perp-route' WHERE agent_id = ?").run(a.id);
    raw.prepare("UPDATE perp_positions SET opened_at = NULL WHERE agent_id = ? AND mode = 'paper'").run(a.id.toLowerCase());
    const crash = await store.perpLaneLedgerFacts(a.id, "paper", 0);
    assert.equal(crash.positionStyles.get(1), "scalp-breakout", "crash before opened_at cache cannot lose profile");
    assert.equal(crash.positionStyleOpenedAt.get(1), Math.floor(clock / 1000), "fill supplies durable opening time");
  } finally { raw.close(); }
  a.cfg = { ...a.cfg, perpsDriver: "manual", perpsStyle: "swing-trend" };
  await a.lane.resetPaper(async () => {});
  clock += 1800_000;
  writeFeed({ mark: 802_000n, bids: [[801_900n, 1000n]], asks: [[802_000n, 1000n]] });
  await pass(a);
  assert.equal(await held(a), null, "manual and new style cannot extend original scalp holding deadline");
  const fills = await journalKinds(a, "perp-fill");
  await pass(a, 2);
  assert.equal(await journalKinds(a, "perp-fill"), fills, "timed close cannot replay");
});


describe("all nine profiles through the measured paper trading loop", () => {
  for (const profile of PERPS_STYLE_CATALOG) it(`${profile.id}: candle → sized order → durable profile/report → timed close`, async () => {
    clock = T_LAST + H4 + 3_600_000;
    const last = Math.floor((clock - 1000) / profile.candleMs) * profile.candleMs - profile.candleMs;
    const bars = CANDLES.map((c, i) => ({ ...c, t: last - (CANDLES.length - 1 - i) * profile.candleMs }));
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1000n]], asks: [[802_000n, 1000n]],
      ...(profile.timeframe === "4h" ? { candles: bars } : { shortCandles: bars, timeframe: profile.timeframe }) });
    const a = await account({ cfg: { perpsStyle: profile.id } });
    const start = await equityOf(a);
    await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, hooks(a, start.equity));
    const position = await held(a);
    assert.ok(position, `${profile.id} must execute a measured breakout`);
    assert.ok(position.allocatedMarginMicro <= u(30));
    // Reports are updated by the protective pass, on its own clock.
    await pass(a);
    const db = new DatabaseSync(path.join(process.env.MERRYMEN_HOME!, "merrymen.db"));
    const saved = db.prepare("SELECT perps FROM agents WHERE smart_account = ?").get(a.id) as { perps: string };
    db.close();
    const status = parsePerpsReport(JSON.parse(saved.perps));
    assert.ok(status);
    assert.equal(status.automation?.style, profile.id);
    assert.equal(status.automation?.state, "candidate");
    assert.equal(status.automation?.evaluatedAt, Math.floor(clock / 1000));
    assert.match(status.automation!.reason, /not a fill/);
    assert.equal(status.positions[0]?.entryStyle, profile.id);
    assert.equal(status.positions[0]?.holdDeadlineSec, Math.floor(clock / 1000) + profile.maxHoldHours * 3600);
    const facts = await store.perpLaneLedgerFacts(a.id, "paper", Math.floor(clock / 1000) - 86400);
    assert.equal(facts.positionStyles.get(1), profile.id);
    assert.equal(facts.lastEntrySignals.get(1)?.candleT, last);
    a.cfg = { ...a.cfg, perpsDriver: "manual" };
    await a.lane.configChanged();
    assert.equal((await a.lane.ownerReport())?.automation, undefined);
    await a.restart();
    clock += profile.maxHoldHours * 3600_000;
    writeFeed({ mark: 802_000n, bids: [[801_900n, 1000n]], asks: [[802_000n, 1000n]] });
    await pass(a, 2);
    assert.equal(await held(a), null);
    const count = await journalKinds(a, "perp-fill");
    await pass(a, 3);
    assert.equal(await journalKinds(a, "perp-fill"), count, "settlement must not replay");
  });
});

it("a profile/driver change while a deterministic entry waits prevents paper settlement", async () => {
  clock = T_LAST + H4 + 3_600_000;
  writeFeed({ mark: 802_000n, bids: [[801_900n, 1000n]], asks: [[802_000n, 1000n]] });
  let a: Account;
  a = await account({ onPaperReview: () => { a.cfg = { ...a.cfg, perpsDriver: "manual" }; } });
  const start = await equityOf(a);
  await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, hooks(a, start.equity));
  assert.equal(await held(a), null);
  assert.equal(await journalKinds(a, "perp-fill"), 0);
  assert.equal(a.energy.refunded, 1);
  assert.ok(a.events.some(e => /perp-style-changed/.test(e.message)));
});


it("a deterministic signal that expires during executor review cannot be booked", async () => {
  clock = T_LAST + H4 + 3_600_000;
  writeFeed({ mark: 802_000n, bids: [[801_900n, 1000n]], asks: [[802_000n, 1000n]] });
  const a = await account({ onPaperReview: () => { clock += 5 * 3600_000; } });
  const start = await equityOf(a);
  await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, hooks(a, start.equity));
  assert.equal(await held(a), null);
  assert.equal(await journalKinds(a, "perp-fill"), 0);
  assert.equal(a.energy.refunded, 1);
  assert.ok(a.events.some(e => /perp-signal-expired/.test(e.message)));
});

it("automation reports distinguish manual, waiting and unreported after restart", async () => {
  clock = T_LAST + H4 + 3_600_000;
  writeFeed({ mark: 802_000n, bids: [[801_900n, 1000n]], asks: [[802_000n, 1000n]] });
  const a = await account({ cfg: { perpsDriver: "manual" } });
  const start = await equityOf(a);
  await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, hooks(a, start.equity));
  const manual = (await a.lane.ownerReport())?.automation;
  assert.equal(manual?.state, "manual");
  assert.equal(manual?.driver, "manual");
  assert.equal(await held(a), null);
  a.cfg = { ...a.cfg, perpsDriver: "perp-trend", perpsPerTradeUsdg: 10 };
  await a.lane.configChanged();
  assert.equal((await a.lane.ownerReport())?.automation, undefined);
  await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, hooks(a, start.equity));
  const waiting = (await a.lane.ownerReport())?.automation;
  assert.equal(waiting?.state, "waiting");
  assert.equal(waiting?.driver, "perp-trend");
  assert.ok(waiting?.reason);
  assert.equal(await held(a), null);
  await a.restart();
  await pass(a);
  assert.equal((await a.lane.ownerReport())?.automation, undefined, "a restarted worker never invents a completed strategy review");
});

it("publishing an old tick's automation result cannot restore a position already closed by protection", async () => {
  clock = T_LAST + H4 + 3_600_000;
  writeFeed({ mark: 802_000n, bids: [[801_900n, 1000n]], asks: [[802_000n, 1000n]] });
  const a = await account();
  const start = await equityOf(a);
  await a.lane.runRoute({ ...TICK, equityUsdg: start.equity }, hooks(a, start.equity));
  const position = await held(a);
  assert.ok(position?.stopTrigger);
  a.cfg = { ...a.cfg, perpsDriver: "manual" };
  await a.lane.configChanged();
  const olderTick = await equityOf(a); // route retains this position-bearing view
  assert.equal(a.lane.snapshotView()?.positions.size, 1);
  clock += 20_000;
  writeFeed({ mark: position.stopTrigger, bids: [[position.stopTrigger, 1000n]], asks: [[position.stopTrigger + 1n, 1000n]] });
  await pass(a);
  assert.equal(await held(a), null);
  const saved = () => {
    const db = new DatabaseSync(path.join(process.env.MERRYMEN_HOME!, "merrymen.db"));
    try {
      const row = db.prepare("SELECT perps FROM agents WHERE smart_account = ?").get(a.id) as { perps: string };
      return parsePerpsReport(JSON.parse(row.perps))!;
    } finally { db.close(); }
  };
  const closed = saved();
  assert.equal(closed.positions.length, 0);
  await a.lane.runRoute({ ...TICK, equityUsdg: olderTick.equity }, hooks(a, olderTick.equity));
  const report = saved();
  assert.equal(report.automation?.state, "manual");
  assert.equal(report.positions.length, 0, "automation must merge into a current book, not its older decision snapshot");
  assert.equal(report.openNotionalMicro, closed.openNotionalMicro);
  assert.equal(report.collateralMicro, closed.collateralMicro);
  assert.equal(report.protectAt, closed.protectAt);
});
