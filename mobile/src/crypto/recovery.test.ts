import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { deriveRecoveryAccountAddress, ownerFromSigner, planRecovery, recoverFunds } from "@merrymen/recover";
import { planFromBrowser, sweepFromBrowser } from "../../../web/src/lib/recover-client";
import { planMobileRecovery, recoveryOrigin, sweepMobileRecovery } from "./recovery";
import type { BrowserPlan } from "../../../web/src/lib/recover-client";

vi.mock("@merrymen/recover", () => ({ deriveRecoveryAccountAddress: vi.fn(), ownerFromSigner: vi.fn(owner => ({ kind: "signer", account: owner })), planRecovery: vi.fn(), recoverFunds: vi.fn() }));
vi.mock("../../../web/src/lib/recover-client", () => ({ grantExtraTokens: (tokens: string[] = []) => tokens.map(address => ({ address, symbol: "" })), planFromBrowser: vi.fn(), sweepFromBrowser: vi.fn() }));

const owner = privateKeyToAccount(`0x${"11".repeat(32)}`); // Public, unfunded test vector.
const account = "0x2222222222222222222222222222222222222222" as const;
const recipient = "0x3333333333333333333333333333333333333333" as const;
const token = "0x4444444444444444444444444444444444444444" as const;
const vault = "0x5555555555555555555555555555555555555555" as const;
const base: BrowserPlan = { smartAccount: account, ownerAddress: owner.address, balances: [], gasWei: 0n, nativeRecoverableWei: 0n, nativeReserveWei: 0n, unreadable: [], classVault: null, classHoldings: [], classNote: null, classVaults: [], needsGas: false, gasSponsored: true, sponsorshipReason: null };
const options = { owner, apiOrigin: "https://app.merrymen.dev", rpcUrl: "https://rpc.mainnet.chain.robinhood.com", grantTokens: [token] };

beforeEach(() => { vi.clearAllMocks(); vi.mocked(deriveRecoveryAccountAddress).mockResolvedValue(account); vi.mocked(planRecovery).mockResolvedValue(base); vi.mocked(planFromBrowser).mockResolvedValue(base); });

describe("mobile recovery fee coverage", () => {
  it("uses the configured secure origin and refuses credential-bearing or non-origin URLs", () => {
    expect(recoveryOrigin("https://app.merrymen.dev")).toBe("https://app.merrymen.dev");
    for (const url of ["mock", "http://192.168.1.2:3000", "https://key@app.merrymen.dev", "https://app.merrymen.dev/api/bundler/4663", "https://app.merrymen.dev?apikey=private", "https://app.merrymen.dev#fragment", "https://app.merrymen.dev:8443"]) expect(recoveryOrigin(url)).toBeNull();
  });

  it("derives and pins the account before requesting house eligibility with only its local signer", async () => {
    const plan = await planMobileRecovery({ ...options, expectedSmartAccount: account });
    expect(plan.needsGas).toBe(false);
    expect(ownerFromSigner).toHaveBeenCalledWith(owner);
    expect(deriveRecoveryAccountAddress).toHaveBeenCalledWith(expect.objectContaining({ rpcUrl: options.rpcUrl }));
    expect(planRecovery).not.toHaveBeenCalled();
    expect(planFromBrowser).toHaveBeenCalledWith({ ownerAccount: owner, smartAccount: account, chainId: 4663, grantTokens: [token], apiOrigin: options.apiOrigin });
    expect(recoverFunds).not.toHaveBeenCalled();
  });

  it("does not contact the fee service if owner-account derivation disagrees", async () => {
    vi.mocked(deriveRecoveryAccountAddress).mockResolvedValue(recipient);
    await expect(planMobileRecovery({ ...options, expectedSmartAccount: account })).rejects.toThrow("different account");
    expect(planFromBrowser).not.toHaveBeenCalled();
  });

  it("sponsors gasless recovery through the house and keeps the reviewed Class vault pinned", async () => {
    const approvedClass = { vault, tokens: [token] };
    await sweepMobileRecovery({ ...options, plan: base, to: recipient, approvedClass, bundlerUrl: "https://caller-bundler.invalid" });
    expect(sweepFromBrowser).toHaveBeenCalledWith({ ownerAccount: owner, smartAccount: account, chainId: 4663, grantTokens: [token], apiOrigin: options.apiOrigin }, recipient, approvedClass);
    expect(recoverFunds).not.toHaveBeenCalled();
  });

  it("never falls back to owner-paid gas when hosted sponsorship is unavailable or fails", async () => {
    await expect(sweepMobileRecovery({ ...options, plan: { ...base, gasWei: 10n, gasSponsored: false }, to: recipient, bundlerUrl: "https://caller-bundler.invalid" })).rejects.toThrow("fee coverage is unavailable");
    expect(sweepFromBrowser).not.toHaveBeenCalled();
    vi.mocked(sweepFromBrowser).mockRejectedValue(new Error("Sponsor declined"));
    await expect(sweepMobileRecovery({ ...options, plan: base, to: recipient })).rejects.toThrow("Sponsor declined");
    expect(recoverFunds).not.toHaveBeenCalled();
  });

  it("keeps explicit standalone recovery self-paying and pins its expected account", async () => {
    const standalone = await planMobileRecovery({ ...options, apiOrigin: null });
    expect(standalone.gasSponsored).toBe(false); expect(standalone.needsGas).toBe(true);
    expect(planFromBrowser).not.toHaveBeenCalled();
    await sweepMobileRecovery({ ...options, apiOrigin: null, plan: standalone, to: recipient, bundlerUrl: "https://own-bundler.invalid", approvedClass: { vault, tokens: [token] } });
    expect(recoverFunds).toHaveBeenCalledWith(expect.objectContaining({ expectedSmartAccount: account, bundlerUrl: "https://own-bundler.invalid", approvedClass: { vault, tokens: [token], destination: recipient }, requireApprovedClassSweep: true }));
    expect(vi.mocked(recoverFunds).mock.calls[0][0].sponsor).toBeUndefined();
    expect(sweepFromBrowser).not.toHaveBeenCalled();
  });

  it("rejects zero/self recipients before either recovery path can sign", async () => {
    for (const to of [account, "0x0000000000000000000000000000000000000000"] as const) await expect(sweepMobileRecovery({ ...options, plan: base, to })).rejects.toThrow("valid recipient");
    expect(sweepFromBrowser).not.toHaveBeenCalled(); expect(recoverFunds).not.toHaveBeenCalled();
  });
});
