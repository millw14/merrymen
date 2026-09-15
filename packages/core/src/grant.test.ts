import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { uncoveredBasketSymbols } from "./grant";
/**
 * THE BANNER THAT COULD NOT FIRE FOR THE TOKEN THAT NEEDED IT.
 *
 * `uncoveredBasketSymbols` filtered `STOCK_TOKENS`, so a CUSTOM token in the
 * basket simply fell out of the filter and the red "update your trading
 * permissions to buy or sell X" warning never appeared for a memecoin — which is
 * exactly the token an owner is most likely to have added after signing, and the
 * one the `no-exit` rule then refuses at the wall.
 */
describe("uncovered basket symbols include the owner's own tokens", () => {
  const CATE = { symbol: "CATE", address: "0xcacacacacacacacacacacacacacacacacacacace" };
  const covered = { grantFeatures: ["tradeable-v2"], grantTokens: [CATE.address] } as never;
  const bare = { grantFeatures: ["tradeable-v2"], grantTokens: [] } as never;

  it("A CUSTOM TOKEN THE GRANT CANNOT SELL IS REPORTED", () => {
    assert.deepEqual(uncoveredBasketSymbols(["CATE"], bare, [CATE]), ["CATE"]);
  });

  it("and one the grant CAN sell is not", () => {
    assert.deepEqual(uncoveredBasketSymbols(["CATE"], covered, [CATE]), []);
  });

  it("with no custom tokens passed, behaviour is byte-identical to before", () => {
    // The default keeps the two callers that already union in `tokenCoverage`
    // — Wallet.tsx and the worker's coverage note — from double-reporting.
    assert.deepEqual(uncoveredBasketSymbols(["CATE"], bare), []);
  });
});
