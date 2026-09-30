/**
 * THE PERPS VIEW — one read, every number. These tests hold the builder to the
 * contract's reading rules (rule 11: unknown is never zero; rule 12: C, M and U
 * from one account read; rule 14: the paper book is the ledger, marked at the
 * feed) and prove the derived shapes — policy state, equity term, report —
 * carry the SAME figures the view shows. Specs come from the live
 * orderBookDetails capture and the live account 22149, through the same
 * parsers the worker uses; the feed is synthetic, built through the reader.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  baseForNotional,
  isolatedLiqPrice,
  leverageTarget,
  notionalMicro,
  parsePerpsReport,
  stopPrices,
  unrealizedPnlMicro,
  worstPriceForTaker,
  type PerpKey,
} from "../../../packages/core/src/index";
import { checkPolicy, type AgentLimits, type PerpOpenIntent } from "../policy";
import { parseLighterFeed, specToJson, type LighterFeedFileMarket, type LighterFeedRead } from "./feed-reader";
import { parseAccount, parseOrderBookDetails, type PerpAccountRead, type VenueOrder } from "./markets";
import {
  PERP_BLOCKER_PRIORITY,
  buildPerpBookTerm,
  buildPerpPolicyState,
  buildPerpsReport,
  buildPerpsView,
  buildPerpsViewStrict,
  perpsPctToBps,
  perpsUsdgToMicro,
  renderScaled,
  type PerpsViewBuilt,
  type PerpsViewInput,
  type PerpsViewLedger,
  type PerpsViewLedgerRow,
  type PerpsViewSettings,
} from "./view";

const FIX = path.join(import.meta.dirname, "fixtures");
const load = (f: string): unknown => JSON.parse(readFileSync(path.join(FIX, f), "utf8"));
const DETAILS = parseOrderBookDetails(load("orderBookDetails.perp.json"))!;
const view = (id: number) => DETAILS.markets.get(id)!;
const BTC = view(1).spec; // sd 5, pd 1, min IMF 200, MMF 120
const NVDA = view(15).spec; // sd 4, pd 2, min IMF 500
const QQQ = view(25).spec;

/** 9 s after account 22149's snapshot (transaction_time 1790694641487929 µs). */
const NOW_MS = 1_790_694_650_000;
const NOW = NOW_MS / 1000;
const u = (usdg: number) => BigInt(Math.round(usdg * 1e6));

function feedMarket(id: number, over: Partial<LighterFeedFileMarket> = {}): LighterFeedFileMarket {
  const v = view(id);
  const mark = BigInt(over.mark ?? v.markPrice.toString());
  return {
    observedAt: NOW_MS - 1_000,
    priceSource: "ws",
    mark: mark.toString(),
    index: v.indexPrice.toString(),
    fundingRatePctPerHour: "0.0012",
    lastFundingRatePctPerHour: "0.0010",
    lastFundingAt: NOW_MS - 1_800_000,
    status: v.spec.status,
    spec: specToJson(v.spec),
    specObservedAt: NOW_MS - 60_000,
    takerFeePpm: 0,
    makerFeePpm: 0,
    bids: [
      [(mark - 1n).toString(), "100"],
      [(mark - 2n).toString(), "100"],
    ],
    asks: [
      [(mark + 1n).toString(), "100"],
      [(mark + 2n).toString(), "100"],
    ],
    bookObservedAt: NOW_MS - 1_000,
    bookSource: "ws",
    ...over,
  };
}

function feed(markets: Record<string, LighterFeedFileMarket>): LighterFeedRead {
  const r = parseLighterFeed({ v: 1, observedAt: NOW_MS - 500, markets }, NOW_MS);
  assert.ok(r, "synthetic feed must parse");
  return r;
}

const FEED = () => feed({ "0": feedMarket(0), "1": feedMarket(1), "15": feedMarket(15), "25": feedMarket(25) });

const SETTINGS: PerpsViewSettings = {
  perpsMarkets: ["BTC-PERP", "ETH-PERP"],
  perpsMaxLeverage: 2,
  perpsPerTradeUsdg: 25,
  perpsMaxOpenNotionalUsdg: 50,
  perpsMaxCollateralUsdg: 30,
  perpsMaxOpensPerDay: 4,
  perpsStopLossPct: 5,
  perpsStopSlipBps: 200,
  perpsLiqBufferPct: 2,
  perpsMaxSlippageBps: 50,
  perpsEntriesHalted: false,
};

function row(over: Partial<PerpsViewLedgerRow> & { marketId: number }): PerpsViewLedgerRow {
  return {
    side: null,
    base: 0n,
    entryPrice: null,
    allocatedMarginMicro: 0n,
    imfBp: 5000,
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
    incident: false,
    entriesHalted: false,
    ...over,
  };
}

function input(over: Partial<PerpsViewInput> = {}): PerpsViewInput {
  return {
    mode: "paper",
    nowSec: NOW,
    feed: FEED(),
    settings: SETTINGS,
    grant: { perTradeSealedMicro: u(25), expiresAtSec: NOW + 30 * 86_400 },
    ledger: ledger(),
    ...over,
  };
}

// A paper BTC long: 0.00030 BTC at 83,000.0, 2x, with its stop on the row.
const ENTRY = 830_000n;
const BASE = 30n;
const PAPER_STOP = stopPrices({ side: "long", entryRefPrice: ENTRY, stopLossBps: 500, stopSlipBps: 200 });
const PAPER_MARGIN = notionalMicro(BASE, ENTRY, BTC, "ceil") / 2n;
const paperBtc = (over: Partial<PerpsViewLedgerRow> = {}) =>
  row({
    marketId: 1,
    side: "long",
    base: BASE,
    entryPrice: ENTRY,
    allocatedMarginMicro: PAPER_MARGIN,
    fundingMicro: -1_234n,
    stopTrigger: PAPER_STOP.trigger,
    stopPrice: PAPER_STOP.price,
    openedAt: NOW - 3_600,
    ...over,
  });

function mustView(i: PerpsViewInput): PerpsViewBuilt {
  const v = buildPerpsViewStrict(i);
  assert.ok(v, "expected a read view");
  return v;
}

// ── units ───────────────────────────────────────────────────────────────────

describe("settings units", () => {
  it("USDG and percent convert exactly on their 0.01 grid", () => {
    assert.equal(perpsUsdgToMicro(25), 25_000_000n);
    assert.equal(perpsUsdgToMicro(12.34), 12_340_000n);
    assert.equal(perpsUsdgToMicro(0.07), 70_000n); // 0.07 * 100 is 7.000000000000001 in floats
    assert.equal(perpsPctToBps(5), 500);
    assert.equal(perpsPctToBps(1.15), 115);
    assert.throws(() => perpsUsdgToMicro(Number.NaN));
    assert.throws(() => perpsPctToBps(-1));
  });
  it("renders venue integers at their precision", () => {
    assert.equal(renderScaled(20n, 5), "0.00020");
    assert.equal(renderScaled(832_186n, 1), "83218.6");
    assert.equal(renderScaled(7n, 0), "7");
    assert.equal(renderScaled(-5n, 2), "-0.05");
  });
});

// ── unread is null, never an empty book ─────────────────────────────────────

describe("when the view is null (on, but unread)", () => {
  it("no feed", () => assert.equal(buildPerpsView(input({ feed: null })), null));
  it("live with no venue account read", () => {
    assert.equal(buildPerpsView(input({ mode: "live" })), null);
    assert.equal(buildPerpsView(input({ mode: "live", venue: null })), null);
  });
  it("every allowed market stale or missing", () => {
    const stale = feed({ "0": feedMarket(0, { observedAt: NOW_MS - 31_000 }), "1": feedMarket(1, { observedAt: NOW_MS - 31_000 }) });
    assert.equal(buildPerpsView(input({ feed: stale })), null);
    assert.equal(buildPerpsView(input({ feed: feed({ "15": feedMarket(15) }) })), null);
  });
  it("a held paper position whose market the feed does not carry at all", () => {
    const f = feed({ "0": feedMarket(0) });
    assert.equal(buildPerpsView(input({ feed: f, ledger: ledger({ positions: [paperBtc()] }) })), null);
  });
  it("but an owner who allows no market still gets a view (positions may remain)", () => {
    const v = buildPerpsView(input({ settings: { ...SETTINGS, perpsMarkets: [] } }));
    assert.ok(v);
    assert.equal(v.markets.size, 0);
  });
  it("buildPerpsView never throws; a malformed book is unread", () => {
    const bad = ledger({ positions: [paperBtc({ entryPrice: null })] });
    assert.throws(() => buildPerpsViewStrict(input({ ledger: bad })));
    assert.equal(buildPerpsView(input({ ledger: bad })), null);
  });
});

// ── paper ───────────────────────────────────────────────────────────────────

describe("paper: the ledger is the book, marked at the feed", () => {
  const ethFlat = row({ marketId: 0, imfBp: 5000, marginMode: "isolated" });
  const v = mustView(
    input({
      ledger: ledger({ positions: [paperBtc(), ethFlat], paperCashMicro: u(70), opensToday: 1, pendingOpenNotionalMicro: u(3) }),
    }),
  );
  const mark = view(1).markPrice;

  it("markets: allowed ∩ fresh, with leverage from the setting and the market's own minimum", () => {
    assert.deepEqual([...v.markets.keys()].sort(), ["BTC-PERP", "ETH-PERP"]);
    const btc = v.markets.get("BTC-PERP")!;
    const target = leverageTarget(2, BTC);
    assert.equal(btc.leverage, target.leverage);
    assert.equal(btc.imfBp, target.imfBp);
    assert.equal(btc.venueImfBp, 5000);
    assert.equal(btc.venueMarginMode, "isolated");
    assert.equal(btc.markPrice, mark);
    assert.equal(btc.fundingPpmPerHour, 12);
    assert.deepEqual(btc.lastFunding, { ppmPerHour: 10, atSec: Math.floor((NOW_MS - 1_800_000) / 1000) });
    assert.equal(btc.bestBid, mark - 1n);
    assert.equal(btc.bestAsk, mark + 1n);
    assert.equal(btc.closed4h, null, "candles not read are null, not empty");
  });

  it("the position: marked with core's integer math, liquidation estimated, stop resting on the row", () => {
    const p = v.positions.get("BTC-PERP")!;
    assert.equal(p.side, "long");
    assert.equal(p.markPrice, mark);
    assert.equal(p.unrealizedMicro, unrealizedPnlMicro({ side: "long", baseAmount: BASE, entryPrice: ENTRY, markPrice: mark, spec: BTC }));
    assert.equal(p.notionalMicro, notionalMicro(BASE, mark, BTC, "ceil"));
    assert.equal(
      p.liqPrice,
      isolatedLiqPrice({ side: "long", entryPrice: ENTRY, baseAmount: BASE, allocatedMarginMicro: PAPER_MARGIN, mmfBp: BTC.mmfBp, spec: BTC }),
    );
    assert.deepEqual(p.stop, { trigger: PAPER_STOP.trigger, price: PAPER_STOP.price, expiresAtSec: null, resting: true });
    assert.equal(p.fundingMicro, -1_234n);
    assert.equal(p.openedAtSec, NOW - 3_600);
    const f = v.facts.positions.get("BTC-PERP")!;
    assert.equal(f.stopState, "resting");
    assert.equal(f.markFresh, true);
    assert.equal(f.markSource, "feed");
  });

  it("the account and the book term: C is the paper collateral (0 here), margin left paper cash as ΣM", () => {
    const p = v.positions.get("BTC-PERP")!;
    assert.equal(v.account.collateralMicro, 0n);
    assert.equal(v.account.freeCollateralMicro, u(70));
    assert.equal(v.account.accountValueMicro, PAPER_MARGIN + p.unrealizedMicro);
    const book = buildPerpBookTerm(v);
    assert.notEqual(book, "unread");
    assert.deepEqual(book, {
      collateralMicro: 0n,
      isolatedMarginMicro: PAPER_MARGIN,
      unrealizedMicro: p.unrealizedMicro,
      unrealizedGainMicro: p.unrealizedMicro > 0n ? p.unrealizedMicro : 0n,
      inTransitMicro: 0n,
      snapshotTime: null,
    });
  });

  it("headroom is the caps less what is used — pending opens count as exposure", () => {
    const p = v.positions.get("BTC-PERP")!;
    assert.equal(v.facts.openNotionalMicro, p.notionalMicro + u(3));
    assert.equal(v.headroom.perTradeNotionalMicro, u(25));
    assert.equal(v.headroom.openNotionalLeftMicro, u(50) - p.notionalMicro - u(3));
    assert.equal(v.headroom.collateralLeftMicro, u(30) - PAPER_MARGIN);
    assert.equal(v.headroom.opensLeftToday, 3);
    assert.equal(v.opensBlocked, null);
  });

  it("a stale market leaves the markets map; its position stays, unfresh, and the book is unread", () => {
    const f = feed({ "0": feedMarket(0), "1": feedMarket(1, { observedAt: NOW_MS - 45_000 }) });
    const s = mustView(input({ feed: f, ledger: ledger({ positions: [paperBtc()] }) }));
    assert.deepEqual([...s.markets.keys()], ["ETH-PERP"]);
    assert.ok(s.positions.has("BTC-PERP"));
    assert.equal(s.facts.positions.get("BTC-PERP")!.markFresh, false);
    assert.equal(buildPerpBookTerm(s), "unread");
  });

  it("a paper stop's expiry comes from the ledger when it keeps one", () => {
    const s = mustView(input({ ledger: ledger({ positions: [paperBtc()], stopExpiresAtSec: new Map([[1, NOW + 86_400]]) }) }));
    assert.equal(s.positions.get("BTC-PERP")!.stop!.expiresAtSec, NOW + 86_400);
  });

  it("no stop on the row is a MISSING stop", () => {
    const s = mustView(input({ ledger: ledger({ positions: [paperBtc({ stopTrigger: null, stopPrice: null })] }) }));
    assert.equal(s.positions.get("BTC-PERP")!.stop, null);
    assert.equal(s.facts.positions.get("BTC-PERP")!.stopState, "missing");
  });
});

// ── live ────────────────────────────────────────────────────────────────────

const ACCT: PerpAccountRead = parseAccount(load("account.22149.isolated.json"), DETAILS.decimals)!;
assert.ok(ACCT);
const LIVE_SETTINGS: PerpsViewSettings = { ...SETTINGS, perpsMarkets: ["NVDA-PERP", "QQQ-PERP"], perpsMaxLeverage: 10 };

function order(over: Partial<VenueOrder>): VenueOrder {
  return {
    orderIndex: "100",
    clientOrderIndex: "0",
    marketId: 15,
    ownerAccountIndex: 22149,
    isAsk: true,
    type: "stop-loss",
    timeInForce: "immediate-or-cancel",
    reduceOnly: true,
    status: "pending",
    triggerStatus: "mark-price",
    price: 21_500n,
    triggerPrice: 22_000n,
    initialBaseAmount: 0n,
    remainingBaseAmount: 0n,
    filledBaseAmount: 0n,
    filledQuoteMicro: 0n,
    orderExpiryMs: NOW_MS + 20 * 86_400_000,
    nonce: 1,
    parentOrderIndex: "0",
    timestampMs: NOW_MS - 60_000,
    ...over,
  };
}

function liveInput(over: Partial<PerpsViewInput> = {}, orders: readonly VenueOrder[] | null = []): PerpsViewInput {
  return input({
    mode: "live",
    settings: LIVE_SETTINGS,
    venue: { account: ACCT, orders, decimals: DETAILS.decimals },
    ...over,
  });
}

describe("live: the venue account is the book", () => {
  const nvdaRow = row({ marketId: 15, side: "long", base: 39_685n, entryPrice: 23_083n, stopTrigger: 22_000n, stopPrice: 21_500n, openedAt: NOW - 7_200 });
  const v = mustView(
    liveInput(
      { ledger: ledger({ positions: [nvdaRow], depositsInTransitMicro: u(2), withdrawalsInTransitMicro: u(1) }) },
      [order({ orderIndex: "101" }), order({ orderIndex: "102", triggerPrice: 21_000n, price: 20_600n })],
    ),
  );

  it("positions carry the venue's own size, entry, margin, P&L, liquidation and funding", () => {
    const nvda = v.positions.get("NVDA-PERP")!;
    assert.equal(nvda.baseAmount, 39_685n); // "3.9685"
    assert.equal(nvda.entryPrice, 23_083n); // "230.83"
    assert.equal(nvda.imfBp, 833); // "8.33" percent
    assert.equal(nvda.allocatedMarginMicro, 76_476_136n);
    assert.equal(nvda.unrealizedMicro, 647_589n);
    assert.equal(nvda.liqPrice, 21_810n, "218.0989960890466 rounded toward the entry");
    assert.equal(nvda.markPrice, view(15).markPrice, "fresh feed mark");
    const qqq = v.positions.get("QQQ-PERP")!;
    assert.equal(qqq.fundingMicro, -12_472n, "holder-signed, as the venue renders it");
    assert.equal(qqq.stop, null, "no record and nothing resting");
    assert.equal(v.facts.positions.get("QQQ-PERP")!.stopState, "missing");
  });

  it("the stop resting at the recorded trigger is the stop; others are listed to supersede", () => {
    const f = v.facts.positions.get("NVDA-PERP")!;
    assert.equal(f.stopState, "resting");
    assert.equal(f.restingStopOrder, "101");
    assert.deepEqual(f.otherStopOrders, ["102"]);
    assert.equal(f.stopExpiresAtSec, Math.floor((NOW_MS + 20 * 86_400_000) / 1000));
    assert.equal(f.openedAtKnown, true);
    const p = v.positions.get("NVDA-PERP")!;
    assert.deepEqual(p.stop, { trigger: 22_000n, price: 21_500n, expiresAtSec: f.stopExpiresAtSec, resting: true });
  });

  it("rule 12: C, ΣM and ΣU are the one account read's; T is the ledger's in-transit", () => {
    assert.equal(v.readAtSec, Math.floor(1_790_694_641_487_929 / 1_000_000));
    const book = buildPerpBookTerm(v);
    assert.notEqual(book, "unread");
    assert.deepEqual(book, {
      collateralMicro: 329_402n,
      isolatedMarginMicro: 76_476_136n + 74_277_343n,
      unrealizedMicro: 647_589n - 873_438n,
      unrealizedGainMicro: 647_589n,
      inTransitMicro: u(3),
      snapshotTime: 1_790_694_641_487_929,
    });
    assert.equal(v.account.accountValueMicro, ACCT.venueValueMicro + u(3));
    assert.equal(v.facts.committedCollateralMicro, 329_402n + 76_476_136n + 74_277_343n + u(2));
    assert.equal(v.facts.accountIndex, 22149);
  });

  it("venue leverage state comes from the account's rows (flat ones too)", () => {
    const nvda = v.markets.get("NVDA-PERP")!;
    assert.equal(nvda.venueImfBp, 833);
    assert.equal(nvda.venueMarginMode, "isolated");
    assert.equal(nvda.imfBp, leverageTarget(10, NVDA).imfBp);
    assert.equal(v.markets.get("QQQ-PERP")!.imfBp, leverageTarget(10, QQQ).imfBp);
  });

  it("unread orders leave every stop UNREAD, never missing", () => {
    const u2 = mustView(liveInput({ ledger: ledger({ positions: [nvdaRow] }) }, null));
    assert.equal(u2.facts.positions.get("NVDA-PERP")!.stopState, "unread");
    assert.equal(u2.facts.positions.get("QQQ-PERP")!.stopState, "unread");
    assert.equal(u2.positions.get("NVDA-PERP")!.stop!.resting, false);
  });

  it("a stop resting at another trigger is 'other'; with no record the tightest resting stop is adopted", () => {
    const other = mustView(liveInput({ ledger: ledger({ positions: [nvdaRow] }) }, [order({ orderIndex: "103", triggerPrice: 21_900n })]));
    assert.equal(other.facts.positions.get("NVDA-PERP")!.stopState, "other");
    assert.deepEqual(other.facts.positions.get("NVDA-PERP")!.otherStopOrders, ["103"]);
    const adopted = mustView(
      liveInput({}, [
        order({ orderIndex: "104", triggerPrice: 21_000n }),
        order({ orderIndex: "105", triggerPrice: 22_100n, price: 21_700n }),
        // not ours: the wrong side, not reduce-only, finished
        order({ orderIndex: "106", triggerPrice: 22_900n, isAsk: false }),
        order({ orderIndex: "107", triggerPrice: 22_800n, reduceOnly: false }),
        order({ orderIndex: "108", triggerPrice: 22_700n, status: "canceled" }),
      ]),
    );
    const f = adopted.facts.positions.get("NVDA-PERP")!;
    assert.equal(f.stopState, "resting");
    assert.deepEqual(f.recordedStop, { trigger: 22_100n, price: 21_700n });
    assert.equal(f.restingStopOrder, "105");
    assert.deepEqual(f.otherStopOrders, ["104"]);
    assert.equal(f.openedAtKnown, false);
    assert.equal(adopted.positions.get("NVDA-PERP")!.openedAtSec, 0, "an undated open reads as old, never as new");
  });

  it("with the feed stale, the mark is the account's own position_value / size, rounded toward liquidation", () => {
    const stale = feed({ "15": feedMarket(15, { observedAt: NOW_MS - 45_000 }), "25": feedMarket(25) });
    const s = mustView(liveInput({ feed: stale }));
    const nvda = s.positions.get("NVDA-PERP")!;
    // 916.683815 / 3.9685 = 230.99 exactly
    assert.equal(nvda.markPrice, 23_099n);
    const f = s.facts.positions.get("NVDA-PERP")!;
    assert.equal(f.markSource, "account");
    assert.equal(f.markFresh, true);
    assert.equal(f.held.fresh, false);
    assert.equal(f.held.status, null, "a stale feed says nothing about status");
    assert.ok(!s.markets.has("NVDA-PERP"), "stale is unread for opens");
  });

  it("exitsOnly: a feed outage does not blind the exits lane — the account alone marks the book, and nothing opens", () => {
    for (const f of [null, feed({ "15": feedMarket(15, { observedAt: NOW_MS - 45_000 }), "25": feedMarket(25, { observedAt: NOW_MS - 45_000 }) })]) {
      assert.equal(buildPerpsView(liveInput({ feed: f })), null, "for opens it is unread");
      const s = mustView(liveInput({ feed: f, exitsOnly: true }));
      assert.equal(s.markets.size, 0);
      assert.equal(s.opensBlocked, "perps-venue-unreachable");
      assert.equal(s.positions.get("NVDA-PERP")!.markPrice, 23_099n);
      assert.equal(s.facts.positions.get("NVDA-PERP")!.markSource, "account");
      assert.notEqual(buildPerpBookTerm(s), "unread", "the venue term is the account's, feed or no feed");
    }
    // Paper has no account to fall back on.
    assert.equal(buildPerpsView(input({ feed: null, exitsOnly: true, ledger: ledger({ positions: [paperBtc()] }) })), null);
  });

  it("a total_asset_value that does not cross-check is a book gap", () => {
    const off = { ...ACCT, totalAssetValueMicro: ACCT.venueValueMicro + 1_000n };
    const s = mustView(liveInput({ venue: { account: off, orders: [], decimals: DETAILS.decimals } }));
    assert.equal(buildPerpBookTerm(s), "unread");
  });

  it("a position in a market outside the frozen table is foreign: counted, kept out of positions, and an incident", () => {
    const foreignPos = { ...ACCT.positions.find((p) => p.marketId === 15)!, marketId: 999, symbol: "ZZZ", key: null };
    const acct: PerpAccountRead = { ...ACCT, positions: [...ACCT.positions, foreignPos] };
    const s = mustView(liveInput({ venue: { account: acct, orders: [], decimals: DETAILS.decimals } }));
    assert.equal(s.facts.foreign.length, 1);
    assert.ok(![...s.positions.values()].some((p) => p.marketId === 999));
    assert.equal(s.facts.incident, true);
    assert.equal(s.opensBlocked, "perps-unknown-activity");
    const without = mustView(liveInput()).facts.openNotionalMicro;
    assert.equal(s.facts.openNotionalMicro, without + 916_683_815n, "its |position_value| joins the open notional");
  });

  it("money parked where the worker never puts it (pool shares, spot) is an incident", () => {
    const s = mustView(liveInput({ venue: { account: { ...ACCT, poolShareCount: 1 }, orders: [], decimals: DETAILS.decimals } }));
    assert.equal(s.facts.incident, true);
  });
});

// ── blockers ────────────────────────────────────────────────────────────────

describe("opensBlocked: the most fundamental blocker wins", () => {
  it("the priority list names every blocker exactly once", () => {
    assert.equal(new Set(PERP_BLOCKER_PRIORITY).size, PERP_BLOCKER_PRIORITY.length);
    assert.equal(PERP_BLOCKER_PRIORITY.length, 14);
  });
  it("incident > halt > breaker > grant expiring > rail > cap-below-min > no collateral", () => {
    const all = input({
      ledger: ledger({ incident: true, entriesHalted: true, paperCashMicro: 0n }),
      breakerTripped: true,
      grant: { perTradeSealedMicro: u(1), expiresAtSec: NOW + 3_600 },
      railBlocker: "perps-awaiting-deposit",
    });
    const steps: [Partial<PerpsViewInput>, string | null][] = [
      [{}, "perps-unknown-activity"],
      [{ ledger: ledger({ entriesHalted: true, paperCashMicro: 0n }) }, "perps-entries-halted"],
      [{ ledger: ledger({ paperCashMicro: 0n }) }, "breaker-tripped"],
      [{ ledger: ledger({ paperCashMicro: 0n }), breakerTripped: false }, "perps-grant-expiring"],
      [{ ledger: ledger({ paperCashMicro: 0n }), breakerTripped: false, grant: { perTradeSealedMicro: u(1), expiresAtSec: NOW + 2 * 86_400 } }, "perps-awaiting-deposit"],
      [{ ledger: ledger({ paperCashMicro: 0n }), breakerTripped: false, grant: { perTradeSealedMicro: u(1), expiresAtSec: null }, railBlocker: null }, "perps-cap-below-min"],
      [{ ledger: ledger({ paperCashMicro: 0n }), breakerTripped: false, railBlocker: null, grant: { perTradeSealedMicro: u(25), expiresAtSec: null } }, "perps-no-collateral"],
      [{ ledger: ledger({ paperCashMicro: u(100) }), breakerTripped: false, railBlocker: null, grant: { perTradeSealedMicro: u(25), expiresAtSec: null } }, null],
    ];
    for (const [over, want] of steps) assert.equal(mustView({ ...all, ...over }).opensBlocked, want, JSON.stringify(want));
  });
  it("the operator halt counts the same as the owner's", () => {
    assert.equal(mustView(input({ settings: { ...SETTINGS, perpsEntriesHalted: true } })).opensBlocked, "perps-entries-halted");
  });
  it("a key mismatch from the arm path outranks everything but an incident", () => {
    assert.equal(mustView(input({ railBlocker: "perps-key-mismatch", breakerTripped: true })).opensBlocked, "perps-key-mismatch");
  });
});

// ── the derived shapes use the same numbers ─────────────────────────────────

const LIMITS: AgentLimits = {
  perTradeUsdg: u(25),
  dailyUsdg: u(100),
  allowedTargets: [],
  allowedAssets: [],
  cashToken: "0x00000000000000000000000000000000000000dd",
  maxDrawdownBps: 1_500,
  expiresAt: NOW + 30 * 86_400,
  maxOpsPerDay: 10,
};

describe("buildPerpPolicyState is the view's numbers", () => {
  const i = input({ ledger: ledger({ positions: [row({ marketId: 1 }), row({ marketId: 0 })], paperCashMicro: u(100), opensToday: 2 }) });
  const v = mustView(i);
  const st = buildPerpPolicyState(i, v, { mode: "paper" });

  it("figures, settings and markets", () => {
    assert.equal(st.mode, "paper");
    assert.equal(st.refuseRule, null);
    assert.equal(st.openNotionalMicro, v.facts.openNotionalMicro);
    assert.equal(st.committedCollateralMicro, v.facts.committedCollateralMicro);
    assert.equal(st.opensToday, 2);
    assert.deepEqual(st.settings, {
      markets: ["BTC-PERP", "ETH-PERP"],
      maxLeverage: 2,
      perTradeMicro: u(25),
      maxOpenNotionalMicro: u(50),
      maxCollateralMicro: u(30),
      maxOpensPerDay: 4,
      stopLossBps: 500,
      stopSlipBps: 200,
      liqBufferBps: 200,
      maxSlippageBps: 50,
    });
    const m = st.markets.get(1)!;
    assert.equal(m.imfBpTarget, v.markets.get("BTC-PERP")!.imfBp);
    assert.equal(m.effMinNotionalMicro, v.markets.get("BTC-PERP")!.effMinNotionalMicro);
    assert.equal(m.mmfBp, BTC.mmfBp);
  });

  it("an open sized to the view's own headroom passes checkPolicy on the state built from it", () => {
    const btc = v.markets.get("BTC-PERP")!;
    const mark = btc.markPrice;
    const worst = worstPriceForTaker({ isAsk: false, mark, maxSlippageBps: 50 });
    const base = baseForNotional(u(20), worst, btc.spec, "floor");
    const stop = stopPrices({ side: "long", entryRefPrice: mark, stopLossBps: 500, stopSlipBps: 200 });
    const intent: PerpOpenIntent = {
      kind: "perp-order",
      venue: "lighter",
      market: "BTC-PERP",
      marketId: 1,
      effect: "open",
      side: "long",
      reduceOnly: false,
      baseAmount: base,
      worstPrice: worst,
      markPrice: mark,
      notionalUsdg: notionalMicro(base, worst, btc.spec, "ceil"),
      imfBp: btc.imfBp,
      stopTrigger: stop.trigger,
      stopPrice: stop.price,
    };
    assert.ok(intent.notionalUsdg <= v.headroom.perTradeNotionalMicro);
    const verdict = checkPolicy(intent, LIMITS, { spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: 0n, equityUsdg: 0n, nowSec: NOW, perp: st });
    assert.deepEqual(verdict, { ok: true });
  });

  it("the sealed cap binds when it is the smaller", () => {
    const tight = buildPerpPolicyState({ ...i, grant: { ...i.grant, perTradeSealedMicro: u(12) } }, v, { mode: "paper" });
    assert.equal(tight.settings.perTradeMicro, u(12));
  });

  it("a refusing rail carries its rule, and still carries positions for exits", () => {
    const held = input({ ledger: ledger({ positions: [paperBtc()] }) });
    const s = buildPerpPolicyState(held, mustView(held), { mode: "refuse", rule: "perp-live-not-enabled" });
    assert.equal(s.mode, "refuse");
    assert.equal(s.refuseRule, "perp-live-not-enabled");
    assert.deepEqual(s.positions.get(1), { side: "long", baseAmount: BASE });
  });

  it("unread: ledger positions for exits, no markets, and money totals saturated at their caps", () => {
    const held = input({ ledger: ledger({ positions: [paperBtc()] }) });
    const s = buildPerpPolicyState(held, null, { mode: "paper" });
    assert.deepEqual(s.positions.get(1), { side: "long", baseAmount: BASE });
    assert.equal(s.markets.size, 0);
    assert.equal(s.openNotionalMicro, u(50));
    assert.equal(s.committedCollateralMicro, u(30));
  });
});

describe("buildPerpsReport", () => {
  it("round-trips the core whitelist parser and says only what was seen", () => {
    const i = input({ ledger: ledger({ positions: [paperBtc()] }) });
    const v = mustView(i);
    const r = buildPerpsReport(i, v, { rail: { mode: "paper" }, protectAtMs: NOW_MS });
    assert.deepEqual(parsePerpsReport(JSON.parse(JSON.stringify(r))), r);
    assert.equal(r.mode, "paper");
    assert.equal(r.blocker, null);
    assert.equal(r.positions.length, 1);
    const p = r.positions[0]!;
    assert.equal(p.market, "BTC-PERP");
    assert.equal(p.baseAmount, "0.00030");
    assert.equal(p.entryPrice, "83000.0");
    assert.equal(p.markPrice, renderScaled(view(1).markPrice, 1));
    assert.equal(p.leverage, 2);
    assert.equal(p.stopTrigger, renderScaled(PAPER_STOP.trigger, 1));
    assert.equal(r.stopsMissing, 0);
    assert.equal(r.collateralMicro, PAPER_MARGIN.toString());
    assert.ok(r.minLiqDistanceBps !== null && r.minLiqDistanceBps > 4_000);
  });

  it("live: unread orders count as missing stops, and the venue's P&L is always said", () => {
    const i = liveInput({}, null);
    const v = mustView(i);
    const r = buildPerpsReport(i, v, { rail: { mode: "live" }, protectAtMs: null });
    assert.ok(parsePerpsReport(JSON.parse(JSON.stringify(r))));
    assert.equal(r.stopsMissing, 2);
    assert.equal(r.accountIndex, 22149);
    assert.equal(r.venueReadAt, Math.floor(1_790_694_641_487_929 / 1000));
    assert.ok(r.positions.every((p) => p.unrealizedMicro !== null && p.stopTrigger === null));
  });

  it("unread: the ledger's positions with every venue figure null — never 'No positions'", () => {
    const i = input({ ledger: ledger({ positions: [paperBtc()] }) });
    const r = buildPerpsReport(i, null, { rail: { mode: "paper" }, protectAtMs: null, lastVenueReadAtMs: NOW_MS - 300_000 });
    assert.ok(parsePerpsReport(JSON.parse(JSON.stringify(r))));
    assert.equal(r.blocker, "perps-venue-unreachable");
    assert.equal(r.collateralMicro, null);
    assert.equal(r.openNotionalMicro, null);
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0]!.markPrice, null);
    assert.equal(r.stopsMissing, 1);
    assert.equal(r.venueReadAt, NOW_MS - 300_000);
  });

  it("rail refusals map to their blockers", () => {
    const i = input();
    const v = mustView(i);
    const b = (rail: Parameters<typeof buildPerpsReport>[2]["rail"]) => buildPerpsReport(i, v, { rail, protectAtMs: null }).blocker;
    assert.equal(b({ mode: "off" }), "perps-off");
    assert.equal(b({ mode: "refuse", rule: "perp-live-not-enabled" }), "perps-live-off");
    assert.equal(b({ mode: "refuse", rule: "perp-not-granted" }), "perps-not-granted");
    assert.equal(b({ mode: "refuse", rule: "perp-venue-unready" }), "perps-venue-unreachable");
    assert.equal(b({ mode: "refuse", rule: "no-cash" }), "account-not-live");
    assert.equal(b({ mode: "refuse", rule: "perp-operator-off" }), null);
  });

  it("a foreign position is shown when it can be rendered, and flags the incident", () => {
    const foreignPos = { ...ACCT.positions.find((p) => p.marketId === 15)!, marketId: 15_000, symbol: "ZZZ", key: null };
    const decimals = new Map(DETAILS.decimals);
    decimals.set(15_000, { sizeDecimals: 4, priceDecimals: 2 });
    const i = liveInput({ venue: { account: { ...ACCT, positions: [...ACCT.positions, foreignPos] }, orders: [], decimals } });
    const r = buildPerpsReport(i, mustView(i), { rail: { mode: "live" }, protectAtMs: null });
    assert.ok(parsePerpsReport(JSON.parse(JSON.stringify(r))));
    assert.ok(r.positions.some((p) => p.market === ("ZZZ-PERP" as PerpKey)));
    assert.equal(r.incident, true);
  });
});
