/** Test support: use the installed account encoder, including its self-call shortcut. */
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createPublicClient, custom, encodeFunctionData, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertDerivedAccount, robinhoodChain } from "@merrymen/core";
import { KERNEL_REVOCATION_ABI } from "./permission-revocation";

export async function sdkRevocationCall(accountAddress: Address, nonce = 2) {
  const client = createPublicClient({ chain: robinhoodChain, transport: custom({
    async request({ method }) {
      if (method === "eth_chainId") return "0x1237";
      throw new Error(`Unexpected RPC during local encoding: ${method}`);
    },
  }) });
  const owner = privateKeyToAccount(`0x${"17".repeat(32)}`);
  const cannotSign = async (): Promise<never> => { throw new Error("Encoding must not sign"); };
  const entryPoint = getEntryPoint("0.7");
  const sudo = await signerToEcdsaValidator(client, {
    signer: { ...owner, signMessage: cannotSign, signTypedData: cannotSign, signTransaction: cannotSign },
    entryPoint, kernelVersion: KERNEL_V3_3,
  });
  const account = await createKernelAccount(client, {
    address: accountAddress, entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo },
  });
  assertDerivedAccount(account.address, "revocation encoding fixture");
  return account.encodeCalls([{
    to: accountAddress, value: 0n,
    data: encodeFunctionData({ abi: KERNEL_REVOCATION_ABI, functionName: "invalidateNonce", args: [nonce] }),
  }]);
}
