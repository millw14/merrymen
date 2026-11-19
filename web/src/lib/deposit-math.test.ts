import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEPOSIT_SOURCES,
  ETH_SOURCES,
  agentGasOf,
  amountForUsd,
  formatAmount,
  formatFixed,
  maxSendable,
  parseAmount,
  reserveFor,
  reserveLine,
  truncateTo,
  usdMicrosOf,
} from "./deposit-math";

const base = DEPOSIT_SOURCES["eth-base"];
const ethereum = DEPOSIT_SOURCES["eth-ethereum"];
const sol = DEPOSIT_SOURCES["sol-solana"];
const ETH = 10n ** 18n;
const SOL = 10n ** 9n;

describe("amounts the owner types", () => {
  it("parses decimals exactly into base units", () => {
    assert.equal(parseAmount("1", 18), ETH);
    assert.equal(parseAmount("0.02", 18), 20_000_000_000_000_000n);
    assert.equal(parseAmount(".5", 9), 500_000_000n);
    assert.equal(parseAmount("12.", 6), 12_000_000n);
    assert.equal(parseAmount(" 0.25 ", 9), 250_000_000n);
    assert.equal(parseAmount("0", 18), 0n);
  });

  it("refuses rather than rounds anything that is not a plain decimal for this asset", () => {
    for (const text of ["", ".", "-1", "+1", "1e18", "1,000", "0x10", "1.2.3", "abc", "１"]) {
      assert.equal(parseAmount(text, 18), null, text);
    }
    // One digit past what SOL has: refused, not rounded down to a different amount.
    assert.equal(parseAmount("0.0000000001", 9), null);
  });

  it("formats by truncation, never rounding a figure up", () => {
    assert.equal(formatAmount(1_999_999_999_999_999_999n, 18, 6), "1.999999");
    assert.equal(formatAmount(20_000_000_000_000_000n, 18), "0.02");
    assert.equal(formatAmount(ETH, 18), "1");
    assert.equal(formatAmount(0n, 6, 2), "0");
    assert.equal(formatFixed(40_000_000n, 6, 2), "40.00");
    assert.equal(formatFixed(1_792_408_000n, 6, 2), "1792.40");
    assert.equal(formatFixed(0n, 6, 2), "0.00");
    assert.equal(formatAmount(35_729_935n, 6, 2), "35.72");
    assert.equal(truncateTo(1_234_567_890n, 9, 4), 1_234_500_000n);
  });

  it("reads Relay's dollar strings to six places, and nothing else", () => {
    assert.equal(usdMicrosOf("35.921563"), 35_921_563n);
    assert.equal(usdMicrosOf("18.6399571234"), 18_639_957n);
    assert.equal(usdMicrosOf("2"), 2_000_000n);
    for (const bad of [null, undefined, "", "-1", "1e3", "$2"]) assert.equal(usdMicrosOf(bad), null);
  });
});

describe("the reserve Max keeps on the source wallet", () => {
  it("uses the agreed floors", () => {
    assert.equal(reserveFor(ethereum), 2_000_000_000_000_000n); // 0.002 ETH
    for (const id of ["eth-base", "eth-arbitrum", "eth-robinhood"] as const) {
      assert.equal(reserveFor(DEPOSIT_SOURCES[id]), 300_000_000_000_000n, id); // 0.0003 ETH
    }
    assert.equal(reserveFor(sol), 5_000_000n); // 0.005 SOL
  });

  it("covers twice the transfer's own fee when that is larger than the floor", () => {
    // Base's measured fee (≈ 0.0000002 ETH) is far under the floor.
    assert.equal(reserveFor(base, 211_615_385_242n), base.floor);
    // A spike past half the floor takes over, so the wallet can still pay the next fee.
    assert.equal(reserveFor(base, 200_000_000_000_000n), 400_000_000_000_000n);
    assert.equal(reserveFor(base, 0n), base.floor);
    assert.equal(reserveFor(base, null), base.floor);
  });

  it("covers SOL rent plus a token account plus fees", () => {
    const rentExempt = 890_880n;
    const tokenAccountRent = 2_039_280n;
    const feeWithPriority = 105_000n;
    assert.ok(sol.floor > rentExempt + tokenAccountRent + feeWithPriority);
  });

  it("says what it keeps in one quiet line", () => {
    assert.equal(reserveLine(base, reserveFor(base)), "Max keeps 0.0003 ETH on Base so this wallet can pay its next fee.");
    assert.equal(reserveLine(sol, reserveFor(sol)), "Max keeps 0.005 SOL so your wallet stays open and can pay its next fee.");
    assert.equal(reserveLine(base, reserveFor(base), 1_114_000_000_000_000n),
      "Max keeps 0.0003 ETH on Base so this wallet can pay its next fee, and sets aside 0.001114 ETH for your agent's gas.");
  });
});

describe("Max", () => {
  it("is the balance less the reserve, truncated to the digits the field accepts", () => {
    const balance = 1_234_567_890_123_456_789n; // 1.234567890123456789 ETH
    const max = maxSendable(base, balance, base.floor);
    assert.equal(max.kind, "ok");
    if (max.kind !== "ok") return;
    assert.equal(max.amount, 1_234_267_000_000_000_000n); // 1.234267 ETH
    // Truncation only ever leaves MORE behind than the reserve.
    assert.ok(balance - max.amount >= base.floor);
  });

  it("is never negative, and says the wallet is short when the reserve is all there is", () => {
    for (const balance of [0n, 1n, base.floor - 1n, base.floor, base.floor + 1n]) {
      const max = maxSendable(base, balance, base.floor);
      assert.equal(max.kind, "short", String(balance));
    }
    const sol1 = maxSendable(sol, SOL, sol.floor);
    assert.deepEqual(sol1, { kind: "ok", amount: 995_000_000n, balance: SOL, reserve: sol.floor });
  });

  it("is unavailable, not zero, when the balance was not read", () => {
    assert.deepEqual(maxSendable(base, null, base.floor), { kind: "unread" });
  });

  it("covers every ETH source with the same rule", () => {
    for (const id of ETH_SOURCES) {
      const source = DEPOSIT_SOURCES[id];
      const max = maxSendable(source, ETH, reserveFor(source));
      assert.equal(max.kind, "ok", id);
      if (max.kind === "ok") assert.equal(max.amount, ETH - source.floor, id);
    }
  });
});

describe("the agent's own gas on Robinhood Chain", () => {
  it("asks for ETH only on a measured zero", () => {
    assert.deepEqual(agentGasOf("0"), { kind: "empty" });
    assert.deepEqual(agentGasOf("1"), { kind: "ok", wei: 1n });
  });

  it("does not ask for money it cannot see is missing", () => {
    for (const value of [null, undefined, "", "-1", "0x0", "1.5"]) {
      assert.deepEqual(agentGasOf(value), { kind: "unread" }, String(value));
    }
  });

  it("asks for nothing when the house pays its gas", () => {
    assert.deepEqual(agentGasOf("0", true), { kind: "sponsored" });
    assert.deepEqual(agentGasOf(null, true), { kind: "sponsored" });
  });

  it("sizes about two dollars of the source asset from the quote's own price, rounded up", () => {
    // 0.02 ETH priced at $35.921563 → $2 is 0.0011134…, rounded UP to 0.001114 ETH.
    const eth = amountForUsd(base, 20_000_000_000_000_000n, "35.921563");
    assert.equal(eth, 1_114_000_000_000_000n);
    // 0.25 SOL priced at $18.639957 → $2 is 0.02682…, rounded UP to 0.0269 SOL.
    const s = amountForUsd(sol, 250_000_000n, "18.639957");
    assert.equal(s, 26_900_000n);
    assert.equal(amountForUsd(base, 20_000_000_000_000_000n, null), null);
    assert.equal(amountForUsd(base, 20_000_000_000_000_000n, "0"), null);
    assert.equal(amountForUsd(base, 0n, "35.9"), null);
  });
});
