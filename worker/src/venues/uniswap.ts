/**
 * Uniswap v3 direct execution — the permissionless swap venue.
 *
 * Rialto's /quote API needs integrator onboarding; Uniswap v3 needs nobody's
 * permission. Flow per swap: QuoterV2 simulation across fee tiers (this IS the
 * pre-trade simulation — it reverts where the swap would revert and returns a
 * gas estimate we store as the receipt) → slippage-bounded minOut →
 * exactInputSingle through SwapRouter02.
 *
 * LIQUIDITY REALITY (2026-07): stock-token v3 pools are seed-sized. The quoter
 * tells us the truth about impact before any money moves — a missing pool shows
 * up as no-quote and the trade is skipped.
 *
 * A TERRIBLE quote IS now skipped — by worker/src/impact.ts, which this comment
 * spent a long time claiming existed before it did. For most of this file's
 * life the sentence here read "skipped by the impact guard upstream" and there
 * was no such guard anywhere in the repo. The two settings that sound like one
 * — minPoolLiquidityUsdg and maxPriceDivergenceBps — gate whether a FEEDLESS
 * token can be PRICED (see venues/pool-price.ts); they have nothing to say
 * about whether a trade can be SIZED. So a quote 40% through the book got a
 * minOut 1% below itself and executed happily.
 *
 * The guard re-prices the chosen route at a small probe size (requoteRoute,
 * below) and compares average execution price to marginal — the pool fee
 * cancels between the two, leaving impact alone. minOut remains what it always
 * was and defends what it always defended: the price MOVING between the quote
 * and the fill. It was never able to judge the quote itself.
 *
 * Trades also record fill_slippage_bps (quoted vs received), so the flat
 * slippage constant can eventually be replaced by a measured distribution. The
 * depth engine in venues/depth.ts computes the same impact number exactly, and
 * is deliberately barred from reaching policy (see depth.invariant.test.ts) —
 * which is why the guard measures from the quoter instead.
 */

import { encodeFunctionData, erc20Abi, parseAbi, type Hex, type PublicClient } from "viem";
import { UNISWAP, UNISWAP_SWAP_ROUTER_ABI } from "../../../packages/core/src/index";
import { buildV4AdapterSwapCalls, buildV4SwapCalls, findV4Pool, quoteV4, type PoolKey } from "./uniswap-v4";

/**
 * Fee tiers to scan.
 *
 * 100 (0.01%) IS WHERE THIS CHAIN'S MAIN PAIR LIVES, and it was missing. The
 * scout's own trending read reports "USDG/WETH 0.01% … the 26.1M pool"
 * (2026-10-02), so every price or route that hops through WETH could not see
 * the deepest WETH/USDG pool on the chain. Meanwhile the autonomous Trencher's
 * discovery verifies pools against the factory at the fee each pool REPORTS
 * (trencher-discovery.ts), so it admitted pools this list could never find:
 * the same agents logged "passing on T6F99D9422EB — no venue gave a usable
 * price" every tick for coins discovery had just proved were canonical v3
 * pools against USDG or WETH. A coin nothing can price is a coin it never buys.
 *
 * The wall does not pin a tier (wall.ts: "fee — any tier the pool actually
 * has"), so a 0.01% route is one the owner's signature already allows.
 */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;

export const QUOTER_V2_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

export interface Quote {
  fee: number;
  amountOut: bigint;
  gasEstimate: bigint;
  /**
   * The hops, in order, when this quote is multi-hop. Absent = a direct
   * single-hop swap, which is what most of this file's callers still produce.
   */
  path?: { tokens: readonly `0x${string}`[]; fees: readonly number[] };
  /**
   * Present when this quote came from Uniswap **v4**, carrying the exact pool it
   * priced. v4 executes through Permit2 + UniversalRouter, so a quote and its
   * calldata are not interchangeable with v3's — buildTradeCalls dispatches on
   * this, and losing it would mean executing a different route than the one
   * minOut was computed against.
   */
  v4?: { key: PoolKey };
}

/**
 * Pack a Uniswap v3 path: token(20) fee(3) token(20) [fee(3) token(20)]…
 *
 * The router walks this itself and holds the intermediate leg, which is the
 * detail that matters for the permission wall: a USDG→WETH→CATE swap still only
 * ever pulls USDG from the account, so it needs no approval beyond the one every
 * grant already carries. Multi-hop widens where a trade can GO, never what the
 * key can TOUCH.
 */
export function encodePath(
  tokens: readonly `0x${string}`[],
  fees: readonly number[],
): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error(`bad path: ${tokens.length} tokens, ${fees.length} fees`);
  }
  let out = "0x";
  tokens.forEach((t, i) => {
    out += t.slice(2).toLowerCase();
    if (i < fees.length) out += fees[i]!.toString(16).padStart(6, "0");
  });
  return out as Hex;
}

/** Highest amountOut wins; null when no tier has a pool with liquidity. */
export function pickBestQuote(quotes: readonly (Quote | null)[]): Quote | null {
  let best: Quote | null = null;
  for (const q of quotes) {
    if (q && q.amountOut > 0n && (!best || q.amountOut > best.amountOut)) best = q;
  }
  return best;
}

/** minOut = quoted × (10000 − slippageBps) / 10000, floor semantics. */
export function minOutWithSlippage(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(`slippageBps out of range: ${slippageBps}`);
  }
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Quote one tier via eth_call simulation; null = no pool / no liquidity there. */
export async function quoteTier(
  client: PublicClient,
  args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint; fee: number },
): Promise<Quote | null> {
  try {
    const { result } = await client.simulateContract({
      address: UNISWAP.v3QuoterV2 as `0x${string}`,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          amountIn: args.amountIn,
          fee: args.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const [amountOut, , , gasEstimate] = result;
    return { fee: args.fee, amountOut, gasEstimate };
  } catch {
    return null;
  }
}

/** Quote one explicit multi-hop path. null = some leg has no pool / no liquidity. */
export async function quotePath(
  client: PublicClient,
  args: { tokens: readonly `0x${string}`[]; fees: readonly number[]; amountIn: bigint },
): Promise<Quote | null> {
  try {
    const { result } = await client.simulateContract({
      address: UNISWAP.v3QuoterV2 as `0x${string}`,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInput",
      args: [encodePath(args.tokens, args.fees), args.amountIn],
    });
    const [amountOut, , , gasEstimate] = result;
    if (amountOut <= 0n) return null;
    return {
      // Reported for the receipt only — a multi-hop swap has no single fee.
      fee: args.fees[0]!,
      amountOut,
      gasEstimate,
      path: { tokens: args.tokens, fees: args.fees },
    };
  } catch {
    return null;
  }
}

/** Scan all fee tiers concurrently and return the best executable quote. */
export async function bestQuote(
  client: PublicClient,
  args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint },
): Promise<Quote | null> {
  const quotes = await Promise.all(FEE_TIERS.map((fee) => quoteTier(client, { ...args, fee })));
  return pickBestQuote(quotes);
}

/**
 * Best executable quote allowing ONE intermediate hop through `via` (WETH).
 *
 * Direct-only execution was leaving real tokens untradable. Live pools on
 * Robinhood Chain (2026-07-27): of the tokens merrymen can price, nine — UP,
 * YOLO, APES, MUMU, WEN, TYGR, WISHBONE, KITSU, wire — have no direct USDG pool
 * at all. They could be valued perfectly and never bought or sold, which is the
 * same trapped-position shape the no-exit rule exists to prevent, arrived at
 * from the execution side instead of the permission side.
 *
 * Every direct tier and every two-hop fee combination is quoted, and the best
 * amountOut wins outright — so a direct pool that happens to be better is still
 * chosen, and adding hops can only ever improve the fill the caller gets.
 */
export async function bestRoute(
  client: PublicClient,
  args: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    /** Intermediate token to try routing through. Omit to stay single-hop. */
    via?: `0x${string}`;
    /**
     * Also quote Uniswap v4. Gated by the CALLER on whether the signed grant
     * carries the v4 permissions — quoting a venue the key can't reach would
     * pick a route that then reverts at the wall, which is worse than never
     * having considered it.
     */
    v4?: boolean;
    /**
     * Discovered v4 PoolKeys for this pair — the HOOKED pools, learned from
     * Initialize events (store.poolKeysFor). findV4Pool can only ever guess
     * hookless keys, so without this list the freshest launches are
     * structurally unreachable. Quoted only when `v4` is on: a key the grant
     * cannot execute is a route that reverts at the wall.
     */
    v4Keys?: readonly PoolKey[];
  },
): Promise<Quote | null> {
  const lc = (a: string) => a.toLowerCase();
  const direct = FEE_TIERS.map((fee) => quoteTier(client, { ...args, fee }));

  // v4 is one more candidate in the same comparison, not a preference. Best
  // amountOut wins outright, so adding it can only improve the fill — and on
  // this chain it sometimes does (AAPL quotes better on v4 than v3).
  const v4 = args.v4
    ? [
        (async (): Promise<Quote | null> => {
          const pool = await findV4Pool(client, args.tokenIn, args.tokenOut);
          if (!pool) return null;
          const q = await quoteV4(client, { key: pool.key, tokenIn: args.tokenIn, amountIn: args.amountIn });
          if (!q) return null;
          return {
            fee: pool.key.fee,
            amountOut: q.amountOut,
            gasEstimate: q.gasEstimate,
            v4: { key: pool.key },
          };
        })(),
        // The discovered keys, each its own candidate in the same comparison.
        // quoteV4 is hooks-agnostic — it always could quote these; nothing
        // ever FED it one before. Deduped against the hookless guess by pool
        // id inside pickBestQuote's amountOut comparison (an identical pool
        // quotes identically, so the duplicate merely ties with itself).
        //
        // ENTRY INTO A HOOKED POOL ALSO REQUIRES THE EXIT TO QUOTE. A hook
        // decides per-swap: one that admits buys and reverts sells is the
        // no-exit trap one level below the wall, and the wall cannot see it —
        // the sell permission exists, the pool just refuses to fill it. The
        // reverse probe is a heuristic (hook behaviour can change after
        // entry, and that residual is what the scout budget bounds), but a
        // pool that will not quote the way OUT right now is not a pool to
        // walk into.
        ...(args.v4Keys ?? []).map(async (key): Promise<Quote | null> => {
          const q = await quoteV4(client, { key, tokenIn: args.tokenIn, amountIn: args.amountIn });
          if (!q) return null;
          if (lc(key.hooks) !== lc("0x0000000000000000000000000000000000000000")) {
            const back = await quoteV4(client, { key, tokenIn: args.tokenOut, amountIn: q.amountOut });
            if (!back || back.amountOut <= 0n) return null;
          }
          return {
            fee: key.fee,
            amountOut: q.amountOut,
            gasEstimate: q.gasEstimate,
            v4: { key },
          };
        }),
      ]
    : [];

  // Hopping through one of the endpoints is the same swap with extra steps.
  const viaUsable =
    args.via && lc(args.via) !== lc(args.tokenIn) && lc(args.via) !== lc(args.tokenOut);
  const hops = viaUsable
    ? FEE_TIERS.flatMap((a) =>
        FEE_TIERS.map((b) =>
          quotePath(client, {
            tokens: [args.tokenIn, args.via!, args.tokenOut],
            fees: [a, b],
            amountIn: args.amountIn,
          }),
        ),
      )
    : [];

  return pickBestQuote(await Promise.all([...direct, ...hops, ...v4]));
}

/**
 * Re-price the SAME route at a different size.
 *
 * The impact guard needs a marginal price for the exact route about to execute,
 * and `bestRoute` cannot give it: run at a probe size it re-selects, and a tiny
 * order routes through a different tier than a large one — so the comparison
 * would be between two different pools and the "impact" it measured would be an
 * artefact of the switch. Dispatching on the quote's own shape is what keeps
 * both numbers on one route, the same reason buildTradeCalls dispatches on it
 * rather than being told the venue separately.
 *
 * Returns null when this size finds no liquidity on that route, which the
 * caller must treat as unknown — never as zero impact.
 */
export async function requoteRoute(
  client: PublicClient,
  route: Quote,
  args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint },
): Promise<bigint | null> {
  if (route.v4) {
    const q = await quoteV4(client, { key: route.v4.key, tokenIn: args.tokenIn, amountIn: args.amountIn });
    return q?.amountOut ?? null;
  }
  if (route.path) {
    const q = await quotePath(client, {
      tokens: route.path.tokens,
      fees: route.path.fees,
      amountIn: args.amountIn,
    });
    return q?.amountOut ?? null;
  }
  const q = await quoteTier(client, { ...args, fee: route.fee });
  return q?.amountOut ?? null;
}

/**
 * Every call needed to execute a quote, in order — the ONE place a route turns
 * into calldata.
 *
 * v3 and v4 need different approvals and a different router, and the quote is
 * what says which. Building these separately at the call site is how you end up
 * approving one router and swapping through another, or executing a v3 path
 * against a minOut computed on a v4 pool. Threading the quote through means the
 * route that was priced is necessarily the route that runs.
 */
export function buildTradeCalls(args: {
  quote: Quote;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  recipient: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
  /** Unix seconds. v4 only — bounds the Permit2 allowance and the router call. */
  deadline: number;
  /**
   * The grant-sealed V4SelfSwap address, when this grant carries one. Present
   * ⇒ v4 quotes execute through the adapter (two calls, no Permit2, recipient
   * structural). Absent ⇒ the legacy Permit2 + UniversalRouter path, which
   * only pre-adapter GRANT_V4 grants can actually reach.
   */
  v4Adapter?: `0x${string}`;
}): SwapCall[] {
  if (args.quote.v4) {
    if (args.v4Adapter) {
      return buildV4AdapterSwapCalls({
        adapter: args.v4Adapter,
        key: args.quote.v4.key,
        tokenIn: args.tokenIn,
        amountIn: args.amountIn,
        minAmountOut: args.minAmountOut,
        deadline: args.deadline,
      });
    }
    return buildV4SwapCalls({
      key: args.quote.v4.key,
      tokenIn: args.tokenIn,
      amountIn: args.amountIn,
      minAmountOut: args.minAmountOut,
      deadline: args.deadline,
    });
  }
  // v3: approve the router directly for exactly this trade, then swap.
  const approve: SwapCall = {
    to: args.tokenIn,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [UNISWAP.swapRouter02 as `0x${string}`, args.amountIn],
    }),
  };
  return [
    approve,
    buildSwapCall({
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      fee: args.quote.fee,
      recipient: args.recipient,
      amountIn: args.amountIn,
      minAmountOut: args.minAmountOut,
      path: args.quote.path,
    }),
  ];
}

export interface SwapCall {
  to: `0x${string}`;
  value: 0n;
  data: Hex;
}

/**
 * Build the swap call. Caller must have approved amountIn of tokenIn to the router.
 *
 * Pass the quote's `path` to execute the multi-hop route it found — the router
 * still only pulls tokenIn, so this needs no permission the single-hop form
 * didn't. Executing a single-hop call for a quote that was multi-hop would
 * silently trade a DIFFERENT (worse, or non-existent) route than the one whose
 * minOut the caller computed, so the two must be threaded together.
 */
export function buildSwapCall(args: {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  fee: number;
  recipient: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
  path?: { tokens: readonly `0x${string}`[]; fees: readonly number[] };
}): SwapCall {
  if (args.path) {
    return {
      to: UNISWAP.swapRouter02 as `0x${string}`,
      value: 0n,
      data: encodeFunctionData({
        abi: UNISWAP_SWAP_ROUTER_ABI,
        functionName: "exactInput",
        args: [
          {
            path: encodePath(args.path.tokens, args.path.fees),
            recipient: args.recipient,
            amountIn: args.amountIn,
            amountOutMinimum: args.minAmountOut,
          },
        ],
      }),
    };
  }
  return {
    to: UNISWAP.swapRouter02 as `0x${string}`,
    value: 0n,
    data: encodeFunctionData({
      abi: UNISWAP_SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          fee: args.fee,
          recipient: args.recipient,
          amountIn: args.amountIn,
          amountOutMinimum: args.minAmountOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  };
}
