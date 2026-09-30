/**
 * THE PRODUCERS ON THE REAL VIEW — perp-trend, the strategist's signals and
 * boundary, the protective loop and checkPolicy, each fed by buildPerpsView
 * itself rather than by testkit-perps' hand-built views.
 *
 * Why a second harness: the testkit builds `markets` and the money totals by
 * hand, and two review findings lived exactly in the gap between what it
 * builds and what the view builder produces —
 *
 *   S3-01 / S3-03 / S3-VIEW-HELD-MARKETS  the view carried only the allowed
 *       markets, so a position held in a market the owner un-ticked lost every
 *       strategic exit (perp-trend skipped it, the strategist could not see
 *       it, a close was dropped perp-unpriced), and when no allowed market
 *       read, the whole book went "unread" — equity paused, every spot buy
 *       refused, protect.ts blind — although every held mark was read.
 *   S3-COLLATERAL-SIZING-MISMATCH  the producers sized to free cash PLUS the
 *       collateral room, while checkPerpOpen judges committed + margin ≤ cap:
 *       an owner's cap under what paper cash could fund made perp-trend
 *       propose an open the wall refused on every signal bar.
 *
 * Every open here is judged by the REAL checkPolicy on the state
 * buildPerpPolicyState derives from the same view.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  isolatedMarginMicro,
  leverageTarget,
  perpCollateralAfterOpen,
  perpDepositForMarginMicro,
  perpMarginFitsCap,
  perpOpenMarginBudgetMicro,
  type PerpKey,
} from "../../../packages/core/src/perps";
import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "../policy";
import { proposalsToPerpIntents, type PerpBoundarySettings, type PerpProposal } from "../strategist/proposals";
import { buildPerpSignals } from "../strategist/strategy";
import { parseLighterFeed, specToJson, type FeedFundingJson, type LighterFeedFileMarket, type LighterFeedRead } from "./feed-reader";
import { parseOrderBookDetails } from "./markets";
import { perpTrendTick } from "./perp-trend";
import { PROTECT_THRESHOLDS, emptyProtectMemory, evaluateProtection } from "./protect";
import { depositToFund } from "./route";
import { H4, NOW_SEC, breakout, ctx, u } from "./testkit-perps";
import {
  buildPerpBookTerm,
  buildPerpPolicyState,
  buildPerpsView,
  buildPerpsViewStrict,
  type PerpsViewBuilt,
  type PerpsViewInput,
  type PerpsViewLedger,
  type PerpsViewLedgerRow,
  type PerpsViewSettings,
} from "./view";

const DETAILS = parseOrderBookDetails(JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "orderBookDetails.perp.json"), "utf8")))!;
const BTC = DETAILS.markets.get(1)!.spec;
const NOW_MS = NOW_SEC * 1000;
const CANDLES = breakout("BTC-PERP", 5_000n); // 119 flat bars at 80,000.0, then a close at 80,500.0: a long breakout
const MARK = CANDLES[CANDLES.length - 1]!.c;

/** Eight settled hours at 0.0010 %/h, longs paying — the feed's `fundings1h`, current at NOW. */
function fundings(): FeedFundingJson[] {
  const last = Math.floor((NOW_SEC - 1_800) / 3600) * 3600;
  return Array.from({ length: 8 }, (_, i) => ({ t: last - (7 - i) * 3600, rate: "0.0010", direction: "long" as const }));
}

/** BTC-PERP as the fleet feed carries it: fresh prices, a fresh book, its funding history. */
function btcEntry(mark: bigint = MARK): LighterFeedFileMarket {
  return {
    observedAt: NOW_MS - 1_000,
    priceSource: "ws",
    mark: mark.toString(),
    index: mark.toString(),
    fundingRatePctPerHour: "0.0010",
    lastFundingRatePctPerHour: "0.0010",
    lastFundingAt: (Math.floor((NOW_SEC - 1_800) / 3600) * 3600) * 1000 + 40,
    status: "active",
    spec: specToJson(BTC),
    specObservedAt: NOW_MS - 60_000,
    takerFeePpm: 0,
    makerFeePpm: 0,
    bids: [[(mark - 1n).toString(), "100000"]],
    asks: [[(mark + 1n).toString(), "100000"]],
    bookObservedAt: NOW_MS - 1_000,
    bookSource: "ws",
    fundings1h: fundings(),
    fundingsObservedAt: NOW_MS - 60_000,
  };
}

/** The feed with BTC only — what the lane's feed carries once perps are off and only BTC is held. */
function feedBtcOnly(mark?: bigint): LighterFeedRead {
  const r = parseLighterFeed({ v: 1, observedAt: NOW_MS - 500, markets: { "1": btcEntry(mark) } }, NOW_MS);
  assert.ok(r, "synthetic feed must parse");
  return r;
}

const SETTINGS: PerpsViewSettings & PerpBoundarySettings = {
  perpsEnabled: false,
  perpsDriver: "strategist",
  perpsMarkets: ["ETH-PERP"],
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
  perpsEntriesHalted: false,
};

const IMF = leverageTarget(2, BTC).imfBp;

function row(over: Partial<PerpsViewLedgerRow> & { marketId: number }): PerpsViewLedgerRow {
  return {
    side: null,
    base: 0n,
    entryPrice: null,
    allocatedMarginMicro: 0n,
    imfBp: IMF,
    marginMode: "isolated",
    fundingMicro: null,
    stopTrigger: null,
    stopPrice: null,
    takeTrigger: null,
    takePrice: null,
    openedAt: null,
    ...over,
  };
}

/** A paper BTC long of 0.00030 at 80,000.0, 2x, its stop at 76,000.0 — opened `heldHours` ago. */
function btcLong(heldHours: number): PerpsViewLedgerRow {
  return row({
    marketId: 1,
    side: "long",
    base: 30n,
    entryPrice: 800_000n,
    allocatedMarginMicro: u(12),
    fundingMicro: 0n,
    stopTrigger: 760_000n,
    stopPrice: 744_800n,
    openedAt: NOW_SEC - heldHours * 3600,
  });
}

function ledger(over: Partial<PerpsViewLedger> = {}): PerpsViewLedger {
  return {
    positions: [],
    unresolvedMarkets: new Set(),
    unresolvedOpenMarkets: new Set(),
    closeInFlightMarkets: new Set(),
    pendingOpenNotionalMicro: 0n,
    opensToday: 0,
    lastExit: new Map(),
    lastEntryCandleT: new Map(),
    depositsInTransitMicro: 0n,
    withdrawalsInTransitMicro: 0n,
    paperCashMicro: u(100),
    incident: false,
    entriesHalted: false,
    ...over,
  };
}

function input(over: Partial<PerpsViewInput> = {}, settings: Partial<PerpsViewSettings> = {}): PerpsViewInput {
  return {
    mode: "paper",
    nowSec: NOW_SEC,
    feed: feedBtcOnly(),
    settings: { ...SETTINGS, ...settings },
    grant: { perTradeSealedMicro: u(100), expiresAtSec: NOW_SEC + 30 * 86_400 },
    ledger: ledger(),
    candles4h: new Map([[1, CANDLES]]),
    ...over,
  };
}

const LIMITS: AgentLimits = {
  perTradeUsdg: u(100),
  dailyUsdg: u(1_000),
  allowedTargets: [],
  allowedAssets: [],
  cashToken: "0x00000000000000000000000000000000000000dd",
  maxDrawdownBps: 1_500,
  expiresAt: NOW_SEC + 30 * 86_400,
  maxOpsPerDay: 50,
};

/** The REAL checkPolicy, on the policy state derived from the same input and view (paper rail). */
function judge(intent: TradeIntent, i: PerpsViewInput, v: PerpsViewBuilt | null) {
  const state: AgentState = {
    spentTodayUsdg: 0n,
    opsToday: 0,
    highWaterMarkUsdg: u(100),
    equityUsdg: u(100),
    nowSec: NOW_SEC,
    perp: buildPerpPolicyState(i, v, { mode: "paper" }),
  };
  return checkPolicy(intent, LIMITS, state);
}

// ── S3-01 / S3-03 / S3-VIEW-HELD-MARKETS ────────────────────────────────────

describe("a position held in a market the owner un-ticked keeps its exits (perps off, the feed carries only it)", () => {
  // perpsMarkets = [ETH-PERP], perps OFF, BTC held for 200 h; the lane's feed
  // (lane.ts feedMarketIds) carries only the held BTC — ETH is not in it.
  const i = input({ ledger: ledger({ positions: [btcLong(200)] }) });
  const v = buildPerpsViewStrict(i);

  it("the view is READ — every held mark is — and carries the held market, with opens blocked", () => {
    assert.ok(v, "a book whose every held mark was read is not 'Lighter unread'");
    assert.ok(v.markets.has("BTC-PERP"), "the held market is carried for its exits");
    assert.ok(!v.markets.has("ETH-PERP"));
    assert.equal(v.opensBlocked, "perps-venue-unreachable", "no allowed market read: nothing opens");
    assert.notEqual(buildPerpBookTerm(v), "unread", "equity, the breaker and spot buys are not held hostage to ETH's price");
  });

  it("perp-trend's 168 h exit fires on it, and nothing opens", () => {
    const t = perpTrendTick(v, SETTINGS, ctx());
    assert.deepEqual(
      t.exits.map((x) => `${x.effect} ${x.side} ${x.market}`),
      ["close long BTC-PERP"],
    );
    assert.deepEqual(t.why[0], { code: "perp-exit", market: "BTC-PERP", side: "long", cause: "aged" });
    assert.equal(t.entry, null);
    assert.deepEqual(judge(t.exits[0]!, i, v), { ok: true }, "and the wall lets the exit out");
  });

  it("the strategist sees the position and its market, and its close is built — never dropped perp-unpriced", () => {
    const signals = buildPerpSignals(v!, SETTINGS, u(25), NOW_SEC);
    assert.deepEqual(signals.positions.map((p) => p.key), ["BTC-PERP"]);
    assert.deepEqual(signals.markets.map((m) => m.key), ["BTC-PERP"]);
    const caps = { perTradeSealedMicro: u(100), maxPerActionMicro: u(50), spendHeadroomMicro: u(100) };
    const close: PerpProposal = { market: "BTC-PERP", effect: "close", side: "long", notionalUsdg: 0, reason: "out" };
    const r = proposalsToPerpIntents([close], v, SETTINGS, caps);
    assert.deepEqual(r.dropped, []);
    assert.equal(r.intents.length, 1);
    assert.deepEqual(judge(r.intents[0]!, i, v), { ok: true });
  });

  it("…but no open reaches the un-ticked market: the boundary and the policy both refuse it by name", () => {
    const caps = { perTradeSealedMicro: u(100), maxPerActionMicro: u(50), spendHeadroomMicro: u(100) };
    const on = { ...SETTINGS, perpsEnabled: true };
    const flat = input({ ledger: ledger({ positions: [row({ marketId: 1 })] }) }, { perpsMarkets: ["ETH-PERP"] });
    // Held elsewhere so BTC is carried; an open proposal on it:
    const heldV = buildPerpsViewStrict(i)!;
    const open: PerpProposal = { market: "BTC-PERP", effect: "open", side: "long", notionalUsdg: 20, stopPct: 3, reason: "in" };
    const r = proposalsToPerpIntents([open], heldV, on, caps);
    assert.equal(r.dropped[0]?.why, "perp-market-not-allowed");
    // And the policy, whatever a producer hands it.
    const pv = buildPerpsViewStrict(flat);
    assert.equal(pv, null, "flat, and no allowed market read: unread for opens");
    const intent = {
      kind: "perp-order",
      venue: "lighter",
      market: "BTC-PERP" as PerpKey,
      marketId: 1,
      effect: "open",
      side: "long",
      reduceOnly: false,
      baseAmount: 25n,
      worstPrice: MARK + 400n,
      markPrice: MARK,
      notionalUsdg: u(20.2),
      imfBp: IMF,
      stopTrigger: 780_000n,
      stopPrice: 764_400n,
    } as TradeIntent;
    const verdict = judge(intent, i, heldV);
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.rule, "perp-market-not-allowed");
  });

  it("protect.ts evaluates it — P1 closes on liquidation proximity — where a null view left it only P7 alerts", () => {
    // 0.00030 BTC at 80,000.0 with 12 USDG of margin liquidates near 40,48x.x:
    // a mark at 40,800.0 is inside half the 2% buffer.
    const near = input({ feed: feedBtcOnly(408_000n), ledger: ledger({ positions: [btcLong(200)] }) });
    const nv = buildPerpsViewStrict(near);
    assert.ok(nv);
    const out = evaluateProtection({ view: nv, nowSec: NOW_SEC, settings: SETTINGS, prior: emptyProtectMemory(), feedFresh: true });
    const closes = out.actions.filter((a) => a.kind === "close");
    assert.equal(closes.length, 1, JSON.stringify(out.actions, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    assert.equal(closes[0]!.kind === "close" && closes[0]!.rule, "P1");
    // The unread answer, for contrast: alerts only, and not before two minutes.
    const blind = evaluateProtection({ view: null, nowSec: NOW_SEC, settings: SETTINGS, prior: emptyProtectMemory(), feedFresh: true });
    assert.deepEqual(blind.actions.filter((a) => a.kind === "close"), []);
    assert.ok(PROTECT_THRESHOLDS.unreadAlertSec > 0);
  });

  it("a held market the feed does NOT read fresh still leaves the tick's view unread (the exits lane has its own)", () => {
    const stale = parseLighterFeed({ v: 1, observedAt: NOW_MS - 500, markets: { "1": { ...btcEntry(), observedAt: NOW_MS - 45_000 } } }, NOW_MS)!;
    assert.equal(buildPerpsView(input({ feed: stale, ledger: ledger({ positions: [btcLong(200)] }) })), null);
  });

  it("with the market still allowed, the view and the exit are exactly the same", () => {
    const allowed = input({ ledger: ledger({ positions: [btcLong(200)] }) }, { perpsMarkets: ["BTC-PERP", "ETH-PERP"] });
    const av = buildPerpsViewStrict(allowed)!;
    assert.deepEqual([...av.markets.keys()], ["BTC-PERP"]);
    assert.equal(av.opensBlocked, null, "BTC is allowed and read: opens are possible");
    assert.deepEqual(perpTrendTick(av, SETTINGS, ctx()).exits.map((x) => x.market), ["BTC-PERP"]);
  });
});

// ── S3-COLLATERAL-SIZING-MISMATCH ───────────────────────────────────────────

describe("the producers size to the collateral cap the policy judges", () => {
  // Paper, 2x, flat, paper cash 100, the owner's collateral cap 10.
  const on = { perpsEnabled: true, perpsMarkets: ["BTC-PERP"] as PerpKey[], perpsMaxCollateralUsdg: 10 };
  const i = input({ ledger: ledger({ positions: [row({ marketId: 1 })] }) }, on);
  const v = buildPerpsViewStrict(i)!;

  it("perp-trend's open fits under the cap — and the real checkPolicy admits it", () => {
    assert.ok(v);
    assert.equal(v.headroom.collateralLeftMicro, u(10));
    assert.equal(v.account.freeCollateralMicro, u(100));
    const t = perpTrendTick(v, { ...SETTINGS, ...on }, ctx());
    assert.ok(t.entry, JSON.stringify(t.idle));
    const margin = isolatedMarginMicro(t.entry.notionalUsdg, t.entry.imfBp);
    assert.ok(margin <= u(10), `margin ${margin} must fit the 10 USDG cap`);
    assert.ok(t.entry.notionalUsdg <= u(19) && t.entry.notionalUsdg > u(18), `0.95 × 2 × 10 = 19, got ${t.entry.notionalUsdg}`);
    assert.deepEqual(judge(t.entry, i, v), { ok: true });
  });

  it("the strategist's boundary refuses what the cap refuses, and admits what it admits", () => {
    const caps = { perTradeSealedMicro: u(100), maxPerActionMicro: u(50), spendHeadroomMicro: u(100) };
    const s = { ...SETTINGS, ...on };
    const big: PerpProposal = { market: "BTC-PERP", effect: "open", side: "long", notionalUsdg: 24, stopPct: 3, reason: "in" };
    const r = proposalsToPerpIntents([big], v, s, caps);
    assert.equal(r.dropped[0]?.why, "perp-collateral-cap", "12 of margin under a 10 cap — paper cash does not widen the cap");
    const fits: PerpProposal = { ...big, notionalUsdg: 19 };
    const ok = proposalsToPerpIntents([fits], v, s, caps);
    assert.equal(ok.intents.length, 1, JSON.stringify(ok.dropped));
    assert.deepEqual(judge(ok.intents[0]!, i, v), { ok: true });
  });

  it("paper cash below the room binds too: margin comes from money that is there", () => {
    const poor = input({ ledger: ledger({ positions: [row({ marketId: 1 })], paperCashMicro: u(9) }) }, { ...on, perpsMaxCollateralUsdg: 30 });
    const pv = buildPerpsViewStrict(poor)!;
    assert.equal(perpOpenMarginBudgetMicro({ mode: "paper", freeMicro: pv.account.freeCollateralMicro, roomMicro: pv.headroom.collateralLeftMicro }), u(9));
    const t = perpTrendTick(pv, { ...SETTINGS, ...on }, ctx());
    assert.ok(t.entry, JSON.stringify(t.idle, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    assert.ok(isolatedMarginMicro(t.entry.notionalUsdg, t.entry.imfBp) <= u(9));
  });
});

describe("live: a deposit is never posted for an open the cap will not then admit", () => {
  const cap = u(30);
  it("margin + 10% at 1x with the defaults would strand 27.50 USDG at the venue — refused, and the budget sizes under it", () => {
    // The finding's arithmetic: 25 notional at 1x is 25 of margin; margin +
    // 10% is 27.50; once landed it is committed, and 27.50 + 25 > 30.
    const view = (free: bigint, room: bigint) => ({
      account: { collateralMicro: free, freeCollateralMicro: free, accountValueMicro: free, inTransitMicro: 0n },
      headroom: { perTradeNotionalMicro: u(25), openNotionalLeftMicro: u(50), collateralLeftMicro: room, opensLeftToday: 4 },
    });
    const d = depositToFund({ notionalUsdg: u(25), imfBp: 10_000 }, view(0n, cap), { perTradeSealedMicro: u(50), spendHeadroomMicro: u(100) });
    assert.equal(d.ok, false);
    // What the producers size to instead, and that it goes through end to end:
    const m = perpOpenMarginBudgetMicro({ mode: "live", freeMicro: 0n, roomMicro: cap });
    const deposit = perpDepositForMarginMicro(m, 0n);
    const funded = depositToFund({ notionalUsdg: m, imfBp: 10_000 }, view(0n, cap), { perTradeSealedMicro: u(50), spendHeadroomMicro: u(100) });
    assert.deepEqual(funded, { ok: true, amountMicro: deposit });
    // The deposit lands (committed += deposit); then checkPerpOpen's test holds.
    assert.ok(perpMarginFitsCap(deposit, m, cap), `${deposit} + ${m} ≤ ${cap}`);
    assert.ok(!perpMarginFitsCap(perpDepositForMarginMicro(m + 2n, 0n), m + 2n, cap), "and within a micro of the largest that does (ceil rounding leans to refusing)");
    // Free collateral already there, with its buffer, needs no deposit — and the margin still fits the room.
    const there = perpOpenMarginBudgetMicro({ mode: "live", freeMicro: u(11), roomMicro: u(10) });
    assert.equal(there, u(10));
    assert.equal(perpDepositForMarginMicro(there, u(11)), 0n);
    assert.ok(perpMarginFitsCap(cap - u(10), there, cap));
    // With more room, topping up beats using only what is there — and the top-up is committed too.
    const topped = perpOpenMarginBudgetMicro({ mode: "live", freeMicro: u(11), roomMicro: u(19) });
    assert.ok(topped > u(10));
    assert.ok(perpMarginFitsCap(perpDepositForMarginMicro(topped, u(11)), topped, u(19)));
    // A second open in the same window spends from what the first left.
    const after = perpCollateralAfterOpen({ mode: "live", freeMicro: 0n, roomMicro: cap, marginMicro: m });
    assert.equal(after.roomMicro, cap - deposit);
    assert.equal(after.freeMicro, deposit - m);
  });
});

it("fixture sanity: the synthetic candles close at the mark, on the 4 h grid, current at NOW", () => {
  assert.equal(CANDLES.length, 120);
  assert.equal((NOW_MS - CANDLES[CANDLES.length - 1]!.t) % H4, 3_600_000);
});
