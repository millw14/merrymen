import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchRialtoQuote, parseRialtoQuote, type FetchLike } from "./rialto";

const ROUTER = "0xC94135b63772b91d79d0A2dAab2A8801F32359bd" as const;
const EVIL = "0x9999999999999999999999999999999999999999" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;
const DATA = "0xdeadbeefcafe0000";

describe("parseRialtoQuote — API output is untrusted", () => {
  it("accepts a flat quote targeting the resolved router", () => {
    const { quote } = parseRialtoQuote({ to: ROUTER, data: DATA, buyAmount: "123" }, ROUTER);
    assert.ok(quote);
    assert.equal(quote.to, ROUTER);
    assert.equal(quote.data, DATA);
    assert.equal(quote.value, 0n);
    assert.equal(quote.buyAmountRaw, 123n);
  });

  it("accepts the nested transaction shape", () => {
    const { quote } = parseRialtoQuote(
      { transaction: { to: ROUTER, data: DATA, value: "0" }, outputAmount: 55 },
      ROUTER,
    );
    assert.ok(quote);
    assert.equal(quote.buyAmountRaw, 55n);
  });

  it("REFUSES a quote whose target is not the registry-resolved router", () => {
    const { quote, reason } = parseRialtoQuote({ to: EVIL, data: DATA }, ROUTER);
    assert.equal(quote, null);
    assert.match(reason!, /not the registry-resolved router/);
  });

  it("refuses non-zero value — ERC-20 swaps never carry ETH", () => {
    const { quote, reason } = parseRialtoQuote({ to: ROUTER, data: DATA, value: "1" }, ROUTER);
    assert.equal(quote, null);
    assert.match(reason!, /non-zero value/);
  });

  it("refuses malformed calldata and addresses", () => {
    assert.equal(parseRialtoQuote({ to: ROUTER, data: "not-hex" }, ROUTER).quote, null);
    assert.equal(parseRialtoQuote({ to: ROUTER, data: "0x00" }, ROUTER).quote, null); // too short
    assert.equal(parseRialtoQuote({ to: "0x123", data: DATA }, ROUTER).quote, null);
    assert.equal(parseRialtoQuote("a string", ROUTER).quote, null);
    assert.equal(parseRialtoQuote(null, ROUTER).quote, null);
  });
});

describe("fetchRialtoQuote", () => {
  function fakeFetch(status: number, body: unknown): FetchLike & { lastUrl?: string; lastHeaders?: Record<string, string> } {
    const f: FetchLike & { lastUrl?: string; lastHeaders?: Record<string, string> } = async (url, init) => {
      f.lastUrl = url;
      f.lastHeaders = init?.headers;
      return { ok: status < 400, status, json: async () => body };
    };
    return f;
  }

  const args = {
    sellToken: USDG,
    buyToken: AAPL,
    sellAmountRaw: 25_000_000n,
    taker: "0x7777777777777777777777777777777777777777" as const,
    expectedRouter: ROUTER,
  };

  it("builds the quote URL and sends the API key header", async () => {
    const f = fakeFetch(200, { to: ROUTER, data: DATA });
    const { quote } = await fetchRialtoQuote({ apiKey: "test-key", fetchFn: f, apiBase: "https://api.test" }, args);
    assert.ok(quote);
    assert.match(f.lastUrl!, /^https:\/\/api\.test\/quote\?/);
    assert.match(f.lastUrl!, /sellAmount=25000000/);
    assert.match(f.lastUrl!, new RegExp(`taker=${args.taker}`));
    assert.equal(f.lastHeaders!["x-api-key"], "test-key");
  });

  it("degrades cleanly on HTTP errors and network failures", async () => {
    const denied = await fetchRialtoQuote({ apiKey: "k", fetchFn: fakeFetch(403, {}) }, args);
    assert.equal(denied.quote, null);
    assert.match(denied.reason!, /403/);

    const boom: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const failed = await fetchRialtoQuote({ apiKey: "k", fetchFn: boom }, args);
    assert.equal(failed.quote, null);
    assert.match(failed.reason!, /ECONNRESET/);
  });

  it("a hostile API cannot redirect execution — target mismatch is refused", async () => {
    const f = fakeFetch(200, { to: EVIL, data: DATA });
    const { quote, reason } = await fetchRialtoQuote({ apiKey: "k", fetchFn: f }, args);
    assert.equal(quote, null);
    assert.match(reason!, /not the registry-resolved router/);
  });
});
