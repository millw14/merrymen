/**
 * Attribution of an account's change (period-pnl.ts).
 *
 * The scenarios are the ones that made a single "change minus flows" figure
 * lie across a break in the record — an opening balance booked again at a
 * restart, a deposit made while the agent was down and booked by nobody — and
 * the ones that made judging every step lie inside a continuous run: an order
 * stamped before the mark its cash lands after, a deposit booked a tick early.
 * Plus the join across a redeploy between the shared ledger's record and the
 * child's own, and practice money kept apart from real money.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MIN_BREAK_SEC, accountSeries, attributeBook, breakGap, periodChange, stepAttribution, type AccountPoint, type BookMark } from "./period-pnl";

const mark = (at: number, equity: number, cash: number): BookMark => ({ at, equity, cash });
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The period from mark o to mark c. `gap` 0 judges every step; undefined uses the book's own break gap. */
function over(marks: BookMark[], flows: { at: number; signed: number; evidenced: boolean }[], trades: number[], gap?: number, o = 0, c = marks.length - 1) {
  const cum = attributeBook(marks, flows, trades, undefined, gap);
  const change = marks[c]!.equity - marks[o]!.equity;
  const f = cum[c]!.flows - cum[o]!.flows;
  const u = cum[c]!.unattributed - cum[o]!.unattributed;
  return { change: r6(change), flows: r6(f), unattributed: r6(u), trading: r6(change - f - u) };
}

describe("a judged step (a break in the record)", () => {
  it("an opening balance booked again with no cash behind it is dropped, never a trading loss", () => {
    const m = [mark(100, 100, 60), mark(200, 101, 60), mark(900, 102, 60)];
    assert.deepEqual(over(m, [{ at: 850, signed: 100, evidenced: false }], [], 0), { change: 2, flows: 0, unattributed: 0, trading: 2 });
  });

  it("a deposit nobody booked is unattributed, not profit", () => {
    const m = [mark(100, 100, 60), mark(200, 100, 60), mark(900, 151, 110), mark(960, 150, 110)];
    assert.deepEqual(over(m, [], [], 0), { change: 50, flows: 0, unattributed: 51, trading: -1 });
  });

  it("an inferred deposit the balance really made counts as money put in", () => {
    assert.deepEqual(over([mark(100, 100, 60), mark(160, 125, 85)], [{ at: 160, signed: 25, evidenced: false }], [], 0), { change: 25, flows: 25, unattributed: 0, trading: 0 });
  });

  it("a price move with cash flat is trading and price moves", () => {
    assert.deepEqual(over([mark(100, 100, 60), mark(900, 108, 60)], [], [], 0), { change: 8, flows: 0, unattributed: 0, trading: 8 });
  });

  it("a trade explains the step it opens — never one settled before the opening reading", () => {
    const m = [mark(1000, 100, 60), mark(1600, 99.5, 50)];
    assert.equal(over(m, [], [1000], 0).unattributed, 0);
    assert.equal(over(m, [], [945], 0).unattributed, -0.5, "a trade before the opening reading is already in its cash");
    assert.equal(over(m, [], [1600], 0).unattributed, -0.5, "a trade AT the closing mark is the next step's");
  });

  it("a known restart inside the run is judged even when its gap is short", () => {
    // A crash that kept the ledger, back within one tick: $50 deposited meanwhile, booked by nobody.
    const m = [mark(0, 100, 60), mark(60, 100, 60), mark(120, 100, 60), mark(180, 150, 110), mark(240, 150, 110)];
    const cum = attributeBook(m, [], [], undefined, undefined, [150]);
    assert.equal(cum[4]!.unattributed, 50);
    assert.equal(attributeBook(m, [], [])[4]!.unattributed, 0, "without the known restart the step reads as continuous");
  });

  it("a flow at the opening mark is already inside it; one at the closing mark belongs to the step", () => {
    const d = [mark(100, 100, 60), mark(160, 110, 70)];
    assert.equal(over(d, [{ at: 100, signed: 10, evidenced: true }], [], 0).unattributed, 10);
    assert.equal(over(d, [{ at: 160, signed: 10, evidenced: true }], [], 0).flows, 10);
  });

  it("an evidenced deposit and an unbooked one: the receipt counts, the rest is unattributed", () => {
    assert.deepEqual(over([mark(100, 100, 60), mark(900, 130, 90)], [{ at: 500, signed: 10, evidenced: true }], [], 0), { change: 30, flows: 10, unattributed: 20, trading: 0 });
  });

  it("within tolerance is rounding, not money", () => {
    assert.deepEqual(stepAttribution(mark(0, 10, 10), mark(1, 10.004, 10.004), [], false), { flows: 0, unattributed: 0 });
  });
});

describe("a continuous run", () => {
  // Marks a minute apart; only a step three times the usual spacing is a break.
  const run = (n: number, at0 = 0) => Array.from({ length: n }, (_, i) => at0 + i * 60);

  it("the break gap is three times the usual spacing, never under the floor", () => {
    assert.equal(breakGap(run(10).map((at) => mark(at, 1, 1))), Math.max(MIN_BREAK_SEC, 180));
    assert.equal(breakGap([mark(0, 1, 1), mark(10, 1, 1), mark(20, 1, 1)]), MIN_BREAK_SEC);
  });

  it("an order stamped before the mark its cash lands after is trading, not unexplained", () => {
    // Sale typed in Telegram during tick k (stamped 50), its $30 of profit
    // shows in the step after the next mark, which has no trade of its own.
    const m = [mark(0, 100, 50), mark(60, 100, 50), mark(120, 130, 130), mark(180, 130, 130)];
    assert.deepEqual(over(m, [], [50]), { change: 30, flows: 0, unattributed: 0, trading: 30 });
  });

  it("a deposit booked a tick before the balance shows it is money in, never split", () => {
    const m = [mark(0, 100, 60), mark(60, 100, 60), mark(120, 150, 110), mark(180, 150, 110)];
    assert.deepEqual(over(m, [{ at: 60, signed: 50, evidenced: true }], [90]), { change: 50, flows: 50, unattributed: 0, trading: 0 });
  });

  it("but a restart inside the run is still judged: a deposit made while down is unexplained", () => {
    const m = [...run(5).map((at) => mark(at, 100, 60)), mark(3000, 151, 110), mark(3060, 151, 110)];
    assert.deepEqual(over(m, [], []), { change: 51, flows: 0, unattributed: 51, trading: 0 });
  });

  it("the identity holds for any series: change = flows + unattributed + trading", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 50; n++) {
      const marks: BookMark[] = [];
      let at = 0;
      let cash = 100;
      for (let i = 0; i < 20; i++) {
        at += rnd() < 0.2 ? 1000 : 60;
        cash += rnd() < 0.3 ? Math.round((rnd() - 0.5) * 40) : 0;
        marks.push(mark(at, cash + rnd() * 20, cash));
      }
      const flows = Array.from({ length: 5 }, () => ({ at: Math.floor(rnd() * at), signed: Math.round((rnd() - 0.5) * 30), evidenced: rnd() < 0.5 }));
      const trades = Array.from({ length: 4 }, () => Math.floor(rnd() * at));
      const r = over(marks, flows, trades, undefined, Math.floor(rnd() * 10), 10 + Math.floor(rnd() * 10));
      assert.ok(Math.abs(r.change - r.flows - r.unattributed - r.trading) < 1e-5); // each part rounded to 1e-6
    }
  });
});

describe("accountSeries across a restart", () => {
  const carried = (at: number, equity: number, cash: number, flows = 0, unattributed = 0, book: AccountPoint["book"] = "live") => ({ at, equity, cash, flows, unattributed, book });
  const none = { paper: [], live: [] };

  it("joins the carried record to this ledger's, and a deposit made while down is unattributed", () => {
    const series = accountSeries({
      carried: [carried(1000, 100, 60), carried(2000, 102, 60)],
      carriedTail: [],
      local: [{ at: 5000, equity: 153, cash: 110, book: "live" }, { at: 5100, equity: 154, cash: 110, book: "live" }],
      localFlows: [],
      tradeTimes: none,
    });
    const pc = periodChange(series, 1500);
    assert.ok(pc.kind === "change");
    if (pc.kind !== "change") return;
    assert.equal(pc.open.at, 1000);
    assert.equal(pc.open.carried, true);
    assert.equal(pc.close.at, 5100);
    assert.deepEqual([pc.change, pc.flows, pc.unattributed, r6(pc.trading)], [54, 0, 51, 3]);
    assert.equal(pc.also, null);
  });

  it("the seam is judged even when this ledger's own run is continuous: a re-booked opening balance is dropped", () => {
    const series = accountSeries({
      carried: [carried(1000, 100, 60)],
      carriedTail: [],
      local: [{ at: 5000, equity: 101, cash: 60, book: "live" }],
      localFlows: [{ at: 4999, signed: 100, evidenced: false }],
      tradeTimes: none,
    });
    const pc = periodChange(series, 0);
    assert.ok(pc.kind === "change");
    if (pc.kind === "change") assert.deepEqual([pc.change, pc.flows, pc.unattributed, pc.trading], [1, 0, 0, 1]);
  });

  it("a trade already in the last carried reading does not excuse the seam: a deposit made while down stays unexplained", () => {
    const series = accountSeries({
      carried: [carried(1000, 100, 60)],
      carriedTail: [],
      local: [{ at: 5000, equity: 150, cash: 110, book: "live" }],
      localFlows: [],
      tradeTimes: { paper: [], live: [945] },
    });
    const pc = periodChange(series, 0);
    assert.ok(pc.kind === "change");
    if (pc.kind === "change") assert.deepEqual([pc.flows, pc.unattributed, pc.trading], [0, 50, 0]);
  });

  it("a trade the old run made just before shutting down explains the cash across the seam", () => {
    const series = accountSeries({
      carried: [carried(1000, 100, 60)],
      carriedTail: [],
      local: [{ at: 5000, equity: 99, cash: 40, book: "live" }],
      localFlows: [],
      tradeTimes: { paper: [], live: [1500] },
    });
    const pc = periodChange(series, 0);
    assert.ok(pc.kind === "change");
    if (pc.kind === "change") assert.deepEqual([pc.flows, pc.unattributed, pc.trading], [0, 0, -1]);
  });

  it("a deposit booked after the old run's last mark rides the tail into the seam", () => {
    const series = accountSeries({
      carried: [carried(1000, 100, 60, 5, 0)],
      carriedTail: [{ book: "live", evidenced: 20, unevidenced: 0 }],
      local: [{ at: 5000, equity: 120, cash: 80, book: "live" }],
      localFlows: [],
      tradeTimes: none,
    });
    const pc = periodChange(series, 0);
    assert.ok(pc.kind === "change");
    if (pc.kind === "change") assert.deepEqual([pc.change, pc.flows, pc.unattributed, pc.trading], [20, 20, 0, 0]);
  });

  it("a practice book takes no flows", () => {
    const series = accountSeries({
      carried: [],
      carriedTail: [],
      local: [
        { at: 100, equity: 1000, cash: 1000, book: "paper" },
        { at: 160, equity: 1010, cash: 1000, book: "paper" },
      ],
      localFlows: [{ at: 150, signed: 500, evidenced: true }],
      tradeTimes: none,
    });
    const pc = periodChange(series, 0);
    assert.ok(pc.kind === "change");
    if (pc.kind === "change") assert.deepEqual([pc.flows, pc.trading], [0, 10]);
  });

  it("the period opens in the book the account is in now, and says when the other was used too", () => {
    const series = accountSeries({
      carried: [carried(100, 1000, 1000, 0, 0, "paper"), carried(200, 40, 40)],
      carriedTail: [],
      local: [{ at: 5000, equity: 50, cash: 50, book: "live" }],
      localFlows: [],
      tradeTimes: none,
    });
    const pc = periodChange(series, 0);
    assert.ok(pc.kind === "change");
    if (pc.kind === "change") {
      assert.equal(pc.open.at, 200, "practice money is never compared with real money");
      assert.equal(pc.also, "paper");
    }
    const legacy = accountSeries({ carried: [], carriedTail: [], local: [{ at: 50, equity: 9, cash: 9, book: "unknown" }, { at: 5000, equity: 50, cash: 50, book: "live" }], localFlows: [], tradeTimes: none });
    const lp = periodChange(legacy, 0);
    assert.ok(lp.kind === "change" && lp.also === null, "a mark from before modes were recorded is not 'the other book'");
    assert.equal(periodChange([], 0).kind, "none");
  });
});
