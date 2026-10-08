import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ethPrice8FromFeed, ethUsdFeed, priceGasAt, type EthFeed } from "./eth-feed";
import { MAX_ROUND_LAG_SEC, type FeedRound } from "./gas-backfill";

/** A feed of published rounds in one phase, 1-based, `updatedAt` ascending. */
function feedOf(rounds: { at: number; usd: number }[]): EthFeed {
  const phase = 1n << 64n;
  const byId = new Map<bigint, FeedRound>(rounds.map((r, i) => [phase | BigInt(i + 1), { roundId: phase | BigInt(i + 1), priceUsd: r.usd, updatedAt: r.at }]));
  const last = rounds.length;
  return {
    async latest() {
      const r = byId.get(phase | BigInt(last));
      return r ? { ...r, price8: BigInt(Math.round(r.priceUsd * 1e8)) } : null;
    },
    async round(id) {
      return byId.get(id) ?? { roundId: id, priceUsd: 0, updatedAt: 0 };
    },
  };
}

describe("the ETH/USD feed, read", () => {
  it("scales an 8-decimal answer exactly, and remembers the decimals", async () => {
    let decimalsReads = 0;
    const client = {
      async readContract(a: { functionName: string; args?: readonly unknown[] }) {
        if (a.functionName === "decimals") { decimalsReads++; return 8; }
        if (a.functionName === "latestRoundData") return [7n, 3_456_78901234n, 0n, 1_000n, 7n];
        if (a.functionName === "getRoundData") return [a.args![0], 3_000_00000000n, 0n, 900n, a.args![0]];
        throw new Error("unexpected");
      },
    };
    const feed = ethUsdFeed(client as never);
    const latest = await feed.latest();
    assert.equal(latest?.price8, 3_456_78901234n);
    assert.equal(latest?.updatedAt, 1_000);
    assert.equal((await feed.round(6n))?.priceUsd, 3_000);
    assert.equal(decimalsReads, 1);
  });

  it("scales an 18-decimal answer down to 8 without float", async () => {
    const client = {
      async readContract(a: { functionName: string }) {
        if (a.functionName === "decimals") return 18;
        return [1n, 2_500_123456789012345678n, 0n, 50n, 1n];
      },
    };
    assert.equal((await ethUsdFeed(client as never).latest())?.price8, 2_500_12345678n);
  });

  it("answers null, never a price, when the feed does not answer", async () => {
    const feed = ethUsdFeed({ async readContract() { throw new Error("rpc"); } } as never);
    assert.equal(await feed.latest(), null);
    assert.equal(await feed.round(1n), null);
  });
});

describe("ethPrice8FromFeed — the pool's fallback", () => {
  it("prices from a recent round", async () => {
    assert.deepEqual(await ethPrice8FromFeed(feedOf([{ at: 1_000, usd: 3_000 }]), 1_060), { price8: 300_000_000_000n });
  });

  it("refuses a round older than the lag bound", async () => {
    const r = await ethPrice8FromFeed(feedOf([{ at: 1_000, usd: 3_000 }]), 1_000 + MAX_ROUND_LAG_SEC + 1);
    assert.equal(r.price8, null);
    assert.match(r.reason!, /last published/);
  });
});

describe("priceGasAt — a cost settled late, priced when it was burned", () => {
  const feed = feedOf([{ at: 1_000, usd: 2_000 }, { at: 5_000, usd: 4_000 }]);

  it("uses the round IN FORCE at that moment, not the newest", async () => {
    // 0.001 ETH at $2,000 = $2; at today's $4,000 it would read $4.
    assert.equal(await priceGasAt(feed, 1_000_000_000_000_000n, 3_000), 2);
    assert.equal(await priceGasAt(feed, 1_000_000_000_000_000n, 6_000), 4);
  });

  it("leaves a cost from before any round unpriced, never zero", async () => {
    assert.equal(await priceGasAt(feed, 1_000_000_000_000_000n, 500), null);
  });

  it("calls a free operation free", async () => {
    assert.equal(await priceGasAt(feed, 0n, 3_000), 0);
  });
});

describe("recovered gas is priced where it is written", () => {
  const INDEX = readFileSync(`${fileURLToPath(new URL(".", import.meta.url))}index.ts`, "utf8");

  it("prices only an owner-paid cost, at its own block's time", () => {
    assert.match(INDEX, /gas\.gasPayer !== "owner"[\s\S]{0,200}?chain\.getBlockTime\(blockNumber\)[\s\S]{0,120}?priceGasAt\(ethFeed\(\), gas\.gasWei, at\)/);
  });

  it("the resolver and the orphan sweep both write it with the row", () => {
    assert.match(INDEX, /\.\.\.gasFields\(r, recoveredUsdg\)/);
    assert.match(INDEX, /settleKeyInstall\(\{ addTrade, priceGas: async \(\) => recoveredUsdg \}/);
    assert.match(INDEX, /const orphanGas = o\.gas \? gasFields\(o\.gas, await recoveredGasUsdg\(chain, o\.gas, o\.blockNumber\)\) : null;/);
    assert.match(INDEX, /basis_source: "receipt",\s*\.\.\.\(orphanGas \?\? \{\}\),/);
  });

  it("falls back to the feed when the pool's ETH price is refused", () => {
    assert.match(INDEX, /return await ethFromFeed\(now, refused\[0\]\?\.reason/);
  });
});
