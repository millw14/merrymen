/**
 * THE STRICT CHAIN HELPERS NAME TWO CHAINS AND THROW ON EVERYTHING ELSE; THE
 * LENIENT ONES ARE PINNED AS THEY ARE.
 *
 * chainForId maps any id but the testnet to mainnet, so a Solana grant or a
 * missing id reads as Robinhood Chain. The strict pair is for new code that
 * must never guess. The lenient pair is pinned here so that flipping it, which
 * needs a read of prod first, is a decision and not an accident.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chainForId,
  chainForIdStrict,
  explorerFor,
  explorerForStrict,
  isRobinhoodChainId,
  robinhoodChain,
  robinhoodTestnet,
} from "./chain";
import { CHAINS, allChains } from "./ids";

/** Ids that are not a Robinhood chain id, each for its own reason. */
const NOT_ROBINHOOD: readonly unknown[] = [
  1, // Ethereum
  0,
  -4663,
  4663.5,
  46631,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "4663", // a numeric string is not the number
  "46630",
  46630n,
  undefined,
  null,
  {},
  [4663],
  CHAINS.robinhood, // a CAIP-2 ref is not an EVM chain id
  CHAINS.solana,
];

describe("chainForIdStrict / explorerForStrict", () => {
  it("names mainnet and the testnet", () => {
    assert.equal(chainForIdStrict(4663), robinhoodChain);
    assert.equal(chainForIdStrict(46630), robinhoodTestnet);
    assert.equal(explorerForStrict(4663), "https://robinhoodchain.blockscout.com");
    assert.equal(explorerForStrict(46630), "https://explorer.testnet.chain.robinhood.com");
  });

  it("throws on every other id, where the lenient pair answers mainnet", () => {
    for (const id of NOT_ROBINHOOD) {
      assert.throws(() => chainForIdStrict(id), /^Error: unknown chain id: /, String(id));
      assert.throws(() => explorerForStrict(id), /^Error: unknown chain id: /, String(id));
    }
  });

  it("keeps a long id out of the message past 80 characters", () => {
    assert.throws(() => chainForIdStrict("9".repeat(500)), (e: Error) => e.message === `unknown chain id: ${"9".repeat(80)}`);
  });

  it("agrees with the ids.ts registry on every EVM chain it names", () => {
    const evm = allChains().filter((c) => c.family === "evm");
    assert.deepEqual(evm.map((c) => c.evmChainId), [4663, 46630]);
    for (const c of evm) {
      assert.equal(chainForIdStrict(c.evmChainId).id, c.evmChainId);
      assert.equal(explorerForStrict(c.evmChainId), c.explorer.base);
      assert.equal(chainForIdStrict(c.evmChainId).testnet === true, !c.realMoney);
    }
  });
});

describe("isRobinhoodChainId", () => {
  it("is true for exactly 4663 and 46630", () => {
    assert.equal(isRobinhoodChainId(4663), true);
    assert.equal(isRobinhoodChainId(46630), true);
    for (const id of NOT_ROBINHOOD) assert.equal(isRobinhoodChainId(id), false, String(id));
  });
});

describe("chainForId / explorerFor — lenient, unchanged", () => {
  it("still map every id but the testnet to mainnet", () => {
    assert.equal(chainForId(46630), robinhoodTestnet);
    assert.equal(chainForId(4663), robinhoodChain);
    for (const id of [1, 0, 46631, Number.NaN]) {
      assert.equal(chainForId(id), robinhoodChain, String(id));
      assert.equal(explorerFor(id), "https://robinhoodchain.blockscout.com", String(id));
    }
    assert.equal(chainForId(undefined as unknown as number), robinhoodChain);
    assert.equal(explorerFor(46630), "https://explorer.testnet.chain.robinhood.com");
  });
});
