"use client";

/**
 * THE PRIVY EMBEDDED WALLET, AS A KERNEL OWNER — or null.
 *
 * Null means "not a Privy session", and every caller treats that as "use the
 * browser-generated owner key exactly as before". That is what keeps an
 * existing Merryman on its existing owner: a legacy user who links a DID still
 * gets null here, because their tenant is not this wallet.
 *
 * A LOCAL ACCOUNT, NOT AN EIP-1193 PROVIDER. `toViemAccount` returns a viem
 * LocalAccount with a fixed address. Handing ZeroDev the raw provider instead
 * would route through `toSigner`, which resolves the address with
 * `Promise.any([eth_requestAccounts, eth_accounts])` and takes `[0]` —
 * whichever RPC answers first. The owner address decides the ACCOUNT address,
 * so that race would decide which Merryman somebody gets.
 *
 * `getEmbeddedConnectedWallet` and never `wallets[0]`: with the wallet login
 * enabled, `useWallets()` returns a mixed list and index zero can be the user's
 * MetaMask. Deriving a Kernel account from THAT would hand them a different
 * agent with a straight face.
 */

import { useEffect, useState } from "react";
import {
  getEmbeddedConnectedWallet,
  toViemAccount,
  usePrivy,
  useWallets,
} from "@privy-io/react-auth";
import type { LocalAccount } from "viem";
import { setPrivyTokenSource } from "@/lib/session";
import { privyEnabled } from "@/lib/privy-client";

export interface PrivyOwner {
  account: LocalAccount;
  /** The DID this owner signs under. Goes into the binding's signed text. */
  did: string;
}

export function usePrivyOwner(): PrivyOwner | null {
  const enabled = privyEnabled();
  const { authenticated, user, getAccessToken } = usePrivy();
  const { wallets, ready } = useWallets();
  const [owner, setOwner] = useState<PrivyOwner | null>(null);

  // The grant handoff needs a FRESH access token at the moment it posts, not
  // one captured earlier — so publish the getter rather than a value.
  useEffect(() => {
    if (!enabled) return;
    setPrivyTokenSource(authenticated ? getAccessToken : null);
    return () => setPrivyTokenSource(null);
  }, [authenticated, enabled, getAccessToken]);

  useEffect(() => {
    if (!enabled || !authenticated || !ready) {
      setOwner(null);
      return;
    }
    const wallet = getEmbeddedConnectedWallet(wallets);
    const did = user?.id ?? "";
    if (!wallet || !did) {
      setOwner(null);
      return;
    }
    let live = true;
    void toViemAccount({ wallet })
      .then((account) => {
        if (live) setOwner({ account: account as unknown as LocalAccount, did });
      })
      .catch(() => {
        // No owner rather than a wrong one. The caller falls back to the
        // browser-key path, which refuses loudly rather than deriving an
        // account from a signer it could not build.
        if (live) setOwner(null);
      });
    return () => {
      live = false;
    };
  }, [authenticated, enabled, ready, user?.id, wallets]);

  return owner;
}
