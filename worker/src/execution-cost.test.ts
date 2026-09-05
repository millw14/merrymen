/**
 * SUNK IS SUNK, AND THE NEXT TRADE IS THE ONLY ONE THAT CAN BE DECIDED.
 *
 * The canary paid 6.97 USDG of gas on a 10 USDG book, and a model handed that
 * total divided by four operations — 1.74 a trade against trades of 1.67 —
 * would correctly conclude that trading is pointless, about a number that is
 * wrong. 5.51M of the 6.02M gas in the first operation was the account
 * deployment and the permission wall: paid once, already paid, and irrelevant
 * to whether the next trade is worth making.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENFORCE_TRADE_ECONOMICS,
  MIN_EDGE_OVER_GAS,
  STEADY_SWAP_GAS_UNITS,
  expectedTradeGasUsdg,
  judgeTradeEconomics,
  tradeEconomics,
} from "./execution-cost";

// The canary's own conditions: 0.597 gwei, and the ETH price implied by op #4
// (305,053,139,433,360 wei costing 764,720 micro-USDG) — about $2,507/ETH.
const GWEI = 1_000_000_000n;
const ETH_PRICE8 = (764_720 * 1e20) / 305_053_139_433_360;

describe("the estimate is of the NEXT trade", () => {
  it("reproduces a real steady-state operation from live inputs", () => {
    // Same units and roughly the same gas price as op #4, so the answer should
    // land on what that operation actually cost. If this drifts, the estimate
    // has stopped describing the thing it claims to.
    const micro = expectedTradeGasUsdg({
      gasUnits: STEADY_SWAP_GAS_UNITS,
      gasPriceWei: 597_000_000n,
      ethPrice8: BigInt(Math.round(ETH_PRICE8)),
    });
    assert.notEqual(micro, null);
    const usdg = Number(micro) / 1e6;
    assert.ok(Math.abs(usdg - 0.7647) < 0.01, `expected ~0.7647 USDG, got ${usdg.toFixed(6)}`);
  });

  it("is a fraction of what the naive average would have said", () => {
    // The average of all four ops is 1.742 USDG. The honest marginal figure is
    // less than half of it, and the gap is the deployment nobody will pay again.
    const micro = expectedTradeGasUsdg({
      gasUnits: STEADY_SWAP_GAS_UNITS,
      gasPriceWei: 597_000_000n,
      ethPrice8: BigInt(Math.round(ETH_PRICE8)),
    });
    assert.ok(Number(micro) / 1e6 < 1.742 / 2, "the marginal cost must not inherit the setup cost");
  });

  it("REFUSES rather than returning zero when the ETH price is unavailable", () => {
    // An unpriceable cost is unknown, and unknown arriving at a decision wearing
    // a zero is how a trade gets made on the belief that it is free.
    assert.equal(
      expectedTradeGasUsdg({ gasUnits: STEADY_SWAP_GAS_UNITS, gasPriceWei: 597_000_000n, ethPrice8: null }),
      null,
    );
    assert.equal(
      expectedTradeGasUsdg({ gasUnits: STEADY_SWAP_GAS_UNITS, gasPriceWei: 597_000_000n, ethPrice8: 0n }),
      null,
    );
    assert.equal(expectedTradeGasUsdg({ gasUnits: 0n, gasPriceWei: GWEI, ethPrice8: 100n }), null);
  });

  it("tracks the gas price, because that is what actually moves", () => {
    const at = (gwei: bigint) =>
      Number(
        expectedTradeGasUsdg({
          gasUnits: STEADY_SWAP_GAS_UNITS,
          gasPriceWei: gwei,
          ethPrice8: BigInt(Math.round(ETH_PRICE8)),
        }),
      );
    // The canary saw 0.330 and 0.610 gwei within four operations. A cost model
    // that ignored the price would be wrong by that ratio.
    assert.ok(at(610_000_000n) > at(330_000_000n) * 1.7, "roughly proportional to the gas price");
  });
});

describe("cost as a share of the trade", () => {
  it("names the break-even move a trade has to clear", () => {
    const e = tradeEconomics(764_720, 1_666_500);
    assert.equal(e.gasShareOfTradePct!.toFixed(1), "45.9");
    assert.equal(e.breakEvenMovePct, e.gasShareOfTradePct, "the same arithmetic, asked the way a desk asks it");
  });

  it("says nothing rather than something when the cost is unknown", () => {
    const e = tradeEconomics(null, 1_666_500);
    assert.equal(e.gasShareOfTradePct, null);
    assert.equal(e.breakEvenMovePct, null);
  });

  it("does not divide by a zero-sized trade", () => {
    assert.equal(tradeEconomics(764_720, 0).gasShareOfTradePct, null);
  });
});

describe("the economics verdict is advisory, and never silently permissive", () => {
  it("calls a trade uneconomic when the edge does not cover the cost", () => {
    const v = judgeTradeEconomics({ expectedEdgeUsdg: 100_000, expectedGasUsdg: 764_720 });
    assert.equal(v.verdict, "uneconomic");
  });

  it("calls it marginal when it clears the cost but not the margin", () => {
    const v = judgeTradeEconomics({ expectedEdgeUsdg: 900_000, expectedGasUsdg: 764_720 });
    assert.equal(v.verdict, "marginal");
    assert.match(v.why, new RegExp(`${MIN_EDGE_OVER_GAS}x`));
  });

  it("calls it viable at the margin and above", () => {
    assert.equal(
      judgeTradeEconomics({ expectedEdgeUsdg: 764_720 * MIN_EDGE_OVER_GAS, expectedGasUsdg: 764_720 }).verdict,
      "viable",
    );
  });

  it("is UNKNOWN when either side is missing, never viable", () => {
    // The dangerous default is the permissive one. A missing edge or a missing
    // cost is a question nobody answered, not a trade nobody objected to.
    assert.equal(judgeTradeEconomics({ expectedEdgeUsdg: null, expectedGasUsdg: 764_720 }).verdict, "unknown");
    assert.equal(judgeTradeEconomics({ expectedEdgeUsdg: 5_000_000, expectedGasUsdg: null }).verdict, "unknown");
  });

  it("is NOT enforced while shadow mode is still observing", () => {
    // At 45.9% gas-to-size a 2x rule refuses essentially every trade the fleet
    // currently sizes — probably correctly, which is exactly why it must not be
    // switched on silently. Shadow exists to see what Brain decides when told
    // the truth; a filter in front of it would replace that with the filter's
    // output. This must flip before Brain gets execution authority.
    assert.equal(ENFORCE_TRADE_ECONOMICS, false);
  });
});
