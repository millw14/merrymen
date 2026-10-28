"use client";
import { useRef } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets, useCreateWallet, useExportWallet, useSignMessage, useSignTransaction } from "@privy-io/react-auth/solana";
import { base58Encode } from "../../../packages/core/src/ids";

const creations = new Map<string, Promise<unknown>>();
/** A separate signer hook: Solana owner IDs are never lowercased or sent to viem. */
export function useSolanaOwner() {
  const { authenticated, ready: loginReady, user, getAccessToken } = usePrivy();
  const { wallets, ready } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const { exportWallet } = useExportWallet();
  const linked = authenticated ? user?.linkedAccounts.filter((account) => account.type === "wallet"
    && account.chainType === "solana" && (account.walletClientType === "privy" || account.walletClientType === "privy-v2")) ?? [] : [];
  const matches = wallets.filter((wallet) => linked.some((account) => account.type === "wallet" && account.address === wallet.address));
  // Multiple embedded owners need an explicit selection flow. Never guess the
  // first wallet from a mixed external/embedded list or a stale previous login.
  const wallet = ready && matches.length === 1 ? matches[0]! : null;
  const did = authenticated ? user?.id ?? null : null;
  const current = useRef({ did, owner: wallet?.address });
  current.current = { did, owner: wallet?.address };
  const requireCurrent = () => {
    if (!wallet || !did || current.current.did !== did || current.current.owner !== wallet.address) throw new Error("Your signing account changed. Refresh before continuing.");
  };
  return {
    ready: loginReady && ready, authenticated, did, address: wallet?.address ?? null,
    ambiguous: matches.length > 1, getAccessToken,
    async create() {
      if (!did || !authenticated) throw new Error("Sign in before creating a Solana wallet.");
      let pending = creations.get(did);
      if (!pending) {
        pending = createWallet().catch((error) => { creations.delete(did); throw error; });
        creations.set(did, pending);
      }
      await pending;
    },
    async signBinding(message: string) {
      requireCurrent();
      const result = await signMessage({ wallet: wallet!, message: new TextEncoder().encode(message) });
      requireCurrent();
      return base58Encode(result.signature);
    },
    async signSetup(bytes: Uint8Array) {
      requireCurrent();
      const result = await signTransaction({ wallet: wallet!, transaction: bytes, chain: "solana:mainnet" });
      requireCurrent();
      return result.signedTransaction;
    },
    /**
     * Opens Privy's own export window for exactly this owner wallet, so the
     * owner can recover the vault without Merrymen. The key is shown in an
     * iframe on Privy's domain; this page never receives it.
     */
    async exportKey() {
      requireCurrent();
      await exportWallet({ address: wallet!.address });
    },
  };
}
