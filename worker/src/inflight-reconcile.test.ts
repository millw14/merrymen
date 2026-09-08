/**
 * In-flight reconciliation core — proven without a chain via the ReconcileChain
 * seam. The invariants that keep the daily cap honest across an unclean restart:
 *   • a SUCCESSFUL op the ledger never recorded is surfaced as an orphan;
 *   • an op already in the ledger (any status) is NOT re-surfaced;
 *   • a REVERTED op is ignored — it moved nothing and counts toward no cap;
 *   • the notional is the |USDG leg| from the receipt, so a reconciled row
 *     counts exactly as the live path would have counted it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbi, toHex, type Hex } from "viem";
import { acquiredLegOf, addressTopic, findOrphanOps, resolveSubmittedOps, type RawLog, type ReconcileChain } from "./inflight-reconcile";
import type { ReceiptLog } from "./fills";

const EP_ABI = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

const ACCOUNT = "0x00000000000000000000000000000000000acc01" as const;
const ROUTER = "0x00000000000000000000000000000000000f0011" as const;
const USDG = "0x00000000000000000000000000000000000d6000" as const;
const STOCK = "0x00000000000000000000000000000000005704c0" as const;

function opLog(userOpHash: Hex, success: boolean, txHash: Hex): RawLog {
  const topics = encodeEventTopics({
    abi: EP_ABI,
    eventName: "UserOperationEvent",
    args: { userOpHash, sender: ACCOUNT, paymaster: "0x0000000000000000000000000000000000000000" },
  });
  // Non-indexed fields, in order: nonce, success, actualGasCost, actualGasUsed.
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
    [1n, success, 0n, 0n],
  );
  return { topics: topics as readonly Hex[], data, transactionHash: txHash };
}

function transfer(token: string, from: string, to: string, value: bigint): ReceiptLog {
  return { address: token, topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)], data: toHex(value, { size: 32 }) };
}

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function fakeChain(logs: RawLog[], receipts: Record<string, ReceiptLog[]>): ReconcileChain {
  return {
    async getBlockNumber() {
      return 1000n;
    },
    async getLogs() {
      return logs;
    },
    async getReceiptLogs(txHash) {
      return receipts[txHash.toLowerCase()] ?? null;
    },
  };
}

describe("findOrphanOps", () => {
  it("surfaces a successful op with no ledger row, at its USDG-leg notional", async () => {
    const orphanHash = h(0xaa);
    const tx = h(0xbb);
    const chain = fakeChain(
      [opLog(orphanHash, true, tx)],
      // A buy: 5 USDG leaves the account, stock arrives.
      { [tx.toLowerCase()]: [transfer(USDG, ACCOUNT, ROUTER, 5_000000n), transfer(STOCK, ROUTER, ACCOUNT, 42n)] },
    );
    const orphans = await findOrphanOps({ chain, smartAccount: ACCOUNT, usdgToken: USDG, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]!.userOpHash, orphanHash.toLowerCase());
    assert.equal(orphans[0]!.notionalUsdg6, 5_000000n);
    assert.equal(orphans[0]!.attributed, true);
  });

  it("does NOT re-surface an op already in the ledger", async () => {
    const known = h(0xaa);
    const tx = h(0xbb);
    const chain = fakeChain([opLog(known, true, tx)], { [tx.toLowerCase()]: [transfer(USDG, ACCOUNT, ROUTER, 5_000000n)] });
    const orphans = await findOrphanOps({
      chain,
      smartAccount: ACCOUNT,
      usdgToken: USDG,
      knownOpHashes: new Set([known.toLowerCase()]),
      lookbackBlocks: 1000n,
    });
    assert.equal(orphans.length, 0);
  });

  it("ignores a reverted op — it moved nothing and counts toward no cap", async () => {
    const reverted = h(0xcc);
    const tx = h(0xdd);
    const chain = fakeChain([opLog(reverted, false, tx)], {});
    const orphans = await findOrphanOps({ chain, smartAccount: ACCOUNT, usdgToken: USDG, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.equal(orphans.length, 0);
  });

  it("records an orphan with no readable USDG leg at notional 0, unattributed", async () => {
    const orphanHash = h(0xee);
    const tx = h(0xff);
    // stock↔stock: no USDG leg on either side.
    const chain = fakeChain([opLog(orphanHash, true, tx)], { [tx.toLowerCase()]: [transfer(STOCK, ACCOUNT, ROUTER, 10n)] });
    const orphans = await findOrphanOps({ chain, smartAccount: ACCOUNT, usdgToken: USDG, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]!.notionalUsdg6, 0n);
    assert.equal(orphans[0]!.attributed, false);
  });

  it("counts a sell (USDG inbound) at its magnitude — the cap is turnover, not net outflow", async () => {
    const orphanHash = h(0x11);
    const tx = h(0x22);
    // A sell: stock leaves, 7 USDG arrives.
    const chain = fakeChain(
      [opLog(orphanHash, true, tx)],
      { [tx.toLowerCase()]: [transfer(STOCK, ACCOUNT, ROUTER, 9n), transfer(USDG, ROUTER, ACCOUNT, 7_000000n)] },
    );
    const orphans = await findOrphanOps({ chain, smartAccount: ACCOUNT, usdgToken: USDG, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]!.notionalUsdg6, 7_000000n);
    assert.equal(orphans[0]!.attributed, true);
  });

  it("de-duplicates the same op appearing twice in the window", async () => {
    const dup = h(0x33);
    const tx = h(0x44);
    const chain = fakeChain([opLog(dup, true, tx), opLog(dup, true, tx)], { [tx.toLowerCase()]: [transfer(USDG, ACCOUNT, ROUTER, 1_000000n)] });
    const orphans = await findOrphanOps({ chain, smartAccount: ACCOUNT, usdgToken: USDG, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.equal(orphans.length, 1);
  });
});

/**
 * THE SIBLING SWEEP, and the bug that made it necessary.
 *
 * cf9b046 started writing a 'submitted' row BEFORE broadcasting, so a crash
 * between the send and the ledger write could not lose the hash. It also made
 * findOrphanOps blind to exactly those rows: `listOpHashes` selected every
 * non-null user_op_hash regardless of status, and findOrphanOps skips any hash
 * in that set. So the row the sweep exists to finish was the one it filtered
 * out — invisible forever, never journaled, absent from realized P&L, and still
 * charging the live rail.
 *
 * The store half of the fix is asserted in inflight-row.integration.test.ts,
 * against real SQL. This is the chain half.
 */
describe("resolveSubmittedOps", () => {
  const chainFor = (logs: RawLog[], receipts: Record<string, ReceiptLog[]> = {}) => {
    // A chain that honours the topic filter, unlike fakeChain above — the
    // exact-lookup path is the whole point here, and a fake that ignores
    // `topics` would let a wrong-hash match pass unnoticed.
    return {
      async getBlockNumber() {
        return 1000n;
      },
      async getLogs(a: { topics: (Hex | Hex[] | null)[] }) {
        const want = a.topics[1];
        if (!want) return logs;
        return logs.filter((l) => l.topics[1]?.toLowerCase() === String(want).toLowerCase());
      },
      async getReceiptLogs(txHash: Hex) {
        return receipts[txHash.toLowerCase()] ?? null;
      },
    } as ReconcileChain;
  };

  it("settles a stranded op the chain LANDED, with its notional", async () => {
    const [op, tx] = [h(0x51), h(0x61)];
    const res = await resolveSubmittedOps({
      chain: chainFor([opLog(op, true, tx)], {
        [tx]: [transfer(USDG, ACCOUNT, ROUTER, 25_000_000n), transfer(STOCK, ROUTER, ACCOUNT, 10n ** 18n)],
      }),
      smartAccount: ACCOUNT,
      usdgToken: USDG,
      hashes: [op],
      lookbackBlocks: 1000n,
    });
    assert.equal(res.length, 1);
    assert.equal(res[0]!.success, true);
    assert.equal(res[0]!.txHash, tx);
    assert.equal(res[0]!.notionalUsdg6, 25_000_000n);
    assert.equal(res[0]!.attributed, true);
  });

  it("settles a stranded op the chain REVERTED — which findOrphanOps would skip", async () => {
    // The asymmetry that makes this a separate function. An unrecorded revert
    // is nothing to an orphan sweep: it moved no money and counts toward no
    // cap. Here the row already EXISTS and is charging the live rail, so the
    // revert is the thing that releases the charge.
    const [op, tx] = [h(0x52), h(0x62)];
    const res = await resolveSubmittedOps({
      chain: chainFor([opLog(op, false, tx)]),
      smartAccount: ACCOUNT,
      usdgToken: USDG,
      hashes: [op],
      lookbackBlocks: 1000n,
    });
    assert.equal(res.length, 1, "a revert must be REPORTED, not skipped");
    assert.equal(res[0]!.success, false);
    assert.equal(res[0]!.notionalUsdg6, 0n, "a reverted op moved nothing");

    // And prove the contrast, so the reason for two functions is on the record.
    const orphans = await findOrphanOps({
      chain: chainFor([opLog(op, false, tx)]),
      smartAccount: ACCOUNT,
      usdgToken: USDG,
      knownOpHashes: new Set(),
      lookbackBlocks: 1000n,
    });
    assert.equal(orphans.length, 0, "the orphan sweep skips it, correctly, for its own purpose");
  });

  it("AN OP IT CANNOT FIND IS LEFT ALONE — never written off as reverted", async () => {
    // The one rule that matters most. Not-found means pending, or older than
    // the lookback, or an RPC that answered thinly. Guessing 'reverted' would
    // release a charge for an op that may well have moved money, and the guess
    // would enter a hash-chained journal where it cannot be quietly corrected.
    const res = await resolveSubmittedOps({
      chain: chainFor([opLog(h(0x53), true, h(0x63))]),
      smartAccount: ACCOUNT,
      usdgToken: USDG,
      hashes: [h(0x54)], // a different op entirely
      lookbackBlocks: 1000n,
    });
    assert.deepEqual(res, [], "silence is not a verdict");
  });

  it("looks each hash up EXACTLY, rather than scanning and filtering", async () => {
    // topic1 of UserOperationEvent is the indexed userOpHash, and the filter
    // has always left that slot null because the orphan sweep does not know the
    // hashes in advance. This one does. Asserted because a regression to a scan
    // would still pass every test above — it would just cost a window read per
    // op and match on hashes it was never asked about.
    const seen: (Hex | Hex[] | null)[][] = [];
    const chain: ReconcileChain = {
      async getBlockNumber() {
        return 1000n;
      },
      async getLogs(a) {
        seen.push(a.topics);
        return [];
      },
      async getReceiptLogs() {
        return null;
      },
    };
    await resolveSubmittedOps({
      chain,
      smartAccount: ACCOUNT,
      usdgToken: USDG,
      hashes: [h(0x55)],
      lookbackBlocks: 1000n,
    });
    assert.equal(seen.length, 1);
    assert.equal(String(seen[0]![1]).toLowerCase(), h(0x55), "topic1 must carry the hash");
  });

  it("asks nothing at all when there is nothing stranded", async () => {
    // The ordinary case, on a 300s clock, for the life of every healthy run.
    let calls = 0;
    const chain: ReconcileChain = {
      async getBlockNumber() {
        calls += 1;
        return 1000n;
      },
      async getLogs() {
        calls += 1;
        return [];
      },
      async getReceiptLogs() {
        return null;
      },
    };
    assert.deepEqual(
      await resolveSubmittedOps({ chain, smartAccount: ACCOUNT, usdgToken: USDG, hashes: [], lookbackBlocks: 1000n }),
      [],
    );
    assert.equal(calls, 0, "not even a block-number read");
  });
});

/**
 * THE POSITION NO RULE COULD SELL.
 *
 * A reconciled op recorded its spend and nothing else — by design, and the
 * design said so: "P&L for this fill isn't attributable, only its spend is."
 * That reasoning is correct about P&L and silent about the consequence. BOTH
 * mechanical exits refuse a holding with no cost on record: the stop floor and
 * the take-profit each skip what they cannot measure against an entry.
 *
 * So a worker restarting between submitting an op and writing its row produced
 * a position that could never be sold by rule. Measured in production on a real
 * owner's book: two holdings, a 25% stop and a 20% take-profit both armed and
 * displayed, and neither able to reach either position. Nothing said so.
 *
 * The evidence was already being fetched. `netTokenDeltas` walks the receipt to
 * find the USDG leg and throws the other legs away; the token that arrived and
 * how much of it arrived are on the same walk. These tests pin that it is read
 * ONLY when the receipt is unambiguous — a guessed basis fires a stop at a level
 * nobody chose, which is worse than no stop at all.
 */
describe("the other leg of a reconciled op", () => {
  const orphanOf = async (logs: ReceiptLog[]) => {
    const hash = h(0xa1);
    const tx = h(0xb1);
    const chain = fakeChain([opLog(hash, true, tx)], { [tx.toLowerCase()]: logs });
    const [o] = await findOrphanOps({ chain, smartAccount: ACCOUNT, usdgToken: USDG, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.ok(o, "expected one orphan");
    return o;
  };

  it("A BUY CARRIES THE TOKEN AND THE QUANTITY, so a basis can be booked", async () => {
    const o = await orphanOf([transfer(USDG, ACCOUNT, ROUTER, 5_000000n), transfer(STOCK, ROUTER, ACCOUNT, 42n)]);
    assert.deepEqual(o.acquired, { token: STOCK.toLowerCase(), qtyRaw: 42n, side: "buy" });
    assert.equal(o.notionalUsdg6, 5_000000n, "and the cash side is unchanged");
  });

  it("and a sell reads the other way round", async () => {
    const o = await orphanOf([transfer(STOCK, ACCOUNT, ROUTER, 42n), transfer(USDG, ROUTER, ACCOUNT, 6_000000n)]);
    assert.deepEqual(o.acquired, { token: STOCK.toLowerCase(), qtyRaw: 42n, side: "sell" });
  });

  it("A MULTI-HOP ROUTE IS AMBIGUOUS, AND STAYS NULL", async () => {
    // Two token legs and no honest way to say which one the position is. A
    // basis picked from one of them is a stop-loss level nobody chose.
    const OTHER = "0x00000000000000000000000000000000000fee01" as const;
    const o = await orphanOf([
      transfer(USDG, ACCOUNT, ROUTER, 5_000000n),
      transfer(STOCK, ROUTER, ACCOUNT, 42n),
      transfer(OTHER, ROUTER, ACCOUNT, 7n),
    ]);
    assert.equal(o.acquired, null);
    assert.equal(o.attributed, true, "the spend is still counted — that half was never in doubt");
  });

  it("and a token leg with NO cash leg is a transfer, not a fill", async () => {
    // Somebody sent the account a token. There is no price in that, and calling
    // it a buy at zero would say the position was free.
    const o = await orphanOf([transfer(STOCK, ROUTER, ACCOUNT, 42n)]);
    assert.equal(o.acquired, null);
    assert.equal(o.attributed, false);
  });

  it("and legs pointing the SAME way are not a swap at all", async () => {
    // Cash in and tokens in together is a funding event or a rebate. A swap has
    // one of each, and the two sides have to disagree or this is not one.
    const o = await orphanOf([transfer(USDG, ROUTER, ACCOUNT, 5_000000n), transfer(STOCK, ROUTER, ACCOUNT, 42n)]);
    assert.equal(o.acquired, null);
  });

  it("THE RECONCILER BOOKS IT, and says whether the exits can now reach it", async () => {
    // The consequence is the point, so the sentence an owner reads names it.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(src, /if \(wrote && o\.acquired && sym\) \{[\s\S]{0,200}bookFill\(/);
    assert.match(src, /cost basis for \$\{sym\} booked from the receipt/);
    assert.match(src, /no cost basis and no rule can exit it/);
    // And the standing condition is reported for positions already in this
    // state, which no backfill can reach.
    assert.match(src, /the stop-loss and take-profit cannot act on/);
  });
});

describe("the same judgement, read from the other end", () => {
  it("ONE RULE, TWO CALLERS — a receipt gets the same answer either way", async () => {
    // The orphan sweep reads an op it has just found; the backfill reads a
    // transaction the ledger recorded long ago and never booked. Two copies of
    // this judgement would be two answers about one receipt, and the answer is
    // a cost basis a stop-loss measures against.
    const tx = h(0xc1);
    const logs = [transfer(USDG, ACCOUNT, ROUTER, 5_000000n), transfer(STOCK, ROUTER, ACCOUNT, 42n)];
    const chain = fakeChain([], { [tx.toLowerCase()]: logs });
    const leg = await acquiredLegOf(chain, tx, ACCOUNT, USDG);
    assert.deepEqual(leg, { token: STOCK.toLowerCase(), qtyRaw: 42n, side: "buy", cashUsdg: 5_000000n });
  });

  it("AN UNREADABLE RECEIPT IS NOT AN AMBIGUOUS ONE, and both book nothing", async () => {
    // "I could not look" and "I looked and it was not clear" are different
    // facts, and the safe action is identical for both — which is the only
    // reason they may share a return value here.
    const chain = fakeChain([], {});
    assert.equal(await acquiredLegOf(chain, h(0xc2), ACCOUNT, USDG), null);
  });

  it("and the backfill only runs for a holding that is actually uncovered", async () => {
    // It costs a receipt fetch per row, so a healthy book must pay nothing —
    // and it must stop the moment it has nothing left to fix, or an agent with
    // one stubborn position re-reads the same receipts every arm forever.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(src, /if \(uncovered\.length && active\?\.executor\) \{/);
    assert.match(src, /if \(!uncovered\.length\) break;/);
    assert.match(src, /if \(!sym \|\| !uncovered\.includes\(sym\)\) continue;/);
    assert.match(src, /recovered \$\{sym\}'s entry price from its receipt/);
  });
});
