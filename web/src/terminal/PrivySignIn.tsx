"use client";

/**
 * CONTINUE WITH X — the first thing a tester sees.
 *
 * One happy path, three buttons deep at most. X is primary because that is
 * where the audience is; email and wallet exist so somebody without an X
 * account is not stopped at the door. The Privy modal renders all three in the
 * order `Providers.tsx` lists them, so this component owns one button and the
 * modal owns the choice.
 *
 * WHAT HAPPENS AFTER THE MODAL CLOSES is the part worth reading. Privy hands
 * back an authenticated user and an embedded wallet; neither is an identity to
 * this server until it has both a verified token and a signature. So:
 *
 *   1. ask the server for a nonce (the same single-use, origin-bound,
 *      HMAC-signed nonce the wallet login has always used)
 *   2. have the EMBEDDED wallet sign that exact challenge
 *   3. POST the signature with the access token in the Authorization header
 *
 * The server verifies the token, recovers the address from the signature, and
 * mints a session for the tenant the DID owns. The browser never says who it
 * is; it only proves two things and lets the server decide.
 *
 * `getEmbeddedConnectedWallet` and not `wallets[0]`: with the wallet login
 * enabled, `useWallets()` returns a MIXED list, so index zero can be somebody's
 * MetaMask. Signing the challenge with that would make THEIR address the tenant.
 */

import { useCallback, useEffect, useState } from "react";
import {
  getEmbeddedConnectedWallet,
  usePrivy,
  useWallets,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import { requestJson } from "./HostedControls";

type Phase = "idle" | "authorising" | "provisioning" | "proving" | "done";

const LABEL: Record<Phase, string> = {
  idle: "Continue with X",
  authorising: "Waiting for X…",
  provisioning: "Creating your wallet…",
  proving: "Signing you in…",
  done: "Signed in",
};

/**
 * Privy provisions the embedded wallet asynchronously after login, so it is
 * normal for `useWallets()` to be briefly empty. Waiting is the honest
 * behaviour; falling back to another wallet would silently pick the wrong owner.
 */
function useEmbeddedWallet(): ConnectedWallet | null {
  const { wallets, ready } = useWallets();
  if (!ready) return null;
  return getEmbeddedConnectedWallet(wallets);
}

export function PrivySignIn({ onDone }: { onDone: () => void }) {
  const { ready, authenticated, login, getAccessToken, user, logout } = usePrivy();
  const embedded = useEmbeddedWallet();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");

  const finish = useCallback(
    async (wallet: ConnectedWallet) => {
      setPhase("proving");
      const token = await getAccessToken();
      if (!token) throw new Error("Your sign-in expired. Try again.");

      const challenge = await requestJson<{ nonce: string; message: string }>("/api/auth/privy");
      // personal_sign over the SAME text the wallet login uses. EIP-191 carries
      // no chain id, so this never needs a network switch.
      const provider = await wallet.getEthereumProvider();
      const signature = (await provider.request({
        method: "personal_sign",
        params: [challenge.message, wallet.address],
      })) as string;

      const linked = user?.twitter ?? null;
      await requestJson("/api/auth/privy", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          nonce: challenge.nonce,
          signature,
          // DISPLAY METADATA ONLY. The server reads the DID from the token it
          // verified; everything here is for the profile and is never an
          // authorization key — a handle is reassignable.
          provider: linked ? "twitter" : user?.email ? "email" : "wallet",
          subject: linked?.subject ?? undefined,
          handle: linked?.username ?? undefined,
          displayName: linked?.name ?? undefined,
          avatarUrl: linked?.profilePictureUrl ?? undefined,
        }),
      });
      setPhase("done");
      onDone();
    },
    [getAccessToken, onDone, user],
  );

  // Authenticated but not yet signed in here: wait for the wallet, then prove.
  useEffect(() => {
    if (!authenticated || phase === "done" || phase === "proving") return;
    if (!embedded) {
      if (phase === "authorising" || phase === "idle") setPhase("provisioning");
      return;
    }
    void finish(embedded).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : "Sign-in failed. Try again.");
      setPhase("idle");
    });
  }, [authenticated, embedded, finish, phase]);

  if (!ready) return <div className="hosted-auth"><button className="flow-primary" disabled>Loading…</button></div>;

  return (
    <div className="hosted-auth">
      <button
        className="flow-primary"
        disabled={phase !== "idle"}
        onClick={() => {
          setError("");
          setPhase("authorising");
          login();
        }}
      >
        {LABEL[phase]}
      </button>
      {phase === "provisioning" && (
        <p className="flow-note">Setting up the wallet that will own your Merryman. This happens once.</p>
      )}
      {error && (
        <>
          <p role="alert" className="flow-error">{error}</p>
          {/* A failed prove leaves a Privy session with no merrymen session —
              signing out is the only way back to a clean start, and hiding
              that would strand somebody on a button that no longer works. */}
          <button className="flow-secondary" onClick={() => void logout()}>Start over</button>
        </>
      )}
    </div>
  );
}
