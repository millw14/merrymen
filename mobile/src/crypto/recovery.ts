import { isAddress, type Address, type LocalAccount } from "viem";
import { robinhoodChain } from "@merrymen/core";
import { deriveRecoveryAccountAddress, ownerFromSigner, planRecovery, recoverFunds } from "@merrymen/recover";
import { grantExtraTokens, planFromBrowser, sweepFromBrowser, type BrowserPlan, type BrowserWallet } from "../../../web/src/lib/recover-client";

const HOUSE_RECOVERY_ORIGIN = "https://app.merrymen.dev";

/** Custom feed servers do not establish trust or support for house recovery. */
export function recoveryOrigin(configured: string): string | null {
  try {
    const url = new URL(configured);
    if (url.origin !== HOUSE_RECOVERY_ORIGIN || url.username || url.password || url.search || url.hash || /[?#]/.test(configured) || url.pathname !== "/") return null;
    return HOUSE_RECOVERY_ORIGIN;
  } catch { return null; }
}

type MobileRecovery = {
  owner: LocalAccount;
  apiOrigin: string | null;
  rpcUrl: string;
  grantTokens?: readonly string[];
};

function wallet(options: MobileRecovery, smartAccount: Address): BrowserWallet {
  return { ownerAccount: options.owner, smartAccount, chainId: robinhoodChain.id, grantTokens: options.grantTokens, apiOrigin: HOUSE_RECOVERY_ORIGIN };
}

/** Derive locally first; ownership proof sends a signature, never the owner key. */
export async function planMobileRecovery(options: MobileRecovery & { expectedSmartAccount?: Address }): Promise<BrowserPlan> {
  if (recoveryOrigin(options.apiOrigin ?? "")) {
    const smartAccount = await deriveRecoveryAccountAddress({ chain: robinhoodChain, owner: ownerFromSigner(options.owner), rpcUrl: options.rpcUrl });
    if (options.expectedSmartAccount && smartAccount.toLowerCase() !== options.expectedSmartAccount.toLowerCase()) throw new Error("This owner controls a different account. No recovery was signed.");
    return planFromBrowser(wallet(options, smartAccount));
  }
  const derived = await planRecovery({
    chain: robinhoodChain, owner: ownerFromSigner(options.owner), rpcUrl: options.rpcUrl,
    expectedSmartAccount: options.expectedSmartAccount, extraTokens: grantExtraTokens(options.grantTokens),
  });
  return { ...derived, gasSponsored: false, sponsorshipReason: "Standalone recovery uses your own bundler and this account's ETH. A custom feed does not provide Merrymen fee coverage.", needsGas: derived.gasWei === 0n };
}

/** Hosted recovery always requests house sponsorship; standalone is explicitly self-paying. */
export async function sweepMobileRecovery(options: MobileRecovery & {
  plan: BrowserPlan;
  to: Address;
  bundlerUrl?: string;
  approvedClass?: { vault: Address; tokens: readonly Address[] };
}) {
  if (!isAddress(options.to) || /^0x0{40}$/i.test(options.to) || options.to.toLowerCase() === options.plan.smartAccount.toLowerCase()) throw new Error("Choose a valid recipient other than this smart account.");
  if (recoveryOrigin(options.apiOrigin ?? "")) {
    if (!options.plan.gasSponsored) throw new Error("Merrymen fee coverage is unavailable. Refresh the plan before withdrawing.");
    return sweepFromBrowser(wallet(options, options.plan.smartAccount), options.to, options.approvedClass);
  }
  if (options.plan.gasSponsored) throw new Error("This plan was prepared for Merrymen fee coverage. Refresh a standalone plan before choosing owner-paid recovery.");
  const bundlerUrl = options.bundlerUrl?.trim();
  if (!bundlerUrl || !/^https?:\/\//.test(bundlerUrl)) throw new Error("Standalone recovery needs your own bundler URL.");
  return recoverFunds({
    chain: robinhoodChain, owner: ownerFromSigner(options.owner), rpcUrl: options.rpcUrl,
    bundlerUrl, to: options.to, expectedSmartAccount: options.plan.smartAccount,
    extraTokens: grantExtraTokens(options.grantTokens),
    ...(options.approvedClass ? { approvedClass: { ...options.approvedClass, destination: options.to }, requireApprovedClassSweep: true } : {}),
  });
}
