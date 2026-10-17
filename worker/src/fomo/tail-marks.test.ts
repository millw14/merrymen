import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dueHorizons, leaderboardLines, movePct, rowToMark, tallyMarks, toPrice8, type TailCallMark } from "./tail-marks.js";

const H = 60 * 60_000;

const mark = (over: Partial<TailCallMark> = {}): TailCallMark => ({
  eventKey: "ev1",
  traderUserId: "u1",
  handle: "unipcs",
  tokenKey: "solana:1399811149:Mint11111111111111111111111111111111111111111",
  entryPriceUsd: 0.05,
  entryAtMs: 1_000_000,
  ...over,
});

describe("dueHorizons", () => {
  it("nothing due before an hour", () => {
    assert.deepEqual(dueHorizons(mark(), 1_000_000 + H - 1), []);
  });
  it("h1 due at an hour, h24 at a day", () => {
    assert.deepEqual(dueHorizons(mark(), 1_000_000 + H), ["h1"]);
    assert.deepEqual(dueHorizons(mark(), 1_000_000 + 24 * H), ["h1", "h24"]);
  });
  it("a taken horizon is never due again", () => {
    assert.deepEqual(dueHorizons(mark({ h1PriceUsd: 0.06, h1AtMs: 1_000_000 + H }), 1_000_000 + 24 * H), ["h24"]);
  });
});

describe("movePct", () => {
  it("doubles read +100", () => assert.equal(movePct(0.05, 0.1), 100));
  it("halves read −50", () => assert.equal(movePct(0.05, 0.025), -50));
  it("missing ends read null, never zero", () => {
    assert.equal(movePct(0.05, null), null);
    assert.equal(movePct(0.05, undefined), null);
    assert.equal(movePct(0, 0.1), null);
    assert.equal(movePct(-1, 0.1), null);
  });
});

describe("tallyMarks", () => {
  it("averages settled horizons and counts unsettled calls", () => {
    const rows = tallyMarks([
      mark({ eventKey: "a", h1PriceUsd: 0.1, h24PriceUsd: 0.025 }),
      mark({ eventKey: "b", h1PriceUsd: 0.05 }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.calls, 2);
    assert.equal(rows[0]!.settledH1, 2);
    assert.equal(rows[0]!.settledH24, 1);
    assert.equal(rows[0]!.avgH1Pct, 50);
    assert.equal(rows[0]!.avgH24Pct, -50);
    assert.equal(rows[0]!.hitRateH1, 0.5);
  });
  it("splits traders and keeps the latest handle", () => {
    const rows = tallyMarks([mark({ traderUserId: "u2", handle: "old" }), mark({ traderUserId: "u2", handle: "new", eventKey: "c" })]);
    assert.equal(rows[0]!.handle, "new");
  });
});

describe("leaderboardLines", () => {
  it("says the sample size every time", () => {
    const lines = leaderboardLines(tallyMarks([mark({ h1PriceUsd: 0.1 })]));
    assert.match(lines[0]!, /@unipcs/);
    assert.match(lines[0]!, /1 call tailed/);
    assert.match(lines[0]!, /\+100\.0%/);
    assert.match(lines[0]!, /1 settled/);
  });
  it("unsettled traders read n/a, not zero", () => {
    const lines = leaderboardLines(tallyMarks([mark()]));
    assert.match(lines[0]!, /n\/a/);
  });
});

describe("toPrice8", () => {
  it("keeps 8dp shape", () => {
    assert.equal(toPrice8(0.05), "0.05000000");
    assert.equal(toPrice8(123.456), "123.45600000");
  });
  it("refuses the unmeasurable, never zeroes it", () => {
    assert.equal(toPrice8(0), null);
    assert.equal(toPrice8(-1), null);
    assert.equal(toPrice8(NaN), null);
    assert.equal(toPrice8(1e-9), null, "dust rounds to zero, so it is unmeasurable");
    assert.equal(toPrice8("0.05" as never), null);
  });
});

describe("rowToMark", () => {
  it("drops unmeasurable rows", () => {
    const row = { eventKey: "a", traderUserId: "u", handle: null, tokenKey: "k", entryPrice8: "0.05000000", entryAtMs: 1, h1Price8: "0.10000000", h1AtMs: 2, h24Price8: null, h24AtMs: null };
    assert.equal(rowToMark(row)?.entryPriceUsd, 0.05);
    assert.equal(rowToMark({ ...row, entryPrice8: "oops" }), null);
  });
});
