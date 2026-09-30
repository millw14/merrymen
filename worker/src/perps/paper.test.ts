/**
 * THE PAPER VENUE, PURE (docs/perps.md rule 14). No ledger, no feed: books,
 * marks and positions built by hand at the BTC market's real decimals
 * (orderBookDetails capture: size 5 dp, price 1 dp, MMF 120, closeout 80,
 * liquidation fee 1%), so every figure below can be checked with a pencil.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { isolatedLiqPrice, isolatedMarginMicro, type PerpMarketSpec } from "../../../packages/core/src/perps";
import { parseOrderBookDetails } from "./markets";
import {
  PAPER_DEFAULT_LIQUIDATION_FEE_BP,
  PerpRefused,
  applyPaperClose,
  applyPaperFunding,
  applyPaperOpen,
  applyPaperReduce,
  evaluatePaperTriggers,
  hourOf,
  paperFundingTerms,
  paperLiquidation,
  paperPerpTerms,
  simulateTakerFill,
  type PaperMarketRead,
  type PaperPerpBook,
  type PaperPerpPosition,
  type TakerFill,
} from "./paper";

const DETAILS = parseOrderBookDetails(JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "orderBookDetails.perp.json"), "utf8")))!;
const BTC: PerpMarketSpec = DETAILS.markets.get(1)!.spec;
const NOW = 1_790_706_600_000; // 30 min past an hour
const H = 1_790_708_400; // the next hour, unix seconds

assert.equal(BTC.sizeDecimals, 5);
assert.equal(BTC.priceDecimals, 1);
assert.equal(BTC.mmfBp, 120);
assert.equal(BTC.closeoutBp, 80);
assert.equal(H % 3600, 0);

const lv = (price: number, base: number) => ({ price: BigInt(price), baseAmount: BigInt(base) });

function book(cashUsdg: number, positions: PaperPerpPosition[] = []): PaperPerpBook {
  return { cashMicro: BigInt(cashUsdg) * 1_000_000n, positions: new Map(positions.map((p) => [p.marketId, p])) };
}

function buy(base: number, worst: number, asks: ReturnType<typeof lv>[], takerFeePpm = 0): TakerFill {
  return simulateTakerFill({ isAsk: false, baseAmount: BigInt(base), worstPrice: BigInt(worst), book: { bids: [], asks }, spec: BTC, takerFeePpm });
}

function sell(base: number, worst: number, bids: ReturnType<typeof lv>[], takerFeePpm = 0): TakerFill {
  return simulateTakerFill({ isAsk: true, baseAmount: BigInt(base), worstPrice: BigInt(worst), book: { bids, asks: [] }, spec: BTC, takerFeePpm });
}

/** A 0.0002 BTC long at 80,000.0, 2x isolated (16 USDG notional, 8 USDG margin), stop 76,000.0 / 74,480.0. */
function long(over: Partial<PaperPerpPosition> = {}): PaperPerpPosition {
  return {
    marketId: 1,
    side: "long",
    baseAmount: 20n,
    entryPrice: 800_000n,
    allocatedMarginMicro: 8_000_000n,
    imfBp: 5000,
    realizedMicro: 0n,
    fundingMicro: 0n,
    stop: { trigger: 760_000n, price: 744_800n },
    take: null,
    openedAtSec: Math.floor(NOW / 1000),
    fundingHourApplied: hourOf(Math.floor(NOW / 1000)),
    ...over,
  };
}

function short(over: Partial<PaperPerpPosition> = {}): PaperPerpPosition {
  return long({ side: "short", stop: { trigger: 840_000n, price: 856_800n }, ...over });
}

// ── the book walk ───────────────────────────────────────────────────────────

describe("simulateTakerFill walks the book like an IOC", () => {
  it("takes levels best first, stops at the worst price, and cancels the rest", () => {
    const f = buy(30, 832_400, [lv(832_200, 10), lv(832_301, 15), lv(832_500, 100)], 100);
    assert.equal(f.filledBase, 25n, "the 832,500 level is past the worst price and is never touched");
    assert.equal(f.requestedBase, 30n);
    assert.deepEqual(f.levels, [lv(832_200, 10), lv(832_301, 15)]);
    // VWAP = (10 × 832200 + 15 × 832301) / 25 = 832260.6 → a buy settles on the tick ABOVE.
    assert.equal(f.avgPrice, 832_261n);
    // 0.00025 BTC × 83,226.1 = 20.806525 USDG, exact at 5 + 1 decimals.
    assert.equal(f.filledQuoteMicro, 20_806_525n);
    // 1 bp of it is 2080.6525 micro — a fee rounds UP.
    assert.equal(f.feeMicro, 2_081n);
  });

  it("a sell walks the bids down to its bound and settles on the tick below", () => {
    const f = sell(25, 832_050, [lv(832_100, 10), lv(832_000, 20)]);
    assert.equal(f.filledBase, 10n);
    assert.equal(f.avgPrice, 832_100n);
    const g = sell(3, 832_000, [lv(832_101, 1), lv(832_100, 2)]);
    // (832101 + 2 × 832100) / 3 = 832100.33… → floor.
    assert.equal(g.avgPrice, 832_100n);
    assert.equal(g.filledQuoteMicro, 2_496_300n, "the account receives the floor — never the sub-tick");
  });

  it("a level exactly at the worst price fills; nothing inside it is a zero fill, not an error", () => {
    assert.equal(buy(5, 832_200, [lv(832_200, 10)]).filledBase, 5n);
    const none = buy(5, 832_199, [lv(832_200, 10)]);
    assert.equal(none.filledBase, 0n);
    assert.equal(none.avgPrice, null);
    assert.equal(none.filledQuoteMicro, 0n);
    assert.deepEqual(none.levels, []);
    assert.equal(sell(5, 800_000, []).filledBase, 0n, "an empty side fills nothing");
  });

  it("never settles past the worst price, whatever the book", () => {
    for (let i = 0; i < 200; i++) {
      const worst = 830_000 + ((i * 37) % 500);
      const asks = [lv(829_900 + (i % 7), 1 + (i % 3)), lv(830_100 + (i % 11), 2 + (i % 5)), lv(830_400 + (i % 13), 5)];
      const f = buy(1 + (i % 9), worst, asks);
      if (f.avgPrice !== null) assert.ok(f.avgPrice <= BigInt(worst), `buy ${i} settled at ${f.avgPrice} over ${worst}`);
      const bids = [lv(830_400 - (i % 7), 1 + (i % 3)), lv(830_100 - (i % 11), 2 + (i % 5)), lv(829_800 - (i % 13), 5)];
      const s = sell(1 + (i % 9), worst, bids);
      if (s.avgPrice !== null) assert.ok(s.avgPrice >= BigInt(worst), `sell ${i} settled at ${s.avgPrice} under ${worst}`);
    }
  });

  it("refuses a book it cannot trust, and inputs that are not venue integers", () => {
    assert.throws(() => buy(5, 900_000, [lv(832_300, 1), lv(832_200, 1)]), /ascending/);
    assert.throws(() => sell(5, 800_000, [lv(832_100, 1), lv(832_100, 1)]), /descending/);
    assert.throws(() => buy(5, 900_000, [lv(832_300, 0)]), /positive/);
    assert.throws(() => buy(0, 900_000, []), /baseAmount/);
    assert.throws(() => buy(5, 0, []), /worstPrice/);
    assert.throws(() => simulateTakerFill({ isAsk: false, baseAmount: 1n, worstPrice: 1n, book: { bids: [], asks: [] }, spec: BTC, takerFeePpm: 1.5 }), /takerFeePpm/);
  });
});

// ── open, reduce, close ─────────────────────────────────────────────────────

describe("isolated margin, P&L and cash", () => {
  const stopL = { trigger: 760_000n, price: 744_800n };

  it("a long opens with margin + fee drawn from cash, and closes returning margin + realized − fees", () => {
    const fill = buy(20, 804_000, [lv(800_000, 1000)], 1000);
    const open = applyPaperOpen({ book: book(100), marketId: 1, side: "long", fill, imfBp: 5000, stop: stopL, spec: BTC, nowMs: NOW, tradeId: "paper:open:1:9" });
    // 0.0002 BTC × 80,000 = 16 USDG notional; 2x → 8 USDG margin; 0.1% fee = 0.016.
    assert.equal(fill.filledQuoteMicro, 16_000_000n);
    assert.equal(fill.feeMicro, 16_000n);
    const pos = open.after!;
    assert.equal(pos.allocatedMarginMicro, isolatedMarginMicro(16_000_000n, 5000));
    assert.equal(pos.allocatedMarginMicro, 8_000_000n);
    assert.equal(open.cashDeltaMicro, -8_016_000n);
    assert.equal(open.book.cashMicro, 91_984_000n);
    assert.equal(pos.entryPrice, 800_000n);
    assert.deepEqual(pos.stop, stopL, "the stop rests for as long as the position lives");
    assert.equal(pos.fundingHourApplied, hourOf(Math.floor(NOW / 1000)), "the hour already begun is not this position's");
    const [f] = open.fills;
    assert.equal(f?.venueTradeId, "paper:open:1:9");
    assert.equal(f?.side, "long");
    assert.equal(f?.sideRole, "bid");
    assert.equal(f?.realizedMicro, 0n);
    assert.equal(f?.leg, "entry");
    assert.equal(f?.attribution, "intent");

    const exit = sell(20, 830_000, [lv(840_000, 1000)], 1000);
    const close = applyPaperClose({ book: open.book, marketId: 1, fill: exit, spec: BTC, nowMs: NOW + 1, tradeId: "paper:close:1:10" });
    // 0.0002 × 4,000 = 0.8 USDG realized; the exit fee is 0.1% of 16.8 = 0.0168.
    const [c] = close.fills;
    assert.equal(c?.realizedMicro, 800_000n);
    assert.equal(c?.feeMicro, 16_800n);
    assert.equal(c?.positionBefore, 20n);
    assert.equal(c?.entryQuoteBeforeMicro, 16_000_000n);
    assert.equal(close.cashDeltaMicro, 8_000_000n + 800_000n - 16_800n);
    assert.equal(close.after, null);
    assert.equal(close.book.positions.size, 0);
    assert.deepEqual(close.restingEnds, [{ role: "sl", status: "cancelled" }], "the stop dies with the position");
    // 100 − 0.016 − 0.0168 + 0.8 = 100.7672: the whole round trip in cash.
    assert.equal(close.book.cashMicro, 100_767_200n);
  });

  it("a partial reduce releases its share of the margin with its P&L; the rest keeps its leverage", () => {
    const b = book(92, [long()]);
    const half = applyPaperReduce({ book: b, marketId: 1, fill: sell(10, 830_000, [lv(840_000, 1000)]), spec: BTC, nowMs: NOW, tradeId: "t1", leg: "close" });
    assert.equal(half.fills[0]?.realizedMicro, 400_000n);
    assert.equal(half.cashDeltaMicro, 4_400_000n);
    assert.equal(half.after?.baseAmount, 10n);
    assert.equal(half.after?.allocatedMarginMicro, 4_000_000n);
    assert.equal(half.after?.realizedMicro, 400_000n);
    assert.deepEqual(half.after?.stop, long().stop, "a reduce leaves the children resting");
    assert.deepEqual(half.restingEnds, []);
    const rest = applyPaperReduce({ book: half.book, marketId: 1, fill: sell(10, 770_000, [lv(780_000, 1000)]), spec: BTC, nowMs: NOW, tradeId: "t2", leg: "close" });
    assert.equal(rest.fills[0]?.realizedMicro, -200_000n);
    assert.equal(rest.cashDeltaMicro, 3_800_000n);
    assert.equal(rest.book.cashMicro, 100_200_000n, "92 + 4.4 + 3.8: +0.4 then −0.2 on the book");
  });

  it("a short profits when the price falls, and a loss past its share comes out of the margin left, not cash", () => {
    const b = book(92, [short()]);
    const win = applyPaperReduce({ book: b, marketId: 1, fill: buy(20, 770_000, [lv(760_000, 1000)]), spec: BTC, nowMs: NOW, tradeId: "t", leg: "close" });
    assert.equal(win.fills[0]?.realizedMicro, 800_000n);
    assert.equal(win.fills[0]?.side, "short", "a short is never spelled sell");
    assert.equal(win.fills[0]?.sideRole, "bid");
    assert.equal(win.fills[0]?.positionBefore, -20n);
    assert.equal(win.cashDeltaMicro, 8_800_000n);

    // Half the short bought back 12.5% higher: −1.0 USDG realized on a 4 USDG share.
    const lose = applyPaperReduce({ book: b, marketId: 1, fill: buy(10, 910_000, [lv(900_000, 1000)]), spec: BTC, nowMs: NOW, tradeId: "t", leg: "close" });
    assert.equal(lose.fills[0]?.realizedMicro, -1_000_000n);
    assert.equal(lose.cashDeltaMicro, 3_000_000n);
    // Now bought back 3x the stop distance up, on a tiny share: the loss is
    // bigger than the share, so cash moves nothing and the margin pays.
    const deep = applyPaperReduce({ book: b, marketId: 1, fill: buy(4, 1_010_000, [lv(1_000_000, 1000)]), spec: BTC, nowMs: NOW, tradeId: "t", leg: "close" });
    // 0.00004 × −20,000 = −0.8 realized; share = 8 × 4/20 = 1.6 → out = +0.8 (still ≥ 0)
    assert.equal(deep.cashDeltaMicro, 800_000n);
    const deeper = applyPaperReduce({ book: b, marketId: 1, fill: buy(4, 1_300_000, [lv(1_200_000, 1000)]), spec: BTC, nowMs: NOW, tradeId: "t", leg: "close" });
    // −1.6 realized on a 1.6 share, and a zero fee: exactly nothing comes home.
    assert.equal(deeper.fills[0]?.realizedMicro, -1_600_000n);
    assert.equal(deeper.cashDeltaMicro, 0n);
    assert.equal(deeper.after?.allocatedMarginMicro, 6_400_000n);
    const past = applyPaperReduce({ book: b, marketId: 1, fill: buy(4, 1_700_000, [lv(1_600_000, 1000)]), spec: BTC, nowMs: NOW, tradeId: "t", leg: "close" });
    // −3.2 realized on a 1.6 share: cash nothing, and the other 1.6 from the margin left.
    assert.equal(past.cashDeltaMicro, 0n);
    assert.equal(past.after?.allocatedMarginMicro, 4_800_000n);
  });

  it("a loss past the whole isolated margin is capped at it: the account loses the margin, never more", () => {
    const b = book(92, [short()]);
    const out = applyPaperClose({ book: b, marketId: 1, fill: buy(20, 1_400_000, [lv(1_300_000, 1000)]), spec: BTC, nowMs: NOW, tradeId: "t" });
    // 0.0002 × −50,000 = −10 USDG on 8 of margin: booked −8, cash untouched.
    assert.equal(out.fills[0]?.realizedMicro, -8_000_000n);
    assert.equal(out.cashDeltaMicro, 0n);
    assert.equal(out.book.cashMicro, 92_000_000n);
    assert.equal(out.after, null);
  });

  it("reduce-only never flips: a fill larger than the position is refused, and the side must be the exit's", () => {
    const b = book(92, [long()]);
    assert.throws(
      () => applyPaperReduce({ book: b, marketId: 1, fill: sell(30, 800_000, [lv(840_000, 1000)]), spec: BTC, nowMs: NOW, tradeId: "t", leg: "close" }),
      /flip/,
    );
    assert.throws(
      () => applyPaperReduce({ book: b, marketId: 1, fill: buy(10, 900_000, [lv(840_000, 1000)]), spec: BTC, nowMs: NOW, tradeId: "t", leg: "close" }),
      /exits with a sell/,
    );
    assert.throws(() => applyPaperClose({ book: b, marketId: 1, fill: sell(10, 800_000, [lv(840_000, 1000)]), spec: BTC, nowMs: NOW, tradeId: "t" }), /whole position/);
    assert.throws(
      () => applyPaperReduce({ book: book(92), marketId: 1, fill: sell(10, 800_000, [lv(840_000, 1000)]), spec: BTC, nowMs: NOW, tradeId: "t", leg: "close" }),
      (e: unknown) => e instanceof PerpRefused && e.rule === "perp-no-position",
    );
  });

  it("an open never adds, always carries its stop, and never outruns the paper cash", () => {
    const fill = buy(20, 804_000, [lv(800_000, 1000)]);
    const args = { marketId: 1, side: "long" as const, fill, imfBp: 5000, stop: stopL, spec: BTC, nowMs: NOW, tradeId: "t" };
    assert.throws(() => applyPaperOpen({ ...args, book: book(100, [long()]) }), (e: unknown) => e instanceof PerpRefused && e.rule === "perp-add-to-position");
    assert.throws(() => applyPaperOpen({ ...args, book: book(7) }), (e: unknown) => e instanceof PerpRefused && e.rule === "perp-collateral-cap");
    assert.throws(
      () => applyPaperOpen({ ...args, book: book(100), stop: undefined as never }),
      (e: unknown) => e instanceof PerpRefused && e.rule === "perp-stop-required",
    );
    assert.throws(
      () => applyPaperOpen({ ...args, book: book(100), stop: { trigger: 810_000n, price: 800_000n } }),
      (e: unknown) => e instanceof PerpRefused && e.rule === "perp-stop-required",
      "a long's stop above its fill would close it at once",
    );
    assert.throws(
      () => applyPaperOpen({ ...args, book: book(100), stop: { trigger: 760_000n, price: 770_000n } }),
      (e: unknown) => e instanceof PerpRefused && e.rule === "perp-stop-required",
      "a long's stop bound above its trigger is not an exit",
    );
    assert.throws(() => applyPaperOpen({ ...args, book: book(100), side: "short" }), /short with a sell/);
    // Exactly enough cash is enough.
    assert.equal(applyPaperOpen({ ...args, book: book(8) }).book.cashMicro, 0n);
    // A zero fill is the IOC cancelled: nothing moves.
    const none = applyPaperOpen({ ...args, book: book(100), fill: buy(20, 799_000, [lv(800_000, 1000)]) });
    assert.equal(none.after, null);
    assert.equal(none.fills.length, 0);
    assert.equal(none.cashDeltaMicro, 0n);
  });
});

// ── funding ─────────────────────────────────────────────────────────────────

describe("hourly funding", () => {
  // 0.0012 %/h on an index of 80,000.0 is 0.96 USDG per BTC; on 0.0002 BTC, 192 micro.
  const terms = paperFundingTerms({ index: 800_000n, ratePpm: 12, spec: BTC });

  it("longs pay a positive rate and shorts receive it, out of and into the isolated margin", () => {
    assert.deepEqual(terms, { valuePerBase: 9_600_000n, valueDecimals: 7, direction: "long", creditReceiver: true });
    const paid = applyPaperFunding({ book: book(92, [long()]), marketId: 1, fundingHour: H, ...terms, ratePpm: 12, spec: BTC })!;
    assert.equal(paid.funding?.paymentMicro, -192n);
    assert.equal(paid.funding?.fundingId, `paper:funding:1:${H}`);
    assert.equal(paid.after?.allocatedMarginMicro, 8_000_000n - 192n);
    assert.equal(paid.after?.fundingMicro, -192n);
    assert.equal(paid.after?.fundingHourApplied, H);
    assert.equal(paid.cashDeltaMicro, 0n, "funding moves margin, not cash");
    const got = applyPaperFunding({ book: book(92, [short()]), marketId: 1, fundingHour: H, ...terms, spec: BTC })!;
    assert.equal(got.funding?.paymentMicro, 192n);
  });

  it("is idempotent by the hour: the same hour twice is charged once", () => {
    const once = applyPaperFunding({ book: book(92, [long()]), marketId: 1, fundingHour: H, ...terms, spec: BTC })!;
    assert.equal(applyPaperFunding({ book: once.book, marketId: 1, fundingHour: H, ...terms, spec: BTC }), null);
    assert.equal(applyPaperFunding({ book: once.book, marketId: 1, fundingHour: H - 3600, ...terms, spec: BTC }), null, "an earlier hour too");
    const next = applyPaperFunding({ book: once.book, marketId: 1, fundingHour: H + 3600, ...terms, spec: BTC });
    assert.equal(next?.after?.allocatedMarginMicro, 8_000_000n - 384n);
  });

  it("only a position held at the hour pays it", () => {
    const late = long({ openedAtSec: H, fundingHourApplied: null });
    assert.equal(applyPaperFunding({ book: book(92, [late]), marketId: 1, fundingHour: H, ...terms, spec: BTC }), null);
    assert.equal(applyPaperFunding({ book: book(92), marketId: 1, fundingHour: H, ...terms, spec: BTC }), null, "no position, nothing to pay");
    assert.throws(() => applyPaperFunding({ book: book(92, [long()]), marketId: 1, fundingHour: H + 1, ...terms, spec: BTC }), /on the hour/);
  });

  it("a negative rate charges shorts (the documented rule) and credits longs nothing (never a gain on a guess)", () => {
    const neg = paperFundingTerms({ index: 800_000n, ratePpm: -12, spec: BTC });
    assert.equal(neg.direction, "short");
    assert.equal(neg.creditReceiver, false);
    assert.equal(applyPaperFunding({ book: book(92, [short()]), marketId: 1, fundingHour: H, ...neg, spec: BTC })?.funding?.paymentMicro, -192n);
    const l = applyPaperFunding({ book: book(92, [long()]), marketId: 1, fundingHour: H, ...neg, spec: BTC })!;
    assert.equal(l.funding?.paymentMicro, 0n);
    assert.equal(l.after?.fundingHourApplied, H, "the hour is still consumed");
  });

  it("never charges more than the margin there is", () => {
    const thin = long({ allocatedMarginMicro: 100n });
    const s = applyPaperFunding({ book: book(92, [thin]), marketId: 1, fundingHour: H, ...terms, spec: BTC })!;
    assert.equal(s.funding?.paymentMicro, -100n);
    assert.equal(s.after?.allocatedMarginMicro, 0n);
  });
});

// ── resting children and liquidation ────────────────────────────────────────

function market(mark: number | null, bids: ReturnType<typeof lv>[] | null, asks: ReturnType<typeof lv>[] = [], spec = BTC): PaperMarketRead {
  return { mark: mark === null ? null : BigInt(mark), levels: bids === null ? null : { bids, asks }, spec, takerFeePpm: 0 };
}

describe("stops and take-profits fire on mark into the book", () => {
  it("a stop crossed fills at the book inside its bound and closes the position", () => {
    const r = evaluatePaperTriggers({ book: book(92, [long({ take: { trigger: 880_000n, price: 862_400n } })]), markets: new Map([[1, market(750_000, [lv(750_000, 100)])]]), nowMs: NOW, seq: 77 });
    assert.equal(r.events.length, 1);
    const [ev] = r.events;
    assert.equal(ev?.kind, "sl");
    assert.equal(ev?.id, "paper:sl:1:77");
    assert.equal(ev?.outcome, "closed");
    assert.equal(ev?.step.fills[0]?.attribution, "venue-stop");
    assert.equal(ev?.step.fills[0]?.leg, "sl");
    assert.equal(ev?.step.fills[0]?.realizedMicro, -1_000_000n);
    assert.deepEqual(ev?.step.restingEnds, [{ role: "sl", status: "filled" }, { role: "tp", status: "cancelled" }]);
    assert.equal(r.book.cashMicro, 92_000_000n + 7_000_000n);
    assert.equal(r.book.positions.size, 0);
  });

  it("a GAPPED stop — no bid inside its bound — is consumed and leaves the position open, as the venue does", () => {
    const pos = long();
    const r = evaluatePaperTriggers({ book: book(92, [pos]), markets: new Map([[1, market(750_000, [lv(740_000, 100)])]]), nowMs: NOW, seq: 5 });
    assert.equal(r.events.length, 1);
    const [ev] = r.events;
    assert.equal(ev?.outcome, "gapped");
    assert.deepEqual(ev?.step.fills, []);
    assert.deepEqual(ev?.step.restingEnds, [{ role: "sl", status: "cancelled" }]);
    const after = r.book.positions.get(1);
    assert.equal(after?.baseAmount, 20n, "still open");
    assert.equal(after?.stop, null, "without its stop — the protective loop puts one back");
    assert.equal(after?.allocatedMarginMicro, pos.allocatedMarginMicro);
    assert.equal(r.book.cashMicro, 92_000_000n);
  });

  it("a stop that finds some liquidity part-fills: the rest stays open and the stop is spent", () => {
    const r = evaluatePaperTriggers({ book: book(92, [long()]), markets: new Map([[1, market(750_000, [lv(750_000, 5), lv(740_000, 100)])]]), nowMs: NOW, seq: 5 });
    const [ev] = r.events;
    assert.equal(ev?.outcome, "reduced");
    assert.deepEqual(ev?.step.restingEnds, [{ role: "sl", status: "partial" }]);
    assert.equal(r.book.positions.get(1)?.baseAmount, 15n);
    assert.equal(r.book.positions.get(1)?.stop, null);
  });

  it("a short's stop fires on a mark at or above its trigger, and a take-profit on the winning side", () => {
    const s = evaluatePaperTriggers({ book: book(92, [short()]), markets: new Map([[1, market(840_000, [], [lv(845_000, 100)])]]), nowMs: NOW, seq: 1 });
    assert.equal(s.events[0]?.kind, "sl");
    assert.equal(s.events[0]?.step.fills[0]?.realizedMicro, -900_000n);
    const t = evaluatePaperTriggers({
      book: book(92, [long({ take: { trigger: 880_000n, price: 862_400n } })]),
      markets: new Map([[1, market(881_000, [lv(870_000, 100)])]]),
      nowMs: NOW,
      seq: 2,
    });
    assert.equal(t.events[0]?.kind, "tp");
    assert.equal(t.events[0]?.id, "paper:tp:1:2");
    assert.equal(t.events[0]?.step.fills[0]?.realizedMicro, 1_400_000n);
    assert.deepEqual(t.events[0]?.step.restingEnds, [{ role: "tp", status: "filled" }, { role: "sl", status: "cancelled" }]);
    const quiet = evaluatePaperTriggers({ book: book(92, [long()]), markets: new Map([[1, market(790_000, [lv(790_000, 100)])]]), nowMs: NOW, seq: 3 });
    assert.deepEqual(quiet.events, []);
  });

  it("nothing fires on a mark we do not have; a stop into a stale book waits, while liquidation is still judged", () => {
    const unread = evaluatePaperTriggers({ book: book(92, [long()]), markets: new Map([[1, market(null, [lv(750_000, 100)])]]), nowMs: NOW, seq: 1 });
    assert.deepEqual(unread.events, []);
    assert.deepEqual(unread.unread, [{ marketId: 1, why: "no fresh mark" }]);
    const missing = evaluatePaperTriggers({ book: book(92, [long()]), markets: new Map(), nowMs: NOW, seq: 1 });
    assert.equal(missing.unread.length, 1);
    const stale = evaluatePaperTriggers({ book: book(92, [long()]), markets: new Map([[1, market(750_000, null)]]), nowMs: NOW, seq: 1 });
    assert.deepEqual(stale.events, []);
    assert.match(stale.unread[0]?.why ?? "", /too old/);
    assert.equal(stale.book.positions.get(1)?.stop?.trigger, 760_000n, "the stop was not spent on a book we could not read");
    const tenx = long({ allocatedMarginMicro: 1_600_000n, imfBp: 1000 });
    const liq = evaluatePaperTriggers({ book: book(92, [tenx]), markets: new Map([[1, market(700_000, null)]]), nowMs: NOW, seq: 1 });
    assert.equal(liq.events.map((e) => e.kind).join(), "liq");
  });
});

describe("liquidation at the venue's line, with the venue's fee", () => {
  // 10x isolated: 16 USDG notional, 1.6 USDG margin.
  const tenx = () => long({ allocatedMarginMicro: 1_600_000n, imfBp: 1000 });

  it("the line is core's isolated liquidation price with the MARKET's maintenance fraction", () => {
    const p = tenx();
    const liq = isolatedLiqPrice({ side: "long", entryPrice: 800_000n, baseAmount: 20n, allocatedMarginMicro: 1_600_000n, mmfBp: 120, spec: BTC });
    // (80,000 − 1.6 / 0.0002) / (1 − 0.012) = 72,000 / 0.988 = 72,874.49… → 72,874.5 (toward the entry).
    assert.equal(liq, 728_745n);
    assert.ok(Math.abs(Number(liq) / 10 - (80_000 - 1.6 / 0.0002) / (1 - 0.012)) < 0.1);
    assert.equal(paperLiquidation(p, 728_746n, BTC), null, "a tick above the line is healthy");
    const at = paperLiquidation(p, 728_745n, BTC)!;
    assert.equal(at.kind, "partial");
    assert.equal(at.price, 728_745n);
    // realized = 0.0002 × (72,874.5 − 80,000) = −1.4251; left = 0.1749 (the MMR);
    // fee = 1% of 14.5749 = 0.145749; home = 0.029151.
    assert.equal(at.realizedMicro, -1_425_100n);
    assert.equal(at.feeMicro, 145_749n);
    assert.equal(at.returnedMicro, 29_151n);
  });

  it("a mark that gapped past the line closes at the mark, never better, and the fee is capped at the margin left", () => {
    const gap = paperLiquidation(tenx(), 728_000n, BTC)!;
    assert.equal(gap.kind, "partial");
    assert.equal(gap.price, 728_000n);
    assert.equal(gap.feeMicro, 145_600n);
    assert.equal(gap.returnedMicro, 14_400n);
    const capped = paperLiquidation(tenx(), 727_000n, BTC)!;
    // TAV = 1.6 − 1.46 = 0.14 ≥ CMR 0.11632: partial; 1% fee = 0.1454 > 0.14 left.
    assert.equal(capped.kind, "partial");
    assert.equal(capped.feeMicro, 140_000n);
    assert.equal(capped.returnedMicro, 0n);
  });

  it("below the close-out line the insurance fund takes the position over, and the margin with it", () => {
    const t = paperLiquidation(tenx(), 725_000n, BTC)!;
    // TAV = 1.6 − 1.5 = 0.1 < CMR = 14.5 × 0.008 = 0.116.
    assert.equal(t.kind, "takeover");
    assert.equal(t.realizedMicro, -1_500_000n);
    assert.equal(t.feeMicro, 100_000n);
    assert.equal(t.returnedMicro, 0n);
    const wiped = paperLiquidation(tenx(), 500_000n, BTC)!;
    assert.equal(wiped.realizedMicro, -1_600_000n, "never more than the margin");
    assert.equal(wiped.returnedMicro, 0n);
  });

  it("a short liquidates above its line; an unread fee is the venue's documented 1%", () => {
    const s = short({ allocatedMarginMicro: 1_600_000n, imfBp: 1000, stop: { trigger: 840_000n, price: 856_800n } });
    const liq = isolatedLiqPrice({ side: "short", entryPrice: 800_000n, baseAmount: 20n, allocatedMarginMicro: 1_600_000n, mmfBp: 120, spec: BTC })!;
    assert.equal(paperLiquidation(s, liq - 1n, BTC), null);
    const noFee = { ...BTC } as PerpMarketSpec;
    delete noFee.liquidationFeeBp;
    const at = paperLiquidation(s, liq, noFee)!;
    assert.equal(PAPER_DEFAULT_LIQUIDATION_FEE_BP, 100);
    assert.equal(at.feeMicro, paperLiquidation(s, liq, BTC)!.feeMicro);
    assert.ok(at.realizedMicro < 0n);
  });

  it("the trigger pass liquidates with venue-forced provenance and cancels every resting child", () => {
    const pos = { ...tenx(), take: { trigger: 900_000n, price: 882_000n } };
    const r = evaluatePaperTriggers({ book: book(92, [pos]), markets: new Map([[1, market(728_000, [lv(700_000, 100)])]]), nowMs: NOW, seq: 9 });
    // The stop fires first and gaps (no bid at or above 74,480.0), then the line is crossed.
    assert.deepEqual(r.events.map((e) => `${e.kind}:${e.outcome}`), ["sl:gapped", "liq:liquidated"]);
    const liq = r.events[1]!;
    assert.equal(liq.id, "paper:liq:1:9");
    const [f] = liq.step.fills;
    assert.equal(f?.tradeType, "liquidation");
    assert.equal(f?.attribution, "venue-forced");
    assert.equal(f?.leg, null);
    assert.equal(f?.feeMicro, 145_600n);
    assert.deepEqual(liq.step.restingEnds, [{ role: "tp", status: "cancelled" }], "the gapped stop already ended; the take goes now");
    assert.equal(liq.step.cashDeltaMicro, 14_400n);
    assert.equal(r.book.positions.size, 0);
    assert.equal(r.book.cashMicro, 92_014_400n);
  });

  it("is deterministic: the same book, marks and seq give the same events", () => {
    const args = { book: book(92, [tenx()]), markets: new Map([[1, market(728_000, [lv(700_000, 100)])]]), nowMs: NOW, seq: 4 };
    assert.deepEqual(evaluatePaperTriggers(args), evaluatePaperTriggers(args));
  });
});

describe("what the paper book is worth", () => {
  it("sums margin, unrealized, per-position gains and notional at mark — and is unread if any mark is", () => {
    const b = book(50, [long(), { ...short(), marketId: 0 }]);
    const specs = new Map([[1, BTC], [0, BTC]]);
    const t = paperPerpTerms(b, new Map([[1, 840_000n], [0, 840_000n]]), specs)!;
    assert.equal(t.isolatedMarginMicro, 16_000_000n);
    assert.equal(t.unrealizedMicro, 0n, "+0.8 on the long, −0.8 on the short");
    assert.equal(t.unrealizedGainMicro, 800_000n, "per position, never netted");
    assert.equal(t.openNotionalMicro, 33_600_000n);
    assert.equal(paperPerpTerms(b, new Map([[1, 840_000n]]), specs), null);
    assert.deepEqual(paperPerpTerms(book(50), new Map(), specs), { isolatedMarginMicro: 0n, unrealizedMicro: 0n, unrealizedGainMicro: 0n, openNotionalMicro: 0n });
  });
});
