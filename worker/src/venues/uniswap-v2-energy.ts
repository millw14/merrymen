/**
 * THE ENERGY BUY'S TWO CALLS — the only builder that can move USDG into
 * $MERRYMEN, and it builds exactly one shape.
 *
 * WHY A FILE OF ITS OWN. Its neighbour venues/uniswap-v2.ts is the route's
 * READ side — quotes, the tax, the floor arithmetic — and is pinned read-only
 * (uniswap-v2.test.ts: no encodeFunctionData, no write ABI), because the tick's
 * energy ESTIMATE imports it and an estimate must not sit one import away from
 * something that spends. The write side lives here, where nothing but the
 * owner's confirmed energy buy reaches it.
 *
 * THE SHAPE, and why each part is what it is:
 *
 *   1. approve(router, amountIn) on USDG — EXACTLY the input, never a ceiling
 *      above it. An allowance larger than the trade is a standing permission
 *      the next caller inherits. The wall caps this approve at perTradeUsdg
 *      (LESS_THAN_OR_EQUAL) and lists the router in its ONE_OF only for USDG.
 *
 *   2. swapExactTokensForTokensSupportingFeeOnTransferTokens(amountIn, minOut,
 *      route.path, recipient, deadline) on the router. The FEE-ON-TRANSFER
 *      variant, because $MERRYMEN takes a buy tax on transfer: the plain
 *      variant checks the pre-tax amount against minOut and would revert on
 *      every honest fill. This variant checks the RECIPIENT's balance delta,
 *      so `minOut` is a floor on what actually ARRIVES — post-tax — and the
 *      caller computes it that way (energyMinOut).
 *
 * The path and the router come from the route the GRANT sealed
 * (grantEnergyRoute), never a constant typed here, so the calldata and the
 * wall's pinned words describe one route. The final fence
 * (checkEnergySwapCalls) re-encodes the canonical form and compares BYTES,
 * which is stricter than the wall — the wall admits non-canonical calldata the
 * router would decode the same way; nothing we send may be anything but the
 * one encoding.
 */

import { encodeFunctionData, erc20Abi } from "viem";
import { CASH, UNISWAP_V2_ENERGY_ABI, type EnergyRoute } from "../../../packages/core/src/index";
import type { Call } from "../executor";

export interface EnergyBuild {
  /** The route the grant sealed (grantEnergyRoute). */
  route: EnergyRoute;
  /** Raw USDG (6dp) the router pulls — and exactly what is approved. */
  amountIn: bigint;
  /** Raw $MERRYMEN (18dp) that must ARRIVE, post-tax. */
  minOut: bigint;
  /** The account itself — the executor's address. */
  recipient: `0x${string}`;
  /** Unix seconds; the router refuses a fill after it. */
  deadline: bigint;
}

/** The canonical swap calldata for these terms — the one encoding the fence accepts. */
export function energySwapData(b: EnergyBuild): `0x${string}` {
  return encodeFunctionData({
    abi: UNISWAP_V2_ENERGY_ABI,
    functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: [b.amountIn, b.minOut, [...b.route.path], b.recipient, b.deadline],
  });
}

/**
 * [approve USDG → router for exactly amountIn, the fee-on-transfer swap].
 *
 * Throws on a non-positive input or floor, or a route whose first hop is not
 * USDG: those are intents built wrong, and an encoder that silently produced
 * calldata for them would hand the fence something it should never see.
 */
export function buildEnergyCalls(b: EnergyBuild): Call[] {
  if (b.amountIn <= 0n) throw new Error(`energy buy: amountIn ${b.amountIn} is not a size`);
  if (b.minOut <= 0n) throw new Error(`energy buy: minOut ${b.minOut} is not a floor`);
  if (b.deadline <= 0n) throw new Error(`energy buy: deadline ${b.deadline} is not a time`);
  const usdg = b.route.path[0];
  if (usdg.toLowerCase() !== (CASH.USDG as string).toLowerCase()) {
    throw new Error(`energy buy: the route starts at ${usdg}, not USDG`);
  }
  return [
    {
      to: usdg,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [b.route.router, b.amountIn] }),
    },
    { to: b.route.router, value: 0n, data: energySwapData(b) },
  ];
}
