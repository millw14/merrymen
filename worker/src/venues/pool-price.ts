/**
 * DEX price for assets with no Chainlink feed — the second step of memecoin
 * support, and the one that decides whether the safety wall stays real.
 *
 * WHY THIS IS DELICATE. Chainlink is what makes merrymen's valuation
 * trustworthy: it's an external, expensive-to-move number. A DEX pool is not —
 * on a thin memecoin pool, anyone with moderate capital can push the spot price
 * for one block. That price would otherwise feed equity, P&L and the DRAWDOWN
 * BREAKER, so trusting spot would let an outsider fake your net worth or trip
 * your circuit breaker on demand. The safety wall would become decorative.
 *
 * THE SPLIT THIS MODULE IMPLEMENTS:
 *   • TWAP  → valuation and safety (equity, P&L, the breaker). Time-averaged
 *             through the pool's own oracle, so moving it means holding the
 *             price away from the market for the whole window and eating the
 *             arbitrage — expensive, not free.
 *   • SPOT  → execution sizing only. What you'd actually trade at right now.
 *             Wrong-but-current beats right-but-stale when you're sizing a swap.
 *
 * Plus two refusals, because a price you can't trust is worse than no price:
 *   • a LIQUIDITY FLOOR — a pool too thin to value is simply refused
 *   • a DIVERGENCE BAND — spot far from TWAP means someone is pushing the pool
 *     right now; refuse rather than trade into it
 *
 * Everything is quoted as USDG-per-whole-token in 8dp (`price8`), the same unit
 * Chainlink feeds already produce, so positionValueUsdg and the entire asset
 * model downstream need no changes at all.
 */

import { parseAbi, type PublicClient } from "viem";
import { UNISWAP } from "../../../packages/core/src/index";
import { FEE_TIERS } from "./uniswap";

const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)",
  "function token0() view returns (address)",
  "function liquidity() view returns (uint128)",
]);

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** Default averaging window. Long enough that moving it costs real money, short
 * enough to track an asset that genuinely reprices in minutes. */
export const DEFAULT_TWAP_WINDOW_SEC = 900; // 15 minutes

export interface PoolPrice {
  pool: `0x${string}`;
  fee: number;
  /** TWAP, cash per whole token, 8dp — use for valuation and safety. */
  price8: bigint;
  /** Spot, same units — use for execution sizing only. */
  spot8: bigint;
  /**
   * The same TWAP at 18dp.
   *
   * 8dp is plenty when the cash leg is USDG, but this pool may be quoting
   * against WETH, and a sub-cent memecoin is then worth ~0.000000015 WETH —
   * which at 8dp rounds to the integer 2. Combining THAT through a second leg
   * carries ~30% error and moves in 50% steps, so a 1% price drift reads as a
   * halving and trips the drawdown breaker on rounding. Intermediate legs must
   * combine at 18dp and be scaled to 8dp exactly once, at the end.
   */
  price18: bigint;
  spot18: bigint;
  /**
   * How deep the pool is AT THE CURRENT PRICE, in the cash token's own raw
   * units. Paired with `cashDecimals` so the caller converts to USD once,
   * explicitly, instead of guessing the scale.
   *
   * This is the virtual reserve implied by in-range liquidity, NOT the pool's
   * ERC-20 balance. The balance counts out-of-range positions, uncollected fees
   * and stray transfers — none of which defend the price — so anyone could mint
   * a single-sided position far from the current tick, clear a depth floor for
   * the cost of gas and temporary capital, withdraw it later, and manipulate a
   * pool the guard just vouched for.
   */
  liquidityCashRaw: bigint;
  cashDecimals: number;
  twapWindowSec: number;
  /** |spot − twap| / twap, in bps. Large ⇒ the pool is being pushed right now. */
  divergenceBps: number;
}

// ── pure math (exported for tests; no RPC, no clock) ────────────────────────

/**
 * Convert a Uniswap v3 tick to USDG-per-whole-token at 8dp.
 *
 * A tick encodes token1_raw per token0_raw as 1.0001^tick. Two adjustments turn
 * that into a human price: invert when the token is token1 rather than token0,
 * and shift by the decimal difference between the two sides.
 *
 * Float exponentiation is deliberate. price8 carries 8 decimal places and a
 * double holds ~15 significant digits, so the rounding is far below the least
 * significant digit we emit — and the alternative (exact bigint 1.0001^n) costs
 * far more than the precision is worth for a valuation number.
 */
/**
 * A human price → a fixed-point bigint at `decimals`, without losing the digits
 * a double actually holds.
 *
 * `BigInt(Math.round(human * 10 ** decimals))` looks equivalent and is not: at
 * 18dp a price like 3000 needs 3e21, far past the 2^53 where a double stops
 * counting in ones, so the low-order digits become noise dressed up as
 * precision. This keeps the float multiply inside the exactly-representable
 * range and finishes the scaling in bigint.
 */
export function scalePrice(human: number, decimals: number): bigint {
  if (!Number.isFinite(human) || human <= 0) return 0n;
  const SAFE_DIGITS = 15; // what a double reliably carries
  const magnitude = Math.max(0, Math.ceil(Math.log10(human)));
  const inFloat = Math.max(0, Math.min(decimals, SAFE_DIGITS - magnitude));
  const scaled = BigInt(Math.round(human * 10 ** inFloat));
  return scaled * 10n ** BigInt(decimals - inFloat);
}

/**
 * Convert a Uniswap v3 tick to cash-per-whole-token at `decimals` places.
 *
 * A tick encodes token1_raw per token0_raw as 1.0001^tick. Two adjustments turn
 * that into a human price: invert when the token is token1 rather than token0,
 * and shift by the decimal difference between the two sides.
 *
 * NOTE the unit: this is the value of one WHOLE ERC-20 token (10^decimals raw
 * units) — the market's own unit. Chainlink instead quotes per ERC-8056 UI
 * SHARE, which is why a Chainlink price is multiplied by uiMultiplier and a pool
 * price must not be. Conflating them double-counts a stock split.
 */
export function tickToPrice(args: {
  tick: number;
  tokenIsToken0: boolean;
  tokenDecimals: number;
  cashDecimals: number;
  decimals?: number;
}): bigint {
  const ratio = Math.pow(1.0001, args.tick); // token1_raw per token0_raw
  const shift = Math.pow(10, args.tokenDecimals - args.cashDecimals);
  // token0 = TOKEN → ratio is cash per token; token0 = CASH → invert.
  const human = args.tokenIsToken0 ? ratio * shift : shift / ratio;
  return scalePrice(human, args.decimals ?? 8);
}

export function tickToPrice8(args: {
  tick: number;
  tokenIsToken0: boolean;
  tokenDecimals: number;
  cashDecimals: number;
}): bigint {
  return tickToPrice({ ...args, decimals: 8 });
}

/** Same, from slot0's sqrtPriceX96. (sqrt/2^96)² is token1_raw per token0_raw. */
export function sqrtPriceX96ToPrice(args: {
  sqrtPriceX96: bigint;
  tokenIsToken0: boolean;
  tokenDecimals: number;
  cashDecimals: number;
  decimals?: number;
}): bigint {
  const sqrt = Number(args.sqrtPriceX96) / 2 ** 96;
  const ratio = sqrt * sqrt;
  const shift = Math.pow(10, args.tokenDecimals - args.cashDecimals);
  const human = args.tokenIsToken0 ? ratio * shift : shift / ratio;
  return scalePrice(human, args.decimals ?? 8);
}

export function sqrtPriceX96ToPrice8(args: {
  sqrtPriceX96: bigint;
  tokenIsToken0: boolean;
  tokenDecimals: number;
  cashDecimals: number;
}): bigint {
  return sqrtPriceX96ToPrice({ ...args, decimals: 8 });
}

/**
 * How much CASH sits at the current price, in the cash token's raw units.
 *
 * For a v3 pool with in-range liquidity L at sqrtP, the virtual reserves are
 * x = L / sqrtP (token0) and y = L · sqrtP (token1) — the constant-product pool
 * that would produce the same price and the same marginal depth. That is the
 * number manipulation cost actually scales with, and unlike balanceOf it cannot
 * be inflated by out-of-range positions, uncollected fees or a plain transfer.
 *
 * Concentrated liquidity means real depth over a narrow band can exceed this, so
 * as a FLOOR test it errs toward refusing — the safe direction.
 */
export function cashDepthFromLiquidity(args: {
  liquidity: bigint;
  sqrtPriceX96: bigint;
  cashIsToken0: boolean;
}): bigint {
  const { liquidity: L, sqrtPriceX96: s } = args;
  if (L <= 0n || s <= 0n) return 0n;
  const Q96 = 2n ** 96n;
  return args.cashIsToken0 ? (L * Q96) / s : (L * s) / Q96;
}

/** Mean tick over the window, from the two cumulative readings observe() gives. */
export function meanTick(tickCumulatives: readonly bigint[], windowSec: number): number | null {
  if (tickCumulatives.length < 2 || windowSec <= 0) return null;
  const older = tickCumulatives[0];
  const newer = tickCumulatives[1];
  if (older === undefined || newer === undefined) return null;
  // observe() returns [olderCumulative, newerCumulative] for [windowSec, 0].
  return Number(newer - older) / windowSec;
}

/** |a − b| / b in bps. Zero when the reference is zero (nothing to compare to). */
export function divergenceBps(spot8: bigint, twap8: bigint): number {
  if (twap8 <= 0n) return 0;
  const diff = spot8 > twap8 ? spot8 - twap8 : twap8 - spot8;
  return Number((diff * 10_000n) / twap8);
}

export interface PriceGuard {
  /** Refuse pools shallower than this (USDG, 6dp). */
  minLiquidityUsdg: bigint;
  /** Refuse when spot has run this far from the TWAP — someone's pushing it. */
  maxDivergenceBps: number;
}

/**
 * Is this price safe to act on? A refusal is a feature: valuing a position off a
 * pool that can be moved for pocket change is how a "safe" agent gets drained.
 */
/**
 * Why a price was refused. A STABLE identifier, separate from the prose: the
 * worker only wants to tell the owner when the situation changes, and prose
 * containing a live pool balance changes every time anyone trades.
 */
export type RefusalKind = "no-twap" | "too-thin" | "divergent";

export function poolPriceUsable(
  p: { price8: bigint; liquidityUsdg: bigint; twapWindowSec: number; divergenceBps: number },
  guard: PriceGuard,
): { ok: true } | { ok: false; kind: RefusalKind; reason: string } {
  if (p.price8 <= 0n) {
    return { ok: false, kind: "no-twap", reason: "no usable TWAP from the pool" };
  }
  if (p.liquidityUsdg < guard.minLiquidityUsdg) {
    return {
      ok: false,
      kind: "too-thin",
      reason: `pool too thin: $${(Number(p.liquidityUsdg) / 1e6).toFixed(0)} at the current price < $${Number(guard.minLiquidityUsdg) / 1e6} floor`,
    };
  }
  if (p.divergenceBps > guard.maxDivergenceBps) {
    return {
      ok: false,
      kind: "divergent",
      reason: `spot is ${(p.divergenceBps / 100).toFixed(1)}% off the ${p.twapWindowSec}s TWAP — pool may be under manipulation`,
    };
  }
  return { ok: true };
}

/**
 * Combine two TWAP legs into one price: TOKEN→WETH→USDG.
 *
 * ON-CHAIN REALITY (checked against live Robinhood Chain pools, 2026-07):
 * roughly three quarters of pools quote against WETH, not USDG — CATE, VIRTUAL,
 * KITTY, GRAILS, POTUS, HOODER and friends all pair with WETH. Only the stock
 * tokens (nvda, gme) and a couple of others have direct USDG pairs. So a
 * memecoin price is nearly always two hops, and pricing that assumed a direct
 * cash pair would simply find nothing for most of the chain.
 *
 * The depth of a two-hop route is the SHALLOWER leg — a deep WETH/USDG pool
 * does not make a $3k memecoin pool safe to value.
 */
export function combineLegs(tokenPerWeth18: bigint, wethPerCash8: bigint): bigint {
  if (tokenPerWeth18 <= 0n || wethPerCash8 <= 0n) return 0n;
  // 18dp × 8dp / 1e18 → 8dp. The token leg comes in at 18dp deliberately: at 8dp
  // a sub-cent memecoin's WETH price is a single-digit integer, and multiplying
  // THAT through the second leg quantizes the answer into ~50% steps.
  return (tokenPerWeth18 * wethPerCash8) / 1_000_000_000_000_000_000n;
}

// ── on-chain read ───────────────────────────────────────────────────────────

/**
 * Read TWAP + spot + depth for one token against the cash leg, picking the fee
 * tier with the deepest cash. Returns null when no pool exists or the oracle
 * can't serve the window.
 */
export interface CashPool {
  fee: number;
  pool: `0x${string}`;
  cashInPool: bigint;
}

/**
 * The pool a trade would actually route through: the one holding the most cash.
 *
 * Selection uses the balance rather than in-range liquidity because it's one
 * cheap call per tier. Steering this is not a way in: whichever pool is picked
 * then has its REAL depth measured, so pointing us at a donated-to shell costs
 * the token its price, it doesn't buy a fake one.
 *
 * Exported because the depth reader needs the SAME answer readPoolPrice gets.
 * Two copies of "which pool counts" could disagree, and then the price and the
 * depth map on the same screen would be describing different pools without
 * saying so — the exact silent drift this codebase treats as a defect.
 */
export async function bestCashPool(
  client: PublicClient,
  args: { token: `0x${string}`; cash: `0x${string}` },
): Promise<CashPool | null> {
  const pools = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      try {
        const pool = (await client.readContract({
          address: UNISWAP.v3Factory as `0x${string}`,
          abi: FACTORY_ABI,
          functionName: "getPool",
          args: [args.token, args.cash, fee],
        })) as `0x${string}`;
        if (!pool || /^0x0{40}$/i.test(pool)) return null;
        const cashInPool = (await client.readContract({
          address: args.cash,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [pool],
        })) as bigint;
        return { fee, pool, cashInPool };
      } catch {
        return null;
      }
    }),
  );

  let best: CashPool | null = null;
  for (const p of pools) if (p && (!best || p.cashInPool > best.cashInPool)) best = p;
  return best && best.cashInPool > 0n ? best : null;
}

export async function readPoolPrice(
  client: PublicClient,
  args: {
    token: `0x${string}`;
    tokenDecimals: number;
    cash: `0x${string}`;
    cashDecimals: number;
    windowSec?: number;
  },
): Promise<PoolPrice | null> {
  const windowSec = args.windowSec ?? DEFAULT_TWAP_WINDOW_SEC;

  const best = await bestCashPool(client, { token: args.token, cash: args.cash });
  if (!best) return null;

  try {
    const [token0, slot0, liquidity] = await Promise.all([
      client.readContract({ address: best.pool, abi: POOL_ABI, functionName: "token0" }) as Promise<`0x${string}`>,
      client.readContract({ address: best.pool, abi: POOL_ABI, functionName: "slot0" }) as Promise<
        readonly [bigint, number, number, number, number, number, boolean]
      >,
      client
        .readContract({ address: best.pool, abi: POOL_ABI, functionName: "liquidity" })
        .catch(() => 0n) as Promise<bigint>,
    ]);
    const tokenIsToken0 = token0.toLowerCase() === args.token.toLowerCase();
    const shape = {
      tokenIsToken0,
      tokenDecimals: args.tokenDecimals,
      cashDecimals: args.cashDecimals,
    };

    const spot8 = sqrtPriceX96ToPrice({ sqrtPriceX96: slot0[0], ...shape, decimals: 8 });
    const spot18 = sqrtPriceX96ToPrice({ sqrtPriceX96: slot0[0], ...shape, decimals: 18 });

    // A brand-new pool has observation cardinality 1, so observe() over any real
    // window reverts. That is a legitimate "no TWAP yet", not an error — and it
    // must NOT silently degrade to spot, which is the whole thing we're avoiding.
    let twap8 = 0n;
    let twap18 = 0n;
    try {
      const [tickCumulatives] = (await client.readContract({
        address: best.pool,
        abi: POOL_ABI,
        functionName: "observe",
        args: [[windowSec, 0]],
      })) as readonly [readonly bigint[], readonly bigint[]];
      const tick = meanTick(tickCumulatives, windowSec);
      if (tick !== null) {
        twap8 = tickToPrice({ tick, ...shape, decimals: 8 });
        twap18 = tickToPrice({ tick, ...shape, decimals: 18 });
      }
    } catch {
      twap8 = 0n; // oracle can't serve this window — poolPriceUsable will refuse
    }

    return {
      pool: best.pool,
      fee: best.fee,
      price8: twap8,
      spot8,
      price18: twap18,
      spot18,
      // Depth AT THE CURRENT PRICE, from in-range liquidity — not the pool's
      // balance, which anyone can inflate with an out-of-range mint.
      liquidityCashRaw: cashDepthFromLiquidity({
        liquidity,
        sqrtPriceX96: slot0[0],
        cashIsToken0: !tokenIsToken0,
      }),
      cashDecimals: args.cashDecimals,
      twapWindowSec: windowSec,
      // Measured at 18dp for the same reason the price is combined at 18dp: on a
      // TOKEN/WETH pool both 8dp figures collapse to single-digit integers, and
      // comparing 1 against 2 reads as a 100% divergence. Every WETH-routed
      // memecoin — most of this chain — would be refused as "manipulated" while
      // trading perfectly normally. It's a ratio, so the scale cancels.
      divergenceBps: divergenceBps(spot18, twap18),
    };
  } catch {
    return null;
  }
}

/**
 * Quote a directly executable swap. Unlike portfolio valuation, execution must
 * still be possible for a pool that has not accumulated a TWAP observation yet.
 * The caller still applies slippage and the wall's amount limit; this helper
 * only chooses the current pool price when the conservative TWAP is unavailable.
 */
export async function readExecutionPoolPrice(
  client: PublicClient,
  args: { token: `0x${string}`; tokenDecimals: number; cash: `0x${string}`; cashDecimals: number },
): Promise<PoolPrice | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000));
  return Promise.race([readExecutionPoolPriceUnbounded(client, args), timeout]);
}

async function readExecutionPoolPriceUnbounded(
  client: PublicClient,
  args: { token: `0x${string}`; tokenDecimals: number; cash: `0x${string}`; cashDecimals: number },
): Promise<PoolPrice | null> {
  const best = await bestCashPool(client, { token: args.token, cash: args.cash });
  if (!best) return null;
  try {
    const [token0, slot0, liquidity] = await Promise.all([
      client.readContract({ address: best.pool, abi: POOL_ABI, functionName: "token0" }) as Promise<`0x${string}`>,
      client.readContract({ address: best.pool, abi: POOL_ABI, functionName: "slot0" }) as Promise<
        readonly [bigint, number, number, number, number, number, boolean]
      >,
      client.readContract({ address: best.pool, abi: POOL_ABI, functionName: "liquidity" }).catch(() => 0n) as Promise<bigint>,
    ]);
    const tokenIsToken0 = token0.toLowerCase() === args.token.toLowerCase();
    const shape = { tokenIsToken0, tokenDecimals: args.tokenDecimals, cashDecimals: args.cashDecimals };
    const spot8 = sqrtPriceX96ToPrice({ sqrtPriceX96: slot0[0], ...shape, decimals: 8 });
    const spot18 = sqrtPriceX96ToPrice({ sqrtPriceX96: slot0[0], ...shape, decimals: 18 });
    if (spot8 <= 0n || spot18 <= 0n) return null;

    // A live TWAP is preferable, but it is not required to execute a newly
    // initialized pool. The execution caller applies slippage to this quote.
    let price8 = 0n;
    let price18 = 0n;
    try {
      const [tickCumulatives] = (await client.readContract({
        address: best.pool,
        abi: POOL_ABI,
        functionName: "observe",
        args: [[DEFAULT_TWAP_WINDOW_SEC, 0]],
      })) as readonly [readonly bigint[], readonly bigint[]];
      const tick = meanTick(tickCumulatives, DEFAULT_TWAP_WINDOW_SEC);
      if (tick !== null) {
        price8 = tickToPrice({ tick, ...shape, decimals: 8 });
        price18 = tickToPrice({ tick, ...shape, decimals: 18 });
      }
    } catch {
      // Fresh pools may not have enough observations for a TWAP.
    }
    return {
      pool: best.pool,
      fee: best.fee,
      price8: price8 > 0n ? price8 : spot8,
      spot8,
      price18: price18 > 0n ? price18 : spot18,
      spot18,
      liquidityCashRaw: cashDepthFromLiquidity({
        liquidity,
        sqrtPriceX96: slot0[0],
        cashIsToken0: !tokenIsToken0,
      }),
      cashDecimals: args.cashDecimals,
      twapWindowSec: DEFAULT_TWAP_WINDOW_SEC,
      divergenceBps: price18 > 0n ? divergenceBps(spot18, price18) : 0,
    };
  } catch {
    return null;
  }
}

/** Raw cash units at `cashDecimals` → USD at 6dp, given USD per whole cash unit.
 *  Exported so the v4 price path scales depth the SAME way — the comment at the
 *  weth-route call site exists because doing this by hand lands 1e12 out. */
export function cashRawToUsdg(rawCash: bigint, cashDecimals: number, cashPriceUsd8: bigint): bigint {
  if (rawCash <= 0n || cashPriceUsd8 <= 0n) return 0n;
  // raw / 10^cashDecimals × price8 / 1e8 × 1e6  →  divide by 10^(cashDecimals + 2)
  return (rawCash * cashPriceUsd8) / 10n ** BigInt(cashDecimals + 2);
}

export interface RoutedPrice {
  /** TWAP, USD per whole token, 8dp — valuation and safety. */
  price8: bigint;
  /** Spot, same units — execution sizing only. */
  spot8: bigint;
  /** "direct" (TOKEN/USDG) or "weth" (TOKEN/WETH × WETH/USDG). */
  route: "direct" | "weth";
  /** USD depth of the SHALLOWEST leg — what actually bounds manipulation cost. */
  liquidityUsdg: bigint;
  /** Worst divergence across the legs. */
  divergenceBps: number;
  twapWindowSec: number;
}

/**
 * Price one token in USD by whichever route is DEEPER: the direct TOKEN/USDG
 * pool, or TOKEN/WETH priced through WETH/USDG. Returns null when neither works.
 *
 * WHY BOTH, ALWAYS. Preferring "direct if it produces any price at all" looks
 * cheaper and is wrong, as live pools on this chain show plainly: ARROW has a
 * USDG pool with a valid TWAP and ZERO in-range liquidity, and a WETH pool with
 * real liquidity behind it. Take the direct route because it answered first and
 * the token is refused as bottomless — while a perfectly usable route sits one
 * hop away. CASHCAT is the milder version: a $32k direct pool preempts a ~$1.5M
 * WETH route, and the token gets valued off the thinner of the two.
 *
 * Depth is the metric because depth is what bounds manipulation cost — the same
 * reason the guard reads it. Two extra pool reads per token is nothing next to
 * refusing tokens that are fine, and the caller's cache absorbs the cost.
 *
 * The caller still runs poolPriceUsable() on the result: routing finds a price,
 * it does not vouch for one.
 */
export async function readRoutedPrice(
  client: PublicClient,
  args: {
    token: `0x${string}`;
    tokenDecimals: number;
    cash: `0x${string}`;
    cashDecimals: number;
    weth: `0x${string}`;
    wethDecimals?: number;
    windowSec?: number;
  },
): Promise<RoutedPrice | null> {
  const windowSec = args.windowSec ?? DEFAULT_TWAP_WINDOW_SEC;
  const wethDecimals = args.wethDecimals ?? 18;

  // Same token on both sides would "price" WETH against itself.
  const isWeth = args.token.toLowerCase() === args.weth.toLowerCase();

  const [direct, leg, wethLeg] = await Promise.all([
    readPoolPrice(client, {
      token: args.token,
      tokenDecimals: args.tokenDecimals,
      cash: args.cash,
      cashDecimals: args.cashDecimals,
      windowSec,
    }),
    isWeth
      ? Promise.resolve(null)
      : readPoolPrice(client, {
          token: args.token,
          tokenDecimals: args.tokenDecimals,
          cash: args.weth,
          cashDecimals: wethDecimals,
          windowSec,
        }),
    isWeth
      ? Promise.resolve(null)
      : readPoolPrice(client, {
          token: args.weth,
          tokenDecimals: wethDecimals,
          cash: args.cash,
          cashDecimals: args.cashDecimals,
          windowSec,
        }),
  ]);

  const directRoute: RoutedPrice | null =
    direct && direct.price8 > 0n
      ? {
          price8: direct.price8,
          spot8: direct.spot8,
          route: "direct",
          // Cash IS USDG here, so a whole unit is $1 — 1e8 at 8dp.
          liquidityUsdg: cashRawToUsdg(direct.liquidityCashRaw, direct.cashDecimals, 100_000_000n),
          divergenceBps: direct.divergenceBps,
          twapWindowSec: windowSec,
        }
      : null;

  if (!leg || !wethLeg || leg.price8 <= 0n || wethLeg.price8 <= 0n) return directRoute;

  // The TOKEN/WETH pool's depth is denominated in WETH — 18 raw decimals, and
  // each whole WETH is worth wethLeg.price8. Converting it explicitly through
  // cashRawToUsdg is the whole point: doing this scaling by hand is how the
  // number ends up 1e12 too large, which silently makes the depth floor
  // unreachable on the WETH route — i.e. on most of this chain.
  const legDepthUsdg = cashRawToUsdg(leg.liquidityCashRaw, leg.cashDecimals, wethLeg.price8);
  const wethDepthUsdg = cashRawToUsdg(wethLeg.liquidityCashRaw, wethLeg.cashDecimals, 100_000_000n);

  const wethRoute: RoutedPrice = {
    // The token leg combines at 18dp; anything less quantizes a sub-cent
    // memecoin's WETH price into single-digit integers.
    price8: combineLegs(leg.price18, wethLeg.price8),
    spot8: combineLegs(leg.spot18, wethLeg.spot8),
    route: "weth",
    // A deep WETH/USDG pool does NOT make a shallow memecoin pool safe: the
    // route is only as manipulable as its thinnest leg.
    liquidityUsdg: legDepthUsdg < wethDepthUsdg ? legDepthUsdg : wethDepthUsdg,
    divergenceBps: Math.max(leg.divergenceBps, wethLeg.divergenceBps),
    twapWindowSec: windowSec,
  };
  if (wethRoute.price8 <= 0n) return directRoute;
  if (!directRoute) return wethRoute;
  // Deeper wins. Ties go to direct — one hop, one pool to reason about.
  return wethRoute.liquidityUsdg > directRoute.liquidityUsdg ? wethRoute : directRoute;
}
