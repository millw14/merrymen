"use client";

import { createPublicClient, encodeFunctionData, erc20Abi, http, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createBundlerClient, getUserOperationHash, type UserOperation } from "viem/account-abstraction";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { accountIndexForPurpose, CASH, grantPurpose, robinhoodChain, type PublicGrantView } from "@merrymen/core";
import { loadGrant } from "./session";
import { getRecoveryTicket, relayUrl } from "./recover-client";
import { userOpGasConfig } from "../../../worker/src/gas";
import { runFundingIntent, FundingPreparationError, type FundingResult } from "./perps-funding-intent";

export type PerpsFundingRequest = {
  amountMicro: string; expectedAccount: string; expectedOwner: string | null;
  expectedSource: string; chainId: number; privyOwnerAccount?: LocalAccount | null;
};
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
async function json(url: string) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new FundingPreparationError("Could not verify your wallet. Nothing was signed.");
  return response.json();
}

/** Only the owner signs this exact transfer. Session/venue credentials never fund wallets. */
export async function transferPerpsFunding(args: PerpsFundingRequest): Promise<FundingResult> {
  if (args.chainId !== robinhoodChain.id || !/^\d+$/.test(args.amountMicro) ||
      BigInt(args.amountMicro) <= 0n || BigInt(args.amountMicro) >= 1n << 256n) throw new FundingPreparationError("Invalid USDG funding amount or network");
  if (!navigator.locks) throw new FundingPreparationError("This browser cannot safely coordinate funding. Send USDG to the deposit address from your wallet.");
  const key = `merrymen.perps-funding.v1:${args.chainId}:${args.expectedSource.toLowerCase()}`;
  return navigator.locks.request(key, { ifAvailable: true }, async lock => {
    if (!lock) throw new FundingPreparationError("Another funding request is in progress");
    const verify = async () => {
      const before = await json("/api/auth/session") as { hosted: boolean; address: string | null };
      if (before.hosted ? !same(before.address, args.expectedOwner) : args.expectedOwner !== null) throw new FundingPreparationError("Your login changed. Reopen funding.");
      const query = args.expectedOwner ? `owner=${encodeURIComponent(args.expectedOwner)}` : "";
      const [spot, perps] = await Promise.all([
        json(`/api/grants?${query}`), json(`/api/grants?purpose=perps&${query}`),
      ]) as { exists: boolean; grant?: PublicGrantView }[];
      const after = await json("/api/auth/session") as typeof before;
      if (before.hosted !== after.hosted || before.address?.toLowerCase() !== after.address?.toLowerCase()) throw new FundingPreparationError("Your login changed. Reopen funding.");
      const source = spot.grant, target = perps.grant;
      if (!spot.exists || !perps.exists || !source || !target || grantPurpose(source) !== "spot" || grantPurpose(target) !== "perps" ||
          !same(source.smartAccount, args.expectedSource) || !same(target.smartAccount, args.expectedAccount) ||
          same(source.smartAccount, target.smartAccount) || !same(source.owner, target.owner) ||
          source.chainId !== args.chainId || target.chainId !== args.chainId) throw new FundingPreparationError("The wallet pair changed. Reopen funding.");
      return { source, target };
    };
    const { source, target } = await verify();
    const local = loadGrant("spot");
    const owner = args.privyOwnerAccount && same(args.privyOwnerAccount.address, source.owner) ? args.privyOwnerAccount :
      local?.demoOwnerPrivateKey && same(local.smartAccount, source.smartAccount) ? privateKeyToAccount(local.demoOwnerPrivateKey) : null;
    if (!owner || !same(owner.address, source.owner)) throw new FundingPreparationError("The Spot wallet owner signer is unavailable. Restore it before funding.");
    const publicClient = createPublicClient({ chain: robinhoodChain, transport: http() });
    const entryPoint = getEntryPoint("0.7");
    const sudo = await signerToEcdsaValidator(publicClient, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
    const derive = (purpose: "spot" | "perps") => createKernelAccount(publicClient, {
      index: accountIndexForPurpose(purpose), entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo },
    });
    const [account, destination] = await Promise.all([derive("spot"), derive("perps")]);
    if (!same(account.address, source.smartAccount) || !same(destination.address, target.smartAccount)) throw new FundingPreparationError("Owner derivation does not match the wallet pair");
    // Reuse the existing transfer-only, owner-authenticated, unsponsored relay.
    await getRecoveryTicket({ smartAccount: account.address, ownerAccount: owner, chainId: args.chainId });
    const bundlerUrl = relayUrl(args.chainId);
    const transport = http(bundlerUrl, { retryCount: 0 });
    const client = createKernelAccountClient({ account, chain: robinhoodChain, bundlerTransport: transport,
      userOperation: userOpGasConfig(publicClient, bundlerUrl) });
    const bundler = createBundlerClient({ chain: robinhoodChain, transport });
    return runFundingIntent({ storage: localStorage, key, source: account.address.toLowerCase(),
      target: destination.address.toLowerCase(), amountMicro: BigInt(args.amountMicro).toString(),
      prepare: async () => {
        const balance = await publicClient.readContract({ address: CASH.USDG, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
        if (balance < BigInt(args.amountMicro)) throw new FundingPreparationError("The Spot wallet has insufficient available USDG");
        if (await publicClient.getBalance({ address: account.address }) === 0n) throw new FundingPreparationError("The Spot wallet needs ETH for this owner transfer; funding gas is not sponsored");
        const callData = await account.encodeCalls([{ to: CASH.USDG, value: 0n,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [destination.address, BigInt(args.amountMicro)] }) }]);
        const prepared = await client.prepareUserOperation({ callData });
        await verify();
        const signature = await account.signUserOperation(prepared);
        const operation = { ...prepared, signature } as UserOperation<"0.7">;
        const hash = getUserOperationHash({ chainId: args.chainId, entryPointAddress: entryPoint.address,
          entryPointVersion: "0.7", userOperation: operation });
        await verify();
        return { hash, send: () => bundler.sendUserOperation({ ...operation, entryPointAddress: entryPoint.address }) };
      },
      receipt: async hash => {
        try {
          const receipt = await bundler.waitForUserOperationReceipt({ hash, timeout: 25_000, pollingInterval: 1500 });
          return receipt.success ? "confirmed" : "reverted";
        } catch { return "pending"; }
      },
    });
  });
}
