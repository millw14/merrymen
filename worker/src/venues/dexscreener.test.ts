/**
 * DexScreener as the coin look's last index (venues/dexscreener.ts): only
 * Robinhood Chain pairs, only the posted token as the coin, mapped onto
 * GeckoPool so the look reads it with the same rules, and "could not ask" kept
 * apart from "lists nothing".
 *
 * The pair below is hand-written to DexScreener's documented `/tokens/v1`
 * shape (numbers as numbers, `priceUsd` as a string, `pairCreatedAt` in
 * milliseconds, `labels` naming the Uniswap version).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CASH } from "../../../packages/core/src/index";
import { DEX_CHAIN, parseDexPair, readDexTokenPairs } from "./dexscreener";

const TOKEN = "0x00000000000000000000000000000000000c0111";
const PAIR = "0x0000000000000000000000000000000000000011";
const CREATED_MS = Date.parse("2026-09-20T08:00:00Z");

const pair = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  chainId: "robinhood",
  dexId: "uniswap",
  url: `https://dexscreener.com/robinhood/${PAIR}`,
  pairAddress: "0x0000000000000000000000000000000000000011",
  labels: ["v3"],
  baseToken: { address: "0x00000000000000000000000000000000000C0111", name: "Commander Vrax", symbol: "VRAX" },
  quoteToken: { address: CASH.WETH, name: "Wrapped Ether", symbol: "WETH" },
  priceNative: "0.00000012",
  priceUsd: "0.00041",
  txns: { m5: { buys: 12, sells: 9 }, h1: { buys: 140, sells: 90 }, h6: { buys: 500, sells: 380 }, h24: { buys: 1900, sells: 1400 } },
  volume: { m5: 1500, h1: 21000, h6: 120000, h24: 410000 },
  priceChange: { m5: 0.4, h1: 2.1, h6: -3.2, h24: 12.5 },
  liquidity: { usd: 190000, base: 230000000, quote: 21.4 },
  fdv: 1200000,
  marketCap: 1200000,
  pairCreatedAt: CREATED_MS,
  ...over,
});

describe("a DexScreener pair, read as a GeckoPool", () => {
  it("a Robinhood Chain Uniswap v3 pair of the token: every figure it publishes, and none it does not", () => {
    const p = parseDexPair(pair(), TOKEN);
    assert.ok(p);
    assert.equal(DEX_CHAIN, "robinhood");
    assert.equal(p.poolAddress, PAIR);
    assert.equal(p.poolId, PAIR);
    assert.equal(p.tokenAddress, TOKEN, "lowercased, the posted token");
    assert.equal(p.dex, "uniswap-v3-robinhood", "named the way GeckoTerminal names it, so the look sees a v3 pool");
    assert.equal(p.name, "VRAX / WETH", "GeckoTerminal's label shape: the coin before the slash");
    assert.equal(p.reserveUsd, 190_000);
    assert.equal(p.fdvUsd, 1_200_000);
    assert.equal(p.priceUsd, 0.00041);
    assert.equal(p.volume24hUsd, 410_000);
    assert.equal(p.buys24h, 1900);
    assert.equal(p.sells24h, 1400);
    assert.equal(p.buckets.m5.volumeUsd, 1500);
    assert.equal(p.change1hPct, 2.1);
    assert.equal(p.createdAt, Math.floor(CREATED_MS / 1000), "milliseconds become seconds");
    assert.equal(p.buyers24h, null, "DexScreener publishes no distinct buyers: unknown, never zero");
    assert.equal(p.buckets.h24.buyers, null);
  });

  it("another chain's pair, a pair where the token is only the quote side, or no usable pair id: dropped", () => {
    assert.equal(parseDexPair(pair({ chainId: "ethereum" }), TOKEN), null);
    assert.equal(parseDexPair(pair({ chainId: "base" }), TOKEN), null);
    assert.equal(
      parseDexPair(pair({ baseToken: { address: CASH.WETH, symbol: "WETH" }, quoteToken: { address: TOKEN, symbol: "VRAX" } }), TOKEN),
      null,
    );
    assert.equal(parseDexPair(pair({ pairAddress: "not-an-address" }), TOKEN), null);
    assert.equal(parseDexPair(pair(), "0x1234"), null, "a malformed token matches nothing");
    for (const junk of [null, undefined, 7, "pair", []]) assert.equal(parseDexPair(junk, TOKEN), null);
  });

  it("the venue is v3 only when the pair says so: a v4 id or label keeps no contract, anything else keeps its own dex id", () => {
    const v4 = parseDexPair(pair({ pairAddress: `0x${"4".repeat(64)}`, labels: ["v4"] }), TOKEN);
    assert.equal(v4?.poolAddress, null);
    assert.equal(v4?.dex, "uniswap-v4-robinhood");
    assert.equal(parseDexPair(pair({ labels: ["v4"] }), TOKEN)?.dex, "uniswap-v4-robinhood");
    assert.equal(parseDexPair(pair({ labels: ["v2"] }), TOKEN)?.dex, "uniswap-robinhood");
    assert.equal(parseDexPair(pair({ labels: undefined }), TOKEN)?.dex, "uniswap-robinhood", "an unlabelled pair is not assumed to be v3");
    assert.equal(parseDexPair(pair({ dexId: "somedex" }), TOKEN)?.dex, "somedex-robinhood");
  });

  it("a figure left out is null, never zero", () => {
    const p = parseDexPair(pair({ liquidity: undefined, fdv: undefined, pairCreatedAt: undefined, txns: undefined, volume: {} }), TOKEN);
    assert.ok(p);
    assert.equal(p.reserveUsd, null);
    assert.equal(p.fdvUsd, null);
    assert.equal(p.createdAt, null);
    assert.equal(p.buys24h, null);
    assert.equal(p.volume24hUsd, null);
  });
});

describe("reading DexScreener's Robinhood Chain pairs of a token", () => {
  const answer = (status: number, body: unknown) =>
    (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("asks for Robinhood Chain and this token only, and keeps only its own pairs", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify([pair(), pair({ chainId: "ethereum" }), pair({ baseToken: { address: CASH.WETH } })]), { status: 200 });
    }) as unknown as typeof fetch;
    const pools = await readDexTokenPairs(TOKEN.toUpperCase().replace("0X", "0x"), { fetchFn });
    assert.deepEqual(urls, [`https://api.dexscreener.com/tokens/v1/robinhood/${TOKEN}`]);
    assert.equal(pools?.length, 1);
    assert.equal(pools?.[0]?.tokenAddress, TOKEN);
  });

  it("could not ask is null; an answer with no pairs is an empty list", async () => {
    assert.equal(await readDexTokenPairs(TOKEN, { fetchFn: answer(429, "slow down") }), null, "rate-limited");
    assert.equal(await readDexTokenPairs(TOKEN, { fetchFn: answer(500, "") }), null);
    assert.equal(await readDexTokenPairs(TOKEN, { fetchFn: answer(200, "<html>") }), null, "not JSON");
    assert.equal(await readDexTokenPairs(TOKEN, { fetchFn: answer(200, { schemaVersion: "1.0.0" }) }), null, "a changed shape");
    const thrown = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    assert.equal(await readDexTokenPairs(TOKEN, { fetchFn: thrown }), null);
    assert.deepEqual(await readDexTokenPairs(TOKEN, { fetchFn: answer(200, []) }), []);
    assert.deepEqual(await readDexTokenPairs(TOKEN, { fetchFn: answer(200, { pairs: null }) }), [], "the older shape's none");
  });

  it("nothing but an address is ever put in the URL", async () => {
    let asked = 0;
    const fetchFn = (async () => {
      asked++;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    for (const bad of ["", "0x1234", `0x${"a".repeat(64)}`, "../../etc", undefined as unknown as string]) {
      assert.equal(await readDexTokenPairs(bad, { fetchFn }), null);
    }
    assert.equal(asked, 0);
  });

  it("a request that never answers is aborted at its bound", async () => {
    const fetchFn = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const t = Date.now();
    assert.equal(await readDexTokenPairs(TOKEN, { fetchFn, timeoutMs: 30 }), null);
    assert.ok(Date.now() - t < 2_000);
  });
});
