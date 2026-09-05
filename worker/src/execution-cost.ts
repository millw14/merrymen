/**
 * WHAT THE NEXT TRADE WILL COST, as opposed to what the last ones did.
 *
 * The canary's published return is −73.8% on a 10.000000 USDG book, and 94% of
 * that loss is gas. Decomposed against the EntryPoint's own numbers:
 *
 *   op #1   6,019,786 gas   4.988562 USDG   AccountDeployed: YES
 *   op #2     526,934 gas   0.437126 USDG
 *   op #3     509,850 gas   0.779371 USDG
 *   op #4     510,760 gas   0.764720 USDG
 *
 * So ~5.51M of op #1's gas was the account deployment and the session-key
 * permission wall — paid once, already paid, and SUNK. The recurring cost of
 * trading is ~510,000 gas.
 *
 * A model told "gas has cost you 1.74 USDG a trade" — the average — will never
 * trade again, and it would be right not to, about a number that is wrong. A
 * model told "the next trade costs about X" can weigh that against what it
 * expects to make. Those are different questions and only the second one is
 * ever actionable.
 *
 * FORWARD-LOOKING, AND THAT IS THE WHOLE POINT. This estimates from TODAY's gas
 * price rather than averaging what was paid historically, for two reasons. The
 * canary's four operations ranged 0.330–0.610 gwei, so a historical average
 * mostly measures which blocks happened to be busy. And the child's ledger is
 * wiped by every redeploy, so a backward-looking figure would be missing
 * exactly when it mattered.
 *
 * WHAT IT IS NOT. It is not a promise, and it is not a policy. Nothing here
 * refuses a trade; it produces a number, and `checkPolicy` remains the only
 * thing that may reduce or refuse anything.
 *
 * PURE. No chain, no clock, no environment — the caller supplies the two live
 * readings and this does the arithmetic.
 */

import { gasCostUsdg } from "./gas-price";

/**
 * Gas a steady-state swap actually costs on chain 4663, in units.
 *
 * MEASURED, not estimated: 526,934 / 509,850 / 510,760 across the canary's
 * three post-deployment swaps, read from the EntryPoint's `actualGasUsed`. The
 * median is used rather than the mean, and the figure is deliberately the
 * WHOLE UserOperation — validation, any batched approval, and the swap — because
 * that is what the account is charged and therefore what a decision has to
 * clear.
 *
 * Superseded per-agent as soon as that agent has its own recorded `gas_units`;
 * this is the floor for an account that has not traded yet, and a new account
 * with no history is exactly when a wrong cost estimate does the most damage.
 */
export const STEADY_SWAP_GAS_UNITS = 510_760n;

/**
 * What a trade of this shape should be expected to cost, in micro-USDG.
 *
 * Null when the ETH price could not be established — the same refusal
 * `priceGas` makes, and for the same reason: an unpriceable cost is unknown,
 * and unknown must not arrive at a decision wearing a zero.
 */
export function expectedTradeGasUsdg(args: {
  gasUnits: bigint;
  /** Wei per unit of gas, as the chain reports it right now. */
  gasPriceWei: bigint;
  /** USD per ETH, 8 decimals. Null when the WETH pool did not pass its guards. */
  ethPrice8: bigint | null;
}): bigint | null {
  if (args.ethPrice8 === null || args.ethPrice8 <= 0n) return null;
  if (args.gasUnits <= 0n || args.gasPriceWei <= 0n) return null;
  return gasCostUsdg(args.gasUnits * args.gasPriceWei, args.ethPrice8);
}

export interface TradeEconomics {
  /** Expected cost of the next trade, micro-USDG. Null when unpriceable. */
  expectedGasUsdg: number | null;
  /** The size that cost is being measured against, micro-USDG. */
  tradeSizeUsdg: number;
  /**
   * Cost as a percentage of the trade. This is the number that decides whether
   * trading at this size is economic at all — the canary's is 45.9%.
   */
  gasShareOfTradePct: number | null;
  /**
   * How much the position must move, in percent, merely to break even on gas.
   * Identical arithmetic to the share, named separately because it is the
   * question a desk actually asks.
   */
  breakEvenMovePct: number | null;
}

/** Assemble the figures a decision needs. PURE. */
export function tradeEconomics(expectedGasUsdg: number | null, tradeSizeUsdg: number): TradeEconomics {
  const share =
    expectedGasUsdg !== null && tradeSizeUsdg > 0 ? (expectedGasUsdg / tradeSizeUsdg) * 100 : null;
  return {
    expectedGasUsdg,
    tradeSizeUsdg,
    gasShareOfTradePct: share,
    breakEvenMovePct: share,
  };
}

/**
 * THE MARGIN A TRADE MUST CLEAR TO BE WORTH MAKING.
 *
 * A trade whose expected edge merely equals its gas is a coin-flip that pays
 * the chain either way. 2x is the smallest multiple that is not obviously
 * self-defeating, and it is a starting point rather than a tuned value — the
 * honest calibration needs realised outcomes, which shadow mode is currently
 * collecting.
 */
export const MIN_EDGE_OVER_GAS = 2;

/**
 * ENFORCEMENT IS OFF, and this constant is the reminder of why.
 *
 * At the measured 45.9% gas-to-size ratio, a rule requiring 2x cover would
 * refuse essentially every trade the fleet currently sizes — which is very
 * probably CORRECT, and is exactly why it must not be switched on silently in
 * shadow mode. Shadow exists to observe what Brain decides when it is told the
 * truth about costs; a deterministic filter in front of it would replace that
 * observation with a filter's output, and we would learn nothing about the
 * reasoner.
 *
 * So the verdict is COMPUTED AND RECORDED on every decision, and enforced by
 * nothing. Before Brain is given execution authority this becomes `true`, or a
 * minimum trade size lands, or both — a technically correct trade that is
 * economically a guaranteed loser is still a loser.
 */
export const ENFORCE_TRADE_ECONOMICS = false;

export type EconomicsVerdict = "viable" | "marginal" | "uneconomic" | "unknown";

/**
 * Would this trade pay for itself? PURE, and advisory while
 * `ENFORCE_TRADE_ECONOMICS` is false.
 *
 * `unknown` when either side of the comparison is missing, and unknown is never
 * quietly read as viable.
 */
export function judgeTradeEconomics(args: {
  expectedEdgeUsdg: number | null;
  expectedGasUsdg: number | null;
}): { verdict: EconomicsVerdict; why: string } {
  const { expectedEdgeUsdg: edge, expectedGasUsdg: gas } = args;
  if (gas === null) return { verdict: "unknown", why: "the cost of the next trade could not be priced" };
  if (edge === null) return { verdict: "unknown", why: "no expected edge was stated to weigh against the cost" };
  if (edge <= gas) {
    return {
      verdict: "uneconomic",
      why: `the expected edge does not cover the ${gas} micro-USDG this trade costs to make`,
    };
  }
  if (edge < gas * MIN_EDGE_OVER_GAS) {
    return {
      verdict: "marginal",
      why: `the expected edge clears the cost but by less than ${MIN_EDGE_OVER_GAS}x`,
    };
  }
  return { verdict: "viable", why: `the expected edge is at least ${MIN_EDGE_OVER_GAS}x the cost of making it` };
}
