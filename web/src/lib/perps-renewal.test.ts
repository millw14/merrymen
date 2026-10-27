/**
 * D6: A PAPER PERPS WALLET WHOSE OLD WALL IS EMPTY RENEWS WITHOUT AN ON-CHAIN
 * REVOCATION — and nothing else does.
 *
 * Main's renewal revokes the old key on chain before minting, which a paper
 * Perps wallet (no ETH, ever) cannot pay for. The exemption is safe only
 * because an empty wall can do nothing on chain, so it is decided by
 * rebuilding the old grant's wall, and every grant whose wall permits
 * anything, or that cannot be read, keeps the revocation. The server's
 * retired-key fence is the store's and is not asked here (wallet-selector
 * and kill-perps cover the stop; grant-store tests the fence).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GRANT_ENERGY, GRANT_PERP_LIGHTER, LIGHTER_ROUTE_V1, publicGrantView } from "@merrymen/core";
import { renewalSkipsRevocation } from "./perps-renewal";

const ACCOUNT = "0x00000000000000000000000000000000000e1e1e";
const CAPS = { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 24 };
const PERP_KEY = `0x${"1a".repeat(40)}`;
/** The paper Perps grant as GET /api/grants?wallet=perps shows it (publicGrantView). */
const paper = { purpose: "perps", smartAccount: ACCOUNT, owner: `0x${"0b".repeat(20)}`, caps: CAPS, chainId: 4663, grantFeatures: [], grantedAt: 1, expiresAt: 2 };

describe("renewalSkipsRevocation", () => {
  it("a paper Perps wallet's empty wall: skipped, from the server's own view of it", () => {
    assert.equal(renewalSkipsRevocation(paper), true);
    assert.equal(renewalSkipsRevocation(publicGrantView({ ...paper, serialized: "x", demoSessionPrivateKey: `0x${"11".repeat(32)}` })), true);
  });

  it("a Perps wall that permits anything keeps the revocation: the energy buy, or a perpetuals key", () => {
    assert.equal(renewalSkipsRevocation({ ...paper, grantFeatures: [GRANT_ENERGY] }), false);
    const perp = { route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_KEY };
    assert.equal(renewalSkipsRevocation({ ...paper, grantFeatures: [GRANT_PERP_LIGHTER], perp }), false);
    // A block the rebuild cannot read is not "no perps".
    assert.equal(renewalSkipsRevocation({ ...paper, perp }), false);
  });

  it("every Spot grant keeps the revocation, whatever it declares", () => {
    for (const purpose of [undefined, "spot"]) {
      assert.equal(renewalSkipsRevocation({ ...paper, purpose }), false, String(purpose));
      assert.equal(renewalSkipsRevocation({ ...paper, purpose, grantFeatures: ["tradeable-v2"] }), false, String(purpose));
    }
  });

  it("anything it cannot read keeps the revocation — the answer that costs gas, never the one that leaves authority", () => {
    for (const g of [
      null,
      undefined,
      "perps",
      { ...paper, purpose: "Perps" },
      { ...paper, grantFeatures: undefined },
      { ...paper, grantFeatures: "energy-buy-v1" },
      { ...paper, grantFeatures: [7] },
      { ...paper, grantTokens: "0x" },
      { ...paper, smartAccount: undefined },
      { ...paper, smartAccount: "0x1234" },
      { ...paper, caps: undefined },
    ]) {
      assert.equal(renewalSkipsRevocation(g), false, JSON.stringify(g));
    }
  });
});
