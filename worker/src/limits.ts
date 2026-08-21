import {
  CASH,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  UNISWAP,
  grantHasV4,
  sellableAssets,
  usdgUnits,
  type StockToken,
  type StoredGrant,
} from "../../packages/core/src/index";
import type { AgentLimits } from "./policy";

/** Build the off-chain mirror of the limits sealed into a signed grant. */
export function limitsFromGrant(
  grant: StoredGrant,
  watchTokens: readonly StockToken[] = STOCK_TOKENS,
): AgentLimits {
  return {
    perTradeUsdg: usdgUnits(grant.caps.perTradeUsdg),
    dailyUsdg: usdgUnits(grant.caps.dailyUsdg),
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
