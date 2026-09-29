import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toEventSelector, type Hex } from "viem";
import { addressTopic, type RawLog, type ReconcileChain } from "./inflight-reconcile";
import { TRANSFER_TOPIC, findTransferFlows, flowKey, resumeFrom } from "./deposit-log";

/**
 * WHY THIS FILE EXISTS. `FlowSource` declared 'chain-log' from the beginning and
 * nothing ever produced one, so every deposit was an inference with no
 * transaction behind it. Contributions are what P&L is measured against, and a
 * deposit that is never recorded is arithmetically indistinguishable from a
 * gain — which is the bug the flows table was created to stop.
 *
 * The two rules worth guarding hardest are the ones that are wrong in opposite
 * directions: a SWAP's USDG leg must never be booked as capital (it would
 * inflate contributions by the account's whole turnover and drive P&L steadily
 * negative), and a real deposit must never be missed or double-counted.
 */

const ACCT = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

/** A Transfer log shaped exactly as eth_getLogs returns one. */
function transferLog(a: {
  from: string;
  to: string;
  value: bigint;
  txHash: string;
  blockNumber?: number;
  logIndex?: number;
  /** The ERC-20 that moved. Defaults to USDG; a swap fixture names the other side. */
  token?: string;
}): RawLog {
  return {
    ...(a.token === undefined ? {} : { address: a.token }),
    topics: [TRANSFER_TOPIC, addressTopic(a.from), addressTopic(a.to)],
    data: `0x${a.value.toString(16).padStart(64, "0")}` as Hex,
    transactionHash: a.txHash as Hex,
    ...(a.blockNumber === undefined ? {} : { blockNumber: `0x${a.blockNumber.toString(16)}` as Hex }),
    ...(a.logIndex === undefined ? {} : { logIndex: `0x${a.logIndex.toString(16)}` as Hex }),
  };
}

/**
 * A chain that serves a fixed log set, honouring the address and topic filter.
 *
 * `receiptExtra` carries the OTHER legs of a transaction — the ones a USDG-only
 * `eth_getLogs` filter never returns. That distinction is the whole reason the
 * scanner reads receipts: a swap's second leg is a different token, so it is
 * invisible to the filter that found the first, and classifying on the filtered
 * view alone books every purchase as a withdrawal.
 */
function fakeChain(logs: RawLog[], head = 1000n, receiptExtra: RawLog[] = []): ReconcileChain {
  return {
    getBlockNumber: async () => head,
    async getReceiptLogs(txHash) {
      const all = [...logs, ...receiptExtra].filter(
        (l) => String(l.transactionHash).toLowerCase() === String(txHash).toLowerCase(),
      );
      return all.length
        ? all.map((l) => ({
            address: (l as { address?: string }).address ?? USDG,
            topics: l.topics as string[],
            data: l.data,
          }))
        : null;
    },
    async getLogs(args) {
      return logs.filter((l) => {
        if (args.address.toLowerCase() !== USDG.toLowerCase()) return false;
        return args.topics.every((want, i) => {
          if (want === null || want === undefined) return true;
          const got = l.topics[i];
          const list = Array.isArray(want) ? want : [want];
          return list.some((w) => String(w).toLowerCase() === String(got).toLowerCase());
        });
      });
    },
  };
}

const scan = (logs: RawLog[], over: Partial<Parameters<typeof findTransferFlows>[0]> = {}) =>
  findTransferFlows({
    chain: fakeChain(logs),
    smartAccount: ACCT,
    usdgToken: USDG,
    fromBlock: 0n,
    toBlock: 1000n,
    knownKeys: new Set<string>(),
    tradeTxHashes: new Set<string>(),
    ...over,
  });

describe("reading flows off the chain", () => {
  it("uses the real Transfer topic", () => {
    // Typed from memory, so pin it against the derivation rather than trusting
    // it. A wrong topic0 matches nothing and the scan reports "no deposits" —
    // silence that looks exactly like an account nobody has funded.
    assert.equal(TRANSFER_TOPIC, toEventSelector("Transfer(address,address,uint256)"));
  });

  it("books an inbound transfer as evidence, with its transaction", async () => {
    const flows = await scan([
      transferLog({ from: OTHER, to: ACCT, value: 250_000_000n, txHash: "0xaa", blockNumber: 500, logIndex: 3 }),
    ]);
    assert.equal(flows.length, 1);
    assert.deepEqual(flows[0], {
      direction: "in",
      amountUsdg6: 250_000_000n,
      txHash: "0xaa",
      blockNumber: 500,
      logIndex: 3,
    });
  });

  it("books an outbound transfer as a withdrawal", async () => {
    const flows = await scan([
      transferLog({ from: ACCT, to: OTHER, value: 5_000_000n, txHash: "0xbb", blockNumber: 501, logIndex: 0 }),
    ]);
    assert.equal(flows.length, 1);
    assert.equal(flows[0]!.direction, "out");
    // This is the leg `transfer-intent` already covers when the AGENT signs it.
    // Read from the chain it also catches a withdrawal made with the owner key,
    // which nothing in the worker ever saw.
    assert.equal(flows[0]!.amountUsdg6, 5_000_000n);
  });

  it("NEVER books a swap's USDG leg as capital", async () => {
    // The single most damaging mistake available here. Every trade moves USDG,
    // so counting fills as contributions would inflate them by the account's
    // whole turnover and drive reported P&L steadily and confidently negative.
    const flows = await scan(
      [
        transferLog({ from: ACCT, to: OTHER, value: 50_000_000n, txHash: "0xfill", blockNumber: 502, logIndex: 1 }),
        transferLog({ from: OTHER, to: ACCT, value: 80_000_000n, txHash: "0xreal", blockNumber: 503, logIndex: 0 }),
      ],
      { tradeTxHashes: new Set(["0xfill"]) },
    );
    assert.equal(flows.length, 1, "the fill must be filtered out, the deposit kept");
    assert.equal(flows[0]!.txHash, "0xreal");
  });

  it("is idempotent — the last block is re-read every pass on purpose", async () => {
    // resumeFrom is INCLUSIVE, so a block already partly recorded is read again.
    // knownKeys is what makes that free of consequence.
    const log = transferLog({
      from: OTHER, to: ACCT, value: 10_000_000n, txHash: "0xcc", blockNumber: 600, logIndex: 2,
    });
    const already = new Set([flowKey("0xcc", 2)]);
    assert.deepEqual(await scan([log], { knownKeys: already }), []);
    // …and without the record, the same log IS booked.
    assert.equal((await scan([log])).length, 1);
  });

  it("tells two transfers in one transaction apart", async () => {
    // The transaction hash alone is not a key.
    const flows = await scan([
      transferLog({ from: OTHER, to: ACCT, value: 1_000_000n, txHash: "0xdd", blockNumber: 700, logIndex: 0 }),
      transferLog({ from: OTHER, to: ACCT, value: 2_000_000n, txHash: "0xdd", blockNumber: 700, logIndex: 1 }),
    ]);
    assert.equal(flows.length, 2);
    assert.deepEqual(flows.map((f) => f.amountUsdg6), [1_000_000n, 2_000_000n]);
  });

  it("ignores a self-transfer, which crosses no boundary", async () => {
    // It also matches BOTH scans, so without this it would be booked as a
    // deposit of its own size.
    assert.deepEqual(
      await scan([
        transferLog({ from: ACCT, to: ACCT, value: 9_000_000n, txHash: "0xee", blockNumber: 800, logIndex: 0 }),
      ]),
      [],
    );
  });

  it("ignores a zero-value transfer", async () => {
    assert.deepEqual(
      await scan([
        transferLog({ from: OTHER, to: ACCT, value: 0n, txHash: "0xff", blockNumber: 801, logIndex: 0 }),
      ]),
      [],
    );
  });

  it("skips a log with no block number rather than booking it", async () => {
    // Without a block it cannot be resumed from, and without an index it cannot
    // be deduplicated. A flow that might be booked twice is worse than one
    // booked late, so this drops it and says so.
    const said: string[] = [];
    const flows = await scan(
      [transferLog({ from: OTHER, to: ACCT, value: 7_000_000n, txHash: "0x01" })],
      { log: (m) => said.push(m) },
    );
    assert.deepEqual(flows, []);
    assert.match(said.join(" "), /no block number or index/);
  });

  it("returns flows in the order the account experienced them", async () => {
    // The high-water mark moves with each flow, so out-of-order booking walks it
    // through a sequence the account never had.
    const flows = await scan([
      transferLog({ from: OTHER, to: ACCT, value: 3n, txHash: "0x3", blockNumber: 902, logIndex: 0 }),
      transferLog({ from: OTHER, to: ACCT, value: 1n, txHash: "0x1", blockNumber: 900, logIndex: 5 }),
      transferLog({ from: OTHER, to: ACCT, value: 2n, txHash: "0x2", blockNumber: 900, logIndex: 9 }),
    ]);
    assert.deepEqual(flows.map((f) => f.amountUsdg6), [1n, 2n, 3n]);
  });

  it("reads nothing from an empty or inverted range", async () => {
    assert.deepEqual(
      await scan([transferLog({ from: OTHER, to: ACCT, value: 5n, txHash: "0x9", blockNumber: 10, logIndex: 0 })], {
        fromBlock: 100n,
        toBlock: 50n,
      }),
      [],
    );
  });
});

describe("where the next scan starts", () => {
  it("opens at the head when nothing has been scanned", () => {
    // At arm, history belongs to the single `inferred` opening-balance row
    // rather than being re-litigated transfer by transfer.
    assert.equal(resumeFrom(null, 5_000n, 1_000n), 5_000n);
  });

  it("re-reads the last recorded block, rather than starting after it", () => {
    // A block can carry several transfers; a crash between two of them would
    // otherwise strand the rest permanently.
    assert.equal(resumeFrom(4_990, 5_000n, 1_000n), 4_990n);
  });

  it("never scans further back than the lookback allows", () => {
    // A long outage must not turn one tick into an unbounded historical scan.
    assert.equal(resumeFrom(10, 5_000n, 1_000n), 4_000n);
  });

  it("opening at the head is a SAFETY property in hosted mode, not just a cost one", () => {
    // A reach-back was written here and reverted, and this pins the reason so it
    // is not rediscovered by shipping it a second time.
    //
    // Reaching back re-reads blocks whose flows may already be booked, so it is
    // only safe when the process can tell which those are. A hosted child cannot:
    // DATABASE_URL is stripped from it (store.ts), so `knownFlowKeys` and
    // `getNetContributionsUsdg` both read the child's sqlite, which a redeploy
    // wipes. After every deploy that reads as "nothing is booked" with an empty
    // dedup set, so every old deposit books again — and `record()` raises the
    // high-water mark with it, which the mirror ratchets with MAX. Durable,
    // one-way, and it halts a healthy account through the drawdown breaker.
    //
    // resumeFrom's null arm is therefore load-bearing, and this is the assertion
    // that fails if someone makes it reach back instead.
    assert.equal(resumeFrom(null, 5_000n, 1_000n), 5_000n, "a first scan opens at the head");
    assert.equal(resumeFrom(null, 5_000n, 4_999n), 5_000n, "no lookback widens it");
    assert.equal(resumeFrom(null, 0n, 1_000n), 0n);
  });
});

/**
 * THE CANARY, AS THE CHAIN ACTUALLY HAS IT.
 *
 * Ground truth for 0x3E34E58e…: one 10.000000 USDG deposit, then four 1.666500
 * USDG outflows to 0xf4acdaee… that are TSLA purchases, leaving 3.334000 in
 * cash. `capital-classify.test.ts` already pins that the correct contributed
 * capital is 10000000 raw and that the naive answer — netting every movement by
 * direction — is 3_334_000. This asserts the SCANNER reaches the same answer,
 * because the classifier being right is no use if the thing that writes rows
 * does not consult it.
 *
 * The router is on NO list here, deliberately. Only transaction context
 * separates a purchase from a withdrawal, and an address allowlist that is
 * merely stale reclassifies trading as capital in exactly the direction that
 * matters.
 */
describe("the canary's real movements", () => {
  const ROUTER = "0xf4acdaee1234567890123456789012345678abcd";
  const TSLA = "0x00000000000000000000000000000000000ee511";

  /** One trade: USDG out to the router, TSLA back in, same transaction. */
  const trade = (tx: string, block: number) => ({
    usdg: transferLog({ from: ACCT, to: ROUTER, value: 1_666_500n, txHash: tx, blockNumber: block, logIndex: 0 }),
    paired: transferLog({
      from: ROUTER, to: ACCT, value: 4_420_417_000_000_000n, txHash: tx, blockNumber: block, logIndex: 1, token: TSLA,
    }),
  });

  const TRADES = [trade("0xt1", 601), trade("0xt2", 602), trade("0xt3", 603), trade("0xt4", 604)];
  const DEPOSIT = transferLog({
    from: OTHER, to: ACCT, value: 10_000_000n, txHash: "0xfund", blockNumber: 600, logIndex: 0,
  });

  it("books the deposit and NONE of the four trade legs", async () => {
    const flows = await findTransferFlows({
      chain: fakeChain(
        [DEPOSIT, ...TRADES.map((t) => t.usdg)],
        1000n,
        TRADES.map((t) => t.paired),
      ),
      smartAccount: ACCT,
      usdgToken: USDG,
      fromBlock: 0n,
      toBlock: 1000n,
      knownKeys: new Set<string>(),
      // EMPTY. This is the set the old rule depended on entirely, and a redeploy
      // empties it — so the fixture reproduces the state the fleet was actually
      // in when the scanner would have been enabled.
      tradeTxHashes: new Set<string>(),
    });

    assert.equal(flows.length, 1, "four purchases are not four withdrawals");
    assert.equal(flows[0]!.txHash, "0xfund");
    const net = flows.reduce((s, f) => s + (f.direction === "in" ? f.amountUsdg6 : -f.amountUsdg6), 0n);
    assert.equal(net, 10_000_000n, "10.000000 USDG contributed");
    assert.notEqual(net, 3_334_000n, "and NOT the cash balance, which is what direction-only netting gives");
  });

  it("refuses the whole pass when a receipt cannot be read", async () => {
    // An unreadable receipt is not an absent second leg. Booking on the single
    // log we can see is precisely the error above, so the pass refuses and the
    // caller leaves its cursor where it was.
    const blind: ReconcileChain = { ...fakeChain([TRADES[0]!.usdg]), getReceiptLogs: async () => null };
    await assert.rejects(
      () =>
        findTransferFlows({
          chain: blind,
          smartAccount: ACCT,
          usdgToken: USDG,
          fromBlock: 0n,
          toBlock: 1000n,
          knownKeys: new Set<string>(),
          tradeTxHashes: new Set<string>(),
        }),
      /receipt for 0xt1 could not be read/,
    );
  });

  it("BLOCKS rather than guesses when a movement cannot be classified", async () => {
    // A known venue with nothing coming back is neither a completed trade nor a
    // deposit. Unknown means blocked, never "probably a contribution".
    await assert.rejects(
      () =>
        findTransferFlows({
          chain: fakeChain([TRADES[0]!.usdg]),
          smartAccount: ACCT,
          usdgToken: USDG,
          fromBlock: 0n,
          toBlock: 1000n,
          knownKeys: new Set<string>(),
          tradeTxHashes: new Set<string>(),
          protocolAddresses: [ROUTER],
        }),
      /could not be classified/,
    );
  });
});

/**
 * THE ENERGY PURCHASE IS NEVER BOOKED BY THIS SCANNER.
 *
 * The worker books it at landing, from its receipt, with both peaks in one
 * transaction. This scanner's caller moves the peak whenever `addFlow` returns
 * true, and `addFlow` returns true on a duplicate — so if the scanner ALSO
 * booked the leg, the flow row would dedupe and the peak would still come down
 * twice. The case that matters is the one where `tradeTxHashes` misses the
 * purchase (it is recency-bounded, and empty between landing and the landed
 * row), so that is the fixture: the purchase is NOT in it.
 */
describe("an energy purchase is not capital to the scanner", () => {
  const PAIR_A = "0x00000000000000000000000000000000000000b1";
  const PAIR_B = "0x00000000000000000000000000000000000000b2";
  const VIRTUAL = "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31";
  const MERRYMEN = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";
  const TX = "0xe0e0";

  const USDG_OUT = transferLog({ from: ACCT, to: PAIR_A, value: 42_000_000n, txHash: TX, blockNumber: 700, logIndex: 5 });
  const OTHER_LEGS = [
    transferLog({ from: PAIR_A, to: PAIR_B, value: 9n * 10n ** 19n, txHash: TX, blockNumber: 700, logIndex: 6, token: VIRTUAL }),
    transferLog({ from: PAIR_B, to: MERRYMEN, value: 2n * 10n ** 21n, txHash: TX, blockNumber: 700, logIndex: 7, token: MERRYMEN }),
    transferLog({ from: PAIR_B, to: ACCT, value: 98n * 10n ** 21n, txHash: TX, blockNumber: 700, logIndex: 8, token: MERRYMEN }),
  ];
  const DEPOSIT = transferLog({ from: OTHER, to: ACCT, value: 100_000_000n, txHash: "0xfund2", blockNumber: 699, logIndex: 0 });

  it("with the reserve named, the purchase NOT in tradeTxHashes returns no flow and does not throw", async () => {
    const lines: string[] = [];
    const flows = await findTransferFlows({
      chain: fakeChain([DEPOSIT, USDG_OUT], 1000n, OTHER_LEGS),
      smartAccount: ACCT,
      usdgToken: USDG,
      fromBlock: 0n,
      toBlock: 1000n,
      knownKeys: new Set<string>(),
      tradeTxHashes: new Set<string>(), // the miss
      chainId: 4663,
      log: (m) => lines.push(m),
    });
    assert.deepEqual(flows.map((f) => f.txHash), ["0xfund2"], "the deposit is booked, the purchase is not");
    assert.ok(lines.some((l) => /reserve-out/.test(l)), "and the log says what it saw");
  });

  it("the chain defaults to mainnet, where the reserve exists", async () => {
    const lines: string[] = [];
    const flows = await scan([USDG_OUT], { chain: fakeChain([USDG_OUT], 1000n, OTHER_LEGS), log: (m) => lines.push(m) });
    assert.equal(flows.length, 0);
    assert.ok(lines.some((l) => /reserve-out/.test(l)));
  });

  it("on a chain with no reserve the same legs are a trade — still not capital", async () => {
    const lines: string[] = [];
    const flows = await scan([USDG_OUT], {
      chain: fakeChain([USDG_OUT], 1000n, OTHER_LEGS),
      chainId: 46630,
      log: (m) => lines.push(m),
    });
    assert.equal(flows.length, 0);
    assert.ok(lines.some((l) => /trade-out/.test(l)));
  });

  it("PIN: the scanner books exactly capital-in || capital-out, never reserve-out", async () => {
    // Widening this condition would make the scanner a second booker of the
    // energy purchase. The comment beside it says why; this says it didn't move.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./deposit-log.ts", import.meta.url), "utf8");
    const booking = src.match(/if \(v\.kind === [^)]*\) \{\n\s*out\.push\(/g) ?? [];
    assert.equal(booking.length, 1, "one booking condition");
    assert.match(booking[0]!, /^if \(v\.kind === "capital-in" \|\| v\.kind === "capital-out"\) \{/);
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""), /kind === "reserve-out"/);
  });
});

/**
 * PERP MARGIN IS NOT CAPITAL (docs/perps.md rule 12).
 *
 * USDG posted to this account's own Lighter account, and paid back from it,
 * stays in the book — equity carries the venue side. Booked here it would be a
 * withdrawal of money that never left (the deposit) and a fresh contribution of
 * money that was already the owner's (the payout, which arrives in Lighter's
 * relayer's transaction, so no ledger row of ours names it). The receipts below
 * are shaped like the live ones: 0x28144cb2… (Approval, Transfer self→proxy,
 * NewPriorityRequest, Deposit) and the relayer batch 0x0f82c519… (Transfer
 * proxy→owner at i, WithdrawPending(owner) at i+1, per owner).
 */
describe("perp margin moving to and from Lighter is not capital", () => {
  const PROXY = "0x94bab9693ba2f6358507effcbd372b0660afff9d";
  const DEPOSIT_TOPIC = "0x493c3b8240368e8343bcd42cac5f4b8b161c06d061710e542a72f06a40ddd9d1";
  const WITHDRAW_PENDING_TOPIC = "0xef80235b5f4cf1822ad6a8621af41ac64372ff672c402874f507fc63dbe5e06f";
  const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
  const STRANGER = "0x7777777777777777777777777777777777777777";
  const RELAYER_TARGET = "0xa91803ac00000000000000000000000000000000";
  const word = (v: bigint | string) =>
    (typeof v === "string" ? v.toLowerCase().replace(/^0x/, "") : v.toString(16)).padStart(64, "0");

  interface Log {
    address: string;
    topics: string[];
    data: string;
    transactionHash: string;
    blockNumber: string;
    logIndex: string;
  }
  const at = (tx: string, block: number, logIndex: number) => ({
    transactionHash: tx,
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
  });
  const usdgTransfer = (tx: string, block: number, i: number, from: string, to: string, value: bigint): Log => ({
    address: USDG,
    topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
    data: `0x${word(value)}`,
    ...at(tx, block, i),
  });
  const depositEvent = (tx: string, block: number, i: number, to: string, amount: bigint, accountIndex = 22_149n): Log => ({
    address: PROXY,
    topics: [DEPOSIT_TOPIC],
    data: `0x${word(accountIndex)}${word(to)}${word(3n)}${word(0n)}${word(amount)}`,
    ...at(tx, block, i),
  });
  const withdrawPending = (tx: string, block: number, i: number, owner: string, amount: bigint): Log => ({
    address: PROXY,
    topics: [WITHDRAW_PENDING_TOPIC, `0x${word(owner)}`],
    data: `0x${word(3n)}${word(amount)}`,
    ...at(tx, block, i),
  });
  const filler = (tx: string, block: number, i: number, address: string, topic: string): Log => ({
    address,
    topics: [topic],
    data: "0x",
    ...at(tx, block, i),
  });

  /**
   * A chain whose receipts are WHOLE — every log, with its position — which is
   * what the venue rule needs and what the plain fake above strips. eth_getLogs
   * still honours the USDG address and topic filter.
   */
  function venueChain(receipts: Log[][]): ReconcileChain {
    const all = receipts.flat();
    return {
      getBlockNumber: async () => 1000n,
      async getReceiptLogs(txHash) {
        const logs = all.filter((l) => l.transactionHash.toLowerCase() === String(txHash).toLowerCase());
        return logs.length ? logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })) : null;
      },
      async getLogs(args) {
        return all
          .filter((l) => l.address.toLowerCase() === args.address.toLowerCase())
          .filter((l) =>
            args.topics.every((want, i) => {
              if (want === null || want === undefined) return true;
              const list = Array.isArray(want) ? want : [want];
              return list.some((w) => String(w).toLowerCase() === String(l.topics[i]).toLowerCase());
            }),
          ) as unknown as RawLog[];
      },
    };
  }
  const run = (receipts: Log[][], lines: string[] = [], chainId = 4663) =>
    findTransferFlows({
      chain: venueChain(receipts),
      smartAccount: ACCT,
      usdgToken: USDG,
      fromBlock: 0n,
      toBlock: 1000n,
      knownKeys: new Set<string>(),
      // EMPTY on purpose: the payout is never in it (it is the relayer's
      // transaction), and a deposit misses it after a redeploy. The receipt
      // must decide, not ledger membership.
      tradeTxHashes: new Set<string>(),
      chainId,
      log: (m) => lines.push(m),
    });

  // 82.973191 USDG, the live deposit's amount.
  const AMT = 82_973_191n;
  const OUR_DEPOSIT = [
    filler("0xd0", 800, 1, USDG, APPROVAL_TOPIC),
    usdgTransfer("0xd0", 800, 2, ACCT, PROXY, AMT),
    filler("0xd0", 800, 3, PROXY, "0x" + "ab".repeat(32)),
    depositEvent("0xd0", 800, 4, ACCT, AMT),
  ];

  it("OUR DEPOSIT: posted as margin, logged not capital, nothing booked", async () => {
    const lines: string[] = [];
    assert.deepEqual(await run([OUR_DEPOSIT], lines), []);
    assert.ok(lines.some((l) => /margin-out/.test(l)), lines.join("\n"));
  });

  it("A RELAYER PAYOUT TO US: margin coming home, not a fresh deposit — even batched with other owners", async () => {
    // The relayer pays a stranger first, then us; each Transfer is followed by
    // its own WithdrawPending. Only ours touches this account.
    const payout = [
      usdgTransfer("0xp0", 810, 10, PROXY, STRANGER, 2_457_020_000n),
      withdrawPending("0xp0", 810, 11, STRANGER, 2_457_020_000n),
      usdgTransfer("0xp0", 810, 12, PROXY, ACCT, 8_085_000_000n),
      withdrawPending("0xp0", 810, 13, ACCT, 8_085_000_000n),
      filler("0xp0", 810, 14, RELAYER_TARGET, "0x" + "cd".repeat(32)),
    ];
    const lines: string[] = [];
    assert.deepEqual(await run([payout], lines), []);
    assert.ok(lines.some((l) => /margin-in/.test(l)), lines.join("\n"));
  });

  it("SOMEONE ELSE'S DEPOSIT IN THE SAME TRANSACTION changes nothing about ours", async () => {
    // A router batch: a stranger's USDG credited to the stranger, then ours to
    // us. Pairing is by position, so neither Deposit is mistaken for the other.
    const batch = [
      usdgTransfer("0xb0", 820, 1, STRANGER, PROXY, 135_000_000n),
      depositEvent("0xb0", 820, 2, STRANGER, 135_000_000n, 30_001n),
      usdgTransfer("0xb0", 820, 3, ACCT, PROXY, AMT),
      depositEvent("0xb0", 820, 4, ACCT, AMT),
    ];
    const lines: string[] = [];
    assert.deepEqual(await run([batch], lines), []);
    assert.ok(lines.some((l) => /margin-out/.test(l)));
  });

  it("OUR USDG CREDITED TO SOMEBODY ELSE'S VENUE ACCOUNT left the book — capital-out, booked as today", async () => {
    // Only the owner key can make this call (the wall pins `_to` to the
    // account); the money is gone to an account this book does not own.
    const gift = [usdgTransfer("0xg0", 830, 2, ACCT, PROXY, AMT), depositEvent("0xg0", 830, 4, STRANGER, AMT)];
    const flows = await run([gift]);
    assert.deepEqual(
      flows.map((f) => [f.direction, f.amountUsdg6, f.txHash]),
      [["out", AMT, "0xg0"]],
    );
  });

  it("A PLAIN USDG TRANSFER TO A STRANGER is still a withdrawal, exactly as before", async () => {
    const plain = [usdgTransfer("0xs0", 840, 0, ACCT, STRANGER, 5_000_000n)];
    const flows = await run([plain]);
    assert.deepEqual(
      flows.map((f) => [f.direction, f.amountUsdg6]),
      [["out", 5_000_000n]],
    );
  });

  it("A PROXY LEG THE RECEIPT CANNOT PROVE BLOCKS — never booked as capital, never waved through as margin", async () => {
    // USDG to the proxy with no Deposit after it: neither a proven margin post
    // nor a proven gift. Ambiguous stops the scanner, as it always has.
    await assert.rejects(() => run([[usdgTransfer("0xa0", 850, 2, ACCT, PROXY, AMT)]]), /could not be classified/);
    // And a payout whose next log is not its WithdrawPending.
    await assert.rejects(
      () => run([[usdgTransfer("0xa1", 851, 5, PROXY, ACCT, AMT), filler("0xa1", 851, 6, PROXY, "0x" + "ef".repeat(32))]]),
      /could not be classified/,
    );
  });

  it("off Robinhood Chain there is no venue: a proxy-shaped leg is judged exactly as before", async () => {
    const flows = await run([OUR_DEPOSIT], [], 46630);
    assert.deepEqual(
      flows.map((f) => [f.direction, f.amountUsdg6]),
      [["out", AMT]],
      "no venue named, so no margin rule — the pre-perps verdict",
    );
  });
});
