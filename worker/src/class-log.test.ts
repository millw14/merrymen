/**
 * THE CHAIN IS THE BOOK. A rebuilt child must not read as flat.
 *
 * `class_positions` lives in the child's sqlite, which the orchestrator wipes
 * on every redeploy. Before this module, an open class position's entire record
 * could vanish while the tokens sat in the vault — and the worker would read
 * the empty table as "nothing held". A missing row meant flat, which for money
 * is the worst possible default.
 *
 * These tests pin the reconstruction: the events say what happened, the balance
 * says what is there, and neither is invented when a read fails.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLASS_BUY_TOPIC,
  CLASS_SELL_TOPIC,
  CLASS_SWEPT_TOPIC,
  foldClassEvents,
  parseClassLogs,
  readClassLog,
} from "./venues/class-log";

const CURVE = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const VAULT = "0x3333333333333333333333333333333333333333" as const;

const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
const w = (v: bigint) => v.toString(16).padStart(64, "0");

const buy = (quoteIn: bigint, tokensOut: bigint, block: bigint, tx: string, idx = 0) => ({
  topics: [CLASS_BUY_TOPIC, topic(CURVE), topic(TOKEN)],
  data: `0x${w(quoteIn)}${w(tokensOut)}`,
  blockNumber: block,
  transactionHash: tx,
  logIndex: idx,
});
const sell = (tokensIn: bigint, quoteOut: bigint, block: bigint, tx: string, idx = 0) => ({
  topics: [CLASS_SELL_TOPIC, topic(CURVE), topic(TOKEN)],
  data: `0x${w(tokensIn)}${w(quoteOut)}`,
  blockNumber: block,
  transactionHash: tx,
  logIndex: idx,
});
const swept = (amount: bigint, block: bigint, tx: string, idx = 0) => ({
  topics: [CLASS_SWEPT_TOPIC, topic(TOKEN)],
  data: `0x${w(amount)}`,
  blockNumber: block,
  transactionHash: tx,
  logIndex: idx,
});

describe("the tape is parsed without inventing anything", () => {
  it("reads a buy's ACTUAL cost and ACTUAL tokens, not the proposed size", () => {
    // 4.87 USDG actually spent against a 5.00 request. The proposal is a
    // request; the event is the fill, and only the fill is a cost.
    const [e] = parseClassLogs([buy(4_870_000n, 410_609_930_000_000_000_000_000n, 100n, "0xaa")]);
    assert.equal(e!.kind, "buy");
    assert.equal(e!.quoteRaw, 4_870_000n);
    assert.equal(e!.tokenRaw, 410_609_930_000_000_000_000_000n);
    assert.equal(e!.token, TOKEN);
    assert.equal(e!.curve, CURVE);
  });

  it("does NOT transpose a sell's legs, whose order is reversed", () => {
    // ClassBuy is (quoteIn, tokensOut); ClassSell is (tokensIn, quoteOut). Get
    // this wrong once and a memecoin count is booked as USDG.
    const [e] = parseClassLogs([sell(410_609_930_000_000_000_000_000n, 4_760_000n, 200n, "0xbb")]);
    assert.equal(e!.kind, "sell");
    assert.equal(e!.tokenRaw, 410_609_930_000_000_000_000_000n, "tokens sold");
    assert.equal(e!.quoteRaw, 4_760_000n, "USDG returned");
  });

  it("reads a sweep, which names no curve and moves no quote", () => {
    const [e] = parseClassLogs([swept(999n, 300n, "0xcc")]);
    assert.equal(e!.kind, "swept");
    assert.equal(e!.curve, null);
    assert.equal(e!.quoteRaw, 0n);
    assert.equal(e!.tokenRaw, 999n);
  });

  it("SKIPS malformed logs rather than defaulting them", () => {
    // A zero cost invented for a truncated buy would hand the scout budget a
    // free position and the P&L an infinite return.
    const short = { ...buy(1n, 1n, 1n, "0xdd"), data: "0x1234" };
    const noBlock = { ...buy(1n, 1n, 1n, "0xee"), blockNumber: null };
    const noTx = { ...buy(1n, 1n, 1n, "0xff"), transactionHash: null };
    const noIdx = { ...buy(1n, 1n, 1n, "0x11"), logIndex: null };
    assert.deepEqual(parseClassLogs([short, noBlock, noTx, noIdx]), []);
  });

  it("ignores logs that are not ours", () => {
    const alien = { ...buy(1n, 1n, 1n, "0x22"), topics: ["0x" + "9".repeat(64), topic(CURVE), topic(TOKEN)] };
    assert.deepEqual(parseClassLogs([alien]), []);
  });

  it("returns chain order regardless of input order, so a replay folds identically", () => {
    const out = parseClassLogs([
      sell(5n, 5n, 300n, "0xb", 1),
      buy(1n, 1n, 100n, "0xa", 2),
      swept(2n, 300n, "0xb", 0),
    ]);
    assert.deepEqual(
      out.map((e) => `${e.blockNumber}:${e.logIndex}`),
      ["100:2", "300:0", "300:1"],
    );
  });
});

describe("folding reconstructs a position", () => {
  it("sums actual cost and tokens across several buys", () => {
    const folded = foldClassEvents(
      parseClassLogs([buy(4_870_000n, 400n, 100n, "0xa"), buy(2_000_000n, 150n, 150n, "0xb")]),
    );
    const e = folded.get(TOKEN)!;
    assert.equal(e.costRaw, 6_870_000n);
    assert.equal(e.boughtRaw, 550n);
  });

  it("starts the hold clock at the FIRST buy and never moves it", () => {
    // A top-up must not rejuvenate a position past its own exit window — the
    // same rule upsertClassPosition keeps by refusing a caller-supplied clock.
    const folded = foldClassEvents(
      parseClassLogs([buy(1n, 100n, 100n, "0xfirst"), buy(1n, 100n, 900n, "0xlater")]),
    );
    const e = folded.get(TOKEN)!;
    assert.equal(e.openedAtBlock, 100n);
    assert.equal(e.entryTx, "0xfirst");
  });

  it("records proceeds and the exit transaction on a sell", () => {
    const folded = foldClassEvents(
      parseClassLogs([buy(5_000_000n, 400n, 100n, "0xin"), sell(400n, 4_760_000n, 200n, "0xout")]),
    );
    const e = folded.get(TOKEN)!;
    assert.equal(e.soldRaw, 400n);
    assert.equal(e.proceedsRaw, 4_760_000n);
    assert.equal(e.exitTx, "0xout");
    // Realised: 4.76 back on 5.00 spent. The arithmetic is the caller's, but
    // both terms must be here for it to be possible at all.
    assert.equal(e.costRaw, 5_000_000n);
  });

  it("counts a SWEEP as tokens leaving, without inventing proceeds", () => {
    // The owner's own exit returns no quote. Booking one would manufacture a
    // gain out of a recovery.
    const folded = foldClassEvents(parseClassLogs([buy(5_000_000n, 400n, 100n, "0xin"), swept(400n, 300n, "0xsw")]));
    const e = folded.get(TOKEN)!;
    assert.equal(e.sweptRaw, 400n);
    assert.equal(e.proceedsRaw, 0n);
    assert.equal(e.exitTx, null, "a sweep is not a curve exit");
  });

  it("gives every event a stable identity, so an accrual can be deduped", () => {
    // (txHash, logIndex) is unique on chain and survives a restart. A UserOp
    // hash would not: one op can carry several calls.
    const folded = foldClassEvents(parseClassLogs([buy(1n, 1n, 100n, "0xa", 3), sell(1n, 1n, 200n, "0xb", 7)]));
    assert.deepEqual(folded.get(TOKEN)!.logKeys, ["0xa:3", "0xb:7"]);
  });

  it("folding the SAME tape twice yields the same totals", () => {
    // Reconciliation replays ranges by design. If a fold were order- or
    // repetition-sensitive, every restart would move the basis.
    const logs = [buy(4_870_000n, 400n, 100n, "0xa"), sell(100n, 1_200_000n, 200n, "0xb")];
    const a = foldClassEvents(parseClassLogs(logs));
    const b = foldClassEvents(parseClassLogs([...logs].reverse()));
    assert.equal(a.get(TOKEN)!.costRaw, b.get(TOKEN)!.costRaw);
    assert.equal(a.get(TOKEN)!.boughtRaw, b.get(TOKEN)!.boughtRaw);
    assert.equal(a.get(TOKEN)!.openedAtBlock, b.get(TOKEN)!.openedAtBlock);
  });
});

describe("a refused scan is not an empty vault", () => {
  it("reports failed when any window is refused", async () => {
    // An empty result from a query that did not answer would close every open
    // position. This is the difference between "nothing happened" and "we
    // could not ask", and it must reach the caller.
    const client = {
      request: async () => {
        throw new Error("node refused the range");
      },
    };
    const out = await readClassLog(client as never, VAULT, 0n, 10n, 5n);
    assert.equal(out.failed, true);
    assert.deepEqual(out.events, []);
  });

  it("reports success and the events when every window answers", async () => {
    const client = {
      request: async () => [
        { topics: [CLASS_BUY_TOPIC, topic(CURVE), topic(TOKEN)], data: `0x${w(7n)}${w(8n)}`, blockNumber: "0x1", transactionHash: "0xaa", logIndex: "0x0" },
      ],
    };
    const out = await readClassLog(client as never, VAULT, 0n, 4n, 5n);
    assert.equal(out.failed, false);
    assert.equal(out.events.length, 1);
    assert.equal(out.events[0]!.quoteRaw, 7n);
  });

  it("keeps partial events AND the failure flag when only some windows answer", async () => {
    let call = 0;
    const client = {
      request: async () => {
        call += 1;
        if (call === 2) throw new Error("refused");
        return [
          { topics: [CLASS_BUY_TOPIC, topic(CURVE), topic(TOKEN)], data: `0x${w(1n)}${w(1n)}`, blockNumber: "0x1", transactionHash: "0xaa", logIndex: "0x0" },
        ];
      },
    };
    const out = await readClassLog(client as never, VAULT, 0n, 9n, 5n);
    assert.equal(out.failed, true, "one refused window makes the whole scan incomplete");
    assert.ok(out.events.length > 0, "what was read is still returned, but flagged");
  });
});
