import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PONS_BUY_TOPIC, PONS_SELL_TOPIC } from "./pons-activity";
import {
  MIN_TRADES_FOR_ACCELERATION,
  decodeTradeLog,
  readCurveTrades,
  trendingScore,
  windowFeatures,
  type PonsTrade,
  type TapeRead,
  type TradeLog,
} from "./pons-tape";

/**
 * THE TAPE WITH ITS NUMBERS LEFT ON.
 *
 * pons-activity.ts drops `blockNumber` and `data` at the parse boundary, which
 * is why the class route has one 15-minute count per curve and nothing else.
 * Everything a trending signal needs — windows, volume, imbalance, momentum,
 * new participants — comes from keeping those two fields. These tests pin
 * that the decode keeps them, that the windows are cut where the clock says,
 * and that a hole in the read is reported rather than smoothed over.
 */

const CURVE_A = "0x00000000000000000000000000000000000000a1";
const CURVE_B = "0x00000000000000000000000000000000000000b2";
const SPOOF = "0x00000000000000000000000000000000000000ee";
const who = (n: number) => `0x${"0".repeat(24)}${String(n).padStart(40, "0")}`;
const word = (n: bigint) => n.toString(16).padStart(64, "0");

const buyLog = (curve: string, trader: number, quoteIn: bigint, tokensOut: bigint, block: bigint): TradeLog => ({
  address: curve,
  topics: [PONS_BUY_TOPIC, who(trader)],
  data: `0x${word(quoteIn)}${word(tokensOut)}${word(1n)}${word(1n)}`,
  blockNumber: `0x${block.toString(16)}`,
  transactionHash: "0xabc",
});
const sellLog = (curve: string, trader: number, tokensIn: bigint, quoteOut: bigint, block: bigint): TradeLog => ({
  address: curve,
  topics: [PONS_SELL_TOPIC, who(trader)],
  data: `0x${word(tokensIn)}${word(quoteOut)}${word(1n)}${word(1n)}`,
  blockNumber: block,
  transactionHash: "0xdef",
});

describe("decoding a curve trade keeps what the old reader threw away", () => {
  it("a buy: quoteIn is word 0, tokensOut is word 1, block and trader travel", () => {
    const t = decodeTradeLog(buyLog(CURVE_A, 7, 5_000_000n, 123n, 100n));
    assert.deepEqual(t, {
      curve: CURVE_A,
      side: "buy",
      trader: who(7).replace(/^0x0{24}/, "0x"),
      quoteRaw: 5_000_000n,
      tokenRaw: 123n,
      block: 100n,
      tx: "0xabc",
    });
  });

  it("a sell: the words are swapped — tokensIn first, quoteOut second", () => {
    const t = decodeTradeLog(sellLog(CURVE_A, 7, 123n, 4_900_000n, 101n));
    assert.equal(t?.side, "sell");
    assert.equal(t?.quoteRaw, 4_900_000n);
    assert.equal(t?.tokenRaw, 123n);
  });

  it("a log that is not a trade, or is short a word, is skipped rather than zero-filled", () => {
    assert.equal(decodeTradeLog({ ...buyLog(CURVE_A, 1, 1n, 1n, 1n), topics: ["0x1234", who(1)] }), null);
    assert.equal(decodeTradeLog({ ...buyLog(CURVE_A, 1, 1n, 1n, 1n), data: `0x${word(5n)}` }), null);
    assert.equal(decodeTradeLog({ ...buyLog(CURVE_A, 1, 1n, 1n, 1n), blockNumber: null }), null);
  });
});

describe("the chunked read reports holes instead of nulling the tape", () => {
  const fake = (perChunk: (lo: bigint, hi: bigint) => TradeLog[] | Error) => ({
    async request(req: { params: [{ fromBlock: string; toBlock: string }] }) {
      const lo = BigInt(req.params[0].fromBlock);
      const hi = BigInt(req.params[0].toBlock);
      const r = perChunk(lo, hi);
      if (r instanceof Error) throw r;
      return r;
    },
  });

  it("covers the range in chunks and keeps every decoded trade", async () => {
    const seen: [bigint, bigint][] = [];
    const client = fake((lo, hi) => {
      seen.push([lo, hi]);
      return [buyLog(CURVE_A, 1, 1n, 1n, lo)];
    });
    const r = await readCurveTrades(client as never, { from: 0n, to: 9n }, 4n);
    assert.deepEqual(seen, [
      [0n, 3n],
      [4n, 7n],
      [8n, 9n],
    ]);
    assert.equal(r.trades.length, 3);
    assert.deepEqual(r.holes, []);
  });

  it("a chunk at the node's cap is a hole, and the other chunks still count", async () => {
    const client = fake((lo) => (lo === 4n ? Array.from({ length: 10_000 }, () => buyLog(CURVE_A, 1, 1n, 1n, lo)) : [buyLog(CURVE_A, 1, 1n, 1n, lo)]));
    const r = await readCurveTrades(client as never, { from: 0n, to: 9n }, 4n);
    assert.equal(r.trades.length, 2, "the capped chunk contributes nothing — a truncated count is a wrong count");
    assert.deepEqual(r.holes, [{ from: 4n, to: 7n, why: "capped" }]);
  });

  it("an RPC refusal is a hole with a different name", async () => {
    const client = fake((lo) => (lo === 8n ? new Error("boom") : []));
    const r = await readCurveTrades(client as never, { from: 0n, to: 9n }, 4n);
    assert.deepEqual(r.holes, [{ from: 8n, to: 9n, why: "rpc-error" }]);
  });
});

describe("windowed features", () => {
  // 10 blocks a second; head 3600 blocks in → windows of 300 / 900 / 3600 s
  // are the last 3,000 / 9,000 / 36,000 blocks.
  const HEAD = 100_000n;
  const SEC_PER_BLOCK = 0.1;
  const blocksAgo = (sec: number) => HEAD - BigInt(Math.round(sec / SEC_PER_BLOCK)) + 1n;
  const trade = (o: Partial<PonsTrade> & { block: bigint }): PonsTrade => ({
    curve: CURVE_A,
    side: "buy",
    trader: who(1),
    quoteRaw: 1_000_000n,
    tokenRaw: 1_000n,
    tx: "0x",
    ...o,
  });
  const tape = (trades: PonsTrade[], holes: TapeRead["holes"] = []): TapeRead => ({ trades, from: HEAD - 36_000n, to: HEAD, holes });
  const args = { head: HEAD, secPerBlock: SEC_PER_BLOCK, windowsSec: [300, 900, 3600], allow: new Set([CURVE_A, CURVE_B]) };

  it("cuts the three windows where the clock says, not where the tape happens to start", () => {
    const f = windowFeatures(
      tape([
        trade({ block: blocksAgo(3599) }), // in the hour only
        trade({ block: blocksAgo(899) }), // in 15m and the hour
        trade({ block: blocksAgo(299) }), // in all three
        trade({ block: blocksAgo(3601) }), // just outside the hour
      ]),
      args,
    ).get(CURVE_A)!;
    assert.deepEqual(
      f.windows.map((w) => [w.sec, w.trades]),
      [
        [300, 1],
        [900, 2],
        [3600, 3],
      ],
    );
  });

  it("volume, imbalance and momentum come from the data words, per window", () => {
    const f = windowFeatures(
      tape([
        trade({ block: blocksAgo(250), side: "buy", quoteRaw: 3_000_000n, tokenRaw: 1_000n }), // price 3000
        trade({ block: blocksAgo(200), side: "sell", quoteRaw: 1_000_000n, tokenRaw: 250n, trader: who(2) }), // price 4000
      ]),
      args,
    ).get(CURVE_A)!;
    const w = f.windows[0]!;
    assert.equal(w.buys, 1);
    assert.equal(w.sells, 1);
    assert.equal(w.quoteIn, 3_000_000n);
    assert.equal(w.quoteOut, 1_000_000n);
    assert.equal(w.volume, 4_000_000n);
    assert.equal(w.imbalanceCount, 0);
    assert.equal(w.imbalanceQuote, 0.5, "(3 − 1) / 4 of the quote went in");
    assert.equal(w.traders, 2);
    assert.ok(Math.abs(w.momentum! - (4000 / 3000 - 1)) < 1e-9, "last implied price over first, minus one");
    assert.equal(f.netQuoteFlow, 2_000_000n);
  });

  it("a trader is NEW to a window only if they had not traded this curve earlier in the tape", () => {
    const f = windowFeatures(
      tape([
        trade({ block: blocksAgo(2000), trader: who(1) }),
        trade({ block: blocksAgo(100), trader: who(1) }),
        trade({ block: blocksAgo(90), trader: who(2) }),
      ]),
      args,
    ).get(CURVE_A)!;
    assert.equal(f.windows[0]!.traders, 2);
    assert.equal(f.windows[0]!.newTraders, 1, "trader 1 was already here at 2000s; only trader 2 is new");
    assert.equal(f.windows[2]!.newTraders, 2, "over the whole hour both are new — nothing precedes them");
  });

  it("acceleration is the short rate over the long rate, and null on an empty hour", () => {
    // 6 trades in the last 5 min, 6 more spread over the earlier 55 min.
    const t: PonsTrade[] = [];
    for (let i = 0; i < 6; i++) t.push(trade({ block: blocksAgo(10 + i) }));
    for (let i = 0; i < 6; i++) t.push(trade({ block: blocksAgo(1000 + i * 400) }));
    const f = windowFeatures(tape(t), args).get(CURVE_A)!;
    // 6/5 per minute vs 12/60 per minute = 6x
    assert.ok(Math.abs(f.tradeAcceleration! - 6) < 1e-9);
    const quiet = windowFeatures(tape([trade({ block: blocksAgo(5000) })]), args);
    assert.equal(quiet.get(CURVE_A), undefined, "a curve with no trade in the hour has no features at all");
  });

  it("a hole overlapping a window marks it incomplete — the figures are a floor, not a count", () => {
    const f = windowFeatures(tape([trade({ block: blocksAgo(100) })], [{ from: blocksAgo(600), to: blocksAgo(500), why: "capped" }]), args).get(CURVE_A)!;
    assert.equal(f.windows[0]!.incomplete, false, "the hole is 500–600s back; 5m is clean");
    assert.equal(f.windows[1]!.incomplete, true);
    assert.equal(f.windows[2]!.incomplete, true);
  });

  it("ONLY FACTORY CURVES COUNT — an emitter outside the allow-list is dropped whole", () => {
    // The query has no address filter, so any contract emitting topic0 lands
    // in the tape. pons-price.ts names this as the spoofing route.
    const f = windowFeatures(tape([trade({ block: blocksAgo(10), curve: SPOOF }), trade({ block: blocksAgo(10), curve: CURVE_B })]), args);
    assert.equal(f.has(SPOOF), false);
    assert.equal(f.has(CURVE_B), true);
  });
});

describe("the trending score wants acceleration on a baseline, not a ratio on nothing", () => {
  const trend = (n5: number, n15: number, n60: number, traders5 = 3) => {
    const w = (sec: number, trades: number) => ({
      sec,
      trades,
      buys: trades,
      sells: 0,
      traders: traders5,
      newTraders: 0,
      quoteIn: 0n,
      quoteOut: 0n,
      volume: 0n,
      imbalanceCount: trades ? 1 : null,
      imbalanceQuote: null,
      tradesPerMin: trades / (sec / 60),
      quotePerMin: 0,
      firstPrice: null,
      lastPrice: null,
      momentum: null,
      incomplete: false,
    });
    const windows = [w(300, n5), w(900, n15), w(3600, n60)];
    return {
      curve: CURVE_A,
      windows,
      tradeAcceleration: windows[2]!.tradesPerMin > 0 ? windows[0]!.tradesPerMin / windows[2]!.tradesPerMin : null,
      volumeAcceleration: null,
      netQuoteFlow: 0n,
      firstBlock: 0n,
      lastBlock: 0n,
    };
  };

  it("two trades in two minutes is not a 12x acceleration", () => {
    // Measured on the live tape: a two-minute-old launch with one wash round
    // trip ranked first on a 12x ratio over an hour that held those same two
    // trades. Below the floor the ratio is carried but does not multiply.
    const tiny = trend(2, 2, 2);
    assert.ok(tiny.tradeAcceleration! > 10, "the ratio itself is what it is");
    const baseline = trend(2, 2, MIN_TRADES_FOR_ACCELERATION); // same 5m, a real hour
    assert.ok(trendingScore(tiny) < trendingScore(trend(20, 40, 60)), "a genuinely busy curve outranks it");
    assert.ok(baseline.tradeAcceleration! < tiny.tradeAcceleration!);
  });

  it("above the floor, the busier last five minutes wins over the same hour", () => {
    assert.ok(trendingScore(trend(10, 20, 30)) > trendingScore(trend(2, 20, 30)));
  });
});
