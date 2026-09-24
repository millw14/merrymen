// Headless computation only. SwiftUI owns all screens and confirmations; the
// native host owns networking, wallet signatures, randomness and Keychain storage.
// Reuse the exact web permission builder instead of porting the financial wall.
import { toAccount } from "viem/accounts";
import { createPrivyOwnedWallet, setPrivyTokenSource, type MintOptions } from "../../web/src/lib/session";
import { verifiedAdapter } from "../../web/src/lib/verified-adapter";
import { isValidCustomToken } from "../../packages/core/src/tokens";
import type { Address, Hex } from "viem";

declare const nativeCall: (operation: string, args: unknown) => Promise<any>;

function signer(address: Address) {
  return toAccount({
    address,
    async signMessage({ message }) {
      return nativeCall("signMessage", { address, message }) as Promise<Hex>;
    },
    async signTypedData(typedData) {
      return nativeCall("signTypedData", { address, typedData }) as Promise<Hex>;
    },
    async signTransaction() { throw new Error("Raw transaction signing is not exposed by the grant builder."); },
  });
}

export function capabilities() { return { version: 1, engine: "shared-permission-builder", nativeScreens: true }; }

export async function create(input: {
  owner: Address; tenant: Address; did: string;
  caps: MintOptions["caps"]; expectAccount?: Address;
  extraTokens: unknown[]; v4AdapterAddress?: Address; ponsAdapterAddress?: Address;
  ponsClassVaultFactory?: Address;
}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.owner) || input.owner.toLowerCase() !== input.tenant.toLowerCase()) {
    throw new Error("The embedded wallet does not own this account.");
  }
  if (!input.did.startsWith("did:privy:")) throw new Error("Missing verified Privy identity.");
  for (const value of Object.values(input.caps)) if (!Number.isFinite(value) || value <= 0) throw new Error("Every cap must be positive.");
  if (input.caps.perTradeUsdg > input.caps.dailyUsdg) throw new Error("The per-trade cap exceeds the daily cap.");
  if (!input.extraTokens.every(isValidCustomToken)) throw new Error("A custom token is invalid.");
  const onStatus = (message: string) => { void nativeCall("status", { message }); };
  const pons = await verifiedAdapter(input.ponsAdapterAddress, 4663, onStatus);
  setPrivyTokenSource(() => nativeCall("accessToken", {}));
  return createPrivyOwnedWallet(signer(input.owner), input.did, {
    caps: input.caps, onStatus, chainId: 4663, hostedAs: input.tenant,
    expectAccount: input.expectAccount, extraTokens: input.extraTokens.filter(isValidCustomToken),
    v4AdapterAddress: input.v4AdapterAddress, ponsAdapterAddress: pons,
    ponsClassVaultFactory: input.ponsClassVaultFactory,
  });
}
