import {
  CASH,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  UNISWAP,
  grantHasTransfer,
  grantHasV4,
  grantV4Adapter,
  grantPonsAdapter,
  builtinGrantTargets,
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
  /**
   * Curves this agent has seen launch, from the FACTORY-FILTERED scan.
   *
   * Passed in rather than read here because this module is deliberately pure
   * and grant-sourced; the caller owns the store. Defaulting to undefined —
   * not [] — matters: undefined means the rule cannot run, [] would mean every
   * curve is unknown and would refuse the venue outright. A check that did not
   * run must never read as one that passed, and it must not silently become a
   * blanket refusal either.
   */
  knownCurves?: readonly string[],
): AgentLimits {
  return {
    perTradeUsdg: usdgUnits(grant.caps.perTradeUsdg),
    dailyUsdg: usdgUnits(grant.caps.dailyUsdg),
    allowedTargets: [
      // RIALTO IS NOT HERE, and its absence is the fix.
      //
      // It used to be listed for every grant, while the wall only ever emits
      // that permission under `allowRialto` — which no signer sets, so no grant
      // this repo can produce carries it. That is the mirror LOOSER than the
      // chain, the one direction this file exists to prevent: the worker
      // believed it could route through Rialto, built the UserOp, and the chain
      // refused it. Gas spent to be told no, by a revert that names nothing.
      //
      // Deliberately not replaced with a marker check. There is no marker,
      // because there is no capability to mark; inventing one would be
      // scaffolding for a route nothing grants. If Rialto is ever enabled it
      // gets a marker then, the way GRANT_V4_ADAPTER and GRANT_PONS_ADAPTER
      // did — permission and marker minted together, never one without the
      // other.
      UNISWAP.swapRouter02 as `0x${string}`,
      MORPHO.steakhouseUsdgVault as `0x${string}`,
      CASH.USDG as `0x${string}`,
      ...(grantHasV4(grant)
        ? [UNISWAP.permit2 as `0x${string}`, UNISWAP.universalRouter as `0x${string}`]
        : []),
      // THE V4 ADAPTER, MIRRORED — and mirrored from the GRANT, not from
      // settings. grantV4Adapter returns the address the swapExactIn
      // permission was actually sealed against (marker AND address, or null),
      // so this list can never admit an adapter the chain would refuse. The
      // transfer-mirror lesson runs in both directions: without this entry a
      // correctly-granted adapter call dies off-chain at `target-allowlist`,
      // a route that looks granted and never fires — the multihop bug's
      // silent sibling.
      ...((): `0x${string}`[] => {
        const a = grantV4Adapter(grant);
        return a ? [a] : [];
      })(),
      // THE PONS ADAPTER, MIRRORED, on exactly the same terms and from the same
      // authority: the GRANT, never settings. `cfg.ponsAdapterAddress` is a
      // configuration field anyone with the dashboard can edit; the address the
      // `tradeExactIn` permission was actually sealed against is the only one
      // the chain will honour, and grantPonsAdapter returns it only when the
      // marker and a valid address both exist.
      //
      // Reading settings here would let a setting silently redirect the
      // agent's trades at a contract the signature never covered — the mirror
      // going LOOSER than the chain, which is the one direction that is never
      // safe. Omitting it entirely would be the other failure: a correctly
      // granted adapter call dying off-chain at `target-allowlist`, a route
      // that looks granted and never fires.
      ...((): `0x${string}`[] => {
        const a = grantPonsAdapter(grant);
        return a ? [a] : [];
      })(),
    ],
    allowedAssets: [CASH.USDG as `0x${string}`, ...watchTokens.map((token) => token.address)],
    sellableAssets: [...sellableAssets(grant)],
    // The quote side only -- see AgentLimits.quoteAssets. sellableAssets minus
    // this is the set of tokens a curve trade could be buying INTO.
    quoteAssets: [...builtinGrantTargets(grant)],
    knownCurves,
    // THE TRANSFER PERMISSION, MIRRORED. checkPolicy has always known how to
    // judge this — it was simply never told. A grant without the transfer
    // marker has NO USDG transfer permission in its call policy:
    // buildCallPermissions emits one only for withdrawal addresses registered
    // at signing, and neither signer registers any.
    //
    // EMPTY, not undefined. undefined means "a pre-allowlist grant, still
    // free-form" and is deliberately permissive; conflating the two is exactly
    // what let the worker build a transfer the chain refuses. This is the
    // load-bearing half of the fix, because it covers EVERY producer of a
    // transfer intent rather than just the Telegram command — and it turns an
    // opaque on-chain revert into the sentence checkPolicy already writes.
    ...(grantHasTransfer(grant) ? {} : { withdrawalAddresses: [] as string[] }),
    // So the breaker can tell a de-risking sell (swap INTO cash) from a buy.
    cashToken: CASH.USDG as string,
    maxDrawdownBps: grant.caps.maxDrawdownPct * 100,
    expiresAt: grant.expiresAt,
    maxOpsPerDay: grant.caps.maxOpsPerDay,
  };
}
