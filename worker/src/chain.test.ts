import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chainForId, explorerFor, robinhoodChain, robinhoodTestnet } from "../../packages/core/src/index";
import { bundlerChainMismatch } from "./settings";
import { readStatus, type StatusContext } from "./telegram/reads";

const statusCtx = (chainId: number | null): StatusContext => ({
  name: "Robin",
  strategy: "steady-basket",
  venue: "uniswap",
  paused: false,
  workerAliveSec: 0,
  grant: null,
  chainId,
  telegramMaxActionUsdg: 25,
});

describe("/status chain line — you always know which mode the band rides", () => {
  it("mainnet reads as REAL FUNDS", () => {
    assert.match(readStatus(statusCtx(4663)), /mainnet 4663 · REAL FUNDS/);
  });
  it("testnet reads as practice", () => {
    assert.match(readStatus(statusCtx(46630)), /testnet 46630 \(practice/);
  });
  it("no grant → no chain line", () => {
    assert.doesNotMatch(readStatus(statusCtx(null)), /chain:/);
  });
});

describe("chainForId / explorerFor", () => {
  it("maps the two Robinhood chain ids", () => {
    assert.equal(chainForId(46630).id, robinhoodTestnet.id);
    assert.equal(chainForId(4663).id, robinhoodChain.id);
  });

  it("treats anything unknown as mainnet (the only real chain)", () => {
    assert.equal(chainForId(1).id, robinhoodChain.id);
  });

  it("explorer URLs differ per chain", () => {
    assert.equal(explorerFor(46630), "https://explorer.testnet.chain.robinhood.com");
    assert.equal(explorerFor(4663), "https://robinhoodchain.blockscout.com");
  });
});

describe("bundlerChainMismatch — the silent-failure guard", () => {
  it("null when no bundler URL is set", () => {
    assert.equal(bundlerChainMismatch(undefined, 4663), null);
    assert.equal(bundlerChainMismatch("", 4663), null);
  });

  it("null when the URL's chain id matches the grant", () => {
    assert.equal(bundlerChainMismatch("https://api.pimlico.io/v2/46630/rpc?apikey=x", 46630), null);
    assert.equal(bundlerChainMismatch("https://api.pimlico.io/v2/4663/rpc?apikey=x", 4663), null);
  });

  it("flags a testnet bundler with a mainnet grant (and vice versa)", () => {
    assert.equal(bundlerChainMismatch("https://api.pimlico.io/v2/46630/rpc?apikey=x", 4663), 46630);
    assert.equal(bundlerChainMismatch("https://api.pimlico.io/v2/4663/rpc?apikey=x", 46630), 4663);
  });

  it("does NOT confuse 4663 with its substring inside 46630", () => {
    // /46630/ contains "4663" — boundaries must prevent a false mainnet match.
    assert.equal(bundlerChainMismatch("https://api.pimlico.io/v2/46630/rpc", 46630), null);
  });

  it("null when the URL names no known chain id (heuristic stays quiet)", () => {
    assert.equal(bundlerChainMismatch("https://my-custom-bundler.example.com/rpc", 4663), null);
    assert.equal(bundlerChainMismatch("https://bundler.example.com/v2/1/rpc", 46630), null);
  });

  it("catches chain ids passed as query params", () => {
    assert.equal(bundlerChainMismatch("https://bundler.example.com/rpc?chain=46630", 4663), 46630);
  });
});
