"use client";

/**
 * CONTINUE TO SIGN IN — the first thing a tester sees.
 *
 * Email and X open Privy's standard modal for the chosen method. A restored
 * authenticated session may still lack its embedded wallet, so this component also repairs that state
 * after the modal closes. Creation and proof have deadlines and explicit retry.
 *
 * WHAT HAPPENS AFTER THE MODAL CLOSES is the part worth reading. Privy hands
 * back an authenticated user; an embedded wallet may still need creating or
 * connecting. Neither is an identity to
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
 * `useWallets()` can contain external wallets. Select the embedded wallet and
 * confirm its address belongs to the current Privy user before requesting proof.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getEmbeddedConnectedWallet,
  useCreateWallet,
  useLogin,
  useLoginWithOAuth,
  useModalStatus,
  usePrivy,
  useWallets,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import { requestJson } from "./request-json";
import { createPrivyWalletOnce } from "./privy-wallet-creation";

export const PRIVY_WALLET_TIMEOUT_MS = 45_000;
export const PRIVY_PROOF_TIMEOUT_MS = 60_000;

type Phase = "idle" | "authorising" | "provisioning" | "proving" | "done" | "error" | "resetting";

const LABEL: Record<Phase, string> = {
  idle: "Continue to sign in",
  authorising: "Waiting for sign-in…",
  provisioning: "Preparing your account…",
  proving: "Verifying account ownership…",
  done: "Signed in",
  error: "Try again",
  resetting: "Signing out…",
};

interface Attempt {
  userId: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  creating: boolean;
  proving: boolean;
  createdAddress?: string;
}

export function PrivySignIn({ onDone, directX = false }: { onDone: () => void; directX?: boolean }) {
  const { ready, authenticated, getAccessToken, user, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const { isOpen } = useModalStatus();
  const embedded = walletsReady ? getEmbeddedConnectedWallet(wallets) : null;
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const attempt = useRef<Attempt | null>(null);
  const mounted = useRef(false);
  const session = useRef({ authenticated, userId: user?.id });
  const done = useRef(onDone);
  session.current = { authenticated, userId: user?.id };
  done.current = onDone;

  const cancelAttempt = useCallback(() => {
    const pending = attempt.current;
    attempt.current = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.controller.abort();
    }
  }, []);
  const isCurrent = useCallback((pending: Attempt) => mounted.current
    && attempt.current === pending
    && session.current.authenticated
    && session.current.userId === pending.userId, []);
  const fail = useCallback((pending: Attempt, message: string) => {
    if (!isCurrent(pending)) return;
    cancelAttempt();
    setError(message);
    setPhase("error");
  }, [cancelAttempt, isCurrent]);

  const { login } = useLogin({
    onError: () => {
      if (!mounted.current) return;
      cancelAttempt();
      setError("Sign-in didn't finish. Try again.");
      setPhase("error");
    },
  });
  const oauthFailed = useCallback(() => {
    if (!mounted.current) return;
    cancelAttempt();
    setError("Sign-in didn't finish. Try again.");
    setPhase("error");
  }, [cancelAttempt]);
  // Privy's supported headless entry removes the redundant provider-choice
  // modal on Android. The hook also finishes the saved PKCE flow on return;
  // wallet provisioning and ownership proof below remain the same path.
  const { initOAuth } = useLoginWithOAuth({ onError: oauthFailed });

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelAttempt(); };
  }, [cancelAttempt]);

  // A late token, wallet or signature from an old login cannot finish a new one.
  useEffect(() => {
    cancelAttempt();
    setError("");
    setPhase("idle");
  }, [authenticated, user?.id, cancelAttempt]);

  const finish = useCallback(async (wallet: ConnectedWallet, pending: Attempt) => {
    const signal = pending.controller.signal;
    const token = await getAccessToken();
    if (!isCurrent(pending)) return;
    if (!token) throw new Error("Your sign-in expired. Try again.");
    const challenge = await requestJson<{ nonce: string; message: string }>("/api/auth/privy", { signal });
    if (!isCurrent(pending)) return;
    const provider = await wallet.getEthereumProvider();
    if (!isCurrent(pending)) return;
    // personal_sign over the server's exact challenge, using the embedded owner.
    const signature = (await provider.request({
      method: "personal_sign",
      params: [challenge.message, wallet.address],
    })) as string;
    if (!isCurrent(pending)) return;
    const linked = user?.twitter ?? null;
    await requestJson("/api/auth/privy", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        nonce: challenge.nonce,
        signature,
        // Display metadata only; the server verifies the token and signature.
        provider: linked ? "twitter" : user?.email ? "email" : "wallet",
        subject: linked?.subject ?? undefined,
        handle: linked?.username ?? undefined,
        displayName: linked?.name ?? undefined,
        avatarUrl: linked?.profilePictureUrl ?? undefined,
      }),
    });
    if (!isCurrent(pending)) return;
    clearTimeout(pending.timer);
    setPhase("done");
    done.current();
  }, [getAccessToken, isCurrent, user]);

  useEffect(() => {
    if (!ready || !authenticated || !user?.id || phase === "done" || phase === "error" || phase === "resetting") return;
    // Automatic creation belongs to Privy's modal. Only repair a missing wallet
    // once that flow has closed, so the two creation paths cannot compete.
    if (isOpen) return;
    let pending = attempt.current;
    if (!pending) {
      pending = {
        userId: user.id, controller: new AbortController(), creating: false, proving: false,
        timer: setTimeout(() => {
          fail(pending!, "Your wallet didn't become available. Try again, or start over to reconnect your account.");
        }, PRIVY_WALLET_TIMEOUT_MS),
      };
      attempt.current = pending;
      setPhase("provisioning");
    }
    if (!walletsReady || pending.proving) return;
    const linkedWallets = user.linkedAccounts.filter((account) => account.type === "wallet"
      && account.chainType === "ethereum"
      && (account.walletClientType === "privy" || account.walletClientType === "privy-v2"));
    // Connected wallets can briefly lag an account switch. Require evidence
    // that this embedded signer belongs to the current authenticated user.
    const ownsEmbedded = embedded && (linkedWallets.some((account) => account.type === "wallet"
      && account.address.toLowerCase() === embedded.address.toLowerCase())
      || pending.createdAddress?.toLowerCase() === embedded.address.toLowerCase());
    if (embedded && ownsEmbedded) {
      pending.proving = true;
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        fail(pending!, "Signing in took too long. Try again and approve the wallet signature when prompted.");
      }, PRIVY_PROOF_TIMEOUT_MS);
      setPhase("proving");
      void finish(embedded, pending).catch((e: unknown) => {
        fail(pending!, e instanceof Error ? e.message : "Sign-in failed. Try again.");
      });
    } else if (!linkedWallets.length && !pending.creating) {
      pending.creating = true;
      // Restored authenticated sessions do not run createOnLogin again. Create
      // only the first user-owned wallet; existing wallets are never replaced.
      void createPrivyWalletOnce(user.id, () => createWallet()).then((wallet) => {
        if (!isCurrent(pending!)) return;
        pending!.createdAddress = wallet.address;
        refresh((value) => value + 1);
      }).catch(() => {
        fail(pending!, "We couldn't create your wallet. Try again, or start over to reconnect your account.");
      });
    }
  }, [ready, authenticated, user, walletsReady, embedded, isOpen, phase, revision, createWallet, fail, finish, isCurrent]);

  async function startOver() {
    cancelAttempt();
    setError("");
    setPhase("resetting");
    try {
      await logout();
      // The authenticated effect resets the UI once Privy confirms sign-out.
      if (mounted.current && !session.current.authenticated) setPhase("idle");
    } catch {
      if (!mounted.current) return;
      setError("Couldn't sign out. Try starting over again.");
      setPhase("error");
    }
  }

  function signIn(method: "email" | "twitter" = "email") {
    cancelAttempt();
    setError("");
    if (authenticated) {
      setPhase("idle");
      refresh((value) => value + 1);
    } else {
      setPhase("authorising");
      try {
        if (directX && method === "twitter") void initOAuth({ provider: "twitter" }).catch(oauthFailed);
        else login({ loginMethods: [method] });
      } catch { oauthFailed(); }
    }
  }

  if (!ready) return <div className="hosted-auth"><button className="flow-primary" disabled>Loading…</button></div>;

  return (
    <div className="hosted-auth">
      {!authenticated && (phase === "idle" || phase === "error") ? <>
        <div className="hosted-signin-methods" role="group" aria-label="Sign-in options">
          <button className="flow-primary" onClick={() => signIn("email")}>Continue with email</button>
          <button className="flow-secondary" onClick={() => signIn("twitter")}>Continue with X</button>
        </div>
        <p className="hosted-auth-note">Use the same email or X account when you return.</p>
      </> :
      <button
        className="flow-primary"
        disabled={phase !== "idle" && phase !== "error"}
        onClick={() => signIn()}
      >
        {LABEL[phase]}
      </button>}
      <div role="status" aria-live="polite">
        {phase === "authorising" && <p className="hosted-auth-note">Complete verification in the sign-in dialog to continue.</p>}
        {phase === "provisioning" && <p className="hosted-auth-note">Connecting your account’s wallet. If you’re new, Merrymen creates it once.</p>}
        {phase === "proving" && <p className="hosted-auth-note">Approve the sign-in signature if prompted. It proves you own this account and does not allow trading.</p>}
      </div>
      {error && <p role="alert" className="flow-error">{error}</p>}
      {(authenticated || error) && phase !== "done" && (
        <button className="flow-secondary" disabled={phase === "resetting"} onClick={() => void startOver()}>Start over</button>
      )}
    </div>
  );
}
