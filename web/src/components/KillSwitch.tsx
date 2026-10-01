"use client";

import Link from "next/link";
import { useState } from "react";
import { stopAgent } from "@/lib/stop-agent";
import { fetchAccountForSession } from "@/terminal/account-session";
import { saveRecoveryGrant, trustedSavedGrant } from "@/lib/saved-grant-binding";
import type { Grant } from "@/lib/session";

/** Stopping the service does not require an owner signature or delete recovery keys. */
export function KillSwitch() {
  const [arming, setArming] = useState(false);
  const [state, setState] = useState<"idle" | "stopping" | "stopped">("idle");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [unsavedRecovery, setUnsavedRecovery] = useState<Grant | null>(null);
  async function stop() {
    if (state === "stopping") return;
    setState("stopping");
    setError(null);
    setWarning(null);
    try {
      const account = await fetchAccountForSession(null);
      let session: { hosted: boolean; address: string | null };
      if (account.kind === "ready") {
        session = account.account.session;
        const grant = account.account.status.grant as Grant | undefined;
        if (grant && await trustedSavedGrant(grant, session, window.location.origin)) {
          try { saveRecoveryGrant(grant); setUnsavedRecovery(null); }
          catch {
            setUnsavedRecovery(grant);
            setWarning("Recovery details could not be saved in this browser. Stopping still works. Keep this page open, free browser storage, then retry saving below. Existing recovery keys were not changed.");
          }
        } else if (account.account.status.exists) {
          setWarning("Recovery details could not be verified for saving. Stopping still works; keep your existing recovery keys to manage this wallet.");
        }
      } else {
        // A grant-read outage must not veto an authenticated service stop.
        // Re-read the session rather than borrowing a stale tenant from props.
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (!response.ok) throw new Error("Could not confirm your account. Your wallet was kept; try again.");
        session = await response.json() as typeof session;
        setWarning("The service could not provide recovery details for this browser. Stopping still works; existing saved wallets and recovery keys were not changed.");
      }
      if (!session || typeof session.hosted !== "boolean" || (session.address !== null && !/^0x[0-9a-fA-F]{40}$/.test(session.address))) {
        throw new Error("Could not confirm your account. No stop was submitted.");
      }
      if (session.hosted && !session.address) throw new Error("Sign in to stop your agent. Your wallet was kept.");
      await stopAgent(session.hosted ? session.address : undefined);
      setState("stopped");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The stop request is unconfirmed. Your wallet was kept.");
      setState("idle");
    }
    setArming(false);
  }
  function retryRecoverySave() {
    if (!unsavedRecovery) return;
    try {
      saveRecoveryGrant(unsavedRecovery);
      setUnsavedRecovery(null);
      setWarning("Wallet recovery details are now saved in this browser. Open Wallet & permissions to resume or revoke.");
    } catch {
      setWarning("Recovery details are still not saved. Keep this page open, free browser storage, and retry saving. Your stop request is unchanged.");
    }
  }
  return <>
    <button className="killall" disabled={state !== "idle"} onClick={() => {
      if (!arming) { setArming(true); return; }
      void stop();
    }}>
      {state === "stopped" ? "Stop request accepted" : state === "stopping" ? "Requesting stop…" : arming ? "Confirm stop agent" : "Stop agent"}
    </button>
    <div className="killall-note" role={error ? "alert" : "status"}>
      {error ?? (state === "stopped"
        ? "The service removed its permission. The worker stops on its next check. Your wallet and recovery access are kept."
        : "Stops this service from trading. It does not invalidate copies of a session key on-chain.")}
      {" "}<Link href="/grant#permission-security">Revoke permissions on-chain</Link> to invalidate earlier keys. This requires the owner and network fees.
    </div>
    {warning && <p className="killall-note" role="status">{warning}</p>}
    {unsavedRecovery && <button className="copy-btn" onClick={retryRecoverySave}>Retry saving wallet details</button>}
  </>;
}
