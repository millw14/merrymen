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
import { contributionFloorUsdg, energyBookingGate, energyFlowFromReceipt, energyPreTradeGate } from "./energy-accounting";
import { TRANSFER_TOPIC } from "./deposit-log";
import type { ReceiptLog } from "./fills";
import { rejectRuleLabel, rejectRuleRemedy } from "./thesis-policy";

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

  it("a contribution record of ZERO is a record, not none — refused for what spending would do to it, never as 'no record'", () => {
    const v = energyPreTradeGate(book({ netContributionsUsdg: 0n }));
    assert.equal(v.action === "refuse" && v.rule, "would-exhaust-contributions");
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

  it("THE PROFIT-FUNDED CASE: funded 20, made 30, peak 50 — the ask that would leave nothing contributed is refused", () => {
    // Before this rule every ask passed (the peak stayed above the spend and
    // the drawdown was 0) while net contributions went 20 → 10 → 0 → −10: an
    // agent the Brain then held on every decision and the board called
    // 'no-deposit', or one whose published return was P&L over a sliver.
    const ask = (net: number, equity: number) =>
      energyPreTradeGate(book({ netContributionsUsdg: u(net), equityUsdg: u(equity), lifetimePeakUsdg: u(equity), breakerPeakUsdg: u(equity), spendUsdg: u(10) }));
    assert.equal(ask(20, 50).action, "book", "20 → 10 leaves capital on record");
    const second = ask(10, 40);
    assert.equal(second.action === "refuse" && second.rule, "would-exhaust-contributions", "10 → 0 is refused");
    const third = ask(0, 30);
    assert.equal(third.action === "refuse" && third.rule, "would-exhaust-contributions");
    // And "something left" is not enough: a micro-USDG left is a sliver (below).
    assert.equal(energyPreTradeGate(book({ netContributionsUsdg: u(10) + 1n, spendUsdg: u(10) })).action, "refuse");
  });

  it("A SLIVER IS REFUSED TOO — funded 20, grown to 50, a 19 USDG ask would leave 1 on record", () => {
    // Stopping only at zero let this through, and the board then published
    // (50 − 19 − 1)/1 as the agent's return. The floor is a tenth of what is
    // on record before the purchase, never under 1 USDG: 2 USDG here.
    const sliver = energyPreTradeGate(
      book({ netContributionsUsdg: u(20), equityUsdg: u(50), lifetimePeakUsdg: u(50), breakerPeakUsdg: u(50), spendUsdg: u(19) }),
    );
    assert.equal(sliver.action === "refuse" && sliver.rule, "would-exhaust-contributions");
    const why = sliver.action === "refuse" ? sliver.why : "";
    assert.match(why, /would leave only 1\.00 of the 20\.00 USDG of capital on record for me — I keep at least 2\.00/);
    assert.match(why, /send USDG to me first and ask again, or send \$MERRYMEN to my account directly$/);
    assert.doesNotMatch(why, /price|returns?\b|profit|investment|moon|\d+\s*%/i);
    // 18 leaves exactly the floor, and is booked.
    const at = energyPreTradeGate(
      book({ netContributionsUsdg: u(20), equityUsdg: u(50), lifetimePeakUsdg: u(50), breakerPeakUsdg: u(50), spendUsdg: u(18) }),
    );
    assert.equal(at.action, "book");
    assert.equal(
      energyPreTradeGate(book({ netContributionsUsdg: u(20), equityUsdg: u(50), lifetimePeakUsdg: u(50), breakerPeakUsdg: u(50), spendUsdg: u(18) + 1n })).action,
      "refuse",
      "one micro-USDG under the floor",
    );
  });

  it("the floor is a tenth of what is on record, and never under 1 USDG", () => {
    assert.equal(contributionFloorUsdg(u(100)), u(10));
    assert.equal(contributionFloorUsdg(u(20)), u(2));
    assert.equal(contributionFloorUsdg(u(10)), u(1));
    assert.equal(contributionFloorUsdg(u(5)), u(1), "small books keep a whole USDG");
    assert.equal(contributionFloorUsdg(0n), u(1));
    assert.equal(contributionFloorUsdg(-u(3)), u(1));
    // A small book: 5 on record, 4 spent leaves 1 — exactly the floor.
    assert.equal(energyPreTradeGate(book({ netContributionsUsdg: u(5), spendUsdg: u(4) })).action, "book");
    assert.equal(energyPreTradeGate(book({ netContributionsUsdg: u(5), spendUsdg: u(4) + 1n })).action, "refuse");
  });

  it("its sentence says what to do — USDG first, then ask again — in capital words only", () => {
    const v = energyPreTradeGate(book({ netContributionsUsdg: u(10), spendUsdg: u(10) }));
    assert.equal(v.action, "refuse");
    const why = v.action === "refuse" ? v.why : "";
    assert.match(why, /spending 10\.00 USDG on energy would use up all 10\.00 USDG of capital on record for me/);
    assert.match(why, /send USDG to me first and ask again, or send \$MERRYMEN to my account directly/);
    assert.doesNotMatch(why, /price|returns?\b|profit|investment|moon|\d+\s*%/i);
  });

  it("the rule has public words and an owner remedy, so it never reaches a surface as a slug", () => {
    const label = rejectRuleLabel("would-exhaust-contributions");
    const remedy = rejectRuleRemedy("would-exhaust-contributions");
    assert.ok(label && remedy);
    assert.ok(!label.includes("would-exhaust"), "never the slug echoed back");
    assert.doesNotMatch(label, /\/grant|\/settings/, "the public sentence names no URL");
    assert.match(remedy, /Send USDG to the agent's account first, then ask for energy again/);
    assert.doesNotMatch(`${label} ${remedy}`, /price|returns?\b|profit|investment|\d+\s*%/i);
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
