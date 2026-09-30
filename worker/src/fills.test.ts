import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fillFromDeltas, netTokenDeltas, slippageBpsAgainst, type ReceiptLog } from "./fills";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ME = "0x00000000000000000000000000000000000000a1";
const ROUTER = "0x00000000000000000000000000000000000000b2";
const STRANGER = "0x00000000000000000000000000000000000000c3";
const USDG = "0x0000000000000000000000000000000000000dd0";
const NVDA = "0x0000000000000000000000000000000000000ee0";

const topic = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2)}`;
const hex = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const transfer = (token: string, from: string, to: string, value: bigint): ReceiptLog => ({
  address: token,
  topics: [TRANSFER, topic(from), topic(to)],
  data: hex(value),
});

const ONE = 10n ** 18n;
const usdg = (v: number) => BigInt(Math.round(v * 1e6));

it("values a discovered six-decimal token from its receipt without an 18-decimal assumption", () => {
  const fill=fillFromDeltas({deltas:new Map([[USDG,-5_000_000n],[NVDA,250_000_000n]]),usdgToken:USDG,stockToken:NVDA,symbol:"COIN",decimals:6});
  assert.equal(fill?.priceUsd,0.02);
  assert.equal(fill?.qtyRaw,250_000_000n);
  assert.equal(fill?.cashUsdg,5_000_000n);
});

describe("netTokenDeltas — the account's own ledger, not the transaction's", () => {
  it("nets a buy: USDG out, stock in", () => {
    const d = netTokenDeltas(
      [transfer(USDG, ME, ROUTER, usdg(50)), transfer(NVDA, ROUTER, ME, ONE / 4n)],
      ME,
    );
    assert.equal(d.get(USDG), -usdg(50));
    assert.equal(d.get(NVDA), ONE / 4n);
  });

  it("ignores legs between other parties in the same receipt", () => {
    // A router's internal hops are in the same receipt and are not our fill.
    const d = netTokenDeltas(
      [
        transfer(USDG, ME, ROUTER, usdg(50)),
        transfer(USDG, ROUTER, STRANGER, usdg(50)),
        transfer(NVDA, STRANGER, ROUTER, ONE),
        transfer(NVDA, ROUTER, ME, ONE / 4n),
      ],
      ME,
    );
    assert.equal(d.get(USDG), -usdg(50));
    assert.equal(d.get(NVDA), ONE / 4n);
  });

  it("a token that arrives and leaves within one op moved nothing", () => {
    const d = netTokenDeltas(
      [transfer(NVDA, ROUTER, ME, ONE), transfer(NVDA, ME, ROUTER, ONE)],
      ME,
    );
    assert.equal(d.get(NVDA), 0n);
  });

  it("skips non-Transfer logs, short topic lists and malformed data", () => {
    const d = netTokenDeltas(
      [
        { address: NVDA, topics: ["0xdeadbeef", topic(ROUTER), topic(ME)], data: hex(ONE) },
        { address: NVDA, topics: [TRANSFER, topic(ME)], data: hex(ONE) },
        { address: NVDA, topics: [TRANSFER, topic(ROUTER), topic(ME)], data: "not-hex" },
        transfer(NVDA, ROUTER, ME, ONE),
      ],
      ME,
    );
    assert.equal(d.get(NVDA), ONE);
  });

  it("is case-insensitive about addresses (receipts are checksummed)", () => {
    const d = netTokenDeltas([transfer(NVDA.toUpperCase(), ROUTER, ME.toUpperCase(), ONE)], ME);
    assert.equal(d.get(NVDA.toLowerCase()), ONE);
  });
});

describe("fillFromDeltas", () => {
  const deltas = (u: bigint, s: bigint) =>
    new Map([
      [USDG, u],
      [NVDA, s],
    ]);

  it("books a buy at the RECEIVED quantity, not a slippage floor", () => {
    // 50 USDG paid, 0.25 NVDA actually received → $200.00.
    const f = fillFromDeltas({ deltas: deltas(-usdg(50), ONE / 4n), usdgToken: USDG, stockToken: NVDA, symbol: "NVDA" })!;
    assert.equal(f.side, "buy");
    assert.equal(f.qtyRaw, ONE / 4n);
    assert.equal(f.cashUsdg, usdg(50));
    assert.equal(f.priceUsd, 200);
  });

  it("books a sell at the proceeds actually received", () => {
    const f = fillFromDeltas({ deltas: deltas(usdg(60), -(ONE / 4n)), usdgToken: USDG, stockToken: NVDA, symbol: "NVDA" })!;
    assert.equal(f.side, "sell");
    assert.equal(f.qtyRaw, ONE / 4n);
    assert.equal(f.cashUsdg, usdg(60));
  });

  it("the quantity a full exit later sells MATCHES what the buy booked", () => {
    // This is the bug in one assertion. The old path booked minOut on the buy,
    // the strategy then sold the real on-chain balance, the sell exceeded the
    // tracked basis, and applyFill wrote NULL realized P&L for the round trip.
    const received = ONE / 4n + 12_345n; // a real fill, not a round number
    const buy = fillFromDeltas({ deltas: deltas(-usdg(50), received), usdgToken: USDG, stockToken: NVDA, symbol: "NVDA" })!;
    assert.equal(buy.qtyRaw, received);
  });

  it("refuses to guess when a leg is missing", () => {
    assert.equal(
      fillFromDeltas({ deltas: deltas(-usdg(50), 0n), usdgToken: USDG, stockToken: NVDA, symbol: "NVDA" }),
      null,
    );
  });

  it("refuses when both legs moved the same way — that is not a swap", () => {
    assert.equal(
      fillFromDeltas({ deltas: deltas(usdg(50), ONE), usdgToken: USDG, stockToken: NVDA, symbol: "NVDA" }),
      null,
    );
  });
});

describe("slippageBpsAgainst", () => {
  it("reports a worse-than-quoted fill as positive bps", () => {
    assert.equal(slippageBpsAgainst(10_000n, 9_900n), 100); // 1% worse
  });

  it("reports a better-than-quoted fill as negative", () => {
    assert.equal(slippageBpsAgainst(10_000n, 10_050n), -50);
  });

  it("is null when there is nothing to compare against", () => {
    assert.equal(slippageBpsAgainst(0n, 10n), null);
  });
});
