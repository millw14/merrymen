/**
 * Uniswap v2 on Robinhood Chain — READ-ONLY quoting for the energy route.
 *
 * $MERRYMEN has no v3 pool and no v2 pair against USDG or WETH; its depth is a
 * v2 pair against VIRTUAL, and VIRTUAL has a v2 pair against USDG on the same
 * factory (measured 2026-09-27, see core energy.ts). So the one route that
 * prices energy is ENERGY_ROUTE_V1: USDG → VIRTUAL → $MERRYMEN through
 * Router02. This file asks that route questions and never builds a call that
 * could move anything: it imports the router's VIEW functions only
 * (UNISWAP_V2_ROUTER_READ_ABI), which are never granted to any key.
 *
 * NO TRANSPORT OF ITS OWN. Every read goes through a client the caller passes
 * in — the tick's metered `active.client` — so this adds no unmetered path to
 * the chain (stop-the-loop.test.ts counts transports per file; this file has
 * none).
 *
 * THE TAX IS READ, NOT REMEMBERED. $MERRYMEN is a Virtuals agent token with a
 * buy tax its own owner can change; the pool's getAmountsOut is the PRE-tax
 * figure. Every helper that turns a quote into what arrives takes the tax as
 * an argument, read fresh by `readEnergyTaxBps`.
 */

import {
  AGENT_TOKEN_TAX_ABI,
  ENERGY_ROUTE_V1,
  UNISWAP_V2_ROUTER_READ_ABI,
} from "../../../packages/core/src/index";
import { minOutWithSlippage } from "./uniswap";

/** The only capability these helpers need — a read. A fake in tests, the metered client in the tick. */
export interface ReadClient {
  readContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

const PATH = ENERGY_ROUTE_V1.path as readonly `0x${string}`[];
const BPS = 10_000n;

/** The amounts array a v2 router returned, or null when it is not one. */
function amountsOf(v: unknown): bigint[] | null {
  if (!Array.isArray(v) || v.length !== PATH.length) return null;
  return v.every((x) => typeof x === "bigint") ? (v as bigint[]) : null;
}

/**
 * $MERRYMEN the pool would send for `amountIn` raw USDG, BEFORE the token's
 * buy tax. null on a revert, a refused read, or an empty pool — "no quote" is
 * never a quote of zero.
 */
export async function quoteEnergyOut(client: ReadClient, amountIn: bigint): Promise<bigint | null> {
  if (amountIn <= 0n) return null;
  try {
    const out = amountsOf(
      await client.readContract({
        address: ENERGY_ROUTE_V1.router,
        abi: UNISWAP_V2_ROUTER_READ_ABI,
        functionName: "getAmountsOut",
        args: [amountIn, PATH],
      }),
    );
    const gross = out?.[PATH.length - 1];
    return gross !== undefined && gross > 0n ? gross : null;
  } catch {
    return null;
  }
}

/**
 * Raw USDG needed for the pool to send `grossOut` $MERRYMEN (pre-tax), with
 * both hops' 0.3% fees included — getAmountsIn's own arithmetic. null on a
 * revert (not enough liquidity for that size) or a refused read.
 */
export async function energyAmountInFor(client: ReadClient, grossOut: bigint): Promise<bigint | null> {
  if (grossOut <= 0n) return null;
  try {
    const amounts = amountsOf(
      await client.readContract({
        address: ENERGY_ROUTE_V1.router,
        abi: UNISWAP_V2_ROUTER_READ_ABI,
        functionName: "getAmountsIn",
        args: [grossOut, PATH],
      }),
    );
    const need = amounts?.[0];
    return need !== undefined && need > 0n ? need : null;
  } catch {
    return null;
  }
}

/** $MERRYMEN's buy tax in bps, read now. null when unreadable or not a sane bps figure. */
export async function readEnergyTaxBps(client: ReadClient): Promise<number | null> {
  try {
    const raw = await client.readContract({
      address: PATH[PATH.length - 1]!,
      abi: AGENT_TOKEN_TAX_ABI,
      functionName: "totalBuyTaxBasisPoints",
      args: [],
    });
    if (typeof raw !== "bigint" || raw < 0n || raw >= BPS) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

function assertBps(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v >= 10_000) throw new Error(`${name} out of range: ${v}`);
}

/**
 * The floor for what must ARRIVE: the pre-tax quote, less the tax, less
 * slippage — floored at each step, so the floor is never above what the
 * chain would deliver at the quoted rate.
 */
export function energyMinOut(gross: bigint, taxBps: number, slippageBps: number): bigint {
  assertBps("taxBps", taxBps);
  const afterTax = (gross * (BPS - BigInt(taxBps))) / BPS;
  return minOutWithSlippage(afterTax, slippageBps);
}

/**
 * The pre-tax amount to ask the pool for so that at least `netOut` arrives
 * after the tax and a `slippageBps` move — the exact inverse of energyMinOut,
 * ceiled at each step so energyMinOut(grossNeededFor(x)) ≥ x always holds.
 */
export function grossNeededFor(netOut: bigint, taxBps: number, slippageBps: number): bigint {
  assertBps("taxBps", taxBps);
  assertBps("slippageBps", slippageBps);
  if (netOut <= 0n) return 0n;
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  const beforeSlip = ceilDiv(netOut * BPS, BPS - BigInt(slippageBps));
  return ceilDiv(beforeSlip * BPS, BPS - BigInt(taxBps));
}
