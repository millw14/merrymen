import { createPublicClient, type Address } from "viem";
import { rpcTransportFor } from "./rpc";
import { toAccount } from "viem/accounts";
import { createKernelAccount } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { chainForId } from "@merrymen/core";

/**
 * Recompute the ERC-4337 smart-account address a given OWNER controls, from the
 * owner ADDRESS alone — the identical derivation the browser does in
 * lib/session.ts (createKernelAccount with the sudo ECDSA validator, KERNEL_V3_3,
 * entryPoint 0.7, default index).
 *
 * The Kernel address derives from the SUDO validator alone — the session-key
 * permission plugin is enabled at UserOp time and doesn't move it (session.ts
 * asserts exactly this). So the owner address is all that's needed: no private
 * key, no signing. The view-only signer below exists only to carry that address
 * into the validator's enable-data; its signing methods are never reached during
 * counterfactual address computation.
 *
 * B1 — first-arm identity proof: at hosted grant intake this lets the server
 * PROVE grant.smartAccount actually derives from the signed-in wallet, rather
 * than trusting the address the client put in the JSON. That's what closes
 * agent-id / ledger-partition squatting: every ledger table keys on
 * smart_account, so an unverified address lets one tenant write under another's
 * partition.
 */
export async function deriveKernelAccountAddress(owner: Address, chainId: number): Promise<Address> {
  const chain = chainForId(chainId);
  // Resolved from configuration rather than from the chain's built-in default,
  // so a house RPC change reaches this path too — and counted, so web's share of
  // the provider's load is visible. See web/src/lib/rpc.ts.
  const publicClient = createPublicClient({ chain, transport: rpcTransportFor(chainId, "derive") });

  const viewSigner = toAccount({
    address: owner,
    async signMessage() {
      throw new Error("view-only signer cannot sign");
    },
    async signTransaction() {
      throw new Error("view-only signer cannot sign");
    },
    async signTypedData() {
      throw new Error("view-only signer cannot sign");
    },
  });

  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: viewSigner,
    entryPoint: getEntryPoint("0.7"),
    kernelVersion: KERNEL_V3_3,
  });

  const account = await createKernelAccount(publicClient, {
    entryPoint: getEntryPoint("0.7"),
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator },
  });

  return account.address;
}
