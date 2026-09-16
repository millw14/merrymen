import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CASH, STOCK_TOKENS } from "../../../packages/core/src/index";
import { FEED_STALE_AFTER_SEC, classifyQuote, depthUsd6, readQuotePrices, spendInQuoteRaw } from "./quote-assets";

/**
 * PRICEABLE AND EXECUTABLE ARE DIFFERENT QUESTIONS, and this module keeps
 * them apart: the research universe is every quote the repo can PRICE; the
 * live universe is still USDG alone until a multi-quote route is proven.
 */

const NVDA = STOCK_TOKENS.find((t) => t.symbol === "NVDA")!;

describe("classifying a quote asset", () => {
  it("USDG is the only executable quote, and it needs no feed", () => {
    const q = classifyQuote(CASH.USDG as `0x${string}`);
    assert.equal(q.kind, "usdg");
    assert.equal(q.executable, true);
    assert.equal(q.feed, null);
  });

  it("native ETH is priceable through the ETH/USD feed and unexecutable for a stated reason", () => {
    const q = classifyQuote("0x0000000000000000000000000000000000000000");
    assert.equal(q.kind, "native-eth");
    assert.ok(q.feed);
    assert.equal(q.executable, false);
    assert.match(q.executableWhy ?? "", /valueLimit 0/);
  });

  it("a registry stock token is priceable through its own feed and unexecutable until the route is proven", () => {
    const q = classifyQuote(NVDA.address.toUpperCase() as `0x${string}`);
    assert.equal(q.kind, "stock");
    assert.equal(q.symbol, "NVDA");
    assert.equal(q.feed, NVDA.chainlinkFeed);
    assert.match(q.executableWhy ?? "", /multi-quote route is not yet proven/);
  });

  it("an unknown asset is neither priceable nor executable, and is named by address", () => {
    const q = classifyQuote("0x1234567890123456789012345678901234567890");
    assert.equal(q.kind, "unknown");
    assert.equal(q.feed, null);
    assert.match(q.symbol, /^0x1234…7890$/);
  });
});

describe("USD arithmetic in the class route's own unit (6dp)", () => {
  it("depth: 2 NVDA at 180 USD is 360 USD", () => {
    assert.equal(depthUsd6(2n * 10n ** 18n, 18, 180_00000000n), 360_000000n);
  });

  it("depth: USDG at a dollar is the identity", () => {
    assert.equal(depthUsd6(250_000000n, 6, 100_000000n), 250_000000n);
  });

  it("spend: 5 USD into an NVDA-quoted curve is 5/180 NVDA in raw units", () => {
    const raw = spendInQuoteRaw(5_000000n, 18, 180_00000000n)!;
    // 0.02777… NVDA
    assert.equal(raw, (5n * 10n ** 18n) / 180n);
  });

  it("a split changes the multiplier, not the value: 2-for-1 halves the price and doubles the multiplier", () => {
    // 2 raw NVDA at 90 USD with multiplier 2.0 is the same 360 USD.
    assert.equal(depthUsd6(2n * 10n ** 18n, 18, 90_00000000n, 2n * 10n ** 18n), 360_000000n);
    // …and 5 USD buys the same number of RAW units either way.
    assert.equal(spendInQuoteRaw(5_000000n, 18, 90_00000000n, 2n * 10n ** 18n), spendInQuoteRaw(5_000000n, 18, 180_00000000n));
  });

  it("unpriced is null, never zero", () => {
    assert.equal(depthUsd6(1n, 18, null), null);
    assert.equal(spendInQuoteRaw(5_000000n, 18, null), null);
  });
});

describe("reading quote prices", () => {
  it("USDG is a constant; feeds are read in one multicall; a failed feed is absent, not zero; staleness follows the 2h rule", async () => {
    const now = 1_800_000_000;
    const fresh = [1n, 180_00000000n, 0n, BigInt(now - 60), 1n];
    const old = [1n, 2400_00000000n, 0n, BigInt(now - FEED_STALE_AFTER_SEC - 1), 1n];
    const client = {
      async multicall({ contracts }: { contracts: readonly { address: string; functionName: string }[] }) {
        return contracts.map((c) =>
          c.functionName === "uiMultiplier"
            ? { status: "success", result: 10n ** 18n }
            : c.address === NVDA.chainlinkFeed
              ? { status: "success", result: fresh }
              : c.address.toLowerCase() === "0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9"
                ? { status: "success", result: old }
                : { status: "failure" },
        );
      },
    };
    const quotes = [classifyQuote(CASH.USDG as `0x${string}`), classifyQuote(NVDA.address), classifyQuote("0x0000000000000000000000000000000000000000")];
    const prices = await readQuotePrices(client as never, quotes, now);
    assert.deepEqual(prices.get(quotes[0]!.address), { usd8: 100_000000n, uiMultiplier: 10n ** 18n, updatedAt: null, stale: false, source: "constant" });
    assert.equal(prices.get(quotes[1]!.address)?.usd8, 180_00000000n);
    assert.equal(prices.get(quotes[1]!.address)?.uiMultiplier, 10n ** 18n, "a stock quote carries its ERC-8056 multiplier");
    assert.equal(prices.get(quotes[1]!.address)?.stale, false);
    assert.equal(prices.get(quotes[2]!.address)?.stale, true, "ETH/USD older than 2h reads stale");
  });

  it("a stock whose multiplier will not read is left unpriced — a price without its multiplier is a wrong price", async () => {
    const now = 1_800_000_000;
    const client = {
      async multicall({ contracts }: { contracts: readonly { address: string; functionName: string }[] }) {
        return contracts.map((c) => (c.functionName === "uiMultiplier" ? { status: "failure" } : { status: "success", result: [1n, 180_00000000n, 0n, BigInt(now), 1n] }));
      },
    };
    const prices = await readQuotePrices(client as never, [classifyQuote(NVDA.address)], now);
    assert.equal(prices.get(NVDA.address.toLowerCase()), undefined);
  });
});
