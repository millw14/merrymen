import { pimlicoPaymasterUrl } from "../../packages/core/src/index";
import { createSponsor, SponsorRefused, type Sponsor } from "./paymaster";

type TradingSponsorConfig = {
  sponsorGasEnabled: boolean;
  bundlerApiKey?: string;
  sponsorshipPolicyId?: string;
};

type TradingArmConfig = TradingSponsorConfig & { liveTradingEnabled: boolean; enforceLiveIntent?: boolean };

export const liveTradingMayRun = (cfg: TradingArmConfig): boolean => cfg.liveTradingEnabled || cfg.enforceLiveIntent === false;

/** Revisit a paper-only arm when live consent arrives, including after configuration recovers. */
export function tradingSponsorNeedsRearm(cfg: TradingArmConfig, armed: { sponsorBlockedPaperOnly?: boolean } | null): boolean {
  return liveTradingMayRun(cfg) && (!!armed?.sponsorBlockedPaperOnly ||
    (cfg.sponsorGasEnabled && (!cfg.bundlerApiKey?.trim() || !cfg.sponsorshipPolicyId?.trim())));
}

/** Missing fee service may not stop explicit paper practice or create a live signer. */
export function tradingSponsorArm(cfg: TradingArmConfig, chainId: number): {
  sponsor: Sponsor | undefined;
  paperOnly: boolean;
  reason?: string;
} {
  try { return { sponsor: createTradingSponsor(cfg, chainId), paperOnly: false }; }
  catch (e) {
    if (!(e instanceof SponsorRefused) || liveTradingMayRun(cfg)) throw e;
    return { sponsor: undefined, paperOnly: true, reason: e.message };
  }
}

/** An enabled sponsor is mandatory; only the explicit OFF choice permits self-pay. */
export function createTradingSponsor(cfg: TradingSponsorConfig, chainId: number): Sponsor | undefined {
  if (!cfg.sponsorGasEnabled) return undefined;
  const key = cfg.bundlerApiKey?.trim();
  const policy = cfg.sponsorshipPolicyId?.trim();
  if (!key || !policy) {
    const missing = !key ? "a house bundler key" : "a spending policy";
    throw new SponsorRefused(
      "sponsor-refused",
      `Gas sponsorship is enabled but ${missing} is missing. Live trading is blocked until gas coverage is configured; the owner's ETH will not pay instead.`,
    );
  }
  return createSponsor({ url: pimlicoPaymasterUrl(chainId, key), policyId: policy });
}
