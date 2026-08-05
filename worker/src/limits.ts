import {
  CASH,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  UNISWAP,
  USDG_DECIMALS,
  grantHasV4,
  sellableAssets,
  type StockToken,
  type StoredGrant,
} from "../../packages/core/src/index";
import type { AgentLimits } from "./policy";

const usdg = (value: number): bigint => BigInt(Math.round(value * 10 ** USDG_DECIMALS));

/** Build the off-chain mirror of the limits sealed into a signed grant. */
export function limitsFromGrant(
  grant: StoredGrant,
  watchTokens: readonly StockToken[] = STOCK_TOKENS,
): AgentLimits {
  return {
    perTradeUsdg: usdg(grant.caps.perTradeUsdg),
    dailyUsdg: usdg(grant.caps.dailyUsdg),
    allowedTargets: [
      RIALTO.routerSnapshot as `0x${string}`,
      UNISWAP.swapRouter02 as `0x${string}`,
      MORPHO.steakhouseUsdgVault as `0x${string}`,
      CASH.USDG as `0x${string}`,
      ...(grantHasV4(grant)
        ? [UNISWAP.permit2 as `0x${string}`, UNISWAP.universalRouter as `0x${string}`]
        : []),
    ],
    allowedAssets: [CASH.USDG as `0x${string}`, ...watchTokens.map((token) => token.address)],
    sellableAssets: [...sellableAssets(grant)],
    maxDrawdownBps: grant.caps.maxDrawdownPct * 100,
    expiresAt: grant.expiresAt,
    maxOpsPerDay: grant.caps.maxOpsPerDay,
  };
}
