import { erc20Abi, parseAbi, type Address } from "viem";
import { ParamCondition } from "@zerodev/permissions/policies";
import { CASH } from "./tokens";

export const GRANT_TRENCHER = "trencher-vault-v1";
export const TRENCHER_VAULT_ABI = parseAbi([
  "function VERSION() view returns (uint256)",
  "function owner() view returns (address)",
  "function cash() view returns (address)",
  "function router() view returns (address)",
  "function poolFactory() view returns (address)",
  "function spent() view returns (uint256)",
  "function windowStart() view returns (uint256)",
  "function tokens() view returns (address[])",
  "function entryAt(address token) view returns (uint256)",
  "function cost(address token) view returns (uint256)",
  "function buy(address token,uint24 fee1,uint24 fee2,uint256 cashIn,uint256 minOut,uint256 deadline) returns (uint256)",
  "function sell(address token,uint24 fee1,uint24 fee2,uint256 tokensIn,uint256 minOut,uint256 deadline) returns (uint256)",
  "function recover(address token)",
  "event Bought(address indexed token,uint256 cashIn,uint256 tokensOut)",
  "event Sold(address indexed token,uint256 tokensIn,uint256 cashOut)",
]);
export const TRENCHER_FACTORY_ABI = parseAbi([
  "function vaultFor(address owner) view returns (address)",
  "function deploy(address owner) returns (address)",
  "function cash() view returns (address)",
  "function bridge() view returns (address)",
  "function router() view returns (address)",
  "function poolFactory() view returns (address)",
]);
export interface TrencherPermission {
  trencherVaultAddress?: string;
  trencherFactoryAddress?: string;
}
export function trencherAddresses(opts: TrencherPermission): { vault: Address; factory: Address } | null {
  if (opts.trencherVaultAddress === undefined && opts.trencherFactoryAddress === undefined) return null;
  const valid = (s: string | undefined): s is Address => !!s && /^0x[0-9a-fA-F]{40}$/.test(s) && !/^0x0{40}$/i.test(s);
  if (!valid(opts.trencherVaultAddress) || !valid(opts.trencherFactoryAddress) || opts.trencherVaultAddress.toLowerCase() === opts.trencherFactoryAddress.toLowerCase()) {
    throw new Error("Trencher permission requires a distinct nonzero vault and factory");
  }
  return { vault: opts.trencherVaultAddress.toLowerCase() as Address, factory: opts.trencherFactoryAddress.toLowerCase() as Address };
}
export function grantTrencher(grant: (TrencherPermission & {grantFeatures?: readonly string[]}) | null | undefined) {
  if (!grant?.grantFeatures?.includes(GRANT_TRENCHER)) return null;
  try { return trencherAddresses(grant); } catch { return null; }
}

/**
 * Buy, sell and idempotent deployment. No recovery, no arbitrary approval.
 *
 * ── WHY THE CASH APPROVAL IS NOT HERE ANY MORE ───────────────────────────
 *
 * It used to be this list's first entry: USDG `approve`, EQUAL(vault), capped
 * at min(cap, 5 USDG). Correct in isolation, and uninstallable in practice.
 * Kernel's CallPolicy keys every permission by a hash over (target, selector)
 * and refuses the same key twice — and `buildCallPermissions` spreads this
 * list into an array that already carries its own USDG `approve` for the
 * routers. Two entries, one key, so the whole wall reverted at validation:
 *
 *   AA23 reverted duplicate permissionHash
 *
 * Measured on chain 4663 for agent 0x8e93ba: every entry attempt failed this
 * way, and re-signing did not help — the owner's new permission id 0x5d8c1f22
 * failed identically, because the duplicate is inside the wall being
 * installed rather than left over on chain. No Trencher grant was ever
 * enableable.
 *
 * So the vault is now named in the ROUTER approval's ONE_OF list instead, in
 * `buildCallPermissions`, which is the one place USDG `approve` may be
 * described. The authority is the same shape — the vault may be approved to
 * pull cash and nothing else here may — and `wall-duplicate-permission.test.ts`
 * pins both halves: no repeated key, and the vault still an approved spender.
 *
 * ONE DIFFERENCE, STATED: the merged entry carries the router cap
 * (`perTradeUsdg`) rather than this function's tighter min(cap, 5 USDG),
 * because a single entry can only carry one amount condition. TrencherVault
 * itself caps each buy at 5 USDG and 25 USDG per 24h window on chain, so the
 * amount that can actually move is unchanged; what moved is where the bound is
 * enforced. The owner chose this over capping the routers at 5 USDG, which
 * would have refused every ordinary trade above that.
 */
export function trencherPermissions(opts: TrencherPermission, self: Address, cap: bigint) {
  const addresses = trencherAddresses(opts);
  if (!addresses) return [];
  if (cap <= 0n) throw new Error("Trencher needs a positive entry cap");
  const limit = cap < 5_000_000n ? cap : 5_000_000n;
  return [
    { target: addresses.vault, valueLimit: 0n, abi: TRENCHER_VAULT_ABI, functionName: "buy", args: [
      null,null,null,{condition:ParamCondition.LESS_THAN_OR_EQUAL,value:limit},null,null,
    ] } as const,
    { target: addresses.vault, valueLimit: 0n, abi: TRENCHER_VAULT_ABI, functionName: "sell", args: [null,null,null,null,null,null] } as const,
    { target: addresses.factory, valueLimit: 0n, abi: TRENCHER_FACTORY_ABI, functionName: "deploy", args: [
      {condition:ParamCondition.EQUAL,value:self},
    ] } as const,
  ];
}
