import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CASH } from "@merrymen/core";
import { DEPOSIT_SOURCES, type DepositSource } from "./deposit-math";
import {
  PRICE_SENDER,
  etaText,
  parseRelayPrice,
  priceRequest,
  relayDeepLink,
  routeLabel,
  usdgText,
} from "./relay-deposit";

const AGENT = "0x1111111111111111111111111111111111111111";
const base = DEPOSIT_SOURCES["eth-base"];
const robinhood = DEPOSIT_SOURCES["eth-robinhood"];
const sol = DEPOSIT_SOURCES["sol-solana"];

/**
 * The shape of Relay's `/price` answer, trimmed to the fields read, with the
 * figures of the live Base and Solana answers taken on 2026-11-19 (dummy
 * recipient, no wallet).
 */
function relayPrice(source: DepositSource, amount: string, over: { out?: string; min?: string; slippage?: string; recipient?: string; outToken?: string; outChain?: number; outDecimals?: number; inChain?: number; inAmount?: string; eta?: unknown; app?: string } = {}) {
  const sourceCurrency = { chainId: source.relayChainId, address: source.currency, symbol: source.asset, decimals: source.decimals };
  return {
    fees: {
      gas: { currency: sourceCurrency, amount: source.family === "solana" ? "8975" : "211615385242", amountUsd: source.family === "solana" ? "0.000669" : "0.000398" },
      relayer: { currency: sourceCurrency, amount: source.family === "solana" ? "851245" : "26897566254439", amountUsd: source.family === "solana" ? "0.063469" : "0.048310" },
      app: { currency: sourceCurrency, amount: over.app ?? "0", amountUsd: "0" },
    },
    details: {
      operation: "swap",
      sender: PRICE_SENDER[source.family],
      recipient: over.recipient ?? AGENT,
      currencyIn: { currency: { ...sourceCurrency, chainId: over.inChain ?? source.relayChainId }, amount: over.inAmount ?? amount, amountUsd: source.family === "solana" ? "18.639957" : "35.921563" },
      currencyOut: {
        currency: { chainId: over.outChain ?? 4663, address: over.outToken ?? "0x5fc5360d0400a0fd4f2af552add042d716f1d168", symbol: "USDG", decimals: over.outDecimals ?? 6 },
        amount: over.out ?? (source.family === "solana" ? "18540697" : "35850921"),
        minimumAmount: over.min ?? (source.family === "solana" ? "18355290" : "35671666"),
        amountUsd: "35.84",
      },
      totalImpact: { usd: "-0.090568", percent: "-0.25" },
      slippageTolerance: { total: over.slippage ?? String(source.slippageBps) },
      timeEstimate: over.eta ?? 1,
    },
  };
}

const AMOUNT = 20_000_000_000_000_000n;

describe("asking Relay for a price", () => {
  it("prices into USDG at the agent, with our slippage cap and nobody's wallet as the sender", () => {
    assert.deepEqual(priceRequest(base, AMOUNT, AGENT), {
      user: "0x0000000000000000000000000000000000000001",
      recipient: AGENT,
      originChainId: 8453,
      destinationChainId: 4663,
      originCurrency: "0x0000000000000000000000000000000000000000",
      destinationCurrency: CASH.USDG,
      amount: "20000000000000000",
      tradeType: "EXACT_INPUT",
      slippageTolerance: "50",
    });
    const s = priceRequest(sol, 250_000_000n, AGENT);
    assert.equal(s.user, "11111111111111111111111111111111");
    assert.equal(s.originChainId, 792703809);
    assert.equal(s.originCurrency, "11111111111111111111111111111111");
    assert.equal(s.slippageTolerance, "100");
    assert.equal(priceRequest(robinhood, AMOUNT, AGENT).originChainId, 4663);
  });
});

describe("reading Relay's answer", () => {
  it("turns a matching answer into a quote: amount in, minimum out, route, fees, slippage and ETA", () => {
    const parsed = parseRelayPrice(relayPrice(base, AMOUNT.toString()), { source: base, amount: AMOUNT, agent: AGENT });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const q = parsed.quote;
    assert.equal(q.amountIn, AMOUNT);
    assert.equal(q.amountInUsd, "35.921563");
    assert.equal(q.expectedOut, 35_850_921n);
    assert.equal(q.minOut, 35_671_666n);
    assert.equal(q.slippageBps, 50);
    assert.equal(q.etaSeconds, 1);
    assert.equal(q.impactPercent, "0.25");
    assert.equal(q.route, "Relay: ETH on Base → USDG on Robinhood Chain");
    assert.deepEqual(q.fees.map((f) => [f.label, f.symbol, f.usd]), [["Relay fee", "ETH", "0.048310"], ["Network fee on Base", "ETH", "0.000398"]]);
    assert.equal(q.sourceNetworkFee, 211_615_385_242n);
  });

  it("reads the Solana answer the same way", () => {
    const parsed = parseRelayPrice(relayPrice(sol, "250000000"), { source: sol, amount: 250_000_000n, agent: AGENT });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.quote.minOut, 18_355_290n);
    assert.equal(parsed.quote.slippageBps, 100);
    assert.equal(parsed.quote.sourceNetworkFee, 8975n);
    assert.equal(parsed.quote.route, "Relay: SOL on Solana → USDG on Robinhood Chain");
  });

  it("shows an app fee if one ever appears, rather than hiding it", () => {
    const parsed = parseRelayPrice(relayPrice(base, AMOUNT.toString(), { app: "1000" }), { source: base, amount: AMOUNT, agent: AGENT });
    assert.ok(parsed.ok && parsed.quote.fees.some((f) => f.label === "App fee"));
  });

  it("refuses an answer for anything other than what was asked", () => {
    const cases: [string, Parameters<typeof relayPrice>[2]][] = [
      ["recipient", { recipient: "0x2222222222222222222222222222222222222222" }],
      ["output token", { outToken: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" }],
      ["output network", { outChain: 8453 }],
      ["output decimals", { outDecimals: 18 }],
      ["input network", { inChain: 1 }],
      ["input amount", { inAmount: "1" }],
      ["slippage", { slippage: "200" }],
      ["output amount", { min: "40000000" }],
      ["output amount", { out: "0", min: "0" }],
      ["time estimate", { eta: "soon" }],
    ];
    for (const [what, over] of cases) {
      const parsed = parseRelayPrice(relayPrice(base, AMOUNT.toString(), over), { source: base, amount: AMOUNT, agent: AGENT });
      assert.equal(parsed.ok, false, what);
      if (!parsed.ok) {
        assert.match(parsed.reason, new RegExp(`\\(${what}\\)`), what);
        assert.match(parsed.reason, /Nothing was sent/);
      }
    }
  });

  it("matches the recipient regardless of checksum case", () => {
    const parsed = parseRelayPrice(relayPrice(base, AMOUNT.toString(), { recipient: AGENT.toUpperCase().replace("0X", "0x") }), { source: base, amount: AMOUNT, agent: AGENT });
    assert.equal(parsed.ok, true);
  });

  it("explains Relay's refusals by code and never repeats Relay's own message", () => {
    const low = parseRelayPrice({ message: "Amount too low <script>", errorCode: "AMOUNT_TOO_LOW" }, { source: base, amount: 1n, agent: AGENT });
    assert.deepEqual(low, { ok: false, reason: "That amount is below what Relay will convert on this route. Try a larger amount." });
    for (const body of [null, "nope", [], { message: "Could not process request. Please try again later." }, { errorCode: "SOMETHING_NEW" }]) {
      const parsed = parseRelayPrice(body, { source: base, amount: 1n, agent: AGENT });
      assert.equal(parsed.ok, false);
      if (!parsed.ok) {
        assert.doesNotMatch(parsed.reason, /Could not process/);
        assert.match(parsed.reason, /Nothing was sent/);
      }
    }
  });
});

describe("the deep link to Relay", () => {
  it("prefills the agent, USDG on Robinhood Chain, the source and the exact amount", () => {
    const url = new URL(relayDeepLink(base, AMOUNT, AGENT));
    assert.equal(url.origin, "https://relay.link");
    assert.equal(url.pathname, "/bridge/robinhood");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      fromChainId: "8453",
      fromCurrency: "0x0000000000000000000000000000000000000000",
      toCurrency: CASH.USDG,
      toAddress: AGENT,
      amount: "0.02",
      tradeType: "EXACT_INPUT",
    });
  });

  it("starts Solana from SOL, and the agent's gas top-up asks for ETH", () => {
    const solUrl = new URL(relayDeepLink(sol, 26_900_000n, AGENT, "ETH"));
    assert.equal(solUrl.searchParams.get("fromChainId"), "792703809");
    assert.equal(solUrl.searchParams.get("fromCurrency"), "11111111111111111111111111111111");
    assert.equal(solUrl.searchParams.get("toCurrency"), "0x0000000000000000000000000000000000000000");
    assert.equal(solUrl.searchParams.get("amount"), "0.0269");
    assert.equal(solUrl.searchParams.get("toAddress"), AGENT);
  });

  it("names the route and the wait the way an owner reads them", () => {
    assert.equal(routeLabel(robinhood), "Relay swap on Robinhood Chain: ETH → USDG");
    assert.equal(etaText(1), "under a minute");
    assert.equal(etaText(60), "about a minute");
    assert.equal(etaText(600), "about 10 minutes");
    assert.equal(usdgText(35_671_666n), "35.67");
  });
});
