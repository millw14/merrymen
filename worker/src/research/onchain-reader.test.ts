/**
 * THE PROOF THAT THE RECONSTRUCTION KNOWS WHEN IT IS WRONG.
 *
 * The reader's whole claim is that balances rebuilt from Transfer logs are
 * EXACT when the window reaches the mint and USELESS when it does not, and that
 * it can tell the two apart without an indexer. Every test below is about that
 * boundary rather than about arithmetic: a scan that quietly returned net flow
 * as "holders" would pass an arithmetic test and hand an analyst a confident
 * number about the wrong quantity.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Hex } from "viem";
import type { RawLog, ReconcileChain } from "../inflight-reconcile";
import { TRANSFER_TOPIC } from "../deposit-log";
import { blocksFor, scanToken, type OnchainSource } from "./onchain-reader";

const TOKEN = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const CURVE = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";
const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const topic = (a: string) => `0x${"0".repeat(24)}${a.replace(/^0x/, "").toLowerCase()}` as Hex;
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}` as Hex;

const xfer = (from: string, to: string, value: bigint, block: number): RawLog => ({
  topics: [TRANSFER_TOPIC, topic(from), topic(to)],
  data: word(value),
  transactionHash: `0x${block.toString(16).padStart(64, "0")}` as Hex,
  blockNumber: `0x${block.toString(16)}` as Hex,
  logIndex: "0x0",
});

/** A chain that serves a fixed log list, and can be told to fail the sweep. */
const chainOf = (logs: RawLog[], fail = false): ReconcileChain => ({
  getBlockNumber: async () => 1_000n,
  async getLogs(a) {
    if (fail) throw new Error("execution reverted: nope");
    return logs.filter((l) => {
      // A real provider returns whatever it has; a log with no block number is
      // the reader's problem to refuse, not the fake's to throw over.
      if (!l.blockNumber) return true;
      const b = BigInt(l.blockNumber);
      return b >= a.fromBlock && b <= a.toBlock;
    });
  },
  getReceiptLogs: async () => null,
});

const src = (logs: RawLog[], supply: bigint | null, fail = false): OnchainSource => ({
  chain: chainOf(logs, fail),
  totalSupply: async () => supply,
});

const scan = (logs: RawLog[], supply: bigint | null, extra: { fail?: boolean; venues?: string[] } = {}) =>
  scanToken(src(logs, supply, extra.fail), {
    token: TOKEN,
    head: 1_000n,
    windowBlocks: 1_000n,
    venues: extra.venues ?? [CURVE],
  });

describe("the completeness proof", () => {
  it("A WINDOW THAT REACHES THE MINT IS EXACT", async () => {
    const s = await scan([xfer(ZERO, at(1), 1_000n, 10), xfer(at(1), at(2), 400n, 20)], 1_000n);
    assert.equal(s.wholeHistory, true);
    assert.equal(s.why, null);
    const bal = new Map(s.holders.map((h) => [h.address, h.raw]));
    assert.equal(bal.get(at(1)), 600n);
    assert.equal(bal.get(at(2)), 400n);
  });

  it("AND A NEGATIVE BALANCE IS A RECEIPT FOR A MISSING WINDOW", async () => {
    // The mint is older than the window. Address 1 spends 400 we never saw
    // arrive, which is proof — not a hint — that we started watching too late.
    const s = await scan([xfer(at(1), at(2), 400n, 20)], 1_000n);
    assert.equal(s.wholeHistory, false);
    assert.match(s.why!, /spent more than we saw arrive/);
  });

  it("and a supply that will not read refuses rather than assuming", async () => {
    const s = await scan([xfer(ZERO, at(1), 1_000n, 10)], null);
    assert.equal(s.wholeHistory, false);
    assert.match(s.why!, /total supply could not be read/);
  });

  it("AND A SUPPLY MISMATCH IS READ BY ITS DIRECTION, not as one failure", async () => {
    // More counted than exists: supply left without a Transfer. Scanning
    // further back would never fix it, so saying "minted before this window"
    // would send an operator widening a window forever.
    const heavy = await scan([xfer(ZERO, at(1), 1_000n, 10)], 900n);
    assert.equal(heavy.wholeHistory, false);
    assert.match(heavy.why!, /does not conserve on transfer/);

    // Less counted than exists, with nobody negative: a mint we never saw,
    // whose tokens have not moved since. That one IS fixable by scanning back.
    const light = await scan([xfer(ZERO, at(1), 1_000n, 10)], 1_500n);
    assert.equal(light.wholeHistory, false);
    assert.match(light.why!, /minted before this window/);
  });

  it("AND A SWEEP THAT DID NOT FINISH IS NEVER COMPLETE, whatever the sums say", async () => {
    const s = await scan([xfer(ZERO, at(1), 1_000n, 10)], 1_000n, { fail: true });
    assert.equal(s.scanned, false);
    assert.equal(s.wholeHistory, false);
    assert.match(s.why!, /did not finish/);
  });

  it("and a burn is excluded supply, not a holder", async () => {
    const s = await scan(
      [xfer(ZERO, at(1), 1_000n, 10), xfer(at(1), "0x000000000000000000000000000000000000dEaD", 600n, 20)],
      400n,
    );
    assert.equal(s.wholeHistory, true, "supply net of the burn still reconciles");
    assert.equal(s.holders.length, 1);
  });
});

describe("what makes a transfer a trade", () => {
  it("EXACTLY ONE SIDE A VENUE, and the trader is the other side", async () => {
    const s = await scan(
      [
        xfer(ZERO, CURVE, 1_000n, 5),
        xfer(CURVE, at(1), 100n, 10), // a buy
        xfer(at(1), CURVE, 40n, 30), // a sell
        xfer(at(1), at(2), 20n, 40), // neither: a wallet-to-wallet move
      ],
      1_000n,
    );
    assert.equal(s.trades.length, 2);
    assert.deepEqual(
      s.trades.map((t) => [t.trader, t.delta]),
      [
        [at(1), 100n],
        [at(1), -40n],
      ],
    );
  });

  it("and the venue is never a holder or an acquirer", async () => {
    const s = await scan([xfer(ZERO, CURVE, 1_000n, 5), xfer(CURVE, at(1), 100n, 10)], 1_000n);
    assert.ok(!s.acquisitions.some((a) => a.address === CURVE));
    // It still appears in `holders` — concentrationOf excludes it by name, and
    // dropping it here would leave the float short instead.
    assert.ok(s.holders.some((h) => h.address === CURVE));
  });

  it("AND CURVE FILLS ARE NOT CLUSTERING MATERIAL", async () => {
    // Amounts on a curve are set by whoever bought. Counting them measures the
    // market; the tell this is for is round-number fan-out between wallets.
    const s = await scan(
      [
        xfer(ZERO, CURVE, 1_000n, 5),
        xfer(CURVE, at(1), 100n, 10),
        xfer(CURVE, at(2), 100n, 11),
        xfer(at(1), at(3), 50n, 20),
      ],
      1_000n,
    );
    assert.deepEqual([...s.amounts], [50n]);
  });
});

describe("acquisitions", () => {
  it("record the FIRST inbound block, not the latest", async () => {
    const s = await scan(
      [xfer(ZERO, at(1), 1_000n, 10), xfer(at(1), at(2), 10n, 50), xfer(at(1), at(2), 10n, 90)],
      1_000n,
    );
    assert.equal(s.acquisitions.find((a) => a.address === at(2))!.block, 50);
  });

  it("and a zero-value transfer is not an acquisition", async () => {
    const s = await scan([xfer(ZERO, at(1), 1_000n, 10), xfer(at(1), at(2), 0n, 50)], 1_000n);
    assert.ok(!s.acquisitions.some((a) => a.address === at(2)));
  });
});

describe("decoding refuses rather than throwing", () => {
  it("AN ERC-721 LOG DOES NOT END A SWEEP OF THOUSANDS OF GOOD ONES", async () => {
    // Same topic0, three indexed args, empty data. Throwing here would lose
    // every legitimate transfer in the same window.
    const nft: RawLog = {
      topics: [TRANSFER_TOPIC, topic(at(1)), topic(at(2)), word(7n)],
      data: "0x",
      transactionHash: "0x00" as Hex,
      blockNumber: "0x14" as Hex,
    };
    const s = await scan([xfer(ZERO, at(1), 1_000n, 10), nft], 1_000n);
    assert.equal(s.transfers, 1);
    assert.equal(s.wholeHistory, true);
  });

  it("and a log with no block number is skipped, because a bundle needs one", async () => {
    const s = await scan(
      [xfer(ZERO, at(1), 1_000n, 10), { ...xfer(at(1), at(2), 5n, 20), blockNumber: undefined }],
      1_000n,
    );
    assert.equal(s.transfers, 1);
  });
});

describe("the window is a duration, not a block count", () => {
  it("blocksFor converts seconds at this chain's measured rate", () => {
    // 9.911 blocks a second, measured over 1,048,576 blocks on 2026-09-09.
    assert.equal(blocksFor(252), 2_498n, "ChainMind's 2,500-block window is ~4.2 minutes here");
    assert.equal(blocksFor(3_600), 35_680n);
  });

  it("and a nonsensical duration still yields at least one block", () => {
    assert.equal(blocksFor(0), 1n);
    assert.equal(blocksFor(-5), 1n);
  });
});
