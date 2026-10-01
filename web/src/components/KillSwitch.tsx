"use client";

import Link from "next/link";
import { useState } from "react";
import { stopAgent } from "@/lib/stop-agent";

/** Stopping the service does not require an owner signature or delete recovery keys. */
export function KillSwitch() {
  const [arming, setArming] = useState(false);
  const [state, setState] = useState<"idle" | "stopping" | "stopped">("idle");
  const [error, setError] = useState<string | null>(null);
  async function stop() {
    if (state === "stopping") return;
    setState("stopping");
    setError(null);
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not confirm your account. Your wallet was kept; try again.");
      const session = await response.json() as { hosted?: boolean; address?: string | null };
      if (session.hosted && !session.address) throw new Error("Sign in to stop your agent. Your wallet was kept.");
      await stopAgent(session.hosted ? session.address : undefined);
      setState("stopped");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The stop request is unconfirmed. Your wallet was kept.");
      setState("idle");
    }
    setArming(false);
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
  </>;
}
