/**
 * THE TWO WAYS A NODE SAYS NO, AND WHY THEY WANT OPPOSITE ANSWERS.
 *
 * The first version of this sweep retried every failure four times at the same
 * size, 700ms apart, on the reasoning that "a rate limit is not a hint about the
 * question". That reasoning is right and it is half the story. Run against the
 * live chain it failed all 110 of its windows with 429 Too Many Requests — while
 * the identical query for a single account across the WHOLE 54.7M-block history
 * succeeded in 1.6 seconds. The node was refusing the RATE, not the range, and
 * windowing was what created the rate.
 *
 * So the sweep now starts with the whole range and narrows only when the node
 * says the answer was too big, which is the one refusal that splitting can fix.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lighterVenueProxies } from "../../packages/core/src/index";
import { classifyRpcError, scanFleetCapital, TRANSFER_TOPIC, type RpcCall } from "./chain-capital";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ACCT = "0x3e34e58e1e1b52a6cbe2bd7c6e0c1b1e1e1e1e1e";
const OWNER = "0x00000000000000000000000000000000000000ff";
const pad32 = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

const transferLog = (a: { from: string; to: string; amount: bigint; tx: string; block: number; idx: number }) => ({
  address: USDG,
  topics: [TRANSFER_TOPIC, pad32(a.from), pad32(a.to)],
  data: "0x" + a.amount.toString(16),
  blockNumber: "0x" + a.block.toString(16),
  transactionHash: a.tx,
  logIndex: "0x" + a.idx.toString(16),
});

const DEPOSIT = transferLog({ from: OWNER, to: ACCT, amount: 10_000_000n, tx: "0xfund", block: 4_100_000, idx: 0 });

describe("what the node's refusal means", () => {
  it("tells a result-cap apart from a rate limit apart from neither", () => {
    assert.equal(classifyRpcError(new Error("-32000: logs matched by query exceeds limit of 10000")), "too-many-results");
    assert.equal(classifyRpcError(new Error("query returned more than 10000 results")), "too-many-results");
    assert.equal(classifyRpcError(new Error("429: Too Many Requests")), "rate-limited");
    assert.equal(classifyRpcError(new Error("rate limit exceeded")), "rate-limited");
    assert.equal(classifyRpcError(new Error("connection reset")), "unknown");
    assert.equal(classifyRpcError("not an Error at all"), "unknown");
  });
});

describe("the fleet sweep", () => {
  /**
   * Counts the getLogs calls, so "how many did it make" is testable — and
   * HONOURS THE TOPIC FILTER, which a fake that ignores it cannot.
   *
   * The first version of this fake returned the same deposit to both the
   * outbound and the inbound sweep, which doubled the account's contributed
   * capital. That is the real bug this module exists to prevent, reached by a
   * test double rather than by the code: a fake that does not filter is not a
   * model of the node, it is a model of a node that does not work.
   */
  const spy = (handler: (from: bigint, to: bigint, call: number) => RawResult) => {
    const ranges: [bigint, bigint][] = [];
    let call = 0;
    const rpc: RpcCall = async (method, params) => {
      if (method === "eth_getTransactionReceipt") return { logs: [DEPOSIT] };
      const p = params[0] as { fromBlock: string; toBlock: string; topics: (string | string[] | null)[] };
      const from = BigInt(p.fromBlock);
      const to = BigInt(p.toBlock);
      ranges.push([from, to]);
      const r = handler(from, to, call++);
      if (r instanceof Error) throw r;
      return (r as { topics: string[] }[]).filter((log) =>
        p.topics.every((want, i) => {
          if (want === null || want === undefined) return true;
          const list = Array.isArray(want) ? want : [want];
          return list.some((w) => w.toLowerCase() === String(log.topics[i]).toLowerCase());
        }),
      );
    };
    return { rpc, ranges, calls: () => ranges.length };
  };
  type RawResult = Error | unknown[];

  it("asks for the whole history in one call per direction, not 110", async () => {
    // The measured behaviour that made the windowed version fail: the node
    // filters server-side on the topic OR-list, so the whole range is cheap.
    const s = spy((from, to) => (from === 0n ? [DEPOSIT] : []));
    const out = await scanFleetCapital(s.rpc, {
      accounts: [ACCT],
      usdgToken: USDG,
      fromBlock: 0n,
      toBlock: 54_700_000n,
    });
    assert.equal(s.calls(), 2, "one sweep for outbound, one for inbound");
    assert.deepEqual(s.ranges[0], [0n, 54_700_000n], "and each covers everything");
    const cap = out.get(ACCT)!;
    assert.equal(cap.complete, true);
    assert.equal(cap.totals.grossContributionsRaw, "10000000");
  });

  it("SPLITS when the node says the answer was too big", async () => {
    // The one refusal that a smaller question can fix.
    const s = spy((from, to) =>
      to - from > 20_000_000n
        ? new Error("-32000: logs matched by query exceeds limit of 10000")
        : from === 0n
          ? [DEPOSIT]
          : [],
    );
    const out = await scanFleetCapital(s.rpc, {
      accounts: [ACCT],
      usdgToken: USDG,
      fromBlock: 0n,
      toBlock: 54_700_000n,
    });
    assert.ok(s.calls() > 2, "it narrowed rather than giving up");
    assert.equal(out.get(ACCT)!.complete, true, "and the coverage is still complete");
    assert.equal(out.get(ACCT)!.totals.grossContributionsRaw, "10000000");
  });

  it("WAITS OUT a rate limit at the same size, because splitting makes it worse", async () => {
    // Splitting here would turn one refused call into two refused calls.
    let seen = 0;
    const s = spy((from, to, call) => {
      if (call < 2) {
        seen += 1;
        return new Error("429: Too Many Requests");
      }
      return from === 0n ? [DEPOSIT] : [];
    });
    const out = await scanFleetCapital(s.rpc, {
      accounts: [ACCT],
      usdgToken: USDG,
      fromBlock: 0n,
      toBlock: 1_000n,
    });
    assert.equal(seen, 2, "it retried");
    for (const [from, to] of s.ranges) {
      assert.deepEqual([from, to], [0n, 1_000n], "…at the SAME range every time, never split");
    }
    assert.equal(out.get(ACCT)!.complete, true);
  });

  it("reports coverage short rather than an empty history when it truly cannot read", async () => {
    // The distinction that matters most: a window nobody could read must not
    // look like a window with no deposits in it. `complete: false` is what stops
    // the planner writing a contribution history with holes in it.
    const s = spy(() => new Error("429: Too Many Requests"));
    const out = await scanFleetCapital(s.rpc, {
      accounts: [ACCT],
      usdgToken: USDG,
      fromBlock: 0n,
      toBlock: 1_000n,
    });
    const cap = out.get(ACCT)!;
    assert.equal(cap.complete, false, "an unread window is not an empty one");
    assert.equal(cap.movements.length, 0);
  });

  it("never pads the topic filter with a trailing null", async () => {
    // Transfer has three topics. A fourth position matches nothing, so a padded
    // filter reports an empty history for a funded account — confirmed against
    // the live node while diagnosing the failed sweep.
    const shapes: unknown[][] = [];
    const rpc: RpcCall = async (method, params) => {
      if (method === "eth_getTransactionReceipt") return { logs: [DEPOSIT] };
      shapes.push((params[0] as { topics: unknown[] }).topics);
      return [];
    };
    await scanFleetCapital(rpc, { accounts: [ACCT], usdgToken: USDG, fromBlock: 0n, toBlock: 10n });
    assert.equal(shapes.length, 2);
    assert.equal(shapes[0]!.length, 2, "outbound filters on topic1 and stops");
    assert.equal(shapes[1]!.length, 3, "inbound filters on topic2 and stops");
    for (const t of shapes) assert.notEqual(t[t.length - 1], null, "no trailing null");
  });
});

/**
 * THE FLEET SWEEP SEES AN ENERGY PURCHASE THE WAY THE LEDGER DOES.
 *
 * The worker books it as capital leaving the book. Named the reserve, the sweep
 * classifies the same leg `reserve-out` and totals it as its own figure, so
 * hwm-repair and reconstruction agree with the ledger instead of calling it a
 * trade and deriving a peak too high by every purchase.
 */
describe("energy purchases in the fleet sweep", () => {
  const MERRYMEN = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";
  const VIRTUAL = "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31";
  const PAIR_A = "0x00000000000000000000000000000000000000b1";
  const PAIR_B = "0x00000000000000000000000000000000000000b2";
  const USDG_OUT = transferLog({ from: ACCT, to: PAIR_A, amount: 42_000_000n, tx: "0xenergy", block: 4_200_000, idx: 5 });
  const other = (token: string, from: string, to: string, amount: bigint, idx: number) => ({
    ...transferLog({ from, to, amount, tx: "0xenergy", block: 4_200_000, idx }),
    address: token,
  });
  const RECEIPT = [
    USDG_OUT,
    other(VIRTUAL, PAIR_A, PAIR_B, 9n * 10n ** 19n, 6),
    other(MERRYMEN, PAIR_B, MERRYMEN, 2n * 10n ** 21n, 7),
    other(MERRYMEN, PAIR_B, ACCT, 98n * 10n ** 21n, 8),
  ];
  const rpc: RpcCall = async (method, params) => {
    if (method === "eth_getTransactionReceipt") {
      return { logs: params[0] === "0xenergy" ? RECEIPT : [DEPOSIT] };
    }
    const p = params[0] as { topics: (string | string[] | null)[] };
    return [DEPOSIT, USDG_OUT].filter((log) =>
      p.topics.every((want, i) => {
        if (want === null || want === undefined) return true;
        const list = Array.isArray(want) ? want : [want];
        return list.some((w) => w.toLowerCase() === String(log.topics[i]).toLowerCase());
      }),
    );
  };
  const sweep = (reserveTokens?: string[]) =>
    scanFleetCapital(rpc, { accounts: [ACCT], usdgToken: USDG, fromBlock: 0n, toBlock: 5_000_000n, reserveTokens });

  it("with the reserve named, the purchase is reserve-out and totalled as such", async () => {
    const cap = (await sweep([MERRYMEN])).get(ACCT)!;
    const m = cap.movements.find((x) => x.txHash === "0xenergy")!;
    assert.equal(m.classification.kind, "reserve-out");
    assert.equal(m.classification.evidence.rule, "reserve-purchase");
    assert.equal(m.logIndex, 5, "the identity reconstruction will key on");
    assert.equal(cap.totals.grossReservePurchasesRaw, "42000000");
    assert.equal(cap.totals.reservePurchases, 1);
    assert.equal(cap.totals.grossWithdrawalsRaw, "0", "not a withdrawal");
    assert.equal(cap.totals.netContributionsRaw, "-32000000", "10 in − 42 on energy");
    assert.equal(cap.complete, true);
  });

  it("without it, the same leg is the trade it always was", async () => {
    const cap = (await sweep()).get(ACCT)!;
    const m = cap.movements.find((x) => x.txHash === "0xenergy")!;
    assert.equal(m.classification.kind, "trade-out");
    assert.equal(cap.totals.grossReservePurchasesRaw, "0");
    assert.equal(cap.totals.tradeLegs, 1);
    assert.equal(cap.totals.netContributionsRaw, "10000000");
  });
});

/**
 * PERP MARGIN IN THE FLEET SWEEP (docs/perps.md rule 12).
 *
 * hwm-repair and reconstruction derive peaks from contributions, so they must
 * see margin exactly as the worker's ledger does: posted and paid back within
 * the book, never capital. Un-named, every payout Lighter's relayer sends home
 * reads as a fresh owner deposit and the derived peak is too high by every one.
 */
describe("perp margin in the fleet sweep", () => {
  const PROXY = "0x94bab9693ba2f6358507effcbd372b0660afff9d";
  const DEPOSIT_TOPIC = "0x493c3b8240368e8343bcd42cac5f4b8b161c06d061710e542a72f06a40ddd9d1";
  const WITHDRAW_PENDING_TOPIC = "0xef80235b5f4cf1822ad6a8621af41ac64372ff672c402874f507fc63dbe5e06f";
  const STRANGER = "0x7777777777777777777777777777777777777777";
  const word = (v: bigint | string) =>
    (typeof v === "string" ? v.toLowerCase().replace(/^0x/, "") : v.toString(16)).padStart(64, "0");
  const AMT = 82_973_191n;
  const event = (tx: string, block: number, idx: number, topics: string[], data: string) => ({
    address: PROXY,
    topics,
    data,
    blockNumber: "0x" + block.toString(16),
    transactionHash: tx,
    logIndex: "0x" + idx.toString(16),
  });
  /** A Transfer as a node returns it — `data` one full 32-byte word, which the venue rule reads strictly. */
  const canonical = (l: ReturnType<typeof transferLog>) => ({ ...l, data: `0x${word(BigInt(l.data))}` });
  const OUT = canonical(transferLog({ from: ACCT, to: PROXY, amount: AMT, tx: "0xmargin", block: 4_300_000, idx: 2 }));
  const DEPOSIT_EVT = event("0xmargin", 4_300_000, 4, [DEPOSIT_TOPIC], `0x${word(22_149n)}${word(ACCT)}${word(3n)}${word(0n)}${word(AMT)}`);
  const THEIRS_OUT = canonical(transferLog({ from: STRANGER, to: PROXY, amount: 135_000_000n, tx: "0xmargin", block: 4_300_000, idx: 5 }));
  const THEIRS_EVT = event("0xmargin", 4_300_000, 6, [DEPOSIT_TOPIC], `0x${word(30_001n)}${word(STRANGER)}${word(3n)}${word(0n)}${word(135_000_000n)}`);
  const IN = canonical(transferLog({ from: PROXY, to: ACCT, amount: 8_085_000_000n, tx: "0xpayout", block: 4_300_100, idx: 12 }));
  const WP = event("0xpayout", 4_300_100, 13, [WITHDRAW_PENDING_TOPIC, `0x${word(ACCT)}`], `0x${word(3n)}${word(8_085_000_000n)}`);
  const GIFT = transferLog({ from: ACCT, to: STRANGER, amount: 5_000_000n, tx: "0xgift", block: 4_300_200, idx: 0 });
  const RECEIPTS: Record<string, unknown[]> = {
    "0xmargin": [OUT, DEPOSIT_EVT, THEIRS_OUT, THEIRS_EVT],
    "0xpayout": [IN, WP],
    "0xgift": [GIFT],
    "0xfund": [DEPOSIT],
  };
  const rpc: RpcCall = async (method, params) => {
    if (method === "eth_getTransactionReceipt") return { logs: RECEIPTS[String(params[0])] ?? [] };
    const p = params[0] as { topics: (string | string[] | null)[] };
    return [DEPOSIT, OUT, THEIRS_OUT, IN, GIFT].filter((log) =>
      p.topics.every((want, i) => {
        if (want === null || want === undefined) return true;
        const list = Array.isArray(want) ? want : [want];
        return list.some((w) => w.toLowerCase() === String(log.topics[i]).toLowerCase());
      }),
    );
  };
  const sweep = (venueProxies?: readonly string[]) =>
    scanFleetCapital(rpc, { accounts: [ACCT], usdgToken: USDG, fromBlock: 0n, toBlock: 5_000_000n, venueProxies });

  it("OUR DEPOSIT AND A RELAYER PAYOUT TO US are margin — totalled apart, never capital", async () => {
    const cap = (await sweep(lighterVenueProxies(4663))).get(ACCT)!;
    const kind = (tx: string) => cap.movements.find((m) => m.txHash === tx)!.classification.kind;
    assert.equal(kind("0xmargin"), "margin-out", "a stranger's deposit in the same transaction changes nothing");
    assert.equal(kind("0xpayout"), "margin-in");
    assert.equal(kind("0xgift"), "capital-out", "a plain transfer to a stranger is still a withdrawal");
    assert.equal(cap.totals.grossMarginOutRaw, AMT.toString());
    assert.equal(cap.totals.grossMarginInRaw, "8085000000");
    assert.equal(cap.totals.grossContributionsRaw, "10000000", "only the owner's real deposit");
    assert.equal(cap.totals.grossWithdrawalsRaw, "5000000", "only the real withdrawal");
    assert.equal(cap.totals.ambiguous, 0);
    assert.equal(cap.complete, true);
  });

  it("the stranger's leg is not ours at all — the sweep never books another account's deposit", async () => {
    const cap = (await sweep(lighterVenueProxies(4663))).get(ACCT)!;
    assert.equal(cap.movements.filter((m) => m.txHash === "0xmargin").length, 1);
  });

  it("WITHOUT the venue named, the verdicts are exactly what they were before perps", async () => {
    const cap = (await sweep()).get(ACCT)!;
    const kind = (tx: string) => cap.movements.find((m) => m.txHash === tx)!.classification.kind;
    assert.equal(kind("0xmargin"), "capital-out");
    assert.equal(kind("0xpayout"), "capital-in");
    assert.equal(cap.totals.marginLegs, 0);
  });

  it("lighterVenueProxies names the venue only on Robinhood Chain", () => {
    assert.deepEqual(lighterVenueProxies(4663), [PROXY]);
    assert.deepEqual(lighterVenueProxies(46630), []);
  });
});
