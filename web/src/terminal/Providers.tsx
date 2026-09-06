"use client";

/**
 * THE ONE MOUNT POINT.
 *
 * `(app)/layout.tsx` renders the terminal and nothing else — every route body
 * under `(app)/` is `return null` — so wrapping it here puts every screen
 * inside the provider with one edit. The layout stays a SERVER component: a
 * server component may import a client module and pass a client element as
 * children, so no `"use client"` spreads upward.
 *
 * Deliberately not inside `App.tsx`: App's own body owns the account state and
 * the `/api/auth/session` poll, and it is that body which needs `usePrivy()`.
 * Deliberately not in `app/layout.tsx`: that would load Privy onto `/gate`,
 * whose whole design point is that it fetches nothing.
 *
 * WHAT IS DELIBERATELY ABSENT, and provable by grep:
 *   - `@privy-io/react-auth/smart-wallets`, `SmartWalletsProvider`,
 *     `useSmartWallets` — merrymen already has Kernel v3.3, ERC-4337 and the
 *     permission wall. A second smart-account implementation beside them is the
 *     thing this integration was scoped to avoid.
 *   - `useSigners`, `addSigners`, `useSessionSigners`, `delegateWallet` — server
 *     side signing would put a key merrymen does not hold in a place merrymen
 *     cannot audit.
 * `privy-boundary.test.ts` asserts both, plus that `permissionless` is not even
 * installed.
 */

import { PrivyProvider } from "@privy-io/react-auth";
import { robinhoodChain } from "@merrymen/core";
import type { ReactNode } from "react";
import { PRIVY_APP_ID, privyEnabled } from "@/lib/privy-client";

export function Providers({ children }: { children: ReactNode }) {
  // A deployment with no Privy — or a malformed app id — renders the terminal
  // with no provider at all rather than crashing the prerender. The legacy
  // wallet login still works, which is what makes this flag-able.
  if (!privyEnabled()) return <>{children}</>;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        // X FIRST. The array order is the modal order in react-auth v3, and
        // `loginMethodsAndOrder` is deprecated as of 3.40. This only FILTERS
        // what the dashboard already enables — it cannot turn a method on.
        // X FIRST, THEN EMAIL, AND NO WALLET.
        //
        // "Continue with a wallet" is removed deliberately: an external wallet
        // can authenticate somebody, but it cannot be the Kernel OWNER — that
        // has to be the embedded wallet, whose key merrymen never sees. Offering
        // it as a third door produced exactly one outcome in testing, which was
        // a session whose wallet was not its owner and a mismatch error nobody
        // could act on.
        loginMethods: ["twitter", "email"],
        // THE v3 SHAPE, NESTED PER CHAIN FAMILY. The flat
        // `embeddedWallets.createOnLogin` is the v2 spelling and is silently
        // ignored here: an unknown extra property, no wallet, no error.
        //
        // `all-users` rather than `users-without-wallets` because X and email
        // logins arrive with no wallet at all, and the wallet fallback arrives
        // with one we must not use as the owner. One consistent owner signer
        // however somebody authenticated.
        embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
        // Chain 4663 is not one of Privy's built-ins, so it is supplied
        // explicitly — from @merrymen/core, never redefined here. A second
        // definition is how a testnet id ends up in a mainnet signature.
        defaultChain: robinhoodChain,
        supportedChains: [robinhoodChain],
        appearance: {
          theme: "dark",
          accentColor: "#c8ff00",
          walletChainType: "ethereum-only",
          // AN ABSOLUTE URL TO A FILE THAT EXISTS, AND ONE THE GATE LETS
          // THROUGH. The modal renders in an auth.privy.io iframe, so a
          // relative path resolves against THEIR origin, and the gate cookie is
          // SameSite so a cross-site image request arrives unauthenticated. The
          // old value was /icon.png — which is not a file in web/public at all —
          // fetched through a middleware that answered with the password page.
          // Three separate reasons for one broken image.
          logo: "https://app.merrymen.dev/icon-192.png",
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
