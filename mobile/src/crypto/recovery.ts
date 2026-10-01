import { isAddress, type Address, type LocalAccount } from "viem";
import { robinhoodChain } from "@merrymen/core";
import { deriveRecoveryAccountAddress, ownerFromSigner, planRecovery, recoverFunds } from "@merrymen/recover";
import { grantExtraTokens, planFromBrowser, sweepFromBrowser, type BrowserPlan, type BrowserWallet } from "../../../web/src/lib/recover-client";

/** A build-configured service origin, never a URL supplied by a recovery backup. */
export function recoveryOrigin(configured: string): string | null {
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.port && url.port !== "443")) return null;
    return url.origin;
  } catch { return null; }
}

type MobileRecovery = {
  owner: LocalAccount;
  apiOrigin: string | null;
  rpcUrl: string;
  grantTokens?: readonly string[];
};

function wallet(options: MobileRecovery, smartAccount: Address): BrowserWallet {
  return { ownerAccount: options.owner, smartAccount, chainId: robinhoodChain.id, grantTokens: options.grantTokens, ...(options.apiOrigin ? { apiOrigin: options.apiOrigin } : {}) };
}

/** Derive locally first; ownership proof sends a signature, never the owner key. */
export async function planMobileRecovery(options: MobileRecovery & { expectedSmartAccount?: Address }): Promise<BrowserPlan> {
  if (options.apiOrigin) {
    const smartAccount = await deriveRecoveryAccountAddress({ chain: robinhoodChain, owner: ownerFromSigner(options.owner), rpcUrl: options.rpcUrl });
    if (options.expectedSmartAccount && smartAccount.toLowerCase() !== options.expectedSmartAccount.toLowerCase()) throw new Error("This owner controls a different account. No recovery was signed.");
    return planFromBrowser(wallet(options, smartAccount));
  }
  const derived = await planRecovery({
    chain: robinhoodChain, owner: ownerFromSigner(options.owner), rpcUrl: options.rpcUrl,
    expectedSmartAccount: options.expectedSmartAccount, extraTokens: grantExtraTokens(options.grantTokens),
  });
  return { ...derived, gasSponsored: false, sponsorshipReason: "This standalone build has no Merrymen fee service. Recovery uses your own bundler and ETH.", needsGas: derived.gasWei === 0n };
}

/** Hosted recovery always requests house sponsorship; standalone is explicitly self-paying. */
export async function sweepMobileRecovery(options: MobileRecovery & {
  plan: BrowserPlan;
  to: Address;
  bundlerUrl?: string;
  approvedClass?: { vault: Address; tokens: readonly Address[] };
}) {
  if (!isAddress(options.to) || /^0x0{40}$/i.test(options.to) || options.to.toLowerCase() === options.plan.smartAccount.toLowerCase()) throw new Error("Choose a valid recipient other than this smart account.");
  if (options.apiOrigin) {
    if (!options.plan.gasSponsored) throw new Error("Merrymen fee coverage is unavailable. Refresh the plan before withdrawing.");
    return sweepFromBrowser(wallet(options, options.plan.smartAccount), options.to, options.approvedClass);
  }
  const bundlerUrl = options.bundlerUrl?.trim();
  if (!bundlerUrl || !/^https?:\/\//.test(bundlerUrl)) throw new Error("Standalone recovery needs your own bundler URL.");
  return recoverFunds({
    chain: robinhoodChain, owner: ownerFromSigner(options.owner), rpcUrl: options.rpcUrl,
    bundlerUrl, to: options.to, expectedSmartAccount: options.plan.smartAccount,
    extraTokens: grantExtraTokens(options.grantTokens),
    ...(options.approvedClass ? { approvedClass: { ...options.approvedClass, destination: options.to }, requireApprovedClassSweep: true } : {}),
  });
}
