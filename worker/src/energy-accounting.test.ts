/**
 * The pure half of booking an energy purchase: what the receipt says moved, and
 * whether the book can take it.
 *
 * The receipt fixtures are the real route's shape — USDG -> VIRTUAL -> $MERRYMEN
 * over two Uniswap v2 pairs, the buy tax skimmed to the token contract — so the
 * classifier is exercised on the four legs a mainnet purchase actually emits.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { energyBookingGate, energyFlowFromReceipt, energyPreTradeGate } from "./energy-accounting";
import { TRANSFER_TOPIC } from "./deposit-log";
import type { ReceiptLog } from "./fills";

const ACCOUNT = "0x00000000000000000000000000000000000000A1";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const VIRTUAL = "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31";
const MERRYMEN = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";
const TSLA = "0x322f0929c4625ed5bad873c95208d54e1c003b2d";
const PAIR_A = "0x00000000000000000000000000000000000000b1";
const PAIR_B = "0x00000000000000000000000000000000000000b2";

const topic = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;
const transfer = (
  token: string,
  from: string,
  to: string,
  amount: bigint,
  logIndex?: number | string | null,
  blockNumber?: bigint | number | string | null,
): ReceiptLog => ({
  address: token,
  topics: [TRANSFER_TOPIC, topic(from), topic(to)],
  data: `0x${amount.toString(16).padStart(64, "0")}`,
  ...(logIndex === undefined ? {} : { logIndex }),
  ...(blockNumber === undefined ? {} : { blockNumber }),
});

/** A 41.500000 USDG energy purchase landing in block 9,000,001. */
const energyReceipt = (over: { usdgLogIndex?: number | string | null; usdgBlock?: bigint | null } = {}) => [
  transfer(USDG, ACCOUNT, PAIR_A, 41_500_000n, over.usdgLogIndex === undefined ? 17 : over.usdgLogIndex, over.usdgBlock === undefined ? 9_000_001n : over.usdgBlock),
  transfer(VIRTUAL, PAIR_A, PAIR_B, 90n * 10n ** 18n, 18, 9_000_001n),
  transfer(MERRYMEN, PAIR_B, MERRYMEN, 2_000n * 10n ** 18n, 19, 9_000_001n),
  transfer(MERRYMEN, PAIR_B, ACCOUNT, 98_000n * 10n ** 18n, 20, 9_000_001n),
];

const read = (logs: ReceiptLog[] | null, extra: { blockNumber?: bigint | number | null; reserveTokens?: string[] } = {}) =>
  energyFlowFromReceipt({
    account: ACCOUNT,
    usdgToken: USDG,
    reserveTokens: extra.reserveTokens ?? [MERRYMEN],
    logs,
    blockNumber: extra.blockNumber,
  });

describe("energyFlowFromReceipt", () => {
  it("one USDG leg out plus the reserve in: ok, with amount, log index and block read off the LOG", () => {
    const r = read(energyReceipt(), { blockNumber: 1n });
    assert.deepEqual(r, { ok: true, amountUsdg6: 41_500_000n, logIndex: 17, blockNumber: 9_000_001 });
  });

  it("a hex log index (a raw RPC log) is read too", () => {
    const r = read(energyReceipt({ usdgLogIndex: "0x11" }));
    assert.equal(r.ok && r.logIndex, 17);
  });

  it("the receipt's block stands in when the log carries none", () => {
    const r = read(energyReceipt({ usdgBlock: null }), { blockNumber: 9_000_002n });
    assert.equal(r.ok && r.blockNumber, 9_000_002);
  });

  it("two USDG legs out: not ok — there is no honest way to say which bought the energy", () => {
    const logs = [...energyReceipt(), transfer(USDG, ACCOUNT, "0x00000000000000000000000000000000000000f1", 10_000n, 21, 9_000_001n)];
    const r = read(logs);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.unreadable, false);
    assert.match(!r.ok ? r.why : "", /2 USDG transfers/);
  });

  it("no reserve leg: not ok, and NOT unreadable — it was read, and it is not an energy purchase", () => {
    const logs = [transfer(USDG, ACCOUNT, PAIR_A, 5_000_000n, 3, 9_000_001n), transfer(TSLA, PAIR_A, ACCOUNT, 10n ** 16n, 4, 9_000_001n)];
    const r = read(logs);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.unreadable, false);
    assert.match(!r.ok ? r.why : "", /trade-out/);
  });

  it("a mixed batch (the reserve AND a position arriving) is not an energy purchase", () => {
    const r = read([...energyReceipt(), transfer(TSLA, PAIR_A, ACCOUNT, 10n ** 16n, 21, 9_000_001n)]);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.unreadable, false);
  });

  it("with no reserve tokens named (another chain), the same receipt is not booked as energy", () => {
    const r = read(energyReceipt(), { reserveTokens: [] });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.unreadable, false);
  });

  it("missing log index: unreadable — the caller re-reads the receipt rather than booking loosely", () => {
    for (const idx of [null, "", "not-a-number"]) {
      const r = read(energyReceipt({ usdgLogIndex: idx }));
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.unreadable, true, `log index ${String(idx)}`);
    }
  });

  it("missing block number everywhere (or the executor's 0n placeholder): unreadable", () => {
    assert.equal(read(energyReceipt({ usdgBlock: null })).ok, false);
    const r = read(energyReceipt({ usdgBlock: null }), { blockNumber: 0n });
    assert.equal(!r.ok && r.unreadable, true);
  });

  it("no logs at all: unreadable — a landed swap always emits Transfers", () => {
    for (const logs of [null, []]) {
      const r = read(logs);
      assert.equal(!r.ok && r.unreadable, true);
    }
  });

  it("no USDG leaving the account: not ok, not unreadable", () => {
    const r = read([transfer(MERRYMEN, PAIR_B, ACCOUNT, 1n, 1, 5n)]);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.unreadable, false);
  });

  it("an ERC-721 Transfer (four topics) is not read as a leg", () => {
    const nft: ReceiptLog = { ...transfer(USDG, ACCOUNT, PAIR_A, 7n, 30, 9_000_001n) };
    const fourTopics = { ...nft, topics: [...nft.topics, topic("0x01")] };
    const r = read([...energyReceipt(), fourTopics]);
    assert.equal(r.ok, true, "the four-topic log is not a second USDG leg");
  });
});

// ── the gates ───────────────────────────────────────────────────────────────

const u = (v: number) => BigInt(Math.round(v * 1e6));
const book = (over: Partial<Parameters<typeof energyPreTradeGate>[0]> = {}): Parameters<typeof energyPreTradeGate>[0] => ({
  paper: false,
  equityKnown: true,
  equityUsdg: u(100),
  spendUsdg: u(42),
  netContributionsUsdg: u(100),
  lifetimePeakUsdg: u(100),
  breakerPeakUsdg: u(100),
  maxDrawdownBps: 500,
  ...over,
});

describe("energyPreTradeGate", () => {
  it("equity unknown → refuse book-untotalled", () => {
    const v = energyPreTradeGate(book({ equityKnown: false }));
    assert.equal(v.action === "refuse" && v.rule, "book-untotalled");
  });

  it("no contribution record, live → refuse", () => {
    const v = energyPreTradeGate(book({ netContributionsUsdg: null }));
    assert.equal(v.action === "refuse" && v.rule, "no-contribution-record");
  });

  it("no contribution record, paper → skip (no real-capital record at all)", () => {
    assert.equal(energyPreTradeGate(book({ paper: true, netContributionsUsdg: null })).action, "skip");
  });

  it("a contribution record of ZERO is a record, not none", () => {
    assert.equal(energyPreTradeGate(book({ netContributionsUsdg: 0n })).action, "book");
  });

  it("lifetime peak below the spend → peak-below-spend", () => {
    const v = energyPreTradeGate(book({ lifetimePeakUsdg: u(41) }));
    assert.equal(v.action === "refuse" && v.rule, "peak-below-spend");
  });

  it("breaker peak EQUAL to the spend → peak-below-spend (a zero peak switches the breaker off)", () => {
    const v = energyPreTradeGate(book({ breakerPeakUsdg: u(42), equityUsdg: u(42) }));
    assert.equal(v.action === "refuse" && v.rule, "peak-below-spend");
  });

  it("the lifetime peak may equal the spend — it is not the breaker's divisor", () => {
    assert.equal(energyPreTradeGate(book({ lifetimePeakUsdg: u(42) })).action, "book");
  });

  it("P=100, E=97, s=42 at 500bps → would-trip-breaker (3% becomes 5.2%)", () => {
    const v = energyPreTradeGate(book({ equityUsdg: u(97) }));
    assert.equal(v.action === "refuse" && v.rule, "would-trip-breaker");
    assert.match(v.action === "refuse" ? v.why : "", /517bps against its 500bps limit/);
  });

  it("P=100, E=100, s=42 → book", () => {
    assert.deepEqual(energyPreTradeGate(book()), { action: "book" });
  });

  it("agrees with policy.ts at the boundary: exactly AT the cap after the purchase refuses", () => {
    // (P−E)/(P−s) = 2.9/58 = 500bps exactly. policy.ts refuses at >=.
    const v = energyPreTradeGate(book({ equityUsdg: u(97.1) }));
    assert.equal(v.action === "refuse" && v.rule, "would-trip-breaker");
    // One micro-USDG better and the purchase fits under the cap.
    assert.equal(energyPreTradeGate(book({ equityUsdg: u(97.1) + 1n })).action, "book");
  });

  it("equity above the peak never trips", () => {
    assert.equal(energyPreTradeGate(book({ equityUsdg: u(120) })).action, "book");
  });

  it("every refusal says how to get energy another way, and never promises anything about the token", () => {
    for (const v of [
      energyPreTradeGate(book({ netContributionsUsdg: null })),
      energyPreTradeGate(book({ breakerPeakUsdg: u(42) })),
      energyPreTradeGate(book({ equityUsdg: u(97) })),
    ]) {
      assert.equal(v.action, "refuse");
      const why = v.action === "refuse" ? v.why : "";
      assert.match(why, /send \$MERRYMEN to its account directly/);
      assert.doesNotMatch(why, /price|return|profit|moon/i);
    }
  });
});

describe("energyBookingGate", () => {
  const landed = (over: Partial<Parameters<typeof energyBookingGate>[0]> = {}) => ({
    paper: false,
    spendUsdg: u(42),
    netContributionsUsdg: u(100) as bigint | null,
    lifetimePeakUsdg: u(100),
    breakerPeakUsdg: u(100),
    ...over,
  });

  it("books a landed purchase that fits", () => {
    assert.deepEqual(energyBookingGate(landed()), { action: "book" });
  });

  it("has NO drawdown test — the money has moved, and a phantom drawdown is worse than an honest one", () => {
    // The exact book the pre-trade gate refuses. After landing it is booked:
    // leaving it unbooked would make the spend itself read as a drawdown.
    assert.equal(energyPreTradeGate(book({ equityUsdg: u(97) })).action, "refuse");
    assert.equal(energyBookingGate(landed()).action, "book");
    assert.equal("equityUsdg" in landed(), false, "and it does not even take equity");
  });

  it("refuses a lone out-flow on an unrecorded live account; skips on paper", () => {
    const v = energyBookingGate(landed({ netContributionsUsdg: null }));
    assert.equal(v.action === "refuse" && v.rule, "no-contribution-record");
    assert.equal(energyBookingGate(landed({ paper: true, netContributionsUsdg: null })).action, "skip");
  });

  it("refuses to clamp a peak to zero", () => {
    const v = energyBookingGate(landed({ breakerPeakUsdg: u(42) }));
    assert.equal(v.action === "refuse" && v.rule, "peak-below-spend");
    const w = energyBookingGate(landed({ lifetimePeakUsdg: u(10) }));
    assert.equal(w.action === "refuse" && w.rule, "peak-below-spend");
  });
});
