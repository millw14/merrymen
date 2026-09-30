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
import { toEventSelector } from "viem";

import {
  CLASS_BUY_TOPIC,
  CLASS_BUY_TOPIC_V2,
  CLASS_SELL_TOPIC,
  CLASS_SELL_TOPIC_V2,
  CLASS_SWEPT_TOPIC,
  decodeClassLog,
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
const QUOTE = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // USDG, the only one so far
/** A v2 log: the same two data words, plus the quote asset as a third topic. */
const buyV2 = (quoteIn: bigint, tokensOut: bigint, block: bigint, tx: string, idx = 0, quote = QUOTE) => ({
  topics: [CLASS_BUY_TOPIC_V2, topic(CURVE), topic(TOKEN), topic(quote)],
  data: `0x${w(quoteIn)}${w(tokensOut)}`,
  blockNumber: block,
  transactionHash: tx,
  logIndex: idx,
});
const sellV2 = (tokensIn: bigint, quoteOut: bigint, block: bigint, tx: string, idx = 0, quote = QUOTE) => ({
  topics: [CLASS_SELL_TOPIC_V2, topic(CURVE), topic(TOKEN), topic(quote)],
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

describe("two vault versions speak on the same tape", () => {
  /**
   * THE GUARD THAT WOULD HAVE CAUGHT THE DEFECT THIS SUITE WAS EXTENDED FOR.
   *
   * The topics were pasted hex. PonsClassVaultV2 added the quote asset as a
   * third indexed argument, which changes the hash — and a reader that knows
   * only v1's does not error on a v2 trade. `decodeClassLog` returns null,
   * `parseClassLogs` skips it, and the tape comes back COMPLETE AND EMPTY.
   * Pinning each constant to `toEventSelector` of the signature in its own
   * docstring turns that into a diff in a readable string.
   */
  it("every topic is the hash of the signature beside it, and the two versions differ", () => {
    assert.equal(CLASS_BUY_TOPIC, toEventSelector("ClassBuy(address,address,uint256,uint256)"));
    assert.equal(CLASS_SELL_TOPIC, toEventSelector("ClassSell(address,address,uint256,uint256)"));
    assert.equal(CLASS_BUY_TOPIC_V2, toEventSelector("ClassBuy(address,address,address,uint256,uint256)"));
    assert.equal(CLASS_SELL_TOPIC_V2, toEventSelector("ClassSell(address,address,address,uint256,uint256)"));
    assert.equal(CLASS_SWEPT_TOPIC, toEventSelector("Swept(address,uint256)"));
    assert.notEqual(CLASS_BUY_TOPIC, CLASS_BUY_TOPIC_V2, "a v2 buy is a different topic");
    assert.notEqual(CLASS_SELL_TOPIC, CLASS_SELL_TOPIC_V2, "a v2 sell is a different topic");
  });

  it("a v2 buy decodes, and it names what it was funded in", () => {
    const [e] = parseClassLogs([buyV2(5_000_000n, 1_000n * 10n ** 18n, 100n, "0xaa")]);
    assert.equal(e!.kind, "buy", "a v2 buy must not be skipped");
    assert.equal(e!.curve!.toLowerCase(), CURVE.toLowerCase());
    assert.equal(e!.token.toLowerCase(), TOKEN.toLowerCase());
    assert.equal(e!.quoteRaw, 5_000_000n);
    assert.equal(e!.tokenRaw, 1_000n * 10n ** 18n);
    assert.equal(e!.quoteAsset, QUOTE.toLowerCase(), "the one fact v2 added must survive the decode");
  });

  it("a v2 sell is not decoded as a buy, which would read a token count as USDG", () => {
    // The dispatch and the buy/sell test are the same comparison. Widening only
    // the first would classify every v2 sell as a buy AND transpose its words.
    const [e] = parseClassLogs([sellV2(7n * 10n ** 18n, 4_900_000n, 101n, "0xbb")]);
    assert.equal(e!.kind, "sell", "a v2 sell must not arrive as a buy");
    assert.equal(e!.tokenRaw, 7n * 10n ** 18n, "tokens in");
    assert.equal(e!.quoteRaw, 4_900_000n, "quote out");
    assert.equal(e!.quoteAsset, QUOTE.toLowerCase());
  });

  it("a v1 log STILL decodes — the mainnet vault is deployed and may hold a position", () => {
    // The regression guard. v1's topics must be added to, never replaced.
    const [e] = parseClassLogs([buy(4_870_000n, 410_609_930_000_000_000_000_000n, 100n, "0xcc")]);
    assert.equal(e!.kind, "buy");
    assert.equal(e!.quoteRaw, 4_870_000n);
    assert.equal(
      e!.quoteAsset,
      null,
      "v1's log does not name the asset, and null must mean UNKNOWN rather than USDG",
    );
  });

  it("a v2 log with only three topics is refused, not read with the words shifted", () => {
    // A truncated v2 log has the v2 topic0 and v1's topic count. Reading
    // topics[3] off the end would produce an address from undefined.
    const truncated = { topics: [CLASS_BUY_TOPIC_V2, topic(CURVE), topic(TOKEN)], data: `0x${w(1n)}${w(2n)}` };
    assert.equal(decodeClassLog(truncated), null);
  });

  it("a sweep carries no denomination in either version, and says so as null", () => {
    const [e] = parseClassLogs([swept(9n, 102n, "0xdd")]);
    assert.equal(e!.kind, "swept");
    assert.equal(e!.quoteAsset, null, "a sweep moves no quote, so there is nothing to name");
  });
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

  it("A LOG WE COULD NOT PARSE IS NOT AN ABSENT LOG — the third answer", async () => {
    // `failed` only ever meant "the RPC refused", so a log the vault really did
    // emit and this code could not decode was dropped in silence and the scan
    // reported COMPLETE. That is what made the v2 topic change invisible: a
    // whole trading history reading as an agent that never traded.
    //
    // The filter is address-only, so every log counted here came from this
    // vault. A non-zero count means exactly one thing: this vault speaks a
    // dialect we do not parse.
    const client = {
      request: async () => [
        { topics: ["0xdeadbeef00000000000000000000000000000000000000000000000000000000", topic(TOKEN)], data: "0x", blockNumber: "0x1", transactionHash: "0xaa", logIndex: "0x0" },
      ],
    };
    const out = await readClassLog(client as never, VAULT, 0n, 4n, 5n);
    assert.equal(out.events.length, 0);
    assert.equal(out.failed, false, "the node answered — this is not a read failure");
    assert.equal(out.unreadable, 1, "and it must not read as an empty history");
  });

  it("a clean scan reports zero unreadable, so the count is a signal and not noise", async () => {
    const client = {
      request: async () => [
        { topics: [CLASS_BUY_TOPIC, topic(CURVE), topic(TOKEN)], data: `0x${w(1n)}${w(2n)}`, blockNumber: "0x1", transactionHash: "0xaa", logIndex: "0x0" },
      ],
    };
    const out = await readClassLog(client as never, VAULT, 0n, 4n, 5n);
    assert.equal(out.unreadable, 0);
    assert.equal(out.events.length, 1);
  });

  it("a v2 log is readable now, which is the whole point of counting the ones that are not", async () => {
    const client = {
      request: async () => [
        { topics: [CLASS_BUY_TOPIC_V2, topic(CURVE), topic(TOKEN), topic(QUOTE)], data: `0x${w(5n)}${w(6n)}`, blockNumber: "0x1", transactionHash: "0xaa", logIndex: "0x0" },
      ],
    };
    const out = await readClassLog(client as never, VAULT, 0n, 4n, 5n);
    assert.equal(out.unreadable, 0);
    assert.equal(out.events[0]!.quoteAsset, QUOTE.toLowerCase());
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

/**
 * THE LEDGER MUST REFUSE TO ADD TWO DENOMINATIONS, NOT ADD THEM WRONGLY.
 *
 * There was no test anywhere in this repo asserting it, because until
 * PonsClassVaultV2 there was no way for the book to know: v1's events name an
 * amount and not the asset it is in, so two denominations were indistinguishable
 * from one. Naming the asset on the event is what makes the refusal possible,
 * and this is the refusal.
 *
 * IT CANNOT FIRE UNDER TODAY'S PRODUCER, which funds every class entry in USDG
 * and refuses any candidate quoted in anything else. That is what makes it cheap
 * to carry now — and it is what makes the multi-quote deferral honest rather
 * than merely postponed. The day that filter is lifted, the ledger says so
 * instead of quietly booking a cost off by a factor of about a trillion.
 */
describe("the book will not add two denominations", () => {
  const OTHER = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"; // an 18dp share

  it("one denomination is the ordinary case and is recorded, not merely tolerated", () => {
    const folded = foldClassEvents(parseClassLogs([
      buyV2(5_000_000n, 1_000n * 10n ** 18n, 100n, "0xaa"),
      buyV2(3_000_000n, 500n * 10n ** 18n, 101n, "0xbb"),
    ]));
    const e = folded.get(TOKEN.toLowerCase())!;
    assert.deepEqual(e.quoteAssets, [QUOTE.toLowerCase()]);
    assert.equal(e.mixedDenomination, false);
    assert.equal(e.costRaw, 8_000_000n, "same asset, so the sum is a number");
  });

  it("TWO denominations are FLAGGED, because costRaw stops being a number", () => {
    // 5 USDG at 6dp plus 0.1 of an 18dp share sums to 100000000000000005000000,
    // which is not a cost, not a quantity, and not anything a price line can
    // divide. The flag is what lets a reader refuse it.
    const folded = foldClassEvents(parseClassLogs([
      buyV2(5_000_000n, 1_000n * 10n ** 18n, 100n, "0xaa"),
      buyV2(10n ** 17n, 500n * 10n ** 18n, 101n, "0xbb", 0, OTHER),
    ]));
    const e = folded.get(TOKEN.toLowerCase())!;
    assert.equal(e.mixedDenomination, true, "the book must know it cannot price this");
    assert.equal(e.quoteAssets.length, 2);
    assert.ok(e.quoteAssets.includes(QUOTE.toLowerCase()));
    assert.ok(e.quoteAssets.includes(OTHER.toLowerCase()));
  });

  it("a v1 position names nothing, and that is UNKNOWN rather than mixed", () => {
    // The regression guard for the deployed vault. Every v1 log is silent about
    // the asset, and silence must not read as a second denomination — that
    // would flag every existing position on mainnet.
    const folded = foldClassEvents(parseClassLogs([
      buy(4_870_000n, 400n, 100n, "0xaa"),
      buy(1_000_000n, 100n, 101n, "0xbb"),
    ]));
    const e = folded.get(TOKEN.toLowerCase())!;
    assert.deepEqual(e.quoteAssets, [], "a v1 log says nothing about the asset");
    assert.equal(e.mixedDenomination, false, "and saying nothing is not saying two things");
    assert.equal(e.costRaw, 5_870_000n, "so the existing fold is untouched");
  });

  it("a SWEEP moves no quote, so it must not contribute a denomination", () => {
    // Swept carries the class token in `token` and no quote at all. Counting it
    // would flag every position that was ever swept.
    const folded = foldClassEvents(parseClassLogs([
      buyV2(5_000_000n, 1_000n * 10n ** 18n, 100n, "0xaa"),
      swept(1_000n * 10n ** 18n, 102n, "0xcc"),
    ]));
    const e = folded.get(TOKEN.toLowerCase())!;
    assert.equal(e.mixedDenomination, false);
    assert.deepEqual(e.quoteAssets, [QUOTE.toLowerCase()]);
  });

  it("a SELL in a different asset than the buy is mixed too — proceeds are a cost's mirror", () => {
    // Realised P&L subtracts one from the other, so a sell in a second asset is
    // exactly as unprintable as a buy in one.
    const folded = foldClassEvents(parseClassLogs([
      buyV2(5_000_000n, 1_000n * 10n ** 18n, 100n, "0xaa"),
      sellV2(1_000n * 10n ** 18n, 10n ** 17n, 101n, "0xbb", 0, OTHER),
    ]));
    assert.equal(folded.get(TOKEN.toLowerCase())!.mixedDenomination, true);
  });
});
